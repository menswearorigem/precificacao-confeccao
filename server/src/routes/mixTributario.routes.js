// API do Mix tributário B2B × B2C (07/09/2026).
//
// Responde a pergunta que tem prazo: quanto do faturamento de cada empresa
// vai para cliente que aproveita crédito de IBS/CBS (CNPJ) e quanto vai para
// consumidor final (CPF e marketplace), mês a mês.
//
// REGRA 1 — nada aqui recalcula preço, margem, markup ou imposto. O único
// número lido do pedido é o total que já está gravado nele.
//
// REGRA 2 — a classificação sai do motor puro em lib/mixTributario.js, que
// recusa chutar o lado de quem não tem documento. Esta rota só busca as
// linhas e entrega. Pedido cancelado fica de fora; pedido sem total gravado
// é contado à parte, nunca como zero.
//
// REGRA 4 — nenhuma tabela nova, nenhuma coluna nova, nenhuma permissão
// nova. Fica sob o módulo `analises`, que é onde a pergunta vive.
const express = require('express');
const pool = require('../db/pool');
const mix = require('../lib/mixTributario');

const router = express.Router();

const MESES_PADRAO = 12;

function quantidadeDeMeses(req) {
  const n = Number(req.query?.meses);
  if (!Number.isFinite(n)) return MESES_PADRAO;
  return Math.min(36, Math.max(3, Math.round(n)));
}

function mesAtual(hoje = new Date()) {
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

// Primeiro dia do mês mais antigo da janela, em 'YYYY-MM-DD'.
function primeiroDia(meses) {
  return `${meses[0]}-01`;
}

async function listarEmpresas() {
  const { rows } = await pool.query(
    `SELECT id, nome, regime_tributario, cnpj
       FROM empresas
      WHERE ativo
      ORDER BY ordem, nome`
  );
  return rows;
}

// As linhas cruas do período. Uma linha por pedido — a classificação é
// feita em memória pelo motor puro, que é o mesmo código coberto pelo teste
// automatizado.
//
// O JOIN com clientes é por chave (cliente_id), nunca por nome (REGRA 2).
async function buscarPedidos({ desde, empresaId }) {
  const valores = [desde];
  let filtroEmpresa = '';
  if (empresaId) {
    valores.push(empresaId);
    filtroEmpresa = ' AND pv.empresa_id = $2';
  }
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', pv.data_pedido), 'YYYY-MM') AS mes,
            pv.id,
            pv.total_liquido,
            pv.origem_marketplace,
            pv.canal_venda,
            pv.empresa_id,
            c.id   AS cliente_id,
            c.nome AS cliente_nome,
            c.cpf_cnpj,
            c.tipo_pessoa
       FROM pedidos_venda pv
       LEFT JOIN clientes c ON c.id = pv.cliente_id
      WHERE pv.situacao <> 'cancelado'
        AND pv.data_pedido >= $1::date${filtroEmpresa}
      ORDER BY pv.data_pedido`,
    valores
  );
  return rows;
}

function paraMotor(linha) {
  return {
    mes: linha.mes,
    // total_liquido NULL vira null (fora da soma), nunca 0.
    valor: linha.total_liquido === null || linha.total_liquido === undefined ? null : Number(linha.total_liquido),
    origemMarketplace: linha.origem_marketplace,
    canalVenda: linha.canal_venda,
    cpfCnpj: linha.cpf_cnpj,
    tipoPessoa: linha.tipo_pessoa,
    cliente: linha.cliente_nome,
  };
}

// Quem são os clientes do lado B2B, do maior para o menor. É a lista que a
// pessoa leva para a conversa: são estes os lojistas que passam a se
// importar com o crédito que a nota dá.
function rankingB2b(linhas, limite = 20) {
  const porCliente = new Map();
  for (const linha of linhas) {
    const classificacao = mix.classificarPedido(paraMotor(linha));
    if (classificacao.lado !== 'b2b') continue;
    const chave = linha.cliente_id ?? `sem-cadastro:${linha.cliente_nome || '—'}`;
    if (!porCliente.has(chave)) {
      porCliente.set(chave, {
        cliente_id: linha.cliente_id ?? null,
        nome: linha.cliente_nome || 'Cliente sem cadastro',
        documento: classificacao.documento.digitos || null,
        criterio: classificacao.criterio,
        valor: 0,
        pedidos: 0,
        pedidosSemValor: 0,
      });
    }
    const alvo = porCliente.get(chave);
    alvo.pedidos += 1;
    const valor = mix.valorDoPedido(paraMotor(linha));
    if (valor === null) alvo.pedidosSemValor += 1;
    else alvo.valor += valor;
  }
  return Array.from(porCliente.values()).sort((a, b) => b.valor - a.valor).slice(0, limite);
}

router.get('/', async (req, res, next) => {
  try {
    const quantidade = quantidadeDeMeses(req);
    const meses = mix.listarMeses(mesAtual(), quantidade);
    const empresaId = Number(req.query.empresa_id) || null;

    const [empresas, linhas] = await Promise.all([
      listarEmpresas(),
      buscarPedidos({ desde: primeiroDia(meses), empresaId }),
    ]);

    const pedidos = linhas.map(paraMotor);
    const comPresuncao = mix.agregar(pedidos, { presumirCanal: true, mesesEsperados: meses });
    const somenteDocumentado = mix.agregar(pedidos, { presumirCanal: false, mesesEsperados: meses });

    const avisos = [...comPresuncao.avisos];
    // Pedido sem empresa vinculada não pertence a CNPJ nenhum — e a decisão
    // do Simples é por empresa. Ficar calado sobre isso seria entregar um
    // número que não é de ninguém.
    const semEmpresa = linhas.filter((l) => l.empresa_id === null).length;
    if (!empresaId && semEmpresa > 0) {
      avisos.push(
        `${semEmpresa} pedido(s) não têm empresa vinculada. Eles entram no total geral, mas não `
        + 'aparecem quando você filtra por uma empresa — a decisão do Simples é por CNPJ.'
      );
    }
    const semCliente = linhas.filter((l) => l.cliente_id === null).length;
    if (semCliente > 0) {
      avisos.push(`${semCliente} pedido(s) não têm cliente vinculado, então não há documento para classificar.`);
    }

    res.json({
      periodo: { meses, quantidade, inicio: primeiroDia(meses), fim: meses[meses.length - 1] },
      empresas,
      empresa_id: empresaId,
      com_presuncao: comPresuncao,
      somente_documentado: somenteDocumentado,
      ranking_b2b: rankingB2b(linhas),
      criterios: mix.CRITERIOS,
      lados: mix.LADOS,
      prazo_opcao_simples: {
        data: mix.PRAZO_OPCAO_SIMPLES,
        dias_restantes: mix.diasAteOPrazo(),
        fonte: 'Janela de opção do Simples Nacional pelo regime regular de IBS/CBS, de 1 a 30 de setembro de 2026, com efeito a partir de janeiro de 2027.',
      },
      avisos,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
