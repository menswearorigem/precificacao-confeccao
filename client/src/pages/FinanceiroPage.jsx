import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  RefreshCw, Printer, History, AlertTriangle, CheckCircle2, XCircle, CircleDashed, Search, X,
  ArrowRight, Landmark, Wallet, Hourglass, ChevronDown, ChevronUp, Link2, ArrowDownLeft, ArrowUpRight,
  Equal, Minus, Plus, ExternalLink, HelpCircle,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
} from 'recharts';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { brl, dataBr, plural } from '../lib/format';
import { Paginacao, BotaoRelatorio, EstadoVazio, ChipsFiltros } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import DataTable from '../components/DataTable';
import { useRefGrafico, capturarGraficos, moedaCompacta } from '../components/graficos';
import { usePaletaGrafico } from '../lib/coresGrafico';
import { exportarCsv, exportarXlsx } from '../lib/exportar';
import { definicaoMovimentacao, definicaoRepasses, definicaoConferencia } from '../lib/relatorioFinanceiro';
import ErroIntegracao from '../components/ErroIntegracao';
import {
  PLATAFORMAS, TIPOS, TIPO, GRUPOS, rotuloTipo, descricaoHumana, idCurto, DESTINO_SAQUE, mesCurto,
} from '../lib/financeiroRepasses';
import '../styles/financeiro-repasses.css';

// "Repasses de marketplace" — refeita em 21/10/2026.
//
// O que o dono pediu, e onde cada pedido foi parar:
//   · "quem não é do financeiro tem que entender de cara" → todo número tem
//     nome de gente e a conta aparece montada (vendas − devoluções − taxas =
//     liberado), em vez de cinco cartões soltos;
//   · "tem que bater certo" → selo de conferência por loja e mês (saldo inicial
//     + movimento = saldo final, ver server/src/lib/financeiroFechamento.js);
//   · "difícil de ver dia a dia" → gráfico de colunas por plataforma em que
//     CLICAR NUM DIA filtra a lista lá embaixo;
//   · "não tem como filtrar os lançamentos" → busca por pedido / id / repasse,
//     tipo, entrou ou saiu, situação, vínculo com pedido, faixa de valor, dia
//     — tudo no servidor, paginado, com a soma do que foi filtrado;
//   · "repasse da Shopee não entra" → entra (correção do back-end), e cada
//     repasse diz PARA ONDE o dinheiro foi;
//   · "a conferência confunde nas cores" → número em cor neutra; cor só no
//     selo de situação (bate / não bate / falta um lado).
//
// A tela só lê o que a API devolve — nenhum cálculo de preço, margem ou
// imposto aqui (REGRA 1).

const rotuloPlataforma = (m) => PLATAFORMA_LABEL[m] || m;
const rotuloStatus = (s) => (s === 'pendente' ? 'Pendente' : 'Liberado');

function periodoPadrao() {
  return PRESETS_PERIODO.find((p) => p.chave === 'mesPassado').calcular();
}
const dataIso = (v) => (v ? String(v).slice(0, 10) : '');
const n = (v) => Number(v) || 0;

function horaBr(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}

function tempoDesde(v) {
  if (!v) return 'nunca';
  const min = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dia(s)`;
}

// Valor com sinal. A cor só aparece quando `colorir` — na conferência os
// números ficam neutros (era o que confundia).
function Valor({ valor, forte, colorir = true, semSinal }) {
  const v = n(valor);
  const classe = 'mono fr-valor' + (colorir ? (v > 0 ? ' fr-pos' : v < 0 ? ' fr-neg' : '') : '') + (forte ? ' fr-forte' : '');
  return <span className={classe}>{!semSinal && v > 0 ? '+' : ''}{brl(v)}</span>;
}

function ChipPlataforma({ marketplace, children }) {
  return <span className={`fr-chip-plat fr-plat-${marketplace}`}>{children || rotuloPlataforma(marketplace)}</span>;
}

function SeloTipo({ tipo }) {
  const t = TIPO[tipo];
  return <span className={`fr-selo-tipo fr-tom-${t?.tom || 'neutro'}`}>{t?.curto || tipo}</span>;
}

// Explicação longa fica atrás de um "como funciona" — a dobra é do número.
function ComoFunciona({ titulo = 'Como este número é calculado', children }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="fr-como">
      <button type="button" className="fr-como-botao" onClick={() => setAberto((v) => !v)} aria-expanded={aberto}>
        <HelpCircle size={14} /> {titulo} {aberto ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {aberto && <div className="fr-como-texto">{children}</div>}
    </div>
  );
}

// Grupo de chips de escolha única ("Tudo · Entrou · Saiu").
function ChipsEscolha({ valor, onChange, opcoes, rotulo }) {
  return (
    <div className="fr-escolha" role="radiogroup" aria-label={rotulo}>
      {rotulo && <span className="fr-escolha-rotulo">{rotulo}</span>}
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          role="radio"
          aria-checked={valor === o.valor}
          className={'fr-chip' + (valor === o.valor ? ' ativo' : '')}
          onClick={() => onChange(o.valor)}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}

// ===========================================================================
// Página
// ===========================================================================

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
  const [conexoes, setConexoes] = useState([]);
  const [sincronizando, setSincronizando] = useState(false);
  const [aviso, setAviso] = useState('');
  const [erro, setErro] = useState('');
  const [versao, setVersao] = useState(0);

  const carregarConexoes = () => api.get('/financeiro/status').then((d) => setConexoes(d.conexoes || [])).catch(() => {});
  useEffect(() => { carregarConexoes(); }, []);

  const lojas = conexoes.filter((c) => c.autorizada && c.ativo);
  const lojasVisiveis = lojas.filter((c) => plataformas.length === 0 || plataformas.includes(c.marketplace));

  function alternar(lista, setLista, valor) {
    setLista(lista.includes(valor) ? lista.filter((v) => v !== valor) : [...lista, valor]);
  }
  function alternarPlataforma(m) {
    const proximas = plataformas.includes(m) ? plataformas.filter((v) => v !== m) : [...plataformas, m];
    setPlataformas(proximas);
    if (proximas.length) {
      setLojaIds((ids) => ids.filter((id) => proximas.includes(conexoes.find((c) => c.id === id)?.marketplace)));
    }
  }

  // Filtro-base: período, plataforma, loja. Cada aba acrescenta os seus.
  const base = useMemo(() => {
    const p = new URLSearchParams();
    if (inicio) p.set('data_inicio', inicio);
    if (fim) p.set('data_fim', fim);
    if (plataformas.length) p.set('marketplace', plataformas.join(','));
    if (lojaIds.length) p.set('origem_integracao_id', lojaIds.join(','));
    return p.toString();
  }, [inicio, fim, plataformas, lojaIds]);

  async function puxar({ periodo = false } = {}) {
    setSincronizando(true);
    setAviso('');
    setErro('');
    try {
      const r = await api.post('/financeiro/sincronizar', periodo ? { desde: inicio, ate: fim } : {});
      const partes = (r.resultados || []).map((res) => {
        const c = conexoes.find((x) => x.id === res.integracaoId);
        const nome = c?.nome || `Loja ${res.integracaoId}`;
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

  const filtrosTexto = [
    plataformas.length ? `Plataformas: ${plataformas.map(rotuloPlataforma).join(', ')}` : 'Todas as plataformas',
    lojaIds.length ? `Lojas: ${lojaIds.map((id) => conexoes.find((c) => c.id === id)?.nome || id).join(', ')}` : null,
  ].filter(Boolean);
  const contexto = { periodo: { inicio, fim }, filtros: filtrosTexto };

  return (
    <div className="page-wide fr-pagina">
      <div className="no-print">
        <h1>Repasses de marketplace</h1>
        <p className="page-sub">
          {aba === 'movimentacao' && 'Quanto cada plataforma pagou e descontou, dia a dia — lido do extrato da própria plataforma.'}
          {aba === 'repasses' && 'Cada vez que o dinheiro saiu de uma plataforma, e para onde ele foi.'}
          {aba === 'conferencia' && 'A prova de que o número está certo: o saldo de cada loja fecha no centavo, mês a mês.'}
        </p>

        <div className="fr-filtros card">
          <div className="fr-filtros-linha">
            <PeriodoFiltro inicio={inicio} fim={fim} onChange={({ inicio: i, fim: f }) => setPeriodo({ inicio: i, fim: f })} />
            <div className="fr-chips-grupo" aria-label="Plataformas">
              {PLATAFORMAS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`fr-chip fr-chip-plataforma fr-plat-${m}` + (plataformas.includes(m) ? ' ativo' : '')}
                  onClick={() => alternarPlataforma(m)}
                  aria-pressed={plataformas.includes(m)}
                >
                  {rotuloPlataforma(m)}
                </button>
              ))}
            </div>
            <div className="fr-acoes">
              <button className="btn btn-ghost" onClick={() => puxar()} disabled={sincronizando} title="Busca agora o que as plataformas liberaram de novo">
                <RefreshCw size={14} className={sincronizando ? 'girando' : ''} /> {sincronizando ? 'Puxando…' : 'Puxar extrato agora'}
              </button>
              <button className="btn btn-ghost" onClick={() => puxar({ periodo: true })} disabled={sincronizando} title="Lê de novo exatamente o período escolhido">
                <History size={14} /> Reler o período
              </button>
              <button className="btn btn-ghost" onClick={() => window.print()} title="Imprimir ou salvar em PDF">
                <Printer size={14} />
              </button>
            </div>
          </div>
          {lojasVisiveis.length > 1 && (
            <div className="fr-filtros-linha fr-lojas">
              <span className="fr-escolha-rotulo">Lojas</span>
              <button type="button" className={'fr-chip' + (lojaIds.length === 0 ? ' ativo' : '')} onClick={() => setLojaIds([])}>Todas</button>
              {lojasVisiveis.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`fr-chip fr-chip-loja fr-plat-${c.marketplace}` + (lojaIds.includes(c.id) ? ' ativo' : '')}
                  onClick={() => alternar(lojaIds, setLojaIds, c.id)}
                  aria-pressed={lojaIds.includes(c.id)}
                >
                  <span className="fr-bolinha" />{c.nome}
                </button>
              ))}
            </div>
          )}
          <LeituraDasLojas conexoes={lojas} />
        </div>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        {aviso && <div className="aviso-compacto tone-saudavel">{aviso}</div>}
        <AvisosDasConexoes conexoes={lojas} />
      </div>

      {aba === 'movimentacao' && (
        <AbaMovimentacao
          base={base}
          versao={versao}
          podeAbrirPedido={podeAbrirPedido}
          contexto={contexto}
          buscaInicial={searchParams.get('busca') || ''}
        />
      )}
      {aba === 'repasses' && <AbaRepasses base={base} versao={versao} contexto={contexto} periodo={{ inicio, fim }} />}
      {aba === 'conferencia' && <AbaConferencia base={base} versao={versao} contexto={contexto} />}
    </div>
  );
}

// Uma linha por loja: quando foi lida e se está tudo bem. Responde "esse
// número está atualizado?" antes de a pessoa precisar perguntar.
function LeituraDasLojas({ conexoes }) {
  if (!conexoes.length) return null;
  const estadoDe = (c) => (c.ultimo_erro ? 'erro' : c.status === 'rodando' || c.relatorio_pendente ? 'lendo' : Number(c.lancamentos) === 0 ? 'vazio' : 'ok');
  const fora = conexoes.filter((c) => estadoDe(c) !== 'ok');
  const maisAntiga = conexoes
    .filter((c) => estadoDe(c) === 'ok' && c.ultima_sincronizacao)
    .reduce((m, c) => (!m || c.ultima_sincronizacao < m ? c.ultima_sincronizacao : m), null);
  const texto = { erro: 'falhou na última leitura', lendo: 'lendo agora', vazio: 'ainda sem extrato' };
  return (
    <div className="fr-leitura">
      {fora.length < conexoes.length && (
        <span className="fr-leitura-item fr-leitura-ok">
          <span className="fr-leitura-ponto" />
          {fora.length === 0 ? 'Todas as lojas' : `${conexoes.length - fora.length} de ${conexoes.length} lojas`} atualizadas {tempoDesde(maisAntiga)}
        </span>
      )}
      {fora.map((c) => (
        <span key={c.id} className={`fr-leitura-item fr-leitura-${estadoDe(c)}`}>
          <span className="fr-leitura-ponto" />
          <strong>{c.nome}</strong> {c.relatorio_pendente ? 'esperando o Mercado Pago' : texto[estadoDe(c)]}
        </span>
      ))}
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
      {c.ultimo_erro
        ? <>a última leitura falhou. <ErroIntegracao erro={c.ultimo_erro} sistema="a plataforma" /></>
        : c.ultimo_aviso}
    </div>
  ));
}

function useDados(rota, params, versao) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro('');
    api.get(`/financeiro/${rota}?${params}`)
      .then((d) => { if (vivo) setDados(d); })
      .catch((e) => { if (vivo) setErro(e.message); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [rota, params, versao]);
  return { dados, carregando, erro };
}

// ===========================================================================
// Aba Movimentação
// ===========================================================================

function AbaMovimentacao({ base, versao, podeAbrirPedido, contexto, buscaInicial }) {
  const { dados, carregando, erro } = useDados('extrato', `${base}&status=liberado`, versao);
  const fech = useDados('fechamento', base, versao);
  const refDias = useRefGrafico();
  const refLista = useRef(null);

  // Filtro da LISTA — os blocos de cima mandam nele (clicar num dia, num
  // tipo ou num cartão do caminho do dinheiro).
  const [filtroLista, setFiltroLista] = useState(() => ({ ...FILTRO_LISTA_VAZIO, busca: buscaInicial }));
  function filtrarLista(parcial) {
    setFiltroLista((f) => ({ ...FILTRO_LISTA_VAZIO, ...parcial, busca: parcial.busca ?? '' }));
    setTimeout(() => refLista.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  // Soma por tipo (só liberado) — base do "caminho do dinheiro".
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

  // Dias × plataforma, só dinheiro do marketplace (sem saque e sem Pix).
  const { dias, plataformasNaTela, totalPorPlataforma, porPlataforma } = useMemo(() => {
    const mapa = new Map();
    const plats = new Set();
    const totais = {};
    const qtd = {};
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
        qtd[r.marketplace] = (qtd[r.marketplace] || 0) + n(r.quantidade);
      }
      mapa.set(data, linha);
    }
    const lista = PLATAFORMAS.filter((p) => plats.has(p));
    return {
      dias: [...mapa.values()].sort((a, b) => (a.data < b.data ? 1 : -1)),
      plataformasNaTela: lista,
      totalPorPlataforma: totais,
      porPlataforma: lista.map((m) => ({ marketplace: m, total: totais[m] || 0, quantidade: qtd[m] || 0 })).sort((a, b) => b.total - a.total),
    };
  }, [dados]);

  async function montarRelatorio(tipo) {
    if (!dados) return null;
    const graficos = await capturarGraficos([{ titulo: 'Liberado dia a dia', ref: refDias }]);
    const lista = Object.values(porTipo).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    let dadosRel = dados;
    if (tipo === 'completo') {
      // O relatório completo leva a lista inteira, não só a página da tela.
      const todos = await buscarTodosLancamentos(`${base}&status=liberado`);
      dadosRel = { ...dados, lancamentos: todos };
    }
    return definicaoMovimentacao({
      tipo, dados: dadosRel, dias, plataformasNaTela, totalPorPlataforma, porTipo: lista, porPlataforma,
      rotuloTipo, rotuloPlataforma, rotuloStatus, periodo: contexto.periodo, filtros: contexto.filtros, graficos,
    });
  }

  if (erro) return <div className="aviso-compacto tone-prejuizo">{erro}</div>;
  if (!dados) return <div className="card fr-carregando">{carregando ? 'Carregando…' : ''}</div>;

  const t = dados.totais;
  const vazio = dias.length === 0 && n(t.transferidoBanco) === 0 && n(t.enviadoMercadoPago) === 0;

  return (
    <>
      <div className="acoes-relatorio no-print">
        <div className="acoes-relatorio-texto">
          <strong>Relatório do período</strong>
          <span>Resumo para mandar ou completo para conferir, em PDF ou Excel.</span>
        </div>
        <BotaoRelatorio
          montar={montarRelatorio}
          rotulo="Gerar relatório"
          descricaoResumo="A conta do período, o gráfico dia a dia e o total por plataforma e por tipo."
          descricaoCompleto="Tudo do resumo e mais cada lançamento, um por linha."
        />
      </div>

      {vazio ? (
        <div className="card">
          <EstadoVazio
            titulo="Nada liberado neste período"
            descricao="Ou o extrato ainda está sendo lido (veja acima quando cada loja foi atualizada), ou não houve movimento. Tente outro período ou clique em “Puxar extrato agora”."
          />
        </div>
      ) : (
        <>
          <CaminhoDoDinheiro t={t} soma={soma} porTipo={porTipo} aoFiltrar={filtrarLista} />
          <SeloConferencia lojas={fech.dados?.lojas} carregando={fech.carregando} />
          <DiaADia
            dias={dias}
            plataformas={plataformasNaTela}
            totalPorPlataforma={totalPorPlataforma}
            refGrafico={refDias}
            diaSelecionado={filtroLista.dia}
            aoEscolherDia={(dia) => filtrarLista({ dia, grupo: 'marketplace' })}
          />
          <ParaOndeFoi porTipo={porTipo} aoEscolher={(tipo) => filtrarLista({ tipos: [tipo] })} />
        </>
      )}

      <div ref={refLista}>
        <ListaLancamentos base={base} versao={versao} filtro={filtroLista} setFiltro={setFiltroLista} podeAbrirPedido={podeAbrirPedido} />
      </div>
    </>
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
// O caminho do dinheiro: a conta montada, da venda até o liberado.
// ---------------------------------------------------------------------------
const PASSOS = [
  { chave: 'vendas', rotulo: 'Vendas liberadas', tipos: ['repasse_venda'], sinal: 'mais', frase: 'O que as vendas renderam depois da comissão da plataforma.' },
  { chave: 'devolucoes', rotulo: 'Devoluções e reclamações', tipos: ['devolucao'], sinal: 'menos', frase: 'Dinheiro devolvido ao comprador ou tirado por reclamação.' },
  { chave: 'custos', rotulo: 'Taxas, Ads e ajustes', tipos: ['taxa', 'ads', 'antecipacao', 'ajuste', 'outros'], sinal: 'menos', frase: 'Cobranças da plataforma fora da comissão: frete, antecipação, publicidade.' },
  { chave: 'retido', rotulo: 'Dinheiro retido', tipos: ['reserva'], sinal: 'maismenos', frase: 'A plataforma segura até resolver uma reclamação ou dívida. Volta depois.' },
];

function CaminhoDoDinheiro({ t, soma, porTipo, aoFiltrar }) {
  const qtd = (tipos) => tipos.reduce((s, x) => s + (porTipo[x]?.quantidade || 0), 0);
  const foraTotal = n(t.outrasEntradas) + n(t.outrasSaidas);
  return (
    <section className="fr-caminho card" aria-label="A conta do período">
      <div className="card-head">A conta do período</div>
      <div className="fr-caminho-trilha">
        {PASSOS.map((p, i) => {
          const valor = soma(p.tipos);
          return (
            <div key={p.chave} className="fr-caminho-passo-envolto">
              {i > 0 && (
                <span className="fr-caminho-op" aria-hidden="true">
                  {valor < 0 ? <Minus size={16} /> : <Plus size={16} />}
                </span>
              )}
              <button
                type="button"
                className={`fr-caminho-passo fr-passo-${p.chave}`}
                onClick={() => aoFiltrar({ tipos: p.tipos })}
                title="Ver estes lançamentos na lista"
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <span className="fr-caminho-rotulo">{p.rotulo}</span>
                <span className="fr-caminho-valor mono">{brl(i === 0 ? valor : Math.abs(valor))}</span>
                <span className="fr-caminho-frase">{p.frase}</span>
                <span className="fr-caminho-qtd">{plural(qtd(p.tipos), 'lançamento')} <ArrowRight size={12} /></span>
              </button>
            </div>
          );
        })}
        <span className="fr-caminho-op fr-caminho-igual" aria-hidden="true"><Equal size={18} /></span>
        <div className="fr-caminho-resultado" style={{ animationDelay: '320ms' }}>
          <span className="fr-caminho-rotulo">Liberado pelo marketplace</span>
          <span className="fr-caminho-valor mono">{brl(t.liberado)}</span>
          <span className="fr-caminho-frase">O que de fato ficou disponível para sacar. Não conta saque nem dinheiro de fora.</span>
        </div>
      </div>

      <div className="fr-caminho-depois">
        <div className="fr-depois-item">
          <Landmark size={18} />
          <div>
            <span className="fr-depois-rotulo">Foi para o banco</span>
            <span className="mono fr-depois-valor">{brl(t.transferidoBanco)}</span>
            <span className="fr-depois-frase">Saques do Mercado Pago{n(t.transferenciaEmAndamento) ? ` · ${brl(t.transferenciaEmAndamento)} ainda a caminho` : ''}</span>
          </div>
        </div>
        <div className="fr-depois-item">
          <Wallet size={18} />
          <div>
            <span className="fr-depois-rotulo">Shopee → Mercado Pago</span>
            <span className="mono fr-depois-valor">{brl(t.enviadoMercadoPago)}</span>
            <span className="fr-depois-frase">Saques da Shopee. Caem no Mercado Pago e saem para o banco junto com o resto</span>
          </div>
        </div>
        <button type="button" className="fr-depois-item fr-depois-clicavel" onClick={() => aoFiltrar({ grupo: 'fora' })}>
          <ArrowDownLeft size={18} />
          <div>
            <span className="fr-depois-rotulo">Passou pela conta, não é marketplace</span>
            <span className="mono fr-depois-valor">{brl(foraTotal)}</span>
            <span className="fr-depois-frase">Pix recebido (o saque da Shopee chegando), maquininha, contas pagas. Fica fora do liberado</span>
          </div>
        </button>
        <div className="fr-depois-item">
          <Hourglass size={18} />
          <div>
            <span className="fr-depois-rotulo">Ainda vai liberar</span>
            <span className="mono fr-depois-valor">{brl(t.pendente)}</span>
            <span className="fr-depois-frase">A plataforma já calculou e ainda não soltou</span>
          </div>
        </div>
      </div>

      <ComoFunciona>
        <p>
          A conta usa só o <strong>extrato da plataforma</strong> (não a soma dos pedidos). Cada linha do extrato
          entra uma única vez — pelo identificador da própria plataforma — e é classificada em um destes grupos:
        </p>
        <ul>
          <li><strong>Dinheiro do marketplace</strong>: vendas, devoluções, taxas, Ads, antecipação e dinheiro retido. É o que forma o “Liberado”.</li>
          <li><strong>Saque</strong>: o dinheiro saindo da plataforma. Não é ganho nem perda — é o mesmo dinheiro mudando de lugar.</li>
          <li><strong>Não é do marketplace</strong>: a conta do Mercado Pago também recebe o Pix do saque da Shopee e a venda da maquininha. Antes isso era somado como venda do Mercado Livre e o dinheiro da Shopee aparecia duas vezes.</li>
        </ul>
        <p>Clique em qualquer cartão para ver na lista os lançamentos que formam aquele número.</p>
      </ComoFunciona>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Selo: o mês fechou?
// ---------------------------------------------------------------------------
function SeloConferencia({ lojas, carregando }) {
  if (!lojas) return carregando ? <div className="fr-selo-faixa fr-selo-carregando">Conferindo o saldo de cada loja…</div> : null;
  const itens = lojas.flatMap((l) => l.meses.filter((m) => m.linhas > 0).map((m) => ({ ...m, loja: l.loja, marketplace: l.marketplace, id: `${l.integracaoId}-${m.mes}` })));
  if (!itens.length) return null;
  const ruins = itens.filter((i) => i.fechado === false);
  return (
    <div className={'fr-selo-faixa' + (ruins.length ? ' fr-selo-com-problema' : ' fr-selo-tudo-ok')}>
      <span className="fr-selo-titulo">
        {ruins.length
          ? <><XCircle size={16} /> {plural(ruins.length, 'loja/mês', 'lojas/meses')} não {ruins.length === 1 ? 'fecha' : 'fecham'} — veja a aba Conferência</>
          : <><CheckCircle2 size={16} /> Número conferido: o saldo de cada loja fecha no centavo</>}
      </span>
      <span className="fr-selo-lista">
        {itens.map((i) => (
          <span
            key={i.id}
            className={'fr-selo ' + (i.fechado === true ? 'ok' : i.fechado === false ? 'ruim' : 'neutro')}
            title={i.fechado === false ? `Diferença de ${brl(i.diferenca)}` : i.conferencia === 'repasses' ? 'Conferido contra os repasses da TikTok' : 'Saldo inicial + movimento = saldo final'}
          >
            {i.fechado === true ? <CheckCircle2 size={12} /> : i.fechado === false ? <XCircle size={12} /> : <CircleDashed size={12} />}
            {i.loja} · {mesCurto(i.mes)}
          </span>
        ))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dia a dia: clicar num dia filtra a lista.
// ---------------------------------------------------------------------------
const COR_PLAT_VAR = { mercado_livre: '--fr-meli', shopee: '--fr-shopee', tiktok_shop: '--fr-tiktok' };

function lerCor(nome, reserva) {
  if (typeof window === 'undefined') return reserva;
  const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
  return v || reserva;
}

function DiaADia({ dias, plataformas, totalPorPlataforma, refGrafico, diaSelecionado, aoEscolherDia }) {
  const paleta = usePaletaGrafico();
  const [modo, setModo] = useState('plataforma');
  const [verTabela, setVerTabela] = useState(false);
  const cores = {
    mercado_livre: lerCor(COR_PLAT_VAR.mercado_livre, '#d8b23a'),
    shopee: lerCor(COR_PLAT_VAR.shopee, '#e2622a'),
    tiktok_shop: lerCor(COR_PLAT_VAR.tiktok_shop, '#3a3a3a'),
    entrou: paleta.positivo || '#2e8b57',
    saiu: paleta.negativo || '#c0392b',
  };
  const crescente = [...dias].reverse().map((d) => ({ ...d, rotulo: dataBr(d.data).slice(0, 5) }));
  const series = modo === 'plataforma'
    ? plataformas.map((m) => ({ chave: m, nome: rotuloPlataforma(m), cor: cores[m] }))
    : [{ chave: 'entrou', nome: 'Entrou', cor: cores.entrou }, { chave: 'saiu', nome: 'Saiu', cor: cores.saiu }];
  const tick = { fontSize: 11.5, fill: paleta.rotulo };
  const melhor = dias.reduce((m, d) => (d.total > (m?.total ?? -Infinity) ? d : m), null);
  const media = dias.length ? dias.reduce((s, d) => s + d.total, 0) / dias.length : 0;

  function Dica({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="grafico-tooltip">
        <div className="grafico-tooltip-titulo">{dataBr(d.data)} · clique para ver os lançamentos</div>
        {series.map((s) => (
          <div className="grafico-tooltip-linha" key={s.chave}>
            <span className="grafico-tooltip-bolinha" style={{ background: s.cor }} />
            <span className="grafico-tooltip-nome">{s.nome}</span>
            <span className="mono grafico-tooltip-valor">{brl(d[s.chave] || 0)}</span>
          </div>
        ))}
        <div className="grafico-tooltip-linha"><span className="grafico-tooltip-nome"><strong>Liberado no dia</strong></span><span className="mono grafico-tooltip-valor"><strong>{brl(d.total)}</strong></span></div>
      </div>
    );
  }

  return (
    <section className="card fr-dias">
      <div className="card-head-linha">
        <div className="card-head">Dia a dia</div>
        <ChipsEscolha
          valor={modo}
          onChange={setModo}
          opcoes={[{ valor: 'plataforma', rotulo: 'Por plataforma' }, { valor: 'fluxo', rotulo: 'Entrou × saiu' }]}
        />
      </div>
      <div className="fr-dias-resumo">
        <span>Média por dia <strong className="mono">{brl(media)}</strong></span>
        {melhor && <span>Melhor dia <strong className="mono">{dataBr(melhor.data)} · {brl(melhor.total)}</strong></span>}
        <span className="fr-dica-clique">Clique numa coluna para ver os lançamentos daquele dia</span>
      </div>
      <div ref={refGrafico}>
        <div className="fr-dias-grafico">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={crescente}
              margin={{ top: 12, right: 8, left: 0, bottom: 0 }}
              barCategoryGap="18%"
              onClick={(e) => { const d = e?.activePayload?.[0]?.payload; if (d) aoEscolherDia(d.data); }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={paleta.grade} vertical={false} />
              <XAxis dataKey="rotulo" tick={tick} axisLine={{ stroke: paleta.eixo }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
              <YAxis tick={tick} tickFormatter={moedaCompacta} width={78} axisLine={false} tickLine={false} />
              <Tooltip content={<Dica />} cursor={{ fill: paleta.grade, fillOpacity: 0.5 }} />
              {modo === 'fluxo' && <ReferenceLine y={0} stroke={paleta.eixo} />}
              {series.map((s, i) => (
                <Bar
                  key={s.chave}
                  dataKey={s.chave}
                  name={s.nome}
                  stackId={modo === 'plataforma' ? 'p' : undefined}
                  fill={s.cor}
                  radius={modo === 'plataforma' ? (i === series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 4, 4]}
                  maxBarSize={38}
                  animationDuration={600}
                  onClick={(d) => { const dia = d?.payload?.data || d?.data; if (dia) aoEscolherDia(dia); }}
                  cursor="pointer"
                >
                  {crescente.map((d) => (
                    <Cell key={d.data} fillOpacity={diaSelecionado && diaSelecionado !== d.data ? 0.3 : 1} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ul className="grafico-legenda grafico-legenda-inline">
          {series.map((s) => (
            <li key={s.chave}>
              <span className="grafico-legenda-cor" style={{ background: s.cor }} />
              <span className="grafico-legenda-nome">{s.nome}</span>
              {modo === 'plataforma' && <span className="mono grafico-legenda-valor">{brl(totalPorPlataforma[s.chave] || 0)}</span>}
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="fr-como-botao" onClick={() => setVerTabela((v) => !v)}>
        {verTabela ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {verTabela ? 'Esconder' : 'Ver'} a tabela dia a dia
      </button>
      {verTabela && (
        <DataTable>
          <table className="data-table fr-tabela">
            <thead>
              <tr>
                <th>Dia</th>
                {plataformas.map((m) => <th key={m} className="num">{rotuloPlataforma(m)}</th>)}
                <th className="num">Liberado no dia</th>
                <th className="num">Saque</th>
              </tr>
            </thead>
            <tbody>
              {dias.map((d) => (
                <tr key={d.data} className={'fr-linha-clicavel' + (diaSelecionado === d.data ? ' fr-linha-ativa' : '')} onClick={() => aoEscolherDia(d.data)}>
                  <td className="mono">{dataBr(d.data)}</td>
                  {plataformas.map((m) => <td key={m} className="num">{d[m] === undefined ? '—' : <Valor valor={d[m]} colorir={false} semSinal />}</td>)}
                  <td className="num"><Valor valor={d.total} forte colorir={false} semSinal /></td>
                  <td className="num fr-apagado">{d.saque ? brl(d.saque) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Para onde o dinheiro foi: duas colunas, entrou e saiu.
// ---------------------------------------------------------------------------
function ParaOndeFoi({ porTipo, aoEscolher }) {
  const itens = Object.values(porTipo).filter((x) => TIPO[x.tipo]?.grupo === 'marketplace' && Math.abs(x.total) >= 0.01);
  const entrou = itens.filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
  const saiu = itens.filter((x) => x.total < 0).sort((a, b) => a.total - b.total);
  // Cada coluna na própria escala: na mesma régua, a venda (centenas de
  // milhares) achatava todas as saídas em um tracinho.
  const Coluna = ({ titulo, lista, Icone, classe, maior = Math.max(1, ...lista.map((x) => Math.abs(x.total))) }) => (
    <div className={`fr-onde-coluna ${classe}`}>
      <div className="fr-onde-titulo"><Icone size={15} /> {titulo} <span className="mono">{brl(lista.reduce((s, x) => s + x.total, 0))}</span></div>
      {lista.length === 0 && <p className="fr-apagado">Nada no período.</p>}
      {lista.map((x, i) => (
        <button key={x.tipo} type="button" className="fr-onde-item" onClick={() => aoEscolher(x.tipo)} title="Ver estes lançamentos">
          <span className="fr-onde-nome">{rotuloTipo(x.tipo)}<small>{plural(x.quantidade, 'lançamento')}</small></span>
          <span className="fr-onde-barra"><span style={{ width: `${Math.max(3, (Math.abs(x.total) / maior) * 100)}%`, animationDelay: `${i * 60}ms` }} /></span>
          <span className="mono fr-onde-valor">{brl(Math.abs(x.total))}</span>
        </button>
      ))}
    </div>
  );
  return (
    <section className="card fr-onde">
      <div className="card-head">Para onde o dinheiro foi</div>
      <div className="fr-onde-grade">
        <Coluna titulo="Entrou" lista={entrou} Icone={ArrowDownLeft} classe="fr-onde-entrou" />
        <Coluna titulo="Saiu" lista={saiu} Icone={ArrowUpRight} classe="fr-onde-saiu" />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Lista de lançamentos: todos os filtros, paginada no servidor.
// ---------------------------------------------------------------------------
const FILTRO_LISTA_VAZIO = {
  busca: '', tipos: [], grupo: '', sentido: '', status: 'liberado', comPedido: '', valorMin: '', valorMax: '', dia: '',
};
const COLUNAS_EXPORTACAO = [
  { rotulo: 'Data', valor: (l) => dataBr(dataIso(l.data_liberacao)) },
  { rotulo: 'Hora', valor: (l) => horaBr(l.data_evento) },
  { rotulo: 'Plataforma', valor: (l) => rotuloPlataforma(l.marketplace) },
  { rotulo: 'Loja', valor: (l) => l.loja_nome || '' },
  { rotulo: 'Tipo', valor: (l) => rotuloTipo(l.tipo) },
  { rotulo: 'O que foi', valor: (l) => descricaoHumana(l) },
  { rotulo: 'Pedido', valor: (l) => (l.pedido_numero ? `#${l.pedido_numero}` : l.pedido_id_externo || '') },
  { rotulo: 'Id na plataforma', valor: (l) => idCurto(l) },
  { rotulo: 'Repasse', valor: (l) => l.repasse_id_externo || '' },
  { rotulo: 'Valor', valor: (l) => n(l.valor) },
  { rotulo: 'Situação', valor: (l) => rotuloStatus(l.status) },
];

function ListaLancamentos({ base, versao, filtro, setFiltro, podeAbrirPedido }) {
  const [textoBusca, setTextoBusca] = useState(filtro.busca);
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(50);
  const [ordem, setOrdem] = useState({ coluna: 'data', direcao: 'desc' });
  const [maisFiltros, setMaisFiltros] = useState(false);
  const [exportando, setExportando] = useState(false);

  useEffect(() => { setTextoBusca(filtro.busca); }, [filtro.busca]);
  useEffect(() => { setPagina(1); }, [filtro, base, porPagina]);

  const params = useMemo(() => {
    const p = new URLSearchParams(base);
    if (filtro.dia) { p.set('data_inicio', filtro.dia); p.set('data_fim', filtro.dia); }
    if (filtro.busca) p.set('busca', filtro.busca);
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
  function alternarTipo(chave) {
    muda({ tipos: filtro.tipos.includes(chave) ? filtro.tipos.filter((x) => x !== chave) : [...filtro.tipos, chave], grupo: '' });
  }
  function ordenar(coluna) {
    setOrdem((o) => ({ coluna, direcao: o.coluna === coluna && o.direcao === 'desc' ? 'asc' : 'desc' }));
  }

  const chips = [
    filtro.dia && { chave: 'dia', rotulo: 'Dia', valor: dataBr(filtro.dia), onRemover: () => muda({ dia: '' }) },
    filtro.busca && { chave: 'busca', rotulo: 'Busca', valor: filtro.busca, onRemover: () => muda({ busca: '' }) },
    filtro.tipos.length > 0 && { chave: 'tipos', rotulo: 'Tipo', valor: filtro.tipos.map(rotuloTipo).join(', '), onRemover: () => muda({ tipos: [] }) },
    filtro.grupo && { chave: 'grupo', rotulo: 'Grupo', valor: GRUPOS.find((g) => g.chave === filtro.grupo)?.rotulo, onRemover: () => muda({ grupo: '' }) },
    filtro.sentido && { chave: 'sentido', rotulo: 'Sentido', valor: filtro.sentido === 'entrada' ? 'Só o que entrou' : 'Só o que saiu', onRemover: () => muda({ sentido: '' }) },
    filtro.status !== 'liberado' && { chave: 'status', rotulo: 'Situação', valor: filtro.status === 'pendente' ? 'Só pendente' : 'Liberado e pendente', onRemover: () => muda({ status: 'liberado' }) },
    filtro.comPedido && { chave: 'pedido', rotulo: 'Pedido', valor: filtro.comPedido === 'sim' ? 'Com pedido' : 'Sem pedido', onRemover: () => muda({ comPedido: '' }) },
    (filtro.valorMin !== '' || filtro.valorMax !== '') && { chave: 'valor', rotulo: 'Valor', valor: `${filtro.valorMin !== '' ? `de ${brl(filtro.valorMin)}` : ''} ${filtro.valorMax !== '' ? `até ${brl(filtro.valorMax)}` : ''}`.trim(), onRemover: () => muda({ valorMin: '', valorMax: '' }) },
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
  const Th = ({ coluna, children, className }) => (
    <th className={'fr-th-ordena ' + (className || '')} onClick={() => ordenar(coluna)} aria-sort={ordem.coluna === coluna ? (ordem.direcao === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {children}{ordem.coluna === coluna && (ordem.direcao === 'asc' ? ' ↑' : ' ↓')}
    </th>
  );

  return (
    <section className="card fr-lista">
      <div className="card-head-linha">
        <div className="card-head">Lançamentos</div>
        <div className="fr-acoes">
          <button type="button" className="btn btn-ghost" disabled={exportando || !dados?.total} onClick={() => exportar('xlsx')}>{exportando ? 'Exportando…' : 'Excel'}</button>
          <button type="button" className="btn btn-ghost" disabled={exportando || !dados?.total} onClick={() => exportar('csv')}>CSV</button>
        </div>
      </div>

      <form className="fr-busca" onSubmit={(e) => { e.preventDefault(); muda({ busca: textoBusca.trim() }); }} role="search">
        <Search size={16} />
        <input
          value={textoBusca}
          onChange={(e) => setTextoBusca(e.target.value)}
          placeholder="Nº do pedido, id do pagamento, id do repasse ou parte da descrição…"
          aria-label="Buscar lançamento"
        />
        {textoBusca && <button type="button" className="fr-busca-limpar" onClick={() => { setTextoBusca(''); muda({ busca: '' }); }} aria-label="Limpar"><X size={14} /></button>}
        <button type="submit" className="btn btn-primary">Buscar</button>
      </form>

      <div className="fr-tipos">
        {GRUPOS.map((g) => (
          <div key={g.chave} className="fr-tipos-grupo">
            <button
              type="button"
              className={'fr-tipos-grupo-nome' + (filtro.grupo === g.chave ? ' ativo' : '')}
              onClick={() => muda({ grupo: filtro.grupo === g.chave ? '' : g.chave, tipos: [] })}
              title="Filtrar pelo grupo inteiro"
            >
              {g.rotulo}
            </button>
            {TIPOS.filter((t) => t.grupo === g.chave).map((t) => (
              <button
                key={t.chave}
                type="button"
                className={`fr-chip fr-chip-tipo fr-tom-${t.tom}` + (filtro.tipos.includes(t.chave) ? ' ativo' : '')}
                onClick={() => alternarTipo(t.chave)}
                aria-pressed={filtro.tipos.includes(t.chave)}
              >
                {t.curto}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="fr-filtros-linha fr-filtros-secundarios">
        <ChipsEscolha rotulo="Mostrar" valor={filtro.sentido} onChange={(v) => muda({ sentido: v })} opcoes={[{ valor: '', rotulo: 'Tudo' }, { valor: 'entrada', rotulo: 'Só entrou' }, { valor: 'saida', rotulo: 'Só saiu' }]} />
        <button type="button" className="fr-como-botao" onClick={() => setMaisFiltros((v) => !v)}>
          {maisFiltros ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Mais filtros
        </button>
      </div>
      {maisFiltros && (
        <div className="fr-filtros-linha fr-filtros-secundarios fr-mais-filtros">
          <ChipsEscolha rotulo="Situação" valor={filtro.status} onChange={(v) => muda({ status: v })} opcoes={[{ valor: 'liberado', rotulo: 'Liberado' }, { valor: 'pendente', rotulo: 'Pendente' }, { valor: '', rotulo: 'Os dois' }]} />
          <ChipsEscolha rotulo="Pedido" valor={filtro.comPedido} onChange={(v) => muda({ comPedido: v })} opcoes={[{ valor: '', rotulo: 'Todos' }, { valor: 'sim', rotulo: 'Com pedido' }, { valor: 'nao', rotulo: 'Sem pedido' }]} />
          <div className="fr-escolha">
            <span className="fr-escolha-rotulo">Valor</span>
            <input className="fr-input-valor" inputMode="decimal" placeholder="de R$" value={filtro.valorMin} onChange={(e) => muda({ valorMin: e.target.value.replace(',', '.') })} />
            <input className="fr-input-valor" inputMode="decimal" placeholder="até R$" value={filtro.valorMax} onChange={(e) => muda({ valorMax: e.target.value.replace(',', '.') })} />
          </div>
        </div>
      )}

      <ChipsFiltros itens={chips} onLimparTudo={chips.length > 1 ? () => setFiltro({ ...FILTRO_LISTA_VAZIO }) : undefined} />

      {dados && (
        <div className="fr-lista-soma">
          <span><strong>{dados.total.toLocaleString('pt-BR')}</strong> lançamento(s)</span>
          <span>Entrou <Valor valor={dados.soma.entradas} /></span>
          <span>Saiu <Valor valor={dados.soma.saidas} /></span>
          <span>Soma do que está na lista <Valor valor={dados.soma.total} forte /></span>
          {carregando && <span className="fr-apagado">atualizando…</span>}
        </div>
      )}
      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <Paginacao
        pagina={pagina}
        totalPaginas={dados?.paginas || 1}
        tamanho={porPagina}
        tamanhos={[25, 50, 100, 250]}
        totalItens={dados?.total || 0}
        inicio={(pagina - 1) * porPagina}
        fim={Math.min(pagina * porPagina, dados?.total || 0)}
        setPagina={setPagina}
        setTamanho={setPorPagina}
        posicao="topo"
      />
      <DataTable>
        <table className="data-table fr-tabela">
          <thead>
            <tr>
              <Th coluna="data">Quando</Th>
              <Th coluna="loja">Loja</Th>
              <Th coluna="tipo">O que foi</Th>
              <th>Pedido</th>
              <th>Repasse</th>
              <Th coluna="valor" className="num">Valor</Th>
            </tr>
          </thead>
          <tbody>
            {lista.map((l) => (
              <tr key={l.id} className={l.status === 'pendente' ? 'fr-linha-pendente' : ''}>
                <td className="mono fr-quando">{dataBr(dataIso(l.data_liberacao))}<small>{horaBr(l.data_evento)}</small></td>
                <td><ChipPlataforma marketplace={l.marketplace}>{l.loja_nome || rotuloPlataforma(l.marketplace)}</ChipPlataforma></td>
                <td>
                  <div className="fr-oque">
                    <SeloTipo tipo={l.tipo} />
                    <span>{descricaoHumana(l)}</span>
                    {l.status === 'pendente' && <span className="fr-selo-tipo fr-tom-pendente">Pendente</span>}
                  </div>
                  <small className="fr-id" title="Identificador na plataforma — dá para buscar por ele">{idCurto(l)}</small>
                </td>
                <td className="mono">
                  {l.pedido_numero ? (
                    podeAbrirPedido ? <Link to={`/pedidos/${l.pedido_id}`}>#{l.pedido_numero}</Link> : `#${l.pedido_numero}`
                  ) : l.pedido_id_externo ? (
                    <button type="button" className="fr-link" onClick={() => muda({ busca: l.pedido_id_externo })} title="Pedido ainda não importado no Hub — clique para ver tudo dele">
                      <Link2 size={11} /> {String(l.pedido_id_externo).slice(-8)}
                    </button>
                  ) : <span className="fr-apagado">—</span>}
                </td>
                <td className="mono">
                  {l.repasse_id_externo ? (
                    <button type="button" className="fr-link" onClick={() => muda({ busca: l.repasse_id_externo })} title="Ver todos os lançamentos deste repasse">
                      {String(l.repasse_id_externo).slice(-8)}
                    </button>
                  ) : <span className="fr-apagado">—</span>}
                </td>
                <td className="num"><Valor valor={l.valor} forte /></td>
              </tr>
            ))}
            {dados && lista.length === 0 && (
              <tr><td colSpan="6" className="fr-vazio-linha">Nenhum lançamento com esses filtros.{chips.length ? ' Tire um filtro acima.' : ''}</td></tr>
            )}
          </tbody>
        </table>
      </DataTable>
      <Paginacao
        pagina={pagina}
        totalPaginas={dados?.paginas || 1}
        tamanho={porPagina}
        tamanhos={[25, 50, 100, 250]}
        totalItens={dados?.total || 0}
        inicio={(pagina - 1) * porPagina}
        fim={Math.min(pagina * porPagina, dados?.total || 0)}
        setPagina={setPagina}
        setTamanho={setPorPagina}
      />
    </section>
  );
}

// ===========================================================================
// Aba Repasses
// ===========================================================================

function AbaRepasses({ base, versao, contexto, periodo }) {
  const navigate = useNavigate();
  const [busca, setBusca] = useState('');
  const [texto, setTexto] = useState('');
  const [status, setStatus] = useState('');
  const [pagina, setPagina] = useState(1);
  const [porPagina, setPorPagina] = useState(50);
  const refDias = useRefGrafico();
  const paleta = usePaletaGrafico();

  const params = useMemo(() => {
    const p = new URLSearchParams(base);
    if (busca) p.set('busca', busca);
    if (status) p.set('status', status);
    return p.toString();
  }, [base, busca, status]);
  useEffect(() => { setPagina(1); }, [params, porPagina]);
  const { dados, carregando, erro } = useDados('repasses', params, versao);
  const repasses = dados?.repasses || [];

  // Um cartão por destino — é a pergunta "para onde foi o dinheiro?".
  const destinos = useMemo(() => {
    const m = {};
    for (const r of repasses) {
      const k = r.marketplace;
      if (!m[k]) m[k] = { marketplace: k, pago: 0, andamento: 0, qtd: 0, lojas: new Set() };
      const v = Math.abs(n(r.valor_liquido));
      const sinal = n(r.valor_liquido) < 0 ? -1 : 1;
      if (r.status === 'pago') m[k].pago += v * sinal; else m[k].andamento += v * sinal;
      m[k].qtd += 1;
      m[k].lojas.add(r.loja_nome);
    }
    return PLATAFORMAS.filter((p) => m[p]).map((p) => m[p]);
  }, [repasses]);

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

  const totalPago = repasses.filter((r) => r.status === 'pago').reduce((s, r) => s + n(r.valor_liquido), 0);
  const totalAndamento = repasses.filter((r) => r.status !== 'pago').reduce((s, r) => s + n(r.valor_liquido), 0);
  const porPlataforma = destinos.map((d) => ({ marketplace: d.marketplace, quantidade: d.qtd, pago: d.pago, andamento: d.andamento }));

  async function montarRelatorio(tipo) {
    const graficos = await capturarGraficos([{ titulo: 'Repasses por dia', ref: refDias }]);
    return definicaoRepasses({ tipo, repasses, totalPago, totalAndamento, porPlataforma, rotuloPlataforma, periodo: contexto.periodo, filtros: contexto.filtros, graficos });
  }

  function verLancamentos(r) {
    const q = new URLSearchParams({ busca: r.repasse_id_externo, de: periodo.inicio, ate: periodo.fim });
    navigate(`/financeiro/movimentacao?${q.toString()}`);
  }

  const cores = {
    mercado_livre: lerCor('--fr-meli', '#d8b23a'),
    shopee: lerCor('--fr-shopee', '#e2622a'),
    tiktok_shop: lerCor('--fr-tiktok', '#3a3a3a'),
  };
  const plats = PLATAFORMAS.filter((p) => porDia.some((d) => d[p]));
  const inicio = (pagina - 1) * porPagina;
  const paginaAtual = repasses.slice(inicio, inicio + porPagina);
  const explicacaoDestino = {
    mercado_livre: 'Saques do Mercado Pago para a conta da empresa. É o que aparece no extrato do banco.',
    shopee: 'Saques da Shopee. Caem no Mercado Pago da mesma empresa, não direto no banco.',
    tiktok_shop: 'Repasses da TikTok para a carteira da loja na própria TikTok.',
  };

  if (erro) return <div className="aviso-compacto tone-prejuizo">{erro}</div>;

  return (
    <>
      <div className="acoes-relatorio no-print">
        <div className="acoes-relatorio-texto">
          <strong>Relatório de repasses</strong>
          <span>Cada saque do período, pronto para bater com o extrato do banco.</span>
        </div>
        <BotaoRelatorio montar={montarRelatorio} disabled={!repasses.length} rotulo="Gerar relatório" descricaoResumo="Os totais por destino e o gráfico." descricaoCompleto="Tudo do resumo e cada repasse, um por linha." />
      </div>

      <div className="fr-destinos">
        {destinos.length === 0 && <div className="card fr-carregando">{carregando ? 'Carregando…' : 'Nenhum repasse neste período.'}</div>}
        {destinos.map((d, i) => (
          <div key={d.marketplace} className={`card fr-destino fr-plat-${d.marketplace}`} style={{ animationDelay: `${i * 70}ms` }}>
            <div className="fr-destino-rota">
              <ChipPlataforma marketplace={d.marketplace} />
              <ArrowRight size={16} />
              <strong>{DESTINO_SAQUE[d.marketplace]}</strong>
            </div>
            <span className="mono fr-destino-valor">{brl(d.pago)}</span>
            <span className="fr-destino-frase">{explicacaoDestino[d.marketplace]}</span>
            <span className="fr-destino-rodape">
              {plural(d.qtd, 'repasse')} · {[...d.lojas].join(', ')}
              {d.andamento ? <> · <strong>{brl(d.andamento)}</strong> ainda a caminho</> : null}
            </span>
          </div>
        ))}
      </div>

      {porDia.length > 0 && (
        <section className="card">
          <div className="card-head">Repasses por dia</div>
          <div ref={refDias}>
            <div className="fr-dias-grafico" style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={porDia} margin={{ top: 12, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
                  <CartesianGrid strokeDasharray="3 3" stroke={paleta.grade} vertical={false} />
                  <XAxis dataKey="rotulo" tick={{ fontSize: 11.5, fill: paleta.rotulo }} axisLine={{ stroke: paleta.eixo }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis tick={{ fontSize: 11.5, fill: paleta.rotulo }} tickFormatter={moedaCompacta} width={78} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v, nome) => [brl(v), nome]} labelFormatter={(r, p) => (p?.[0]?.payload?.data ? dataBr(p[0].payload.data) : r)} />
                  {plats.map((p, i) => (
                    <Bar key={p} dataKey={p} name={rotuloPlataforma(p)} stackId="r" fill={cores[p]} radius={i === plats.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={38} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ul className="grafico-legenda grafico-legenda-inline">
              {plats.map((p) => (
                <li key={p}><span className="grafico-legenda-cor" style={{ background: cores[p] }} /><span className="grafico-legenda-nome">{rotuloPlataforma(p)} → {DESTINO_SAQUE[p]}</span></li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="card fr-lista">
        <div className="card-head-linha">
          <div className="card-head">Cada repasse</div>
          <div className="fr-acoes">
            <button type="button" className="btn btn-ghost" disabled={!repasses.length} onClick={() => exportarXlsx('repasses-marketplace', COLUNAS_REPASSE, repasses)}>Excel</button>
            <button type="button" className="btn btn-ghost" disabled={!repasses.length} onClick={() => exportarCsv('repasses-marketplace', COLUNAS_REPASSE, repasses)}>CSV</button>
          </div>
        </div>
        <form className="fr-busca" onSubmit={(e) => { e.preventDefault(); setBusca(texto.trim()); }} role="search">
          <Search size={16} />
          <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Id do repasse ou do saque…" aria-label="Buscar repasse" />
          {texto && <button type="button" className="fr-busca-limpar" onClick={() => { setTexto(''); setBusca(''); }} aria-label="Limpar"><X size={14} /></button>}
          <button type="submit" className="btn btn-primary">Buscar</button>
        </form>
        <div className="fr-filtros-linha fr-filtros-secundarios">
          <ChipsEscolha rotulo="Situação" valor={status} onChange={setStatus} opcoes={[{ valor: '', rotulo: 'Todos' }, { valor: 'pago', rotulo: 'Concluído' }, { valor: 'processando', rotulo: 'A caminho' }]} />
        </div>
        <Paginacao pagina={pagina} totalPaginas={Math.max(1, Math.ceil(repasses.length / porPagina))} tamanho={porPagina} tamanhos={[25, 50, 100, 250]} totalItens={repasses.length} inicio={inicio} fim={Math.min(inicio + porPagina, repasses.length)} setPagina={setPagina} setTamanho={setPorPagina} posicao="topo" />
        <DataTable>
          <table className="data-table fr-tabela">
            <thead>
              <tr><th>Dia</th><th>De</th><th>Para</th><th>Identificador</th><th className="num">Valor</th><th>Situação</th><th /></tr>
            </thead>
            <tbody>
              {paginaAtual.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.data_liberacao ? dataBr(dataIso(r.data_liberacao)) : '—'}</td>
                  <td><ChipPlataforma marketplace={r.marketplace}>{r.loja_nome || rotuloPlataforma(r.marketplace)}</ChipPlataforma></td>
                  <td>{DESTINO_SAQUE[r.marketplace]}</td>
                  <td className="mono fr-id">{r.repasse_id_externo}</td>
                  <td className="num"><Valor valor={r.valor_liquido} forte colorir={false} semSinal /></td>
                  <td>
                    <span className={'fr-situacao ' + (r.status === 'pago' ? 'ok' : 'andamento')}>
                      {r.status === 'pago' ? 'Concluído' : r.status === 'processando' ? 'A caminho' : 'Previsto'}
                    </span>
                  </td>
                  <td><button type="button" className="fr-link" onClick={() => verLancamentos(r)}>Ver lançamentos <ExternalLink size={11} /></button></td>
                </tr>
              ))}
              {repasses.length === 0 && <tr><td colSpan="7" className="fr-vazio-linha">{carregando ? 'Carregando…' : 'Nenhum repasse com esses filtros.'}</td></tr>}
            </tbody>
          </table>
        </DataTable>
      </section>
    </>
  );
}
const COLUNAS_REPASSE = [
  { rotulo: 'Dia', valor: (r) => dataBr(dataIso(r.data_liberacao)) },
  { rotulo: 'Plataforma', valor: (r) => rotuloPlataforma(r.marketplace) },
  { rotulo: 'Loja', valor: (r) => r.loja_nome || '' },
  { rotulo: 'Para', valor: (r) => DESTINO_SAQUE[r.marketplace] },
  { rotulo: 'Identificador', valor: (r) => r.repasse_id_externo },
  { rotulo: 'Valor', valor: (r) => n(r.valor_liquido) },
  { rotulo: 'Situação', valor: (r) => (r.status === 'pago' ? 'Concluído' : 'A caminho') },
];

// ===========================================================================
// Aba Conferência
// ===========================================================================

function AbaConferencia({ base, versao, contexto }) {
  const fech = useDados('fechamento', base, versao);
  const conc = useDados('conciliacao', base, versao);
  const [abertos, setAbertos] = useState({});
  const [soDivergentes, setSoDivergentes] = useState(true);

  const lojas = fech.dados?.lojas || [];
  const linhas = conc.dados?.linhas || [];
  const linhasVisiveis = soDivergentes ? linhas.filter((l) => l.confere === false) : linhas;

  async function montarRelatorio(tipo) {
    if (!conc.dados) return null;
    return definicaoConferencia({ tipo, dados: conc.dados, linhas, rotuloPlataforma, periodo: contexto.periodo, filtros: contexto.filtros, graficos: [] });
  }

  return (
    <>
      <div className="acoes-relatorio no-print">
        <div className="acoes-relatorio-texto">
          <strong>Relatório de conferência</strong>
          <span>O extrato comparado com a soma dos pedidos, dia a dia.</span>
        </div>
        <BotaoRelatorio montar={montarRelatorio} disabled={!linhas.length} rotulo="Gerar relatório" descricaoResumo="Só os dias que não bateram." descricaoCompleto="Todos os dias comparados." />
      </div>

      <section className="card fr-fechamento">
        <div className="card-head">1. O saldo de cada loja fecha?</div>
        <p className="fr-texto-curto">
          Para cada loja e mês: <strong>saldo no começo + tudo que entrou − tudo que saiu = saldo no fim</strong>.
          Se faltar ou sobrar uma única linha, o mês aparece como <em>não fecha</em>, com a diferença em reais.
        </p>
        {fech.erro && <div className="aviso-compacto tone-prejuizo">{fech.erro}</div>}
        {!fech.dados && <div className="fr-carregando">Conferindo…</div>}
        <div className="fr-fech-lojas">
          {lojas.map((l) => {
            const meses = l.meses.filter((m) => m.linhas > 0 || m.quantidadeRepasses);
            const ruins = meses.filter((m) => m.fechado === false).length;
            const aberto = abertos[l.integracaoId];
            return (
              <div key={l.integracaoId} className={'fr-fech-loja' + (ruins ? ' ruim' : '')}>
                <button type="button" className="fr-fech-cabeca" onClick={() => setAbertos((a) => ({ ...a, [l.integracaoId]: !a[l.integracaoId] }))} aria-expanded={!!aberto}>
                  <ChipPlataforma marketplace={l.marketplace}>{l.loja}</ChipPlataforma>
                  <span className="fr-fech-meses">
                    {meses.length === 0 && <span className="fr-apagado">sem extrato no período</span>}
                    {meses.map((m) => (
                      <span key={m.mes} className={'fr-selo ' + (m.fechado === true ? 'ok' : m.fechado === false ? 'ruim' : 'neutro')}>
                        {m.fechado === true ? <CheckCircle2 size={12} /> : m.fechado === false ? <XCircle size={12} /> : <CircleDashed size={12} />}
                        {mesCurto(m.mes)}{m.fechado === false ? ` · ${brl(m.diferenca)}` : ''}
                      </span>
                    ))}
                  </span>
                  <span className="fr-fech-como">{l.marketplace === 'tiktok_shop' ? 'conferido pelos repasses' : 'conferido pelo saldo'}</span>
                  {aberto ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {aberto && meses.length > 0 && (
                  <DataTable>
                    <table className="data-table fr-tabela fr-tabela-neutra">
                      <thead>
                        <tr>
                          <th>Mês</th>
                          {l.marketplace !== 'tiktok_shop' && <th className="num">Saldo no começo</th>}
                          <th className="num">Liberado (marketplace)</th>
                          <th className="num">Fora do marketplace</th>
                          <th className="num">Saques</th>
                          {l.marketplace !== 'tiktok_shop' ? <th className="num">Saldo no fim</th> : <th className="num">Soma dos repasses</th>}
                          <th>Situação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {meses.map((m) => (
                          <tr key={m.mes}>
                            <td>{mesCurto(m.mes)}</td>
                            {l.marketplace !== 'tiktok_shop' && <td className="num mono">{m.saldoInicial === null ? '—' : brl(m.saldoInicial)}</td>}
                            <td className="num mono">{brl(m.marketplace.total)}</td>
                            <td className="num mono">{brl(m.foraMarketplace.total)}</td>
                            <td className="num mono">{brl(m.saque.total)}</td>
                            <td className="num mono">{l.marketplace !== 'tiktok_shop' ? (m.saldoFinal === null ? '—' : brl(m.saldoFinal)) : brl(m.somaRepasses)}</td>
                            <td>
                              <span className={'fr-situacao ' + (m.fechado === true ? 'ok' : m.fechado === false ? 'ruim' : 'neutro')}>
                                {m.fechado === true ? 'Fecha no centavo' : m.fechado === false ? `Diferença ${brl(m.diferenca)}` : 'Sem dado suficiente'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                )}
              </div>
            );
          })}
        </div>
        <ComoFunciona titulo="O que fazer se um mês não fechar">
          <ol>
            <li>Clique em <strong>Reler o período</strong> lá em cima com o mês escolhido — quase sempre é uma leitura que ficou pela metade.</li>
            <li>Se continuar, a diferença em reais diz o tamanho do problema: uma linha que faltou ou sobrou. Busque na aba Movimentação por um lançamento desse valor.</li>
            <li>A TikTok não informa saldo; ali a conferência é: a soma das linhas de cada repasse tem que dar o valor que a TikTok diz que pagou.</li>
          </ol>
        </ComoFunciona>
      </section>

      <section className="card fr-conciliacao">
        <div className="card-head-linha">
          <div className="card-head">2. O extrato bate com os pedidos?</div>
          <ChipsEscolha valor={soDivergentes ? 'sim' : 'nao'} onChange={(v) => setSoDivergentes(v === 'sim')} opcoes={[{ valor: 'sim', rotulo: 'Só o que não bate' }, { valor: 'nao', rotulo: 'Todos os dias' }]} />
        </div>
        <p className="fr-texto-curto">
          Para cada dia: a venda liberada no extrato comparada com a soma do valor recebido dos pedidos.
          Taxas, Ads e devoluções já estão descontadas dos dois lados — o que sobra na última coluna é o que merece olhar.
        </p>
        {conc.dados && (
          <div className="fr-conc-resumo">
            {(() => {
              const bate = linhas.filter((l) => l.confere === true).length;
              const umLado = conc.dados.diasSemExtrato + conc.dados.diasSemPedidos;
              return (
                <>
                  {bate > 0 && <span className="fr-situacao ok">{plural(bate, 'dia bate', 'dias batem')}</span>}
                  <span className={'fr-situacao ' + (conc.dados.diasDivergentes ? 'ruim' : 'ok')}>
                    {conc.dados.diasDivergentes ? plural(conc.dados.diasDivergentes, 'dia não bate', 'dias não batem') : 'Nenhum dia com diferença'}
                  </span>
                  {umLado > 0 && (
                    <span className="fr-situacao neutro" title="Ou o extrato daquele dia não foi lido, ou não houve pedido com repasse liberado. Não é diferença.">
                      {plural(umLado, 'dia com um lado só', 'dias com um lado só')}
                    </span>
                  )}
                </>
              );
            })()}
          </div>
        )}
        <DataTable>
          <table className="data-table fr-tabela fr-tabela-neutra">
            <thead>
              <tr>
                <th>Dia</th><th>Plataforma</th>
                <th className="num">Venda no extrato</th>
                <th className="num">Pedidos (valor recebido)</th>
                <th className="num">Taxas, Ads e devoluções</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {linhasVisiveis.map((l) => (
                <tr key={`${l.data}-${l.marketplace}`}>
                  <td className="mono">{dataBr(l.data)}</td>
                  <td><ChipPlataforma marketplace={l.marketplace} /></td>
                  <td className="num mono">{l.extratoRepasseVenda === null ? '—' : brl(l.extratoRepasseVenda)}</td>
                  <td className="num mono">{l.pedidosTotal === null ? '—' : brl(l.pedidosTotal)}</td>
                  <td className="num mono">{l.extratoOutros === null ? '—' : brl(l.extratoOutros)}</td>
                  <td>
                    {l.diferencaNaoExplicada === null
                      ? <span className="fr-situacao neutro">{l.extratoTotal === null ? 'Extrato não lido' : 'Sem pedido no dia'}</span>
                      : l.confere
                        ? <span className="fr-situacao ok">Bate</span>
                        : <span className="fr-situacao ruim">Sobra {brl(l.diferencaNaoExplicada)}</span>}
                  </td>
                </tr>
              ))}
              {linhasVisiveis.length === 0 && (
                <tr><td colSpan="6" className="fr-vazio-linha">{conc.carregando ? 'Carregando…' : soDivergentes ? 'Nenhum dia com diferença no período. 🎉' : 'Nada para comparar no período.'}</td></tr>
              )}
            </tbody>
          </table>
        </DataTable>
      </section>
    </>
  );
}
