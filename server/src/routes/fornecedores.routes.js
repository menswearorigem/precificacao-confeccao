// Cadastro de fornecedores + o que a operação sabe sobre cada um.
//
// A listagem devolve, junto do cadastro, o RESUMO das compras daquele
// fornecedor (quanto já foi comprado, quantas compras, ticket médio, última
// compra, forma de pagamento mais usada). Isso existe pra tela de
// Fornecedores parar de ser uma agenda de telefone e virar a resposta a
// "com quem eu gasto, quanto e como pago".
//
// Nada aqui recalcula preço, margem ou imposto (REGRA 1) — só lê e agrega o
// que já está gravado em `compras`.
//
// Precisão (REGRA 2):
//   · compra CANCELADA nunca entra em total, ticket médio ou "forma de
//     pagamento mais usada" — ela é contada à parte, pra ninguém achar que
//     sumiu;
//   · ticket médio é soma(total) ÷ quantidade, nunca a média de médias;
//   · fornecedor sem compra nenhuma volta com total 0 e `sem_compras: true`,
//     não com um número inventado.

const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const EDITABLE_FIELDS = [
  'tipo_pessoa',
  'nome',
  'nome_fantasia',
  'cpf_cnpj',
  'ie',
  'ie_isento',
  'telefone',
  'email',
  'cep',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'categoria_principal',
  'condicao_pagamento_padrao',
  'chave_pix',
  'dados_bancarios',
  'observacoes',
  'ativo',
];

// Os campos que a busca sabe varrer. A chave é o que a tela manda em
// `campo=`; o valor monta o pedaço de SQL.
//
// `t()` e `d()` são FUNÇÕES, não strings: `t` é o termo com %, `d` são só os
// dígitos (pra CPF/CNPJ e telefone acharem "12.345.678" digitando
// "12345678"). Cada uma só reserva o parâmetro no SQL na primeira vez que é
// chamada — se fossem valores prontos, buscar num campo que não usa dígitos
// (ex.: `campo=pix`) mandaria pro Postgres um parâmetro a mais do que a
// consulta usa, e a busca quebrava com "bind message supplies 2 parameters".
const CAMPOS_BUSCA = {
  nome: { rotulo: 'Nome / Razão social', sql: (t) => `f.nome ILIKE ${t()}` },
  fantasia: { rotulo: 'Nome fantasia', sql: (t) => `f.nome_fantasia ILIKE ${t()}` },
  documento: {
    rotulo: 'CPF / CNPJ',
    sql: (t, d) => `(f.cpf_cnpj ILIKE ${t()}${d ? ` OR regexp_replace(COALESCE(f.cpf_cnpj, ''), '[^0-9]', '', 'g') LIKE ${d()}` : ''})`,
  },
  telefone: {
    rotulo: 'Telefone / WhatsApp',
    sql: (t, d) => `(f.telefone ILIKE ${t()}${d ? ` OR regexp_replace(COALESCE(f.telefone, ''), '[^0-9]', '', 'g') LIKE ${d()}` : ''})`,
  },
  email: { rotulo: 'E-mail', sql: (t) => `f.email ILIKE ${t()}` },
  endereco: {
    rotulo: 'Endereço / cidade',
    sql: (t) => `(f.cidade ILIKE ${t()} OR f.bairro ILIKE ${t()} OR f.logradouro ILIKE ${t()} OR f.uf ILIKE ${t()} OR f.cep ILIKE ${t()})`,
  },
  ie: { rotulo: 'Inscrição estadual', sql: (t) => `f.ie ILIKE ${t()}` },
  pix: { rotulo: 'Chave PIX / dados bancários', sql: (t) => `(f.chave_pix ILIKE ${t()} OR f.dados_bancarios ILIKE ${t()})` },
  observacoes: { rotulo: 'Observações', sql: (t) => `f.observacoes ILIKE ${t()}` },
};

// Bloco compartilhado pela listagem e pela ficha: o resumo de compras por
// fornecedor. Fica numa constante só pra os dois lugares não divergirem com
// o tempo (era assim que "total do fornecedor" e "total da ficha" passavam a
// discordar em sistema antigo).
const CTE_RESUMO = `
  resumo AS (
    SELECT c.fornecedor_id,
           COUNT(*) FILTER (WHERE c.situacao <> 'cancelado')                       AS compras_qtd,
           COALESCE(SUM(c.total_liquido) FILTER (WHERE c.situacao <> 'cancelado'), 0) AS total_comprado,
           COALESCE(SUM(c.valor_frete)   FILTER (WHERE c.situacao <> 'cancelado'), 0) AS total_frete,
           COALESCE(SUM(c.desconto_valor) FILTER (WHERE c.situacao <> 'cancelado'), 0) AS total_desconto,
           MAX(c.data_compra) FILTER (WHERE c.situacao <> 'cancelado')             AS ultima_compra,
           MIN(c.data_compra) FILTER (WHERE c.situacao <> 'cancelado')             AS primeira_compra,
           COUNT(*) FILTER (WHERE c.situacao = 'pendente')                         AS compras_pendentes,
           COALESCE(SUM(c.total_liquido) FILTER (WHERE c.situacao = 'pendente'), 0) AS total_pendente,
           COUNT(*) FILTER (WHERE c.situacao = 'cancelado')                        AS compras_canceladas
      FROM compras c
     GROUP BY c.fornecedor_id
  ),
  forma AS (
    SELECT DISTINCT ON (fornecedor_id) fornecedor_id, forma_pagamento, qtd
      FROM (
        SELECT c.fornecedor_id, c.forma_pagamento, COUNT(*) AS qtd
          FROM compras c
         WHERE c.situacao <> 'cancelado'
           AND c.forma_pagamento IS NOT NULL AND c.forma_pagamento <> ''
         GROUP BY 1, 2
      ) t
     ORDER BY fornecedor_id, qtd DESC, forma_pagamento
  ),
  categoria AS (
    SELECT DISTINCT ON (fornecedor_id) fornecedor_id, categoria, qtd
      FROM (
        SELECT c.fornecedor_id, c.categoria, COUNT(*) AS qtd
          FROM compras c
         WHERE c.situacao <> 'cancelado'
         GROUP BY 1, 2
      ) t
     ORDER BY fornecedor_id, qtd DESC, categoria
  )
`;

// O driver do Postgres devolve coluna DATE como objeto Date. `String(date)`
// dá "Wed Aug 19 2026 ...", e cortar 10 caracteres disso não é uma data ISO —
// era o que fazia "dias sem comprar" sair sempre nulo (e, por consequência,
// o filtro de fornecedor parado não achar ninguém). Usa os componentes
// locais, nunca toISOString (que converte pra UTC e pode voltar um dia).
function isoData(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    const ano = valor.getFullYear();
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

// Monta o objeto que a tela consome, já com os derivados que ela usaria
// mesmo (ticket médio, dias desde a última compra) calculados num lugar só.
function montarFornecedor(r) {
  const comprasQtd = Number(r.compras_qtd || 0);
  const totalComprado = Number(r.total_comprado || 0);
  let diasSemComprar = null;
  const ultimaIso = isoData(r.ultima_compra);
  if (ultimaIso) {
    const ultima = new Date(`${ultimaIso}T00:00:00`);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    diasSemComprar = Math.max(0, Math.round((hoje.getTime() - ultima.getTime()) / 86400000));
  }
  return {
    ...r,
    compras_qtd: comprasQtd,
    total_comprado: totalComprado,
    total_frete: Number(r.total_frete || 0),
    total_desconto: Number(r.total_desconto || 0),
    compras_pendentes: Number(r.compras_pendentes || 0),
    total_pendente: Number(r.total_pendente || 0),
    compras_canceladas: Number(r.compras_canceladas || 0),
    // Sem compra nenhuma o ticket médio não é zero: ele não existe. `null`
    // faz a tela escrever "—" em vez de "R$ 0,00", que passaria a ideia
    // errada de fornecedor que vende de graça (REGRA 2).
    ticket_medio: comprasQtd > 0 ? totalComprado / comprasQtd : null,
    sem_compras: comprasQtd === 0,
    dias_sem_comprar: diasSemComprar,
  };
}

// ---------------------------------------------------------------------------
// GET /api/fornecedores/opcoes — o que existe de verdade para filtrar
// ---------------------------------------------------------------------------
// Precisa vir antes de "/:id" pra "opcoes" não ser lido como um id.
// Devolve só o que está cadastrado: um filtro de UF com 27 estados quando a
// empresa compra de 4 é ruído.
router.get('/opcoes', async (req, res, next) => {
  try {
    const [ufs, cidades, categorias, formas, condicoes] = await Promise.all([
      pool.query("SELECT DISTINCT uf FROM fornecedores WHERE uf IS NOT NULL AND uf <> '' ORDER BY uf"),
      pool.query("SELECT DISTINCT cidade FROM fornecedores WHERE cidade IS NOT NULL AND cidade <> '' ORDER BY cidade"),
      pool.query("SELECT DISTINCT categoria_principal AS valor FROM fornecedores WHERE categoria_principal IS NOT NULL AND categoria_principal <> '' ORDER BY 1"),
      pool.query("SELECT DISTINCT forma_pagamento AS valor FROM compras WHERE forma_pagamento IS NOT NULL AND forma_pagamento <> '' ORDER BY 1"),
      pool.query("SELECT DISTINCT condicao_pagamento_padrao AS valor FROM fornecedores WHERE condicao_pagamento_padrao IS NOT NULL AND condicao_pagamento_padrao <> '' ORDER BY 1"),
    ]);
    res.json({
      ufs: ufs.rows.map((r) => r.uf),
      cidades: cidades.rows.map((r) => r.cidade),
      categorias: categorias.rows.map((r) => r.valor),
      formasPagamento: formas.rows.map((r) => r.valor),
      condicoesPagamento: condicoes.rows.map((r) => r.valor),
      camposBusca: Object.entries(CAMPOS_BUSCA).map(([chave, c]) => ({ chave, rotulo: c.rotulo })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/fornecedores — listagem com busca ampla e filtros
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const {
      busca, campo, categoria, uf, cidade, tipo_pessoa: tipoPessoa, ativo,
      forma_pagamento: formaPagamento, condicao_pagamento: condicaoPagamento,
      com_compras: comCompras, gasto_min: gastoMin, gasto_max: gastoMax,
      sem_comprar_dias: semComprarDias,
    } = req.query;

    const conditions = [];
    const values = [];
    let i = 1;
    const p = (valor) => { values.push(valor); return `$${i++}`; };

    if (busca && busca.trim()) {
      // Reserva o parâmetro só quando ele é de fato usado na consulta.
      const preguicoso = (valor) => {
        let marcador = null;
        return () => {
          if (marcador === null) marcador = p(valor);
          return marcador;
        };
      };
      const termo = preguicoso(`%${busca.trim()}%`);
      const soDigitos = busca.replace(/\D/g, '');
      const digitos = soDigitos.length >= 3 ? preguicoso(`%${soDigitos}%`) : null;
      // `campo` restringe a busca a uma coluna; sem ele, varre todas — que é
      // o que a pessoa espera ao digitar num campo de busca só.
      const escolhidos = campo && CAMPOS_BUSCA[campo] ? [CAMPOS_BUSCA[campo]] : Object.values(CAMPOS_BUSCA);
      conditions.push(`(${escolhidos.map((c) => c.sql(termo, digitos)).join(' OR ')})`);
    }
    if (categoria) conditions.push(`f.categoria_principal = ${p(categoria)}`);
    if (uf) conditions.push(`f.uf = ${p(uf)}`);
    if (cidade) conditions.push(`f.cidade = ${p(cidade)}`);
    if (tipoPessoa) conditions.push(`f.tipo_pessoa = ${p(tipoPessoa)}`);
    if (ativo === 'sim') conditions.push('f.ativo = TRUE');
    if (ativo === 'nao') conditions.push('f.ativo = FALSE');
    if (condicaoPagamento) conditions.push(`f.condicao_pagamento_padrao = ${p(condicaoPagamento)}`);
    // Forma de pagamento MAIS USADA nas compras reais — não o campo do
    // cadastro. É a pergunta "quem eu costumo pagar em PIX".
    if (formaPagamento) conditions.push(`forma.forma_pagamento = ${p(formaPagamento)}`);
    if (comCompras === 'sim') conditions.push('COALESCE(resumo.compras_qtd, 0) > 0');
    if (comCompras === 'nao') conditions.push('COALESCE(resumo.compras_qtd, 0) = 0');
    if (gastoMin) conditions.push(`COALESCE(resumo.total_comprado, 0) >= ${p(Number(gastoMin))}`);
    if (gastoMax) conditions.push(`COALESCE(resumo.total_comprado, 0) <= ${p(Number(gastoMax))}`);
    if (semComprarDias) {
      conditions.push(`(resumo.ultima_compra IS NULL OR resumo.ultima_compra < CURRENT_DATE - ${p(Number(semComprarDias))}::int)`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `WITH ${CTE_RESUMO}
       SELECT f.*,
              COALESCE(resumo.compras_qtd, 0)        AS compras_qtd,
              COALESCE(resumo.total_comprado, 0)     AS total_comprado,
              COALESCE(resumo.total_frete, 0)        AS total_frete,
              COALESCE(resumo.total_desconto, 0)     AS total_desconto,
              resumo.ultima_compra,
              resumo.primeira_compra,
              COALESCE(resumo.compras_pendentes, 0)  AS compras_pendentes,
              COALESCE(resumo.total_pendente, 0)     AS total_pendente,
              COALESCE(resumo.compras_canceladas, 0) AS compras_canceladas,
              forma.forma_pagamento                  AS forma_pagamento_comum,
              forma.qtd                              AS forma_pagamento_comum_qtd,
              categoria.categoria                    AS categoria_mais_comprada
         FROM fornecedores f
         LEFT JOIN resumo    ON resumo.fornecedor_id = f.id
         LEFT JOIN forma     ON forma.fornecedor_id = f.id
         LEFT JOIN categoria ON categoria.fornecedor_id = f.id
         ${where}
        ORDER BY f.nome`,
      values
    );
    res.json(rows.map(montarFornecedor));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `WITH ${CTE_RESUMO}
       SELECT f.*,
              COALESCE(resumo.compras_qtd, 0)        AS compras_qtd,
              COALESCE(resumo.total_comprado, 0)     AS total_comprado,
              COALESCE(resumo.total_frete, 0)        AS total_frete,
              COALESCE(resumo.total_desconto, 0)     AS total_desconto,
              resumo.ultima_compra,
              resumo.primeira_compra,
              COALESCE(resumo.compras_pendentes, 0)  AS compras_pendentes,
              COALESCE(resumo.total_pendente, 0)     AS total_pendente,
              COALESCE(resumo.compras_canceladas, 0) AS compras_canceladas,
              forma.forma_pagamento                  AS forma_pagamento_comum,
              forma.qtd                              AS forma_pagamento_comum_qtd,
              categoria.categoria                    AS categoria_mais_comprada
         FROM fornecedores f
         LEFT JOIN resumo    ON resumo.fornecedor_id = f.id
         LEFT JOIN forma     ON forma.fornecedor_id = f.id
         LEFT JOIN categoria ON categoria.fornecedor_id = f.id
        WHERE f.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.json(montarFornecedor(rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/fornecedores/:id/historico — o relacionamento com esse fornecedor
// ---------------------------------------------------------------------------
// Alimenta a aba "Histórico" da ficha: as compras, a evolução mês a mês, o
// que mais se compra dele e como costuma ser pago.
router.get('/:id/historico', async (req, res, next) => {
  try {
    const [compras, porMes, porCategoria, porForma, itens] = await Promise.all([
      pool.query(
        `SELECT c.id, c.numero, c.data_compra, c.categoria, c.numero_documento,
                c.forma_pagamento, c.condicao_pagamento, c.situacao,
                c.total_bruto, c.total_liquido, c.desconto_valor, c.valor_frete,
                (SELECT COUNT(*) FROM compra_itens ci WHERE ci.compra_id = c.id) AS itens_qtd
           FROM compras c
          WHERE c.fornecedor_id = $1
          ORDER BY c.data_compra DESC, c.id DESC
          LIMIT 500`,
        [req.params.id]
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', c.data_compra), 'YYYY-MM') AS mes,
                COUNT(*) AS quantidade, SUM(c.total_liquido) AS total
           FROM compras c
          WHERE c.fornecedor_id = $1 AND c.situacao <> 'cancelado'
          GROUP BY 1 ORDER BY 1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT c.categoria, COUNT(*) AS quantidade, SUM(c.total_liquido) AS total
           FROM compras c
          WHERE c.fornecedor_id = $1 AND c.situacao <> 'cancelado'
          GROUP BY 1 ORDER BY 3 DESC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(c.forma_pagamento, ''), '(não informada)') AS forma,
                COUNT(*) AS quantidade, SUM(c.total_liquido) AS total
           FROM compras c
          WHERE c.fornecedor_id = $1 AND c.situacao <> 'cancelado'
          GROUP BY 1 ORDER BY 2 DESC`,
        [req.params.id]
      ),
      pool.query(
        `SELECT ci.descricao, COALESCE(NULLIF(ci.unidade, ''), '—') AS unidade,
                SUM(ci.quantidade) AS quantidade, SUM(ci.total) AS total,
                COUNT(DISTINCT ci.compra_id) AS compras
           FROM compra_itens ci
           JOIN compras c ON c.id = ci.compra_id
          WHERE c.fornecedor_id = $1 AND c.situacao <> 'cancelado'
          GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 50`,
        [req.params.id]
      ),
    ]);

    res.json({
      compras: compras.rows,
      porMes: porMes.rows,
      porCategoria: porCategoria.rows,
      porFormaPagamento: porForma.rows,
      itensMaisComprados: itens.rows,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    const fields = EDITABLE_FIELDS.filter((f) => body[f] !== undefined);
    const columns = fields.length ? fields : ['nome'];
    const values = fields.length ? fields.map((f) => body[f]) : [body.nome];
    const placeholders = columns.map((_, idx) => `$${idx + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO fornecedores (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field]);
        i += 1;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'nada para atualizar.' });
    updates.push('updated_at = now()');
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE fornecedores SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM fornecedores WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Existem compras vinculadas a este fornecedor.' });
    }
    next(err);
  }
});

module.exports = router;
