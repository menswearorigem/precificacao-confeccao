import { useEffect, useState } from 'react';
import { Plus, Trash2, Boxes } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, uid, formatQtd } from '../lib/format';
import { Select } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';

function NovoKitForm({ produtos, onCriado }) {
  const [nome, setNome] = useState('');
  const [itens, setItens] = useState([{ _key: uid(), produtoId: '', quantidade: 1 }]);
  const [descontoOverride, setDescontoOverride] = useState('');
  const [erro, setErro] = useState('');

  function updateItem(key, patch) {
    setItens((list) => list.map((i) => (i._key === key ? { ...i, ...patch } : i)));
  }
  function addItem() {
    setItens((list) => [...list, { _key: uid(), produtoId: '', quantidade: 1 }]);
  }
  function removeItem(key) {
    setItens((list) => list.filter((i) => i._key !== key));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    const itensValidos = itens.filter((i) => i.produtoId);
    if (!nome.trim()) return setErro('Dê um nome ao kit.');
    if (itensValidos.length === 0) return setErro('Inclua ao menos uma referência.');
    try {
      await api.post('/kits/manuais', {
        nome,
        desconto_pct_override: descontoOverride === '' ? null : Number(descontoOverride) / 100,
        itens: itensValidos.map((i) => ({ produtoId: Number(i.produtoId), quantidade: Number(i.quantidade) || 1 })),
      });
      setNome('');
      setItens([{ _key: uid(), produtoId: '', quantidade: 1 }]);
      setDescontoOverride('');
      onCriado();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
      <div className="card-head">Novo kit manual</div>
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <div className="field">
          <span className="field-label">Nome do Kit</span>
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Kit Sortido Verão" />
        </div>
        <div className="field">
          <span className="field-label">% desconto (opcional — deixe em branco para usar o padrão)</span>
          <input type="number" value={descontoOverride} onChange={(e) => setDescontoOverride(e.target.value)} />
        </div>
      </div>

      <table className="data-table">
        <thead><tr><th>Referência</th><th>Quantidade</th><th /></tr></thead>
        <tbody>
          {itens.map((item) => (
            <tr key={item._key}>
              <td>
                <Select value={item.produtoId} onChange={(e) => updateItem(item._key, { produtoId: e.target.value })}>
                  <option value="">Selecione…</option>
                  {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
                </Select>
              </td>
              <td><input type="number" min="1" value={item.quantidade} onChange={(e) => updateItem(item._key, { quantidade: e.target.value })} /></td>
              <td><button type="button" className="icon-btn" onClick={() => removeItem(item._key)}><Trash2 size={13} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="btn btn-dashed" style={{ marginTop: 8 }} onClick={addItem}>
        <Plus size={13} /> Adicionar referência
      </button>

      {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
      <div style={{ marginTop: 12 }}>
        <button className="btn btn-primary" type="submit">Criar kit</button>
      </div>
    </form>
  );
}

function KitManualCard({ kit, onRemovido }) {
  async function handleRemover() {
    if (!(await confirmar(`Remover o kit "${kit.nome}"?`))) return;
    await api.del(`/kits/manuais/${kit.id}`);
    onRemovido();
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head-linha">
        <div className="card-head">{kit.nome}</div>
        <button className="icon-btn" onClick={handleRemover}><Trash2 size={14} /></button>
      </div>
      <table className="data-table">
        <thead><tr><th>Referência</th><th>Qtd</th><th>Custo unit.</th><th>Preço unit.</th></tr></thead>
        <tbody>
          {kit.itens.map((item) => (
            <tr key={item.id}>
              <td className="mono">{item.referencia}</td>
              <td className="mono">{formatQtd(item.quantidade)}</td>
              <td className="mono">{brl(item.custoUnitario)}</td>
              <td className="mono">{brl(item.precoUnitSugerido)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="total-banner" style={{ background: 'var(--border-soft)', color: 'var(--ink)' }}>
        Custo total do kit <span className="mono">{brl(kit.custoTotalKit)}</span>
      </div>
      <div className="total-banner" style={{ background: 'var(--border-soft)', color: 'var(--ink)' }}>
        Soma preços avulsos <span className="mono">{brl(kit.somaPrecosAvulsos)}</span>
      </div>
      <div className="total-banner">
        Preço sugerido do kit ({pct(kit.pctDesconto)} desconto) <span className="mono">{brl(kit.precoSugeridoKit)}</span>
      </div>
      <div className="total-banner" style={{ background: 'var(--success)' }}>
        Margem estimada <span className="mono">{pct(kit.margemEstimada)}</span>
      </div>
    </div>
  );
}

export default function KitsPage() {
  const [automaticos, setAutomaticos] = useState([]);
  const [manuais, setManuais] = useState([]);
  const [produtos, setProdutos] = useState([]);

  function loadManuais() {
    api.get('/kits/manuais').then(setManuais);
  }

  useEffect(() => {
    api.get('/kits/automaticos').then(setAutomaticos);
    loadManuais();
    api.get('/produtos').then(setProdutos);
  }, []);

  return (
    <div className="page-wide">
      <h2>Kits para Marketplace</h2>
      <p className="page-sub">
        Kits automáticos (2 a 8 peças da mesma referência) para Camiseta Dryfit, Camiseta Polo e
        Bermuda, e kits manuais combinando referências diferentes.
      </p>

      <h3 style={{ marginTop: 0 }}>Kits Automáticos</h3>
      {automaticos.length === 0 && (
        <p className="page-sub">Nenhuma referência de Camiseta Dryfit, Camiseta Polo ou Bermuda cadastrada ainda.</p>
      )}
      {automaticos.map((a) => (
        <div className="card" style={{ marginBottom: 16 }} key={a.produtoId}>
          <div className="card-head"><Boxes size={14} /> {a.referencia} — {a.descricao}</div>
          <table className="data-table">
            <thead>
              <tr><th>Peças</th><th>Custo total</th><th>Soma avulsos</th><th>% Desconto</th><th>Preço do kit</th><th>Margem</th></tr>
            </thead>
            <tbody>
              {a.kits.map((k) => (
                <tr key={k.pecas}>
                  <td>{k.pecas}</td>
                  <td className="mono">{brl(k.custoTotalKit)}</td>
                  <td className="mono">{brl(k.somaPrecosAvulsos)}</td>
                  <td className="mono">{pct(k.pctDesconto)}</td>
                  <td className="mono">{brl(k.precoSugeridoKit)}</td>
                  <td className="mono">{pct(k.margemEstimada)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <h3>Kits Manuais</h3>
      <NovoKitForm produtos={produtos} onCriado={loadManuais} />
      {manuais.map((kit) => (
        <KitManualCard key={kit.id} kit={kit} onRemovido={loadManuais} />
      ))}
    </div>
  );
}
