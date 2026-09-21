import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Sparkles, RefreshCw, ChevronDown, ChevronRight, Info, ShoppingCart, Factory,
  CalendarClock, CheckCircle2, HelpCircle, X, TriangleAlert, Check, Ban, Save,
  CalendarHeart, History, Wand2, Plus, ExternalLink,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, Select, NumInput, Paginacao, DateInput } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoTresMeses } from '../lib/periodos';
import { formatQtd, plural, dataBr } from '../lib/format';
import { useTabela } from '../lib/useTabela';
import { confirmar } from '../components/ConfirmDialog';
import FotoProduto from '../components/FotoProduto';

// Produção › Planejamento — o sistema sugere, você aprova (21/09/2026).
//
// ---------------------------------------------------------------------------
// A ideia
// ---------------------------------------------------------------------------
// Cobertura diz QUANTO FALTA. Matéria-Prima diz QUANTO TECIDO. Esta tela
// junta as duas e dá o passo que faltava: prevê a venda das próximas semanas
// (com a sazonalidade da referência e as datas duplas), monta a OP com grade
// cor × tamanho pronta, confere o insumo, e encadeia a compra de tecido que
// essa OP puxa. Tudo aparece como SUGESTÃO, com a conta escrita, e vira OP ou
// pedido de compra de verdade só quando alguém aprova.
//
// O que a tela NÃO faz: recalcular. A quantidade sai da mesma fórmula da
// Cobertura, a grade da mesma Curva de Tamanho, o tecido da mesma
// Matéria-Prima. "Como esta tela calcula", no fim, mostra a cadeia.
//
// Padrão visual: o mesmo da Matéria-Prima que a dona aprovou — indicadores no
// alto, lista compacta que abre, o que exige ação em painel com contador, e
// a explicação longa atrás de um botão.

const ROTA = '/planejamento';
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function q(v, casas = 0) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
const fator = (f) => (f == null ? '—' : `×${Number(f).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function Swatch({ hex, cor }) {
  if (!hex) return <span className="pe-swatch pe-swatch-vazio" title={`${cor} — sem cor de tela cadastrada`} />;
  const nome = String(cor || '').toUpperCase();
  const estilo = nome.includes('MESCLA')
    ? { backgroundImage: `repeating-linear-gradient(45deg, ${hex} 0 2px, ${hex}99 2px 4px)` }
    : { background: hex };
  return <span className="pe-swatch" style={estilo} title={`${cor} ${hex}`} />;
}

const URGENCIAS = {
  atrasada: { rotulo: 'Já vai faltar', Icone: CalendarClock, classe: 'pl-urg-atrasada' },
  agora: { rotulo: 'Produzir agora', Icone: Factory, classe: 'pl-urg-agora' },
  programar: { rotulo: 'Programar', Icone: CheckCircle2, classe: 'pl-urg-programar' },
};
const URGENCIAS_COMPRA = {
  atrasada: { ...URGENCIAS.atrasada, rotulo: 'Chega tarde' },
  agora: { ...URGENCIAS.agora, rotulo: 'Comprar agora', Icone: ShoppingCart },
  programar: { ...URGENCIAS.programar, rotulo: 'Programar' },
};
function Urgencia({ chave, compra }) {
  const tabela = compra ? URGENCIAS_COMPRA : URGENCIAS;
  const u = tabela[chave] || tabela.programar;
  const { Icone } = u;
  return <span className={`pl-urg ${u.classe}`}><Icone size={12} />{u.rotulo}</span>;
}

// ---------------------------------------------------------------------------
// A grade editável da OP sugerida
// ---------------------------------------------------------------------------
function GradeEditavel({ grade, cores, onChange, somente }) {
  const tamanhos = useMemo(() => {
    const vistos = [];
    for (const g of grade) if (!vistos.includes(g.tamanho)) vistos.push(g.tamanho);
    return vistos;
  }, [grade]);
  const linhasCor = useMemo(() => {
    const vistos = [];
    for (const g of grade) if (!vistos.includes(g.cor)) vistos.push(g.cor);
    return vistos;
  }, [grade]);
  const valor = (cor, t) => grade.find((g) => g.cor === cor && g.tamanho === t)?.quantidade_planejada ?? 0;
  const mudar = (cor, t, n) => {
    const nova = grade.filter((g) => !(g.cor === cor && g.tamanho === t));
    const qtd = Math.max(0, Math.round(Number(n) || 0));
    if (qtd > 0) nova.push({ cor, tamanho: t, quantidade_planejada: qtd });
    onChange(nova);
  };
  const total = grade.reduce((s, g) => s + g.quantidade_planejada, 0);
  return (
    <table className="mp-tab pl-grade">
      <thead>
        <tr><th>Cor</th>{tamanhos.map((t) => <th key={t}>{t}</th>)}<th>Total</th></tr>
      </thead>
      <tbody>
        {linhasCor.map((cor) => {
          const hex = cores.find((c) => c.cor === cor)?.hex || null;
          const totalCor = grade.filter((g) => g.cor === cor).reduce((s, g) => s + g.quantidade_planejada, 0);
          return (
            <tr key={cor}>
              <td><Swatch hex={hex} cor={cor} />{cor}</td>
              {tamanhos.map((t) => (
                <td key={t}>
                  {somente
                    ? (valor(cor, t) || <span className="mp-vazio">·</span>)
                    : <NumInput className="pl-cel" step="1" min={0} value={valor(cor, t)} onChange={(n) => mudar(cor, t, n)} />}
                </td>
              ))}
              <td>{totalCor}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          {tamanhos.map((t) => <td key={t}>{grade.filter((g) => g.tamanho === t).reduce((s, g) => s + g.quantidade_planejada, 0)}</td>)}
          <td>{total}</td>
        </tr>
      </tfoot>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Uma sugestão de OP
// ---------------------------------------------------------------------------
function SugestaoOp({ s, aberta, onAlternar, faccoes, onDecidir }) {
  const d = s.dados || {};
  const gradeOriginal = d.grade?.grade || [];
  const [grade, setGrade] = useState(d.editado?.grade || gradeOriginal);
  const [faccao, setFaccao] = useState(d.editado?.fornecedor_id || '');
  const [dataPrevista, setDataPrevista] = useState(d.editado?.data_prevista || d.quantidade?.dataPrevista || '');
  const [recusando, setRecusando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);

  const total = grade.reduce((t, g) => t + g.quantidade_planejada, 0);
  const editada = JSON.stringify(grade) !== JSON.stringify(gradeOriginal);
  const cores = (d.grade?.porCor || []).map((c) => ({ cor: c.cor, hex: c.hex || null }));
  const ins = d.insumo || {};
  const hz = d.horizonte || {};
  const qd = d.quantidade || {};
  const saz = d.sazonalidade?.escolhida || {};

  const aprovar = async (situacao) => {
    setOcupado(true); setErro(null);
    try {
      const body = { situacao, grade, fornecedor_id: faccao || null, data_prevista: dataPrevista || null };
      try {
        await api.post(`${ROTA}/sugestoes/${s.id}/aprovar`, body);
      } catch (e) {
        if (e.data?.exige === 'aceitar_ficha_incompleta') {
          const ok = await confirmar(
            `${e.message} Abrir a OP mesmo assim? O material desses tamanhos vai ficar de fora da reserva.`,
            { titulo: 'Ficha incompleta', confirmarTexto: 'Abrir mesmo assim', perigo: false }
          );
          if (!ok) return;
          await api.post(`${ROTA}/sugestoes/${s.id}/aprovar`, { ...body, aceitar_ficha_incompleta: true });
        } else throw e;
      }
      onDecidir();
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  const recusar = async () => {
    if (!motivo.trim()) { setErro('Diga o motivo — é o que ensina o sistema.'); return; }
    setOcupado(true); setErro(null);
    try { await api.post(`${ROTA}/sugestoes/${s.id}/recusar`, { motivo }); onDecidir(); } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };

  return (
    <div className={`mp-ref ${aberta ? 'mp-ref-aberta' : ''}`}>
      <button type="button" className="mp-ref-topo pl-topo" onClick={onAlternar}>
        {aberta ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="pl-id">
          <FotoProduto produtoId={s.produto_id} temFoto={s.tem_foto} url={d.fotoUrl} urlBase={`${ROTA}/produtos`} size={34} alt={s.referencia} />
          <span className="mp-ref-id"><b>{s.referencia}</b><span>{s.descricao}</span></span>
        </span>
        <Urgencia chave={s.urgencia} />
        <span className="mp-ref-num"><b>{formatQtd(total)}</b><span>peças</span></span>
        <span className="mp-ref-num" title={`Fator sazonal médio do horizonte de ${hz.dias} dias`}>
          <b className={hz.fator > 1.05 ? 'pl-alta' : (hz.fator < 0.95 ? 'pl-baixa' : '')}>{fator(hz.fator)}</b><span>estação</span>
        </span>
        <span className="mp-ref-num"><b>{q(d.cobertura?.posicao)}</b><span>tenho</span></span>
        <span className="pl-insumo">
          {ins.conferido === false ? <span className="mp-selo mp-selo-neutro" title={ins.motivo}>insumo ?</span>
            : ins.materialSuficiente ? <span className="mp-selo mp-selo-confirmada">tecido ok</span>
              : <span className="mp-selo mp-selo-pendente" title={(ins.faltas || []).map((f) => `${f.insumo}: falta ${q(f.falta, 1)} ${f.unidade}`).join(' · ')}>falta {plural((ins.faltas || []).length, 'insumo')}</span>}
        </span>
      </button>

      {aberta && (
        <div className="mp-ref-corpo pl-corpo">
          <div className="pl-porque">
            <div className="pl-conta">
              <span className="pl-conta-passo"><small>vende</small><b>{q(qd.demandaMedida, 2)}</b> pç/dia</span>
              <span className="pl-conta-op">×</span>
              <span className="pl-conta-passo"><small>estação</small><b>{fator(qd.fatorAplicado)}</b></span>
              <span className="pl-conta-op">=</span>
              <span className="pl-conta-passo"><small>vai vender</small><b>{q(qd.demandaAjustada, 2)}</b> pç/dia</span>
              <span className="pl-conta-op">×</span>
              <span className="pl-conta-passo"><small>ciclo</small><b>{qd.cicloDias}</b> dias</span>
              <span className="pl-conta-op">=</span>
              <span className="pl-conta-passo"><small>preciso</small><b>{q(qd.alvo)}</b></span>
              <span className="pl-conta-op">−</span>
              <span className="pl-conta-passo"><small>tenho</small><b>{q(qd.posicao)}</b></span>
              <span className="pl-conta-op">=</span>
              <span className="pl-conta-passo pl-conta-final"><small>produzir</small><b>{q(qd.pecas)}</b></span>
            </div>
            <div className="pl-detalhes">
              <span>
                <CalendarHeart size={12} /> Sazonalidade de <b>{saz.rotuloNivel || saz.nivel}</b>
                {hz.meses?.length > 0 && <>: {hz.meses.map((m) => `${MESES[m.mes - 1]} ${fator(m.fator)}${m.manual ? ' (manual)' : ''}`).join(' · ')}</>}
                {hz.eventos?.length > 0 && <> · eventos: {hz.eventos.map((e) => `${e.nome} (${e.dias} d)`).join(', ')}</>}
                {hz.eventosSemFator?.length > 0 && <span className="pl-aviso"> · {hz.eventosSemFator.join(', ')} caem no horizonte mas estão sem fator</span>}
              </span>
              <span>
                Tenho = {q(d.cobertura?.saldo)} no galpão + <span className="mp-prod">{q(d.cobertura?.emProducao)}</span> na facção
                {d.cobertura?.reservado > 0 && <> − {q(d.cobertura.reservado)} já vendidas</>}
                {' '}· cadência {d.cobertura?.cadencia} · prazo {d.cobertura?.leadDias ?? '—'} d · ponto de pedido {q(qd.pontoDePedido)}
                {qd.pedirAte?.explicacao && <> · {qd.pedirAte.explicacao}</>}
              </span>
              <span>
                Grade pela participação de cor na venda ({(d.grade?.porCor || []).map((c) => `${c.cor} ${Math.round(c.participacao * 100)}%`).join(', ')})
                {d.grade?.curva && <> e curva de tamanho de <b>{d.grade.curva.rotuloNivel || d.grade.curva.nivel}</b> ({d.grade.curva.itens.map((i) => `${i.tamanho} ${Math.round(i.participacao * 100)}%`).join(' · ')})</>}
              </span>
              {(d.grade?.ressalvas || []).map((r) => <span key={r} className="pl-aviso"><TriangleAlert size={12} /> {r}</span>)}
              {ins.conferido && !ins.materialSuficiente && (
                <span className="pl-aviso"><TriangleAlert size={12} /> Insumo no galpão não cobre: {(ins.faltas || []).map((f) => `${f.insumo} falta ${q(f.falta, 1)} ${f.unidade}`).join(' · ')}. A OP pode abrir — a compra do tecido está na aba ao lado.</span>
              )}
              {ins.fichaIncompleta && <span className="pl-aviso"><TriangleAlert size={12} /> A ficha desta referência tem tamanho sem consumo cadastrado.</span>}
            </div>
          </div>

          <div className="pl-grade-wrap">
            <div className="pl-grade-topo">
              <h4><Factory size={13} /> Grade da OP {editada && <span className="mp-selo mp-selo-sugerida">editada</span>}</h4>
              {editada && <button type="button" className="btn-sec btn-mini" onClick={() => setGrade(gradeOriginal)}><Wand2 size={12} /> Voltar à sugerida</button>}
            </div>
            <GradeEditavel grade={grade} cores={cores} onChange={setGrade} />
          </div>

          <div className="pl-acoes">
            <div className="mp-param">
              <label>Facção</label>
              <Select value={faccao} onChange={(e) => setFaccao(e.target.value)} chaveRecentes="pl_faccao">
                <option value="">— decidir depois —</option>
                {faccoes.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </Select>
            </div>
            <div className="mp-param">
              <label>Chega em</label>
              <DateInput value={dataPrevista} onChange={(e) => setDataPrevista(e.target.value)} />
            </div>
            <span style={{ flex: 1 }} />
            {!recusando ? (
              <>
                <button type="button" className="btn-sec" disabled={ocupado} onClick={() => setRecusando(true)}><Ban size={14} /> Recusar</button>
                <button type="button" className="btn-sec" disabled={ocupado || total <= 0} onClick={() => aprovar('rascunho')}><Save size={14} /> Abrir como rascunho</button>
                <button type="button" className="btn btn-primary" disabled={ocupado || total <= 0} onClick={() => aprovar('planejada')}><Check size={14} /> {ocupado ? 'Abrindo…' : `Aprovar · abrir OP de ${total} pç`}</button>
              </>
            ) : (
              <>
                <input className="pl-motivo" placeholder="Por que não? (ex.: coleção sai de linha, tecido não chega)" value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus />
                <button type="button" className="btn-sec" onClick={() => { setRecusando(false); setMotivo(''); }}>Cancelar</button>
                <button type="button" className="btn btn-primary" disabled={ocupado} onClick={recusar}><Ban size={14} /> Confirmar recusa</button>
              </>
            )}
          </div>
          {erro && <p className="erro-inline">{erro}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// As compras de tecido
// ---------------------------------------------------------------------------
function Compras({ compras, fornecedores, onDecidir }) {
  const [abertas, setAbertas] = useState(() => new Set());
  const [form, setForm] = useState({});
  const [ocupado, setOcupado] = useState(null);
  const [erro, setErro] = useState({});
  const [recusando, setRecusando] = useState({});

  const alternar = (id) => { const n = new Set(abertas); n.has(id) ? n.delete(id) : n.add(id); setAbertas(n); };
  const f = (id, campo, padrao) => (form[id]?.[campo] !== undefined ? form[id][campo] : padrao);
  const muda = (id, campo, v) => setForm({ ...form, [id]: { ...(form[id] || {}), [campo]: v } });

  const aprovar = async (s) => {
    setOcupado(s.id); setErro({ ...erro, [s.id]: null });
    try {
      await api.post(`${ROTA}/sugestoes/${s.id}/aprovar`, {
        fornecedor_id: f(s.id, 'fornecedor', s.fornecedor_id || '') || null,
        quantidade: f(s.id, 'quantidade', Number(s.quantidade)),
        valor_unitario: f(s.id, 'valor', s.dados?.custoAtual ?? ''),
        previsao_entrega: f(s.id, 'previsao', '') || null,
      });
      onDecidir();
    } catch (e) { setErro({ ...erro, [s.id]: e.message }); } finally { setOcupado(null); }
  };
  const recusar = async (s) => {
    const motivo = (recusando[s.id] || '').trim();
    if (!motivo) { setErro({ ...erro, [s.id]: 'Diga o motivo.' }); return; }
    setOcupado(s.id);
    try { await api.post(`${ROTA}/sugestoes/${s.id}/recusar`, { motivo }); onDecidir(); } catch (e) { setErro({ ...erro, [s.id]: e.message }); } finally { setOcupado(null); }
  };

  if (compras.length === 0) {
    return <EstadoVazio Icone={ShoppingCart} titulo="Nenhuma compra de tecido pendente" descricao="As OPs sugeridas estão cobertas pelo tecido que existe, ou ainda não há sugestão gerada." />;
  }

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="mp-tecido-topo">
        <ShoppingCart size={14} />
        <h4>Comprar por tecido</h4>
        <span style={{ fontSize: 12, opacity: .8 }}>o que as OPs sugeridas puxam, somado por rolo — aprovar gera o pedido em rascunho para Compras</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="mp-tecido-tab">
          <thead>
            <tr><th style={{ width: 18 }} /><th>Tecido</th><th>Cor</th><th>Preciso</th><th>Tenho</th><th>Comprar</th><th>Fornecedor</th><th style={{ textAlign: 'left' }}>Situação</th></tr>
          </thead>
          <tbody>
            {compras.map((s) => {
              const d = s.dados || {};
              const ab = abertas.has(s.id);
              return (
                <FragmentoCompra key={s.id}>
                  <tr className="pl-linha-clicavel" onClick={() => alternar(s.id)}>
                    <td>{ab ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td><b>{s.insumo_nome || d.insumo}</b></td>
                    <td>{s.cor_insumo || <span className="mp-selo mp-selo-pendente">sem cor</span>}</td>
                    <td>{q(d.necessidade, 1)} {s.unidade}</td>
                    <td>{d.saldo == null ? <span className="mp-vazio" title="saldo desta cor não informado">—</span> : `${q(d.saldo, 1)}${d.emCompras > 0 ? ` +${q(d.emCompras, 1)}` : ''}`}</td>
                    <td><b className="mp-falta-n">{q(s.quantidade, 1)}</b> {s.unidade}{d.pedido?.arredondado && <small className="ink-soft" title={`arredondado em múltiplos da barca de ${d.pedido.barcaUsada}`}> (barca)</small>}</td>
                    <td>{s.fornecedor_nome || <span className="mp-selo mp-selo-pendente">escolher</span>}</td>
                    <td style={{ textAlign: 'left' }}><Urgencia chave={s.urgencia} compra /></td>
                  </tr>
                  {ab && (
                    <tr>
                      <td colSpan={8} className="mp-contrib">
                        <div style={{ marginBottom: 8 }}>
                          {(d.contribuintes || []).map((c, i) => (
                            <span key={`${c.produtoId}-${c.corProduto}`}>{i > 0 && ' · '}<b>{c.referencia}</b> {c.corProduto}: {formatQtd(c.pecas)} pç × {q(c.consumoPorPeca, 3)}{d.perdaNaoCadastrada ? '' : ' (+ perda de corte)'} = {q(c.necessidade, 1)} {s.unidade}</span>
                          ))}
                          {d.unidadeNaoConfirmada && <div style={{ marginTop: 6, color: 'var(--warning)' }}><TriangleAlert size={12} /> A unidade deste tecido ainda não foi confirmada (metro ou quilo muda o resultado por três vezes).</div>}
                          {d.perdaNaoCadastrada && <div style={{ marginTop: 4 }}>Sem perda de corte cadastrada: o número está <b>baixo</b>.</div>}
                        </div>
                        <div className="pl-acoes" onClick={(e) => e.stopPropagation()}>
                          <div className="mp-param">
                            <label>Fornecedor</label>
                            <Select value={f(s.id, 'fornecedor', s.fornecedor_id || '')} onChange={(e) => muda(s.id, 'fornecedor', e.target.value)} chaveRecentes="pl_fornecedor">
                              <option value="">— escolher —</option>
                              {fornecedores.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}
                            </Select>
                          </div>
                          <div className="mp-param"><label>Quantidade ({s.unidade})</label><NumInput step="0.01" min={0} value={f(s.id, 'quantidade', Number(s.quantidade))} onChange={(n) => muda(s.id, 'quantidade', n)} /></div>
                          <div className="mp-param"><label>Valor unitário</label><NumInput step="0.01" min={0} value={f(s.id, 'valor', d.custoAtual ?? '')} onChange={(n) => muda(s.id, 'valor', n ?? '')} /></div>
                          <div className="mp-param"><label>Previsão de entrega</label><DateInput value={f(s.id, 'previsao', '')} onChange={(e) => muda(s.id, 'previsao', e.target.value)} /></div>
                          <span style={{ flex: 1 }} />
                          {recusando[s.id] === undefined ? (
                            <>
                              <button type="button" className="btn-sec" onClick={() => setRecusando({ ...recusando, [s.id]: '' })}><Ban size={14} /> Recusar</button>
                              <button type="button" className="btn btn-primary" disabled={ocupado === s.id} onClick={() => aprovar(s)}><Check size={14} /> {ocupado === s.id ? 'Gerando…' : 'Aprovar · gerar pedido'}</button>
                            </>
                          ) : (
                            <>
                              <input className="pl-motivo" placeholder="Por que não?" value={recusando[s.id]} onChange={(e) => setRecusando({ ...recusando, [s.id]: e.target.value })} autoFocus />
                              <button type="button" className="btn-sec" onClick={() => { const r = { ...recusando }; delete r[s.id]; setRecusando(r); }}>Cancelar</button>
                              <button type="button" className="btn btn-primary" disabled={ocupado === s.id} onClick={() => recusar(s)}><Ban size={14} /> Confirmar recusa</button>
                            </>
                          )}
                        </div>
                        {erro[s.id] && <p className="erro-inline">{erro[s.id]}</p>}
                      </td>
                    </tr>
                  )}
                </FragmentoCompra>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function FragmentoCompra({ children }) { return <>{children}</>; }

// ---------------------------------------------------------------------------
// Sazonalidade e datas duplas
// ---------------------------------------------------------------------------
function Sazonalidade() {
  const [dados, setDados] = useState(null);
  const [eventos, setEventos] = useState([]);
  const [manuais, setManuais] = useState({});
  const [sujo, setSujo] = useState(false);
  const [novo, setNovo] = useState(null);
  const [erro, setErro] = useState(null);

  const carregar = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([api.get(`${ROTA}/sazonalidade`), api.get(`${ROTA}/eventos`)]);
      setDados(s); setEventos(e); setManuais(s.manuaisGeral || {}); setSujo(false);
    } catch (x) { setErro(x.message); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const salvarManuais = async () => {
    try { await api.put(`${ROTA}/sazonalidade/geral`, { fatores: manuais }); await carregar(); } catch (x) { setErro(x.message); }
  };
  const salvarEvento = async (ev, campos) => {
    try { await api.put(`${ROTA}/eventos/${ev.id}`, campos); await carregar(); } catch (x) { setErro(x.message); }
  };
  const criarEvento = async () => {
    try { await api.post(`${ROTA}/eventos`, novo); setNovo(null); await carregar(); } catch (x) { setErro(x.message); }
  };
  const desativar = async (ev) => {
    if (!(await confirmar(`Desativar "${ev.nome}"? Ele deixa de entrar na conta; o cadastro fica guardado.`, { titulo: 'Desativar evento', confirmarTexto: 'Desativar' }))) return;
    try { await api.del(`${ROTA}/eventos/${ev.id}`); await carregar(); } catch (x) { setErro(x.message); }
  };

  if (!dados) return <Skeleton height={120} radius={10} />;
  const g = dados.geral;
  const max = Math.max(...Object.values(g.fatores || {}).map(Number), 1.2);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <section className="card pl-saz">
        <div className="pl-saz-topo">
          <h4><CalendarHeart size={14} /> Sazonalidade do catálogo</h4>
          <span className="ink-soft" style={{ fontSize: 12 }}>
            {g.ok
              ? `Calculada sobre ${g.meses} meses fechados (${formatQtd(g.pecas)} peças). Cada referência usa a dela quando tem histórico; senão a da categoria; senão esta.`
              : `Sem índice calculado: ${g.motivo}. Enquanto isso, os meses valem 1 — ou o que você definir à mão abaixo.`}
          </span>
        </div>
        <div className="pl-meses">
          {MESES.map((nome, i) => {
            const m = i + 1;
            const calc = Number(g.fatores?.[m] ?? 1);
            const manual = manuais[m];
            const efetivo = manual != null && manual !== '' ? Number(manual) : calc;
            return (
              <div key={m} className={`pl-mes ${manual != null && manual !== '' ? 'pl-mes-manual' : ''}`}>
                <div className="pl-mes-barra"><i style={{ height: `${Math.min(100, (efetivo / max) * 100)}%` }} /></div>
                <b>{fator(efetivo)}</b>
                <span>{nome}</span>
                <NumInput step="0.01" min={0} placeholder={q(calc, 2)} value={manual ?? ''} onChange={(n) => { setManuais({ ...manuais, [m]: n ?? null }); setSujo(true); }} />
              </div>
            );
          })}
        </div>
        <div className="pl-saz-rodape">
          <span className="ink-soft" style={{ fontSize: 12 }}>Digite um fator para sobrescrever o calculado do mês (vale para o catálogo inteiro; a referência com histórico próprio continua usando o dela). Apague para voltar ao calculado.</span>
          {sujo && <button type="button" className="btn btn-primary btn-mini" onClick={salvarManuais}><Save size={13} /> Salvar meses</button>}
        </div>
        {(g.ressalvas || []).map((r) => <p key={r} className="mp-nota"><Info size={13} /><span>{r}</span></p>)}
      </section>

      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="mp-tecido-topo">
          <CalendarClock size={14} />
          <h4>Datas duplas e datas fortes</h4>
          <span style={{ fontSize: 12, opacity: .8 }}>a venda sobe ANTES da data — a janela é o período de venda</span>
          <div className="mp-acoes">
            <button type="button" className="btn-sec btn-mini" onClick={() => setNovo({ nome: '', inicio_mes: 11, inicio_dia: 1, fim_mes: 11, fim_dia: 11, fator: '' })}><Plus size={13} /> Nova data</button>
          </div>
        </div>
        <table className="mp-tecido-tab">
          <thead><tr><th>Evento</th><th>Janela de venda</th><th>Ano passado</th><th>Fator</th><th>Categoria</th><th /></tr></thead>
          <tbody>
            {novo && (
              <tr className="pl-nova">
                <td><input placeholder="Nome" value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} /></td>
                <td className="pl-janela-edit">
                  <NumInput step="1" min={1} value={novo.inicio_dia} onChange={(n) => setNovo({ ...novo, inicio_dia: n })} />/<NumInput step="1" min={1} value={novo.inicio_mes} onChange={(n) => setNovo({ ...novo, inicio_mes: n })} />
                  {' até '}
                  <NumInput step="1" min={1} value={novo.fim_dia} onChange={(n) => setNovo({ ...novo, fim_dia: n })} />/<NumInput step="1" min={1} value={novo.fim_mes} onChange={(n) => setNovo({ ...novo, fim_mes: n })} />
                </td>
                <td>—</td>
                <td><NumInput step="0.01" min={0} placeholder="1,00" value={novo.fator} onChange={(n) => setNovo({ ...novo, fator: n ?? '' })} /></td>
                <td><input placeholder="todas" value={novo.categoria || ''} onChange={(e) => setNovo({ ...novo, categoria: e.target.value })} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn-sec btn-mini" onClick={() => setNovo(null)}>Cancelar</button>{' '}
                  <button type="button" className="btn btn-primary btn-mini" onClick={criarEvento}><Save size={12} /> Salvar</button>
                </td>
              </tr>
            )}
            {eventos.map((ev) => <LinhaEvento key={ev.id} ev={ev} onSalvar={salvarEvento} onDesativar={desativar} />)}
          </tbody>
        </table>
        <p className="mp-nota" style={{ padding: '0 14px 12px' }}>
          <Info size={13} />
          <span>O fator multiplica a demanda dos dias da janela (1,40 = 40% a mais). <b>Evento sem fator não entra na conta</b> — a coluna "ano passado" mostra quanto a venda subiu naquela janela contra os 60 dias anteriores, para você decidir com base.</span>
        </p>
      </section>
    </div>
  );
}

function LinhaEvento({ ev, onSalvar, onDesativar }) {
  const [f, setF] = useState(ev.fator ?? '');
  const [cat, setCat] = useState(ev.categoria || '');
  useEffect(() => { setF(ev.fator ?? ''); setCat(ev.categoria || ''); }, [ev]);
  const sujo = String(f) !== String(ev.fator ?? '') || cat !== (ev.categoria || '');
  const r = ev.reforcoAnoPassado;
  return (
    <tr style={{ opacity: ev.ativo ? 1 : .5 }}>
      <td><b>{ev.nome}</b>{!ev.ativo && <span className="mp-selo mp-selo-neutro" style={{ marginLeft: 6 }}>inativo</span>}<br /><small className="ink-soft">{ev.observacao}</small></td>
      <td>{String(ev.inicio_dia).padStart(2, '0')}/{MESES[ev.inicio_mes - 1]} até {String(ev.fim_dia).padStart(2, '0')}/{MESES[ev.fim_mes - 1]}</td>
      <td>
        {r?.fatorObservado != null
          ? <span title={`${r.diasNaJanela} dias na janela de ${r.ano}: ${q(r.mediaJanela, 1)} pç/dia contra ${q(r.mediaVizinhanca, 1)} nos 60 dias antes`}>
            <b className={r.fatorObservado > 1.05 ? 'pl-alta' : ''}>{fator(r.fatorObservado)}</b> em {r.ano}
          </span>
          : <span className="mp-vazio" title={r?.motivo || 'sem venda registrada na janela do ano passado'}>—</span>}
      </td>
      <td>
        <NumInput step="0.01" min={0} placeholder="decidir" value={f} onChange={(n) => setF(n ?? '')} />
        {(f === '' || f == null) && <span className="mp-selo mp-selo-pendente" style={{ marginLeft: 6 }} title="Sem fator o evento não entra na conta">sem fator</span>}
      </td>
      <td><input value={cat} placeholder="todas" onChange={(e) => setCat(e.target.value)} style={{ width: 110 }} /></td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {sujo && <button type="button" className="btn btn-primary btn-mini" onClick={() => onSalvar(ev, { fator: f === '' ? null : Number(f), categoria: cat || null })}><Save size={12} /> Salvar</button>}{' '}
        {ev.ativo
          ? <button type="button" className="btn-sec btn-mini" onClick={() => onDesativar(ev)} title="Desativar"><X size={12} /></button>
          : <button type="button" className="btn-sec btn-mini" onClick={() => onSalvar(ev, { ativo: true })}>Reativar</button>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------
function Historico() {
  const [situacao, setSituacao] = useState('aprovada');
  const [dados, setDados] = useState(null);
  useEffect(() => {
    let vivo = true;
    api.get(`${ROTA}?situacao=${situacao}`).then((d) => { if (vivo) setDados(d); });
    return () => { vivo = false; };
  }, [situacao]);
  const itens = dados ? [...dados.ops, ...dados.compras].sort((a, b) => new Date(b.decidida_em || 0) - new Date(a.decidida_em || 0)) : [];
  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="mp-tecido-topo">
        <History size={14} /><h4>Histórico</h4>
        <span className="mp-seg" style={{ marginLeft: 'auto' }}>
          {[['aprovada', 'Aprovadas'], ['recusada', 'Recusadas'], ['substituida', 'Substituídas']].map(([k, r]) => (
            <button key={k} type="button" aria-pressed={situacao === k} onClick={() => setSituacao(k)}>{r}</button>
          ))}
        </span>
      </div>
      {!dados ? <div style={{ padding: 14 }}><Skeleton height={40} /></div> : itens.length === 0 ? (
        <EstadoVazio titulo="Nada aqui ainda" descricao="As sugestões decididas aparecem nesta lista, com o que viraram." />
      ) : (
        <table className="mp-tecido-tab">
          <thead><tr><th>Quando</th><th>Tipo</th><th>O quê</th><th>Quantidade</th><th>Virou</th><th>Quem</th><th>Motivo</th></tr></thead>
          <tbody>
            {itens.map((s) => (
              <tr key={s.id}>
                <td>{s.decidida_em ? dataBr(s.decidida_em.slice(0, 10)) : '—'}</td>
                <td>{s.tipo === 'op' ? 'OP' : 'Compra'}</td>
                <td style={{ textAlign: 'left' }}>{s.tipo === 'op' ? <><b>{s.referencia}</b> {s.descricao}</> : <><b>{s.insumo_nome || s.dados?.insumo}</b> {s.cor_insumo}</>}</td>
                <td>{q(s.quantidade, s.tipo === 'op' ? 0 : 1)} {s.unidade}</td>
                <td>
                  {s.ordem_numero && <a href={`/producao?ordem=${s.ordem_producao_id}`}>OP {s.ordem_numero} <ExternalLink size={11} /></a>}
                  {s.pedido_numero && <a href="/compras/pedidos">Pedido {s.pedido_numero} <ExternalLink size={11} /></a>}
                  {!s.ordem_numero && !s.pedido_numero && '—'}
                </td>
                <td>{s.decidida_por_nome || '—'}</td>
                <td style={{ textAlign: 'left' }}>{s.motivo_recusa || (s.situacao === 'substituida' ? 'a conta mudou numa rodada seguinte' : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
export default function PlanejamentoPage() {
  const [periodo, setPeriodo] = useState(periodoTresMeses);
  const [dados, setDados] = useState(null);
  const [apoio, setApoio] = useState({ fornecedores: [], faccoes: [] });
  const [carregando, setCarregando] = useState(true);
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState(null);
  const [aba, setAba] = useState('produzir');
  const [abertas, setAbertas] = useState(() => new Set());
  const [ajuda, setAjuda] = useState(false);
  const [verSem, setVerSem] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try {
      const [d, a] = await Promise.all([api.get(ROTA), api.get(`${ROTA}/apoio`)]);
      setDados(d); setApoio(a);
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const gerar = async () => {
    setGerando(true); setErro(null);
    try {
      await api.post(`${ROTA}/gerar`, { parametros: { inicio: periodo.inicio, fim: periodo.fim } });
      await carregar();
    } catch (e) { setErro(e.message); } finally { setGerando(false); }
  };

  const tabela = useTabela(dados?.ops || [], {
    colunas: { referencia: (r) => r.referencia, quantidade: (r) => Number(r.quantidade), urgencia: (r) => ({ atrasada: 0, agora: 1, programar: 2 }[r.urgencia] ?? 3) },
    colunaPadrao: 'urgencia', direcaoPadrao: 'asc', prefixo: 'pl',
  });

  const resumo = dados?.lote?.resumo || null;
  const ops = dados?.ops || [];
  const compras = dados?.compras || [];
  const pecas = ops.reduce((s, o) => s + Number(o.quantidade || 0), 0);
  const atrasadas = ops.filter((o) => o.urgencia === 'atrasada').length;
  const alternar = (id) => { const n = new Set(abertas); n.has(id) ? n.delete(id) : n.add(id); setAbertas(n); };

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Sparkles size={20} /> Planejamento</h1>
          <p className="page-sub">O sistema prevê a venda com a estação, monta a OP e a compra de tecido. Você só aprova.</p>
        </div>
        <div className="pagina-acoes mp-barra">
          <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
          <span className="mp-barra-sep" aria-hidden="true" />
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}><RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar</button>
          <button type="button" className="btn btn-primary" onClick={gerar} disabled={gerando} title="Recalcula tudo com a venda do período escolhido. O que já estava sugerido e não mudou é mantido, com suas edições.">
            <Wand2 size={15} className={gerando ? 'girando' : ''} /> {gerando ? 'Gerando…' : 'Gerar sugestões'}
          </button>
        </div>
      </header>

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && !dados && <div style={{ display: 'grid', gap: 10 }}>{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={58} radius={8} />)}</div>}

      {dados && (
        <>
          {dados.lote ? (
            <p className="pl-lote">
              Última rodada <b>{dataBr(String(dados.lote.gerado_em).slice(0, 10))}</b> às {new Date(dados.lote.gerado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })},
              sobre a venda de {dataBr(dados.lote.janela_inicio)} a {dataBr(dados.lote.janela_fim)} · {resumo?.referenciasAvaliadas ?? '—'} referências avaliadas
              {resumo?.substituidas > 0 && <> · {resumo.substituidas} sugestão(ões) anteriores substituídas</>}
              {resumo?.eventosSemFator?.length > 0 && <> · <button type="button" className="pl-link" onClick={() => setAba('sazonalidade')}><TriangleAlert size={12} /> {resumo.eventosSemFator.length} data(s) sem fator decidido</button></>}
            </p>
          ) : (
            <div className="mp-setup">
              <div>
                <h3><Sparkles size={16} color="var(--warning)" /> Nenhuma sugestão gerada ainda</h3>
                <p>Escolha o período de venda que serve de base (3 meses é o padrão das telas de planejamento) e clique em <b>Gerar sugestões</b>. Leva alguns segundos: a tela avalia todas as referências com venda.</p>
              </div>
              <button type="button" className="btn btn-primary" onClick={gerar} disabled={gerando}><Wand2 size={14} /> Gerar agora</button>
            </div>
          )}

          <div className="mp-kpis">
            <div className={`mp-kpi${ops.length > 0 ? ' mp-kpi-alerta' : ' mp-kpi-bom'}`}>
              <span className="mp-kpi-rotulo"><Factory size={12} /> OPs a aprovar</span>
              <strong>{ops.length}</strong>
              <small>{formatQtd(pecas)} peças sugeridas</small>
            </div>
            <div className={`mp-kpi${atrasadas > 0 ? ' mp-kpi-perigo' : ''}`}>
              <span className="mp-kpi-rotulo"><CalendarClock size={12} /> Já vai faltar</span>
              <strong>{atrasadas}</strong>
              <small>o estoque acaba antes de a OP chegar</small>
            </div>
            <div className={`mp-kpi${compras.length > 0 ? ' mp-kpi-alerta' : ''}`}>
              <span className="mp-kpi-rotulo"><ShoppingCart size={12} /> Tecido a comprar</span>
              <strong>{compras.length}</strong>
              <small>{resumo ? `${resumo.tecidosCobertos} tecido(s) já cobertos` : 'rolos que as OPs puxam'}</small>
            </div>
            <button type="button" className={`mp-kpi pl-kpi-btn${resumo?.semSugestao > 0 ? '' : ' mp-kpi-bom'}`} onClick={() => setVerSem(!verSem)}>
              <span className="mp-kpi-rotulo"><HelpCircle size={12} /> Sem sugestão</span>
              <strong>{resumo?.semSugestao ?? '—'}</strong>
              <small>{verSem ? 'fechar a lista' : 'referências avaliadas sem OP — ver por quê'}</small>
            </button>
          </div>

          {verSem && resumo && (
            <section className="card pl-sem">
              <h4><HelpCircle size={14} /> Por que não houve sugestão</h4>
              {resumo.semSugestaoDetalhe?.length === 0 && <p className="ink-soft">Todas as referências avaliadas receberam sugestão ou estão cobertas.</p>}
              <ul>{(resumo.semSugestaoDetalhe || []).map((x) => <li key={x.produto_id}><b>{x.referencia}</b> — {x.motivo}</li>)}</ul>
              {resumo.pendenciasTecido?.semConfiguracao?.length > 0 && <p className="mp-nota"><Info size={13} /><span>Sem tecido configurado na Matéria-Prima (por isso sem compra sugerida): {resumo.pendenciasTecido.semConfiguracao.join(', ')}.</span></p>}
              {resumo.pendenciasTecido?.semDePara?.length > 0 && <p className="mp-nota"><Info size={13} /><span>Cor da peça sem cor do tecido ligada: {resumo.pendenciasTecido.semDePara.join(', ')}.</span></p>}
            </section>
          )}

          <div className="subtab-row">
            <button type="button" className={`subtab-btn ${aba === 'produzir' ? 'active' : ''}`} onClick={() => setAba('produzir')}>Produzir ({ops.length})</button>
            <button type="button" className={`subtab-btn ${aba === 'comprar' ? 'active' : ''}`} onClick={() => setAba('comprar')}>Comprar tecido ({compras.length})</button>
            <button type="button" className={`subtab-btn ${aba === 'sazonalidade' ? 'active' : ''}`} onClick={() => setAba('sazonalidade')}>Estação e datas</button>
            <button type="button" className={`subtab-btn ${aba === 'historico' ? 'active' : ''}`} onClick={() => setAba('historico')}>Histórico</button>
          </div>

          {aba === 'produzir' && (ops.length === 0 ? (
            <EstadoVazio Icone={Factory} titulo="Nenhuma OP para aprovar" descricao={dados.lote ? 'Todas as referências com venda estão acima do ponto de pedido para a estação que vem — ou já foram decididas.' : 'Gere as sugestões para começar.'} />
          ) : (
            <>
              <Paginacao {...tabela} posicao="topo" />
              <div className="mp-lista">
                {tabela.itensPagina.map((s) => (
                  <SugestaoOp key={s.id} s={s} aberta={abertas.has(s.id)} onAlternar={() => alternar(s.id)} faccoes={apoio.faccoes} onDecidir={carregar} />
                ))}
              </div>
              <Paginacao {...tabela} posicao="rodape" />
            </>
          ))}
          {aba === 'comprar' && <Compras compras={compras} fornecedores={apoio.fornecedores} onDecidir={carregar} />}
          {aba === 'sazonalidade' && <Sazonalidade />}
          {aba === 'historico' && <Historico />}

          <div>
            <button type="button" className="mp-ajuda-btn" onClick={() => setAjuda(!ajuda)}>{ajuda ? <X size={13} /> : <Info size={13} />} Como esta tela calcula</button>
            {ajuda && (
              <div className="mp-ajuda" style={{ marginTop: 8 }}>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li><b>Quanto produzir:</b> a mesma fórmula da Cobertura — <code>venda/dia × (prazo + segurança + intervalo) − posição de estoque</code> — com a venda/dia multiplicada pelo <b>fator sazonal médio do horizonte</b> (os dias entre hoje e o fim do ciclo). Só entra quem está no ponto de pedido — o da Cobertura ou o da demanda ajustada, o que for MAIOR: a estação pode antecipar uma referência, nunca tirar da lista uma que já precisa.</li>
                  <li><b>Sazonalidade:</b> índice de cada mês = média de peças daquele mês nos anos disponíveis ÷ média geral, sobre até 36 meses fechados. Precisa de 12 meses e 120 peças; senão sobe para a categoria, depois para o catálogo. Fator manual, quando existe, vence o calculado. Contido entre 0,3× e 3×.</li>
                  <li><b>Datas duplas:</b> multiplicam a demanda dos dias da janela. Evento sem fator não entra — a tela mostra o reforço observado no ano anterior para ajudar a decidir.</li>
                  <li><b>Grade:</b> peças por cor pela participação de cada cor na venda por variante da janela (kit não tem cor e fica de fora); por tamanho pela Curva de Tamanho da referência (ou da categoria/catálogo quando falta histórico), fechando exato no lote. Cor de segunda qualidade (LD) nunca recebe peça.</li>
                  <li><b>Insumo:</b> a mesma prévia da Nova Ordem — explode a ficha e compara com o saldo próprio. Falta de insumo não trava a OP; vira compra sugerida.</li>
                  <li><b>Compra de tecido:</b> a mesma conta da Matéria-Prima — peças por cor × consumo × (1 + perda), somada por (tecido, cor do tecido), menos saldo e o que já está em compras, arredondada na barca. Aprovar gera o pedido em <b>rascunho</b> em Compras e soma a quantidade em "a caminho" da referência.</li>
                  <li><b>Aprovar a OP</b> abre a ordem como <b>planejada</b> (ou rascunho) pelo mesmo caminho da Nova Ordem, com o evento no Calendário. A sugestão fica no histórico com a OP que virou.</li>
                  <li><b>Gerar de novo</b> mantém as sugestões cuja conta não mudou (com o que você editou) e marca as demais como substituídas. Nada é apagado.</li>
                  {(resumo?.avisos || []).map((a) => <li key={a}>{a}</li>)}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
