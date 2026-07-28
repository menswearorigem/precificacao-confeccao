import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, CheckCircle2, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { api } from '../api/client';

export default function ImportacaoPage() {
  const fileRef = useRef(null);
  const [tipoCsv, setTipoCsv] = useState('produtos');
  const [isCsv, setIsCsv] = useState(false);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState(null);

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    setIsCsv(!!file && !/\.xlsx$/i.test(file.name));
    setPreview(null);
    setResultado(null);
    setError('');
  }

  async function handlePreview(e) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Selecione um arquivo .xlsx ou .csv.');
      return;
    }
    setLoading(true);
    setError('');
    setResultado(null);
    const formData = new FormData();
    formData.append('file', file);
    if (isCsv) formData.append('tipo', tipoCsv);
    try {
      const data = await api.upload('/importacao/preview', formData);
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
      const body = {
        produtosCriar: preview.produtos.criar,
        produtosAtualizar: preview.produtos.atualizar,
        materiais: preview.materiais.validos,
        custosIndustriais: preview.custosIndustriais.validos,
      };
      const data = await api.post('/importacao/confirmar', body);
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
      <h2>Importação em Massa</h2>
      <p className="page-sub">
        Envie um .xlsx com as abas <strong>Cadastro_Produto</strong>, <strong>Materiais</strong> e/ou{' '}
        <strong>Custos_Industriais</strong> (mesmo formato da planilha original), ou um .csv com uma
        dessas tabelas por vez. Nada é gravado até você conferir e confirmar.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handlePreview} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field">
            <span className="field-label">Arquivo (.xlsx ou .csv)</span>
            <input type="file" accept=".xlsx,.csv" ref={fileRef} onChange={handleFileChange} />
          </div>
          {isCsv && (
            <div className="field">
              <span className="field-label">Esse CSV é a tabela de:</span>
              <select value={tipoCsv} onChange={(e) => setTipoCsv(e.target.value)}>
                <option value="produtos">Cadastro de Produtos</option>
                <option value="materiais">Materiais</option>
                <option value="custos_industriais">Custos Industriais</option>
              </select>
            </div>
          )}
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
            {resultado.criados} produto(s) criado(s), {resultado.atualizados} atualizado(s).{' '}
            {resultado.referenciasComMateriaisAtualizados} referência(s) com materiais gravados,{' '}
            {resultado.referenciasComCustosAtualizados} com custos industriais gravados.
          </p>
          <Link to="/produtos" className="btn btn-ghost">Ver produtos</Link>
        </div>
      )}

      {preview && (
        <>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head"><FileSpreadsheet size={14} /> Produtos — serão criados ({preview.produtos.criar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Descrição</th><th>Categoria</th><th>Marca</th></tr></thead>
                <tbody>
                  {preview.produtos.criar.map((p, i) => (
                    <tr key={i}><td className="mono">{p.referencia}</td><td>{p.descricao}</td><td>{p.categoria}</td><td>{p.marca}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-head"><FileSpreadsheet size={14} /> Produtos — serão atualizados ({preview.produtos.atualizar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Descrição</th><th>Categoria</th><th>Marca</th></tr></thead>
                <tbody>
                  {preview.produtos.atualizar.map((p, i) => (
                    <tr key={i}><td className="mono">{p.referencia}</td><td>{p.descricao}</td><td>{p.categoria}</td><td>{p.marca}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head">Materiais válidos ({preview.materiais.validos.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Material</th><th>Un.</th><th>Qtd</th><th>Vlr. unit.</th></tr></thead>
                <tbody>
                  {preview.materiais.validos.slice(0, 50).map((m, i) => (
                    <tr key={i}><td className="mono">{m.referencia}</td><td>{m.material}</td><td>{m.unidade}</td><td className="mono">{m.quantidade}</td><td className="mono">{m.valor_unitario}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.materiais.validos.length > 50 && <p className="page-sub">Mostrando 50 de {preview.materiais.validos.length}.</p>}
            </div>
            <div className="card">
              <div className="card-head">Custos industriais válidos ({preview.custosIndustriais.validos.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Tipo</th><th>Observação</th><th>Valor</th></tr></thead>
                <tbody>
                  {preview.custosIndustriais.validos.slice(0, 50).map((c, i) => (
                    <tr key={i}><td className="mono">{c.referencia}</td><td>{c.tipo}</td><td>{c.observacao}</td><td className="mono">{c.valor}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.custosIndustriais.validos.length > 50 && <p className="page-sub">Mostrando 50 de {preview.custosIndustriais.validos.length}.</p>}
            </div>
          </div>

          {totalErros > 0 && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger-ring)' }}>
              <div className="card-head" style={{ color: 'var(--danger)' }}>
                <AlertTriangle size={14} /> Linhas com erro ({totalErros}) — não serão importadas
              </div>
              <table className="data-table">
                <thead><tr><th>Origem</th><th>Linha</th><th>Motivo</th></tr></thead>
                <tbody>
                  {preview.produtos.erros.map((e, i) => (
                    <tr key={'p' + i}><td>Produtos</td><td>{e.linha}</td><td>{e.motivo}</td></tr>
                  ))}
                  {preview.materiais.erros.map((e, i) => (
                    <tr key={'m' + i}><td>Materiais</td><td>{e.linha}</td><td>{e.motivo}</td></tr>
                  ))}
                  {preview.custosIndustriais.erros.map((e, i) => (
                    <tr key={'c' + i}><td>Custos Industriais</td><td>{e.linha}</td><td>{e.motivo}</td></tr>
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
