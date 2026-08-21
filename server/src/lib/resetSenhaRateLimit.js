// Limite de pedidos de "esqueci minha senha" por nome de usuário — evita
// que alguém encha a caixa de entrada de outra pessoa disparando o
// e-mail de redefinição repetidamente. Em memória, mesmo raciocínio do
// loginRateLimit.js.

const MAX_PEDIDOS = 3;
const JANELA_MS = 60 * 60 * 1000; // 1 hora

const pedidosPorNome = new Map();

function chave(nome) {
  return String(nome || '').trim().toLowerCase();
}

function excedeuLimite(nome) {
  const k = chave(nome);
  const agora = Date.now();
  const registro = pedidosPorNome.get(k);
  if (!registro || agora - registro.primeiroPedidoEm > JANELA_MS) {
    pedidosPorNome.set(k, { pedidos: 1, primeiroPedidoEm: agora });
    return false;
  }
  registro.pedidos += 1;
  return registro.pedidos > MAX_PEDIDOS;
}

module.exports = { excedeuLimite };
