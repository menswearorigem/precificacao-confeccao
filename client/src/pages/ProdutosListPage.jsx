import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Search, PackageSearch, Store, Printer } from 'lucide-react';
import { api } from '../api/client';
import { statusToneClass } from '../lib/statusTone';
import { brl, pct } from '../lib/format';
import FotoProduto from '../components/FotoProduto';
import { Select, Checkbox, SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio } from '../components/ui';
import DataTable from '../components/DataTable';
import { useTabela } from '../lib/useTabela';

const COLUNAS_ORDENAVEIS = {
  referencia: (p) => p.referencia,
  descricao: (p) => p.descricao,
  marca: (p) => p.marca,
  categoria: (p) => p.categoria,
  marketplace: (p) => (p.marketplace ? 0 : 1),
  preco: (p) => Number(p.precoAtivo) || 0,
  margem: (p) => Number(p.lucroPct) || 0,
  status: (p) => p.status,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Referência', valor: (p) => p.referencia },
  { rotulo: 'Descrição', valor: (p) => p.descricao },
  { rotulo: 'Marca', valor: (p) => p.marca },
  { rotulo: 'Categoria', valor: (p) => p.categoria },
  { rotulo: 'Marketplace', valor: (p) => (p.marketplace ? 'Sim' : 'Não') },
  { rotulo: 'Preço', valor: (p) => brl(p.precoAtivo) },
  { rotulo: 'Margem', valor: (p) => pct(p.lucroPct) },
  { rotulo: 'Status', valor: (p) => p.status },
];

export default function ProdutosListPage() {
  const navigate = useNavigate();
  const [produtos, setProdutos] = useState([]);
  const [listas, setListas] = useState(null);
  const [marca, setMarca] = useState('');
  const [categoria, setCategoria] = useState('');
  // '' = todos · '1' = só marketplace · '0' = só fora do marketplace
  const [marketplace, setMarketplace] = useState('');
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(true);
  const [selecionados, setSelecionados] = useState(new Set());
  const [aplicando, setAplicando] = useState(false);
  const [aviso, setAviso] = useState('');

  useEffect(() => {
    api.get('/listas').then(setListas);
  }, []);

  function load() {
    setLoading(true);
    setSelecionados(new Set());
    const params = new URLSearchParams();
    if (marca) params.set('marca', marca);
    if (categoria) params.set('categoria', categoria);
    if (marketplace) params.set('marketplace', marketplace);
    if (busca) params.set('busca', busca);
    api.get(`/produtos?${params.toString()}`).then((data) => {
      setProdutos(data);
      setLoading(false);
    });
  }

  useEffect(load, [marca, categoria, marketplace]);

  function handleBuscaSubmit(e) {
    e.preventDefault();
    load();
  }

  const tabela = useTabela(produtos, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'referencia' });

  function alternarSelecao(id) {
    setSelecionados((atual) => {
      const nova = new Set(atual);
      if (nova.has(id)) nova.delete(id); else nova.add(id);
      return nova;
    });
  }

  // Marca/desmarca todos os da PÁGINA atual — não a lista inteira: o que a
  // pessoa está vendo é o que ela seleciona.
  const idsPagina = tabela.itensPagina.map((p) => p.id);
  const todosDaPaginaSelecionados = idsPagina.length > 0 && idsPagina.every((id) => selecionados.has(id));

  function alternarPagina() {
    setSelecionados((atual) => {
      const nova = new Set(atual);
      if (todosDaPaginaSelecionados) idsPagina.forEach((id) => nova.delete(id));
      else idsPagina.forEach((id) => nova.add(id));
      return nova;
    });
  }

  async function aplicarMarketplace(entrar) {
    if (selecionados.size === 0) return;
    setAplicando(true);
    setAviso('');
    try {
      const caminho = entrar ? '/produtos-marketplace' : '/produtos-marketplace/remover';
      const r = await api.post(caminho, { ids: [...selecionados] });
      setAviso(
        `${r.alterados} produto(s) ${entrar ? 'adicionado(s) à' : 'removido(s) da'} seleção de marketplace.`
        + (r.jaEstavam > 0 ? ` ${r.jaEstavam} já ${entrar ? 'estava(m) na' : 'estava(m) fora da'} seleção.` : '')
      );
      load();
    } catch (err) {
      setAviso(err.message);
    } finally {
      setAplicando(false);
    }
  }

  const totalMarketplace = produtos.filter((p) => p.marketplace).length;

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Produtos / Referências</h2>
          <p className="page-sub">Cadastro, custo e formação de preço de cada referência.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/estoque/ficha?marketplace=1" className="btn btn-ghost">
            <Printer size={14} /> Fichas do marketplace
          </Link>
          <BotaoExportar nomeBase="produtos" colunas={COLUNAS_EXPORTACAO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
          <Link to="/produtos/novo" className="btn btn-primary">
            <Plus size={14} /> Novo produto
          </Link>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <form onSubmit={handleBuscaSubmit} style={{ display: 'flex', gap: 8, flex: 1, minWidth: 220 }}>
            <input
              placeholder="Buscar por referência, código ou descrição"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
          </form>
          <Select value={marca} onChange={(e) => setMarca(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Todas as marcas</option>
            {listas?.marca.map((m) => <option key={m.id} value={m.valor}>{m.valor}</option>)}
          </Select>
          <Select value={categoria} onChange={(e) => setCategoria(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Todas as categorias</option>
            {listas?.categoria.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
          </Select>
          <Select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} style={{ maxWidth: 210 }}>
            <option value="">Marketplace: todos</option>
            <option value="1">Somente do marketplace</option>
            <option value="0">Fora do marketplace</option>
          </Select>
        </div>
        {!loading && (
          <p className="page-sub" style={{ margin: '10px 0 0' }}>
            {tabela.totalItens.toLocaleString('pt-BR')} resultado(s)
            {marketplace === '' && totalMarketplace > 0 && ` · ${totalMarketplace} do marketplace`}
          </p>
        )}
      </div>

      {selecionados.size > 0 && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{selecionados.size} selecionado(s)</strong>
          <button className="btn btn-primary sm" disabled={aplicando} onClick={() => aplicarMarketplace(true)}>
            <Store size={13} /> Marcar como marketplace
          </button>
          <button className="btn btn-ghost sm" disabled={aplicando} onClick={() => aplicarMarketplace(false)}>
            Tirar do marketplace
          </button>
          <button className="btn btn-ghost sm" disabled={aplicando} onClick={() => setSelecionados(new Set())}>
            Limpar seleção
          </button>
        </div>
      )}

      {aviso && <div className="card" style={{ marginBottom: 16 }}>{aviso}</div>}

      <div className="card">
        <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <th><Checkbox checked={todosDaPaginaSelecionados} onChange={alternarPagina} /></th>
              <th />
              <ThOrdenavel coluna="referencia" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Referência</ThOrdenavel>
              <ThOrdenavel coluna="descricao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Descrição</ThOrdenavel>
              <ThOrdenavel coluna="marca" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Marca</ThOrdenavel>
              <ThOrdenavel coluna="categoria" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Categoria</ThOrdenavel>
              <ThOrdenavel coluna="marketplace" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Marketplace</ThOrdenavel>
              <ThOrdenavel coluna="preco" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Preço</ThOrdenavel>
              <ThOrdenavel coluna="margem" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Margem</ThOrdenavel>
              <ThOrdenavel coluna="status" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Status</ThOrdenavel>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && produtos.length === 0 && <SkeletonLinhasTabela colunas={11} />}
            {tabela.itensPagina.map((p) => (
              <tr key={p.id} className="clickable-row" onClick={() => navigate(`/produtos/${p.id}`)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <Checkbox checked={selecionados.has(p.id)} onChange={() => alternarSelecao(p.id)} />
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <FotoProduto produtoId={p.id} temFoto={p.temFoto} size={36} alt={p.descricao} />
                </td>
                <td className="mono">{p.referencia}</td>
                <td>{p.descricao}</td>
                <td>{p.marca}</td>
                <td>{p.categoria}</td>
                <td>{p.marketplace ? <span className="stamp sm tone-neutro"><Store size={11} /> sim</span> : ''}</td>
                <td className="mono">{brl(p.precoAtivo)}</td>
                <td className="mono">{pct(p.lucroPct)}</td>
                <td><span className={'stamp sm ' + statusToneClass(p.status)}>{p.status}</span></td>
                <td>
                  <Link to={`/produtos/${p.id}`} className="icon-btn" style={{ color: 'var(--ink-soft)' }}>
                    <ChevronRight size={16} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </DataTable>
        {!loading && produtos.length === 0 && (
          <EstadoVazio
            Icone={PackageSearch}
            titulo={busca || marca || categoria || marketplace ? 'Nenhum produto encontrado' : 'Nenhum produto cadastrado ainda'}
            descricao={busca || marca || categoria || marketplace
              ? 'Tente outro termo de busca ou limpe os filtros.'
              : 'Aqui aparecem as referências cadastradas, com custo, preço e margem de cada uma.'}
            href="/produtos/novo"
            acaoLabel="Novo produto"
            IconeAcao={Plus}
          />
        )}
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
