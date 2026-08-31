// Seleção "produtos de marketplace".
//
// A marcação mora em produtos.marketplace (migration 0039) e serve pra três
// coisas: filtrar a lista de Produtos, filtrar o Estoque e — o motivo de
// existir — puxar de uma vez só a Ficha de Estoque de todas as referências
// anunciadas, pra conferir e imprimir tudo junto.
//
// Este router fica separado de produtos.routes.js de propósito: ele não
// devolve preço nem margem (só referência/descrição/marca/categoria), então
// pode ser liberado também pra quem só tem o módulo Estoque ou Configurações,
// sem abrir o dado sensível de precificação.
const express = require('express');
const pool = require('../db/pool');
const { normalizarComparacao } = require('../lib/marketplaceSync');

const router = express.Router();

const CAMPOS = 'id, referencia, codigo, descricao, categoria, marca, colecao, marketplace';

// Casamento de referência digitada/colada -> produto do cadastro.
//
// REGRA 2 (precisão): o cruzamento é por IDENTIFICADOR EXATO. Primeiro tenta
// igualdade literal; só se não achar aplica a MESMA normalização já usada no
// casamento de SKU do marketplace (sem acento, sem espaço/hífen/pontuação,
// maiúsculo — ver normalizarComparacao em marketplaceSync.js), que o script
// checar-colisao-referencia.js confirma não colidir no catálogo.
// Nada de busca por descrição ou aproximação: o que não bater volta na lista
// de "não encontradas" pra conferência humana, nunca é adivinhado.
async function resolverReferencias(db, referencias) {
  const limpas = [...new Set(referencias.map((r) => String(r || '').trim()).filter(Boolean))];
  if (limpas.length === 0) return { ids: [], encontradas: [], naoEncontradas: [], ambiguas: [] };

  const { rows } = await db.query('SELECT id, referencia FROM produtos');

  const porExata = new Map();
  const porNormalizada = new Map();
  for (const p of rows) {
    porExata.set(p.referencia, p);
    const chave = normalizarComparacao(p.referencia);
    if (!porNormalizada.has(chave)) porNormalizada.set(chave, []);
    porNormalizada.get(chave).push(p);
  }

  const ids = [];
  const encontradas = [];
  const naoEncontradas = [];
  const ambiguas = [];

  for (const ref of limpas) {
    const exata = porExata.get(ref);
    if (exata) {
      ids.push(exata.id);
      encontradas.push({ informada: ref, referencia: exata.referencia });
      continue;
    }
    const candidatos = porNormalizada.get(normalizarComparacao(ref)) || [];
    if (candidatos.length === 1) {
      ids.push(candidatos[0].id);
      encontradas.push({ informada: ref, referencia: candidatos[0].referencia });
    } else if (candidatos.length > 1) {
      // Duas referências diferentes do cadastro batem na mesma chave — não dá
      // pra escolher sozinho sem arriscar marcar o produto errado.
      ambiguas.push({ informada: ref, candidatas: candidatos.map((c) => c.referencia) });
    } else {
      naoEncontradas.push(ref);
    }
  }

  return { ids, encontradas, naoEncontradas, ambiguas };
}

async function aplicarMarcacao(req, res, next, marketplace) {
  try {
    const body = req.body || {};
    const referencias = Array.isArray(body.referencias) ? body.referencias : [];
    const idsInformados = (Array.isArray(body.ids) ? body.ids : [])
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);

    const resolvido = await resolverReferencias(pool, referencias);
    const ids = [...new Set([...resolvido.ids, ...idsInformados])];

    if (ids.length === 0) {
      return res.json({
        alterados: 0,
        jaEstavam: 0,
        naoEncontradas: resolvido.naoEncontradas,
        ambiguas: resolvido.ambiguas,
      });
    }

    // Só conta como "alterado" quem realmente mudou de estado — marcar de novo
    // quem já estava marcado não é erro, mas também não é uma alteração.
    const { rows } = await pool.query(
      `UPDATE produtos SET marketplace = $1, updated_at = now()
        WHERE id = ANY($2) AND marketplace IS DISTINCT FROM $1
        RETURNING referencia`,
      [marketplace, ids]
    );

    res.json({
      alterados: rows.length,
      jaEstavam: ids.length - rows.length,
      referenciasAlteradas: rows.map((r) => r.referencia),
      naoEncontradas: resolvido.naoEncontradas,
      ambiguas: resolvido.ambiguas,
    });
  } catch (err) {
    next(err);
  }
}

// Lista a seleção inteira, na ordem em que a ficha de estoque vai sair.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${CAMPOS} FROM produtos WHERE marketplace ORDER BY referencia`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Referências que AINDA NÃO estão na seleção, pra alimentar a busca da tela
// de administração ("adicionar produto à seleção").
router.get('/candidatos', async (req, res, next) => {
  try {
    const busca = String(req.query.busca || '').trim();
    const values = [];
    let where = 'WHERE marketplace = FALSE';
    if (busca) {
      where += ' AND (referencia ILIKE $1 OR descricao ILIKE $1 OR codigo ILIKE $1)';
      values.push(`%${busca}%`);
    }
    const { rows } = await pool.query(
      `SELECT ${CAMPOS} FROM produtos ${where} ORDER BY referencia LIMIT 200`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Prévia da colagem em massa: diz o que casaria, o que não casaria e o que
// ficou ambíguo — SEM gravar nada. É o passo que evita marcar errado uma
// planilha inteira e só descobrir depois.
router.post('/conferir', async (req, res, next) => {
  try {
    const referencias = Array.isArray(req.body?.referencias) ? req.body.referencias : [];
    const resolvido = await resolverReferencias(pool, referencias);
    if (resolvido.ids.length === 0) {
      return res.json({ ...resolvido, jaNaSelecao: [], aMarcar: [] });
    }
    const { rows } = await pool.query(
      'SELECT id, referencia, descricao, marketplace FROM produtos WHERE id = ANY($1) ORDER BY referencia',
      [resolvido.ids]
    );
    res.json({
      encontradas: resolvido.encontradas,
      naoEncontradas: resolvido.naoEncontradas,
      ambiguas: resolvido.ambiguas,
      jaNaSelecao: rows.filter((r) => r.marketplace),
      aMarcar: rows.filter((r) => !r.marketplace),
    });
  } catch (err) {
    next(err);
  }
});

// Adiciona à seleção. Aceita `referencias` (colagem/planilha) e/ou `ids`
// (clique na tela) na mesma chamada.
router.post('/', (req, res, next) => aplicarMarcacao(req, res, next, true));

// Remove da seleção. POST em vez de DELETE porque precisa de corpo com a
// lista, e o cliente HTTP do front não manda corpo em DELETE.
router.post('/remover', (req, res, next) => aplicarMarcacao(req, res, next, false));

module.exports = router;
