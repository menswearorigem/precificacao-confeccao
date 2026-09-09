// Leitor de OFX — o extrato bancário que o banco exporta.
//
// OFX vem em dois sabores: 1.x é SGML (tags sem fechamento) e 2.x é XML de
// verdade. Este leitor trata os dois com o mesmo código, porque a diferença
// que importa (fechar ou não a tag) não muda o que precisamos ler.
//
// ---------------------------------------------------------------------------
// As armadilhas, todas encontradas em arquivo real de banco brasileiro
// ---------------------------------------------------------------------------
//
// 1. FITID NÃO É CHAVE CONFIÁVEL. Alguns bancos reciclam o valor entre meses;
//    outros mudam o FITID do mesmo lançamento entre duas exportações. Por isso
//    a deduplicação usa (conta, fitid) quando há fitid, e um hash de
//    (data, valor, memo) quando não há — e nunca confia só no fitid.
//
// 2. DTPOSTED VEM COM FUSO ENTRE COLCHETES: `20260115120000[-3:BRT]`. Quem
//    parseia como UTC empurra lançamento de madrugada para o dia anterior — e
//    o extrato deixa de bater com o do banco por um dia inteiro.
//
// 3. TRNAMT JÁ VEM ASSINADO. Débito é negativo. Não inverta pelo TRNTYPE:
//    alguns bancos mandam TRNTYPE=DEBIT com valor já negativo, e a inversão
//    dupla transforma saída em entrada.
//
// 4. VÍRGULA DECIMAL. O padrão manda ponto, mas há banco brasileiro exportando
//    `-1.234,56`. O parser aceita os dois.
//
// 5. ACENTO EM LATIN-1. OFX 1.x costuma vir em ISO-8859-1; ler como UTF-8
//    produz "TARIFA DE MANUTEN��O". O chamador deve passar o texto já
//    decodificado; `detectarCharset` ajuda a escolher.

const crypto = require('crypto');

// Lê o cabeçalho do OFX 1.x para descobrir o charset. Devolve o nome que o
// Node entende, ou 'utf8' quando não dá para saber.
function detectarCharset(buffer) {
  const inicio = buffer.slice(0, 512).toString('latin1');
  if (/CHARSET:\s*1252/i.test(inicio) || /ENCODING:\s*USASCII/i.test(inicio)) return 'latin1';
  if (/CHARSET:\s*UTF-8/i.test(inicio) || /encoding="UTF-8"/i.test(inicio)) return 'utf8';
  if (/ISO-8859-1/i.test(inicio)) return 'latin1';
  return 'utf8';
}

function tag(bloco, nome) {
  // Aceita <TAG>valor</TAG> (XML) e <TAG>valor (SGML, sem fechamento).
  const re = new RegExp(`<${nome}>\\s*([^<\\r\\n]*)`, 'i');
  const m = bloco.match(re);
  return m ? m[1].trim() : null;
}

// `20260115` | `20260115120000` | `20260115120000[-3:BRT]` | `20260115120000.000[-03:EST]`
function parseData(valor) {
  if (!valor) return null;
  const m = String(valor).match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, ano, mes, dia] = m;

  // A hora só importa para decidir o DIA quando há fuso declarado. Como o
  // extrato é sempre lido em data local do banco, a data que vale é a que o
  // próprio arquivo escreveu — não se converte fuso nenhum (armadilha 2).
  return `${ano}-${mes}-${dia}`;
}

function parseValor(valor) {
  if (valor == null || valor === '') return null;
  let t = String(valor).trim();
  // "-1.234,56" -> "-1234.56" ; "1234.56" fica como está (armadilha 4)
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function hashDedup({ data, valor, memo, fitid }) {
  const base = fitid
    ? `fitid:${fitid}`
    : `mov:${data}|${Number(valor).toFixed(2)}|${String(memo || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 64);
}

// Lê um OFX inteiro e devolve { conta, periodo, lancamentos, avisos }.
//
// `lancamentos` sai com valor ASSINADO e data em AAAA-MM-DD, pronto para
// gravar. Linha que não deu para interpretar NÃO vira zero: entra em `avisos`
// e fica de fora, para o financeiro ver que existe dinheiro não lido em vez de
// achar que o extrato fechou (REGRA 2).
function lerOfx(texto) {
  const avisos = [];
  const conteudo = String(texto || '');

  const banco = tag(conteudo, 'BANKID');
  const agencia = tag(conteudo, 'BRANCHID');
  const conta = tag(conteudo, 'ACCTID');
  const periodoDe = parseData(tag(conteudo, 'DTSTART'));
  const periodoAte = parseData(tag(conteudo, 'DTEND'));
  const saldoFinal = parseValor(tag(conteudo, 'BALAMT'));

  const blocos = conteudo.split(/<STMTTRN>/i).slice(1);
  if (blocos.length === 0) avisos.push('O arquivo não tem nenhum lançamento (<STMTTRN>).');

  const lancamentos = [];
  for (const [i, bruto] of blocos.entries()) {
    const bloco = bruto.split(/<\/STMTTRN>/i)[0];
    const data = parseData(tag(bloco, 'DTPOSTED'));
    const valor = parseValor(tag(bloco, 'TRNAMT'));
    const fitid = tag(bloco, 'FITID');
    const memo = tag(bloco, 'MEMO') || tag(bloco, 'NAME');
    const tipo = tag(bloco, 'TRNTYPE');
    const documento = tag(bloco, 'CHECKNUM') || tag(bloco, 'REFNUM');

    if (!data || valor == null) {
      avisos.push(
        `Lançamento ${i + 1} ficou de fora: ${!data ? 'data ilegível' : 'valor ilegível'}`
        + `${memo ? ` ("${memo}")` : ''}.`
      );
      continue;
    }

    lancamentos.push({
      data_lancamento: data,
      valor,                                   // já assinado (armadilha 3)
      historico: memo || null,
      documento: documento || null,
      fitid: fitid || null,
      tipo_ofx: tipo || null,
      hash_dedup: hashDedup({ data, valor, memo, fitid }),
    });
  }

  // Dois lançamentos idênticos no mesmo dia, sem FITID, geram o mesmo hash e
  // um sumiria na gravação. Desempata com um sufixo — e avisa, porque isso
  // também pode ser duplicidade de verdade no arquivo.
  const vistos = new Map();
  for (const l of lancamentos) {
    const n = (vistos.get(l.hash_dedup) || 0) + 1;
    vistos.set(l.hash_dedup, n);
    if (n > 1) {
      if (!l.fitid) {
        l.hash_dedup = hashDedup({
          data: l.data_lancamento, valor: l.valor, memo: `${l.historico}#${n}`, fitid: null,
        });
      }
      avisos.push(
        `Há ${n} lançamentos iguais em ${l.data_lancamento} (${l.valor}) — foram mantidos todos. `
        + `Confira se não é duplicidade do arquivo.`
      );
    }
  }

  return {
    conta: { banco, agencia, conta },
    periodo: { de: periodoDe, ate: periodoAte, saldo_final: saldoFinal },
    lancamentos,
    avisos,
  };
}

module.exports = { lerOfx, detectarCharset, parseData, parseValor, hashDedup };
