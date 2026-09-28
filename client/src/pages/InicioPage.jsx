import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Printer, ScanLine, Barcode, Timer, Factory, Sparkles, MessageSquareWarning, Store,
  ReceiptText, Inbox, PackageCheck, ClipboardList, ChevronRight, RefreshCw, CircleCheck,
  CalendarDays, Clock, TriangleAlert, ArrowRight,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { canAccessPath, moduloDaRota } from '../lib/modules';
import '../styles/inicio.css';

// Início (28/09/2026) — o dia de quem está logado, por setor.
//
// Padrão copiado do painel do Tempestivo, que o dono aprovou: saudação pela
// hora + primeiro nome; UMA linha com o que o dia pede, cada pedaço um link;
// um cartão "Próximo" com contagem regressiva; os cartões que pedem ação; e
// a coluna "Hoje" com o marcador de agora. O QUE aparece depende do setor
// (módulos liberados) — quem decide é o servidor (/api/inicio). A tela só
// desenha.

const ICONES = {
  printer: Printer, scan: ScanLine, barcode: Barcode, timer: Timer, factory: Factory, sparkles: Sparkles,
  message: MessageSquareWarning, store: Store, receipt: ReceiptText, inbox: Inbox, package: PackageCheck, clipboard: ClipboardList,
};
const FUSO = 'America/Sao_Paulo';

function agoraBrasilia(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  return { h, hm: `${String(h).padStart(2, '0')}:${p.minute}` };
}
function saudacao(h) { return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; }
function dataLonga(d) {
  const t = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function quandoTexto(p, agora) {
  if (p.quando) {
    const min = Math.max(0, Math.round((new Date(p.quando) - agora) / 60000));
    if (min < 1) return 'agora';
    if (min < 60) return `em ${min} min`;
    const h = Math.floor(min / 60); const m = min % 60;
    return `em ${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}`;
  }
  if (!p.dia) return '';
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(agora);
  const dias = Math.round((new Date(`${p.dia}T12:00:00Z`) - new Date(`${hoje}T12:00:00Z`)) / 86400000);
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'amanhã';
  const t = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(`${p.dia}T12:00:00Z`));
  return `${t.replace('.', '')} · em ${dias} dias`;
}

// Link só quando a pessoa pode abrir a tela de destino; senão, texto.
function Destino({ user, rota, className, children, ...resto }) {
  const pode = rota && canAccessPath(user, rota.split('?')[0]);
  if (!pode) return <span className={className} {...resto}>{children}</span>;
  return <Link to={rota} className={className} {...resto}>{children}</Link>;
}

function IconeDoModulo({ rota, size = 16 }) {
  const mod = moduloDaRota(rota);
  const Icon = mod?.icon || CalendarDays;
  return <Icon size={size} />;
}

export default function InicioPage() {
  const { user } = useAuth();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [agora, setAgora] = useState(() => new Date());

  const carregar = useCallback(async (forcar = false) => {
    setCarregando(true);
    try {
      setDados(await api.get(`/inicio${forcar ? '?forcar=1' : ''}`));
      setErro('');
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);
  // Relógio da tela (saudação, "em 40 min", marcador de agora) a cada 30 s;
  // os números voltam do servidor a cada 5 min.
  useEffect(() => {
    const t1 = setInterval(() => setAgora(new Date()), 30000);
    const t2 = setInterval(() => carregar(), 5 * 60000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [carregar]);

  const { h, hm } = agoraBrasilia(agora);
  const nome = dados?.nome ?? (user?.nome || '').trim().split(/\s+/)[0];

  // "Hoje": com hora, e o marcador de agora entre o que passou e o que vem.
  const linhaHoje = useMemo(() => {
    if (!dados) return [];
    const itens = [];
    let pos = false;
    for (const it of dados.hojeComHora) {
      if (!pos && it.hora >= hm) { itens.push({ agora: true }); pos = true; }
      itens.push({ ...it, passou: it.hora < hm });
    }
    if (dados.hojeComHora.length && !pos) itens.push({ agora: true });
    return itens;
  }, [dados, hm]);

  return (
    <div className="page-wide inicio">
      <section className="inicio-hello">
        <div className="inicio-hello-t">
          <div className="inicio-data">{dataLonga(agora)}{dados?.setor && <span className="inicio-setor">{dados.setor}</span>}</div>
          <h1>{saudacao(h)}{nome ? `, ${nome}` : ''}</h1>
          {!dados && !erro && <div className="inicio-resumo"><span className="inicio-esqueleto" /></div>}
          {dados && (
            <div className="inicio-resumo" aria-label="Resumo do dia">
              {dados.resumo.length ? dados.resumo.map((r) => (
                <span key={r.texto} className={`tom-${r.tom}`}>
                  <Destino user={user} rota={r.rota}>{r.texto}</Destino>
                </span>
              )) : <span><span>Nada pendente para hoje. Bom trabalho.</span></span>}
            </div>
          )}
          {erro && <div className="inicio-resumo"><span><span>Não consegui montar o resumo agora ({erro}).</span></span></div>}
          {dados?.atalhos?.length > 0 && (
            <div className="inicio-atalhos">
              {dados.atalhos.filter((a) => canAccessPath(user, a.rota)).map((a, i) => {
                const Icon = ICONES[a.icone] || ArrowRight;
                return <Link key={a.rota} to={a.rota} className={'inicio-btn' + (i === 0 ? ' pri' : '')}><Icon size={15} />{a.rotulo}</Link>;
              })}
            </div>
          )}
        </div>
        {dados?.proximo && (
          <Destino user={user} rota={dados.proximo.rota} className="inicio-proximo">
            <small>{dados.proximo.rotulo}</small>
            <b>{dados.proximo.hora && <span className="mono">{dados.proximo.hora}</span>}{dados.proximo.hora && ' · '}{dados.proximo.titulo}</b>
            <span>
              <em>{quandoTexto(dados.proximo, agora)}</em>
              {dados.proximo.detalhe ? ` · ${dados.proximo.detalhe}` : ''}
            </span>
          </Destino>
        )}
      </section>

      {dados && dados.acoes.length > 0 && (
        <>
          <div className="inicio-rotulo">Pede ação</div>
          <div className="inicio-acoes">
            {dados.acoes.map((a) => {
              const mod = moduloDaRota(a.rota);
              return (
                <Destino key={a.chave} user={user} rota={a.rota} className={`inicio-acao tom-${a.tom}`} style={{ '--cor-mod': mod?.color || 'var(--mod-calendario)' }}>
                  <span className="inicio-acao-ic"><IconeDoModulo rota={a.rota} size={17} /></span>
                  <span className="inicio-acao-corpo">
                    <span className="inicio-acao-lbl"><span>{a.rotulo}</span>{a.tom === 'urgente' && <i className="inicio-selo">urgente</i>}</span>
                    <b className="mono">{a.valor}</b>
                    <small>{a.sub}</small>
                  </span>
                  <ChevronRight size={15} className="inicio-seta" />
                </Destino>
              );
            })}
          </div>
        </>
      )}

      {dados && (
        <div className="inicio-split">
          <section className="card inicio-card">
            <div className="inicio-card-h"><span className="inicio-eyeb">Hoje</span><h3>{dataLonga(agora).split(',')[0]}</h3></div>
            <div className="inicio-dia">
              {linhaHoje.map((it, i) => (it.agora
                ? <div key={`agora-${i}`} className="inicio-agora"><span>{hm}</span></div>
                : (
                  <Destino key={`${it.titulo}-${i}`} user={user} rota={it.rota} className={'inicio-it' + (it.passou ? ' passou' : '') + ` tom-${it.tom}`} style={{ '--cor-mod': moduloDaRota(it.rota)?.color }}>
                    <span className="inicio-it-h mono">{it.hora}</span>
                    <span className="inicio-it-b"><b>{it.titulo}</b><small>{it.sub}</small></span>
                  </Destino>
                )))}
              {dados.hojeSemHora.length > 0 && <div className="inicio-grp">Sem horário</div>}
              {dados.hojeSemHora.map((it, i) => (
                <Destino key={`s-${it.titulo}-${i}`} user={user} rota={it.rota} className={`inicio-it tom-${it.tom}`} style={{ '--cor-mod': moduloDaRota(it.rota)?.color || 'var(--mod-calendario)' }}>
                  <span className="inicio-it-h"><IconeDoModulo rota={it.rota} size={14} /></span>
                  <span className="inicio-it-b"><b>{it.titulo}</b><small>{it.sub}</small></span>
                </Destino>
              ))}
              {!linhaHoje.length && !dados.hojeSemHora.length && (
                <div className="inicio-vazio"><Clock size={18} /><b>Nada marcado para hoje.</b></div>
              )}
            </div>
          </section>

          <section className="card inicio-card">
            <div className="inicio-card-h"><span className="inicio-eyeb">Ficou para trás</span><h3>Atrasados</h3></div>
            <div className="inicio-lista">
              {dados.ficouParaTras.length ? dados.ficouParaTras.map((it, i) => (
                <Destino key={`t-${it.titulo}-${i}`} user={user} rota={it.rota} className="inicio-li">
                  <TriangleAlert size={15} className="inicio-li-ic" />
                  <span><b>{it.titulo}</b><small>{it.sub}</small></span>
                  <ChevronRight size={14} />
                </Destino>
              )) : <div className="inicio-vazio"><CircleCheck size={18} /><b>Nada atrasado.</b><span>Tudo em dia.</span></div>}
            </div>
            {dados.emDia.length > 0 && (
              <div className="inicio-emdia">
                <span className="inicio-eyeb">Em dia</span>
                {dados.emDia.map((o) => (
                  <Destino key={o.titulo} user={user} rota={o.rota} className="inicio-emdia-chip"><CircleCheck size={12} />{o.titulo}</Destino>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {dados && (
        <div className="inicio-rodape">
          {dados.semDado.length > 0 && (
            <span title={dados.semDado.map((s) => s.motivo).join('\n')}>Sem dado em {dados.semDado.length === 1 ? '1 frente' : `${dados.semDado.length} frentes`} — passe o mouse para ver o motivo. </span>
          )}
          <span>Atualizado às {agoraBrasilia(new Date(dados.geradoEm)).hm}</span>
          <button type="button" className="inicio-atualizar" onClick={() => carregar(true)} disabled={carregando}>
            <RefreshCw size={13} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      )}
    </div>
  );
}
