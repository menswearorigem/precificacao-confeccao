import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Plus, X, Wallet, AlertTriangle, CalendarClock, Timer, Info, Undo2, Ban,
  Receipt, CheckCircle2, Trash2, Calculator, Split,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd, numeroBr } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio,
  IndicadorDestaque, CampoBusca, ChipsFiltros, Checkbox, Field, Select, NumInput, DateInput, Row,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { useTabela } from '../lib/useTabela';

// Contas a pagar e a receber — a mesma tela, lendo a natureza da rota.
//
// A mecânica de um título a pagar e de um a receber é idêntica (vencimento,
// retenção, rateio, baixa, estorno); o que muda é o SINAL e a contraparte. Por
// isso o backend guarda os dois na mesma tabela e esta tela é uma só: duas
// telas iguais divergem no primeiro ajuste feito em apenas uma delas.
//
// O que esta tela responde, na ordem em que se pergunta:
//   1. quanto eu devo (ou tenho a receber) que ainda não andou -> total em aberto
//   2. quanto disso já venceu                                  -> vencido
//   3. o que me cobra a atenção esta semana                    -> a vencer em 7 dias
//   4. qual é o pior atraso                                    -> maior atraso
//   5. cadê aquele título                                      -> busca + filtros + tabela
//
// REGRA 1: nada aqui recalcula preço, margem ou imposto de venda. O bruto, o
// retido e o líquido vêm prontos da view `vw_fin_titulo_saldo`.
// REGRA 2: dado que não existe aparece como "—", nunca como zero.

const BASE = '/financeiro-nucleo';

const SITUACAO_LABEL = {
  previsto: 'Previsto',
  aberto: 'Em aberto',
  parcial: 'Baixado em parte',
  liquidado: 'Liquidado',
  cancelado: 'Cancelado',
};

const SITUACAO_TONE = {
  previsto: 'tone-neutro',
  aberto: 'tone-atencao',
  parcial: 'tone-atencao',
  liquidado: 'tone-saudavel',
  cancelado: 'tone-prejuizo',
};

// O filtro de situação manda uma lista pro backend (`situacao=aberto,parcial`).
// O padrão é "ainda em aberto" porque é a pergunta de todo dia; o histórico
// completo fica a um clique.
const FILTROS_SITUACAO = [
  { valor: 'aberto,parcial,previsto', rotulo: 'Ainda em aberto' },
  { valor: 'aberto', rotulo: 'Só os firmes em aberto' },
  { valor: 'parcial', rotulo: 'Só os baixados em parte' },
  { valor: 'previsto', rotulo: 'Só as previsões' },
  { valor: 'liquidado', rotulo: 'Só os liquidados' },
  { valor: 'cancelado', rotulo: 'Só os cancelados' },
  { valor: '', rotulo: 'Todas as situações' },
];

const TRIBUTOS = [
  { valor: 'inss', rotulo: 'INSS (11% sobre facção com cessão de mão de obra)' },
  { valor: 'irrf', rotulo: 'IRRF' },
  { valor: 'iss', rotulo: 'ISS' },
  { valor: 'csrf', rotulo: 'CSRF (PIS/COFINS/CSLL)' },
  { valor: 'outros', rotulo: 'Outra retenção' },
];

const TRIBUTO_LABEL = Object.fromEntries(TRIBUTOS.map((t) => [t.valor, t.rotulo]));

function mensagemErro(err) {
  return err?.data?.error || err?.message || 'Não consegui completar a ação.';
}

function dataIso(valor) {
  return valor ? String(valor).slice(0, 10) : '';
}

function hojeIso() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function emDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function contraparteDe(t) {
  return t.fornecedor_nome || t.cliente_nome || t.contraparte_nome || '';
}

function categoriaDe(t) {
  if (!t.plano_nome) return '';
  return t.plano_codigo ? `${t.plano_codigo} · ${t.plano_nome}` : t.plano_nome;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const COLUNAS_ORDENAVEIS = {
  vencimento: (t) => dataIso(t.data_vencimento),
  contraparte: (t) => contraparteDe(t),
  descricao: (t) => t.descricao || '',
  categoria: (t) => categoriaDe(t),
  bruto: (t) => num(t.valor_bruto),
  retido: (t) => num(t.valor_retido),
  liquido: (t) => num(t.valor_liquido),
  baixado: (t) => num(t.valor_baixado),
  saldo: (t) => num(t.saldo_aberto),
  atraso: (t) => num(t.dias_atraso),
  situacao: (t) => t.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Vencimento', valor: (t) => dataBr(dataIso(t.data_vencimento)) },
  { rotulo: 'Competência', valor: (t) => dataBr(dataIso(t.data_competencia)) },
  { rotulo: 'Empresa', valor: (t) => t.empresa_nome || '' },
  { rotulo: 'Contraparte', valor: (t) => contraparteDe(t) },
  { rotulo: 'Descrição', valor: (t) => t.descricao || '' },
  { rotulo: 'Documento', valor: (t) => t.documento || '' },
  { rotulo: 'Parcela', valor: (t) => t.parcela || '' },
  { rotulo: 'Categoria', valor: (t) => categoriaDe(t) },
  { rotulo: 'Centro de custo', valor: (t) => t.centro_custo_nome || '' },
  { rotulo: 'Valor bruto', valor: (t) => brl(t.valor_bruto) },
  { rotulo: 'Retido', valor: (t) => brl(t.valor_retido) },
  { rotulo: 'Líquido', valor: (t) => brl(t.valor_liquido) },
  { rotulo: 'Baixado', valor: (t) => brl(t.valor_baixado) },
  { rotulo: 'Saldo em aberto', valor: (t) => brl(t.saldo_aberto) },
  { rotulo: 'Dias de atraso', valor: (t) => (num(t.dias_atraso) > 0 ? formatQtd(t.dias_atraso) : '—') },
  { rotulo: 'Situação', valor: (t) => SITUACAO_LABEL[t.situacao] || t.situacao },
];

// ---------------------------------------------------------------------------
// Novo título — com retenção e rateio
// ---------------------------------------------------------------------------

function ModalNovoTitulo({ natureza, empresas, plano, centros, contrapartes, onFechar, onCriado }) {
  const [empresaId, setEmpresaId] = useState(() => (empresas.length === 1 ? String(empresas[0].id) : ''));
  const [contraparteId, setContraparteId] = useState('');
  const [contraparteTexto, setContraparteTexto] = useState('');
  const [descricao, setDescricao] = useState('');
  const [documento, setDocumento] = useState('');
  const [planoId, setPlanoId] = useState('');
  const [centroId, setCentroId] = useState('');
  const [competencia, setCompetencia] = useState(hojeIso());
  const [vencimento, setVencimento] = useState(hojeIso());
  const [valorBruto, setValorBruto] = useState('');
  const [observacao, setObservacao] = useState('');
  const [retencoes, setRetencoes] = useState([]);
  const [rateios, setRateios] = useState([]);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const analiticas = plano.filter((p) => p.analitica && p.natureza !== 'transferencia');
  const bruto = num(valorBruto);

  // O valor de cada retenção: ou a pessoa digitou o valor, ou ele sai da
  // alíquota sobre o bruto. É a mesma conta que o backend faz — mostrada aqui
  // só para ninguém assinar um líquido que não esperava.
  const retido = retencoes.reduce((soma, r) => (
    soma + (r.valor !== '' && r.valor !== null ? num(r.valor) : bruto * (num(r.aliquota) / 100))
  ), 0);
  const liquido = bruto - retido;
  const somaRateio = rateios.reduce((soma, r) => soma + num(r.percentual), 0);

  function alterarRetencao(idx, patch) {
    setRetencoes((lista) => lista.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function alterarRateio(idx, patch) {
    setRateios((lista) => lista.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function salvar(e) {
    e.preventDefault();
    if (!empresaId) { setErro('Escolha a empresa (CNPJ) do título — ela decide a retenção e a guia.'); return; }
    if (!vencimento) { setErro('Informe o vencimento.'); return; }
    if (!(bruto > 0)) { setErro('Informe um valor bruto maior que zero.'); return; }
    if (retencoes.some((r) => !r.tributo)) { setErro('Toda retenção precisa dizer qual é o tributo.'); return; }

    setSalvando(true);
    setErro('');
    try {
      const corpo = {
        empresa_id: Number(empresaId),
        natureza,
        descricao: descricao.trim() || null,
        documento: documento.trim() || null,
        plano_id: planoId ? Number(planoId) : null,
        centro_custo_id: centroId ? Number(centroId) : null,
        data_competencia: competencia || null,
        data_vencimento: vencimento,
        valor_bruto: bruto,
        observacao: observacao.trim() || null,
        // Alíquota e percentual viajam como FRAÇÃO (0,11 para 11%) porque é
        // assim que o backend multiplica. A tela pede em % porque é assim que
        // se fala.
        retencoes: retencoes.map((r) => ({
          tributo: r.tributo,
          aliquota: r.aliquota === '' ? null : num(r.aliquota) / 100,
          valor: r.valor === '' ? null : num(r.valor),
        })),
        rateios: rateios.map((r) => ({
          plano_id: r.plano_id ? Number(r.plano_id) : null,
          centro_custo_id: r.centro_custo_id ? Number(r.centro_custo_id) : null,
          percentual: num(r.percentual) / 100,
        })),
      };
      if (contraparteId) {
        corpo[natureza === 'pagar' ? 'fornecedor_id' : 'cliente_id'] = Number(contraparteId);
      } else if (contraparteTexto.trim()) {
        corpo.contraparte_nome = contraparteTexto.trim();
      }
      onCriado(await api.post(`${BASE}/titulos`, corpo));
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
          <div className="card-head">{natureza === 'pagar' ? 'Novo título a pagar' : 'Novo título a receber'}</div>
          <button type="button" className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>
        <p className="page-sub">
          O título guarda o valor <strong>bruto</strong>. A retenção é filha dele e o líquido é calculado —
          gravar só o líquido faz a conciliação bancária bater e o razão do contador não fechar.
        </p>

        <div className="form-grid">
          <Field label="Empresa (CNPJ)" hint="Decide a retenção e a guia. É dimensão obrigatória do título.">
            <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
              <option value="">Escolha a empresa</option>
              {empresas.map((emp) => <option key={emp.id} value={String(emp.id)}>{emp.nome}</option>)}
            </Select>
          </Field>
          <Field
            label={natureza === 'pagar' ? 'Fornecedor' : 'Cliente'}
            hint={contrapartes.length === 0
              ? 'O cadastro não está disponível para o seu acesso — escreva o nome no campo abaixo.'
              : 'Deixe em branco quando a contraparte não é cadastrada (guia de imposto, tarifa).'}
          >
            <Select value={contraparteId} onChange={(e) => setContraparteId(e.target.value)} disabled={contrapartes.length === 0}>
              <option value="">Não cadastrada</option>
              {contrapartes.map((c) => <option key={c.id} value={String(c.id)}>{c.nome}</option>)}
            </Select>
          </Field>
          <Field label="Nome da contraparte" hint="Usado quando não há cadastro: guia de imposto, tarifa bancária, adiantamento.">
            <input
              value={contraparteTexto}
              onChange={(e) => setContraparteTexto(e.target.value)}
              disabled={Boolean(contraparteId)}
              placeholder="Ex.: Receita Federal · DAS de setembro"
            />
          </Field>
          <Field label="Descrição">
            <input value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex.: Facção — corte e costura lote 42" />
          </Field>
          <Field label="Documento" hint="Nota, boleto ou número da guia — é por ele que a busca acha o título.">
            <input value={documento} onChange={(e) => setDocumento(e.target.value)} />
          </Field>
          <Field label="Categoria do plano financeiro" hint="É ela que leva o título para o DRE. Sem categoria, o título não aparece no resultado.">
            <Select value={planoId} onChange={(e) => setPlanoId(e.target.value)}>
              <option value="">Sem categoria</option>
              {analiticas.map((p) => <option key={p.id} value={String(p.id)}>{`${p.codigo} · ${p.nome}`}</option>)}
            </Select>
          </Field>
          <Field label="Centro de custo">
            <Select value={centroId} onChange={(e) => setCentroId(e.target.value)}>
              <option value="">Sem centro de custo</option>
              {centros.map((c) => <option key={c.id} value={String(c.id)}>{c.nome}</option>)}
            </Select>
          </Field>
          <Field label="Competência" hint="Quando o fato aconteceu. É a data que o DRE usa.">
            <DateInput value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
          </Field>
          <Field label="Vencimento" hint="Quando o dinheiro deve andar. É a data que o fluxo de caixa usa.">
            <DateInput value={vencimento} onChange={(e) => setVencimento(e.target.value)} />
          </Field>
          <Field label="Valor bruto">
            <NumInput value={valorBruto} onChange={setValorBruto} suffix="R$" />
          </Field>
        </div>

        <Field label="Observação">
          <textarea rows={2} value={observacao} onChange={(e) => setObservacao(e.target.value)} />
        </Field>

        <div className="card-head-linha" style={{ marginTop: 16 }}>
          <div className="card-head">Retenções</div>
          <button type="button" className="btn btn-ghost" onClick={() => setRetencoes((l) => [...l, { tributo: 'inss', aliquota: 11, valor: '' }])}>
            <Plus size={14} /> Acrescentar retenção
          </button>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          A retenção diminui o líquido e vira obrigação com o fisco. Informe a alíquota <em>ou</em> o valor:
          com a alíquota preenchida e o valor em branco, o valor sai de alíquota × bruto.
        </p>
        {retencoes.length === 0 ? (
          <p className="page-sub">Nenhuma retenção — o líquido é igual ao bruto.</p>
        ) : (
          <DataTable>
            <table className="data-table">
              <thead>
                <tr><th>Tributo</th><th>Alíquota</th><th>Valor</th><th /></tr>
              </thead>
              <tbody>
                {retencoes.map((r, idx) => (
                  <tr key={idx}>
                    <td>
                      <Select value={r.tributo} onChange={(e) => alterarRetencao(idx, { tributo: e.target.value })}>
                        {TRIBUTOS.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
                      </Select>
                    </td>
                    <td><NumInput value={r.aliquota} onChange={(v) => alterarRetencao(idx, { aliquota: v })} suffix="%" /></td>
                    <td><NumInput value={r.valor} onChange={(v) => alterarRetencao(idx, { valor: v })} suffix="R$" /></td>
                    <td>
                      <button type="button" className="icon-btn" title="Tirar esta retenção" onClick={() => setRetencoes((l) => l.filter((_, i) => i !== idx))}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        )}

        <div className="card-head-linha" style={{ marginTop: 16 }}>
          <div className="card-head">Rateio</div>
          <button type="button" className="btn btn-ghost" onClick={() => setRateios((l) => [...l, { plano_id: '', centro_custo_id: '', percentual: '' }])}>
            <Split size={14} /> Acrescentar linha de rateio
          </button>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Um título dividido entre categorias ou centros de custo (energia, aluguel, contador). A soma tem
          que fechar com o bruto: a sobra de centavo cai na última linha, sempre.
        </p>
        {rateios.length === 0 ? (
          <p className="page-sub">Sem rateio — o título inteiro fica na categoria e no centro de custo escolhidos acima.</p>
        ) : (
          <>
            <DataTable>
              <table className="data-table">
                <thead>
                  <tr><th>Categoria</th><th>Centro de custo</th><th>Percentual</th><th>Dá em</th><th /></tr>
                </thead>
                <tbody>
                  {rateios.map((r, idx) => (
                    <tr key={idx}>
                      <td>
                        <Select value={r.plano_id} onChange={(e) => alterarRateio(idx, { plano_id: e.target.value })}>
                          <option value="">Sem categoria</option>
                          {analiticas.map((p) => <option key={p.id} value={String(p.id)}>{`${p.codigo} · ${p.nome}`}</option>)}
                        </Select>
                      </td>
                      <td>
                        <Select value={r.centro_custo_id} onChange={(e) => alterarRateio(idx, { centro_custo_id: e.target.value })}>
                          <option value="">Sem centro de custo</option>
                          {centros.map((c) => <option key={c.id} value={String(c.id)}>{c.nome}</option>)}
                        </Select>
                      </td>
                      <td><NumInput value={r.percentual} onChange={(v) => alterarRateio(idx, { percentual: v })} suffix="%" /></td>
                      <td className="mono">{bruto > 0 ? brl(bruto * (num(r.percentual) / 100)) : '—'}</td>
                      <td>
                        <button type="button" className="icon-btn" title="Tirar esta linha" onClick={() => setRateios((l) => l.filter((_, i) => i !== idx))}>
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
            {Math.abs(somaRateio - 100) > 0.009 && (
              <div className="aviso-compacto tone-atencao">
                As linhas somam {numeroBr(somaRateio, 2)}% do título. A diferença vai inteira para a última
                linha do rateio — é assim que a soma fecha com o bruto. Ajuste os percentuais se não for isso
                que você quer.
              </div>
            )}
          </>
        )}

        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">O que vai ser gravado</div>
          <Row label="Valor bruto" value={bruto > 0 ? brl(bruto) : '—'} />
          <Row label="Retido" value={retencoes.length === 0 ? '—' : brl(retido)} />
          <Row label={natureza === 'pagar' ? 'Líquido a pagar' : 'Líquido a receber'} value={bruto > 0 ? brl(liquido) : '—'} strong />
        </div>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Gravando…' : 'Gravar título'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Baixa — com a simulação de encargos vinda do servidor
// ---------------------------------------------------------------------------

function ModalBaixar({ titulo, contas, onFechar, onBaixado }) {
  const saldo = num(titulo.saldo_aberto);
  const [dataBaixa, setDataBaixa] = useState(hojeIso());
  const [contaId, setContaId] = useState(() => (contas.length === 1 ? String(contas[0].conta_id) : ''));
  const [principal, setPrincipal] = useState(saldo);
  const [juros, setJuros] = useState(0);
  const [multa, setMulta] = useState(0);
  const [desconto, setDesconto] = useState(0);
  const [tarifa, setTarifa] = useState(0);
  const [forma, setForma] = useState('');
  const [observacao, setObservacao] = useState('');
  const [multaPct, setMultaPct] = useState(2);
  const [jurosPct, setJurosPct] = useState(1);
  const [simulacao, setSimulacao] = useState(null);
  const [erroSimulacao, setErroSimulacao] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  // A simulação é do SERVIDOR de propósito: multa uma vez sobre o principal e
  // juros pro rata die, em centavos. Repetir essa conta na tela é o caminho
  // mais curto para a tela e o banco discordarem em um centavo.
  useEffect(() => {
    let vivo = true;
    const p = new URLSearchParams();
    if (dataBaixa) p.set('ate', dataBaixa);
    p.set('multa', String(num(multaPct) / 100));
    p.set('juros', String(num(jurosPct) / 100));
    setErroSimulacao('');
    api.get(`${BASE}/titulos/${titulo.id}/encargos?${p.toString()}`)
      .then((r) => { if (vivo) setSimulacao(r); })
      .catch((err) => { if (vivo) { setSimulacao(null); setErroSimulacao(mensagemErro(err)); } });
    return () => { vivo = false; };
  }, [titulo.id, dataBaixa, multaPct, jurosPct]);

  const saiDaConta = num(principal) + num(juros) + num(multa) + num(tarifa) - num(desconto);

  async function salvar(e) {
    e.preventDefault();
    if (!(num(principal) > 0)) { setErro('Informe um valor de baixa maior que zero.'); return; }
    setSalvando(true);
    setErro('');
    try {
      await api.post(`${BASE}/titulos/${titulo.id}/baixar`, {
        conta_id: contaId ? Number(contaId) : null,
        data_baixa: dataBaixa || null,
        principal: num(principal),
        juros: num(juros),
        multa: num(multa),
        desconto: num(desconto),
        tarifa: num(tarifa),
        forma_pagamento: forma.trim() || null,
        observacao: observacao.trim() || null,
      });
      onBaixado();
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
          <div className="card-head">{titulo.natureza === 'pagar' ? 'Pagar' : 'Receber'} — {titulo.descricao || contraparteDe(titulo) || `título ${titulo.id}`}</div>
          <button type="button" className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>
        <p className="page-sub">
          Saldo em aberto de <strong>{brl(saldo)}</strong>, vencendo em {dataBr(dataIso(titulo.data_vencimento))}.
          Só o <strong>principal</strong> abate o saldo do título: juros, multa, desconto e tarifa mudam
          quanto sai da conta, não quanto o título devia.
        </p>

        <div className="card">
          <div className="card-head"><Calculator size={14} /> Quanto ficaria com os encargos</div>
          <p className="grafico-explicacao">
            Multa uma vez sobre o principal e juros por dia corrido, contados do vencimento até a data da
            baixa. É uma simulação: nada é gravado até você usar os valores e confirmar.
          </p>
          <div className="form-grid">
            <Field label="Multa" hint="Percentual único sobre o saldo.">
              <NumInput value={multaPct} onChange={setMultaPct} suffix="%" />
            </Field>
            <Field label="Juros ao mês" hint="Convertidos para o dia (pro rata die) pelo servidor.">
              <NumInput value={jurosPct} onChange={setJurosPct} suffix="%" />
            </Field>
          </div>
          {erroSimulacao && <div className="aviso-compacto tone-prejuizo">{erroSimulacao}</div>}
          {!erroSimulacao && !simulacao && <p className="page-sub">Calculando…</p>}
          {simulacao && (
            <>
              <Row label="Dias de atraso até a data da baixa" value={simulacao.dias > 0 ? `${formatQtd(simulacao.dias)} dia(s)` : '—'} />
              <Row label="Multa" value={simulacao.multa ? brl(simulacao.multa) : '—'} />
              <Row label="Juros" value={simulacao.juros ? brl(simulacao.juros) : '—'} />
              <Row label="Saldo + encargos" value={brl(simulacao.total)} strong />
              {simulacao.dias === 0 ? (
                <p className="page-sub">
                  Sem atraso nesta data: não há multa nem juros a cobrar, e a simulação devolve o próprio saldo.
                </p>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setMulta(simulacao.multa); setJuros(simulacao.juros); }}
                >
                  Usar multa e juros da simulação
                </button>
              )}
            </>
          )}
        </div>

        <div className="form-grid">
          <Field label="Data da baixa" hint="É a data de caixa — a que o fluxo e o extrato usam.">
            <DateInput value={dataBaixa} onChange={(e) => setDataBaixa(e.target.value)} />
          </Field>
          <Field label="Conta" hint={contas.length === 0 ? 'Nenhuma conta cadastrada ainda.' : 'De onde o dinheiro sai (ou onde entra).'}>
            <Select value={contaId} onChange={(e) => setContaId(e.target.value)}>
              <option value="">Sem conta informada</option>
              {contas.map((c) => (
                <option key={c.conta_id} value={String(c.conta_id)}>
                  {`${c.nome}${c.empresa_nome ? ` · ${c.empresa_nome}` : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Principal" hint="O que abate o saldo. Não pode passar do saldo em aberto.">
            <NumInput value={principal} onChange={setPrincipal} suffix="R$" />
          </Field>
          <Field label="Juros">
            <NumInput value={juros} onChange={setJuros} suffix="R$" />
          </Field>
          <Field label="Multa">
            <NumInput value={multa} onChange={setMulta} suffix="R$" />
          </Field>
          <Field label="Desconto">
            <NumInput value={desconto} onChange={setDesconto} suffix="R$" />
          </Field>
          <Field label="Tarifa" hint="Tarifa bancária cobrada na operação.">
            <NumInput value={tarifa} onChange={setTarifa} suffix="R$" />
          </Field>
          <Field label="Forma de pagamento">
            <input value={forma} onChange={(e) => setForma(e.target.value)} placeholder="Ex.: Pix, boleto, transferência" />
          </Field>
        </div>

        <Field label="Observação">
          <textarea rows={2} value={observacao} onChange={(e) => setObservacao(e.target.value)} />
        </Field>

        <div className="card">
          <Row label="Sai da conta nesta baixa" value={brl(saiDaConta)} strong />
          <Row
            label="Saldo do título depois desta baixa"
            value={brl(Math.max(0, saldo - num(principal)))}
          />
        </div>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Voltar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Gravando…' : 'Confirmar baixa'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancelar (exige motivo)
// ---------------------------------------------------------------------------

function ModalCancelar({ titulo, onFechar, onCancelado }) {
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function cancelar(e) {
    e.preventDefault();
    if (!motivo.trim()) { setErro('Escreva o motivo do cancelamento.'); return; }
    setSalvando(true);
    setErro('');
    try {
      await api.post(`${BASE}/titulos/${titulo.id}/cancelar`, { motivo: motivo.trim() });
      onCancelado();
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
          <div className="card-head">Cancelar o título</div>
          <button type="button" className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>
        <p className="page-sub">
          Título cancelado sai do fluxo de caixa e do DRE e não recebe mais baixa. Ele continua na lista,
          com o motivo escrito — nada é apagado, para o histórico continuar explicando o que houve.
        </p>
        <Field label="Motivo do cancelamento (obrigatório)">
          <textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: nota cancelada pelo fornecedor; o serviço não foi prestado." />
        </Field>
        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Voltar</button>
          <button type="submit" className="btn btn-danger" disabled={salvando}>
            {salvando ? 'Cancelando…' : 'Cancelar título'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe: retenções, rateios e o histórico de baixas
// ---------------------------------------------------------------------------

function ModalDetalhe({ tituloId, onFechar, onMudou }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [estornando, setEstornando] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function carregar() {
    setErro('');
    try {
      setDados(await api.get(`${BASE}/titulos/${tituloId}`));
    } catch (err) {
      setErro(mensagemErro(err));
    }
  }

  useEffect(() => { carregar(); }, [tituloId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function estornar(e) {
    e.preventDefault();
    if (!motivo.trim()) { setErro('Escreva o motivo do estorno.'); return; }
    setSalvando(true);
    setErro('');
    try {
      await api.post(`${BASE}/baixas/${estornando.id}/estornar`, { motivo: motivo.trim() });
      setEstornando(null);
      setMotivo('');
      await carregar();
      onMudou();
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  const t = dados?.titulo;

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <div className="card viagem-modal">
        <div className="card-head-linha">
          <div className="card-head">{t ? (t.descricao || contraparteDe(t) || `Título ${t.id}`) : 'Título'}</div>
          <button type="button" className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        {!dados && !erro && <p className="page-sub">Carregando o título…</p>}

        {t && (
          <>
            <p className="page-sub">
              {contraparteDe(t) || 'Contraparte não informada'} · {t.empresa_nome || 'sem empresa'} ·
              {' '}vence em {dataBr(dataIso(t.data_vencimento))} · competência {dataBr(dataIso(t.data_competencia))}
              {t.documento && <> · documento {t.documento}</>}
              {t.parcela && <> · parcela {t.parcela}</>}
            </p>
            <div className="card">
              <Row label="Valor bruto" value={brl(t.valor_bruto)} />
              <Row label="Retido" value={num(t.valor_retido) ? brl(t.valor_retido) : '—'} />
              <Row label="Líquido" value={brl(t.valor_liquido)} />
              <Row label="Já baixado" value={num(t.valor_baixado) ? brl(t.valor_baixado) : '—'} />
              <Row label="Saldo em aberto" value={brl(t.saldo_aberto)} strong />
              <Row
                label="Dias de atraso"
                value={num(t.dias_atraso) > 0 ? `${formatQtd(t.dias_atraso)} dia(s)` : '—'}
              />
            </div>
            {t.situacao === 'cancelado' && (
              <div className="aviso-compacto tone-prejuizo">
                Cancelado{t.cancelado_em ? ` em ${dataBr(dataIso(t.cancelado_em))}` : ''}
                {t.cancelado_motivo ? `: ${t.cancelado_motivo}` : '.'}
              </div>
            )}

            <div className="card-head" style={{ marginTop: 14 }}>Retenções</div>
            {dados.retencoes.length === 0 ? (
              <p className="page-sub">Nenhuma retenção neste título — o líquido é igual ao bruto.</p>
            ) : (
              <DataTable>
                <table className="data-table">
                  <thead><tr><th>Tributo</th><th>Alíquota</th><th>Base</th><th>Valor</th></tr></thead>
                  <tbody>
                    {dados.retencoes.map((r) => (
                      <tr key={r.id}>
                        <td>{TRIBUTO_LABEL[r.tributo] || r.tributo}</td>
                        <td className="mono">{r.aliquota === null ? '—' : `${numeroBr(num(r.aliquota) * 100, 2)}%`}</td>
                        <td className="mono">{r.base_calculo === null ? '—' : brl(r.base_calculo)}</td>
                        <td className="mono">{brl(r.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}

            <div className="card-head" style={{ marginTop: 14 }}>Rateios</div>
            {dados.rateios.length === 0 ? (
              <p className="page-sub">Sem rateio: o título inteiro está na categoria e no centro de custo do cabeçalho.</p>
            ) : (
              <DataTable>
                <table className="data-table">
                  <thead><tr><th>Categoria</th><th>Centro de custo</th><th>Percentual</th><th>Valor</th></tr></thead>
                  <tbody>
                    {dados.rateios.map((r) => (
                      <tr key={r.id}>
                        <td>{r.plano_nome || '—'}</td>
                        <td>{r.centro_custo_nome || '—'}</td>
                        <td className="mono">{r.percentual === null ? '—' : `${numeroBr(num(r.percentual) * 100, 2)}%`}</td>
                        <td className="mono">{brl(r.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}

            <div className="card-head" style={{ marginTop: 14 }}>Histórico de baixas</div>
            {dados.baixas.length === 0 ? (
              <p className="page-sub">
                Nenhuma baixa ainda. Enquanto não houver baixa, o saldo em aberto é o líquido inteiro.
              </p>
            ) : (
              <DataTable>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Data</th><th>Conta</th><th>Principal</th><th>Juros</th><th>Multa</th>
                      <th>Desconto</th><th>Tarifa</th><th>Quem</th><th>Situação</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {dados.baixas.map((b) => (
                      <tr key={b.id}>
                        <td className="mono">{dataBr(dataIso(b.data_baixa))}</td>
                        <td>{b.conta_nome || '—'}</td>
                        <td className="mono">{brl(b.principal)}</td>
                        <td className="mono">{num(b.juros) ? brl(b.juros) : '—'}</td>
                        <td className="mono">{num(b.multa) ? brl(b.multa) : '—'}</td>
                        <td className="mono">{num(b.desconto) ? brl(b.desconto) : '—'}</td>
                        <td className="mono">{num(b.tarifa) ? brl(b.tarifa) : '—'}</td>
                        <td>{b.usuario_nome || '—'}</td>
                        <td>
                          {b.estorno_de_id
                            ? <span className="stamp sm tone-neutro">estorno</span>
                            : b.estornada_em
                              ? <span className="stamp sm tone-prejuizo">estornada</span>
                              : <span className="stamp sm tone-saudavel">válida</span>}
                        </td>
                        <td>
                          {!b.estorno_de_id && !b.estornada_em && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => { setEstornando(b); setMotivo(''); }}
                            >
                              <Undo2 size={13} /> Estornar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}

            {estornando && (
              <form className="card" onSubmit={estornar}>
                <div className="card-head">Estornar a baixa de {dataBr(dataIso(estornando.data_baixa))}</div>
                <p className="page-sub">
                  Estorno não apaga a baixa: grava um lançamento novo com os valores negativos, e o extrato
                  que estava conciliado com ela volta a ficar pendente. O motivo fica no histórico.
                </p>
                <Field label="Motivo do estorno (obrigatório)">
                  <textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: pagamento devolvido pelo banco; conta errada." />
                </Field>
                <div className="confirm-modal-acoes">
                  <button type="button" className="btn btn-ghost" onClick={() => setEstornando(null)}>Voltar</button>
                  <button type="submit" className="btn btn-danger" disabled={salvando}>
                    {salvando ? 'Estornando…' : 'Estornar baixa'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

export default function TitulosPage() {
  const { pathname } = useLocation();
  const natureza = pathname.endsWith('/receber') ? 'receber' : 'pagar';
  const ehPagar = natureza === 'pagar';

  const [situacao, setSituacao] = useState('aberto,parcial,previsto');
  const [empresaId, setEmpresaId] = useState('');
  const [periodo, setPeriodo] = useState({ inicio: '', fim: '' });
  const [soVencidos, setSoVencidos] = useState(false);
  const [termoDigitado, setTermoDigitado] = useState('');
  const [busca, setBusca] = useState('');

  const [titulos, setTitulos] = useState([]);
  const [empresas, setEmpresas] = useState([]);
  const [plano, setPlano] = useState([]);
  const [centros, setCentros] = useState([]);
  const [contas, setContas] = useState([]);
  const [contrapartes, setContrapartes] = useState([]);

  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [recarregar, setRecarregar] = useState(0);
  const [criando, setCriando] = useState(false);
  const [baixando, setBaixando] = useState(null);
  const [cancelando, setCancelando] = useState(null);
  const [detalheId, setDetalheId] = useState(null);

  useEffect(() => {
    api.get('/empresas').then((r) => setEmpresas(Array.isArray(r) ? r : [])).catch(() => setEmpresas([]));
    api.get(`${BASE}/plano`).then((r) => setPlano(Array.isArray(r) ? r : [])).catch(() => setPlano([]));
    api.get(`${BASE}/centros-custo`).then((r) => setCentros(Array.isArray(r) ? r : [])).catch(() => setCentros([]));
    api.get(`${BASE}/contas`).then((r) => setContas(Array.isArray(r) ? r : [])).catch(() => setContas([]));
  }, []);

  // Fornecedor mora no módulo Compras e cliente no módulo Vendas: quem só tem
  // Financeiro recebe 403 nessas rotas. Não é erro — a tela cai no campo de
  // texto livre da contraparte e diz isso no formulário.
  useEffect(() => {
    api.get(ehPagar ? '/fornecedores' : '/clientes')
      .then((r) => setContrapartes(Array.isArray(r) ? r : []))
      .catch(() => setContrapartes([]));
  }, [ehPagar]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('natureza', natureza);
    if (situacao) p.set('situacao', situacao);
    if (empresaId) p.set('empresa_id', empresaId);
    if (periodo.inicio) p.set('de', periodo.inicio);
    if (periodo.fim) p.set('ate', periodo.fim);
    if (soVencidos) p.set('vencidos', 'true');
    if (busca.trim()) p.set('busca', busca.trim());
    return p;
  }, [natureza, situacao, empresaId, periodo, soVencidos, busca]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`${BASE}/titulos?${params.toString()}`)
      .then((r) => setTitulos(Array.isArray(r) ? r : []))
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params, recarregar]);

  const tabela = useTabela(titulos, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'vencimento', direcaoPadrao: 'asc' });

  // Os quatro números da faixa. Todos saem da lista que está na tela — mudar um
  // filtro muda os números junto, e a explicação de cada cartão diz isso.
  const resumo = useMemo(() => {
    const vivos = titulos.filter((t) => t.situacao !== 'cancelado' && num(t.saldo_aberto) > 0);
    const limite = emDias(7);
    const hoje = hojeIso();
    const vencidos = vivos.filter((t) => num(t.dias_atraso) > 0);
    const proximos = vivos.filter((t) => {
      const v = dataIso(t.data_vencimento);
      return v >= hoje && v <= limite;
    });
    const pior = vivos.reduce((maior, t) => (num(t.dias_atraso) > num(maior?.dias_atraso) ? t : maior), null);
    return {
      aberto: vivos.reduce((s, t) => s + num(t.saldo_aberto), 0),
      abertoQtd: vivos.length,
      vencido: vencidos.reduce((s, t) => s + num(t.saldo_aberto), 0),
      vencidoQtd: vencidos.length,
      proximos: proximos.reduce((s, t) => s + num(t.saldo_aberto), 0),
      proximosQtd: proximos.length,
      pior: pior && num(pior.dias_atraso) > 0 ? pior : null,
    };
  }, [titulos]);

  const chips = [];
  const rotuloSituacao = FILTROS_SITUACAO.find((f) => f.valor === situacao)?.rotulo;
  if (situacao) chips.push({ chave: 'situacao', rotulo: 'Situação', valor: rotuloSituacao || situacao, onRemover: () => setSituacao('') });
  if (empresaId) {
    const emp = empresas.find((e) => String(e.id) === String(empresaId));
    chips.push({ chave: 'empresa', rotulo: 'Empresa', valor: emp?.nome || empresaId, onRemover: () => setEmpresaId('') });
  }
  if (periodo.inicio || periodo.fim) {
    chips.push({
      chave: 'periodo',
      rotulo: 'Vencimento',
      valor: `${periodo.inicio ? dataBr(periodo.inicio) : 'início'} – ${periodo.fim ? dataBr(periodo.fim) : 'hoje'}`,
      onRemover: () => setPeriodo({ inicio: '', fim: '' }),
    });
  }
  if (soVencidos) chips.push({ chave: 'vencidos', rotulo: 'Atraso', valor: 'Só os vencidos', onRemover: () => setSoVencidos(false) });
  if (busca.trim()) {
    chips.push({ chave: 'busca', rotulo: 'Busca', valor: busca.trim(), onRemover: () => { setBusca(''); setTermoDigitado(''); } });
  }

  function limparTudo() {
    setSituacao('');
    setEmpresaId('');
    setPeriodo({ inicio: '', fim: '' });
    setSoVencidos(false);
    setBusca('');
    setTermoDigitado('');
  }

  function recarregarLista() {
    setRecarregar((n) => n + 1);
  }

  const semNenhum = !loading && titulos.length === 0;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>{ehPagar ? 'Contas a pagar' : 'Contas a receber'}</h2>
          <p className="page-sub">
            {ehPagar
              ? 'Tudo que a empresa deve: facção, insumo, aluguel, guia de imposto. O título guarda o bruto; a retenção e a baixa são registros próprios, para o líquido e o razão do contador nunca discordarem.'
              : 'Tudo que a empresa tem a receber. O título guarda o bruto; a retenção e a baixa são registros próprios, para o líquido e o razão do contador nunca discordarem.'}
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <button type="button" className="btn btn-primary" onClick={() => setCriando(true)}>
            <Plus size={14} /> {ehPagar ? 'Novo título a pagar' : 'Novo título a receber'}
          </button>
        </div>
      </div>

      <div className="filtros-barra no-print">
        <PeriodoFiltro
          inicio={periodo.inicio}
          fim={periodo.fim}
          permitirTudo
          onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })}
        />
        <Select value={situacao} onChange={(e) => setSituacao(e.target.value)}>
          {FILTROS_SITUACAO.map((f) => <option key={f.valor || 'todas'} value={f.valor}>{f.rotulo}</option>)}
        </Select>
        <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
          <option value="">Todas as empresas</option>
          {empresas.map((e) => <option key={e.id} value={String(e.id)}>{e.nome}</option>)}
        </Select>
        <label className="check-linha">
          <Checkbox checked={soVencidos} onChange={(e) => setSoVencidos(e.target.checked)} />
          Só vencidos
        </label>
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase={ehPagar ? 'contas-a-pagar' : 'contas-a-receber'}
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
          onSubmit={(v) => setBusca(v === undefined ? termoDigitado : v)}
          placeholder="Buscar por descrição, documento ou nome da contraparte — e apertar Buscar"
        />
      </div>

      <ChipsFiltros itens={chips} onLimparTudo={chips.length ? limparTudo : undefined} />

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="indicadores-faixa" style={{ marginTop: 14 }}>
        <IndicadorDestaque
          destaque
          Icone={Wallet}
          rotulo={ehPagar ? 'Total em aberto a pagar' : 'Total em aberto a receber'}
          valor={resumo.abertoQtd === 0 ? '—' : brl(resumo.aberto)}
          explicacao={resumo.abertoQtd === 0
            ? 'Nenhum título com saldo em aberto neste recorte. Não é zero: é ausência de título.'
            : `Soma do saldo ainda não baixado de ${formatQtd(resumo.abertoQtd)} título(s) deste recorte. Cancelado e liquidado ficam de fora.`}
        />
        <IndicadorDestaque
          Icone={AlertTriangle}
          tom={resumo.vencidoQtd > 0 ? 'negativo' : undefined}
          rotulo="Já vencido"
          valor={resumo.vencidoQtd === 0 ? '—' : brl(resumo.vencido)}
          explicacao={resumo.vencidoQtd === 0
            ? 'Nada venceu sem ser pago neste recorte.'
            : `${formatQtd(resumo.vencidoQtd)} título(s) passaram do vencimento e ainda têm saldo. É a fila que gera juros e multa.`}
        />
        <IndicadorDestaque
          Icone={CalendarClock}
          tom={resumo.proximosQtd > 0 ? 'atencao' : undefined}
          rotulo="Vence nos próximos 7 dias"
          valor={resumo.proximosQtd === 0 ? '—' : brl(resumo.proximos)}
          explicacao={resumo.proximosQtd === 0
            ? 'Nenhum vencimento na próxima semana dentro deste recorte.'
            : `${formatQtd(resumo.proximosQtd)} título(s) vencem de hoje até daqui a sete dias. É o dinheiro que precisa estar em conta nesta semana.`}
        />
        <IndicadorDestaque
          Icone={Timer}
          tom={resumo.pior ? 'negativo' : undefined}
          rotulo="Maior atraso"
          valor={resumo.pior ? `${formatQtd(resumo.pior.dias_atraso)} dia(s)` : '—'}
          explicacao={resumo.pior
            ? `${contraparteDe(resumo.pior) || 'Sem contraparte'} · ${brl(resumo.pior.saldo_aberto)} vencidos em ${dataBr(dataIso(resumo.pior.data_vencimento))}. É o título mais antigo ainda em aberto.`
            : 'Nenhum título em atraso neste recorte — por isso não há um "pior caso" para mostrar.'}
        />
      </div>

      <div className="nota-precisao">
        <Info size={14} />
        <span>
          <strong>Bruto</strong> é o valor do documento; <strong>retido</strong> é o que fica com o fisco;{' '}
          <strong>líquido</strong> é bruto menos retido — e é sobre o líquido que a baixa acontece. Juros,
          multa e desconto de uma baixa <em>não</em> mexem no saldo do título: eles mudam quanto saiu da
          conta.
        </span>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Títulos</div>
          <span className="page-sub" style={{ margin: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</span>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Clique numa linha para ver as retenções, os rateios e o histórico de baixas do título.
        </p>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="vencimento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 110 }}>Vencimento</ThOrdenavel>
                <ThOrdenavel coluna="contraparte" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Contraparte</ThOrdenavel>
                <ThOrdenavel coluna="descricao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Descrição</ThOrdenavel>
                <ThOrdenavel coluna="categoria" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Categoria</ThOrdenavel>
                <ThOrdenavel coluna="bruto" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Bruto</ThOrdenavel>
                <ThOrdenavel coluna="retido" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Retido</ThOrdenavel>
                <ThOrdenavel coluna="liquido" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Líquido</ThOrdenavel>
                <ThOrdenavel coluna="baixado" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Baixado</ThOrdenavel>
                <ThOrdenavel coluna="saldo" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Saldo</ThOrdenavel>
                <ThOrdenavel coluna="atraso" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Atraso</ThOrdenavel>
                <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                <th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {loading && titulos.length === 0 && <SkeletonLinhasTabela colunas={12} />}
              {tabela.itensPagina.map((t) => {
                const atraso = num(t.dias_atraso);
                const podeBaixar = num(t.saldo_aberto) > 0 && t.situacao !== 'cancelado';
                return (
                  <tr key={t.id} className="clickable-row" onClick={() => setDetalheId(t.id)}>
                    <td className="mono">{dataBr(dataIso(t.data_vencimento))}</td>
                    <td>
                      <span className="cel-dupla">
                        <strong>{contraparteDe(t) || '—'}</strong>
                        {t.empresa_nome && <small>{t.empresa_nome}</small>}
                      </span>
                    </td>
                    <td>
                      <span className="cel-dupla">
                        <strong>{t.descricao || '—'}</strong>
                        {(t.documento || t.parcela) && (
                          <small>{[t.documento, t.parcela && `parcela ${t.parcela}`].filter(Boolean).join(' · ')}</small>
                        )}
                      </span>
                    </td>
                    <td>{categoriaDe(t) || '—'}</td>
                    <td className="mono">{brl(t.valor_bruto)}</td>
                    <td className="mono">{num(t.valor_retido) ? brl(t.valor_retido) : '—'}</td>
                    <td className="mono">{brl(t.valor_liquido)}</td>
                    <td className="mono">{num(t.valor_baixado) ? brl(t.valor_baixado) : '—'}</td>
                    <td className="mono">{num(t.saldo_aberto) ? brl(t.saldo_aberto) : '—'}</td>
                    <td>
                      {atraso > 0
                        ? <span className="stamp sm tone-prejuizo">{formatQtd(atraso)} dia(s)</span>
                        : <span className="mono">—</span>}
                    </td>
                    <td>
                      <span className={'stamp sm ' + (SITUACAO_TONE[t.situacao] || 'tone-neutro')}>
                        {SITUACAO_LABEL[t.situacao] || t.situacao}
                      </span>
                    </td>
                    <td className="no-print">
                      <span className="painel-acoes-inline">
                        {podeBaixar && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={(e) => { e.stopPropagation(); setBaixando(t); }}
                          >
                            <Receipt size={13} /> {ehPagar ? 'Pagar' : 'Receber'}
                          </button>
                        )}
                        {t.situacao !== 'cancelado' && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Cancelar o título"
                            onClick={(e) => { e.stopPropagation(); setCancelando(t); }}
                          >
                            <Ban size={14} />
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
        {semNenhum && (
          <EstadoVazio
            Icone={ehPagar ? Wallet : CheckCircle2}
            titulo={chips.length ? 'Nenhum título com esses filtros' : 'Nenhum título lançado ainda'}
            descricao={chips.length
              ? soVencidos
                ? 'Nada venceu sem ser pago neste recorte — é a resposta boa. Tire o filtro "só vencidos" para ver o resto.'
                : 'Os filtros que estão valendo aparecem logo acima da faixa de números — remova um deles ou limpe tudo.'
              : ehPagar
                ? 'Aqui ficam as contas a pagar: facção, insumo, aluguel, guia. Comece lançando o primeiro título.'
                : 'Aqui ficam as contas a receber. Comece lançando o primeiro título.'}
            onAcao={chips.length ? limparTudo : () => setCriando(true)}
            acaoLabel={chips.length ? 'Limpar filtros' : 'Novo título'}
            IconeAcao={chips.length ? undefined : Plus}
          />
        )}
        <Paginacao {...tabela} />
      </div>

      {criando && (
        <ModalNovoTitulo
          natureza={natureza}
          empresas={empresas}
          plano={plano}
          centros={centros}
          contrapartes={contrapartes}
          onFechar={() => setCriando(false)}
          onCriado={() => { setCriando(false); recarregarLista(); }}
        />
      )}
      {baixando && (
        <ModalBaixar
          titulo={baixando}
          contas={contas}
          onFechar={() => setBaixando(null)}
          onBaixado={() => { setBaixando(null); recarregarLista(); }}
        />
      )}
      {cancelando && (
        <ModalCancelar
          titulo={cancelando}
          onFechar={() => setCancelando(null)}
          onCancelado={() => { setCancelando(null); recarregarLista(); }}
        />
      )}
      {detalheId && (
        <ModalDetalhe
          tituloId={detalheId}
          onFechar={() => setDetalheId(null)}
          onMudou={recarregarLista}
        />
      )}
    </div>
  );
}
