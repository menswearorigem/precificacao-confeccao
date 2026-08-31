import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { NumInput, Select } from '../components/ui';

const MARKETPLACES = [
  { key: 'mercado_livre', label: 'Mercado Livre' },
  { key: 'shopee', label: 'Shopee' },
];

// percentual guardado como fração (ex: 0.14) vira "14" na tela — arredonda
// pra não mostrar ruído de ponto flutuante (0.14 * 100 = 14.000000000000002).
function paraPct(fracao) {
  return Math.round(Number(fracao) * 1000000) / 10000;
}

export default function MarketplaceTaxasPage() {
  const [marketplace, setMarketplace] = useState('mercado_livre');
  const [comissaoFaixas, setComissaoFaixas] = useState([]);
  const [freteFaixas, setFreteFaixas] = useState([]);
  const [mostrarFrete, setMostrarFrete] = useState(false);

  function load() {
    api.get('/marketplace-taxas').then((data) => {
      setComissaoFaixas(data.comissaoFaixas);
      setFreteFaixas(data.freteFaixas);
    });
  }

  useEffect(load, []);

  async function updateComissao(id, patch) {
    setComissaoFaixas((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    await api.put(`/marketplace-taxas/comissao/${id}`, patch);
  }

  async function addComissao() {
    const created = await api.post('/marketplace-taxas/comissao', {
      marketplace,
      tipo_anuncio: marketplace === 'mercado_livre' ? 'classico' : null,
      valor_min: 0,
      valor_max: null,
      comissao_pct: 0,
      comissao_fixa: 0,
      subsidio_pix_pct: 0,
      ordem: comissaoFaixas.filter((f) => f.marketplace === marketplace).length + 1,
    });
    setComissaoFaixas((list) => [...list, created]);
  }

  async function removeComissao(id) {
    await api.del(`/marketplace-taxas/comissao/${id}`);
    setComissaoFaixas((list) => list.filter((f) => f.id !== id));
  }

  async function updateFrete(id, patch) {
    setFreteFaixas((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    await api.put(`/marketplace-taxas/frete/${id}`, patch);
  }

  async function addFrete() {
    const created = await api.post('/marketplace-taxas/frete', {
      marketplace,
      peso_min_kg: 0,
      peso_max_kg: null,
      valor_min: 0,
      valor_max: null,
      custo_frete: 0,
      ordem: freteFaixas.filter((f) => f.marketplace === marketplace).length + 1,
    });
    setFreteFaixas((list) => [...list, created]);
  }

  async function removeFrete(id) {
    await api.del(`/marketplace-taxas/frete/${id}`);
    setFreteFaixas((list) => list.filter((f) => f.id !== id));
  }

  const comissaoDoMarketplace = comissaoFaixas.filter((f) => f.marketplace === marketplace);
  const freteDoMarketplace = freteFaixas.filter((f) => f.marketplace === marketplace);

  return (
    <div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Tabelas de comissão e frete que o Mercado Livre e a Shopee cobram dos vendedores — usadas na
        aba Vendas → Taxas de Marketplace pra conferir se a cobrança real bate com o esperado. Ajuste
        aqui sempre que o marketplace anunciar reajuste.
      </p>

      <div className="shell-nav" style={{ marginBottom: 16 }}>
        {MARKETPLACES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={'nav-link' + (marketplace === m.key ? ' active' : '')}
            onClick={() => setMarketplace(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Comissão</div>
        <table className="data-table">
          <thead>
            <tr>
              {marketplace === 'mercado_livre' && <th>Tipo de anúncio</th>}
              <th>Valor do item (de)</th>
              <th>Valor do item (até)</th>
              <th>Comissão %</th>
              <th>Comissão fixa R$</th>
              {marketplace === 'shopee' && <th>Subsídio Pix %</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {comissaoDoMarketplace.map((f) => (
              <tr key={f.id}>
                {marketplace === 'mercado_livre' && (
                  <td>
                    <Select value={f.tipo_anuncio || 'classico'} onChange={(e) => updateComissao(f.id, { tipo_anuncio: e.target.value })}>
                      <option value="classico">Clássico</option>
                      <option value="premium">Premium</option>
                    </Select>
                  </td>
                )}
                <td><NumInput value={f.valor_min} onChange={(v) => updateComissao(f.id, { valor_min: v })} /></td>
                <td><NumInput value={f.valor_max ?? ''} onChange={(v) => updateComissao(f.id, { valor_max: v === '' ? null : v })} placeholder="sem teto" /></td>
                <td><NumInput value={paraPct(f.comissao_pct)} onChange={(v) => updateComissao(f.id, { comissao_pct: (Number(v) || 0) / 100 })} suffix="%" /></td>
                <td><NumInput value={f.comissao_fixa} onChange={(v) => updateComissao(f.id, { comissao_fixa: v })} /></td>
                {marketplace === 'shopee' && (
                  <td><NumInput value={paraPct(f.subsidio_pix_pct)} onChange={(v) => updateComissao(f.id, { subsidio_pix_pct: (Number(v) || 0) / 100 })} suffix="%" /></td>
                )}
                <td><button className="icon-btn" onClick={() => removeComissao(f.id)}><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {comissaoDoMarketplace.length === 0 && <tr><td colSpan="6">Nenhuma faixa cadastrada.</td></tr>}
          </tbody>
        </table>
        <button className="btn btn-dashed" style={{ marginTop: 10 }} onClick={addComissao}>
          <Plus size={13} /> Adicionar faixa
        </button>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Frete Subsidiado ({freteDoMarketplace.length} faixas)</div>
          <button className="btn btn-ghost" onClick={() => setMostrarFrete((v) => !v)}>
            {mostrarFrete ? 'Ocultar tabela' : 'Ver tabela'}
          </button>
        </div>
        <p className="page-sub">
          Custo de Mercado Envios / Frete Grátis por peso e faixa de valor do pedido — só entra na
          conta se o produto tiver peso cadastrado e a loja usar frete subsidiado (configurável em
          Integrações).
        </p>

        {mostrarFrete && (
          <>
            <table className="data-table">
              <thead>
                <tr><th>Peso (de)</th><th>Peso (até)</th><th>Valor pedido (de)</th><th>Valor pedido (até)</th><th>Custo frete R$</th><th /></tr>
              </thead>
              <tbody>
                {freteDoMarketplace.map((f) => (
                  <tr key={f.id}>
                    <td><NumInput value={f.peso_min_kg} onChange={(v) => updateFrete(f.id, { peso_min_kg: v })} suffix="kg" /></td>
                    <td><NumInput value={f.peso_max_kg ?? ''} onChange={(v) => updateFrete(f.id, { peso_max_kg: v === '' ? null : v })} suffix="kg" placeholder="sem teto" /></td>
                    <td><NumInput value={f.valor_min} onChange={(v) => updateFrete(f.id, { valor_min: v })} /></td>
                    <td><NumInput value={f.valor_max ?? ''} onChange={(v) => updateFrete(f.id, { valor_max: v === '' ? null : v })} placeholder="sem teto" /></td>
                    <td><NumInput value={f.custo_frete} onChange={(v) => updateFrete(f.id, { custo_frete: v })} /></td>
                    <td><button className="icon-btn" onClick={() => removeFrete(f.id)}><Trash2 size={13} /></button></td>
                  </tr>
                ))}
                {freteDoMarketplace.length === 0 && <tr><td colSpan="6">Nenhuma faixa cadastrada.</td></tr>}
              </tbody>
            </table>
            <button className="btn btn-dashed" style={{ marginTop: 10 }} onClick={addFrete}>
              <Plus size={13} /> Adicionar faixa
            </button>
          </>
        )}
      </div>
    </div>
  );
}
