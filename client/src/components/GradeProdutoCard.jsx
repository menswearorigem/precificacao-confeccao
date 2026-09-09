import { useCallback, useEffect, useState } from 'react';
import {
  Palette, Plus, Trash2, Save, Grid3x3, Info, AlertTriangle, Check, Download,
} from 'lucide-react';
import { api } from '../api/client';

// Cores e grade da referência, dentro da ficha do produto.
//
// A queixa que originou esta tela, palavra por palavra: "na OG1620 temos azul,
// verde, vermelho, mas eu não consigo ver essa informação em lugar algum e nem
// consigo editar, excluir ou adicionar novas cores".
//
// ---------------------------------------------------------------------------
// A distinção que a tela precisa deixar clara o tempo todo
// ---------------------------------------------------------------------------
// CADASTRO é o que a referência PODE ter. VARIANTE é o que ela TEM, com EAN e
// saldo. Confundir os dois é como se perde peça: tirar uma cor do cadastro tem
// de ser reversível e não pode encostar em saldo nenhum.
//
// Por isso a matriz mostra as duas coisas ao mesmo tempo — a célula com
// variante aparece com o saldo, a célula sem variante aparece vazia e há um
// botão que cria as que faltam. Ninguém precisa adivinhar o que existe.

export default function GradeProdutoCard({ produtoId, referencia }) {
  const [dados, setDados] = useState(null);
  const [cores, setCores] = useState([]);
  const [tamanhos, setTamanhos] = useState([]);
  const [catalogo, setCatalogo] = useState({ cores: [], tamanhos: [] });
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [removidas, setRemovidas] = useState([]);

  const aplicar = useCallback((r) => {
    setDados(r);
    setCores((r.cores || []).map((c) => ({ cor: c.cor, hex: c.hex || '', ativo: c.ativo !== false })));
    setTamanhos((r.tamanhos || []).map((t) => ({ tamanho: t.tamanho, ativo: t.ativo !== false })));
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [r, cat] = await Promise.all([
        api.get(`/produto-grade/${produtoId}`),
        api.get('/produto-grade/catalogo/valores').catch(() => ({ cores: [], tamanhos: [] })),
      ]);
      aplicar(r);
      setCatalogo(cat);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [produtoId, aplicar]);

  useEffect(() => { carregar(); }, [carregar]);

  async function salvar() {
    setErro(''); setAviso(''); setRemovidas([]);
    setSalvando(true);
    try {
      const r = await api.put(`/produto-grade/${produtoId}`, {
        cores: cores.filter((c) => c.cor.trim()),
        tamanhos: tamanhos.filter((t) => t.tamanho.trim()),
      });
      aplicar(r);
      setRemovidas(r.removidas || []);
      setAviso('Cores e grade salvas. A ordem de produção desta referência passa a usar esta grade.');
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  async function acao(caminho, corpo, mensagem) {
    setErro(''); setAviso('');
    try {
      const r = await api.post(`/produto-grade/${produtoId}/${caminho}`, corpo);
      aplicar(r);
      setAviso(r.aviso || mensagem);
    } catch (e) { setErro(e.message); }
  }

  if (carregando) return <div className="card"><div className="card-head"><Palette size={14} /> Cores e grade</div><p className="ink-soft">Carregando…</p></div>;

  const matriz = dados?.matriz;
  const resumo = dados?.resumo;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><Palette size={14} /> Cores e grade{referencia ? ` — ${referencia}` : ''}</div>

      <p className="ink-soft" style={{ marginBottom: 10 }}>
        É esta grade que a ordem de produção usa. O cadastro diz o que a referência{' '}
        <strong>pode</strong> ter; a variante é o que ela <strong>tem</strong>, com EAN e saldo —
        tirar uma cor daqui não encosta em saldo nenhum.
      </p>

      {(dados?.avisos || []).map((a, i) => (
        <p key={i} className="aviso-inline"><Info size={14} /> {a}</p>
      ))}
      {erro && <p className="erro-inline">{erro}</p>}
      {aviso && <p className="sucesso-inline"><Check size={14} /> {aviso}</p>}
      {removidas.length > 0 && (
        <div className="bloco-alerta">
          <p><AlertTriangle size={15} /> O que saiu da lista:</p>
          <ul>
            {removidas.map((r, i) => (
              <li key={i}>
                <strong>{r.valor}</strong> — {r.acao}{r.motivo ? `: ${r.motivo}` : '.'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid-2" style={{ gap: 12 }}>
        {/* ---------------- cores ---------------- */}
        <div>
          <div className="card-head" style={{ fontSize: 12 }}>Cores</div>
          <table className="data-table">
            <thead><tr><th style={{ width: 34 }} /><th>Cor</th><th style={{ width: 60 }}>Tom</th><th style={{ width: 34 }} /></tr></thead>
            <tbody>
              {cores.map((c, i) => (
                <tr key={i} style={{ opacity: c.ativo ? 1 : 0.5 }}>
                  <td>
                    <span
                      className="grade-bolinha"
                      style={{ background: c.hex || 'var(--border)' }}
                      title={c.hex || 'sem tom cadastrado'}
                    />
                  </td>
                  <td>
                    <input
                      className="input" list="catalogo-cores" value={c.cor}
                      onChange={(e) => setCores((l) => l.map((x, j) => (j === i ? { ...x, cor: e.target.value } : x)))}
                    />
                  </td>
                  <td>
                    <input
                      type="color" className="input grade-cor-input" value={c.hex || '#cccccc'}
                      onChange={(e) => setCores((l) => l.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)))}
                    />
                  </td>
                  <td>
                    <button type="button" className="icon-btn" aria-label={`Remover ${c.cor}`}
                      onClick={() => setCores((l) => l.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-dashed sm" onClick={() => setCores((l) => [...l, { cor: '', hex: '', ativo: true }])}>
            <Plus size={13} /> Cor
          </button>
        </div>

        {/* ---------------- tamanhos ---------------- */}
        <div>
          <div className="card-head" style={{ fontSize: 12 }}>Grade de tamanhos</div>
          <table className="data-table">
            <thead><tr><th>Tamanho</th><th style={{ width: 34 }} /></tr></thead>
            <tbody>
              {tamanhos.map((t, i) => (
                <tr key={i} style={{ opacity: t.ativo ? 1 : 0.5 }}>
                  <td>
                    <input
                      className="input" list="catalogo-tamanhos" value={t.tamanho}
                      onChange={(e) => setTamanhos((l) => l.map((x, j) => (j === i ? { ...x, tamanho: e.target.value } : x)))}
                    />
                  </td>
                  <td>
                    <button type="button" className="icon-btn" aria-label={`Remover ${t.tamanho}`}
                      onClick={() => setTamanhos((l) => l.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-dashed sm" onClick={() => setTamanhos((l) => [...l, { tamanho: '', ativo: true }])}>
            <Plus size={13} /> Tamanho
          </button>
          <p className="ink-soft" style={{ fontSize: 11, marginTop: 6 }}>
            A ordem da grade é a da casa (PP, P, M, G, GG…), não a ordem em que você digita —
            senão GG apareceria antes de M em toda tela.
          </p>
        </div>
      </div>

      <datalist id="catalogo-cores">
        {catalogo.cores.map((c) => <option key={c} value={c} />)}
      </datalist>
      <datalist id="catalogo-tamanhos">
        {catalogo.tamanhos.map((t) => <option key={t} value={t} />)}
      </datalist>

      <div className="painel-acoes-inline" style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-primary sm" disabled={salvando} onClick={salvar}>
          <Save size={13} /> Salvar cores e grade
        </button>
        <button
          type="button" className="btn btn-ghost sm"
          onClick={() => acao('importar-do-estoque', {}, 'Cores e tamanhos puxados do estoque.')}
          title="Lê as variantes que já existem no estoque desta referência e traz cor e tamanho para o cadastro."
        >
          <Download size={13} /> Puxar do estoque
        </button>
        <button
          type="button" className="btn btn-ghost sm"
          disabled={!resumo || resumo.semVariante === 0}
          onClick={() => acao('gerar-variantes', { confirmar: true }, 'Variantes criadas.')}
          title="Cria, com saldo zero, as combinações de cor e tamanho que ainda não existem no estoque."
        >
          <Grid3x3 size={13} /> Gerar as {resumo?.semVariante || 0} variante(s) que faltam
        </button>
      </div>

      {/* ---------------- a matriz ---------------- */}
      {matriz && matriz.linhas.length > 0 && (
        <>
          <div className="card-head" style={{ fontSize: 12, marginTop: 14 }}>
            <Grid3x3 size={13} /> Grade completa
            <span className="page-sub">
              {' '}— {resumo.combinacoes} combinação(ões), {resumo.variantes} já existe(m) no estoque
            </span>
          </div>
          <div className="tabela-rolagem">
            <table className="data-table grade-matriz">
              <thead>
                <tr>
                  <th>Cor</th>
                  {matriz.tamanhos.map((t) => <th key={t} className="num">{t || '—'}</th>)}
                </tr>
              </thead>
              <tbody>
                {matriz.linhas.map((l) => (
                  <tr key={l.cor}>
                    <td>
                      <span className="grade-bolinha" style={{ background: l.hex || 'var(--border)' }} />
                      {l.cor || '—'}
                    </td>
                    {l.celulas.map((c) => (
                      <td key={`${c.cor}|${c.tamanho}`} className="num">
                        {c.variante_id == null
                          ? <span className="selo tone-neutro" title="Esta combinação ainda não existe como variante: não tem EAN nem saldo.">—</span>
                          : (
                            <span
                              className={c.variante_ativa === false ? 'ink-soft' : undefined}
                              title={c.variante_ativa === false ? 'Variante desativada' : 'Saldo em estoque'}
                            >{Number(c.saldo)}</span>
                          )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ink-soft" style={{ fontSize: 11, marginTop: 6 }}>
            Célula com número é variante que existe, e o número é o saldo. Célula com traço ainda
            não existe — criar a variante <strong>não</strong> dá entrada de peça: ela nasce zerada.
          </p>
        </>
      )}
    </div>
  );
}
