import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, CheckCircle2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { api } from '../api/client';

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
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/estoque')}>
        <ArrowLeft size={14} /> Voltar para estoque
      </button>

      <h2>Importar EAN do Sistema Real</h2>
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
            <input type="file" accept=".csv" multiple ref={fileRef} />
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

          <button className="btn btn-primary" onClick={handleConfirmar} disabled={loading}>
            {loading ? 'Gravando…' : 'Confirmar importação'}
          </button>
        </>
      )}
    </div>
  );
}
