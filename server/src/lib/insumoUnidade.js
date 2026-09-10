// Classificação de TIPO e UNIDADE de insumo a partir da descrição.
//
// Por que isto existe como código, e não como uma coluna preenchida à mão:
// a lista de matéria-prima que veio do Wik (503 itens, 10/09/2026) traz
// REFERENCIA, DESCRIÇÃO e PREÇO — e NÃO traz unidade. Sem unidade, o preço
// não quer dizer nada: R$ 45,00 pode ser o metro de um tecido plano ou o
// quilo de uma malha, e o custo da peça muda por um fator de 3 conforme a
// escolha.
//
// A REGRA 2 do projeto proíbe preencher dado inexistente com valor padrão.
// A saída daqui, então, NUNCA é só "kg" ou "m": é sempre
//   { unidade, tipo, confianca, regra }
// onde `confianca` é 'alta' | 'media' | 'baixa' e `regra` é a frase que
// explica a decisão, para a tela poder escrever na cara de quem confere
// POR QUE aquele insumo ficou em quilo. Tudo que não for 'alta' entra na
// fila de conferência de unidade e é tratado como palpite até alguém
// confirmar.
//
// Ordem importa: a primeira regra que casar vence. As regras estão da mais
// específica (o texto diz a unidade) para a mais genérica (palpite por
// família de produto).

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9%/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cada regra: { teste, unidade, tipo, confianca, regra }
// `teste` recebe a descrição JÁ normalizada (sem acento, maiúscula).
const REGRAS = [
  // -------------------------------------------------------------------
  // 1. O texto diz a unidade. Confiança alta — não é palpite, está escrito.
  // -------------------------------------------------------------------
  {
    teste: (d) => /\bPOR QUILO\b|\bPOR KG\b|\bQUILO\b/.test(d),
    unidade: 'kg', tipo: 'aviamento', confianca: 'alta',
    regra: 'a própria descrição diz "por quilo"',
  },
  {
    teste: (d) => /\bMILHEIRO\b|\bMIL UN\b/.test(d),
    unidade: 'milheiro', tipo: 'aviamento', confianca: 'alta',
    regra: 'a própria descrição diz "milheiro"',
  },

  // -------------------------------------------------------------------
  // 2. Etiquetaria, tags e adesivos — sempre por peça.
  //    Vem ANTES da malharia de propósito: "ETIQUETA DE TAMANHO OG PIQUET" é
  //    uma etiqueta contada por peça, não malha vendida por quilo, e a
  //    palavra PIQUET no meio do nome não muda isso. O relatório de saldo do
  //    Wik de 10/09/2026 flagrou exatamente esse erro em três itens.
  // -------------------------------------------------------------------
  {
    teste: (d) => /^(ETIQUETA|ETQUETA|ETQ|ETIQUETAS|ET \d|ETIQ)\b/.test(d),
    unidade: 'un', tipo: 'etiqueta', confianca: 'alta',
    regra: 'etiqueta — contada por peça',
  },
  {
    teste: (d) => /\b(TAG|LACRE|ADESIVO|CODIGO DE BARRA|CODICO DE BARRA|TERMO COLANTE)\b/.test(d),
    unidade: 'un', tipo: 'etiqueta', confianca: 'alta',
    regra: 'tag/lacre/adesivo — contado por peça',
  },
  {
    teste: (d) => /\bRIBBON\b/.test(d),
    unidade: 'rolo', tipo: 'etiqueta', confianca: 'alta',
    regra: 'ribbon de impressão — comprado em rolo',
  },

  // -------------------------------------------------------------------
  // 3. Aviamento contado por peça.
  // -------------------------------------------------------------------
  {
    teste: (d) => /^(BOTAO|BOTOES|BOTO)/.test(d) || /\bBOTAO\b|\bBOTOES\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'alta',
    regra: 'botão — contado por peça',
  },
  {
    teste: (d) => /\b(ZIPER|ZIPPER)\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'alta',
    regra: 'zíper — contado por peça',
  },
  {
    teste: (d) => /^(PLACA|PLAQUINHA|PLAC)\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'alta',
    regra: 'placa/plaquinha de metal — contada por peça',
  },
  {
    teste: (d) => /\b(RIBITE|REBITE|ILHOS|ILHOSES|FIVELA|ARGOLA|PONTEIRA|FECHO|COLCHETE|PASSADOR|PASSANTE|CANTINHO|JACAREZINHO|CHUPETINHA|BARBATANA|BOJO|BRASAO|STRAS|FIXADOR|MOSQUETAO|PRESILHA)\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'alta',
    regra: 'aviamento metálico/plástico contado por peça',
  },
  {
    // Gola e punho JÁ PRONTOS (cortados) são peça; gola/punho em rolo caiu
    // na regra de retilínea lá em cima.
    teste: (d) => /\b(GOLA|PUNHO|COLARINHO)\b/.test(d) && /\b(PRONTA|PRONTO|PRONTAS|PRONTOS|KIT)\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'alta',
    regra: 'gola/punho pronto — entra na peça já cortado, contado por peça',
  },
  {
    teste: (d) => /^KIT\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'media',
    regra: 'kit — contado por conjunto',
  },
  {
    teste: (d) => /^EMBALAGEM\b|\bSACO\b|\bSACOLA\b/.test(d),
    unidade: 'un', tipo: 'embalagem', confianca: 'alta',
    regra: 'embalagem — contada por peça',
  },

  // -------------------------------------------------------------------
  // 4. Malharia — malha circular e retilínea são vendidas e estocadas em
  //    QUILO na confecção brasileira. É a regra que mais muda custo, e é
  //    também a mais estável: quem compra malha compra por peso.
  // -------------------------------------------------------------------
  {
    // "MALHAS WILSON LTDA" é nome de fornecedor e não pode disparar aqui;
    // por isso `MALHA` precisa vir isolado ou seguido de qualificador.
    teste: (d) => /\bMALHA\b/.test(d) && !/\bMALHAS \w+ LTDA\b/.test(d),
    unidade: 'kg', tipo: 'tecido', confianca: 'alta',
    regra: 'malha — malharia é comprada e estocada em quilo',
  },
  {
    teste: (d) => /\b(SUPLEX|SUPPLEX|CANELADO|CANELADA|SUEDINE|MOLETOM|MOLETON|RIBANA|RIBAN|TRICOT|DRY ?FIT|PIQUET?|PIQUE)\b/.test(d),
    unidade: 'kg', tipo: 'tecido', confianca: 'alta',
    regra: 'família de malharia (suplex, canelado, ribana, piquet, suedine, moletom, tricot)',
  },
  {
    // Gola/punho retilínea sai do tear em peso, não em metro nem em peça.
    teste: (d) => /\bRETILINEA\b/.test(d),
    unidade: 'kg', tipo: 'aviamento', confianca: 'media',
    regra: 'retilínea — sai do tear em peso; confira se a sua vem em quilo ou em peça',
  },
  {
    // "RIB FIO 30", "FIO 30 100%ALGODAO": fio e malha de fio contado, em quilo.
    teste: (d) => /\bFIO \d+\b/.test(d) && !/\bETIQUETA|ETQ|TAG\b/.test(d),
    unidade: 'kg', tipo: 'tecido', confianca: 'media',
    regra: 'malha de fio contado (fio 30/40) — costuma ser comprada em quilo',
  },

  // -------------------------------------------------------------------
  // 5. Aviamento vendido em metro (rolo, mas consumido em metro).
  // -------------------------------------------------------------------
  {
    teste: (d) => /^(CADARCO|CARDACO|CORDAO|VIES|VIVO|ELASTICO|FITA|RENDA|DEBRUM|RABO DE RATO|GALAO)\b/.test(d)
      || /\b(CADARCO|CARDACO|ELASTICO|RABO DE RATO)\b/.test(d),
    unidade: 'm', tipo: 'aviamento', confianca: 'alta',
    regra: 'cadarço/elástico/fita/viés — vendido e consumido em metro',
  },
  {
    // Entretela de GOLA e de PUNHO: resolvido por dado, não por leitura.
    // O relatório "Saldo de estoque de Matéria-Prima" do Wik (10/09/2026)
    // traz 14 entretelas de gola/punho em estoque, e as 14 estão em UN —
    // nesta casa elas entram já cortadas, por peça. Não é mais palpite.
    teste: (d) => /\bENTRETELA\b/.test(d) && /\b(GOLA|PUNHO|COLARINHO)\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'alta',
    regra: 'entretela de gola/punho — as 14 que o Wik tem em estoque estão todas em UN, cortadas por peça',
  },
  {
    // As demais entretelas (pala, calça, braguilha) não aparecem no relatório
    // de saldo, então continuam sem prova: a de rolo vem em metro, a cortada
    // vem em peça, e o preço sozinho não decide. Vai para a conferência.
    teste: (d) => /\bENTRETELA\b/.test(d),
    unidade: 'un', tipo: 'aviamento', confianca: 'media',
    regra: 'entretela que não é de gola/punho — pode vir em rolo (metro) ou já cortada (peça): CONFIRA',
  },

  // -------------------------------------------------------------------
  // 6. Tecido plano — metro.
  // -------------------------------------------------------------------
  {
    // A família nomeada vem primeiro: aqui a palavra diz que é plano.
    teste: (d) => /\b(TRICOLINE|VISCOLAICRA|VISCOLYCRA|VISCOSE|LINHO|LINEN|JEANS|DENIM|SARJA|OXFORD|XADREZ|CHAMBRAY|CETIM|COTTON|TEAR TEXTIL|FORRO|BRIM|GABARDINE|ALFAIATARIA|TAFETA|CREPE|LAISE|LASER)\b/.test(d),
    unidade: 'm', tipo: 'tecido', confianca: 'alta',
    regra: 'família de tecido plano (tricoline, viscose, jeans, linho, cetim, xadrez…)',
  },
  {
    // "TECIDO ..." sozinho NÃO prova que é plano. O relatório de saldo do Wik
    // de 10/09/2026 mostrou "TECIDO DYNAMIC FIT-UV50+" e "TECIDO FITNESS
    // FURADINHO" estocados em QUILO — são malha, e a palavra "TECIDO" no
    // começo do nome não avisa. Por isso este caso é 'media', não 'alta':
    // vai para a fila de conferência em vez de virar custo calado.
    teste: (d) => /^(TECIDO|TEC)\b/.test(d),
    unidade: 'm', tipo: 'tecido', confianca: 'media',
    regra: 'começa por "TECIDO" mas nenhuma palavra diz se é plano (metro) ou malha (quilo) — tratado como metro, CONFIRA',
  },

  // -------------------------------------------------------------------
  // 7. Serviço e consumível de corte — não entram na peça por unidade.
  // -------------------------------------------------------------------
  {
    teste: (d) => /\b(FACA|COLA DE MATRIZ|PAPEL PLOTTER|PLOTTER)\b/.test(d),
    unidade: 'un', tipo: 'servico', confianca: 'media',
    regra: 'consumível de corte/serviço — não é material que entra na peça',
  },
];

// Fallback: quando nenhuma regra casa, a descrição é um NOME PRÓPRIO de
// tecido (ATRIA, MISSY, JET SLIM, KOLON…), que é como a casa batiza os
// artigos dos fornecedores de malha e plano. O preço separa razoavelmente
// os dois mundos — aviamento nesta lista custa centavos, tecido custa
// dezenas — mas isso é PALPITE, e sai como 'baixa'.
function fallback(desc, preco) {
  const p = Number(preco);
  if (Number.isFinite(p) && p >= 5) {
    return {
      unidade: 'm', tipo: 'tecido', confianca: 'baixa',
      regra: `sem palavra-chave: nome próprio de artigo com preço de R$ ${p.toFixed(2)} — tratado como tecido em metro. CONFIRA se é malha (quilo)`,
    };
  }
  if (Number.isFinite(p)) {
    return {
      unidade: 'un', tipo: 'aviamento', confianca: 'baixa',
      regra: `sem palavra-chave: preço de R$ ${p.toFixed(2)} — tratado como aviamento por peça. CONFIRA`,
    };
  }
  return {
    unidade: 'un', tipo: 'outro', confianca: 'baixa',
    regra: 'sem palavra-chave e sem preço — nada permite decidir a unidade. CONFIRA',
  };
}

// Entrada: descrição e, opcionalmente, { preco, referencia, pistas }.
//   `pistas` é qualquer texto solto que veio junto no cadastro de origem
//   (no relatório do Wik, a coluna COD.FORNECEDOR carrega coisas como
//   "LARGURA 1,56" — e largura só faz sentido para artigo vendido por
//   COMPRIMENTO. É a única pista dura que a lista dá sobre unidade, e ela
//   vale mais do que qualquer palpite por família).
// Saída: { unidade, tipo, confianca, regra, descricaoNormalizada }
function classificar(descricao, opcoes) {
  const opts = (typeof opcoes === 'number' || typeof opcoes === 'string' || opcoes == null)
    ? { preco: opcoes }
    : opcoes;
  const d = normalizar(descricao);
  const pistas = normalizar([opts.pistas, opts.referencia].filter(Boolean).join(' '));

  if (!d) {
    return { unidade: 'un', tipo: 'outro', confianca: 'baixa', regra: 'sem descrição', descricaoNormalizada: '' };
  }

  // A pista de LARGURA vence as regras de família: o artigo é medido em
  // comprimento. Só não vence quando a própria descrição diz "por quilo".
  if (/\bLARGURA\b/.test(pistas) && !/\bQUILO\b/.test(d)) {
    return {
      unidade: 'm', tipo: 'tecido', confianca: 'alta',
      regra: 'o cadastro de origem informa LARGURA — largura só existe em artigo vendido por metro',
      descricaoNormalizada: d,
    };
  }

  for (const r of REGRAS) {
    if (r.teste(d)) {
      return { unidade: r.unidade, tipo: r.tipo, confianca: r.confianca, regra: r.regra, descricaoNormalizada: d };
    }
  }

  // Antes do palpite por preço: a REFERÊNCIA da casa às vezes diz a família
  // quando a descrição é só um nome próprio ("A001 / ATRIA").
  if (/^(TEC|TECIDO|MALHA|RIB|TEAR|VISC)/.test(pistas)) {
    return {
      unidade: 'm', tipo: 'tecido', confianca: 'media',
      regra: 'a referência da casa começa por TEC/TECIDO/MALHA/RIB — é artigo têxtil; tratado como metro, confira se é malha (quilo)',
      descricaoNormalizada: d,
    };
  }

  return { ...fallback(d, opts.preco), descricaoNormalizada: d };
}

// Unidades que a casa usa. Serve para a tela montar o seletor e para o
// vínculo saber quando precisa de fator de conversão.
const UNIDADES = ['un', 'm', 'kg', 'rolo', 'cone', 'milheiro', 'par', 'peca', 'l'];

// Duas unidades são "a mesma grandeza"? Se não forem, converter exige
// fator explícito — nunca chute (é o erro que troca quilo por metro).
const GRANDEZA = {
  un: 'contagem', peca: 'contagem', par: 'contagem', milheiro: 'contagem',
  m: 'comprimento',
  kg: 'peso',
  rolo: 'embalagem', cone: 'embalagem',
  l: 'volume',
};

function mesmaGrandeza(a, b) {
  if (!a || !b) return false;
  return GRANDEZA[String(a).toLowerCase()] === GRANDEZA[String(b).toLowerCase()];
}

module.exports = { classificar, normalizar, UNIDADES, GRANDEZA, mesmaGrandeza, REGRAS };
