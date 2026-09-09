import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Barcode, PackageCheck, ListChecks, BarChart3, CheckCircle2, XCircle, AlertTriangle,
  Undo2, Tag, LogOut, ScanLine, Package,
} from 'lucide-react';
import { api } from '../api/client';
import { StatCard, Select, DateInput } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import FotoProduto from '../components/FotoProduto';
import { dataBr, hojeIso } from '../lib/format';
import { somAcerto, somErro, somPedidoCompleto } from '../lib/somConferencia';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';

const ABAS = [
  { chave: 'bipagem', rotulo: 'Bipagem', Icone: ScanLine },
  { chave: 'fila', rotulo: 'Fila do dia', Icone: ListChecks },
  { chave: 'relatorio', rotulo: 'Relatório', Icone: BarChart3 },
];

const TOM_RESULTADO = {
  ok: 'ok',
  confirmado_manual: 'aviso',
  desfeita: 'aviso',
  ean_desconhecido: 'erro',
  fora_do_pedido: 'erro',
  quantidade_excedida: 'erro',
};

const ROTULO_RESULTADO = {
  ok: 'Conferida',
  confirmado_manual: 'Confirmada no olho',
  desfeita: 'Desfeita',
  ean_desconhecido: 'Código desconhecido',
  fora_do_pedido: 'Não é deste pedido',
  quantidade_excedida: 'Já estava completa',
};



// Identificação do pedido em uma linha, do jeito que a pessoa reconhece a
// caixa: a loja, o número da plataforma e o cliente.
//
// Texto simples de propósito, sem símbolo de plataforma próprio: quando a
// branch de Anúncios entrar, o certo é trocar isto pelo `SeloPlataforma` de
// `lib/canalMarketplace.jsx`, que é o componente único do sistema. Criar um
// símbolo local aqui seria justamente o erro que aquela decisão de direção
// proíbe.
function TituloPedido({ pedido }) {
  const plataforma = PLATAFORMA_LABEL[pedido.origem_marketplace] || pedido.origem_marketplace;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {plataforma && (
        <span className="stamp sm tone-neutro">
          {plataforma}{pedido.loja_nome ? ` · ${pedido.loja_nome}` : ''}
        </span>
      )}
      <strong className="mono">{pedido.origem_pedido_id || `#${pedido.numero}`}</strong>
      {pedido.cliente_nome && <span style={{ color: 'var(--ink-soft)' }}>· {pedido.cliente_nome}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Aba 1 — Bipagem
// ---------------------------------------------------------------------------
function AbaBipagem({ aoConcluirPedido, pedidoParaAbrir, aoAbrirPedido }) {
  const [sessao, setSessao] = useState(null); // { pedido, conferencia, itens, ... }
  const [codigo, setCodigo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  // Campos que substituem os dois window.prompt desta tela.
  const [pedindoEtiqueta, setPedindoEtiqueta] = useState(false);
  const [pedindoMotivo, setPedindoMotivo] = useState(false);
  const [etiquetaDigitada, setEtiquetaDigitada] = useState('');
  const [motivoDigitado, setMotivoDigitado] = useState('');
  const [erro, setErro] = useState('');
  const [ultima, setUltima] = useState(null); // { resultado, mensagem }
  const [overlay, setOverlay] = useState(null); // { titulo, subtitulo }
  const [abertoPorNumero, setAbertoPorNumero] = useState(false);
  const inputRef = useRef(null);

  // Foco permanente no campo. O leitor de código de barras "digita" e dá
  // Enter muito rápido; qualquer render que perca o foco corta o código no
  // meio e a leitura chega truncada. O setTimeout(0) é o detalhe que a
  // ferramenta antiga já tinha e que precisa vir junto: devolve o foco
  // DEPOIS que o React terminou de pintar.
  const focar = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(focar, [sessao?.conferencia?.id, ocupado, focar]);

  function limparSessao() {
    setSessao(null);
    setUltima(null);
    setAbertoPorNumero(false);
    setCodigo('');
    focar();
  }

  // Quando a pessoa clica numa linha da Fila, a conferência daquele pedido
  // abre aqui direto. Antes era preciso decorar o número, voltar para esta
  // aba e digitar — três ações e uma digitação, muitas vezes por dia.
  useEffect(() => {
    if (!pedidoParaAbrir || sessao) return;
    abrirPedido(pedidoParaAbrir);
    aoAbrirPedido?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedidoParaAbrir]);

  async function abrirPedido(valor) {
    setErro('');
    setOcupado(true);
    try {
      const r = await api.get(`/conferencia/abrir/${encodeURIComponent(valor)}`);
      const iniciada = r.conferencia
        ? r
        : await api.post(`/conferencia/pedidos/${r.pedido.id}/iniciar`);
      setSessao(iniciada);
      setAbertoPorNumero(r.via !== 'rastreio');
      setUltima(null);
      somAcerto();
    } catch (err) {
      somErro();
      setErro(err.message);
    } finally {
      setOcupado(false);
      focar();
    }
  }

  async function biparPeca(valor) {
    setErro('');
    setOcupado(true);
    try {
      const r = await api.post(`/conferencia/${sessao.conferencia.id}/leitura`, { codigo: valor });
      setSessao(r);
      setUltima(r.leitura);
      if (r.leitura.resultado === 'ok') somAcerto(); else somErro();
      // Fechou a caixa: som próprio, aviso de tela cheia por 2 segundos e o
      // campo já pronto pro próximo pedido — sem precisar clicar em nada.
      if (r.completo) {
        somPedidoCompleto();
        setOverlay({ titulo: 'Pedido completo', subtitulo: `${r.conferidoTotal} de ${r.esperadoTotal} peças conferidas — pode fechar a caixa.` });
      }
    } catch (err) {
      somErro();
      setErro(err.message);
    } finally {
      setOcupado(false);
      focar();
    }
  }

  function aoEnviar(e) {
    e.preventDefault();
    const valor = codigo.trim();
    if (!valor || ocupado) return;
    setCodigo('');
    if (!sessao) abrirPedido(valor); else biparPeca(valor);
  }

  async function confirmarNoOlho(itemId) {
    const ok = await confirmar(
      'Essa peça não tem código de barras cadastrado. Confirmando no olho, o pedido fica marcado como divergente no relatório. Confirma que a peça está na caixa?',
      { titulo: 'Confirmar sem bipar', perigo: false, confirmarTexto: 'Confirmar peça' }
    );
    if (!ok) return;
    try {
      const r = await api.post(`/conferencia/${sessao.conferencia.id}/confirmar-manual`, { pedido_item_id: itemId });
      setSessao(r);
      setUltima(r.leitura);
      somAcerto();
      if (r.completo) {
        somPedidoCompleto();
        setOverlay({ titulo: 'Pedido completo', subtitulo: `${r.conferidoTotal} de ${r.esperadoTotal} peças conferidas — pode fechar a caixa.` });
      }
    } catch (err) { somErro(); setErro(err.message); } finally { focar(); }
  }

  async function desfazer() {
    // `ocupado` também aqui: sem a trava, dois toques rápidos desfaziam DUAS
    // leituras, e a segunda passava despercebida. Era a única ação da tela
    // sem retorno sonoro — quem confere está de costas para o monitor.
    if (ocupado) return;
    setOcupado(true);
    try {
      const r = await api.post(`/conferencia/${sessao.conferencia.id}/desfazer`, {});
      setSessao(r);
      setUltima(r.leitura);
      somAcerto();
    } catch (err) { somErro(); setErro(err.message); } finally { setOcupado(false); focar(); }
  }

  // O diálogo nativo do navegador era o pior lugar possível para este campo:
  // é onde a pessoa BIPA a etiqueta, e no Android o prompt do sistema rouba o
  // foco do leitor e abre o teclado por cima. Agora é um campo da própria
  // tela, que aceita a bipagem direto.
  async function vincularEtiqueta(valor) {
    if (!valor || !valor.trim()) return;
    try {
      const r = await api.post(`/conferencia/pedidos/${sessao.pedido.id}/vincular-rastreio`, { codigo: valor.trim() });
      setSessao((s) => ({ ...s, pedido: { ...s.pedido, codigos_rastreio: r.codigos_rastreio } }));
      setAbertoPorNumero(false);
      setPedindoEtiqueta(false);
      somAcerto();
    } catch (err) { somErro(); setErro(err.message); } finally { focar(); }
  }

  async function concluir(motivoInformado) {
    const incompleto = !sessao.completo;
    let observacao = null;
    if (incompleto) {
      observacao = motivoInformado;
      // Sem motivo escrito, abre o campo na tela em vez do prompt nativo.
      if (!observacao || !observacao.trim()) { setPedindoMotivo(true); return; }
    }
    if (ocupado) return;
    setOcupado(true);
    try {
      const r = await api.post(`/conferencia/${sessao.conferencia.id}/concluir`, {
        forcar: incompleto,
        observacao: observacao ? observacao.trim() : undefined,
      });
      somPedidoCompleto();
      setOverlay({
        titulo: r.houveDivergencia ? 'Fechado com divergência' : 'Conferido e fechado',
        subtitulo: `${r.conferidoTotal} de ${r.esperadoTotal} peças.`,
        alerta: r.houveDivergencia,
      });
      limparSessao();
      setPedindoMotivo(false);
      aoConcluirPedido?.();
    } catch (err) { somErro(); setErro(err.message); } finally { setOcupado(false); }
  }

  async function abandonar() {
    const ok = await confirmar('Largar esta conferência? O que já foi bipado fica registrado, e o pedido volta pra fila pra outra pessoa conferir do zero.', {
      titulo: 'Largar a conferência', confirmarTexto: 'Largar',
    });
    if (!ok) return;
    try {
      await api.post(`/conferencia/${sessao.conferencia.id}/abandonar`, {});
      limparSessao();
    } catch (err) { setErro(err.message); }
  }

  useEffect(() => {
    if (!overlay) return undefined;
    const t = setTimeout(() => setOverlay(null), 2000);
    return () => clearTimeout(t);
  }, [overlay]);

  const tomUltima = ultima ? TOM_RESULTADO[ultima.resultado] : null;

  return (
    <>
      {overlay && (
        <div className={`conferencia-overlay${overlay.alerta ? ' alerta' : ''}`}>
          <CheckCircle2 size={72} />
          <div className="conferencia-overlay-titulo">{overlay.titulo}</div>
          <div className="conferencia-overlay-sub">{overlay.subtitulo}</div>
        </div>
      )}

      <form onSubmit={aoEnviar} className="card conferencia-scanner">
        <label className="field-label" htmlFor="campo-conferencia">
          {sessao ? 'Bipe cada peça da caixa' : 'Bipe a etiqueta de envio (ou digite o número do pedido)'}
        </label>
        <div className="conferencia-scanner-linha">
          <Barcode size={26} />
          <input
            id="campo-conferencia"
            ref={inputRef}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            autoComplete="off"
            autoFocus
            disabled={ocupado}
            placeholder={sessao ? 'código de barras da peça…' : 'etiqueta, nº do pedido ou nº do pacote…'}
          />
        </div>
        {!sessao && (
          <p className="page-sub" style={{ margin: '8px 0 0' }}>
            Aceita o código de rastreio da etiqueta, o número do pedido na plataforma, o número do
            pacote do Mercado Livre ou o número interno. Se a etiqueta ainda não estiver no sistema,
            abra pelo número do pedido e use “Vincular esta etiqueta” — na próxima vez ela abre sozinha.
          </p>
        )}
      </form>

      {erro && (
        <div className="conferencia-aviso erro">
          <XCircle size={18} /> <span>{erro}</span>
        </div>
      )}

      {ultima && !erro && (
        <div className={`conferencia-aviso ${tomUltima}`}>
          {tomUltima === 'ok' ? <CheckCircle2 size={18} /> : tomUltima === 'aviso' ? <AlertTriangle size={18} /> : <XCircle size={18} />}
          <span>{ultima.mensagem}</span>
        </div>
      )}

      {sessao && (
        <>
          <div className="card conferencia-cabecalho">
            <div>
              <TituloPedido pedido={sessao.pedido} />
              <p className="page-sub" style={{ margin: '4px 0 0' }}>
                {dataBr(String(sessao.pedido.data_pedido).slice(0, 10))}
                {sessao.pedido.codigos_rastreio?.length > 0 && (
                  <> · etiqueta <span className="mono">{sessao.pedido.codigos_rastreio.join(', ')}</span></>
                )}
                {sessao.conferencia?.usuarioNome && <> · conferindo: {sessao.conferencia.usuarioNome}</>}
              </p>
            </div>
            <div className="conferencia-contador">
              <span className={sessao.completo ? 'completo' : ''}>{sessao.conferidoTotal}</span>
              <span className="de">de {sessao.esperadoTotal} peças</span>
            </div>
          </div>

          {abertoPorNumero && (
            <div className="conferencia-aviso aviso">
              <Tag size={18} />
              <span>Este pedido ainda não tem etiqueta cadastrada — foi aberto pelo número.</span>
              {!pedindoEtiqueta && (
                <button type="button" className="btn btn-ghost" onClick={() => setPedindoEtiqueta(true)}>
                  Vincular esta etiqueta
                </button>
              )}
            </div>
          )}

          {/* O campo mora AQUI, na tela, e não num window.prompt: é onde a
              pessoa bipa a etiqueta, e o diálogo nativo do navegador rouba o
              foco do leitor e, no celular, abre o teclado por cima. */}
          {abertoPorNumero && pedindoEtiqueta && (
            <form
              className="conferencia-campo-linha"
              onSubmit={(ev) => { ev.preventDefault(); vincularEtiqueta(etiquetaDigitada); }}
            >
              <input
                autoFocus
                value={etiquetaDigitada}
                onChange={(ev) => setEtiquetaDigitada(ev.target.value)}
                placeholder="bipe ou digite o código da etiqueta de envio…"
                autoComplete="off"
              />
              <button type="submit" className="btn btn-primary" disabled={!etiquetaDigitada.trim()}>Vincular</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setPedindoEtiqueta(false); setEtiquetaDigitada(''); focar(); }}>
                Cancelar
              </button>
            </form>
          )}

          <div className="card">
            <div className="card-head" style={{ marginBottom: 10 }}>O que vai nesta caixa</div>
            <div className="conferencia-itens">
              {sessao.itens.map((item) => {
                const pronto = item.falta === 0;
                return (
                  <div key={item.id} className={`conferencia-item${pronto ? ' pronto' : ''}`}>
                    <FotoProduto produtoId={item.produtoId} temFoto={item.temFoto} size={44} alt={item.referencia} urlBase="/produtos" />
                    <div className="conferencia-item-texto">
                      <div>
                        <strong className="mono">{item.referencia}</strong>
                        {(item.cor || item.tamanho) && <span> · {item.cor} {item.tamanho}</span>}
                        {item.ehKit && <span className="stamp sm tone-elevada" style={{ marginLeft: 6 }}>kit de {item.pecasPorUnidade}</span>}
                      </div>
                      {item.descricao && <div className="conferencia-item-desc">{item.descricao}</div>}
                      {item.semEan && (
                        <div className="conferencia-item-desc aviso">
                          Sem código de barras cadastrado — não dá pra bipar.
                        </div>
                      )}
                    </div>
                    <div className="conferencia-item-contagem">
                      <span className={pronto ? 'completo' : ''}>{item.conferido}/{item.esperado}</span>
                      {!pronto && item.semEan && (
                        <button type="button" className="btn btn-ghost" onClick={() => confirmarNoOlho(item.id)}>
                          Confirmar no olho
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Motivo do fechamento incompleto, também na tela em vez do
                prompt nativo — o texto vai para o relatório e merece um
                campo de verdade, com espaço para escrever. */}
            {pedindoMotivo && (
              <form
                className="conferencia-campo-linha"
                onSubmit={(ev) => { ev.preventDefault(); concluir(motivoDigitado); }}
              >
                <input
                  autoFocus
                  value={motivoDigitado}
                  onChange={(ev) => setMotivoDigitado(ev.target.value)}
                  placeholder={`Faltam ${sessao.esperadoTotal - sessao.conferidoTotal} peça(s) — escreva o motivo (fica no relatório)`}
                  autoComplete="off"
                />
                <button type="submit" className="btn btn-primary" disabled={!motivoDigitado.trim() || ocupado}>
                  Fechar assim mesmo
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => { setPedindoMotivo(false); setMotivoDigitado(''); focar(); }}>
                  Cancelar
                </button>
              </form>
            )}

            <div className="conferencia-acoes">
              <button type="button" className="btn btn-ghost" onClick={desfazer} disabled={ocupado}><Undo2 size={14} /> Desfazer última</button>
              <button type="button" className="btn btn-ghost" onClick={abandonar} disabled={ocupado}><LogOut size={14} /> Largar</button>
              {/* Antes de bipar a primeira peça o botão fica DESLIGADO. Com
                  0 de 3 conferidas, oferecer "fechar mesmo faltando" como a
                  ação mais destacada da tela é convidar ao erro que a
                  conferência existe pra evitar. */}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => concluir()}
                disabled={sessao.conferidoTotal === 0 || ocupado}
                title={sessao.conferidoTotal === 0 ? 'Bipe pelo menos uma peça antes de fechar a caixa.' : undefined}
                style={sessao.completo || sessao.conferidoTotal === 0 ? undefined : { background: 'var(--warning)', borderColor: 'var(--warning-ring)' }}
              >
                <PackageCheck size={15} /> {sessao.completo ? 'Fechar caixa' : 'Fechar mesmo faltando peça'}
              </button>
            </div>
          </div>

          {sessao.leituras?.length > 0 && (
            <div className="card">
              <div className="card-head" style={{ marginBottom: 8 }}>Leituras desta caixa</div>
              <div className="conferencia-log">
                {sessao.leituras.map((l) => (
                  <div key={l.id} className={`conferencia-log-linha ${TOM_RESULTADO[l.resultado] || ''}`}>
                    <span className="mono">{l.codigo}</span>
                    <span>{ROTULO_RESULTADO[l.resultado] || l.resultado}</span>
                    <span className="conferencia-log-hora">
                      {new Date(l.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Aba 2 — Fila do dia
// ---------------------------------------------------------------------------
function AbaFila({ recarregarChave, aoEscolherPedido }) {
  const [de, setDe] = useState(hojeIso());
  const [ate, setAte] = useState(hojeIso());
  const [dados, setDados] = useState(null);
  const [erroFila, setErroFila] = useState('');
  const [filtro, setFiltro] = useState('');

  useEffect(() => {
    setErroFila('');
    api.get(`/conferencia/fila?de=${de}&ate=${ate}`)
      .then(setDados)
      // Antes: `.catch(() => setDados(null))` — erro de rede ficava IDÊNTICO a
      // "nenhum pedido hoje", e a bancada concluía que não havia o que expedir.
      .catch((e) => { setDados(null); setErroFila(e.message); });
  }, [de, ate, recarregarChave]);

  const pedidos = useMemo(() => {
    const lista = dados?.pedidos || [];
    if (filtro === 'pendentes') return lista.filter((p) => !p.conferencia || p.conferencia.situacao !== 'concluida');
    if (filtro === 'conferidos') return lista.filter((p) => p.conferencia?.situacao === 'concluida');
    if (filtro === 'divergentes') return lista.filter((p) => p.conferencia?.houveDivergencia);
    if (filtro === 'sem_etiqueta') return lista.filter((p) => (p.codigos_rastreio || []).length === 0);
    return lista;
  }, [dados, filtro]);

  const totais = useMemo(() => {
    const lista = dados?.pedidos || [];
    return {
      total: lista.length,
      conferidos: lista.filter((p) => p.conferencia?.situacao === 'concluida').length,
      semEtiqueta: lista.filter((p) => (p.codigos_rastreio || []).length === 0).length,
    };
  }, [dados]);

  return (
    <>
      <div className="filtros-barra">
        <span className="field-label" style={{ margin: 0 }}>De</span>
        <DateInput value={de} onChange={(e) => setDe(e.target.value)} />
        <span className="field-label" style={{ margin: 0 }}>até</span>
        <DateInput value={ate} onChange={(e) => setAte(e.target.value)} />
        <Select value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Todos os pedidos" style={{ maxWidth: 230 }}>
          <option value="pendentes">Só os que faltam conferir</option>
          <option value="conferidos">Só os já conferidos</option>
          <option value="divergentes">Só os com divergência</option>
          <option value="sem_etiqueta">Só os sem etiqueta cadastrada</option>
        </Select>
      </div>

      {erroFila && <p className="login-error">{erroFila}</p>}

      <div className="stat-strip">
        <StatCard label="Pedidos no período" value={totais.total} Icone={Package} />
        <StatCard label="Já conferidos" value={totais.conferidos} variant="success" Icone={CheckCircle2} />
        <StatCard label="Sem etiqueta cadastrada" value={totais.semEtiqueta} variant="warning" Icone={Tag}>
          {totais.semEtiqueta > 0 && (
            <span className="stat-card-delta">só abrem pelo número do pedido</span>
          )}
        </StatCard>
      </div>

      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="calendario-lista-tabela">
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Data</th>
                <th>Etiqueta</th>
                <th>Peças</th>
                <th>Conferência</th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p) => (
                <tr
                  key={p.id}
                  className="linha-clicavel"
                  title="Abrir a conferência deste pedido"
                  onClick={() => aoEscolherPedido?.(
                    (p.codigos_rastreio || [])[0] || p.origem_pedido_id || String(p.numero)
                  )}
                >
                  <td><TituloPedido pedido={p} /></td>
                  <td>{dataBr(String(p.data_pedido).slice(0, 10))}</td>
                  <td className="mono">{(p.codigos_rastreio || []).join(', ') || <span style={{ color: 'var(--warning)' }}>sem etiqueta</span>}</td>
                  <td>{Number(p.quantidade_pecas) || '—'}</td>
                  <td>
                    {!p.conferencia && <span className="stamp sm tone-neutro">não conferido</span>}
                    {p.conferencia?.situacao === 'em_andamento' && <span className="stamp sm tone-atencao">conferindo agora{p.conferencia.usuarioNome ? ` (${p.conferencia.usuarioNome})` : ''}</span>}
                    {p.conferencia?.situacao === 'concluida' && (
                      p.conferencia.houveDivergencia
                        ? <span className="stamp sm tone-atencao">conferido com divergência</span>
                        : <span className="stamp sm tone-elevada">conferido</span>
                    )}
                  </td>
                </tr>
              ))}
              {pedidos.length === 0 && <tr><td colSpan="5">Nenhum pedido nesse filtro.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Aba 3 — Relatório
// ---------------------------------------------------------------------------
function AbaRelatorio({ recarregarChave }) {
  const [de, setDe] = useState(hojeIso());
  const [ate, setAte] = useState(hojeIso());
  const [r, setR] = useState(null);

  useEffect(() => {
    api.get(`/conferencia/relatorio?de=${de}&ate=${ate}`).then(setR).catch(() => setR(null));
  }, [de, ate, recarregarChave]);

  if (!r) return <p className="page-sub">Carregando…</p>;

  const pct = r.conferidos > 0 ? Math.round((r.sem_divergencia / r.conferidos) * 100) : null;

  return (
    <>
      <div className="filtros-barra">
        <span className="field-label" style={{ margin: 0 }}>De</span>
        <DateInput value={de} onChange={(e) => setDe(e.target.value)} />
        <span className="field-label" style={{ margin: 0 }}>até</span>
        <DateInput value={ate} onChange={(e) => setAte(e.target.value)} />
      </div>

      <div className="stat-strip">
        <StatCard label="Pedidos conferidos" value={r.conferidos} Icone={PackageCheck} />
        <StatCard label="Saíram de primeira" value={pct === null ? '—' : `${pct}%`} variant="success" Icone={CheckCircle2}>
          <span className="stat-card-delta">{r.sem_divergencia} sem nenhuma divergência</span>
        </StatCard>
        <StatCard label="Com divergência" value={r.com_divergencia} variant="warning" Icone={AlertTriangle} />
        <StatCard label="Peças conferidas" value={r.pecas} Icone={Package} />
      </div>
      <p className="page-sub">
        “Saíram de primeira” conta os pedidos fechados sem nenhuma peça confirmada no olho e sem
        nada faltando. Um pedido fechado com peça confirmada sem bipar conta como divergência, mesmo
        estando completo — porque a garantia não é a mesma.
      </p>

      <div className="grid-2">
        <div className="card">
          <div className="card-head" style={{ marginBottom: 8 }}>O que foi recusado</div>
          {r.recusas.length === 0 ? (
            <p className="page-sub" style={{ marginBottom: 0 }}>
              Nenhuma leitura recusada no período — tudo que foi bipado era a peça certa da caixa certa.
            </p>
          ) : (
            <>
              <table className="calendario-lista-tabela">
                <tbody>
                  {r.recusas.map((x) => (
                    <tr key={x.resultado}>
                      <td>{ROTULO_RESULTADO[x.resultado] || x.resultado}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{x.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="page-sub" style={{ marginBottom: 0 }}>
                “Não é deste pedido” é o erro que a conferência existe pra pegar: cada um desses é uma
                peça que teria ido na caixa errada.
              </p>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-head" style={{ marginBottom: 8 }}>Códigos que o sistema não conhece</div>
          {r.eansDesconhecidos.length === 0 ? (
            <p className="page-sub">Nenhum. Todo código bipado no período está cadastrado.</p>
          ) : (
            <>
              <table className="calendario-lista-tabela">
                <tbody>
                  {r.eansDesconhecidos.map((x) => (
                    <tr key={x.codigo}>
                      <td className="mono">{x.codigo}</td>
                      <td style={{ textAlign: 'right' }}>{x.vezes}×</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="page-sub" style={{ marginBottom: 0 }}>
                Esta é a fila de trabalho da tela <strong>Estoque › Importar EAN</strong>: cada código
                aqui é uma peça que a bancada teve que confirmar no olho.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ marginBottom: 8 }}>Por pessoa</div>
        <table className="calendario-lista-tabela">
          <thead><tr><th>Quem conferiu</th><th>Pedidos</th><th>Com divergência</th></tr></thead>
          <tbody>
            {r.porPessoa.map((p) => (
              <tr key={p.usuario_nome}>
                <td>{p.usuario_nome}</td>
                <td className="mono">{p.conferidos}</td>
                <td className="mono">{p.com_divergencia}</td>
              </tr>
            ))}
            {r.porPessoa.length === 0 && <tr><td colSpan="3">Nenhuma conferência no período.</td></tr>}
          </tbody>
        </table>
      </div>

      {r.divergentes.length > 0 && (
        <div className="card">
          <div className="card-head" style={{ marginBottom: 8 }}>Pedidos com divergência</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="calendario-lista-tabela">
              <thead><tr><th>Pedido</th><th>Quando</th><th>Quem</th><th>Motivo registrado</th></tr></thead>
              <tbody>
                {r.divergentes.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.origem_pedido_id || `#${d.numero}`}</td>
                    <td>{new Date(d.concluida_em).toLocaleString('pt-BR')}</td>
                    <td>{d.usuario_nome || '—'}</td>
                    <td>{d.observacao || 'peça confirmada no olho'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

export default function ConferenciaPedidosPage() {
  const [aba, setAba] = useState('bipagem');
  // Pedido escolhido na Fila para abrir direto na aba de bipagem.
  const [pedidoParaAbrir, setPedidoParaAbrir] = useState(null);
  const [recarregarChave, setRecarregarChave] = useState(0);

  return (
    <div className="page-wide">
      <h1><ScanLine size={22} style={{ verticalAlign: -3, marginRight: 8 }} />Conferência de Pedidos</h1>
      <p className="page-sub">
        Antes de fechar a caixa: bipe a etiqueta de envio pra abrir o pedido e depois bipe cada peça.
        O sistema confere contra o que foi vendido e avisa na hora se a peça não é daquele pedido.
      </p>

      <div className="view-toggle" style={{ margin: '12px 0 14px' }}>
        {ABAS.map(({ chave, rotulo, Icone }) => (
          <button key={chave} type="button" className={aba === chave ? 'active' : ''} onClick={() => setAba(chave)}>
            <Icone size={13} /> {rotulo}
          </button>
        ))}
      </div>

      {/* A bipagem fica MONTADA e apenas escondida: renderizada por
          condicional, trocar para a Fila desmontava a sessão, e quem estava no
          meio de uma caixa tinha de bipar a etiqueta de novo para voltar. */}
      <div hidden={aba !== 'bipagem'}>
        <AbaBipagem
          aoConcluirPedido={() => setRecarregarChave((n) => n + 1)}
          pedidoParaAbrir={pedidoParaAbrir}
          aoAbrirPedido={() => setPedidoParaAbrir(null)}
        />
      </div>
      {aba === 'fila' && (
        <AbaFila
          recarregarChave={recarregarChave}
          aoEscolherPedido={(codigo) => { setPedidoParaAbrir(codigo); setAba('bipagem'); }}
        />
      )}
      {aba === 'relatorio' && <AbaRelatorio recarregarChave={recarregarChave} />}
    </div>
  );
}
