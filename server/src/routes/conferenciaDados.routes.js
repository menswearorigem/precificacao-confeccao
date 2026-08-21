const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// Só sinaliza — nunca apaga nada. Cada critério aqui é um "cheiro" de dado
// de teste, não uma certeza; por isso a tela que consome isto exige revisão
// item a item (ver TAREFA 3.9 do prompt de redesign).
const VOGAIS = /[aeiouáéíóúàèìòùâêîôûãõäëïöüAEIOUÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÃÕÄËÏÖÜ]/;

function semVogal(texto) {
  const limpo = String(texto || '').trim();
  return limpo.length > 0 && !VOGAIS.test(limpo);
}

function nomeCurto(texto) {
  const limpo = String(texto || '').trim();
  return limpo.length > 0 && limpo.length < 3;
}

// Desvio-padrão populacional simples, só pra marcar valor fora da curva
// nesta tela de conferência — não é usado em nenhum cálculo de preço,
// margem ou markup do resto do sistema.
function limiarPorDesvio(valores, multiplicador = 3) {
  const n = valores.length;
  if (n < 4) return null; // amostra pequena de mais pra "fora da curva" fazer sentido
  const media = valores.reduce((s, v) => s + v, 0) / n;
  const variancia = valores.reduce((s, v) => s + (v - media) ** 2, 0) / n;
  const desvio = Math.sqrt(variancia);
  return media + multiplicador * desvio;
}

router.get('/', async (req, res, next) => {
  try {
    const clientesSuspeitos = [];
    const fornecedoresSuspeitos = [];
    const viagensSuspeitas = [];
    const pedidosSuspeitos = [];

    const { rows: clientes } = await pool.query('SELECT id, nome, cpf_cnpj, created_at FROM clientes ORDER BY id');
    for (const c of clientes) {
      const motivos = [];
      if (semVogal(c.nome)) motivos.push('nome sem vogais');
      if (nomeCurto(c.nome)) motivos.push('nome com menos de 3 caracteres');
      if (motivos.length) {
        clientesSuspeitos.push({ id: c.id, nome: c.nome, cpfCnpj: c.cpf_cnpj, motivos, criadoEm: c.created_at });
      }
    }

    const { rows: fornecedores } = await pool.query('SELECT id, nome, cpf_cnpj, created_at FROM fornecedores ORDER BY id');
    for (const f of fornecedores) {
      const motivos = [];
      if (semVogal(f.nome)) motivos.push('nome sem vogais');
      if (nomeCurto(f.nome)) motivos.push('nome com menos de 3 caracteres');
      if (motivos.length) {
        fornecedoresSuspeitos.push({ id: f.id, nome: f.nome, cpfCnpj: f.cpf_cnpj, motivos, criadoEm: f.created_at });
      }
    }

    const { rows: viagens } = await pool.query(`
      SELECT v.id, v.nome, v.created_at,
        COALESCE(SUM(pv.total_liquido), 0) AS faturamento
      FROM viagens v
      LEFT JOIN pedidos_venda pv ON pv.origem_viagem_id = v.id AND pv.situacao != 'cancelado'
      GROUP BY v.id, v.nome, v.created_at
      ORDER BY v.id
    `);
    const faturamentosViagem = viagens.map((v) => Number(v.faturamento)).filter((v) => v > 0);
    const limiarViagem = limiarPorDesvio(faturamentosViagem);
    for (const v of viagens) {
      const motivos = [];
      if (semVogal(v.nome)) motivos.push('nome sem vogais');
      if (nomeCurto(v.nome)) motivos.push('nome com menos de 3 caracteres');
      const faturamento = Number(v.faturamento);
      if (limiarViagem != null && faturamento > limiarViagem) motivos.push('valor fora de 3 desvios-padrão');
      if (motivos.length) {
        viagensSuspeitas.push({ id: v.id, nome: v.nome, faturamento, motivos, criadoEm: v.created_at });
      }
    }

    const { rows: pedidos } = await pool.query(`
      SELECT pv.id, pv.numero, pv.quantidade_pecas, pv.total_liquido, pv.created_at, c.nome AS cliente_nome
      FROM pedidos_venda pv
      LEFT JOIN clientes c ON c.id = pv.cliente_id
      WHERE pv.quantidade_pecas > 1000
      ORDER BY pv.id
    `);
    for (const p of pedidos) {
      pedidosSuspeitos.push({
        id: p.id,
        numero: p.numero,
        clienteNome: p.cliente_nome,
        quantidadePecas: Number(p.quantidade_pecas),
        totalLiquido: Number(p.total_liquido),
        motivos: ['quantidade acima de 1.000 peças'],
        criadoEm: p.created_at,
      });
    }

    const total = clientesSuspeitos.length + fornecedoresSuspeitos.length + viagensSuspeitas.length + pedidosSuspeitos.length;

    res.json({
      total,
      clientes: clientesSuspeitos,
      fornecedores: fornecedoresSuspeitos,
      viagens: viagensSuspeitas,
      pedidos: pedidosSuspeitos,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
