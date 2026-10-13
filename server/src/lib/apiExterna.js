// ═══════════════════════════════════════════════════════════════════════════
// API EXTERNA — configuração dos sites que podem usar o Hub (13/10/2026)
// ═══════════════════════════════════════════════════════════════════════════
// Os outros sites internos da empresa leem e GRAVAM no Hub por aqui. Cada site
// é um "cliente" com:
//
//   • nome      — apelido do site (aparece no histórico: "[API · site-vendas]")
//   • chave     — segredo de no mínimo 32 caracteres (ou uma lista, durante a
//                 troca de chave)
//   • usuario   — o NOME de um usuário do Hub (como no login). O site enxerga
//                 e mexe exatamente no que esse usuário enxerga e mexe: as
//                 permissões vêm dos módulos dele, na tela de Acessos. Quer
//                 tirar um módulo do site? Tira do usuário. Quer desligar o
//                 site? Desativa o usuário.
//   • origens   — endereços dos sites que podem chamar direto do navegador
//                 (CORS). Opcional: chamada de servidor para servidor não usa.
//   • somenteLeitura — true trava qualquer gravação, mesmo que o usuário possa.
//
// Tudo isso mora numa variável de ambiente só, HBN_API_CLIENTES, em JSON.
// NENHUMA tabela nova no banco (REGRA 4) — o cadastro de permissão é o de
// usuários que já existe.
//
// Regras de segurança:
//   • usuário ADMINISTRADOR não pode ser vinculado a uma chave. Chave vaza;
//     chave de administrador vazada é o sistema inteiro aberto.
//   • comparação da chave em tempo constante (sobre o hash), como na API de
//     conteúdo.
//   • entrada inválida na configuração é IGNORADA com aviso no log — o servidor
//     sobe mesmo assim, e o site com problema recebe 401.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const TAMANHO_MINIMO_CHAVE = 32;

function hash(v) {
  return crypto.createHash('sha256').update(String(v)).digest();
}

function normalizarOrigem(o) {
  try {
    const u = new URL(String(o).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

let cacheBruto = null;
let cacheResultado = null;

// Lê e valida HBN_API_CLIENTES. Devolve { clientes, avisos }.
// O resultado fica guardado enquanto a variável não mudar.
function carregarClientes() {
  const bruto = process.env.HBN_API_CLIENTES || '';
  if (bruto === cacheBruto && cacheResultado) return cacheResultado;

  const avisos = [];
  const clientes = [];

  if (bruto.trim()) {
    let lista;
    try {
      lista = JSON.parse(bruto);
    } catch (err) {
      avisos.push(`HBN_API_CLIENTES não é um JSON válido (${err.message}). Nenhum site foi liberado.`);
      lista = [];
    }
    if (!Array.isArray(lista)) {
      if (lista && typeof lista === 'object') lista = [lista];
      else lista = [];
    }

    const nomesVistos = new Set();
    const chavesVistas = new Set();

    lista.forEach((item, i) => {
      const onde = `site nº ${i + 1}`;
      if (!item || typeof item !== 'object') {
        avisos.push(`${onde}: não é um objeto — ignorado.`);
        return;
      }
      const nome = String(item.nome || '').trim();
      if (!/^[a-z0-9][a-z0-9-_]{1,49}$/i.test(nome)) {
        avisos.push(`${onde}: "nome" precisa ter de 2 a 50 letras, números, - ou _ — ignorado.`);
        return;
      }
      if (nomesVistos.has(nome.toLowerCase())) {
        avisos.push(`${nome}: nome repetido — o segundo foi ignorado.`);
        return;
      }
      const usuario = String(item.usuario || '').trim();
      if (!usuario) {
        avisos.push(`${nome}: falta "usuario" (o nome de um usuário do Hub) — ignorado.`);
        return;
      }
      const chavesBrutas = (Array.isArray(item.chave) ? item.chave : [item.chave])
        .map((c) => String(c || '').trim())
        .filter(Boolean);
      const chaves = chavesBrutas.filter((c) => c.length >= TAMANHO_MINIMO_CHAVE);
      if (chaves.length < chavesBrutas.length) {
        avisos.push(`${nome}: chave com menos de ${TAMANHO_MINIMO_CHAVE} caracteres foi ignorada.`);
      }
      if (chaves.length === 0) {
        avisos.push(`${nome}: nenhuma chave válida — ignorado.`);
        return;
      }
      const repetida = chaves.find((c) => chavesVistas.has(c));
      if (repetida) {
        avisos.push(`${nome}: usa a mesma chave de outro site — ignorado. Cada site precisa da sua.`);
        return;
      }

      const origensBrutas = Array.isArray(item.origens) ? item.origens : (item.origens ? [item.origens] : []);
      const origens = [];
      origensBrutas.forEach((o) => {
        const n = normalizarOrigem(o);
        if (n) origens.push(n);
        else avisos.push(`${nome}: origem "${o}" não é um endereço válido (ex.: https://meusite.onrender.com) — ignorada.`);
      });

      nomesVistos.add(nome.toLowerCase());
      chaves.forEach((c) => chavesVistas.add(c));
      clientes.push({
        nome,
        usuario,
        origens,
        somenteLeitura: item.somenteLeitura === true,
        hashes: chaves.map(hash),
      });
    });
  }

  if (avisos.length) avisos.forEach((a) => console.warn(`[api-externa] ${a}`));

  cacheBruto = bruto;
  cacheResultado = { clientes, avisos };
  return cacheResultado;
}

// Acha o cliente dono da chave. Percorre TODAS as chaves sempre (sem parar no
// primeiro acerto) para o tempo de resposta não dizer em que posição a chave
// está.
function clientePorChave(chaveRecebida) {
  if (!chaveRecebida) return null;
  const h = hash(chaveRecebida);
  let achado = null;
  for (const c of carregarClientes().clientes) {
    for (const v of c.hashes) {
      if (crypto.timingSafeEqual(v, h) && !achado) achado = c;
    }
  }
  return achado;
}

// Todas as origens liberadas por algum site — usado no "pré-voo" do CORS, que
// o navegador manda SEM a chave.
function origemLiberadaPorAlgum(origem) {
  const n = normalizarOrigem(origem);
  if (!n) return false;
  return carregarClientes().clientes.some((c) => c.origens.includes(n));
}

function gerarChave() {
  // 48 bytes aleatórios → 64 caracteres seguros para URL e cabeçalho.
  return crypto.randomBytes(48).toString('base64url');
}

module.exports = {
  carregarClientes,
  clientePorChave,
  origemLiberadaPorAlgum,
  normalizarOrigem,
  gerarChave,
  TAMANHO_MINIMO_CHAVE,
};
