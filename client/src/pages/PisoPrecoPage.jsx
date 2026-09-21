import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, RefreshCw, TriangleAlert, Info, X, Calculator, Users, SlidersHorizontal,
  Plus, Save, Trash2, Search, ChevronDown, ChevronRight, ExternalLink, CheckCircle2, Ban, ArrowDownRight, ArrowUpRight, ScrollText,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, Select, NumInput, Paginacao, CampoBusca, MultiSelect } from '../components/ui';
import { brl, formatQtd, dataBr, plural } from '../lib/format';
import { useTabela } from '../lib/useTabela';
import { confirmar } from '../components/ConfirmDialog';
import { SeloPlataforma } from '../lib/canalMarketplace';

// Marketplace › Catálogo › Piso de Preço (21/09/2026) — frente 2.
//
// Quatro abas, uma pergunta cada:
//   Auditoria    — qual anúncio no ar está abaixo do piso do canal dele, e
//                  quanto isso custa por mês?
//   Simular      — se eu entrar nesta campanha, quanto sobra por peça e
//                  quantas peças a mais preciso vender para empatar?
//   Concorrentes — quanto o concorrente cobra pela mesma peça, e quanto o
//                  Mercado Livre pede para eu ganhar a vitrine do catálogo?
//   Regras       — a margem mínima por canal, classe ou referência.
//
// A trava em si (o preço do anúncio e a promoção) mora nas telas de Anúncios
// e Promoções: quando o preço fica abaixo do piso, elas pedem o motivo. Aqui
// é onde se vê o piso, se ajusta a regra e se mede o estrago.

const ROTA = '/preco-regra';
const CANAIS = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein' };
const pct = (v, casas = 1) => (v == null ? '—' : `${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`);
const money = (v) => (v == null ? '—' : brl(Number(v)));

const SITUACOES = {
  prejuizo: { rotulo: 'Prejuízo', classe: 'pl-urg-atrasada', Icone: TriangleAlert },
  abaixo: { rotulo: 'Abaixo do piso', classe: 'pl-urg-agora', Icone: ArrowDownRight },
  no_limite: { rotulo: 'No limite', classe: 'pl-urg-programar', Icone: Info },
  ok: { rotulo: 'Acima do piso', classe: 'pp-ok', Icone: CheckCircle2 },
  sem_piso: { rotulo: 'Sem piso', classe: 'pp-sem', Icone: Ban },
};
function Situacao({ chave }) {
  const s = SITUACOES[chave] || SITUACOES.sem_piso;
  const { Icone } = s;
  return <span className={`pl-urg ${s.classe}`}><Icone size={12} />{s.rotulo}</span>;
}
function Canal({ chave }) {
  return <span className="pp-canal"><SeloPlataforma chave={chave} size={14} /> {CANAIS[chave] || chave}</span>;
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
function Auditoria({ lojas }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [filtroSit, setFiltroSit] = useState(['prejuizo', 'abaixo', 'no_limite']);
  const [busca, setBusca] = useState('');
  const [canal, setCanal] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try {
      const qs = new URLSearchParams(); if (canal) qs.set('marketplace', canal);
      setDados(await api.get(`${ROTA}/auditoria?${qs}`));
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, [canal]);
  useEffect(() => { carregar(); }, [carregar]);

  const linhas = useMemo(() => (dados?.linhas || []).filter((l) => (filtroSit.length === 0 || filtroSit.includes(l.situacao))
    && (!busca || `${l.titulo} ${l.referencia || ''} ${l.anuncio_id_externo}`.toLowerCase().includes(busca.toLowerCase()))), [dados, filtroSit, busca]);
  const tabela = useTabela(linhas, {
    colunas: { titulo: (r) => r.titulo, preco: (r) => Number(r.preco || 0), piso: (r) => Number(r.piso || 0), margem: (r) => Number(r.margem ?? -9), perda: (r) => Number(r.perda_30d || 0), situacao: (r) => ({ prejuizo: 0, abaixo: 1, no_limite: 2, ok: 3, sem_piso: 4 }[r.situacao]) },
    colunaPadrao: 'perda', direcaoPadrao: 'desc', prefixo: 'pp-aud',
  });
  const t = dados?.totais;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      {t && (
        <div className="mp-kpis">
          <div className={`mp-kpi${t.prejuizo > 0 ? ' mp-kpi-perigo' : ''}`}><span className="mp-kpi-rotulo"><TriangleAlert size={12} /> Com prejuízo</span><strong>{t.prejuizo}</strong><small>anúncios no ar vendendo abaixo do custo</small></div>
          <div className={`mp-kpi${t.abaixo > 0 ? ' mp-kpi-alerta' : ' mp-kpi-bom'}`}><span className="mp-kpi-rotulo"><ArrowDownRight size={12} /> Abaixo do piso</span><strong>{t.abaixo}</strong><small>{t.noLimite} no limite (até 5% acima)</small></div>
          <div className={`mp-kpi${t.perda30d > 0 ? ' mp-kpi-perigo' : ''}`}><span className="mp-kpi-rotulo"><ScrollText size={12} /> Deixado na mesa</span><strong>{money(t.perda30d)}</strong><small>nos últimos 30 dias, nos anúncios com venda</small></div>
          <div className={`mp-kpi${t.semPiso > 0 ? ' mp-kpi-alerta' : ''}`}><span className="mp-kpi-rotulo"><Ban size={12} /> Sem piso</span><strong>{t.semPiso}</strong><small>sem referência, sem custo ou sem tabela do canal</small></div>
        </div>
      )}
      <div className="cobertura-barra" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select value={canal} onChange={(e) => setCanal(e.target.value)}><option value="">Todos os canais</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <MultiSelect valor={filtroSit} onChange={setFiltroSit} opcoes={Object.entries(SITUACOES).map(([k, v]) => ({ valor: k, rotulo: v.rotulo }))} placeholder="Situação" />
        <CampoBusca valor={busca} onChange={setBusca} placeholder="Título, referência ou MLB" />
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}><RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar</button>
      </div>
      {carregando && !dados ? <Skeleton height={200} radius={10} /> : linhas.length === 0 ? (
        <EstadoVazio Icone={ShieldCheck} titulo="Nenhum anúncio nesta situação" descricao="Todos os anúncios no ar estão acima do piso do canal — ou mude o filtro para ver os demais." />
      ) : (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <Paginacao {...tabela} posicao="topo" />
          <div style={{ overflowX: 'auto' }}>
            <table className="mp-tecido-tab">
              <thead><tr><th>Anúncio</th><th>Canal</th><th>Referência</th><th>Preço</th><th>Piso</th><th>Margem</th><th>Mínimo</th><th>Falta</th><th>30 dias</th><th>Na mesa</th><th style={{ textAlign: 'left' }}>Situação</th></tr></thead>
              <tbody>
                {tabela.itensPagina.map((l) => (
                  <tr key={l.anuncio_id} title={l.motivo || l.regra || ''}>
                    <td style={{ maxWidth: 320 }}><div className="pp-titulo">{l.foto_url && <img src={l.foto_url} alt="" className="pp-foto" />}<span>{l.titulo}</span></div><small className="ink-soft">{l.loja_nome} · {l.anuncio_id_externo}</small></td>
                    <td><Canal chave={l.marketplace} /></td>
                    <td>{l.referencia || <span className="mp-selo mp-selo-pendente">sem vínculo</span>}{l.classe && <span className="mp-selo mp-selo-neutro" style={{ marginLeft: 4 }}>{l.classe}</span>}</td>
                    <td><b>{money(l.preco)}</b></td>
                    <td>{l.piso == null ? <span className="mp-vazio" title={l.motivo || ''}>—</span> : money(l.piso)}</td>
                    <td className={l.margem != null && l.margem < 0 ? 'mp-falta-n' : ''}>{pct(l.margem)}</td>
                    <td>{pct(l.margem_minima)}</td>
                    <td>{l.falta > 0 ? <b className="mp-falta-n">{money(l.falta)}</b> : (l.piso == null ? '—' : <span style={{ color: 'var(--success)' }}>0</span>)}</td>
                    <td>{l.unidades_30d == null ? <span className="mp-vazio" title="sem venda ligada a este anúncio nos 30 dias">—</span> : `${formatQtd(l.unidades_30d)} pç`}</td>
                    <td>{l.perda_30d == null ? <span className="mp-vazio" title="abaixo do piso, mas sem venda ligada ao anúncio para medir">?</span> : (l.perda_30d > 0 ? <b className="mp-falta-n">{money(l.perda_30d)}</b> : '—')}</td>
                    <td style={{ textAlign: 'left' }}><Situacao chave={l.situacao} />{l.situacao === 'sem_piso' && l.motivo && <div className="ink-soft" style={{ fontSize: 11, maxWidth: 220 }}>{l.motivo}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginacao {...tabela} posicao="rodape" />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simulador de campanha
// ---------------------------------------------------------------------------
function Simulador({ lojas }) {
  const [catalogo, setCatalogo] = useState([]);
  const [busca, setBusca] = useState('');
  const [canal, setCanal] = useState('');
  const [selecionados, setSelecionados] = useState(() => new Set());
  const [tipo, setTipo] = useState('desconto_pct');
  const [valor, setValor] = useState(20);
  const [taxaPct, setTaxaPct] = useState('');
  const [taxaFixa, setTaxaFixa] = useState('');
  const [dias, setDias] = useState(30);
  const [resultado, setResultado] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [nome, setNome] = useState('');
  const [salvas, setSalvas] = useState([]);

  useEffect(() => {
    api.get(`${ROTA}/auditoria`).then((d) => setCatalogo(d.linhas || [])).catch((e) => setErro(e.message));
    api.get(`${ROTA}/simulacoes`).then(setSalvas).catch(() => {});
  }, []);

  const candidatos = useMemo(() => catalogo.filter((l) => (!canal || l.marketplace === canal) && (!busca || `${l.titulo} ${l.referencia || ''}`.toLowerCase().includes(busca.toLowerCase()))), [catalogo, canal, busca]);
  const alternar = (id) => { const n = new Set(selecionados); n.has(id) ? n.delete(id) : n.add(id); setSelecionados(n); };
  const todos = () => setSelecionados(new Set(candidatos.map((c) => c.anuncio_id)));

  const simular = async () => {
    setOcupado(true); setErro(null);
    try {
      setResultado(await api.post(`${ROTA}/simular`, {
        anuncio_ids: [...selecionados], regra: { tipo, valor: Number(valor) },
        taxa_campanha_pct: taxaPct === '' ? null : Number(taxaPct) / 100, taxa_campanha_fixa: taxaFixa === '' ? 0 : Number(taxaFixa), dias: Number(dias),
      }));
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  const salvar = async () => {
    if (!nome.trim() || !resultado) return;
    try {
      await api.post(`${ROTA}/simulacoes`, { nome, marketplace: canal || null, parametros: resultado.parametros, resultado });
      setNome(''); setSalvas(await api.get(`${ROTA}/simulacoes`));
    } catch (e) { setErro(e.message); }
  };

  const t = resultado?.totais;
  const SIT = {
    melhora: { rotulo: 'Sobra mais', classe: 'pp-ok' }, precisa_vender_mais: { rotulo: 'Precisa vender mais', classe: 'pl-urg-programar' },
    nao_fecha: { rotulo: 'Não fecha', classe: 'pl-urg-atrasada' }, sem_calculo: { rotulo: 'Sem cálculo', classe: 'pp-sem' },
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <section className="card pp-sim-param">
        <div className="mp-param"><label>Campanha</label>
          <span className="mp-seg">
            {[['desconto_pct', 'Desconto %'], ['cupom_pct', 'Cupom %'], ['preco_fixo', 'Preço fixo']].map(([k, r]) => <button key={k} type="button" aria-pressed={tipo === k} onClick={() => setTipo(k)}>{r}</button>)}
          </span>
        </div>
        <div className="mp-param"><label>{tipo === 'preco_fixo' ? 'Preço (R$)' : 'Valor (%)'}</label><NumInput step={tipo === 'preco_fixo' ? '0.01' : '1'} min={0} value={valor} onChange={(n) => setValor(n ?? '')} /></div>
        <div className="mp-param"><label>Taxa da campanha (%)</label><NumInput step="0.1" min={0} placeholder="0" value={taxaPct} onChange={(n) => setTaxaPct(n ?? '')} /></div>
        <div className="mp-param"><label>Taxa fixa por peça (R$)</label><NumInput step="0.01" min={0} placeholder="0" value={taxaFixa} onChange={(n) => setTaxaFixa(n ?? '')} /></div>
        <div className="mp-param"><label>Velocidade dos últimos</label><span className="mp-campo"><NumInput step="1" min={7} value={dias} onChange={(n) => setDias(n ?? 30)} /><span className="mp-unid">dias</span></span></div>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" disabled={ocupado || selecionados.size === 0} onClick={simular}><Calculator size={14} /> {ocupado ? 'Simulando…' : `Simular ${selecionados.size} anúncio(s)`}</button>
      </section>

      {t && (
        <>
          <div className="mp-kpis">
            <div className="mp-kpi"><span className="mp-kpi-rotulo">Lucro por dia hoje</span><strong>{money(t.lucroDiaAtual)}</strong><small>{t.comVenda} de {t.avaliados} anúncios com venda medida</small></div>
            <div className={`mp-kpi${t.lucroDiaCampanhaSemUplift < t.lucroDiaAtual ? ' mp-kpi-alerta' : ' mp-kpi-bom'}`}><span className="mp-kpi-rotulo">Na campanha, mesmo volume</span><strong>{money(t.lucroDiaCampanhaSemUplift)}</strong><small>se vender igual a hoje</small></div>
            <div className={`mp-kpi${t.upliftMedioNecessario > 0.5 ? ' mp-kpi-perigo' : (t.upliftMedioNecessario > 0 ? ' mp-kpi-alerta' : ' mp-kpi-bom')}`}><span className="mp-kpi-rotulo">Para empatar</span><strong>{t.upliftMedioNecessario == null ? (t.lucroDiaCampanhaSemUplift <= 0 && t.comVenda > 0 ? 'não empata' : '—') : (t.upliftMedioNecessario <= 0 ? 'já empata' : `+${pct(t.upliftMedioNecessario, 0)}`)}</strong><small>de peças a mais por dia, no conjunto</small></div>
            <div className={`mp-kpi${t.naoFecha + t.abaixoDoPiso > 0 ? ' mp-kpi-perigo' : ''}`}><span className="mp-kpi-rotulo">Não fecha / abaixo do piso</span><strong>{t.naoFecha} / {t.abaixoDoPiso}</strong><small>lucro zero ou negativo · abaixo da margem mínima</small></div>
          </div>
          <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="mp-tecido-topo"><Calculator size={14} /><h4>Resultado por anúncio</h4>
              <div className="mp-acoes"><input className="pl-motivo" style={{ height: 30, minWidth: 180 }} placeholder="nome para guardar" value={nome} onChange={(e) => setNome(e.target.value)} /><button type="button" className="btn-sec btn-mini" disabled={!nome.trim()} onClick={salvar}><Save size={12} /> Guardar simulação</button></div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="mp-tecido-tab">
                <thead><tr><th>Anúncio</th><th>Canal</th><th>Hoje</th><th>Campanha</th><th>Sobra/pç hoje</th><th>Sobra/pç campanha</th><th>Vende/dia</th><th>Precisa vender</th><th style={{ textAlign: 'left' }}>Situação</th></tr></thead>
                <tbody>
                  {resultado.itens.map((i) => (
                    <tr key={i.anuncio_id}>
                      <td style={{ maxWidth: 300 }}><div className="pp-titulo"><span>{i.titulo}</span></div><small className="ink-soft">{i.referencia || 'sem referência'} · {i.loja_nome}</small></td>
                      <td><Canal chave={i.marketplace} /></td>
                      <td>{money(i.precoAtual)}<br /><small className="ink-soft">{pct(i.margemAtual)}</small></td>
                      <td><b>{money(i.precoCampanha)}</b><br /><small className="ink-soft">{pct(i.margemCampanha)}{i.taxaCampanhaRS > 0 && ` · taxa ${money(i.taxaCampanhaRS)}`}</small></td>
                      <td>{money(i.lucroAtual)}</td>
                      <td className={i.lucroCampanha != null && i.lucroCampanha <= 0 ? 'mp-falta-n' : ''}>{money(i.lucroCampanha)}</td>
                      <td>{i.vendasDia == null ? <span className="mp-vazio" title="sem venda ligada ao anúncio no período">—</span> : i.vendasDia.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</td>
                      <td>{i.vendasDiaParaEmpatar == null ? (i.fatorEmpate != null ? `×${i.fatorEmpate}` : '—') : <><b>{i.vendasDiaParaEmpatar.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</b>/dia <small className="ink-soft">(×{i.fatorEmpate})</small></>}</td>
                      <td style={{ textAlign: 'left' }}><span className={`pl-urg ${SIT[i.situacao]?.classe || 'pp-sem'}`}>{SIT[i.situacao]?.rotulo || i.motivo || '—'}</span>{i.abaixoDoPiso && <span className="mp-selo mp-selo-pendente" style={{ marginLeft: 6 }} title={`piso ${money(i.piso)}`}>abaixo do piso</span>}{i.motivo && <div className="ink-soft" style={{ fontSize: 11 }}>{i.motivo}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="mp-tecido-topo"><Search size={14} /><h4>Escolher anúncios</h4>
          <span style={{ fontSize: 12, opacity: .8 }}>{selecionados.size} selecionado(s)</span>
          <div className="mp-acoes">
            <Select value={canal} onChange={(e) => setCanal(e.target.value)}><option value="">Todos os canais</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <CampoBusca valor={busca} onChange={setBusca} placeholder="Título ou referência" />
            <button type="button" className="btn-sec btn-mini" onClick={todos}>Selecionar os {candidatos.length}</button>
            <button type="button" className="btn-sec btn-mini" onClick={() => setSelecionados(new Set())}>Limpar</button>
          </div>
        </div>
        <div className="pp-lista-sel">
          {candidatos.slice(0, 400).map((c) => (
            <label key={c.anuncio_id} className={`pp-sel ${selecionados.has(c.anuncio_id) ? 'pp-sel-on' : ''}`}>
              <input type="checkbox" checked={selecionados.has(c.anuncio_id)} onChange={() => alternar(c.anuncio_id)} />
              <span className="pp-sel-titulo">{c.titulo}</span>
              <small className="ink-soft">{c.referencia || 'sem ref.'} · {money(c.preco)} · <Situacao chave={c.situacao} /></small>
            </label>
          ))}
          {candidatos.length > 400 && <p className="mp-nota" style={{ padding: 10 }}><Info size={13} /><span>Mostrando 400 de {candidatos.length}. Refine pela busca.</span></p>}
        </div>
      </section>

      {salvas.length > 0 && (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="mp-tecido-topo"><Save size={14} /><h4>Simulações guardadas</h4></div>
          <table className="mp-tecido-tab"><thead><tr><th>Quando</th><th>Nome</th><th>Campanha</th><th>Lucro/dia hoje</th><th>Na campanha</th><th>Para empatar</th><th>Quem</th></tr></thead>
            <tbody>{salvas.map((s) => (
              <tr key={s.id}><td>{dataBr(String(s.criada_em).slice(0, 10))}</td><td style={{ textAlign: 'left' }}><b>{s.nome}</b></td><td>{s.parametros?.regra ? `${s.parametros.regra.tipo === 'preco_fixo' ? 'R$ ' : ''}${s.parametros.regra.valor}${s.parametros.regra.tipo !== 'preco_fixo' ? '%' : ''}` : '—'}</td><td>{money(s.totais?.lucroDiaAtual)}</td><td>{money(s.totais?.lucroDiaCampanhaSemUplift)}</td><td>{s.totais?.upliftMedioNecessario == null ? '—' : pct(s.totais.upliftMedioNecessario, 0)}</td><td>{s.criada_por_nome || '—'}</td></tr>
            ))}</tbody></table>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concorrentes
// ---------------------------------------------------------------------------
function Concorrentes() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [lendo, setLendo] = useState(false);
  const [novo, setNovo] = useState(null);
  const [produtos, setProdutos] = useState([]);
  const [buscaProd, setBuscaProd] = useState('');

  const carregar = useCallback(async () => {
    try { setDados(await api.get(`${ROTA}/concorrentes`)); } catch (e) { setErro(e.message); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (novo && produtos.length === 0) api.get(`${ROTA}/auditoria`).then((d) => {
      const vistos = new Map();
      for (const l of d.linhas || []) if (l.produto_id && !vistos.has(l.produto_id)) vistos.set(l.produto_id, { id: l.produto_id, referencia: l.referencia, descricao: l.descricao });
      setProdutos([...vistos.values()].sort((a, b) => String(a.referencia).localeCompare(String(b.referencia))));
    }).catch(() => {});
  }, [novo, produtos.length]);

  const ler = async () => {
    setLendo(true); setErro(null);
    try { const r = await api.post(`${ROTA}/concorrentes/ler`, {}); if (r.semIntegracao) setErro('Nenhuma conta do Mercado Livre conectada — só o preço digitado à mão fica disponível.'); await carregar(); } catch (e) { setErro(e.message); } finally { setLendo(false); }
  };
  const criar = async () => {
    setErro(null);
    try { await api.post(`${ROTA}/concorrentes`, novo); setNovo(null); await carregar(); } catch (e) { setErro(e.message); }
  };
  const remover = async (c) => {
    if (!(await confirmar(`Parar de acompanhar "${c.titulo || c.item_id_externo || c.vendedor}"?`, { titulo: 'Remover concorrente', confirmarTexto: 'Remover' }))) return;
    try { await api.del(`${ROTA}/concorrentes/${c.id}`); await carregar(); } catch (e) { setErro(e.message); }
  };
  const editarPreco = async (c, preco) => {
    try { await api.put(`${ROTA}/concorrentes/${c.id}`, { preco }); await carregar(); } catch (e) { setErro(e.message); }
  };

  const linhas = dados?.linhas || [];
  const t = dados?.totais;
  const prodFiltrados = produtos.filter((p) => !buscaProd || `${p.referencia} ${p.descricao || ''}`.toLowerCase().includes(buscaProd.toLowerCase())).slice(0, 60);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      {t && (
        <div className="mp-kpis">
          <div className="mp-kpi"><span className="mp-kpi-rotulo"><Users size={12} /> Acompanhados</span><strong>{t.concorrentes}</strong><small>anúncios de concorrente e vitrines de catálogo</small></div>
          <div className={`mp-kpi${t.maisBaratos > 0 ? ' mp-kpi-alerta' : ' mp-kpi-bom'}`}><span className="mp-kpi-rotulo"><ArrowDownRight size={12} /> Mais baratos que nós</span><strong>{t.maisBaratos}</strong><small>no mesmo canal</small></div>
          <div className={`mp-kpi${t.comErro > 0 ? ' mp-kpi-perigo' : ''}`}><span className="mp-kpi-rotulo"><TriangleAlert size={12} /> Com erro de leitura</span><strong>{t.comErro}</strong><small>{dados.leituraMlDisponivel ? 'leitura automática pelo Mercado Livre ativa' : 'sem conta do Mercado Livre conectada'}</small></div>
          <div className="mp-kpi"><span className="mp-kpi-rotulo"><Info size={12} /> Sem preço ainda</span><strong>{t.semLeitura}</strong><small>cadastrados e ainda não lidos</small></div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={() => setNovo({ produto_id: '', marketplace: 'mercado_livre', url: '', preco: '', titulo: '' })}><Plus size={14} /> Acompanhar concorrente</button>
        <button type="button" className="btn-sec" onClick={ler} disabled={lendo}><RefreshCw size={14} className={lendo ? 'girando' : ''} /> Ler preços agora</button>
        <span className="ink-soft" style={{ fontSize: 12, alignSelf: 'center' }}>Leitura automática a cada 6 horas para anúncios do Mercado Livre; nos outros canais o preço é digitado.</span>
      </div>

      {novo && (
        <section className="card" style={{ display: 'grid', gap: 10 }}>
          <h4 style={{ margin: 0, fontSize: 13 }}><Plus size={14} /> Novo concorrente</h4>
          <div className="pl-acoes">
            <div className="mp-param"><label>Referência nossa</label>
              <Select value={novo.produto_id} onChange={(e) => setNovo({ ...novo, produto_id: e.target.value })} chaveRecentes="pp_produto">
                <option value="">— escolher —</option>
                {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
              </Select>
            </div>
            <div className="mp-param"><label>Canal</label>
              <Select value={novo.marketplace} onChange={(e) => setNovo({ ...novo, marketplace: e.target.value })}>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            </div>
            <div className="mp-param" style={{ flex: 1, minWidth: 260 }}><label>{novo.marketplace === 'mercado_livre' ? 'Link ou MLB do anúncio' : 'Link do anúncio (opcional)'}</label><input value={novo.url} onChange={(e) => setNovo({ ...novo, url: e.target.value })} placeholder={novo.marketplace === 'mercado_livre' ? 'https://produto.mercadolivre.com.br/MLB-123456789-...' : 'https://…'} /></div>
            {novo.marketplace !== 'mercado_livre' && (
              <>
                <div className="mp-param"><label>Nome / vendedor</label><input value={novo.titulo} onChange={(e) => setNovo({ ...novo, titulo: e.target.value })} /></div>
                <div className="mp-param"><label>Preço (R$)</label><NumInput step="0.01" min={0} value={novo.preco} onChange={(n) => setNovo({ ...novo, preco: n ?? '' })} /></div>
              </>
            )}
            <button type="button" className="btn-sec" onClick={() => setNovo(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={!novo.produto_id || (novo.marketplace === 'mercado_livre' ? !novo.url : !(novo.preco || novo.titulo))} onClick={criar}><Save size={14} /> Acompanhar</button>
          </div>
        </section>
      )}

      {linhas.length === 0 ? (
        <EstadoVazio Icone={Users} titulo="Nenhum concorrente acompanhado" descricao="Cole o link do anúncio de um concorrente do Mercado Livre numa referência sua; o preço é lido na hora e a cada 6 horas. Para os outros canais, digite o preço." />
      ) : (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="mp-tecido-tab">
            <thead><tr><th>Referência</th><th>Canal</th><th>Concorrente</th><th>Preço deles</th><th>Nosso</th><th>Diferença</th><th>Variação</th><th>Lido</th><th /></tr></thead>
            <tbody>
              {linhas.map((c) => (
                <tr key={c.id}>
                  <td style={{ textAlign: 'left' }}><b>{c.referencia}</b><br /><small className="ink-soft">{c.descricao}</small></td>
                  <td><Canal chave={c.marketplace} /></td>
                  <td style={{ textAlign: 'left', maxWidth: 320 }}>
                    {c.origem === 'catalogo' ? <span className="mp-selo mp-selo-sugerida">vitrine do catálogo</span> : null} {c.titulo || c.vendedor || c.item_id_externo}
                    {c.url && <a href={c.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}><ExternalLink size={11} /></a>}
                    {c.observacao && <div className="ink-soft" style={{ fontSize: 11 }}>{c.observacao}</div>}
                    {c.ultimo_erro && <div style={{ fontSize: 11, color: 'var(--danger)' }}><TriangleAlert size={11} /> {c.ultimo_erro}</div>}
                  </td>
                  <td>{c.origem === 'manual' ? <NumInput className="mp-saldo" step="0.01" min={0} value={c.preco ?? ''} onChange={() => {}} onBlur={(e) => { const v = Number(String(e.target.value).replace(/\./g, '').replace(',', '.')); if (v > 0 && v !== Number(c.preco)) editarPreco(c, v); }} /> : <b>{money(c.preco)}</b>}</td>
                  <td>{money(c.nosso_preco)}{c.nossos_anuncios > 1 && <small className="ink-soft"> (menor de {c.nossos_anuncios})</small>}</td>
                  <td className={c.diferenca_pct != null && c.diferenca_pct < 0 ? 'mp-falta-n' : ''}>{c.diferenca_pct == null ? '—' : <>{c.diferenca_pct < 0 ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />} {pct(Math.abs(c.diferenca_pct))} {c.diferenca_pct < 0 ? 'mais barato' : 'mais caro'}</>}</td>
                  <td>{c.variacao_pct == null ? '—' : `${c.variacao_pct > 0 ? '+' : ''}${pct(c.variacao_pct)}`}</td>
                  <td>{c.lido_em ? dataBr(String(c.lido_em).slice(0, 10)) : '—'}</td>
                  <td><button type="button" className="btn-sec btn-mini" title="Parar de acompanhar" onClick={() => remover(c)}><Trash2 size={12} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------
function Regras() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [novo, setNovo] = useState(null);
  const [excecoes, setExcecoes] = useState([]);
  const [verExcecoes, setVerExcecoes] = useState(false);

  const carregar = useCallback(async () => {
    try { setDados(await api.get(`${ROTA}/regras`)); setExcecoes(await api.get(`${ROTA}/excecoes`)); } catch (e) { setErro(e.message); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const salvar = async () => {
    setErro(null);
    try {
      await api.post(`${ROTA}/regras`, {
        marketplace: novo.marketplace || null, classe_abc: novo.classe_abc || null, produto_id: novo.produto_id || null,
        margem_minima: Number(novo.margem) / 100, pct_ads: novo.ads === '' ? null : Number(novo.ads) / 100, pct_devolucao: novo.dev === '' ? null : Number(novo.dev) / 100,
        incluir_embalagem: novo.embalagem !== false, observacao: novo.observacao || null,
      });
      setNovo(null); await carregar();
    } catch (e) { setErro(e.message); }
  };
  const desativar = async (r) => {
    if (!(await confirmar('Desativar esta regra? O piso volta a seguir a regra mais geral.', { titulo: 'Desativar regra', confirmarTexto: 'Desativar' }))) return;
    try { await api.del(`${ROTA}/regras/${r.id}`); await carregar(); } catch (e) { setErro(e.message); }
  };

  if (!dados) return <Skeleton height={120} radius={10} />;
  const ativas = dados.regras.filter((r) => r.ativo);

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <section className="card pp-geral">
        <div><h4><SlidersHorizontal size={14} /> Sem regra, vale a margem mínima geral</h4>
          <p className="ink-soft">Configurações → Parâmetros: <b>{pct(dados.geral.margemMinima)}</b>, com a embalagem de {money(dados.geral.custoEmbalagem)} por peça e sem publicidade nem devolução. As regras abaixo refinam por canal, classe ABC ou referência — a mais específica vence.</p>
        </div>
        {dados.podeEditar ? <button type="button" className="btn btn-primary" onClick={() => setNovo({ marketplace: '', classe_abc: '', produto_id: '', margem: 15, ads: '', dev: '', embalagem: true, observacao: '' })}><Plus size={14} /> Nova regra</button>
          : <span className="mp-selo mp-selo-neutro">só Configurações edita</span>}
      </section>

      {novo && (
        <section className="card" style={{ display: 'grid', gap: 10 }}>
          <div className="pl-acoes">
            <div className="mp-param"><label>Canal</label><Select value={novo.marketplace} onChange={(e) => setNovo({ ...novo, marketplace: e.target.value })}><option value="">todos</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></div>
            <div className="mp-param"><label>Classe ABC</label><span className="mp-seg">{['', 'A', 'B', 'C'].map((c) => <button key={c || 'x'} type="button" aria-pressed={novo.classe_abc === c} onClick={() => setNovo({ ...novo, classe_abc: c })}>{c || 'todas'}</button>)}</span></div>
            <div className="mp-param"><label>Referência (id)</label><NumInput step="1" min={0} placeholder="todas" value={novo.produto_id} onChange={(n) => setNovo({ ...novo, produto_id: n ?? '' })} /></div>
            <div className="mp-param"><label>Margem mínima (%)</label><NumInput step="0.1" min={0} value={novo.margem} onChange={(n) => setNovo({ ...novo, margem: n ?? '' })} /></div>
            <div className="mp-param"><label>Publicidade prevista (%)</label><NumInput step="0.1" min={0} placeholder="não descontar" value={novo.ads} onChange={(n) => setNovo({ ...novo, ads: n ?? '' })} /></div>
            <div className="mp-param"><label>Devolução prevista (%)</label><NumInput step="0.1" min={0} placeholder="não descontar" value={novo.dev} onChange={(n) => setNovo({ ...novo, dev: n ?? '' })} /></div>
            <label className="mp-param" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={novo.embalagem} onChange={(e) => setNovo({ ...novo, embalagem: e.target.checked })} /> embalagem no custo</label>
            <div className="mp-param" style={{ flex: 1, minWidth: 200 }}><label>Observação</label><input value={novo.observacao} onChange={(e) => setNovo({ ...novo, observacao: e.target.value })} /></div>
            <button type="button" className="btn-sec" onClick={() => setNovo(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={!(Number(novo.margem) >= 0)} onClick={salvar}><Save size={14} /> Salvar regra</button>
          </div>
        </section>
      )}

      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="mp-tecido-topo"><SlidersHorizontal size={14} /><h4>Regras ativas</h4><span style={{ fontSize: 12, opacity: .8 }}>{ativas.length === 0 ? 'nenhuma — vale a geral' : `${ativas.length} regra(s)`}</span></div>
        {ativas.length > 0 && (
          <table className="mp-tecido-tab">
            <thead><tr><th>Escopo</th><th>Margem mínima</th><th>Publicidade</th><th>Devolução</th><th>Embalagem</th><th>Observação</th><th>Quem</th><th /></tr></thead>
            <tbody>{ativas.map((r) => (
              <tr key={r.id}>
                <td style={{ textAlign: 'left' }}>{r.produto_id ? <b>{r.referencia}</b> : null}{r.marketplace ? <> <Canal chave={r.marketplace} /></> : null}{r.classe_abc ? <span className="mp-selo mp-selo-neutro" style={{ marginLeft: 4 }}>classe {r.classe_abc}</span> : null}{!r.produto_id && !r.marketplace && !r.classe_abc ? 'geral' : null}</td>
                <td><b>{pct(r.margem_minima)}</b></td><td>{r.pct_ads == null ? '—' : pct(r.pct_ads)}</td><td>{r.pct_devolucao == null ? '—' : pct(r.pct_devolucao)}</td><td>{r.incluir_embalagem ? 'sim' : 'não'}</td>
                <td style={{ textAlign: 'left' }}>{r.observacao || ''}</td><td>{r.definido_por_nome || '—'}</td>
                <td>{dados.podeEditar && <button type="button" className="btn-sec btn-mini" onClick={() => desativar(r)}><X size={12} /></button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <div>
        <button type="button" className="mp-ajuda-btn" onClick={() => setVerExcecoes(!verExcecoes)}>{verExcecoes ? <X size={13} /> : <ScrollText size={13} />} Quem vendeu abaixo do piso ({excecoes.length})</button>
        {verExcecoes && (
          <section className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 8 }}>
            {excecoes.length === 0 ? <p className="ink-soft" style={{ padding: 14 }}>Ninguém ainda.</p> : (
              <table className="mp-tecido-tab"><thead><tr><th>Quando</th><th>Onde</th><th>Referência</th><th>Preço</th><th>Piso</th><th>Margem</th><th>Motivo</th><th>Quem</th></tr></thead>
                <tbody>{excecoes.map((e) => (
                  <tr key={e.id}><td>{dataBr(String(e.registrado_em).slice(0, 10))}</td><td>{e.origem === 'promocao' ? `promoção${e.promocao_nome ? ` "${e.promocao_nome}"` : ''}` : 'anúncio'}<br /><small className="ink-soft">{e.anuncio_titulo}</small></td><td>{e.referencia || '—'}</td><td>{money(e.preco)}</td><td>{money(e.piso)}</td><td>{pct(e.margem_no_preco)} <small className="ink-soft">/ {pct(e.margem_minima)}</small></td><td style={{ textAlign: 'left', maxWidth: 320 }}>{e.motivo}</td><td>{e.usuario_nome || '—'}</td></tr>
                ))}</tbody></table>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function PisoPrecoPage() {
  const [aba, setAba] = useState('auditoria');
  const [ajuda, setAjuda] = useState(false);
  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><ShieldCheck size={20} /> Piso de Preço</h1>
          <p className="page-sub">O menor preço que cada canal aguenta por referência. Abaixo dele, quem vende assina o motivo.</p>
        </div>
      </header>
      <div className="subtab-row">
        <button type="button" className={`subtab-btn ${aba === 'auditoria' ? 'active' : ''}`} onClick={() => setAba('auditoria')}>Auditoria dos anúncios</button>
        <button type="button" className={`subtab-btn ${aba === 'simular' ? 'active' : ''}`} onClick={() => setAba('simular')}>Simular campanha</button>
        <button type="button" className={`subtab-btn ${aba === 'concorrentes' ? 'active' : ''}`} onClick={() => setAba('concorrentes')}>Concorrentes</button>
        <button type="button" className={`subtab-btn ${aba === 'regras' ? 'active' : ''}`} onClick={() => setAba('regras')}>Regras</button>
      </div>
      {aba === 'auditoria' && <Auditoria />}
      {aba === 'simular' && <Simulador />}
      {aba === 'concorrentes' && <Concorrentes />}
      {aba === 'regras' && <Regras />}
      <div>
        <button type="button" className="mp-ajuda-btn" onClick={() => setAjuda(!ajuda)}>{ajuda ? <X size={13} /> : <Info size={13} />} Como esta tela calcula</button>
        {ajuda && (
          <div className="mp-ajuda" style={{ marginTop: 8 }}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li><b>Piso</b> = o preço que deixa a margem mínima da regra depois de imposto da empresa, comissão da faixa do canal (a tabela de Taxas de Marketplace), frete subsidiado pelo peso, taxas de venda (cartão, antecipação) e, quando a regra pede, publicidade e devolução previstas e a embalagem. É a mesma formação de preço de Análises › Preço por Canal, com a margem mínima no lugar da desejada.</li>
              <li><b>Regra que vale</b>: a mais específica — referência, depois canal + classe, canal, classe, geral. Sem regra, a margem mínima das Configurações. A classe ABC é a mesma da Cobertura (margem de contribuição, 26 semanas).</li>
              <li><b>Trava</b>: ao alterar o preço de um anúncio ou criar/editar uma promoção abaixo do piso, o sistema pede confirmação e motivo; o motivo fica gravado com quem assinou. Prejuízo continua avisando como antes. Anúncio sem referência, sem custo ou canal sem tabela não tem piso — e não trava.</li>
              <li><b>Simulador</b>: preço de campanha = desconto/cupom sobre o preço corrente (ou preço fixo), arredondado para baixo; a comissão é recalculada na faixa do preço novo; a taxa da campanha é a que você informar. "Precisa vender" = lucro por peça hoje ÷ lucro por peça na campanha × peças/dia medidas nos últimos N dias por este anúncio.</li>
              <li><b>Concorrentes</b>: anúncio do Mercado Livre é lido pela API a cada 6 horas (precisa de uma conta ML conectada); nos outros canais o preço é digitado. "Vitrine do catálogo" é o preço para ganhar que o ML devolve para os nossos anúncios de catálogo.</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
