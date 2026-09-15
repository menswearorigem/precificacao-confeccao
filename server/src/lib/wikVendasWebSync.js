// ═══════════════════════════════════════════════════════════════════════════
// VENDAS DE ATACADO/LOJA PELA SESSÃO WEB DO WIK (15/09/2026)
// ═══════════════════════════════════════════════════════════════════════════
// Por que existe: as vendas de ATACADO são lançadas DIRETO no Wik, e a API
// pública (`venda_get`) volta VAZIA para esse fluxo — por isso o módulo de
// Vendas ficava vazio e o job dizia "não tinha vendas para puxar". Marketplace
// (Shopee, ML, TikTok, Shein) é outra coisa e não passa pelo Wik.
//
// A fonte real é o GRID da Tela de Vendas (/Pedido/CarregaGrid), lido pela
// sessão web (cookie), a MESMA técnica confiável do grid das OPs. Isso substitui
// a etapa de vendas do maestro, que antes usava a API vazia.
//
// Grava o CABEÇALHO do pedido em `pedidos_venda` — que é o que o módulo precisa
// para "aparecer lá": cliente, vendedor, operação, situação, valores, NF, data.
// Idempotente por (wik_emp_id, wik_ped_id) e NÃO-destrutivo: um pedido que a
// casa descolou (sincroniza_wik = FALSE) nunca é sobrescrito. Os ITENS (grade)
// não vêm no grid e NÃO são tocados aqui — a linha do pedido não depende deles.

const pool = require('../db/pool');
const wikWeb = require('./wikWeb');
const { obterSessao, renovarSessao } = require('./wikWebSessao');

const MATRIZ_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);

function hojeIso() { return new Date().toISOString().slice(0, 10); }
function somarDias(iso, d) { const dt = new Date(iso + 'T00:00:00'); dt.setDate(dt.getDate() + d); return dt.toISOString().slice(0, 10); }
function txt(v) { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; }
function num(v) { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; }

async function buscarIntegracao() {
  const { rows } = await pool.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
  return rows[0] || null;
}

// Trava WEB compartilhada (migration 0069): produção, financeiro e vendas
// disputam a mesma `web_job_ativo`, então nunca há dois logins concorrentes no
// Wik (que só permite UMA sessão por login). Reusa a coluna existente — sem
// migration nova. O maestro já roda as etapas em sequência; esta trava é o
// cinto extra contra um disparo manual colidir com o ciclo.
async function reservarWebVendas(id) {
  const { rowCount } = await pool.query(
    `UPDATE integracoes_wik
        SET web_job_ativo = 'vendas', web_job_ativo_desde = now()
      WHERE id = $1
        AND (web_job_ativo IS NULL OR web_job_ativo_desde < now() - interval '25 minutes')`,
    [id]
  );
  return rowCount > 0;
}
async function liberarWebVendas(id) {
  await pool.query(
    `UPDATE integracoes_wik SET web_job_ativo = NULL, web_job_ativo_desde = NULL
      WHERE id = $1 AND web_job_ativo = 'vendas'`, [id]
  );
}

// Situação do grid ("Aberto", "Faturado", "Concluído", "Cancelado"...) → o
// enum nativo de `pedidos_venda` (aberto | faturado | cancelado), o mesmo que a
// importação por API já usava.
function situacaoVenda(s) {
  const t = String(s ?? '').toLowerCase();
  if (t.includes('cancel')) return 'cancelado';
  if (t.includes('faturad') || t.includes('conclu') || t.includes('baixad')) return 'faturado';
  return 'aberto';
}

// Casa o cliente: primeiro pelo id do Wik (PedCliId → clientes.wik_cli_id, que a
// importação de clientes já grava), depois pelo nome. Sem match, fica nulo — o
// pedido entra do mesmo jeito (o nome do cliente vem no próprio grid).
async function acharClienteId(client, wikCliId, nome) {
  if (wikCliId) {
    const r = await client.query('SELECT id FROM clientes WHERE wik_cli_id = $1 LIMIT 1', [wikCliId]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (nome) {
    const r = await client.query('SELECT id FROM clientes WHERE lower(btrim(nome)) = lower(btrim($1)) LIMIT 1', [nome]);
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

async function gravarPedido(client, ped) {
  const pedId = Number(ped.PedId);
  // descolado pela casa? não mexe.
  const jaTem = await client.query(
    'SELECT id, sincroniza_wik FROM pedidos_venda WHERE wik_emp_id = $1 AND wik_ped_id = $2',
    [MATRIZ_EMP_ID, pedId]
  );
  if (jaTem.rows[0] && jaTem.rows[0].sincroniza_wik !== true) return 'jaExistia';

  const clienteId = await acharClienteId(client, Number(ped.PedCliId) || null, txt(ped.Cliente));
  const dataPedido = (txt(ped.PedDatacad) || '').slice(0, 10) || hojeIso();
  const totalBruto = num(ped.PedValorTotal);
  const totalLiq = num(ped.PedValorLiq) || totalBruto;

  // quantidade_pecas: o grid não traz — no INSERT entra 0; no UPDATE fica de
  // fora, para não zerar uma contagem que outro caminho tenha preenchido.
  const up = await client.query(
    `INSERT INTO pedidos_venda
       (data_pedido, cliente_id, vendedor, operacao, condicao_pagamento, forma_pagamento,
        desconto_pct, desconto_valor, acrescimo, valor_frete, situacao, quantidade_pecas,
        total_bruto, total_liquido, observacao, origem, sincroniza_wik, wik_emp_id, wik_ped_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'wik',TRUE,$16,$17)
     ON CONFLICT (wik_emp_id, wik_ped_id) WHERE wik_ped_id IS NOT NULL DO UPDATE SET
       data_pedido=EXCLUDED.data_pedido, cliente_id=EXCLUDED.cliente_id, vendedor=EXCLUDED.vendedor,
       operacao=EXCLUDED.operacao, condicao_pagamento=EXCLUDED.condicao_pagamento,
       forma_pagamento=EXCLUDED.forma_pagamento, desconto_pct=EXCLUDED.desconto_pct,
       desconto_valor=EXCLUDED.desconto_valor, acrescimo=EXCLUDED.acrescimo, valor_frete=EXCLUDED.valor_frete,
       situacao=EXCLUDED.situacao, total_bruto=EXCLUDED.total_bruto, total_liquido=EXCLUDED.total_liquido,
       observacao=EXCLUDED.observacao, updated_at=now()
     WHERE pedidos_venda.sincroniza_wik = TRUE
     RETURNING (xmax = 0) AS inserido`,
    [dataPedido, clienteId, txt(ped.Vendedor), txt(ped.Operacao) || 'Venda',
     txt(ped.CondVenc), txt(ped.FormPgto), num(ped.PedPercDesc), num(ped.PedValorDesc), num(ped.PedAcrescimo),
     num(ped.PedFrete), situacaoVenda(ped.Situacao), 0, totalBruto, totalLiq,
     txt(ped.PedObservacao), MATRIZ_EMP_ID, pedId]
  );
  if (!up.rows[0]) return 'jaExistia'; // barrado pelo WHERE (descolado)
  return up.rows[0].inserido ? 'criado' : 'atualizado';
}

// Importa os pedidos dos últimos `dias` (padrão 60). Empresa = matriz (192),
// onde o atacado é lançado.
async function importarVendasWebAgora({ dias = 60 } = {}) {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem credencial ativa' };
  if (!(await reservarWebVendas(integracao.id))) return { pulado: 'sessão web ocupada' };

  const de = somarDias(hojeIso(), -Math.max(1, dias));
  const ate = hojeIso();
  const resumo = { janela: `${de}..${ate}`, lidos: 0, criadas: 0, atualizadas: 0, jaExistiam: 0, erros: [] };
  try {
    let sessao = await obterSessao(integracao);
    async function puxar() {
      await wikWeb.trocarEmpresa(sessao, MATRIZ_EMP_ID);
      return wikWeb.gridPedidos(sessao, { de, ate });
    }
    let linhas;
    try { linhas = await puxar(); }
    catch (e) {
      if (e.sessaoExpirada) { sessao = await renovarSessao(integracao); linhas = await puxar(); }
      else throw e;
    }
    resumo.lidos = linhas.length;

    for (const ped of linhas) {
      if (!ped || !ped.PedId) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await gravarPedido(client, ped);
        await client.query('COMMIT');
        if (r === 'criado') resumo.criadas++;
        else if (r === 'atualizado') resumo.atualizadas++;
        else resumo.jaExistiam++;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        resumo.erros.push(`Ped ${ped.PedId}: ${e.message}`);
      } finally { client.release(); }
    }
    resumo.erros = resumo.erros.slice(0, 10);
    return resumo;
  } finally {
    await liberarWebVendas(integracao.id);
  }
}

module.exports = { importarVendasWebAgora, situacaoVenda };
