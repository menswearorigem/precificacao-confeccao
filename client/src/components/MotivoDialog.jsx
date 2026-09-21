import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert } from 'lucide-react';

const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctBr = (v) => (v == null ? '?' : `${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

// Pergunta com MOTIVO (21/09/2026). É o `confirmar()` do ConfirmDialog com um
// campo de texto obrigatório — nasceu para a trava do piso de preço: vender
// abaixo do piso não é proibido, mas exige que alguém escreva por quê, e o
// motivo fica gravado com o nome de quem assinou.
//
// Uso: `const motivo = await pedirMotivo('R$ 79,90 fica abaixo do piso...');`
// → string com o motivo, ou null se a pessoa desistiu.
// <MotivoDialogRoot /> é montado uma vez, em App.jsx, ao lado do ConfirmDialogRoot.
let acionarEstado = null;
let resolverPendente = null;

export function pedirMotivo(mensagem, opcoes = {}) {
  return new Promise((resolve) => {
    resolverPendente?.(null);
    resolverPendente = resolve;
    acionarEstado?.({
      aberto: true,
      mensagem,
      titulo: opcoes.titulo || 'Abaixo do piso — diga o motivo',
      confirmarTexto: opcoes.confirmarTexto || 'Assinar e aplicar',
      cancelarTexto: opcoes.cancelarTexto || 'Voltar',
      placeholder: opcoes.placeholder || 'Ex.: queimar a cor que sai de linha; acompanhar concorrente por 7 dias; campanha combinada com a plataforma',
      detalhes: opcoes.detalhes || null,
    });
  });
}

function concluir(valor) {
  acionarEstado?.((s) => ({ ...s, aberto: false }));
  resolverPendente?.(valor);
  resolverPendente = null;
}

// Erro de API com `exige: 'aceitar_abaixo_do_piso'` → pergunta o motivo e
// devolve os campos extras para repetir a chamada. `null` = desistiu.
export async function tratarTravaDoPiso(erro) {
  if (erro?.data?.exige !== 'aceitar_abaixo_do_piso' && erro?.data?.exige !== 'motivo_piso') return null;
  const d = erro.data || {};
  const detalhes = Array.isArray(d.itens) && d.itens.length > 0
    ? d.itens.slice(0, 8).map((i) => `${brl(i.preco)} contra piso de ${brl(i.piso)} (margem ${pctBr(i.margem)} · mínimo ${pctBr(i.margem_minima)})`)
    : (d.piso != null ? [`Piso ${brl(d.piso)} · margem neste preço ${pctBr(d.margem)} · mínimo ${pctBr(d.margemMinima)}${d.regra ? ` · ${d.regra}` : ''}`] : null);
  const motivo = await pedirMotivo(erro.message, { detalhes });
  if (!motivo) return null;
  return { aceitar_abaixo_do_piso: true, motivo_piso: motivo };
}

export function MotivoDialogRoot() {
  const [estado, setEstado] = useState({ aberto: false, mensagem: '', titulo: '', confirmarTexto: '', cancelarTexto: '', placeholder: '', detalhes: null });
  const [texto, setTexto] = useState('');

  useEffect(() => {
    acionarEstado = (v) => { setEstado(v); if (typeof v === 'object' && v.aberto) setTexto(''); };
    return () => { acionarEstado = null; };
  }, []);

  useEffect(() => {
    if (!estado.aberto) return undefined;
    function aoTeclar(e) { if (e.key === 'Escape') { e.preventDefault(); concluir(null); } }
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [estado.aberto]);

  if (!estado.aberto) return null;
  const pronto = texto.trim().length >= 4;

  return createPortal(
    <div className="viagem-modal-overlay confirm-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) concluir(null); }}>
      <div className="card confirm-modal motivo-modal" role="alertdialog" aria-modal="true">
        <div className="confirm-modal-icone perigo"><ShieldAlert size={20} /></div>
        <div className="confirm-modal-titulo">{estado.titulo}</div>
        <p className="confirm-modal-texto">{estado.mensagem}</p>
        {estado.detalhes && (
          <ul className="motivo-modal-detalhes">{estado.detalhes.map((d) => <li key={d}>{d}</li>)}</ul>
        )}
        <textarea
          className="motivo-modal-texto"
          rows={3}
          placeholder={estado.placeholder}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          autoFocus
        />
        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={() => concluir(null)}>{estado.cancelarTexto}</button>
          <button type="button" className="btn btn-danger" disabled={!pronto} onClick={() => concluir(texto.trim())}>{estado.confirmarTexto}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
