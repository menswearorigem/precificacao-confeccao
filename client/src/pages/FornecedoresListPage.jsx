import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Search } from 'lucide-react';
import { api } from '../api/client';
import { SkeletonLinhasTabela } from '../components/ui';

export default function FornecedoresListPage() {
  const navigate = useNavigate();
  const [fornecedores, setFornecedores] = useState([]);
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    api.get(`/fornecedores?${params.toString()}`).then((data) => {
      setFornecedores(data);
      setLoading(false);
    });
  }

  useEffect(load, []);

  function handleBuscaSubmit(e) {
    e.preventDefault();
    load();
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Fornecedores</h2>
          <p className="page-sub">Cadastro de fornecedores usado nos lançamentos de compra.</p>
        </div>
        <Link to="/fornecedores/novo" className="btn btn-primary">
          <Plus size={14} /> Novo fornecedor
        </Link>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handleBuscaSubmit} style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="Buscar por nome, CPF/CNPJ ou telefone"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
        </form>
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>CPF/CNPJ</th>
              <th>Telefone</th>
              <th>Categoria Principal</th>
              <th>Ativo?</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && fornecedores.length === 0 && <SkeletonLinhasTabela colunas={6} />}
            {fornecedores.map((f) => (
              <tr key={f.id} className="clickable-row" onClick={() => navigate(`/fornecedores/${f.id}`)}>
                <td>{f.nome}</td>
                <td className="mono">{f.cpf_cnpj}</td>
                <td className="mono">{f.telefone}</td>
                <td>{f.categoria_principal}</td>
                <td>{f.ativo ? 'Sim' : 'Não'}</td>
                <td>
                  <Link to={`/fornecedores/${f.id}`} className="icon-btn" style={{ color: 'var(--ink-soft)' }} onClick={(e) => e.stopPropagation()}>
                    <ChevronRight size={16} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && fornecedores.length === 0 && (
          <div style={{ padding: '20px 4px', color: 'var(--ink-soft)', fontSize: 13 }}>
            Nenhum fornecedor encontrado.
          </div>
        )}
      </div>
    </div>
  );
}
