// Calculadora de tecido (28/09/2026) — a conta, sem tela.
//
// Pedido do dono, em resumo: "tenho um pedido da referência 63317; quantos
// quilos eu preciso para fabricar 150 peças na cor branca, 150 na amarela e
// 150 na vermelha?" — com lugar para o consumo por peça, com vários clientes
// pedindo a mesma cor (150 de um + 100 de outro), com a grade (P2 M2 G1 GG1)
// para o consumo sair por tamanho, e com a escolha entre quilo e metro.
//
// Fica separado da tela para dar para testar sem navegador
// (server/scripts/teste-calculadora-tecido-2026-09-28.js).
//
// Regras:
//   · KG: o consumo por peça é digitado em GRAMAS (é como o chão de fábrica
//     fala: "essa camiseta gasta 180 g") e o resultado sai em quilos.
//     METROS: o consumo é digitado em metros e o resultado sai em metros.
//   · A perda entra UMA vez, sobre o total da cor — igual ao motor da OP
//     (server/src/lib/producao.js). Aplicar por tamanho acumularia erro.
//   · Peças por tamanho saem pelo MAIOR RESTO: arredonda para baixo e dá as
//     peças que sobram aos tamanhos com a maior fração. O total por tamanho
//     sempre fecha com o total do pedido.
//   · Tamanho sem consumo (campo vazio) com peça na grade é PENDÊNCIA, não
//     zero: a tela avisa e o número sai marcado como incompleto.

export const UNIDADES = {
  kg: { rotulo: 'KG', resultado: 'kg', porPeca: 'g', porPecaLongo: 'gramas', divisor: 1000, casas: 2 },
  m: { rotulo: 'METROS', resultado: 'm', porPeca: 'm', porPecaLongo: 'metros', divisor: 1, casas: 2 },
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const temNumero = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));

/**
 * Reparte `total` peças pela proporção da grade (maior resto).
 * @param {number} total
 * @param {number[]} pesos  proporção de cada tamanho (0 = não corta)
 * @returns {number[]}
 */
export function repartirPelaGrade(total, pesos) {
  const t = Math.max(0, Math.floor(num(total)));
  const p = pesos.map((x) => Math.max(0, num(x)));
  const soma = p.reduce((s, x) => s + x, 0);
  if (t === 0 || soma === 0) return p.map(() => 0);
  const exatos = p.map((x) => (t * x) / soma);
  const base = exatos.map((x) => Math.floor(x));
  let sobra = t - base.reduce((s, x) => s + x, 0);
  const ordem = exatos
    .map((x, i) => ({ i, resto: x - Math.floor(x), peso: p[i] }))
    .filter((o) => o.peso > 0)
    .sort((a, b) => (b.resto - a.resto) || (b.peso - a.peso) || (a.i - b.i));
  for (let k = 0; sobra > 0 && ordem.length > 0; k = (k + 1) % ordem.length) {
    base[ordem[k].i] += 1;
    sobra -= 1;
  }
  return base;
}

/** "P2 M2 G1 GG1" — o jeito que a grade é falada no corte. */
export function rotuloGrade(tamanhos) {
  return tamanhos
    .filter((t) => num(t.grade) > 0)
    .map((t) => `${t.tamanho}${num(t.grade)}`)
    .join(' ');
}

/**
 * @param {object} p
 * @param {'kg'|'m'} p.unidade
 * @param {'tamanho'|'unico'} p.modo           consumo por tamanho ou único
 * @param {number} p.consumoUnico             g (kg) ou m (metros) por peça
 * @param {number} p.perdaPct                 em % (5 = 5%)
 * @param {{tamanho:string, grade:number, consumo:number|''}[]} p.tamanhos
 * @param {{cor:string, hex?:string, qtds:(number|'')[]}[]} p.cores  qtds = uma por cliente
 */
export function calcularTecido({ unidade = 'kg', modo = 'tamanho', consumoUnico, perdaPct, tamanhos = [], cores = [] }) {
  const u = UNIDADES[unidade] || UNIDADES.kg;
  const fatorPerda = 1 + Math.max(0, num(perdaPct)) / 100;
  const pesos = tamanhos.map((t) => num(t.grade));
  const somaGrade = pesos.reduce((s, x) => s + x, 0);
  const usaGrade = modo === 'tamanho';

  const pendencias = [];
  if (usaGrade && somaGrade === 0) {
    pendencias.push('A grade está toda zerada. Coloque a proporção de pelo menos um tamanho (ex.: P 2 · M 2 · G 1 · GG 1).');
  }
  const semConsumo = usaGrade
    ? tamanhos.filter((t) => num(t.grade) > 0 && !(temNumero(t.consumo) && num(t.consumo) > 0)).map((t) => t.tamanho)
    : [];
  if (semConsumo.length > 0) {
    pendencias.push(`Falta o consumo por peça do${semConsumo.length > 1 ? 's tamanhos' : ' tamanho'} ${semConsumo.join(', ')}. Sem ele o total sai MENOR do que o real.`);
  }
  if (!usaGrade && !(num(consumoUnico) > 0)) {
    pendencias.push('Falta o consumo por peça. Sem ele não dá para calcular o tecido.');
  }

  const linhas = cores.map((c) => {
    const pecas = (c.qtds || []).reduce((s, q) => s + Math.max(0, Math.floor(num(q))), 0);
    const porTamanho = repartirPelaGrade(pecas, pesos);
    let consumoBruto; // em g (kg) ou m (metros), sem perda
    if (usaGrade) {
      consumoBruto = porTamanho.reduce((s, q, i) => s + q * Math.max(0, num(tamanhos[i]?.consumo)), 0);
    } else {
      consumoBruto = pecas * Math.max(0, num(consumoUnico));
    }
    const tecido = (consumoBruto * fatorPerda) / u.divisor;
    return {
      cor: c.cor,
      hex: c.hex || null,
      pecas,
      porTamanho: usaGrade ? porTamanho : null,
      tecido,
      mediaPorPeca: pecas > 0 ? (consumoBruto * fatorPerda) / pecas : 0, // g ou m
    };
  });

  const totalPecas = linhas.reduce((s, l) => s + l.pecas, 0);
  const totalTecido = linhas.reduce((s, l) => s + l.tecido, 0);
  const porTamanhoTotal = usaGrade
    ? tamanhos.map((_, i) => linhas.reduce((s, l) => s + (l.porTamanho?.[i] || 0), 0))
    : null;
  const porCliente = (cores[0]?.qtds || []).map((_, j) => cores.reduce((s, c) => s + Math.max(0, Math.floor(num(c.qtds?.[j]))), 0));
  // Rendimento: quantas peças 1 kg (ou 1 m) faz, na média do pedido.
  const rendimento = totalTecido > 0 ? totalPecas / totalTecido : 0;

  return {
    unidade: u,
    linhas,
    totalPecas,
    totalTecido,
    porTamanhoTotal,
    porCliente,
    rendimento,
    pendencias,
    completo: pendencias.length === 0,
  };
}

const fmt = (n, casas = 2) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const fmtInt = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

/** Texto pronto para mandar no WhatsApp / e-mail ao fornecedor ou à facção. */
export function textoResumo({ referencia, descricao, tamanhos, modo, perdaPct, clientes }, r) {
  const u = r.unidade;
  const linhas = [];
  linhas.push(`*Tecido — ${referencia || 'referência'}${descricao ? ` · ${descricao}` : ''}*`);
  linhas.push(`Total: *${fmt(r.totalTecido, u.casas)} ${u.resultado}* para ${fmtInt(r.totalPecas)} peças`);
  if (modo === 'tamanho') {
    const g = rotuloGrade(tamanhos);
    if (g) linhas.push(`Grade: ${g}`);
  }
  if (num(perdaPct) > 0) linhas.push(`Já com ${fmt(perdaPct, 1)}% de perda`);
  linhas.push('');
  for (const l of r.linhas.filter((x) => x.pecas > 0)) {
    let t = `• ${l.cor}: ${fmt(l.tecido, u.casas)} ${u.resultado} (${fmtInt(l.pecas)} pç)`;
    if (l.porTamanho) {
      const pt = tamanhos.map((tm, i) => (l.porTamanho[i] > 0 ? `${tm.tamanho} ${l.porTamanho[i]}` : null)).filter(Boolean).join(' · ');
      if (pt) t += ` — ${pt}`;
    }
    linhas.push(t);
  }
  const comPedido = (clientes || []).map((c, j) => ({ c, q: r.porCliente[j] || 0 })).filter((x) => x.q > 0);
  if (comPedido.length > 1) {
    linhas.push('');
    linhas.push(`Pedidos: ${comPedido.map((x) => `${x.c || 'Cliente'} ${fmtInt(x.q)}`).join(' + ')}`);
  }
  return linhas.join('\n').trim();
}
