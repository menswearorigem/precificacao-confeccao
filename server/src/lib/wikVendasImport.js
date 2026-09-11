// Importa CLIENTES e VENDAS do Wik pela API PÚBLICA (token, 3 req/s, serializada
// — mesma disciplina do wik.js). Não usa a sessão web.
//
//   CLIENTES  → cliente_get (paginado; filtra CliTpCliente = 1)         → tabela `clientes`
//   VENDAS    → venda_get (lista por período) + vendas_itens_get (detalhe) → `pedidos_venda` + `pedido_itens`
//
// Idempotente e NÃO-destrutivo: casa pela chave do Wik (wik_cli_id / wik_ped_id);
// registro editado pela casa (sincroniza_wik = FALSE) não é sobrescrito.
// Produto/cliente são casados por referência/nome; sem match, o dado entra do
// mesmo jeito (cliente por nome; item guarda a referência mesmo sem produto_id).

const pool = require('../db/pool');
const wik = require('./wik');
const {
  buscarIntegracao, obterTokenBoxAtual, criarOpcoesToken,
  reservarJobWik, liberarJobWik, mensagemJobOcupado,
  registrarTentativaWik, registrarFalhaWik, registrarSucessoWik, cicloDevePular,
  empIdsConfigurados,
} = require('./wikSync');

const EMP_IDS_PADRAO = [192, 193, 198, 202];
function hojeIso() { return new Date().toISOString().slice(0, 10); }
function somarDias(iso, d) { const dt = new Date(iso + 'T00:00:00'); dt.setDate(dt.getDate() + d); return dt.toISOString().slice(0, 10); }
function txt(v) { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; }
function num(v) { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function primeiro(v) { return Array.isArray(v) ? v[0] : v; }
function soDigitos(v) { return String(v ?? '').replace(/\D/g, ''); }

async function empIds() {
  try { const m = await empIdsConfigurados(); const ks = [...m.keys()].map(Number); if (ks.length) return ks; } catch (_) { /* fallback */ }
  return EMP_IDS_PADRAO;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLIENTES
// ═══════════════════════════════════════════════════════════════════════════
function mapClienteWik(c) {
  const cnpjcpf = txt(c.CliCnpjCpf);
  const end = primeiro(c.Endereco) || {};
  const fone = txt(c.ClifFone) || txt(primeiro(c.Telefone)?.ClifFone) || txt(primeiro(c.Telefone));
  const inativo = /inativ|bloq|desativ/i.test(String(c.CliStatus ?? '')) || String(c.CliStatus ?? '') === '2';
  return {
    wik_cli_id: Number(c.CliId),
    tipo_pessoa: soDigitos(cnpjcpf).length > 11 ? 'PJ' : 'PF',
    nome: (txt(c.CliRazaoSocial) || txt(c.CliFantasia) || `Cliente Wik ${c.CliId}`).slice(0, 160),
    nome_fantasia: txt(c.CliFantasia)?.slice(0, 160) || null,
    cpf_cnpj: cnpjcpf?.slice(0, 20) || null,
    ie: txt(c.CliInscEstad)?.slice(0, 30) || null,
    email: txt(c.CliEmail)?.slice(0, 160) || null,
    telefone: fone?.slice(0, 30) || null,
    cep: txt(end.ClieCep)?.slice(0, 10) || null,
    logradouro: txt(end.ClieEndereco)?.slice(0, 160) || null,
    numero: txt(end.ClieNumero)?.slice(0, 20) || null,
    complemento: txt(end.ClieComplemento)?.slice(0, 80) || null,
    bairro: txt(end.ClieBairro)?.slice(0, 80) || null,
    cidade: txt(end.ClieCidade)?.slice(0, 80) || null,
    uf: txt(end.ClieUf)?.slice(0, 2) || null,
    limite_credito: num(c.CliLimiteCredito),
    ativo: !inativo,
  };
}

async function upsertCliente(client, m) {
  // 1) já vinculado?
  const lig = await client.query('SELECT id, sincroniza_wik FROM clientes WHERE wik_cli_id = $1', [m.wik_cli_id]);
  if (lig.rows[0]) {
    if (lig.rows[0].sincroniza_wik !== true) return 'jaExistia'; // descolado: não mexe
    await client.query(
      `UPDATE clientes SET nome=$2, nome_fantasia=$3, cpf_cnpj=$4, ie=$5, email=$6, telefone=$7,
         cep=$8, logradouro=$9, numero=$10, complemento=$11, bairro=$12, cidade=$13, uf=$14,
         limite_credito=$15, ativo=$16, tipo_pessoa=$17, updated_at=now() WHERE id=$1`,
      [lig.rows[0].id, m.nome, m.nome_fantasia, m.cpf_cnpj, m.ie, m.email, m.telefone, m.cep, m.logradouro,
       m.numero, m.complemento, m.bairro, m.cidade, m.uf, m.limite_credito, m.ativo, m.tipo_pessoa]
    );
    return 'atualizado';
  }
  // 2) mesmo CNPJ/CPF ou mesmo nome já existe? vincula sem sobrescrever o resto
  let ex = null;
  if (m.cpf_cnpj) { const r = await client.query('SELECT id FROM clientes WHERE cpf_cnpj = $1 LIMIT 1', [m.cpf_cnpj]); ex = r.rows[0]; }
  if (!ex) { const r = await client.query('SELECT id FROM clientes WHERE lower(btrim(nome)) = lower(btrim($1)) LIMIT 1', [m.nome]); ex = r.rows[0]; }
  if (ex) {
    await client.query(
      `UPDATE clientes SET wik_cli_id=$2, sincroniza_wik=TRUE,
         cpf_cnpj=COALESCE(cpf_cnpj,$3), email=COALESCE(email,$4), telefone=COALESCE(telefone,$5),
         cidade=COALESCE(cidade,$6), uf=COALESCE(uf,$7), updated_at=now() WHERE id=$1`,
      [ex.id, m.wik_cli_id, m.cpf_cnpj, m.email, m.telefone, m.cidade, m.uf]
    );
    return 'vinculado';
  }
  // 3) cria
  await client.query(
    `INSERT INTO clientes (tipo_pessoa, nome, nome_fantasia, cpf_cnpj, ie, email, telefone,
       cep, logradouro, numero, complemento, bairro, cidade, uf, limite_credito, ativo,
       wik_cli_id, sincroniza_wik)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE)`,
    [m.tipo_pessoa, m.nome, m.nome_fantasia, m.cpf_cnpj, m.ie, m.email, m.telefone, m.cep, m.logradouro,
     m.numero, m.complemento, m.bairro, m.cidade, m.uf, m.limite_credito, m.ativo, m.wik_cli_id]
  );
  return 'criado';
}

async function importarClientesAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem credencial ativa' };
  const pular = cicloDevePular(integracao); if (pular) return { pulado: pular };
  if (!(await reservarJobWik(integracao.id, 'clientes'))) return { pulado: await mensagemJobOcupado(integracao.id) };
  await registrarTentativaWik(integracao.id);
  const resumo = { lidos: 0, criados: 0, atualizados: 0, vinculados: 0, jaExistiam: 0, erros: [] };
  try {
    const tokenBox = await obterTokenBoxAtual(integracao);
    const opcoes = criarOpcoesToken(integracao);
    // puxa todas as páginas
    const brutos = [];
    for (let pagina = 1; pagina <= 500; pagina++) {
      const lote = await wik.listarClientes(tokenBox, { pagina, dataInicio: '2000-01-01', dataFinal: hojeIso(), tipoData: 1 }, opcoes);
      if (!lote.length) break;
      brutos.push(...lote);
      if (lote.length < 1) break;
    }
    const clientes = brutos.filter((c) => Number(c.CliTpCliente) === 1 && c.CliId);
    resumo.lidos = clientes.length;
    for (const c of clientes) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await upsertCliente(client, mapClienteWik(c));
        await client.query('COMMIT');
        if (r === 'criado') resumo.criados++; else if (r === 'atualizado') resumo.atualizados++;
        else if (r === 'vinculado') resumo.vinculados++; else resumo.jaExistiam++;
      } catch (e) { await client.query('ROLLBACK'); resumo.erros.push(`Cli ${c.CliId}: ${e.message}`); }
      finally { client.release(); }
    }
    await registrarSucessoWik(integracao.id);
    resumo.erros = resumo.erros.slice(0, 10);
    return resumo;
  } catch (err) {
    await registrarFalhaWik(integracao.id, err);
    throw err;
  } finally {
    await liberarJobWik(integracao.id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VENDAS
// ═══════════════════════════════════════════════════════════════════════════
const MAP_SITUACAO_VENDA = { faturad: 'faturado', cancelad: 'cancelado' };
function situacaoVenda(s) {
  const t = String(s ?? '').toLowerCase();
  for (const k of Object.keys(MAP_SITUACAO_VENDA)) if (t.includes(k)) return MAP_SITUACAO_VENDA[k];
  return 'aberto';
}
async function acharClienteId(client, nome) {
  if (!nome) return null;
  const r = await client.query('SELECT id FROM clientes WHERE lower(btrim(nome)) = lower(btrim($1)) LIMIT 1', [nome]);
  return r.rows[0]?.id || null;
}
// vendas_itens_get pode vir como 1 objeto com listas aninhadas, ou uma linha por
// item. Normaliza para: { header, itens[] }. Defensivo — confirmar no 1º run.
function normalizarVendaDetalhe(det) {
  const linhas = Array.isArray(det) ? det : [det];
  const h = linhas[0] || {};
  const itens = [];
  for (const l of linhas) {
    const grade = Array.isArray(l.ListaProdutoGrade) ? l.ListaProdutoGrade : null;
    if (grade && grade.length) {
      for (const g of grade) itens.push({ ref: txt(l.ProdReferencia), prodId: l.ProdId, cor: txt(g.Cor), tamanho: txt(g.Tamanho), qtd: num(g.Quantidade) });
    } else if (l.ProdReferencia || l.ProdId) {
      itens.push({ ref: txt(l.ProdReferencia), prodId: l.ProdId, cor: txt(l.Cor), tamanho: txt(l.Tamanho), qtd: num(l.Quantidade) });
    }
  }
  return { h, itens };
}

async function gravarVenda(empId, ped, det, marcaId) {
  const { h, itens } = normalizarVendaDetalhe(det);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jaTem = await client.query('SELECT id, sincroniza_wik FROM pedidos_venda WHERE wik_emp_id=$1 AND wik_ped_id=$2', [empId, ped.PedId]);
    if (jaTem.rows[0] && jaTem.rows[0].sincroniza_wik !== true) { await client.query('COMMIT'); return 'jaExistia'; }

    const clienteId = await acharClienteId(client, txt(h.Cliente) || txt(ped.Cliente));
    const totalBruto = num(h.PedValorTotal);
    const totalLiq = num(h.PedValorLiq) || num(ped.PedValorLiq);
    const qtdPecas = itens.reduce((a, i) => a + i.qtd, 0);
    const dataPedido = (txt(h.PedDataCad) || '').slice(0, 10) || hojeIso();

    const up = await client.query(
      `INSERT INTO pedidos_venda
         (data_pedido, cliente_id, vendedor, operacao, condicao_pagamento, forma_pagamento,
          desconto_pct, desconto_valor, acrescimo, valor_frete, situacao, quantidade_pecas,
          total_bruto, total_liquido, observacao, origem, sincroniza_wik, wik_emp_id, wik_ped_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'wik',TRUE,$16,$17)
       ON CONFLICT (wik_emp_id, wik_ped_id) DO UPDATE SET
         data_pedido=EXCLUDED.data_pedido, cliente_id=EXCLUDED.cliente_id, vendedor=EXCLUDED.vendedor,
         operacao=EXCLUDED.operacao, condicao_pagamento=EXCLUDED.condicao_pagamento,
         forma_pagamento=EXCLUDED.forma_pagamento, desconto_pct=EXCLUDED.desconto_pct,
         desconto_valor=EXCLUDED.desconto_valor, acrescimo=EXCLUDED.acrescimo,
         situacao=EXCLUDED.situacao, quantidade_pecas=EXCLUDED.quantidade_pecas,
         total_bruto=EXCLUDED.total_bruto, total_liquido=EXCLUDED.total_liquido, updated_at=now()
       WHERE pedidos_venda.sincroniza_wik = TRUE
       RETURNING id`,
      [dataPedido, clienteId, txt(h.Vendedor), txt(h.Operacao) || txt(ped.Operacao) || 'Venda',
       txt(h.CondVenc), txt(h.FormPgto), num(h.PedPercDesc), num(h.PedValorDesc), num(h.PedAcrescimo),
       num(h.Pedfrete), situacaoVenda(h.Situacao || ped.Situacao), qtdPecas, totalBruto, totalLiq,
       null, empId, ped.PedId]
    );
    if (!up.rows[0]) { await client.query('COMMIT'); return 'jaExistia'; } // barrado (descolado)
    const pedidoId = up.rows[0].id;

    await client.query('DELETE FROM pedido_itens WHERE pedido_id = $1', [pedidoId]);
    let ordem = 0;
    for (const it of itens) {
      let produtoId = null;
      if (it.ref) { const r = await client.query('SELECT id FROM produtos WHERE upper(btrim(referencia)) = upper(btrim($1)) LIMIT 1', [it.ref]); produtoId = r.rows[0]?.id || null; }
      await client.query(
        `INSERT INTO pedido_itens (pedido_id, produto_id, referencia, descricao, cor, tamanho, quantidade, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pedidoId, produtoId, it.ref, null, it.cor, it.tamanho, it.qtd, ordem++]
      );
    }
    await client.query('COMMIT');
    return jaTem.rows[0] ? 'atualizado' : 'criado';
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function importarVendasAgora({ dias = 30, cap = 400 } = {}) {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem credencial ativa' };
  const pular = cicloDevePular(integracao); if (pular) return { pulado: pular };
  if (!(await reservarJobWik(integracao.id, 'vendas'))) return { pulado: await mensagemJobOcupado(integracao.id) };
  await registrarTentativaWik(integracao.id);
  const resumo = { empresas: 0, vistas: 0, criadas: 0, atualizadas: 0, jaExistiam: 0, semItens: 0, erros: [] };
  const de = somarDias(hojeIso(), -Math.max(1, dias)); const ate = hojeIso();
  try {
    const tokenBox = await obterTokenBoxAtual(integracao);
    const opcoes = criarOpcoesToken(integracao);
    const empMarca = await empIdsConfigurados().catch(() => new Map());
    let orcamento = cap;
    for (const empId of await empIds()) {
      if (orcamento <= 0) break;
      let lista;
      try { lista = await wik.listarVendas(tokenBox, { empId, dataInicial: de, dataFinal: ate }, opcoes); }
      catch (e) { resumo.erros.push(`Empresa ${empId} (lista): ${e.message}`); continue; }
      resumo.empresas++; resumo.vistas += lista.length;
      const marcaId = (empMarca.get(empId) || [])[0] || null;
      for (const ped of lista) {
        if (orcamento <= 0) break;
        if (!ped.PedId) continue;
        try {
          const det = await wik.buscarVendaItens(tokenBox, { empId, id: ped.PedId }, opcoes);
          if (!det || (Array.isArray(det) && !det.length)) resumo.semItens++;
          const r = await gravarVenda(empId, ped, det, marcaId);
          if (r === 'criado') resumo.criadas++; else if (r === 'atualizado') resumo.atualizadas++; else resumo.jaExistiam++;
          orcamento--;
        } catch (e) { resumo.erros.push(`Venda ${empId}/${ped.PedId}: ${e.message}`); orcamento--; }
      }
    }
    await registrarSucessoWik(integracao.id);
    resumo.erros = resumo.erros.slice(0, 10);
    return resumo;
  } catch (err) {
    await registrarFalhaWik(integracao.id, err);
    throw err;
  } finally {
    await liberarJobWik(integracao.id);
  }
}

module.exports = { importarClientesAgora, importarVendasAgora, mapClienteWik, normalizarVendaDetalhe };
