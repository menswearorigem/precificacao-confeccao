import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, HelpCircle } from 'lucide-react';

// Substituto do window.confirm() nativo do navegador (que mostra o domínio
// do site e não dá pra estilizar) por um modal com a cara do sistema.
// Uso: `if (!(await confirmar('Remover isso?'))) return;` no lugar de
// `if (!confirm('Remover isso?')) return;` — mesma lógica, só que assíncrona.
// <ConfirmDialogRoot /> é montado uma única vez (em App.jsx) e essa função
// só dispara ele por fora, sem precisar de Context em cada tela.
let acionarEstado = null;
let resolverPendente = null;

export function confirmar(mensagem, opcoes = {}) {
  return new Promise((resolve) => {
    resolverPendente?.(false); // uma pergunta pendente nunca fica presa se outra chegar antes de responder
    resolverPendente = resolve;
    acionarEstado?.({
      aberto: true,
      mensagem,
      titulo: opcoes.titulo || (opcoes.perigo === false ? 'Confirmar' : 'Confirmar exclusão'),
      confirmarTexto: opcoes.confirmarTexto || 'Confirmar',
      cancelarTexto: opcoes.cancelarTexto || 'Cancelar',
      perigo: opcoes.perigo !== false,
    });
  });
}

function concluir(valor) {
  acionarEstado?.((s) => ({ ...s, aberto: false }));
  resolverPendente?.(valor);
  resolverPendente = null;
}

export function ConfirmDialogRoot() {
  const [estado, setEstado] = useState({
    aberto: false, mensagem: '', titulo: '', confirmarTexto: '', cancelarTexto: '', perigo: true,
  });

  useEffect(() => {
    acionarEstado = setEstado;
    return () => { acionarEstado = null; };
  }, []);

  useEffect(() => {
    if (!estado.aberto) return undefined;
    function aoTeclar(e) {
      if (e.key === 'Escape') { e.preventDefault(); concluir(false); }
      if (e.key === 'Enter') { e.preventDefault(); concluir(true); }
    }
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [estado.aberto]);

  if (!estado.aberto) return null;

  return createPortal(
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) concluir(false); }}>
      <div className="card confirm-modal" role="alertdialog" aria-modal="true">
        <div className={'confirm-modal-icone' + (estado.perigo ? ' perigo' : '')}>
          {estado.perigo ? <AlertTriangle size={20} /> : <HelpCircle size={20} />}
        </div>
        <div className="confirm-modal-titulo">{estado.titulo}</div>
        <p className="confirm-modal-texto">{estado.mensagem}</p>
        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={() => concluir(false)}>{estado.cancelarTexto}</button>
          <button
            type="button"
            className={'btn ' + (estado.perigo ? 'btn-danger' : 'btn-primary')}
            onClick={() => concluir(true)}
            autoFocus
          >
            {estado.confirmarTexto}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
