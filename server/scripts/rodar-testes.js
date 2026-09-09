#!/usr/bin/env node
/*
 * Roda TODAS as suítes de teste do repositório, cada uma num banco próprio.
 * 09/09/2026.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *   DATABASE_SSL=false node server/scripts/rodar-testes.js
 *
 * POR QUE ESTE SCRIPT EXISTE
 *
 * Cada `teste-*.js` foi escrito para rodar "contra um Postgres LIMPO", e cada
 * um semeia as suas próprias referências, lojas e pedidos. Rodando todos em
 * sequência contra o MESMO banco, o segundo tropeça nos dados que o primeiro
 * deixou: o resultado é uma pilha de erros de chave única e, pior, algumas
 * asserções que passam a comparar número de teste com dado de outro teste e
 * falham dizendo coisas que não são verdade ("veio 6141,53" onde o teste
 * esperava R$ 30,00).
 *
 * Quem rodasse a bateria inteira via `for f in teste-*.js` concluiria que o
 * sistema está quebrado quando não está — e, no sentido inverso e mais
 * perigoso, poderia acostumar-se a ignorar essas falhas e deixar passar uma
 * de verdade.
 *
 * O que este script faz: cria um banco vazio por suíte, aplica as migrations
 * nele, roda a suíte e apaga o banco no fim. Nenhuma suíte foi alterada.
 *
 * Se o usuário do Postgres não puder criar bancos, o script diz isso em vez
 * de rodar tudo junto e produzir um resultado que não significa nada.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PASTA = __dirname;
const RAIZ = path.resolve(__dirname, '..', '..');

function urlComBanco(urlBase, nomeBanco) {
  const u = new URL(urlBase);
  u.pathname = `/${nomeBanco}`;
  return u.toString();
}

async function main() {
  const base = process.env.DATABASE_URL;
  if (!base) {
    console.error('Defina DATABASE_URL. Ex.: DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres DATABASE_SSL=false node server/scripts/rodar-testes.js');
    process.exit(1);
  }

  const suites = fs.readdirSync(PASTA)
    .filter((f) => f.startsWith('teste-') && f.endsWith('.js'))
    .sort();

  // Conexão administrativa: aponta para `postgres`, que sempre existe, para
  // poder criar e apagar os bancos das suítes.
  const admin = new Client({ connectionString: urlComBanco(base, 'postgres'), ssl: false });
  try {
    await admin.connect();
  } catch (err) {
    console.error(`Não deu para conectar ao Postgres: ${err.message}`);
    process.exit(1);
  }

  const resultados = [];
  const marca = Date.now().toString(36);

  for (const [indice, arquivo] of suites.entries()) {
    const nomeBanco = `hbn_teste_${marca}_${indice}`;
    process.stdout.write(`\n──────── ${arquivo} ────────\n`);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${nomeBanco}`);
      await admin.query(`CREATE DATABASE ${nomeBanco}`);
    } catch (err) {
      console.error(`\nNão deu para criar o banco da suíte: ${err.message}`);
      console.error('Este script precisa de um usuário do Postgres que possa criar bancos.');
      console.error('Sem isso, rodar as suítes em sequência no mesmo banco produz falhas falsas — não vale a pena.');
      await admin.end();
      process.exit(1);
    }

    const ambiente = {
      ...process.env,
      DATABASE_URL: urlComBanco(base, nomeBanco),
      DATABASE_SSL: 'false',
      SESSION_SECRET: process.env.SESSION_SECRET || 'a'.repeat(64),
      APP_PASSWORD: process.env.APP_PASSWORD || 'liberacao-de-teste-123',
      NODE_ENV: 'development',
    };

    try {
      execFileSync(process.execPath, [path.join(RAIZ, 'server', 'src', 'db', 'migrate.js')], {
        env: ambiente, stdio: 'ignore', cwd: RAIZ,
      });
    } catch (err) {
      resultados.push({ arquivo, situacao: 'migration falhou' });
      await admin.query(`DROP DATABASE IF EXISTS ${nomeBanco}`);
      continue;
    }

    const r = spawnSync(process.execPath, [path.join(PASTA, arquivo)], {
      env: ambiente, stdio: 'inherit', cwd: RAIZ, timeout: 10 * 60 * 1000,
    });
    resultados.push({ arquivo, situacao: r.status === 0 ? 'ok' : `saiu com código ${r.status}` });

    await admin.query(`DROP DATABASE IF EXISTS ${nomeBanco}`);
  }

  await admin.end();

  console.log('\n========================================');
  const falharam = resultados.filter((x) => x.situacao !== 'ok');
  for (const r of resultados) console.log(`  ${r.situacao === 'ok' ? '✓' : '✗'} ${r.arquivo}${r.situacao === 'ok' ? '' : ` — ${r.situacao}`}`);
  console.log(`\n${resultados.length - falharam.length} de ${resultados.length} suítes passaram.`);
  process.exit(falharam.length === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
