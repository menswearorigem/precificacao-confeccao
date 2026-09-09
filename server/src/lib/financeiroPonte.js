// A PONTE FINANCEIRA — a porta única por onde todo módulo fala com o dinheiro.
//
// Antes deste arquivo, um módulo que gerava custo tinha três opções: chamar
// `criarTitulo` na mão (só a O.S. fazia), não fazer nada (todos os outros), ou
// esperar que alguém lembrasse. O resultado é a frase que originou este
// trabalho: "preciso pagar um costureiro e essa necessidade não vai para o
// financeiro".
//
// A regra passa a ser uma só:
//
//   NENHUM módulo escreve em fin_titulos diretamente. Todo módulo que move
//   dinheiro chama `registrar()`, e todo módulo que CONCLUI um documento
//   chama `exigirCobertura()` antes de fechar.
//
// O que a ponte faz com a necessidade:
//
//   · se dá para transformar em título sozinha (tem empresa, valor, categoria
//     e vencimento), ela transforma — como PREVISTO quando o fato ainda não
//     se confirmou, como firme quando já se confirmou. O financeiro não
//     precisa digitar nada;
//   · se falta alguma dessas quatro coisas, ela vira FILA na Caixa de Entrada
//     do Financeiro, e trava a conclusão do documento de origem.
//
// É a diferença entre um sistema que avisa e um sistema que cobra.
//
// REGRA 1: nada aqui lê ou escreve preço de venda, margem, markup ou imposto
// de venda. O valor vem pronto do módulo que chamou.

const { criarTitulo } = require('./financeiroTitulos');

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Normaliza data para 'AAAA-MM-DD'.
//
// ⚠️ O `pg` devolve coluna DATE como objeto Date na MEIA-NOITE LOCAL, e é daí
// que vem a armadilha: `String(date)` produz "Sat Aug 15 2026 …" — cortar os
// 10 primeiros caracteres disso dá "Sat Aug 15", que o Postgres recusa. Foi
// exatamente esse o defeito que o teste da varredura pegou.
//
// E `toISOString()` também não serve: em qualquer fuso a oeste de Greenwich
// (o nosso), a meia-noite local é o dia ANTERIOR em UTC, e toda data
// retrocederia um dia em silêncio. É o mesmo defeito do DTPOSTED do OFX
// documentado na 0055. Por isso a data se monta pelas partes locais.
function dataIso(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function somarDias(data, dias) {
  const base = dataIso(data);
  if (!base || dias == null) return null;
  const d = new Date(`${base}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(dias));
  return dataIso(d);
}

// ---------------------------------------------------------------------------
// O catálogo
// ---------------------------------------------------------------------------

async function carregarOrigem(client, codigo) {
  const { rows } = await client.query('SELECT * FROM fin_origens WHERE codigo = $1', [codigo]);
  if (rows.length === 0) {
    // Origem que não está no catálogo é defeito de programação, não de dado:
    // significa que alguém acrescentou um ponto de custo e esqueceu de
    // registrá-lo. Falhar alto aqui é melhor que gravar em silêncio.
    throw erro(`Origem financeira desconhecida: "${codigo}". Cadastre-a em fin_origens.`, 500);
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// registrar() — a porta
// ---------------------------------------------------------------------------
// Idempotente por (origem, documento, chave): chamar duas vezes pelo mesmo
// fato atualiza a necessidade, nunca duplica. É o que permite chamá-la de
// dentro de qualquer rota sem medo de repetição.
//
// Devolve { pendencia, titulos, gerouTitulo }.
async function registrar(client, dados) {
  const {
    origem_codigo, origem_id, chave = 'principal',
    empresa_id, descricao, documento,
    fornecedor_id, cliente_id, contraparte_nome,
    valor_estimado, data_competencia, data_vencimento,
    plano_id, centro_custo_id, detalhe, observacao,
    retencoes = [], usuarioId, autoTitulo = true,
  } = dados;

  if (!origem_codigo || !origem_id) throw erro('registrar(): origem e documento são obrigatórios.', 500);

  const origem = await carregarOrigem(client, origem_codigo);
  if (!origem.ativo) return { pendencia: null, titulos: [], gerouTitulo: false, ignorada: true };

  const natureza = dados.natureza || origem.natureza;
  const competencia = dataIso(data_competencia) || dataIso(new Date());
  const vencimento = dataIso(data_vencimento)
    || (origem.prazo_padrao_dias != null ? somarDias(competencia, origem.prazo_padrao_dias) : null);
  const plano = plano_id || origem.plano_id || null;
  const centro = centro_custo_id || origem.centro_custo_id || null;
  const valor = num(valor_estimado);

  // Já existe?
  const { rows: existentes } = await client.query(
    `SELECT * FROM fin_pendencias
      WHERE origem_codigo = $1 AND origem_id = $2 AND chave = $3 FOR UPDATE`,
    [origem_codigo, origem_id, chave]
  );
  const anterior = existentes[0] || null;

  // Necessidade já resolvida não é reaberta por uma nova chamada. Se o valor
  // mudou depois de virar título, quem resolve é `promover()` — que sabe
  // distinguir "previsão que se confirmou" de "alguém mexeu no documento".
  if (anterior && ['atendida', 'dispensada'].includes(anterior.situacao)) {
    return { pendencia: anterior, titulos: [], gerouTitulo: false, jaResolvida: true };
  }

  let pendencia;
  if (anterior) {
    const { rows } = await client.query(
      `UPDATE fin_pendencias SET
         empresa_id = $2, natureza = $3, descricao = $4, documento = $5,
         fornecedor_id = $6, cliente_id = $7, contraparte_nome = $8,
         valor_estimado = $9, data_competencia = $10, data_vencimento = $11,
         plano_id = $12, centro_custo_id = $13, detalhe = $14,
         situacao = 'aberta', bloqueia = $15, atualizado_em = now()
       WHERE id = $1 RETURNING *`,
      [anterior.id, empresa_id || null, natureza, descricao, documento || null,
       fornecedor_id || null, cliente_id || null, contraparte_nome || null,
       valor, competencia, vencimento, plano, centro,
       detalhe ? JSON.stringify(detalhe) : null, origem.bloqueia_conclusao]
    );
    pendencia = rows[0];
  } else {
    const { rows } = await client.query(
      `INSERT INTO fin_pendencias
         (origem_codigo, origem_id, chave, empresa_id, natureza, descricao, documento,
          fornecedor_id, cliente_id, contraparte_nome, valor_estimado,
          data_competencia, data_vencimento, plano_id, centro_custo_id,
          detalhe, bloqueia, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [origem_codigo, origem_id, chave, empresa_id || null, natureza, descricao, documento || null,
       fornecedor_id || null, cliente_id || null, contraparte_nome || null, valor,
       competencia, vencimento, plano, centro,
       detalhe ? JSON.stringify(detalhe) : null, origem.bloqueia_conclusao, usuarioId || null]
    );
    pendencia = rows[0];
  }

  // Dá para resolver sozinha?
  const faltas = faltandoParaTitulo(pendencia);
  if (!autoTitulo || faltas.length > 0) {
    return { pendencia, titulos: [], gerouTitulo: false, faltando: faltas };
  }

  const titulo = await criarTitulo(client, {
    empresa_id: pendencia.empresa_id,
    natureza: pendencia.natureza,
    fornecedor_id: pendencia.fornecedor_id,
    cliente_id: pendencia.cliente_id,
    contraparte_nome: pendencia.contraparte_nome,
    descricao: pendencia.descricao,
    documento: pendencia.documento,
    plano_id: pendencia.plano_id,
    centro_custo_id: pendencia.centro_custo_id,
    data_competencia: pendencia.data_competencia,
    data_vencimento: pendencia.data_vencimento,
    valor_bruto: Number(pendencia.valor_estimado),
    // A decisão de 09/09/2026: compromisso assumido na ABERTURA nasce
    // PREVISTO — entra no fluxo de caixa ("vou precisar de R$ X no dia 20") e
    // fica fora do DRE, porque o fato ainda não aconteceu. Confirmado o fato,
    // `promover()` o torna firme pelo valor real.
    situacao: origem.momento === 'abertura' ? 'previsto' : 'aberto',
    origem_tipo: origem_codigo,
    origem_id,
    observacao,
    retencoes,
    usuarioId,
  });

  await client.query(
    'INSERT INTO fin_pendencia_titulos (pendencia_id, titulo_id) VALUES ($1,$2)',
    [pendencia.id, titulo.id]
  );
  const { rows: atualizada } = await client.query(
    `UPDATE fin_pendencias SET situacao = 'atendida', atendida_em = now(), atendida_por = $2,
            atualizado_em = now() WHERE id = $1 RETURNING *`,
    [pendencia.id, usuarioId || null]
  );

  return { pendencia: atualizada[0], titulos: [titulo], gerouTitulo: true };
}

// As quatro coisas sem as quais um título não pode existir. A lista é
// devolvida em português porque ela vira, literalmente, o texto que a tela
// mostra para quem precisa resolver.
function faltandoParaTitulo(p) {
  const faltas = [];
  if (!p.empresa_id) faltas.push('a empresa (CNPJ)');
  if (!(Number(p.valor_estimado) > 0)) faltas.push('o valor');
  if (!p.data_vencimento) faltas.push('o vencimento');
  // Sem categoria o título existe, mas some do DRE. Ver a linha "sem
  // classificação" na 0061: preferimos exigir a categoria a produzir o
  // relatório perigoso — o que fecha bonito e está errado.
  if (!p.plano_id) faltas.push('a categoria do DRE');
  return faltas;
}

// ---------------------------------------------------------------------------
// promover() — a previsão que virou fato
// ---------------------------------------------------------------------------
// Chamada na CONCLUSÃO do documento: a facção devolveu, a nota chegou, o
// pedido foi recebido. Atualiza o título previsto para o valor real e o torna
// firme (entra no DRE a partir daqui).
//
// Título previsto pode ter o valor corrigido; título firme, não. Firme já é
// dívida reconhecida — corrigi-lo em silêncio é como reescrever o passado.
// Nesse caso a diferença vira uma pendência nova, visível.
async function promover(client, {
  origem_codigo, origem_id, chave = 'principal',
  valor_real, data_competencia, data_vencimento, descricao, detalhe, usuarioId,
}) {
  const { rows: pend } = await client.query(
    `SELECT * FROM fin_pendencias
      WHERE origem_codigo = $1 AND origem_id = $2 AND chave = $3 FOR UPDATE`,
    [origem_codigo, origem_id, chave]
  );
  if (pend.length === 0) return { promovido: false, motivo: 'sem_pendencia' };
  const p = pend[0];

  const valor = num(valor_real);

  const { rows: titulos } = await client.query(
    `SELECT t.* FROM fin_pendencia_titulos pt
       JOIN fin_titulos t ON t.id = pt.titulo_id
      WHERE pt.pendencia_id = $1 AND t.situacao = 'previsto' FOR UPDATE OF t`,
    [p.id]
  );

  if (titulos.length === 1 && valor != null && valor > 0) {
    const t = titulos[0];
    const { rows } = await client.query(
      `UPDATE fin_titulos SET
         valor_bruto = $2,
         situacao = 'aberto',
         data_competencia = COALESCE($3, data_competencia),
         data_vencimento = COALESCE($4, data_vencimento),
         descricao = COALESCE($5, descricao),
         atualizado_em = now()
       WHERE id = $1 RETURNING *`,
      [t.id, valor, dataIso(data_competencia), dataIso(data_vencimento), descricao || null]
    );
    await client.query(
      `UPDATE fin_pendencias SET valor_estimado = $2, detalhe = COALESCE($3, detalhe),
              atualizado_em = now() WHERE id = $1`,
      [p.id, valor, detalhe ? JSON.stringify(detalhe) : null]
    );
    return { promovido: true, titulo: rows[0], anterior: Number(t.valor_bruto) };
  }

  // Sem título previsto: ou a pendência ainda está na fila (aí só atualiza o
  // valor), ou o título já é firme (aí a diferença precisa aparecer).
  if (p.situacao === 'aberta') {
    const r = await registrar(client, {
      origem_codigo, origem_id, chave,
      empresa_id: p.empresa_id, natureza: p.natureza,
      descricao: descricao || p.descricao, documento: p.documento,
      fornecedor_id: p.fornecedor_id, cliente_id: p.cliente_id,
      contraparte_nome: p.contraparte_nome,
      valor_estimado: valor != null ? valor : p.valor_estimado,
      data_competencia: data_competencia || p.data_competencia,
      data_vencimento: data_vencimento || p.data_vencimento,
      plano_id: p.plano_id, centro_custo_id: p.centro_custo_id,
      detalhe, usuarioId,
    });
    return { promovido: r.gerouTitulo, pendencia: r.pendencia, faltando: r.faltando };
  }

  return { promovido: false, motivo: 'titulo_ja_firme' };
}

// ---------------------------------------------------------------------------
// exigirCobertura() — a trava
// ---------------------------------------------------------------------------
// A decisão de 09/09/2026: trava a CONCLUSÃO, não o registro. Chamada no
// endpoint que fecha o documento, antes de qualquer escrita.
//
// A mensagem diz o valor, a contraparte e exatamente o que falta — mensagem de
// bloqueio que não diz como sair dele é o que faz as pessoas contornarem o
// sistema por fora.
async function exigirCobertura(client, { origem_codigo, origem_id, acao = 'concluir este documento' }) {
  const { rows } = await client.query(
    `SELECT * FROM fin_pendencias
      WHERE origem_codigo = $1 AND origem_id = $2 AND situacao = 'aberta' AND bloqueia`,
    [origem_codigo, origem_id]
  );
  if (rows.length === 0) return true;

  const partes = rows.map((p) => {
    const faltas = faltandoParaTitulo(p);
    const valor = p.valor_estimado != null
      ? `R$ ${Number(p.valor_estimado).toFixed(2).replace('.', ',')}`
      : 'valor ainda não informado';
    return `${p.descricao} (${valor}) — falta ${faltas.join(', ')}`;
  });

  throw erro(
    `Não dá para ${acao} enquanto o financeiro não tiver o compromisso: `
    + `${partes.join('; ')}. Resolva em Financeiro › Caixa de Entrada, `
    + `ou dispense a pendência escrevendo o motivo.`,
    409
  );
}

// ---------------------------------------------------------------------------
// cancelar() — o documento morreu, a necessidade morre junto
// ---------------------------------------------------------------------------
// Não apaga: marca. Pendência apagada é pendência que ninguém consegue
// auditar depois — e cancelamento é justamente o que mais se audita.
//
// Título PREVISTO ligado a ela também é cancelado: previsão de um documento
// cancelado é dinheiro fantasma no fluxo de caixa. Título FIRME não se
// cancela sozinho — a dívida pode existir mesmo com o documento cancelado, e
// essa decisão é do financeiro.
async function cancelar(client, { origem_codigo, origem_id, motivo, usuarioId }) {
  const { rows } = await client.query(
    `UPDATE fin_pendencias SET situacao = 'cancelada', atualizado_em = now()
      WHERE origem_codigo = $1 AND origem_id = $2 AND situacao IN ('aberta', 'atendida')
      RETURNING id`,
    [origem_codigo, origem_id]
  );
  if (rows.length === 0) return { canceladas: 0, titulosCancelados: 0 };

  const { rows: tit } = await client.query(
    `UPDATE fin_titulos SET situacao = 'cancelado', cancelado_em = now(),
            cancelado_motivo = $3, atualizado_em = now()
      WHERE origem_tipo = $1 AND origem_id = $2 AND situacao = 'previsto'
      RETURNING id`,
    [origem_codigo, origem_id, `Documento de origem cancelado. ${motivo || ''}`.trim()]
  );

  const { rows: firmes } = await client.query(
    `SELECT id, valor_bruto FROM fin_titulos
      WHERE origem_tipo = $1 AND origem_id = $2 AND situacao IN ('aberto', 'parcial', 'liquidado')`,
    [origem_codigo, origem_id]
  );

  return {
    canceladas: rows.length,
    titulosCancelados: tit.length,
    // O chamador mostra isso na tela: cancelar a O.S. não faz sumir o título
    // que já era firme, e quem cancelou precisa saber disso na hora.
    titulosFirmesRemanescentes: firmes,
  };
}

// ---------------------------------------------------------------------------
// situacaoDocumento() — o selo que todo módulo mostra
// ---------------------------------------------------------------------------
// É o que faz a ligação ser visível dos DOIS lados: do financeiro dá para
// chegar no documento, e do documento dá para ver o dinheiro.
async function situacaoDocumento(client, origem_codigo, origem_id) {
  const { rows: pend } = await client.query(
    'SELECT * FROM vw_fin_pendencias WHERE origem_codigo = $1 AND origem_id = $2 ORDER BY chave',
    [origem_codigo, origem_id]
  );
  const { rows: titulos } = await client.query(
    `SELECT t.id, t.numero, t.natureza, t.situacao, t.valor_bruto, t.data_vencimento,
            s.valor_baixado, s.saldo_aberto
       FROM fin_titulos t
       JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
      WHERE t.origem_tipo = $1 AND t.origem_id = $2
      ORDER BY t.data_vencimento`,
    [origem_codigo, origem_id]
  );

  const abertas = pend.filter((p) => p.situacao === 'aberta');
  let estado = 'sem_compromisso';
  if (abertas.some((p) => p.bloqueia)) estado = 'bloqueado';
  else if (abertas.length > 0) estado = 'pendente';
  else if (titulos.some((t) => t.situacao === 'previsto')) estado = 'previsto';
  else if (titulos.length > 0) estado = 'no_financeiro';

  return {
    estado,
    pendencias: pend,
    titulos,
    faltando: abertas.flatMap((p) => faltandoParaTitulo(p)),
  };
}

module.exports = {
  registrar, promover, exigirCobertura, cancelar, situacaoDocumento,
  carregarOrigem, faltandoParaTitulo, somarDias,
};
