// Explicador do Fechamento do Mês (26/10/2026) — um arquivo HTML que vive
// FORA do Hub e responde, sozinho, de onde veio cada número da tela.
//
// Pedido do dono: "um arquivo que não dependa de você", que responda qualquer
// pergunta sobre os números (de qualquer jeito que for feita), reconheça um
// print da tela, simule ("se tiver uma despesa de X, quanto sai no Y?"),
// avise quando um número não é confiável e diga o que os números NÃO mostram.
//
// Como funciona:
//   1. montarPacote(): roda o MESMO cálculo da tela (fechamentoDoMes +
//      lancamentosDoMes) para os 3 últimos meses, nas três unidades. Nada é
//      recalculado de outro jeito — o arquivo explica exatamente o que a tela
//      mostrou no momento do download.
//   2. O pacote vai comprimido (gzip) e CRIPTOGRAFADO (AES-256-GCM, chave
//      derivada por PBKDF2-SHA256 com 250.000 rodadas) dentro do HTML. Sem a
//      senha do arquivo, o HTML só mostra as explicações gerais.
//   3. O HTML (templates/explicador-fechamento.html) decifra no navegador
//      (WebCrypto), e tem o motor de perguntas, o simulador e a leitura de
//      print. Funciona aberto direto do computador, sem internet — só a
//      leitura de PRINT precisa de internet (baixa o leitor de texto na hora).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const f = require('./fechamentoMes');
const { agruparExtrato } = require('./fechamentoExcel');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'explicador-fechamento.html');
const ITERACOES = 250000;
const VERSAO = '2026-10-26';

function somarMeses(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Senha legível do arquivo: 4 blocos de 4, sem letra que confunde (0/O, 1/l/I).
function gerarSenhaArquivo() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i += 1) {
    s += alfabeto[bytes[i] % alfabeto.length];
    if (i % 4 === 3 && i < 15) s += '-';
  }
  return s;
}

// O que cada lançamento leva para o arquivo — o suficiente para responder
// "de onde veio" sem carregar o que não ajuda a explicar.
function enxugarLancamento(l) {
  return {
    t: l.tipo, d: l.data, u: l.unidade, p: l.pessoa || '', ds: l.descricao || '', c: l.conta || null, g: l.grupo || null,
    pl: l.planoNome || null, b: l.contaBancaria || '', v: Math.round(Number(l.valor) * 100) / 100,
    w: l.doWik ? 1 : 0, f: l.fatia ? Math.round(l.fatia * 10) / 10 : undefined, q: l.qtd || undefined, o: l.obs || undefined,
  };
}

async function montarPacote({ mesFinal, quantidadeMeses = 3, geradoPor = null }) {
  const meses = [];
  for (let i = quantidadeMeses - 1; i >= 0; i -= 1) meses.push(somarMeses(mesFinal, -i));
  const cadastro = await f.cadastro();
  const contextos = {};
  const lancamentos = {};
  for (const mes of meses) {
    for (const unidade of ['matriz', 'marketplace', 'consolidado']) {
      const fech = await f.fechamentoDoMes({ unidade, mes, comVendas: true });
      contextos[`${unidade}|${mes}`] = fech;
    }
    // Lançamentos só das duas unidades: o Consolidado é a soma das duas listas.
    for (const unidade of ['matriz', 'marketplace']) {
      const lista = await f.lancamentosDoMes({ unidade, mes });
      lancamentos[`${unidade}|${mes}`] = agruparExtrato(lista).map(enxugarLancamento);
    }
  }
  return {
    versao: VERSAO,
    geradoEm: new Date().toISOString(),
    geradoPor,
    meses,
    contas: cadastro.contas,
    grupos: cadastro.grupos,
    contasBancarias: cadastro.contasBancarias.map((c) => ({ nome: c.nome, unidade: c.unidade })),
    contextos,
    lancamentos,
  };
}

function cifrar(objeto, senha) {
  const sal = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const chave = crypto.pbkdf2Sync(senha, sal, ITERACOES, 32, 'sha256');
  const comprimido = zlib.gzipSync(Buffer.from(JSON.stringify(objeto), 'utf8'), { level: 9 });
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const corpo = Buffer.concat([c.update(comprimido), c.final(), c.getAuthTag()]);
  return { v: 1, it: ITERACOES, sal: sal.toString('base64'), iv: iv.toString('base64'), dados: corpo.toString('base64') };
}

function gerarHtml(pacote, senha) {
  const modelo = fs.readFileSync(TEMPLATE, 'utf8');
  const cofre = cifrar(pacote, senha);
  const resumoPublico = {
    versao: pacote.versao, geradoEm: pacote.geradoEm, meses: pacote.meses,
    geradoPor: pacote.geradoPor ? String(pacote.geradoPor).slice(0, 60) : null,
  };
  return modelo
    .replace('"__COFRE__"', JSON.stringify(cofre))
    .replace('"__PUBLICO__"', JSON.stringify(resumoPublico).replace(/</g, '\\u003c'));
}

async function gerarExplicador({ mesFinal, geradoPor }) {
  const senha = gerarSenhaArquivo();
  const pacote = await montarPacote({ mesFinal, geradoPor });
  const nome = `EXPLICADOR_FECHAMENTO_${mesFinal.replace('-', '_')}.html`;
  return { html: gerarHtml(pacote, senha), senha, nome };
}

module.exports = { gerarExplicador, montarPacote, gerarHtml, cifrar, gerarSenhaArquivo, enxugarLancamento };
