// Painel de vendas ao vivo (Marketplace › Painel ao vivo), 11/11/2026.
//
// Este arquivo só CALCULA: recebe as linhas que a rota leu do banco e devolve
// o painel pronto. Não fala com o banco, o que deixa cada regra testável sem
// subir nada (ver scripts/teste-painel-ao-vivo-2026-11-11.js).
//
// AS REGRAS QUE VÊM DO RESTO DO SISTEMA (e não foram reinventadas aqui):
//   · "pedido" = grupo. Pedidos do mesmo carrinho do Mercado Livre dividem
//     `pack_id_marketplace` e contam UMA venda, igual ao painel do próprio ML
//     e às Métricas (resumirPedidosMarketplace em pedidos.routes.js). O valor
//     em R$ soma tudo, sem agrupar.
//   · pedido cancelado não entra (a rota já filtra).
//   · o "dia" é o de Brasília (`data_pedido`, que o sincronizador grava assim).
//
// A HORA DA VENDA — o ponto que pede cuidado:
//   `data_pedido` é DATE, não tem hora. A hora vem de `pedido_envio.pago_em`
//   (Shopee e TikTok, que informam o pagamento) e, na falta dela, de
//   `pedidos_venda.created_at` — a hora em que o Hub viu o pedido, no máximo
//   5 min depois da venda (é o ciclo do sincronizador). O mesmo relógio que
//   o painel de Expedição já usa para o prazo de coleta.
//   Só vale se cair no MESMO dia de `data_pedido`: um pedido de ontem
//   importado hoje (planilha, repovoamento) teria a hora da importação, que
//   é mentira. Esses ficam SEM HORA: entram nos totais, não entram na curva
//   nem na comparação "mesmo período de ontem" — e a tela diz quantos são
//   (REGRA 2: dado ausente fica ausente, não é chutado).
//
// ESTADO (UF) DE DESTINO: o hub não tem coluna de estado no pedido. O que
//   existe é o endereço que as plataformas devolveram na consulta de envio e
//   que ficou em `pedido_envio.bruto`. Lemos dali, de forma tolerante, e a
//   tela declara "estado identificado em N de M pedidos".

const { FUSO } = require('./dataBrasil');

const PASSO_CURVA_MIN = 30; // a curva do dia tem um ponto a cada 30 min

// Sigla -> nome sem acento, minúsculo. Usada para ler o estado como cada
// plataforma escreve ("BR-SP", "SP", "São Paulo", "sao paulo").
const ESTADOS = {
  AC: 'acre', AL: 'alagoas', AP: 'amapa', AM: 'amazonas', BA: 'bahia', CE: 'ceara',
  DF: 'distrito federal', ES: 'espirito santo', GO: 'goias', MA: 'maranhao',
  MT: 'mato grosso', MS: 'mato grosso do sul', MG: 'minas gerais', PA: 'para',
  PB: 'paraiba', PR: 'parana', PE: 'pernambuco', PI: 'piaui', RJ: 'rio de janeiro',
  RN: 'rio grande do norte', RS: 'rio grande do sul', RO: 'rondonia', RR: 'roraima',
  SC: 'santa catarina', SP: 'sao paulo', SE: 'sergipe', TO: 'tocantins',
};

const semAcento = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const NOME_PARA_UF = new Map(Object.entries(ESTADOS).map(([uf, nome]) => [nome, uf]));
const NOMES_POR_TAMANHO = [...NOME_PARA_UF.keys()].sort((a, b) => b.length - a.length);

// Qualquer forma de escrever um estado -> sigla (ou null).
function normalizarUF(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'object') {
    return normalizarUF(valor.id ?? valor.code ?? valor.state_code ?? valor.name ?? valor.address_name ?? null);
  }
  let t = semAcento(valor);
  if (!t) return null;
  t = t.replace(/^br[-_ ]/, '');
  if (t.length === 2 && ESTADOS[t.toUpperCase()]) return t.toUpperCase();
  if (NOME_PARA_UF.has(t)) return NOME_PARA_UF.get(t);
  t = t.replace(/^estado d[eo] /, '');
  if (NOME_PARA_UF.has(t)) return NOME_PARA_UF.get(t);
  // "Rio Grande do Sul - RS", "Goiás (GO)": acha o nome mais longo contido.
  for (const nome of NOMES_POR_TAMANHO) {
    if (new RegExp(`(^|[^a-z])${nome.replace(/ /g, ' +')}([^a-z]|$)`).test(t)) return NOME_PARA_UF.get(nome);
  }
  return null;
}

// `endereco` é o que a rota extrai de pedido_envio.bruto, por plataforma:
//   ml  — envio.receiver_address.state            ({ id: 'BR-SP', name: 'São Paulo' })
//   sh  — recipient_address.state                 ('São Paulo')
//   tk  — recipient_address.district_info         ([{ address_level_name: 'State', address_name: '...' }])
//   tk2 — recipient_address.state                 (quando vier direto)
// Só o formato do Mercado Livre foi conferido contra a documentação; os da
// Shopee e da TikTok são lidos de forma tolerante e, se não reconhecidos, o
// pedido fica "sem estado" — nunca com estado inventado.
function ufDoEndereco(endereco) {
  if (!endereco) return null;
  const direta = normalizarUF(endereco.ml) || normalizarUF(endereco.sh) || normalizarUF(endereco.tk2);
  if (direta) return direta;
  const niveis = Array.isArray(endereco.tk) ? endereco.tk : [];
  const estado = niveis.find((n) => /^(state|estado|province|provincia)$/i.test(String(n?.address_level_name || '').trim()))
    || niveis.find((n) => String(n?.address_level || '').toUpperCase() === 'L1');
  return normalizarUF(estado?.address_name ?? estado?.name ?? null);
}

const arred = (n) => Math.round((Number(n) || 0) * 100) / 100;

function somarDias(dia, delta) {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Minuto do dia (0–1439) em Brasília.
function minutoDoDia(agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(agora);
  const h = Number(partes.find((p) => p.type === 'hour').value);
  const m = Number(partes.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

// Junta as linhas de pedido em "vendas" (um pack do ML = uma venda).
function agruparVendas(pedidos) {
  const mapa = new Map();
  for (const p of pedidos) {
    const chave = `${p.dia}|${p.grupo}`;
    let v = mapa.get(chave);
    if (!v) {
      v = { chave, grupo: p.grupo, dia: p.dia, lojaId: p.loja_id ?? null, plataforma: p.plataforma, canal: p.canal_venda, valor: 0, min: null };
      mapa.set(chave, v);
    }
    v.valor += Number(p.receita) || 0;
    // A hora só vale quando o banco a confirmou no mesmo dia do pedido.
    if (p.hora_ok && p.min !== null && p.min !== undefined) {
      v.min = v.min === null ? Number(p.min) : Math.min(v.min, Number(p.min));
    }
  }
  return [...mapa.values()];
}

function totais(vendas) {
  return { pedidos: vendas.length, valor: arred(vendas.reduce((s, v) => s + v.valor, 0)) };
}

function variacaoPct(atual, base) {
  if (!(base > 0)) return null;
  return Math.round(((atual - base) / base) * 1000) / 10;
}

// Curva acumulada do dia: um ponto a cada 30 min, de 00:00 a 24:00. Hoje para
// de existir no minuto atual (null depois dele) — é isso que desenha a linha
// "crescendo" na tela.
function curvaDoDia(vendasHoje, vendasOntem, agoraMin) {
  const comHora = (lista) => lista.filter((v) => v.min !== null).sort((a, b) => a.min - b.min);
  const hoje = comHora(vendasHoje);
  const ontem = comHora(vendasOntem);
  const pontos = [];
  let ih = 0; let io = 0;
  let hojePed = 0; let hojeVal = 0; let ontemPed = 0; let ontemVal = 0;
  for (let min = 0; min <= 1440; min += PASSO_CURVA_MIN) {
    while (io < ontem.length && ontem[io].min <= min) { ontemPed += 1; ontemVal += ontem[io].valor; io += 1; }
    // O ponto de HOJE só existe até agora; o último é exatamente "agora".
    const passouAgora = min > agoraMin;
    while (!passouAgora && ih < hoje.length && hoje[ih].min <= min) { hojePed += 1; hojeVal += hoje[ih].valor; ih += 1; }
    pontos.push({
      min,
      hojePedidos: passouAgora ? null : hojePed,
      hojeValor: passouAgora ? null : arred(hojeVal),
      ontemPedidos: ontemPed,
      ontemValor: arred(ontemVal),
    });
  }
  // Ponto final de hoje = agora, com tudo o que já aconteceu (inclusive o que
  // caiu depois do último degrau de 30 min).
  const ate = hoje.filter((v) => v.min <= agoraMin);
  const ponto = { min: agoraMin, hojePedidos: ate.length, hojeValor: arred(ate.reduce((s, v) => s + v.valor, 0)) };
  return { passoMin: PASSO_CURVA_MIN, pontos, agora: ponto };
}

const textoOuNulo = (t) => { const s = String(t ?? '').trim(); return s || null; };

function maisComum(lista) {
  const cont = new Map();
  for (const x of lista) if (x) cont.set(x, (cont.get(x) || 0) + 1);
  let melhor = null; let n = 0;
  for (const [k, c] of cont) if (c > n) { melhor = k; n = c; }
  return melhor;
}

// Ranking de anúncios ou variações do dia por quantidade de pedidos.
function ranquear(itens, nivel) {
  const mapa = new Map();
  for (const it of itens) {
    const anuncio = textoOuNulo(it.anuncio_id) || textoOuNulo(it.sku_externo) || textoOuNulo(it.referencia) || textoOuNulo(it.titulo_externo) || `item:${it.item_id}`;
    const variacao = textoOuNulo(it.sku_externo) || [it.referencia, it.cor, it.tamanho].map(textoOuNulo).filter(Boolean).join('-') || anuncio;
    const chave = nivel === 'variacao'
      ? `${it.plataforma}|${it.loja_id}|${anuncio}|${variacao}`
      : `${it.plataforma}|${it.loja_id}|${anuncio}`;
    let r = mapa.get(chave);
    if (!r) {
      r = { chave, anuncioId: textoOuNulo(it.anuncio_id), lojaId: it.loja_id ?? null, plataforma: it.plataforma, grupos: new Set(), valor: 0, titulos: [], skus: [], refs: [], variacao };
      mapa.set(chave, r);
    }
    r.grupos.add(it.grupo);
    r.valor += Number(it.total) || 0;
    r.titulos.push(textoOuNulo(it.titulo_externo) || textoOuNulo(it.descricao));
    r.skus.push(textoOuNulo(it.sku_externo));
    r.refs.push(textoOuNulo(it.referencia));
  }
  return [...mapa.values()]
    .map((r) => ({
      anuncioId: r.anuncioId,
      lojaId: r.lojaId,
      plataforma: r.plataforma,
      pedidos: r.grupos.size,
      valor: arred(r.valor),
      titulo: maisComum(r.titulos),
      // No anúncio, o código que a casa reconhece é a REFERÊNCIA (OG1340);
      // na variação, o SKU completo (cor e tamanho).
      codigo: nivel === 'variacao' ? r.variacao : (maisComum(r.refs) || maisComum(r.skus)),
    }))
    .sort((a, b) => b.pedidos - a.pedidos || b.valor - a.valor)
    .slice(0, 5);
}

function agrupar(vendas, chaveDe) {
  const mapa = new Map();
  for (const v of vendas) {
    const k = chaveDe(v);
    const a = mapa.get(k) || { chave: k, pedidos: 0, valor: 0 };
    a.pedidos += 1;
    a.valor += v.valor;
    mapa.set(k, a);
  }
  return [...mapa.values()].map((a) => ({ ...a, valor: arred(a.valor) }));
}

function montarPainel({ hoje, agora = new Date(), pedidos = [], itens = [], enderecos = [], lojas = [], atualizadoEm = null }) {
  const ontem = somarDias(hoje, -1);
  const agoraMin = minutoDoDia(agora);
  const vendas = agruparVendas(pedidos);
  const vHoje = vendas.filter((v) => v.dia === hoje);
  const vOntem = vendas.filter((v) => v.dia === ontem);

  // Comparação "ontem até a mesma hora": só com venda de hora conhecida.
  const ontemAteAgora = vOntem.filter((v) => v.min !== null && v.min <= agoraMin);
  const semHoraHoje = vHoje.filter((v) => v.min === null).length;
  const semHoraOntem = vOntem.filter((v) => v.min === null).length;

  const tHoje = totais(vHoje);
  const tOntemMP = totais(ontemAteAgora);
  const tOntem = totais(vOntem);

  // Lojas: nome vem do cadastro da conexão; sem conexão, o canal genérico.
  const nomesLojas = new Map(lojas.map((l) => [String(l.id), l]));
  const porLoja = agrupar(vHoje, (v) => (v.lojaId !== null ? `loja:${v.lojaId}` : `canal:${v.canal || v.plataforma || '—'}`))
    .map((l) => {
      const id = l.chave.startsWith('loja:') ? l.chave.slice(5) : null;
      const cad = id ? nomesLojas.get(id) : null;
      const exemplo = vHoje.find((v) => (v.lojaId !== null ? `loja:${v.lojaId}` : `canal:${v.canal || v.plataforma || '—'}`) === l.chave);
      return {
        lojaId: id ? Number(id) : null,
        plataforma: cad?.marketplace || exemplo?.plataforma || null,
        nome: cad?.nome || null,
        canalGenerico: cad ? null : (exemplo?.canal || null),
        pedidos: l.pedidos,
        valor: l.valor,
      };
    })
    .sort((a, b) => b.pedidos - a.pedidos || b.valor - a.valor);

  const totalValorHoje = tHoje.valor;
  const porPlataforma = agrupar(vHoje, (v) => v.plataforma || 'outro')
    .map((p) => ({
      plataforma: p.chave, pedidos: p.pedidos, valor: p.valor,
      pct: totalValorHoje > 0 ? Math.round((p.valor / totalValorHoje) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.valor - a.valor);

  const porLojaComPct = porLoja.map((l) => ({
    ...l, pct: totalValorHoje > 0 ? Math.round((l.valor / totalValorHoje) * 1000) / 10 : 0,
  }));

  // Sete dias fechados, até ontem (o dia de hoje tem painel só dele).
  const sete = [];
  for (let i = 7; i >= 1; i -= 1) {
    const dia = somarDias(hoje, -i);
    const t = totais(vendas.filter((v) => v.dia === dia));
    sete.push({ dia, valor: t.valor, pedidos: t.pedidos });
  }

  // Estados: por venda (grupo), não por linha de pedido.
  const ufPorGrupo = new Map();
  for (const e of enderecos) {
    const uf = ufDoEndereco(e.endereco);
    if (uf && !ufPorGrupo.has(e.grupo)) ufPorGrupo.set(e.grupo, uf);
  }
  const contUF = new Map();
  let resolvidos = 0;
  for (const v of vHoje) {
    const uf = ufPorGrupo.get(v.grupo);
    if (!uf) continue;
    resolvidos += 1;
    contUF.set(uf, (contUF.get(uf) || 0) + 1);
  }
  const estados = [...contUF.entries()].map(([uf, n]) => ({ uf, pedidos: n })).sort((a, b) => b.pedidos - a.pedidos || a.uf.localeCompare(b.uf));

  // A foto não mora aqui: a rota busca só as dos anúncios que chegaram ao topo.
  const topAnuncios = ranquear(itens, 'anuncio');
  const topVariacoes = ranquear(itens, 'variacao');

  const ultima = vHoje.filter((v) => v.min !== null).sort((a, b) => b.min - a.min)[0] || null;

  return {
    hoje,
    geradoEm: agora.toISOString(),
    atualizadoEm,
    agoraMin,
    hojeTotais: tHoje,
    ontemMesmoPeriodo: { ...tOntemMP, variacaoValorPct: variacaoPct(tHoje.valor, tOntemMP.valor), variacaoPedidosPct: variacaoPct(tHoje.pedidos, tOntemMP.pedidos) },
    ontemTotais: tOntem,
    // Quantas vendas ficaram de fora da curva/comparação por não terem hora.
    semHora: { hoje: semHoraHoje, ontem: semHoraOntem },
    curva: curvaDoDia(vHoje, vOntem, agoraMin),
    lojas: porLojaComPct,
    plataformas: porPlataforma,
    seteDias: sete,
    topAnuncios,
    topVariacoes,
    estados: { lista: estados, identificados: resolvidos, total: vHoje.length },
    ultimaVenda: ultima ? { min: ultima.min, lojaId: ultima.lojaId, plataforma: ultima.plataforma, valor: arred(ultima.valor) } : null,
    lojasCadastradas: lojas.map((l) => ({ id: l.id, marketplace: l.marketplace, nome: l.nome })),
  };
}

module.exports = {
  ESTADOS, normalizarUF, ufDoEndereco, minutoDoDia, somarDias,
  agruparVendas, curvaDoDia, ranquear, montarPainel, PASSO_CURVA_MIN,
};
