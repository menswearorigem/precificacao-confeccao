const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL não configurada. Defina a variável de ambiente com a URL do Postgres.');
}

// Render exige SSL para o Postgres gerenciado, mas usa certificado que o
// driver não valida por padrão nessa configuração de rede interna.
const useSsl = process.env.DATABASE_SSL !== 'false';

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
