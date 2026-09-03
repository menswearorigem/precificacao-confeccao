import { useEffect, useState } from 'react';

// Paleta dos gráficos, lida do tema.
//
// Por que ler do CSS em vez de escrever "#b5651d" no componente: a REGRA 3 diz
// que nenhuma cor mora solta em componente — cor é variável, declarada nos três
// blocos de tema. Só que o Recharts precisa do valor RESOLVIDO em duas
// situações: quando o gráfico vira imagem para o PDF (um `var(--gr-1)` dentro
// de um SVG serializado não resolve, e o gráfico sai preto), e quando a cor
// precisa entrar num gradiente. Então a fonte da verdade continua sendo o
// theme.css; aqui só se lê o que ele definiu.

const VARIAVEIS_SERIE = ['--gr-1', '--gr-2', '--gr-3', '--gr-4', '--gr-5', '--gr-6', '--gr-7', '--gr-8'];

const VARIAVEIS_APOIO = {
  positivo: '--gr-positivo',
  negativo: '--gr-negativo',
  neutro: '--gr-neutro',
  grade: '--gr-grade',
  eixo: '--gr-eixo',
  rotulo: '--gr-rotulo',
  superficie: '--surface',
  borda: '--border',
  tinta: '--ink',
  tintaSuave: '--ink-soft',
};

// Fallback usado só se a folha de estilo ainda não carregou (primeiro paint) —
// são os mesmos valores do bloco claro do theme.css.
const RESERVA = {
  series: ['#b5651d', '#33512f', '#2c4a63', '#9c7a3c', '#5c3157', '#1f6f66', '#7a2a1d', '#6b4423'],
  positivo: '#33512f',
  negativo: '#7a2a1d',
  neutro: '#96897a',
  grade: '#ebe2cd',
  eixo: '#ddd0b4',
  rotulo: '#6b5d4d',
  superficie: '#fffdf9',
  borda: '#ddd0b4',
  tinta: '#2a1d10',
  tintaSuave: '#6b5d4d',
};

function ler(estilo, variavel, reserva) {
  const valor = estilo.getPropertyValue(variavel).trim();
  return valor || reserva;
}

export function lerPaleta() {
  if (typeof window === 'undefined') return RESERVA;
  const estilo = getComputedStyle(document.documentElement);
  const paleta = {
    series: VARIAVEIS_SERIE.map((v, i) => ler(estilo, v, RESERVA.series[i])),
  };
  for (const [nome, variavel] of Object.entries(VARIAVEIS_APOIO)) {
    paleta[nome] = ler(estilo, variavel, RESERVA[nome] || RESERVA.neutro);
  }
  return paleta;
}

// Recalcula quando o tema muda — pelo botão (atributo `data-theme` na raiz) ou
// pela preferência do sistema. Sem isso, trocar pro modo escuro deixava os
// gráficos com as cores do claro até recarregar a página.
export function usePaletaGrafico() {
  const [paleta, setPaleta] = useState(lerPaleta);

  useEffect(() => {
    const atualizar = () => setPaleta(lerPaleta());
    atualizar();
    const observador = new MutationObserver(atualizar);
    observador.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    const consulta = window.matchMedia('(prefers-color-scheme: dark)');
    consulta.addEventListener('change', atualizar);
    return () => {
      observador.disconnect();
      consulta.removeEventListener('change', atualizar);
    };
  }, []);

  return paleta;
}

// Cor estável por rótulo: a mesma categoria fica com a mesma cor no gráfico de
// rosca, no de barras e na legenda — inclusive depois de reordenar a lista.
export function corPorIndice(paleta, indice) {
  const series = paleta?.series?.length ? paleta.series : RESERVA.series;
  return series[indice % series.length];
}

export function mapaDeCores(paleta, rotulos) {
  const mapa = {};
  rotulos.forEach((rotulo, i) => { mapa[rotulo] = corPorIndice(paleta, i); });
  return mapa;
}
