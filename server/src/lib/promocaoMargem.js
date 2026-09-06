// Margem no preço promocional (aba Marketplace › Promoções, 06/09/2026).
//
// É o coração da prévia obrigatória: antes de colocar 40 anúncios numa
// promoção, a tela precisa dizer, item por item, quanto sobra em cada um.
//
// ⚠️ REGRA 1 — este arquivo NÃO calcula margem. Ele monta as MESMAS entradas
// que a Ficha de Precificação monta e chama `calcularProduto` de calc.js com
// o preço promocional entrando como `precoInformado`. A margem que sai daqui
// é, literalmente, a resposta do motor à pergunta "e se o preço fosse esse?".
// Nenhuma fórmula é reescrita, nenhum número é arredondado no caminho, e o
// motor não é tocado.
//
// ⚠️ REGRA 2 — quando não dá pra responder, a resposta é "não dá", nunca zero:
//   · anúncio sem produto vinculado          → { semVinculo: true }
//   · produto sem custo cadastrado           → { semCusto: true }
//   · preço promocional ausente              → { semPreco: true }
// Um "0%" nesses casos seria lido como "margem zero" e alguém tomaria decisão
// em cima disso.
const pool = require('../db/pool');
const { calcularProduto, calcularPrecificacao, pctImpostosEmpresa } = require('./calc');
const { getCalcContext } = require('./calcContext');

// Carrega, de uma vez só, tudo que o motor precisa pra um conjunto de
// produtos. Em lote de propósito: a prévia de 200 itens não pode virar 600
// consultas.
async function carregarBaseDeMargem(produtoIds) {
  const ids = [...new Set((produtoIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const ctx = await getCalcContext();
  if (ids.length === 0) return { ctx, porProduto: new Map() };

  const [{ rows: produtos }, { rows: materiais }, { rows: industriais }] = await Promise.all([
    pool.query(
      `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
              e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct,
              e.nome AS empresa_nome
         FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
        WHERE p.id = ANY($1)`,
      [ids]
    ),
    pool.query('SELECT * FROM materiais WHERE produto_id = ANY($1) ORDER BY ordem, id', [ids]),
    pool.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1) ORDER BY ordem, id', [ids]),
  ]);

  const porProduto = new Map();
  for (const produto of produtos) {
    porProduto.set(produto.id, {
      produto,
      materiais: materiais.filter((m) => m.produto_id === produto.id),
      industriais: industriais.filter((c) => c.produto_id === produto.id),
    });
  }
  return { ctx, porProduto };
}

// Responde a margem NUM preço. `preco` null/0 devolve semPreco.
function margemNoPreco(base, produtoId, preco) {
  if (produtoId == null) return { semVinculo: true };
  const entrada = base.porProduto.get(Number(produtoId));
  if (!entrada) return { semVinculo: true };

  const valor = Number(preco);
  if (!Number.isFinite(valor) || valor <= 0) return { semPreco: true };

  const calculo = calcularProduto({
    materiais: entrada.materiais,
    custosIndustriais: entrada.industriais,
    custoIndiretoPorPeca: base.ctx.custoIndiretoPorPeca,
    pctImpostos: pctImpostosEmpresa(entrada.produto),
    pctTaxas: base.ctx.pctTaxas,
    valorFixoTaxas: base.ctx.valorFixoTaxas,
    config: base.ctx.config,
    // O ponto do arquivo inteiro: o preço promocional entra como preço
    // informado, e o motor responde a margem nele.
    precoInformado: valor,
  });

  // Produto sem material nem custo industrial cadastrado: o motor devolve
  // subtotal 0 e, por consequência, lucro igual ao preço inteiro — o que
  // apareceria na tela como "margem de 100%". É custo faltando, não lucro.
  if (Number(calculo.custoTotal.subtotalProducao) <= 0) return { semCusto: true };

  const f = calculo.formacaoPreco;
  return {
    lucroRS: f.lucroRS,
    lucroPct: f.lucroPct,
    status: f.status,
    precoMinimo: f.precoMinimo,
    precoIdeal: f.precoIdeal,
    precoSugerido: f.precoSugerido,
    // O preço que a ficha do produto tem hoje — é a referência de "de quanto
    // pra quanto" que a prévia mostra ao lado do preço promocional.
    precoAtualCadastro: entrada.produto.preco_informado != null
      ? Number(entrada.produto.preco_informado) : null,
    subtotalProducao: calculo.custoTotal.subtotalProducao,
    custoTotalPeca: calculo.custoTotal.custoTotalPeca,
    // Prejuízo é o único caso em que a tela pinta vermelho forte. Margem
    // abaixo da mínima é laranja: continua sendo decisão da dona (foi o que
    // ela escolheu em 06/09/2026 — avisa, mas deixa aplicar).
    prejuizo: Number(f.lucroRS) < 0,
    abaixoDoMinimo: Number(valor) < Number(f.precoMinimo),
  };
}

// Caminho inverso: "qual preço promocional deixa esse produto com X de
// margem?". Serve pro modo de ação em massa "quero 12% em todos".
//
// Continua sendo o motor respondendo: `calcularPrecificacao` é a mesma função
// exportada por calc.js que a Ficha usa, chamada com `margemDesejada` — a
// fórmula do markup divisor não é reescrita aqui. O subtotal de produção vem
// do próprio `calcularProduto`, não de uma soma feita neste arquivo.
function precoParaMargemAlvo(base, produtoId, margemAlvo) {
  if (produtoId == null) return { semVinculo: true };
  const entrada = base.porProduto.get(Number(produtoId));
  if (!entrada) return { semVinculo: true };

  const margem = Number(margemAlvo);
  if (!Number.isFinite(margem)) return { semPreco: true };

  const completo = calcularProduto({
    materiais: entrada.materiais,
    custosIndustriais: entrada.industriais,
    custoIndiretoPorPeca: base.ctx.custoIndiretoPorPeca,
    pctImpostos: pctImpostosEmpresa(entrada.produto),
    pctTaxas: base.ctx.pctTaxas,
    valorFixoTaxas: base.ctx.valorFixoTaxas,
    config: base.ctx.config,
    precoInformado: null,
  });
  const subtotal = Number(completo.custoTotal.subtotalProducao);
  if (subtotal <= 0) return { semCusto: true };

  const alvo = calcularPrecificacao({
    subtotalProducao: subtotal,
    pctImpostos: pctImpostosEmpresa(entrada.produto),
    pctTaxas: base.ctx.pctTaxas,
    valorFixoTaxas: base.ctx.valorFixoTaxas,
    config: base.ctx.config,
    margemDesejada: margem,
  });
  // Margem impossível: o motor trava o divisor em 0,01 e devolve um preço
  // absurdo em vez de dividir por zero. Devolver esse número como "preço
  // sugerido" seria entregar lixo com cara de resposta.
  if (1 - alvo.pctImpostos - alvo.pctTaxas - margem <= 0.01) return { margemImpossivel: true };
  return { preco: alvo.precoSugerido };
}

// Rótulo curto pra quando não dá pra calcular. Fica aqui, e não na tela, pra
// os três lugares que mostram margem (prévia, listagem e exportação) dizerem
// exatamente a mesma coisa.
function motivoSemMargem(m) {
  if (!m) return null;
  if (m.semVinculo) return 'anúncio sem produto vinculado';
  if (m.semCusto) return 'produto sem custo cadastrado';
  if (m.semPreco) return 'sem preço promocional definido';
  return null;
}

module.exports = { carregarBaseDeMargem, margemNoPreco, precoParaMargemAlvo, motivoSemMargem };
