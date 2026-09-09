// Produção: etapas, movimentação, ordem de serviço de facção e carga.
//
// A tela de movimentação é a cópia da tela "Gerar Movimentação" da versão
// antiga do Wik: um par ORIGEM → DESTINO, com vários destinos numa operação.
// A diferença é que aqui a peça tem cor e tamanho, e o saldo é conferido antes
// de gravar.

const express = require('express');
const pool = require('../db/pool');
const {
  movimentar, estornar, registrarRetorno, precoVigente, encerrarComQuebra,
} = require('../lib/producaoMovimentacao');
const ponte = require('../lib/financeiroPonte');

const router = express.Router();

function erroHttp(res, err) {
  // `exige` viaja junto: é ele que diz à tela QUAL campo faltou (ou qual
  // confirmação falta), em vez de deixar o operador reler a frase para
  // descobrir onde clicar.
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, exige: err.exige });
  }
  return null;
}

// ---------------------------------------------------------------- etapas

router.get('/etapas', async (req, res, next) => {
  try {
    // ⚠️ Corrigido em 09/09/2026: aqui havia uma subconsulta CORRELACIONADA
    // (`SELECT COUNT(*) FROM vw_producao_wip WHERE etapa_id = e.id`), executada
    // uma vez por etapa. `vw_producao_wip` é um UNION ALL + GROUP BY sobre o
    // livro-razão inteiro, e o `HAVING SUM(...) <> 0` impede o filtro de descer
    // — então eram onze agregações completas de `producao_movimentos` a cada
    // carregamento das três telas de produção. Agora é uma agregação só.
    const { rows } = await pool.query(
      `WITH carga AS (
         SELECT etapa_id, COUNT(*)::int AS n FROM vw_producao_wip
          WHERE quantidade > 0 GROUP BY etapa_id
       )
       SELECT e.*, COALESCE(c.n, 0) AS ordens_na_etapa
         FROM producao_etapas e
         LEFT JOIN carga c ON c.etapa_id = e.id
        ${req.query.todas === 'true' ? '' : 'WHERE e.ativo'}
        ORDER BY e.sequencia, e.nome`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/etapas', async (req, res, next) => {
  try {
    const { nome, sequencia = 0, natureza = 'interna', cor } = req.body || {};
    if (!String(nome || '').trim()) return res.status(400).json({ error: 'Informe o nome da etapa.' });
    if (!['interna', 'externa'].includes(natureza)) {
      return res.status(400).json({ error: 'Natureza deve ser interna ou externa.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO producao_etapas (nome, sequencia, natureza, cor) VALUES ($1,$2,$3,$4) RETURNING *`,
      [nome.trim(), Number(sequencia) || 0, natureza, cor || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Já existe uma etapa com esse nome.' });
    next(err);
  }
});

router.put('/etapas/:id', async (req, res, next) => {
  try {
    const { nome, sequencia, natureza, cor, ativo } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE producao_etapas SET
         nome = COALESCE($1, nome), sequencia = COALESCE($2, sequencia),
         natureza = COALESCE($3, natureza), cor = COALESCE($4, cor),
         ativo = COALESCE($5, ativo), atualizado_em = now()
       WHERE id = $6 RETURNING *`,
      [nome ?? null, sequencia ?? null, natureza ?? null, cor ?? null,
       ativo === undefined ? null : ativo, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Etapa não encontrada.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.get('/motivos', async (req, res, next) => {
  try {
    const cond = req.query.tipo ? 'WHERE ativo AND tipo = $1' : 'WHERE ativo';
    const { rows } = await pool.query(
      `SELECT * FROM producao_motivos ${cond} ORDER BY tipo, nome`,
      req.query.tipo ? [req.query.tipo] : []
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ------------------------------------------------------- onde está a peça

// WIP de uma ordem: quanto tem em cada etapa, por grade.
router.get('/ordens/:id/posicao', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT w.*, e.nome AS etapa_nome, e.natureza, e.sequencia, f.nome AS fornecedor_nome
         FROM vw_producao_wip w
         LEFT JOIN producao_etapas e ON e.id = w.etapa_id
         LEFT JOIN fornecedores f ON f.id = w.fornecedor_id
        WHERE w.ordem_id = $1
        ORDER BY e.sequencia NULLS LAST, w.cor, w.tamanho`,
      [req.params.id]
    );
    const total = rows.reduce((s, r) => s + Number(r.quantidade), 0);
    res.json({ posicao: rows, total_em_producao: total });
  } catch (err) { next(err); }
});

// Extrato de movimentos de uma ordem — o histórico completo, inclusive
// estornos. É a resposta para "quem tirou 200 peças do corte na sexta".
router.get('/ordens/:id/movimentos', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*,
              eo.nome AS etapa_origem_nome, ed.nome AS etapa_destino_nome,
              ei.nome AS etapa_identificadora_nome,
              fo.nome AS fornecedor_origem_nome, fd.nome AS fornecedor_destino_nome,
              mo.nome AS motivo_nome, u.nome AS usuario_nome,
              os.numero AS os_numero
         FROM producao_movimentos m
         LEFT JOIN producao_etapas eo ON eo.id = m.etapa_origem_id
         LEFT JOIN producao_etapas ed ON ed.id = m.etapa_destino_id
         LEFT JOIN producao_etapas ei ON ei.id = m.etapa_identificadora_id
         LEFT JOIN fornecedores fo ON fo.id = m.fornecedor_origem_id
         LEFT JOIN fornecedores fd ON fd.id = m.fornecedor_destino_id
         LEFT JOIN producao_motivos mo ON mo.id = m.motivo_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
         LEFT JOIN ordens_servico os ON os.id = m.ordem_servico_id
        WHERE m.ordem_id = $1
        ORDER BY m.data_movimento DESC, m.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ------------------------------------------------------------ movimentar

router.post('/movimentos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { ordem_id, etapa_origem_id, fornecedor_origem_id, destinos, data } = req.body || {};
    if (!ordem_id) return res.status(400).json({ error: 'Informe a ordem de produção.' });
    if (!Array.isArray(destinos) || destinos.length === 0) {
      return res.status(400).json({ error: 'Informe ao menos um destino.' });
    }

    await client.query('BEGIN');
    const resultado = await movimentar(client, {
      ordemId: ordem_id,
      etapaOrigemId: etapa_origem_id || null,
      fornecedorOrigemId: fornecedor_origem_id || null,
      destinos,
      data,
      usuarioId: req.user?.id || null,
    });
    // A PONTE FINANCEIRA. Remeter mercadoria para a facção é assumir uma
    // dívida — e era exatamente aqui que ela sumia: a O.S. nascia, a peça
    // saía, e o financeiro só ficava sabendo se alguém lembrasse de clicar
    // "gerar título" semanas depois.
    //
    // O valor é o PREVISTO da remessa (preço congelado × o que foi remetido),
    // não o final: o final é o que voltar bom, e isso `promover()` acerta no
    // retorno. Previsão é melhor que silêncio — o fluxo de caixa precisa
    // saber que esse dinheiro vai sair.
    const financeiro = [];
    for (const os of resultado.ordensServico || []) {
      const { rows: soma } = await client.query(
        'SELECT SUM(quantidade_remetida) AS remetido FROM ordem_servico_itens WHERE ordem_servico_id = $1',
        [os.id]
      );
      const remetido = Number(soma[0]?.remetido || 0);
      // Sem preço cadastrado o valor fica NULO, nunca zero: "não sei quanto
      // vai custar" e "vai custar nada" são coisas diferentes (REGRA 2), e a
      // Caixa de Entrada mostra "—" e cobra o cadastro do preço.
      const valor = os.valor_por_peca != null && remetido > 0
        ? Number((remetido * Number(os.valor_por_peca)).toFixed(2))
        : null;
      const { rows: forn } = await client.query(
        'SELECT nome FROM fornecedores WHERE id = $1', [os.fornecedor_id]
      );
      const r = await ponte.registrar(client, {
        origem_codigo: 'ordem_servico',
        origem_id: os.id,
        empresa_id: os.empresa_id,
        descricao: `Serviço de facção — O.S. ${os.numero}`,
        documento: `O.S. ${os.numero}`,
        fornecedor_id: os.fornecedor_id,
        contraparte_nome: forn[0]?.nome || null,
        valor_estimado: valor,
        data_competencia: os.data_remessa,
        detalhe: {
          base: 'remessa',
          pecas_remetidas: remetido,
          valor_por_peca: os.valor_por_peca,
          previsao_retorno: os.previsao_retorno,
        },
        usuarioId: req.user?.id || null,
      });
      financeiro.push({ ordem_servico_id: os.id, ...r });
      if (!r.gerouTitulo && r.faltando?.length) {
        resultado.avisos.push(
          `O.S. ${os.numero}: o compromisso com a facção foi para a Caixa de Entrada do Financeiro `
          + `— falta ${r.faltando.join(', ')}. A ordem de produção não fecha enquanto isso não for resolvido.`
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...resultado, financeiro });
  } catch (err) {
    await client.query('ROLLBACK');
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/movimentos/:id/estornar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mov = await estornar(client, {
      movimentoId: req.params.id,
      usuarioId: req.user?.id || null,
      motivo: req.body?.motivo,
    });
    await client.query('COMMIT');
    res.status(201).json(mov);
  } catch (err) {
    await client.query('ROLLBACK');
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// -------------------------------------------------------- ordem de serviço

router.get('/ordens-servico', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.situacao) {
      const lista = String(req.query.situacao).split(',').map((s) => s.trim()).filter(Boolean);
      if (lista.length) { params.push(lista); cond.push(`q.situacao = ANY($${params.length})`); }
    }
    if (req.query.fornecedor_id) {
      params.push(req.query.fornecedor_id); cond.push(`q.fornecedor_id = $${params.length}`);
    }
    if (req.query.atrasadas === 'true') {
      cond.push(`q.data_retorno IS NULL AND q.previsao_retorno < CURRENT_DATE AND q.situacao IN ('remetida','parcial')`);
    }
    // "só as que têm peça sumida" — a fila de cobrança da facção.
    if (req.query.com_quebra === 'true') cond.push('q.quebra > 0');

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT q.*, f.nome AS fornecedor_nome, e.nome AS etapa_nome,
              o.numero AS ordem_numero, p.referencia AS produto_referencia, p.descricao AS produto_descricao
         FROM vw_faccao_quebra q
         LEFT JOIN fornecedores f ON f.id = q.fornecedor_id
         LEFT JOIN producao_etapas e ON e.id = q.etapa_id
         LEFT JOIN ordens_producao o ON o.id = q.ordem_id
         LEFT JOIN produtos p ON p.id = o.produto_id
         ${where}
         ORDER BY q.data_remessa DESC NULLS LAST, q.numero DESC
         LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/ordens-servico/:id', async (req, res, next) => {
  try {
    const { rows: cab } = await pool.query(
      `SELECT q.*, f.nome AS fornecedor_nome, f.telefone AS fornecedor_telefone,
              e.nome AS etapa_nome, o.numero AS ordem_numero,
              p.referencia AS produto_referencia, p.descricao AS produto_descricao
         FROM vw_faccao_quebra q
         LEFT JOIN fornecedores f ON f.id = q.fornecedor_id
         LEFT JOIN producao_etapas e ON e.id = q.etapa_id
         LEFT JOIN ordens_producao o ON o.id = q.ordem_id
         LEFT JOIN produtos p ON p.id = o.produto_id
        WHERE q.ordem_servico_id = $1`,
      [req.params.id]
    );
    if (cab.length === 0) return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });

    const { rows: itens } = await pool.query(
      `SELECT *,
              quantidade_remetida - quantidade_retornada - quantidade_segunda - quantidade_perdida AS pendente
         FROM ordem_servico_itens WHERE ordem_servico_id = $1 ORDER BY cor, tamanho`,
      [req.params.id]
    );
    res.json({ ordem_servico: cab[0], itens });
  } catch (err) { next(err); }
});

// Retorno da facção.
router.post('/ordens-servico/:id/retorno', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { itens, etapa_destino_id, data, observacao, sair_do_fluxo } = req.body || {};
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ error: 'Informe o que voltou.' });
    }
    await client.query('BEGIN');
    const r = await registrarRetorno(client, {
      ordemServicoId: req.params.id,
      itens,
      etapaDestinoId: etapa_destino_id || null,
      sairDoFluxo: sair_do_fluxo === true,
      data,
      observacao,
      usuarioId: req.user?.id || null,
    });

    // A previsão vira fato. Paga-se pelo que voltou BOM: segunda qualidade e
    // quebra não são serviço prestado, e somá-las esconderia exatamente o
    // número que se quer cobrar da facção.
    const { rows: q } = await client.query(
      'SELECT * FROM vw_faccao_quebra WHERE ordem_servico_id = $1', [req.params.id]
    );
    let financeiro = null;
    if (q.length > 0 && q[0].valor_servico != null) {
      financeiro = await ponte.promover(client, {
        origem_codigo: 'ordem_servico',
        origem_id: Number(req.params.id),
        valor_real: Number(q[0].valor_servico),
        data_competencia: q[0].data_retorno || data || null,
        detalhe: {
          base: 'retorno',
          pecas_boas: q[0].retornado_bom,
          segunda: q[0].retornado_segunda,
          quebra: q[0].quebra,
          valor_por_peca: q[0].valor_por_peca,
        },
        usuarioId: req.user?.id || null,
      });
    }

    await client.query('COMMIT');
    res.status(201).json({ ...r, financeiro });
  } catch (err) {
    await client.query('ROLLBACK');
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// Encerrar assumindo a quebra.
//
// Sem esta saída, a O.S. de uma facção que perdeu peça ficava PARCIAL para
// sempre e a ordem de produção nunca fechava — a única alternativa era
// "dispensar" a pendência no financeiro, que é registrar uma mentira. A quebra
// continua medida e continua no ranking da facção: encerrar reconhece que a
// peça não volta, não apaga o fato de que ela sumiu.
router.post('/ordens-servico/:id/encerrar-quebra', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await encerrarComQuebra(client, {
      ordemServicoId: req.params.id,
      motivo: req.body?.motivo,
      usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.json({
      ...r,
      aviso: `A O.S. foi encerrada com ${r.quebra} peça(s) de quebra. Ela continua contando no `
        + 'indicador de quebra e no ranking da facção — encerrar não apaga o que sumiu.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/ordens-servico/:id/cancelar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Escreva o motivo do cancelamento.' });
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE ordens_servico
          SET situacao = 'cancelada',
              observacao = COALESCE(observacao,'') || $1, atualizado_em = now()
        WHERE id = $2 AND situacao <> 'cancelada' RETURNING id`,
      [`\n[cancelada] ${motivo}`, req.params.id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'O.S. não encontrada ou já cancelada.' });
    }
    // Cancela a necessidade e a PREVISÃO junto. Título já firme não se
    // cancela sozinho — a dívida pode existir mesmo com a O.S. cancelada, e
    // essa decisão é do financeiro. Quando sobra algum, a resposta diz.
    const financeiro = await ponte.cancelar(client, {
      origem_codigo: 'ordem_servico',
      origem_id: Number(req.params.id),
      motivo,
      usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.json({ ok: true, financeiro });
  } catch (err) {
    await client.query('ROLLBACK');
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// Fecha a corrente: O.S. → título a pagar da facção.
//
// É o elo que faltava. O serviço prestado vira dinheiro devido, com o valor
// apurado pelo que voltou BOM (segunda e quebra não são serviço prestado), e
// com a retenção de INSS quando houver — o caso recorrente de facção com
// cessão de mão de obra.
//
// A retenção NÃO é assumida: quem chama diz se retém e quanto. A regra real
// depende de (empresa tomadora, tipo de serviço, regime do prestador), e
// chutar 11% para todo mundo produziria guia errada.
router.post('/ordens-servico/:id/gerar-titulo', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { criarTitulo } = require('../lib/financeiroTitulos');
    const { data_vencimento, plano_id, centro_custo_id, reter_inss, aliquota_inss = 0.11, observacao } = req.body || {};
    if (!data_vencimento) return res.status(400).json({ error: 'Informe o vencimento do título.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT q.*, o.empresa_id, f.nome AS fornecedor_nome
         FROM vw_faccao_quebra q
         LEFT JOIN ordens_producao o ON o.id = q.ordem_id
         LEFT JOIN fornecedores f ON f.id = q.fornecedor_id
        WHERE q.ordem_servico_id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ordem de serviço não encontrada.' });
    }
    const os = rows[0];

    if (!os.valor_por_peca) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Esta O.S. não tem preço de serviço. Cadastre o preço da facção antes de gerar o título.',
      });
    }
    if (!(Number(os.valor_servico) > 0)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Nenhuma peça voltou boa nesta O.S. — não há serviço a pagar.',
      });
    }

    const { rows: jaTem } = await client.query(
      `SELECT id FROM fin_titulos WHERE origem_tipo = 'ordem_servico' AND origem_id = $1
         AND situacao <> 'cancelado'`,
      [req.params.id]
    );
    if (jaTem.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Esta O.S. já gerou o título ${jaTem[0].id}.` });
    }

    // O plano de contas vem do catálogo da ponte quando a tela não manda um.
    //
    // ⚠️ Corrigido em 09/09/2026: esta rota chamava `criarTitulo` direto com
    // `plano_id: plano_id || null`, e a tela nunca manda plano — então TODO
    // custo de facção nascia sem classificação no DRE, exatamente a "linha sem
    // categoria" que a ponte se recusa a produzir quando é ela quem cria o
    // título. O default de `fin_origens` ('3.2') só era aplicado pelo caminho
    // da ponte, que este não usa.
    const catalogo = await ponte.carregarOrigem(client, 'ordem_servico').catch(() => null);

    const titulo = await criarTitulo(client, {
      empresa_id: os.empresa_id,
      natureza: 'pagar',
      fornecedor_id: os.fornecedor_id,
      descricao: `Serviço de facção — O.S. ${os.numero}`,
      plano_id: plano_id || catalogo?.plano_id || null,
      centro_custo_id: centro_custo_id || catalogo?.centro_custo_id || null,
      data_competencia: os.data_retorno || os.data_remessa,
      data_vencimento,
      valor_bruto: Number(os.valor_servico),
      origem_tipo: 'ordem_servico',
      origem_id: Number(req.params.id),
      observacao: observacao
        || `${os.retornado_bom} peças boas × ${Number(os.valor_por_peca).toFixed(4)}.`
           + (Number(os.quebra) > 0 ? ` Quebra de ${os.quebra} peças não entrou no valor.` : ''),
      retencoes: reter_inss ? [{ tributo: 'inss', aliquota: aliquota_inss }] : [],
      usuarioId: req.user?.id || null,
    });

    // Fecha a necessidade que nasceu na remessa. Sem isto o título existiria
    // e a pendência continuaria na fila — a Caixa de Entrada mostraria
    // trabalho que já foi feito, que é a forma mais rápida de uma fila
    // perder a credibilidade.
    const { rows: pend } = await client.query(
      `UPDATE fin_pendencias SET situacao = 'atendida', atendida_em = now(), atendida_por = $2,
              atualizado_em = now()
        WHERE origem_codigo = 'ordem_servico' AND origem_id = $1 AND situacao = 'aberta'
        RETURNING id`,
      [Number(req.params.id), req.user?.id || null]
    );
    for (const p of pend) {
      await client.query(
        'INSERT INTO fin_pendencia_titulos (pendencia_id, titulo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [p.id, titulo.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ titulo, base: {
      pecas_boas: os.retornado_bom, valor_por_peca: os.valor_por_peca,
      quebra: os.quebra, segunda: os.retornado_segunda,
    } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

// ---------------------------------------------------------- tabela de preço

router.get('/faccao-precos', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, f.nome AS fornecedor_nome, e.nome AS etapa_nome, p.referencia AS produto_referencia
         FROM faccao_tabela_preco t
         JOIN fornecedores f ON f.id = t.fornecedor_id
         JOIN producao_etapas e ON e.id = t.etapa_id
         LEFT JOIN produtos p ON p.id = t.produto_id
        ORDER BY f.nome, e.sequencia, t.vigencia_inicio DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/faccao-precos', async (req, res, next) => {
  try {
    const { fornecedor_id, etapa_id, produto_id, valor_por_peca, vigencia_inicio, vigencia_fim, observacao } = req.body || {};
    if (!fornecedor_id || !etapa_id) return res.status(400).json({ error: 'Informe a facção e a etapa.' });
    if (valor_por_peca == null || Number(valor_por_peca) < 0) {
      return res.status(400).json({ error: 'Informe o valor por peça.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO faccao_tabela_preco
         (fornecedor_id, etapa_id, produto_id, valor_por_peca, vigencia_inicio, vigencia_fim, observacao, criado_por)
       VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7,$8) RETURNING *`,
      [fornecedor_id, etapa_id, produto_id || null, valor_por_peca,
       vigencia_inicio || null, vigencia_fim || null, observacao || null, req.user?.id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// Consulta do preço vigente — usada pela tela antes de remeter, para mostrar
// quanto aquela remessa vai custar.
router.get('/faccao-precos/vigente', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { fornecedor_id, etapa_id, produto_id, data } = req.query;
    if (!fornecedor_id || !etapa_id) return res.status(400).json({ error: 'Informe a facção e a etapa.' });
    const preco = await precoVigente(client, {
      fornecedorId: fornecedor_id,
      etapaId: etapa_id,
      produtoId: produto_id || null,
      data: data || new Date().toISOString().slice(0, 10),
    });
    res.json(preco || null);
  } catch (err) { next(err); } finally { client.release(); }
});

// ------------------------------------------------------------------ carga

// O gargalo, em peças E em minutos. A ideia é do Consistem: uma etapa com 200
// peças de 30 segundos está folgada; com 200 peças de 8 minutos, travada.
router.get('/carga', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, f.nome AS fornecedor_nome
         FROM vw_producao_carga_etapa c
         LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
        ORDER BY c.minutos DESC NULLS LAST, c.pecas DESC`
    );
    const semTempo = rows.filter((r) => r.minutos === null).length;
    res.json({
      carga: rows,
      // A tela precisa dizer isto por escrito em vez de mostrar zero minutos
      // (mestre 4.4): etapa sem operação casada no roteiro não tem tempo.
      etapas_sem_tempo: semTempo,
    });
  } catch (err) { next(err); }
});

// Ranking de facção: quem entrega no prazo, quem quebra, quanto custa.
// É o que fecha o ciclo de decisão — sem isso, escolher facção continua sendo
// pelo telefone.
router.get('/ranking-faccao', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.fornecedor_id, f.nome AS fornecedor_nome,
              COUNT(*) AS ordens_servico,
              SUM(q.remetido) AS remetido,
              SUM(q.retornado_bom) AS retornado_bom,
              SUM(q.retornado_segunda) AS segunda,
              SUM(q.quebra) AS quebra,
              CASE WHEN SUM(q.remetido) > 0
                   THEN SUM(q.quebra) / SUM(q.remetido) END AS quebra_fracao,
              CASE WHEN SUM(q.retornado_bom + q.retornado_segunda) > 0
                   THEN SUM(q.retornado_segunda) / SUM(q.retornado_bom + q.retornado_segunda) END AS segunda_fracao,
              COUNT(*) FILTER (WHERE q.data_retorno IS NOT NULL
                               AND q.previsao_retorno IS NOT NULL
                               AND q.data_retorno <= q.previsao_retorno) AS no_prazo,
              COUNT(*) FILTER (WHERE q.data_retorno IS NOT NULL AND q.previsao_retorno IS NOT NULL) AS concluidas_com_prazo,
              SUM(q.valor_servico) AS valor_servico
         FROM vw_faccao_quebra q
         JOIN fornecedores f ON f.id = q.fornecedor_id
        GROUP BY q.fornecedor_id, f.nome
        ORDER BY quebra_fracao DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
