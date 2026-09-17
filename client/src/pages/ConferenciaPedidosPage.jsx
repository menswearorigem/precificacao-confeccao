import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Barcode, PackageCheck, ListChecks, BarChart3, CheckCircle2, XCircle, AlertTriangle,
  Undo2, Tag, LogOut, ScanLine, Package, CornerDownLeft, FileUp, FileText, ChevronDown, ChevronUp,
} from 'lucide-react';
import { api } from '../api/client';
import { StatCard, Select, DateInput, EstadoVazio } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import FotoProduto from '../components/FotoProduto';
import { dataBr, hojeIso } from '../lib/format';
import { somAcerto, somErro, somPedidoCompleto } from '../lib/somConferencia';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';

const ABAS = [
  { chave: 'bipagem', rotulo: 'Bipagem', Icone: ScanLine },
  { chave: 'lista', rotulo: 'Lista do dia', Icone: FileUp },
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
      {pedido.soNaLista && (
        <span className="stamp sm tone-atencao" title="Ainda não chegou ao sistema — as peças são conferidas contra a Lista de Separação">
          só na lista
        </span>
      )}
      {pedido.cliente_nome && <span style={{ color: 'var(--ink-soft)' }}>· {pedido.cliente_nome}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Aba 1 — Bipagem
// ---------------------------------------------------------------------------
function AbaBipagem({ aoConcluirPedido, pedidoParaAbrir, aoAbrirPedido, resumoLista, aoIrParaLista }) {
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
  const [semLista, setSemLista] = useState(false);
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
    setSemLista(false);
    setOcupado(true);
    try {
      const r = await api.get(`/conferencia/abrir/${encodeURIComponent(valor)}`);
      let iniciada = r;
      if (!r.conferencia) {
        // Pedido que ainda não chegou ao sistema abre pela lista do dia.
        iniciada = r.pedido.soNaLista
          ? await api.post(`/conferencia/lista/${r.pedido.listaPedidoId}/iniciar`)
          : await api.post(`/conferencia/pedidos/${r.pedido.id}/iniciar`);
      }
      setSessao(iniciada);
      setAbertoPorNumero(!r.pedido.soNaLista && r.via !== 'rastreio');
      setUltima(null);
      somAcerto();
    } catch (err) {
      somErro();
      setErro(err.message);
      setSemLista(Boolean(err.data?.naoEncontrado));
    } finally {
      setOcupado(false);
      focar();
    }
  }

  // A última peça FECHA a caixa sozinha (como no site antigo): som próprio,
  // aviso de tela cheia por 2 segundos e o campo já pronto pra próxima
  // etiqueta — sem clicar em nada entre uma caixa e outra.
  function tratarFechamentoAutomatico(r) {
    if (!r.fechadaAutomaticamente) return false;
    somPedidoCompleto();
    setOverlay({
      titulo: r.houveDivergencia ? 'Fechado com divergência' : 'Pedido conferido',
      subtitulo: `${r.conferidoTotal} de ${r.esperadoTotal} peças — pode fechar a caixa e bipar a próxima etiqueta.`,
      alerta: r.houveDivergencia,
    });
    limparSessao();
    aoConcluirPedido?.();
    return true;
  }

  async function biparPeca(valor) {
    setErro('');
    setOcupado(true);
    try {
      const r = await api.post(`/conferencia/${sessao.conferencia.id}/leitura`, { codigo: valor, fecharAoCompletar: true });
      if (tratarFechamentoAutomatico(r)) return;
      setSessao(r);
      setUltima(r.leitura);
      if (r.leitura.resultado === 'ok') somAcerto(); else somErro();
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
      const r = await api.post(`/conferencia/${sessao.conferencia.id}/confirmar-manual`, { pedido_item_id: itemId, fecharAoCompletar: true });
      if (tratarFechamentoAutomatico(r)) return;
      setSessao(r);
      setUltima(r.leitura);
      somAcerto();
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
        <div className={'conferencia-scanner-linha' + (ocupado ? ' ocupado' : '')}>
          <span className="conferencia-scanner-icone" aria-hidden="true"><Barcode size={24} /></span>
          <input
            id="campo-conferencia"
            ref={inputRef}
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="go"
            autoFocus
            disabled={ocupado}
            placeholder={sessao ? 'Código de barras da peça' : 'Etiqueta, nº do pedido ou nº do pacote'}
          />
          {/* Botão para quem digita (o leitor manda o Enter sozinho). */}
          <button
            type="submit"
            className="btn btn-primary conferencia-scanner-enviar"
            disabled={ocupado || !codigo.trim()}
          >
            {ocupado ? 'Conferindo…' : sessao ? 'Conferir' : 'Abrir'}
            {!ocupado && <CornerDownLeft size={15} />}
          </button>
        </div>
        <div className="conferencia-scanner-status" aria-live="polite">
          <span className="conferencia-scanner-ponto" aria-hidden="true" />
          <span className="quando-pronto">Pronto para ler — pode bipar</span>
          <span className="quando-parado">Clique no campo para voltar a bipar</span>
          <span className="quando-ocupado">Conferindo a leitura…</span>
        </div>
        {!sessao && (
          <div className={`conferencia-lista-faixa${resumoLista?.total ? ' ok' : ''}`}>
            <FileText size={16} />
            {resumoLista?.total ? (
              <span>
                Lista do dia: <strong>{resumoLista.total}</strong> pedido(s) ·{' '}
                <strong>{resumoLista.conferidos}</strong> conferido(s) · faltam{' '}
                <strong>{resumoLista.total - resumoLista.conferidos}</strong>
              </span>
            ) : (
              <span>Nenhuma lista carregada hoje — carregue o PDF da Lista de Separação pra bipar direto pela etiqueta.</span>
            )}
            <button type="button" className="btn btn-ghost" onClick={aoIrParaLista}>
              <FileUp size={14} /> {resumoLista?.total ? 'Carregar outra' : 'Carregar lista'}
            </button>
          </div>
        )}
      </form>

      {erro && (
        <div className="conferencia-aviso erro">
          <XCircle size={18} /> <span>{erro}</span>
          {semLista && (
            <button type="button" className="btn btn-ghost" onClick={aoIrParaLista}>
              <FileUp size={14} /> Carregar lista do dia
            </button>
          )}
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
                {sessao.pedido.soNaLista ? `lista ${sessao.pedido.up_id}` : dataBr(String(sessao.pedido.data_pedido).slice(0, 10))}
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
                      {item.sku && item.ehKit && <div className="conferencia-item-desc mono">{item.sku}</div>}
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
// Aba — Lista do dia (PDF da Lista de Separação do UpSeller)
// ---------------------------------------------------------------------------
// É o que faz a bipagem funcionar sem cadastrar etiqueta: carregado o PDF de
// manhã, toda etiqueta da lista abre a caixa. Pedido que já está no sistema
// confere pelo sistema; o que ainda não chegou confere pelo próprio PDF.
const FILTROS_LISTA = [
  { chave: 'faltam', rotulo: 'Faltam conferir' },
  { chave: 'conferidos', rotulo: 'Conferidos' },
  { chave: 'so_lista', rotulo: 'Só na lista' },
  { chave: 'todos', rotulo: 'Todos' },
];

function AbaLista({ recarregarChave, aoCarregar, aoEscolherPedido }) {
  const [data, setData] = useState(hojeIso());
  const [dados, setDados] = useState(null);
  const [erroLista, setErroLista] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erroEnvio, setErroEnvio] = useState('');
  const [colar, setColar] = useState(false);
  const [texto, setTexto] = useState('');
  const [filtro, setFiltro] = useState('faltam');
  const [arrastando, setArrastando] = useState(false);
  const [explicar, setExplicar] = useState(false);
  const arquivoRef = useRef(null);

  const carregar = useCallback(() => {
    setErroLista('');
    api.get(`/conferencia/lista?data=${data}`)
      .then(setDados)
      .catch((e) => { setDados(null); setErroLista(e.message); });
  }, [data]);

  useEffect(carregar, [carregar, recarregarChave]);

  async function enviar({ arquivo, textoColado }) {
    setErroEnvio('');
    setResultado(null);
    setEnviando(true);
    try {
      let r;
      if (arquivo) {
        const form = new FormData();
        form.append('file', arquivo);
        r = await api.upload('/conferencia/lista', form);
      } else {
        r = await api.post('/conferencia/lista', { texto: textoColado });
      }
      setResultado(r);
      setTexto('');
      setColar(false);
      setData(hojeIso());
      somAcerto();
      carregar();
      aoCarregar?.();
    } catch (err) {
      somErro();
      setErroEnvio(err.message);
    } finally {
      setEnviando(false);
      if (arquivoRef.current) arquivoRef.current.value = '';
    }
  }

  const pedidos = dados?.pedidos || [];
  const totais = useMemo(() => ({
    total: pedidos.length,
    conferidos: pedidos.filter((p) => p.conferencia?.situacao === 'concluida').length,
    soLista: pedidos.filter((p) => !p.noSistema).length,
    semEtiqueta: pedidos.filter((p) => p.codigosRastreio.length === 0).length,
  }), [pedidos]);

  const visiveis = useMemo(() => {
    if (filtro === 'faltam') return pedidos.filter((p) => p.conferencia?.situacao !== 'concluida');
    if (filtro === 'conferidos') return pedidos.filter((p) => p.conferencia?.situacao === 'concluida');
    if (filtro === 'so_lista') return pedidos.filter((p) => !p.noSistema);
    return pedidos;
  }, [pedidos, filtro]);

  return (
    <>
      <div
        className={`card conferencia-upload${arrastando ? ' arrastando' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(e) => {
          e.preventDefault();
          setArrastando(false);
          const f = e.dataTransfer.files?.[0];
          if (f) enviar({ arquivo: f });
        }}
      >
        <div className="conferencia-upload-icone"><FileUp size={26} /></div>
        <div className="conferencia-upload-texto">
          <strong>Lista de Separação do UpSeller (PDF)</strong>
          <span>Arraste o arquivo aqui ou escolha. Pode carregar mais de uma vez no dia — nada duplica.</span>
        </div>
        <div className="conferencia-upload-acoes">
          <input
            ref={arquivoRef}
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) enviar({ arquivo: f }); }}
          />
          <button type="button" className="btn btn-primary" disabled={enviando} onClick={() => arquivoRef.current?.click()}>
            <FileUp size={15} /> {enviando ? 'Lendo a lista…' : 'Escolher PDF'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setColar((v) => !v)}>
            {colar ? 'Fechar' : 'Colar texto'}
          </button>
        </div>
        {colar && (
          <div className="conferencia-upload-colar">
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={6}
              placeholder="Cole aqui o texto copiado do PDF da Lista de Separação…"
            />
            <button type="button" className="btn btn-primary" disabled={!texto.trim() || enviando} onClick={() => enviar({ textoColado: texto })}>
              Carregar texto
            </button>
          </div>
        )}
      </div>

      {erroEnvio && (
        <div className="conferencia-aviso erro"><XCircle size={18} /> <span>{erroEnvio}</span></div>
      )}

      {resultado && (
        <div className={`conferencia-aviso ${resultado.conflitos.length || resultado.semItens ? 'aviso' : 'ok'}`}>
          <CheckCircle2 size={18} />
          <span>
            <strong>{resultado.total} pedido(s) carregado(s)</strong>
            {' — '}{resultado.noSistema} já no sistema, {resultado.soNaLista} só na lista.
            {resultado.semEtiqueta > 0 && <> {resultado.semEtiqueta} sem etiqueta no PDF (abrem pelo número).</>}
            {resultado.semItens > 0 && <> {resultado.semItens} sem nenhum item lido — confira no UpSeller.</>}
            {resultado.itensNaoReconhecidos > 0 && <> {resultado.itensNaoReconhecidos} item(ns) com referência fora do cadastro.</>}
            {resultado.conflitos.length > 0 && (
              <> Etiqueta que já era de outro pedido (não foi trocada):{' '}
                {resultado.conflitos.map((c) => `${c.codigo} → ${c.pedido}`).join(', ')}.
              </>
            )}
            {' '}Já pode bipar.
          </span>
        </div>
      )}

      <div className="filtros-barra">
        <span className="field-label" style={{ margin: 0 }}>Lista carregada em</span>
        <DateInput value={data} onChange={(e) => setData(e.target.value)} />
        <div className="view-toggle">
          {FILTROS_LISTA.map((f) => (
            <button key={f.chave} type="button" className={filtro === f.chave ? 'active' : ''} onClick={() => setFiltro(f.chave)}>
              {f.rotulo}
            </button>
          ))}
        </div>
      </div>

      {erroLista && <p className="login-error">{erroLista}</p>}

      {totais.total > 0 && (
        <div className="stat-strip">
          <StatCard label="Na lista" value={totais.total} Icone={FileText} />
          <StatCard label="Conferidos" value={totais.conferidos} variant="success" Icone={CheckCircle2} />
          <StatCard label="Faltam" value={totais.total - totais.conferidos} variant="warning" Icone={Package} />
          <StatCard label="Só na lista" value={totais.soLista} Icone={AlertTriangle}>
            <span className="stat-card-delta">ainda não chegaram pela sincronização</span>
          </StatCard>
        </div>
      )}

      {dados && totais.total === 0 && (
        <EstadoVazio
          Icone={FileUp}
          titulo="Nenhuma lista carregada nesse dia"
          descricao="Baixe a Lista de Separação no UpSeller e carregue acima. Depois disso, é só bipar a etiqueta de cada caixa."
        />
      )}

      {totais.total > 0 && (
        <div className="card">
          <div style={{ overflowX: 'auto' }}>
            <table className="calendario-lista-tabela">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Etiqueta</th>
                  <th>Peças</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map((p) => (
                  <tr
                    key={p.id}
                    className="linha-clicavel"
                    title="Abrir a conferência deste pedido"
                    onClick={() => aoEscolherPedido?.(p.codigosRastreio[0] || p.pedidoPlataforma || p.upId)}
                  >
                    <td>
                      {p.pedido
                        ? <TituloPedido pedido={p.pedido} />
                        : <TituloPedido pedido={{ origem_pedido_id: p.pedidoPlataforma || p.upId, soNaLista: true }} />}
                    </td>
                    <td className="mono">{p.codigosRastreio.join(', ') || <span style={{ color: 'var(--warning)' }}>sem etiqueta</span>}</td>
                    <td title={p.itens.map((i) => `${i.quantidade}× ${i.sku}`).join('\n')}>
                      {p.itens.length === 0 ? <span style={{ color: 'var(--warning)' }}>nenhum item lido</span> : p.pecas}
                    </td>
                    <td>
                      {!p.conferencia && <span className="stamp sm tone-neutro">falta conferir</span>}
                      {p.conferencia?.situacao === 'em_andamento' && <span className="stamp sm tone-atencao">conferindo{p.conferencia.usuarioNome ? ` (${p.conferencia.usuarioNome})` : ''}</span>}
                      {p.conferencia?.situacao === 'concluida' && (
                        p.conferencia.houveDivergencia
                          ? <span className="stamp sm tone-atencao">conferido com divergência</span>
                          : <span className="stamp sm tone-elevada">conferido</span>
                      )}
                    </td>
                  </tr>
                ))}
                {visiveis.length === 0 && <tr><td colSpan="4">Nenhum pedido nesse filtro.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <button type="button" className="btn btn-ghost" onClick={() => setExplicar((v) => !v)}>
        {explicar ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Como a lista funciona
      </button>
      {explicar && (
        <div className="card page-sub" style={{ lineHeight: 1.6 }}>
          <p style={{ marginTop: 0 }}>
            Cada pedido do PDF traz o número, a etiqueta de envio e os SKUs. Ao carregar, o sistema procura o
            pedido pelo número: <strong>achou</strong>, a etiqueta é gravada nele e a conferência usa o pedido do
            sistema (com kit e foto); <strong>não achou</strong> (loja não integrada ou venda de agora há pouco),
            a conferência usa os SKUs do próprio PDF — e se o pedido chegar depois, a mesma etiqueta passa a abrir
            o pedido do sistema.
          </p>
          <p>
            A peça é reconhecida pelo código de barras do cadastro e pelo mapeamento de EAN do Wik. Valem as
            equivalências fixas: Marrom = Chocolate, Azul Marinho = Marinho, Verde Militar = Militar,
            MM6387 = MB6387 (e, nela, P/M/1 e G/GG/2).
          </p>
          <p style={{ marginBottom: 0 }}>
            Carregar a lista não mexe em venda, estoque nem valor. Etiqueta que já pertence a outro pedido nunca é
            trocada — aparece no aviso, porque quase sempre é caixa trocada.
          </p>
        </div>
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
        {/* `pecas` é o que foi BIPADO de verdade; `pecas_esperadas` é o que a
            caixa prometia. A diferença entre os dois é exatamente a peça que
            saiu sem conferência — mostrar só o conferido escondia isso. */}
        <StatCard label="Peças conferidas" value={r.pecas} Icone={Package}>
          {r.pecas_esperadas != null && (
            <span className="stat-card-delta">
              de {r.pecas_esperadas} esperada(s) nas caixas do período
            </span>
          )}
        </StatCard>
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
  const [resumoLista, setResumoLista] = useState(null);

  // Resumo da lista de hoje para a faixa da bipagem.
  useEffect(() => {
    api.get(`/conferencia/lista?data=${hojeIso()}`)
      .then((r) => setResumoLista({
        total: r.pedidos.length,
        conferidos: r.pedidos.filter((p) => p.conferencia?.situacao === 'concluida').length,
      }))
      .catch(() => setResumoLista(null));
  }, [recarregarChave]);

  const recarregar = () => setRecarregarChave((n) => n + 1);

  return (
    <div className="page-wide">
      <h1><ScanLine size={22} style={{ verticalAlign: -3, marginRight: 8 }} />Conferência de Pedidos</h1>
      <p className="page-sub">
        Carregue a Lista de Separação do dia, bipe a etiqueta de envio e depois cada peça. A caixa fecha
        sozinha quando a última peça certa é bipada — e o sistema avisa na hora se a peça não é daquele pedido.
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
          aoConcluirPedido={recarregar}
          pedidoParaAbrir={pedidoParaAbrir}
          aoAbrirPedido={() => setPedidoParaAbrir(null)}
          resumoLista={resumoLista}
          aoIrParaLista={() => setAba('lista')}
        />
      </div>
      {aba === 'lista' && (
        <AbaLista
          recarregarChave={recarregarChave}
          aoCarregar={recarregar}
          aoEscolherPedido={(codigo) => { setPedidoParaAbrir(codigo); setAba('bipagem'); }}
        />
      )}
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
