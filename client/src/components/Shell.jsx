import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Menu, X, ChevronsLeft, ChevronsRight, Sun, Moon, Rows3, AlignJustify, HelpCircle, Search } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules, getEntradasVisiveis, acharEntradaAtiva } from '../lib/modules';
import { useTema } from '../lib/useTema';
import { useDensidade } from '../contexts/DensidadeContext';
import BuscaGlobal from './BuscaGlobal';
import SinoCalendario from './SinoCalendario';
import ManuBotao from './ManuBotao';
import logoHbnHub from '../assets/logo-hbn-hub.png';
import { BarraInferior, FerramentasDaGaveta, useTabelasEmCartao } from './MobileShell';

const CHAVE_SIDEBAR_COLAPSADO = 'hbn_sidebar_colapsado';

// Módulos com a repaginação "viva" (16/09/2026): mesmo padrão visual do
// Calendário — só estética, a distribuição de abas e subabas não muda. A
// classe .modulo-vivo liga a camada de estilo do fim do theme.css.
// Rodada 4 (16/09/2026): o padrão "vivo" vale pra todos os módulos, menos o
// Calendário, que já tem o próprio visual (CalendarioVivo).
const MODULOS_VIVOS = new Set([
  'produto', 'estoque', 'producao', 'vendas', 'marketplace', 'financeiro',
  'viagens', 'compras', 'analises', 'configuracoes',
]);

function semMovimento() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Marcador que desliza até a aba acesa (2º e 3º nível do menu). Mede o
// elemento `.active` dentro do contêiner e posiciona um <span> absoluto.
function useMarcadorDeslizante(ativo, dependencia) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!ativo) return undefined;
    const medir = () => {
      const alvo = ref.current?.querySelector('.active');
      if (!alvo) { setPos(null); return; }
      setPos({ x: alvo.offsetLeft, y: alvo.offsetTop, w: alvo.offsetWidth, h: alvo.offsetHeight });
    };
    medir();
    const obs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(medir) : null;
    if (obs && ref.current) obs.observe(ref.current);
    window.addEventListener('resize', medir);
    document.fonts?.ready?.then(medir);
    return () => { obs?.disconnect(); window.removeEventListener('resize', medir); };
  }, [ativo, dependencia]);
  return [ref, pos];
}

function Marcador({ pos, className }) {
  if (!pos) return null;
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ width: pos.w, height: pos.h, transform: `translate(${pos.x}px, ${pos.y}px)` }}
    />
  );
}

function findActiveModule(pathname, visibleModules) {
  for (const mod of visibleModules) {
    for (const page of mod.pages) {
      if (pathname === page.to || pathname.startsWith(`${page.to}/`)) return mod;
    }
  }
  return visibleModules[0] || null;
}

// Descrição da página em UMA linha (revisão visual 25/09/2026): quase toda
// tela abria com um parágrafo de 2–3 linhas empurrando o conteúdo para baixo.
// O parágrafo logo abaixo do título ganha .descricao-cortavel quando não cabe
// numa linha; clicar nele mostra o resto (e clicar de novo recolhe). Só mexe
// em classe — o texto de cada tela continua onde está, sem reescrever nada.
const SELETOR_DESCRICAO = ':is(.page, .page-wide, .pagina) :is(h1 + p.page-sub, h1 + p.ink-soft)';
function useDescricaoCortavel(refMain, chave) {
  useEffect(() => {
    const main = refMain.current;
    if (!main) return undefined;
    const marcar = () => {
      main.querySelectorAll(SELETOR_DESCRICAO).forEach((p) => {
        if (p.dataset.cortavelVisto) return;
        p.dataset.cortavelVisto = '1';
        p.classList.add('descricao-cortavel');
        // Coube numa linha: não há o que abrir — tira a marca.
        if (p.scrollHeight <= p.clientHeight + 2) p.classList.remove('descricao-cortavel');
        else p.title = 'Clique para ler a descrição inteira';
      });
    };
    const t1 = setTimeout(marcar, 0);
    const t2 = setTimeout(marcar, 900);
    const aoClicar = (e) => {
      const p = e.target.closest?.('.descricao-cortavel');
      if (!p || !main.contains(p) || e.target.closest('a, button')) return;
      p.classList.toggle('aberta');
    };
    main.addEventListener('click', aoClicar);
    return () => { clearTimeout(t1); clearTimeout(t2); main.removeEventListener('click', aoClicar); };
  }, [refMain, chave]);
}

export default function Shell({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { tema, setTema } = useTema();
  const densidadeCtx = useDensidade();
  const visibleModules = getVisibleModules(user);
  const activeModule = findActiveModule(location.pathname, visibleModules);
  // Entradas de menu do módulo aberto (o segundo nível) e qual delas está
  // acesa — é ela que decide se existe um terceiro nível.
  const entradas = activeModule ? getEntradasVisiveis(activeModule, user) : [];
  const entradaAtiva = acharEntradaAtiva(entradas, location.pathname);
  const vivo = Boolean(activeModule && MODULOS_VIVOS.has(activeModule.key));
  const [refSubmenu, posSubmenu] = useMarcadorDeslizante(vivo, `${location.pathname}|${entradas.length}`);
  const [refSubsub, posSubsub] = useMarcadorDeslizante(vivo, location.pathname);
  const refMain = useRef(null);
  useTabelasEmCartao(refMain, activeModule?.key);
  useDescricaoCortavel(refMain, location.pathname);

  // Celular: a fileira de abas rola de lado; a aba acesa vem pro meio da
  // tela (antes ela podia ficar escondida depois da borda direita).
  useEffect(() => {
    if (!window.matchMedia?.('(max-width: 860px)').matches) return;
    for (const sel of ['.shell-submenu .nav-link.active', '.shell-subsubmenu .subnav-link.active']) {
      const el = document.querySelector(sel);
      el?.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: semMovimento() ? 'auto' : 'smooth' });
    }
  }, [location.pathname]);

  // Troca de tela nos módulos vivos: o conteúdo sobe suavemente. Feito com a
  // Web Animations API (e não com `key` no <main>) para não desmontar a tela
  // — o FinanceiroPage serve três rotas e perderia o estado.
  useEffect(() => {
    if (!vivo || semMovimento() || !refMain.current?.animate) return;
    refMain.current.animate(
      [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }
    );
  }, [location.pathname, vivo]);
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
          <div className="brand-textos">
            {activeModule && <div className="brand-modulo">{location.pathname.startsWith('/ajuda') ? 'Ajuda' : activeModule.label}</div>}
            <div className="brand-name">HBN Hub</div>
            <div className="brand-sub">Miss Manu · Origem · Hoggar · Hebron</div>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-toggle-btn so-celular"
            aria-label="Buscar no sistema"
            onClick={() => window.dispatchEvent(new Event('hbn:abrir-busca'))}
          >
            <Search size={17} />
          </button>
          <SinoCalendario comCalendario={visibleModules.some((mod) => mod.key === 'calendario')} />
          {densidadeCtx && (
            <button
              type="button"
              className="icon-toggle-btn so-computador"
              title={densidadeCtx.densidade === 'compacta' ? 'Densidade compacta — clique para confortável' : 'Densidade confortável — clique para compacta'}
              onClick={() => densidadeCtx.setDensidade(densidadeCtx.densidade === 'compacta' ? 'confortavel' : 'compacta')}
            >
              {densidadeCtx.densidade === 'compacta' ? <AlignJustify size={15} /> : <Rows3 size={15} />}
            </button>
          )}
          <button
            type="button"
            className="icon-toggle-btn so-computador"
            title={tema === 'dark' ? 'Tema escuro — clique para claro' : 'Tema claro — clique para escuro'}
            onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')}
          >
            {tema === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          {/* /ajuda não é de nenhum módulo (ver lib/modules.js#canAccessPath),
              então o link mora aqui em vez de entrar como página de um
              módulo — não distorce o modelo de permissão por módulo. */}
          <Link to="/ajuda" className="icon-toggle-btn so-computador" title="Ajuda" aria-label="Ajuda">
            <HelpCircle size={15} />
          </Link>
          {user && <span className="user-badge">{user.nome}</span>}
          {/* O rótulo vai num <span> próprio para o CSS poder escondê-lo no
              celular (o botão vira só o ícone) sem perder o nome acessível,
              que o aria-label garante. */}
          <button className="logout-btn so-computador" onClick={handleLogout} aria-label="Sair">
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
          <FerramentasDaGaveta
            user={user}
            tema={tema}
            setTema={setTema}
            densidadeCtx={densidadeCtx}
            onSair={handleLogout}
          />
        </nav>

        <div
          className={'shell-content' + (vivo ? ` modulo-vivo modulo-${activeModule.key}` : '') + (location.pathname.startsWith('/ajuda') ? ' pagina-ajuda' : '')}
          style={vivo ? {
            '--module-color': activeModule.color,
            // Rótulo acima do título da página (CSS `content: var(--modulo-nome)`).
            '--modulo-nome': JSON.stringify(location.pathname.startsWith('/ajuda') ? 'Ajuda · Manu' : activeModule.label),
          } : undefined}
        >
          {activeModule ? (
            <>
              {/* Segundo nível: as ENTRADAS do módulo (14/09/2026).
                  Era a lista lisa de todas as páginas — 11 no Estoque, 12 no
                  Marketplace, 11 no Financeiro e 11 em Configurações — numa
                  barra que não cabia na tela e escondia de 2 a 5 telas fora da
                  borda direita, sem seta nem sombra. Agora são de 1 a 5
                  entradas por módulo, e a entrada que reúne mais de uma tela
                  abre a fileira de baixo. Nada aqui muda rota nem permissão
                  (REGRA 4): `mod.pages` continua sendo a mesma lista de
                  sempre, só que agrupada para exibição. */}
              {entradas.length > 1 && (
              <div className="shell-submenu" ref={refSubmenu}>
                {vivo && <Marcador pos={posSubmenu} className="vivo-marcador-aba" />}
                {entradas.map((entrada) => {
                  const Icon = entrada.icon;
                  const ativa = entradaAtiva === entrada;
                  const destino = entrada.paginas ? entrada.paginas[0].to : entrada.to;
                  return (
                    // <Link> e não <NavLink> de propósito: o NavLink acrescenta
                    // o "active" dele por cima do nosso, e aí
                    // `/producao/projecao` acendia "Ordens de Produção" (rota
                    // `/producao`, que é prefixo) junto com "Planejamento" —
                    // duas entradas acesas ao mesmo tempo. Quem decide o aceso
                    // aqui é `acharEntradaAtiva`, que escolhe a rota mais
                    // específica.
                    <Link
                      key={entrada.label + destino}
                      to={destino}
                      className={'nav-link' + (ativa ? ' active' : '')}
                      aria-current={ativa ? 'page' : undefined}
                    >
                      <Icon size={15} />
                      {entrada.label}
                    </Link>
                  );
                })}
              </div>
              )}

              {/* Terceiro nível: só aparece quando a entrada aberta reúne mais
                  de uma tela. É deliberadamente menor e mais discreto que a
                  fileira de cima — o olho tem que enxergar primeiro ONDE está
                  (a entrada) e só depois QUAL ângulo (a tela). */}
              {entradaAtiva?.paginas && (
                <div className="shell-subsubmenu" aria-label={`Telas de ${entradaAtiva.label}`} ref={refSubsub}>
                  {vivo && <Marcador pos={posSubsub} className="vivo-marcador-subaba" />}
                  {entradaAtiva.paginas.map(({ to, label, icon: Icon }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={to === '/compras'}
                      className={({ isActive }) => 'subnav-link' + (isActive ? ' active' : '')}
                    >
                      <Icon size={13} />
                      {label}
                    </NavLink>
                  ))}
                </div>
              )}

              <main className="shell-main" ref={refMain}>{children}</main>
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
      <BarraInferior
        visiveis={visibleModules}
        ativo={activeModule}
        menuAberto={menuAberto}
        onMenu={() => setMenuAberto((v) => !v)}
      />
    </div>
  );
}
