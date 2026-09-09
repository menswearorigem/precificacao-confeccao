// Financeiro — núcleo: cadastros, títulos, baixa, extrato, conciliação,
// fluxo de caixa, DRE e o pacote do contador.
//
// Este arquivo NÃO emite documento fiscal. Emissão está fora de escopo.

const express = require('express');
const pool = require('../db/pool');
const {
  criarTitulo, baixar, estornarBaixa, saldoTitulo, calcularEncargos,
} = require('../lib/financeiroTitulos');
const { lerOfx } = require('../lib/ofx');

const router = express.Router();

const httpErr = (res, err) =>
  (err && err.status ? res.status(err.status).json({ error: err.message }) : null);

// =============================================================== cadastros

router.get('/plano', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM fin_plano ${req.query.todas === 'true' ? '' : 'WHERE ativo'} ORDER BY codigo`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/plano', async (req, res, next) => {
  try {
    const { codigo, nome, natureza, analitica = true, variavel = false, conta_contabil } = req.body || {};
    if (!codigo || !nome) return res.status(400).json({ error: 'Informe código e nome.' });
    if (!['receita', 'despesa', 'transferencia'].includes(natureza)) {
      return res.status(400).json({ error: 'Natureza deve ser receita, despesa ou transferencia.' });
    }
    const pai = String(codigo).includes('.')
      ? (await pool.query('SELECT id FROM fin_plano WHERE codigo = $1',
          [String(codigo).split('.').slice(0, -1).join('.')])).rows[0]
      : null;
    const { rows } = await pool.query(
      `INSERT INTO fin_plano (codigo, nome, pai_id, natureza, analitica, variavel, conta_contabil)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [codigo, nome, pai?.id || null, natureza, analitica, variavel, conta_contabil || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Já existe categoria com esse código.' });
    next(err);
  }
});

router.get('/centros-custo', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fin_centros_custo WHERE ativo ORDER BY codigo NULLS LAST, nome');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/centros-custo', async (req, res, next) => {
  try {
    const { codigo, nome } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'Informe o nome do centro de custo.' });
    const { rows } = await pool.query(
      'INSERT INTO fin_centros_custo (codigo, nome) VALUES ($1,$2) RETURNING *', [codigo || null, nome]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.get('/contas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, c.banco_nome, c.agencia, c.conta, c.ativo, e.nome AS empresa_nome
         FROM vw_fin_saldo_conta s
         JOIN fin_contas c ON c.id = s.conta_id
         LEFT JOIN empresas e ON e.id = s.empresa_id
        ${req.query.todas === 'true' ? '' : 'WHERE c.ativo'}
        ORDER BY e.nome, s.nome`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/contas', async (req, res, next) => {
  try {
    const { empresa_id, nome, tipo, banco_codigo, banco_nome, agencia, conta,
            saldo_inicial = 0, saldo_inicial_data } = req.body || {};
    if (!empresa_id || !nome) return res.status(400).json({ error: 'Informe a empresa e o nome da conta.' });
    const { rows } = await pool.query(
      `INSERT INTO fin_contas
         (empresa_id, nome, tipo, banco_codigo, banco_nome, agencia, conta, saldo_inicial, saldo_inicial_data)
       VALUES ($1,$2,COALESCE($3,'bancaria'),$4,$5,$6,$7,$8,$9) RETURNING *`,
      [empresa_id, nome, tipo || null, banco_codigo || null, banco_nome || null,
       agencia || null, conta || null, saldo_inicial, saldo_inicial_data || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ================================================================= títulos

router.get('/titulos', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    const add = (sql, v) => { params.push(v); cond.push(sql.replace('$?', `$${params.length}`)); };

    if (req.query.natureza) add('t.natureza = $?', req.query.natureza);
    if (req.query.empresa_id) add('t.empresa_id = $?', req.query.empresa_id);
    if (req.query.situacao) {
      add('t.situacao = ANY($?)', String(req.query.situacao).split(',').map((s) => s.trim()).filter(Boolean));
    }
    if (req.query.de) add('t.data_vencimento >= $?', req.query.de);
    if (req.query.ate) add('t.data_vencimento <= $?', req.query.ate);
    if (req.query.vencidos === 'true') {
      cond.push("t.data_vencimento < CURRENT_DATE AND t.situacao IN ('aberto','parcial')");
    }
    if (req.query.busca) {
      params.push(`%${req.query.busca}%`);
      cond.push(`(t.descricao ILIKE $${params.length} OR t.documento ILIKE $${params.length}
                  OR f.nome ILIKE $${params.length} OR t.contraparte_nome ILIKE $${params.length})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT t.*, s.valor_retido, s.valor_liquido, s.valor_baixado, s.saldo_aberto, s.dias_atraso,
              f.nome AS fornecedor_nome, cl.nome AS cliente_nome,
              p.nome AS plano_nome, p.codigo AS plano_codigo,
              cc.nome AS centro_custo_nome, e.nome AS empresa_nome
         FROM fin_titulos t
         JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
         LEFT JOIN fornecedores f ON f.id = t.fornecedor_id
         LEFT JOIN clientes cl ON cl.id = t.cliente_id
         LEFT JOIN fin_plano p ON p.id = t.plano_id
         LEFT JOIN fin_centros_custo cc ON cc.id = t.centro_custo_id
         LEFT JOIN empresas e ON e.id = t.empresa_id
         ${where}
         ORDER BY t.data_vencimento, t.id
         LIMIT 1000`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/titulos/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, s.valor_retido, s.valor_liquido, s.valor_baixado, s.saldo_aberto, s.dias_atraso,
              f.nome AS fornecedor_nome, cl.nome AS cliente_nome, e.nome AS empresa_nome
         FROM fin_titulos t
         JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
         LEFT JOIN fornecedores f ON f.id = t.fornecedor_id
         LEFT JOIN clientes cl ON cl.id = t.cliente_id
         LEFT JOIN empresas e ON e.id = t.empresa_id
        WHERE t.id = $1`, [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Título não encontrado.' });

    const [{ rows: retencoes }, { rows: rateios }, { rows: baixas }] = await Promise.all([
      pool.query('SELECT * FROM fin_titulo_retencoes WHERE titulo_id = $1 ORDER BY id', [req.params.id]),
      pool.query(`SELECT r.*, p.nome AS plano_nome, cc.nome AS centro_custo_nome
                    FROM fin_titulo_rateios r
                    LEFT JOIN fin_plano p ON p.id = r.plano_id
                    LEFT JOIN fin_centros_custo cc ON cc.id = r.centro_custo_id
                   WHERE r.titulo_id = $1 ORDER BY r.id`, [req.params.id]),
      pool.query(`SELECT b.*, c.nome AS conta_nome, u.nome AS usuario_nome
                    FROM fin_baixas b
                    LEFT JOIN fin_contas c ON c.id = b.conta_id
                    LEFT JOIN usuarios u ON u.id = b.usuario_id
                   WHERE b.titulo_id = $1 ORDER BY b.data_baixa, b.id`, [req.params.id]),
    ]);

    res.json({ titulo: rows[0], retencoes, rateios, baixas });
  } catch (err) { next(err); }
});

router.post('/titulos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const titulo = await criarTitulo(client, { ...req.body, usuarioId: req.user?.id || null });
    await client.query('COMMIT');
    res.status(201).json(titulo);
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// Gera N parcelas de uma vez. A sobra de centavo vai na ÚLTIMA parcela — se
// for jogada na primeira, o cliente estranha pagar mais no começo.
router.post('/titulos/parcelado', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { parcelas = 1, intervalo_dias = 30, valor_bruto, data_vencimento } = req.body || {};
    const n = Math.max(1, Number(parcelas) || 1);
    const totalCent = Math.round(Number(valor_bruto) * 100);
    if (!(totalCent > 0)) return res.status(400).json({ error: 'Informe um valor maior que zero.' });
    if (!data_vencimento) return res.status(400).json({ error: 'Informe o primeiro vencimento.' });

    await client.query('BEGIN');
    const base = Math.floor(totalCent / n);
    const criados = [];
    for (let i = 0; i < n; i += 1) {
      const valor = i === n - 1 ? totalCent - base * (n - 1) : base;
      const venc = new Date(`${data_vencimento}T00:00:00`);
      venc.setDate(venc.getDate() + i * Number(intervalo_dias));
      criados.push(await criarTitulo(client, {
        ...req.body,
        valor_bruto: valor / 100,
        data_vencimento: venc.toISOString().slice(0, 10),
        parcela: `${i + 1}/${n}`,
        usuarioId: req.user?.id || null,
      }));
    }
    await client.query('COMMIT');
    res.status(201).json({ titulos: criados });
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/titulos/:id/cancelar', async (req, res, next) => {
  try {
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Escreva o motivo do cancelamento.' });
    const { rows } = await pool.query(
      `UPDATE fin_titulos SET situacao='cancelado', cancelado_em=now(), cancelado_motivo=$1, atualizado_em=now()
        WHERE id=$2 AND situacao <> 'cancelado' RETURNING id`, [motivo, req.params.id]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Título não encontrado ou já cancelado.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Simulação de encargos antes de baixar — a tela mostra quanto vai sair.
router.get('/titulos/:id/encargos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const s = await saldoTitulo(client, req.params.id);
    if (!s) return res.status(404).json({ error: 'Título não encontrado.' });
    res.json(calcularEncargos({
      saldo: s.saldo_aberto,
      vencimento: s.data_vencimento.toISOString ? s.data_vencimento.toISOString().slice(0, 10) : s.data_vencimento,
      ate: req.query.ate || new Date().toISOString().slice(0, 10),
      multaPercentual: Number(req.query.multa || 0),
      jurosMesPercentual: Number(req.query.juros || 0),
    }));
  } catch (err) { next(err); } finally { client.release(); }
});

// ================================================================== baixas

router.post('/titulos/:id/baixar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await baixar(client, {
      tituloId: req.params.id, ...req.body, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.status(201).json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/baixas/:id/estornar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await estornarBaixa(client, {
      baixaId: req.params.id, motivo: req.body?.motivo, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.status(201).json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// ============================================== extrato bancário (OFX)

// Importa um OFX. O conteúdo vem em base64 para não depender de multipart.
router.post('/extrato/importar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { conta_id, arquivo_base64, arquivo_nome } = req.body || {};
    if (!conta_id) return res.status(400).json({ error: 'Informe a conta bancária.' });
    if (!arquivo_base64) return res.status(400).json({ error: 'Envie o arquivo OFX.' });

    const buffer = Buffer.from(arquivo_base64, 'base64');
    const { detectarCharset } = require('../lib/ofx');
    const texto = buffer.toString(detectarCharset(buffer));
    const lido = lerOfx(texto);

    await client.query('BEGIN');
    let novos = 0;
    let repetidos = 0;
    for (const l of lido.lancamentos) {
      const { rowCount } = await client.query(
        `INSERT INTO fin_extrato_bancario
           (conta_id, data_lancamento, valor, historico, documento, fitid, hash_dedup, tipo_ofx, arquivo_origem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (conta_id, hash_dedup) DO NOTHING`,
        [conta_id, l.data_lancamento, l.valor, l.historico, l.documento, l.fitid,
         l.hash_dedup, l.tipo_ofx, arquivo_nome || null]
      );
      if (rowCount > 0) novos += 1; else repetidos += 1;
    }
    await client.query('COMMIT');

    res.status(201).json({
      periodo: lido.periodo,
      conta_arquivo: lido.conta,
      lidos: lido.lancamentos.length,
      novos,
      // Repetido não é erro: reimportar o mesmo mês é normal e esperado.
      repetidos,
      avisos: lido.avisos,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.get('/extrato', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.conta_id) { params.push(req.query.conta_id); cond.push(`e.conta_id = $${params.length}`); }
    if (req.query.de) { params.push(req.query.de); cond.push(`e.data_lancamento >= $${params.length}`); }
    if (req.query.ate) { params.push(req.query.ate); cond.push(`e.data_lancamento <= $${params.length}`); }
    if (req.query.pendentes === 'true') cond.push('e.baixa_id IS NULL AND e.plano_id IS NULL');
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT e.*, c.nome AS conta_nome, p.nome AS plano_nome
         FROM fin_extrato_bancario e
         JOIN fin_contas c ON c.id = e.conta_id
         LEFT JOIN fin_plano p ON p.id = e.plano_id
         ${where}
         ORDER BY e.data_lancamento DESC, e.id DESC
         LIMIT 1000`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Sugestão de conciliação: para um lançamento do extrato, os títulos que
// podem ser ele. A ordem é a que o mercado usa — valor exato e data próxima
// primeiro, e a janela abre à medida que nada casa.
router.get('/extrato/:id/sugestoes', async (req, res, next) => {
  try {
    const { rows: ex } = await pool.query('SELECT * FROM fin_extrato_bancario WHERE id = $1', [req.params.id]);
    if (ex.length === 0) return res.status(404).json({ error: 'Lançamento não encontrado.' });
    const lanc = ex[0];
    const natureza = Number(lanc.valor) < 0 ? 'pagar' : 'receber';
    const valorAbs = Math.abs(Number(lanc.valor));

    const { rows } = await pool.query(
      `SELECT t.id, t.descricao, t.documento, t.data_vencimento, s.saldo_aberto,
              f.nome AS fornecedor_nome, cl.nome AS cliente_nome,
              ABS(s.saldo_aberto - $2) AS diferenca_valor,
              ABS(t.data_vencimento - $3::date) AS diferenca_dias
         FROM fin_titulos t
         JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
         LEFT JOIN fornecedores f ON f.id = t.fornecedor_id
         LEFT JOIN clientes cl ON cl.id = t.cliente_id
        WHERE t.natureza = $1
          AND t.situacao IN ('aberto','parcial')
          AND s.saldo_aberto > 0
          AND ABS(t.data_vencimento - $3::date) <= 30
        ORDER BY ABS(s.saldo_aberto - $2), ABS(t.data_vencimento - $3::date)
        LIMIT 20`,
      [natureza, valorAbs, lanc.data_lancamento]
    );
    res.json({ lancamento: lanc, sugestoes: rows });
  } catch (err) { next(err); }
});

// Conciliar: ou casa com um título (gerando a baixa), ou classifica direto
// numa categoria (tarifa, rendimento), ou marca como transferência entre
// contas próprias.
router.post('/extrato/:id/conciliar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { titulo_id, plano_id, transferencia_par_id } = req.body || {};
    await client.query('BEGIN');
    const { rows: ex } = await client.query(
      'SELECT * FROM fin_extrato_bancario WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (ex.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lançamento não encontrado.' });
    }
    const lanc = ex[0];
    if (lanc.baixa_id || lanc.plano_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este lançamento já foi conciliado.' });
    }

    if (titulo_id) {
      const r = await baixar(client, {
        tituloId: titulo_id,
        conta_id: lanc.conta_id,
        data_baixa: lanc.data_lancamento,
        principal: Math.abs(Number(lanc.valor)),
        observacao: `Conciliado com o extrato: ${lanc.historico || ''}`.trim(),
        usuarioId: req.user?.id || null,
      });
      await client.query(
        `UPDATE fin_extrato_bancario SET baixa_id = $1, conciliado_em = now(), conciliado_por = $2
          WHERE id = $3`,
        [r.baixa.id, req.user?.id || null, req.params.id]
      );
    } else if (plano_id) {
      await client.query(
        `UPDATE fin_extrato_bancario SET plano_id = $1, conciliado_em = now(), conciliado_por = $2
          WHERE id = $3`,
        [plano_id, req.user?.id || null, req.params.id]
      );
    } else if (transferencia_par_id) {
      await client.query(
        `UPDATE fin_extrato_bancario SET transferencia_par_id = $1, conciliado_em = now(), conciliado_por = $2
          WHERE id = $3`,
        [transferencia_par_id, req.user?.id || null, req.params.id]
      );
      await client.query(
        `UPDATE fin_extrato_bancario SET transferencia_par_id = $1, conciliado_em = now()
          WHERE id = $2 AND transferencia_par_id IS NULL`,
        [req.params.id, transferencia_par_id]
      );
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Diga com o que conciliar: um título, uma categoria, ou o par da transferência.',
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// =============================================== leituras consolidadas

router.get('/aging', async (req, res, next) => {
  try {
    const natureza = req.query.natureza || 'receber';
    const { rows } = await pool.query(
      `SELECT faixa,
              COUNT(*) AS titulos,
              SUM(saldo_aberto) AS valor
         FROM vw_fin_aging
        WHERE natureza = $1 AND saldo_aberto > 0
        GROUP BY faixa
        ORDER BY CASE faixa
          WHEN 'a_vencer' THEN 0 WHEN '1_30' THEN 1 WHEN '31_60' THEN 2
          WHEN '61_90' THEN 3 WHEN '91_180' THEN 4 ELSE 5 END`,
      [natureza]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/fluxo-caixa', async (req, res, next) => {
  try {
    const de = req.query.de || new Date().toISOString().slice(0, 10);
    const ate = req.query.ate || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT data, visao, natureza, SUM(valor) AS valor
         FROM vw_fin_fluxo_caixa
        WHERE data BETWEEN $1 AND $2
          ${req.query.empresa_id ? 'AND empresa_id = $3' : ''}
        GROUP BY data, visao, natureza
        ORDER BY data`,
      req.query.empresa_id ? [de, ate, req.query.empresa_id] : [de, ate]
    );

    // Saldo acumulado do previsto, dia a dia: é o número que responde "quando
    // o caixa fica negativo", que é a pergunta real do fluxo.
    const { rows: contas } = await pool.query(
      `SELECT COALESCE(SUM(saldo_atual),0) AS saldo FROM vw_fin_saldo_conta
        ${req.query.empresa_id ? 'WHERE empresa_id = $1' : ''}`,
      req.query.empresa_id ? [req.query.empresa_id] : []
    );

    res.json({ saldo_inicial: Number(contas[0].saldo), linhas: rows });
  } catch (err) { next(err); }
});

router.get('/dre', async (req, res, next) => {
  try {
    const de = req.query.de || `${new Date().getFullYear()}-01-01`;
    const ate = req.query.ate || new Date().toISOString().slice(0, 10);
    const params = [de, ate];
    let filtroEmpresa = '';
    if (req.query.empresa_id) { params.push(req.query.empresa_id); filtroEmpresa = `AND empresa_id = $3`; }

    const { rows } = await pool.query(
      `SELECT codigo, plano_nome, natureza, variavel, SUM(valor) AS valor
         FROM vw_fin_dre
        WHERE competencia BETWEEN $1 AND $2 ${filtroEmpresa}
        GROUP BY codigo, plano_nome, natureza, variavel
        ORDER BY codigo`, params
    );

    const receita = rows.filter((r) => r.natureza === 'receita').reduce((s, r) => s + Number(r.valor), 0);
    const variaveis = rows.filter((r) => r.natureza === 'despesa' && r.variavel)
      .reduce((s, r) => s + Number(r.valor), 0);
    const fixas = rows.filter((r) => r.natureza === 'despesa' && !r.variavel)
      .reduce((s, r) => s + Number(r.valor), 0);
    const margemContribuicao = receita + variaveis; // variáveis já vêm negativas
    const resultado = margemContribuicao + fixas;

    res.json({
      periodo: { de, ate },
      linhas: rows,
      resumo: {
        receita,
        custos_variaveis: variaveis,
        margem_contribuicao: margemContribuicao,
        margem_contribuicao_fracao: receita > 0 ? margemContribuicao / receita : null,
        despesas_fixas: fixas,
        resultado,
        // Ponto de equilíbrio: quanto precisa faturar para o resultado ser
        // zero. NULO quando a margem de contribuição é zero ou negativa —
        // nesse caso não existe faturamento que salve, e um número aqui
        // mentiria (REGRA 2).
        ponto_equilibrio: margemContribuicao > 0 && receita > 0
          ? Math.abs(fixas) / (margemContribuicao / receita)
          : null,
      },
    });
  } catch (err) { next(err); }
});

// O pacote que o contador pede todo mês, num CSV só.
router.get('/exportar-contador', async (req, res, next) => {
  try {
    const de = req.query.de;
    const ate = req.query.ate;
    if (!de || !ate) return res.status(400).json({ error: 'Informe o período (de e ate).' });

    const { rows } = await pool.query(
      `SELECT b.data_baixa AS data,
              t.natureza,
              COALESCE(f.nome, cl.nome, t.contraparte_nome) AS contraparte,
              t.documento, t.descricao,
              p.codigo AS categoria_codigo, p.nome AS categoria,
              p.conta_contabil,
              cc.nome AS centro_custo,
              e.nome AS empresa,
              b.principal, b.juros, b.multa, b.desconto, b.tarifa,
              c.nome AS conta
         FROM fin_baixas b
         JOIN fin_titulos t ON t.id = b.titulo_id
         LEFT JOIN fornecedores f ON f.id = t.fornecedor_id
         LEFT JOIN clientes cl ON cl.id = t.cliente_id
         LEFT JOIN fin_plano p ON p.id = t.plano_id
         LEFT JOIN fin_centros_custo cc ON cc.id = t.centro_custo_id
         LEFT JOIN empresas e ON e.id = t.empresa_id
         LEFT JOIN fin_contas c ON c.id = b.conta_id
        WHERE b.data_baixa BETWEEN $1 AND $2
        ORDER BY b.data_baixa, b.id`,
      [de, ate]
    );

    const cabecalho = ['Data', 'Natureza', 'Contraparte', 'Documento', 'Histórico', 'Categoria',
      'Conta contábil', 'Centro de custo', 'Empresa', 'Principal', 'Juros', 'Multa',
      'Desconto', 'Tarifa', 'Conta'];
    const escapa = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const linhas = rows.map((r) => [
      r.data instanceof Date ? r.data.toISOString().slice(0, 10) : r.data,
      r.natureza, r.contraparte, r.documento, r.descricao,
      `${r.categoria_codigo || ''} ${r.categoria || ''}`.trim(),
      r.conta_contabil, r.centro_custo, r.empresa,
      r.principal, r.juros, r.multa, r.desconto, r.tarifa, r.conta,
    ].map(escapa).join(';'));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="financeiro-${de}-a-${ate}.csv"`);
    res.send(`﻿${[cabecalho.map(escapa).join(';'), ...linhas].join('\n')}`);
  } catch (err) { next(err); }
});

// ============================================================ recorrências

router.get('/recorrencias', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, f.nome AS fornecedor_nome, p.nome AS plano_nome, e.nome AS empresa_nome
         FROM fin_recorrencias r
         LEFT JOIN fornecedores f ON f.id = r.fornecedor_id
         LEFT JOIN fin_plano p ON p.id = r.plano_id
         LEFT JOIN empresas e ON e.id = r.empresa_id
        WHERE r.ativo ORDER BY r.descricao`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/recorrencias', async (req, res, next) => {
  try {
    const { empresa_id, natureza, descricao, valor, dia_vencimento } = req.body || {};
    if (!empresa_id || !descricao || !dia_vencimento) {
      return res.status(400).json({ error: 'Informe empresa, descrição e dia de vencimento.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO fin_recorrencias
         (empresa_id, natureza, descricao, fornecedor_id, cliente_id, plano_id, centro_custo_id,
          valor, dia_vencimento, periodicidade, inicio, fim, observacao)
       VALUES ($1,COALESCE($2,'pagar'),$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'mensal'),
               COALESCE($11,CURRENT_DATE),$12,$13) RETURNING *`,
      [empresa_id, natureza || null, descricao, req.body.fornecedor_id || null, req.body.cliente_id || null,
       req.body.plano_id || null, req.body.centro_custo_id || null, valor, dia_vencimento,
       req.body.periodicidade || null, req.body.inicio || null, req.body.fim || null,
       req.body.observacao || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// Gera os títulos do mês a partir das recorrências ativas. Idempotente: roda
// duas vezes no mesmo mês e não duplica, porque `ultima_geracao` segura.
router.post('/recorrencias/gerar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const competencia = req.body?.competencia || new Date().toISOString().slice(0, 7);
    const [ano, mes] = competencia.split('-').map(Number);

    await client.query('BEGIN');
    const { rows: recs } = await client.query(
      // Comparação por MÊS, não por dia: uma recorrência cadastrada dia 9 vale
      // para a competência daquele mês inteiro. Comparar a data exata deixava
      // o próprio mês de fora — e a primeira parcela nunca era gerada.
      `SELECT * FROM fin_recorrencias
        WHERE ativo
          AND date_trunc('month', inicio) <= date_trunc('month', $1::date)
          AND (fim IS NULL OR date_trunc('month', fim) >= date_trunc('month', $1::date))
          AND (ultima_geracao IS NULL OR date_trunc('month', ultima_geracao) < date_trunc('month', $1::date))`,
      [`${competencia}-01`]
    );

    const criados = [];
    for (const r of recs) {
      // Dia 31 em mês de 30: cai no último dia do mês, nunca "pula" para o
      // mês seguinte.
      const ultimoDia = new Date(ano, mes, 0).getDate();
      const dia = Math.min(r.dia_vencimento, ultimoDia);
      const venc = `${competencia}-${String(dia).padStart(2, '0')}`;

      const titulo = await criarTitulo(client, {
        empresa_id: r.empresa_id, natureza: r.natureza,
        fornecedor_id: r.fornecedor_id, cliente_id: r.cliente_id,
        descricao: r.descricao, plano_id: r.plano_id, centro_custo_id: r.centro_custo_id,
        data_competencia: `${competencia}-01`, data_vencimento: venc,
        valor_bruto: r.valor, origem_tipo: 'recorrente', origem_id: r.id,
        usuarioId: req.user?.id || null,
      });
      criados.push(titulo);
      await client.query('UPDATE fin_recorrencias SET ultima_geracao = $1 WHERE id = $2', [venc, r.id]);
    }

    await client.query('COMMIT');
    res.status(201).json({ competencia, gerados: criados.length, titulos: criados });
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

module.exports = router;
