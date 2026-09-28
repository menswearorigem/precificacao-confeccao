// Teste do Início (28/09/2026) — o dia de cada pessoa, por setor.
//
//   1. Motor puro (lib/inicioDoDia): setor a partir dos módulos, primeiro
//      nome, saudação pela hora de Brasília, linha de resumo (urgente
//      primeiro, "tarefas para hoje" abrindo, máx. 5), escolha do Próximo,
//      coleta de hoje × de amanhã, frente sem dado vira `semDado` (REGRA 2).
//   2. Contra o banco (rota GET /api/inicio): expedição, produção, financeiro,
//      compras e agenda semeados; cada usuário só recebe o do próprio setor;
//      a agenda respeita a visibilidade do Calendário.
//
// Rodar: DATABASE_URL=... node scripts/teste-inicio.js
const ini = require('../src/lib/inicioDoDia');

let passou = 0; let falhou = 0;
function ok(c, d, det) { if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); } }
function igual(a, b, d) { ok(JSON.stringify(a) === JSON.stringify(b), d, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); }

console.log('\n1. Motor puro');
{
  igual(ini.setoresDoUsuario({ role: 'admin', modulos: [] }).rotulo, 'Diretoria', 'admin é Diretoria');
  igual(ini.setoresDoUsuario({ role: 'admin', modulos: [] }).chaves.length, ini.SETORES.length, 'admin enxerga todos os setores');
  igual(ini.setoresDoUsuario({ role: 'limitado', modulos: ['estoque'] }).rotulo, 'Expedição · Estoque', 'galpão (só estoque) = Expedição · Estoque');
  igual(ini.setoresDoUsuario({ role: 'limitado', modulos: ['financeiro', 'compras'] }).chaves, ['financeiro', 'compras'], 'financeiro + compras');
  igual(ini.setoresDoUsuario({ role: 'limitado', modulos: ['producao'] }).chaves, ['producao'], 'produção sozinha não vira expedição');
  igual(ini.setoresDoUsuario({ role: 'limitado', modulos: [] }).rotulo, null, 'sem módulo, sem setor');
  igual(ini.primeiroNome('josé arthur silva'), 'José', 'primeiro nome, com maiúscula');
  igual(ini.primeiroNome('expedicao2'), null, 'login com número não é nome de gente');
  igual(ini.saudacao(new Date('2026-09-28T13:00:00Z')), 'Bom dia', '10h em Brasília = bom dia');
  igual(ini.saudacao(new Date('2026-09-28T18:00:00Z')), 'Boa tarde', '15h = boa tarde');
  igual(ini.saudacao(new Date('2026-09-28T23:30:00Z')), 'Boa noite', '20h30 = boa noite (servidor em UTC já é outro dia de madrugada, e tanto faz)');
}
{
  const agora = new Date('2026-09-28T13:00:00Z'); // 10:00 em Brasília
  const hoje = '2026-09-28';
  const dados = {
    agenda: { atrasados: [{ id: 1, titulo: 'Enfesto', data: '2026-09-26', meu: true }], deHoje: [{ id: 2, titulo: 'Reunião', data: hoje, meu: true }], proximo: null },
    expedicao: {
      total: 30, atrasados: 3, apertados: 10, ateHoje: 24,
      porCanal: [
        { canal: 'Shopee', n: 24, atrasados: 0, apertados: 10, ate_hoje: 18, proxima: '2026-09-28T17:00:00Z' },
        { canal: 'TikTok Shop', n: 3, atrasados: 3, apertados: 0, ate_hoje: 3, proxima: null },
        { canal: 'Mercado Livre', n: 3, atrasados: 0, apertados: 0, ate_hoje: 3, proxima: '2026-09-28T20:30:00Z' },
      ],
    },
    producao: { abertas: 3, atrasadas: [{ id: 9, numero: 1, referencia: 'OG1620', faccao: 'Célia', diasAtraso: 4, faltam: 180 }], deHoje: [], proximas: [{ id: 10, numero: 5, referencia: 'HB3301', data_prevista: '2026-10-01', faltam: 200 }] },
    financeiro: { pagarVencidos: { n: 0, valor: 0 }, pagarHoje: { n: 1, valor: 500 }, receberHoje: { n: 0, valor: 0 }, receberVencidos: { n: 0, valor: 0 }, itensHoje: [{ natureza: 'pagar', descricao: 'Malha', valor: 500, dia: hoje }] },
  };
  const r = ini.montarInicio({ user: { role: 'admin', nome: 'José Arthur', modulos: [] }, dados, agora, hoje, erros: { compras: 'tabela fora do ar' } });
  igual(r.nome, 'José', 'nome');
  igual(r.resumo[0].texto, '1 tarefa para hoje', '"tarefas para hoje" abre a linha, como no Tempestivo');
  ok(r.resumo.length <= 5, 'no máximo 5 pedaços na linha');
  igual(r.resumo[1].tom, 'urgente', 'depois dela vem o urgente');
  ok(r.resumo.findIndex((x) => x.tom === 'info' && x !== r.resumo[0]) === -1 || r.resumo.findIndex((x) => x.tom === 'info' && x !== r.resumo[0]) > r.resumo.findIndex((x) => x.tom === 'urgente'), 'informativo depois do urgente');
  igual(r.proximo?.rotulo, 'Próxima coleta', 'coleta com hora hoje é o Próximo');
  igual(r.proximo?.hora, '14:00', 'hora da coleta em Brasília');
  igual(r.proximo?.titulo, 'Shopee · 18 pedidos', 'conta só os que saem hoje (18), não os de amanhã (+6)');
  igual(r.proximo?.minutos, 240, 'faltam 4 h');
  igual(r.hojeComHora.map((h) => h.hora), ['14:00', '17:30'], 'coluna Hoje em ordem de hora');
  ok(r.hojeComHora[0].sub.includes('+6 para depois'), 'linha da Shopee avisa os de depois');
  ok(r.ficouParaTras.some((x) => x.titulo === 'Coleta TikTok Shop'), 'coleta atrasada sem próxima vai para "ficou para trás"');
  ok(r.ficouParaTras.some((x) => x.titulo.startsWith('OP 1')), 'OP atrasada em "ficou para trás"');
  igual(r.acoes[r.acoes.length - 1].chave === 'agenda' || r.acoes.findIndex((a) => a.chave === 'agenda') > r.acoes.findIndex((a) => a.chave === 'expedicao'), true, 'atraso do setor vem antes do atraso da agenda');
  ok(r.semDado.some((s) => s.chave === 'compras'), 'frente que falhou vira semDado (REGRA 2)');
  ok(!r.resumo.some((x) => /compra/i.test(x.texto)), 'e não inventa zero de compras');
}
{
  // Sem coleta com hora: o que vence hoje (financeiro) vira o Próximo.
  const r = ini.montarInicio({
    user: { role: 'limitado', nome: 'Luana', modulos: ['financeiro'] }, agora: new Date('2026-09-28T13:00:00Z'), hoje: '2026-09-28',
    dados: { financeiro: { pagarVencidos: { n: 0 }, pagarHoje: { n: 2, valor: 900 }, receberHoje: { n: 0 }, receberVencidos: { n: 0 }, itensHoje: [{ natureza: 'pagar', descricao: 'Menor', valor: 100, dia: '2026-09-28' }, { natureza: 'pagar', descricao: 'Maior', valor: 800, dia: '2026-09-28' }] }, agenda: { atrasados: [], deHoje: [], proximo: { id: 3, titulo: 'Depois', data: '2026-09-30' } } },
  });
  igual(r.proximo?.titulo, 'Maior', 'maior conta de hoje é o Próximo');
  igual(r.setor, 'Financeiro', 'setor Financeiro');
  ok(!r.acoes.some((a) => a.modulo === 'marketplace'), 'financeiro não vê cartão de expedição');
}
{
  const r = ini.montarInicio({ user: { role: 'limitado', nome: 'Ana', modulos: ['vendas'] }, agora: new Date(), hoje: '2026-09-28', dados: { vendas: { abertos: 0, valor: 0, antigos: 0 }, agenda: { atrasados: [], deHoje: [], proximo: null } } });
  igual(r.resumo, [], 'dia limpo: linha vazia (a tela escreve "nada pendente")');
  igual(r.proximo, null, 'sem próximo');
  igual(r.emDia.map((x) => x.titulo), ['Pedidos de venda'], 'frente em dia aparece como em dia');
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('\n(sem DATABASE_URL — pulei a parte do banco)'); return; }
  console.log('\n2. Contra o banco (rota)');
  const pool = require('../src/db/pool');
  const rotas = require('../src/routes/inicio.routes');
  function chamar(user) {
    const camada = rotas.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
    const req = { params: {}, query: {}, body: {}, method: 'GET', user, headers: {} };
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); } };
      camada.route.stack[0].handle(req, res, (err) => (err ? reject(err) : reject(new Error('next sem erro'))));
    });
  }
  const q = (s, v) => pool.query(s, v);
  const { rows: [adm] } = await q(`INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ('José Arthur Silva','ini-adm@t','x','admin') RETURNING id`);
  const { rows: [gal] } = await q(`INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ('Carla Mendes','ini-gal@t','x','limitado') RETURNING id`);
  const { rows: [fin] } = await q(`INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ('Luana Prado','ini-fin@t','x','limitado') RETURNING id`);
  const { rows: [emp] } = await q(`INSERT INTO empresas (nome) VALUES ('TSTINI') RETURNING id`);
  const { rows: [prod] } = await q(`INSERT INTO produtos (referencia, empresa_id) VALUES ('TSTINI-1', $1) RETURNING id`, [emp.id]);
  const { rows: [fac] } = await q(`INSERT INTO fornecedores (nome, eh_faccao) VALUES ('Facção Teste', true) RETURNING id`);
  await q(`INSERT INTO ordens_producao (produto_id, empresa_id, fornecedor_id, situacao, quantidade_planejada, data_prevista) VALUES ($1,$2,$3,'em_producao',100,CURRENT_DATE - 3),($1,$2,$3,'em_producao',50,CURRENT_DATE)`, [prod.id, emp.id, fac.id]);
  // Shopee: 48 h. Faturado há 50 h = atrasado; há 30 h = sai hoje ou amanhã, conforme a hora.
  await q(`INSERT INTO pedidos_venda (situacao, canal_venda, origem_marketplace, faturado_em, empresa_id) VALUES ('faturado','Shopee','shopee', now() - interval '50 hours', $1),('faturado','Shopee','shopee', now() - interval '30 hours', $1)`, [emp.id]);
  await q(`INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_competencia, data_vencimento, valor_bruto, situacao) VALUES ($1,'pagar','TSTINI hoje',CURRENT_DATE,${'(now() AT TIME ZONE \'America/Sao_Paulo\')::date'},700,'aberto')`, [emp.id]);
  const { rows: [ev] } = await q(`INSERT INTO calendario_eventos (titulo, data_prevista_fim, criado_por) VALUES ('Inventário C', (now() AT TIME ZONE 'America/Sao_Paulo')::date, $1) RETURNING id`, [adm.id]);
  await q(`INSERT INTO calendario_eventos_responsaveis VALUES ($1,$2)`, [ev.id, gal.id]);
  await q(`INSERT INTO calendario_eventos (titulo, data_prevista_fim, criado_por) VALUES ('Segredo do admin', (now() AT TIME ZONE 'America/Sao_Paulo')::date, $1)`, [adm.id]);

  const a = (await chamar({ id: adm.id, nome: 'José Arthur Silva', role: 'admin', modulos: [] })).body;
  igual(a.setor, 'Diretoria', 'admin: Diretoria');
  ok(a.acoes.some((x) => x.chave === 'op-atrasada'), 'admin vê OP atrasada');
  ok(a.acoes.some((x) => x.chave === 'pagar-hoje'), 'admin vê conta de hoje');
  ok(a.resumo.some((x) => /coleta atrasada/.test(x.texto)), 'admin vê coleta atrasada');

  const g = (await chamar({ id: gal.id, nome: 'Carla Mendes', role: 'limitado', modulos: ['estoque'] })).body;
  igual(g.nome, 'Carla', 'galpão: nome');
  igual(g.setor, 'Expedição · Estoque', 'galpão: setor');
  ok(g.resumo.some((x) => /coleta atrasada/.test(x.texto)), 'galpão vê a coleta');
  ok(!g.acoes.some((x) => x.modulo === 'financeiro'), 'galpão NÃO vê financeiro');
  ok(!g.acoes.some((x) => x.chave === 'op-atrasada'), 'galpão (sem módulo produção) NÃO vê OP');
  ok(g.hojeSemHora.some((x) => x.titulo === 'Inventário C'), 'galpão vê a tarefa em que é responsável');
  ok(!g.hojeSemHora.some((x) => x.titulo === 'Segredo do admin'), 'galpão não vê evento que não lhe foi liberado');

  const f = (await chamar({ id: fin.id, nome: 'Luana Prado', role: 'limitado', modulos: ['financeiro'] })).body;
  ok(f.acoes.some((x) => x.chave === 'pagar-hoje'), 'financeiro vê conta de hoje');
  ok(!f.resumo.some((x) => /coleta|OP/.test(x.texto)), 'financeiro não vê coleta nem OP');
  igual(f.proximo?.rotulo, 'Vence hoje', 'Próximo do financeiro é a conta de hoje');
  await pool.end();
})().catch((e) => { falhou += 1; console.error(e); }).finally(() => {
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exitCode = falhou ? 1 : 0;
});
