import { NavLink, useNavigate } from 'react-router-dom';
import {
  Shirt, Package, Settings, Landmark, Percent, Factory, Upload,
  FlaskConical, LayoutDashboard, Boxes, FileText, LogOut, List as ListIcon,
} from 'lucide-react';
import { api } from '../api/client';

const NAV_ITEMS = [
  { to: '/produtos', label: 'Produtos', icon: Package },
  { to: '/importacao', label: 'Importação', icon: Upload },
  { to: '/simulador', label: 'Simulador', icon: FlaskConical },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/kits', label: 'Kits', icon: Boxes },
  { to: '/ficha-tecnica', label: 'Ficha Técnica', icon: FileText },
  { to: '/configuracoes', label: 'Configurações', icon: Settings },
  { to: '/empresas', label: 'Empresas', icon: Landmark },
  { to: '/listas', label: 'Listas', icon: ListIcon },
  { to: '/taxas-venda', label: 'Taxas de Venda', icon: Percent },
  { to: '/custos-indiretos', label: 'Custos Indiretos', icon: Factory },
];

export default function Shell({ children }) {
  const navigate = useNavigate();

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

      <nav className="shell-nav">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
          >
            <Icon size={15} />
            {label}
          </NavLink>
        ))}
      </nav>

      <main className="shell-main">{children}</main>
    </div>
  );
}
