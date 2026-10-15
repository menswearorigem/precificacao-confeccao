// Rotinas (15/10/2026) — o motor: valida o modelo que o administrador
// escreveu, resolve os produtos, gera as ocorrências do dia e julga cada
// resposta da equipe.
//
// Regras que valem para o arquivo inteiro:
//   · A geração é IDEMPOTENTE: a restrição única (modelo_id, data, vaga)
//     garante que rodar duas vezes no mesmo dia não duplica nada — por isso
//     o job da madrugada e a abertura do "Meu dia" podem chamar à vontade.
//   · Uma ocorrência guarda o modelo COMO ESTAVA (snapshot) e os produtos
//     COMO ESTAVAM (produtos_resolvidos). Editar o modelo só muda as próximas.
//   · "Atrasada" não é status: é ocorrência aberta com prazo no passado,
//     calculado na leitura.

const sanitizeHtml = require('sanitize-html');
const pool = require('../db/pool');
const rec = require('./rotinasRecorrencia');
const { hojeEmBrasilia, FUSO } = require('./dataBrasil');

// ---------------------------------------------------------------------------
// Vocabulário
// ---------------------------------------------------------------------------
const SETORES = {
  expedicao: 'Expedição', estoque: 'Estoque', producao: 'Produção', marketplace: 'Marketplace',
  conteudo: 'Conteúdo', atendimento: 'Atendimento', financeiro: 'Financeiro', compras: 'Compras',
};
const MARCAS = ['Miss Manu', 'Origem', 'Hoggar', 'Hebron'];
const CANAIS = {
  mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein', atacado: 'Atacado',
};
const TIPOS_PASSO = ['feito', 'sim_nao', 'ok_problema', 'numero', 'texto', 'escolha', 'foto'];
const PROVAS = ['nao', 'problema', 'sempre'];
const PRIORIDADES = ['baixa', 'normal', 'alta', 'urgente'];
const PESO_PRIORIDADE = { urgente: 0, alta: 1, normal: 2, baixa: 3 };
const ABERTOS = ['pendente', 'em_andamento', 'devolvida'];
const MOTIVOS_NAO_FEITA = {
  falta_produto: 'Falta de produto', falta_tempo: 'Falta de tempo', sistema_fora: 'Sistema fora', outro: 'Outro',
};
const LIMITE_PRODUTOS_AUTOMATICOS = 300;

class ErroRotina extends Error {
  constructor(mensagem, status = 400, extra = {}) {
    super(mensagem);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Texto e HTML
// ---------------------------------------------------------------------------
function textoLimpo(v, limite) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return limite ? s.slice(0, limite) : s;
}

// Só o que o editor da tela produz: negrito, itálico, listas, link e quebra.
function sanitizarInstrucao(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'div'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      div: 'p',
    },
  }).trim();
}
function htmlTemTexto(html) {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;/g, ' ').trim().length > 0;
}
function escaparHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ehUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch { return false; }
}

function idsInteiros(lista) {
  return [...new Set((Array.isArray(lista) ? lista : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// ---------------------------------------------------------------------------
// Validação do modelo
// ---------------------------------------------------------------------------
function normalizarFaixa(f) {
  if (!f || typeof f !== 'object') return null;
  if (f.estoque) {
    const tolerancia = Number(f.tolerancia ?? 0);
    if (!Number.isFinite(tolerancia) || tolerancia < 0) throw new ErroRotina('A tolerância em relação ao estoque precisa ser 0 ou mais.');
    return { estoque: true, tolerancia };
  }
  const min = f.min === '' || f.min == null ? null : Number(f.min);
  const max = f.max === '' || f.max == null ? null : Number(f.max);
  if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) throw new ErroRotina('A faixa esperada precisa ser número.');
  if (min == null && max == null) return null;
  if (min != null && max != null && max < min) throw new ErroRotina('Na faixa esperada, o máximo é menor que o mínimo.');
  return { min, max };
}

function normalizarPassos(passos) {
  const lista = Array.isArray(passos) ? passos : [];
  if (lista.length > 30) throw new ErroRotina('No máximo 30 passos por tarefa.');
  return lista.map((p, i) => {
    const texto = textoLimpo(p.texto, 300);
    if (!texto) throw new ErroRotina(`O passo ${i + 1} está sem texto.`);
    const tipo = TIPOS_PASSO.includes(p.tipo) ? p.tipo : null;
    if (!tipo) throw new ErroRotina(`Escolha o tipo de resposta do passo ${i + 1}.`);
    const prova = PROVAS.includes(p.provaFoto) ? p.provaFoto : 'nao';
    let opcoes = [];
    if (tipo === 'escolha') {
      opcoes = [...new Set((p.opcoes || []).map((o) => textoLimpo(o, 60)).filter(Boolean))].slice(0, 12);
      if (opcoes.length < 2) throw new ErroRotina(`O passo ${i + 1} é de escolha: escreva pelo menos duas opções.`);
    }
    return {
      ordem: i,
      texto,
      tipo,
      opcoes,
      unidade: tipo === 'numero' ? (textoLimpo(p.unidade, 20) || null) : null,
      porProduto: Boolean(p.porProduto),
      obrigatorio: p.obrigatorio !== false,
      // "Foto" já é a própria prova; "só se der problema" não existe para
      // um passo que não tem como dar problema.
      provaFoto: tipo === 'foto' ? 'nao' : (prova === 'problema' && !['sim_nao', 'ok_problema', 'numero'].includes(tipo) ? 'nao' : prova),
      faixa: tipo === 'numero' ? normalizarFaixa(p.faixa) : null,
    };
  });
}

function normalizarFiltroProdutos(f) {
  const x = f && typeof f === 'object' ? f : {};
  const lista = (v, lim = 40) => [...new Set((Array.isArray(v) ? v : []).map((s) => textoLimpo(s, 80)).filter(Boolean))].slice(0, lim);
  return {
    marcas: lista(x.marcas).filter((m) => MARCAS.includes(m)),
    canais: lista(x.canais).filter((c) => CANAIS[c] && c !== 'atacado'),
    curvas: lista(x.curvas).filter((c) => ['A', 'B', 'C'].includes(c)),
    grupos: lista(x.grupos),
    subgrupos: lista(x.subgrupos),
  };
}

function horaValida(h) {
  if (h == null || h === '') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(h));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new ErroRotina('O horário limite precisa ser no formato 10:00.');
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

async function normalizarModelo(body, db = pool, { avulsa = false } = {}) {
  const titulo = textoLimpo(body.titulo, 120);
  if (!titulo) throw new ErroRotina('Dê um título para a tarefa.');
  const instrucaoHtml = sanitizarInstrucao(body.instrucaoHtml);
  if (!htmlTemTexto(instrucaoHtml)) throw new ErroRotina('Escreva o que precisa ser feito.');
  if (instrucaoHtml.length > 20000) throw new ErroRotina('A instrução ficou longa demais (máx. ~20 mil caracteres).');
  const setor = SETORES[body.setor] ? body.setor : null;
  if (!setor) throw new ErroRotina('Escolha o setor da tarefa.');

  const links = (body.anexos?.links || []).slice(0, 10).map((l) => ({ rotulo: textoLimpo(l.rotulo, 80), url: String(l.url || '').trim() }))
    .filter((l) => l.url);
  for (const l of links) if (!ehUrl(l.url)) throw new ErroRotina(`O link "${l.rotulo || l.url}" precisa começar com http:// ou https://.`);
  const imagens = idsInteiros(body.anexos?.imagens);
  if (imagens.length > 3) throw new ErroRotina('No máximo 3 imagens de referência.');

  const modoProdutos = body.modoProdutos === 'automatica' ? 'automatica' : 'fixa';
  const filtro = modoProdutos === 'automatica' ? normalizarFiltroProdutos(body.filtroProdutos) : null;
  if (filtro && !filtro.marcas.length && !filtro.canais.length && !filtro.curvas.length && !filtro.grupos.length && !filtro.subgrupos.length) {
    throw new ErroRotina('A lista automática precisa de pelo menos um filtro (marca, canal, curva ou grupo).');
  }
  const produtos = modoProdutos === 'fixa'
    ? (Array.isArray(body.produtos) ? body.produtos : []).slice(0, 500).map((p) => ({
      produtoId: Number(p.produtoId), varianteId: p.varianteId ? Number(p.varianteId) : null,
    })).filter((p) => Number.isInteger(p.produtoId) && p.produtoId > 0)
    : [];

  const passos = normalizarPassos(body.passos);
  const temProdutos = modoProdutos === 'automatica' || produtos.length > 0;
  if (!temProdutos && passos.some((p) => p.porProduto)) {
    throw new ErroRotina('Há passo marcado "por produto", mas a tarefa não tem produtos. Escolha os produtos ou desmarque.');
  }
  if (passos.some((p) => p.faixa?.estoque && !p.porProduto)) {
    throw new ErroRotina('"Comparar com o estoque do sistema" só funciona em passo por produto.');
  }

  const responsaveis = idsInteiros(body.responsaveis);
  if (!responsaveis.length) throw new ErroRotina('Escolha quem faz a tarefa.');
  const { rows: pessoas } = await db.query('SELECT id, role, ativo FROM usuarios WHERE id = ANY($1)', [responsaveis]);
  if (pessoas.length !== responsaveis.length || pessoas.some((p) => !p.ativo)) throw new ErroRotina('Algum responsável não existe mais ou está desativado.');

  let recorrencia = rec.normalizar(avulsa ? { tipo: 'uma_vez', data: body.recorrencia?.data } : body.recorrencia);
  // Semanal sem início: conta a partir desta semana.
  if (recorrencia.tipo === 'semanal' && !recorrencia.inicio) recorrencia = { ...recorrencia, inicio: hojeEmBrasilia() };

  const minutos = body.minutosEstimados === '' || body.minutosEstimados == null ? null : Number(body.minutosEstimados);
  if (minutos != null && (!Number.isInteger(minutos) || minutos < 1 || minutos > 1440)) throw new ErroRotina('O tempo estimado vai de 1 a 1440 minutos.');
  const lembrete = body.lembreteMin === '' || body.lembreteMin == null ? null : Number(body.lembreteMin);
  if (lembrete != null && (!Number.isInteger(lembrete) || lembrete < 5 || lembrete > 1440)) throw new ErroRotina('O lembrete vai de 5 a 1440 minutos antes do prazo.');
  const horaLimite = horaValida(body.horaLimite);
  if (lembrete && !horaLimite) throw new ErroRotina('Para avisar antes do prazo, defina o horário limite.');

  const conferirDepois = Boolean(body.conferirDepois);
  let conferenteId = conferirDepois && body.conferenteId ? Number(body.conferenteId) : null;
  if (conferenteId) {
    const { rows } = await db.query("SELECT 1 FROM usuarios WHERE id = $1 AND role = 'admin' AND ativo", [conferenteId]);
    if (!rows.length) throw new ErroRotina('Quem confere precisa ser um administrador ativo.');
  }
  let correcao = null;
  if (body.correcaoAutomatica?.responsavelId) {
    const id = Number(body.correcaoAutomatica.responsavelId);
    const { rows } = await db.query('SELECT 1 FROM usuarios WHERE id = $1 AND ativo', [id]);
    if (!rows.length) throw new ErroRotina('Quem corrige o problema não existe mais ou está desativado.');
    correcao = { responsavelId: id };
  }

  return {
    titulo,
    instrucaoHtml,
    motivo: textoLimpo(body.motivo, 200) || null,
    setor,
    marcas: [...new Set((body.marcas || []).filter((m) => MARCAS.includes(m)))],
    canais: [...new Set((body.canais || []).filter((c) => CANAIS[c]))],
    anexos: { links, imagens },
    modoProdutos,
    filtroProdutos: filtro,
    produtos,
    passos,
    responsaveis,
    modoAtribuicao: body.modoAtribuicao === 'qualquer_um' ? 'qualquer_um' : 'cada_um',
    recorrencia,
    horaLimite,
    minutosEstimados: minutos,
    prioridade: PRIORIDADES.includes(body.prioridade) ? body.prioridade : 'normal',
    conferirDepois,
    conferenteId,
    correcaoAutomatica: correcao,
    lembreteMin: lembrete,
    avulsa,
  };
}

// ---------------------------------------------------------------------------
// Gravação do modelo
// ---------------------------------------------------------------------------
async function salvarModelo(m, usuarioId, modeloId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const valores = [
      m.titulo, m.instrucaoHtml, m.motivo, m.setor, JSON.stringify(m.marcas), JSON.stringify(m.canais), JSON.stringify(m.anexos),
      m.modoProdutos, m.filtroProdutos ? JSON.stringify(m.filtroProdutos) : null, JSON.stringify(m.responsaveis), m.modoAtribuicao,
      JSON.stringify(m.recorrencia), m.horaLimite, m.minutosEstimados, m.prioridade, m.conferirDepois, m.conferenteId,
      m.correcaoAutomatica ? JSON.stringify(m.correcaoAutomatica) : null, m.lembreteMin, usuarioId,
    ];
    let id = modeloId;
    if (id) {
      const { rowCount } = await client.query(
        `UPDATE rotina_modelos SET titulo=$1, instrucao_html=$2, motivo=$3, setor=$4, marcas=$5, canais=$6, anexos=$7,
                modo_produtos=$8, filtro_produtos=$9, responsaveis=$10, modo_atribuicao=$11, recorrencia=$12, hora_limite=$13,
                minutos_estimados=$14, prioridade=$15, conferir_depois=$16, conferente_id=$17, correcao_automatica=$18,
                lembrete_min=$19, atualizado_por=$20, updated_at=now()
          WHERE id=$21`,
        [...valores, id]
      );
      if (!rowCount) throw new ErroRotina('Rotina não encontrada.', 404);
      await client.query('DELETE FROM rotina_modelo_passos WHERE modelo_id = $1', [id]);
      await client.query('DELETE FROM rotina_modelo_produtos WHERE modelo_id = $1', [id]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO rotina_modelos (titulo, instrucao_html, motivo, setor, marcas, canais, anexos, modo_produtos, filtro_produtos,
                responsaveis, modo_atribuicao, recorrencia, hora_limite, minutos_estimados, prioridade, conferir_depois, conferente_id,
                correcao_automatica, lembrete_min, criado_por, atualizado_por, avulsa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,$21) RETURNING id`,
        [...valores, m.avulsa]
      );
      id = rows[0].id;
    }
    for (const p of m.passos) {
      await client.query(
        `INSERT INTO rotina_modelo_passos (modelo_id, ordem, texto, tipo, opcoes, unidade, por_produto, obrigatorio, prova_foto, faixa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, p.ordem, p.texto, p.tipo, JSON.stringify(p.opcoes), p.unidade, p.porProduto, p.obrigatorio, p.provaFoto, p.faixa ? JSON.stringify(p.faixa) : null]
      );
    }
    if (m.produtos.length) {
      // Variante que não é da referência informada é descartada em silêncio
      // de propósito: é o caso de variante apagada entre a escolha e o salvar.
      await client.query(
        `INSERT INTO rotina_modelo_produtos (modelo_id, produto_id, variante_id)
         SELECT $1, x.produto_id, x.variante_id
           FROM jsonb_to_recordset($2::jsonb) AS x(produto_id INTEGER, variante_id INTEGER)
           JOIN produtos p ON p.id = x.produto_id
          WHERE x.variante_id IS NULL OR EXISTS (SELECT 1 FROM estoque_variantes v WHERE v.id = x.variante_id AND v.produto_id = x.produto_id)
         ON CONFLICT DO NOTHING`,
        [id, JSON.stringify(m.produtos.map((p) => ({ produto_id: p.produtoId, variante_id: p.varianteId })))]
      );
    }
    if (m.anexos.imagens.length) {
      await client.query('UPDATE rotina_fotos SET modelo_id = $1 WHERE id = ANY($2) AND ocorrencia_id IS NULL', [id, m.anexos.imagens]);
    }
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function linhaParaModelo(r, passos = [], produtos = []) {
  return {
    id: r.id,
    titulo: r.titulo,
    instrucaoHtml: r.instrucao_html,
    motivo: r.motivo,
    setor: r.setor,
    marcas: r.marcas,
    canais: r.canais,
    anexos: r.anexos,
    modoProdutos: r.modo_produtos,
    filtroProdutos: r.filtro_produtos,
    produtos,
    passos,
    responsaveis: r.responsaveis,
    modoAtribuicao: r.modo_atribuicao,
    recorrencia: r.recorrencia,
    horaLimite: r.hora_limite ? String(r.hora_limite).slice(0, 5) : null,
    minutosEstimados: r.minutos_estimados,
    prioridade: r.prioridade,
    conferirDepois: r.conferir_depois,
    conferenteId: r.conferente_id,
    correcaoAutomatica: r.correcao_automatica,
    lembreteMin: r.lembrete_min,
    status: r.status,
    avulsa: r.avulsa,
    criadoEm: r.created_at,
    atualizadoEm: r.updated_at,
  };
}

function linhaParaPasso(p) {
  return {
    id: p.id, texto: p.texto, tipo: p.tipo, opcoes: p.opcoes, unidade: p.unidade, porProduto: p.por_produto,
    obrigatorio: p.obrigatorio, provaFoto: p.prova_foto, faixa: p.faixa,
  };
}

async function carregarModelo(id, db = pool) {
  const { rows } = await db.query('SELECT * FROM rotina_modelos WHERE id = $1', [id]);
  if (!rows.length) return null;
  const [{ rows: passos }, { rows: produtos }] = await Promise.all([
    db.query('SELECT * FROM rotina_modelo_passos WHERE modelo_id = $1 ORDER BY ordem, id', [id]),
    db.query(
      `SELECT mp.produto_id, mp.variante_id, p.referencia, p.descricao, COALESCE(NULLIF(p.marca, ''), p.wik_marca) AS marca,
              v.cor, v.tamanho
         FROM rotina_modelo_produtos mp
         JOIN produtos p ON p.id = mp.produto_id
         LEFT JOIN estoque_variantes v ON v.id = mp.variante_id
        WHERE mp.modelo_id = $1
        ORDER BY p.referencia, v.cor, v.tamanho`,
      [id]
    ),
  ]);
  return linhaParaModelo(
    rows[0],
    passos.map(linhaParaPasso),
    produtos.map((p) => ({
      produtoId: p.produto_id, varianteId: p.variante_id, referencia: p.referencia, descricao: p.descricao,
      marca: p.marca, cor: p.cor, tamanho: p.tamanho,
    }))
  );
}

// ---------------------------------------------------------------------------
// Catálogo de produtos (seletor + lista automática)
// ---------------------------------------------------------------------------
// A curva ABC é a MESMA conta da Cobertura e do Piso (curvaAbc por margem de
// contribuição em 26 semanas, caindo para faturamento sem custo) — reusada de
// lib/precoPiso.js, não recalculada aqui (REGRA 1). Ela é do catálogo
// inteiro e custa caro: fica guardada 1 hora.
let cacheCurva = { em: 0, mapa: new Map() };
async function curvasAbc() {
  if (Date.now() - cacheCurva.em < 60 * 60 * 1000) return cacheCurva.mapa;
  try {
    const vendas = require('./vendasEmPecas');
    const { carregarBaseDeMargem } = require('./promocaoMargem');
    const { classesAbc } = require('./precoPiso');
    const totais = await vendas.totaisPorProduto(pool, vendas.normalizarJanela(26));
    const base = await carregarBaseDeMargem([...totais.keys()]);
    const mapa = await classesAbc(base, []);
    cacheCurva = { em: Date.now(), mapa };
  } catch (err) {
    console.error('[rotinas] curva ABC indisponível:', err.message);
    cacheCurva = { em: Date.now() - 50 * 60 * 1000, mapa: new Map() };
  }
  return cacheCurva.mapa;
}
function limparCacheCurva() { cacheCurva = { em: 0, mapa: new Map() }; }

function normalizarMarca(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function marcaCanonica(s) {
  const n = normalizarMarca(s);
  return MARCAS.find((m) => normalizarMarca(m) === n || n.includes(normalizarMarca(m))) || (s ? String(s) : null);
}

async function catalogo() {
  const [{ rows }, curva] = await Promise.all([
    pool.query(
      `SELECT p.id, p.referencia, p.descricao, p.codigo, COALESCE(NULLIF(p.marca, ''), p.wik_marca) AS marca,
              p.wik_grupo AS grupo, p.wik_subgrupo AS subgrupo,
              EXISTS (SELECT 1 FROM produto_fotos f WHERE f.produto_id = p.id) AS tem_foto,
              (SELECT a.foto_url FROM anuncios_marketplace a WHERE a.produto_id = p.id AND a.foto_url IS NOT NULL ORDER BY a.id LIMIT 1) AS foto_url,
              COALESCE((SELECT jsonb_agg(DISTINCT a.marketplace) FROM anuncios_marketplace a WHERE a.produto_id = p.id AND a.status = 'ativo'), '[]') AS canais,
              COUNT(v.id) FILTER (WHERE v.ativo)::int AS variantes,
              COALESCE(SUM(v.quantidade) FILTER (WHERE v.ativo), 0)::float AS estoque,
              string_agg(v.ean, ' ') FILTER (WHERE v.ativo AND v.ean IS NOT NULL) AS eans
         FROM produtos p
         LEFT JOIN estoque_variantes v ON v.produto_id = p.id
        GROUP BY p.id
        ORDER BY p.referencia`
    ),
    curvasAbc(),
  ]);
  return rows.map((r) => ({
    id: r.id,
    referencia: r.referencia,
    descricao: r.descricao,
    codigo: r.codigo,
    marca: marcaCanonica(r.marca),
    grupo: r.grupo,
    subgrupo: r.subgrupo,
    curva: curva.get(r.id) || null,
    canais: r.canais,
    temFoto: r.tem_foto,
    fotoUrl: r.tem_foto ? null : r.foto_url,
    variantes: r.variantes,
    estoque: r.estoque,
    eans: r.eans || '',
  }));
}

function casaFiltro(item, f) {
  if (f.marcas.length && !f.marcas.includes(item.marca)) return false;
  if (f.curvas.length && !f.curvas.includes(item.curva)) return false;
  if (f.canais.length && !f.canais.some((c) => item.canais.includes(c))) return false;
  const semId = (s) => String(s || '').replace(/^\s*\d+\s*-\s*/, '').trim().toLowerCase();
  if (f.grupos.length && !f.grupos.some((g) => semId(g) === semId(item.grupo))) return false;
  if (f.subgrupos.length && !f.subgrupos.some((g) => semId(g) === semId(item.subgrupo))) return false;
  return true;
}

async function variantesDe(produtoIds) {
  if (!produtoIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, produto_id, cor, tamanho, quantidade::float AS quantidade, localizacao, ean
       FROM estoque_variantes WHERE produto_id = ANY($1) AND ativo
      ORDER BY produto_id, cor, tamanho`,
    [produtoIds]
  );
  const mapa = new Map();
  for (const v of rows) {
    if (!mapa.has(v.produto_id)) mapa.set(v.produto_id, []);
    mapa.get(v.produto_id).push({ id: v.id, cor: v.cor, tamanho: v.tamanho, quantidade: v.quantidade, localizacao: v.localizacao, ean: v.ean });
  }
  return mapa;
}

// O que a lista automática dá HOJE (prévia na tela e geração da ocorrência).
async function previaFiltro(filtro) {
  const f = normalizarFiltroProdutos(filtro);
  const itens = (await catalogo()).filter((i) => casaFiltro(i, f));
  return {
    referencias: itens.length,
    variantes: itens.reduce((s, i) => s + (i.variantes || 0), 0),
    exemplos: itens.slice(0, 8).map((i) => i.referencia),
    itens,
  };
}

// Produtos de UMA ocorrência, congelados no momento em que ela nasce.
async function resolverProdutos(modelo, linhasFixas) {
  let porProduto; // produtoId -> null (referência inteira) | Set(varianteId)
  let info = new Map();
  if (modelo.modoProdutos === 'automatica') {
    const { itens } = await previaFiltro(modelo.filtroProdutos);
    porProduto = new Map(itens.slice(0, LIMITE_PRODUTOS_AUTOMATICOS).map((i) => [i.id, null]));
    info = new Map(itens.map((i) => [i.id, i]));
  } else {
    porProduto = new Map();
    for (const l of linhasFixas) {
      if (l.variante_id == null) porProduto.set(l.produto_id, null);
      else if (porProduto.get(l.produto_id) !== null) {
        if (!porProduto.has(l.produto_id)) porProduto.set(l.produto_id, new Set());
        porProduto.get(l.produto_id).add(l.variante_id);
      }
    }
  }
  const ids = [...porProduto.keys()];
  if (!ids.length) return [];
  if (!info.size) {
    const { rows } = await pool.query(
      `SELECT p.id, p.referencia, p.descricao, COALESCE(NULLIF(p.marca, ''), p.wik_marca) AS marca,
              EXISTS (SELECT 1 FROM produto_fotos f WHERE f.produto_id = p.id) AS tem_foto,
              (SELECT a.foto_url FROM anuncios_marketplace a WHERE a.produto_id = p.id AND a.foto_url IS NOT NULL ORDER BY a.id LIMIT 1) AS foto_url
         FROM produtos p WHERE p.id = ANY($1)`,
      [ids]
    );
    info = new Map(rows.map((r) => [r.id, { referencia: r.referencia, descricao: r.descricao, marca: marcaCanonica(r.marca), temFoto: r.tem_foto, fotoUrl: r.tem_foto ? null : r.foto_url }]));
  }
  const variantes = await variantesDe(ids);
  return ids.filter((id) => info.has(id)).map((id) => {
    const i = info.get(id);
    const escolhidas = porProduto.get(id);
    const vs = (variantes.get(id) || []).filter((v) => !escolhidas || escolhidas.has(v.id));
    return {
      produtoId: id, referencia: i.referencia, descricao: i.descricao, marca: i.marca, temFoto: i.temFoto, fotoUrl: i.fotoUrl,
      variantes: vs.map(({ ean, ...v }) => v),
    };
  }).sort((a, b) => a.referencia.localeCompare(b.referencia, 'pt-BR', { numeric: true }));
}

// As "chaves" de produto de uma ocorrência: uma por variante; referência sem
// variante nenhuma vira uma chave só.
function chavesDeProduto(produtos) {
  const out = [];
  for (const p of produtos || []) {
    if (p.variantes?.length) for (const v of p.variantes) out.push({ chave: `v${v.id}`, produtoId: p.produtoId, varianteId: v.id, produto: p, variante: v });
    else out.push({ chave: `p${p.produtoId}`, produtoId: p.produtoId, varianteId: null, produto: p, variante: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geração das ocorrências
// ---------------------------------------------------------------------------
function snapshotDoModelo(m) {
  return {
    titulo: m.titulo, instrucaoHtml: m.instrucaoHtml, motivo: m.motivo, setor: m.setor, marcas: m.marcas, canais: m.canais,
    anexos: m.anexos, prioridade: m.prioridade, horaLimite: m.horaLimite, minutosEstimados: m.minutosEstimados,
    conferirDepois: m.conferirDepois, conferenteId: m.conferenteId, correcaoAutomatica: m.correcaoAutomatica,
    lembreteMin: m.lembreteMin, modoAtribuicao: m.modoAtribuicao, responsaveis: m.responsaveis, avulsa: m.avulsa,
    passos: m.passos,
  };
}

// Prazo = dia + horário limite em Brasília; sem horário, o fim do dia.
function sqlPrazo(diaParam, horaParam) {
  return `((${diaParam}::date + COALESCE(${horaParam}::time, time '23:59')) AT TIME ZONE '${FUSO}')`;
}

// Gera as ocorrências de `dia`. Opções:
//   usuarioId  — só as vagas desta pessoa (abertura do "Meu dia")
//   modeloIds  — só estes modelos
//   forcar     — cria mesmo se a recorrência não cair neste dia ("criar agora")
//   origemOcorrenciaId — liga a ocorrência à que a originou (correção)
async function gerarDia(dia, { usuarioId = null, modeloIds = null, forcar = false, origemOcorrenciaId = null } = {}) {
  const valores = [];
  let where = "m.status = 'ativo'";
  if (modeloIds) { valores.push(modeloIds); where += ` AND m.id = ANY($${valores.length})`; }
  if (usuarioId) { valores.push(JSON.stringify([usuarioId])); where += ` AND m.responsaveis @> $${valores.length}::jsonb`; }
  const { rows: modelos } = await pool.query(`SELECT * FROM rotina_modelos m WHERE ${where}`, valores);
  let criadas = 0;
  for (const linha of modelos) {
    if (!forcar && !rec.ocorreEm(linha.recorrencia, dia)) continue;
    const responsaveis = linha.responsaveis || [];
    let vagas = linha.modo_atribuicao === 'cada_um' ? responsaveis : [0];
    if (usuarioId && linha.modo_atribuicao === 'cada_um') vagas = vagas.filter((v) => v === usuarioId);
    if (!vagas.length) continue;
    const { rows: existentes } = await pool.query('SELECT vaga FROM rotina_ocorrencias WHERE modelo_id = $1 AND data = $2', [linha.id, dia]);
    const faltam = vagas.filter((v) => !existentes.some((e) => e.vaga === v));
    if (!faltam.length) continue;

    const modelo = await carregarModelo(linha.id);
    const { rows: fixas } = await pool.query('SELECT produto_id, variante_id FROM rotina_modelo_produtos WHERE modelo_id = $1', [linha.id]);
    const produtos = await resolverProdutos(modelo, fixas);
    const snapshot = snapshotDoModelo(modelo);
    for (const vaga of faltam) {
      const { rowCount } = await pool.query(
        `INSERT INTO rotina_ocorrencias (modelo_id, data, vaga, responsavel_id, prazo, snapshot, produtos_resolvidos, origem_ocorrencia_id)
         VALUES ($1, $2, $3, $4, ${sqlPrazo('$2', '$5')}, $6, $7, $8)
         ON CONFLICT (modelo_id, data, vaga) DO NOTHING`,
        [linha.id, dia, vaga, vaga || null, modelo.horaLimite, JSON.stringify(snapshot), JSON.stringify(produtos), origemOcorrenciaId]
      );
      criadas += rowCount;
    }
  }
  return { dia, criadas };
}

// Job: uma passada a cada 15 min; a primeira depois da virada do dia gera
// tudo, as outras não encontram nada a fazer (idempotente). Advisory lock
// para duas instâncias no overlap do deploy não correrem juntas.
const LOCK_ROTINAS = 778_015_102;
async function jobGerarDoDia() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ROTINAS]);
    if (!rows[0].ok) return { pulado: true };
    try {
      return await gerarDia(hojeEmBrasilia());
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ROTINAS]);
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------
function fotosDe(valor) {
  return idsInteiros(valor?.fotos);
}

// Uma resposta conta como respondida?
function respondida(passo, valor) {
  if (!valor) return false;
  switch (passo.tipo) {
    case 'feito': return valor.feito === true;
    case 'sim_nao': return valor.resposta === 'sim' || valor.resposta === 'nao';
    case 'ok_problema': return valor.resposta === 'ok' || valor.resposta === 'problema';
    case 'numero': return typeof valor.numero === 'number' && Number.isFinite(valor.numero);
    case 'texto': return Boolean(textoLimpo(valor.texto));
    case 'escolha': return Boolean(valor.opcao) && (passo.opcoes || []).includes(valor.opcao);
    case 'foto': return fotosDe(valor).length > 0;
    default: return false;
  }
}

// Normaliza o valor que a tela mandou e decide se é "problema".
// `estoqueSistema` só existe em passo por produto com faixa de estoque.
function avaliarResposta(passo, entrada, { estoqueSistema = null } = {}) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const valor = {};
  const fotos = fotosDe(e);
  if (fotos.length) valor.fotos = fotos.slice(0, 6);
  let problema = false;
  switch (passo.tipo) {
    case 'feito':
      if (e.feito === true) valor.feito = true;
      break;
    case 'sim_nao':
      if (e.resposta === 'sim' || e.resposta === 'nao') valor.resposta = e.resposta;
      problema = valor.resposta === 'nao';
      break;
    case 'ok_problema':
      if (e.resposta === 'ok' || e.resposta === 'problema') valor.resposta = e.resposta;
      problema = valor.resposta === 'problema';
      break;
    case 'numero': {
      if (e.numero !== '' && e.numero != null) {
        const n = Number(String(e.numero).replace(',', '.'));
        if (!Number.isFinite(n)) throw new ErroRotina('Digite um número.');
        valor.numero = n;
        const f = passo.faixa;
        if (f?.estoque) {
          if (estoqueSistema != null) {
            valor.sistema = estoqueSistema;
            problema = Math.abs(n - estoqueSistema) > (Number(f.tolerancia) || 0);
          }
        } else if (f) {
          problema = (f.min != null && n < f.min) || (f.max != null && n > f.max);
        }
      }
      break;
    }
    case 'texto':
      if (textoLimpo(e.texto)) valor.texto = textoLimpo(e.texto, 500);
      break;
    case 'escolha':
      if (e.opcao && (passo.opcoes || []).includes(e.opcao)) valor.opcao = e.opcao;
      else if (e.opcao) throw new ErroRotina('Essa opção não existe neste passo.');
      break;
    case 'foto':
      break;
    default:
      throw new ErroRotina('Tipo de passo desconhecido.');
  }
  if (e.nota) valor.nota = textoLimpo(e.nota, 300);
  return { valor, problema };
}

// O que falta para concluir. Lista vazia = pode concluir.
function faltasParaConcluir(snapshot, produtos, respostas) {
  const mapa = new Map(respostas.map((r) => [`${r.passo_id}|${r.chave_produto}`, r]));
  const chaves = chavesDeProduto(produtos);
  const faltas = [];
  for (const passo of snapshot.passos || []) {
    const alvos = passo.porProduto ? chaves : [{ chave: '' }];
    for (const a of alvos) {
      const r = mapa.get(`${passo.id}|${a.chave}`);
      const feita = r && respondida(passo, r.valor);
      const rotulo = a.produto ? `${a.produto.referencia}${a.variante ? ` · ${[a.variante.cor, a.variante.tamanho].filter(Boolean).join(' · ')}` : ''}` : null;
      const base = { passoId: passo.id, chave: a.chave, passo: passo.texto, produto: rotulo };
      if (!feita) {
        if (passo.obrigatorio) faltas.push({ ...base, motivo: passo.tipo === 'foto' ? 'falta a foto' : 'falta responder' });
        continue;
      }
      const nFotos = fotosDe(r.valor).length;
      if (passo.provaFoto === 'sempre' && nFotos === 0) faltas.push({ ...base, motivo: 'falta a foto de prova' });
      else if (passo.provaFoto === 'problema' && r.problema && nFotos === 0) faltas.push({ ...base, motivo: 'deu problema — falta a foto' });
    }
  }
  return faltas;
}

// Progresso "X de Y" (conta cada passo OBRIGATÓRIO × produto; o opcional
// não entra, senão a barra nunca chegaria ao fim sem ele).
function progresso(snapshot, produtos, respostas) {
  const nChaves = Math.max(1, chavesDeProduto(produtos).length);
  const mapa = new Map(respostas.map((r) => [`${r.passo_id}|${r.chave_produto}`, r]));
  let total = 0;
  let feitos = 0;
  for (const passo of (snapshot.passos || []).filter((p) => p.obrigatorio)) {
    const n = passo.porProduto ? nChaves : 1;
    total += n;
    if (passo.porProduto) {
      for (const c of chavesDeProduto(produtos)) {
        const r = mapa.get(`${passo.id}|${c.chave}`);
        if (r && respondida(passo, r.valor)) feitos += 1;
      }
    } else {
      const r = mapa.get(`${passo.id}|`);
      if (r && respondida(passo, r.valor)) feitos += 1;
    }
  }
  return { feitos, total };
}

// ---------------------------------------------------------------------------
// Acesso a uma ocorrência
// ---------------------------------------------------------------------------
function podeExecutar(user, oc) {
  if (!user || !oc) return false;
  if (user.role === 'admin') return true;
  if (oc.responsavel_id === user.id) return true;
  return oc.vaga === 0 && oc.responsavel_id == null && (oc.snapshot?.responsaveis || []).includes(user.id);
}

function situacao(oc, agora = new Date()) {
  const atrasada = ABERTOS.includes(oc.status) && new Date(oc.prazo) < agora;
  return { atrasada };
}

module.exports = {
  SETORES, MARCAS, CANAIS, TIPOS_PASSO, PROVAS, PRIORIDADES, PESO_PRIORIDADE, ABERTOS, MOTIVOS_NAO_FEITA,
  ErroRotina, sanitizarInstrucao, escaparHtml, normalizarModelo, salvarModelo, carregarModelo, linhaParaPasso,
  catalogo, previaFiltro, variantesDe, resolverProdutos, chavesDeProduto, curvasAbc, limparCacheCurva,
  snapshotDoModelo, gerarDia, jobGerarDoDia, sqlPrazo,
  respondida, avaliarResposta, faltasParaConcluir, progresso, fotosDe, podeExecutar, situacao,
  marcaCanonica, casaFiltro, normalizarFiltroProdutos,
};
