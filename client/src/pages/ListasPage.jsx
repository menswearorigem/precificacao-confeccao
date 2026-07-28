import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';

const TIPOS = [
  { tipo: 'categoria', label: 'Categorias' },
  { tipo: 'marca', label: 'Marcas' },
  { tipo: 'colecao', label: 'Coleções' },
  { tipo: 'linha', label: 'Linhas' },
  { tipo: 'material', label: 'Materiais' },
  { tipo: 'unidade', label: 'Unidades' },
  { tipo: 'tipo_custo_industrial', label: 'Tipos de Custo Industrial' },
];

export default function ListasPage() {
  const [tipoAtivo, setTipoAtivo] = useState('categoria');
  const [itens, setItens] = useState([]);
  const [novoValor, setNovoValor] = useState('');

  function load(tipo) {
    api.get(`/listas/${tipo}`).then(setItens);
  }

  useEffect(() => load(tipoAtivo), [tipoAtivo]);

  async function addValor(e) {
    e.preventDefault();
    if (!novoValor.trim()) return;
    const created = await api.post(`/listas/${tipoAtivo}`, { valor: novoValor.trim(), ordem: itens.length + 1 });
    setItens((list) => [...list, created]);
    setNovoValor('');
  }

  async function toggleAtivo(item) {
    const updated = await api.put(`/listas/${tipoAtivo}/${item.id}`, { ativo: !item.ativo });
    setItens((list) => list.map((i) => (i.id === item.id ? updated : i)));
  }

  async function remover(item) {
    await api.del(`/listas/${tipoAtivo}/${item.id}`);
    setItens((list) => list.filter((i) => i.id !== item.id));
  }

  return (
    <div className="page-wide">
      <h2>Listas</h2>
      <p className="page-sub">
        Valores usados nos menus suspensos em todo o sistema. Você pode desativar um valor sem
        perder o histórico dos produtos que já o usam, ou removê-lo por completo.
      </p>

      <div className="shell-nav" style={{ padding: 0, marginBottom: 18, background: 'transparent', border: 'none' }}>
        {TIPOS.map(({ tipo, label }) => (
          <button
            key={tipo}
            className={'nav-link' + (tipo === tipoAtivo ? ' active' : '')}
            style={{ border: 'none', background: tipo === tipoAtivo ? 'var(--surface)' : 'transparent', cursor: 'pointer' }}
            onClick={() => setTipoAtivo(tipo)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="card">
        <table className="data-table">
          <thead><tr><th>Valor</th><th>Ativo?</th><th /></tr></thead>
          <tbody>
            {itens.map((item) => (
              <tr key={item.id}>
                <td>{item.valor}</td>
                <td>
                  <label className="toggle">
                    <input type="checkbox" checked={item.ativo} onChange={() => toggleAtivo(item)} />
                    {item.ativo ? 'Sim' : 'Não'}
                  </label>
                </td>
                <td><button className="icon-btn" onClick={() => remover(item)}><Trash2 size={13} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>

        <form onSubmit={addValor} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            placeholder="Novo valor"
            value={novoValor}
            onChange={(e) => setNovoValor(e.target.value)}
          />
          <button className="btn btn-dashed" type="submit"><Plus size={13} /> Adicionar</button>
        </form>
      </div>
    </div>
  );
}
