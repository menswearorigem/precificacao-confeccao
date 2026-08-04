const express = require('express');
const pool = require('../db/pool');
const wik = require('../lib/wik');
const { resolverEan } = require('../lib/eanResolver');
const { registrarMovimento } = require('../lib/estoqueMovimento');

const router = express.Router();

function paraFora(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    conectado: Boolean(row.access_token),
    ativo: row.ativo,
    ultimaSincronizacao: row.ultima_sincronizacao,
    ultimoErro: row.ultimo_erro,
  };
}

async function buscarIntegracao() {
  const { rows } = await pool.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
  return rows[0] || null;
}

// Garante um token válido pra integração, logando de novo se estiver
// ausente/expirado (o Wik expira o token em 4h e não deixa duas sessões
// simultâneas com o mesmo login, então evitamos logar à toa).
async function obterTokenValido(integracao) {
  const expirado = !integracao.token_expira_em || new Date(integracao.token_expira_em).getTime() - Date.now() < 60 * 1000;
  if (integracao.access_token && !expirado) return integracao.access_token;

  const resultado = await wik.login(integracao.email, integracao.senha);
  await pool.query(
    'UPDATE integracoes_wik SET access_token = $1, token_expira_em = $2, atualizado_em = now() WHERE id = $3',
    [resultado.token, resultado.expiraEm, integracao.id]
  );
  return resultado.token;
}

router.get('/', async (req, res, next) => {
  try {
    res.json(paraFora(await buscarIntegracao()));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha.' });
    const existente = await buscarIntegracao();
    let row;
    if (existente) {
      ({ rows: [row] } = await pool.query(
        `UPDATE integracoes_wik SET email = $1, senha = $2, access_token = NULL, token_expira_em = NULL,
                                     ultimo_erro = NULL, atualizado_em = now()
         WHERE id = $3 RETURNING *`,
        [email, senha, existente.id]
      ));
    } else {
      ({ rows: [row] } = await pool.query(
        'INSERT INTO integracoes_wik (email, senha) VALUES ($1, $2) RETURNING *',
        [email, senha]
      ));
    }
    res.status(201).json(paraFora(row));
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM integracoes_wik');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/testar', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial primeiro.' });
    const resultado = await wik.login(integracao.email, integracao.senha);
    await pool.query(
      'UPDATE integracoes_wik SET access_token = $1, token_expira_em = $2, ultimo_erro = NULL, atualizado_em = now() WHERE id = $3',
      [resultado.token, resultado.expiraEm, integracao.id]
    );
    res.json({ ok: true, nome: resultado.nome, email: resultado.email, expiraEm: resultado.expiraEm });
  } catch (err) {
    const integracao = await buscarIntegracao();
    if (integracao) await pool.query('UPDATE integracoes_wik SET ultimo_erro = $1, atualizado_em = now() WHERE id = $2', [err.message, integracao.id]);
    res.status(422).json({ error: err.message });
  }
});

// Agrupa as marcas cadastradas (listas tipo='marca') por Id de Empresa do
// Wik — mais de uma marca pode compartilhar o mesmo Id (ex.: Hoggar e Miss
// Manu ficam sob a mesma empresa lá no Wik).
async function empIdsConfigurados() {
  const { rows } = await pool.query(
    "SELECT valor, wik_emp_id FROM listas WHERE tipo = 'marca' AND wik_emp_id IS NOT NULL AND ativo = TRUE"
  );
  const porEmpId = new Map();
  for (const row of rows) {
    if (!porEmpId.has(row.wik_emp_id)) porEmpId.set(row.wik_emp_id, []);
    porEmpId.get(row.wik_emp_id).push(row.valor);
  }
  return porEmpId;
}

// Pré-visualização da sincronização de estoque: puxa o saldo de todas as
// empresas (marcas) configuradas e cruza com o que já existe localmente —
// mesma lógica/formato da importação manual de CSV/PDF (estoque.routes.js),
// só que a fonte é a API em vez de um arquivo. Nada é gravado aqui.
router.post('/estoque/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });
    const porEmpId = await empIdsConfigurados();
    if (porEmpId.size === 0) {
      return res.status(400).json({ error: 'Nenhuma marca tem Id de Empresa do Wik configurado (em Listas > Marcas).' });
    }

    const token = await obterTokenValido(integracao);

    const linhasBrutas = [];
    for (const empId of porEmpId.keys()) {
      const linhas = await wik.listarSaldoEstoque(token, empId);
      linhasBrutas.push(...linhas);
    }

    const { rows: produtosRows } = await pool.query('SELECT id, referencia FROM produtos');
    const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

    const { rows: variantesRows } = await pool.query(
      `SELECT v.*, p.referencia FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id`
    );
    const varianteExistente = new Map(variantesRows.map((v) => [`${v.referencia}::${v.cor}::${v.tamanho}`, v]));

    const porChave = new Map();
    const erros = [];
    for (const linha of linhasBrutas) {
      const referencia = linha.prod_referencia;
      const cor = linha.cor || '';
      const tamanho = linha.estct_tamanho || '';
      const quantidade = Number(linha.estct_saldo) || 0;
      if (!produtoIdPorReferencia.has(referencia)) {
        erros.push({ motivo: `Referência "${referencia}" não está cadastrada em Produtos — cadastre-a antes de sincronizar.`, dados: { referencia, cor, tamanho } });
        continue;
      }
      porChave.set(`${referencia}::${cor}::${tamanho}`, { referencia, descricao: linha.prod_descricao, cor, tamanho, quantidade });
    }

    const criar = [];
    const atualizar = [];
    for (const [chave, linha] of porChave.entries()) {
      const existente = varianteExistente.get(chave);
      if (existente) {
        if (Number(existente.quantidade) === linha.quantidade) continue; // sem mudança, não precisa listar
        atualizar.push({
          referencia: linha.referencia, descricao: linha.descricao, cor: linha.cor, tamanho: linha.tamanho,
          quantidadeAtual: Number(existente.quantidade), quantidadeNova: linha.quantidade, varianteId: existente.id,
        });
      } else {
        criar.push({ referencia: linha.referencia, descricao: linha.descricao, cor: linha.cor, tamanho: linha.tamanho, quantidadeNova: linha.quantidade });
      }
    }

    res.json({
      criar, atualizar, erros,
      resumo: { totalLinhasWik: linhasBrutas.length, variantesCriar: criar.length, variantesAtualizar: atualizar.length, totalErros: erros.length },
    });
  } catch (err) {
    const integracao = await buscarIntegracao();
    if (integracao) await pool.query('UPDATE integracoes_wik SET ultimo_erro = $1, atualizado_em = now() WHERE id = $2', [err.message, integracao.id]);
    res.status(422).json({ error: err.message });
  }
});

// Mesmo corpo {criar, atualizar} devolvido pelo preview acima — reaproveita
// a rota de confirmação já existente em /estoque/importacao/confirmar seria
// redundante, então replica a mesma lógica aqui (registrando o movimento
// como 'importacao' com motivo específico pra rastrear a origem).
router.post('/estoque/confirmar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const criar = body.criar || [];
    const atualizar = body.atualizar || [];

    const { rows: produtosRows } = await client.query('SELECT id, referencia FROM produtos');
    const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

    await client.query('BEGIN');

    let criados = 0;
    for (const item of criar) {
      const produtoId = produtoIdPorReferencia.get(item.referencia);
      if (!produtoId) continue;
      const ean = await resolverEan(client, item.referencia, item.cor, item.tamanho);
      const { rows } = await client.query(
        `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (produto_id, cor, tamanho) DO NOTHING RETURNING id`,
        [produtoId, item.cor, item.tamanho, ean, item.quantidadeNova]
      );
      if (rows.length > 0 && Number(item.quantidadeNova) !== 0) {
        await client.query(
          `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
           VALUES ($1, 'importacao', $2, $2, 'Sincronização automática — Wik Sistemas')`,
          [rows[0].id, item.quantidadeNova]
        );
      }
      if (rows.length > 0) criados += 1;
    }

    let atualizados = 0;
    for (const item of atualizar) {
      const delta = Number(item.quantidadeNova) - Number(item.quantidadeAtual);
      if (delta !== 0) {
        await registrarMovimento(client, item.varianteId, 'importacao', delta, 'Sincronização automática — Wik Sistemas');
      }
      atualizados += 1;
    }

    await client.query('COMMIT');

    const integracao = await buscarIntegracao();
    if (integracao) {
      await pool.query('UPDATE integracoes_wik SET ultima_sincronizacao = now(), ultimo_erro = NULL WHERE id = $1', [integracao.id]);
    }

    res.json({ criados, atualizados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
