import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Search } from 'lucide-react';
import { api } from '../api/client';
import DataTable from '../components/DataTable';
import { SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar } from '../components/ui';
import { useTabela } from '../lib/useTabela';

const COLUNAS_ORDENAVEIS = {
  nome: (c) => c.nome,
  cpf_cnpj: (c) => c.cpf_cnpj,
  telefone: (c) => c.telefone,
  cidade: (c) => c.cidade,
  vendedor: (c) => c.vendedor,
  ativo: (c) => (c.ativo ? 1 : 0),
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nome', valor: (c) => c.nome },
  { rotulo: 'CPF/CNPJ', valor: (c) => c.cpf_cnpj },
  { rotulo: 'Telefone', valor: (c) => c.telefone },
  { rotulo: 'Cidade/UF', valor: (c) => [c.cidade, c.uf].filter(Boolean).join('/') },
  { rotulo: 'Vendedor', valor: (c) => c.vendedor },
  { rotulo: 'Ativo?', valor: (c) => (c.ativo ? 'Sim' : 'Não') },
];

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

  const tabela = useTabela(clientes, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'nome' });

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Clientes</h2>
          <p className="page-sub">Cadastro de clientes usado nos pedidos de venda.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <BotaoExportar nomeBase="clientes" colunas={COLUNAS_EXPORTACAO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
          <Link to="/clientes/novo" className="btn btn-primary">
            <Plus size={14} /> Novo cliente
          </Link>
        </div>
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
        {!loading && <p className="page-sub" style={{ margin: '10px 0 0' }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</p>}
      </div>

      <div className="card">
        <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <ThOrdenavel coluna="nome" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nome</ThOrdenavel>
              <ThOrdenavel coluna="cpf_cnpj" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>CPF/CNPJ</ThOrdenavel>
              <ThOrdenavel coluna="telefone" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Telefone</ThOrdenavel>
              <ThOrdenavel coluna="cidade" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cidade/UF</ThOrdenavel>
              <ThOrdenavel coluna="vendedor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Vendedor</ThOrdenavel>
              <ThOrdenavel coluna="ativo" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Ativo?</ThOrdenavel>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && clientes.length === 0 && <SkeletonLinhasTabela colunas={7} />}
            {tabela.itensPagina.map((c) => (
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
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
