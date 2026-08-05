import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Download } from 'lucide-react';
import { api } from '../api/client';

export default function WikImportarFichaCustoCard() {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [erro, setErro] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState(null);

  useEffect(() => {
    api.get('/wik').then((data) => {
      if (data?.fichaCustoImportStatus === 'rodando') {
        setLoading(true);
        esperar();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function iniciar() {
    setErro('');
    setResultado(null);
    setPreview(null);
    setLoading(true);
    try {
      await api.post('/wik/ficha-custo/preview', {});
      await esperar();
    } catch (err) {
      setErro(err.message);
      setLoading(false);
    }
  }

  async function esperar() {
    for (let tentativa = 0; tentativa < 600; tentativa += 1) {
      const status = await api.get('/wik/ficha-custo/preview');
      if (status.status === 'concluido') {
        setPreview(status.resultado);
        setLoading(false);
        return;
      }
      if (status.status === 'erro') {
        setErro(status.erro || 'Falha ao buscar ficha de custo no Wik.');
        setLoading(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    setErro('A busca no Wik está demorando demais — tente de novo em alguns minutos.');
    setLoading(false);
  }

  async function confirmar() {
    if (!preview) return;
    setConfirmando(true);
    setErro('');
    try {
      const data = await api.post('/wik/ficha-custo/confirmar', { produtos: preview.produtos });
      setResultado(data);
      setPreview(null);
    } catch (err) {
      setErro(err.message);
    } finally {
      setConfirmando(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Importar Ficha de Custo (materiais e operações) do Wik</div>
      <p className="page-sub" style={{ marginTop: -6, marginBottom: 14 }}>
        Traz os materiais (com custo unitário real) e as operações de corte/costura de cada produto que
        ainda não tem nenhuma ficha de custo cadastrada aqui — não mexe em produto que você já preencheu
        manualmente. O Wik não informa o valor de cada operação (corte, facção etc.), então elas entram
        com valor R$ 0,00 — só falta você preencher isso depois.
      </p>

      <button className="btn btn-primary" onClick={iniciar} disabled={loading}>
        <Download size={13} /> {loading ? 'Buscando no Wik…' : 'Buscar ficha de custo dos produtos pendentes'}
      </button>
      {loading && (
        <p className="page-sub" style={{ marginTop: 8 }}>
          Isso pode levar bastante tempo (uma chamada por produto, mais uma por material único, respeitando
          o limite de 3 requisições/segundo do Wik). Pode continuar usando o sistema normalmente.
        </p>
      )}

      {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}

      {resultado && (
        <div className="card" style={{ marginTop: 14, borderColor: 'var(--success-ring)' }}>
          <div className="card-head" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={14} /> Importação concluída
          </div>
          <p>
            {resultado.produtosAtualizados} produto(s) com ficha de custo criada — {resultado.materiaisCriados} material(is)
            e {resultado.custosCriados} operaç(ões) de custo industrial no total.
            {resultado.ignorados.length > 0 && ` ${resultado.ignorados.length} produto(s) já tinham ficha e foram ignorados.`}
          </p>
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div><span className="field-label">Produtos sem ficha (candidatos)</span><div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{preview.resumo.totalCandidatos}</div></div>
            <div><span className="field-label">Ficha encontrada no Wik</span><div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--success)' }}>{preview.resumo.comFichaEncontrada}</div></div>
            <div><span className="field-label">Sem ficha no Wik</span><div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{preview.resumo.semFichaNoWik}</div></div>
            <div><span className="field-label">Com erro</span><div className="mono" style={{ fontSize: 18, fontWeight: 700, color: preview.resumo.totalErros > 0 ? 'var(--danger)' : undefined }}>{preview.resumo.totalErros}</div></div>
          </div>

          <table className="data-table" style={{ marginBottom: 10 }}>
            <thead><tr><th>Referência</th><th>Descrição</th><th>Materiais</th><th>Operações</th></tr></thead>
            <tbody>
              {preview.produtos.slice(0, 200).map((p, i) => (
                <tr key={i}>
                  <td className="mono">{p.referencia}</td>
                  <td>{p.descricao}</td>
                  <td className="mono">{p.materiais.length}</td>
                  <td className="mono">{p.custosIndustriais.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.produtos.length > 200 && <p className="page-sub">Mostrando 200 de {preview.produtos.length}.</p>}

          {preview.erros.length > 0 && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger-ring)' }}>
              <div className="card-head" style={{ color: 'var(--danger)' }}>
                <AlertTriangle size={14} /> Produtos com erro ({preview.erros.length})
              </div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Motivo</th></tr></thead>
                <tbody>
                  {preview.erros.slice(0, 100).map((e, i) => (
                    <tr key={i}><td className="mono">{e.referencia}</td><td>{e.motivo}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className="btn btn-primary" onClick={confirmar} disabled={confirmando || preview.produtos.length === 0}>
            {confirmando ? 'Gravando…' : `Confirmar importação de ${preview.produtos.length} ficha(s)`}
          </button>
        </div>
      )}
    </div>
  );
}
