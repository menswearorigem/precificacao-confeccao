// Peças pequenas repartidas entre Corte e Folha do corte (28/09/2026).

export function SwatchCor({ cor, hex }) {
  if (!hex) return <span className="pe-swatch pe-swatch-vazio" title={cor ? `${cor} — sem cor de tela cadastrada` : ''} />;
  const estilo = String(cor || '').toUpperCase().includes('MESCLA')
    ? { backgroundImage: `repeating-linear-gradient(45deg, ${hex} 0 2px, ${hex}99 2px 4px)` }
    : { background: hex };
  return <span className="pe-swatch" style={estilo} title={`${cor} ${hex}`} />;
}

export function qtdTecido(valor, unidade = 'kg', casas = 2) {
  if (valor == null) return '—';
  return `${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })} ${unidade === 'm' ? 'm' : 'kg'}`;
}

const SITUACAO = {
  aberta: { rotulo: 'Esperando corte', tom: 'tone-atencao' },
  cortada: { rotulo: 'Cortada', tom: 'tone-saudavel' },
  cancelada: { rotulo: 'Cancelada', tom: 'tone-neutro' },
};
export function SeloSituacaoCorte({ situacao }) {
  const s = SITUACAO[situacao] || { rotulo: situacao, tom: 'tone-neutro' };
  return <span className={`selo ${s.tom}`}>{s.rotulo}</span>;
}

// Gastar mais que a ficha é custo escondido (vermelho); gastar menos também
// merece olhar (azul) — ficha folgada faz comprar tecido demais. Dentro de
// ±5% é variação normal de enfesto.
export function SeloDesvio({ desvio, grande }) {
  if (desvio == null) return null;
  const pct = (desvio * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const tom = desvio >= 0.05 ? 'tone-prejuizo' : desvio <= -0.05 ? 'tone-elevada' : 'tone-saudavel';
  const texto = `${desvio > 0 ? '+' : ''}${pct}%`;
  return (
    <span
      className={`selo ${tom}${grande ? ' co-selo-grande' : ''}`}
      title={desvio >= 0.05 ? 'Gastou mais tecido que a ficha prevê' : desvio <= -0.05 ? 'Gastou menos tecido que a ficha prevê' : 'Dentro da variação normal (±5%)'}
    >
      {texto}
    </span>
  );
}
