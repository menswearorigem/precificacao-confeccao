// Peças do Shell que só aparecem no celular (17/09/2026).
// Até aqui o celular era o computador achatado: menu escondido num
// hambúrguer, cinco ícones brigando no cabeçalho e tabelas de 9 colunas
// rolando de lado. Aqui ficam:
// - a barra de navegação de baixo (4 módulos + "Menu"), ao alcance do polegar;
// - as ferramentas (tema, densidade, ajuda, sair) que saem do cabeçalho e
//   vão pra dentro da gaveta;
// - o "cartonador" de tabelas: marca cada célula com o nome da coluna para o
//   CSS transformar a linha num cartão (só abaixo de 860px).
// Nenhuma rota, permissão ou dado muda.
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { LayoutGrid, Sun, Moon, Rows3, AlignJustify, HelpCircle, LogOut } from 'lucide-react';

// Ordem de preferência da barra de baixo; completa com os outros módulos
// visíveis se o usuário não tiver acesso a algum destes.
const PREFERIDOS = ['marketplace', 'vendas', 'estoque', 'producao', 'financeiro', 'produto'];

export function escolherModulosDaBarra(visiveis) {
  const porChave = new Map(visiveis.map((m) => [m.key, m]));
  const escolhidos = PREFERIDOS.map((k) => porChave.get(k)).filter(Boolean);
  for (const m of visiveis) if (!escolhidos.includes(m)) escolhidos.push(m);
  return escolhidos.slice(0, 4);
}

export function BarraInferior({ visiveis, ativo, menuAberto, onMenu }) {
  const modulos = escolherModulosDaBarra(visiveis);
  const ativoNaBarra = ativo && modulos.includes(ativo);
  const IconeAtivoFora = !ativoNaBarra && ativo ? ativo.icon : null;
  return (
    <nav className="barra-inferior" aria-label="Módulos">
      {modulos.map((mod) => {
        const Icon = mod.icon;
        const aceso = ativo === mod && !menuAberto;
        return (
          <Link
            key={mod.key}
            to={mod.pages[0].to}
            className={'barra-inferior-item' + (aceso ? ' ativo' : '')}
            style={{ '--module-color': mod.color }}
            aria-current={aceso ? 'page' : undefined}
          >
            <span className="barra-inferior-icone"><Icon size={20} /></span>
            <span className="barra-inferior-rotulo">{mod.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        className={'barra-inferior-item' + (menuAberto || IconeAtivoFora ? ' ativo' : '')}
        style={IconeAtivoFora && !menuAberto ? { '--module-color': ativo.color } : undefined}
        onClick={onMenu}
        aria-expanded={menuAberto}
      >
        <span className="barra-inferior-icone">
          {IconeAtivoFora && !menuAberto ? <IconeAtivoFora size={20} /> : <LayoutGrid size={20} />}
        </span>
        <span className="barra-inferior-rotulo">{IconeAtivoFora && !menuAberto ? ativo.label : 'Menu'}</span>
      </button>
    </nav>
  );
}

export function FerramentasDaGaveta({ user, tema, setTema, densidadeCtx, onSair }) {
  return (
    <div className="gaveta-ferramentas">
      {user && (
        <div className="gaveta-usuario">
          <span className="gaveta-usuario-avatar">{(user.nome || '?').trim().charAt(0).toUpperCase()}</span>
          <span className="gaveta-usuario-nome">{user.nome}</span>
        </div>
      )}
      <div className="gaveta-ferramentas-grade">
        <button type="button" onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')}>
          {tema === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          <span>{tema === 'dark' ? 'Tema claro' : 'Tema escuro'}</span>
        </button>
        {densidadeCtx && (
          <button
            type="button"
            onClick={() => densidadeCtx.setDensidade(densidadeCtx.densidade === 'compacta' ? 'confortavel' : 'compacta')}
          >
            {densidadeCtx.densidade === 'compacta' ? <AlignJustify size={18} /> : <Rows3 size={18} />}
            <span>{densidadeCtx.densidade === 'compacta' ? 'Tabela confortável' : 'Tabela compacta'}</span>
          </button>
        )}
        <Link to="/ajuda">
          <HelpCircle size={18} />
          <span>Ajuda</span>
        </Link>
        <button type="button" className="perigo" onClick={onSair}>
          <LogOut size={18} />
          <span>Sair</span>
        </button>
      </div>
    </div>
  );
}

// ---- tabelas que viram cartão ----------------------------------------------
// Heurística conservadora: só converte tabela de UMA linha de cabeçalho, de 5
// a 14 colunas, sem célula mesclada no corpo, e fora das matrizes (grade de
// tamanhos, DRE, fluxo, calendário), que continuam rolando de lado — matriz
// em cartão perde a leitura cruzada. `data-sem-cartao` desliga na mão.
const CLASSES_MATRIZ = /grade|matriz|dre|fluxo|calendario|mix|ficha-doc|extrato|frete/i;

function textoDoCabecalho(th) {
  const t = (th.getAttribute('aria-label') || th.textContent || '').replace(/\s+/g, ' ').trim();
  return t;
}

function cartonarTabela(tabela) {
  if (tabela.dataset.semCartao != null) return;
  if (CLASSES_MATRIZ.test(tabela.className)) { tabela.dataset.cartao = 'nao'; return; }
  const linhasCab = tabela.tHead ? tabela.tHead.rows : [];
  if (linhasCab.length !== 1) { tabela.dataset.cartao = 'nao'; return; }
  const rotulos = [];
  for (const th of linhasCab[0].cells) {
    const n = th.colSpan || 1;
    for (let i = 0; i < n; i += 1) rotulos.push(i === 0 ? textoDoCabecalho(th) : '');
  }
  if (rotulos.length < 5 || rotulos.length > 14) { tabela.dataset.cartao = 'nao'; return; }
  const corpos = [...tabela.tBodies, ...(tabela.tFoot ? [tabela.tFoot] : [])];
  for (const corpo of corpos) {
    for (const tr of corpo.rows) {
      if (tr.cells.length === 1) continue; // linha de "vazio"/"carregando" ocupa tudo
      let col = 0;
      let tituloMarcado = false;
      for (const td of tr.cells) {
        if (td.rowSpan > 1) { tabela.dataset.cartao = 'nao'; return; }
        const rotulo = rotulos[col] || '';
        if (td.dataset.rotulo !== rotulo) td.dataset.rotulo = rotulo;
        const vazio = !td.textContent.trim() && !td.querySelector('input:not([type="checkbox"]), select, textarea');
        const eTitulo = !tituloMarcado && rotulo && !vazio;
        if (eTitulo) tituloMarcado = true;
        if (eTitulo) { if (td.dataset.titulo !== '1') td.dataset.titulo = '1'; } else if (td.dataset.titulo) delete td.dataset.titulo;
        if (!rotulo) { if (td.dataset.solto !== '1') td.dataset.solto = '1'; } else if (td.dataset.solto) delete td.dataset.solto;
        col += td.colSpan || 1;
      }
    }
  }
  if (tabela.dataset.cartao !== 'sim') tabela.dataset.cartao = 'sim';
}

export function useTabelasEmCartao(refRaiz, chave) {
  useEffect(() => {
    const raiz = refRaiz.current;
    if (!raiz || typeof MutationObserver === 'undefined') return undefined;
    const mq = window.matchMedia('(max-width: 860px)');
    let agendado = 0;
    const rodar = () => {
      agendado = 0;
      if (!mq.matches) return;
      raiz.querySelectorAll('table').forEach(cartonarTabela);
    };
    const agendar = () => { if (!agendado) agendado = requestAnimationFrame(rodar); };
    rodar();
    const obs = new MutationObserver(agendar);
    obs.observe(raiz, { childList: true, subtree: true, characterData: true });
    mq.addEventListener?.('change', agendar);
    return () => {
      obs.disconnect();
      mq.removeEventListener?.('change', agendar);
      if (agendado) cancelAnimationFrame(agendado);
    };
  }, [refRaiz, chave]);
}
