import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MessageSquareWarning, RefreshCw, Info, X, Undo2, MessageCircleQuestion, Star, ShieldAlert, Ruler, Scissors, ImageOff, Truck, PackageX,
  ChevronDown, ChevronRight, Check, Send, Search, Plus, Save, TriangleAlert, ExternalLink,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, Select, NumInput, Paginacao, CampoBusca } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { brl, formatQtd, dataBr, plural } from '../lib/format';
import { useTabela } from '../lib/useTabela';
import { SeloPlataforma } from '../lib/canalMarketplace';
import { confirmar } from '../components/ConfirmDialog';

// Marketplace › Pós-venda (21/09/2026) — frente 3: o que o cliente diz depois
// de comprar, de todos os canais, ligado a referência × cor × tamanho.
//
// Quatro abas:
//   O que exige ação — perguntas sem resposta, reclamações abertas, devoluções
//                      em andamento, avaliações ruins, referências devolvendo
//                      demais, sinais de modelagem. Regra fixa, sem IA.
//   Por referência   — taxa de devolução, motivos, tamanhos, para QUEM a
//                      informação serve (modelagem, qualidade, anúncio...).
//   Eventos          — a lista, com classificação de motivo à mão e resposta
//                      de pergunta (ML) pela plataforma.
//   Devoluções no Hub — a devolução registrada à mão (tabela de 0060), que
//                      até hoje só tinha backend.

const ROTA = '/pos-venda';
const CANAIS = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein', manual: 'No Hub' };
const TIPOS = { devolucao: { rotulo: 'Devolução', Icone: Undo2 }, reclamacao: { rotulo: 'Reclamação', Icone: ShieldAlert }, pergunta: { rotulo: 'Pergunta', Icone: MessageCircleQuestion }, avaliacao: { rotulo: 'Avaliação', Icone: Star } };
const ALIMENTA_ICONE = { modelagem: Ruler, qualidade: Scissors, anuncio: ImageOff, expedicao: PackageX, logistica: Truck };
const pct = (v, casas = 1) => (v == null ? '—' : `${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`);
const quando = (iso) => (iso ? `${dataBr(String(iso).slice(0, 10))} ${new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '—');

function Canal({ chave }) { return <span className="pp-canal"><SeloPlataforma chave={chave} size={14} /> {CANAIS[chave] || chave}</span>; }
function Tipo({ chave }) { const t = TIPOS[chave] || { rotulo: chave, Icone: Info }; const { Icone } = t; return <span className="pv-tipo"><Icone size={12} /> {t.rotulo}</span>; }
function Estrelas({ n }) { return n == null ? null : <span className="pv-estrelas" title={`${n} de 5`}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span>; }

// ---------------------------------------------------------------------------
function Acao({ painel, onIr }) {
  const itens = painel?.acao || [];
  const urgentes = itens.filter((i) => i.nivel === 'urgente');
  const demais = itens.filter((i) => i.nivel !== 'urgente');
  if (itens.length === 0) return <EstadoVazio Icone={Check} titulo="Nada exige ação agora" descricao="Sem pergunta parada, reclamação aberta, devolução em andamento, avaliação ruim sem tratar ou referência devolvendo demais na janela." />;
  const Lista = ({ lista, titulo, tom }) => lista.length === 0 ? null : (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className={`mp-tecido-topo ${tom === 'urgente' ? 'pv-topo-urgente' : ''}`}><TriangleAlert size={14} /><h4>{titulo}</h4><span style={{ fontSize: 12, opacity: .8 }}>{lista.length}</span></div>
      <ul className="pv-acoes">
        {lista.map((i) => (
          <li key={i.chave}>
            <Tipo chave={i.tipo === 'referencia' || i.tipo === 'modelagem' ? 'devolucao' : i.tipo} />
            {i.marketplace && <Canal chave={i.marketplace} />}
            <span className="pv-acao-texto">{i.texto}</span>
            <button type="button" className="btn-sec btn-mini" onClick={() => onIr(i)}>{i.eventoId ? 'Abrir' : 'Ver referência'} <ChevronRight size={12} /></button>
          </li>
        ))}
      </ul>
    </section>
  );
  return <div style={{ display: 'grid', gap: 14 }}><Lista lista={urgentes} titulo="Urgente" tom="urgente" /><Lista lista={demais} titulo="Atenção" /></div>;
}

// ---------------------------------------------------------------------------
function PorReferencia({ painel, onVerEventos }) {
  const [abertas, setAbertas] = useState(() => new Set());
  const [busca, setBusca] = useState('');
  const linhas = useMemo(() => (painel?.porReferencia || []).filter((r) => !busca || `${r.referencia} ${r.descricao || ''}`.toLowerCase().includes(busca.toLowerCase())), [painel, busca]);
  const tabela = useTabela(linhas, { colunas: { referencia: (r) => r.referencia, taxa: (r) => Number(r.taxaDevolucao ?? -1), pecas: (r) => r.pecasDevolvidas, nota: (r) => Number(r.notaMedia ?? 9) }, colunaPadrao: 'taxa', direcaoPadrao: 'desc', prefixo: 'pv-ref' });
  const alternar = (id) => { const n = new Set(abertas); n.has(id) ? n.delete(id) : n.add(id); setAbertas(n); };
  if (!painel) return <Skeleton height={200} />;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {painel.alimenta.length > 0 && (
        <section className="card pv-alimenta">
          <h4><Info size={14} /> Para quem o pós-venda está falando</h4>
          <div className="pv-alimenta-lista">
            {painel.alimenta.map((a) => { const Icone = ALIMENTA_ICONE[a.area] || Info; return <div key={a.area} className={`pv-alimenta-item pv-a-${a.area}`}><Icone size={16} /><div><b>{plural(a.n, 'peça')}</b><span>{a.rotulo}</span></div></div>; })}
          </div>
        </section>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><CampoBusca valor={busca} onChange={setBusca} placeholder="Referência ou descrição" /><span className="ink-soft" style={{ fontSize: 12 }}>{linhas.length} referências com evento na janela</span></div>
      {linhas.length === 0 ? <EstadoVazio Icone={Undo2} titulo="Nenhuma referência com evento na janela" descricao="Sincronize as lojas ou registre uma devolução no Hub." /> : (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <Paginacao {...tabela} posicao="topo" />
          <div className="mp-lista" style={{ border: 0, boxShadow: 'none' }}>
            {tabela.itensPagina.map((r) => {
              const ab = abertas.has(r.produtoId);
              return (
                <div key={r.produtoId} className={`mp-ref ${ab ? 'mp-ref-aberta' : ''}`}>
                  <button type="button" className="mp-ref-topo pv-topo" onClick={() => alternar(r.produtoId)}>
                    {ab ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className="mp-ref-id"><b>{r.referencia}</b><span>{r.descricao}</span></span>
                    <span className="mp-ref-num"><b className={r.taxaDevolucao >= 0.08 ? 'mp-falta-n' : ''}>{pct(r.taxaDevolucao)}</b><span>devolve{r.amostraPequena ? ' *' : ''}</span></span>
                    <span className="mp-ref-num"><b>{formatQtd(r.pecasDevolvidas)}</b><span>de {r.vendidas == null ? '?' : formatQtd(r.vendidas)}</span></span>
                    <span className="mp-ref-num"><b>{r.reclamacoes}</b><span>reclam.</span></span>
                    <span className="mp-ref-num"><b>{r.notaMedia ?? '—'}</b><span>{r.avaliacoes} aval.</span></span>
                    <span className="pv-alimenta-selo">{r.alimenta ? (() => { const I = ALIMENTA_ICONE[r.alimenta.area] || Info; return <span className={`mp-selo pv-a-${r.alimenta.area}`}><I size={11} /> {r.alimenta.area}</span>; })() : (r.motivos[0] ? <span className="mp-selo mp-selo-neutro">{r.motivos[0].rotulo}</span> : null)}</span>
                  </button>
                  {ab && (
                    <div className="mp-ref-corpo pv-corpo">
                      {r.sinais.length > 0 && <div className="pv-sinais">{r.sinais.map((s) => <span key={`${s.tamanho}${s.sinal}`} className="pl-aviso"><Ruler size={12} /> {s.texto}</span>)}</div>}
                      <div className="pv-quadros">
                        <div className="mp-quadro"><h4><Undo2 size={13} /> Motivos das devoluções</h4>
                          {r.motivos.length === 0 ? <p className="ink-soft" style={{ padding: 10, margin: 0, fontSize: 12 }}>sem motivo classificado</p> : (
                            <table className="mp-tab"><tbody>{r.motivos.map((m) => <tr key={m.motivo}><td>{m.rotulo}</td><td>{m.alimenta ? <span className={`mp-selo pv-a-${m.alimenta}`}>{m.alimenta}</span> : ''}</td><td>{m.n}</td></tr>)}</tbody></table>
                          )}
                        </div>
                        <div className="mp-quadro"><h4><Ruler size={13} /> Por tamanho</h4>
                          <table className="mp-tab"><thead><tr><th>Tam.</th><th>Devolv.</th><th>Vend.</th><th>Taxa</th><th>Pequeno</th><th>Grande</th><th>Defeito</th></tr></thead>
                            <tbody>{r.tamanhos.map((t) => <tr key={t.tamanho}><td>{t.tamanho}</td><td>{t.pecasDevolvidas}</td><td>{t.vendidas ?? '—'}</td><td className={t.taxa >= 0.1 ? 'mp-falta-n' : ''}>{pct(t.taxa)}</td><td className={t.pequeno >= 3 ? 'mp-falta-n' : ''}>{t.pequeno || '·'}</td><td className={t.grande >= 3 ? 'mp-falta-n' : ''}>{t.grande || '·'}</td><td className={t.defeito >= 3 ? 'mp-falta-n' : ''}>{t.defeito || '·'}</td></tr>)}</tbody></table>
                        </div>
                        {r.perguntasTema.length > 0 && (
                          <div className="mp-quadro"><h4><MessageCircleQuestion size={13} /> O que perguntam antes de comprar</h4>
                            <table className="mp-tab"><tbody>{r.perguntasTema.map((t) => <tr key={t.tema}><td>{t.tema}</td><td>{t.n}</td></tr>)}</tbody></table>
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn-sec btn-mini" onClick={() => onVerEventos(r.produtoId)}>Ver os eventos desta referência <ChevronRight size={12} /></button></div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Paginacao {...tabela} posicao="rodape" />
          <p className="mp-nota" style={{ padding: '8px 14px' }}><Info size={13} /><span>* amostra pequena: menos de 20 peças vendidas na janela — a taxa é real, mas uma devolução a mais muda tudo.</span></p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Eventos({ periodo, opcoes, filtroInicial, onMudou }) {
  const [filtro, setFiltro] = useState({ tipo: '', marketplace: '', aberto: false, motivo: '', produto_id: '', ...filtroInicial });
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [aberto, setAberto] = useState(null);
  const [resposta, setResposta] = useState('');
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { setFiltro((f) => ({ ...f, ...filtroInicial })); }, [filtroInicial]);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const qs = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim });
      for (const [k, v] of Object.entries(filtro)) if (v) qs.set(k, v === true ? '1' : v);
      setDados(await api.get(`${ROTA}/eventos?${qs}`));
    } catch (e) { setErro(e.message); }
  }, [periodo, filtro]);
  useEffect(() => { carregar(); }, [carregar]);

  const classificar = async (e, motivo) => {
    if (e.manual) return;
    try { await api.put(`${ROTA}/eventos/${e.id}`, { motivo: motivo || null }); await carregar(); onMudou(); } catch (x) { setErro(x.message); }
  };
  const tratar = async (e) => {
    if (e.manual) return;
    try { await api.put(`${ROTA}/eventos/${e.id}`, { tratado: !e.tratado_em, tratamento: e.tratado_em ? null : 'visto' }); await carregar(); onMudou(); } catch (x) { setErro(x.message); }
  };
  const responder = async (e) => {
    if (!resposta.trim()) return;
    if (!(await confirmar(`Enviar esta resposta ao comprador no Mercado Livre? Vai para o ar agora.`, { titulo: 'Responder pergunta', confirmarTexto: 'Enviar', perigo: false }))) return;
    setOcupado(true);
    try { await api.post(`${ROTA}/eventos/${e.id}/responder`, { texto: resposta }); setResposta(''); await carregar(); onMudou(); } catch (x) { setErro(x.message); } finally { setOcupado(false); }
  };

  const eventos = dados?.eventos || [];
  const tabela = useTabela(eventos, { colunas: { quando: (r) => new Date(r.ocorrido_em).getTime() }, colunaPadrao: 'quando', direcaoPadrao: 'desc', prefixo: 'pv-ev' });

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <div className="pv-filtros">
        <span className="mp-seg">{[['', 'Todos'], ['devolucao', 'Devoluções'], ['reclamacao', 'Reclamações'], ['pergunta', 'Perguntas'], ['avaliacao', 'Avaliações']].map(([k, r]) => <button key={k} type="button" aria-pressed={filtro.tipo === k} onClick={() => setFiltro({ ...filtro, tipo: k })}>{r}</button>)}</span>
        <span className="pv-filtro-sel"><Select value={filtro.marketplace} onChange={(e) => setFiltro({ ...filtro, marketplace: e.target.value })}><option value="">Todos os canais</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></span>
        <span className="pv-filtro-sel"><Select value={filtro.motivo} onChange={(e) => setFiltro({ ...filtro, motivo: e.target.value })}><option value="">Qualquer motivo</option><option value="sem">Sem classificar</option>{(opcoes?.motivos || []).map((m) => <option key={m.chave} value={m.chave}>{m.rotulo}</option>)}</Select></span>
        <label className="pv-filtro-chk"><input type="checkbox" checked={filtro.aberto} onChange={(e) => setFiltro({ ...filtro, aberto: e.target.checked })} /> só em aberto</label>
        {filtro.produto_id && <span className="mp-selo mp-selo-sugerida">referência #{filtro.produto_id} <button type="button" className="pl-link" onClick={() => setFiltro({ ...filtro, produto_id: '' })}><X size={10} /></button></span>}
        <span style={{ flex: 1 }} /><span className="ink-soft" style={{ fontSize: 12 }}>{dados ? `${dados.total} evento(s)` : ''}</span>
      </div>
      {!dados ? <Skeleton height={200} /> : eventos.length === 0 ? <EstadoVazio Icone={MessageSquareWarning} titulo="Nenhum evento com esse filtro" /> : (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <Paginacao {...tabela} posicao="topo" />
          <table className="mp-tecido-tab pv-tab">
            <thead><tr><th /><th>Quando</th><th>Tipo</th><th>Canal</th><th>Referência</th><th>Cor / tam.</th><th style={{ textAlign: 'left' }}>O que o cliente disse</th><th>Motivo</th><th>Situação</th></tr></thead>
            <tbody>
              {tabela.itensPagina.map((e) => {
                const ab = aberto === e.id;
                return (
                  <FragmentoLinha key={e.id}>
                    <tr className="pl-linha-clicavel" onClick={() => setAberto(ab ? null : e.id)}>
                      <td>{ab ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{quando(e.ocorrido_em)}</td>
                      <td><Tipo chave={e.tipo} /></td>
                      <td><Canal chave={e.marketplace} /></td>
                      <td>{e.referencia || <span className="mp-selo mp-selo-pendente">sem vínculo</span>}</td>
                      <td>{[e.cor, e.tamanho].filter(Boolean).join(' / ') || '—'}</td>
                      <td style={{ textAlign: 'left', maxWidth: 380 }}><div className="pv-texto">{e.nota != null && <Estrelas n={Number(e.nota)} />} {e.texto || <span className="ink-soft">{e.motivo_externo || '—'}</span>}</div>{e.resposta && <div className="pv-resposta"><Send size={11} /> {e.resposta}</div>}</td>
                      <td onClick={(ev) => ev.stopPropagation()}>
                        {(e.tipo === 'devolucao' || e.tipo === 'reclamacao' || (e.tipo === 'avaliacao' && Number(e.nota) <= 3)) ? (
                          e.manual ? <span>{opcoes?.motivos.find((m) => m.chave === e.motivo)?.rotulo || e.motivo || '—'}</span> : (
                            <Select value={e.motivo || ''} onChange={(ev) => classificar(e, ev.target.value)} className={!e.motivo ? 'mp-sujo' : ''}>
                              <option value="">— classificar —</option>
                              {(opcoes?.motivos || []).map((m) => <option key={m.chave} value={m.chave}>{m.rotulo}</option>)}
                            </Select>
                          )
                        ) : (e.tipo === 'pergunta' ? <span className="mp-selo mp-selo-neutro" title="tema da pergunta">{e.tema || '—'}</span> : <span className="mp-vazio">—</span>)}
                        {e.motivo && e.motivo_origem && e.motivo_origem !== 'manual' && <small className="ink-soft" style={{ display: 'block', fontSize: 10 }}>{e.motivo_origem === 'plataforma' ? 'código da plataforma' : 'por palavra'}</small>}
                      </td>
                      <td>{e.aberto ? <span className="pl-urg pl-urg-agora">em aberto</span> : (e.tratado_em ? <span className="pl-urg pp-ok">tratada</span> : <span className="pl-urg pp-sem">{e.status_externo || 'fechada'}</span>)}</td>
                    </tr>
                    {ab && (
                      <tr><td colSpan={9} className="mp-contrib" onClick={(ev) => ev.stopPropagation()}>
                        <div className="pv-detalhe">
                          <div>
                            {e.loja_nome && <span><b>Loja:</b> {e.loja_nome}</span>}
                            {e.anuncio_titulo && <span><b>Anúncio:</b> {e.anuncio_titulo}</span>}
                            {e.pedido_numero && <span><b>Pedido:</b> #{e.pedido_numero}</span>}
                            {e.motivo_externo && <span><b>Motivo na plataforma:</b> {e.motivo_externo}</span>}
                            {e.status_externo && <span><b>Situação na plataforma:</b> {e.status_externo}</span>}
                            {e.comprador_nome && <span><b>Comprador:</b> {e.comprador_nome}</span>}
                            {e.valor != null && <span><b>Valor:</b> {brl(Number(e.valor))}</span>}
                            {e.quantidade != null && <span><b>Peças:</b> {formatQtd(e.quantidade)}</span>}
                            {e.destino && <span><b>Destino:</b> {e.destino}</span>}
                            {e.tratado_em && <span><b>Tratada por:</b> {e.tratado_por_nome || '—'} em {quando(e.tratado_em)}{e.tratamento ? ` — ${e.tratamento}` : ''}</span>}
                          </div>
                          {e.tipo === 'pergunta' && !e.resposta && e.marketplace === 'mercado_livre' && (
                            <div className="pl-acoes">
                              <textarea className="motivo-modal-texto" style={{ margin: 0, flex: 1, minWidth: 320 }} rows={2} placeholder="Resposta ao comprador (vai para o Mercado Livre)" value={resposta} onChange={(ev) => setResposta(ev.target.value)} />
                              <button type="button" className="btn btn-primary" disabled={ocupado || !resposta.trim()} onClick={() => responder(e)}><Send size={14} /> {ocupado ? 'Enviando…' : 'Responder'}</button>
                            </div>
                          )}
                          {e.tipo === 'pergunta' && !e.resposta && e.marketplace !== 'mercado_livre' && <p className="ink-soft" style={{ margin: 0, fontSize: 12 }}>Este canal não aceita resposta por API — responda no painel da plataforma e marque como tratada.</p>}
                          {!e.manual && <div><button type="button" className="btn-sec btn-mini" onClick={() => tratar(e)}>{e.tratado_em ? <><Undo2 size={12} /> Reabrir</> : <><Check size={12} /> Marcar como tratada</>}</button></div>}
                          {e.manual && <div><a href={`/marketplace/pos-venda?devolucao=${e.devolucao_id}`} onClick={(ev) => { ev.preventDefault(); onMudou('devolucoes', e.devolucao_id); }}>Abrir a devolução #{e.numero} no Hub <ExternalLink size={11} /></a></div>}
                        </div>
                      </td></tr>
                    )}
                  </FragmentoLinha>
                );
              })}
            </tbody>
          </table>
          <Paginacao {...tabela} posicao="rodape" />
        </section>
      )}
    </div>
  );
}
function FragmentoLinha({ children }) { return <>{children}</>; }

// ---------------------------------------------------------------------------
// Devoluções registradas no Hub (backend de 0060, agora com tela)
// ---------------------------------------------------------------------------
function DevolucoesHub({ opcoes, destaque, onMudou }) {
  const [lista, setLista] = useState(null);
  const [erro, setErro] = useState(null);
  const [nova, setNova] = useState(null);
  const [itensPedido, setItensPedido] = useState([]);
  const [aberta, setAberta] = useState(destaque || null);
  const [detalhe, setDetalhe] = useState(null);
  const [destinos, setDestinos] = useState({});

  const carregar = useCallback(async () => { try { setLista(await api.get('/devolucoes')); } catch (e) { setErro(e.message); } }, []);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => { setAberta(destaque || null); }, [destaque]);
  useEffect(() => { if (!aberta) { setDetalhe(null); return; } api.get(`/devolucoes/${aberta}`).then(setDetalhe).catch((e) => setErro(e.message)); }, [aberta]);

  const buscarPedido = async (numero) => {
    if (!numero) return;
    try {
      const r = await api.get(`/pedidos?busca=${encodeURIComponent(numero)}`);
      const lista = Array.isArray(r) ? r : (r.itens || r.pedidos || []);
      const p = lista.find((x) => String(x.numero) === String(numero).trim()) || lista[0];
      if (!p) { setErro('Pedido não encontrado.'); return; }
      setNova({ ...nova, pedido_id: p.id, pedido_numero: p.numero, canal: p.origem_marketplace || p.canal_venda || 'manual' });
      setItensPedido(await api.get(`/devolucoes/pedido/${p.id}/itens`));
    } catch (e) { setErro(e.message); }
  };
  const abrir = async () => {
    setErro(null);
    const itens = itensPedido.filter((i) => Number(nova.qtd?.[i.id]) > 0).map((i) => ({ variante_id: i.variante_id, quantidade: Number(nova.qtd[i.id]) }));
    if (itens.length === 0) { setErro('Informe a quantidade devolvida de pelo menos um item.'); return; }
    try {
      await api.post('/devolucoes', { pedido_id: nova.pedido_id, canal: nova.canal, motivo: nova.motivo, motivo_detalhe: nova.motivo_detalhe || null, itens, valor_reembolsado: nova.valor_reembolsado === '' ? null : Number(nova.valor_reembolsado), observacao: nova.observacao || null });
      setNova(null); setItensPedido([]); await carregar(); onMudou();
    } catch (e) { setErro(e.message); }
  };
  const acao = async (id, caminho, body = {}) => {
    try { await api.post(`/devolucoes/${id}/${caminho}`, body); await carregar(); setDetalhe(await api.get(`/devolucoes/${id}`)); onMudou(); } catch (e) { setErro(e.message); }
  };
  const avaliar = async (id) => {
    const itens = (detalhe?.itens || []).map((i) => ({ id: i.item_id ?? i.id, destino: destinos[i.item_id ?? i.id] || i.destino || 'revenda' }));
    await acao(id, 'avaliar', { itens });
  };

  const SIT = { aguardando: 'Aguardando chegar', recebida: 'Recebida — avaliar', avaliada: 'Avaliada', cancelada: 'Cancelada' };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary" onClick={() => setNova({ pedido_numero: '', motivo: 'tamanho', qtd: {}, valor_reembolsado: '' })}><Plus size={14} /> Registrar devolução</button>
        <span className="ink-soft" style={{ fontSize: 12, alignSelf: 'center' }}>Para devolução que chega fora da plataforma, ou quando a plataforma não avisa. Ao avaliar, a peça volta ao estoque (revenda), vai para segunda qualidade, conserto ou descarte.</span>
      </div>
      {nova && (
        <section className="card" style={{ display: 'grid', gap: 10 }}>
          <div className="pl-acoes">
            <div className="mp-param"><label>Número do pedido</label><span className="mp-campo"><input value={nova.pedido_numero} onChange={(e) => setNova({ ...nova, pedido_numero: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && buscarPedido(nova.pedido_numero)} placeholder="ex.: 1234" /><button type="button" className="btn-sec btn-mini" onClick={() => buscarPedido(nova.pedido_numero)}><Search size={12} /></button></span></div>
            <div className="mp-param"><label>Motivo</label><Select value={nova.motivo} onChange={(e) => setNova({ ...nova, motivo: e.target.value })}>{(opcoes?.motivos || []).map((m) => <option key={m.chave} value={m.chave}>{m.rotulo}</option>)}</Select></div>
            <div className="mp-param" style={{ flex: 1, minWidth: 220 }}><label>O que o cliente disse</label><input value={nova.motivo_detalhe || ''} onChange={(e) => setNova({ ...nova, motivo_detalhe: e.target.value })} /></div>
            <div className="mp-param"><label>Reembolso (R$)</label><NumInput step="0.01" min={0} value={nova.valor_reembolsado} onChange={(n) => setNova({ ...nova, valor_reembolsado: n ?? '' })} /></div>
          </div>
          {itensPedido.length > 0 && (
            <table className="mp-tab"><thead><tr><th>Item</th><th>Cor / tam.</th><th>Comprou</th><th>Já devolvida</th><th>Devolve agora</th></tr></thead>
              <tbody>{itensPedido.map((i) => <tr key={i.id}><td>{i.referencia} — {i.descricao}</td><td>{[i.cor, i.tamanho].filter(Boolean).join(' / ')}</td><td>{formatQtd(i.quantidade)}</td><td>{formatQtd(i.ja_devolvida)}</td><td><NumInput className="pl-cel" step="1" min={0} value={nova.qtd[i.id] ?? ''} onChange={(n) => setNova({ ...nova, qtd: { ...nova.qtd, [i.id]: n ?? '' } })} /></td></tr>)}</tbody></table>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn-sec" onClick={() => { setNova(null); setItensPedido([]); }}>Cancelar</button><button type="button" className="btn btn-primary" disabled={!nova.pedido_id} onClick={abrir}><Save size={14} /> Abrir devolução</button></div>
        </section>
      )}
      {!lista ? <Skeleton height={160} /> : lista.length === 0 ? <EstadoVazio Icone={Undo2} titulo="Nenhuma devolução registrada no Hub" /> : (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="mp-tecido-tab">
            <thead><tr><th>Nº</th><th>Quando</th><th>Canal</th><th>Pedido</th><th>Motivo</th><th>Peças</th><th>Reembolso</th><th>Situação</th><th /></tr></thead>
            <tbody>{lista.map((d) => (
              <FragmentoLinha key={d.id}>
                <tr className="pl-linha-clicavel" onClick={() => setAberta(aberta === d.id ? null : d.id)}>
                  <td><b>#{d.numero}</b></td><td>{dataBr(String(d.criado_em).slice(0, 10))}</td><td><Canal chave={d.canal || 'manual'} /></td><td>{d.pedido_numero ? `#${d.pedido_numero}` : (d.pedido_canal_id || '—')}</td>
                  <td>{opcoes?.motivos.find((m) => m.chave === d.motivo)?.rotulo || d.motivo}</td><td>{formatQtd(d.pecas)}</td><td>{d.valor_reembolsado == null ? '—' : brl(Number(d.valor_reembolsado))}</td>
                  <td><span className={`pl-urg ${d.situacao === 'avaliada' ? 'pp-ok' : (d.situacao === 'cancelada' ? 'pp-sem' : 'pl-urg-agora')}`}>{SIT[d.situacao] || d.situacao}</span></td>
                  <td>{aberta === d.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                </tr>
                {aberta === d.id && detalhe && (
                  <tr><td colSpan={9} className="mp-contrib" onClick={(e) => e.stopPropagation()}>
                    {detalhe.devolucao?.motivo_detalhe && <p style={{ margin: '0 0 8px' }}>“{detalhe.devolucao.motivo_detalhe}”</p>}
                    <table className="mp-tab" style={{ marginBottom: 10 }}><thead><tr><th>Item</th><th>Cor / tam.</th><th>Peças</th><th>Destino</th></tr></thead>
                      <tbody>{(detalhe.itens || []).map((i) => { const iid = i.item_id ?? i.id; return <tr key={iid}><td>{i.referencia} {i.descricao_livre || ''}</td><td>{[i.cor, i.tamanho].filter(Boolean).join(' / ')}</td><td>{formatQtd(i.quantidade)}</td>
                        <td>{d.situacao === 'recebida' ? <Select value={destinos[iid] || i.destino || 'revenda'} onChange={(e) => setDestinos({ ...destinos, [iid]: e.target.value })}>{(opcoes?.destinos || [{ chave: 'revenda', rotulo: 'Volta a vender' }, { chave: 'segunda', rotulo: 'Segunda qualidade' }, { chave: 'conserto', rotulo: 'Conserto' }, { chave: 'descarte', rotulo: 'Descarte' }]).map((x) => <option key={x.chave} value={x.chave}>{x.rotulo}</option>)}</Select> : (i.destino || '—')}</td></tr>; })}</tbody></table>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {d.situacao === 'aguardando' && <button type="button" className="btn btn-primary btn-mini" onClick={() => acao(d.id, 'receber')}><Check size={12} /> Chegou — marcar como recebida</button>}
                      {d.situacao === 'recebida' && <button type="button" className="btn btn-primary btn-mini" onClick={() => avaliar(d.id)}><Check size={12} /> Avaliar e dar destino</button>}
                      {['aguardando', 'recebida'].includes(d.situacao) && <button type="button" className="btn-sec btn-mini" onClick={async () => { if (await confirmar('Cancelar esta devolução?', { titulo: 'Cancelar devolução', confirmarTexto: 'Cancelar devolução' })) acao(d.id, 'cancelar', { motivo: 'cancelada na tela' }); }}><X size={12} /> Cancelar</button>}
                    </div>
                  </td></tr>
                )}
              </FragmentoLinha>
            ))}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function PosVendaPage() {
  const [periodo, setPeriodo] = useState(() => ({ inicio: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), fim: new Date().toISOString().slice(0, 10) }));
  const [aba, setAba] = useState('acao');
  const [painel, setPainel] = useState(null);
  const [opcoes, setOpcoes] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [filtroEventos, setFiltroEventos] = useState({});
  const [devolucaoDestaque, setDevolucaoDestaque] = useState(null);
  const [ajuda, setAjuda] = useState(false);
  const [verLojas, setVerLojas] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try {
      const [p, o] = await Promise.all([api.get(`${ROTA}/painel?inicio=${periodo.inicio}&fim=${periodo.fim}`), opcoes || Promise.all([api.get(`${ROTA}/opcoes`), api.get('/devolucoes/opcoes')]).then(([a, b]) => ({ ...a, destinos: b.destinos }))]);
      setPainel(p); if (!opcoes) setOpcoes(o);
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, [periodo, opcoes]);
  useEffect(() => { carregar(); }, [carregar]);

  const sincronizar = async () => {
    setSincronizando(true); setErro(null);
    try { const r = await api.post(`${ROTA}/sincronizar`, {}); const falhas = r.filter((x) => !x.ok); if (falhas.length) setErro(`Lojas com erro: ${falhas.map((f) => `${f.nome}: ${f.erro}`).join(' · ')}`); await carregar(); } catch (e) { setErro(e.message); } finally { setSincronizando(false); }
  };
  const ir = (item) => {
    if (item.eventoId) { setFiltroEventos({ tipo: item.tipo === 'referencia' || item.tipo === 'modelagem' ? '' : item.tipo, aberto: true }); setAba('eventos'); }
    else if (item.produtoId) { setFiltroEventos({ produto_id: String(item.produtoId) }); setAba('referencia'); }
  };
  const t = painel?.totais;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div><h1><MessageSquareWarning size={20} /> Pós-venda</h1><p className="page-sub">O que o cliente diz depois de comprar — devolução, reclamação, pergunta, avaliação — ligado à referência, cor e tamanho. Para a modelagem, a qualidade e o anúncio ouvirem.</p></div>
        <div className="pagina-acoes mp-barra">
          <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
          <span className="mp-barra-sep" aria-hidden="true" />
          <button type="button" className="btn-sec" onClick={() => setVerLojas(!verLojas)}>Lojas e fontes</button>
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}><RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar</button>
          <button type="button" className="btn btn-primary" onClick={sincronizar} disabled={sincronizando}><RefreshCw size={15} className={sincronizando ? 'girando' : ''} /> {sincronizando ? 'Lendo as lojas…' : 'Ler as lojas agora'}</button>
        </div>
      </header>
      {erro && <p className="erro-inline">{erro}</p>}
      {verLojas && painel && (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="mp-tecido-topo"><Info size={14} /><h4>O que cada loja dá por API</h4><span style={{ fontSize: 12, opacity: .8 }}>leitura automática de hora em hora</span></div>
          <table className="mp-tecido-tab"><thead><tr><th>Loja</th><th>Última leitura</th><th>Devolução</th><th>Reclamação</th><th>Pergunta</th><th>Avaliação</th></tr></thead>
            <tbody>{painel.lojas.map((l) => { const F = ({ k }) => { const v = l.fontes?.[k]; return v == null ? <span className="mp-vazio">—</span> : v === 'ok' ? <span className="mp-selo mp-selo-confirmada">ok</span> : v === 'sem_api' ? <span className="mp-selo mp-selo-neutro" title="a plataforma não expõe por API">sem API</span> : v === 'na reclamação' ? <span className="mp-selo mp-selo-neutro">na reclamação</span> : <span className="mp-selo mp-selo-pendente" title={v}>erro</span>; };
              return <tr key={l.integracaoId}><td style={{ textAlign: 'left' }}><Canal chave={l.marketplace} /> {l.nome}</td><td>{l.ultimaSincronizacao ? quando(l.ultimaSincronizacao) : 'nunca'}</td><td><F k="devolucao" /></td><td><F k="reclamacao" /></td><td><F k="pergunta" /></td><td><F k="avaliacao" /></td></tr>; })}</tbody></table>
        </section>
      )}
      {t && (
        <div className="mp-kpis">
          <button type="button" className={`mp-kpi pl-kpi-btn${t.acaoUrgente > 0 ? ' mp-kpi-perigo' : (t.acao > 0 ? ' mp-kpi-alerta' : ' mp-kpi-bom')}`} onClick={() => setAba('acao')}><span className="mp-kpi-rotulo"><TriangleAlert size={12} /> Exige ação</span><strong>{t.acao}</strong><small>{t.acaoUrgente} urgente · {t.perguntasSemResposta} pergunta(s) sem resposta · {t.reclamacoesAbertas} reclamação(ões) aberta(s)</small></button>
          <div className={`mp-kpi${t.taxaDevolucao >= 0.08 ? ' mp-kpi-perigo' : ''}`}><span className="mp-kpi-rotulo"><Undo2 size={12} /> Taxa de devolução</span><strong>{pct(t.taxaDevolucao)}</strong><small>{formatQtd(t.pecasDevolvidas)} de {formatQtd(t.pecasVendidas)} peças na janela</small></div>
          <div className="mp-kpi"><span className="mp-kpi-rotulo"><Star size={12} /> Avaliações</span><strong>{t.notaMedia ?? '—'}</strong><small>{t.avaliacoes} avaliação(ões) · {t.reclamacoes} reclamação(ões)</small></div>
          <button type="button" className={`mp-kpi pl-kpi-btn${t.semVinculo + t.semMotivo > 0 ? ' mp-kpi-alerta' : ' mp-kpi-bom'}`} onClick={() => { setFiltroEventos({ motivo: 'sem' }); setAba('eventos'); }}><span className="mp-kpi-rotulo"><Info size={12} /> Precisa de mão</span><strong>{t.semVinculo + t.semMotivo}</strong><small>{t.semVinculo} sem referência · {t.semMotivo} sem motivo classificado</small></button>
        </div>
      )}
      <div className="subtab-row">
        <button type="button" className={`subtab-btn ${aba === 'acao' ? 'active' : ''}`} onClick={() => setAba('acao')}>O que exige ação{t ? ` (${t.acao})` : ''}</button>
        <button type="button" className={`subtab-btn ${aba === 'referencia' ? 'active' : ''}`} onClick={() => setAba('referencia')}>Por referência</button>
        <button type="button" className={`subtab-btn ${aba === 'eventos' ? 'active' : ''}`} onClick={() => setAba('eventos')}>Eventos</button>
        <button type="button" className={`subtab-btn ${aba === 'devolucoes' ? 'active' : ''}`} onClick={() => setAba('devolucoes')}>Devoluções no Hub</button>
      </div>
      {carregando && !painel ? <Skeleton height={200} /> : (
        <>
          {aba === 'acao' && <Acao painel={painel} onIr={ir} />}
          {aba === 'referencia' && <PorReferencia painel={painel} onVerEventos={(pid) => { setFiltroEventos({ produto_id: String(pid) }); setAba('eventos'); }} />}
          {aba === 'eventos' && <Eventos periodo={periodo} opcoes={opcoes} filtroInicial={filtroEventos} onMudou={(dest, id) => { carregar(); if (dest === 'devolucoes') { setDevolucaoDestaque(id); setAba('devolucoes'); } }} />}
          {aba === 'devolucoes' && <DevolucoesHub opcoes={opcoes} destaque={devolucaoDestaque} onMudou={carregar} />}
        </>
      )}
      <div>
        <button type="button" className="mp-ajuda-btn" onClick={() => setAjuda(!ajuda)}>{ajuda ? <X size={13} /> : <Info size={13} />} Como esta tela calcula</button>
        {ajuda && <div className="mp-ajuda" style={{ marginTop: 8 }}><ul style={{ margin: 0, paddingLeft: 18 }}>{(painel?.avisos || []).map((a) => <li key={a}>{a}</li>)}<li><b>Ligação com o produto:</b> pelo pedido da plataforma (que já tem referência, cor e tamanho), senão pela variação do anúncio, senão pelo SKU. O que não casa aparece como "sem vínculo" e pode ser ligado à mão.</li><li><b>Responder pergunta:</b> só o Mercado Livre aceita por API; a resposta vai para o ar na hora e fica registrada com quem respondeu.</li></ul></div>}
      </div>
    </div>
  );
}
