// Pós-venda alimentando o produto — o motor puro (21/09/2026), frente 3.
//
// Três coisas, sem banco:
//   1. A TAXONOMIA de motivo — a mesma para devolução, reclamação e avaliação,
//      de qualquer canal. Cada motivo diz para quem a informação serve
//      (modelagem, qualidade, anúncio, logística), porque é isso que faz o
//      pós-venda alimentar o produto em vez de virar uma lista de queixas.
//   2. O CLASSIFICADOR: dado o código de motivo da plataforma (quando ela dá
//      um) e o texto do cliente, escolhe o motivo da taxonomia — ou devolve
//      null, com "sem classificar", em vez de chutar (REGRA 2). Palavra é
//      pista, não prova: "pequeno" numa frase com "defeito" vira defeito.
//   3. Os AGREGADOS: dada a lista de eventos e a venda por variante, a taxa
//      de devolução por referência × tamanho e o sinal de modelagem
//      (pequeno ≫ grande num tamanho = a peça veste menor que a etiqueta).
const { temNumero } = require('./estoqueMinimo');

const MOTIVOS = {
  ficou_pequeno:     { rotulo: 'Ficou pequeno',        alimenta: 'modelagem',  peso: 3 },
  ficou_grande:      { rotulo: 'Ficou grande',         alimenta: 'modelagem',  peso: 3 },
  tamanho:           { rotulo: 'Tamanho (sem dizer)',  alimenta: 'modelagem',  peso: 2 },
  defeito:           { rotulo: 'Defeito',              alimenta: 'qualidade',  peso: 3 },
  diferente_da_foto: { rotulo: 'Diferente da foto',    alimenta: 'anuncio',    peso: 2 },
  errado:            { rotulo: 'Peça errada',          alimenta: 'expedicao',  peso: 2 },
  atraso:            { rotulo: 'Atraso',               alimenta: 'logistica',  peso: 1 },
  nao_recebido:      { rotulo: 'Não recebido',         alimenta: 'logistica',  peso: 1 },
  arrependimento:    { rotulo: 'Arrependimento',       alimenta: null,         peso: 0 },
  outro:             { rotulo: 'Outro',                alimenta: null,         peso: 0 },
};
const ALIMENTA = {
  modelagem: 'Modelagem — a peça veste diferente do que a etiqueta diz',
  qualidade: 'Qualidade — defeito de costura, tecido, acabamento',
  anuncio: 'Anúncio — foto, descrição ou cor não batem com a peça',
  expedicao: 'Expedição — mandaram a peça errada',
  logistica: 'Logística — prazo e entrega',
};

// Códigos de motivo das plataformas → taxonomia. Shopee `reason` (returns),
// ML `reason_id`/`reason` de claims. Quando um código não está aqui, cai
// para o texto; quando o texto não decide, fica sem classificar.
const CODIGO_PLATAFORMA = {
  // Shopee returns
  NOT_RECEIPT: 'nao_recebido', DIFF: 'diferente_da_foto', DAMAGE: 'defeito', WRONG_ITEM: 'errado',
  NOT_AS_DESCRIBED: 'diferente_da_foto', CHANGE_MIND: 'arrependimento', FUNCTIONAL_DAMAGE: 'defeito',
  PHYSICAL_DAMAGE: 'defeito', MISSING_ITEMS: 'errado', SIZE_NOT_FIT: 'tamanho', OTHER: null,
  // Vistos na tela em 25/09/2026 sem classificação (revisão visual).
  ITEM_NOT_FIT: 'tamanho', ITEM_MISSING: 'errado', MISSING_ITEM: 'errado', DAMAGED_ITEM: 'defeito', DEFECTIVE_ITEM: 'defeito',
  NOT_AS_EXPECTED: 'diferente_da_foto', ITEM_NOT_AS_DESCRIBED: 'diferente_da_foto', CHANGED_MIND: 'arrependimento',
  // Mercado Livre (reason / reason_id conhecidos)
  PNR: 'nao_recebido', PDD: 'diferente_da_foto', UNDELIVERED: 'nao_recebido', DIFFERENT: 'diferente_da_foto',
  DEFECTIVE: 'defeito', WRONG_PRODUCT: 'errado', DELAY: 'atraso', SIZE: 'tamanho', REGRET: 'arrependimento',
  // TikTok return reasons (texto do reason_text é o que vale; códigos variam)
};

// Palavras, com o motivo mais específico ganhando do genérico. A ordem
// importa: "defeito" antes de "pequeno" porque "veio com defeito no tamanho
// P" é defeito.
const PALAVRAS = [
  ['nao_recebido', /n[aã]o (recebi|chegou|entregue)|nunca chegou|extraviad|sumiu|n[aã]o veio/i],
  ['errado', /(pe[çc]a|produto|cor|tamanho|modelo) (errad|trocad|diferente do pedido)|veio (outro|outra|errad)|mandaram (outro|errad)|n[aã]o era o que (pedi|comprei)/i],
  ['defeito', /defeit|rasg|furad|mancha|descos|costura|bot[aã]o (caiu|solto)|z[ií]per|estrag|quebr|desfia|soltou|danific|avaria|amass|encolheu/i],
  ['diferente_da_foto', /diferente da (foto|imagem|descri)|n[aã]o (parece|é igual|e igual) (a|à|com) (foto|imagem)|cor (diferente|n[aã]o é|nao e)|foto engan|tecido (diferente|fino demais)|n[aã]o (é|e) (como|igual) (o|a|ao|à) an[uú]ncio/i],
  ['ficou_pequeno', /(ficou|veio|é|e|muito|tá|ta|esta|está) (pequen|apertad|justo|curt)|pequen[oa] demais|apertad[oa] demais|n[aã]o (coube|serviu|entrou)|menor que|tamanho menor|veste menor|preciso de um maior/i],
  ['ficou_grande', /(ficou|veio|é|e|muito|tá|ta|esta|está) (grande|larg|folgad|comprid)|grande demais|larg[oa] demais|maior que|tamanho maior|veste maior|preciso de um menor/i],
  ['tamanho', /tamanho|numera[çc][aã]o|n[aã]o serviu|medida/i],
  ['atraso', /atras|demor|prazo|ainda n[aã]o (chegou|recebi)|quando chega|cad[eê] (meu|o) (pedido|produto)/i],
  ['arrependimento', /desisti|arrependi|n[aã]o quero mais|comprei errado|mudei de ideia|n[aã]o gostei|n[aã]o preciso mais/i],
];

function classificarMotivo({ codigo = null, texto = '' } = {}) {
  const cod = codigo ? String(codigo).toUpperCase().trim() : null;
  if (cod && Object.prototype.hasOwnProperty.call(CODIGO_PLATAFORMA, cod) && CODIGO_PLATAFORMA[cod]) {
    // Código genérico de tamanho + texto que diz qual: o texto refina.
    if (CODIGO_PLATAFORMA[cod] === 'tamanho') {
      const fino = porPalavra(texto);
      if (fino === 'ficou_pequeno' || fino === 'ficou_grande') return { motivo: fino, origem: 'palavra' };
    }
    return { motivo: CODIGO_PLATAFORMA[cod], origem: 'plataforma' };
  }
  const m = porPalavra(texto);
  return m ? { motivo: m, origem: 'palavra' } : { motivo: null, origem: null };
}

function porPalavra(texto) {
  const t = String(texto || '').normalize('NFC');
  if (!t.trim()) return null;
  for (const [motivo, re] of PALAVRAS) if (re.test(t)) return motivo;
  return null;
}

// Uma pergunta de comprador também é sinal: "veste pequeno?" antes da compra
// é a mesma dúvida que vira devolução depois. Aqui só o tema, sem motivo.
const TEMAS_PERGUNTA = [
  ['tamanho', /tamanho|veste|numera|medida|altura|peso|cm|serve|grande|pequen|largo|justo|manequim/i],
  ['prazo', /prazo|entrega|chega|envio|frete|quando|demora/i],
  ['estoque', /tem (em|no) estoque|dispon[ií]vel|ainda tem|tem (a|o|na) cor|tem (o|no) tamanho/i],
  ['material', /tecido|algod|material|composi|malha|elastano|encolhe|desbota|transpar/i],
  ['cor', /\bcor\b|cores|tonalidade|estampa/i],
  ['preco', /pre[çc]o|desconto|cupom|promo|parcel|valor/i],
];
function temaDaPergunta(texto) {
  for (const [tema, re] of TEMAS_PERGUNTA) if (re.test(String(texto || ''))) return tema;
  return 'outro';
}

// ---------------------------------------------------------------------------
// Agregados
// ---------------------------------------------------------------------------
// `eventos`: [{ tipo, produtoId, referencia, cor, tamanho, motivo, quantidade, nota }]
// `vendaPorVariante`: Map 'produtoId|cor|tamanho' → peças vendidas na janela
// `vendaPorProduto`: Map produtoId → peças vendidas na janela
function agregarPorReferencia(eventos, { vendaPorVariante = new Map(), vendaPorProduto = new Map(), pecasMinimas = 20 } = {}) {
  const porProduto = new Map();
  for (const e of eventos) {
    if (e.produtoId == null) continue;
    const p = porProduto.get(e.produtoId) || {
      produtoId: e.produtoId, referencia: e.referencia, descricao: e.descricao,
      devolucoes: 0, pecasDevolvidas: 0, reclamacoes: 0, perguntas: 0, avaliacoes: 0, somaNotas: 0, notasBaixas: 0,
      motivos: new Map(), tamanhos: new Map(), perguntasTema: new Map(),
    };
    const qtd = temNumero(e.quantidade) && Number(e.quantidade) > 0 ? Number(e.quantidade) : 1;
    if (e.tipo === 'devolucao') {
      p.devolucoes += 1; p.pecasDevolvidas += qtd;
      const t = e.tamanho || '(sem tamanho)';
      const tam = p.tamanhos.get(t) || { tamanho: t, pecasDevolvidas: 0, pequeno: 0, grande: 0, defeito: 0 };
      tam.pecasDevolvidas += qtd;
      if (e.motivo === 'ficou_pequeno') tam.pequeno += qtd;
      if (e.motivo === 'ficou_grande') tam.grande += qtd;
      if (e.motivo === 'defeito') tam.defeito += qtd;
      p.tamanhos.set(t, tam);
    } else if (e.tipo === 'reclamacao') p.reclamacoes += 1;
    else if (e.tipo === 'pergunta') { p.perguntas += 1; const tema = e.tema || temaDaPergunta(e.texto); p.perguntasTema.set(tema, (p.perguntasTema.get(tema) || 0) + 1); }
    else if (e.tipo === 'avaliacao') { p.avaliacoes += 1; if (temNumero(e.nota)) { p.somaNotas += Number(e.nota); if (Number(e.nota) <= 2) p.notasBaixas += 1; } }
    if (e.motivo && (e.tipo === 'devolucao' || e.tipo === 'reclamacao' || (e.tipo === 'avaliacao' && temNumero(e.nota) && Number(e.nota) <= 3))) {
      p.motivos.set(e.motivo, (p.motivos.get(e.motivo) || 0) + (e.tipo === 'devolucao' ? qtd : 1));
    }
    porProduto.set(e.produtoId, p);
  }

  return [...porProduto.values()].map((p) => {
    const vendidas = vendaPorProduto.get(p.produtoId) ?? null;
    const taxa = vendidas != null && vendidas > 0 ? p.pecasDevolvidas / vendidas : null;
    const motivos = [...p.motivos.entries()].map(([motivo, n]) => ({ motivo, rotulo: MOTIVOS[motivo]?.rotulo || motivo, alimenta: MOTIVOS[motivo]?.alimenta || null, n })).sort((a, b) => b.n - a.n);
    const tamanhos = [...p.tamanhos.values()].map((t) => {
      const vend = vendaPorVariante.size > 0 ? [...vendaPorVariante.entries()].filter(([k]) => k.startsWith(`${p.produtoId}|`) && k.endsWith(`|${t.tamanho}`)).reduce((s, [, v]) => s + v, 0) : null;
      return { ...t, vendidas: vend, taxa: vend != null && vend > 0 ? t.pecasDevolvidas / vend : null };
    }).sort((a, b) => b.pecasDevolvidas - a.pecasDevolvidas);
    // Sinal de modelagem: num tamanho, "pequeno" pelo menos 3× "grande" (ou
    // vice-versa) com pelo menos 3 peças. Menos que isso é acaso.
    const sinais = [];
    for (const t of tamanhos) {
      if (t.pequeno >= 3 && t.pequeno >= 3 * Math.max(1, t.grande)) sinais.push({ tamanho: t.tamanho, sinal: 'veste_menor', pecas: t.pequeno, texto: `o ${t.tamanho} veste menor que a etiqueta (${t.pequeno} devolvidas por "ficou pequeno")` });
      if (t.grande >= 3 && t.grande >= 3 * Math.max(1, t.pequeno)) sinais.push({ tamanho: t.tamanho, sinal: 'veste_maior', pecas: t.grande, texto: `o ${t.tamanho} veste maior que a etiqueta (${t.grande} devolvidas por "ficou grande")` });
      if (t.defeito >= 3) sinais.push({ tamanho: t.tamanho, sinal: 'defeito', pecas: t.defeito, texto: `${t.defeito} peças do ${t.tamanho} voltaram com defeito` });
    }
    const alimenta = new Map();
    for (const m of motivos) if (m.alimenta) alimenta.set(m.alimenta, (alimenta.get(m.alimenta) || 0) + m.n);
    const principal = [...alimenta.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    return {
      produtoId: p.produtoId, referencia: p.referencia, descricao: p.descricao,
      devolucoes: p.devolucoes, pecasDevolvidas: p.pecasDevolvidas, vendidas, taxaDevolucao: taxa == null ? null : Number(taxa.toFixed(4)),
      amostraPequena: vendidas != null && vendidas < pecasMinimas,
      reclamacoes: p.reclamacoes, perguntas: p.perguntas, perguntasTema: [...p.perguntasTema.entries()].map(([tema, n]) => ({ tema, n })).sort((a, b) => b.n - a.n),
      avaliacoes: p.avaliacoes, notaMedia: p.avaliacoes > 0 && p.somaNotas > 0 ? Number((p.somaNotas / p.avaliacoes).toFixed(2)) : null, notasBaixas: p.notasBaixas,
      motivos, tamanhos, sinais,
      alimenta: principal ? { area: principal[0], rotulo: ALIMENTA[principal[0]], n: principal[1] } : null,
    };
  }).sort((a, b) => (b.taxaDevolucao ?? -1) - (a.taxaDevolucao ?? -1) || b.pecasDevolvidas - a.pecasDevolvidas);
}

// "O que exige ação" — as regras fixas, sem IA. Devolve itens com nível.
function exigemAcao({ eventos = [], porReferencia = [], agora = new Date(), taxaAlerta = 0.08, horasPergunta = 24 } = {}) {
  const itens = [];
  const h = (d) => (agora - new Date(d)) / 3600000;
  for (const e of eventos) {
    // Avaliação nunca está "aberta" na plataforma; o que a tira da lista é
    // alguém marcar como tratada.
    // 23/09/2026: cada item leva também `resumo` (a frase do cliente ou o
    // fato), `detalhe` (o que a tela mostra em letra menor), loja, nota e
    // quando aconteceu — a lista "Resolver" é uma tabela com colunas, não
    // texto corrido. `texto` continua como antes para a Manu analista.
    const base = { lojaNome: e.loja_nome || null, anuncioTitulo: e.anuncio_titulo || null, ocorridoEm: e.ocorrido_em, nota: temNumero(e.nota) ? Number(e.nota) : null, motivoRotulo: e.motivo ? (MOTIVOS[e.motivo]?.rotulo || e.motivo) : null };
    const frase = (t) => (t ? `“${String(t).slice(0, 140)}”` : null);
    if (e.tipo === 'avaliacao') {
      if (temNumero(e.nota) && Number(e.nota) <= 2 && !e.tratado_em) {
        itens.push({ ...base, chave: `avaliacao-${e.id}`, tipo: 'avaliacao', nivel: 'atencao', eventoId: e.id, referencia: e.referencia, marketplace: e.marketplace, texto: `Avaliação ${e.nota}★${e.referencia ? ` · ${e.referencia}` : ''}: “${String(e.texto || '').slice(0, 90)}”`, resumo: frase(e.texto) || 'Avaliação sem comentário', detalhe: [e.anuncio_titulo, base.motivoRotulo ? `motivo: ${base.motivoRotulo}` : null].filter(Boolean).join(' · ') });
      }
      continue;
    }
    if (!e.aberto) continue;
    if (e.tipo === 'pergunta' && !e.respondida_em) {
      const horas = h(e.ocorrido_em);
      itens.push({ ...base, chave: `pergunta-${e.id}`, tipo: 'pergunta', nivel: horas > horasPergunta ? 'urgente' : 'atencao', eventoId: e.id, referencia: e.referencia, marketplace: e.marketplace, texto: `Pergunta sem resposta há ${Math.floor(horas)} h${e.referencia ? ` · ${e.referencia}` : ''}: “${String(e.texto || '').slice(0, 90)}”`, horas: Math.floor(horas), resumo: frase(e.texto) || 'Pergunta sem texto', detalhe: `sem resposta há ${Math.floor(horas)} h${e.anuncio_titulo ? ` · ${e.anuncio_titulo}` : ''}` });
    }
    if (e.tipo === 'reclamacao') {
      const horas = h(e.ocorrido_em);
      itens.push({ ...base, chave: `reclamacao-${e.id}`, tipo: 'reclamacao', nivel: horas > 48 ? 'urgente' : 'atencao', eventoId: e.id, referencia: e.referencia, marketplace: e.marketplace, texto: `Reclamação aberta há ${Math.floor(horas / 24)} d${e.referencia ? ` · ${e.referencia}` : ''}${e.motivo ? ` · ${MOTIVOS[e.motivo]?.rotulo || e.motivo}` : ''}`, horas: Math.floor(horas), resumo: frase(e.texto) || (e.motivo_externo ? `Motivo na plataforma: ${e.motivo_externo}` : 'Reclamação aberta'), detalhe: `aberta há ${Math.floor(horas / 24)} d${base.motivoRotulo ? ` · ${base.motivoRotulo}` : ' · sem motivo classificado'}${e.anuncio_titulo ? ` · ${e.anuncio_titulo}` : ''}` });
    }
    if (e.tipo === 'devolucao' && e.marketplace !== 'manual') {
      itens.push({ ...base, chave: `devolucao-${e.id}`, tipo: 'devolucao', nivel: 'atencao', eventoId: e.id, referencia: e.referencia, marketplace: e.marketplace, texto: `Devolução em andamento${e.referencia ? ` · ${e.referencia}` : ''}${e.motivo ? ` · ${MOTIVOS[e.motivo]?.rotulo || e.motivo}` : ' · sem motivo classificado'}`, resumo: frase(e.texto) || (e.motivo_externo ? `Motivo na plataforma: ${e.motivo_externo}` : 'Devolução em andamento'), detalhe: `${e.status_externo ? String(e.status_externo).toLowerCase().replace(/_/g, ' ') : 'em andamento'} · ${base.motivoRotulo ? `motivo: ${base.motivoRotulo}` : 'sem motivo classificado'}${e.anuncio_titulo ? ` · ${e.anuncio_titulo}` : ''}` });
    }
  }
  for (const r of porReferencia) {
    if (r.taxaDevolucao != null && r.taxaDevolucao >= taxaAlerta && !r.amostraPequena) {
      const taxaTxt = `${(r.taxaDevolucao * 100).toFixed(1).replace('.', ',')}%`;
      itens.push({ chave: `taxa-${r.produtoId}`, tipo: 'referencia', nivel: r.taxaDevolucao >= taxaAlerta * 2 ? 'urgente' : 'atencao', produtoId: r.produtoId, referencia: r.referencia, texto: `${r.referencia} devolve ${(r.taxaDevolucao * 100).toFixed(1)}% do que vende${r.motivos[0] ? ` — principal: ${r.motivos[0].rotulo}` : ''}`, resumo: `Devolve ${taxaTxt} do que vende (${r.pecasDevolvidas} de ${r.vendidas} peças)`, detalhe: `${r.descricao || ''}${r.motivos[0] ? ` · principal: ${r.motivos[0].rotulo}` : ' · sem motivo classificado'}` });
    }
    for (const s of r.sinais) {
      itens.push({ chave: `sinal-${r.produtoId}-${s.tamanho}-${s.sinal}`, tipo: 'modelagem', nivel: 'atencao', produtoId: r.produtoId, referencia: r.referencia, texto: `${r.referencia}: ${s.texto}`, resumo: s.texto.charAt(0).toUpperCase() + s.texto.slice(1), detalhe: r.descricao || '' });
    }
  }
  const ordem = { urgente: 0, atencao: 1 };
  return itens.sort((a, b) => ordem[a.nivel] - ordem[b.nivel] || (b.horas || 0) - (a.horas || 0));
}

module.exports = { MOTIVOS, ALIMENTA, CODIGO_PLATAFORMA, classificarMotivo, temaDaPergunta, agregarPorReferencia, exigemAcao };
