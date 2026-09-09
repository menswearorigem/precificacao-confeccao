// Movimentação de produção — a lógica que faz a peça andar.
//
// Regras que este arquivo garante, e que a tela não deve reimplementar:
//
//   1. Não se move o que não está lá. Toda movimentação confere o saldo da
//      origem por (ordem, cor, tamanho, etapa, fornecedor) antes de gravar.
//   2. Um movimento para etapa EXTERNA gera (ou usa) uma Ordem de Serviço, com
//      preço congelado da tabela vigente e previsão de retorno obrigatória.
//   3. Vários destinos numa operação só — é assim que a tela do Wik funciona,
//      e é assim que a fábrica trabalha (metade para uma facção, metade para
//      outra).
//   4. Movimento não se apaga: estorna-se, com um movimento de pontas
//      invertidas apontando para o original.
//
// REGRA 1: nada aqui lê ou escreve preço, margem, markup ou imposto.

const SITUACOES_OS = ['aberta', 'remetida', 'parcial', 'concluida', 'cancelada'];

// Saldo disponível numa etapa, por grade. Lê a view — nunca um contador.
async function saldoNaEtapa(client, { ordemId, etapaId, fornecedorId }) {
  const { rows } = await client.query(
    `SELECT cor, tamanho, quantidade
       FROM vw_producao_wip
      WHERE ordem_id = $1
        AND etapa_id IS NOT DISTINCT FROM $2
        AND fornecedor_id IS NOT DISTINCT FROM $3`,
    [ordemId, etapaId ?? null, fornecedorId ?? null]
  );
  const mapa = new Map();
  for (const r of rows) mapa.set(`${r.cor}|${r.tamanho}`, Number(r.quantidade));
  return mapa;
}

// O preço vigente daquela facção para aquela etapa, na data. Preço específico
// do produto ganha do geral; entre dois vigentes, vence o mais recente.
async function precoVigente(client, { fornecedorId, etapaId, produtoId, data }) {
  const { rows } = await client.query(
    `SELECT id, valor_por_peca
       FROM faccao_tabela_preco
      WHERE fornecedor_id = $1
        AND etapa_id = $2
        AND (produto_id IS NULL OR produto_id = $3)
        AND vigencia_inicio <= $4
        AND (vigencia_fim IS NULL OR vigencia_fim >= $4)
      ORDER BY (produto_id IS NOT NULL) DESC, vigencia_inicio DESC, id DESC
      LIMIT 1`,
    [fornecedorId, etapaId, produtoId ?? null, data]
  );
  return rows[0] || null;
}

async function buscarEtapa(client, id) {
  const { rows } = await client.query('SELECT * FROM producao_etapas WHERE id = $1', [id]);
  return rows[0] || null;
}

// Movimenta de UMA origem para VÁRIOS destinos, numa transação só.
//
// `destinos` é uma lista de:
//   { etapa_destino_id, fornecedor_destino_id?, tipo?, motivo_id?,
//     etapa_identificadora_id?, previsao_retorno?, observacao?,
//     itens: [{ cor, tamanho, quantidade }] }
//
// Devolve { movimentos, ordensServico, avisos }.
async function movimentar(client, {
  ordemId, etapaOrigemId, fornecedorOrigemId, destinos, data, usuarioId,
}) {
  const avisos = [];
  const movimentos = [];
  const ordensServico = [];

  const { rows: ordemRows } = await client.query(
    'SELECT id, produto_id, empresa_id, situacao FROM ordens_producao WHERE id = $1 FOR UPDATE',
    [ordemId]
  );
  if (ordemRows.length === 0) throw Object.assign(new Error('Ordem de produção não encontrada.'), { status: 400 });
  const ordem = ordemRows[0];
  if (['cancelada', 'concluida'].includes(ordem.situacao)) {
    throw Object.assign(new Error(`Ordem ${ordem.situacao} não movimenta.`), { status: 400 });
  }

  const dataMov = data || new Date().toISOString().slice(0, 10);

  // Confere o saldo da ORIGEM contra a soma de TODOS os destinos, antes de
  // gravar qualquer coisa. Conferir destino a destino deixaria passar o caso
  // em que cada um cabe sozinho mas a soma não cabe.
  const saldo = etapaOrigemId
    ? await saldoNaEtapa(client, { ordemId, etapaId: etapaOrigemId, fornecedorId: fornecedorOrigemId })
    : null;

  if (saldo) {
    const pedido = new Map();
    for (const d of destinos) {
      for (const it of d.itens || []) {
        const chave = `${it.cor || ''}|${it.tamanho || ''}`;
        pedido.set(chave, (pedido.get(chave) || 0) + (Number(it.quantidade) || 0));
      }
    }
    for (const [chave, qtd] of pedido) {
      const disponivel = saldo.get(chave) || 0;
      if (qtd > disponivel) {
        const [cor, tamanho] = chave.split('|');
        throw Object.assign(
          new Error(
            `Não há essa quantidade na origem: ${cor || 'sem cor'} ${tamanho || 'sem tamanho'} tem ${disponivel}, `
            + `e a movimentação pede ${qtd}.`
          ),
          { status: 400 }
        );
      }
    }
  }

  for (const d of destinos) {
    const itens = (d.itens || []).filter((it) => Number(it.quantidade) > 0);
    if (itens.length === 0) continue;

    const etapaDestino = d.etapa_destino_id ? await buscarEtapa(client, d.etapa_destino_id) : null;
    if (d.etapa_destino_id && !etapaDestino) {
      throw Object.assign(new Error('Etapa de destino não encontrada.'), { status: 400 });
    }

    const tipo = d.tipo || 'normal';
    if (tipo === 'reprocesso' && !d.motivo_id) {
      throw Object.assign(
        new Error('Reprocesso exige motivo — é o que permite saber qual etapa causou o defeito.'),
        { status: 400 }
      );
    }

    // Destino externo: precisa de facção, de prazo e gera O.S.
    let ordemServicoId = d.ordem_servico_id || null;
    if (etapaDestino && etapaDestino.natureza === 'externa' && tipo !== 'estorno') {
      if (!d.fornecedor_destino_id) {
        throw Object.assign(
          new Error(`A etapa "${etapaDestino.nome}" é externa: informe a facção que vai receber.`),
          { status: 400 }
        );
      }
      if (!d.previsao_retorno && !ordemServicoId) {
        throw Object.assign(
          new Error(
            `Informe a previsão de retorno da facção. Sem prazo prometido não há como medir atraso.`
          ),
          { status: 400 }
        );
      }

      if (!ordemServicoId) {
        const preco = await precoVigente(client, {
          fornecedorId: d.fornecedor_destino_id,
          etapaId: etapaDestino.id,
          produtoId: ordem.produto_id,
          data: dataMov,
        });
        if (!preco) {
          avisos.push(
            `Não há preço de serviço cadastrado para essa facção nesta etapa. A O.S. foi criada sem valor, `
            + `e o custo do serviço vai aparecer como "—" até alguém cadastrar o preço.`
          );
        }

        const { rows: osRows } = await client.query(
          `INSERT INTO ordens_servico
             (empresa_id, ordem_id, etapa_id, fornecedor_id, situacao, data_remessa,
              previsao_retorno, valor_por_peca, tabela_preco_id, observacao, criado_por)
           VALUES ($1,$2,$3,$4,'remetida',$5,$6,$7,$8,$9,$10) RETURNING *`,
          [ordem.empresa_id, ordemId, etapaDestino.id, d.fornecedor_destino_id, dataMov,
           d.previsao_retorno, preco?.valor_por_peca ?? null, preco?.id ?? null,
           d.observacao || null, usuarioId || null]
        );
        ordemServicoId = osRows[0].id;
        ordensServico.push(osRows[0]);
      }

      for (const it of itens) {
        await client.query(
          `INSERT INTO ordem_servico_itens (ordem_servico_id, cor, tamanho, quantidade_remetida)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (ordem_servico_id, cor, tamanho) DO UPDATE
             SET quantidade_remetida = ordem_servico_itens.quantidade_remetida + EXCLUDED.quantidade_remetida`,
          [ordemServicoId, it.cor || '', it.tamanho || '', Number(it.quantidade)]
        );
      }
    }

    for (const it of itens) {
      const { rows } = await client.query(
        `INSERT INTO producao_movimentos
           (ordem_id, cor, tamanho, etapa_origem_id, etapa_destino_id,
            fornecedor_origem_id, fornecedor_destino_id, tipo, quantidade,
            ordem_servico_id, motivo_id, etapa_identificadora_id,
            data_movimento, observacao, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [ordemId, it.cor || '', it.tamanho || '', etapaOrigemId || null, d.etapa_destino_id || null,
         fornecedorOrigemId || null, d.fornecedor_destino_id || null, tipo, Number(it.quantidade),
         ordemServicoId, d.motivo_id || null, d.etapa_identificadora_id || null,
         dataMov, d.observacao || null, usuarioId || null]
      );
      movimentos.push(rows[0]);
    }
  }

  if (movimentos.length === 0) {
    throw Object.assign(new Error('Nenhuma quantidade informada.'), { status: 400 });
  }

  return { movimentos, ordensServico, avisos };
}

// Estorna um movimento: cria outro com as pontas invertidas.
async function estornar(client, { movimentoId, usuarioId, motivo }) {
  const { rows } = await client.query(
    'SELECT * FROM producao_movimentos WHERE id = $1 FOR UPDATE', [movimentoId]
  );
  if (rows.length === 0) throw Object.assign(new Error('Movimento não encontrado.'), { status: 404 });
  const m = rows[0];
  if (m.estornado_em) throw Object.assign(new Error('Este movimento já foi estornado.'), { status: 400 });
  if (m.tipo === 'estorno') throw Object.assign(new Error('Estorno não se estorna.'), { status: 400 });
  if (!String(motivo || '').trim()) {
    throw Object.assign(new Error('Escreva o motivo do estorno.'), { status: 400 });
  }

  const { rows: novo } = await client.query(
    `INSERT INTO producao_movimentos
       (ordem_id, cor, tamanho, etapa_origem_id, etapa_destino_id,
        fornecedor_origem_id, fornecedor_destino_id, tipo, quantidade,
        ordem_servico_id, estorno_de_id, data_movimento, observacao, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'estorno',$8,$9,$10,CURRENT_DATE,$11,$12) RETURNING *`,
    [m.ordem_id, m.cor, m.tamanho,
     m.etapa_destino_id, m.etapa_origem_id,      // pontas invertidas
     m.fornecedor_destino_id, m.fornecedor_origem_id,
     m.quantidade, m.ordem_servico_id, m.id, `[estorno] ${motivo}`, usuarioId || null]
  );

  await client.query('UPDATE producao_movimentos SET estornado_em = now() WHERE id = $1', [movimentoId]);

  // Se o movimento tocou uma O.S., a coluna que volta atrás depende do TIPO do
  // movimento.
  //
  // ⚠️ Defeito corrigido em 09/09/2026: a condição era `if (m.ordem_servico_id
  // && m.etapa_destino_id)` e subtraía SEMPRE de `quantidade_remetida`. Um
  // movimento de RETORNO também tem `ordem_servico_id` e `etapa_destino_id`
  // (quando o operador escolheu a etapa que recebe), então estornar um retorno
  // lançado errado baixava o REMETIDO: numa O.S. de 160 com 90 de retorno
  // estornado, o remetido virava 70 contra 90 retornados, a quebra ficava
  // NEGATIVA em 20, a O.S. continuava "concluída" para sempre e o ranking da
  // facção invertia. Segunda e perda (destino nulo) nem entravam na condição, e
  // o estorno devolvia as peças ao WIP deixando os contadores inflados.
  const COLUNA_POR_TIPO = {
    normal: 'quantidade_remetida',
    reprocesso: 'quantidade_remetida',
    retorno: 'quantidade_retornada',
    segunda: 'quantidade_segunda',
    perda: 'quantidade_perdida',
  };
  const coluna = m.ordem_servico_id ? COLUNA_POR_TIPO[m.tipo] : null;
  if (coluna) {
    await client.query(
      `UPDATE ordem_servico_itens
          SET ${coluna} = GREATEST(0, ${coluna} - $1)
        WHERE ordem_servico_id = $2 AND cor = $3 AND tamanho = $4`,
      [m.quantidade, m.ordem_servico_id, m.cor, m.tamanho]
    );
    // A situação da O.S. tem de ser recalculada: um retorno estornado pode
    // fazer uma O.S. concluída voltar a ser parcial, e sem isto ela ficaria
    // marcada como fechada com peça ainda na facção.
    await recalcularSituacaoOS(client, m.ordem_servico_id);
  }

  return novo[0];
}

// Recalcula situação e data de retorno de uma O.S. a partir dos itens.
// Extraída do retorno em 09/09/2026 porque o estorno precisa da mesma conta —
// e duas cópias da mesma regra divergem na primeira correção.
async function recalcularSituacaoOS(client, ordemServicoId, dataMov = null) {
  const { rows: soma } = await client.query(
    `SELECT SUM(quantidade_remetida) AS remetido,
            SUM(quantidade_retornada + quantidade_segunda + quantidade_perdida) AS voltou
       FROM ordem_servico_itens WHERE ordem_servico_id = $1`,
    [ordemServicoId]
  );
  const remetido = Number(soma[0].remetido || 0);
  const voltou = Number(soma[0].voltou || 0);
  const situacao = voltou <= 0 ? 'remetida' : (voltou >= remetido ? 'concluida' : 'parcial');
  await client.query(
    // $1 aparece duas vezes e o Postgres não consegue deduzir o tipo sozinho
    // ("inconsistent types deduced for parameter $1") — daí o cast explícito.
    `UPDATE ordens_servico
        SET situacao = CASE WHEN situacao = 'cancelada' THEN situacao ELSE $1::varchar END,
            data_retorno = CASE WHEN $1::varchar = 'concluida'
                                THEN COALESCE(data_retorno, $2::date, CURRENT_DATE)
                                ELSE NULL END,
            atualizado_em = now()
      WHERE id = $3`,
    [situacao, dataMov, ordemServicoId]
  );
  return situacao;
}

// Retorno de facção: o que voltou bom, o que voltou como segunda e o que se
// perdeu. O que não voltou de jeito nenhum é QUEBRA, e é calculada — nunca
// digitada.
async function registrarRetorno(client, { ordemServicoId, itens, etapaDestinoId, data, usuarioId, observacao, sairDoFluxo }) {
  const { rows: osRows } = await client.query(
    'SELECT * FROM ordens_servico WHERE id = $1 FOR UPDATE', [ordemServicoId]
  );
  if (osRows.length === 0) throw Object.assign(new Error('Ordem de serviço não encontrada.'), { status: 404 });
  const os = osRows[0];
  if (os.situacao === 'cancelada') {
    throw Object.assign(new Error('Ordem de serviço cancelada não recebe retorno.'), { status: 400 });
  }

  const dataMov = data || new Date().toISOString().slice(0, 10);
  const movimentos = [];

  // ⚠️ Defeito corrigido em 09/09/2026: a etapa que recebe a peça boa era
  // opcional, e o combo da tela abria vazio. O caminho de menor esforço era
  // digitar "90 boas" e clicar em Registrar — as 90 peças saíam do WIP da
  // facção e não entravam em lugar nenhum. A O.S. fechava, o título era gerado,
  // a facção era paga, e as peças sumiam do sistema em silêncio.
  //
  // Agora a etapa é obrigatória quando volta peça boa, e sair do fluxo é uma
  // escolha explícita (`sair_do_fluxo`) — que é coisa rara e nunca deveria ser
  // o padrão.
  const totalBoas = (itens || []).reduce((s, it) => s + (Number(it.quantidade_retornada) || 0), 0);
  if (totalBoas > 0 && !etapaDestinoId && sairDoFluxo !== true) {
    throw Object.assign(
      new Error(
        'Diga para qual etapa as peças boas voltam. Sem etapa de destino elas saem da facção e não '
        + 'entram em lugar nenhum: somem do sistema, e a O.S. fecha como se tudo estivesse certo.'
      ),
      { status: 400, exige: 'etapa_destino_id' }
    );
  }

  // Devolver peça boa para uma etapa EXTERNA por aqui contornaria todas as
  // regras da movimentação: as peças ficariam numa facção sem O.S., sem preço
  // congelado, sem previsão de retorno e sem compromisso no financeiro.
  if (etapaDestinoId) {
    const { rows: etapaRows } = await client.query(
      'SELECT nome, natureza FROM producao_etapas WHERE id = $1', [etapaDestinoId]
    );
    if (etapaRows.length === 0) {
      throw Object.assign(new Error('Etapa de destino não encontrada.'), { status: 400 });
    }
    if (etapaRows[0].natureza === 'externa') {
      throw Object.assign(
        new Error(
          `${etapaRows[0].nome} é uma etapa externa: mandar a peça para lá é uma remessa nova, com facção, `
          + 'prazo e preço. Devolva primeiro para uma etapa interna e faça a remessa em Gerar Movimentação.'
        ),
        { status: 400 }
      );
    }
  }

  for (const it of itens || []) {
    const boa = Number(it.quantidade_retornada) || 0;
    const segunda = Number(it.quantidade_segunda) || 0;
    const perdida = Number(it.quantidade_perdida) || 0;
    if (boa + segunda + perdida <= 0) continue;

    const { rows: atual } = await client.query(
      `SELECT quantidade_remetida, quantidade_retornada, quantidade_segunda, quantidade_perdida
         FROM ordem_servico_itens
        WHERE ordem_servico_id = $1 AND cor = $2 AND tamanho = $3`,
      [ordemServicoId, it.cor || '', it.tamanho || '']
    );
    if (atual.length === 0) {
      throw Object.assign(
        new Error(`${it.cor || 'sem cor'} ${it.tamanho || 'sem tamanho'} não foi remetido nesta O.S.`),
        { status: 400 }
      );
    }
    const remetido = Number(atual[0].quantidade_remetida);
    const jaVoltou = Number(atual[0].quantidade_retornada)
      + Number(atual[0].quantidade_segunda)
      + Number(atual[0].quantidade_perdida);
    if (jaVoltou + boa + segunda + perdida > remetido) {
      throw Object.assign(
        new Error(
          `Está voltando mais do que foi remetido em ${it.cor || 'sem cor'} ${it.tamanho || 'sem tamanho'}: `
          + `remetido ${remetido}, já retornado ${jaVoltou}, e este retorno soma ${boa + segunda + perdida}.`
        ),
        { status: 400 }
      );
    }

    await client.query(
      `UPDATE ordem_servico_itens
          SET quantidade_retornada = quantidade_retornada + $1,
              quantidade_segunda   = quantidade_segunda + $2,
              quantidade_perdida   = quantidade_perdida + $3
        WHERE ordem_servico_id = $4 AND cor = $5 AND tamanho = $6`,
      [boa, segunda, perdida, ordemServicoId, it.cor || '', it.tamanho || '']
    );

    // Peça boa volta para a etapa seguinte (ou para a etapa informada).
    if (boa > 0) {
      const { rows } = await client.query(
        `INSERT INTO producao_movimentos
           (ordem_id, cor, tamanho, etapa_origem_id, etapa_destino_id,
            fornecedor_origem_id, tipo, quantidade, ordem_servico_id,
            data_movimento, observacao, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,'retorno',$7,$8,$9,$10,$11) RETURNING *`,
        [os.ordem_id, it.cor || '', it.tamanho || '', os.etapa_id, etapaDestinoId || null,
         os.fornecedor_id, boa, ordemServicoId, dataMov, observacao || null, usuarioId || null]
      );
      movimentos.push(rows[0]);
    }
    // Segunda qualidade e perda SAEM do fluxo: destino nulo.
    for (const [qtd, tipo] of [[segunda, 'segunda'], [perdida, 'perda']]) {
      if (qtd <= 0) continue;
      const { rows } = await client.query(
        `INSERT INTO producao_movimentos
           (ordem_id, cor, tamanho, etapa_origem_id, fornecedor_origem_id,
            tipo, quantidade, ordem_servico_id, motivo_id, data_movimento, observacao, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [os.ordem_id, it.cor || '', it.tamanho || '', os.etapa_id, os.fornecedor_id,
         tipo, qtd, ordemServicoId, it.motivo_id || null, dataMov, observacao || null, usuarioId || null]
      );
      movimentos.push(rows[0]);
    }
  }

  // Situação da O.S.: concluída quando nada mais pode voltar.
  const situacao = await recalcularSituacaoOS(client, ordemServicoId, dataMov);

  return { movimentos, situacao };
}

// Encerra uma O.S. assumindo a quebra.
//
// Sem esta saída, uma O.S. com peça sumida ficava PARCIAL para sempre: `voltou`
// nunca alcança `remetido`, `data_retorno` nunca é gravada, o atraso cresce
// indefinidamente e a pendência bloqueante do financeiro nunca fecha — o que
// travava a conclusão da ordem de produção permanentemente. A única saída era
// "dispensar" a pendência na Caixa de Entrada, que é registrar uma mentira.
//
// A quebra continua medida e continua aparecendo: encerrar não a apaga, só
// reconhece que ela não vai voltar.
async function encerrarComQuebra(client, { ordemServicoId, motivo, usuarioId }) {
  if (!String(motivo || '').trim()) {
    throw Object.assign(new Error('Escreva o que aconteceu com as peças que não voltaram.'), { status: 400 });
  }
  const { rows } = await client.query(
    'SELECT * FROM ordens_servico WHERE id = $1 FOR UPDATE', [ordemServicoId]
  );
  if (rows.length === 0) throw Object.assign(new Error('Ordem de serviço não encontrada.'), { status: 404 });
  if (rows[0].situacao === 'cancelada') {
    throw Object.assign(new Error('Ordem de serviço cancelada não se encerra.'), { status: 400 });
  }

  const { rows: quebra } = await client.query(
    'SELECT quebra FROM vw_faccao_quebra WHERE ordem_servico_id = $1', [ordemServicoId]
  );
  const pecas = Number(quebra[0]?.quebra || 0);

  await client.query(
    `UPDATE ordens_servico
        SET situacao = 'concluida', data_retorno = COALESCE(data_retorno, CURRENT_DATE),
            observacao = COALESCE(observacao,'') || $2, atualizado_em = now()
      WHERE id = $1`,
    [ordemServicoId, `\n[encerrada com quebra de ${pecas} peça(s)] ${motivo}`]
  );
  return { quebra: pecas };
}

module.exports = {
  SITUACOES_OS,
  saldoNaEtapa,
  precoVigente,
  movimentar,
  estornar,
  registrarRetorno,
  recalcularSituacaoOS,
  encerrarComQuebra,
};
