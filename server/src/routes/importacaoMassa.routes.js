// Importação em massa por planilha: grade, cadastro e variante.
//
// O fluxo é sempre o mesmo, e é de propósito: enviar → SIMULAR → conferir a
// conta → aplicar. E, se der errado, desfazer.

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { parseCsv } = require('../lib/csv');
const {
  CAMPOS_PRODUTO, CAMPOS_VARIANTE, APAGAR,
  simular, aplicar, desfazer,
} = require('../lib/importacaoMassa');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const httpErr = (res, err) => (err && err.status ? res.status(err.status).json({ error: err.message }) : null);

// As colunas de cada modelo, na ordem em que fazem sentido para quem preenche.
const MODELOS = {
  grade: {
    titulo: 'Grade',
    frase: 'Cria as variantes de cor × tamanho. Uma linha por referência: escreva as cores e os tamanhos separados por vírgula, e o sistema faz a conta.',
    colunas: ['Referência', 'Descrição', 'Cores', 'Tamanhos', 'Quantidade', 'Categoria', 'Marca', 'Coleção', 'Linha'],
    exemplo: ['CAM-001', 'Camisa Oxford', 'Azul, Branco, Preto', 'P, M, G, GG', '0', 'Camisaria', 'Origem', 'Verão 26', 'Básica'],
  },
  cadastro: {
    titulo: 'Cadastro',
    frase: 'Atualiza campos de produtos que JÁ existem. Coluna que você não quiser mexer, deixe fora do arquivo; célula vazia não apaga nada.',
    colunas: ['Referência', ...Object.values(CAMPOS_PRODUTO).map((c) => c.rotulo)],
    exemplo: ['CAM-001', 'Camisa Oxford manga longa', 'Camisaria', 'Origem', 'Verão 26', 'Básica', 'Ana', 'CAM001', '0,320', 'Sim'],
  },
  variante: {
    titulo: 'Variante',
    frase: 'Atualiza EAN, localização e situação de variantes que já existem. Uma linha por cor × tamanho.',
    colunas: ['Referência', 'Cor', 'Tamanho', ...Object.values(CAMPOS_VARIANTE).map((c) => c.rotulo)],
    exemplo: ['CAM-001', 'Azul', 'M', '7891234567895', 'Rua B / 3', 'Sim'],
  },
};

router.get('/modelos', (req, res) => {
  res.json(Object.entries(MODELOS).map(([tipo, m]) => ({
    tipo, titulo: m.titulo, frase: m.frase, colunas: m.colunas, exemplo: m.exemplo,
  })));
});

// O modelo em planilha. Existe porque "monte um arquivo com estas colunas" é
// a instrução que produz o arquivo errado: o nome da coluna sai diferente, e a
// importação recusa tudo antes de começar.
router.get('/modelo/:tipo.xlsx', async (req, res, next) => {
  try {
    const m = MODELOS[req.params.tipo];
    if (!m) return res.status(404).json({ error: 'Modelo não encontrado.' });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(m.titulo);
    ws.addRow(m.colunas);
    ws.addRow(m.exemplo);
    ws.getRow(1).font = { bold: true };
    m.colunas.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(14, c.length + 4); });

    // A linha de exemplo é a segunda, e a instrução diz para apagá-la. Modelo
    // sem exemplo faz a pessoa adivinhar o formato de "Cores"; modelo com
    // exemplo que ninguém manda apagar vira produto "CAM-001" no cadastro.
    const aviso = wb.addWorksheet('Como usar');
    aviso.addRow(['Como usar este modelo']);
    aviso.addRow([]);
    aviso.addRow(['1.', 'A linha 2 da outra aba é EXEMPLO. Apague antes de importar.']);
    aviso.addRow(['2.', m.frase]);
    aviso.addRow(['3.', 'Célula vazia NÃO apaga o que está no sistema. Para apagar de propósito, escreva ' + APAGAR + ' na célula.']);
    aviso.addRow(['4.', 'Nada é gravado quando você envia o arquivo: primeiro o sistema mostra a conta (quantas criar, quantas atualizar, quantas já estão certas, quantas deram erro) e você decide.']);
    aviso.addRow(['5.', 'Depois de aplicar, dá para desfazer — e o desfazer não passa por cima do que alguém corrigiu à mão depois.']);
    aviso.getRow(1).font = { bold: true };
    aviso.getColumn(1).width = 5;
    aviso.getColumn(2).width = 110;
    aviso.getColumn(2).alignment = { wrapText: true };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="modelo-${req.params.tipo}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

async function matrizDoArquivo(file) {
  const nome = (file.originalname || '').toLowerCase();
  if (nome.endsWith('.csv') || nome.endsWith('.txt')) {
    return parseCsv(file.buffer.toString('utf-8'));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('A planilha não tem nenhuma aba.'), { status: 400 });
  const linhas = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const v = cell.value;
      vals[col - 1] = v && typeof v === 'object'
        ? (v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? '')
        : v;
    });
    linhas.push(vals);
  });
  return linhas;
}

router.post('/simular', upload.single('arquivo'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie a planilha.' });
    const tipo = req.body?.tipo;
    const matriz = await matrizDoArquivo(req.file);

    await client.query('BEGIN');
    const doc = await simular(client, {
      tipo, matriz, arquivoNome: req.file.originalname, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.status(201).json(await detalhe(doc.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

async function detalhe(id) {
  const { rows: docs } = await pool.query(
    `SELECT i.*, uc.nome AS criado_por_nome, ua.nome AS aplicado_por_nome, ud.nome AS desfeito_por_nome
       FROM importacoes_massa i
       LEFT JOIN usuarios uc ON uc.id = i.criado_por
       LEFT JOIN usuarios ua ON ua.id = i.aplicado_por
       LEFT JOIN usuarios ud ON ud.id = i.desfeito_por
      WHERE i.id = $1`,
    [id]
  );
  if (docs.length === 0) return null;
  const { rows: linhas } = await pool.query(
    'SELECT * FROM importacao_massa_linhas WHERE importacao_id = $1 ORDER BY linha_numero, id LIMIT 2000',
    [id]
  );
  return { importacao: docs[0], linhas };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.nome AS criado_por_nome
         FROM importacoes_massa i
         LEFT JOIN usuarios u ON u.id = i.criado_por
        ORDER BY i.criado_em DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const d = await detalhe(req.params.id);
    if (!d) return res.status(404).json({ error: 'Importação não encontrada.' });
    res.json(d);
  } catch (err) { next(err); }
});

router.post('/:id/aplicar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await aplicar(client, { importacaoId: Number(req.params.id), usuarioId: req.user?.id || null });
    await client.query('COMMIT');
    res.json({ ...out, detalhe: await detalhe(out.importacao.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/:id/desfazer', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await desfazer(client, {
      importacaoId: Number(req.params.id), motivo: req.body?.motivo, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT situacao FROM importacoes_massa WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Importação não encontrada.' });
    if (rows[0].situacao !== 'simulada') {
      return res.status(409).json({
        error: 'Só simulação se descarta. Importação aplicada fica no histórico — é ela que responde "quem mudou isto".',
      });
    }
    await pool.query("UPDATE importacoes_massa SET situacao = 'descartada' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// O histórico de um produto ou variante: o que uma importação trocou nele.
router.get('/historico/:entidade/:id', async (req, res, next) => {
  try {
    if (!['produto', 'variante'].includes(req.params.entidade)) {
      return res.status(400).json({ error: 'Entidade inválida.' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM vw_importacao_massa_historico
        WHERE entidade = $1 AND entidade_id = $2
        ORDER BY aplicado_em DESC LIMIT 100`,
      [req.params.entidade, req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
