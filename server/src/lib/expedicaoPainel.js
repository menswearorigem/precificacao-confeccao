// As leituras da tela de Expedição (Marketplace › Romaneio), 28/09/2026.
//
// Tudo aqui lê `pedido_envio` (o que a plataforma disse) e a Conferência (a
// hora em que a casa bipou a caixa). Nada é estimado: onde a plataforma não
// informou, a resposta diz que não informou (REGRA 2).
//
// Dia sempre no fuso de Brasília — o servidor roda em UTC.

const pool = require('../db/pool');
const { hojeEmBrasilia } = require('./dataBrasil');
const { ALMOCO, cruzaAlmoco, minutosDoDia } = require('./expedicaoEnvio');

const FUSO = 'America/Sao_Paulo';
const DIA = (col) => `(${col} AT TIME ZONE '${FUSO}')::date`;
const HORA = (col) => `to_char(${col} AT TIME ZONE '${FUSO}', 'HH24:MI')`;
const CANAIS = ['mercado_livre', 'shopee', 'tiktok_shop'];
const ROTULO = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein' };

// A hora "de verdade" em que o pedido saiu, e de onde ela veio.
const SAIDA = 'COALESCE(pe.enviado_em, r.coletado_em, pe.enviado_detectado_em)';
const SAIDA_FONTE = `CASE WHEN pe.enviado_em IS NOT NULL THEN 'plataforma'
                          WHEN r.coletado_em IS NOT NULL THEN 'romaneio'
                          WHEN pe.enviado_detectado_em IS NOT NULL THEN 'detectado' END`;

function diaValido(dia) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dia || '')) ? String(dia) : hojeEmBrasilia();
}

function diaDaSemana(diaIso) {
  // 12:00 UTC evita virar o dia por fuso.
  return new Date(`${diaIso}T12:00:00Z`).getUTCDay();
}

function mediana(numeros) {
  const v = numeros.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

function hhmm(minutos) {
  if (minutos === null || minutos === undefined) return null;
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

async function lojas() {
  const { rows } = await pool.query(
    `SELECT im.id, im.nome, im.marketplace, im.ativo, ses.ultima_execucao, ses.ultimo_erro,
            ses.agenda_erro, ses.agenda_consultada_em
       FROM integracoes_marketplace im
       LEFT JOIN expedicao_sync_estado ses ON ses.origem_integracao_id = im.id
      WHERE im.marketplace = ANY($1) AND im.ativo
      ORDER BY array_position($1::text[], im.marketplace::text), im.nome`,
    [CANAIS]
  );
  return rows;
}

async function cortes() {
  const { rows } = await pool.query(`SELECT lower(canal) AS canal, to_char(horario_corte, 'HH24:MI') AS corte FROM expedicao_prazos`);
  return Object.fromEntries(rows.map((r) => [r.canal, r.corte]));
}

async function agendas() {
  const { rows } = await pool.query('SELECT * FROM expedicao_agenda WHERE modalidade = $1', ['coleta']);
  const por = new Map();
  for (const a of rows) por.set(`${a.origem_integracao_id}:${a.dia_semana}`, a);
  return por;
}

// Primeira e última saída registrada pela PLATAFORMA, por loja e dia — é o
// bipe do motorista. Só modalidade coleta (ou sem modalidade informada): o
// que foi postado em agência não diz quando o caminhão passou.
async function passagens({ desde, ate }) {
  const { rows } = await pool.query(
    `SELECT pe.origem_integracao_id, ${DIA('pe.enviado_em')}::text AS dia,
            ${HORA('MIN(pe.enviado_em)')} AS primeira, ${HORA('MAX(pe.enviado_em)')} AS ultima,
            COUNT(*)::int AS pacotes
       FROM pedido_envio pe
      WHERE pe.enviado_em IS NOT NULL
        AND COALESCE(pe.modalidade, 'coleta') = 'coleta'
        AND ${DIA('pe.enviado_em')} BETWEEN $1::date AND $2::date
      GROUP BY 1, 2`,
    [desde, ate]
  );
  const por = new Map();
  for (const r of rows) por.set(`${r.origem_integracao_id}:${r.dia}`, r);
  return por;
}

// ---------------------------------------------------------------- hoje
async function painelHoje() {
  const hoje = hojeEmBrasilia();
  const dow = diaDaSemana(hoje);
  const [ls, corte, agenda] = await Promise.all([lojas(), cortes(), agendas()]);
  const desde = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
  const pas = await passagens({ desde, ate: hoje });

  const { rows: cont } = await pool.query(
    `SELECT origem_integracao_id,
            COUNT(*) FILTER (WHERE situacao_coleta <> 'coletado')::int AS pendentes,
            COUNT(*) FILTER (WHERE situacao_coleta = 'atrasado')::int AS atrasados,
            COUNT(*) FILTER (WHERE situacao_coleta = 'apertado')::int AS vencem_hoje,
            COUNT(*) FILTER (WHERE situacao_coleta = 'no_prazo')::int AS no_prazo,
            COUNT(*) FILTER (WHERE situacao_coleta = 'sem_prazo')::int AS sem_prazo,
            COUNT(*) FILTER (WHERE situacao_coleta <> 'coletado' AND conferido_em IS NOT NULL)::int AS conferidos_esperando,
            MIN(coletar_ate) FILTER (WHERE situacao_coleta IN ('apertado','no_prazo')) AS proximo_prazo
       FROM vw_expedicao_coleta GROUP BY 1`
  );
  const contPor = new Map(cont.map((c) => [c.origem_integracao_id, c]));

  const { rows: env } = await pool.query(
    `SELECT pe.origem_integracao_id, COUNT(*)::int AS enviados
       FROM pedido_envio pe
       LEFT JOIN romaneio_pedidos rp ON rp.pedido_id = pe.pedido_id AND rp.liberado_em IS NULL
       LEFT JOIN romaneios r ON r.id = rp.romaneio_id
      WHERE ${DIA(SAIDA)} = $1::date
      GROUP BY 1`,
    [hoje]
  );
  const envPor = new Map(env.map((e) => [e.origem_integracao_id, e.enviados]));

  const cartoes = ls.map((l) => {
    const c = contPor.get(l.id) || {};
    const ag = agenda.get(`${l.id}:${dow}`) || null;
    // Horário típico: mediana da PRIMEIRA passagem dos últimos 14 dias.
    const historico = [];
    for (let i = 1; i <= 14; i += 1) {
      const d = new Date(Date.now() - i * 86400000);
      const iso = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(d);
      const p = pas.get(`${l.id}:${iso}`);
      if (p) historico.push({ dia: iso, primeira: p.primeira });
    }
    const passouHoje = pas.get(`${l.id}:${hoje}`) || null;
    const tipico = hhmm(mediana(historico.map((h) => minutosDoDia(h.primeira))));
    const janelaAgenda = ag && ag.trabalha ? { corte: ag.corte, de: ag.janela_de, ate: ag.janela_ate } : null;
    const alertaAlmoco = Boolean(
      (janelaAgenda && janelaAgenda.de && cruzaAlmoco(janelaAgenda.de, janelaAgenda.ate))
      || (passouHoje && cruzaAlmoco(passouHoje.primeira))
      || (!janelaAgenda && tipico && cruzaAlmoco(tipico))
    );
    return {
      integracao_id: l.id,
      loja: l.nome,
      canal: l.marketplace,
      canal_rotulo: ROTULO[l.marketplace],
      pendentes: c.pendentes || 0,
      atrasados: c.atrasados || 0,
      vencem_hoje: c.vencem_hoje || 0,
      no_prazo: c.no_prazo || 0,
      sem_prazo: c.sem_prazo || 0,
      conferidos_esperando: c.conferidos_esperando || 0,
      proximo_prazo: c.proximo_prazo || null,
      corte_casa: corte[l.marketplace] || null,
      agenda_hoje: janelaAgenda,
      agenda_trabalha_hoje: ag ? ag.trabalha : null,
      agenda_erro: l.agenda_erro || null,
      passou_hoje: passouHoje,
      passou_ultima: historico[0] || null,
      horario_tipico: tipico,
      dias_com_passagem: historico.length,
      alerta_almoco: alertaAlmoco,
      enviados_hoje: envPor.get(l.id) || 0,
      sync: { ultima_execucao: l.ultima_execucao, ultimo_erro: l.ultimo_erro },
    };
  });

  // Pedidos sem loja (vieram de planilha): não dá para perguntar à plataforma.
  const semLoja = cont.find((c) => c.origem_integracao_id === null);
  return {
    hoje, agora: new Date().toISOString(), almoco: ALMOCO, cortes: corte,
    shein: { integrada: false, corte_casa: corte.shein || null },
    cartoes,
    sem_loja: semLoja ? { pendentes: semLoja.pendentes } : null,
  };
}

// ---------------------------------------------------------------- pendências
async function pendencias({ integracoes = [], situacao = null } = {}) {
  const cond = ["situacao_coleta <> 'coletado'"];
  const params = [];
  if (integracoes.length) { params.push(integracoes); cond.push(`origem_integracao_id = ANY($${params.length}::int[])`); }
  if (situacao) { params.push(situacao); cond.push(`situacao_coleta = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT v.*, EXTRACT(EPOCH FROM (v.coletar_ate - now()))::int / 60 AS falta_min
       FROM vw_expedicao_coleta v
      WHERE ${cond.join(' AND ')}
      ORDER BY CASE situacao_coleta WHEN 'atrasado' THEN 0 WHEN 'apertado' THEN 1 WHEN 'no_prazo' THEN 2 ELSE 3 END,
               coletar_ate NULLS LAST, faturado_em
      LIMIT 800`,
    params
  );
  // Cancelado depois de embalado: a caixa está na mesa e não deve sair.
  const { rows: cancelados } = await pool.query(
    `SELECT p.id AS pedido_id, p.numero, p.origem_pedido_id, p.origem_marketplace AS canal, im.nome AS loja,
            conf.conferido_em, COALESCE(pe.cancelado_em, p.cancelado_em) AS cancelado_em
       FROM pedidos_venda p
       JOIN LATERAL (SELECT MIN(concluida_em) AS conferido_em FROM conferencias_pedido
                      WHERE pedido_id = p.id AND situacao = 'concluida') conf ON conf.conferido_em IS NOT NULL
       LEFT JOIN pedido_envio pe ON pe.pedido_id = p.id
       LEFT JOIN integracoes_marketplace im ON im.id = p.origem_integracao_id
      WHERE p.origem_marketplace IS NOT NULL
        AND p.data_pedido >= CURRENT_DATE - 7
        AND (p.situacao = 'cancelado' OR p.cancelado_em IS NOT NULL OR pe.etapa = 'cancelado')
        AND pe.enviado_em IS NULL
      ORDER BY conf.conferido_em DESC LIMIT 100`
  );
  const resumo = { atrasado: 0, apertado: 0, no_prazo: 0, sem_prazo: 0, conferidos: 0 };
  for (const r of rows) {
    resumo[r.situacao_coleta] = (resumo[r.situacao_coleta] || 0) + 1;
    if (r.conferido_em) resumo.conferidos += 1;
  }
  return { itens: rows, resumo, cancelados_embalados: cancelados };
}

// ---------------------------------------------------------------- enviados
async function enviadosDoDia(diaParam) {
  const dia = diaValido(diaParam);
  const dow = diaDaSemana(dia);
  const [ls, agenda, pas] = await Promise.all([lojas(), agendas(), passagens({ desde: dia, ate: dia })]);
  const { rows } = await pool.query(
    `SELECT p.id AS pedido_id, p.numero, p.origem_pedido_id, p.origem_marketplace AS canal,
            p.origem_integracao_id, im.nome AS loja, pe.modalidade, pe.transportadora, pe.status_plataforma,
            pe.despachar_ate, ${SAIDA} AS saiu_em, ${SAIDA_FONTE} AS fonte,
            conf.conferido_em, COALESCE(pe.codigo_rastreio, p.codigos_rastreio[1]) AS rastreio,
            CASE WHEN pe.despachar_ate IS NULL THEN NULL ELSE ${SAIDA} <= pe.despachar_ate END AS no_prazo
       FROM pedido_envio pe
       JOIN pedidos_venda p ON p.id = pe.pedido_id
       LEFT JOIN integracoes_marketplace im ON im.id = p.origem_integracao_id
       LEFT JOIN romaneio_pedidos rp ON rp.pedido_id = p.id AND rp.liberado_em IS NULL
       LEFT JOIN romaneios r ON r.id = rp.romaneio_id
       LEFT JOIN LATERAL (SELECT MIN(concluida_em) AS conferido_em FROM conferencias_pedido
                           WHERE pedido_id = p.id AND situacao = 'concluida') conf ON TRUE
      WHERE ${DIA(SAIDA)} = $1::date
        AND COALESCE(pe.modalidade, '') <> 'full'
      ORDER BY saiu_em`,
    [dia]
  );
  const porLoja = ls.map((l) => {
    const itens = rows.filter((r) => r.origem_integracao_id === l.id);
    const ag = agenda.get(`${l.id}:${dow}`);
    const p = pas.get(`${l.id}:${dia}`);
    return {
      integracao_id: l.id, loja: l.nome, canal: l.marketplace,
      total: itens.length,
      no_prazo: itens.filter((i) => i.no_prazo === true).length,
      fora_do_prazo: itens.filter((i) => i.no_prazo === false).length,
      sem_conferencia: itens.filter((i) => !i.conferido_em).length,
      hora_aproximada: itens.filter((i) => i.fonte === 'detectado').length,
      passagem: p ? { primeira: p.primeira, ultima: p.ultima, pacotes: p.pacotes } : null,
      janela_prevista: ag && ag.trabalha ? { de: ag.janela_de, ate: ag.janela_ate, corte: ag.corte } : null,
      alerta_almoco: Boolean(p && cruzaAlmoco(p.primeira, p.ultima)),
    };
  });
  // Pacotes por hora do dia (para ver a curva do dia).
  const porHora = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: FUSO, hour: 'numeric', hour12: false }).format(new Date(r.saiu_em))) % 24;
    porHora[h] += 1;
  }
  return { dia, total: rows.length, por_loja: porLoja, por_hora: porHora, itens: rows };
}

// ---------------------------------------------------------------- coletas
async function historicoColetas(diasParam = 14) {
  const dias = Math.min(Math.max(Number(diasParam) || 14, 1), 60);
  const hoje = hojeEmBrasilia();
  const desde = new Date(Date.now() - (dias - 1) * 86400000);
  const desdeIso = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(desde);
  const [ls, agenda, pas] = await Promise.all([lojas(), agendas(), passagens({ desde: desdeIso, ate: hoje })]);
  const linhas = [];
  for (let i = 0; i < dias; i += 1) {
    const d = new Date(Date.now() - i * 86400000);
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(d);
    const dow = diaDaSemana(iso);
    for (const l of ls) {
      const p = pas.get(`${l.id}:${iso}`);
      const ag = agenda.get(`${l.id}:${dow}`);
      if (!p && !(ag && ag.trabalha)) continue;
      const janela = ag && ag.trabalha ? { de: ag.janela_de, ate: ag.janela_ate, corte: ag.corte } : null;
      let situacao = 'sem_janela';
      if (!p) situacao = iso === hoje ? 'aguardando' : 'nao_passou';
      else if (janela?.de && janela?.ate) {
        const m = minutosDoDia(p.primeira);
        situacao = m < minutosDoDia(janela.de) ? 'antes' : m > minutosDoDia(janela.ate) ? 'depois' : 'na_janela';
      }
      linhas.push({
        dia: iso, dia_semana: dow, integracao_id: l.id, loja: l.nome, canal: l.marketplace,
        janela, passou: p ? p.primeira : null, ultimo_bipe: p ? p.ultima : null, pacotes: p ? p.pacotes : 0,
        situacao, alerta_almoco: Boolean(p && cruzaAlmoco(p.primeira, p.ultima)),
      });
    }
  }
  return { dias, linhas };
}

// ---------------------------------------------------------------- indicadores
async function indicadores(diasParam = 30) {
  const dias = Math.min(Math.max(Number(diasParam) || 30, 7), 90);
  const { rows } = await pool.query(
    `WITH base AS (
       SELECT pe.origem_integracao_id, pe.canal, pe.modalidade, pe.despachar_ate,
              pe.pago_em, pe.enviado_em, conf.conferido_em
         FROM pedido_envio pe
         JOIN pedidos_venda p ON p.id = pe.pedido_id
         LEFT JOIN LATERAL (SELECT MIN(concluida_em) AS conferido_em FROM conferencias_pedido
                             WHERE pedido_id = p.id AND situacao = 'concluida') conf ON TRUE
        WHERE pe.enviado_em >= now() - make_interval(days => $1)
          AND COALESCE(pe.modalidade, '') <> 'full'
     )
     SELECT b.origem_integracao_id, im.nome AS loja, b.canal,
            COUNT(*)::int AS enviados,
            COUNT(*) FILTER (WHERE b.despachar_ate IS NOT NULL)::int AS com_prazo,
            COUNT(*) FILTER (WHERE b.despachar_ate IS NOT NULL AND b.enviado_em <= b.despachar_ate)::int AS no_prazo,
            COUNT(*) FILTER (WHERE b.conferido_em IS NULL)::int AS sem_conferencia,
            ROUND(AVG(EXTRACT(EPOCH FROM (b.conferido_em - b.pago_em)) / 60) FILTER (WHERE b.conferido_em > b.pago_em))::int AS min_pago_conferido,
            ROUND(AVG(EXTRACT(EPOCH FROM (b.enviado_em - b.conferido_em)) / 60) FILTER (WHERE b.enviado_em > b.conferido_em))::int AS min_conferido_enviado,
            ROUND(AVG(EXTRACT(EPOCH FROM (b.enviado_em - b.pago_em)) / 60) FILTER (WHERE b.enviado_em > b.pago_em))::int AS min_pago_enviado,
            COUNT(*) FILTER (WHERE b.modalidade = 'coleta')::int AS m_coleta,
            COUNT(*) FILTER (WHERE b.modalidade = 'agencia')::int AS m_agencia,
            COUNT(*) FILTER (WHERE b.modalidade = 'flex')::int AS m_flex,
            COUNT(*) FILTER (WHERE b.modalidade = 'outro' OR b.modalidade IS NULL)::int AS m_outro
       FROM base b
       LEFT JOIN integracoes_marketplace im ON im.id = b.origem_integracao_id
      GROUP BY 1, 2, 3
      ORDER BY 3, 2`,
    [dias]
  );
  // Mapa de calor: pedidos que ENTRAM, por dia da semana × hora (últimos 28
  // dias). Hora = pagamento na plataforma; sem ela, a entrada no Hub (o ciclo
  // é de 5 min, então a hora é a mesma na prática).
  const { rows: mapa } = await pool.query(
    `SELECT EXTRACT(DOW FROM (COALESCE(pe.pago_em, p.created_at) AT TIME ZONE '${FUSO}'))::int AS dow,
            EXTRACT(HOUR FROM (COALESCE(pe.pago_em, p.created_at) AT TIME ZONE '${FUSO}'))::int AS hora,
            COUNT(*)::int AS n
       FROM pedidos_venda p
       LEFT JOIN pedido_envio pe ON pe.pedido_id = p.id
      WHERE p.origem_marketplace IS NOT NULL
        AND p.situacao <> 'cancelado'
        AND COALESCE(pe.pago_em, p.created_at) >= now() - interval '28 days'
      GROUP BY 1, 2`
  );
  const matriz = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const m of mapa) matriz[m.dow][m.hora] = m.n;
  return { dias, por_loja: rows, mapa_entrada: matriz, semanas_mapa: 4 };
}

async function diagnostico(pedidoId) {
  const { rows } = await pool.query(
    `SELECT pe.*, p.numero, p.origem_pedido_id, im.nome AS loja
       FROM pedidos_venda p
       LEFT JOIN pedido_envio pe ON pe.pedido_id = p.id
       LEFT JOIN integracoes_marketplace im ON im.id = p.origem_integracao_id
      WHERE p.id = $1`,
    [pedidoId]
  );
  if (!rows[0]) return null;
  const { rows: estado } = await pool.query(
    'SELECT * FROM expedicao_sync_estado WHERE origem_integracao_id = $1', [rows[0].origem_integracao_id || 0]
  );
  return { envio: rows[0], loja: estado[0] || null };
}

module.exports = {
  painelHoje, pendencias, enviadosDoDia, historicoColetas, indicadores, diagnostico,
  mediana, hhmm, diaDaSemana,
};
