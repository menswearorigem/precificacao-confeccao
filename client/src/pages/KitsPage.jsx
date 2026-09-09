import { useEffect, useState } from 'react';
import { Plus, Trash2, Boxes, Pencil, X } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, uid, formatQtd } from '../lib/format';
import { Select } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';

// Formulário de kit manual — cria e edita (09/09/2026).
//
// POR QUE: a rota PUT /kits/manuais/:id existia e nenhuma tela chamava. Errar
// uma referência ou a quantidade de um kit obrigava a apagar o kit e montar
// tudo de novo. O mesmo formulário agora serve para os dois casos: sem `kit`
// ele cria, com `kit` ele edita.
function KitManualForm({ produtos, kit, onPronto, onCancelar }) {
  const editando = Boolean(kit);
  const [nome, setNome] = useState(kit ? kit.nome : '');
  const [itens, setItens] = useState(() => (
    kit && kit.itens && kit.itens.length > 0
      ? kit.itens.map((i) => ({ _key: uid(), produtoId: String(i.produtoId ?? i.produto_id ?? ''), quantidade: i.quantidade }))
      : [{ _key: uid(), produtoId: '', quantidade: 1 }]
  ));
  // O desconto guardado é fração (0,12) e o campo é percentual (12). Sem essa
  // conversão na abertura, editar um kit reescrevia 0,12 como 0,0012.
  const [descontoOverride, setDescontoOverride] = useState(
    kit && kit.descontoPctOverride !== null && kit.descontoPctOverride !== undefined
      ? String(Number(kit.descontoPctOverride) * 100)
      : ''
  );
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

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
    const corpo = {
      nome,
      desconto_pct_override: descontoOverride === '' ? null : Number(descontoOverride) / 100,
      itens: itensValidos.map((i) => ({ produtoId: Number(i.produtoId), quantidade: Number(i.quantidade) || 1 })),
    };
    setSalvando(true);
    try {
      if (editando) await api.put(`/kits/manuais/${kit.id}`, corpo);
      else await api.post('/kits/manuais', corpo);
      if (!editando) {
        setNome('');
        setItens([{ _key: uid(), produtoId: '', quantidade: 1 }]);
        setDescontoOverride('');
      }
      onPronto();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 16 }}>
      <div className="card-head">{editando ? `Editando "${kit.nome}"` : 'Novo kit manual'}</div>
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
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={salvando}>
          {salvando ? 'Salvando…' : (editando ? 'Salvar alterações' : 'Criar kit')}
        </button>
        {editando && (
          <button type="button" className="btn btn-ghost" onClick={onCancelar} disabled={salvando}>
            <X size={13} /> Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

function KitManualCard({ kit, produtos, onRemovido, onAlterado }) {
  const [editando, setEditando] = useState(false);
  // A remoção não tinha catch: falhando (kit em uso, sessão caída), o botão
  // simplesmente não fazia nada e o kit continuava na tela sem explicação.
  const [erro, setErro] = useState('');

  async function handleRemover() {
    if (!(await confirmar(`Remover o kit "${kit.nome}"?`))) return;
    setErro('');
    try {
      await api.del(`/kits/manuais/${kit.id}`);
      onRemovido();
    } catch (e) {
      setErro(e.message);
    }
  }

  if (editando) {
    return (
      <KitManualForm
        produtos={produtos}
        kit={kit}
        onPronto={() => { setEditando(false); onAlterado(); }}
        onCancelar={() => setEditando(false)}
      />
    );
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head-linha">
        <div className="card-head">{kit.nome}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="icon-btn" title="Editar kit" aria-label={`Editar o kit ${kit.nome}`} onClick={() => setEditando(true)}><Pencil size={14} /></button>
          <button type="button" className="icon-btn" title="Remover kit" aria-label={`Remover o kit ${kit.nome}`} onClick={handleRemover}><Trash2 size={14} /></button>
        </div>
      </div>
      {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}
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
  // Nenhuma das quatro chamadas tinha catch: falhando, a tela ficava em branco
  // e parecia que não havia kit nenhum cadastrado.
  const [erroCarga, setErroCarga] = useState('');

  function loadManuais() {
    api.get('/kits/manuais').then(setManuais).catch((e) => setErroCarga(e.message));
  }

  useEffect(() => {
    api.get('/kits/automaticos').then(setAutomaticos).catch((e) => setErroCarga(e.message));
    loadManuais();
    api.get('/produtos').then(setProdutos).catch((e) => setErroCarga(e.message));
  }, []);

  return (
    <div className="page-wide">
      <h1>Kits para Marketplace</h1>
      {erroCarga && <p className="login-error">{erroCarga}</p>}
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
      <KitManualForm produtos={produtos} onPronto={loadManuais} />
      {manuais.length === 0 && (
        <p className="page-sub">Nenhum kit manual montado ainda. Use o formulário acima para combinar referências diferentes num kit.</p>
      )}
      {manuais.map((kit) => (
        <KitManualCard key={kit.id} kit={kit} produtos={produtos} onRemovido={loadManuais} onAlterado={loadManuais} />
      ))}
    </div>
  );
}
