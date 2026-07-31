import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Shirt, Package, Settings, Landmark, Percent, Factory, Upload,
  FlaskConical, LayoutDashboard, Boxes, FileText, LogOut, List as ListIcon,
  Warehouse, Barcode, Tags, Printer, Users, ClipboardList,
} from 'lucide-react';
import { api } from '../api/client';

const MODULES = [
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
    color: 'var(--leather)',
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
    key: 'config',
    label: 'Configurações',
    icon: Settings,
    color: 'var(--warning)',
    pages: [
      { to: '/configuracoes', label: 'Parâmetros', icon: Settings },
      { to: '/empresas', label: 'Empresas', icon: Landmark },
      { to: '/listas', label: 'Listas', icon: ListIcon },
      { to: '/taxas-venda', label: 'Taxas de Venda', icon: Percent },
      { to: '/custos-indiretos', label: 'Custos Indiretos', icon: Factory },
    ],
  },
];

function findActiveModule(pathname) {
  for (const mod of MODULES) {
    for (const page of mod.pages) {
      if (pathname === page.to || pathname.startsWith(`${page.to}/`)) return mod;
    }
  }
  return MODULES[0];
}

export default function Shell({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const activeModule = findActiveModule(location.pathname);

  async function handleLogout() {
    await api.post('/auth/logout', {});
    navigate('/login');
  }

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand">
          <div className="brand-mark"><Shirt size={20} /></div>
          <div>
            <div className="brand-name">Formação de Preço</div>
            <div className="brand-sub">Miss Manu · Origem · Hoggar · Hebron</div>
          </div>
        </div>
        <div className="header-actions">
          <button className="logout-btn" onClick={handleLogout}>
            <LogOut size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
            Sair
          </button>
        </div>
      </header>

      <div className="shell-body">
        <nav className="shell-sidebar">
          {MODULES.map((mod) => {
            const Icon = mod.icon;
            const isActive = mod.key === activeModule.key;
            return (
              <button
                key={mod.key}
                type="button"
                className={'sidebar-module' + (isActive ? ' active' : '')}
                style={{ '--module-color': mod.color }}
                onClick={() => navigate(mod.pages[0].to)}
              >
                <Icon size={17} />
                <span>{mod.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="shell-content">
          <div className="shell-submenu">
            {activeModule.pages.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/estoque'}
                className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
              >
                <Icon size={15} />
                {label}
              </NavLink>
            ))}
          </div>

          <main className="shell-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
