import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// Botão pequeno de copiar — usado ao lado de número de pedido (e qualquer
// outro valor que o usuário normalmente precisaria selecionar manualmente
// pra copiar). Alterna pra um ícone de check por um instante como
// confirmação visual, sem precisar de toast/alerta separado.
export default function CopiarBotao({ valor, label = 'Copiar', className = '', size = 12 }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar(e) {
    e.stopPropagation();
    const texto = String(valor ?? '');
    if (!texto) return;
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      return;
    }
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1200);
  }

  if (valor === null || valor === undefined || valor === '') return null;

  return (
    <button
      type="button"
      className={'copiar-btn' + (copiado ? ' copiado' : '') + (className ? ` ${className}` : '')}
      onClick={copiar}
      title={copiado ? 'Copiado!' : label}
      aria-label={label}
    >
      {copiado ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
