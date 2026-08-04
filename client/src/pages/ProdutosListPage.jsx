import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Search } from 'lucide-react';
import { api } from '../api/client';
import { statusToneClass } from '../lib/statusTone';
import { brl, pct } from '../lib/format';
import FotoProduto from '../components/FotoProduto';

export default function ProdutosListPage() {
  const navigate = useNavigate();
  const [produtos, setProdutos] = useState([]);
  const [listas, setListas] = useState(null);
  const [marca, setMarca] = useState('');
  const [categoria, setCategoria] = useState('');
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/listas').then(setListas);
  }, []);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (marca) params.set('marca', marca);
    if (categoria) params.set('categoria', categoria);
    if (busca) params.set('busca', busca);
    api.get(`/produtos?${params.toString()}`).then((data) => {
      setProdutos(data);
      setLoading(false);
    });
  }

  useEffect(load, [marca, categoria]);

  function handleBuscaSubmit(e) {
    e.preventDefault();
    load();
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Produtos / Referências</h2>
          <p className="page-sub">Cadastro, custo e formação de preço de cada referência.</p>
        </div>
        <Link to="/produtos/novo" className="btn btn-primary">
          <Plus size={14} /> Novo produto
        </Link>
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
          <select value={marca} onChange={(e) => setMarca(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Todas as marcas</option>
            {listas?.marca.map((m) => <option key={m.id} value={m.valor}>{m.valor}</option>)}
          </select>
          <select value={categoria} onChange={(e) => setCategoria(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Todas as categorias</option>
            {listas?.categoria.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th />
              <th>Referência</th>
              <th>Descrição</th>
              <th>Marca</th>
              <th>Categoria</th>
              <th>Preço</th>
              <th>Margem</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {produtos.map((p) => (
              <tr key={p.id} className="clickable-row" onClick={() => navigate(`/produtos/${p.id}`)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <FotoProduto produtoId={p.id} temFoto={p.temFoto} size={36} alt={p.descricao} />
                </td>
                <td className="mono">{p.referencia}</td>
                <td>{p.descricao}</td>
                <td>{p.marca}</td>
                <td>{p.categoria}</td>
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
        {!loading && produtos.length === 0 && (
          <div style={{ padding: '20px 4px', color: 'var(--ink-soft)', fontSize: 13 }}>
            Nenhum produto encontrado.
          </div>
        )}
      </div>
    </div>
  );
}
