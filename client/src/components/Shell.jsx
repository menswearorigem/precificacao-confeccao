import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Menu, X, ChevronsLeft, ChevronsRight, Sun, Moon, Rows3, AlignJustify } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules } from '../lib/modules';
import { useTema } from '../lib/useTema';
import { useDensidade } from '../contexts/DensidadeContext';
import BuscaGlobal from './BuscaGlobal';
import logoHbnHub from '../assets/logo-hbn-hub.png';

const CHAVE_SIDEBAR_COLAPSADO = 'hbn_sidebar_colapsado';

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
  const { tema, setTema } = useTema();
  const densidadeCtx = useDensidade();
  const visibleModules = getVisibleModules(user);
  const activeModule = findActiveModule(location.pathname, visibleModules);
  const [menuAberto, setMenuAberto] = useState(false);
  const [sidebarColapsado, setSidebarColapsado] = useState(
    () => localStorage.getItem(CHAVE_SIDEBAR_COLAPSADO) === '1'
  );

  // fecha o menu (celular) sempre que troca de página, senão fica aberto
  // por cima do conteúdo novo.
  useEffect(() => { setMenuAberto(false); }, [location.pathname]);

  function alternarSidebar() {
    setSidebarColapsado((v) => {
      const novo = !v;
      localStorage.setItem(CHAVE_SIDEBAR_COLAPSADO, novo ? '1' : '0');
      return novo;
    });
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className={'shell' + (sidebarColapsado ? ' sidebar-colapsado' : '')}>
      <BuscaGlobal />
      <header className="shell-header">
        <div className="brand">
          <button className="mobile-menu-btn" onClick={() => setMenuAberto((v) => !v)} aria-label="Abrir menu">
            {menuAberto ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="brand-mark"><img src={logoHbnHub} alt="" /></div>
          <div>
            <div className="brand-name">HBN Hub</div>
            <div className="brand-sub">Miss Manu · Origem · Hoggar · Hebron</div>
          </div>
        </div>
        <div className="header-actions">
          {densidadeCtx && (
            <button
              type="button"
              className="icon-toggle-btn"
              title={densidadeCtx.densidade === 'compacta' ? 'Densidade compacta — clique para confortável' : 'Densidade confortável — clique para compacta'}
              onClick={() => densidadeCtx.setDensidade(densidadeCtx.densidade === 'compacta' ? 'confortavel' : 'compacta')}
            >
              {densidadeCtx.densidade === 'compacta' ? <AlignJustify size={15} /> : <Rows3 size={15} />}
            </button>
          )}
          <button
            type="button"
            className="icon-toggle-btn"
            title={tema === 'dark' ? 'Tema escuro — clique para claro' : 'Tema claro — clique para escuro'}
            onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')}
          >
            {tema === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          {user && <span className="user-badge">{user.nome}</span>}
          <button className="logout-btn" onClick={handleLogout}>
            <LogOut size={13} style={{ marginRight: 6, verticalAlign: -2 }} />
            Sair
          </button>
        </div>
      </header>

      <div className="shell-body">
        {menuAberto && <div className="mobile-sidebar-backdrop" onClick={() => setMenuAberto(false)} />}
        <nav className={'shell-sidebar' + (menuAberto ? ' mobile-open' : '')}>
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
                title={sidebarColapsado ? mod.label : undefined}
              >
                <span className="module-badge"><Icon size={16} /></span>
                <span className="module-label">{mod.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="sidebar-toggle"
            onClick={alternarSidebar}
            title={sidebarColapsado ? 'Expandir menu' : 'Recolher menu'}
          >
            {sidebarColapsado ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            {!sidebarColapsado && <span>Recolher</span>}
          </button>
        </nav>

        <div className="shell-content">
          {activeModule ? (
            <>
              {activeModule.pages.length > 1 && (
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
              )}

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
