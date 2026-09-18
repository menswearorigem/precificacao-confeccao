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
const { sincronizarFinanceiroAgora, travarTitulo } = require('../lib/wikFinanceiroSync');

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

// A conta bancária existia no banco desde a migration 0055 e era criada só
// por POST solto ou pela sincronização do Wik — não havia tela nenhuma para
// cadastrar, corrigir um saldo inicial digitado errado ou desativar uma conta
// encerrada. A sub-aba Financeiro › Contas Bancárias (10/09/2026) usa estas
// rotas. `wik_grp_id` vai junto porque conta que vem do Wik é sobrescrita a
// cada sincronização: a tela precisa avisar isso e travar o que não adianta
// editar.
// `s.conta_id AS id` existe porque a view chama a chave de `conta_id` e o
// POST antigo devolvia a linha crua de `fin_contas`, cuja chave é `id` — quem
// já consumia o retorno do POST (e os testes) lê `.id`. Os dois nomes saem
// juntos: nada que já funcionava precisa mudar de campo.
const COLUNAS_CONTA = `s.*, s.conta_id AS id, c.banco_codigo, c.banco_nome, c.agencia, c.conta,
         c.ativo, c.saldo_inicial_data, c.wik_grp_id, c.wik_tipo, c.cedente, c.carteira,
         c.nosso_numero_ini, c.nosso_numero_fin, c.conta_matriz, c.wik_dados, e.nome AS empresa_nome`;

router.get('/contas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUNAS_CONTA}
         FROM vw_fin_saldo_conta s
         JOIN fin_contas c ON c.id = s.conta_id
         LEFT JOIN empresas e ON e.id = s.empresa_id
        ${req.query.todas === 'true' ? '' : 'WHERE c.ativo'}
        ORDER BY e.nome, s.nome`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

async function lerConta(id) {
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_CONTA}
       FROM vw_fin_saldo_conta s
       JOIN fin_contas c ON c.id = s.conta_id
       LEFT JOIN empresas e ON e.id = s.empresa_id
      WHERE s.conta_id = $1`, [id]
  );
  return rows[0] || null;
}

// Só o que a tela pode gravar. Empresa fica de fora de propósito: mudar a
// empresa de uma conta que já tem extrato e baixa lançados jogaria histórico
// de um CNPJ no outro.
const CAMPOS_CONTA = ['nome', 'tipo', 'banco_codigo', 'banco_nome', 'agencia',
  'conta', 'saldo_inicial', 'saldo_inicial_data', 'ativo'];

function normalizarConta(body) {
  const saida = {};
  for (const campo of CAMPOS_CONTA) {
    if (body[campo] === undefined) continue;
    let valor = body[campo];
    if (valor === '') valor = null;
    if (campo === 'saldo_inicial') valor = Number(valor) || 0;
    if (campo === 'ativo') valor = Boolean(valor);
    saida[campo] = valor;
  }
  return saida;
}

router.post('/contas', async (req, res, next) => {
  try {
    const { empresa_id, nome, tipo, banco_codigo, banco_nome, agencia, conta,
            saldo_inicial = 0, saldo_inicial_data } = req.body || {};
    if (!empresa_id || !nome) return res.status(400).json({ error: 'Informe a empresa e o nome da conta.' });
    const { rows } = await pool.query(
      `INSERT INTO fin_contas
         (empresa_id, nome, tipo, banco_codigo, banco_nome, agencia, conta, saldo_inicial, saldo_inicial_data)
       VALUES ($1,$2,COALESCE($3,'bancaria'),$4,$5,$6,$7,$8,$9) RETURNING id`,
      [empresa_id, nome, tipo || null, banco_codigo || null, banco_nome || null,
       agencia || null, conta || null, Number(saldo_inicial) || 0, saldo_inicial_data || null]
    );
    res.status(201).json(await lerConta(rows[0].id));
  } catch (err) { next(err); }
});

router.put('/contas/:id', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: 'Conta inválida.' });
    const atual = await lerConta(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Conta não encontrada.' });

    const dados = normalizarConta(req.body || {});
    if (dados.nome !== undefined && !String(dados.nome || '').trim()) {
      return res.status(400).json({ error: 'A conta precisa de um nome.' });
    }
    const campos = Object.keys(dados);
    if (campos.length > 0) {
      await pool.query(
        `UPDATE fin_contas SET ${campos.map((c, i) => `${c} = $${i + 1}`).join(', ')}
          WHERE id = $${campos.length + 1}`,
        [...campos.map((c) => dados[c]), req.params.id]
      );
    }
    res.json(await lerConta(req.params.id));
  } catch (err) { next(err); }
});

// Conta com extrato ou baixa NÃO é excluída — é desativada. Apagar levaria
// junto o extrato conciliado (a FK do extrato é ON DELETE CASCADE) e o
// histórico de pagamento pararia de bater com o DRE do mês fechado.
router.delete('/contas/:id', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(400).json({ error: 'Conta inválida.' });
    const atual = await lerConta(req.params.id);
    if (!atual) return res.status(404).json({ error: 'Conta não encontrada.' });

    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM fin_extrato_bancario WHERE conta_id = $1)::int AS extrato,
              (SELECT COUNT(*) FROM fin_baixas          WHERE conta_id = $1)::int AS baixas`,
      [req.params.id]
    );
    const usos = rows[0].extrato + rows[0].baixas;
    if (usos > 0) {
      return res.status(409).json({
        error: `"${atual.nome}" já tem ${rows[0].extrato} lançamento(s) de extrato e ${rows[0].baixas} baixa(s) `
          + 'no nome dela. Em vez de excluir, desative a conta — assim o extrato conciliado e os meses '
          + 'já fechados continuam batendo.',
      });
    }
    await pool.query('DELETE FROM fin_contas WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================================================================= títulos

// Teto da LISTA — não dos totais. Até 14/09/2026 a rota devolvia a lista
// truncada em 1.000 e mais nada: com 1.200 recebíveis somando R$ 120.000 a
// aba Contas a Receber mostrava R$ 100.000 (ela soma o que recebeu) enquanto
// o DRE, que soma no banco, mostrava R$ 120.000. Duas telas do mesmo módulo
// discordando em R$ 20.000, sem um aviso sequer. Os totais passam a vir
// agregados em SQL e a lista passa a dizer quando foi cortada.
const LIMITE_LISTA_TITULOS = 1000;

// O que entra na soma. O título marcado como duplicado (0069) sai do DRE e do
// fluxo de caixa desde então — mas as duas rotas abaixo somavam tudo, e o
// financeiro via R$ 7.000 em Contas a Receber para os R$ 3.500 que o DRE já
// mostrava certos. Marcar duplicidade tem que valer nas quatro telas, não em
// duas.
const CONTA_NO_TOTAL = `t.situacao <> 'cancelado' AND s.saldo_aberto > 0 AND t.wik_duplicado_de_id IS NULL`;
const MARCADO_DUPLICADO = `t.situacao <> 'cancelado' AND s.saldo_aberto > 0 AND t.wik_duplicado_de_id IS NOT NULL`;

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

    // As duas consultas usam EXATAMENTE o mesmo FROM e o mesmo WHERE: a
    // primeira devolve a lista (truncada), a segunda soma o conjunto inteiro
    // no banco. Separá-las é o ponto todo — ver o comentário dos totais.
    const de = `FROM fin_titulos t
         JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
         LEFT JOIN fornecedores f ON f.id = t.fornecedor_id
         LEFT JOIN clientes cl ON cl.id = t.cliente_id
         LEFT JOIN fin_plano p ON p.id = t.plano_id
         LEFT JOIN fin_centros_custo cc ON cc.id = t.centro_custo_id
         LEFT JOIN empresas e ON e.id = t.empresa_id
         ${where}`;

    const [lista, agregado] = await Promise.all([
      pool.query(
        // `entra_no_total` viaja junto com a linha porque o título marcado
        // como duplicado CONTINUA visível — é o que a 0069 promete — e só
        // não pode ser somado. Quem esconde a linha esconde também o erro.
        `SELECT t.*, s.valor_retido, s.valor_liquido, s.valor_baixado, s.saldo_aberto, s.dias_atraso,
                f.nome AS fornecedor_nome, cl.nome AS cliente_nome,
                p.nome AS plano_nome, p.codigo AS plano_codigo,
                cc.nome AS centro_custo_nome, e.nome AS empresa_nome,
                (t.situacao <> 'cancelado'
                 AND s.saldo_aberto > 0
                 AND t.wik_duplicado_de_id IS NULL) AS entra_no_total
           ${de}
           ORDER BY t.data_vencimento, t.id
           LIMIT ${LIMITE_LISTA_TITULOS}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::INT AS linhas,
                COALESCE(SUM(s.saldo_aberto) FILTER (WHERE ${CONTA_NO_TOTAL}), 0) AS aberto,
                COUNT(*) FILTER (WHERE ${CONTA_NO_TOTAL})::INT AS aberto_titulos,
                COALESCE(SUM(s.saldo_aberto) FILTER (WHERE ${CONTA_NO_TOTAL} AND s.dias_atraso > 0), 0) AS vencido,
                COUNT(*) FILTER (WHERE ${CONTA_NO_TOTAL} AND s.dias_atraso > 0)::INT AS vencido_titulos,
                COALESCE(SUM(s.saldo_aberto) FILTER (
                  WHERE ${CONTA_NO_TOTAL}
                    AND t.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7), 0) AS a_vencer_7,
                COUNT(*) FILTER (
                  WHERE ${CONTA_NO_TOTAL}
                    AND t.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::INT AS a_vencer_7_titulos,
                COALESCE(SUM(s.saldo_aberto) FILTER (WHERE ${MARCADO_DUPLICADO}), 0) AS duplicado,
                COUNT(*) FILTER (WHERE ${MARCADO_DUPLICADO})::INT AS duplicado_titulos,
                MAX(s.dias_atraso) FILTER (WHERE ${CONTA_NO_TOTAL}) AS pior_atraso
           ${de}`,
        params
      ),
    ]);

    const a = agregado.rows[0];
    res.json({
      titulos: lista.rows,
      // Truncar a lista sem dizer é mentir sobre o total — a tela avisa. É o
      // mesmo `listaTruncada` que a aba Movimentação já usa.
      listaTruncada: lista.rows.length === LIMITE_LISTA_TITULOS,
      limiteLista: LIMITE_LISTA_TITULOS,
      totais: {
        aberto: Number(a.aberto),
        abertoTitulos: a.aberto_titulos,
        vencido: Number(a.vencido),
        vencidoTitulos: a.vencido_titulos,
        aVencer7: Number(a.a_vencer_7),
        aVencer7Titulos: a.a_vencer_7_titulos,
        // Fora dos totais acima, mas NUNCA escondido: a tela mostra o que
        // ficou de fora por ter sido marcado como duplicado.
        duplicado: Number(a.duplicado),
        duplicadoTitulos: a.duplicado_titulos,
        piorAtraso: a.pior_atraso === null ? null : Number(a.pior_atraso),
        linhas: a.linhas,
      },
    });
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
    // Decisão do dono (10/09/2026): "Edita e trava a sincronização". Cancelar
    // aqui é uma edição — o Wik não sobrescreve mais este título.
    await travarTitulo(req.params.id, req.user?.id, 'cancelado no Hub');
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
    // Baixou aqui dentro: o Wik para de mexer neste título. Fica FORA da
    // transação de propósito — a trava é metadado da integração, e falhar nela
    // não pode desfazer um pagamento que já foi registrado.
    await travarTitulo(req.params.id, req.user?.id, 'baixado no Hub');
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
    // `estornarBaixa` devolve { baixa, situacao } — o título vem dentro da baixa.
    const tituloEstornado = r && r.baixa && r.baixa.titulo_id;
    if (tituloEstornado) await travarTitulo(tituloEstornado, req.user?.id, 'estornado no Hub');
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
        `UPDATE fin_extrato_bancario SET baixa_id = $1, conciliado_em = now(), conciliado_por = $2,
                wik_travado = TRUE
          WHERE id = $3`,
        [r.baixa.id, req.user?.id || null, req.params.id]
      );
    } else if (plano_id) {
      // Conciliar é uma decisão humana sobre a linha: o Wik não a sobrescreve
      // mais (0069, "Edita e trava a sincronização").
      await client.query(
        `UPDATE fin_extrato_bancario SET plano_id = $1, conciliado_em = now(), conciliado_por = $2,
                wik_travado = TRUE
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
    // Conciliar contra um título é baixá-lo: o título também sai do alcance do
    // Wik. Fora da transação pelo mesmo motivo da rota de baixa — a trava é
    // metadado da integração e não pode desfazer uma conciliação já gravada.
    if (titulo_id) await travarTitulo(titulo_id, req.user?.id, 'conciliado no Hub');
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
      // `wik_duplicado_de_id IS NULL` pelo mesmo motivo da rota de títulos: o
      // DRE e o fluxo de caixa já ignoram o título marcado como duplicado
      // desde a 0069, e o aging não ignorava. Com dois títulos de R$ 3.500
      // para a mesma venda e um deles marcado, o DRE mostrava R$ 3.500 e esta
      // rota R$ 7.000 — o mesmo dinheiro, duas respostas.
      `SELECT a.faixa,
              COUNT(*) AS titulos,
              SUM(a.saldo_aberto) AS valor
         FROM vw_fin_aging a
         JOIN fin_titulos t ON t.id = a.titulo_id
        WHERE a.natureza = $1 AND a.saldo_aberto > 0
          AND t.wik_duplicado_de_id IS NULL
        GROUP BY a.faixa
        ORDER BY CASE a.faixa
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

// ============================================ importação do financeiro do Wik
// Fica AQUI, dentro do módulo Financeiro, e não num módulo próprio: o pedido
// foi "como se fosse um cadastro normal de cada aba já existente". Não há tela
// nova — estes endpoints alimentam o cartão de status dentro das telas que já
// existem e o botão de sincronizar agora.

router.get('/wik/status', async (req, res, next) => {
  try {
    const [{ rows: integ }, { rows: empresas }, { rows: contagem }] = await Promise.all([
      pool.query(`SELECT id, financeiro_ativo, financeiro_status, financeiro_erro, financeiro_resumo,
                         financeiro_ultima_sincronizacao, financeiro_dias_retro,
                         financeiro_carga_inicial_ate, financeiro_carga_inicial_fim,
                         financeiro_carga_inicial_desde, web_job_ativo, web_usuario
                    FROM integracoes_wik ORDER BY id LIMIT 1`),
      pool.query('SELECT id, nome, wik_emp_id, ativo FROM empresas ORDER BY ordem, id'),
      pool.query(`SELECT natureza,
                         COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE wik_travado)::int AS travados
                    FROM fin_titulos WHERE wik_id IS NOT NULL GROUP BY natureza`),
    ]);
    const { rows: extrato } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM fin_extrato_bancario WHERE wik_ext_id IS NOT NULL'
    );
    const { rows: dup } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM vw_fin_titulos_duplicados WHERE NOT ja_resolvido'
    );
    res.json({
      integracao: integ[0] || null,
      empresas,
      semMapa: empresas.filter((e) => e.ativo && !e.wik_emp_id).map((e) => e.nome),
      titulos: contagem,
      extrato: extrato[0]?.total || 0,
      duplicados: dup[0]?.total || 0,
    });
  } catch (err) { next(err); }
});

// Liga/desliga e ajusta a janela. Sem isto ligado, o job não roda — a
// importação nasce DESLIGADA de propósito: puxar o histórico inteiro do
// financeiro de um ERP é decisão de gente, não default de migration.
router.put('/wik/config', async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE integracoes_wik
          SET financeiro_ativo = COALESCE($1, financeiro_ativo),
              financeiro_dias_retro = COALESCE($2, financeiro_dias_retro),
              financeiro_carga_inicial_desde = COALESCE($3, financeiro_carga_inicial_desde)
        WHERE id = (SELECT id FROM integracoes_wik ORDER BY id LIMIT 1)
        RETURNING id, financeiro_ativo, financeiro_dias_retro, financeiro_carga_inicial_desde`,
      [typeof b.ativo === 'boolean' ? b.ativo : null,
        Number.isFinite(Number(b.dias_retro)) && b.dias_retro !== null ? Number(b.dias_retro) : null,
        b.carga_desde || null]
    );
    if (!rows[0]) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// O mapa empresa do Hub -> empresa do Wik (192/193/198/202). Sem ele o job
// pula a empresa em vez de chutar CNPJ.
router.put('/wik/empresas/:id', async (req, res, next) => {
  try {
    const valor = req.body?.wik_emp_id === null || req.body?.wik_emp_id === ''
      ? null : Number(req.body.wik_emp_id);
    if (valor !== null && !Number.isFinite(valor)) {
      return res.status(400).json({ error: 'Id de empresa do Wik inválido.' });
    }
    const { rows } = await pool.query(
      'UPDATE empresas SET wik_emp_id = $1 WHERE id = $2 RETURNING id, nome, wik_emp_id',
      [valor, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Esse Id de empresa do Wik já está em outra empresa.' });
    }
    next(err);
  }
});

// Roda um ciclo agora, sem esperar o próximo. Devolve 409 quando a sessão web
// já está ocupada pelo job de produção — é UMA sessão só (ver 0069).
router.post('/wik/sincronizar', async (req, res, next) => {
  try {
    const r = await sincronizarFinanceiroAgora({ forcarCadastros: req.body?.cadastros === true });
    if (r && r.pulado) return res.status(409).json({ error: r.pulado });
    res.json(r);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ── Testar o caminho do Wik ────────────────────────────────────────────────
// Diagnóstico de UMA página, para acabar com o chute sobre a "sessão
// derrubada". Faz o mínimo possível — um login, e por empresa algumas leituras
// curtas do contas a pagar — e responde, em português, o que REALMENTE
// acontece.
//
// ⚠️ REESCRITO NO CHECAPE DE 18/09/2026. A versão anterior tinha três defeitos,
// e os três apareciam juntos na tela:
//
//   1. Contava LINHA, não conteúdo. O Wik devolve HTTP 200 com N linhas de
//      `CtaId = 0` e todos os campos nulos — lixo. O diagnóstico via "9 linhas"
//      e dizia "funcionou".
//   2. Concluía, quando o caminho sem troca lia e o com troca não, que a
//      resposta era **definir `WIK_FIN_TROCA_EMPRESA=0`**. Está medido que o
//      `EmpId` do contas a pagar é IGNORADO pelo Wik: sem a troca de empresa,
//      o Hub grava os títulos da MATRIZ carimbados como se fossem de cada
//      CNPJ — dívida duplicada, Simples Nacional misturado com Lucro Real.
//      Era o conselho mais caro do sistema.
//   3. Usava o endpoint de troca que devolve HTTP 500 nesta instalação — e o
//      500 deixa a sessão SEM empresa ativa, então todas as leituras seguintes
//      também davam 500 e o diagnóstico culpava a leitura.
//
// Agora: conta só linha com `CtaId > 0`, compara as listas entre empresas (se
// vierem iguais, o filtro não separa), refaz o login quando a troca falha (para
// os passos seguintes valerem alguma coisa) e nunca recomenda desligar a troca.
//
// Só leitura: não grava nada no Hub nem no Wik.
router.post('/wik/diagnostico', async (req, res) => {
  const wikWeb = require('../lib/wikWeb');
  const { obterSessao, renovarSessao } = require('../lib/wikWebSessao');
  const MATRIZ_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);
  const passos = [];
  const anota = (o) => { passos.push(o); return o; };
  // Assinatura do lote: se duas empresas devolverem a mesma, não houve
  // separação nenhuma — foi a mesma lista duas vezes.
  const assinatura = (linhas) => {
    const ids = linhas.map((l) => Number(l.CtaId) || 0).filter((n) => n > 0);
    return `${ids.length}:${ids.slice(0, 10).join(',')}`;
  };
  const validas = (linhas) => linhas.filter((l) => Number(l.CtaId) > 0);

  try {
    const { rows: ints } = await pool.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
    const integracao = ints[0];
    if (!integracao || !integracao.ativo) {
      return res.status(409).json({ error: 'A integração com o Wik não está ativa.' });
    }
    const { rows: empresas } = await pool.query(
      'SELECT id, nome, wik_emp_id FROM empresas WHERE ativo AND wik_emp_id IS NOT NULL ORDER BY ordem, id'
    );
    if (!empresas.length) {
      return res.status(409).json({ error: 'Nenhuma empresa com Id do Wik configurado.' });
    }

    const hoje = new Date().toISOString().slice(0, 10);
    const de = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    let sessao;
    try {
      sessao = await obterSessao(integracao);
      anota({ passo: 'login', ok: true, detalhe: 'A sessão web do Wik abriu.' });
    } catch (e) {
      anota({ passo: 'login', ok: false, detalhe: e.message });
      return res.json({ conclusao: 'Nem o login funcionou — o problema é a credencial, não o caminho.', passos });
    }

    // A descrição e a matriz que a troca de empresa espera são as DO WIK, não as
    // do cadastro do Hub — o combo é a mesma chamada que a tela deles faz.
    const comboWik = new Map();
    try {
      for (const e of await wikWeb.listarEmpresas(sessao)) comboWik.set(Number(e.id), e);
      anota({ passo: 'ler a lista de empresas do Wik', ok: true, detalhe: [...comboWik.values()].map((e) => `${e.id} ${e.nome}`).join(' · ') });
    } catch (e) {
      anota({ passo: 'ler a lista de empresas do Wik', ok: false, detalhe: e.message });
    }

    const porEmpresa = new Map();   // wik_emp_id -> assinatura do lote lido DEPOIS de trocar
    let trocaFuncionou = false;
    let trocaRecusada = false;
    let leuAlgumaCoisa = false;
    let veioLixo = false;

    for (const emp of empresas) {
      // 1) A troca de empresa — é ela que escopa o contas a pagar no Wik.
      let trocou = false;
      try {
        const noWik = comboWik.get(Number(emp.wik_emp_id));
        trocou = await wikWeb.trocarEmpresa(sessao, emp.wik_emp_id, {
          descricao: (noWik && noWik.nome) || emp.nome,
          matriz: (noWik && noWik.matriz) || MATRIZ_EMP_ID,
        });
        anota({
          passo: `trocar a empresa da sessão para ${emp.nome}`,
          ok: trocou,
          detalhe: trocou ? 'aceitou' : 'o Wik recusou a troca nos três endereços conhecidos',
        });
      } catch (e) {
        anota({ passo: `trocar a empresa da sessão para ${emp.nome}`, ok: false, detalhe: e.message });
      }
      if (trocou) trocaFuncionou = true; else trocaRecusada = true;

      if (!trocou) {
        // O endpoint antigo devolve 500 e deixa a sessão sem empresa ativa —
        // dali em diante TODA leitura do contas a pagar dá 500. Sem refazer o
        // login, os passos seguintes não diriam nada sobre o Wik, só sobre a
        // sessão que este próprio teste estragou.
        try {
          sessao = await renovarSessao(integracao);
          anota({ passo: `refazer o login depois da troca recusada · ${emp.nome}`, ok: true, detalhe: 'sessão nova, para os próximos passos valerem' });
        } catch (e) {
          anota({ passo: `refazer o login depois da troca recusada · ${emp.nome}`, ok: false, detalhe: e.message });
        }
        continue;
      }

      // 2) A leitura, já com a empresa certa na sessão.
      try {
        const linhas = await wikWeb.contasPagar(sessao, { de, ate: hoje, tipoData: 2 });
        const boas = validas(linhas);
        if (linhas.length && !boas.length) {
          veioLixo = true;
          anota({
            passo: `contas a pagar · ${emp.nome}`,
            ok: false,
            linhas: 0,
            detalhe: `o Wik devolveu ${linhas.length} linha(s) VAZIAS (CtaId 0, todos os campos nulos) — não é título, é uma página de preenchimento`,
          });
        } else {
          if (boas.length) leuAlgumaCoisa = true;
          porEmpresa.set(emp.wik_emp_id, { nome: emp.nome, assinatura: assinatura(boas), n: boas.length });
          anota({ passo: `contas a pagar · ${emp.nome}`, ok: true, linhas: boas.length });
        }
      } catch (e) {
        anota({
          passo: `contas a pagar · ${emp.nome}`,
          ok: false,
          detalhe: e.sessaoExpirada ? 'o Wik devolveu a tela de login (HTTP 401 ou o formulário)' : e.message,
        });
      }
    }

    // 3) As listas das empresas são as mesmas? Então não houve separação.
    const listas = [...porEmpresa.values()].filter((x) => x.n > 0);
    const iguais = listas.length > 1 && new Set(listas.map((x) => x.assinatura)).size === 1;
    if (listas.length > 1) {
      anota({
        passo: 'as empresas devolveram listas diferentes?',
        ok: !iguais,
        detalhe: iguais
          ? `NÃO: ${listas.map((x) => `${x.nome} ${x.n}`).join(' · ')} — a mesma lista para todas, ou seja, a sessão não trocou de verdade`
          : `sim: ${listas.map((x) => `${x.nome} ${x.n}`).join(' · ')}`,
      });
    }

    let conclusao;
    if (iguais) {
      conclusao = 'A troca de empresa foi aceita, mas as empresas devolveram A MESMA lista de títulos — '
        + 'ou seja, a sessão continuou na mesma empresa. Importar assim gravaria a dívida de um CNPJ dentro do outro, '
        + 'então o sync PULA a segunda empresa em vez de duplicar. Isso é assunto para o suporte da Wik.';
    } else if (!trocaFuncionou && trocaRecusada) {
      conclusao = 'O Wik recusou a troca da empresa da sessão em todos os endereços conhecidos '
        + '(/Login/AdicionarEmpresaNasessao e /Home/AtualizaEmpresaSessao). Sem a troca não dá para ler o contas a pagar '
        + 'de cada empresa: o filtro de empresa do grid é IGNORADO pelo Wik, então sem trocar viriam sempre os títulos '
        + 'da mesma empresa. NÃO defina WIK_FIN_TROCA_EMPRESA=0 — isso não conserta e ainda duplica a dívida entre os CNPJs. '
        + 'Abra chamado na Wik com este resultado.';
    } else if (veioLixo && !leuAlgumaCoisa) {
      conclusao = 'A sessão abriu e a troca de empresa funcionou, mas o Wik devolveu só linhas VAZIAS — '
        + 'essas empresas não têm título nenhum na janela testada (30 dias). Provavelmente o financeiro do grupo está '
        + 'lançado em outra empresa do Wik (a matriz), que ainda não está mapeada em Empresas aqui no Hub.';
    } else if (leuAlgumaCoisa) {
      conclusao = 'O caminho está funcionando: login, troca de empresa e leitura do contas a pagar, com títulos de verdade. '
        + 'Se a tela ainda estiver vazia, o que falta é rodar a importação (botão "Sincronizar agora") ou esperar o próximo ciclo.';
    } else {
      conclusao = 'O login abre mas nenhuma leitura do contas a pagar passou. As causas, nesta ordem: alguém entrou no Wik '
        + 'com o MESMO usuário do Hub (o Wik só permite uma sessão por login); o usuário não tem permissão de financeiro no Wik; '
        + 'ou o Wik está instável agora. Tente de novo em alguns minutos antes de mexer em configuração.';
    }
    res.json({ conclusao, passos });
  } catch (err) {
    res.status(502).json({ error: err.message, passos });
  }
});

// A fila de conferência de duplicidade. É SUGESTÃO: nada é fundido sozinho.
router.get('/wik/duplicados', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM vw_fin_titulos_duplicados
        WHERE NOT ja_resolvido
        ORDER BY vencimento_wik DESC, valor_bruto DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Marca um título como "é o mesmo fato que aquele outro". O marcado sai do DRE
// e do fluxo, mas NÃO some da tela e NÃO é apagado — dá para desfazer mandando
// duplicado_de = null.
router.post('/titulos/:id/duplicado', async (req, res, next) => {
  try {
    const alvo = req.body?.duplicado_de === null || req.body?.duplicado_de === ''
      ? null : Number(req.body.duplicado_de);
    if (alvo !== null && !Number.isFinite(alvo)) {
      return res.status(400).json({ error: 'Informe o título que representa o mesmo fato.' });
    }
    if (alvo !== null && Number(alvo) === Number(req.params.id)) {
      return res.status(400).json({ error: 'Um título não pode ser duplicata dele mesmo.' });
    }
    const { rows } = await pool.query(
      'UPDATE fin_titulos SET wik_duplicado_de_id = $1, atualizado_em = now() WHERE id = $2 RETURNING id, wik_duplicado_de_id',
      [alvo, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Título não encontrado.' });
    // Marcar duplicidade é decisão humana sobre o registro: trava também.
    if (alvo !== null) await travarTitulo(req.params.id, req.user?.id, 'marcado como duplicado');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
