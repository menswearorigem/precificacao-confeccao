// Módulo Financeiro — conciliação de marketplace.
//
// Responde a pergunta que o financeiro faz e nenhuma outra tela responde:
// "quanto entrou (e saiu) na conta, por data e por plataforma, no período".
//
// A fonte é `fin_extrato_lancamentos` — o extrato lido da própria
// plataforma (ver lib/financeiroExtrato.js), não a soma dos pedidos. As
// duas leituras são comparadas na rota /conciliacao, e a diferença entre
// elas é informação, não erro: é onde aparecem Ads, multa, ajuste e estorno,
// que não pertencem a venda nenhuma.
//
// Nenhuma rota aqui escreve em `pedidos_venda`, `produtos` ou em qualquer
// tabela do motor de cálculo. Tudo é leitura, fora a sincronização do
// extrato, que só escreve nas tabelas `fin_*`.

const { condMulti } = require('../lib/filtrosMulti');
const express = require('express');
const pool = require('../db/pool');
const {
  sincronizarExtratoIntegracao,
  sincronizarExtratoTodasAtivas,
  sincronizarExtratoSeNecessario,
  vincularPedidos,
  TIPOS_VALIDOS,
  GRUPOS_TIPO,
  LABEL,
} = require('../lib/financeiroExtrato');
const { fechamentoMensal } = require('../lib/financeiroFechamento');

const router = express.Router();

// Plataformas cujo saque cai na conta do Mercado Pago da casa, e não direto
// no banco (informado pelo dono em 20/10/2026 e conferido no relatório de
// liberações: cada saque da Shopee Origem aparece, no mesmo valor, como Pix
// recebido no Mercado Pago Origem). Decisão de negócio — se um dia a Shopee
// passar a sacar direto para o banco, é só tirar daqui.
const SAQUE_VAI_PARA_O_MERCADO_PAGO = ['shopee'];

// Monta o WHERE compartilhado por todas as consultas de extrato. Filtro
// desconhecido é ignorado em silêncio de propósito — nunca vira "sem
// filtro", que devolveria mais dado do que a pessoa pediu.
// `ignorarStatus` existe por um motivo concreto: os RESUMOS precisam mostrar
// liberado e pendente lado a lado sempre — se o filtro de situação também
// valesse pra eles, o indicador "ainda pendente" mostraria R$ 0,00 justamente
// no modo padrão da tela (que lista só os liberados). O filtro de situação
// vale para a LISTA detalhada; os totais e resumos trazem os dois, separados.
function filtrosExtrato(query, aliasTabela = 'l', { ignorarStatus = false } = {}) {
  const t = aliasTabela;
  const conditions = [];
  const values = [];
  let i = 1;

  if (query.data_inicio) { conditions.push(`${t}.data_liberacao >= $${i}`); values.push(query.data_inicio); i += 1; }
  if (query.data_fim) { conditions.push(`${t}.data_liberacao <= $${i}`); values.push(query.data_fim); i += 1; }
  // Loja e plataforma aceitam VÁRIOS valores (10/09/2026): "7" continua
  // valendo, e "7,9" filtra as duas lojas de uma vez — é o mesmo formato
  // do UpSeller, que a equipe já usa. Ver lib/filtrosMulti.js.
  const condMkt = condMulti(`${t}.marketplace`, query.marketplace, values, 'text');
  if (condMkt) { conditions.push(condMkt); i = values.length + 1; }
  const condLoja = condMulti(`${t}.origem_integracao_id`, query.origem_integracao_id, values, 'int');
  if (condLoja) { conditions.push(condLoja); i = values.length + 1; }

  // `tipo` aceita lista separada por vírgula ("ads,taxa,ajuste") — é o
  // filtro de "o que aparece na tela" que o financeiro pediu.
  if (query.tipo) {
    const tipos = String(query.tipo).split(',').map((s) => s.trim()).filter((s) => TIPOS_VALIDOS.has(s));
    if (tipos.length > 0) { conditions.push(`${t}.tipo = ANY($${i})`); values.push(tipos); i += 1; }
  }
  if (!ignorarStatus && (query.status === 'liberado' || query.status === 'pendente')) {
    conditions.push(`${t}.status = $${i}`); values.push(query.status); i += 1;
  }
  if (query.com_pedido === 'sim') conditions.push(`${t}.pedido_id IS NOT NULL`);
  if (query.com_pedido === 'nao') conditions.push(`${t}.pedido_id IS NULL`);

  // 20/10/2026 — filtros pedidos pelo financeiro.
  // `grupo`: marketplace | foraMarketplace | saque (ver GRUPOS_TIPO).
  if (query.grupo) {
    const tipos = String(query.grupo).split(',').flatMap((g) => GRUPOS_TIPO[g.trim()] || []);
    if (tipos.length > 0) { conditions.push(`${t}.tipo = ANY($${i})`); values.push(tipos); i += 1; }
  }
  // `repasse`: todos os lançamentos de um repasse/saque específico.
  if (query.repasse) {
    conditions.push(`${t}.repasse_id_externo = $${i}`); values.push(String(query.repasse).trim()); i += 1;
  }
  // `busca`: número do pedido, id do pagamento, id do lançamento, id do
  // repasse ou parte da descrição da plataforma.
  if (query.busca && String(query.busca).trim()) {
    const termo = `%${String(query.busca).trim()}%`;
    conditions.push(`(${t}.lancamento_id_externo ILIKE $${i} OR ${t}.pedido_id_externo ILIKE $${i}
      OR ${t}.repasse_id_externo ILIKE $${i} OR ${t}.descricao_externa ILIKE $${i}
      OR EXISTS (SELECT 1 FROM pedidos_venda pb WHERE pb.id = ${t}.pedido_id AND pb.numero::text ILIKE $${i}))`);
    values.push(termo); i += 1;
  }
  // `valor_min`/`valor_max`: em módulo (R$ 50 acha +50 e −50).
  if (query.valor_min !== undefined && query.valor_min !== '' && Number.isFinite(Number(query.valor_min))) {
    conditions.push(`ABS(${t}.valor) >= $${i}`); values.push(Number(query.valor_min)); i += 1;
  }
  if (query.valor_max !== undefined && query.valor_max !== '' && Number.isFinite(Number(query.valor_max))) {
    conditions.push(`ABS(${t}.valor) <= $${i}`); values.push(Number(query.valor_max)); i += 1;
  }
  if (query.sentido === 'entrada') conditions.push(`${t}.valor > 0`);
  if (query.sentido === 'saida') conditions.push(`${t}.valor < 0`);

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values, proximoIndice: i };
}

// ---------------------------------------------------------------------------
// GET /api/financeiro/extrato
// ---------------------------------------------------------------------------
// A tela principal. Devolve, para o mesmo conjunto filtrado:
//   · resumoPorData      — quanto foi liberado em cada dia, por plataforma
//   · resumoPorPlataforma
//   · resumoPorTipo      — para onde o dinheiro foi (Ads, devolução, taxa…)
//   · lancamentos        — a lista detalhada
//   · totais             — liberado e pendente SEPARADOS, nunca somados
router.get('/extrato', async (req, res, next) => {
  try {
    // Gatilho oportunista: o serviço do Render dorme sem tráfego, então
    // abrir a tela também dispara a atualização (com cooldown próprio).
    sincronizarExtratoSeNecessario();

    const { where, values } = filtrosExtrato(req.query);
    // Resumos e totais: mesmos filtros, MENOS a situação (ver comentário em
    // filtrosExtrato).
    const resumo = filtrosExtrato(req.query, 'l', { ignorarStatus: true });

    const [porData, porPlataforma, porTipo, totais, lancamentos, avisos] = await Promise.all([
      pool.query(
        // `tipo` entra no agrupamento por causa do SAQUE. Transferir o saldo
        // da plataforma pra conta da empresa não é dinheiro que o marketplace
        // deixou de pagar — é o mesmo dinheiro mudando de lugar. Somado junto,
        // ele zera o total do dia (entra a venda, sai o saque) e o número que
        // o financeiro precisa desaparece. Com o tipo aqui, a tela separa as
        // duas leituras sem precisar de outra consulta.
        `SELECT l.data_liberacao, l.marketplace, l.status, l.tipo,
                SUM(l.valor) AS total, COUNT(*) AS quantidade
           FROM fin_extrato_lancamentos l ${resumo.where}
          GROUP BY l.data_liberacao, l.marketplace, l.status, l.tipo
          ORDER BY l.data_liberacao DESC, l.marketplace`,
        resumo.values
      ),
      pool.query(
        `SELECT l.marketplace, l.status, SUM(l.valor) AS total, COUNT(*) AS quantidade
           FROM fin_extrato_lancamentos l ${resumo.where}
          GROUP BY l.marketplace, l.status ORDER BY l.marketplace`,
        resumo.values
      ),
      pool.query(
        `SELECT l.tipo, l.marketplace, l.status, SUM(l.valor) AS total, COUNT(*) AS quantidade
           FROM fin_extrato_lancamentos l ${resumo.where}
          GROUP BY l.tipo, l.marketplace, l.status ORDER BY l.tipo`,
        resumo.values
      ),
      pool.query(
        // Totais por GRUPO (20/10/2026). Cada tipo pertence a um grupo só
        // (GRUPOS_TIPO), então a soma dos grupos é o extrato inteiro.
        //
        // O saque é somado linha a linha, com sinal, como qualquer outra linha.
        // A versão anterior "colapsava" o saque por repasse_id_externo e
        // ficava com o MAIOR valor de cada grupo; como a Shopee manda
        // root_withdrawal_id = 0 em todos os saques, todos os saques da loja
        // viravam um grupo só e só o maior era contado. Na Shopee o
        // WITHDRAWAL_COMPLETED vem com valor zero (conferido no saldo: a
        // carteira fecha centavo a centavo com a soma simples), então a soma
        // simples não conta saque duas vezes.
        `SELECT l.status, l.marketplace,
                CASE WHEN l.tipo = ANY($${resumo.values.length + 1}) THEN 'saque'
                     WHEN l.tipo = ANY($${resumo.values.length + 2}) THEN 'foraMarketplace'
                     ELSE 'marketplace' END AS grupo,
                SUM(l.valor) FILTER (WHERE l.valor > 0) AS entradas,
                SUM(l.valor) FILTER (WHERE l.valor < 0) AS saidas,
                SUM(l.valor) AS total, COUNT(*) AS quantidade,
                COUNT(*) FILTER (WHERE l.valor < 0) AS quantidade_saidas
           FROM fin_extrato_lancamentos l ${resumo.where}
          GROUP BY 1, 2, 3`,
        [...resumo.values, GRUPOS_TIPO.saque, GRUPOS_TIPO.foraMarketplace]
      ),
      pool.query(
        `SELECT l.id, l.marketplace, l.lancamento_id_externo, l.tipo, l.descricao_externa,
                l.data_liberacao, l.data_evento, l.valor, l.moeda, l.status,
                l.pedido_id, l.pedido_id_externo, l.repasse_id_externo, l.detalhe,
                p.numero AS pedido_numero,
                im.nome AS loja_nome
           FROM fin_extrato_lancamentos l
           LEFT JOIN pedidos_venda p ON p.id = l.pedido_id
           LEFT JOIN integracoes_marketplace im ON im.id = l.origem_integracao_id
           ${where}
          ORDER BY l.data_liberacao DESC, l.id DESC
          LIMIT 5000`,
        values
      ),
      // Ressalvas da última leitura de cada conexão (linha do extrato que a
      // plataforma devolveu e não deu pra interpretar). Aparecem na tela:
      // dinheiro que ficou de fora precisa ser visível, não silencioso.
      pool.query(
        `SELECT s.origem_integracao_id, s.ultimo_aviso, s.ultimo_erro, s.ultima_sincronizacao,
                s.status, im.marketplace, im.nome AS loja_nome
           FROM fin_extrato_sync s
           JOIN integracoes_marketplace im ON im.id = s.origem_integracao_id
          WHERE s.ultimo_aviso IS NOT NULL OR s.ultimo_erro IS NOT NULL`
      ),
    ]);

    // Cada número responde a UMA pergunta (20/10/2026):
    //   liberado            — o que o MARKETPLACE creditou menos o que debitou
    //                         (venda − devolução − taxa − Ads ± reserva). Sem
    //                         saque e sem dinheiro que não é da plataforma.
    //   outrasEntradas/Saidas — dinheiro que passou pela conta do Mercado Pago
    //                         mas não é do Mercado Livre: saque da Shopee
    //                         recebido via Pix, maquininha, link, Pix enviado.
    //                         Antes ele era somado como "venda do Mercado
    //                         Livre" — e o saque da Shopee era contado duas vezes.
    //   transferidoBanco    — saques concluídos para a conta da empresa.
    //   pendente            — o que a plataforma já calculou e não soltou.
    const somar = (filtro, campo) => totais.rows
      .filter(filtro)
      .reduce((s, r) => s + Number(r[campo] || 0), 0);
    const arred = (n) => Math.round(n * 100) / 100;

    const mkLiberado = (r) => r.status === 'liberado' && r.grupo === 'marketplace';
    const foraLiberado = (r) => r.status === 'liberado' && r.grupo === 'foraMarketplace';
    const totalLiberado = arred(somar(mkLiberado, 'total'));
    const totalPendente = arred(somar((r) => r.status === 'pendente' && r.grupo !== 'saque', 'total'));
    // O saque da Shopee NÃO vai para o banco: a casa saca a Shopee para a
    // conta do Mercado Pago da mesma empresa (Shopee Origem → Mercado Pago
    // Origem, Shopee Hoggar → Mercado Pago Hoggar), e de lá o dinheiro sai
    // para o banco junto com o do Mercado Livre. Somar os dois como
    // "transferido para o banco" contaria o mesmo real duas vezes. Ver
    // SAQUE_VAI_PARA_O_MERCADO_PAGO.
    const vaiProBanco = (r) => !SAQUE_VAI_PARA_O_MERCADO_PAGO.includes(r.marketplace);
    const transferidoBanco = arred(Math.abs(somar((r) => r.status === 'liberado' && r.grupo === 'saque' && vaiProBanco(r), 'total')));
    const enviadoMercadoPago = arred(Math.abs(somar((r) => r.status === 'liberado' && r.grupo === 'saque' && !vaiProBanco(r), 'total')));
    const transferenciaEmAndamento = arred(Math.abs(somar((r) => r.status === 'pendente' && r.grupo === 'saque', 'total')));

    res.json({
      resumoPorData: porData.rows,
      resumoPorPlataforma: porPlataforma.rows,
      resumoPorTipo: porTipo.rows,
      lancamentos: lancamentos.rows,
      // Truncar a lista sem dizer é mentir sobre o total — a tela avisa.
      listaTruncada: lancamentos.rows.length === 5000,
      totais: {
        liberado: totalLiberado,
        pendente: totalPendente,
        entradas: arred(somar(mkLiberado, 'entradas')),
        saidas: arred(somar(mkLiberado, 'saidas')),
        outrasEntradas: arred(somar(foraLiberado, 'entradas')),
        outrasSaidas: arred(somar(foraLiberado, 'saidas')),
        transferidoBanco,
        enviadoMercadoPago,
        transferenciaEmAndamento,
        quantidadeSaques: somar((r) => r.grupo === 'saque', 'quantidade_saidas'),
        quantidadeLiberada: somar(mkLiberado, 'quantidade'),
        quantidadePendente: somar((r) => r.status === 'pendente', 'quantidade'),
      },
      grupos: GRUPOS_TIPO,
      avisos: avisos.rows,
      rotulos: LABEL,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/financeiro/repasses
// ---------------------------------------------------------------------------
// Nível "linha do extrato bancário": cada repasse é uma transferência que a
// plataforma mandou (ou vai mandar) pra conta da empresa.
router.get('/repasses', async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    let i = 1;
    if (req.query.data_inicio) { conditions.push(`r.data_liberacao >= $${i}`); values.push(req.query.data_inicio); i += 1; }
    if (req.query.data_fim) { conditions.push(`r.data_liberacao <= $${i}`); values.push(req.query.data_fim); i += 1; }
    const condMktR = condMulti('r.marketplace', req.query.marketplace, values, 'text');
    if (condMktR) { conditions.push(condMktR); i = values.length + 1; }
    const condLojaR = condMulti('r.origem_integracao_id', req.query.origem_integracao_id, values, 'int');
    if (condLojaR) { conditions.push(condLojaR); i = values.length + 1; }
    if (['pago', 'processando', 'previsto'].includes(req.query.status)) {
      conditions.push(`r.status = $${i}`); values.push(req.query.status); i += 1;
    }
    if (req.query.busca && String(req.query.busca).trim()) {
      conditions.push(`r.repasse_id_externo ILIKE $${i}`); values.push(`%${String(req.query.busca).trim()}%`); i += 1;
    }
    if (req.query.valor_min !== undefined && req.query.valor_min !== '' && Number.isFinite(Number(req.query.valor_min))) {
      conditions.push(`ABS(r.valor_liquido) >= $${i}`); values.push(Number(req.query.valor_min)); i += 1;
    }
    if (req.query.valor_max !== undefined && req.query.valor_max !== '' && Number.isFinite(Number(req.query.valor_max))) {
      conditions.push(`ABS(r.valor_liquido) <= $${i}`); values.push(Number(req.query.valor_max)); i += 1;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT r.*, im.nome AS loja_nome,
              (SELECT COUNT(*) FROM fin_extrato_lancamentos l
                WHERE l.origem_integracao_id = r.origem_integracao_id
                  AND l.repasse_id_externo = r.repasse_id_externo) AS lancamentos_vinculados
         FROM fin_repasses r
         LEFT JOIN integracoes_marketplace im ON im.id = r.origem_integracao_id
         ${where}
        ORDER BY r.data_liberacao DESC NULLS LAST, r.id DESC
        LIMIT 2000`,
      values
    );
    res.json({ repasses: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/financeiro/conciliacao
// ---------------------------------------------------------------------------
// Compara, por data × plataforma, DUAS leituras independentes:
//
//   A) extrato       — o que a plataforma diz que movimentou na conta
//   B) pedidos       — a soma do valor recebido dos pedidos liberados naquele dia
//
// A diferença NÃO é apresentada como erro. Na maior parte dos dias ela é
// exatamente o que o financeiro quer ver: Ads, multa, ajuste e estorno, que
// existem no extrato e não pertencem a venda nenhuma. Por isso a resposta
// separa "diferença explicada" (soma dos lançamentos que não são repasse de
// venda) de "diferença não explicada" (o que sobra depois disso) — e é essa
// última que merece investigação.
router.get('/conciliacao', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, marketplace, origem_integracao_id } = req.query;

    const cond = [];
    const vals = [];
    let i = 1;
    if (data_inicio) { cond.push(`data_liberacao >= $${i}`); vals.push(data_inicio); i += 1; }
    if (data_fim) { cond.push(`data_liberacao <= $${i}`); vals.push(data_fim); i += 1; }
    const condMktE = condMulti('marketplace', marketplace, vals, 'text');
    if (condMktE) { cond.push(condMktE); i = vals.length + 1; }
    const condLojaE = condMulti('origem_integracao_id', origem_integracao_id, vals, 'int');
    if (condLojaE) { cond.push(condLojaE); i = vals.length + 1; }
    const whereExtrato = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows: extrato } = await pool.query(
      // O saque fica FORA dos três totais: ele não é dinheiro que o
      // marketplace pagou nem deixou de pagar, é o mesmo dinheiro saindo da
      // plataforma pra conta da empresa. Comparado contra a soma dos pedidos,
      // ele apareceria como uma diferença gigante que não significa nada.
      // Vai numa coluna própria, pra continuar visível.
      `SELECT data_liberacao AS data, marketplace,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo <> ALL($${vals.length + 1})) AS total_liberado,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo = 'repasse_venda') AS repasse_venda,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo <> 'repasse_venda' AND tipo <> ALL($${vals.length + 1})) AS outros_lancamentos,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo = 'saque') AS saque,
              COUNT(*) AS quantidade
         FROM fin_extrato_lancamentos
         ${whereExtrato}
        GROUP BY data_liberacao, marketplace`,
      // Saque e dinheiro que não é da plataforma ficam fora da comparação com
      // os pedidos (20/10/2026): o saque da Shopee que cai no Mercado Pago
      // aparecia aqui como "diferença sem explicação" do Mercado Livre.
      [...vals, [...GRUPOS_TIPO.saque, ...GRUPOS_TIPO.foraMarketplace]]
    );

    // Lado B: os pedidos. Só entram os que já estão marcados como liberados
    // — pedido com repasse apenas "confirmado" ainda não é movimentação
    // bancária e somá-lo aqui inventaria dinheiro que não caiu.
    const condP = ["pv.valor_recebido_status = 'liberado'", 'pv.valor_recebido_liberacao_em IS NOT NULL'];
    const valsP = [];
    let j = 1;
    if (data_inicio) { condP.push(`(pv.valor_recebido_liberacao_em AT TIME ZONE 'America/Sao_Paulo')::date >= $${j}`); valsP.push(data_inicio); j += 1; }
    if (data_fim) { condP.push(`(pv.valor_recebido_liberacao_em AT TIME ZONE 'America/Sao_Paulo')::date <= $${j}`); valsP.push(data_fim); j += 1; }
    const condMktP = condMulti('pv.origem_marketplace', marketplace, valsP, 'text');
    if (condMktP) { condP.push(condMktP); j = valsP.length + 1; }
    const condLojaP = condMulti('pv.origem_integracao_id', origem_integracao_id, valsP, 'int');
    if (condLojaP) { condP.push(condLojaP); j = valsP.length + 1; }

    // ⚠️ UM PAGAMENTO, UMA VEZ. O carrinho do Mercado Livre (o "pacote") vira
    // N pedidos irmãos que compartilham o MESMO pagamento, e o sincronizador
    // grava em cada um o líquido do PACOTE INTEIRO — de propósito, porque o
    // que a plataforma informa é por pagamento, não por suborder.
    //
    // Somar linha a linha contava o mesmo dinheiro uma vez por anúncio:
    // medido em 14/09/2026, um carrinho com 3 anúncios e pagamento único de
    // R$ 300,00 aparecia aqui como R$ 900,00, e a tela acusava uma divergência
    // de −R$ 600,00 contra o extrato que não existia. Justo na aba que serve
    // para provar que o extrato bate.
    //
    // É o mesmo critério que a Lucratividade já usa (pedidos.routes.js, o
    // agrupamento por pacote): o líquido entra uma vez por pagamento DISTINTO.
    // Pedido sem pagamento identificado é o seu próprio pagamento, e por isso
    // o COALESCE com a chave do pedido — nunca agrupar todos os nulos juntos.
    const { rows: pedidos } = await pool.query(
      `SELECT u.data, u.marketplace,
              SUM(u.valor_recebido_marketplace) AS total_pedidos,
              COUNT(*) AS quantidade_pedidos,
              SUM(u.irmaos) AS quantidade_suborders
         FROM (
           SELECT DISTINCT ON (COALESCE(pv.pagamento_id_marketplace, 'pedido:' || pv.id))
                  (pv.valor_recebido_liberacao_em AT TIME ZONE 'America/Sao_Paulo')::date AS data,
                  pv.origem_marketplace AS marketplace,
                  pv.valor_recebido_marketplace,
                  COUNT(*) OVER (PARTITION BY COALESCE(pv.pagamento_id_marketplace, 'pedido:' || pv.id)) AS irmaos
             FROM pedidos_venda pv
            WHERE ${condP.join(' AND ')}
              AND pv.situacao <> 'cancelado'
            ORDER BY COALESCE(pv.pagamento_id_marketplace, 'pedido:' || pv.id), pv.id
         ) u
        GROUP BY u.data, u.marketplace`,
      valsP
    );

    const chave = (d, m) => `${d instanceof Date ? d.toISOString().slice(0, 10) : d}|${m}`;
    const mapa = new Map();

    for (const e of extrato) {
      const data = e.data instanceof Date ? e.data.toISOString().slice(0, 10) : e.data;
      mapa.set(chave(data, e.marketplace), {
        data,
        marketplace: e.marketplace,
        extratoTotal: Number(e.total_liberado || 0),
        extratoRepasseVenda: Number(e.repasse_venda || 0),
        extratoOutros: Number(e.outros_lancamentos || 0),
        extratoSaque: Number(e.saque || 0),
        lancamentos: Number(e.quantidade || 0),
        pedidosTotal: null,
        pedidosQuantidade: 0,
      });
    }
    for (const p of pedidos) {
      const data = p.data instanceof Date ? p.data.toISOString().slice(0, 10) : p.data;
      const k = chave(data, p.marketplace);
      const atual = mapa.get(k) || {
        data,
        marketplace: p.marketplace,
        extratoTotal: null,
        extratoRepasseVenda: null,
        extratoOutros: null,
        extratoSaque: 0,
        lancamentos: 0,
      };
      atual.pedidosTotal = Number(p.total_pedidos || 0);
      atual.pedidosQuantidade = Number(p.quantidade_pedidos || 0);
      mapa.set(k, atual);
    }

    const linhas = [...mapa.values()].map((l) => {
      // Só há diferença a calcular quando os DOIS lados existem. Quando um
      // lado é null (o extrato daquele dia ainda não foi lido, ou não há
      // pedido nenhum), a diferença fica null — não vira zero, que passaria
      // a impressão de "está batendo" (REGRA 2).
      const temOsDois = l.extratoTotal !== null && l.pedidosTotal !== null;
      const diferenca = temOsDois ? l.extratoTotal - l.pedidosTotal : null;
      const naoExplicada = temOsDois ? diferenca - (l.extratoOutros || 0) : null;
      return {
        ...l,
        diferenca,
        // Arredondamento SÓ na comparação de tolerância — o valor devolvido
        // continua com todas as casas.
        diferencaNaoExplicada: naoExplicada,
        confere: naoExplicada === null ? null : Math.abs(naoExplicada) < 0.01,
      };
    }).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : a.marketplace.localeCompare(b.marketplace)));

    res.json({
      linhas,
      diasSemExtrato: linhas.filter((l) => l.extratoTotal === null).length,
      diasSemPedidos: linhas.filter((l) => l.pedidosTotal === null).length,
      diasDivergentes: linhas.filter((l) => l.confere === false).length,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/financeiro/fechamento — o mês fecha ou não fecha (20/10/2026)
// ---------------------------------------------------------------------------
// Por loja e por mês: saldo inicial, o que entrou e saiu (marketplace, fora
// do marketplace, saque), saldo final e a DIFERENÇA. Diferença zero quer
// dizer que nenhuma linha está faltando nem sobrando. É esta rota que a tela
// usa para dizer se o número do mês é confiável. Ver lib/financeiroFechamento.js.
router.get('/fechamento', async (req, res, next) => {
  try {
    const hoje = new Date();
    const fim = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data_fim || '') ? req.query.data_fim
      : new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().slice(0, 10);
    const inicio = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data_inicio || '') ? req.query.data_inicio
      : new Date(hoje.getFullYear(), hoje.getMonth() - 5, 1).toISOString().slice(0, 10);
    const ids = String(req.query.origem_integracao_id || '')
      .split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0);
    const lojas = await fechamentoMensal({ inicio, fim, integracaoIds: ids });
    res.json({ inicio, fim, lojas, grupos: GRUPOS_TIPO, rotulos: LABEL });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/financeiro/status — como está a leitura do extrato de cada conexão
// ---------------------------------------------------------------------------
router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT im.id, im.marketplace, im.nome, im.ativo,
              (im.access_token IS NOT NULL) AS autorizada,
              s.ultima_sincronizacao, s.lido_ate, s.status, s.ultimo_erro, s.ultimo_aviso,
              s.relatorio_pendente, s.relatorio_pedido_em,
              (SELECT COUNT(*) FROM fin_extrato_lancamentos l WHERE l.origem_integracao_id = im.id) AS lancamentos,
              (SELECT MAX(l.data_liberacao) FROM fin_extrato_lancamentos l WHERE l.origem_integracao_id = im.id) AS ultimo_lancamento
         FROM integracoes_marketplace im
         LEFT JOIN fin_extrato_sync s ON s.origem_integracao_id = im.id
        ORDER BY im.marketplace, im.nome`
    );
    res.json({ conexoes: rows, rotulos: LABEL });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/financeiro/sincronizar — puxar o extrato agora
// ---------------------------------------------------------------------------
// `integracaoId` opcional: sem ele, roda todas as conexões ativas.
// `desde`/`ate` opcionais permitem reler um período fechado (fechamento de
// mês, auditoria) sem esperar a janela automática.
router.post('/sincronizar', async (req, res, next) => {
  try {
    const { integracaoId, desde, ate } = req.body || {};
    if (integracaoId) {
      const resultado = await sincronizarExtratoIntegracao(Number(integracaoId), { forcar: true, desde, ate });
      return res.json({ resultados: [{ integracaoId: Number(integracaoId), ...resultado }] });
    }
    const resultados = await sincronizarExtratoTodasAtivas({ forcar: true });
    res.json({ resultados });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/financeiro/revincular — fechar vínculos lançamento -> pedido
// ---------------------------------------------------------------------------
// Útil depois de importar pedidos antigos: o extrato pode ter chegado antes
// do pedido existir aqui.
router.post('/revincular', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id FROM integracoes_marketplace');
    let vinculados = 0;
    for (const { id } of rows) vinculados += await vincularPedidos(id);
    res.json({ vinculados });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
