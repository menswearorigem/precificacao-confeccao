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

// ---------- trava global anti-múltiplos-acessos (27/08/2026) ----------
// CRÍTICO: a conta foi bloqueada pelo suporte do Wik por "múltiplos acessos
// com o mesmo token", e minutos depois de desbloqueada os 3 jobs (estoque,
// produtos, ficha de custo) voltaram a rodar ao mesmo tempo — o que teria
// causado o MESMO bloqueio de novo. Complementa a fila serial de rede em
// wik.js (que garante nenhuma requisição sobreposta) com uma trava no nível
// do JOB: NENHUMA rotina que toca a API do Wik (os 3 ciclos automáticos, os
// botões manuais equivalentes, "sincronizar referências", os dois botões de
// teste e o diagnóstico de ficha técnica) começa a trabalhar de verdade sem
// reservar essa trava primeiro — se outra já estiver rodando, desiste na
// hora com uma mensagem clara em vez de competir por acesso.
//
// Implementado como um UPDATE...WHERE atômico direto no Postgres (não só em
// memória) — o WHERE só casa se a trava estiver livre (`wik_job_ativo IS
// NULL`) OU presa há mais de TIMEOUT_TRAVA_GLOBAL_MS (processo reiniciado
// no meio de um job, sem ninguém pra liberar). Isso funciona corretamente
// mesmo sob concorrência de verdade: o Postgres serializa UPDATEs na MESMA
// linha, então de duas reservas simultâneas só uma pode ver a trava livre e
// gravar seu nome — a outra reavalia o WHERE depois que a primeira já
// commitou e não bate mais.
const TIMEOUT_TRAVA_GLOBAL_MS = 30 * 60 * 1000;

async function reservarJobWik(integracaoId, nomeJob) {
  const { rows } = await pool.query(
    `UPDATE integracoes_wik SET wik_job_ativo = $1, wik_job_ativo_desde = now()
     WHERE id = $2 AND (wik_job_ativo IS NULL OR wik_job_ativo_desde < now() - ($3 * interval '1 millisecond'))
     RETURNING wik_job_ativo`,
    [nomeJob, integracaoId, TIMEOUT_TRAVA_GLOBAL_MS]
  );
  return rows.length > 0;
}

async function liberarJobWik(integracaoId) {
  await pool.query('UPDATE integracoes_wik SET wik_job_ativo = NULL, wik_job_ativo_desde = NULL WHERE id = $1', [integracaoId]);
}

async function jobAtivoNoMomento(integracaoId) {
  const { rows } = await pool.query('SELECT wik_job_ativo FROM integracoes_wik WHERE id = $1', [integracaoId]);
  return rows[0]?.wik_job_ativo || null;
}

// Mensagem padrão de recusa quando a trava global já está com outro job —
// usada por todo entry point que toca a API do Wik (ver comentário acima).
async function mensagemJobOcupado(integracaoId) {
  const ativo = await jobAtivoNoMomento(integracaoId);
  return `Outro job do Wik (${ativo || 'desconhecido'}) está rodando agora — aguarde terminar antes de tentar de novo `
    + '(trava global anti-múltiplos-acessos: rodar 2+ ao mesmo tempo foi o que derrubou o acesso da conta em 17/08/2026).';
}

// ---------- token único, renovado só por AGENDA (27/08/2026) ----------
// Ligação com o suporte técnico do Wik confirmou a causa do bloqueio de
// conta de 17/08: "Se você ficar abrindo muito o login e ficar tentando
// usar simultaneamente, a gente vai travar o usuário" / "A aplicação
// bloqueia. Ela está tentando algum tipo de ataque, por tentativa de login
// usar token que não está ativo." Ou seja: relogar/retentar em REAÇÃO a um
// 401/403 (o que uma rodada anterior desta integração fazia) é exatamente
// o padrão que derruba a conta — não existe mais isso no código. A
// disciplina correta, ditada pelo suporte:
//   1. Logar UMA vez, guardar o token — nunca por operação, nunca por falha.
//   2. Renovar por AGENDA: a cada 2h (token dura até 4h), ou quando faltar
//      30min pra `expiracao` — nunca em reação a erro (ver
//      renovarTokenWikSeNecessario abaixo, chamado por um timer em
//      index.js, não por nenhum caminho de erro).
//   3. Troca ATÔMICA: "se muitas consultas tentarem usar o token antigo, vai
//      travar esse usuário" — por isso existe UM SÓ tokenBox no processo
//      inteiro (tokenBoxGlobal abaixo); nenhuma função guarda cópia própria.
//      Quando a agenda troca o token, a troca fica visível pra TODO MUNDO
//      na mesma hora, porque todo mundo segura a MESMA referência de objeto.
//   4. Ao ver 401/403 de token: registra e para (ver chamarApi em wik.js) —
//      não relogar, não retentar, esperar a próxima agenda ou intervenção
//      humana (o clique em "Testar conexão" depois de resolver com o
//      suporte do Wik).
const tokenBoxGlobal = wik.criarTokenBox(null);

const INTERVALO_MAXIMO_RENOVACAO_MS = 2 * 60 * 60 * 1000; // agenda normal: 2h (token dura até 4h)
const MARGEM_ANTECIPADA_RENOVACAO_MS = 30 * 60 * 1000; // renova mais cedo se faltar isso pra expiracao

// Login de verdade + troca atômica em memória e banco. Chamado só pela
// agenda (renovarTokenWikSeNecessario) ou por uma ação HUMANA explícita
// ("Testar conexão"/"Testar conexão completa" em wik.routes.js) — um clique
// deliberado da usuária não é reação a erro, é intervenção humana, sempre
// permitida pela regra do suporte.
async function renovarTokenAgora(integracao) {
  const resultado = await wik.login(integracao.email, integracao.senha);
  tokenBoxGlobal.atual = resultado.token; // visível pra TODOS os consumidores na mesma hora
  await pool.query(
    `UPDATE integracoes_wik SET access_token = $1, token_expira_em = $2, token_renovado_em = now(),
                                 ultima_expiracao_suspeita = $3, atualizado_em = now() WHERE id = $4`,
    [resultado.token, resultado.expiraEm, resultado.expiracaoSuspeita ? new Date() : null, integracao.id]
  );
  integracao.access_token = resultado.token;
  integracao.token_expira_em = resultado.expiraEm;
  integracao.token_renovado_em = new Date();
  return resultado;
}

// Chamado por um timer periódico (ver index.js) — decide, só por AGENDA
// (nunca por erro), se é hora de renovar: sem token nenhum ainda, mais de
// 2h desde a última renovação, ou menos de 30min pra expiracao.
async function renovarTokenWikSeNecessario() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return;

  const agora = Date.now();
  const renovadoEm = integracao.token_renovado_em ? new Date(integracao.token_renovado_em).getTime() : 0;
  const expiraEm = integracao.token_expira_em ? new Date(integracao.token_expira_em).getTime() : 0;

  const semToken = !integracao.access_token;
  const passouDaAgenda = !renovadoEm || (agora - renovadoEm) >= INTERVALO_MAXIMO_RENOVACAO_MS;
  const expirandoLogo = expiraEm > 0 && (expiraEm - agora) <= MARGEM_ANTECIPADA_RENOVACAO_MS;
  if (!(semToken || passouDaAgenda || expirandoLogo)) {
    if (integracao.access_token) tokenBoxGlobal.atual = integracao.access_token; // sincroniza a memória após um restart do processo
    return;
  }

  try {
    await renovarTokenAgora(integracao);
    console.log('[wik-token] renovado por agenda.');
  } catch (err) {
    // Login em si falhando (credencial errada, Wik fora do ar) é diferente
    // de uma rejeição de DADO — registra, mas a PRÓXIMA tentativa só
    // acontece na próxima agenda, nunca antes por reação a essa falha.
    await registrarFalhaWik(integracao.id, err);
    console.error('[wik-token] falha ao renovar por agenda:', err.message);
  }
}

// Devolve o tokenBox ÚNICO e compartilhado, garantindo que ele tenha algum
// valor: carrega do banco se já existir um token gravado (ex.: logo após um
// restart do processo), ou faz UM login se realmente não houver nada em
// lugar nenhum ainda (bootstrap inevitável do sistema — não é "reação a
// erro", é a inicialização). Usado por toda função que precisa fazer uma
// chamada de dado ao Wik (nenhuma cria mais o próprio tokenBox).
async function obterTokenBoxAtual(integracao) {
  if (!tokenBoxGlobal.atual && integracao.access_token) {
    tokenBoxGlobal.atual = integracao.access_token;
  }
  if (!tokenBoxGlobal.atual) {
    await renovarTokenAgora(integracao);
  }
  return tokenBoxGlobal;
}

// Chamado quando a credencial é trocada na tela (POST /wik) — o token em
// memória é da credencial ANTIGA, então precisa ser esquecido junto com o
// que foi limpo no banco. Sem isso, obterTokenBoxAtual acharia que já tem
// um token válido (o antigo, ainda em memória) e seguiria usando a
// credencial errada até a próxima renovação por agenda.
function esquecerTokenEmMemoria() {
  tokenBoxGlobal.atual = null;
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
// última mensagem — mais robusto do que confiar só no texto (que pode variar
// entre "inválido", "expirado" etc.). O parâmetro pode ser um Error (com ou
// sem `causaWikToken`) ou uma string solta (chamadas antigas/diretas) — nesse
// caso cai no casamento de texto como fallback.
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

// Modo degradado: quando o Wik rejeita o token 5x SEGUIDAS. Insistir com o
// ciclo automático completo a cada 15min nessas condições só gera tráfego
// inútil (chegou a 224 rejeições em 24h, uma a cada ~6min) — a partir do
// limiar, os ciclos automáticos passam a tentar 1x/hora em vez do ritmo
// normal (ver cicloDevePular abaixo). Não tem mais nenhuma ligação com
// relogin — não existe relogin reativo neste código (ver bloco de token
// acima). Volta ao normal sozinho na primeira chamada de dado bem-sucedida
// (registrarSucessoWik zera o contador) ou quando a credencial é salva de
// novo na tela.
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

// Opções passadas pra toda chamada da API do Wik (ver chamarApi em wik.js)
// — hoje só `aoDetectarTokenMorto`, que REGISTRA a rejeição (contagem de
// 24h, modo degradado) e nada mais. Não existe mais `renovarToken` aqui:
// rodada anterior desta integração relogava/retentava em reação a um
// 401/403, e o suporte técnico do Wik confirmou que é EXATAMENTE esse
// padrão que derruba a conta — foi removido por completo (ver bloco de
// token único/agenda, no topo do arquivo).
function criarOpcoesToken(integracao) {
  return {
    aoDetectarTokenMorto: () => registrarFalhaWik(integracao.id, 'Token rejeitado pelo Wik ("token inválido ou expirado").'),
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
  const tokenBox = await obterTokenBoxAtual(integracao);
  const opcoesToken = criarOpcoesToken(integracao);

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

  // Trava global ANTES de qualquer mutação de estado — se outro job do Wik
  // já está rodando (produtos, ficha de custo, um teste manual etc.), desiste
  // aqui sem marcar preview_status como 'rodando' (ver comentário na trava,
  // no topo do arquivo).
  if (!(await reservarJobWik(integracao.id, 'estoque'))) {
    return { pulado: await mensagemJobOcupado(integracao.id) };
  }

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
  } finally {
    await liberarJobWik(integracao.id);
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

  if (!(await reservarJobWik(integracao.id, 'referencias-especificas'))) {
    throw new Error(await mensagemJobOcupado(integracao.id));
  }
  try {
    const preview = await montarPreviewEstoque(integracao, porEmpId);
    return {
      criar: preview.criar.filter((item) => alvo.has(item.referencia)),
      atualizar: preview.atualizar.filter((item) => alvo.has(item.referencia)),
      erros: preview.erros.filter((e) => alvo.has(e.dados?.referencia)),
    };
  } finally {
    await liberarJobWik(integracao.id);
  }
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
  obterTokenBoxAtual,
  renovarTokenAgora,
  renovarTokenWikSeNecessario,
  esquecerTokenEmMemoria,
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
  criarOpcoesToken,
  cicloDevePular,
  emModoDegradado,
  calcularStatusToken,
  corrigirJobsPresos,
  reservarJobWik,
  liberarJobWik,
  mensagemJobOcupado,
};
