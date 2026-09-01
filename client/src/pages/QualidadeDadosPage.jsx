import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ChevronRight, Layers } from 'lucide-react';
import { api } from '../api/client';
import { formatQtd, pct } from '../lib/format';
import { Skeleton } from '../components/ui';

function Resumo({ label, valor, tom }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10.5, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div className={'mono' + (tom ? ' ' + tom : '')} style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{valor}</div>
    </div>
  );
}

function ListaRefs({ produtos, limite = 30 }) {
  const excedente = produtos.length - limite;
  return (
    <table className="data-table">
      <tbody>
        {produtos.slice(0, limite).map((p) => (
          <tr key={p.id}>
            <td className="mono">{p.referencia}</td>
            <td>{p.descricao || '—'}</td>
            <td style={{ textAlign: 'right' }}>
              <Link to={`/produtos/${p.id}`} className="icon-btn"><ChevronRight size={16} /></Link>
            </td>
          </tr>
        ))}
        {excedente > 0 && (
          <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12.5 }}>e mais {formatQtd(excedente)} referência(s)…</td></tr>
        )}
      </tbody>
    </table>
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
    <div>
      <div className="card-head" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Layers size={16} />Qualidade do Dado</div>
      <p className="page-sub">
        Antes de confiar em qualquer painel agregado (Dashboard Executivo, Indicadores de Estoque,
        Central de Alertas), vale saber o quanto do dado por trás dele está completo. Isto é um
        raio-x, não um alarme — não corrige nada sozinho.
      </p>

      {erro && <div className="login-error" style={{ marginTop: 12 }}>{erro}</div>}

      {loading && (
        <div className="card" style={{ marginTop: 16 }}>
          <Skeleton width="40%" height={16} style={{ marginBottom: 10 }} />
          <Skeleton width="70%" style={{ marginBottom: 8 }} />
          <Skeleton width="55%" />
        </div>
      )}

      {!loading && dados && (
        <div style={{ marginTop: 16 }}>
          <div className="card-head" style={{ marginBottom: 8 }}>A — Referências / produtos</div>
          <div className="grid-4" style={{ marginBottom: 16 }}>
            <Resumo label="Total de referências" valor={formatQtd(dados.produtos.totalReferencias)} />
            <Resumo label="Com custo de material > 0" valor={formatQtd(dados.produtos.comCustoMaterialPositivo)} />
            <Resumo label="Material cadastrado sem valor" valor={formatQtd(dados.produtos.materiaisZerados.total)} tom={dados.produtos.materiaisZerados.total > 0 ? 'tone-atencao' : ''} />
            <Resumo label="Preço sugerido = 0" valor={formatQtd(dados.produtos.precoSugeridoZero.total)} tom={dados.produtos.precoSugeridoZero.total > 0 ? 'tone-atencao' : ''} />
            <Resumo label="Sem empresa associada" valor={formatQtd(dados.produtos.semEmpresa)} tom={dados.produtos.semEmpresa > 0 ? 'tone-atencao' : ''} />
            <Resumo label="Sem categoria" valor={formatQtd(dados.produtos.semCategoria)} />
            <Resumo label="Sem marca" valor={formatQtd(dados.produtos.semMarca)} />
            <Resumo label="Sem linha" valor={formatQtd(dados.produtos.semLinha)} />
          </div>

          {dados.produtos.materiaisZerados.total > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">Material cadastrado com valor unitário zerado ({formatQtd(dados.produtos.materiaisZerados.total)})</div>
              <p className="page-sub" style={{ margin: '0 0 12px' }}>
                Têm material cadastrado (com quantidade), mas o valor unitário de todos está em 0 —
                nenhum alerta de "% de materiais sobre o custo" pode disparar pra elas.
              </p>
              <ListaRefs produtos={dados.produtos.materiaisZerados.produtos} />
            </div>
          )}

          {dados.produtos.precoSugeridoZero.total > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">Preço sugerido = 0 ({formatQtd(dados.produtos.precoSugeridoZero.total)})</div>
              <p className="page-sub" style={{ margin: '0 0 12px' }}>
                A formação de preço não teve dado suficiente pra chegar a um valor — faltam materiais,
                custo industrial ou outro insumo do cálculo.
              </p>
              <ListaRefs produtos={dados.produtos.precoSugeridoZero.produtos} />
            </div>
          )}

          {dados.empresasSemImpostos.total > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">Empresas sem imposto configurado ({formatQtd(dados.empresasSemImpostos.total)})</div>
              <p className="page-sub" style={{ margin: '0 0 12px' }}>
                O cálculo de % de impostos (o mesmo usado na Ficha de Custo e na formação de preço)
                resulta em 0% — sinal de que ninguém preencheu regime, alíquotas ou alíquota média.
              </p>
              <table className="data-table">
                <tbody>
                  {dados.empresasSemImpostos.empresas.map((e) => (
                    <tr key={e.id}>
                      <td style={{ fontWeight: 600 }}>{e.nome}</td>
                      <td><span className="stamp sm tone-atencao">{e.regimeTributario}</span></td>
                      <td style={{ textAlign: 'right' }}><Link to="/empresas" className="icon-btn"><ChevronRight size={16} /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card-head" style={{ marginBottom: 8, marginTop: 8 }}>B — Pedidos de marketplace</div>
          <div className="grid-3" style={{ marginBottom: 16 }}>
            <Resumo label="Confirmados" valor={formatQtd(dados.marketplace.confirmados)} />
            <Resumo label="Estimados (não liberados)" valor={formatQtd(dados.marketplace.estimados)} tom={dados.marketplace.estimados > 0 ? 'tone-atencao' : ''} />
            <Resumo label="Itens sem produto vinculado" valor={formatQtd(dados.marketplace.itensSemProdutoVinculado)} tom={dados.marketplace.itensSemProdutoVinculado > 0 ? 'tone-atencao' : ''} />
          </div>
          {dados.marketplace.total > 0 && (
            <p className="page-sub" style={{ marginTop: -8, marginBottom: 16 }}>
              {pct(dados.marketplace.estimados / dados.marketplace.total)} do total de {formatQtd(dados.marketplace.total)} pedidos de marketplace ainda não teve o valor liberado confirmado pela plataforma.
            </p>
          )}

          <div className="card-head" style={{ marginBottom: 8, marginTop: 8 }}>C — Estoque</div>
          <div className="grid-4" style={{ marginBottom: 8 }}>
            <Resumo label="Variantes ativas" valor={formatQtd(dados.estoque.totalVariantes)} />
            <Resumo label="Com EAN" valor={formatQtd(dados.estoque.comEan)} />
            <Resumo label="Com saldo" valor={formatQtd(dados.estoque.comSaldo)} />
            <Resumo label="Zeradas" valor={formatQtd(dados.estoque.zeradas)} />
          </div>

          {dados.total === 0 && (
            <div className="card" style={{ marginTop: 16, textAlign: 'center', padding: '32px 16px' }}>
              <ShieldCheck size={28} style={{ color: 'var(--success)' }} />
              <p style={{ marginTop: 10, color: 'var(--ink-soft)' }}>Nenhuma lacuna de dado encontrada nos critérios acompanhados.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
