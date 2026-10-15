import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Pencil, Copy, Pause, Play, Archive, Zap, Clock, Users, Package, ShieldCheck, LayoutList, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { confirmar } from '../components/ConfirmDialog';
import { NOME_PRIORIDADE, NOME_SETOR, diaCurto } from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Modelos (15/10/2026) — as rotinas que o administrador escreveu.
// Criar, editar, duplicar, pausar, arquivar e "criar a de hoje agora".

const ABAS = [['ativo', 'Ativas'], ['pausado', 'Pausadas'], ['avulsas', 'Avulsas'], ['arquivado', 'Arquivadas']];

export default function RotinasModelosPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const aba = params.get('aba') || 'ativo';
  const [lista, setLista] = useState(null);
  const [erro, setErro] = useState('');
  const location = useLocation();
  // Recado de quem acabou de salvar (o formulário volta para cá).
  const [aviso, setAviso] = useState(location.state?.aviso || '');

  const carregar = useCallback(async () => {
    try { setLista(await api.get(`/rotinas/modelos?status=${aba}`)); setErro(''); } catch (e) { setErro(e.message); }
  }, [aba]);
  useEffect(() => { carregar(); }, [carregar]);

  async function status(m, novo) {
    if (novo === 'arquivado' && !(await confirmar(`Arquivar "${m.titulo}"? Ela para de gerar tarefas. O histórico continua na Equipe.`, { titulo: 'Arquivar rotina', confirmarTexto: 'Arquivar' }))) return;
    try { await api.post(`/rotinas/modelos/${m.id}/status`, { status: novo }); carregar(); } catch (e) { setErro(e.message); }
  }
  async function duplicar(m) {
    try { const r = await api.post(`/rotinas/modelos/${m.id}/duplicar`, {}); navigate(`/rotinas/modelos/${r.id}`); } catch (e) { setErro(e.message); }
  }
  async function gerarAgora(m) {
    try {
      const r = await api.post(`/rotinas/modelos/${m.id}/gerar-agora`, {});
      setAviso(r.criadas ? `"${m.titulo}": ${r.criadas === 1 ? 'tarefa de hoje criada' : `${r.criadas} tarefas de hoje criadas`}.` : `"${m.titulo}" já tinha a tarefa de hoje.`);
    } catch (e) { setErro(e.message); }
  }

  if (user?.role !== 'admin') return <div className="page"><p>Esta tela é só de administrador.</p></div>;

  return (
    <div className="page-wide rotinas">
      <header className="rt-topo">
        <div>
          <h1>Modelos de rotina</h1>
          <p className="ink-soft">O que a equipe faz e quando. Editar muda só as próximas tarefas.</p>
        </div>
        <div className="rt-topo-acoes">
          <Link to="/rotinas/modelos/novo?avulsa=1" className="btn-sec"><Zap size={15} />Tarefa avulsa</Link>
          <Link to="/rotinas/modelos/novo" className="btn btn-primary"><Plus size={15} />Nova rotina</Link>
        </div>
      </header>

      <div className="segmentado rt-abas">
        {ABAS.map(([k, l]) => <button key={k} type="button" className={aba === k ? 'ativo' : ''} onClick={() => setParams(k === 'ativo' ? {} : { aba: k })}>{l}</button>)}
      </div>

      {erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}
      {aviso && <div className="rt-aviso rt-tom-ok">{aviso}</div>}

      <section className="rt-modelos">
        {lista && lista.length === 0 && (
          <div className="rt-vazio">
            <LayoutList size={24} />
            <b>{aba === 'ativo' ? 'Escreva a primeira rotina' : 'Nada aqui.'}</b>
            {aba === 'ativo' && <span>Uma rotina é uma tarefa escrita que se repete — contagem de estoque, conferência da coleta, revisão de anúncio.</span>}
            {aba === 'ativo' && <Link to="/rotinas/modelos/novo" className="btn btn-primary"><Plus size={15} />Nova rotina</Link>}
          </div>
        )}
        {(lista || []).map((m) => (
          <article key={m.id} className={`rt-modelo rt-pri-borda-${m.prioridade}`}>
            <div className="rt-modelo-corpo">
              <Link to={`/rotinas/modelos/${m.id}`} className="rt-modelo-titulo">{m.titulo}</Link>
              <div className="rt-linha-sub">
                <span><Clock size={12} />{m.quando}{m.horaLimite ? ` · até ${m.horaLimite}` : ''}</span>
                <span><Users size={12} />{m.dividida ? 'dividem: ' : m.compartilhada ? 'qualquer um: ' : ''}{m.responsaveis.join(', ')}</span>
                {(m.nProdutos > 0 || m.automatica) && <span>{m.automatica ? <Sparkles size={12} /> : <Package size={12} />}{m.automatica ? 'lista automática' : `${m.nProdutos} ${m.nProdutos > 1 ? 'referências' : 'referência'}${m.nVariantesEscolhidas ? ` (${m.nVariantesEscolhidas} var.)` : ''}`}</span>}
                <span>{m.nPassos ? `${m.nPassos} passo${m.nPassos > 1 ? 's' : ''}` : 'tarefa simples'}</span>
                {m.conferir && <span><ShieldCheck size={12} />conferir depois</span>}
              </div>
              <div className="rt-modelo-chips">
                <i className={`rt-chip rt-pri-${m.prioridade}`}>{NOME_PRIORIDADE[m.prioridade]}</i>
                <i className="rt-chip rt-chip-neutro">{NOME_SETOR[m.setor] || m.setor}</i>
                {m.proximas.length > 0 && <span className="ink-soft rt-sub">próximas: {m.proximas.map(diaCurto).join(', ')}</span>}
                {m.noPrazo30 != null && <span className={`rt-sub ${m.noPrazo30 >= 90 ? 'rt-txt-ok' : m.noPrazo30 < 70 ? 'rt-txt-perigo' : ''}`}>{m.noPrazo30}% no prazo (30 dias)</span>}
              </div>
            </div>
            <div className="rt-modelo-acoes">
              <Link to={`/rotinas/modelos/${m.id}`} className="btn-icone" title="Editar" aria-label="Editar"><Pencil size={15} /></Link>
              <button type="button" className="btn-icone" title="Duplicar" aria-label="Duplicar" onClick={() => duplicar(m)}><Copy size={15} /></button>
              {m.status === 'ativo' && <button type="button" className="btn-icone" title="Criar a tarefa de hoje agora" aria-label="Criar a tarefa de hoje agora" onClick={() => gerarAgora(m)}><Zap size={15} /></button>}
              {m.status === 'ativo' && <button type="button" className="btn-icone" title="Pausar" aria-label="Pausar" onClick={() => status(m, 'pausado')}><Pause size={15} /></button>}
              {m.status !== 'ativo' && <button type="button" className="btn-icone" title="Ativar" aria-label="Ativar" onClick={() => status(m, 'ativo')}><Play size={15} /></button>}
              {m.status !== 'arquivado' && <button type="button" className="btn-icone" title="Arquivar" aria-label="Arquivar" onClick={() => status(m, 'arquivado')}><Archive size={15} /></button>}
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
