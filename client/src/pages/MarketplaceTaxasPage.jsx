import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Search } from 'lucide-react';
import { api } from '../api/client';
import { NumInput, Select } from '../components/ui';
import BarraAlteracoes from '../components/BarraAlteracoes';
import { brl } from '../lib/format';
import logoMercadoLivre from '../assets/logos/mercado-livre.svg';
import logoShopee from '../assets/logos/shopee.svg';

const MARKETPLACES = [
  { key: 'mercado_livre', label: 'Mercado Livre', logo: logoMercadoLivre },
  { key: 'shopee', label: 'Shopee', logo: logoShopee },
];

const LINHAS_INICIAIS = 8;

// percentual guardado como fração (ex: 0.14) vira "14" na tela — arredonda
// pra não mostrar ruído de ponto flutuante (0.14 * 100 = 14.000000000000002).
function paraPct(fracao) {
  return Math.round(Number(fracao) * 1000000) / 10000;
}

function faixaLegivel(min, max) {
  const de = brl(Number(min) || 0);
  const ateTxt = min === undefined || min === null ? '' : ' até';
  if (max === null || max === undefined || max === '') return `${de}${ateTxt} sem teto`;
  return `${de}${ateTxt} ${brl(Number(max))}`;
}

function dentroDaFaixa(valor, min, max) {
  const v = Number(valor) || 0;
  return v >= Number(min) && (max === null || max === undefined || v <= Number(max));
}

function comissaoAplicavel(faixas, valorAnuncio, tipoAnuncio) {
  return faixas.find((f) => (
    (!f.tipo_anuncio || f.tipo_anuncio === tipoAnuncio) && dentroDaFaixa(valorAnuncio, f.valor_min, f.valor_max)
  ));
}

function freteAplicavel(faixas, peso, valorAnuncio) {
  return faixas.find((f) => (
    dentroDaFaixa(peso, f.peso_min_kg, f.peso_max_kg) && dentroDaFaixa(valorAnuncio, f.valor_min, f.valor_max)
  ));
}

// Monta a grade peso × faixa de valor do pedido a partir das faixas
// planas do banco (cada linha do banco já é um cruzamento peso×valor —
// isto só reorganiza pra matriz, sem inventar nenhum dado).
function construirGradeFrete(faixas) {
  const chavePeso = (f) => `${f.peso_min_kg}|${f.peso_max_kg}`;
  const chaveValor = (f) => `${f.valor_min}|${f.valor_max}`;
  const pesos = [...new Map(faixas.map((f) => [chavePeso(f), { min: f.peso_min_kg, max: f.peso_max_kg }])).values()]
    .sort((a, b) => Number(a.min) - Number(b.min));
  const valores = [...new Map(faixas.map((f) => [chaveValor(f), { min: f.valor_min, max: f.valor_max }])).values()]
    .sort((a, b) => Number(a.min) - Number(b.min));
  const porChave = new Map(faixas.map((f) => [`${chavePeso(f)}||${chaveValor(f)}`, f]));
  return { pesos, valores, porChave };
}

function normalizarNum(v) {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export default function MarketplaceTaxasPage() {
  const [marketplace, setMarketplace] = useState('mercado_livre');
  const [servidorComissao, setServidorComissao] = useState([]);
  const [servidorFrete, setServidorFrete] = useState([]);
  const [comissaoFaixas, setComissaoFaixas] = useState([]);
  const [freteFaixas, setFreteFaixas] = useState([]);
  const [buscaPeso, setBuscaPeso] = useState('');
  const [mostrarTodasFaixas, setMostrarTodasFaixas] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [mensagemSalvo, setMensagemSalvo] = useState('');

  const [valorSim, setValorSim] = useState(150);
  const [pesoSim, setPesoSim] = useState(1);
  const [tipoAnuncioSim, setTipoAnuncioSim] = useState('classico');

  function load() {
    api.get('/marketplace-taxas').then((data) => {
      setServidorComissao(data.comissaoFaixas);
      setServidorFrete(data.freteFaixas);
      setComissaoFaixas(data.comissaoFaixas);
      setFreteFaixas(data.freteFaixas);
    });
  }

  useEffect(load, []);

  function atualizarComissao(id, patch) {
    setComissaoFaixas((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function addComissao() {
    const created = await api.post('/marketplace-taxas/comissao', {
      marketplace,
      tipo_anuncio: marketplace === 'mercado_livre' ? 'classico' : null,
      valor_min: 0,
      valor_max: null,
      comissao_pct: 0,
      comissao_fixa: 0,
      subsidio_pix_pct: 0,
      ordem: comissaoFaixas.filter((f) => f.marketplace === marketplace).length + 1,
    });
    setServidorComissao((list) => [...list, created]);
    setComissaoFaixas((list) => [...list, created]);
  }

  async function removeComissao(id) {
    await api.del(`/marketplace-taxas/comissao/${id}`);
    setServidorComissao((list) => list.filter((f) => f.id !== id));
    setComissaoFaixas((list) => list.filter((f) => f.id !== id));
  }

  function atualizarFrete(id, patch) {
    setFreteFaixas((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  async function addFrete() {
    const created = await api.post('/marketplace-taxas/frete', {
      marketplace,
      peso_min_kg: 0,
      peso_max_kg: null,
      valor_min: 0,
      valor_max: null,
      custo_frete: 0,
      ordem: freteFaixas.filter((f) => f.marketplace === marketplace).length + 1,
    });
    setServidorFrete((list) => [...list, created]);
    setFreteFaixas((list) => [...list, created]);
  }

  async function removeFrete(id) {
    await api.del(`/marketplace-taxas/frete/${id}`);
    setServidorFrete((list) => list.filter((f) => f.id !== id));
    setFreteFaixas((list) => list.filter((f) => f.id !== id));
  }

  const camposAlterados = useMemo(() => {
    const nomes = [];
    for (const f of comissaoFaixas) {
      const original = servidorComissao.find((s) => s.id === f.id);
      if (original && JSON.stringify(original) !== JSON.stringify(f)) nomes.push(`Comissão ${faixaLegivel(f.valor_min, f.valor_max)}`);
    }
    for (const f of freteFaixas) {
      const original = servidorFrete.find((s) => s.id === f.id);
      if (original && JSON.stringify(original) !== JSON.stringify(f)) nomes.push(`Frete ${f.peso_min_kg}–${f.peso_max_kg ?? '∞'}kg`);
    }
    return nomes;
  }, [comissaoFaixas, servidorComissao, freteFaixas, servidorFrete]);

  async function salvar() {
    setSalvando(true);
    try {
      const comissaoAlteradas = comissaoFaixas.filter((f) => {
        const original = servidorComissao.find((s) => s.id === f.id);
        return original && JSON.stringify(original) !== JSON.stringify(f);
      });
      const freteAlteradas = freteFaixas.filter((f) => {
        const original = servidorFrete.find((s) => s.id === f.id);
        return original && JSON.stringify(original) !== JSON.stringify(f);
      });
      const [comissaoRes, freteRes] = await Promise.all([
        Promise.all(comissaoAlteradas.map((f) => api.put(`/marketplace-taxas/comissao/${f.id}`, {
          tipo_anuncio: f.tipo_anuncio, valor_min: f.valor_min, valor_max: f.valor_max,
          comissao_pct: f.comissao_pct, comissao_fixa: f.comissao_fixa, subsidio_pix_pct: f.subsidio_pix_pct,
        }))),
        Promise.all(freteAlteradas.map((f) => api.put(`/marketplace-taxas/frete/${f.id}`, {
          peso_min_kg: f.peso_min_kg, peso_max_kg: f.peso_max_kg, valor_min: f.valor_min, valor_max: f.valor_max, custo_frete: f.custo_frete,
        }))),
      ]);
      const comissaoPorId = new Map(comissaoRes.map((r) => [r.id, r]));
      const fretePorId = new Map(freteRes.map((r) => [r.id, r]));
      setServidorComissao((list) => list.map((f) => comissaoPorId.get(f.id) || f));
      setComissaoFaixas((list) => list.map((f) => comissaoPorId.get(f.id) || f));
      setServidorFrete((list) => list.map((f) => fretePorId.get(f.id) || f));
      setFreteFaixas((list) => list.map((f) => fretePorId.get(f.id) || f));
      setMensagemSalvo('Salvo · há instantes');
      setTimeout(() => setMensagemSalvo(''), 3000);
    } finally {
      setSalvando(false);
    }
  }

  function descartar() {
    setComissaoFaixas(servidorComissao);
    setFreteFaixas(servidorFrete);
  }

  const comissaoDoMarketplace = comissaoFaixas.filter((f) => f.marketplace === marketplace);
  const freteDoMarketplace = freteFaixas.filter((f) => f.marketplace === marketplace);

  const comissaoRowSim = comissaoAplicavel(comissaoDoMarketplace, valorSim, marketplace === 'mercado_livre' ? tipoAnuncioSim : null);
  const comissaoValorSim = comissaoRowSim
    ? (Number(valorSim) || 0) * Number(comissaoRowSim.comissao_pct) + Number(comissaoRowSim.comissao_fixa) - (Number(valorSim) || 0) * Number(comissaoRowSim.subsidio_pix_pct || 0)
    : 0;
  const freteRowSim = freteAplicavel(freteDoMarketplace, pesoSim, valorSim);
  const freteValorSim = freteRowSim ? Number(freteRowSim.custo_frete) : 0;
  const totalTaxasSim = comissaoValorSim + freteValorSim;
  const sobraSim = (Number(valorSim) || 0) - totalTaxasSim;

  const grade = useMemo(() => construirGradeFrete(freteDoMarketplace), [freteDoMarketplace]);
  const buscaPesoNum = buscaPeso.trim() === '' ? null : normalizarNum(buscaPeso);
  const pesosFiltrados = grade.pesos.filter((p) => buscaPesoNum === null || dentroDaFaixa(buscaPesoNum, p.min, p.max));
  const pesosExibidos = mostrarTodasFaixas || buscaPesoNum !== null ? pesosFiltrados : pesosFiltrados.slice(0, LINHAS_INICIAIS);
  const totalFaixasFrete = freteDoMarketplace.length;

  return (
    <div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Tabelas de comissão e frete que o Mercado Livre e a Shopee cobram dos vendedores — usadas na
        aba Vendas → Taxas de Marketplace pra conferir se a cobrança real bate com o esperado. Ajuste
        aqui sempre que o marketplace anunciar reajuste.
      </p>

      <div className="shell-nav" style={{ marginBottom: 16 }}>
        {MARKETPLACES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={'nav-link' + (marketplace === m.key ? ' active' : '')}
            onClick={() => setMarketplace(m.key)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          >
            <img src={m.logo} alt="" width={16} height={16} style={{ borderRadius: 3 }} />
            {m.label}
          </button>
        ))}
      </div>

      <div className="card cfg-simulador" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="cfg-simulador-campo">
          <span className="cfg-simulador-campo-label">Valor do anúncio</span>
          <NumInput value={valorSim} onChange={setValorSim} suffix="R$" style={{ maxWidth: 120 }} />
        </div>
        <div className="cfg-simulador-campo">
          <span className="cfg-simulador-campo-label">Peso da peça</span>
          <NumInput value={pesoSim} onChange={setPesoSim} suffix="kg" style={{ maxWidth: 100 }} />
        </div>
        {marketplace === 'mercado_livre' && (
          <div className="cfg-simulador-campo">
            <span className="cfg-simulador-campo-label">Tipo de anúncio</span>
            <Select value={tipoAnuncioSim} onChange={(e) => setTipoAnuncioSim(e.target.value)} style={{ maxWidth: 120 }}>
              <option value="classico">Clássico</option>
              <option value="premium">Premium</option>
            </Select>
          </div>
        )}
        <div className="cfg-simulador-resultado">
          <div className="cfg-simulador-resultado-item">
            <div className="cfg-simulador-resultado-label">Comissão</div>
            <div className="cfg-simulador-resultado-valor">- {brl(comissaoValorSim)}</div>
          </div>
          <div className="cfg-simulador-resultado-item">
            <div className="cfg-simulador-resultado-label">Frete</div>
            <div className="cfg-simulador-resultado-valor">- {brl(freteValorSim)}</div>
          </div>
        </div>
        <div className="cfg-simulador-recebe">
          <div className="cfg-simulador-recebe-label">Sobra</div>
          <div className="cfg-simulador-recebe-valor">{brl(sobraSim)}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Comissão</div>
        <table className="data-table">
          <thead>
            <tr>
              {marketplace === 'mercado_livre' && <th>Tipo de anúncio</th>}
              <th>Faixa de valor do item</th>
              <th>Comissão %</th>
              <th>Comissão fixa R$</th>
              {marketplace === 'shopee' && <th>Subsídio Pix %</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {comissaoDoMarketplace.map((f) => {
              const aplicavel = f === comissaoRowSim;
              return (
                <tr key={f.id} className={'cfg-linha-hover' + (aplicavel ? ' cfg-linha-aplicavel' : '')}>
                  {marketplace === 'mercado_livre' && (
                    <td>
                      <Select value={f.tipo_anuncio || 'classico'} onChange={(e) => atualizarComissao(f.id, { tipo_anuncio: e.target.value })}>
                        <option value="classico">Clássico</option>
                        <option value="premium">Premium</option>
                      </Select>
                    </td>
                  )}
                  <td>
                    <div className="cfg-faixa-legivel">{faixaLegivel(f.valor_min, f.valor_max)}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <NumInput value={f.valor_min} onChange={(v) => atualizarComissao(f.id, { valor_min: v })} style={{ maxWidth: 90 }} />
                      <NumInput value={f.valor_max ?? ''} onChange={(v) => atualizarComissao(f.id, { valor_max: v === '' ? null : v })} placeholder="sem teto" style={{ maxWidth: 90 }} />
                    </div>
                  </td>
                  <td><NumInput value={paraPct(f.comissao_pct)} onChange={(v) => atualizarComissao(f.id, { comissao_pct: (Number(v) || 0) / 100 })} suffix="%" /></td>
                  <td><NumInput value={f.comissao_fixa} onChange={(v) => atualizarComissao(f.id, { comissao_fixa: v })} suffix="R$" /></td>
                  {marketplace === 'shopee' && (
                    <td><NumInput value={paraPct(f.subsidio_pix_pct)} onChange={(v) => atualizarComissao(f.id, { subsidio_pix_pct: (Number(v) || 0) / 100 })} suffix="%" /></td>
                  )}
                  <td><button className="icon-btn cfg-lixeira" onClick={() => removeComissao(f.id)}><Trash2 size={13} /></button></td>
                </tr>
              );
            })}
            {comissaoDoMarketplace.length === 0 && <tr><td colSpan="6">Nenhuma faixa cadastrada.</td></tr>}
          </tbody>
        </table>
        <button className="btn btn-dashed" style={{ marginTop: 10 }} onClick={addComissao}>
          <Plus size={13} /> Adicionar faixa
        </button>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Frete Subsidiado ({totalFaixasFrete} faixas)</div>
          <div className="cfg-busca">
            <Search size={14} />
            <input placeholder="Buscar por peso (kg)…" value={buscaPeso} onChange={(e) => setBuscaPeso(e.target.value)} style={{ minWidth: 170 }} />
          </div>
        </div>
        <p className="page-sub">
          Custo de Mercado Envios / Frete Grátis por peso e faixa de valor do pedido — só entra na
          conta se o produto tiver peso cadastrado e a loja usar frete subsidiado (configurável em
          Integrações). A faixa aplicável ao simulador acima está destacada.
        </p>

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table cfg-grade-frete">
            <thead>
              <tr>
                <th>Peso \ Valor do pedido</th>
                {grade.valores.map((v) => (
                  <th key={`${v.min}-${v.max}`} className={dentroDaFaixa(valorSim, v.min, v.max) ? 'cfg-coluna-aplicavel' : ''}>
                    {faixaLegivel(v.min, v.max)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pesosExibidos.map((p) => {
                const linhaAplicavel = dentroDaFaixa(pesoSim, p.min, p.max);
                return (
                  <tr key={`${p.min}-${p.max}`} className={linhaAplicavel ? 'cfg-linha-aplicavel' : ''}>
                    <td className="mono">{p.min}{p.max === null ? 'kg+' : `–${p.max}kg`}</td>
                    {grade.valores.map((v) => {
                      const cel = grade.porChave.get(`${p.min}|${p.max}||${v.min}|${v.max}`);
                      const aplicavel = linhaAplicavel && dentroDaFaixa(valorSim, v.min, v.max);
                      return (
                        <td key={`${v.min}-${v.max}`} className={'mono' + (aplicavel ? ' cfg-celula-aplicavel' : '')}>
                          {cel ? brl(cel.custo_frete) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {pesosExibidos.length === 0 && (
                <tr><td colSpan={grade.valores.length + 1} style={{ textAlign: 'center', color: 'var(--ink-faint)' }}>Nenhuma faixa de peso encontrada.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {buscaPesoNum === null && pesosFiltrados.length > LINHAS_INICIAIS && (
          <button type="button" className="cfg-colapsavel-cabecalho" style={{ marginTop: 8 }} onClick={() => setMostrarTodasFaixas((v) => !v)}>
            {mostrarTodasFaixas ? `Mostrar só as primeiras ${LINHAS_INICIAIS} faixas de peso` : `Ver tabela inteira (${pesosFiltrados.length} faixas de peso)`}
          </button>
        )}

        <table className="data-table" style={{ marginTop: 14 }}>
          <thead>
            <tr><th>Editar faixa</th><th>Peso (de)</th><th>Peso (até)</th><th>Valor pedido (de)</th><th>Valor pedido (até)</th><th>Custo frete R$</th><th /></tr>
          </thead>
          <tbody>
            {freteDoMarketplace.map((f) => (
              <tr key={f.id} className="cfg-linha-hover">
                <td className="page-sub" style={{ margin: 0 }}>#{f.id}</td>
                <td><NumInput value={f.peso_min_kg} onChange={(v) => atualizarFrete(f.id, { peso_min_kg: v })} suffix="kg" /></td>
                <td><NumInput value={f.peso_max_kg ?? ''} onChange={(v) => atualizarFrete(f.id, { peso_max_kg: v === '' ? null : v })} suffix="kg" placeholder="sem teto" /></td>
                <td><NumInput value={f.valor_min} onChange={(v) => atualizarFrete(f.id, { valor_min: v })} /></td>
                <td><NumInput value={f.valor_max ?? ''} onChange={(v) => atualizarFrete(f.id, { valor_max: v === '' ? null : v })} placeholder="sem teto" /></td>
                <td><NumInput value={f.custo_frete} onChange={(v) => atualizarFrete(f.id, { custo_frete: v })} suffix="R$" /></td>
                <td><button className="icon-btn cfg-lixeira" onClick={() => removeFrete(f.id)}><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {freteDoMarketplace.length === 0 && <tr><td colSpan="7">Nenhuma faixa cadastrada.</td></tr>}
          </tbody>
        </table>
        <button className="btn btn-dashed" style={{ marginTop: 10 }} onClick={addFrete}>
          <Plus size={13} /> Adicionar faixa
        </button>
      </div>

      <BarraAlteracoes
        quantidade={camposAlterados.length}
        salvando={salvando}
        mensagemSalvo={mensagemSalvo}
        detalhe={camposAlterados.slice(0, 3).join(' · ')}
        onSalvar={salvar}
        onDescartar={descartar}
      />
    </div>
  );
}
