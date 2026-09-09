// Cadastro de vendedores (09/09/2026).
//
// Antes disto, "vendedor" era um texto solto no cabeçalho do pedido. Este
// router transforma a coisa em cadastro: quem é, se tem login no sistema,
// como a comissão dele é calculada e qual é a meta do mês.
//
// PERMISSÃO: ler exige o módulo `vendas` OU `configuracoes` (o pedido de
// venda precisa listar vendedores para o seletor). Escrever exige
// `configuracoes` — quem lança venda não define a própria comissão. Isso é
// aplicado aqui dentro, rota a rota, e não muda nenhuma regra de permissão
// existente (REGRA 4): nenhuma chave de módulo nova foi criada.

const express = require('express');
const pool = require('../db/pool');
const { requireModulo } = require('../middleware/auth');
const { registrar, diferenca } = require('../lib/auditoria');

const router = express.Router();
const soConfiguracoes = requireModulo('configuracoes');

router.param('id', (req, res, next, valor) => {
  if (!/^\d+$/.test(String(valor))) return res.status(400).json({ error: 'Vendedor inválido.' });
  next();
});

// Quem pode ver o percentual de comissão e a meta de cada pessoa.
//
// A tela de pedido precisa da LISTA de vendedores para o seletor; ela não
// precisa saber quanto cada colega ganha. Quem tem só o módulo `vendas`
// recebe a lista sem esses três campos — mesma regra que já vale para
// escrever, aplicada agora também para ler.
function podeVerComissao(req) {
  return req.user?.role === 'admin' || (req.user?.modulos || []).includes('configuracoes');
}
const CAMPOS_SENSIVEIS = ['comissao_tipo', 'comissao_valor', 'comissao_somente_faturado', 'meta_mensal'];
function filtrarSensiveis(vendedor, req) {
  if (podeVerComissao(req)) return vendedor;
  const copia = { ...vendedor };
  for (const campo of CAMPOS_SENSIVEIS) delete copia[campo];
  return copia;
}

const TIPOS_COMISSAO = new Set(['percentual_receita', 'percentual_lucro', 'valor_por_peca']);

const CAMPOS = [
  'nome', 'apelido', 'usuario_id', 'telefone', 'email',
  'comissao_tipo', 'comissao_valor', 'comissao_somente_faturado',
  'meta_mensal', 'ativo', 'observacao',
];

function normalizar(body) {
  const saida = {};
  for (const campo of CAMPOS) {
    if (body[campo] === undefined) continue;
    let valor = body[campo];
    if (valor === '') valor = null;
    if (campo === 'comissao_tipo') {
      valor = TIPOS_COMISSAO.has(valor) ? valor : 'percentual_receita';
    }
    if (campo === 'comissao_valor' || campo === 'meta_mensal') {
      valor = Number(valor) || 0;
      if (valor < 0) valor = 0;
    }
    if (campo === 'usuario_id') valor = valor === null ? null : Number(valor) || null;
    if (campo === 'ativo' || campo === 'comissao_somente_faturado') valor = valor !== false && valor !== 'false';
    saida[campo] = valor;
  }
  return saida;
}

async function fetchVendedor(id) {
  const { rows } = await pool.query(
    `SELECT v.*, u.nome AS usuario_nome, u.email AS usuario_email, u.ativo AS usuario_ativo
       FROM vendedores v LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// GET /api/vendedores?incluir_inativos=1&com_resumo=1&data_inicio=&data_fim=
//
// `com_resumo` acrescenta, para cada vendedor, quanto ele vendeu no período
// pedido — é o que a tela de cadastro mostra ao lado do nome, para a lista
// não ser só um cadastro morto.
router.get('/', async (req, res, next) => {
  try {
    const { incluir_inativos: incluirInativos, com_resumo: comResumo, data_inicio: dataInicio, data_fim: dataFim } = req.query;
    const where = incluirInativos === '1' ? '' : 'WHERE v.ativo = TRUE';
    const { rows } = await pool.query(
      `SELECT v.*, u.nome AS usuario_nome, u.email AS usuario_email, u.ativo AS usuario_ativo
         FROM vendedores v LEFT JOIN usuarios u ON u.id = v.usuario_id
         ${where}
        ORDER BY v.ativo DESC, v.nome`
    );
    if (comResumo !== '1') return res.json(rows.map((v) => filtrarSensiveis(v, req)));

    const condicoes = ["pv.situacao <> 'cancelado'", 'pv.vendedor_id IS NOT NULL', 'pv.origem_marketplace IS NULL'];
    const valores = [];
    let i = 1;
    if (dataInicio) { condicoes.push(`pv.data_pedido >= $${i}`); valores.push(dataInicio); i += 1; }
    if (dataFim) { condicoes.push(`pv.data_pedido <= $${i}`); valores.push(dataFim); i += 1; }
    const { rows: resumoRows } = await pool.query(
      `SELECT pv.vendedor_id,
              COUNT(*)::int AS pedidos,
              COALESCE(SUM(pv.total_liquido), 0) AS receita,
              COALESCE(SUM(pv.quantidade_pecas), 0) AS pecas,
              MAX(pv.data_pedido) AS ultima_venda
         FROM pedidos_venda pv
        WHERE ${condicoes.join(' AND ')}
        GROUP BY pv.vendedor_id`,
      valores
    );
    const mapa = new Map(resumoRows.map((r) => [r.vendedor_id, r]));
    res.json(rows.map((v) => {
      const r = mapa.get(v.id);
      return {
        ...filtrarSensiveis(v, req),
        resumo: {
          pedidos: r ? r.pedidos : 0,
          receita: r ? Number(r.receita) : 0,
          pecas: r ? Number(r.pecas) : 0,
          ultimaVenda: r ? r.ultima_venda : null,
        },
      };
    }));
  } catch (err) {
    next(err);
  }
});

// Usuários que ainda não estão ligados a nenhum vendedor — alimenta o
// seletor "criar vendedor a partir de um usuário do sistema".
router.get('/usuarios-disponiveis', soConfiguracoes, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.nome, u.email, u.role, u.ativo
         FROM usuarios u
        WHERE NOT EXISTS (SELECT 1 FROM vendedores v WHERE v.usuario_id = u.id)
        ORDER BY u.ativo DESC, u.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const vendedor = await fetchVendedor(req.params.id);
    if (!vendedor) return res.status(404).json({ error: 'Vendedor não encontrado.' });
    res.json(filtrarSensiveis(vendedor, req));
  } catch (err) {
    next(err);
  }
});

router.post('/', soConfiguracoes, async (req, res, next) => {
  try {
    const dados = normalizar(req.body || {});
    if (!dados.nome || !String(dados.nome).trim()) {
      return res.status(400).json({ error: 'O nome do vendedor é obrigatório.' });
    }
    dados.nome = String(dados.nome).trim();

    const { rows: repetido } = await pool.query('SELECT id FROM vendedores WHERE lower(nome) = lower($1)', [dados.nome]);
    if (repetido.length > 0) {
      return res.status(409).json({ error: `Já existe um vendedor chamado "${dados.nome}".` });
    }
    if (dados.usuario_id) {
      const { rows: jaLigado } = await pool.query('SELECT id, nome FROM vendedores WHERE usuario_id = $1', [dados.usuario_id]);
      if (jaLigado.length > 0) {
        return res.status(409).json({ error: `Esse usuário já está ligado ao vendedor "${jaLigado[0].nome}".` });
      }
    }

    const campos = Object.keys(dados);
    const { rows } = await pool.query(
      `INSERT INTO vendedores (${campos.join(', ')}) VALUES (${campos.map((_, idx) => `$${idx + 1}`).join(', ')}) RETURNING *`,
      campos.map((c) => dados[c])
    );
    await registrar(req, {
      acao: 'criou', entidade: 'vendedor', entidadeId: rows[0].id,
      descricao: `Cadastrou o vendedor "${rows[0].nome}"`, depois: rows[0],
    });
    res.status(201).json(await fetchVendedor(rows[0].id));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', soConfiguracoes, async (req, res, next) => {
  try {
    const atual = await fetchVendedor(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Vendedor não encontrado.' });

    const dados = normalizar(req.body || {});
    if (dados.nome !== undefined) {
      if (!String(dados.nome || '').trim()) return res.status(400).json({ error: 'O nome do vendedor é obrigatório.' });
      dados.nome = String(dados.nome).trim();
      const { rows: repetido } = await pool.query(
        'SELECT id FROM vendedores WHERE lower(nome) = lower($1) AND id <> $2',
        [dados.nome, req.params.id]
      );
      if (repetido.length > 0) return res.status(409).json({ error: `Já existe outro vendedor chamado "${dados.nome}".` });
    }
    if (dados.usuario_id) {
      const { rows: jaLigado } = await pool.query(
        'SELECT id, nome FROM vendedores WHERE usuario_id = $1 AND id <> $2',
        [dados.usuario_id, req.params.id]
      );
      if (jaLigado.length > 0) return res.status(409).json({ error: `Esse usuário já está ligado ao vendedor "${jaLigado[0].nome}".` });
    }

    const campos = Object.keys(dados);
    if (campos.length > 0) {
      const sets = campos.map((c, idx) => `${c} = $${idx + 1}`);
      await pool.query(
        `UPDATE vendedores SET ${sets.join(', ')}, updated_at = now() WHERE id = $${campos.length + 1}`,
        [...campos.map((c) => dados[c]), req.params.id]
      );
    }
    const depois = await fetchVendedor(req.params.id);
    await registrar(req, {
      acao: 'alterou', entidade: 'vendedor', entidadeId: Number(req.params.id),
      descricao: `Alterou o vendedor "${depois.nome}"`, ...diferenca(atual, depois),
    });
    res.json(depois);
  } catch (err) {
    next(err);
  }
});

// Vendedor NÃO é excluído quando já tem venda no nome dele — desativar
// preserva o histórico e o relatório de comissão dos meses anteriores.
// Apagar registro de dado é justamente o que a REGRA 4 proíbe.
router.delete('/:id', soConfiguracoes, async (req, res, next) => {
  try {
    const atual = await fetchVendedor(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Vendedor não encontrado.' });

    const { rows: usos } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM pedidos_venda WHERE vendedor_id = $1',
      [req.params.id]
    );
    if (usos[0].total > 0) {
      return res.status(409).json({
        error: `"${atual.nome}" já tem ${usos[0].total} pedido(s) no nome dele. `
          + 'Em vez de excluir, desative o vendedor — assim o histórico e a comissão dos meses anteriores continuam existindo.',
      });
    }
    await pool.query('DELETE FROM vendedores WHERE id = $1', [req.params.id]);
    await registrar(req, {
      acao: 'excluiu', entidade: 'vendedor', entidadeId: Number(req.params.id),
      descricao: `Excluiu o vendedor "${atual.nome}" (sem nenhuma venda no nome dele)`, antes: atual,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
