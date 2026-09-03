import { useMemo, useRef } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { brl, formatQtd, numeroBr } from '../lib/format';
import { usePaletaGrafico, corPorIndice } from '../lib/coresGrafico';

// Biblioteca de gráficos compartilhada pelos módulos Compras e Financeiro.
//
// Três decisões que valem para todos eles:
//
// 1. Cor vem do tema (usePaletaGrafico), nunca escrita aqui — REGRA 3.
// 2. Todo gráfico mora dentro de um <CartaoGrafico>, que carrega o título, a
//    frase que explica o gráfico em português comum e a referência usada para
//    virar imagem no PDF. Gráfico sem legenda escrita é enfeite; com ela, é
//    informação.
// 3. Nenhum gráfico calcula nada além de somar o que recebeu. Percentual de
//    composição é parte ÷ total (nunca média de percentuais) e o denominador
//    aparece escrito na tela — REGRA 2.

const FONTE = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export const FORMATADORES = {
  moeda: brl,
  numero: formatQtd,
  decimal: (v) => numeroBr(v, 2),
};

// Eixo de dinheiro em escala compacta ("R$ 12,4 mil"): com o valor cheio, um
// eixo de milhão ocupa 120px de largura e come metade do gráfico.
export function moedaCompacta(valor) {
  const n = Number(valor) || 0;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? '-' : ''}R$ ${numeroBr(abs / 1_000_000, 1)} mi`;
  if (abs >= 1_000) return `${n < 0 ? '-' : ''}R$ ${numeroBr(abs / 1_000, abs >= 10_000 ? 0 : 1)} mil`;
  return brl(n);
}

// ---------------------------------------------------------------------------
// Casca
// ---------------------------------------------------------------------------

// `refGrafico` é o que o motor de relatório usa para transformar o gráfico em
// imagem no PDF (ver capturarGrafico, abaixo).
// `legenda`: [{ rotulo, valor, cor }] — obrigatória sempre que o gráfico tem
// mais de uma série. Na tela, o nome de cada série só apareceria ao passar o
// mouse; no PDF não existe mouse, e um gráfico de três cores sem dizer o que
// é cada cor não informa nada.
//
// A `refGrafico` embrulha o desenho E a legenda de propósito: é esse elemento
// que vira imagem, e a legenda precisa ir junto (ver capturarGrafico).
export function CartaoGrafico({ titulo, explicacao, acoes, children, refGrafico, altura = 260, rodape, vazio, legenda }) {
  return (
    <div className="card grafico-card">
      <div className="card-head-linha">
        <div className="card-head">{titulo}</div>
        {acoes}
      </div>
      {explicacao && <p className="grafico-explicacao">{explicacao}</p>}
      {vazio ? (
        <div className="grafico-vazio" style={{ height: altura }}>{vazio}</div>
      ) : (
        <div ref={refGrafico}>
          <div className="grafico-area" style={{ height: altura }}>{children}</div>
          {legenda?.length > 0 && <LegendaSeries itens={legenda} />}
        </div>
      )}
      {rodape && <div className="grafico-rodape">{rodape}</div>}
    </div>
  );
}

// Mesmas classes da legenda da rosca — é o que faz a captura para o PDF
// encontrá-la sem saber de que gráfico veio.
export function LegendaSeries({ itens }) {
  return (
    <ul className="grafico-legenda grafico-legenda-inline">
      {itens.map((item) => (
        <li key={item.rotulo}>
          <span className="grafico-legenda-cor" style={{ background: item.cor }} />
          <span className="grafico-legenda-nome">{item.rotulo}</span>
          {item.valor !== undefined && <span className="mono grafico-legenda-valor">{item.valor}</span>}
        </li>
      ))}
    </ul>
  );
}

// Cor da série i, para a tela montar a legenda com a mesma cor do desenho.
export { corPorIndice };

export function useRefGrafico() {
  return useRef(null);
}

function CaixaTooltip({ titulo, linhas }) {
  return (
    <div className="grafico-tooltip">
      {titulo && <div className="grafico-tooltip-titulo">{titulo}</div>}
      {linhas.map((l) => (
        <div className="grafico-tooltip-linha" key={l.chave}>
          {l.cor && <span className="grafico-tooltip-bolinha" style={{ background: l.cor }} />}
          <span className="grafico-tooltip-nome">{l.nome}</span>
          <span className="mono grafico-tooltip-valor">{l.valor}</span>
        </div>
      ))}
    </div>
  );
}

function tooltipPadrao(formatar) {
  return function Conteudo({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    return (
      <CaixaTooltip
        titulo={label}
        linhas={payload.map((p) => ({
          chave: `${p.dataKey}`,
          nome: p.name,
          cor: p.color || p.payload?.cor,
          valor: formatar(p.value),
        }))}
      />
    );
  };
}

// ---------------------------------------------------------------------------
// Evolução no tempo (área)
// ---------------------------------------------------------------------------

// `series`: [{ chave, nome, cor? }]. `rotuloX`: campo do eixo horizontal.
export function GraficoEvolucao({ dados, series, rotuloX = 'rotulo', formato = 'moeda', altura = 260, empilhado }) {
  const paleta = usePaletaGrafico();
  const formatar = FORMATADORES[formato] || FORMATADORES.moeda;
  const Tip = useMemo(() => tooltipPadrao(formatar), [formato]); // eslint-disable-line react-hooks/exhaustive-deps
  const tick = { fontSize: 11.5, fontFamily: FONTE, fill: paleta.rotulo };

  return (
    <ResponsiveContainer width="100%" height={altura}>
      {/* margin.top: o rótulo mais alto do eixo Y quebra em duas linhas
          ("R$ 360 / mil") e, sem folga, a primeira some no corte da imagem
          exportada. */}
      <AreaChart data={dados} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s, i) => {
            const cor = s.cor || corPorIndice(paleta, i);
            return (
              <linearGradient key={s.chave} id={`grad-${s.chave}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="4%" stopColor={cor} stopOpacity={0.26} />
                <stop offset="96%" stopColor={cor} stopOpacity={0.02} />
              </linearGradient>
            );
          })}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={paleta.grade} vertical={false} />
        <XAxis dataKey={rotuloX} tick={tick} axisLine={{ stroke: paleta.eixo }} tickLine={false} minTickGap={18} />
        <YAxis
          tick={tick}
          tickFormatter={formato === 'moeda' ? moedaCompacta : formatar}
          width={formato === 'moeda' ? 76 : 52}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<Tip />} cursor={{ stroke: paleta.eixo }} />
        {series.map((s, i) => {
          const cor = s.cor || corPorIndice(paleta, i);
          return (
            <Area
              key={s.chave}
              type="monotone"
              dataKey={s.chave}
              name={s.nome}
              stackId={empilhado ? 'pilha' : undefined}
              stroke={cor}
              fill={`url(#grad-${s.chave})`}
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: paleta.superficie }}
            />
          );
        })}
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Colunas (comparação entre períodos ou categorias)
// ---------------------------------------------------------------------------

export function GraficoColunas({ dados, series, rotuloX = 'rotulo', formato = 'moeda', altura = 260, empilhado, comZero }) {
  const paleta = usePaletaGrafico();
  const formatar = FORMATADORES[formato] || FORMATADORES.moeda;
  const Tip = useMemo(() => tooltipPadrao(formatar), [formato]); // eslint-disable-line react-hooks/exhaustive-deps
  const tick = { fontSize: 11.5, fontFamily: FONTE, fill: paleta.rotulo };

  return (
    <ResponsiveContainer width="100%" height={altura}>
      <BarChart data={dados} margin={{ top: 16, right: 12, left: 0, bottom: 0 }} barCategoryGap="24%">
        <CartesianGrid strokeDasharray="3 3" stroke={paleta.grade} vertical={false} />
        <XAxis dataKey={rotuloX} tick={tick} axisLine={{ stroke: paleta.eixo }} tickLine={false} interval={0} />
        <YAxis
          tick={tick}
          tickFormatter={formato === 'moeda' ? moedaCompacta : formatar}
          width={formato === 'moeda' ? 76 : 52}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<Tip />} cursor={{ fill: paleta.grade, fillOpacity: 0.45 }} />
        {/* Linha do zero explícita: sem ela, um gráfico com entradas e saídas
            deixa a pessoa adivinhando onde o positivo vira negativo. */}
        {comZero && <ReferenceLine y={0} stroke={paleta.eixo} />}
        {series.map((s, i) => (
          <Bar
            key={s.chave}
            dataKey={s.chave}
            name={s.nome}
            stackId={empilhado ? 'pilha' : undefined}
            fill={s.cor || corPorIndice(paleta, i)}
            radius={empilhado ? 0 : [5, 5, 0, 0]}
            maxBarSize={54}
          >
            {/* Cor por barra quando a própria linha traz `cor` (ex.: entrada
                verde / saída vermelha no mesmo dataKey). */}
            {dados.some((d) => d.cor) && dados.map((d, idx) => (
              <Cell key={idx} fill={d.cor || s.cor || corPorIndice(paleta, i)} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Linha simples (evolução comparada, sem preenchimento)
// ---------------------------------------------------------------------------

export function GraficoLinha({ dados, series, rotuloX = 'rotulo', formato = 'moeda', altura = 240 }) {
  const paleta = usePaletaGrafico();
  const formatar = FORMATADORES[formato] || FORMATADORES.moeda;
  const Tip = useMemo(() => tooltipPadrao(formatar), [formato]); // eslint-disable-line react-hooks/exhaustive-deps
  const tick = { fontSize: 11.5, fontFamily: FONTE, fill: paleta.rotulo };

  return (
    <ResponsiveContainer width="100%" height={altura}>
      <LineChart data={dados} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={paleta.grade} vertical={false} />
        <XAxis dataKey={rotuloX} tick={tick} axisLine={{ stroke: paleta.eixo }} tickLine={false} minTickGap={18} />
        <YAxis tick={tick} tickFormatter={formato === 'moeda' ? moedaCompacta : formatar} width={formato === 'moeda' ? 76 : 52} axisLine={false} tickLine={false} />
        <Tooltip content={<Tip />} />
        {series.map((s, i) => (
          <Line
            key={s.chave}
            type="monotone"
            dataKey={s.chave}
            name={s.nome}
            stroke={s.cor || corPorIndice(paleta, i)}
            strokeWidth={2.25}
            strokeDasharray={s.tracejada ? '5 4' : undefined}
            dot={false}
            activeDot={{ r: 4.5, strokeWidth: 2, stroke: paleta.superficie }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Rosca de composição
// ---------------------------------------------------------------------------

// `dados`: [{ rotulo, valor }]. O total fica escrito no meio — a pergunta que
// vem junto de "quanto é cada fatia" é sempre "de quanto no total".
export function GraficoRosca({ dados, formato = 'moeda', altura = 260, totalRotulo = 'Total' }) {
  const paleta = usePaletaGrafico();
  const formatar = FORMATADORES[formato] || FORMATADORES.moeda;
  // Fatia negativa não existe numa rosca — o desenho não sabe representar. As
  // saídas entram pelo módulo, e a tela avisa quando isso acontece.
  const fatias = dados.map((d, i) => ({ ...d, valor: Math.abs(Number(d.valor) || 0), cor: d.cor || corPorIndice(paleta, i) }));
  const total = fatias.reduce((s, d) => s + d.valor, 0);

  if (total === 0) return <div className="grafico-vazio" style={{ height: altura }}>Nada a compor no período.</div>;

  return (
    <div className="grafico-rosca">
      <div className="grafico-rosca-desenho" style={{ height: altura }}>
        <ResponsiveContainer width="100%" height={altura}>
          <PieChart>
            <Pie
              data={fatias}
              dataKey="valor"
              nameKey="rotulo"
              innerRadius="58%"
              outerRadius="86%"
              paddingAngle={1.5}
              stroke={paleta.superficie}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {fatias.map((f) => <Cell key={f.rotulo} fill={f.cor} />)}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload;
                return (
                  <CaixaTooltip
                    titulo={p.rotulo}
                    linhas={[
                      { chave: 'v', nome: 'Valor', cor: p.cor, valor: formatar(p.valor) },
                      { chave: 'p', nome: 'Do total', valor: `${numeroBr((p.valor / total) * 100, 1)}%` },
                    ]}
                  />
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="grafico-rosca-centro">
          <span className="grafico-rosca-centro-label">{totalRotulo}</span>
          {/* O buraco da rosca é pequeno: um total na casa do milhão escrito
              por extenso transborda por cima do anel. Acima de 12 caracteres,
              cai pra escala compacta ("R$ 1,99 mi"), que continua legível. */}
          <span className="mono grafico-rosca-centro-valor" title={formatar(total)}>
            {(() => {
              const cheio = formatar(total);
              return formato === 'moeda' && cheio.length > 12 ? moedaCompacta(total) : cheio;
            })()}
          </span>
        </div>
      </div>
      <ul className="grafico-legenda">
        {fatias.map((f) => (
          <li key={f.rotulo}>
            <span className="grafico-legenda-cor" style={{ background: f.cor }} />
            <span className="grafico-legenda-nome" title={f.rotulo}>{f.rotulo}</span>
            <span className="mono grafico-legenda-valor">
              {formatar(f.valor)}
              <span className="grafico-legenda-pct">{numeroBr((f.valor / total) * 100, 1)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranking em barra (HTML puro, não SVG)
// ---------------------------------------------------------------------------

// Feito em CSS de propósito: um ranking de 10 fornecedores com nome comprido
// fica ilegível num gráfico de barras do Recharts (o rótulo é cortado), e em
// HTML ele imprime certinho, quebra linha no celular e dá pra clicar.
export function BarraRanking({ itens, formato = 'moeda', aoClicar, vazio = 'Nada no período.' }) {
  const paleta = usePaletaGrafico();
  const formatar = FORMATADORES[formato] || FORMATADORES.moeda;
  const maior = itens.reduce((m, i) => Math.max(m, Math.abs(Number(i.valor) || 0)), 0);
  const total = itens.reduce((s, i) => s + Math.abs(Number(i.valor) || 0), 0);

  if (itens.length === 0) return <div className="grafico-vazio">{vazio}</div>;

  return (
    <ul className="ranking">
      {itens.map((item, i) => {
        const valor = Number(item.valor) || 0;
        const largura = maior > 0 ? Math.max(2, (Math.abs(valor) / maior) * 100) : 0;
        const cor = item.cor || corPorIndice(paleta, i);
        const Elemento = aoClicar ? 'button' : 'div';
        return (
          <li key={item.rotulo + i}>
            <Elemento
              type={aoClicar ? 'button' : undefined}
              className={'ranking-linha' + (aoClicar ? ' ranking-linha-clicavel' : '')}
              onClick={aoClicar ? () => aoClicar(item) : undefined}
            >
              <span className="ranking-posicao mono">{i + 1}</span>
              <span className="ranking-nome" title={item.rotulo}>
                {item.rotulo}
                {item.detalhe && <small>{item.detalhe}</small>}
              </span>
              <span className="ranking-barra"><span style={{ width: `${largura}%`, background: cor }} /></span>
              <span className="ranking-valor mono">{formatar(valor)}</span>
              <span className="ranking-pct mono">{total > 0 ? `${numeroBr((Math.abs(valor) / total) * 100, 1)}%` : '—'}</span>
            </Elemento>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Gráfico -> imagem (para o PDF)
// ---------------------------------------------------------------------------

// Serializa o SVG que o Recharts desenhou e devolve um PNG em data URL. É por
// isso que as cores dos gráficos são valores resolvidos e não `var(--x)`: um
// `var()` dentro de um SVG serializado não tem a quem perguntar e sairia preto.
//
// Falhar aqui não pode derrubar o relatório — sem a imagem, o PDF ainda tem
// todas as tabelas, que é o dado. Devolve null e quem chamou segue sem ela.
// `qualidade`/JPEG em vez de PNG: um gráfico de 1300x560 em PNG sai com ~1,5 MB
// e um relatório com dois gráficos passava de 8 MB — grande demais pra mandar
// por WhatsApp, que é justamente o destino do resumo. Em JPEG a 0,92 o mesmo
// gráfico fica em ~100 KB sem diferença visível (é desenho vetorial sobre
// fundo branco, o pior caso do JPEG nem aparece aqui).
// Lê a legenda HTML do cartão (cor, nome, valor) para redesenhá-la na imagem.
// `inline` diz de que gráfico ela veio: a da rosca é uma coluna à direita; a
// de séries (linha/área/coluna) é uma faixa embaixo. Desenhar as duas do mesmo
// jeito espremia o desenho ou deixava a letra pequena demais.
function lerLegenda(elemento) {
  const lista = elemento?.querySelector?.('.grafico-legenda');
  const itens = lista?.querySelectorAll('li');
  if (!itens?.length) return { itens: [], inline: false };
  const inline = lista.classList.contains('grafico-legenda-inline');
  const lidos = [...itens].slice(0, 14).map((li) => {
    const pct = li.querySelector('.grafico-legenda-pct')?.textContent?.trim() || '';
    let valor = li.querySelector('.grafico-legenda-valor')?.textContent?.trim() || '';
    // O percentual mora DENTRO do span do valor: sem separá-los, o
    // textContent saía grudado ("R$ 601.278,4145,8%").
    if (pct && valor.endsWith(pct)) valor = valor.slice(0, -pct.length).trim();
    return {
      cor: getComputedStyle(li.querySelector('.grafico-legenda-cor')).backgroundColor,
      nome: li.querySelector('.grafico-legenda-nome')?.textContent?.trim() || '',
      valor: pct ? `${valor}   ${pct}` : valor,
    };
  });
  return { itens: lidos, inline };
}

// Coluna à direita (rosca): nome à esquerda, valor alinhado à direita.
function desenharLegendaColuna(ctx, itens, x, y, largura) {
  ctx.textBaseline = 'middle';
  for (const [i, item] of itens.entries()) {
    const linhaY = y + 12 + i * 21;
    ctx.fillStyle = item.cor || '#999999';
    ctx.fillRect(x, linhaY - 5, 10, 10);
    ctx.fillStyle = '#2a1d10';
    ctx.font = '600 12.5px Helvetica, Arial, sans-serif';
    // Corta o nome se ele passar do espaço reservado — melhor reticências do
    // que texto escrito por cima do valor.
    let nome = item.nome;
    while (nome.length > 4 && ctx.measureText(nome).width > largura - 155) nome = nome.slice(0, -1);
    ctx.fillText(nome === item.nome ? nome : `${nome}…`, x + 16, linhaY);
    ctx.fillStyle = '#6b5d4d';
    ctx.font = '12px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(item.valor, x + largura, linhaY);
    ctx.textAlign = 'left';
  }
}

// Faixa embaixo (séries): mantém a imagem na mesma largura do desenho, o que
// preserva o tamanho da letra quando o PDF encaixa a figura na página.
function desenharLegendaFaixa(ctx, itens, x, y, largura) {
  ctx.textBaseline = 'middle';
  let cursor = x;
  let linhaY = y;
  for (const item of itens) {
    ctx.font = '600 12.5px Helvetica, Arial, sans-serif';
    const larguraNome = ctx.measureText(item.nome).width;
    ctx.font = '12px Helvetica, Arial, sans-serif';
    const larguraValor = item.valor ? ctx.measureText(item.valor).width + 7 : 0;
    const bloco = 16 + larguraNome + larguraValor + 22;
    if (cursor + bloco > x + largura && cursor > x) { cursor = x; linhaY += 21; }
    ctx.fillStyle = item.cor || '#999999';
    ctx.fillRect(cursor, linhaY - 5, 10, 10);
    ctx.fillStyle = '#2a1d10';
    ctx.font = '600 12.5px Helvetica, Arial, sans-serif';
    ctx.fillText(item.nome, cursor + 16, linhaY);
    if (item.valor) {
      ctx.fillStyle = '#6b5d4d';
      ctx.font = '12px Helvetica, Arial, sans-serif';
      ctx.fillText(item.valor, cursor + 16 + larguraNome + 7, linhaY);
    }
    cursor += bloco;
  }
  return linhaY + 16;
}

export async function capturarGrafico(elemento, { escala = 2, fundo = '#ffffff', qualidade = 0.92 } = {}) {
  try {
    const svgOriginal = elemento?.querySelector?.('svg');
    if (!svgOriginal) return null;
    const largura = Math.round(svgOriginal.clientWidth || svgOriginal.getBoundingClientRect().width || 640);
    const altura = Math.round(svgOriginal.clientHeight || svgOriginal.getBoundingClientRect().height || 280);
    if (!largura || !altura) return null;

    const clone = svgOriginal.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(largura));
    clone.setAttribute('height', String(altura));
    clone.setAttribute('viewBox', `0 0 ${largura} ${altura}`);
    // A fonte da aplicação vem de um @font-face que o SVG isolado não enxerga:
    // fixa uma pilha de fontes do sistema para o texto não sumir na imagem.
    clone.querySelectorAll('text').forEach((t) => {
      t.setAttribute('font-family', 'Helvetica, Arial, sans-serif');
    });

    const texto = new XMLSerializer().serializeToString(clone);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(texto)}`;
    const imagem = new Image();
    imagem.crossOrigin = 'anonymous';
    await new Promise((resolver, rejeitar) => {
      imagem.onload = resolver;
      imagem.onerror = rejeitar;
      imagem.src = url;
    });

    // A legenda da rosca é HTML ao lado do SVG — ela NÃO entra na
    // serialização. Sem isto, o PDF recebia um anel colorido sem dizer o que
    // é cada cor, que é pior do que não ter gráfico nenhum. Aqui ela é
    // redesenhada no canvas, ao lado do desenho.
    const { itens: legenda, inline } = lerLegenda(elemento);
    // Faixa embaixo não muda a largura (a letra continua do mesmo tamanho
    // quando o PDF encaixa a figura); coluna à direita alarga a imagem.
    const larguraLegenda = legenda.length && !inline ? 300 : 0;
    const alturaLegenda = legenda.length && inline ? 34 : 0;
    const alturaMinimaColuna = legenda.length && !inline ? 26 + legenda.length * 21 : 0;
    const larguraFinal = largura + larguraLegenda;
    const alturaFinal = Math.max(altura + alturaLegenda, alturaMinimaColuna);

    const canvas = document.createElement('canvas');
    canvas.width = larguraFinal * escala;
    canvas.height = alturaFinal * escala;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = fundo;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(escala, escala);
    ctx.drawImage(imagem, 0, inline ? 0 : (alturaFinal - altura) / 2, largura, altura);
    if (legenda.length) {
      if (inline) desenharLegendaFaixa(ctx, legenda, 4, altura + 16, largura - 8);
      else desenharLegendaColuna(ctx, legenda, largura + 12, 14, larguraLegenda - 12);
    }

    return {
      dataUrl: canvas.toDataURL('image/jpeg', qualidade),
      formato: 'JPEG',
      largura: larguraFinal,
      altura: alturaFinal,
    };
  } catch {
    return null;
  }
}

// Captura vários de uma vez. Recebe [{ titulo, ref }] e devolve só os que
// deram certo, já no formato que o motor de relatório espera.
export async function capturarGraficos(lista) {
  const capturados = await Promise.all(
    lista.map(async ({ titulo, ref }) => {
      const imagem = await capturarGrafico(ref?.current);
      return imagem ? { titulo, ...imagem } : null;
    })
  );
  return capturados.filter(Boolean);
}
