import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { NumInput, Toggle } from '../components/ui';
import { pct } from '../lib/format';

export default function TaxasVendaPage() {
  const [taxas, setTaxas] = useState([]);
  const [totalPct, setTotalPct] = useState(0);

  function load() {
    api.get('/taxas-venda').then((data) => {
      setTaxas(data.taxas);
      setTotalPct(data.totalPct);
    });
  }

  useEffect(load, []);

  function recomputeTotal(list) {
    setTotalPct(list.filter((t) => t.ativo).reduce((s, t) => s + Number(t.percentual), 0));
  }

  async function update(id, patch) {
    setTaxas((list) => {
      const next = list.map((t) => (t.id === id ? { ...t, ...patch } : t));
      recomputeTotal(next);
      return next;
    });
    await api.put(`/taxas-venda/${id}`, patch);
  }

  async function addTaxa() {
    const created = await api.post('/taxas-venda', { nome: 'Nova taxa', ativo: false, percentual: 0, ordem: taxas.length + 1 });
    setTaxas((list) => [...list, created]);
  }

  async function removeTaxa(id) {
    await api.del(`/taxas-venda/${id}`);
    setTaxas((list) => {
      const next = list.filter((t) => t.id !== id);
      recomputeTotal(next);
      return next;
    });
  }

  return (
    <div className="page-wide">
      <h2>Taxas de Venda</h2>
      <p className="page-sub">Marketplaces, cartão, antecipação etc. Ative apenas as que se aplicam a cada canal.</p>

      <table className="data-table">
        <thead>
          <tr><th>Canal / Taxa</th><th>Ativa?</th><th>% sobre o preço</th><th /></tr>
        </thead>
        <tbody>
          {taxas.map((t) => (
            <tr key={t.id}>
              <td><input value={t.nome} onChange={(e) => update(t.id, { nome: e.target.value })} /></td>
              <td>
                <label className="toggle">
                  <Toggle checked={t.ativo} onChange={(e) => update(t.id, { ativo: e.target.checked })} />
                  {t.ativo ? 'Sim' : 'Não'}
                </label>
              </td>
              <td>
                <NumInput value={t.percentual * 100} onChange={(v) => update(t.id, { percentual: (Number(v) || 0) / 100 })} suffix="%" />
              </td>
              <td><button className="icon-btn" onClick={() => removeTaxa(t.id)}><Trash2 size={13} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-dashed" style={{ marginTop: 10 }} onClick={addTaxa}>
        <Plus size={13} /> Adicionar taxa
      </button>

      <div className="total-banner">
        % total de taxas ativas sobre o preço de venda
        <span className="mono">{pct(totalPct)}</span>
      </div>
    </div>
  );
}
