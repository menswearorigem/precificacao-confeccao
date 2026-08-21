import { useEffect, useRef, useState } from 'react';

// Envolve uma <table className="data-table"> já existente (a marcação de
// cada página continua igual — só a moldura muda) com: cabeçalho fixo ao
// rolar, primeira coluna congelada, e uma sombra na borda que só aparece
// quando tem conteúdo escondido daquele lado (senão, tabela estreita nunca
// precisaria da sombra). Densidade 'confortavel' (padrão) ou 'compacta'
// controla o espaçamento das células via CSS.
export default function DataTable({ children, densidade = 'confortavel', className = '' }) {
  const wrapRef = useRef(null);
  const [sombraEsq, setSombraEsq] = useState(false);
  const [sombraDir, setSombraDir] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    function atualizar() {
      setSombraEsq(el.scrollLeft > 2);
      setSombraDir(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    }
    atualizar();
    el.addEventListener('scroll', atualizar, { passive: true });
    window.addEventListener('resize', atualizar);
    const obs = new ResizeObserver(atualizar);
    obs.observe(el);
    return () => {
      el.removeEventListener('scroll', atualizar);
      window.removeEventListener('resize', atualizar);
      obs.disconnect();
    };
  }, [children]);

  const classes = [
    'data-table-outer',
    `densidade-${densidade}`,
    sombraEsq && 'sombra-esq',
    sombraDir && 'sombra-dir',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className="data-table-wrap" ref={wrapRef}>{children}</div>
    </div>
  );
}
