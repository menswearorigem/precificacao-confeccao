// O cálculo da aba Marketplace › Full (11/09/2026).
//
// Aqui mora a conta que a tela mostra. A varredura (fullSync.js) só grava o
// que as plataformas responderam; nada aqui escreve no banco.
//
// As cinco perguntas, e de onde sai cada resposta:
//
//   1. QUANTO TEMPO O ESTOQUE DURA — saldo disponível no centro de
//      distribuição ÷ velocidade de venda do anúncio.
//
//   2. QUAL VELOCIDADE USAR — é a regra que a dona definiu, e é o miolo deste
//      arquivo. Um anúncio que está no Full há pouco tempo ainda não gerou
//      venda suficiente LÁ DENTRO para medir nada: usar a venda do Full dele
//      daria uma velocidade montada em cima de dez dias de vitrine nova.
//      Então:
//
//        · no Full há 30 dias ou mais  → mede pela janela recente (30 dias
//          por padrão), que é a velocidade de agora;
//        · no Full há menos de 30 dias → mede pela venda GERAL do anúncio,
//          incluindo todo o período em que ele ainda NÃO estava no Full.
//
//      O resultado sempre vem com `base` dizendo qual dos dois foi usado e
//      sobre quantos dias — a tela escreve isso embaixo do número, porque
//      "dura 12 dias" medido de dois jeitos diferentes são dois números
//      diferentes e quem decide precisa saber qual está lendo (REGRA 2).
//
//   3. QUAL O MÍNIMO PARA ESTAR NO FULL — velocidade × (prazo de recebimento
//      + margem de segurança). Não é um número redondo escolhido a dedo: é
//      quanto o anúncio vende no tempo que uma reposição leva para ficar
//      vendável lá dentro. Peça que gira rápido tem mínimo alto; peça que
//      gira devagar tem mínimo baixo, pela mesma conta.
//
//   4. QUANTO PRECISA MANDAR — o que falta para cobrir o período escolhido
//      MAIS o mínimo, descontando o que já está lá e o que já está a caminho.
//      O período é o que a tela deixa mudar na hora ("quero que este envio
//      dure 45 dias").
//
//   5. QUANDO AS PEÇAS TÊM QUE ESTAR LÁ — o dia em que o saldo encosta no
//      mínimo. E a data LIMITE DE SAÍDA daqui é essa data menos o prazo de
//      recebimento — que é a data que interessa para quem despacha.
//
// REGRA 1: nada aqui toca preço, margem ou markup. REGRA 2: velocidade sem
// venda nenhuma no período volta NULA, e não zero — zero afirmaria que o
// anúncio não vende, e "não vendeu na janela medida" é outra coisa.

const { diaSqlBrasilia } = require('./dataBrasil');

// A data de HOJE em SQL, no fuso de Brasília.
//
// `CURRENT_DATE` seria o dia da SESSÃO do Postgres, que no Render é UTC — e
// das 21h em diante, no horário de Brasília, isso já é amanhã. O estrago aqui
// seria diário e silencioso: a varredura das 22h gravaria o retrato de
// `full_estoque_dia` na data de amanhã, dois retratos do mesmo dia brasileiro
// cairiam em dias diferentes, `desde` nasceria um dia à frente e a série da
// inferência de remessa ganharia degraus que não existiram. O projeto já
// tinha a solução em lib/dataBrasil.js; ela só não estava sendo usada aqui.
const HOJE_SQL = diaSqlBrasilia('now()');

// ---------------------------------------------------------------------------
// Parâmetros
// ---------------------------------------------------------------------------
const PADRAO = {
  dias_cobertura_alvo: 60,
  lead_time_dias: 10,
  dias_seguranca: 10,
  multiplo_envio: 1,
  janela_vendas_dias: 30,
};

// O corte da regra da dona: abaixo disto, a venda do Full ainda não mede nada.
const DIAS_MINIMOS_NO_FULL = 30;

// Teto da janela "venda geral": um anúncio de três anos medido pela média dos
// três anos vira um número que não descreve nenhum mês em particular.
const TETO_JANELA_GERAL_DIAS = 365;

// ⚠️ O teste explícito de nulo e de texto vazio ANTES do Number() não é
// preciosismo: `Number(null)` é 0 e `Number('')` também. Sem estas duas
// linhas, uma coluna NULA (que quer dizer "ninguém definiu") virava um
// ZERO definido — e um `estoque_minimo_manual` nulo passava a vencer o
// mínimo calculado com o valor 0, fazendo o sistema pedir um terço das
// peças e atrasar a data limite em vinte dias, calado.
function inteiro(valor, padrao = null) {
  if (valor === null || valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n) : padrao;
}

function numero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// Reparte um total INTEIRO entre pesos, pelo método do maior resto: a soma
// das partes é exatamente o total. É o que faz a coluna "mandar" de cada cor
// somar o mesmo número que o cartão do anúncio mostra — arredondar cada cor
// por conta própria fazia os dois brigarem na mesma tela.
function distribuirInteiros(total, pesos) {
  const soma = pesos.reduce((s, p) => s + (p > 0 ? p : 0), 0);
  if (!(total > 0) || soma <= 0) return pesos.map(() => 0);
  const brutos = pesos.map((p) => (p > 0 ? (p / soma) * total : 0));
  const base = brutos.map((b) => Math.floor(b));
  let resto = total - base.reduce((s, b) => s + b, 0);
  const ordem = brutos
    .map((b, i) => ({ i, frac: b - Math.floor(b) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of ordem) {
    if (resto <= 0) break;
    base[i] += 1;
    resto -= 1;
  }
  return base;
}

// Coluna DATE do Postgres chega como Date à MEIA-NOITE LOCAL do processo.
// `toISOString()` converte para UTC — e num processo rodando no fuso da
// empresa isso devolve o DIA ANTERIOR a partir das 21h, deslocando de uma vez
// `hoje`, `desde`, as datas de envio e o eixo inteiro da curva. Ler os
// componentes locais devolve exatamente a data que está gravada, em qualquer
// fuso.
function dataIso(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const ano = valor.getFullYear();
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }
  const texto = String(valor);
  return /^\d{4}-\d{2}-\d{2}/.test(texto) ? texto.slice(0, 10) : null;
}

// Dias entre duas datas ISO, inclusivo na ponta inicial. Feito em UTC ao
// meio-dia para que o horário de verão (que o Brasil já teve e pode ter de
// novo) não tire ou acrescente um dia na conta.
function diasEntre(de, ate) {
  const a = new Date(`${de}T12:00:00Z`).getTime();
  const b = new Date(`${ate}T12:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function somarDias(iso, dias) {
  const base = new Date(`${iso}T12:00:00Z`).getTime();
  if (!Number.isFinite(base) || !Number.isFinite(dias)) return null;
  return new Date(base + Math.round(dias) * 86400000).toISOString().slice(0, 10);
}

function arredondarParaMultiplo(valor, multiplo) {
  const m = Math.max(1, inteiro(multiplo, 1) || 1);
  if (valor <= 0) return 0;
  return Math.ceil(valor / m) * m;
}

async function carregarParametros(db, integracaoIds) {
  const { rows } = await db.query(
    `SELECT * FROM full_parametros WHERE origem_integracao_id = ANY($1::int[])`,
    [integracaoIds.length ? integracaoIds : [0]]
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(Number(r.origem_integracao_id), {
      dias_cobertura_alvo: inteiro(r.dias_cobertura_alvo, PADRAO.dias_cobertura_alvo),
      lead_time_dias: inteiro(r.lead_time_dias, PADRAO.lead_time_dias),
      dias_seguranca: inteiro(r.dias_seguranca, PADRAO.dias_seguranca),
      multiplo_envio: inteiro(r.multiplo_envio, PADRAO.multiplo_envio),
      janela_vendas_dias: inteiro(r.janela_vendas_dias, PADRAO.janela_vendas_dias),
      padrao: false,
    });
  }
  return mapa;
}

function parametrosDaLoja(mapa, integracaoId) {
  return mapa.get(Number(integracaoId)) || { ...PADRAO, padrao: true };
}

// ---------------------------------------------------------------------------
// A velocidade de venda, com a regra dos 30 dias
// ---------------------------------------------------------------------------
// `vendas` traz o que a consulta somou: a janela recente, o histórico inteiro
// do anúncio e as datas de primeira e última venda.
function medirVelocidade({ vendas, diasNoFull, janelaDias, hoje }) {
  const janela = Math.max(1, inteiro(janelaDias, PADRAO.janela_vendas_dias) || PADRAO.janela_vendas_dias);
  const noFullTempoSuficiente = diasNoFull != null && diasNoFull >= DIAS_MINIMOS_NO_FULL;

  if (noFullTempoSuficiente) {
    const qtd = numero(vendas?.janela) || 0;
    // O denominador é a JANELA, e não o tempo no Full, porque a janela é
    // exatamente o período que a consulta somou. Usar um denominador menor
    // que o numerador inflaria a velocidade — foi um erro tentador aqui: a
    // vontade de "não medir antes de entrar no Full" não justifica dividir
    // 90 dias de venda por 40 dias de prateleira.
    const dias = janela;
    const antesDeEntrar = diasNoFull != null && diasNoFull < janela;
    return {
      base: 'full',
      rotuloBase: `venda dos últimos ${dias} dias`,
      dias,
      pecas: qtd,
      porDia: qtd > 0 ? qtd / dias : null,
      // Diz por que ESTA base foi escolhida — a tela repete isso ao lado do
      // número, e é o que evita a pergunta "de onde saiu esse 1,4/dia?".
      motivo: `Está no fulfillment há ${diasNoFull} dias, então a velocidade é medida pela venda recente.`
        + (antesDeEntrar
          ? ` A janela escolhida (${janela} dias) é maior que esse tempo, então ela alcança dias em que o anúncio ainda não estava no Full.`
          : ''),
    };
  }

  // Menos de 30 dias no Full: a venda GERAL do anúncio, incluindo o período
  // em que ele ainda não estava lá.
  const primeira = dataIso(vendas?.primeira);
  const total = numero(vendas?.total) || 0;
  const vaoDias = primeira ? Math.max(1, (diasEntre(primeira, hoje) || 0) + 1) : null;
  const dias = vaoDias ? Math.min(vaoDias, TETO_JANELA_GERAL_DIAS) : null;
  // Com teto batido, só a venda DENTRO do teto pode entrar na conta — senão
  // seriam três anos de peça divididos por um ano de dias.
  const pecas = dias && vaoDias && vaoDias > TETO_JANELA_GERAL_DIAS
    ? (numero(vendas?.tetoGeral) ?? total)
    : total;

  return {
    base: 'geral',
    rotuloBase: dias ? `venda geral do anúncio nos últimos ${dias} dias` : 'sem venda registrada',
    dias,
    pecas,
    porDia: dias && pecas > 0 ? pecas / dias : null,
    motivo: diasNoFull == null
      ? 'Ainda não há registro de quando este item entrou no fulfillment, então a conta usa a venda geral do anúncio.'
      : `Está no fulfillment há ${diasNoFull} ${diasNoFull === 1 ? 'dia' : 'dias'} — menos de ${DIAS_MINIMOS_NO_FULL}. `
        + 'A velocidade vem da venda geral do anúncio, contando também o período em que ele não estava lá.',
  };
}

// ---------------------------------------------------------------------------
// A conta de reposição de um anúncio
// ---------------------------------------------------------------------------
// `minimoEfetivo` existe para o nível do ANÚNCIO: lá o mínimo é a soma do
// mínimo de cada cor (cada uma arredondada para cima), e não o cálculo feito
// sobre a velocidade somada — os dois diferem por alguns itens. Sem este
// parâmetro, a tela mostrava um mínimo e as datas eram calculadas com outro.
function calcularReposicao({ saldo, velocidade, params, diasAlvo, minimoManual, minimoEfetivo, hoje }) {
  const disponivel = saldo.disponivel;
  const emTransito = saldo.emTransito || 0;
  const porDia = velocidade.porDia;

  const alvo = Math.max(1, inteiro(diasAlvo, params.dias_cobertura_alvo) || params.dias_cobertura_alvo);
  const diasDeMinimo = (params.lead_time_dias || 0) + (params.dias_seguranca || 0);

  // Mínimo calculado: o que o anúncio vende no tempo que a reposição leva
  // para ficar vendável. Sem velocidade medida não há mínimo calculável — e
  // um mínimo chutado é pior que nenhum.
  const minimoCalculado = porDia != null ? Math.ceil(porDia * diasDeMinimo) : null;
  const minimo = minimoEfetivo != null
    ? minimoEfetivo
    : (minimoManual != null ? minimoManual : minimoCalculado);

  const cobertura = porDia != null && disponivel != null ? disponivel / porDia : null;
  const dataRuptura = cobertura != null ? somarDias(hoje, Math.floor(cobertura)) : null;

  // O dia em que o saldo encosta no mínimo: a data em que as peças novas
  // PRECISAM estar disponíveis lá dentro.
  const diasAteMinimo = porDia != null && disponivel != null && minimo != null
    ? (disponivel - minimo) / porDia
    : null;
  const dataPrecisaEstarLa = diasAteMinimo != null ? somarDias(hoje, Math.floor(diasAteMinimo)) : null;
  // E a data em que a remessa tem que SAIR daqui.
  const dataLimiteEnvio = dataPrecisaEstarLa != null
    ? somarDias(dataPrecisaEstarLa, -(params.lead_time_dias || 0))
    : null;

  let necessidade = null;
  let necessidadeBruta = null;
  if (porDia != null && disponivel != null && minimo != null) {
    necessidadeBruta = porDia * alvo + minimo - disponivel - emTransito;
    necessidade = arredondarParaMultiplo(Math.max(0, Math.ceil(necessidadeBruta)), params.multiplo_envio);
  }

  // A urgência. Não é enfeite: é o que ordena a tela, e é lido do MESMO
  // número que a tela mostra, nunca de um segundo critério paralelo.
  let urgencia = 'sem_medida';
  if (cobertura != null) {
    if (disponivel === 0) urgencia = 'ruptura';
    else if (dataLimiteEnvio != null && diasEntre(hoje, dataLimiteEnvio) <= 0) urgencia = 'atrasado';
    else if (dataLimiteEnvio != null && diasEntre(hoje, dataLimiteEnvio) <= 7) urgencia = 'urgente';
    else if (necessidade != null && necessidade > 0) urgencia = 'planejar';
    else urgencia = 'ok';
  } else if (disponivel === 0) {
    urgencia = 'ruptura';
  }

  return {
    diasAlvo: alvo,
    diasDeMinimo,
    estoqueMinimo: minimo,
    estoqueMinimoCalculado: minimoCalculado,
    estoqueMinimoManual: minimoManual,
    coberturaDias: cobertura != null ? Math.round(cobertura * 10) / 10 : null,
    dataRuptura,
    dataPrecisaEstarLa,
    dataLimiteEnvio,
    diasAteLimite: dataLimiteEnvio != null ? diasEntre(hoje, dataLimiteEnvio) : null,
    precisaEnviar: necessidade,
    precisaEnviarBruto: necessidadeBruta != null ? Math.round(necessidadeBruta * 10) / 10 : null,
    urgencia,
  };
}

// ---------------------------------------------------------------------------
// Desempenho
// ---------------------------------------------------------------------------
// O bloco "como foi no geral". Nenhum número aqui é inventado: conversão só
// existe se a plataforma devolveu visitas, tendência só existe se as duas
// janelas têm venda, e dias sem estoque só contam os dias EFETIVAMENTE
// retratados (a tela mostra o denominador junto).
function medirDesempenho({ vendas, anuncio, snapshots, diasNoFull, velocidadeMedida, pecasPorUnidade = 1 }) {
  const janela = numero(vendas?.janela) || 0;
  const anterior = numero(vendas?.anterior);
  const visitas = numero(anuncio?.visitas);

  const tendencia = anterior != null && anterior > 0
    ? (janela - anterior) / anterior
    : null;

  const diasRetratados = snapshots?.dias || 0;
  const diasZerado = snapshots?.diasZerado || 0;

  return {
    vendasJanela: janela,
    vendasAnterior: anterior,
    // As peças da base que a velocidade realmente usou. A tela mostra ESTE
    // número ao lado do rótulo da base — antes ela escrevia o rótulo da base
    // geral com o número da janela recente ao lado, e as duas leituras não
    // batiam.
    // O número da base medida, na moeda do Full: unidades do anúncio.
    vendasDaBase: numero(velocidadeMedida?.pecas),
    baseDias: velocidadeMedida?.dias ?? null,
    // E o espelho em peças, derivado do MESMO câmbio que o resto da tela usa.
    pecasJanela: numero(vendas?.janela) != null && pecasPorUnidade
      ? Number(vendas.janela) * pecasPorUnidade : null,
    pecasTotal: numero(vendas?.total) != null && pecasPorUnidade
      ? Number(vendas.total) * pecasPorUnidade : null,
    vendasTotalAnuncio: numero(vendas?.total),
    receitaJanela: numero(vendas?.receita),
    // Ticket médio é receita ÷ VENDAS (linhas), não ÷ peças: num anúncio de
    // kit, dividir pelo número de peças daria um terço do preço de venda.
    unidadesJanela: numero(vendas?.unidadesJanela),
    ticketMedio: numero(vendas?.unidadesJanela) > 0 && vendas?.receita != null
      ? Number(vendas.receita) / Number(vendas.unidadesJanela)
      : null,
    primeiraVenda: dataIso(vendas?.primeira),
    ultimaVenda: dataIso(vendas?.ultima),
    diasSemVender: vendas?.ultima ? diasEntre(dataIso(vendas.ultima), snapshots?.hoje || dataIso(vendas.ultima)) : null,
    visitas,
    // Conversão: venda ACUMULADA DA PLATAFORMA ÷ visitas ACUMULADAS DA
    // PLATAFORMA. As duas do mesmo lugar e do mesmo período, que é a única
    // forma de a divisão significar alguma coisa.
    //
    // A tentação era usar a nossa própria contagem de venda — mas ela vai só
    // até onde a importação de pedidos alcançou, enquanto as visitas são o
    // acumulado da vida inteira do anúncio. Dividir uma pela outra daria uma
    // conversão menor do que a real, com cara de número certo.
    conversao: visitas && visitas > 0 && numero(anuncio?.vendas_plataforma) != null
      ? Number(anuncio.vendas_plataforma) / visitas
      : null,
    vendasPlataforma: numero(anuncio?.vendas_plataforma),
    unidadesTotal: numero(vendas?.unidadesTotal),
    tendencia,
    diasRetratados,
    diasZerado,
    // A fração só é honesta se houver retrato suficiente; abaixo de uma
    // semana, a tela mostra os dias crus em vez de um percentual.
    fracaoZerado: diasRetratados >= 7 ? diasZerado / diasRetratados : null,
    diasNoFull,
  };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

// Os itens do Full, com o anúncio e o produto ao lado.
async function carregarItens(db, { integracaoIds, marketplaces, busca, incluirSaidos }) {
  const cond = ['TRUE'];
  const vals = [];
  const add = (sql, valor) => { vals.push(valor); cond.push(sql.replace('$?', `$${vals.length}`)); };

  if (!incluirSaidos) cond.push('fi.no_full');
  if (integracaoIds?.length) add('fi.origem_integracao_id = ANY($?::int[])', integracaoIds);
  if (marketplaces?.length) add('fi.marketplace = ANY($?::text[])', marketplaces);
  if (busca) {
    vals.push(`%${busca}%`);
    const m = `$${vals.length}`;
    cond.push(`(a.titulo ILIKE ${m} OR fi.sku_externo ILIKE ${m} OR fi.anuncio_id_externo ILIKE ${m} OR p.referencia ILIKE ${m})`);
  }

  const { rows } = await db.query(
    `SELECT fi.id, fi.origem_integracao_id, fi.marketplace, fi.anuncio_id,
            fi.anuncio_id_externo, fi.variacao_id_externa, fi.inventory_id,
            fi.sku_externo, fi.produto_id, fi.variante_id,
            fi.no_full, fi.desde, fi.visto_em, fi.saiu_em,
            fi.estoque_disponivel, fi.estoque_indisponivel, fi.estoque_total, fi.estoque_em_transito,
            fi.estoque_minimo_manual, fi.dias_cobertura_manual, fi.ignorar_reposicao,
            fi.pecas_por_unidade, fi.pecas_por_unidade_origem, fi.vinculo_manual,
            fi.status_full, fi.status_externo,
            a.titulo, a.preco, a.status AS status_anuncio, a.url, a.foto_url,
            a.visitas, a.vendas_total AS vendas_plataforma,
            a.criado_em_plataforma,
            p.referencia, p.descricao AS produto_descricao,
            -- Mesma fonte de foto de reserva que a aba de Anúncios usa: a
            -- foto do produto no cadastro, quando a da plataforma não abrir.
            (pf.produto_id IS NOT NULL) AS produto_tem_foto,
            im.nome AS loja_nome,
            av.cor, av.tamanho,
            -- O saldo da casa vem da visão vw_estoque_disponivel (migration
            -- 0056), e não de estoque_variantes.quantidade: reserva de
            -- pedido de cliente NÃO move o saldo, e contar peça reservada
            -- como "pode sair amanhã" faria a ordem de produção nascer menor
            -- do que precisa. Os três números vão juntos para a tela poder
            -- dizer por que o disponível é menor que o saldo.
            -- Quando o item do Full é lido no nível do ANÚNCIO (é o caso da
            -- Shopee, que não separa o saldo do armazém por variação), não há
            -- variante para casar — e sem esta queda o saldo da casa vinha
            -- NULO, o plano concluía que não havia nada na prateleira e
            -- mandava produzir peça que já existia. A queda é o saldo da
            -- REFERÊNCIA inteira, e a coluna ao lado diz que foi isso.
            COALESCE(evd.disponivel, evp.disponivel) AS estoque_casa,
            COALESCE(evd.saldo, evp.saldo) AS estoque_casa_saldo,
            COALESCE(evd.reservado, evp.reservado) AS estoque_casa_reservado,
            CASE WHEN evd.variante_id IS NOT NULL THEN 'variante'
                 WHEN evp.disponivel IS NOT NULL THEN 'referencia'
                 ELSE NULL END AS estoque_casa_origem,
            ${HOJE_SQL} AS hoje
       FROM full_itens fi
       LEFT JOIN anuncios_marketplace a ON a.id = fi.anuncio_id
       LEFT JOIN produtos p ON p.id = fi.produto_id
       LEFT JOIN produto_fotos pf ON pf.produto_id = fi.produto_id
       LEFT JOIN integracoes_marketplace im ON im.id = fi.origem_integracao_id
       LEFT JOIN anuncio_variacoes av
              ON av.anuncio_id = fi.anuncio_id AND av.variacao_id_externa = fi.variacao_id_externa
       LEFT JOIN vw_estoque_disponivel evd ON evd.variante_id = fi.variante_id
       LEFT JOIN LATERAL (
         SELECT SUM(v.disponivel) AS disponivel, SUM(v.saldo) AS saldo, SUM(v.reservado) AS reservado
           FROM vw_estoque_disponivel v
          WHERE fi.variante_id IS NULL
            AND fi.produto_id IS NOT NULL
            AND v.produto_id = fi.produto_id
       ) evp ON TRUE
      WHERE ${cond.join(' AND ')}
      ORDER BY fi.marketplace, im.nome, a.titulo, av.cor, av.tamanho`,
    vals
  );
  return rows;
}

// Venda por ANÚNCIO. A ligação é `pedido_itens.anuncio_id_marketplace`
// (migration 0028) — o código do anúncio na plataforma, casado exato. Nunca
// por título nem por descrição (REGRA 2).
//
// Quatro medidas numa consulta só, porque as quatro são do mesmo conjunto de
// linhas e quatro consultas separadas divergiriam na primeira mudança de
// filtro: a janela, a janela anterior (para a tendência), o total histórico e
// o total dentro do teto de um ano.
async function carregarVendas(db, chaves, { janelaDias }) {
  if (chaves.length === 0) return new Map();
  const integracoes = chaves.map((c) => c.integracaoId);
  const anuncios = chaves.map((c) => c.anuncioIdExterno);

  const { rows } = await db.query(
    `SELECT pv.origem_integracao_id AS integracao_id,
            pi.anuncio_id_marketplace AS anuncio_id_externo,
            -- TUDO AQUI É EM UNIDADES DO ANÚNCIO — a moeda do lado do Full.
            --
            -- O centro de distribuição do marketplace conta unidades do
            -- anúncio: num "Kit 3", uma unidade lá dentro são três camisas.
            -- Velocidade, cobertura, mínimo e quanto mandar são todos desse
            -- lado. Medir a venda em peças contra um saldo em kits dividia a
            -- cobertura por três, calada (ver migration 0073).
            --
            -- A conversão para PEÇAS não acontece aqui: ela é feita uma vez
            -- só, com a coluna full_itens.pecas_por_unidade. Ter duas fontes
            -- para o mesmo câmbio (uma pela composição do kit, outra pelo SKU) era
            -- garantia de as duas divergirem — e de a tela afirmar "kit de 3"
            -- ao lado de "500 kits · 500 peças".
            SUM(pi.quantidade) FILTER (WHERE pv.data_pedido > ${HOJE_SQL} - $3::int) AS janela,
            SUM(pi.quantidade) FILTER (
              WHERE pv.data_pedido > ${HOJE_SQL} - ($3::int * 2)
                AND pv.data_pedido <= ${HOJE_SQL} - $3::int) AS anterior,
            SUM(pi.quantidade) AS total,
            SUM(pi.quantidade) FILTER (WHERE pv.data_pedido > ${HOJE_SQL} - 365) AS teto_geral,
            SUM(pi.total) FILTER (WHERE pv.data_pedido > ${HOJE_SQL} - $3::int) AS receita,
            MIN(pv.data_pedido) AS primeira,
            MAX(pv.data_pedido) AS ultima
       FROM pedido_itens pi
       JOIN pedidos_venda pv ON pv.id = pi.pedido_id
      WHERE pi.anuncio_id_marketplace = ANY($2::text[])
        AND pv.origem_integracao_id = ANY($1::int[])
        AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
        -- Devolução e troca entram no sistema como pedido próprio. Contá-las
        -- como venda aumentaria a velocidade justamente do item que voltou.
        AND COALESCE(pv.operacao, 'Venda') NOT IN ('Devolução', 'Troca')
      GROUP BY 1, 2`,
    [integracoes, anuncios, Math.max(1, inteiro(janelaDias, PADRAO.janela_vendas_dias))]
  );

  const mapa = new Map();
  for (const r of rows) {
    mapa.set(`${r.integracao_id}|${r.anuncio_id_externo}`, {
      janela: numero(r.janela) || 0,
      anterior: numero(r.anterior),
      receita: numero(r.receita),
      total: numero(r.total) || 0,
      tetoGeral: numero(r.teto_geral),
      unidadesJanela: numero(r.janela) || 0,
      unidadesTotal: numero(r.total) || 0,
      primeira: r.primeira,
      ultima: r.ultima,
    });
  }
  return mapa;
}

// A grade vendida de cada anúncio: quanto saiu de cada cor e tamanho. É ela
// que reparte o envio entre as variações e, depois, vira a grade da ordem de
// produção. Sem venda registrada não há repartição — e o plano diz isso em
// vez de dividir por igual em silêncio.
async function carregarMixGrade(db, chaves, { janelaDias }) {
  if (chaves.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT pv.origem_integracao_id AS integracao_id,
            pi.anuncio_id_marketplace AS anuncio_id_externo,
            pi.variante_id,
            COALESCE(pi.cor, '') AS cor,
            COALESCE(pi.tamanho, '') AS tamanho,
            SUM(pi.quantidade) AS quantidade
       FROM pedido_itens pi
       JOIN pedidos_venda pv ON pv.id = pi.pedido_id
      WHERE pi.anuncio_id_marketplace = ANY($2::text[])
        AND pv.origem_integracao_id = ANY($1::int[])
        AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
        AND COALESCE(pv.operacao, 'Venda') NOT IN ('Devolução', 'Troca')
        AND pv.data_pedido > ${HOJE_SQL} - $3::int
        -- Item vendido DENTRO de kit fica de fora da grade: ele não guarda
        -- cor nem tamanho de variante (o kit é uma composição, não uma
        -- variante), e o que está gravado em pi.cor/pi.tamanho nesse caso é
        -- do kit. Entrar aqui criaria uma linha de grade falsa — e a
        -- repartição do envio passaria a mandar peça de uma cor que não
        -- existe (REGRA 2).
        AND pi.kit_id IS NULL
      GROUP BY 1, 2, 3, 4, 5`,
    [chaves.map((c) => c.integracaoId), chaves.map((c) => c.anuncioIdExterno),
      Math.max(1, inteiro(janelaDias, PADRAO.janela_vendas_dias))]
  );
  const mapa = new Map();
  for (const r of rows) {
    const chave = `${r.integracao_id}|${r.anuncio_id_externo}`;
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push({
      varianteId: r.variante_id != null ? Number(r.variante_id) : null,
      cor: r.cor,
      tamanho: r.tamanho,
      quantidade: numero(r.quantidade) || 0,
    });
  }
  return mapa;
}

// Quantos dias de retrato existem por item e em quantos deles o saldo estava
// zerado. O denominador vai junto de propósito: "3 dias zerado" sobre 5 dias
// de retrato e sobre 90 dias são frases muito diferentes.
async function carregarSnapshots(db, itemIds) {
  if (itemIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT full_item_id,
            COUNT(*)::int AS dias,
            COUNT(*) FILTER (WHERE COALESCE(disponivel, 0) = 0)::int AS dias_zerado,
            MIN(data) AS primeiro_retrato
       FROM full_estoque_dia
      WHERE full_item_id = ANY($1::int[])
      GROUP BY full_item_id`,
    [itemIds]
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(Number(r.full_item_id), {
      dias: r.dias,
      diasZerado: r.dias_zerado,
      primeiroRetrato: dataIso(r.primeiro_retrato),
    });
  }
  return mapa;
}

// A curva do saldo de um item, para o gráfico do painel.
async function carregarCurva(db, itemIds, dias = 90) {
  if (itemIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT data, SUM(disponivel)::int AS disponivel,
            SUM(COALESCE(em_transito, 0))::int AS em_transito
       FROM full_estoque_dia
      WHERE full_item_id = ANY($1::int[])
        AND data > ${HOJE_SQL} - $2::int
      GROUP BY data
      ORDER BY data`,
    [itemIds, dias]
  );
  return rows.map((r) => ({
    data: dataIso(r.data),
    disponivel: r.disponivel,
    emTransito: r.em_transito,
  }));
}

// Remessas que tocaram estes itens, mais recentes primeiro.
async function carregarEnvios(db, itemIds, { limite = 60 } = {}) {
  if (itemIds.length === 0) return [];
  const { rows } = await db.query(
    `SELECT e.id, e.envio_id_externo, e.origem, e.status, e.status_externo,
            e.enviado_em, e.previsao_em, e.recebido_em,
            e.quantidade_enviada, e.quantidade_recebida, e.observacoes,
            e.criado_em,
            COALESCE(SUM(ei.quantidade_enviada), 0)::int AS pecas_destes_itens,
            -- A contagem da remessa INTEIRA, e não das linhas que o filtro
            -- deixou passar: com COUNT() aqui fora, uma remessa de quarenta
            -- referências aparecia como "2 itens na remessa" só porque o
            -- anúncio aberto tem duas variações.
            (SELECT COUNT(*)::int FROM full_envio_itens t WHERE t.envio_id = e.id) AS itens_no_envio
       FROM full_envios e
       JOIN full_envio_itens ei ON ei.envio_id = e.id
      WHERE ei.full_item_id = ANY($1::int[])
      GROUP BY e.id
      ORDER BY COALESCE(e.recebido_em, e.enviado_em, e.criado_em::date) DESC
      LIMIT $2`,
    [itemIds, limite]
  );
  return rows.map((r) => ({
    id: r.id,
    envioIdExterno: r.envio_id_externo,
    origem: r.origem,
    status: r.status,
    statusExterno: r.status_externo,
    enviadoEm: dataIso(r.enviado_em),
    previsaoEm: dataIso(r.previsao_em),
    recebidoEm: dataIso(r.recebido_em),
    quantidadeEnviada: r.quantidade_enviada,
    quantidadeRecebida: r.quantidade_recebida,
    pecasDestesItens: r.pecas_destes_itens,
    itensNoEnvio: r.itens_no_envio,
    observacoes: r.observacoes,
  }));
}


// O casamento do item do Full com a VARIANTE do cadastro.
//
// Mora aqui, e não copiado em dois lugares, porque a varredura e a tela de
// vínculo precisam casar exatamente do mesmo jeito — duas cópias divergiriam
// na primeira correção.
//
// O detalhe que faltava: o SKU de KIT. "KIT-3-OG1190-PRETO-M" normaliza para
// KIT3OG1190PRETOM e nunca batia com referência||cor||tamanho, então TODO
// item de kit ficava sem variante para sempre — e, sem variante, o saldo do
// galpão caía para o da referência inteira e era prometido de novo a cada
// cor, fazendo o plano concluir que não havia nada a produzir.
//
// O prefixo KIT<n> é retirado antes de comparar. Isso NÃO é casar por
// descrição (REGRA 2): cor e tamanho aqui saem do próprio SKU, que é campo
// estruturado, com o padrão que a casa usa.
const SQL_CASAR_VARIANTE = `
  UPDATE full_itens fi
     SET variante_id = ev.id, atualizado_em = now()
    FROM estoque_variantes ev
    JOIN produtos p ON p.id = ev.produto_id
   WHERE fi.id = ANY($1::int[])
     AND fi.produto_id IS NOT NULL
     AND ev.produto_id = fi.produto_id
     AND fi.sku_externo IS NOT NULL
     AND regexp_replace(
           upper(regexp_replace(fi.sku_externo, '[^A-Za-z0-9]', '', 'g')),
           '^KIT[0-9]+', '')
         = upper(regexp_replace(p.referencia || ev.cor || ev.tamanho, '[^A-Za-z0-9]', '', 'g'))
     AND fi.variante_id IS DISTINCT FROM ev.id`;

async function casarVariantes(db, itemIds) {
  if (!itemIds || itemIds.length === 0) return 0;
  const { rowCount } = await db.query(SQL_CASAR_VARIANTE, [itemIds]);
  return rowCount;
}

// A COMPOSIÇÃO de cada variação: o que sai da expedição quando uma unidade
// daquela variação é vendida (migration 0074).
//
// Só existe onde alguém registrou. Onde não existe, o plano cai no padrão do
// SKU — N peças da própria cor —, que é o kit de uma cor só. A diferença
// entre os dois casos é dita na tela: um plano montado sobre a composição
// registrada é medição; montado sobre o SKU, é a suposição de que o kit é
// monocromático.
async function carregarComposicao(db, itemIds) {
  if (!itemIds || itemIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT fc.full_item_id, fc.id, fc.produto_id, fc.cor, fc.tamanho,
            fc.variante_id, fc.quantidade, fc.ordem,
            p.referencia, p.descricao,
            evd.disponivel AS estoque_casa, evd.reservado AS estoque_casa_reservado
       FROM full_composicao fc
       JOIN produtos p ON p.id = fc.produto_id
       LEFT JOIN vw_estoque_disponivel evd ON evd.variante_id = fc.variante_id
      WHERE fc.full_item_id = ANY($1::int[])
      ORDER BY fc.full_item_id, fc.ordem, fc.id`,
    [itemIds]
  );
  const mapa = new Map();
  for (const r of rows) {
    const chave = Number(r.full_item_id);
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push({
      id: r.id,
      produtoId: r.produto_id,
      referencia: r.referencia,
      descricao: r.descricao,
      cor: r.cor,
      tamanho: r.tamanho,
      varianteId: r.variante_id,
      quantidade: Number(r.quantidade) || 0,
      estoqueCasa: numero(r.estoque_casa),
      estoqueCasaReservado: numero(r.estoque_casa_reservado),
    });
  }
  return mapa;
}

// Casa cada linha da composição com a variante do cadastro, por cor e tamanho
// normalizados DENTRO da referência já escolhida. Não é casar por descrição
// (REGRA 2): a referência veio de uma escolha explícita, e cor e tamanho são
// campos do cadastro comparados com os campos da composição.
const SQL_CASAR_COMPOSICAO = `
  UPDATE full_composicao fc
     SET variante_id = ev.id, atualizado_em = now()
    FROM estoque_variantes ev
   WHERE fc.full_item_id = ANY($1::int[])
     AND ev.produto_id = fc.produto_id
     AND upper(regexp_replace(ev.cor, '[^A-Za-z0-9]', '', 'g'))
         = upper(regexp_replace(fc.cor, '[^A-Za-z0-9]', '', 'g'))
     AND upper(regexp_replace(ev.tamanho, '[^A-Za-z0-9]', '', 'g'))
         = upper(regexp_replace(fc.tamanho, '[^A-Za-z0-9]', '', 'g'))
     AND fc.variante_id IS DISTINCT FROM ev.id`;

async function casarComposicao(db, itemIds) {
  if (!itemIds || itemIds.length === 0) return 0;
  const { rowCount } = await db.query(SQL_CASAR_COMPOSICAO, [itemIds]);
  return rowCount;
}

// Peças JÁ DESPACHADAS e ainda não confirmadas lá dentro, segundo o nosso
// registro — não o da plataforma.
//
// Por que existe: a conta de reposição descontava só `estoque_em_transito`,
// que vem da leitura da plataforma. Na Shopee esse campo é sempre NULO (a
// API de item não separa "a caminho do armazém"), e no Mercado Livre ele só
// aparece depois que a remessa é recebida no galpão deles. Resultado: a
// expedição despachava 300 peças hoje e a tela continuava pedindo as mesmas
// 300 todos os dias durante o prazo inteiro de recebimento — e alguém
// mandaria duas vezes.
//
// A remessa é considerada "a caminho" enquanto não tiver data de recebimento
// e não estiver cancelada. O corte de 120 dias existe para que uma remessa
// que ninguém deu baixa não fique abatendo reposição para sempre.
async function carregarEmTransitoRegistrado(db, itemIds) {
  if (itemIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT ei.full_item_id,
            SUM(ei.quantidade_enviada - COALESCE(ei.quantidade_recebida, 0))::int AS pecas,
            MIN(e.enviado_em) AS desde
       FROM full_envio_itens ei
       JOIN full_envios e ON e.id = ei.envio_id
      WHERE ei.full_item_id = ANY($1::int[])
        AND e.origem <> 'inferido'
        AND e.recebido_em IS NULL
        AND COALESCE(e.status, '') NOT IN ('cancelado', 'recebido')
        AND COALESCE(e.enviado_em, e.criado_em::date) > ${HOJE_SQL} - 120
      GROUP BY ei.full_item_id`,
    [itemIds]
  );
  const mapa = new Map();
  for (const r of rows) {
    const pecas = numero(r.pecas);
    if (pecas != null && pecas > 0) mapa.set(Number(r.full_item_id), { pecas, desde: dataIso(r.desde) });
  }
  return mapa;
}

// Primeiro e último envio POR ITEM — as duas datas que a tela mostra no
// cartão sem precisar abrir o histórico inteiro.
async function carregarPontasDeEnvio(db, itemIds) {
  if (itemIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT ei.full_item_id,
            MIN(COALESCE(e.enviado_em, e.recebido_em)) AS primeiro,
            MAX(COALESCE(e.enviado_em, e.recebido_em)) AS ultimo,
            COUNT(DISTINCT e.id)::int AS envios,
            SUM(ei.quantidade_enviada)::int AS pecas,
            BOOL_OR(e.origem <> 'inferido') AS tem_registro_firme
       FROM full_envio_itens ei
       JOIN full_envios e ON e.id = ei.envio_id
      WHERE ei.full_item_id = ANY($1::int[])
        AND COALESCE(e.status, '') <> 'cancelado'
      GROUP BY ei.full_item_id`,
    [itemIds]
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(Number(r.full_item_id), {
      primeiro: dataIso(r.primeiro),
      ultimo: dataIso(r.ultimo),
      envios: r.envios,
      pecas: r.pecas,
      temRegistroFirme: Boolean(r.tem_registro_firme),
    });
  }
  return mapa;
}

// Normalização de comparação: sem acento, sem separador, em maiúsculas. É a
// mesma forma usada no casamento de SKU do sincronismo — nunca para DECIDIR
// vínculo (isso é por SKU exato, REGRA 2), só para casar a cor e o tamanho
// lidos da plataforma com a cor e o tamanho do pedido.
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function somaOuNulo(valores) {
  const validos = valores.filter((v) => v != null && Number.isFinite(Number(v)));
  if (validos.length === 0) return null;
  return validos.reduce((s, v) => s + Number(v), 0);
}

// ---------------------------------------------------------------------------
// A repartição do anúncio entre as variações
// ---------------------------------------------------------------------------
// A velocidade é medida no ANÚNCIO (é lá que a venda está amarrada, pelo
// código do anúncio no pedido). Mas o envio é por COR e TAMANHO — mandar 120
// peças "do anúncio" não é uma instrução que a expedição consiga cumprir.
//
// A repartição usa a GRADE VENDIDA do próprio anúncio na janela. Onde não há
// venda registrada para repartir, divide por igual e MARCA como divisão por
// igual — a tela mostra o aviso, porque um plano montado sobre divisão igual
// é um chute educado, não uma medição (REGRA 2).
function repartirEntreUnidades(unidades, mix) {
  const porVariante = new Map();
  const porGrade = new Map();
  let totalMix = 0;
  for (const m of mix || []) {
    totalMix += m.quantidade;
    if (m.varianteId != null) {
      porVariante.set(m.varianteId, (porVariante.get(m.varianteId) || 0) + m.quantidade);
    }
    const chave = `${normalizar(m.cor)}|${normalizar(m.tamanho)}`;
    porGrade.set(chave, (porGrade.get(chave) || 0) + m.quantidade);
  }

  const cruas = unidades.map((u) => {
    if (u.variante_id != null && porVariante.has(Number(u.variante_id))) {
      return { valor: porVariante.get(Number(u.variante_id)), origem: 'variante' };
    }
    const chave = `${normalizar(u.cor)}|${normalizar(u.tamanho)}`;
    if (porGrade.has(chave)) return { valor: porGrade.get(chave), origem: 'grade' };
    return { valor: null, origem: null };
  });

  const somaCasada = cruas.reduce((s, c) => s + (c.valor || 0), 0);

  if (totalMix > 0 && somaCasada > 0) {
    const comVenda = cruas.filter((c) => c.valor != null);
    // Variação sem venda casada NÃO recebe zero: ficaria fora de qualquer
    // reposição para sempre, inclusive a cor nova que acabou de entrar. Ela
    // entra com a MENOR participação entre as que têm venda — o mínimo que
    // ainda a mantém viva sem inventar demanda para ela.
    const minima = comVenda.length > 0
      ? Math.min(...comVenda.map((c) => c.valor)) / somaCasada
      : 0;
    const brutas = cruas.map((c) => ({
      bruta: c.valor != null ? c.valor / somaCasada : minima,
      origem: c.valor != null ? c.origem : 'sem_venda',
    }));
    // Renormaliza: sem isto, cada variação sem venda ACRESCENTA participação
    // e o total passa de 100% — a soma das cores pediria mais peça do que o
    // anúncio precisa.
    const totalBruto = brutas.reduce((s, b) => s + b.bruta, 0) || 1;
    return brutas.map((b) => ({
      participacao: b.bruta / totalBruto,
      origem: b.origem,
      semVenda: b.origem === 'sem_venda',
    }));
  }

  const igual = unidades.length > 0 ? 1 / unidades.length : 0;
  return unidades.map(() => ({ participacao: igual, origem: 'igual', semVenda: true }));
}

// ---------------------------------------------------------------------------
// Monta um anúncio inteiro: saldo, velocidade, reposição, desempenho
// ---------------------------------------------------------------------------
function montarAnuncio({ unidades, vendas, mix, params, snapshots, pontas, transito, composicao, hoje, diasAlvoPedido, janelaDias }) {
  const primeiro = unidades[0];

  // "A caminho" tem DUAS fontes, e as duas precisam entrar — pela MAIOR, não
  // pela soma:
  //
  //   · o que a plataforma declara em trânsito (só o Mercado Livre declara;
  //     na Shopee esse campo é sempre nulo);
  //   · o que a NOSSA expedição registrou como despachado e ainda não
  //     recebido.
  //
  // Somar as duas contaria a mesma remessa duas vezes assim que a plataforma
  // passasse a enxergá-la, e a casa mandaria peça de menos. Ignorar a segunda
  // faz a tela pedir a mesma remessa todo dia durante o prazo de recebimento
  // inteiro — que era o defeito. O maior das duas é a única leitura que não
  // erra em nenhum dos dois sentidos.
  const transitoRegistrado = (u) => transito?.get(u.id)?.pecas ?? null;
  const plataformaTotal = somaOuNulo(unidades.map((u) => u.estoque_em_transito));
  const registradoTotal = somaOuNulo(unidades.map(transitoRegistrado));

  // O crédito que a remessa registrada acrescenta ALÉM do que a plataforma já
  // enxerga. É aplicado no TOTAL do anúncio, e não variação por variação, por
  // uma razão prática: a expedição registra a remessa no anúncio (o formulário
  // grava na primeira variação), então o crédito não tem dono por cor. Descê-lo
  // para uma variação só fazia o excedente dela evaporar no `max(0, …)` e as
  // outras cores continuarem pedindo a remessa inteira de novo — que era
  // exatamente o defeito que o desconto veio corrigir.
  const creditoRegistrado = Math.max(
    0,
    (Number(registradoTotal) || 0) - (Number(plataformaTotal) || 0)
  );

  // Por variação, só o que a plataforma declara: esse número TEM dono.
  const emTransitoPorUnidade = unidades.map((u) => u.estoque_em_transito);

  const saldo = {
    disponivel: somaOuNulo(unidades.map((u) => u.estoque_disponivel)),
    indisponivel: somaOuNulo(unidades.map((u) => u.estoque_indisponivel)),
    total: somaOuNulo(unidades.map((u) => u.estoque_total)),
    emTransito: plataformaTotal == null && registradoTotal == null
      ? null
      : Math.max(Number(plataformaTotal) || 0, Number(registradoTotal) || 0),
    emTransitoPlataforma: plataformaTotal,
    emTransitoRegistrado: registradoTotal,
  };
  const estoqueCasa = somaOuNulo(unidades.map((u) => u.estoque_casa));
  const estoqueCasaReservado = somaOuNulo(unidades.map((u) => u.estoque_casa_reservado));

  // Quantas variações NÃO tiveram o saldo lido. Vai para a tela porque muda o
  // sentido de todos os números do cartão: "120 peças no Full" com duas cores
  // não lidas não é 120 — é "pelo menos 120" (REGRA 2).
  const naoLidas = unidades.filter((u) => u.estoque_disponivel == null);

  // Desde quando está no Full: a data mais antiga entre as variações. Uma cor
  // que entrou depois não reinicia a contagem do anúncio.
  const desdes = unidades.map((u) => dataIso(u.desde)).filter(Boolean).sort();
  const desde = desdes[0] || null;
  const diasNoFull = desde ? (diasEntre(desde, hoje) || 0) + 1 : null;

  const velocidade = medirVelocidade({ vendas, diasNoFull, janelaDias, hoje });

  // O período que o envio deve durar: o que a tela pediu agora vence o que
  // está gravado no item, que por sua vez vence o padrão da loja.
  const manualDoItem = unidades
    .map((u) => inteiro(u.dias_cobertura_manual))
    .filter((v) => v != null)[0] ?? null;
  const diasAlvo = inteiro(diasAlvoPedido) ?? manualDoItem ?? params.dias_cobertura_alvo;

  const participacoes = repartirEntreUnidades(unidades, mix);
  const ignorado = unidades.every((u) => u.ignorar_reposicao);

  const detalhes = unidades.map((u, i) => {
    const p = participacoes[i];
    const porDiaUnidade = velocidade.porDia != null ? velocidade.porDia * p.participacao : null;
    const minimoManual = inteiro(u.estoque_minimo_manual);
    const conta = calcularReposicao({
      saldo: { disponivel: u.estoque_disponivel, emTransito: emTransitoPorUnidade[i] },
      velocidade: { porDia: porDiaUnidade },
      params,
      diasAlvo,
      minimoManual,
      hoje,
    });
    return {
      id: u.id,
      variacaoIdExterna: u.variacao_id_externa || null,
      inventoryId: u.inventory_id,
      sku: u.sku_externo,
      cor: u.cor,
      tamanho: u.tamanho,
      varianteId: u.variante_id,
      // A referência DESTA variação. Desde que a varredura passou a resolver
      // o SKU por variação, um anúncio pode ter variações de referências
      // diferentes — e o plano precisa agrupar por esta, não pela do anúncio.
      produtoId: u.produto_id ?? null,
      vinculoManual: Boolean(u.vinculo_manual),
      estoqueCasa: u.estoque_casa != null ? Number(u.estoque_casa) : null,
      estoqueCasaReservado: u.estoque_casa_reservado != null ? Number(u.estoque_casa_reservado) : null,
      // 'variante' = saldo da cor/tamanho exatos. 'referencia' = saldo da
      // referência inteira, porque o Full desta loja é lido no nível do
      // anúncio (Shopee) e não há variante para casar. A tela diz qual é.
      estoqueCasaOrigem: u.estoque_casa_origem || null,
      // O câmbio entre as duas moedas: quantas PEÇAS da nossa referência
      // cabem em UMA unidade do anúncio (3 num kit de 3, 1 no resto).
      pecasPorUnidade: inteiro(u.pecas_por_unidade) ?? 1,
      pecasPorUnidadeOrigem: u.pecas_por_unidade_origem || null,
      // O que sai da expedição quando UMA unidade desta variação é vendida.
      // Vazio = ninguém registrou, e o plano cai no padrão do SKU (N peças da
      // própria cor). A tela diz qual dos dois está valendo.
      composicao: composicao?.get(u.id) || [],
      // A chave que impede a mesma peça física de ser contada (ou prometida)
      // duas vezes quando alimenta dois anúncios.
      estoqueCasaChave: u.variante_id != null
        ? `v${u.variante_id}`
        : (u.produto_id != null && u.estoque_casa_origem === 'referencia' ? `p${u.produto_id}` : null),
      disponivel: u.estoque_disponivel,
      indisponivel: u.estoque_indisponivel,
      emTransito: emTransitoPorUnidade[i],
      emTransitoRegistrado: transitoRegistrado(u),
      statusFull: u.status_full,
      naoLido: u.status_externo || null,
      noFull: u.no_full,
      desde: dataIso(u.desde),
      saiuEm: dataIso(u.saiu_em),
      ignorarReposicao: u.ignorar_reposicao,
      diasCoberturaManual: inteiro(u.dias_cobertura_manual),
      participacao: p.participacao,
      participacaoOrigem: p.origem,
      velocidadeDia: porDiaUnidade,
      ...conta,
      // O `precisaEnviar` que vem de `conta` é arredondado ao múltiplo de
      // envio POR VARIAÇÃO — e o múltiplo se aplica uma vez só, no total do
      // anúncio. Deixá-lo na resposta seria uma armadilha: é o campo de nome
      // mais óbvio, e quem o lesse somaria 600 onde o cartão mostra 500. O
      // número por cor é `precisaEnviarUnidade`, preenchido logo abaixo.
      precisaEnviar: undefined,
      // Sem arredondamento por unidade de propósito: o múltiplo de envio é
      // aplicado UMA vez, na soma do anúncio. Arredondar cada cor para cima
      // inflaria a remessa inteira.
      precisaEnviarCru: conta.precisaEnviarBruto != null ? Math.max(0, conta.precisaEnviarBruto) : null,
    };
  });

  const temNecessidade = detalhes.some((d) => d.precisaEnviarCru != null);
  const somaNecessidade = temNecessidade
    ? detalhes.reduce((s, d) => s + (d.ignorarReposicao ? 0 : (d.precisaEnviarCru || 0)), 0)
    : null;

  // O total do anúncio é arredondado UMA vez (o múltiplo de envio da loja), e
  // então repartido de volta entre as cores pelo método do maior resto. É o
  // que faz a coluna "mandar" da aba de cores somar exatamente o número do
  // cartão — antes, o cartão arredondava o total e a tabela arredondava cada
  // cor, e os dois brigavam na mesma tela.
  const totalAEnviar = somaNecessidade != null
    ? arredondarParaMultiplo(
      Math.max(0, Math.ceil(somaNecessidade - creditoRegistrado)),
      params.multiplo_envio
    )
    : null;
  if (totalAEnviar != null) {
    const repartido = distribuirInteiros(
      totalAEnviar,
      detalhes.map((d) => (d.ignorarReposicao ? 0 : (d.precisaEnviarCru || 0)))
    );
    detalhes.forEach((d, i) => { d.precisaEnviarUnidade = repartido[i]; });
  } else {
    detalhes.forEach((d) => { d.precisaEnviarUnidade = null; });
  }

  // O mínimo do anúncio é a SOMA do mínimo EFETIVO de cada cor — manual onde
  // alguém definiu, calculado no resto.
  //
  // Somar só os manuais (que era o que estava aqui) tinha um efeito perverso:
  // bastava UMA cor com mínimo à mão para o anúncio inteiro passar a ter um
  // mínimo manual igual ao daquela cor sozinha, vencendo o cálculo das outras
  // — e a aba Ajustes ainda oferecia esse total encolhido de volta no campo,
  // pronto para ser regravado em cima das cores certas com um clique.
  const minimosEfetivos = detalhes.map((d) => d.estoqueMinimo);
  const todosManuais = unidades.length > 0
    && unidades.every((u) => inteiro(u.estoque_minimo_manual) != null);

  const reposicao = calcularReposicao({
    saldo,
    velocidade,
    params,
    diasAlvo,
    // Só conta como "definido à mão" quando TODAS as cores foram definidas à
    // mão; no caso misto o número existe, mas não é um valor que alguém
    // digitou, e a tela não pode dizer que foi.
    minimoManual: todosManuais ? somaOuNulo(minimosEfetivos) : null,
    // E a conta usa a soma do mínimo de cada cor — o MESMO número que a tela
    // mostra —, para a data e o mínimo do topo virem do mesmo lugar.
    minimoEfetivo: somaOuNulo(minimosEfetivos),
    hoje,
  });

  // A data que manda é a da variação que quebra PRIMEIRO: um anúncio com a
  // cor campeã zerada já está perdendo venda, mesmo com as outras cheias.
  // ---- As datas do anúncio são do ANÚNCIO ----------------------------------
  //
  // A primeira versão trazia para o topo a data da variação que quebra
  // primeiro, com o argumento de que um anúncio com a cor campeã zerada já
  // está perdendo venda. O argumento continua verdadeiro, mas o efeito na
  // tela era incoerente e assustou quem leu: o painel mostrava "21,4 dias de
  // estoque" e, dois centímetros abaixo, "as peças têm que estar lá em
  // 21/08" — uma data do mês passado —, porque uma cor de doze já estava
  // zerada. Dois números do mesmo bloco falando de coisas diferentes sem
  // dizer isso.
  //
  // Agora o bloco do topo é todo do MESMO nível: cobertura, mínimo e datas do
  // anúncio inteiro. A cor zerada não sumiu — virou um aviso próprio, com
  // nome e contagem, que aponta para a aba Cores e tamanhos.
  const comSaldoLido = detalhes.filter((d) => d.disponivel != null);
  const zeradas = comSaldoLido.filter((d) => Number(d.disponivel) === 0);
  const coresZeradas = {
    quantidade: zeradas.length,
    total: comSaldoLido.length,
    // Só é "algumas cores zeradas" quando SOBRA alguma: com todas zeradas o
    // anúncio inteiro está em ruptura, e quem diz isso é a urgência.
    parcial: zeradas.length > 0 && zeradas.length < comSaldoLido.length,
    nomes: zeradas.map((d) => [d.cor, d.tamanho].filter(Boolean).join(' ')).filter(Boolean).slice(0, 6),
  };

  const urgenciaPeso = {
    ruptura: 6, atrasado: 5, urgente: 4, cor_zerada: 3, planejar: 2, ok: 1, sem_medida: 0,
  };
  // A urgência é a do anúncio. A única coisa que a variação acrescenta é o
  // estado `cor_zerada`, e ele nunca REBAIXA o que o anúncio já dizia.
  const urgencia = coresZeradas.parcial
      && urgenciaPeso[reposicao.urgencia] < urgenciaPeso.cor_zerada
    ? 'cor_zerada'
    : reposicao.urgencia;

  const diasRetratados = Math.max(0, ...unidades.map((u) => snapshots.get(u.id)?.dias || 0));
  const diasZerado = Math.max(0, ...unidades.map((u) => snapshots.get(u.id)?.diasZerado || 0));
  const primeiroRetrato = unidades
    .map((u) => snapshots.get(u.id)?.primeiroRetrato)
    .filter(Boolean).sort()[0] || null;

  const desempenho = medirDesempenho({
    vendas,
    anuncio: primeiro,
    snapshots: { dias: diasRetratados, diasZerado, hoje },
    diasNoFull,
    velocidadeMedida: velocidade,
    pecasPorUnidade: Math.max(...detalhes.map((d) => d.pecasPorUnidade || 1), 1),
  });

  const pontasDoAnuncio = unidades
    .map((u) => pontas.get(u.id))
    .filter(Boolean);
  const envio = pontasDoAnuncio.length > 0
    ? {
      primeiro: pontasDoAnuncio.map((p) => p.primeiro).filter(Boolean).sort()[0] || null,
      ultimo: pontasDoAnuncio.map((p) => p.ultimo).filter(Boolean).sort().slice(-1)[0] || null,
      envios: Math.max(...pontasDoAnuncio.map((p) => p.envios)),
      pecas: pontasDoAnuncio.reduce((s, p) => s + (p.pecas || 0), 0),
      temRegistroFirme: pontasDoAnuncio.some((p) => p.temRegistroFirme),
    }
    : { primeiro: null, ultimo: null, envios: 0, pecas: 0, temRegistroFirme: false };

  return {
    chave: `${primeiro.origem_integracao_id}|${primeiro.anuncio_id_externo}`,
    anuncioId: primeiro.anuncio_id,
    anuncioIdExterno: primeiro.anuncio_id_externo,
    integracaoId: primeiro.origem_integracao_id,
    marketplace: primeiro.marketplace,
    lojaNome: primeiro.loja_nome,
    titulo: primeiro.titulo,
    url: primeiro.url,
    fotoUrl: primeiro.foto_url,
    produtoId: primeiro.produto_id,
    produtoTemFoto: primeiro.produto_tem_foto,
    referencia: primeiro.referencia,
    produtoDescricao: primeiro.produto_descricao,
    preco: primeiro.preco != null ? Number(primeiro.preco) : null,
    statusAnuncio: primeiro.status_anuncio,
    noFull: unidades.some((u) => u.no_full),
    desde,
    diasNoFull,
    saiuEm: unidades.every((u) => !u.no_full)
      ? unidades.map((u) => dataIso(u.saiu_em)).filter(Boolean).sort().slice(-1)[0] || null
      : null,
    saldo,
    estoqueCasa,
    estoqueCasaReservado,
    // Quantas peças tem uma unidade deste anúncio. Quando é mais de 1 — um
    // kit — a tela escreve as DUAS medidas lado a lado, porque "mandar 998"
    // significa coisas muito diferentes para a expedição e para o corte.
    pecasPorUnidade: Math.max(...detalhes.map((d) => d.pecasPorUnidade || 1), 1),
    ehKit: detalhes.some((d) => (d.pecasPorUnidade || 1) > 1 || (d.composicao || []).length > 0),
    // Quantas variações já têm a composição registrada. É o que separa um
    // plano medido de um plano suposto, e a tela escreve a diferença.
    composicaoRegistrada: detalhes.filter((d) => (d.composicao || []).length > 0).length,
    // A tela precisa disto para não afirmar um total que não mediu.
    leitura: {
      unidades: unidades.length,
      naoLidas: naoLidas.length,
      completa: naoLidas.length === 0,
      motivos: [...new Set(naoLidas.map((u) => u.status_externo).filter(Boolean))],
    },
    velocidade,
    parametros: params,
    ignorado,
    reposicao: {
      ...reposicao,
      estoqueMinimoParcial: !todosManuais
        && unidades.some((u) => inteiro(u.estoque_minimo_manual) != null),
      urgencia: ignorado ? 'ignorado' : urgencia,
      coresZeradas,
      // A soma das cores vence a conta do anúncio inteiro: é ela que a
      // expedição vai separar, e as duas precisam ser o MESMO número na tela.
      precisaEnviar: totalAEnviar != null ? totalAEnviar : reposicao.precisaEnviar,
    },
    desempenho: {
      ...desempenho,
      primeiroRetrato,
    },
    envio,
    unidades: detalhes,
  };
}

// ---------------------------------------------------------------------------
// O PLANO DE PRODUÇÃO
// ---------------------------------------------------------------------------
// Função PURA: recebe os anúncios já montados e devolve a grade por
// referência. Mora aqui, e não na rota, porque é o trecho que mais errou —
// três defeitos numa revisão só — e aqui o teste o alcança sem banco:
// unidade contada uma vez por variação (e não por linha de grade), peças de
// cada referência no chip do anúncio certo, e a prateleira prometida uma vez.
//
// `referencia`/`descricao` saem NULAS para as peças que entraram pela
// composição de um kit sortido — elas são de outra referência, e quem
// completa o nome é quem tem banco à mão.
function montarPlano({ escolhidos, usarEstoqueCasa = true }) {
  const porProduto = new Map();
  const semVinculo = [];
  const semMedida = [];

  for (const a of escolhidos) {
    // As cores que TÊM referência. Desde que a varredura passou a resolver
    // o SKU por variação, um anúncio pode ter parte das cores vinculada e
    // parte não — e cada cor pode até apontar referências diferentes.
    // Uma variação serve ao plano quando sabe QUE PEÇA produzir: pela
    // referência dela, pela do anúncio, ou pela composição registrada (que
    // carrega as próprias referências, inclusive de outras peças do kit).
    const comReferencia = a.unidades.filter(
      (u) => (u.produtoId ?? a.produtoId) != null || (u.composicao || []).length > 0
    );

    // Anúncio sem NENHUMA referência não é descartado em silêncio.
    //
    // Ele não pode virar ordem de produção — sem saber qual peça é, não há
    // o que cortar. Mas ele TEM uma quantidade a enviar, e ela é a resposta
    // à pergunta que trouxe a pessoa até aqui. Descartá-lo fazia o plano
    // abrir com "A enviar 0 · Já na casa 0 · A produzir 0" e a mensagem
    // "Nada a produzir", que é falsa: há 998 unidades a mandar. Pior, mudar
    // o período não mexia em número nenhum, e a tela parecia quebrada.
    if (comReferencia.length === 0) {
      semVinculo.push({
        chave: a.chave,
        titulo: a.titulo,
        anuncioIdExterno: a.anuncioIdExterno,
        lojaNome: a.lojaNome,
        marketplace: a.marketplace,
        anuncioId: a.anuncioId,
        sku: a.unidades.map((u) => u.sku).filter(Boolean)[0] || null,
        aEnviar: a.reposicao.precisaEnviar,
        pecasPorUnidade: a.pecasPorUnidade,
        pecasAEnviar: a.reposicao.precisaEnviar != null
          ? a.reposicao.precisaEnviar * (a.pecasPorUnidade || 1)
          : null,
        dataLimiteEnvio: a.reposicao.dataLimiteEnvio,
        diasAlvo: a.reposicao.diasAlvo,
      });
      continue;
    }
    if (a.velocidade.porDia == null) semMedida.push(a);

    for (const u of a.unidades) {
      if (u.ignorarReposicao) continue;
      const unidadesAEnviar = u.precisaEnviarUnidade || 0;
      if (unidadesAEnviar <= 0) continue;

      // O QUE UMA UNIDADE VENDIDA LEVA PARA FORA DA EXPEDIÇÃO.
      //
      // Duas fontes, e a diferença entre elas é a diferença entre um plano
      // medido e um plano suposto:
      //
      //   1. a COMPOSIÇÃO registrada da variação (migration 0074) — é o
      //      caso do kit sortido, em que uma unidade são três camisas de
      //      cores diferentes. Cada linha vira uma linha de grade própria;
      //
      //   2. sem composição registrada, o padrão do SKU: N peças da PRÓPRIA
      //      cor e tamanho da variação. É o kit de uma cor só, e é uma
      //      suposição — que a tela declara como tal.
      //
      // Sem a primeira, o plano mandava cortar o triplo de uma cor e
      // nenhuma das outras duas.
      const composicao = (u.composicao || []).length > 0
        ? u.composicao.map((c) => ({
          produtoId: c.produtoId,
          cor: c.cor,
          tamanho: c.tamanho,
          varianteId: c.varianteId,
          estoqueCasa: c.estoqueCasa,
          estoqueCasaReservado: c.estoqueCasaReservado,
          estoqueCasaChave: c.varianteId != null ? `v${c.varianteId}` : `p${c.produtoId}`,
          estoqueCasaOrigem: c.varianteId != null ? 'variante' : null,
          quantidade: c.quantidade,
          origem: 'composicao',
        }))
        : [{
          produtoId: u.produtoId ?? a.produtoId,
          cor: u.cor || '',
          tamanho: u.tamanho || '',
          varianteId: u.varianteId ?? null,
          estoqueCasa: u.estoqueCasa,
          estoqueCasaReservado: u.estoqueCasaReservado,
          estoqueCasaChave: u.estoqueCasaChave || null,
          estoqueCasaOrigem: u.estoqueCasaOrigem || null,
          quantidade: u.pecasPorUnidade || 1,
          origem: (u.pecasPorUnidade || 1) > 1 ? 'sku' : 'direto',
        }];

      for (const c of composicao) {
        const produtoId = c.produtoId;
        if (produtoId == null) continue;
        const enviar = unidadesAEnviar * (c.quantidade || 0);
        if (enviar <= 0) continue;

        if (!porProduto.has(produtoId)) {
          porProduto.set(produtoId, {
            produtoId,
            referencia: null,
            descricao: null,
            temFoto: false,
            anuncios: [],
            linhas: new Map(),
            // As unidades do anúncio que alimentam ESTA referência, por
            // variação. Um kit sortido vira três linhas de grade, mas
            // continua sendo UM conjunto de kits — somar a unidade em cada
            // linha dizia "200 unidades de anúncio" onde havia 100.
            unidadesPorVariacao: new Map(),
          });
        }
        const alvo = porProduto.get(produtoId);
        // Referência e descrição vêm do anúncio quando ele é o dono delas;
        // para uma peça de outra referência dentro do kit, ficam nulas até
        // a consulta de nomes logo abaixo.
        if (produtoId === a.produtoId) {
          alvo.referencia = alvo.referencia ?? a.referencia;
          alvo.descricao = alvo.descricao ?? a.produtoDescricao;
          alvo.temFoto = alvo.temFoto || Boolean(a.produtoTemFoto);
        }
        alvo.unidadesPorVariacao.set(`${a.chave}|${u.id}`, unidadesAEnviar);

        let noAnuncio = alvo.anuncios.find((x) => x.chave === a.chave);
        if (!noAnuncio) {
          noAnuncio = {
            chave: a.chave,
            titulo: a.titulo,
            lojaNome: a.lojaNome,
            marketplace: a.marketplace,
            // Unidades do ANÚNCIO (kits), e peças DESTA referência — que
            // num kit sortido não é o total do anúncio. Repetir o total em
            // cada card fazia quem lesse três cards somar 900 peças onde
            // existem 300.
            aEnviar: a.reposicao.precisaEnviar,
            pecasAEnviar: 0,
            pecasPorUnidade: a.pecasPorUnidade,
            dataLimiteEnvio: a.reposicao.dataLimiteEnvio,
            dataPrecisaEstarLa: a.reposicao.dataPrecisaEstarLa,
            velocidadeDia: a.velocidade.porDia,
            baseVelocidade: a.velocidade.base,
            diasAlvo: a.reposicao.diasAlvo,
            rateio: a.unidades[0]?.participacaoOrigem || null,
          };
          alvo.anuncios.push(noAnuncio);
        }
        noAnuncio.pecasAEnviar += enviar;

        // A chave é NORMALIZADA: duas lojas cadastram a mesma cor de jeitos
        // diferentes ("Azul Marinho" e "AZUL MARINHO"), e agrupar pelo texto
        // cru criava duas linhas para a MESMA variante, cada uma descontando
        // o mesmo saldo do galpão.
        const chave = `${normalizar(c.cor)}|${normalizar(c.tamanho)}`;
        const linha = alvo.linhas.get(chave) || {
          cor: c.cor,
          tamanho: c.tamanho,
          varianteId: c.varianteId ?? null,
          estoqueCasaChave: c.estoqueCasaChave || null,
          estoqueCasaOrigem: c.estoqueCasaOrigem || null,
          aEnviar: 0,
          pecasPorUnidade: c.quantidade || 1,
          estoqueCasa: c.estoqueCasa,
          estoqueCasaReservado: c.estoqueCasaReservado,
          // Sem cor nem tamanho não dá para montar grade: a linha entra
          // marcada e a tela pede que alguém complete, em vez de a ordem
          // nascer com "cor em branco".
          gradeIncerta: !c.cor && !c.tamanho,
          origemComposicao: c.origem,
          origemRateio: u.participacaoOrigem,
        };
        linha.aEnviar += enviar;
        if (linha.varianteId == null && c.varianteId != null) linha.varianteId = c.varianteId;
        if (linha.estoqueCasaChave == null) linha.estoqueCasaChave = c.estoqueCasaChave || null;
        if (linha.estoqueCasa == null) linha.estoqueCasa = c.estoqueCasa;
        alvo.linhas.set(chave, linha);
      }
    }
  }

  // A prateleira é UMA só: a mesma variante pode alimentar duas lojas, e
  // cada peça dela só pode ser prometida uma vez. Este mapa é o que impede
  // que o saldo da casa seja descontado duas vezes e a ordem de produção
  // nasça curta.
  const casaJaPrometida = new Map();
  const produtos = [...porProduto.values()].map((p) => {
    const linhas = [...p.linhas.values()].map((l) => {
      const bruto = usarEstoqueCasa && l.estoqueCasa != null ? Math.max(0, Number(l.estoqueCasa)) : 0;
      // A chave vem da UNIDADE (v<variante> ou p<produto>). Montá-la aqui
      // com cor e tamanho fazia cada cor de um anúncio sem variante casada
      // receber o saldo INTEIRO da referência — 18 linhas prometendo as
      // mesmas 200 peças, e o "a produzir" caindo para zero.
      const chaveCasa = l.estoqueCasaChave
        || (l.varianteId != null ? `v${l.varianteId}` : `p${p.produtoId}`);
      const jaUsado = casaJaPrometida.get(chaveCasa) || 0;
      const disponivelCasa = Math.max(0, bruto - jaUsado);
      const daCasa = Math.min(l.aEnviar, disponivelCasa);
      casaJaPrometida.set(chaveCasa, jaUsado + daCasa);
      return {
        ...l,
        daCasa,
        aProduzir: Math.max(0, l.aEnviar - daCasa),
      };
    }).sort((a, b) => (a.cor || '').localeCompare(b.cor || '') || (a.tamanho || '').localeCompare(b.tamanho || ''));

    // Tudo em PEÇAS, menos `unidadesAEnviar`, que é o que a expedição
    // conta na caixa — e vem do mapa por VARIAÇÃO, não da soma das linhas:
    // um kit sortido vira três linhas de grade e continua sendo um só
    // conjunto de kits.
    const totais = linhas.reduce((acc, l) => ({
      aEnviar: acc.aEnviar + l.aEnviar,
      daCasa: acc.daCasa + l.daCasa,
      aProduzir: acc.aProduzir + l.aProduzir,
    }), { aEnviar: 0, daCasa: 0, aProduzir: 0 });
    totais.unidadesAEnviar = [...p.unidadesPorVariacao.values()].reduce((acc, v) => acc + v, 0);

    const datas = p.anuncios.map((a) => a.dataLimiteEnvio).filter(Boolean).sort();
    return {
      produtoId: p.produtoId,
      referencia: p.referencia,
      descricao: p.descricao,
      temFoto: p.temFoto,
      anuncios: p.anuncios,
      linhas,
      totais,
      ehKit: linhas.some((l) => (l.pecasPorUnidade || 1) > 1),
      dataLimiteEnvio: datas[0] || null,
      // A grade pronta para POST /api/producao/ordens. O formato é o que
      // aquela rota já espera — nenhuma rota nova, nenhuma permissão nova.
      gradeParaOrdem: linhas
        .filter((l) => l.aProduzir > 0 && !l.gradeIncerta)
        .map((l) => ({
          cor: l.cor,
          tamanho: l.tamanho,
          variante_id: l.varianteId,
          quantidade_planejada: l.aProduzir,
        })),
    };
  }).sort((a, b) => b.totais.aProduzir - a.totais.aProduzir);


  return { produtos, semVinculo, semMedida };
}

module.exports = {
  HOJE_SQL,
  montarAnuncio,
  montarPlano,
  normalizar,
  somaOuNulo,
  repartirEntreUnidades,
  PADRAO,
  DIAS_MINIMOS_NO_FULL,
  TETO_JANELA_GERAL_DIAS,
  inteiro,
  numero,
  dataIso,
  diasEntre,
  somarDias,
  arredondarParaMultiplo,
  carregarParametros,
  parametrosDaLoja,
  medirVelocidade,
  calcularReposicao,
  medirDesempenho,
  carregarItens,
  carregarVendas,
  carregarMixGrade,
  carregarSnapshots,
  carregarCurva,
  carregarEnvios,
  carregarEmTransitoRegistrado,
  carregarPontasDeEnvio,
  carregarComposicao,
  casarComposicao,
  SQL_CASAR_COMPOSICAO,
  casarVariantes,
  SQL_CASAR_VARIANTE,
  distribuirInteiros,
};
