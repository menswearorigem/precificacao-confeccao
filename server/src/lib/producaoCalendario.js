// A ordem de produção no calendário (09/09/2026).
//
// Pedido do dono: "depois de preencher as informações como início, essa OP
// deve ser colocada automaticamente no calendário, com a data inicial e a data
// de chegada".
//
// ---------------------------------------------------------------------------
// Por que sincronizar, e não só criar
// ---------------------------------------------------------------------------
// Criar o evento na abertura e nunca mais tocar nele é pior que não criar: a
// data prevista muda (a facção renegocia o prazo), a ordem é cancelada, a
// ordem conclui — e o calendário continua prometendo uma entrega que não vai
// acontecer. Um calendário que mente é abandonado em duas semanas.
//
// Por isso existe UMA função, chamada em todo lugar que mexe na ordem, que
// deixa o evento igual à ordem: cria se não existe, atualiza se existe.
//
// ---------------------------------------------------------------------------
// O que este arquivo NÃO faz
// ---------------------------------------------------------------------------
// ⚠️ Não apaga evento que a pessoa editou à mão além do que a ordem controla.
// Título, datas, status e grade são da ordem; descrição, responsáveis,
// prioridade, permissões, anexos e comentários são de quem usa o calendário e
// nunca são sobrescritos depois da criação.
//
// ⚠️ Não cria evento sem data de entrega. `calendario_eventos.data_prevista_fim`
// é NOT NULL, e inventar uma data (hoje + 30, por exemplo) colocaria no
// calendário um prazo que ninguém prometeu. Sem data prevista, a função devolve
// o motivo e a tela escreve isso — REGRA 2.

const CATEGORIA = 'Produção';

// `ordens_producao.situacao` → `calendario_eventos.status`.
//
// Rascunho e planejada viram "não iniciado" porque, do ponto de vista de quem
// olha o calendário, as duas são a mesma coisa: a peça ainda não começou. A
// diferença entre elas (material reservado ou não) é assunto da produção.
const STATUS_POR_SITUACAO = {
  rascunho: 'nao_iniciado',
  planejada: 'nao_iniciado',
  em_producao: 'em_andamento',
  concluida: 'concluido',
  cancelada: 'cancelado',
};

function tituloDaOrdem(ordem) {
  if (ordem.tipo === 'kit') {
    return `OP ${ordem.numero} · Kit ${ordem.nome || ordem.referencia || ''}`.trim();
  }
  return `OP ${ordem.numero} · ${ordem.referencia}${ordem.produto_descricao ? ` — ${ordem.produto_descricao}` : ''}`;
}

/**
 * Deixa o evento de calendário igual à ordem de produção.
 *
 * @param client conexão JÁ dentro da transação de quem chamou. Nunca abre
 *   transação própria: o evento tem de nascer e morrer junto com a ordem.
 * @returns {{ evento_id: number|null, acao: 'criado'|'atualizado'|'nenhuma', motivo: string|null }}
 */
async function sincronizarEvento(client, { ordemId, usuarioId = null }) {
  const { rows } = await client.query(
    `SELECT o.*, p.referencia, p.descricao AS produto_descricao, f.nome AS fornecedor_nome
       FROM ordens_producao o
       JOIN produtos p ON p.id = o.produto_id
       LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
      WHERE o.id = $1`, [ordemId]
  );
  if (rows.length === 0) return { evento_id: null, acao: 'nenhuma', motivo: 'Ordem não encontrada.' };
  const ordem = rows[0];

  // Filha de uma O.P. de kit não vira evento próprio: seriam três linhas no
  // mesmo dia dizendo a mesma coisa. Quem entra no calendário é a mãe, que é o
  // documento que a casa acompanha ("o kit fica pronto dia 20").
  if (ordem.op_pai_id) {
    return { evento_id: null, acao: 'nenhuma', motivo: 'Esta ordem faz parte de uma O.P. de kit; quem entra no calendário é a ordem do kit.' };
  }

  const { rows: existentes } = await client.query(
    'SELECT id, status FROM calendario_eventos WHERE ordem_producao_id = $1', [ordemId]
  );
  const evento = existentes[0] || null;

  if (!ordem.data_prevista) {
    return {
      evento_id: evento?.id || null,
      acao: 'nenhuma',
      motivo: 'A ordem não tem data de chegada prevista, e o calendário não aceita evento sem prazo. '
        + 'Preencha a previsão de entrega e a ordem entra no calendário sozinha.',
    };
  }

  const status = STATUS_POR_SITUACAO[ordem.situacao] || 'nao_iniciado';
  const titulo = tituloDaOrdem(ordem);
  // A grade da ordem vira a grade do evento. É o mesmo formato que o
  // importador de ordem de produção do calendário já produzia — daí `wiki_op`
  // em `origem`, que desde a 0038 significa "esta linha veio de uma O.P., não
  // foi digitada aqui".
  const { rows: grade } = await client.query(
    `SELECT g.cor, g.tamanho, g.quantidade_planejada, po.referencia
       FROM ordem_producao_grade g
       JOIN ordens_producao o2 ON o2.id = g.ordem_id
       JOIN produtos po ON po.id = o2.produto_id
      WHERE g.ordem_id = $1 OR o2.op_pai_id = $1
      ORDER BY po.referencia, g.cor, g.tamanho`,
    [ordemId]
  );

  const camposExtra = {
    ordem_producao_id: ordem.id,
    numero_op: String(ordem.numero),
    referencia_texto: ordem.referencia,
    quantidade: Number(ordem.quantidade_planejada) || 0,
    fornecedor_id: ordem.fornecedor_id || null,
    faccao: ordem.fornecedor_nome || null,
    tipo_op: ordem.tipo || 'produto',
  };

  let eventoId = evento?.id || null;
  let acao;

  if (!evento) {
    const { rows: criado } = await client.query(
      `INSERT INTO calendario_eventos
         (titulo, descricao, categoria, data_inicio, data_prevista_fim,
          data_conclusao_real, status, prioridade, produto_id, campos_extra,
          criado_por, usa_grade, ordem_producao_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'media',$8,$9,$10,TRUE,$11) RETURNING id`,
      [
        titulo,
        'Evento criado pela ordem de produção. As datas, a situação e a grade seguem a O.P.; '
        + 'responsáveis, anexos e comentários são deste evento.',
        CATEGORIA,
        ordem.data_inicio || ordem.data_abertura,
        ordem.data_prevista,
        ordem.situacao === 'concluida' ? (ordem.data_conclusao || null) : null,
        status,
        ordem.produto_id,
        JSON.stringify(camposExtra),
        usuarioId,
        ordem.id,
      ]
    );
    eventoId = criado[0].id;
    acao = 'criado';
    await client.query(
      `INSERT INTO calendario_historico (evento_id, usuario_id, acao, alteracoes)
       VALUES ($1,$2,'criado',$3)`,
      [eventoId, usuarioId, JSON.stringify({ origem: 'ordem_producao', ordem_id: ordem.id })]
    );
  } else {
    await client.query(
      `UPDATE calendario_eventos
          SET titulo = $2, data_inicio = $3, data_prevista_fim = $4,
              data_conclusao_real = $5, status = $6, produto_id = $7,
              campos_extra = $8, usa_grade = TRUE, atualizado_em = now()
        WHERE id = $1`,
      [
        eventoId, titulo,
        ordem.data_inicio || ordem.data_abertura,
        ordem.data_prevista,
        ordem.situacao === 'concluida' ? (ordem.data_conclusao || null) : null,
        status, ordem.produto_id, JSON.stringify(camposExtra),
      ]
    );
    acao = 'atualizado';
    // Só registra no histórico quando o status mudou. Toda gravação da ordem
    // passa por aqui; registrar tudo encheria o histórico do evento de linhas
    // idênticas e esconderia a única que importa.
    if (evento.status !== status) {
      await client.query(
        `INSERT INTO calendario_historico (evento_id, usuario_id, acao, alteracoes)
         VALUES ($1,$2,'editado',$3)`,
        [eventoId, usuarioId, JSON.stringify({ status: { de: evento.status, para: status }, origem: 'ordem_producao' })]
      );
    }
  }

  await client.query('DELETE FROM calendario_eventos_grade WHERE evento_id = $1', [eventoId]);
  for (const l of grade) {
    const cor = String(l.cor || '').trim();
    const tamanho = String(l.tamanho || '').trim();
    if (!cor && !tamanho) continue;
    await client.query(
      `INSERT INTO calendario_eventos_grade (evento_id, cor, tamanho, quantidade, origem)
       VALUES ($1,$2,$3,$4,'wiki_op')`,
      [eventoId, cor, tamanho, Math.round(Number(l.quantidade_planejada) || 0)]
    );
  }

  return { evento_id: eventoId, acao, motivo: null };
}

module.exports = { sincronizarEvento, STATUS_POR_SITUACAO, CATEGORIA };
