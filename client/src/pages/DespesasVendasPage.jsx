import { useEffect, useMemo, useState } from 'react';
import {
  Megaphone, Plus, Trash2, Pencil, Info, Wallet, CalendarDays, PieChart as PieIcon,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { api } from '../api/client';
import { Field, Select, NumInput, EstadoVazio, AvisoDeFalha, Skeleton } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import { confirmar } from '../components/ConfirmDialog';
import { brl, pct, formatQtd, hojeIso } from '../lib/format';
import DataTable from '../components/DataTable';
import { usePaletaGrafico, corPorIndice } from '../lib/coresGrafico';

// Publicidade e despesas da venda direta (09/09/2026).
//
// O marketplace puxa o gasto de Ads pela API. A venda direta não tem de onde
// puxar: o impulsionamento do Instagram, o panfleto e a feira são pagos fora
// do sistema. Esta tela é onde esse gasto entra, por MÊS de competência, para
// o relatório de lucratividade poder descontá-lo do lucro.
//
// REGRA 2 na cara da tela: quando o período escolhido pega só parte de um mês,
// o valor daquele mês entra RATEADO POR DIAS, e cada linha diz quanto entrou e
// por quê. Mostrar a publicidade do mês inteiro dentro de uma semana seria
// inventar despesa; escondê-la seria inventar lucro.

const PRESET_MES = PRESETS_PERIODO.find((p) => p.chave === 'esteMes').calcular();

const TIPOS = [
  { valor: 'publicidade', rotulo: 'Publicidade' },
  { valor: 'comissao_extra', rotulo: 'Comissão extra / premiação' },
  { valor: 'frete', rotulo: 'Frete pago pela loja' },
  { valor: 'embalagem', rotulo: 'Embalagem' },
  { valor: 'brinde', rotulo: 'Brinde e amostra' },
  { valor: 'evento', rotulo: 'Feira e evento' },
  { valor: 'outros', rotulo: 'Outros' },
];

const TIPO_LABEL = Object.fromEntries(TIPOS.map((t) => [t.valor, t.rotulo]));

const CANAIS_SUGERIDOS = [
  'Instagram / Meta Ads', 'Google Ads', 'TikTok Ads', 'WhatsApp / disparo',
  'Panfleto e impresso', 'Rádio', 'Influenciador', 'Feira', 'Outro',
];

function mesAtual() {
  return hojeIso().slice(0, 7);
}

function rotuloMes(competencia) {
  const [ano, mes] = String(competencia).slice(0, 7).split('-');
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${nomes[Number(mes) - 1] || mes}/${ano}`;
}

function lancamentoVazio() {
  return { competencia: mesAtual(), tipo: 'publicidade', descricao: '', canal: '', valor: 0, vendedor_id: '', observacao: '' };
}

function TooltipDespesa({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 14px', boxShadow: 'var(--shadow-md)', fontFamily: 'var(--font-body)',
    }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{label}</div>
      {payload.map((item) => (
        <div key={item.dataKey} style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
          <span style={{ color: 'var(--ink-soft)' }}>{item.name}</span>
          <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600 }}>{brl(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function DespesasVendasPage() {
  const paleta = usePaletaGrafico();
  const [dados, setDados] = useState(null);
  const [vendedores, setVendedores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [{ inicio, fim }, setPeriodo] = useState(PRESET_MES);
  const [tipoFiltro, setTipoFiltro] = useState('');

  const [form, setForm] = useState(lancamentoVazio());
  const [editandoId, setEditandoId] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [abertoForm, setAbertoForm] = useState(false);

  function carregar() {
    setLoading(true);
    setErro('');
    const params = new URLSearchParams();
    if (inicio) params.set('data_inicio', inicio);
    if (fim) params.set('data_fim', fim);
    if (tipoFiltro) params.set('tipo', tipoFiltro);
    api.get(`/vendas/despesas?${params.toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(carregar, [inicio, fim, tipoFiltro]);
  useEffect(() => { api.get('/vendedores').then(setVendedores).catch(() => setVendedores([])); }, []);

  const publicidade = useMemo(
    () => (dados?.itens || []).filter((d) => d.tipo === 'publicidade').reduce((s, d) => s + d.valorNoPeriodo, 0),
    [dados]
  );

  const porMes = useMemo(() => {
    const mapa = new Map();
    for (const item of dados?.itens || []) {
      const chave = item.competencia.slice(0, 7);
      if (!mapa.has(chave)) mapa.set(chave, { mes: rotuloMes(chave), publicidade: 0, outras: 0 });
      const alvo = mapa.get(chave);
      if (item.tipo === 'publicidade') alvo.publicidade += item.valorNoPeriodo;
      else alvo.outras += item.valorNoPeriodo;
    }
    return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
  }, [dados]);

  async function salvar(e) {
    e.preventDefault();
    setSalvando(true);
    setErro('');
    try {
      const corpo = { ...form, vendedor_id: form.vendedor_id || null, competencia: `${form.competencia}-01` };
      if (editandoId) await api.put(`/vendas/despesas/${editandoId}`, corpo);
      else await api.post('/vendas/despesas', corpo);
      setForm(lancamentoVazio());
      setEditandoId(null);
      setAbertoForm(false);
      carregar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function excluir(item) {
    if (!(await confirmar(`Excluir o lançamento de ${brl(item.valor)} de ${rotuloMes(item.competencia)}?`))) return;
    try {
      await api.del(`/vendas/despesas/${item.id}`);
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  function editar(item) {
    setForm({
      competencia: item.competencia.slice(0, 7),
      tipo: item.tipo,
      descricao: item.descricao || '',
      canal: item.canal || '',
      valor: Number(item.valor),
      vendedor_id: item.vendedor_id || '',
      observacao: item.observacao || '',
    });
    setEditandoId(item.id);
    setAbertoForm(true);
  }

  return (
    <div className="page-wide">
      <div className="pagina-topo">
        <div>
          <h1>Publicidade e Despesas</h1>
          <p className="page-sub">
            O que a venda direta gasta fora do custo da peça: impulsionamento, feira, brinde, frete
            pago pela loja. É daqui que a Lucratividade tira o desconto de publicidade do mês.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { setAbertoForm((v) => !v); setEditandoId(null); setForm(lancamentoVazio()); }}
          >
            <Plus size={14} /> Lançar gasto
          </button>
        </div>
      </div>

      <div className="filtros-barra">
        <PeriodoFiltro inicio={inicio} fim={fim} onChange={({ inicio: i, fim: f }) => setPeriodo({ inicio: i, fim: f })} />
        <Select value={tipoFiltro} onChange={(e) => setTipoFiltro(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">Todos os tipos de gasto</option>
          {TIPOS.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
        </Select>
      </div>

      <AvisoDeFalha mensagem={erro} aoTentarDeNovo={carregar} />

      {abertoForm && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={salvar}>
          <div className="card-head">{editandoId ? 'Editar lançamento' : 'Novo lançamento'}</div>
          <div className="form-grid">
            <Field label="Mês de competência" hint="O gasto pertence ao mês inteiro, não a um dia.">
              <input type="month" value={form.competencia} onChange={(e) => setForm((f) => ({ ...f, competencia: e.target.value }))} />
            </Field>
            <Field label="Tipo">
              <Select value={form.tipo} onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value }))}>
                {TIPOS.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
              </Select>
            </Field>
            <Field label="Valor">
              <NumInput value={form.valor} onChange={(v) => setForm((f) => ({ ...f, valor: v }))} suffix="R$" />
            </Field>
            <Field label="Onde foi gasto" hint="Instagram, Google, panfleto, feira…">
              <input
                list="canais-despesa"
                value={form.canal}
                onChange={(e) => setForm((f) => ({ ...f, canal: e.target.value }))}
              />
              <datalist id="canais-despesa">
                {CANAIS_SUGERIDOS.map((c) => <option key={c} value={c} />)}
              </datalist>
            </Field>
            <Field label="Descrição">
              <input
                value={form.descricao}
                onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
                placeholder="Ex.: campanha de dia das mães"
              />
            </Field>
            <Field label="Vendedor (opcional)" hint="Só quando o gasto foi para a campanha de uma pessoa específica.">
              <Select value={form.vendedor_id} onChange={(e) => setForm((f) => ({ ...f, vendedor_id: e.target.value }))}>
                <option value="">Gasto da operação inteira</option>
                {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Observação">
            <textarea rows={2} value={form.observacao} onChange={(e) => setForm((f) => ({ ...f, observacao: e.target.value }))} />
          </Field>
          <div className="painel-acoes-inline" style={{ marginTop: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={salvando || !(Number(form.valor) > 0)}>
              {salvando ? 'Salvando…' : editandoId ? 'Salvar alteração' : 'Lançar'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setAbertoForm(false); setEditandoId(null); setForm(lancamentoVazio()); }}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {loading && !dados && <Skeleton height={160} />}

      {dados && (
        <>
          <div className="stat-strip">
            <div className="stat-card">
              <div className="stat-card-corpo">
                <span className="stat-card-label">Publicidade no período</span>
                <span className="stat-card-value">{brl(publicidade)}</span>
              </div>
              <Megaphone size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
            </div>
            <div className="stat-card">
              <div className="stat-card-corpo">
                <span className="stat-card-label">Outras despesas</span>
                <span className="stat-card-value">{brl(dados.totalNoPeriodo - publicidade)}</span>
              </div>
              <Wallet size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
            </div>
            <div className="stat-card">
              <div className="stat-card-corpo">
                <span className="stat-card-label">Total que entra no lucro</span>
                <span className="stat-card-value">{brl(dados.totalNoPeriodo)}</span>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-card-corpo">
                <span className="stat-card-label">Lançado nos meses</span>
                <span className="stat-card-value">{brl(dados.totalLancado)}</span>
                <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
                  {formatQtd(dados.itens.length)} lançamento(s)
                </span>
              </div>
              <CalendarDays size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
            </div>
          </div>

          {dados.houveRateio && (
            <div className="venda-ressalva" style={{ marginTop: 0, marginBottom: 16 }}>
              <Info size={14} />
              <span>{dados.criterio}</span>
            </div>
          )}

          {porMes.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">Gasto por mês</div>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={porMes} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
                  <XAxis dataKey="mes" tick={{ fontSize: 11.5, fill: 'var(--ink-soft)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11.5, fill: 'var(--ink-soft)' }} tickFormatter={(v) => brl(v)} width={86} axisLine={false} tickLine={false} />
                  <Tooltip content={<TooltipDespesa />} cursor={{ fill: 'var(--accent-softer)' }} />
                  <Bar dataKey="publicidade" name="Publicidade" fill={corPorIndice(paleta, 0)} radius={[4, 4, 0, 0]} stackId="d" />
                  <Bar dataKey="outras" name="Outras despesas" fill={corPorIndice(paleta, 3)} radius={[4, 4, 0, 0]} stackId="d" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="duas-colunas" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head"><PieIcon size={13} /> Por onde saiu</div>
              {dados.porCanal.length === 0 ? (
                <p className="page-sub" style={{ margin: 0 }}>Nada lançado no período.</p>
              ) : (
                <div className="ranking">
                  {dados.porCanal.map((c, i) => {
                    const maior = dados.porCanal[0].valor || 1;
                    return (
                      <div className="ranking-linha" key={c.canal}>
                        <span className="ranking-posicao mono">{i + 1}</span>
                        <span className="ranking-nome">{c.canal}</span>
                        <span className="ranking-barra">
                          <span style={{ width: `${(c.valor / maior) * 100}%`, background: corPorIndice(paleta, i) }} />
                        </span>
                        <span className="ranking-valor mono">{brl(c.valor)}</span>
                        <span className="ranking-pct mono">{pct(dados.totalNoPeriodo > 0 ? c.valor / dados.totalNoPeriodo : 0)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="card">
              <div className="card-head">Por tipo de gasto</div>
              {dados.porTipo.length === 0 ? (
                <p className="page-sub" style={{ margin: 0 }}>Nada lançado no período.</p>
              ) : (
                <div className="cascata-lucro">
                  {dados.porTipo.map((t) => (
                    <div className="cascata-linha" key={t.tipo}>
                      <span className="cascata-rotulo">{TIPO_LABEL[t.tipo] || t.tipo}</span>
                      <span className="cascata-valor">{brl(t.valor)}</span>
                    </div>
                  ))}
                  <div className="cascata-linha subtotal">
                    <span className="cascata-rotulo">Total no período</span>
                    <span className="cascata-valor">{brl(dados.totalNoPeriodo)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">Lançamentos ({formatQtd(dados.itens.length)})</div>
            {dados.itens.length === 0 ? (
              <EstadoVazio
                Icone={Megaphone}
                titulo="Nenhum gasto lançado no período"
                descricao="Lance aqui a publicidade do mês para ela aparecer descontada no relatório de lucratividade."
                onAcao={() => setAbertoForm(true)}
                acaoLabel="Lançar gasto"
                IconeAcao={Plus}
              />
            ) : (
              <DataTable>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Competência</th>
                      <th>Tipo</th>
                      <th>Descrição</th>
                      <th>Onde</th>
                      <th>Vendedor</th>
                      <th className="num">Lançado</th>
                      <th className="num">Entra no período</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {dados.itens.map((item) => (
                      <tr key={item.id}>
                        <td className="mono">{rotuloMes(item.competencia)}</td>
                        <td><span className="selo tone-neutro">{TIPO_LABEL[item.tipo] || item.tipo}</span></td>
                        <td className="col-truncar">{item.descricao || '—'}</td>
                        <td className="col-truncar">{item.canal || '—'}</td>
                        <td className="col-truncar">{item.vendedor_nome || <span className="ink-faint">operação</span>}</td>
                        <td className="num">{brl(item.valor)}</td>
                        <td className="num">
                          {brl(item.valorNoPeriodo)}
                          {item.rateada && (
                            <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>
                              {item.diasNoPeriodo} de {item.diasDoMes} dias
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button type="button" className="btn-icone" onClick={() => editar(item)} title="Editar">
                            <Pencil size={14} />
                          </button>
                          <button type="button" className="icon-btn" onClick={() => excluir(item)} title="Excluir">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}
          </div>
        </>
      )}
    </div>
  );
}
