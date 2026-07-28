import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput } from '../components/ui';
import { brl } from '../lib/format';

export default function CustosIndiretosPage() {
  const [resumo, setResumo] = useState(null);

  function load() {
    api.get('/custos-indiretos').then(setResumo);
  }

  useEffect(load, []);

  async function updateItem(id, patch) {
    const updated = await api.put(`/custos-indiretos/${id}`, patch);
    setResumo(updated);
  }

  async function addItem() {
    const updated = await api.post('/custos-indiretos', { nome: 'Novo item', valor_mensal: 0, ordem: (resumo?.itens.length || 0) + 1 });
    setResumo(updated);
  }

  async function removeItem(id) {
    const updated = await api.del(`/custos-indiretos/${id}`);
    setResumo(updated);
  }

  async function updateProducao(v) {
    const updated = await api.put('/custos-indiretos/producao-mensal', { producao_mensal_pecas: v });
    setResumo(updated);
  }

  if (!resumo) return <div className="page">Carregando…</div>;

  return (
    <div className="page-wide">
      <h2>Custos Indiretos — Rateio Mensal</h2>
      <p className="page-sub">
        Total mensal dividido pela produção mensal, aplicado igualmente a todas as peças cadastradas.
      </p>

      <table className="data-table">
        <thead><tr><th>Item de custo fixo mensal</th><th>Valor mensal</th><th /></tr></thead>
        <tbody>
          {resumo.itens.map((i) => (
            <tr key={i.id}>
              <td><input value={i.nome} onChange={(e) => updateItem(i.id, { nome: e.target.value })} /></td>
              <td><NumInput value={i.valor_mensal} onChange={(v) => updateItem(i.id, { valor_mensal: v })} suffix="R$" /></td>
              <td><button className="icon-btn" onClick={() => removeItem(i.id)}><Trash2 size={13} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-dashed" style={{ marginTop: 10 }} onClick={addItem}>
        <Plus size={13} /> Adicionar item
      </button>

      <div className="form-grid" style={{ marginTop: 18 }}>
        <Field label="Quantidade produzida no mês (peças)">
          <NumInput value={resumo.producaoMensal} onChange={updateProducao} step="1" />
        </Field>
      </div>

      <div className="total-banner">
        Total de custos indiretos / mês <span className="mono">{brl(resumo.totalMensal)}</span>
      </div>
      <div className="total-banner">
        Custo indireto por peça <span className="mono">{brl(resumo.custoPorPeca)}</span>
      </div>
    </div>
  );
}
