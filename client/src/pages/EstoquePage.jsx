import { useEffect, useState } from 'react';
import { Plus, ArrowUpCircle, ArrowDownCircle, Trash2, Search, Barcode, Upload, Pencil, Check, X, Tags, Printer, Wand2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Field, Select } from '../components/ui';

function EanEditavel({ variante, onFeito }) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(variante.ean);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  function iniciar() {
    setValor(variante.ean);
    setErro('');
    setEditando(true);
  }

  async function salvar() {
    setSalvando(true);
    setErro('');
    try {
      await api.put(`/estoque/variantes/${variante.id}/ean`, { ean: valor });
      setEditando(false);
      onFeito();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  if (!editando) {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="mono">{variante.ean}</span>
        <button className="icon-btn" title="Substituir EAN" onClick={iniciar}><Pencil size={12} /></button>
      </span>
    );
  }

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <input
        className="mono"
        autoFocus
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        style={{ width: 130 }}
      />
      <button className="icon-btn" title="Salvar" disabled={salvando} onClick={salvar} style={{ color: 'var(--success)' }}><Check size={13} /></button>
      <button className="icon-btn" title="Cancelar" disabled={salvando} onClick={() => setEditando(false)}><X size={13} /></button>
      {erro && <span className="login-error" style={{ marginLeft: 4 }}>{erro}</span>}
    </span>
  );
}

function NovaVarianteForm({ produtoId, onCriada }) {
  const [cor, setCor] = useState('');
  const [tamanho, setTamanho] = useState('');
  const [quantidade, setQuantidade] = useState(0);
  const [erro, setErro] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    try {
      await api.post('/estoque/variantes', { produto_id: produtoId, cor, tamanho, quantidade: Number(quantidade) || 0 });
      setCor('');
      setTamanho('');
      setQuantidade(0);
      onCriada();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }}>
      <Field label="Cor"><input value={cor} onChange={(e) => setCor(e.target.value)} style={{ width: 140 }} /></Field>
      <Field label="Tamanho"><input value={tamanho} onChange={(e) => setTamanho(e.target.value)} style={{ width: 90 }} /></Field>
      <Field label="Qtd. inicial"><input type="number" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} style={{ width: 90 }} /></Field>
      <button className="btn btn-dashed" type="submit"><Plus size={13} /> Adicionar variante</button>
      {erro && <span className="login-error">{erro}</span>}
    </form>
  );
}

function MovimentoInline({ variante, onFeito }) {
  const [quantidade, setQuantidade] = useState(1);
  const [motivo, setMotivo] = useState('');
  const [loading, setLoading] = useState(false);

  async function mover(tipo) {
    setLoading(true);
    try {
      await api.post(`/estoque/variantes/${variante.id}/movimento`, { tipo, quantidade: Number(quantidade) || 0, motivo });
      setMotivo('');
      onFeito();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number"
        min="0"
        value={quantidade}
        onChange={(e) => setQuantidade(e.target.value)}
        style={{ width: 64 }}
      />
      <input
        placeholder="motivo (opcional)"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        style={{ width: 140 }}
      />
      <button className="icon-btn" title="Entrada" disabled={loading} onClick={() => mover('entrada')} style={{ color: 'var(--success)' }}>
        <ArrowUpCircle size={18} />
      </button>
      <button className="icon-btn" title="Saída" disabled={loading} onClick={() => mover('saida')} style={{ color: 'var(--danger)' }}>
        <ArrowDownCircle size={18} />
      </button>
    </div>
  );
}

// Corrige um valor de cor ou tamanho digitado errado em todas as variantes
// que usam esse valor de uma vez (ex.: "Azl" -> "Azul" em 30 referências
// diferentes), sem precisar editar produto por produto.
function CorrigirEmMassa() {
  const [campo, setCampo] = useState('cor');
  const [valorAtual, setValorAtual] = useState('');
  const [valorNovo, setValorNovo] = useState('');
  const [encontradas, setEncontradas] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [erro, setErro] = useState('');
  const [resultado, setResultado] = useState(null);

  async function buscar(e) {
    e.preventDefault();
    if (!valorAtual.trim()) return;
    setErro('');
    setResultado(null);
    setBuscando(true);
    try {
      const data = await api.get(`/estoque/variantes?${campo}=${encodeURIComponent(valorAtual)}`);
      setEncontradas(data);
    } catch (err) {
      setErro(err.message);
    } finally {
      setBuscando(false);
    }
  }

  async function aplicar() {
    if (!encontradas || !valorNovo.trim()) return;
    setAplicando(true);
    setErro('');
    let corrigidas = 0;
    const conflitos = [];
    for (const v of encontradas) {
      try {
        await api.put(`/estoque/variantes/${v.id}`, { [campo]: valorNovo.trim() });
        corrigidas += 1;
      } catch (err) {
        conflitos.push({ referencia: v.referencia, cor: v.cor, tamanho: v.tamanho, motivo: err.message });
      }
    }
    setResultado({ corrigidas, conflitos });
    setEncontradas(null);
    setValorAtual('');
    setAplicando(false);
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><Wand2 size={14} style={{ verticalAlign: -2, marginRight: 4 }} />Corrigir cor/tamanho em massa</div>
      <p className="page-sub" style={{ marginTop: -6 }}>
        Ex.: digitou "Azl" em vez de "Azul" em várias referências? Corrige todas de uma vez, em vez de editar uma por uma.
      </p>
      <form onSubmit={buscar} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Campo">
          <Select value={campo} onChange={(e) => { setCampo(e.target.value); setEncontradas(null); }}>
            <option value="cor">Cor</option>
            <option value="tamanho">Tamanho</option>
          </Select>
        </Field>
        <Field label="Valor atual (exato)">
          <input value={valorAtual} onChange={(e) => setValorAtual(e.target.value)} style={{ width: 160 }} />
        </Field>
        <button className="btn btn-ghost" type="submit" disabled={buscando}>
          <Search size={13} /> {buscando ? 'Buscando…' : 'Buscar'}
        </button>
      </form>

      {encontradas && (
        <div style={{ marginTop: 12 }}>
          {encontradas.length === 0 ? (
            <p className="page-sub">Nenhuma variante encontrada com {campo} = "{valorAtual}".</p>
          ) : (
            <>
              <p className="page-sub">{encontradas.length} variante(s) encontrada(s):</p>
              <table className="data-table" style={{ marginBottom: 10 }}>
                <thead><tr><th>Referência</th><th>Descrição</th><th>Cor</th><th>Tamanho</th></tr></thead>
                <tbody>
                  {encontradas.slice(0, 100).map((v) => (
                    <tr key={v.id}><td className="mono">{v.referencia}</td><td>{v.descricao}</td><td>{v.cor}</td><td>{v.tamanho}</td></tr>
                  ))}
                </tbody>
              </table>
              {encontradas.length > 100 && <p className="page-sub">Mostrando 100 de {encontradas.length}.</p>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Novo valor">
                  <input value={valorNovo} onChange={(e) => setValorNovo(e.target.value)} style={{ width: 160 }} />
                </Field>
                <button className="btn btn-primary" onClick={aplicar} disabled={aplicando || !valorNovo.trim()}>
                  {aplicando ? 'Aplicando…' : `Aplicar em ${encontradas.length} variante(s)`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}

      {resultado && (
        <div style={{ marginTop: 10 }}>
          <div className="stamp sm tone-saudavel" style={{ display: 'inline-flex' }}>{resultado.corrigidas} variante(s) corrigida(s).</div>
          {resultado.conflitos.length > 0 && (
            <div className="login-error" style={{ marginTop: 8 }}>
              {resultado.conflitos.length} não puderam ser corrigidas (já existe uma variante igual na mesma referência):
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {resultado.conflitos.map((c, i) => (
                  <li key={i}>{c.referencia} — {c.cor} / {c.tamanho}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function EstoquePage() {
  const [produtos, setProdutos] = useState([]);
  const [produtoId, setProdutoId] = useState('');
  const [variantes, setVariantes] = useState([]);
  const [busca, setBusca] = useState('');
  const [resultadoBusca, setResultadoBusca] = useState(null);
  const [erro, setErro] = useState('');
  const [selecionadas, setSelecionadas] = useState(new Set());
  const [aplicandoEmMassa, setAplicandoEmMassa] = useState(false);

  useEffect(() => {
    api.get('/estoque/produtos-referencia').then(setProdutos);
  }, []);

  function loadVariantes(id) {
    setSelecionadas(new Set());
    if (!id) { setVariantes([]); return; }
    api.get(`/estoque/variantes?produto_id=${id}`).then(setVariantes);
  }

  useEffect(() => loadVariantes(produtoId), [produtoId]);

  async function handleBuscar(e) {
    e.preventDefault();
    if (!busca.trim()) { setResultadoBusca(null); return; }
    const data = await api.get(`/estoque/variantes?busca=${encodeURIComponent(busca)}`);
    setResultadoBusca(data);
  }

  async function removerVariante(id) {
    if (!confirm('Remover esta variante de estoque? O histórico de movimentos dela também será apagado.')) return;
    setErro('');
    try {
      await api.del(`/estoque/variantes/${id}`);
      loadVariantes(produtoId);
      if (resultadoBusca) handleBuscar({ preventDefault: () => {} });
    } catch (err) {
      setErro(err.message);
    }
  }

  async function alternarAtivo(variante) {
    setErro('');
    try {
      await api.put(`/estoque/variantes/${variante.id}`, { ativo: !variante.ativo });
      loadVariantes(produtoId);
    } catch (err) {
      setErro(err.message);
    }
  }

  function alternarSelecao(id) {
    setSelecionadas((atual) => {
      const nova = new Set(atual);
      if (nova.has(id)) nova.delete(id); else nova.add(id);
      return nova;
    });
  }

  function alternarSelecionarTodas() {
    setSelecionadas((atual) => (atual.size === variantes.length ? new Set() : new Set(variantes.map((v) => v.id))));
  }

  async function ativarDesativarSelecionadas(ativo) {
    setErro('');
    setAplicandoEmMassa(true);
    try {
      await Promise.all([...selecionadas].map((id) => api.put(`/estoque/variantes/${id}`, { ativo })));
      loadVariantes(produtoId);
    } catch (err) {
      setErro(err.message);
      loadVariantes(produtoId);
    } finally {
      setAplicandoEmMassa(false);
    }
  }

  async function excluirSelecionadas() {
    if (!confirm(`Excluir ${selecionadas.size} variante(s) selecionada(s)? As que já tiverem venda registrada não serão excluídas.`)) return;
    setErro('');
    setAplicandoEmMassa(true);
    let excluidas = 0;
    const bloqueadas = [];
    for (const id of selecionadas) {
      try {
        await api.del(`/estoque/variantes/${id}`);
        excluidas += 1;
      } catch (err) {
        const v = variantes.find((x) => x.id === id);
        bloqueadas.push(`${v?.cor} / ${v?.tamanho}`);
      }
    }
    setAplicandoEmMassa(false);
    loadVariantes(produtoId);
    if (bloqueadas.length > 0) {
      setErro(`${excluidas} excluída(s). ${bloqueadas.length} bloqueada(s) por já terem venda registrada: ${bloqueadas.join(', ')}.`);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Estoque</h2>
          <p className="page-sub">Controle de estoque por variante (referência + cor + tamanho), com EAN próprio para bipagem.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/estoque/ean" className="btn btn-ghost"><Tags size={14} /> Importar EAN</Link>
          <Link to="/estoque/importacao" className="btn btn-ghost"><Upload size={14} /> Importar saldo</Link>
          <Link to="/estoque/ficha" className="btn btn-ghost"><Printer size={14} /> Ficha de estoque</Link>
          <Link to="/estoque/bipagem" className="btn btn-primary"><Barcode size={14} /> Bipagem</Link>
        </div>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}

      <CorrigirEmMassa />

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handleBuscar} style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="Buscar por referência, descrição ou EAN em todo o estoque"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
        </form>
        {resultadoBusca && (
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Referência</th><th>Descrição</th><th>Cor</th><th>Tamanho</th><th>EAN</th><th>Qtd.</th></tr></thead>
            <tbody>
              {resultadoBusca.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.referencia}</td>
                  <td>{v.descricao}</td>
                  <td>{v.cor}</td>
                  <td>{v.tamanho}</td>
                  <td><EanEditavel variante={v} onFeito={() => handleBuscar({ preventDefault: () => {} })} /></td>
                  <td className="mono">{v.quantidade}</td>
                </tr>
              ))}
              {resultadoBusca.length === 0 && <tr><td colSpan="6">Nada encontrado.</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <Field label="Referência">
          <Select value={produtoId} onChange={(e) => setProdutoId(e.target.value)}>
            <option value="">Selecione uma referência…</option>
            {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
          </Select>
        </Field>

        {produtoId && (
          <>
            {selecionadas.size > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, padding: '8px 12px', background: 'var(--surface-alt)', borderRadius: 8 }}>
                <strong>{selecionadas.size} selecionada(s)</strong>
                <button className="btn btn-ghost sm" disabled={aplicandoEmMassa} onClick={() => ativarDesativarSelecionadas(true)}>Ativar selecionadas</button>
                <button className="btn btn-ghost sm" disabled={aplicandoEmMassa} onClick={() => ativarDesativarSelecionadas(false)}>Desativar selecionadas</button>
                <button className="btn btn-ghost sm" disabled={aplicandoEmMassa} onClick={excluirSelecionadas} style={{ color: 'var(--danger)' }}>
                  <Trash2 size={12} /> Excluir selecionadas
                </button>
              </div>
            )}
            <table className="data-table" style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th><input type="checkbox" checked={variantes.length > 0 && selecionadas.size === variantes.length} onChange={alternarSelecionarTodas} /></th>
                  <th>Cor</th><th>Tamanho</th><th>EAN</th><th>Qtd. atual</th><th>Movimentar</th><th>Ativa?</th><th /></tr>
              </thead>
              <tbody>
                {variantes.map((v) => (
                  <tr key={v.id} style={v.ativo ? undefined : { opacity: 0.55 }}>
                    <td><input type="checkbox" checked={selecionadas.has(v.id)} onChange={() => alternarSelecao(v.id)} /></td>
                    <td>{v.cor}</td>
                    <td>{v.tamanho}</td>
                    <td><EanEditavel variante={v} onFeito={() => loadVariantes(produtoId)} /></td>
                    <td className="mono" style={{ fontWeight: 700 }}>{v.quantidade}</td>
                    <td><MovimentoInline variante={v} onFeito={() => loadVariantes(produtoId)} /></td>
                    <td>
                      <label className="toggle">
                        <input type="checkbox" checked={v.ativo} onChange={() => alternarAtivo(v)} />
                        {v.ativo ? 'Sim' : 'Não'}
                      </label>
                    </td>
                    <td><button className="icon-btn" title="Excluir (só se nunca vendida)" onClick={() => removerVariante(v.id)}><Trash2 size={13} /></button></td>
                  </tr>
                ))}
                {variantes.length === 0 && (
                  <tr><td colSpan="8" style={{ color: 'var(--ink-soft)' }}>Nenhuma variante cadastrada ainda para esta referência.</td></tr>
                )}
              </tbody>
            </table>
            <NovaVarianteForm produtoId={produtoId} onCriada={() => loadVariantes(produtoId)} />
          </>
        )}
      </div>
    </div>
  );
}
