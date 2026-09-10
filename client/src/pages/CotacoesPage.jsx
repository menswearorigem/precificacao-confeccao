import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, ArrowLeft, ChevronRight, Scale, Users, Clock, ClipboardList,
  CheckCircle2, AlertTriangle, Trash2, Info, X,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd, qtdFracionaria } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio,
  IndicadorDestaque, CampoBusca, ChipsFiltros, Select, NumInput, Field, DateInput, Checkbox,
} from '../components/ui';
import { useTabela } from '../lib/useTabela';

// Cotação de compra — comparar fornecedor ANTES de comprar.
//
// A tela responde, na ordem em que alguém pergunta:
//   1. o que está esperando resposta       -> faixa de indicadores
//   2. qual cotação é aquela               -> busca + filtro de situação + lista
//   3. quem cobrou o quê, item a item      -> a MATRIZ de comparação
//   4. com quem eu fecho cada item         -> escolha do vencedor, por item
//   5. e agora?                            -> gerar os pedidos de compra
//
// Duas regras do backend que a tela precisa contar em português:
//   · preço em branco é "não cotou", nunca R$ 0,00 — o fornecedor respondeu a
//     cotação e não cotou AQUELE item, que é diferente de cotar de graça;
//   · escolher quem não é o menor preço exige motivo escrito. Sem isso, quem
//     olhar daqui a três meses vai ler a escolha como erro.

const SITUACAO_LABEL = {
  rascunho: 'Rascunho',
  aberta: 'Aberta',
  fechada: 'Fechada',
  cancelada: 'Cancelada',
};

const SITUACAO_TONE = {
  rascunho: 'tone-neutro',
  aberta: 'tone-elevada',
  fechada: 'tone-saudavel',
  cancelada: 'tone-prejuizo',
};

const COLUNAS_ORDENAVEIS = {
  numero: (c) => Number(c.numero) || 0,
  descricao: (c) => c.descricao || '',
  abertura: (c) => new Date(c.data_abertura).getTime(),
  prazo: (c) => (c.prazo_resposta ? new Date(c.prazo_resposta).getTime() : null),
  itens: (c) => Number(c.qtd_itens) || 0,
  respostas: (c) => Number(c.qtd_respostas) || 0,
  situacao: (c) => c.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (c) => c.numero },
  { rotulo: 'Descrição', valor: (c) => c.descricao || '' },
  { rotulo: 'Abertura', valor: (c) => dataBr(String(c.data_abertura).slice(0, 10)) },
  { rotulo: 'Prazo de resposta', valor: (c) => (c.prazo_resposta ? dataBr(String(c.prazo_resposta).slice(0, 10)) : '') },
  { rotulo: 'Itens', valor: (c) => formatQtd(c.qtd_itens) },
  { rotulo: 'Convidados', valor: (c) => formatQtd(c.qtd_convidados) },
  { rotulo: 'Responderam', valor: (c) => formatQtd(c.qtd_respostas) },
  { rotulo: 'Situação', valor: (c) => SITUACAO_LABEL[c.situacao] || c.situacao },
];

// O backend novo responde `{ erro }`; o cliente de API só conhece `error`.
// Sem isto a pessoa lia "Erro na requisição (400)" no lugar da frase que o
// servidor escreveu justamente pra ela.
function mensagemErro(err) {
  return err?.data?.error || err?.data?.erro || err?.message || 'Não consegui completar a ação.';
}

function hojeIso() {
  return new Date().toISOString().slice(0, 10);
}

function itemVazio() {
  return { descricao: '', unidade: '', quantidade: 1 };
}

// ---------------------------------------------------------------------------
// Nova cotação
// ---------------------------------------------------------------------------
function ModalNovaCotacao({ fornecedores, insumos, onFechar, onCriada }) {
  const [descricao, setDescricao] = useState('');
  const [prazo, setPrazo] = useState('');
  const [itens, setItens] = useState([itemVazio()]);
  const [convidados, setConvidados] = useState([]);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  function alterarItem(idx, patch) {
    setItens((lista) => lista.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function usarInsumo(idx, insumoId) {
    const insumo = insumos.find((i) => String(i.id) === String(insumoId));
    if (!insumo) { alterarItem(idx, { insumo_id: null }); return; }
    alterarItem(idx, { insumo_id: insumo.id, descricao: insumo.nome, unidade: insumo.unidade || '' });
  }

  function alternarFornecedor(id) {
    setConvidados((atuais) => (atuais.includes(id) ? atuais.filter((x) => x !== id) : [...atuais, id]));
  }

  async function salvar(e) {
    e.preventDefault();
    const limpos = itens.filter((it) => String(it.descricao || '').trim());
    if (limpos.length === 0) { setErro('Escreva pelo menos um item pra perguntar o preço.'); return; }
    setSalvando(true);
    setErro('');
    try {
      const data = await api.post('/cotacoes', {
        descricao: descricao.trim() || null,
        prazo_resposta: prazo || null,
        itens: limpos,
        fornecedores: convidados,
      });
      onCriada(data);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <form className="card viagem-modal" onSubmit={salvar}>
        <div className="card-head-linha">
          <div className="card-head">Nova cotação</div>
          <button type="button" className="icon-btn" onClick={onFechar}><X size={16} /></button>
        </div>
        <p className="page-sub">
          A cotação é a mesma lista de itens perguntada a vários fornecedores. É a quantidade igual
          pra todo mundo que torna as respostas comparáveis.
        </p>

        <div className="form-grid">
          <Field label="Descrição" hint="Como a equipe vai se referir a ela no telefone.">
            <input value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex.: malha e aviamento da coleção de verão" />
          </Field>
          <Field label="Prazo de resposta" hint="Até quando o fornecedor pode responder.">
            <DateInput value={prazo} onChange={(e) => setPrazo(e.target.value)} />
          </Field>
        </div>

        <div className="card-head" style={{ marginTop: 14 }}>O que vai ser perguntado</div>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr><th>Insumo cadastrado</th><th>Descrição</th><th>Unidade</th><th>Quantidade</th><th /></tr>
            </thead>
            <tbody>
              {itens.map((it, idx) => (
                <tr key={idx}>
                  <td>
                    <Select value={it.insumo_id ? String(it.insumo_id) : ''} onChange={(e) => usarInsumo(idx, e.target.value)}>
                      <option value="">Texto livre</option>
                      {insumos.map((i) => <option key={i.id} value={String(i.id)}>{i.nome}</option>)}
                    </Select>
                  </td>
                  <td>
                    <input
                      value={it.descricao}
                      onChange={(e) => alterarItem(idx, { descricao: e.target.value })}
                      placeholder="O que está sendo cotado"
                    />
                  </td>
                  <td>
                    <input value={it.unidade || ''} onChange={(e) => alterarItem(idx, { unidade: e.target.value })} placeholder="m, kg, pç" />
                  </td>
                  <td>
                    <NumInput value={it.quantidade} onChange={(v) => alterarItem(idx, { quantidade: v })} />
                  </td>
                  <td>
                    <button type="button" className="icon-btn perigo" title="Tirar este item" onClick={() => setItens((l) => l.filter((_, i) => i !== idx))}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        <button type="button" className="btn btn-dashed" style={{ marginTop: 8 }} onClick={() => setItens((l) => [...l, itemVazio()])}>
          <Plus size={14} /> Mais um item
        </button>

        <div className="card-head" style={{ marginTop: 16 }}>Quem vai ser convidado a responder</div>
        <p className="page-sub">
          Fornecedor que NÃO respondeu também é informação: é o que mostra, depois, que a cotação
          teve uma resposta só e portanto não comparou nada.
        </p>
        {fornecedores.length === 0 && <p className="page-sub">Nenhum fornecedor cadastrado ainda.</p>}
        <div className="grid-3">
          {fornecedores.map((f) => (
            <label key={f.id} className="check-linha">
              <Checkbox checked={convidados.includes(f.id)} onChange={() => alternarFornecedor(f.id)} />
              {f.nome}
            </label>
          ))}
        </div>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Criando…' : 'Criar cotação'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Digitar a proposta de UM fornecedor
// ---------------------------------------------------------------------------
function ModalResposta({ detalhe, onFechar, onGravada }) {
  const convidados = detalhe.fornecedores;
  const [fornecedorId, setFornecedorId] = useState(convidados[0] ? String(convidados[0].fornecedor_id) : '');
  const [precos, setPrecos] = useState({});
  const [prazoDias, setPrazoDias] = useState('');
  const [condicao, setCondicao] = useState('');
  const [frete, setFrete] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  // Trocar de fornecedor no seletor traz o que ele já tinha respondido, em vez
  // de abrir a grade em branco e fazer a pessoa digitar tudo de novo.
  useEffect(() => {
    const atuais = {};
    for (const r of detalhe.respostas) {
      if (String(r.fornecedor_id) !== String(fornecedorId)) continue;
      atuais[r.cotacao_item_id] = r.valor_unitario === null || r.valor_unitario === undefined ? '' : Number(r.valor_unitario);
    }
    setPrecos(atuais);
    const cf = convidados.find((c) => String(c.fornecedor_id) === String(fornecedorId));
    setPrazoDias(cf?.prazo_entrega_dias ?? '');
    setCondicao(cf?.condicao_pagamento || '');
    setFrete(cf?.valor_frete ?? '');
  }, [fornecedorId, detalhe]); // eslint-disable-line react-hooks/exhaustive-deps

  async function salvar(e) {
    e.preventDefault();
    if (!fornecedorId) { setErro('Escolha o fornecedor que mandou a proposta.'); return; }
    setSalvando(true);
    setErro('');
    try {
      const data = await api.post(`/cotacoes/${detalhe.cotacao.id}/respostas`, {
        fornecedor_id: Number(fornecedorId),
        prazo_entrega_dias: prazoDias === '' ? null : Number(prazoDias),
        condicao_pagamento: condicao.trim() || null,
        valor_frete: frete === '' ? null : Number(frete),
        itens: detalhe.itens.map((it) => ({
          cotacao_item_id: it.id,
          valor_unitario: precos[it.id] === '' || precos[it.id] === undefined ? null : precos[it.id],
        })),
      });
      onGravada(data);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <form className="card viagem-modal" onSubmit={salvar}>
        <div className="card-head-linha">
          <div className="card-head">Registrar a proposta que chegou</div>
          <button type="button" className="icon-btn" onClick={onFechar}><X size={16} /></button>
        </div>
        <p className="page-sub">
          Item que o fornecedor não cotou fica <strong>em branco</strong> — em branco quer dizer
          “não cotou”, e é diferente de cotar por zero.
        </p>

        <div className="form-grid">
          <Field label="Fornecedor">
            <Select value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)}>
              <option value="">Escolha</option>
              {convidados.map((c) => (
                <option key={c.fornecedor_id} value={String(c.fornecedor_id)}>{c.fornecedor_nome}</option>
              ))}
            </Select>
          </Field>
          <Field label="Prazo de entrega (dias)">
            <NumInput value={prazoDias} onChange={setPrazoDias} step="1" />
          </Field>
          <Field label="Condição de pagamento">
            <input value={condicao} onChange={(e) => setCondicao(e.target.value)} placeholder="Ex.: 30/60 dias" />
          </Field>
          <Field label="Frete da proposta">
            <NumInput value={frete} onChange={setFrete} suffix="R$" />
          </Field>
        </div>

        <DataTable>
          <table className="data-table">
            <thead>
              <tr><th>Item</th><th>Qtd.</th><th>Preço unitário cotado</th></tr>
            </thead>
            <tbody>
              {detalhe.itens.map((it) => (
                <tr key={it.id}>
                  <td>{it.descricao}</td>
                  <td className="mono">{qtdFracionaria(it.quantidade)} {it.unidade || ''}</td>
                  <td>
                    <NumInput
                      value={precos[it.id] ?? ''}
                      onChange={(v) => setPrecos((p) => ({ ...p, [it.id]: v }))}
                      suffix="R$"
                      placeholder="não cotou"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Gravando…' : 'Gravar proposta'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Escolher o vencedor de um item — motivo obrigatório quando não é o menor
// ---------------------------------------------------------------------------
function ModalEscolha({ escolha, onFechar, onConfirmada }) {
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const precisaMotivo = !escolha.ehMenor;

  async function confirmar(e) {
    e.preventDefault();
    if (precisaMotivo && !motivo.trim()) {
      setErro('Este não é o menor preço cotado. Escreva o motivo da escolha (prazo, qualidade, pagamento).');
      return;
    }
    setSalvando(true);
    setErro('');
    try {
      const data = await api.post(`/cotacoes/${escolha.cotacaoId}/vencedor`, {
        cotacao_item_id: escolha.itemId,
        fornecedor_id: escolha.fornecedorId,
        motivo_escolha: motivo.trim() || null,
      });
      onConfirmada(data);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <form className="card viagem-modal" onSubmit={confirmar}>
        <div className="card-head-linha">
          <div className="card-head">Fechar este item com {escolha.fornecedorNome}</div>
          <button type="button" className="icon-btn" onClick={onFechar}><X size={16} /></button>
        </div>

        <div className="row-line"><span>Item</span><span className="mono">{escolha.itemDescricao}</span></div>
        <div className="row-line"><span>Preço deste fornecedor</span><span className="mono">{brl(escolha.valor)}</span></div>
        <div className="row-line">
          <span>Menor preço cotado</span>
          <span className="mono">{escolha.menor === null ? '—' : `${brl(escolha.menor)} (${escolha.menorFornecedor})`}</span>
        </div>
        <div className="row-line strong">
          <span>Diferença no total do item</span>
          <span className="mono">{escolha.menor === null ? '—' : brl((Number(escolha.valor) - Number(escolha.menor)) * Number(escolha.quantidade || 0))}</span>
        </div>

        {precisaMotivo ? (
          <div className="aviso-compacto tone-atencao" style={{ marginTop: 12 }}>
            <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            Este não é o menor preço. O motivo é obrigatório: sem ele, quem abrir esta cotação daqui a
            três meses vai ler a escolha como erro.
          </div>
        ) : (
          <div className="aviso-compacto tone-saudavel" style={{ marginTop: 12 }}>
            É o menor preço cotado para este item. O motivo é opcional.
          </div>
        )}

        <Field label={precisaMotivo ? 'Motivo da escolha (obrigatório)' : 'Motivo da escolha (opcional)'}>
          <textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: entrega em 7 dias contra 40 do mais barato." />
        </Field>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Gravando…' : 'Escolher este fornecedor'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A matriz de comparação
// ---------------------------------------------------------------------------
function Detalhe({ detalhe, onVoltar, onAtualizar }) {
  const navigate = useNavigate();
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [respondendo, setRespondendo] = useState(false);
  const [escolha, setEscolha] = useState(null);
  const [gerando, setGerando] = useState(false);

  const { cotacao, itens, fornecedores, respostas } = detalhe;

  const porItemFornecedor = useMemo(() => {
    const mapa = new Map();
    for (const r of respostas) mapa.set(`${r.cotacao_item_id}-${r.fornecedor_id}`, r);
    return mapa;
  }, [respostas]);

  // Menor preço de cada linha. Só entra quem cotou de verdade — linha sem
  // preço nenhum devolve null, e a tela escreve "ninguém cotou".
  const menorPorItem = useMemo(() => {
    const mapa = new Map();
    for (const it of itens) {
      let menor = null;
      for (const f of fornecedores) {
        const r = porItemFornecedor.get(`${it.id}-${f.fornecedor_id}`);
        const v = r?.valor_unitario;
        if (v === null || v === undefined) continue;
        if (menor === null || Number(v) < Number(menor.valor)) {
          menor = { valor: Number(v), fornecedorId: f.fornecedor_id, fornecedorNome: f.fornecedor_nome };
        }
      }
      mapa.set(it.id, menor);
    }
    return mapa;
  }, [itens, fornecedores, porItemFornecedor]);

  const vencedores = respostas.filter((r) => r.vencedor);

  const totalPorFornecedor = useMemo(() => {
    const mapa = new Map();
    for (const f of fornecedores) {
      let total = 0;
      let cotados = 0;
      for (const it of itens) {
        const r = porItemFornecedor.get(`${it.id}-${f.fornecedor_id}`);
        if (r?.valor_unitario === null || r?.valor_unitario === undefined) continue;
        total += Number(r.valor_unitario) * Number(it.quantidade || 0);
        cotados += 1;
      }
      mapa.set(f.fornecedor_id, { total, cotados });
    }
    return mapa;
  }, [fornecedores, itens, porItemFornecedor]);

  const totalEscolhido = useMemo(() => itens.reduce((soma, it) => {
    const venc = respostas.find((r) => r.cotacao_item_id === it.id && r.vencedor);
    if (!venc || venc.valor_unitario === null) return soma;
    return soma + Number(venc.valor_unitario) * Number(it.quantidade || 0);
  }, 0), [itens, respostas]);

  const totalMenor = useMemo(() => itens.reduce((soma, it) => {
    const menor = menorPorItem.get(it.id);
    return menor ? soma + menor.valor * Number(it.quantidade || 0) : soma;
  }, 0), [itens, menorPorItem]);

  async function abrirCotacao() {
    setErro('');
    try {
      const data = await api.put(`/cotacoes/${cotacao.id}`, { situacao: 'aberta' });
      onAtualizar(data);
    } catch (err) { setErro(mensagemErro(err)); }
  }

  async function gerarPedidos() {
    setGerando(true);
    setErro('');
    try {
      const r = await api.post(`/cotacoes/${cotacao.id}/gerar-pedidos`, {});
      const quantos = r.pedidos?.length || 0;
      setAviso(`${formatQtd(quantos)} pedido(s) de compra criado(s) — um por fornecedor vencedor. Eles nascem em rascunho e ainda precisam ser aprovados.`);
      const atual = await api.get(`/cotacoes/${cotacao.id}`);
      onAtualizar(atual);
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setGerando(false);
    }
  }

  const semResposta = fornecedores.filter((f) => !f.respondido_em).length;

  return (
    <div className="page-wide">
      <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={onVoltar}>
        <ArrowLeft size={14} /> Voltar para as cotações
      </button>

      <div className="pagina-topo">
        <div>
          <h2>
            Cotação #{cotacao.numero}{' '}
            <span className={'stamp sm ' + (SITUACAO_TONE[cotacao.situacao] || 'tone-neutro')}>
              {SITUACAO_LABEL[cotacao.situacao] || cotacao.situacao}
            </span>
          </h2>
          <p className="page-sub">
            {cotacao.descricao || 'Sem descrição.'} · aberta em {dataBr(String(cotacao.data_abertura).slice(0, 10))}
            {cotacao.prazo_resposta && <> · responder até {dataBr(String(cotacao.prazo_resposta).slice(0, 10))}</>}
          </p>
        </div>
        <div className="pagina-topo-acoes">
          {cotacao.situacao === 'rascunho' && (
            <button type="button" className="btn btn-ghost" onClick={abrirCotacao}>Abrir para resposta</button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setRespondendo(true)} disabled={fornecedores.length === 0}>
            <Plus size={14} /> Registrar proposta
          </button>
          <button type="button" className="btn btn-primary" onClick={gerarPedidos} disabled={vencedores.length === 0 || gerando}>
            <ClipboardList size={14} /> {gerando ? 'Gerando…' : 'Gerar pedidos'}
          </button>
        </div>
      </div>

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      {aviso && (
        <div className="aviso-compacto tone-saudavel">
          {aviso}{' '}
          <button type="button" className="btn btn-ghost sm" onClick={() => navigate('/compras/pedidos')}>Ver pedidos de compra</button>
        </div>
      )}

      <div className="indicadores-faixa compacta">
        <IndicadorDestaque
          Icone={Users}
          rotulo="Responderam"
          valor={`${formatQtd(fornecedores.filter((f) => f.respondido_em).length)} de ${formatQtd(fornecedores.length)}`}
          explicacao={semResposta > 0
            ? `${formatQtd(semResposta)} convidado(s) ainda não mandaram proposta — comparar com uma resposta só não é comparar.`
            : 'Todos os convidados mandaram proposta.'}
        />
        <IndicadorDestaque
          Icone={CheckCircle2}
          rotulo="Itens já decididos"
          valor={`${formatQtd(vencedores.length)} de ${formatQtd(itens.length)}`}
          explicacao="O vencedor é por item: é normal fechar a malha com um fornecedor e o aviamento com outro."
        />
        <IndicadorDestaque
          destaque
          rotulo="Total do que já foi escolhido"
          valor={vencedores.length === 0 ? '—' : brl(totalEscolhido)}
          explicacao="Soma de quantidade × preço do fornecedor escolhido, item a item. É o valor que vai virar pedido."
        />
        <IndicadorDestaque
          rotulo="Se fosse tudo pelo menor preço"
          valor={totalMenor === 0 ? '—' : brl(totalMenor)}
          explicacao="Soma do menor preço cotado de cada item. Serve de referência — nem sempre o menor preço é a melhor compra."
        />
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Matriz de comparação</div>
          <span className="page-sub" style={{ margin: 0 }}>
            {formatQtd(itens.length)} item(ns) × {formatQtd(fornecedores.length)} fornecedor(es)
          </span>
        </div>
        <p className="page-sub">
          Cada linha é um item, cada coluna é um fornecedor. O menor preço da linha vem marcado.
          Clique em <strong>Escolher</strong> na célula do fornecedor com quem você fecha aquele item.
        </p>

        {itens.length === 0 || fornecedores.length === 0 ? (
          <EstadoVazio
            Icone={Scale}
            titulo="Ainda não há o que comparar"
            descricao={itens.length === 0
              ? 'Esta cotação foi criada sem itens — sem item perguntado não há preço pra comparar.'
              : 'Nenhum fornecedor foi convidado nesta cotação. Convidado que não responde também é informação, mas é preciso convidar alguém primeiro.'}
          />
        ) : (
          <DataTable>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qtd.</th>
                  {fornecedores.map((f) => (
                    <th key={f.fornecedor_id}>
                      <span className="cel-dupla">
                        <strong>{f.fornecedor_nome}</strong>
                        <small>
                          {f.respondido_em ? 'respondeu' : 'sem resposta'}
                          {f.prazo_entrega_dias ? ` · ${formatQtd(f.prazo_entrega_dias)} dia(s)` : ''}
                          {f.condicao_pagamento ? ` · ${f.condicao_pagamento}` : ''}
                        </small>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {itens.map((it) => {
                  const menor = menorPorItem.get(it.id);
                  return (
                    <tr key={it.id}>
                      <td>
                        <span className="cel-dupla">
                          <strong>{it.descricao}</strong>
                          {menor === null && <small>ninguém cotou este item</small>}
                          {it.insumo_nome && <small>{it.insumo_nome}</small>}
                        </span>
                      </td>
                      <td className="mono">{qtdFracionaria(it.quantidade)} {it.unidade || ''}</td>
                      {fornecedores.map((f) => {
                        const r = porItemFornecedor.get(`${it.id}-${f.fornecedor_id}`);
                        const cotou = r && r.valor_unitario !== null && r.valor_unitario !== undefined;
                        if (!cotou) {
                          return (
                            <td key={f.fornecedor_id}>
                              <span style={{ color: 'var(--ink-faint)' }}>não cotou</span>
                            </td>
                          );
                        }
                        const valor = Number(r.valor_unitario);
                        const ehMenor = menor && Math.abs(valor - menor.valor) < 1e-9;
                        return (
                          <td key={f.fornecedor_id}>
                            <span className="cel-dupla">
                              <strong className="mono">{brl(valor)}</strong>
                              <small className="mono">{brl(valor * Number(it.quantidade || 0))} no total</small>
                              <small>
                                {ehMenor && <span className="stamp sm tone-saudavel">menor</span>}
                                {r.vencedor && <span className="stamp sm tone-elevada">escolhido</span>}
                              </small>
                              {r.vencedor && r.motivo_escolha && <small>{r.motivo_escolha}</small>}
                              {!r.vencedor && (
                                <small>
                                <button
                                  type="button"
                                  className="btn btn-dashed sm"
                                  onClick={() => setEscolha({
                                    cotacaoId: cotacao.id,
                                    itemId: it.id,
                                    itemDescricao: it.descricao,
                                    quantidade: it.quantidade,
                                    fornecedorId: f.fornecedor_id,
                                    fornecedorNome: f.fornecedor_nome,
                                    valor,
                                    menor: menor ? menor.valor : null,
                                    menorFornecedor: menor ? menor.fornecedorNome : '—',
                                    ehMenor: Boolean(ehMenor),
                                  })}
                                >
                                  Escolher
                                </button>
                                </small>
                              )}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr className="linha-total">
                  <td>Total da proposta</td>
                  <td className="mono">—</td>
                  {fornecedores.map((f) => {
                    const t = totalPorFornecedor.get(f.fornecedor_id);
                    return (
                      <td key={f.fornecedor_id} className="mono">
                        {t && t.cotados > 0
                          ? `${brl(t.total)} (${formatQtd(t.cotados)} de ${formatQtd(itens.length)} itens)`
                          : '—'}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </DataTable>
        )}

        <div className="nota-precisao">
          <Info size={14} />
          <span>
            O total de cada coluna soma <strong>só os itens que aquele fornecedor cotou</strong> — comparar
            duas colunas com quantidade diferente de itens não diz quem está mais barato.
          </span>
        </div>
      </div>

      {respondendo && (
        <ModalResposta
          detalhe={detalhe}
          onFechar={() => setRespondendo(false)}
          onGravada={(data) => { onAtualizar(data); setRespondendo(false); }}
        />
      )}
      {escolha && (
        <ModalEscolha
          escolha={escolha}
          onFechar={() => setEscolha(null)}
          onConfirmada={(data) => { onAtualizar(data); setEscolha(null); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A lista
// ---------------------------------------------------------------------------
export default function CotacoesPage() {
  const [situacoes, setSituacoes] = useState([]);
  const [termoDigitado, setTermoDigitado] = useState('');
  const [termoAplicado, setTermoAplicado] = useState('');
  const [cotacoes, setCotacoes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [recarregar, setRecarregar] = useState(0);

  const [detalhe, setDetalhe] = useState(null);
  const [criando, setCriando] = useState(false);
  const [fornecedores, setFornecedores] = useState([]);
  const [insumos, setInsumos] = useState([]);

  useEffect(() => {
    Promise.all([
      api.get('/fornecedores').catch(() => []),
      api.get('/insumos').catch(() => []),
    ]).then(([forns, ins]) => {
      setFornecedores(Array.isArray(forns) ? forns : []);
      setInsumos(Array.isArray(ins) ? ins : []);
    });
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (situacoes.length) p.set('situacao', situacoes.join(','));
    if (termoAplicado.trim()) p.set('busca', termoAplicado.trim());
    return p;
  }, [situacoes, termoAplicado]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`/cotacoes?${params.toString()}`)
      .then((r) => setCotacoes(Array.isArray(r) ? r : []))
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params, recarregar]);

  const tabela = useTabela(cotacoes, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'abertura', direcaoPadrao: 'desc' });

  const resumo = useMemo(() => {
    const vivas = cotacoes.filter((c) => c.situacao !== 'cancelada');
    const abertas = vivas.filter((c) => c.situacao === 'aberta');
    const hoje = hojeIso();
    const vencidas = abertas.filter((c) => c.prazo_resposta && String(c.prazo_resposta).slice(0, 10) < hoje
      && Number(c.qtd_respostas) < Number(c.qtd_convidados));
    const semNenhuma = abertas.filter((c) => Number(c.qtd_respostas) === 0);
    return {
      abertas: abertas.length,
      aguardando: abertas.reduce((s, c) => s + Math.max(0, Number(c.qtd_convidados) - Number(c.qtd_respostas)), 0),
      vencidas: vencidas.length,
      semNenhuma: semNenhuma.length,
      fechadas: vivas.filter((c) => c.situacao === 'fechada').length,
    };
  }, [cotacoes]);

  const chips = [];
  for (const s of situacoes) {
    chips.push({
      chave: `sit-${s}`,
      rotulo: 'Situação',
      valor: SITUACAO_LABEL[s] || s,
      onRemover: () => setSituacoes((a) => a.filter((x) => x !== s)),
    });
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
    setTermoAplicado('');
    setTermoDigitado('');
  }

  // O botão de limpar do CampoBusca chama onSubmit('') — o do formulário
  // chama sem argumento nenhum. Sem tratar os dois, limpar a busca aplicava o
  // termo antigo de novo.
  function aplicarBusca(valor) {
    setTermoAplicado(valor === undefined ? termoDigitado : valor);
  }

  async function abrirDetalhe(id) {
    setErro('');
    try {
      const data = await api.get(`/cotacoes/${id}`);
      setDetalhe(data);
    } catch (err) { setErro(mensagemErro(err)); }
  }

  if (detalhe) {
    return (
      <Detalhe
        detalhe={detalhe}
        onVoltar={() => { setDetalhe(null); setRecarregar((n) => n + 1); }}
        onAtualizar={setDetalhe}
      />
    );
  }

  const semNenhuma = !loading && cotacoes.length === 0;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Cotações de compra</h2>
          <p className="page-sub">
            Perguntar o preço a vários fornecedores antes de comprar, e deixar a comparação gravada.
            Sem isto, a escolha de fornecedor acontece no WhatsApp e não deixa rastro nenhum.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <button type="button" className="btn btn-primary" onClick={() => setCriando(true)}>
            <Plus size={14} /> Nova cotação
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
            Todas
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
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase="cotacoes"
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
          placeholder="Buscar por número da cotação ou descrição — e apertar Buscar"
        />
      </div>

      <ChipsFiltros itens={chips} onLimparTudo={chips.length ? limparTudo : undefined} />

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="indicadores-faixa" style={{ marginTop: 14 }}>
        <IndicadorDestaque
          destaque
          Icone={Scale}
          rotulo="Cotações abertas"
          valor={formatQtd(resumo.abertas)}
          explicacao="Cotações já enviadas e ainda esperando resposta ou decisão. Canceladas ficam de fora."
        />
        <IndicadorDestaque
          Icone={Users}
          rotulo="Propostas que faltam chegar"
          valor={formatQtd(resumo.aguardando)}
          explicacao="Soma dos convidados que ainda não responderam nas cotações abertas."
        />
        <IndicadorDestaque
          tom={resumo.vencidas > 0 ? 'atencao' : undefined}
          Icone={Clock}
          rotulo="Passaram do prazo"
          valor={formatQtd(resumo.vencidas)}
          explicacao="Cotações cujo prazo de resposta já venceu e que ainda têm convidado sem responder — é o que mais atrasa compra."
        />
        <IndicadorDestaque
          tom={resumo.semNenhuma > 0 ? 'atencao' : undefined}
          Icone={AlertTriangle}
          rotulo="Sem nenhuma resposta"
          valor={formatQtd(resumo.semNenhuma)}
          explicacao="Cotações abertas em que ninguém respondeu ainda — não dá pra comparar nada nelas."
        />
        <IndicadorDestaque
          Icone={CheckCircle2}
          rotulo="Já decididas"
          valor={formatQtd(resumo.fechadas)}
          explicacao="Cotações com vencedor escolhido. Fechada não quer dizer que já virou pedido de compra."
        />
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Cotações</div>
          <span className="page-sub" style={{ margin: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</span>
        </div>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nº</ThOrdenavel>
                <ThOrdenavel coluna="descricao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Descrição</ThOrdenavel>
                <ThOrdenavel coluna="abertura" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Abertura</ThOrdenavel>
                <ThOrdenavel coluna="prazo" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Prazo de resposta</ThOrdenavel>
                <ThOrdenavel coluna="itens" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Itens</ThOrdenavel>
                <ThOrdenavel coluna="respostas" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Convidados × responderam</ThOrdenavel>
                <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && cotacoes.length === 0 && <SkeletonLinhasTabela colunas={8} />}
              {tabela.itensPagina.map((c) => {
                const convidados = Number(c.qtd_convidados) || 0;
                const respondidos = Number(c.qtd_respostas) || 0;
                return (
                  <tr key={c.id} className="clickable-row" onClick={() => abrirDetalhe(c.id)}>
                    <td className="mono">#{c.numero}</td>
                    <td>{c.descricao || '—'}</td>
                    <td className="mono">{dataBr(String(c.data_abertura).slice(0, 10))}</td>
                    <td className="mono">{c.prazo_resposta ? dataBr(String(c.prazo_resposta).slice(0, 10)) : '—'}</td>
                    <td className="mono">{formatQtd(c.qtd_itens)}</td>
                    <td>
                      <span className="cel-dupla">
                        <strong className="mono">{formatQtd(convidados)} × {formatQtd(respondidos)}</strong>
                        <small>
                          {convidados === 0
                            ? 'nenhum fornecedor convidado'
                            : respondidos === 0
                              ? 'ninguém respondeu ainda'
                              : `${formatQtd(convidados - respondidos)} ainda sem resposta`}
                        </small>
                      </span>
                    </td>
                    <td>
                      <span className={'stamp sm ' + (SITUACAO_TONE[c.situacao] || 'tone-neutro')}>
                        {SITUACAO_LABEL[c.situacao] || c.situacao}
                      </span>
                    </td>
                    <td><ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
        {semNenhuma && (
          <EstadoVazio
            Icone={Scale}
            titulo={chips.length ? 'Nenhuma cotação com esses filtros' : 'Nenhuma cotação registrada ainda'}
            descricao={chips.length
              ? 'Os filtros que estão valendo aparecem logo acima da faixa de números — remova um deles ou limpe tudo.'
              : 'Aqui ficam as perguntas de preço feitas aos fornecedores antes de comprar, com a resposta de cada um lado a lado.'}
            onAcao={chips.length ? limparTudo : () => setCriando(true)}
            acaoLabel={chips.length ? 'Limpar filtros' : 'Nova cotação'}
            IconeAcao={chips.length ? undefined : Plus}
          />
        )}
        <Paginacao {...tabela} />
      </div>

      {criando && (
        <ModalNovaCotacao
          fornecedores={fornecedores}
          insumos={insumos}
          onFechar={() => setCriando(false)}
          onCriada={(data) => { setCriando(false); setDetalhe(data); setRecarregar((n) => n + 1); }}
        />
      )}
    </div>
  );
}
