import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, PackageX, PackageCheck, Wallet, Tag, ChevronRight, Info } from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, pct, numeroBr } from '../lib/format';
import { StatCard, Skeleton } from './ui';
import SeloDeConfianca from './SeloDeConfianca';
import ErroIntegracao from './ErroIntegracao';

const CLASSE_TONE = { A: 'tone-saudavel', B: 'tone-elevada', C: 'tone-neutro' };

// 25/09/2026 (revisão visual): a busca e a lista do estoque ficavam no FIM
// da página, depois de dezenas de linhas de análise. Agora a página passa o
// seu miolo (busca + referência) como `children`, e ele entra logo depois dos
// indicadores do topo — a análise (rupturas, cobertura, curva ABC) desce para
// baixo, recolhível.
export default function IndicadoresEstoque({ children }) {
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);

  const [erro, setErro] = useState('');

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get('/estoque/indicadores')
      .then(setDados)
      // Sem catch, uma falha deixava `dados` nulo e o componente devolvia
      // null: a tela de Estoque simplesmente NÃO tinha indicadores, sem
      // esqueleto, sem erro e sem pista nenhuma de que faltava algo.
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <>
        <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 16 }}>
          {Array.from({ length: 6 }, (_, k) => (
            <div key={k} className="stat-card"><div className="stat-card-corpo"><Skeleton width="60%" height={11} /><Skeleton width="70%" height={22} style={{ marginTop: 8 }} /></div></div>
          ))}
        </div>
        {children}
      </>
    );
  }
  if (erro) {
    return (
      <>
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="login-error" style={{ margin: 0 }}>
            Não consegui carregar os indicadores de estoque. <ErroIntegracao erro={erro} sistema="auto" />
          </p>
        </div>
        {children}
      </>
    );
  }
  if (!dados) return <>{children}</>;
  const maxCobertura = Math.max(1, ...dados.cobertura.slice(0, 20).map((c) => Number(c.coberturaDias) || 0));
  const maxAbc = Math.max(0.0001, ...dados.curvaAbc.slice(0, 30).map((c) => Number(c.participacaoPct) || 0));

  const { indicadores: i } = dados;
  const considerado = dados.totalVariantesAtivas - i.variantesSemCustoComSaldo;

  return (
    <>
      {/* `repeat(6, 1fr)` fixo espremia os seis cartões em ~200px cada num
          notebook de 1366px, e o valor em R$ quebrava em duas linhas. Com
          auto-fit eles quebram para duas fileiras quando não cabem. */}
      <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 16 }}>
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

      {children}

      <details className="secao-recolhivel" open={dados.rupturas.length > 0}>
        <summary>
          <span className="secao-recolhivel-titulo">Análise do estoque</span>
          <span className="secao-recolhivel-resumo">
            {dados.rupturas.length > 0
              ? <span className="stamp sm tone-prejuizo">{formatQtd(dados.rupturas.length)} em ruptura</span>
              : <span className="stamp sm tone-saudavel">sem ruptura</span>}
            {' '}Cobertura em dias e curva ABC
          </span>
        </summary>
      {/* Card de ruptura vazio ocupava meia tela: sem item, vira uma linha. */}
      <div className={dados.rupturas.length > 0 ? 'grid-2' : undefined} style={{ marginBottom: 16 }}>
        {dados.rupturas.length > 0 && (
        <div className="card">
          <div className="card-head">Rupturas — saldo zero com venda nos últimos 30 dias</div>
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
        )}

        <div className="card">
          <div className="card-head">Cobertura em Dias</div>
          <p className="page-sub" style={{ margin: '0 0 8px', fontSize: 12 }}>
            Saldo atual ÷ média diária de venda dos últimos 30 dias. Sem venda no período, mostra "—" — não é possível estimar cobertura sem dado.
          </p>
          <table className="data-table">
            <thead><tr><th>Referência</th><th className="num">Saldo</th><th className="num">Vendido 30d</th><th>Cobertura</th></tr></thead>
            <tbody>
              {dados.cobertura.slice(0, 20).map((c) => (
                <tr key={c.produtoId}>
                  <td className="mono"><Link to={`/produtos/${c.produtoId}`} style={{ color: 'inherit' }}>{c.referencia}</Link></td>
                  <td className="num">{formatQtd(c.saldo)}</td>
                  <td className="num">{formatQtd(c.vendido30d)}</td>
                  <td>
                    {c.coberturaDias === null ? '—' : (
                      <span className={`celula-com-barra${c.coberturaDias < 15 ? ' curta' : ''}`}>
                        <span className="barra-celula" aria-hidden="true"><span style={{ width: `${Math.max(3, Math.min(100, (Number(c.coberturaDias) / maxCobertura) * 100))}%` }} /></span>
                        <span className="celula-com-barra-valor">{numeroBr(c.coberturaDias, 0)} dias</span>
                      </span>
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
            <thead><tr><th>Classe</th><th>Referência</th><th className="num">Valor</th><th>Participação</th><th className="num">Acumulado</th></tr></thead>
            <tbody>
              {/* A classe deixou de ser um selo "A" repetido em trinta linhas:
                  vira a faixa colorida da linha, e o selo só aparece na
                  primeira linha de cada classe. */}
              {dados.curvaAbc.slice(0, 30).map((c, idx, lista) => (
                <tr key={c.produtoId} className={`abc-linha abc-${String(c.classe).toLowerCase()}`}>
                  <td>{(idx === 0 || lista[idx - 1].classe !== c.classe) ? <span className={'stamp sm ' + CLASSE_TONE[c.classe]}>Classe {c.classe}</span> : null}</td>
                  <td className="mono"><Link to={`/produtos/${c.produtoId}`} style={{ color: 'inherit' }}>{c.referencia}</Link></td>
                  <td className="num">{brl(c.valor)}</td>
                  <td>
                    <span className="celula-com-barra">
                      <span className="barra-celula" aria-hidden="true"><span style={{ width: `${Math.max(2, (Number(c.participacaoPct) / maxAbc) * 100)}%` }} /></span>
                      <span className="celula-com-barra-valor">{pct(c.participacaoPct)}</span>
                    </span>
                  </td>
                  <td className="num">{pct(c.pctAcumulado)}</td>
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
      </details>
    </>
  );
}
