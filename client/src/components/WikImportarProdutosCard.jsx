import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { api } from '../api/client';

export default function WikImportarProdutosCard() {
  const [integracao, setIntegracao] = useState(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [sincronizandoAgora, setSincronizandoAgora] = useState(false);

  useEffect(() => {
    api.get('/wik').then((data) => {
      setIntegracao(data);
      if (data?.produtosImportStatus === 'rodando') {
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
      await api.post('/wik/produtos/preview', {});
      await esperar();
    } catch (err) {
      setErro(err.message);
      setLoading(false);
    }
  }

  async function esperar() {
    for (let tentativa = 0; tentativa < 400; tentativa += 1) {
      const status = await api.get('/wik/produtos/preview');
      if (status.status === 'concluido') {
        setPreview(status.resultado);
        setLoading(false);
        return;
      }
      if (status.status === 'erro') {
        setErro(status.erro || 'Falha ao buscar produtos no Wik.');
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
      const data = await api.post('/wik/produtos/confirmar', { criar: preview.criar });
      setResultado(data);
      setPreview(null);
    } catch (err) {
      setErro(err.message);
    } finally {
      setConfirmando(false);
    }
  }

  // Mesma importação, mas dispara e já grava sozinha (sem passar por
  // conferência) — igual ao que já roda automaticamente a cada 6h.
  async function atualizarAgora() {
    setErro('');
    setAviso('');
    setResultado(null);
    setSincronizandoAgora(true);
    try {
      const data = await api.post('/wik/produtos/sincronizar-agora', {});
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
      <div className="card-head">Importar catálogo completo de produtos do Wik</div>
      <p className="page-sub" style={{ marginTop: -6, marginBottom: 14 }}>
        Traz TODOS os produtos ativos cadastrados no Wik (nas 4 empresas: matriz, filial, Hoggar/Miss
        Manu e Origem), com marca, categoria e o estoque de cada variante — usando o maior valor entre
        as lojas quando o mesmo produto aparece em mais de uma. Só cria produtos que ainda não existem
        aqui (não duplica). Além disso, roda sozinho a cada 6 horas pra pegar produtos recém-lançados
        no Wik sem precisar clicar em nada — os botões abaixo são só pra conferir ou forçar agora.
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
          Isso pode levar vários minutos (o Wik só libera 3 requisições por segundo e o catálogo pode
          ser grande). Pode continuar usando o sistema normalmente enquanto espera.
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
            {resultado.produtosCriados} produto(s) novo(s) criado(s), {resultado.variantesCriadas} variante(s) de estoque criada(s).
            {resultado.ignorados.length > 0 && ` ${resultado.ignorados.length} referência(s) já existiam e foram ignoradas.`}
          </p>
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div><span className="field-label">Produtos ativos no Wik</span><div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{preview.resumo.totalProdutosWik}</div></div>
            <div><span className="field-label">Novos pra criar</span><div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--success)' }}>{preview.resumo.novosParaCriar}</div></div>
            <div><span className="field-label">Já existentes (ignorados)</span><div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{preview.resumo.jaExistentesIgnorados}</div></div>
            <div><span className="field-label">Sem marca/categoria</span><div className="mono" style={{ fontSize: 18, fontWeight: 700, color: preview.resumo.semMarcaOuCategoria > 0 ? 'var(--danger)' : undefined }}>{preview.resumo.semMarcaOuCategoria}</div></div>
          </div>

          {preview.resumo.semMarcaOuCategoria > 0 && (
            <div className="login-error" style={{ marginBottom: 12 }}>
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
              {preview.resumo.semMarcaOuCategoria} produto(s) não tinham marca/categoria em nenhuma linha de
              estoque do Wik (produto sem saldo cadastrado em lugar nenhum) — serão criados mesmo assim, só
              que sem marca/categoria preenchida. Dá pra completar depois na ficha do produto.
            </div>
          )}

          {preview.resumo.produtoGetDisponivel === false && (
            <div className="stamp sm tone-atencao" style={{ marginBottom: 12, display: 'inline-flex' }}>
              O catálogo veio 100% do saldo de estoque do Wik — a busca complementar de produto (que traria o
              Id interno, usado depois na Ficha de Custo) não respondeu dessa vez, mas não afeta o que está
              listado abaixo.
            </div>
          )}

          <table className="data-table" style={{ marginBottom: 10 }}>
            <thead><tr><th>Referência</th><th>Descrição</th><th>Marca</th><th>Categoria</th><th>Variantes</th></tr></thead>
            <tbody>
              {preview.criar.slice(0, 200).map((p, i) => (
                <tr key={i}>
                  <td className="mono">{p.referencia}</td>
                  <td>{p.descricao}</td>
                  <td>{p.marca || '—'}</td>
                  <td>{p.categoria || '—'}</td>
                  <td className="mono">{p.variantes.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.criar.length > 200 && <p className="page-sub">Mostrando 200 de {preview.criar.length}.</p>}

          <button className="btn btn-primary" onClick={confirmar} disabled={confirmando || preview.criar.length === 0}>
            {confirmando ? 'Gravando…' : `Confirmar importação de ${preview.criar.length} produto(s)`}
          </button>
        </div>
      )}
    </div>
  );
}
