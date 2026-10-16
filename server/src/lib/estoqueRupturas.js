// Quando o estoque ZEROU e quando VOLTOU (16/10/2026, pedido do usuário).
//
// DE ONDE VEM: o Wik não guarda isso em lugar que a API entregue — o
// saldo_estoque_get só devolve o saldo de AGORA, e não existe endpoint de
// histórico/kardex de produto acabado. Quem guarda é o próprio Hub: toda
// mudança de quantidade (sincronização do Wik a cada 15 min, bipagem,
// venda, ajuste) grava uma linha em `estoque_movimentos` com a quantidade
// resultante. Refazendo essa fila em ordem dá para saber, com precisão de um
// ciclo de sincronização, quando cada variante — e a referência inteira —
// ficou sem peça e quando voltou a ter.
//
// LIMITE HONESTO: só existe histórico a partir do primeiro movimento gravado
// de cada variante. Um zero que durou menos que um ciclo e foi desfeito antes
// da sincronização seguinte não aparece.
//
// "Sem estoque" = quantidade <= 0 (saldo negativo também é falta de peça).

function zeroTardio(m) {
  return /não veio no saldo do Wik/i.test(String(m.motivo || ''));
}

function semEstoque(q) {
  return Number(q) <= 0;
}

// movimentos: [{ variante_id, quantidade_resultante, criado_em }] em QUALQUER
// ordem. variantes: [{ id, quantidade }] (saldo atual, para o "agora").
// Devolve { referencia: {...}, porVariante: Map(id → {...}) }.
function calcularRupturas(movimentos, variantes, agora = new Date()) {
  const ordenados = [...movimentos].sort((a, b) => {
    const d = new Date(a.criado_em) - new Date(b.criado_em);
    return d !== 0 ? d : Number(a.id || 0) - Number(b.id || 0);
  });

  const porVariante = new Map();
  for (const v of variantes) {
    porVariante.set(v.id, { periodos: [], aberto: null, temHistorico: false, saldo: 0 });
  }

  // Saldo de cada variante "no tempo", para o total da referência.
  const saldoAtual = new Map(variantes.map((v) => [v.id, 0]));
  let totalAntes = 0;
  const ref = { periodos: [], aberto: null, temHistorico: false, primeiroRegistro: null };

  for (const m of ordenados) {
    const estado = porVariante.get(m.variante_id);
    if (!estado) continue;
    const q = Number(m.quantidade_resultante);
    const quando = new Date(m.criado_em);

    // --- variante ---
    const antes = estado.temHistorico ? estado.saldo : null;
    if (antes === null) {
      // Primeiro registro: se já nasceu zerada, conta como zerada desde ali.
      if (semEstoque(q)) estado.aberto = { zerou_em: quando, inicio_conhecido: false };
    } else if (!semEstoque(antes) && semEstoque(q)) {
      // Zerada porque a variante SUMIU do saldo do Wik (ver wikSync, 3ª
      // passada): o Wik já estava em zero havia um tempo — a data é "ou antes".
      estado.aberto = { zerou_em: quando, inicio_conhecido: !zeroTardio(m) };
    } else if (semEstoque(antes) && !semEstoque(q) && estado.aberto) {
      estado.periodos.push({ ...estado.aberto, voltou_em: quando, voltou_com: q });
      estado.aberto = null;
    }
    estado.saldo = q;
    estado.temHistorico = true;

    // --- referência inteira (soma das variantes com saldo positivo) ---
    saldoAtual.set(m.variante_id, q);
    let total = 0;
    for (const s of saldoAtual.values()) if (s > 0) total += s;
    if (!ref.temHistorico) {
      ref.primeiroRegistro = quando;
      if (semEstoque(total)) ref.aberto = { zerou_em: quando, inicio_conhecido: false };
    } else if (!semEstoque(totalAntes) && semEstoque(total)) {
      ref.aberto = { zerou_em: quando, inicio_conhecido: !zeroTardio(m) };
    } else if (semEstoque(totalAntes) && !semEstoque(total) && ref.aberto) {
      ref.periodos.push({ ...ref.aberto, voltou_em: quando, voltou_com: total });
      ref.aberto = null;
    }
    totalAntes = total;
    ref.temHistorico = true;
  }

  const dias = (de, ate) => Math.max(0, (new Date(ate) - new Date(de)) / 86400000);
  const fechar = (estado) => {
    const periodos = estado.periodos.map((p) => ({ ...p, dias: dias(p.zerou_em, p.voltou_em) }));
    const aberto = estado.aberto ? { ...estado.aberto, voltou_em: null, dias: dias(estado.aberto.zerou_em, agora) } : null;
    const todos = aberto ? [...periodos, aberto] : periodos;
    return {
      sem_estoque_agora: Boolean(aberto),
      periodos: todos.reverse(), // mais recente primeiro
      vezes: todos.length,
      dias_sem_estoque: todos.reduce((s, p) => s + p.dias, 0),
      tem_historico: estado.temHistorico,
    };
  };

  const saida = new Map();
  for (const [id, estado] of porVariante.entries()) saida.set(id, fechar(estado));
  return { referencia: { ...fechar(ref), primeiro_registro: ref.primeiroRegistro }, porVariante: saida };
}

module.exports = { calcularRupturas };
