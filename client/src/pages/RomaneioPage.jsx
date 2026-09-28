import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Truck, ClipboardList, AlertTriangle, RefreshCw, Clock, PackageCheck, Timer, CalendarDays,
  History, Gauge, ChevronDown, Utensils, Scissors, CheckCircle2, XCircle, Search, PackageX,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, CampoBusca, DateInput, Paginacao } from '../components/ui';
import { useTabela } from '../lib/useTabela';
import { formatQtd, plural } from '../lib/format';
import { SeloPlataforma, CanalMarketplace, indiceDeLojas, nomeDaLoja } from '../lib/canalMarketplace';

// "MELI Origem", "Shopee Origem": a casa tem mais de uma loja por plataforma.
const loja = (nome, canal) => nomeDaLoja({ nome, marketplace: canal }, canal);
import RomaneioPapel from '../components/RomaneioPapel';
import '../styles/expedicao.css';

// Marketplace › Romaneio — a expedição do dia (repaginada em 28/09/2026).
//
// A aba estava em desuso porque TODO pedido aparecia atrasado: o "prazo" era
// a entrada do pedido no Hub + um número de horas digitado, e só o romaneio de
// papel parava o relógio. Agora o prazo, a modalidade e a hora em que a
// transportadora pegou o pacote vêm da própria plataforma (migration 0094,
// lib/expedicaoSync.js). Nada é estimado: onde a plataforma não disse, a tela
// diz que ela não disse (REGRA 2).
//
// Sub-abas: Hoje (cartão por loja + pendências), Enviados por dia, Coletas
// (previsto × real), Indicadores (no prazo, ciclo, mapa de horário) e o
// Romaneio de papel, que continua como era.

const BASE = '/romaneios';
const FUSO = 'America/Sao_Paulo';
const mensagem = (e) => e?.data?.error || e?.data?.erro || e?.message || 'Erro inesperado.';

const SUBABAS = [
  { chave: 'hoje', label: 'Hoje', Icone: Clock },
  { chave: 'enviados', label: 'Enviados por dia', Icone: CalendarDays },
  { chave: 'coletas', label: 'Coletas', Icone: History },
  { chave: 'indicadores', label: 'Indicadores', Icone: Gauge },
  { chave: 'papel', label: 'Romaneio de papel', Icone: ClipboardList },
];

const SITUACAO = {
  atrasado: { rotulo: 'Atrasados', curto: 'Atrasado', classe: 'exp-tom-atraso' },
  apertado: { rotulo: 'Vencem hoje', curto: 'Vence hoje', classe: 'exp-tom-hoje' },
  no_prazo: { rotulo: 'No prazo', curto: 'No prazo', classe: 'exp-tom-ok' },
  sem_prazo: { rotulo: 'Sem prazo da plataforma', curto: 'Sem prazo', classe: 'exp-tom-neutro' },
};

const MODALIDADE = { coleta: 'Coleta', agencia: 'Agência', flex: 'Flex', full: 'Full', outro: 'Outro' };
const ETAPA = { a_enviar: 'A preparar', pronto: 'Etiqueta pronta', enviado: 'Enviado', entregue: 'Entregue', cancelado: 'Cancelado' };
const FONTE = { plataforma: 'bipe da transportadora', romaneio: 'romaneio de papel', detectado: 'aproximada: quando o Hub viu' };
const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// ------------------------------------------------------------ hora de Brasília
const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
const fmtDiaIso = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO });
const fmtDiaCurto = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'short', day: '2-digit', month: '2-digit' });

function hora(v) { return v ? fmtHora.format(new Date(v)) : '—'; }
function diaIso(v) { return fmtDiaIso.format(v instanceof Date ? v : new Date(v)); }
function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function diaBr(iso) { const [a, m, d] = String(iso).split('-'); return `${d}/${m}${a ? '' : ''}`; }

// "hoje 14:00", "amanhã 09:00", "ontem 15:42", "sex. 26/09 14:00"
function quando(v, agora = Date.now()) {
  if (!v) return '—';
  const hoje = diaIso(new Date(agora));
  const d = diaIso(v);
  const h = hora(v);
  if (d === hoje) return `hoje ${h}`;
  if (d === somarDias(hoje, 1)) return `amanhã ${h}`;
  if (d === somarDias(hoje, -1)) return `ontem ${h}`;
  return `${fmtDiaCurto.format(new Date(v))} ${h}`;
}

function duracao(min) {
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

function falta(v, agora = Date.now()) {
  if (!v) return null;
  const min = (new Date(v).getTime() - agora) / 60000;
  return min >= 0 ? { texto: `faltam ${duracao(min)}`, atrasado: false, min } : { texto: `atrasado ${duracao(min)}`, atrasado: true, min };
}

// O corte da casa (HH:MM) de hoje como instante.
function corteHoje(hhmm, agora = Date.now()) {
  if (!hhmm) return null;
  return new Date(`${diaIso(new Date(agora))}T${hhmm}:00-03:00`);
}

// ================================================================ página
export default function RomaneioPage() {
  const [params, setParams] = useSearchParams();
  const aba = SUBABAS.some((s) => s.chave === params.get('aba')) ? params.get('aba') : 'hoje';
  const [agora, setAgora] = useState(Date.now());
  const [hoje, setHoje] = useState(null);
  const [pend, setPend] = useState(null);
  const [erro, setErro] = useState('');
  const [sincronizando, setSincronizando] = useState(false);
  const [aviso, setAviso] = useState('');

  useEffect(() => { const t = setInterval(() => setAgora(Date.now()), 30000); return () => clearInterval(t); }, []);

  const carregar = useCallback(async () => {
    setErro('');
    try {
      const [h, p] = await Promise.all([api.get(`${BASE}/expedicao/hoje`), api.get(`${BASE}/expedicao/pendencias`)]);
      setHoje(h); setPend(p);
    } catch (e) { setErro(mensagem(e)); }
  }, []);
  useEffect(() => { carregar(); const t = setInterval(carregar, 5 * 60000); return () => clearInterval(t); }, [carregar]);

  const indiceLojas = useMemo(() => indiceDeLojas((hoje?.cartoes || []).map((c) => ({
    id: c.integracao_id, nome: c.loja, marketplace: c.canal,
  }))), [hoje]);

  async function sincronizar() {
    setSincronizando(true); setAviso(''); setErro('');
    try {
      const r = await api.post(`${BASE}/expedicao/sincronizar`);
      const falhas = (r.lojas || []).filter((l) => l.erro);
      const lidos = (r.lojas || []).reduce((s, l) => s + (l.gravados || 0), 0);
      setAviso(falhas.length
        ? `${plural(lidos, 'pedido relido', 'pedidos relidos')}. Falhou: ${falhas.map((f) => `${f.loja} (${f.erro})`).join('; ')}`
        : `${plural(lidos, 'pedido relido', 'pedidos relidos')} nas plataformas.`);
      await carregar();
    } catch (e) { setErro(mensagem(e)); } finally { setSincronizando(false); }
  }

  function trocarAba(chave) { setParams(chave === 'hoje' ? {} : { aba: chave }, { replace: true }); }

  const atrasados = pend?.resumo?.atrasado || 0;

  return (
    <div className="pagina exp">
      <header className="pagina-topo">
        <div>
          <h1><Truck size={22} /> Expedição</h1>
          <p className="ink-soft">
            Prazo e coleta como a plataforma registra. {hoje && <>Agora: {hora(agora)} · almoço {hoje.almoco.de}–{hoje.almoco.ate}</>}
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn btn-primary" onClick={sincronizar} disabled={sincronizando}>
            <RefreshCw size={15} className={sincronizando ? 'girando' : ''} /> {sincronizando ? 'Lendo as plataformas…' : 'Atualizar das plataformas'}
          </button>
        </div>
      </header>

      <div className="subtab-row">
        {SUBABAS.map((s) => (
          <button key={s.chave} type="button" className={`subtab-btn${aba === s.chave ? ' active' : ''}`} onClick={() => trocarAba(s.chave)}>
            <s.Icone size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
            {s.label}
            {s.chave === 'hoje' && atrasados > 0 && <span className="exp-contador">{atrasados}</span>}
          </button>
        ))}
      </div>

      {erro && <p className="erro-inline">{erro}</p>}
      {aviso && <p className="aviso-inline">{aviso}</p>}

      {aba === 'hoje' && <AbaHoje hoje={hoje} pend={pend} agora={agora} indiceLojas={indiceLojas} aoMudarCorte={carregar} />}
      {aba === 'enviados' && <AbaEnviados agora={agora} indiceLojas={indiceLojas} />}
      {aba === 'coletas' && <AbaColetas />}
      {aba === 'indicadores' && <AbaIndicadores />}
      {aba === 'papel' && <RomaneioPapel pendentesTodos={pend?.itens || []} indiceLojas={indiceLojas} aoMudar={carregar} />}

      <ComoCalcula />
    </div>
  );
}

// ================================================================ Hoje
function AbaHoje({ hoje, pend, agora, indiceLojas, aoMudarCorte }) {
  const [situacao, setSituacao] = useState('');
  const [lojas, setLojas] = useState([]);
  const [busca, setBusca] = useState('');

  const itens = useMemo(() => {
    const alvo = busca.trim().toLowerCase();
    return (pend?.itens || [])
      .filter((i) => !situacao || i.situacao_coleta === situacao)
      .filter((i) => !lojas.length || lojas.includes(i.origem_integracao_id))
      .filter((i) => !alvo || [i.numero, i.origem_pedido_id, i.loja, i.transportadora, (i.codigos_rastreio || []).join(' ')]
        .some((c) => String(c || '').toLowerCase().includes(alvo)));
  }, [pend, situacao, lojas, busca]);

  const tabela = useTabela(itens, { colunas: { prazo: (i) => i.coletar_ate || '9' }, colunaPadrao: null, prefixo: 'exp-pend' });

  if (!hoje || !pend) return <Skeleton height={260} />;

  return (
    <>
      <div className="exp-lojas">
        {hoje.cartoes.map((c) => <CartaoLoja key={c.integracao_id} c={c} agora={agora} />)}
        <div className="exp-loja exp-shein exp-loja-off">
          <div className="exp-loja-topo"><SeloPlataforma chave="shein" size={20} /><strong>Shein</strong></div>
          <div className="exp-loja-num">—</div>
          <p>Sem integração com o Hub ainda.</p>
          {hoje.shein.corte_casa && <p>Corte da casa {hoje.shein.corte_casa}</p>}
        </div>
      </div>

      {hoje.sem_loja?.pendentes > 0 && (
        <p className="aviso-inline">
          <AlertTriangle size={14} /> {plural(hoje.sem_loja.pendentes, 'pedido veio', 'pedidos vieram')} de planilha, sem loja ligada.
          Não dá para perguntar o prazo à plataforma: eles aparecem como “sem prazo”.
        </p>
      )}

      {pend.cancelados_embalados?.length > 0 && (
        <div className="exp-alerta exp-tom-atraso">
          <PackageX size={18} />
          <div>
            <strong>Tirar da mesa: {plural(pend.cancelados_embalados.length, 'pedido cancelado', 'pedidos cancelados')} depois de conferido</strong>
            <p>{pend.cancelados_embalados.map((c) => `${c.origem_pedido_id || c.numero} (${c.loja ? loja(c.loja, c.canal) : c.canal})`).join(' · ')}</p>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head-linha">
          <h2 className="card-titulo"><AlertTriangle size={16} /> Pendências</h2>
          <span className="ink-soft">{plural(pend.resumo.conferidos || 0, 'conferido', 'conferidos')} esperando a coleta</span>
        </div>
        <div className="exp-chips">
          <button type="button" className={`exp-chip${!situacao ? ' ativo' : ''}`} onClick={() => setSituacao('')}>
            Todos <b>{(pend.itens || []).length}</b>
          </button>
          {Object.entries(SITUACAO).map(([k, s]) => (
            <button key={k} type="button" className={`exp-chip ${s.classe}${situacao === k ? ' ativo' : ''}`} onClick={() => setSituacao(situacao === k ? '' : k)}>
              {s.rotulo} <b>{pend.resumo[k] || 0}</b>
            </button>
          ))}
        </div>
        <div className="exp-chips">
          {hoje.cartoes.map((c) => (
            <button
              key={c.integracao_id} type="button"
              className={`exp-chip${lojas.includes(c.integracao_id) ? ' ativo' : ''}`}
              onClick={() => setLojas(lojas.includes(c.integracao_id) ? lojas.filter((x) => x !== c.integracao_id) : [...lojas, c.integracao_id])}
            >
              <SeloPlataforma chave={c.canal} size={13} /> {loja(c.loja, c.canal)}
            </button>
          ))}
          <CampoBusca valor={busca} onChange={setBusca} placeholder="Pedido, loja, rastreio" />
        </div>

        {itens.length === 0 && (
          <EstadoVazio Icone={PackageCheck} titulo="Nada pendente aqui" descricao="Tudo o que a plataforma cobra já saiu, ou o filtro não achou nada." />
        )}
        {itens.length > 0 && (
          <>
            <Paginacao {...tabela} posicao="topo" />
            <div className="tabela-rolagem">
              <table className="tabela-nota exp-tabela">
                <thead>
                  <tr>
                    <th>Pedido</th><th>Loja</th><th>Modalidade</th><th>Na plataforma</th>
                    <th>Conferido</th><th>Prazo da plataforma</th><th>Falta</th>
                  </tr>
                </thead>
                <tbody>
                  {tabela.itensPagina.map((i) => {
                    const f = falta(i.coletar_ate, agora);
                    const s = SITUACAO[i.situacao_coleta] || SITUACAO.sem_prazo;
                    return (
                      <tr key={i.pedido_id}>
                        <td className="mono">{i.origem_pedido_id || i.numero}</td>
                        <td><CanalMarketplace registro={{ origem_marketplace: i.canal, origem_integracao_id: i.origem_integracao_id }} indiceLojas={indiceLojas} /></td>
                        <td>{i.modalidade ? <span className="exp-tag">{MODALIDADE[i.modalidade]}</span> : <span className="ink-faint">—</span>}</td>
                        <td title={[i.status_plataforma, i.substatus_plataforma].filter(Boolean).join(' / ')}>
                          {ETAPA[i.etapa] || <span className="ink-faint">não consultado</span>}
                          {i.pronto_ate && i.etapa === 'a_enviar' && <div className="ink-faint">etiqueta até {quando(i.pronto_ate, agora)}</div>}
                        </td>
                        <td>{i.conferido_em ? <span className="exp-ok"><CheckCircle2 size={13} /> {hora(i.conferido_em)}</span> : <span className="ink-faint">não bipado</span>}</td>
                        <td>{i.coletar_ate ? quando(i.coletar_ate, agora) : <span className="ink-faint" title={i.motivo_sem_prazo || ''}>{i.motivo_sem_prazo || 'não informado'}</span>}</td>
                        <td>{f ? <span className={`exp-pilula ${s.classe}`}>{f.texto}</span> : <span className={`exp-pilula ${s.classe}`}>{s.curto}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Paginacao {...tabela} posicao="rodape" />
          </>
        )}
      </div>

      <CortesDaCasa cortes={hoje.cortes} aoMudar={aoMudarCorte} />
    </>
  );
}

function CartaoLoja({ c, agora }) {
  const corte = corteHoje(c.corte_casa, agora);
  const faltaCorte = corte ? falta(corte, agora) : null;
  const passou = c.passou_hoje;
  return (
    <div className={`exp-loja exp-${c.canal}`}>
      <div className="exp-loja-topo">
        <SeloPlataforma chave={c.canal} size={20} />
        <strong>{loja(c.loja, c.canal)}</strong>
        {c.alerta_almoco && <span className="exp-selo-almoco" title="A coleta costuma cair na hora do almoço (ninguém para atender)"><Utensils size={12} /> almoço</span>}
      </div>
      <div className="exp-loja-num">{c.pendentes}<small> para sair</small></div>
      <div className="exp-loja-chips">
        {c.atrasados > 0 && <span className="exp-pilula exp-tom-atraso">{c.atrasados} atrasado{c.atrasados > 1 ? 's' : ''}</span>}
        {c.vencem_hoje > 0 && <span className="exp-pilula exp-tom-hoje">{c.vencem_hoje} vence{c.vencem_hoje > 1 ? 'm' : ''} hoje</span>}
        {c.sem_prazo > 0 && <span className="exp-pilula exp-tom-neutro">{c.sem_prazo} sem prazo</span>}
      </div>
      <dl className="exp-loja-dl">
        <dt><Timer size={12} /> Próximo prazo</dt>
        <dd>{c.proximo_prazo ? quando(c.proximo_prazo, agora) : '—'}</dd>
        <dt><Scissors size={12} /> Corte da casa</dt>
        <dd>{c.corte_casa ? <>{c.corte_casa}{faltaCorte && <em> · {faltaCorte.atrasado ? 'passou' : faltaCorte.texto.replace('faltam ', 'em ')}</em>}</> : '—'}</dd>
        <dt><Truck size={12} /> Coleta prevista</dt>
        <dd>
          {c.agenda_hoje?.de ? `${c.agenda_hoje.de}–${c.agenda_hoje.ate} (plataforma)`
            : c.agenda_trabalha_hoje === false ? 'sem coleta hoje (plataforma)'
              : c.horario_tipico ? `costuma passar ${c.horario_tipico}` : 'ainda sem histórico'}
        </dd>
        <dt><CheckCircle2 size={12} /> Coleta passou</dt>
        <dd>
          {passou ? <>hoje {passou.primeira}{passou.ultima !== passou.primeira ? `–${passou.ultima}` : ''} · {plural(passou.pacotes, 'pacote')}</>
            : <>ainda não hoje{c.passou_ultima ? <em> · última {diaBr(c.passou_ultima.dia)} {c.passou_ultima.primeira}</em> : ''}</>}
        </dd>
      </dl>
      <div className="exp-loja-rodape">
        <span>{plural(c.enviados_hoje, 'enviado', 'enviados')} hoje</span>
        {c.conferidos_esperando > 0 && <span>{c.conferidos_esperando} conferido{c.conferidos_esperando > 1 ? 's' : ''} na mesa</span>}
      </div>
      {c.sync?.ultimo_erro && <p className="exp-loja-erro" title={c.sync.ultimo_erro}><XCircle size={12} /> Falha ao ler a plataforma</p>}
      {!c.sync?.ultima_execucao && <p className="exp-loja-erro"><Clock size={12} /> Ainda não lida: clique em “Atualizar das plataformas”</p>}
    </div>
  );
}

function CortesDaCasa({ cortes, aoMudar }) {
  const [editando, setEditando] = useState({});
  const [erro, setErro] = useState('');
  async function salvar(canal) {
    setErro('');
    try { await api.put(`${BASE}/prazos/${canal}`, { horario_corte: editando[canal] }); setEditando({ ...editando, [canal]: undefined }); aoMudar?.(); }
    catch (e) { setErro(mensagem(e)); }
  }
  const canais = ['mercado_livre', 'tiktok_shop', 'shein', 'shopee'];
  return (
    <div className="card">
      <h2 className="card-titulo"><Scissors size={16} /> Corte da casa</h2>
      <p className="ink-soft">A hora em que a expedição fecha cada canal no dia. É meta da casa, não o prazo da plataforma.</p>
      {erro && <p className="erro-inline">{erro}</p>}
      <div className="exp-cortes">
        {canais.map((k) => (
          <label key={k} className="exp-corte">
            <SeloPlataforma chave={k} size={16} />
            <input
              type="time" value={editando[k] ?? cortes?.[k] ?? ''}
              onChange={(e) => setEditando({ ...editando, [k]: e.target.value })}
              onBlur={() => editando[k] !== undefined && editando[k] !== cortes?.[k] && salvar(k)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

// ================================================================ Enviados
function AbaEnviados({ agora, indiceLojas }) {
  const [dia, setDia] = useState(diaIso(new Date()));
  const [dados, setDados] = useState(null);
  const [lojas, setLojas] = useState([]);
  const [erro, setErro] = useState('');
  useEffect(() => {
    setDados(null); setErro('');
    api.get(`${BASE}/expedicao/enviados?dia=${dia}`).then(setDados).catch((e) => setErro(mensagem(e)));
  }, [dia]);
  const itens = useMemo(() => (dados?.itens || []).filter((i) => !lojas.length || lojas.includes(i.origem_integracao_id)), [dados, lojas]);
  const tabela = useTabela(itens, { colunas: { saiu: (i) => i.saiu_em }, colunaPadrao: null, prefixo: 'exp-env' });
  const hojeIso = diaIso(new Date(agora));
  const maxHora = Math.max(1, ...(dados?.por_hora || [0]));

  return (
    <>
      <div className="exp-barra">
        <div className="exp-chips">
          <button type="button" className={`exp-chip${dia === hojeIso ? ' ativo' : ''}`} onClick={() => setDia(hojeIso)}>Hoje</button>
          <button type="button" className={`exp-chip${dia === somarDias(hojeIso, -1) ? ' ativo' : ''}`} onClick={() => setDia(somarDias(hojeIso, -1))}>Ontem</button>
          <DateInput value={dia} onChange={(e) => e.target.value && setDia(e.target.value)} />
        </div>
        {dados && <strong>{plural(dados.total, 'pedido enviado', 'pedidos enviados')} em {diaBr(dia)}</strong>}
      </div>
      {erro && <p className="erro-inline">{erro}</p>}
      {!dados && !erro && <Skeleton height={220} />}
      {dados && (
        <>
          <div className="exp-resumo-lojas">
            {dados.por_loja.map((l) => (
              <button
                key={l.integracao_id} type="button"
                className={`exp-resumo exp-${l.canal}${lojas.includes(l.integracao_id) ? ' ativo' : ''}`}
                onClick={() => setLojas(lojas.includes(l.integracao_id) ? lojas.filter((x) => x !== l.integracao_id) : [...lojas, l.integracao_id])}
              >
                <span className="exp-resumo-topo"><SeloPlataforma chave={l.canal} size={16} /> {loja(l.loja, l.canal)}</span>
                <span className="exp-resumo-num">{l.total}</span>
                <span>{l.passagem ? `coleta passou ${l.passagem.primeira}${l.passagem.ultima !== l.passagem.primeira ? `–${l.passagem.ultima}` : ''}` : 'sem bipe de coleta'}</span>
                {l.janela_prevista?.de && <span>janela {l.janela_prevista.de}–{l.janela_prevista.ate}</span>}
                <span>{l.no_prazo} no prazo{l.fora_do_prazo ? ` · ${l.fora_do_prazo} fora` : ''}</span>
                {l.sem_conferencia > 0 && <span className="exp-atencao">{l.sem_conferencia} saíram sem conferência</span>}
                {l.alerta_almoco && <span className="exp-atencao"><Utensils size={11} /> coleta no almoço</span>}
              </button>
            ))}
          </div>

          <div className="card">
            <h2 className="card-titulo"><Clock size={16} /> Saída por hora</h2>
            <div className="exp-horas">
              {dados.por_hora.map((n, h) => (
                <div key={h} className="exp-hora" title={`${String(h).padStart(2, '0')}h: ${n}`}>
                  <span className="exp-hora-barra" style={{ height: `${(n / maxHora) * 100}%` }}>{n > 0 && <b>{n}</b>}</span>
                  <small>{h}</small>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2 className="card-titulo"><Truck size={16} /> Pedidos enviados</h2>
            {itens.length === 0 && <EstadoVazio Icone={Truck} titulo="Nenhum envio registrado" descricao="A plataforma não registrou saída neste dia." />}
            {itens.length > 0 && (
              <>
                <Paginacao {...tabela} posicao="topo" />
                <div className="tabela-rolagem">
                  <table className="tabela-nota exp-tabela">
                    <thead><tr><th>Saiu às</th><th>Pedido</th><th>Loja</th><th>Modalidade</th><th>Conferido</th><th>Prazo</th><th>No prazo?</th><th>Rastreio</th></tr></thead>
                    <tbody>
                      {tabela.itensPagina.map((i) => (
                        <tr key={i.pedido_id}>
                          <td title={FONTE[i.fonte]}>{hora(i.saiu_em)}{i.fonte === 'detectado' && <span className="ink-faint"> ≈</span>}</td>
                          <td className="mono">{i.origem_pedido_id || i.numero}</td>
                          <td><CanalMarketplace registro={{ origem_marketplace: i.canal, origem_integracao_id: i.origem_integracao_id }} indiceLojas={indiceLojas} /></td>
                          <td>{i.modalidade ? MODALIDADE[i.modalidade] : '—'}</td>
                          <td>{i.conferido_em ? hora(i.conferido_em) : <span className="exp-atencao">sem conferência</span>}</td>
                          <td>{i.despachar_ate ? quando(i.despachar_ate, agora) : '—'}</td>
                          <td>{i.no_prazo === true ? <span className="exp-pilula exp-tom-ok">sim</span> : i.no_prazo === false ? <span className="exp-pilula exp-tom-atraso">não</span> : '—'}</td>
                          <td className="mono">{i.rastreio || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Paginacao {...tabela} posicao="rodape" />
              </>
            )}
            <p className="ink-faint exp-nota">≈ hora aproximada: a plataforma disse “enviado” sem dizer a hora (ex.: postado em agência).</p>
          </div>
        </>
      )}
    </>
  );
}

// ================================================================ Coletas
const SIT_COLETA = {
  na_janela: { t: 'Na janela', c: 'exp-tom-ok' },
  depois: { t: 'Depois da janela', c: 'exp-tom-hoje' },
  antes: { t: 'Antes da janela', c: 'exp-tom-hoje' },
  nao_passou: { t: 'Não passou', c: 'exp-tom-atraso' },
  aguardando: { t: 'Aguardando', c: 'exp-tom-neutro' },
  sem_janela: { t: 'Sem janela da plataforma', c: 'exp-tom-neutro' },
};

function AbaColetas() {
  const [dias, setDias] = useState(14);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    setDados(null);
    api.get(`${BASE}/expedicao/coletas?dias=${dias}`).then(setDados).catch((e) => setErro(mensagem(e)));
  }, [dias]);
  const noAlmoco = (dados?.linhas || []).filter((l) => l.alerta_almoco).length;
  return (
    <div className="card">
      <div className="card-head-linha">
        <h2 className="card-titulo"><History size={16} /> Quando a coleta passou</h2>
        <div className="exp-chips">
          {[7, 14, 30].map((n) => <button key={n} type="button" className={`exp-chip${dias === n ? ' ativo' : ''}`} onClick={() => setDias(n)}>{n} dias</button>)}
        </div>
      </div>
      <p className="ink-soft">A hora é o primeiro e o último bipe da transportadora nos pacotes de coleta daquele dia. A janela é a que a plataforma divulga (hoje, só o Mercado Livre divulga).</p>
      {noAlmoco > 0 && <p className="aviso-inline"><Utensils size={14} /> {plural(noAlmoco, 'coleta caiu', 'coletas caíram')} no horário de almoço (12:00–13:15) neste período.</p>}
      {erro && <p className="erro-inline">{erro}</p>}
      {!dados && !erro && <Skeleton height={200} />}
      {dados && dados.linhas.length === 0 && <EstadoVazio Icone={Truck} titulo="Sem coletas registradas" descricao="Assim que as plataformas registrarem as saídas, o histórico aparece aqui." />}
      {dados && dados.linhas.length > 0 && (
        <div className="tabela-rolagem">
          <table className="tabela-nota exp-tabela">
            <thead><tr><th>Dia</th><th>Loja</th><th>Janela prevista</th><th>Passou</th><th>Último bipe</th><th className="num">Pacotes</th><th>Situação</th></tr></thead>
            <tbody>
              {dados.linhas.map((l) => (
                <tr key={`${l.dia}-${l.integracao_id}`}>
                  <td>{DIAS_SEMANA[l.dia_semana]} {diaBr(l.dia)}</td>
                  <td><SeloPlataforma chave={l.canal} size={14} /> {loja(l.loja, l.canal)}</td>
                  <td>{l.janela?.de ? `${l.janela.de}–${l.janela.ate}` : '—'}</td>
                  <td><strong>{l.passou || '—'}</strong>{l.alerta_almoco && <span className="exp-selo-almoco inline"><Utensils size={11} /> almoço</span>}</td>
                  <td>{l.ultimo_bipe || '—'}</td>
                  <td className="num">{l.pacotes || '—'}</td>
                  <td><span className={`exp-pilula ${SIT_COLETA[l.situacao]?.c}`}>{SIT_COLETA[l.situacao]?.t}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ================================================================ Indicadores
function AbaIndicadores() {
  const [dias, setDias] = useState(30);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    setDados(null);
    api.get(`${BASE}/expedicao/indicadores?dias=${dias}`).then(setDados).catch((e) => setErro(mensagem(e)));
  }, [dias]);
  const maxMapa = Math.max(1, ...((dados?.mapa_entrada || []).flat()));
  const min = (m) => (m === null || m === undefined ? '—' : duracao(m));

  return (
    <>
      <div className="exp-barra">
        <div className="exp-chips">
          {[7, 30, 90].map((n) => <button key={n} type="button" className={`exp-chip${dias === n ? ' ativo' : ''}`} onClick={() => setDias(n)}>{n} dias</button>)}
        </div>
      </div>
      {erro && <p className="erro-inline">{erro}</p>}
      {!dados && !erro && <Skeleton height={240} />}
      {dados && (
        <>
          <div className="exp-resumo-lojas">
            {dados.por_loja.length === 0 && <EstadoVazio Icone={Gauge} titulo="Sem envios no período" descricao="Os indicadores aparecem quando as plataformas registrarem as saídas." />}
            {dados.por_loja.map((l) => {
              const pct = l.com_prazo ? Math.round((l.no_prazo / l.com_prazo) * 1000) / 10 : null;
              return (
                <div key={l.origem_integracao_id} className={`exp-resumo exp-${l.canal} exp-ind`}>
                  <span className="exp-resumo-topo"><SeloPlataforma chave={l.canal} size={16} /> {loja(l.loja, l.canal)}</span>
                  <span className="exp-resumo-num">{pct === null ? '—' : `${pct.toLocaleString('pt-BR')}%`}</span>
                  <span>enviados no prazo ({l.no_prazo} de {l.com_prazo})</span>
                  <span className="exp-ciclo">
                    <i>Pago → conferido <b>{min(l.min_pago_conferido)}</b></i>
                    <i>Conferido → coletado <b>{min(l.min_conferido_enviado)}</b></i>
                    <i>Pago → coletado <b>{min(l.min_pago_enviado)}</b></i>
                  </span>
                  <span>{[l.m_coleta && `${l.m_coleta} coleta`, l.m_agencia && `${l.m_agencia} agência`, l.m_flex && `${l.m_flex} Flex`, l.m_outro && `${l.m_outro} outro`].filter(Boolean).join(' · ')}</span>
                  {l.sem_conferencia > 0 && <span className="exp-atencao">{l.sem_conferencia} de {l.enviados} saíram sem conferência</span>}
                </div>
              );
            })}
          </div>

          <div className="card">
            <h2 className="card-titulo"><CalendarDays size={16} /> Pedidos que entram, por dia e hora</h2>
            <p className="ink-soft">Últimas {dados.semanas_mapa} semanas, pela hora do pagamento. Serve para escalar gente no pico.</p>
            <div className="exp-mapa">
              <span />
              {Array.from({ length: 24 }, (_, h) => <small key={h}>{h}</small>)}
              {dados.mapa_entrada.map((linha, d) => (
                [<small key={`d${d}`}>{DIAS_SEMANA[d]}</small>,
                  ...linha.map((n, h) => (
                    <span key={`${d}-${h}`} className={`exp-mapa-cel${n / maxMapa > 0.5 ? ' forte' : ''}`} title={`${DIAS_SEMANA[d]} ${h}h: ${n}`} style={{ '--i': n / maxMapa }}>{n > 0 ? n : ''}</span>
                  ))]
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ================================================================ explicação
function ComoCalcula() {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="card exp-como">
      <button type="button" className="exp-como-btn" onClick={() => setAberto(!aberto)}>
        <Search size={14} /> Como esta tela calcula <ChevronDown size={14} className={aberto ? 'virado' : ''} />
      </button>
      {aberto && (
        <ul>
          <li><b>Prazo</b>: o que a plataforma exige para o pacote sair. Mercado Livre: prazo de despacho do envio (o mesmo da reputação). Shopee: <i>ship by date</i>. TikTok: prazo da coleta (ou do envio; sem nenhum dos dois, o da etiqueta).</li>
          <li><b>Coleta passou</b>: o primeiro bipe da transportadora nos pacotes de coleta do dia (ML <i>date_shipped</i>, Shopee <i>pickup done</i>, TikTok <i>collection time</i>).</li>
          <li><b>Coleta prevista</b>: a janela que o Mercado Livre divulga para a conta. Sem janela, a mediana do horário real dos últimos 14 dias.</li>
          <li><b>Atrasado</b>: passou do prazo da plataforma e ela ainda não registrou a saída. <b>Vence hoje</b>: o prazo é hoje. Pedido que a plataforma não informou fica em <b>sem prazo</b>. O sistema não chuta.</li>
          <li><b>Conferido</b>: a hora em que a caixa foi bipada na Conferência.</li>
          <li>As plataformas são relidas a cada 5 minutos. O botão “Atualizar das plataformas” relê na hora. Pedidos do Full ficam de fora: quem despacha é a plataforma.</li>
        </ul>
      )}
    </div>
  );
}
