const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

function hashSenha(senha) {
  return bcrypt.hash(senha, SALT_ROUNDS);
}

function verificarSenha(senha, hash) {
  return bcrypt.compare(senha, hash);
}

module.exports = { hashSenha, verificarSenha };
