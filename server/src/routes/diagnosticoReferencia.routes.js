// Diagnóstico TEMPORÁRIO da TAREFA 1 (normalizar referência no casamento
// SKU -> produto de marketplace) — só leitura, nenhum UPDATE/INSERT/DELETE.
// Existe só pra dar pro dono do sistema uma forma de rodar a conferência (a)
// e (b) direto de produção sem precisar de acesso ao banco. Remover depois
// que a conferência acabar (não é uma funcionalidade permanente do sistema).
const express = require('express');
const pool = require('../db/pool');
const { checarColisaoReferencia, previewRevinculoReferencia } = require('../lib/diagnosticoReferencia');

const router = express.Router();

router.get('/colisao', async (req, res, next) => {
  try {
    res.json(await checarColisaoReferencia(pool));
  } catch (err) {
    next(err);
  }
});

router.get('/preview-revinculo', async (req, res, next) => {
  try {
    res.json(await previewRevinculoReferencia(pool));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
