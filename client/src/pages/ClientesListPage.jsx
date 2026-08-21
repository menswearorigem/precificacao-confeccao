import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Search } from 'lucide-react';
import { api } from '../api/client';
import DataTable from '../components/DataTable';
import { SkeletonLinhasTabela } from '../components/ui';

export default function ClientesListPage() {
  const navigate = useNavigate();
  const [clientes, setClientes] = useState([]);
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    api.get(`/clientes?${params.toString()}`).then((data) => {
      setClientes(data);
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
          <h2>Clientes</h2>
          <p className="page-sub">Cadastro de clientes usado nos pedidos de venda.</p>
        </div>
        <Link to="/clientes/novo" className="btn btn-primary">
          <Plus size={14} /> Novo cliente
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
        <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>CPF/CNPJ</th>
              <th>Telefone</th>
              <th>Cidade/UF</th>
              <th>Vendedor</th>
              <th>Ativo?</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && clientes.length === 0 && <SkeletonLinhasTabela colunas={7} />}
            {clientes.map((c) => (
              <tr key={c.id} className="clickable-row" onClick={() => navigate(`/clientes/${c.id}`)}>
                <td>{c.nome}</td>
                <td className="mono">{c.cpf_cnpj}</td>
                <td className="mono">{c.telefone}</td>
                <td>{[c.cidade, c.uf].filter(Boolean).join('/')}</td>
                <td>{c.vendedor}</td>
                <td>{c.ativo ? 'Sim' : 'Não'}</td>
                <td>
                  <Link to={`/clientes/${c.id}`} className="icon-btn" style={{ color: 'var(--ink-soft)' }} onClick={(e) => e.stopPropagation()}>
                    <ChevronRight size={16} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </DataTable>
        {!loading && clientes.length === 0 && (
          <div style={{ padding: '20px 4px', color: 'var(--ink-soft)', fontSize: 13 }}>
            Nenhum cliente encontrado.
          </div>
        )}
      </div>
    </div>
  );
}
