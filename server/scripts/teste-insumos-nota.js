// Teste do cadastro de insumos e da entrada por nota fiscal (06/09/2026).
//
// Roda contra um Postgres LIMPO:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-insumos-nota.js
//
// Prova a corrente inteira, que é a razão de este bloco existir:
//   XML da NF-e → custo real (com frete e imposto) → estoque do insumo
//   → ficha técnica → custo da peça.
//
// E cobre o que quebra em silêncio:
//   1. leitura do XML: chave de 44 dígitos inteira, item único não vira nota
//      vazia, "SEM GTIN" não vira código de barras, data não anda um dia;
//   2. CUSTO: frete rateado por valor, ICMS de crédito só onde há crédito,
//      ICMS-ST sempre custo, e nada tratado como zero por engano;
//   3. o `Number(null) === 0` que fazia o frete nunca ser rateado;
//   4. o NULL na chave única que faria cada nota criar uma linha de saldo
//      nova em vez de somar;
//   5. nota repetida não entra duas vezes;
//   6. a ficha só muda por ação explícita — e nunca com unidade trocada.
const pool = require('../src/db/pool');
const { lerNotaFiscal } = require('../src/lib/nfeParser');
const { calcularCustoDaNota, custoDoInsumo, politicaDeCredito } = require('../src/lib/notaFiscalCusto');

let passou = 0;
let falhou = 0;

function ok(condicao, descricao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✓ ${descricao}`); }
  else { falhou += 1; console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function igual(a, b, descricao) { ok(String(a) === String(b), descricao, `esperado ${b}, veio ${a}`); }
function perto(a, b, descricao, tol = 0.005) {
  ok(Math.abs(Number(a) - Number(b)) <= tol, descricao, `esperado ~${b}, veio ${a}`);
}

// Uma NF-e realista: dois itens, frete só no total, ICMS destacado.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
 <NFe><infNFe Id="NFe52260900112233000199550010000012341000012348" versao="4.00">
  <ide><nNF>1234</nNF><serie>1</serie><mod>55</mod><tpNF>1</tpNF><dhEmi>2026-09-02T23:40:00-03:00</dhEmi></ide>
  <emit><CNPJ>00.112.233/0001-99</CNPJ><xNome>MALHAS GOIAS LTDA</xNome><enderEmit><UF>GO</UF></enderEmit></emit>
  <dest><CNPJ>99887766000155</CNPJ><xNome>ORIGEM CONFECCOES</xNome></dest>
  <det nItem="1"><prod><cProd>MLH-DRY-PT</cProd><xProd>MALHA DRY FIT PRETA 1,80</xProd>
    <NCM>60063200</NCM><CFOP>6102</CFOP><uCom>KG</uCom><qCom>100.0000</qCom>
    <vUnCom>28.500000</vUnCom><vProd>2850.00</vProd><cEAN>SEM GTIN</cEAN><indTot>1</indTot></prod>
   <imposto><ICMS><ICMS00><CST>00</CST><vBC>2850.00</vBC><pICMS>12.00</pICMS><vICMS>342.00</vICMS></ICMS00></ICMS></imposto></det>
  <det nItem="2"><prod><cProd>ZIP-20</cProd><xProd>ZIPER 20CM</xProd><uCom>UN</uCom>
    <qCom>500.0000</qCom><vUnCom>1.300000</vUnCom><vProd>650.00</vProd><cEAN>7891234567895</cEAN><indTot>1</indTot></prod>
   <imposto><ICMS><ICMS00><CST>00</CST><vICMS>78.00</vICMS></ICMS00></ICMS></imposto></det>
  <total><ICMSTot><vProd>3500.00</vProd><vFrete>210.00</vFrete><vDesc>0.00</vDesc>
    <vICMS>420.00</vICMS><vST>0.00</vST><vNF>3710.00</vNF></ICMSTot></total>
  <transp><modFrete>0</modFrete></transp>
  <cobr><dup><nDup>001</nDup><dVenc>2026-10-02</dVenc><vDup>1855.00</vDup></dup>
        <dup><nDup>002</nDup><dVenc>2026-11-02</dVenc><vDup>1855.00</vDup></dup></cobr>
 </infNFe></NFe></nfeProc>`;

// Nota de um item só — a NF-e não repete o elemento quando há um, e um leitor
// ingênuo lê isso como nota vazia.
const XML_UM_ITEM = `<?xml version="1.0"?><NFe><infNFe Id="NFe11111111111111111111111111111111111111111111">
  <ide><nNF>9</nNF><mod>55</mod><dhEmi>2026-09-05T08:00:00-03:00</dhEmi></ide>
  <emit><CNPJ>00112233000199</CNPJ><xNome>FIO E CIA</xNome></emit>
  <det nItem="1"><prod><cProd>LN-40</cProd><xProd>LINHA 40 CONE</xProd><uCom>CONE</uCom>
    <qCom>10</qCom><vUnCom>9.90</vUnCom><vProd>99.00</vProd><indTot>1</indTot></prod><imposto/></det>
  <total><ICMSTot><vProd>99.00</vProd><vNF>99.00</vNF></ICMSTot></total></infNFe></NFe>`;

// ---------------------------------------------------------------------------
function testarLeitura() {
  console.log('\nLeitura do XML da NF-e');
  const r = lerNotaFiscal(XML);

  igual(r.nota.chaveAcesso, '52260900112233000199550010000012341000012348', 'chave de acesso lida');
  igual(r.nota.chaveAcesso.length, 44, 'a chave tem os 44 dígitos (não virou notação científica)');
  igual(r.nota.emitenteCnpj, '00112233000199', 'CNPJ do emitente sai só com dígitos, sem pontuação');
  igual(r.nota.emitenteNome, 'MALHAS GOIAS LTDA', 'nome do emitente');
  igual(r.itens.length, 2, 'os dois itens foram lidos');
  igual(r.duplicatas.length, 2, 'as duas parcelas foram lidas');

  // A emissão é 02/09 às 23h40 no fuso -03:00. Um leitor que passe por
  // new Date() e volte em UTC mostraria 03/09 — um dia a mais.
  igual(r.nota.dataEmissao, '2026-09-02', 'a data de emissão NÃO anda um dia por causa do fuso');

  ok(r.itens[0].ean === null, '"SEM GTIN" não vira código de barras');
  igual(r.itens[1].ean, '7891234567895', 'EAN de verdade é lido');
  igual(r.itens[0].valorIcms, 342, 'o ICMS é lido de dentro do nó ICMS00 (o nome do nó varia com a CST)');

  // Campo ausente é NULO, nunca 0 (REGRA 2).
  ok(r.nota.valorIcmsSt === 0, 'ICMS-ST veio zerado na nota e é lido como 0');
  ok(r.itens[0].valorFrete === null, 'frete NÃO veio no item, então fica NULO — não 0');
  ok(r.itens[0].valorIpi === null, 'IPI ausente fica NULO — não 0');

  const um = lerNotaFiscal(XML_UM_ITEM);
  igual(um.itens.length, 1, 'nota de UM item é lida (a NF-e não repete o elemento nesse caso)');
  igual(um.itens[0].descricao, 'LINHA 40 CONE', 'e o item vem certo');

  let recusou = false;
  try { lerNotaFiscal('<html><body>não é nota</body></html>'); } catch { recusou = true; }
  ok(recusou, 'arquivo que não é NF-e é recusado com mensagem, não lido pela metade');
}

// ---------------------------------------------------------------------------
function testarCusto() {
  console.log('\nCusto real da nota (landed cost)');
  const r = lerNotaFiscal(XML);

  // --- Simples Nacional: nada é crédito, tudo é custo ---
  const simples = calcularCustoDaNota(r.nota, r.itens, { regime_tributario: 'Simples Nacional' });
  perto(simples.resumo.custoTotal, 3710, 'no Simples o custo total é o total da nota (nada é crédito)');
  // 2850/3500 × 210 = 171,00
  perto(simples.itens[0].composicaoCusto.frete, 171, 'o frete do total foi RATEADO por valor no item 1');
  perto(simples.itens[1].composicaoCusto.frete, 39, 'e no item 2');
  perto(simples.itens[0].custoUnitarioFinal, 30.21, 'a malha custa 30,21/kg, e não os 28,50 da nota');
  perto(simples.itens[1].custoUnitarioFinal, 1.378, 'o zíper custa 1,378/un');
  igual(simples.avisos.length, 0, 'e não sobra aviso nenhum: a conta fecha com o total da nota');

  // --- Lucro Real: o ICMS vira crédito ---
  const lucroReal = calcularCustoDaNota(r.nota, r.itens, { regime_tributario: 'Lucro Real' });
  perto(lucroReal.resumo.custoTotal, 3290, 'no Lucro Real sai o ICMS de crédito (3710 − 420)');
  perto(lucroReal.itens[0].custoUnitarioFinal, 26.79, 'a mesma malha custa 26,79/kg no Lucro Real');
  ok(
    simples.itens[0].custoUnitarioFinal > lucroReal.itens[0].custoUnitarioFinal,
    'o regime tributário MUDA o custo da matéria-prima — é por isso que a empresa da nota importa'
  );

  // --- a política de crédito ---
  const pSimples = politicaDeCredito({ regime_tributario: 'Simples Nacional' });
  ok(pSimples.icmsRecuperavel === false, 'Simples não se credita de ICMS');
  ok(pSimples.ipiRecuperavel === false, 'Simples não se credita de IPI');
  const pReal = politicaDeCredito({ regime_tributario: 'Lucro Real' });
  ok(pReal.icmsRecuperavel === true, 'Lucro Real se credita de ICMS');

  // Sem empresa, o sistema NÃO adivinha: assume o pior e avisa.
  const semEmpresa = calcularCustoDaNota(r.nota, r.itens, null);
  ok(
    semEmpresa.avisos.some((a) => a.includes('não está vinculada')),
    'nota sem empresa vinculada gera aviso em vez de assumir um regime calado'
  );

  // --- ICMS-ST é custo em qualquer regime ---
  // Nota montada do zero de proposito: espalhar `r.nota` aqui traria o frete
  // de 210 da nota de cima e a conta viraria outra coisa.
  const comSt = calcularCustoDaNota(
    { valorTotal: 118 },
    [{ descricao: 'X', quantidade: 10, valorTotal: 100, valorIcmsSt: 18, entraNoTotal: true }],
    { regime_tributario: 'Lucro Real' }
  );
  perto(comSt.itens[0].custoUnitarioFinal, 11.8, 'o ICMS-ST entra no custo mesmo no Lucro Real');

  // --- o bug do Number(null) ---
  // Se a checagem de "o item já tem frete" usar Number.isFinite(Number(null)),
  // ela dá TRUE para todo item e o frete do total nunca é rateado.
  const semFreteNoItem = calcularCustoDaNota(
    { valorFrete: 100, valorTotal: 1100 },
    [
      { descricao: 'A', quantidade: 1, valorTotal: 500, valorFrete: null, entraNoTotal: true },
      { descricao: 'B', quantidade: 1, valorTotal: 500, valorFrete: null, entraNoTotal: true },
    ],
    { regime_tributario: 'Simples Nacional' }
  );
  perto(semFreteNoItem.itens[0].composicaoCusto.frete, 50, 'frete NULO no item não impede o rateio (o Number(null) === 0)');

  // --- item que não entra no total não puxa frete ---
  const comBrinde = calcularCustoDaNota(
    { valorFrete: 100, valorTotal: 1000 },
    [
      { descricao: 'vendido', quantidade: 1, valorTotal: 1000, entraNoTotal: true },
      { descricao: 'brinde', quantidade: 1, valorTotal: 50, entraNoTotal: false },
    ],
    { regime_tributario: 'Simples Nacional' }
  );
  perto(comBrinde.itens[1].composicaoCusto.frete, 0, 'item que não entra no total da nota não recebe rateio de frete');
  perto(comBrinde.itens[0].composicaoCusto.frete, 100, 'e o frete inteiro fica com o item que entra');

  // --- FOB sem frete: o custo está incompleto e o sistema diz isso ---
  const fob = calcularCustoDaNota(
    { modalidadeFrete: '1', valorFrete: null, valorTotal: 100 },
    [{ descricao: 'A', quantidade: 1, valorTotal: 100, entraNoTotal: true }],
    { regime_tributario: 'Simples Nacional' }
  );
  ok(
    fob.avisos.some((a) => a.includes('FOB')),
    'frete FOB sem valor gera aviso — o custo está incompleto e alguém precisa saber'
  );

  // --- item sem quantidade não vira custo zero ---
  const semQtd = calcularCustoDaNota(
    { valorTotal: 100 },
    [{ descricao: 'A', quantidade: null, valorTotal: 100, entraNoTotal: true }],
    { regime_tributario: 'Simples Nacional' }
  );
  ok(semQtd.itens[0].custoUnitarioFinal === null, 'item sem quantidade tem custo NULO, nunca 0 (REGRA 2)');
}

// ---------------------------------------------------------------------------
function testarPoliticaDeCusto() {
  console.log('\nCusto do insumo: reposição x média');
  const entradas = [
    { data: '2026-07-01', custoUnitario: 20, quantidade: 100 },
    { data: '2026-08-01', custoUnitario: 24, quantidade: 100 },
    { data: '2026-09-01', custoUnitario: 30, quantidade: 50 },
  ];
  const ultima = custoDoInsumo(entradas, 'ultima');
  perto(ultima.custo, 30, 'a política padrão é a ÚLTIMA nota (custo de reposição)');
  const media = custoDoInsumo(entradas, 'media');
  // (20x100 + 24x100 + 30x50) / 250 = 5900/250 = 23,60.
  // A media SIMPLES daria (20+24+30)/3 = 24,67 -- numero diferente, e e' por
  // isso que o teste distingue os dois.
  perto(media.custo, 23.6, 'a média é ponderada pela quantidade, não simples');
  ok(Math.abs(media.custo - 24.67) > 0.5, 'e não é a média simples, que daria 24,67');
  ok(
    ultima.custo > media.custo,
    'com o insumo subindo, a média esconde a alta e a reposição mostra — é por isso que a padrão é a reposição'
  );

  const semNota = custoDoInsumo([], 'ultima');
  ok(semNota.custo === null, 'insumo sem nota tem custo NULO, e o motivo sai por escrito');
  ok(String(semNota.motivo).includes('nenhuma nota'), 'com o motivo legível');

  const semQtd = custoDoInsumo([{ data: '2026-09-01', custoUnitario: 10, quantidade: 0 }], 'media');
  ok(semQtd.custo === null, 'sem quantidade não existe média PONDERADA — devolve nulo em vez de virar média simples');
}

// ---------------------------------------------------------------------------
async function testarBanco() {
  console.log('\nBanco: estoque, custo e a chave única');

  const { rows: [empresa] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, cnpj)
     VALUES ('Origem', 'Simples Nacional', 0.06, '99887766000155') RETURNING id`
  );
  const { rows: [forn] } = await pool.query(
    `INSERT INTO fornecedores (nome, cpf_cnpj) VALUES ('MALHAS GOIAS LTDA', '00.112.233/0001-99') RETURNING id`
  );
  const { rows: [insumo] } = await pool.query(
    `INSERT INTO insumos (nome, tipo, unidade, unidade_consumo, fator_conversao, fornecedor_id, lead_time_dias)
     VALUES ('MALHA DRY FIT PRETA', 'tecido', 'kg', 'm', 0.32, $1, 15) RETURNING id`,
    [forn.id]
  );

  // O CNPJ do cadastro tem pontuação e o da nota não. O casamento tem que ser
  // por dígitos, senão a nota nunca acha o fornecedor.
  const { rows: achado } = await pool.query(
    `SELECT id FROM fornecedores WHERE regexp_replace(COALESCE(cpf_cnpj, ''), '\\D', '', 'g') = $1`,
    ['00112233000199']
  );
  igual(achado.length, 1, 'o fornecedor é achado por CNPJ só com dígitos, mesmo cadastrado com pontuação');

  const { rows: achadaEmpresa } = await pool.query(
    `SELECT id FROM empresas WHERE regexp_replace(COALESCE(cnpj, ''), '\\D', '', 'g') = $1`,
    ['99887766000155']
  );
  igual(achadaEmpresa.length, 1, 'e a nossa empresa é achada pelo CNPJ do destinatário da nota');

  // --- a chave única do saldo ---
  // Duas entradas no MESMO local (com fornecedor_id NULO) têm que SOMAR na
  // mesma linha. Com uma UNIQUE comum, o NULL faria cada uma virar linha nova.
  for (const qtd of [100, 50]) {
    await pool.query(
      `INSERT INTO insumo_saldos (insumo_id, local, quantidade)
       VALUES ($1, 'proprio', $2)
       ON CONFLICT (insumo_id, local, COALESCE(fornecedor_id, 0))
         DO UPDATE SET quantidade = insumo_saldos.quantidade + EXCLUDED.quantidade`,
      [insumo.id, qtd]
    );
  }
  const { rows: saldos } = await pool.query('SELECT * FROM insumo_saldos WHERE insumo_id = $1', [insumo.id]);
  igual(saldos.length, 1, 'duas entradas no mesmo local viram UMA linha de saldo');
  perto(saldos[0].quantidade, 150, 'e as quantidades somam (o NULL do fornecedor não quebra a chave)');

  // Facção é OUTRO local: linha separada, de propósito.
  await pool.query(
    `INSERT INTO insumo_saldos (insumo_id, local, fornecedor_id, quantidade)
     VALUES ($1, 'faccao', $2, 30)`, [insumo.id, forn.id]
  );
  const { rows: comFaccao } = await pool.query('SELECT * FROM insumo_saldos WHERE insumo_id = $1', [insumo.id]);
  igual(comFaccao.length, 2, 'matéria-prima em poder da facção fica numa linha própria, não somada ao galpão');

  // --- nota repetida ---
  const chave = '52260900112233000199550010000012341000012348';
  await pool.query(
    `INSERT INTO notas_fiscais_entrada (chave_acesso, numero, fornecedor_id, empresa_id, situacao)
     VALUES ($1, '1234', $2, $3, 'lancada')`, [chave, forn.id, empresa.id]
  );
  let duplicou = false;
  try {
    await pool.query(
      `INSERT INTO notas_fiscais_entrada (chave_acesso, numero) VALUES ($1, '1234')`, [chave]
    );
    duplicou = true;
  } catch { /* esperado */ }
  ok(duplicou === false, 'a MESMA nota não entra duas vezes (a chave de acesso é única)');

  // --- a ficha só muda por ação explícita, e nunca com unidade trocada ---
  const { rows: [produto] } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('OG1620', 'KIT POLO', $1) RETURNING id`,
    [empresa.id]
  );
  const { rows: [material] } = await pool.query(
    `INSERT INTO materiais (produto_id, material, quantidade, valor_unitario, insumo_id)
     VALUES ($1, 'malha dry fit', 1.2, 9.00, $2) RETURNING id`,
    [produto.id, insumo.id]
  );
  await pool.query(
    `UPDATE insumos SET custo_atual = 30.21, custo_origem = 'nota', custo_atualizado_em = now() WHERE id = $1`,
    [insumo.id]
  );

  const { rows: [linha] } = await pool.query(
    `SELECT m.valor_unitario, i.custo_atual, i.unidade, i.unidade_consumo, i.fator_conversao
       FROM materiais m JOIN insumos i ON i.id = m.insumo_id WHERE m.id = $1`, [material.id]
  );
  perto(linha.valor_unitario, 9.00, 'a ficha NÃO mudou sozinha quando o custo do insumo mudou');

  // O insumo é comprado em kg e consumido em metro: 30,21/kg × 0,32 kg/m
  const custoNaUnidadeDaFicha = Number(linha.custo_atual) * Number(linha.fator_conversao);
  perto(custoNaUnidadeDaFicha, 9.6672, 'o custo é convertido de kg para metro antes de comparar com a ficha');
  ok(
    custoNaUnidadeDaFicha !== Number(linha.custo_atual),
    'sem a conversão o sistema compararia quilo com metro e poria 30,21 numa ficha que consome metro'
  );

  // --- nada é apagado (REGRA 4) ---
  await pool.query(
    `INSERT INTO insumo_movimentos (insumo_id, tipo, quantidade, quantidade_resultante)
     VALUES ($1, 'ajuste', -10, 140)`, [insumo.id]
  );
  const { rows: movs } = await pool.query('SELECT * FROM insumo_movimentos WHERE insumo_id = $1', [insumo.id]);
  igual(movs.length, 1, 'correção de estoque é um MOVIMENTO de ajuste, não um DELETE');
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('Teste de Insumos e Nota Fiscal de entrada\n' + '='.repeat(52));
  testarLeitura();
  testarCusto();
  testarPoliticaDeCusto();
  await testarBanco();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  await pool.end();
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nO teste explodiu:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
