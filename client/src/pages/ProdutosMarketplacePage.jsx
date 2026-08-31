import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Store, Search, Plus, X, Printer, ClipboardPaste, PackageSearch } from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio } from '../components/ui';
import DataTable from '../components/DataTable';

// Administração da seleção "produtos de marketplace": ver quem está dentro,
// adicionar por busca, adicionar em massa colando a coluna de referências de
// uma planilha, e remover.
export default function ProdutosMarketplacePage() {
  const [selecao, setSelecao] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  const [busca, setBusca] = useState('');
  const [candidatos, setCandidatos] = useState(null);
  const [buscando, setBuscando] = useState(false);

  const [colagem, setColagem] = useState('');
  const [previa, setPrevia] = useState(null);
  const [conferindo, setConferindo] = useState(false);
  const [gravando, setGravando] = useState(false);

  function carregar() {
    setCarregando(true);
    api.get('/produtos-marketplace')
      .then(setSelecao)
      .catch((err) => setErro(err.message))
      .finally(() => setCarregando(false));
  }

  useEffect(carregar, []);

  async function handleBuscar(e) {
    e.preventDefault();
    if (!busca.trim()) return;
    setBuscando(true);
    setErro('');
    try {
      setCandidatos(await api.get(`/produtos-marketplace/candidatos?busca=${encodeURIComponent(busca)}`));
    } catch (err) {
      setErro(err.message);
    } finally {
      setBuscando(false);
    }
  }

  async function adicionar(ids) {
    setErro('');
    setAviso('');
    try {
      const r = await api.post('/produtos-marketplace', { ids });
      setAviso(`${r.alterados} referência(s) adicionada(s) à seleção.`);
      setCandidatos((atual) => (atual ? atual.filter((c) => !ids.includes(c.id)) : atual));
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function remover(id) {
    setErro('');
    setAviso('');
    try {
      await api.post('/produtos-marketplace/remover', { ids: [id] });
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  function referenciasColadas() {
    // Aceita uma por linha, separadas por vírgula, ponto-e-vírgula ou tab —
    // é o que sai de uma coluna copiada do Excel ou de uma lista digitada.
    return colagem
      .split(/[\n\r,;\t]+/)
      .map((r) => r.trim())
      .filter(Boolean);
  }

  async function conferirColagem() {
    const referencias = referenciasColadas();
    if (referencias.length === 0) return;
    setConferindo(true);
    setErro('');
    setAviso('');
    try {
      setPrevia(await api.post('/produtos-marketplace/conferir', { referencias }));
    } catch (err) {
      setErro(err.message);
    } finally {
      setConferindo(false);
    }
  }

  async function confirmarColagem() {
    setGravando(true);
    setErro('');
    try {
      const r = await api.post('/produtos-marketplace', { referencias: referenciasColadas() });
      setAviso(`${r.alterados} referência(s) adicionada(s) à seleção.`);
      setPrevia(null);
      setColagem('');
      carregar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setGravando(false);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Produtos de Marketplace</h2>
          <p className="page-sub">
            As referências anunciadas nos marketplaces. Serve para filtrar Produtos e Estoque e para
            puxar todas as fichas de estoque de uma vez só, prontas para imprimir.
          </p>
        </div>
        <Link to="/estoque/ficha?marketplace=1" className="btn btn-primary">
          <Printer size={14} /> Gerar fichas de estoque
        </Link>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && <div className="card" style={{ marginBottom: 12 }}>{aviso}</div>}

      {/* --- adicionar por busca --- */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Adicionar uma referência</h3>
        <form onSubmit={handleBuscar} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            placeholder="Buscar por referência, código ou descrição (só aparece o que ainda não está na seleção)"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <button className="btn btn-ghost" type="submit" disabled={buscando}>
            <Search size={14} /> {buscando ? 'Buscando…' : 'Buscar'}
          </button>
        </form>

        {candidatos && candidatos.length === 0 && (
          <p className="page-sub">Nenhuma referência fora da seleção bate com essa busca.</p>
        )}
        {candidatos && candidatos.length > 0 && (
          <>
            <div style={{ marginBottom: 8 }}>
              <button className="btn btn-dashed sm" onClick={() => adicionar(candidatos.map((c) => c.id))}>
                <Plus size={13} /> Adicionar os {candidatos.length} resultados
              </button>
            </div>
            <DataTable>
              <table className="data-table">
                <tbody>
                  {candidatos.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.referencia}</td>
                      <td>{c.descricao}</td>
                      <td>{c.marca}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-dashed sm" onClick={() => adicionar([c.id])}>
                          <Plus size={13} /> Adicionar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          </>
        )}
      </div>

      {/* --- adicionar em massa (colagem de planilha) --- */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}><ClipboardPaste size={15} /> Adicionar várias de uma vez</h3>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Copie a coluna de referências da planilha e cole aqui (uma por linha, ou separadas por
          vírgula). O sistema confere antes de gravar e mostra o que não encontrou — nada é
          adivinhado por descrição.
        </p>
        <textarea
          rows={6}
          value={colagem}
          onChange={(e) => { setColagem(e.target.value); setPrevia(null); }}
          placeholder={'OG1192\nVM034\nMM6232'}
          style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={conferirColagem} disabled={conferindo || referenciasColadas().length === 0}>
            {conferindo ? 'Conferindo…' : `Conferir ${referenciasColadas().length} referência(s)`}
          </button>
          {previa && previa.aMarcar.length > 0 && (
            <button className="btn btn-primary" onClick={confirmarColagem} disabled={gravando}>
              <Store size={14} /> {gravando ? 'Gravando…' : `Adicionar ${previa.aMarcar.length} à seleção`}
            </button>
          )}
        </div>

        {previa && (
          <div style={{ marginTop: 12 }}>
            <p className="page-sub" style={{ margin: '0 0 6px' }}>
              {previa.aMarcar.length} a adicionar · {previa.jaNaSelecao.length} já na seleção ·
              {' '}{previa.naoEncontradas.length} não encontrada(s)
              {previa.ambiguas.length > 0 && ` · ${previa.ambiguas.length} ambígua(s)`}
            </p>
            {previa.aMarcar.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {previa.aMarcar.map((p) => (
                  <span key={p.id} className="stamp sm tone-saudavel">{p.referencia}</span>
                ))}
              </div>
            )}
            {previa.naoEncontradas.length > 0 && (
              <div className="login-error" style={{ marginBottom: 8 }}>
                Não existem no cadastro (não serão marcadas): {previa.naoEncontradas.join(', ')}
              </div>
            )}
            {previa.ambiguas.length > 0 && (
              <div className="login-error">
                Ambíguas — mais de um produto bate, confira à mão:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {previa.ambiguas.map((a, i) => (
                    <li key={i}>"{a.informada}" → {a.candidatas.join(', ')}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* --- seleção atual --- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          Na seleção {!carregando && `(${selecao.length})`}
        </h3>
        {selecao.length === 0 && !carregando ? (
          <EstadoVazio
            Icone={PackageSearch}
            titulo="Nenhum produto de marketplace ainda"
            descricao="Use a busca acima ou cole a lista de referências da sua planilha para montar a seleção."
          />
        ) : (
          <DataTable>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Referência</th><th>Descrição</th><th>Marca</th><th>Categoria</th><th>Coleção</th><th />
                </tr>
              </thead>
              <tbody>
                {selecao.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.referencia}</td>
                    <td>{p.descricao}</td>
                    <td>{p.marca}</td>
                    <td>{p.categoria}</td>
                    <td>{p.colecao}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="icon-btn" title="Tirar da seleção" onClick={() => remover(p.id)}>
                        <X size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        )}
      </div>
    </div>
  );
}
