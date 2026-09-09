// Romaneio de expedição: o papel que o motorista assina, e o relógio da coleta.
//
// ---------------------------------------------------------------------------
// As regras que este arquivo garante
// ---------------------------------------------------------------------------
// 1. UM PEDIDO NÃO ESTÁ EM DOIS ROMANEIOS VIVOS. Quem garante é o índice único
//    parcial `uq_romaneio_pedido_vivo`; aqui a violação vira mensagem que diz
//    em QUAL romaneio o pedido já está, porque "chave duplicada" não ajuda
//    ninguém na expedição.
//
// 2. ROMANEIO FECHADO NÃO RECEBE PEDIDO. Fechar é imprimir; acrescentar depois
//    faria o papel na mão do motorista discordar do sistema.
//
// 3. O CÓDIGO DE RASTREIO É CONGELADO NA ENTRADA. O pedido pode ser
//    reetiquetado depois, e o papel assinado tem que continuar dizendo o que
//    dizia.
//
// REGRA 1: romaneio não tem valor. Nada aqui lê preço, margem ou imposto.

const { DocumentoPdf } = require('./pdfMinimo');
const { codificarCode128 } = require('./zpl');

function erro(mensagem, status = 400) {
  return Object.assign(new Error(mensagem), { status });
}

async function lerRomaneio(db, id) {
  const { rows } = await db.query(
    `SELECT r.*, v.pedidos, v.volumes, v.peso_kg, v.sem_rastreio,
            uf.nome AS fechado_por_nome, uc.nome AS coletado_por_nome
       FROM romaneios r
       LEFT JOIN vw_romaneio_resumo v ON v.id = r.id
       LEFT JOIN usuarios uf ON uf.id = r.fechado_por
       LEFT JOIN usuarios uc ON uc.id = r.coletado_por
      WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function itensDo(db, romaneioId, { incluirLiberados = false } = {}) {
  const { rows } = await db.query(
    `SELECT rp.*, p.numero AS pedido_numero, p.origem_marketplace, p.origem_pedido_id,
            p.canal_venda, p.quantidade_pecas, p.faturado_em,
            c.nome AS cliente_nome
       FROM romaneio_pedidos rp
       JOIN pedidos_venda p ON p.id = rp.pedido_id
       LEFT JOIN clientes c ON c.id = p.cliente_id
      WHERE rp.romaneio_id = $1 ${incluirLiberados ? '' : 'AND rp.liberado_em IS NULL'}
      ORDER BY rp.id`,
    [romaneioId]
  );
  return rows;
}

// Acrescenta pedidos ao romaneio. Devolve o que entrou e o que não entrou —
// e por quê, um por um.
//
// ⚠️ Nunca falha o lote inteiro por causa de um pedido: quem está embalando
// tem 40 caixas na mesa, e um erro que derruba as 40 é o que faz a expedição
// parar de usar o sistema.
async function acrescentar(client, { romaneioId, pedidos, usuarioId }) {
  const r = await lerRomaneio(client, romaneioId);
  if (!r) throw erro('Romaneio não encontrado.', 404);
  if (r.situacao !== 'aberto') {
    throw erro(
      r.situacao === 'fechado'
        ? 'Este romaneio já foi fechado. Acrescentar pedido agora faria o papel impresso discordar do sistema — reabra ou crie outro.'
        : `Este romaneio está ${r.situacao}.`,
      409
    );
  }

  const entraram = [];
  const recusados = [];

  for (const item of pedidos || []) {
    const pedidoId = Number(item.pedido_id ?? item);
    if (!pedidoId) { recusados.push({ pedidoId: item, motivo: 'Pedido inválido.' }); continue; }

    const { rows: ped } = await client.query(
      'SELECT id, numero, situacao, codigos_rastreio FROM pedidos_venda WHERE id = $1', [pedidoId]
    );
    if (ped.length === 0) { recusados.push({ pedidoId, motivo: 'Pedido não encontrado.' }); continue; }
    const p = ped[0];
    if (p.situacao === 'cancelado') {
      recusados.push({ pedidoId, numero: p.numero, motivo: 'Pedido cancelado não entra em romaneio.' });
      continue;
    }

    // Congela o rastreio: o que a etiqueta diz HOJE.
    const rastreio = item.codigo_rastreio
      || (Array.isArray(p.codigos_rastreio) && p.codigos_rastreio.length > 0 ? p.codigos_rastreio[0] : null);

    // ⚠️ SAVEPOINT, e não só try/catch.
    //
    // No Postgres, um erro DENTRO de uma transação aborta a transação inteira:
    // o `catch` do JavaScript captura a exceção, mas a próxima query responde
    // "current transaction is aborted". Sem o savepoint, o primeiro pedido
    // repetido derrubaria as 39 caixas seguintes — que é exatamente o que a
    // regra 'uma linha errada não derruba o lote' promete não fazer.
    //
    // (Este defeito existiu aqui e foi pego pelo teste, não pela leitura.)
    await client.query('SAVEPOINT sp_item');
    try {
      await client.query(
        `INSERT INTO romaneio_pedidos (romaneio_id, pedido_id, codigo_rastreio, volumes, peso_kg)
         VALUES ($1,$2,$3,$4,$5)`,
        [romaneioId, pedidoId, rastreio, Number(item.volumes) > 0 ? Number(item.volumes) : 1,
         item.peso_kg === undefined || item.peso_kg === null || item.peso_kg === '' ? null : Number(item.peso_kg)]
      );
      await client.query('RELEASE SAVEPOINT sp_item');
      entraram.push({ pedidoId, numero: p.numero, codigo_rastreio: rastreio });
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_item');
      await client.query('RELEASE SAVEPOINT sp_item');
      if (e.code === '23505') {
        // "chave duplicada" não diz nada para quem está com a caixa na mão.
        const { rows: onde } = await client.query(
          `SELECT r.numero, r.situacao FROM romaneio_pedidos rp
             JOIN romaneios r ON r.id = rp.romaneio_id
            WHERE rp.pedido_id = $1 AND rp.liberado_em IS NULL`,
          [pedidoId]
        );
        recusados.push({
          pedidoId, numero: p.numero,
          motivo: onde.length
            ? `Já está no romaneio ${onde[0].numero} (${onde[0].situacao}).`
            : 'Já está em outro romaneio.',
        });
      } else { throw e; }
    }
  }

  return { entraram, recusados };
}

// Tira um pedido do romaneio. Não apaga a linha: marca a saída, e é o mesmo
// mecanismo do cancelamento do romaneio inteiro.
async function liberar(client, { romaneioId, pedidoId, motivo }) {
  if (!String(motivo || '').trim()) {
    throw erro('Escreva por que este pedido está saindo do romaneio.');
  }
  const r = await lerRomaneio(client, romaneioId);
  if (!r) throw erro('Romaneio não encontrado.', 404);
  if (r.situacao === 'coletado') {
    throw erro('Este romaneio já foi coletado: o pedido saiu daqui de verdade. Tirar do papel agora não traz a caixa de volta.', 409);
  }
  const { rows } = await client.query(
    `UPDATE romaneio_pedidos SET liberado_em = now(), liberado_motivo = $1
      WHERE romaneio_id = $2 AND pedido_id = $3 AND liberado_em IS NULL RETURNING *`,
    [String(motivo).slice(0, 200), romaneioId, pedidoId]
  );
  if (rows.length === 0) throw erro('Este pedido não está neste romaneio.', 400);
  return rows[0];
}

async function fechar(client, { romaneioId, usuarioId }) {
  const r = await lerRomaneio(client, romaneioId);
  if (!r) throw erro('Romaneio não encontrado.', 404);
  if (r.situacao !== 'aberto') throw erro(`Este romaneio já está ${r.situacao}.`, 409);
  if (Number(r.pedidos) === 0) throw erro('Romaneio vazio não se fecha.');

  const { rows } = await client.query(
    `UPDATE romaneios SET situacao = 'fechado', fechado_em = now(), fechado_por = $1
      WHERE id = $2 RETURNING *`,
    [usuarioId || null, romaneioId]
  );
  return rows[0];
}

// Reabrir existe porque a caixa que faltava aparece. O que NÃO existe é
// reabrir depois de coletado.
async function reabrir(client, { romaneioId, motivo }) {
  const r = await lerRomaneio(client, romaneioId);
  if (!r) throw erro('Romaneio não encontrado.', 404);
  if (r.situacao !== 'fechado') {
    throw erro(
      r.situacao === 'coletado'
        ? 'Este romaneio já foi coletado. O que saiu, saiu — para corrigir, faça outro romaneio.'
        : `Este romaneio está ${r.situacao}.`,
      409
    );
  }
  const { rows } = await client.query(
    `UPDATE romaneios
        SET situacao = 'aberto', fechado_em = NULL, fechado_por = NULL,
            observacao = CONCAT_WS(E'\\n', observacao, $1::text)
      WHERE id = $2 RETURNING *`,
    [`Reaberto: ${String(motivo || 'sem motivo informado').slice(0, 150)}`, romaneioId]
  );
  return rows[0];
}

// Registra a coleta. É o carimbo que para o relógio.
async function coletar(client, { romaneioId, motorista, placa, usuarioId }) {
  const r = await lerRomaneio(client, romaneioId);
  if (!r) throw erro('Romaneio não encontrado.', 404);
  if (r.situacao === 'coletado') throw erro('Este romaneio já foi coletado.', 409);
  if (r.situacao === 'cancelado') throw erro('Romaneio cancelado não é coletado.', 409);
  if (r.situacao !== 'fechado') {
    throw erro('Feche o romaneio antes de registrar a coleta — o motorista assina o papel impresso, e o papel só existe depois de fechado.', 409);
  }
  if (!String(motorista || '').trim()) {
    throw erro('Escreva o nome de quem levou. É esse nome que serve numa reclamação três semanas depois.');
  }
  const { rows } = await client.query(
    `UPDATE romaneios
        SET situacao = 'coletado', coletado_em = now(), coletado_por = $1,
            motorista = $2, placa = $3
      WHERE id = $4 RETURNING *`,
    [usuarioId || null, String(motorista).trim().slice(0, 120),
     String(placa || '').trim().slice(0, 15) || null, romaneioId]
  );
  return rows[0];
}

async function cancelar(client, { romaneioId, motivo }) {
  if (!String(motivo || '').trim()) throw erro('Escreva o motivo do cancelamento.');
  const r = await lerRomaneio(client, romaneioId);
  if (!r) throw erro('Romaneio não encontrado.', 404);
  if (r.situacao === 'coletado') {
    throw erro('Romaneio coletado não se cancela: as caixas foram embora. O histórico do que saiu não se apaga.', 409);
  }
  // Os pedidos voltam a poder entrar em outro romaneio — pelo mesmo mecanismo
  // de tirar um pedido só, e sem apagar a linha.
  await client.query(
    `UPDATE romaneio_pedidos SET liberado_em = now(), liberado_motivo = $1
      WHERE romaneio_id = $2 AND liberado_em IS NULL`,
    [`Romaneio cancelado: ${String(motivo).slice(0, 160)}`, romaneioId]
  );
  const { rows } = await client.query(
    `UPDATE romaneios SET situacao = 'cancelado', cancelado_motivo = $1 WHERE id = $2 RETURNING *`,
    [String(motivo).slice(0, 200), romaneioId]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// O papel
// ---------------------------------------------------------------------------
// A4 retrato, sem dependência nenhuma: o mesmo escritor de PDF das etiquetas.
//
// O que ele precisa ter, e por quê:
//   · o número em código de barras — para o motorista bipar em vez de digitar;
//   · uma linha por pedido, com o código de rastreio POR EXTENSO, porque é por
//     ele que se procura quando um pedido some;
//   · totais de pedidos e volumes, que é o que se confere na porta;
//   · duas assinaturas. Romaneio sem assinatura é uma lista.
function gerarPdf(romaneio, itens, { empresaNome } = {}) {
  const doc = new DocumentoPdf();
  const LARGURA = 595; // A4
  const ALTURA = 842;
  const M = 36;
  const POR_PAGINA = 28;

  const paginas = Math.max(1, Math.ceil(itens.length / POR_PAGINA));
  const totalVolumes = itens.reduce((s, i) => s + Number(i.volumes || 1), 0);

  for (let p = 0; p < paginas; p += 1) {
    const pg = doc.novaPagina(LARGURA, ALTURA);
    let y = M;

    pg.texto(M, y, empresaNome || 'Romaneio de expedição', { tamanho: 15, negrito: true });
    pg.texto(LARGURA - M - 150, y, `Romaneio ${romaneio.numero}`, { tamanho: 13, negrito: true });
    y += 20;
    pg.texto(M, y, `Transportadora: ${romaneio.transportadora || '—'}`, { tamanho: 9 });
    pg.texto(M + 260, y, `Canal: ${romaneio.canal || '—'}`, { tamanho: 9 });
    pg.texto(LARGURA - M - 150, y, `Página ${p + 1} de ${paginas}`, { tamanho: 9 });
    y += 13;
    const quando = romaneio.fechado_em ? new Date(romaneio.fechado_em) : new Date();
    pg.texto(M, y, `Emitido em ${quando.toLocaleString('pt-BR')}`, { tamanho: 9 });
    y += 16;

    // Código de barras do número do romaneio.
    const elementos = codificarCode128(`ROM${romaneio.numero}`);
    let cursor = M;
    let barra = true;
    for (const largura of elementos) {
      const w = largura * 1.1;
      if (barra) pg.retangulo(cursor, y, w, 28);
      cursor += w;
      barra = !barra;
    }
    // ⚠️ +40, e não +32: `texto` recebe a LINHA DE BASE, então o texto sobe
    // acima do y pedido. Com 32 o "ROM1042" encostava nas barras — e código de
    // barras com tinta em cima é código que o leitor recusa.
    y += 40;
    pg.texto(M, y, `ROM${romaneio.numero}`, { tamanho: 8 });
    y += 12;

    pg.moldura(M, y, LARGURA - 2 * M, 16);
    pg.texto(M + 4, y + 11, 'Pedido', { tamanho: 8, negrito: true });
    pg.texto(M + 70, y + 11, 'Canal', { tamanho: 8, negrito: true });
    pg.texto(M + 145, y + 11, 'Código de rastreio', { tamanho: 8, negrito: true });
    pg.texto(M + 330, y + 11, 'Destinatário', { tamanho: 8, negrito: true });
    pg.texto(LARGURA - M - 50, y + 11, 'Vol.', { tamanho: 8, negrito: true });
    y += 16;

    for (const item of itens.slice(p * POR_PAGINA, (p + 1) * POR_PAGINA)) {
      pg.texto(M + 4, y + 11, String(item.pedido_numero ?? item.pedido_id), { tamanho: 8 });
      pg.texto(M + 70, y + 11, (item.origem_marketplace || item.canal_venda || '—').slice(0, 12), { tamanho: 8 });
      // ⚠️ Sem rastreio NÃO vira espaço em branco: espaço em branco parece
      // coluna que não coube, e ninguém pergunta. "SEM RASTREIO" é uma
      // pergunta que a pessoa faz antes de o motorista sair.
      pg.texto(M + 145, y + 11, item.codigo_rastreio || 'SEM RASTREIO', { tamanho: 8 });
      pg.texto(M + 330, y + 11, (item.cliente_nome || item.origem_pedido_id || '—').slice(0, 22), { tamanho: 8 });
      pg.texto(LARGURA - M - 46, y + 11, String(item.volumes || 1), { tamanho: 8 });
      y += 15;
    }

    y += 10;
    if (p === paginas - 1) {
      pg.texto(M, y + 12, `Total: ${itens.length} pedido(s), ${totalVolumes} volume(s)`, { tamanho: 10, negrito: true });
      y += 46;
      pg.retangulo(M, y, 210, 0.8);
      pg.retangulo(LARGURA - M - 210, y, 210, 0.8);
      pg.texto(M, y + 12, 'Entregue por (nome e assinatura)', { tamanho: 8 });
      pg.texto(LARGURA - M - 210, y + 12, 'Recebido por (nome, RG e assinatura)', { tamanho: 8 });
    }
  }

  return doc.buffer();
}

module.exports = {
  erro, lerRomaneio, itensDo, acrescentar, liberar, fechar, reabrir, coletar, cancelar, gerarPdf,
};
