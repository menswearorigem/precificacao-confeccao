import {
  DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import { Factory, Package, AlertTriangle, Layers } from 'lucide-react';
import { formatQtd, dataBr } from '../lib/format';

// Quadro da Produção — mudar a situação da ordem arrastando o cartão.
//
// Mesma estrutura do Kanban do Calendário (`CalendarioKanban.jsx`), de
// propósito: mesma biblioteca (@dnd-kit, já instalada), mesmas classes de CSS
// (`.kanban-coluna`, `.kanban-cartao`), mesmo sensor com `distance: 5` — que é
// o detalhe que permite CLICAR e ARRASTAR no mesmo elemento. Sem ele, o clique
// que abre a ordem nunca dispararia.
//
// ---------------------------------------------------------------------------
// O que este quadro NÃO faz, e por quê
// ---------------------------------------------------------------------------
// ⚠️ Não conclui ordem. Concluir dá entrada das peças no estoque e passa pela
// conferência do financeiro (compromisso com facção não registrado trava o
// fechamento). Fazer isso com um arrastar de cartão seria a maneira mais fácil
// já inventada de duplicar estoque — e um arrastar sem querer é comum.
//
// A coluna "Concluída" existe assim mesmo, porque esconder as concluídas faria
// o quadro parecer que a produção do mês desapareceu. Ela só não ACEITA
// cartão: soltar ali devolve a instrução e a tela abre a ordem no botão certo.
//
// ⚠️ Não reordena dentro da coluna. A lista já vem ordenada por data de
// entrega, que é a ordem que interessa a quem olha o chão de fábrica.

export const COLUNAS = [
  { valor: 'rascunho', rotulo: 'Rascunho', ajuda: 'Sendo montada. Nada foi reservado.' },
  { valor: 'planejada', rotulo: 'Planejada', ajuda: 'Grade fechada, material reservado.' },
  { valor: 'em_producao', rotulo: 'Em produção', ajuda: 'O corte saiu.' },
  { valor: 'concluida', rotulo: 'Concluída', recebe: false, ajuda: 'As peças entraram no estoque. Só a própria ordem fecha, pelo botão de concluir.' },
  { valor: 'cancelada', rotulo: 'Cancelada', ajuda: 'Não vai acontecer. Nada é apagado.' },
];

function Cartao({ ordem, onClick }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(ordem.id),
    // Ordem concluída não se arrasta: as peças já entraram no estoque e não há
    // caminho de volta que não seja um movimento de estoque.
    disabled: ordem.situacao === 'concluida',
  });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;

  const atrasada = ordem.data_prevista
    && new Date(ordem.data_prevista) < new Date()
    && !['concluida', 'cancelada'].includes(ordem.situacao);
  const falta = Number(ordem.quantidade_planejada) - Number(ordem.quantidade_produzida);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`kanban-cartao op-cartao${isDragging ? ' arrastando' : ''}${atrasada ? ' op-cartao-atrasada' : ''}`}
      onClick={() => onClick(ordem.id)}
      {...listeners}
      {...attributes}
    >
      <div className="kanban-cartao-titulo">
        {ordem.tipo === 'kit' ? <Layers size={13} /> : <Factory size={13} />}
        OP {ordem.numero} · {ordem.tipo === 'kit' ? (ordem.nome || 'Kit') : ordem.referencia}
      </div>
      <div className="op-cartao-linha ink-soft">
        {ordem.tipo === 'kit'
          ? (ordem.referencias_do_kit || 'sem referência')
          : (ordem.produto_descricao || '')}
      </div>
      <div className="kanban-cartao-meta">
        <span>
          {formatQtd(ordem.quantidade_produzida)} / {formatQtd(ordem.quantidade_planejada)} peças
        </span>
        <span>{ordem.data_prevista ? dataBr(ordem.data_prevista) : 'sem prazo'}</span>
      </div>
      <div className="op-cartao-selos">
        {atrasada && <span className="selo tone-prejuizo"><AlertTriangle size={11} /> atrasada</span>}
        {!ordem.data_prevista && (
          <span className="selo tone-atencao" title="Sem previsão de entrega, esta ordem não entra no calendário e não tem como atrasar.">sem prazo</span>
        )}
        {Number(ordem.insumos_sem_custo) > 0 && (
          <span className="selo tone-atencao" title="Há insumo sem custo conhecido: o custo desta ordem está incompleto, não é zero.">custo parcial</span>
        )}
        {ordem.fornecedor_nome && <span className="selo tone-neutro">{ordem.fornecedor_nome}</span>}
        {falta > 0 && ordem.situacao === 'em_producao' && (
          <span className="selo tone-elevada"><Package size={11} /> faltam {formatQtd(falta)}</span>
        )}
      </div>
    </div>
  );
}

function Coluna({ coluna, ordens, onClickCartao }) {
  const { setNodeRef, isOver } = useDroppable({ id: coluna.valor, disabled: coluna.recebe === false });
  const pecas = ordens.reduce((s, o) => s + Number(o.quantidade_planejada || 0), 0);
  return (
    <div
      ref={setNodeRef}
      className={`kanban-coluna${isOver && coluna.recebe !== false ? ' sobre-drop' : ''}${coluna.recebe === false ? ' kanban-coluna-fechada' : ''}`}
    >
      <div className="kanban-coluna-head" title={coluna.ajuda}>
        <span>{coluna.rotulo}</span>
        <span>{ordens.length}</span>
      </div>
      {ordens.length > 0 && (
        <div className="kanban-coluna-sub ink-soft">{formatQtd(pecas)} peças</div>
      )}
      {ordens.map((o) => <Cartao key={o.id} ordem={o} onClick={onClickCartao} />)}
    </div>
  );
}

export default function ProducaoKanban({ ordens, onMudarSituacao, onClickCartao }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function aoSoltar(evt) {
    const { active, over } = evt;
    if (!over) return;
    const destino = String(over.id);
    const coluna = COLUNAS.find((c) => c.valor === destino);
    if (!coluna || coluna.recebe === false) return;
    const ordem = ordens.find((o) => String(o.id) === String(active.id));
    if (ordem && ordem.situacao !== destino) onMudarSituacao(ordem, destino);
  }

  return (
    <DndContext sensors={sensors} onDragEnd={aoSoltar}>
      <div className="producao-kanban">
        {COLUNAS.map((coluna) => (
          <Coluna
            key={coluna.valor}
            coluna={coluna}
            ordens={ordens.filter((o) => o.situacao === coluna.valor)}
            onClickCartao={onClickCartao}
          />
        ))}
      </div>
    </DndContext>
  );
}
