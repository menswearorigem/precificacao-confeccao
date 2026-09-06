import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Store, RefreshCw, Search, X, ImageOff, Megaphone, Eye, ShoppingBag,
  ExternalLink, History, Link2, Link2Off, PackageSearch, Download, Pencil,
  AlertTriangle, TrendingUp, LayoutGrid, Layers, ArrowLeft, Copy,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Select, Skeleton, CampoBusca, ChipsFiltros } from '../components/ui';
import { brl, numeroBr, formatQtd, tempoRelativo } from '../lib/format';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import { SeloPlataforma, nomeDaLoja, chaveDaPlataforma } from '../lib/canalMarketplace';

// Marketplace › Anúncios (04/09/2026).
//
// A grade imita o painel da Shopee de propósito — é o formato que a equipe já
// lê sem precisar aprender. As duas coisas que o painel da Shopee NÃO tem, e
// que são o motivo desta tela existir:
//   · aqui convivem as quatro plataformas e as duas contas de cada uma, então
//     todo cartão diz de qual loja é (cor da plataforma na borda e no fundo,
//     selo com o nome da loja sobre a foto);
//   · todo cartão diz se aquele anúncio roda Ads, quanto gastou e qual foi o
//     ROAS dos últimos 30 dias — o número que hoje só existe abrindo o
//     gerenciador de anúncios de cada plataforma, uma por uma.

const STATUS_ROTULO = {
  ativo: 'Ativo',
  pausado: 'Pausado',
  encerrado: 'Encerrado',
  em_analise: 'Em análise',
  violacao: 'Violação',
  // A plataforma respondeu uma situação que o sistema não conhece. NÃO é
  // "pausado" — era esse chute que fazia anúncio ativo aparecer como pausado
  // na tela (corrigido em 06/09/2026).
  desconhecido: 'Situação não reconhecida',
};

const STATUS_TOM = {
  ativo: 'tone-saudavel',
  pausado: 'tone-atencao',
  encerrado: 'tone-neutro',
  em_analise: 'tone-atencao',
  violacao: 'tone-prejuizo',
  desconhecido: 'tone-neutro',
};

// Chave de agrupamento "por referência": loja + produto do cadastro. É
// casamento EXATO por id — anúncio sem vínculo nunca é agrupado com outro
// por título parecido (REGRA 2), fica sozinho e a tela diz por quê.
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
      // que não existe (REGRA 2). Mostra o maior, que é o do anúncio com mais
      // saldo publicado.
      estoqueMaior: estoques.length ? Math.max(...estoques) : null,
      ativos: itens.filter((i) => i.status === 'ativo').length,
      adsCusto: custo > 0 ? custo : null,
      adsRoas: custo > 0 ? receita / custo : null,
    };
  });
}

export default function AnunciosPage() {
  const [lojas, setLojas] = useState([]);
  const [anuncios, setAnuncios] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [sincronizando, setSincronizando] = useState(false);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [marketplace, setMarketplace] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [status, setStatus] = useState('');
  const [vinculo, setVinculo] = useState('');
  const [ads, setAds] = useState('');

  const [selecionado, setSelecionado] = useState(null);
  // 'anuncio' = um cartão por anúncio (fiel ao painel da plataforma).
  // 'referencia' = um cartão por produto em cada loja, com contador.
  const [modo, setModo] = useState('anuncio');
  const [grupoFocado, setGrupoFocado] = useState(null);

  const carregarLojas = useCallback(() => {
    api.get('/anuncios/lojas').then(setLojas).catch((e) => setErro(e.message));
  }, []);

  const carregar = useCallback(() => {
    setCarregando(true);
    const p = new URLSearchParams();
    if (buscaAplicada) p.set('busca', buscaAplicada);
    if (marketplace) p.set('marketplace', marketplace);
    if (lojaId) p.set('integracao_id', lojaId);
    if (status) p.set('status', status);
    if (vinculo) p.set('vinculo', vinculo);
    if (ads) p.set('ads', ads);
    api.get(`/anuncios?${p.toString()}`)
      .then(setAnuncios)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [buscaAplicada, marketplace, lojaId, status, vinculo, ads]);

  useEffect(carregarLojas, [carregarLojas]);
  useEffect(carregar, [carregar]);

  // Trocar de plataforma tem de soltar a loja escolhida — senão sobra um
  // filtro de loja que não existe naquela plataforma e a tela volta vazia
  // sem dizer por quê.
  function mudarPlataforma(valor) {
    setMarketplace(valor);
    if (lojaId && !lojas.some((l) => String(l.id) === String(lojaId) && (!valor || l.marketplace === valor))) {
      setLojaId('');
    }
  }

  async function sincronizar(integracaoId) {
    setSincronizando(true);
    setErro('');
    setAviso('');
    try {
      const r = await api.post('/anuncios/sincronizar', integracaoId ? { integracaoId } : {});
      const ok = r.lojas.filter((l) => l.ok);
      const falhou = r.lojas.filter((l) => !l.ok);
      setAviso([
        ok.length ? `${ok.reduce((s, l) => s + (l.anuncios || 0), 0)} anúncio(s) lidos em ${ok.length} loja(s).` : '',
        falhou.length ? `Não deu para ler ${falhou.map((l) => `${l.nome || l.marketplace} (${l.erro})`).join('; ')}.` : '',
      ].filter(Boolean).join(' '));
      carregarLojas();
      carregar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSincronizando(false);
    }
  }

  function exportar() {
    const p = new URLSearchParams();
    if (marketplace) p.set('marketplace', marketplace);
    if (lojaId) p.set('integracao_id', lojaId);
    // A exportação sai com os produtos que estão na tela agora — o filtro
    // que a pessoa está vendo é o mesmo que vai pra planilha.
    const produtos = [...new Set(anuncios.map((a) => a.produto_id).filter(Boolean))];
    if (produtos.length) p.set('produtos', produtos.join(','));
    window.open(`/api/anuncios/exportacao/planilha?${p.toString()}`, '_blank');
  }

  const lojasFiltradas = useMemo(
    () => lojas.filter((l) => !marketplace || l.marketplace === marketplace),
    [lojas, marketplace]
  );

  const chips = useMemo(() => {
    const itens = [];
    if (buscaAplicada) itens.push({ chave: 'busca', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } });
    if (marketplace) itens.push({ chave: 'mkt', rotulo: 'Plataforma', valor: PLATAFORMA_LABEL[marketplace] || marketplace, onRemover: () => mudarPlataforma('') });
    if (lojaId) {
      const l = lojas.find((x) => String(x.id) === String(lojaId));
      itens.push({ chave: 'loja', rotulo: 'Loja', valor: nomeDaLoja(l), onRemover: () => setLojaId('') });
    }
    if (status) itens.push({ chave: 'status', rotulo: 'Situação', valor: STATUS_ROTULO[status] || status, onRemover: () => setStatus('') });
    if (vinculo) itens.push({ chave: 'vinc', rotulo: 'Cadastro', valor: vinculo === 'sem' ? 'sem vínculo' : 'com vínculo', onRemover: () => setVinculo('') });
    if (ads) itens.push({ chave: 'ads', rotulo: 'Ads', valor: ads === 'sim' ? 'rodando' : 'sem Ads', onRemover: () => setAds('') });
    return itens;
  }, [buscaAplicada, marketplace, lojaId, status, vinculo, ads, lojas]);

  const grupos = useMemo(() => agruparPorReferencia(anuncios), [anuncios]);

  // Ao entrar num grupo, a grade mostra só os anúncios dele — o mesmo cartão
  // de sempre, sem inventar uma terceira tela.
  const anunciosVisiveis = useMemo(() => (
    grupoFocado ? (grupos.find((g) => g.chave === grupoFocado)?.itens || []) : anuncios
  ), [grupoFocado, grupos, anuncios]);

  // Trocar filtro com um grupo aberto deixaria a tela mostrando um grupo que
  // não existe mais no resultado.
  useEffect(() => { setGrupoFocado(null); }, [buscaAplicada, marketplace, lojaId, status, vinculo, ads]);

  const resumo = useMemo(() => {
    const comAds = anuncios.filter((a) => a.ads?.rodaAds);
    const gasto = comAds.reduce((s, a) => s + (a.ads.custo || 0), 0);
    const receita = comAds.reduce((s, a) => s + (a.ads.receita || 0), 0);
    return {
      total: anuncios.length,
      semVinculo: anuncios.filter((a) => !a.produto_id).length,
      comAds: comAds.length,
      gasto,
      // ROAS consolidado = soma da receita ÷ soma do gasto. Nunca a média dos
      // ROAS de cada anúncio, que daria outro número (REGRA 2).
      roas: gasto > 0 ? receita / gasto : null,
    };
  }, [anuncios]);

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2>Anúncios</h2>
          <p className="page-sub">
            Todos os anúncios de todas as lojas conectadas, num lugar só. A cor do cartão diz a
            plataforma e o selo sobre a foto diz a loja. Preço, estoque e situação são o que está
            no ar agora; o bloco de Ads é dos últimos 30 dias.
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

      <PainelLojas lojas={lojas} onSincronizar={sincronizar} sincronizando={sincronizando} />

      {/* ---- filtros ---- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <CampoBusca
            valor={busca}
            onChange={setBusca}
            onSubmit={(valor) => setBuscaAplicada(valor === '' ? '' : busca)}
            placeholder="Título, SKU, código do anúncio ou referência"
          />
          <Select value={marketplace} onChange={(e) => mudarPlataforma(e.target.value)} style={{ maxWidth: 170 }}>
            <option value="">Todas as plataformas</option>
            {Object.entries(PLATAFORMA_LABEL).map(([chave, rotulo]) => (
              <option key={chave} value={chave}>{rotulo}</option>
            ))}
          </Select>
          <Select value={lojaId} onChange={(e) => setLojaId(e.target.value)} style={{ maxWidth: 190 }}>
            <option value="">Todas as lojas</option>
            {lojasFiltradas.map((l) => <option key={l.id} value={l.id}>{nomeDaLoja(l)}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 150 }}>
            <option value="">Qualquer situação</option>
            {Object.entries(STATUS_ROTULO).map(([chave, rotulo]) => (
              <option key={chave} value={chave}>{rotulo}</option>
            ))}
          </Select>
          <Select value={ads} onChange={(e) => setAds(e.target.value)} style={{ maxWidth: 150 }}>
            <option value="">Com e sem Ads</option>
            <option value="sim">Rodando Ads</option>
            <option value="nao">Sem Ads</option>
          </Select>
          <Select value={vinculo} onChange={(e) => setVinculo(e.target.value)} style={{ maxWidth: 170 }}>
            <option value="">Vinculados ou não</option>
            <option value="sem">Sem vínculo no cadastro</option>
            <option value="com">Vinculados ao cadastro</option>
          </Select>
          <div className="modo-exibicao" role="group" aria-label="Como agrupar os anúncios">
            <button
              type="button"
              className={'modo-btn' + (modo === 'anuncio' ? ' active' : '')}
              onClick={() => { setModo('anuncio'); setGrupoFocado(null); }}
            >
              <LayoutGrid size={13} /> Por anúncio
            </button>
            <button
              type="button"
              className={'modo-btn' + (modo === 'referencia' ? ' active' : '')}
              onClick={() => { setModo('referencia'); setGrupoFocado(null); }}
            >
              <Layers size={13} /> Por referência
            </button>
          </div>
        </div>
        {chips.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <ChipsFiltros
              itens={chips}
              onLimparTudo={() => {
                setBusca(''); setBuscaAplicada(''); setMarketplace(''); setLojaId(''); setStatus(''); setVinculo(''); setAds('');
              }}
            />
          </div>
        )}
      </div>

      {/* ---- indicadores ---- */}
      {!carregando && anuncios.length > 0 && (
        <p className="page-sub" style={{ marginTop: -4, marginBottom: 12 }}>
          <strong>{formatQtd(resumo.total)}</strong> anúncio(s) no filtro ·{' '}
          <strong>{formatQtd(resumo.comAds)}</strong> rodando Ads, com{' '}
          <strong>{brl(resumo.gasto)}</strong> gastos em 30 dias
          {resumo.roas != null && <> e ROAS consolidado de <strong>{numeroBr(resumo.roas)}x</strong></>}
          {resumo.semVinculo > 0 && (
            <> · <span className="anuncio-card-sem-vinculo">{formatQtd(resumo.semVinculo)} sem vínculo com o cadastro</span></>
          )}
          . O ROAS consolidado é a soma da receita atribuída dividida pela soma do gasto — não a
          média dos ROAS de cada anúncio.
        </p>
      )}

      {carregando ? (
        <div className="anuncios-grade">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="anuncio-card" style={{ cursor: 'default' }}>
              <Skeleton height={200} radius={0} />
              <div style={{ padding: 10 }}>
                <Skeleton height={12} /><div style={{ height: 6 }} /><Skeleton height={12} width="60%" />
              </div>
            </div>
          ))}
        </div>
      ) : anuncios.length === 0 ? (
        <EstadoVazio
          Icone={PackageSearch}
          titulo="Nenhum anúncio por aqui"
          descricao={
            lojas.some((l) => l.ultima_sincronizacao)
              ? 'Nenhum anúncio bate com esses filtros. Tente limpar a busca ou trocar a loja.'
              : 'As lojas ainda não foram lidas. Clique em "Atualizar das lojas" para trazer os anúncios pela primeira vez.'
          }
          acaoLabel={lojas.some((l) => l.ultima_sincronizacao) ? undefined : 'Atualizar das lojas'}
          onAcao={lojas.some((l) => l.ultima_sincronizacao) ? undefined : () => sincronizar(null)}
          IconeAcao={RefreshCw}
        />
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
          <div className="anuncios-grade">
            {anunciosVisiveis.map((a) => (
              <CartaoAnuncio key={a.id} anuncio={a} onAbrir={() => setSelecionado(a.id)} />
            ))}
          </div>
        </>
      )}

      {selecionado && (
        <PainelAnuncio
          anuncioId={selecionado}
          onFechar={() => setSelecionado(null)}
          onAlterado={() => { carregar(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Situação das lojas conectadas
// ---------------------------------------------------------------------------
function PainelLojas({ lojas, onSincronizar, sincronizando }) {
  if (lojas.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {lojas.map((l) => (
        <div
          key={l.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 10px', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', fontSize: 12,
          }}
        >
          <SeloPlataforma chave={l.marketplace} size={18} />
          <div>
            <div style={{ fontWeight: 600 }}>{nomeDaLoja(l)}</div>
            <div className="page-sub" style={{ margin: 0, fontSize: 11 }}>
              {l.ultimo_erro
                ? <span style={{ color: 'var(--danger)' }}>Falhou: {l.ultimo_erro}</span>
                : l.ultima_sincronizacao
                  ? `${formatQtd(l.anuncios)} anúncio(s) · lido ${tempoRelativo(l.ultima_sincronizacao)}`
                  : 'Ainda não foi lido'}
            </div>
          </div>
          <button
            className="icon-btn"
            title={`Atualizar só a ${nomeDaLoja(l)}`}
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
function CartaoAnuncio({ anuncio, onAbrir }) {
  const chave = chaveDaPlataforma(anuncio.marketplace);
  const preco = anuncio.preco != null ? Number(anuncio.preco) : null;
  const precoDe = anuncio.preco_original != null ? Number(anuncio.preco_original) : null;
  const desconto = precoDe && preco && precoDe > preco ? Math.round((1 - preco / precoDe) * 100) : null;

  // A foto é a DO ANÚNCIO, não a do produto no cadastro.
  //
  // Corrigido em 06/09/2026: a tela usava a foto interna do produto, que é a
  // mesma para todos os anúncios da mesma referência. Como aqui a casa publica
  // vários anúncios do mesmo produto (todas as cores em cada um, mudando só as
  // fotos), e título e preço também se repetem, o resultado era meia dúzia de
  // cartões idênticos, sem nada que os distinguisse.
  // A EXPORTAÇÃO continua usando a foto do cadastro — lá é uma foto por
  // produto, e foi o que a dona escolheu.
  const foto = anuncio.foto_url || (anuncio.produto_tem_foto ? `/api/produtos/${anuncio.produto_id}/foto` : null);

  return (
    <button type="button" className={`anuncio-card plataforma-${chave}`} onClick={onAbrir}>
      <div className="anuncio-card-foto">
        {foto
          ? <img src={foto} alt="" loading="lazy" />
          : <div className="anuncio-card-foto-vazia"><ImageOff size={28} /></div>}
        <span className="anuncio-card-loja">
          <SeloPlataforma chave={chave} size={14} />
          <span>{nomeDaLoja({ marketplace: anuncio.marketplace, nome: anuncio.loja_nome })}</span>
        </span>
        {desconto != null && <span className="anuncio-card-desconto">{desconto}% OFF</span>}
        {anuncio.ads?.rodaAds && (
          <span className="anuncio-card-ads" title={`Gastou ${brl(anuncio.ads.custo)} em 30 dias`}>
            <Megaphone size={10} />
            {anuncio.ads.roas != null ? `ROAS ${numeroBr(anuncio.ads.roas)}x` : 'Ads sem retorno'}
          </span>
        )}
      </div>
      <div className="anuncio-card-corpo">
        <p className="anuncio-card-titulo">{anuncio.titulo || '(sem título)'}</p>
        <div className="anuncio-card-preco">
          {preco != null ? brl(preco) : '—'}
          {desconto != null && <small>{brl(precoDe)}</small>}
        </div>
        <div className="anuncio-card-estoque">
          Estoque {anuncio.estoque != null ? formatQtd(anuncio.estoque) : '—'}
          {' · '}
          <span
            className={`stamp sm ${STATUS_TOM[anuncio.status] || 'tone-neutro'}`}
            title={anuncio.status === 'desconhecido' && anuncio.status_externo
              ? `A plataforma respondeu "${anuncio.status_externo}", que o sistema ainda não conhece.`
              : undefined}
          >
            {STATUS_ROTULO[anuncio.status] || anuncio.status}
          </span>
        </div>
        <div className="anuncio-card-ref">
          {anuncio.referencia
            ? anuncio.referencia
            : <span className="anuncio-card-sem-vinculo">sem vínculo no cadastro</span>}
          {/* O código do anúncio é a única coisa que diferencia dois anúncios
              do mesmo produto na mesma loja — sem ele os cartões ficavam
              indistinguíveis. */}
          <span className="anuncio-card-id" title="Código do anúncio na plataforma">
            {anuncio.anuncio_id_externo}
          </span>
        </div>
        <div className="anuncio-card-metricas">
          <span title="Visitas"><Eye size={11} /> {anuncio.visitas != null ? formatQtd(anuncio.visitas) : '—'}</span>
          <span title="Vendas na plataforma"><ShoppingBag size={11} /> {anuncio.vendas_total != null ? formatQtd(anuncio.vendas_total) : '—'}</span>
          <span title="Gasto com Ads em 30 dias">
            <Megaphone size={11} /> {anuncio.ads?.custo != null ? brl(anuncio.ads.custo) : '—'}
          </span>
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Cartão de grupo (modo "por referência")
// ---------------------------------------------------------------------------
function CartaoGrupo({ grupo, onAbrir }) {
  const { principal, quantidade } = grupo;
  const chave = chaveDaPlataforma(principal.marketplace);
  const foto = principal.foto_url
    || (principal.produto_tem_foto ? `/api/produtos/${principal.produto_id}/foto` : null);
  const faixa = grupo.precoMin == null
    ? '—'
    : (grupo.precoMin === grupo.precoMax
      ? brl(grupo.precoMin)
      : `${brl(grupo.precoMin)} – ${brl(grupo.precoMax)}`);

  return (
    <button type="button" className={`anuncio-card plataforma-${chave}`} onClick={onAbrir}>
      <div className="anuncio-card-foto">
        {foto
          ? <img src={foto} alt="" loading="lazy" />
          : <div className="anuncio-card-foto-vazia"><ImageOff size={28} /></div>}
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
        <div className="anuncio-card-preco">{faixa}</div>
        <div className="anuncio-card-estoque">
          {grupo.ativos} de {quantidade} ativo(s)
          {grupo.estoqueMaior != null && ` · maior estoque ${formatQtd(grupo.estoqueMaior)}`}
        </div>
        <div className="anuncio-card-ref">
          {principal.referencia
            ? principal.referencia
            : <span className="anuncio-card-sem-vinculo">sem vínculo no cadastro</span>}
        </div>
        <div className="anuncio-card-metricas">
          <span title="Gasto com Ads em 30 dias, somando os anúncios do grupo">
            <Megaphone size={11} /> {grupo.adsCusto != null ? brl(grupo.adsCusto) : '—'}
          </span>
          {grupo.adsRoas != null && (
            <span title="ROAS do grupo: soma da receita ÷ soma do gasto">
              <TrendingUp size={11} /> {numeroBr(grupo.adsRoas)}x
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Painel de detalhe
// ---------------------------------------------------------------------------
function PainelAnuncio({ anuncioId, onFechar, onAlterado }) {
  const [dado, setDado] = useState(null);
  const [historico, setHistorico] = useState(null);
  const [aba, setAba] = useState('resumo');
  const [erro, setErro] = useState('');

  useEffect(() => {
    api.get(`/anuncios/${anuncioId}`).then(setDado).catch((e) => setErro(e.message));
    api.get(`/anuncios/${anuncioId}/historico`).then(setHistorico).catch(() => {});
  }, [anuncioId]);

  function recarregar() {
    api.get(`/anuncios/${anuncioId}`).then(setDado).catch((e) => setErro(e.message));
    api.get(`/anuncios/${anuncioId}/historico`).then(setHistorico).catch(() => {});
    onAlterado();
  }

  return (
    <>
      <button type="button" className="anuncio-painel-fundo" aria-label="Fechar" onClick={onFechar} />
      <aside className="anuncio-painel">
        <div className="anuncio-painel-topo">
          <SeloPlataforma chave={dado?.marketplace} size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.35 }}>
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
          <button className="icon-btn" onClick={onFechar} title="Fechar"><X size={16} /></button>
        </div>

        <div className="subtab-row" style={{ padding: '0 16px' }}>
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
              {aba === 'editar' && <AbaEditar dado={dado} onGravado={recarregar} />}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function AbaResumo({ dado }) {
  // Mesma regra do cartão: a foto do anúncio é a que identifica o anúncio.
  const foto = dado.foto_url || (dado.produto_tem_foto ? `/api/produtos/${dado.produto_id}/foto` : null);
  return (
    <>
      <div style={{ display: 'flex', gap: 14 }}>
        {foto && <img src={foto} alt="" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 'var(--radius-sm)' }} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 }}>
          <div><strong style={{ fontFamily: 'var(--font-mono)', fontSize: 17, color: 'var(--terracotta)' }}>{dado.preco != null ? brl(dado.preco) : '—'}</strong></div>
          <div>Estoque anunciado: <strong>{dado.estoque != null ? formatQtd(dado.estoque) : '—'}</strong></div>
          <div>Situação: <span className={`stamp sm ${STATUS_TOM[dado.status] || 'tone-neutro'}`}>{STATUS_ROTULO[dado.status] || dado.status}</span></div>
          <div>SKU no anúncio: <span className="mono">{dado.sku_externo || '—'}</span></div>
          <div>
            {dado.referencia
              ? <><Link2 size={12} /> Vinculado a <strong className="mono">{dado.referencia}</strong> — {dado.produto_descricao}</>
              : <span className="anuncio-card-sem-vinculo"><Link2Off size={12} /> Sem vínculo com o cadastro</span>}
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
          <h4 style={{ margin: '0 0 6px' }}>Variações ({dado.variacoes.length})</h4>
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr><th>Cor</th><th>Tam.</th><th>SKU</th><th style={{ textAlign: 'right' }}>Preço</th><th style={{ textAlign: 'right' }}>Estoque</th></tr>
            </thead>
            <tbody>
              {dado.variacoes.map((v) => (
                <tr key={v.id} style={{ opacity: v.ativo ? 1 : 0.5 }}>
                  <td>{v.cor || '—'}</td>
                  <td>{v.tamanho || '—'}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{v.sku_externo || '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{v.preco != null ? brl(v.preco) : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{v.estoque != null ? formatQtd(v.estoque) : '—'}</td>
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
  if (!ads.rodaAds) {
    return (
      <EstadoVazio
        Icone={Megaphone}
        titulo="Este anúncio não teve gasto com Ads nos últimos 30 dias"
        descricao={
          ads.diasComDado > 0
            ? 'Existe métrica registrada no período, mas sem custo — a campanha pode estar pausada.'
            : 'Nenhuma métrica de publicidade foi registrada para este anúncio no período. Isso pode significar que ele nunca foi anunciado, ou que a leitura de Ads dessa loja ainda não rodou.'
        }
      />
    );
  }
  return (
    <>
      <div className="grid-3">
        <Indicador rotulo="Gasto em 30 dias" valor={brl(ads.custo)} />
        <Indicador rotulo="Receita atribuída" valor={ads.receita != null ? brl(ads.receita) : '—'} />
        <Indicador rotulo="ROAS" valor={ads.roas != null ? `${numeroBr(ads.roas)}x` : '—'} Icone={TrendingUp} />
        <Indicador rotulo="Cliques" valor={ads.cliques != null ? formatQtd(ads.cliques) : '—'} />
        <Indicador rotulo="Impressões" valor={ads.impressoes != null ? formatQtd(ads.impressoes) : '—'} />
        <Indicador rotulo="Dias com dado" valor={`${formatQtd(ads.diasComDado)} de ${ads.janelaDias}`} />
      </div>

      <p className="page-sub" style={{ fontSize: 11 }}>
        ROAS é a receita que a plataforma atribuiu à campanha dividida pelo que foi gasto nela.
        "Dias com dado" diz sobre quantos dias esse número foi somado — se for menos que {ads.janelaDias},
        o total é de um período mais curto, não de um mês inteiro.
      </p>

      {ads.campanha && (
        <div className="card" style={{ margin: 0 }}>
          <h4 style={{ marginTop: 0 }}>Campanha</h4>
          <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div><strong>{ads.campanha.nome || '(sem nome)'}</strong></div>
            <div>Situação: <span className={`stamp sm ${ads.campanha.status === 'ativa' ? 'tone-saudavel' : 'tone-atencao'}`}>{ads.campanha.status}</span></div>
            {ads.campanha.tipo && <div>Tipo: {ads.campanha.tipo}</div>}
            {ads.campanha.orcamentoDiario != null && <div>Orçamento diário: <span className="mono">{brl(ads.campanha.orcamentoDiario)}</span></div>}
          </div>
        </div>
      )}

      {dado.adsDiario?.length > 0 && (
        <div>
          <h4 style={{ margin: '0 0 6px' }}>Dia a dia</h4>
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr><th>Dia</th><th style={{ textAlign: 'right' }}>Gasto</th><th style={{ textAlign: 'right' }}>Receita</th><th style={{ textAlign: 'right' }}>Cliques</th></tr>
            </thead>
            <tbody>
              {dado.adsDiario.map((d) => (
                <tr key={d.data}>
                  <td className="mono">{new Date(`${String(d.data).slice(0, 10)}T00:00:00`).toLocaleDateString('pt-BR')}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{brl(d.custo)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{brl(d.receita)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{formatQtd(d.cliques)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Indicador({ rotulo, valor, Icone }) {
  return (
    <div className="card" style={{ margin: 0, padding: '10px 12px' }}>
      <div className="page-sub" style={{ margin: 0, fontSize: 10.5 }}>{Icone && <Icone size={11} />} {rotulo}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 16, fontWeight: 700 }}>{valor}</div>
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
        "pouco tempo de registro", não "pouca mudança".
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
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  const mudancas = [
    preco !== '' && `preço para ${brl(Number(preco))}`,
    estoque !== '' && `estoque para ${formatQtd(Number(estoque))}`,
    titulo !== '' && 'título',
    situacao !== '' && `situação para ${STATUS_ROTULO[situacao]}`,
  ].filter(Boolean);

  async function publicar() {
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
      setConfirmando(false);
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
        <p style={{ margin: '4px 0 0', fontSize: 12 }}>
          O que você mudar aqui é enviado para a {PLATAFORMA_LABEL[dado.marketplace] || dado.marketplace} na hora,
          e fica registrado no Histórico com o seu nome. Campo deixado em branco não é enviado.
        </p>
      </div>

      <div className="form-grid">
        <label>
          Preço <span className="page-sub" style={{ fontSize: 11 }}>hoje: {dado.preco != null ? brl(dado.preco) : '—'}</span>
          <input type="number" step="0.01" value={preco} onChange={(e) => setPreco(e.target.value)} placeholder="deixe em branco para não mudar" />
        </label>
        <label>
          Estoque <span className="page-sub" style={{ fontSize: 11 }}>hoje: {dado.estoque != null ? formatQtd(dado.estoque) : '—'}</span>
          <input type="number" step="1" value={estoque} onChange={(e) => setEstoque(e.target.value)} placeholder="deixe em branco para não mudar" />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          Título
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder={dado.titulo || ''} />
        </label>
        <label>
          Situação
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

      {!confirmando ? (
        <button className="btn btn-primary" disabled={mudancas.length === 0} onClick={() => setConfirmando(true)}>
          <Pencil size={14} /> Alterar na plataforma
        </button>
      ) : (
        <div className="card" style={{ margin: 0 }}>
          <p style={{ margin: '0 0 8px', fontSize: 12 }}>
            Confirma alterar {mudancas.join(', ')} no anúncio <strong>{dado.titulo}</strong> da{' '}
            <strong>{nomeDaLoja({ marketplace: dado.marketplace, nome: dado.loja_nome })}</strong>?
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={publicar} disabled={enviando}>
              {enviando ? 'Enviando…' : 'Sim, alterar agora'}
            </button>
            <button className="btn btn-ghost" onClick={() => setConfirmando(false)} disabled={enviando}>Cancelar</button>
          </div>
        </div>
      )}
    </>
  );
}
