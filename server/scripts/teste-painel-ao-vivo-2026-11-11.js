// Teste do Painel de vendas ao vivo (Marketplace › Painel ao vivo), 11/11/2026.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-painel-ao-vivo-2026-11-11.js
//
// Parte 1 (sem banco): as regras de cálculo da lib, com relógio fixo.
//   · estado lido de cada plataforma;
//   · pack do Mercado Livre conta UMA venda, e o valor soma tudo;
//   · venda sem hora confiável entra no total e sai da curva e da comparação;
//   · "ontem até a mesma hora" não inclui o que ontem vendeu depois dela.
// Parte 2 (com banco): a rota real, com pedidos semeados.
//   · cancelado fora; pedido de planilha (sem origem_marketplace) fora;
//   · totais, lojas, plataformas, sete dias, ranking e estado batem com o
//     que foi semeado;
//   · a resposta não carrega credencial de loja.

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-painel-ao-vivo';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-painel-ao-vivo-secret-com-32-caracteres';

const http = require('http');
const lib = require('../src/lib/painelAoVivo');

let falhas = 0;
let passou = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ok   ${descricao}`); } else {
    falhas += 1;
    console.log(`  FALHA ${descricao}${detalhe !== undefined ? ` — veio ${JSON.stringify(detalhe)}` : ''}`);
  }
}
const perto = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005;

function parteLib() {
  console.log('\n1. Estado de destino, como cada plataforma escreve');
  const n = lib.normalizarUF;
  conferir("'BR-SP' -> SP", n('BR-SP') === 'SP', n('BR-SP'));
  conferir("'São Paulo' -> SP", n('São Paulo') === 'SP', n('São Paulo'));
  conferir("'mato grosso do sul' não vira MT", n('mato grosso do sul') === 'MS', n('mato grosso do sul'));
  conferir("'Mato Grosso' -> MT", n('Mato Grosso') === 'MT', n('Mato Grosso'));
  conferir("'Rio Grande do Norte - RN' -> RN", n('Rio Grande do Norte - RN') === 'RN', n('Rio Grande do Norte - RN'));
  conferir("'Estado de Goiás' -> GO", n('Estado de Goiás') === 'GO', n('Estado de Goiás'));
  conferir('texto sem estado -> nulo (nada inventado)', n('Brasil') === null && n('') === null && n(null) === null);
  conferir("objeto { id: 'BR-BA' } -> BA", n({ id: 'BR-BA', name: 'Bahia' }) === 'BA', n({ id: 'BR-BA' }));

  const u = lib.ufDoEndereco;
  conferir('Mercado Livre (receiver_address.state)', u({ ml: { id: 'BR-MG', name: 'Minas Gerais' } }) === 'MG');
  conferir('Shopee (recipient_address.state, por extenso)', u({ sh: 'Paraná' }) === 'PR');
  conferir('TikTok (district_info nível "State")', u({ tk: [
    { address_level: 'L0', address_level_name: 'Country', address_name: 'Brazil' },
    { address_level: 'L1', address_level_name: 'State', address_name: 'Bahia' },
    { address_level: 'L2', address_level_name: 'City', address_name: 'Salvador' },
  ] }) === 'BA');
  conferir('endereço sem estado -> nulo', u({ ml: null, sh: null, tk: null, tk2: null }) === null && u(null) === null);

  console.log('\n2. Relógio fixo: hoje 15:00 (900 min)');
  const hoje = '2026-11-11';
  const ontem = '2026-11-10';
  const agora = new Date('2026-11-11T18:00:00Z'); // 15:00 em Brasília
  const ped = (id, dia, grupo, receita, min, horaOk = true, extra = {}) => ({
    id, dia, grupo, receita, min, hora_ok: horaOk, loja_id: 1, plataforma: 'mercado_livre', canal_venda: 'Mercado Livre', ...extra,
  });
  const pedidos = [
    // hoje
    ped(1, hoje, 'pack:A', 100, 600),                    // 10:00 — dois pedidos do MESMO pack
    ped(2, hoje, 'pack:A', 50, 601),
    ped(3, hoje, 'pedido:3', 80, 840, true, { loja_id: 2, plataforma: 'shopee', canal_venda: 'Shopee' }), // 14:00
    ped(4, hoje, 'pedido:4', 70, null, false, { loja_id: 2, plataforma: 'shopee', canal_venda: 'Shopee' }), // sem hora
    // ontem
    ped(5, ontem, 'pedido:5', 60, 540),                   // 09:00  (até 15:00: entra)
    ped(6, ontem, 'pedido:6', 90, 870, true, { loja_id: 2, plataforma: 'shopee', canal_venda: 'Shopee' }), // 14:30 (entra)
    ped(7, ontem, 'pedido:7', 500, 1200),                 // 20:00 (NÃO entra no "mesmo período")
    ped(8, ontem, 'pedido:8', 40, null, false),           // ontem sem hora
  ];
  const itens = [
    { item_id: 1, anuncio_id: 'MLB1', titulo_externo: 'Camisa Polo', sku_externo: 'OG1620-P-M', referencia: 'OG1620', cor: 'Preto', tamanho: 'M', total: 100, plataforma: 'mercado_livre', loja_id: 1, grupo: 'pack:A' },
    { item_id: 2, anuncio_id: 'MLB1', titulo_externo: 'Camisa Polo', sku_externo: 'OG1620-P-G', referencia: 'OG1620', cor: 'Preto', tamanho: 'G', total: 50, plataforma: 'mercado_livre', loja_id: 1, grupo: 'pack:A' },
    { item_id: 3, anuncio_id: 'MLB1', titulo_externo: 'Camisa Polo', sku_externo: 'OG1620-P-M', referencia: 'OG1620', cor: 'Preto', tamanho: 'M', total: 80, plataforma: 'mercado_livre', loja_id: 1, grupo: 'pedido:3' },
    { item_id: 4, anuncio_id: '999', titulo_externo: 'Camisa Social', sku_externo: 'OG1340', referencia: 'OG1340', cor: null, tamanho: null, total: 70, plataforma: 'shopee', loja_id: 2, grupo: 'pedido:4' },
  ];
  const enderecos = [
    { id: 1, grupo: 'pack:A', endereco: { ml: { id: 'BR-SP' } } },
    { id: 2, grupo: 'pack:A', endereco: { ml: { id: 'BR-SP' } } },
    { id: 3, grupo: 'pedido:3', endereco: { sh: 'Bahia' } },
  ];
  const lojas = [{ id: 1, marketplace: 'mercado_livre', nome: 'Hoggar' }, { id: 2, marketplace: 'shopee', nome: 'Origem' }];
  const p = lib.montarPainel({ hoje, agora, pedidos, itens, enderecos, lojas, atualizadoEm: null });

  conferir('minuto atual em Brasília = 900', p.agoraMin === 900, p.agoraMin);
  conferir('pack do ML conta UMA venda: hoje = 3 pedidos (pack + 2 shopee)', p.hojeTotais.pedidos === 3, p.hojeTotais);
  conferir('valor soma tudo, sem agrupar: R$ 300,00', perto(p.hojeTotais.valor, 300), p.hojeTotais.valor);
  conferir('1 venda de hoje sem hora', p.semHora.hoje === 1, p.semHora);
  conferir('ontem sem hora: 1', p.semHora.ontem === 1, p.semHora);
  conferir('ontem até 15:00 = R$ 150,00 em 2 pedidos (fora a de 20h e a sem hora)',
    perto(p.ontemMesmoPeriodo.valor, 150) && p.ontemMesmoPeriodo.pedidos === 2, p.ontemMesmoPeriodo);
  conferir('ontem total = R$ 690,00 em 4 pedidos (a sem hora entra no total)',
    perto(p.ontemTotais.valor, 690) && p.ontemTotais.pedidos === 4, p.ontemTotais);
  conferir('variação do valor = +100% (300 contra 150)', p.ontemMesmoPeriodo.variacaoValorPct === 100, p.ontemMesmoPeriodo.variacaoValorPct);

  const curva = p.curva.pontos;
  const em = (min) => curva.find((x) => x.min === min);
  conferir('curva de hoje: 12:00 já tem o pack (1 pedido, R$ 150)', em(720).hojePedidos === 1 && perto(em(720).hojeValor, 150), em(720));
  conferir('curva de hoje: 15:00 tem 2 (a sem hora fica de fora)', em(900).hojePedidos === 2 && perto(em(900).hojeValor, 230), em(900));
  conferir('curva de hoje não existe depois de agora (15:30 = null)', em(930).hojePedidos === null, em(930));
  conferir('curva de ontem corre o dia inteiro: 24:00 = 3 pedidos com hora (a sem hora fica fora)', em(1440).ontemPedidos === 3, em(1440));
  conferir('ponto "agora" soma o que já aconteceu', p.curva.agora.min === 900 && p.curva.agora.hojePedidos === 2, p.curva.agora);

  conferir('lojas: Hoggar (1 pedido) e Origem (2 pedidos); a com mais pedidos vem primeiro', p.lojas[0].nome === 'Origem' && p.lojas[0].pedidos === 2 && p.lojas[1].nome === 'Hoggar', p.lojas);
  const somaPct = p.plataformas.reduce((s, x) => s + x.pct, 0);
  conferir('plataformas somam ~100%', Math.abs(somaPct - 100) < 0.2, somaPct);
  conferir('ranking de anúncios: MLB1 lidera com 2 pedidos (pack conta 1)', p.topAnuncios[0].anuncioId === 'MLB1' && p.topAnuncios[0].pedidos === 2, p.topAnuncios[0]);
  conferir('anúncio mostra a referência (OG1620)', p.topAnuncios[0].codigo === 'OG1620', p.topAnuncios[0].codigo);
  conferir('variações: OG1620-P-M (2 pedidos) à frente de OG1620-P-G (1)', p.topVariacoes[0].codigo === 'OG1620-P-M' && p.topVariacoes[0].pedidos === 2, p.topVariacoes.map((x) => [x.codigo, x.pedidos]));
  conferir('estados: SP 1 e BA 1; identificados 2 de 3', p.estados.identificados === 2 && p.estados.total === 3
    && p.estados.lista.some((e) => e.uf === 'SP' && e.pedidos === 1) && p.estados.lista.some((e) => e.uf === 'BA' && e.pedidos === 1), p.estados);
  conferir('sete dias fechados, até ontem', p.seteDias.length === 7 && p.seteDias[6].dia === ontem, p.seteDias.map((d) => d.dia));
  conferir('o dia de ontem nos sete dias = R$ 690,00', perto(p.seteDias[6].valor, 690), p.seteDias[6]);
  conferir('última venda com hora = a das 14:00', p.ultimaVenda && p.ultimaVenda.min === 840, p.ultimaVenda);

  console.log('\n3. Sem venda nenhuma: nada quebra');
  const vazio = lib.montarPainel({ hoje, agora, pedidos: [], itens: [], enderecos: [], lojas });
  conferir('zera sem dividir por zero', vazio.hojeTotais.pedidos === 0 && vazio.ontemMesmoPeriodo.variacaoValorPct === null && vazio.ultimaVenda === null && vazio.plataformas.length === 0, vazio.ontemMesmoPeriodo);
}

function pedir(porta, metodo, caminho, { cookie, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const body = corpo ? JSON.stringify(corpo) : undefined;
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let texto = '';
      res.on('data', (c) => { texto += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function parteBanco() {
  const criarApp = require('../src/app');
  const pool = require('../src/db/pool');
  const { hojeEmBrasilia } = require('../src/lib/dataBrasil');
  // Repetível: apaga sobras de uma execução anterior (pedidos EXT-*) antes de semear.
  const ids = "(SELECT id FROM pedidos_venda WHERE origem_pedido_id LIKE 'EXT-%')";
  await pool.query(`DELETE FROM pedido_envio WHERE pedido_id IN ${ids}`);
  await pool.query(`DELETE FROM pedido_itens WHERE pedido_id IN ${ids}`);
  await pool.query("DELETE FROM pedidos_venda WHERE origem_pedido_id LIKE 'EXT-%'");

  console.log('\n4. A rota, com pedidos semeados');
  const hoje = hojeEmBrasilia();
  const ontem = lib.somarDias(hoje, -1);
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo)
     VALUES ('Empresa Painel', 'Simples Nacional', 0.1, 0, TRUE) RETURNING id`,
  );
  const integ = async (marketplace, nome) => (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo, ultima_sincronizacao)
     VALUES ($1, $2, 'ID-SECRETO', 'SEGREDO-NAO-PODE-VAZAR', $3, $4, 0.6, TRUE, now() - interval '2 minutes') RETURNING *`,
    [marketplace, nome, `${marketplace}-${nome}`, emp.id],
  )).rows[0];
  const ml = await integ('mercado_livre', 'Hoggar');
  const sh = await integ('shopee', 'Origem');

  let seq = 0;
  async function semear({ dia, integracao, valor, pack = null, situacao = 'aberto', origem = true, anuncio = 'MLB-1', criadoEm = 'now()', uf = null }) {
    seq += 1;
    const { rows: [pv] } = await pool.query(
      `INSERT INTO pedidos_venda (data_pedido, canal_venda, origem_marketplace, origem_pedido_id, origem_integracao_id, situacao, pack_id_marketplace, empresa_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${criadoEm}) RETURNING id`,
      [dia, integracao.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre', origem ? integracao.marketplace : null, `EXT-${seq}`, integracao.id, situacao, pack, emp.id],
    );
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, quantidade, valor_unitario, total, anuncio_id_marketplace, titulo_externo, sku_externo, referencia)
       VALUES ($1, 1, $2, $2, $3, 'Camisa Polo Teste', 'OG1620-PRETO-M', 'OG1620')`,
      [pv.id, valor, anuncio],
    );
    if (uf) {
      const bruto = integracao.marketplace === 'mercado_livre'
        ? { envio: { receiver_address: { state: { id: `BR-${uf}` } } } }
        : { recipient_address: { state: uf } };
      await pool.query(
        `INSERT INTO pedido_envio (pedido_id, origem_integracao_id, canal, bruto) VALUES ($1, $2, $3, $4::jsonb)`,
        [pv.id, integracao.id, integracao.marketplace, JSON.stringify(bruto)],
      );
    }
    return pv.id;
  }

  // Hoje: pack do ML com dois pedidos (conta 1), um da Shopee, um cancelado,
  // um que não é de marketplace (planilha).
  await semear({ dia: hoje, integracao: ml, valor: 100, pack: 'PACK-1', uf: 'SP' });
  await semear({ dia: hoje, integracao: ml, valor: 50, pack: 'PACK-1', uf: 'SP' });
  await semear({ dia: hoje, integracao: sh, valor: 80, anuncio: 'SHP-9', uf: 'Bahia' });
  await semear({ dia: hoje, integracao: sh, valor: 999, situacao: 'cancelado' });
  await semear({ dia: hoje, integracao: ml, valor: 777, origem: false });
  // Ontem: dois pedidos, com hora conhecida (10h de Brasília).
  const dezDeOntem = `(('${ontem} 10:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
  await semear({ dia: ontem, integracao: ml, valor: 60, criadoEm: dezDeOntem });
  await semear({ dia: ontem, integracao: sh, valor: 40, criadoEm: dezDeOntem });
  // Três dias atrás.
  await semear({ dia: lib.somarDias(hoje, -3), integracao: ml, valor: 25, criadoEm: `(('${lib.somarDias(hoje, -3)} 11:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo')` });

  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  const setup = await pedir(porta, 'POST', '/api/auth/setup', {
    corpo: { nome: 'teste', email: 'teste@exemplo.com', senha: 'roupa azul de verao', appPassword: process.env.APP_PASSWORD },
  });
  if (![200, 201].includes(setup.status)) throw new Error(`Setup falhou: ${setup.status} ${setup.texto}`);
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const sem = await pedir(porta, 'GET', '/api/painel-ao-vivo');
  conferir('sem login a rota nega', sem.status === 401, sem.status);

  const r = await pedir(porta, 'GET', '/api/painel-ao-vivo?fresco=1', { cookie });
  conferir('responde 200', r.status === 200, r.status);
  const p = JSON.parse(r.texto);
  conferir('hoje = 2 pedidos (pack conta 1; cancelado e planilha ficam fora)', p.hojeTotais.pedidos === 2, p.hojeTotais);
  conferir('hoje = R$ 230,00', perto(p.hojeTotais.valor, 230), p.hojeTotais.valor);
  conferir('ontem = 2 pedidos, R$ 100,00', p.ontemTotais.pedidos === 2 && perto(p.ontemTotais.valor, 100), p.ontemTotais);
  conferir('duas lojas hoje, com nome do cadastro', p.lojas.length === 2 && p.lojas.some((l) => l.nome === 'Hoggar' && l.pedidos === 1) && p.lojas.some((l) => l.nome === 'Origem' && l.pedidos === 1), p.lojas);
  conferir('plataformas: ML R$ 150 e Shopee R$ 80', perto(p.plataformas.find((x) => x.plataforma === 'mercado_livre').valor, 150) && perto(p.plataformas.find((x) => x.plataforma === 'shopee').valor, 80), p.plataformas);
  conferir('sete dias: ontem R$ 100 e três dias atrás R$ 25', perto(p.seteDias[6].valor, 100) && perto(p.seteDias[4].valor, 25), p.seteDias);
  conferir('estados lidos do envio: SP e BA', p.estados.identificados === 2 && p.estados.lista.some((e) => e.uf === 'SP') && p.estados.lista.some((e) => e.uf === 'BA'), p.estados);
  conferir('ranking traz o código da referência', p.topAnuncios.length > 0 && p.topAnuncios.every((a) => a.codigo === 'OG1620'), p.topAnuncios);
  conferir('atualizado-em vem da última sincronização (≈ 2 min)', p.atualizadoEm && Math.abs(Date.now() - new Date(p.atualizadoEm).getTime() - 120000) < 60000, p.atualizadoEm);
  conferir('nenhuma credencial de loja vaza na resposta', !/SEGREDO-NAO-PODE-VAZAR|ID-SECRETO/.test(r.texto));

  servidor.close();
  await pool.end();
}

async function main() {
  parteLib();
  if (process.env.DATABASE_URL) await parteBanco();
  else console.log('\n(sem DATABASE_URL: parte da rota não rodou)');
  console.log(`\n${passou} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
