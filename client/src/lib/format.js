// `casas` é opcional e serve para os poucos lugares onde duas casas
// escondem a informação: custo unitário de insumo (R$ 0,0500 por etiqueta) e
// a diferença de arredondamento da redistribuição de custo, que precisa ser
// mostrada com precisão para se poder afirmar que ela é zero. Sem argumento,
// o comportamento é exatamente o de sempre — R$ com duas casas.
export const brl = (n, casas) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    ...(casas === undefined ? {} : { minimumFractionDigits: casas, maximumFractionDigits: casas }),
  });

export const pct = (n, digits = 1) =>
  `${((Number.isFinite(Number(n)) ? Number(n) : 0) * 100).toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;

// Inteiro sem casas decimais, no separador de milhar brasileiro — pra
// quantidade de peças, que hoje em alguns lugares herdava .toFixed(2) de
// valor monetário e mostrava "1.00 peça"/"50044.00 peças".
export const formatQtd = (n) =>
  Math.round(Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR');

// Número com casas decimais fixas em vírgula brasileira — pra multiplicadores
// (markup "2,35x") e notas (avaliação "4,8") que hoje usavam .toFixed() puro
// e saíam com ponto.
export const numeroBr = (n, digits = 2) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

// Quantidade que pode ter fração de verdade (metros de tecido, kg de linha —
// ao contrário de peças, que são sempre inteiras). Corta zeros à direita
// (1,5000 -> "1,5", 2,0000 -> "2") em vez de arredondar pra inteiro ou
// mostrar zeros que a coluna NUMERIC do banco carrega mas não significam nada.
export const qtdFracionaria = (n) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });

// REGRA 2 na tela: "não sei" não é zero.
//
// Depois da onda de correções de cálculo (14/09/2026) várias rotas passaram a
// devolver `null` onde antes mandavam 0 — preço que não existe, custo de
// referência sem ficha. `brl(null)` escreve "R$ 0,00" e `pct(null)` escreve
// "0,0%": isso troca uma ausência por um número, que é exatamente o erro que
// a regra proíbe. Quem pode receber ausência usa estas duas e escreve o
// MOTIVO ao lado do traço — o traço sozinho ainda não explica nada.
const ausente = (n) => n === null || n === undefined || n === '' || !Number.isFinite(Number(n));

export const brlOuTraco = (n, casas) => (ausente(n) ? '—' : brl(n, casas));

export const pctOuTraco = (n, digits) => (ausente(n) ? '—' : pct(n, digits));

export const uid = () => Math.random().toString(36).slice(2, 10);


// O dia de HOJE no fuso de Brasília, em 'YYYY-MM-DD' (09/09/2026).
//
// Existe porque as telas usavam `new Date().toISOString().slice(0, 10)`, que
// é UTC: a partir das 21h no horário de Brasília os filtros de data abriam
// já no dia seguinte, e a Fila do dia da Conferência aparecia vazia para
// quem vira o turno à noite. Par do lib/dataBrasil.js do servidor.
export const hojeIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

// ⚠️ Corrigido em 10/09/2026: coluna DATE do Postgres chega ao cliente como
// timestamp ISO completo ("2026-09-09T00:00:00.000Z", serializado pelo
// `pg`+`res.json()`), não como "AAAA-MM-DD". Concatenar `T00:00:00` num valor
// que já tem hora e fuso produz uma string inválida e `Date` devolve
// "Invalid Date" sem erro nenhum — foi assim que a lista de Ordens de Produção
// (e a ficha de facção) passaram a mostrar "Invalid Date" na coluna de datas.
// Cortar para os 10 primeiros caracteres antes de montar a data resolve os
// dois formatos: "AAAA-MM-DD" já tinha exatamente esse tamanho.
export const dataBr = (iso) => {
  if (!iso) return '';
  const dia = (iso instanceof Date ? iso.toISOString() : String(iso)).slice(0, 10);
  return new Date(`${dia}T00:00:00`).toLocaleDateString('pt-BR');
};

// Tempo relativo ("agora mesmo", "há 2 h", "há 3 d") pra campos de
// sincronização — cai pra data completa em pt-BR quando mais antigo que uma
// semana, onde "há N semanas/meses" fica vago de mais pra ser útil.
// ⚠️ Trata FUTURO também (09/09/2026).
//
// Até aqui a função só sabia olhar para trás: uma data no futuro dava diferença
// negativa, caía no `< 1` e virava "agora mesmo". Passou despercebido enquanto
// só havia carimbo de coisa que já aconteceu — e apareceu na primeira coluna de
// PRAZO ("coletar até"), onde todo pedido dentro do prazo dizia "agora mesmo",
// que é exatamente o contrário do que ele queria dizer.
export function tempoRelativo(valor) {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  const diffMs = Date.now() - data.getTime();
  const futuro = diffMs < 0;
  const diffMin = Math.round(Math.abs(diffMs) / 60000);
  const prefixo = (texto) => (futuro ? `em ${texto}` : `há ${texto}`);
  if (diffMin < 1) return 'agora mesmo';
  if (diffMin < 60) return prefixo(`${diffMin} min`);
  const diffHoras = Math.round(diffMin / 60);
  if (diffHoras < 24) return prefixo(`${diffHoras} h`);
  const diffDias = Math.round(diffHoras / 24);
  if (diffDias < 7) return prefixo(`${diffDias} d`);
  return data.toLocaleDateString('pt-BR');
}

// ---------------------------------------------------------------------------
// Rótulo humano de um módulo do sistema (14/09/2026).
//
// A ponte financeira guarda o módulo de origem como a CHAVE do módulo —
// `configuracoes`, `producao`, `marketplace` — e a Caixa de Entrada e a
// Cobertura despejavam essa chave direto numa coluna chamada "MÓDULO": em
// caixa baixa, sem acento, exatamente como está no banco. `configuracoes` sem
// cedilha aparecendo para quem opera o financeiro.
//
// Fica aqui, e não em cada tela, porque são cinco lugares renderizando o mesmo
// campo — e porque a chave continua sendo a chave: só a exibição muda.
const ROTULO_MODULO = {
  produto: 'Produto',
  estoque: 'Estoque',
  producao: 'Produção',
  vendas: 'Vendas',
  marketplace: 'Marketplace',
  financeiro: 'Financeiro',
  compras: 'Compras',
  viagens: 'Viagens',
  analises: 'Análises',
  calendario: 'Calendário',
  configuracoes: 'Configurações',
};

export function rotuloModulo(chave) {
  if (!chave) return '—';
  return ROTULO_MODULO[String(chave)] || String(chave);
}

// Plural sem "(s)". O sistema tinha 1.187 ocorrências de "(s)" e "(es)" nos
// textos — "31 compra(s)", "24 DIA(S)", "50 etapa(s)" — que é o sistema
// pedindo para a pessoa fazer a concordância por ele.
//   plural(1, 'pedido')            -> '1 pedido'
//   plural(3, 'pedido')            -> '3 pedidos'
//   plural(2, 'compra', 'compras') -> '2 compras'
export function plural(n, singular, pluralForma) {
  const q = Number(n) || 0;
  const palavra = q === 1 ? singular : (pluralForma || `${singular}s`);
  return `${formatQtd(q)} ${palavra}`;
}

// Nome de campo técnico virando texto de gente (14/09/2026).
// Os dois modelos fixos do Calendário guardam os campos com o nome da coluna
// (`fornecedor_id`, `tipo_adicao`, `cor_tecido`, `valor_alvo`) e a tela de
// Modelos imprimia essa lista como subtítulo do cartão — era a única
// informação que o cartão carregava. O dado continua o mesmo; só a exibição
// deixa de ser em linguagem de banco.
const NOMES_DE_CAMPO = {
  fornecedor_id: 'Fornecedor',
  tipo_adicao: 'Tipo de adição',
  cor_tecido: 'Cor do tecido',
  valor_alvo: 'Valor da meta',
  quantidade: 'Quantidade',
};

export function rotuloCampo(nome) {
  const chave = String(nome || '').trim();
  if (!chave) return '';
  if (NOMES_DE_CAMPO[chave]) return NOMES_DE_CAMPO[chave];
  const limpo = chave.replace(/_id$/, '').replace(/[_-]+/g, ' ').trim();
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}
