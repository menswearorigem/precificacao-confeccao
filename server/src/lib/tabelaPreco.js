// Tabelas de preço — aplicação do desconto comercial (09/09/2026).
//
// REGRA 1, dita em voz alta porque este arquivo fica perto da fronteira:
// NADA aqui é precificação. O preço de partida chega pronto de fora (é o
// preço sugerido que o motor de cálculo já devolve, ou o preço que a pessoa
// digitou no item). Esta função só aplica em cima dele o desconto comercial
// que a dona cadastrou na tabela — a mesma conta que hoje é feita de cabeça
// no balcão. Nenhuma margem, markup, imposto ou custo é lido, escrito ou
// recalculado aqui.
//
// Ordem de prioridade, do mais específico para o mais geral:
//   1. item da tabela com `preco_fixo`  → o preço é aquele, ponto final
//   2. item da tabela com desconto próprio (percentual ou R$)
//   3. desconto geral da tabela (percentual ou R$)
//   4. nenhuma tabela → o preço base passa intacto
//
// Item cadastrado com desconto ZERO é uma EXCEÇÃO deliberada ("esta
// referência não entra no desconto desta tabela") e por isso ganha do
// desconto geral. É o único jeito de tirar uma peça do desconto sem criar
// uma tabela só para ela.
//
// ── COMO CADA TIPO É DEVOLVIDO, e por quê ────────────────────────────────
//
// PERCENTUAL → volta em `descontoPct`, e o preço unitário fica intacto.
//   `calcularItem` (no router de pedidos) faz `bruto × pct`, então o
//   desconto acompanha a quantidade sozinho: 3 peças descontam 3 vezes.
//
// EM R$ → volta ABATIDO DO PREÇO UNITÁRIO, e NÃO no campo de desconto.
//   Esta é a correção de um defeito achado na revisão: `pedido_itens.
//   desconto_valor` é o desconto da LINHA INTEIRA (ver lib/pedidoRecalculo.js,
//   que soma o campo sem multiplicar por quantidade), enquanto o desconto da
//   tabela é POR PEÇA. Gravando R$ 20 de desconto por peça no campo da linha,
//   um pedido de 3 peças descontaria R$ 20 em vez de R$ 60 — e ainda mostraria
//   R$ 80 na busca contra R$ 93,33 no total, dois números diferentes para a
//   mesma peça na mesma tela. Abatendo no preço unitário, a conta escala
//   sozinha com a quantidade, sobrevive a uma troca de quantidade depois, e o
//   preço que aparece na linha é o preço realmente praticado.

/** Arredonda para centavos. Só na SAÍDA — as frações chegam inteiras até aqui (REGRA 2). */
function arredondarCentavos(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Aplica uma tabela de preço sobre um preço base.
 *
 * @param {object|null} tabela  linha de `tabelas_preco` (ou null)
 * @param {object|null} item    linha de `tabela_preco_itens` daquele produto (ou null)
 * @param {number} precoBase    preço de partida, já calculado fora daqui
 * @returns {{ valorUnitario:number, descontoPct:number, descontoValor:number,
 *             precoBase:number, descontoPorPeca:number, origem:string }}
 *          `valorUnitario` já é o preço a gravar no item; `descontoPct` é
 *          fração (0,15 = 15%); `descontoValor` é sempre 0 (ver acima);
 *          `descontoPorPeca` existe só para a tela poder mostrar "de/por".
 */
function aplicarTabelaPreco(tabela, item, precoBase) {
  const base = Number(precoBase) || 0;
  const vazio = {
    valorUnitario: arredondarCentavos(base),
    descontoPct: 0,
    descontoValor: 0,
    precoBase: arredondarCentavos(base),
    descontoPorPeca: 0,
    origem: 'preco_base',
  };
  if (!tabela || !tabela.ativo) return vazio;

  // 1. Preço travado para essa referência nessa tabela.
  if (item && item.tipo_desconto === 'preco_fixo' && item.preco_fixo !== null && item.preco_fixo !== undefined) {
    const fixo = arredondarCentavos(Number(item.preco_fixo));
    return {
      valorUnitario: fixo,
      descontoPct: 0,
      descontoValor: 0,
      precoBase: arredondarCentavos(base),
      descontoPorPeca: arredondarCentavos(Math.max(0, base - fixo)),
      origem: 'preco_fixo_item',
    };
  }

  // 2. Desconto específico da referência.
  if (item) {
    if (item.tipo_desconto === 'percentual') {
      const fracao = Math.min(1, Math.max(0, Number(item.desconto) || 0));
      return {
        ...vazio,
        descontoPct: fracao,
        descontoPorPeca: arredondarCentavos(base * fracao),
        origem: 'desconto_item_percentual',
      };
    }
    if (item.tipo_desconto === 'valor') {
      const abate = Math.min(Math.max(0, Number(item.desconto) || 0), base);
      return {
        ...vazio,
        valorUnitario: arredondarCentavos(base - abate),
        descontoPorPeca: arredondarCentavos(abate),
        origem: 'desconto_item_valor',
      };
    }
  }

  // 3. Desconto geral da tabela.
  const geral = Number(tabela.desconto_geral) || 0;
  if (geral <= 0) return { ...vazio, origem: 'tabela_sem_desconto' };
  if (tabela.tipo_desconto === 'valor') {
    const abate = Math.min(geral, base);
    return {
      ...vazio,
      valorUnitario: arredondarCentavos(base - abate),
      descontoPorPeca: arredondarCentavos(abate),
      origem: 'desconto_geral_valor',
    };
  }
  const fracao = Math.min(1, Math.max(0, geral));
  return {
    ...vazio,
    descontoPct: fracao,
    descontoPorPeca: arredondarCentavos(base * fracao),
    origem: 'desconto_geral_percentual',
  };
}

/** O preço por peça depois de tudo — o número que a tela mostra. */
function precoFinalPorPeca(aplicado) {
  const valor = aplicado.descontoPct > 0
    ? aplicado.valorUnitario * (1 - aplicado.descontoPct)
    : aplicado.valorUnitario - aplicado.descontoValor;
  return arredondarCentavos(Math.max(0, valor));
}

/**
 * Carrega a tabela e o item daquele produto de uma vez só.
 * Aceita um client de transação — a busca acontece dentro do mesmo BEGIN de
 * quem está lançando o item.
 */
async function carregarTabelaParaProduto(client, tabelaId, produtoId) {
  if (!tabelaId) return { tabela: null, item: null };
  const { rows: tabelas } = await client.query('SELECT * FROM tabelas_preco WHERE id = $1', [tabelaId]);
  const tabela = tabelas[0] || null;
  if (!tabela || !produtoId) return { tabela, item: null };
  const { rows: itens } = await client.query(
    'SELECT * FROM tabela_preco_itens WHERE tabela_id = $1 AND produto_id = $2',
    [tabelaId, produtoId]
  );
  return { tabela, item: itens[0] || null };
}

/**
 * Lê um número escrito como gente escreve — inclusive colado de planilha.
 *
 * Existe porque a importação em lote recebia "89,90" e `Number()` devolvia
 * NaN, que o `|| 0` transformava em ZERO: a tabela inteira era gravada com
 * preço travado de R$ 0,00 e a resposta dizia "aplicadas: N" como se tivesse
 * dado certo. Devolve `null` quando não dá para ler — quem chama decide se
 * recusa ou ignora, mas ninguém mais transforma erro de leitura em zero.
 */
function lerNumeroBr(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const texto = String(valor).replace(/[R$%\s ]/g, '');
  if (!texto) return null;
  // Com vírgula, ela é a decimal e o ponto é separador de milhar ("1.234,50").
  // Sem vírgula, o ponto é a decimal ("1234.50").
  const normalizado = texto.includes(',')
    ? texto.replace(/\./g, '').replace(',', '.')
    : texto;
  if (!/^-?\d*\.?\d+$/.test(normalizado)) return null;
  const numero = Number(normalizado);
  return Number.isFinite(numero) ? numero : null;
}

/** A tabela marcada como padrão, se houver — é com ela que o pedido novo nasce. */
async function tabelaPadrao() {
  // require aqui dentro, e não no topo: assim o resto do arquivo continua
  // sendo função pura, testável sem DATABASE_URL configurada.
  const pool = require('../db/pool');
  const { rows } = await pool.query('SELECT * FROM tabelas_preco WHERE padrao AND ativo LIMIT 1');
  return rows[0] || null;
}

module.exports = {
  aplicarTabelaPreco,
  tabelaPadrao,
  precoFinalPorPeca,
  carregarTabelaParaProduto,
  arredondarCentavos,
  lerNumeroBr,
};
