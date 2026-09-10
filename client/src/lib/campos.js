// ============================================================================
// Regras de campo do sistema inteiro — 10/09/2026
// ============================================================================
// Antes desta data cada tela escrevia o seu próprio <input> cru: o CNPJ de
// Cliente aceitava letra, o de Facção não; a UF era cortada em 2 em três
// implementações diferentes; o CEP só era conferido na hora de chamar o
// ViaCEP. O resultado era um cadastro que aceitava qualquer coisa e só
// quebrava na emissão da nota.
//
// Este arquivo é a ÚNICA fonte das regras. Os componentes de campo
// (components/campos.jsx) consomem daqui, e as telas consomem os componentes —
// nenhuma tela repete regra.
//
// As regras, como foram pedidas pela dona:
//   Nome ............ 50 caracteres, só letras
//   Nome fantasia ... 50 caracteres
//   CNPJ ............ 18 caracteres já formatados (00.000.000/0000-00),
//                     só números; inválido ENTRA, mas com aviso
//   CPF ............. 14 caracteres já formatados (000.000.000-00),
//                     só números; inválido ENTRA, mas com aviso
//   Telefone ........ 20 caracteres, sem letra
//   E-mail .......... 50 caracteres, obrigatoriamente com "@";
//                     inválido LIMPA o campo pra escrever de novo
//   CEP ............. 9 caracteres (00000-000), sem letra
//   Cidade .......... 35 caracteres, só letras
//   UF .............. só as 27 siglas, 2 caracteres
//   Desconto ........ 0 a 100
//
// "Inválido entra com aviso" (documento) x "inválido limpa" (e-mail) é
// proposital: um CNPJ com dígito verificador errado às vezes é o que está na
// nota do fornecedor e precisa ser cadastrado assim mesmo; um e-mail sem @
// nunca serve pra nada.

// ---------------------------------------------------------------------------
// Limites
// ---------------------------------------------------------------------------
export const LIMITES = {
  nome: 50,
  nomeFantasia: 50,
  cnpj: 18, // com máscara: 00.000.000/0000-00
  cpf: 14, // com máscara: 000.000.000-00
  telefone: 20,
  email: 50,
  cep: 9, // com máscara: 00000-000
  cidade: 35,
  uf: 2,
};

// As 27 unidades federativas, na ordem em que foram pedidas (por região).
export const UFS = [
  'DF', 'GO', 'MT', 'MS',
  'AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE',
  'AC', 'AP', 'AM', 'PA', 'RO', 'RR', 'TO',
  'ES', 'MG', 'RJ', 'SP',
  'PR', 'RS', 'SC',
];

export const UF_VALIDA = (valor) => UFS.includes(String(valor || '').toUpperCase());

// ---------------------------------------------------------------------------
// Saneamento de digitação
// ---------------------------------------------------------------------------
export const soDigitos = (valor) => String(valor ?? '').replace(/\D/g, '');

// Letras (com acento), espaço, hífen e apóstrofo — o que existe em nome de
// gente e de cidade brasileira ("Santa Bárbara d'Oeste", "Mogi-Guaçu").
// Número e símbolo não passam. O espaço duplo é colapsado só no blur, nunca
// durante a digitação (senão não dá pra digitar "Ana " e continuar).
const NAO_E_LETRA = /[^A-Za-zÀ-ÖØ-öø-ÿÀ-ɏ\s'-]/g;

export function soLetras(valor, limite) {
  const limpo = String(valor ?? '').replace(NAO_E_LETRA, '');
  return limite ? limpo.slice(0, limite) : limpo;
}

// Telefone: dígitos e os sinais que um telefone de verdade carrega
// (+55, parênteses de DDD, hífen, espaço, ramal com "/"). Letra nenhuma.
const NAO_E_TELEFONE = /[^0-9+()\-\s/]/g;

export function soTelefone(valor, limite = LIMITES.telefone) {
  return String(valor ?? '').replace(NAO_E_TELEFONE, '').slice(0, limite);
}

// ---------------------------------------------------------------------------
// Máscaras — formatam ENQUANTO se digita, sempre a partir dos dígitos
// ---------------------------------------------------------------------------
export function mascaraCnpj(valor) {
  const d = soDigitos(valor).slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function mascaraCpf(valor) {
  const d = soDigitos(valor).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// Campo que aceita os dois (cpf_cnpj de Cliente e Fornecedor): até 11 dígitos
// é CPF, daí em diante é CNPJ. A troca acontece sozinha enquanto se digita.
export function mascaraCpfCnpj(valor) {
  const d = soDigitos(valor);
  return d.length > 11 ? mascaraCnpj(d) : mascaraCpf(d);
}

export function mascaraCep(valor) {
  const d = soDigitos(valor).slice(0, 8);
  return d.length <= 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`;
}

// Telefone brasileiro: (00) 00000-0000 para celular, (00) 0000-0000 para fixo.
// Acima de 11 dígitos (internacional, ramal) o texto passa cru mas limpo de
// letras, respeitando o teto de 20 caracteres.
export function mascaraTelefone(valor) {
  const bruto = String(valor ?? '');
  const d = soDigitos(bruto);
  if (bruto.trim().startsWith('+') || d.length > 11) return soTelefone(bruto);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

// ---------------------------------------------------------------------------
// Dígito verificador — mesmo cálculo do servidor (server/src/lib/mixTributario.js).
// Duplicado de propósito: o servidor precisa dele para não confiar no cliente,
// e o cliente precisa dele para avisar antes de salvar.
// ---------------------------------------------------------------------------
const digitosTodosIguais = (d) => d.length > 0 && /^(\d)\1+$/.test(d);

export function cpfValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 11 || digitosTodosIguais(d)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i += 1) soma += Number(d[i]) * (10 - i);
  let dv = (soma * 10) % 11;
  if (dv === 10) dv = 0;
  if (dv !== Number(d[9])) return false;
  soma = 0;
  for (let i = 0; i < 10; i += 1) soma += Number(d[i]) * (11 - i);
  dv = (soma * 10) % 11;
  if (dv === 10) dv = 0;
  return dv === Number(d[10]);
}

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function dvCnpj(digitos, pesos) {
  const soma = pesos.reduce((acc, peso, idx) => acc + Number(digitos[idx]) * peso, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cnpjValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 14 || digitosTodosIguais(d)) return false;
  return dvCnpj(d, PESOS_CNPJ_1) === Number(d[12]) && dvCnpj(d, PESOS_CNPJ_2) === Number(d[13]);
}

export function cpfCnpjValido(valor) {
  const d = soDigitos(valor);
  if (d.length === 11) return cpfValido(d);
  if (d.length === 14) return cnpjValido(d);
  return false;
}

// ---------------------------------------------------------------------------
// E-mail e CEP
// ---------------------------------------------------------------------------
// A regra pedida é "obrigatoriamente ter @". Somamos o mínimo que impede o
// erro de digitação clássico (arroba solta, sem domínio, com espaço) sem
// entrar no pântano de tentar validar e-mail por expressão regular completa.
export function emailValido(valor) {
  const v = String(valor ?? '').trim();
  if (!v) return false;
  if (v.length > LIMITES.email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

export const cepValido = (valor) => soDigitos(valor).length === 8;

// ---------------------------------------------------------------------------
// Desconto — 0 a 100
// ---------------------------------------------------------------------------
export const DESCONTO_MIN = 0;
export const DESCONTO_MAX = 100;

// Prende no intervalo sem inventar valor: string vazia continua vazia (o campo
// pode estar em branco de propósito), e o que não é número vira vazio.
export function limitarDesconto(valor) {
  if (valor === '' || valor === null || valor === undefined) return '';
  const n = Number(valor);
  if (!Number.isFinite(n)) return '';
  return Math.min(DESCONTO_MAX, Math.max(DESCONTO_MIN, n));
}

// ---------------------------------------------------------------------------
// Saneamento no blur — o que só faz sentido quando a pessoa termina de digitar
// ---------------------------------------------------------------------------
export const colapsarEspacos = (valor) => String(valor ?? '').replace(/\s+/g, ' ').trim();
