#!/usr/bin/env node
/*
 * Gera a configuração de um site novo para a API externa (13/10/2026).
 *
 *   node server/scripts/gerar-chave-api.js --nome site-vendas --usuario "API Site Vendas" \
 *        --origem https://site-vendas.onrender.com [--somente-leitura]
 *
 * Imprime:
 *   1. a CHAVE nova (é ela que vai no site);
 *   2. o valor COMPLETO da variável HBN_API_CLIENTES, já juntando com os
 *      sites que existirem (passe o valor atual em --atual '<json>' ou na
 *      própria variável de ambiente HBN_API_CLIENTES).
 *
 * Não grava nada em lugar nenhum — só mostra na tela para copiar.
 */

const { gerarChave, normalizarOrigem } = require('../src/lib/apiExterna');

function argumento(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function todos(nome) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${nome}`) out.push(process.argv[i + 1]); });
  return out;
}

const nome = argumento('nome');
const usuario = argumento('usuario');
if (!nome || !usuario) {
  console.error('Uso: node server/scripts/gerar-chave-api.js --nome site-vendas --usuario "API Site Vendas" [--origem https://...] [--somente-leitura]');
  process.exit(1);
}

const origens = todos('origem').map(normalizarOrigem).filter(Boolean);
const atualBruto = argumento('atual') || process.env.HBN_API_CLIENTES || '[]';
let atual;
try {
  atual = JSON.parse(atualBruto);
  if (!Array.isArray(atual)) atual = [atual];
} catch {
  console.error('O valor atual de HBN_API_CLIENTES não é um JSON válido. Corrija ou passe --atual "[]".');
  process.exit(1);
}
if (atual.some((c) => String(c.nome).toLowerCase() === nome.toLowerCase())) {
  console.error(`Já existe um site chamado "${nome}". Escolha outro nome.`);
  process.exit(1);
}

const chave = gerarChave();
const novo = { nome, usuario, chave, origens };
if (process.argv.includes('--somente-leitura')) novo.somenteLeitura = true;

console.log('\nCHAVE DO SITE (vai no site, em segredo):\n');
console.log(`  ${chave}\n`);
console.log('VALOR COMPLETO DE HBN_API_CLIENTES (cole no Render):\n');
console.log(JSON.stringify([...atual, novo]));
console.log('');
