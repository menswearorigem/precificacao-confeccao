import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { corDaCategoria } from '../lib/corCategoria';
import { situacaoEvento, situacaoClasse } from '../lib/situacaoEvento';

export const COLUNAS = [
  { valor: 'nao_iniciado', rotulo: 'Não iniciado' },
  { valor: 'em_andamento', rotulo: 'Em andamento' },
  { valor: 'concluido', rotulo: 'Concluído' },
  { valor: 'cancelado', rotulo: 'Cancelado' },
];

function Cartao({ evento, diasAlerta, onClick }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(evento.id),
    disabled: !evento.podeEditar,
  });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const situacao = situacaoEvento(evento, diasAlerta);
  return (
    <div
      ref={setNodeRef}
      style={{ ...style, opacity: evento.podeEditar ? 1 : 0.75, cursor: evento.podeEditar ? undefined : 'pointer' }}
      className={`kanban-cartao ${situacaoClasse(situacao)}${isDragging ? ' arrastando' : ''}`}
      onClick={() => onClick(evento.id)}
      {...listeners}
      {...attributes}
    >
      <div className="kanban-cartao-titulo">
        {evento.categoria && <span className="categoria-dot" style={{ background: corDaCategoria(evento.categoria) }} />}
        {evento.titulo}
      </div>
      <div className="kanban-cartao-meta">
        <span>{evento.produto ? evento.produto.referencia : (evento.categoria || '—')}</span>
        <span>
          {evento.atrasado ? `Atrasado ${Math.abs(evento.diasParaPrazo)}d` : evento.diasParaPrazo !== null ? `${evento.diasParaPrazo}d` : ''}
        </span>
      </div>
    </div>
  );
}

function Coluna({ coluna, eventos, diasAlerta, onClickCartao }) {
  const { setNodeRef, isOver } = useDroppable({ id: coluna.valor });
  return (
    <div ref={setNodeRef} className={`kanban-coluna${isOver ? ' sobre-drop' : ''}`}>
      <div className="kanban-coluna-head">
        <span>{coluna.rotulo}</span>
        <span>{eventos.length}</span>
      </div>
      {eventos.map((e) => <Cartao key={e.id} evento={e} diasAlerta={diasAlerta} onClick={onClickCartao} />)}
    </div>
  );
}

// Kanban por status — arrastar um cartão pra outra coluna atualiza o status
// do evento (PUT). Sem ordenação dentro da coluna: a lista já vem ordenada
// por prazo, o que já é a ordem mais útil pra decidir prioridade.
export default function CalendarioKanban({ eventos, diasAlerta, onMudarStatus, onClickCartao }) {
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
            onClickCartao={onClickCartao}
          />
        ))}
      </div>
    </DndContext>
  );
}
