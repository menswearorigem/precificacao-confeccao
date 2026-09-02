import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Package, Users, Truck, ShoppingCart, Store, Barcode, LayoutGrid, History,
  MessageCircleQuestion,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules } from '../lib/modules';
import { api } from '../api/client';
import { brl } from '../lib/format';
import { buscarAjuda, pareceDuvida, buscarVerbetePorId } from '../lib/ajuda';
import { RespostaVerbete } from './ManuPainel';

const CHAVE_RECENTES = 'hbn_busca_global_recentes';
const MAX_RECENTES = 8;
const MAX_AJUDA = 4;

function lerRecentesGlobal() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAVE_RECENTES) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function gravarRecenteGlobal(item) {
  try {
    const atuais = lerRecentesGlobal().filter((r) => r.href !== item.href);
    atuais.unshift(item);
    localStorage.setItem(CHAVE_RECENTES, JSON.stringify(atuais.slice(0, MAX_RECENTES)));
  } catch {
    // localStorage indisponível — não trava a navegação por causa disso
  }
}

const GRUPOS_CONFIG = [
  { chave: 'produtos', titulo: 'Produtos', Icone: Package, item: (p) => ({ label: p.referencia, sub: p.descricao || p.codigo || '', href: `/produtos/${p.id}` }) },
  { chave: 'clientes', titulo: 'Clientes', Icone: Users, item: (c) => ({ label: c.nome, sub: c.cpf_cnpj || '', href: `/clientes/${c.id}` }) },
  { chave: 'fornecedores', titulo: 'Fornecedores', Icone: Truck, item: (f) => ({ label: f.nome, sub: f.cpf_cnpj || '', href: `/fornecedores/${f.id}` }) },
  { chave: 'pedidos', titulo: 'Pedidos de Venda', Icone: ShoppingCart, item: (p) => ({ label: `Pedido #${p.numero}`, sub: `${p.cliente_nome || '—'} · ${brl(p.total_liquido)}`, href: `/pedidos/${p.id}` }) },
  { chave: 'pedidosMarketplace', titulo: 'Pedidos de Marketplace', Icone: Store, item: (p) => ({ label: p.origem_pedido_id || `#${p.numero}`, sub: `${p.canal_venda || '—'} · ${brl(p.total_liquido)}`, href: `/pedidos/${p.id}` }) },
  { chave: 'ean', titulo: 'EAN', Icone: Barcode, item: (v) => ({ label: v.ean, sub: `${v.referencia} · ${[v.cor, v.tamanho].filter(Boolean).join(' / ')}`, href: `/produtos/${v.produto_id}` }) },
];

export default function BuscaGlobal() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [aberto, setAberto] = useState(false);
  const [termo, setTermo] = useState('');
  const [resultados, setResultados] = useState(null);
  const [indiceAtivo, setIndiceAtivo] = useState(0);
  const [ajudaAbertaId, setAjudaAbertaId] = useState(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  const paginas = useMemo(() => {
    if (!user) return [];
    return getVisibleModules(user).flatMap((mod) => mod.pages.map((p) => ({ ...p, moduloLabel: mod.label })));
  }, [user]);

  useEffect(() => {
    function aoTeclar(e) {
      const combinacao = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (combinacao) {
        e.preventDefault();
        setAberto((v) => !v);
      } else if (e.key === 'Escape' && aberto) {
        setAberto(false);
      }
    }
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [aberto]);

  useEffect(() => {
    if (aberto) {
      setTermo('');
      setResultados(null);
      setIndiceAtivo(0);
      setAjudaAbertaId(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return;
    clearTimeout(debounceRef.current);
    if (termo.trim().length < 2) { setResultados(null); return; }
    debounceRef.current = setTimeout(() => {
      api.get(`/busca?q=${encodeURIComponent(termo.trim())}`).then(setResultados);
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [termo, aberto]);

  const paginasFiltradas = useMemo(() => {
    if (!termo.trim()) return [];
    const alvo = termo.trim().toLowerCase();
    return paginas.filter((p) => p.label.toLowerCase().includes(alvo)).slice(0, 5);
  }, [paginas, termo]);

  // A busca de ajuda é local e síncrona (lib/ajuda) — não passa pelo
  // debounce de 200ms nem espera o servidor: responde a partir de 2
  // caracteres, na hora, enquanto os grupos de entidade ainda carregam.
  const ajudaResultados = useMemo(() => {
    if (!user || termo.trim().length < 2) return [];
    return buscarAjuda(termo, { user, limite: MAX_AJUDA });
  }, [termo, user]);

  // Decide a ORDEM dos grupos, não o conteúdo: consulta com cara de dúvida
  // ("como...", "não sei...") põe a Ajuda antes até das Páginas.
  const ajudaPrimeiro = useMemo(() => pareceDuvida(termo), [termo]);

  // Achata tudo numa lista única (na mesma ordem visual) pra navegação por setas.
  const listaAchatada = useMemo(() => {
    if (!termo.trim()) {
      return lerRecentesGlobal().map((r) => ({ ...r, tipo: 'recente' }));
    }
    const itensAjuda = ajudaResultados.map((v) => ({
      label: v.titulo, sub: v.tela, href: v.rota, tipo: 'ajuda', verbete: v,
    }));
    const itensPaginas = paginasFiltradas.map((p) => ({ label: p.label, sub: p.moduloLabel, href: p.to, tipo: 'pagina' }));
    const itens = ajudaPrimeiro ? [...itensAjuda, ...itensPaginas] : [...itensPaginas, ...itensAjuda];
    if (resultados) {
      for (const g of GRUPOS_CONFIG) {
        for (const row of resultados[g.chave] || []) {
          itens.push({ ...g.item(row), tipo: g.chave });
        }
      }
    }
    return itens;
  }, [termo, paginasFiltradas, ajudaResultados, ajudaPrimeiro, resultados]);

  useEffect(() => { setIndiceAtivo(0); }, [listaAchatada.length]);

  function abrir(item) {
    // Itens de ajuda não navegam nem entram em "Últimas consultadas" — Enter
    // ou clique nele expande a resposta ali mesmo, dentro da paleta.
    if (item.tipo === 'ajuda') {
      setAjudaAbertaId((atual) => (atual === item.verbete.id ? null : item.verbete.id));
      return;
    }
    if (item.tipo !== 'pagina') gravarRecenteGlobal(item);
    setAberto(false);
    navigate(item.href);
  }

  function navegarParaVerbete(verbete) {
    setAberto(false);
    navigate(verbete.rota);
  }

  function aoTeclarNaBusca(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndiceAtivo((i) => Math.min(i + 1, listaAchatada.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndiceAtivo((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (listaAchatada[indiceAtivo]) abrir(listaAchatada[indiceAtivo]);
    }
  }

  if (!aberto) return null;

  const semTermo = !termo.trim();

  // Offset de cada item dentro da lista achatada, na mesma ordem em que é
  // renderizado — usado só pra saber qual linha destacar como "ativa".
  let cursor = 0;
  const offsetAjuda = cursor; if (ajudaPrimeiro) cursor += ajudaResultados.length;
  const offsetPaginasPreAjuda = ajudaPrimeiro ? cursor : 0;
  if (!ajudaPrimeiro) cursor += paginasFiltradas.length;
  const offsetPaginas = ajudaPrimeiro ? offsetPaginasPreAjuda : 0;
  const offsetAjudaDepois = ajudaPrimeiro ? -1 : cursor;
  if (!ajudaPrimeiro) cursor += ajudaResultados.length;
  const offsetEntidades = cursor;

  // Um "relacionado" clicado dentro da resposta pode apontar pra um
  // verbete fora dos 4 exibidos aqui (o grupo é bem mais estreito que o do
  // ManuPainel) — nesse caso ele entra como uma linha extra no fim do
  // grupo, só pra abrir a resposta; não ganha destaque de teclado (caso
  // raro, não vale a complexidade de recalcular todos os offsets por causa
  // dele).
  const extraFalta = ajudaAbertaId && !ajudaResultados.some((v) => v.id === ajudaAbertaId)
    ? buscarVerbetePorId(ajudaAbertaId)
    : null;

  const blocoAjuda = (ajudaResultados.length > 0 || extraFalta) && (
    <div className="busca-global-grupo" key="ajuda">
      <div className="busca-global-grupo-titulo"><MessageCircleQuestion size={12} /> Ajuda da Manu</div>
      {ajudaResultados.map((v, idx) => {
        const posicao = (ajudaPrimeiro ? offsetAjuda : offsetAjudaDepois) + idx;
        const item = { label: v.titulo, sub: v.tela, href: v.rota, tipo: 'ajuda', verbete: v };
        return (
          <ItemAjuda
            key={v.id}
            verbete={v}
            ativo={posicao === indiceAtivo}
            aberto={ajudaAbertaId === v.id}
            onClick={() => abrir(item)}
            onNavegar={navegarParaVerbete}
            onSelecionarRelacionado={setAjudaAbertaId}
          />
        );
      })}
      {extraFalta && (
        <ItemAjuda
          key={extraFalta.id}
          verbete={extraFalta}
          ativo={false}
          aberto
          onClick={() => setAjudaAbertaId(null)}
          onNavegar={navegarParaVerbete}
          onSelecionarRelacionado={setAjudaAbertaId}
        />
      )}
    </div>
  );

  return (
    <div className="busca-global-backdrop" onClick={() => setAberto(false)}>
      <div className="busca-global-painel" onClick={(e) => e.stopPropagation()}>
        <div className="busca-global-campo">
          <Search size={16} />
          <input
            ref={inputRef}
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            onKeyDown={aoTeclarNaBusca}
            placeholder="Buscar produto, pedido, cliente, fornecedor, EAN ou uma página…"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="busca-global-resultados">
          {semTermo && listaAchatada.length === 0 && (
            <p className="busca-global-vazio">Digite ao menos 2 letras pra buscar.</p>
          )}
          {semTermo && listaAchatada.length > 0 && (
            <div className="busca-global-grupo">
              <div className="busca-global-grupo-titulo"><History size={12} /> Últimas consultadas</div>
              {listaAchatada.map((item, idx) => (
                <ItemResultado key={`${item.href}-${idx}`} item={item} ativo={idx === indiceAtivo} onClick={() => abrir(item)} />
              ))}
            </div>
          )}

          {!semTermo && (
            <>
              {ajudaPrimeiro && blocoAjuda}
              {paginasFiltradas.length > 0 && (
                <div className="busca-global-grupo">
                  <div className="busca-global-grupo-titulo"><LayoutGrid size={12} /> Páginas</div>
                  {paginasFiltradas.map((p, idx) => (
                    <ItemResultado
                      key={p.to}
                      item={{ label: p.label, sub: p.moduloLabel, href: p.to }}
                      ativo={offsetPaginas + idx === indiceAtivo}
                      onClick={() => abrir({ label: p.label, href: p.to, tipo: 'pagina' })}
                    />
                  ))}
                </div>
              )}
              {!ajudaPrimeiro && blocoAjuda}
              {resultados && GRUPOS_CONFIG.map((g) => {
                const linhas = resultados[g.chave] || [];
                if (linhas.length === 0) return null;
                let offset = offsetEntidades;
                for (const anterior of GRUPOS_CONFIG) {
                  if (anterior.chave === g.chave) break;
                  offset += (resultados[anterior.chave] || []).length;
                }
                return (
                  <div className="busca-global-grupo" key={g.chave}>
                    <div className="busca-global-grupo-titulo"><g.Icone size={12} /> {g.titulo}</div>
                    {linhas.map((row, idx) => {
                      const item = { ...g.item(row), tipo: g.chave };
                      return <ItemResultado key={`${g.chave}-${idx}`} item={item} ativo={offset + idx === indiceAtivo} onClick={() => abrir(item)} />;
                    })}
                  </div>
                );
              })}
              {!resultados && termo.trim().length >= 2 && ajudaResultados.length === 0 && (
                <p className="busca-global-vazio">Buscando…</p>
              )}
              {resultados && listaAchatada.length === 0 && <p className="busca-global-vazio">Nada encontrado pra "{termo}".</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ItemResultado({ item, ativo, onClick }) {
  return (
    <button type="button" className={'busca-global-item' + (ativo ? ' ativo' : '')} onClick={onClick}>
      <span className="busca-global-item-label">{item.label}</span>
      {item.sub && <span className="busca-global-item-sub">{item.sub}</span>}
    </button>
  );
}

// Item do grupo "Ajuda da Manu": clicar não navega, expande a resposta ali
// mesmo (mesma peça RespostaVerbete usada no ManuPainel — ver seção "um só
// componente" do relatório da tarefa).
function ItemAjuda({ verbete, ativo, aberto, onClick, onNavegar, onSelecionarRelacionado }) {
  return (
    <div className={'busca-global-item-ajuda-wrap' + (aberto ? ' aberto' : '')}>
      <button type="button" className={'busca-global-item' + (ativo ? ' ativo' : '')} onClick={onClick} aria-expanded={aberto}>
        <span className="busca-global-item-label">{verbete.titulo}</span>
        <span className="busca-global-item-sub">{verbete.tela}</span>
      </button>
      {aberto && (
        <RespostaVerbete verbete={buscarVerbetePorId(verbete.id) || verbete} onNavegar={onNavegar} onSelecionarRelacionado={onSelecionarRelacionado} />
      )}
    </div>
  );
}
