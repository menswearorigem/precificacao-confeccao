// Extrato financeiro dos marketplaces — a base do módulo Financeiro.
//
// O QUE ESTE ARQUIVO FAZ, E O QUE NÃO FAZ
//
// Faz: lê o extrato de cada plataforma conectada (a movimentação da conta,
// não a venda), normaliza tudo pro mesmo formato de lançamento e grava em
// `fin_extrato_lancamentos` / `fin_repasses`.
//
// NÃO faz: cálculo de preço, margem, markup, imposto, rateio ou qualquer
// outra coisa do motor de precificação. Nada aqui lê `calc.js`, nada aqui
// escreve em `produtos`, `pedidos_venda`, `pedido_itens` ou nas tabelas de
// configuração. O vínculo com o pedido é gravado só do lado do extrato
// (`fin_extrato_lancamentos.pedido_id`) — `pedidos_venda` não é tocado.
// Ver REGRA 1 e REGRA 4.
//
// TRÊS PRINCÍPIOS QUE VALEM PRA TODA PLATAFORMA AQUI
//
// 1. Valor assinado. Crédito positivo, débito negativo. A soma de um
//    período é literalmente o quanto o saldo se moveu, e nenhuma tela
//    precisa saber o sinal de cada tipo.
// 2. Linha ilegível não vira zero. Lançamento sem data ou sem valor
//    reconhecível é CONTADO e reportado como ressalva, nunca gravado como
//    R$ 0,00 — um zero no meio do extrato passa despercebido e faz o
//    relatório fechar errado com cara de certo (REGRA 2).
// 3. Liberado e pendente nunca somam juntos. Dinheiro que a plataforma já
//    calculou mas ainda não soltou é outra coisa, e vai numa linha própria.

const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const tiktokShop = require('./marketplaces/tiktokShop');
const { garantirTokenValido } = require('./marketplaceSync');

const LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop' };

// Toda sincronização relê esta janela pra trás, sempre. Plataforma insere
// lançamento com data retroativa o tempo todo (estorno de venda antiga,
// ajuste manual, correção de frete de semanas atrás) — um cursor que só
// andasse pra frente perderia esse dinheiro pra sempre. Reler é barato: a
// chave única (integração + id do lançamento + tipo) descarta repetição.
const JANELA_RELEITURA_DIAS = 45;

// Teto de janela por plataforma, em dias. NÃO é preferência nossa: é o que
// cada API aceita numa chamada só.
//
// Mercado Livre: o Mercado Pago recusa qualquer pedido de relatório com
// intervalo de 90 dias ou mais ("Date interval should be less than 90 days")
// — foi o erro que derrubou as duas conexões do ML na primeira carga, que
// pedia 180 dias de uma vez. 80 deixa folga confortável abaixo do limite.
//
// Shopee e TikTok: a quebra em pedaços já é feita dentro do próprio cliente
// (15 dias na Shopee, paginação por page_token na TikTok), então aqui o teto
// existe só pra não montar uma janela absurda.
const JANELA_MAXIMA_DIAS = {
  mercado_livre: 80,
  shopee: 180,
  tiktok_shop: 180,
};

// Até onde pra trás o histórico é buscado sozinho, andando um pedaço por
// ciclo. Um ano cobre o fechamento contábil e a comparação com o mesmo mês
// do ano passado.
const HISTORICO_ALVO_DIAS = 365;

const COOLDOWN_MS = 30 * 60 * 1000;
const ultimaSincronizacaoPorIntegracao = new Map();

// Quanto tempo esperar o Mercado Pago gerar o relatório de liberações antes
// de desistir daquele pedido e tentar de novo do zero no ciclo seguinte.
const TIMEOUT_RELATORIO_ML_MS = 90 * 60 * 1000;

const TIPOS_VALIDOS = new Set([
  'repasse_venda', 'devolucao', 'ads', 'taxa', 'ajuste', 'antecipacao', 'saque', 'outros',
]);

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

function isoDoDia(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function diasAtras(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function isoMenosDias(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - n);
  return isoDoDia(d);
}

function diferencaEmDias(inicioIso, fimIso) {
  const a = new Date(`${inicioIso}T12:00:00`).getTime();
  const b = new Date(`${fimIso}T12:00:00`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function maiorIso(a, b) { return a > b ? a : b; }

// Decide qual pedaço do extrato ler neste ciclo.
//
// A lógica tem duas prioridades, nesta ordem:
//
//   1. O RECENTE primeiro. Enquanto os últimos dias não estiverem lidos, é
//      isso que interessa — o financeiro pergunta pelo mês corrente, não
//      pelo ano passado.
//   2. Só depois o HISTÓRICO, um pedaço por ciclo, andando pra trás até
//      `HISTORICO_ALVO_DIAS`. Isso existe porque a plataforma limita o
//      tamanho da janela (80 dias no Mercado Pago), então um ano só entra
//      em partes.
//
// A janela recente sempre reabre `JANELA_RELEITURA_DIAS` pra trás do que já
// foi lido: a plataforma insere lançamento com data retroativa (estorno de
// venda antiga, ajuste, correção de frete), e um cursor que só andasse pra
// frente perderia esse dinheiro pra sempre.
function planejarJanela(marketplace, estado, hojeIso) {
  const maximo = JANELA_MAXIMA_DIAS[marketplace] || 80;
  const limiteHistorico = isoMenosDias(hojeIso, HISTORICO_ALVO_DIAS);

  // Nunca leu nada: começa pelo pedaço mais recente que a API aceita.
  if (!estado.lido_ate) {
    return { inicio: maiorIso(isoMenosDias(hojeIso, maximo), limiteHistorico), fim: hojeIso, fase: 'recente' };
  }

  const lidoAte = String(estado.lido_ate).slice(0, 10);
  const inicioRecente = maiorIso(isoMenosDias(lidoAte, JANELA_RELEITURA_DIAS), isoMenosDias(hojeIso, maximo));

  // O recente ainda não está em dia, ou a releitura ainda cabe na janela:
  // é sempre esta a prioridade.
  if (lidoAte < hojeIso || !estado.lido_desde) {
    return { inicio: inicioRecente, fim: hojeIso, fase: 'recente' };
  }

  // Recente em dia. Sobrou histórico pra trás?
  const lidoDesde = String(estado.lido_desde).slice(0, 10);
  if (lidoDesde > limiteHistorico) {
    // O pedaço anterior termina um dia antes do que já foi lido, pra não
    // reler à toa o que já está no banco.
    const fim = isoMenosDias(lidoDesde, 1);
    const inicio = maiorIso(isoMenosDias(fim, maximo), limiteHistorico);
    return { inicio, fim, fase: 'historico' };
  }

  // Nada de histórico faltando — segue relendo o recente, que é onde o
  // dado muda.
  return { inicio: inicioRecente, fim: hojeIso, fase: 'recente' };
}

// Avança os dois cursores depois de ler uma janela com sucesso. `lido_ate`
// só anda pra frente e `lido_desde` só anda pra trás — assim uma leitura
// de histórico não faz o cursor recente retroceder, nem vice-versa.
function cursoresApos(estado, { inicio, fim }) {
  const ateAtual = estado.lido_ate ? String(estado.lido_ate).slice(0, 10) : null;
  const desdeAtual = estado.lido_desde ? String(estado.lido_desde).slice(0, 10) : null;
  return {
    lido_ate: !ateAtual || fim > ateAtual ? fim : ateAtual,
    lido_desde: !desdeAtual || inicio < desdeAtual ? inicio : desdeAtual,
  };
}

// Dia no fuso de Brasília a partir de um unix em segundos. O financeiro
// fecha o dia pelo calendário daqui: a partir das 21h o UTC já virou o dia
// seguinte, e um lançamento das 22h apareceria no dia errado do relatório.
function diaBrasilia(unixSegundos) {
  if (!Number.isFinite(unixSegundos) || unixSegundos <= 0) return null;
  const d = new Date((unixSegundos - 3 * 60 * 60) * 1000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Estado da sincronização
// ---------------------------------------------------------------------------

async function lerEstado(integracaoId) {
  const { rows } = await pool.query(
    'SELECT * FROM fin_extrato_sync WHERE origem_integracao_id = $1',
    [integracaoId]
  );
  if (rows[0]) return rows[0];
  const { rows: criados } = await pool.query(
    `INSERT INTO fin_extrato_sync (origem_integracao_id) VALUES ($1)
     ON CONFLICT (origem_integracao_id) DO UPDATE SET atualizado_em = now()
     RETURNING *`,
    [integracaoId]
  );
  return criados[0];
}

async function gravarEstado(integracaoId, patch) {
  const campos = [];
  const valores = [];
  let i = 1;
  for (const [chave, valor] of Object.entries(patch)) {
    campos.push(`${chave} = $${i}`);
    valores.push(valor);
    i += 1;
  }
  if (campos.length === 0) return;
  valores.push(integracaoId);
  await pool.query(
    `UPDATE fin_extrato_sync SET ${campos.join(', ')}, atualizado_em = now()
     WHERE origem_integracao_id = $${i}`,
    valores
  );
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

// Grava (ou atualiza) um lote de lançamentos normalizados.
//
// ON CONFLICT atualiza em vez de ignorar porque valor e status MUDAM
// legitimamente entre leituras: um lançamento lido como "pendente" ontem
// pode estar "liberado" hoje, e a plataforma corrige valor de ajuste. O que
// nunca muda é a identidade da linha — e é ela que está na chave única.
async function gravarLancamentos(integracaoId, marketplace, lancamentos) {
  let gravados = 0;
  for (const l of lancamentos) {
    if (!l || !l.dataLiberacao || l.valor === null || l.valor === undefined) continue;
    const tipo = TIPOS_VALIDOS.has(l.tipo) ? l.tipo : 'outros';
    await pool.query(
      `INSERT INTO fin_extrato_lancamentos (
         origem_integracao_id, marketplace, lancamento_id_externo, tipo,
         descricao_externa, data_liberacao, data_evento, valor, moeda,
         pedido_id_externo, repasse_id_externo, status, detalhe
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (origem_integracao_id, lancamento_id_externo, tipo) DO UPDATE SET
         descricao_externa = EXCLUDED.descricao_externa,
         data_liberacao = EXCLUDED.data_liberacao,
         data_evento = EXCLUDED.data_evento,
         valor = EXCLUDED.valor,
         moeda = EXCLUDED.moeda,
         pedido_id_externo = COALESCE(EXCLUDED.pedido_id_externo, fin_extrato_lancamentos.pedido_id_externo),
         repasse_id_externo = COALESCE(EXCLUDED.repasse_id_externo, fin_extrato_lancamentos.repasse_id_externo),
         status = EXCLUDED.status,
         detalhe = EXCLUDED.detalhe,
         atualizado_em = now()`,
      [
        integracaoId,
        marketplace,
        String(l.idExterno).slice(0, 160),
        tipo,
        l.descricaoExterna || null,
        l.dataLiberacao,
        l.dataEvento || null,
        l.valor,
        (l.moeda || 'BRL').slice(0, 3),
        l.pedidoIdExterno ? String(l.pedidoIdExterno).slice(0, 120) : null,
        l.repasseIdExterno ? String(l.repasseIdExterno).slice(0, 160) : null,
        l.status === 'pendente' ? 'pendente' : 'liberado',
        l.detalhe ? JSON.stringify(l.detalhe) : null,
      ]
    );
    gravados += 1;
  }
  return gravados;
}

async function gravarRepasse(integracaoId, marketplace, repasse) {
  if (!repasse || !repasse.idExterno) return;
  await pool.query(
    `INSERT INTO fin_repasses (
       origem_integracao_id, marketplace, repasse_id_externo,
       data_liberacao, data_evento, valor_liquido, moeda, status, detalhe
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (origem_integracao_id, repasse_id_externo) DO UPDATE SET
       data_liberacao = EXCLUDED.data_liberacao,
       data_evento = EXCLUDED.data_evento,
       valor_liquido = EXCLUDED.valor_liquido,
       status = EXCLUDED.status,
       detalhe = EXCLUDED.detalhe,
       atualizado_em = now()`,
    [
      integracaoId,
      marketplace,
      String(repasse.idExterno).slice(0, 160),
      repasse.dataLiberacao || null,
      repasse.dataEvento || null,
      repasse.valorLiquido ?? null,
      (repasse.moeda || 'BRL').slice(0, 3),
      repasse.status || 'previsto',
      repasse.detalhe ? JSON.stringify(repasse.detalhe) : null,
    ]
  );
}

// Fecha o vínculo lançamento -> pedido. Roda depois de gravar, e de novo a
// cada ciclo: um lançamento pode chegar antes de o pedido ser importado.
//
// O casamento é SÓ por identificador exato (id do pedido na plataforma ou
// id do pagamento). Aproximar por valor e data — "esse crédito de R$ 87,40
// no dia 12 deve ser aquele pedido de R$ 87,40" — é o tipo de cruzamento
// que a REGRA 2 proíbe: dois pedidos do mesmo valor no mesmo dia é o caso
// comum, não a exceção.
async function vincularPedidos(integracaoId) {
  const { rowCount: porPedido } = await pool.query(
    `UPDATE fin_extrato_lancamentos l
        SET pedido_id = p.id, atualizado_em = now()
       FROM pedidos_venda p
      WHERE l.origem_integracao_id = $1
        AND l.pedido_id IS NULL
        AND l.pedido_id_externo IS NOT NULL
        AND p.origem_marketplace = l.marketplace
        AND p.origem_pedido_id = l.pedido_id_externo`,
    [integracaoId]
  );

  // Mercado Livre: a linha do extrato traz o id do PAGAMENTO, não o do
  // pedido. `pagamento_id_marketplace` pode ter mais de um id separado por
  // vírgula (pagamento dividido), daí o split.
  const { rowCount: porPagamento } = await pool.query(
    `UPDATE fin_extrato_lancamentos l
        SET pedido_id = p.id, atualizado_em = now()
       FROM pedidos_venda p
      WHERE l.origem_integracao_id = $1
        AND l.pedido_id IS NULL
        AND l.marketplace = 'mercado_livre'
        AND p.pagamento_id_marketplace IS NOT NULL
        AND l.lancamento_id_externo = ANY(
              regexp_split_to_array(replace(p.pagamento_id_marketplace, ' ', ''), ',')
            )`,
    [integracaoId]
  );

  return porPedido + porPagamento;
}

// ---------------------------------------------------------------------------
// Mercado Livre — relatório de liberações (assíncrono, duas fases)
// ---------------------------------------------------------------------------

async function sincronizarExtratoMercadoLivre(integracao, { inicio, fim }) {
  const estado = await lerEstado(integracao.id);
  const accessToken = integracao.access_token;

  // Fase 2: já existe um relatório pedido — tenta baixar.
  if (estado.relatorio_pendente) {
    const pedidoEm = estado.relatorio_pedido_em ? new Date(estado.relatorio_pedido_em).getTime() : 0;
    const lista = await mercadoLivre.listarRelatoriosLiberacoes({ accessToken });
    const alvo = estado.relatorio_pendente === 'aguardando'
      // O POST nem sempre devolve o nome do arquivo. Nesse caso o relatório
      // certo é o mais recente criado depois do pedido (com 5 min de folga
      // pra diferença de relógio entre nosso servidor e o Mercado Pago).
      ? lista.find((r) => r.criadoEm && new Date(r.criadoEm).getTime() >= pedidoEm - 5 * 60 * 1000)
      : lista.find((r) => r.arquivo === estado.relatorio_pendente);

    if (!alvo) {
      if (Date.now() - pedidoEm > TIMEOUT_RELATORIO_ML_MS) {
        await gravarEstado(integracao.id, {
          relatorio_pendente: null,
          relatorio_pedido_em: null,
          ultimo_erro: 'O Mercado Pago não entregou o relatório de liberações no prazo. Um novo pedido será feito no próximo ciclo.',
        });
        return { fase: 'timeout', gravados: 0 };
      }
      return { fase: 'aguardando', gravados: 0 };
    }

    const csv = await mercadoLivre.baixarRelatorioLiberacoes({ accessToken, arquivo: alvo.arquivo });
    const { lancamentos, naoInterpretadas, totalLinhas } = mercadoLivre.mapearRelatorioLiberacoes(csv);
    const gravados = await gravarLancamentos(integracao.id, 'mercado_livre', lancamentos);

    // Toda linha de saída de dinheiro pro banco também vira um repasse, que
    // é o nível que o financeiro compara com o extrato bancário.
    for (const l of lancamentos.filter((x) => x.tipo === 'saque')) {
      await gravarRepasse(integracao.id, 'mercado_livre', {
        idExterno: l.idExterno,
        dataLiberacao: l.dataLiberacao,
        dataEvento: l.dataEvento,
        valorLiquido: Math.abs(l.valor),
        moeda: l.moeda,
        status: 'pago',
        detalhe: { origem: 'release_report', descricao: l.descricaoExterna },
      });
    }

    // Os cursores avançam com a janela QUE O RELATÓRIO COBRE, não com a
    // janela que este ciclo calculou: quem pediu foi o ciclo anterior, e no
    // meio do caminho a data de hoje pode ter virado. Sem isso, um pedaço do
    // histórico seria marcado como lido sem nunca ter sido baixado.
    const janelaDoRelatorio = {
      inicio: estado.relatorio_de ? String(estado.relatorio_de).slice(0, 10) : inicio,
      fim: estado.relatorio_ate ? String(estado.relatorio_ate).slice(0, 10) : fim,
    };

    await gravarEstado(integracao.id, {
      relatorio_pendente: null,
      relatorio_pedido_em: null,
      relatorio_de: null,
      relatorio_ate: null,
      ...cursoresApos(estado, janelaDoRelatorio),
      ultimo_erro: null,
      ultimo_aviso: naoInterpretadas.length > 0
        ? `${naoInterpretadas.length} de ${totalLinhas} linha(s) do relatório de liberações não puderam ser interpretadas (data ou valor ilegível) e ficaram FORA do extrato. Primeira delas, linha ${naoInterpretadas[0].linha}: ${naoInterpretadas[0].conteudo}`
        : null,
    });
    return {
      fase: 'baixado', gravados, naoInterpretadas: naoInterpretadas.length, totalLinhas,
      janela: janelaDoRelatorio,
    };
  }

  // Fase 1: pede a geração do relatório da janela.
  //
  // O Mercado Pago recusa intervalo de 90 dias ou mais. `planejarJanela` já
  // devolve no máximo 80, mas a conferência fica aqui também porque esta
  // função também é chamada com janela escolhida à mão pela tela ("reler
  // este período") — e ali o período vem do filtro do usuário.
  const dias = diferencaEmDias(inicio, fim);
  if (dias >= 89) {
    throw new Error(
      `O Mercado Pago só entrega o relatório de liberações em janelas de até 89 dias, e este período tem ${dias}. `
      + 'Peça um período menor — o histórico mais antigo é completado sozinho, um pedaço a cada ciclo.'
    );
  }

  const resposta = await mercadoLivre.solicitarRelatorioLiberacoes({ accessToken, inicio, fim });
  const arquivo = resposta?.file_name || resposta?.fileName || null;
  await gravarEstado(integracao.id, {
    relatorio_pendente: arquivo || 'aguardando',
    relatorio_pedido_em: new Date(),
    relatorio_de: inicio,
    relatorio_ate: fim,
    ultimo_erro: null,
  });
  return { fase: 'solicitado', gravados: 0, janela: { inicio, fim } };
}

// ---------------------------------------------------------------------------
// Shopee — extrato da carteira (síncrono)
// ---------------------------------------------------------------------------

async function sincronizarExtratoShopee(integracao, { inicio, fim }, estado) {
  const desdeUnix = Math.floor(new Date(`${inicio}T00:00:00-03:00`).getTime() / 1000);
  const ateUnix = Math.floor(new Date(`${fim}T23:59:59-03:00`).getTime() / 1000);

  const cruas = await shopee.buscarExtratoCarteira({
    partnerId: integracao.client_id,
    partnerKey: integracao.client_secret,
    accessToken: integracao.access_token,
    shopId: integracao.conta_externa_id,
    desdeUnix,
    ateUnix,
  });

  const lancamentos = [];
  let descartadas = 0;
  for (const t of cruas) {
    const l = shopee.mapearTransacaoCarteira(t);
    if (l) lancamentos.push(l);
    else descartadas += 1;
  }

  const gravados = await gravarLancamentos(integracao.id, 'shopee', lancamentos);

  // Saque concluído = uma transferência pro banco. É o que o financeiro
  // procura no extrato bancário.
  for (const l of lancamentos.filter((x) => x.tipo === 'saque')) {
    const concluido = String(l.detalhe?.transactionType || '').toUpperCase().includes('COMPLETED');
    await gravarRepasse(integracao.id, 'shopee', {
      idExterno: l.repasseIdExterno || l.idExterno,
      dataLiberacao: l.dataLiberacao,
      dataEvento: l.dataEvento,
      valorLiquido: Math.abs(l.valor),
      moeda: l.moeda,
      status: concluido ? 'pago' : 'processando',
      detalhe: { origem: 'wallet_transaction', descricao: l.descricaoExterna, tipo: l.detalhe?.transactionType || null },
    });
  }

  await gravarEstado(integracao.id, {
    ...cursoresApos(estado, { inicio, fim }),
    ultimo_erro: null,
    ultimo_aviso: descartadas > 0
      ? `${descartadas} transação(ões) da carteira da Shopee vieram sem data ou sem valor legível e ficaram FORA do extrato — não foram lançadas como R$ 0,00.`
      : null,
  });

  return { gravados, descartadas, lidas: cruas.length, janela: { inicio, fim } };
}

// ---------------------------------------------------------------------------
// TikTok Shop — statements (cada um é um repasse) + saques
// ---------------------------------------------------------------------------

async function sincronizarExtratoTikTok(integracao, { inicio, fim }, estado) {
  const credenciais = {
    appKey: integracao.client_id,
    appSecret: integracao.client_secret,
    accessToken: integracao.access_token,
    shopCipher: integracao.shop_cipher,
  };
  const desdeUnix = Math.floor(new Date(`${inicio}T00:00:00-03:00`).getTime() / 1000);
  const ateUnix = Math.floor(new Date(`${fim}T23:59:59-03:00`).getTime() / 1000);

  const statements = await tiktokShop.buscarStatements({ ...credenciais, desdeUnix, ateUnix });

  let gravados = 0;
  let descartadas = 0;

  for (const statement of statements) {
    if (!statement.id) continue;
    const dia = diaBrasilia(statement.fechadoEm);

    await gravarRepasse(integracao.id, 'tiktok_shop', {
      idExterno: statement.id,
      dataLiberacao: dia,
      dataEvento: statement.fechadoEm ? new Date(statement.fechadoEm * 1000).toISOString() : null,
      valorLiquido: statement.valorLiquido,
      moeda: statement.moeda,
      status: statement.pago ? 'pago' : 'processando',
      detalhe: { origem: 'statement', statusPagamento: statement.statusPagamento },
    });

    const { lancamentos, descartadas: fora } = await tiktokShop.buscarLancamentosDoStatement({
      ...credenciais,
      statementId: statement.id,
    });
    descartadas += fora.length;

    gravados += await gravarLancamentos(integracao.id, 'tiktok_shop', lancamentos.map((l) => ({
      ...l,
      // A data que importa pro financeiro é a do REPASSE (quando o dinheiro
      // saiu), não a da criação do pedido. Pedido de março pago em abril é
      // movimentação de abril.
      dataLiberacao: dia,
      dataEvento: statement.fechadoEm ? new Date(statement.fechadoEm * 1000).toISOString() : null,
      status: statement.pago ? 'liberado' : 'pendente',
    })));
  }

  // Saques: quando a conta tem o escopo liberado, são a ponte mais direta
  // com o extrato bancário. Sem o escopo, a função devolve lista vazia e o
  // resto do extrato continua valendo.
  const saques = await tiktokShop.buscarSaques({ ...credenciais, desdeUnix, ateUnix });
  gravados += await gravarLancamentos(integracao.id, 'tiktok_shop', saques.map((s) => ({
    idExterno: s.idExterno,
    tipo: 'saque',
    descricaoExterna: s.tipoOriginal || 'Saque',
    dataLiberacao: diaBrasilia(s.criadoEm),
    dataEvento: s.criadoEm ? new Date(s.criadoEm * 1000).toISOString() : null,
    valor: s.valor,
    moeda: s.moeda,
    pedidoIdExterno: null,
    repasseIdExterno: null,
    status: s.status === 'SUCCESS' || s.status === 'PAID' ? 'liberado' : 'pendente',
    detalhe: { origem: 'withdrawal', status: s.status },
  })));

  await gravarEstado(integracao.id, {
    ...cursoresApos(estado, { inicio, fim }),
    ultimo_erro: null,
    ultimo_aviso: descartadas > 0
      ? `${descartadas} linha(s) de repasse da TikTok Shop vieram sem valor reconhecível e ficaram FORA do extrato — não foram lançadas como R$ 0,00.`
      : null,
  });

  return { gravados, descartadas, repasses: statements.length, janela: { inicio, fim } };
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

async function sincronizarExtratoIntegracao(integracaoId, { forcar = false, desde = null, ate = null } = {}) {
  const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
  const integracao = rows[0];
  if (!integracao) throw new Error('Conexão de marketplace não encontrada.');
  if (!integracao.ativo) throw new Error('Essa conexão está desativada.');
  if (!integracao.access_token) throw new Error('Essa conexão ainda não foi autorizada.');

  if (!forcar) {
    const ultima = ultimaSincronizacaoPorIntegracao.get(integracaoId) || 0;
    if (Date.now() - ultima < COOLDOWN_MS) return { pulado: true, motivo: 'cooldown' };
  }
  ultimaSincronizacaoPorIntegracao.set(integracaoId, Date.now());

  const estado = await lerEstado(integracaoId);
  const hoje = isoDoDia(new Date());

  // Sem período pedido à mão, quem decide o pedaço a ler é planejarJanela:
  // recente primeiro, histórico depois, sempre dentro do teto que a API da
  // plataforma aceita. Com período pedido à mão (tela: "reler este
  // período"), o pedido do usuário manda — mas ainda passa pelo teto, senão
  // a plataforma devolve erro e a leitura inteira se perde.
  const planejada = planejarJanela(integracao.marketplace, estado, hoje);
  const maximo = JANELA_MAXIMA_DIAS[integracao.marketplace] || 80;
  let inicio = desde || planejada.inicio;
  const fim = ate || planejada.fim;
  let janelaEncurtada = false;
  if (diferencaEmDias(inicio, fim) > maximo) {
    inicio = isoMenosDias(fim, maximo);
    janelaEncurtada = true;
  }

  await gravarEstado(integracaoId, { status: 'rodando' });

  try {
    await garantirTokenValido(integracao);

    let resultado;
    if (integracao.marketplace === 'mercado_livre') {
      resultado = await sincronizarExtratoMercadoLivre(integracao, { inicio, fim }, estado);
    } else if (integracao.marketplace === 'shopee') {
      resultado = await sincronizarExtratoShopee(integracao, { inicio, fim }, estado);
    } else if (integracao.marketplace === 'tiktok_shop') {
      resultado = await sincronizarExtratoTikTok(integracao, { inicio, fim }, estado);
    } else {
      throw new Error(`Extrato ainda não implementado para "${integracao.marketplace}".`);
    }

    const vinculados = await vincularPedidos(integracaoId);
    await gravarEstado(integracaoId, { status: 'idle', ultima_sincronizacao: new Date() });
    return {
      ...resultado,
      vinculados,
      janela: resultado.janela || { inicio, fim },
      faseJanela: desde || ate ? 'manual' : planejada.fase,
      janelaEncurtada,
      marketplace: integracao.marketplace,
    };
  } catch (err) {
    await gravarEstado(integracaoId, { status: 'erro', ultimo_erro: err.message });
    throw err;
  }
}

async function sincronizarExtratoTodasAtivas({ forcar = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL`
  );
  const resultados = [];
  for (const { id } of rows) {
    try {
      resultados.push({ integracaoId: id, ...(await sincronizarExtratoIntegracao(id, { forcar })) });
    } catch (err) {
      // Já gravado em fin_extrato_sync.ultimo_erro — segue pras outras
      // conexões em vez de derrubar o ciclo inteiro.
      console.error(`[financeiro-extrato] falha na conexão ${id}:`, err.message);
      resultados.push({ integracaoId: id, erro: err.message });
    }
  }
  return resultados;
}

// Mesma ideia do sincronizarSeNecessario do marketplaceSync: o Render
// derruba o processo quando não tem tráfego, então abrir a tela do
// Financeiro é também um gatilho oportunista de atualização.
let ultimaChamadaOportunista = 0;
function sincronizarExtratoSeNecessario() {
  const agora = Date.now();
  if (agora - ultimaChamadaOportunista < COOLDOWN_MS) return;
  ultimaChamadaOportunista = agora;
  sincronizarExtratoTodasAtivas().catch((err) => {
    console.error('[financeiro-extrato] falha na sincronização oportunista:', err.message);
  });
}

module.exports = {
  sincronizarExtratoIntegracao,
  sincronizarExtratoTodasAtivas,
  sincronizarExtratoSeNecessario,
  vincularPedidos,
  planejarJanela,
  cursoresApos,
  gravarLancamentos,
  gravarRepasse,
  lerEstado,
  diaBrasilia,
  LABEL,
  TIPOS_VALIDOS,
  JANELA_RELEITURA_DIAS,
  JANELA_MAXIMA_DIAS,
  HISTORICO_ALVO_DIAS,
};
