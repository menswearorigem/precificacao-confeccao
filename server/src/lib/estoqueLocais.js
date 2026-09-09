// Saldo de peça pronta por LOCAL (08/09/2026).
//
// Autorizado em 08/09/2026 junto com a coluna de localização (REGRA 4).
//
// ---------------------------------------------------------------------------
// A regra que atravessa o arquivo inteiro
// ---------------------------------------------------------------------------
// `estoque_variantes.quantidade` é a VERDADE do total. Este arquivo nunca a
// altera — ele só reparte esse total entre lugares. Movimento entre locais é
// soma zero: sai de um, entra em outro, o total não muda.
//
// Isso não é preciosismo. Se o detalhamento pudesse mexer no total, existiriam
// dois caminhos para alterar o mesmo número, e mais cedo ou mais tarde os dois
// discordariam — com o agravante de que ninguém saberia qual dos dois está
// certo. Aqui, quando os dois discordam, a resposta é sempre a mesma: o total
// manda, e a diferença tem nome.
//
// ---------------------------------------------------------------------------
// Os três números, que são diferentes e costumam ser confundidos
// ---------------------------------------------------------------------------
//   TOTAL        — tudo que é nosso, esteja onde estiver. É `quantidade`.
//   EM TERCEIRO  — o que está fora (facção, trânsito, consignado). É nosso,
//                  mas não dá para vender hoje.
//   DISPONÍVEL   — total − em terceiro. É o que pode ser vendido AGORA.
//
// A tela que promete prazo de entrega precisa do DISPONÍVEL. A que calcula
// quanto dinheiro está parado precisa do TOTAL (a peça na lavanderia também é
// dinheiro parado). Trocar um pelo outro erra nos dois sentidos.

const LOCAIS = {
  proprio: {
    chave: 'proprio',
    rotulo: 'No galpão',
    disponivelParaVenda: true,
    exigeFornecedor: false,
    explicacao: 'Aqui dentro, pronta para separar e faturar.',
  },
  faccao: {
    chave: 'faccao',
    rotulo: 'Na facção',
    disponivelParaVenda: false,
    exigeFornecedor: true,
    explicacao: 'Em costura, lavanderia, bordado ou estamparia. Continua sendo nossa e continua valendo dinheiro — mas não dá para vender hoje.',
  },
  transito: {
    chave: 'transito',
    rotulo: 'Em trânsito',
    disponivelParaVenda: false,
    exigeFornecedor: false,
    explicacao: 'Saiu de um lugar e ainda não chegou no outro. Existe para a peça não sumir durante a viagem.',
  },
  terceiro: {
    chave: 'terceiro',
    rotulo: 'Com terceiro',
    disponivelParaVenda: false,
    exigeFornecedor: false,
    explicacao: 'Consignado, showroom, mala de viagem. Nosso, fora daqui, e não vendável pelo canal normal.',
  },
};

function temNumero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

function ehLocalValido(local) {
  return Object.prototype.hasOwnProperty.call(LOCAIS, String(local));
}

// A chave que identifica um lugar. Fornecedor só entra quando o local é de
// facção: sem isso, "na facção" viraria um balde só e a pergunta "quanto a
// Dona Cida está com a gente?" continuaria sem resposta.
function chaveLocal(local, fornecedorId) {
  return LOCAIS[local]?.exigeFornecedor ? `${local}:${fornecedorId ?? 'sem'}` : local;
}

/**
 * Confere o detalhamento contra o total e devolve a leitura dos três números.
 *
 * @param {number} total     `estoque_variantes.quantidade`
 * @param {Array}  porLocal  [{ local, fornecedor_id, fornecedor_nome, quantidade }]
 */
function conciliar(total, porLocal) {
  // ⚠️ `Number(null)` é 0 e passa em `Number.isFinite`. Variante sem saldo
  // conhecido viraria "zero peças" — que é uma afirmação, não a ausência de
  // uma. Aqui ela fica nula e a tela diz que não sabe.
  if (!temNumero(total)) {
    return { ok: false, motivo: 'esta variante não tem saldo registrado' };
  }
  const totalNum = Number(total);

  const linhas = [];
  let somaDetalhada = 0;
  let emTerceiro = 0;
  const negativos = [];

  for (const l of porLocal || []) {
    if (!temNumero(l.quantidade)) continue;
    const q = Number(l.quantidade);
    if (q === 0) continue;
    const def = LOCAIS[l.local];
    if (q < 0) {
      // Saldo negativo num local é sempre defeito de lançamento: mandou-se
      // para a facção mais peça do que havia. Ele NÃO é somado como se fosse
      // um crédito — seria a mesma coisa que aceitar que a facção nos deve
      // peça que nunca saiu daqui.
      negativos.push({
        local: l.local,
        fornecedorNome: l.fornecedor_nome || null,
        quantidade: q,
        texto: `${def?.rotulo || l.local}${l.fornecedor_nome ? ` (${l.fornecedor_nome})` : ''} está com saldo negativo de ${Math.abs(q)} peça(s). Foi lançada saída maior do que havia ali.`,
      });
    }
    somaDetalhada += q;
    // ⚠️ Local DESCONHECIDO conta como fora daqui, e não como disponível.
    // Não é detalhe: os dois lados do erro custam coisas diferentes. Tratar
    // um lugar que não se sabe qual é como "está no galpão" faz o sistema
    // prometer prazo para peça que talvez esteja na lavanderia — e quem
    // descobre é o cliente. Tratar como "está fora" só deixa de vender uma
    // peça que estava aqui, e isso aparece na tela para alguém corrigir.
    // `q > 0` (09/09/2026): o comentário acima descreve a regra certa, mas o
    // código somava também os NEGATIVOS. Um −5 na facção REDUZIA "fora daqui"
    // e portanto AUMENTAVA em 5 o "disponível para vender" — cinco peças que
    // não existem, no número que sustenta o prazo prometido ao cliente.
    // Saldo negativo num local é pendência de lançamento, e já é reportado
    // como tal em `negativos` logo acima; não é crédito.
    if (q > 0 && (!def || !def.disponivelParaVenda)) emTerceiro += q;
    linhas.push({
      local: l.local,
      rotulo: def?.rotulo || l.local,
      fornecedorId: l.fornecedor_id ?? null,
      fornecedorNome: l.fornecedor_nome || null,
      quantidade: q,
      disponivelParaVenda: def ? def.disponivelParaVenda : false,
      // Local que não está na lista é dado antigo ou erro de gravação: não
      // vira "disponível" por omissão, que seria o lado perigoso do chute.
      localDesconhecido: !def,
    });
  }

  const naoEnderecado = totalNum - somaDetalhada;

  return {
    ok: true,
    total: totalNum,
    linhas,
    emTerceiro,
    // O que dá para vender hoje. O não endereçado conta como disponível: ele
    // é saldo antigo que ninguém mexeu, e o mais provável é que esteja aqui —
    // mas a tela mostra quanto é, para a conta não passar por exata.
    disponivel: totalNum - emTerceiro,
    naoEnderecado,
    // Enquanto não for zero, a repartição está incompleta. Dizer isso é o que
    // separa "50 peças estão no galpão" de "50 peças a gente não sabe onde
    // estão, e provavelmente estão no galpão".
    completo: Math.abs(naoEnderecado) < 0.005,
    // Detalhamento MAIOR que o total é impossível: alguém endereçou peça que
    // não existe. Nunca é escondido nem "ajustado".
    inconsistente: naoEnderecado < -0.005,
    motivoInconsistencia: naoEnderecado < -0.005
      ? `A soma dos locais (${somaDetalhada}) é maior que o saldo da variante (${totalNum}). Há ${Math.abs(naoEnderecado)} peça(s) endereçadas que não existem no estoque.`
      : null,
    negativos,
  };
}

/**
 * Valida um movimento entre locais ANTES de gravar.
 *
 * A validação é separada da gravação de propósito: a tela precisa poder
 * perguntar "isso vai dar certo?" sem escrever no banco.
 */
function validarMovimento({ quantidade, localOrigem, fornecedorOrigemId, localDestino, fornecedorDestinoId, saldoNaOrigem }) {
  if (!temNumero(quantidade) || Number(quantidade) <= 0) {
    return { ok: false, erro: 'Informe quantas peças estão saindo.' };
  }
  if (!ehLocalValido(localOrigem) || !ehLocalValido(localDestino)) {
    return { ok: false, erro: 'Local de origem ou destino desconhecido.' };
  }
  const origem = chaveLocal(localOrigem, fornecedorOrigemId);
  const destino = chaveLocal(localDestino, fornecedorDestinoId);
  if (origem === destino) {
    return { ok: false, erro: 'A origem e o destino são o mesmo lugar — não há o que mover.' };
  }
  if (LOCAIS[localOrigem].exigeFornecedor && !fornecedorOrigemId) {
    return { ok: false, erro: 'Diga de qual facção a peça está voltando — sem isso o saldo dela não fecha.' };
  }
  if (LOCAIS[localDestino].exigeFornecedor && !fornecedorDestinoId) {
    return { ok: false, erro: 'Diga para qual facção a peça está indo — sem isso o saldo dela não fecha.' };
  }

  const q = Number(quantidade);
  // Mover mais do que existe na origem é o erro que cria saldo negativo. Ele
  // é recusado na entrada, e não "corrigido" depois: um negativo que aparece
  // três semanas depois já contaminou toda a conferência do período.
  if (temNumero(saldoNaOrigem) && q > Number(saldoNaOrigem) + 0.005) {
    return {
      ok: false,
      erro: `Só há ${Number(saldoNaOrigem)} peça(s) em ${LOCAIS[localOrigem].rotulo.toLowerCase()}. Não dá para mover ${q}.`,
      saldoNaOrigem: Number(saldoNaOrigem),
    };
  }
  // Origem sem linha de saldo NÃO é origem com zero: pode ser saldo antigo
  // que nunca foi endereçado. Deixa passar quando a origem é o galpão (é para
  // lá que o não endereçado aponta) e recusa quando é facção, porque saldo em
  // facção só existe se alguém lançou a remessa.
  if (!temNumero(saldoNaOrigem)) {
    if (localOrigem !== 'proprio') {
      return { ok: false, erro: `Não há saldo registrado em ${LOCAIS[localOrigem].rotulo.toLowerCase()} para esta variante.` };
    }
    return {
      ok: true,
      quantidade: q,
      avisoOrigemNaoEnderecada: 'Esta variante ainda não tinha saldo endereçado. O movimento sai do saldo do galpão, que é onde o estoque antigo é presumido estar.',
    };
  }
  return { ok: true, quantidade: q };
}

// Resumo de uma lista de variantes já conciliadas, para o topo da tela.
function panorama(conciliacoes) {
  const validas = (conciliacoes || []).filter((c) => c.ok);
  return {
    variantes: validas.length,
    total: validas.reduce((s, c) => s + c.total, 0),
    disponivel: validas.reduce((s, c) => s + c.disponivel, 0),
    emTerceiro: validas.reduce((s, c) => s + c.emTerceiro, 0),
    naoEnderecado: validas.reduce((s, c) => s + Math.max(0, c.naoEnderecado), 0),
    variantesNaoEnderecadas: validas.filter((c) => !c.completo && c.naoEnderecado > 0).length,
    variantesInconsistentes: validas.filter((c) => c.inconsistente).length,
    variantesComNegativo: validas.filter((c) => c.negativos.length > 0).length,
  };
}

// ---------------------------------------------------------------------------
// A parte que fala com o banco
// ---------------------------------------------------------------------------
// Recebe `db` (pool ou client de transação) como primeiro parâmetro, igual ao
// `saudeIntegracao.js`. É o que permite chamar de dentro da transação que a
// remessa de facção já abre, sem abrir uma segunda conexão — e sem que metade
// do movimento fique gravada se a outra metade falhar.

async function saldosDaVariante(db, varianteId) {
  const { rows } = await db.query(
    `SELECT s.local, s.fornecedor_id, f.nome AS fornecedor_nome, s.quantidade
       FROM estoque_variante_saldos s
       LEFT JOIN fornecedores f ON f.id = s.fornecedor_id
      WHERE s.variante_id = $1
      ORDER BY s.local, f.nome`,
    [varianteId]
  );
  return rows;
}

// Soma (ou subtrai) num local. O ON CONFLICT casa pelo índice de expressão,
// que é o que faz o saldo próprio (com `fornecedor_id` nulo) atualizar a linha
// existente em vez de criar uma nova a cada movimento.
async function ajustarLocal(db, { varianteId, local, fornecedorId, delta }) {
  await db.query(
    `INSERT INTO estoque_variante_saldos (variante_id, local, fornecedor_id, quantidade)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (variante_id, local, COALESCE(fornecedor_id, 0))
       DO UPDATE SET quantidade = estoque_variante_saldos.quantidade + EXCLUDED.quantidade,
                     atualizado_em = now()`,
    [varianteId, local, fornecedorId || null, delta]
  );
}

/**
 * Move peça de um local para outro. NÃO altera `estoque_variantes.quantidade`
 * — o total é o mesmo antes e depois, o que muda é onde a peça está.
 *
 * O chamador é responsável pela transação e por ter validado com
 * `validarMovimento`. As duas metades ficam aqui juntas de propósito: separar
 * "tira de lá" de "põe aqui" em duas chamadas é como se cria peça que sai de
 * um lugar e não chega no outro.
 */
async function aplicarMovimento(db, {
  varianteId, quantidade, localOrigem, fornecedorOrigemId,
  localDestino, fornecedorDestinoId, motivo, usuarioId,
  faccaoMovimentoId = null, ordemId = null,
}) {
  const q = Number(quantidade);
  await ajustarLocal(db, { varianteId, local: localOrigem, fornecedorId: fornecedorOrigemId, delta: -q });
  await ajustarLocal(db, { varianteId, local: localDestino, fornecedorId: fornecedorDestinoId, delta: q });
  const { rows } = await db.query(
    `INSERT INTO estoque_local_movimentos
       (variante_id, local_origem, fornecedor_origem_id, local_destino, fornecedor_destino_id,
        quantidade, faccao_movimento_id, ordem_id, motivo, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      varianteId, localOrigem, fornecedorOrigemId || null, localDestino, fornecedorDestinoId || null,
      q, faccaoMovimentoId, ordemId, motivo || null, usuarioId || null,
    ]
  );
  return rows[0];
}

// Quanto há num local específico. Devolve NULO quando não existe linha —
// diferente de zero, e a diferença importa: "nunca foi endereçado" não é a
// mesma coisa que "acabou". `validarMovimento` trata os dois casos separados.
async function saldoNoLocal(db, { varianteId, local, fornecedorId }) {
  const { rows } = await db.query(
    `SELECT quantidade FROM estoque_variante_saldos
      WHERE variante_id = $1 AND local = $2 AND COALESCE(fornecedor_id, 0) = COALESCE($3, 0)`,
    [varianteId, local, fornecedorId || null]
  );
  return rows.length === 0 ? null : Number(rows[0].quantidade);
}

module.exports = {
  LOCAIS,
  temNumero,
  ehLocalValido,
  chaveLocal,
  conciliar,
  validarMovimento,
  panorama,
  saldosDaVariante,
  saldoNoLocal,
  ajustarLocal,
  aplicarMovimento,
};
