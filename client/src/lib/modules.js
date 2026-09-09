import {
  Package, Settings, Landmark, Percent, Factory, Upload,
  FlaskConical, LayoutDashboard, Boxes, FileText, List as ListIcon,
  Warehouse, Barcode, Tags, Printer, Users, ClipboardList, ShoppingCart,
  Truck, BarChart3, ShieldCheck, Plug, TrendingUp, ReceiptText, Store, Plane,
  LineChart, SearchCheck, Layers, AlertTriangle, CalendarDays, UsersRound,
  LayoutTemplate, Wallet, ArrowLeftRight, Scale, ScanLine, Tag, Timer, Activity,
  Banknote, Ruler, MapPin, Gauge, Bookmark, PackageCheck, FileSpreadsheet,
} from 'lucide-react';

export const MODULES = [
  {
    key: 'produto',
    label: 'Produto',
    icon: Package,
    color: 'var(--terracotta)',
    pages: [
      { to: '/produtos', label: 'Produtos', icon: Package },
      { to: '/ficha-tecnica', label: 'Ficha Técnica', icon: FileText },
      { to: '/kits', label: 'Kits', icon: Boxes },
      { to: '/importacao', label: 'Importar Produtos', icon: Upload },
      // Importacao em massa (09/09/2026). Fica ao lado da importacao de ficha
      // de custo que ja' existia porque as duas respondem "trazer de fora" --
      // mas esta CRIA GRADE e ATUALIZA, que a outra nunca fez. Mesma chave
      // `produto`; nenhuma permissao nova (REGRA 4).
      { to: '/importacao-massa', label: 'Importar em Massa', icon: FileSpreadsheet },
    ],
  },
  {
    key: 'estoque',
    label: 'Estoque',
    icon: Warehouse,
    color: 'var(--brass)',
    // Grupos (09/09/2026). Eram 10 abas numa fileira lisa: nada distinguia a
    // tela aberta todo dia da tela aberta uma vez por mes. A ordem tambem
    // mudou -- Bipagem e "Onde Esta a Peca" sobem porque sao usadas EM PE, no
    // galpao, e estavam depois de duas telas de importacao. Nenhuma rota,
    // nenhum nome e nenhuma permissao mudou (REGRA 4): so' a ordem e o
    // rotulo do grupo.
    pages: [
      { to: '/estoque', label: 'Estoque', icon: Warehouse, grupo: 'Dia a dia' },
      { to: '/estoque/bipagem', label: 'Bipagem', icon: Barcode, grupo: 'Dia a dia' },
      // Onde Esta a Peca (08/09/2026): endereco no galpao e saldo por local.
      { to: '/estoque/locais', label: 'Onde Está a Peça', icon: MapPin, grupo: 'Dia a dia' },
      // Depositos e transferencia com aceite (09/09/2026). Fecha a trinca:
      // Cobertura olha o saldo pelo TEMPO, Onde Esta a Peca pela NATUREZA do
      // lugar, Reserva pelo que ainda PODE SER VENDIDO -- e esta, pelo LUGAR
      // com nome, que e' o que faltava para responder "quanto tem na
      // Expedicao?". Mesma chave `estoque` (o backend aceita `estoque` ou
      // `producao` em /api/depositos, como ja' faz em estoque-locais);
      // nenhuma permissao nova (REGRA 4).
      { to: '/estoque/depositos', label: 'Depósitos', icon: ArrowLeftRight, grupo: 'Dia a dia' },
      // Cobertura e Estoque Minimo (06/09/2026), Dinheiro Parado e Curva de
      // Tamanho (08/09/2026): as tres respondem sobre o MESMO saldo, mas pelo
      // lado da DECISAO -- quanto dura, quanto esta' preso, o que falta de
      // tamanho. Nenhuma delas se abre no meio de uma conferencia.
      { to: '/estoque/cobertura', label: 'Cobertura e Mínimo', icon: Timer, grupo: 'Para decidir' },
      { to: '/estoque/parado', label: 'Dinheiro Parado', icon: Banknote, grupo: 'Para decidir' },
      { to: '/estoque/curva-tamanho', label: 'Curva de Tamanho', icon: Ruler, grupo: 'Para decidir' },
      // Reserva de estoque (09/09/2026). Olha o MESMO saldo por mais um
      // angulo -- o que ainda PODE SER VENDIDO: saldo menos o que ja' esta'
      // reservado para pedido pago e nao separado. Mesmo modulo `estoque`
      // que o backend exige em /api/estoque-reserva; nenhuma chave de
      // permissao nova (REGRA 4).
      { to: '/estoque/reserva', label: 'Reserva de Estoque', icon: Bookmark, grupo: 'Para decidir' },
      { to: '/estoque/importacao', label: 'Importar Saldo', icon: Upload, grupo: 'Entradas e papel' },
      { to: '/estoque/ean', label: 'Importar EAN', icon: Tags, grupo: 'Entradas e papel' },
      { to: '/estoque/ficha', label: 'Ficha de Estoque', icon: Printer, grupo: 'Entradas e papel' },
    ],
  },
  {
    // Modulo proprio da Producao (08/09/2026, autorizado pela dona).
    //
    // Ate aqui a Producao morava dentro de Estoque, e a REGRA 4 nao deixava
    // criar chave nova sem ordem dela. O motivo de separar e' concreto: quem
    // toca corte, roteiro e faccao nao precisa -- e as vezes nao deve -- ver
    // o saldo do estoque inteiro nem a Ficha de Estoque.
    //
    // O backend aceita `producao` OU `estoque` na mesma rota, entao quem ja'
    // tinha estoque continua enxergando a Producao. A chave nova ACRESCENTA
    // um caminho de acesso; nao tira de ninguem.
    key: 'producao',
    label: 'Produção',
    icon: Factory,
    color: 'var(--leather-dark)',
    // Quem ja' tinha `estoque` continua vendo a Producao, igual ao backend.
    tambemPor: ['estoque'],
    pages: [
      { to: '/producao', label: 'Ordens de Produção', icon: Factory },
      // Movimentacao, O.S. de faccao e carga (09/09/2026). As tres entram no
      // modulo `producao` que ja' existe -- nenhuma chave de permissao nova
      // (REGRA 4). A ordem e' a da vida real: a peca anda, a faccao devolve, e
      // o gargalo aparece.
      { to: '/producao/movimentacao', label: 'Gerar Movimentação', icon: ArrowLeftRight },
      { to: '/producao/ordens-servico', label: 'Ordens de Serviço', icon: ClipboardList },
      { to: '/producao/carga', label: 'Carga e Gargalo', icon: Gauge },
    ],
  },
  {
    key: 'vendas',
    label: 'Vendas',
    icon: ClipboardList,
    color: 'var(--info)',
    pages: [
      { to: '/pedidos', label: 'Pedidos de Venda', icon: ClipboardList },
      { to: '/clientes', label: 'Clientes', icon: Users },
      { to: '/ficha-venda', label: 'Ficha de Venda', icon: Printer },
      { to: '/vendas/lucratividade', label: 'Lucratividade', icon: TrendingUp },
    ],
  },
  {
    key: 'marketplace',
    label: 'Marketplace',
    icon: Store,
    color: 'var(--plum)',
    // Grupos e ordem (09/09/2026). Conferencia e Pedidos sobem para o
    // comeco: sao as duas telas abertas TODO dia, e a Conferencia e' feita em
    // pe, no galpao. Anuncios e Promocoes formam o catalogo; Lucratividade,
    // Metricas e Taxas formam o resultado; Importar e Saude sao as telas que
    // so' se abrem quando alguma coisa parece faltar. Nenhuma rota mudou.
    pages: [
      { to: '/marketplace/conferencia', label: 'Conferência', icon: ScanLine, grupo: 'Dia a dia' },
      // Etiquetas (09/09/2026). Fica colada na Conferência de propósito: são
      // as duas telas da MESMA meia hora da expedição — imprime a etiqueta e
      // a lista de separação, depois bipa a caixa. Mesmo módulo `marketplace`
      // que o backend já exige em /api/etiquetas; nenhuma chave nova (REGRA 4).
      { to: '/marketplace/etiquetas', label: 'Etiquetas', icon: Printer, grupo: 'Dia a dia' },
      { to: '/marketplace/pedidos', label: 'Pedidos', icon: ClipboardList, grupo: 'Dia a dia' },
      { to: '/marketplace/anuncios', label: 'Anúncios', icon: Store, grupo: 'Catálogo' },
      // Promoções (06/09/2026): a mesma pergunta dos Anúncios ("como está o
      // meu catálogo na loja?") vista pelo lado do preço promocional.
      { to: '/marketplace/promocoes', label: 'Promoções', icon: Tag, grupo: 'Catálogo' },
      { to: '/marketplace/lucratividade', label: 'Lucratividade', icon: TrendingUp, grupo: 'Resultado' },
      { to: '/marketplace/metricas', label: 'Métricas', icon: LineChart, grupo: 'Resultado' },
      { to: '/marketplace/taxas', label: 'Taxas Cobradas', icon: ReceiptText, grupo: 'Resultado' },
      { to: '/marketplace/importar-pedidos', label: 'Importar Pedidos', icon: Upload, grupo: 'Quando falta algo' },
      // Saúde da Sincronização (07/09/2026): a tela que se abre quando alguma
      // coisa parece faltar, não a de uso diária.
      { to: '/marketplace/saude', label: 'Saúde da Sincronização', icon: Activity, grupo: 'Quando falta algo' },
    ],
  },
  {
    // Nono módulo (02/09/2026). Separado de Marketplace de propósito: quem
    // cuida do caixa precisa da movimentação da conta e NÃO precisa ver
    // custo de peça, margem nem ficha de precificação — dar o módulo
    // Marketplace pra alguém do financeiro abriria a Lucratividade junto.
    key: 'financeiro',
    label: 'Financeiro',
    icon: Wallet,
    color: 'var(--success)',
    pages: [
      { to: '/financeiro/movimentacao', label: 'Movimentação', icon: Wallet },
      { to: '/financeiro/repasses', label: 'Repasses', icon: ArrowLeftRight },
      { to: '/financeiro/conferencia', label: 'Conferência', icon: Scale },
      // Núcleo financeiro (09/09/2026): contas a pagar e a receber, extrato
      // bancário, fluxo de caixa e DRE. Entram no módulo `financeiro` que já
      // existe — nenhuma chave de permissão nova (REGRA 4). As três abas de
      // cima continuam sendo a conciliação do repasse de marketplace; estas
      // cinco são o financeiro da empresa inteira.
      { to: '/financeiro/pagar', label: 'Contas a Pagar', icon: ReceiptText },
      { to: '/financeiro/receber', label: 'Contas a Receber', icon: Banknote },
      { to: '/financeiro/conciliacao-bancaria', label: 'Conciliação Bancária', icon: Landmark },
      { to: '/financeiro/fluxo-caixa', label: 'Fluxo de Caixa', icon: LineChart },
      { to: '/financeiro/dre', label: 'DRE Gerencial', icon: BarChart3 },
    ],
  },
  {
    key: 'viagens',
    label: 'Viagens',
    icon: Plane,
    color: 'var(--teal)',
    pages: [
      { to: '/viagens', label: 'Viagens', icon: Plane },
    ],
  },
  {
    key: 'compras',
    label: 'Compras',
    icon: ShoppingCart,
    color: 'var(--danger)',
    pages: [
      // Insumos e Notas (06/09/2026): o cadastro de materia-prima e a
      // entrada por nota fiscal que alimenta o custo da peca.
      { to: '/compras/insumos', label: 'Insumos e Notas', icon: Package },
      { to: '/compras', label: 'Compras', icon: ShoppingCart },
      // Cotacao -> Pedido -> Recebimento (09/09/2026). Ficam nesta ordem de
      // proposito: e' a ordem em que a compra acontece na vida real -- pergunto
      // o preco, me comprometo com o pedido, confiro o que chegou. Todas dentro
      // do modulo `compras` que ja' existe; nenhuma permissao muda (REGRA 4).
      { to: '/compras/cotacoes', label: 'Cotações', icon: Scale },
      { to: '/compras/pedidos', label: 'Pedidos de Compra', icon: ClipboardList },
      { to: '/compras/recebimentos', label: 'Recebimentos', icon: PackageCheck },
      { to: '/compras/relatorio', label: 'Relatório', icon: BarChart3 },
      { to: '/fornecedores', label: 'Fornecedores', icon: Truck },
    ],
  },
  {
    key: 'analises',
    label: 'Análises',
    icon: LayoutDashboard,
    color: 'var(--success)',
    pages: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, grupo: 'Panorama' },
      { to: '/alertas', label: 'Central de Alertas', icon: AlertTriangle, grupo: 'Panorama' },
      { to: '/ficha-precificacao', label: 'Ficha de Precificação', icon: FileText, grupo: 'Preço' },
      // Preco por canal (08/09/2026): o preco que entrega a margem em cada
      // marketplace, com a taxa real de cada um. So' leitura -- nao grava
      // preco nenhum (REGRA 1).
      { to: '/analises/preco-por-canal', label: 'Preço por Canal', icon: Tags, grupo: 'Preço' },
      { to: '/simulador', label: 'Simulador', icon: FlaskConical, grupo: 'Preço' },
      // Mix B2B × B2C (07/09/2026). O número que embasa a decisão da opção
      // do Simples pelo regime regular de IBS/CBS — prazo em 30/09/2026.
      // Entra em Análises (leitura sobre faturamento já gravado) e não num
      // módulo novo: chave de módulo nova muda quem enxerga o quê, e a
      // REGRA 4 não deixa mexer nisso sem autorização.
      { to: '/analises/mix-tributario', label: 'Mix B2B × B2C', icon: Scale, grupo: 'Tributário' },
    ],
  },
  {
    // O Calendário vem ANTES de Configurações de propósito (04/09/2026): é
    // tela de uso diário — prazo de corte, meta, chegada de mercadoria — e
    // estava caindo depois de Configurações, que é tela de ajuste, aberta
    // uma vez por mês. Menu se ordena por frequência de uso, não por ordem
    // de nascimento do módulo.
    key: 'calendario',
    label: 'Calendário',
    icon: CalendarDays,
    color: 'var(--leather)',
    pages: [
      { to: '/calendario', label: 'Calendário', icon: CalendarDays },
      { to: '/calendario/modelos', label: 'Modelos', icon: LayoutTemplate, adminOnly: true },
    ],
  },
  {
    key: 'configuracoes',
    label: 'Configurações',
    icon: Settings,
    color: 'var(--warning)',
    // Redesenho de Configurações (Etapa 2, 28/08/2026): 11 abas -> 8, em 4
    // grupos lógicos (a ordem abaixo já segue os grupos, já que o Shell.jsx
    // renderiza esta lista linear sem cabeçalho de grupo — ver limitação
    // documentada no relatório da tarefa). getVisibleModules/canAccessPath
    // e as flags adminOnly não mudaram, só a apresentação.
    //   Cálculo: Parâmetros · Empresas · Custos Indiretos
    //   Taxas: 1 aba com sub-abas Venda/Marketplace (funde /taxas-venda +
    //          /marketplace-taxas, que agora só redirecionam — ver App.jsx)
    //   Cadastros: Listas
    //   Acesso e dados: Acessos (sub-abas Usuários/Grupos) · Integrações ·
    //          Saúde dos Dados (funde /conferencia-dados + /qualidade-dados)
    //
    // 09/09/2026: os quatro grupos abaixo existiam SÓ neste comentário — o
    // Shell renderizava a lista lisa. Agora cada página declara o seu grupo e
    // o submenu mostra o rótulo. Nenhuma rota, nenhum nome e nenhuma flag
    // adminOnly mudou.
    pages: [
      { to: '/configuracoes', label: 'Parâmetros', icon: Settings, grupo: 'Cálculo' },
      { to: '/empresas', label: 'Empresas', icon: Landmark, grupo: 'Cálculo' },
      { to: '/custos-indiretos', label: 'Custos Indiretos', icon: Factory, grupo: 'Cálculo' },
      { to: '/taxas', label: 'Taxas', icon: Percent, grupo: 'Taxas' },
      { to: '/listas', label: 'Listas', icon: ListIcon, grupo: 'Cadastros' },
      { to: '/configuracoes/marketplace', label: 'Produtos de Marketplace', icon: Store, grupo: 'Cadastros' },
      // NÃO é adminOnly (diferente da extinta aba "Usuários", que era):
      // Grupos nunca precisou de admin (backend exige só o módulo
      // "configuracoes"), e a fusão não pode tirar esse acesso de quem não
      // é admin — a sub-aba Usuários fica escondida pra quem não é admin
      // dentro do próprio AcessosPage.jsx, não aqui.
      { to: '/acessos', label: 'Acessos', icon: ShieldCheck, grupo: 'Acesso e dados' },
      { to: '/integracoes', label: 'Integrações', icon: Plug, adminOnly: true, grupo: 'Acesso e dados' },
      { to: '/saude-dados', label: 'Saúde dos Dados', icon: Layers, adminOnly: true, grupo: 'Acesso e dados' },
    ],
  },
];

// `tambemPor` (08/09/2026) existe por causa do modulo novo de Producao.
//
// O backend aceita `['producao', 'estoque']` na rota de Producao: a chave nova
// ACRESCENTA acesso, nao substitui. O menu tinha de contar a mesma historia --
// sem isto, quem tem `estoque` perderia a Producao do menu no primeiro deploy
// e `canAccessPath` bloquearia /producao, mesmo com a API respondendo. Menu e
// permissao discordando e' o tipo de defeito que ninguem reporta direito:
// aparece como "sumiu a tela".
export function getVisibleModules(user) {
  const isAdmin = user?.role === 'admin';
  const tem = (chave) => user?.modulos?.includes(chave);
  return MODULES
    .filter((mod) => isAdmin || tem(mod.key) || (mod.tambemPor || []).some(tem))
    .map((mod) => ({ ...mod, pages: mod.pages.filter((p) => !p.adminOnly || isAdmin) }));
}

// Primeira página que o usuário realmente pode acessar — usado pra saber
// pra onde mandar ele logo após o login, em vez de assumir "/produtos".
export function getDefaultPath(user) {
  const visible = getVisibleModules(user);
  return visible[0]?.pages[0]?.to || null;
}

// Confere se o usuário pode acessar esse caminho, pra bloquear navegação
// direta por URL a uma página fora dos módulos liberados pra ele (o backend
// já barra a chamada de API, mas sem isso a tela tentaria montar mesmo assim
// e quebraria com o erro 403 sem tratamento).
//
// /ajuda é a única exceção: a central de ajuda da Manu não pertence a
// nenhum módulo de propósito (ela mesma lê user.modulos por dentro, pra
// mostrar só o que cada um pode ver) e precisa ficar aberta pra qualquer
// usuário autenticado, não só quem tem módulo liberado. Isso não mexe em
// regra de permissão de módulo nenhuma — só libera essa única rota sem
// módulo, do mesmo jeito que /login já fica fora de toda essa guarda.
export function canAccessPath(user, pathname) {
  if (pathname === '/ajuda') return true;
  if (user?.role === 'admin') return true;
  const visible = getVisibleModules(user);
  return visible.some((mod) => mod.pages.some((p) => pathname === p.to || pathname.startsWith(`${p.to}/`)));
}
