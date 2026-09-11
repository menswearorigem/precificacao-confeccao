import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, Search, Users, DownloadCloud } from 'lucide-react';
import { api } from '../api/client';
import DataTable from '../components/DataTable';
import { SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio } from '../components/ui';
import { useTabela } from '../lib/useTabela';
import { brl } from '../lib/format';
import { novaAba } from '../lib/novaAba';

// Data do pedido (coluna DATE) formatada como o resto do sistema formata.
const dataPedidoBr = (v) => (v ? new Date(v).toLocaleDateString('pt-BR') : '');

// Ordenação: cliente sem compra tem que ir para o fim das duas ordens, não
// competir com quem comprou R$ 0,00. -Infinity/Infinity conforme a direção não
// dá pra fazer aqui, então o "nunca comprou" vira -1 (abaixo de qualquer
// total, que nunca é negativo) e época 0 (antes de qualquer data real).
const COLUNAS_ORDENAVEIS = {
  nome: (c) => c.nome,
  cpf_cnpj: (c) => c.cpf_cnpj,
  telefone: (c) => c.telefone,
  cidade: (c) => c.cidade,
  vendedor: (c) => c.vendedor,
  total_comprado: (c) => (c.total_comprado === null || c.total_comprado === undefined ? -1 : Number(c.total_comprado)),
  ultima_compra: (c) => (c.ultima_compra ? new Date(c.ultima_compra).getTime() : 0),
  ativo: (c) => (c.ativo ? 1 : 0),
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nome', valor: (c) => c.nome },
  { rotulo: 'CPF/CNPJ', valor: (c) => c.cpf_cnpj },
  { rotulo: 'Telefone', valor: (c) => c.telefone },
  { rotulo: 'Cidade/UF', valor: (c) => [c.cidade, c.uf].filter(Boolean).join('/') },
  { rotulo: 'Vendedor', valor: (c) => c.vendedor },
  { rotulo: 'Pedidos', valor: (c) => c.total_pedidos ?? 0 },
  { rotulo: 'Total comprado', valor: (c) => (c.total_comprado === null || c.total_comprado === undefined ? '' : c.total_comprado) },
  { rotulo: 'Ticket médio', valor: (c) => (c.ticket_medio === null || c.ticket_medio === undefined ? '' : c.ticket_medio) },
  { rotulo: 'Última compra', valor: (c) => dataPedidoBr(c.ultima_compra) },
  { rotulo: 'Ativo?', valor: (c) => (c.ativo ? 'Sim' : 'Não') },
];

export default function ClientesListPage() {
  const navigate = useNavigate();
  const [clientes, setClientes] = useState([]);
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(true);
  const [erroCarga, setErroCarga] = useState('');
  const [impWik, setImpWik] = useState(false);
  const [avisoWik, setAvisoWik] = useState('');

  // Estado próprio (não `erroCarga`): load(), chamado logo abaixo, zera
  // erroCarga no próprio início — reaproveitar o mesmo estado apagaria esta
  // mensagem antes de ela chegar a aparecer na tela.
  async function importarWik() {
    setImpWik(true); setAvisoWik('');
    try {
      const r = await api.post('/clientes/importar-wik', {});
      const p = [];
      if (r.criados) p.push(`${r.criados} criados`);
      if (r.vinculados) p.push(`${r.vinculados} vinculados`);
      if (r.atualizados) p.push(`${r.atualizados} atualizados`);
      if (r.jaExistiam) p.push(`${r.jaExistiam} já existiam`);
      setAvisoWik(`Clientes do Wik: ${p.join(', ') || (r.pulado || 'nada a importar')}.`);
      load();
    } catch (e) { setAvisoWik('Erro: ' + e.message); }
    finally { setImpWik(false); }
  }

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    setErroCarga('');
    api.get(`/clientes?${params.toString()}`)
      .then((data) => { setClientes(data); })
      // Sem catch, uma falha (sessão expirada, servidor fora) deixava a tela
      // no esqueleto para sempre, sem nenhuma mensagem.
      .catch((e) => setErroCarga(e.message))
      .finally(() => setLoading(false));
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
          <h1>Clientes</h1>
          <p className="page-sub">Cadastro de clientes usado nos pedidos de venda.</p>
        </div>

      {erroCarga && <p className="login-error">{erroCarga}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <BotaoExportar nomeBase="clientes" colunas={COLUNAS_EXPORTACAO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
          <button type="button" className="btn btn-ghost" onClick={importarWik} disabled={impWik}
            title="Importa os clientes do Wik pela API. Editar um cliente aqui desliga a sincronização dele.">
            <DownloadCloud size={14} /> {impWik ? 'Importando…' : 'Importar do Wik'}
          </button>
          <Link to="/clientes/novo" className="btn btn-primary">
            <Plus size={14} /> Novo cliente
          </Link>
        </div>
      </div>

      {avisoWik && <p className="aviso-inline" style={{ marginBottom: 8 }}>{avisoWik}</p>}

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
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <ThOrdenavel coluna="nome" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nome</ThOrdenavel>
              <ThOrdenavel coluna="cpf_cnpj" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>CPF/CNPJ</ThOrdenavel>
              <ThOrdenavel coluna="telefone" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Telefone</ThOrdenavel>
              <ThOrdenavel coluna="cidade" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cidade/UF</ThOrdenavel>
              <ThOrdenavel coluna="vendedor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Vendedor</ThOrdenavel>
              <ThOrdenavel coluna="total_comprado" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Total comprado</ThOrdenavel>
              <ThOrdenavel coluna="ultima_compra" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Última compra</ThOrdenavel>
              <ThOrdenavel coluna="ativo" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Ativo?</ThOrdenavel>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && clientes.length === 0 && <SkeletonLinhasTabela colunas={9} />}
            {tabela.itensPagina.map((c) => (
              <tr key={c.id} className="clickable-row" {...novaAba(`/clientes/${c.id}`)} onClick={() => navigate(`/clientes/${c.id}`)}>
                <td>{c.nome}</td>
                <td className="mono">{c.cpf_cnpj}</td>
                <td className="mono">{c.telefone}</td>
                <td>{[c.cidade, c.uf].filter(Boolean).join('/')}</td>
                <td>{c.vendedor}</td>
                <td className="num">
                  {c.total_comprado === null || c.total_comprado === undefined
                    ? <span style={{ color: 'var(--ink-faint)' }}>nunca comprou</span>
                    : (
                      <>
                        {brl(c.total_comprado)}
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-soft)' }}>
                          {c.total_pedidos} ped. · {brl(c.ticket_medio)} méd.
                        </span>
                      </>
                    )}
                </td>
                <td className="num">{dataPedidoBr(c.ultima_compra) || <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
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
          <EstadoVazio
            Icone={Users}
            titulo={busca ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado ainda'}
            descricao={busca
              ? 'Tente buscar por outro nome, CPF/CNPJ ou telefone.'
              : 'Aqui aparecem os clientes usados nos pedidos de venda.'}
            href="/clientes/novo"
            acaoLabel="Novo cliente"
            IconeAcao={Plus}
          />
        )}
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
