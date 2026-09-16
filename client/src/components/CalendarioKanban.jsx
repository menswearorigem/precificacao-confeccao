import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { Factory, Users, Inbox } from 'lucide-react';
import { corDaCategoria } from '../lib/corCategoria';
import { situacaoEvento, situacaoClasse } from '../lib/situacaoEvento';
import { casaFoco, ehOrdemDeProducao, prazoRelativo } from './CalendarioVivo';

export const COLUNAS = [
  { valor: 'nao_iniciado', rotulo: 'Não iniciado', tom: 'no-prazo' },
  { valor: 'em_andamento', rotulo: 'Em andamento', tom: 'andamento' },
  { valor: 'concluido', rotulo: 'Concluído', tom: 'concluido' },
  { valor: 'cancelado', rotulo: 'Cancelado', tom: 'cancelado' },
];

function Cartao({ evento, diasAlerta, foco, indice, onClick }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(evento.id),
    disabled: !evento.podeEditar,
  });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const situacao = situacaoEvento(evento, diasAlerta);
  const pecas = (evento.grade || []).reduce((s, g) => s + (Number(g.quantidade) || 0), 0);
  const apagado = foco && !casaFoco(evento, foco);
  return (
    <div
      ref={setNodeRef}
      style={{ ...style, '--i': Math.min(indice, 15), cursor: evento.podeEditar ? undefined : 'pointer' }}
      className={`kanban-cartao cal-cartao ${situacaoClasse(situacao)}${isDragging ? ' arrastando' : ''}${evento.podeEditar ? '' : ' so-leitura'}${apagado ? ' apagado' : ''}`}
      title={evento.podeEditar ? 'Arraste para mudar o status' : 'Você pode ver, mas não editar este evento'}
      onClick={() => onClick(evento.id)}
      {...listeners}
      {...attributes}
    >
      <div className="kanban-cartao-titulo">
        {ehOrdemDeProducao(evento) ? <Factory size={12} className="cal-cartao-icone" />
          : evento.categoria && <span className="categoria-dot" style={{ background: corDaCategoria(evento.categoria) }} />}
        <span>{evento.titulo}</span>
        {(evento.compartilhadoCom || []).length > 0 && <Users size={11} className="cal-cartao-icone cal-chip-fim" />}
      </div>
      <div className="kanban-cartao-meta">
        <span>
          {evento.produto ? evento.produto.referencia : (evento.categoria || '—')}
          {pecas > 0 && ` · ${pecas.toLocaleString('pt-BR')} pç`}
        </span>
        <span className="cal-cartao-prazo">{prazoRelativo(evento)}</span>
      </div>
    </div>
  );
}

function Coluna({ coluna, eventos, diasAlerta, foco, onClickCartao }) {
  const { setNodeRef, isOver } = useDroppable({ id: coluna.valor });
  return (
    <div ref={setNodeRef} className={`kanban-coluna cal-coluna cal-coluna-${coluna.tom}${isOver ? ' sobre-drop' : ''}`}>
      <div className="kanban-coluna-head">
        <span>{coluna.rotulo}</span>
        <span key={eventos.length} className="cal-contador">{eventos.length}</span>
      </div>
      {eventos.map((e, i) => <Cartao key={e.id} evento={e} indice={i} foco={foco} diasAlerta={diasAlerta} onClick={onClickCartao} />)}
      {eventos.length === 0 && (
        <div className="cal-coluna-vazia"><Inbox size={18} /> {isOver ? 'Solte aqui' : 'Nada nesta coluna — arraste um cartão para cá'}</div>
      )}
    </div>
  );
}

// Kanban por status — arrastar um cartão pra outra coluna atualiza o status
// do evento (PUT). Sem ordenação dentro da coluna: a lista já vem ordenada
// por prazo, o que já é a ordem mais útil pra decidir prioridade.
export default function CalendarioKanban({ eventos, diasAlerta, foco, onMudarStatus, onClickCartao }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function aoSoltar(evt) {
    const { active, over } = evt;
    if (!over) return;
    const eventoId = Number(active.id);
    const novoStatus = over.id;
    const evento = eventos.find((e) => e.id === eventoId);
    if (evento && evento.status !== novoStatus) onMudarStatus(eventoId, novoStatus);
  }

  return (
    <DndContext sensors={sensors} onDragEnd={aoSoltar}>
      <div className="calendario-kanban">
        {COLUNAS.map((coluna) => (
          <Coluna
            key={coluna.valor}
            coluna={coluna}
            eventos={eventos.filter((e) => e.status === coluna.valor)}
            diasAlerta={diasAlerta}
            foco={foco}
            onClickCartao={onClickCartao}
          />
        ))}
      </div>
    </DndContext>
  );
}
