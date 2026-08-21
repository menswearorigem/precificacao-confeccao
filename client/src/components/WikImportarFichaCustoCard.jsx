import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { brl } from '../lib/format';

export default function WikImportarFichaCustoCard() {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [sincronizandoAgora, setSincronizandoAgora] = useState(false);

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

  // Mesma busca, mas dispara e já grava sozinha (sem passar por
  // conferência) — igual ao que já roda automaticamente a cada 6h.
  async function atualizarAgora() {
    setErro('');
    setAviso('');
    setResultado(null);
    setSincronizandoAgora(true);
    try {
      const data = await api.post('/wik/ficha-custo/sincronizar-agora', {});
      if (data.pulado) {
        setAviso(`Não rodou agora: ${data.pulado}.`);
      } else {
        setResultado(data);
      }
    } catch (err) {
      setErro(err.message);
    } finally {
      setSincronizandoAgora(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Importar Ficha de Custo do Wik</div>
      <p className="page-sub" style={{ marginTop: -6, marginBottom: 14 }}>
        Traz o custo total já calculado e aprovado na Ficha de Custo do Wik (o mesmo valor que aparece na
        ficha impressa) pra cada produto que ainda não tem ficha, e ATUALIZA a ficha de produto que já foi
        trazida do Wik antes, acompanhando mudanças feitas lá — nunca mexe em produto que você editou
        manualmente aqui. Além disso, roda sozinha a cada 6 horas; os botões abaixo são só pra conferir ou
        forçar agora. Os materiais entram como referência (nome e quantidade por peça), mas sem custo
        individual — o Wik não expõe um custo por material que bata com a ficha aprovada, só o total
        (confirmado comparando com a ficha impressa real).
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={atualizarAgora} disabled={sincronizandoAgora || loading}>
          <RefreshCw size={13} /> {sincronizandoAgora ? 'Atualizando…' : 'Atualizar agora'}
        </button>
        <button className="btn btn-ghost" onClick={iniciar} disabled={loading || sincronizandoAgora}>
          <Download size={13} /> {loading ? 'Buscando no Wik…' : 'Só conferir (sem aplicar)'}
        </button>
      </div>
      {(loading || sincronizandoAgora) && (
        <p className="page-sub" style={{ marginTop: 8 }}>
          Isso pode levar bastante tempo (uma chamada ao produto por referência, mais uma por material único
          pra pegar a unidade de medida, respeitando o limite de 3 requisições/segundo do Wik). Pode continuar
          usando o sistema normalmente.
        </p>
      )}

      {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
      {aviso && <div className="stamp sm tone-saudavel" style={{ marginTop: 10, display: 'inline-flex' }}>{aviso}</div>}

      {resultado && (
        <div className="card" style={{ marginTop: 14, borderColor: 'var(--success-ring)' }}>
          <div className="card-head" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={14} /> Importação concluída
          </div>
          <p>
            {resultado.produtosAtualizados} produto(s) com ficha de custo criada ou atualizada — {resultado.materiaisCriados} material(is)
            e {resultado.custosCriados} operaç(ões) de custo industrial no total.
            {resultado.ignorados.length > 0 && ` ${resultado.ignorados.length} produto(s) tinham ficha editada manualmente e foram ignorados (protegidos).`}
          </p>
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div><span className="field-label">Candidatos (sem ficha ou vindos do Wik)</span><div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{preview.resumo.totalCandidatos}</div></div>
            <div><span className="field-label">Ficha encontrada no Wik</span><div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--success)' }}>{preview.resumo.comFichaEncontrada}</div></div>
            <div><span className="field-label">Sem ficha no Wik</span><div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{preview.resumo.semFichaNoWik}</div></div>
            <div><span className="field-label">Sem custo total</span><div className="mono" style={{ fontSize: 18, fontWeight: 700, color: preview.resumo.semCustoTotal > 0 ? 'var(--danger)' : undefined }}>{preview.resumo.semCustoTotal}</div></div>
            <div><span className="field-label">Com erro</span><div className="mono" style={{ fontSize: 18, fontWeight: 700, color: preview.resumo.totalErros > 0 ? 'var(--danger)' : undefined }}>{preview.resumo.totalErros}</div></div>
          </div>

          {preview.resumo.semCustoTotal > 0 && (
            <div className="login-error" style={{ marginBottom: 12 }}>
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              {preview.resumo.semCustoTotal} produto(s) tinham materiais/operações mas nenhum custo total
              encontrado (sem tabela de preço no Wik) — serão criados só com a referência de materiais, sem
              nenhum custo. Precisam ser preenchidos manualmente.
            </div>
          )}

          <table className="data-table" style={{ marginBottom: 10 }}>
            <thead><tr><th>Referência</th><th>Descrição</th><th>Materiais (ref.)</th><th>Operações</th><th>Custo Total (Wik)</th></tr></thead>
            <tbody>
              {preview.produtos.slice(0, 200).map((p, i) => (
                <tr key={i}>
                  <td className="mono">{p.referencia}</td>
                  <td>{p.descricao}</td>
                  <td className="mono">{p.materiais.length}</td>
                  <td className="mono">{p.custosIndustriais.length - (p.custoTotalWik != null ? 1 : 0)}</td>
                  <td className="mono" style={{ fontWeight: 700, color: p.custoTotalWik != null ? 'var(--success)' : 'var(--danger)' }}>
                    {p.custoTotalWik != null ? brl(p.custoTotalWik) : 'sem custo'}
                  </td>
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
