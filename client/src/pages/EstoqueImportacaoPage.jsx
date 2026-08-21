import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, CheckCircle2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { api } from '../api/client';
import FileDropzone from '../components/FileDropzone';
import { formatQtd } from '../lib/format';

export default function EstoqueImportacaoPage() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState(null);

  async function handlePreview(e) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Selecione um arquivo .csv ou .pdf.');
      return;
    }
    setLoading(true);
    setError('');
    setResultado(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const data = await api.upload('/estoque/importacao/preview', formData);
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
      const data = await api.post('/estoque/importacao/confirmar', {
        criar: preview.criar,
        atualizar: preview.atualizar,
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

  const totalErros = preview?.resumo.totalErros || 0;

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/estoque')}>
        <ArrowLeft size={14} /> Voltar para estoque
      </button>

      <h2>Importar Saldo de Estoque</h2>
      <p className="page-sub">
        Envie o relatório de saldo de estoque do Wiki Sistemas — o CSV "relEst" (uma linha por
        referência + cor + tamanho) ou o PDF "Relatório - Saldo de estoque" (em grade, cor x
        tamanho). A referência precisa já estar cadastrada em Produtos. Nada é gravado até você
        confirmar.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handlePreview} style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div className="field">
            <span className="field-label">Arquivo (.csv ou .pdf)</span>
            <FileDropzone accept=".csv,.pdf" ref={fileRef} formatosTexto="Formatos aceitos: .csv ou .pdf" />
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
          <p>{resultado.criados} variante(s) nova(s), {resultado.atualizados} atualizada(s).</p>
        </div>
      )}

      {preview && (
        <>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head">Variantes novas ({preview.criar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd.</th></tr></thead>
                <tbody>
                  {preview.criar.slice(0, 100).map((v, i) => (
                    <tr key={i}><td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td><td className="mono">{formatQtd(v.quantidadeNova)}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.criar.length > 100 && <p className="page-sub">Mostrando 100 de {preview.criar.length}.</p>}
            </div>
            <div className="card">
              <div className="card-head">Variantes a atualizar ({preview.atualizar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd. atual</th><th>Qtd. nova</th></tr></thead>
                <tbody>
                  {preview.atualizar.slice(0, 100).map((v, i) => (
                    <tr key={i}>
                      <td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td>
                      <td className="mono">{formatQtd(v.quantidadeAtual)}</td>
                      <td className="mono" style={{ fontWeight: v.quantidadeAtual !== v.quantidadeNova ? 700 : 400 }}>{formatQtd(v.quantidadeNova)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.atualizar.length > 100 && <p className="page-sub">Mostrando 100 de {preview.atualizar.length}.</p>}
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
                    <tr key={i}><td className="mono">{e.dados.referencia}</td><td>{e.dados.cor}</td><td>{e.dados.tamanho}</td><td>{e.motivo}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className="btn btn-primary" onClick={handleConfirmar} disabled={loading}>
            {loading ? 'Gravando…' : 'Confirmar importação'}
          </button>
        </>
      )}
    </div>
  );
}
