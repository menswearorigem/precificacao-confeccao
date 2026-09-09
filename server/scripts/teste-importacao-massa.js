// Teste da importação em massa: grade, cadastro, variante, simular, aplicar e
// desfazer.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-importacao-massa.js
//
// O que este arquivo cobra acima de tudo: nada é gravado antes de aplicar, o
// desfazer volta ao estado anterior, e o desfazer NÃO passa por cima do que
// alguém corrigiu à mão depois.

const express = require('express');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/importacaoMassa.routes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: null }; next(); });
app.use('/api/im', rotas);
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// Monta um .csv na memória e envia como arquivo, que é o caminho real.
async function enviar(tipo, linhas) {
  const csv = linhas.map((l) => l.map((c) => {
    const s = String(c ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\n');
  const form = new FormData();
  form.append('tipo', tipo);
  form.append('arquivo', new Blob([csv], { type: 'text/csv' }), 'teste.csv');
  const r = await fetch(`${base}/api/im/simular`, { method: 'POST', body: form });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const produtoDe = async (ref) => (await pool.query('SELECT * FROM produtos WHERE referencia = $1', [ref])).rows[0] || null;
const variantesDe = async (ref) => (await pool.query(
  'SELECT v.* FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE p.referencia = $1 ORDER BY v.cor, v.tamanho', [ref]
)).rows;

async function limpar() {
  await pool.query("DELETE FROM importacao_massa_linhas WHERE importacao_id IN (SELECT id FROM importacoes_massa WHERE arquivo_nome = 'teste.csv')");
  await pool.query("DELETE FROM importacoes_massa WHERE arquivo_nome = 'teste.csv'");
  await pool.query("DELETE FROM estoque_movimentos WHERE variante_id IN (SELECT v.id FROM estoque_variantes v JOIN produtos p ON p.id=v.produto_id WHERE p.referencia LIKE 'TIM-%')");
  await pool.query("DELETE FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TIM-%')");
  await pool.query("DELETE FROM produtos WHERE referencia LIKE 'TIM-%'");
}

async function main() {
  await limpar();

  console.log('\n== MODELOS ==');
  const modelos = await req('GET', '/api/im/modelos');
  checa('os três modelos existem', modelos.body.length === 3, modelos.body?.map((m) => m.tipo));
  checa('o modelo de grade explica a conta de cor × tamanho', /cores e os tamanhos/.test(modelos.body[0].frase), modelos.body[0].frase);

  const xlsx = await fetch(`${base}/api/im/modelo/grade.xlsx`);
  const buf = Buffer.from(await xlsx.arrayBuffer());
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  checa('o modelo baixa como planilha de verdade', xlsx.status === 200 && wb.worksheets.length === 2, wb.worksheets.length);
  checa('e traz a aba explicando que a linha 2 é exemplo',
    /apague antes de importar/i.test(wb.getWorksheet('Como usar').getRow(3).getCell(2).value || ''),
    wb.getWorksheet('Como usar')?.getRow(3).getCell(2).value);

  console.log('\n== GRADE: A CONTA ANTES DE GRAVAR ==');
  const g1 = await enviar('grade', [
    ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade'],
    ['TIM-001', 'CAMISA IMPORTADA', 'Azul, Branco', 'P, M, G', '0'],
  ]);
  checa('simulação aceita', g1.status === 201, g1.body);
  checa('2 cores × 3 tamanhos = 6 variantes a criar', g1.body.importacao.total_criar === 6, g1.body.importacao.total_criar);
  checa('nasce como simulada', g1.body.importacao.situacao === 'simulada', g1.body.importacao.situacao);
  checa('⚠️ e NADA foi gravado ainda', (await produtoDe('TIM-001')) === null, await produtoDe('TIM-001'));

  console.log('\n== APLICAR ==');
  const ap1 = await req('POST', `/api/im/${g1.body.importacao.id}/aplicar`);
  checa('aplicar aceito', ap1.status === 200, ap1.body);
  checa('6 variantes criadas', ap1.body.criadas === 6, ap1.body.criadas);
  const prod = await produtoDe('TIM-001');
  checa('o produto foi criado junto', prod !== null && prod.descricao === 'CAMISA IMPORTADA', prod);
  const vars1 = await variantesDe('TIM-001');
  checa('as 6 combinações existem', vars1.length === 6, vars1.map((v) => `${v.cor}/${v.tamanho}`));
  const reap = await req('POST', `/api/im/${g1.body.importacao.id}/aplicar`);
  checa('aplicar duas vezes é recusado', reap.status === 409, reap.body);

  console.log('\n== REIMPORTAR O MESMO ARQUIVO NÃO DUPLICA ==');
  const g2 = await enviar('grade', [
    ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade'],
    ['TIM-001', 'CAMISA IMPORTADA', 'Azul, Branco', 'P, M, G', '0'],
  ]);
  checa('tudo cai em "já existe", nada em criar',
    g2.body.importacao.total_criar === 0 && g2.body.importacao.total_ignorar === 6, g2.body.importacao);

  console.log('\n== GRADE INCREMENTAL: SÓ O QUE FALTA ==');
  const g3 = await enviar('grade', [
    ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade'],
    ['TIM-001', 'CAMISA IMPORTADA', 'Azul, Branco, Preto', 'P, M, G', '0'],
  ]);
  checa('só as 3 combinações novas entram como criar', g3.body.importacao.total_criar === 3, g3.body.importacao.total_criar);
  checa('e as 6 antigas como já existentes', g3.body.importacao.total_ignorar === 6, g3.body.importacao.total_ignorar);
  await req('POST', `/api/im/${g3.body.importacao.id}/aplicar`);
  checa('agora são 9', (await variantesDe('TIM-001')).length === 9, (await variantesDe('TIM-001')).length);

  console.log('\n== UMA LINHA ERRADA NÃO DERRUBA O ARQUIVO ==');
  const g4 = await enviar('grade', [
    ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade'],
    ['TIM-002', 'CALCA', 'Preto', '38, 40', '5'],
    ['', 'SEM REFERENCIA', 'Azul', 'P', '0'],
    ['TIM-003', '', 'Verde', 'M', '0'],
  ]);
  checa('as boas seguem', g4.body.importacao.total_criar === 2, g4.body.importacao.total_criar);
  checa('as duas ruins viram erro', g4.body.importacao.total_erro === 2, g4.body.importacao.total_erro);
  const linhaSemRef = g4.body.linhas.find((l) => l.motivo === 'Linha sem referência.');
  checa('o erro cita o número da linha NA PLANILHA', linhaSemRef?.linha_numero === 3, linhaSemRef);
  const linhaSemDesc = g4.body.linhas.find((l) => /precisa de uma descrição/.test(l.motivo || ''));
  checa('produto novo sem descrição é recusado com o motivo escrito', linhaSemDesc !== undefined, linhaSemDesc?.motivo);

  console.log('\n== REFERÊNCIA REPETIDA É AMBIGUIDADE ==');
  const g5 = await enviar('grade', [
    ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade'],
    ['TIM-009', 'UM', 'Azul', 'P', '0'],
    ['TIM-009', 'OUTRO', 'Verde', 'M', '0'],
  ]);
  checa('as duas ocorrências viram erro, e não "a última vence"', g5.body.importacao.total_erro === 2, g5.body.importacao);

  console.log('\n== CADASTRO: SÓ ATUALIZA, E SÓ O QUE MUDA ==');
  const c1 = await enviar('cadastro', [
    ['Referência', 'Coleção', 'Marca'],
    ['TIM-001', 'Verão 26', 'Origem'],
    ['TIM-404', 'Verão 26', 'Origem'],
  ]);
  checa('referência inexistente vira erro explicando que aqui só atualiza',
    c1.body.linhas.some((l) => /só ATUALIZA/.test(l.motivo || '')), c1.body.linhas.map((l) => l.motivo));
  checa('a que existe entra como atualizar', c1.body.importacao.total_atualizar === 1, c1.body.importacao);
  await req('POST', `/api/im/${c1.body.importacao.id}/aplicar`);
  const p1 = await produtoDe('TIM-001');
  checa('a coleção mudou', p1.colecao === 'Verão 26', p1.colecao);
  checa('a marca mudou', p1.marca === 'Origem', p1.marca);

  const c2 = await enviar('cadastro', [['Referência', 'Coleção', 'Marca'], ['TIM-001', 'Verão 26', 'Origem']]);
  checa('reimportar o mesmo não conta como alteração', c2.body.importacao.total_ignorar === 1 && c2.body.importacao.total_atualizar === 0, c2.body.importacao);

  console.log('\n== CÉLULA VAZIA NÃO APAGA ==');
  const c3 = await enviar('cadastro', [['Referência', 'Coleção', 'Marca'], ['TIM-001', 'Inverno 26', '']]);
  await req('POST', `/api/im/${c3.body.importacao.id}/aplicar`);
  const p2 = await produtoDe('TIM-001');
  checa('a coluna preenchida muda', p2.colecao === 'Inverno 26', p2.colecao);
  checa('⚠️ e a vazia NÃO apagou a marca', p2.marca === 'Origem', p2.marca);

  const c4 = await enviar('cadastro', [['Referência', 'Marca'], ['TIM-001', '-']]);
  await req('POST', `/api/im/${c4.body.importacao.id}/aplicar`);
  checa('mas o traço apaga de propósito', (await produtoDe('TIM-001')).marca === '', (await produtoDe('TIM-001')).marca);

  console.log('\n== NÚMERO E SIM/NÃO ==');
  const c5 = await enviar('cadastro', [
    ['Referência', 'Peso (kg)', 'Vai para marketplace'],
    ['TIM-001', '0,320', 'Sim'],
  ]);
  checa('número em formato brasileiro é aceito',
    c5.body.linhas.some((l) => l.chave === 'TIM-001' && l.acao === 'atualizar'), c5.body.linhas);
  await req('POST', `/api/im/${c5.body.importacao.id}/aplicar`);

  const c5b = await enviar('cadastro', [['Referência', 'Peso (kg)'], ['TIM-001', 'meio quilo']]);
  checa('texto no lugar de número vira erro com o rótulo da coluna',
    c5b.body.linhas.some((l) => /"Peso \(kg\)" precisa ser um número/.test(l.motivo || '')), c5b.body.linhas.map((l) => l.motivo));
  checa('e a linha ruim não conta como alteração', c5b.body.importacao.total_atualizar === 0, c5b.body.importacao);
  const p3 = await produtoDe('TIM-001');
  checa('0,320 virou 0.320 e não 320', Number(p3.peso_kg) === 0.32, p3.peso_kg);
  checa('"Sim" virou verdadeiro', p3.marketplace === true, p3.marketplace);

  console.log('\n== O HISTÓRICO RESPONDE "QUEM MUDOU ISTO" ==');
  const hist = await req('GET', `/api/im/historico/produto/${p3.id}`);
  checa('o histórico do produto tem as alterações', hist.body.length >= 3, hist.body.length);
  const linhaColecao = hist.body.find((h) => h.dados?.colecao === 'Verão 26');
  checa('e cada uma guarda o valor ANTERIOR', linhaColecao?.antes?.colecao === null, linhaColecao?.antes);

  console.log('\n== DESFAZER ==');
  const c6 = await enviar('cadastro', [['Referência', 'Categoria'], ['TIM-001', 'Camisaria']]);
  const idDesfazer = c6.body.importacao.id;
  await req('POST', `/api/im/${idDesfazer}/aplicar`);
  checa('categoria aplicada', (await produtoDe('TIM-001')).categoria === 'Camisaria', (await produtoDe('TIM-001')).categoria);

  const semMotivo = await req('POST', `/api/im/${idDesfazer}/desfazer`, {});
  checa('desfazer sem motivo é recusado', semMotivo.status === 400, semMotivo.body);

  const d1 = await req('POST', `/api/im/${idDesfazer}/desfazer`, { motivo: 'Planilha errada' });
  checa('desfazer aceito', d1.status === 200, d1.body);
  checa('a categoria voltou ao que era', (await produtoDe('TIM-001')).categoria === null, (await produtoDe('TIM-001')).categoria);
  checa('a importação fica marcada como desfeita', d1.body.importacao.situacao === 'desfeita', d1.body.importacao.situacao);

  console.log('\n== ⚠️ O DESFAZER NÃO PASSA POR CIMA DE CORREÇÃO POSTERIOR ==');
  const c7 = await enviar('cadastro', [['Referência', 'Linha'], ['TIM-001', 'Errada']]);
  await req('POST', `/api/im/${c7.body.importacao.id}/aplicar`);
  checa('aplicou o valor errado', (await produtoDe('TIM-001')).linha === 'Errada', (await produtoDe('TIM-001')).linha);
  // Alguém corrige à mão depois:
  await pool.query("UPDATE produtos SET linha = 'Corrigida na mão' WHERE referencia = 'TIM-001'");
  const d2 = await req('POST', `/api/im/${c7.body.importacao.id}/desfazer`, { motivo: 'Tentando voltar' });
  checa('o desfazer roda', d2.status === 200, d2.body);
  checa('⚠️ mas NÃO volta o campo corrigido à mão',
    (await produtoDe('TIM-001')).linha === 'Corrigida na mão', (await produtoDe('TIM-001')).linha);
  checa('e diz por que não voltou', d2.body.mantidas.some((m) => /alterado depois da importação/.test(m.motivo)), d2.body.mantidas);

  console.log('\n== DESFAZER DE CRIAÇÃO NÃO APAGA PEÇA QUE JÁ ANDOU ==');
  const g6 = await enviar('grade', [
    ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade'],
    ['TIM-010', 'BLUSA', 'Rosa', 'P, M', '0'],
  ]);
  await req('POST', `/api/im/${g6.body.importacao.id}/aplicar`);
  const vs = await variantesDe('TIM-010');
  checa('as duas nasceram', vs.length === 2, vs.length);
  // Uma delas ganha movimento; a outra não.
  await pool.query(
    "INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo) VALUES ($1,'entrada',5,5,'teste')",
    [vs[0].id]
  );
  await pool.query('UPDATE estoque_variantes SET quantidade = 5 WHERE id = $1', [vs[0].id]);
  const d3 = await req('POST', `/api/im/${g6.body.importacao.id}/desfazer`, { motivo: 'Grade errada' });
  const restantes = await variantesDe('TIM-010');
  checa('a que nunca andou é apagada', restantes.length === 1, restantes.map((v) => v.tamanho));
  checa('a que tem movimento sobra, INATIVADA', restantes[0].ativo === false, restantes[0]);
  checa('e o desfazer explica por que ela sobrou',
    d3.body.mantidas.some((m) => /inativada, não apagada/.test(m.motivo)), d3.body.mantidas);

  console.log('\n== VARIANTE: EAN E LOCALIZAÇÃO ==');
  const v1 = await enviar('variante', [
    ['Referência', 'Cor', 'Tamanho', 'EAN', 'Localização'],
    ['TIM-001', 'Azul', 'M', '7891234567895', 'Rua B / 3'],
    ['TIM-001', 'Azul', 'XG', '7891234567901', 'Rua B / 4'],
  ]);
  checa('a variante que existe entra como atualizar', v1.body.importacao.total_atualizar === 1, v1.body.importacao);
  checa('a que não existe manda criar a grade antes',
    v1.body.linhas.some((l) => /Crie a grade antes/.test(l.motivo || '')), v1.body.linhas.map((l) => l.motivo));
  await req('POST', `/api/im/${v1.body.importacao.id}/aplicar`);
  const vAzulM = (await variantesDe('TIM-001')).find((v) => v.cor === 'Azul' && v.tamanho === 'M');
  checa('o EAN entrou', vAzulM.ean === '7891234567895', vAzulM.ean);
  checa('a localização também', vAzulM.localizacao === 'Rua B / 3', vAzulM.localizacao);

  console.log('\n== DESCARTAR SIMULAÇÃO ==');
  const s1 = await enviar('cadastro', [['Referência', 'Categoria'], ['TIM-001', 'Outra']]);
  const del1 = await req('DELETE', `/api/im/${s1.body.importacao.id}`);
  checa('simulação se descarta', del1.status === 200, del1.body);
  const del2 = await req('DELETE', `/api/im/${c5.body.importacao.id}`);
  checa('aplicada não se descarta — é ela que responde quem mudou', del2.status === 409, del2.body);

  console.log('\n== LIMITES ==');
  const g7 = await enviar('grade', [
    ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade'],
    ['TIM-020', 'X', Array.from({ length: 30 }, (_, i) => `C${i}`).join(','), Array.from({ length: 10 }, (_, i) => `T${i}`).join(','), '0'],
  ]);
  checa('linha que geraria 300 variantes é recusada com a conta na mensagem',
    g7.body.linhas.some((l) => /geraria 300 variantes/.test(l.motivo || '')), g7.body.linhas.map((l) => l.motivo));

  const semRefCol = await enviar('cadastro', [['Coleção'], ['Verão']]);
  checa('planilha sem coluna de referência é recusada inteira',
    semRefCol.status === 400 && /coluna "Referência"/.test(semRefCol.body.error), semRefCol.body);

  console.log('\n== REGRA 1 ==');
  const calc = fs.readFileSync(path.join(__dirname, '../src/lib/calc.js'), 'utf-8');
  const meu = fs.readFileSync(path.join(__dirname, '../src/lib/importacaoMassa.js'), 'utf-8');
  checa('o motor de cálculo não menciona importação', !/importac/i.test(calc), null);
  const semComentarios = meu.replace(/^\s*\/\/.*$/gm, '');
  checa('⚠️ a importação NÃO escreve preco_informado', !/preco_informado/.test(semComentarios), null);
  checa('nem materiais nem custos industriais', !/(custos_industriais|INSERT INTO materiais)/.test(semComentarios), null);

  await limpar();
  console.log(`\n${ok} ok, ${falhas} falharam.`);
  if (falhas > 0) process.exitCode = 1;
}

servidor = app.listen(0, async () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  try { await main(); } catch (e) { console.error(e); process.exitCode = 1; }
  finally { servidor.close(); await pool.end(); }
});
