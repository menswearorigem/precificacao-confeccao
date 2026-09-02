// Verbetes do módulo Financeiro — as três abas de /financeiro
// (Movimentação, Repasses e Conferência, todas em FinanceiroPage.jsx).
// A linguagem aqui é a de quem cuida do caixa, não a de quem precifica: o
// assunto é dinheiro que entrou e saiu da conta, não margem nem custo.

export const verbetesFinanceiro = [
  {
    id: 'financeiro-movimentacao',
    modulo: 'financeiro',
    tela: 'Movimentação',
    titulo: 'Quanto o marketplace liberou, por data e plataforma',
    rota: '/financeiro/movimentacao',
    perguntas: [
      'quanto o marketplace pagou',
      'quanto foi liberado na conta',
      'quanto entrou de dinheiro',
      'movimentacao bancaria do periodo',
      'quanto a shopee me pagou',
      'quanto o mercado livre liberou',
      'quanto a tiktok repassou',
      'extrato do marketplace',
      'dinheiro liberado por data',
      'quanto caiu na conta em cada dia',
    ],
    resposta:
      'A aba **Movimentação** responde exatamente isso: escolha o período no filtro de data e a tabela **Liberado por data e plataforma** mostra, dia a dia, quanto cada marketplace liberou na conta — uma coluna por plataforma e o total do dia na última.\n\nO número vem do **extrato da própria plataforma**, não da soma dos pedidos. Por isso ele inclui o que não pertence a venda nenhuma: publicidade descontada, multa, ajuste, estorno de um pedido antigo e saque para o banco. O quadro **Para onde o dinheiro foi** separa esses tipos.\n\nO que ainda **não foi liberado** aparece à parte, no indicador "Ainda pendente" — nunca somado ao liberado, porque dinheiro retido ainda não é movimentação bancária.',
    relacionados: ['financeiro-filtros', 'financeiro-repasses', 'financeiro-conferencia'],
  },
  {
    id: 'financeiro-filtros',
    modulo: 'financeiro',
    tela: 'Movimentação',
    titulo: 'Escolher o que aparece na tela (Ads, devolução, taxas…)',
    rota: '/financeiro/movimentacao',
    perguntas: [
      'filtrar tipo de lancamento',
      'quanto gastei de ads',
      'quanto foi descontado de publicidade',
      'quanto voltou de devolucao',
      'quanto paguei de taxa',
      'ver so os estornos',
      'esconder lancamento do relatorio',
      'antecipacao de recebiveis',
    ],
    resposta:
      'O quadro **O que aparece na tela** tem uma caixinha por tipo de lançamento: repasse de venda, devolução/estorno, publicidade (Ads), taxas e multas, antecipação, ajustes, saque para o banco e outros. Desmarcar um tipo tira ele de tudo — tabela de datas, resumo e lista detalhada — então dá pra montar, por exemplo, "só o que a plataforma me cobrou no mês".\n\nOs outros filtros da barra são: **período**, **plataforma**, **loja**, **situação** (liberado, pendente ou os dois) e **com/sem pedido vinculado** — esse último é útil pra achar dinheiro que entrou sem venda por trás.\n\nQualquer combinação de filtro pode ser exportada em CSV ou Excel pelo botão **Exportar**.',
    relacionados: ['financeiro-movimentacao', 'financeiro-tipos'],
  },
  {
    id: 'financeiro-tipos',
    modulo: 'financeiro',
    tela: 'Movimentação',
    titulo: 'O que significa cada tipo de lançamento',
    rota: '/financeiro/movimentacao',
    perguntas: [
      'o que e repasse de venda',
      'o que e ajuste no extrato',
      'o que significa outros no financeiro',
      'tipo de lancamento desconhecido',
      'lancamento sem pedido',
    ],
    resposta:
      '**Repasse de venda** é o dinheiro do pedido, já líquido do que a plataforma cobrou. **Devolução/estorno** é valor que voltou pro cliente. **Publicidade (Ads)** é o que a plataforma descontou de anúncio. **Taxas e multas** são cobranças da plataforma que não são comissão de pedido. **Antecipação** é quando o dinheiro sai antes do prazo mediante taxa. **Saque para o banco** é a transferência do saldo. **Ajustes** são correções lançadas pela plataforma.\n\n**Outros** é proposital: quando a plataforma manda um rótulo que o sistema ainda não conhece, o lançamento entra como "outros" com a descrição original preservada na coluna Descrição — em vez de ser encaixado num tipo parecido e virar número errado com cara de certo.\n\nLançamento **sem pedido vinculado** é normal: multa, Ads e ajuste não têm pedido. Quando o lançamento tem um pedido que ainda não foi importado aqui, a coluna Pedido mostra a marca "externo".',
    relacionados: ['financeiro-filtros', 'financeiro-conferencia'],
  },
  {
    id: 'financeiro-repasses',
    modulo: 'financeiro',
    tela: 'Repasses',
    titulo: 'Conferir com o extrato bancário',
    rota: '/financeiro/repasses',
    perguntas: [
      'conferir com o extrato do banco',
      'quais transferencias o marketplace mandou',
      'repasse ainda nao caiu',
      'quando o dinheiro cai na conta',
      'valor da transferencia do marketplace',
    ],
    resposta:
      'Cada linha da aba **Repasses** é uma transferência da plataforma para a conta da empresa — é o nível que casa **uma pra uma** com o extrato bancário. A coluna Situação diz se o repasse já foi **pago**, está **processando** ou é **previsto**; os dois primeiros indicadores somam pago e não-pago separadamente, porque repasse em processamento ainda não caiu.\n\nA coluna **Lançamentos** mostra quantas linhas do extrato compõem aquele repasse — é o caminho pra abrir e ver de onde saiu o valor.',
    relacionados: ['financeiro-movimentacao', 'financeiro-conferencia'],
  },
  {
    id: 'financeiro-conferencia',
    modulo: 'financeiro',
    tela: 'Conferência',
    titulo: 'Por que o extrato não bate com a soma dos pedidos',
    rota: '/financeiro/conferencia',
    perguntas: [
      'extrato nao bate com os pedidos',
      'diferenca entre o que caiu e o que vendi',
      'conciliacao financeira',
      'sobra sem explicacao',
      'faltou dinheiro do marketplace',
      'conferir repasse com as vendas',
    ],
    resposta:
      'A aba **Conferência** põe lado a lado, por dia e por plataforma, duas leituras independentes: o **extrato** da plataforma e a **soma do valor recebido dos pedidos** liberados naquele dia.\n\nAs duas quase nunca são iguais — e isso normalmente **não é erro**. A diferença é justamente o que o extrato tem e a venda não: publicidade, multa, ajuste, estorno. Por isso a coluna que importa é a última, **Sobra sem explicação**: é o que resta depois de descontar esses lançamentos. Quando ela mostra "bate", o dia fechou.\n\nQuando um dos dois lados não existe, a linha mostra "não lido" ou "sem pedido" em vez de zero — de propósito: um zero passaria a impressão de que está batendo.',
    relacionados: ['financeiro-repasses', 'financeiro-sincronizar'],
  },
  {
    id: 'financeiro-sincronizar',
    modulo: 'financeiro',
    tela: 'Financeiro',
    titulo: 'Atualizar o extrato e por que o Mercado Livre demora',
    rota: '/financeiro/movimentacao',
    perguntas: [
      'atualizar o extrato',
      'puxar extrato agora',
      'extrato vazio',
      'nao aparece nada no financeiro',
      'relatorio de liberacoes do mercado pago',
      'por que o mercado livre demora',
    ],
    resposta:
      'O extrato é atualizado sozinho a cada 30 minutos, e o botão **Puxar extrato agora** força a leitura na hora.\n\nA Shopee e a TikTok Shop respondem na mesma chamada. O **Mercado Livre é diferente**: o extrato de lá é o Relatório de Liberações do Mercado Pago, que é **gerado sob encomenda** — o sistema pede, o Mercado Pago prepara o arquivo em alguns minutos e a leitura acontece na passada seguinte. Por isso a primeira carga do Mercado Livre costuma precisar de dois cliques com alguns minutos de intervalo, e a mensagem "relatório pedido" é o comportamento normal, não erro.\n\nSe alguma linha do extrato vier ilegível (sem data ou sem valor), aparece um aviso amarelo no topo dizendo quantas ficaram de fora — elas **não** entram no relatório como R$ 0,00, porque um zero escondido faz o total fechar errado sem ninguém perceber.',
    relacionados: ['financeiro-movimentacao', 'financeiro-conferencia'],
  },
];
