// Busca livre do extrato de marketplace (21/10/2026).
//
// O pedido do dono: "pesquisar por absolutamente qualquer coisa — nome do
// cliente, número do pedido, número do repasse, cidade, estado — e até um
// conjunto: `maria mato grosso do sul og1620`".
//
// COMO FUNCIONA
// O texto é quebrado em PEDAÇOS, e cada pedaço tem que aparecer em ALGUM
// lugar ligado ao lançamento (E entre os pedaços, OU entre os lugares):
//   · o próprio lançamento: id na plataforma, id do pagamento, id do repasse,
//     id do pedido na plataforma, descrição, tipo, loja;
//   · o pedido vinculado: número no Hub (#123), id na plataforma, pacote,
//     pagamento, código de rastreio, canal;
//   · o cliente: nome, fantasia, CPF/CNPJ, telefone, e-mail, cidade, UF;
//   · os itens: referência (OG1620), SKU, título do anúncio, cor, tamanho;
//   · o envio lido da plataforma (destinatário, cidade, estado, bairro, CEP).
//
// Pedaços especiais:
//   · nome de estado por extenso ("mato grosso do sul", "são paulo") vira um
//     pedaço só, e casa também com a sigla (MS, SP) — e a sigla sozinha casa
//     com o nome por extenso;
//   · valor em reais ("35,32", "R$ 35,32") casa com o valor do lançamento;
//   · palavra de tipo ("devolução", "saque", "ads", "pix") casa com o tipo.
//
// Acento e maiúscula não importam ("São Paulo" = "sao paulo"). Nada aqui
// escreve em tabela nenhuma.

const ESTADOS = {
  AC: 'acre', AL: 'alagoas', AP: 'amapa', AM: 'amazonas', BA: 'bahia', CE: 'ceara',
  DF: 'distrito federal', ES: 'espirito santo', GO: 'goias', MA: 'maranhao',
  MT: 'mato grosso', MS: 'mato grosso do sul', MG: 'minas gerais', PA: 'para',
  PB: 'paraiba', PR: 'parana', PE: 'pernambuco', PI: 'piaui', RJ: 'rio de janeiro',
  RN: 'rio grande do norte', RS: 'rio grande do sul', RO: 'rondonia', RR: 'roraima',
  SC: 'santa catarina', SP: 'sao paulo', SE: 'sergipe', TO: 'tocantins',
};

const PALAVRAS_TIPO = {
  venda: ['repasse_venda'], vendas: ['repasse_venda'],
  devolucao: ['devolucao'], devolucoes: ['devolucao'], reclamacao: ['devolucao'], estorno: ['devolucao'], reembolso: ['devolucao'],
  taxa: ['taxa'], taxas: ['taxa'], frete: ['taxa'], multa: ['taxa'],
  ads: ['ads'], publicidade: ['ads'], anuncio: ['ads'],
  antecipacao: ['antecipacao'],
  retido: ['reserva'], reserva: ['reserva'], bloqueado: ['reserva'], bloqueio: ['reserva'],
  ajuste: ['ajuste'],
  saque: ['saque'], saques: ['saque'],
  pix: ['transferencia_entrada', 'transferencia_saida'], transferencia: ['transferencia_entrada', 'transferencia_saida'],
  maquininha: ['venda_direta'], link: ['venda_direta'],
  emprestimo: ['emprestimo'], rendimento: ['rendimento'],
};

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Mesma normalização, do lado do Postgres (sem depender da extensão unaccent,
// que o banco do Render pode não ter).
const COM_ACENTO = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuucn';
const norm = (expr) => `translate(lower(${expr}), '${COM_ACENTO}', '${SEM_ACENTO}')`;

// Quebra a busca em pedaços. Devolve [{ texto, uf?, tipos?, valor? }].
function partirBusca(busca) {
  let resto = ` ${normalizar(busca).replace(/[;|]+/g, ' ')} `;
  const pedacos = [];

  // Estados por extenso primeiro, do nome mais comprido para o mais curto
  // ("mato grosso do sul" antes de "mato grosso").
  const porTamanho = Object.entries(ESTADOS).sort((a, b) => b[1].length - a[1].length);
  for (const [uf, nome] of porTamanho) {
    const re = new RegExp(`\\s${nome.replace(/ /g, '\\s+')}\\s`, 'g');
    if (re.test(resto)) {
      pedacos.push({ texto: nome, uf });
      resto = resto.replace(re, ' ');
    }
  }

  for (const bruto of resto.split(/\s+/)) {
    const p = bruto.replace(/^r\$/, '').trim();
    if (!p) continue;
    if (p === 'r$') continue;
    // Valor em reais: 35,32 · 1.234,56 · 35.32
    if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(p) || /^\d+,\d{2}$/.test(p) || /^\d+\.\d{2}$/.test(p)) {
      const valor = Number(p.includes(',') ? p.replace(/\./g, '').replace(',', '.') : p);
      pedacos.push({ texto: p, valor });
      continue;
    }
    const sigla = p.toUpperCase();
    if (p.length === 2 && ESTADOS[sigla]) {
      pedacos.push({ texto: p, uf: sigla, siglaSolta: true });
      continue;
    }
    if (p.replace(/^#/, '').length < 2) continue;
    pedacos.push({ texto: p.replace(/^#/, ''), tipos: PALAVRAS_TIPO[p] || null });
  }
  return pedacos;
}

// Resolve a busca numa lista de ids de lançamento — UMA consulta por tela,
// em conjunto (sem subconsulta por linha). Medido no banco de teste com 12
// mil linhas: de ~6 s (texto montado linha a linha, em cada uma das seis
// consultas da tela) para menos de 1 s.
//
// `janela`: { inicio, fim, integracoes: [ids] } — limita o trabalho ao
// recorte da tela.
async function idsDaBusca(pool, busca, janela = {}) {
  const pedacos = partirBusca(busca);
  if (pedacos.length === 0) return null;
  const values = [];
  const p = (v) => { values.push(v); return `$${values.length}`; };

  const filtros = [];
  if (janela.inicio) filtros.push(`b.data_liberacao >= ${p(janela.inicio)}`);
  if (janela.fim) filtros.push(`b.data_liberacao <= ${p(janela.fim)}`);
  if (janela.integracoes?.length) filtros.push(`b.origem_integracao_id = ANY(${p(janela.integracoes)}::int[])`);
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  const porPedaco = pedacos.map((x) => {
    // Sigla solta ("ms") não pode virar "qualquer texto com ms dentro" — isso
    // casaria com metade do extrato. Só casa como estado.
    const ou = x.siglaSolta ? [] : [`x.t LIKE ${p(`%${x.texto}%`)}`];
    if (x.uf) {
      ou.push(`x.t LIKE ${p(`%uf:${x.uf.toLowerCase()}%`)}`);
      if (x.siglaSolta) ou.push(`x.t LIKE ${p(`%${ESTADOS[x.uf]}%`)}`);
      else ou.push(`x.t LIKE ${p(`%br-${x.uf.toLowerCase()}%`)}`);
    }
    if (x.tipos) ou.push(`x.tipo = ANY(${p(x.tipos)})`);
    if (x.valor !== undefined) ou.push(`ABS(x.valor) = ${p(x.valor)}`);
    return `(${ou.join(' OR ')})`;
  });

  const sql = `
    WITH lanc AS (
      SELECT b.id, b.tipo, b.valor, b.pedido_id, b.origem_integracao_id,
             concat_ws(' ', b.lancamento_id_externo, b.pedido_id_externo, b.repasse_id_externo,
                       b.descricao_externa, b.tipo, b.marketplace, b.detalhe->>'transactionType',
                       b.detalhe->>'meioPagamento', b.detalhe->>'unidade') AS t
        FROM fin_extrato_lancamentos b ${where}
    ),
    itens AS (
      SELECT i.pedido_id,
             string_agg(concat_ws(' ', i.referencia, i.sku_externo, i.titulo_externo, i.descricao, i.cor, i.tamanho), ' ') AS t
        FROM pedido_itens i
       WHERE i.pedido_id IN (SELECT pedido_id FROM lanc WHERE pedido_id IS NOT NULL)
       GROUP BY i.pedido_id
    ),
    ped AS (
      SELECT pv.id, concat_ws(' ',
               pv.numero::text, '#' || pv.numero::text, pv.origem_pedido_id, pv.pack_id_marketplace,
               pv.pagamento_id_marketplace, array_to_string(pv.codigos_rastreio, ' '), pv.canal_venda,
               pv.wik_cliente_nome, pv.observacao,
               c.nome, c.nome_fantasia, c.cpf_cnpj, c.telefone, c.email, c.bairro, c.cidade, 'uf:' || c.uf, c.cep,
               it.t, pe.codigo_rastreio, pe.bruto::text) AS t
        FROM pedidos_venda pv
        LEFT JOIN clientes c ON c.id = pv.cliente_id
        LEFT JOIN itens it ON it.pedido_id = pv.id
        LEFT JOIN pedido_envio pe ON pe.pedido_id = pv.id
       WHERE pv.id IN (SELECT pedido_id FROM lanc WHERE pedido_id IS NOT NULL)
    )
    SELECT x.id FROM (
      SELECT l.id, l.tipo, l.valor,
             ${norm(`concat_ws(' ', l.t, im.nome, ped.t)`)} AS t
        FROM lanc l
        LEFT JOIN ped ON ped.id = l.pedido_id
        LEFT JOIN integracoes_marketplace im ON im.id = l.origem_integracao_id
    ) x
    WHERE ${porPedaco.join(' AND ')}
    LIMIT 100000`;
  const { rows } = await pool.query(sql, values);
  return rows.map((r) => r.id);
}

module.exports = { idsDaBusca, partirBusca, normalizar, ESTADOS };
