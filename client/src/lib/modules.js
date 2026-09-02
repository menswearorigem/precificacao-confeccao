import {
  Package, Settings, Landmark, Percent, Factory, Upload,
  FlaskConical, LayoutDashboard, Boxes, FileText, List as ListIcon,
  Warehouse, Barcode, Tags, Printer, Users, ClipboardList, ShoppingCart,
  Truck, BarChart3, ShieldCheck, Plug, TrendingUp, ReceiptText, Store, Plane,
  LineChart, SearchCheck, Layers, AlertTriangle, CalendarDays, UsersRound,
  LayoutTemplate,
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
    ],
  },
  {
    key: 'estoque',
    label: 'Estoque',
    icon: Warehouse,
    color: 'var(--brass)',
    pages: [
      { to: '/estoque', label: 'Estoque', icon: Warehouse },
      { to: '/estoque/bipagem', label: 'Bipagem', icon: Barcode },
      { to: '/estoque/importacao', label: 'Importar Saldo', icon: Upload },
      { to: '/estoque/ean', label: 'Importar EAN', icon: Tags },
      { to: '/estoque/ficha', label: 'Ficha de Estoque', icon: Printer },
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
    pages: [
      { to: '/marketplace/pedidos', label: 'Pedidos', icon: ClipboardList },
      { to: '/marketplace/lucratividade', label: 'Lucratividade', icon: TrendingUp },
      { to: '/marketplace/metricas', label: 'Métricas', icon: LineChart },
      { to: '/marketplace/taxas', label: 'Taxas Cobradas', icon: ReceiptText },
      { to: '/marketplace/importar-pedidos', label: 'Importar Pedidos', icon: Upload },
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
      { to: '/compras', label: 'Compras', icon: ShoppingCart },
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
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/ficha-precificacao', label: 'Ficha de Precificação', icon: FileText },
      { to: '/alertas', label: 'Central de Alertas', icon: AlertTriangle },
      { to: '/simulador', label: 'Simulador', icon: FlaskConical },
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
    pages: [
      { to: '/configuracoes', label: 'Parâmetros', icon: Settings },
      { to: '/empresas', label: 'Empresas', icon: Landmark },
      { to: '/custos-indiretos', label: 'Custos Indiretos', icon: Factory },
      { to: '/taxas', label: 'Taxas', icon: Percent },
      { to: '/listas', label: 'Listas', icon: ListIcon },
      { to: '/configuracoes/marketplace', label: 'Produtos de Marketplace', icon: Store },
      // NÃO é adminOnly (diferente da extinta aba "Usuários", que era):
      // Grupos nunca precisou de admin (backend exige só o módulo
      // "configuracoes"), e a fusão não pode tirar esse acesso de quem não
      // é admin — a sub-aba Usuários fica escondida pra quem não é admin
      // dentro do próprio AcessosPage.jsx, não aqui.
      { to: '/acessos', label: 'Acessos', icon: ShieldCheck },
      { to: '/integracoes', label: 'Integrações', icon: Plug, adminOnly: true },
      { to: '/saude-dados', label: 'Saúde dos Dados', icon: Layers, adminOnly: true },
    ],
  },
  {
    key: 'calendario',
    label: 'Calendário',
    icon: CalendarDays,
    color: 'var(--leather)',
    pages: [
      { to: '/calendario', label: 'Calendário', icon: CalendarDays },
      { to: '/calendario/modelos', label: 'Modelos', icon: LayoutTemplate, adminOnly: true },
    ],
  },
];

export function getVisibleModules(user) {
  const isAdmin = user?.role === 'admin';
  return MODULES
    .filter((mod) => isAdmin || user?.modulos?.includes(mod.key))
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
