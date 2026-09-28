import { useMemo, useState } from 'react';
import { CartaoGrafico, GraficoColunas, BarraRanking } from './graficos';
import { usePaletaGrafico } from '../lib/coresGrafico';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import { formatQtd, numeroBr, brl } from '../lib/format';

// Gráficos da aba "Vendas por Anúncio" (Marketplace → Métricas), 28/09/2026.
//
// Os dois gráficos recebem a MESMA lista de anúncios que a tabela da aba
// mostra — já com período, plataforma, loja, Full e a BUSCA aplicados. A
// busca é feita no front (a tabela sempre filtrou assim); por isso o backend
// passou a mandar a série diária de cada anúncio, e a conta por dia é feita
// aqui em cima do que sobrou do filtro. Resultado: a soma das colunas bate
// com o cartão "Unidades Vendidas" e com a coluna "Unid. Vendidas" da tabela,
// qualquer que seja o filtro.
//
// "Unidades" é o que a tabela chama de unidade: o que o cliente comprou (um
// kit 4x vendido = 1 unidade). Não é peça de estoque.

const ROTULO_PARA_CHAVE = Object.fromEntries(
  Object.entries(PLATAFORMA_LABEL).map(([chave, rotulo]) => [rotulo, chave]),
);
ROTULO_PARA_CHAVE.Shein = 'shein';

const ORDEM_PLATAFORMAS = ['shopee', 'mercado_livre', 'tiktok_shop', 'shein', 'outros'];
const NOME_PLATAFORMA = { ...PLATAFORMA_LABEL, shein: 'Shein', outros: 'Outros canais' };
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const LIMITE_DIAS_POR_DIA = 31;
const TOP_RANKING = 15;

export function plataformaDoAnuncio(anuncio) {
  return ROTULO_PARA_CHAVE[anuncio.canalVenda] || 'outros';
}

function corDaPlataforma(paleta, chave) {
  return paleta.plataformas?.[chave] || paleta.neutro;
}

// "Kit 4x — BLUSINHA…" → "Kit 4x"; sem kit → "Avulsa". Olha a descrição
// (kit cadastrado no Hub) e o título do anúncio no marketplace (item que casou
// com o produto avulso, mas é vendido como kit no anúncio).
function tipoDoAnuncio(anuncio) {
  const padrao = /kit\s*(?:c\/\s*|com\s*)?(\d+)\s*(?:x|p[çc]|pe[çc]as?|un)/i;
  const m = padrao.exec(anuncio.descricao || '') || padrao.exec(anuncio.tituloAnuncio || '');
  return m ? `Kit ${m[1]}x` : 'Avulsa';
}

// Datas como 'YYYY-MM-DD' andando em UTC: é só calendário, e UTC não tem
// horário de verão para pular ou repetir um dia.
function somarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diaDaSemana(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}
function ddmm(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}
function listaDeDias(inicio, fim) {
  const dias = [];
  if (!inicio || !fim || inicio > fim) return dias;
  for (let d = inicio; d <= fim; d = somarDias(d, 1)) dias.push(d);
  return dias;
}

function Chips({ opcoes, valor, onChange, rotulo }) {
  return (
    <span className="mp-seg mp-seg-cheio" role="group" aria-label={rotulo}>
      {opcoes.map(([chave, texto]) => (
        <button key={chave} type="button" aria-pressed={valor === chave} onClick={() => onChange(chave)}>
          {texto}
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Vendas por dia (ou por semana, em período longo)
// ---------------------------------------------------------------------------

export function GraficoVendasPorDia({ anuncios, dataInicio, dataFim }) {
  const paleta = usePaletaGrafico();
  const [metrica, setMetrica] = useState('unidades');

  const { dados, series, legenda, media, porSemana, total } = useMemo(() => {
    // Sem período fechado (não acontece nesta tela hoje, mas o componente não
    // pode inventar um): usa do primeiro ao último dia com venda.
    const diasComVenda = anuncios.flatMap((a) => (a.porDia || []).map((d) => d.data)).sort();
    const inicio = dataInicio || diasComVenda[0];
    const fim = dataFim || diasComVenda[diasComVenda.length - 1];
    const dias = listaDeDias(inicio, fim);
    const semanal = dias.length > LIMITE_DIAS_POR_DIA;

    // Balde = o dia, ou a segunda-feira da semana (semana começa na segunda,
    // como a equipe fecha a semana). A 1ª e a última semana podem ser
    // parciais: o tooltip diz as datas de verdade que o balde cobre.
    const baldeDe = (iso) => (semanal ? somarDias(iso, -((diaDaSemana(iso) + 6) % 7)) : iso);
    const baldes = new Map();
    for (const d of dias) {
      const chave = baldeDe(d);
      if (!baldes.has(chave)) baldes.set(chave, { de: d, ate: d, porPlataforma: new Map() });
      baldes.get(chave).ate = d;
    }

    const presentes = new Set();
    for (const a of anuncios) {
      const plat = plataformaDoAnuncio(a);
      for (const d of a.porDia || []) {
        const balde = baldes.get(baldeDe(d.data));
        if (!balde) continue; // venda fora da janela pedida — não deveria vir
        if (!balde.porPlataforma.has(plat)) balde.porPlataforma.set(plat, { unidades: 0, pedidos: new Set() });
        const acc = balde.porPlataforma.get(plat);
        acc.unidades += d.unidades;
        for (const id of d.pedidos || []) acc.pedidos.add(id);
        presentes.add(plat);
      }
    }

    const plataformas = ORDEM_PLATAFORMAS.filter((p) => presentes.has(p));
    const totaisPlat = Object.fromEntries(plataformas.map((p) => [p, 0]));
    const linhas = [...baldes.entries()].map(([, b]) => {
      const linha = {
        rotulo: ddmm(b.de),
        titulo: semanal
          ? (b.de === b.ate ? `${DIAS_SEMANA[diaDaSemana(b.de)]}, ${ddmm(b.de)}` : `${ddmm(b.de)} a ${ddmm(b.ate)}`)
          : `${DIAS_SEMANA[diaDaSemana(b.de)]}, ${ddmm(b.de)}`,
      };
      for (const p of plataformas) {
        const acc = b.porPlataforma.get(p);
        // Pedidos é contagem de pedidos DISTINTOS no balde (um pedido com
        // dois anúncios conta uma vez), por isso vem de um conjunto de ids.
        const v = acc ? (metrica === 'pedidos' ? acc.pedidos.size : acc.unidades) : 0;
        linha[p] = v;
        totaisPlat[p] += v;
      }
      return linha;
    });
    const soma = Object.values(totaisPlat).reduce((s, v) => s + v, 0);

    return {
      dados: linhas,
      series: plataformas.map((p) => ({ chave: p, nome: NOME_PLATAFORMA[p], cor: corDaPlataforma(paleta, p) })),
      legenda: plataformas.map((p) => ({ rotulo: NOME_PLATAFORMA[p], valor: formatQtd(totaisPlat[p]), cor: corDaPlataforma(paleta, p) })),
      media: linhas.length > 0 ? soma / linhas.length : 0,
      porSemana: semanal,
      total: soma,
    };
  }, [anuncios, dataInicio, dataFim, metrica, paleta]);

  const unidadeTempo = porSemana ? 'semana' : 'dia';
  const nomeMetrica = metrica === 'pedidos' ? 'pedidos' : 'unidades';

  return (
    <CartaoGrafico
      titulo={porSemana ? 'Vendas por semana' : 'Vendas por dia'}
      explicacao={`${formatQtd(total)} ${nomeMetrica} no período, média de ${numeroBr(media, media < 10 ? 1 : 0)} por ${unidadeTempo}.${metrica === 'unidades' ? ' Kit conta como 1 unidade, igual à tabela.' : ' Pedido com dois anúncios conta uma vez.'}`}
      acoes={(
        <Chips
          rotulo="Métrica do gráfico"
          valor={metrica}
          onChange={setMetrica}
          opcoes={[['unidades', 'Unidades'], ['pedidos', 'Pedidos']]}
        />
      )}
      altura={280}
      legenda={series.length > 1 ? legenda : undefined}
      vazio={total === 0 ? 'Nenhuma venda com esses filtros.' : null}
    >
      <GraficoColunas
        dados={dados}
        series={series}
        formato="numero"
        altura={280}
        empilhado
        linhaMedia={{ valor: media, rotulo: `média ${numeroBr(media, media < 10 ? 1 : 0)}/${porSemana ? 'sem.' : 'dia'}` }}
        campoTituloTooltip="titulo"
        totalNoTooltip
        intervaloX="preserveStartEnd"
      />
    </CartaoGrafico>
  );
}

// ---------------------------------------------------------------------------
// Ranking por anúncio
// ---------------------------------------------------------------------------

const METRICAS_RANKING = {
  faturado: { rotulo: 'Faturamento', formato: 'moeda', valor: (a) => a.totalFaturado },
  unidades: { rotulo: 'Unidades', formato: 'numero', valor: (a) => a.unidadesVendidas },
  pedidos: { rotulo: 'Pedidos', formato: 'numero', valor: (a) => a.pedidosValidos },
};

export function RankingAnuncios({ anuncios }) {
  const paleta = usePaletaGrafico();
  const [metrica, setMetrica] = useState('faturado');
  const def = METRICAS_RANKING[metrica];

  const itens = useMemo(() => {
    const ordenados = [...anuncios].sort((a, b) => def.valor(b) - def.valor(a));
    const topo = ordenados.slice(0, TOP_RANKING).map((a) => {
      const plat = plataformaDoAnuncio(a);
      return {
        rotulo: `${a.referencia} · ${tipoDoAnuncio(a)}`,
        detalhe: `${a.anuncioId || 'sem ID gravado'} · ${NOME_PLATAFORMA[plat] || a.canalVenda || '—'}`,
        valor: def.valor(a),
        cor: corDaPlataforma(paleta, plat),
      };
    });
    const resto = ordenados.slice(TOP_RANKING);
    if (resto.length > 0) {
      // Pedidos de "Outros" contados por id: um pedido com dois anúncios do
      // resto somaria duas vezes se somássemos pedidosValidos.
      let valor;
      if (metrica === 'pedidos') {
        const ids = new Set();
        for (const a of resto) for (const d of a.porDia || []) for (const id of d.pedidos || []) ids.add(id);
        valor = ids.size;
      } else {
        valor = resto.reduce((s, a) => s + def.valor(a), 0);
      }
      topo.push({
        rotulo: `Outros (${formatQtd(resto.length)} anúncios)`,
        detalhe: 'soma dos anúncios abaixo do 15º',
        valor,
        cor: paleta.neutro,
      });
    }
    return topo;
  }, [anuncios, metrica, def, paleta]);

  // Total de pedidos por id, pelo mesmo motivo do "Outros" acima.
  const total = useMemo(() => {
    if (metrica !== 'pedidos') return anuncios.reduce((s, a) => s + def.valor(a), 0);
    const ids = new Set();
    for (const a of anuncios) for (const d of a.porDia || []) for (const id of d.pedidos || []) ids.add(id);
    return ids.size;
  }, [anuncios, metrica, def]);

  return (
    <CartaoGrafico
      titulo="Quem vende mais"
      explicacao={`Anúncios em ordem de ${def.rotulo.toLowerCase()}; a cor é a plataforma. Total: ${def.formato === 'moeda' ? brl(total) : formatQtd(total)}.`}
      acoes={(
        <Chips
          rotulo="Ordenar ranking por"
          valor={metrica}
          onChange={setMetrica}
          opcoes={Object.entries(METRICAS_RANKING).map(([k, m]) => [k, m.rotulo])}
        />
      )}
      altura={anuncios.length === 0 ? 140 : 'auto'}
      vazio={anuncios.length === 0 ? 'Nenhum anúncio com esses filtros.' : null}
    >
      <BarraRanking itens={itens} formato={def.formato} />
    </CartaoGrafico>
  );
}
