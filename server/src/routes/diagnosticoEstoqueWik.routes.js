// Diagnóstico TEMPORÁRIO da TAREFA 2 (Wik x saldo editado à mão) — só
// leitura, nunca apaga nem grava nada. Existe pelo mesmo motivo do
// diagnosticoReferencia.routes.js (Tarefa 1): não há acesso direto ao
// Postgres de produção nem à internet a partir deste ambiente — o dono do
// sistema abre essas URLs já logado como admin em produção e devolve o
// JSON. Remover depois que a conferência da Tarefa 2 terminar.
const express = require('express');
const pool = require('../db/pool');
const { variantesDuplicadas } = require('../lib/diagnosticoEstoqueWik');
const { previewReferencias } = require('../lib/wikSync');

const router = express.Router();

function parseReferencias(req) {
  const raw = req.query.referencias || '';
  return String(raw).split(',').map((r) => r.trim()).filter(Boolean);
}

// Variantes que já colidiriam sob a chave corrigida (referência+cor+tamanho
// normalizados) — candidata a duplicata criada pelo bug da chave antiga.
// ?referencias=OG1192,OG1620,MM6387 (omitir pra checar o catálogo inteiro).
router.get('/variantes-duplicadas', async (req, res, next) => {
  try {
    res.json(await variantesDuplicadas(pool, parseReferencias(req)));
  } catch (err) {
    next(err);
  }
});

// Lista ANTES/DEPOIS (busca no Wik + compara com o saldo atual) pras
// referências pedidas, SEM aplicar nada — precisa da integração com o Wik
// reconectada e ativa (Tarefa 3a).
router.get('/preview-referencias', async (req, res, next) => {
  try {
    const referencias = parseReferencias(req);
    if (referencias.length === 0) return res.status(400).json({ error: 'Informe ?referencias=REF1,REF2,...' });
    res.json(await previewReferencias(referencias));
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;
