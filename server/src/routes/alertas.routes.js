const express = require('express');
const pool = require('../db/pool');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

// Central de Alertas (Onda 4, TAREFA 4.3). Os 6 limites já existem em
// Configurações › Parâmetros e já são calculados PRODUTO A PRODUTO por
// calcularProduto (server/src/lib/calc.js, `alertas` no retorno) — hoje só
// aparecem no card "Alertas" da própria ficha, sem visão agregada de
// quantas/quais referências estão fora de cada um agora. Esta rota
// reaproveita a MESMA função/mesmo array de alertas, sem recalcular nada:
// só lê `calculo.alertas` (as frases já prontas) e os números que
// `custoTotal`/`formacaoPreco` já devolvem, e agrupa por tipo.
//
// Exceção: o limite de frete (`alerta_frete_pct`) é checado dentro de
// calcularProduto contra um percentual (frete ÷ custo industrial) que a
// função NÃO devolve no objeto de retorno — só a frase pronta quando já
// está acima do limite. Sem alterar calc.js pra expor esse número (fora
// do escopo autorizado — "se precisar de um número que a fórmula
// existente não devolve, pergunte antes"), a coluna "valor apurado" desse
// grupo específico fica "—": a referência aparece corretamente listada
// (o alerta em si vem exatamente da mesma função), só não repetimos aqui
// um percentual que a função não expõe.
const GRUPOS = [
  { chave: 'materiais', titulo: 'Materiais acima do limite', prefixo: 'Materiais acima do limite', configCampo: 'alerta_materiais_pct', valorCampo: (c) => c.custoTotal.pctMateriais },
  { chave: 'maoDeObra', titulo: 'Mão de obra industrial acima do limite', prefixo: 'Mão de obra industrial acima do limite', configCampo: 'alerta_mao_obra_pct', valorCampo: (c) => c.custoTotal.pctIndustrial },
  { chave: 'impostos', titulo: 'Impostos acima do esperado', prefixo: 'Impostos acima do esperado', configCampo: 'alerta_impostos_pct', valorCampo: (c) => c.custoTotal.pctImpostosDoCusto },
  { chave: 'frete', titulo: 'Frete elevado', prefixo: 'Frete elevado', configCampo: 'alerta_frete_pct', valorCampo: () => null },
  { chave: 'indireto', titulo: 'Custo indireto acima do limite', prefixo: 'Custo indireto acima do limite', configCampo: 'alerta_indireto_pct', valorCampo: (c) => c.custoTotal.pctIndireto },
  { chave: 'lucro', titulo: 'Lucro abaixo da meta', prefixo: 'Lucro abaixo da meta', configCampo: 'meta_lucro_pct', valorCampo: (c) => c.formacaoPreco.lucroPct },
];

router.get('/', async (req, res, next) => {
  try {
    const { marca, categoria, empresa_id } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (marca) { conditions.push(`p.marca = $${i}`); values.push(marca); i += 1; }
    if (categoria) { conditions.push(`p.categoria = $${i}`); values.push(categoria); i += 1; }
    if (empresa_id) { conditions.push(`p.empresa_id = $${i}`); values.push(empresa_id); i += 1; }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: produtos } = await pool.query(`
      SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
             e.iss, e.simples_aliquota, e.outros_impostos
      FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
      ${where}
    `, values);

    const resultado = { total: produtos.length, avaliadas: 0, comAlerta: 0, grupos: {}, naoAvaliavelMateriais: [] };
    for (const g of GRUPOS) resultado.grupos[g.chave] = { titulo: g.titulo, limite: null, referencias: [] };

    if (produtos.length > 0) {
      const ids = produtos.map((p) => p.id);
      const { rows: materiaisRows } = await pool.query('SELECT * FROM materiais WHERE produto_id = ANY($1)', [ids]);
      const { rows: custosRows } = await pool.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1)', [ids]);
      const ctx = await getCalcContext();
      for (const g of GRUPOS) resultado.grupos[g.chave].limite = Number(ctx.config[g.configCampo]);

      for (const p of produtos) {
        const materiaisDoProduto = materiaisRows.filter((m) => m.produto_id === p.id);
        const custosDoProduto = custosRows.filter((c) => c.produto_id === p.id);
        const itensComQtd = materiaisDoProduto.filter((m) => Number(m.quantidade) > 0).length;
        const totalMateriaisBruto = materiaisDoProduto.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0), 0);
        const materiaisZerados = itensComQtd > 0 && totalMateriaisBruto === 0;

        const calculo = produtosRoutes.buildCalculo(p, materiaisDoProduto, custosDoProduto, ctx);
        const avaliavel = calculo.custoTotal.subtotalProducao > 0;
        if (!avaliavel) continue; // sem nenhum custo cadastrado — calcularProduto nem gera alertas pra este produto

        resultado.avaliadas += 1;
        if (calculo.alertas.length > 0 && calculo.alertas[0] !== 'Tudo dentro do esperado') resultado.comAlerta += 1;

        const refInfo = { id: p.id, referencia: p.referencia, descricao: p.descricao };

        if (materiaisZerados) {
          resultado.naoAvaliavelMateriais.push(refInfo);
        } else if (calculo.alertas.some((a) => a.startsWith(GRUPOS[0].prefixo))) {
          resultado.grupos.materiais.referencias.push({ ...refInfo, valorApurado: GRUPOS[0].valorCampo(calculo), desvio: GRUPOS[0].valorCampo(calculo) - resultado.grupos.materiais.limite });
        }

        for (const g of GRUPOS.slice(1)) {
          if (!calculo.alertas.some((a) => a.startsWith(g.prefixo))) continue;
          const valorApurado = g.valorCampo(calculo);
          resultado.grupos[g.chave].referencias.push({
            ...refInfo,
            valorApurado,
            desvio: valorApurado !== null ? valorApurado - resultado.grupos[g.chave].limite : null,
          });
        }
      }
    }

    for (const g of GRUPOS) {
      resultado.grupos[g.chave].total = resultado.grupos[g.chave].referencias.length;
      resultado.grupos[g.chave].referencias.sort((a, b) => (b.desvio || 0) - (a.desvio || 0));
    }
    resultado.naoAvaliavelMateriais.sort((a, b) => a.referencia.localeCompare(b.referencia));

    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
