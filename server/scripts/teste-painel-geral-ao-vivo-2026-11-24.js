// Teste do Painel ao vivo GERAL (Análises › Painel ao vivo), 24/11/2026.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-painel-geral-ao-vivo-2026-11-24.js
//
// A conta é a da lib compartilhada. Aqui se confere o que é DESTA rota:
//   · soma marketplace + venda direta (contagens e valores, por diferença
//     contra o que já existia na base);
//   · NÃO conta em dobro: venda direta com canal Shopee/Mercado Livre/TikTok é descartada;
//   · cancelado, devolução e bonificação ficam de fora; pedido em aberto conta;
//   · "lojas" = lojas de marketplace + uma "Venda direta"; plataformas inclui "direta";
//   · ranking por referência junta o mesmo produto dos dois lados;
//   · estados vêm do envio (marketplace) e do cliente (direta);
//   · atualizado-em é o da fonte mais antiga; as duas fontes vêm em fontesSync;
//   · a rota exige o módulo Análises e a foto sai por rota própria.

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-painel-geral';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-painel-geral-secret-com-32-caracteres';
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
    (res) => { const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto: Buffer.concat(partes).toString('utf8') })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

async function main() {
  const criarApp = require('../src/app');
  const pool = require('../src/db/pool');
  const { hojeEmBrasilia } = require('../src/lib/dataBrasil');
  const { somarDias } = require('../src/lib/painelAoVivo');
  const MARCA = 'TESTE-PV-GERAL';

  async function limpar() {
    await pool.query(`DELETE FROM pedido_envio WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = $1)`, [MARCA]);
    await pool.query(`DELETE FROM pedido_itens WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = $1)`, [MARCA]);
    await pool.query(`DELETE FROM pedidos_venda WHERE observacao = $1`, [MARCA]);
    await pool.query(`DELETE FROM clientes WHERE nome LIKE 'Cliente PV-GERAL%'`);
    await pool.query(`DELETE FROM integracoes_marketplace WHERE conta_externa_id = 'pv-geral-ml'`);
    await pool.query(`DELETE FROM empresas WHERE nome = 'Empresa PV-GERAL'`);
    await pool.query(`DELETE FROM produtos WHERE referencia = 'PVG-REF'`);
  }
  await limpar();

  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  const setup = await pedir(porta, 'POST', '/api/auth/setup', { corpo: { nome: 'teste', email: 'teste@exemplo.com', senha: 'roupa azul de verao', appPassword: process.env.APP_PASSWORD } });
  let cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (![200, 201].includes(setup.status)) {
    const login = await pedir(porta, 'POST', '/api/auth/login', { corpo: { nome: 'teste', senha: 'roupa azul de verao' } });
    cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  }

  console.log('\nAcesso');
  const sem = await pedir(porta, 'GET', '/api/analises-painel-ao-vivo');
  conferir('sem login a rota nega', sem.status === 401, sem.status);

  // Base antes de semear (a base de teste pode ter outras vendas de hoje).
  const antes = JSON.parse((await pedir(porta, 'GET', '/api/analises-painel-ao-vivo?fresco=1', { cookie })).texto);

  const hoje = hojeEmBrasilia();
  const ontem = somarDias(hoje, -1);
  const { rows: [emp] } = await pool.query(`INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo) VALUES ('Empresa PV-GERAL', 'Simples Nacional', 0.1, 0, TRUE) RETURNING id`);
  const { rows: [ml] } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo, ultima_sincronizacao)
     VALUES ('mercado_livre', 'Loja PV-GERAL', 'x', 'y', 'pv-geral-ml', $1, 0.6, TRUE, now() - interval '2 minutes') RETURNING id`, [emp.id]);
  const { rowCount } = await pool.query(`UPDATE integracoes_wik SET vendas_ultima_sincronizacao = now() - interval '12 minutes'`);
  if (!rowCount) await pool.query(`INSERT INTO integracoes_wik (email, senha, vendas_ultima_sincronizacao) VALUES ('wik@teste', 'x', now() - interval '12 minutes')`);
  const { rows: [prod] } = await pool.query(`INSERT INTO produtos (referencia) VALUES ('PVG-REF') RETURNING id`);
  await pool.query(`INSERT INTO produto_fotos (produto_id, dados, mime_type, tamanho) VALUES ($1, $2, 'image/png', 4) ON CONFLICT (produto_id) DO NOTHING`, [prod.id, Buffer.from([137, 80, 78, 71])]);
  const cli = async (nome, uf) => (await pool.query(`INSERT INTO clientes (nome, uf) VALUES ($1, $2) RETURNING id`, [`Cliente PV-GERAL ${nome}`, uf])).rows[0].id;
  const cGO = await cli('GO', 'GO');

  let seq = 0;
  async function mkt({ dia, valor, pack = null, situacao = 'aberto', uf = null, ref = 'PVG-REF', anuncio = 'MLB-PVG' }) {
    seq += 1;
    const { rows: [pv] } = await pool.query(
      `INSERT INTO pedidos_venda (data_pedido, canal_venda, origem_marketplace, origem_pedido_id, origem_integracao_id, situacao, pack_id_marketplace, empresa_id, observacao)
       VALUES ($1, 'Mercado Livre', 'mercado_livre', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [dia, `PVG-${Date.now()}-${seq}`, ml.id, situacao, pack, emp.id, MARCA]);
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, valor_unitario, total, anuncio_id_marketplace, titulo_externo, sku_externo, referencia, descricao)
       VALUES ($1, $2, 1, $3, $3, $4, 'Anúncio ML Polo', 'PVG-REF-PRETO-M', $5, 'Camisa Polo Geral')`, [pv.id, ref === 'PVG-REF' ? prod.id : null, valor, anuncio, ref]);
    if (uf) await pool.query(`INSERT INTO pedido_envio (pedido_id, origem_integracao_id, canal, bruto) VALUES ($1, $2, 'mercado_livre', $3::jsonb)`, [pv.id, ml.id, JSON.stringify({ envio: { receiver_address: { state: { id: `BR-${uf}` } } } })]);
  }
  async function dir({ dia, valor, canal = 'Atacado', situacao = 'faturado', operacao = 'Venda', cliente = cGO, ref = 'PVG-REF' }) {
    const { rows: [pv] } = await pool.query(
      `INSERT INTO pedidos_venda (data_pedido, canal_venda, cliente_id, situacao, operacao, total_liquido, observacao) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [dia, canal, cliente, situacao, operacao, valor, MARCA]);
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, produto_id, referencia, cor, tamanho, descricao, quantidade, valor_unitario, total)
       VALUES ($1, $2, $3, 'Preto', 'M', 'Camisa Polo Geral', 1, $4, $4)`, [pv.id, ref === 'PVG-REF' ? prod.id : null, ref, valor]);
  }

  // HOJE — marketplace: um carrinho do ML com 2 pedidos (1 venda, R$ 150) + 1 cancelado.
  await mkt({ dia: hoje, valor: 100, pack: 'PACK-GERAL', uf: 'SP' });
  await mkt({ dia: hoje, valor: 50, pack: 'PACK-GERAL', uf: 'SP' });
  await mkt({ dia: hoje, valor: 999, situacao: 'cancelado' });
  // HOJE — direta: 2 que contam (R$ 70 + R$ 30), mais as que NÃO contam.
  await dir({ dia: hoje, valor: 70, canal: 'Atacado' });
  await dir({ dia: hoje, valor: 30, canal: 'Varejo', situacao: 'aberto' });
  await dir({ dia: hoje, valor: 888, canal: 'Shopee' }); // marketplace digitado: já está no outro lado
  await dir({ dia: hoje, valor: 777, canal: 'Mercado Livre' });
  await dir({ dia: hoje, valor: 666, operacao: 'DEVOLUÇÃO' });
  await dir({ dia: hoje, valor: 555, operacao: 'Bonificação' });
  // ONTEM: 1 marketplace (R$ 60) + 1 direta (R$ 40).
  await mkt({ dia: ontem, valor: 60 });
  await dir({ dia: ontem, valor: 40 });

  console.log('\nO painel geral');
  const r = await pedir(porta, 'GET', '/api/analises-painel-ao-vivo?fresco=1', { cookie });
  conferir('responde 200', r.status === 200, [r.status, r.texto.slice(0, 200)]);
  const p = JSON.parse(r.texto);
  const dPed = p.hojeTotais.pedidos - antes.hojeTotais.pedidos;
  const dVal = p.hojeTotais.valor - antes.hojeTotais.valor;
  conferir('hoje soma 3 vendas (1 carrinho ML + 2 diretas); cancelado, devolução, bonificação e direta "Shopee/ML" ficam de fora', dPed === 3, { dPed });
  conferir('hoje soma R$ 250 (150 do marketplace + 70 + 30 da direta)', perto(dVal, 250), dVal);
  conferir('ontem soma 2 vendas, R$ 100', p.ontemTotais.pedidos - antes.ontemTotais.pedidos === 2 && perto(p.ontemTotais.valor - antes.ontemTotais.valor, 100), [p.ontemTotais, antes.ontemTotais]);
  const lojaDireta = p.lojas.find((l) => l.plataforma === 'direta');
  const lojaML = p.lojas.find((l) => l.nome === 'Loja PV-GERAL');
  const lojaDiretaAntes = antes.lojas.find((l) => l.plataforma === 'direta');
  conferir('"lojas" tem a loja do marketplace e "Venda direta"', !!lojaML && !!lojaDireta && lojaDireta.nome === 'Venda direta', p.lojas);
  conferir('loja de marketplace: 1 venda, R$ 150', lojaML?.pedidos === 1 && perto(lojaML.valor, 150), lojaML);
  conferir('Venda direta: +2 vendas, +R$ 100', lojaDireta.pedidos - (lojaDiretaAntes?.pedidos || 0) === 2 && perto(lojaDireta.valor - (lojaDiretaAntes?.valor || 0), 100), [lojaDireta, lojaDiretaAntes]);
  conferir('rosca por plataforma inclui "direta" e "mercado_livre"', p.plataformas.some((x) => x.plataforma === 'direta') && p.plataformas.some((x) => x.plataforma === 'mercado_livre'), p.plataformas);
  const ref = p.topAnuncios.find((a) => a.codigo === 'PVG-REF');
  conferir('ranking junta o mesmo produto dos dois lados: PVG-REF com 3 vendas', ref?.pedidos === 3, p.topAnuncios);
  conferir('o ranking usa o nome do produto no Hub', ref?.titulo === 'Camisa Polo Geral', ref);
  const ufs = Object.fromEntries(p.estados.lista.map((e) => [e.uf, e.pedidos]));
  const ufsAntes = Object.fromEntries(antes.estados.lista.map((e) => [e.uf, e.pedidos]));
  conferir('estados: SP (envio do marketplace) +1 e GO (cadastro do cliente) +2', (ufs.SP || 0) - (ufsAntes.SP || 0) === 1 && (ufs.GO || 0) - (ufsAntes.GO || 0) === 2, [ufs, ufsAntes]);
  conferir('traz as duas fontes de atualização (Lojas ≈ 2 min, Wik ≈ 12 min)', Array.isArray(p.fontesSync) && p.fontesSync.length === 2
    && Math.abs(Date.now() - new Date(p.fontesSync[0].em).getTime() - 2 * 60e3) < 90e3
    && Math.abs(Date.now() - new Date(p.fontesSync[1].em).getTime() - 12 * 60e3) < 90e3, p.fontesSync);
  conferir('atualizado-em é o da fonte mais antiga (Wik)', Math.abs(Date.now() - new Date(p.atualizadoEm).getTime() - 12 * 60e3) < 90e3, p.atualizadoEm);
  conferir('informa a cadência de 30 min', p.cadenciaSyncMin === 30, p.cadenciaSyncMin);
  conferir('informa quantas vendas diretas de canal marketplace foram descartadas (2)', p.descartadasMarketplace - antes.descartadasMarketplace === 2, [p.descartadasMarketplace, antes.descartadasMarketplace]);

  console.log('\nFoto');
  const comFoto = [...p.topAnuncios, ...p.topVariacoes].find((x) => x.foto && x.codigo && x.codigo.startsWith('PVG-REF'));
  conferir('produto com foto aponta para a rota do painel geral', !!comFoto && comFoto.foto.startsWith('/api/analises-painel-ao-vivo/foto/'), comFoto);
  if (comFoto) {
    const f = await pedir(porta, 'GET', comFoto.foto, { cookie });
    conferir('a foto abre (200, image/png)', f.status === 200 && /image\/png/.test(f.headers['content-type'] || ''), [f.status, f.headers['content-type']]);
  }
  const fx = await pedir(porta, 'GET', '/api/analises-painel-ao-vivo/foto/abc', { cookie });
  conferir('id de foto inválido -> 404', fx.status === 404, fx.status);

  console.log('\nOs outros painéis seguem como eram');
  const pm = JSON.parse((await pedir(porta, 'GET', '/api/painel-ao-vivo?fresco=1', { cookie })).texto);
  conferir('o painel do Marketplace não soma a venda direta', !pm.plataformas.some((x) => x.plataforma === 'direta'), pm.plataformas);

  await limpar();
  servidor.close();
  await pool.end();
  console.log(`\n${passou} ok, ${falhas} falha(s)`);
  process.exit(falhas ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
