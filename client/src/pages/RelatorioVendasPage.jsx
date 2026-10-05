// Relatório de Vendas (02/10/2026) — Vendas › Resultado › Relatório de Vendas.
//
// A tela é o mesmo relatório que foi apresentado aos diretores (arquivo HTML
// único), agora dentro do Hub: abre no Geral, afunila Grupo › Subgrupo ›
// Referência, tem filtros de período e canal, Destaques e comentários
// editáveis, impressão e "Salvar versão editada".
//
// Como funciona:
//   - o modelo (relatorio/relatorioVendas.html) entra no pacote como texto;
//   - os dados vêm de /api/vendas/relatorio/dados (exige login + módulo Vendas;
//     o arquivo não fica na pasta pública);
//   - o modelo recebe o JSON e roda num iframe (srcdoc), isolado do CSS do Hub,
//     seguindo o tema claro/escuro do Hub;
//   - os textos editados ficam guardados neste navegador; "Salvar versão
//     editada" baixa o arquivo avulso com eles gravados dentro.
//
// Desde 05/10/2026 o relatório se ALIMENTA SOZINHO: o servidor junta o
// histórico da exportação do Wik (até set/26) com os meses seguintes, montados
// a partir dos pedidos que o ciclo do Wik já sincroniza (lib/relatorioVendas.js).
// A faixa de cima diz até onde vai cada parte, o que ainda falta chegar do Wik
// e, em "Como estes números são montados", mostra a CONFERÊNCIA: os últimos
// meses do histórico montados também pelo Hub, lado a lado com a exportação.
//
// O botão "Abrir outro JSON do Wik" mostra um arquivo novo SÓ nesta tela, sem
// gravar no sistema.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import modelo from '../relatorio/relatorioVendas.html?raw';
import { api } from '../api/client';
import { AvisoDeFalha, Skeleton } from '../components/ui';

const CHAVES = ['months', 'canais', 'grupos', 'subs', 'marcas', 'refs', 'f', 'cores', 'c', 'tams', 't', 'o'];
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function validar(d) {
  if (!d || typeof d !== 'object') return 'O arquivo não é um JSON de objeto.';
  const faltando = CHAVES.filter((k) => !Array.isArray(d[k]));
  if (faltando.length) return `Faltam no arquivo: ${faltando.join(', ')}.`;
  if (!d.f.length) return 'O arquivo não tem nenhuma linha de venda (f).';
  const r = d.f[0];
  if (!Array.isArray(r) || r.length < 6) return 'As linhas de venda (f) não estão no formato [ref, mês, canal, peças, faturamento, custo].';
  return null;
}

function mesCurto(ym) {
  const [a, m] = String(ym || '').split('-');
  return a && m ? `${MES[Number(m) - 1]}/${a.slice(2)}` : '—';
}

function dataBr(s) {
  const p = String(s || '').split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '—';
}

const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCurto = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e6) return `R$ ${(n / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mi`;
  if (Math.abs(n) >= 1e4) return `R$ ${(n / 1e3).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mil`;
  return brl(n);
};

function haQuanto(iso) {
  if (!iso) return null;
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(min)) return null;
  if (min < 1) return 'agora há pouco';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

// Diferença entre o que o Hub montou e a exportação, para um mês da conferência.
function situacaoConferencia(c) {
  const hist = Number(c.historico?.fat) || 0;
  const hub = Number(c.hub?.fat) || 0;
  if (!c.pedidosNoHub) return { tipo: 'sem', texto: 'O Hub não tem pedidos deste mês (a sincronização começou depois)' };
  // Mês que o Hub só tem pela metade (a sincronização começou no meio dele, ou
  // os itens ainda estão chegando) não serve de prova: diferença ali é falta de
  // dado, não regra errada.
  const dia = c.primeiroPedidoNoHub ? Number(String(c.primeiroPedidoNoHub).slice(8, 10)) : 1;
  if (dia > 3) return { tipo: 'sem', texto: `Incompleto no Hub (só a partir de ${dataBr(c.primeiroPedidoNoHub)}): não dá para comparar` };
  if (c.pendentes && hist && c.pendentes.valor > hist * 0.02) return { tipo: 'sem', texto: 'Itens deste mês ainda chegando do Wik: compare depois' };
  const dif = hist ? (hub - hist) / hist : 0;
  const pct = `${dif >= 0 ? '+' : '−'}${Math.abs(dif * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  if (Math.abs(dif) <= 0.01) return { tipo: 'ok', texto: `Bate (${pct})`, dif };
  return { tipo: 'dif', texto: `Diferença de ${pct}`, dif };
}

function montarDocumento(dados) {
  // `<` e `>` escapados: o JSON vai dentro de <script>, e um "</script>" numa
  // descrição de produto fecharia a tag.
  const json = JSON.stringify(dados).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return modelo
    .replace('<html lang="pt-BR">', '<html lang="pt-BR" data-embed="">')
    .replace('<script type="application/json" id="data">__DATA__</script>', () => `<script type="application/json" id="data">${json}</script>`);
}

export default function RelatorioVendasPage() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [arquivoLocal, setArquivoLocal] = useState(null); // { nome, dados }
  const [avisoArquivo, setAvisoArquivo] = useState('');
  const [altura, setAltura] = useState(640);
  const [painel, setPainel] = useState(false);
  const [atualizando, setAtualizando] = useState(false);
  const refCaixa = useRef(null);
  const refInput = useRef(null);

  const carregar = useCallback((forcar = false) => {
    setErro('');
    if (forcar) setAtualizando(true); else setDados(null);
    api.get(`/vendas/relatorio/dados${forcar ? '?atualizar=1' : ''}`)
      .then((d) => {
        const problema = validar(d);
        if (problema) throw new Error(problema);
        setDados(d);
      })
      .catch((e) => setErro(e?.message || String(e)))
      .finally(() => setAtualizando(false));
  }, []);

  useEffect(() => { carregar(false); }, [carregar]);

  // O relatório tem cabeçalho fixo e folhas que sobem do rodapé (no celular),
  // então o iframe ocupa a área visível que sobra, e não a altura do conteúdo.
  const ajustar = useCallback(() => {
    const el = refCaixa.current;
    if (!el) return;
    const topo = el.getBoundingClientRect().top;
    let fundo = window.innerHeight;
    const barra = document.querySelector('.barra-inferior');
    if (barra) {
      const r = barra.getBoundingClientRect();
      if (r.height > 0 && r.top < fundo) fundo = r.top;
    }
    setAltura(Math.max(460, Math.round(fundo - topo - 12)));
  }, []);

  useEffect(() => {
    ajustar();
    window.addEventListener('resize', ajustar);
    return () => window.removeEventListener('resize', ajustar);
  }, [ajustar, dados, arquivoLocal, painel]);

  function abrirArquivo(ev) {
    const arq = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!arq) return;
    setAvisoArquivo('');
    const leitor = new FileReader();
    leitor.onload = () => {
      try {
        const d = JSON.parse(String(leitor.result));
        const problema = validar(d);
        if (problema) { setAvisoArquivo(`Esse arquivo não serve: ${problema}`); return; }
        setArquivoLocal({ nome: arq.name, dados: d });
      } catch {
        setAvisoArquivo('Esse arquivo não é um JSON válido.');
      }
    };
    leitor.readAsText(arq, 'utf-8');
  }

  const ativo = arquivoLocal ? arquivoLocal.dados : dados;
  // Montar o documento custa (o JSON tem ~500 KB): só refaz quando o dado muda.
  const documento = useMemo(() => (ativo ? montarDocumento(ativo) : ''), [ativo]);
  const auto = !arquivoLocal && dados && dados.auto ? dados.auto : null;
  const pendTotal = auto ? auto.pendentes.reduce((acc, p) => ({ pedidos: acc.pedidos + p.pedidos, valor: acc.valor + p.valor }), { pedidos: 0, valor: 0 }) : null;
  const confs = auto ? auto.conferencia.map((c) => ({ ...c, sit: situacaoConferencia(c) })) : [];
  const confComDif = confs.some((c) => c.sit.tipo === 'dif');
  const syncErro = auto && auto.sincronizacao && auto.sincronizacao.status === 'erro';
  const periodo = ativo?.months?.length
    ? `${mesCurto(ativo.months[0])} – ${mesCurto(ativo.months[ativo.months.length - 1])}`
    : '';

  return (
    <div className="page-wide relvendas">
      <style>{`
        .relvendas-barra { display:flex; align-items:center; justify-content:space-between; gap:10px 16px; flex-wrap:wrap; margin: 0 0 10px; }
        .relvendas-info { font-size: 13px; color: var(--ink-soft); line-height: 1.4; }
        .relvendas-info b { color: var(--ink); }
        .relvendas-local { color: var(--terracotta); font-weight: 600; }
        .relvendas-acoes { display:flex; gap:8px; flex-wrap:wrap; }
        .relvendas-quadro { width: 100%; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface); box-shadow: var(--shadow-sm, 0 1px 3px rgba(66,42,21,.08)); }
        .relvendas-quadro iframe { display:block; width:100%; border:0; }
        .relvendas-esqueleto { padding: 24px; display:grid; gap:14px; }
        .relvendas-curto { display: none; }
        .relvendas-selos { display:inline-flex; gap:6px; flex-wrap:wrap; margin-left:6px; vertical-align:middle; }
        .relvendas-selo { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 10px; border-radius:999px; font-size:12px; font-weight:600; color:#fff; white-space:nowrap; }
        .relvendas-selo.auto { background: var(--success, #33512f); }
        .relvendas-selo.alerta { background: #b5651d; }
        .relvendas-selo.erro { background: var(--danger, #7a2a1d); }
        .relvendas-selo i { width:7px; height:7px; border-radius:50%; background:#fff; display:block; }
        .relvendas-link { background:none; border:0; padding:0; color: var(--terracotta); font: inherit; font-weight:600; cursor:pointer; text-decoration: underline; text-underline-offset: 3px; }
        .relvendas-painel { border:1px solid var(--border); border-radius:12px; background: var(--surface); padding:16px 18px; margin: 0 0 12px; display:grid; grid-template-columns: minmax(0, 1fr); gap:14px; }
        .relvendas-painel > * { min-width: 0; }
        .relvendas-painel h3 { font-family: var(--font-display); font-size:17px; margin:0; }
        .relvendas-painel ul { margin:0; padding-left:18px; display:grid; gap:4px; font-size:13.5px; color: var(--ink-soft); }
        .relvendas-painel ul b { color: var(--ink); }
        .relvendas-conf { width:100%; border-collapse:collapse; font-size:13px; font-variant-numeric: tabular-nums; }
        .relvendas-conf th { text-align:left; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color: var(--ink-soft); padding:6px 8px; border-bottom:1px solid var(--border); }
        .relvendas-conf td { padding:6px 8px; border-bottom:1px solid var(--border); }
        .relvendas-conf td.n, .relvendas-conf th.n { text-align:right; white-space:nowrap; }
        .relvendas-conf tr.mes td { font-weight:700; background: color-mix(in srgb, var(--border) 25%, transparent); }
        .relvendas-sit { font-weight:700; }
        .relvendas-sit.ok { color: var(--success, #33512f); }
        .relvendas-sit.dif { color: #b5651d; }
        .relvendas-sit.sem { color: var(--ink-soft); font-weight:500; }
        .relvendas-nota { font-size:12.5px; color: var(--ink-soft); }
        .relvendas-sit-mob { display:none; }
        @media (max-width: 759.98px) {
          .relvendas-barra { margin-bottom: 8px; flex-direction: column; align-items: stretch; gap: 8px; }
          .relvendas-info { font-size: 12.5px; min-width: 0; }
          .relvendas-selo { height: 26px; font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
          .relvendas-link { display: inline-flex; align-items: center; min-height: 32px; margin-top: 2px; }
          .relvendas-longo { display: none; }
          .relvendas-curto { display: inline; }
          .relvendas-acoes { flex-wrap: nowrap; }
          .relvendas-acoes .btn { min-height: 44px; padding: 0 12px; font-size: 13px; flex: 1; justify-content: center; }
          .relvendas-quadro { border-radius: 10px; }
          .relvendas-selos { display:flex; margin:6px 0 0; }
          .relvendas-painel { padding:14px; }
          .relvendas-conf { font-size:12px; }
          .relvendas-conf th, .relvendas-conf td { padding:6px 5px; }
          .relvendas-conf .col-sit { display:none; }
          .relvendas-sit-mob { display:block; font-size:11.5px; margin-top:2px; white-space:normal; }
          .relvendas-conf tr.mes td { vertical-align: top; }
          .relvendas-conf .esconde-cel { display:none; }
        }
      `}</style>

      <div className="relvendas-barra">
        <div className="relvendas-info">
          {ativo ? (
            arquivoLocal ? (
              <>
                <span className="relvendas-local">Mostrando o arquivo “{arquivoLocal.nome}” só nesta tela</span>
                {' '}— não fica salvo no sistema · <b>{periodo}</b>
              </>
            ) : (
              auto ? (
                <>
                  <b>{periodo}</b>
                  <span className="relvendas-longo">
                    {' '}· exportação do Wik até {mesCurto(auto.historicoAte)}
                    {auto.automaticoDesde ? `, automático a partir de ${mesCurto(auto.automaticoDesde)}` : ''}
                    {auto.sincronizacao?.ultima ? ` · vendas do Wik sincronizadas ${haQuanto(auto.sincronizacao.ultima)}` : ''}
                  </span>
                  <span className="relvendas-selos">
                    {syncErro ? (
                      <span className="relvendas-selo erro" title={auto.sincronizacao.erro || ''}><i />Sincronização com erro</span>
                    ) : (
                      <span className="relvendas-selo auto"><i />Atualiza sozinho</span>
                    )}
                    {pendTotal && pendTotal.pedidos > 0 && (
                      <span className="relvendas-selo alerta" title="Pedidos que já chegaram do Wik, mas cujos produtos ainda não foram puxados. Entram sozinhos nos próximos ciclos.">
                        {pendTotal.pedidos} {pendTotal.pedidos === 1 ? 'pedido' : 'pedidos'} ainda sem itens · {brlCurto(pendTotal.valor)}
                      </span>
                    )}
                    {confComDif && <span className="relvendas-selo alerta">Conferência com diferença</span>}
                  </span>
                  {' '}
                  <button type="button" className="relvendas-link" onClick={() => setPainel((v) => !v)} aria-expanded={painel}>
                    {painel ? 'Fechar' : 'Como estes números são montados'}
                  </button>
                </>
              ) : (
                <>
                  Dados do Wik · <b>{periodo}</b>
                  <span className="relvendas-longo"> · exportados em {dataBr(ativo.geradoEm)} · só operações de VENDA</span>
                </>
              )
            )
          ) : 'Carregando os dados de venda…'}
        </div>
        <div className="relvendas-acoes">
          {arquivoLocal && (
            <button type="button" className="btn btn-ghost" onClick={() => { setArquivoLocal(null); setAvisoArquivo(''); }}>
              <span className="relvendas-longo">Voltar aos dados do sistema</span>
              <span className="relvendas-curto">Voltar</span>
            </button>
          )}
          {auto && (
            <button type="button" className="btn btn-ghost" onClick={() => carregar(true)} disabled={atualizando}>
              {atualizando ? 'Atualizando…' : 'Atualizar'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => refInput.current && refInput.current.click()}>
            <span className="relvendas-longo">Abrir outro JSON do Wik</span>
            <span className="relvendas-curto">Outro JSON</span>
          </button>
          <input ref={refInput} type="file" accept="application/json,.json" hidden onChange={abrirArquivo} />
        </div>
      </div>

      {auto && painel && (
        <section className="relvendas-painel" aria-label="Como estes números são montados">
          <div>
            <h3>Como estes números são montados</h3>
            <ul style={{ marginTop: 8 }}>
              <li><b>Até {mesCurto(auto.historicoAte)}:</b> a exportação especial do Wik, do jeito que veio.</li>
              {auto.automaticoDesde ? (
                <li><b>De {mesCurto(auto.automaticoDesde)} em diante:</b> os pedidos que o Hub puxa do Wik a cada ciclo, com as mesmas regras: só VENDA (fora troca, mostruário, bonificação, consignado e cancelado), valor líquido do item com o desconto do pedido rateado, custo da ficha da peça e canal pelo nome do cliente.{auto.mesParcial ? ` ${mesCurto(auto.mesParcial)} ainda está em andamento e aparece como parcial.` : ''}</li>
              ) : (
                <li>Ainda não começou nenhum mês depois da exportação. O próximo mês entra sozinho.</li>
              )}
              {pendTotal && pendTotal.pedidos > 0 && (
                <li><b>{pendTotal.pedidos} {pendTotal.pedidos === 1 ? 'pedido' : 'pedidos'} ({brl(pendTotal.valor)})</b> já chegaram do Wik, mas os produtos ainda não. Ficam fora dos números até os itens chegarem, o que acontece sozinho nos próximos ciclos.</li>
              )}
              {auto.valorSemCusto > 0 && (
                <li><b>{brl(auto.valorSemCusto)}</b> dos meses automáticos são de peças sem ficha de custo no Hub. Ficam fora da margem, como na exportação.</li>
              )}
              {auto.referenciasSemClassificacao > 0 && (
                <li><b>{auto.referenciasSemClassificacao} {auto.referenciasSemClassificacao === 1 ? 'referência nova ainda' : 'referências novas ainda'}</b> sem grupo do Wik estão em SEM GRUPO. O grupo e o subgrupo chegam na próxima sincronização de estoque.</li>
              )}
              {syncErro && (
                <li style={{ color: 'var(--danger, #7a2a1d)' }}><b>A última sincronização de vendas com o Wik deu erro:</b> {auto.sincronizacao.erro}</li>
              )}
            </ul>
          </div>
          {confs.length > 0 && (
            <div>
              <h3>Conferência com a exportação</h3>
              <p className="relvendas-nota" style={{ margin: '4px 0 8px' }}>
                Os últimos meses da exportação montados também pelo Hub, com as regras dos meses automáticos. Se batem, as regras estão certas.
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table className="relvendas-conf">
                  <thead>
                    <tr><th>Mês / canal</th><th className="n">Exportação</th><th className="n">Montado pelo Hub</th><th className="col-sit">Situação</th></tr>
                  </thead>
                  <tbody>
                    {confs.map((c) => (
                      <Fragment key={c.mes}>
                        <tr className="mes">
                          <td>{mesCurto(c.mes)}<span className={`relvendas-sit relvendas-sit-mob ${c.sit.tipo}`}>{c.sit.texto}</span></td>
                          <td className="n">{brl(c.historico.fat)}</td>
                          <td className="n">{c.pedidosNoHub ? brl(c.hub.fat) : '—'}</td>
                          <td className="col-sit"><span className={`relvendas-sit ${c.sit.tipo}`}>{c.sit.texto}</span></td>
                        </tr>
                        {(c.sit.tipo === 'ok' || c.sit.tipo === 'dif') && (ativo.canais || []).map((nome, i) => {
                          const h = c.historico.canais[i]?.fat || 0;
                          const u = c.hub.canais[i]?.fat || 0;
                          if (!h && !u) return null;
                          const d = h ? (u - h) / h : (u ? 1 : 0);
                          return (
                            <tr key={nome}>
                              <td style={{ paddingLeft: 20 }}>{nome}</td>
                              <td className="n">{brl(h)}</td>
                              <td className="n">{brl(u)}</td>
                              <td className="esconde-cel" style={{ color: Math.abs(d) <= 0.01 ? 'var(--success, #33512f)' : '#b5651d' }}>
                                {Math.abs(d) <= 0.01 ? 'bate' : `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
                              </td>
                            </tr>
                          );
                        })}
                        {c.pendentes && c.pendentes.pedidos > 0 && (
                          <tr><td colSpan={4} className="relvendas-nota">{c.pendentes.pedidos} pedidos deste mês ({brl(c.pendentes.valor)}) ainda sem itens no Hub.</td></tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {avisoArquivo && (
        <div className="login-error" role="alert" style={{ marginBottom: 10 }}>{avisoArquivo}</div>
      )}
      <AvisoDeFalha mensagem={erro} aoTentarDeNovo={() => carregar(false)} />

      <div className="relvendas-quadro" ref={refCaixa}>
        {ativo ? (
          <iframe
            // `key` troca o documento inteiro quando o arquivo muda.
            key={arquivoLocal ? `local:${arquivoLocal.nome}` : `sistema:${ativo.geradoEm}`}
            title="Relatório de Vendas"
            srcDoc={documento}
            style={{ height: altura }}
          />
        ) : !erro ? (
          <div className="relvendas-esqueleto" style={{ height: altura }}>
            <Skeleton width="40%" height={28} />
            <Skeleton width="100%" height={90} radius={12} />
            <Skeleton width="100%" height={260} radius={12} />
            <Skeleton width="100%" height={220} radius={12} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
