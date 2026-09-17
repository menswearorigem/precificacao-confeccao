/*
 * Teste da LISTA DO DIA da Conferência de Pedidos — 17/09/2026.
 *
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-conferencia-lista.js
 *
 * O cenário que motivou a mudança: a bancada não pode cadastrar etiqueta por
 * etiqueta. Carregando o PDF da Lista de Separação do UpSeller, TODA etiqueta
 * da lista tem que abrir a caixa — seja o pedido já sincronizado no sistema,
 * seja um pedido que ainda não chegou.
 */

require('dotenv').config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'liberacao-de-teste-123';

const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { parseListaSeparacao, extrairTextoPdf } = require('../src/lib/listaSeparacaoParser');
const { mesmaPeca } = require('../src/lib/conferenciaEquivalencias');
const { DocumentoPdf } = require('../src/lib/pdfMinimo');

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

// Texto no formato da Lista de Separação do UpSeller. O 1º pedido existe no
// sistema; o 2º ainda não chegou; o 3º tem a etiqueta dupla quebrada em duas
// linhas (o bug de 21/07 do site antigo); o 4º não trouxe item.
const LISTA = `Lista de Separação  17/09/2026
UPAAA111 [SPXBR7770001]
250917SHOPEE01 Origem Oficial
Camiseta Dry Fit PretaOG1620-PRETO-M
×2
UPBBB222 [BR555000111BR]
250917NOVO0002 Origem Oficial
Kit camisetas KIT-3-OG1620-PRETO-G ×1
MM6387-CHOCOLATE-1
×1
UPCCC333 [BR999000333BR
SPXBR9990003]
250917DUPLA003
Moletom VM034-AZUL MARINHO-G
×1
UPDDD444 [SPXBR4440004]
250917VAZIO004`;

async function semear() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: emp } = await c.query("INSERT INTO empresas (nome) VALUES ('Origem') RETURNING id");
    const { rows: prodA } = await c.query("INSERT INTO produtos (referencia, descricao) VALUES ('OG1620', 'Camiseta Dry Fit') RETURNING id");
    const { rows: prodB } = await c.query("INSERT INTO produtos (referencia, descricao) VALUES ('VM034', 'Moletom') RETURNING id");
    const { rows: prodC } = await c.query("INSERT INTO produtos (referencia, descricao) VALUES ('MB6387', 'Bermuda') RETURNING id");
    await c.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1,'PRETO','M','7891000000011',10)", [prodA[0].id]);
    await c.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1,'PRETO','G','7891000000028',10)", [prodA[0].id]);
    await c.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1,'MARINHO','G','7891000000035',10)", [prodB[0].id]);
    // Etiqueta do Wik diz MB6387 MARROM M — o anúncio diz MM6387 CHOCOLATE 1.
    await c.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1,'MARROM','M','7891000000042',10)", [prodC[0].id]);

    const { rows: cli } = await c.query("INSERT INTO clientes (nome) VALUES ('Cliente Shopee') RETURNING id");
    const { rows: p1 } = await c.query(
      `INSERT INTO pedidos_venda (cliente_id, empresa_id, canal_venda, origem_marketplace, origem_pedido_id, quantidade_pecas)
       VALUES ($1,$2,'Shopee','shopee','250917SHOPEE01', 2) RETURNING id, numero`,
      [cli[0].id, emp[0].id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, produto_id, referencia, descricao, cor, tamanho, quantidade, ordem)
       VALUES ($1,$2,'OG1620','Camiseta Dry Fit','PRETO','M',2,1)`,
      [p1[0].id, prodA[0].id]
    );
    // Pedido que já tem uma etiqueta que a lista vai tentar dar a outro
    await c.query(
      `INSERT INTO pedidos_venda (cliente_id, empresa_id, canal_venda, origem_marketplace, origem_pedido_id, codigos_rastreio)
       VALUES ($1,$2,'Shopee','shopee','OUTRO0000001', ARRAY['SPXBR9990003'])`,
      [cli[0].id, emp[0].id]
    );
    await c.query('COMMIT');
    return { p1: p1[0] };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  // -----------------------------------------------------------------
  secao('1. Leitura do texto da lista');
  // -----------------------------------------------------------------
  const lidos = parseListaSeparacao(LISTA, new Set(['OG1620', 'VM034', 'MM6387', 'MB6387']));
  ok('lê os 4 pedidos, inclusive o sem item', lidos.length === 4, `veio ${lidos.length}`);
  ok('etiqueta dupla quebrada em duas linhas não junta pedidos',
    lidos[2].rastreios.length === 2 && lidos[2].upId === 'UPCCC333', JSON.stringify(lidos[2].rastreios));
  ok('número da Shopee é reconhecido', lidos[0].pedidoPlataforma === '250917SHOPEE01');
  ok('SKU grudado na descrição é limpo', lidos[0].itens[0]?.sku === 'OG1620-PRETO-M', JSON.stringify(lidos[0].itens));
  ok('quantidade da linha de baixo é lida', lidos[0].itens[0]?.quantidade === 2);
  ok('kit mantém o prefixo KIT-3', lidos[1].itens[0]?.sku === 'KIT-3-OG1620-PRETO-G', JSON.stringify(lidos[1].itens));
  ok('tamanho numérico é aceito', lidos[1].itens[1]?.sku === 'MM6387-CHOCOLATE-1', JSON.stringify(lidos[1].itens));
  ok('pedido sem item continua na lista', lidos[3].itens.length === 0 && lidos[3].rastreios[0] === 'SPXBR4440004');

  secao('2. Equivalências permanentes');
  ok('MB6387 MARROM M = MM6387 CHOCOLATE 1',
    mesmaPeca({ referencia: 'MB6387', cor: 'MARROM', tamanho: 'M' }, { referencia: 'MM6387', cor: 'Chocolate', tamanho: '1' }));
  ok('Azul Marinho = Marinho', mesmaPeca({ referencia: 'VM034', cor: 'AZUL MARINHO', tamanho: 'G' }, { referencia: 'VM034', cor: 'MARINHO', tamanho: 'G' }));
  ok('P ≠ G em MM6387', !mesmaPeca({ referencia: 'MM6387', cor: 'MARROM', tamanho: 'P' }, { referencia: 'MM6387', cor: 'MARROM', tamanho: 'GG' }));
  ok('P ≠ M fora da MM6387', !mesmaPeca({ referencia: 'OG1620', cor: 'PRETO', tamanho: 'P' }, { referencia: 'OG1620', cor: 'PRETO', tamanho: 'M' }));
  ok('cor diferente continua diferente', !mesmaPeca({ referencia: 'OG1620', cor: 'PRETO', tamanho: 'M' }, { referencia: 'OG1620', cor: 'BRANCO', tamanho: 'M' }));

  secao('3. Leitura de um PDF de verdade');
  const doc = new DocumentoPdf();
  const pag = doc.novaPagina(595, 842);
  LISTA.replace(/×/g, 'x').split('\n').forEach((linha, i) => pag.texto(40, 40 + i * 16, linha, { tamanho: 10 }));
  const textoPdf = await extrairTextoPdf(doc.buffer());
  const doPdf = parseListaSeparacao(textoPdf, new Set(['OG1620', 'VM034', 'MM6387', 'MB6387']));
  ok('o PDF rende os mesmos 4 pedidos', doPdf.length === 4, `veio ${doPdf.length}: ${textoPdf.slice(0, 200)}`);
  ok('com os mesmos itens', JSON.stringify(doPdf.map((p) => p.itens.length)) === '[1,2,1,0]', JSON.stringify(doPdf.map((p) => p.itens)));

  const dados = await semear();
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
      const res = await fetch(base + caminho, {
        method: metodo, headers, body: form || (corpo === undefined ? undefined : JSON.stringify(corpo)),
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

  try {
    await ana('/api/auth/setup', { metodo: 'POST', corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Ana', email: 'a@a.com', senha: SENHA } });
    await ana('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Bruno', email: 'b@b.com', senha: SENHA, role: 'limitado', modulos: ['marketplace'] } });
    await bruno('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Bruno', senha: SENHA } });

    // -----------------------------------------------------------------
    secao('4. Carregar a lista (PDF enviado como arquivo)');
    // -----------------------------------------------------------------
    const antes = await bruno('/api/conferencia/abrir/SPXBR7770001');
    ok('sem lista, a etiqueta não abre nada', antes.status === 404 && antes.dados.naoEncontrado === true);

    const form = new FormData();
    form.append('file', new Blob([doc.buffer()], { type: 'application/pdf' }), 'lista-separacao.pdf');
    const carga = await bruno('/api/conferencia/lista', { metodo: 'POST', form });
    ok('carrega a lista', carga.status === 201, JSON.stringify(carga.dados));
    ok('4 pedidos, 1 já no sistema e 3 só na lista',
      carga.dados.total === 4 && carga.dados.noSistema === 1 && carga.dados.soNaLista === 3, JSON.stringify(carga.dados));

    const { rows: p1 } = await pool.query('SELECT codigos_rastreio FROM pedidos_venda WHERE id = $1', [dados.p1.id]);
    ok('a etiqueta foi gravada no pedido do sistema', (p1[0].codigos_rastreio || []).includes('SPXBR7770001'), JSON.stringify(p1[0].codigos_rastreio));

    const deNovo = await bruno('/api/conferencia/lista', { metodo: 'POST', corpo: { texto: LISTA } });
    const { rows: contagem } = await pool.query('SELECT COUNT(*)::int AS n FROM conferencia_lista_pedidos');
    ok('carregar a mesma lista de novo não duplica', deNovo.status === 201 && contagem[0].n === 4, `linhas: ${contagem[0].n}`);

    const vazia = await bruno('/api/conferencia/lista', { metodo: 'POST', corpo: { texto: 'um texto qualquer sem pedido' } });
    ok('arquivo que não é a lista é recusado com explicação', vazia.status === 400 && /UP/.test(vazia.dados.error));

    await pool.query(`INSERT INTO pedidos_venda (canal_venda, origem_marketplace, origem_pedido_id) VALUES ('Shopee','shopee','250917CONFLIT6')`);
    await pool.query(`INSERT INTO pedidos_venda (canal_venda, origem_marketplace, origem_pedido_id, codigos_rastreio) VALUES ('Shopee','shopee','DONO00000006', ARRAY['SPXBR6660006'])`);
    const conflito = await bruno('/api/conferencia/lista', { metodo: 'POST', corpo: { texto: 'UPFFF666 [SPXBR6660006]\n250917CONFLIT6\nOG1620-PRETO-M\n×1' } });
    ok('etiqueta que já é de OUTRO pedido não é roubada — vira aviso',
      conflito.dados.conflitos.length === 1 && conflito.dados.conflitos[0].pedido === 'DONO00000006', JSON.stringify(conflito.dados));
    await pool.query("DELETE FROM conferencia_lista_pedidos WHERE up_id = 'UPFFF666'");

    const listagem = await bruno('/api/conferencia/lista');
    ok('a aba Lista do dia mostra os 4', listagem.status === 200 && listagem.dados.pedidos.length === 4);

    // -----------------------------------------------------------------
    secao('5. Pedido da lista que existe no sistema — confere pelo sistema');
    // -----------------------------------------------------------------
    const a1 = await bruno('/api/conferencia/abrir/SPXBR7770001');
    ok('a etiqueta abre direto, sem vincular nada', a1.status === 200 && a1.dados.via === 'rastreio' && a1.dados.pedido.id === dados.p1.id);
    const c1 = await bruno(`/api/conferencia/pedidos/${dados.p1.id}/iniciar`, { metodo: 'POST', corpo: {} });
    const conf1 = c1.dados.conferencia.id;
    const l1 = await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7891000000011', fecharAoCompletar: true } });
    ok('primeira peça conta e a caixa continua aberta', l1.dados.leitura.resultado === 'ok' && !l1.dados.fechadaAutomaticamente);
    const l2 = await bruno(`/api/conferencia/${conf1}/leitura`, { metodo: 'POST', corpo: { codigo: '7891000000011', fecharAoCompletar: true } });
    ok('a última peça FECHA a caixa sozinha', l2.status === 200 && l2.dados.fechadaAutomaticamente === true && l2.dados.conferencia.situacao === 'concluida',
      JSON.stringify(l2.dados?.conferencia));
    const dnv = await bruno('/api/conferencia/abrir/SPXBR7770001');
    ok('bipar de novo avisa JÁ FOI CONFERIDO', dnv.status === 409 && dnv.dados.jaConferido === true);

    // -----------------------------------------------------------------
    secao('6. Pedido que só existe na lista — confere pelo PDF');
    // -----------------------------------------------------------------
    const a2 = await bruno('/api/conferencia/abrir/BR555000111BR');
    ok('a etiqueta abre o pedido da lista', a2.status === 200 && a2.dados.pedido.soNaLista === true, JSON.stringify(a2.dados));
    ok('kit de 3 + 1 peça = 4 peças esperadas', a2.dados.esperadoTotal === 4, `veio ${a2.dados.esperadoTotal}`);
    ok('peças com EAN não pedem confirmação no olho', a2.dados.itens.every((i) => !i.semEan), JSON.stringify(a2.dados.itens));
    const c2 = await bruno(`/api/conferencia/lista/${a2.dados.pedido.listaPedidoId}/iniciar`, { metodo: 'POST', corpo: {} });
    ok('inicia a conferência da lista', c2.status === 201, JSON.stringify(c2.dados));
    const conf2 = c2.dados.conferencia.id;
    const errada = await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '7891000000011', fecharAoCompletar: true } });
    ok('peça de outro pedido é recusada', errada.dados.leitura.resultado === 'fora_do_pedido');
    const desconhecida = await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '0000', fecharAoCompletar: true } });
    ok('código desconhecido é recusado', desconhecida.dados.leitura.resultado === 'ean_desconhecido');
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '7891000000028', fecharAoCompletar: true } });
    }
    const excesso = await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '7891000000028', fecharAoCompletar: true } });
    ok('quarta camiseta do kit de 3 é recusada', excesso.dados.leitura.resultado === 'quantidade_excedida');
    const equivalente = await bruno(`/api/conferencia/${conf2}/leitura`, { metodo: 'POST', corpo: { codigo: '7891000000042', fecharAoCompletar: true } });
    ok('etiqueta MB6387 MARROM M passa como MM6387 CHOCOLATE 1', equivalente.dados.leitura.resultado === 'ok', JSON.stringify(equivalente.dados.leitura));
    ok('e fecha a caixa da lista sozinha', equivalente.dados.fechadaAutomaticamente === true);

    // Pedido 3: sem fechar automático, fecha pelo botão
    const a3 = await bruno('/api/conferencia/abrir/250917DUPLA003');
    ok('abre pelo número da plataforma que só está na lista', a3.status === 200 && a3.dados.via === 'lista_numero');
    const c3 = await bruno(`/api/conferencia/lista/${a3.dados.pedido.listaPedidoId}/iniciar`, { metodo: 'POST', corpo: {} });
    const conf3 = c3.dados.conferencia.id;
    const l3 = await bruno(`/api/conferencia/${conf3}/leitura`, { metodo: 'POST', corpo: { codigo: '7891000000035' } });
    ok('Azul Marinho da lista aceita a etiqueta MARINHO', l3.dados.leitura.resultado === 'ok' && l3.dados.completo === true);
    ok('sem pedir, não fecha sozinha (API antiga intacta)', !l3.dados.fechadaAutomaticamente);
    const f3 = await bruno(`/api/conferencia/${conf3}/concluir`, { metodo: 'POST', corpo: {} });
    ok('fecha pelo botão', f3.status === 200 && f3.dados.houveDivergencia === false);

    // Pedido 4: sem item
    const a4 = await bruno('/api/conferencia/abrir/SPXBR4440004');
    const c4 = await bruno(`/api/conferencia/lista/${a4.dados.pedido.listaPedidoId}/iniciar`, { metodo: 'POST', corpo: {} });
    ok('pedido da lista sem item não abre conferência vazia', c4.status === 400);

    // -----------------------------------------------------------------
    secao('7. O pedido chega pela sincronização DEPOIS da carga');
    // -----------------------------------------------------------------
    const { rows: novo } = await pool.query(
      `INSERT INTO pedidos_venda (canal_venda, origem_marketplace, origem_pedido_id)
       VALUES ('Shopee','shopee','250917VAZIO004') RETURNING id`
    );
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, referencia, cor, tamanho, quantidade, ordem) VALUES ($1,'OG1620','PRETO','G',1,1)`,
      [novo[0].id]
    );
    const a5 = await bruno('/api/conferencia/abrir/SPXBR4440004');
    ok('a mesma etiqueta agora abre o pedido do sistema', a5.status === 200 && a5.dados.pedido.id === novo[0].id, JSON.stringify(a5.dados?.pedido));
    const { rows: p5 } = await pool.query('SELECT codigos_rastreio FROM pedidos_venda WHERE id = $1', [novo[0].id]);
    ok('e a etiqueta passou a morar no pedido', (p5[0].codigos_rastreio || []).includes('SPXBR4440004'));

    // -----------------------------------------------------------------
    secao('8. Confirmar no olho e relatório');
    // -----------------------------------------------------------------
    const lista = await bruno('/api/conferencia/lista');
    const conferidos = lista.dados.pedidos.filter((p) => p.conferencia?.situacao === 'concluida').length;
    ok('a lista mostra 3 pedidos conferidos', conferidos === 3, `veio ${conferidos}`);
    const rel = await bruno('/api/conferencia/relatorio');
    ok('o relatório conta as conferências da lista', rel.status === 200 && rel.dados.conferidos === 3, JSON.stringify(rel.dados));

    // Linha de lista com SKU fora do padrão → confirmar no olho
    await bruno('/api/conferencia/lista', { metodo: 'POST', corpo: { texto: 'UPEEE555 [SPXBR5550005]\n250917ESTRANHO5\nBrinde-X-Y-U\n×1' } });
    const a6 = await bruno('/api/conferencia/abrir/SPXBR5550005');
    ok('item sem EAN aparece como "confirmar no olho"', a6.status === 200 && a6.dados.itens[0]?.semEan === true, JSON.stringify(a6.dados));
    const c6 = await bruno(`/api/conferencia/lista/${a6.dados.pedido.listaPedidoId}/iniciar`, { metodo: 'POST', corpo: {} });
    const m6 = await bruno(`/api/conferencia/${c6.dados.conferencia.id}/confirmar-manual`, { metodo: 'POST', corpo: { pedido_item_id: 1, fecharAoCompletar: true } });
    ok('confirmar no olho fecha com divergência', m6.status === 200 && m6.dados.fechadaAutomaticamente === true && m6.dados.houveDivergencia === true, JSON.stringify(m6.dados));
    const rel2 = await bruno('/api/conferencia/relatorio');
    ok('e o divergente da lista aparece identificado', rel2.dados.divergentes.some((d) => d.origem_pedido_id === '250917ESTRANHO5'), JSON.stringify(rel2.dados.divergentes));
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
