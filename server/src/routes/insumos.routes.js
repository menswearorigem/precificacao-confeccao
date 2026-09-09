// API de Insumos e de Nota Fiscal de entrada (06/09/2026).
//
// É a corrente que o Hub não tinha:
//   nota fiscal → custo real do insumo → ficha técnica → custo da peça
//
// Antes disto, o valor do material na ficha era digitado uma vez e congelava.
// Quando a malha subia, o preço mínimo continuava o mesmo e a casa vendia
// abaixo do que precisava, sem nada na tela dizendo isso.
//
// REGRA 1 — nada aqui recalcula preço, margem ou markup. O custo do insumo é
// oferecido para a ficha técnica, e só entra nela por ação explícita de
// alguém na tela (POST /insumos/:id/aplicar-na-ficha). A Ficha de
// Precificação continua lendo `materiais.valor_unitario`, o mesmo campo de
// sempre.
//
// REGRA 2 — insumo sem nota fica com custo NULO e a tela escreve "sem custo".
// Nunca R$ 0,00, que passaria por matéria-prima de graça.
const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const ponte = require('../lib/financeiroPonte');
const { hojeEmBrasilia } = require('../lib/dataBrasil');
const { registrar } = require('../lib/auditoria');
const { lerNotaFiscal } = require('../lib/nfeParser');
const { calcularCustoDaNota, custoDoInsumo } = require('../lib/notaFiscalCusto');

const router = express.Router();

// XML de NF-e é texto e não passa de alguns MB nem em nota de 500 itens.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function numeroOuNulo(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ===========================================================================
// Insumos
// ===========================================================================
router.get('/', async (req, res, next) => {
  try {
    const cond = [];
    const vals = [];
    if (!req.query.incluir_inativos) cond.push('i.ativo');
    if (req.query.tipo) { vals.push(req.query.tipo); cond.push(`i.tipo = $${vals.length}`); }
    if (req.query.fornecedor_id) { vals.push(req.query.fornecedor_id); cond.push(`i.fornecedor_id = $${vals.length}`); }
    if (req.query.busca) {
      vals.push(`%${req.query.busca}%`);
      cond.push(`(i.nome ILIKE $${vals.length} OR i.codigo ILIKE $${vals.length} OR i.especificacao ILIKE $${vals.length})`);
    }
    if (req.query.sem_custo === 'true') cond.push('i.custo_atual IS NULL');
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT i.*,
              f.nome AS fornecedor_nome,
              COALESCE(s.total, 0) AS saldo_total,
              s.detalhe AS saldo_detalhe,
              u.usos AS fichas_que_usam,
              lt.media_dias AS lead_time_real_medio,
              lt.desvio_dias AS lead_time_real_desvio,
              lt.amostras AS lead_time_amostras
         FROM insumos i
         LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
         LEFT JOIN LATERAL (
           SELECT SUM(quantidade) AS total,
                  json_agg(json_build_object('local', local, 'quantidade', quantidade)) AS detalhe
             FROM insumo_saldos WHERE insumo_id = i.id
         ) s ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS usos FROM materiais WHERE insumo_id = i.id
         ) u ON TRUE
         LEFT JOIN LATERAL (
           -- Lead time REAL medido, e o desvio dele. É o dado que a fórmula
           -- de estoque de segurança com variabilidade de prazo exige, e que
           -- a maioria dos ERPs de confecção não guarda.
           SELECT AVG(dias)::numeric AS media_dias,
                  STDDEV_SAMP(dias)::numeric AS desvio_dias,
                  COUNT(*) AS amostras
             FROM insumo_lead_time_observado
            WHERE insumo_id = i.id AND dias IS NOT NULL
         ) lt ON TRUE
         ${where}
         ORDER BY i.tipo, i.nome`,
      vals
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Insumo inválido.' });

    const { rows } = await pool.query(
      `SELECT i.*, f.nome AS fornecedor_nome
         FROM insumos i LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
        WHERE i.id = $1`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Insumo não encontrado.' });

    const [{ rows: saldos }, { rows: movimentos }, { rows: historico }, { rows: fichas }, { rows: leadTimes }] =
      await Promise.all([
        pool.query('SELECT s.*, f.nome AS fornecedor_nome FROM insumo_saldos s LEFT JOIN fornecedores f ON f.id = s.fornecedor_id WHERE s.insumo_id = $1', [id]),
        pool.query(
          `SELECT m.*, u.nome AS usuario_nome, n.numero AS nota_numero
             FROM insumo_movimentos m
             LEFT JOIN usuarios u ON u.id = m.usuario_id
             LEFT JOIN notas_fiscais_entrada n ON n.id = m.nota_id
            WHERE m.insumo_id = $1 ORDER BY m.criado_em DESC LIMIT 200`, [id]
        ),
        pool.query(
          `SELECT h.*, f.nome AS fornecedor_nome, n.numero AS nota_numero, u.nome AS usuario_nome
             FROM insumo_custo_historico h
             LEFT JOIN fornecedores f ON f.id = h.fornecedor_id
             LEFT JOIN notas_fiscais_entrada n ON n.id = h.nota_id
             LEFT JOIN usuarios u ON u.id = h.usuario_id
            WHERE h.insumo_id = $1 ORDER BY h.registrado_em DESC LIMIT 100`, [id]
        ),
        // Quais fichas usam este insumo, e por qual valor elas estão. É a
        // tela que responde "quem vai ficar caro se essa malha subir".
        pool.query(
          `SELECT m.id AS material_id, m.produto_id, m.quantidade, m.valor_unitario, m.consumo_por_peca,
                  p.referencia, p.descricao
             FROM materiais m JOIN produtos p ON p.id = m.produto_id
            WHERE m.insumo_id = $1 ORDER BY p.referencia`, [id]
        ),
        pool.query(
          `SELECT l.*, f.nome AS fornecedor_nome
             FROM insumo_lead_time_observado l
             LEFT JOIN fornecedores f ON f.id = l.fornecedor_id
            WHERE l.insumo_id = $1 ORDER BY l.data_recebimento DESC LIMIT 50`, [id]
        ),
      ]);

    res.json({ insumo: rows[0], saldos, movimentos, historicoCusto: historico, fichas, leadTimes });
  } catch (err) {
    next(err);
  }
});

const CAMPOS_INSUMO = [
  'codigo', 'nome', 'tipo', 'unidade', 'unidade_consumo', 'fator_conversao',
  'especificacao', 'cor', 'largura_cm', 'gramatura', 'fornecedor_id',
  'lead_time_dias', 'lote_minimo', 'multiplo_compra', 'perda_pct',
  'estoque_minimo_manual', 'observacoes', 'ativo',
];

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!String(body.nome || '').trim()) {
      return res.status(400).json({ error: 'O insumo precisa de um nome.' });
    }
    const colunas = CAMPOS_INSUMO.filter((c) => body[c] !== undefined);
    const valores = colunas.map((c) => (body[c] === '' ? null : body[c]));
    const { rows } = await pool.query(
      `INSERT INTO insumos (${colunas.join(', ')})
       VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      valores
    );
    await registrar(req, {
      acao: 'criar', entidade: 'insumo', entidadeId: rows[0].id,
      descricao: `Cadastrou o insumo "${rows[0].nome}"`, sucesso: true,
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe um insumo com esse código.' });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Insumo inválido.' });
    const body = req.body || {};
    const colunas = CAMPOS_INSUMO.filter((c) => body[c] !== undefined);
    if (colunas.length === 0) return res.status(400).json({ error: 'Nada para alterar.' });

    const sets = colunas.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await pool.query(
      `UPDATE insumos SET ${sets.join(', ')}, atualizado_em = now() WHERE id = $1 RETURNING *`,
      [id, ...colunas.map((c) => (body[c] === '' ? null : body[c]))]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Insumo não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Vincular a ficha técnica a um insumo
// ---------------------------------------------------------------------------
// Decisão HUMANA, uma linha de ficha por vez. Não existe casamento automático
// por nome parecido — "malha dry fit" e "MALHA DRY FIT PRETA 1,80" podem ser
// a mesma coisa ou duas coisas, e errar aqui contamina o custo de uma
// referência inteira (REGRA 2).
router.post('/vincular-ficha', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const materialId = inteiroPositivo(req.body?.material_id);
    const insumoId = req.body?.insumo_id === null ? null : inteiroPositivo(req.body?.insumo_id);
    if (!materialId) return res.status(400).json({ error: 'Linha de ficha inválida.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE materiais
          SET insumo_id = $2,
              consumo_por_peca = COALESCE($3, consumo_por_peca),
              perda_pct = COALESCE($4, perda_pct)
        WHERE id = $1 RETURNING *`,
      [materialId, insumoId, numeroOuNulo(req.body?.consumo_por_peca), numeroOuNulo(req.body?.perda_pct)]
    );
    await client.query('COMMIT');
    if (rows.length === 0) return res.status(404).json({ error: 'Linha de ficha não encontrada.' });

    await registrar(req, {
      acao: 'alterar', entidade: 'material_ficha', entidadeId: materialId,
      descricao: insumoId ? `Vinculou a linha da ficha ao insumo ${insumoId}` : 'Desvinculou a linha da ficha do insumo',
      sucesso: true,
    });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Quais fichas ficaram defasadas
// ---------------------------------------------------------------------------
// A pergunta que o Wik não responde: "o custo da malha subiu — quais peças
// estão com a ficha desatualizada, e quanto isso muda o preço mínimo delas?".
//
// NÃO altera nada. É só o diagnóstico; a atualização é o endpoint seguinte.
router.get('/diagnostico/fichas-defasadas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id AS material_id, m.produto_id, m.material, m.quantidade,
              m.valor_unitario AS valor_na_ficha,
              m.consumo_por_peca,
              i.id AS insumo_id, i.nome AS insumo_nome, i.unidade, i.unidade_consumo,
              i.fator_conversao, i.custo_atual, i.custo_atualizado_em, i.custo_origem,
              p.referencia, p.descricao AS produto_descricao
         FROM materiais m
         JOIN insumos i ON i.id = m.insumo_id
         JOIN produtos p ON p.id = m.produto_id
        WHERE i.custo_atual IS NOT NULL
        ORDER BY p.referencia, i.nome`
    );

    // O custo do insumo está na unidade de COMPRA. A ficha consome na unidade
    // de CONSUMO. Sem o fator, os dois números não são comparáveis — e a
    // tela precisa dizer isso em vez de comparar quilo com metro.
    const linhas = rows.map((r) => {
      const fator = r.fator_conversao != null ? Number(r.fator_conversao) : null;
      const precisaConverter = Boolean(r.unidade_consumo && r.unidade_consumo !== r.unidade);
      const custoNaUnidadeDaFicha = precisaConverter
        ? (fator != null ? Number(r.custo_atual) * fator : null)
        : Number(r.custo_atual);

      const naFicha = r.valor_na_ficha != null ? Number(r.valor_na_ficha) : null;
      const diferenca = custoNaUnidadeDaFicha != null && naFicha != null
        ? custoNaUnidadeDaFicha - naFicha : null;

      return {
        ...r,
        custo_na_unidade_da_ficha: custoNaUnidadeDaFicha,
        diferenca,
        diferenca_pct: diferenca != null && naFicha > 0 ? diferenca / naFicha : null,
        // Motivo pelo qual não dá pra comparar, quando é o caso.
        impedimento: precisaConverter && fator == null
          ? `O insumo é comprado em ${r.unidade} e consumido em ${r.unidade_consumo}, mas não tem fator de conversão cadastrado.`
          : (naFicha == null ? 'A ficha não tem valor unitário para comparar.' : null),
      };
    });

    res.json({
      linhas,
      resumo: {
        total: linhas.length,
        defasadas: linhas.filter((l) => l.diferenca != null && Math.abs(l.diferenca) > 0.0001).length,
        semConversao: linhas.filter((l) => l.impedimento).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Aplica o custo do insumo na ficha técnica. Ação EXPLÍCITA, com confirmação,
// e registrada — é o único caminho pelo qual o custo de um insumo chega ao
// motor de cálculo.
router.post('/aplicar-na-ficha', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar o custo das fichas.' });
    }
    const ids = (Array.isArray(req.body?.material_ids) ? req.body.material_ids : [])
      .map(inteiroPositivo).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: 'Nenhuma linha de ficha selecionada.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT m.id, m.valor_unitario, m.produto_id, p.referencia,
              i.custo_atual, i.unidade, i.unidade_consumo, i.fator_conversao, i.nome AS insumo_nome
         FROM materiais m
         JOIN insumos i ON i.id = m.insumo_id
         JOIN produtos p ON p.id = m.produto_id
        WHERE m.id = ANY($1) AND i.custo_atual IS NOT NULL`,
      [ids]
    );

    const aplicados = [];
    const recusados = [];
    for (const linha of rows) {
      const precisaConverter = Boolean(linha.unidade_consumo && linha.unidade_consumo !== linha.unidade);
      const fator = linha.fator_conversao != null ? Number(linha.fator_conversao) : null;
      if (precisaConverter && fator == null) {
        // Sem fator, aplicar seria trocar quilo por metro no custo da peça.
        recusados.push({ materialId: linha.id, motivo: 'sem fator de conversão entre a unidade de compra e a de consumo' });
        continue;
      }
      const novo = precisaConverter ? Number(linha.custo_atual) * fator : Number(linha.custo_atual);
      await client.query('UPDATE materiais SET valor_unitario = $2 WHERE id = $1', [linha.id, novo]);
      aplicados.push({
        materialId: linha.id, referencia: linha.referencia, insumo: linha.insumo_nome,
        de: linha.valor_unitario != null ? Number(linha.valor_unitario) : null, para: novo,
      });
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'material_ficha',
      descricao: `Atualizou o custo de ${aplicados.length} linha(s) de ficha a partir do custo de insumo`
        + (recusados.length ? `; ${recusados.length} recusada(s)` : ''),
      sucesso: true,
    });

    res.json({ aplicados, recusados });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ===========================================================================
// Notas fiscais de entrada
// ===========================================================================

// Lê o XML e devolve a prévia SEM gravar nada. A tela mostra, alguém confere
// e vincula os itens a insumos, e só então lança.
router.post('/notas/ler-xml', upload.single('arquivo'), async (req, res, next) => {
  try {
    const xml = req.file ? req.file.buffer.toString('utf8') : req.body?.xml;
    if (!xml) return res.status(400).json({ error: 'Mande o arquivo XML da nota.' });

    const { nota, itens, duplicatas, avisos } = lerNotaFiscal(xml);

    // Nota repetida é o erro mais fácil de cometer aqui, e o mais caro:
    // dobra o estoque e estraga a média de custo.
    let jaExiste = null;
    if (nota.chaveAcesso) {
      const { rows } = await pool.query(
        'SELECT id, numero, situacao, data_emissao FROM notas_fiscais_entrada WHERE chave_acesso = $1',
        [nota.chaveAcesso]
      );
      jaExiste = rows[0] || null;
    }

    // Fornecedor pelo CNPJ EXATO — nunca por nome parecido (REGRA 2).
    let fornecedor = null;
    if (nota.emitenteCnpj) {
      const { rows } = await pool.query(
        `SELECT id, nome, cpf_cnpj FROM fornecedores
          WHERE regexp_replace(COALESCE(cpf_cnpj, ''), '\\D', '', 'g') = $1`,
        [nota.emitenteCnpj]
      );
      fornecedor = rows[0] || null;
    }

    // Empresa destinatária, também por CNPJ exato.
    let empresa = null;
    if (nota.destinatarioCnpj) {
      const { rows } = await pool.query(
        `SELECT * FROM empresas WHERE regexp_replace(COALESCE(cnpj, ''), '\\D', '', 'g') = $1`,
        [nota.destinatarioCnpj]
      );
      empresa = rows[0] || null;
    }

    // Sugestão de insumo por vínculo JÁ DECIDIDO antes, para o mesmo
    // fornecedor e o mesmo código/descrição exatos.
    let sugestoes = new Map();
    if (fornecedor) {
      const { rows } = await pool.query(
        'SELECT * FROM insumo_vinculo_fornecedor WHERE fornecedor_id = $1', [fornecedor.id]
      );
      for (const v of rows) {
        sugestoes.set(`${v.codigo_fornecedor || ''}::${v.descricao_nota || ''}`, v);
      }
    }

    const custo = calcularCustoDaNota(nota, itens, empresa);
    const itensComSugestao = custo.itens.map((i) => {
      const v = sugestoes.get(`${i.codigoFornecedor || ''}::${i.descricao || ''}`);
      return {
        ...i,
        insumo_sugerido_id: v?.insumo_id || null,
        fator_conversao_sugerido: v?.fator_conversao || null,
      };
    });

    res.json({
      nota, itens: itensComSugestao, duplicatas,
      fornecedor, empresa: empresa ? { id: empresa.id, nome: empresa.nome, regime_tributario: empresa.regime_tributario } : null,
      jaExiste,
      resumoCusto: custo.resumo,
      avisos: [
        ...avisos,
        ...custo.avisos,
        ...(jaExiste ? [`Esta nota JÁ foi importada (situação: ${jaExiste.situacao}). Lançar de novo dobraria o estoque.`] : []),
        ...(fornecedor ? [] : ['O emitente da nota não está cadastrado como fornecedor. Cadastre antes de lançar, para o custo ficar ligado a ele.']),
        ...(empresa ? [] : ['Não reconheci o destinatário como uma das suas empresas. Sem o regime tributário, o custo sai sem considerar crédito de imposto.']),
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Lançar a nota: grava, dá entrada no estoque e atualiza o custo do insumo
// ---------------------------------------------------------------------------
// É a operação que fecha a corrente. Três travas, porque ela mexe em estoque
// e em custo ao mesmo tempo:
//   · `confirmar: true` obrigatório;
//   · nenhum item pode ficar sem insumo vinculado — lançar sem saber o que
//     entrou é inventar estoque;
//   · a chave de acesso é única no banco, então a mesma nota não entra duas
//     vezes nem por corrida de dois cliques.
router.post('/notas', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (body.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de lançar a nota.' });
    }
    const nota = body.nota || {};
    const itens = Array.isArray(body.itens) ? body.itens : [];
    if (itens.length === 0) return res.status(400).json({ error: 'A nota não tem itens.' });

    const semVinculo = itens.filter((i) => !inteiroPositivo(i.insumo_id));
    if (semVinculo.length > 0) {
      return res.status(400).json({
        error: `${semVinculo.length} ${semVinculo.length === 1 ? 'item ainda não está vinculado' : 'itens ainda não estão vinculados'} a um insumo. Sem isso o estoque entraria sem saber do quê.`,
        itensSemVinculo: semVinculo.map((i) => i.descricao),
      });
    }

    const empresaId = inteiroPositivo(nota.empresa_id);
    const empresa = empresaId
      ? (await pool.query('SELECT * FROM empresas WHERE id = $1', [empresaId])).rows[0] || null
      : null;

    // O custo é recalculado AQUI, no servidor, a partir dos itens enviados —
    // nunca aceito pronto do cliente. Um custo unitário vindo da tela poderia
    // ter sido editado, e ele alimenta a precificação de tudo.
    const custo = calcularCustoDaNota(nota, itens, empresa);

    await client.query('BEGIN');

    const { rows: notaRows } = await client.query(
      `INSERT INTO notas_fiscais_entrada
         (chave_acesso, numero, serie, modelo, fornecedor_id, emitente_cnpj, emitente_nome,
          empresa_id, destinatario_cnpj, data_emissao, data_entrada,
          valor_produtos, valor_frete, valor_seguro, valor_desconto, valor_outras_despesas,
          valor_ipi, valor_icms_st, valor_total, origem, xml_bruto, nome_arquivo,
          situacao, lancada_em, lancada_por, compra_id, observacoes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               'lancada', now(), $23, $24, $25)
       RETURNING *`,
      [
        nota.chaveAcesso || nota.chave_acesso || null,
        nota.numero || null, nota.serie || null, nota.modelo || null,
        inteiroPositivo(nota.fornecedor_id), nota.emitenteCnpj || nota.emitente_cnpj || null,
        nota.emitenteNome || nota.emitente_nome || null,
        empresaId, nota.destinatarioCnpj || nota.destinatario_cnpj || null,
        nota.dataEmissao || nota.data_emissao || null,
        nota.data_entrada || hojeEmBrasilia(),
        numeroOuNulo(nota.valorProdutos ?? nota.valor_produtos),
        numeroOuNulo(nota.valorFrete ?? nota.valor_frete),
        numeroOuNulo(nota.valorSeguro ?? nota.valor_seguro),
        numeroOuNulo(nota.valorDesconto ?? nota.valor_desconto),
        numeroOuNulo(nota.valorOutrasDespesas ?? nota.valor_outras_despesas),
        numeroOuNulo(nota.valorIpi ?? nota.valor_ipi),
        numeroOuNulo(nota.valorIcmsSt ?? nota.valor_icms_st),
        numeroOuNulo(nota.valorTotal ?? nota.valor_total),
        nota.origem || 'manual', nota.xml_bruto || null, nota.nome_arquivo || null,
        req.user?.id || null, inteiroPositivo(nota.compra_id), nota.observacoes || null,
      ]
    );
    const notaId = notaRows[0].id;

    const resultado = [];
    for (const item of custo.itens) {
      const insumoId = inteiroPositivo(item.insumo_id);
      // Quantidade na unidade do INSUMO. Quando a nota vem noutra unidade, o
      // fator é o que a pessoa confirmou na tela — nunca adivinhado.
      const fator = numeroOuNulo(item.fator_conversao);
      const qtdNota = Number(item.quantidade) || 0;
      const qtdConvertida = fator != null && fator > 0 ? qtdNota * fator : qtdNota;
      const custoUnitarioNaUnidadeDoInsumo = item.custoUnitarioFinal != null && fator != null && fator > 0
        ? item.custoUnitarioFinal / fator
        : item.custoUnitarioFinal;

      await client.query(
        `INSERT INTO nota_fiscal_itens
           (nota_id, numero_item, codigo_fornecedor, descricao, ncm, cfop, unidade,
            quantidade, valor_unitario, valor_total, ean,
            valor_frete, valor_desconto, valor_outras_despesas, valor_seguro,
            valor_ipi, valor_icms, valor_icms_st, icms_recuperavel,
            custo_unitario_final, insumo_id, quantidade_convertida)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          notaId, item.numeroItem || null, item.codigoFornecedor || null, item.descricao,
          item.ncm || null, item.cfop || null, item.unidade || null,
          qtdNota, item.valorUnitario, item.valorTotal, item.ean || null,
          item.composicaoCusto.frete, item.composicaoCusto.desconto,
          item.composicaoCusto.outrasDespesas, item.composicaoCusto.seguro,
          numeroOuNulo(item.valorIpi), numeroOuNulo(item.valorIcms), numeroOuNulo(item.valorIcmsSt),
          item.icmsRecuperavelAplicado,
          item.custoUnitarioFinal, insumoId, qtdConvertida,
        ]
      );

      // --- entrada no estoque do insumo ---
      const { rows: saldoRows } = await client.query(
        `INSERT INTO insumo_saldos (insumo_id, local, quantidade)
         VALUES ($1, 'proprio', $2)
         -- Casa pelo indice de expressao uq_insumo_saldos: sem o COALESCE, o
         -- NULL de fornecedor_id faria o ON CONFLICT nunca casar e cada nota
         -- criaria uma linha de saldo nova (ver a migration 0048).
         ON CONFLICT (insumo_id, local, COALESCE(fornecedor_id, 0), COALESCE(deposito_id, 0)) DO UPDATE
           SET quantidade = insumo_saldos.quantidade + EXCLUDED.quantidade,
               atualizado_em = now()
         RETURNING quantidade`,
        [insumoId, qtdConvertida]
      );

      await client.query(
        `INSERT INTO insumo_movimentos
           (insumo_id, local, tipo, quantidade, quantidade_resultante, custo_unitario,
            nota_id, motivo, usuario_id)
         VALUES ($1, 'proprio', 'entrada_nota', $2, $3, $4, $5, $6, $7)`,
        [
          insumoId, qtdConvertida, saldoRows[0].quantidade, custoUnitarioNaUnidadeDoInsumo,
          notaId, `Nota ${notaRows[0].numero || ''} — ${item.descricao}`.trim(), req.user?.id || null,
        ]
      );

      // --- custo do insumo ---
      // Política padrão: CUSTO DE REPOSIÇÃO (a última nota). O motivo está em
      // notaFiscalCusto.js: o preço de venda precisa cobrir a PRÓXIMA compra,
      // não a do ano passado.
      if (custoUnitarioNaUnidadeDoInsumo != null && custoUnitarioNaUnidadeDoInsumo > 0) {
        const { rows: antes } = await client.query('SELECT custo_atual FROM insumos WHERE id = $1', [insumoId]);
        await client.query(
          `UPDATE insumos
              SET custo_atual = $2, custo_atualizado_em = now(), custo_origem = 'nota',
                  atualizado_em = now()
            WHERE id = $1`,
          [insumoId, custoUnitarioNaUnidadeDoInsumo]
        );
        await client.query(
          `INSERT INTO insumo_custo_historico
             (insumo_id, custo_anterior, custo_novo, origem, nota_id, fornecedor_id, usuario_id)
           VALUES ($1, $2, $3, 'nota', $4, $5, $6)`,
          [
            insumoId, antes[0]?.custo_atual ?? null, custoUnitarioNaUnidadeDoInsumo,
            notaId, inteiroPositivo(nota.fornecedor_id), req.user?.id || null,
          ]
        );
        resultado.push({
          insumoId, descricao: item.descricao,
          custoAnterior: antes[0]?.custo_atual != null ? Number(antes[0].custo_atual) : null,
          custoNovo: custoUnitarioNaUnidadeDoInsumo,
          quantidade: qtdConvertida,
        });
      }

      // --- memória do vínculo, pra não refazer na próxima nota ---
      if (inteiroPositivo(nota.fornecedor_id)) {
        await client.query(
          `INSERT INTO insumo_vinculo_fornecedor
             (fornecedor_id, codigo_fornecedor, descricao_nota, insumo_id, fator_conversao, criado_por)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (fornecedor_id, codigo_fornecedor, descricao_nota) DO UPDATE
             SET insumo_id = EXCLUDED.insumo_id, fator_conversao = EXCLUDED.fator_conversao`,
          [
            inteiroPositivo(nota.fornecedor_id), item.codigoFornecedor || null,
            item.descricao, insumoId, fator, req.user?.id || null,
          ]
        );
      }

      // --- lead time REAL, quando dá pra medir ---
      // Só grava quando existe uma data de pedido de verdade. Inventar a data
      // do pedido a partir da emissão daria um lead time de zero dia e
      // envenenaria a série que alimenta o estoque de segurança (REGRA 2).
      if (nota.data_pedido) {
        const dias = Math.round(
          (new Date(nota.data_entrada || Date.now()) - new Date(nota.data_pedido)) / 86400000
        );
        if (Number.isFinite(dias) && dias >= 0) {
          await client.query(
            `INSERT INTO insumo_lead_time_observado
               (insumo_id, fornecedor_id, nota_id, compra_id, data_pedido, data_recebimento, dias)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              insumoId, inteiroPositivo(nota.fornecedor_id), notaId, inteiroPositivo(nota.compra_id),
              nota.data_pedido, nota.data_entrada || hojeEmBrasilia(), dias,
            ]
          );
        }
      }
    }

    // ------------------------------------------------------------------
    // A PONTE FINANCEIRA — a nota vira contas a pagar com o prazo REAL
    // ------------------------------------------------------------------
    // O bloco <cobr><dup> do XML traz o parcelamento que o fornecedor
    // concedeu de verdade: número, vencimento e valor de cada duplicata. O
    // sistema já lia isso (nfeParser) e já guardava o XML inteiro — e jogava
    // fora justamente a parte que o financeiro precisa.
    //
    // Sem isto, alguém digita "30 dias" no chute e o fluxo de caixa projetado
    // nasce errado. Com isto, o prazo é o que está na nota — inclusive quando
    // o fornecedor deu 28/42/56 dias.
    //
    // As duplicatas são relidas do XML aqui no servidor, nunca aceitas
    // prontas do cliente: elas viram dívida, e dívida não se aceita da tela.
    let duplicatas = [];
    const avisosFinanceiro = [];
    if (notaRows[0].xml_bruto) {
      try {
        const relida = lerNotaFiscal(notaRows[0].xml_bruto);
        duplicatas = relida.duplicatas || [];
      } catch (e) {
        avisosFinanceiro.push(
          'Não foi possível reler as duplicatas do XML desta nota. O contas a pagar dela precisa ser lançado à mão.'
        );
      }
    } else if (Array.isArray(body.duplicatas)) {
      // Nota digitada (sem XML): as parcelas vêm da tela, porque não há de
      // onde mais tirá-las.
      duplicatas = body.duplicatas
        .map((d) => ({ numero: d.numero || null, vencimento: d.vencimento || null, valor: Number(d.valor) }))
        .filter((d) => d.valor > 0);
    }

    const totalNota = Number(notaRows[0].valor_total) || null;
    const somaDup = duplicatas.reduce((acc, d) => acc + (Number(d.valor) || 0), 0);
    // A soma das duplicatas tem que fechar com o total da nota. Quando não
    // fecha, o aviso é escrito — e as duplicatas continuam valendo, porque
    // elas são o que o fornecedor vai cobrar. O que não pode é ninguém saber.
    if (duplicatas.length > 0 && totalNota != null && Math.abs(somaDup - totalNota) > 0.02) {
      avisosFinanceiro.push(
        `A soma das duplicatas (${somaDup.toFixed(2)}) não fecha com o total da nota `
        + `(${totalNota.toFixed(2)}). As parcelas foram lançadas como estão na nota; confira antes de pagar.`
      );
    }

    const financeiro = { titulos: [], pendencia: null };
    if (duplicatas.length > 0) {
      // Parcelamento gera N TÍTULOS IRMÃOS, com a MESMA competência. Propagar
      // a competência junto com o vencimento transformaria o DRE por
      // competência num fluxo de caixa disfarçado — é o erro nº 1 de quem
      // implementa parcelamento.
      const r = await ponte.registrar(client, {
        origem_codigo: 'nota_entrada',
        origem_id: notaId,
        empresa_id: empresaId,
        descricao: `NF ${notaRows[0].numero || notaId} — ${notaRows[0].emitente_nome || 'fornecedor'}`,
        documento: `NF ${notaRows[0].numero || notaId}`,
        fornecedor_id: inteiroPositivo(nota.fornecedor_id),
        contraparte_nome: notaRows[0].emitente_nome || null,
        valor_estimado: totalNota,
        data_competencia: notaRows[0].data_entrada || notaRows[0].data_emissao,
        data_vencimento: duplicatas[0].vencimento,
        detalhe: { base: 'duplicatas do XML (bloco cobr/dup)', duplicatas, total_nota: totalNota },
        usuarioId: req.user?.id || null,
        // A ponte não gera o título sozinha aqui: quem manda são as
        // duplicatas, e elas são N.
        autoTitulo: false,
      });
      financeiro.pendencia = r.pendencia;

      if (r.pendencia && r.pendencia.situacao === 'aberta' && empresaId && r.pendencia.plano_id) {
        const { criarTitulo } = require('../lib/financeiroTitulos');
        for (const [i, d] of duplicatas.entries()) {
          if (!(Number(d.valor) > 0) || !d.vencimento) continue;
          const titulo = await criarTitulo(client, {
            empresa_id: empresaId,
            natureza: 'pagar',
            fornecedor_id: inteiroPositivo(nota.fornecedor_id),
            contraparte_nome: notaRows[0].emitente_nome || null,
            descricao: `NF ${notaRows[0].numero || notaId} — parcela ${i + 1}/${duplicatas.length}`,
            documento: `NF ${notaRows[0].numero || notaId}`,
            parcela: `${i + 1}/${duplicatas.length}`,
            plano_id: r.pendencia.plano_id,
            centro_custo_id: r.pendencia.centro_custo_id,
            // MESMA competência em todas as parcelas. Ver o comentário acima.
            data_competencia: r.pendencia.data_competencia,
            data_vencimento: d.vencimento,
            valor_bruto: Number(d.valor),
            situacao: 'aberto',
            origem_tipo: 'nota_entrada',
            origem_id: notaId,
            observacao: d.numero ? `Duplicata ${d.numero} da nota.` : null,
            usuarioId: req.user?.id || null,
          });
          await client.query(
            'INSERT INTO fin_pendencia_titulos (pendencia_id, titulo_id) VALUES ($1,$2)',
            [r.pendencia.id, titulo.id]
          );
          financeiro.titulos.push(titulo);
        }
        if (financeiro.titulos.length > 0) {
          await client.query(
            `UPDATE fin_pendencias SET situacao = 'atendida', atendida_em = now(), atendida_por = $2,
                    atualizado_em = now() WHERE id = $1`,
            [r.pendencia.id, req.user?.id || null]
          );
        }
      }
      if (financeiro.titulos.length === 0) {
        avisosFinanceiro.push(
          'A nota foi lançada e o compromisso com o fornecedor está na Caixa de Entrada do Financeiro '
          + '— falta a empresa (CNPJ) ou a categoria do DRE para virar contas a pagar.'
        );
      }
    } else {
      // Sem duplicata no XML não se inventa prazo. A necessidade vai para a
      // fila SEM vencimento, e a tela diz por quê — um "30 dias" chutado aqui
      // envenenaria o fluxo de caixa sem ninguém perceber.
      const r = await ponte.registrar(client, {
        origem_codigo: 'nota_entrada',
        origem_id: notaId,
        empresa_id: empresaId,
        descricao: `NF ${notaRows[0].numero || notaId} — ${notaRows[0].emitente_nome || 'fornecedor'}`,
        documento: `NF ${notaRows[0].numero || notaId}`,
        fornecedor_id: inteiroPositivo(nota.fornecedor_id),
        contraparte_nome: notaRows[0].emitente_nome || null,
        valor_estimado: totalNota,
        data_competencia: notaRows[0].data_entrada || notaRows[0].data_emissao,
        detalhe: { base: 'total da nota (o XML não trouxe duplicatas)', total_nota: totalNota },
        usuarioId: req.user?.id || null,
        autoTitulo: false,
      });
      financeiro.pendencia = r.pendencia;
      avisosFinanceiro.push(
        'Esta nota não trouxe duplicatas no XML, então o sistema não inventou prazo. '
        + 'O vencimento precisa ser informado em Financeiro › Caixa de Entrada.'
      );
    }

    await client.query('COMMIT');

    await registrar(req, {
      acao: 'criar', entidade: 'nota_fiscal_entrada', entidadeId: notaId,
      descricao: `Lançou a nota ${notaRows[0].numero || notaRows[0].chave_acesso || notaId} de ${notaRows[0].emitente_nome || 'fornecedor não identificado'}: ${itens.length} item(ns), custo total ${custo.resumo.custoTotal.toFixed(2)}`,
      sucesso: true,
    });

    res.status(201).json({
      nota: notaRows[0], custosAtualizados: resultado, resumo: custo.resumo,
      avisos: [...custo.avisos, ...avisosFinanceiro],
      financeiro,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Essa nota já foi lançada (a chave de acesso já existe no sistema).' });
    }
    await registrar(req, {
      acao: 'criar', entidade: 'nota_fiscal_entrada',
      descricao: `Tentou lançar uma nota e falhou: ${err.message}`, sucesso: false,
    }).catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Listagem das notas lançadas.
router.get('/notas/lista', async (req, res, next) => {
  try {
    const cond = [];
    const vals = [];
    if (req.query.situacao) { vals.push(req.query.situacao); cond.push(`n.situacao = $${vals.length}`); }
    if (req.query.fornecedor_id) { vals.push(req.query.fornecedor_id); cond.push(`n.fornecedor_id = $${vals.length}`); }
    if (req.query.busca) {
      vals.push(`%${req.query.busca}%`);
      cond.push(`(n.numero ILIKE $${vals.length} OR n.emitente_nome ILIKE $${vals.length} OR n.chave_acesso ILIKE $${vals.length})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT n.*, f.nome AS fornecedor_nome, e.nome AS empresa_nome, u.nome AS lancada_por_nome,
              i.qtd_itens, i.custo_total
         FROM notas_fiscais_entrada n
         LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
         LEFT JOIN empresas e ON e.id = n.empresa_id
         LEFT JOIN usuarios u ON u.id = n.lancada_por
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS qtd_itens,
                  SUM(custo_unitario_final * quantidade) AS custo_total
             FROM nota_fiscal_itens WHERE nota_id = n.id
         ) i ON TRUE
         ${where}
         ORDER BY n.data_emissao DESC NULLS LAST, n.id DESC
         LIMIT 300`,
      vals
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
