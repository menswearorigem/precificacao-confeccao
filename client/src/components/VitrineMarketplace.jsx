// Peças visuais do módulo Marketplace repaginado ("vitrine viva",
// 16/09/2026). Só apresentação: nenhum dado novo, nenhuma regra nova.
import { brl } from '../lib/format';

// Preço de vitrine: "R$" e centavos menores, a parte inteira grande.
// Recebe o número (ou null) e usa o mesmo `brl` do resto do sistema, então o
// texto final é idêntico ao de antes — só dividido em pedaços.
export function PrecoVitrine({ valor, className = '' }) {
  if (valor == null || Number.isNaN(Number(valor))) {
    return <span className={`preco-vitrine ${className}`}>—</span>;
  }
  const texto = brl(Number(valor));
  const m = texto.match(/^(-?)\s*(R\$)\s*([\d.]+)(,\d+)?$/);
  if (!m) return <span className={`preco-vitrine ${className}`}>{texto}</span>;
  return (
    <span className={`preco-vitrine ${className}`} aria-label={texto}>
      {m[1] && <span className="preco-vitrine-sinal">−</span>}
      <span className="preco-vitrine-moeda">{m[2]}</span>
      <span className="preco-vitrine-inteiro">{m[3]}</span>
      {m[4] && <span className="preco-vitrine-centavos">{m[4]}</span>}
    </span>
  );
}

// Faixa de preço ("R$ 69,90 – R$ 89,90") com as duas pontas no mesmo estilo.
export function FaixaPrecoVitrine({ min, max }) {
  if (min == null) return <PrecoVitrine valor={null} />;
  if (max == null || Number(min) === Number(max)) return <PrecoVitrine valor={min} />;
  return (
    <span className="preco-vitrine-faixa">
      <PrecoVitrine valor={min} />
      <span className="preco-vitrine-ate">a</span>
      <PrecoVitrine valor={max} className="menor" />
    </span>
  );
}

// Foto que aparece com um fade quando termina de carregar; até lá o
// contêiner mostra o brilho de "carregando" (CSS). Quem chama continua
// decidindo as quedas (foto do anúncio → reserva → referência).
export function marcarFotoCarregada(evento) {
  evento.currentTarget.classList.add('foto-carregou');
}

export function refFotoJaCarregada(el) {
  if (el && el.complete && el.naturalWidth > 0) el.classList.add('foto-carregou');
}

// Quanto do prazo de uma promoção já passou (0–100) e o texto do que falta.
// Datas ausentes ou inválidas devolvem null, e o cartão simplesmente não
// mostra a barra (nada inventado).
export function andamentoDoPrazo(inicio, fim, agora = new Date()) {
  const i = inicio ? new Date(inicio) : null;
  const f = fim ? new Date(fim) : null;
  if (!f || Number.isNaN(f.getTime())) return null;
  const dia = 24 * 60 * 60 * 1000;
  const restante = Math.ceil((f.getTime() - agora.getTime()) / dia);
  let pct = null;
  if (i && !Number.isNaN(i.getTime()) && f > i) {
    pct = Math.max(0, Math.min(100, ((agora - i) / (f - i)) * 100));
  }
  let texto;
  if (restante < 0) texto = `terminou há ${Math.abs(restante)} ${Math.abs(restante) === 1 ? 'dia' : 'dias'}`;
  else if (restante === 0) texto = 'termina hoje';
  else if (restante === 1) texto = 'termina amanhã';
  else texto = `faltam ${restante} dias`;
  if (i && i > agora) {
    const comeca = Math.ceil((i.getTime() - agora.getTime()) / dia);
    texto = comeca <= 1 ? 'começa amanhã' : `começa em ${comeca} dias`;
    pct = 0;
  }
  return { pct, texto, encerrado: restante < 0 };
}

// "Carregando…" com cara de tela: três cartões e um gráfico em brilho, no
// lugar da frase solta no canto (Métricas → ABC, Entrada e Saída…).
export function CarregandoVitrine({ texto = 'Carregando…' }) {
  return (
    <div className="carregando-vitrine" role="status" aria-live="polite">
      <span className="carregando-vitrine-texto">{texto}</span>
      <div className="carregando-vitrine-cartoes" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      <div className="carregando-vitrine-bloco" aria-hidden="true" />
    </div>
  );
}
