// API da Saúde da Sincronização (07/09/2026).
//
// Mostra o que o sistema deixou de saber: conexão que parou de trazer
// pedido, e pedido que falhou na importação — separando o que ainda vai ser
// tentado sozinho do que já saiu da janela de 7 dias e não vai mais.
//
// REGRA 1 — nada aqui lê ou escreve preço, custo, margem ou markup. A tela
// trata de pedido que ENTROU ou NÃO ENTROU, não de quanto ele valeu para a
// empresa.
//
// REGRA 4 — nenhum registro é apagado. "Resolver" uma falha grava a data e
// quem resolveu; a linha continua no histórico.
const express = require('express');
const pool = require('../db/pool');
const saude = require('../lib/saudeIntegracao');
const {
  reimportarPedidoFalho, marcarFalhaResolvida, sincronizarIntegracao,
} = require('../lib/marketplaceSync');

const router = express.Router();

// Quanto histórico de falha já resolvida a tela carrega. Serve para a pessoa
// ver que o problema de ontem sumiu — não é a lista principal.
const DIAS_DE_HISTORICO = 30;

async function carregarConexoes() {
  const { rows } = await pool.query(
    `SELECT id, marketplace, nome, ativo, ultima_sincronizacao, ultimo_erro,
            token_expira_em, conta_externa_id,
            (access_token IS NOT NULL) AS tem_token
       FROM integracoes_marketplace
      ORDER BY marketplace, nome`
  );
  // `access_token` NUNCA sai daqui — a tela só precisa saber se ele existe.
  return rows.map((r) => ({
    ...r,
    access_token: r.tem_token ? true : null,
  }));
}

async function carregarFalhas() {
  const { rows } = await pool.query(
    `SELECT f.*, i.nome AS integracao_nome
       FROM integracao_falhas_pedido f
       JOIN integracoes_marketplace i ON i.id = f.integracao_id
      WHERE f.resolvido_em IS NULL
         OR f.resolvido_em >= now() - ($1::int * INTERVAL '1 day')
      ORDER BY f.data_pedido NULLS LAST, f.primeira_falha_em`,
    [DIAS_DE_HISTORICO]
  );
  return rows;
}

router.get('/', async (req, res, next) => {
  try {
    const agora = new Date();
    const [conexoesCruas, falhas] = await Promise.all([carregarConexoes(), carregarFalhas()]);

    const conexoes = conexoesCruas.map((c) => ({ ...c, situacao: saude.situacaoDaConexao(c, agora) }));
    const resumo = saude.resumo(falhas, agora);

    res.json({
      agora: agora.toISOString(),
      conexoes,
      resumo,
      frase: saude.frasePrincipal(conexoes, resumo),
      categorias: saude.CATEGORIAS,
      janela_dias: saude.JANELA_RESSINCRONIZACAO_DIAS,
      ciclo_minutos: saude.CICLO_MINUTOS,
      dias_de_historico: DIAS_DE_HISTORICO,
    });
  } catch (err) {
    next(err);
  }
});

// Busca o pedido de novo no marketplace e tenta importar. É o único caminho
// para trazer de volta um pedido que já saiu da janela de 7 dias.
router.post('/falhas/:id/tentar-novamente', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, integracao_id, id_externo FROM integracao_falhas_pedido WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Falha não encontrada.' });

    const linha = rows[0];
    const { rows: integracaoRows } = await pool.query(
      'SELECT * FROM integracoes_marketplace WHERE id = $1',
      [linha.integracao_id]
    );
    const integracao = integracaoRows[0];
    if (!integracao) return res.status(404).json({ error: 'A conexão dessa falha não existe mais.' });
    if (!integracao.access_token) {
      return res.status(409).json({ error: 'Esta conexão não está autorizada — autorize em Configurações › Integrações antes de tentar de novo.' });
    }

    const resultado = await reimportarPedidoFalho({ id_externo: linha.id_externo }, integracao);
    res.json({
      ok: true,
      importado: resultado.importado,
      ja_existia: resultado.jaExistia,
      mensagem: resultado.jaExistia
        ? 'O pedido já estava no sistema. A pendência foi encerrada.'
        : 'Pedido importado. Confira em Marketplace › Pedidos.',
    });
  } catch (err) {
    // Falhar de novo é resultado esperado (o motivo pode não ter sido
    // corrigido ainda) e já foi regravado na tabela — a tela mostra o erro
    // novo em vez de um 500 mudo.
    if (err.status === 404) {
      return res.status(404).json({ error: 'O marketplace não tem mais esse pedido. Ele não pode ser importado.' });
    }
    if (err.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

// Encerra a pendência sem importar — para o caso em que a pessoa conferiu e
// o pedido não deve mesmo entrar (teste, pedido cancelado antes de pagar).
// Não apaga nada: grava quem encerrou e quando (REGRA 4).
router.post('/falhas/:id/encerrar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT integracao_id, id_externo FROM integracao_falhas_pedido WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Falha não encontrada.' });
    const encerrada = await marcarFalhaResolvida(rows[0].integracao_id, rows[0].id_externo, {
      por: req.user?.nome || null,
      como: 'manual',
    });
    if (!encerrada) return res.status(409).json({ error: 'Essa pendência já estava encerrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Roda o ciclo agora, para a conexão escolhida. Mesma função do laço
// automático — só que sob demanda, sem esperar os 5 minutos.
router.post('/conexoes/:id/sincronizar', async (req, res, next) => {
  try {
    const resultado = await sincronizarIntegracao(Number(req.params.id));
    res.json({ ok: true, ...resultado });
  } catch (err) {
    if (err.message) return res.status(422).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
