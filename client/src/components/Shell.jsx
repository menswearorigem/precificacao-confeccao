import { Fragment, useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Menu, X, ChevronsLeft, ChevronsRight, Sun, Moon, Rows3, AlignJustify, HelpCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules } from '../lib/modules';
import { useTema } from '../lib/useTema';
import { useDensidade } from '../contexts/DensidadeContext';
import BuscaGlobal from './BuscaGlobal';
import SinoCalendario from './SinoCalendario';
import ManuBotao from './ManuBotao';
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

  // Esc fecha a gaveta — no celular quem usa teclado externo (e o leitor de
  // tela) não tinha saída sem acertar o backdrop.
  useEffect(() => {
    if (!menuAberto) return undefined;
    function aoTeclar(e) { if (e.key === 'Escape') setMenuAberto(false); }
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [menuAberto]);

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
      <ManuBotao />
      <header className="shell-header">
        <div className="brand">
          <button
            className="mobile-menu-btn"
            onClick={() => setMenuAberto((v) => !v)}
            aria-label={menuAberto ? 'Fechar menu' : 'Abrir menu'}
            aria-expanded={menuAberto}
          >
            {menuAberto ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="brand-mark"><img src={logoHbnHub} alt="" /></div>
          <div>
            <div className="brand-name">HBN Hub</div>
            <div className="brand-sub">Miss Manu · Origem · Hoggar · Hebron</div>
          </div>
        </div>
        <div className="header-actions">
          {visibleModules.some((mod) => mod.key === 'calendario') && <SinoCalendario />}
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
          {/* /ajuda não é de nenhum módulo (ver lib/modules.js#canAccessPath),
              então o link mora aqui em vez de entrar como página de um
              módulo — não distorce o modelo de permissão por módulo. */}
          <Link to="/ajuda" className="icon-toggle-btn" title="Ajuda" aria-label="Ajuda">
            <HelpCircle size={15} />
          </Link>
          {user && <span className="user-badge">{user.nome}</span>}
          {/* O rótulo vai num <span> próprio para o CSS poder escondê-lo no
              celular (o botão vira só o ícone) sem perder o nome acessível,
              que o aria-label garante. */}
          <button className="logout-btn" onClick={handleLogout} aria-label="Sair">
            <LogOut size={13} className="logout-btn-icone" />
            <span className="logout-btn-texto">Sair</span>
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
              // 10/09/2026: era <button> + navigate(). Virou <Link> pra que o
              // clique do meio do mouse (e o Ctrl+clique, e o "abrir em nova
              // aba" do botão direito) abram o módulo numa aba nova, como em
              // qualquer site. O CSS não mudou — .sidebar-module é seletor de
              // classe, não de elemento.
              <Link
                key={mod.key}
                to={mod.pages[0].to}
                className={'sidebar-module' + (isActive ? ' active' : '')}
                style={{ '--module-color': mod.color }}
                title={sidebarColapsado ? mod.label : undefined}
                onClick={() => setMenuAberto(false)}
              >
                <span className="module-badge"><Icon size={16} /></span>
                <span className="module-label">{mod.label}</span>
              </Link>
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
              {/* Grupos dentro do submenu (09/09/2026).
                  Módulos como Estoque (10 abas) e Marketplace (9) eram uma
                  fileira lisa de links: nada dizia que "Bipagem" é tela de
                  todo dia e "Importar EAN" é tela de uma vez por mês, então
                  achar a certa custava ler a linha inteira. O rótulo de grupo
                  aparece só quando o módulo declara `grupo` nas páginas — e
                  fecha a limitação que o redesenho de Configurações registrou
                  em modules.js: os quatro grupos existiam no comentário e não
                  na tela. Nada aqui muda rota nem permissão (REGRA 4): é a
                  MESMA lista de páginas, na mesma ordem em que o módulo a
                  declara. */}
              {activeModule.pages.length > 1 && (
              <div className="shell-submenu">
                {activeModule.pages.map(({ to, label, icon: Icon, grupo }, indice) => {
                  const grupoAnterior = indice > 0 ? activeModule.pages[indice - 1].grupo : null;
                  const abreGrupo = grupo && grupo !== grupoAnterior;
                  return (
                    <Fragment key={to}>
                      {abreGrupo && <span className="submenu-grupo">{grupo}</span>}
                      <NavLink
                        to={to}
                        end={to === '/estoque' || to === '/compras'}
                        className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
                      >
                        <Icon size={15} />
                        {label}
                      </NavLink>
                    </Fragment>
                  );
                })}
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
