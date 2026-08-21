import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Package, Users, Truck, ShoppingCart, Store, Barcode, LayoutGrid, History,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules } from '../lib/modules';
import { api } from '../api/client';
import { brl } from '../lib/format';

const CHAVE_RECENTES = 'hbn_busca_global_recentes';
const MAX_RECENTES = 8;

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

  // Achata tudo numa lista única (na mesma ordem visual) pra navegação por setas.
  const listaAchatada = useMemo(() => {
    if (!termo.trim()) {
      return lerRecentesGlobal().map((r) => ({ ...r, tipo: 'recente' }));
    }
    const itens = [];
    if (paginasFiltradas.length > 0) {
      itens.push(...paginasFiltradas.map((p) => ({ label: p.label, sub: p.moduloLabel, href: p.to, tipo: 'pagina' })));
    }
    if (resultados) {
      for (const g of GRUPOS_CONFIG) {
        for (const row of resultados[g.chave] || []) {
          itens.push({ ...g.item(row), tipo: g.chave });
        }
      }
    }
    return itens;
  }, [termo, paginasFiltradas, resultados]);

  useEffect(() => { setIndiceAtivo(0); }, [listaAchatada.length]);

  function abrir(item) {
    if (item.tipo !== 'pagina') gravarRecenteGlobal(item);
    setAberto(false);
    navigate(item.href);
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
              {paginasFiltradas.length > 0 && (
                <div className="busca-global-grupo">
                  <div className="busca-global-grupo-titulo"><LayoutGrid size={12} /> Páginas</div>
                  {paginasFiltradas.map((p, idx) => (
                    <ItemResultado
                      key={p.to}
                      item={{ label: p.label, sub: p.moduloLabel, href: p.to }}
                      ativo={idx === indiceAtivo}
                      onClick={() => abrir({ label: p.label, href: p.to, tipo: 'pagina' })}
                    />
                  ))}
                </div>
              )}
              {resultados && GRUPOS_CONFIG.map((g) => {
                const linhas = resultados[g.chave] || [];
                if (linhas.length === 0) return null;
                let offset = paginasFiltradas.length;
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
              {!resultados && termo.trim().length >= 2 && <p className="busca-global-vazio">Buscando…</p>}
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
