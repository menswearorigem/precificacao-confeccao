import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, PackageX, PackageCheck, Wallet, Tag, ChevronRight, Info } from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, pct, numeroBr } from '../lib/format';
import { StatCard, Skeleton } from './ui';
import SeloDeConfianca from './SeloDeConfianca';

const CLASSE_TONE = { A: 'tone-saudavel', B: 'tone-atencao', C: 'tone-neutro' };

export default function IndicadoresEstoque() {
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get('/estoque/indicadores').then(setDados).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <Skeleton width="60%" height={16} style={{ marginBottom: 10 }} />
        <Skeleton width="80%" />
      </div>
    );
  }
  if (!dados) return null;

  const { indicadores: i } = dados;
  const considerado = dados.totalVariantesAtivas - i.variantesSemCustoComSaldo;

  return (
    <>
      <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(6, 1fr)', marginBottom: 16 }}>
        <StatCard label={<><Boxes size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Peças em estoque</>} value={formatQtd(i.pecasEmEstoque)} />
        <StatCard label={<><PackageCheck size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Variantes ativas</>} value={formatQtd(i.variantesComSaldo)} />
        <StatCard label={<><PackageX size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Variantes zeradas</>} value={formatQtd(i.variantesZeradas)} />
        <StatCard
          label={<><Wallet size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Valor em estoque (a custo atual)</>}
          value={brl(i.valorCusto)}
        >
          <span className="stat-card-delta" title="Custo atual da ficha de cada referência — não é custo histórico nem custo médio. Não há registro do custo no momento em que cada peça entrou no estoque.">
            <Info size={11} /> a custo atual
          </span>
        </StatCard>
        <StatCard label={<><Wallet size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Valor em estoque (preço sugerido)</>} value={brl(i.valorPrecoSugerido)} />
        <StatCard label={<><Tag size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Variantes sem EAN</>} value={formatQtd(i.variantesSemEan)} />
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">Rupturas — saldo zero com venda nos últimos 30 dias</div>
          {dados.rupturas.length === 0 && <p className="page-sub">Nenhuma variante nessa condição agora.</p>}
          {dados.rupturas.length > 0 && (
            <table className="data-table">
              <thead><tr><th>Referência</th><th>Cor / Tam.</th><th>Vendido em 30d</th><th /></tr></thead>
              <tbody>
                {dados.rupturas.slice(0, 20).map((r) => (
                  <tr key={r.varianteId}>
                    <td className="mono">{r.referencia}</td>
                    <td>{[r.cor, r.tamanho].filter(Boolean).join(' / ') || '—'}</td>
                    <td className="mono">{formatQtd(r.vendidoUltimos30d)}</td>
                    <td style={{ textAlign: 'right' }}><Link to={`/produtos/${r.produtoId}`} className="icon-btn"><ChevronRight size={16} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-head">Cobertura em Dias</div>
          <p className="page-sub" style={{ margin: '0 0 8px', fontSize: 12 }}>
            Saldo atual ÷ média diária de venda dos últimos 30 dias. Sem venda no período, mostra "—" — não é possível estimar cobertura sem dado.
          </p>
          <table className="data-table">
            <thead><tr><th>Referência</th><th>Saldo</th><th>Vendido 30d</th><th>Cobertura</th></tr></thead>
            <tbody>
              {dados.cobertura.slice(0, 20).map((c) => (
                <tr key={c.produtoId}>
                  <td className="mono"><Link to={`/produtos/${c.produtoId}`} style={{ color: 'inherit' }}>{c.referencia}</Link></td>
                  <td className="mono">{formatQtd(c.saldo)}</td>
                  <td className="mono">{formatQtd(c.vendido30d)}</td>
                  <td className="mono">
                    {c.coberturaDias === null ? '—' : (
                      <span className={c.coberturaDias < 15 ? 'stamp sm tone-atencao' : ''}>{numeroBr(c.coberturaDias, 0)} dias</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Curva ABC — valor em estoque (a custo atual)</div>
        {dados.curvaAbc.length === 0 && <p className="page-sub">Sem referências com custo cadastrado pra classificar.</p>}
        {dados.curvaAbc.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Referência</th><th>Valor</th><th>Participação</th><th>Acumulado</th><th>Classe</th></tr></thead>
            <tbody>
              {dados.curvaAbc.slice(0, 30).map((c) => (
                <tr key={c.produtoId}>
                  <td className="mono"><Link to={`/produtos/${c.produtoId}`} style={{ color: 'inherit' }}>{c.referencia}</Link></td>
                  <td className="mono">{brl(c.valor)}</td>
                  <td className="mono">{pct(c.participacaoPct)}</td>
                  <td className="mono">{pct(c.pctAcumulado)}</td>
                  <td><span className={'stamp sm ' + CLASSE_TONE[c.classe]}>{c.classe}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {dados.vendasNaoConciliadas > 0 && (
        <p className="page-sub" style={{ marginBottom: 8 }}>
          {formatQtd(dados.vendasNaoConciliadas)} unidade(s) vendida(s) nos últimos 30 dias não conciliadas com nenhuma variante de estoque (item de pedido sem vínculo exato).
        </p>
      )}

      <SeloDeConfianca
        considerado={considerado}
        total={dados.totalVariantesAtivas}
        unidade="variantes ativas"
        excluidos={[{ label: 'sem custo cadastrado (fora do valor em estoque)', total: i.variantesSemCustoComSaldo }]}
      />
    </>
  );
}
