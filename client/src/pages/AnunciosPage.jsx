import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw, X, Megaphone, Eye, ShoppingBag, ExternalLink, History, Link2,
  Link2Off, PackageSearch, Download, Pencil, AlertTriangle, TrendingUp,
  LayoutGrid, Layers, ArrowLeft, Copy, Table2, PauseCircle, PlayCircle,
  Store, CheckSquare,
} from 'lucide-react';
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { api } from '../api/client';
import {
  EstadoVazio, Select, MultiSelect, Skeleton, CampoBusca, ChipsFiltros, FiltrosAvancados,
  IndicadorDestaque, Paginacao, Checkbox,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { confirmar } from '../components/ConfirmDialog';
import { useTabela } from '../lib/useTabela';
import { brl, numeroBr, formatQtd, tempoRelativo, dataBr } from '../lib/format';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import { SeloPlataforma, nomeDaLoja, chaveDaPlataforma, PREFIXO_PLATAFORMA } from '../lib/canalMarketplace';
import { usePaletaGrafico } from '../lib/coresGrafico';

// Marketplace › Anúncios.
//
// A grade imita o painel da Shopee de propósito — é o formato que a equipe já
// lê sem precisar aprender. As duas coisas que aquele painel NÃO tem, e que
// são o motivo desta tela existir: de qual LOJA é cada anúncio (aqui convivem
// quatro plataformas e duas contas em cada uma), e se ele roda Ads.
//
// ANÚNCIO x VARIAÇÃO — a correção de 10/09/2026
//
// O painel do Mercado Livre da conta Origem diz "82 anúncios". Esta tela dizia
// perto de 800. Os dois números estavam certos, contando coisas diferentes:
//
//   · o painel conta a PUBLICAÇÃO — o anúncio que a pessoa criou;
//   · a API devolve os ITENS — e um anúncio com variações pode virar um item
//     MLB por variação, todos amarrados pelo mesmo `user_product_id`.
//
// A tela mostrava a contagem da API com o nome da contagem do painel, e não
// havia como conferir uma contra a outra. Agora o padrão é a PUBLICAÇÃO (bate
// com o painel), e a variação continua a um clique de distância — nada foi
// escondido, só reorganizado (REGRA 2: número menor não pode parecer perda).
//
// Quatro modos de ver a mesma lista:
//   · por anúncio    — um cartão por PUBLICAÇÃO, igual ao painel da plataforma;
//   · por variação   — um cartão por item da plataforma, a lista crua;
//   · por referência — um cartão por produto em cada loja, com contador;
//   · comparar lojas — a matriz produto × plataforma, que é a organização da
//                      planilha da casa.

const STATUS_ROTULO = {
  ativo: 'Ativo',
  pausado: 'Pausado',
  encerrado: 'Encerrado',
  em_analise: 'Em análise',
  violacao: 'Violação',
  // A plataforma respondeu uma situação que o sistema não conhece. NÃO é
  // "pausado" — era esse chute que fazia anúncio ativo aparecer como pausado.
  desconhecido: 'Situação não reconhecida',
};

const PLATAFORMAS_MATRIZ = ['shopee', 'mercado_livre', 'tiktok_shop', 'shein'];

// Como o período do Ads é dito em texto na tela. Sem intervalo escolhido,
// continua sendo "nos últimos 30 dias"; com intervalo, são as duas datas — e
// nunca "nos últimos 0 dias", que era o risco de derivar isso de uma conta.
function rotuloPeriodoAds(periodo) {
  if (periodo?.inicio && periodo?.fim) return `de ${dataBr(periodo.inicio)} a ${dataBr(periodo.fim)}`;
  if (periodo?.inicio) return `a partir de ${dataBr(periodo.inicio)}`;
  if (periodo?.fim) return `até ${dataBr(periodo.fim)}`;
  return 'nos últimos 30 dias';
}

// Os parâmetros de período que vão para o servidor, na mesma forma usada pela
// listagem — assim o painel do anúncio e a grade somam exatamente o mesmo Ads.
function paramsPeriodoAds(periodo) {
  const p = new URLSearchParams();
  if (periodo?.inicio) p.set('de', periodo.inicio);
  if (periodo?.fim) p.set('ate', periodo.fim);
  if (!periodo?.inicio && !periodo?.fim) p.set('dias', '30');
  return p.toString();
}

// Colunas ordenáveis. Sem isso a ordem era sempre plataforma → loja → título,
// e "o mais caro primeiro" / "o de pior ROAS" — que são as perguntas que
// levam alguém a abrir esta tela — não tinham resposta.
const COLUNAS_ORDENAVEIS = {
  titulo: (a) => a.titulo,
  loja: (a) => `${a.marketplace}${a.loja_nome || ''}`,
  preco: (a) => (a.preco != null ? Number(a.preco) : null),
  estoque: (a) => (a.estoque != null ? Number(a.estoque) : null),
  vendas: (a) => (a.vendas_total != null ? Number(a.vendas_total) : null),
  visitas: (a) => (a.visitas != null ? Number(a.visitas) : null),
  gasto: (a) => a.ads?.custo ?? null,
  roas: (a) => a.ads?.roas ?? null,
  situacao: (a) => STATUS_ROTULO[a.status] || a.status,
};

// Ordenação da grade de publicações. Espelha as colunas da grade de itens,
// mas lendo do grupo — o preço vira faixa, o estoque vira soma das variações.
const COLUNAS_PUBLICACAO = {
  titulo: (g) => g.titulo || g.principal?.titulo,
  loja: (g) => `${g.principal?.marketplace}${g.principal?.loja_nome || ''}`,
  preco: (g) => g.precoMin,
  estoque: (g) => g.estoqueTotal,
  vendas: (g) => g.itens.reduce((soma, i) => soma + (Number(i.vendas_total) || 0), 0),
  visitas: (g) => g.itens.reduce((soma, i) => soma + (Number(i.visitas) || 0), 0),
  gasto: (g) => g.adsCusto,
  roas: (g) => g.adsRoas,
  situacao: (g) => (g.ativos > 0 ? 'Ativo' : 'Pausado'),
};

const ORDENS = [
  { chave: 'titulo', rotulo: 'Título' },
  { chave: 'loja', rotulo: 'Loja' },
  { chave: 'preco', rotulo: 'Preço' },
  { chave: 'estoque', rotulo: 'Estoque' },
  { chave: 'vendas', rotulo: 'Vendas' },
  { chave: 'visitas', rotulo: 'Visitas' },
  { chave: 'gasto', rotulo: 'Gasto com Ads' },
  { chave: 'roas', rotulo: 'ROAS' },
  { chave: 'situacao', rotulo: 'Situação' },
];

// Chave de agrupamento "por referência": loja + produto do cadastro. É
// casamento EXATO por id — anúncio sem vínculo nunca é agrupado com outro por
// título parecido (REGRA 2), fica sozinho e a tela diz por quê.
function chaveDoGrupo(a) {
  return a.produto_id ? `${a.origem_integracao_id}:${a.produto_id}` : `avulso:${a.id}`;
}

function agruparPorReferencia(anuncios) {
  const grupos = new Map();
  for (const a of anuncios) {
    const chave = chaveDoGrupo(a);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(a);
  }
  return [...grupos.entries()].map(([chave, itens]) => {
    const precos = itens.map((i) => (i.preco != null ? Number(i.preco) : null)).filter((v) => v != null);
    const estoques = itens.map((i) => (i.estoque != null ? Number(i.estoque) : null)).filter((v) => v != null);
    const custo = itens.reduce((soma, i) => soma + (i.ads?.custo || 0), 0);
    const receita = itens.reduce((soma, i) => soma + (i.ads?.receita || 0), 0);
    return {
      chave,
      itens,
      principal: itens[0],
      quantidade: itens.length,
      // Faixa de preço em vez de um preço só: com vários anúncios do mesmo
      // produto, mostrar um preço qualquer seria escolher no escuro.
      precoMin: precos.length ? Math.min(...precos) : null,
      precoMax: precos.length ? Math.max(...precos) : null,
      // Estoque NÃO é somado entre anúncios: os anúncios do mesmo produto
      // costumam dividir o mesmo estoque físico, então somar inventaria peça
      // que não existe (REGRA 2). Mostra o maior.
      estoqueMaior: estoques.length ? Math.max(...estoques) : null,
      ativos: itens.filter((i) => i.status === 'ativo').length,
      adsCusto: custo > 0 ? custo : null,
      adsReceita: custo > 0 ? receita : null,
      adsRoas: custo > 0 ? receita / custo : null,
    };
  });
}

// Chave da PUBLICAÇÃO: loja + identificador de família da plataforma.
//
// Vem do servidor já resolvida (`publicacao_id_externa`), que no Mercado Livre
// é o `user_product_id` e, onde esse conceito não existe (Shopee, TikTok), é o
// próprio código do anúncio — nesses casos cada item continua valendo por si.
// É casamento por ID EXATO da plataforma: nada é juntado por título parecido
// (REGRA 2).
function chaveDaPublicacao(a) {
  return `${a.origem_integracao_id}:${a.publicacao_id_externa || a.anuncio_id_externo}`;
}

function agruparPorPublicacao(anuncios) {
  const grupos = new Map();
  for (const a of anuncios) {
    const chave = chaveDaPublicacao(a);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(a);
  }
  return [...grupos.entries()].map(([chave, itens]) => {
    const precos = itens.map((i) => (i.preco != null ? Number(i.preco) : null)).filter((v) => v != null);
    const custo = itens.reduce((soma, i) => soma + (i.ads?.custo || 0), 0);
    const receita = itens.reduce((soma, i) => soma + (i.ads?.receita || 0), 0);
    // A publicação herda a foto e o título do primeiro item que TIVER foto —
    // numa família por cor, o primeiro item pode ser justamente o que ficou
    // sem imagem, e o cartão sairia vazio sem motivo.
    const comFoto = itens.find((i) => i.foto_url) || itens[0];
    const estoques = itens.map((i) => (i.estoque != null ? Number(i.estoque) : null)).filter((v) => v != null);
    return {
      chave,
      itens,
      principal: comFoto,
      quantidade: itens.length,
      // Aqui o estoque É somado, ao contrário do agrupamento por referência:
      // as variações de UMA publicação são peças diferentes (cor/tamanho), não
      // anúncios distintos dividindo o mesmo estoque físico. É exatamente o
      // número que o painel da plataforma mostra na linha do anúncio.
      estoqueTotal: estoques.length ? estoques.reduce((soma, e) => soma + e, 0) : null,
      precoMin: precos.length ? Math.min(...precos) : null,
      precoMax: precos.length ? Math.max(...precos) : null,
      ativos: itens.filter((i) => i.status === 'ativo').length,
      adsCusto: custo > 0 ? custo : null,
      adsReceita: custo > 0 ? receita : null,
      adsRoas: custo > 0 ? receita / custo : null,
      titulo: comFoto.publicacao_nome || comFoto.titulo,
    };
  });
}

// Matriz produto × plataforma: uma linha por produto, uma coluna por
// plataforma. É a organização da planilha da casa, na tela.
function montarMatriz(anuncios) {
  const porProduto = new Map();
  for (const a of anuncios) {
    // Sem vínculo não entra: não dá pra saber de qual produto é, e chutar pelo
    // título seria exatamente o que a REGRA 2 proíbe.
    if (!a.produto_id) continue;
    if (!porProduto.has(a.produto_id)) {
      porProduto.set(a.produto_id, {
        produtoId: a.produto_id,
        referencia: a.referencia,
        descricao: a.produto_descricao || a.titulo,
        temFoto: a.produto_tem_foto,
        fotoAnuncio: a.foto_url,
        plataformas: {},
      });
    }
    const linha = porProduto.get(a.produto_id);
    if (!linha.plataformas[a.marketplace]) linha.plataformas[a.marketplace] = [];
    linha.plataformas[a.marketplace].push(a);
  }
  return [...porProduto.values()].sort((x, y) => (
    String(x.referencia).localeCompare(String(y.referencia), 'pt-BR', { numeric: true })
  ));
}

export default function AnunciosPage() {
  const [lojas, setLojas] = useState([]);
  const [anuncios, setAnuncios] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [sincronizando, setSincronizando] = useState(false);
  const [andamento, setAndamento] = useState(null);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  // Plataforma, loja e situação viraram LISTAS (10/09/2026): dá pra ver
  // "MELI Origem + MELI Hoggar" numa tela só, como no UpSeller.
  const [marketplaces, setMarketplaces] = useState([]);
  const [lojaIds, setLojaIds] = useState([]);
  // A tela abre filtrada em ATIVOS, que é o pedido da dona e também o padrão
  // do painel de toda plataforma: encerrado e pausado poluem a contagem e não
  // são o que se olha no dia a dia. Continua sendo um filtro comum — aparece
  // como chip e sai com um clique.
  const [status, setStatus] = useState(['ativo']);
  const [vinculo, setVinculo] = useState('');
  const [ads, setAds] = useState('');
  // Período do Ads: vazio = "últimos 30 dias" (o padrão de antes). Com data
  // escolhida no calendário, manda o intervalo.
  const [periodoAds, setPeriodoAds] = useState({ inicio: '', fim: '' });
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);

  const [selecionado, setSelecionado] = useState(null);
  // Abre em PUBLICAÇÃO — a mesma unidade que o painel da plataforma conta.
  const [modo, setModo] = useState('publicacao');
  const [publicacaoFocada, setPublicacaoFocada] = useState(null);
  const [grupoFocado, setGrupoFocado] = useState(null);
  const [marcados, setMarcados] = useState(() => new Set());
  const [aplicandoLote, setAplicandoLote] = useState(false);

  const carregarLojas = useCallback(() => {
    api.get('/anuncios/lojas').then(setLojas).catch((e) => setErro(e.message));
  }, []);

  const parametros = useCallback(() => {
    const p = new URLSearchParams();
    if (buscaAplicada) p.set('busca', buscaAplicada);
    // Lista separada por vírgula — o servidor aceita um valor ou vários no
    // mesmo parâmetro, então links e favoritos antigos continuam valendo.
    if (marketplaces.length) p.set('marketplace', marketplaces.join(','));
    if (lojaIds.length) p.set('integracao_id', lojaIds.join(','));
    if (status.length) p.set('status', status.join(','));
    // Situação escolhida à mão precisa trazer também o que saiu do ar: sem
    // isto, filtrar por "Encerrado" devolveria vazio, porque o corte padrão da
    // rota já esconde o anúncio que sumiu da loja.
    if (status.some((s) => s !== 'ativo')) p.set('incluir_inativos', '1');
    if (vinculo) p.set('vinculo', vinculo);
    if (ads) p.set('ads', ads);
    if (periodoAds.inicio) p.set('de', periodoAds.inicio);
    if (periodoAds.fim) p.set('ate', periodoAds.fim);
    if (!periodoAds.inicio && !periodoAds.fim) p.set('dias', '30');
    return p;
  }, [buscaAplicada, marketplaces, lojaIds, status, vinculo, ads, periodoAds]);

  const carregar = useCallback(() => {
    setCarregando(true);
    let cancelado = false;
    api.get(`/anuncios?${parametros().toString()}`)
      .then((dados) => { if (!cancelado) { setAnuncios(dados); setErro(''); } })
      .catch((e) => { if (!cancelado) setErro(e.message); })
      .finally(() => { if (!cancelado) setCarregando(false); });
    return () => { cancelado = true; };
  }, [parametros]);

  useEffect(carregarLojas, [carregarLojas]);
  // O retorno de `carregar` é a função de limpeza: trocar de filtro depressa
  // disparava buscas que podiam chegar fora de ordem e deixar na tela o
  // resultado de um filtro antigo. A resposta que chega depois de o efeito ser
  // descartado é ignorada.
  useEffect(carregar, [carregar]);

  // Trocar a plataforma solta as lojas que deixaram de fazer parte dela —
  // senão sobrava um filtro de loja da Shopee valendo com "só Mercado Livre"
  // marcado, e a tela voltava vazia sem dizer por quê.
  function mudarPlataformas(valores) {
    setMarketplaces(valores);
    if (valores.length === 0) return;
    setLojaIds((atuais) => atuais.filter((id) => {
      const loja = lojas.find((l) => String(l.id) === String(id));
      return loja && valores.includes(loja.marketplace);
    }));
  }

  function limparTudo() {
    setBusca(''); setBuscaAplicada(''); setMarketplaces([]); setLojaIds([]);
    setStatus([]); setVinculo(''); setAds('');
  }

  // ---- sincronização em segundo plano ----
  async function sincronizar(integracaoId) {
    setErro('');
    setAviso('');
    try {
      await api.post('/anuncios/sincronizar', integracaoId ? { integracaoId } : {});
      setSincronizando(true);
    } catch (e) {
      setErro(e.message);
    }
  }

  useEffect(() => {
    if (!sincronizando) return undefined;
    let vivo = true;
    const timer = setInterval(async () => {
      try {
        const r = await api.get('/anuncios/sincronizacao');
        if (!vivo) return;
        setAndamento(r);
        if (!r.emAndamento) {
          setSincronizando(false);
          const comErro = r.lojas.filter((l) => l.ultimo_erro);
          setAviso([
            `${formatQtd(r.lojas.reduce((s, l) => s + (l.anuncios_lidos || 0), 0))} anúncio(s) lidos.`,
            comErro.length
              ? `Falharam: ${comErro.map((l) => `${nomeDaLoja(l)} (${l.ultimo_erro})`).join('; ')}.`
              : '',
          ].filter(Boolean).join(' '));
          carregarLojas();
          carregar();
        }
      } catch {
        // Uma consulta de andamento que falha não derruba o acompanhamento —
        // a próxima tenta de novo.
      }
    }, 2500);
    return () => { vivo = false; clearInterval(timer); };
  }, [sincronizando, carregar, carregarLojas]);

  function exportar() {
    // Manda os FILTROS, não a lista de ids: com algumas centenas de anúncios
    // a lista estourava o tamanho do endereço e a exportação voltava erro.
    window.open(`/api/anuncios/exportacao/planilha?${parametros().toString()}`, '_blank');
  }

  const lojasFiltradas = useMemo(
    () => lojas.filter((l) => marketplaces.length === 0 || marketplaces.includes(l.marketplace)),
    [lojas, marketplaces]
  );

  // As opções dos dois seletores múltiplos, montadas uma vez.
  const opcoesLojas = useMemo(
    () => lojasFiltradas.map((l) => ({ valor: String(l.id), rotulo: nomeDaLoja(l) })),
    [lojasFiltradas]
  );
  const opcoesPlataformas = useMemo(
    () => Object.entries(PLATAFORMA_LABEL).map(([chave, rotulo]) => ({ valor: chave, rotulo })),
    []
  );
  const opcoesSituacao = useMemo(
    () => Object.entries(STATUS_ROTULO).map(([chave, rotulo]) => ({ valor: chave, rotulo })),
    []
  );

  const chips = useMemo(() => {
    const itens = [];
    if (buscaAplicada) itens.push({ chave: 'busca', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } });
    if (marketplaces.length) {
      itens.push({
        chave: 'mkt',
        rotulo: 'Plataforma',
        valor: marketplaces.map((m) => PLATAFORMA_LABEL[m] || m).join(', '),
        onRemover: () => mudarPlataformas([]),
      });
    }
    if (lojaIds.length) {
      itens.push({
        chave: 'loja',
        rotulo: lojaIds.length > 1 ? 'Lojas' : 'Loja',
        valor: lojaIds.map((id) => nomeDaLoja(lojas.find((x) => String(x.id) === String(id)))).join(', '),
        onRemover: () => setLojaIds([]),
      });
    }
    if (status.length) {
      itens.push({
        chave: 'status',
        rotulo: 'Situação',
        valor: status.map((v) => STATUS_ROTULO[v] || v).join(', '),
        onRemover: () => setStatus([]),
      });
    }
    if (vinculo) itens.push({ chave: 'vinc', rotulo: 'Cadastro', valor: vinculo === 'sem' ? 'sem vínculo' : 'com vínculo', onRemover: () => setVinculo('') });
    if (ads) itens.push({ chave: 'ads', rotulo: 'Ads', valor: ads === 'sim' ? 'rodando' : 'sem Ads', onRemover: () => setAds('') });
    return itens;
  }, [buscaAplicada, marketplaces, lojaIds, status, vinculo, ads, lojas]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtrosAvancadosAtivos = [marketplaces.length > 0, status.length > 0, Boolean(vinculo), Boolean(ads)]
    .filter(Boolean).length;

  const grupos = useMemo(() => agruparPorReferencia(anuncios), [anuncios]);
  const publicacoes = useMemo(() => agruparPorPublicacao(anuncios), [anuncios]);
  const matriz = useMemo(() => montarMatriz(anuncios), [anuncios]);

  const anunciosVisiveis = useMemo(() => {
    if (publicacaoFocada) return publicacoes.find((g) => g.chave === publicacaoFocada)?.itens || [];
    if (grupoFocado) return grupos.find((g) => g.chave === grupoFocado)?.itens || [];
    return anuncios;
  }, [publicacaoFocada, grupoFocado, publicacoes, grupos, anuncios]);

  // `modo` entra nas dependências (09/09/2026): a barra de ação em massa
  // aparece sempre que há algo marcado, INCLUSIVE nos modos "Por referência" e
  // "Comparar lojas", onde as caixas de seleção nem são exibidas. Marcar 30
  // anúncios na grade, trocar para a matriz e clicar em "Pausar na plataforma"
  // pausava 30 anúncios que a pessoa não estava vendo.
  useEffect(() => {
    setGrupoFocado(null);
    setPublicacaoFocada(null);
    setMarcados(new Set());
  }, [buscaAplicada, marketplaces, lojaIds, status, vinculo, ads, periodoAds, modo]);

  const tabela = useTabela(anunciosVisiveis, {
    colunas: COLUNAS_ORDENAVEIS,
    colunaPadrao: 'titulo',
    direcaoPadrao: 'asc',
    tamanhoPadrao: 50,
  });

  // A grade de publicações tem paginação própria — com 82 anúncios de uma
  // loja e 4 lojas, a lista continua longa, e a regra da casa é paginação no
  // topo E no rodapé de toda lista.
  const tabelaPublicacoes = useTabela(publicacoes, {
    colunas: COLUNAS_PUBLICACAO,
    colunaPadrao: 'titulo',
    direcaoPadrao: 'asc',
    tamanhoPadrao: 50,
  });

  const resumo = useMemo(() => {
    const comAds = anuncios.filter((a) => a.ads?.rodaAds);
    const gasto = comAds.reduce((s, a) => s + (a.ads.custo || 0), 0);
    const receita = comAds.reduce((s, a) => s + (a.ads.receita || 0), 0);
    return {
      // O número de cima é o de PUBLICAÇÕES — o mesmo que o painel da
      // plataforma mostra. `itens` fica logo abaixo, na explicação, pra
      // diferença entre os dois nunca virar mistério.
      total: publicacoes.length,
      itens: anuncios.length,
      semVinculo: anuncios.filter((a) => !a.produto_id).length,
      comAds: comAds.length,
      gasto,
      // ROAS consolidado = soma da receita ÷ soma do gasto. Nunca a média dos
      // ROAS de cada anúncio, que daria outro número (REGRA 2).
      roas: gasto > 0 ? receita / gasto : null,
    };
  }, [anuncios, publicacoes]);

  function alternarMarcado(id) {
    setMarcados((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(id)) proximo.delete(id);
      else proximo.add(id);
      return proximo;
    });
  }

  async function aplicarEmLote(situacao) {
    const ids = [...marcados];
    const verbo = situacao === 'ativo' ? 'ativar' : 'pausar';
    const ok = await confirmar(
      `${ids.length} anúncio(s) vão ser ${situacao === 'ativo' ? 'ativados' : 'pausados'} nas plataformas agora. `
      + 'A alteração vai para o ar e fica registrada no histórico com o seu nome.',
      { titulo: `Confirmar ${verbo} em massa`, confirmarTexto: `Sim, ${verbo}`, perigo: true }
    );
    if (!ok) return;
    setAplicandoLote(true);
    setErro('');
    setAviso('');
    try {
      const r = await api.post('/anuncios/situacao-em-lote', { confirmar: true, situacao, ids });
      setAviso(
        r.falhas.length === 0
          ? `${r.alterados} anúncio(s) alterados na plataforma.`
          : `${r.alterados} de ${r.total} alterados. ${r.falhas.length} recusado(s) pela plataforma: `
            + r.falhas.slice(0, 3).map((f) => f.erro).join('; ')
      );
      setMarcados(new Set());
      carregar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setAplicandoLote(false);
    }
  }

  const emGrade = modo === 'item' || grupoFocado || publicacaoFocada;
  const emPublicacoes = modo === 'publicacao' && !publicacaoFocada;
  const tabelaAtiva = emPublicacoes ? tabelaPublicacoes : tabela;
  const listaNaTela = emGrade ? tabela.itensPagina : [];
  const todosMarcados = listaNaTela.length > 0 && listaNaTela.every((a) => marcados.has(a.id));
  const jaLeuAlguma = lojas.some((l) => l.ultima_sincronizacao);

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Anúncios</h1>
          <p className="page-sub">
            Todos os anúncios de todas as lojas conectadas, num lugar só. A cor do cartão diz a
            plataforma e o selo sobre a foto diz a loja. Preço, estoque e situação são o que está
            no ar agora.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={exportar} disabled={anuncios.length === 0}>
            <Download size={14} /> Exportar planilha
          </button>
          <button className="btn btn-primary" onClick={() => sincronizar(null)} disabled={sincronizando}>
            <RefreshCw size={14} className={sincronizando ? 'girando' : ''} />
            {sincronizando ? 'Lendo as lojas…' : 'Atualizar das lojas'}
          </button>
        </div>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && <div className="card" style={{ marginBottom: 12 }}>{aviso}</div>}

      {sincronizando && <AndamentoSync andamento={andamento} />}

      <FaixaDeLojas lojas={lojas} onSincronizar={sincronizar} sincronizando={sincronizando} />

      {/* ---- filtros ---- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <CampoBusca
            valor={busca}
            onChange={setBusca}
            onSubmit={(valor) => setBuscaAplicada(valor === '' ? '' : busca)}
            placeholder="Título, SKU, código do anúncio ou referência"
          />
          {/* Várias lojas de uma vez, no formato do UpSeller: busca, "Tudo",
              caixas de seleção e Salvar. Ver MultiSelect em components/ui.jsx. */}
          <MultiSelect
            valor={lojaIds}
            onChange={setLojaIds}
            opcoes={opcoesLojas}
            rotuloTudo="Todas as lojas"
            rotuloVazio="Todas as lojas"
            larguraMinima={190}
          />
          {/* O período do Ads passou a ser o MESMO filtro de calendário das
              outras telas do módulo (10/09/2026). A lista fixa de "últimos
              7/14/30/60/90 dias" não respondia "como foi o Ads na semana da
              campanha", que é justamente quando alguém abre esta tela. */}
          <span className="filtro-ads-periodo" title="Período das métricas de publicidade">
            <Megaphone size={13} />
            <PeriodoFiltro
              inicio={periodoAds.inicio}
              fim={periodoAds.fim}
              onChange={setPeriodoAds}
              permitirTudo
            />
          </span>
          <FiltrosAvancados
            ativos={filtrosAvancadosAtivos}
            aberto={filtrosAbertos}
            onAlternar={() => setFiltrosAbertos((v) => !v)}
            resumo="Plataforma, situação, publicidade e vínculo com o cadastro."
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <MultiSelect
                valor={marketplaces}
                onChange={mudarPlataformas}
                opcoes={opcoesPlataformas}
                rotuloTudo="Todas as plataformas"
                rotuloVazio="Todas as plataformas"
                larguraMinima={180}
              />
              <MultiSelect
                valor={status}
                onChange={setStatus}
                opcoes={opcoesSituacao}
                rotuloTudo="Qualquer situação"
                rotuloVazio="Qualquer situação"
                larguraMinima={190}
              />
              <Select value={ads} onChange={(e) => setAds(e.target.value)} style={{ maxWidth: 160 }}>
                <option value="">Com e sem Ads</option>
                <option value="sim">Rodando Ads</option>
                <option value="nao">Sem Ads</option>
              </Select>
              <Select value={vinculo} onChange={(e) => setVinculo(e.target.value)} style={{ maxWidth: 200 }}>
                <option value="">Vinculados ou não</option>
                <option value="sem">Sem vínculo no cadastro</option>
                <option value="com">Vinculados ao cadastro</option>
              </Select>
            </div>
          </FiltrosAvancados>
        </div>
        {chips.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <ChipsFiltros itens={chips} onLimparTudo={limparTudo} />
          </div>
        )}
      </div>

      {/* ---- indicadores ---- */}
      {!carregando && anuncios.length > 0 && (
        <div className="indicadores-faixa compacta" style={{ marginBottom: 16 }}>
          <IndicadorDestaque
            destaque
            Icone={Store}
            rotulo="Anúncios"
            valor={formatQtd(resumo.total)}
            explicacao={[
              `Anúncios que batem com os filtros de agora`,
              status.length
                ? ` — situação: ${status.map((v) => (STATUS_ROTULO[v] || v).toLowerCase()).join(', ')}.`
                : ' (qualquer situação).',
              // A frase que evita a dúvida mais provável: "por que aqui dá
              // menos que no painel?". O painel, sem filtro, mostra tudo que
              // não foi encerrado — é o número da faixa de lojas lá em cima.
              status.length === 1 && status[0] === 'ativo'
                ? ' O painel da plataforma, sem filtro, também conta os pausados — esse número é o da faixa de lojas no topo.'
                : '',
              resumo.itens > resumo.total
                ? ` Somam ${formatQtd(resumo.itens)} variações, que é o que a API devolve; o modo "Por variação" mostra uma a uma.`
                : '',
            ].join('')}
          />
          <IndicadorDestaque
            Icone={Megaphone}
            rotulo="Rodando Ads"
            valor={formatQtd(resumo.comAds)}
            explicacao={`${brl(resumo.gasto)} gastos com publicidade ${rotuloPeriodoAds(periodoAds)}.`}
          />
          <IndicadorDestaque
            Icone={TrendingUp}
            rotulo="ROAS do conjunto"
            valor={resumo.roas != null ? `${numeroBr(resumo.roas)}x` : '—'}
            explicacao="Soma da receita atribuída dividida pela soma do gasto — não a média dos ROAS de cada anúncio, que daria outro número."
          />
          <IndicadorDestaque
            Icone={Link2Off}
            tom={resumo.semVinculo > 0 ? 'atencao' : undefined}
            rotulo="Sem vínculo"
            valor={formatQtd(resumo.semVinculo)}
            explicacao={resumo.semVinculo > 0
              ? 'Anúncios cujo SKU não bate com nenhuma referência do cadastro. Eles não entram na exportação nem na comparação entre lojas.'
              : 'Todos os anúncios do recorte estão ligados a uma referência do cadastro.'}
          />
        </div>
      )}

      {/* ---- barra de modo, ordenação e seleção ---- */}
      <div className="anuncios-barra">
        <div className="modo-exibicao" role="group" aria-label="Como agrupar os anúncios">
          <button
            type="button"
            className={'modo-btn' + (modo === 'publicacao' ? ' active' : '')}
            onClick={() => { setModo('publicacao'); setGrupoFocado(null); setPublicacaoFocada(null); }}
            title="Um cartão por anúncio, contado do mesmo jeito que o painel da plataforma conta"
          >
            <LayoutGrid size={13} /> Por anúncio
          </button>
          <button
            type="button"
            className={'modo-btn' + (modo === 'item' ? ' active' : '')}
            onClick={() => { setModo('item'); setGrupoFocado(null); setPublicacaoFocada(null); }}
            title="A lista crua: um cartão por item da plataforma. Um anúncio com variações aparece várias vezes."
          >
            <Copy size={13} /> Por variação
          </button>
          <button
            type="button"
            className={'modo-btn' + (modo === 'referencia' ? ' active' : '')}
            onClick={() => { setModo('referencia'); setGrupoFocado(null); setPublicacaoFocada(null); }}
          >
            <Layers size={13} /> Por referência
          </button>
          <button
            type="button"
            className={'modo-btn' + (modo === 'matriz' ? ' active' : '')}
            onClick={() => { setModo('matriz'); setGrupoFocado(null); setPublicacaoFocada(null); }}
          >
            <Table2 size={13} /> Comparar lojas
          </button>
        </div>

        {(emGrade || emPublicacoes) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <span className="page-sub" style={{ margin: 0 }}>Ordenar por</span>
            <Select
              value={tabelaAtiva.coluna}
              onChange={(e) => tabelaAtiva.ordenarPor(e.target.value)}
              style={{ maxWidth: 170 }}
            >
              {ORDENS.map((o) => <option key={o.chave} value={o.chave}>{o.rotulo}</option>)}
            </Select>
            <button
              type="button"
              className="btn btn-ghost sm"
              onClick={() => tabelaAtiva.ordenarPor(tabelaAtiva.coluna)}
              title={tabelaAtiva.direcao === 'asc' ? 'Do menor para o maior' : 'Do maior para o menor'}
            >
              {tabelaAtiva.direcao === 'asc' ? '↑ crescente' : '↓ decrescente'}
            </button>
          </span>
        )}

        {emGrade && listaNaTela.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost sm"
            onClick={() => setMarcados((atual) => {
              const proximo = new Set(atual);
              if (todosMarcados) listaNaTela.forEach((a) => proximo.delete(a.id));
              else listaNaTela.forEach((a) => proximo.add(a.id));
              return proximo;
            })}
          >
            <CheckSquare size={13} /> {todosMarcados ? 'Desmarcar a página' : 'Marcar a página'}
          </button>
        )}
      </div>

      {marcados.size > 0 && (
        <div className="barra-selecao">
          <strong>{marcados.size}</strong> anúncio(s) marcados
          <button className="btn btn-ghost sm" disabled={aplicandoLote} onClick={() => aplicarEmLote('pausado')}>
            <PauseCircle size={13} /> Pausar na plataforma
          </button>
          <button className="btn btn-ghost sm" disabled={aplicandoLote} onClick={() => aplicarEmLote('ativo')}>
            <PlayCircle size={13} /> Ativar na plataforma
          </button>
          <button className="btn btn-ghost sm" onClick={() => setMarcados(new Set())}>Limpar seleção</button>
        </div>
      )}

      {/* ---- conteúdo ---- */}
      {carregando ? (
        <div className="anuncios-grade">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="anuncio-card">
              <div className="anuncio-card-faixa" />
              <Skeleton height={210} radius={0} />
              <div style={{ padding: 12 }}>
                <Skeleton height={12} /><div style={{ height: 8 }} /><Skeleton height={18} width="55%" />
              </div>
            </div>
          ))}
        </div>
      ) : anuncios.length === 0 ? (
        <EstadoVazio
          Icone={PackageSearch}
          titulo="Nenhum anúncio por aqui"
          descricao={jaLeuAlguma
            ? 'Nenhum anúncio bate com esses filtros. Tente limpar a busca ou trocar a loja.'
            : 'As lojas ainda não foram lidas. Clique em "Atualizar das lojas" para trazer os anúncios pela primeira vez.'}
          acaoLabel={jaLeuAlguma ? undefined : 'Atualizar das lojas'}
          onAcao={jaLeuAlguma ? undefined : () => sincronizar(null)}
          IconeAcao={RefreshCw}
        />
      ) : modo === 'matriz' ? (
        <MatrizLojas matriz={matriz} lojas={lojas} semVinculo={resumo.semVinculo} />
      ) : modo === 'publicacao' && !publicacaoFocada ? (
        <>
          <p className="page-sub" style={{ marginTop: -4, marginBottom: 12 }}>
            Um cartão por anúncio, como no painel da plataforma. Anúncio criado com variações vira
            vários itens na API do Mercado Livre — aqui eles voltam para um cartão só, juntados pelo
            código de família da própria plataforma. Clique para ver as variações.
          </p>
          <Paginacao {...tabelaPublicacoes} posicao="topo" />
          <div className="anuncios-grade">
            {tabelaPublicacoes.itensPagina.map((g) => (
              <CartaoPublicacao
                key={g.chave}
                grupo={g}
                onAbrir={() => (g.quantidade > 1 ? setPublicacaoFocada(g.chave) : setSelecionado(g.principal.id))}
              />
            ))}
          </div>
          <Paginacao {...tabelaPublicacoes} posicao="rodape" />
        </>
      ) : modo === 'referencia' && !grupoFocado ? (
        <>
          <p className="page-sub" style={{ marginTop: -4, marginBottom: 12 }}>
            Um cartão por referência em cada loja. Anúncios sem vínculo com o cadastro aparecem
            sozinhos — o agrupamento é por produto, e nada é juntado por título parecido.
          </p>
          <div className="anuncios-grade">
            {grupos.map((g) => (
              <CartaoGrupo
                key={g.chave}
                grupo={g}
                onAbrir={() => (g.quantidade > 1 ? setGrupoFocado(g.chave) : setSelecionado(g.principal.id))}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          {publicacaoFocada && (
            <div className="voltar-grupo">
              <button type="button" className="btn btn-ghost sm" onClick={() => setPublicacaoFocada(null)}>
                <ArrowLeft size={13} /> Voltar para os anúncios
              </button>
              <span className="page-sub" style={{ margin: 0 }}>
                {anunciosVisiveis.length} variação(ões) do anúncio{' '}
                <strong>{anunciosVisiveis[0]?.publicacao_nome || anunciosVisiveis[0]?.titulo || ''}</strong>
              </span>
            </div>
          )}
          {grupoFocado && (
            <div className="voltar-grupo">
              <button type="button" className="btn btn-ghost sm" onClick={() => setGrupoFocado(null)}>
                <ArrowLeft size={13} /> Voltar para o agrupado
              </button>
              <span className="page-sub" style={{ margin: 0 }}>
                {anunciosVisiveis.length} anúncio(s) de{' '}
                <strong className="mono">{anunciosVisiveis[0]?.referencia || 'sem referência'}</strong>
                {' '}na <strong>{nomeDaLoja({
                  marketplace: anunciosVisiveis[0]?.marketplace,
                  nome: anunciosVisiveis[0]?.loja_nome,
                })}</strong>
              </span>
            </div>
          )}
          <Paginacao {...tabela} posicao="topo" />
          <div className="anuncios-grade">
            {tabela.itensPagina.map((a) => (
              <CartaoAnuncio
                key={a.id}
                anuncio={a}
                marcado={marcados.has(a.id)}
                onMarcar={() => alternarMarcado(a.id)}
                onAbrir={() => setSelecionado(a.id)}
              />
            ))}
          </div>
          <Paginacao {...tabela} posicao="rodape" />
        </>
      )}

      {selecionado && (
        <PainelAnuncio
          anuncioId={selecionado}
          periodoAds={periodoAds}
          onFechar={() => setSelecionado(null)}
          onAlterado={carregar}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Andamento da sincronização
// ---------------------------------------------------------------------------
function AndamentoSync({ andamento }) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0, marginBottom: 4 }}>Lendo os anúncios das lojas</h3>
      <p className="page-sub" style={{ marginTop: 0, fontSize: 12 }}>
        A leitura roda no servidor e pode levar alguns minutos — a Shopee e a TikTok cobram uma
        chamada de API por anúncio. Você pode sair desta tela; ela continua.
      </p>
      <div className="sync-andamento">
        {!andamento && <Skeleton height={40} />}
        {(andamento?.lojas || []).map((l) => (
          <div key={l.integracao_id} className="sync-loja">
            <SeloPlataforma chave={l.marketplace} size={20} />
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{nomeDaLoja(l)}</div>
              <div className={`sync-barra${l.em_andamento ? '' : (l.ultimo_erro ? ' falhou' : ' pronta')}`}>
                <span />
              </div>
            </div>
            <span className="page-sub" style={{ margin: 0, fontSize: 11, whiteSpace: 'nowrap' }}>
              {l.em_andamento
                ? 'lendo…'
                : l.ultimo_erro
                  ? 'falhou'
                  : `${formatQtd(l.anuncios_lidos || 0)} anúncios`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Faixa das lojas conectadas
// ---------------------------------------------------------------------------
function FaixaDeLojas({ lojas, onSincronizar, sincronizando }) {
  if (lojas.length === 0) return null;
  return (
    <div className="lojas-faixa">
      {lojas.map((l) => (
        <div key={l.id} className={`loja-ficha${l.ultimo_erro ? ' com-erro' : ''}`}>
          <SeloPlataforma chave={l.marketplace} size={20} />
          <div>
            <div className="loja-ficha-nome">{nomeDaLoja(l)}</div>
            <div className="loja-ficha-sub">
              {l.ultimo_erro
                ? `Falhou: ${l.ultimo_erro}`
                : l.ultima_sincronizacao
                  // `anuncios` é a contagem de PUBLICAÇÕES no ar (ativas,
                  // pausadas e em análise) — o mesmo recorte que o painel da
                  // plataforma mostra sem filtro, pra este número poder ser
                  // conferido contra ele direto. Quando difere do número de
                  // itens lidos, os dois aparecem: sem isso, quem conhecia o
                  // número antigo (~800) acharia que sumiu anúncio.
                  ? `${formatQtd(l.anuncios)} anúncios${Number(l.itens) > Number(l.anuncios) ? ` · ${formatQtd(l.itens)} variações` : ''} · ${tempoRelativo(l.ultima_sincronizacao)}`
                  : 'ainda não foi lida'}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            title={`Atualizar só a ${nomeDaLoja(l)}`}
            aria-label={`Atualizar só a ${nomeDaLoja(l)}`}
            onClick={() => onSincronizar(l.id)}
            disabled={sincronizando || !l.conectada}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartão
// ---------------------------------------------------------------------------
// A foto é a DO ANÚNCIO, não a do produto no cadastro: a casa publica vários
// anúncios do mesmo produto mudando só as fotos, e usar a foto interna deixava
// meia dúzia de cartões idênticos. A EXPORTAÇÃO continua usando a foto do
// cadastro — lá é uma foto por produto, e foi o que a dona escolheu.
function fotoDoAnuncio(a) {
  return a.foto_url || (a.produto_tem_foto ? `/api/produtos/${a.produto_id}/foto` : null);
}

// A reserva, quando a foto da plataforma não abre: a foto do produto no
// cadastro. Só existe se houver produto vinculado E foto gravada.
function fotoDeReserva(a) {
  return a.foto_url && a.produto_tem_foto && a.produto_id ? `/api/produtos/${a.produto_id}/foto` : null;
}

// O ROAS ganha cor de ESTADO (acima ou abaixo de 1), que é a informação que
// interessa — nunca a cor de acento, que no sistema significa ação.
function ChipRoas({ ads }) {
  if (!ads?.rodaAds) return <span className="anuncio-roas sem">Sem Ads</span>;
  if (ads.roas == null) {
    return (
      <span className="anuncio-roas frio" title={`Gastou ${brl(ads.custo)} sem venda atribuída`}>
        sem retorno
      </span>
    );
  }
  return (
    <span
      className={`anuncio-roas${ads.roas < 1 ? ' frio' : ''}`}
      title={`Gastou ${brl(ads.custo)} e a plataforma atribuiu ${brl(ads.receita)} de venda`}
    >
      <Megaphone size={10} /> {numeroBr(ads.roas)}x
    </span>
  );
}

// A foto do anúncio, com duas quedas em vez de uma imagem quebrada.
//
// Por que precisou de queda (10/09/2026): o endereço gravado pode não abrir —
// foto apagada na plataforma, CDN fora do ar, ou uma linha antiga gravada em
// http:// antes da correção. Antes, qualquer um desses casos deixava o ícone
// de imagem quebrada do navegador no lugar da peça, sem dizer nada.
//
// A ordem é: foto do anúncio → foto do produto no cadastro → a referência
// escrita por extenso. Nunca some em silêncio (REGRA 2).
function FotoOuReferencia({ anuncio }) {
  const [falhou, setFalhou] = useState(false);
  const [tentouReserva, setTentouReserva] = useState(false);

  const principal = fotoDoAnuncio(anuncio);
  const reserva = fotoDeReserva(anuncio);
  const foto = falhou ? null : (tentouReserva ? reserva : principal);

  // Anúncio diferente = foto diferente: sem isto, rolar a grade reaproveitaria
  // o "falhou" de um cartão em outro.
  useEffect(() => { setFalhou(false); setTentouReserva(false); }, [anuncio.id, principal]);

  if (foto) {
    return (
      <img
        src={foto}
        alt=""
        loading="lazy"
        decoding="async"
        // A CDN do Mercado Livre recusa requisição com referer de outro site.
        // Sem isto, parte das fotos volta 403 mesmo com o endereço certo.
        referrerPolicy="no-referrer"
        onError={() => {
          if (!tentouReserva && reserva) setTentouReserva(true);
          else setFalhou(true);
        }}
      />
    );
  }
  // Sem foto: a referência grande na tinta da plataforma. Diz "não tem foto" e
  // ainda ajuda a identificar a peça — melhor que um ícone cinza.
  return (
    <div className="anuncio-card-foto-vazia">
      {anuncio.referencia || anuncio.anuncio_id_externo}
      <small>{falhou ? 'foto não abriu' : 'sem foto'}</small>
    </div>
  );
}

function CartaoAnuncio({ anuncio, marcado, onMarcar, onAbrir }) {
  const chave = chaveDaPlataforma(anuncio.marketplace);
  const preco = anuncio.preco != null ? Number(anuncio.preco) : null;
  const precoDe = anuncio.preco_original != null ? Number(anuncio.preco_original) : null;
  const desconto = precoDe && preco && precoDe > preco ? Math.round((1 - preco / precoDe) * 100) : null;

  return (
    <article className={`anuncio-card plataforma-${chave}${marcado ? ' selecionado' : ''}`}>
      <div className="anuncio-card-faixa" />
      {/* Link esticado: o cartão inteiro clica, mas continua sendo um
          <article>, então cabem controles próprios dentro dele — dentro de um
          <button> não caberia a caixa de seleção. */}
      <button type="button" className="anuncio-card-alvo" onClick={onAbrir}>
        Abrir {anuncio.titulo || 'anúncio'}
      </button>

      <div className="anuncio-card-foto">
        <FotoOuReferencia anuncio={anuncio} />
        <span className="anuncio-card-loja">
          <SeloPlataforma chave={chave} size={14} />
          <span>{nomeDaLoja({ marketplace: anuncio.marketplace, nome: anuncio.loja_nome })}</span>
        </span>
        <span className="anuncio-card-selecao">
          <Checkbox checked={marcado} onChange={onMarcar} aria-label={`Marcar ${anuncio.titulo || 'anúncio'}`} />
        </span>
      </div>

      <div className="anuncio-card-corpo">
        <p className="anuncio-card-titulo">{anuncio.titulo || '(sem título)'}</p>
        <div className="anuncio-card-linha-preco">
          <span className="anuncio-card-preco">{preco != null ? brl(preco) : '—'}</span>
          {desconto != null && <span className="anuncio-card-preco-de">{brl(precoDe)}</span>}
          {desconto != null && <span className="anuncio-card-desconto">−{desconto}%</span>}
        </div>
        {!anuncio.referencia && (
          <span className="anuncio-card-sem-vinculo"><Link2Off size={11} /> sem vínculo no cadastro</span>
        )}
        <div className="anuncio-card-ref">
          <span>{anuncio.referencia || ''}</span>
          {/* O código do anúncio é a única coisa que diferencia dois anúncios
              do mesmo produto na mesma loja. */}
          <span className="anuncio-card-id" title="Código do anúncio na plataforma">
            {anuncio.anuncio_id_externo}
          </span>
        </div>
        <div className="anuncio-card-metricas">
          <span title="Visitas informadas pela plataforma">
            <Eye size={11} /> {anuncio.visitas != null ? formatQtd(anuncio.visitas) : '—'}
          </span>
          <span title="Vendas acumuladas na plataforma">
            <ShoppingBag size={11} /> {anuncio.vendas_total != null ? formatQtd(anuncio.vendas_total) : '—'}
          </span>
          <span title="Estoque anunciado">
            <Layers size={11} /> {anuncio.estoque != null ? formatQtd(anuncio.estoque) : '—'}
          </span>
        </div>
      </div>

      <div className="anuncio-card-rodape">
        <span
          className="anuncio-situacao"
          title={anuncio.status === 'desconhecido' && anuncio.status_externo
            ? `A plataforma respondeu "${anuncio.status_externo}", que o sistema ainda não conhece.`
            : undefined}
        >
          <span className={`anuncio-ponto ${anuncio.status}`} />
          {STATUS_ROTULO[anuncio.status] || anuncio.status}
        </span>
        <ChipRoas ads={anuncio.ads} />
      </div>
    </article>
  );
}

// O cartão de uma PUBLICAÇÃO: um anúncio, do jeito que o painel da plataforma
// mostra. Quando ele tem variações, elas viram um contador e uma faixa de
// preço — e o clique entra na lista delas.
function CartaoPublicacao({ grupo, onAbrir }) {
  const { principal, quantidade } = grupo;
  const chave = chaveDaPlataforma(principal.marketplace);
  const faixa = grupo.precoMin == null
    ? '—'
    : (grupo.precoMin === grupo.precoMax
      ? brl(grupo.precoMin)
      : `${brl(grupo.precoMin)} – ${brl(grupo.precoMax)}`);

  return (
    <article className={`anuncio-card plataforma-${chave}`}>
      <div className="anuncio-card-faixa" />
      <button type="button" className="anuncio-card-alvo" onClick={onAbrir}>
        Abrir {grupo.titulo || principal.titulo || 'anúncio'}
      </button>

      <div className="anuncio-card-foto">
        <FotoOuReferencia anuncio={principal} />
        <span className="anuncio-card-loja">
          <SeloPlataforma chave={chave} size={14} />
          <span>{nomeDaLoja({ marketplace: principal.marketplace, nome: principal.loja_nome })}</span>
        </span>
        {quantidade > 1 && (
          <span className="anuncio-card-contador" title="Variações publicadas dentro deste anúncio">
            <Layers size={10} /> {quantidade} variações
          </span>
        )}
      </div>

      <div className="anuncio-card-corpo">
        <p className="anuncio-card-titulo">{grupo.titulo || principal.titulo || '(sem título)'}</p>
        <div className="anuncio-card-linha-preco">
          <span className="anuncio-card-preco">{faixa}</span>
        </div>
        {!principal.referencia && (
          <span className="anuncio-card-sem-vinculo"><Link2Off size={11} /> sem vínculo no cadastro</span>
        )}
        <div className="anuncio-card-ref">
          <span>{principal.referencia || ''}</span>
          <span className="anuncio-card-id" title="Código do anúncio na plataforma">
            {principal.anuncio_id_externo}
          </span>
        </div>
        <div className="anuncio-card-metricas">
          <span title="Visitas informadas pela plataforma, somando as variações">
            <Eye size={11} /> {formatQtd(grupo.itens.reduce((soma, i) => soma + (Number(i.visitas) || 0), 0))}
          </span>
          <span title="Vendas acumuladas na plataforma, somando as variações">
            <ShoppingBag size={11} /> {formatQtd(grupo.itens.reduce((soma, i) => soma + (Number(i.vendas_total) || 0), 0))}
          </span>
          <span title="Estoque anunciado somando as variações — aqui a soma vale, porque cada variação é uma peça diferente (cor/tamanho), não o mesmo estoque repetido">
            <Layers size={11} /> {grupo.estoqueTotal != null ? formatQtd(grupo.estoqueTotal) : '—'}
          </span>
        </div>
      </div>

      <div className="anuncio-card-rodape">
        <span className="anuncio-situacao">
          <span className={`anuncio-ponto ${grupo.ativos > 0 ? 'ativo' : 'pausado'}`} />
          {quantidade > 1 ? `${grupo.ativos} de ${quantidade} ativa(s)` : (STATUS_ROTULO[principal.status] || principal.status)}
        </span>
        <ChipRoas ads={grupo.adsCusto != null
          ? { rodaAds: true, roas: grupo.adsRoas, custo: grupo.adsCusto, receita: grupo.adsReceita }
          : null}
        />
      </div>
    </article>
  );
}

function CartaoGrupo({ grupo, onAbrir }) {
  const { principal, quantidade } = grupo;
  const chave = chaveDaPlataforma(principal.marketplace);
  const faixa = grupo.precoMin == null
    ? '—'
    : (grupo.precoMin === grupo.precoMax
      ? brl(grupo.precoMin)
      : `${brl(grupo.precoMin)} – ${brl(grupo.precoMax)}`);

  return (
    <article className={`anuncio-card plataforma-${chave}`}>
      <div className="anuncio-card-faixa" />
      <button type="button" className="anuncio-card-alvo" onClick={onAbrir}>
        Abrir {principal.referencia || principal.titulo}
      </button>
      <div className="anuncio-card-foto">
        <FotoOuReferencia anuncio={principal} />
        <span className="anuncio-card-loja">
          <SeloPlataforma chave={chave} size={14} />
          <span>{nomeDaLoja({ marketplace: principal.marketplace, nome: principal.loja_nome })}</span>
        </span>
        {quantidade > 1 && (
          <span className="anuncio-card-contador" title="Anúncios desta referência nesta loja">
            <Copy size={10} /> {quantidade} anúncios
          </span>
        )}
      </div>
      <div className="anuncio-card-corpo">
        <p className="anuncio-card-titulo">
          {principal.produto_descricao || principal.titulo || '(sem título)'}
        </p>
        <div className="anuncio-card-linha-preco">
          <span className="anuncio-card-preco">{faixa}</span>
        </div>
        {principal.referencia
          ? <div className="anuncio-card-ref"><span>{principal.referencia}</span></div>
          : <span className="anuncio-card-sem-vinculo"><Link2Off size={11} /> sem vínculo no cadastro</span>}
        <div className="anuncio-card-metricas">
          <span title="Maior estoque entre os anúncios do grupo — não é a soma, porque eles costumam dividir o mesmo estoque físico">
            <Layers size={11} /> {grupo.estoqueMaior != null ? formatQtd(grupo.estoqueMaior) : '—'}
          </span>
          <span title="Gasto com Ads somando os anúncios do grupo">
            <Megaphone size={11} /> {grupo.adsCusto != null ? brl(grupo.adsCusto) : '—'}
          </span>
        </div>
      </div>
      <div className="anuncio-card-rodape">
        <span className="anuncio-situacao">
          <span className={`anuncio-ponto ${grupo.ativos > 0 ? 'ativo' : 'pausado'}`} />
          {grupo.ativos} de {quantidade} ativo(s)
        </span>
        <ChipRoas ads={grupo.adsCusto != null
          ? { rodaAds: true, roas: grupo.adsRoas, custo: grupo.adsCusto, receita: grupo.adsReceita }
          : null}
        />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Matriz produto × plataforma ("Comparar lojas")
// ---------------------------------------------------------------------------
function MatrizLojas({ matriz, lojas, semVinculo }) {
  // Só mostra a coluna de uma plataforma que exista como loja conectada, mais
  // a Shein, que aparece sempre: ela está na planilha exportada e sumia da
  // tela — as duas coisas juntas confundem.
  const conectadas = new Set(lojas.map((l) => l.marketplace));
  const colunas = PLATAFORMAS_MATRIZ.filter((p) => conectadas.has(p) || p === 'shein');

  if (matriz.length === 0) {
    return (
      <EstadoVazio
        Icone={Table2}
        titulo="Nenhum anúncio vinculado a uma referência"
        descricao="A comparação entre lojas é por produto do cadastro. Vincule os anúncios a uma referência para eles aparecerem aqui."
      />
    );
  }

  return (
    <>
      <p className="page-sub" style={{ marginTop: -4, marginBottom: 12 }}>
        Uma linha por produto, uma coluna por plataforma — a organização da planilha da casa.
        Preço e ROAS são os que estão no ar agora.
        {semVinculo > 0 && ` ${formatQtd(semVinculo)} anúncio(s) sem vínculo ficaram de fora: sem referência não dá para saber de qual produto são.`}
        {' '}O lucro e a margem por loja continuam saindo na exportação, que lê o custo pela mesma
        conta da Ficha de Precificação.
      </p>
      <div className="matriz-wrap">
        <table className="matriz-anuncios">
          <thead>
            <tr>
              <th>Produto</th>
              {colunas.map((p) => (
                <th key={p}>
                  <span><SeloPlataforma chave={p} size={18} /> {PLATAFORMA_LABEL[p] || PREFIXO_PLATAFORMA[p]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matriz.map((linha) => {
              const foto = linha.fotoAnuncio
                || (linha.temFoto ? `/api/produtos/${linha.produtoId}/foto` : null);
              return (
                <tr key={linha.produtoId}>
                  <td>
                    <div className="matriz-produto">
                      {foto ? <img src={foto} alt="" loading="lazy" /> : <span className="sem-foto" />}
                      <div style={{ minWidth: 0 }}>
                        <div className="matriz-nome">{linha.descricao}</div>
                        <div className="matriz-ref">{linha.referencia}</div>
                      </div>
                    </div>
                  </td>
                  {colunas.map((p) => {
                    const itens = linha.plataformas[p] || [];
                    if (itens.length === 0) {
                      return (
                        <td key={p} className={p}>
                          <span className="matriz-vazio">NÃO ANUNCIADO</span>
                        </td>
                      );
                    }
                    const precos = itens
                      .map((i) => (i.preco != null ? Number(i.preco) : null))
                      .filter((v) => v != null);
                    const custo = itens.reduce((s, i) => s + (i.ads?.custo || 0), 0);
                    const receita = itens.reduce((s, i) => s + (i.ads?.receita || 0), 0);
                    return (
                      <td key={p} className={p}>
                        <div className="matriz-cel">
                          <span className="matriz-preco">
                            {precos.length === 0
                              ? '—'
                              : (Math.min(...precos) === Math.max(...precos)
                                ? brl(precos[0])
                                : `${brl(Math.min(...precos))} – ${brl(Math.max(...precos))}`)}
                          </span>
                          <span className="matriz-meta">
                            {itens.length > 1 && `${itens.length} anúncios · `}
                            {custo > 0 ? `ROAS ${numeroBr(receita / custo)}x` : 'sem Ads'}
                          </span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Painel de detalhe
// ---------------------------------------------------------------------------
function PainelAnuncio({ anuncioId, periodoAds, onFechar, onAlterado }) {
  const [dado, setDado] = useState(null);
  const [historico, setHistorico] = useState(null);
  const [aba, setAba] = useState('resumo');
  const [erro, setErro] = useState('');
  const painelRef = useRef(null);
  const focoAnterior = useRef(null);

  const recarregar = useCallback(() => {
    api.get(`/anuncios/${anuncioId}?${paramsPeriodoAds(periodoAds)}`).then(setDado).catch((e) => setErro(e.message));
    api.get(`/anuncios/${anuncioId}/historico`).then(setHistorico).catch(() => {});
  }, [anuncioId, periodoAds]);

  useEffect(recarregar, [recarregar]);

  // Esc fecha, o foco entra no painel e volta para onde estava ao fechar.
  // Antes o painel abria por cima e o teclado continuava navegando atrás dele.
  useEffect(() => {
    focoAnterior.current = document.activeElement;
    painelRef.current?.focus();
    function aoTeclar(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onFechar(); return; }
      if (e.key !== 'Tab') return;
      const foco = painelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!foco || foco.length === 0) return;
      const primeiro = foco[0];
      const ultimo = foco[foco.length - 1];
      if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
    }
    document.addEventListener('keydown', aoTeclar);
    const anterior = focoAnterior.current;
    return () => {
      document.removeEventListener('keydown', aoTeclar);
      anterior?.focus?.();
    };
  }, [onFechar]);

  return (
    <>
      <div className="anuncio-painel-fundo" onClick={onFechar} aria-hidden="true" />
      <aside
        className="anuncio-painel"
        ref={painelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={dado?.titulo || 'Detalhe do anúncio'}
      >
        <div className="anuncio-painel-topo">
          <SeloPlataforma chave={dado?.marketplace} size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.35 }}>
              {dado?.titulo || <Skeleton height={13} width="70%" />}
            </div>
            <div className="page-sub" style={{ margin: '2px 0 0', fontSize: 11 }}>
              {dado && `${nomeDaLoja({ marketplace: dado.marketplace, nome: dado.loja_nome })} · ${dado.anuncio_id_externo}`}
            </div>
          </div>
          {dado?.url && (
            <a className="icon-btn" href={dado.url} target="_blank" rel="noreferrer" title="Abrir na plataforma">
              <ExternalLink size={14} />
            </a>
          )}
          <button className="icon-btn" onClick={onFechar} title="Fechar (Esc)" aria-label="Fechar (Esc)"><X size={16} /></button>
        </div>

        <div className="subtab-row" style={{ padding: '0 18px' }}>
          {[['resumo', 'Resumo'], ['ads', 'Publicidade'], ['historico', 'Histórico'], ['editar', 'Editar']]
            .map(([chave, rotulo]) => (
              <button
                key={chave}
                type="button"
                className={'subtab-btn' + (aba === chave ? ' active' : '')}
                onClick={() => setAba(chave)}
              >
                {rotulo}
              </button>
            ))}
        </div>

        <div className="anuncio-painel-corpo">
          {erro && <div className="login-error">{erro}</div>}
          {!dado ? <Skeleton height={200} /> : (
            <>
              {aba === 'resumo' && <AbaResumo dado={dado} />}
              {aba === 'ads' && <AbaAds dado={dado} />}
              {aba === 'historico' && <AbaHistorico historico={historico} />}
              {aba === 'editar' && <AbaEditar dado={dado} onGravado={() => { recarregar(); onAlterado(); }} />}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function AbaResumo({ dado }) {
  const foto = fotoDoAnuncio(dado);
  const esgotadas = (dado.variacoes || []).filter((v) => v.ativo && Number(v.estoque) === 0).length;
  return (
    <>
      <div style={{ display: 'flex', gap: 16 }}>
        {foto && (
          <img
            src={foto}
            alt=""
            style={{ width: 132, height: 132, objectFit: 'cover', borderRadius: 'var(--radius-sm)', flex: '0 0 auto' }}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, minWidth: 0 }}>
          <div>
            <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, letterSpacing: '-.02em' }}>
              {dado.preco != null ? brl(dado.preco) : '—'}
            </strong>
          </div>
          <div>Estoque anunciado: <strong>{dado.estoque != null ? formatQtd(dado.estoque) : '—'}</strong></div>
          <div className="anuncio-situacao" style={{ fontSize: 12.5 }}>
            <span className={`anuncio-ponto ${dado.status}`} />
            {STATUS_ROTULO[dado.status] || dado.status}
            {dado.status === 'desconhecido' && dado.status_externo && (
              <span className="page-sub" style={{ margin: 0, fontSize: 11 }}>
                — a plataforma respondeu &quot;{dado.status_externo}&quot;
              </span>
            )}
          </div>
          <div>SKU no anúncio: <span className="mono">{dado.sku_externo || '—'}</span></div>
          <div>
            {dado.referencia
              ? <><Link2 size={12} /> Vinculado a <strong className="mono">{dado.referencia}</strong> — {dado.produto_descricao}</>
              : <span className="anuncio-card-sem-vinculo"><Link2Off size={11} /> sem vínculo com o cadastro</span>}
          </div>
        </div>
      </div>

      <div className="page-sub" style={{ fontSize: 11, margin: 0 }}>
        Lido da plataforma {tempoRelativo(dado.ultima_sincronizacao)}
        {dado.atualizado_em_plataforma && ` · alterado lá ${tempoRelativo(dado.atualizado_em_plataforma)}`}
        {!dado.ativo && dado.sumiu_em && ` · saiu da listagem ${tempoRelativo(dado.sumiu_em)}`}
      </div>

      {dado.variacoes?.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 6px' }}>
            Variações ({dado.variacoes.length})
            {esgotadas > 0 && (
              <span className="stamp sm tone-atencao" style={{ marginLeft: 8 }}>
                {esgotadas} esgotada(s)
              </span>
            )}
          </h4>
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Cor</th><th>Tam.</th><th>SKU</th>
                <th style={{ textAlign: 'right' }}>Preço</th>
                <th style={{ textAlign: 'right' }}>Estoque</th>
              </tr>
            </thead>
            <tbody>
              {dado.variacoes.map((v) => (
                <tr
                  key={v.id}
                  style={{ opacity: v.ativo ? 1 : 0.5 }}
                  className={v.ativo && Number(v.estoque) === 0 ? 'variacao-esgotada' : undefined}
                >
                  <td>{v.cor || '—'}</td>
                  <td>{v.tamanho || '—'}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{v.sku_externo || '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{v.preco != null ? brl(v.preco) : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {v.estoque != null ? formatQtd(v.estoque) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AbaAds({ dado }) {
  const ads = dado.ads || {};
  const paleta = usePaletaGrafico();
  if (!ads.rodaAds) {
    return (
      <EstadoVazio
        Icone={Megaphone}
        titulo={`Este anúncio não teve gasto com Ads ${rotuloPeriodoAds({ inicio: ads.de, fim: ads.ate })}`}
        descricao={ads.diasComDado > 0
          ? 'Existe métrica registrada no período, mas sem custo — a campanha pode estar pausada.'
          : 'Nenhuma métrica de publicidade foi registrada para este anúncio no período. Isso pode significar que ele nunca foi anunciado, ou que a leitura de Ads dessa loja ainda não rodou.'}
      />
    );
  }
  const serie = (dado.adsDiario || []).map((d) => ({
    dia: new Date(`${String(d.data).slice(0, 10)}T00:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
    gasto: Number(d.custo) || 0,
    receita: Number(d.receita) || 0,
  }));

  return (
    <>
      <div className="grid-3">
        <Indicador
          rotulo={ads.de || ads.ate ? 'Gasto no período' : `Gasto em ${ads.janelaDias} dias`}
          valor={brl(ads.custo)}
        />
        <Indicador rotulo="Receita atribuída" valor={ads.receita != null ? brl(ads.receita) : '—'} />
        <Indicador rotulo="ROAS" valor={ads.roas != null ? `${numeroBr(ads.roas)}x` : '—'} Icone={TrendingUp} />
        <Indicador rotulo="Cliques" valor={ads.cliques != null ? formatQtd(ads.cliques) : '—'} />
        <Indicador rotulo="Impressões" valor={ads.impressoes != null ? formatQtd(ads.impressoes) : '—'} />
        <Indicador rotulo="Dias com dado" valor={`${formatQtd(ads.diasComDado)} de ${ads.janelaDias}`} />
      </div>

      <p className="page-sub" style={{ fontSize: 11 }}>
        ROAS é a receita que a plataforma atribuiu à campanha dividida pelo que foi gasto nela.
        &quot;Dias com dado&quot; diz sobre quantos dias esse número foi somado — se for menos que{' '}
        {ads.janelaDias}, o total é de um período mais curto, não do período inteiro.
      </p>

      {serie.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 8px' }}>Gasto e receita, dia a dia</h4>
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={serie} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={paleta.grade} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="dia" tick={{ fontSize: 10, fill: paleta.rotulo }} stroke={paleta.eixo} />
                <YAxis
                  tick={{ fontSize: 10, fill: paleta.rotulo }}
                  stroke={paleta.eixo}
                  width={54}
                  tickFormatter={(v) => brl(v).replace('R$', '').trim()}
                />
                <Tooltip formatter={(v, n) => [brl(v), n === 'gasto' ? 'Gasto' : 'Receita atribuída']} />
                <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => (v === 'gasto' ? 'Gasto' : 'Receita atribuída')} />
                <Area type="monotone" dataKey="receita" stroke={paleta.positivo} fill={paleta.positivo} fillOpacity={0.18} />
                <Area type="monotone" dataKey="gasto" stroke={paleta.series[0]} fill={paleta.series[0]} fillOpacity={0.18} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="page-sub" style={{ fontSize: 11 }}>
            Um dia sem ponto é um dia sem métrica registrada — não é um dia com gasto zero.
          </p>
        </div>
      )}

      {ads.campanha && (
        <div className="card" style={{ margin: 0 }}>
          <h4 style={{ marginTop: 0 }}>Campanha</h4>
          <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div><strong>{ads.campanha.nome || '(sem nome)'}</strong></div>
            <div className="anuncio-situacao" style={{ fontSize: 12.5 }}>
              <span className={`anuncio-ponto ${ads.campanha.status === 'ativa' ? 'ativo' : 'pausado'}`} />
              {ads.campanha.status}
            </div>
            {ads.campanha.tipo && <div>Tipo: {ads.campanha.tipo}</div>}
            {ads.campanha.orcamentoDiario != null && (
              <div>Orçamento diário: <span className="mono">{brl(ads.campanha.orcamentoDiario)}</span></div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Indicador({ rotulo, valor, Icone }) {
  return (
    <div className="card" style={{ margin: 0, padding: '11px 13px' }}>
      <div className="page-sub" style={{ margin: 0, fontSize: 10.5 }}>{Icone && <Icone size={11} />} {rotulo}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 17, fontWeight: 700 }}>
        {valor}
      </div>
    </div>
  );
}

function AbaHistorico({ historico }) {
  if (!historico) return <Skeleton height={120} />;
  return (
    <>
      <p className="page-sub" style={{ fontSize: 11, marginTop: 0 }}>
        <History size={12} /> O histórico é gravado a partir da primeira leitura deste anúncio
        {historico.gravadoDesde && ` (${new Date(historico.gravadoDesde).toLocaleDateString('pt-BR')})`}.
        Não há reconstrução do que aconteceu antes disso — uma lista curta aqui pode significar
        &quot;pouco tempo de registro&quot;, não &quot;pouca mudança&quot;.
      </p>
      {historico.linhas.length === 0 ? (
        <EstadoVazio
          Icone={History}
          titulo="Nada mudou desde a primeira leitura"
          descricao="Assim que preço, estoque, título, foto ou situação mudarem — aqui ou na plataforma — a alteração aparece nesta lista."
        />
      ) : (
        <div>
          {historico.linhas.map((l) => (
            <div key={l.id} className="anuncio-historico-linha">
              <div className="anuncio-historico-data">
                {new Date(l.registrado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
              </div>
              <div>
                <strong>{l.campo}</strong>{' '}
                <span className="anuncio-historico-de-para">
                  <span className="anuncio-historico-antes">{l.valor_antes ?? '—'}</span>
                  {' → '}
                  <strong>{l.valor_depois ?? '—'}</strong>
                </span>
                <div className="page-sub" style={{ margin: 0, fontSize: 10.5 }}>
                  {l.origem === 'hbn_hub'
                    ? `alterado aqui no HBN Hub${l.usuario_nome ? ` por ${l.usuario_nome}` : ''}`
                    : 'percebido na leitura da plataforma'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AbaEditar({ dado, onGravado }) {
  const [preco, setPreco] = useState('');
  const [estoque, setEstoque] = useState('');
  const [titulo, setTitulo] = useState('');
  const [situacao, setSituacao] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const mudancas = [
    preco !== '' && `preço para ${brl(Number(preco))}`,
    estoque !== '' && `estoque para ${formatQtd(Number(estoque))}`,
    titulo !== '' && 'título',
    situacao !== '' && `situação para ${STATUS_ROTULO[situacao]}`,
  ].filter(Boolean);

  // A confirmação virou diálogo: antes o botão era substituído por um cartão
  // maior e o conteúdo da aba saltava.
  async function publicar() {
    const confirmado = await confirmar(
      `Confirma alterar ${mudancas.join(', ')} no anúncio "${dado.titulo}" da `
      + `${nomeDaLoja({ marketplace: dado.marketplace, nome: dado.loja_nome })}? `
      + 'A alteração vai para o ar agora.',
      { titulo: 'Alterar na plataforma', confirmarTexto: 'Sim, alterar agora', perigo: true }
    );
    if (!confirmado) return;
    setEnviando(true);
    setErro('');
    setOk('');
    try {
      await api.post(`/anuncios/${dado.id}/publicar`, {
        confirmar: true,
        preco: preco === '' ? null : Number(preco),
        estoque: estoque === '' ? null : Number(estoque),
        titulo: titulo === '' ? null : titulo,
        situacao: situacao === '' ? null : situacao,
      });
      setOk('Alteração enviada para a plataforma e registrada no histórico.');
      setPreco(''); setEstoque(''); setTitulo(''); setSituacao('');
      onGravado();
    } catch (e) {
      setErro(e.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <div className="card" style={{ margin: 0, borderColor: 'var(--warning-ring)', background: 'var(--warning-bg)' }}>
        <strong><AlertTriangle size={13} /> Isto altera o anúncio que está no ar.</strong>
        <p style={{ margin: '4px 0 0', fontSize: 12.5 }}>
          O que você mudar aqui é enviado para a {PLATAFORMA_LABEL[dado.marketplace] || dado.marketplace} na
          hora, e fica registrado no Histórico com o seu nome. Campo deixado em branco não é enviado.
        </p>
      </div>

      <div className="form-grid">
        <label>
          <span>Preço <span className="page-sub" style={{ fontSize: 11 }}>hoje {dado.preco != null ? brl(dado.preco) : '—'}</span></span>
          <input type="number" step="0.01" value={preco} onChange={(e) => setPreco(e.target.value)} placeholder="não mudar" />
        </label>
        <label>
          <span>Estoque <span className="page-sub" style={{ fontSize: 11 }}>hoje {dado.estoque != null ? formatQtd(dado.estoque) : '—'}</span></span>
          <input type="number" step="1" value={estoque} onChange={(e) => setEstoque(e.target.value)} placeholder="não mudar" />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <span>Título</span>
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder={dado.titulo || ''} />
        </label>
        <label>
          <span>Situação</span>
          <Select value={situacao} onChange={(e) => setSituacao(e.target.value)}>
            <option value="">não mudar</option>
            <option value="ativo">Ativo</option>
            <option value="pausado">Pausado</option>
          </Select>
        </label>
      </div>

      {dado.variacoes?.length > 1 && (preco !== '' || estoque !== '') && (
        <p className="page-sub" style={{ fontSize: 11 }}>
          Este anúncio tem {dado.variacoes.length} variações. O valor informado será aplicado a
          todas elas — para mexer em uma cor só, use o painel da plataforma.
        </p>
      )}

      {erro && <div className="login-error">{erro}</div>}
      {ok && <div className="card" style={{ margin: 0, borderColor: 'var(--success-ring)' }}>{ok}</div>}

      <button className="btn btn-primary" disabled={mudancas.length === 0 || enviando} onClick={publicar}>
        <Pencil size={14} /> {enviando ? 'Enviando…' : 'Alterar na plataforma'}
      </button>
    </>
  );
}
