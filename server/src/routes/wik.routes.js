const express = require('express');
const pool = require('../db/pool');
const wik = require('../lib/wik');
const {
  buscarIntegracao, obterTokenBoxAtual, renovarTokenAgora, empIdsConfigurados, montarPreviewEstoque, aplicarSincronizacaoEstoque, sincronizarEstoqueAgora,
  criarOpcoesToken, registrarTentativaWik, registrarFalhaWik, registrarSucessoWik, calcularStatusToken, corrigirJobsPresos,
  reservarJobWik, liberarJobWik, mensagemJobOcupado, esquecerTokenEmMemoria,
} = require('../lib/wikSync');
const { montarPreviewProdutos, aplicarImportacaoProdutos, sincronizarProdutosAgora } = require('../lib/wikProdutosImport');
const { montarPreviewFichaCusto, aplicarImportacaoFichaCusto, sincronizarFichaCustoAgora } = require('../lib/wikFichaCustoImport');

const router = express.Router();

function paraFora(row, rejeicoes24h = 0) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    conectado: Boolean(row.access_token),
    ativo: row.ativo,
    ultimaSincronizacao: row.ultima_sincronizacao,
    ultimaTentativa: row.ultima_tentativa,
    ultimoErro: row.ultimo_erro,
    statusToken: calcularStatusToken(row),
    rejeicoesToken24h: rejeicoes24h,
    rejeicoesConsecutivasToken: row.rejeicoes_consecutivas_token || 0,
    ultimaExpiracaoSuspeita: row.ultima_expiracao_suspeita,
    previewStatus: row.preview_status,
    produtosImportStatus: row.produtos_import_status,
    fichaCustoImportStatus: row.ficha_custo_import_status,
  };
}

async function contarRejeicoesToken24h(integracaoId) {
  if (!integracaoId) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM wik_token_rejeicoes WHERE integracao_id = $1 AND criado_em > now() - interval '24 hours'`,
    [integracaoId]
  );
  return rows[0]?.total || 0;
}

router.get('/', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (integracao) await corrigirJobsPresos(integracao);
    const rejeicoes24h = await contarRejeicoesToken24h(integracao?.id);
    res.json(paraFora(integracao, rejeicoes24h));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha.' });
    const existente = await buscarIntegracao();
    let row;
    if (existente) {
      // Credencial nova (ou trocada) zera o contador de rejeições seguidas
      // (rejeicoes_consecutivas_token) — o modo degradado de uma credencial
      // ANTIGA não faz mais sentido pra uma credencial nova — e o token/
      // renovação ficam limpos (token_renovado_em incluído) pra forçar um
      // login de verdade com a credencial nova na próxima chamada, em vez de
      // seguir usando o token antigo até a próxima agenda de 2h.
      ({ rows: [row] } = await pool.query(
        `UPDATE integracoes_wik SET email = $1, senha = $2, access_token = NULL, token_expira_em = NULL,
                                     token_renovado_em = NULL, ultimo_erro = NULL, ultima_rejeicao_token = NULL,
                                     rejeicoes_consecutivas_token = 0, atualizado_em = now()
         WHERE id = $3 RETURNING *`,
        [email, senha, existente.id]
      ));
      esquecerTokenEmMemoria();
    } else {
      ({ rows: [row] } = await pool.query(
        'INSERT INTO integracoes_wik (email, senha) VALUES ($1, $2) RETURNING *',
        [email, senha]
      ));
    }
    res.status(201).json(paraFora(row));
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM integracoes_wik');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// "Testar conexão" faz um LOGIN de verdade — mas ATENÇÃO: isso é uma ação
// HUMANA deliberada (um clique), não uma reação automática a erro, então é
// sempre permitida pela regra do suporte do Wik. Usa renovarTokenAgora (o
// MESMO caminho que a agenda usa) pra trocar o token de forma atômica —
// nunca faz um login "solto" que ficaria descolado do tokenBox
// compartilhado. Não grava em ultima_tentativa/ultimo_erro/
// ultima_rejeicao_token (essas são só pra chamadas de DADO — ver
// calcularStatusToken acima; login sozinho não prova que saldo_estoque_get
// vai funcionar). Passa pela trava global — mesmo sendo rápido, ainda é uma
// chamada real à API do Wik e não deve rodar ao mesmo tempo que outro job.
router.post('/testar', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial primeiro.' });
    if (!(await reservarJobWik(integracao.id, 'teste-conexao'))) {
      return res.status(409).json({ error: await mensagemJobOcupado(integracao.id) });
    }
    try {
      const resultado = await renovarTokenAgora(integracao);
      res.json({ ok: true, nome: resultado.nome, email: resultado.email, expiraEm: resultado.expiraEm });
    } finally {
      await liberarJobWik(integracao.id);
    }
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// "Testar conexão completa" (item 7 do pedido de 27/08/2026) — o equivalente
// na tela do teste feito direto na API por PowerShell, fora do sistema, que
// isolou a causa raiz do 403: 1 login → 1 chamada de saldo_estoque_get
// (base "apiwiki") → 1 chamada de tamanhos_get (base "wiki_v2"), mostrando o
// HTTP status, o body.status e o corpo bruto de cada uma. Também é ação
// HUMANA deliberada (renovarTokenAgora, mesmo caminho de "Testar conexão"
// acima) — não participa do job/status normal de dado (sem
// registrarTentativaWik/registrarFalhaWik/registrarSucessoWik), mas passa
// pela trava global igual a tudo que toca a API do Wik. Nunca devolve o
// token pro front.
router.post('/testar-completo', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial primeiro.' });
    if (!(await reservarJobWik(integracao.id, 'teste-completo'))) {
      return res.status(409).json({ error: await mensagemJobOcupado(integracao.id) });
    }
    try {
      const login = await renovarTokenAgora(integracao);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const porEmpId = await empIdsConfigurados();
      const primeiroEmpId = porEmpId.size > 0 ? [...porEmpId.keys()][0] : null;

      const chamadaEstoque = primeiroEmpId
        ? await wik.chamarBrutoDiagnostico(login.token, 'apiwiki', 'saldo_estoque_get', { empId: primeiroEmpId, pagina: 1 })
        : { pulado: 'nenhuma marca com Id de Empresa configurado (em Listas > Marcas) — não dá pra montar o parâmetro empId' };
      const chamadaTamanhos = await wik.chamarBrutoDiagnostico(login.token, 'wiki_v2', 'tamanhos_get', {});

      res.json({
        login: {
          criacao: login.criacao,
          expiracao: login.expiraEm,
          expiracaoSuspeita: login.expiracaoSuspeita,
          usuarioMaster: login.usuarioMaster,
          empresaAcesso: login.empresaAcesso,
        },
        saldoEstoque: { base: 'apiwiki', path: 'saldo_estoque_get', empIdUsado: primeiroEmpId, ...chamadaEstoque },
        tamanhos: { base: 'wiki_v2', path: 'tamanhos_get', ...chamadaTamanhos },
      });
    } finally {
      await liberarJobWik(integracao.id);
    }
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// Com o limite de 3 req/s do Wik, puxar o saldo inteiro de duas empresas
// pode passar de um minuto — tempo demais pra uma única requisição HTTP
// (o proxy do Render derruba antes). Por isso o botão só dispara o job
// (roda em segundo plano, sem o `await`) e devolve na hora; o front consulta
// o progresso via GET até o status virar "concluido" ou "erro". Essa rota
// só MOSTRA o que mudaria — quem aplica de verdade é a sincronização
// automática (a cada 15min) ou o botão "Sincronizar agora" abaixo.
router.post('/estoque/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });

    const jobTravado = integracao.preview_status === 'rodando'
      && integracao.preview_iniciado_em
      && Date.now() - new Date(integracao.preview_iniciado_em).getTime() < 10 * 60 * 1000;
    if (jobTravado) return res.json({ status: 'rodando' });

    const porEmpId = await empIdsConfigurados();
    if (porEmpId.size === 0) {
      return res.status(400).json({ error: 'Nenhuma marca tem Id de Empresa do Wik configurado (em Listas > Marcas).' });
    }

    if (!(await reservarJobWik(integracao.id, 'estoque-preview'))) {
      return res.status(409).json({ error: await mensagemJobOcupado(integracao.id) });
    }

    await registrarTentativaWik(integracao.id);
    await pool.query(
      `UPDATE integracoes_wik SET preview_status = 'rodando', preview_resultado = NULL, preview_erro = NULL,
                                   preview_iniciado_em = now(), atualizado_em = now() WHERE id = $1`,
      [integracao.id]
    );
    res.json({ status: 'rodando' });

    montarPreviewEstoque(integracao, porEmpId)
      .then(async (resultado) => {
        await pool.query(
          `UPDATE integracoes_wik SET preview_status = 'concluido', preview_resultado = $1, atualizado_em = now() WHERE id = $2`,
          [JSON.stringify(resultado), integracao.id]
        );
        await registrarSucessoWik(integracao.id);
      })
      .catch(async (err) => {
        await pool.query(
          `UPDATE integracoes_wik SET preview_status = 'erro', preview_erro = $1, atualizado_em = now() WHERE id = $2`,
          [err.message, integracao.id]
        );
        await registrarFalhaWik(integracao.id, err);
      })
      .finally(async () => {
        await liberarJobWik(integracao.id);
      });
  } catch (err) {
    next(err);
  }
});

router.get('/estoque/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });
    await corrigirJobsPresos(integracao);
    res.json({
      status: integracao.preview_status,
      resultado: integracao.preview_resultado,
      erro: integracao.preview_erro,
    });
  } catch (err) {
    next(err);
  }
});

// Grava de fato o resultado de uma pré-visualização já feita (usado pela
// tela de conferência manual).
router.post('/estoque/confirmar', async (req, res, next) => {
  try {
    const body = req.body || {};
    const resultado = await aplicarSincronizacaoEstoque({ criar: body.criar || [], atualizar: body.atualizar || [] });

    const integracao = await buscarIntegracao();
    if (integracao) {
      await pool.query(
        `UPDATE integracoes_wik SET preview_status = 'idle', preview_resultado = NULL WHERE id = $1`,
        [integracao.id]
      );
      await registrarSucessoWik(integracao.id, { sincronizouEstoque: true });
    }

    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// Força uma sincronização completa (busca + aplica) agora, sem esperar o
// próximo ciclo automático de 15min — mesma rotina que roda sozinha.
router.post('/estoque/sincronizar-agora', async (req, res, next) => {
  try {
    const resultado = await sincronizarEstoqueAgora();
    res.json(resultado);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// Importação completa do catálogo (produtos + variantes + estoque
// consolidado) — separada da sincronização de estoque recorrente, usa
// colunas de status próprias (produtos_import_*) pra não colidir com ela.
// Além do botão manual abaixo, roda sozinha periodicamente (ver index.js)
// pra pegar produtos recém-lançados no Wik sem depender de clique nenhum —
// seguro porque só CRIA produtos novos, nunca apaga/edita os existentes.
router.post('/produtos/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });

    const jobTravado = integracao.produtos_import_status === 'rodando'
      && integracao.produtos_import_iniciado_em
      && Date.now() - new Date(integracao.produtos_import_iniciado_em).getTime() < 30 * 60 * 1000;
    if (jobTravado) return res.json({ status: 'rodando' });

    if (!(await reservarJobWik(integracao.id, 'produtos-preview'))) {
      return res.status(409).json({ error: await mensagemJobOcupado(integracao.id) });
    }

    await registrarTentativaWik(integracao.id);
    await pool.query(
      `UPDATE integracoes_wik SET produtos_import_status = 'rodando', produtos_import_resultado = NULL,
                                   produtos_import_erro = NULL, produtos_import_iniciado_em = now(), atualizado_em = now()
       WHERE id = $1`,
      [integracao.id]
    );
    res.json({ status: 'rodando' });

    montarPreviewProdutos(integracao)
      .then(async (resultado) => {
        await pool.query(
          `UPDATE integracoes_wik SET produtos_import_status = 'concluido', produtos_import_resultado = $1,
                                       atualizado_em = now() WHERE id = $2`,
          [JSON.stringify(resultado), integracao.id]
        );
        await registrarSucessoWik(integracao.id);
      })
      .catch(async (err) => {
        await pool.query(
          `UPDATE integracoes_wik SET produtos_import_status = 'erro', produtos_import_erro = $1, atualizado_em = now() WHERE id = $2`,
          [err.message, integracao.id]
        );
        await registrarFalhaWik(integracao.id, err);
      })
      .finally(async () => {
        await liberarJobWik(integracao.id);
      });
  } catch (err) {
    next(err);
  }
});

router.get('/produtos/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });
    await corrigirJobsPresos(integracao);
    res.json({
      status: integracao.produtos_import_status,
      resultado: integracao.produtos_import_resultado,
      erro: integracao.produtos_import_erro,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/produtos/confirmar', async (req, res, next) => {
  try {
    const body = req.body || {};
    const resultado = await aplicarImportacaoProdutos(body.criar || []);

    const integracao = await buscarIntegracao();
    if (integracao) {
      await pool.query(
        `UPDATE integracoes_wik SET produtos_import_status = 'idle', produtos_import_resultado = NULL WHERE id = $1`,
        [integracao.id]
      );
    }

    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// Força a importação de produtos novos agora, sem esperar o próximo ciclo
// automático (ver WIK_CATALOGO_INTERVAL_MS em index.js).
router.post('/produtos/sincronizar-agora', async (req, res, next) => {
  try {
    const resultado = await sincronizarProdutosAgora();
    res.json(resultado);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ---------- Ficha de Custo (Audaces) — ainda em fase de descoberta ----------
// Ainda não sabemos como o "id" de insumosfichatecnica_get/
// operacoesfichatecnica_get se relaciona com o produto na prática (a doc
// chama de "id do produto ficha tecnica", ambíguo) — essa rota só busca o
// ProdId de um produto real (pela referência, já que produto_get não lista
// sem filtro) e mostra a resposta crua dos dois endpoints, pra confirmar
// antes de construir a importação de verdade.
router.post('/ficha-custo/diagnosticar', async (req, res, next) => {
  try {
    const { referencia } = req.body || {};
    if (!referencia) return res.status(400).json({ error: 'Informe a referência do produto.' });

    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });

    const { rows } = await pool.query('SELECT id, referencia, descricao, wik_prod_id FROM produtos WHERE referencia ILIKE $1', [referencia.trim()]);
    if (rows.length === 0) return res.status(404).json({ error: 'Não achei esse produto cadastrado localmente.' });
    const produto = rows[0];

    if (!(await reservarJobWik(integracao.id, 'diagnostico-ficha'))) {
      return res.status(409).json({ error: await mensagemJobOcupado(integracao.id) });
    }
    try {
      const tokenBox = await obterTokenBoxAtual(integracao);
      const opcoesToken = criarOpcoesToken(integracao);

      let wikProdId = produto.wik_prod_id;
      let produtoWik = null;
      if (!wikProdId) {
        produtoWik = await wik.buscarProdutoPorReferencia(tokenBox, referencia, opcoesToken);
        wikProdId = produtoWik?.ProdId || null;
        if (wikProdId) {
          await pool.query('UPDATE produtos SET wik_prod_id = $1 WHERE id = $2', [wikProdId, produto.id]);
        }
      }

      if (!wikProdId) {
        return res.status(422).json({
          error: 'Não consegui resolver o ProdId desse produto no Wik (busca por referência não retornou nada).',
          produtoWik,
        });
      }

      // Sequencial, não Promise.all — chamadas do Wik em paralelo foram
      // exatamente a causa do bloqueio de conta em 17/08/2026 ("múltiplos
      // acessos com o mesmo token"). A fila serial em wik.js já garante isso
      // no nível mais baixo, mas aqui fica explícito também.
      const insumos = await wik.buscarInsumosFichaTecnica(tokenBox, wikProdId, opcoesToken).catch((err) => ({ erro: err.message }));
      const operacoesFicha = await wik.buscarOperacoesFichaTecnica(tokenBox, wikProdId, opcoesToken).catch((err) => ({ erro: err.message }));
      const operacoesGlobais = await wik.listarOperacoes(tokenBox, opcoesToken).catch((err) => ({ erro: err.message }));

      // A doc de materiaprima_get não mostra campo de custo — testa aqui se
      // ele vem "escondido" mesmo assim (já rolou duas vezes de a doc omitir
      // campo que a resposta real trazia).
      let materiaPrimaExemplo = null;
      if (Array.isArray(insumos) && insumos.length > 0) {
        materiaPrimaExemplo = await wik.buscarMateriaPrima(tokenBox, insumos[0].MatId, opcoesToken).catch((err) => ({ erro: err.message }));
      }

      res.json({
        produto: { ...produto, wik_prod_id: wikProdId }, produtoWik, insumos, operacoesFicha, operacoesGlobais,
        materiaPrimaExemplo: materiaPrimaExemplo ? { matIdTestado: insumos[0]?.MatId, resposta: materiaPrimaExemplo } : null,
      });
    } finally {
      await liberarJobWik(integracao.id);
    }
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// Importação de Ficha de Custo — cria ficha nova pra produto que ainda não
// tem nenhuma, e ATUALIZA a ficha de produto que já foi importada do Wik
// antes (ficha_custo_origem_wik = TRUE), pra acompanhar mudanças feitas lá.
// Uma ficha editada à mão localmente nunca é tocada (ver
// ficha_custo_origem_wik em produtos.routes.js). Além do botão manual
// abaixo, roda sozinha periodicamente (ver index.js). Assíncrono pelo mesmo
// motivo dos outros: cada produto exige várias chamadas (insumos +
// operações + 1 por material único), e um catálogo grande facilmente passa
// dos limites de uma única requisição HTTP.
router.post('/ficha-custo/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });

    const jobTravado = integracao.ficha_custo_import_status === 'rodando'
      && integracao.ficha_custo_import_iniciado_em
      && Date.now() - new Date(integracao.ficha_custo_import_iniciado_em).getTime() < 30 * 60 * 1000;
    if (jobTravado) return res.json({ status: 'rodando' });

    if (!(await reservarJobWik(integracao.id, 'ficha-custo-preview'))) {
      return res.status(409).json({ error: await mensagemJobOcupado(integracao.id) });
    }

    await registrarTentativaWik(integracao.id);
    await pool.query(
      `UPDATE integracoes_wik SET ficha_custo_import_status = 'rodando', ficha_custo_import_resultado = NULL,
                                   ficha_custo_import_erro = NULL, ficha_custo_import_iniciado_em = now(), atualizado_em = now()
       WHERE id = $1`,
      [integracao.id]
    );
    res.json({ status: 'rodando' });

    montarPreviewFichaCusto(integracao)
      .then(async (resultado) => {
        await pool.query(
          `UPDATE integracoes_wik SET ficha_custo_import_status = 'concluido', ficha_custo_import_resultado = $1,
                                       atualizado_em = now() WHERE id = $2`,
          [JSON.stringify(resultado), integracao.id]
        );
        await registrarSucessoWik(integracao.id);
      })
      .catch(async (err) => {
        await pool.query(
          `UPDATE integracoes_wik SET ficha_custo_import_status = 'erro', ficha_custo_import_erro = $1, atualizado_em = now() WHERE id = $2`,
          [err.message, integracao.id]
        );
        await registrarFalhaWik(integracao.id, err);
      })
      .finally(async () => {
        await liberarJobWik(integracao.id);
      });
  } catch (err) {
    next(err);
  }
});

router.get('/ficha-custo/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });
    await corrigirJobsPresos(integracao);
    res.json({
      status: integracao.ficha_custo_import_status,
      resultado: integracao.ficha_custo_import_resultado,
      erro: integracao.ficha_custo_import_erro,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ficha-custo/confirmar', async (req, res, next) => {
  try {
    const body = req.body || {};
    const resultado = await aplicarImportacaoFichaCusto(body.produtos || []);

    const integracao = await buscarIntegracao();
    if (integracao) {
      await pool.query(
        `UPDATE integracoes_wik SET ficha_custo_import_status = 'idle', ficha_custo_import_resultado = NULL WHERE id = $1`,
        [integracao.id]
      );
    }

    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// Força a atualização das fichas de custo agora, sem esperar o próximo
// ciclo automático (ver WIK_CATALOGO_INTERVAL_MS em index.js).
router.post('/ficha-custo/sincronizar-agora', async (req, res, next) => {
  try {
    const resultado = await sincronizarFichaCustoAgora();
    res.json(resultado);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;
