// O motor da busca da Manu: normalização de texto, extração do sinal de
// "isso parece uma dúvida", aplicação de sinônimos e a configuração do
// Fuse.js. Tudo síncrono, tudo local — sem IA, sem API externa, sem rede.
//
// A "inteligência" da busca não vem de nenhum algoritmo esperto aqui: vem
// da quantidade e da variedade de formulações escritas em cada verbete
// (perguntas[]) e do dicionário de sinônimos. Este arquivo só faz o texto
// da consulta e o texto de cada pergunta chegarem no Fuse o mais parecidos
// possível um do outro.
import Fuse from 'fuse.js';
import { MAPA_SINONIMOS } from './sinonimos';

// Palavras que carregam ruído, não sentido — removidas só DEPOIS de extrair
// o sinal de intenção (pareceDuvida), porque várias delas ("como", "nao
// sei") são justamente o sinal.
const STOPWORDS = new Set([
  'como', 'oq', 'o', 'que', 'eu', 'meu', 'minha', 'pra', 'para', 'por', 'no',
  'na', 'do', 'da', 'de', 'um', 'uma', 'e', 'ai', 'aqui', 'site', 'sistema',
  'hub', 'faco', 'fazer', 'isso', 'aquilo', 'favor', 'preciso', 'queria',
  'quero', 'gostaria', 'ajuda', 'ajudar',
]);

// Expressões que marcam "isso parece uma dúvida" — decide a ORDEM dos
// grupos de resultado no ⌘K (seção 3.3 do projeto), nunca o conteúdo da
// busca em si. Frases de mais de uma palavra são conferidas contra o texto
// já normalizado (com espaços), não token a token.
const SINAIS_DUVIDA = [
  'como', 'onde', 'quando', 'porque', 'por que', 'qual', 'quais',
  'nao sei', 'nao consigo', 'nao estou conseguindo',
  'ajuda', 'duvida', 'ensina', 'tutorial', 'passo a passo',
];

// Sinônimos de mais de uma palavra ("mercado livre", "codigo de barras")
// precisam ser trocados como frase inteira, antes da tokenização — senão
// "mercado" e "livre" seriam procurados (e trocados) cada um por conta
// própria. Ordenados do mais longo pro mais curto pra uma frase de 3
// palavras não ser cortada por um match de 2 no meio dela.
const FRASES_SINONIMO = [...MAPA_SINONIMOS.keys()]
  .filter((v) => v.includes(' '))
  .sort((a, b) => b.length - a.length);

// Passo 1-4 da normalização (seção 2.4): minúsculas, sem acento, pontuação
// vira espaço, espaços colapsados. `ç` já cai em "c" no passo de remover
// acento (NFD decompõe ç em c + combining cedilla).
function normalizarBase(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stemming leve (passo 6): só tokens com mais de 4 letras, só corta "s" ou
// "es" final. De propósito superficial — um stemmer agressivo em português
// erra mais do que ajuda (ver comentário do projeto original).
function stemLeve(token) {
  if (token.length <= 4) return token;
  if (token.endsWith('es') && token.length > 6) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

// Extrai o sinal de dúvida ANTES de tirar as stopwords (ele mora justamente
// nelas) e devolve junto o texto já pronto pra virar tokens de busca.
export function analisarConsulta(textoOriginal) {
  const base = normalizarBase(textoOriginal);
  const pareceDuvida = SINAIS_DUVIDA.some((sinal) => {
    if (sinal.includes(' ')) return base.includes(sinal);
    return base.split(' ').includes(sinal);
  });
  return { base, pareceDuvida };
}

// Uma passada de troca de sinônimos de frase inteira (mais de uma
// palavra), do mais longo pro mais curto.
function trocarFrases(base) {
  let resultado = base;
  for (const frase of FRASES_SINONIMO) {
    if (resultado.includes(frase)) {
      resultado = resultado.split(frase).join(MAPA_SINONIMOS.get(frase));
    }
  }
  return resultado;
}

// Normalização completa: usada tanto na consulta digitada quanto em cada
// string de `perguntas[]` na hora de montar o índice — o mesmo pipeline
// dos dois lados é o que faz a comparação fazer sentido.
//
// Sinônimo é trocado ANTES de tirar as stopwords (a ordem inverte a leitura
// mais literal da seção 2.4, de propósito): algumas frases-sinônimo têm uma
// stopword no meio ("cor E tamanho" → "grade") e tirar o "e" primeiro
// quebraria esse casamento. Trocado em duas camadas — frase inteira (ex.:
// "mercado livre" → "marketplace") e token a token (ex.: "cadastrar" →
// "criar") — e uma troca de token pode produzir um valor de mais de uma
// palavra (ex.: "mercadolivre" → "mercado livre"), que por sua vez ainda é
// sinônimo de outra coisa ("mercado livre" → "marketplace"). Por isso a
// troca de frase roda de novo depois da troca por token, em ponto fixo
// (repete até não mudar mais nada, com um teto de segurança pra nunca
// entrar em loop).
export function normalizar(textoOriginal) {
  let atual = trocarFrases(normalizarBase(textoOriginal));

  for (let i = 0; i < 3; i += 1) {
    const comTokenTrocado = atual
      .split(' ')
      .filter(Boolean)
      .map((t) => MAPA_SINONIMOS.get(t) || t)
      .join(' ');
    const proximo = trocarFrases(comTokenTrocado);
    if (proximo === atual) { atual = proximo; break; }
    atual = proximo;
  }

  const tokens = atual
    .split(' ')
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map(stemLeve);

  return tokens.join(' ');
}

// Configuração do Fuse — ver seção 2.6. threshold e distance calibrados
// pela bateria de aceite (30 consultas, lib/ajuda/__bateria__).
export const FUSE_OPTIONS = {
  keys: [
    { name: 'perguntasNormalizadas', weight: 0.6 },
    { name: 'tituloNormalizado', weight: 0.3 },
    { name: 'telaNormalizada', weight: 0.1 },
  ],
  threshold: 0.6,
  distance: 100,
  ignoreLocation: true,
  minMatchCharLength: 3,
  includeScore: true,
  useExtendedSearch: false,
};

// Corte de relevância (seção 2.6): melhor "não encontrei" do que o verbete
// errado com cara de certo.
export const CORTE_SCORE = 0.6;

export { Fuse };
