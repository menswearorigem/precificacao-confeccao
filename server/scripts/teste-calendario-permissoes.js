/*
 * Teste do Calendário depois das correções de 04/09/2026.
 *
 * Roda contra um Postgres LIMPO, como os outros scripts do repositório:
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-calendario-permissoes.js
 *
 * Sobe o app de verdade numa porta livre e conversa com ele por HTTP.
 *
 * Cobre exatamente o que foi mexido:
 *   1. "Quem vê / quem edita" funcionando de verdade — inclusive o buraco
 *      que fazia parecer enfeite: responsável que não enxergava o evento.
 *   2. O filtro de escopo (Todos / Meus / Onde sou responsável / Criados por
 *      mim), que é o que deixa o administrador tirar da frente o calendário
 *      dos outros.
 *   3. Rascunho de evento: guardar ao sair sem terminar, retomar depois,
 *      substituir e apagar. O prazo de 1 semana é conferido mexendo na
 *      coluna expira_em direto no banco.
 *   4. Filtro por período (o que faz o Kanban parar de acumular evento de
 *      todos os meses e a Lista poder ser filtrada por data).
 *   5. O módulo "calendario" ser concedível pela tela de Acessos.
 *   6. O leitor de Ordem de Produção — inclusive o que ele NÃO preenche.
 */

require('dotenv').config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'liberacao-de-teste-123';

const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { lerOrdemDeProducao } = require('../src/lib/ordemProducaoParser');

let passou = 0;
let falhou = 0;
const falhas = [];

function ok(titulo, condicao, detalhe) {
  if (condicao) {
    passou += 1;
    console.log(`  ✓ ${titulo}`);
  } else {
    falhou += 1;
    falhas.push(titulo + (detalhe ? ` — ${detalhe}` : ''));
    console.log(`  ✗ ${titulo}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

function secao(nome) {
  console.log(`\n${nome}`);
}

const SENHA = 'trigo azul de setembro';
const HOJE = new Date().toISOString().slice(0, 10);

function emDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const app = createApp();
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const porta = servidor.address().port;
  const base = `http://127.0.0.1:${porta}`;
  const origem = `http://127.0.0.1:${porta}`;

  // Cada "sessão" guarda o próprio cookie, pra poder ter três pessoas
  // logadas ao mesmo tempo no teste.
  function novaSessao() {
    const estado = { cookie: '' };
    return async function chamar(caminho, { metodo = 'GET', corpo } = {}) {
      const headers = { 'Content-Type': 'application/json', Origin: origem };
      if (estado.cookie) headers.Cookie = estado.cookie;
      const res = await fetch(base + caminho, {
        method: metodo,
        headers,
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
      const set = res.headers.get('set-cookie');
      if (set) estado.cookie = set.split(';')[0];
      let dados = null;
      try { dados = await res.json(); } catch { /* sem corpo */ }
      return { status: res.status, dados };
    };
  }

  const admin = novaSessao();
  const gerente = novaSessao();
  const costureira = novaSessao();

  try {
    // -----------------------------------------------------------------
    secao('1. Contas e módulo do Calendário');
    // -----------------------------------------------------------------
    const setup = await admin('/api/auth/setup', {
      metodo: 'POST',
      corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Ana', email: 'ana@teste.com', senha: SENHA },
    });
    ok('primeira conta criada como administradora', setup.status === 201 && setup.dados.role === 'admin');

    // O módulo "calendario" precisa ser aceito pelo backend — era ele que a
    // tela de Acessos não oferecia (só faltava a linha na lista do front).
    const criaGerente = await admin('/api/usuarios', {
      metodo: 'POST',
      corpo: { nome: 'Bruno', email: 'bruno@teste.com', senha: SENHA, role: 'limitado', modulos: ['calendario'] },
    });
    ok('usuário limitado pode receber o módulo "calendario"',
      criaGerente.status === 201 && criaGerente.dados.modulos.includes('calendario'),
      JSON.stringify(criaGerente.dados));

    const criaCostureira = await admin('/api/usuarios', {
      metodo: 'POST',
      corpo: { nome: 'Carla', email: 'carla@teste.com', senha: SENHA, role: 'limitado', modulos: ['calendario'] },
    });
    ok('segunda conta limitada criada', criaCostureira.status === 201);

    ok('login do Bruno', (await gerente('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Bruno', senha: SENHA } })).status === 200);
    ok('login da Carla', (await costureira('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Carla', senha: SENHA } })).status === 200);

    const idBruno = criaGerente.dados.id;
    const idCarla = criaCostureira.dados.id;

    // -----------------------------------------------------------------
    secao('2. Editar dados de usuário (antes só dava pra excluir e recriar)');
    // -----------------------------------------------------------------
    const renomeia = await admin(`/api/usuarios/${idCarla}`, {
      metodo: 'PUT',
      corpo: { nome: 'Carla Souza', email: 'carla.souza@teste.com' },
    });
    ok('nome e e-mail do usuário podem ser alterados',
      renomeia.status === 200 && renomeia.dados.nome === 'Carla Souza' && renomeia.dados.email === 'carla.souza@teste.com',
      JSON.stringify(renomeia.dados));
    // Trocar o nome derruba a sessão? Não: só role/ativo/modulos derrubam.
    // Mas o login novo precisa funcionar com o nome novo.
    const loginNomeNovo = novaSessao();
    ok('login passa a valer com o nome novo',
      (await loginNomeNovo('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Carla Souza', senha: SENHA } })).status === 200);

    // -----------------------------------------------------------------
    secao('3. "Quem vê / quem edita" — a liberação valendo de verdade');
    // -----------------------------------------------------------------
    const privado = await gerente('/api/calendario/eventos', {
      metodo: 'POST',
      corpo: { titulo: 'Corte só do Bruno', data_prevista_fim: emDias(5) },
    });
    ok('evento criado pelo Bruno', privado.status === 201);

    const listaCarla = await costureira('/api/calendario/eventos');
    ok('Carla NÃO enxerga evento que não foi liberado pra ela',
      listaCarla.status === 200 && !listaCarla.dados.some((e) => e.id === privado.dados.id));

    const buscaDireta = await costureira(`/api/calendario/eventos/${privado.dados.id}`);
    ok('acesso direto pela URL também é barrado (404, não 403)', buscaDireta.status === 404);

    // AQUI está a correção principal: responsável passa a enxergar.
    const comResponsavel = await gerente('/api/calendario/eventos', {
      metodo: 'POST',
      corpo: { titulo: 'Corte da Carla', data_prevista_fim: emDias(6), responsaveis_ids: [idCarla] },
    });
    const listaCarla2 = await costureira('/api/calendario/eventos');
    const eventoDaCarla = listaCarla2.dados.find((e) => e.id === comResponsavel.dados.id);
    ok('quem é RESPONSÁVEL enxerga o evento (correção de 04/09/2026)', Boolean(eventoDaCarla));
    ok('mas responsável sozinho NÃO ganha permissão de editar', eventoDaCarla && eventoDaCarla.podeEditar === false,
      eventoDaCarla ? `podeEditar=${eventoDaCarla.podeEditar}` : 'evento não veio');

    const tentaEditar = await costureira(`/api/calendario/eventos/${comResponsavel.dados.id}`, {
      metodo: 'PUT',
      corpo: { titulo: 'mudei na marra' },
    });
    ok('e o PUT recusa mesmo assim', tentaEditar.status === 404);

    const comEdicao = await gerente('/api/calendario/eventos', {
      metodo: 'POST',
      corpo: {
        titulo: 'Meta compartilhada',
        data_prevista_fim: emDias(7),
        permissoes: [{ usuario_id: idCarla, nivel: 'editar' }],
      },
    });
    const listaCarla3 = await costureira('/api/calendario/eventos');
    const compartilhado = listaCarla3.dados.find((e) => e.id === comEdicao.dados.id);
    ok('liberação com nível "editar" dá acesso de edição', compartilhado && compartilhado.podeEditar === true);
    ok('o evento diz com quem está compartilhado (some o "isso é só cosmético")',
      compartilhado && Array.isArray(compartilhado.compartilhadoCom) && compartilhado.compartilhadoCom.length === 1
        && compartilhado.compartilhadoCom[0].nivel === 'editar',
      JSON.stringify(compartilhado?.compartilhadoCom));
    ok('agora o PUT aceita',
      (await costureira(`/api/calendario/eventos/${comEdicao.dados.id}`, { metodo: 'PUT', corpo: { titulo: 'Meta compartilhada (revisada)' } })).status === 200);

    // -----------------------------------------------------------------
    secao('4. Filtro de escopo — o administrador conseguindo se achar');
    // -----------------------------------------------------------------
    const doAdmin = await admin('/api/calendario/eventos', {
      metodo: 'POST',
      corpo: { titulo: 'Evento da Ana', data_prevista_fim: emDias(3), responsaveis_ids: [idBruno] },
    });
    ok('evento criado pela administradora', doAdmin.status === 201);

    const todos = await admin('/api/calendario/eventos');
    ok('sem escopo, o administrador vê o calendário inteiro (comportamento antigo, preservado)',
      todos.dados.length === 4, `veio ${todos.dados.length}`);

    const meus = await admin('/api/calendario/eventos?escopo=meus');
    ok('escopo=meus mostra só o que é dela', meus.dados.length === 1 && meus.dados[0].id === doAdmin.dados.id,
      `veio ${meus.dados.length}`);

    const criados = await admin('/api/calendario/eventos?escopo=criados_por_mim');
    ok('escopo=criados_por_mim idem', criados.dados.length === 1 && criados.dados[0].id === doAdmin.dados.id);

    const souResponsavel = await gerente('/api/calendario/eventos?escopo=responsavel');
    ok('escopo=responsavel devolve só onde a pessoa é responsável',
      souResponsavel.dados.length === 1 && souResponsavel.dados[0].id === doAdmin.dados.id,
      `veio ${souResponsavel.dados.length}`);

    const escopoNaoBurlaPermissao = await costureira('/api/calendario/eventos?escopo=');
    ok('escopo NÃO fura permissão: Carla continua sem ver o evento privado do Bruno',
      !escopoNaoBurlaPermissao.dados.some((e) => e.id === privado.dados.id));

    // -----------------------------------------------------------------
    secao('5. Filtro por período (Kanban por mês, Lista por data)');
    // -----------------------------------------------------------------
    await gerente('/api/calendario/eventos', {
      metodo: 'POST',
      corpo: { titulo: 'Corte do ano que vem', data_prevista_fim: emDias(200) },
    });
    const semPeriodo = await gerente('/api/calendario/eventos');
    const comPeriodo = await gerente(`/api/calendario/eventos?data_inicio=${HOJE}&data_fim=${emDias(30)}`);
    ok('sem período vem tudo', semPeriodo.dados.length > comPeriodo.dados.length);
    ok('com período, o evento de daqui a 200 dias fica de fora',
      !comPeriodo.dados.some((e) => e.titulo === 'Corte do ano que vem'));

    // -----------------------------------------------------------------
    secao('6. Rascunho: sair sem terminar e retomar');
    // -----------------------------------------------------------------
    const dataRascunho = emDias(12);
    const vazio = await gerente(`/api/calendario/rascunhos/${dataRascunho}`);
    ok('data sem rascunho responde "não existe"', vazio.status === 200 && vazio.dados.existe === false);

    const guardar = await gerente(`/api/calendario/rascunhos/${dataRascunho}`, {
      metodo: 'PUT',
      corpo: { dados: { titulo: 'Corte pela metade', data_prevista_fim: dataRascunho, grade: [{ cor: 'PRETO', tamanho: 'M', quantidade: 20 }] } },
    });
    ok('rascunho é guardado', guardar.status === 200 && Boolean(guardar.dados.id));

    const retomar = await gerente(`/api/calendario/rascunhos/${dataRascunho}`);
    ok('rascunho volta inteiro',
      retomar.dados.existe === true && retomar.dados.dados.titulo === 'Corte pela metade'
      && retomar.dados.dados.grade[0].cor === 'PRETO');

    const daCarla = await costureira(`/api/calendario/rascunhos/${dataRascunho}`);
    ok('rascunho é de quem escreveu — outra pessoa não vê', daCarla.dados.existe === false);

    await gerente(`/api/calendario/rascunhos/${dataRascunho}`, {
      metodo: 'PUT',
      corpo: { dados: { titulo: 'Corte pela metade v2' } },
    });
    const substituido = await gerente(`/api/calendario/rascunhos/${dataRascunho}`);
    ok('salvar de novo SUBSTITUI (não empilha dois rascunhos da mesma data)',
      substituido.dados.dados.titulo === 'Corte pela metade v2');
    const quantos = await pool.query('SELECT COUNT(*)::int AS n FROM calendario_eventos_rascunho');
    ok('e continua existindo só um', quantos.rows[0].n === 1, `tem ${quantos.rows[0].n}`);

    // O prazo de 1 semana: envelhece a linha na marra e confere que ela some.
    await pool.query("UPDATE calendario_eventos_rascunho SET expira_em = now() - INTERVAL '1 day'");
    const vencido = await gerente(`/api/calendario/rascunhos/${dataRascunho}`);
    ok('rascunho com mais de 1 semana não é mais retomável', vencido.dados.existe === false);
    const sobrou = await pool.query('SELECT COUNT(*)::int AS n FROM calendario_eventos_rascunho');
    ok('e sai do banco na primeira leitura (limpeza preguiçosa)', sobrou.rows[0].n === 0);

    // Salvar o evento de verdade tira o rascunho do caminho.
    await gerente(`/api/calendario/rascunhos/${dataRascunho}`, { metodo: 'PUT', corpo: { dados: { titulo: 'x' } } });
    await gerente(`/api/calendario/rascunhos/${dataRascunho}`, { metodo: 'DELETE' });
    const apagado = await gerente(`/api/calendario/rascunhos/${dataRascunho}`);
    ok('rascunho pode ser apagado (é o que o front faz ao salvar o evento)', apagado.dados.existe === false);

    const dataInvalida = await gerente('/api/calendario/rascunhos/30-12-2026');
    ok('data em formato errado é recusada', dataInvalida.status === 400);

    // -----------------------------------------------------------------
    secao('7. Leitor de Ordem de Produção');
    // -----------------------------------------------------------------
    const cadastro = {
      produtos: [{ id: 1, referencia: 'OG1620', descricao: 'Camiseta' }],
      fornecedores: [{ id: 1, nome: 'MALHARIA SÃO JOSÉ LTDA', nome_fantasia: 'Malharia São José' }],
      tamanhos: ['P', 'M', 'G', 'GG'],
    };
    const csvMatriz = [
      'ORDEM DE PRODUCAO: 7032',
      'Referencia;OG 1620;Fornecedor;Malharia São José',
      'Tecido: MOLETOM PELUCIA',
      'COR;P;M;G;GG',
      'PRETO;10;20;15;5',
    ].join('\n');
    const lido = await lerOrdemDeProducao(Buffer.from(csvMatriz, 'utf8'), 'op.csv', 'text/csv', cadastro);
    ok('lê o número da OP', lido.encontrado.numero_op === '7032');
    ok('casa a referência mesmo escrita com espaço ("OG 1620")', lido.encontrado.produto?.id === 1);
    ok('casa o fornecedor mesmo com acento diferente', lido.encontrado.fornecedor?.id === 1);
    ok('monta a grade de cor x tamanho', lido.grade.length === 4 && lido.grade[0].cor === 'PRETO');
    ok('soma a quantidade a partir da grade', lido.encontrado.quantidade === 50);
    ok('marca a origem como wiki_op (estrutura que a 0038 já reservou)', lido.grade.every((l) => l.origem === 'wiki_op'));
    ok('não sobra aviso quando achou tudo', lido.avisos.length === 0, JSON.stringify(lido.avisos));

    const semNada = await lerOrdemDeProducao(Buffer.from('arquivo qualquer\nsem nada útil', 'utf8'), 'x.txt', 'text/plain', cadastro);
    ok('arquivo irreconhecível NÃO chuta produto (REGRA 2)', semNada.encontrado.produto === null);
    ok('arquivo irreconhecível NÃO chuta fornecedor', semNada.encontrado.fornecedor === null);
    ok('e explica em português o que faltou', semNada.avisos.length === 3);

    const divergente = [
      'OP 7099',
      'Referencia;OG1620',
      'Quantidade total;999',
      'Cor;Tamanho;Qtd',
      'PRETO;P;10',
    ].join('\n');
    const comDivergencia = await lerOrdemDeProducao(Buffer.from(divergente, 'utf8'), 'op.csv', 'text/csv', cadastro);
    ok('avisa quando o total escrito na OP não bate com a soma da grade',
      comDivergencia.avisos.some((a) => a.includes('diferente da soma da grade')));
    ok('e usa a soma da grade, não o total escrito', comDivergencia.encontrado.quantidade === 10);

    // -----------------------------------------------------------------
    secao('8. Regressão: o que já funcionava continua funcionando');
    // -----------------------------------------------------------------
    const resumo = await gerente('/api/calendario/resumo');
    ok('o painel de resumo responde', resumo.status === 200 && typeof resumo.dados.atrasados === 'number');
    const notificacoes = await gerente('/api/calendario/notificacoes');
    ok('o sino de notificações responde', notificacoes.status === 200 && Array.isArray(notificacoes.dados.itens));
    const templates = await gerente('/api/calendario/templates');
    ok('os dois modelos de fábrica continuam lá',
      templates.dados.some((t) => t.nome === 'Previsão de chegada de corte') && templates.dados.some((t) => t.nome === 'Meta'));
    const semModulo = novaSessao();
    await admin('/api/usuarios', {
      metodo: 'POST',
      corpo: { nome: 'Davi', email: 'davi@teste.com', senha: SENHA, role: 'limitado', modulos: ['estoque'] },
    });
    await semModulo('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Davi', senha: SENHA } });
    ok('quem não tem o módulo continua barrado no Calendário',
      (await semModulo('/api/calendario/eventos')).status === 403);
  } finally {
    servidor.close();
    await pool.end();
  }

  console.log(`\n${passou} passaram, ${falhou} falharam.`);
  if (falhou > 0) {
    console.log('\nFalhas:');
    for (const f of falhas) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
