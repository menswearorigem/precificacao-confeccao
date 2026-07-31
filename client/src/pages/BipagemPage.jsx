import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Barcode, CheckCircle2, XCircle, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { api } from '../api/client';
import { Field } from '../components/ui';

export default function BipagemPage() {
  const navigate = useNavigate();
  const [tipo, setTipo] = useState('saida');
  const [ean, setEan] = useState('');
  const [quantidade, setQuantidade] = useState(1);
  const [log, setLog] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tipo]);

  async function handleSubmit(e) {
    e.preventDefault();
    const codigo = ean.trim();
    if (!codigo) return;
    setEan('');
    try {
      const data = await api.post('/estoque/bipar', { ean: codigo, tipo, quantidade: Number(quantidade) || 1 });
      setLog((l) => [{
        ok: true,
        ean: codigo,
        tipo,
        texto: `${data.referencia} · ${data.cor} ${data.tamanho} — nova qtd.: ${data.quantidade}`,
        aviso: data.estoqueNegativo ? 'Estoque ficou negativo!' : null,
        hora: new Date().toLocaleTimeString('pt-BR'),
      }, ...l].slice(0, 30));
    } catch (err) {
      setLog((l) => [{ ok: false, ean: codigo, tipo, texto: err.message, hora: new Date().toLocaleTimeString('pt-BR') }, ...l].slice(0, 30));
    } finally {
      inputRef.current?.focus();
    }
  }

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/estoque')}>
        <ArrowLeft size={14} /> Voltar para estoque
      </button>

      <h2><Barcode size={22} style={{ verticalAlign: -3, marginRight: 8 }} />Bipagem</h2>
      <p className="page-sub">
        Escolha se a leitura é entrada ou saída, depois aponte o leitor de código de barras para
        a etiqueta (EAN). Cada leitura já ajusta o estoque daquela variação na hora.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button
            type="button"
            className={tipo === 'saida' ? 'btn btn-primary' : 'btn btn-ghost'}
            onClick={() => setTipo('saida')}
            style={tipo === 'saida' ? { background: 'var(--danger)', borderColor: 'var(--danger-ring)' } : {}}
          >
            <ArrowDownCircle size={15} /> Saída
          </button>
          <button
            type="button"
            className={tipo === 'entrada' ? 'btn btn-primary' : 'btn btn-ghost'}
            onClick={() => setTipo('entrada')}
            style={tipo === 'entrada' ? { background: 'var(--success)', borderColor: 'var(--success-ring)' } : {}}
          >
            <ArrowUpCircle size={15} /> Entrada
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <Field label="Código EAN (bipe aqui)">
            <input
              ref={inputRef}
              value={ean}
              onChange={(e) => setEan(e.target.value)}
              autoComplete="off"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 18 }}
            />
          </Field>
          <Field label="Quantidade por leitura">
            <input type="number" min="1" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} style={{ width: 100 }} />
          </Field>
          <button className="btn btn-primary" type="submit">
            Confirmar {tipo === 'entrada' ? 'entrada' : 'saída'}
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-head">Últimas leituras</div>
        <ul className="alerts-list">
          {log.map((item, i) => (
            <li key={i} className={item.ok && !item.aviso ? 'ok' : ''} style={item.ok ? {} : { background: 'var(--danger-bg)', color: 'var(--danger)' }}>
              {item.ok ? <CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 6 }} /> : <XCircle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />}
              <span className="mono">{item.hora}</span> — <strong style={{ color: item.tipo === 'entrada' ? 'var(--success)' : 'var(--danger)' }}>{item.tipo === 'entrada' ? 'ENTRADA' : 'SAÍDA'}</strong> — <span className="mono">{item.ean}</span> — {item.texto}
              {item.aviso && <strong> · {item.aviso}</strong>}
            </li>
          ))}
          {log.length === 0 && <li style={{ background: 'transparent', color: 'var(--ink-soft)' }}>Nenhuma leitura ainda.</li>}
        </ul>
      </div>
    </div>
  );
}
