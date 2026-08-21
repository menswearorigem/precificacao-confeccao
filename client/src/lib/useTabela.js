import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export const TAMANHOS_PAGINA = [25, 50, 100];

// Ordenação + paginação client-side compartilhada pelas listas grandes do
// sistema — estado (coluna, direção, página, tamanho) mora na URL pra dar
// pra compartilhar o link exatamente como a tela está aberta. `colunas`
// mapeia a chave de cada coluna ordenável pra uma função que extrai o
// valor comparável do item (ex.: { referencia: (p) => p.referencia }).
// Trabalha sobre a lista que a página já filtrou (busca/período/etc.) —
// não busca nada de novo, só ordena e fatia o que já teria sido mostrado.
export function useTabela(lista, { colunas, colunaPadrao, direcaoPadrao = 'asc', tamanhoPadrao = 25 }) {
  const [searchParams, setSearchParams] = useSearchParams();

  const ordemUrl = searchParams.get('ordem');
  const coluna = ordemUrl && colunas[ordemUrl] ? ordemUrl : colunaPadrao;
  const dirUrl = searchParams.get('dir');
  const direcao = dirUrl === 'desc' || dirUrl === 'asc' ? dirUrl : direcaoPadrao;
  const tamanhoUrl = Number(searchParams.get('tamanho'));
  const tamanho = TAMANHOS_PAGINA.includes(tamanhoUrl) ? tamanhoUrl : tamanhoPadrao;

  const ordenada = useMemo(() => {
    const extrair = colunas[coluna];
    if (!extrair) return lista;
    const copia = [...lista];
    copia.sort((a, b) => {
      const va = extrair(a);
      const vb = extrair(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = (typeof va === 'number' && typeof vb === 'number')
        ? va - vb
        : String(va).localeCompare(String(vb), 'pt-BR', { numeric: true, sensitivity: 'base' });
      return direcao === 'asc' ? cmp : -cmp;
    });
    return copia;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lista, coluna, direcao]);

  const totalItens = ordenada.length;
  const totalPaginas = Math.max(1, Math.ceil(totalItens / tamanho));
  const paginaUrl = Number(searchParams.get('pagina')) || 1;
  const pagina = Math.min(Math.max(1, paginaUrl), totalPaginas);

  const inicio = totalItens === 0 ? 0 : (pagina - 1) * tamanho;
  const fim = Math.min(totalItens, inicio + tamanho);
  const itensPagina = useMemo(() => ordenada.slice(inicio, fim), [ordenada, inicio, fim]);

  function atualizarParams(patch) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) next.set(k, String(v));
      return next;
    }, { replace: true });
  }

  function ordenarPor(chave) {
    if (coluna === chave) atualizarParams({ ordem: chave, dir: direcao === 'asc' ? 'desc' : 'asc', pagina: 1 });
    else atualizarParams({ ordem: chave, dir: 'asc', pagina: 1 });
  }

  return {
    itensPagina,
    totalItens,
    pagina,
    totalPaginas,
    tamanho,
    tamanhos: TAMANHOS_PAGINA,
    coluna,
    direcao,
    ordenarPor,
    inicio,
    fim,
    setPagina: (p) => atualizarParams({ pagina: p }),
    setTamanho: (t) => atualizarParams({ tamanho: t, pagina: 1 }),
  };
}
