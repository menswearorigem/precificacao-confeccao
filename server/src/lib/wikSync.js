const pool = require('../db/pool');
const wik = require('./wik');
const { resolverEan } = require('./eanResolver');
const { registrarMovimento } = require('./estoqueMovimento');
const { normalizarComparacao } = require('./marketplaceSync');

// Vários campos "descritivos" do saldo_estoque_get vêm como "id-DESCRIÇÃO"
// (ex.: cor: "10-DIVERSAS", grupo: "1 - CALÇA") — aqui só a descrição, sem
// o id, é o que bate com o que a gente já guarda em estoque_variantes.cor.
function limparDescricaoWik(valor) {
  return String(valor || '').replace(/^\s*\d+\s*-\s*/, '').trim();
}

// Chave de comparação normalizada (mesma normalizarComparacao usada no
// casamento de SKU de marketplace — ver marketplaceSync.js e a correção da
// Tarefa 1): sem acento, sem espaço/hífen/pontuação, maiúsculo. Aplicada
// também na REFERÊNCIA, não só cor/tamanho.
//
// CORRIGIDO (Tarefa 2): antes só dava .toUpperCase() em cor/tamanho e
// comparava a referência ao pé da letra — bem mais fraco que a normalização
// usada do lado do marketplace. Isso é exatamente o que fazia uma variante
// corrigida à mão (ex.: cor com espaço/hífen diferente do jeito que o Wik
// manda) nunca mais bater com o saldo do Wik: a chave calculada aqui
// divergia da chave da variante já existente, a linha do Wik caía no balde
// "criar" e nascia uma variante duplicada — o saldo do Wik passava a
// atualizar essa duplicata, enquanto a variante editada ficava congelada
// pra sempre. Nunca reescreve o cadastro, só compara.
function chaveVariante(referencia, cor, tamanho) {
  return `${normalizarComparacao(referencia)}::${normalizarComparacao(cor)}::${normalizarComparacao(tamanho)}`;
}

async function buscarIntegracao() {
  const { rows } = await pool.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
  return rows[0] || null;
}

// Garante um token válido pra integração, logando de novo se estiver
// ausente/expirado. Com `forcar: true` ignora o que o banco acha que ainda
// é válido e login de novo mesmo assim — usado quando o próprio Wik já
// rejeitou o token com "token inválido ou expirado", ou seja, a validade
// real do lado deles já passou mesmo com o relógio daqui ainda achando que
// tinha tempo (a validade em si vem SÓ de retorno.expiracao — nunca
// calculada aqui, ver wik.js).
//
// Margem de 10min: folga suficiente pra uma sincronização mais longa
// terminar antes do vencimento de verdade (teste direto na API, fora do
// sistema, 27/08/2026: token de 4h de vida real).
async function obterTokenValido(integracao, { forcar = false } = {}) {
  const MARGEM_MS = 10 * 60 * 1000;
  const expirado = forcar || !integracao.token_expira_em || new Date(integracao.token_expira_em).getTime() - Date.now() < MARGEM_MS;
  if (integracao.access_token && !expirado) return integracao.access_token;

  const TENTATIVAS = 3;
  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa += 1) {
    try {
      const resultado = await wik.login(integracao.email, integracao.senha);
      // NÃO limpa ultimo_erro/ultima_rejeicao_token aqui — um LOGIN
      // bem-sucedido não prova que uma chamada de DADO vai funcionar (é
      // exatamente essa distinção que corrige o selo "TOKEN VÁLIDO"
      // aparecendo ao lado de uma rejeição real, ver calcularStatusToken
      // abaixo). Só registrarSucessoWik (chamado depois de uma operação de
      // dado de verdade dar certo) limpa esse estado.
      await pool.query(
        `UPDATE integracoes_wik SET access_token = $1, token_expira_em = $2,
                                     ultima_expiracao_suspeita = $3, atualizado_em = now() WHERE id = $4`,
        [resultado.token, resultado.expiraEm, resultado.expiracaoSuspeita ? new Date() : null, integracao.id]
      );
      // Mantém o objeto em memória em sincronia — evita logar de novo à toa
      // se essa mesma chamada rodar mais de uma vez dentro do mesmo processo
      // (ex.: renovação forçada no meio de uma sincronização longa, seguida
      // de outra chamada que também checa validade).
      integracao.access_token = resultado.token;
      integracao.token_expira_em = resultado.expiraEm;
      return resultado.token;
    } catch (err) {
      ultimoErro = err;
      if (tentativa < TENTATIVAS) await new Promise((resolve) => setTimeout(resolve, tentativa * 2000));
    }
  }
  const erroFinal = new Error(`Não foi possível renovar o token do Wik depois de ${TENTATIVAS} tentativa(s): ${ultimoErro.message}`);
  await registrarFalhaWik(integracao.id, erroFinal);
  throw erroFinal;
}

// ---------- registro de tentativa/erro/sucesso — usado por TODAS as
// chamadas ao Wik (sincronização de estoque, produtos, ficha de custo,
// teste de conexão), não só saldo_estoque_get. ----------

// Diferente de ultima_sincronizacao (só sucesso do ciclo completo de
// estoque) — sem isso não dava pra saber se um clique/ciclo automático
// chegou a rodar: o texto de ultimo_erro ficava idêntico ao de 8 dias
// atrás, então "não mudou" não distinguia "não tentei" de "tentei e
// continuo falhando do mesmo jeito".
async function registrarTentativaWik(integracaoId) {
  await pool.query('UPDATE integracoes_wik SET ultima_tentativa = now() WHERE id = $1', [integracaoId]);
}

// Classifica pela CAUSA RAIZ (erro.causaWikToken, marcado em wik.js na hora
// em que a rejeição de token é detectada de verdade), não pelo texto da
// última mensagem. CORRIGIDO: quando o relogin forçado é bloqueado pelo
// limite de 10min (ver criarOpcoesTokenComLimite abaixo), a mensagem que
// sobe pro chamador é a do BLOQUEIO ("já tentei reautenticar há menos de
// X min..."), não o 403 original — checar só o texto dessa mensagem final
// perdia a classificação (virava "erro_outro" mesmo a causa sendo token).
// O parâmetro pode ser um Error (com ou sem `causaWikToken`) ou uma string
// solta (chamadas antigas/diretas) — nesse caso cai no casamento de texto
// como fallback.
function pareceRejeicaoDeToken(mensagemOuErro) {
  if (mensagemOuErro && typeof mensagemOuErro === 'object' && mensagemOuErro.causaWikToken) return true;
  const texto = String(mensagemOuErro?.message ?? mensagemOuErro ?? '').toLowerCase();
  return texto.includes('token') && (texto.includes('inválid') || texto.includes('invalid') || texto.includes('expir') || texto.includes('rejeit'));
}

// Registra o erro de qualquer operação do Wik, distinguindo rejeição de
// token (loga em wik_token_rejeicoes pra contagem de 24h, marca
// ultima_rejeicao_token e incrementa rejeicoes_consecutivas_token — ver
// modo degradado abaixo) de qualquer outro tipo de erro — é essa distinção
// que corrige o selo "TOKEN VÁLIDO" aparecendo do lado de "última tentativa
// falhou": antes o selo só olhava se existia uma string de token gravada,
// nunca se a ÚLTIMA tentativa de usá-la tinha dado certo. Aceita o Error
// inteiro (preferível, permite classificar pela causa raiz) ou uma string.
async function registrarFalhaWik(integracaoId, mensagemOuErro) {
  const ehToken = pareceRejeicaoDeToken(mensagemOuErro);
  const mensagem = mensagemOuErro instanceof Error ? mensagemOuErro.message : String(mensagemOuErro);
  if (ehToken) {
    await pool.query('INSERT INTO wik_token_rejeicoes (integracao_id) VALUES ($1)', [integracaoId]);
  }
  await pool.query(
    `UPDATE integracoes_wik SET ultimo_erro = $1, ultima_rejeicao_token = $2,
                                 rejeicoes_consecutivas_token = CASE WHEN $4 THEN rejeicoes_consecutivas_token + 1 ELSE rejeicoes_consecutivas_token END,
                                 atualizado_em = now() WHERE id = $3`,
    [mensagem, ehToken ? new Date() : null, integracaoId, ehToken]
  );
}

async function registrarSucessoWik(integracaoId, { sincronizouEstoque = false } = {}) {
  const campoExtra = sincronizouEstoque ? ', ultima_sincronizacao = now()' : '';
  await pool.query(
    `UPDATE integracoes_wik SET ultimo_erro = NULL, ultima_rejeicao_token = NULL, rejeicoes_consecutivas_token = 0${campoExtra}, atualizado_em = now() WHERE id = $1`,
    [integracaoId]
  );
}

// Limite de reautenticação: no máximo 1 login forçado a cada
// BACKOFF_REAUTENTICACAO_MS, não importa quantas chamadas dentro do MESMO
// ciclo rejeitem o token. Sem esse limite, uma sincronização paginada
// (várias empresas/páginas) tentaria relogar a cada chamada que rejeitasse.
// Usado por TODAS as sincronizações do Wik (estoque, produtos, ficha de
// custo, diagnóstico de ficha técnica), não só saldo_estoque_get.
//
// Login bem-sucedido por "Testar conexão" ou "Salvar credencial" LIMPA essa
// marca (ver rotas em wik.routes.js) — um login manual que deu certo prova
// que a credencial está boa AGORA, então não faz sentido deixar uma marca
// antiga de relogin forçado bloqueando uma tentativa de recuperação
// legítima logo em seguida (foi exatamente o bug visto em produção: login
// manual às 09:41 deu certo, a chamada de dado foi rejeitada às 09:42, e a
// trava — de um relogin forçado ANTERIOR — recusou nova tentativa).
const BACKOFF_REAUTENTICACAO_MS = 10 * 60 * 1000;

// Modo degradado: quando o Wik rejeita o token 5x SEGUIDAS (teste direto na
// API, fora do sistema, 27/08/2026, mostrou que a causa é o acesso de DADOS
// da conta revogado/suspenso do lado deles, não sessão — login sozinho
// continua funcionando igual). Insistir a cada 15min nessas condições só
// gera tráfego inútil (chegou a 224 rejeições em 24h, uma a cada ~6min) e
// pode ser lido como abuso pelo fornecedor. A partir do limiar: os ciclos
// automáticos passam a tentar 1x/hora em vez do ritmo normal (ver
// cicloDevePular abaixo) E o relogin forçado dentro de um ciclo é
// desativado (ver criarOpcoesTokenComLimite abaixo) — sem sentido insistir
// em relogar quando já sabemos que o login não é o problema. Volta ao normal
// sozinho na primeira chamada de dado bem-sucedida (registrarSucessoWik
// zera o contador) ou quando a credencial é salva de novo na tela.
const LIMIAR_MODO_DEGRADADO = 5;
const INTERVALO_MODO_DEGRADADO_MS = 60 * 60 * 1000;

function emModoDegradado(integracao) {
  return (integracao.rejeicoes_consecutivas_token || 0) >= LIMIAR_MODO_DEGRADADO;
}

// Chamado no início de cada ciclo automático (estoque/produtos/ficha de
// custo) — devolve uma string de motivo (pra virar `{ pulado }`) quando o
// ciclo deve ser pulado por estar em modo degradado e ainda não ter passado
// 1h desde a última tentativa, ou `null` quando deve rodar normalmente.
function cicloDevePular(integracao) {
  if (!emModoDegradado(integracao)) return null;
  const ultima = integracao.ultima_tentativa ? new Date(integracao.ultima_tentativa).getTime() : 0;
  if (Date.now() - ultima < INTERVALO_MODO_DEGRADADO_MS) {
    return `modo degradado (${integracao.rejeicoes_consecutivas_token} rejeições de token seguidas) — tentando 1x/hora `
      + 'em vez do ritmo normal até o Wik aceitar de novo ou a credencial ser salva';
  }
  return null;
}

function criarOpcoesTokenComLimite(integracao) {
  return {
    aoDetectarTokenMorto: () => registrarFalhaWik(integracao.id, 'Token rejeitado pelo Wik ("token inválido ou expirado").'),
    renovarToken: async () => {
      if (emModoDegradado(integracao)) {
        throw new Error(
          `Já são ${integracao.rejeicoes_consecutivas_token} rejeições de token seguidas — parei de forçar relogin `
          + '(modo degradado) até a primeira chamada de dado bem-sucedida ou a credencial ser salva de novo na tela.'
        );
      }
      const { rows } = await pool.query('SELECT ultima_reautenticacao_forcada FROM integracoes_wik WHERE id = $1', [integracao.id]);
      const ultima = rows[0]?.ultima_reautenticacao_forcada;
      if (ultima && Date.now() - new Date(ultima).getTime() < BACKOFF_REAUTENTICACAO_MS) {
        throw new Error(
          `Token do Wik rejeitado, mas já tentei reautenticar há menos de ${Math.round(BACKOFF_REAUTENTICACAO_MS / 60000)} min — `
          + 'não insisto de novo agora. Tento de novo mais tarde.'
        );
      }
      await pool.query('UPDATE integracoes_wik SET ultima_reautenticacao_forcada = now() WHERE id = $1', [integracao.id]);
      return obterTokenValido(integracao, { forcar: true });
    },
  };
}

// Agrupa as marcas cadastradas (listas tipo='marca') por Id de Empresa do
// Wik — mais de uma marca pode compartilhar o mesmo Id (ex.: Hoggar e Miss
// Manu ficam sob a mesma empresa lá no Wik).
async function empIdsConfigurados() {
  const { rows } = await pool.query(
    "SELECT valor, wik_emp_id FROM listas WHERE tipo = 'marca' AND wik_emp_id IS NOT NULL AND ativo = TRUE"
  );
  const porEmpId = new Map();
  for (const row of rows) {
    if (!porEmpId.has(row.wik_emp_id)) porEmpId.set(row.wik_emp_id, []);
    porEmpId.get(row.wik_emp_id).push(row.valor);
  }
  return porEmpId;
}

// Puxa o saldo de todas as empresas (marcas) configuradas e cruza com o que
// já existe localmente — mesma lógica/formato da importação manual de
// CSV/PDF (estoque.routes.js), só que a fonte é a API em vez de um arquivo.
async function montarPreviewEstoque(integracao, porEmpId) {
  const token = await obterTokenValido(integracao);
  const tokenBox = wik.criarTokenBox(token);
  const opcoesToken = criarOpcoesTokenComLimite(integracao);

  const linhasBrutas = [];
  for (const empId of porEmpId.keys()) {
    const linhas = await wik.listarSaldoEstoque(tokenBox, empId, opcoesToken);
    linhasBrutas.push(...linhas);
  }

  const { rows: produtosRows } = await pool.query('SELECT id, referencia FROM produtos');
  const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

  const { rows: variantesRows } = await pool.query(
    `SELECT v.*, p.referencia FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id`
  );
  const varianteExistente = new Map(variantesRows.map((v) => [chaveVariante(v.referencia, v.cor, v.tamanho), v]));

  const porChave = new Map();
  const erros = [];
  for (const linha of linhasBrutas) {
    const referencia = linha.prod_referencia;
    const cor = limparDescricaoWik(linha.cor);
    const tamanho = linha.estct_tamanho || '';
    const quantidade = Number(linha.estct_saldo) || 0;
    if (!produtoIdPorReferencia.has(referencia)) {
      erros.push({ motivo: `Referência "${referencia}" não está cadastrada em Produtos — cadastre-a antes de sincronizar.`, dados: { referencia, cor, tamanho } });
      continue;
    }
    // BUG CORRIGIDO: isso sobrescrevia sem comparar, então quando o mesmo
    // produto+cor+tamanho existia em mais de uma loja (empresa), só a
    // última loja processada no loop "ganhava" — nunca o maior valor entre
    // elas, como devia ser (pedido explícito da usuária, já que cada loja
    // registra um saldo diferente hoje). Agora compara e fica com o maior.
    const chave = chaveVariante(referencia, cor, tamanho);
    const atual = porChave.get(chave);
    if (!atual || quantidade > atual.quantidade) {
      porChave.set(chave, { referencia, descricao: linha.prod_descricao, cor, tamanho, quantidade });
    }
  }

  const criar = [];
  const atualizar = [];
  for (const [chave, linha] of porChave.entries()) {
    const existente = varianteExistente.get(chave);
    if (existente) {
      if (Number(existente.quantidade) === linha.quantidade) continue; // sem mudança, não precisa listar
      atualizar.push({
        referencia: linha.referencia, descricao: linha.descricao, cor: linha.cor, tamanho: linha.tamanho,
        quantidadeAtual: Number(existente.quantidade), quantidadeNova: linha.quantidade, varianteId: existente.id,
      });
    } else {
      criar.push({ referencia: linha.referencia, descricao: linha.descricao, cor: linha.cor, tamanho: linha.tamanho, quantidadeNova: linha.quantidade });
    }
  }

  return {
    criar, atualizar, erros,
    resumo: { totalLinhasWik: linhasBrutas.length, variantesCriar: criar.length, variantesAtualizar: atualizar.length, totalErros: erros.length },
  };
}

const MOTIVO_SINCRONIZACAO_PADRAO = 'Sincronização automática — Wik Sistemas';

// Grava de fato as mudanças de um resultado de preview (criar/atualizar) —
// usado tanto pela confirmação manual quanto pela sincronização automática.
// `motivo` é sobrescrevível (ex.: reconciliação manual pontual de uma
// referência específica) pra deixar rastro claro em estoque_movimentos de
// qual fluxo gerou aquele lançamento, sem nunca fazer UPDATE direto no saldo.
async function aplicarSincronizacaoEstoque({ criar, atualizar }, motivo = MOTIVO_SINCRONIZACAO_PADRAO) {
  const client = await pool.connect();
  try {
    const { rows: produtosRows } = await client.query('SELECT id, referencia FROM produtos');
    const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

    await client.query('BEGIN');

    let criados = 0;
    for (const item of criar || []) {
      const produtoId = produtoIdPorReferencia.get(item.referencia);
      if (!produtoId) continue;
      const ean = await resolverEan(client, item.referencia, item.cor, item.tamanho);
      const { rows } = await client.query(
        `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (produto_id, cor, tamanho) DO NOTHING RETURNING id`,
        [produtoId, item.cor, item.tamanho, ean, item.quantidadeNova]
      );
      if (rows.length > 0 && Number(item.quantidadeNova) !== 0) {
        await client.query(
          `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
           VALUES ($1, 'importacao', $2, $2, $3)`,
          [rows[0].id, item.quantidadeNova, motivo]
        );
      }
      if (rows.length > 0) criados += 1;
    }

    let atualizados = 0;
    for (const item of atualizar || []) {
      const delta = Number(item.quantidadeNova) - Number(item.quantidadeAtual);
      if (delta !== 0) {
        await registrarMovimento(client, item.varianteId, 'importacao', delta, motivo);
      }
      atualizados += 1;
    }

    await client.query('COMMIT');
    return { criados, atualizados };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pipeline completo (busca + aplica), usado pelo job automático em segundo
// plano. Não deixa duas execuções se sobreporem — o Wik não permite duas
// sessões simultâneas com o mesmo login, então uma sincronização rodando
// (manual ou automática) precisa terminar antes da próxima começar.
async function sincronizarEstoqueAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem credencial ativa' };

  const jobTravado = integracao.preview_status === 'rodando'
    && integracao.preview_iniciado_em
    && Date.now() - new Date(integracao.preview_iniciado_em).getTime() < 10 * 60 * 1000;
  if (jobTravado) return { pulado: 'já tem uma sincronização em andamento' };

  const pulado = cicloDevePular(integracao);
  if (pulado) return { pulado };

  const porEmpId = await empIdsConfigurados();
  if (porEmpId.size === 0) return { pulado: 'nenhuma marca com Id de Empresa configurado' };

  await registrarTentativaWik(integracao.id);
  await pool.query(
    `UPDATE integracoes_wik SET preview_status = 'rodando', preview_resultado = NULL, preview_erro = NULL,
                                 preview_iniciado_em = now(), atualizado_em = now() WHERE id = $1`,
    [integracao.id]
  );

  // Instrumentação pra responder de verdade "quanto tempo leva um ciclo
  // hoje e quantas chamadas ele faz contra o limite de 3/s" (pergunta (iii)
  // da Tarefa 3) em vez de estimar — some com os logs do Render.
  wik.zerarContadorChamadas();
  const inicio = Date.now();
  try {
    const resultado = await montarPreviewEstoque(integracao, porEmpId);
    const aplicado = await aplicarSincronizacaoEstoque(resultado);
    await pool.query(
      `UPDATE integracoes_wik SET preview_status = 'idle', preview_resultado = NULL, atualizado_em = now() WHERE id = $1`,
      [integracao.id]
    );
    await registrarSucessoWik(integracao.id, { sincronizouEstoque: true });
    console.log(`[wik-sync] ciclo concluído em ${((Date.now() - inicio) / 1000).toFixed(1)}s, ${wik.contadorChamadas()} chamada(s) à API do Wik.`);
    return { ...aplicado, erros: resultado.erros.length };
  } catch (err) {
    await pool.query(
      `UPDATE integracoes_wik SET preview_status = 'erro', preview_erro = $1, atualizado_em = now() WHERE id = $2`,
      [err.message, integracao.id]
    );
    await registrarFalhaWik(integracao.id, err);
    throw err;
  }
}

// Mesmo paliativo que já existe pros marketplaces (sincronizarSeNecessario
// em marketplaceSync.js) — o setInterval de 15min (index.js) só roda
// enquanto o processo está de pé, e no plano gratuito do Render o serviço
// dorme depois de um tempo sem tráfego. Sem isso, se o processo ficar
// dormindo além de um ciclo, a sincronização do Wik fica parada até alguém
// notar (foi exatamente o que aconteceu: 7 dias sem sincronizar, sem nada
// acordar o processo pra tentar de novo). Chamada a cada carregamento da
// tela de Estoque; o cooldown evita disparar a cada requisição enquanto a
// usuária navega.
const COOLDOWN_MS = 5 * 60 * 1000;
let ultimaChamadaOportunista = 0;

function sincronizarEstoqueSeNecessario() {
  const agora = Date.now();
  if (agora - ultimaChamadaOportunista < COOLDOWN_MS) return;
  ultimaChamadaOportunista = agora;
  sincronizarEstoqueAgora().catch((err) => {
    console.error('[wik-sync] falha na sincronização oportunista:', err.message);
  });
}

// Busca o saldo completo do Wik (mesma chamada cara de sempre — a API não
// filtra saldo_estoque_get por referência) e filtra só o que bate com as
// referências pedidas, SEM aplicar nada — usado tanto pra montar a lista de
// conferência ANTES/DEPOIS quanto, depois de confirmado, como primeiro passo
// de sincronizarReferenciasAgora.
async function previewReferencias(referencias) {
  const alvo = new Set((referencias || []).map((r) => String(r).trim()).filter(Boolean));
  if (alvo.size === 0) return { criar: [], atualizar: [], erros: [] };

  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) throw new Error('Nenhuma credencial do Wik ativa.');

  const porEmpId = await empIdsConfigurados();
  if (porEmpId.size === 0) throw new Error('Nenhuma marca com Id de Empresa do Wik configurado (em Listas > Marcas).');

  const preview = await montarPreviewEstoque(integracao, porEmpId);
  return {
    criar: preview.criar.filter((item) => alvo.has(item.referencia)),
    atualizar: preview.atualizar.filter((item) => alvo.has(item.referencia)),
    erros: preview.erros.filter((e) => alvo.has(e.dados?.referencia)),
  };
}

// Sincroniza o saldo de só as referências pedidas, sem esperar o ciclo
// automático inteiro (que cobre TODO o catálogo) — dá pra forçar uma
// atualização pontual sem esperar, ou aplicar uma reconciliação manual já
// conferida (ver previewReferencias, chamado antes disso pra montar a lista
// ANTES/DEPOIS que o usuário aprova).
async function sincronizarReferenciasAgora(referencias, motivo) {
  const { criar, atualizar, erros } = await previewReferencias(referencias);
  const referenciasEncontradas = [...new Set([...criar, ...atualizar].map((i) => i.referencia))];
  const aplicado = await aplicarSincronizacaoEstoque({ criar, atualizar }, motivo);
  return { ...aplicado, erros: erros.length, referenciasEncontradas, criar, atualizar };
}

// "conectado" (existe uma string de token gravada) NÃO significa que ele
// ainda funciona — a validade real de um token do lado do Wik pode acabar
// (ou o acesso de DADOS da conta pode ser revogado, mesmo com login
// funcionando — ver incidente de 17/08/2026 em INTEGRACAO-WIK.md) antes do
// que o relógio local (token_expira_em) enxerga. statusToken reflete o
// resultado da ÚLTIMA CHAMADA DE DADO de verdade (estoque, produtos, ficha
// de custo — não "Testar conexão", que é só um login e por isso NUNCA
// escreve em ultima_tentativa/ultimo_erro/ultima_rejeicao_token, ver rota
// /testar em wik.routes.js): 'nao_testado' (nenhuma chamada de dado ainda),
// 'rejeitado' (ultimo_erro atual é especificamente uma rejeição de token
// pelo Wik), 'erro_outro' (falhou por outro motivo — rede, marca não
// configurada etc.) ou 'valido'. Compartilhada entre wik.routes.js
// (Integrações) e estoque.routes.js (banner de Estoque) — as duas telas
// precisam concordar sobre o mesmo estado.
function calcularStatusToken(row) {
  if (!row.ultima_tentativa) return 'nao_testado';
  if (row.ultimo_erro) return row.ultima_rejeicao_token ? 'rejeitado' : 'erro_outro';
  return 'valido';
}

// Se um job de importação (estoque/produtos/ficha de custo) ficou "rodando"
// travado além do próprio limiar que usamos pra permitir uma NOVA tentativa
// começar (ver jobTravado em cada sincronizarXAgora e nas rotas de preview),
// o status nunca se corrigia sozinho na TELA — ficava em "rodando" por horas
// até alguém clicar de novo (visto em produção: ficha de custo presa por
// mais de 40min). Corrige na hora de LER o status: se já passou do limiar e
// ninguém atualizou, marca como erro com uma mensagem clara em vez de
// deixar a mentira "ainda rodando" na tela.
const TIMEOUT_JOB_ESTOQUE_MS = 10 * 60 * 1000;
const TIMEOUT_JOB_CATALOGO_MS = 30 * 60 * 1000;

async function corrigirJobsPresos(integracao) {
  const checks = [
    { statusCol: 'preview_status', iniciadoCol: 'preview_iniciado_em', erroCol: 'preview_erro', limiteMs: TIMEOUT_JOB_ESTOQUE_MS, nome: 'sincronização de estoque' },
    { statusCol: 'produtos_import_status', iniciadoCol: 'produtos_import_iniciado_em', erroCol: 'produtos_import_erro', limiteMs: TIMEOUT_JOB_CATALOGO_MS, nome: 'importação de produtos' },
    { statusCol: 'ficha_custo_import_status', iniciadoCol: 'ficha_custo_import_iniciado_em', erroCol: 'ficha_custo_import_erro', limiteMs: TIMEOUT_JOB_CATALOGO_MS, nome: 'importação de ficha de custo' },
  ];
  for (const c of checks) {
    if (integracao[c.statusCol] !== 'rodando' || !integracao[c.iniciadoCol]) continue;
    const decorrido = Date.now() - new Date(integracao[c.iniciadoCol]).getTime();
    if (decorrido <= c.limiteMs) continue;
    const mensagem = `A ${c.nome} ficou travada em "rodando" por mais de ${Math.round(c.limiteMs / 60000)} min sem `
      + 'terminar (o processo provavelmente reiniciou no meio) — marcada como erro automaticamente.';
    // Nomes de coluna vêm de `checks` acima (constante fixa no código, nunca
    // de entrada do usuário) — seguro interpolar no SQL.
    await pool.query(
      `UPDATE integracoes_wik SET ${c.statusCol} = 'erro', ${c.erroCol} = $1, atualizado_em = now() WHERE id = $2`,
      [mensagem, integracao.id]
    );
    integracao[c.statusCol] = 'erro';
    integracao[c.erroCol] = mensagem;
  }
}

module.exports = {
  buscarIntegracao,
  obterTokenValido,
  empIdsConfigurados,
  montarPreviewEstoque,
  aplicarSincronizacaoEstoque,
  sincronizarEstoqueAgora,
  sincronizarEstoqueSeNecessario,
  previewReferencias,
  sincronizarReferenciasAgora,
  registrarTentativaWik,
  registrarFalhaWik,
  registrarSucessoWik,
  criarOpcoesTokenComLimite,
  cicloDevePular,
  emModoDegradado,
  calcularStatusToken,
  corrigirJobsPresos,
};
