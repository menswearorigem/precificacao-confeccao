import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Barcode, CheckCircle2, XCircle, ArrowDownCircle, ArrowUpCircle, ScanLine, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { Field } from '../components/ui';

// Teto de segurança da leitura. Existe por causa de um defeito real: o campo
// de quantidade ficava DENTRO do mesmo formulário do EAN, e o leitor de
// código de barras "digita" os 13 dígitos seguidos de Enter. Bastava o cursor
// estar no campo errado para a quantidade virar 7891234567890 e a leitura
// seguinte mover sete trilhões de peças. O campo saiu do formulário (abaixo),
// e este teto é a segunda tranca.
const QTD_MAXIMA_POR_LEITURA = 999;

export default function BipagemPage() {
  const navigate = useNavigate();
  const [tipo, setTipo] = useState('saida');
  const [ean, setEan] = useState('');
  const [quantidade, setQuantidade] = useState(1);
  const [log, setLog] = useState([]);
  const [comFoco, setComFoco] = useState(true);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [tipo]);

  const qtdNumero = Number(quantidade);
  const qtdValida = Number.isInteger(qtdNumero) && qtdNumero >= 1 && qtdNumero <= QTD_MAXIMA_POR_LEITURA;

  // Devolver o foco ao campo de leitura é a operação mais importante da tela:
  // sem foco, o leitor digita no vazio e a peça bipada some sem deixar rastro.
  function voltarAoCampo() {
    inputRef.current?.focus();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const codigo = ean.trim();
    // Leitura vazia também precisa devolver o foco: antes o `return` saía
    // antes do `finally`, e uma leitura perdida deixava o foco onde estava —
    // ou seja, TODAS as seguintes se perdiam também, em silêncio.
    if (!codigo) { voltarAoCampo(); return; }
    if (!qtdValida) {
      setLog((l) => [{
        ok: false, ean: codigo, tipo,
        texto: `Quantidade inválida (${quantidade}). Corrija antes de bipar.`,
        hora: new Date().toLocaleTimeString('pt-BR'),
      }, ...l].slice(0, 30));
      voltarAoCampo();
      return;
    }
    setEan('');
    try {
      const data = await api.post('/estoque/bipar', { ean: codigo, tipo, quantidade: qtdNumero });
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
      <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/estoque')}>
        <ArrowLeft size={14} /> Voltar para estoque
      </button>

      <h1><Barcode size={22} style={{ verticalAlign: -3, marginRight: 8 }} />Bipagem</h1>
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

        {/* A quantidade fica FORA do formulário do EAN, de propósito. Dentro
            dele, o Enter que o leitor manda no fim da leitura submetia o
            formulário com os 13 dígitos do código de barras no campo de
            quantidade. */}
        <div className="bipagem-quantidade">
          <Field
            label="Quantidade por leitura"
            hint={`Quantas peças cada bipada movimenta. Entre 1 e ${QTD_MAXIMA_POR_LEITURA}.`}
          >
            <input
              type="number"
              min="1"
              max={QTD_MAXIMA_POR_LEITURA}
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
              style={{ width: 110 }}
            />
          </Field>
          {!qtdValida && (
            <p className="bipagem-quantidade-erro">
              <AlertTriangle size={13} /> Quantidade inválida — a bipagem está bloqueada até corrigir.
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="bipagem-form">
          <Field label="Código EAN (bipe aqui)">
            <input
              ref={inputRef}
              value={ean}
              onChange={(e) => setEan(e.target.value)}
              onFocus={() => setComFoco(true)}
              onBlur={() => setComFoco(false)}
              autoComplete="off"
              inputMode="numeric"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 18 }}
            />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={!qtdValida}>
            Confirmar {tipo === 'entrada' ? 'entrada' : 'saída'}
          </button>
        </form>

        {/* Sinal grande e visível de que o leitor tem para onde mandar a
            leitura. Sem isso, o campo perde o foco a qualquer toque na tela e
            as bipadas seguintes somem sem nenhum aviso. */}
        <button
          type="button"
          className={`bipagem-foco ${comFoco ? 'pronto' : 'sem-foco'}`}
          onClick={voltarAoCampo}
        >
          <ScanLine size={16} />
          {comFoco
            ? `Pronto para bipar · ${qtdValida ? qtdNumero : '—'} peça(s) por leitura`
            : 'SEM FOCO — toque aqui antes de bipar'}
        </button>
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
