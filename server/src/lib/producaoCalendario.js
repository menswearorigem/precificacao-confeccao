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
// ---------------------------------------------------------------------------
// OPs do Wik dos produtos de MARKETPLACE (16/09/2026)
// ---------------------------------------------------------------------------
// Pedido da dona: "todas as vezes que uma OP dos produtos de marketplace for
// alimentada no sistema, atualiza no calendário com todos os dados possíveis;
// se for atualizada, atualiza também (prazos, grade, cores, estado da OP); se
// for concluída, conclui no calendário".
//
// As OPs do Wik NÃO passam pelas rotas de produção (o sincronizador grava
// direto), então chamar `sincronizarEvento` só nas rotas deixava todas elas de
// fora. `reconciliarCalendario` fecha esse buraco: roda no fim de cada ciclo do
// Wik (e depois de alimentar grade à mão) e passa em toda OP de produto de
// marketplace cujo evento não existe ou ficou para trás da OP. A `assinatura`
// guardada no evento faz a passada ser barata: OP sem mudança não grava nada.
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

const ROTULO_SITUACAO = {
  rascunho: 'Rascunho',
  planejada: 'Planejada',
  em_producao: 'Em produção',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

// Chaves de `campos_extra` que pertencem à ORDEM. Tudo o que não está aqui é
// de quem usa o calendário e sobrevive a qualquer sincronização.
const CHAVES_DA_ORDEM = [
  'ordem_producao_id', 'numero_op', 'numero_op_hub', 'wik_op', 'origem_op', 'sincroniza_wik',
  'referencia_texto', 'produto_descricao', 'marca', 'categoria_produto', 'marketplace',
  'tipo_op', 'nome_op', 'situacao_op', 'situacao_op_rotulo', 'wik_situacao',
  'etapas', 'atrasada_wik', 'quantidade', 'quantidade_produzida', 'quantidade_segunda',
  'quantidade_kits', 'fornecedor_id', 'fornecedor_nome', 'faccao',
  'cores', 'tamanhos', 'grade_por_cor', 'grade_detalhe',
  'data_abertura', 'data_inicio_op', 'data_prevista_op', 'data_conclusao_op',
  'observacoes_op', 'sincronizado_em', 'assinatura',
];

function iso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function numeroVisivel(ordem) {
  // A casa conhece a OP do Wik pelo número do Wik, não pelo serial do Hub.
  return ordem.wik_op ? String(ordem.wik_op) : String(ordem.numero);
}

function tituloDaOrdem(ordem) {
  const n = numeroVisivel(ordem);
  if (ordem.tipo === 'kit') {
    return `OP ${n} · Kit ${ordem.nome || ordem.referencia || ''}`.trim().slice(0, 200);
  }
  return `OP ${n} · ${ordem.referencia}${ordem.produto_descricao ? ` — ${ordem.produto_descricao}` : ''}`.slice(0, 200);
}

// Assinatura estável do que a ordem manda no evento. Igual = nada a gravar.
function assinar(obj) {
  const texto = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${texto.length}`;
}

function montarDados(ordem, grade) {
  const status = STATUS_POR_SITUACAO[ordem.situacao] || 'nao_iniciado';
  const dataInicio = iso(ordem.data_inicio) || iso(ordem.data_abertura);
  const dataFim = iso(ordem.data_prevista);
  // Concluída sem data de conclusão (OP do Wik que já chegou finalizada na
  // primeira leitura) usa o prazo: é a única data que a OP de fato tem, e não
  // inventa que ela terminou "hoje".
  const dataConclusao = ordem.situacao === 'concluida'
    ? (iso(ordem.data_conclusao) || iso(ordem.data_prevista))
    : null;

  const cores = [];
  const tamanhos = [];
  const porCor = new Map();
  const linhas = [];
  for (const l of grade) {
    const cor = String(l.cor || '').trim();
    const tamanho = String(l.tamanho || '').trim();
    if (!cor && !tamanho) continue;
    if (cor && !cores.includes(cor)) cores.push(cor);
    if (tamanho && !tamanhos.includes(tamanho)) tamanhos.push(tamanho);
    const chave = cor || '(sem cor)';
    const acc = porCor.get(chave) || { cor: chave, planejada: 0, produzida: 0, segunda: 0 };
    acc.planejada += num(l.quantidade_planejada);
    acc.produzida += num(l.quantidade_produzida);
    acc.segunda += num(l.quantidade_segunda);
    porCor.set(chave, acc);
    linhas.push({
      referencia: l.referencia, cor, tamanho,
      planejada: num(l.quantidade_planejada),
      produzida: num(l.quantidade_produzida),
      segunda: num(l.quantidade_segunda),
    });
  }

  const extra = {
    ordem_producao_id: ordem.id,
    numero_op: numeroVisivel(ordem),
    numero_op_hub: String(ordem.numero),
    wik_op: ordem.wik_op || null,
    origem_op: ordem.origem || 'manual',
    sincroniza_wik: Boolean(ordem.sincroniza_wik),
    referencia_texto: ordem.referencia,
    produto_descricao: ordem.produto_descricao || null,
    marca: ordem.marca || null,
    categoria_produto: ordem.produto_categoria || null,
    marketplace: Boolean(ordem.marketplace),
    tipo_op: ordem.tipo || 'produto',
    nome_op: ordem.nome || null,
    situacao_op: ordem.situacao,
    situacao_op_rotulo: ROTULO_SITUACAO[ordem.situacao] || ordem.situacao,
    wik_situacao: ordem.wik_situacao || null,
    etapas: ordem.wik_etapas || null,
    atrasada_wik: Boolean(ordem.wik_atrasada),
    quantidade: num(ordem.quantidade_planejada),
    quantidade_produzida: num(ordem.quantidade_produzida),
    quantidade_segunda: num(ordem.quantidade_segunda),
    quantidade_kits: ordem.quantidade_kits != null ? num(ordem.quantidade_kits) : null,
    fornecedor_id: ordem.fornecedor_id || null,
    fornecedor_nome: ordem.fornecedor_nome || null,
    faccao: ordem.fornecedor_nome || null,
    cores,
    tamanhos,
    grade_por_cor: [...porCor.values()],
    grade_detalhe: linhas,
    data_abertura: iso(ordem.data_abertura),
    data_inicio_op: iso(ordem.data_inicio),
    data_prevista_op: dataFim,
    data_conclusao_op: dataConclusao,
    observacoes_op: ordem.observacoes || null,
  };

  const evento = {
    titulo: tituloDaOrdem(ordem),
    data_inicio: dataInicio && dataFim && dataInicio > dataFim ? dataFim : dataInicio,
    data_prevista_fim: dataFim,
    data_conclusao_real: dataConclusao,
    status,
    produto_id: ordem.produto_id,
  };
  const assinatura = assinar({ evento, extra });
  return { evento, extra: { ...extra, assinatura }, assinatura, linhas };
}

async function carregarOrdem(client, ordemId) {
  const { rows } = await client.query(
    `SELECT o.*, p.referencia, p.descricao AS produto_descricao, p.marca,
            p.categoria AS produto_categoria, p.marketplace,
            f.nome AS fornecedor_nome
       FROM ordens_producao o
       JOIN produtos p ON p.id = o.produto_id
       LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
      WHERE o.id = $1`, [ordemId]
  );
  return rows[0] || null;
}

/**
 * Deixa o evento de calendário igual à ordem de produção.
 *
 * @param client conexão JÁ dentro da transação de quem chamou (ou o pool, para
 *   quem não tem transação — o reconciliador). Nunca abre transação própria.
 * @returns {{ evento_id: number|null, acao: 'criado'|'atualizado'|'nenhuma', motivo: string|null }}
 */
async function sincronizarEvento(client, { ordemId, usuarioId = null }) {
  const ordem = await carregarOrdem(client, ordemId);
  if (!ordem) return { evento_id: null, acao: 'nenhuma', motivo: 'Ordem não encontrada.' };

  // Filha de uma O.P. de kit não vira evento próprio: seriam três linhas no
  // mesmo dia dizendo a mesma coisa. Quem entra no calendário é a mãe, que é o
  // documento que a casa acompanha ("o kit fica pronto dia 20").
  if (ordem.op_pai_id) {
    return { evento_id: null, acao: 'nenhuma', motivo: 'Esta ordem faz parte de uma O.P. de kit; quem entra no calendário é a ordem do kit.' };
  }

  const { rows: existentes } = await client.query(
    'SELECT id, status, campos_extra FROM calendario_eventos WHERE ordem_producao_id = $1', [ordemId]
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

  // A grade da ordem vira a grade do evento. É o mesmo formato que o
  // importador de ordem de produção do calendário já produzia — daí `wiki_op`
  // em `origem`, que desde a 0038 significa "esta linha veio de uma O.P., não
  // foi digitada aqui".
  const { rows: grade } = await client.query(
    `SELECT g.cor, g.tamanho, g.quantidade_planejada, g.quantidade_produzida,
            g.quantidade_segunda, po.referencia
       FROM ordem_producao_grade g
       JOIN ordens_producao o2 ON o2.id = g.ordem_id
       JOIN produtos po ON po.id = o2.produto_id
      WHERE g.ordem_id = $1 OR o2.op_pai_id = $1
      ORDER BY po.referencia, g.cor, g.tamanho`,
    [ordemId]
  );

  const dados = montarDados(ordem, grade);
  const { evento: ev, extra } = dados;

  let eventoId = evento?.id || null;
  let acao;

  if (!evento) {
    const { rows: criado } = await client.query(
      `INSERT INTO calendario_eventos
         (titulo, descricao, categoria, data_inicio, data_prevista_fim,
          data_conclusao_real, status, prioridade, produto_id, campos_extra,
          criado_por, usa_grade, ordem_producao_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'media',$8,
               $9::jsonb || jsonb_build_object('sincronizado_em', now()),$10,TRUE,$11)
       ON CONFLICT (ordem_producao_id) WHERE ordem_producao_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        ev.titulo,
        ordem.origem === 'wik'
          ? 'Evento criado automaticamente pela OP do Wik. Prazos, situação, cores e grade seguem a OP '
            + 'a cada sincronização; responsáveis, anexos e comentários são deste evento.'
          : 'Evento criado pela ordem de produção. As datas, a situação e a grade seguem a O.P.; '
            + 'responsáveis, anexos e comentários são deste evento.',
        CATEGORIA,
        ev.data_inicio,
        ev.data_prevista_fim,
        ev.data_conclusao_real,
        ev.status,
        ev.produto_id,
        JSON.stringify(extra),
        usuarioId,
        ordem.id,
      ]
    );
    if (!criado[0]) {
      // Outro processo criou no meio do caminho — segue como atualização na
      // próxima passada; nada a fazer agora.
      return { evento_id: null, acao: 'nenhuma', motivo: 'Evento criado em paralelo.' };
    }
    eventoId = criado[0].id;
    acao = 'criado';
    await client.query(
      `INSERT INTO calendario_historico (evento_id, usuario_id, acao, alteracoes)
       VALUES ($1,$2,'criado',$3)`,
      [eventoId, usuarioId, JSON.stringify({ origem: 'ordem_producao', ordem_id: ordem.id, origem_op: ordem.origem || 'manual' })]
    );
  } else {
    const assinaturaAntes = evento.campos_extra?.assinatura || null;
    if (assinaturaAntes === dados.assinatura) {
      // Nada mudou no que a ordem manda. Só carimba que conferiu — sem mexer
      // em `atualizado_em`, que é "última edição" para quem usa o calendário.
      await client.query(
        `UPDATE calendario_eventos
            SET campos_extra = campos_extra || jsonb_build_object('sincronizado_em', now())
          WHERE id = $1`, [eventoId]
      );
      return { evento_id: eventoId, acao: 'nenhuma', motivo: null };
    }
    // `campos_extra || $8`: as chaves da ordem sobrescrevem, as da pessoa
    // (campos de template, anotações) ficam.
    await client.query(
      `UPDATE calendario_eventos
          SET titulo = $2, data_inicio = $3, data_prevista_fim = $4,
              data_conclusao_real = $5, status = $6, produto_id = $7,
              campos_extra = COALESCE(campos_extra, '{}'::jsonb) || $8::jsonb
                             || jsonb_build_object('sincronizado_em', now()),
              usa_grade = TRUE, atualizado_em = now()
        WHERE id = $1`,
      [
        eventoId, ev.titulo, ev.data_inicio, ev.data_prevista_fim,
        ev.data_conclusao_real, ev.status, ev.produto_id, JSON.stringify(extra),
      ]
    );
    acao = 'atualizado';
    // Registra no histórico o que mudou de verdade (status e prazo) — o resto
    // (grade, etapas) muda demais e esconderia a linha que importa.
    const antes = evento.campos_extra || {};
    const alteracoes = {};
    if (evento.status !== ev.status) alteracoes.status = { de: evento.status, para: ev.status };
    if (antes.data_prevista_op && antes.data_prevista_op !== ev.data_prevista_fim) {
      alteracoes.data_prevista_fim = { de: antes.data_prevista_op, para: ev.data_prevista_fim };
    }
    if (Object.keys(alteracoes).length) {
      alteracoes.origem = ordem.origem === 'wik' ? 'wik' : 'ordem_producao';
      await client.query(
        `INSERT INTO calendario_historico (evento_id, usuario_id, acao, alteracoes)
         VALUES ($1,$2,'editado',$3)`,
        [eventoId, usuarioId, JSON.stringify(alteracoes)]
      );
    }
  }

  await client.query('DELETE FROM calendario_eventos_grade WHERE evento_id = $1', [eventoId]);
  for (const l of dados.linhas) {
    await client.query(
      `INSERT INTO calendario_eventos_grade (evento_id, cor, tamanho, quantidade, origem)
       VALUES ($1,$2,$3,$4,'wiki_op')`,
      [eventoId, l.cor.slice(0, 60), l.tamanho.slice(0, 20), Math.round(l.planejada)]
    );
  }

  return { evento_id: eventoId, acao, motivo: null };
}

/**
 * Passa em todas as OPs de produto de MARKETPLACE (Wik ou manuais) e deixa o
 * calendário igual a elas. Só toca as que não têm evento ou cuja OP mudou
 * depois do evento; a assinatura evita regravar o que já está igual.
 *
 * Cada OP roda na sua própria transação: uma OP com problema não derruba as
 * outras nem o ciclo do Wik.
 */
async function reconciliarCalendario(pool, { ordemIds = null, todas = false, limite = 5000 } = {}) {
  const valores = [];
  let filtroIds = '';
  if (Array.isArray(ordemIds)) {
    if (!ordemIds.length) return { verificadas: 0, criados: 0, atualizados: 0, semPrazo: 0, erros: [] };
    valores.push(ordemIds);
    filtroIds = `AND o.id = ANY($${valores.length}::int[])`;
  }
  // Sem prazo não há evento a criar (ver o topo) — fica fora da passada
  // automática para não ser revista à toa a cada ciclo.
  const filtroMudou = todas || filtroIds ? '' : `
        AND (o.data_prevista IS NOT NULL OR e.id IS NOT NULL)
        AND (e.id IS NULL
             OR (e.campos_extra->>'assinatura') IS NULL
             OR o.atualizado_em > COALESCE((e.campos_extra->>'sincronizado_em')::timestamptz, '-infinity'::timestamptz))`;
  valores.push(limite);
  const { rows } = await pool.query(
    `SELECT o.id
       FROM ordens_producao o
       JOIN produtos p ON p.id = o.produto_id
       LEFT JOIN calendario_eventos e ON e.ordem_producao_id = o.id
      WHERE p.marketplace = TRUE
        AND o.op_pai_id IS NULL
        ${filtroIds}
        ${filtroMudou}
      ORDER BY o.atualizado_em DESC
      LIMIT $${valores.length}`,
    valores
  );

  const res = { verificadas: rows.length, criados: 0, atualizados: 0, semPrazo: 0, erros: [] };
  for (const { id } of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await sincronizarEvento(client, { ordemId: id });
      await client.query('COMMIT');
      if (r.acao === 'criado') res.criados += 1;
      else if (r.acao === 'atualizado') res.atualizados += 1;
      else if (r.motivo && r.motivo.startsWith('A ordem não tem data')) res.semPrazo += 1;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      res.erros.push(`OP ${id}: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return res;
}

module.exports = {
  sincronizarEvento, reconciliarCalendario,
  STATUS_POR_SITUACAO, CATEGORIA, CHAVES_DA_ORDEM,
  _montarDados: montarDados,
};
