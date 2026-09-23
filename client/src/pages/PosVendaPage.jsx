import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MessageSquareWarning, RefreshCw, Info, X, Undo2, MessageCircleQuestion, Star, ShieldAlert, Ruler, Scissors, ImageOff, Truck, PackageX,
  Check, Send, Search, Plus, Save, TriangleAlert, ExternalLink, Store, TrendingUp, ArrowDownRight, ArrowUpRight, Link2Off, Eye, ChevronRight,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, Select, NumInput, Paginacao, CampoBusca, IndicadorDestaque, ThOrdenavel, Toggle } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import DataTable from '../components/DataTable';
import Gaveta from '../components/Gaveta';
import { CartaoGrafico, GraficoEvolucao } from '../components/graficos';
import { brl, formatQtd, dataBr, plural, numeroBr, tempoRelativo } from '../lib/format';
import { useTabela } from '../lib/useTabela';
import { SeloPlataforma } from '../lib/canalMarketplace';
import { confirmar } from '../components/ConfirmDialog';
import { periodoTresMeses } from '../lib/periodos';

// Marketplace › Pós-venda — repaginada em 23/09/2026 depois do teste de uso.
//
// O que mudou e por quê (ver claude/hbn-pos-venda-piso-diagnostico-2026-09-23.md):
//   • "Abrir" numa avaliação levava a Eventos com "só em aberto" ligado e a
//     lista vinha vazia. Agora abre O evento, numa gaveta.
//   • Avaliação 5★ fechada mostrava "Marcar como tratada". O botão só aparece
//     no que exige tratamento.
//   • Sub-aba nova "Evolução": a taxa de devolução, a nota e as reclamações
//     mês a mês (ou semana a semana), geral ou por referência, e o comparador
//     período A × período B por referência — "10% na OG1192 no período X e
//     15% no Y" era a pergunta que a tela não respondia.
//   • Blocos técnicos (mp-tecido-*, mp-param, mp-ref-num) trocados pelos do
//     resto do módulo: card/card-head, data-table com cabeçalho fixo,
//     indicadores, chips sólidos, gaveta lateral para detalhe e formulário.
//   • "Lojas e fontes" deixa de ser um cartão no meio da página: é um
//     indicador no topo que abre a gaveta com o erro por escrito e "ler de
//     novo" por loja (a Shopee estava em ERRO nas duas lojas e ninguém via).

const ROTA = '/pos-venda';
const CANAIS = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein', manual: 'No Hub' };
const TIPOS = {
  devolucao: { rotulo: 'Devolução', plural: 'Devoluções', Icone: Undo2, classe: 'pv-tipo-devolucao' },
  reclamacao: { rotulo: 'Reclamação', plural: 'Reclamações', Icone: ShieldAlert, classe: 'pv-tipo-reclamacao' },
  pergunta: { rotulo: 'Pergunta', plural: 'Perguntas', Icone: MessageCircleQuestion, classe: 'pv-tipo-pergunta' },
  avaliacao: { rotulo: 'Avaliação', plural: 'Avaliações', Icone: Star, classe: 'pv-tipo-avaliacao' },
  referencia: { rotulo: 'Referência', plural: 'Referências devolvendo demais', Icone: TrendingUp, classe: 'pv-tipo-referencia' },
  modelagem: { rotulo: 'Modelagem', plural: 'Sinais de modelagem', Icone: Ruler, classe: 'pv-tipo-modelagem' },
};
const ALIMENTA_ICONE = { modelagem: Ruler, qualidade: Scissors, anuncio: ImageOff, expedicao: PackageX, logistica: Truck };
const ALIMENTA_ROTULO = { modelagem: 'Modelagem', qualidade: 'Qualidade', anuncio: 'Anúncio', expedicao: 'Expedição', logistica: 'Logística' };
const pct = (v, casas = 1) => (v == null ? '—' : `${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`);
const pontos = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pt`);
const quando = (iso) => (iso ? `${dataBr(String(iso).slice(0, 10))} ${new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '—');
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const rotuloBalde = (iso, granularidade) => { const [a, m, d] = String(iso).split('-'); return granularidade === 'semana' ? `${d}/${m}` : `${MESES[Number(m) - 1]}/${a.slice(2)}`; };

function Canal({ chave, nome }) { return <span className="pv-canal"><SeloPlataforma chave={chave} size={14} /> {nome || CANAIS[chave] || chave}</span>; }
function Tipo({ chave }) { const t = TIPOS[chave] || { rotulo: chave, Icone: Info, classe: '' }; const { Icone } = t; return <span className={`stamp sm pv-tipo ${t.classe}`}><Icone size={11} /> {t.rotulo}</span>; }
function Estrelas({ n }) {
  if (n == null) return null;
  return <span className="pv-estrelas" title={`${n} de 5`}>{[1, 2, 3, 4, 5].map((i) => <Star key={i} size={12} className={i <= n ? 'cheia' : ''} />)}</span>;
}
function Situacao({ e }) {
  if (e.aberto) return <span className="stamp sm tone-atencao">Em aberto</span>;
  if (e.tratado_em) return <span className="stamp sm tone-saudavel">Tratada</span>;
  if (e.tipo === 'avaliacao') return <span className="stamp sm tone-neutro">Recebida</span>;
  return <span className="stamp sm tone-neutro">{e.status_externo ? e.status_externo.toLowerCase().replace(/_/g, ' ') : 'Fechada'}</span>;
}
function Alimenta({ area }) { if (!area) return null; const I = ALIMENTA_ICONE[area] || Info; return <span className={`stamp sm pv-alimenta pv-a-${area}`}><I size={11} /> {ALIMENTA_ROTULO[area] || area}</span>; }
// O que pede tratamento humano: aberto, avaliação ruim ou pergunta sem resposta.
const precisaTratar = (e) => !e.manual && !e.tratado_em && (e.aberto || (e.tipo === 'avaliacao' && Number(e.nota) <= 3) || (e.tipo === 'pergunta' && !e.resposta));

// ---------------------------------------------------------------------------
// Gaveta do evento — o detalhe, classificar, tratar, responder
// ---------------------------------------------------------------------------
function GavetaEvento({ evento, opcoes, onFechar, onMudou, onDevolucao }) {
  const [resposta, setResposta] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState(null);
  const e = evento;
  if (!e) return null;
  const chamar = async (fn) => { setOcupado(true); setErro(null); try { await fn(); await onMudou(); } catch (x) { setErro(x.message); } finally { setOcupado(false); } };
  const classificar = (motivo) => chamar(() => api.put(`${ROTA}/eventos/${e.id}`, { motivo: motivo || null }));
  const tratar = () => chamar(() => api.put(`${ROTA}/eventos/${e.id}`, { tratado: !e.tratado_em, tratamento: e.tratado_em ? null : 'visto' }));
  const responder = async () => {
    if (!resposta.trim()) return;
    if (!(await confirmar('Enviar esta resposta ao comprador no Mercado Livre? Vai para o ar agora.', { titulo: 'Responder pergunta', confirmarTexto: 'Enviar' }))) return;
    await chamar(() => api.post(`${ROTA}/eventos/${e.id}/responder`, { texto: resposta })); setResposta('');
  };
  const classificavel = !e.manual && (e.tipo === 'devolucao' || e.tipo === 'reclamacao' || (e.tipo === 'avaliacao' && Number(e.nota) <= 3));
  const T = TIPOS[e.tipo] || {};
  return (
    <Gaveta aberta onFechar={onFechar} Icone={T.Icone} titulo={<>{T.rotulo} {e.referencia ? <span className="pv-gaveta-ref">{e.referencia}</span> : <span className="stamp sm tone-atencao">sem vínculo</span>}</>} subtitulo={<><Canal chave={e.marketplace} nome={e.loja_nome} /> · {quando(e.ocorrido_em)}</>}
      rodape={(
        <>
          <Situacao e={e} />
          <span style={{ flex: 1 }} />
          {e.manual && <button type="button" className="btn btn-ghost" onClick={() => onDevolucao(e.devolucao_id)}>Abrir devolução #{e.numero} <ExternalLink size={13} /></button>}
          {!e.manual && (precisaTratar(e) || e.tratado_em) && (
            <button type="button" className={`btn ${e.tratado_em ? 'btn-ghost' : 'btn-primary'}`} disabled={ocupado} onClick={tratar}>{e.tratado_em ? <><Undo2 size={14} /> Reabrir</> : <><Check size={14} /> Marcar como tratada</>}</button>
          )}
        </>
      )}>
      {erro && <p className="erro-inline">{erro}</p>}
      <section className="pv-gaveta-bloco">
        <h4>O que o cliente disse</h4>
        {e.nota != null && <div style={{ marginBottom: 6 }}><Estrelas n={Number(e.nota)} /> <b>{e.nota} de 5</b></div>}
        <p className="pv-gaveta-texto">{e.texto || <span className="ink-soft">{e.motivo_externo || 'sem texto'}</span>}</p>
        {e.resposta && <p className="pv-gaveta-resposta"><Send size={12} /> <span><b>Resposta:</b> {e.resposta}{e.respondida_por_nome ? <span className="ink-soft"> — {e.respondida_por_nome}, {quando(e.respondida_em)}</span> : null}</span></p>}
      </section>
      <section className="pv-gaveta-bloco">
        <h4>Onde e o quê</h4>
        <dl className="pv-gaveta-dados">
          {e.anuncio_titulo && <><dt>Anúncio</dt><dd>{e.anuncio_titulo}</dd></>}
          {e.descricao && <><dt>Referência</dt><dd><b>{e.referencia}</b> — {e.descricao}</dd></>}
          {(e.cor || e.tamanho) && <><dt>Cor / tamanho</dt><dd>{[e.cor, e.tamanho].filter(Boolean).join(' / ')}</dd></>}
          {e.pedido_numero && <><dt>Pedido</dt><dd>#{e.pedido_numero}</dd></>}
          {e.comprador_nome && <><dt>Comprador</dt><dd>{e.comprador_nome}</dd></>}
          {e.quantidade != null && <><dt>Peças</dt><dd>{formatQtd(e.quantidade)}</dd></>}
          {e.valor != null && <><dt>Valor</dt><dd>{brl(Number(e.valor))}</dd></>}
          {e.motivo_externo && <><dt>Motivo na plataforma</dt><dd>{e.motivo_externo}</dd></>}
          {e.status_externo && <><dt>Situação na plataforma</dt><dd>{e.status_externo}</dd></>}
          {e.destino && <><dt>Destino</dt><dd>{e.destino}</dd></>}
          {e.tratado_em && <><dt>Tratada por</dt><dd>{e.tratado_por_nome || '—'} em {quando(e.tratado_em)}{e.tratamento ? ` — ${e.tratamento}` : ''}</dd></>}
        </dl>
      </section>
      {classificavel && (
        <section className="pv-gaveta-bloco">
          <h4>Motivo <span className="ink-soft">(alimenta {e.motivo && opcoes?.motivos.find((m) => m.chave === e.motivo)?.alimenta ? ALIMENTA_ROTULO[opcoes.motivos.find((m) => m.chave === e.motivo).alimenta] : 'ninguém ainda'})</span></h4>
          <div className="pv-motivos-chips">
            {(opcoes?.motivos || []).map((m) => (
              <button key={m.chave} type="button" className={`pv-chip-motivo${e.motivo === m.chave ? ' ativo' : ''}`} disabled={ocupado} onClick={() => classificar(e.motivo === m.chave ? null : m.chave)}>{m.rotulo}</button>
            ))}
          </div>
          {e.motivo && e.motivo_origem && e.motivo_origem !== 'manual' && <p className="ink-soft" style={{ fontSize: 12, margin: '6px 0 0' }}>Classificado automaticamente {e.motivo_origem === 'plataforma' ? 'pelo código da plataforma' : 'pelo texto do cliente'} — clique em outro motivo para corrigir.</p>}
        </section>
      )}
      {e.tipo === 'pergunta' && !e.resposta && (
        <section className="pv-gaveta-bloco">
          <h4>Responder</h4>
          {e.marketplace === 'mercado_livre' ? (
            <>
              <textarea className="pv-textarea" rows={3} placeholder="Resposta ao comprador — vai para o Mercado Livre" value={resposta} onChange={(ev) => setResposta(ev.target.value)} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}><button type="button" className="btn btn-primary" disabled={ocupado || !resposta.trim()} onClick={responder}><Send size={14} /> {ocupado ? 'Enviando…' : 'Enviar resposta'}</button></div>
            </>
          ) : <p className="ink-soft" style={{ margin: 0, fontSize: 12.5 }}>Este canal não aceita resposta por API — responda no painel da plataforma e marque como tratada aqui.</p>}
        </section>
      )}
    </Gaveta>
  );
}

// ---------------------------------------------------------------------------
// Resolver — o que exige ação, agrupado por tipo
// ---------------------------------------------------------------------------
function Resolver({ painel, onAbrir, onReferencia }) {
  const itens = painel?.acao || [];
  if (itens.length === 0) return <EstadoVazio Icone={Check} titulo="Nada exige ação agora" descricao="Sem pergunta parada, reclamação aberta, devolução em andamento, avaliação ruim sem tratar ou referência devolvendo demais na janela." />;
  const grupos = new Map();
  for (const i of itens) { const k = i.tipo; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(i); }
  const ordem = ['pergunta', 'reclamacao', 'devolucao', 'avaliacao', 'referencia', 'modelagem'];
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {ordem.filter((k) => grupos.has(k)).map((k) => {
        const lista = grupos.get(k); const T = TIPOS[k]; const urgentes = lista.filter((i) => i.nivel === 'urgente').length;
        return (
          <section key={k} className="card" style={{ padding: 0 }}>
            <div className="card-head pv-card-head"><T.Icone size={14} /> {T.plural} <span className="pv-contador">{lista.length}</span>{urgentes > 0 && <span className="stamp sm tone-prejuizo" style={{ marginLeft: 6 }}>{urgentes} urgente{urgentes > 1 ? 's' : ''}</span>}</div>
            <table className="data-table pv-tabela-acao">
              <tbody>
                {lista.map((i) => (
                  <tr key={i.chave} className={`clickable-row${i.nivel === 'urgente' ? ' pv-urgente' : ''}`} onClick={() => (i.eventoId ? onAbrir(i.eventoId) : onReferencia(i.produtoId))}>
                    <td style={{ width: 150 }}>{i.marketplace ? <Canal chave={i.marketplace} nome={i.lojaNome} /> : <span className="ink-soft">todas as lojas</span>}</td>
                    <td style={{ width: 100 }}>{i.referencia ? <b>{i.referencia}</b> : <span className="stamp sm tone-atencao">sem vínculo</span>}</td>
                    <td>
                      <div className="pv-acao-texto">{i.nota != null && <Estrelas n={Number(i.nota)} />} {i.resumo || i.texto}</div>
                      {i.detalhe && <small className="ink-soft">{i.detalhe}</small>}
                    </td>
                    <td style={{ width: 120, whiteSpace: 'nowrap' }} className="ink-soft">{i.ocorridoEm ? tempoRelativo(i.ocorridoEm) : ''}</td>
                    <td style={{ width: 130, textAlign: 'right' }}><span className="btn btn-ghost btn-mini">{i.eventoId ? <><Eye size={12} /> Ver</> : <>Ver referência <ChevronRight size={12} /></>}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Por referência
// ---------------------------------------------------------------------------
function PorReferencia({ painel, onVerEventos, onComparar }) {
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState(null);
  const linhas = useMemo(() => (painel?.porReferencia || []).filter((r) => !busca || `${r.referencia} ${r.descricao || ''}`.toLowerCase().includes(busca.toLowerCase())), [painel, busca]);
  const tabela = useTabela(linhas, { colunas: { referencia: (r) => r.referencia, taxa: (r) => Number(r.taxaDevolucao ?? -1), pecas: (r) => r.pecasDevolvidas, vendidas: (r) => r.vendidas ?? -1, reclamacoes: (r) => r.reclamacoes, nota: (r) => Number(r.notaMedia ?? 9) }, colunaPadrao: 'taxa', direcaoPadrao: 'desc', prefixo: 'pv-ref' });
  if (!painel) return <Skeleton height={200} />;
  const r = aberta ? linhas.find((x) => x.produtoId === aberta) : null;
  const Th = (p) => <ThOrdenavel atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} {...p} />;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {painel.alimenta.length > 0 && (
        <div className="pv-alimenta-lista">
          {painel.alimenta.map((a) => { const I = ALIMENTA_ICONE[a.area] || Info; return <div key={a.area} className={`pv-alimenta-item pv-a-${a.area}`}><I size={18} /><div><b>{plural(a.n, 'peça')}</b><span>{a.rotulo}</span></div></div>; })}
        </div>
      )}
      <div className="filtros-linha"><CampoBusca valor={busca} onChange={setBusca} placeholder="Referência ou descrição" /><span className="ink-soft" style={{ fontSize: 12.5 }}>{plural(linhas.length, 'referência')} com evento na janela</span></div>
      {linhas.length === 0 ? <EstadoVazio Icone={Undo2} titulo="Nenhuma referência com evento na janela" descricao="Leia as lojas ou registre uma devolução no Hub." /> : (
        <section className="card" style={{ padding: 0 }}>
          <Paginacao {...tabela} posicao="topo" />
          <DataTable>
            <table className="data-table">
              <thead><tr>
                <Th coluna="referencia">Referência</Th>
                <Th coluna="taxa" title="Peças devolvidas ÷ peças vendidas na janela">Devolve</Th>
                <Th coluna="pecas">Devolvidas</Th>
                <Th coluna="vendidas">Vendidas</Th>
                <Th coluna="reclamacoes">Reclamações</Th>
                <Th coluna="nota">Nota</Th>
                <th>Para quem fala</th>
                <th />
              </tr></thead>
              <tbody>
                {tabela.itensPagina.map((x) => (
                  <tr key={x.produtoId} className="clickable-row" onClick={() => setAberta(x.produtoId)}>
                    <td><b>{x.referencia}</b> <span className="ink-soft">{x.descricao}</span></td>
                    <td><b className={x.taxaDevolucao >= 0.08 ? 'pv-ruim' : ''}>{pct(x.taxaDevolucao)}</b>{x.amostraPequena && <span className="stamp sm tone-neutro" style={{ marginLeft: 6 }} title="menos de 20 peças vendidas na janela — uma devolução a mais muda tudo">amostra pequena</span>}</td>
                    <td>{formatQtd(x.pecasDevolvidas)}</td>
                    <td>{x.vendidas == null ? '—' : formatQtd(x.vendidas)}</td>
                    <td>{x.reclamacoes}</td>
                    <td>{x.notaMedia != null ? <>{numeroBr(x.notaMedia, 2)} <span className="ink-soft">({x.avaliacoes})</span></> : '—'}</td>
                    <td>{x.alimenta ? <Alimenta area={x.alimenta.area} /> : (x.motivos[0] ? <span className="stamp sm tone-neutro">{x.motivos[0].rotulo}</span> : '—')}</td>
                    <td style={{ textAlign: 'right' }}><span className="btn btn-ghost btn-mini"><Eye size={12} /> Ver</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
          <Paginacao {...tabela} posicao="rodape" />
        </section>
      )}
      {r && (
        <Gaveta aberta larga onFechar={() => setAberta(null)} Icone={Undo2} titulo={<>{r.referencia} <span className="ink-soft" style={{ fontWeight: 400 }}>{r.descricao}</span></>}
          subtitulo={`${pct(r.taxaDevolucao)} de devolução · ${formatQtd(r.pecasDevolvidas)} de ${r.vendidas == null ? '?' : formatQtd(r.vendidas)} peças · ${plural(r.reclamacoes, 'reclamação', 'reclamações')} · nota ${r.notaMedia != null ? numeroBr(r.notaMedia, 2) : '—'}`}
          rodape={<><button type="button" className="btn btn-ghost" onClick={() => { setAberta(null); onComparar(r.produtoId); }}><TrendingUp size={14} /> Evolução e comparar períodos</button><span style={{ flex: 1 }} /><button type="button" className="btn btn-primary" onClick={() => { setAberta(null); onVerEventos(r.produtoId); }}>Ver os eventos <ChevronRight size={14} /></button></>}>
          {r.sinais.length > 0 && <div className="pv-sinais">{r.sinais.map((s) => <span key={`${s.tamanho}${s.sinal}`} className="pv-sinal"><Ruler size={13} /> {s.texto}</span>)}</div>}
          {r.alimenta && <p className="pv-gaveta-alimenta"><Alimenta area={r.alimenta.area} /> <span>{r.alimenta.rotulo} — {plural(r.alimenta.n, 'peça')}</span></p>}
          <div className="pv-quadros">
            <section className="pv-gaveta-bloco"><h4><Undo2 size={13} /> Motivos das devoluções</h4>
              {r.motivos.length === 0 ? <p className="ink-soft" style={{ margin: 0, fontSize: 12.5 }}>sem motivo classificado — classifique nos eventos</p> : (
                <table className="data-table pv-mini"><tbody>{r.motivos.map((m) => <tr key={m.motivo}><td>{m.rotulo}</td><td><Alimenta area={m.alimenta} /></td><td style={{ textAlign: 'right' }}><b>{m.n}</b></td></tr>)}</tbody></table>
              )}
            </section>
            <section className="pv-gaveta-bloco"><h4><Ruler size={13} /> Por tamanho</h4>
              <table className="data-table pv-mini"><thead><tr><th>Tam.</th><th>Devolv.</th><th>Vend.</th><th>Taxa</th><th>Pequeno</th><th>Grande</th><th>Defeito</th></tr></thead>
                <tbody>{r.tamanhos.map((t) => <tr key={t.tamanho}><td><b>{t.tamanho}</b></td><td>{t.pecasDevolvidas}</td><td>{t.vendidas ?? '—'}</td><td className={t.taxa >= 0.1 ? 'pv-ruim' : ''}>{pct(t.taxa)}</td><td className={t.pequeno >= 3 ? 'pv-ruim' : ''}>{t.pequeno || '·'}</td><td className={t.grande >= 3 ? 'pv-ruim' : ''}>{t.grande || '·'}</td><td className={t.defeito >= 3 ? 'pv-ruim' : ''}>{t.defeito || '·'}</td></tr>)}</tbody></table>
            </section>
            {r.perguntasTema.length > 0 && (
              <section className="pv-gaveta-bloco"><h4><MessageCircleQuestion size={13} /> O que perguntam antes de comprar</h4>
                <table className="data-table pv-mini"><tbody>{r.perguntasTema.map((t) => <tr key={t.tema}><td>{t.tema}</td><td style={{ textAlign: 'right' }}><b>{t.n}</b></td></tr>)}</tbody></table>
              </section>
            )}
          </div>
        </Gaveta>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evolução — a série no tempo e o comparador de períodos
// ---------------------------------------------------------------------------
function Evolucao({ periodo, painel, produtoInicial }) {
  const [granularidade, setGranularidade] = useState('mes');
  const [produtoId, setProdutoId] = useState(produtoInicial ? String(produtoInicial) : '');
  const [serie, setSerie] = useState(null);
  const [erro, setErro] = useState(null);
  // Comparador: A = os 3 meses anteriores ao período da tela, B = o período da tela.
  const [a, setA] = useState(() => { const ini = new Date(`${periodo.inicio}T00:00:00`); const fim = new Date(ini.getTime() - 86400000); const ini2 = new Date(fim.getTime()); ini2.setMonth(ini2.getMonth() - 3); return { inicio: ini2.toISOString().slice(0, 10), fim: fim.toISOString().slice(0, 10) }; });
  const [b, setB] = useState(periodo);
  const [comp, setComp] = useState(null);
  const [buscaComp, setBuscaComp] = useState('');
  useEffect(() => { setProdutoId(produtoInicial ? String(produtoInicial) : ''); }, [produtoInicial]);
  useEffect(() => {
    setSerie(null);
    const qs = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim, granularidade }); if (produtoId) qs.set('produto_id', produtoId);
    api.get(`${ROTA}/evolucao?${qs}`).then(setSerie).catch((e) => setErro(e.message));
  }, [periodo, granularidade, produtoId]);
  useEffect(() => {
    setComp(null);
    api.get(`${ROTA}/comparar?a_inicio=${a.inicio}&a_fim=${a.fim}&b_inicio=${b.inicio}&b_fim=${b.fim}`).then(setComp).catch((e) => setErro(e.message));
  }, [a, b]);

  const referencias = painel?.porReferencia || [];
  const dados = (serie?.serie || []).map((s) => ({ rotulo: rotuloBalde(s.balde, granularidade), taxa: s.taxa == null ? null : Number((s.taxa * 100).toFixed(2)), nota: s.notaMedia, devolvidas: s.devolvidas, vendidas: s.vendidas, reclamacoes: s.reclamacoes, ruins: s.ruins }));
  const linhasComp = useMemo(() => (comp?.linhas || []).filter((l) => (!produtoId || String(l.produtoId) === produtoId) && (!buscaComp || `${l.referencia} ${l.descricao || ''}`.toLowerCase().includes(buscaComp.toLowerCase()))), [comp, produtoId, buscaComp]);
  const refSel = referencias.find((r) => String(r.produtoId) === produtoId);
  const piorou = (comp?.linhas || []).filter((l) => l.delta != null && l.delta > 0.02 && !l.b.amostraPequena).length;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <div className="filtros-linha">
        <span className="mp-seg">{[['mes', 'Por mês'], ['semana', 'Por semana']].map(([k, r]) => <button key={k} type="button" aria-pressed={granularidade === k} onClick={() => setGranularidade(k)}>{r}</button>)}</span>
        <Select value={produtoId} onChange={(e) => setProdutoId(e.target.value)} style={{ maxWidth: 360 }} chaveRecentes="pv_evolucao_ref">
          <option value="">Todas as referências</option>
          {referencias.map((r) => <option key={r.produtoId} value={String(r.produtoId)}>{r.referencia} — {r.descricao}</option>)}
        </Select>
        <span className="ink-soft" style={{ fontSize: 12.5 }}>{dataBr(periodo.inicio)} a {dataBr(periodo.fim)} — mude o período no topo da tela</span>
      </div>

      <CartaoGrafico titulo={`Taxa de devolução ${refSel ? `da ${refSel.referencia}` : 'geral'}, ${granularidade === 'mes' ? 'mês a mês' : 'semana a semana'}`} explicacao="Peças devolvidas (plataforma + registradas no Hub) ÷ peças vendidas no mesmo balde, com o kit aberto. Balde sem venda fica sem ponto — não é zero." altura={240}
        vazio={serie && dados.every((d) => d.taxa == null) ? 'Sem venda medida no período.' : null}>
        {!serie ? <Skeleton height={220} /> : <GraficoEvolucao dados={dados} series={[{ chave: 'taxa', nome: 'Devolução' }]} formato="percentual" altura={220} />}
      </CartaoGrafico>

      {serie && dados.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-head pv-card-head"><TrendingUp size={14} /> Balde a balde</div>
          <DataTable>
            <table className="data-table">
              <thead><tr><th>{granularidade === 'mes' ? 'Mês' : 'Semana de'}</th><th>Vendidas</th><th>Devolvidas</th><th>Devolve</th><th>por tamanho</th><th>por defeito</th><th>Reclamações</th><th>Avaliações</th><th>Nota</th><th>1–2★</th></tr></thead>
              <tbody>{(serie.serie || []).map((s, i, arr) => {
                const ant = i > 0 ? arr[i - 1].taxa : null; const d = s.taxa != null && ant != null ? s.taxa - ant : null;
                return (
                  <tr key={s.balde}>
                    <td><b>{rotuloBalde(s.balde, granularidade)}</b></td><td>{formatQtd(s.vendidas)}</td><td>{formatQtd(s.devolvidas)}</td>
                    <td><b className={s.taxa >= 0.08 ? 'pv-ruim' : ''}>{pct(s.taxa)}</b>{d != null && Math.abs(d) >= 0.005 && <span className={`pv-delta ${d > 0 ? 'sobe' : 'desce'}`}>{d > 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}{pontos(d)}</span>}</td>
                    <td>{s.devTamanho || '·'}</td><td>{s.devDefeito || '·'}</td><td>{s.reclamacoes || '·'}</td><td>{s.avaliacoes || '·'}</td><td>{s.notaMedia != null ? numeroBr(s.notaMedia, 2) : '—'}</td><td className={s.ruins > 0 ? 'pv-ruim' : ''}>{s.ruins || '·'}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </DataTable>
        </section>
      )}

      <section className="card" style={{ padding: 0 }}>
        <div className="card-head pv-card-head"><TrendingUp size={14} /> Comparar dois períodos, por referência {piorou > 0 && <span className="stamp sm tone-prejuizo" style={{ marginLeft: 6 }}>{piorou} pioraram mais de 2 pt</span>}</div>
        <div className="pv-comparar-barra">
          <div className="pv-periodo"><span className="pv-periodo-rotulo pv-periodo-a">A</span><PeriodoFiltro inicio={a.inicio} fim={a.fim} onChange={setA} /></div>
          <span className="ink-soft">contra</span>
          <div className="pv-periodo"><span className="pv-periodo-rotulo pv-periodo-b">B</span><PeriodoFiltro inicio={b.inicio} fim={b.fim} onChange={setB} /></div>
          <span style={{ flex: 1 }} />
          <CampoBusca valor={buscaComp} onChange={setBuscaComp} placeholder="Referência" />
        </div>
        {comp && (
          <div className="pv-comparar-totais">
            <span><b className="pv-periodo-rotulo pv-periodo-a">A</b> {pct(comp.a.taxa)} <span className="ink-soft">({formatQtd(comp.a.devolvidas)} de {formatQtd(comp.a.vendidas)} peças)</span></span>
            <span><b className="pv-periodo-rotulo pv-periodo-b">B</b> {pct(comp.b.taxa)} <span className="ink-soft">({formatQtd(comp.b.devolvidas)} de {formatQtd(comp.b.vendidas)} peças)</span></span>
            {comp.a.taxa != null && comp.b.taxa != null && <span className={`pv-delta ${comp.b.taxa > comp.a.taxa ? 'sobe' : 'desce'}`}>{comp.b.taxa > comp.a.taxa ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{pontos(comp.b.taxa - comp.a.taxa)} no geral</span>}
          </div>
        )}
        {!comp ? <Skeleton height={160} /> : linhasComp.length === 0 ? <p className="ink-soft" style={{ padding: 16, margin: 0 }}>Nenhuma referência com evento nos dois períodos.</p> : (
          <DataTable>
            <table className="data-table">
              <thead><tr><th>Referência</th><th>Devolve em A</th><th>Devolve em B</th><th>Diferença</th><th>Nota A → B</th><th>Reclam. A → B</th><th>O que mais cresceu</th></tr></thead>
              <tbody>{linhasComp.map((l) => (
                <tr key={l.produtoId}>
                  <td><b>{l.referencia}</b> <span className="ink-soft">{l.descricao}</span></td>
                  <td>{pct(l.a.taxa)} <span className="ink-soft">{l.a.vendidas != null ? `(${formatQtd(l.a.devolvidas)}/${formatQtd(l.a.vendidas)})` : ''}</span>{l.a.amostraPequena && <span className="ink-soft" title="amostra pequena"> *</span>}</td>
                  <td>{pct(l.b.taxa)} <span className="ink-soft">{l.b.vendidas != null ? `(${formatQtd(l.b.devolvidas)}/${formatQtd(l.b.vendidas)})` : ''}</span>{l.b.amostraPequena && <span className="ink-soft" title="amostra pequena"> *</span>}</td>
                  <td>{l.delta == null ? <span className="ink-soft">sem base</span> : <span className={`pv-delta ${l.delta > 0.005 ? 'sobe' : l.delta < -0.005 ? 'desce' : ''}`}>{l.delta > 0.005 ? <ArrowUpRight size={12} /> : l.delta < -0.005 ? <ArrowDownRight size={12} /> : null}{pontos(l.delta)}</span>}</td>
                  <td>{l.a.notaMedia != null ? numeroBr(l.a.notaMedia, 2) : '—'} → {l.b.notaMedia != null ? numeroBr(l.b.notaMedia, 2) : '—'}{l.deltaNota != null && l.deltaNota !== 0 && <span className={`pv-delta ${l.deltaNota < 0 ? 'sobe' : 'desce'}`}> {l.deltaNota > 0 ? '+' : ''}{numeroBr(l.deltaNota, 2)}</span>}</td>
                  <td>{l.a.reclamacoes} → {l.b.reclamacoes}</td>
                  <td>{l.motivoQueCresceu ? <><span className="stamp sm tone-neutro">{l.motivoQueCresceu.rotulo}</span> <span className="ink-soft">{l.motivoQueCresceu.de} → {l.motivoQueCresceu.para}</span> <Alimenta area={l.motivoQueCresceu.alimenta} /></> : <span className="ink-soft">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </DataTable>
        )}
        <p className="pv-nota"><Info size={13} /> "Diferença" é em pontos percentuais (10% → 15% = +5,0 pt). * amostra pequena: menos de 20 peças vendidas naquele período.</p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Eventos — a lista
// ---------------------------------------------------------------------------
function Eventos({ periodo, opcoes, filtroInicial, onAbrir, recarregarChave }) {
  const [filtro, setFiltro] = useState({ tipo: '', marketplace: '', aberto: false, motivo: '', produto_id: '', relevantes: true, semVinculo: false, ...filtroInicial });
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  useEffect(() => { setFiltro((f) => ({ ...f, ...filtroInicial })); }, [filtroInicial]);
  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const qs = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim });
      for (const [k, v] of Object.entries(filtro)) if (v) qs.set(k === 'semVinculo' ? 'sem_vinculo' : k, v === true ? '1' : v);
      setDados(await api.get(`${ROTA}/eventos?${qs}`));
    } catch (e) { setErro(e.message); }
  }, [periodo, filtro]);
  useEffect(() => { carregar(); }, [carregar, recarregarChave]);
  const eventos = dados?.eventos || [];
  const tabela = useTabela(eventos, { colunas: { quando: (r) => new Date(r.ocorrido_em).getTime(), tipo: (r) => r.tipo, referencia: (r) => r.referencia || '' }, colunaPadrao: 'quando', direcaoPadrao: 'desc', prefixo: 'pv-ev' });
  const Th = (p) => <ThOrdenavel atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} {...p} />;
  const refSel = filtro.produto_id ? eventos.find((e) => String(e.produto_id) === String(filtro.produto_id)) : null;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <div className="filtros-linha">
        <span className="mp-seg">{[['', 'Todos'], ['devolucao', 'Devoluções'], ['reclamacao', 'Reclamações'], ['pergunta', 'Perguntas'], ['avaliacao', 'Avaliações']].map(([k, r]) => <button key={k} type="button" aria-pressed={filtro.tipo === k} onClick={() => setFiltro({ ...filtro, tipo: k })}>{r}</button>)}</span>
        <Select value={filtro.marketplace} onChange={(e) => setFiltro({ ...filtro, marketplace: e.target.value })} style={{ maxWidth: 180 }}><option value="">Todos os canais</option>{Object.entries(CANAIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select value={filtro.motivo} onChange={(e) => setFiltro({ ...filtro, motivo: e.target.value })} style={{ maxWidth: 190 }}><option value="">Qualquer motivo</option><option value="sem">Sem classificar</option>{(opcoes?.motivos || []).map((m) => <option key={m.chave} value={m.chave}>{m.rotulo}</option>)}</Select>
        <span className="pv-toggle"><Toggle checked={filtro.aberto} onChange={(e) => setFiltro({ ...filtro, aberto: e.target.checked })} /> só em aberto</span>
        <span className="pv-toggle" title="Esconde avaliação de 4★ ou mais sem comentário"><Toggle checked={filtro.relevantes} onChange={(e) => setFiltro({ ...filtro, relevantes: e.target.checked })} /> só com texto ou nota baixa</span>
        <span className="pv-toggle"><Toggle checked={filtro.semVinculo} onChange={(e) => setFiltro({ ...filtro, semVinculo: e.target.checked })} /> só sem vínculo</span>
        {filtro.produto_id && <span className="chip-filtro"><span className="chip-filtro-campo">Referência</span><span className="chip-filtro-valor">{refSel?.referencia || `#${filtro.produto_id}`}</span><button type="button" onClick={() => setFiltro({ ...filtro, produto_id: '' })} title="Remover"><X size={11} /></button></span>}
        <span style={{ flex: 1 }} /><span className="ink-soft" style={{ fontSize: 12.5 }}>{dados ? plural(dados.total, 'evento') : ''}</span>
      </div>
      {!dados ? <Skeleton height={200} /> : eventos.length === 0 ? <EstadoVazio Icone={MessageSquareWarning} titulo="Nenhum evento com esse filtro" /> : (
        <section className="card" style={{ padding: 0 }}>
          <Paginacao {...tabela} posicao="topo" />
          <DataTable>
            <table className="data-table pv-tabela-eventos">
              <thead><tr><Th coluna="quando">Quando</Th><Th coluna="tipo">Tipo</Th><th>Canal</th><Th coluna="referencia">Referência</Th><th>O que o cliente disse</th><th>Motivo</th><th>Situação</th></tr></thead>
              <tbody>
                {tabela.itensPagina.map((e) => (
                  <tr key={e.id} className="clickable-row" onClick={() => onAbrir(e)}>
                    <td style={{ whiteSpace: 'nowrap' }}>{quando(e.ocorrido_em)}</td>
                    <td><Tipo chave={e.tipo} /></td>
                    <td><Canal chave={e.marketplace} nome={e.manual ? 'No Hub' : e.loja_nome} /></td>
                    <td>{e.referencia ? <><b>{e.referencia}</b>{(e.cor || e.tamanho) && <span className="ink-soft"> · {[e.cor, e.tamanho].filter(Boolean).join(' / ')}</span>}</> : <span className="stamp sm tone-atencao">sem vínculo</span>}</td>
                    <td className="pv-col-texto"><div className="pv-texto">{e.nota != null && <Estrelas n={Number(e.nota)} />} {e.texto || <span className="ink-soft">{e.motivo_externo || '—'}</span>}</div>{e.resposta && <div className="pv-resposta"><Send size={11} /> respondida</div>}</td>
                    <td>{e.motivo ? <span className={`stamp sm ${e.motivo_origem === 'manual' ? 'tone-saudavel' : 'tone-neutro'}`}>{opcoes?.motivos.find((m) => m.chave === e.motivo)?.rotulo || e.motivo}</span> : (e.tipo === 'pergunta' ? <span className="ink-soft">{e.tema || '—'}</span> : ((e.tipo === 'devolucao' || e.tipo === 'reclamacao' || (e.tipo === 'avaliacao' && Number(e.nota) <= 3)) ? <span className="stamp sm tone-atencao">classificar</span> : <span className="ink-soft">—</span>))}</td>
                    <td><Situacao e={e} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
          <Paginacao {...tabela} posicao="rodape" />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devoluções registradas no Hub
// ---------------------------------------------------------------------------
function DevolucoesHub({ opcoes, destaque, onMudou }) {
  const [lista, setLista] = useState(null);
  const [erro, setErro] = useState(null);
  const [nova, setNova] = useState(null);
  const [itensPedido, setItensPedido] = useState([]);
  const [aberta, setAberta] = useState(destaque || null);
  const [detalhe, setDetalhe] = useState(null);
  const [destinos, setDestinos] = useState({});
  const [buscando, setBuscando] = useState(false);

  const carregar = useCallback(async () => { try { setLista(await api.get('/devolucoes')); } catch (e) { setErro(e.message); } }, []);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => { setAberta(destaque || null); }, [destaque]);
  useEffect(() => { if (!aberta) { setDetalhe(null); return; } api.get(`/devolucoes/${aberta}`).then(setDetalhe).catch((e) => setErro(e.message)); }, [aberta]);

  const buscarPedido = async (numero) => {
    if (!numero) return;
    setBuscando(true); setErro(null);
    try {
      const r = await api.get(`/pedidos?busca=${encodeURIComponent(numero)}`);
      const l = Array.isArray(r) ? r : (r.itens || r.pedidos || []);
      const p = l.find((x) => String(x.numero) === String(numero).trim()) || l[0];
      if (!p) { setErro('Pedido não encontrado.'); setItensPedido([]); return; }
      setNova({ ...nova, pedido_id: p.id, pedido_numero: p.numero, canal: p.origem_marketplace || p.canal_venda || 'manual' });
      setItensPedido(await api.get(`/devolucoes/pedido/${p.id}/itens`));
    } catch (e) { setErro(e.message); } finally { setBuscando(false); }
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
  const avaliar = async (id) => { const itens = (detalhe?.itens || []).map((i) => ({ id: i.item_id ?? i.id, destino: destinos[i.item_id ?? i.id] || i.destino || 'revenda' })); await acao(id, 'avaliar', { itens }); };

  const SIT = { aguardando: ['Aguardando chegar', 'tone-atencao'], recebida: ['Recebida — avaliar', 'tone-elevada'], avaliada: ['Avaliada', 'tone-saudavel'], cancelada: ['Cancelada', 'tone-neutro'] };
  const d = aberta && lista ? lista.find((x) => x.id === aberta) : null;
  const DESTINOS = opcoes?.destinos || [{ chave: 'revenda', rotulo: 'Volta a vender' }, { chave: 'segunda', rotulo: 'Segunda qualidade' }, { chave: 'conserto', rotulo: 'Conserto' }, { chave: 'descarte', rotulo: 'Descarte' }];
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {erro && <p className="erro-inline">{erro}</p>}
      <div className="filtros-linha">
        <button type="button" className="btn btn-primary" onClick={() => setNova({ pedido_numero: '', motivo: 'tamanho', qtd: {}, valor_reembolsado: '' })}><Plus size={14} /> Registrar devolução</button>
        <span className="ink-soft" style={{ fontSize: 12.5 }}>Para devolução que chega fora da plataforma, ou quando a plataforma não avisa. Ao avaliar, a peça volta ao estoque, vai para segunda qualidade, conserto ou descarte.</span>
      </div>
      {!lista ? <Skeleton height={160} /> : lista.length === 0 ? <EstadoVazio Icone={Undo2} titulo="Nenhuma devolução registrada no Hub" descricao="As devoluções lidas das plataformas ficam em Eventos. Aqui entra o que chegou por fora." acaoLabel="Registrar devolução" onAcao={() => setNova({ pedido_numero: '', motivo: 'tamanho', qtd: {}, valor_reembolsado: '' })} IconeAcao={Plus} /> : (
        <section className="card" style={{ padding: 0 }}>
          <DataTable>
            <table className="data-table">
              <thead><tr><th>Nº</th><th>Quando</th><th>Canal</th><th>Pedido</th><th>Motivo</th><th>Peças</th><th>Reembolso</th><th>Situação</th></tr></thead>
              <tbody>{lista.map((x) => (
                <tr key={x.id} className="clickable-row" onClick={() => setAberta(x.id)}>
                  <td><b>#{x.numero}</b></td><td>{dataBr(String(x.criado_em).slice(0, 10))}</td><td><Canal chave={x.canal || 'manual'} /></td><td>{x.pedido_numero ? `#${x.pedido_numero}` : (x.pedido_canal_id || '—')}</td>
                  <td>{opcoes?.motivos.find((m) => m.chave === x.motivo)?.rotulo || x.motivo}</td><td>{formatQtd(x.pecas)}</td><td>{x.valor_reembolsado == null ? '—' : brl(Number(x.valor_reembolsado))}</td>
                  <td><span className={`stamp sm ${SIT[x.situacao]?.[1] || 'tone-neutro'}`}>{SIT[x.situacao]?.[0] || x.situacao}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </DataTable>
        </section>
      )}

      {nova && (
        <Gaveta aberta onFechar={() => { setNova(null); setItensPedido([]); }} Icone={Undo2} titulo="Registrar devolução" subtitulo="Busque o pedido, marque o que voltou e quanto foi reembolsado."
          rodape={<><button type="button" className="btn btn-ghost" onClick={() => { setNova(null); setItensPedido([]); }}>Cancelar</button><span style={{ flex: 1 }} /><button type="button" className="btn btn-primary" disabled={!nova.pedido_id} onClick={abrir}><Save size={14} /> Abrir devolução</button></>}>
          <div className="pv-form">
            <label className="field"><span className="field-label">Número do pedido</span>
              <div className="pv-campo-busca"><input value={nova.pedido_numero} onChange={(e) => setNova({ ...nova, pedido_numero: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && buscarPedido(nova.pedido_numero)} placeholder="ex.: 1234" /><button type="button" className="btn btn-ghost" disabled={buscando} onClick={() => buscarPedido(nova.pedido_numero)}><Search size={14} /> {buscando ? 'Buscando…' : 'Buscar'}</button></div>
            </label>
            {nova.pedido_id && <p className="pv-form-ok"><Check size={13} /> Pedido #{nova.pedido_numero} · <Canal chave={nova.canal} /></p>}
            <label className="field"><span className="field-label">Motivo</span><Select value={nova.motivo} onChange={(e) => setNova({ ...nova, motivo: e.target.value })}>{(opcoes?.motivos || []).map((m) => <option key={m.chave} value={m.chave}>{m.rotulo}</option>)}</Select></label>
            <label className="field"><span className="field-label">O que o cliente disse</span><input value={nova.motivo_detalhe || ''} onChange={(e) => setNova({ ...nova, motivo_detalhe: e.target.value })} placeholder="opcional" /></label>
            <label className="field"><span className="field-label">Reembolso (R$)</span><NumInput step="0.01" min={0} value={nova.valor_reembolsado} onChange={(n) => setNova({ ...nova, valor_reembolsado: n ?? '' })} placeholder="0,00" /></label>
          </div>
          {itensPedido.length > 0 && (
            <section className="pv-gaveta-bloco" style={{ marginTop: 14 }}><h4>O que voltou</h4>
              <table className="data-table pv-mini"><thead><tr><th>Item</th><th>Cor / tam.</th><th>Comprou</th><th>Já devolvida</th><th>Devolve agora</th></tr></thead>
                <tbody>{itensPedido.map((i) => <tr key={i.id}><td><b>{i.referencia}</b> {i.descricao}</td><td>{[i.cor, i.tamanho].filter(Boolean).join(' / ')}</td><td>{formatQtd(i.quantidade)}</td><td>{formatQtd(i.ja_devolvida)}</td><td><NumInput className="pv-qtd" step="1" min={0} value={nova.qtd[i.id] ?? ''} onChange={(n) => setNova({ ...nova, qtd: { ...nova.qtd, [i.id]: n ?? '' } })} /></td></tr>)}</tbody></table>
            </section>
          )}
        </Gaveta>
      )}

      {d && detalhe && (
        <Gaveta aberta onFechar={() => setAberta(null)} Icone={Undo2} titulo={`Devolução #${d.numero}`} subtitulo={<><Canal chave={d.canal || 'manual'} /> · {dataBr(String(d.criado_em).slice(0, 10))}{d.pedido_numero ? ` · pedido #${d.pedido_numero}` : ''}</>}
          rodape={(
            <>
              <span className={`stamp sm ${SIT[d.situacao]?.[1] || 'tone-neutro'}`}>{SIT[d.situacao]?.[0] || d.situacao}</span>
              <span style={{ flex: 1 }} />
              {['aguardando', 'recebida'].includes(d.situacao) && <button type="button" className="btn btn-danger" onClick={async () => { if (await confirmar('Cancelar esta devolução?', { titulo: 'Cancelar devolução', confirmarTexto: 'Cancelar devolução', perigo: true })) acao(d.id, 'cancelar', { motivo: 'cancelada na tela' }); }}><X size={13} /> Cancelar</button>}
              {d.situacao === 'aguardando' && <button type="button" className="btn btn-primary" onClick={() => acao(d.id, 'receber')}><Check size={14} /> Chegou — marcar como recebida</button>}
              {d.situacao === 'recebida' && <button type="button" className="btn btn-primary" onClick={() => avaliar(d.id)}><Check size={14} /> Avaliar e dar destino</button>}
            </>
          )}>
          {detalhe.devolucao?.motivo_detalhe && <p className="pv-gaveta-texto">“{detalhe.devolucao.motivo_detalhe}”</p>}
          <section className="pv-gaveta-bloco"><h4>Peças</h4>
            <table className="data-table pv-mini"><thead><tr><th>Item</th><th>Cor / tam.</th><th>Peças</th><th>Destino</th></tr></thead>
              <tbody>{(detalhe.itens || []).map((i) => { const iid = i.item_id ?? i.id; return <tr key={iid}><td><b>{i.referencia}</b> {i.descricao_livre || ''}</td><td>{[i.cor, i.tamanho].filter(Boolean).join(' / ')}</td><td>{formatQtd(i.quantidade)}</td>
                <td>{d.situacao === 'recebida' ? <Select value={destinos[iid] || i.destino || 'revenda'} onChange={(e) => setDestinos({ ...destinos, [iid]: e.target.value })}>{DESTINOS.map((x) => <option key={x.chave} value={x.chave}>{x.rotulo}</option>)}</Select> : (DESTINOS.find((x) => x.chave === i.destino)?.rotulo || i.destino || '—')}</td></tr>; })}</tbody></table>
          </section>
          <dl className="pv-gaveta-dados">
            <dt>Motivo</dt><dd>{opcoes?.motivos.find((m) => m.chave === d.motivo)?.rotulo || d.motivo}</dd>
            <dt>Reembolso</dt><dd>{d.valor_reembolsado == null ? '—' : brl(Number(d.valor_reembolsado))}</dd>
          </dl>
        </Gaveta>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gaveta das lojas — o que cada fonte deu, com o erro por escrito
// ---------------------------------------------------------------------------
function GavetaLojas({ lojas, onFechar, onLer, lendo }) {
  const F = ({ v }) => (v == null ? <span className="ink-soft">—</span> : v === 'ok' ? <span className="stamp sm tone-saudavel">ok</span> : v === 'sem_api' ? <span className="stamp sm tone-neutro" title="a plataforma não expõe por API">sem API</span> : v === 'na reclamação' ? <span className="stamp sm tone-neutro" title="a devolução do Mercado Livre chega pela reclamação">na reclamação</span> : <span className="stamp sm tone-prejuizo">erro</span>);
  return (
    <Gaveta aberta larga onFechar={onFechar} Icone={Store} titulo="Lojas e fontes" subtitulo="O que cada loja dá por API. Leitura automática de hora em hora; o erro fica escrito aqui até a próxima leitura dar certo.">
      <table className="data-table pv-mini">
        <thead><tr><th>Loja</th><th>Última leitura</th><th>Devolução</th><th>Reclamação</th><th>Pergunta</th><th>Avaliação</th><th /></tr></thead>
        <tbody>{lojas.map((l) => {
          const erros = Object.entries(l.fontes || {}).filter(([, v]) => v && !['ok', 'sem_api', 'na reclamação'].includes(v));
          return (
            <FragmentoLinha key={l.integracaoId}>
              <tr><td><Canal chave={l.marketplace} nome={l.nome} /></td><td>{l.ultimaSincronizacao ? quando(l.ultimaSincronizacao) : 'nunca'}</td><td><F v={l.fontes?.devolucao} /></td><td><F v={l.fontes?.reclamacao} /></td><td><F v={l.fontes?.pergunta} /></td><td><F v={l.fontes?.avaliacao} /></td>
                <td style={{ textAlign: 'right' }}><button type="button" className="btn btn-ghost btn-mini" disabled={lendo} onClick={() => onLer(l.integracaoId)}><RefreshCw size={12} className={lendo ? 'girando' : ''} /> Ler de novo</button></td></tr>
              {erros.length > 0 && <tr className="pv-linha-erro"><td colSpan={7}>{erros.map(([k, v]) => <div key={k}><TriangleAlert size={12} /> <b>{TIPOS[k]?.rotulo || k}:</b> {v}</div>)}</td></tr>}
            </FragmentoLinha>
          );
        })}</tbody>
      </table>
    </Gaveta>
  );
}
function FragmentoLinha({ children }) { return <>{children}</>; }

// ---------------------------------------------------------------------------
export default function PosVendaPage() {
  const [periodo, setPeriodo] = useState(() => periodoTresMeses());
  const [aba, setAba] = useState('acao');
  const [painel, setPainel] = useState(null);
  const [opcoes, setOpcoes] = useState(null);
  const [erro, setErro] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [filtroEventos, setFiltroEventos] = useState({});
  const [devolucaoDestaque, setDevolucaoDestaque] = useState(null);
  const [evolucaoProduto, setEvolucaoProduto] = useState(null);
  const [ajuda, setAjuda] = useState(false);
  const [verLojas, setVerLojas] = useState(false);
  const [eventoAberto, setEventoAberto] = useState(null);
  const [recarregarChave, setRecarregarChave] = useState(0);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try {
      const [p, o] = await Promise.all([api.get(`${ROTA}/painel?inicio=${periodo.inicio}&fim=${periodo.fim}`), opcoes || Promise.all([api.get(`${ROTA}/opcoes`), api.get('/devolucoes/opcoes')]).then(([a, b]) => ({ ...a, destinos: b.destinos }))]);
      setPainel(p); if (!opcoes) setOpcoes(o);
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, [periodo, opcoes]);
  useEffect(() => { carregar(); }, [carregar]);

  const sincronizar = async (integracaoId = null) => {
    setSincronizando(true); setErro(null);
    try { const r = await api.post(`${ROTA}/sincronizar`, integracaoId ? { integracao_id: integracaoId } : {}); const falhas = r.filter((x) => !x.ok); if (falhas.length) setErro(`Lojas com erro: ${falhas.map((f) => `${f.nome}: ${f.erro}`).join(' · ')}`); await carregar(); setRecarregarChave((k) => k + 1); } catch (e) { setErro(e.message); } finally { setSincronizando(false); }
  };
  const abrirEvento = async (idOuEvento) => {
    if (typeof idOuEvento === 'object') { setEventoAberto(idOuEvento); return; }
    try { const r = await api.get(`${ROTA}/eventos?evento_id=${idOuEvento}&inicio=2000-01-01&fim=${new Date().toISOString().slice(0, 10)}`); if (r.eventos?.[0]) setEventoAberto(r.eventos[0]); else setErro('Evento não encontrado.'); } catch (e) { setErro(e.message); }
  };
  const depoisDeMudar = async () => {
    await carregar(); setRecarregarChave((k) => k + 1);
    if (eventoAberto && !eventoAberto.manual) { try { const r = await api.get(`${ROTA}/eventos?evento_id=${eventoAberto.id}&inicio=2000-01-01&fim=${new Date().toISOString().slice(0, 10)}`); if (r.eventos?.[0]) setEventoAberto(r.eventos[0]); } catch { /* fica como está */ } }
  };
  const t = painel?.totais;
  const lojasComErro = (painel?.lojas || []).filter((l) => Object.values(l.fontes || {}).some((v) => v && !['ok', 'sem_api', 'na reclamação'].includes(v)));
  const ultimaLeitura = (painel?.lojas || []).map((l) => l.ultimaSincronizacao).filter(Boolean).sort().pop();
  const abas = [['acao', `Resolver${t ? ` (${t.acao})` : ''}`], ['referencia', 'Por referência'], ['evolucao', 'Evolução'], ['eventos', 'Eventos'], ['devolucoes', 'Devoluções no Hub']];

  return (
    <div className="pagina pv-pagina">
      <header className="pagina-topo">
        <div><h1><MessageSquareWarning size={20} /> Pós-venda</h1><p className="page-sub">O que o cliente diz depois de comprar — devolução, reclamação, pergunta, avaliação — ligado à referência, cor e tamanho.</p></div>
        <div className="pagina-acoes">
          <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
          {painel && (
            <button type="button" className={`btn btn-ghost pv-lojas-btn${lojasComErro.length ? ' com-erro' : ''}`} onClick={() => setVerLojas(true)} title="O que cada loja dá por API">
              <Store size={14} /> {plural(painel.lojas.length, 'loja')}{lojasComErro.length > 0 && <span className="pv-lojas-erro"><TriangleAlert size={12} /> {lojasComErro.length} com erro</span>}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => sincronizar()} disabled={sincronizando}><RefreshCw size={14} className={sincronizando || carregando ? 'girando' : ''} /> {sincronizando ? 'Lendo as lojas…' : 'Ler as lojas agora'}{ultimaLeitura && !sincronizando && <span className="pv-lido">· lido {hora(ultimaLeitura)}</span>}</button>
        </div>
      </header>
      {erro && <p className="erro-inline">{erro}</p>}

      {t && (
        <div className="indicadores-faixa compacta pv-kpis">
          <button type="button" className="pv-kpi-btn" onClick={() => setAba('acao')}><IndicadorDestaque destaque Icone={TriangleAlert} tom={t.acaoUrgente > 0 ? 'negativo' : (t.acao > 0 ? 'atencao' : 'positivo')} rotulo="Preciso resolver" valor={formatQtd(t.acao)} explicacao={`${t.acaoUrgente} urgente · ${t.perguntasSemResposta} pergunta(s) sem resposta · ${t.reclamacoesAbertas} reclamação(ões) aberta(s)`} /></button>
          <IndicadorDestaque Icone={Undo2} tom={t.taxaDevolucao >= 0.08 ? 'negativo' : undefined} rotulo="Taxa de devolução" valor={pct(t.taxaDevolucao)} explicacao={`${formatQtd(t.pecasDevolvidas)} de ${formatQtd(t.pecasVendidas)} peças vendidas na janela`} />
          <IndicadorDestaque Icone={Star} rotulo="Nota média" valor={t.notaMedia != null ? numeroBr(t.notaMedia, 2) : '—'} explicacao={`${plural(t.avaliacoes, 'avaliação', 'avaliações')} · ${plural(t.reclamacoes, 'reclamação', 'reclamações')}`} />
          <button type="button" className="pv-kpi-btn" onClick={() => { setFiltroEventos({ semVinculo: true, relevantes: false }); setAba('eventos'); }}><IndicadorDestaque Icone={Link2Off} tom={t.semVinculo > 0 ? 'atencao' : 'positivo'} rotulo="Sem vínculo com o produto" valor={formatQtd(t.semVinculo)} explicacao={t.semVinculo > 0 ? `de ${formatQtd(t.avaliacoes + t.devolucoes + t.reclamacoes + t.perguntas)} eventos não acharam a referência — não entram na taxa por referência. ${t.semMotivo} sem motivo classificado.` : 'Todos os eventos acharam a referência.'} /></button>
        </div>
      )}

      <div className="subtab-row">
        {abas.map(([k, r]) => <button key={k} type="button" className={`subtab-btn ${aba === k ? 'active' : ''}`} onClick={() => setAba(k)}>{r}</button>)}
      </div>

      {carregando && !painel ? <Skeleton height={200} /> : (
        <>
          {aba === 'acao' && <Resolver painel={painel} onAbrir={abrirEvento} onReferencia={(pid) => { setEvolucaoProduto(pid); setAba('referencia'); }} />}
          {aba === 'referencia' && <PorReferencia painel={painel} onVerEventos={(pid) => { setFiltroEventos({ produto_id: String(pid), relevantes: false }); setAba('eventos'); }} onComparar={(pid) => { setEvolucaoProduto(pid); setAba('evolucao'); }} />}
          {aba === 'evolucao' && <Evolucao periodo={periodo} painel={painel} produtoInicial={evolucaoProduto} />}
          {aba === 'eventos' && <Eventos periodo={periodo} opcoes={opcoes} filtroInicial={filtroEventos} onAbrir={abrirEvento} recarregarChave={recarregarChave} />}
          {aba === 'devolucoes' && <DevolucoesHub opcoes={opcoes} destaque={devolucaoDestaque} onMudou={carregar} />}
        </>
      )}

      {eventoAberto && <GavetaEvento evento={eventoAberto} opcoes={opcoes} onFechar={() => setEventoAberto(null)} onMudou={depoisDeMudar} onDevolucao={(id) => { setEventoAberto(null); setDevolucaoDestaque(id); setAba('devolucoes'); }} />}
      {verLojas && painel && <GavetaLojas lojas={painel.lojas} onFechar={() => setVerLojas(false)} onLer={(id) => sincronizar(id)} lendo={sincronizando} />}

      <div>
        <button type="button" className="mp-ajuda-btn" onClick={() => setAjuda(!ajuda)}>{ajuda ? <X size={13} /> : <Info size={13} />} Como esta tela calcula</button>
        {ajuda && <div className="mp-ajuda" style={{ marginTop: 8 }}><ul style={{ margin: 0, paddingLeft: 18 }}>{(painel?.avisos || []).map((a) => <li key={a}>{a}</li>)}<li><b>Ligação com o produto:</b> pelo pedido da plataforma (que já tem referência, cor e tamanho), senão pela variação do anúncio, senão pelo SKU. O que não casa aparece como "sem vínculo".</li><li><b>Evolução:</b> a mesma taxa, cortada por mês ou semana pela data do evento e do pedido; a comparação entre períodos é em pontos percentuais.</li><li><b>Responder pergunta:</b> só o Mercado Livre aceita por API; a resposta vai para o ar na hora e fica registrada com quem respondeu.</li></ul></div>}
      </div>
    </div>
  );
}
