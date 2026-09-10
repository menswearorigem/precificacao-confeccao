import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, CheckCircle2, AlertTriangle, ArrowLeft, Trash2, Search, Barcode } from 'lucide-react';
import { api } from '../api/client';
import FileDropzone from '../components/FileDropzone';
import DataTable from '../components/DataTable';
import { ThOrdenavel, Paginacao, SkeletonLinhasTabela, EstadoVazio } from '../components/ui';
import { useTabela } from '../lib/useTabela';
import { confirmar } from '../components/ConfirmDialog';

const COLUNAS_GUARDADOS = {
  referencia: (m) => m.referencia,
  cor: (m) => m.cor,
  tamanho: (m) => m.tamanho,
  ean: (m) => m.ean,
};

// EANs guardados, com busca e remoção (09/09/2026).
//
// POR QUE: GET e DELETE /estoque/ean-mapeamento existiam desde a migration
// 0004 e nenhuma tela chamava. Depois de importar, o que ficou "guardado para
// quando a variante existir" sumia de vista: não dava para conferir se um EAN
// foi mesmo gravado, nem para tirar um que veio errado do arquivo do Wik —
// e como a coluna `ean` é UNIQUE, um EAN errado guardado bloqueia o EAN certo
// numa importação seguinte, sem que ninguém veja o porquê.
function EansGuardados({ chave }) {
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [removendo, setRemovendo] = useState(null);

  function carregar() {
    setCarregando(true);
    setErro('');
    api.get('/estoque/ean-mapeamento')
      .then(setItens)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }

  useEffect(carregar, [chave]);

  const termo = busca.trim().toLowerCase();
  const filtrados = termo
    ? itens.filter((m) => [m.referencia, m.cor, m.tamanho, m.ean]
        .some((v) => String(v || '').toLowerCase().includes(termo)))
    : itens;

  const tabela = useTabela(filtrados, { colunas: COLUNAS_GUARDADOS, colunaPadrao: 'referencia', prefixo: 'ean' });

  async function remover(m) {
    const onde = [m.referencia, m.cor, m.tamanho].filter(Boolean).join(' · ');
    if (!(await confirmar(`Apagar o EAN ${m.ean} guardado para ${onde}?`))) return;
    setErro('');
    setRemovendo(m.id);
    try {
      await api.del(`/estoque/ean-mapeamento/${m.id}`);
      setItens((lista) => lista.filter((x) => x.id !== m.id));
    } catch (e) {
      setErro(e.message);
    } finally {
      setRemovendo(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-head"><Barcode size={14} /> EANs já importados ({itens.length.toLocaleString('pt-BR')})</div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Tudo que veio dos arquivos do Wik. Cada linha é aplicada na variante correspondente
        assim que ela existir. Apagar uma linha aqui não mexe no estoque nem no EAN de uma
        variante que já foi criada — só tira o mapeamento guardado.
      </p>

      <div className="campo-com-icone" style={{ marginBottom: 12, maxWidth: 420 }}>
        <Search size={14} aria-hidden="true" />
        <input
          placeholder="Buscar por referência, cor, tamanho ou EAN"
          aria-label="Buscar nos EANs importados"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

      <Paginacao {...tabela} posicao="topo" />
      <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <ThOrdenavel coluna="referencia" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Referência</ThOrdenavel>
              <ThOrdenavel coluna="cor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cor</ThOrdenavel>
              <ThOrdenavel coluna="tamanho" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Tamanho</ThOrdenavel>
              <ThOrdenavel coluna="ean" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>EAN</ThOrdenavel>
              <th />
            </tr>
          </thead>
          <tbody>
            {carregando && itens.length === 0 && <SkeletonLinhasTabela colunas={5} />}
            {tabela.itensPagina.map((m) => (
              <tr key={m.id}>
                <td className="mono">{m.referencia}</td>
                <td>{m.cor || <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
                <td>{m.tamanho || <span style={{ color: 'var(--ink-faint)' }}>—</span>}</td>
                <td className="mono">{m.ean}</td>
                <td>
                  <button
                    type="button"
                    className="icon-btn perigo"
                    title="Apagar este mapeamento"
                    aria-label={`Apagar o EAN ${m.ean}`}
                    disabled={removendo === m.id}
                    onClick={() => remover(m)}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
      {!carregando && itens.length === 0 && (
        <EstadoVazio
          Icone={Barcode}
          titulo="Nenhum EAN importado ainda"
          descricao="Envie os arquivos do Wik acima para que a bipagem passe a usar o EAN verdadeiro da etiqueta."
        />
      )}
      {!carregando && itens.length > 0 && filtrados.length === 0 && (
        <p className="page-sub">Nenhum EAN encontrado para "{busca}".</p>
      )}
      <Paginacao {...tabela} />
    </div>
  );
}

export default function EstoqueEanImportacaoPage() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState(null);

  async function handlePreview(e) {
    e.preventDefault();
    const files = fileRef.current?.files;
    if (!files || files.length === 0) {
      setError('Selecione um ou mais arquivos .csv.');
      return;
    }
    setLoading(true);
    setError('');
    setResultado(null);
    const formData = new FormData();
    for (const file of files) formData.append('files', file);
    try {
      const data = await api.upload('/estoque/ean-mapeamento/preview', formData);
      setPreview(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmar() {
    if (!preview) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.post('/estoque/ean-mapeamento/confirmar', {
        aplicarImediato: preview.aplicarImediato,
        guardarParaDepois: preview.guardarParaDepois,
      });
      setResultado(data);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const totalErros = preview?.erros?.length || 0;

  return (
    <div className="page-wide">
      <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/estoque')}>
        <ArrowLeft size={14} /> Voltar para estoque
      </button>

      <h1>Importar EAN do Sistema Real</h1>
      <p className="page-sub">
        Envie um ou mais arquivos "relListaProd" do Wiki Sistemas (colunas REF, COR, TAM, EAN
        EXTERNO). Se a variante já existe aqui, o EAN dela é atualizado na hora. Se ainda não
        existe, o EAN fica guardado e é aplicado automaticamente assim que a variante for
        cadastrada (manual ou por importação de saldo) — assim a bipagem sempre usa o EAN
        verdadeiro da etiqueta. Nada é gravado até você confirmar.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handlePreview} style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div className="field">
            <span className="field-label">Arquivos (.csv) — pode selecionar vários de uma vez</span>
            <FileDropzone accept=".csv" multiple ref={fileRef} formatosTexto="Formato aceito: .csv" />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            <Upload size={14} /> {loading ? 'Processando…' : 'Pré-visualizar'}
          </button>
        </form>
        {error && <div className="login-error" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {resultado && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--success-ring)' }}>
          <div className="card-head" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={14} /> Importação concluída
          </div>
          <p>
            {resultado.aplicados} EAN(s) aplicado(s) direto na variante já existente,{' '}
            {resultado.guardados} guardado(s) para aplicar quando a variante for criada.
          </p>
        </div>
      )}

      {preview && (
        <>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head">Variantes existentes — EAN será atualizado ({preview.aplicarImediato.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>EAN atual</th><th>EAN novo</th></tr></thead>
                <tbody>
                  {preview.aplicarImediato.slice(0, 100).map((v, i) => (
                    <tr key={i}>
                      <td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td>
                      <td className="mono">{v.eanAtual}</td>
                      <td className="mono" style={{ fontWeight: v.eanAtual !== v.eanNovo ? 700 : 400 }}>{v.eanNovo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.aplicarImediato.length > 100 && <p className="page-sub">Mostrando 100 de {preview.aplicarImediato.length}.</p>}
            </div>
            <div className="card">
              <div className="card-head">Ainda sem variante — EAN fica guardado ({preview.guardarParaDepois.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>EAN</th></tr></thead>
                <tbody>
                  {preview.guardarParaDepois.slice(0, 100).map((v, i) => (
                    <tr key={i}><td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td><td className="mono">{v.ean}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.guardarParaDepois.length > 100 && <p className="page-sub">Mostrando 100 de {preview.guardarParaDepois.length}.</p>}
            </div>
          </div>

          {totalErros > 0 && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger-ring)' }}>
              <div className="card-head" style={{ color: 'var(--danger)' }}>
                <AlertTriangle size={14} /> Linhas com erro ({totalErros}) — não serão importadas
              </div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Motivo</th></tr></thead>
                <tbody>
                  {preview.erros.slice(0, 100).map((e, i) => (
                    <tr key={i}>
                      <td className="mono">{e.dados?.referencia}</td>
                      <td>{e.dados?.cor}</td>
                      <td>{e.dados?.tamanho}</td>
                      <td>{e.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button type="button" className="btn btn-primary" onClick={handleConfirmar} disabled={loading}>
            {loading ? 'Gravando…' : 'Confirmar importação'}
          </button>
        </>
      )}

      <EansGuardados chave={resultado ? resultado.aplicados + resultado.guardados : 0} />
    </div>
  );
}
