// Depósitos e transferência entre eles, com aceite (09/09/2026).
//
// ---------------------------------------------------------------------------
// As três regras que este arquivo garante
// ---------------------------------------------------------------------------
// 1. TRANSFERÊNCIA NÃO CRIA NEM DESTRÓI PEÇA. `estoque_variantes.quantidade`
//    e `insumos.quantidade` não são tocados em lugar nenhum daqui. O que muda
//    é onde a peça está. A única exceção é a baixa de divergência, que é um
//    ato separado, com motivo escrito e nome de quem mandou.
//
// 2. MANDAR NÃO ENTREGA. O envio tira da origem e põe em TRÂNSITO; só o aceite
//    credita o destino. Sem isso a Expedição prometeria peça que ainda está na
//    van, e a diferença entre o que saiu e o que chegou não teria onde
//    aparecer.
//
// 3. FALTA NÃO VIRA AJUSTE SOZINHA. Chegou menos do que saiu, a diferença não
//    é apagada nem descontada do total automaticamente: ela sai do trânsito e
//    volta a ser saldo NÃO ENDEREÇADO — que é a verdade ("é nosso, e ninguém
//    sabe onde está") — e fica marcada na transferência até alguém decidir se
//    foi perda ou erro de contagem.
//
// REGRA 1: nada aqui lê ou escreve preço, margem, markup ou imposto.

const {
  ajustarLocal, ajustarLocalInsumo, saldoNoLocal, saldoInsumoNoLocal,
} = require('./estoqueLocais');
const { registrarMovimento } = require('./estoqueMovimento');

const SITUACOES = ['rascunho', 'em_transito', 'recebida', 'cancelada'];
const NATUREZAS = ['proprio', 'faccao', 'terceiro'];

function erro(mensagem, status = 400) {
  return Object.assign(new Error(mensagem), { status });
}

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

async function lerDeposito(db, id) {
  const { rows } = await db.query('SELECT * FROM depositos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listarDepositos(db, { incluirInativos = false } = {}) {
  const { rows } = await db.query(
    `SELECT d.*, f.nome AS fornecedor_nome,
            (SELECT COUNT(*) FROM estoque_variante_saldos s
              WHERE s.deposito_id = d.id AND s.quantidade <> 0) AS variantes_com_saldo,
            (SELECT COUNT(*) FROM insumo_saldos s
              WHERE s.deposito_id = d.id AND s.quantidade <> 0) AS insumos_com_saldo
       FROM depositos d
       LEFT JOIN fornecedores f ON f.id = d.fornecedor_id
      ${incluirInativos ? '' : 'WHERE d.ativo'}
      ORDER BY d.padrao DESC, d.nome`
  );
  return rows;
}

// Natureza 'faccao' sem fornecedor é o erro que transforma "na facção" num
// balde só, e deixa a pergunta "quanto a Dona Cida está com a gente?" sem
// resposta. O banco não tem como recusar isso sozinho; aqui tem.
function validarDeposito({ codigo, nome, natureza, fornecedorId }) {
  if (!String(codigo || '').trim()) throw erro('O depósito precisa de um código curto.');
  if (!String(nome || '').trim()) throw erro('O depósito precisa de um nome.');
  if (!NATUREZAS.includes(natureza)) {
    throw erro(`Natureza inválida. Use uma destas: ${NATUREZAS.join(', ')}. Trânsito não é depósito — é estado de viagem.`);
  }
  if (natureza === 'faccao' && !fornecedorId) {
    throw erro('Depósito de facção precisa dizer de qual fornecedor é a casa.');
  }
}

// Depósito com saldo não se apaga: inativa. Apagar transformaria o saldo dele
// em não endereçado sem ninguém perceber, e a peça sumiria do mapa continuando
// no total. O banco também recusa (ON DELETE RESTRICT); aqui a recusa tem
// explicação.
async function inativarDeposito(db, id) {
  const dep = await lerDeposito(db, id);
  if (!dep) throw erro('Depósito não encontrado.', 404);

  const { rows } = await db.query(
    `SELECT
       (SELECT COALESCE(SUM(quantidade),0) FROM estoque_variante_saldos WHERE deposito_id = $1) AS pecas,
       (SELECT COALESCE(SUM(quantidade),0) FROM insumo_saldos WHERE deposito_id = $1) AS insumos`,
    [id]
  );
  const pecas = Number(rows[0].pecas);
  const insumos = Number(rows[0].insumos);
  if (pecas !== 0 || insumos !== 0) {
    throw erro(
      `Este depósito ainda tem saldo (${pecas} peça(s) e ${insumos} de insumo). `
      + 'Transfira o que está nele antes de inativar — inativar com saldo dentro faz o estoque sumir do mapa sem sumir do total.',
      409
    );
  }
  const { rows: upd } = await db.query(
    'UPDATE depositos SET ativo = FALSE, padrao = FALSE WHERE id = $1 RETURNING *', [id]
  );
  return upd[0];
}

// ---------------------------------------------------------------------------
// Transferência
// ---------------------------------------------------------------------------

async function lerTransferencia(db, id) {
  const { rows } = await db.query(
    `SELECT t.*, o.nome AS origem_nome, o.natureza AS origem_natureza, o.fornecedor_id AS origem_fornecedor_id,
            dst.nome AS destino_nome, dst.natureza AS destino_natureza, dst.fornecedor_id AS destino_fornecedor_id
       FROM transferencias_estoque t
       JOIN depositos o ON o.id = t.origem_deposito_id
       JOIN depositos dst ON dst.id = t.destino_deposito_id
      WHERE t.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function itensDa(db, transferenciaId) {
  const { rows } = await db.query(
    `SELECT i.*, v.cor, v.tamanho, v.ean, p.referencia, p.descricao AS produto_nome,
            ins.nome AS insumo_nome, ins.unidade AS insumo_unidade,
            d.situacao_item, d.diferenca
       FROM transferencia_itens i
       LEFT JOIN estoque_variantes v ON v.id = i.variante_id
       LEFT JOIN produtos p ON p.id = v.produto_id
       LEFT JOIN insumos ins ON ins.id = i.insumo_id
       LEFT JOIN vw_transferencia_divergencia d ON d.item_id = i.id
      WHERE i.transferencia_id = $1
      ORDER BY i.id`,
    [transferenciaId]
  );
  return rows;
}

// Envia: tira da origem, põe em trânsito.
//
// ⚠️ A decisão do saldo NÃO ENDEREÇADO.
//
// No dia em que os depósitos nascem, todo o estoque antigo está não endereçado
// (migration 0052 recusou, de propósito, chutar que estava tudo no galpão).
// Se o envio exigisse saldo já endereçado no depósito de origem, a
// transferência não funcionaria em nenhuma peça no primeiro dia — e o caminho
// de menor esforço seria endereçar tudo no chute, que é justamente o que 0052
// evitou.
//
// Então o envio pode puxar do não endereçado da MESMA natureza de lugar, e
// devolve, item por item, quanto veio de lá. O aviso é obrigatório: puxar em
// silêncio faria o endereçamento parecer completo quando não está.
async function enviar(client, { transferenciaId, usuarioId, permitirNaoEnderecado = true }) {
  const t = await lerTransferencia(client, transferenciaId);
  if (!t) throw erro('Transferência não encontrada.', 404);
  if (t.situacao !== 'rascunho') {
    throw erro(`Esta transferência já foi ${t.situacao === 'em_transito' ? 'enviada' : t.situacao}.`, 409);
  }

  const itens = await itensDa(client, transferenciaId);
  if (itens.length === 0) throw erro('A transferência não tem nenhum item.');

  const avisos = [];

  for (const item of itens) {
    const qtd = Number(item.quantidade_enviada);
    const ehPeca = item.variante_id !== null;

    const leitura = ehPeca
      ? await saldoNoLocal(client, {
        varianteId: item.variante_id, local: t.origem_natureza,
        fornecedorId: t.origem_fornecedor_id, depositoId: t.origem_deposito_id,
      })
      : await saldoInsumoNoLocal(client, {
        insumoId: item.insumo_id, local: t.origem_natureza,
        fornecedorId: t.origem_fornecedor_id, depositoId: t.origem_deposito_id,
      });

    const noDeposito = leitura === null ? 0 : leitura;
    const falta = qtd - noDeposito;
    const nome = ehPeca
      ? `${item.referencia || item.produto_nome || 'peça'} ${item.cor || ''} ${item.tamanho || ''}`.trim()
      : (item.insumo_nome || 'insumo');

    let doDeposito = Math.min(qtd, Math.max(noDeposito, 0));
    let doNaoEnderecado = 0;

    if (falta > 0) {
      if (!permitirNaoEnderecado) {
        throw erro(
          `${nome}: o depósito ${t.origem_nome} tem ${noDeposito} e a transferência pede ${qtd}. Faltam ${falta}.`,
          409
        );
      }
      const solto = ehPeca
        ? await saldoNoLocal(client, {
          varianteId: item.variante_id, local: t.origem_natureza,
          fornecedorId: t.origem_fornecedor_id, depositoId: null,
        })
        : await saldoInsumoNoLocal(client, {
          insumoId: item.insumo_id, local: t.origem_natureza,
          fornecedorId: t.origem_fornecedor_id, depositoId: null,
        });
      const disponivelSolto = solto === null ? 0 : solto;
      if (disponivelSolto < falta) {
        throw erro(
          `${nome}: faltam ${falta}. O depósito ${t.origem_nome} tem ${noDeposito} e há ${disponivelSolto} `
          + 'ainda sem depósito nesta natureza de lugar. Enderece o saldo ou corrija a quantidade.',
          409
        );
      }
      doNaoEnderecado = falta;
      avisos.push(
        `${nome}: ${falta} de ${qtd} saíram do saldo ainda não endereçado de "${t.origem_nome}".`
      );
    }

    const ajustar = ehPeca ? ajustarLocal : ajustarLocalInsumo;
    const alvo = ehPeca ? { varianteId: item.variante_id } : { insumoId: item.insumo_id };

    if (doDeposito > 0) {
      await ajustar(client, {
        ...alvo, local: t.origem_natureza, fornecedorId: t.origem_fornecedor_id,
        depositoId: t.origem_deposito_id, delta: -doDeposito,
      });
    }
    if (doNaoEnderecado > 0) {
      await ajustar(client, {
        ...alvo, local: t.origem_natureza, fornecedorId: t.origem_fornecedor_id,
        depositoId: null, delta: -doNaoEnderecado,
      });
    }

    // Trânsito fica marcado com o depósito de DESTINO. É o que responde "o que
    // está a caminho da Expedição?" — pergunta que se faz olhando para onde a
    // coisa vai, nunca de onde saiu.
    await ajustar(client, {
      ...alvo, local: 'transito', fornecedorId: null,
      depositoId: t.destino_deposito_id, delta: qtd,
    });

    if (ehPeca) {
      await client.query(
        `INSERT INTO estoque_local_movimentos
           (variante_id, local_origem, fornecedor_origem_id, local_destino, fornecedor_destino_id,
            quantidade, motivo, usuario_id, deposito_origem_id, deposito_destino_id)
         VALUES ($1,$2,$3,'transito',NULL,$4,$5,$6,$7,$8)`,
        [
          item.variante_id, t.origem_natureza, t.origem_fornecedor_id || null, qtd,
          `Transferência ${t.numero || t.id}: ${t.origem_nome} → ${t.destino_nome}`,
          usuarioId || null, t.origem_deposito_id, t.destino_deposito_id,
        ]
      );
    }
  }

  const { rows } = await client.query(
    `UPDATE transferencias_estoque
        SET situacao = 'em_transito', enviado_em = now(), enviado_por = $1
      WHERE id = $2 RETURNING *`,
    [usuarioId || null, transferenciaId]
  );
  return { transferencia: rows[0], avisos };
}

// Recebe: tira do trânsito, credita o destino com o que CHEGOU.
//
// A diferença não é escondida e não vira ajuste automático. Ela sai do
// trânsito (a viagem acabou) e volta a ser saldo não endereçado da origem —
// "é nosso, e ninguém sabe onde está" —, que é a única afirmação verdadeira
// que o sistema pode fazer sozinho. Quem decide se foi perda é gente.
async function receber(client, { transferenciaId, itens, usuarioId }) {
  const t = await lerTransferencia(client, transferenciaId);
  if (!t) throw erro('Transferência não encontrada.', 404);
  if (t.situacao !== 'em_transito') {
    throw erro(
      t.situacao === 'rascunho'
        ? 'Esta transferência ainda não foi enviada.'
        : `Esta transferência já está ${t.situacao}.`,
      409
    );
  }

  const existentes = await itensDa(client, transferenciaId);
  const porId = new Map(existentes.map((i) => [i.id, i]));
  const informados = new Map();
  for (const linha of itens || []) {
    const id = Number(linha.id);
    if (!porId.has(id)) throw erro(`O item ${id} não é desta transferência.`);
    const q = numero(linha.quantidadeRecebida ?? linha.quantidade_recebida);
    if (q === null || q < 0) {
      throw erro('Informe a quantidade recebida de cada item (pode ser zero, se nada chegou).');
    }
    informados.set(id, q);
  }
  // Conferência pela metade não fecha a transferência: item sem número
  // conferido ficaria com `quantidade_recebida` nula para sempre, dentro de um
  // documento marcado como recebido — e ninguém voltaria nele.
  const faltando = existentes.filter((i) => !informados.has(i.id));
  if (faltando.length > 0) {
    throw erro(
      `Faltou conferir ${faltando.length} item(ns). Todos precisam de um número — zero também é um número.`
    );
  }

  const divergencias = [];

  for (const item of existentes) {
    const enviada = Number(item.quantidade_enviada);
    const recebida = informados.get(item.id);
    const ehPeca = item.variante_id !== null;
    const ajustar = ehPeca ? ajustarLocal : ajustarLocalInsumo;
    const alvo = ehPeca ? { varianteId: item.variante_id } : { insumoId: item.insumo_id };

    // O trânsito zera sempre pelo que SAIU: a viagem daquelas peças terminou,
    // independente de quantas apareceram na conferência.
    await ajustar(client, {
      ...alvo, local: 'transito', fornecedorId: null,
      depositoId: t.destino_deposito_id, delta: -enviada,
    });

    if (recebida > 0) {
      await ajustar(client, {
        ...alvo, local: t.destino_natureza, fornecedorId: t.destino_fornecedor_id,
        depositoId: t.destino_deposito_id, delta: recebida,
      });
    }

    const diferenca = recebida - enviada;
    if (diferenca !== 0) {
      // Volta para o não endereçado da natureza de ORIGEM. Sobra também: peça
      // que chegou a mais não nasceu na viagem, ela estava em algum lugar que
      // o sistema achava que era outro.
      await ajustar(client, {
        ...alvo, local: t.origem_natureza, fornecedorId: t.origem_fornecedor_id,
        depositoId: null, delta: -diferenca,
      });
      divergencias.push({
        itemId: item.id,
        nome: ehPeca
          ? `${item.referencia || item.produto_nome || 'peça'} ${item.cor || ''} ${item.tamanho || ''}`.trim()
          : (item.insumo_nome || 'insumo'),
        enviada, recebida, diferenca,
      });
    }

    await client.query(
      'UPDATE transferencia_itens SET quantidade_recebida = $1 WHERE id = $2',
      [recebida, item.id]
    );

    if (ehPeca && recebida > 0) {
      await client.query(
        `INSERT INTO estoque_local_movimentos
           (variante_id, local_origem, fornecedor_origem_id, local_destino, fornecedor_destino_id,
            quantidade, motivo, usuario_id, deposito_origem_id, deposito_destino_id)
         VALUES ($1,'transito',NULL,$2,$3,$4,$5,$6,$7,$8)`,
        [
          item.variante_id, t.destino_natureza, t.destino_fornecedor_id || null, recebida,
          `Aceite da transferência ${t.numero || t.id} em ${t.destino_nome}`,
          usuarioId || null, t.origem_deposito_id, t.destino_deposito_id,
        ]
      );
    }
  }

  const { rows } = await client.query(
    `UPDATE transferencias_estoque
        SET situacao = 'recebida', recebido_em = now(), recebido_por = $1
      WHERE id = $2 RETURNING *`,
    [usuarioId || null, transferenciaId]
  );
  return { transferencia: rows[0], divergencias };
}

// Estorna um envio que ainda não foi aceito: o carregamento voltou.
//
// Volta para o depósito de origem, e não para o não endereçado: aqui o sistema
// SABE de onde saiu. (A parte que veio do não endereçado no envio volta
// endereçada — é uma informação a mais que se ganhou no caminho, não uma
// invenção.)
async function estornarEnvio(client, { transferenciaId, motivo, usuarioId }) {
  if (!String(motivo || '').trim()) {
    throw erro('Escreva o motivo do estorno — sem ele ninguém sabe, depois, se a carga voltou ou se o lançamento estava errado.');
  }
  const t = await lerTransferencia(client, transferenciaId);
  if (!t) throw erro('Transferência não encontrada.', 404);
  if (t.situacao !== 'em_transito') {
    throw erro('Só dá para estornar transferência que está em trânsito.', 409);
  }

  const itens = await itensDa(client, transferenciaId);
  for (const item of itens) {
    const qtd = Number(item.quantidade_enviada);
    const ehPeca = item.variante_id !== null;
    const ajustar = ehPeca ? ajustarLocal : ajustarLocalInsumo;
    const alvo = ehPeca ? { varianteId: item.variante_id } : { insumoId: item.insumo_id };

    await ajustar(client, {
      ...alvo, local: 'transito', fornecedorId: null,
      depositoId: t.destino_deposito_id, delta: -qtd,
    });
    await ajustar(client, {
      ...alvo, local: t.origem_natureza, fornecedorId: t.origem_fornecedor_id,
      depositoId: t.origem_deposito_id, delta: qtd,
    });

    if (ehPeca) {
      await client.query(
        `INSERT INTO estoque_local_movimentos
           (variante_id, local_origem, fornecedor_origem_id, local_destino, fornecedor_destino_id,
            quantidade, motivo, usuario_id, deposito_origem_id, deposito_destino_id)
         VALUES ($1,'transito',NULL,$2,$3,$4,$5,$6,$7,$8)`,
        [
          item.variante_id, t.origem_natureza, t.origem_fornecedor_id || null, qtd,
          `Estorno da transferência ${t.numero || t.id}: ${motivo}`,
          usuarioId || null, t.destino_deposito_id, t.origem_deposito_id,
        ]
      );
    }
  }

  const { rows } = await client.query(
    `UPDATE transferencias_estoque
        SET situacao = 'rascunho', enviado_em = NULL, enviado_por = NULL,
            observacao = CONCAT_WS(E'\\n', observacao, $1::text)
      WHERE id = $2 RETURNING *`,
    [`Estorno em ${new Date().toISOString().slice(0, 10)}: ${motivo}`, transferenciaId]
  );
  return rows[0];
}

// Baixa a falta como perda. É o ÚNICO ponto deste arquivo que mexe no total —
// e por isso exige motivo e fica na trilha de `estoque_movimentos`.
//
// Só peça pronta: o total de insumo é mantido por outra máquina
// (`insumo_movimentos`), e escrever um segundo caminho para o mesmo número é
// exatamente o que este módulo inteiro recusa a fazer.
async function baixarDivergencia(client, { transferenciaId, motivo, usuarioId }) {
  if (!String(motivo || '').trim()) throw erro('Escreva o motivo da baixa.');

  const t = await lerTransferencia(client, transferenciaId);
  if (!t) throw erro('Transferência não encontrada.', 404);
  if (t.situacao !== 'recebida') {
    throw erro('Só dá para baixar divergência de transferência já recebida.', 409);
  }

  const { rows: faltas } = await client.query(
    `SELECT i.id, i.variante_id, i.insumo_id, i.quantidade_enviada, i.quantidade_recebida
       FROM transferencia_itens i
      WHERE i.transferencia_id = $1
        AND i.quantidade_recebida IS NOT NULL
        AND i.quantidade_recebida < i.quantidade_enviada
        AND i.divergencia_baixada_em IS NULL`,
    [transferenciaId]
  );
  if (faltas.length === 0) {
    throw erro('Esta transferência não tem falta pendente para baixar — ou não faltou nada, ou a falta já foi baixada.');
  }

  const baixados = [];
  const ignorados = [];

  for (const f of faltas) {
    const falta = Number(f.quantidade_enviada) - Number(f.quantidade_recebida);
    if (f.variante_id === null) {
      ignorados.push({ itemId: f.id, insumoId: f.insumo_id, falta });
      continue;
    }
    // Tira do não endereçado, para onde a falta foi no aceite...
    await ajustarLocal(client, {
      varianteId: f.variante_id, local: t.origem_natureza,
      fornecedorId: t.origem_fornecedor_id, depositoId: null, delta: -falta,
    });
    // ...e só então baixa do total, com trilha.
    await registrarMovimento(
      client, f.variante_id, 'ajuste', -falta,
      `Perda em transferência ${t.numero || t.id} (${t.origem_nome} → ${t.destino_nome}): ${motivo}`
    );
    await client.query(
      `UPDATE transferencia_itens
          SET divergencia_baixada_em = now(), divergencia_baixada_motivo = $1
        WHERE id = $2`,
      [String(motivo).slice(0, 200), f.id]
    );
    baixados.push({ itemId: f.id, varianteId: f.variante_id, falta });
  }

  await client.query(
    `UPDATE transferencias_estoque
        SET observacao = CONCAT_WS(E'\\n', observacao, $1::text)
      WHERE id = $2`,
    [`Baixa de divergência por ${usuarioId || 'sistema'}: ${motivo}`, transferenciaId]
  );

  return { baixados, ignorados };
}

module.exports = {
  SITUACOES,
  NATUREZAS,
  lerDeposito,
  listarDepositos,
  validarDeposito,
  inativarDeposito,
  lerTransferencia,
  itensDa,
  enviar,
  receber,
  estornarEnvio,
  baixarDivergencia,
};
