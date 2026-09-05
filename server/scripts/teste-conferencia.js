/*
 * Teste da Conferência de Pedidos (expedição) — 05/09/2026.
 *
 * Roda contra um Postgres LIMPO, como os outros scripts do repositório:
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-conferencia.js
 *
 * Sobe o app de verdade numa porta livre e conversa com ele por HTTP, com
 * DUAS pessoas logadas ao mesmo tempo — é o único jeito de testar a trava de
 * "duas bancadas no mesmo pedido", que é a parte que mais importa.
 */

require('dotenv').config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'liberacao-de-teste-123';

const createApp = require('../src/app');
const pool = require('../src/db/pool');

let passou = 0;
let falhou = 0;
const falhas = [];

function ok(titulo, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✓ ${titulo}`); } else {
    falhou += 1;
    falhas.push(titulo + (detalhe ? ` — ${detalhe}` : ''));
    console.log(`  ✗ ${titulo}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}
function secao(nome) { console.log(`\n${nome}`); }

const SENHA = 'trigo azul de setembro';

// ---------------------------------------------------------------------------
// Cenário: três pedidos de marketplace, cobrindo os casos que existem de
// verdade no galpão — peça avulsa, kit, peça sem EAN e item que nunca foi
// vinculado a produto (só o SKU do anúncio).
// ---------------------------------------------------------------------------
async function semear() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: emp } = await c.query("INSERT INTO empresas (nome) VALUES ('Origem') RETURNING id");
    const { rows: prodA } = await c.query("INSERT INTO produtos (referencia, descricao) VALUES ('OG1620', 'Camiseta Dry Fit') RETURNING id");
    const { rows: prodB } = await c.query("INSERT INTO produtos (referencia, descricao) VALUES ('VM034', 'Moletom') RETURNING id");

    // Variantes COM EAN (o caminho normal)
    const { rows: vA1 } = await c.query(
      "INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1,'PRETO','M','7890000000017',10) RETURNING id",
      [prodA[0].id]
    );
    const { rows: vA2 } = await c.query(
      "INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1,'PRETO','G','7890000000024',10) RETURNING id",
      [prodA[0].id]
    );
    // Variante SEM EAN — força o caminho "confirmar no olho"
    const { rows: vB1 } = await c.query(
      "INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1,'MARINHO','G',NULL,10) RETURNING id",
      [prodB[0].id]
    );

    // EAN que só existe no mapeamento importado do Wik (variante ainda sem
    // EAN gravado) — tem que resolver mesmo assim.
    await c.query(
      "INSERT INTO estoque_ean_mapeamento (referencia, cor, tamanho, ean) VALUES ('VM034','MARINHO','G','7890000000031')"
    );

    // Kit de 3 peças da mesma variação
    const { rows: kit } = await c.query("INSERT INTO kits_manuais (nome) VALUES ('KIT-3-OG1620-PRETO-M') RETURNING id");
    await c.query('INSERT INTO kits_manuais_itens (kit_id, produto_id, quantidade) VALUES ($1,$2,3)', [kit[0].id, prodA[0].id]);

    const { rows: cli } = await c.query("INSERT INTO clientes (nome) VALUES ('Comprador Shopee') RETURNING id");

    // PEDIDO 1 — duas peças avulsas, com etiqueta de rastreio
    const { rows: p1 } = await c.query(
      `INSERT INTO pedidos_venda (cliente_id, empresa_id, canal_venda, origem_marketplace, origem_pedido_id, codigos_rastreio, quantidade_pecas)
       VALUES ($1,$2,'Shopee','shopee','2409SHOPEE001', ARRAY['SPXBR0001'], 3) RETURNING id, numero`,
      [cli[0].id, emp[0].id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, ordem)
       VALUES ($1,$2,$3,'OG1620','Camiseta Dry Fit','PRETO','M',2,1)`,
      [p1[0].id, vA1[0].id, prodA[0].id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, ordem)
       VALUES ($1,$2,$3,'OG1620','Camiseta Dry Fit','PRETO','G',1,2)`,
      [p1[0].id, vA2[0].id, prodA[0].id]
    );

    // PEDIDO 2 — um kit (1 linha, 3 peças) + uma peça sem EAN. SEM etiqueta.
    const { rows: p2 } = await c.query(
      `INSERT INTO pedidos_venda (cliente_id, empresa_id, canal_venda, origem_marketplace, origem_pedido_id, quantidade_pecas)
       VALUES ($1,$2,'Mercado Livre','mercado_livre','ML2000000002', 4) RETURNING id, numero`,
      [cli[0].id, emp[0].id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, kit_id, referencia, descricao, cor, tamanho, quantidade, sku_externo, ordem)
       VALUES ($1,$2,$3,$4,'OG1620','Kit 3 camisetas','PRETO','M',1,'KIT-3-OG1620-PRETO-M',1)`,
      [p2[0].id, vA1[0].id, prodA[0].id, kit[0].id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, ordem)
       VALUES ($1,$2,$3,'VM034','Moletom','MARINHO','G',1,2)`,
      [p2[0].id, vB1[0].id, prodB[0].id]
    );

    // PEDIDO 3 — item NUNCA vinculado a produto: só o SKU do anúncio.
    const { rows: p3 } = await c.query(
      `INSERT INTO pedidos_venda (cliente_id, empresa_id, canal_venda, origem_marketplace, origem_pedido_id, codigos_rastreio, quantidade_pecas)
       VALUES ($1,$2,'TikTok Shop','tiktok_shop','TT300003', ARRAY['TTBR0003'], 1) RETURNING id, numero`,
      [cli[0].id, emp[0].id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, referencia, descricao, quantidade, sku_externo, titulo_externo, ordem)
       VALUES ($1,'OG1620-PRETO-G','Camiseta preta G',1,'OG1620-PRETO-G','Camiseta Dry Fit Preta G',1)`,
      [p3[0].id]
    );

    await c.query('COMMIT');
    return { p1: p1[0], p2: p2[0], p3: p3[0] };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  const dados = await semear();
  const app = createApp();
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  function novaSessao() {
    const estado = { cookie: '' };
    return async function chamar(caminho, { metodo = 'GET', corpo } = {}) {
      const headers = { 'Content-Type': 'application/json', Origin: base };
      if (estado.cookie) headers.Cookie = estado.cookie;
      const res = await fetch(base + caminho, {
        method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
      const set = res.headers.get('set-cookie');
      if (set) estado.cookie = set.split(';')[0];
      let d = null;
      try { d = await res.json(); } catch { /* sem corpo */ }
      return { status: res.status, dados: d };
    };
  }

  const ana = novaSessao();
  const bruno = novaSessao();
  const semAcesso = novaSessao();

  try {
    // -----------------------------------------------------------------
    secao('1. Acesso');
    // -----------------------------------------------------------------
    await ana('/api/auth/setup', { metodo: 'POST', corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Ana', email: 'a@a.com', senha: SENHA } });
    await ana('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Bruno', email: 'b@b.com', senha: SENHA, role: 'limitado', modulos: ['marketplace'] } });
    await ana('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Davi', email: 'd@d.com', senha: SENHA, role: 'limitado', modulos: ['estoque'] } });
    await bruno('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Bruno', senha: SENHA } });
    await semAcesso('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Davi', senha: SENHA } });

    ok('quem tem o módulo Marketplace entra na conferência', (await bruno('/api/conferencia/fila')).status === 200);
    ok('quem não tem o módulo é barrado', (await semAcesso('/api/conferencia/fila')).status === 403);

    // -----------------------------------------------------------------
    secao('2. Abrir a caixa — os três jeitos de identificar o pedido');
    // -----------------------------------------------------------------
    const porEtiqueta = await bruno('/api/conferencia/abrir/SPXBR0001');
    ok('abre bipando a etiqueta de envio', porEtiqueta.status === 200 && porEtiqueta.dados.via === 'rastreio');
    ok('e já diz quantas peças a caixa deve levar', porEtiqueta.dados.esperadoTotal === 3, `veio ${porEtiqueta.dados?.esperadoTotal}`);

    const porNumeroPlataforma = await bruno('/api/conferencia/abrir/ML2000000002');
    ok('abre pelo número do pedido na plataforma', porNumeroPlataforma.status === 200 && porNumeroPlataforma.dados.via === 'pedido_plataforma');
    ok('kit conta como 3 peças, não como 1 linha',
      porNumeroPlataforma.dados.esperadoTotal === 4, `veio ${porNumeroPlataforma.dados?.esperadoTotal}`);
    const itemKit = porNumeroPlataforma.dados.itens.find((i) => i.ehKit);
    ok('a linha do kit aparece marcada como kit de 3', itemKit && itemKit.pecasPorUnidade === 3 && itemKit.esperado === 3);
    const itemSemEan = porNumeroPlataforma.dados.itens.find((i) => i.semEan);
    ok('a peça sem EAN cadastrado vem sinalizada pra tela', Boolean(itemSemEan));

    const porInterno = await bruno(`/api/conferencia/abrir/${dados.p1.numero}`);
    ok('abre pelo número interno do sistema', porInterno.status === 200 && porInterno.dados.via === 'numero_interno');

    const inexistente = await bruno('/api/conferencia/abrir/NAOEXISTE123');
    ok('código que não é de nenhum pedido dá 404 com explicação', inexistente.status === 404
      && /vincular esta etiqueta/i.test(inexistente.dados.error));

    // -----------------------------------------------------------------
    secao('3. Bipar peça — os quatro desfechos');
    // -----------------------------------------------------------------
    const iniciou = await bruno(`/api/conferencia/pedidos/${dados.p1.id}/iniciar`, { metodo: 'POST' });
    ok('conferência iniciada', iniciou.status === 201);
    const conf1 = iniciou.dados.conferencia.id;

    const certa = await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000017' } });
    ok('peça do pedido é aceita', certa.dados.leitura.resultado === 'ok');
    ok('e o contador anda', certa.dados.conferidoTotal === 1, `veio ${certa.dados?.conferidoTotal}`);

    const desconhecida = await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '0000000000000' } });
    ok('código que o sistema não conhece é recusado', desconhecida.dados.leitura.resultado === 'ean_desconhecido');
    ok('e a recusa NÃO conta como peça conferida', desconhecida.dados.conferidoTotal === 1);

    const deOutroPedido = await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000031' } });
    ok('peça que existe mas não é deste pedido é recusada', deOutroPedido.dados.leitura.resultado === 'fora_do_pedido');
    ok('e a mensagem manda NÃO colocar na caixa', /não coloque na caixa/i.test(deOutroPedido.dados.leitura.mensagem));

    await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000017' } });
    const excedeu = await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000017' } });
    ok('peça a mais da mesma variação é recusada', excedeu.dados.leitura.resultado === 'quantidade_excedida');
    ok('e o contador não passa do esperado', excedeu.dados.conferidoTotal === 2, `veio ${excedeu.dados?.conferidoTotal}`);

    // -----------------------------------------------------------------
    secao('4. Desfazer — o que faltava na ferramenta antiga');
    // -----------------------------------------------------------------
    const desfez = await bruno(`/api/conferencia/${conf1}/desfazer`, { metodo: 'POST' });
    ok('desfazer volta o contador', desfez.dados.conferidoTotal === 1, `veio ${desfez.dados?.conferidoTotal}`);
    const { rows: rastro } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM conferencia_leituras WHERE conferencia_id = $1 AND resultado = 'desfeita'", [conf1]
    );
    ok('mas a leitura desfeita continua no histórico (não some)', rastro[0].n === 1);
    await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000017' } });

    // -----------------------------------------------------------------
    secao('5. Fechar a caixa');
    // -----------------------------------------------------------------
    const cedoDemais = await bruno(`/api/conferencia/${conf1}/concluir`, { metodo: 'POST', corpo: {} });
    ok('não deixa fechar com peça faltando', cedoDemais.status === 400 && cedoDemais.dados.incompleto === true);
    ok('e diz quantas faltam', /falta/i.test(cedoDemais.dados.error));

    const forcadoSemMotivo = await bruno(`/api/conferencia/${conf1}/concluir`, { metodo: 'POST', corpo: { forcar: true } });
    ok('forçar sem escrever o motivo é recusado', forcadoSemMotivo.status === 400);

    await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000024' } });
    const completo = await bruno(`/api/conferencia/${conf1}/concluir`, { metodo: 'POST', corpo: {} });
    ok('caixa completa fecha', completo.status === 200 && completo.dados.completo === true);
    ok('e sai SEM divergência', completo.dados.houveDivergencia === false);

    const deNovo = await bruno('/api/conferencia/abrir/SPXBR0001');
    ok('abrir de novo avisa que JÁ FOI CONFERIDO', deNovo.status === 409 && deNovo.dados.jaConferido === true);
    ok('e diz quem conferiu e quando', /conferido em/i.test(deNovo.dados.error) && /Bruno/.test(deNovo.dados.error));

    // -----------------------------------------------------------------
    secao('6. Duas bancadas no mesmo pedido');
    // -----------------------------------------------------------------
    const brunoAbriu = await bruno(`/api/conferencia/pedidos/${dados.p2.id}/iniciar`, { metodo: 'POST' });
    ok('Bruno abre o pedido 2', brunoAbriu.status === 201);
    const anaTenta = await ana(`/api/conferencia/pedidos/${dados.p2.id}/iniciar`, { metodo: 'POST' });
    ok('Ana recebe a MESMA conferência, não cria uma segunda',
      anaTenta.status === 201 && anaTenta.dados.conferencia.id === brunoAbriu.dados.conferencia.id);
    const { rows: quantas } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM conferencias_pedido WHERE pedido_id = $1 AND situacao = 'em_andamento'", [dados.p2.id]
    );
    ok('só existe uma conferência aberta pro pedido', quantas[0].n === 1);

    // -----------------------------------------------------------------
    secao('7. Kit, EAN do mapeamento do Wik e confirmação no olho');
    // -----------------------------------------------------------------
    const conf2 = brunoAbriu.dados.conferencia.id;
    let estado = null;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      estado = await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000017' } });
    }
    ok('as 3 peças do kit entram na mesma linha', estado.dados.conferidoTotal === 3, `veio ${estado.dados?.conferidoTotal}`);
    const quarta = await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000017' } });
    ok('a quarta peça do kit é recusada', quarta.dados.leitura.resultado === 'quantidade_excedida');

    // A peça VM034 MARINHO G não tem EAN na variante, mas TEM no mapeamento
    // do Wik — o sistema tem que resolver por ali.
    const viaMapeamento = await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000031' } });
    ok('EAN que só existe no mapeamento importado do Wik funciona',
      viaMapeamento.dados.leitura.resultado === 'ok', JSON.stringify(viaMapeamento.dados?.leitura));
    ok('e a caixa fica completa', viaMapeamento.dados.completo === true);

    const fechou2 = await bruno(`/api/conferencia/${conf2}/concluir`, { metodo: 'POST', corpo: {} });
    ok('pedido com kit fecha sem divergência', fechou2.status === 200 && fechou2.dados.houveDivergencia === false);

    // -----------------------------------------------------------------
    secao('8. Item que nunca foi vinculado a produto (só o SKU do anúncio)');
    // -----------------------------------------------------------------
    const p3 = await bruno(`/api/conferencia/pedidos/${dados.p3.id}/iniciar`, { metodo: 'POST' });
    const conf3 = p3.dados.conferencia.id;
    const porSku = await bruno(`/api/conferencia/${conf3}/leitura`, { metodo: 'POST', corpo: { codigo: '7890000000024' } });
    ok('casa a peça pelo SKU do anúncio ("OG1620-PRETO-G")',
      porSku.dados.leitura.resultado === 'ok', JSON.stringify(porSku.dados?.leitura));

    // -----------------------------------------------------------------
    secao('9. Vincular etiqueta — o galpão construindo o dado que falta');
    // -----------------------------------------------------------------
    const semEtiqueta = await bruno('/api/conferencia/abrir/BR9999NOVA');
    ok('etiqueta desconhecida ainda não abre nada', semEtiqueta.status === 404);
    const vinculou = await bruno(`/api/conferencia/pedidos/${dados.p2.id}/vincular-rastreio`, { metodo: 'POST', corpo: { codigo: 'br9999nova' } });
    ok('vincular a etiqueta ao pedido funciona', vinculou.status === 200);
    ok('e ela é guardada em maiúscula', vinculou.dados.codigos_rastreio.includes('BR9999NOVA'));
    const roubar = await ana(`/api/conferencia/pedidos/${dados.p3.id}/vincular-rastreio`, { metodo: 'POST', corpo: { codigo: 'BR9999NOVA' } });
    ok('etiqueta de outro pedido NÃO é roubada em silêncio', roubar.status === 409 && /já está no pedido/i.test(roubar.dados.error));

    // -----------------------------------------------------------------
    secao('10. Fechar incompleto — permitido, mas registrado');
    // -----------------------------------------------------------------
    const forcado = await bruno(`/api/conferencia/${conf3}/concluir`, { metodo: 'POST', corpo: {} });
    ok('o pedido 3 já estava completo, fecha normal', forcado.status === 200);

    // -----------------------------------------------------------------
    secao('11. O que a conferência NÃO faz (REGRA 1 e REGRA 4)');
    // -----------------------------------------------------------------
    const { rows: pedidoDepois } = await pool.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [dados.p1.id]);
    ok('conferir NÃO muda a situação do pedido', pedidoDepois[0].situacao === 'aberto', pedidoDepois[0].situacao);
    const { rows: saldo } = await pool.query(
      "SELECT quantidade FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE p.referencia = 'OG1620' AND v.tamanho = 'M'"
    );
    ok('conferir NÃO dá baixa de estoque', Number(saldo[0].quantidade) === 10, `saldo ${saldo[0].quantidade}`);
    const { rows: mov } = await pool.query("SELECT COUNT(*)::int AS n FROM estoque_movimentos");
    ok('e não gera movimento de estoque nenhum', mov[0].n === 0, `${mov[0].n} movimentos`);

    // -----------------------------------------------------------------
    secao('12. Fila e relatório');
    // -----------------------------------------------------------------
    const hoje = new Date().toISOString().slice(0, 10);
    const fila = await bruno(`/api/conferencia/fila?de=${hoje}&ate=${hoje}`);
    ok('a fila do dia lista os três pedidos', fila.dados.pedidos.length === 3, `veio ${fila.dados?.pedidos?.length}`);
    ok('e mostra o estado da conferência de cada um',
      fila.dados.pedidos.every((p) => p.conferencia?.situacao === 'concluida'));

    const rel = await bruno(`/api/conferencia/relatorio?de=${hoje}&ate=${hoje}`);
    ok('o relatório conta os pedidos conferidos', rel.dados.conferidos === 3, `veio ${rel.dados?.conferidos}`);
    ok('conta os que saíram de primeira', rel.dados.sem_divergencia === 3, `veio ${rel.dados?.sem_divergencia}`);
    ok('lista as recusas por tipo', rel.dados.recusas.length >= 2, JSON.stringify(rel.dados?.recusas));
    ok('e devolve os códigos desconhecidos como fila de trabalho do EAN',
      rel.dados.eansDesconhecidos.some((e) => e.codigo === '0000000000000'));
    ok('o relatório sabe quem conferiu', rel.dados.porPessoa.some((p) => p.usuario_nome === 'Bruno'));

    // -----------------------------------------------------------------
    secao('13. Confirmação no olho marca divergência');
    // -----------------------------------------------------------------
    const { rows: p4 } = await pool.query(
      `INSERT INTO pedidos_venda (canal_venda, origem_marketplace, origem_pedido_id, quantidade_pecas)
       VALUES ('Shopee','shopee','2409SHOPEE009', 1) RETURNING id`
    );
    const { rows: vSemEan } = await pool.query(
      "SELECT v.id FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE p.referencia = 'VM034' LIMIT 1"
    );
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, referencia, descricao, cor, tamanho, quantidade, ordem)
       VALUES ($1,$2,'VM034','Moletom','MARINHO','G',1,1)`,
      [p4[0].id, vSemEan[0].id]
    );
    const conf4resp = await bruno(`/api/conferencia/pedidos/${p4[0].id}/iniciar`, { metodo: 'POST' });
    const conf4 = conf4resp.dados.conferencia.id;
    const itemManual = conf4resp.dados.itens[0];
    const manual = await bruno(`/api/conferencia/${conf4}/confirmar-manual`, { metodo: 'POST', corpo: { pedido_item_id: itemManual.id } });
    ok('confirmar no olho conta a peça', manual.dados.conferidoTotal === 1);
    ok('e marca o pedido como divergente na hora', manual.dados.conferencia.houveDivergencia === true);
    const fechou4 = await bruno(`/api/conferencia/${conf4}/concluir`, { metodo: 'POST', corpo: {} });
    ok('a divergência sobrevive ao fechamento', fechou4.dados.houveDivergencia === true);

    const relFinal = await bruno(`/api/conferencia/relatorio?de=${hoje}&ate=${hoje}`);
    ok('e o relatório separa "de primeira" de "com divergência"',
      relFinal.dados.conferidos === 4 && relFinal.dados.sem_divergencia === 3 && relFinal.dados.com_divergencia === 1,
      JSON.stringify({ c: relFinal.dados.conferidos, s: relFinal.dados.sem_divergencia, d: relFinal.dados.com_divergencia }));

    // -----------------------------------------------------------------
    secao('14. Largar a conferência');
    // -----------------------------------------------------------------
    const { rows: p5 } = await pool.query(
      `INSERT INTO pedidos_venda (canal_venda, origem_marketplace, origem_pedido_id, quantidade_pecas)
       VALUES ('Shopee','shopee','2409SHOPEE010', 1) RETURNING id`
    );
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, referencia, quantidade, sku_externo, ordem) VALUES ($1,'OG1620-PRETO-M',1,'OG1620-PRETO-M',1)`,
      [p5[0].id]
    );
    const abriu5 = await bruno(`/api/conferencia/pedidos/${p5[0].id}/iniciar`, { metodo: 'POST' });
    ok('largar libera o pedido', (await bruno(`/api/conferencia/${abriu5.dados.conferencia.id}/abandonar`, { metodo: 'POST' })).status === 204);
    const reabriu = await ana(`/api/conferencia/pedidos/${p5[0].id}/iniciar`, { metodo: 'POST' });
    ok('e outra pessoa consegue começar do zero',
      reabriu.status === 201 && reabriu.dados.conferencia.id !== abriu5.dados.conferencia.id);
    ok('a nova conferência começa zerada', reabriu.dados.conferidoTotal === 0);

    // -----------------------------------------------------------------
    secao('15. A etiqueta vinda da planilha do UpSeller');
    // -----------------------------------------------------------------
    // A coluna de rastreio é OPCIONAL: não sabemos se toda exportação do
    // UpSeller tem. A importação não pode quebrar quando ela não existir.
    const ExcelJS = require('exceljs');
    const { parseUpsellerXlsx } = require('../src/lib/pedidoImportParsers/upsellerXlsx');
    async function planilhaUpseller(comRastreio) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Pedidos');
      const cab = ['Nº de Pedido da Plataforma', 'Plataformas', 'Nome da Loja no Upseller', 'Estado do Pedido',
        'Hora do Pedido', 'Comissão Total', 'Total de Frete', 'SKU', 'Nome do Anúncio', 'Preço de Produto', 'Qtd. do Produto'];
      if (comRastreio) cab.push('Código de Rastreio');
      ws.addRow(cab);
      for (const [sku, qtd] of [['OG1620-PRETO-M', 2], ['OG1620-PRETO-G', 1]]) {
        const l = ['2409UPS001', 'Shopee', 'Origem', 'Pronto para envio', '2026-09-05 10:00', 2.5, 8, sku, 'Camiseta', 39.9, qtd];
        if (comRastreio) l.push('spxbr0777');
        ws.addRow(l);
      }
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    const comColuna = await parseUpsellerXlsx(await planilhaUpseller(true));
    ok('lê a etiqueta quando a exportação tem a coluna',
      comColuna[0].codigosRastreio.length === 1 && comColuna[0].codigosRastreio[0] === 'SPXBR0777',
      JSON.stringify(comColuna[0].codigosRastreio));
    ok('e não repete a etiqueta que aparece em toda linha do pedido', comColuna[0].itens.length === 2);

    const semColuna = await parseUpsellerXlsx(await planilhaUpseller(false));
    ok('a importação NÃO quebra quando a coluna não existe',
      Array.isArray(semColuna[0].codigosRastreio) && semColuna[0].codigosRastreio.length === 0);
    ok('e os itens continuam sendo lidos normalmente', semColuna[0].itens.length === 2);

    // Reimportar um pedido que já existe só acrescenta a etiqueta — nunca
    // reescreve o resto. É o caso real: a etiqueta sai numa exportação
    // POSTERIOR à que trouxe o pedido.
    const { acrescentarRastreios } = require('../src/lib/marketplaceSync');
    const clientePool = await pool.connect();
    try {
      await acrescentarRastreios(clientePool, dados.p3.id, ['br1111novo', 'BR1111NOVO', 'x']);
      const { rows } = await clientePool.query('SELECT codigos_rastreio FROM pedidos_venda WHERE id = $1', [dados.p3.id]);
      ok('acrescentar etiqueta não apaga a que já existia',
        rows[0].codigos_rastreio.includes('TTBR0003') && rows[0].codigos_rastreio.includes('BR1111NOVO'),
        JSON.stringify(rows[0].codigos_rastreio));
      ok('não duplica a mesma etiqueta em caixa diferente',
        rows[0].codigos_rastreio.filter((c) => c === 'BR1111NOVO').length === 1);
      ok('e ignora código curto demais pra ser etiqueta', !rows[0].codigos_rastreio.includes('X'));
    } finally {
      clientePool.release();
    }
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

main().catch((err) => { console.error(err); process.exit(1); });
