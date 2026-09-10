// Cores e grade de tamanho no CADASTRO DO PRODUTO (09/09/2026).
//
// Pedido do dono, literal: "no cadastro de produtos, não é possível adicionar
// grade ou cores por enquanto, quero que você dê essa opção, visto que na hora
// da criação da ordem de produção vai ser usada a grade pré-criada do produto.
// Além disso, todos os produtos que já têm informações de grade e cores, você
// vai adicionar essas informações no cadastro desses produtos (ex.: na OG1620
// temos azul, verde, vermelho, mas eu não consigo ver essa informação em lugar
// algum e nem consigo editar, excluir ou adicionar novas cores)."
//
// O "além disso" foi feito na migration 0063, que leu `estoque_variantes` e
// preencheu o cadastro de toda referência que já produz. Este arquivo é a parte
// de editar.
//
// ---------------------------------------------------------------------------
// A regra que organiza tudo aqui
// ---------------------------------------------------------------------------
// CADASTRO E ESTOQUE SÃO COISAS DIFERENTES, e a confusão entre os dois é o que
// causa perda de saldo:
//
//   · tirar uma cor do CADASTRO faz ela sumir das telas novas (ordem de
//     produção, geração de variante). É reversível e não mexe em saldo;
//   · apagar a VARIANTE apaga o saldo. Isso continua sendo feito só na tela de
//     Estoque, com as travas que ela já tem.
//
// Por isso desativar cor com saldo é permitido — e avisado. Excluir a linha do
// cadastro, não: excluir é só para cor que nunca virou variante.

const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const { gradeDoProduto, montarMatriz, pesoTamanho } = require('../lib/produtoGrade');
const { resolverEan } = require('../lib/eanResolver');

const router = express.Router();

function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function texto(v) {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
router.get('/:produtoId', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.params.produtoId);
    if (!produtoId) return res.status(400).json({ error: 'Produto inválido.' });

    const grade = await gradeDoProduto(pool, produtoId, { incluirInativos: req.query.todas === 'true' });
    const matriz = montarMatriz(grade);

    // Quantas células da matriz ainda não existem como variante. É o número
    // que responde "quantas peças de grade eu ainda tenho que criar" antes de
    // abrir uma ordem — e é ele que o botão "gerar variantes" usa.
    const semVariante = matriz.linhas.reduce(
      (s, l) => s + l.celulas.filter((c) => c.variante_id == null).length, 0
    );

    res.json({
      ...grade,
      matriz,
      resumo: {
        cores: grade.cores.length,
        tamanhos: grade.tamanhos.length,
        combinacoes: grade.cores.length * grade.tamanhos.length,
        variantes: grade.variantes.length,
        semVariante,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Gravação em bloco — é assim que a tela salva
// ---------------------------------------------------------------------------
// Uma chamada só, com as duas listas inteiras. Salvar cor a cor obrigaria a
// tela a decidir sozinha o que fazer quando a terceira chamada falha depois de
// as duas primeiras terem passado — e o cadastro ficaria pela metade sem
// ninguém perceber.
router.put('/:produtoId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const produtoId = inteiroPositivo(req.params.produtoId);
    if (!produtoId) return res.status(400).json({ error: 'Produto inválido.' });

    const cores = Array.isArray(req.body?.cores) ? req.body.cores : null;
    const tamanhos = Array.isArray(req.body?.tamanhos) ? req.body.tamanhos : null;
    if (!cores && !tamanhos) return res.status(400).json({ error: 'Nada para salvar.' });

    const { rows: prod } = await pool.query('SELECT referencia FROM produtos WHERE id = $1', [produtoId]);
    if (prod.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });

    // Duas grafias da mesma cor no mesmo envio ("Azul" e "azul") viram uma
    // violação de unicidade no meio do laço, e a mensagem do Postgres não
    // ajudaria ninguém. Melhor recusar dizendo qual é a cor repetida.
    const repetida = (lista, campo) => {
      const vistos = new Map();
      for (const item of lista) {
        const v = texto(item?.[campo]);
        if (!v) continue;
        const chave = v.toLocaleLowerCase('pt-BR');
        if (vistos.has(chave)) return `${vistos.get(chave)} e ${v}`;
        vistos.set(chave, v);
      }
      return null;
    };
    if (cores) {
      const dup = repetida(cores, 'cor');
      if (dup) return res.status(400).json({ error: `A mesma cor aparece duas vezes: ${dup}.` });
    }
    if (tamanhos) {
      const dup = repetida(tamanhos, 'tamanho');
      if (dup) return res.status(400).json({ error: `O mesmo tamanho aparece duas vezes: ${dup}.` });
    }

    await client.query('BEGIN');

    const removidas = [];

    if (cores) {
      const nomes = cores.map((c) => texto(c.cor)).filter(Boolean);
      // Cor que saiu da lista: só desaparece do cadastro se nunca virou
      // variante. Com variante (mesmo zerada, mesmo inativa), ela é DESATIVADA
      // — apagar a linha do cadastro deixaria a variante órfã de cadastro e a
      // cor voltaria a ser invisível, que é o problema de origem.
      const { rows: atuais } = await client.query(
        'SELECT id, cor FROM produto_cores WHERE produto_id = $1', [produtoId]
      );
      for (const a of atuais) {
        if (nomes.some((n) => n.toLocaleLowerCase('pt-BR') === a.cor.toLocaleLowerCase('pt-BR'))) continue;
        const { rows: uso } = await client.query(
          'SELECT COUNT(*)::int AS n, COALESCE(SUM(quantidade),0) AS saldo FROM estoque_variantes WHERE produto_id = $1 AND cor = $2',
          [produtoId, a.cor]
        );
        if (uso[0].n > 0) {
          await client.query('UPDATE produto_cores SET ativo = FALSE WHERE id = $1', [a.id]);
          removidas.push({
            tipo: 'cor', valor: a.cor, acao: 'desativada',
            motivo: `${uso[0].n} variante(s) no estoque (saldo ${Number(uso[0].saldo)}) ainda usam esta cor.`,
          });
        } else {
          await client.query('DELETE FROM produto_cores WHERE id = $1', [a.id]);
          removidas.push({ tipo: 'cor', valor: a.cor, acao: 'excluida', motivo: null });
        }
      }
      for (let i = 0; i < cores.length; i += 1) {
        const nome = texto(cores[i].cor);
        if (!nome) continue;
        await client.query(
          `INSERT INTO produto_cores (produto_id, cor, hex, ordem, ativo)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (produto_id, cor) DO UPDATE
             SET hex = EXCLUDED.hex, ordem = EXCLUDED.ordem, ativo = EXCLUDED.ativo`,
          [produtoId, nome, texto(cores[i].hex), (i + 1) * 10, cores[i].ativo !== false]
        );
      }
    }

    if (tamanhos) {
      const nomes = tamanhos.map((t) => texto(t.tamanho)).filter(Boolean);
      const { rows: atuais } = await client.query(
        'SELECT id, tamanho FROM produto_tamanhos WHERE produto_id = $1', [produtoId]
      );
      for (const a of atuais) {
        if (nomes.some((n) => n.toLocaleLowerCase('pt-BR') === a.tamanho.toLocaleLowerCase('pt-BR'))) continue;
        const { rows: uso } = await client.query(
          'SELECT COUNT(*)::int AS n, COALESCE(SUM(quantidade),0) AS saldo FROM estoque_variantes WHERE produto_id = $1 AND tamanho = $2',
          [produtoId, a.tamanho]
        );
        if (uso[0].n > 0) {
          await client.query('UPDATE produto_tamanhos SET ativo = FALSE WHERE id = $1', [a.id]);
          removidas.push({
            tipo: 'tamanho', valor: a.tamanho, acao: 'desativado',
            motivo: `${uso[0].n} variante(s) no estoque (saldo ${Number(uso[0].saldo)}) ainda usam este tamanho.`,
          });
        } else {
          await client.query('DELETE FROM produto_tamanhos WHERE id = $1', [a.id]);
          removidas.push({ tipo: 'tamanho', valor: a.tamanho, acao: 'excluido', motivo: null });
        }
      }
      for (const t of tamanhos) {
        const nome = texto(t.tamanho);
        if (!nome) continue;
        // A ordem sai da tabela canônica de tamanhos, não da posição na tela:
        // quem digita "GG" depois de "P" não está dizendo que GG vem depois na
        // grade — está só digitando. Ordem alfabética ou de digitação deixaria
        // a grade ilegível na ordem de produção.
        await client.query(
          `INSERT INTO produto_tamanhos (produto_id, tamanho, ordem, ativo)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (produto_id, tamanho) DO UPDATE
             SET ordem = EXCLUDED.ordem, ativo = EXCLUDED.ativo`,
          [produtoId, nome, t.ordem != null ? Number(t.ordem) : pesoTamanho(nome), t.ativo !== false]
        );
      }
    }

    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'produto_grade', entidadeId: produtoId,
      descricao: `Alterou cores e grade da referência ${prod[0].referencia}`
        + (removidas.length ? ` (${removidas.length} item(ns) removido(s) da lista)` : ''),
      sucesso: true,
    });

    const grade = await gradeDoProduto(pool, produtoId);
    res.json({ ...grade, matriz: montarMatriz(grade), removidas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Gerar as variantes que faltam
// ---------------------------------------------------------------------------
// O cadastro de cor e tamanho diz o que a referência PODE ter; a variante é o
// que ela TEM, com EAN e saldo. Quem acrescenta uma cor nova quase sempre quer
// as duas coisas — mas não sempre (cor exclusiva de um tamanho existe), então
// a criação é um ato separado e a tela mostra quantas células estão vazias.
//
// ⚠️ Nasce com quantidade ZERO e sem movimento de estoque. Criar variante não é
// dar entrada de peça; a peça entra pela produção ou pela importação.
router.post('/:produtoId/gerar-variantes', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const produtoId = inteiroPositivo(req.params.produtoId);
    if (!produtoId) return res.status(400).json({ error: 'Produto inválido.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de criar as variantes.' });
    }

    const { rows: prod } = await pool.query('SELECT referencia FROM produtos WHERE id = $1', [produtoId]);
    if (prod.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });

    const grade = await gradeDoProduto(pool, produtoId);
    const { linhas } = montarMatriz(grade);

    // Quando a tela manda uma seleção, vale a seleção. Sem seleção, vale a
    // matriz inteira — que é o caso comum de "cadastrei a cor nova, cria os
    // seis tamanhos dela".
    const selecao = Array.isArray(req.body?.celulas) && req.body.celulas.length > 0
      ? new Set(req.body.celulas.map((c) => `${c.cor || ''}|${c.tamanho || ''}`))
      : null;

    await client.query('BEGIN');
    const criadas = [];
    for (const linha of linhas) {
      for (const celula of linha.celulas) {
        if (celula.variante_id != null) continue;
        const chave = `${celula.cor}|${celula.tamanho}`;
        if (selecao && !selecao.has(chave)) continue;
        const ean = await resolverEan(client, prod[0].referencia, celula.cor, celula.tamanho, null);
        const { rows } = await client.query(
          `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade)
           VALUES ($1,$2,$3,$4,0)
           ON CONFLICT (produto_id, cor, tamanho) DO NOTHING
           RETURNING id, cor, tamanho, ean`,
          [produtoId, celula.cor, celula.tamanho, ean]
        );
        if (rows.length > 0) criadas.push(rows[0]);
      }
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'criar', entidade: 'produto_grade', entidadeId: produtoId,
      descricao: `Gerou ${criadas.length} variante(s) de grade da referência ${prod[0].referencia}`,
      sucesso: true,
    });

    const atualizada = await gradeDoProduto(pool, produtoId);
    res.status(201).json({
      criadas,
      ...atualizada,
      matriz: montarMatriz(atualizada),
      aviso: criadas.length > 0
        ? `${criadas.length} variante(s) criada(s) com saldo ZERO. Criar variante não é dar entrada de peça — `
          + 'o saldo entra pela conclusão da ordem de produção ou por um movimento de estoque.'
        : 'Nenhuma variante nova: todas as combinações da grade já existiam.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// Puxa cor e tamanho do que já existe no estoque para dentro do cadastro. É o
// mesmo backfill da migration 0063, disponível como botão — para referência
// criada depois dela, ou para variante que entrou por importação em massa.
router.post('/:produtoId/importar-do-estoque', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const produtoId = inteiroPositivo(req.params.produtoId);
    if (!produtoId) return res.status(400).json({ error: 'Produto inválido.' });

    await client.query('BEGIN');
    const { rows: cores } = await client.query(
      `INSERT INTO produto_cores (produto_id, cor, ordem)
       SELECT $1, v.cor, ROW_NUMBER() OVER (ORDER BY v.cor) * 10
         FROM (SELECT DISTINCT cor FROM estoque_variantes WHERE produto_id = $1 AND cor <> '') v
       ON CONFLICT (produto_id, cor) DO NOTHING RETURNING cor`, [produtoId]
    );
    const { rows: variantes } = await client.query(
      `SELECT DISTINCT tamanho FROM estoque_variantes WHERE produto_id = $1 AND tamanho <> ''`, [produtoId]
    );
    const tamanhosNovos = [];
    for (const v of variantes) {
      const { rows } = await client.query(
        `INSERT INTO produto_tamanhos (produto_id, tamanho, ordem) VALUES ($1,$2,$3)
         ON CONFLICT (produto_id, tamanho) DO NOTHING RETURNING tamanho`,
        [produtoId, v.tamanho, pesoTamanho(v.tamanho)]
      );
      if (rows.length > 0) tamanhosNovos.push(rows[0].tamanho);
    }
    await client.query('COMMIT');

    const grade = await gradeDoProduto(pool, produtoId);
    res.json({
      coresImportadas: cores.map((c) => c.cor),
      tamanhosImportados: tamanhosNovos,
      ...grade,
      matriz: montarMatriz(grade),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// Catálogo do sistema inteiro: toda cor e todo tamanho que existem em qualquer
// referência. Serve para a tela sugerir em vez de deixar digitar do zero — que
// é como "Azul" e "Azl" viram duas cores.
router.get('/catalogo/valores', async (req, res, next) => {
  try {
    const [{ rows: cores }, { rows: tamanhos }] = await Promise.all([
      pool.query(
        `SELECT cor, COUNT(*)::int AS usos FROM (
           SELECT cor FROM produto_cores WHERE ativo
           UNION ALL SELECT cor FROM estoque_variantes WHERE cor <> ''
         ) t GROUP BY cor ORDER BY usos DESC, cor`
      ),
      pool.query(
        `SELECT tamanho, COUNT(*)::int AS usos FROM (
           SELECT tamanho FROM produto_tamanhos WHERE ativo
           UNION ALL SELECT tamanho FROM estoque_variantes WHERE tamanho <> ''
         ) t GROUP BY tamanho ORDER BY usos DESC, tamanho`
      ),
    ]);
    res.json({
      cores: cores.map((c) => c.cor),
      tamanhos: tamanhos.map((t) => t.tamanho).sort((a, b) => pesoTamanho(a) - pesoTamanho(b)),
    });
  } catch (err) { next(err); }
});

module.exports = router;
