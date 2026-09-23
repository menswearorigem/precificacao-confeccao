/**
 * Cobertura por tamanho — a grade pela venda, com olho no estoque (23/09/2026).
 *
 * A grade de corte responde "em que proporção cortar", e responde pela venda.
 * Ela não sabe que o M já tem 50 peças na prateleira vendendo 30 por mês. Este
 * arquivo mede, tamanho a tamanho, quantos dias o que a casa JÁ TEM (estoque de
 * primeira + o que está em produção) aguenta no ritmo de venda atual, e marca
 * o tamanho que aguenta o horizonte escolhido como "dá para tirar do corte".
 *
 * É SUGESTÃO. Quem decide tirar é gente: a tela mostra a conta e um botão. A
 * proporção dos tamanhos que ficam continua sendo a da venda — a grade não
 * passa a ser "pela falta"; só deixa de cortar o que não precisa.
 *
 * Módulo puro: não toca banco (REGRA 4), não toca preço (REGRA 1). A rota lê
 * os números e entrega aqui.
 *
 * REGRA 2 — "não sei" nunca vira zero:
 *   - tamanho sem venda no ritmo e sem estoque: sem sugestão, e diz por quê;
 *   - tamanho sem venda no ritmo e COM estoque: é o caso mais claro de
 *     "não precisa cortar" — mas a cobertura é infinita, não um número
 *     inventado. Sai com `duraDias: null` e o motivo escrito.
 */

const HORIZONTE_PADRAO_DIAS = 45;
const HORIZONTES_DIAS = [30, 45, 60, 90];
const DIAS_NO_MES = 30;

function temNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return false;
  return Number.isFinite(Number(valor));
}

function chaveTamanho(t) {
  return String(t ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function horizonteValido(dias) {
  const n = Math.round(Number(dias));
  return Number.isFinite(n) && n >= 7 && n <= 365 ? n : HORIZONTE_PADRAO_DIAS;
}

/**
 * @param {string[]} tamanhos na ordem da curva
 * @param {{
 *   vendaNoRitmo: Map<string, number>,   // peças vendidas na janela do ritmo, por tamanho
 *   diasDoRitmo: number,                 // tamanho da janela do ritmo, em dias
 *   estoque: Map<string, number>,        // saldo de primeira qualidade, por tamanho
 *   emProducao: Map<string, number>,     // pendente de ordens vivas, por tamanho
 *   horizonteDias?: number,
 * }} dados
 */
function coberturaPorTamanho(tamanhos, dados) {
  const horizonteDias = horizonteValido(dados.horizonteDias);
  const dias = Number(dados.diasDoRitmo) > 0 ? Number(dados.diasDoRitmo) : 90;
  const ler = (mapa, t) => {
    const v = mapa?.get(chaveTamanho(t));
    return temNumero(v) ? Math.max(0, Number(v)) : 0;
  };

  const linhas = (tamanhos || []).map((tamanho) => {
    const vendidasNoRitmo = ler(dados.vendaNoRitmo, tamanho);
    const estoque = ler(dados.estoque, tamanho);
    const emProducao = ler(dados.emProducao, tamanho);
    const tenho = estoque + emProducao;
    const vendaMes = (vendidasNoRitmo / dias) * DIAS_NO_MES;
    const vendaDia = vendidasNoRitmo / dias;

    let duraDias = null;
    let sugereTirar = false;
    let motivo;

    if (vendaDia > 0) {
      duraDias = tenho / vendaDia;
      sugereTirar = duraDias >= horizonteDias;
      motivo = sugereTirar
        ? `tem ${Math.round(tenho)} e vende ~${arred(vendaMes)}/mês — dura ~${Math.round(duraDias)} dias, mais que os ${horizonteDias} escolhidos`
        : tenho > 0
          ? `dura ~${Math.round(duraDias)} dias — menos que os ${horizonteDias} escolhidos`
          : 'não tem nada — precisa entrar no corte';
    } else if (tenho > 0) {
      sugereTirar = true;
      motivo = `não vendeu nos últimos ${Math.round(dias)} dias e ainda tem ${Math.round(tenho)}`;
    } else {
      motivo = `não vendeu nos últimos ${Math.round(dias)} dias e não tem estoque — sem conta a fazer`;
    }

    return {
      tamanho,
      vendidasNoRitmo,
      vendaMes: arred(vendaMes),
      estoque,
      emProducao,
      tenho,
      duraDias: duraDias === null ? null : Math.round(duraDias),
      sugereTirar,
      motivo,
    };
  });

  return {
    horizonteDias,
    horizontes: HORIZONTES_DIAS,
    diasDoRitmo: Math.round(dias),
    linhas,
    sugeridos: linhas.filter((l) => l.sugereTirar).map((l) => l.tamanho),
    // Todo tamanho que conta aguenta o horizonte: talvez não seja hora de cortar.
    todosCobertos: linhas.some((l) => l.sugereTirar)
      && linhas.every((l) => l.sugereTirar || (l.tenho === 0 && l.vendidasNoRitmo === 0)),
  };
}

function arred(v) {
  return Math.round(v * 10) / 10;
}

module.exports = {
  coberturaPorTamanho,
  chaveTamanho,
  horizonteValido,
  HORIZONTE_PADRAO_DIAS,
  HORIZONTES_DIAS,
};
