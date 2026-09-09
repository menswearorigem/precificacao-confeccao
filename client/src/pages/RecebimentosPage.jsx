import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ChevronRight, Plus, Barcode, PackageCheck, AlertTriangle, CheckCircle2,
  XCircle, FileText, Info, X, Trash2, Truck,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd, qtdFracionaria } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio,
  IndicadorDestaque, CampoBusca, ChipsFiltros, Checkbox, Field, Select, NumInput, DateInput,
} from '../components/ui';
import { useTabela } from '../lib/useTabela';

// Recebimento — o que efetivamente chegou na doca.
//
// É a tela copiada da versão antiga do Wik (vídeo de 09/09/2026): escolhe-se o
// pedido, o sistema já traz as linhas que faltam chegar, e quem está na doca
// corrige a quantidade que realmente veio. O rodapé é o ponto central da tela:
// Qtd. Comprada × Qtd. Recebida e Valor Compra × Valor Recebimento, lado a lado.
//
// Três regras do backend que a tela precisa contar em português:
//   · recebimento NÃO move estoque e NÃO lança custo — quem faz isso é a nota
//     fiscal de entrada. Aqui é conferência física;
//   · fechar com divergência EXIGE motivo escrito (o servidor recusa e devolve
//     `divergencia: true`);
//   · mercadoria que chegou sem ter sido pedida é caso real e aparece na
//     lista — não é recusada.

const SITUACAO_LABEL = { aberto: 'Em conferência', conferido: 'Conferido', cancelado: 'Cancelado' };
const SITUACAO_TONE = { aberto: 'tone-atencao', conferido: 'tone-saudavel', cancelado: 'tone-prejuizo' };

const COLUNAS_ORDENAVEIS = {
  numero: (r) => Number(r.numero) || 0,
  data: (r) => new Date(r.data_recebimento).getTime(),
  fornecedor: (r) => r.fornecedor_nome || '',
  pedido: (r) => Number(r.pedido_numero) || 0,
  itens: (r) => Number(r.qtd_itens) || 0,
  situacao: (r) => r.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (r) => r.numero },
  { rotulo: 'Data', valor: (r) => dataBr(String(r.data_recebimento).slice(0, 10)) },
  { rotulo: 'Fornecedor', valor: (r) => r.fornecedor_nome || '' },
  { rotulo: 'Pedido de compra', valor: (r) => (r.pedido_numero ? `#${r.pedido_numero}` : '') },
  { rotulo: 'Itens', valor: (r) => formatQtd(r.qtd_itens) },
  { rotulo: 'Divergência', valor: (r) => (r.divergencia ? (r.divergencia_motivo || 'sim') : 'não') },
  { rotulo: 'Nota fiscal', valor: (r) => (r.nota_fiscal_entrada_id ? 'vinculada' : 'sem nota') },
  { rotulo: 'Situação', valor: (r) => SITUACAO_LABEL[r.situacao] || r.situacao },
];

function mensagemErro(err) {
  return err?.data?.error || err?.data?.erro || err?.message || 'Não consegui completar a ação.';
}

function normalizar(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// A linha do recebimento como a tela precisa dela: o que o pedido dizia
// (quantidade_pedida, valor_unitario_pedido) fica ao lado do que chegou.
function paraLinha(it) {
  return {
    id: it.id,
    pedido_compra_item_id: it.pedido_compra_item_id,
    insumo_id: it.insumo_id,
    insumo_nome: it.insumo_nome,
    descricao: it.descricao,
    unidade: it.unidade || '',
    quantidade_recebida: it.quantidade_recebida === null || it.quantidade_recebida === undefined
      ? 0 : Number(it.quantidade_recebida),
    valor_unitario: it.valor_unitario === null || it.valor_unitario === undefined ? '' : Number(it.valor_unitario),
    lote: it.lote || '',
    validade: it.validade ? String(it.validade).slice(0, 10) : '',
    codigo_lido: it.codigo_lido || '',
    observacao: it.observacao || '',
    quantidade_pedida: it.quantidade_pedida === null || it.quantidade_pedida === undefined
      ? null : Number(it.quantidade_pedida),
    valor_unitario_pedido: it.valor_unitario_pedido === null || it.valor_unitario_pedido === undefined
      ? null : Number(it.valor_unitario_pedido),
  };
}

// ---------------------------------------------------------------------------
// Abrir um recebimento a partir de um pedido aprovado
// ---------------------------------------------------------------------------
function ModalNovoRecebimento({ onFechar, onCriado }) {
  const [pedidos, setPedidos] = useState([]);
  const [pedidoId, setPedidoId] = useState('');
  const [data, setData] = useState(new Date().toISOString().slice(0, 10));
  const [localizacao, setLocalizacao] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    api.get('/pedidos-compra?situacao=aprovado,parcial')
      .then((r) => setPedidos(Array.isArray(r) ? r : []))
      .catch(() => setPedidos([]));
  }, []);

  async function abrir(e) {
    e.preventDefault();
    if (!pedidoId) { setErro('Escolha o pedido que está chegando.'); return; }
    setSalvando(true);
    setErro('');
    try {
      const data_ = await api.post('/recebimentos', {
        pedido_compra_id: Number(pedidoId),
        data_recebimento: data || null,
        localizacao: localizacao.trim() || null,
      });
      onCriado(data_);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <form className="card viagem-modal" onSubmit={abrir}>
        <div className="card-head-linha">
          <div className="card-head">Conferir uma entrega</div>
          <button type="button" className="icon-btn" onClick={onFechar}><X size={16} /></button>
        </div>
        <p className="page-sub">
          Escolha o pedido que chegou. O sistema já traz as linhas que ainda faltavam, com a
          quantidade pendente preenchida — quem confere só corrige o que veio a menos.
        </p>

        <div className="form-grid">
          <Field label="Pedido de compra" hint="Só aparecem pedidos aprovados: pedido não aprovado não recebe mercadoria.">
            <Select value={pedidoId} onChange={(e) => setPedidoId(e.target.value)}>
              <option value="">Escolha o pedido</option>
              {pedidos.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {`#${p.numero} · ${p.fornecedor_nome || 'sem fornecedor'} · ${brl(p.total_liquido)}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Data do recebimento">
            <DateInput value={data} onChange={(e) => setData(e.target.value)} />
          </Field>
          <Field label="Onde a mercadoria foi colocada" hint="O endereço no galpão, do mesmo jeito que aparece em Onde Está a Peça.">
            <input value={localizacao} onChange={(e) => setLocalizacao(e.target.value)} placeholder="Ex.: Corredor B · prateleira 3" />
          </Field>
        </div>

        {pedidos.length === 0 && (
          <div className="aviso-compacto tone-atencao">
            Nenhum pedido aprovado esperando entrega. Aprove o pedido em Compras › Pedidos de Compra
            antes de conferir a chegada.
          </div>
        )}
        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando || pedidos.length === 0}>
            {salvando ? 'Abrindo…' : 'Abrir conferência'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ModalCancelar({ recebimento, onFechar, onCancelado }) {
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function cancelar(e) {
    e.preventDefault();
    if (!motivo.trim()) { setErro('Escreva o motivo do cancelamento.'); return; }
    setSalvando(true);
    setErro('');
    try {
      const data = await api.post(`/recebimentos/${recebimento.id}/cancelar`, { motivo: motivo.trim() });
      onCancelado(data);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <form className="card viagem-modal" onSubmit={cancelar}>
        <div className="card-head-linha">
          <div className="card-head">Cancelar o recebimento #{recebimento.numero}</div>
          <button type="button" className="icon-btn" onClick={onFechar}><X size={16} /></button>
        </div>
        <p className="page-sub">
          Cancelar desfaz a entrega: a quantidade deixa de contar no pedido na hora, e o pedido
          volta a aparecer como pendente. O motivo fica gravado na observação.
        </p>
        <Field label="Motivo do cancelamento (obrigatório)">
          <textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: a carga era de outro cliente; devolvida ao motorista." />
        </Field>
        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Voltar</button>
          <button type="submit" className="btn btn-danger" disabled={salvando}>
            {salvando ? 'Cancelando…' : 'Cancelar recebimento'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A conferência — a tela copiada do Wik
// ---------------------------------------------------------------------------
function Conferencia({ detalhe, onVoltar, onAtualizar }) {
  const { recebimento } = detalhe;
  const aberto = recebimento.situacao === 'aberto';

  const [linhas, setLinhas] = useState(() => detalhe.itens.map(paraLinha));
  const [codigo, setCodigo] = useState('');
  const [leitura, setLeitura] = useState(null); // { tom, mensagem }
  const [erro, setErro] = useState('');
  const [divergenciaRecusada, setDivergenciaRecusada] = useState('');
  const [motivo, setMotivo] = useState(recebimento.divergencia_motivo || '');
  const [salvando, setSalvando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setLinhas(detalhe.itens.map(paraLinha)); }, [detalhe]);

  // O leitor de código de barras "digita" e dá Enter muito rápido: qualquer
  // render que perca o foco corta a leitura no meio. O setTimeout(0) devolve o
  // foco depois que o React terminou de pintar.
  const focar = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => { if (aberto) focar(); }, [aberto, focar]);

  const totais = useMemo(() => linhas.reduce((acc, l) => {
    const pedida = l.quantidade_pedida === null ? 0 : Number(l.quantidade_pedida);
    const unitPedido = l.valor_unitario_pedido === null ? 0 : Number(l.valor_unitario_pedido);
    const recebida = Number(l.quantidade_recebida) || 0;
    const unitRecebido = l.valor_unitario === '' || l.valor_unitario === null ? unitPedido : Number(l.valor_unitario);
    return {
      qtdComprada: acc.qtdComprada + pedida,
      qtdRecebida: acc.qtdRecebida + recebida,
      valorCompra: acc.valorCompra + pedida * unitPedido,
      valorRecebimento: acc.valorRecebimento + recebida * unitRecebido,
      semPedido: acc.semPedido + (l.pedido_compra_item_id ? 0 : 1),
      divergentes: acc.divergentes + (!l.pedido_compra_item_id || recebida !== pedida ? 1 : 0),
    };
  }, { qtdComprada: 0, qtdRecebida: 0, valorCompra: 0, valorRecebimento: 0, semPedido: 0, divergentes: 0 }), [linhas]);

  const temDivergencia = totais.divergentes > 0;

  async function gravarLinhas(novas) {
    setErro('');
    setSalvando(true);
    try {
      const data = await api.put(`/recebimentos/${recebimento.id}/itens`, {
        itens: novas.map((l) => ({
          pedido_compra_item_id: l.pedido_compra_item_id,
          insumo_id: l.insumo_id,
          descricao: l.descricao,
          unidade: l.unidade || null,
          quantidade_recebida: Number(l.quantidade_recebida) || 0,
          valor_unitario: l.valor_unitario === '' ? null : l.valor_unitario,
          lote: l.lote || null,
          validade: l.validade || null,
          codigo_lido: l.codigo_lido || null,
          observacao: l.observacao || null,
        })),
      });
      onAtualizar(data);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  function alterarLinha(idx, patch) {
    setLinhas((lista) => lista.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  // Bipar soma 1 na linha correspondente. O código lido fica gravado na linha
  // mesmo quando não casa com nada — é o log que explica, no dia seguinte, por
  // que a contagem não fechou.
  function bipar(e) {
    e.preventDefault();
    const valor = codigo.trim();
    if (!valor) return;
    setCodigo('');
    const alvo = normalizar(valor);
    let idx = linhas.findIndex((l) => normalizar(l.codigo_lido) === alvo);
    if (idx < 0) idx = linhas.findIndex((l) => normalizar(l.descricao).includes(alvo) || normalizar(l.insumo_nome).includes(alvo));
    if (idx < 0) {
      setLeitura({ tom: 'erro', mensagem: `“${valor}” não corresponde a nenhuma linha desta entrega. Confira se a caixa é deste pedido.` });
      focar();
      return;
    }
    const novas = linhas.map((l, i) => (i === idx
      ? { ...l, quantidade_recebida: (Number(l.quantidade_recebida) || 0) + 1, codigo_lido: valor }
      : l));
    setLinhas(novas);
    setLeitura({ tom: 'ok', mensagem: `+1 em ${novas[idx].descricao} — agora ${qtdFracionaria(novas[idx].quantidade_recebida)}.` });
    gravarLinhas(novas);
    focar();
  }

  async function fechar(comMotivo) {
    setErro('');
    setDivergenciaRecusada('');
    setSalvando(true);
    try {
      await gravarLinhas(linhas);
      const data = await api.post(`/recebimentos/${recebimento.id}/conferir`, {
        divergencia_motivo: comMotivo ? comMotivo.trim() : undefined,
      });
      onAtualizar(data);
    } catch (err) {
      // O servidor recusa fechar torto e devolve `divergencia: true`. Isso não
      // é um erro de sistema: é a tela pedindo a explicação que falta.
      if (err?.data?.divergencia) setDivergenciaRecusada(mensagemErro(err));
      else setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="page-wide">
      <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={onVoltar}>
        <ArrowLeft size={14} /> Voltar para os recebimentos
      </button>

      <div className="pagina-topo">
        <div>
          <h2>
            Recebimento #{recebimento.numero}{' '}
            <span className={'stamp sm ' + (SITUACAO_TONE[recebimento.situacao] || 'tone-neutro')}>
              {SITUACAO_LABEL[recebimento.situacao] || recebimento.situacao}
            </span>
          </h2>
          <p className="page-sub">
            {recebimento.fornecedor_nome || 'Sem fornecedor'}
            {recebimento.pedido_numero ? <> · pedido #{recebimento.pedido_numero}</> : <> · <strong>sem pedido de compra</strong></>}
            {' '}· chegou em {dataBr(String(recebimento.data_recebimento).slice(0, 10))}
            {recebimento.localizacao && <> · guardado em {recebimento.localizacao}</>}
          </p>
        </div>
        <div className="pagina-topo-acoes">
          {aberto && (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => gravarLinhas(linhas)} disabled={salvando}>
                {salvando ? 'Salvando…' : 'Salvar contagem'}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => fechar(temDivergencia ? motivo : '')} disabled={salvando}>
                <PackageCheck size={14} /> Fechar conferência
              </button>
            </>
          )}
          {recebimento.situacao !== 'cancelado' && (
            <button type="button" className="btn btn-danger" onClick={() => setCancelando(true)}>
              <XCircle size={14} /> Cancelar entrega
            </button>
          )}
        </div>
      </div>

      {!recebimento.nota_fiscal_entrada_id && (
        <div className="aviso-compacto tone-atencao">
          <FileText size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          Sem nota fiscal vinculada. Isso é normal — a mercadoria costuma chegar antes da nota —, mas
          lembre: <strong>este documento não move estoque nem lança custo</strong>. Quem faz isso é a
          nota fiscal de entrada, em Compras › Insumos e Notas.
        </div>
      )}
      {recebimento.situacao === 'conferido' && (
        <div className={'aviso-compacto ' + (recebimento.divergencia ? 'tone-atencao' : 'tone-saudavel')}>
          {recebimento.divergencia
            ? <>Fechado com divergência por {recebimento.conferido_por_nome || 'alguém'}: {recebimento.divergencia_motivo}</>
            : <>Conferido por {recebimento.conferido_por_nome || 'alguém'} — o que chegou bateu com o pedido.</>}
        </div>
      )}
      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      {aberto && (
        <form onSubmit={bipar} className="card conferencia-scanner">
          <label className="field-label" htmlFor="campo-recebimento">Leitura por código de barras</label>
          <div className="conferencia-scanner-linha">
            <Barcode size={26} />
            <input
              id="campo-recebimento"
              ref={inputRef}
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              autoComplete="off"
              placeholder="bipe o volume — soma 1 na linha correspondente"
            />
          </div>
          <p className="page-sub" style={{ margin: '8px 0 0' }}>
            Cada leitura soma 1 na linha do item. Quando o código não casa com nenhuma linha, a tela
            avisa em vez de somar em qualquer lugar — e quem confere corrige a quantidade na mão.
          </p>
        </form>
      )}

      {leitura && (
        <div className={`conferencia-aviso ${leitura.tom}`}>
          {leitura.tom === 'ok' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <span>{leitura.mensagem}</span>
        </div>
      )}

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">O que chegou</div>
          <span className="page-sub" style={{ margin: 0 }}>{formatQtd(linhas.length)} linha(s)</span>
        </div>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Unid.</th>
                <th>Qtd. Comprada</th>
                <th>Qtd. Recebida</th>
                <th>Diferença</th>
                <th>Vlr. Unit. do recebimento</th>
                <th>Valor recebido</th>
                <th>Lote</th>
                {aberto && <th />}
              </tr>
            </thead>
            <tbody>
              {linhas.map((l, idx) => {
                const pedida = l.quantidade_pedida;
                const recebida = Number(l.quantidade_recebida) || 0;
                const unitPedido = l.valor_unitario_pedido === null ? 0 : Number(l.valor_unitario_pedido);
                const unitUsado = l.valor_unitario === '' || l.valor_unitario === null ? unitPedido : Number(l.valor_unitario);
                const diferenca = pedida === null ? null : recebida - pedida;
                return (
                  <tr key={l.id ?? idx}>
                    <td>
                      <span className="cel-dupla">
                        <strong>{l.descricao}</strong>
                        {l.insumo_nome && <small>{l.insumo_nome}</small>}
                        {!l.pedido_compra_item_id && <small>não estava no pedido</small>}
                      </span>
                    </td>
                    <td>{l.unidade || '—'}</td>
                    <td className="mono">{pedida === null ? '—' : qtdFracionaria(pedida)}</td>
                    <td>
                      {aberto ? (
                        <NumInput
                          value={l.quantidade_recebida}
                          onChange={(v) => alterarLinha(idx, { quantidade_recebida: v === '' ? 0 : v })}
                          onBlur={() => gravarLinhas(linhas)}
                        />
                      ) : <span className="mono">{qtdFracionaria(recebida)}</span>}
                    </td>
                    <td>
                      {diferenca === null
                        ? <span style={{ color: 'var(--ink-faint)' }}>sem pedido</span>
                        : diferenca === 0
                          ? <span className="mono">—</span>
                          : <span className={'stamp sm ' + (diferenca < 0 ? 'tone-atencao' : 'tone-prejuizo')}>
                            {diferenca > 0 ? '+' : ''}{qtdFracionaria(diferenca)}
                          </span>}
                    </td>
                    <td>
                      {aberto ? (
                        <NumInput
                          value={l.valor_unitario}
                          onChange={(v) => alterarLinha(idx, { valor_unitario: v })}
                          onBlur={() => gravarLinhas(linhas)}
                          suffix="R$"
                          placeholder={unitPedido ? brl(unitPedido) : 'do pedido'}
                        />
                      ) : <span className="mono">{l.valor_unitario === '' ? brl(unitPedido) : brl(l.valor_unitario)}</span>}
                    </td>
                    <td className="mono">{recebida === 0 ? '—' : brl(recebida * unitUsado)}</td>
                    <td>
                      {aberto ? (
                        <input value={l.lote} onChange={(e) => alterarLinha(idx, { lote: e.target.value })} onBlur={() => gravarLinhas(linhas)} />
                      ) : (l.lote || '—')}
                    </td>
                    {aberto && (
                      <td>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Tirar esta linha da entrega"
                          onClick={() => { const novas = linhas.filter((_, i) => i !== idx); setLinhas(novas); gravarLinhas(novas); }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
        {linhas.length === 0 && (
          <EstadoVazio
            Icone={PackageCheck}
            titulo="Esta entrega está sem linha nenhuma"
            descricao="O pedido escolhido já tinha tudo recebido, ou as linhas foram removidas. Recebimento sem item não pode ser fechado."
          />
        )}
      </div>

      {/* ------------------------------------------------------------------
          O RODAPÉ — o ponto central da tela, igual ao Wik antigo:
          Qtd. Comprada × Qtd. Recebida e Valor Compra × Valor Recebimento.
          ------------------------------------------------------------------ */}
      <div className="card">
        <div className="card-head">Confronto da entrega</div>
        <div className="indicadores-faixa compacta">
          <IndicadorDestaque
            rotulo="Qtd. Comprada"
            valor={totais.qtdComprada === 0 ? '—' : qtdFracionaria(totais.qtdComprada)}
            explicacao="Soma do que o pedido de compra mandou vir nas linhas desta entrega."
          />
          <IndicadorDestaque
            destaque
            rotulo="Qtd. Recebida"
            valor={qtdFracionaria(totais.qtdRecebida)}
            tom={temDivergencia ? 'atencao' : undefined}
            explicacao={temDivergencia
              ? `Soma do que a doca contou. ${formatQtd(totais.divergentes)} linha(s) não bateram com o pedido.`
              : 'Soma do que a doca contou. Bateu com o pedido, linha por linha.'}
          />
          <IndicadorDestaque
            rotulo="Valor Compra"
            valor={totais.valorCompra === 0 ? '—' : brl(totais.valorCompra)}
            explicacao="Quantidade pedida × preço do pedido, nas linhas desta entrega."
          />
          <IndicadorDestaque
            destaque
            rotulo="Valor Recebimento"
            valor={brl(totais.valorRecebimento)}
            tom={totais.valorRecebimento > totais.valorCompra ? 'atencao' : undefined}
            explicacao="Quantidade recebida × preço que veio na entrega (ou o do pedido, quando não veio preço diferente)."
          />
        </div>
        <div className="nota-precisao">
          <Info size={14} />
          <span>
            As duas colunas ficam lado a lado de propósito: o pedido <strong>não</strong> é reescrito
            para o que chegou. A diferença é o que permite cobrar o fornecedor.
            {totais.semPedido > 0 && <> {formatQtd(totais.semPedido)} linha(s) chegaram sem estar no pedido — elas contam como divergência.</>}
          </span>
        </div>
      </div>

      {aberto && (temDivergencia || divergenciaRecusada) && (
        <div className="card">
          <div className="card-head">Por que o que chegou não bate com o pedido</div>
          {divergenciaRecusada && (
            <div className="aviso-compacto tone-prejuizo">
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
              {divergenciaRecusada}
            </div>
          )}
          <p className="page-sub">
            Fechar torto sem explicar é o que faz a divergência sumir e reaparecer como falta de
            material três semanas depois. O motivo fica gravado no recebimento.
          </p>
          <Field label="Motivo da divergência (obrigatório para fechar)">
            <textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: vieram 180 m dos 200 pedidos; o resto o fornecedor entrega semana que vem." />
          </Field>
          <button type="button" className="btn btn-primary" onClick={() => fechar(motivo)} disabled={salvando || !motivo.trim()}>
            <PackageCheck size={14} /> Fechar com divergência
          </button>
        </div>
      )}

      {cancelando && (
        <ModalCancelar
          recebimento={recebimento}
          onFechar={() => setCancelando(false)}
          onCancelado={(data) => { onAtualizar(data); setCancelando(false); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A lista
// ---------------------------------------------------------------------------
export default function RecebimentosPage() {
  const [situacoes, setSituacoes] = useState([]);
  const [soDivergentes, setSoDivergentes] = useState(false);
  const [semNota, setSemNota] = useState(false);
  const [termoDigitado, setTermoDigitado] = useState('');
  const [termoAplicado, setTermoAplicado] = useState('');
  const [recebimentos, setRecebimentos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [recarregar, setRecarregar] = useState(0);
  const [detalhe, setDetalhe] = useState(null);
  const [criando, setCriando] = useState(false);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (situacoes.length) p.set('situacao', situacoes.join(','));
    if (soDivergentes) p.set('divergentes', 'true');
    if (semNota) p.set('sem_nota', 'true');
    return p;
  }, [situacoes, soDivergentes, semNota]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`/recebimentos?${params.toString()}`)
      .then((r) => setRecebimentos(Array.isArray(r) ? r : []))
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params, recarregar]);

  // A rota de recebimentos não filtra por texto no servidor — a busca é feita
  // aqui, sobre a lista que já veio, e a tela diz isso no próprio campo.
  const filtrados = useMemo(() => {
    const alvo = normalizar(termoAplicado);
    if (!alvo) return recebimentos;
    return recebimentos.filter((r) => normalizar(r.fornecedor_nome).includes(alvo)
      || String(r.numero).includes(alvo)
      || String(r.pedido_numero || '').includes(alvo));
  }, [recebimentos, termoAplicado]);

  const tabela = useTabela(filtrados, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  const resumo = useMemo(() => {
    const vivos = recebimentos.filter((r) => r.situacao !== 'cancelado');
    return {
      emConferencia: vivos.filter((r) => r.situacao === 'aberto').length,
      conferidos: vivos.filter((r) => r.situacao === 'conferido').length,
      divergentes: vivos.filter((r) => r.divergencia).length,
      semNota: vivos.filter((r) => !r.nota_fiscal_entrada_id).length,
    };
  }, [recebimentos]);

  const chips = [];
  for (const s of situacoes) {
    chips.push({
      chave: `sit-${s}`,
      rotulo: 'Situação',
      valor: SITUACAO_LABEL[s] || s,
      onRemover: () => setSituacoes((a) => a.filter((x) => x !== s)),
    });
  }
  if (soDivergentes) chips.push({ chave: 'div', rotulo: 'Conferência', valor: 'Só divergentes', onRemover: () => setSoDivergentes(false) });
  if (semNota) chips.push({ chave: 'nota', rotulo: 'Fiscal', valor: 'Sem nota fiscal', onRemover: () => setSemNota(false) });
  if (termoAplicado.trim()) {
    chips.push({
      chave: 'busca',
      rotulo: 'Busca',
      valor: termoAplicado.trim(),
      onRemover: () => { setTermoAplicado(''); setTermoDigitado(''); },
    });
  }

  function limparTudo() {
    setSituacoes([]);
    setSoDivergentes(false);
    setSemNota(false);
    setTermoAplicado('');
    setTermoDigitado('');
  }

  function aplicarBusca(valor) {
    setTermoAplicado(valor === undefined ? termoDigitado : valor);
  }

  async function abrirDetalhe(id) {
    setErro('');
    try {
      setDetalhe(await api.get(`/recebimentos/${id}`));
    } catch (err) { setErro(mensagemErro(err)); }
  }

  if (detalhe) {
    return (
      <Conferencia
        detalhe={detalhe}
        onVoltar={() => { setDetalhe(null); setRecarregar((n) => n + 1); }}
        onAtualizar={setDetalhe}
      />
    );
  }

  const semNenhum = !loading && filtrados.length === 0;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Recebimentos</h2>
          <p className="page-sub">
            A conferência física do que chegou na doca. Não move estoque e não lança custo — quem faz
            isso é a nota fiscal de entrada. Aqui o que importa é o confronto entre o que foi comprado
            e o que realmente veio.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <button type="button" className="btn btn-primary" onClick={() => setCriando(true)}>
            <Plus size={14} /> Conferir uma entrega
          </button>
        </div>
      </div>

      <div className="filtros-barra no-print">
        <div className="subtab-row" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={'subtab-btn' + (situacoes.length === 0 ? ' active' : '')}
            onClick={() => setSituacoes([])}
          >
            Todas as situações
          </button>
          {Object.entries(SITUACAO_LABEL).map(([valor, rotulo]) => (
            <button
              key={valor}
              type="button"
              className={'subtab-btn' + (situacoes.includes(valor) ? ' active' : '')}
              onClick={() => setSituacoes((a) => (a.includes(valor) ? a.filter((x) => x !== valor) : [...a, valor]))}
            >
              {rotulo}
            </button>
          ))}
        </div>
        <label className="check-linha">
          <Checkbox checked={soDivergentes} onChange={(e) => setSoDivergentes(e.target.checked)} />
          Só divergentes
        </label>
        <label className="check-linha">
          <Checkbox checked={semNota} onChange={(e) => setSemNota(e.target.checked)} />
          Sem nota fiscal
        </label>
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase="recebimentos"
            colunas={COLUNAS_EXPORTACAO}
            itens={tabela.itensOrdenados}
            disabled={tabela.totalItens === 0}
          />
        </div>
      </div>

      <div className="no-print" style={{ marginBottom: 12 }}>
        <CampoBusca
          valor={termoDigitado}
          onChange={setTermoDigitado}
          onSubmit={aplicarBusca}
          placeholder="Buscar por fornecedor, nº do recebimento ou nº do pedido — e apertar Buscar"
        />
      </div>

      <ChipsFiltros itens={chips} onLimparTudo={chips.length ? limparTudo : undefined} />

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="indicadores-faixa" style={{ marginTop: 14 }}>
        <IndicadorDestaque
          destaque
          Icone={PackageCheck}
          rotulo="Em conferência agora"
          valor={formatQtd(resumo.emConferencia)}
          explicacao="Entregas abertas, ainda sendo contadas na doca. Enquanto não são fechadas, não contam no pedido."
        />
        <IndicadorDestaque
          Icone={CheckCircle2}
          rotulo="Já conferidas"
          valor={formatQtd(resumo.conferidos)}
          explicacao="Entregas fechadas. É a partir delas que o pedido de compra vira parcial ou recebido."
        />
        <IndicadorDestaque
          tom={resumo.divergentes > 0 ? 'atencao' : undefined}
          Icone={AlertTriangle}
          rotulo="Fechadas com divergência"
          valor={formatQtd(resumo.divergentes)}
          explicacao="Chegou diferente do que foi pedido, com o motivo escrito. Cada uma é uma cobrança em aberto com o fornecedor."
        />
        <IndicadorDestaque
          tom={resumo.semNota > 0 ? 'atencao' : undefined}
          Icone={FileText}
          rotulo="Ainda sem nota fiscal"
          valor={formatQtd(resumo.semNota)}
          explicacao="Mercadoria que chegou antes da nota. É a fila de trabalho do fiscal — sem a nota, o custo do insumo não entra."
        />
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Entregas</div>
          <span className="page-sub" style={{ margin: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</span>
        </div>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nº</ThOrdenavel>
                <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Data</ThOrdenavel>
                <ThOrdenavel coluna="fornecedor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Fornecedor</ThOrdenavel>
                <ThOrdenavel coluna="pedido" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Pedido</ThOrdenavel>
                <ThOrdenavel coluna="itens" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Linhas</ThOrdenavel>
                <th>Nota fiscal</th>
                <th>Divergência</th>
                <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && recebimentos.length === 0 && <SkeletonLinhasTabela colunas={9} />}
              {tabela.itensPagina.map((r) => (
                <tr key={r.id} className="clickable-row" onClick={() => abrirDetalhe(r.id)}>
                  <td className="mono">#{r.numero}</td>
                  <td className="mono">{dataBr(String(r.data_recebimento).slice(0, 10))}</td>
                  <td>{r.fornecedor_nome || '—'}</td>
                  <td className="mono">{r.pedido_numero ? `#${r.pedido_numero}` : '—'}</td>
                  <td className="mono">{formatQtd(r.qtd_itens)}</td>
                  <td>{r.nota_fiscal_entrada_id ? <span className="stamp sm tone-saudavel">vinculada</span> : <span style={{ color: 'var(--ink-faint)' }}>sem nota</span>}</td>
                  <td>
                    {r.divergencia
                      ? <span className="cel-dupla"><span className="stamp sm tone-atencao">divergente</span><small>{r.divergencia_motivo || ''}</small></span>
                      : '—'}
                  </td>
                  <td>
                    <span className={'stamp sm ' + (SITUACAO_TONE[r.situacao] || 'tone-neutro')}>
                      {SITUACAO_LABEL[r.situacao] || r.situacao}
                    </span>
                  </td>
                  <td><ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        {semNenhum && (
          <EstadoVazio
            Icone={Truck}
            titulo={chips.length ? 'Nenhuma entrega com esses filtros' : 'Nenhuma entrega registrada ainda'}
            descricao={chips.length
              ? soDivergentes
                ? 'Nenhuma entrega fechou com divergência neste recorte — é a resposta boa. Tire o filtro para ver o resto.'
                : 'Os filtros que estão valendo aparecem logo acima da faixa de números — remova um deles ou limpe tudo.'
              : 'Aqui fica a conferência do que chega na doca. Comece abrindo a conferência de um pedido de compra já aprovado.'}
            onAcao={chips.length ? limparTudo : () => setCriando(true)}
            acaoLabel={chips.length ? 'Limpar filtros' : 'Conferir uma entrega'}
            IconeAcao={chips.length ? undefined : Plus}
          />
        )}
        <Paginacao {...tabela} />
      </div>

      {criando && (
        <ModalNovoRecebimento
          onFechar={() => setCriando(false)}
          onCriado={(data) => { setCriando(false); setDetalhe(data); setRecarregar((n) => n + 1); }}
        />
      )}
    </div>
  );
}
