import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { NumInput, Toggle } from '../components/ui';
import { brl, pct } from '../lib/format';

const VALOR_REFERENCIA = 100;

// Efeito de uma taxa sobre uma venda de referência — soma o componente
// percentual (sobre o valor) com o componente fixo (por venda), cada um só
// entrando na conta quando o `tipo` realmente o usa (campo tracejado não
// conta, mesmo que ainda tenha um valor antigo guardado).
function efeitoNaVenda(taxa, valorVenda) {
  const usaPct = taxa.tipo !== 'fixo';
  const usaFixo = taxa.tipo !== 'percentual';
  return (usaPct ? Number(taxa.percentual) * valorVenda : 0) + (usaFixo ? Number(taxa.valor_fixo) : 0);
}

const TIPO_OPCOES = [
  { valor: 'percentual', rotulo: '%' },
  { valor: 'fixo', rotulo: 'R$' },
  { valor: 'ambos', rotulo: '% + R$' },
];

function SeletorTipo({ valor, onChange, disabled }) {
  return (
    <div className="cfg-segmentado">
      {TIPO_OPCOES.map((o) => (
        <button
          key={o.valor}
          type="button"
          className={valor === o.valor ? 'is-ativo' : ''}
          disabled={disabled}
          onClick={() => onChange(o.valor)}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}

export default function TaxasVendaPage() {
  const [taxas, setTaxas] = useState([]);
  const [valorSimulado, setValorSimulado] = useState(VALOR_REFERENCIA);

  function load() {
    api.get('/taxas-venda').then((data) => setTaxas(data.taxas));
  }

  useEffect(load, []);

  async function update(id, patch) {
    setTaxas((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const atualizada = await api.put(`/taxas-venda/${id}`, patch);
    // O backend pode normalizar percentual/valor_fixo a 0 conforme o tipo
    // escolhido (ver normalizarPorTipo em taxasVenda.routes.js) — sincroniza
    // com o que realmente ficou gravado, não só o patch otimista.
    setTaxas((list) => list.map((t) => (t.id === id ? atualizada : t)));
  }

  async function addTaxa() {
    const created = await api.post('/taxas-venda', { nome: 'Nova taxa', ativo: false, tipo: 'percentual', percentual: 0, ordem: taxas.length + 1 });
    setTaxas((list) => [...list, created]);
  }

  async function removeTaxa(id) {
    await api.del(`/taxas-venda/${id}`);
    setTaxas((list) => list.filter((t) => t.id !== id));
  }

  const ativas = taxas.filter((t) => t.ativo);
  const totalSimulado = ativas.reduce((s, t) => s + efeitoNaVenda(t, Number(valorSimulado) || 0), 0);
  const recebeSimulado = (Number(valorSimulado) || 0) - totalSimulado;

  return (
    <div className="page-wide">
      <h2>Taxas de Venda</h2>
      <p className="page-sub">
        Tudo que é descontado do preço antes do dinheiro chegar. Cada taxa pode ser percentual, valor fixo, ou os dois.
      </p>

      <div className="card cfg-simulador">
        <div className="cfg-simulador-campo">
          <span className="cfg-simulador-campo-label">Numa venda de</span>
          <NumInput value={valorSimulado} onChange={setValorSimulado} suffix="R$" style={{ maxWidth: 130 }} />
        </div>
        <div className="cfg-simulador-resultado">
          <div className="cfg-simulador-resultado-item">
            <div className="cfg-simulador-resultado-label">Taxas</div>
            <div className="cfg-simulador-resultado-valor">- {brl(totalSimulado)}</div>
          </div>
        </div>
        <div className="cfg-simulador-recebe">
          <div className="cfg-simulador-recebe-label">Você recebe</div>
          <div className="cfg-simulador-recebe-valor">{brl(recebeSimulado)}</div>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Canal / Taxa</th>
            <th>Ativa?</th>
            <th>Como cobra</th>
            <th>% do preço</th>
            <th>R$ por venda</th>
            <th>Em {brl(VALOR_REFERENCIA)}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {taxas.map((t) => (
            <tr key={t.id} className="cfg-linha-hover">
              <td><input value={t.nome} onChange={(e) => update(t.id, { nome: e.target.value })} /></td>
              <td>
                <label className="toggle">
                  <Toggle checked={t.ativo} onChange={(e) => update(t.id, { ativo: e.target.checked })} />
                  {t.ativo ? 'Sim' : 'Não'}
                </label>
              </td>
              <td><SeletorTipo valor={t.tipo} onChange={(tipo) => update(t.id, { tipo })} /></td>
              <td className={t.tipo === 'fixo' ? 'cfg-campo-tracejado' : ''}>
                <NumInput
                  value={t.percentual * 100}
                  onChange={(v) => update(t.id, { percentual: (Number(v) || 0) / 100 })}
                  suffix="%"
                  disabled={t.tipo === 'fixo'}
                />
              </td>
              <td className={t.tipo === 'percentual' ? 'cfg-campo-tracejado' : ''}>
                <NumInput
                  value={t.valor_fixo}
                  onChange={(v) => update(t.id, { valor_fixo: Number(v) || 0 })}
                  suffix="R$"
                  disabled={t.tipo === 'percentual'}
                />
              </td>
              <td className="cfg-efeito-valor">- {brl(efeitoNaVenda(t, VALOR_REFERENCIA))}</td>
              <td>
                <button className="icon-btn cfg-lixeira" onClick={() => removeTaxa(t.id)}><Trash2 size={13} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-dashed" style={{ marginTop: 10 }} onClick={addTaxa}>
        <Plus size={13} /> Adicionar taxa
      </button>

      <div className="total-banner">
        Efeito total das taxas ativas numa venda de {brl(VALOR_REFERENCIA)}
        <span className="mono">{brl(ativas.reduce((s, t) => s + efeitoNaVenda(t, VALOR_REFERENCIA), 0))} ({pct(ativas.reduce((s, t) => s + efeitoNaVenda(t, VALOR_REFERENCIA), 0) / VALOR_REFERENCIA)})</span>
      </div>
    </div>
  );
}
