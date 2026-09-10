// Teste das REGRAS DE CAMPO de cadastro — 10/09/2026.
//
// A padronização de campo (nome, CNPJ, CPF, telefone, e-mail, CEP, cidade, UF
// e desconto) vale em todos os módulos porque mora num arquivo só:
// `client/src/lib/campos.js`. Este teste vigia esse arquivo.
//
// Ele é o único teste da bateria que testa código do CLIENTE, e está aqui de
// propósito: é onde a bateria roda. Não precisa de banco.
//
//   node server/scripts/teste-campos-cadastro.js

const path = require('path');

let falhas = 0; let ok = 0;
function checa(nome, real, esperado) {
  const bate = JSON.stringify(real) === JSON.stringify(esperado);
  if (bate) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome} -> esperava ${JSON.stringify(esperado)}, veio ${JSON.stringify(real)}`); }
}

async function main() {
  const arquivo = path.resolve(__dirname, '..', '..', 'client', 'src', 'lib', 'campos.js');
  const C = await import(`file://${arquivo}`);

  console.log('\n== MÁSCARAS (o campo já vem formatado) ==');
  checa('CNPJ ganha ponto, barra e traço', C.mascaraCnpj('11222333000181'), '11.222.333/0001-81');
  checa('CNPJ recusa letra no meio', C.mascaraCnpj('11a222b333000181'), '11.222.333/0001-81');
  checa('CNPJ para nos 14 números', C.mascaraCnpj('112223330001819999'), '11.222.333/0001-81');
  checa('CNPJ colado já formatado não duplica pontuação', C.mascaraCnpj('11.222.333/0001-81'), '11.222.333/0001-81');
  checa('CNPJ cabe nos 18 caracteres', C.mascaraCnpj('11222333000181').length <= C.LIMITES.cnpj, true);
  checa('CPF ganha ponto e traço', C.mascaraCpf('52998224725'), '529.982.247-25');
  checa('CPF recusa letra', C.mascaraCpf('529x982y247z25'), '529.982.247-25');
  checa('CPF cabe nos 14 caracteres', C.mascaraCpf('52998224725').length <= C.LIMITES.cpf, true);
  checa('campo CPF/CNPJ vira CNPJ ao passar de 11 números', C.mascaraCpfCnpj('112223330001'), '11.222.333/0001');
  checa('CEP ganha traço', C.mascaraCep('01310100'), '01310-100');
  checa('CEP recusa letra', C.mascaraCep('01a310b100'), '01310-100');
  checa('CEP cabe nos 9 caracteres', C.mascaraCep('01310100').length <= C.LIMITES.cep, true);
  checa('celular vira (00) 00000-0000', C.mascaraTelefone('11987654321'), '(11) 98765-4321');
  checa('fixo vira (00) 0000-0000', C.mascaraTelefone('1133334444'), '(11) 3333-4444');
  checa('telefone recusa letra', C.mascaraTelefone('11 9876 abc'), '(11) 9876');
  checa('telefone cabe nos 20 caracteres', C.soTelefone('1'.repeat(40)).length, 20);
  checa('telefone internacional passa inteiro', C.mascaraTelefone('+55 11 98765-4321'), '+55 11 98765-4321');

  console.log('\n== DÍGITO VERIFICADOR (inválido entra, mas avisado) ==');
  checa('CNPJ bom passa', C.cnpjValido('11222333000181'), true);
  checa('CNPJ com DV errado é acusado', C.cnpjValido('11222333000182'), false);
  checa('CNPJ de número repetido é acusado', C.cnpjValido('11111111111111'), false);
  checa('CNPJ real (Petrobras) passa', C.cnpjValido('33.000.167/0001-01'), true);
  checa('CPF bom passa', C.cpfValido('529.982.247-25'), true);
  checa('CPF com DV errado é acusado', C.cpfValido('529.982.247-26'), false);
  checa('CPF de número repetido é acusado', C.cpfValido('111.111.111-11'), false);

  console.log('\n== E-MAIL (sem @ não vale) ==');
  checa('e-mail completo passa', C.emailValido('ademir@grupohbn.com.br'), true);
  checa('sem @ não passa', C.emailValido('ademir.grupohbn.com.br'), false);
  checa('sem domínio não passa', C.emailValido('ademir@'), false);
  checa('com espaço não passa', C.emailValido('ade mir@x.com'), false);
  checa('acima de 50 caracteres não passa', C.emailValido(`${'a'.repeat(45)}@dominio.com.br`), false);

  console.log('\n== NOME, CIDADE, UF E DESCONTO ==');
  checa('nome tira número', C.soLetras('Ana2 Maria3', 50), 'Ana Maria');
  checa('nome aceita acento, hífen e apóstrofo', C.soLetras("Mogi-Guaçu d'Oeste", 50), "Mogi-Guaçu d'Oeste");
  checa('nome para em 50 caracteres', C.soLetras('a'.repeat(80), C.LIMITES.nome).length, 50);
  checa('cidade para em 35 caracteres', C.soLetras('a'.repeat(80), C.LIMITES.cidade).length, 35);
  checa('são 27 UFs', C.UFS.length, 27);
  checa('nenhuma UF repetida', new Set(C.UFS).size, 27);
  checa('toda UF tem 2 letras', C.UFS.every((u) => u.length === 2), true);
  checa('sigla inventada não está na lista', C.UF_VALIDA('XX'), false);
  checa('sigla minúscula é aceita como válida', C.UF_VALIDA('sp'), true);
  checa('desconto 150 vira 100', C.limitarDesconto(150), 100);
  checa('desconto -5 vira 0', C.limitarDesconto(-5), 0);
  checa('desconto 37,5 passa inteiro', C.limitarDesconto(37.5), 37.5);
  checa('desconto em branco continua em branco', C.limitarDesconto(''), '');
  checa('desconto com letra vira vazio', C.limitarDesconto('abc'), '');

  console.log(`\n${ok} ok, ${falhas} falharam.`);
}

main()
  .catch((e) => { console.error('ERRO NO TESTE:', e); falhas += 1; })
  .finally(() => process.exit(falhas ? 1 : 0));
