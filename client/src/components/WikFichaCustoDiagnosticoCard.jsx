import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from '../api/client';

export default function WikFichaCustoDiagnosticoCard() {
  const [referencia, setReferencia] = useState('');
  const [loading, setLoading] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');

  async function testar(e) {
    e.preventDefault();
    if (!referencia.trim()) return;
    setLoading(true);
    setErro('');
    setResultado(null);
    try {
      const data = await api.post('/wik/ficha-custo/diagnosticar', { referencia: referencia.trim() });
      setResultado(data);
    } catch (err) {
      setErro(err.message);
      if (err.data) setResultado(err.data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head"><FlaskConical size={14} style={{ verticalAlign: -2, marginRight: 4 }} />Testar Ficha de Custo (Audaces) — em investigação</div>
      <p className="page-sub" style={{ marginTop: -6, marginBottom: 14 }}>
        Ainda não sabemos como o Wik liga a ficha técnica (materiais/operações) a um produto específico
        na prática. Digite a referência de um produto já importado pra ver a resposta crua da API — isso
        vai definir como construir a importação completa da ficha de custo.
      </p>

      <form onSubmit={testar} style={{ display: 'flex', gap: 8 }}>
        <input placeholder="Referência do produto (ex: 10010)" value={referencia} onChange={(e) => setReferencia(e.target.value)} style={{ maxWidth: 240 }} />
        <button className="btn btn-primary" type="submit" disabled={loading}>{loading ? 'Consultando…' : 'Testar'}</button>
      </form>

      {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}

      {resultado && (
        <pre style={{
          marginTop: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 500, overflowY: 'auto',
          background: 'rgba(0,0,0,0.05)', padding: 10, borderRadius: 6, fontSize: 12,
        }}>{JSON.stringify(resultado, null, 2)}</pre>
      )}
    </div>
  );
}
