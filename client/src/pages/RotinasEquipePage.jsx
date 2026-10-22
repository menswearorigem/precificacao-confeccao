import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  Plus, RefreshCw, TriangleAlert, ShieldCheck, Clock, X, Camera, Zap, CalendarClock, Check, ChevronRight, Users, BarChart3, Sun, Loader2,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import Gaveta from '../components/Gaveta';
import RotinaTarefa from '../components/RotinaTarefa';
import { Avatar, CartaoEvento, LinhaGrupo, Vazio } from '../components/RotinaCartoes';
import {
  situacaoDe, prazoTexto, diaCurto, horaDe, diaLongo, agruparPorRotina, terminada, NOME_SETOR,
} from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Equipe — refeita em 21/10/2026 ("muito embaralhado"). Uma pessoa
// por vez (ou todos) e quatro abas, cada uma com UM trabalho:
//   · Conferir   — o que a equipe entregou e espera aprovação;
//   · Atrasadas  — o que passou do horário;
//   · Hoje       — um quadro por pessoa, com as rotinas do dia (vários
//                  horários juntos num item só);
//   · Desempenho — % no prazo por pessoa e por rotina, e o histórico.
// Só administrador.

const ABAS = [
  ['conferir', 'Conferir', ShieldCheck],
  ['atrasadas', 'Atrasadas', TriangleAlert],
  ['hoje', 'Hoje', Sun],
  ['desempenho', 'Desempenho', BarChart3],
];
// Links antigos (sino, Início) usavam ?painel=.
const PAINEL_PARA_ABA = { conferir: 'conferir', atrasadas: 'atrasadas', problema: 'hoje' };

function tempoDesde(iso, agora = new Date()) {
  const min = Math.max(0, Math.round((agora - new Date(iso)) / 60000));
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

export default function RotinasEquipePage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const pessoa = params.get('pessoa') || '';
  const modelo = params.get('modelo') || '';
  const produto = params.get('produto') || '';
  const periodo = params.get('periodo') || '7';
  const abaUrl = params.get('aba') || PAINEL_PARA_ABA[params.get('painel')] || '';
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [aberta, setAberta] = useState(null);
  const [aprovando, setAprovando] = useState(null);
  const location = useLocation();
  const [aviso, setAviso] = useState(location.state?.aviso || '');

  const mudar = (mudancas) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.delete('painel');
    for (const [k, v] of Object.entries(mudancas)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true });

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const q = new URLSearchParams({ periodo });
      if (produto) q.set('produto', produto);
      if (modelo) q.set('modelo', modelo);
      setDados(await api.get(`/rotinas/equipe?${q}`));
      setErro('');
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, [periodo, produto, modelo]);
  useEffect(() => { carregar(); }, [carregar]);

  const daPessoa = useCallback((x) => !pessoa
    || String(x.responsavelId || '') === pessoa
    || (!x.responsavelId && (x.grupo || []).map(String).includes(pessoa)), [pessoa]);

  const itens = useMemo(() => (dados?.itens || []).filter(daPessoa), [dados, daPessoa]);
  const conferir = useMemo(() => itens.filter((x) => x.status === 'aguardando_conferencia')
    .sort((a, b) => new Date(a.concluidaEm) - new Date(b.concluidaEm)), [itens]);
  const atrasadas = useMemo(() => itens.filter((x) => x.atrasada).sort((a, b) => new Date(a.prazo) - new Date(b.prazo)), [itens]);
  const deHoje = useMemo(() => itens.filter((x) => x.data === dados?.hoje), [itens, dados]);

  // Aba padrão: a que pede ação.
  const aba = abaUrl || (conferir.length ? 'conferir' : atrasadas.length ? 'atrasadas' : 'hoje');

  // Quadro "Hoje": um bloco por pessoa + um das compartilhadas ainda livres.
  const quadro = useMemo(() => {
    if (!dados) return [];
    const blocos = new Map();
    const bloco = (id, nome) => {
      if (!blocos.has(id)) blocos.set(id, { id, nome, itens: [] });
      return blocos.get(id);
    };
    for (const p of dados.equipe) if (!pessoa || String(p.id) === pessoa) bloco(p.id, p.nome);
    for (const x of deHoje) {
      // Compartilhada fica no bloco da equipe mesmo depois que alguém pegou —
      // assim os horários da mesma rotina não se espalham entre pessoas.
      if (x.responsavelId && !x.compartilhada) bloco(x.responsavelId, x.responsavelNome).itens.push(x);
      else bloco(0, 'Equipe (compartilhadas)').itens.push(x);
    }
    return [...blocos.values()].map((b) => {
      const grupos = agruparPorRotina(b.itens);
      const total = b.itens.length;
      const feitas = b.itens.filter((x) => terminada(x.status)).length;
      return { ...b, grupos, total, feitas, atrasadas: b.itens.filter((x) => x.atrasada).length };
    })
      // Sem filtro, quem não tem nada hoje some (menos ruído); quem tem
      // atraso vem primeiro; a equipe compartilhada fecha a lista.
      .filter((b) => b.total > 0 || pessoa)
      .sort((a, b) => (a.id === 0) - (b.id === 0) || (b.atrasadas > 0) - (a.atrasadas > 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [dados, deHoje, pessoa]);

  const eventos = useMemo(() => (dados?.eventos || []).filter((ev) => !pessoa || ev.responsaveis.map(String).includes(pessoa)), [dados, pessoa]);

  async function aprovarRapido(x) {
    setAprovando(x.id);
    try {
      await api.post(`/rotinas/ocorrencias/${x.id}/aprovar`, {});
      setAviso(`"${x.titulo}" de ${x.concluidaPorNome || x.responsavelNome || 'equipe'} aprovada.`);
      await carregar();
    } catch (e) { setErro(e.message); } finally { setAprovando(null); }
  }

  if (user?.role !== 'admin') return <div className="page"><p>Esta tela é só de administrador.</p></div>;

  const nomePessoa = dados?.equipe.find((p) => String(p.id) === pessoa)?.nome;
  const contagem = { conferir: conferir.length, atrasadas: atrasadas.length, hoje: deHoje.filter((x) => !terminada(x.status) && x.status !== 'nao_feita').length };
  // % do dia de cada pessoa: o mesmo número do bloco dela no quadro (só o que
  // é só dela; o compartilhado fica no bloco da equipe).
  // Vermelho só quando há atraso — 0% às 9h não é problema.
  const hojeDe = (id) => {
    const lista = (dados?.itens || []).filter((x) => x.data === dados.hoje && x.responsavelId === id && !x.compartilhada);
    return {
      pct: lista.length ? Math.round((lista.filter((x) => terminada(x.status)).length / lista.length) * 100) : null,
      atraso: (dados?.itens || []).some((x) => x.atrasada && (x.responsavelId === id || (!x.responsavelId && (x.grupo || []).includes(id)))),
    };
  };

  return (
    <div className="page-wide rotinas">
      <header className="rt-topo">
        <div>
          <h1>Equipe</h1>
          <p className="ink-soft">{dados ? diaLongo(dados.hoje) : '…'}{nomePessoa ? ` · só ${nomePessoa}` : ''}</p>
        </div>
        <div className="rt-topo-acoes">
          <Link to="/rotinas/modelos/novo?avulsa=1" className="btn-sec"><Zap size={15} />Tarefa avulsa</Link>
          <Link to="/rotinas/modelos/novo" className="btn btn-primary"><Plus size={15} />Nova rotina</Link>
          <button type="button" className="btn-icone" onClick={carregar} aria-label="Atualizar" title="Atualizar"><RefreshCw size={15} className={carregando ? 'girando' : ''} /></button>
        </div>
      </header>

      {erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}
      {aviso && <button type="button" className="rt-aviso rt-tom-ok rt-aviso-fechar" onClick={() => setAviso('')}><Check size={15} />{aviso}<X size={14} /></button>}

      {dados && (
        <div className="rt-filtro-pessoas" role="group" aria-label="Ver uma pessoa">
          <button type="button" className={`rt-pessoa-chip${!pessoa ? ' ativo' : ''}`} onClick={() => mudar({ pessoa: '' })}>
            <span className="rt-avatar rt-avatar-todos"><Users size={13} /></span>Todos
          </button>
          {dados.equipe.map((p) => {
            const { pct, atraso } = hojeDe(p.id);
            return (
              <button key={p.id} type="button" className={`rt-pessoa-chip${pessoa === String(p.id) ? ' ativo' : ''}`} onClick={() => mudar({ pessoa: pessoa === String(p.id) ? '' : String(p.id) })}>
                <Avatar id={p.id} nome={p.nome} />{p.nome.split(' ')[0]}
                {(pct != null || atraso) && <small className={atraso ? 'ruim' : pct === 100 ? 'ok' : ''} title={atraso ? 'tem tarefa atrasada' : 'feito hoje'}>{atraso ? <TriangleAlert size={10} /> : null}{pct ?? 0}%</small>}
              </button>
            );
          })}
        </div>
      )}

      {(produto || modelo) && (
        <div className="rt-filtro-ativo">
          {produto && <span className="chip-filtro"><span className="chip-filtro-campo">Produto</span><span className="chip-filtro-valor">#{produto}</span><button type="button" onClick={() => mudar({ produto: '' })} aria-label="Tirar filtro"><X size={12} /></button></span>}
          {modelo && <span className="chip-filtro"><span className="chip-filtro-campo">Rotina</span><span className="chip-filtro-valor">{dados?.modelos.find((m) => String(m.id) === modelo)?.titulo || `#${modelo}`}</span><button type="button" onClick={() => mudar({ modelo: '' })} aria-label="Tirar filtro"><X size={12} /></button></span>}
        </div>
      )}

      <nav className="rt-abas-grandes" role="tablist">
        {ABAS.map(([k, rot, Ic]) => (
          <button key={k} type="button" role="tab" aria-selected={aba === k} className={`rt-aba-g rt-aba-${k}${aba === k ? ' ativo' : ''}`} onClick={() => mudar({ aba: k })}>
            <Ic size={16} /><span>{rot}</span>
            {contagem[k] != null && <b className={contagem[k] ? 'tem' : ''}>{contagem[k]}</b>}
          </button>
        ))}
      </nav>

      {!dados && !erro && <div className="rt-carregando"><Loader2 className="girando" size={18} /> Carregando…</div>}

      {dados && aba === 'conferir' && (
        <section className="rt-secao">
          <p className="rt-secao-ajuda">Tarefas que a equipe entregou e esperam você. <b>Aprovar</b> direto quando não houve problema; <b>Abrir</b> para ver as respostas e as fotos, ou devolver com um comentário.</p>
          {conferir.length === 0 ? <Vazio icone={ShieldCheck} titulo="Nada para conferir." texto={pessoa ? 'Ninguém dessa pessoa esperando.' : 'Quando alguém entregar uma tarefa com "conferir depois", ela aparece aqui.'} /> : (
            <div className="rt-cartoes">
              {conferir.map((x) => (
                <article key={x.id} className={`rt-cartao rt-faixa-${x.problemas ? 'perigo' : 'roxo'}`}>
                  <header className="rt-cartao-topo">
                    <span className="rt-cartao-pessoa"><Avatar id={x.responsavelId || 0} nome={x.concluidaPorNome || x.responsavelNome} />{x.concluidaPorNome || x.responsavelNome || '—'}</span>
                    {x.noPrazo === false ? <i className="rt-chip rt-tom-perigo">entregou atrasado</i> : <i className="rt-chip rt-tom-ok">no prazo</i>}
                  </header>
                  <h3 className="rt-cartao-titulo">{x.titulo}{x.horario ? <span className="rt-horario"> · {x.horario}</span> : null}</h3>
                  <p className="rt-cartao-info">
                    <span><Clock size={12} />entregou {diaCurto(new Date(x.concluidaEm).toISOString().slice(0, 10))} às {horaDe(x.concluidaEm)}</span>
                    {x.progresso.total > 0 && <span>{x.progresso.feitos}/{x.progresso.total} passos</span>}
                    {x.fotos > 0 && <span><Camera size={12} />{x.fotos} foto{x.fotos > 1 ? 's' : ''}</span>}
                  </p>
                  {x.problemas > 0 && <p className="rt-cartao-problema"><TriangleAlert size={12} />{x.problemas} problema{x.problemas > 1 ? 's' : ''} registrado{x.problemas > 1 ? 's' : ''} — abra para ver</p>}
                  <footer className="rt-cartao-pe">
                    <button type="button" className="rt-cartao-btn" onClick={() => setAberta(x)}>Abrir<ChevronRight size={15} /></button>
                    {!x.problemas && (
                      <button type="button" className="rt-cartao-btn principal ok" onClick={() => aprovarRapido(x)} disabled={aprovando === x.id}>
                        {aprovando === x.id ? <Loader2 size={14} className="girando" /> : <Check size={15} />}Aprovar
                      </button>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {dados && aba === 'atrasadas' && (
        <section className="rt-secao">
          <p className="rt-secao-ajuda">Passaram do horário e ainda não foram feitas. Elas continuam no Meu dia da pessoa até serem concluídas ou marcadas "não consegui fazer".</p>
          {atrasadas.length === 0 ? <Vazio titulo="Ninguém atrasado." texto="Tudo o que venceu foi feito." /> : (
            <div className="rt-cartoes">
              {atrasadas.map((x) => (
                <article key={x.id} className="rt-cartao rt-faixa-perigo" onClick={() => setAberta(x)} role="button" tabIndex={0}>
                  <header className="rt-cartao-topo">
                    <span className="rt-cartao-pessoa">{x.responsavelId ? <Avatar id={x.responsavelId} nome={x.responsavelNome} /> : <span className="rt-avatar rt-avatar-todos"><Users size={13} /></span>}{x.responsavelNome || '—'}</span>
                    <i className="rt-chip rt-tom-perigo">venceu {tempoDesde(x.prazo)}</i>
                  </header>
                  <h3 className="rt-cartao-titulo">{x.titulo}{x.horario ? <span className="rt-horario"> · {x.horario}</span> : null}</h3>
                  <p className="rt-cartao-info">
                    <span className="rt-txt-perigo"><Clock size={12} />{prazoTexto(x, dados.hoje)}</span>
                    {x.setor && <span>{NOME_SETOR[x.setor] || x.setor}</span>}
                    {x.status === 'em_andamento' && <span>começou, não terminou</span>}
                  </p>
                  {x.progresso.total > 0 && (
                    <div className="rt-cartao-prog"><span className="rt-barrinha"><i style={{ width: `${Math.round((x.progresso.feitos / x.progresso.total) * 100)}%` }} /></span><small>{x.progresso.feitos} de {x.progresso.total}</small></div>
                  )}
                  <footer className="rt-cartao-pe"><button type="button" className="rt-cartao-btn" onClick={(e) => { e.stopPropagation(); setAberta(x); }}>Abrir<ChevronRight size={15} /></button></footer>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {dados && aba === 'hoje' && (
        <section className="rt-secao">
          {eventos.length > 0 && (
            <>
              <h2 className="rt-secao-h"><CalendarClock size={15} />Eventos de hoje <small>sem baixa, sem atraso</small></h2>
              <div className="rt-eventos">{eventos.map((ev, i) => <CartaoEvento key={`${ev.modeloId}-${ev.horario || i}`} ev={ev} />)}</div>
            </>
          )}
          <div className={`rt-quadro${pessoa ? ' uma' : ''}`}>
            {quadro.map((b) => (
              <section key={b.id} className="rt-quadro-col">
                <header className="rt-quadro-cab">
                  {b.id ? <Avatar id={b.id} nome={b.nome} tamanho={34} /> : <span className="rt-avatar rt-avatar-todos" style={{ width: 34, height: 34 }}><Users size={16} /></span>}
                  <span className="rt-quadro-nome">
                    <b>{b.nome}</b>
                    <small>{b.total ? `${b.feitas} de ${b.total} feitas` : 'nada hoje'}{b.atrasadas ? <span className="rt-txt-perigo"> · {b.atrasadas} atrasada{b.atrasadas > 1 ? 's' : ''}</span> : null}</small>
                  </span>
                  {b.total > 0 && <span className="rt-quadro-pct">{Math.round((b.feitas / b.total) * 100)}%</span>}
                </header>
                {b.total > 0 && <div className="rt-prog rt-prog-grande"><i style={{ width: `${Math.round((b.feitas / b.total) * 100)}%` }} /></div>}
                <div className="rt-quadro-lista">
                  {b.grupos.map((g) => <LinhaGrupo key={g.chave} grupo={g} hoje={dados.hoje} onAbrir={setAberta} />)}
                  {!b.grupos.length && <p className="ink-soft rt-quadro-vazio">Sem tarefas hoje.</p>}
                </div>
              </section>
            ))}
            {!quadro.length && <Vazio titulo="Ninguém com rotina hoje." />}
          </div>
        </section>
      )}

      {dados && aba === 'desempenho' && (
        <section className="rt-secao">
          <div className="rt-secao-barra">
            <p className="rt-secao-ajuda">Quanto foi feito <b>no prazo</b> do que já venceu. Tarefa de hoje que ainda está no horário não conta.</p>
            <div className="segmentado">
              {[['7', '7 dias'], ['30', '30 dias'], ['1', 'Hoje']].map(([k, l]) => (
                <button key={k} type="button" className={periodo === k ? 'ativo' : ''} onClick={() => mudar({ periodo: k === '7' ? '' : k })}>{l}</button>
              ))}
            </div>
          </div>
          <div className="rt-taxas">
            <section className="card rt-bloco">
              <h3 className="rt-h">Por pessoa</h3>
              {dados.pessoas.filter((p) => !pessoa || String(p.id) === pessoa).map((p) => (
                <BarraTaxa key={p.id} rotulo={<>{p.id ? <Avatar id={p.id} nome={p.nome} tamanho={20} /> : null}{p.nome}</>} pct={p.pctNoPrazo} sub={`${p.noPrazo} de ${p.vencidas}`} onClick={p.id ? () => mudar({ pessoa: String(p.id) }) : undefined} />
              ))}
              {!dados.pessoas.length && <p className="ink-soft">Nada venceu no período.</p>}
            </section>
            <section className="card rt-bloco">
              <h3 className="rt-h">Por rotina <small>pior primeiro · toque para filtrar</small></h3>
              {dados.modelos.slice(0, 12).map((m) => <BarraTaxa key={m.id} rotulo={m.titulo} pct={m.pctNoPrazo} sub={`${m.noPrazo} de ${m.vencidas}`} onClick={() => mudar({ modelo: String(m.id) })} />)}
            </section>
          </div>

          <h2 className="rt-secao-h">Histórico <small>{periodo === '1' ? 'hoje' : `${periodo} dias`}{nomePessoa ? ` · ${nomePessoa}` : ''}</small></h2>
          <section className="card rt-tabela-card">
            <div className="data-table-wrap">
              <table className="data-table rt-tabela">
                <thead><tr><th>Dia</th><th>Tarefa</th><th>Pessoa</th><th>Situação</th><th>Concluiu</th></tr></thead>
                <tbody>
                  {itens.map((x) => {
                    const sit = situacaoDe(x);
                    return (
                      <tr key={x.id} className="linha-clicavel" onClick={() => setAberta(x)}>
                        <td className="ink-soft">{diaCurto(x.data)}{x.horario ? ` ${x.horario}` : ''}</td>
                        <td><b>{x.titulo}</b>{x.problemas > 0 && <i className="rt-chip rt-tom-perigo rt-chip-mini">{x.problemas} problema{x.problemas > 1 ? 's' : ''}</i>}</td>
                        <td>{x.responsavelNome || '—'}</td>
                        <td><i className={`rt-chip rt-tom-${sit.tom}`}>{sit.rotulo}</i></td>
                        <td>{x.concluidaEm ? <>{diaCurto(new Date(x.concluidaEm).toISOString().slice(0, 10))} {horaDe(x.concluidaEm)}{x.noPrazo === false && <i className="rt-chip rt-tom-perigo rt-chip-mini">atrasou</i>}</> : (x.motivoNaoFeita ? <span className="ink-soft">{x.motivoNaoFeita}</span> : '—')}</td>
                      </tr>
                    );
                  })}
                  {!itens.length && <tr><td colSpan={5}><Vazio titulo="Nada no período." /></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      )}

      <Gaveta aberta={Boolean(aberta)} onFechar={() => setAberta(null)} titulo={aberta ? `${aberta.titulo}${aberta.horario ? ` · ${aberta.horario}` : ''}` : ''} subtitulo={aberta ? `${aberta.responsavelNome || '—'} · ${diaCurto(aberta.data)}` : ''} larga>
        {aberta && <RotinaTarefa key={aberta.id} id={aberta.id} naGaveta onMudou={carregar} onExcluida={() => { setAberta(null); setAviso('Tarefa excluída.'); }} />}
      </Gaveta>
    </div>
  );
}

function BarraTaxa({ rotulo, pct, sub, onClick }) {
  const tom = pct == null ? 'neutro' : pct >= 90 ? 'ok' : pct >= 70 ? 'atencao' : 'perigo';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className="rt-taxa" onClick={onClick}>
      <span className="rt-taxa-rot">{rotulo}</span>
      <span className="rt-taxa-barra"><i className={`rt-tom-fundo-${tom}`} style={{ width: `${pct ?? 0}%` }} /></span>
      <b>{pct == null ? '—' : `${pct}%`}</b>
      <small className="ink-soft">{sub}</small>
    </Tag>
  );
}
