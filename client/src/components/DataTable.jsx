import { useEffect, useRef, useState } from 'react';
import { useDensidade } from '../contexts/DensidadeContext';

// Envolve uma <table className="data-table"> já existente (a marcação de
// cada página continua igual — só a moldura muda) com: cabeçalho fixo ao
// rolar, primeira coluna congelada, e uma sombra na borda que só aparece
// quando tem conteúdo escondido daquele lado (senão, tabela estreita nunca
// precisaria da sombra). Densidade 'confortavel' ou 'compacta' controla o
// espaçamento das células via CSS — por padrão segue a preferência global
// (DensidadeContext, alternada no cabeçalho); passar a prop explicitamente
// sobrepõe essa preferência só para esta tabela específica.
export default function DataTable({ children, densidade, className = '' }) {
  const contexto = useDensidade();
  const densidadeFinal = densidade || contexto?.densidade || 'confortavel';
  const wrapRef = useRef(null);
  const [sombraEsq, setSombraEsq] = useState(false);
  const [sombraDir, setSombraDir] = useState(false);
  const [precisaRolar, setPrecisaRolar] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    function atualizar() {
      // `overflow-x: auto` faz o navegador tratar TAMBÉM o eixo Y como área
      // de rolagem — e um thead com position:sticky gruda na área de rolagem
      // mais próxima, que nesse caso nunca rola. Resultado: o cabeçalho não
      // acompanhava a rolagem da página. Aqui a moldura só liga a rolagem
      // lateral quando a tabela de fato não cabe; quando cabe (o normal
      // depois do agrupamento de colunas), o overflow sai do caminho e o
      // cabeçalho gruda no topo da tela de verdade.
      // A medida usa a largura da TABELA (não o scrollWidth da moldura), pra
      // não ficar oscilando entre ligado/desligado a cada re-medição.
      const tabela = el.querySelector('table');
      const larguraConteudo = tabela ? tabela.scrollWidth : el.scrollWidth;
      // Histerese: liga com folga e só desliga quando sobra espaço de novo —
      // sem isso, uma tabela que fica a poucos pixels do limite podia ficar
      // alternando entre "rola" e "não rola" a cada re-medição.
      setPrecisaRolar((antes) => (antes
        ? larguraConteudo > el.clientWidth
        : larguraConteudo > el.clientWidth + 4));
      setSombraEsq(el.scrollLeft > 2);
      setSombraDir(el.scrollLeft + el.clientWidth < larguraConteudo - 2);
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
    `densidade-${densidadeFinal}`,
    precisaRolar ? 'rola-lateral' : 'sem-rolagem-lateral',
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
