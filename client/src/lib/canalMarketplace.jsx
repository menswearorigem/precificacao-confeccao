// Canal de marketplace: nome da LOJA e símbolo da plataforma.
//
// Por que existe: até 04/09/2026 o sistema inteiro mostrava o canal genérico
// ("Mercado Livre"), que é o texto gravado em `pedidos_venda.canal_venda`.
// Só que a casa tem MAIS DE UMA LOJA por plataforma (Origem e Hoggar), e a
// tela não dizia de qual delas era o pedido — o que obrigava a abrir cada um
// pra descobrir. Aqui o canal genérico vira "MELI Origem" com o símbolo da
// plataforma na frente.
//
// A regra de resolução, em ordem:
//   1. `origem_integracao_id` do registro → o nome cadastrado daquela loja;
//   2. sem integração conhecida → o rótulo genérico, sem inventar loja
//      (REGRA 2: não adivinhar de qual conta veio um pedido importado por
//      planilha só porque a plataforma bate).
import { Handshake, ShoppingBag, Music2, Shirt, Store } from 'lucide-react';
import { PLATAFORMA_LABEL } from './marketplaces';

// Prefixo curto por plataforma — é como a casa fala ("MELI Origem",
// "Shopee Hoggar"). O nome da loja vem do cadastro da conexão.
export const PREFIXO_PLATAFORMA = {
  mercado_livre: 'MELI',
  shopee: 'Shopee',
  tiktok_shop: 'TikTok',
  shein: 'Shein',
};

// Símbolo de cada canal. NÃO é o logotipo da plataforma — é um ícone comum
// na cor dela, o suficiente pra reconhecer o canal de relance sem reproduzir
// marca de terceiro. As cores vêm dos tokens --mkt-* do theme.css: nenhuma
// cor solta em componente (REGRA 3).
//
// Substitui o `IconePlataforma` que existia só dentro de Métricas (e que
// conhecia apenas Mercado Livre e Shopee, com cor de marca escrita à mão no
// meio do arquivo) — agora é um componente só, usado por todas as telas.
const SIMBOLO = {
  mercado_livre: Handshake,
  shopee: ShoppingBag,
  tiktok_shop: Music2,
  shein: Shirt,
};

// Chave da plataforma a partir do que estiver à mão: a chave já normalizada
// ('shopee'), o rótulo genérico gravado em canal_venda ('Shopee') ou o nome
// abreviado que aparece em planilha ('MER. LIVRE').
export function chaveDaPlataforma(valor) {
  if (!valor) return null;
  const bruto = String(valor).trim();
  if (PREFIXO_PLATAFORMA[bruto]) return bruto;
  const texto = bruto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (texto.includes('MERCADO') || texto.startsWith('MELI') || texto.startsWith('MER.')) return 'mercado_livre';
  if (texto.includes('SHOPEE')) return 'shopee';
  if (texto.includes('TIKTOK') || texto.includes('TIK TOK')) return 'tiktok_shop';
  if (texto.includes('SHEIN')) return 'shein';
  return null;
}

// Nome da loja no formato "MELI Origem". Se o nome cadastrado da conexão já
// começa com o prefixo (a dona pode ter cadastrado "MELI Origem"), não
// duplica.
export function nomeDaLoja(integracao, plataformaFallback) {
  const chave = integracao?.marketplace || chaveDaPlataforma(plataformaFallback);
  const prefixo = PREFIXO_PLATAFORMA[chave] || PLATAFORMA_LABEL[chave] || plataformaFallback || '';
  const nome = String(integracao?.nome || '').trim();
  if (!nome) return prefixo || String(plataformaFallback || '');
  const jaTemPrefixo = nome
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .startsWith(String(prefixo).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase());
  return jaTemPrefixo ? nome : `${prefixo} ${nome}`;
}

// Índice id da conexão -> conexão, pra tela montar o nome sem varrer a lista
// a cada linha.
export function indiceDeLojas(integracoes) {
  return new Map((integracoes || []).map((i) => [String(i.id), i]));
}

// Resolve o rótulo de um registro (pedido, taxa, anúncio) que tenha
// `origem_integracao_id` e/ou `canal_venda`.
export function rotuloDoCanal(registro, indiceLojas) {
  // Registro já carimbado por carimbarCanal reaproveita o resultado — assim um
  // componente filho (o card de pedido, por exemplo) mostra o nome da loja sem
  // precisar receber o índice de lojas por prop.
  if (registro?._canal) return registro._canal;
  const canal = registro?.canal_venda ?? registro?.canalVenda ?? null;
  const chave = chaveDaPlataforma(registro?.marketplace || registro?.origem_marketplace || canal);
  const loja = registro?.origem_integracao_id != null
    ? indiceLojas?.get(String(registro.origem_integracao_id))
    : null;
  return {
    chave,
    // Sem conexão conhecida o texto continua sendo o canal genérico. É
    // melhor mostrar "Mercado Livre" do que chutar a loja errada.
    texto: loja ? nomeDaLoja(loja, canal) : (canal || PLATAFORMA_LABEL[chave] || '—'),
    lojaConhecida: Boolean(loja),
  };
}

// Selo com o monograma da plataforma na cor dela. `size` em pixels.
export function SeloPlataforma({ chave, size = 16, title }) {
  const alvo = chaveDaPlataforma(chave);
  const Icone = SIMBOLO[alvo] || Store;
  return (
    <span
      className={`selo-plataforma ${alvo ? `plataforma-${alvo}` : 'selo-plataforma-desconhecida'}`}
      style={{ '--selo-size': `${size}px` }}
      title={title || PLATAFORMA_LABEL[alvo] || 'Canal não identificado'}
      aria-label={PLATAFORMA_LABEL[alvo] || 'Canal não identificado'}
    >
      <Icone size={Math.round(size * 0.58)} strokeWidth={2.3} />
    </span>
  );
}

// O componente que substitui o canal genérico nas telas: selo + nome da loja.
export function CanalMarketplace({ registro, indiceLojas, size = 15, semSelo = false }) {
  const { chave, texto, lojaConhecida } = rotuloDoCanal(registro, indiceLojas);
  return (
    <span className="canal-marketplace" title={lojaConhecida ? undefined : 'Loja não identificada — o pedido não tem conexão de marketplace vinculada.'}>
      {!semSelo && <SeloPlataforma chave={chave} size={size} />}
      <span className={lojaConhecida ? '' : 'canal-marketplace-generico'}>{texto}</span>
    </span>
  );
}

// Carimba `_canal` ({ chave, texto, lojaConhecida }) em cada registro de uma
// lista, uma vez só depois de carregar. É o que deixa ordenação, exportação e
// tabela usarem o MESMO texto de canal sem cada uma refazer a resolução — e
// sem precisar passar o índice de lojas por dentro de constante de módulo.
export function carimbarCanal(registros, indiceLojas) {
  return (registros || []).map(({ _canal: _antigo, ...r }) => ({
    ...r,
    // Recarimba sempre do zero: se a lista de lojas mudou (a dona renomeou uma
    // conexão), o rótulo antigo não pode sobreviver.
    _canal: rotuloDoCanal(r, indiceLojas),
  }));
}

// A lista de lojas para as telas do módulo Marketplace.
//
// Vem de /api/anuncios/lojas, e NÃO de /api/integracoes: a segunda é só de
// administrador (devolve client_id, client_secret e tokens), o que fazia o
// filtro "Todas as lojas" aparecer vazio pra quem não é admin — ou seja,
// justamente pra quem usa essas telas o dia inteiro. A rota nova devolve só
// id, plataforma e nome, sem uma única credencial.
export const CAMINHO_LOJAS = '/anuncios/lojas';
