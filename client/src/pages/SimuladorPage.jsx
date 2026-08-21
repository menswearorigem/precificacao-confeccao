import { useEffect, useRef, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Row, Select } from '../components/ui';
import { brl, pct } from '../lib/format';
import { statusToneClass } from '../lib/statusTone';

const AJUSTES_INICIAIS = {
  materiaisPct: 0,
  industrialPct: 0,
  indiretoPct: 0,
  freteExtra: 0,
  impostosPontos: 0,
  taxasPontos: 0,
  novaMargem: '',
};

export default function SimuladorPage() {
  const [produtos, setProdutos] = useState([]);
  const [produtoId, setProdutoId] = useState('');
  const [ajustes, setAjustes] = useState(AJUSTES_INICIAIS);
  const [resultado, setResultado] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    api.get('/produtos').then(setProdutos);
  }, []);

  function rodarSimulacao(id, novosAjustes) {
    if (!id) {
      setResultado(null);
      return;
    }
    const body = {
      produtoId: id,
      ajustes: {
        ...novosAjustes,
        novaMargem: novosAjustes.novaMargem === '' ? null : Number(novosAjustes.novaMargem) / 100,
        materiaisPct: Number(novosAjustes.materiaisPct) / 100,
        industrialPct: Number(novosAjustes.industrialPct) / 100,
        indiretoPct: Number(novosAjustes.indiretoPct) / 100,
        impostosPontos: Number(novosAjustes.impostosPontos) / 100,
        taxasPontos: Number(novosAjustes.taxasPontos) / 100,
        freteExtra: Number(novosAjustes.freteExtra) || 0,
      },
    };
    api.post('/simulacao', body).then(setResultado);
  }

  function handleProdutoChange(id) {
    setProdutoId(id);
    setAjustes(AJUSTES_INICIAIS);
    rodarSimulacao(id, AJUSTES_INICIAIS);
  }

  function updateAjuste(patch) {
    const next = { ...ajustes, ...patch };
    setAjustes(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => rodarSimulacao(produtoId, next), 350);
  }

  return (
    <div className="page-wide">
      <h2>Simulador de Cenários</h2>
      <p className="page-sub">
        Teste ajustes hipotéticos de custo, frete e impostos sem alterar os dados reais do produto.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <Field label="Referência a simular">
          <Select value={produtoId} onChange={(e) => handleProdutoChange(e.target.value)} chaveRecentes="simulador_produto">
            <option value="">Selecione uma referência…</option>
            {produtos.map((p) => (
              <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>
            ))}
          </Select>
        </Field>
      </div>

      {resultado && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">Valores base (da referência selecionada)</div>
            <Row label="Custo materiais (base)" value={brl(resultado.valoresBase.totalMateriais)} />
            <Row label="Custo industrial / facção (base)" value={brl(resultado.valoresBase.totalIndustrial)} />
            <Row label="Custo indireto / energia (base)" value={brl(resultado.valoresBase.custoIndireto)} />
            <Row label="% impostos (base)" value={pct(resultado.valoresBase.pctImpostos)} />
            <Row label="% taxas / comissão (base)" value={pct(resultado.valoresBase.pctTaxas)} />
            <Row label="Margem desejada (base)" value={pct(resultado.valoresBase.margemDesejada)} />
            <Row label="Preço sugerido (base)" value={brl(resultado.valoresBase.precoSugerido)} strong />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><FlaskConical size={14} /> Ajustes do cenário</div>
            <div className="form-grid">
              <Field label="Ajuste no preço do tecido/materiais">
                <NumInput value={ajustes.materiaisPct} onChange={(v) => updateAjuste({ materiaisPct: v })} suffix="%" />
              </Field>
              <Field label="Ajuste no custo da facção/industrial">
                <NumInput value={ajustes.industrialPct} onChange={(v) => updateAjuste({ industrialPct: v })} suffix="%" />
              </Field>
              <Field label="Ajuste na energia/rateio indireto">
                <NumInput value={ajustes.indiretoPct} onChange={(v) => updateAjuste({ indiretoPct: v })} suffix="%" />
              </Field>
              <Field label="Frete extra não previsto">
                <NumInput value={ajustes.freteExtra} onChange={(v) => updateAjuste({ freteExtra: v })} suffix="R$" />
              </Field>
              <Field label="Ajuste nos impostos" hint="pontos percentuais somados à % de impostos base">
                <NumInput value={ajustes.impostosPontos} onChange={(v) => updateAjuste({ impostosPontos: v })} suffix="p.p." />
              </Field>
              <Field label="Ajuste na comissão/taxas" hint="pontos percentuais somados à % de taxas base">
                <NumInput value={ajustes.taxasPontos} onChange={(v) => updateAjuste({ taxasPontos: v })} suffix="p.p." />
              </Field>
              <Field label="Nova margem desejada" hint="deixe em branco para manter a margem base">
                <NumInput value={ajustes.novaMargem} onChange={(v) => updateAjuste({ novaMargem: v })} suffix="%" />
              </Field>
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-head">Cenário atual</div>
              <span className={'stamp sm ' + statusToneClass(resultado.atual.status)}>{resultado.atual.status}</span>
              <div style={{ marginTop: 10 }}>
                <Row label="Subtotal de produção" value={brl(resultado.atual.subtotalProducao)} />
                <Row label="Custo total" value={brl(resultado.atual.custoTotalPeca)} />
                <Row label="Preço sugerido" value={brl(resultado.atual.precoSugerido)} strong />
                <Row label="Lucro" value={`${brl(resultado.atual.lucroRS)} · ${pct(resultado.atual.lucroPct)}`} />
              </div>
            </div>
            <div className="card">
              <div className="card-head">Cenário simulado</div>
              <span className={'stamp sm ' + statusToneClass(resultado.simulado.status)}>{resultado.simulado.status}</span>
              <div style={{ marginTop: 10 }}>
                <Row label="Subtotal de produção" value={brl(resultado.simulado.subtotalProducao)} />
                <Row label="Custo total" value={brl(resultado.simulado.custoTotalPeca)} />
                <Row label="Preço sugerido" value={brl(resultado.simulado.precoSugerido)} strong />
                <Row label="Lucro" value={`${brl(resultado.simulado.lucroRS)} · ${pct(resultado.simulado.lucroPct)}`} />
              </div>
            </div>
          </div>

          <div className="total-banner" style={{ marginTop: 16 }}>
            Diferença vs. preço sugerido base
            <span className="mono">{brl(resultado.simulado.diferencaRS)} ({pct(resultado.simulado.diferencaPct)})</span>
          </div>
        </>
      )}
    </div>
  );
}
