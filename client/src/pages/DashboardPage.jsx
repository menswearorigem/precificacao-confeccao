import { useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, History } from 'lucide-react';
import { Field, Select, EstadoVazio, lerRecentes } from '../components/ui';
import { api } from '../api/client';
import { brl, pct, numeroBr } from '../lib/format';
import { statusToneClass } from '../lib/statusTone';

const DONUT_CORES = {
  materiais: '#6b4423',
  industrial: '#b5651d',
  indireto: '#c9a876',
  impostos: '#a93f2b',
  taxas: '#3e6e90',
  lucro: '#5b7553',
};

function Donut({ fatias }) {
  const total = fatias.reduce((s, f) => s + Math.max(f.valor, 0), 0);
  let acc = 0;
  const stops = fatias.map((f) => {
    const valor = Math.max(f.valor, 0);
    const start = total === 0 ? 0 : (acc / total) * 360;
    acc += valor;
    const end = total === 0 ? 0 : (acc / total) * 360;
    return `${f.cor} ${start}deg ${end}deg`;
  });
  const gradient = total === 0 ? '#eae1cc 0deg 360deg' : stops.join(', ');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      <div
        style={{
          width: 160,
          height: 160,
          borderRadius: '50%',
          background: `conic-gradient(${gradient})`,
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <div style={{
          position: 'absolute', inset: 22, borderRadius: '50%', background: 'var(--surface)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
        }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>preço</span>
          <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{brl(total)}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {fatias.map((f) => (
          <div key={f.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: f.cor, display: 'inline-block' }} />
            <span style={{ minWidth: 90 }}>{f.label}</span>
            <span className="mono" style={{ color: 'var(--ink-soft)' }}>
              {brl(f.valor)} · {pct(total === 0 ? 0 : f.valor / total)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FaixaPreco({ minimo, ideal, premium, ativo }) {
  const lo = minimo;
  const hi = Math.max(premium, ativo, ideal) * 1.05;
  const posOf = (v) => (hi === lo ? 0 : Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)));

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ position: 'relative', height: 10, borderRadius: 6, background: 'var(--border-soft)', marginBottom: 8 }}>
        <div
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${posOf(ativo)}%`, background: 'var(--terracotta)', borderRadius: 6,
          }}
        />
        {[
          { v: minimo, label: 'Mínimo' },
          { v: ideal, label: 'Ideal' },
          { v: premium, label: 'Premium' },
        ].map((marca) => (
          <div
            key={marca.label}
            title={`${marca.label}: ${brl(marca.v)}`}
            style={{
              position: 'absolute', left: `${posOf(marca.v)}%`, top: -3, width: 2, height: 16,
              background: 'var(--leather-dark)', transform: 'translateX(-1px)',
            }}
          />
        ))}
        <div
          title={`Preço ativo: ${brl(ativo)}`}
          style={{
            position: 'absolute', left: `${posOf(ativo)}%`, top: -5, width: 12, height: 12,
            borderRadius: '50%', background: 'var(--terracotta)', border: '2px solid var(--surface)',
            boxShadow: '0 0 0 1px var(--leather-dark)', transform: 'translateX(-6px)',
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-soft)' }}>
        <span>Mínimo <span className="mono">{brl(minimo)}</span></span>
        <span>Ideal <span className="mono">{brl(ideal)}</span></span>
        <span>Premium <span className="mono">{brl(premium)}</span></span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [produtos, setProdutos] = useState([]);
  const [produtoId, setProdutoId] = useState('');
  const [detalhe, setDetalhe] = useState(null);

  useEffect(() => {
    api.get('/produtos').then(setProdutos);
  }, []);

  useEffect(() => {
    if (!produtoId) { setDetalhe(null); return; }
    api.get(`/produtos/${produtoId}`).then(setDetalhe);
  }, [produtoId]);

  const c = detalhe?.calculo;

  // Atalho pras últimas referências consultadas — mesma lista de "recentes"
  // que o Select já guarda em localStorage, só filtrada pro que ainda existe
  // no cadastro atual (produto pode ter sido excluído nesse meio-tempo).
  const recentes = useMemo(() => {
    if (produtos.length === 0) return [];
    return lerRecentes('dashboard_produto')
      .map((id) => produtos.find((p) => String(p.id) === String(id)))
      .filter(Boolean);
  }, [produtos]);

  return (
    <div className="page-wide">
      <h2>Dashboard Executivo</h2>
      <p className="page-sub">Painel resumo de precificação de uma referência.</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <Field label="Referência">
          <Select value={produtoId} onChange={(e) => setProdutoId(e.target.value)} chaveRecentes="dashboard_produto">
            <option value="">Selecione uma referência…</option>
            {produtos.map((p) => (
              <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>
            ))}
          </Select>
        </Field>
      </div>

      {c && (
        <>
          <div className="stamp-row">
            <div className={'stamp ' + statusToneClass(c.formacaoPreco.status)}>{c.formacaoPreco.status}</div>
            <div style={{ display: 'flex', gap: 28 }}>
              <KpiMini label="Preço sugerido" value={brl(c.formacaoPreco.precoSugerido)} />
              <KpiMini label="Lucro" value={`${brl(c.formacaoPreco.lucroRS)} · ${pct(c.formacaoPreco.lucroPct)}`} />
              <KpiMini label="Markup" value={`${numeroBr(c.formacaoPreco.markupMult)}x`} />
            </div>
          </div>

          <div className="grid-2" style={{ marginBottom: 16 }}>
            <KpiCard label="% Custo Materiais" value={pct(c.custoTotal.pctMateriais)} />
            <KpiCard label="% Mão de Obra Industrial" value={pct(c.custoTotal.pctIndustrial)} />
            <KpiCard label="% Despesas Indiretas" value={pct(c.custoTotal.pctIndireto)} />
            <KpiCard label="% Impostos" value={pct(c.custoTotal.pctImpostosDoCusto)} />
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-head">Composição do Preço de Venda</div>
              <Donut
                fatias={[
                  { label: 'Materiais', valor: c.custoTotal.totalMateriais, cor: DONUT_CORES.materiais },
                  { label: 'Industrial', valor: c.custoTotal.totalIndustrial, cor: DONUT_CORES.industrial },
                  { label: 'Indireto', valor: c.custoTotal.custoIndireto, cor: DONUT_CORES.indireto },
                  { label: 'Impostos', valor: c.custoTotal.impostosRS, cor: DONUT_CORES.impostos },
                  { label: 'Taxas', valor: c.custoTotal.taxasRS, cor: DONUT_CORES.taxas },
                  { label: 'Lucro', valor: c.formacaoPreco.lucroRS, cor: DONUT_CORES.lucro },
                ]}
              />
            </div>
            <div className="card">
              <div className="card-head">Onde o preço está</div>
              <FaixaPreco
                minimo={c.formacaoPreco.precoMinimo}
                ideal={c.formacaoPreco.precoIdeal}
                premium={c.formacaoPreco.precoPremium}
                ativo={c.formacaoPreco.precoAtivo}
              />
              <p className="page-sub" style={{ marginTop: 14 }}>
                Preço {detalhe.produto.preco_informado ? 'praticado' : 'sugerido'} atual: <strong className="mono">{brl(c.formacaoPreco.precoAtivo)}</strong>
              </p>
            </div>
          </div>
        </>
      )}

      {!c && (
        <div className="card">
          <EstadoVazio
            Icone={LayoutDashboard}
            titulo="Selecione uma referência acima"
            descricao="O painel mostra a composição do preço de venda (materiais, industrial, indireto, impostos, taxas e lucro), a faixa entre preço mínimo/ideal/premium e os indicadores de custo da referência escolhida."
          />
          {recentes.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 4, paddingTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ink-soft)', marginBottom: 10, justifyContent: 'center' }}>
                <History size={13} /> Últimas consultadas
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                {recentes.map((p) => (
                  <button key={p.id} type="button" className="btn btn-ghost sm" onClick={() => setProdutoId(String(p.id))}>
                    <span className="mono">{p.referencia}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KpiMini({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <span style={{ fontSize: 10.5, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--leather-dark)' }}>{value}</span>
    </div>
  );
}

function KpiCard({ label, value }) {
  return (
    <div className="card" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10.5, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: 'var(--leather-dark)', marginTop: 4 }}>{value}</div>
    </div>
  );
}
