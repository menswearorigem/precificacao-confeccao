// Tabelas de preço (09/09/2026).
//
// Atacado, lojista, revenda e varejo pagam preços diferentes pela mesma
// peça. Cada tabela guarda um desconto GERAL e, quando é o caso, um
// desconto ESPECÍFICO por referência — ou um preço travado.
//
// REGRA 1: nenhuma rota aqui lê ou escreve custo, margem, markup ou preço
// sugerido. A tabela é desconto comercial aplicado SOBRE o preço que o
// motor já devolveu — ver o comentário em lib/tabelaPreco.js.
//
// PERMISSÃO: ler exige `vendas` ou `configuracoes` (o pedido precisa listar
// as tabelas); escrever exige `configuracoes`.

const express = require('express');
const pool = require('../db/pool');
const { requireModulo } = require('../middleware/auth');
const { registrar, diferenca } = require('../lib/auditoria');
const { aplicarTabelaPreco, precoFinalPorPeca, lerNumeroBr } = require('../lib/tabelaPreco');

const router = express.Router();
const soConfiguracoes = requireModulo('configuracoes');

// Id que não é número devolve 400, não 500. Sem isto, um `/api/tabelas-preco/
// undefined` vindo de um estado ainda não carregado da tela estourava o
// `22P02` do Postgres e virava "erro interno do servidor" no log.
router.param('id', (req, res, next, valor) => {
  if (!/^\d+$/.test(String(valor))) return res.status(400).json({ error: 'Tabela de preço inválida.' });
  next();
});
router.param('itemId', (req, res, next, valor) => {
  if (!/^\d+$/.test(String(valor))) return res.status(400).json({ error: 'Item inválido.' });
  next();
});

// Duas pessoas marcando "tabela padrão" ao mesmo tempo batem no índice único
// parcial do banco. Sem tratar, o segundo recebe "erro interno"; tratado, ele
// recebe a explicação e tenta de novo.
function ehConflitoDePadrao(err) {
  return err && err.code === '23505';
}

const TIPOS_TABELA = new Set(['percentual', 'valor']);
const TIPOS_ITEM = new Set(['percentual', 'valor', 'preco_fixo']);

// Percentual é FRAÇÃO e nunca passa de 1 (100%).
//
// Sem esse teto, dois acidentes reais aconteciam: `desconto_geral = 1.5`
// gerava 150% de desconto e um pedido com total NEGATIVO; e quem digitasse
// um valor em reais com o tipo em "percentual" (1500) estourava o
// NUMERIC(7,4) de `pedido_itens.desconto_pct` e derrubava o lançamento do
// item em 500. Cortar em 100% é o limite da própria coisa: não existe
// desconto maior que o preço.
function lerDesconto(valor, tipo) {
  const numero = lerNumeroBr(valor);
  if (numero === null) return null;
  if (numero < 0) return 0;
  return tipo === 'percentual' ? Math.min(1, numero) : numero;
}

async function fetchTabela(id, { comItens = true } = {}) {
  const { rows } = await pool.query('SELECT * FROM tabelas_preco WHERE id = $1', [id]);
  if (rows.length === 0) return null;
  const tabela = rows[0];
  if (!comItens) return tabela;
  const { rows: itens } = await pool.query(
    `SELECT tpi.*, p.referencia, p.descricao, p.marca
       FROM tabela_preco_itens tpi JOIN produtos p ON p.id = tpi.produto_id
      WHERE tpi.tabela_id = $1
      ORDER BY p.referencia`,
    [id]
  );
  return { ...tabela, itens };
}

// GET /api/tabelas-preco?incluir_inativas=1
router.get('/', async (req, res, next) => {
  try {
    const where = req.query.incluir_inativas === '1' ? '' : 'WHERE t.ativo = TRUE';
    const { rows } = await pool.query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM tabela_preco_itens tpi WHERE tpi.tabela_id = t.id) AS itens_especificos,
              (SELECT COUNT(*)::int FROM pedidos_venda pv WHERE pv.tabela_preco_id = t.id) AS pedidos_usando
         FROM tabelas_preco t
         ${where}
        ORDER BY t.padrao DESC, t.ativo DESC, t.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const tabela = await fetchTabela(req.params.id);
    if (!tabela) return res.status(404).json({ error: 'Tabela de preço não encontrada.' });
    res.json(tabela);
  } catch (err) {
    next(err);
  }
});

// Simulador da tela de configuração: mostra, para um punhado de referências,
// quanto a tabela deixa o preço. NÃO grava nada e NÃO recalcula preço — só
// aplica o desconto sobre o preço base que vem de fora.
router.get('/:id/simular', async (req, res, next) => {
  try {
    const tabela = await fetchTabela(req.params.id, { comItens: false });
    if (!tabela) return res.status(404).json({ error: 'Tabela de preço não encontrada.' });
    const precoBase = Number(req.query.preco_base) || 0;
    const produtoId = req.query.produto_id ? Number(req.query.produto_id) : null;
    let item = null;
    if (produtoId) {
      const { rows } = await pool.query(
        'SELECT * FROM tabela_preco_itens WHERE tabela_id = $1 AND produto_id = $2',
        [req.params.id, produtoId]
      );
      item = rows[0] || null;
    }
    const aplicado = aplicarTabelaPreco(tabela, item, precoBase);
    res.json({ ...aplicado, precoLiquido: precoFinalPorPeca(aplicado) });
  } catch (err) {
    next(err);
  }
});

router.post('/', soConfiguracoes, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const nome = String(body.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Dê um nome à tabela de preço (ex.: "Atacado", "Lojista").' });
    const tipo = TIPOS_TABELA.has(body.tipo_desconto) ? body.tipo_desconto : 'percentual';
    const desconto = lerDesconto(body.desconto_geral, tipo) ?? 0;
    const padrao = body.padrao === true;

    await client.query('BEGIN');
    const { rows: repetido } = await client.query('SELECT id FROM tabelas_preco WHERE lower(nome) = lower($1)', [nome]);
    if (repetido.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Já existe uma tabela chamada "${nome}".` });
    }
    // Só pode haver uma tabela padrão — o banco garante isso com índice
    // único parcial, então tira a marca da anterior antes de gravar.
    if (padrao) await client.query('UPDATE tabelas_preco SET padrao = FALSE WHERE padrao');
    const { rows } = await client.query(
      `INSERT INTO tabelas_preco (nome, descricao, tipo_desconto, desconto_geral, padrao, ativo, observacao)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING *`,
      [nome, body.descricao || null, tipo, desconto, padrao, body.observacao || null]
    );
    await client.query('COMMIT');
    await registrar(req, {
      acao: 'criou', entidade: 'tabela_preco', entidadeId: rows[0].id,
      descricao: `Criou a tabela de preço "${nome}"`, depois: rows[0],
    });
    res.status(201).json(await fetchTabela(rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (ehConflitoDePadrao(err)) {
      return res.status(409).json({ error: 'Outra pessoa acabou de marcar uma tabela como padrão. Recarregue a tela e tente de novo.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', soConfiguracoes, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const atual = await fetchTabela(req.params.id, { comItens: false });
    if (!atual) return res.status(404).json({ error: 'Tabela de preço não encontrada.' });
    const body = req.body || {};

    const updates = [];
    const valores = [];
    let i = 1;
    if (body.nome !== undefined) {
      const nome = String(body.nome || '').trim();
      if (!nome) return res.status(400).json({ error: 'O nome da tabela é obrigatório.' });
      const { rows: repetido } = await client.query(
        'SELECT id FROM tabelas_preco WHERE lower(nome) = lower($1) AND id <> $2', [nome, req.params.id]
      );
      if (repetido.length > 0) return res.status(409).json({ error: `Já existe outra tabela chamada "${nome}".` });
      updates.push(`nome = $${i}`); valores.push(nome); i += 1;
    }
    if (body.descricao !== undefined) { updates.push(`descricao = $${i}`); valores.push(body.descricao || null); i += 1; }
    if (body.observacao !== undefined) { updates.push(`observacao = $${i}`); valores.push(body.observacao || null); i += 1; }
    if (body.tipo_desconto !== undefined) {
      updates.push(`tipo_desconto = $${i}`);
      valores.push(TIPOS_TABELA.has(body.tipo_desconto) ? body.tipo_desconto : 'percentual');
      i += 1;
    }
    if (body.desconto_geral !== undefined) {
      // O tipo pode estar mudando na MESMA requisição — o teto de 100% tem de
      // valer sobre o tipo novo, não sobre o que estava gravado.
      const tipoValendo = TIPOS_TABELA.has(body.tipo_desconto) ? body.tipo_desconto : atual.tipo_desconto;
      updates.push(`desconto_geral = $${i}`); valores.push(lerDesconto(body.desconto_geral, tipoValendo) ?? 0); i += 1;
    }
    if (body.ativo !== undefined) { updates.push(`ativo = $${i}`); valores.push(body.ativo !== false); i += 1; }

    await client.query('BEGIN');
    if (body.padrao !== undefined) {
      if (body.padrao === true) {
        await client.query('UPDATE tabelas_preco SET padrao = FALSE WHERE padrao AND id <> $1', [req.params.id]);
      }
      updates.push(`padrao = $${i}`); valores.push(body.padrao === true); i += 1;
    }
    if (updates.length > 0) {
      valores.push(req.params.id);
      await client.query(`UPDATE tabelas_preco SET ${updates.join(', ')}, updated_at = now() WHERE id = $${i}`, valores);
    }
    await client.query('COMMIT');

    const depois = await fetchTabela(req.params.id, { comItens: false });
    await registrar(req, {
      acao: 'alterou', entidade: 'tabela_preco', entidadeId: Number(req.params.id),
      descricao: `Alterou a tabela de preço "${depois.nome}"`, ...diferenca(atual, depois),
    });
    res.json(await fetchTabela(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (ehConflitoDePadrao(err)) {
      return res.status(409).json({ error: 'Outra pessoa acabou de marcar uma tabela como padrão. Recarregue a tela e tente de novo.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', soConfiguracoes, async (req, res, next) => {
  try {
    const atual = await fetchTabela(req.params.id, { comItens: false });
    if (!atual) return res.status(404).json({ error: 'Tabela de preço não encontrada.' });
    const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM pedidos_venda WHERE tabela_preco_id = $1', [req.params.id]);
    if (rows[0].total > 0) {
      return res.status(409).json({
        error: `Essa tabela já foi usada em ${rows[0].total} pedido(s). Em vez de excluir, desative-a — `
          + 'assim os pedidos antigos continuam mostrando com qual tabela foram vendidos.',
      });
    }
    await pool.query('DELETE FROM tabelas_preco WHERE id = $1', [req.params.id]);
    await registrar(req, {
      acao: 'excluiu', entidade: 'tabela_preco', entidadeId: Number(req.params.id),
      descricao: `Excluiu a tabela de preço "${atual.nome}"`, antes: atual,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- itens (desconto específico por referência) ----------

// Busca de referências para acrescentar desconto específico. Vive aqui, e
// não em /api/pedidos/buscar-produtos, porque esta tela é de Configurações:
// quem só tem `configuracoes` não tem o módulo Vendas e receberia 403 lá.
// Devolve só identificação — nenhum preço, custo ou margem (REGRA 1).
router.get('/:id/produtos', async (req, res, next) => {
  try {
    const busca = String(req.query.busca || '').trim();
    if (!busca) return res.json([]);
    const { rows } = await pool.query(
      `SELECT p.id, p.referencia, p.descricao, p.marca,
              EXISTS (SELECT 1 FROM tabela_preco_itens t WHERE t.tabela_id = $2 AND t.produto_id = p.id) AS ja_na_tabela
         FROM produtos p
        WHERE p.referencia ILIKE $1 OR p.descricao ILIKE $1
        ORDER BY p.referencia
        LIMIT 40`,
      [`%${busca}%`, req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/itens', soConfiguracoes, async (req, res, next) => {
  try {
    const tabela = await fetchTabela(req.params.id, { comItens: false });
    if (!tabela) return res.status(404).json({ error: 'Tabela de preço não encontrada.' });
    const body = req.body || {};
    const produtoId = Number(body.produto_id);
    if (!produtoId) return res.status(400).json({ error: 'Escolha a referência que vai receber o desconto específico.' });
    const tipo = TIPOS_ITEM.has(body.tipo_desconto) ? body.tipo_desconto : 'percentual';
    const desconto = tipo === 'preco_fixo' ? 0 : lerDesconto(body.desconto, tipo) ?? 0;
    const precoFixo = tipo === 'preco_fixo' ? lerNumeroBr(body.preco_fixo) : null;
    if (tipo === 'preco_fixo' && (precoFixo === null || precoFixo <= 0)) {
      return res.status(400).json({ error: 'Informe o preço travado para essa referência.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO tabela_preco_itens (tabela_id, produto_id, tipo_desconto, desconto, preco_fixo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tabela_id, produto_id)
       DO UPDATE SET tipo_desconto = EXCLUDED.tipo_desconto, desconto = EXCLUDED.desconto,
                     preco_fixo = EXCLUDED.preco_fixo, updated_at = now()
       RETURNING *`,
      [req.params.id, produtoId, tipo, desconto, precoFixo]
    );
    await registrar(req, {
      acao: 'alterou', entidade: 'tabela_preco', entidadeId: Number(req.params.id),
      descricao: `Definiu desconto específico na tabela "${tabela.nome}"`, depois: rows[0],
    });
    res.status(201).json(await fetchTabela(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Colar uma lista inteira de uma vez (referência;desconto por linha) — é
// como as tabelas chegam hoje, numa planilha.
router.post('/:id/itens/em-lote', soConfiguracoes, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const tabela = await fetchTabela(req.params.id, { comItens: false });
    if (!tabela) return res.status(404).json({ error: 'Tabela de preço não encontrada.' });
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    const tipoPadrao = TIPOS_ITEM.has(req.body?.tipo_desconto) ? req.body.tipo_desconto : 'percentual';
    if (linhas.length === 0) return res.status(400).json({ error: 'Nenhuma linha para importar.' });

    const referencias = linhas.map((l) => String(l.referencia || '').trim()).filter(Boolean);
    // Casamento por referência exata, ignorando só maiúsculas e espaços das
    // pontas — nunca por nome parecido (REGRA 2). A comparação em minúsculas
    // acontece NO BANCO; antes ela era feita só no mapa em memória, o que
    // fazia "cam-01" não achar "CAM-01" e cair como "não encontrada".
    const { rows: produtos } = await client.query(
      'SELECT id, referencia FROM produtos WHERE lower(btrim(referencia)) = ANY($1)',
      [referencias.map((r) => r.toLowerCase())]
    );
    const mapa = new Map();
    const ambiguas = new Set();
    for (const p of produtos) {
      const chave = String(p.referencia).trim().toLowerCase();
      // Duas referências que só diferem na caixa não podem ser colapsadas: o
      // desconto iria para a errada, em silêncio.
      if (mapa.has(chave)) { ambiguas.add(String(p.referencia).trim()); continue; }
      mapa.set(chave, p.id);
    }

    const aplicadas = [];
    const naoEncontradas = [];
    const valorIlegivel = [];
    await client.query('BEGIN');
    for (const linha of linhas) {
      const ref = String(linha.referencia || '').trim();
      const produtoId = mapa.get(ref.toLowerCase());
      if (!produtoId || ambiguas.has(ref)) { naoEncontradas.push(ref); continue; }
      const tipo = TIPOS_ITEM.has(linha.tipo_desconto) ? linha.tipo_desconto : tipoPadrao;
      // Valor que não dá para ler NÃO vira zero: a linha é recusada e volta
      // relatada. Zerar em silêncio gravava a tabela inteira com preço
      // R$ 0,00 e respondia "importado com sucesso".
      const bruto = tipo === 'preco_fixo' ? (linha.preco_fixo ?? linha.desconto) : linha.desconto;
      const numero = tipo === 'preco_fixo' ? lerNumeroBr(bruto) : lerDesconto(bruto, tipo);
      if (numero === null || (tipo === 'preco_fixo' && numero <= 0)) { valorIlegivel.push(ref); continue; }
      const desconto = tipo === 'preco_fixo' ? 0 : numero;
      const precoFixo = tipo === 'preco_fixo' ? numero : null;
      await client.query(
        `INSERT INTO tabela_preco_itens (tabela_id, produto_id, tipo_desconto, desconto, preco_fixo)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tabela_id, produto_id)
         DO UPDATE SET tipo_desconto = EXCLUDED.tipo_desconto, desconto = EXCLUDED.desconto,
                       preco_fixo = EXCLUDED.preco_fixo, updated_at = now()`,
        [req.params.id, produtoId, tipo, desconto, precoFixo]
      );
      aplicadas.push(ref);
    }
    await client.query('COMMIT');
    await registrar(req, {
      acao: 'alterou', entidade: 'tabela_preco', entidadeId: Number(req.params.id),
      descricao: `Importou ${aplicadas.length} desconto(s) específico(s) na tabela "${tabela.nome}"`,
    });
    res.json({
      aplicadas: aplicadas.length,
      naoEncontradas,
      valorIlegivel,
      ambiguas: [...ambiguas],
      tabela: await fetchTabela(req.params.id),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/itens/:itemId', soConfiguracoes, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM tabela_preco_itens WHERE id = $1 AND tabela_id = $2',
      [req.params.itemId, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Item não encontrado nessa tabela.' });
    res.json(await fetchTabela(req.params.id));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
