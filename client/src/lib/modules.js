import {
  Package, Settings, Landmark, Percent, Factory, Upload,
  FlaskConical, LayoutDashboard, Boxes, FileText, List as ListIcon,
  Warehouse, Barcode, Tags, Printer, Users, ClipboardList, ShoppingCart,
  Truck, BarChart3, ShieldCheck, Plug, TrendingUp, ReceiptText, Store, Plane,
  LineChart, Layers, AlertTriangle, CalendarDays,
  LayoutTemplate, Wallet, ArrowLeftRight, Scale, ScanLine, Tag, Timer,
  Banknote, MapPin, Gauge, PackageCheck, FileSpreadsheet,
  Inbox, Radar, Megaphone, Scissors, PackageOpen, HeartPulse, Calculator,
  BookUser, Send} from 'lucide-react';

/* ---------------------------------------------------------------------------
 * NAVEGAÇÃO EM TRÊS NÍVEIS (14/09/2026)
 *
 * O que mudou e por quê. A varredura rodou o sistema com dados reais e mediu
 * a barra de abas de cada módulo em 1600, 1366 e 1280 px. Resultado:
 *
 *   Estoque        11 abas · precisa de 1596 px · a barra tem 1404 px
 *   Marketplace    12 abas · precisa de 1517 px
 *   Financeiro     11 abas · precisa de 1594 px
 *   Configurações  11 abas · precisa de 1452 px
 *
 * Ou seja: em 1600 px, QUATRO módulos escondiam de 2 a 3 abas fora da borda
 * direita. Em 1366 px (o notebook comum da casa) some até CINCO — entre elas
 * "Caixa de Entrada" e "Cobertura", que são justamente as telas de pendência
 * do Financeiro. A barra tem `overflow-x: auto`, mas não há seta, sombra nem
 * qualquer sinal de que existe mais coisa: na prática a tela não existe para
 * quem não sabe que ela existe.
 *
 * A correção não foi apagar tela nenhuma. Foi agrupar: cada módulo passa a ter
 * de 1 a 5 ENTRADAS de menu, e a entrada que reúne mais de uma tela abre uma
 * segunda fileira, menor, com as telas de dentro. Nenhuma rota mudou, nenhuma
 * tela foi removida, nenhuma chave de permissão foi criada ou alterada
 * (REGRA 4) — `pages` continua sendo a lista achatada de sempre, e é ela que
 * getVisibleModules / canAccessPath / getDefaultPath continuam usando.
 *
 * De 78 entradas de primeiro nível para 42. Nenhum módulo passa de 5.
 *
 * O critério do agrupamento é um só: telas que respondem A MESMA PERGUNTA por
 * ângulos diferentes ficam juntas. "Endereços", "Depósitos" e "Disponível"
 * respondem *onde está o saldo*; "Faltando", "Sobrando" e "Curva de tamanho"
 * respondem *tenho peça de menos ou de mais*. Eram seis abas concorrendo entre
 * si — e duas delas chegavam a dar números diferentes para a mesma pergunta
 * sem nada na tela reconciliando.
 * ------------------------------------------------------------------------- */

export const MODULES = [
  {
    key: 'produto',
    label: 'Produto',
    icon: Package,
    color: 'var(--terracotta)',
    entradas: [
      { to: '/produtos', label: 'Produtos', icon: Package },
      { to: '/kits', label: 'Kits', icon: Boxes },
      // Importar Produtos, Importar em Massa e Ficha Técnica eram três abas de
      // primeiro nível. As três só se usam de vez em quando (carga de planilha
      // e impressão de PDF) e as duas primeiras têm até o mesmo título dentro
      // da tela ("Importação em Massa"). Viram uma entrada só.
      {
        label: 'Importar e imprimir',
        icon: Upload,
        paginas: [
          { to: '/importacao', label: 'Importar Produtos', icon: Upload },
          { to: '/importacao-massa', label: 'Importar em Massa', icon: FileSpreadsheet },
          { to: '/ficha-tecnica', label: 'Ficha Técnica', icon: FileText },
        ],
      },
    ],
  },
  {
    key: 'estoque',
    label: 'Estoque',
    icon: Warehouse,
    color: 'var(--brass)',
    entradas: [
      { to: '/estoque', label: 'Estoque', icon: Warehouse },
      // Bipagem fica sozinha de propósito: é a única tela deste módulo que se
      // usa EM PÉ, no galpão, e não pode custar dois cliques.
      { to: '/estoque/bipagem', label: 'Bipagem', icon: Barcode },
      // As três respondem "onde está o saldo": pelo endereço na prateleira,
      // pelo depósito com nome, e pelo que ainda pode ser vendido. Estavam
      // separadas e chegavam a exibir o MESMO número com nomes diferentes
      // (-5.834 aparecia como "Disponível para vender" numa e "Peças fora do
      // mapa" na outra, uma com alerta e a outra sem).
      {
        label: 'Onde Está',
        icon: MapPin,
        paginas: [
          { to: '/estoque/locais', label: 'Endereços', icon: MapPin },
          { to: '/estoque/depositos', label: 'Depósitos', icon: ArrowLeftRight },
          { to: '/estoque/reserva', label: 'Disponível para vender', icon: PackageOpen },
        ],
      },
      // As três respondem "tenho peça de menos ou de mais". Cobertura já
      // classifica "parado e sobrando", que é literalmente o assunto da aba
      // vizinha Dinheiro Parado — e as duas davam valores diferentes.
      {
        label: 'Reposição',
        icon: Timer,
        paginas: [
          { to: '/estoque/cobertura', label: 'Faltando', icon: Timer },
          { to: '/estoque/parado', label: 'Sobrando', icon: Banknote },
          { to: '/estoque/curva-tamanho', label: 'Curva de tamanho', icon: BarChart3 },
        ],
      },
      {
        label: 'Importar e imprimir',
        icon: Upload,
        paginas: [
          { to: '/estoque/importacao', label: 'Importar Saldo', icon: Upload },
          { to: '/estoque/ean', label: 'Importar EAN', icon: Tags },
          { to: '/estoque/ficha', label: 'Ficha de Estoque', icon: Printer },
        ],
      },
    ],
  },
  {
    key: 'producao',
    label: 'Produção',
    icon: Factory,
    color: 'var(--leather-dark)',
    tambemPor: ['estoque'],
    entradas: [
      { to: '/producao', label: 'Ordens de Produção', icon: Factory },
      { to: '/producao/ordens-servico', label: 'Ordens de Serviço', icon: ClipboardList },
      { to: '/producao/movimentacao', label: 'Movimentação', icon: ArrowLeftRight },
      // As três respondem "vou conseguir entregar?": em peça pronta, em
      // tecido e em minuto de facção. Mesmo horizonte, mesmo filtro de
      // período, mesma conta de suficiência.
      {
        label: 'Planejamento',
        icon: PackageCheck,
        paginas: [
          { to: '/producao/projecao', label: 'Projeção de Estoque', icon: PackageCheck },
          { to: '/producao/materia-prima', label: 'Matéria-Prima', icon: Scissors },
          { to: '/producao/carga', label: 'Carga e Gargalo', icon: Gauge },
        ],
      },
    ],
  },
  {
    key: 'vendas',
    label: 'Vendas',
    icon: ClipboardList,
    color: 'var(--info)',
    entradas: [
      { to: '/pedidos', label: 'Pedidos de Venda', icon: ClipboardList },
      { to: '/clientes', label: 'Clientes', icon: Users },
      { to: '/ficha-venda', label: 'Ficha de Venda', icon: Printer },
      // Métricas responde "quanto vendi", Lucratividade "quanto sobrou" e
      // Publicidade é o formulário de UM campo da Lucratividade (o próprio
      // subtítulo da tela diz isso). São o mesmo fechamento.
      {
        label: 'Resultado',
        icon: TrendingUp,
        paginas: [
          { to: '/vendas/metricas', label: 'Métricas', icon: LineChart },
          { to: '/vendas/lucratividade', label: 'Lucratividade', icon: TrendingUp },
          { to: '/vendas/despesas', label: 'Publicidade e Despesas', icon: Megaphone },
        ],
      },
    ],
  },
  {
    key: 'marketplace',
    label: 'Marketplace',
    icon: Store,
    color: 'var(--plum)',
    entradas: [
      // Etiqueta, conferência e romaneio são a MESMA meia hora da expedição,
      // na ordem em que acontecem: imprime a etiqueta, bipa a caixa, fecha o
      // papel que o motorista assina. Eram três abas separadas, cada uma com
      // as suas próprias sub-abas.
      {
        label: 'Expedição',
        icon: Send,
        paginas: [
          { to: '/marketplace/etiquetas', label: 'Etiquetas', icon: Printer },
          { to: '/marketplace/conferencia', label: 'Conferência', icon: ScanLine },
          { to: '/marketplace/romaneio', label: 'Romaneio', icon: ClipboardList },
        ],
      },
      { to: '/marketplace/pedidos', label: 'Pedidos', icon: ClipboardList },
      {
        label: 'Catálogo',
        icon: Store,
        paginas: [
          { to: '/marketplace/anuncios', label: 'Anúncios', icon: Store },
          { to: '/marketplace/promocoes', label: 'Promoções', icon: Tag },
          { to: '/marketplace/full', label: 'Full', icon: Warehouse },
        ],
      },
      {
        label: 'Resultado',
        icon: TrendingUp,
        paginas: [
          { to: '/marketplace/lucratividade', label: 'Lucratividade', icon: TrendingUp },
          { to: '/marketplace/metricas', label: 'Métricas', icon: LineChart },
          { to: '/marketplace/taxas', label: 'Taxas Cobradas', icon: ReceiptText },
        ],
      },
      {
        label: 'Quando falta algo',
        icon: HeartPulse,
        paginas: [
          { to: '/marketplace/saude', label: 'Saúde da Sincronização', icon: HeartPulse },
          { to: '/marketplace/importar-pedidos', label: 'Importar Pedidos', icon: Upload },
        ],
      },
    ],
  },
  {
    key: 'financeiro',
    label: 'Financeiro',
    icon: Wallet,
    color: 'var(--success)',
    entradas: [
      // Pagar e Receber tinham DUAS abas para o que é um alternador de dois
      // estados: mesmos filtros, mesmos quatro cartões, mesmas onze colunas,
      // mesma paginação. Só muda o sinal.
      {
        label: 'Títulos',
        icon: ReceiptText,
        paginas: [
          { to: '/financeiro/pagar', label: 'Contas a Pagar', icon: ReceiptText },
          { to: '/financeiro/receber', label: 'Contas a Receber', icon: Banknote },
        ],
      },
      // A Conciliação exige escolher uma conta antes de mostrar qualquer
      // coisa — e a tela que cadastra conta era outra aba.
      {
        label: 'Bancos',
        icon: Landmark,
        paginas: [
          { to: '/financeiro/contas-bancarias', label: 'Contas Bancárias', icon: Landmark },
          { to: '/financeiro/conciliacao-bancaria', label: 'Conciliação Bancária', icon: Scale },
        ],
      },
      // As três primeiras abas do módulo eram outro produto convivendo no
      // mesmo menu: a conciliação do repasse de marketplace, com filtro de
      // plataforma e loja, título "Financeiro" repetido e uma fileira de
      // pílulas que duplicava as próprias abas. Agora é UMA entrada.
      {
        label: 'Repasses de Marketplace',
        icon: ArrowLeftRight,
        paginas: [
          { to: '/financeiro/movimentacao', label: 'Movimentação', icon: Wallet },
          { to: '/financeiro/repasses', label: 'Repasses', icon: ArrowLeftRight },
          { to: '/financeiro/conferencia', label: 'Conferência', icon: Scale },
        ],
      },
      {
        label: 'Resultado',
        icon: BarChart3,
        paginas: [
          { to: '/financeiro/fluxo-caixa', label: 'Fluxo de Caixa', icon: LineChart },
          { to: '/financeiro/dre', label: 'DRE Gerencial', icon: BarChart3 },
        ],
      },
      // A ação principal da Cobertura é literalmente "Trazer tudo para a
      // Caixa de Entrada". São as duas pontas do mesmo fluxo, e as duas eram
      // exatamente as abas que sumiam na borda direita em 1366 px.
      {
        label: 'Pendências',
        icon: Inbox,
        paginas: [
          { to: '/financeiro/entradas', label: 'Caixa de Entrada', icon: Inbox },
          { to: '/financeiro/cobertura', label: 'Cobertura', icon: Radar },
        ],
      },
    ],
  },
  {
    key: 'viagens',
    label: 'Viagens',
    icon: Plane,
    color: 'var(--teal)',
    entradas: [
      { to: '/viagens', label: 'Viagens', icon: Plane },
    ],
  },
  {
    key: 'compras',
    label: 'Compras',
    icon: ShoppingCart,
    color: 'var(--danger)',
    entradas: [
      {
        label: 'Compras',
        icon: ShoppingCart,
        paginas: [
          { to: '/compras', label: 'Visão Geral', icon: ShoppingCart },
          { to: '/compras/relatorio', label: 'Relatório', icon: BarChart3 },
        ],
      },
      // É o MESMO documento andando: pergunto o preço, me comprometo com o
      // pedido, confiro o que chegou. Os mesmos números de pedido apareciam
      // nas três abas e ninguém via o caminho inteiro de uma vez.
      {
        label: 'Pedidos de Compra',
        icon: ClipboardList,
        paginas: [
          { to: '/compras/cotacoes', label: 'Cotações', icon: Scale },
          { to: '/compras/pedidos', label: 'Pedidos', icon: ClipboardList },
          { to: '/compras/recebimentos', label: 'Recebimentos', icon: PackageCheck },
        ],
      },
      { to: '/compras/insumos', label: 'Insumos e Notas', icon: Package },
      { to: '/fornecedores', label: 'Fornecedores', icon: Truck },
    ],
  },
  {
    key: 'analises',
    label: 'Análises',
    icon: LayoutDashboard,
    color: 'var(--success)',
    entradas: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/alertas', label: 'Central de Alertas', icon: AlertTriangle },
      // As três abriam com o MESMO seletor "Selecione uma referência…" e
      // ~80% de tela vazia até alguém escolher. Agora se escolhe uma vez e
      // troca-se de ângulo sem voltar ao começo.
      {
        label: 'Preço',
        icon: Tags,
        paginas: [
          { to: '/ficha-precificacao', label: 'Ficha de Precificação', icon: FileText },
          { to: '/analises/preco-por-canal', label: 'Preço por Canal', icon: Tags },
          { to: '/simulador', label: 'Simulador', icon: FlaskConical },
        ],
      },
      { to: '/analises/mix-tributario', label: 'Mix B2B × B2C', icon: Scale },
    ],
  },
  {
    key: 'calendario',
    label: 'Calendário',
    icon: CalendarDays,
    color: 'var(--leather)',
    entradas: [
      { to: '/calendario', label: 'Calendário', icon: CalendarDays },
      { to: '/calendario/modelos', label: 'Modelos', icon: LayoutTemplate, adminOnly: true },
    ],
  },
  {
    key: 'configuracoes',
    label: 'Configurações',
    icon: Settings,
    color: 'var(--warning)',
    entradas: [
      // Os três já eram rotulados como grupo "Cálculo" no submenu; agora são
      // uma entrada só, como o rótulo sempre prometeu.
      {
        label: 'Cálculo',
        icon: Calculator,
        paginas: [
          { to: '/configuracoes', label: 'Parâmetros', icon: Settings },
          { to: '/custos-indiretos', label: 'Custos Indiretos', icon: Factory },
          { to: '/taxas', label: 'Taxas', icon: Percent },
        ],
      },
      {
        label: 'Cadastros',
        icon: BookUser,
        paginas: [
          { to: '/listas', label: 'Listas', icon: ListIcon },
          { to: '/configuracoes/marketplace', label: 'Produtos de Marketplace', icon: Store },
          { to: '/configuracoes/vendedores', label: 'Vendedores', icon: Users },
          { to: '/configuracoes/tabelas-preco', label: 'Tabelas de Preço', icon: Tags },
        ],
      },
      { to: '/empresas', label: 'Empresas', icon: Landmark },
      { to: '/acessos', label: 'Acessos', icon: ShieldCheck },
      // As duas respondem "está tudo certo com os dados e as conexões?" e as
      // duas eram abas que não cabiam na barra.
      {
        label: 'Integrações e Saúde',
        icon: Plug,
        paginas: [
          { to: '/integracoes', label: 'Integrações', icon: Plug, adminOnly: true },
          { to: '/saude-dados', label: 'Saúde dos Dados', icon: Layers, adminOnly: true },
        ],
      },
    ],
  },
];

// Achata `entradas` em `pages` — a lista linear que o resto do sistema já
// usava antes deste agrupamento. Fazer isso aqui, e não em cada consumidor, é
// o que garante que a mudança de menu NÃO mexeu em permissão: `canAccessPath`
// e `getDefaultPath` continuam vendo exatamente a mesma lista de rotas, na
// mesma ordem.
function achatar(entradas) {
  const paginas = [];
  for (const entrada of entradas) {
    if (entrada.paginas) {
      for (const p of entrada.paginas) paginas.push({ ...p, entrada: entrada.label });
    } else {
      paginas.push({ ...entrada });
    }
  }
  return paginas;
}

for (const mod of MODULES) {
  mod.pages = achatar(mod.entradas);
}

// Devolve, para um módulo já filtrado por permissão, as entradas de menu com
// as páginas que este usuário pode abrir — descartando a entrada que ficou
// sem nenhuma página (é o caso de "Integrações e Saúde" para quem não é
// administrador: as duas telas de dentro são adminOnly).
export function getEntradasVisiveis(mod, user) {
  const isAdmin = user?.role === 'admin';
  const entradas = [];
  for (const entrada of mod.entradas) {
    if (entrada.paginas) {
      const paginas = entrada.paginas.filter((p) => !p.adminOnly || isAdmin);
      if (paginas.length === 1) {
        // Sobrou uma só: vira entrada simples, para não abrir uma segunda
        // fileira com um item único (o defeito LAY-08 do relatório antigo).
        entradas.push({ ...paginas[0], grupoLabel: entrada.label });
      } else if (paginas.length > 1) {
        entradas.push({ ...entrada, paginas });
      }
    } else if (!entrada.adminOnly || isAdmin) {
      entradas.push(entrada);
    }
  }
  return entradas;
}

// Quanto desta entrada "casa" com o caminho aberto — 0 quando não casa.
//
// Devolve o comprimento da rota que casou, e não um sim/não, por causa das
// rotas que são prefixo de outras: `/estoque` é prefixo de
// `/estoque/cobertura`, e `/compras` de `/compras/insumos`. Com um sim/não
// simples, estar em "Reposição" acenderia TAMBÉM a entrada "Estoque", e a
// primeira da lista venceria — a fileira de baixo sumiria e a pessoa ficaria
// sem saber em que tela está. Ganha a rota mais específica.
export function forcaDaEntrada(entrada, pathname) {
  const alvos = entrada.paginas ? entrada.paginas.map((p) => p.to) : [entrada.to];
  let maior = 0;
  for (const to of alvos) {
    if (pathname === to || pathname.startsWith(`${to}/`)) maior = Math.max(maior, to.length);
  }
  return maior;
}

// A entrada de menu que deve estar acesa: a de rota mais específica.
export function acharEntradaAtiva(entradas, pathname) {
  let melhor = null;
  let forca = 0;
  for (const entrada of entradas) {
    const f = forcaDaEntrada(entrada, pathname);
    if (f > forca) { forca = f; melhor = entrada; }
  }
  return melhor;
}

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
