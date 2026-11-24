// Pendências de 24/11/2026 — uma suíte para as correções do mesmo patch.
//
//   1. "-0,00%" / "-R$ 0,00": valor que arredonda para zero sai sem sinal
//      (formatador do Hub e o do Explicador do Fechamento).
//   2. Conferência de saldo: "Sem dado" não conta como "fecha".
//   3. Fechamento do Mês: só administrador fecha e reabre o mês.
//   4. Exportação de anúncios pela tela: anúncio SEM VÍNCULO que vendeu vai
//      para a aba FORA DA PLANILHA; filtro "sem vínculo" não exporta o
//      catálogo inteiro.
//   5. Índice em pedido_itens.anuncio_id_marketplace (migration 0108).
//   6. jszip declarado no server/package.json.
//
// Roda contra um Postgres LIMPO, com as migrations aplicadas:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-pendencias-2026-11-24.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-pendencias';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-pendencias-secret-com-32-caracteres-ou-mais';

const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const ExcelJS = require('exceljs');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');

const RAIZ = path.resolve(__dirname, '..', '..');

let falhas = 0;
let oks = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) { oks += 1; console.log(`  ok   ${descricao}`); } else { falhas += 1; console.log(`  FALHA ${descricao}${detalhe !== undefined ? ` — ${typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)}` : ''}`); }
}

function chamar(porta, caminho, { metodo = 'GET', dados, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const body = dados ? JSON.stringify(dados) : null;
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => {
        const corpo = Buffer.concat(partes);
        let json = null;
        try { json = JSON.parse(corpo.toString('utf8')); } catch { /* binário */ }
        resolve({ status: res.statusCode, headers: res.headers, corpo, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const cookieDe = (r) => (r.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

async function main() {
  // ------------------------------------------------------------------
  console.log('\n1. Zero arredondado sai sem sinal');
  const fmt = await import(pathToFileURL(path.join(RAIZ, 'client', 'src', 'lib', 'format.js')).href);
  conferir('brl(−0,004) = "R$ 0,00" (antes "-R$ 0,00")', fmt.brl(-0.004).replace(/\s/g, ' ') === 'R$ 0,00', fmt.brl(-0.004));
  conferir('pct(−0,00001) = "0,0%"', fmt.pct(-0.00001) === '0,0%', fmt.pct(-0.00001));
  conferir('pct(−0,00001, 2) = "0,00%"', fmt.pct(-0.00001, 2) === '0,00%', fmt.pct(-0.00001, 2));
  conferir('numeroBr(−0,001) = "0,00"', fmt.numeroBr(-0.001) === '0,00', fmt.numeroBr(-0.001));
  conferir('negativo de verdade continua negativo: brl(−0,01)', fmt.brl(-0.01).replace(/\s/g, ' ') === '-R$ 0,01', fmt.brl(-0.01));
  conferir('negativo de verdade continua negativo: pct(−0,0005, 2) = "-0,05%"', fmt.pct(-0.0005, 2) === '-0,05%', fmt.pct(-0.0005, 2));
  conferir('brl com casas: brl(−0,00004, 4) = "R$ 0,0000"', fmt.brl(-0.00004, 4).replace(/\s/g, ' ') === 'R$ 0,0000', fmt.brl(-0.00004, 4));

  // O Explicador é um HTML que abre fora do Hub e tem o próprio formatador.
  const html = fs.readFileSync(path.join(RAIZ, 'server', 'src', 'templates', 'explicador-fechamento.html'), 'utf8');
  const linhas = html.split('\n').filter((l) => /^const (semMenosZero|brl|nbr|pctTxt) = /.test(l));
  conferir('o Explicador define semMenosZero, brl, nbr e pctTxt', linhas.length === 4, linhas.length);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${linhas.join('\n')}\nthis.f = { brl, nbr, pctTxt };`, ctx);
  conferir('Explicador: pctTxt(−0,001) = "0,00%" (era "-0,00%")', ctx.f.pctTxt(-0.001) === '0,00%', ctx.f.pctTxt(-0.001));
  conferir('Explicador: pctTxt(−0,001, 1) = "0,0%"', ctx.f.pctTxt(-0.001, 1) === '0,0%', ctx.f.pctTxt(-0.001, 1));
  conferir('Explicador: brl(−0,003) = "R$ 0,00"', ctx.f.brl(-0.003).replace(/\s/g, ' ') === 'R$ 0,00', ctx.f.brl(-0.003));
  conferir('Explicador: pctTxt(−1,25) continua "-1,25%"', ctx.f.pctTxt(-1.25) === '-1,25%', ctx.f.pctTxt(-1.25));
  conferir('Explicador: null continua "—"', ctx.f.pctTxt(null) === '—');

  // ------------------------------------------------------------------
  console.log('\n2. Conferência de saldo: "Sem dado" não é "fecha"');
  const cs = await import(pathToFileURL(path.join(RAIZ, 'client', 'src', 'lib', 'conferenciaSaldo.js')).href);
  const meses = [{ fechado: true }, { fechado: false, diferenca: 3.2 }, { fechado: null }, { fechado: true }, {}];
  const c = cs.contarSituacoes(meses);
  conferir('2 fecham (só os comparados que fecharam)', c.fecham.length === 2, c.fecham.length);
  conferir('1 não fecha', c.naoFecham.length === 1, c.naoFecham.length);
  conferir('⚠️ 2 sem dado (null e sem o campo) — antes contavam como "fecha"', c.semDado.length === 2, c.semDado.length);
  conferir('as três somam o total', c.fecham.length + c.naoFecham.length + c.semDado.length === c.total);
  conferir('situação de null = sem_dado', cs.situacaoDoMes({ fechado: null }) === 'sem_dado');
  conferir('rótulo "Sem dado" com chip neutro (cinza sólido no módulo vivo)', cs.SITUACAO_SALDO.sem_dado.rotulo === 'Sem dado' && cs.SITUACAO_SALDO.sem_dado.tom === 'tone-neutro');
  const pagina = fs.readFileSync(path.join(RAIZ, 'client', 'src', 'pages', 'FinanceiroPage.jsx'), 'utf8');
  conferir('a tela não calcula mais "fecham" como total − não fecham', !pagina.includes('meses.length - ruins.length'));
  conferir('a tela tem o cartão "Sem dado para conferir"', pagina.includes('rotulo="Sem dado para conferir"'));

  // ------------------------------------------------------------------
  const servidor = http.createServer(criarApp());
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;
  try {
    const credAdmin = { nome: 'admin-pend', senha: 'senha do admin 123' };
    let auth = await chamar(porta, '/api/auth/setup', { metodo: 'POST', dados: { ...credAdmin, email: 'admin-pend@exemplo.com', appPassword: process.env.APP_PASSWORD } });
    if (auth.status === 409) auth = await chamar(porta, '/api/auth/login', { metodo: 'POST', dados: credAdmin });
    if (![200, 201].includes(auth.status)) throw new Error(`setup falhou: ${auth.status} ${auth.corpo}`);
    const admin = cookieDe(auth);

    const credLim = { nome: 'Financeiro Pend', senha: 'senha da equipe 123' };
    const cria = await chamar(porta, '/api/usuarios', {
      metodo: 'POST', cookie: admin,
      dados: { ...credLim, email: 'fin-pend@exemplo.com', role: 'limitado', modulos: ['financeiro', 'marketplace'] },
    });
    conferir('usuário limitado com Financeiro criado', cria.status === 201, `${cria.status} ${cria.corpo}`);
    const loginLim = await chamar(porta, '/api/auth/login', { metodo: 'POST', dados: credLim });
    conferir('usuário limitado entra', loginLim.status === 200, loginLim.status);
    const limitado = cookieDe(loginLim);

    // ----------------------------------------------------------------
    console.log('\n3. Fechamento do Mês: só administrador fecha e reabre');
    const mes = '2024-03';
    const ver = await chamar(porta, `/api/financeiro-fechamento?unidade=marketplace&mes=${mes}`, { cookie: limitado });
    conferir('limitado continua VENDO o fechamento (200)', ver.status === 200, ver.status);
    const fLim = await chamar(porta, '/api/financeiro-fechamento/mes/fechar', { metodo: 'POST', cookie: limitado, dados: { unidade: 'marketplace', mes } });
    conferir('⚠️ limitado NÃO fecha o mês (403)', fLim.status === 403, `${fLim.status} ${fLim.corpo}`);
    conferir('…com mensagem clara', /administrador/i.test(fLim.json?.error || ''), fLim.json?.error);
    const depoisLim = await chamar(porta, `/api/financeiro-fechamento?unidade=marketplace&mes=${mes}`, { cookie: admin });
    conferir('…e o mês continua aberto', depoisLim.json && !depoisLim.json.fechado, depoisLim.json?.fechado);
    // Fechar exige o saldo de abertura (regra do Fechamento, não desta trava).
    const abre = await chamar(porta, '/api/financeiro-fechamento/mes', { metodo: 'PUT', cookie: limitado, dados: { unidade: 'marketplace', mes, saldo_inicial: 1000 } });
    conferir('limitado ainda informa o saldo de abertura (200)', abre.status === 200, `${abre.status} ${abre.corpo}`);
    const fAdm = await chamar(porta, '/api/financeiro-fechamento/mes/fechar', { metodo: 'POST', cookie: admin, dados: { unidade: 'marketplace', mes } });
    conferir('administrador fecha o mês (200)', fAdm.status === 200, `${fAdm.status} ${fAdm.corpo}`);
    const fechado = await chamar(porta, `/api/financeiro-fechamento?unidade=marketplace&mes=${mes}`, { cookie: limitado });
    conferir('limitado vê o mês fechado', fechado.json?.fechado === true, fechado.json?.fechado);
    const rLim = await chamar(porta, '/api/financeiro-fechamento/mes/reabrir', { metodo: 'POST', cookie: limitado, dados: { unidade: 'marketplace', mes } });
    conferir('⚠️ limitado NÃO reabre o mês (403)', rLim.status === 403, `${rLim.status} ${rLim.corpo}`);
    const rAdm = await chamar(porta, '/api/financeiro-fechamento/mes/reabrir', { metodo: 'POST', cookie: admin, dados: { unidade: 'marketplace', mes } });
    conferir('administrador reabre (200)', rAdm.status === 200, `${rAdm.status} ${rAdm.corpo}`);
    const telaFech = fs.readFileSync(path.join(RAIZ, 'client', 'src', 'pages', 'FechamentoMesPage.jsx'), 'utf8');
    conferir('a tela só mostra Fechar/Reabrir para administrador', telaFech.includes('!consolidado && souAdmin && (fechado'));

    // ----------------------------------------------------------------
    console.log('\n4. Exportação de anúncios pela tela: sem vínculo vai para FORA DA PLANILHA');
    const { rows: [empresa] } = await pool.query(
      `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('Origem Pend', 'Simples Nacional', 0.06) RETURNING id`
    );
    const { rows: [prod] } = await pool.query(
      `INSERT INTO produtos (referencia, descricao, empresa_id, marketplace) VALUES ('OG7001', 'CAMISETA PENDENCIA', $1, TRUE) RETURNING id`,
      [empresa.id]
    );
    await pool.query('INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, $2, $3)', [prod.id, 'costura', 10]);
    const { rows: [loja] } = await pool.query(
      `INSERT INTO integracoes_marketplace (marketplace, nome, ativo, access_token, conta_externa_id, empresa_id)
       VALUES ('shopee', 'Origem Pend', TRUE, 'tk', 'PEND', $1) RETURNING id`, [empresa.id]
    );
    const anuncio = async (id, titulo, sku, produtoId) => (await pool.query(
      `INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, sku_externo, produto_id, preco, estoque, status)
       VALUES ($1, 'shopee', $2, $3, $4, $5, 59.9, 10, 'ativo') RETURNING id`,
      [loja.id, id, titulo, sku, produtoId]
    )).rows[0].id;
    await anuncio('AN-VINC', 'Camiseta pendencia vinculada', 'OG7001', prod.id);
    await anuncio('AN-SEMV', 'Camiseta sem vinculo que vendeu', 'XYZ-999', null);
    await anuncio('AN-SEMV-PARADO', 'Camiseta sem vinculo parada', 'XYZ-000', null);

    const { rows: [cli] } = await pool.query("INSERT INTO clientes (nome) VALUES ('Cliente Pend') RETURNING id");
    const vender = async (n, anuncioExterno, produtoId) => {
      const { rows: [pv] } = await pool.query(
        `INSERT INTO pedidos_venda (cliente_id, empresa_id, data_pedido, situacao, canal_venda, origem_marketplace, origem_pedido_id, origem_integracao_id)
         VALUES ($1, $2, CURRENT_DATE - 2, 'faturado', 'Shopee', 'shopee', $3, $4) RETURNING id`,
        [cli.id, empresa.id, `PEND-${n}`, loja.id]
      );
      await pool.query(
        `INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, valor_unitario, total, anuncio_id_marketplace, sku_externo)
         VALUES ($1, $2, 1, 59.9, 59.9, $3, $4)`,
        [pv.id, produtoId, anuncioExterno, produtoId ? 'OG7001' : 'XYZ-999']
      );
    };
    await vender(1, 'AN-VINC', prod.id);
    await vender(2, 'AN-SEMV', null);

    const ler = async (r) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.corpo); return wb; };
    const textoDaAba = (aba) => {
      const t = [];
      aba.eachRow((row) => row.eachCell((cel) => t.push(String(cel.value?.richText ? cel.value.richText.map((x) => x.text).join('') : cel.value ?? ''))));
      return t.join(' | ');
    };

    // Exportação COM filtro de tela (busca): antes, a lista de produtos ia
    // sozinha e o anúncio sem vínculo nunca chegava à exportação.
    const r1 = await chamar(porta, '/api/anuncios/exportacao/planilha?busca=Camiseta', { cookie: admin });
    conferir('exportação pela tela responde 200', r1.status === 200, `${r1.status} ${r1.corpo.toString().slice(0, 200)}`);
    if (r1.status === 200) {
      const wb = await ler(r1);
      const fora = wb.getWorksheet('FORA DA PLANILHA');
      conferir('⚠️ a aba FORA DA PLANILHA existe', Boolean(fora), wb.worksheets.map((w) => w.name));
      const txt = fora ? textoDaAba(fora) : '';
      conferir('⚠️ …com o anúncio sem vínculo que vendeu (AN-SEMV)', txt.includes('AN-SEMV') && txt.includes('não está vinculado'), txt.slice(0, 300));
      conferir('…e sem o sem vínculo que não vendeu', !txt.includes('AN-SEMV-PARADO'));
      conferir('a referência vinculada continua na Planilha1', textoDaAba(wb.getWorksheet('Planilha1')).includes('OG7001'));
    }

    // Filtro "só sem vínculo": antes a lista de produtos vinha vazia, virava
    // `null` e a exportação trazia o catálogo INTEIRO.
    const r2 = await chamar(porta, '/api/anuncios/exportacao/planilha?vinculo=sem', { cookie: admin });
    conferir('exportação "sem vínculo" responde 200', r2.status === 200, r2.status);
    if (r2.status === 200) {
      const wb = await ler(r2);
      conferir('⚠️ "sem vínculo" NÃO traz a referência vinculada (catálogo inteiro)', !textoDaAba(wb.getWorksheet('Planilha1')).includes('OG7001'));
      const fora = wb.getWorksheet('FORA DA PLANILHA');
      conferir('…e traz o sem vínculo que vendeu em FORA DA PLANILHA', Boolean(fora) && textoDaAba(fora).includes('AN-SEMV'));
    }

    // Sem nenhum filtro, nada muda: a vinculada e o sem vínculo que vendeu.
    const r3 = await chamar(porta, '/api/anuncios/exportacao/planilha', { cookie: admin });
    if (r3.status === 200) {
      const wb = await ler(r3);
      conferir('sem filtro: vinculada na Planilha1', textoDaAba(wb.getWorksheet('Planilha1')).includes('OG7001'));
      conferir('sem filtro: sem vínculo em FORA DA PLANILHA', Boolean(wb.getWorksheet('FORA DA PLANILHA')) && textoDaAba(wb.getWorksheet('FORA DA PLANILHA')).includes('AN-SEMV'));
    } else conferir('exportação sem filtro responde 200', false, r3.status);

    // Teste de impressão (24/11/2026, planilha convertida em PDF A4): o "%" do
    // kit saía "#DIV/0!" na loja sem valor recebido.
    const libExp = fs.readFileSync(path.join(RAIZ, 'server', 'src', 'lib', 'anunciosExportacao.js'), 'utf8');
    conferir('"%" do kit não divide por V. RECE. vazio (sem #DIV/0! na impressão)', libExp.includes('IF(N(M${linha})=0,"",(P${linha}/M${linha})*100)'));
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }

  // ------------------------------------------------------------------
  console.log('\n5. Índice em pedido_itens.anuncio_id_marketplace');
  const { rows: idx } = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'pedido_itens' AND indexname = 'idx_pedido_itens_anuncio_marketplace'`
  );
  conferir('o índice existe', idx.length === 1);
  conferir('…na coluna certa e parcial (sem os itens sem anúncio)', idx[0] && /anuncio_id_marketplace/.test(idx[0].indexdef) && /IS NOT NULL/.test(idx[0].indexdef), idx[0]?.indexdef);

  // ------------------------------------------------------------------
  console.log('\n6. jszip declarado no servidor');
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'server', 'package.json'), 'utf8'));
  conferir('server/package.json declara o jszip (usado em lib/excelGraficos.js)', Boolean(pkg.dependencies?.jszip), pkg.dependencies?.jszip);
  const lock = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package-lock.json'), 'utf8'));
  conferir('…e o package-lock também', Boolean(lock.packages?.server?.dependencies?.jszip));

  console.log(`\n${oks} ok, ${falhas} falha(s).`);
  await pool.end();
  process.exit(falhas ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch { /* */ }
  process.exit(1);
});
