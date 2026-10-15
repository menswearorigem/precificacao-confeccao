// Rotinas (15/10/2026) — /api/rotinas
//
// Montada em app.js com requireAuth + requireModulo('rotinas'). Dentro:
//   · o que é da EQUIPE (Meu dia, abrir/responder/concluir a própria tarefa,
//     fotos, avisos) vale para quem tem o módulo;
//   · o que é de ADMINISTRADOR (Equipe, Modelos, tarefa avulsa, conferência,
//     catálogo para montar a tarefa) passa por requireAdmin, rota a rota.
// "Administrador" é o mesmo do resto do Hub: usuarios.role = 'admin'.

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const r = require('../lib/rotinas');
const rec = require('../lib/rotinasRecorrencia');
const { hojeEmBrasilia } = require('../lib/dataBrasil');

const router = express.Router();

// Erro de regra (ErroRotina) vira resposta com a frase pronta para a tela.
const a = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof r.ErroRotina) {
      const { status, message, ...extra } = err;
      return res.status(status || 400).json({ error: message, ...extra });
    }
    if (err && err.regra) return res.status(400).json({ error: err.message });
    return next(err);
  }
};

const ehAdmin = (req) => req.user?.role === 'admin';

// ---------------------------------------------------------------------------
// Leitura de ocorrências
// ---------------------------------------------------------------------------
const COLUNAS_OC = `o.id, o.modelo_id, to_char(o.data, 'YYYY-MM-DD') AS data, o.vaga, o.responsavel_id, o.prazo, o.status,
  o.motivo_nao_feita, o.motivo_texto, o.observacao, o.snapshot, o.produtos_resolvidos, o.origem_ocorrencia_id,
  o.iniciada_em, o.concluida_em, o.concluida_por, o.conferida_por, o.conferida_em, o.comentario_conferencia, o.devolvida_em,
  u.nome AS responsavel_nome, uc.nome AS concluida_por_nome, uf.nome AS conferida_por_nome, m.status AS modelo_status`;
const JOINS_OC = `FROM rotina_ocorrencias o
  JOIN rotina_modelos m ON m.id = o.modelo_id
  LEFT JOIN usuarios u ON u.id = o.responsavel_id
  LEFT JOIN usuarios uc ON uc.id = o.concluida_por
  LEFT JOIN usuarios uf ON uf.id = o.conferida_por`;

async function respostasDe(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT rr.id, rr.ocorrencia_id, rr.passo_id, rr.chave_produto, rr.produto_id, rr.variante_id, rr.valor, rr.problema,
            rr.respondido_por, rr.respondido_em, u.nome AS respondido_por_nome
       FROM rotina_respostas rr LEFT JOIN usuarios u ON u.id = rr.respondido_por
      WHERE rr.ocorrencia_id = ANY($1)`,
    [ids]
  );
  const mapa = new Map(ids.map((id) => [id, []]));
  for (const x of rows) mapa.get(x.ocorrencia_id).push(x);
  return mapa;
}

// A linha compacta (listas do Meu dia e da Equipe).
function resumo(oc, respostas, agora = new Date()) {
  const s = oc.snapshot || {};
  const prog = r.progresso(s, oc.produtos_resolvidos, respostas);
  const nVariantes = r.chavesDeProduto(oc.produtos_resolvidos).length;
  const pedeFoto = (s.passos || []).some((p) => p.tipo === 'foto' || p.provaFoto === 'sempre');
  return {
    id: oc.id,
    modeloId: oc.modelo_id,
    titulo: s.titulo,
    setor: s.setor,
    prioridade: s.prioridade,
    data: oc.data,
    prazo: oc.prazo,
    horaLimite: s.horaLimite,
    status: oc.status,
    atrasada: r.situacao(oc, agora).atrasada,
    responsavelId: oc.responsavel_id,
    responsavelNome: oc.responsavel_nome || (r.ehDividida(oc) ? 'Equipe (dividida)' : r.ehCompartilhada(oc) ? 'Qualquer um' : null),
    dividida: r.ehDividida(oc),
    compartilhada: r.ehCompartilhada(oc),
    horario: s.horario || null,
    nProdutos: (oc.produtos_resolvidos || []).length,
    nVariantes,
    progresso: prog,
    pedeFoto,
    problemas: respostas.filter((x) => x.problema).length,
    fotos: respostas.reduce((n, x) => n + r.fotosDe(x.valor).length, 0),
    conferir: Boolean(s.conferirDepois),
    concluidaEm: oc.concluida_em,
    noPrazo: oc.concluida_em ? new Date(oc.concluida_em) <= new Date(oc.prazo) : null,
    comentarioConferencia: oc.comentario_conferencia,
    motivoNaoFeita: oc.motivo_nao_feita ? (r.MOTIVOS_NAO_FEITA[oc.motivo_nao_feita] || oc.motivo_nao_feita) : null,
    lembreteMin: s.lembreteMin || null,
    correcao: Boolean(oc.origem_ocorrencia_id),
  };
}

function ordenarLista(itens) {
  return itens.sort((x, y) => (Number(y.atrasada) - Number(x.atrasada))
    || (Number(y.status === 'devolvida') - Number(x.status === 'devolvida'))
    || new Date(x.prazo) - new Date(y.prazo)
    || (r.PESO_PRIORIDADE[x.prioridade] - r.PESO_PRIORIDADE[y.prioridade])
    || String(x.titulo).localeCompare(String(y.titulo), 'pt-BR'));
}

async function carregarOcorrencia(id) {
  const { rows } = await pool.query(`SELECT ${COLUNAS_OC} ${JOINS_OC} WHERE o.id = $1`, [id]);
  return rows[0] || null;
}

// Estoque AO VIVO das variantes (passo "comparar com o estoque").
async function estoqueAgora(varianteIds) {
  if (!varianteIds.length) return new Map();
  const { rows } = await pool.query('SELECT id, quantidade::float AS q FROM estoque_variantes WHERE id = ANY($1)', [varianteIds]);
  return new Map(rows.map((x) => [x.id, x.q]));
}

async function detalhe(oc, user) {
  const respostas = (await respostasDe([oc.id])).get(oc.id);
  const s = oc.snapshot || {};
  const chaves = r.chavesDeProduto(oc.produtos_resolvidos);
  const atual = await estoqueAgora(chaves.filter((c) => c.varianteId).map((c) => c.varianteId));
  const produtos = (oc.produtos_resolvidos || []).map((p) => ({
    ...p,
    variantes: [...(p.variantes || [])].sort(r.compararVariante).map((v) => ({ ...v, quantidadeAgora: atual.has(v.id) ? atual.get(v.id) : null })),
  }));
  const idsFotos = [...new Set([...respostas.flatMap((x) => r.fotosDe(x.valor)), ...(s.anexos?.imagens || [])])];
  const { rows: fotos } = idsFotos.length
    ? await pool.query('SELECT id, hash, largura, altura FROM rotina_fotos WHERE id = ANY($1)', [idsFotos])
    : { rows: [] };
  let origem = null;
  if (oc.origem_ocorrencia_id) {
    const { rows } = await pool.query("SELECT id, snapshot->>'titulo' AS titulo, to_char(data, 'YYYY-MM-DD') AS data FROM rotina_ocorrencias WHERE id = $1", [oc.origem_ocorrencia_id]);
    origem = rows[0] || null;
  }
  const podeAgir = r.podeExecutar(user, oc) && r.ABERTOS.includes(oc.status);
  return {
    ...resumo(oc, respostas),
    instrucaoHtml: s.instrucaoHtml,
    motivo: s.motivo,
    anexos: s.anexos || { links: [], imagens: [] },
    marcas: s.marcas || [],
    canais: s.canais || [],
    minutosEstimados: s.minutosEstimados,
    passos: s.passos || [],
    produtos,
    respostas: respostas.map((x) => ({
      passoId: x.passo_id, chave: x.chave_produto, valor: x.valor, problema: x.problema, respondidoEm: x.respondido_em,
      respondidoPor: x.respondido_por, respondidoPorNome: x.respondido_por_nome,
    })),
    fotos: Object.fromEntries(fotos.map((f) => [f.id, { hash: f.hash, largura: f.largura, altura: f.altura }])),
    observacao: oc.observacao,
    motivoTexto: oc.motivo_texto,
    concluidaPorNome: oc.concluida_por_nome,
    conferidaPorNome: oc.conferida_por_nome,
    conferidaEm: oc.conferida_em,
    devolvidaEm: oc.devolvida_em,
    origem,
    faltas: r.faltasParaConcluir(s, oc.produtos_resolvidos, respostas),
    podeResponder: podeAgir,
    podeConferir: ehAdmin({ user }) && oc.status === 'aguardando_conferencia',
  };
}

async function exigirOcorrencia(req, { paraAgir = false } = {}) {
  const oc = await carregarOcorrencia(Number(req.params.id));
  if (!oc) throw new r.ErroRotina('Tarefa não encontrada.', 404);
  if (!ehAdmin(req) && !r.podeExecutar(req.user, oc)) throw new r.ErroRotina('Essa tarefa não é sua.', 403);
  if (paraAgir && !r.ABERTOS.includes(oc.status)) {
    throw new r.ErroRotina(oc.status === 'aguardando_conferencia' ? 'Essa tarefa já foi entregue e está aguardando conferência.' : 'Essa tarefa já foi encerrada.', 409);
  }
  return oc;
}

// Pega a tarefa compartilhada (o primeiro que mexe fica com ela) e marca o
// começo. Idempotente.
async function iniciar(oc, user) {
  const pegar = r.ehCompartilhada(oc) && !r.ehDividida(oc) && oc.responsavel_id == null && user.role !== 'admin' ? user.id : null;
  const { rows } = await pool.query(
    `UPDATE rotina_ocorrencias
        SET status = CASE WHEN status = 'pendente' THEN 'em_andamento' ELSE status END,
            iniciada_em = COALESCE(iniciada_em, now()),
            responsavel_id = COALESCE(responsavel_id, $2),
            updated_at = now()
      WHERE id = $1 AND (responsavel_id IS NULL OR $2::int IS NULL OR responsavel_id = $2)
      RETURNING responsavel_id`,
    [oc.id, pegar]
  );
  if (!rows.length) throw new r.ErroRotina('Outra pessoa já pegou essa tarefa.', 409);
}

// ---------------------------------------------------------------------------
// MEU DIA
// ---------------------------------------------------------------------------
function condicaoMinha(param) {
  return `(o.responsavel_id = $${param} OR (o.snapshot->>'modoAtribuicao' IN ('qualquer_um', 'dividir') AND o.responsavel_id IS NULL AND o.snapshot->'responsaveis' @> to_jsonb(ARRAY[$${param}::int])))`;
}

// Prévia de dias futuros (sem gerar nada): o que a recorrência promete.
async function previaFutura(usuarioId, de, ate) {
  const { rows } = await pool.query(
    `SELECT id, titulo, prioridade, hora_limite, recorrencia, setor, modo_atribuicao
       FROM rotina_modelos WHERE status = 'ativo' AND responsaveis @> to_jsonb(ARRAY[$1::int])`,
    [usuarioId]
  );
  const itens = [];
  for (const m of rows) {
    for (const dia of rec.proximas(m.recorrencia, de, 14)) {
      if (dia > ate) break;
      const horas = m.recorrencia?.horarios || [m.hora_limite ? String(m.hora_limite).slice(0, 5) : null];
      for (const h of horas) {
        itens.push({
          modeloId: m.id, titulo: m.titulo, prioridade: m.prioridade, setor: m.setor, data: dia,
          horaLimite: h, compartilhada: m.modo_atribuicao !== 'cada_um', dividida: m.modo_atribuicao === 'dividir',
        });
      }
    }
  }
  return itens.sort((x, y) => x.data.localeCompare(y.data) || String(x.horaLimite || '99').localeCompare(String(y.horaLimite || '99')));
}

router.get('/meu-dia', a(async (req, res) => {
  const hoje = hojeEmBrasilia();
  await r.gerarDia(hoje, { usuarioId: req.user.id });
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_OC} ${JOINS_OC}
      WHERE ${condicaoMinha(1)}
        AND (o.data = $2::date
             OR o.status IN ('pendente', 'em_andamento', 'devolvida')
             OR (o.concluida_em AT TIME ZONE 'America/Sao_Paulo')::date = $2::date)
      ORDER BY o.prazo
      LIMIT 300`,
    [req.user.id, hoje]
  );
  const respostas = await respostasDe(rows.map((x) => x.id));
  const agora = new Date();
  const itens = rows.map((oc) => resumo(oc, respostas.get(oc.id), agora));
  const abertas = ordenarLista(itens.filter((x) => r.ABERTOS.includes(x.status)));
  const feitas = itens.filter((x) => !r.ABERTOS.includes(x.status)).sort((x, y) => new Date(y.concluidaEm || 0) - new Date(x.concluidaEm || 0));
  const lembretes = abertas.filter((x) => !x.atrasada && x.lembreteMin
    && new Date(x.prazo).getTime() - agora.getTime() <= x.lembreteMin * 60000)
    .map((x) => ({ id: x.id, titulo: x.titulo, minutos: Math.max(0, Math.round((new Date(x.prazo) - agora) / 60000)) }));

  let futuro = [];
  if (req.query.ver === 'amanha' || req.query.ver === 'semana') {
    const de = rec.somarDias(hoje, 1);
    futuro = await previaFutura(req.user.id, de, req.query.ver === 'amanha' ? de : rec.somarDias(hoje, 7));
  }
  res.json({
    hoje,
    contadores: {
      atrasadas: abertas.filter((x) => x.atrasada).length,
      paraHoje: abertas.filter((x) => !x.atrasada).length,
      feitas: feitas.filter((x) => x.status === 'concluida' || x.status === 'aguardando_conferencia').length,
    },
    abertas,
    feitas,
    lembretes,
    futuro,
  });
}));

// Avisos para o sino (a cada 5 min): lembretes e atrasos da pessoa; para o
// administrador, também o que espera conferência e o atraso da equipe.
router.get('/avisos', a(async (req, res) => {
  const agora = new Date();
  const itens = [];
  const { rows } = await pool.query(
    `SELECT o.id, o.prazo, o.snapshot->>'titulo' AS titulo, (o.snapshot->>'lembreteMin')::int AS lembrete
       FROM rotina_ocorrencias o
      WHERE ${condicaoMinha(1)} AND o.status IN ('pendente', 'em_andamento', 'devolvida')
      ORDER BY o.prazo LIMIT 50`,
    [req.user.id]
  );
  const atrasadas = rows.filter((x) => new Date(x.prazo) < agora);
  if (atrasadas.length) {
    itens.push({ chave: 'rotinas-atrasadas', nivel: 'urgente', titulo: `${atrasadas.length} ${atrasadas.length === 1 ? 'tarefa atrasada' : 'tarefas atrasadas'}`, resumo: atrasadas.slice(0, 2).map((x) => x.titulo).join(' · '), rota: '/rotinas' });
  }
  for (const x of rows) {
    const min = (new Date(x.prazo) - agora) / 60000;
    if (x.lembrete && min >= 0 && min <= x.lembrete) {
      itens.push({ chave: `rotina-${x.id}`, nivel: 'atencao', titulo: x.titulo, resumo: `vence em ${Math.round(min)} min`, rota: `/rotinas/tarefa/${x.id}` });
    }
  }
  if (ehAdmin(req)) {
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'aguardando_conferencia')::int AS conferir,
              COUNT(*) FILTER (WHERE status IN ('pendente', 'em_andamento', 'devolvida') AND prazo < now())::int AS atrasadas
         FROM rotina_ocorrencias`
    );
    if (c.conferir) itens.push({ chave: 'rotinas-conferir', nivel: 'atencao', titulo: `${c.conferir} ${c.conferir === 1 ? 'tarefa aguardando' : 'tarefas aguardando'} conferência`, resumo: 'aprovar ou devolver', rota: '/rotinas/equipe?painel=conferir' });
    if (c.atrasadas) itens.push({ chave: 'rotinas-equipe-atrasadas', nivel: 'urgente', titulo: `Equipe: ${c.atrasadas} ${c.atrasadas === 1 ? 'tarefa atrasada' : 'tarefas atrasadas'}`, resumo: 'passaram do horário limite', rota: '/rotinas/equipe?painel=atrasadas' });
  }
  res.json({ itens });
}));

// ---------------------------------------------------------------------------
// Uma tarefa: abrir, responder, concluir, não fazer
// ---------------------------------------------------------------------------
router.get('/ocorrencias/:id', a(async (req, res) => {
  const oc = await exigirOcorrencia(req);
  res.json(await detalhe(oc, req.user));
}));

router.put('/ocorrencias/:id/respostas', a(async (req, res) => {
  const oc = await exigirOcorrencia(req, { paraAgir: true });
  const passoId = Number(req.body.passoId);
  const passo = (oc.snapshot.passos || []).find((p) => p.id === passoId);
  if (!passo) throw new r.ErroRotina('Esse passo não existe nesta tarefa.');
  const chave = passo.porProduto ? String(req.body.chave || '') : '';
  let alvo = null;
  if (passo.porProduto) {
    alvo = r.chavesDeProduto(oc.produtos_resolvidos).find((c) => c.chave === chave);
    if (!alvo) throw new r.ErroRotina('Esse produto não faz parte desta tarefa.');
  }
  // Fotos só desta tarefa.
  const fotos = r.fotosDe(req.body.valor);
  if (fotos.length) {
    const { rows } = await pool.query('SELECT id FROM rotina_fotos WHERE id = ANY($1) AND ocorrencia_id = $2', [fotos, oc.id]);
    if (rows.length !== fotos.length) throw new r.ErroRotina('Alguma foto não é desta tarefa. Tire de novo.');
  }
  let estoqueSistema = null;
  if (passo.faixa?.estoque && alvo?.varianteId) estoqueSistema = (await estoqueAgora([alvo.varianteId])).get(alvo.varianteId) ?? null;
  const { valor, problema } = r.avaliarResposta(passo, req.body.valor, { estoqueSistema });
  // Recontagem fica registrada (uso real, 15/10/2026): com a contagem às
  // cegas, quem conta vê o aviso de "problema" e podia digitar outro número
  // até o aviso sumir, sem rastro. Agora o número anterior fica guardado e o
  // administrador vê "contou 80 → recontou 87".
  if (passo.tipo === 'numero') {
    const { rows: [ant] } = await pool.query(
      'SELECT valor, problema, respondido_em FROM rotina_respostas WHERE ocorrencia_id = $1 AND passo_id = $2 AND chave_produto = $3',
      [oc.id, passo.id, chave]
    );
    const antes = Array.isArray(ant?.valor?.antes) ? ant.valor.antes : [];
    if (typeof ant?.valor?.numero === 'number' && ant.valor.numero !== valor.numero) {
      valor.antes = [...antes, { numero: ant.valor.numero, problema: ant.problema, em: ant.respondido_em }].slice(-5);
    } else if (antes.length) {
      valor.antes = antes;
    }
  }

  // Tarefa dividida: o passo que outra pessoa já fez fica com ela. Sem isto,
  // dois que abrissem a tarefa ao mesmo tempo podiam apagar o "feito" um do
  // outro. Administrador pode corrigir.
  if (r.ehDividida(oc) && !ehAdmin(req)) {
    const { rows: [dono] } = await pool.query(
      `SELECT rr.respondido_por, rr.valor, u.nome FROM rotina_respostas rr LEFT JOIN usuarios u ON u.id = rr.respondido_por
        WHERE rr.ocorrencia_id = $1 AND rr.passo_id = $2 AND rr.chave_produto = $3`,
      [oc.id, passo.id, chave]
    );
    if (dono && dono.respondido_por !== req.user.id && r.respondida(passo, dono.valor)) {
      throw new r.ErroRotina(`Esse passo já foi feito por ${dono.nome || 'outra pessoa'}.`, 409);
    }
  }
  await iniciar(oc, req.user);
  const { rows: [resp] } = await pool.query(
    `INSERT INTO rotina_respostas (ocorrencia_id, passo_id, chave_produto, produto_id, variante_id, valor, problema, respondido_por, respondido_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (ocorrencia_id, passo_id, chave_produto)
     DO UPDATE SET valor = EXCLUDED.valor, problema = EXCLUDED.problema, respondido_por = EXCLUDED.respondido_por, respondido_em = now()
     RETURNING id`,
    [oc.id, passo.id, chave, alvo?.produtoId || null, alvo?.varianteId || null, JSON.stringify(valor), problema, req.user.id]
  );
  if (fotos.length) await pool.query('UPDATE rotina_fotos SET resposta_id = $1, passo_id = $2, chave_produto = $3 WHERE id = ANY($4)', [resp.id, passo.id, chave, fotos]);

  const respostas = (await respostasDe([oc.id])).get(oc.id);
  res.json({
    resposta: { passoId: passo.id, chave, valor, problema },
    progresso: r.progresso(oc.snapshot, oc.produtos_resolvidos, respostas),
    faltas: r.faltasParaConcluir(oc.snapshot, oc.produtos_resolvidos, respostas),
  });
}));

// A correção automática: uma tarefa avulsa nova, para hoje, com os produtos
// que deram problema e as fotos que provaram.
async function criarCorrecao(oc, respostas, user) {
  const s = oc.snapshot;
  const responsavelId = s.correcaoAutomatica?.responsavelId;
  const comProblema = respostas.filter((x) => x.problema);
  if (!responsavelId || !comProblema.length) return null;
  // Entrega devolvida e reentregue não abre segunda correção.
  const { rows: ja } = await pool.query('SELECT 1 FROM rotina_ocorrencias WHERE origem_ocorrencia_id = $1 LIMIT 1', [oc.id]);
  if (ja.length) return null;
  const chaves = new Map(r.chavesDeProduto(oc.produtos_resolvidos).map((c) => [c.chave, c]));
  const passos = new Map((s.passos || []).map((p) => [p.id, p]));
  const linhas = comProblema.map((x) => {
    const p = passos.get(x.passo_id);
    const c = chaves.get(x.chave_produto);
    const prod = c ? `${c.produto.referencia}${c.variante ? ` · ${[c.variante.cor, c.variante.tamanho].filter(Boolean).join(' · ')}` : ''} — ` : '';
    const v = x.valor || {};
    let resposta = v.resposta === 'nao' ? 'Não' : v.resposta === 'problema' ? 'Problema' : v.numero != null ? `${v.numero}${p?.unidade ? ` ${p.unidade}` : ''}${v.sistema != null ? ` (sistema: ${v.sistema})` : ''}` : '';
    if (v.nota) resposta += ` · "${v.nota}"`;
    return `<li>${r.escaparHtml(prod)}${r.escaparHtml(p?.texto || 'passo')}: <b>${r.escaparHtml(resposta)}</b></li>`;
  });
  const [, mes, dia] = oc.data.split('-');
  const instrucao = `<p>Na tarefa <b>${r.escaparHtml(s.titulo)}</b> de ${dia}/${mes}, <b>${r.escaparHtml(user.nome)}</b> registrou problema em:</p><ul>${linhas.join('')}</ul><p>Resolva e conte o que foi feito.</p>`;
  const produtos = [];
  for (const x of comProblema) {
    const c = chaves.get(x.chave_produto);
    if (c && !produtos.some((p) => p.produtoId === c.produtoId && p.varianteId === c.varianteId)) produtos.push({ produtoId: c.produtoId, varianteId: c.varianteId });
  }
  const fotos = [...new Set(comProblema.flatMap((x) => r.fotosDe(x.valor)))].slice(0, 3);
  const modelo = await r.normalizarModelo({
    titulo: `Corrigir: ${s.titulo}`.slice(0, 120),
    instrucaoHtml: instrucao,
    motivo: 'Aberta sozinha porque a tarefa de origem registrou problema.',
    setor: s.setor,
    marcas: s.marcas,
    canais: s.canais,
    anexos: { links: [], imagens: [] },
    modoProdutos: 'fixa',
    produtos,
    passos: [
      { texto: 'Problema resolvido', tipo: 'feito', obrigatorio: true, provaFoto: 'nao' },
      { texto: 'O que foi feito', tipo: 'texto', obrigatorio: false, provaFoto: 'nao' },
    ],
    responsaveis: [responsavelId],
    modoAtribuicao: 'cada_um',
    recorrencia: { tipo: 'uma_vez', data: hojeEmBrasilia() },
    prioridade: 'alta',
  }, pool, { avulsa: true });
  const modeloId = await r.salvarModelo(modelo, user.id);
  // As fotos de prova continuam sendo da ocorrência de origem; a correção só
  // as mostra (via snapshot.anexos.imagens) — por isso o UPDATE acima, que
  // liga imagens ao modelo, não as alcança (ocorrencia_id não é nulo).
  await pool.query(`UPDATE rotina_modelos SET anexos = jsonb_set(anexos, '{imagens}', $2::jsonb) WHERE id = $1`, [modeloId, JSON.stringify(fotos)]);
  await r.gerarDia(hojeEmBrasilia(), { modeloIds: [modeloId], forcar: true, origemOcorrenciaId: oc.id });
  return modeloId;
}

// Passos "Marcar feito" que ainda faltam — o "concluir tudo de uma vez".
// Só os de marcar: número, foto, sim/não etc. continuam pedindo resposta.
function feitosPendentes(oc, respostas) {
  const mapa = new Map(respostas.map((x) => [`${x.passo_id}|${x.chave_produto}`, x]));
  const chaves = r.chavesDeProduto(oc.produtos_resolvidos);
  const out = [];
  for (const passo of (oc.snapshot.passos || []).filter((p) => p.tipo === 'feito' && p.provaFoto !== 'sempre')) {
    for (const a of passo.porProduto ? chaves : [{ chave: '', produtoId: null, varianteId: null }]) {
      const x = mapa.get(`${passo.id}|${a.chave}`);
      if (!x || !r.respondida(passo, x.valor)) out.push({ passo, ...a });
    }
  }
  return out;
}

router.post('/ocorrencias/:id/concluir', a(async (req, res) => {
  const oc = await exigirOcorrencia(req, { paraAgir: true });
  let respostas = (await respostasDe([oc.id])).get(oc.id);
  if (req.body.marcarRestantes) {
    const pend = feitosPendentes(oc, respostas);
    for (const p of pend) {
      await pool.query(
        `INSERT INTO rotina_respostas (ocorrencia_id, passo_id, chave_produto, produto_id, variante_id, valor, problema, respondido_por, respondido_em)
         VALUES ($1, $2, $3, $4, $5, '{"feito":true}', FALSE, $6, now())
         ON CONFLICT (ocorrencia_id, passo_id, chave_produto) DO UPDATE SET valor = '{"feito":true}', respondido_por = EXCLUDED.respondido_por, respondido_em = now()`,
        [oc.id, p.passo.id, p.chave, p.produtoId, p.varianteId, req.user.id]
      );
    }
    respostas = (await respostasDe([oc.id])).get(oc.id);
  }
  const faltas = r.faltasParaConcluir(oc.snapshot, oc.produtos_resolvidos, respostas);
  if (faltas.length) {
    throw new r.ErroRotina(`Ainda falta${faltas.length > 1 ? 'm' : ''} ${faltas.length} ${faltas.length === 1 ? 'item' : 'itens'} para concluir.`, 422, { faltas });
  }
  await iniciar(oc, req.user);
  const novo = oc.snapshot.conferirDepois ? 'aguardando_conferencia' : 'concluida';
  const { rowCount } = await pool.query(
    `UPDATE rotina_ocorrencias SET status = $2, concluida_em = now(), concluida_por = $3, observacao = $4, updated_at = now()
      WHERE id = $1 AND status IN ('pendente', 'em_andamento', 'devolvida')`,
    [oc.id, novo, req.user.id, req.body.observacao ? String(req.body.observacao).slice(0, 1000) : null]
  );
  if (!rowCount) throw new r.ErroRotina('Essa tarefa acabou de ser encerrada por outra pessoa.', 409);
  let correcaoModeloId = null;
  try {
    correcaoModeloId = await criarCorrecao(oc, respostas, req.user);
  } catch (err) {
    // A conclusão vale mesmo se a correção não puder ser aberta (ex.: a
    // pessoa da correção foi desativada) — o problema continua na Equipe.
    console.error('[rotinas] correção automática não criada:', err.message);
  }
  res.json({ status: novo, correcaoCriada: Boolean(correcaoModeloId) });
}));

router.post('/ocorrencias/:id/nao-feita', a(async (req, res) => {
  const oc = await exigirOcorrencia(req, { paraAgir: true });
  const motivo = r.MOTIVOS_NAO_FEITA[req.body.motivo] ? req.body.motivo : null;
  if (!motivo) throw new r.ErroRotina('Diga por que não deu para fazer.');
  const texto = String(req.body.texto || '').trim().slice(0, 300);
  if (motivo === 'outro' && !texto) throw new r.ErroRotina('Escreva o motivo.');
  await pool.query(
    `UPDATE rotina_ocorrencias SET status = 'nao_feita', motivo_nao_feita = $2, motivo_texto = $3,
            concluida_em = now(), concluida_por = $4, responsavel_id = COALESCE(responsavel_id, $5), updated_at = now()
      WHERE id = $1`,
    [oc.id, motivo, texto || null, req.user.id, ehAdmin(req) ? null : req.user.id]
  );
  res.json({ status: 'nao_feita' });
}));

// ---------------------------------------------------------------------------
// Conferência (administrador)
// ---------------------------------------------------------------------------
router.post('/ocorrencias/:id/aprovar', requireAdmin, a(async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE rotina_ocorrencias SET status = 'concluida', conferida_por = $2, conferida_em = now(),
            comentario_conferencia = COALESCE($3, comentario_conferencia), updated_at = now()
      WHERE id = $1 AND status = 'aguardando_conferencia'`,
    [Number(req.params.id), req.user.id, req.body.comentario ? String(req.body.comentario).slice(0, 500) : null]
  );
  if (!rowCount) throw new r.ErroRotina('Essa tarefa não está aguardando conferência.', 409);
  res.json({ status: 'concluida' });
}));

router.post('/ocorrencias/:id/devolver', requireAdmin, a(async (req, res) => {
  const comentario = String(req.body.comentario || '').trim();
  if (!comentario) throw new r.ErroRotina('Diga o que precisa ser refeito.');
  const { rowCount } = await pool.query(
    `UPDATE rotina_ocorrencias SET status = 'devolvida', conferida_por = $2, conferida_em = now(),
            comentario_conferencia = $3, devolvida_em = now(), concluida_em = NULL, updated_at = now()
      WHERE id = $1 AND status = 'aguardando_conferencia'`,
    [Number(req.params.id), req.user.id, comentario.slice(0, 500)]
  );
  if (!rowCount) throw new r.ErroRotina('Essa tarefa não está aguardando conferência.', 409);
  res.json({ status: 'devolvida' });
}));

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------
// A foto chega comprimida do navegador (≤ 1280 px, WebP/JPEG) junto com a
// miniatura de 320 px. O limite aqui é a rede de segurança, não o alvo.
const LIMITE_FOTO = 400 * 1024;
const LIMITE_MINI = 80 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITE_FOTO, files: 2 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|webp)$/.test(file.mimetype)),
});
function ehImagem(buffer, mime) {
  if (!buffer || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}

router.post('/fotos', upload.fields([{ name: 'foto', maxCount: 1 }, { name: 'miniatura', maxCount: 1 }]), a(async (req, res) => {
  const foto = req.files?.foto?.[0];
  const mini = req.files?.miniatura?.[0];
  if (!foto || !mini) throw new r.ErroRotina('Envie a foto (JPEG ou WebP) — ela é reduzida no celular antes de subir.');
  if (!ehImagem(foto.buffer, foto.mimetype) || !ehImagem(mini.buffer, mini.mimetype)) throw new r.ErroRotina('Esse arquivo não é uma foto de verdade.');
  if (mini.size > LIMITE_MINI) throw new r.ErroRotina('A miniatura veio grande demais.');

  let ocorrenciaId = null;
  if (req.body.ocorrenciaId) {
    req.params.id = req.body.ocorrenciaId;
    const oc = await exigirOcorrencia(req, { paraAgir: true });
    ocorrenciaId = oc.id;
  } else if (!ehAdmin(req)) {
    throw new r.ErroRotina('Diga de qual tarefa é a foto.');
  }
  const hash = crypto.createHash('sha256').update(foto.buffer).update(crypto.randomBytes(16)).digest('hex');
  const { rows: [f] } = await pool.query(
    `INSERT INTO rotina_fotos (hash, ocorrencia_id, dados, miniatura, mime_type, largura, altura, bytes, enviada_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, hash`,
    [hash, ocorrenciaId, foto.buffer, mini.buffer, foto.mimetype, Number(req.body.largura) || null, Number(req.body.altura) || null, foto.size, req.user.id]
  );
  res.status(201).json({ id: f.id, hash: f.hash });
}));

// Servida por hash (impossível de adivinhar) com cache imutável: o navegador
// nunca pede a mesma foto duas vezes. `private` e não `public`: a foto fica
// atrás do login, então nenhum cache compartilhado no caminho deve guardá-la.
router.get('/fotos/:hash', a(async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.hash)) return res.status(404).end();
  const mini = req.query.t === 'mini';
  const { rows } = await pool.query(`SELECT ${mini ? 'miniatura' : 'dados'} AS b, mime_type FROM rotina_fotos WHERE hash = $1`, [req.params.hash]);
  if (!rows.length) return res.status(404).end();
  res.set('Content-Type', rows[0].mime_type);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  return res.send(rows[0].b);
}));

// Foto do produto para quem executa a tarefa (o /api/produtos exige o módulo
// Produto, que a equipe do galpão nem sempre tem). Só a imagem — nada de
// custo nem preço.
router.get('/produtos/:id/foto', a(async (req, res) => {
  const { rows } = await pool.query('SELECT dados, mime_type FROM produto_fotos WHERE produto_id = $1', [Number(req.params.id)]);
  if (!rows.length) return res.status(404).end();
  const tipo = /^image\/(jpeg|png|webp)$/.test(rows[0].mime_type) ? rows[0].mime_type : 'application/octet-stream';
  res.set('Content-Type', tipo);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=86400');
  return res.send(rows[0].dados);
}));

// ===========================================================================
// ADMINISTRADOR
// ===========================================================================
router.get('/pessoas', requireAdmin, a(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.nome, u.role,
            (u.role = 'admin' OR EXISTS (SELECT 1 FROM usuario_modulos um WHERE um.usuario_id = u.id AND um.modulo = 'rotinas')) AS tem_acesso
       FROM usuarios u WHERE u.ativo ORDER BY u.nome`
  );
  res.json(rows.map((x) => ({ id: x.id, nome: x.nome, admin: x.role === 'admin', temAcesso: x.tem_acesso })));
}));

router.get('/catalogo', requireAdmin, a(async (req, res) => {
  const itens = await r.catalogo();
  const unicos = (k) => [...new Set(itens.map((i) => i[k]).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  res.json({ itens, grupos: unicos('grupo'), subgrupos: unicos('subgrupo'), marcas: r.MARCAS, canais: r.CANAIS });
}));

router.get('/catalogo/:id/variantes', requireAdmin, a(async (req, res) => {
  const id = Number(req.params.id);
  res.json((await r.variantesDe([id])).get(id) || []);
}));

router.post('/previa/produtos', requireAdmin, a(async (req, res) => {
  const { referencias, variantes, exemplos } = await r.previaFiltro(req.body.filtro);
  res.json({ referencias, variantes, exemplos });
}));

router.post('/previa/recorrencia', requireAdmin, a(async (req, res) => {
  const recorrencia = rec.normalizar(req.body.recorrencia);
  const datas = rec.proximas(recorrencia.tipo === 'semanal' && !recorrencia.inicio ? { ...recorrencia, inicio: hojeEmBrasilia() } : recorrencia, hojeEmBrasilia(), 5);
  res.json({ descricao: rec.descrever(recorrencia), datas: datas.map((d) => ({ data: d, feriado: rec.feriado(d) })) });
}));

// --- Modelos ---------------------------------------------------------------
router.get('/modelos', requireAdmin, a(async (req, res) => {
  const filtro = req.query.status || 'ativo';
  let where = "m.status = 'ativo' AND NOT m.avulsa";
  if (filtro === 'pausado') where = "m.status = 'pausado' AND NOT m.avulsa";
  if (filtro === 'arquivado') where = "m.status = 'arquivado'";
  if (filtro === 'avulsas') where = "m.avulsa AND m.status <> 'arquivado'";
  const { rows } = await pool.query(
    `SELECT m.id, m.titulo, m.setor, m.prioridade, m.recorrencia, m.hora_limite, m.responsaveis, m.modo_atribuicao, m.status, m.avulsa,
            m.modo_produtos, m.conferir_depois, m.updated_at,
            (SELECT COUNT(*)::int FROM rotina_modelo_passos p WHERE p.modelo_id = m.id) AS n_passos,
            (SELECT COUNT(DISTINCT p.produto_id)::int FROM rotina_modelo_produtos p WHERE p.modelo_id = m.id) AS n_produtos,
            (SELECT COUNT(p.variante_id)::int FROM rotina_modelo_produtos p WHERE p.modelo_id = m.id) AS n_variantes_escolhidas,
            (SELECT COUNT(*)::int FROM rotina_ocorrencias o WHERE o.modelo_id = m.id AND o.data >= CURRENT_DATE - 30 AND (o.prazo < now() OR o.status NOT IN ('pendente', 'em_andamento', 'devolvida'))) AS total30,
            (SELECT COUNT(*)::int FROM rotina_ocorrencias o WHERE o.modelo_id = m.id AND o.data >= CURRENT_DATE - 30 AND o.concluida_em IS NOT NULL AND o.status IN ('concluida', 'aguardando_conferencia') AND o.concluida_em <= o.prazo) AS no_prazo30
       FROM rotina_modelos m WHERE ${where}
      ORDER BY m.updated_at DESC LIMIT 300`
  );
  const { rows: pessoas } = await pool.query('SELECT id, nome FROM usuarios');
  const nome = new Map(pessoas.map((p) => [p.id, p.nome]));
  const hoje = hojeEmBrasilia();
  res.json(rows.map((m) => ({
    id: m.id,
    titulo: m.titulo,
    setor: m.setor,
    prioridade: m.prioridade,
    quando: rec.descrever(m.recorrencia),
    horaLimite: m.hora_limite ? String(m.hora_limite).slice(0, 5) : null,
    proximas: m.status === 'ativo' ? rec.proximas(m.recorrencia, hoje, 3) : [],
    responsaveis: (m.responsaveis || []).map((id) => nome.get(id) || '—'),
    compartilhada: m.modo_atribuicao !== 'cada_um',
    dividida: m.modo_atribuicao === 'dividir',
    status: m.status,
    avulsa: m.avulsa,
    automatica: m.modo_produtos === 'automatica',
    conferir: m.conferir_depois,
    nPassos: m.n_passos,
    nProdutos: m.n_produtos,
    nVariantesEscolhidas: m.n_variantes_escolhidas,
    noPrazo30: m.total30 ? Math.round((m.no_prazo30 / m.total30) * 100) : null,
    total30: m.total30,
  })));
}));

router.get('/modelos/:id', requireAdmin, a(async (req, res) => {
  const m = await r.carregarModelo(Number(req.params.id));
  if (!m) throw new r.ErroRotina('Rotina não encontrada.', 404);
  const imgs = m.anexos?.imagens || [];
  const { rows: fotos } = imgs.length ? await pool.query('SELECT id, hash FROM rotina_fotos WHERE id = ANY($1)', [imgs]) : { rows: [] };
  res.json({ ...m, fotos: Object.fromEntries(fotos.map((f) => [f.id, { hash: f.hash }])) });
}));

async function salvarEResponder(req, res, modeloId = null) {
  const avulsa = modeloId
    ? (await pool.query('SELECT avulsa FROM rotina_modelos WHERE id = $1', [modeloId])).rows[0]?.avulsa
    : Boolean(req.body.avulsa);
  if (modeloId && avulsa === undefined) throw new r.ErroRotina('Rotina não encontrada.', 404);
  const m = await r.normalizarModelo(req.body, pool, { avulsa });
  const id = await r.salvarModelo(m, req.user.id, modeloId);
  const hoje = hojeEmBrasilia();
  let geradas = 0;
  // Avulsa para hoje, ou "Salvar e criar a primeira agora": nasce já.
  if (req.body.criarAgora || (avulsa && m.recorrencia.data === hoje)) {
    geradas = (await r.gerarDia(hoje, { modeloIds: [id], forcar: Boolean(req.body.criarAgora) })).criadas;
  }
  res.status(modeloId ? 200 : 201).json({ id, geradas });
}

router.post('/modelos', requireAdmin, a((req, res) => salvarEResponder(req, res)));
router.put('/modelos/:id', requireAdmin, a((req, res) => salvarEResponder(req, res, Number(req.params.id))));

router.post('/modelos/:id/duplicar', requireAdmin, a(async (req, res) => {
  const m = await r.carregarModelo(Number(req.params.id));
  if (!m) throw new r.ErroRotina('Rotina não encontrada.', 404);
  const copia = await r.normalizarModelo({ ...m, titulo: `${m.titulo} (cópia)`.slice(0, 120), anexos: { ...m.anexos, imagens: [] } }, pool, { avulsa: m.avulsa });
  const id = await r.salvarModelo(copia, req.user.id);
  await pool.query("UPDATE rotina_modelos SET status = 'pausado' WHERE id = $1", [id]);
  res.status(201).json({ id });
}));

router.post('/modelos/:id/status', requireAdmin, a(async (req, res) => {
  const status = ['ativo', 'pausado', 'arquivado'].includes(req.body.status) ? req.body.status : null;
  if (!status) throw new r.ErroRotina('Situação inválida.');
  const { rowCount } = await pool.query('UPDATE rotina_modelos SET status = $2, atualizado_por = $3, updated_at = now() WHERE id = $1', [Number(req.params.id), status, req.user.id]);
  if (!rowCount) throw new r.ErroRotina('Rotina não encontrada.', 404);
  res.json({ status });
}));

router.post('/modelos/:id/gerar-agora', requireAdmin, a(async (req, res) => {
  const { criadas } = await r.gerarDia(hojeEmBrasilia(), { modeloIds: [Number(req.params.id)], forcar: true });
  res.json({ criadas });
}));

// --- Equipe ----------------------------------------------------------------
router.get('/equipe', requireAdmin, a(async (req, res) => {
  const hoje = hojeEmBrasilia();
  await r.gerarDia(hoje);
  const dias = req.query.periodo === '30' ? 30 : req.query.periodo === '7' ? 7 : 1;
  const de = rec.somarDias(hoje, 1 - dias);
  const valores = [de, hoje];
  let filtro = '';
  if (req.query.pessoa) { valores.push(Number(req.query.pessoa)); filtro += ` AND COALESCE(o.responsavel_id, 0) = $${valores.length}`; }
  if (req.query.modelo) { valores.push(Number(req.query.modelo)); filtro += ` AND o.modelo_id = $${valores.length}`; }
  if (req.query.produto) { valores.push(JSON.stringify([{ produtoId: Number(req.query.produto) }])); filtro += ` AND o.produtos_resolvidos @> $${valores.length}::jsonb`; }
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_OC} ${JOINS_OC}
      WHERE ((o.data BETWEEN $1::date AND $2::date) OR o.status IN ('pendente', 'em_andamento', 'devolvida', 'aguardando_conferencia'))
        AND o.data <= $2::date ${filtro}
      ORDER BY o.data DESC, o.prazo
      LIMIT 600`,
    valores
  );
  const respostas = await respostasDe(rows.map((x) => x.id));
  const agora = new Date();
  const itens = rows.map((oc) => resumo(oc, respostas.get(oc.id), agora));
  const doPeriodo = itens.filter((x) => x.data >= de);

  // % do dia por pessoa (chips) e taxa no prazo (período): só conta o que já
  // venceu ou já terminou — tarefa de hoje que ainda está no prazo não pesa.
  const porPessoa = new Map();
  const porModelo = new Map();
  for (const x of doPeriodo) {
    const chave = x.responsavelId || 0;
    if (!porPessoa.has(chave)) porPessoa.set(chave, { id: chave, nome: x.responsavelNome || 'Qualquer um', hojeTotal: 0, hojeFeitas: 0, vencidas: 0, noPrazo: 0 });
    if (!porModelo.has(x.modeloId)) porModelo.set(x.modeloId, { id: x.modeloId, titulo: x.titulo, vencidas: 0, noPrazo: 0 });
    const p = porPessoa.get(chave);
    const m = porModelo.get(x.modeloId);
    const terminada = x.status === 'concluida' || x.status === 'aguardando_conferencia';
    if (x.data === hoje) {
      p.hojeTotal += 1;
      if (terminada) p.hojeFeitas += 1;
    }
    if (terminada || x.atrasada || x.status === 'nao_feita') {
      p.vencidas += 1; m.vencidas += 1;
      if (terminada && x.noPrazo) { p.noPrazo += 1; m.noPrazo += 1; }
    }
  }
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
  res.json({
    hoje,
    periodo: dias,
    paineis: {
      atrasadas: itens.filter((x) => x.atrasada).length,
      conferir: itens.filter((x) => x.status === 'aguardando_conferencia').length,
      comProblemaHoje: itens.filter((x) => x.data === hoje && x.problemas > 0).length,
    },
    pessoas: [...porPessoa.values()].map((p) => ({ ...p, pctHoje: pct(p.hojeFeitas, p.hojeTotal), pctNoPrazo: pct(p.noPrazo, p.vencidas) }))
      .sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR')),
    modelos: [...porModelo.values()].map((m) => ({ ...m, pctNoPrazo: pct(m.noPrazo, m.vencidas) }))
      .sort((x, y) => (x.pctNoPrazo ?? 101) - (y.pctNoPrazo ?? 101)),
    itens: ordenarLista(itens),
  });
}));

// Histórico por produto (ficha do produto e filtro da Equipe).
router.get('/produto/:id/historico', requireAdmin, a(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT rr.valor, rr.problema, rr.respondido_em, rr.passo_id, rr.chave_produto, o.id AS ocorrencia_id,
            o.snapshot->>'titulo' AS titulo, o.snapshot->'passos' AS passos, u.nome AS quem, v.cor, v.tamanho
       FROM rotina_respostas rr
       JOIN rotina_ocorrencias o ON o.id = rr.ocorrencia_id
       LEFT JOIN usuarios u ON u.id = rr.respondido_por
       LEFT JOIN estoque_variantes v ON v.id = rr.variante_id
      WHERE rr.produto_id = $1
      ORDER BY rr.respondido_em DESC LIMIT 15`,
    [Number(req.params.id)]
  );
  res.json(rows.map((x) => {
    const passo = (x.passos || []).find((p) => p.id === x.passo_id);
    return {
      ocorrenciaId: x.ocorrencia_id, titulo: x.titulo, passo: passo?.texto || null, unidade: passo?.unidade || null,
      variante: [x.cor, x.tamanho].filter(Boolean).join(' · '), valor: x.valor, problema: x.problema, quem: x.quem, em: x.respondido_em,
    };
  }));
}));

module.exports = router;
