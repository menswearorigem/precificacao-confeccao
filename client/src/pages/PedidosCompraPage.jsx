import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ChevronRight, ClipboardList, Clock, Wallet, PackageCheck, AlertTriangle,
  CheckCircle2, XCircle, Info, X, Truck,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd, qtdFracionaria } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio,
  IndicadorDestaque, CampoBusca, ChipsFiltros, Checkbox, Field, DateInput,
} from '../components/ui';
import { useTabela } from '../lib/useTabela';

// Pedido de compra — o que foi pedido e ainda não chegou.
//
// É o documento que não existia: `compras` nasce com o gasto consumado, então
// a casa só descobria que algo não chegou quando faltava na produção.
//
// Duas regras do backend que a tela precisa explicar em português:
//   · aprovar exige PREVISÃO DE ENTREGA. Sem prazo prometido não existe
//     atraso, e pedido sem data nunca aparece em lista de cobrança nenhuma;
//   · a quantidade recebida NUNCA é um contador: vem da soma dos recebimentos.
//     É por isso que o detalhe mostra pedido e recebido lado a lado, e não um
//     número só "corrigido".

const SITUACAO_LABEL = {
  rascunho: 'Rascunho',
  aguardando_aprovacao: 'Aguardando aprovação',
  aprovado: 'Aprovado',
  parcial: 'Recebido em parte',
  recebido: 'Recebido',
  cancelado: 'Cancelado',
};

const SITUACAO_TONE = {
  rascunho: 'tone-neutro',
  aguardando_aprovacao: 'tone-atencao',
  aprovado: 'tone-elevada',
  parcial: 'tone-atencao',
  recebido: 'tone-saudavel',
  cancelado: 'tone-prejuizo',
};

const ITEM_LABEL = {
  pendente: 'Não chegou',
  parcial: 'Chegou em parte',
  completo: 'Completo',
  excedente: 'Veio a mais',
};

const ITEM_TONE = {
  pendente: 'tone-neutro',
  parcial: 'tone-atencao',
  completo: 'tone-saudavel',
  excedente: 'tone-prejuizo',
};

const COLUNAS_ORDENAVEIS = {
  numero: (p) => Number(p.numero) || 0,
  emissao: (p) => new Date(p.data_emissao).getTime(),
  fornecedor: (p) => p.fornecedor_nome || '',
  previsao: (p) => (p.previsao_entrega ? new Date(p.previsao_entrega).getTime() : null),
  atraso: (p) => (p.dias_atraso === null || p.dias_atraso === undefined ? null : Number(p.dias_atraso)),
  itens: (p) => Number(p.qtd_itens) || 0,
  total: (p) => Number(p.total_liquido) || 0,
  situacao: (p) => p.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (p) => p.numero },
  { rotulo: 'Emissão', valor: (p) => dataBr(String(p.data_emissao).slice(0, 10)) },
  { rotulo: 'Fornecedor', valor: (p) => p.fornecedor_nome || '' },
  { rotulo: 'Previsão de entrega', valor: (p) => (p.previsao_entrega ? dataBr(String(p.previsao_entrega).slice(0, 10)) : '') },
  { rotulo: 'Dias de atraso', valor: (p) => (p.dias_atraso === null || p.dias_atraso === undefined ? '' : formatQtd(p.dias_atraso)) },
  { rotulo: 'Itens', valor: (p) => formatQtd(p.qtd_itens) },
  { rotulo: 'Total Líquido', valor: (p) => brl(p.total_liquido) },
  { rotulo: 'Situação', valor: (p) => SITUACAO_LABEL[p.situacao] || p.situacao },
];

function mensagemErro(err) {
  return err?.data?.error || err?.data?.erro || err?.message || 'Não consegui completar a ação.';
}

// ---------------------------------------------------------------------------
// Aprovar — o ato que transforma "alguém digitou" em "a casa se comprometeu"
// ---------------------------------------------------------------------------
function ModalAprovar({ pedido, onFechar, onAprovado }) {
  const [previsao, setPrevisao] = useState(pedido.previsao_entrega ? String(pedido.previsao_entrega).slice(0, 10) : '');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function aprovar(e) {
    e.preventDefault();
    if (!previsao) {
      setErro('Informe a previsão de entrega antes de aprovar. Sem prazo prometido não há como medir atraso.');
      return;
    }
    setSalvando(true);
    setErro('');
    try {
      const data = await api.post(`/pedidos-compra/${pedido.id}/aprovar`, { previsao_entrega: previsao });
      onAprovado(data);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <form className="card viagem-modal" onSubmit={aprovar}>
        <div className="card-head-linha">
          <div className="card-head">Aprovar o pedido #{pedido.numero}</div>
          <button type="button" className="icon-btn" onClick={onFechar}><X size={16} /></button>
        </div>
        <p className="page-sub">
          Aprovar é o que separa “alguém digitou” de “a casa se comprometeu com o gasto”. Fica
          gravado quem aprovou e quando.
        </p>

        <div className="row-line"><span>Fornecedor</span><span className="mono">{pedido.fornecedor_nome || '—'}</span></div>
        <div className="row-line strong"><span>Total do pedido</span><span className="mono">{brl(pedido.total_liquido)}</span></div>

        <Field
          label="Previsão de entrega (obrigatória)"
          hint="É a data prometida pelo fornecedor. Sem ela o pedido nunca aparece na lista de atrasados."
        >
          <DateInput value={previsao} onChange={(e) => setPrevisao(e.target.value)} />
        </Field>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Aprovando…' : 'Aprovar pedido'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ModalCancelar({ pedido, onFechar, onCancelado }) {
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function cancelar(e) {
    e.preventDefault();
    if (!motivo.trim()) { setErro('Escreva o motivo do cancelamento.'); return; }
    setSalvando(true);
    setErro('');
    try {
      const data = await api.post(`/pedidos-compra/${pedido.id}/cancelar`, { motivo: motivo.trim() });
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
          <div className="card-head">Cancelar o pedido #{pedido.numero}</div>
          <button type="button" className="icon-btn" onClick={onFechar}><X size={16} /></button>
        </div>
        <p className="page-sub">
          O pedido continua existindo com o motivo escrito. Cancelar não apaga nada — é o que
          permite entender, meses depois, por que aquela compra não aconteceu.
        </p>

        <Field label="Motivo do cancelamento (obrigatório)">
          <textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: fornecedor não conseguiu a malha; compramos de outro." />
        </Field>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Voltar</button>
          <button type="submit" className="btn btn-danger" disabled={salvando}>
            {salvando ? 'Cancelando…' : 'Cancelar pedido'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe — o confronto por item
// ---------------------------------------------------------------------------
function Detalhe({ detalhe, confronto, onVoltar, onAtualizar }) {
  const navigate = useNavigate();
  const [aprovando, setAprovando] = useState(false);
  const [cancelando, setCancelando] = useState(false);

  const { pedido, recebimentos } = detalhe;
  const itens = confronto?.itens || detalhe.itens || [];
  const totais = confronto?.totais || null;

  const atraso = pedido.dias_atraso === null || pedido.dias_atraso === undefined ? null : Number(pedido.dias_atraso);
  const pendentes = itens.filter((i) => i.situacao_item === 'pendente' || i.situacao_item === 'parcial').length;

  return (
    <div className="page-wide">
      <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={onVoltar}>
        <ArrowLeft size={14} /> Voltar para os pedidos
      </button>

      <div className="pagina-topo">
        <div>
          <h2>
            Pedido de compra #{pedido.numero}{' '}
            <span className={'stamp sm ' + (SITUACAO_TONE[pedido.situacao] || 'tone-neutro')}>
              {SITUACAO_LABEL[pedido.situacao] || pedido.situacao}
            </span>
          </h2>
          <p className="page-sub">
            {pedido.fornecedor_nome || 'Sem fornecedor'} · emitido em {dataBr(String(pedido.data_emissao).slice(0, 10))}
            {pedido.previsao_entrega
              ? <> · prometido para {dataBr(String(pedido.previsao_entrega).slice(0, 10))}</>
              : <> · <strong>sem previsão de entrega</strong></>}
            {pedido.aprovado_em && <> · aprovado por {pedido.aprovado_por_nome || 'alguém'} em {new Date(pedido.aprovado_em).toLocaleDateString('pt-BR')}</>}
          </p>
        </div>
        <div className="pagina-topo-acoes">
          {!pedido.aprovado_em && pedido.situacao !== 'cancelado' && (
            <button type="button" className="btn btn-primary" onClick={() => setAprovando(true)}>
              <CheckCircle2 size={14} /> Aprovar
            </button>
          )}
          {pedido.situacao !== 'cancelado' && (
            <button type="button" className="btn btn-danger" onClick={() => setCancelando(true)}>
              <XCircle size={14} /> Cancelar
            </button>
          )}
        </div>
      </div>

      {pedido.situacao === 'cancelado' && pedido.cancelado_motivo && (
        <div className="aviso-compacto tone-prejuizo">
          Pedido cancelado: {pedido.cancelado_motivo}
        </div>
      )}
      {!pedido.previsao_entrega && pedido.situacao !== 'cancelado' && (
        <div className="aviso-compacto tone-atencao">
          <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          Este pedido não tem previsão de entrega. Enquanto não tiver, ele nunca vai aparecer como
          atrasado — o atraso é medido contra a data prometida.
        </div>
      )}

      <div className="indicadores-faixa compacta">
        <IndicadorDestaque
          destaque
          Icone={Wallet}
          rotulo="Valor do pedido"
          valor={brl(pedido.total_liquido)}
          explicacao="Total líquido do que foi pedido, já com desconto e frete."
        />
        <IndicadorDestaque
          Icone={PackageCheck}
          rotulo="Valor já recebido"
          valor={totais ? brl(totais.valor_recebido) : '—'}
          explicacao="Soma do que efetivamente chegou, pelo preço de cada recebimento. Recebimento cancelado não conta."
        />
        <IndicadorDestaque
          tom={pendentes > 0 ? 'atencao' : undefined}
          Icone={ClipboardList}
          rotulo="Itens que ainda faltam"
          valor={formatQtd(pendentes)}
          explicacao={pendentes > 0
            ? 'Linhas que não chegaram, ou chegaram só em parte.'
            : 'Todas as linhas do pedido já chegaram por completo.'}
        />
        <IndicadorDestaque
          tom={atraso > 0 ? 'negativo' : undefined}
          Icone={Clock}
          rotulo="Dias de atraso"
          valor={atraso === null ? '—' : formatQtd(atraso)}
          explicacao={atraso === null
            ? 'Sem previsão de entrega, não há como medir atraso.'
            : atraso > 0
              ? 'Dias corridos passados da data prometida pelo fornecedor.'
              : 'Dentro do prazo prometido.'}
        />
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Confronto: o que foi pedido × o que chegou</div>
          <span className="page-sub" style={{ margin: 0 }}>{formatQtd(itens.length)} item(ns)</span>
        </div>
        <p className="page-sub">
          As duas quantidades ficam lado a lado para sempre — o pedido não é reescrito para o que
          chegou. É isso que permite cobrar o fornecedor e medir quem entrega certo.
        </p>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Qtd. Pedida</th>
                <th>Qtd. Recebida</th>
                <th>Pendente</th>
                <th>Valor Pedido</th>
                <th>Valor Recebido</th>
                <th>Situação do item</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => {
                const pendente = Number(it.quantidade_pendente || 0);
                return (
                  <tr key={it.pedido_compra_item_id}>
                    <td>
                      <span className="cel-dupla">
                        <strong>{it.descricao}</strong>
                        {it.insumo_nome && <small>{it.insumo_nome}</small>}
                      </span>
                    </td>
                    <td className="mono">{qtdFracionaria(it.quantidade_pedida)} {it.unidade || ''}</td>
                    <td className="mono">{qtdFracionaria(it.quantidade_recebida)}</td>
                    <td className="mono">
                      {pendente > 0
                        ? <span className="stamp sm tone-atencao">{qtdFracionaria(pendente)}</span>
                        : pendente < 0
                          ? <span className="stamp sm tone-prejuizo">{qtdFracionaria(pendente)}</span>
                          : '—'}
                    </td>
                    <td className="mono">{brl(it.valor_pedido)}</td>
                    <td className="mono">{Number(it.quantidade_recebida) === 0 ? '—' : brl(it.valor_recebido)}</td>
                    <td>
                      <span className={'stamp sm ' + (ITEM_TONE[it.situacao_item] || 'tone-neutro')}>
                        {ITEM_LABEL[it.situacao_item] || it.situacao_item}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {totais && itens.length > 0 && (
                <tr className="linha-total">
                  <td>Totais do pedido</td>
                  <td className="mono">{qtdFracionaria(totais.quantidade_pedida)}</td>
                  <td className="mono">{qtdFracionaria(totais.quantidade_recebida)}</td>
                  <td className="mono">{qtdFracionaria(Number(totais.quantidade_pedida) - Number(totais.quantidade_recebida))}</td>
                  <td className="mono">{brl(totais.valor_pedido)}</td>
                  <td className="mono">{brl(totais.valor_recebido)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </DataTable>
        {itens.length === 0 && (
          <EstadoVazio
            Icone={ClipboardList}
            titulo="Este pedido não tem itens"
            descricao="Um pedido sem item não pode ser aprovado — o backend recusa. Ele provavelmente nasceu de uma cotação sem vencedor."
          />
        )}
        <div className="nota-precisao">
          <Info size={14} />
          <span>
            A quantidade recebida não é um contador: é a <strong>soma dos recebimentos</strong> não
            cancelados desta compra. Cancelar um recebimento devolve a quantidade na hora.
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Entregas deste pedido</div>
        {recebimentos.length === 0 ? (
          <EstadoVazio
            Icone={PackageCheck}
            titulo="Nada chegou ainda"
            descricao={pedido.aprovado_em
              ? 'Nenhum recebimento foi aberto para este pedido. A conferência da doca é feita na tela Recebimentos.'
              : 'O pedido ainda não foi aprovado — e pedido não aprovado não recebe mercadoria.'}
            onAcao={pedido.aprovado_em ? () => navigate('/compras/recebimentos') : undefined}
            acaoLabel="Ir para Recebimentos"
          />
        ) : (
          <DataTable>
            <table className="data-table">
              <thead>
                <tr><th>Nº</th><th>Data</th><th>Situação</th><th>Divergência</th><th>Quem conferiu</th></tr>
              </thead>
              <tbody>
                {recebimentos.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">#{r.numero}</td>
                    <td className="mono">{dataBr(String(r.data_recebimento).slice(0, 10))}</td>
                    <td>{r.situacao}</td>
                    <td>{r.divergencia ? <span className="stamp sm tone-atencao">{r.divergencia_motivo || 'com divergência'}</span> : '—'}</td>
                    <td>{r.conferido_por_nome || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        )}
      </div>

      {aprovando && (
        <ModalAprovar
          pedido={pedido}
          onFechar={() => setAprovando(false)}
          onAprovado={(data) => { onAtualizar(data); setAprovando(false); }}
        />
      )}
      {cancelando && (
        <ModalCancelar
          pedido={pedido}
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
export default function PedidosCompraPage() {
  const [situacoes, setSituacoes] = useState([]);
  const [soAtrasados, setSoAtrasados] = useState(false);
  const [termoDigitado, setTermoDigitado] = useState('');
  const [termoAplicado, setTermoAplicado] = useState('');
  const [pedidos, setPedidos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [recarregar, setRecarregar] = useState(0);

  const [detalhe, setDetalhe] = useState(null);
  const [confronto, setConfronto] = useState(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (situacoes.length) p.set('situacao', situacoes.join(','));
    if (soAtrasados) p.set('atrasados', 'true');
    if (termoAplicado.trim()) p.set('busca', termoAplicado.trim());
    return p;
  }, [situacoes, soAtrasados, termoAplicado]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`/pedidos-compra?${params.toString()}`)
      .then((r) => setPedidos(Array.isArray(r) ? r : []))
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params, recarregar]);

  const tabela = useTabela(pedidos, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'emissao', direcaoPadrao: 'desc' });

  const resumo = useMemo(() => {
    const vivos = pedidos.filter((p) => p.situacao !== 'cancelado');
    const emAberto = vivos.filter((p) => p.situacao === 'aprovado' || p.situacao === 'parcial');
    const atrasados = emAberto.filter((p) => Number(p.dias_atraso) > 0);
    const semPrevisao = vivos.filter((p) => !p.previsao_entrega && p.situacao !== 'recebido');
    return {
      emAbertoValor: emAberto.reduce((s, p) => s + Number(p.total_liquido || 0), 0),
      emAbertoQtd: emAberto.length,
      atrasadosQtd: atrasados.length,
      atrasadosValor: atrasados.reduce((s, p) => s + Number(p.total_liquido || 0), 0),
      piorAtraso: atrasados.reduce((m, p) => Math.max(m, Number(p.dias_atraso) || 0), 0),
      aguardando: vivos.filter((p) => p.situacao === 'rascunho' || p.situacao === 'aguardando_aprovacao').length,
      semPrevisao: semPrevisao.length,
    };
  }, [pedidos]);

  const chips = [];
  for (const s of situacoes) {
    chips.push({
      chave: `sit-${s}`,
      rotulo: 'Situação',
      valor: SITUACAO_LABEL[s] || s,
      onRemover: () => setSituacoes((a) => a.filter((x) => x !== s)),
    });
  }
  if (soAtrasados) {
    chips.push({ chave: 'atrasados', rotulo: 'Entrega', valor: 'Só os atrasados', onRemover: () => setSoAtrasados(false) });
  }
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
    setSoAtrasados(false);
    setTermoAplicado('');
    setTermoDigitado('');
  }

  function aplicarBusca(valor) {
    setTermoAplicado(valor === undefined ? termoDigitado : valor);
  }

  async function abrirDetalhe(id) {
    setErro('');
    try {
      const [d, c] = await Promise.all([
        api.get(`/pedidos-compra/${id}`),
        api.get(`/pedidos-compra/${id}/confronto`).catch(() => null),
      ]);
      setDetalhe(d);
      setConfronto(c);
    } catch (err) { setErro(mensagemErro(err)); }
  }

  async function atualizarDetalhe(d) {
    setDetalhe(d);
    const c = await api.get(`/pedidos-compra/${d.pedido.id}/confronto`).catch(() => null);
    setConfronto(c);
  }

  if (detalhe) {
    return (
      <Detalhe
        detalhe={detalhe}
        confronto={confronto}
        onVoltar={() => { setDetalhe(null); setConfronto(null); setRecarregar((n) => n + 1); }}
        onAtualizar={atualizarDetalhe}
      />
    );
  }

  const semNenhum = !loading && pedidos.length === 0;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Pedidos de compra</h2>
          <p className="page-sub">
            O que foi pedido e ainda não chegou. Os números abaixo são deste recorte: mude os
            filtros e eles acompanham. Pedido cancelado aparece na lista, mas fica fora das somas.
          </p>
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
          <Checkbox checked={soAtrasados} onChange={(e) => setSoAtrasados(e.target.checked)} />
          Só os atrasados
        </label>
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase="pedidos-de-compra"
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
          placeholder="Buscar por número do pedido ou fornecedor — e apertar Buscar"
        />
      </div>

      <ChipsFiltros itens={chips} onLimparTudo={chips.length ? limparTudo : undefined} />

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="indicadores-faixa" style={{ marginTop: 14 }}>
        <IndicadorDestaque
          destaque
          Icone={Wallet}
          rotulo="Comprometido e não recebido"
          valor={brl(resumo.emAbertoValor)}
          explicacao={`${formatQtd(resumo.emAbertoQtd)} pedido(s) aprovado(s) ou recebido(s) em parte — dinheiro já prometido ao fornecedor.`}
        />
        <IndicadorDestaque
          tom={resumo.atrasadosQtd > 0 ? 'negativo' : undefined}
          Icone={Clock}
          rotulo="Pedidos atrasados"
          valor={formatQtd(resumo.atrasadosQtd)}
          explicacao={resumo.atrasadosQtd > 0
            ? `${brl(resumo.atrasadosValor)} parados, e o pior atraso é de ${formatQtd(resumo.piorAtraso)} dia(s) contra a data prometida.`
            : 'Nenhum pedido passou da data prometida pelo fornecedor.'}
        />
        <IndicadorDestaque
          tom={resumo.aguardando > 0 ? 'atencao' : undefined}
          Icone={ClipboardList}
          rotulo="Esperando aprovação"
          valor={formatQtd(resumo.aguardando)}
          explicacao="Rascunhos e pedidos aguardando aprovação. Enquanto não forem aprovados, não recebem mercadoria."
        />
        <IndicadorDestaque
          tom={resumo.semPrevisao > 0 ? 'atencao' : undefined}
          Icone={AlertTriangle}
          rotulo="Sem previsão de entrega"
          valor={formatQtd(resumo.semPrevisao)}
          explicacao="Sem data prometida, esses pedidos nunca vão aparecer como atrasados — é o defeito que a aprovação existe pra impedir."
        />
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Pedidos</div>
          <span className="page-sub" style={{ margin: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</span>
        </div>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nº</ThOrdenavel>
                <ThOrdenavel coluna="emissao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Emissão</ThOrdenavel>
                <ThOrdenavel coluna="fornecedor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Fornecedor</ThOrdenavel>
                <ThOrdenavel coluna="previsao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Previsão</ThOrdenavel>
                <ThOrdenavel coluna="atraso" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Atraso</ThOrdenavel>
                <ThOrdenavel coluna="itens" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Itens</ThOrdenavel>
                <ThOrdenavel coluna="total" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Total Líquido</ThOrdenavel>
                <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && pedidos.length === 0 && <SkeletonLinhasTabela colunas={9} />}
              {tabela.itensPagina.map((p) => {
                const atraso = p.dias_atraso === null || p.dias_atraso === undefined ? null : Number(p.dias_atraso);
                return (
                  <tr key={p.id} className="clickable-row" onClick={() => abrirDetalhe(p.id)}>
                    <td className="mono">#{p.numero}</td>
                    <td className="mono">{dataBr(String(p.data_emissao).slice(0, 10))}</td>
                    <td>{p.fornecedor_nome || '—'}</td>
                    <td className="mono">{p.previsao_entrega ? dataBr(String(p.previsao_entrega).slice(0, 10)) : '—'}</td>
                    <td>
                      {atraso === null
                        ? <span style={{ color: 'var(--ink-faint)' }}>sem previsão</span>
                        : atraso > 0
                          ? <span className="stamp sm tone-prejuizo">{formatQtd(atraso)} dia(s)</span>
                          : <span className="mono">—</span>}
                    </td>
                    <td className="mono">{formatQtd(p.qtd_itens)}</td>
                    <td className="mono">{brl(p.total_liquido)}</td>
                    <td>
                      <span className={'stamp sm ' + (SITUACAO_TONE[p.situacao] || 'tone-neutro')}>
                        {SITUACAO_LABEL[p.situacao] || p.situacao}
                      </span>
                    </td>
                    <td><ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
        {semNenhum && (
          <EstadoVazio
            Icone={Truck}
            titulo={chips.length ? 'Nenhum pedido com esses filtros' : 'Nenhum pedido de compra ainda'}
            descricao={chips.length
              ? soAtrasados
                ? 'Nenhum pedido passou da data prometida neste recorte — é a resposta boa. Tire o filtro “só os atrasados” para ver o resto.'
                : 'Os filtros que estão valendo aparecem logo acima da faixa de números — remova um deles ou limpe tudo.'
              : 'Pedidos de compra nascem de uma cotação com vencedor escolhido, na tela Cotações. Enquanto não houver nenhum, não há o que cobrar do fornecedor.'}
            onAcao={chips.length ? limparTudo : undefined}
            acaoLabel="Limpar filtros"
          />
        )}
        <Paginacao {...tabela} />
      </div>

      <div className="nota-precisao">
        <Info size={14} />
        <span>
          O atraso é medido em dias corridos contra a <strong>previsão de entrega</strong> prometida
          na aprovação. Pedido sem previsão aparece como “sem previsão”, nunca como zero dia de atraso.
        </span>
      </div>
    </div>
  );
}
