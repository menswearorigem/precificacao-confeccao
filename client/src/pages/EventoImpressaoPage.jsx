import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { api } from '../api/client';
import { dataBr } from '../lib/format';

const STATUS_ROTULO = {
  nao_iniciado: 'Não iniciado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
};
const PRIORIDADE_ROTULO = { baixa: 'Baixa', media: 'Média', alta: 'Alta' };

// Campos internos que já aparecem em rótulo próprio (fornecedor_nome cobre
// fornecedor_id) — não faz sentido repetir na lista de campos extras.
const CAMPOS_EXTRA_OCULTOS = new Set(['fornecedor_id', 'fornecedor_nome', 'referencia_texto']);

// Página dedicada (fora do modal) só pra imprimir/exportar em PDF um evento —
// window.print() dentro do modal imprimiria a tela toda por trás dele, então
// isso abre numa aba própria com só o conteúdo do evento.
export default function EventoImpressaoPage() {
  const { id } = useParams();
  const [evento, setEvento] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    api.get(`/calendario/eventos/${id}`).then(setEvento).catch((err) => setErro(err.message));
  }, [id]);

  if (erro) return <div className="page"><div className="login-error">{erro}</div></div>;
  if (!evento) return <div className="page"><p className="page-sub">Carregando…</p></div>;

  const camposExtra = Object.entries(evento.campos_extra || {}).filter(([chave, valor]) => (
    !CAMPOS_EXTRA_OCULTOS.has(chave) && valor !== null && valor !== '' && valor !== undefined
  ));

  return (
    <div className="page-wide">
      <div className="no-print" style={{ marginBottom: 14 }}>
        <button className="btn btn-primary" onClick={() => window.print()}>
          <Printer size={14} /> Imprimir / Exportar PDF
        </button>
      </div>

      <div className="ficha-page ficha-doc-grid card">
        <div className="ficha-doc-topo">
          <div>
            <div className="ficha-doc-empresa">HBN HUB — MISS MANU · ORIGEM · HOGGAR · HEBRON</div>
            <div className="ficha-doc-titulo">{evento.titulo}</div>
          </div>
          <div className="ficha-doc-meta">
            <div><strong>Status:</strong> {STATUS_ROTULO[evento.status] || evento.status}</div>
            <div><strong>Prazo:</strong> {dataBr(evento.data_prevista_fim.slice(0, 10))}{evento.atrasado ? ' (atrasado)' : ''}</div>
          </div>
        </div>

        <div className="ficha-doc-campos">
          <div className="ficha-doc-campo"><span>CATEGORIA:</span> <strong>{evento.categoria || '—'}</strong></div>
          <div className="ficha-doc-campo"><span>PRIORIDADE:</span> <strong>{PRIORIDADE_ROTULO[evento.prioridade] || evento.prioridade}</strong></div>
          <div className="ficha-doc-campo"><span>INÍCIO:</span> <strong>{evento.data_inicio ? dataBr(evento.data_inicio.slice(0, 10)) : '—'}</strong></div>
          <div className="ficha-doc-campo"><span>CONCLUSÃO:</span> <strong>{evento.data_conclusao_real ? dataBr(evento.data_conclusao_real.slice(0, 10)) : '—'}</strong></div>
        </div>

        {evento.descricao && (
          <div className="ficha-doc-secao">
            <strong>Descrição</strong>
            <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{evento.descricao}</p>
          </div>
        )}

        {evento.usa_grade && evento.grade?.length > 0 && (
          <div className="ficha-doc-secao">
            <strong>Grade de variações</strong>
            <table className="grade-variacoes-mini">
              <thead>
                <tr><th>Cor</th><th>Tamanho</th><th>Quantidade</th></tr>
              </thead>
              <tbody>
                {evento.grade.map((g) => (
                  <tr key={g.id}><td>{g.cor || '—'}</td><td>{g.tamanho || '—'}</td><td>{g.quantidade}</td></tr>
                ))}
                <tr><td colSpan="2"><strong>Total</strong></td><td><strong>{evento.grade.reduce((s, g) => s + (Number(g.quantidade) || 0), 0)}</strong></td></tr>
              </tbody>
            </table>
          </div>
        )}

        {evento.produto && (
          <div className="ficha-doc-secao">
            <strong>Produto vinculado</strong>
            <p style={{ margin: '6px 0 0' }}>{evento.produto.referencia} — {evento.produto.descricao || 'sem descrição'}</p>
          </div>
        )}

        {evento.responsaveis?.length > 0 && (
          <div className="ficha-doc-secao">
            <strong>Responsáveis</strong>
            <p style={{ margin: '6px 0 0' }}>{evento.responsaveis.map((r) => r.nome).join(', ')}</p>
          </div>
        )}

        {camposExtra.length > 0 && (
          <div className="ficha-doc-secao">
            <strong>Campos do modelo</strong>
            <table className="ficha-doc-tabela" style={{ marginTop: 6 }}>
              <tbody>
                {camposExtra.map(([chave, valor]) => (
                  <tr key={chave}>
                    <td className="col-esq">{chave}</td>
                    <td className="col-esq">{String(valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
