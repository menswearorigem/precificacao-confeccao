// Verbetes do módulo Calendário — visão principal com Mês/Kanban/Lista
// (/calendario, CalendarioPage.jsx), o formulário de evento
// (EventoCalendarioModal.jsx, aberto de dentro de /calendario — sem rota
// própria), a lógica de situação/cor (situacaoEvento.js, corCategoria.js), o
// quadro Kanban (CalendarioKanban.jsx), a impressão de um evento
// (/calendario/eventos/:id/imprimir, EventoImpressaoPage.jsx — página de
// detalhe com id real, sem rota fixa navegável, então os verbetes sobre
// imprimir um evento apontam pra /calendario, de onde o botão é aberto) e os
// Modelos do Calendário (/calendario/modelos, TemplatesCalendarioPage.jsx,
// só visível pra administrador).
//
// Nota de escopo: o módulo Calendário não está na lista original de módulos
// do spec da Manu (Produto/Estoque/Vendas/Marketplace/Viagens/Compras/
// Análises/Configurações) — foi incluído por completude, já que é um módulo
// real e ativo do sistema (client/src/lib/modules.js), com a mesma
// profundidade de leitura e verbetes dos demais.

export const verbetesCalendario = [
  {
    id: 'calendario-visao-mes-navegacao',
    modulo: 'calendario',
    tela: 'Calendário — Visão Mês',
    titulo: 'Visão Mês — grade do mês, navegação e indicadores',
    rota: '/calendario',
    perguntas: [
      'calendario visao mes',
      'navegar entre meses',
      'ir para hoje no calendario',
      'quantos atrasados no calendario',
      'eventos vencendo em 7 dias',
      'concluidos no mes',
      'clicar num dia vazio do calendario',
      'clicar num dia com varios eventos',
      'mais de 3 eventos no mesmo dia',
      'imprimir o calendario do mes',
    ],
    resposta:
      'A tela **Calendário** abre na **Visão Mês**: uma grade com o mês inteiro (incluindo dias do mês anterior/seguinte que completam a semana), navegável pelas setas ou pelo botão **Hoje**. No topo, três indicadores resumem a situação geral: **Atrasados**, **Vencendo em 7 dias** e **Concluídos no mês**.\n\nCada dia mostra até 3 eventos (chips coloridos por situação, com uma bolinha da cor da categoria); havendo mais, aparece "+N mais". Clicar num dia **vazio** já abre direto o formulário de novo evento com aquela data; clicar num dia **com eventos** abre um menu curto com a lista deles e um atalho "Criar novo evento nesse dia". O botão **Imprimir/Exportar PDF** gera uma versão só da visão ativa no momento (aqui, a grade do mês).',
    relacionados: ['calendario-filtros-visoes-kanban-lista', 'calendario-situacao-cores-legenda', 'calendario-criar-evento-basico'],
  },
  {
    id: 'calendario-filtros-visoes-kanban-lista',
    modulo: 'calendario',
    tela: 'Calendário',
    titulo: 'Filtros e as visões Kanban e Lista',
    rota: '/calendario',
    perguntas: [
      'filtrar calendario por categoria',
      'filtrar calendario por responsavel',
      'filtrar calendario por status',
      'buscar evento por titulo ou sku',
      'quadro kanban do calendario',
      'arrastar evento para outra coluna',
      'lista de eventos do calendario',
      'trocar entre mes kanban e lista',
    ],
    resposta:
      'A barra de filtros do Calendário vale pras três visões: **Categoria**, **Responsável** e busca livre por título, SKU ou referência; o filtro de **Status** só aparece nas visões Mês e Lista (no Kanban a coluna já é o status).\n\nA visão **Kanban** organiza os eventos em 4 colunas — Não iniciado, Em andamento, Concluído, Cancelado — e arrastar um cartão pra outra coluna já muda o status do evento na hora (só funciona pra quem tem permissão de editar aquele evento). A visão **Lista** mostra os eventos filtrados numa tabela (título, categoria, responsáveis, prazo, status); clicar numa linha abre o evento. Trocar de visão (Mês/Kanban/Lista) é pelos botões no topo da tela.',
    relacionados: ['calendario-visao-mes-navegacao', 'calendario-situacao-cores-legenda'],
  },
  {
    id: 'calendario-situacao-cores-legenda',
    modulo: 'calendario',
    tela: 'Calendário',
    titulo: 'De onde vem a cor de cada evento (situação e categoria)',
    rota: '/calendario',
    perguntas: [
      'por que o evento esta vermelho',
      'evento atrasado no calendario',
      'evento vencendo em breve',
      'legenda de cores do calendario',
      'quantos dias antes o evento fica amarelo',
      'onde configuro os dias de alerta do calendario',
      'cor da bolinha da categoria',
    ],
    resposta:
      'Cada evento tem uma **situação** — Atrasado, Vencendo em breve, No prazo ou Concluído — mostrada pela cor do chip/cartão e explicada na legenda no rodapé da grade. Evento concluído é sempre "Concluído"; evento cancelado conta como "No prazo" (não gera alerta); os demais viram "Atrasado" se já passou do prazo, ou "Vencendo em breve" se faltam poucos dias — esse limiar de dias é o mesmo configurado em Configurações → Parâmetros ("a partir de quantos dias antes o evento vira urgente").\n\nJá a bolinha colorida ao lado do título é a cor da **categoria** do evento — gerada automaticamente a partir do próprio texto da categoria (sempre a mesma cor pra mesma categoria), já que o cadastro de categorias não guarda uma cor escolhida à mão.',
    relacionados: ['calendario-visao-mes-navegacao', 'config-parametros-kits-marketplace-calendario'],
  },
  {
    id: 'calendario-criar-evento-basico',
    modulo: 'calendario',
    tela: 'Calendário — Novo evento',
    titulo: 'Criar ou editar um evento — campos básicos',
    rota: '/calendario',
    perguntas: [
      'criar evento no calendario',
      'novo evento',
      'escolher modelo do evento',
      'evento simples sem modelo',
      'prioridade do evento',
      'status do evento',
      'data prevista de fim do evento',
      'data de conclusao real',
      'vincular produto ao evento',
      'referencia sem cadastro no evento',
      'descricao do evento',
      'titulo e data prevista sao obrigatorios',
    ],
    resposta:
      'O botão **Novo evento** (ou clicar num dia vazio) abre o formulário. Ao criar (não ao editar), o primeiro campo é o **Modelo** — "Evento simples (sem modelo)" ou um dos modelos cadastrados em Modelos do Calendário; escolher um modelo já muda os campos extras que aparecem mais abaixo. Título e **Data prevista de fim** são os únicos campos obrigatórios pra salvar.\n\nOs demais campos básicos: Prioridade (Baixa/Média/Alta), Status (Não iniciado/Em andamento/Concluído/Cancelado — marcar Concluído libera o campo Data de conclusão real, preenchida com hoje se deixada em branco), Data início, Descrição, e **Produto vinculado** (busca por referência/código/descrição — puxa foto e referência automaticamente). Sem um produto cadastrado, dá pra digitar a referência/SKU como texto livre no campo próprio, sem vincular a nenhum produto real.',
    relacionados: ['calendario-evento-grade-variacoes', 'calendario-evento-corte-meta', 'calendario-evento-categoria-anexos-acoes'],
  },
  {
    id: 'calendario-evento-grade-variacoes',
    modulo: 'calendario',
    tela: 'Calendário — Novo evento',
    titulo: 'Detalhar o evento por variação (cor/tamanho)',
    rota: '/calendario',
    perguntas: [
      'grade de variacoes no evento',
      'detalhar evento por cor e tamanho',
      'quando aparece a grade no evento',
      'sugestao de variantes no evento',
      'quantidade por cor e tamanho no calendario',
      'grade de variacao no evento do corte',
    ],
    resposta:
      'O toggle **"Detalhar por variação (cor/tamanho)"** só aparece em dois casos: no modelo fixo **Corte**, ou em qualquer modelo customizado que tenha um campo do tipo "Grade de variação" (configurado em Modelos do Calendário) — nunca num evento simples. Ligado, abre a mesma grade de cor/tamanho/quantidade usada em outras partes do sistema.\n\nSe o evento já tem um produto vinculado, a grade vem pré-preenchida com as variantes sugeridas daquele produto (cor e tamanho, quantidade em branco pra preencher) assim que o toggle é ligado pela primeira vez — só uma sugestão de ponto de partida, os valores continuam totalmente editáveis.',
    relacionados: ['calendario-criar-evento-basico', 'gloss-grade'],
  },
  {
    id: 'calendario-evento-corte-meta',
    modulo: 'calendario',
    tela: 'Calendário — Novo evento',
    titulo: 'Campos dos modelos fixos "Previsão de chegada de corte" e "Meta"',
    rota: '/calendario',
    perguntas: [
      'campos do modelo corte',
      'previsao de chegada de corte',
      'fornecedor do corte',
      'tipo de adicao do corte',
      'quantidade e cor tecido do corte',
      'campos do modelo meta',
      'valor alvo da meta',
    ],
    resposta:
      'Os dois modelos fixos do sistema têm formulário próprio (não passam pelo motor de campos customizados). **Previsão de chegada de corte**: Fornecedor (busca), Tipo de adição (lista cadastrada em Listas), Quantidade e Cor/tecido — esse último com sugestões de variante quando há produto vinculado com variantes cadastradas. **Meta**: um único campo, Valor/indicador alvo (numérico).\n\nOs dois modelos fixos não aparecem pra editar em Modelos do Calendário (só pra ativar/desativar) — os campos deles são fixos no código, diferente dos modelos customizados.',
    relacionados: ['calendario-criar-evento-basico', 'calendario-modelos-customizados'],
  },
  {
    id: 'calendario-evento-responsaveis-visibilidade',
    modulo: 'calendario',
    tela: 'Calendário — Novo evento',
    titulo: 'Responsáveis x "Quem vê / quem edita" o evento',
    rota: '/calendario',
    perguntas: [
      'responsaveis do evento',
      'quem ve o evento no calendario',
      'quem pode editar o evento',
      'liberar grupo no evento',
      'evento privado no calendario',
      'nivel visualizar ou editar',
      'quem sempre ve o evento',
    ],
    resposta:
      'São dois campos diferentes, de propósitos distintos. **Responsáveis** é só uma lista de pessoas ligadas ao evento (informativo, aparece na Lista/impressão). Já **"Quem vê / quem edita este evento"** controla a visibilidade de verdade: quem criou o evento e os administradores sempre veem e editam; sem nenhuma liberação nesse campo, mais ninguém enxerga o evento.\n\nAqui dá pra liberar pessoas **ou grupos** (cadastrados em Configurações → Acessos → Grupos), cada um com nível **Visualizar** ou **Editar** — liberar um grupo libera todo mundo que está nele de uma vez, sem precisar adicionar pessoa por pessoa.',
    relacionados: ['calendario-criar-evento-basico', 'config-acessos-grupos'],
  },
  {
    id: 'calendario-evento-categoria-anexos-acoes',
    modulo: 'calendario',
    tela: 'Calendário — Editar evento',
    titulo: 'Categoria, anexos, comentários e as ações de duplicar/excluir/imprimir',
    rota: '/calendario',
    perguntas: [
      'categoria do evento em detalhes avancados',
      'criar categoria nova no evento',
      'anexar arquivo no evento',
      'quantos anexos por evento',
      'comentar no evento',
      'duplicar evento',
      'excluir evento do calendario',
      'imprimir um evento especifico',
      'exportar pdf de um evento',
    ],
    resposta:
      'O campo **Categoria** fica dentro de "Detalhes avançados" (recolhido por padrão, abre sozinho se o evento já tiver uma categoria) — dá pra escolher uma existente ou cadastrar uma nova sem sair do formulário. **Anexos** (só em evento já salvo) aceita até 5 arquivos de até 8MB cada; **Comentários** é uma lista simples de mensagens com autor e data, mais um campo pra escrever uma nova.\n\nNo rodapé do formulário, pra evento já salvo e com permissão de editar: **Duplicar** cria uma cópia do evento, e **Excluir** apaga em definitivo (pede confirmação). O link **Imprimir/Exportar PDF** abre uma página separada só com aquele evento (título, status, prazo, categoria, prioridade, descrição, grade de variações se houver, produto vinculado, responsáveis e os campos do modelo) — separada do modal pra não imprimir a tela toda por trás dele.',
    relacionados: ['calendario-criar-evento-basico', 'calendario-evento-responsaveis-visibilidade'],
  },
  {
    id: 'calendario-modelos-customizados',
    modulo: 'calendario',
    tela: 'Modelos do Calendário',
    titulo: 'Modelos do Calendário — criar campos extras customizados',
    rota: '/calendario/modelos',
    perguntas: [
      'modelos do calendario',
      'criar modelo de evento',
      'tipos de campo do modelo',
      'campo tipo lista de opcoes',
      'fonte das opcoes do campo select',
      'campo obrigatorio no modelo',
      'ativar ou desativar modelo',
      'modelo corte e meta sao fixos',
      'so admin acessa modelos',
      'cadastrar novo modelo de evento pro calendario',
    ],
    resposta:
      'A tela **Modelos do Calendário** (só pra administrador) cadastra modelos customizados, além dos dois fixos (Corte e Meta, que não têm edição de campos aqui — só o alternador de ativo/inativo). Cada modelo tem um nome e uma lista de campos, cada campo com nome, tipo (Texto, Número, Data, Sim/Não, Lista de opções ou Grade de variação) e se é obrigatório.\n\nNo tipo **Lista de opções**, a fonte pode ser uma lista personalizada digitada na hora (uma opção por linha) ou uma fonte pronta do sistema — Cores/Tamanhos do estoque, Fornecedores, Categorias de calendário ou Responsáveis — que se atualiza sozinha se a lista de origem mudar, sem precisar editar o modelo de novo. O tipo **Grade de variação** não pede configuração extra: só liga o toggle "Detalhar por variação" no formulário do evento desse modelo. Desativar um modelo (toggle) o tira da lista de escolha ao criar evento novo, sem apagar os eventos que já usam ele.',
    relacionados: ['calendario-evento-grade-variacoes', 'calendario-evento-corte-meta'],
  },
];
