import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, RefreshCw, TriangleAlert, Info, X, Calculator, Users, SlidersHorizontal, Plus, Save, Trash2, Search, ExternalLink,
  CheckCircle2, Ban, ArrowDownRight, ArrowUpRight, ScrollText, Pencil, Layers, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, Select, NumInput, Paginacao, CampoBusca, MultiSelect, IndicadorDestaque, ThOrdenavel, Toggle } from '../components/ui';
import DataTable from '../components/DataTable';
import Gaveta from '../components/Gaveta';
import { brl, formatQtd, dataBr, plural, numeroBr } from '../lib/format';
import { useTabela } from '../lib/useTabela';
import { confirmar } from '../components/ConfirmDialog';
import { tratarTravaDoPiso } from '../components/MotivoDialog';
import { SeloPlataforma } from '../lib/canalMarketplace';

// Marketplace › Catálogo › Piso de Preço — repaginada em 23/09/2026 depois do
// teste de uso (ver claude/hbn-pos-venda-piso-diagnostico-2026-09-23.md).
//
//   Auditoria    — uma linha por ANÚNCIO (não por variação), os 4 números do
//                  topo filtram a lista ao clicar, e a linha tem ação:
//                  "Ajustar preço" abre a gaveta com o piso ao lado e publica
//                  na plataforma pela mesma trava dos Anúncios.
//   Simular      — em três passos, de cima para baixo: escolher (por
//                  referência, não por variação), campanha, resultado.
//   Concorrentes — sem KPIs zerados antes do primeiro cadastro; o formulário
//                  vive numa gaveta.
//   Regras       — formulário em gaveta, referência escolhida por código
//                  (não por id do banco), embalagem como chave liga/desliga.

const ROTA = '/preco-regra';
const CANAIS = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein' };
const pct = (v, casas = 1) => (v == null ? '—' : `${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`);
const money = (v) => (v == null ? '—' : brl(Number(v)));
const fator = (v) => (v == null ? '—' : `×${numeroBr(v, 2)}`);

const SITUACOES = {
  prejuizo: { rotulo: 'Prejuízo', classe: 'tone-prejuizo', Icone: TriangleAlert },
  abaixo: { rotulo: 'Abaixo do piso', classe: 'tone-abaixo', Icone: ArrowDownRight },
  no_limite: { rotulo: 'No limite', classe: 'tone-atencao', Icone: Info },
  ok: { rotulo: 'Acima do piso', classe: 'tone-saudavel', Icone: CheckCircle2 },
  sem_piso: { rotulo: 'Sem piso', classe: 'tone-neutro', Icone: Ban },
};
function Situacao({ chave }) { const s = SITUACOES[chave] || SITUACOES.sem_piso; const { Icone } = s; return <span className={`stamp sm ${s.classe}`}><Icone size={11} /> {s.rotulo}</span>; }
function Canal({ chave, nome }) { return <span className="pv-canal"><SeloPlataforma chave={chave} size={14} /> {nome || CANAIS[chave] || chave}</span>; }
function Anuncio({ l, compacto }) {
  return (
    <div className="pp-anuncio">
      {l.foto_url ? <img src={l.foto_url} alt="" className="pp-foto" /> : <span className="pp-foto pp-foto-vazia" />}
      <div className="pp-anuncio-textos">
        <span className="pp-anuncio-titulo" title={l.titulo}>{l.titulo}</span>
        {!compacto && <small className="ink-soft">{l.loja_nome} · {l.anuncio_id_externo}{l.variacoes > 1 && <span className="stamp sm tone-neutro pp-var" title={`${l.variacoes} variações com o mesmo piso`}><Layers size={10} /> {l.variacoes} var.</span>}</small>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gaveta "Ajustar preço" — o preço do anúncio com o piso ao lado, publicado
// na plataforma pela mesma trava dos Anúncios (400 → motivo → repete).
// ---------------------------------------------------------------------------
function GavetaPreco({ linha, onFechar, onGravado }) {
  const [preco, setPreco] = useState(linha.preco ?? '');
  const [avaliacao, setAvaliacao] = useState(null);
  const [erro, setErro] = useState(null);
  const [ok, setOk] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [itemId, setItemId] = useState(linha.anuncio_id);
  const itens = linha.itens || [linha];
  const item = itens.find((i) => i.anuncio_id === itemId) || linha;
  useEffect(() => {
    if (!(Number(preco) > 0)) { setAvaliacao(null); return undefined; }
    const t = setTimeout(() => { api.post(`${ROTA}/avaliar`, { anuncio_id: itemId, preco: Number(preco) }).then(setAvaliacao).catch(() => setAvaliacao(null)); }, 250);
    return () => clearTimeout(t);
  }, [preco, itemId]);
  const publicar = async () => {
    const alvo = itens.length > 1 ? `${plural(itens.length, 'variação', 'variações')} de "${linha.titulo}"` : `"${linha.titulo}"`;
    if (!(await confirmar(`Alterar o preço para ${money(preco)} em ${alvo} na ${linha.loja_nome}? Vai para o ar agora.`, { titulo: 'Alterar na plataforma', confirmarTexto: 'Sim, alterar agora', perigo: true }))) return;
    setEnviando(true); setErro(null); setOk(null);
    try {
      let extra = null;
      for (const i of itens) {
        const corpo = { confirmar: true, preco: Number(preco), ...(extra || {}) };
        try { await api.post(`/anuncios/${i.anuncio_id}/publicar`, corpo); } catch (e) {
          if (extra) throw e;
          extra = await tratarTravaDoPiso(e);
          if (!extra) throw e;
          await api.post(`/anuncios/${i.anuncio_id}/publicar`, { ...corpo, ...extra });
        }
      }
      setOk('Preço enviado para a plataforma e registrado no histórico.');
      await onGravado();
    } catch (e) { setErro(e.message); } finally { setEnviando(false); }
  };
  const av = avaliacao;
  const situacaoNova = !av ? null : !av.ok ? 'sem_piso' : av.prejuizo ? 'prejuizo' : av.abaixoDoPiso ? 'abaixo' : (av.piso > 0 && Number(preco) < av.piso * 1.05 ? 'no_limite' : 'ok');
  return (
    <Gaveta aberta onFechar={onFechar} Icone={Pencil} titulo="Ajustar preço" subtitulo={<><Canal chave={linha.marketplace} nome={linha.loja_nome} /> · {linha.titulo}</>}
      rodape={<><button type="button" className="btn btn-ghost" onClick={onFechar}>Fechar</button><span style={{ flex: 1 }} /><button type="button" className="btn btn-primary" disabled={enviando || !(Number(preco) > 0) || Number(preco) === Number(item.preco)} onClick={publicar}><Save size={14} /> {enviando ? 'Enviando…' : 'Publicar na plataforma'}</button></>}>
      {erro && <p className="erro-inline">{erro}</p>}
      {ok && <p className="pv-form-ok"><CheckCircle2 size={13} /> {ok}</p>}
      <div className="pp-preco-grade">
        <div className="pp-preco-bloco"><span className="field-label">Hoje</span><b>{money(linha.preco)}</b>{linha.preco_max != null && linha.preco_max !== linha.preco && <small className="ink-soft">até {money(linha.preco_max)}</small>}<Situacao chave={linha.situacao} /></div>
        <div className="pp-preco-bloco"><span className="field-label">Piso do canal</span><b>{money(linha.piso)}</b><small className="ink-soft">margem mínima {pct(linha.margem_minima)}{linha.regra ? ` · ${linha.regra}` : ''}</small></div>
        <div className="pp-preco-bloco"><span className="field-label">Margem hoje</span><b className={linha.margem != null && linha.margem < 0 ? 'pv-ruim' : ''}>{pct(linha.margem)}</b><small className="ink-soft">{linha.unidades_30d != null ? `${formatQtd(linha.unidades_30d)} pç em 30 dias` : 'sem venda ligada em 30 dias'}</small></div>
      </div>
      {itens.length > 1 && (
        <label className="field" style={{ marginTop: 14 }}><span className="field-label">Variação para conferir a margem (o preço novo vai para todas)</span>
          <Select value={String(itemId)} onChange={(e) => setItemId(Number(e.target.value))}>{itens.map((i) => <option key={i.anuncio_id} value={String(i.anuncio_id)}>{i.anuncio_id_externo} · {money(i.preco)} · {SITUACOES[i.situacao]?.rotulo}</option>)}</Select>
        </label>
      )}
      <label className="field" style={{ marginTop: 14 }}><span className="field-label">Preço novo (R$)</span><NumInput step="0.01" min={0} value={preco} onChange={(n) => setPreco(n ?? '')} autoFocus /></label>
      {av && (
        <div className={`pp-previa ${situacaoNova}`}>
          {av.ok ? (
            <>
              <div><Situacao chave={situacaoNova} /></div>
              <dl className="pv-gaveta-dados">
                <dt>Margem neste preço</dt><dd><b className={av.margem < 0 ? 'pv-ruim' : ''}>{pct(av.margem)}</b> contra mínimo de {pct(av.regra?.margemMinima)}</dd>
                <dt>Sobra por peça</dt><dd>{money(av.lucroRS)}</dd>
                <dt>Piso</dt><dd>{money(av.piso)}{av.faltaParaPiso > 0 && <span className="pv-ruim"> · faltam {money(av.faltaParaPiso)}</span>}</dd>
              </dl>
              {av.abaixoDoPiso && <p className="pp-previa-aviso"><TriangleAlert size={13} /> Abaixo do piso: ao publicar, o sistema vai pedir o motivo e gravar quem assinou.</p>}
            </>
          ) : <p className="ink-soft" style={{ margin: 0 }}>{av.motivo}</p>}
        </div>
      )}
      {linha.url && <p style={{ marginTop: 14 }}><a className="btn btn-ghost btn-mini" href={linha.url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Abrir o anúncio na plataforma</a></p>}
    </Gaveta>
  );
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
function Auditoria({ dados, carregando, erro, recarregar, filtroSit, setFiltroSit }) {
  const [busca, setBusca] = useState('');
  const [canal, setCanal] = useState('');
  const [editando, setEditando] = useState(null);
  const [expandida, setExpandida] = useState(null);
  const linhas = useMemo(() => (dados?.linhas || []).filter((l) => (!canal || l.marketplace === canal) && (filtroSit.length === 0 || filtroSit.includes(l.situacao))
    && (!busca || `${l.titulo} ${l.referencia || ''} ${l.anuncio_id_externo}`.toLowerCase().includes(busca.toLowerCase()))), [dados, filtroSit, busca, canal]);
  const tabela = useTabela(linhas, {
    colunas: { titulo: (r) => r.titulo, canal: (r) => r.marketplace, referencia: (r) => r.referencia || '', preco: (r) => Number(r.preco || 0), margem: (r) => Number(r.margem ?? -9), vendas: (r) => Number(r.unidades_30d ?? -1), perda: (r) => Number(r.perda_30d || 0), situacao: (r) => ({ prejuizo: 0, abaixo: 1, no_limite: 2, sem_piso: 3, ok: 4 }[r.situacao]) },
    colunaPadrao: 'situacao', direcaoPadrao: 'asc', prefixo: 'pp-aud',
  });
  const t = dados?.totais;
  const Th = (p) => <ThOrdenavel atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} {...p} />;
  const filtrar = (lista) => setFiltroSit((atual) => (atual.length === lista.length && lista.every((x) => atual.includes(x)) ? [] : lista));
  const ativo = (lista) => filtroSit.length === lista.length && lista.every((x) => filtroSit.includes(x));
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      {t && (
        <div className="indicadores-faixa compacta pv-kpis">
          <button type="button" className={`pv-kpi-btn${ativo(['prejuizo']) ? ' ativo' : ''}`} onClick={() => filtrar(['prejuizo'])}><IndicadorDestaque destaque Icone={TriangleAlert} tom={t.prejuizo > 0 ? 'negativo' : 'positivo'} rotulo="Com prejuízo" valor={formatQtd(t.prejuizo)} explicacao="Anúncios no ar vendendo abaixo do custo. Clique para ver só eles." /></button>
          <button type="button" className={`pv-kpi-btn${ativo(['abaixo', 'no_limite']) ? ' ativo' : ''}`} onClick={() => filtrar(['abaixo', 'no_limite'])}><IndicadorDestaque Icone={ArrowDownRight} tom={t.abaixo > 0 ? 'atencao' : 'positivo'} rotulo="Abaixo do piso" valor={formatQtd(t.abaixo)} explicacao={`Mais ${formatQtd(t.noLimite)} no limite (até 5% acima do piso).`} /></button>
          <button type="button" className={`pv-kpi-btn${ativo(['prejuizo', 'abaixo']) ? ' ativo' : ''}`} onClick={() => filtrar(['prejuizo', 'abaixo'])}><IndicadorDestaque Icone={ScrollText} tom={t.perda30d > 0 ? 'negativo' : undefined} rotulo="Deixado na mesa" valor={money(t.perda30d)} explicacao="Nos últimos 30 dias, nos anúncios abaixo do piso com venda ligada a eles." /></button>
          <button type="button" className={`pv-kpi-btn${ativo(['sem_piso']) ? ' ativo' : ''}`} onClick={() => filtrar(['sem_piso'])}><IndicadorDestaque Icone={Ban} tom={t.semPiso > 0 ? 'atencao' : undefined} rotulo="Sem piso" valor={formatQtd(t.semPiso)} explicacao="Sem referência vinculada, sem custo ou canal sem tabela. Clique para ver quais." /></button>
        </div>
      )}
      <div className="filtros-linha">
        <Select value={canal} onChange={(e) => setCanal(e.target.value)} style={{ maxWidth: 180 }}><option value="">Todos os canais</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <MultiSelect valor={filtroSit} onChange={setFiltroSit} opcoes={Object.entries(SITUACOES).map(([k, v]) => ({ valor: k, rotulo: v.rotulo }))} placeholder="Qualquer situação" />
        <CampoBusca valor={busca} onChange={setBusca} placeholder="Título, referência ou código do anúncio" />
        <span style={{ flex: 1 }} />
        <span className="ink-soft" style={{ fontSize: 12.5 }}>{t ? `${plural(linhas.length, 'anúncio')} no filtro · ${formatQtd(t.anuncios)} no ar (${formatQtd(t.variacoes)} variações)` : ''}</span>
        <button type="button" className="btn btn-ghost" onClick={recarregar} disabled={carregando}><RefreshCw size={14} className={carregando ? 'girando' : ''} /> Atualizar</button>
      </div>
      {carregando && !dados ? <Skeleton height={200} radius={10} /> : linhas.length === 0 ? (
        <EstadoVazio Icone={ShieldCheck} titulo="Nenhum anúncio nesta situação" descricao={filtroSit.length ? 'Mude o filtro de situação (ou clique de novo no número do topo) para ver os demais.' : 'Nenhum anúncio no ar bate com a busca.'} />
      ) : (
        <section className="card" style={{ padding: 0 }}>
          <Paginacao {...tabela} posicao="topo" />
          <DataTable>
            <table className="data-table pp-tabela">
              <thead><tr><Th coluna="titulo">Anúncio</Th><Th coluna="canal">Canal</Th><Th coluna="referencia">Referência</Th><Th coluna="preco">Preço → piso</Th><Th coluna="margem">Margem / mínima</Th><Th coluna="vendas">Vendas 30 d</Th><Th coluna="perda">Na mesa</Th><Th coluna="situacao">Situação</Th><th /></tr></thead>
              <tbody>
                {tabela.itensPagina.map((l) => (
                  <FragmentoLinha key={l.anuncio_id}>
                    <tr className="clickable-row" onClick={() => setEditando(l)} title={l.motivo || l.regra || ''}>
                      <td className="pp-col-anuncio"><Anuncio l={l} /></td>
                      <td><Canal chave={l.marketplace} /></td>
                      <td>{l.referencia ? <><b>{l.referencia}</b>{l.classe && <span className="stamp sm tone-neutro pp-classe">{l.classe}</span>}</> : <span className="stamp sm tone-atencao">sem vínculo</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><b>{money(l.preco)}</b>{l.preco_max != null && l.preco_max !== l.preco && <span className="ink-soft"> a {money(l.preco_max)}</span>} <span className="ink-soft">→</span> {l.piso == null ? <span className="ink-soft" title={l.motivo || ''}>sem piso</span> : money(l.piso)}{l.falta > 0 && <div className="pv-ruim" style={{ fontSize: 11.5 }}>faltam {money(l.falta)}</div>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><b className={l.margem != null && l.margem < 0 ? 'pv-ruim' : ''}>{pct(l.margem)}</b> <span className="ink-soft">/ {pct(l.margem_minima)}</span></td>
                      <td>{l.unidades_30d == null ? <span className="ink-soft" title="sem venda ligada a este anúncio nos 30 dias">—</span> : `${formatQtd(l.unidades_30d)} pç`}</td>
                      <td>{l.perda_30d == null ? <span className="ink-soft" title="abaixo do piso, mas sem venda ligada ao anúncio para medir">?</span> : (l.perda_30d > 0 ? <b className="pv-ruim">{money(l.perda_30d)}</b> : <span className="ink-soft">—</span>)}</td>
                      <td><Situacao chave={l.situacao} />{l.situacao === 'sem_piso' && l.motivo && <div className="ink-soft" style={{ fontSize: 11.5, maxWidth: 220 }}>{l.motivo}</div>}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        {l.itens && <button type="button" className="icon-btn" title={`${l.variacoes} variações`} onClick={() => setExpandida(expandida === l.anuncio_id ? null : l.anuncio_id)}>{expandida === l.anuncio_id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>}
                        {l.piso != null && <button type="button" className="btn btn-ghost btn-mini" onClick={() => setEditando(l)}><Pencil size={12} /> Ajustar preço</button>}
                        {l.url && <a className="icon-btn" href={l.url} target="_blank" rel="noreferrer" title="Abrir na plataforma"><ExternalLink size={14} /></a>}
                      </td>
                    </tr>
                    {expandida === l.anuncio_id && l.itens && l.itens.map((i) => (
                      <tr key={i.anuncio_id} className="pp-linha-var">
                        <td className="pp-col-anuncio"><span className="ink-soft" style={{ paddingLeft: 38 }}>{i.anuncio_id_externo}</span></td>
                        <td /><td />
                        <td style={{ whiteSpace: 'nowrap' }}>{money(i.preco)} <span className="ink-soft">→</span> {money(i.piso)}</td>
                        <td>{pct(i.margem)}</td>
                        <td>{i.unidades_30d == null ? '—' : `${formatQtd(i.unidades_30d)} pç`}</td>
                        <td>{i.perda_30d > 0 ? money(i.perda_30d) : '—'}</td>
                        <td><Situacao chave={i.situacao} /></td>
                        <td style={{ textAlign: 'right' }}>{i.url && <a className="icon-btn" href={i.url} target="_blank" rel="noreferrer" title="Abrir na plataforma"><ExternalLink size={14} /></a>}</td>
                      </tr>
                    ))}
                  </FragmentoLinha>
                ))}
              </tbody>
            </table>
          </DataTable>
          <Paginacao {...tabela} posicao="rodape" />
        </section>
      )}
      {editando && <GavetaPreco linha={editando} onFechar={() => setEditando(null)} onGravado={async () => { await recarregar(); }} />}
    </div>
  );
}
function FragmentoLinha({ children }) { return <>{children}</>; }

// ---------------------------------------------------------------------------
// Simulador — três passos
// ---------------------------------------------------------------------------
function Passo({ n, titulo, extra, children }) {
  return <section className="card pp-passo"><div className="card-head pv-card-head"><span className="pp-passo-num">{n}</span> {titulo}{extra}</div>{children}</section>;
}
function Simulador({ dados }) {
  const [busca, setBusca] = useState('');
  const [canal, setCanal] = useState('');
  const [selecionados, setSelecionados] = useState(() => new Set()); // chaves de publicação
  const [tipo, setTipo] = useState('desconto_pct');
  const [valor, setValor] = useState(20);
  const [taxaPct, setTaxaPct] = useState('');
  const [taxaFixa, setTaxaFixa] = useState('');
  const [dias, setDias] = useState(30);
  const [resultado, setResultado] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const [salvas, setSalvas] = useState([]);
  const [escolhendo, setEscolhendo] = useState(false);
  useEffect(() => { api.get(`${ROTA}/simulacoes`).then(setSalvas).catch(() => {}); }, []);

  // Escolha por REFERÊNCIA × canal: cada opção junta os anúncios daquela
  // referência naquele canal (com todas as variações dentro).
  const opcoes = useMemo(() => {
    const m = new Map();
    for (const l of dados?.linhas || []) {
      const k = `${l.produto_id || `x${l.anuncio_id}`}|${l.marketplace}`;
      const o = m.get(k) || { chave: k, produto_id: l.produto_id, referencia: l.referencia, descricao: l.descricao, marketplace: l.marketplace, anuncios: 0, variacoes: 0, anuncio_ids: [], precoMin: null, situacao: 'ok', lojas: new Set(), titulo: l.titulo };
      o.anuncios += 1; o.variacoes += l.variacoes || 1; o.anuncio_ids.push(...(l.anuncio_ids || [l.anuncio_id])); o.lojas.add(l.loja_nome);
      if (l.preco != null && (o.precoMin == null || l.preco < o.precoMin)) o.precoMin = l.preco;
      const ordem = { prejuizo: 0, abaixo: 1, no_limite: 2, sem_piso: 3, ok: 4 }; if ((ordem[l.situacao] ?? 9) < (ordem[o.situacao] ?? 9)) o.situacao = l.situacao;
      m.set(k, o);
    }
    return [...m.values()].sort((a, b) => String(a.referencia || 'zzz').localeCompare(String(b.referencia || 'zzz')) || a.marketplace.localeCompare(b.marketplace));
  }, [dados]);
  const candidatos = useMemo(() => opcoes.filter((o) => (!canal || o.marketplace === canal) && (!busca || `${o.referencia || ''} ${o.descricao || ''} ${o.titulo || ''}`.toLowerCase().includes(busca.toLowerCase()))), [opcoes, canal, busca]);
  const escolhidos = opcoes.filter((o) => selecionados.has(o.chave));
  const idsEscolhidos = escolhidos.flatMap((o) => o.anuncio_ids);
  const alternar = (k) => { const n = new Set(selecionados); n.has(k) ? n.delete(k) : n.add(k); setSelecionados(n); };

  const simular = async () => {
    setOcupado(true); setErro(null);
    try {
      setResultado(await api.post(`${ROTA}/simular`, { anuncio_ids: idsEscolhidos.slice(0, 300), regra: { tipo, valor: Number(valor) }, taxa_campanha_pct: taxaPct === '' ? null : Number(taxaPct) / 100, taxa_campanha_fixa: taxaFixa === '' ? 0 : Number(taxaFixa), dias: Number(dias) }));
    } catch (e) { setErro(e.message); } finally { setOcupado(false); }
  };
  const [nome, setNome] = useState('');
  const salvar = async () => {
    if (!nome.trim() || !resultado) return;
    try { await api.post(`${ROTA}/simulacoes`, { nome: nome.trim(), marketplace: canal || null, parametros: resultado.parametros, resultado }); setNome(''); setSalvas(await api.get(`${ROTA}/simulacoes`)); } catch (e) { setErro(e.message); }
  };
  const t = resultado?.totais;
  const SIT = { melhora: ['Sobra mais', 'tone-saudavel'], precisa_vender_mais: ['Precisa vender mais', 'tone-atencao'], nao_fecha: ['Não fecha', 'tone-prejuizo'], sem_venda: ['Sem venda medida', 'tone-neutro'], sem_calculo: ['Sem cálculo', 'tone-neutro'] };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <Passo n="1" titulo="Escolher os anúncios" extra={<span className="ink-soft pp-passo-sub">{escolhidos.length === 0 ? 'nenhum escolhido' : `${plural(escolhidos.length, 'referência')} · ${plural(idsEscolhidos.length, 'anúncio')}${idsEscolhidos.length > 300 ? ' — só os 300 primeiros entram' : ''}`}</span>}>
        <div className="pp-escolhidos">
          {escolhidos.map((o) => <span key={o.chave} className="chip-filtro"><span className="chip-filtro-campo"><SeloPlataforma chave={o.marketplace} size={12} /></span><span className="chip-filtro-valor">{o.referencia || o.titulo}</span><button type="button" onClick={() => alternar(o.chave)} title="Tirar"><X size={11} /></button></span>)}
          <button type="button" className="btn btn-ghost" onClick={() => setEscolhendo(true)}><Plus size={14} /> {escolhidos.length ? 'Mudar a escolha' : 'Escolher referências'}</button>
          {escolhidos.length > 0 && <button type="button" className="btn btn-ghost btn-mini" onClick={() => setSelecionados(new Set())}>Limpar</button>}
        </div>
      </Passo>
      <Passo n="2" titulo="A campanha">
        <div className="pp-parametros">
          <label className="field"><span className="field-label">Tipo</span><span className="mp-seg">{[['desconto_pct', 'Desconto %'], ['cupom_pct', 'Cupom %'], ['preco_fixo', 'Preço fixo']].map(([k, r]) => <button key={k} type="button" aria-pressed={tipo === k} onClick={() => setTipo(k)}>{r}</button>)}</span></label>
          <label className="field"><span className="field-label">{tipo === 'preco_fixo' ? 'Preço (R$)' : 'Valor (%)'}</span><NumInput step={tipo === 'preco_fixo' ? '0.01' : '1'} min={0} value={valor} onChange={(n) => setValor(n ?? '')} /></label>
          <label className="field"><span className="field-label">Taxa da campanha (%)</span><NumInput step="0.1" min={0} placeholder="0" value={taxaPct} onChange={(n) => setTaxaPct(n ?? '')} /></label>
          <label className="field"><span className="field-label">Taxa fixa por peça (R$)</span><NumInput step="0.01" min={0} placeholder="0,00" value={taxaFixa} onChange={(n) => setTaxaFixa(n ?? '')} /></label>
          <label className="field"><span className="field-label">Velocidade medida nos últimos</span><NumInput step="1" min={7} value={dias} onChange={(n) => setDias(n ?? 30)} suffix="dias" /></label>
          <div className="field pp-simular-btn"><span className="field-label">&nbsp;</span><button type="button" className="btn btn-primary" disabled={ocupado || idsEscolhidos.length === 0} onClick={simular}><Calculator size={14} /> {ocupado ? 'Simulando…' : (idsEscolhidos.length ? `Simular ${plural(Math.min(300, idsEscolhidos.length), 'anúncio')}` : 'Escolha os anúncios')}</button></div>
        </div>
      </Passo>
      {t && (
        <Passo n="3" titulo="Resultado" extra={<span className="pp-guardar"><input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome para guardar" onKeyDown={(e) => e.key === 'Enter' && salvar()} /><button type="button" className="btn btn-ghost btn-mini" disabled={!nome.trim()} onClick={salvar}><Save size={12} /> Guardar</button></span>}>
          <div className="indicadores-faixa compacta" style={{ marginBottom: 12 }}>
            <IndicadorDestaque Icone={Calculator} rotulo="Sobra por dia hoje" valor={money(t.lucroDiaAtual)} explicacao={`${t.comVenda} de ${t.avaliados} anúncios com venda medida no período`} />
            <IndicadorDestaque Icone={Calculator} tom={t.lucroDiaCampanhaSemUplift < t.lucroDiaAtual ? 'atencao' : 'positivo'} rotulo="Na campanha, mesmo volume" valor={money(t.lucroDiaCampanhaSemUplift)} explicacao="Se vender igual a hoje" />
            <IndicadorDestaque Icone={ArrowUpRight} tom={t.upliftMedioNecessario > 0.5 ? 'negativo' : (t.upliftMedioNecessario > 0 ? 'atencao' : 'positivo')} rotulo="Para empatar" valor={t.upliftMedioNecessario == null ? (t.lucroDiaCampanhaSemUplift <= 0 && t.comVenda > 0 ? 'não empata' : '—') : (t.upliftMedioNecessario <= 0 ? 'já empata' : `+${pct(t.upliftMedioNecessario, 0)}`)} explicacao="De peças a mais por dia, no conjunto" />
            <IndicadorDestaque Icone={TriangleAlert} tom={t.naoFecha + t.abaixoDoPiso > 0 ? 'negativo' : undefined} rotulo="Não fecha / abaixo do piso" valor={`${t.naoFecha} / ${t.abaixoDoPiso}`} explicacao="Lucro zero ou negativo · abaixo da margem mínima" />
          </div>
          <DataTable>
            <table className="data-table">
              <thead><tr><th>Anúncio</th><th>Canal</th><th>Hoje</th><th>Campanha</th><th>Sobra/pç hoje</th><th>Sobra/pç campanha</th><th>Vende/dia</th><th>Precisa vender</th><th>Situação</th></tr></thead>
              <tbody>
                {resultado.itens.map((i) => (
                  <tr key={i.anuncio_id}>
                    <td className="pp-col-anuncio"><Anuncio l={{ ...i, loja_nome: i.loja_nome, anuncio_id_externo: i.anuncio_id_externo || (i.referencia || 'sem referência') }} /></td>
                    <td><Canal chave={i.marketplace} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{money(i.precoAtual)}<div className="ink-soft" style={{ fontSize: 11.5 }}>{pct(i.margemAtual)}</div></td>
                    <td style={{ whiteSpace: 'nowrap' }}><b>{money(i.precoCampanha)}</b><div className="ink-soft" style={{ fontSize: 11.5 }}>{pct(i.margemCampanha)}{i.taxaCampanhaRS > 0 && ` · taxa ${money(i.taxaCampanhaRS)}`}</div></td>
                    <td>{money(i.lucroAtual)}</td>
                    <td className={i.lucroCampanha != null && i.lucroCampanha <= 0 ? 'pv-ruim' : ''}>{money(i.lucroCampanha)}</td>
                    <td>{i.vendasDia == null ? <span className="ink-soft" title="sem venda ligada ao anúncio no período">—</span> : numeroBr(i.vendasDia, 2)}</td>
                    <td>{i.vendasDiaParaEmpatar != null ? <><b>{numeroBr(i.vendasDiaParaEmpatar, 2)}</b>/dia <span className="ink-soft">({fator(i.fatorEmpate)})</span></> : (i.fatorEmpate != null && i.fatorEmpate > 1 ? <span className="ink-soft" title="precisaria vender este tanto de vezes o volume de hoje — mas não há venda medida para dizer quanto é">{fator(i.fatorEmpate)} do volume</span> : '—')}</td>
                    <td><span className={`stamp sm ${SIT[i.situacao]?.[1] || 'tone-neutro'}`}>{SIT[i.situacao]?.[0] || i.motivo || '—'}</span>{i.abaixoDoPiso && <span className="stamp sm tone-abaixo" style={{ marginLeft: 6 }} title={`piso ${money(i.piso)}`}>abaixo do piso</span>}{i.motivo && <div className="ink-soft" style={{ fontSize: 11.5 }}>{i.motivo}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        </Passo>
      )}
      {salvas.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-head pv-card-head"><Save size={14} /> Simulações guardadas <span className="pv-contador">{salvas.length}</span></div>
          <table className="data-table"><thead><tr><th>Quando</th><th>Nome</th><th>Campanha</th><th>Sobra/dia hoje</th><th>Na campanha</th><th>Para empatar</th><th>Quem</th></tr></thead>
            <tbody>{salvas.map((s) => (
              <tr key={s.id}><td>{dataBr(String(s.criada_em).slice(0, 10))}</td><td><b>{s.nome}</b></td><td>{s.parametros?.regra ? `${s.parametros.regra.tipo === 'preco_fixo' ? 'R$ ' : ''}${s.parametros.regra.valor}${s.parametros.regra.tipo !== 'preco_fixo' ? '%' : ''}` : '—'}</td><td>{money(s.totais?.lucroDiaAtual)}</td><td>{money(s.totais?.lucroDiaCampanhaSemUplift)}</td><td>{s.totais?.upliftMedioNecessario == null ? '—' : pct(s.totais.upliftMedioNecessario, 0)}</td><td>{s.criada_por_nome || '—'}</td></tr>
            ))}</tbody></table>
        </section>
      )}

      {escolhendo && (
        <Gaveta aberta larga onFechar={() => setEscolhendo(false)} Icone={Search} titulo="Escolher referências" subtitulo="Uma linha por referência e canal; todas as variações do anúncio entram juntas."
          rodape={<><span className="ink-soft" style={{ fontSize: 12.5 }}>{plural(escolhidos.length, 'referência')} · {plural(idsEscolhidos.length, 'anúncio')}</span><span style={{ flex: 1 }} /><button type="button" className="btn btn-ghost" onClick={() => setSelecionados(new Set(candidatos.map((c) => c.chave)))}>Marcar {candidatos.length === opcoes.length ? 'todas' : `as ${candidatos.length} da busca`}</button><button type="button" className="btn btn-primary" onClick={() => setEscolhendo(false)}>Pronto</button></>}>
          <div className="filtros-linha" style={{ marginBottom: 10 }}>
            <Select value={canal} onChange={(e) => setCanal(e.target.value)} style={{ maxWidth: 170 }}><option value="">Todos os canais</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <CampoBusca valor={busca} onChange={setBusca} placeholder="Referência, descrição ou título" autoFocus />
          </div>
          <table className="data-table pv-mini">
            <thead><tr><th /><th>Referência</th><th>Canal</th><th>Anúncios</th><th>Preço</th><th>Situação</th></tr></thead>
            <tbody>{candidatos.slice(0, 400).map((o) => (
              <tr key={o.chave} className={`clickable-row${selecionados.has(o.chave) ? ' pp-sel-on' : ''}`} onClick={() => alternar(o.chave)}>
                <td style={{ width: 28 }}><Toggle checked={selecionados.has(o.chave)} onChange={() => alternar(o.chave)} /></td>
                <td>{o.referencia ? <><b>{o.referencia}</b> <span className="ink-soft">{o.descricao}</span></> : <><span className="stamp sm tone-atencao">sem vínculo</span> <span className="ink-soft">{o.titulo}</span></>}</td>
                <td><Canal chave={o.marketplace} /><div className="ink-soft" style={{ fontSize: 11 }}>{[...o.lojas].join(', ')}</div></td>
                <td>{o.anuncios}{o.variacoes > o.anuncios && <span className="ink-soft"> ({o.variacoes} var.)</span>}</td>
                <td>{money(o.precoMin)}</td>
                <td><Situacao chave={o.situacao} /></td>
              </tr>
            ))}</tbody>
          </table>
          {candidatos.length > 400 && <p className="pv-nota"><Info size={13} /> Mostrando 400 de {candidatos.length}. Refine pela busca.</p>}
        </Gaveta>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concorrentes
// ---------------------------------------------------------------------------
function Concorrentes({ produtos }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [lendo, setLendo] = useState(false);
  const [novo, setNovo] = useState(null);
  const carregar = useCallback(async () => { try { setDados(await api.get(`${ROTA}/concorrentes`)); } catch (e) { setErro(e.message); } }, []);
  useEffect(() => { carregar(); }, [carregar]);
  const ler = async () => { setLendo(true); setErro(null); try { const r = await api.post(`${ROTA}/concorrentes/ler`, {}); if (r.semIntegracao) setErro('Nenhuma conta do Mercado Livre conectada — só o preço digitado à mão fica disponível.'); await carregar(); } catch (e) { setErro(e.message); } finally { setLendo(false); } };
  const criar = async () => { setErro(null); try { await api.post(`${ROTA}/concorrentes`, novo); setNovo(null); await carregar(); } catch (e) { setErro(e.message); } };
  const remover = async (c) => { if (!(await confirmar(`Parar de acompanhar "${c.titulo || c.item_id_externo || c.vendedor}"?`, { titulo: 'Remover concorrente', confirmarTexto: 'Remover', perigo: true }))) return; try { await api.del(`${ROTA}/concorrentes/${c.id}`); await carregar(); } catch (e) { setErro(e.message); } };
  const editarPreco = async (c, preco) => { try { await api.put(`${ROTA}/concorrentes/${c.id}`, { preco }); await carregar(); } catch (e) { setErro(e.message); } };
  const linhas = dados?.linhas || [];
  const t = dados?.totais;
  const abrirNovo = () => setNovo({ produto_id: '', marketplace: 'mercado_livre', url: '', preco: '', titulo: '' });
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      {t && linhas.length > 0 && (
        <div className="indicadores-faixa compacta">
          <IndicadorDestaque destaque Icone={Users} rotulo="Acompanhados" valor={formatQtd(t.concorrentes)} explicacao="Anúncios de concorrente e vitrines de catálogo" />
          <IndicadorDestaque Icone={ArrowDownRight} tom={t.maisBaratos > 0 ? 'atencao' : 'positivo'} rotulo="Mais baratos que nós" valor={formatQtd(t.maisBaratos)} explicacao="No mesmo canal" />
          <IndicadorDestaque Icone={TriangleAlert} tom={t.comErro > 0 ? 'negativo' : undefined} rotulo="Com erro de leitura" valor={formatQtd(t.comErro)} explicacao={dados.leituraMlDisponivel ? 'Leitura automática pelo Mercado Livre ativa' : 'Sem conta do Mercado Livre conectada'} />
          <IndicadorDestaque Icone={Info} rotulo="Sem preço ainda" valor={formatQtd(t.semLeitura)} explicacao="Cadastrados e ainda não lidos" />
        </div>
      )}
      <div className="filtros-linha">
        <button type="button" className="btn btn-primary" onClick={abrirNovo}><Plus size={14} /> Acompanhar concorrente</button>
        <button type="button" className="btn btn-ghost" onClick={ler} disabled={lendo}><RefreshCw size={14} className={lendo ? 'girando' : ''} /> Ler preços agora</button>
        <span className="ink-soft" style={{ fontSize: 12.5 }}>Anúncio do Mercado Livre é lido a cada 6 horas; nos outros canais o preço é digitado.</span>
      </div>
      {!dados ? <Skeleton height={160} /> : linhas.length === 0 ? (
        <EstadoVazio Icone={Users} titulo="Nenhum concorrente acompanhado" descricao="Cole o link do anúncio de um concorrente do Mercado Livre numa referência sua; o preço é lido na hora e a cada 6 horas. Para os outros canais, digite o preço." acaoLabel="Acompanhar concorrente" onAcao={abrirNovo} IconeAcao={Plus} />
      ) : (
        <section className="card" style={{ padding: 0 }}>
          <DataTable>
            <table className="data-table">
              <thead><tr><th>Referência</th><th>Canal</th><th>Concorrente</th><th>Preço deles</th><th>Nosso</th><th>Diferença</th><th>Variação</th><th>Lido</th><th /></tr></thead>
              <tbody>
                {linhas.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.referencia}</b> <span className="ink-soft">{c.descricao}</span></td>
                    <td><Canal chave={c.marketplace} /></td>
                    <td style={{ maxWidth: 320 }}>
                      {c.origem === 'catalogo' && <span className="stamp sm tone-elevada">vitrine do catálogo</span>} {c.titulo || c.vendedor || c.item_id_externo}
                      {c.url && <a href={c.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }} title="Abrir"><ExternalLink size={11} /></a>}
                      {c.observacao && <div className="ink-soft" style={{ fontSize: 11.5 }}>{c.observacao}</div>}
                      {c.ultimo_erro && <div className="pv-ruim" style={{ fontSize: 11.5 }}><TriangleAlert size={11} /> {c.ultimo_erro}</div>}
                    </td>
                    <td>{c.origem === 'manual' ? <NumInput className="pp-preco-manual" step="0.01" min={0} value={c.preco ?? ''} onChange={() => {}} onBlur={(e) => { const v = Number(String(e.target.value).replace(/\./g, '').replace(',', '.')); if (v > 0 && v !== Number(c.preco)) editarPreco(c, v); }} /> : <b>{money(c.preco)}</b>}</td>
                    <td>{money(c.nosso_preco)}{c.nossos_anuncios > 1 && <small className="ink-soft"> (menor de {c.nossos_anuncios})</small>}</td>
                    <td className={c.diferenca_pct != null && c.diferenca_pct < 0 ? 'pv-ruim' : ''}>{c.diferenca_pct == null ? '—' : <>{c.diferenca_pct < 0 ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />} {pct(Math.abs(c.diferenca_pct))} {c.diferenca_pct < 0 ? 'mais barato' : 'mais caro'}</>}</td>
                    <td>{c.variacao_pct == null ? '—' : `${c.variacao_pct > 0 ? '+' : ''}${pct(c.variacao_pct)}`}</td>
                    <td>{c.lido_em ? dataBr(String(c.lido_em).slice(0, 10)) : '—'}</td>
                    <td style={{ textAlign: 'right' }}><button type="button" className="icon-btn perigo" title="Parar de acompanhar" onClick={() => remover(c)}><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        </section>
      )}
      {novo && (
        <Gaveta aberta onFechar={() => setNovo(null)} Icone={Users} titulo="Acompanhar concorrente" subtitulo="Um anúncio de concorrente ligado a uma referência sua."
          rodape={<><button type="button" className="btn btn-ghost" onClick={() => setNovo(null)}>Cancelar</button><span style={{ flex: 1 }} /><button type="button" className="btn btn-primary" disabled={!novo.produto_id || (novo.marketplace === 'mercado_livre' ? !novo.url : !(novo.preco || novo.titulo))} onClick={criar}><Save size={14} /> Acompanhar</button></>}>
          <div className="pv-form">
            <label className="field"><span className="field-label">Referência nossa</span>
              <Select value={novo.produto_id} onChange={(e) => setNovo({ ...novo, produto_id: e.target.value })} chaveRecentes="pp_produto" placeholder="— escolher —">
                <option value="">— escolher —</option>
                {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
              </Select>
            </label>
            <label className="field"><span className="field-label">Canal</span><Select value={novo.marketplace} onChange={(e) => setNovo({ ...novo, marketplace: e.target.value })}>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></label>
            <label className="field"><span className="field-label">{novo.marketplace === 'mercado_livre' ? 'Link ou MLB do anúncio' : 'Link do anúncio (opcional)'}</span><input value={novo.url} onChange={(e) => setNovo({ ...novo, url: e.target.value })} placeholder={novo.marketplace === 'mercado_livre' ? 'https://produto.mercadolivre.com.br/MLB-123456789-...' : 'https://…'} /></label>
            {novo.marketplace !== 'mercado_livre' && (
              <>
                <label className="field"><span className="field-label">Nome / vendedor</span><input value={novo.titulo} onChange={(e) => setNovo({ ...novo, titulo: e.target.value })} /></label>
                <label className="field"><span className="field-label">Preço (R$)</span><NumInput step="0.01" min={0} value={novo.preco} onChange={(n) => setNovo({ ...novo, preco: n ?? '' })} /></label>
              </>
            )}
          </div>
        </Gaveta>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------
function Regras({ produtos }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [novo, setNovo] = useState(null);
  const [excecoes, setExcecoes] = useState([]);
  const [verExcecoes, setVerExcecoes] = useState(false);
  const carregar = useCallback(async () => { try { setDados(await api.get(`${ROTA}/regras`)); setExcecoes(await api.get(`${ROTA}/excecoes`)); } catch (e) { setErro(e.message); } }, []);
  useEffect(() => { carregar(); }, [carregar]);
  const salvar = async () => {
    setErro(null);
    try {
      await api.post(`${ROTA}/regras`, { marketplace: novo.marketplace || null, classe_abc: novo.classe_abc || null, produto_id: novo.produto_id || null, margem_minima: Number(novo.margem) / 100, pct_ads: novo.ads === '' ? null : Number(novo.ads) / 100, pct_devolucao: novo.dev === '' ? null : Number(novo.dev) / 100, incluir_embalagem: novo.embalagem !== false, observacao: novo.observacao || null });
      setNovo(null); await carregar();
    } catch (e) { setErro(e.message); }
  };
  const desativar = async (r) => { if (!(await confirmar('Desativar esta regra? O piso volta a seguir a regra mais geral.', { titulo: 'Desativar regra', confirmarTexto: 'Desativar', perigo: true }))) return; try { await api.del(`${ROTA}/regras/${r.id}`); await carregar(); } catch (e) { setErro(e.message); } };
  if (!dados) return <Skeleton height={120} radius={10} />;
  const ativas = dados.regras.filter((r) => r.ativo);
  const abrirNova = () => setNovo({ marketplace: '', classe_abc: '', produto_id: '', margem: 15, ads: '', dev: '', embalagem: true, observacao: '' });
  const escopo = (n) => [n.produto_id ? (produtos.find((p) => String(p.id) === String(n.produto_id))?.referencia || `referência #${n.produto_id}`) : null, n.marketplace ? CANAIS[n.marketplace] : null, n.classe_abc ? `classe ${n.classe_abc}` : null].filter(Boolean).join(' · ') || 'todos os anúncios (regra geral)';
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <section className="card pp-geral">
        <div className="pp-geral-textos"><h4><SlidersHorizontal size={15} /> Sem regra, vale a margem mínima geral: <b>{pct(dados.geral.margemMinima)}</b></h4>
          <p className="ink-soft">Definida em Configurações → Parâmetros, com a embalagem de {money(dados.geral.custoEmbalagem)} por peça e sem publicidade nem devolução previstas. As regras abaixo refinam por canal, classe ABC ou referência — a mais específica vence.</p>
        </div>
        {dados.podeEditar ? <button type="button" className="btn btn-primary" onClick={abrirNova}><Plus size={14} /> Nova regra</button> : <span className="stamp sm tone-neutro">só quem tem Configurações edita</span>}
      </section>

      <section className="card" style={{ padding: 0 }}>
        <div className="card-head pv-card-head"><SlidersHorizontal size={14} /> Regras ativas <span className="pv-contador">{ativas.length}</span>{ativas.length === 0 && <span className="ink-soft pp-passo-sub">nenhuma — vale a geral</span>}</div>
        {ativas.length > 0 && (
          <DataTable>
            <table className="data-table">
              <thead><tr><th>Vale para</th><th>Margem mínima</th><th>Publicidade prevista</th><th>Devolução prevista</th><th>Embalagem no custo</th><th>Observação</th><th>Quem definiu</th><th /></tr></thead>
              <tbody>{ativas.map((r) => (
                <tr key={r.id}>
                  <td>{r.produto_id ? <b>{r.referencia} </b> : null}{r.marketplace ? <Canal chave={r.marketplace} /> : null}{r.classe_abc ? <span className="stamp sm tone-neutro" style={{ marginLeft: 4 }}>classe {r.classe_abc}</span> : null}{!r.produto_id && !r.marketplace && !r.classe_abc ? 'todos os anúncios' : null}</td>
                  <td><b>{pct(r.margem_minima)}</b></td><td>{r.pct_ads == null ? <span className="ink-soft">não desconta</span> : pct(r.pct_ads)}</td><td>{r.pct_devolucao == null ? <span className="ink-soft">não desconta</span> : pct(r.pct_devolucao)}</td><td>{r.incluir_embalagem ? 'sim' : 'não'}</td>
                  <td>{r.observacao || <span className="ink-soft">—</span>}</td><td>{r.definido_por_nome || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{dados.podeEditar && <button type="button" className="btn btn-ghost btn-mini" onClick={() => desativar(r)}><X size={12} /> Desativar</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </DataTable>
        )}
      </section>

      <section className="card" style={{ padding: 0 }}>
        <button type="button" className="card-head pv-card-head pp-card-head-btn" onClick={() => setVerExcecoes(!verExcecoes)}><ScrollText size={14} /> Quem vendeu abaixo do piso <span className="pv-contador">{excecoes.length}</span><span style={{ marginLeft: 'auto' }}>{verExcecoes ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span></button>
        {verExcecoes && (excecoes.length === 0 ? <p className="ink-soft" style={{ padding: '0 18px 16px', margin: 0 }}>Ninguém ainda — toda alteração de preço e promoção abaixo do piso passa a aparecer aqui, com o motivo assinado.</p> : (
          <DataTable>
            <table className="data-table"><thead><tr><th>Quando</th><th>Onde</th><th>Referência</th><th>Preço</th><th>Piso</th><th>Margem / mínima</th><th>Motivo</th><th>Quem</th></tr></thead>
              <tbody>{excecoes.map((e) => (
                <tr key={e.id}><td>{dataBr(String(e.registrado_em).slice(0, 10))}</td><td>{e.origem === 'promocao' ? `promoção${e.promocao_nome ? ` "${e.promocao_nome}"` : ''}` : 'anúncio'}<div className="ink-soft" style={{ fontSize: 11.5 }}>{e.anuncio_titulo}</div></td><td>{e.referencia || '—'}</td><td>{money(e.preco)}</td><td>{money(e.piso)}</td><td>{pct(e.margem_no_preco)} <span className="ink-soft">/ {pct(e.margem_minima)}</span></td><td style={{ maxWidth: 320 }}>{e.motivo}</td><td>{e.usuario_nome || '—'}</td></tr>
              ))}</tbody></table>
          </DataTable>
        ))}
      </section>

      {novo && (
        <Gaveta aberta onFechar={() => setNovo(null)} Icone={SlidersHorizontal} titulo="Nova regra de piso" subtitulo={<>Vale para: <b>{escopo(novo)}</b></>}
          rodape={<><button type="button" className="btn btn-ghost" onClick={() => setNovo(null)}>Cancelar</button><span style={{ flex: 1 }} /><button type="button" className="btn btn-primary" disabled={!(Number(novo.margem) >= 0)} onClick={salvar}><Save size={14} /> Salvar regra</button></>}>
          <div className="pv-form">
            <label className="field"><span className="field-label">Canal</span><Select value={novo.marketplace} onChange={(e) => setNovo({ ...novo, marketplace: e.target.value })}><option value="">Todos os canais</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></label>
            <label className="field"><span className="field-label">Classe ABC</span><span className="mp-seg">{['', 'A', 'B', 'C'].map((c) => <button key={c || 'x'} type="button" aria-pressed={novo.classe_abc === c} onClick={() => setNovo({ ...novo, classe_abc: c })}>{c || 'Todas'}</button>)}</span></label>
            <label className="field"><span className="field-label">Referência</span>
              <Select value={novo.produto_id} onChange={(e) => setNovo({ ...novo, produto_id: e.target.value })} chaveRecentes="pp_regra_produto">
                <option value="">Todas as referências</option>
                {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
              </Select>
            </label>
            <div className="pp-form-linha">
              <label className="field"><span className="field-label">Margem mínima (%)</span><NumInput step="0.1" min={0} value={novo.margem} onChange={(n) => setNovo({ ...novo, margem: n ?? '' })} /></label>
              <label className="field"><span className="field-label">Publicidade prevista (%)</span><NumInput step="0.1" min={0} placeholder="não descontar" value={novo.ads} onChange={(n) => setNovo({ ...novo, ads: n ?? '' })} /></label>
              <label className="field"><span className="field-label">Devolução prevista (%)</span><NumInput step="0.1" min={0} placeholder="não descontar" value={novo.dev} onChange={(n) => setNovo({ ...novo, dev: n ?? '' })} /></label>
            </div>
            <div className="pv-toggle-linha"><Toggle checked={novo.embalagem} onChange={(e) => setNovo({ ...novo, embalagem: e.target.checked })} /><span>Embalagem entra no custo <span className="ink-soft">({money(dados.geral.custoEmbalagem)} por peça)</span></span></div>
            <label className="field"><span className="field-label">Observação</span><input value={novo.observacao} onChange={(e) => setNovo({ ...novo, observacao: e.target.value })} placeholder="por que esta regra existe" /></label>
          </div>
        </Gaveta>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function PisoPrecoPage() {
  const [aba, setAba] = useState('auditoria');
  const [ajuda, setAjuda] = useState(false);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [filtroSit, setFiltroSit] = useState(['prejuizo', 'abaixo', 'no_limite']);
  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try { setDados(await api.get(`${ROTA}/auditoria`)); } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);
  // As referências que têm anúncio no ar — para escolher em Concorrentes e Regras.
  const produtos = useMemo(() => {
    const vistos = new Map();
    for (const l of dados?.linhas || []) if (l.produto_id && !vistos.has(l.produto_id)) vistos.set(l.produto_id, { id: l.produto_id, referencia: l.referencia, descricao: l.descricao });
    return [...vistos.values()].sort((a, b) => String(a.referencia).localeCompare(String(b.referencia)));
  }, [dados]);
  const abas = [['auditoria', 'Auditoria dos anúncios'], ['simular', 'Simular campanha'], ['concorrentes', 'Concorrentes'], ['regras', 'Regras']];
  return (
    <div className="pagina pv-pagina">
      <header className="pagina-topo">
        <div><h1><ShieldCheck size={20} /> Piso de Preço</h1><p className="page-sub">O menor preço que cada canal aguenta por referência. Abaixo dele, quem vende assina o motivo.</p></div>
      </header>
      <div className="subtab-row">{abas.map(([k, r]) => <button key={k} type="button" className={`subtab-btn ${aba === k ? 'active' : ''}`} onClick={() => setAba(k)}>{r}</button>)}</div>
      {aba === 'auditoria' && <Auditoria dados={dados} carregando={carregando} erro={erro} recarregar={carregar} filtroSit={filtroSit} setFiltroSit={setFiltroSit} />}
      {aba === 'simular' && (dados ? <Simulador dados={dados} /> : <Skeleton height={200} />)}
      {aba === 'concorrentes' && <Concorrentes produtos={produtos} />}
      {aba === 'regras' && <Regras produtos={produtos} />}
      <div>
        <button type="button" className="mp-ajuda-btn" onClick={() => setAjuda(!ajuda)}>{ajuda ? <X size={13} /> : <Info size={13} />} Como esta tela calcula</button>
        {ajuda && (
          <div className="mp-ajuda" style={{ marginTop: 8 }}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li><b>Piso</b> = o preço que deixa a margem mínima da regra depois de imposto da empresa, comissão da faixa do canal (a tabela de Taxas de Marketplace), frete subsidiado pelo peso, taxas de venda (cartão, antecipação) e, quando a regra pede, publicidade e devolução previstas e a embalagem. É a mesma formação de preço de Análises › Preço por Canal, com a margem mínima no lugar da desejada.</li>
              <li><b>Uma linha por anúncio</b>, como no painel da plataforma: no Mercado Livre cada cor é um item separado com o mesmo preço e o mesmo piso; a linha mostra a pior situação entre as variações, o menor preço e a soma das vendas. A seta abre as variações.</li>
              <li><b>Regra que vale</b>: a mais específica — referência, depois canal + classe, canal, classe, geral. Sem regra, a margem mínima das Configurações. A classe ABC é a mesma da Cobertura (margem de contribuição, 26 semanas).</li>
              <li><b>Trava</b>: ao alterar o preço (aqui ou em Anúncios) ou criar/editar uma promoção abaixo do piso, o sistema pede confirmação e motivo; o motivo fica gravado com quem assinou. Anúncio sem referência, sem custo ou canal sem tabela não tem piso — e não trava.</li>
              <li><b>Simulador</b>: preço de campanha = desconto/cupom sobre o preço corrente (ou preço fixo), arredondado para baixo; a comissão é recalculada na faixa do preço novo; a taxa da campanha é a que você informar. "Precisa vender" = sobra por peça hoje ÷ sobra por peça na campanha × peças/dia medidas nos últimos N dias por este anúncio. Sem venda medida, a linha diz isso em vez de inventar um número.</li>
              <li><b>Concorrentes</b>: anúncio do Mercado Livre é lido pela API a cada 6 horas (precisa de uma conta ML conectada); nos outros canais o preço é digitado. "Vitrine do catálogo" é o preço para ganhar que o ML devolve para os nossos anúncios de catálogo.</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
