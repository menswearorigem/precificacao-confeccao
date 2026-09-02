// Dicionário de sinônimos da busca da Manu: mapa "termo digitado (já
// normalizado, sem acento) → termo canônico". Aplicado token a token, depois
// da normalização e da extração do sinal de intenção (ver motor.js), antes
// de mandar a consulta pro Fuse. É isto que faz "shoppe", "meli" ou "onde
// bota o preco" encontrarem o verbete certo sem precisar de IA nenhuma — a
// "inteligência" é só um mapa grande e bem cuidado.
//
// Formato: cada entrada do array é [canonico, [variantes...]]. As variantes
// já devem estar em minúsculas e sem acento (a normalização do motor tira
// acento de tudo antes de comparar, mas escrever aqui sem acento evita
// depender disso). Não repita aqui o que o stemming leve do motor.js já
// resolve (plural simples com s/es) — são casos diferentes.

const GRUPOS = [
  // ---------- Verbos de ação ----------
  ['criar', ['cadastrar', 'adicionar', 'incluir', 'inserir', 'lancar', 'registrar', 'abrir', 'novo', 'nova', 'colocar', 'botar', 'subir', 'fazer', 'montar', 'gerar', 'cadastro', 'cadastrando']],
  ['editar', ['alterar', 'mudar', 'modificar', 'corrigir', 'arrumar', 'ajustar', 'atualizar', 'trocar', 'mexer']],
  ['excluir', ['apagar', 'deletar', 'remover', 'tirar', 'cancelar', 'desativar', 'inativar']],
  ['buscar', ['procurar', 'achar', 'encontrar', 'localizar', 'filtrar', 'pesquisar', 'consultar', 'ver', 'visualizar', 'olhar', 'conferir', 'checar']],
  ['exportar', ['baixar', 'salvar', 'extrair', 'imprimir']],
  ['importar', ['carregar', 'puxar', 'trazer', 'sincronizar', 'sincronizando']],

  // ---------- Substantivos do negócio ----------
  ['produto', ['peca', 'item', 'artigo', 'modelo', 'referencia', 'ref', 'sku', 'mercadoria', 'camiseta', 'camisa', 'roupa']],
  ['cliente', ['comprador', 'fregues', 'freguesia', 'loja', 'revenda']],
  ['fornecedor', ['fabrica', 'faccao', 'terceiro', 'malharia', 'aviamenteiro']],
  ['pedido', ['venda', 'ordem', 'nota']],
  ['estoque', ['saldo', 'quantidade', 'disponivel', 'inventario']],
  ['custo', ['gasto', 'despesa']],
  ['preco', ['valor', 'quanto cobrar', 'quanto vender']],
  ['margem', ['lucro', 'ganho', 'rentabilidade', 'lucratividade']],
  ['grade', ['cor e tamanho', 'tamanhos', 'numeracao', 'variacao', 'variante']],
  ['ean', ['codigo de barras', 'barra', 'gtin', 'bipagem']],
  ['marketplace', ['ml', 'mercado livre', 'meli', 'shopee', 'tiktok', 'tik tok', 'shoppe', 'canal', 'plataforma']],
  ['viagem', ['sacoleira', 'rota', 'visita', 'atendimento externo']],
  ['kit', ['combo', 'conjunto', 'pacote']],
  ['usuario', ['pessoa', 'funcionario', 'acesso', 'login de alguem', 'conta']],
  ['empresa', ['cnpj', 'pj', 'razao social']],
  ['compra', ['pedido de compra', 'compra de tecido', 'compra de material']],
  ['taxa', ['tarifa', 'comissao']],
  ['imposto', ['tributo', 'regime tributario']],
  ['alerta', ['aviso', 'notificacao', 'sinal']],
  ['calendario', ['agenda', 'evento']],
  ['dashboard', ['painel', 'indicadores', 'numeros', 'resumo geral']],

  // ---------- Erros de digitação e abreviações ----------
  // "shoppe→shopee" do enunciado original não entra como par isolado: o
  // grupo de "marketplace" acima já leva shoppe/shopee/meli/ml pro mesmo
  // canônico ("marketplace"), que é mais útil pra achar o verbete certo do
  // que resolver só a grafia. Mesma lógica para "mercadolivre".
  ['marketplace', ['mercadolivre']],
  ['codigo de barras', ['codbarra', 'cod barra']],
  ['preco', ['precificacao']],
  ['quantidade', ['qtd', 'qtde']],
  ['configuracoes', ['config']],
  ['cadastro', ['cad']],
  ['mesmo', ['msm']],
  ['porque', ['pq']],
  ['voce', ['vc']],
  ['tambem', ['tbm']],
  ['nao', ['naum']],
  ['estou', ['to']],
  ['esta', ['ta']],

  // ---------- Apelidos internos da equipe (parcial — completar com a dona) ----------
  // "ficha" sozinha NÃO entra como variante aqui de propósito: como o
  // canônico começa com a própria palavra "ficha", o token isolado
  // duplicava ("ficha tecnica tecnica tecnica…") no laço de ponto fixo da
  // normalização (motor.js normalizar()) — achado testando a bateria de
  // aceite. Só as duas frases de mais de uma palavra continuam mapeadas;
  // "ficha" sozinha fica como está e casa por semelhança mesmo assim.
  ['ficha tecnica', ['ficha de precificacao', 'ficha do produto']],
  ['dashboard', ['painel de indicadores']],
  ['configuracoes', ['parametros', 'ajustes']],
];

// index invertido: variante normalizada -> termo canônico. Construído uma
// vez, em módulo.
export const MAPA_SINONIMOS = new Map();
for (const [canonico, variantes] of GRUPOS) {
  for (const variante of variantes) {
    // uma variante pode ter mais de uma palavra ("mercado livre") — nesse
    // caso ela é tratada como frase inteira na normalização (ver motor.js),
    // não token a token.
    if (!MAPA_SINONIMOS.has(variante)) MAPA_SINONIMOS.set(variante, canonico);
  }
}
