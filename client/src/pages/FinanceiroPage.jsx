import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  RefreshCw, History, AlertTriangle, CheckCircle2, Info, Banknote, ArrowDownCircle, Undo2, Receipt, Lock,
  Landmark, Wallet, ArrowLeftRight, Hourglass, Link2, ExternalLink, Download,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
} from 'recharts';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { brl, dataBr, plural } from '../lib/format';
import {
  Select, MultiSelect, ThOrdenavel, Paginacao, BotaoRelatorio, IndicadorDestaque, EstadoVazio,
  CampoBusca, ChipsFiltros,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import DataTable from '../components/DataTable';
import {
  CartaoGrafico, BarraRanking, useRefGrafico, capturarGraficos, moedaCompacta,
} from '../components/graficos';
import { usePaletaGrafico, corPorIndice } from '../lib/coresGrafico';
import { exportarCsv, exportarXlsx } from '../lib/exportar';
import { definicaoMovimentacao, definicaoRepasses, definicaoConferencia } from '../lib/relatorioFinanceiro';
import ErroIntegracao from '../components/ErroIntegracao';
import { TIPOS, TIPO, rotuloTipo, descricaoHumana, idCurto, DESTINO_SAQUE, mesCurto } from '../lib/financeiroRepasses';
import '../styles/financeiro-repasses.css';

// "Repasses de marketplace" — 21/10/2026, segunda versão.
//
// Mesma linguagem das outras telas do Financeiro (Títulos, Resultado):
// título e frase, uma barra de filtros com período e listas, a busca larga
// com "Buscar", fichas "Filtrando por", faixa de indicadores com ícone, nota
// de precisão, cartões com tabela. Nada de componente visual próprio.
//
// O que mudou de conteúdo, e por quê:
//   · BUSCA LIVRE por qualquer coisa — cliente, nº do pedido, repasse,
//     cidade, estado por extenso, referência, valor — e combinada ("maria
//     mato grosso do sul og1620"). Vale para a tela inteira: indicadores,
//     gráficos e lista mostram só o que casa. Ver server/src/lib/financeiroBusca.js;
//   · os indicadores contam a conta (vendas − devoluções − taxas ± retido =
//     liberado) e cada um abre a lista com os lançamentos dele;
//   · clicar num dia do gráfico filtra a lista naquele dia;
//   · a lista é paginada no servidor, sem o corte de 5.000 linhas;
//   · repasse da Shopee aparece, e cada repasse diz para onde foi;
//   · conferência: número em cor neutra, cor só no selo.

const rotuloPlataforma = (m) => PLATAFORMA_LABEL[m] || m;
const rotuloStatus = (s) => (s === 'pendente' ? 'Pendente' : 'Liberado');
const dataIso = (v) => (v ? String(v).slice(0, 10) : '');
const n = (v) => Number(v) || 0;
const TOM_STAMP = { entrada: 'tone-saudavel', saida: 'tone-prejuizo', retido: 'tone-atencao' };

function periodoPadrao() {
  return PRESETS_PERIODO.find((p) => p.chave === 'mesPassado').calcular();
}
function horaBr(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}
function tempoDesde(v) {
  if (!v) return 'nunca';
  const min = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} dia(s)`;
}

function ValorAssinado({ valor, forte }) {
  const v = n(valor);
  const cor = v > 0 ? 'var(--success)' : v < 0 ? 'var(--danger)' : undefined;
  return <span className="mono" style={{ color: cor, fontWeight: forte ? 700 : undefined }}>{v > 0 ? '+' : ''}{brl(v)}</span>;
}

function useDados(rota, params, versao, ativo = true) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  useEffect(() => {
    if (!ativo) return undefined;
    let vivo = true;
    setCarregando(true);
    setErro('');
    api.get(`/financeiro/${rota}?${params}`)
      .then((d) => { if (vivo) setDados(d); })
      .catch((e) => { if (vivo) setErro(e.message); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [rota, params, versao, ativo]);
  return { dados, carregando, erro };
}

// Indicador que abre a lista com os lançamentos dele.
function IndicadorClicavel({ aoClicar, titulo, ...props }) {
  return (
    <div
      className="indicador-clicavel"
      role="button"
      tabIndex={0}
      title={titulo || 'Ver estes lançamentos na lista'}
      onClick={aoClicar}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aoClicar(); } }}
    >
      <IndicadorDestaque {...props} />
    </div>
  );
}

// ===========================================================================
// Página
// ===========================================================================

const SUBTITULO = {
  movimentacao: 'Quanto cada plataforma pagou e descontou, dia a dia, lido do extrato da própria plataforma. Clique num indicador, num dia ou num tipo para ver os lançamentos que formam o número.',
  repasses: 'Cada vez que o dinheiro saiu de uma plataforma, e para onde ele foi — banco, Mercado Pago ou carteira da TikTok.',
  conferencia: 'A prova de que o número está certo: o saldo de cada loja fecha no centavo, mês a mês, e o extrato é comparado com os pedidos.',
};

export default function FinanceiroPage({ aba = 'movimentacao' }) {
  const { user } = useAuth();
  const podeAbrirPedido = user?.role === 'admin'
    || (user?.modulos || []).some((m) => m === 'vendas' || m === 'marketplace');
  const [searchParams] = useSearchParams();

  const [{ inicio, fim }, setPeriodo] = useState(() => {
    const de = searchParams.get('de');
    const ate = searchParams.get('ate');
    return de && ate ? { inicio: de, fim: ate } : periodoPadrao();
  });
  const [plataformas, setPlataformas] = useState([]);
  const [lojaIds, setLojaIds] = useState([]);
  const [termo, setTermo] = useState(searchParams.get('busca') || '');
  const [busca, setBusca] = useState(searchParams.get('busca') || '');
  const [conexoes, setConexoes] = useState([]);
  const [sincronizando, setSincronizando] = useState(false);
  const [aviso, setAviso] = useState('');
  const [erro, setErro] = useState('');
  const [versao, setVersao] = useState(0);
  // A aba monta o relatório; a página só mostra o botão no lugar de sempre.
  const montarRelatorioRef = useRef(null);

  const carregarConexoes = () => api.get('/financeiro/status').then((d) => setConexoes(d.conexoes || [])).catch(() => {});
  useEffect(() => { carregarConexoes(); }, []);

  const lojas = conexoes.filter((c) => c.autorizada && c.ativo);
  const opcoesPlataformas = Object.entries(PLATAFORMA_LABEL).map(([valor, rotulo]) => ({ valor, rotulo }));
  const opcoesLojas = lojas
    .filter((c) => plataformas.length === 0 || plataformas.includes(c.marketplace))
    .map((c) => ({ valor: String(c.id), rotulo: c.nome || rotuloPlataforma(c.marketplace) }));

  function mudarPlataformas(valores) {
    setPlataformas(valores);
    if (valores.length) {
      setLojaIds((ids) => ids.filter((id) => valores.includes(conexoes.find((c) => String(c.id) === String(id))?.marketplace)));
    }
  }

  const base = useMemo(() => {
    const p = new URLSearchParams();
    if (inicio) p.set('data_inicio', inicio);
    if (fim) p.set('data_fim', fim);
    if (plataformas.length) p.set('marketplace', plataformas.join(','));
    if (lojaIds.length) p.set('origem_integracao_id', lojaIds.join(','));
    if (busca) p.set('busca', busca);
    return p.toString();
  }, [inicio, fim, plataformas, lojaIds, busca]);

  async function puxar({ periodo = false } = {}) {
    setSincronizando(true);
    setAviso('');
    setErro('');
    try {
      const r = await api.post('/financeiro/sincronizar', periodo ? { desde: inicio, ate: fim } : {});
      const partes = (r.resultados || []).map((res) => {
        const nome = conexoes.find((x) => x.id === res.integracaoId)?.nome || `Loja ${res.integracaoId}`;
        if (res.erro) return `${nome}: não consegui ler (${res.erro})`;
        if (res.pulado) return `${nome}: lido há pouco`;
        if (res.fase === 'solicitado') return `${nome}: relatório pedido ao Mercado Pago, chega em alguns minutos`;
        if (res.fase === 'aguardando') return `${nome}: esperando o Mercado Pago terminar o relatório`;
        return `${nome}: ${res.gravados || 0} linha(s) lidas`;
      });
      setAviso(partes.join(' · ') || 'Nenhuma loja conectada.');
      await carregarConexoes();
      setVersao((v) => v + 1);
    } catch (e) {
      setErro(e.message);
    } finally {
      setSincronizando(false);
    }
  }

  const lendo = lojas.filter((c) => c.status === 'rodando' || c.relatorio_pendente);
  const maisAntiga = lojas.reduce((m, c) => (c.ultima_sincronizacao && (!m || c.ultima_sincronizacao < m) ? c.ultima_sincronizacao : m), null);

  const chips = [
    plataformas.length && { chave: 'plat', rotulo: 'Plataforma', valor: plataformas.map(rotuloPlataforma).join(', '), onRemover: () => setPlataformas([]) },
    lojaIds.length && { chave: 'loja', rotulo: 'Loja', valor: lojaIds.map((id) => conexoes.find((c) => String(c.id) === String(id))?.nome || id).join(', '), onRemover: () => setLojaIds([]) },
    busca && { chave: 'busca', rotulo: 'Busca', valor: busca, onRemover: () => { setBusca(''); setTermo(''); } },
  ].filter(Boolean);

  const contexto = {
    periodo: { inicio, fim },
    filtros: chips.map((c) => `${c.rotulo}: ${c.valor}`),
  };

  return (
    <div className="page-wide fr-pagina">
      <div className="pagina-topo no-print">
        <div>
          <h2>Repasses de marketplace</h2>
          <p className="page-sub" style={{ maxWidth: '78ch' }}>{SUBTITULO[aba]}</p>
        </div>
        <div className="pagina-topo-acoes">
          <button className="btn btn-ghost" onClick={() => puxar()} disabled={sincronizando} title="Busca agora o que as plataformas liberaram de novo">
            <RefreshCw size={14} className={sincronizando ? 'girando' : ''} /> {sincronizando ? 'Puxando…' : 'Puxar extrato agora'}
          </button>
          <button className="btn btn-ghost" onClick={() => puxar({ periodo: true })} disabled={sincronizando} title="Lê de novo exatamente o período escolhido">
            <History size={14} /> Reler o período
          </button>
        </div>
      </div>

      <div className="filtros-barra no-print">
        <PeriodoFiltro inicio={inicio} fim={fim} onChange={({ inicio: i, fim: f }) => setPeriodo({ inicio: i, fim: f })} />
        <MultiSelect valor={plataformas} onChange={mudarPlataformas} opcoes={opcoesPlataformas} rotuloTudo="Todas as plataformas" rotuloVazio="Todas as plataformas" larguraMinima={180} />
        <MultiSelect valor={lojaIds} onChange={setLojaIds} opcoes={opcoesLojas} rotuloTudo="Todas as lojas" rotuloVazio="Todas as lojas" larguraMinima={170} />
        <div className="filtros-barra-acoes">
          <span className="page-sub" style={{ margin: 0 }} title={lojas.map((c) => `${c.nome}: ${tempoDesde(c.ultima_sincronizacao)}`).join('\n')}>
            {lendo.length ? `Lendo agora: ${lendo.map((c) => c.nome).join(', ')}` : `Extrato atualizado ${tempoDesde(maisAntiga)}`}
          </span>
          <BotaoRelatorio
            montar={(tipo) => montarRelatorioRef.current?.(tipo)}
            rotulo="Relatório"
            descricaoResumo="Os indicadores, os gráficos e os totais do período."
            descricaoCompleto="Tudo do resumo e mais cada linha, uma por uma."
          />
        </div>
      </div>

      <div className="no-print" style={{ marginBottom: 12 }}>
        <CampoBusca
          valor={termo}
          onChange={setTermo}
          onSubmit={(v) => setBusca(String(v === undefined ? termo : v).trim())}
          placeholder="Buscar por qualquer coisa — cliente, nº do pedido, repasse, cidade, estado, referência, valor. Dá para juntar: maria mato grosso do sul og1620"
        />
      </div>

      <ChipsFiltros itens={chips} onLimparTudo={chips.length > 1 ? () => { setPlataformas([]); setLojaIds([]); setBusca(''); setTermo(''); } : undefined} />

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      {aviso && <div className="aviso-compacto tone-saudavel">{aviso}</div>}
      <AvisosDasConexoes conexoes={lojas} />

      {aba === 'movimentacao' && (
        <AbaMovimentacao base={base} versao={versao} podeAbrirPedido={podeAbrirPedido} contexto={contexto} montarRef={montarRelatorioRef} temBusca={!!busca} />
      )}
      {aba === 'repasses' && <AbaRepasses base={base} versao={versao} contexto={contexto} periodo={{ inicio, fim }} montarRef={montarRelatorioRef} />}
      {aba === 'conferencia' && <AbaConferencia base={base} versao={versao} contexto={contexto} montarRef={montarRelatorioRef} />}
    </div>
  );
}

function AvisosDasConexoes({ conexoes }) {
  const com = conexoes.filter((c) => c.ultimo_aviso || c.ultimo_erro);
  if (!com.length) return null;
  return com.map((c) => (
    <div key={c.id} className={'aviso-compacto ' + (c.ultimo_erro ? 'tone-prejuizo' : 'tone-atencao')}>
      <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
      <strong>{c.nome}:</strong>{' '}
      {c.ultimo_erro ? <>a última leitura falhou. <ErroIntegracao erro={c.ultimo_erro} sistema="a plataforma" /></> : c.ultimo_aviso}
    </div>
  ));
}

// ===========================================================================
// Aba Movimentação
// ===========================================================================

const GRUPOS_CONTA = {
  vendas: ['repasse_venda'],
  devolucoes: ['devolucao'],
  custos: ['taxa', 'ads', 'antecipacao', 'ajuste', 'outros'],
  retido: ['reserva'],
};

function AbaMovimentacao({ base, versao, podeAbrirPedido, contexto, montarRef, temBusca }) {
  const { dados, carregando, erro } = useDados('extrato', `${base}&status=liberado`, versao);
  const fech = useDados('fechamento', base.replace(/(^|&)busca=[^&]*/, ''), versao);
  const refDias = useRefGrafico();
  const refTipos = useRefGrafico();
  const refLista = useRef(null);
  const paleta = usePaletaGrafico();
  const [modoGrafico, setModoGrafico] = useState('plataforma');

  const [filtroLista, setFiltroLista] = useState(FILTRO_LISTA_VAZIO);
  function abrirNaLista(parcial) {
    setFiltroLista({ ...FILTRO_LISTA_VAZIO, ...parcial });
    setTimeout(() => refLista.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }

  const porTipo = useMemo(() => {
    const m = {};
    for (const r of dados?.resumoPorTipo || []) {
      if (r.status !== 'liberado') continue;
      if (!m[r.tipo]) m[r.tipo] = { tipo: r.tipo, total: 0, quantidade: 0 };
      m[r.tipo].total += n(r.total);
      m[r.tipo].quantidade += n(r.quantidade);
    }
    return m;
  }, [dados]);
  const soma = (tipos) => tipos.reduce((s, t) => s + (porTipo[t]?.total || 0), 0);
  const qtd = (tipos) => tipos.reduce((s, t) => s + (porTipo[t]?.quantidade || 0), 0);

  const { dias, plataformasNaTela, totalPorPlataforma, porPlataforma } = useMemo(() => {
    const mapa = new Map();
    const plats = new Set();
    const totais = {};
    const quantos = {};
    for (const r of dados?.resumoPorData || []) {
      if (r.status !== 'liberado') continue;
      const grupo = TIPO[r.tipo]?.grupo || 'marketplace';
      const data = dataIso(r.data_liberacao);
      const linha = mapa.get(data) || { data, total: 0, saque: 0, entrou: 0, saiu: 0 };
      if (grupo === 'saque') linha.saque += n(r.total);
      else if (grupo === 'marketplace') {
        plats.add(r.marketplace);
        linha[r.marketplace] = (linha[r.marketplace] || 0) + n(r.total);
        linha.total += n(r.total);
        if (n(r.total) > 0) linha.entrou += n(r.total); else linha.saiu += n(r.total);
        totais[r.marketplace] = (totais[r.marketplace] || 0) + n(r.total);
        quantos[r.marketplace] = (quantos[r.marketplace] || 0) + n(r.quantidade);
      }
      mapa.set(data, linha);
    }
    const lista = Object.keys(PLATAFORMA_LABEL).filter((p) => plats.has(p));
    return {
      dias: [...mapa.values()].sort((a, b) => (a.data < b.data ? 1 : -1)),
      plataformasNaTela: lista,
      totalPorPlataforma: totais,
      porPlataforma: lista.map((m) => ({ marketplace: m, total: totais[m] || 0, quantidade: quantos[m] || 0 })).sort((a, b) => b.total - a.total),
    };
  }, [dados]);

  montarRef.current = async (tipo) => {
    if (!dados) return null;
    const graficos = await capturarGraficos([
      { titulo: 'Liberado dia a dia', ref: refDias },
      { titulo: 'Para onde o dinheiro foi', ref: refTipos },
    ]);
    const lista = Object.values(porTipo).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    let dadosRel = dados;
    if (tipo === 'completo') dadosRel = { ...dados, lancamentos: await buscarTodosLancamentos(`${base}&status=liberado`) };
    return definicaoMovimentacao({
      tipo, dados: dadosRel, dias, plataformasNaTela, totalPorPlataforma, porTipo: lista, porPlataforma,
      rotuloTipo, rotuloPlataforma, rotuloStatus, periodo: contexto.periodo, filtros: contexto.filtros, graficos,
    });
  };

  if (erro) return <div className="aviso-compacto tone-prejuizo">{erro}</div>;
  if (!dados) return <div className="card"><p className="page-sub">{carregando ? 'Carregando…' : ''}</p></div>;

  const t = dados.totais;
  const crescente = [...dias].reverse().map((d) => ({ ...d, rotulo: dataBr(d.data).slice(0, 5) }));
  const series = modoGrafico === 'plataforma'
    ? plataformasNaTela.map((m, i) => ({ chave: m, nome: rotuloPlataforma(m), cor: corPorIndice(paleta, i) }))
    : [{ chave: 'entrou', nome: 'Entrou', cor: paleta.positivo || 'var(--success)' }, { chave: 'saiu', nome: 'Saiu', cor: paleta.negativo || 'var(--danger)' }];
  const tick = { fontSize: 11.5, fill: paleta.rotulo };
  const destino = Object.values(porTipo)
    .filter((x) => TIPO[x.tipo]?.grupo === 'marketplace' && Math.abs(x.total) >= 0.01)
    .sort((a, b) => b.total - a.total);
  const nenhum = dias.length === 0 && !n(t.transferidoBanco) && !n(t.enviadoMercadoPago) && !n(t.outrasEntradas);

  return (
    <>
      {nenhum ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <EstadoVazio
            titulo={temBusca ? 'Nada encontrado com essa busca' : 'Nada liberado neste período'}
            descricao={temBusca
              ? 'Todos os pedaços da busca precisam aparecer no mesmo lançamento (no pedido, no cliente, nos itens ou no envio). Tire uma palavra ou aumente o período.'
              : 'Ou o extrato ainda está sendo lido, ou não houve movimento. Tente outro período ou clique em “Puxar extrato agora”.'}
          />
        </div>
      ) : (
        <>
          <div className="indicadores-faixa">
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ tipos: GRUPOS_CONTA.vendas })}
              Icone={ArrowDownCircle}
              tom="positivo"
              rotulo="Vendas liberadas"
              valor={brl(soma(GRUPOS_CONTA.vendas))}
              explicacao={`O que as vendas renderam já sem a comissão da plataforma. ${plural(qtd(GRUPOS_CONTA.vendas), 'lançamento')}.`}
            />
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ tipos: GRUPOS_CONTA.devolucoes })}
              Icone={Undo2}
              tom={soma(GRUPOS_CONTA.devolucoes) < 0 ? 'negativo' : undefined}
              rotulo="− Devoluções e reclamações"
              valor={brl(Math.abs(soma(GRUPOS_CONTA.devolucoes)))}
              explicacao={`Devolvido ao comprador ou tirado por reclamação. ${plural(qtd(GRUPOS_CONTA.devolucoes), 'lançamento')}.`}
            />
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ tipos: GRUPOS_CONTA.custos })}
              Icone={Receipt}
              tom={soma(GRUPOS_CONTA.custos) < 0 ? 'negativo' : undefined}
              rotulo="− Taxas, Ads e ajustes"
              valor={brl(Math.abs(soma(GRUPOS_CONTA.custos)))}
              explicacao={`Frete, antecipação, publicidade e ajustes cobrados à parte. ${plural(qtd(GRUPOS_CONTA.custos), 'lançamento')}.`}
            />
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ tipos: GRUPOS_CONTA.retido })}
              Icone={Lock}
              tom={soma(GRUPOS_CONTA.retido) ? 'atencao' : undefined}
              rotulo={soma(GRUPOS_CONTA.retido) < 0 ? '− Dinheiro retido' : soma(GRUPOS_CONTA.retido) > 0 ? '+ Retido que voltou' : 'Dinheiro retido'}
              valor={brl(Math.abs(soma(GRUPOS_CONTA.retido)))}
              explicacao="A plataforma segura até resolver uma reclamação ou dívida, e devolve depois."
            />
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ grupo: 'marketplace' })}
              destaque
              Icone={Banknote}
              rotulo="= Liberado pelo marketplace"
              valor={brl(t.liberado)}
              explicacao="Vendas menos devoluções, taxas e o que ficou retido. Não conta saque nem dinheiro que não é da plataforma."
            />
          </div>

          <div className="indicadores-faixa compacta">
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ tipos: ['saque'], plataformas: ['mercado_livre', 'tiktok_shop'] })}
              Icone={Landmark}
              rotulo="Foi para o banco"
              valor={brl(t.transferidoBanco)}
              explicacao={`Saques do Mercado Pago.${n(t.transferenciaEmAndamento) ? ` ${brl(t.transferenciaEmAndamento)} ainda a caminho.` : ''}`}
            />
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ tipos: ['saque'], plataformas: ['shopee'] })}
              Icone={Wallet}
              rotulo="Shopee → Mercado Pago"
              valor={brl(t.enviadoMercadoPago)}
              explicacao="Saques da Shopee: caem no Mercado Pago e saem para o banco junto com o resto."
            />
            <IndicadorClicavel
              aoClicar={() => abrirNaLista({ grupo: 'fora' })}
              Icone={ArrowLeftRight}
              rotulo="Não é do marketplace"
              valor={brl(n(t.outrasEntradas) + n(t.outrasSaidas))}
              explicacao="Pix recebido (o saque da Shopee chegando), maquininha, contas pagas pelo Mercado Pago."
            />
            <IndicadorDestaque
              Icone={Hourglass}
              tom={n(t.pendente) ? 'atencao' : undefined}
              rotulo="Ainda vai liberar"
              valor={brl(t.pendente)}
              explicacao="A plataforma já calculou e ainda não soltou. Nunca somado ao liberado."
            />
          </div>

          <NotaConferencia lojas={fech.dados?.lojas} />

          <CartaoGrafico
            titulo="Liberado dia a dia"
            explicacao="Só o dinheiro do marketplace — sem saque e sem Pix. Clique numa coluna para ver os lançamentos daquele dia."
            refGrafico={refDias}
            altura={280}
            vazio={crescente.length === 0 ? 'Nenhum dia com movimentação no período.' : null}
            acoes={(
              <div className="segmentado segmentado-mini" role="group" aria-label="Como mostrar">
                <button type="button" className={modoGrafico === 'plataforma' ? 'ativo' : undefined} onClick={() => setModoGrafico('plataforma')}>Por plataforma</button>
                <button type="button" className={modoGrafico === 'fluxo' ? 'ativo' : undefined} onClick={() => setModoGrafico('fluxo')}>Entrou × saiu</button>
              </div>
            )}
            legenda={series.map((s) => ({ rotulo: s.nome, cor: s.cor, valor: modoGrafico === 'plataforma' ? brl(totalPorPlataforma[s.chave] || 0) : undefined }))}
            rodape={`${plural(dias.length, 'dia')} com movimento · média de ${brl(dias.length ? n(t.liberado) / dias.length : 0)} por dia`}
          >
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={crescente} margin={{ top: 16, right: 12, left: 0, bottom: 0 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke={paleta.grade} vertical={false} />
                <XAxis dataKey="rotulo" tick={tick} axisLine={{ stroke: paleta.eixo }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
                <YAxis tick={tick} tickFormatter={moedaCompacta} width={76} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: paleta.grade, fillOpacity: 0.45 }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="grafico-tooltip">
                        <div className="grafico-tooltip-titulo">{dataBr(d.data)}</div>
                        {series.map((s) => (
                          <div className="grafico-tooltip-linha" key={s.chave}>
                            <span className="grafico-tooltip-bolinha" style={{ background: s.cor }} />
                            <span className="grafico-tooltip-nome">{s.nome}</span>
                            <span className="mono grafico-tooltip-valor">{brl(d[s.chave] || 0)}</span>
                          </div>
                        ))}
                        <div className="grafico-tooltip-linha"><span className="grafico-tooltip-nome">Liberado no dia</span><span className="mono grafico-tooltip-valor">{brl(d.total)}</span></div>
                        <div className="grafico-tooltip-linha"><span className="grafico-tooltip-nome" style={{ fontStyle: 'italic' }}>Clique para ver os lançamentos</span></div>
                      </div>
                    );
                  }}
                />
                {modoGrafico === 'fluxo' && <ReferenceLine y={0} stroke={paleta.eixo} />}
                {series.map((s) => (
                  <Bar
                    key={s.chave}
                    dataKey={s.chave}
                    name={s.nome}
                    stackId={modoGrafico === 'plataforma' ? 'p' : undefined}
                    fill={s.cor}
                    maxBarSize={40}
                    cursor="pointer"
                    onClick={(d) => { const dia = d?.payload?.data || d?.data; if (dia) abrirNaLista({ dia, grupo: 'marketplace' }); }}
                  >
                    {crescente.map((d) => <Cell key={d.data} fillOpacity={filtroLista.dia && filtroLista.dia !== d.data ? 0.35 : 1} />)}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CartaoGrafico>

          <div className="coluna-larga">
            <div className="card" ref={refTipos}>
              <div className="card-head">Para onde o dinheiro foi</div>
              <p className="grafico-explicacao">O que entrou e o que saiu do dinheiro do marketplace, por tipo. Clique num tipo para ver os lançamentos.</p>
              <BarraRanking
                itens={destino.map((x) => ({
                  rotulo: rotuloTipo(x.tipo),
                  detalhe: plural(x.quantidade, 'lançamento'),
                  valor: x.total,
                  tipo: x.tipo,
                  cor: x.total >= 0 ? (paleta.positivo || 'var(--success)') : (paleta.negativo || 'var(--danger)'),
                }))}
                aoClicar={(item) => abrirNaLista({ tipos: [item.tipo] })}
                vazio="Nada no período."
              />
            </div>
            <div className="card">
              <div className="card-head">Quanto cada plataforma liberou</div>
              <p className="grafico-explicacao">A porcentagem é o peso de cada plataforma no liberado do período.</p>
              <BarraRanking
                itens={porPlataforma.map((p, i) => ({ rotulo: rotuloPlataforma(p.marketplace), detalhe: plural(p.quantidade, 'lançamento'), valor: p.total, marketplace: p.marketplace, cor: corPorIndice(paleta, i) }))}
                aoClicar={(item) => abrirNaLista({ grupo: 'marketplace', plataformas: [item.marketplace] })}
                vazio="Nenhuma plataforma com movimento."
              />
            </div>
          </div>
        </>
      )}

      <div ref={refLista} className="fr-ancora">
        <ListaLancamentos base={base} versao={versao} filtro={filtroLista} setFiltro={setFiltroLista} podeAbrirPedido={podeAbrirPedido} />
      </div>
    </>
  );
}

function NotaConferencia({ lojas }) {
  if (!lojas) return null;
  const itens = lojas.flatMap((l) => l.meses.filter((m) => m.linhas > 0).map((m) => ({ ...m, loja: l.loja })));
  if (!itens.length) return null;
  const ruins = itens.filter((i) => i.fechado === false);
  return (
    <div className={'nota-precisao' + (ruins.length ? ' fr-nota-ruim' : '')}>
      {ruins.length ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
      <span>
        {ruins.length ? (
          <>
            <strong>Atenção:</strong> {ruins.map((r) => `${r.loja} (${mesCurto(r.mes)}, diferença de ${brl(r.diferenca)})`).join(', ')}{' '}
            não fecha{ruins.length > 1 ? 'm' : ''} com o saldo da plataforma — veja a aba <Link to="/financeiro/conferencia">Conferência</Link>.
          </>
        ) : (
          <>
            <strong>Número conferido.</strong> O saldo de cada loja fecha no centavo neste período:{' '}
            {itens.map((i) => `${i.loja} ${mesCurto(i.mes)}`).join(' · ')}. Nada contado duas vezes, nada faltando.
          </>
        )}
      </span>
    </div>
  );
}

async function buscarTodosLancamentos(params) {
  const todos = [];
  for (let pagina = 1; pagina <= 40; pagina += 1) {
    const r = await api.get(`/financeiro/lancamentos?${params}&por_pagina=500&pagina=${pagina}&ordem=data&direcao=asc`);
    todos.push(...(r.lancamentos || []));
    if (pagina >= r.paginas) break;
  }
  return todos;
}

// ---------------------------------------------------------------------------
// Lista de lançamentos
// ---------------------------------------------------------------------------
const FILTRO_LISTA_VAZIO = { tipos: [], grupo: '', plataformas: [], sentido: '', status: 'liberado', comPedido: '', valorMin: '', valorMax: '', dia: '' };
const GRUPO_ROTULO = { marketplace: 'Dinheiro do marketplace', fora: 'Não é do marketplace', saque: 'Saque' };
const COLUNAS_EXPORTACAO = [
  { rotulo: 'Data', valor: (l) => dataBr(dataIso(l.data_liberacao)) },
  { rotulo: 'Hora', valor: (l) => horaBr(l.data_evento) },
  { rotulo: 'Plataforma', valor: (l) => rotuloPlataforma(l.marketplace) },
  { rotulo: 'Loja', valor: (l) => l.loja_nome || '' },
  { rotulo: 'Tipo', valor: (l) => rotuloTipo(l.tipo) },
  { rotulo: 'O que foi', valor: (l) => descricaoHumana(l) },
  { rotulo: 'Pedido', valor: (l) => (l.pedido_numero ? `#${l.pedido_numero}` : l.pedido_id_externo || '') },
  { rotulo: 'Cliente', valor: (l) => l.cliente_nome || '' },
  { rotulo: 'Cidade', valor: (l) => [l.cliente_cidade, l.cliente_uf].filter(Boolean).join('/') },
  { rotulo: 'Id na plataforma', valor: (l) => idCurto(l) },
  { rotulo: 'Repasse', valor: (l) => l.repasse_id_externo || '' },
  { rotulo: 'Valor', valor: (l) => n(l.valor) },
  { rotulo: 'Situação', valor: (l) => rotuloStatus(l.status) },
];

function ListaLancamentos({ base, versao, filtro, setFiltro, podeAbrirPedido }) {
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(50);
  const [ordem, setOrdem] = useState({ coluna: 'data', direcao: 'desc' });
  const [exportando, setExportando] = useState(false);
  useEffect(() => { setPagina(1); }, [filtro, base, porPagina]);

  const params = useMemo(() => {
    const p = new URLSearchParams(base);
    if (filtro.dia) { p.set('data_inicio', filtro.dia); p.set('data_fim', filtro.dia); }
    if (filtro.plataformas.length) p.set('marketplace', filtro.plataformas.join(','));
    if (filtro.tipos.length) p.set('tipo', filtro.tipos.join(','));
    if (filtro.grupo) p.set('grupo', filtro.grupo === 'fora' ? 'foraMarketplace' : filtro.grupo);
    if (filtro.sentido) p.set('sentido', filtro.sentido);
    if (filtro.status) p.set('status', filtro.status);
    if (filtro.comPedido) p.set('com_pedido', filtro.comPedido);
    if (filtro.valorMin !== '') p.set('valor_min', filtro.valorMin);
    if (filtro.valorMax !== '') p.set('valor_max', filtro.valorMax);
    return p.toString();
  }, [base, filtro]);
  const { dados, carregando, erro } = useDados('lancamentos', `${params}&pagina=${pagina}&por_pagina=${porPagina}&ordem=${ordem.coluna}&direcao=${ordem.direcao}`, versao);

  const muda = (parcial) => setFiltro((f) => ({ ...f, ...parcial }));
  const ordenarPor = (coluna) => setOrdem((o) => ({ coluna, direcao: o.coluna === coluna && o.direcao === 'desc' ? 'asc' : 'desc' }));

  const chips = [
    filtro.dia && { chave: 'dia', rotulo: 'Dia', valor: dataBr(filtro.dia), onRemover: () => muda({ dia: '' }) },
    filtro.plataformas.length > 0 && { chave: 'plat', rotulo: 'Plataforma', valor: filtro.plataformas.map(rotuloPlataforma).join(', '), onRemover: () => muda({ plataformas: [] }) },
    filtro.grupo && { chave: 'grupo', rotulo: 'Grupo', valor: GRUPO_ROTULO[filtro.grupo], onRemover: () => muda({ grupo: '' }) },
    filtro.tipos.length > 0 && { chave: 'tipo', rotulo: 'Tipo', valor: filtro.tipos.map(rotuloTipo).join(', '), onRemover: () => muda({ tipos: [] }) },
    filtro.sentido && { chave: 'sentido', rotulo: 'Mostrando', valor: filtro.sentido === 'entrada' ? 'só o que entrou' : 'só o que saiu', onRemover: () => muda({ sentido: '' }) },
    filtro.status !== 'liberado' && { chave: 'status', rotulo: 'Situação', valor: filtro.status === 'pendente' ? 'só pendente' : 'liberado e pendente', onRemover: () => muda({ status: 'liberado' }) },
    filtro.comPedido && { chave: 'ped', rotulo: 'Pedido', valor: filtro.comPedido === 'sim' ? 'com pedido' : 'sem pedido', onRemover: () => muda({ comPedido: '' }) },
    (filtro.valorMin !== '' || filtro.valorMax !== '') && { chave: 'valor', rotulo: 'Valor', valor: [filtro.valorMin !== '' && `de ${brl(filtro.valorMin)}`, filtro.valorMax !== '' && `até ${brl(filtro.valorMax)}`].filter(Boolean).join(' '), onRemover: () => muda({ valorMin: '', valorMax: '' }) },
  ].filter(Boolean);

  async function exportar(formato) {
    setExportando(true);
    try {
      const todos = await buscarTodosLancamentos(params);
      (formato === 'csv' ? exportarCsv : exportarXlsx)('lancamentos-marketplace', COLUNAS_EXPORTACAO, todos);
    } finally {
      setExportando(false);
    }
  }

  const lista = dados?.lancamentos || [];
  const total = dados?.total || 0;
  const opcoesTipo = TIPOS.map((t) => ({ valor: t.chave, rotulo: `${t.rotulo}${t.grupo === 'fora' ? ' (não é marketplace)' : ''}` }));

  return (
    <div className="card">
      <div className="card-head-linha">
        <div className="card-head">Lançamentos</div>
        <div className="filtros-barra-acoes">
          <span className="page-sub" style={{ margin: 0 }}>{carregando ? 'Atualizando…' : `${total.toLocaleString('pt-BR')} resultado(s)`}</span>
          <button type="button" className="btn btn-ghost" disabled={exportando || !total} onClick={() => exportar('xlsx')}><Download size={14} /> {exportando ? 'Exportando…' : 'Excel'}</button>
          <button type="button" className="btn btn-ghost" disabled={exportando || !total} onClick={() => exportar('csv')}>CSV</button>
        </div>
      </div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Uma linha por movimento do extrato. A busca lá em cima também vale aqui — e dá para afinar com os filtros abaixo.
      </p>

      <div className="filtros-barra">
        <MultiSelect valor={filtro.tipos} onChange={(v) => muda({ tipos: v, grupo: '' })} opcoes={opcoesTipo} rotuloTudo="Todos os tipos" rotuloVazio="Todos os tipos" larguraMinima={200} />
        <Select value={filtro.sentido} onChange={(e) => muda({ sentido: e.target.value })} aria-label="Entrou ou saiu">
          <option value="">Entrou e saiu</option>
          <option value="entrada">Só o que entrou</option>
          <option value="saida">Só o que saiu</option>
        </Select>
        <Select value={filtro.status} onChange={(e) => muda({ status: e.target.value })} aria-label="Situação">
          <option value="liberado">Só liberado</option>
          <option value="pendente">Só pendente</option>
          <option value="">Liberado e pendente</option>
        </Select>
        <Select value={filtro.comPedido} onChange={(e) => muda({ comPedido: e.target.value })} aria-label="Vínculo com pedido">
          <option value="">Com e sem pedido</option>
          <option value="sim">Só com pedido</option>
          <option value="nao">Só sem pedido</option>
        </Select>
        <input className="input fr-input-valor" inputMode="decimal" placeholder="Valor de R$" value={filtro.valorMin} onChange={(e) => muda({ valorMin: e.target.value.replace(',', '.') })} aria-label="Valor mínimo" />
        <input className="input fr-input-valor" inputMode="decimal" placeholder="até R$" value={filtro.valorMax} onChange={(e) => muda({ valorMax: e.target.value.replace(',', '.') })} aria-label="Valor máximo" />
      </div>

      <ChipsFiltros itens={chips} onLimparTudo={chips.length > 1 ? () => setFiltro({ ...FILTRO_LISTA_VAZIO }) : undefined} />

      {dados && total > 0 && (
        <div className="nota-precisao" style={{ marginTop: 8 }}>
          <Info size={14} />
          <span>
            Nesta lista: entrou <ValorAssinado valor={dados.soma.entradas} />, saiu <ValorAssinado valor={dados.soma.saidas} /> —
            soma de <ValorAssinado valor={dados.soma.total} forte />.
          </span>
        </div>
      )}
      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <Paginacao
        pagina={pagina} totalPaginas={dados?.paginas || 1} tamanho={porPagina} tamanhos={[25, 50, 100, 250]}
        totalItens={total} inicio={(pagina - 1) * porPagina} fim={Math.min(pagina * porPagina, total)}
        setPagina={setPagina} setTamanho={setPorPagina} posicao="topo"
      />
      <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <ThOrdenavel coluna="data" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor} style={{ width: 110 }}>Data</ThOrdenavel>
              <ThOrdenavel coluna="loja" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor}>Loja</ThOrdenavel>
              <ThOrdenavel coluna="tipo" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor}>Tipo</ThOrdenavel>
              <th>O que foi</th>
              <th>Pedido e cliente</th>
              <th>Repasse</th>
              <ThOrdenavel coluna="valor" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor} className="num">Valor</ThOrdenavel>
            </tr>
          </thead>
          <tbody>
            {lista.map((l) => (
              <tr key={l.id}>
                <td className="mono">{dataBr(dataIso(l.data_liberacao))}<div className="fr-sub">{horaBr(l.data_evento)}</div></td>
                <td>{l.loja_nome || rotuloPlataforma(l.marketplace)}<div className="fr-sub">{rotuloPlataforma(l.marketplace)}</div></td>
                <td>
                  <span className={'stamp sm ' + (TOM_STAMP[TIPO[l.tipo]?.tom] || 'tone-neutro')}>{TIPO[l.tipo]?.curto || l.tipo}</span>
                  {l.status === 'pendente' && <span className="stamp sm tone-atencao" style={{ marginLeft: 4 }}>Pendente</span>}
                </td>
                <td>{descricaoHumana(l)}<div className="fr-sub mono" title="Identificador na plataforma — dá para buscar por ele">{idCurto(l)}</div></td>
                <td>
                  {l.pedido_numero ? (
                    <>
                      <span className="mono">{podeAbrirPedido ? <Link to={`/pedidos/${l.pedido_id}`}>#{l.pedido_numero}</Link> : `#${l.pedido_numero}`}</span>
                      {l.cliente_nome && <div className="fr-sub">{l.cliente_nome}{l.cliente_cidade ? ` · ${l.cliente_cidade}${l.cliente_uf ? `/${l.cliente_uf}` : ''}` : ''}</div>}
                    </>
                  ) : l.pedido_id_externo ? (
                    <span className="stamp sm tone-neutro" title={`Pedido ${l.pedido_id_externo} ainda não importado no Hub`}><Link2 size={11} /> externo</span>
                  ) : '—'}
                </td>
                <td className="mono fr-sub-ink">{l.repasse_id_externo ? String(l.repasse_id_externo).slice(-10) : '—'}</td>
                <td className="mono num"><ValorAssinado valor={l.valor} /></td>
              </tr>
            ))}
            {dados && lista.length === 0 && (
              <tr><td colSpan="7">Nenhum lançamento com esses filtros{chips.length ? ' — tire um dos filtros acima.' : '.'}</td></tr>
            )}
          </tbody>
        </table>
      </DataTable>
      <Paginacao
        pagina={pagina} totalPaginas={dados?.paginas || 1} tamanho={porPagina} tamanhos={[25, 50, 100, 250]}
        totalItens={total} inicio={(pagina - 1) * porPagina} fim={Math.min(pagina * porPagina, total)}
        setPagina={setPagina} setTamanho={setPorPagina}
      />
    </div>
  );
}

// ===========================================================================
// Aba Repasses
// ===========================================================================

const COLUNAS_REPASSE = [
  { rotulo: 'Data', valor: (r) => dataBr(dataIso(r.data_liberacao)) },
  { rotulo: 'Plataforma', valor: (r) => rotuloPlataforma(r.marketplace) },
  { rotulo: 'Loja', valor: (r) => r.loja_nome || '' },
  { rotulo: 'Para', valor: (r) => DESTINO_SAQUE[r.marketplace] },
  { rotulo: 'Identificador', valor: (r) => r.repasse_id_externo },
  { rotulo: 'Valor', valor: (r) => n(r.valor_liquido) },
  { rotulo: 'Situação', valor: (r) => (r.status === 'pago' ? 'Concluído' : 'A caminho') },
];
const ORDEM_REPASSE = {
  data: (r) => dataIso(r.data_liberacao),
  loja: (r) => r.loja_nome || '',
  valor: (r) => n(r.valor_liquido),
  status: (r) => r.status,
};

function AbaRepasses({ base, versao, contexto, periodo, montarRef }) {
  const navigate = useNavigate();
  const paleta = usePaletaGrafico();
  const refDias = useRefGrafico();
  const [status, setStatus] = useState('');
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(50);
  const [ordem, setOrdem] = useState({ coluna: 'data', direcao: 'desc' });

  const params = status ? `${base}&status=${status}` : base;
  useEffect(() => { setPagina(1); }, [params, porPagina]);
  const { dados, carregando, erro } = useDados('repasses', params, versao);
  const repasses = useMemo(() => {
    const lista = [...(dados?.repasses || [])];
    const f = ORDEM_REPASSE[ordem.coluna];
    lista.sort((a, b) => { const x = f(a); const y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * (ordem.direcao === 'asc' ? 1 : -1); });
    return lista;
  }, [dados, ordem]);

  const destinos = useMemo(() => {
    const m = {};
    for (const r of repasses) {
      if (!m[r.marketplace]) m[r.marketplace] = { marketplace: r.marketplace, pago: 0, andamento: 0, quantidade: 0 };
      if (r.status === 'pago') m[r.marketplace].pago += n(r.valor_liquido); else m[r.marketplace].andamento += n(r.valor_liquido);
      m[r.marketplace].quantidade += 1;
    }
    return Object.keys(PLATAFORMA_LABEL).filter((p) => m[p]).map((p) => m[p]);
  }, [repasses]);
  const plats = destinos.map((d) => d.marketplace);
  const porDia = useMemo(() => {
    const m = new Map();
    for (const r of repasses) {
      const d = dataIso(r.data_liberacao);
      if (!d) continue;
      const linha = m.get(d) || { data: d, rotulo: dataBr(d).slice(0, 5) };
      linha[r.marketplace] = (linha[r.marketplace] || 0) + n(r.valor_liquido);
      m.set(d, linha);
    }
    return [...m.values()].sort((a, b) => (a.data < b.data ? -1 : 1));
  }, [repasses]);

  const totalPago = destinos.reduce((s, d) => s + d.pago, 0);
  const totalAndamento = destinos.reduce((s, d) => s + d.andamento, 0);
  montarRef.current = async (tipo) => {
    const graficos = await capturarGraficos([{ titulo: 'Repasses por dia', ref: refDias }]);
    return definicaoRepasses({
      tipo, repasses, totalPago, totalAndamento, porPlataforma: destinos, rotuloPlataforma,
      periodo: contexto.periodo, filtros: contexto.filtros, graficos,
    });
  };

  function verLancamentos(r) {
    navigate(`/financeiro/movimentacao?${new URLSearchParams({ busca: r.repasse_id_externo, de: periodo.inicio, ate: periodo.fim })}`);
  }

  const ICONE = { mercado_livre: Landmark, shopee: Wallet, tiktok_shop: Banknote };
  const FRASE = {
    mercado_livre: 'Saques do Mercado Pago para a conta da empresa — o que aparece no extrato do banco.',
    shopee: 'Saques da Shopee. Caem no Mercado Pago da mesma empresa, não direto no banco.',
    tiktok_shop: 'Repasses da TikTok para a carteira da loja na própria TikTok.',
  };
  const inicioPag = (pagina - 1) * porPagina;
  const ordenarPor = (coluna) => setOrdem((o) => ({ coluna, direcao: o.coluna === coluna && o.direcao === 'desc' ? 'asc' : 'desc' }));

  if (erro) return <div className="aviso-compacto tone-prejuizo">{erro}</div>;

  return (
    <>
      <div className="indicadores-faixa">
        {destinos.map((d, i) => (
          <IndicadorDestaque
            key={d.marketplace}
            destaque={i === 0}
            Icone={ICONE[d.marketplace]}
            rotulo={`${rotuloPlataforma(d.marketplace)} → ${DESTINO_SAQUE[d.marketplace]}`}
            valor={brl(d.pago)}
            explicacao={`${FRASE[d.marketplace]} ${plural(d.quantidade, 'repasse')}${d.andamento ? `, ${brl(d.andamento)} ainda a caminho` : ''}.`}
          />
        ))}
        {destinos.length === 0 && (
          <IndicadorDestaque Icone={Landmark} rotulo="Repasses no período" valor="—" explicacao={carregando ? 'Carregando…' : 'Nenhum repasse com esses filtros.'} />
        )}
      </div>

      <CartaoGrafico
        titulo="Repasses por dia"
        explicacao="Cada coluna é um dia em que o dinheiro saiu de uma plataforma."
        refGrafico={refDias}
        altura={240}
        vazio={porDia.length === 0 ? 'Nenhum repasse no período.' : null}
        legenda={plats.map((p, i) => ({ rotulo: `${rotuloPlataforma(p)} → ${DESTINO_SAQUE[p]}`, cor: corPorIndice(paleta, i) }))}
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={porDia} margin={{ top: 16, right: 12, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke={paleta.grade} vertical={false} />
            <XAxis dataKey="rotulo" tick={{ fontSize: 11.5, fill: paleta.rotulo }} axisLine={{ stroke: paleta.eixo }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tick={{ fontSize: 11.5, fill: paleta.rotulo }} tickFormatter={moedaCompacta} width={76} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v, nome) => [brl(v), nome]} labelFormatter={(_, p) => (p?.[0]?.payload?.data ? dataBr(p[0].payload.data) : '')} />
            {plats.map((p, i) => <Bar key={p} dataKey={p} name={rotuloPlataforma(p)} stackId="r" fill={corPorIndice(paleta, i)} maxBarSize={40} />)}
          </BarChart>
        </ResponsiveContainer>
      </CartaoGrafico>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Repasses</div>
          <div className="filtros-barra-acoes">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
              <option value="">Todas as situações</option>
              <option value="pago">Só concluídos</option>
              <option value="processando">Só a caminho</option>
            </Select>
            <button type="button" className="btn btn-ghost" disabled={!repasses.length} onClick={() => exportarXlsx('repasses-marketplace', COLUNAS_REPASSE, repasses)}><Download size={14} /> Excel</button>
          </div>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Cada linha é uma vez em que o dinheiro saiu da plataforma. A busca lá em cima acha o repasse pelo número ou por
          qualquer pedido pago nele (cliente, cidade, referência…). “Ver lançamentos” abre o que compôs o repasse.
        </p>
        <Paginacao
          pagina={pagina} totalPaginas={Math.max(1, Math.ceil(repasses.length / porPagina))} tamanho={porPagina} tamanhos={[25, 50, 100, 250]}
          totalItens={repasses.length} inicio={inicioPag} fim={Math.min(inicioPag + porPagina, repasses.length)}
          setPagina={setPagina} setTamanho={setPorPagina} posicao="topo"
        />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="data" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor} style={{ width: 110 }}>Data</ThOrdenavel>
                <ThOrdenavel coluna="loja" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor}>De</ThOrdenavel>
                <th>Para</th>
                <th>Identificador</th>
                <ThOrdenavel coluna="valor" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor} className="num">Valor</ThOrdenavel>
                <ThOrdenavel coluna="status" atual={ordem.coluna} direcao={ordem.direcao} onClick={ordenarPor}>Situação</ThOrdenavel>
                <th />
              </tr>
            </thead>
            <tbody>
              {repasses.slice(inicioPag, inicioPag + porPagina).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.data_liberacao ? dataBr(dataIso(r.data_liberacao)) : '—'}</td>
                  <td>{r.loja_nome || rotuloPlataforma(r.marketplace)}<div className="fr-sub">{rotuloPlataforma(r.marketplace)}</div></td>
                  <td>{DESTINO_SAQUE[r.marketplace]}</td>
                  <td className="mono fr-sub-ink">{r.repasse_id_externo}</td>
                  <td className="mono num">{brl(r.valor_liquido)}</td>
                  <td><span className={'stamp sm ' + (r.status === 'pago' ? 'tone-saudavel' : 'tone-atencao')}>{r.status === 'pago' ? 'Concluído' : r.status === 'processando' ? 'A caminho' : 'Previsto'}</span></td>
                  <td><button type="button" className="botao-link" onClick={() => verLancamentos(r)}>Ver lançamentos <ExternalLink size={11} /></button></td>
                </tr>
              ))}
              {repasses.length === 0 && <tr><td colSpan="7">{carregando ? 'Carregando…' : 'Nenhum repasse com esses filtros.'}</td></tr>}
            </tbody>
          </table>
        </DataTable>
      </div>
    </>
  );
}

// ===========================================================================
// Aba Conferência
// ===========================================================================

function AbaConferencia({ base, versao, contexto, montarRef }) {
  const semBusca = base.replace(/(^|&)busca=[^&]*/, '');
  const fech = useDados('fechamento', semBusca, versao);
  const conc = useDados('conciliacao', semBusca, versao);
  const [soDivergentes, setSoDivergentes] = useState('sim');

  const meses = (fech.dados?.lojas || []).flatMap((l) => l.meses
    .filter((m) => m.linhas > 0 || m.quantidadeRepasses)
    .map((m) => ({ ...m, loja: l.loja, plataforma: l.marketplace, id: `${l.integracaoId}-${m.mes}` })));
  const ruins = meses.filter((m) => m.fechado === false);
  const linhas = conc.dados?.linhas || [];
  const visiveis = soDivergentes === 'sim' ? linhas.filter((l) => l.confere === false) : linhas;
  const bate = linhas.filter((l) => l.confere === true).length;

  montarRef.current = async (tipo) => (conc.dados
    ? definicaoConferencia({ tipo, dados: conc.dados, linhas, rotuloPlataforma, periodo: contexto.periodo, filtros: contexto.filtros, graficos: [] })
    : null);

  return (
    <>
      <div className="indicadores-faixa">
        <IndicadorDestaque
          destaque
          Icone={ruins.length ? AlertTriangle : CheckCircle2}
          tom={ruins.length ? 'negativo' : meses.length ? 'positivo' : undefined}
          rotulo="Lojas e meses que fecham"
          valor={meses.length ? `${meses.length - ruins.length} de ${meses.length}` : '—'}
          explicacao={ruins.length
            ? 'Algum mês não fecha com o saldo da plataforma: falta ou sobra linha. Veja a diferença na tabela.'
            : 'Saldo no começo + tudo que entrou − tudo que saiu = saldo no fim, no centavo.'}
        />
        <IndicadorDestaque
          Icone={CheckCircle2}
          rotulo="Dias em que extrato e pedidos batem"
          valor={conc.dados ? String(bate) : '—'}
          explicacao="A venda liberada no extrato é igual à soma do valor recebido dos pedidos do dia."
        />
        <IndicadorDestaque
          Icone={AlertTriangle}
          tom={conc.dados?.diasDivergentes ? 'negativo' : undefined}
          rotulo="Dias com diferença"
          valor={conc.dados ? String(conc.dados.diasDivergentes) : '—'}
          explicacao="Sobrou diferença mesmo depois de tirar taxas, Ads e devoluções. São os que merecem olhar."
        />
        <IndicadorDestaque
          Icone={Info}
          rotulo="Dias com um lado só"
          valor={conc.dados ? String(conc.dados.diasSemExtrato + conc.dados.diasSemPedidos) : '—'}
          explicacao="O extrato daquele dia não foi lido, ou não houve pedido liberado. Não é diferença."
        />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">O saldo de cada loja fecha?</div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Para cada loja e mês: <strong>saldo no começo + tudo que entrou − tudo que saiu = saldo no fim</strong>. Se faltar
          ou sobrar uma única linha do extrato, o mês aparece como “não fecha”, com a diferença em reais. Na TikTok, que não
          informa saldo, a conferência é contra o valor de cada repasse.
        </p>
        {fech.erro && <div className="aviso-compacto tone-prejuizo">{fech.erro}</div>}
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Loja</th><th>Mês</th>
                <th className="num">Saldo no começo</th>
                <th className="num">Liberado (marketplace)</th>
                <th className="num">Não é do marketplace</th>
                <th className="num">Saques</th>
                <th className="num">Saldo no fim / repasses</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {meses.map((m) => (
                <tr key={m.id}>
                  <td>{m.loja}<div className="fr-sub">{rotuloPlataforma(m.plataforma)}</div></td>
                  <td>{mesCurto(m.mes)}</td>
                  <td className="mono num">{m.saldoInicial === null ? '—' : brl(m.saldoInicial)}</td>
                  <td className="mono num">{brl(m.marketplace.total)}</td>
                  <td className="mono num">{brl(m.foraMarketplace.total)}</td>
                  <td className="mono num">{brl(m.saque.total)}</td>
                  <td className="mono num">{m.conferencia === 'repasses' ? brl(m.somaRepasses) : m.saldoFinal === null ? '—' : brl(m.saldoFinal)}</td>
                  <td>
                    <span className={'stamp sm ' + (m.fechado === true ? 'tone-saudavel' : m.fechado === false ? 'tone-prejuizo' : 'tone-neutro')}>
                      {m.fechado === true ? 'Fecha no centavo' : m.fechado === false ? `Diferença ${brl(m.diferenca)}` : 'Sem dado'}
                    </span>
                  </td>
                </tr>
              ))}
              {meses.length === 0 && <tr><td colSpan="8">{fech.carregando ? 'Conferindo…' : 'Nenhuma loja com extrato no período.'}</td></tr>}
            </tbody>
          </table>
        </DataTable>
        {ruins.length > 0 && (
          <div className="aviso-compacto tone-atencao" style={{ marginTop: 10 }}>
            Mês que não fecha quase sempre é leitura pela metade: escolha o mês no período e clique em <strong>Reler o
            período</strong>. Se continuar, busque na Movimentação por um lançamento do valor da diferença.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">O extrato bate com os pedidos?</div>
          <div className="filtros-barra-acoes">
            <Select value={soDivergentes} onChange={(e) => setSoDivergentes(e.target.value)} aria-label="Quais dias mostrar">
              <option value="sim">Só os dias com diferença</option>
              <option value="nao">Todos os dias</option>
            </Select>
          </div>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          A venda liberada no extrato comparada com a soma do valor recebido dos pedidos liberados no mesmo dia. Os números
          ficam em cor neutra; a cor só aparece no resultado.
        </p>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Data</th><th>Plataforma</th>
                <th className="num">Venda no extrato</th>
                <th className="num">Pedidos (valor recebido)</th>
                <th className="num">Taxas, Ads e devoluções</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={`${l.data}-${l.marketplace}`}>
                  <td className="mono">{dataBr(l.data)}</td>
                  <td>{rotuloPlataforma(l.marketplace)}</td>
                  <td className="mono num">{l.extratoRepasseVenda === null ? '—' : brl(l.extratoRepasseVenda)}</td>
                  <td className="mono num">{l.pedidosTotal === null ? '—' : brl(l.pedidosTotal)}</td>
                  <td className="mono num">{l.extratoOutros === null ? '—' : brl(l.extratoOutros)}</td>
                  <td>
                    {l.diferencaNaoExplicada === null
                      ? <span className="stamp sm tone-neutro">{l.extratoTotal === null ? 'Extrato não lido' : 'Sem pedido no dia'}</span>
                      : l.confere
                        ? <span className="stamp sm tone-saudavel">Bate</span>
                        : <span className="stamp sm tone-prejuizo">Sobra {brl(l.diferencaNaoExplicada)}</span>}
                  </td>
                </tr>
              ))}
              {visiveis.length === 0 && (
                <tr><td colSpan="6">{conc.carregando ? 'Carregando…' : soDivergentes === 'sim' ? 'Nenhum dia com diferença no período.' : 'Nada para comparar no período.'}</td></tr>
              )}
            </tbody>
          </table>
        </DataTable>
      </div>
    </>
  );
}

