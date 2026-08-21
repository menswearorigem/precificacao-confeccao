import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, SearchCheck } from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd } from '../lib/format';
import { Skeleton } from '../components/ui';

// Cada critério aqui é só um "cheiro" de dado de teste — não uma certeza.
// Por isso a tela NUNCA apaga nada sozinha: só lista, com o motivo, e leva
// pra ficha do próprio registro (cliente/fornecedor/viagem/pedido) pra quem
// olhar decidir com calma se apaga, corrige ou ignora.
function GrupoSuspeito({ titulo, itens, render }) {
  if (itens.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">{titulo} ({itens.length})</div>
      <table className="data-table">
        <tbody>
          {itens.map((item) => render(item))}
        </tbody>
      </table>
    </div>
  );
}

function Motivos({ motivos }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {motivos.map((m) => (
        <span key={m} className="stamp sm tone-atencao">{m}</span>
      ))}
    </div>
  );
}

export default function ConferenciaDadosPage() {
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/conferencia-dados')
      .then(setDados)
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page-wide">
      <h2><SearchCheck size={20} style={{ verticalAlign: -3, marginRight: 6 }} />Conferência de Dados</h2>
      <p className="page-sub">
        Lista registros com cara de dado de teste (nome sem vogais ou curto de mais, quantidade ou
        valor muito fora do normal) — cada um com o motivo da suspeita. Isto é só um raio-x, não faz
        nada sozinho: nenhum item é apagado ou alterado por esta tela.
      </p>

      <div className="aviso-compacto tone-atencao" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Confira item a item antes de mexer em qualquer um. A exclusão de um cliente, fornecedor, viagem
          ou pedido é <strong>definitiva</strong> — não tem como desfazer depois. Esta tela não tem (e não
          vai ter) um botão de "apagar todos": clique no item pra abrir a ficha dele e decidir por lá.
        </span>
      </div>

      {erro && <div className="login-error" style={{ marginTop: 12 }}>{erro}</div>}

      {loading && (
        <div className="card" style={{ marginTop: 16 }}>
          <Skeleton width="40%" height={16} style={{ marginBottom: 10 }} />
          <Skeleton width="70%" style={{ marginBottom: 8 }} />
          <Skeleton width="55%" />
        </div>
      )}

      {!loading && dados && dados.total === 0 && (
        <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: '32px 16px' }}>
          <SearchCheck size={28} style={{ color: 'var(--success)' }} />
          <p style={{ marginTop: 10, color: 'var(--ink-soft)' }}>
            Nenhum registro com cara de dado de teste encontrado agora — nada pra revisar aqui.
          </p>
        </div>
      )}

      {!loading && dados && dados.total > 0 && (
        <div style={{ marginTop: 16 }}>
          <GrupoSuspeito
            titulo="Clientes"
            itens={dados.clientes}
            render={(c) => (
              <tr key={`cliente-${c.id}`}>
                <td style={{ fontWeight: 600 }}>{c.nome}</td>
                <td className="mono">{c.cpfCnpj || '—'}</td>
                <td><Motivos motivos={c.motivos} /></td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/clientes/${c.id}`} className="icon-btn"><ChevronRight size={16} /></Link>
                </td>
              </tr>
            )}
          />
          <GrupoSuspeito
            titulo="Fornecedores"
            itens={dados.fornecedores}
            render={(f) => (
              <tr key={`fornecedor-${f.id}`}>
                <td style={{ fontWeight: 600 }}>{f.nome}</td>
                <td className="mono">{f.cpfCnpj || '—'}</td>
                <td><Motivos motivos={f.motivos} /></td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/fornecedores/${f.id}`} className="icon-btn"><ChevronRight size={16} /></Link>
                </td>
              </tr>
            )}
          />
          <GrupoSuspeito
            titulo="Viagens"
            itens={dados.viagens}
            render={(v) => (
              <tr key={`viagem-${v.id}`}>
                <td style={{ fontWeight: 600 }}>{v.nome}</td>
                <td className="mono">{brl(v.faturamento)}</td>
                <td><Motivos motivos={v.motivos} /></td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/viagens/${v.id}`} className="icon-btn"><ChevronRight size={16} /></Link>
                </td>
              </tr>
            )}
          />
          <GrupoSuspeito
            titulo="Pedidos"
            itens={dados.pedidos}
            render={(p) => (
              <tr key={`pedido-${p.id}`}>
                <td className="mono">#{p.numero}</td>
                <td>{p.clienteNome || '—'}</td>
                <td className="mono">{formatQtd(p.quantidadePecas)} peças · {brl(p.totalLiquido)}</td>
                <td><Motivos motivos={p.motivos} /></td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/pedidos/${p.id}`} className="icon-btn"><ChevronRight size={16} /></Link>
                </td>
              </tr>
            )}
          />
        </div>
      )}
    </div>
  );
}
