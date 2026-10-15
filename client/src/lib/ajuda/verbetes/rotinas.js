// Verbetes do módulo Rotinas (15/10/2026) — Meu dia (/rotinas), a tela da
// tarefa (/rotinas/tarefa/:id, sem rota fixa navegável — os verbetes apontam
// para /rotinas), Equipe (/rotinas/equipe) e Modelos (/rotinas/modelos), as
// duas últimas só de administrador.

export const verbetesRotinas = [
  {
    id: 'rotinas-como-criar',
    modulo: 'rotinas',
    adminOnly: true,
    tela: 'Rotinas — Modelos',
    titulo: 'Como criar uma rotina',
    rota: '/rotinas/modelos',
    perguntas: [
      'como criar uma rotina',
      'como passar tarefa para a equipe',
      'nova rotina',
      'tarefa que repete',
      'como programar tarefa todo dia',
      'tarefa avulsa',
      'como escolher produtos na tarefa',
      'lista automatica de produtos',
      'conferir depois',
      'tarefa varias vezes no dia',
      'responder o chat 4 vezes',
      'como pedir foto na tarefa',
    ],
    resposta:
      'Em **Rotinas › Modelos**, toque em **Nova rotina** (só administrador). O formulário tem quatro blocos:\n\n1. **O que fazer** — título, a instrução escrita (com negrito, listas e link), o porquê da tarefa, o setor, marca/canal e links ou imagens de apoio.\n2. **Produtos** (opcional) — **Lista fixa** (busca por referência, nome ou SKU; escolha a referência inteira ou só algumas variantes) ou **Lista automática** (um filtro como "Origem + curva A", que pega os produtos certos no dia em que cada tarefa nasce — a tela mostra quanto dá hoje).\n3. **Passos** — cada passo tem um tipo de resposta (marcar feito, sim/não, OK/problema, número, texto, escolha, foto), pode **repetir para cada produto**, ser obrigatório e pedir **foto de prova**: nunca, sempre ou **só se der problema**. Em número dá para definir a faixa esperada ou comparar com o **estoque do sistema** com tolerância.\n4. **Quem, quando e prioridade** — as pessoas (cada um faz a sua ou qualquer um resolve), quando repete (dia útil, dias da semana, a cada N semanas, mensal, uma vez), **várias vezes no dia** (ex.: chat às 9h, 12h, 15h e 18h — cada horário vira uma tarefa), horário limite, prioridade, **conferir depois**, a **correção automática** quando der problema e o aviso antes do prazo.\n\nAntes de salvar, confira as **próximas datas** que aparecem embaixo de "Quando". **Salvar e criar a de hoje agora** já põe a tarefa no Meu dia. Para uma tarefa de um dia só, use **Tarefa avulsa** (na Equipe ou nos Modelos). Editar uma rotina muda só as próximas tarefas.',
    relacionados: ['rotinas-como-concluir', 'rotinas-como-conferir'],
  },
  {
    id: 'rotinas-como-concluir',
    modulo: 'rotinas',
    tela: 'Rotinas — Meu dia',
    titulo: 'Como concluir uma tarefa',
    rota: '/rotinas',
    perguntas: [
      'como concluir uma tarefa',
      'meu dia',
      'minhas tarefas',
      'tarefa atrasada',
      'nao consigo concluir',
      'falta responder',
      'como tirar foto na tarefa',
      'nao consegui fazer a tarefa',
      'tarefa devolvida',
      'o que tenho para fazer hoje',
    ],
    resposta:
      'Abra **Rotinas › Meu dia**: em cima ficam **Atrasadas**, **Para hoje** e **Feitas**; a lista vem com as atrasadas primeiro, depois pelo prazo. Toque na tarefa para ler a instrução, ver os produtos (com foto, estoque e endereço) e responder os passos. **Cada resposta é salva na hora** — dá para sair e voltar.\n\nQuando o passo pede foto, toque em **Foto**: o celular reduz a imagem antes de enviar. Se o passo é "foto só se der problema", ela é pedida quando a resposta for **Não**, **Problema** ou um número fora do esperado.\n\nToque em **Concluir**. Se faltar algo obrigatório, a tela marca em vermelho o que falta e por quê. Se não deu para fazer, use **Não consegui fazer** e escolha o motivo. Tarefa **devolvida** pelo administrador volta para o Meu dia com o comentário dele. Tarefa de **qualquer um da equipe** fica com quem responder primeiro.',
    relacionados: ['rotinas-como-criar', 'rotinas-como-conferir'],
  },
  {
    id: 'rotinas-como-conferir',
    modulo: 'rotinas',
    adminOnly: true,
    tela: 'Rotinas — Equipe',
    titulo: 'Como conferir uma tarefa',
    rota: '/rotinas/equipe',
    perguntas: [
      'como conferir uma tarefa',
      'aprovar tarefa',
      'devolver tarefa',
      'quem fez o que',
      'tarefas da equipe',
      'aguardando conferencia',
      'tarefa com problema',
      'taxa no prazo da equipe',
      'rotinas deste produto',
    ],
    resposta:
      'Em **Rotinas › Equipe** (só administrador) ficam os chips de cada pessoa com o **% do dia concluído** (toque para filtrar) e três painéis: **Atrasadas**, **Aguardando conferência** e **Com problema hoje** — o botão de cada um filtra a tabela.\n\nToque numa linha para abrir a tarefa ao lado: tudo o que foi respondido, as fotos (toque para ampliar) e os botões **Aprovar** ou **Devolver** — devolver pede um comentário, que a pessoa vê no Meu dia dela.\n\nNo seletor **Hoje / 7 dias / 30 dias** aparece a **taxa de conclusão no prazo** por pessoa e por rotina (pior primeiro; tocar numa rotina filtra a tabela). O sino também avisa quando há tarefa esperando conferência ou atrasada.',
    relacionados: ['rotinas-como-criar', 'rotinas-como-concluir'],
  },
];
