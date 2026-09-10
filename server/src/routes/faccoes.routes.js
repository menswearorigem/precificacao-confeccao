// Cadastro de FACÇÃO (09/09/2026).
//
// Pedido da dona, literal: "a aba facção vai ser necessário cadastro de
// categorias, ex.: costureira, lavanderia, e outros, podendo alterar dentro do
// módulo de produção; essas facções criadas deverão ser tão completas quanto o
// preenchimento de fornecedores — se for pessoa jurídica quero cadastrar CNPJ,
// nome, razão social, e campos adicionais, contato, o endereço, forma de
// pagamento padrão, a chave PIX dessa pessoa, e campo observações".
//
// ---------------------------------------------------------------------------
// Facção É um fornecedor. Por quê
// ---------------------------------------------------------------------------
// Onze tabelas apontam para `fornecedores(id)` — O.S., tabela de preço,
// movimento de produção, saldo de insumo em poder de terceiro, título a pagar.
// Uma tabela `faccoes` paralela obrigaria cada uma delas a escolher qual das
// duas chaves vale, e a resposta certa mudaria conforme a tabela. Facção passa
// a ser um fornecedor MARCADO como facção (`eh_faccao`), com categoria própria.
//
// O efeito prático que a dona vai ver: o combo "Escolha a facção" para de
// listar o fornecedor de embalagem, e a costureira ganha ficha própria com
// quebra, atraso e custo por peça — que é o que não existia.
//
// ---------------------------------------------------------------------------
// REGRA 4 — nada é apagado de verdade
// ---------------------------------------------------------------------------
// Facção com O.S., preço ou movimento não é excluída: é DESATIVADA. Excluir
// apagaria o histórico de quem costurou o quê, que é justamente o que se
// precisa três semanas depois, quando falta peça.

const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const { cnpjValido, cpfValido } = require('../lib/mixTributario');

const router = express.Router();

function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function texto(v) {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}
function soDigitos(v) {
  return String(v ?? '').replace(/\D/g, '');
}

// Campos que a facção compartilha com qualquer fornecedor, mais os que a 0063
// acrescentou. É a mesma lista branca do cadastro de fornecedor — de propósito:
// a dona pediu um cadastro "tão completo quanto o de fornecedores", e duas
// listas diferentes garantiriam que uma delas ficasse para trás.
const CAMPOS = [
  'tipo_pessoa', 'nome', 'nome_fantasia', 'razao_social', 'cpf_cnpj', 'ie', 'ie_isento',
  'telefone', 'email', 'contato_nome', 'contato_telefone',
  'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf',
  'categoria_principal', 'condicao_pagamento_padrao', 'forma_pagamento_padrao',
  'chave_pix', 'pix_tipo', 'dados_bancarios', 'observacoes',
  'faccao_categoria_id', 'faccao_capacidade_mes', 'campos_adicionais', 'ativo',
];

// ===========================================================================
// CATEGORIAS — costureira, lavanderia, bordado…
// ===========================================================================
router.get('/categorias', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, e.nome AS etapa_nome,
              (SELECT COUNT(*) FROM fornecedores f
                WHERE f.faccao_categoria_id = c.id AND f.eh_faccao AND f.ativo) AS faccoes
         FROM faccao_categorias c
         LEFT JOIN producao_etapas e ON e.id = c.etapa_id
        ${req.query.todas === 'true' ? '' : 'WHERE c.ativo'}
        ORDER BY c.ordem, c.nome`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/categorias', async (req, res, next) => {
  try {
    const nome = texto(req.body?.nome);
    if (!nome) return res.status(400).json({ error: 'A categoria precisa de um nome.' });
    const { rows } = await pool.query(
      `INSERT INTO faccao_categorias (nome, etapa_id, ordem, observacao)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [nome, inteiroPositivo(req.body?.etapa_id), Number(req.body?.ordem) || 0, texto(req.body?.observacao)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
    next(err);
  }
});

router.put('/categorias/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Categoria inválida.' });
    const b = req.body || {};
    // UPDATE dinâmico, e não COALESCE em todos os campos: `etapa_id` precisa
    // poder voltar a ser NULO ("esta categoria não é uma etapa do fluxo"), e
    // com COALESCE não existiria caminho para limpar o campo.
    const colunas = [];
    const vals = [id];
    const set = (col, valor) => { vals.push(valor); colunas.push(`${col} = $${vals.length}`); };
    if (b.nome !== undefined) {
      if (!texto(b.nome)) return res.status(400).json({ error: 'A categoria precisa de um nome.' });
      set('nome', texto(b.nome));
    }
    if (b.etapa_id !== undefined) set('etapa_id', inteiroPositivo(b.etapa_id));
    if (b.ordem !== undefined) set('ordem', Number(b.ordem) || 0);
    if (b.observacao !== undefined) set('observacao', texto(b.observacao));
    if (b.ativo !== undefined) set('ativo', Boolean(b.ativo));
    if (colunas.length === 0) return res.status(400).json({ error: 'Nada para alterar.' });

    const { rows } = await pool.query(
      `UPDATE faccao_categorias SET ${colunas.join(', ')}, atualizado_em = now()
        WHERE id = $1 RETURNING *`,
      vals
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Categoria não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
    next(err);
  }
});

// Excluir categoria só quando ninguém a usa. Com facção pendurada, desativa —
// senão a facção ficaria sem categoria de um dia para o outro e ninguém saberia
// por quê.
router.delete('/categorias/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Categoria inválida.' });
    const { rows: uso } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM fornecedores WHERE faccao_categoria_id = $1', [id]
    );
    if (uso[0].n > 0) {
      await pool.query('UPDATE faccao_categorias SET ativo = FALSE, atualizado_em = now() WHERE id = $1', [id]);
      return res.json({
        ok: true, desativada: true,
        aviso: `${uso[0].n} facção(ões) usam esta categoria, então ela foi DESATIVADA em vez de excluída. `
          + 'Ela some das listas novas e continua identificando quem já estava nela.',
      });
    }
    const { rowCount } = await pool.query('DELETE FROM faccao_categorias WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Categoria não encontrada.' });
    res.json({ ok: true, desativada: false });
  } catch (err) { next(err); }
});

// ===========================================================================
// FACÇÕES
// ===========================================================================
// A listagem já traz o que decide: quanto está fora, quanto quebrou, se está
// atrasada e quanto custa por peça. Sem isso, escolher facção continua sendo
// pelo telefone.
router.get('/', async (req, res, next) => {
  try {
    const cond = ['f.eh_faccao'];
    const vals = [];
    if (req.query.ativo === 'nao') cond.push('NOT f.ativo');
    else if (req.query.ativo !== 'todos') cond.push('f.ativo');
    if (req.query.categoria_id) {
      vals.push(Number(req.query.categoria_id));
      cond.push(`f.faccao_categoria_id = $${vals.length}`);
    }
    if (req.query.busca) {
      vals.push(`%${req.query.busca}%`);
      const i = vals.length;
      cond.push(`(f.nome ILIKE $${i} OR f.nome_fantasia ILIKE $${i} OR f.razao_social ILIKE $${i}
                  OR f.cpf_cnpj ILIKE $${i} OR f.contato_nome ILIKE $${i} OR f.cidade ILIKE $${i})`);
    }

    const { rows } = await pool.query(
      `SELECT f.*, c.nome AS categoria_nome, c.etapa_id AS categoria_etapa_id,
              COALESCE(q.os_abertas, 0) AS os_abertas,
              COALESCE(q.pecas_fora, 0) AS pecas_fora,
              q.quebra_fracao, q.atrasadas, q.custo_peca_medio, q.ultima_remessa,
              COALESCE(p.precos, 0) AS precos_cadastrados
         FROM fornecedores f
         LEFT JOIN faccao_categorias c ON c.id = f.faccao_categoria_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE q.situacao IN ('remetida','parcial')) AS os_abertas,
                  SUM(q.remetido - q.retornado_bom - q.retornado_segunda - q.perda_declarada)
                    FILTER (WHERE q.situacao IN ('remetida','parcial')) AS pecas_fora,
                  CASE WHEN SUM(q.remetido) > 0 THEN SUM(q.quebra) / SUM(q.remetido) END AS quebra_fracao,
                  COUNT(*) FILTER (WHERE q.data_retorno IS NULL AND q.previsao_retorno < CURRENT_DATE
                                     AND q.situacao IN ('remetida','parcial')) AS atrasadas,
                  CASE WHEN SUM(q.retornado_bom) > 0
                       THEN SUM(q.valor_servico) / SUM(q.retornado_bom) END AS custo_peca_medio,
                  MAX(q.data_remessa) AS ultima_remessa
             FROM vw_faccao_quebra q WHERE q.fornecedor_id = f.id
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS precos FROM faccao_tabela_preco t
            WHERE t.fornecedor_id = f.id
              AND (t.vigencia_fim IS NULL OR t.vigencia_fim >= CURRENT_DATE)
         ) p ON TRUE
        WHERE ${cond.join(' AND ')}
        ORDER BY f.nome`,
      vals
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Lista enxuta para os combos das telas de produção. Devolve só identificação
// — nome, categoria, etapa sugerida — e nunca dado financeiro: quem movimenta
// peça no chão de fábrica não precisa saber quanto a facção fatura.
router.get('/opcoes', async (req, res, next) => {
  try {
    const [{ rows: faccoes }, { rows: categorias }] = await Promise.all([
      pool.query(
        `SELECT f.id, f.nome, f.nome_fantasia, f.faccao_categoria_id,
                c.nome AS categoria_nome, c.etapa_id AS categoria_etapa_id
           FROM fornecedores f
           LEFT JOIN faccao_categorias c ON c.id = f.faccao_categoria_id
          WHERE f.eh_faccao AND f.ativo
          ORDER BY f.nome`
      ),
      pool.query('SELECT id, nome, etapa_id FROM faccao_categorias WHERE ativo ORDER BY ordem, nome'),
    ]);
    res.json({ faccoes, categorias });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Facção inválida.' });

    const { rows } = await pool.query(
      `SELECT f.*, c.nome AS categoria_nome
         FROM fornecedores f
         LEFT JOIN faccao_categorias c ON c.id = f.faccao_categoria_id
        WHERE f.id = $1`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Facção não encontrada.' });

    const [{ rows: ordensServico }, { rows: precos }, { rows: material }] = await Promise.all([
      pool.query(
        `SELECT q.*, e.nome AS etapa_nome, o.numero AS ordem_numero, p.referencia
           FROM vw_faccao_quebra q
           LEFT JOIN producao_etapas e ON e.id = q.etapa_id
           LEFT JOIN ordens_producao o ON o.id = q.ordem_id
           LEFT JOIN produtos p ON p.id = o.produto_id
          WHERE q.fornecedor_id = $1
          ORDER BY q.data_remessa DESC NULLS LAST, q.numero DESC LIMIT 100`, [id]
      ),
      pool.query(
        `SELECT t.*, e.nome AS etapa_nome, p.referencia AS produto_referencia
           FROM faccao_tabela_preco t
           JOIN producao_etapas e ON e.id = t.etapa_id
           LEFT JOIN produtos p ON p.id = t.produto_id
          WHERE t.fornecedor_id = $1
          ORDER BY e.sequencia, t.vigencia_inicio DESC`, [id]
      ),
      pool.query(
        `SELECT s.insumo_id, i.nome AS insumo_nome, i.unidade, s.quantidade, i.custo_atual
           FROM insumo_saldos s JOIN insumos i ON i.id = s.insumo_id
          WHERE s.local = 'faccao' AND s.fornecedor_id = $1 AND s.quantidade <> 0
          ORDER BY i.nome`, [id]
      ),
    ]);

    res.json({ faccao: rows[0], ordensServico, precos, material });
  } catch (err) { next(err); }
});

function validarDocumento(body) {
  const doc = soDigitos(body.cpf_cnpj);
  if (!doc) return null;
  const pj = (body.tipo_pessoa || 'PJ') === 'PJ';
  if (pj && doc.length !== 14) return 'O CNPJ precisa ter 14 dígitos.';
  if (!pj && doc.length !== 11) return 'O CPF precisa ter 11 dígitos.';
  // O dígito verificador é conferido porque um CNPJ errado só aparece na hora
  // de emitir a nota de remessa — semanas depois, com a mercadoria já fora.
  if (pj && !cnpjValido(doc)) return 'Este CNPJ não é válido (o dígito verificador não fecha).';
  if (!pj && !cpfValido(doc)) return 'Este CPF não é válido (o dígito verificador não fecha).';
  return null;
}

async function documentoRepetido(id, cpfCnpj) {
  const doc = soDigitos(cpfCnpj);
  if (!doc) return null;
  const { rows } = await pool.query(
    `SELECT id, nome FROM fornecedores
      WHERE regexp_replace(COALESCE(cpf_cnpj,''), '\\D', '', 'g') = $1
        AND ($2::int IS NULL OR id <> $2)
      LIMIT 1`,
    [doc, id]
  );
  return rows[0] || null;
}

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!texto(body.nome)) return res.status(400).json({ error: 'A facção precisa de um nome.' });
    const erroDoc = validarDocumento(body);
    if (erroDoc) return res.status(400).json({ error: erroDoc });

    // Duplicidade avisa, não bloqueia: a mesma pessoa às vezes é cadastrada
    // como facção e como fornecedor de aviamento, e recusar aqui obrigaria a
    // fundir dois cadastros que a casa quer separados. Mas ninguém pode
    // cadastrar a mesma facção duas vezes sem saber.
    const repetido = await documentoRepetido(null, body.cpf_cnpj);
    if (repetido && body.aceitar_documento_repetido !== true) {
      return res.status(409).json({
        error: `Já existe um cadastro com este documento: ${repetido.nome}. `
          + 'Se for mesmo outro cadastro, confirme para continuar.',
        existente: repetido,
        exige: 'aceitar_documento_repetido',
      });
    }

    const colunas = CAMPOS.filter((c) => body[c] !== undefined);
    colunas.push('eh_faccao');
    const valores = colunas.map((c) => {
      if (c === 'eh_faccao') return true;
      if (c === 'campos_adicionais') return JSON.stringify(body[c] || {});
      return body[c] === '' ? null : body[c];
    });

    const { rows } = await pool.query(
      `INSERT INTO fornecedores (${colunas.join(', ')})
       VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      valores
    );

    await registrar(req, {
      acao: 'criar', entidade: 'faccao', entidadeId: rows[0].id,
      descricao: `Cadastrou a facção ${rows[0].nome}`, sucesso: true,
    });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Facção inválida.' });
    const body = req.body || {};
    if (body.nome !== undefined && !texto(body.nome)) {
      return res.status(400).json({ error: 'A facção precisa de um nome.' });
    }
    const erroDoc = validarDocumento({ ...body, tipo_pessoa: body.tipo_pessoa || 'PJ' });
    if (body.cpf_cnpj !== undefined && erroDoc) return res.status(400).json({ error: erroDoc });

    if (body.cpf_cnpj !== undefined) {
      const repetido = await documentoRepetido(id, body.cpf_cnpj);
      if (repetido && body.aceitar_documento_repetido !== true) {
        return res.status(409).json({
          error: `Já existe outro cadastro com este documento: ${repetido.nome}.`,
          existente: repetido, exige: 'aceitar_documento_repetido',
        });
      }
    }

    const colunas = CAMPOS.filter((c) => body[c] !== undefined);
    if (colunas.length === 0) return res.status(400).json({ error: 'Nada para alterar.' });
    const valores = colunas.map((c) => {
      if (c === 'campos_adicionais') return JSON.stringify(body[c] || {});
      return body[c] === '' ? null : body[c];
    });

    const { rows } = await pool.query(
      `UPDATE fornecedores SET ${colunas.map((c, i) => `${c} = $${i + 2}`).join(', ')},
              eh_faccao = TRUE, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, ...valores]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Facção não encontrada.' });

    await registrar(req, {
      acao: 'alterar', entidade: 'faccao', entidadeId: id,
      descricao: `Alterou a facção ${rows[0].nome}`, sucesso: true,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// "Excluir" uma facção que já trabalhou apagaria o histórico de quem costurou o
// quê — que é o dado mais cobrado três semanas depois. Por isso a rota desativa
// e explica; só some de verdade quem nunca foi usado.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Facção inválida.' });
    const { rows: uso } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM ordens_servico WHERE fornecedor_id = $1)::int AS os,
         (SELECT COUNT(*) FROM faccao_movimentos WHERE fornecedor_id = $1)::int AS movimentos,
         (SELECT COUNT(*) FROM faccao_tabela_preco WHERE fornecedor_id = $1)::int AS precos,
         (SELECT COUNT(*) FROM compras WHERE fornecedor_id = $1)::int AS compras`,
      [id]
    );
    const u = uso[0];
    const total = u.os + u.movimentos + u.precos + u.compras;
    if (total > 0) {
      const { rows } = await pool.query(
        'UPDATE fornecedores SET ativo = FALSE, updated_at = now() WHERE id = $1 RETURNING nome', [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Facção não encontrada.' });
      return res.json({
        ok: true, desativada: true,
        aviso: `${rows[0].nome} tem histórico no sistema (${u.os} O.S., ${u.movimentos} movimento(s), `
          + `${u.precos} preço(s), ${u.compras} compra(s)), então foi DESATIVADA em vez de excluída. `
          + 'Ela some das listas de escolha e o histórico continua respondendo por ela.',
      });
    }
    const { rowCount } = await pool.query('DELETE FROM fornecedores WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Facção não encontrada.' });
    res.json({ ok: true, desativada: false });
  } catch (err) {
    if (err.code === '23503') {
      await pool.query('UPDATE fornecedores SET ativo = FALSE WHERE id = $1', [req.params.id]);
      return res.json({ ok: true, desativada: true, aviso: 'A facção tem vínculos no sistema e foi desativada.' });
    }
    next(err);
  }
});

// ===========================================================================
// TABELA DE PREÇO DE SERVIÇO
// ===========================================================================
// A 0054 criou a tabela e a rota de gravação, mas nunca existiu tela: o sistema
// dizia "cadastre o preço da facção" em três lugares e não havia onde fazer
// isso a não ser por SQL. Toda O.S. nascia sem preço. Agora o cadastro vive na
// ficha da facção, que é onde alguém pensa nele.
router.post('/:id/precos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    const etapaId = inteiroPositivo(req.body?.etapa_id);
    const valor = Number(req.body?.valor_por_peca);
    if (!id) return res.status(400).json({ error: 'Facção inválida.' });
    if (!etapaId) return res.status(400).json({ error: 'Escolha a etapa do serviço.' });
    if (!Number.isFinite(valor) || valor < 0) return res.status(400).json({ error: 'Informe o valor por peça.' });

    const inicio = req.body?.vigencia_inicio || new Date().toISOString().slice(0, 10);
    const produtoId = inteiroPositivo(req.body?.produto_id);

    await client.query('BEGIN');
    // Preço novo ENCERRA o anterior no dia anterior ao início do novo, em vez
    // de conviver com ele. Dois preços vigentes ao mesmo tempo para o mesmo
    // par (facção, etapa) fazem o desempate cair no "mais recente", que é uma
    // regra invisível — e a O.S. congelaria um valor que ninguém escolheu.
    await client.query(
      `UPDATE faccao_tabela_preco
          SET vigencia_fim = ($4::date - INTERVAL '1 day')::date
        WHERE fornecedor_id = $1 AND etapa_id = $2
          AND COALESCE(produto_id, 0) = COALESCE($3::int, 0)
          AND (vigencia_fim IS NULL OR vigencia_fim >= $4::date)
          AND vigencia_inicio < $4::date`,
      [id, etapaId, produtoId, inicio]
    );
    const { rows } = await client.query(
      `INSERT INTO faccao_tabela_preco
         (fornecedor_id, etapa_id, produto_id, valor_por_peca, vigencia_inicio, vigencia_fim, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, etapaId, produtoId, valor, inicio, req.body?.vigencia_fim || null,
        texto(req.body?.observacao), req.user?.id || null]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// Encerrar um preço não o apaga: grava a data em que ele deixou de valer. As
// O.S. antigas continuam apontando para a linha que congelaram.
router.post('/precos/:precoId/encerrar', async (req, res, next) => {
  try {
    const precoId = inteiroPositivo(req.params.precoId);
    if (!precoId) return res.status(400).json({ error: 'Preço inválido.' });
    const { rows } = await pool.query(
      `UPDATE faccao_tabela_preco SET vigencia_fim = COALESCE($2::date, CURRENT_DATE)
        WHERE id = $1 RETURNING *`,
      [precoId, req.body?.vigencia_fim || null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Preço não encontrado.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});


// Importa as facções do Wik (cadastro de Departamento -> Fornecedor). Cria as
// que faltam, vincula as de mesmo nome, não sobrescreve o que a casa já editou.
// Detalhes em lib/wikFaccoesImport.js. Só admin, como as demais ações de Wik.
router.post('/importar-wik', async (req, res, next) => {
  try {
    const { importarFaccoesDoWik } = require('../lib/wikFaccoesImport');
    const resumo = await importarFaccoesDoWik();
    try {
      await registrar(req, {
        acao: 'importar-wik', entidade: 'faccao', entidadeId: null,
        descricao: `Importação de facções do Wik: ${resumo.criadas || 0} criadas, ${resumo.vinculadas || 0} vinculadas, ${resumo.jaExistiam || 0} já existiam.`,
        sucesso: true,
      });
    } catch (_) { /* auditoria é best-effort */ }
    res.json(resumo);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
