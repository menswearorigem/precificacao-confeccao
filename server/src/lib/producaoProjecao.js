// Projeção de estoque: o que a produção acrescenta, por cor e tamanho.
//
// 10/09/2026. Nasceu de um relatório em PDF que o dono pediu em três camadas —
// produção agrupada, produção somada ao estoque real, e o estoque que sobra
// quando tudo chegar — e que ela quis ver aplicado a todas as referências.
//
// ---------------------------------------------------------------------------
// Por que este arquivo existe, e não uma segunda consulta na tela nova
// ---------------------------------------------------------------------------
// A Cobertura já calculava isto, em `estoqueMinimo.routes.js`:
//
//     SUM(GREATEST(quantidade_planejada - quantidade_produzida, 0))
//       FROM ordens_producao
//      WHERE situacao IN ('planejada','em_producao')
//      GROUP BY produto_id
//
// e chamava o resultado de `naFaccao`, somando-o ao saldo para formar a
// POSIÇÃO de estoque. A tela nova precisa exatamente do mesmo número, aberto
// por variante. Se ela fizesse a própria consulta, o sistema teria duas
// definições de "em produção" — e a varredura de 09/09 já mostrou aonde isso
// vai: cobertura calculada em dois lugares, 60 dias num, 168 no outro, mesma
// referência. Uma conta, um arquivo, dois consumidores.
//
// ---------------------------------------------------------------------------
// As três correções que a versão por variante traz
// ---------------------------------------------------------------------------
//
// 1. POR VARIANTE, NÃO POR PRODUTO. A consulta antiga agrupa por `produto_id`.
//    É o defeito que a própria repaginação da Cobertura deixou registrado como
//    pendência: o P esgotado e o GG encalhado se cancelam dentro do número da
//    referência. Aqui a unidade é (produto, cor, tamanho), que é a unidade em
//    que a peça é vendida e produzida.
//
// 2. SEGUNDA QUALIDADE SAI DO PENDENTE. A peça que voltou com defeito não vai
//    voltar a ser produzida e não entra no estoque de primeira. Pendente é
//    `planejada - produzida - segunda`, e não só `planejada - produzida`, que
//    manteria a peça defeituosa eternamente "a caminho".
//
// 3. LD NÃO É COR. O saldo do Wik traz "leves defeitos" como se fosse uma cor.
//    `produto_cores.eh_qualidade` (migration 0066) marca essas linhas; elas
//    continuam no saldo, mas não contam como primeira qualidade na posição.
//
// ---------------------------------------------------------------------------
// A contagem dupla, e por que ela não se resolve sozinha
// ---------------------------------------------------------------------------
// O apontamento de produção do Hub ainda não é usado: a casa lança a produção
// no Wik e o Hub importa o SALDO do Wik. Então `quantidade_produzida` fica
// zero mesmo quando metade da ordem já voltou da facção.
//
// O efeito é concreto: a facção entrega 300 das 720, a fábrica lança no Wik, o
// saldo importado sobe 300 — e a ordem continua declarando 720 pendentes. As
// 300 peças passam a existir nos dois lados da soma.
//
// Este arquivo NÃO corrige isso sozinho, e de propósito. Uma baixa automática
// teria de adivinhar que a subida do saldo veio da produção e não de uma
// devolução, de uma transferência ou de um ajuste — e erraria calada. O que
// ele faz é MEDIR a suspeita (`entregaParcialSuspeita`) para a tela poder
// sugerir a baixa a quem sabe. Sugere; quem decide é gente.

const pool = require('../db/pool');

// As situações em que uma ordem ainda tem peça para entregar. 'rascunho' fica
// de fora: grade aberta que ninguém fechou não é promessa de entrega.
// 'concluida' e 'cancelada' também - uma já entrou no estoque, a outra não vai
// acontecer.
const SITUACOES_VIVAS = ['planejada', 'em_producao'];

// Ordem canônica de tamanho da casa. A mesma de `estoque.routes.js`: em ordem
// alfabética o GG vem antes do M e a grade fica ilegível.
const ORDEM_TAMANHOS = [
  'PP', 'P', 'M', 'G', 'GG', 'XG', 'EG', 'XGG', 'EGG', 'G1', 'G2', 'G3',
];

function pesoTamanho(t) {
  const i = ORDEM_TAMANHOS.indexOf(String(t || '').toUpperCase().trim());
  if (i >= 0) return i;
  const n = Number(String(t || '').replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? 100 + n : 999;
}

function chave(produtoId, cor, tamanho) {
  return `${produtoId} ${cor || ''} ${tamanho || ''}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Em produção, por variante
// ---------------------------------------------------------------------------
// `GREATEST(..., 0)` porque apontar mais do que a grade previa é legítimo -
// sobra de enfesto acontece - e não pode virar produção negativa puxando o
// projetado para baixo.
async function emProducaoPorVariante({ produtoIds = null, client = pool } = {}) {
  const params = [SITUACOES_VIVAS];
  let filtro = '';
  if (Array.isArray(produtoIds) && produtoIds.length > 0) {
    params.push(produtoIds);
    filtro = ` AND op.produto_id = ANY($${params.length}::int[])`;
  }
  const { rows } = await client.query(
    `SELECT op.produto_id,
            g.cor,
            g.tamanho,
            SUM(GREATEST(g.quantidade_planejada - g.quantidade_produzida - g.quantidade_segunda, 0))::numeric AS pendente,
            SUM(g.quantidade_produzida)::numeric AS produzida,
            SUM(g.quantidade_segunda)::numeric   AS segunda,
            COUNT(DISTINCT op.id)::int           AS ordens
       FROM ordens_producao op
       JOIN ordem_producao_grade g ON g.ordem_id = op.id
      WHERE op.situacao = ANY($1::text[])${filtro}
      GROUP BY op.produto_id, g.cor, g.tamanho`,
    params
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(chave(r.produto_id, r.cor, r.tamanho), {
      produtoId: r.produto_id,
      cor: r.cor || '',
      tamanho: r.tamanho || '',
      pendente: num(r.pendente),
      produzida: num(r.produzida),
      segunda: num(r.segunda),
      ordens: num(r.ordens),
    });
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// O mesmo número, somado por produto - para a Cobertura
// ---------------------------------------------------------------------------
// Substitui a `emProducaoPorProduto()` que vivia dentro de
// `estoqueMinimo.routes.js`. A diferença de resultado não é arredondamento: a
// versão antiga somava `planejada - produzida` no CABEÇALHO da ordem, esta
// soma a grade e desconta a segunda qualidade. Onde houver segunda lançada, a
// posição de estoque da Cobertura vai baixar - e estava alta.
async function emProducaoPorProduto({ produtoIds = null, client = pool } = {}) {
  const porVariante = await emProducaoPorVariante({ produtoIds, client });
  const mapa = new Map();
  for (const v of porVariante.values()) {
    mapa.set(v.produtoId, (mapa.get(v.produtoId) || 0) + v.pendente);
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// As ordens vivas que compõem cada referência
// ---------------------------------------------------------------------------
// Vira o rodapé de chips da Camada 1 - número, data prevista e quantidade.
// `data_prevista` NULA é devolvida como nula e a tela escreve "sem data": sem
// ela não há janela para projetar venda, e inventar uma seria repetir o
// `01/01/1900` do Wik com outro nome.
async function ordensVivas({ produtoIds = null, client = pool } = {}) {
  const params = [SITUACOES_VIVAS];
  let filtro = '';
  if (Array.isArray(produtoIds) && produtoIds.length > 0) {
    params.push(produtoIds);
    filtro = ` AND op.produto_id = ANY($${params.length}::int[])`;
  }
  const { rows } = await client.query(
    `SELECT op.id, op.numero, op.produto_id, op.situacao,
            op.data_abertura, op.data_prevista,
            op.quantidade_planejada, op.quantidade_produzida, op.quantidade_segunda,
            f.nome AS faccao,
            COALESCE(SUM(GREATEST(g.quantidade_planejada - g.quantidade_produzida - g.quantidade_segunda, 0)), 0)::numeric AS pendente
       FROM ordens_producao op
       LEFT JOIN ordem_producao_grade g ON g.ordem_id = op.id
       LEFT JOIN fornecedores f ON f.id = op.fornecedor_id
      WHERE op.situacao = ANY($1::text[])${filtro}
      GROUP BY op.id, f.nome
      ORDER BY op.data_prevista NULLS LAST, op.numero`,
    params
  );
  const porProduto = new Map();
  for (const r of rows) {
    const lista = porProduto.get(r.produto_id) || [];
    lista.push({
      id: r.id,
      numero: r.numero,
      situacao: r.situacao,
      dataAbertura: r.data_abertura,
      dataPrevista: r.data_prevista,
      faccao: r.faccao || null,
      planejada: num(r.quantidade_planejada),
      produzida: num(r.quantidade_produzida),
      segunda: num(r.quantidade_segunda),
      pendente: num(r.pendente),
      semData: r.data_prevista == null,
    });
    porProduto.set(r.produto_id, lista);
  }
  return porProduto;
}

// ---------------------------------------------------------------------------
// Ordens encerradas com saldo pendente - a faixa de exceção
// ---------------------------------------------------------------------------
// Decisão do dono em 10/09/2026: aparecem como exceção visível em vez de
// serem tratadas como entregues integralmente. Ordem concluída deveria ter
// dado entrada de tudo; se sobrou pendente na grade, ou a entrada foi parcial
// ou a grade não foi fechada. Somar em silêncio esconderia as duas coisas.
async function ordensEncerradasComPendencia({ produtoIds = null, client = pool } = {}) {
  const params = [];
  let filtro = '';
  if (Array.isArray(produtoIds) && produtoIds.length > 0) {
    params.push(produtoIds);
    filtro = ` AND op.produto_id = ANY($${params.length}::int[])`;
  }
  const { rows } = await client.query(
    `SELECT op.id, op.numero, op.produto_id, op.data_conclusao,
            SUM(GREATEST(g.quantidade_planejada - g.quantidade_produzida - g.quantidade_segunda, 0))::numeric AS pendente
       FROM ordens_producao op
       JOIN ordem_producao_grade g ON g.ordem_id = op.id
      WHERE op.situacao = 'concluida'${filtro}
      GROUP BY op.id
     HAVING SUM(GREATEST(g.quantidade_planejada - g.quantidade_produzida - g.quantidade_segunda, 0)) > 0
      ORDER BY op.data_conclusao DESC NULLS LAST
      LIMIT 200`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    numero: r.numero,
    produtoId: r.produto_id,
    dataConclusao: r.data_conclusao,
    pendente: num(r.pendente),
  }));
}

// ---------------------------------------------------------------------------
// Saldo por variante, já sabendo o que é cor e o que é qualidade
// ---------------------------------------------------------------------------
async function saldoPorVariante({ produtoIds = null, client = pool } = {}) {
  const params = [];
  let filtro = '';
  if (Array.isArray(produtoIds) && produtoIds.length > 0) {
    params.push(produtoIds);
    filtro = ` WHERE v.produto_id = ANY($${params.length}::int[])`;
  }
  const { rows } = await client.query(
    `SELECT v.produto_id, v.cor, v.tamanho, v.quantidade,
            pc.hex                           AS hex,
            COALESCE(pc.eh_qualidade, FALSE) AS eh_qualidade
       FROM estoque_variantes v
       LEFT JOIN produto_cores pc
              ON pc.produto_id = v.produto_id AND pc.cor = v.cor
       ${filtro}`,
    params
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(chave(r.produto_id, r.cor, r.tamanho), {
      produtoId: r.produto_id,
      cor: r.cor || '',
      tamanho: r.tamanho || '',
      saldo: num(r.quantidade),
      hex: r.hex || null,
      ehQualidade: r.eh_qualidade === true,
    });
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// O cadastro de cor da referencia
// ---------------------------------------------------------------------------
// Vem de `produto_cores` e nao da variante de estoque, e a diferenca importa:
// cor que esta sendo produzida PELA PRIMEIRA VEZ ainda nao tem variante com
// saldo. Lendo o hex so' pelo saldo, essa cor apareceria com o quadrado neutro
// de "sem cor cadastrada" justamente na tela que existe para mostrar o que
// esta chegando -- cadastrada ela estava; era a leitura que olhava no lugar
// errado.
async function coresPorProduto({ produtoIds = null, client = pool } = {}) {
  const params = [];
  let filtro = '';
  if (Array.isArray(produtoIds) && produtoIds.length > 0) {
    params.push(produtoIds);
    filtro = ` WHERE produto_id = ANY($${params.length}::int[])`;
  }
  const { rows } = await client.query(
    `SELECT produto_id, cor, hex, eh_qualidade FROM produto_cores${filtro}`,
    params
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(`${r.produto_id} ${r.cor || ''}`, {
      hex: r.hex || null,
      ehQualidade: r.eh_qualidade === true,
    });
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Suspeita de entrega parcial
// ---------------------------------------------------------------------------
// Enquanto o apontamento não for feito no Hub, esta é a única pista de que uma
// ordem já entregou parte. Mede as ENTRADAS de estoque da variante desde a
// abertura da ordem, excluindo as que o próprio Hub gerou ao concluir uma OP
// (essas já baixaram a grade). Sobrando entrada, ou veio do Wik - e aí é
// provavelmente produção - ou foi ajuste manual.
//
// É deliberadamente uma SUSPEITA, não uma baixa. Devolução de cliente e
// transferência entre depósitos também são entradas, e uma baixa automática
// comeria a produção pendente sem ninguém ver.
async function entregaParcialSuspeita({ produtoIds = null, client = pool } = {}) {
  const params = [SITUACOES_VIVAS];
  let filtro = '';
  if (Array.isArray(produtoIds) && produtoIds.length > 0) {
    params.push(produtoIds);
    filtro = ` AND op.produto_id = ANY($${params.length}::int[])`;
  }
  const { rows } = await client.query(
    `WITH vivas AS (
        SELECT op.id, op.numero, op.produto_id, op.data_abertura,
               g.cor, g.tamanho,
               GREATEST(g.quantidade_planejada - g.quantidade_produzida - g.quantidade_segunda, 0) AS pendente
          FROM ordens_producao op
          JOIN ordem_producao_grade g ON g.ordem_id = op.id
         WHERE op.situacao = ANY($1::text[])${filtro}
     )
     SELECT v.id, v.numero, v.produto_id, v.cor, v.tamanho, v.pendente,
            COALESCE(SUM(GREATEST(m.quantidade, 0)), 0)::numeric AS entradas
       FROM vivas v
       JOIN estoque_variantes ev
         ON ev.produto_id = v.produto_id AND ev.cor = v.cor AND ev.tamanho = v.tamanho
       LEFT JOIN estoque_movimentos m
         ON m.variante_id = ev.id
        AND m.tipo IN ('entrada', 'importacao')
        AND m.criado_em >= v.data_abertura
        AND COALESCE(m.motivo, '') NOT LIKE 'Produção %'
      WHERE v.pendente > 0
      GROUP BY v.id, v.numero, v.produto_id, v.cor, v.tamanho, v.pendente
     HAVING COALESCE(SUM(GREATEST(m.quantidade, 0)), 0) > 0`,
    params
  );
  const porOrdem = new Map();
  for (const r of rows) {
    const atual = porOrdem.get(r.id) || {
      ordemId: r.id, numero: r.numero, produtoId: r.produto_id, linhas: [], total: 0,
    };
    // A suspeita nunca passa do que a ordem ainda deve: entrada maior que o
    // pendente com certeza tem outra origem além da produção.
    const sugerido = Math.min(num(r.entradas), num(r.pendente));
    atual.linhas.push({
      cor: r.cor || '', tamanho: r.tamanho || '',
      entradas: num(r.entradas), pendente: num(r.pendente), sugerido,
    });
    atual.total += sugerido;
    porOrdem.set(r.id, atual);
  }
  return porOrdem;
}

module.exports = {
  SITUACOES_VIVAS,
  ORDEM_TAMANHOS,
  pesoTamanho,
  chave,
  emProducaoPorVariante,
  emProducaoPorProduto,
  ordensVivas,
  ordensEncerradasComPendencia,
  saldoPorVariante,
  coresPorProduto,
  entregaParcialSuspeita,
};
