import {
  Package, Settings, Landmark, Percent, Factory, Upload,
  FlaskConical, LayoutDashboard, Boxes, FileText, List as ListIcon,
  Warehouse, Barcode, Tags, Printer, Users, ClipboardList, ShoppingCart,
  Truck, BarChart3, ShieldCheck, Plug, TrendingUp, ReceiptText,
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
      { to: '/vendas/taxas-marketplace', label: 'Taxas de Marketplace', icon: ReceiptText },
      { to: '/vendas/importar-pedidos', label: 'Importar Pedidos', icon: Upload },
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
      { to: '/simulador', label: 'Simulador', icon: FlaskConical },
    ],
  },
  {
    key: 'configuracoes',
    label: 'Configurações',
    icon: Settings,
    color: 'var(--warning)',
    pages: [
      { to: '/configuracoes', label: 'Parâmetros', icon: Settings },
      { to: '/empresas', label: 'Empresas', icon: Landmark },
      { to: '/listas', label: 'Listas', icon: ListIcon },
      { to: '/taxas-venda', label: 'Taxas de Venda', icon: Percent },
      { to: '/marketplace-taxas', label: 'Taxas de Marketplace', icon: ReceiptText },
      { to: '/custos-indiretos', label: 'Custos Indiretos', icon: Factory },
      { to: '/usuarios', label: 'Usuários', icon: ShieldCheck, adminOnly: true },
      { to: '/integracoes', label: 'Integrações', icon: Plug, adminOnly: true },
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
export function canAccessPath(user, pathname) {
  if (user?.role === 'admin') return true;
  const visible = getVisibleModules(user);
  return visible.some((mod) => mod.pages.some((p) => pathname === p.to || pathname.startsWith(`${p.to}/`)));
}
