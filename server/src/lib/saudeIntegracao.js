// Saúde da Sincronização com os marketplaces (07/09/2026).
//
// Motor puro da tela Marketplace › Saúde da Sincronização. Nada aqui toca
// banco nem rede: são as decisões de LEITURA sobre o estado da
// sincronização, isoladas para poderem ser testadas sem ambiente.
//
// A pergunta que a tela responde é uma só: **o que o sistema deixou de saber
// e não vai descobrir sozinho?**
//
// Três números importam, e são diferentes entre si:
//
//   · o pedido que falhou e AINDA está na janela de 7 dias — vai ser tentado
//     de novo no próximo ciclo, sozinho, sem ninguém fazer nada;
//   · o pedido que falhou e JÁ SAIU da janela — não vai mais ser procurado.
//     Ele está fora do sistema e vai continuar fora até alguém mandar buscar;
//   · a conexão que parou de sincronizar — que é pior que qualquer falha
//     individual, porque nada novo entra enquanto ela estiver assim.
//
// Misturar os três num "3 erros" é o que faz a tela não servir para nada.

// Espelha `JANELA_RESSINCRONIZACAO_MS` de lib/marketplaceSync.js. Se aquele
// número mudar, este muda junto — e o teste compara os dois de propósito,
// para que uma mudança lá não deixe esta tela mentindo aqui.
const JANELA_RESSINCRONIZACAO_DIAS = 7;

// Espelha o setInterval de src/index.js. A sincronização não é instantânea:
// um atraso de um ciclo é normal e não deve virar alarme.
const CICLO_MINUTOS = 5;

// A partir de quantos minutos sem sincronizar a conexão vira "atrasada" e
// depois "parada". Seis ciclos de folga antes do primeiro aviso: no plano
// gratuito do Render o serviço dorme, e um aviso a cada soneca não seria
// informação, seria ruído.
const ATRASO_ATENCAO_MINUTOS = CICLO_MINUTOS * 6;
const ATRASO_PARADA_MINUTOS = 24 * 60;

const MINUTO_MS = 60 * 1000;
const DIA_MS = 24 * 60 * MINUTO_MS;

// Cada categoria carrega a única coisa que a pessoa realmente precisa saber:
// isto se resolve sozinho, ou depende de alguém?
const CATEGORIAS = {
  sku_desconhecido: {
    rotulo: 'Produto não encontrado no estoque',
    automatico: false,
    oQueFazer:
      'O SKU ou o EAN que veio do marketplace não bate com nenhuma variante cadastrada. '
      + 'Cadastre o EAN da variante (ou corrija o SKU no anúncio) e mande tentar de novo.',
  },
  token: {
    rotulo: 'Autorização da conta',
    automatico: false,
    oQueFazer: 'A conexão precisa ser autorizada de novo em Configurações › Integrações.',
  },
  api: {
    rotulo: 'Marketplace fora do ar ou limitando',
    automatico: true,
    oQueFazer: 'Erro de rede, tempo esgotado ou limite de chamadas. Costuma passar sozinho no próximo ciclo.',
  },
  dado_do_pedido: {
    rotulo: 'Dado do pedido inesperado',
    automatico: false,
    oQueFazer: 'O pedido veio com um campo que o sistema não soube ler. Precisa de conferência manual.',
  },
  banco: {
    rotulo: 'Conflito ao gravar',
    automatico: true,
    oQueFazer:
      'Duas gravações disputaram o mesmo registro. Quase sempre passa na tentativa seguinte; '
      + 'se repetir muitas vezes, é problema de verdade.',
  },
  desconhecido: {
    rotulo: 'Não classificado',
    automatico: false,
    oQueFazer: 'A mensagem não se parece com nenhum caso conhecido. Vale ler o erro inteiro.',
  },
};

// A ordem importa: a primeira regra que casar decide. As mais específicas
// vêm antes das mais genéricas — "token expirado" contém "expirado", que
// também aparece em erro de rede.
const REGRAS_CATEGORIA = [
  [/token|autoriza|unauthorized|forbidden|\b401\b|\b403\b|credencia/i, 'token'],
  [/sku|ean|variante|refer[êe]ncia|produto n[ãa]o encontrad|n[ãa]o casou/i, 'sku_desconhecido'],
  [/timeout|timed ?out|etimed|tempo esgotado|econn|enotfound|socket|network|rede|\b429\b|\b5\d\d\b|limite de (chamadas|requisi)/i, 'api'],
  [/duplicate key|unique|constraint|deadlock|serializa|violates|violação/i, 'banco'],
  [/quantidade|valor|data inv[áa]lida|campo|formato|nulo|null value/i, 'dado_do_pedido'],
];

function categorizarErro(mensagem) {
  const texto = String(mensagem || '');
  for (const [padrao, categoria] of REGRAS_CATEGORIA) {
    if (padrao.test(texto)) return { categoria, ...CATEGORIAS[categoria] };
  }
  return { categoria: 'desconhecido', ...CATEGORIAS.desconhecido };
}

function paraData(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A DATA QUE DECIDE. A janela de ressincronização filtra por data do PEDIDO
// no marketplace, não por quando nós falhamos — então é a data do pedido que
// diz se ele ainda vai ser procurado. Sem data de pedido (acontece quando a
// falha foi tão cedo que nem isso veio), sobra a data da primeira falha, e a
// tela diz que está usando a segunda melhor informação.
function dataDeReferencia(falha = {}) {
  const doPedido = paraData(falha.data_pedido);
  if (doPedido) return { data: doPedido, origem: 'data_pedido' };
  const daFalha = paraData(falha.primeira_falha_em);
  if (daFalha) return { data: daFalha, origem: 'primeira_falha_em' };
  return { data: null, origem: null };
}

// Onde esta falha está: já resolvida, ainda na fila de novas tentativas, ou
// abandonada — que é a palavra certa, porque ninguém vai buscar aquele
// pedido de novo.
function situacaoDaFalha(falha = {}, agora = new Date()) {
  if (falha.resolvido_em) {
    return {
      situacao: 'resolvida',
      rotulo: 'Resolvida',
      tom: 'tone-saudavel',
      motivo: falha.resolvido_como === 'manual'
        ? 'Marcada como resolvida por uma pessoa.'
        : 'O pedido entrou no sistema.',
      diasDesde: null,
      dentroDaJanela: null,
    };
  }

  const { data, origem } = dataDeReferencia(falha);
  if (!data) {
    return {
      situacao: 'abandonada',
      rotulo: 'Sem data',
      tom: 'tone-prejuizo',
      motivo: 'A falha não tem data de pedido nem data de primeira tentativa — não dá para saber se ainda está na janela. Trate como abandonada e mande buscar.',
      diasDesde: null,
      dentroDaJanela: false,
    };
  }

  const diasDesde = (agora.getTime() - data.getTime()) / DIA_MS;
  const dentroDaJanela = diasDesde <= JANELA_RESSINCRONIZACAO_DIAS;

  if (dentroDaJanela) {
    const diasRestantes = JANELA_RESSINCRONIZACAO_DIAS - diasDesde;
    return {
      situacao: 'em_fila',
      rotulo: 'Vai tentar de novo',
      tom: 'tone-atencao',
      motivo: `O pedido ainda está dentro da janela de ${JANELA_RESSINCRONIZACAO_DIAS} dias, então a sincronização volta a procurá-lo sozinha por mais ${Math.floor(diasRestantes)} dia(s).`,
      diasDesde,
      dentroDaJanela: true,
      origemDaData: origem,
    };
  }

  return {
    situacao: 'abandonada',
    rotulo: 'Não vai mais tentar',
    tom: 'tone-prejuizo',
    motivo: `O pedido é de ${Math.floor(diasDesde)} dias atrás e já saiu da janela de ${JANELA_RESSINCRONIZACAO_DIAS} dias. A sincronização não procura mais por ele — este pedido está fora do sistema até alguém mandar buscar.`,
    diasDesde,
    dentroDaJanela: false,
    origemDaData: origem,
  };
}

// Valor de uma falha. NULL e zero são coisas diferentes e continuam sendo
// (REGRA 2): um pedido sem itens não vale R$ 0,00, ele tem valor
// desconhecido.
function valorDaFalha(falha = {}) {
  if (falha.valor_itens === null || falha.valor_itens === undefined || falha.valor_itens === '') return null;
  const n = Number(falha.valor_itens);
  return Number.isFinite(n) ? n : null;
}

// O placar da tela. Note que `valor` vem com a contagem de quantas falhas
// entraram na soma e quantas ficaram de fora por não ter valor — sem isso,
// "R$ 430,00 parados" pareceria o total quando pode ser metade.
function resumo(falhas = [], agora = new Date()) {
  const abertas = [];
  // As já resolvidas eram contadas e as linhas jogadas fora. A tela dizia
  // "3 resolvidas" e não tinha como mostrar QUAIS — quem quisesse conferir o
  // que tinha entrado de volta ontem não tinha onde olhar. A lista sai aqui
  // separada; nada dela entra em nenhum dos totais das abertas.
  const listaResolvidas = [];
  let resolvidas = 0;
  let emFila = 0;
  let abandonadas = 0;
  let valorTotal = 0;
  let comValor = 0;
  let semValor = 0;
  const porCategoria = {};
  let maisAntiga = null;

  for (const falha of falhas) {
    const situacao = situacaoDaFalha(falha, agora);
    if (situacao.situacao === 'resolvida') {
      resolvidas += 1;
      listaResolvidas.push({ ...falha, situacao });
      continue;
    }
    abertas.push({ ...falha, situacao });
    if (situacao.situacao === 'em_fila') emFila += 1;
    else abandonadas += 1;

    const valor = valorDaFalha(falha);
    if (valor === null) semValor += 1;
    else { valorTotal += valor; comValor += 1; }

    const categoria = falha.categoria || 'desconhecido';
    if (!porCategoria[categoria]) {
      porCategoria[categoria] = { categoria, ...(CATEGORIAS[categoria] || CATEGORIAS.desconhecido), quantidade: 0 };
    }
    porCategoria[categoria].quantidade += 1;

    const { data } = dataDeReferencia(falha);
    if (data && (!maisAntiga || data < maisAntiga)) maisAntiga = data;
  }

  return {
    total: falhas.length,
    resolvidas,
    abertas: abertas.length,
    emFila,
    abandonadas,
    valor: { total: valorTotal, comValor, semValor },
    porCategoria,
    maisAntiga,
    lista: abertas,
    // Mais recente primeiro: quem abre "o que já foi resolvido" quer ver o
    // de hoje, não o de 30 dias atrás.
    listaResolvidas: listaResolvidas.sort(
      (a, b) => new Date(b.resolvido_em).getTime() - new Date(a.resolvido_em).getTime()
    ),
  };
}

// Como está UMA conexão. A ordem das perguntas é a ordem da gravidade:
// desligada, sem autorização, token vencido, parada, atrasada, com erro, ok.
// Uma conexão parada é pior que qualquer falha individual, porque enquanto
// ela estiver assim NADA novo entra.
function situacaoDaConexao(integracao = {}, agora = new Date()) {
  const ultima = paraData(integracao.ultima_sincronizacao);
  const atrasoMinutos = ultima ? (agora.getTime() - ultima.getTime()) / MINUTO_MS : null;
  const base = { atrasoMinutos, ultimaSincronizacao: ultima };

  if (integracao.ativo === false) {
    return { ...base, situacao: 'desativada', rotulo: 'Desativada', tom: 'tone-neutro', motivo: 'A conexão está desligada. Nada é importado dela.' };
  }
  if (!integracao.access_token) {
    return { ...base, situacao: 'sem_autorizacao', rotulo: 'Sem autorização', tom: 'tone-prejuizo', motivo: 'A conexão nunca foi autorizada. Autorize em Configurações › Integrações.' };
  }

  const expira = paraData(integracao.token_expira_em);
  if (expira && expira <= agora) {
    return { ...base, situacao: 'token_vencido', rotulo: 'Autorização vencida', tom: 'tone-prejuizo', motivo: 'O token de acesso venceu. A sincronização tenta renovar sozinha; se continuar assim, autorize de novo.' };
  }

  if (!ultima) {
    return { ...base, situacao: 'nunca_sincronizou', rotulo: 'Nunca sincronizou', tom: 'tone-atencao', motivo: 'Esta conexão está autorizada mas nunca completou uma sincronização.' };
  }

  if (atrasoMinutos >= ATRASO_PARADA_MINUTOS) {
    return { ...base, situacao: 'parada', rotulo: 'Parada', tom: 'tone-prejuizo', motivo: `Sem sincronizar há mais de ${Math.floor(atrasoMinutos / 60)} h. Enquanto estiver assim, nenhum pedido novo entra por ela.` };
  }
  if (atrasoMinutos >= ATRASO_ATENCAO_MINUTOS) {
    return { ...base, situacao: 'atrasada', rotulo: 'Atrasada', tom: 'tone-atencao', motivo: `O ciclo roda a cada ${CICLO_MINUTOS} min e a última foi há ${Math.floor(atrasoMinutos)} min.` };
  }
  if (integracao.ultimo_erro) {
    return { ...base, situacao: 'com_erro', rotulo: 'Sincroniza, mas com erro', tom: 'tone-atencao', motivo: `Último ciclo terminou com: ${integracao.ultimo_erro}` };
  }
  return { ...base, situacao: 'ok', rotulo: 'Em dia', tom: 'tone-saudavel', motivo: null };
}

// A frase do topo da tela. É a única coisa que alguém com pressa vai ler, e
// por isso ela fala do pior caso primeiro e nunca arredonda para melhor.
function frasePrincipal(conexoes = [], resumoFalhas = { abandonadas: 0, emFila: 0 }) {
  const paradas = conexoes.filter((c) => ['parada', 'sem_autorizacao', 'token_vencido'].includes(c.situacao?.situacao));
  if (paradas.length > 0) {
    return {
      tom: 'tone-prejuizo',
      texto: `${paradas.length} conexão(ões) não estão trazendo pedido nenhum. Enquanto isso não for resolvido, o resto do sistema trabalha com faturamento incompleto.`,
    };
  }
  if (resumoFalhas.abandonadas > 0) {
    return {
      tom: 'tone-prejuizo',
      texto: `${resumoFalhas.abandonadas} pedido(s) falharam na importação e já saíram da janela de ${JANELA_RESSINCRONIZACAO_DIAS} dias. Eles não vão ser procurados de novo sozinhos.`,
    };
  }
  if (resumoFalhas.emFila > 0) {
    return {
      tom: 'tone-atencao',
      texto: `${resumoFalhas.emFila} pedido(s) falharam mas ainda estão na janela — a sincronização volta a tentar sozinha.`,
    };
  }
  return { tom: 'tone-saudavel', texto: 'Nenhum pedido ficou de fora, e todas as conexões estão em dia.' };
}

module.exports = {
  JANELA_RESSINCRONIZACAO_DIAS,
  CICLO_MINUTOS,
  ATRASO_ATENCAO_MINUTOS,
  ATRASO_PARADA_MINUTOS,
  CATEGORIAS,
  categorizarErro,
  dataDeReferencia,
  situacaoDaFalha,
  valorDaFalha,
  resumo,
  situacaoDaConexao,
  frasePrincipal,
};
