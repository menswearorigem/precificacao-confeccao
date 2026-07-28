export const brl = (n) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });

export const pct = (n, digits = 1) =>
  `${((Number.isFinite(Number(n)) ? Number(n) : 0) * 100).toFixed(digits)}%`;

export const uid = () => Math.random().toString(36).slice(2, 10);
