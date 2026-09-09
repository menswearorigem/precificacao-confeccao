// Etiquetas: conversão de ZPL para PDF e impressão em lote da expedição.
//
// Pedido de 03/09/2026, adiado desde então. A dor: a etiqueta do Mercado Livre
// Full sai em ZPL e a impressora da casa só imprime PDF.
//
// Motor híbrido: render LOCAL por padrão (sem rede, sem limite, sem mandar
// endereço de comprador para fora) e a Labelary como reserva EXPLÍCITA, só
// quando quem está na tela pedir.

const express = require('express');
const pool = require('../db/pool');
const { zplParaPdf, analisar } = require('../lib/zpl');
const { converterPelaLabelary } = require('../lib/zplLabelary');

const router = express.Router();

function tamanho(req) {
  return {
    dpmm: Number(req.body?.dpmm || req.query?.dpmm || 8),
    larguraMm: Number(req.body?.largura_mm || req.query?.largura_mm || 101.6),
    alturaMm: Number(req.body?.altura_mm || req.query?.altura_mm || 152.4),
  };
}

// Diz o que vai acontecer ANTES de converter: quantas etiquetas tem, se o
// render local dá conta, e o que ele não entendeu. A tela usa isto para não
// oferecer a reserva sem necessidade.
router.post('/zpl/analisar', (req, res) => {
  const zpl = String(req.body?.zpl || '');
  if (!zpl.trim()) return res.status(400).json({ error: 'Envie o conteúdo ZPL.' });
  const info = analisar(zpl);
  res.json({
    ...info,
    recomendacao: info.local
      ? 'Converto aqui mesmo, sem enviar nada para fora.'
      : `Esta etiqueta usa ${info.naoEntendidos.join(', ')}, que o conversor local não desenha. `
        + 'Dá para usar a Labelary como reserva — mas o conteúdo da etiqueta, incluindo nome e '
        + 'endereço do comprador, sai da casa nessa opção.',
  });
});

// Converte e devolve o PDF.
router.post('/zpl/pdf', async (req, res, next) => {
  try {
    const zpl = String(req.body?.zpl || '');
    if (!zpl.trim()) return res.status(400).json({ error: 'Envie o conteúdo ZPL.' });
    const opcoes = tamanho(req);
    const usarReserva = req.body?.usar_labelary === true;

    let pdf;
    let motor;
    if (usarReserva) {
      pdf = await converterPelaLabelary(zpl, {
        dpmm: opcoes.dpmm,
        larguraPol: Number((opcoes.larguraMm / 25.4).toFixed(2)),
        alturaPol: Number((opcoes.alturaMm / 25.4).toFixed(2)),
      });
      motor = 'labelary';
    } else {
      const info = analisar(zpl);
      // Zero etiquetas é outro problema — e a mensagem "não desenha ." não
      // ajudava ninguém. Quem colou o arquivo errado precisa ouvir isso.
      if (info.etiquetas === 0) {
        return res.status(400).json({
          error: 'Não encontrei nenhuma etiqueta no conteúdo (falta ^XA ... ^XZ). Confira o arquivo.',
        });
      }
      if (!info.local) {
        return res.status(422).json({
          error: `O conversor local não desenha ${info.naoEntendidos.join(', ')}. `
            + 'Reenvie com "usar_labelary": true se aceitar que o conteúdo da etiqueta saia da casa.',
          naoEntendidos: info.naoEntendidos,
        });
      }
      pdf = zplParaPdf(zpl, opcoes).pdf;
      motor = 'local';
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Motor-Conversao', motor);
    res.setHeader('Content-Disposition', `inline; filename="etiquetas.pdf"`);
    res.send(pdf);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Lote da expedição: junta o ZPL de vários pedidos num PDF só, na ordem em que
// vieram. Uma ação, N etiquetas — é isso que tira a expedição do painel de
// cada marketplace.
router.post('/zpl/lote', async (req, res, next) => {
  try {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (itens.length === 0) return res.status(400).json({ error: 'Envie ao menos uma etiqueta.' });
    if (itens.length > 500) {
      return res.status(400).json({ error: 'Máximo de 500 etiquetas por lote.' });
    }

    const opcoes = tamanho(req);
    const zplJunto = itens.map((i) => String(i.zpl || '')).join('\n');
    const info = analisar(zplJunto);
    if (!info.local && req.body?.usar_labelary !== true) {
      return res.status(422).json({
        error: `Há etiquetas no lote com ${info.naoEntendidos.join(', ')}, que o conversor local não desenha.`,
        naoEntendidos: info.naoEntendidos,
      });
    }

    const pdf = req.body?.usar_labelary === true
      ? await converterPelaLabelary(zplJunto, {
        dpmm: opcoes.dpmm,
        larguraPol: Number((opcoes.larguraMm / 25.4).toFixed(2)),
        alturaPol: Number((opcoes.alturaMm / 25.4).toFixed(2)),
      })
      : zplParaPdf(zplJunto, opcoes).pdf;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Etiquetas', String(info.etiquetas));
    res.setHeader('Content-Disposition', 'attachment; filename="lote-etiquetas.pdf"');
    res.send(pdf);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// -------------------------------------------------------------- picking list

// Lista de separação AGREGADA POR SKU para um conjunto de pedidos.
//
// É a diferença entre andar pelo galpão uma vez por pedido e andar uma vez por
// referência. Numa confecção com grade cor × tamanho isso é a maior economia
// de tempo da expedição — o mesmo SKU aparece em vários pedidos do dia.
router.post('/picking', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.pedido_ids) ? req.body.pedido_ids : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Selecione os pedidos.' });

    const { rows } = await pool.query(
      `SELECT pi.produto_id, pi.descricao, pi.cor, pi.tamanho,
              COALESCE(pi.referencia, '') AS referencia, COALESCE(v.ean, '') AS ean,
              v.localizacao,
              SUM(pi.quantidade) AS quantidade,
              COUNT(DISTINCT pi.pedido_id) AS pedidos
         FROM pedido_itens pi
         LEFT JOIN estoque_variantes v ON v.id = pi.variante_id
        WHERE pi.pedido_id = ANY($1::int[])
        GROUP BY pi.produto_id, pi.referencia, pi.descricao, pi.cor, pi.tamanho, v.ean, v.localizacao
        ORDER BY v.localizacao NULLS LAST, pi.descricao, pi.tamanho`,
      [ids]
    );

    const totalPecas = rows.reduce((s, r) => s + Number(r.quantidade), 0);
    res.json({
      pedidos: ids.length,
      linhas: rows.length,
      total_pecas: totalPecas,
      itens: rows,
    });
  } catch (err) { next(err); }
});

// A mesma lista, em PDF, para levar impressa no galpão.
router.post('/picking/pdf', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.pedido_ids) ? req.body.pedido_ids : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Selecione os pedidos.' });

    const { rows } = await pool.query(
      `SELECT pi.descricao, pi.cor, pi.tamanho, COALESCE(pi.referencia,'') AS referencia,
              v.localizacao, SUM(pi.quantidade) AS quantidade,
              COUNT(DISTINCT pi.pedido_id) AS pedidos
         FROM pedido_itens pi
         LEFT JOIN estoque_variantes v ON v.id = pi.variante_id
        WHERE pi.pedido_id = ANY($1::int[])
        GROUP BY pi.descricao, pi.cor, pi.tamanho, pi.referencia, v.localizacao
        ORDER BY v.localizacao NULLS LAST, pi.descricao, pi.tamanho`,
      [ids]
    );

    const { DocumentoPdf } = require('../lib/pdfMinimo');
    const doc = new DocumentoPdf();
    const A4_L = 595; const A4_A = 842;
    let pagina = doc.novaPagina(A4_L, A4_A);
    let y = 50;

    const cabecalho = () => {
      pagina.texto(40, y, 'LISTA DE SEPARAÇÃO', { tamanho: 16, negrito: true });
      y += 18;
      pagina.texto(40, y, `${ids.length} pedidos · ${rows.reduce((s, r) => s + Number(r.quantidade), 0)} peças · `
        + `${new Date().toLocaleString('pt-BR')}`, { tamanho: 9 });
      y += 20;
      pagina.retangulo(40, y, A4_L - 80, 1);
      y += 16;
      pagina.texto(40, y, 'LOCAL', { tamanho: 8, negrito: true });
      pagina.texto(110, y, 'PRODUTO', { tamanho: 8, negrito: true });
      pagina.texto(330, y, 'COR', { tamanho: 8, negrito: true });
      pagina.texto(420, y, 'TAM', { tamanho: 8, negrito: true });
      pagina.texto(460, y, 'QTD', { tamanho: 8, negrito: true });
      pagina.texto(510, y, 'PED', { tamanho: 8, negrito: true });
      y += 6;
      pagina.retangulo(40, y, A4_L - 80, 0.7);
      y += 14;
    };
    cabecalho();

    for (const r of rows) {
      if (y > A4_A - 50) { pagina = doc.novaPagina(A4_L, A4_A); y = 50; cabecalho(); }
      pagina.texto(40, y, r.localizacao || '—', { tamanho: 9 });
      pagina.texto(110, y, String(r.descricao || '').slice(0, 40), { tamanho: 9 });
      pagina.texto(330, y, String(r.cor || '—').slice(0, 16), { tamanho: 9 });
      pagina.texto(420, y, String(r.tamanho || '—'), { tamanho: 9 });
      pagina.texto(460, y, String(Number(r.quantidade)), { tamanho: 10, negrito: true });
      pagina.texto(510, y, String(r.pedidos), { tamanho: 9 });
      y += 15;
    }

    if (rows.length === 0) {
      pagina.texto(40, y, 'Nenhum item nos pedidos selecionados.', { tamanho: 10 });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="separacao.pdf"');
    res.send(doc.buffer());
  } catch (err) { next(err); }
});

module.exports = router;
