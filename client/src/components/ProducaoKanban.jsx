import { memo, useState } from 'react';
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

// Quantas concluídas o quadro mostra antes do "ver todas". Com 275 cartões
// na coluna Concluída o quadro virava uma parede — e renderizar tudo de novo
// a cada troca de tema chegou a travar a aba (revisão visual 25/09/2026).
const CONCLUIDAS_VISIVEIS = 10;

// memo: o cartão só redesenha quando a própria ordem muda, não a cada
// arrastar/soltar ou troca de tema do quadro inteiro.
const Cartao = memo(function Cartao({ ordem, onClick }) {
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
  const planejada = Number(ordem.quantidade_planejada) || 0;
  const progresso = planejada > 0 ? Math.max(0, Math.min(1, (Number(ordem.quantidade_produzida) || 0) / planejada)) : 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`kanban-cartao op-cartao${isDragging ? ' arrastando' : ''}${atrasada ? ' op-cartao-atrasada' : ''}`}
      onClick={() => onClick(ordem.id)}
      {...listeners}
      {...attributes}
    >
      <div className="op-cartao-cabeca">
        <MiniaturaOp ordem={ordem} />
        <div className="kanban-cartao-titulo">
          {ordem.tipo === 'kit' ? <Layers size={13} /> : <Factory size={13} />}
          OP {ordem.numero} · {ordem.tipo === 'kit' ? (ordem.nome || 'Kit') : ordem.referencia}
        </div>
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
      {/* "0 / 959 peças" vira uma barra — lê-se de longe. */}
      {ordem.situacao !== 'cancelada' && planejada > 0 && (
        <div className={`op-progresso${progresso >= 1 ? ' completo' : ''}`} title={`${Math.round(progresso * 100)}% produzido`}>
          <span style={{ width: `${progresso * 100}%` }} />
        </div>
      )}
      <div className="op-cartao-selos">
        {atrasada && <span className="selo tone-prejuizo"><AlertTriangle size={11} /> atrasada</span>}
        {/* "sem prazo" em âmbar em quase todo cartão virava ruído. Só vira
            selo quando é problema: ordem já em produção sem data de chegada.
            Nas outras, a própria linha de data já diz "sem prazo". */}
        {!ordem.data_prevista && ordem.situacao === 'em_producao' && (
          <span className="selo tone-atencao" title="Em produção sem previsão de entrega: esta ordem não entra no calendário e não tem como atrasar.">sem prazo</span>
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
});

// Miniatura da peça no cartão (revisão visual 25/09/2026). Foto do cadastro;
// sem ela, a do anúncio; link quebrado ou sem foto nenhuma: nada (o cartão
// não ganha um ícone de "sem imagem" a mais).
function MiniaturaOp({ ordem }) {
  const [falhou, setFalhou] = useState(false);
  if (ordem.tipo === 'kit') return null;
  const src = ordem.tem_foto ? `/api/produtos/${ordem.produto_id}/foto` : (ordem.foto_url || null);
  if (!src || falhou) return null;
  return <img className="op-cartao-foto" src={src} alt="" loading="lazy" draggable={false} onError={() => setFalhou(true)} />;
}

function Coluna({ coluna, ordens, onClickCartao }) {
  const { setNodeRef, isOver } = useDroppable({ id: coluna.valor, disabled: coluna.recebe === false });
  const pecas = ordens.reduce((s, o) => s + Number(o.quantidade_planejada || 0), 0);
  const [todas, setTodas] = useState(false);
  // Concluída: só as mais recentes, com "ver todas". As outras colunas são
  // trabalho em andamento — ali cada cartão importa e nada é escondido.
  const recolhe = coluna.valor === 'concluida' && ordens.length > CONCLUIDAS_VISIVEIS && !todas;
  const visiveis = recolhe
    ? [...ordens]
      .sort((a, b) => String(b.data_conclusao || b.data_prevista || '').localeCompare(String(a.data_conclusao || a.data_prevista || '')) || Number(b.numero) - Number(a.numero))
      .slice(0, CONCLUIDAS_VISIVEIS)
    : ordens;
  return (
    <div
      ref={setNodeRef}
      data-situacao={coluna.valor}
      className={`kanban-coluna${isOver && coluna.recebe !== false ? ' sobre-drop' : ''}${coluna.recebe === false ? ' kanban-coluna-fechada' : ''}`}
    >
      <div className="kanban-coluna-head" title={coluna.ajuda}>
        <span>{coluna.rotulo}</span>
        <span>{ordens.length}</span>
      </div>
      {ordens.length > 0 && (
        <div className="kanban-coluna-sub ink-soft">{formatQtd(pecas)} peças</div>
      )}
      {visiveis.map((o) => <Cartao key={o.id} ordem={o} onClick={onClickCartao} />)}
      {coluna.valor === 'concluida' && ordens.length > CONCLUIDAS_VISIVEIS && (
        <button type="button" className="kanban-ver-todas" onClick={() => setTodas((v) => !v)}>
          {todas ? 'Mostrar só as 10 mais recentes' : `Ver todas as ${formatQtd(ordens.length)} concluídas`}
        </button>
      )}
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
