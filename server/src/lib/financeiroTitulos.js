// Financeiro — títulos, baixa, rateio e retenção.
//
// As regras que este arquivo garante:
//
//   · a soma dos rateios fecha EXATAMENTE com o valor bruto, com a sobra de
//     arredondamento na última linha. Rateio que não fecha faz o DRE nunca
//     bater, e o erro só aparece meses depois;
//   · baixa nunca ultrapassa o saldo do título;
//   · baixa não se apaga: estorna-se com um registro de valores negativos;
//   · a situação do título é recalculada a partir das baixas, nunca digitada.
//
// REGRA 1: nada aqui lê ou escreve preço, margem, markup ou imposto de venda.

// Centavos, para não somar float. Ver armadilha de arredondamento: 1% ÷ 30 ×
// dias em ponto flutuante gera diferença de centavo que o banco não aceita.
const cent = (v) => Math.round(Number(v || 0) * 100);
const real = (c) => Number((c / 100).toFixed(2));

// Distribui um valor entre N linhas por percentual, jogando a sobra na última.
// É a única forma de a soma fechar com o bruto em todos os casos.
function distribuir(valorBruto, percentuais) {
  const totalCent = cent(valorBruto);
  const linhas = [];
  let acumulado = 0;
  percentuais.forEach((p, i) => {
    if (i === percentuais.length - 1) {
      linhas.push(real(totalCent - acumulado));
    } else {
      const parte = Math.round(totalCent * (Number(p) || 0));
      acumulado += parte;
      linhas.push(real(parte));
    }
  });
  return linhas;
}

async function saldoTitulo(client, tituloId) {
  const { rows } = await client.query(
    'SELECT * FROM vw_fin_titulo_saldo WHERE titulo_id = $1', [tituloId]
  );
  return rows[0] || null;
}

// Recalcula a situação a partir das baixas. Só mexe entre aberto/parcial/
// liquidado — 'previsto' e 'cancelado' são decisão humana, e baixa nenhuma
// pode tirar um título de lá sozinha.
async function recalcularSituacao(client, tituloId) {
  const { rows } = await client.query('SELECT situacao FROM fin_titulos WHERE id = $1', [tituloId]);
  if (rows.length === 0) return null;
  if (!['aberto', 'parcial', 'liquidado'].includes(rows[0].situacao)) return rows[0].situacao;

  const s = await saldoTitulo(client, tituloId);
  const baixado = cent(s.valor_baixado);
  const liquido = cent(s.valor_liquido);

  let nova = 'aberto';
  if (baixado > 0 && baixado < liquido) nova = 'parcial';
  else if (baixado >= liquido && liquido > 0) nova = 'liquidado';

  await client.query(
    'UPDATE fin_titulos SET situacao = $1, atualizado_em = now() WHERE id = $2', [nova, tituloId]
  );
  return nova;
}

// Cria um título com suas retenções e rateios, numa transação.
async function criarTitulo(client, dados) {
  const {
    empresa_id, natureza, fornecedor_id, cliente_id, contraparte_nome,
    descricao, documento, parcela, plano_id, centro_custo_id,
    data_emissao, data_competencia, data_vencimento, valor_bruto,
    situacao, origem_tipo, origem_id, observacao,
    retencoes = [], rateios = [], usuarioId,
  } = dados;

  if (!empresa_id) throw Object.assign(new Error('Informe a empresa (CNPJ) do título.'), { status: 400 });
  if (!['pagar', 'receber'].includes(natureza)) {
    throw Object.assign(new Error('Natureza deve ser "pagar" ou "receber".'), { status: 400 });
  }
  if (!data_vencimento) throw Object.assign(new Error('Informe o vencimento.'), { status: 400 });
  if (!(Number(valor_bruto) > 0)) throw Object.assign(new Error('Informe um valor maior que zero.'), { status: 400 });

  const { rows } = await client.query(
    `INSERT INTO fin_titulos
       (empresa_id, natureza, fornecedor_id, cliente_id, contraparte_nome, descricao, documento, parcela,
        plano_id, centro_custo_id, data_emissao, data_competencia, data_vencimento, valor_bruto,
        situacao, origem_tipo, origem_id, observacao, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             COALESCE($11, CURRENT_DATE), COALESCE($12, CURRENT_DATE), $13, $14,
             COALESCE($15,'aberto'), $16, $17, $18, $19)
     RETURNING *`,
    [empresa_id, natureza, fornecedor_id || null, cliente_id || null, contraparte_nome || null,
     descricao || null, documento || null, parcela || null, plano_id || null, centro_custo_id || null,
     data_emissao || null, data_competencia || null, data_vencimento, valor_bruto,
     situacao || null, origem_tipo || null, origem_id || null, observacao || null, usuarioId || null]
  );
  const titulo = rows[0];

  for (const r of retencoes) {
    const valor = r.valor != null
      ? Number(r.valor)
      : real(Math.round(cent(r.base_calculo ?? valor_bruto) * Number(r.aliquota || 0)));
    await client.query(
      `INSERT INTO fin_titulo_retencoes (titulo_id, tributo, aliquota, base_calculo, valor, observacao)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [titulo.id, r.tributo, r.aliquota ?? null, r.base_calculo ?? valor_bruto, valor, r.observacao || null]
    );
  }

  if (rateios.length > 0) {
    const temPercentual = rateios.every((r) => r.percentual != null);
    const valores = temPercentual
      ? distribuir(valor_bruto, rateios.map((r) => Number(r.percentual)))
      : rateios.map((r) => Number(r.valor) || 0);

    const soma = valores.reduce((s, v) => cent(v) + s, 0);
    if (!temPercentual && soma !== cent(valor_bruto)) {
      throw Object.assign(
        new Error(
          `A soma do rateio (${real(soma)}) não fecha com o valor do título (${Number(valor_bruto).toFixed(2)}).`
        ),
        { status: 400 }
      );
    }

    for (const [i, r] of rateios.entries()) {
      await client.query(
        `INSERT INTO fin_titulo_rateios (titulo_id, plano_id, centro_custo_id, percentual, valor)
         VALUES ($1,$2,$3,$4,$5)`,
        [titulo.id, r.plano_id || null, r.centro_custo_id || null, r.percentual ?? null, valores[i]]
      );
    }
  }

  return titulo;
}

// Baixa (pagamento/recebimento).
async function baixar(client, {
  tituloId, conta_id, data_baixa, principal, juros = 0, multa = 0, desconto = 0, tarifa = 0,
  forma_pagamento, observacao, usuarioId,
}) {
  const { rows } = await client.query('SELECT * FROM fin_titulos WHERE id = $1 FOR UPDATE', [tituloId]);
  if (rows.length === 0) throw Object.assign(new Error('Título não encontrado.'), { status: 404 });
  const titulo = rows[0];
  if (titulo.situacao === 'cancelado') {
    throw Object.assign(new Error('Título cancelado não recebe baixa.'), { status: 400 });
  }

  const s = await saldoTitulo(client, tituloId);
  const valorPrincipal = principal == null ? Number(s.saldo_aberto) : Number(principal);
  if (!(valorPrincipal > 0)) {
    throw Object.assign(new Error('Informe um valor de baixa maior que zero.'), { status: 400 });
  }
  if (cent(valorPrincipal) > cent(s.saldo_aberto)) {
    throw Object.assign(
      new Error(
        `A baixa (${valorPrincipal.toFixed(2)}) é maior que o saldo em aberto do título `
        + `(${Number(s.saldo_aberto).toFixed(2)}).`
      ),
      { status: 400 }
    );
  }

  const { rows: baixa } = await client.query(
    `INSERT INTO fin_baixas
       (titulo_id, conta_id, data_baixa, principal, juros, multa, desconto, tarifa,
        forma_pagamento, observacao, usuario_id)
     VALUES ($1,$2,COALESCE($3, CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [tituloId, conta_id || null, data_baixa || null, valorPrincipal,
     Number(juros) || 0, Number(multa) || 0, Number(desconto) || 0, Number(tarifa) || 0,
     forma_pagamento || null, observacao || null, usuarioId || null]
  );

  const situacao = await recalcularSituacao(client, tituloId);
  return { baixa: baixa[0], situacao };
}

// Estorno de baixa: registro novo com os valores negativos.
async function estornarBaixa(client, { baixaId, motivo, usuarioId }) {
  if (!String(motivo || '').trim()) {
    throw Object.assign(new Error('Escreva o motivo do estorno.'), { status: 400 });
  }
  const { rows } = await client.query('SELECT * FROM fin_baixas WHERE id = $1 FOR UPDATE', [baixaId]);
  if (rows.length === 0) throw Object.assign(new Error('Baixa não encontrada.'), { status: 404 });
  const b = rows[0];
  if (b.estornada_em) throw Object.assign(new Error('Esta baixa já foi estornada.'), { status: 400 });
  if (b.estorno_de_id) throw Object.assign(new Error('Estorno não se estorna.'), { status: 400 });

  const { rows: nova } = await client.query(
    `INSERT INTO fin_baixas
       (titulo_id, conta_id, data_baixa, principal, juros, multa, desconto, tarifa,
        forma_pagamento, observacao, estorno_de_id, usuario_id)
     VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [b.titulo_id, b.conta_id, -Number(b.principal), -Number(b.juros), -Number(b.multa),
     -Number(b.desconto), -Number(b.tarifa), b.forma_pagamento,
     `[estorno] ${motivo}`, b.id, usuarioId || null]
  );

  await client.query('UPDATE fin_baixas SET estornada_em = now() WHERE id = $1', [baixaId]);
  // O extrato que estava conciliado com esta baixa volta a ficar pendente.
  await client.query(
    'UPDATE fin_extrato_bancario SET baixa_id = NULL, conciliado_em = NULL WHERE baixa_id = $1', [baixaId]
  );

  const situacao = await recalcularSituacao(client, b.titulo_id);
  return { baixa: nova[0], situacao };
}

// Juros e multa até uma data, pelo padrão do mercado: multa uma vez sobre o
// principal, juros pro rata die. Devolve valores em reais, arredondados uma
// única vez no fim.
function calcularEncargos({ saldo, vencimento, ate, multaPercentual = 0, jurosMesPercentual = 0 }) {
  const d1 = new Date(`${vencimento}T00:00:00`);
  const d2 = new Date(`${ate}T00:00:00`);
  const dias = Math.floor((d2 - d1) / 86400000);
  if (dias <= 0) return { dias: 0, multa: 0, juros: 0, total: Number(saldo) };

  const saldoCent = cent(saldo);
  const multaCent = Math.round(saldoCent * Number(multaPercentual || 0));
  // pro rata die sobre o PRINCIPAL, não sobre principal + multa.
  const jurosCent = Math.round(saldoCent * (Number(jurosMesPercentual || 0) / 30) * dias);
  return {
    dias,
    multa: real(multaCent),
    juros: real(jurosCent),
    total: real(saldoCent + multaCent + jurosCent),
  };
}

module.exports = {
  criarTitulo, baixar, estornarBaixa, recalcularSituacao, saldoTitulo,
  distribuir, calcularEncargos, cent, real,
};
