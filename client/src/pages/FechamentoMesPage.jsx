import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarCheck, ChevronLeft, ChevronRight, ChevronDown, Plus, Lock, Unlock, Settings2, TrendingUp,
  TrendingDown, Scale, Wallet, Percent, Trash2, AlertTriangle, CheckCircle2, Info, History, ShoppingBag,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, numeroBr } from '../lib/format';
import DataTable from '../components/DataTable';
import Gaveta from '../components/Gaveta';
import {
  Field, Select, NumInput, DateInput, IndicadorDestaque, EstadoVazio, FileTypeIcon, CampoBusca, Paginacao, ThOrdenavel,
} from '../components/ui';
import { useTabela } from '../lib/useTabela';
import { CartaoGrafico, GraficoColunas, GraficoRosca, useRefGrafico } from '../components/graficos';
import '../styles/fechamento-mes.css';

// Fechamento do Mês (24/10/2026) — o resultado mensal no modelo da planilha
// do financeiro (RESULTADO_FINANCEIRO), separado em MATRIZ (Wik) e
// MARKETPLACE (Hub), com o Consolidado para a apresentação.
//
// Como a planilha: cada lançamento numa conta do plano, a conta somada no
// mês, o peso sobre a receita operacional, a média e o ideal ao lado. Regime
// de caixa — o mês é o mês em que o dinheiro andou.

const BASE = '/financeiro-fechamento';
const UNIDADES = [
  { chave: 'marketplace', rotulo: 'Marketplace' },
  { chave: 'matriz', rotulo: 'Matriz' },
  { chave: 'consolidado', rotulo: 'Consolidado' },
];
const NOME_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const COLUNAS_LANC = {
  data: (l) => l.data,
  pessoa: (l) => (l.pessoa || '').toLowerCase(),
  conta: (l) => (l.conta || l.planoNome || '').toLowerCase(),
  valor: (l) => Number(l.valor),
};
const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctTxt = (v, casas = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `${numeroBr(Number(v), casas)}%`);
const mesAtual = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function somarMes(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const rotuloMes = (mes) => `${NOME_MES[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
const rotuloMesTitulo = (mes) => { const t = rotuloMes(mes); return t.charAt(0).toUpperCase() + t.slice(1); };
const rotuloMesCurto = (mes) => `${MES_CURTO[Number(mes.slice(5, 7)) - 1]}/${mes.slice(2, 4)}`;
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const msgErro = (e) => e?.data?.error || e?.message || 'Não consegui completar a ação.';

function lerPreferencia(chave, padrao) {
  try { return window.localStorage.getItem(chave) || padrao; } catch { return padrao; }
}
function gravarPreferencia(chave, valor) {
  try { window.localStorage.setItem(chave, valor); } catch { /* sem armazenamento: só não lembra */ }
}

// Tom da diferença contra o ideal: gastar MAIS que o ideal é ruim; receber
// mais é bom. Despesa vem negativa, então "dif" negativa = gastou mais.
function tomDif(dif, receita) {
  if (dif === null || dif === undefined) return '';
  if (Math.abs(dif) < 0.05) return '';
  return (receita ? dif > 0 : dif > 0) ? 'fm-bom' : 'fm-ruim';
}

export default function FechamentoMesPage() {
  const [unidade, setUnidadeEstado] = useState(() => lerPreferencia('fm-unidade', 'marketplace'));
  const [mes, setMes] = useState(mesAtual());
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [cadastro, setCadastro] = useState(null);
  const [lancamentos, setLancamentos] = useState([]);
  const [buscaLanc, setBuscaLanc] = useState('');
  const [historico, setHistorico] = useState(null);
  const [abertos, setAbertos] = useState(() => new Set(['RECEITA OPERACIONAL']));
  const [gavetaLancar, setGavetaLancar] = useState(false);
  const [gavetaConfig, setGavetaConfig] = useState(false);
  const [recarregar, setRecarregar] = useState(0);
  const refSerie = useRefGrafico();
  const refRosca = useRefGrafico();

  const setUnidade = (u) => { setUnidadeEstado(u); gravarPreferencia('fm-unidade', u); };
  const atualizar = useCallback(() => setRecarregar((n) => n + 1), []);

  useEffect(() => { api.get(`${BASE}/cadastro`).then(setCadastro).catch(() => setCadastro(null)); }, [recarregar]);

  useEffect(() => {
    let vivo = true;
    setLoading(true);
    setErro('');
    Promise.all([
      api.get(`${BASE}?unidade=${unidade}&mes=${mes}`),
      api.get(`${BASE}/lancamentos?unidade=${unidade}&mes=${mes}`),
    ])
      .then(([d, l]) => { if (vivo) { setDados(d); setLancamentos(Array.isArray(l) ? l : []); } })
      .catch((e) => { if (vivo) setErro(msgErro(e)); })
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, [unidade, mes, recarregar]);

  useEffect(() => {
    let vivo = true;
    api.get(`${BASE}/historico?unidade=${unidade}`).then((h) => { if (vivo) setHistorico(h); }).catch(() => {});
    return () => { vivo = false; };
  }, [unidade, recarregar]);

  const r = dados?.resumo;
  const consolidado = unidade === 'consolidado';
  const fechado = Boolean(dados?.fechado);

  const alternarGrupo = (nome) => setAbertos((s) => {
    const n = new Set(s);
    if (n.has(nome)) n.delete(nome); else n.add(nome);
    return n;
  });
  const todosAbertos = dados?.dr?.length > 0 && dados.dr.every((g) => abertos.has(g.nome));

  const serieGrafico = useMemo(() => (dados?.serie || []).map((s) => ({
    rotulo: rotuloMesCurto(s.mes) + (s.temDado ? '' : ' ·'),
    receita: s.temDado ? s.receita : 0,
    resultado: s.temDado ? s.resultado : 0,
  })), [dados]);

  const composicao = useMemo(() => (dados?.dr || [])
    .filter((g) => g.nome !== 'RECEITA OPERACIONAL' && g.valor < 0)
    .map((g) => ({ rotulo: g.nome.charAt(0) + g.nome.slice(1).toLowerCase(), valor: Math.abs(g.valor) }))
    .sort((a, b) => b.valor - a.valor), [dados]);

  const lancFiltrados = useMemo(() => {
    const t = buscaLanc.trim().toLowerCase();
    if (!t) return lancamentos;
    const termos = t.split(/\s+/);
    return lancamentos.filter((l) => {
      const alvo = `${l.pessoa} ${l.conta || ''} ${l.planoNome || ''} ${l.descricao} ${l.contaBancaria || ''} ${dataBr(l.data)} ${numeroBr(Math.abs(l.valor), 2)}`.toLowerCase();
      return termos.every((x) => alvo.includes(x));
    });
  }, [lancamentos, buscaLanc]);
  const tabela = useTabela(lancFiltrados, { colunas: COLUNAS_LANC, colunaPadrao: 'data', direcaoPadrao: 'asc', prefixo: 'fm' });

  async function acao(fn, sucesso) {
    setAviso('');
    setErro('');
    try { await fn(); if (sucesso) setAviso(sucesso); atualizar(); } catch (e) { setErro(msgErro(e)); }
  }

  const fecharMes = () => acao(() => api.post(`${BASE}/mes/fechar`, { unidade, mes }), `Mês de ${rotuloMes(mes)} fechado. O saldo final já é a abertura do mês seguinte.`);
  const reabrirMes = () => acao(() => api.post(`${BASE}/mes/reabrir`, { unidade, mes }), 'Mês reaberto para ajustes.');
  const apagarLanc = (l) => acao(() => api.del(`${BASE}/lancamento/${l.tituloId}`), 'Lançamento apagado.');

  const exportarHref = `/api${BASE}/exportar.xlsx?unidade=${unidade}&mes=${mes}`;

  return (
    <div className="page-wide fm-pagina">
      <div className="pagina-topo no-print">
        <div>
          <h2>Fechamento do Mês</h2>
          <p className="page-sub">
            O resultado do mês conta a conta, no formato da planilha do financeiro: quanto entrou, o peso de cada gasto sobre a
            receita, a média e o ideal — e o saldo que passa para o mês seguinte. Pela <strong>data do pagamento</strong>.
          </p>
        </div>
      </div>

      <div className="filtros-barra no-print fm-barra">
        <div className="segmentado" role="tablist" aria-label="Unidade">
          {UNIDADES.map((u) => (
            <button key={u.chave} type="button" role="tab" aria-selected={unidade === u.chave}
              className={unidade === u.chave ? 'ativo' : undefined} onClick={() => setUnidade(u.chave)}>
              {u.rotulo}
            </button>
          ))}
        </div>
        <div className="fm-mes">
          <button type="button" className="icon-btn" title="Mês anterior" aria-label="Mês anterior" onClick={() => setMes((m) => somarMes(m, -1))}><ChevronLeft size={16} /></button>
          <label className="fm-mes-rotulo">
            <span>{rotuloMesTitulo(mes)}</span>
            <input type="month" value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} aria-label="Escolher mês" />
          </label>
          <button type="button" className="icon-btn" title="Próximo mês" aria-label="Próximo mês" onClick={() => setMes((m) => somarMes(m, 1))}><ChevronRight size={16} /></button>
          {fechado && <span className="stamp sm tone-saudavel"><Lock size={11} /> fechado</span>}
        </div>
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <button type="button" className="btn btn-ghost" onClick={() => setGavetaConfig(true)}><Settings2 size={14} /> Fatias e metas</button>
          <a className="btn btn-ghost" href={exportarHref}><FileTypeIcon extensao="xlsx" size={18} /> Excel</a>
          {!consolidado && (fechado
            ? <button type="button" className="btn btn-ghost" onClick={reabrirMes}><Unlock size={14} /> Reabrir mês</button>
            : <button type="button" className="btn btn-ghost" onClick={fecharMes}><Lock size={14} /> Fechar mês</button>)}
          {!consolidado && (
            <button type="button" className="btn btn-primary" onClick={() => setGavetaLancar(true)} disabled={fechado}
              title={fechado ? 'Mês fechado — reabra para lançar' : undefined}>
              <Plus size={14} /> Lançar
            </button>
          )}
        </div>
      </div>

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      {aviso && <div className="aviso-compacto tone-saudavel"><CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{aviso}</div>}
      {dados?.mudouDepoisDeFechar !== null && dados?.mudouDepoisDeFechar !== undefined && (
        <div className="aviso-compacto tone-atencao">
          <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          Este mês foi fechado com resultado de <strong>{brl(dados.foto.resultado)}</strong>, mas os lançamentos de hoje somam{' '}
          <strong>{brl(num(dados.foto.resultado) + num(dados.mudouDepoisDeFechar))}</strong> — alguém mexeu em lançamento de mês
          fechado (diferença de {brl(dados.mudouDepoisDeFechar)}). O saldo levado adiante continua o da foto do fechamento.
        </div>
      )}

      {r && (
        <div className="indicadores-faixa fm-indicadores">
          <IndicadorDestaque destaque Icone={TrendingUp} rotulo="Receita operacional"
            valor={r.temDado ? brl(r.receita) : '—'}
            variacao={r.mediaReceita ? `média ${brl(r.mediaReceita)} · ${r.mesesNaMedia} ${r.mesesNaMedia === 1 ? 'mês' : 'meses'}` : undefined}
            explicacao={unidade === 'marketplace'
              ? 'O que as plataformas liberaram de venda no mês, menos as devoluções.'
              : 'Vendas e recebimentos operacionais que entraram no caixa no mês.'} />
          <IndicadorDestaque Icone={TrendingDown} rotulo="Saiu no mês" valor={r.temDado ? brl(r.saidas) : '—'}
            explicacao="Tudo que saiu do caixa no mês, de todas as contas (inclui investimentos, retiradas e adiantamentos)." />
          <IndicadorDestaque Icone={Scale} rotulo="Lucro operacional"
            tom={r.lucroOperacional > 0 ? 'positivo' : r.lucroOperacional < 0 ? 'negativo' : undefined}
            valor={r.temDado ? brl(r.lucroOperacional) : '—'}
            variacao={r.margemOperacional !== null ? `${pctTxt(r.margemOperacional)} da receita` : undefined}
            explicacao="Receita operacional menos pessoal, administrativas, produção e vendas. Calculado sozinho — não precisa montar à mão." />
          <IndicadorDestaque Icone={Wallet} rotulo="Resultado do caixa"
            tom={r.resultado > 0 ? 'positivo' : r.resultado < 0 ? 'negativo' : undefined}
            valor={r.temDado ? brl(r.resultado) : '—'}
            explicacao="O Total geral da DR: tudo que entrou menos tudo que saiu no mês." />
          <IndicadorDestaque Icone={CalendarCheck} rotulo="Saldo do mês"
            valor={r.saldoFinal === null ? '—' : brl(r.saldoFinal)}
            variacao={r.saldoInicial === null ? 'falta o saldo de abertura' : `abriu com ${brl(r.saldoInicial)}`}
            explicacao="Saldo de abertura + resultado do caixa. Vira a abertura do mês seguinte." />
          <IndicadorDestaque Icone={Percent} rotulo="Custo fixo"
            tom={r.custoFixoPct !== null && r.custoFixoIdeal !== null ? (r.custoFixoPct > r.custoFixoIdeal ? 'negativo' : 'positivo') : undefined}
            valor={pctTxt(r.custoFixoPct, 2)}
            variacao={r.custoFixoIdeal !== null ? `ideal ${pctTxt(r.custoFixoIdeal, 2)} · média ${pctTxt(r.custoFixoMedio, 2)}` : `média ${pctTxt(r.custoFixoMedio, 2)}`}
            explicacao="(Pessoal + administrativas) ÷ receita operacional — a aba CUSTO FIXO da planilha." />
        </div>
      )}

      {dados && r?.saldoInicial === null && !consolidado && !fechado && (
        <SaldoAbertura unidade={unidade} mes={mes} registro={dados.mesRegistro} onSalvo={() => acao(async () => {}, 'Saldo de abertura gravado.')} onErro={setErro} />
      )}
      {dados && r?.saldoInicial === null && consolidado && (
        <div className="aviso-compacto tone-atencao">
          <Info size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          O saldo do Consolidado aparece quando as duas unidades tiverem o saldo de abertura informado.
        </div>
      )}

      {dados?.aClassificar?.length > 0 && (
        <AClassificar itens={dados.aClassificar} cadastro={cadastro} onLigar={(planoId, contaId) => acao(() => api.put(`${BASE}/plano/${planoId}/conta`, { conta_id: contaId }), 'Conta ligada. Daqui para frente ela cai no lugar certo sozinha.')} />
      )}

      <div className="fm-graficos">
        <CartaoGrafico titulo="Últimos 12 meses" refGrafico={refSerie} altura={250}
          explicacao="Receita operacional e resultado do caixa de cada mês. Mês marcado com · não tem nenhum lançamento — não é zero, é sem dado."
          vazio={serieGrafico.every((s) => !s.receita && !s.resultado) ? 'Nenhum movimento nos últimos 12 meses.' : null}
          legenda={[{ rotulo: 'Receita operacional', cor: 'var(--success)' }, { rotulo: 'Resultado do caixa', cor: 'var(--brass)' }]}>
          <GraficoColunas dados={serieGrafico} comZero altura={250} intervaloX="preserveStartEnd"
            series={[{ chave: 'receita', nome: 'Receita operacional', cor: 'var(--success)' }, { chave: 'resultado', nome: 'Resultado do caixa', cor: 'var(--brass)' }]} />
        </CartaoGrafico>
        <CartaoGrafico titulo="Para onde o dinheiro foi" refGrafico={refRosca} altura={250}
          explicacao="As saídas do mês por grupo da planilha."
          vazio={composicao.length === 0 ? 'Nenhuma saída neste mês.' : null}>
          <GraficoRosca dados={composicao} altura={250} totalRotulo="Saídas" />
        </CartaoGrafico>
      </div>

      {dados && (
        <div className="card">
          <div className="card-head-linha">
            <div className="card-head">Demonstração do resultado · {rotuloMes(mes)}</div>
            <button type="button" className="btn btn-ghost sm" onClick={() => setAbertos(todosAbertos ? new Set() : new Set(dados.dr.map((g) => g.nome)))}>
              {todosAbertos ? 'Recolher contas' : 'Abrir todas as contas'}
            </button>
          </div>
          <p className="page-sub" style={{ marginTop: 0 }}>
            Clique no grupo para ver as contas. % é sobre a receita operacional do mês; a média é dos últimos {r?.mesesNaMedia || 0}{' '}
            {r?.mesesNaMedia === 1 ? 'mês' : 'meses'} com movimento; o ideal vem do orçamento.
            {r?.mesesNaMedia > 0 && r?.mesesNaMedia < 12 && ' Menos de 12 meses de histórico: a média ainda é curta.'}
          </p>
          {dados.dr.length === 0 ? (
            <EstadoVazio Icone={Scale} titulo="Nenhum lançamento neste mês"
              descricao={unidade === 'marketplace'
                ? 'Lance as contas do marketplace no botão Lançar. A venda liberada pelas plataformas entra sozinha quando o extrato estiver sincronizado.'
                : 'Os lançamentos da Matriz vêm do Wik. Se o mês deveria ter movimento, confira a sincronização do financeiro do Wik.'} />
          ) : (
            <DataTable>
              <table className="data-table fm-dr">
                <thead>
                  <tr>
                    <th>Conta</th>
                    <th className="num">Valor</th>
                    <th className="num">%</th>
                    <th className="num">Média</th>
                    <th className="num">% média</th>
                    <th className="num">Ideal</th>
                    <th className="num">Dif.</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.dr.map((g) => {
                    const aberto = abertos.has(g.nome);
                    const receita = g.nome.startsWith('RECEITA') || g.nome.startsWith('ENTRADA') || g.nome === 'TRANSITÓRIO ENTRADA';
                    return (
                      <Fragment key={g.nome}>
                        <tr className={`linha-total fm-grupo${g.operacional ? '' : ' fm-grupo-nao-op'}`} onClick={() => alternarGrupo(g.nome)}>
                          <td>
                            <span className="fm-grupo-nome">
                              <ChevronDown size={14} className={aberto ? 'fm-seta aberta' : 'fm-seta'} />
                              <strong>{g.nome}</strong>
                              <small>{g.itens.length} {g.itens.length === 1 ? 'conta' : 'contas'}</small>
                            </span>
                          </td>
                          <td className={`mono num ${g.valor < 0 ? 'fm-neg' : ''}`}>{brl(g.valor)}</td>
                          <td className="mono num">{pctTxt(g.pct, 2)}</td>
                          <td className="mono num fm-suave">{brl(g.media)}</td>
                          <td className="mono num fm-suave">{pctTxt(g.pctMedia, 2)}</td>
                          <td className="mono num fm-suave">{pctTxt(g.ideal, 2)}</td>
                          <td className={`mono num ${tomDif(g.dif, receita)}`}>{g.dif === null ? '—' : `${g.dif > 0 ? '+' : ''}${numeroBr(g.dif, 2)}`}</td>
                        </tr>
                        {aberto && g.itens.map((i) => (
                          <tr key={i.contaId} className="fm-conta">
                            <td>{i.nome}</td>
                            <td className={`mono num ${i.valor < 0 ? 'fm-neg' : ''}`}>{Math.abs(i.valor) < 0.005 ? '—' : brl(i.valor)}</td>
                            <td className="mono num">{Math.abs(i.valor) < 0.005 ? '—' : pctTxt(i.pct, 2)}</td>
                            <td className="mono num fm-suave">{Math.abs(i.media) < 0.005 ? '—' : brl(i.media)}</td>
                            <td className="mono num fm-suave">{Math.abs(i.media) < 0.005 ? '—' : pctTxt(i.pctMedia, 2)}</td>
                            <td className="mono num fm-suave">{pctTxt(i.ideal, 2)}</td>
                            <td className={`mono num ${tomDif(i.dif, receita)}`}>{i.dif === null ? '—' : `${i.dif > 0 ? '+' : ''}${numeroBr(i.dif, 2)}`}</td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                  {dados.aClassificar.length > 0 && (
                    <tr className="linha-total fm-grupo-alerta">
                      <td><strong>A CLASSIFICAR</strong></td>
                      <td className="mono num">{brl(dados.aClassificar.reduce((s, c) => s + c.valor, 0))}</td>
                      <td colSpan={5} className="fm-suave">contas que ainda não têm lugar no plano — veja o aviso acima</td>
                    </tr>
                  )}
                  <tr className="linha-total fm-total">
                    <td><strong>= LUCRO OPERACIONAL</strong></td>
                    <td className="mono num">{brl(r.lucroOperacional)}</td>
                    <td className="mono num">{pctTxt(r.margemOperacional, 2)}</td>
                    <td colSpan={4} className="fm-suave">receita − pessoal − administrativas − produção − vendas</td>
                  </tr>
                  <tr className="linha-total fm-total">
                    <td><strong>= TOTAL GERAL (resultado do caixa)</strong></td>
                    <td className="mono num">{brl(r.resultado)}</td>
                    <td className="mono num">{pctTxt(r.receita > 0 ? (r.resultado / r.receita) * 100 : null, 2)}</td>
                    <td className="mono num fm-suave">{brl(r.mediaResultado)}</td>
                    <td colSpan={3} />
                  </tr>
                </tbody>
              </table>
            </DataTable>
          )}
        </div>
      )}

      {dados && (
        <div className="fm-duas">
          <Vendas vendas={dados.vendas} unidade={unidade} />
          <Posicao dados={dados} unidade={unidade} mes={mes} fechado={fechado} onSalvar={(posicao) => acao(() => api.put(`${BASE}/mes`, {
            unidade, mes, posicao,
            saldo_inicial: dados.mesRegistro?.saldoInicialInformado ?? null,
            observacao: dados.mesRegistro?.observacao ?? null,
          }), 'Posição do fim do mês gravada.')} />
        </div>
      )}

      {dados && unidade !== 'matriz' && (dados.extrato || dados.foraDoResultado?.length > 0) && (
        <Conferencia extrato={dados.extrato} fora={dados.foraDoResultado} />
      )}

      {historico && <Historico historico={historico} mesAtivo={mes} onEscolher={setMes} />}

      {dados && (
        <div className="card">
          <div className="card-head-linha">
            <div className="card-head">Lançamentos do mês · {lancamentos.length}</div>
            <div className="fm-busca"><CampoBusca valor={buscaLanc} onChange={setBuscaLanc} placeholder="Buscar pessoa, conta, valor, data…" /></div>
          </div>
          <p className="page-sub" style={{ marginTop: 0 }}>
            A aba FLUXO DE CAIXA: cada pagamento e recebimento do mês na conta do plano.
            {unidade !== 'matriz' && ' No Marketplace entram também o extrato das plataformas e as fatias assumidas da Matriz.'}
          </p>
          {lancFiltrados.length === 0 ? (
            <p className="page-sub">{lancamentos.length === 0 ? 'Nenhum lançamento neste mês.' : 'Nada encontrado com essa busca.'}</p>
          ) : (
            <>
            <Paginacao {...tabela} posicao="topo" />
            <DataTable>
              <table className="data-table">
                <thead>
                  <tr>
                    <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 110 }}>Data</ThOrdenavel>
                    <ThOrdenavel coluna="pessoa" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Pessoa</ThOrdenavel>
                    <ThOrdenavel coluna="conta" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Conta</ThOrdenavel>
                    <th>Origem</th>
                    <ThOrdenavel coluna="valor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Valor</ThOrdenavel>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tabela.itensPagina.map((l, idx) => (
                    <tr key={`${l.tipo}-${l.baixaId || l.extratoId}-${l.unidade}-${idx}`}>
                      <td className="mono">{dataBr(l.data)}</td>
                      <td>
                        <span className="cel-dupla">
                          <strong>{l.pessoa || '—'}</strong>
                          {l.descricao && l.descricao !== l.conta && <small>{l.descricao}</small>}
                        </span>
                      </td>
                      <td>
                        <span className="cel-dupla">
                          {l.conta ? <span>{l.conta}</span> : <span className="fm-ruim">A classificar · {l.planoNome || 'sem conta'}</span>}
                          {l.grupo && <small>{l.grupo.toLowerCase()}</small>}
                        </span>
                      </td>
                      <td><OrigemSelo l={l} consolidado={consolidado} /></td>
                      <td className={`mono num ${l.valor < 0 ? 'fm-neg' : 'fm-pos'}`}>{brl(l.valor)}</td>
                      <td>
                        {l.rapido && l.tipo !== 'fatia' && !fechado && (
                          <button type="button" className="icon-btn" title="Apagar lançamento" aria-label="Apagar lançamento" onClick={() => apagarLanc(l)}><Trash2 size={14} /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
            <Paginacao {...tabela} />
            </>
          )}
        </div>
      )}

      <GavetaLancar aberta={gavetaLancar} onFechar={() => setGavetaLancar(false)} unidade={consolidado ? 'marketplace' : unidade}
        mes={mes} cadastro={cadastro} onLancado={(t) => { setAviso(t); atualizar(); }} />
      <GavetaConfig aberta={gavetaConfig} onFechar={() => setGavetaConfig(false)} cadastro={cadastro}
        onSalvo={(t) => { setAviso(t); atualizar(); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function OrigemSelo({ l, consolidado }) {
  let texto = 'Hub';
  let tom = 'tone-neutro';
  if (l.tipo === 'extrato') { texto = 'Extrato'; tom = 'tone-elevada'; }
  else if (l.tipo === 'fatia') { texto = `Fatia ${numeroBr(l.fatia, 0)}%`; tom = 'tone-atencao'; }
  else if (l.doWik) { texto = 'Wik'; tom = 'tone-neutro'; }
  else if (l.rapido) { texto = 'Lançado aqui'; tom = 'tone-saudavel'; }
  return (
    <span className="fm-origem">
      <span className={`stamp sm ${tom}`}>{texto}</span>
      {consolidado && <small>{l.unidade === 'matriz' ? 'Matriz' : 'Marketplace'}</small>}
    </span>
  );
}

function SaldoAbertura({ unidade, mes, registro, onSalvo, onErro }) {
  const [valor, setValor] = useState(registro?.saldoInicialInformado ?? null);
  const [salvando, setSalvando] = useState(false);
  async function salvar() {
    setSalvando(true);
    try {
      await api.put(`${BASE}/mes`, { unidade, mes, saldo_inicial: valor, posicao: registro?.posicao || {}, observacao: registro?.observacao ?? null });
      onSalvo();
    } catch (e) { onErro(msgErro(e)); } finally { setSalvando(false); }
  }
  return (
    <div className="card fm-saldo-abertura">
      <div>
        <strong>Falta o saldo de abertura</strong>
        <p className="page-sub" style={{ margin: '2px 0 0' }}>
          Informe quanto havia em caixa no começo de {rotuloMes(mes)}. É preciso só uma vez: daqui para frente cada mês abre com o
          saldo final do anterior.
        </p>
      </div>
      <div className="fm-saldo-campo">
        <NumInput value={valor} onChange={setValor} suffix="R$" />
        <button type="button" className="btn btn-primary" onClick={salvar} disabled={salvando || valor === null}>Gravar</button>
      </div>
    </div>
  );
}

function AClassificar({ itens, cadastro, onLigar }) {
  const [escolha, setEscolha] = useState({});
  return (
    <div className="card fm-classificar">
      <div className="card-head">A classificar · {itens.length}</div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Estes valores entraram no caixa, mas a conta deles não existe no plano da planilha. Eles <strong>estão</strong> no resultado
        (na linha A CLASSIFICAR) — ligue cada um a uma conta para irem ao grupo certo. A ligação vale para sempre.
      </p>
      <table className="data-table">
        <tbody>
          {itens.map((c) => (
            <tr key={c.nome}>
              <td><strong>{c.nome}</strong></td>
              <td className={`mono num ${c.valor < 0 ? 'fm-neg' : ''}`}>{brl(c.valor)}</td>
              <td style={{ width: 320 }}>
                {c.planoId ? (
                  <Select value={escolha[c.planoId] || ''} onChange={(e) => setEscolha((s) => ({ ...s, [c.planoId]: e.target.value }))} placeholder="Escolha a conta">
                    {(cadastro?.grupos || []).map((g) => (
                      <optgroup key={g} label={g}>
                        {(cadastro?.contas || []).filter((x) => x.grupo === g).map((x) => <option key={x.id} value={String(x.id)}>{x.nome}</option>)}
                      </optgroup>
                    ))}
                  </Select>
                ) : <span className="page-sub">tipo do extrato sem conta — avise para incluir na regra</span>}
              </td>
              <td style={{ width: 90 }}>
                {c.planoId && <button type="button" className="btn btn-ghost sm" disabled={!escolha[c.planoId]} onClick={() => onLigar(c.planoId, Number(escolha[c.planoId]))}>Ligar</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Vendas({ vendas, unidade }) {
  const linhas = vendas && !vendas.erro ? [
    ['Faturamento', brl(vendas.faturamento)],
    ['Vendas (pedidos)', formatQtd(vendas.pedidos)],
    ['Peças', formatQtd(vendas.pecas)],
    ['Preço médio', vendas.precoMedio === null ? '—' : brl(vendas.precoMedio)],
    ['Ticket médio (R$)', vendas.ticketReais === null ? '—' : brl(vendas.ticketReais)],
    ['Ticket médio (peças)', vendas.ticketPecas === null ? '—' : numeroBr(vendas.ticketPecas, 1)],
  ] : [];
  return (
    <div className="card">
      <div className="card-head"><ShoppingBag size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Vendas do mês</div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Pela data do pedido{unidade === 'marketplace' ? ', só marketplace' : unidade === 'matriz' ? ', vendas que não são de marketplace (inclui as do Wik)' : ''}.
        O lucro é o da Lucratividade do Hub: venda menos custo das peças, taxas, frete e Ads.
      </p>
      {vendas?.erro && <div className="aviso-compacto tone-atencao">Não consegui calcular as vendas: {vendas.erro}</div>}
      {!vendas?.erro && vendas && (
        <>
          <dl className="fm-lista">
            {linhas.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{v}</dd></Fragment>)}
          </dl>
          <div className={`fm-lucro ${vendas.pedidos === 0 ? '' : vendas.lucro >= 0 ? 'fm-lucro-pos' : 'fm-lucro-neg'}`}>
            <span>Lucro das vendas</span>
            <strong className="mono">{brl(vendas.lucro)}</strong>
            <small>{vendas.margem === null ? 'sem venda no mês' : `${pctTxt(vendas.margem)} de margem`}</small>
          </div>
          {vendas.pedidosSemCusto > 0 && (
            <p className="page-sub">{vendas.pedidosSemCusto} pedido(s) sem custo completo ficaram fora do lucro.</p>
          )}
        </>
      )}
    </div>
  );
}

function Posicao({ dados, unidade, fechado, onSalvar }) {
  const p = dados.posicao;
  const [editando, setEditando] = useState(false);
  const [valores, setValores] = useState({});
  useEffect(() => {
    const v = {};
    for (const l of p.linhas) if (!l.automatico) v[l.chave] = l.atual;
    setValores(v);
    setEditando(false);
  }, [dados]); // eslint-disable-line react-hooks/exhaustive-deps
  const podeEditar = unidade !== 'consolidado' && !fechado;
  return (
    <div className="card">
      <div className="card-head-linha">
        <div className="card-head">Posição no fim do mês</div>
        {podeEditar && !editando && <button type="button" className="btn btn-ghost sm" onClick={() => setEditando(true)}>Informar estoques</button>}
      </div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        A aba SALDOS. Pagar e receber saem dos títulos sozinhos; estoques e aplicações são informados no fechamento.
      </p>
      <table className="data-table fm-posicao">
        <thead><tr><th>Conta</th><th className="num">Anterior</th><th className="num">Atual</th><th className="num">Variação</th></tr></thead>
        <tbody>
          {p.linhas.map((l) => (
            <tr key={l.chave}>
              <td>{l.rotulo}{!l.automatico && <small className="fm-suave"> · informado</small>}</td>
              <td className="mono num fm-suave">{l.anterior === null ? '—' : brl(l.anterior)}</td>
              <td className="mono num">
                {editando && !l.automatico
                  ? <NumInput value={valores[l.chave]} onChange={(v) => setValores((s) => ({ ...s, [l.chave]: v }))} suffix="R$" />
                  : (l.atual === null ? '—' : brl(l.atual))}
              </td>
              <td className={`mono num ${l.variacao < 0 ? 'fm-neg' : ''}`}>{l.variacao === null ? '—' : brl(l.variacao)}</td>
            </tr>
          ))}
          <tr className="linha-total">
            <td><strong>Total geral</strong></td>
            <td className="mono num">{p.totalAnterior === null ? '—' : brl(p.totalAnterior)}</td>
            <td className="mono num">{p.totalAtual === null ? '—' : brl(p.totalAtual)}</td>
            <td className="mono num">{p.variacao === null ? '—' : brl(p.variacao)}</td>
          </tr>
        </tbody>
      </table>
      {editando && (
        <div className="fm-acoes-dir">
          <button type="button" className="btn btn-ghost" onClick={() => setEditando(false)}>Cancelar</button>
          <button type="button" className="btn btn-primary" onClick={() => onSalvar(valores)}>Gravar posição</button>
        </div>
      )}
    </div>
  );
}

function Conferencia({ extrato, fora }) {
  const lojas = Array.isArray(extrato) ? extrato.filter((l) => l.linhas > 0 || l.saldoFinal !== null) : [];
  return (
    <div className="card">
      <div className="card-head">Conferência do caixa das plataformas</div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        A conciliação independente do Wik: em cada loja, saldo inicial + tudo que entrou e saiu tem que dar o saldo final do extrato,
        no centavo. Saque, Pix e maquininha passam pela conta mas não são resultado — ficam aqui para conferir se cada Pix pago foi lançado.
      </p>
      {extrato?.erro && <div className="aviso-compacto tone-atencao">Não consegui conferir o extrato: {extrato.erro}</div>}
      {lojas.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Loja</th><th className="num">Saldo inicial</th><th className="num">Saldo final</th><th>Conferência</th></tr></thead>
          <tbody>
            {lojas.map((l) => (
              <tr key={l.loja}>
                <td><strong>{l.loja}</strong></td>
                <td className="mono num">{l.saldoInicial === null ? '—' : brl(l.saldoInicial)}</td>
                <td className="mono num">{l.saldoFinal === null ? '—' : brl(l.saldoFinal)}</td>
                <td>
                  {l.fechado === true && <span className="stamp sm tone-saudavel">fecha no centavo</span>}
                  {l.fechado === false && <span className="stamp sm tone-prejuizo">não fecha · {brl(l.diferenca)}</span>}
                  {l.fechado === null && <span className="stamp sm tone-neutro">{l.marketplace === 'tiktok_shop' ? 'conferido por repasse' : 'sem saldo no extrato'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {fora?.length > 0 && (
        <dl className="fm-lista fm-fora">
          {fora.map((x) => (
            <Fragment key={x.tipo}><dt>{x.rotulo} <small>({x.qtd})</small></dt><dd className={`mono ${x.valor < 0 ? 'fm-neg' : ''}`}>{brl(x.valor)}</dd></Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

function Historico({ historico, mesAtivo, onEscolher }) {
  const anos = historico.anos.slice().reverse();
  return (
    <div className="card">
      <div className="card-head"><History size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Histórico · desde {historico.de.slice(5, 7)}/{historico.de.slice(0, 4)}</div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Resultado do caixa de cada mês. Cinza = mês sem nenhum lançamento (sem dado, não zero). Clique num mês para abrir.
      </p>
      <div className="fm-hist">
        {anos.map((a) => (
          <div key={a.ano} className="fm-hist-ano">
            <div className="fm-hist-topo">
              <strong>{a.ano}</strong>
              <span className="fm-suave">
                {a.mesesComDado ? `${a.mesesComDado} ${a.mesesComDado === 1 ? 'mês' : 'meses'} · receita média ${brl(a.mediaReceita)} · resultado ${brl(a.resultado)}` : 'sem dado'}
              </span>
            </div>
            <div className="fm-hist-meses">
              {a.meses.map((m) => (
                <button key={m.mes} type="button" disabled={m.futuro}
                  className={`fm-hist-mes${m.temDado ? (m.resultado >= 0 ? ' pos' : ' neg') : ' vazio'}${m.mes === mesAtivo ? ' ativo' : ''}`}
                  title={m.temDado ? `${rotuloMes(m.mes)}: resultado ${brl(m.resultado)} · receita ${brl(m.receita)}` : `${rotuloMes(m.mes)}: sem dado`}
                  onClick={() => onEscolher(m.mes)}>
                  <span>{MES_CURTO[Number(m.mes.slice(5, 7)) - 1]}</span>
                  <small className="mono">{m.temDado ? compacto(m.resultado) : '—'}</small>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function compacto(v) {
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e6) return `${s}${numeroBr(a / 1e6, 1)} mi`;
  if (a >= 1e3) return `${s}${numeroBr(a / 1e3, 0)} mil`;
  return `${s}${numeroBr(a, 0)}`;
}

// ---------------------------------------------------------------------------
// Lançar — uma linha da aba FLUXO DE CAIXA
// ---------------------------------------------------------------------------

function GavetaLancar({ aberta, onFechar, unidade, mes, cadastro, onLancado }) {
  const vazio = useCallback(() => ({
    unidade, conta_id: '', data: mes === hoje().slice(0, 7) ? hoje() : `${mes}-01`, valor: null, pessoa: '', descricao: '',
    sinal: '', conta_bancaria_id: '', empresa_id: '', observacao: '',
  }), [unidade, mes]);
  const [f, setF] = useState(vazio);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [feitos, setFeitos] = useState([]);
  useEffect(() => { if (aberta) { setF(vazio()); setErro(''); setFeitos([]); } }, [aberta, vazio]);

  const conta = cadastro?.contas?.find((c) => String(c.id) === String(f.conta_id));
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v && v.target ? v.target.value : v }));

  async function salvar(continuar) {
    setErro('');
    setSalvando(true);
    try {
      const r = await api.post(`${BASE}/lancamento`, { ...f, conta_id: Number(f.conta_id) });
      const texto = `${r.conta}: ${brl(r.valor)} em ${dataBr(r.data)} (${r.unidade === 'matriz' ? 'Matriz' : 'Marketplace'}).`;
      onLancado(`Lançado — ${texto}`);
      if (continuar) {
        setFeitos((l) => [texto, ...l].slice(0, 6));
        setF((s) => ({ ...s, valor: null, pessoa: '', descricao: '', observacao: '' }));
      } else onFechar();
    } catch (e) { setErro(msgErro(e)); } finally { setSalvando(false); }
  }

  const pronto = f.conta_id && f.data && num(f.valor) > 0;
  return (
    <Gaveta aberta={aberta} onFechar={onFechar} Icone={Plus} titulo="Lançar no caixa"
      subtitulo="Conta, data do pagamento e valor. Despesa já entra como saída — não precisa digitar o sinal."
      rodape={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Fechar</button>
          <button type="button" className="btn btn-ghost" disabled={!pronto || salvando} onClick={() => salvar(true)}>Lançar e continuar</button>
          <button type="button" className="btn btn-primary" disabled={!pronto || salvando} onClick={() => salvar(false)}>Lançar</button>
        </>
      )}>
      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      <div className="fm-form">
        <Field label="Unidade">
          <div className="segmentado">
            {UNIDADES.filter((u) => u.chave !== 'consolidado').map((u) => (
              <button key={u.chave} type="button" className={f.unidade === u.chave ? 'ativo' : undefined} onClick={() => set('unidade')(u.chave)}>{u.rotulo}</button>
            ))}
          </div>
        </Field>
        <Field label="Conta do plano">
          <Select value={String(f.conta_id)} onChange={set('conta_id')} placeholder="Escolha a conta" chaveRecentes="fm-contas-recentes">
            {(cadastro?.grupos || []).map((g) => (
              <optgroup key={g} label={g}>
                {(cadastro?.contas || []).filter((c) => c.grupo === g).map((c) => <option key={c.id} value={String(c.id)}>{c.nome}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        <div className="fm-form-duas">
          <Field label="Data do pagamento"><DateInput value={f.data} onChange={set('data')} /></Field>
          <Field label="Valor" hint={conta ? (conta.entrada ? 'entra como ENTRADA' : 'entra como SAÍDA') : undefined}>
            <NumInput value={f.valor} onChange={set('valor')} suffix="R$" min={0} />
          </Field>
        </div>
        {conta && (
          <label className="fm-inverter">
            <input type="checkbox" checked={f.sinal !== ''} onChange={(e) => set('sinal')(e.target.checked ? (conta.entrada ? 'saida' : 'entrada') : '')} />
            {conta.entrada ? 'É uma saída nesta conta (estorno)' : 'É uma entrada nesta conta (estorno / devolução)'}
          </label>
        )}
        <Field label="Pessoa"><input className="input" maxLength={160} value={f.pessoa} onChange={set('pessoa')} placeholder="Quem pagou ou recebeu" /></Field>
        <Field label="Descrição (opcional)"><input className="input" maxLength={200} value={f.descricao} onChange={set('descricao')} placeholder={conta?.nome || ''} /></Field>
        <div className="fm-form-duas">
          <Field label="Conta bancária">
            <Select value={String(f.conta_bancaria_id)} onChange={set('conta_bancaria_id')} placeholder="Não informar">
              <option value="">Não informar</option>
              {(cadastro?.contasBancarias || []).map((c) => <option key={c.id} value={String(c.id)}>{c.nome}</option>)}
            </Select>
          </Field>
          <Field label="Empresa (CNPJ)">
            <Select value={String(f.empresa_id)} onChange={set('empresa_id')} placeholder="A primeira">
              {(cadastro?.empresas || []).map((e) => <option key={e.id} value={String(e.id)}>{e.nome}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Observação"><textarea className="input" rows={2} value={f.observacao} onChange={set('observacao')} /></Field>
        {feitos.length > 0 && (
          <div className="fm-feitos">
            <small>Lançados agora</small>
            {feitos.map((t, i) => <div key={i}><CheckCircle2 size={12} /> {t}</div>)}
          </div>
        )}
      </div>
    </Gaveta>
  );
}

// ---------------------------------------------------------------------------
// Fatias e metas
// ---------------------------------------------------------------------------

function GavetaConfig({ aberta, onFechar, cadastro, onSalvo }) {
  const [aba, setAba] = useState('fatias');
  const [unidadeMeta, setUnidadeMeta] = useState('matriz');
  const [fatias, setFatias] = useState({});
  const [metas, setMetas] = useState({ matriz: {}, marketplace: {} });
  const [bancos, setBancos] = useState({});
  const [busca, setBusca] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!aberta || !cadastro) return;
    const fa = {};
    const me = { matriz: {}, marketplace: {} };
    for (const c of cadastro.contas) {
      fa[c.id] = c.fatia || 0;
      me.matriz[c.id] = c.orcamento.matriz;
      me.marketplace[c.id] = c.orcamento.marketplace;
    }
    setFatias(fa);
    setMetas(me);
    setBancos(Object.fromEntries((cadastro.contasBancarias || []).map((c) => [c.id, c.unidade || ''])));
    setErro('');
  }, [aberta, cadastro]);

  const contas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return (cadastro?.contas || []).filter((c) => !t || c.nome.toLowerCase().includes(t) || c.grupo.toLowerCase().includes(t));
  }, [cadastro, busca]);

  const receitaMeta = useMemo(() => (cadastro?.contas || []).filter((c) => c.grupo === 'RECEITA OPERACIONAL')
    .reduce((s, c) => s + num(metas[unidadeMeta]?.[c.id]), 0), [cadastro, metas, unidadeMeta]);

  async function salvar() {
    setErro('');
    setSalvando(true);
    try {
      if (aba === 'bancos') {
        const mudadas = (cadastro.contasBancarias || []).filter((c) => (c.unidade || '') !== (bancos[c.id] || ''));
        for (const c of mudadas) await api.put(`${BASE}/conta-bancaria/${c.id}/unidade`, { unidade: bancos[c.id] || null });
        onSalvo(`Contas bancárias gravadas (${mudadas.length} alterada(s)).`);
      } else if (aba === 'fatias') {
        const itens = cadastro.contas.filter((c) => num(fatias[c.id]) !== num(c.fatia)).map((c) => ({ conta_id: c.id, percentual: num(fatias[c.id]) }));
        await api.put(`${BASE}/fatias`, { itens });
        onSalvo(`Fatias gravadas (${itens.length} conta(s) alterada(s)).`);
      } else {
        const itens = cadastro.contas
          .filter((c) => (metas[unidadeMeta][c.id] ?? null) !== (c.orcamento[unidadeMeta] ?? null))
          .map((c) => ({ conta_id: c.id, valor_mensal: metas[unidadeMeta][c.id] ?? null }));
        await api.put(`${BASE}/orcamento`, { unidade: unidadeMeta, itens });
        onSalvo(`Metas da ${unidadeMeta === 'matriz' ? 'Matriz' : 'unidade Marketplace'} gravadas (${itens.length} conta(s)).`);
      }
      onFechar();
    } catch (e) { setErro(msgErro(e)); } finally { setSalvando(false); }
  }

  const grupos = cadastro?.grupos || [];
  return (
    <Gaveta aberta={aberta} onFechar={onFechar} larga Icone={Settings2} titulo="Fatias e metas"
      subtitulo="Fatia: quanto de cada conta da Matriz o Marketplace assume. Meta: o orçamento mensal que vira a coluna Ideal."
      rodape={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={salvando || !cadastro} onClick={salvar}>Gravar</button>
        </>
      )}>
      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      <div className="fm-config-topo">
        <div className="segmentado">
          <button type="button" className={aba === 'fatias' ? 'ativo' : undefined} onClick={() => setAba('fatias')}>Fatias do Marketplace</button>
          <button type="button" className={aba === 'metas' ? 'ativo' : undefined} onClick={() => setAba('metas')}>Metas (Ideal)</button>
          <button type="button" className={aba === 'bancos' ? 'ativo' : undefined} onClick={() => setAba('bancos')}>Contas bancárias</button>
        </div>
        {aba === 'metas' && (
          <div className="segmentado segmentado-mini">
            <button type="button" className={unidadeMeta === 'matriz' ? 'ativo' : undefined} onClick={() => setUnidadeMeta('matriz')}>Matriz</button>
            <button type="button" className={unidadeMeta === 'marketplace' ? 'ativo' : undefined} onClick={() => setUnidadeMeta('marketplace')}>Marketplace</button>
          </div>
        )}
        {aba !== 'bancos' && <div className="fm-busca"><CampoBusca valor={busca} onChange={setBusca} placeholder="Buscar conta…" /></div>}
      </div>
      {aba === 'bancos' ? (
        <>
          <p className="page-sub">
            Diga de quem é cada conta. Tudo que for pago ou recebido numa conta do <strong>Marketplace</strong> (Mercado Pago, carteira
            da Shopee) entra no resultado do Marketplace, venha de onde vier o título. Recebimento do Wik numa conta do Marketplace não
            entra de novo: a venda já está no extrato da plataforma.
          </p>
          {(cadastro?.contasBancarias || []).length === 0 && <p className="page-sub">Nenhuma conta bancária cadastrada.</p>}
          <table className="data-table fm-config">
            <tbody>
              {(cadastro?.contasBancarias || []).map((c) => (
                <tr key={c.id}>
                  <td>{c.nome}</td>
                  <td style={{ width: 290 }}>
                    <div className="segmentado segmentado-mini">
                      {[['', 'Segue o título'], ['matriz', 'Matriz'], ['marketplace', 'Marketplace']].map(([v, t]) => (
                        <button key={v || 'nada'} type="button" className={(bancos[c.id] || '') === v ? 'ativo' : undefined}
                          onClick={() => setBancos((b) => ({ ...b, [c.id]: v }))}>{t}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
      <>
      <p className="page-sub">
        {aba === 'fatias'
          ? 'Ex.: 20% em Aluguéis = de cada aluguel pago pela Matriz, 20% vai para o resultado do Marketplace e 80% fica na Matriz. O Consolidado continua com o valor inteiro.'
          : `O % ideal de cada conta é a meta dela ÷ a meta de receita operacional (${brl(receitaMeta)}). Despesa entra com sinal de menos, como na planilha.`}
      </p>
      <table className="data-table fm-config">
        <tbody>
          {grupos.map((g) => {
            const doGrupo = contas.filter((c) => c.grupo === g && (aba === 'metas' || !c.entrada));
            if (!doGrupo.length) return null;
            return (
              <Fragment key={g}>
                <tr className="linha-total"><td colSpan={3}><strong>{g}</strong></td></tr>
                {doGrupo.map((c) => (
                  <tr key={c.id}>
                    <td>{c.nome}</td>
                    <td style={{ width: 170 }}>
                      {aba === 'fatias'
                        ? <NumInput value={fatias[c.id]} onChange={(v) => setFatias((s) => ({ ...s, [c.id]: v }))} suffix="%" min={0} step="0.1" />
                        : <NumInput value={metas[unidadeMeta][c.id]} onChange={(v) => setMetas((s) => ({ ...s, [unidadeMeta]: { ...s[unidadeMeta], [c.id]: v } }))} suffix="R$" />}
                    </td>
                    <td className="mono num fm-suave" style={{ width: 80 }}>
                      {aba === 'metas' && receitaMeta > 0 && metas[unidadeMeta][c.id] !== null && metas[unidadeMeta][c.id] !== undefined
                        ? pctTxt((num(metas[unidadeMeta][c.id]) / receitaMeta) * 100, 2) : ''}
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </>
      )}
    </Gaveta>
  );
}
