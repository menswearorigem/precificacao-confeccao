// Ponto de entrada da base de ajuda da Manu: junta os verbetes de todos os
// módulos, monta o índice do Fuse uma única vez (memoizado, em módulo — não
// a cada render) e expõe as duas funções que os três pontos de entrada
// (Manu flutuante, grupo do ⌘K, página /ajuda) realmente usam.
//
// Zero rede, zero IA: tudo roda em cima do array de verbetes abaixo, que é
// versionado no repositório como código comum.
import Fuse from 'fuse.js';
import { normalizar, analisarConsulta, FUSE_OPTIONS, CORTE_SCORE } from './motor';
import { getVisibleModules } from '../modules';

import { verbetesGeral } from './verbetes/geral';
import { verbetesProduto } from './verbetes/produto';
import { verbetesEstoque } from './verbetes/estoque';
import { verbetesVendas } from './verbetes/vendas';
import { verbetesMarketplace } from './verbetes/marketplace';
import { verbetesViagens } from './verbetes/viagens';
import { verbetesCompras } from './verbetes/compras';
import { verbetesAnalises } from './verbetes/analises';
import { verbetesConfiguracoes } from './verbetes/configuracoes';
import { verbetesCalendario } from './verbetes/calendario';

const TODOS_OS_VERBETES = [
  ...verbetesGeral,
  ...verbetesProduto,
  ...verbetesEstoque,
  ...verbetesVendas,
  ...verbetesMarketplace,
  ...verbetesViagens,
  ...verbetesCompras,
  ...verbetesAnalises,
  ...verbetesConfiguracoes,
  ...verbetesCalendario,
];

// Confere unicidade do id em tempo de build/carregamento do módulo — um id
// repetido quebraria o link "relacionados" e a navegação por teclado sem
// dar nenhum erro visível, então é melhor gritar cedo. Só roda em dev
// (import.meta.env.DEV), pra não gastar ciclo nenhum em produção.
if (import.meta.env?.DEV) {
  const vistos = new Map();
  for (const v of TODOS_OS_VERBETES) {
    if (vistos.has(v.id)) {
      // eslint-disable-next-line no-console
      console.error(`[ajuda] id de verbete duplicado: "${v.id}" (em ${vistos.get(v.id)} e ${v.modulo})`);
    }
    vistos.set(v.id, v.modulo);
  }
}

// Índice pré-computado: cada verbete ganha as três strings normalizadas que
// o Fuse compara (perguntas — mantidas como lista, pra casar com a melhor
// formulação individual em vez de diluir tudo numa string só — título e
// tela). Calculado uma vez, na carga do módulo.
const INDICE = TODOS_OS_VERBETES.map((v) => ({
  ...v,
  perguntasNormalizadas: v.perguntas.map(normalizar),
  tituloNormalizado: normalizar(v.titulo),
  telaNormalizada: normalizar(v.tela),
}));

const fuse = new Fuse(INDICE, FUSE_OPTIONS);

// Mapa "prefixo de rota -> chave de módulo", derivado de lib/modules.js —
// é o que permite ao painel adivinhar "em que módulo a pessoa está" a
// partir do pathname, sem duplicar a lista de rotas aqui.
function moduloDaRota(pathname) {
  for (const mod of getVisibleModules({ role: 'admin' })) {
    for (const pagina of mod.pages) {
      if (pathname === pagina.to || pathname.startsWith(`${pagina.to}/`)) return mod.key;
    }
  }
  return null;
}

// Mesma lógica de lib/modules.js (getVisibleModules/canAccessPath),
// reaplicada aqui verbete a verbete: descarta o que o módulo do usuário não
// libera, e o que é só de admin pra quem não é admin. `modulo: 'geral'`
// nunca é filtrado.
function usuarioVeVerbete(v, user) {
  if (v.modulo === 'geral') return !v.adminOnly || user?.role === 'admin';
  const isAdmin = user?.role === 'admin';
  if (!isAdmin && !(user?.modulos || []).includes(v.modulo)) return false;
  if (v.adminOnly && !isAdmin) return false;
  return true;
}

// Busca principal — usada pelas três portas. `limite` é quem chama que
// decide (o grupo do ⌘K pede 4; o painel completo pede mais).
export function buscarAjuda(termoOriginal, { user, limite = 20 } = {}) {
  const termoNormalizado = normalizar(termoOriginal);
  if (termoNormalizado.length < 2) return [];

  const brutos = fuse.search(termoNormalizado, { limit: limite * 3 }); // folga pra sobrar o bastante depois do filtro de permissão
  const filtrados = brutos.filter(
    (r) => (r.score ?? 1) <= CORTE_SCORE && usuarioVeVerbete(r.item, user)
  );
  return filtrados.slice(0, limite).map((r) => despirCamposInternos(r.item));
}

// Sinal de "isso parece uma dúvida" — decide a ordem dos grupos no ⌘K, não
// o conteúdo da busca (ver seção 3.3 do relatório da tarefa).
export function pareceDuvida(termoOriginal) {
  return analisarConsulta(termoOriginal).pareceDuvida;
}

// As N dúvidas mais comuns do módulo atual — usada com o campo de busca
// vazio ("Dúvidas comuns nesta tela"). "Mais comuns" aqui é a ordem em que
// o verbete aparece no arquivo do módulo: cada verbetes/<modulo>.js foi
// escrito começando pelas ações mais frequentes daquele módulo, então os 6
// primeiros já são a curadoria. Sem pathname reconhecido (ex.: a própria
// /ajuda sem módulo ativo), cai nos verbetes gerais.
export function listarAjuda(pathname, { user, quantidade = 6 } = {}) {
  const chave = moduloDaRota(pathname) || 'geral';
  const doModulo = TODOS_OS_VERBETES.filter((v) => v.modulo === chave && usuarioVeVerbete(v, user));
  const lista = doModulo.length > 0
    ? doModulo
    : TODOS_OS_VERBETES.filter((v) => v.modulo === 'geral' && usuarioVeVerbete(v, user));
  return lista.slice(0, quantidade).map(despirCamposInternos);
}

// Todos os verbetes de um módulo, na ordem do arquivo — usado pela página
// /ajuda pra montar o índice completo por módulo.
export function listarModulo(chaveModulo, { user } = {}) {
  return TODOS_OS_VERBETES
    .filter((v) => v.modulo === chaveModulo && usuarioVeVerbete(v, user))
    .map(despirCamposInternos);
}

export function buscarVerbetePorId(id) {
  return TODOS_OS_VERBETES.find((v) => v.id === id) || null;
}

// ---------------------------------------------------------------------
// Registro de buscas sem resposta (seção 2.7) — sem tabela nova no banco
// (Regra 4): só localStorage, até 50 entradas, mais recente primeiro. É o
// que alimenta o bloco "Perguntas que ninguém conseguiu responder" da
// página /ajuda (só admin).
const CHAVE_SEM_RESPOSTA = 'hbn_ajuda_sem_resposta';
const MAX_SEM_RESPOSTA = 50;

export function registrarSemResposta(termoOriginal) {
  const termo = termoOriginal.trim();
  if (!termo) return;
  try {
    const atuais = listarSemResposta().filter((e) => e.termo !== termo);
    atuais.unshift({ termo, data: new Date().toISOString() });
    localStorage.setItem(CHAVE_SEM_RESPOSTA, JSON.stringify(atuais.slice(0, MAX_SEM_RESPOSTA)));
  } catch {
    // localStorage indisponível — a busca sem resposta só não fica
    // registrada; não é motivo pra quebrar a busca em si.
  }
}

export function listarSemResposta() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_SEM_RESPOSTA) || '[]');
    return Array.isArray(bruto) ? bruto : [];
  } catch {
    return [];
  }
}

export function limparSemResposta() {
  try {
    localStorage.removeItem(CHAVE_SEM_RESPOSTA);
  } catch {
    // idem — degrada em silêncio.
  }
}

// Tira os campos que só existem pra alimentar o Fuse — quem consome o
// resultado (ManuPainel, AjudaPage) não precisa saber que a busca é fuzzy.
function despirCamposInternos(v) {
  const { perguntasNormalizadas, tituloNormalizado, telaNormalizada, ...resto } = v;
  return resto;
}

export const TOTAL_VERBETES = TODOS_OS_VERBETES.length;
