import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Shirt, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules } from '../lib/modules';

function findActiveModule(pathname, visibleModules) {
  for (const mod of visibleModules) {
    for (const page of mod.pages) {
      if (pathname === page.to || pathname.startsWith(`${page.to}/`)) return mod;
    }
  }
  return visibleModules[0] || null;
}

export default function Shell({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const visibleModules = getVisibleModules(user);
  const activeModule = findActiveModule(location.pathname, visibleModules);

  async function handleLogout() {
    await logout();
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
          {user && <span className="user-badge">{user.nome}</span>}
          <button className="logout-btn" onClick={handleLogout}>
            <LogOut size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
            Sair
          </button>
        </div>
      </header>

      <div className="shell-body">
        <nav className="shell-sidebar">
          {visibleModules.map((mod) => {
            const Icon = mod.icon;
            const isActive = activeModule && mod.key === activeModule.key;
            return (
              <button
                key={mod.key}
                type="button"
                className={'sidebar-module' + (isActive ? ' active' : '')}
                style={{ '--module-color': mod.color }}
                onClick={() => navigate(mod.pages[0].to)}
              >
                <span className="module-badge"><Icon size={16} /></span>
                <span className="module-label">{mod.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="shell-content">
          {activeModule ? (
            <>
              <div className="shell-submenu">
                {activeModule.pages.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === '/estoque' || to === '/compras'}
                    className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
                  >
                    <Icon size={15} />
                    {label}
                  </NavLink>
                ))}
              </div>

              <main className="shell-main">{children}</main>
            </>
          ) : (
            <main className="shell-main">
              <div className="page-wide">
                <div className="card" style={{ marginTop: 24 }}>
                  <h2>Sem acesso liberado</h2>
                  <p className="page-sub">
                    Sua conta ainda não tem acesso a nenhum módulo. Fale com um administrador
                    para liberar o que você precisa usar.
                  </p>
                </div>
              </div>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
