import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, X, Printer, Store, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { brl, plural, brlOuTraco, formatQtd } from '../lib/format';
import SeloDeConfianca from '../components/SeloDeConfianca';

// Quantas referências vão em cada chamada de /estoque/ficha quando a seleção
// é montada à mão. Sem isso, uma seleção grande viraria uma URL de milhares
// de caracteres — que servidor e proxy cortam sem avisar. O lote inteiro do
// marketplace não passa por aqui: usa ?marketplace=1, uma chamada só.
const LOTE_REFERENCIAS = 40;

// A partir daqui a impressão começa a ficar pesada no navegador — não é
// impedimento, é só um aviso honesto antes de mandar imprimir.
const AVISO_MUITAS_FICHAS = 80;

export default function FichaEstoquePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState([]);
  const [selecionadas, setSelecionadas] = useState([]);
  const [fichas, setFichas] = useState([]);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [gerando, setGerando] = useState(false);
  // Fica ligado enquanto a seleção na tela é exatamente a seleção de
  // marketplace inteira — nesse caso as fichas são pedidas de uma vez só,
  // por ?marketplace=1, em vez de listar centenas de referências na URL.
  const [loteMarketplace, setLoteMarketplace] = useState(false);

  async function handleBuscar(e) {
    e.preventDefault();
    if (!busca.trim()) return;
    const data = await api.get(`/estoque/produtos-referencia?busca=${encodeURIComponent(busca)}`);
    setResultados(data);
  }

  async function carregarMarketplace() {
    setErro('');
    setCarregando(true);
    try {
      const data = await api.get('/estoque/produtos-referencia?marketplace=1');
      if (data.length === 0) {
        setErro('Nenhum produto está marcado como marketplace ainda. Marque as referências em Produtos ou em Configurações › Produtos de Marketplace.');
        return;
      }
      setSelecionadas(data);
      setLoteMarketplace(true);
      setFichas([]);
    } catch (err) {
      setErro(err.message);
    } finally {
      setCarregando(false);
    }
  }

  // Permite chegar aqui já com a seleção carregada, vindo do botão "Fichas do
  // marketplace" da lista de Produtos (/estoque/ficha?marketplace=1).
  useEffect(() => {
    if (searchParams.get('marketplace') === '1') {
      setSearchParams({}, { replace: true });
      carregarMarketplace();
      return;
    }
    // 14/09/2026: mesmo caminho, agora vindo da SELEÇÃO da lista de Produtos
    // (?referencias=OG1620,OG1621). Era a outra metade da tela que abria
    // vazia: o atalho "todos do marketplace" já existia, mas quem queria três
    // referências específicas tinha de digitar as três.
    const refs = (searchParams.get('referencias') || '').split(',').map((r) => r.trim()).filter(Boolean);
    if (refs.length === 0) return;
    setSearchParams({}, { replace: true });
    let cancelado = false;
    (async () => {
      setCarregando(true);
      try {
        const achados = [];
        for (const ref of refs) {
          const lista = await api.get(`/produtos?busca=${encodeURIComponent(ref)}`);
          const exato = (lista || []).find((p) => String(p.referencia).toUpperCase() === ref.toUpperCase());
          if (exato) achados.push(exato);
        }
        if (!cancelado) setSelecionadas(achados);
      } catch {
        // Busca falhou: a busca manual continua valendo.
      } finally {
        if (!cancelado) setCarregando(false);
      }
    })();
    return () => { cancelado = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function adicionar(p) {
    if (selecionadas.some((s) => s.id === p.id)) return;
    setErro('');
    setLoteMarketplace(false);
    setSelecionadas((list) => [...list, p]);
  }

  function remover(id) {
    setLoteMarketplace(false);
    setSelecionadas((list) => list.filter((s) => s.id !== id));
  }

  function limpar() {
    setLoteMarketplace(false);
    setSelecionadas([]);
    setFichas([]);
    setErro('');
  }

  async function gerarFichas() {
    if (selecionadas.length === 0) return;
    setErro('');
    setGerando(true);
    try {
      if (loteMarketplace) {
        setFichas(await api.get('/estoque/ficha?marketplace=1'));
        return;
      }
      // Seleção montada à mão: quebra em lotes e recompõe na ordem escolhida.
      const partes = [];
      for (let i = 0; i < selecionadas.length; i += LOTE_REFERENCIAS) {
        const refs = selecionadas.slice(i, i + LOTE_REFERENCIAS).map((s) => s.referencia).join(',');
        // eslint-disable-next-line no-await-in-loop
        partes.push(...(await api.get(`/estoque/ficha?referencias=${encodeURIComponent(refs)}`)));
      }
      setFichas(partes);
    } catch (err) {
      setErro(err.message);
    } finally {
      setGerando(false);
    }
  }

  // ⚠️ 14/09/2026 — `custoTotal`/`valorTotal` passaram a poder ser NULOS
  // (referência sem ficha de custo). O `|| 0` antigo somava essas peças como
  // se valessem R$ 0,00 e o rodapé ainda declarava isso em voz alta
  // ("entram como zero"), o que espalha o erro em vez de corrigi-lo. Agora
  // o total soma só o que é somável, e o que sobra é declarado EM PEÇAS —
  // mesmo tratamento da tela Dinheiro Parado.
  const totalPecas = fichas.reduce((s, f) => s + Number(f.quantidadeTotal || 0), 0);
  const totalCusto = fichas.reduce((s, f) => s + (f.custoTotal === null ? 0 : Number(f.custoTotal) || 0), 0);
  const totalValor = fichas.reduce((s, f) => s + (f.valorTotal === null ? 0 : Number(f.valorTotal) || 0), 0);
  const fichasComCusto = fichas.filter((f) => f.custoConhecido);
  const fichasSemCusto = fichas.filter((f) => !f.custoConhecido);
  const pecasSemCusto = fichasSemCusto.reduce((s, f) => s + Number(f.pecasSemCusto || 0), 0);
  const totalEhPiso = pecasSemCusto > 0;

  return (
    <div className="page-wide">
      <div className="no-print">
        <h1>Ficha de Estoque</h1>
        <p className="page-sub">
          Busque e selecione as referências para gerar fichas de conferência de estoque prontas
          para impressão (uma referência por folha, variantes organizadas em tabelas por cor).
        </p>

        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <button type="button" className="btn btn-dashed" onClick={carregarMarketplace} disabled={carregando}>
              <Store size={14} /> {carregando ? 'Carregando…' : 'Carregar todos do Marketplace'}
            </button>
            {selecionadas.length > 0 && (
              <button type="button" className="btn btn-ghost" onClick={limpar}>
                <Trash2 size={14} /> Limpar seleção
              </button>
            )}
          </div>

          <form onSubmit={handleBuscar} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              placeholder="Buscar por referência, código ou descrição"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
          </form>

          {resultados.length > 0 && (
            <table className="data-table" style={{ marginBottom: 12 }}>
              <tbody>
                {resultados.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.referencia}</td>
                    <td>{p.descricao}</td>
                    <td>{p.marketplace && <span className="stamp sm tone-neutro">marketplace</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="btn btn-dashed" onClick={() => adicionar(p)}>Adicionar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {loteMarketplace && (
            <p className="page-sub" style={{ margin: '0 0 8px' }}>
              Seleção completa do marketplace carregada — {plural(selecionadas.length, 'referência')}.
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {selecionadas.map((s) => (
              <span key={s.id} className="stamp sm tone-neutro" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {s.referencia}
                <X size={12} style={{ cursor: 'pointer' }} onClick={() => remover(s.id)} />
              </span>
            ))}
          </div>

          {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

          {selecionadas.length >= AVISO_MUITAS_FICHAS && (
            <p className="page-sub" style={{ margin: '0 0 10px' }}>
              São {selecionadas.length} folhas. Gerar e imprimir pode demorar alguns segundos.
            </p>
          )}

          <button type="button" className="btn btn-primary" onClick={gerarFichas} disabled={selecionadas.length === 0 || gerando}>
            {gerando ? 'Gerando…' : `Gerar fichas (${selecionadas.length})`}
          </button>
          {fichas.length > 0 && (
            <button type="button" className="btn btn-ghost" style={{ marginLeft: 8 }} onClick={() => window.print()} title="Abre a impressão do navegador — de lá dá para salvar em PDF">
              <Printer size={14} /> Imprimir
            </button>
          )}

          {fichas.length > 0 && (
            <>
              <p className="page-sub" style={{ margin: '10px 0 0' }}>
                {fichas.length} ficha(s) · {formatQtd(totalPecas)} peça(s) ·
                {' '}custo {brl(totalCusto)}{totalEhPiso ? ' (no mínimo)' : ''} ·
                {' '}valor {brl(totalValor)}{totalEhPiso ? ' (no mínimo)' : ''}
              </p>
              {totalEhPiso && (
                <p className="page-sub" style={{ margin: '4px 0 0' }}>
                  Os dois valores são um PISO: {formatQtd(pecasSemCusto)} peça(s) de{' '}
                  {fichasSemCusto.length} referência(s) sem custo de produção calculado não entram
                  no R$ — elas continuam contadas em peças e aparecem com “—” na própria ficha.
                </p>
              )}
              <SeloDeConfianca
                considerado={fichasComCusto.length}
                total={fichas.length}
                excluidos={[{ label: 'sem custo de produção calculado', total: fichasSemCusto.length }]}
              />
            </>
          )}
        </div>
      </div>

      {fichas.map((f, i) => (
        <FichaEstoque key={f.produto.id} ficha={f} pagina={i + 1} totalPaginas={fichas.length} />
      ))}
    </div>
  );
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR');
}

function FichaEstoque({ ficha, pagina, totalPaginas }) {
  const {
    produto, tamanhos, linhas, totalizador, quantidadeTotal,
    custoTotal, valorTotal, motivoSemCusto,
  } = ficha;
  return (
    <div className="ficha-page ficha-doc-grid card" style={{ marginBottom: 24 }}>
      <div className="ficha-doc-topo">
        <div>
          <div className="ficha-doc-empresa">FORMAÇÃO DE PREÇO — MISS MANU · ORIGEM · HOGGAR · HEBRON</div>
          <div className="ficha-doc-titulo">Relatório - Saldo de Estoque</div>
        </div>
        <div className="ficha-doc-meta">
          <div><strong>Pag.:</strong> {pagina}/{totalPaginas}</div>
          <div><strong>Data:</strong> {hoje()}</div>
        </div>
      </div>

      <div className="ficha-doc-campos">
        <div className="ficha-doc-campo"><span>REFERÊNCIA:</span> <strong>{produto.referencia}</strong></div>
        <div className="ficha-doc-campo ficha-doc-campo-grande"><span>DESCRIÇÃO:</span> <strong>{produto.descricao || '—'}</strong></div>
        <div className="ficha-doc-campo"><span>COLEÇÃO:</span> <strong>{produto.colecao || '—'}</strong></div>
      </div>

      {tamanhos.length === 0 ? (
        <p className="page-sub">Nenhuma variante de estoque cadastrada para esta referência.</p>
      ) : (
        <table className="ficha-doc-tabela">
          <thead>
            <tr>
              <th className="col-cor">Cor</th>
              {tamanhos.map((t) => <th key={t}>{t}</th>)}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.cor}>
                <td className="col-cor">{l.cor || '(sem cor)'}</td>
                {l.quantidades.map((q, i) => <td key={i}>{q}</td>)}
                <td className="col-total">{l.total}</td>
              </tr>
            ))}
            <tr className="linha-totalizador">
              <td className="col-cor">TOTALIZADOR</td>
              {totalizador.map((q, i) => <td key={i}>{q}</td>)}
              <td className="col-total">{quantidadeTotal}</td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="ficha-doc-resumos">
        <div className="ficha-doc-resumo">
          <table>
            <thead><tr><th colSpan="2">TOTALIZADOR</th></tr></thead>
            <tbody>
              <tr><td>Qtd. Total:</td><td className="col-total">{quantidadeTotal}</td></tr>
              {/* Esta folha é conferida no chão da fábrica: "R$ 0,00" seria
                  lido como "esta referência não vale nada", e não como "o
                  custo dela nunca foi cadastrado". */}
              <tr><td>Custo Total:</td><td className="col-total">{brlOuTraco(custoTotal)}</td></tr>
              <tr><td>Valor Total:</td><td className="col-total">{brlOuTraco(valorTotal)}</td></tr>
            </tbody>
          </table>
          {motivoSemCusto && (
            <p className="page-sub" style={{ margin: '6px 0 0' }}>{motivoSemCusto}</p>
          )}
        </div>
      </div>
    </div>
  );
}
