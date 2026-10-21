// Rotinas (15/10/2026) — vocabulário e ajudantes das telas.
//
// Os rótulos são de gente ("Para hoje", "Não consegui fazer") — nunca
// "instância", "status" ou "recorrência" na tela.

export const SETORES = [
  ['expedicao', 'Expedição'], ['estoque', 'Estoque'], ['producao', 'Produção'], ['marketplace', 'Marketplace'],
  ['conteudo', 'Conteúdo'], ['atendimento', 'Atendimento'], ['financeiro', 'Financeiro'], ['compras', 'Compras'],
];
export const NOME_SETOR = Object.fromEntries(SETORES);
export const MARCAS = ['Miss Manu', 'Origem', 'Hoggar', 'Hebron'];
export const CANAIS = [
  ['mercado_livre', 'Mercado Livre'], ['shopee', 'Shopee'], ['tiktok_shop', 'TikTok Shop'], ['shein', 'Shein'], ['atacado', 'Atacado'],
];
export const NOME_CANAL = Object.fromEntries(CANAIS);
export const PRIORIDADES = [['baixa', 'Baixa'], ['normal', 'Normal'], ['alta', 'Alta'], ['urgente', 'Urgente']];
export const NOME_PRIORIDADE = Object.fromEntries(PRIORIDADES);
export const TIPOS_PASSO = [
  ['feito', 'Marcar feito'], ['sim_nao', 'Sim / Não'], ['ok_problema', 'OK / Problema'], ['numero', 'Número'],
  ['texto', 'Texto curto'], ['escolha', 'Escolha'], ['foto', 'Foto'],
];
export const PROVAS = [['nao', 'Não pede'], ['problema', 'Só se der problema'], ['sempre', 'Sempre']];
export const MOTIVOS_NAO_FEITA = [
  ['falta_produto', 'Falta de produto'], ['falta_tempo', 'Falta de tempo'], ['sistema_fora', 'Sistema fora'], ['outro', 'Outro'],
];
export const DIAS = [[1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [7, 'Dom']];

export const SITUACAO = {
  pendente: { rotulo: 'Para fazer', tom: 'info' },
  em_andamento: { rotulo: 'Fazendo', tom: 'latao' },
  devolvida: { rotulo: 'Devolvida', tom: 'atencao' },
  aguardando_conferencia: { rotulo: 'Conferir', tom: 'roxo' },
  concluida: { rotulo: 'Feita', tom: 'ok' },
  nao_feita: { rotulo: 'Não feita', tom: 'neutro' },
};
export function situacaoDe(item) {
  if (item.atrasada) return { rotulo: 'Atrasada', tom: 'perigo' };
  return SITUACAO[item.status] || { rotulo: item.status, tom: 'neutro' };
}

export const fotoUrl = (hash, mini = false) => `/api/rotinas/fotos/${hash}${mini ? '?t=mini' : ''}`;
export const fotoProdutoUrl = (p) => (p.temFoto ? `/api/rotinas/produtos/${p.produtoId ?? p.id}/foto` : (p.fotoUrl || null));

const FUSO = 'America/Sao_Paulo';
export function horaDe(iso) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
export function diaCurto(dia) {
  const [, m, d] = String(dia).split('-');
  return `${d}/${m}`;
}
export function diaLongo(dia) {
  const t = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${dia}T12:00:00Z`));
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export function prazoTexto(item, hoje) {
  const hora = item.prazo ? horaDe(item.prazo) : null;
  const mesmoDia = item.data === hoje;
  if (item.atrasada) return mesmoDia ? `venceu às ${hora}` : `venceu ${diaCurto(item.data)}${item.horaLimite ? ` às ${hora}` : ''}`;
  if (!item.horaLimite) return mesmoDia ? 'até o fim do dia' : `até ${diaCurto(item.data)}`;
  return mesmoDia ? `até ${hora}` : `até ${diaCurto(item.data)} às ${hora}`;
}
export function varianteTexto(v) {
  return [v?.cor, v?.tamanho].filter(Boolean).join(' · ') || 'única';
}
export function numeroBr(n) {
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Foto: reduz NO CELULAR antes de subir (lado maior 1280 px, WebP ~0,7) e
// gera a miniatura de 320 px. O servidor recusa acima de 400 KB — é a rede
// de segurança; o alvo é ficar abaixo de 200 KB. Navegador que não sabe
// gerar WebP (Safari antigo) devolve PNG do canvas: aí cai para JPEG.
// ---------------------------------------------------------------------------
async function carregarImagem(arquivo) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); } catch { /* cai para <img> */ }
  }
  const url = URL.createObjectURL(arquivo);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function paraBlob(canvas, tipo, qualidade) {
  return new Promise((resolve) => canvas.toBlob(resolve, tipo, qualidade));
}

async function reduzir(img, ladoMaior, qualidades) {
  const w = img.width || img.naturalWidth;
  const h = img.height || img.naturalHeight;
  const escala = Math.min(1, ladoMaior / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * escala);
  canvas.height = Math.round(h * escala);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  let blob = null;
  for (const q of qualidades) {
    blob = await paraBlob(canvas, 'image/webp', q);
    if (!blob || blob.type !== 'image/webp') blob = await paraBlob(canvas, 'image/jpeg', q);
    if (blob && blob.size <= qualidades.alvo) break;
  }
  return { blob, largura: canvas.width, altura: canvas.height };
}

export async function comprimirFoto(arquivo) {
  const img = await carregarImagem(arquivo);
  const grandes = Object.assign([0.7, 0.6, 0.5, 0.4], { alvo: 200 * 1024 });
  const pequenas = Object.assign([0.6, 0.45], { alvo: 40 * 1024 });
  const foto = await reduzir(img, 1280, grandes);
  const mini = await reduzir(img, 320, pequenas);
  img.close?.();
  if (!foto.blob || foto.blob.size > 400 * 1024) throw new Error('Não consegui reduzir essa foto. Tente tirar de novo, mais de perto.');
  return { foto: foto.blob, miniatura: mini.blob, largura: foto.largura, altura: foto.altura };
}

export async function enviarFoto(arquivo, ocorrenciaId) {
  const { foto, miniatura, largura, altura } = await comprimirFoto(arquivo);
  const ext = foto.type === 'image/webp' ? 'webp' : 'jpg';
  const f = new FormData();
  f.append('foto', foto, `foto.${ext}`);
  f.append('miniatura', miniatura, `mini.${ext}`);
  f.append('largura', largura);
  f.append('altura', altura);
  if (ocorrenciaId) f.append('ocorrenciaId', ocorrenciaId);
  const res = await fetch('/api/rotinas/fotos', { method: 'POST', credentials: 'include', body: f });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados.error || `Não deu para enviar a foto (${res.status}).`);
  return dados;
}

// ---------------------------------------------------------------------------
// Cartões (21/10/2026): a tarefa de vários horários vira UM cartão com os
// horários dentro. Chave: rotina + dia (+ id, quando é tarefa de um horário só).
// ---------------------------------------------------------------------------
export const aberta = (status) => status === 'pendente' || status === 'em_andamento' || status === 'devolvida';
export const terminada = (status) => status === 'concluida' || status === 'aguardando_conferencia';

export function agruparPorRotina(itens) {
  const grupos = new Map();
  for (const x of itens) {
    // Compartilhada: os horários ficam juntos mesmo depois que cada um foi
    // pego por uma pessoa diferente.
    const chave = x.horario ? `${x.modeloId}|${x.data}|${x.compartilhada ? 'eq' : x.responsavelId}` : `t${x.id}`;
    if (!grupos.has(chave)) grupos.set(chave, { chave, modeloId: x.modeloId, data: x.data, titulo: x.titulo, itens: [] });
    grupos.get(chave).itens.push(x);
  }
  for (const g of grupos.values()) g.itens.sort((a, b) => String(a.horario || '').localeCompare(String(b.horario || '')) || a.id - b.id);
  return [...grupos.values()];
}

// O horário que a pessoa deve abrir agora: o atrasado mais antigo; senão o
// próximo aberto; senão o último.
export function proximoDoGrupo(g) {
  const meus = g.itens.filter((x) => !x.deOutro);
  return meus.find((x) => x.atrasada) || meus.find((x) => aberta(x.status)) || meus[meus.length - 1] || g.itens[0];
}

// Pior situação do grupo — dá a cor da faixa do cartão.
export function situacaoDoGrupo(gTodo) {
  const g = { itens: gTodo.itens.filter((x) => !x.deOutro) };
  if (!g.itens.length) return { rotulo: 'Com a equipe', tom: 'neutro' };
  if (g.itens.some((x) => x.atrasada)) return { rotulo: 'Atrasada', tom: 'perigo' };
  if (g.itens.some((x) => x.status === 'devolvida')) return { rotulo: 'Devolvida', tom: 'atencao' };
  if (g.itens.some((x) => x.status === 'em_andamento')) return { rotulo: 'Fazendo', tom: 'latao' };
  if (g.itens.some((x) => x.status === 'pendente')) return { rotulo: 'Para fazer', tom: 'info' };
  if (g.itens.some((x) => x.status === 'aguardando_conferencia')) return { rotulo: 'Conferir', tom: 'roxo' };
  if (g.itens.every((x) => x.status === 'nao_feita')) return { rotulo: 'Não feita', tom: 'neutro' };
  return { rotulo: 'Feita', tom: 'ok' };
}

// Estado de UM horário dentro do cartão.
export function estadoDoHorario(x, proximoId) {
  if (x.deOutro) {
    const nome = String(x.responsavelNome || 'outra pessoa').split(' ')[0];
    return terminada(x.status) ? { classe: 'feito outro', rotulo: nome } : { classe: 'outro', rotulo: `com ${nome}` };
  }
  if (x.atrasada) return { classe: 'atrasado', rotulo: 'atrasado' };
  if (x.status === 'concluida') return { classe: 'feito', rotulo: 'feito' };
  if (x.status === 'aguardando_conferencia') return { classe: 'conferir', rotulo: 'entregue' };
  if (x.status === 'nao_feita') return { classe: 'nao', rotulo: 'não feito' };
  if (x.status === 'devolvida') return { classe: 'devolvido', rotulo: 'devolvido' };
  if (x.id === proximoId) return { classe: 'agora', rotulo: x.status === 'em_andamento' ? 'fazendo' : 'agora' };
  return { classe: 'depois', rotulo: 'depois' };
}

export const MODO_TEXTO = {
  cada_um: 'cada um faz a sua', qualquer_um: 'qualquer um resolve', dividir: 'dividem os passos', evento: 'todos veem',
};

// Iniciais e cor estável por pessoa (avatar sem foto).
export function iniciais(nome) {
  const p = String(nome || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
const CORES_PESSOA = ['#8a5a2b', '#2e7d6b', '#7b4fa0', '#b5532e', '#3f6fb0', '#6b7d2e', '#a03f6b', '#4f6b7d'];
export function corPessoa(id) { return CORES_PESSOA[Math.abs(Number(id) || 0) % CORES_PESSOA.length]; }

// Evento: "começa às 15:00" / "começou às 15:00" — nunca "atrasado".
export function estadoEvento(ev, agora = new Date()) {
  if (!ev.horario) return { rotulo: 'hoje', tom: 'info' };
  const hm = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false }).format(agora);
  const min = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const falta = min(ev.horario) - min(hm);
  if (falta > 60) return { rotulo: `começa às ${ev.horario}`, tom: 'info' };
  if (falta > 0) return { rotulo: `começa em ${falta} min`, tom: 'atencao' };
  const dur = ev.minutos || 60;
  if (-falta < dur) return { rotulo: 'acontecendo agora', tom: 'ok' };
  return { rotulo: `foi às ${ev.horario}`, tom: 'neutro' };
}
