import { Plus, Trash2 } from 'lucide-react';
import { Select } from './ui';

// Grade editável de cor x tamanho x quantidade — usada no formulário de
// evento (EventoCalendarioModal), na exportação em massa (CalendarioPage,
// visão Lista) e na impressão de um evento só (EventoImpressaoPage, em modo
// só-leitura via `disabled`). As opções de cor/tamanho vêm da MESMA fonte
// pré-pronta do sistema usada pelo campo 'select' de modelo (Seção 2), não
// de texto livre — mas uma linha com um valor que não está mais na lista
// (dado legado, ou removido do estoque depois) continua aparecendo, só não
// pode ser escolhido de novo em outra linha.
function opcoesComValorAtual(opcoes, valorAtual) {
  if (!valorAtual || opcoes.includes(valorAtual)) return opcoes;
  return [valorAtual, ...opcoes];
}

export default function GradeVariacoes({ linhas, onChange, coresOpcoes, tamanhosOpcoes, disabled }) {
  function atualizar(idx, patch) {
    onChange(linhas.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function remover(idx) {
    onChange(linhas.filter((_, i) => i !== idx));
  }

  function adicionar() {
    onChange([...linhas, { cor: '', tamanho: '', quantidade: '' }]);
  }

  const total = linhas.reduce((soma, l) => soma + (Number(l.quantidade) || 0), 0);

  return (
    <div className="grade-variacoes">
      {linhas.length > 0 && (
        <div className="grade-variacoes-cabecalho">
          <span>Cor</span>
          <span>Tamanho</span>
          <span>Quantidade</span>
          <span />
        </div>
      )}
      {linhas.map((linha, idx) => (
        <div key={idx} className="grade-variacoes-linha">
          <Select
            value={linha.cor || ''}
            onChange={(e) => atualizar(idx, { cor: e.target.value })}
            disabled={disabled}
            placeholder="Cor…"
          >
            {opcoesComValorAtual(coresOpcoes, linha.cor).map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select
            value={linha.tamanho || ''}
            onChange={(e) => atualizar(idx, { tamanho: e.target.value })}
            disabled={disabled}
            placeholder="Tamanho…"
          >
            {opcoesComValorAtual(tamanhosOpcoes, linha.tamanho).map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          <input
            type="number"
            min="0"
            value={linha.quantidade ?? ''}
            onChange={(e) => atualizar(idx, { quantidade: e.target.value })}
            disabled={disabled}
            placeholder="0"
          />
          {!disabled && (
            <button type="button" className="icon-btn" onClick={() => remover(idx)} aria-label="Remover variação">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button type="button" className="btn btn-ghost" style={{ marginTop: linhas.length > 0 ? 8 : 0 }} onClick={adicionar}>
          <Plus size={13} /> Adicionar variação
        </button>
      )}
      {linhas.length > 0 && (
        <div className="grade-variacoes-total">Total: <strong>{total}</strong> peça(s)</div>
      )}
      {linhas.length === 0 && disabled && (
        <p className="page-sub" style={{ margin: 0 }}>Nenhuma variação lançada.</p>
      )}
    </div>
  );
}
