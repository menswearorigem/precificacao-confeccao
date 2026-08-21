import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, AlertTriangle, ChevronRight, Layers } from 'lucide-react';
import { api } from '../api/client';
import { formatQtd } from '../lib/format';
import { Skeleton } from '../components/ui';

function GrupoAchado({ titulo, descricao, total, children }) {
  if (total === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">{titulo} ({formatQtd(total)})</div>
      <p className="page-sub" style={{ margin: '0 0 12px' }}>{descricao}</p>
      {children}
    </div>
  );
}

export default function QualidadeDadosPage() {
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/qualidade-dados')
      .then(setDados)
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page-wide">
      <h2><Layers size={20} style={{ verticalAlign: -3, marginRight: 6 }} />Qualidade do Dado</h2>
      <p className="page-sub">
        Antes de confiar em qualquer painel agregado (Dashboard Executivo, Indicadores de Estoque),
        vale saber o quanto do dado por trás dele está completo. Isto é um raio-x, não um alarme —
        e não corrige nada sozinho.
      </p>

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
          <ShieldCheck size={28} style={{ color: 'var(--success)' }} />
          <p style={{ marginTop: 10, color: 'var(--ink-soft)' }}>
            Nenhuma lacuna de dado encontrada agora nos três critérios acompanhados.
          </p>
        </div>
      )}

      {!loading && dados && dados.total > 0 && (
        <div style={{ marginTop: 16 }}>
          <GrupoAchado
            titulo="Referências com custo de material zerado"
            descricao="Têm material cadastrado (com quantidade), mas o valor unitário de todos está em 0 — o total de materiais fica em R$ 0,00 e nenhum alerta de '% de materiais sobre o custo' pode disparar pra elas."
            total={dados.materiaisZerados.total}
          >
            <table className="data-table">
              <tbody>
                {dados.materiaisZerados.produtos.map((p) => (
                  <tr key={`produto-${p.id}`}>
                    <td className="mono">{p.referencia}</td>
                    <td>{p.descricao || '—'}</td>
                    <td><span className="stamp sm tone-atencao">{formatQtd(p.itensComQuantidade)} material(is) sem valor</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <Link to={`/produtos/${p.id}`} className="icon-btn"><ChevronRight size={16} /></Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GrupoAchado>

          <GrupoAchado
            titulo="Empresas sem imposto configurado"
            descricao="O cálculo de % de impostos (o mesmo usado na Ficha de Custo e na formação de preço) resulta em 0% — sinal de que ninguém preencheu regime, alíquotas ou a alíquota média ainda."
            total={dados.empresasSemImpostos.total}
          >
            <table className="data-table">
              <tbody>
                {dados.empresasSemImpostos.empresas.map((e) => (
                  <tr key={`empresa-${e.id}`}>
                    <td style={{ fontWeight: 600 }}>{e.nome}</td>
                    <td><span className="stamp sm tone-atencao">{e.regimeTributario}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <Link to="/empresas" className="icon-btn"><ChevronRight size={16} /></Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GrupoAchado>

          {dados.pedidosValorNaoConfirmado.total > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">Pedidos de marketplace com valor ainda não confirmado</div>
              <p className="page-sub" style={{ margin: '0 0 4px' }}>
                O pagamento ainda não foi liberado pela plataforma — o valor recebido usado nos
                cálculos de lucratividade pode mudar quando isso acontecer.
              </p>
              <div className="stamp-row" style={{ marginTop: 8 }}>
                <span className="stamp tone-atencao">
                  {formatQtd(dados.pedidosValorNaoConfirmado.total)} de {formatQtd(dados.pedidosValorNaoConfirmado.totalMarketplace)} pedidos de marketplace
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
