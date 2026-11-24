// Teste do Painel ao vivo da VENDA DIRETA (Vendas › Painel ao vivo), 24/11/2026.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-painel-vendas-ao-vivo-2026-11-24.js
//
// A conta em si é a da lib compartilhada (já testada em teste-painel-ao-vivo-*).
// Aqui se confere o que é DESTA rota:
//   · só venda direta (origem_marketplace nulo); marketplace fica de fora;
//   · cancelado, devolução/troca/bonificação ficam de fora; pedido em aberto conta;
//   · valor = total_liquido; sete dias; vendedores (cadastro, texto do Wik e "sem");
//   · canais no lugar de plataformas; UF do cliente; ranking por referência;
//   · pedido importado de outro dia não entra na curva (hora não confiável);
//   · a foto sai por uma rota que só exige o módulo Vendas.

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-painel-vendas';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-painel-vendas-secret-com-32-caracteres';
if (!process.env.DATABASE_URL) { console.log('(sem DATABASE_URL: nada a testar)'); process.exit(0); }

const http = require('http');

let falhas = 0; let passou = 0;
function conferir(d, c, det) {
  if (c) { passou += 1; console.log(`  ok   ${d}`); } else { falhas += 1; console.log(`  FALHA ${d}${det !== undefined ? ` — veio ${JSON.stringify(det)}` : ''}`); }
}
const perto = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005;

function pedir(porta, metodo, caminho, { cookie, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const body = corpo ? JSON.stringify(corpo) : undefined;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) } },
    (res) => { const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(partes), texto: Buffer.concat(partes).toString('utf8') })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

async function main() {
  const criarApp = require('../src/app');
  const pool = require('../src/db/pool');
  const { hojeEmBrasilia } = require('../src/lib/dataBrasil');
  const { somarDias } = require('../src/lib/painelAoVivo');
  const MARCA = 'TESTE-PV-DIRETA';

  await pool.query(`DELETE FROM pedido_itens WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = $1)`, [MARCA]);
  await pool.query(`DELETE FROM pedidos_venda WHERE observacao = $1`, [MARCA]);
  await pool.query(`DELETE FROM clientes WHERE nome LIKE 'Cliente PV-DIRETA%'`);
  await pool.query(`DELETE FROM vendedores WHERE nome = 'Vendedora PV-DIRETA'`);

  const hoje = hojeEmBrasilia();
  const ontem = somarDias(hoje, -1);
  const { rows: [vend] } = await pool.query(`INSERT INTO vendedores (nome) VALUES ('Vendedora PV-DIRETA') RETURNING id`);
  const cli = async (nome, uf) => (await pool.query(`INSERT INTO clientes (nome, uf) VALUES ($1, $2) RETURNING id`, [`Cliente PV-DIRETA ${nome}`, uf])).rows[0].id;
  const cSP = await cli('SP', 'SP');
  const cGO = await cli('GO', 'GO');
  const cSem = await cli('sem uf', null);
  await pool.query(`DELETE FROM produtos WHERE referencia = 'PVD-REF'`);
  const { rows: [prod] } = await pool.query(`INSERT INTO produtos (referencia) VALUES ('PVD-REF') RETURNING id`);
  if (prod?.id) await pool.query(`INSERT INTO produto_fotos (produto_id, dados, mime_type, tamanho) VALUES ($1, $2, 'image/png', 4) ON CONFLICT (produto_id) DO NOTHING`, [prod.id, Buffer.from([137, 80, 78, 71])]);

  async function venda({ dia, valor, canal = 'Atacado', vendedorId = null, vendedorTexto = null, cliente = cSP, situacao = 'faturado', operacao = 'Venda', origem = null, criadoEm = 'now()', ref = 'OG1620', cor = 'Preto', tam = 'M' }) {
    const { rows: [pv] } = await pool.query(
      `INSERT INTO pedidos_venda (data_pedido, canal_venda, vendedor_id, vendedor, cliente_id, situacao, operacao, origem_marketplace, total_liquido, observacao, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${criadoEm}) RETURNING id`,
      [dia, canal, vendedorId, vendedorTexto, cliente, situacao, operacao, origem, valor, MARCA],
    );
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, produto_id, referencia, cor, tamanho, descricao, quantidade, valor_unitario, total)
       VALUES ($1, $2, $3, $4, $5, 'Camisa Polo Teste', 1, $6, $6)`,
      [pv.id, ref === 'PVD-REF' ? prod?.id ?? null : null, ref, cor, tam, valor],
    );
    return pv.id;
  }

  // HOJE: 3 vendas que contam + 4 que não contam.
  await venda({ dia: hoje, valor: 100, canal: 'Atacado', vendedorId: vend.id, cliente: cSP });
  await venda({ dia: hoje, valor: 50, canal: 'Varejo', vendedorTexto: 'Maria do Wik', cliente: cGO, situacao: 'aberto' }); // em aberto conta
  await venda({ dia: hoje, valor: 25, canal: 'Varejo', cliente: cSem, ref: 'PVD-REF' }); // sem vendedor, cliente sem UF
  await venda({ dia: hoje, valor: 999, situacao: 'cancelado' });
  await venda({ dia: hoje, valor: 777, operacao: 'DEVOLUÇÃO' });
  await venda({ dia: hoje, valor: 555, operacao: 'Bonificação' });
  await venda({ dia: hoje, valor: 444, origem: 'shopee' }); // marketplace tem painel próprio
  // Importado hoje, mas é de ONTEM: hora da importação é mentira.
  const dezDeOntem = `(('${ontem} 10:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
  await venda({ dia: ontem, valor: 200, vendedorId: vend.id, criadoEm: dezDeOntem });
  await venda({ dia: ontem, valor: 40, canal: 'Varejo' }); // created_at = agora (hoje) -> sem hora
  await venda({ dia: somarDias(hoje, -3), valor: 30, criadoEm: `(('${somarDias(hoje, -3)} 11:00:00')::timestamp AT TIME ZONE 'America/Sao_Paulo')` });

  // O Wik é uma integração só; se a base de teste não tem, cria uma.
  const { rowCount } = await pool.query(`UPDATE integracoes_wik SET vendas_ultima_sincronizacao = now() - interval '12 minutes'`);
  if (!rowCount) await pool.query(`INSERT INTO integracoes_wik (email, senha, vendas_ultima_sincronizacao) VALUES ('wik@teste', 'x', now() - interval '12 minutes')`);

  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  const setup = await pedir(porta, 'POST', '/api/auth/setup', { corpo: { nome: 'teste', email: 'teste@exemplo.com', senha: 'roupa azul de verao', appPassword: process.env.APP_PASSWORD } });
  let cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (![200, 201].includes(setup.status)) {
    const login = await pedir(porta, 'POST', '/api/auth/login', { corpo: { nome: 'teste', senha: 'roupa azul de verao' } });
    cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  }

  console.log('\nA rota da venda direta');
  const sem = await pedir(porta, 'GET', '/api/vendas-painel-ao-vivo');
  conferir('sem login a rota nega', sem.status === 401, sem.status);
  const r = await pedir(porta, 'GET', '/api/vendas-painel-ao-vivo?fresco=1', { cookie });
  conferir('responde 200', r.status === 200, [r.status, r.texto.slice(0, 200)]);
  const p = JSON.parse(r.texto);
  conferir('hoje = 3 vendas (cancelado, devolução, bonificação e marketplace ficam de fora)', p.hojeTotais.pedidos === 3, p.hojeTotais);
  conferir('hoje = R$ 175,00 (valor é total_liquido; pedido em aberto conta)', perto(p.hojeTotais.valor, 175), p.hojeTotais.valor);
  conferir('ontem = 2 vendas, R$ 240,00', p.ontemTotais.pedidos === 2 && perto(p.ontemTotais.valor, 240), p.ontemTotais);
  conferir('sete dias: ontem R$ 240 e três dias atrás R$ 30', perto(p.seteDias[6].valor, 240) && perto(p.seteDias[4].valor, 30), p.seteDias);
  const nomes = p.lojas.map((l) => l.nome);
  conferir('"lojas" são vendedores: cadastro, texto do Wik e "Sem vendedor"', nomes.includes('Vendedora PV-DIRETA') && nomes.includes('Maria do Wik') && nomes.includes('Sem vendedor') && p.lojas.length === 3, nomes);
  conferir('"plataformas" são canais: Atacado R$ 100 e Varejo R$ 75', perto(p.plataformas.find((x) => x.plataforma === 'Atacado')?.valor, 100) && perto(p.plataformas.find((x) => x.plataforma === 'Varejo')?.valor, 75), p.plataformas);
  conferir('estados vêm do cliente: SP e GO, e 2 de 3 identificados', p.estados.identificados === 2 && p.estados.lista.some((e) => e.uf === 'SP') && p.estados.lista.some((e) => e.uf === 'GO') && p.estados.total === 3, p.estados);
  conferir('ranking traz a referência e o nome do produto', p.topAnuncios.length > 0 && p.topAnuncios.every((a) => a.codigo && a.titulo === 'Camisa Polo Teste'), p.topAnuncios);
  conferir('variação traz referência-cor-tamanho', p.topVariacoes.some((v) => v.codigo === 'OG1620-Preto-M'), p.topVariacoes);
  conferir('venda importada de outro dia não entra na curva (sem hora): ontem tem 1 sem hora', p.semHora.ontem === 1, p.semHora);
  conferir('atualizado-em vem da última leitura do Wik (≈ 12 min)', p.atualizadoEm && Math.abs(Date.now() - new Date(p.atualizadoEm).getTime() - 12 * 60e3) < 60e3, p.atualizadoEm);
  conferir('informa a cadência do Wik (30 min)', p.cadenciaSyncMin === 30, p.cadenciaSyncMin);

  const comFoto = [...p.topAnuncios, ...p.topVariacoes].find((x) => x.foto);
  if (prod?.id) {
    conferir('produto com foto cadastrada aponta para a rota do painel', !!comFoto && comFoto.foto.startsWith('/api/vendas-painel-ao-vivo/foto/'), p.topAnuncios);
    const f = await pedir(porta, 'GET', comFoto.foto, { cookie });
    conferir('a foto abre (200, image/png)', f.status === 200 && /image\/png/.test(f.headers['content-type'] || ''), [f.status, f.headers['content-type']]);
  }
  const fx = await pedir(porta, 'GET', '/api/vendas-painel-ao-vivo/foto/abc', { cookie });
  conferir('id de foto inválido -> 404', fx.status === 404, fx.status);

  // O painel do Marketplace não enxerga venda direta (e vice-versa).
  const mkt = JSON.parse((await pedir(porta, 'GET', '/api/painel-ao-vivo?fresco=1', { cookie })).texto);
  conferir('o painel do Marketplace não soma a venda direta', !mkt.plataformas.some((x) => x.plataforma === 'Atacado'), mkt.plataformas);

  await pool.query(`DELETE FROM pedido_itens WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = $1)`, [MARCA]);
  await pool.query(`DELETE FROM pedidos_venda WHERE observacao = $1`, [MARCA]);
  await pool.query(`DELETE FROM produtos WHERE referencia = 'PVD-REF'`);
  servidor.close();
  await pool.end();
  console.log(`\n${passou} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
