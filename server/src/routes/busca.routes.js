const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const LIMITE_POR_GRUPO = 5;

function podeVer(user, modulos) {
  if (user.role === 'admin') return true;
  return modulos.some((m) => user.modulos.includes(m));
}

// Busca global (Ctrl/Cmd+K, TAREFA 4.4). Cada grupo só é consultado se o
// usuário tiver acesso ao módulo correspondente — mesma regra de permissão
// das rotas de dados de cada módulo (ver app.js), aplicada aqui na mão
// porque esta rota agrega vários módulos numa chamada só.
router.get('/', async (req, res, next) => {
  try {
    const termo = String(req.query.q || '').trim();
    if (termo.length < 2) return res.json({ produtos: [], clientes: [], fornecedores: [], pedidos: [], pedidosMarketplace: [], ean: [] });
    const like = `%${termo}%`;
    const user = req.user;

    const consultas = [];

    if (podeVer(user, ['produto', 'analises'])) {
      consultas.push(
        pool.query(
          `SELECT id, referencia, codigo, descricao FROM produtos
           WHERE referencia ILIKE $1 OR codigo ILIKE $1 OR descricao ILIKE $1
           ORDER BY referencia LIMIT ${LIMITE_POR_GRUPO}`,
          [like]
        ).then((r) => ({ chave: 'produtos', rows: r.rows }))
      );
    }
    if (podeVer(user, ['vendas'])) {
      consultas.push(
        pool.query(
          `SELECT id, nome, cpf_cnpj FROM clientes WHERE nome ILIKE $1 OR cpf_cnpj ILIKE $1
           ORDER BY nome LIMIT ${LIMITE_POR_GRUPO}`,
          [like]
        ).then((r) => ({ chave: 'clientes', rows: r.rows }))
      );
      consultas.push(
        pool.query(
          `SELECT pv.id, pv.numero, c.nome AS cliente_nome, pv.total_liquido
           FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
           WHERE pv.origem_marketplace IS NULL AND (pv.numero::text ILIKE $1 OR c.nome ILIKE $1)
           ORDER BY pv.data_pedido DESC LIMIT ${LIMITE_POR_GRUPO}`,
          [like]
        ).then((r) => ({ chave: 'pedidos', rows: r.rows }))
      );
    }
    if (podeVer(user, ['marketplace'])) {
      consultas.push(
        pool.query(
          `SELECT pv.id, pv.numero, pv.origem_pedido_id, pv.canal_venda, pv.total_liquido
           FROM pedidos_venda pv
           WHERE pv.origem_marketplace IS NOT NULL AND (pv.numero::text ILIKE $1 OR pv.origem_pedido_id ILIKE $1)
           ORDER BY pv.data_pedido DESC LIMIT ${LIMITE_POR_GRUPO}`,
          [like]
        ).then((r) => ({ chave: 'pedidosMarketplace', rows: r.rows }))
      );
    }
    if (podeVer(user, ['compras'])) {
      consultas.push(
        pool.query(
          `SELECT id, nome, cpf_cnpj FROM fornecedores WHERE nome ILIKE $1 OR cpf_cnpj ILIKE $1
           ORDER BY nome LIMIT ${LIMITE_POR_GRUPO}`,
          [like]
        ).then((r) => ({ chave: 'fornecedores', rows: r.rows }))
      );
    }
    if (podeVer(user, ['estoque'])) {
      consultas.push(
        pool.query(
          `SELECT v.id, v.ean, v.cor, v.tamanho, p.id AS produto_id, p.referencia
           FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
           WHERE v.ean ILIKE $1
           ORDER BY v.ean LIMIT ${LIMITE_POR_GRUPO}`,
          [like]
        ).then((r) => ({ chave: 'ean', rows: r.rows }))
      );
    }

    const resultados = await Promise.all(consultas);
    const resposta = { produtos: [], clientes: [], fornecedores: [], pedidos: [], pedidosMarketplace: [], ean: [] };
    for (const { chave, rows } of resultados) resposta[chave] = rows;
    res.json(resposta);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
