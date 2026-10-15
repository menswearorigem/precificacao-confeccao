import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, TriangleAlert } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { numeroBr, horaDe } from '../lib/rotinas';

// "Rotinas deste produto" na ficha (15/10/2026): as últimas respostas das
// tarefas que tocaram esta referência (contagens, conferências). Só para
// administrador, e só aparece quando há alguma — sem cartão vazio na ficha.
function valorTexto(h) {
  const v = h.valor || {};
  if (v.numero != null) return `${numeroBr(v.numero)}${h.unidade ? ` ${h.unidade}` : ''}${v.sistema != null ? ` (sistema ${numeroBr(v.sistema)})` : ''}`;
  if (v.resposta) return { sim: 'Sim', nao: 'Não', ok: 'OK', problema: 'Problema' }[v.resposta] || v.resposta;
  if (v.opcao) return v.opcao;
  if (v.texto) return v.texto;
  if (v.feito) return 'Feito';
  return v.fotos?.length ? 'Foto' : '—';
}

export default function RotinasDoProdutoCard({ produtoId }) {
  const { user } = useAuth();
  const [itens, setItens] = useState([]);
  const admin = user?.role === 'admin';
  useEffect(() => {
    if (!admin || !produtoId) return;
    api.get(`/rotinas/produto/${produtoId}/historico`).then(setItens).catch(() => setItens([]));
  }, [admin, produtoId]);
  if (!admin || !itens.length) return null;
  return (
    <div className="card rt-produto-card" style={{ marginTop: 16 }}>
      <div className="rt-produto-card-topo">
        <h3><ListChecks size={16} /> Rotinas deste produto</h3>
        <Link to={`/rotinas/equipe?periodo=30&produto=${produtoId}`}>Ver na Equipe</Link>
      </div>
      <ul>
        {itens.slice(0, 6).map((h, i) => (
          <li key={i} className={h.problema ? 'problema' : ''}>
            <Link to={`/rotinas/tarefa/${h.ocorrenciaId}`}>{h.titulo}</Link>
            <span className="ink-soft">{h.passo}{h.variante ? ` · ${h.variante}` : ''}</span>
            <b>{h.problema && <TriangleAlert size={12} />}{valorTexto(h)}</b>
            <small className="ink-soft">{h.quem} · {new Date(h.em).toLocaleDateString('pt-BR')} {horaDe(h.em)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
