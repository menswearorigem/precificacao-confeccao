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
