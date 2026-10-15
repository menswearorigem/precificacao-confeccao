import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw, TriangleAlert, ShieldCheck, Clock, X, Camera, ListChecks, Zap } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import Gaveta from '../components/Gaveta';
import RotinaTarefa from '../components/RotinaTarefa';
import { NumeroAnimado } from '../components/ui';
import { situacaoDe, prazoTexto, diaCurto, horaDe, diaLongo } from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Equipe (15/10/2026) — quem fez o quê. Só administrador.
//   · chips por pessoa com o % do dia concluído (clicar filtra);
//   · três painéis que pedem ação: atrasadas, aguardando conferência e com
//     problema hoje;
//   · a tabela do período; abrir uma linha mostra tudo o que foi respondido,
//     com as fotos, e Aprovar / Devolver;
//   · taxa de conclusão no prazo por pessoa e por rotina.

const PAINEIS = {
  atrasadas: (x) => x.atrasada,
  conferir: (x) => x.status === 'aguardando_conferencia',
  problema: (x, hoje) => x.data === hoje && x.problemas > 0,
};

export default function RotinasEquipePage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const periodo = params.get('periodo') || '1';
  const painel = params.get('painel') || '';
  const pessoa = params.get('pessoa') || '';
  const produto = params.get('produto') || '';
  const modelo = params.get('modelo') || '';
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [aberta, setAberta] = useState(null);
  const location = useLocation();
  const [aviso, setAviso] = useState(location.state?.aviso || '');

  const mudar = (k, v) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

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

  const itens = useMemo(() => {
    if (!dados) return [];
    return dados.itens.filter((x) => (!pessoa || String(x.responsavelId || 0) === pessoa)
      && (!painel || PAINEIS[painel]?.(x, dados.hoje)));
  }, [dados, pessoa, painel]);

  if (user?.role !== 'admin') return <div className="page"><p>Esta tela é só de administrador.</p></div>;

  return (
    <div className="page-wide rotinas">
      <header className="rt-topo">
        <div>
          <h1>Equipe</h1>
          <p className="ink-soft">{dados ? `${diaLongo(dados.hoje)} · quem fez o quê` : '…'}</p>
        </div>
        <div className="rt-topo-acoes">
          <div className="segmentado">
            {[['1', 'Hoje'], ['7', '7 dias'], ['30', '30 dias']].map(([k, l]) => (
              <button key={k} type="button" className={periodo === k ? 'ativo' : ''} onClick={() => mudar('periodo', k === '1' ? '' : k)}>{l}</button>
            ))}
          </div>
          <Link to="/rotinas/modelos/novo?avulsa=1" className="btn-sec"><Zap size={15} />Tarefa avulsa</Link>
          <Link to="/rotinas/modelos/novo" className="btn btn-primary"><Plus size={15} />Nova rotina</Link>
          <button type="button" className="btn-icone" onClick={carregar} aria-label="Atualizar" title="Atualizar"><RefreshCw size={15} className={carregando ? 'girando' : ''} /></button>
        </div>
      </header>

      {erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}
      {aviso && <div className="rt-aviso rt-tom-ok" onClick={() => setAviso('')}>{aviso}</div>}

      {dados && dados.pessoas.length > 0 && (
        <div className="rt-pessoas" role="group" aria-label="Filtrar por pessoa">
          <button type="button" className={`rt-pessoa${!pessoa ? ' ativo' : ''}`} onClick={() => mudar('pessoa', '')}>Todos</button>
          {dados.pessoas.map((p) => (
            <button key={p.id} type="button" className={`rt-pessoa${pessoa === String(p.id) ? ' ativo' : ''}`} onClick={() => mudar('pessoa', pessoa === String(p.id) ? '' : String(p.id))}>
              <span>{p.id ? p.nome.split(' ')[0] : p.nome}</span>
              {p.pctHoje != null && <b className={p.pctHoje === 100 ? 'ok' : p.pctHoje < 50 ? 'ruim' : ''}>{p.pctHoje}%</b>}
            </button>
          ))}
        </div>
      )}

      {(produto || modelo) && (
        <div className="rt-filtro-ativo">
          {produto && <span className="chip-filtro"><span className="chip-filtro-campo">Produto</span><span className="chip-filtro-valor">#{produto}</span><button type="button" onClick={() => mudar('produto', '')} aria-label="Tirar filtro"><X size={12} /></button></span>}
          {modelo && <span className="chip-filtro"><span className="chip-filtro-campo">Rotina</span><span className="chip-filtro-valor">{dados?.modelos.find((m) => String(m.id) === modelo)?.titulo || `#${modelo}`}</span><button type="button" onClick={() => mudar('modelo', '')} aria-label="Tirar filtro"><X size={12} /></button></span>}
        </div>
      )}

      <div className="rt-paineis">
        {[
          ['atrasadas', 'Atrasadas', dados?.paineis.atrasadas, 'perigo', TriangleAlert, 'Ver atrasadas'],
          ['conferir', 'Aguardando conferência', dados?.paineis.conferir, 'roxo', ShieldCheck, 'Conferir'],
          ['problema', 'Com problema hoje', dados?.paineis.comProblemaHoje, 'atencao', Camera, 'Ver problemas'],
        ].map(([k, rot, n, tom, Ic, botao]) => (
          <div key={k} className={`rt-painel rt-tom-${tom}${painel === k ? ' ativo' : ''}`}>
            <span className="rt-painel-ic"><Ic size={18} /></span>
            <span className="rt-painel-txt"><small>{rot}</small><b><NumeroAnimado valor={n ?? 0} /></b></span>
            <button type="button" className="rt-painel-btn" onClick={() => mudar('painel', painel === k ? '' : k)} disabled={!n && painel !== k}>{painel === k ? 'Mostrar tudo' : botao}</button>
          </div>
        ))}
      </div>

      <section className="card rt-tabela-card">
        <div className="data-table-wrap">
          <table className="data-table rt-tabela">
            <thead>
              <tr><th>Tarefa</th><th>Pessoa</th><th>Prazo</th><th>Situação</th><th>Concluiu</th><th className="num">Problemas</th><th className="num">Fotos</th></tr>
            </thead>
            <tbody>
              {itens.map((x) => {
                const sit = situacaoDe(x);
                return (
                  <tr key={x.id} className="linha-clicavel" onClick={() => setAberta(x)}>
                    <td><b>{x.titulo}{x.horario ? ` · ${x.horario}` : ''}</b>{x.correcao && <i className="rt-chip rt-tom-atencao rt-chip-mini">Correção</i>}<div className="ink-soft rt-sub">{diaCurto(x.data)}{x.nVariantes ? ` · ${x.nVariantes} var.` : ''}{x.progresso.total ? ` · ${x.progresso.feitos}/${x.progresso.total}` : ''}</div></td>
                    <td>{x.responsavelNome || '—'}</td>
                    <td><span className="rt-prazo"><Clock size={12} />{prazoTexto(x, dados.hoje)}</span></td>
                    <td><i className={`rt-chip rt-tom-${sit.tom}`}>{sit.rotulo}</i></td>
                    <td>{x.concluidaEm ? <>{diaCurto(new Date(x.concluidaEm).toISOString().slice(0, 10))} {horaDe(x.concluidaEm)}{x.noPrazo === false && <i className="rt-chip rt-tom-perigo rt-chip-mini">atrasou</i>}</> : (x.motivoNaoFeita ? <span className="ink-soft">{x.motivoNaoFeita}</span> : '—')}</td>
                    <td className="num">{x.problemas ? <b className="rt-txt-perigo">{x.problemas}</b> : '—'}</td>
                    <td className="num">{x.fotos || '—'}</td>
                  </tr>
                );
              })}
              {dados && !itens.length && (
                <tr><td colSpan={7}><div className="rt-vazio"><ListChecks size={22} /><b>Nada aqui.</b><span>{painel || pessoa ? 'Tire o filtro para ver o resto.' : 'Crie uma rotina ou uma tarefa avulsa.'}</span></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {dados && (dados.pessoas.length > 0 || dados.modelos.length > 0) && (
        <div className="rt-taxas">
          <section className="card rt-bloco">
            <h3 className="rt-h">No prazo, por pessoa <small>{periodo === '1' ? 'hoje' : `${periodo} dias`}</small></h3>
            {dados.pessoas.map((p) => <BarraTaxa key={p.id} rotulo={p.nome} pct={p.pctNoPrazo} sub={`${p.noPrazo} de ${p.vencidas}`} />)}
          </section>
          <section className="card rt-bloco">
            <h3 className="rt-h">No prazo, por rotina <small>pior primeiro</small></h3>
            {dados.modelos.slice(0, 10).map((m) => <BarraTaxa key={m.id} rotulo={m.titulo} pct={m.pctNoPrazo} sub={`${m.noPrazo} de ${m.vencidas}`} onClick={() => mudar('modelo', String(m.id))} />)}
          </section>
        </div>
      )}

      <Gaveta aberta={Boolean(aberta)} onFechar={() => setAberta(null)} titulo={aberta?.titulo} subtitulo={aberta ? `${aberta.responsavelNome || '—'} · ${diaCurto(aberta.data)}` : ''} larga>
        {aberta && <RotinaTarefa key={aberta.id} id={aberta.id} naGaveta onMudou={carregar} />}
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
