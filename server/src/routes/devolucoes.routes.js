// Devolução e logística reversa.

const express = require('express');
const pool = require('../db/pool');
const {
  MOTIVOS, DESTINOS, lerDevolucao, itensDa, abrir, receber, avaliar, cancelar,
} = require('../lib/devolucao');

const ponte = require('../lib/financeiroPonte');

const router = express.Router();
const httpErr = (res, err) => (err && err.status ? res.status(err.status).json({ error: err.message }) : null);

router.get('/opcoes', (req, res) => {
  res.json({
    motivos: MOTIVOS,
    destinos: Object.entries(DESTINOS).map(([chave, d]) => ({ chave, ...d })),
  });
});

router.get('/', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.situacao) { params.push(req.query.situacao); cond.push(`d.situacao = $${params.length}`); }
    if (req.query.motivo) { params.push(req.query.motivo); cond.push(`d.motivo = $${params.length}`); }
    if (req.query.canal) { params.push(req.query.canal); cond.push(`d.canal = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT d.*, p.numero AS pedido_numero,
              (SELECT COUNT(*) FROM devolucao_itens i WHERE i.devolucao_id = d.id) AS itens,
              (SELECT COALESCE(SUM(i.quantidade),0) FROM devolucao_itens i WHERE i.devolucao_id = d.id) AS pecas,
              (SELECT COUNT(*) FROM devolucao_itens i WHERE i.devolucao_id = d.id AND i.destino IS NULL) AS sem_avaliar
         FROM devolucoes d
         LEFT JOIN pedidos_venda p ON p.id = d.pedido_id
         ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
        ORDER BY d.criado_em DESC LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// O painel: quanto do retorno é de cada motivo, e o que ele virou.
router.get('/panorama', async (req, res, next) => {
  try {
    const { rows: porMotivo } = await pool.query(
      `SELECT motivo,
              SUM(pecas) AS pecas,
              SUM(devolucoes) AS devolucoes,
              SUM(COALESCE(pecas_revenda,0)) AS revenda,
              SUM(COALESCE(pecas_segunda,0)) AS segunda,
              SUM(COALESCE(pecas_descarte,0)) AS descarte,
              SUM(COALESCE(pecas_sem_avaliar,0)) AS sem_avaliar
         FROM vw_devolucao_por_motivo GROUP BY motivo ORDER BY SUM(pecas) DESC`
    );
    const { rows: porReferencia } = await pool.query(
      `SELECT referencia,
              SUM(pecas) AS pecas,
              SUM(COALESCE(pecas_descarte,0) + COALESCE(pecas_segunda,0)) AS pecas_perdidas
         FROM vw_devolucao_por_motivo
        WHERE referencia IS NOT NULL
        GROUP BY referencia ORDER BY SUM(pecas) DESC LIMIT 30`
    );
    const { rows: totais } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE situacao = 'aguardando') AS aguardando,
         COUNT(*) FILTER (WHERE situacao = 'recebida') AS a_avaliar,
         COUNT(*) FILTER (WHERE situacao = 'avaliada') AS avaliadas,
         COALESCE(SUM(valor_reembolsado) FILTER (WHERE situacao <> 'cancelada'), 0) AS reembolsado
       FROM devolucoes`
    );
    res.json({ porMotivo, porReferencia, totais: totais[0] });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const d = await lerDevolucao(pool, req.params.id);
    if (!d) return res.status(404).json({ error: 'Devolução não encontrada.' });
    res.json({ devolucao: d, itens: await itensDa(pool, d.id) });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ⚠️ Mapeamento EXPLÍCITO, e não `{ ...req.body }`.
    //
    // A planilha do corpo vem em snake_case (`valor_reembolsado`) e a função
    // recebe camelCase (`valorReembolsado`). Espalhar o corpo fazia o valor
    // chegar como `undefined` e ser gravado como nulo — sem erro nenhum, e o
    // painel somava zero. Foi assim que este defeito apareceu, no teste do
    // painel e não no da devolução.
    const b = req.body || {};
    const d = await abrir(client, {
      pedidoId: b.pedido_id ?? b.pedidoId,
      canal: b.canal,
      pedidoCanalId: b.pedido_canal_id ?? b.pedidoCanalId,
      motivo: b.motivo,
      motivoDetalhe: b.motivo_detalhe ?? b.motivoDetalhe,
      itens: b.itens,
      codigoRastreioReverso: b.codigo_rastreio_reverso ?? b.codigoRastreioReverso,
      valorReembolsado: b.valor_reembolsado ?? b.valorReembolsado,
      valorFreteReverso: b.valor_frete_reverso ?? b.valorFreteReverso,
      observacao: b.observacao,
      usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.status(201).json({ devolucao: d, itens: await itensDa(pool, d.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

for (const [caminho, fn] of [['receber', receber], ['avaliar', avaliar], ['cancelar', cancelar]]) {
  router.post(`/:id/${caminho}`, async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client, {
        devolucaoId: Number(req.params.id),
        usuarioId: req.user?.id || null,
        itens: req.body?.itens,
        motivo: req.body?.motivo,
      });

      // A PONTE FINANCEIRA. O cabeçalho da migration 0060 registrava por
      // escrito que o dinheiro da devolução era "gravado, e ainda NÃO ligado
      // ao financeiro". É aqui que aquela ressalva deixa de valer.
      //
      // Duas necessidades separadas, e não uma soma: reembolso ao comprador e
      // frete reverso são linhas de DRE diferentes, e podem ser cobrados por
      // caminhos diferentes. Somá-los pouparia uma linha e custaria a
      // resposta de "quanto o frete de devolução me custou este mês".
      //
      // NÃO trava a avaliação: a peça já voltou fisicamente, e travar a
      // avaliação pararia o galpão por uma decisão contábil. A garantia aqui
      // é a Caixa de Entrada e a varredura de cobertura.
      let financeiro = null;
      if (caminho === 'receber' || caminho === 'avaliar') {
        const dev = await lerDevolucao(client, Number(req.params.id));
        financeiro = [];
        const partes = [
          { chave: 'reembolso', valor: dev?.valor_reembolsado, rotulo: 'Reembolso ao comprador' },
          { chave: 'frete_reverso', valor: dev?.valor_frete_reverso, rotulo: 'Frete reverso' },
        ];
        for (const parte of partes) {
          if (!(Number(parte.valor) > 0)) continue;
          const r = await ponte.registrar(client, {
            origem_codigo: 'devolucao',
            origem_id: Number(req.params.id),
            chave: parte.chave,
            descricao: `${parte.rotulo} — DEV ${dev.numero}`,
            documento: `DEV ${dev.numero}`,
            contraparte_nome: dev.canal || 'Devolução',
            valor_estimado: Number(parte.valor),
            // A normalização de data é da ponte — ver `dataIso` lá: `pg` devolve
            // DATE como objeto Date, e cortar a string dele daria "Sat Aug 15".
            data_competencia: dev.recebida_em || dev.criado_em || new Date(),
            detalhe: { base: parte.rotulo, motivo: dev.motivo, canal: dev.canal, pedido_canal_id: dev.pedido_canal_id },
            usuarioId: req.user?.id || null,
            // Em marketplace este dinheiro quase sempre JÁ veio descontado do
            // repasse. Gerar título automático aqui contaria o mesmo dinheiro
            // duas vezes — por isso a pendência espera a decisão de quem
            // olha: virar título (venda própria) ou ser dispensada apontando
            // o repasse que já a cobriu.
            autoTitulo: false,
          });
          financeiro.push({ chave: parte.chave, pendencia_id: r.pendencia?.id || null });
        }
      }
      if (caminho === 'cancelar') {
        financeiro = await ponte.cancelar(client, {
          origem_codigo: 'devolucao',
          origem_id: Number(req.params.id),
          motivo: req.body?.motivo,
          usuarioId: req.user?.id || null,
        });
      }

      await client.query('COMMIT');
      // As três funções devolvem formas diferentes (`receber` devolve a linha;
      // `avaliar` e `cancelar` devolvem um objeto com mais coisas). A rota
      // normaliza para UMA forma só — a tela não deveria ter que saber qual
      // ação devolve o quê.
      const corpo = out && out.devolucao ? out : { devolucao: out };
      res.json({ ...corpo, financeiro, itens: await itensDa(pool, Number(req.params.id)) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (httpErr(res, err)) return;
      next(err);
    } finally { client.release(); }
  });
}

// Os itens de um pedido, para montar a devolução sem digitar.
router.get('/pedido/:pedidoId/itens', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.variante_id, i.referencia, i.descricao, i.cor, i.tamanho, i.quantidade,
              COALESCE((SELECT SUM(di.quantidade) FROM devolucao_itens di
                          JOIN devolucoes d ON d.id = di.devolucao_id
                         WHERE di.variante_id = i.variante_id AND d.pedido_id = i.pedido_id
                           AND d.situacao <> 'cancelada'), 0) AS ja_devolvida
         FROM pedido_itens i WHERE i.pedido_id = $1 ORDER BY i.ordem, i.id`,
      [req.params.pedidoId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
