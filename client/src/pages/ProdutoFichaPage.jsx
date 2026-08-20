import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Plus, Trash2, Layers, Factory, Wallet, TrendingUp, AlertTriangle,
  Save, XCircle, CheckCircle2, Package, ArrowLeft, ImagePlus,
} from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Row, Select } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { statusToneClass } from '../lib/statusTone';
import { brl, pct, uid } from '../lib/format';
import Lightbox from '../components/Lightbox';

const UNIDADES_FALLBACK = ['un', 'm', 'cm', 'kg', 'g', 'par', 'cj', 'rolo', 'pct'];

function emptyProduto() {
  return {
    codigo: '',
    referencia: '',
    descricao: '',
    categoria: '',
    marca: '',
    colecao: '',
    linha: '',
    empresa_id: '',
    responsavel: '',
    preco_informado: '',
    peso_kg: '',
  };
}

const STATUS_ICON = {
  'PREJUÍZO': XCircle,
  'PREÇO ABAIXO DA MARGEM MÍNIMA': AlertTriangle,
  'ATENÇÃO - MARGEM PRÓXIMA DO LIMITE': AlertTriangle,
  'MARGEM SAUDÁVEL': CheckCircle2,
  'MARGEM ELEVADA': TrendingUp,
};

export default function ProdutoFichaPage() {
  const { id } = useParams();
  const isNew = id === 'novo';
  const navigate = useNavigate();

  const [produto, setProduto] = useState(emptyProduto());
  const [materiais, setMateriais] = useState([]);
  const [custosIndustriais, setCustosIndustriais] = useState([]);
  const [calculo, setCalculo] = useState(null);
  const [listas, setListas] = useState(null);
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const calcTimer = useRef(null);
  const fotoInputRef = useRef(null);
  const [enviandoFoto, setEnviandoFoto] = useState(false);
  const [fotoVersion, setFotoVersion] = useState(0);
  const [fotoAmpliada, setFotoAmpliada] = useState(false);
  const fotoUrl = `/api/produtos/${id}/foto?v=${fotoVersion}`;

  useEffect(() => {
    Promise.all([api.get('/listas'), api.get('/empresas')]).then(([l, e]) => {
      setListas(l);
      setEmpresas(e);
    });
  }, []);

  useEffect(() => {
    if (isNew) {
      setProduto(emptyProduto());
      setMateriais([]);
      setCustosIndustriais([]);
      setCalculo(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get(`/produtos/${id}`).then((data) => {
      setProduto({
        ...data.produto,
        preco_informado: data.produto.preco_informado ?? '',
        empresa_id: data.produto.empresa_id ?? '',
      });
      setMateriais(data.materiais.map((m) => ({ ...m, _key: m.id })));
      setCustosIndustriais(data.custosIndustriais.map((c) => ({ ...c, _key: c.id })));
      setCalculo(data.calculo);
      setLoading(false);
    });
  }, [id, isNew]);

  const unidades = listas?.unidade.map((u) => u.valor) || UNIDADES_FALLBACK;

  function recalcularAoVivo(nextProduto, nextMateriais, nextCustos) {
    if (calcTimer.current) clearTimeout(calcTimer.current);
    calcTimer.current = setTimeout(async () => {
      const data = await api.post('/produtos/calcular', {
        empresa_id: nextProduto.empresa_id || null,
        preco_informado: nextProduto.preco_informado,
        materiais: nextMateriais,
        custosIndustriais: nextCustos,
      });
      setCalculo(data);
    }, 350);
  }

  function updateProduto(patch) {
    const next = { ...produto, ...patch };
    setProduto(next);
    recalcularAoVivo(next, materiais, custosIndustriais);
  }

  function updateMaterial(key, patch) {
    const next = materiais.map((m) => (m._key === key ? { ...m, ...patch } : m));
    setMateriais(next);
    recalcularAoVivo(produto, next, custosIndustriais);
  }
  function addMaterial() {
    const next = [...materiais, { _key: uid(), material: '', unidade: unidades[0] || 'un', quantidade: 1, valor_unitario: 0 }];
    setMateriais(next);
    recalcularAoVivo(produto, next, custosIndustriais);
  }
  function removeMaterial(key) {
    const next = materiais.filter((m) => m._key !== key);
    setMateriais(next);
    recalcularAoVivo(produto, next, custosIndustriais);
  }

  function updateCusto(key, patch) {
    const next = custosIndustriais.map((c) => (c._key === key ? { ...c, ...patch } : c));
    setCustosIndustriais(next);
    recalcularAoVivo(produto, materiais, next);
  }
  function addCusto() {
    const next = [...custosIndustriais, { _key: uid(), tipo: '', observacao: '', valor: 0 }];
    setCustosIndustriais(next);
    recalcularAoVivo(produto, materiais, next);
  }
  function removeCusto(key) {
    const next = custosIndustriais.filter((c) => c._key !== key);
    setCustosIndustriais(next);
    recalcularAoVivo(produto, materiais, next);
  }

  async function handleSalvar() {
    setError('');
    if (!produto.referencia) {
      setError('Referência é obrigatória.');
      return;
    }
    setSaving(true);
    const body = {
      ...produto,
      preco_informado: produto.preco_informado === '' ? null : produto.preco_informado,
      empresa_id: produto.empresa_id || null,
      materiais,
      custosIndustriais,
    };
    try {
      if (isNew) {
        const created = await api.post('/produtos', body);
        navigate(`/produtos/${created.produto.id}`, { replace: true });
      } else {
        const updated = await api.put(`/produtos/${id}`, body);
        setProduto({ ...updated.produto, preco_informado: updated.produto.preco_informado ?? '', empresa_id: updated.produto.empresa_id ?? '' });
        setMateriais(updated.materiais.map((m) => ({ ...m, _key: m.id })));
        setCustosIndustriais(updated.custosIndustriais.map((c) => ({ ...c, _key: c.id })));
        setCalculo(updated.calculo);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleExcluir() {
    if (!(await confirmar(`Remover o produto "${produto.referencia}"? Essa ação não pode ser desfeita.`))) return;
    await api.del(`/produtos/${id}`);
    navigate('/produtos');
  }

  async function handleFotoSelecionada(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setEnviandoFoto(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('foto', file);
      await api.upload(`/produtos/${id}/foto`, formData);
      setProduto((p) => ({ ...p, temFoto: true }));
      setFotoVersion((v) => v + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviandoFoto(false);
      if (fotoInputRef.current) fotoInputRef.current.value = '';
    }
  }

  async function handleRemoverFoto() {
    if (!(await confirmar('Remover a foto desse produto?'))) return;
    await api.del(`/produtos/${id}/foto`);
    setProduto((p) => ({ ...p, temFoto: false }));
  }

  const totalMateriais = useMemo(
    () => materiais.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0), 0),
    [materiais]
  );
  const totalIndustrial = useMemo(
    () => custosIndustriais.reduce((s, c) => s + (Number(c.valor) || 0), 0),
    [custosIndustriais]
  );

  if (loading || !listas) return <div className="page">Carregando…</div>;

  const c = calculo;
  const StatusIcon = c ? STATUS_ICON[c.formacaoPreco.status] || Package : Package;
  const toneClass = c ? statusToneClass(c.formacaoPreco.status) : 'tone-neutro';

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/produtos')}>
        <ArrowLeft size={14} /> Voltar para produtos
      </button>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div className="produto-foto-painel">
            {produto.temFoto ? (
              <img src={fotoUrl} alt={produto.descricao} className="foto-produto-thumb" style={{ width: 108, height: 108 }} onClick={() => setFotoAmpliada(true)} />
            ) : (
              <button
                type="button"
                className="foto-produto-upload-btn"
                style={{ width: 108, height: 108 }}
                disabled={isNew}
                title={isNew ? 'Salve o produto primeiro pra adicionar uma foto' : 'Adicionar foto'}
                onClick={() => fotoInputRef.current?.click()}
              >
                <ImagePlus size={22} />
                <span>{enviandoFoto ? 'Enviando…' : 'Adicionar foto'}</span>
              </button>
            )}
            {!isNew && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button type="button" className="btn btn-ghost sm" onClick={() => fotoInputRef.current?.click()} disabled={enviandoFoto}>
                  {produto.temFoto ? 'Trocar' : 'Enviar'}
                </button>
                {produto.temFoto && (
                  <button type="button" className="icon-btn" title="Remover foto" onClick={handleRemoverFoto}><Trash2 size={13} /></button>
                )}
              </div>
            )}
            <input
              ref={fotoInputRef} type="file" accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }} onChange={handleFotoSelecionada}
            />
            {fotoAmpliada && <Lightbox src={fotoUrl} alt={produto.descricao} onClose={() => setFotoAmpliada(false)} />}
          </div>
          <div className="form-grid" style={{ flex: 1, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <Field label="Código do Produto">
              <input value={produto.codigo || ''} onChange={(e) => updateProduto({ codigo: e.target.value })} placeholder="MM6387" />
            </Field>
            <Field label="Referência (SKU)">
              <input value={produto.referencia || ''} onChange={(e) => updateProduto({ referencia: e.target.value })} placeholder="MM6387-P-AZ" />
            </Field>
            <Field label="Descrição">
              <input value={produto.descricao || ''} onChange={(e) => updateProduto({ descricao: e.target.value })} />
            </Field>
            <Field label="Categoria">
              <Select value={produto.categoria || ''} onChange={(e) => updateProduto({ categoria: e.target.value })}>
                <option value="">—</option>
                {listas.categoria.map((v) => <option key={v.id} value={v.valor}>{v.valor}</option>)}
              </Select>
            </Field>
            <Field label="Marca">
              <Select value={produto.marca || ''} onChange={(e) => updateProduto({ marca: e.target.value })}>
                <option value="">—</option>
                {listas.marca.map((v) => <option key={v.id} value={v.valor}>{v.valor}</option>)}
              </Select>
            </Field>
            <Field label="Coleção">
              <Select value={produto.colecao || ''} onChange={(e) => updateProduto({ colecao: e.target.value })}>
                <option value="">—</option>
                {listas.colecao.map((v) => <option key={v.id} value={v.valor}>{v.valor}</option>)}
              </Select>
            </Field>
            <Field label="Linha">
              <Select value={produto.linha || ''} onChange={(e) => updateProduto({ linha: e.target.value })}>
                <option value="">—</option>
                {listas.linha.map((v) => <option key={v.id} value={v.valor}>{v.valor}</option>)}
              </Select>
            </Field>
            <Field label="Empresa (regime tributário)">
              <Select value={produto.empresa_id || ''} onChange={(e) => updateProduto({ empresa_id: e.target.value })}>
                <option value="">—</option>
                {empresas.map((emp) => <option key={emp.id} value={emp.id}>{emp.nome}</option>)}
              </Select>
            </Field>
            <Field label="Responsável pela Precificação">
              <input value={produto.responsavel || ''} onChange={(e) => updateProduto({ responsavel: e.target.value })} />
            </Field>
            <Field label="Peso da peça (opcional)">
              <NumInput value={produto.peso_kg ?? ''} onChange={(v) => updateProduto({ peso_kg: v === '' ? null : v })} suffix="kg" placeholder="usado na conferência de frete de marketplace" />
            </Field>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleSalvar} disabled={saving}>
              <Save size={14} /> {saving ? 'Salvando…' : 'Salvar'}
            </button>
            {!isNew && (
              <button className="btn btn-danger" onClick={handleExcluir}>
                <Trash2 size={14} /> Remover
              </button>
            )}
          </div>
        </div>
        {error && <div className="login-error" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {c && (
        <div className="stamp-row">
          <div className={'stamp ' + toneClass}>
            <StatusIcon size={16} />
            {c.formacaoPreco.status}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            <span style={{ fontSize: 10.5, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Preço {produto.preco_informado ? 'praticado' : 'sugerido'}
            </span>
            <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--leather-dark)' }}>
              {brl(c.formacaoPreco.precoAtivo)}
            </span>
          </div>
        </div>
      )}

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head"><Layers size={14} /> Materiais</div>
          <table className="data-table">
            <thead>
              <tr><th>Material</th><th>Un.</th><th>Qtd</th><th>Vlr. unit.</th><th>Total</th><th /></tr>
            </thead>
            <tbody>
              {materiais.map((m) => (
                <tr key={m._key}>
                  <td>
                    <input
                      list="lista-materiais"
                      value={m.material || ''}
                      onChange={(e) => updateMaterial(m._key, { material: e.target.value })}
                    />
                  </td>
                  <td>
                    <Select value={m.unidade || ''} onChange={(e) => updateMaterial(m._key, { unidade: e.target.value })}>
                      {unidades.map((u) => <option key={u} value={u}>{u}</option>)}
                    </Select>
                  </td>
                  <td><NumInput value={m.quantidade} onChange={(v) => updateMaterial(m._key, { quantidade: v })} /></td>
                  <td><NumInput value={m.valor_unitario} onChange={(v) => updateMaterial(m._key, { valor_unitario: v })} suffix="R$" /></td>
                  <td className="mono">{brl((Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0))}</td>
                  <td><button className="icon-btn" onClick={() => removeMaterial(m._key)}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="lista-materiais">
            {listas.material.map((v) => <option key={v.id} value={v.valor} />)}
          </datalist>
          <button className="btn btn-dashed" style={{ marginTop: 8 }} onClick={addMaterial}>
            <Plus size={13} /> Adicionar material
          </button>
          <div className="total-banner" style={{ background: 'var(--border-soft)', color: 'var(--ink)' }}>
            Total materiais <span className="mono">{brl(totalMateriais)}</span>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><Factory size={14} /> Custos Industriais</div>
          <table className="data-table">
            <thead>
              <tr><th>Tipo</th><th>Observação / fornecedor</th><th>Valor</th><th /></tr>
            </thead>
            <tbody>
              {custosIndustriais.map((cst) => (
                <tr key={cst._key}>
                  <td>
                    <Select value={cst.tipo || ''} onChange={(e) => updateCusto(cst._key, { tipo: e.target.value })}>
                      <option value="">—</option>
                      {listas.tipo_custo_industrial.map((v) => <option key={v.id} value={v.valor}>{v.valor}</option>)}
                    </Select>
                  </td>
                  <td><input value={cst.observacao || ''} onChange={(e) => updateCusto(cst._key, { observacao: e.target.value })} /></td>
                  <td><NumInput value={cst.valor} onChange={(v) => updateCusto(cst._key, { valor: v })} suffix="R$" /></td>
                  <td><button className="icon-btn" onClick={() => removeCusto(cst._key)}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-dashed" style={{ marginTop: 8 }} onClick={addCusto}>
            <Plus size={13} /> Adicionar custo
          </button>
          <div className="total-banner" style={{ background: 'var(--border-soft)', color: 'var(--ink)' }}>
            Total industrial <span className="mono">{brl(totalIndustrial)}</span>
          </div>
        </div>
      </div>

      {c && (
        <div className="grid-2" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="card-head"><Wallet size={14} /> Custo Total da Peça</div>
            <Row label="Materiais" value={brl(c.custoTotal.totalMateriais)} />
            <Row label="Custo industrial" value={brl(c.custoTotal.totalIndustrial)} />
            <Row label="Custo indireto (rateio)" value={brl(c.custoTotal.custoIndireto)} />
            <Row label="Subtotal de produção" value={brl(c.custoTotal.subtotalProducao)} strong />
            <Row label={`Impostos (${pct(c.custoTotal.pctImpostos)})`} value={brl(c.custoTotal.impostosRS)} />
            <Row label={`Taxas de venda (${pct(c.custoTotal.pctTaxas)})`} value={brl(c.custoTotal.taxasRS)} />
            <Row label="Custo total da peça" value={brl(c.custoTotal.custoTotalPeca)} strong big />
          </div>

          <div className="card">
            <div className="card-head"><TrendingUp size={14} /> Formação do Preço</div>
            <Field label="Preço praticado (opcional — deixe em branco para usar o sugerido)">
              <NumInput
                value={produto.preco_informado}
                onChange={(v) => updateProduto({ preco_informado: v })}
                suffix="R$"
                placeholder={c.formacaoPreco.precoSugerido.toFixed(2)}
              />
            </Field>
            <Row label="Preço sugerido (margem ideal)" value={brl(c.formacaoPreco.precoSugerido)} strong />
            <Row label="Preço mínimo aceitável" value={brl(c.formacaoPreco.precoMinimo)} />
            <Row label="Preço ideal" value={brl(c.formacaoPreco.precoIdeal)} />
            <Row label="Preço premium" value={brl(c.formacaoPreco.precoPremium)} />
            <Row label="Preço máximo recomendado" value={brl(c.formacaoPreco.precoMax)} />
            <Row label="Lucro estimado" value={`${brl(c.formacaoPreco.lucroRS)} · ${pct(c.formacaoPreco.lucroPct)}`} strong />
            <Row label="Markup (mult.)" value={`${c.formacaoPreco.markupMult.toFixed(2)}x`} />
          </div>
        </div>
      )}

      {c && (
        <div className="grid-2">
          <div className="card">
            <div className="card-head">Indicadores</div>
            <Row label="Markup" value={`${c.indicadores.markup.toFixed(2)}x`} />
            <Row label="Margem bruta" value={pct(c.indicadores.margemBruta)} />
            <Row label="Margem de contribuição" value={brl(c.indicadores.margemContribuicao)} />
            <Row label="Lucro líquido estimado" value={brl(c.indicadores.lucroLiquidoEstimado)} />
            <Row label="ROI estimado" value={pct(c.indicadores.roiEstimado)} />
            <Row label="Custo industrial" value={brl(c.indicadores.custoIndustrial)} />
            <Row label="Custo administrativo (indireto)" value={brl(c.indicadores.custoAdministrativo)} />
            <Row label="Peso impostos" value={pct(c.indicadores.pesoImpostos)} />
            <Row label="Peso taxas" value={pct(c.indicadores.pesoTaxas)} />
            <Row label="Peso custo indireto" value={pct(c.indicadores.pesoCustoIndireto)} />
          </div>
          <div className="card">
            <div className="card-head"><AlertTriangle size={14} /> Alertas</div>
            <ul className="alerts-list">
              {c.alertas.map((a, i) => (
                <li key={i} className={a === 'Tudo dentro do esperado' ? 'ok' : ''}>{a}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
