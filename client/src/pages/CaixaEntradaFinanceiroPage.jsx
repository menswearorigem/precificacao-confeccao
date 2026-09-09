import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Inbox, X, AlertTriangle, Ban, Undo2, ReceiptText, Info, Clock, Split, Plus, Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd, hojeIso } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, EstadoVazio, IndicadorDestaque, CampoBusca, ChipsFiltros,
  Field, Select, NumInput, DateInput, Paginacao, ThOrdenavel, BotaoExportar,
} from '../components/ui';
import { useTabela } from '../lib/useTabela';

// Financeiro › Caixa de Entrada.
//
// A fila de trabalho do módulo: o que a operação comprometeu e o financeiro
// ainda não transformou em título.
//
// Ela existe porque a resposta certa para "a facção vai custar quanto?" nem
// sempre está disponível na hora em que a mercadoria sai. O que não podia
// continuar é a pergunta não ser feita a ninguém — que era o estado até
// 09/09/2026.
//
// Três decisões desta tela:
//
//   · NASCE SEM RECORTE DE DATA. "O que a operação comprometeu e ninguém
//     resolveu" é pergunta sem período; um filtro de mês corrente esconderia
//     justamente a pendência velha, que é a que dói.
//   · VALOR NULO APARECE COMO "—", nunca R$ 0,00. "Não sei quanto vai custar"
//     e "vai custar nada" são coisas diferentes, e a segunda faria a faixa de
//     indicadores somar zero e todo mundo dormir tranquilo (REGRA 2).
//   · DISPENSAR EXIGE MOTIVO. É a válvula legítima (a devolução que a
//     plataforma já descontou do repasse, por exemplo) — e válvula sem
//     registro é o buraco por onde todo controle vaza.

const BASE = '/financeiro-ponte';

const SITUACOES = [
  { valor: 'aberta', rotulo: 'Abertas — esperando o financeiro' },
  { valor: 'atendida', rotulo: 'Atendidas — já viraram título' },
  { valor: 'dispensada', rotulo: 'Dispensadas — com motivo escrito' },
  { valor: 'cancelada', rotulo: 'Canceladas — o documento morreu' },
  { valor: 'todas', rotulo: 'Todas' },
];

// `useTabela` recebe um MAPA chave -> extrator, não uma lista.
const COLUNAS_ORDENAVEIS = {
  documento: (p) => p.documento || '',
  origem: (p) => p.origem_rotulo || '',
  descricao: (p) => p.descricao || '',
  // Valor nulo vai para o fim da ordenação em vez de virar zero: pendência
  // sem valor não é a mais barata, é a que ninguém apurou.
  valor: (p) => (p.valor_estimado == null ? null : Number(p.valor_estimado)),
  vencimento: (p) => p.data_vencimento || '',
  parada: (p) => Number(p.dias_parada || 0),
};

const COLUNAS_EXPORTACAO = [
  { chave: 'documento', rotulo: 'Documento' },
  { chave: 'origem_rotulo', rotulo: 'Origem' },
  { chave: 'descricao', rotulo: 'Descrição' },
  { chave: 'contraparte_nome', rotulo: 'Contraparte' },
  { chave: 'valor_estimado', rotulo: 'Valor estimado' },
  { chave: 'data_competencia', rotulo: 'Competência' },
  { chave: 'data_vencimento', rotulo: 'Vencimento' },
  { chave: 'situacao', rotulo: 'Situação' },
  { chave: 'dias_parada', rotulo: 'Parada há (dias)' },
];

const num = (v) => (v == null || v === '' ? null : Number(v));
const mensagemErro = (err) => err?.data?.error || err?.message || 'Não deu para completar a ação.';
const iso = (v) => (v ? String(v).slice(0, 10) : '');

// ---------------------------------------------------------------------------
// Atender: a necessidade vira título (um, ou N parcelas irmãs)
// ---------------------------------------------------------------------------

function ModalAtender({ pendencia, plano, centros, empresas, onFechar, onFeito }) {
  const [empresaId, setEmpresaId] = useState(pendencia.empresa_id ? String(pendencia.empresa_id) : '');
  const [planoId, setPlanoId] = useState(pendencia.plano_id ? String(pendencia.plano_id) : '');
  const [centroId, setCentroId] = useState(pendencia.centro_custo_id ? String(pendencia.centro_custo_id) : '');
  const [competencia, setCompetencia] = useState(iso(pendencia.data_competencia) || hojeIso());
  const [parcelas, setParcelas] = useState([{
    valor: pendencia.valor_estimado != null ? String(pendencia.valor_estimado) : '',
    data_vencimento: iso(pendencia.data_vencimento),
  }]);
  const [reterInss, setReterInss] = useState(false);
  const [aliquota, setAliquota] = useState('11');
  const [observacao, setObservacao] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const total = parcelas.reduce((s, p) => s + (num(p.valor) || 0), 0);
  const estimado = num(pendencia.valor_estimado);
  const diverge = estimado != null && Math.abs(total - estimado) > 0.02;

  async function salvar(e) {
    e.preventDefault();
    setErro('');
    if (!empresaId) { setErro('Escolha a empresa (CNPJ). Sem ela o título não pode existir.'); return; }
    if (!planoId) { setErro('Escolha a categoria do DRE. Sem categoria o título some do relatório.'); return; }
    const limpas = parcelas
      .map((p) => ({ valor: num(p.valor), data_vencimento: p.data_vencimento }))
      .filter((p) => p.valor > 0 && p.data_vencimento);
    if (limpas.length === 0) { setErro('Informe ao menos uma parcela com valor e vencimento.'); return; }

    setSalvando(true);
    try {
      await api.post(`${BASE}/pendencias/${pendencia.id}/atender`, {
        empresa_id: Number(empresaId),
        plano_id: Number(planoId),
        centro_custo_id: centroId ? Number(centroId) : null,
        data_competencia: competencia,
        parcelas: limpas,
        observacao: observacao.trim() || null,
        retencoes: reterInss ? [{ tributo: 'inss', aliquota: (num(aliquota) || 0) / 100 }] : [],
      });
      onFeito();
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
          <div className="card-head">{pendencia.descricao}</div>
          <button type="button" className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>
        <p className="page-sub">
          {pendencia.origem_rotulo} · {pendencia.documento || 'sem documento'}
          {pendencia.contraparte_nome ? ` · ${pendencia.contraparte_nome}` : ''}
          {' — '}
          {estimado != null
            ? `a operação estimou ${brl(estimado)}.`
            : 'a operação não conseguiu estimar o valor; ele precisa ser informado aqui.'}
        </p>

        {pendencia.detalhe && (
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-head"><Info size={14} /> De onde saiu esse valor</div>
            <p className="grafico-explicacao">
              É o que o módulo de origem calculou. Serve para conferir sem precisar abrir o documento.
            </p>
            <table className="data-table">
              <tbody>
                {Object.entries(pendencia.detalhe).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ width: '40%' }}>{k.replace(/_/g, ' ')}</td>
                    <td className="mono">
                      {v == null ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="form-grid" style={{ marginTop: 16 }}>
          <Field label="Empresa (CNPJ)" hint="Dimensão obrigatória do título — os dois CNPJs têm regimes diferentes.">
            <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
              <option value="">Escolha…</option>
              {empresas.map((e) => <option key={e.id} value={String(e.id)}>{e.nome}</option>)}
            </Select>
          </Field>
          <Field label="Categoria do DRE" hint="Sem categoria o valor cai na linha “sem classificação”.">
            <Select value={planoId} onChange={(e) => setPlanoId(e.target.value)}>
              <option value="">Escolha…</option>
              {plano.filter((p) => p.analitica).map((p) => (
                <option key={p.id} value={String(p.id)}>{p.codigo} — {p.nome}</option>
              ))}
            </Select>
          </Field>
          <Field label="Centro de custo (opcional)">
            <Select value={centroId} onChange={(e) => setCentroId(e.target.value)}>
              <option value="">Sem centro de custo</option>
              {centros.map((c) => <option key={c.id} value={String(c.id)}>{c.nome}</option>)}
            </Select>
          </Field>
          <Field
            label="Competência"
            hint="Quando o fato aconteceu. É a MESMA em todas as parcelas — propagá-la junto com o vencimento transformaria o DRE num fluxo de caixa disfarçado."
          >
            {/* ⚠️ `DateInput` chama onChange com um EVENTO ({target:{value}}),
                não com a string. Passar o setter direto grava um objeto no
                estado e o campo para de funcionar sem erro nenhum. */}
            <DateInput value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
          </Field>
        </div>

        <div className="card-head-linha" style={{ marginTop: 16 }}>
          <div className="card-head"><Split size={14} /> Parcelas</div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setParcelas((l) => [...l, { valor: '', data_vencimento: '' }])}
          >
            <Plus size={13} /> Acrescentar parcela
          </button>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Cada parcela vira um título irmão, com vencimento e baixa próprios — e todas com a mesma competência.
        </p>
        <table className="data-table">
          <thead>
            <tr><th>Vencimento</th><th>Valor</th><th className="no-print" /></tr>
          </thead>
          <tbody>
            {parcelas.map((p, idx) => (
              <tr key={idx}>
                <td style={{ minWidth: 150 }}>
                  <DateInput
                    value={p.data_vencimento}
                    onChange={(e) => setParcelas((l) => l.map((x, i) => (
                      i === idx ? { ...x, data_vencimento: e.target.value } : x
                    )))}
                  />
                </td>
                <td style={{ minWidth: 140 }}>
                  <NumInput
                    value={p.valor}
                    onChange={(v) => setParcelas((l) => l.map((x, i) => (i === idx ? { ...x, valor: v } : x)))}
                  />
                </td>
                <td className="no-print">
                  {parcelas.length > 1 && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Tirar esta parcela"
                      onClick={() => setParcelas((l) => l.filter((_, i) => i !== idx))}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {diverge && (
          <div className="aviso-compacto tone-atencao">
            <AlertTriangle size={14} />
            A soma das parcelas ({brl(total)}) não bate com o que a operação estimou ({brl(estimado)}).
            Dá para gravar assim — só confira antes.
          </div>
        )}

        {pendencia.natureza === 'pagar' && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head">Retenção</div>
            <p className="grafico-explicacao">
              A regra depende da empresa tomadora, do tipo de serviço e do regime do prestador — o sistema
              não assume nenhuma. O caso recorrente desta casa é INSS de 11% sobre facção com cessão de
              mão de obra.
            </p>
            <div className="form-grid">
              <Field label="Reter INSS?">
                <Select value={reterInss ? '1' : ''} onChange={(e) => setReterInss(e.target.value === '1')}>
                  <option value="">Não reter</option>
                  <option value="1">Reter INSS</option>
                </Select>
              </Field>
              {reterInss && (
                <Field label="Alíquota (%)">
                  <NumInput value={aliquota} onChange={setAliquota} />
                </Field>
              )}
            </div>
          </div>
        )}

        <Field label="Observação (opcional)">
          <textarea rows={2} value={observacao} onChange={(e) => setObservacao(e.target.value)} />
        </Field>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Voltar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Gravando…' : `Gerar ${parcelas.length > 1 ? `${parcelas.length} títulos` : 'o título'}`}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispensar: decidir que NÃO gera título — com motivo escrito
// ---------------------------------------------------------------------------

function ModalDispensar({ pendencia, onFechar, onFeito }) {
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function salvar(e) {
    e.preventDefault();
    setErro('');
    setSalvando(true);
    try {
      await api.post(`${BASE}/pendencias/${pendencia.id}/dispensar`, { motivo: motivo.trim() });
      onFeito();
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
          <div className="card-head">Dispensar — {pendencia.descricao}</div>
          <button type="button" className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>
        <p className="page-sub">
          Dispensar é decidir que este compromisso não gera título. O caso legítimo mais comum é a
          devolução que a plataforma já descontou do repasse: gerar título ali contaria o mesmo dinheiro
          duas vezes. A pendência continua na lista, com o motivo escrito, e pode ser reaberta.
        </p>
        <Field label="Motivo (obrigatório)">
          <textarea
            rows={3}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Ex.: já descontado no repasse Shopee de 05/09; não gera pagamento próprio."
          />
        </Field>
        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Voltar</button>
          <button type="submit" className="btn btn-danger" disabled={salvando || motivo.trim().length < 5}>
            {salvando ? 'Gravando…' : 'Dispensar'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function CaixaEntradaFinanceiroPage() {
  const [pendencias, setPendencias] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [recarregar, setRecarregar] = useState(0);

  const [situacao, setSituacao] = useState('aberta');
  const [origem, setOrigem] = useState('');
  const [natureza, setNatureza] = useState('');
  const [busca, setBusca] = useState('');
  const [termoDigitado, setTermoDigitado] = useState('');

  const [origens, setOrigens] = useState([]);
  const [plano, setPlano] = useState([]);
  const [centros, setCentros] = useState([]);
  const [empresas, setEmpresas] = useState([]);

  const [atendendo, setAtendendo] = useState(null);
  const [dispensando, setDispensando] = useState(null);

  useEffect(() => {
    api.get(`${BASE}/origens`).then((r) => setOrigens(Array.isArray(r) ? r : [])).catch(() => setOrigens([]));
    api.get('/financeiro-nucleo/plano').then((r) => setPlano(Array.isArray(r) ? r : [])).catch(() => setPlano([]));
    api.get('/financeiro-nucleo/centros-custo').then((r) => setCentros(Array.isArray(r) ? r : [])).catch(() => setCentros([]));
    api.get('/empresas').then((r) => setEmpresas(Array.isArray(r) ? r : [])).catch(() => setEmpresas([]));
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('situacao', situacao);
    if (origem) p.set('origem', origem);
    if (natureza) p.set('natureza', natureza);
    if (busca.trim()) p.set('busca', busca.trim());
    return p;
  }, [situacao, origem, natureza, busca]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    Promise.all([
      api.get(`${BASE}/pendencias?${params.toString()}`),
      api.get(`${BASE}/pendencias/resumo`),
    ])
      .then(([lista, res]) => {
        setPendencias(Array.isArray(lista) ? lista : []);
        setResumo(res);
      })
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params, recarregar]);

  const recarrega = useCallback(() => setRecarregar((n) => n + 1), []);

  async function reabrir(p) {
    try {
      await api.post(`${BASE}/pendencias/${p.id}/reabrir`, {});
      recarrega();
    } catch (err) { setErro(mensagemErro(err)); }
  }

  const tabela = useTabela(pendencias, {
    colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'parada', direcaoPadrao: 'desc',
  });

  const chips = [];
  if (origem) {
    chips.push({
      chave: 'origem', rotulo: 'Origem',
      valor: origens.find((o) => o.codigo === origem)?.rotulo || origem,
      onRemover: () => setOrigem(''),
    });
  }
  if (natureza) {
    chips.push({
      chave: 'natureza', rotulo: 'Natureza',
      valor: natureza === 'pagar' ? 'A pagar' : 'A receber',
      onRemover: () => setNatureza(''),
    });
  }
  if (busca.trim()) {
    chips.push({ chave: 'busca', rotulo: 'Busca', valor: busca.trim(), onRemover: () => { setBusca(''); setTermoDigitado(''); } });
  }

  const total = resumo?.total;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Caixa de Entrada</h2>
          <p className="page-sub">
            O que a operação comprometeu e o financeiro ainda não transformou em título. Cada linha aqui é
            dinheiro que vai sair ou entrar e que já foi decidido lá fora — na facção, na compra, na
            devolução. A lista nasce sem recorte de data de propósito: pendência velha é justamente a que
            não pode se esconder atrás de um filtro de mês.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <BotaoExportar
            nomeBase="caixa-entrada-financeiro"
            colunas={COLUNAS_EXPORTACAO}
            itens={tabela.itensOrdenados}
            disabled={tabela.totalItens === 0}
          />
        </div>
      </div>

      <div className="indicadores-faixa stat-strip-fluida no-print">
        <IndicadorDestaque
          rotulo="Compromissos na fila"
          valor={total ? formatQtd(total.abertas) : '—'}
          explicacao="Necessidades registradas pelos módulos e ainda sem título. Conta todas as origens, independentemente de data."
          Icone={Inbox}
        />
        <IndicadorDestaque
          rotulo="Valor já estimado"
          valor={total ? brl(total.valor) : '—'}
          explicacao={total && total.sem_valor > 0
            ? `Soma só do que tem valor. ${formatQtd(total.sem_valor)} pendência(s) ainda sem valor não entram nesta conta — e por isso o número real é maior.`
            : 'Soma do valor estimado de todas as pendências abertas.'}
          tom={total && total.valor > 0 ? 'atencao' : undefined}
        />
        <IndicadorDestaque
          rotulo="Travando documento"
          valor={total ? formatQtd(total.travando) : '—'}
          explicacao="Pendências que impedem o fechamento do documento de origem — a ordem de produção não conclui e a venda não fatura enquanto estiverem aqui."
          tom={total && total.travando > 0 ? 'prejuizo' : undefined}
          Icone={AlertTriangle}
        />
        <IndicadorDestaque
          rotulo="Mais antiga"
          valor={resumo?.linhas?.length
            ? `${formatQtd(Math.max(...resumo.linhas.map((l) => Number(l.mais_antiga_dias || 0))))} dia(s)`
            : '—'}
          explicacao="Há quanto tempo a pendência mais velha está esperando. É o número que mede se esta fila está viva ou virou depósito."
          Icone={Clock}
        />
      </div>

      {resumo?.linhas?.length > 0 && (
        <div className="card no-print">
          <div className="card-head">De onde vem a fila</div>
          <p className="grafico-explicacao">
            Quantas pendências cada módulo deixou em aberto. Clique numa linha para filtrar a lista abaixo.
          </p>
          <DataTable>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Módulo</th><th>Origem</th><th>Abertas</th><th>Travando</th>
                  <th>Valor</th><th>Sem valor</th><th>Mais antiga</th>
                </tr>
              </thead>
              <tbody>
                {resumo.linhas.map((l) => (
                  <tr
                    key={l.origem_codigo}
                    className="clickable-row"
                    onClick={() => setOrigem(l.origem_codigo === origem ? '' : l.origem_codigo)}
                  >
                    <td>{l.modulo}</td>
                    <td>{l.origem_rotulo}</td>
                    <td className="mono">{formatQtd(l.abertas)}</td>
                    <td>
                      {Number(l.travando) > 0
                        ? <span className="stamp sm tone-prejuizo">{formatQtd(l.travando)}</span>
                        : <span className="mono">—</span>}
                    </td>
                    <td className="mono">{l.valor_aberto != null ? brl(l.valor_aberto) : '—'}</td>
                    <td className="mono">{Number(l.sem_valor) > 0 ? formatQtd(l.sem_valor) : '—'}</td>
                    <td className="mono">{l.mais_antiga_dias != null ? `${formatQtd(l.mais_antiga_dias)} d` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        </div>
      )}

      <div className="filtros-barra no-print">
        <Select value={situacao} onChange={(e) => setSituacao(e.target.value)}>
          {SITUACOES.map((s) => <option key={s.valor} value={s.valor}>{s.rotulo}</option>)}
        </Select>
        <Select value={origem} onChange={(e) => setOrigem(e.target.value)}>
          <option value="">Todas as origens</option>
          {origens.map((o) => <option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}
        </Select>
        <Select value={natureza} onChange={(e) => setNatureza(e.target.value)}>
          <option value="">A pagar e a receber</option>
          <option value="pagar">Só a pagar</option>
          <option value="receber">Só a receber</option>
        </Select>
        <CampoBusca
          valor={termoDigitado}
          onChange={setTermoDigitado}
          onSubmit={(v) => setBusca(v === '' ? '' : termoDigitado)}
          placeholder="Documento, descrição ou contraparte"
        />
      </div>
      {chips.length > 0 && (
        <ChipsFiltros
          itens={chips}
          onLimparTudo={() => { setOrigem(''); setNatureza(''); setBusca(''); setTermoDigitado(''); }}
        />
      )}

      {erro && <div className="aviso-compacto tone-prejuizo"><AlertTriangle size={14} /> {erro}</div>}

      <div className="card">
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="documento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Documento</ThOrdenavel>
                <ThOrdenavel coluna="origem" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Origem</ThOrdenavel>
                <ThOrdenavel coluna="descricao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Descrição</ThOrdenavel>
                <th>Contraparte</th>
                <ThOrdenavel coluna="valor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Valor</ThOrdenavel>
                <ThOrdenavel coluna="vencimento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Vencimento</ThOrdenavel>
                <th>O que falta</th>
                <ThOrdenavel coluna="parada" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Parada há</ThOrdenavel>
                <th className="no-print">Ação</th>
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonLinhasTabela colunas={9} />}
              {!loading && tabela.itensPagina.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="cel-dupla">
                      <strong>{p.documento || '—'}</strong>
                      <small>{p.modulo}</small>
                    </span>
                  </td>
                  <td>{p.origem_rotulo}</td>
                  <td>{p.descricao}</td>
                  <td>{p.contraparte_nome || p.fornecedor_nome || p.cliente_nome || '—'}</td>
                  <td className="mono">
                    {p.valor_estimado != null ? brl(p.valor_estimado) : <span title="A operação não conseguiu estimar. Não é zero.">—</span>}
                  </td>
                  <td className="mono">{p.data_vencimento ? dataBr(iso(p.data_vencimento)) : '—'}</td>
                  <td>
                    {p.situacao !== 'aberta'
                      ? <span className="mono">—</span>
                      : (p.faltando?.length
                        ? p.faltando.map((f) => <span key={f} className="stamp sm tone-atencao" style={{ marginRight: 4 }}>{f}</span>)
                        : <span className="stamp sm tone-saudavel">pronta para virar título</span>)}
                  </td>
                  <td className="mono">
                    {p.situacao === 'aberta' ? `${formatQtd(p.dias_parada)} d` : '—'}
                  </td>
                  <td className="no-print">
                    <span className="painel-acoes-inline">
                      {p.situacao === 'aberta' && (
                        <>
                          <button type="button" className="btn btn-ghost" onClick={() => setAtendendo(p)}>
                            <ReceiptText size={13} /> Gerar título
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => setDispensando(p)}>
                            <Ban size={13} /> Dispensar
                          </button>
                        </>
                      )}
                      {p.situacao === 'dispensada' && (
                        <button type="button" className="btn btn-ghost" onClick={() => reabrir(p)}>
                          <Undo2 size={13} /> Reabrir
                        </button>
                      )}
                      {p.situacao === 'atendida' && (
                        <span className="stamp sm tone-saudavel">
                          {formatQtd(p.titulos_gerados)} título(s) · {p.valor_atendido != null ? brl(p.valor_atendido) : '—'}
                        </span>
                      )}
                      {p.situacao === 'cancelada' && <span className="stamp sm tone-neutro">cancelada</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        {!loading && pendencias.length === 0 && (
          <EstadoVazio
            Icone={Inbox}
            titulo={situacao === 'aberta' ? 'Nada na fila' : 'Nenhuma pendência com esses filtros'}
            descricao={situacao === 'aberta'
              ? 'Nenhum módulo deixou compromisso sem destino financeiro. Se isso parecer bom demais, confira a tela de Cobertura: ela varre as tabelas de origem e mostra o que nunca chegou nem a virar pendência.'
              : 'Troque a situação ou limpe os filtros.'}
          />
        )}
        <Paginacao {...tabela} />
      </div>

      {atendendo && (
        <ModalAtender
          pendencia={atendendo}
          plano={plano}
          centros={centros}
          empresas={empresas}
          onFechar={() => setAtendendo(null)}
          onFeito={() => { setAtendendo(null); recarrega(); }}
        />
      )}
      {dispensando && (
        <ModalDispensar
          pendencia={dispensando}
          onFechar={() => setDispensando(null)}
          onFeito={() => { setDispensando(null); recarrega(); }}
        />
      )}
    </div>
  );
}
