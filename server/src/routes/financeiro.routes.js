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

const express = require('express');
const pool = require('../db/pool');
const {
  sincronizarExtratoIntegracao,
  sincronizarExtratoTodasAtivas,
  sincronizarExtratoSeNecessario,
  vincularPedidos,
  TIPOS_VALIDOS,
  LABEL,
} = require('../lib/financeiroExtrato');

const router = express.Router();

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
  if (query.marketplace) { conditions.push(`${t}.marketplace = $${i}`); values.push(query.marketplace); i += 1; }
  if (query.origem_integracao_id) { conditions.push(`${t}.origem_integracao_id = $${i}`); values.push(Number(query.origem_integracao_id)); i += 1; }

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
        // Entradas e saídas separadas, e o saque separado das duas: com ele
        // dentro, um mês em que entraram R$ 212 mil e foram sacados R$ 209 mil
        // aparece como "R$ 2,5 mil liberados", que responde a pergunta errada.
        `SELECT l.status, (l.tipo = 'saque') AS eh_saque,
                SUM(l.valor) FILTER (WHERE l.valor > 0) AS entradas,
                SUM(l.valor) FILTER (WHERE l.valor < 0) AS saidas,
                SUM(l.valor) AS total, COUNT(*) AS quantidade
           FROM fin_extrato_lancamentos l ${resumo.where}
          GROUP BY l.status, (l.tipo = 'saque')`,
        resumo.values
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

    // Quatro números diferentes, e cada um responde a uma pergunta:
    //   liberado          — quanto o marketplace de fato creditou (venda menos
    //                       Ads, taxa, devolução). É a resposta ao "quanto
    //                       eles me pagaram". SEM o saque.
    //   transferidoBanco  — quanto saiu da plataforma pra conta da empresa.
    //   pendente          — o que a plataforma já reconhece e ainda não soltou.
    const somar = (filtro, campo) => totais.rows
      .filter(filtro)
      .reduce((s, r) => s + Number(r[campo] || 0), 0);

    const liberadoSemSaque = (r) => r.status === 'liberado' && !r.eh_saque;
    const totalLiberado = somar(liberadoSemSaque, 'total');
    const totalPendente = somar((r) => r.status === 'pendente' && !r.eh_saque, 'total');
    const transferidoBanco = Math.abs(somar((r) => r.status === 'liberado' && r.eh_saque, 'total'));
    const transferenciaEmAndamento = Math.abs(somar((r) => r.status === 'pendente' && r.eh_saque, 'total'));

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
        entradas: somar(liberadoSemSaque, 'entradas'),
        saidas: somar(liberadoSemSaque, 'saidas'),
        transferidoBanco,
        transferenciaEmAndamento,
        quantidadeLiberada: somar(liberadoSemSaque, 'quantidade'),
        quantidadePendente: somar((r) => r.status === 'pendente', 'quantidade'),
      },
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
    if (req.query.marketplace) { conditions.push(`r.marketplace = $${i}`); values.push(req.query.marketplace); i += 1; }
    if (req.query.origem_integracao_id) { conditions.push(`r.origem_integracao_id = $${i}`); values.push(Number(req.query.origem_integracao_id)); i += 1; }
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
    if (marketplace) { cond.push(`marketplace = $${i}`); vals.push(marketplace); i += 1; }
    if (origem_integracao_id) { cond.push(`origem_integracao_id = $${i}`); vals.push(Number(origem_integracao_id)); i += 1; }
    const whereExtrato = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows: extrato } = await pool.query(
      // O saque fica FORA dos três totais: ele não é dinheiro que o
      // marketplace pagou nem deixou de pagar, é o mesmo dinheiro saindo da
      // plataforma pra conta da empresa. Comparado contra a soma dos pedidos,
      // ele apareceria como uma diferença gigante que não significa nada.
      // Vai numa coluna própria, pra continuar visível.
      `SELECT data_liberacao AS data, marketplace,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo <> 'saque') AS total_liberado,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo = 'repasse_venda') AS repasse_venda,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo NOT IN ('repasse_venda', 'saque')) AS outros_lancamentos,
              SUM(valor) FILTER (WHERE status = 'liberado' AND tipo = 'saque') AS saque,
              COUNT(*) AS quantidade
         FROM fin_extrato_lancamentos
         ${whereExtrato}
        GROUP BY data_liberacao, marketplace`,
      vals
    );

    // Lado B: os pedidos. Só entram os que já estão marcados como liberados
    // — pedido com repasse apenas "confirmado" ainda não é movimentação
    // bancária e somá-lo aqui inventaria dinheiro que não caiu.
    const condP = ["pv.valor_recebido_status = 'liberado'", 'pv.valor_recebido_liberacao_em IS NOT NULL'];
    const valsP = [];
    let j = 1;
    if (data_inicio) { condP.push(`(pv.valor_recebido_liberacao_em AT TIME ZONE 'America/Sao_Paulo')::date >= $${j}`); valsP.push(data_inicio); j += 1; }
    if (data_fim) { condP.push(`(pv.valor_recebido_liberacao_em AT TIME ZONE 'America/Sao_Paulo')::date <= $${j}`); valsP.push(data_fim); j += 1; }
    if (marketplace) { condP.push(`pv.origem_marketplace = $${j}`); valsP.push(marketplace); j += 1; }
    if (origem_integracao_id) { condP.push(`pv.origem_integracao_id = $${j}`); valsP.push(Number(origem_integracao_id)); j += 1; }

    const { rows: pedidos } = await pool.query(
      `SELECT (pv.valor_recebido_liberacao_em AT TIME ZONE 'America/Sao_Paulo')::date AS data,
              pv.origem_marketplace AS marketplace,
              SUM(pv.valor_recebido_marketplace) AS total_pedidos,
              COUNT(*) AS quantidade_pedidos
         FROM pedidos_venda pv
        WHERE ${condP.join(' AND ')}
          AND pv.situacao <> 'cancelado'
        GROUP BY 1, 2`,
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
