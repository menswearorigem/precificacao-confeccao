// Verbetes do módulo Viagens — lista de viagens (/viagens, ViagensListPage.jsx)
// e o detalhe de cada viagem (/viagens/:id, ViagemDetailPage.jsx: catálogo de
// produtos levados, carrinho de venda com checkout, entrada de estoque direto
// na viagem, resumo de vendas). Como /viagens/:id não é navegável sem saber o
// id de uma viagem específica, todo verbete sobre a tela de detalhe aponta a
// rota pra /viagens (a lista, de onde qualquer viagem é aberta).

export const verbetesViagens = [
  {
    id: 'viagens-listar-criar',
    modulo: 'viagens',
    tela: 'Viagens',
    titulo: 'Ver, criar e organizar viagens',
    rota: '/viagens',
    perguntas: [
      'como crio uma viagem',
      'nova viagem',
      'onde vejo minhas viagens',
      'lista de viagens',
      'viagem em andamento',
      'viagem em planejamento',
      'viagem finalizada',
      'nome local e data da viagem',
      'quanto uma viagem faturou',
      'quantos produtos tem numa viagem',
      'para que serve o modulo de viagens',
    ],
    resposta:
      'A tela **Viagens** lista as viagens agrupadas por situação: **Em andamento**, **Planejamento** e **Finalizadas**. Cada cartão mostra local, data, quantidade de produtos levados, quantidade de vendas e o total faturado — clicar no cartão abre o detalhe da viagem.\n\nO botão **Nova viagem** pede nome, local, data de início/fim e observações (opcional); ao criar, o sistema já leva direto pro catálogo da viagem pra começar a escolher o que ela vai levar. O módulo existe pra planejar o que levar numa venda fora do ponto fixo (feira, evento, viagem de vendas), ver o que dá pra vender sem medo de faltar estoque, e fechar vendas na hora com o estoque baixando em tempo real.',
    relacionados: ['viagens-detalhe-adicionar-produto', 'viagens-detalhe-situacao'],
  },
  {
    id: 'viagens-detalhe-adicionar-produto',
    modulo: 'viagens',
    tela: 'Detalhe da Viagem',
    titulo: 'Adicionar ou tirar um produto da viagem',
    rota: '/viagens',
    perguntas: [
      'adicionar produto na viagem',
      'buscar produto para levar na viagem',
      'montar catalogo da viagem',
      'tirar produto da viagem',
      'remover produto da viagem',
      'produto nao aparece na viagem',
    ],
    resposta:
      'Dentro de uma viagem, o card **Adicionar Produto à Viagem** busca por referência ou descrição — clicar no resultado já adiciona o produto ao catálogo daquela viagem, com todas as variantes (cor/tamanho) dele. O catálogo da viagem tem seu próprio campo de busca separado, pra filtrar entre os produtos já adicionados.\n\nO ícone de lixeira no cartão de cada produto tira ele da viagem — vendas que já foram feitas com ele continuam registradas normalmente, só o produto some da lista de "o que essa viagem está levando".',
    relacionados: ['viagens-listar-criar', 'viagens-detalhe-precos'],
  },
  {
    id: 'viagens-detalhe-precos',
    modulo: 'viagens',
    tela: 'Detalhe da Viagem',
    titulo: 'Preço mínimo, ideal e desconto máximo de cada produto na viagem',
    rota: '/viagens',
    perguntas: [
      'preco minimo na viagem',
      'preco ideal na viagem',
      'desconto ideal e desconto maximo',
      'ate quanto posso dar de desconto na viagem',
      'custo de producao mostrado na viagem',
      'pode vender sem medo o que significa',
      'status atencao conferir estoque',
      'sem estoque disponivel na viagem',
    ],
    resposta:
      'Cada produto na viagem mostra, lado a lado, o **preço mínimo**, o **preço ideal** (o de referência pra vender), o **desconto ideal** e o **desconto máximo** que a formação de preço do produto permite, além do custo de produção da peça — tudo já calculado, sem precisar abrir a ficha do produto.\n\nUm selo indica a situação de estoque do produto na viagem: **"Pode vender sem medo"** (estoque confortável), **"Atenção — conferir estoque"** (ficando baixo) ou **"Sem estoque disponível"**. Cada peça já colocada no carrinho de venda desconta visualmente desse estoque mostrado, mesmo antes da venda ser confirmada — pra não deixar vender a mesma peça duas vezes sem perceber.',
    relacionados: ['viagens-detalhe-vender-carrinho', 'viagens-detalhe-dar-entrada'],
  },
  {
    id: 'viagens-detalhe-vender-carrinho',
    modulo: 'viagens',
    tela: 'Detalhe da Viagem',
    titulo: 'Vender na viagem: carrinho e fechamento (checkout)',
    rota: '/viagens',
    perguntas: [
      'vender produto na viagem',
      'carrinho de venda da viagem',
      'fechar venda na viagem',
      'finalizar venda na viagem',
      'checkout da viagem',
      'baixar estoque vendendo na viagem',
      'vincular cliente na venda da viagem',
      'cliente avulso sem cadastro na viagem',
      'forma de pagamento na venda da viagem',
      'desconto acima do maximo na viagem',
      'quantidade maior que o estoque na viagem',
      'nao consigo vender viagem finalizada',
      'venda de sacoleira na rua como lanco',
    ],
    resposta:
      'Em cada variante (cor/tamanho) de um produto, o botão **Vender** adiciona uma peça ao carrinho — clicar de novo na mesma variante aumenta a quantidade. Uma barra flutuante mostra o total de peças e o valor do carrinho, com o botão **Finalizar Venda** pra abrir o checkout.\n\nNo checkout, cada item pode ter quantidade, valor unitário e desconto (%) ajustados na hora — o sistema avisa se a quantidade passar do estoque disponível, ou se o desconto passar do máximo permitido pro produto (não bloqueia, só avisa). É possível buscar um cliente já cadastrado, ou digitar um "nome rápido" sem cadastro, e anotar a forma de pagamento livremente (Pix, Dinheiro, Cartão...). O botão **Confirmar Venda e Baixar Estoque** registra a venda e já desconta do estoque na hora.\n\nSó dá pra vender enquanto a viagem não está com a situação **Finalizada**.',
    relacionados: ['viagens-detalhe-precos', 'viagens-detalhe-situacao'],
  },
  {
    id: 'viagens-detalhe-dar-entrada',
    modulo: 'viagens',
    tela: 'Detalhe da Viagem',
    titulo: 'Dar entrada de estoque direto na viagem',
    rota: '/viagens',
    perguntas: [
      'dar entrada de estoque na viagem',
      'chegou mais peca durante a viagem',
      'aumentar estoque de um produto na viagem',
      'reposicao durante a viagem',
      'botao de entrada no card do produto',
    ],
    resposta:
      'O ícone de caixa com "+" no card de cada produto abre um modo de entrada de estoque: um campo de quantidade aparece ao lado de cada variante (cor/tamanho), pra lançar reposição que chegou durante a viagem (por exemplo, alguém trouxe mais peças de fora). Preenchendo as quantidades e clicando em **Confirmar Entrada**, o estoque daquelas variantes já sobe na hora — sem precisar sair da viagem e ir na tela de Estoque.',
    relacionados: ['viagens-detalhe-precos'],
  },
  {
    id: 'viagens-detalhe-situacao',
    modulo: 'viagens',
    tela: 'Detalhe da Viagem',
    titulo: 'Situação da viagem e resumo de vendas',
    rota: '/viagens',
    perguntas: [
      'iniciar viagem',
      'finalizar viagem',
      'mudar situacao da viagem',
      'resumo de vendas da viagem',
      'lucro da viagem',
      'margem da viagem',
      'quantas pecas vendi na viagem',
      'quantas vendas teve a viagem',
    ],
    resposta:
      'Uma viagem nova começa em **Planejamento**. O botão **Iniciar Viagem** muda pra **Em andamento** (libera a venda, se ainda não estivesse liberada). O botão **Finalizar Viagem** encerra ela — depois de finalizada, não dá mais pra vender, mas todo o histórico continua disponível pra consulta.\n\nNo topo do detalhe da viagem, uma faixa de resumo mostra o total **Vendido** (receita), **Lucro**, **Margem**, quantidade de **Peças vendidas** e número de **Vendas** — atualizado a cada venda confirmada.',
    relacionados: ['viagens-listar-criar', 'viagens-detalhe-vender-carrinho'],
  },
];
