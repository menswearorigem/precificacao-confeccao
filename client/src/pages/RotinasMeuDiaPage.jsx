import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, ChevronRight, CircleCheck, Clock, Package, RefreshCw, TriangleAlert, Undo2, BellRing, Users } from 'lucide-react';
import { api } from '../api/client';
import { NumeroAnimado } from '../components/ui';
import { NOME_PRIORIDADE, diaLongo, prazoTexto, situacaoDe, horaDe, diaCurto } from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Meu dia (15/10/2026) — o que a pessoa logada tem para fazer.
// Pensada para o celular: três contadores, lista compacta (atrasadas →
// prazo → prioridade), um toque abre a tarefa.

export function LinhaTarefa({ item, hoje, mostrarPessoa = false, onClick }) {
  const sit = situacaoDe(item);
  const corpo = (
    <>
      <span className="rt-linha-barra" />
      <span className="rt-linha-corpo">
        <span className="rt-linha-titulo">
          <b>{item.titulo}</b>
          {(item.prioridade === 'alta' || item.prioridade === 'urgente') && <i className={`rt-chip rt-pri-${item.prioridade}`}>{NOME_PRIORIDADE[item.prioridade]}</i>}
          {item.correcao && <i className="rt-chip rt-tom-atencao">Correção</i>}
        </span>
        <span className="rt-linha-sub">
          <span className="rt-prazo"><Clock size={12} />{prazoTexto(item, hoje)}</span>
          {mostrarPessoa && <span><Users size={12} />{item.responsavelNome || '—'}</span>}
          {item.nVariantes > 0 && <span><Package size={12} />{item.nVariantes === 1 ? '1 variante' : `${item.nVariantes} variantes`}</span>}
          {item.progresso.total > 0 && aberta(item.status) && <span className="rt-prog"><i style={{ width: `${Math.round((item.progresso.feitos / item.progresso.total) * 100)}%` }} />{item.progresso.feitos} de {item.progresso.total}</span>}
          {item.pedeFoto && aberta(item.status) && <span title="Pede foto"><Camera size={12} /></span>}
          {item.problemas > 0 && <span className="rt-txt-perigo"><TriangleAlert size={12} />{item.problemas} problema{item.problemas > 1 ? 's' : ''}</span>}
        </span>
        {item.status === 'devolvida' && item.comentarioConferencia && (
          <span className="rt-linha-devolvida"><Undo2 size={12} />{item.comentarioConferencia}</span>
        )}
      </span>
      <i className={`rt-chip rt-tom-${sit.tom}`}>{sit.rotulo}</i>
      <ChevronRight size={16} className="rt-linha-seta" />
    </>
  );
  const classe = `rt-linha rt-tom-borda-${sit.tom}`;
  if (onClick) return <button type="button" className={classe} onClick={onClick}>{corpo}</button>;
  return <Link to={`/rotinas/tarefa/${item.id}`} className={classe}>{corpo}</Link>;
}
const aberta = (status) => status === 'pendente' || status === 'em_andamento' || status === 'devolvida';

export default function RotinasMeuDiaPage() {
  const [ver, setVer] = useState('hoje');
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await api.get(`/rotinas/meu-dia${ver !== 'hoje' ? `?ver=${ver}` : ''}`));
      setErro('');
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, [ver]);

  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    const t = setInterval(carregar, 2 * 60000);
    return () => clearInterval(t);
  }, [carregar]);

  const c = dados?.contadores;
  const porDia = {};
  for (const f of dados?.futuro || []) (porDia[f.data] ||= []).push(f);

  return (
    <div className="page-wide rotinas">
      <header className="rt-topo">
        <div>
          <h1>Meu dia</h1>
          <p className="ink-soft">{dados ? diaLongo(dados.hoje) : '…'}</p>
        </div>
        <div className="rt-topo-acoes">
          <div className="segmentado" role="tablist" aria-label="Ver">
            {[['hoje', 'Hoje'], ['amanha', 'Ver amanhã'], ['semana', 'Ver semana']].map(([k, l]) => (
              <button key={k} type="button" className={ver === k ? 'ativo' : ''} onClick={() => setVer(k)}>{l}</button>
            ))}
          </div>
          <button type="button" className="btn-icone" onClick={carregar} title="Atualizar" aria-label="Atualizar">
            <RefreshCw size={15} className={carregando ? 'girando' : ''} />
          </button>
        </div>
      </header>

      {erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}

      {dados?.lembretes?.length > 0 && (
        <div className="rt-aviso rt-tom-atencao" role="status">
          <BellRing size={16} />
          <span>
            {dados.lembretes.map((l, i) => (
              <span key={l.id}>{i > 0 && ' · '}<Link to={`/rotinas/tarefa/${l.id}`}><b>{l.titulo}</b></Link> {l.minutos < 1 ? 'vence agora' : `vence em ${l.minutos} min`}</span>
            ))}
          </span>
        </div>
      )}

      <div className="rt-contadores">
        <div className="rt-contador rt-tom-perigo"><small>Atrasadas</small><b><NumeroAnimado valor={c?.atrasadas ?? 0} /></b></div>
        <div className="rt-contador rt-tom-info"><small>Para hoje</small><b><NumeroAnimado valor={c?.paraHoje ?? 0} /></b></div>
        <div className="rt-contador rt-tom-ok"><small>Feitas</small><b><NumeroAnimado valor={c?.feitas ?? 0} /></b></div>
      </div>

      {ver === 'hoje' && dados && (
        <section className="rt-lista">
          {dados.abertas.length === 0 ? (
            <div className="rt-vazio"><CircleCheck size={22} /><b>Nada pendente.</b><span>Quando um administrador passar uma tarefa, ela aparece aqui.</span></div>
          ) : dados.abertas.map((it) => <LinhaTarefa key={it.id} item={it} hoje={dados.hoje} />)}
        </section>
      )}

      {ver === 'hoje' && dados?.feitas?.length > 0 && (
        <details className="rt-feitas">
          <summary>Feitas hoje ({dados.feitas.length})</summary>
          <section className="rt-lista">
            {dados.feitas.map((it) => <LinhaTarefa key={it.id} item={it} hoje={dados.hoje} />)}
          </section>
        </details>
      )}

      {ver !== 'hoje' && dados && (
        <section className="rt-futuro">
          {Object.keys(porDia).length === 0 && <div className="rt-vazio"><Clock size={22} /><b>Nada programado.</b></div>}
          {Object.entries(porDia).map(([dia, itens]) => (
            <div key={dia} className="rt-futuro-dia">
              <h3>{diaLongo(dia)}</h3>
              {itens.map((f) => (
                <div key={`${f.modeloId}-${dia}`} className="rt-linha rt-linha-estatica">
                  <span className="rt-linha-barra" />
                  <span className="rt-linha-corpo">
                    <span className="rt-linha-titulo"><b>{f.titulo}</b>{(f.prioridade === 'alta' || f.prioridade === 'urgente') && <i className={`rt-chip rt-pri-${f.prioridade}`}>{NOME_PRIORIDADE[f.prioridade]}</i>}</span>
                    <span className="rt-linha-sub"><span><Clock size={12} />{f.horaLimite ? `até ${f.horaLimite}` : 'até o fim do dia'}</span>{f.compartilhada && <span><Users size={12} />qualquer um da equipe</span>}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      <details className="rt-como">
        <summary>Como funciona</summary>
        <p>As tarefas aparecem aqui no dia em que foram programadas pelo administrador. Toque numa tarefa para ler o que fazer, ver os produtos e responder cada passo — cada resposta é salva na hora, dá para sair e voltar.</p>
        <p><b>Atrasada</b> é a que passou do horário limite: ela continua aqui até ser concluída ou marcada como "não consegui fazer". Se a tarefa pede conferência, depois de concluir ela vai para o administrador; se ele <b>devolver</b>, ela volta para cá com o comentário.</p>
        <p>Tarefa de <b>qualquer um da equipe</b> fica com quem responder primeiro.</p>
        {dados && <p className="ink-soft">Atualizado às {horaDe(new Date())} · {diaCurto(dados.hoje)}</p>}
      </details>
    </div>
  );
}
