/*
 * Rotinas (15/10/2026) — tarefas que os administradores passam para a equipe.
 *
 * Roda contra um Postgres LIMPO (o runner cria um banco por suíte):
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-rotinas-2026-10-15.js
 *
 * Cobre os critérios de aceite do pedido:
 *   1. Recorrência: diária útil, dias da semana, semanal a cada N, mensal no
 *      último dia útil, feriado pulado (nacional, Sexta Santa, Goiânia).
 *   2. Geração idempotente: "cada um" × "qualquer um", rodar duas vezes não
 *      duplica, e quem pega a compartilhada não abre outra vaga.
 *   3. Lista automática resolve na geração e NÃO muda depois.
 *   4. Concluir bloqueado com obrigatório faltando; foto "só se der
 *      problema" exigida exatamente quando há problema; comparação com o
 *      estoque do sistema.
 *   5. Conferir depois → aguardando; Devolver volta com comentário; Aprovar.
 *   6. Funcionário sem administrador: 403 em Equipe e Modelos; tarefa de
 *      outra pessoa: 403; sem o módulo: 403 em tudo.
 *   7. Foto: tamanho limitado, cache imutável, miniatura separada.
 *   8. Correção automática, "não consegui fazer", editar o modelo não mexe
 *      na ocorrência já gerada, HTML sanitizado, Início e avisos.
 */

require('dotenv').config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'liberacao-de-teste-123';

const createApp = require('../src/app');
const pool = require('../src/db/pool');
const rec = require('../src/lib/rotinasRecorrencia');
const rot = require('../src/lib/rotinas');
const { hojeEmBrasilia } = require('../src/lib/dataBrasil');

let passou = 0;
let falhou = 0;
const falhas = [];
function ok(titulo, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✓ ${titulo}`); } else {
    falhou += 1; falhas.push(titulo + (detalhe ? ` — ${detalhe}` : ''));
    console.log(`  ✗ ${titulo}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}
function secao(nome) { console.log(`\n${nome}`); }

const SENHA = 'trigo azul de setembro';
const HOJE = hojeEmBrasilia();

// Bytes mínimos que passam na conferência de "é WebP de verdade".
function webpFalso(tamanho = 2000) {
  const b = Buffer.alloc(tamanho, 7);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  return b;
}

async function main() {
  // ---------------------------------------------------------------------
  secao('1. Recorrência (puro)');
  // ---------------------------------------------------------------------
  ok('Páscoa 2026 = 05/04', rec.pascoa(2026) === '2026-04-05');
  ok('Sexta-feira Santa 2026 é feriado', rec.feriado('2026-04-03') === 'Sexta-feira Santa');
  ok('Corpus Christi 2026 (04/06) é feriado em Goiânia', /Corpus/.test(rec.feriado('2026-06-04') || ''));
  ok('24/10 é aniversário de Goiânia', /Goiânia/.test(rec.feriado('2026-10-24') || ''));
  const uteis = rec.normalizar({ tipo: 'dias_uteis' });
  ok('dia útil: quinta 15/10/2026 sim', rec.ocorreEm(uteis, '2026-10-15'));
  ok('dia útil: sábado 17/10 não', !rec.ocorreEm(uteis, '2026-10-17'));
  ok('dia útil: feriado 12/10 (segunda) não', !rec.ocorreEm(uteis, '2026-10-12'));
  ok('dia útil: Consciência Negra 20/11 não', !rec.ocorreEm(uteis, '2026-11-20'));
  const sqs = rec.normalizar({ tipo: 'dias_semana', dias: [1, 3, 5] });
  ok('Seg/Qua/Sex: quarta 14/10 sim, terça 13/10 não', rec.ocorreEm(sqs, '2026-10-14') && !rec.ocorreEm(sqs, '2026-10-13'));
  ok('Seg/Qua/Sex: segunda 12/10 (feriado) pulada', !rec.ocorreEm(sqs, '2026-10-12'));
  const sqsSemPular = rec.normalizar({ tipo: 'dias_semana', dias: [1], pularFeriados: false });
  ok('sem "pular feriado", 12/10 acontece', rec.ocorreEm(sqsSemPular, '2026-10-12'));
  const quinzenal = rec.normalizar({ tipo: 'semanal', dias: [2], intervalo: 2, inicio: '2026-10-05' });
  ok('a cada 2 semanas (ter): 06/10 sim, 13/10 não, 20/10 sim',
    rec.ocorreEm(quinzenal, '2026-10-06') && !rec.ocorreEm(quinzenal, '2026-10-13') && rec.ocorreEm(quinzenal, '2026-10-20'));
  ok('semanal antes do início não acontece', !rec.ocorreEm(quinzenal, '2026-09-29'));
  const ultimo = rec.normalizar({ tipo: 'mensal', modo: 'ultimo_util' });
  ok('último dia útil de out/2026 = 30/10 (31 é sábado)', rec.ocorreEm(ultimo, '2026-10-30') && !rec.ocorreEm(ultimo, '2026-10-31'));
  ok('último dia útil de dez/2026 = 31/12', rec.ocorreEm(ultimo, '2026-12-31'));
  const primeiro = rec.normalizar({ tipo: 'mensal', modo: 'primeiro_util' });
  ok('primeiro dia útil de jan/2027 = 04/01 (01 feriado, 02-03 fim de semana)', rec.proximas(primeiro, '2027-01-01', 1)[0] === '2027-01-04');
  const dia31 = rec.normalizar({ tipo: 'mensal', modo: 'dia', dia: 31, pularFeriados: false });
  ok('dia 31 em fevereiro cai no último dia (28/02/2027)', rec.ocorreEm(dia31, '2027-02-28'));
  const dia10 = rec.normalizar({ tipo: 'mensal', modo: 'dia', dia: 10 });
  ok('dia 10 num sábado (10/10/2026) passa para segunda 13/10? não — 12 é feriado, vai para 13/10',
    rec.ocorreEm(dia10, '2026-10-13') && !rec.ocorreEm(dia10, '2026-10-10'));
  const limitada = rec.normalizar({ tipo: 'dias_uteis', inicio: '2026-10-19', fim: '2026-10-21' });
  ok('início e fim limitam as datas', rec.proximas(limitada, '2026-10-01', 10).join() === '2026-10-19,2026-10-20,2026-10-21');
  let erro = null;
  try { rec.normalizar({ tipo: 'dias_semana', dias: [] }); } catch (e) { erro = e; }
  ok('dias da semana sem dia marcado é recusado com frase', erro && erro.regra && /Marque/.test(erro.message));
  ok('descrição de gente', rec.descrever(sqs) === 'Seg, Qua e Sex' && rec.descrever(ultimo) === 'Todo mês, no último dia útil');

  // ---------------------------------------------------------------------
  secao('2. Contas, módulo e produtos');
  // ---------------------------------------------------------------------
  const app = createApp();
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  function novaSessao() {
    const estado = { cookie: '' };
    return async function chamar(caminho, { metodo = 'GET', corpo, form } = {}) {
      const headers = { Origin: base };
      if (!form) headers['Content-Type'] = 'application/json';
      if (estado.cookie) headers.Cookie = estado.cookie;
      const res = await fetch(base + caminho, { method: metodo, headers, body: form || (corpo === undefined ? undefined : JSON.stringify(corpo)) });
      const set = res.headers.get('set-cookie');
      if (set) estado.cookie = set.split(';')[0];
      const tipo = res.headers.get('content-type') || '';
      let dados = null;
      if (tipo.includes('application/json')) dados = await res.json();
      else dados = Buffer.from(await res.arrayBuffer());
      return { status: res.status, dados, headers: res.headers };
    };
  }
  const admin = novaSessao();
  const eri = novaSessao();
  const nath = novaSessao();
  const semModulo = novaSessao();

  try {
    const setup = await admin('/api/auth/setup', { metodo: 'POST', corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Arthur', email: 'arthur@teste.com', senha: SENHA } });
    ok('administrador criado', setup.status === 201);
    const cria = async (nome, modulos) => (await admin('/api/usuarios', { metodo: 'POST', corpo: { nome, email: `${nome.toLowerCase()}@teste.com`, senha: SENHA, role: 'limitado', modulos } })).dados;
    const uEri = await cria('Erizania', ['rotinas', 'estoque']);
    const uNath = await cria('Nath', ['rotinas']);
    await cria('Debora', ['vendas']);
    ok('a chave "rotinas" é aceita pela tela de Acessos', uEri.modulos.includes('rotinas'));
    for (const [s, nome] of [[eri, 'Erizania'], [nath, 'Nath'], [semModulo, 'Debora']]) {
      await s('/api/auth/login', { metodo: 'POST', corpo: { nome, senha: SENHA } });
    }

    // Produtos e variantes direto no banco (o seed de dev).
    const { rows: [p1] } = await pool.query("INSERT INTO produtos (referencia, descricao, marca) VALUES ('1042', 'Camiseta dry', 'ORIGEM') RETURNING id");
    const { rows: [p2] } = await pool.query("INSERT INTO produtos (referencia, descricao, marca, wik_grupo) VALUES ('1108', 'Regata', 'Origem', '3 - REGATAS') RETURNING id");
    const { rows: [p3] } = await pool.query("INSERT INTO produtos (referencia, descricao, marca) VALUES ('2001', 'Blusa', 'Miss Manu') RETURNING id");
    const vari = async (pid, cor, tam, q) => (await pool.query('INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,$2,$3,$4) RETURNING id', [pid, cor, tam, q])).rows[0].id;
    const v1P = await vari(p1.id, 'Preto', 'P', 10);
    const v1M = await vari(p1.id, 'Preto', 'M', 6);
    await vari(p2.id, 'Branco', 'G', 3);
    await vari(p3.id, 'Rosa', 'M', 8);

    // -------------------------------------------------------------------
    secao('3. Permissões');
    // -------------------------------------------------------------------
    ok('sem o módulo: 403 no Meu dia', (await semModulo('/api/rotinas/meu-dia')).status === 403);
    ok('funcionário: 403 em Equipe', (await eri('/api/rotinas/equipe')).status === 403);
    ok('funcionário: 403 em Modelos', (await eri('/api/rotinas/modelos')).status === 403);
    ok('funcionário: 403 ao criar modelo', (await eri('/api/rotinas/modelos', { metodo: 'POST', corpo: {} })).status === 403);
    ok('funcionário: 403 no catálogo', (await eri('/api/rotinas/catalogo')).status === 403);

    // -------------------------------------------------------------------
    secao('4. Modelo: validação e gravação');
    // -------------------------------------------------------------------
    const contagem = {
      titulo: 'Contagem cíclica — curva A',
      instrucaoHtml: '<p>Contar <b>cada variante</b>.</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><ul><li>um</li></ul>',
      motivo: 'O saldo do Wik desvia toda semana.',
      setor: 'estoque',
      marcas: ['Origem', 'Inexistente'],
      canais: ['mercado_livre'],
      anexos: { links: [{ rotulo: 'Planilha', url: 'https://exemplo.com/p' }] },
      modoProdutos: 'fixa',
      produtos: [{ produtoId: p1.id, varianteId: null }],
      passos: [
        { texto: 'Quantidade contada', tipo: 'numero', unidade: 'peças', porProduto: true, obrigatorio: true, provaFoto: 'problema', faixa: { estoque: true, tolerancia: 2 } },
        { texto: 'Prateleira organizada?', tipo: 'sim_nao', obrigatorio: true, provaFoto: 'nao' },
        { texto: 'Observação', tipo: 'texto', obrigatorio: false },
      ],
      responsaveis: [uEri.id],
      modoAtribuicao: 'cada_um',
      recorrencia: { tipo: 'dias_semana', dias: [1, 2, 3, 4, 5, 6, 7], pularFeriados: false },
      horaLimite: '10:00',
      minutosEstimados: 30,
      prioridade: 'alta',
      conferirDepois: true,
      correcaoAutomatica: { responsavelId: uNath.id },
      lembreteMin: 30,
    };
    let r = await admin('/api/rotinas/modelos', { metodo: 'POST', corpo: { ...contagem, titulo: '' } });
    ok('título vazio é recusado com frase', r.status === 400 && /título/.test(r.dados.error));
    r = await admin('/api/rotinas/modelos', { metodo: 'POST', corpo: { ...contagem, produtos: [] } });
    ok('passo por produto sem produtos é recusado', r.status === 400 && /por produto/.test(r.dados.error));
    r = await admin('/api/rotinas/modelos', { metodo: 'POST', corpo: { ...contagem, recorrencia: { tipo: 'dias_semana', dias: [] } } });
    ok('recorrência sem dia é recusada (400, não 500)', r.status === 400 && /Marque/.test(r.dados.error), JSON.stringify(r.dados));
    r = await admin('/api/rotinas/modelos', { metodo: 'POST', corpo: { ...contagem, anexos: { links: [{ url: 'ftp://x' }] } } });
    ok('link que não é http é recusado', r.status === 400);
    r = await admin('/api/rotinas/modelos', { metodo: 'POST', corpo: contagem });
    ok('modelo de contagem criado', r.status === 201, JSON.stringify(r.dados));
    const idContagem = r.dados.id;
    const lido = (await admin(`/api/rotinas/modelos/${idContagem}`)).dados;
    ok('HTML sanitizado: sem <script> e sem javascript:', !/script|javascript:/i.test(lido.instrucaoHtml) && /<b>cada variante<\/b>/.test(lido.instrucaoHtml));
    ok('marca inexistente descartada', JSON.stringify(lido.marcas) === '["Origem"]');
    ok('passos gravados em ordem', lido.passos.length === 3 && lido.passos[0].texto === 'Quantidade contada');

    const prev = await admin('/api/rotinas/previa/recorrencia', { metodo: 'POST', corpo: { recorrencia: { tipo: 'dias_uteis' } } });
    ok('prévia: 5 próximas datas', prev.status === 200 && prev.dados.datas.length === 5 && prev.dados.descricao === 'Todo dia útil');

    // -------------------------------------------------------------------
    secao('5. Geração: "cada um", idempotência, Meu dia');
    // -------------------------------------------------------------------
    let md = await eri('/api/rotinas/meu-dia');
    ok('Meu dia gera a tarefa do dia', md.status === 200 && md.dados.abertas.length === 1, JSON.stringify(md.dados).slice(0, 300));
    await rot.gerarDia(HOJE);
    await rot.gerarDia(HOJE);
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM rotina_ocorrencias WHERE modelo_id = $1', [idContagem]);
    ok('rodar a geração 3 vezes não duplica', n === 1);
    const ocId = md.dados.abertas[0].id;
    ok('linha do Meu dia: 2 variantes, 0 de 3 passos, pede foto? não (só se der problema)',
      md.dados.abertas[0].nVariantes === 2 && md.dados.abertas[0].progresso.total === 3 && md.dados.abertas[0].progresso.feitos === 0);
    ok('Nath (não responsável) não vê a tarefa', (await nath('/api/rotinas/meu-dia')).dados.abertas.length === 0);
    ok('Nath: 403 ao abrir a tarefa da Erizânia', (await nath(`/api/rotinas/ocorrencias/${ocId}`)).status === 403);

    // Editar o modelo NÃO muda a ocorrência de hoje.
    await admin(`/api/rotinas/modelos/${idContagem}`, { metodo: 'PUT', corpo: { ...contagem, titulo: 'Contagem — título novo' } });
    let det = (await eri(`/api/rotinas/ocorrencias/${ocId}`)).dados;
    ok('editar o modelo não mexe na ocorrência já gerada', det.titulo === 'Contagem cíclica — curva A');
    ok('produtos com estoque e estoque agora', det.produtos[0].variantes.length === 2 && det.produtos[0].variantes.some((v) => v.quantidadeAgora === 6));

    // -------------------------------------------------------------------
    secao('6. Respostas, problema e foto');
    // -------------------------------------------------------------------
    const passoNum = det.passos[0];
    const passoSim = det.passos[1];
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/concluir`, { metodo: 'POST', corpo: {} });
    ok('concluir sem responder é bloqueado e diz o que falta', r.status === 422 && r.dados.faltas.length === 3, JSON.stringify(r.dados));
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/respostas`, { metodo: 'PUT', corpo: { passoId: passoNum.id, chave: `v${v1P}`, valor: { numero: 11 } } });
    ok('contagem dentro da tolerância (11 × 10) não é problema', r.status === 200 && r.dados.resposta.problema === false && r.dados.resposta.valor.sistema === 10);
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/respostas`, { metodo: 'PUT', corpo: { passoId: passoNum.id, chave: `v${v1M}`, valor: { numero: 2 } } });
    ok('contagem fora da tolerância (2 × 6) é problema', r.dados.resposta.problema === true);
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/respostas`, { metodo: 'PUT', corpo: { passoId: passoSim.id, valor: { resposta: 'sim' } } });
    ok('progresso 3 de 3', r.dados.progresso.feitos === 3 && r.dados.progresso.total === 3);
    ok('falta só a foto do problema', r.dados.faltas.length === 1 && /foto/.test(r.dados.faltas[0].motivo) && r.dados.faltas[0].chave === `v${v1M}`);
    ok('a tarefa passou para "em andamento"', (await pool.query('SELECT status FROM rotina_ocorrencias WHERE id = $1', [ocId])).rows[0].status === 'em_andamento');
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/respostas`, { metodo: 'PUT', corpo: { passoId: 9999, valor: {} } });
    ok('passo de outra tarefa é recusado', r.status === 400);
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/respostas`, { metodo: 'PUT', corpo: { passoId: passoNum.id, chave: 'v999999', valor: { numero: 1 } } });
    ok('produto fora da tarefa é recusado', r.status === 400);

    // Foto
    const form = (buf, mini, extra = {}) => {
      const f = new FormData();
      f.append('foto', new Blob([buf], { type: 'image/webp' }), 'f.webp');
      f.append('miniatura', new Blob([mini], { type: 'image/webp' }), 'm.webp');
      for (const [k, v] of Object.entries(extra)) f.append(k, String(v));
      return f;
    };
    r = await eri('/api/rotinas/fotos', { metodo: 'POST', form: form(webpFalso(500 * 1024), webpFalso(1000), { ocorrenciaId: ocId }) });
    ok('foto acima de 400 KB é recusada', r.status === 413, String(r.status));
    const falsa = Buffer.from('nao sou imagem nenhuma de verdade');
    r = await eri('/api/rotinas/fotos', { metodo: 'POST', form: (() => { const f = new FormData(); f.append('foto', new Blob([falsa], { type: 'image/webp' }), 'x.webp'); f.append('miniatura', new Blob([falsa], { type: 'image/webp' }), 'y.webp'); f.append('ocorrenciaId', ocId); return f; })() });
    ok('arquivo que não é foto é recusado', r.status === 400);
    r = await nath('/api/rotinas/fotos', { metodo: 'POST', form: form(webpFalso(), webpFalso(500), { ocorrenciaId: ocId }) });
    ok('foto em tarefa de outra pessoa é recusada', r.status === 403);
    r = await eri('/api/rotinas/fotos', { metodo: 'POST', form: form(webpFalso(150 * 1024), webpFalso(900), { ocorrenciaId: ocId, largura: 1280, altura: 960 }) });
    ok('foto de 150 KB aceita', r.status === 201 && /^[a-f0-9]{64}$/.test(r.dados.hash), JSON.stringify(r.dados));
    const foto = r.dados;
    const grande = await eri(`/api/rotinas/fotos/${foto.hash}`);
    const mini = await eri(`/api/rotinas/fotos/${foto.hash}?t=mini`);
    ok('foto servida com cache imutável', /immutable/.test(grande.headers.get('cache-control')) && /max-age=31536000/.test(grande.headers.get('cache-control')));
    ok('miniatura é outro arquivo, bem menor', mini.status === 200 && mini.dados.length === 900 && grande.dados.length === 150 * 1024);
    ok('foto não é acessível sem login', (await fetch(`${base}/api/rotinas/fotos/${foto.hash}`)).status === 401);

    r = await eri(`/api/rotinas/ocorrencias/${ocId}/respostas`, { metodo: 'PUT', corpo: { passoId: passoNum.id, chave: `v${v1M}`, valor: { numero: 2, fotos: [foto.id], nota: 'faltando na prateleira' } } });
    ok('foto ligada à resposta do problema', r.status === 200 && r.dados.faltas.length === 0);

    // -------------------------------------------------------------------
    secao('7. Concluir → conferência → devolver → aprovar; correção automática');
    // -------------------------------------------------------------------
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/concluir`, { metodo: 'POST', corpo: { observacao: 'feito' } });
    ok('"conferir depois": vai para aguardando conferência', r.status === 200 && r.dados.status === 'aguardando_conferencia');
    ok('correção automática criada', r.dados.correcaoCriada === true);
    const mdNath = (await nath('/api/rotinas/meu-dia')).dados;
    const corr = mdNath.abertas.find((x) => /^Corrigir:/.test(x.titulo));
    ok('a correção aparece no Meu dia da Nath, com o produto do problema', corr && corr.nVariantes === 1 && corr.correcao === true, JSON.stringify(mdNath.abertas));
    const detCorr = (await nath(`/api/rotinas/ocorrencias/${corr.id}`)).dados;
    ok('a correção explica o problema e mostra a foto', /sistema: 6/.test(detCorr.instrucaoHtml) && detCorr.anexos.imagens.includes(foto.id) && detCorr.fotos[foto.id]);
    ok('a correção aponta a tarefa de origem', detCorr.origem && detCorr.origem.id === ocId);

    r = await eri(`/api/rotinas/ocorrencias/${ocId}/respostas`, { metodo: 'PUT', corpo: { passoId: passoSim.id, valor: { resposta: 'nao' } } });
    ok('depois de entregue, não dá mais para responder (409)', r.status === 409);
    ok('funcionário não aprova (403)', (await eri(`/api/rotinas/ocorrencias/${ocId}/aprovar`, { metodo: 'POST', corpo: {} })).status === 403);
    r = await admin(`/api/rotinas/ocorrencias/${ocId}/devolver`, { metodo: 'POST', corpo: { comentario: '' } });
    ok('devolver exige comentário', r.status === 400);
    r = await admin(`/api/rotinas/ocorrencias/${ocId}/devolver`, { metodo: 'POST', corpo: { comentario: 'Conte o M de novo' } });
    ok('devolvida', r.status === 200);
    md = (await eri('/api/rotinas/meu-dia')).dados;
    const dev = md.abertas.find((x) => x.id === ocId);
    ok('volta para o Meu dia com o comentário', dev && dev.status === 'devolvida' && dev.comentarioConferencia === 'Conte o M de novo');
    r = await eri(`/api/rotinas/ocorrencias/${ocId}/concluir`, { metodo: 'POST', corpo: {} });
    ok('entrega de novo', r.dados.status === 'aguardando_conferencia');
    r = await admin(`/api/rotinas/ocorrencias/${ocId}/aprovar`, { metodo: 'POST', corpo: {} });
    ok('aprovada', r.status === 200 && (await pool.query('SELECT status, conferida_por FROM rotina_ocorrencias WHERE id = $1', [ocId])).rows[0].conferida_por);
    const { rows: [{ nc }] } = await pool.query("SELECT COUNT(*)::int AS nc FROM rotina_modelos WHERE titulo LIKE 'Corrigir:%'");
    ok('reentregar depois de devolvida NÃO abre segunda correção', nc === 1, String(nc));

    // -------------------------------------------------------------------
    secao('8. "Qualquer um", lista automática, simples sem passos');
    // -------------------------------------------------------------------
    r = await admin('/api/rotinas/modelos', { metodo: 'POST', corpo: {
      titulo: 'Conferir coleta Mercado Livre', instrucaoHtml: '<p>Foto da pilha antes da coleta.</p>', setor: 'expedicao',
      modoProdutos: 'automatica', filtroProdutos: { marcas: ['Origem'] },
      passos: [{ texto: 'Foto da pilha', tipo: 'foto', obrigatorio: true }, { texto: 'Contagem', tipo: 'numero', porProduto: true, obrigatorio: false, faixa: { min: 0, max: 100 } }],
      responsaveis: [uEri.id, uNath.id], modoAtribuicao: 'qualquer_um', recorrencia: { tipo: 'dias_semana', dias: [1, 2, 3, 4, 5, 6, 7], pularFeriados: false },
      horaLimite: '23:59', prioridade: 'normal', criarAgora: true,
    } });
    ok('modelo "qualquer um" com lista automática criado e gerado agora', r.status === 201 && r.dados.geradas === 1, JSON.stringify(r.dados));
    const idColeta = r.dados.id;
    const prevProd = await admin('/api/rotinas/previa/produtos', { metodo: 'POST', corpo: { filtro: { marcas: ['Origem'] } } });
    ok('prévia da lista automática: 2 referências / 3 variantes (ORIGEM e Origem são a mesma marca)', prevProd.dados.referencias === 2 && prevProd.dados.variantes === 3, JSON.stringify(prevProd.dados));
    const { rows: [ocColeta] } = await pool.query('SELECT id, produtos_resolvidos FROM rotina_ocorrencias WHERE modelo_id = $1', [idColeta]);
    ok('ocorrência congelou 2 referências', ocColeta.produtos_resolvidos.length === 2);
    await pool.query("INSERT INTO produtos (referencia, descricao, marca) VALUES ('1200', 'Bermuda nova', 'Origem')");
    rot.limparCacheCurva();
    await rot.gerarDia(HOJE);
    const { rows: [ocColeta2] } = await pool.query('SELECT produtos_resolvidos FROM rotina_ocorrencias WHERE id = $1', [ocColeta.id]);
    ok('produto novo da marca NÃO entra na ocorrência já gerada', ocColeta2.produtos_resolvidos.length === 2);
    const { rows: [{ nv }] } = await pool.query('SELECT COUNT(*)::int AS nv FROM rotina_ocorrencias WHERE modelo_id = $1', [idColeta]);
    ok('"qualquer um": uma ocorrência só para as duas pessoas', nv === 1);
    ok('as duas pessoas veem a compartilhada', (await eri('/api/rotinas/meu-dia')).dados.abertas.some((x) => x.id === ocColeta.id) && (await nath('/api/rotinas/meu-dia')).dados.abertas.some((x) => x.id === ocColeta.id));
    // Nath pega (responde primeiro)
    const detCol = (await nath(`/api/rotinas/ocorrencias/${ocColeta.id}`)).dados;
    const chaveCol = `v${detCol.produtos[0].variantes[0].id}`;
    r = await nath(`/api/rotinas/ocorrencias/${ocColeta.id}/respostas`, { metodo: 'PUT', corpo: { passoId: detCol.passos[1].id, chave: chaveCol, valor: { numero: 150 } } });
    ok('número fora da faixa (150 > 100) é problema', r.dados.resposta.problema === true);
    ok('quem respondeu primeiro ficou com a tarefa', (await pool.query('SELECT responsavel_id FROM rotina_ocorrencias WHERE id = $1', [ocColeta.id])).rows[0].responsavel_id === uNath.id);
    ok('e ela sai do Meu dia da Erizânia', !(await eri('/api/rotinas/meu-dia')).dados.abertas.some((x) => x.id === ocColeta.id));
    ok('Erizânia não consegue mais responder (403)', (await eri(`/api/rotinas/ocorrencias/${ocColeta.id}/respostas`, { metodo: 'PUT', corpo: { passoId: detCol.passos[1].id, chave: chaveCol, valor: { numero: 1 } } })).status === 403);
    await rot.gerarDia(HOJE);
    const { rows: [{ nv2 }] } = await pool.query('SELECT COUNT(*)::int AS nv2 FROM rotina_ocorrencias WHERE modelo_id = $1', [idColeta]);
    ok('pegar a compartilhada NÃO abre outra vaga na geração seguinte', nv2 === 1);
    r = await nath(`/api/rotinas/ocorrencias/${ocColeta.id}/concluir`, { metodo: 'POST', corpo: {} });
    ok('passo tipo Foto obrigatório bloqueia sem foto', r.status === 422 && r.dados.faltas.some((f) => f.motivo === 'falta a foto'));
    r = await nath(`/api/rotinas/ocorrencias/${ocColeta.id}/nao-feita`, { metodo: 'POST', corpo: { motivo: 'outro' } });
    ok('"não consegui": Outro exige texto', r.status === 400);
    r = await nath(`/api/rotinas/ocorrencias/${ocColeta.id}/nao-feita`, { metodo: 'POST', corpo: { motivo: 'sistema_fora' } });
    ok('"não consegui fazer" registrado', r.status === 200 && (await pool.query('SELECT status, motivo_nao_feita FROM rotina_ocorrencias WHERE id = $1', [ocColeta.id])).rows[0].motivo_nao_feita === 'sistema_fora');

    r = await admin('/api/rotinas/modelos', { metodo: 'POST', corpo: {
      titulo: 'Avisar fornecedor', instrucaoHtml: 'Ligar para o fornecedor de tecido.', setor: 'compras', avulsa: true,
      responsaveis: [uEri.id], recorrencia: { data: HOJE }, horaLimite: '00:01',
    } });
    ok('tarefa avulsa para hoje nasce na hora', r.status === 201 && r.dados.geradas === 1);
    md = (await eri('/api/rotinas/meu-dia')).dados;
    const avulsa = md.abertas.find((x) => x.titulo === 'Avisar fornecedor');
    ok('avulsa com prazo 00:01 já está atrasada e vem primeiro', avulsa && avulsa.atrasada && md.abertas[0].id === avulsa.id && md.contadores.atrasadas >= 1);
    r = await eri(`/api/rotinas/ocorrencias/${avulsa.id}/concluir`, { metodo: 'POST', corpo: {} });
    ok('tarefa simples (sem passos) conclui direto', r.status === 200 && r.dados.status === 'concluida');
    const lista = (await admin('/api/rotinas/modelos?status=avulsas')).dados;
    ok('avulsa fica fora da lista de rotinas e aparece em "Avulsas"', lista.some((m) => m.titulo === 'Avisar fornecedor') && !(await admin('/api/rotinas/modelos')).dados.some((m) => m.titulo === 'Avisar fornecedor'));

    // -------------------------------------------------------------------
    secao('9. Equipe, modelos, avisos, Início, histórico');
    // -------------------------------------------------------------------
    const eq = (await admin('/api/rotinas/equipe?periodo=7')).dados;
    ok('Equipe: painéis e pessoas', eq.paineis && typeof eq.paineis.atrasadas === 'number' && eq.pessoas.some((p) => p.nome === 'Erizania'), JSON.stringify(eq.paineis));
    ok('Equipe: problema de hoje contado', eq.paineis.comProblemaHoje >= 1);
    const eqProd = (await admin(`/api/rotinas/equipe?produto=${p1.id}`)).dados;
    ok('Equipe filtra por produto', eqProd.itens.length >= 1 && eqProd.itens.every((x) => x.nProdutos >= 1));
    const hist = (await admin(`/api/rotinas/produto/${p1.id}/historico`)).dados;
    ok('histórico do produto traz a contagem', hist.some((h) => h.valor.numero === 2 && h.problema));
    r = await admin(`/api/rotinas/modelos/${idContagem}/duplicar`, { metodo: 'POST' });
    ok('duplicar cria uma cópia pausada', r.status === 201 && (await pool.query('SELECT status, titulo FROM rotina_modelos WHERE id = $1', [r.dados.id])).rows[0].status === 'pausado');
    await admin(`/api/rotinas/modelos/${idColeta}/status`, { metodo: 'POST', corpo: { status: 'pausado' } });
    await pool.query('DELETE FROM rotina_ocorrencias WHERE modelo_id = $1', [idColeta]);
    await rot.gerarDia(HOJE);
    ok('modelo pausado não gera', (await pool.query('SELECT COUNT(*)::int AS n FROM rotina_ocorrencias WHERE modelo_id = $1', [idColeta])).rows[0].n === 0);
    const avisosAdm = (await admin('/api/rotinas/avisos')).dados;
    ok('avisos do admin respondem', Array.isArray(avisosAdm.itens));
    const ini = (await nath('/api/inicio')).dados;
    ok('Início da Nath mostra a correção atrasada ou de hoje', [...(ini.hojeComHora || []), ...(ini.hojeSemHora || []), ...(ini.ficouParaTras || [])].some((x) => /Corrigir/.test(x.titulo)), JSON.stringify(ini).slice(0, 400));
    const ml = (await admin('/api/rotinas/modelos')).dados.find((m) => m.id === idContagem);
    ok('lista de modelos traz "quando" e próximas datas', ml && ml.quando === 'Todo dia' && ml.proximas.length === 3);
  } finally {
    servidor.close();
    await pool.end();
  }

  console.log(`\n${passou} passaram, ${falhou} falharam.`);
  if (falhou) { console.log(falhas.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
