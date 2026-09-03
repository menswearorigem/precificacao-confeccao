import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer, Info, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, numeroBr, dataBr } from '../lib/format';
import {
  Select, Field, IndicadorDestaque, BotaoRelatorio, ChipsFiltros,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import DataTable from '../components/DataTable';
import {
  CartaoGrafico, GraficoEvolucao, GraficoColunas, GraficoRosca, BarraRanking,
  useRefGrafico, capturarGraficos,
} from '../components/graficos';
import { definicaoRelatorioCompras, indicadoresCompras, SITUACAO_LABEL } from '../lib/relatorioCompras';
import { textoPeriodo } from '../lib/relatorio';

// Relatório de Compras.
//
// A tela antiga tinha três tabelas e nenhum gráfico: dava para saber quanto,
// mas não dava para VER nada. Esta responde na ordem em que a pergunta
// aparece — quanto, comparado com antes, em que ritmo, em quê, com quem, e
// como foi pago — e cada bloco traz escrito o que ele significa.
//
// Todos os números vêm somados do backend (GET /api/compras/relatorio). A
// tela não recalcula nada (REGRA 1) e não completa dado que não existe
// (REGRA 2): mês sem compra não vira zero, ticket médio sem compra vira "—".

function rotuloMes(mes) {
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const [ano, m] = String(mes).split('-');
  return `${nomes[Number(m) - 1] || m}/${ano.slice(2)}`;
}

function Variacao({ atual, anterior }) {
  if (anterior === null || anterior === undefined) return null;
  if (Math.abs(anterior) < 0.01) {
    return <span className="indicador-variacao">sem base para comparar</span>;
  }
  const delta = (atual - anterior) / Math.abs(anterior);
  if (Math.abs(delta) < 0.005) {
    return <span className="indicador-variacao"><Minus size={12} /> igual ao período anterior</span>;
  }
  const subiu = delta > 0;
  // Em COMPRA, subir é gastar mais: o verde/vermelho do faturamento se
  // inverte aqui. Gasto maior é vermelho.
  return (
    <span className={'indicador-variacao ' + (subiu ? 'caiu' : 'subiu')}>
      {subiu ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {numeroBr(Math.abs(delta) * 100, 1)}% {subiu ? 'a mais' : 'a menos'} que o período anterior
    </span>
  );
}

export default function RelatorioComprasPage() {
  const navigate = useNavigate();

  const [periodo, setPeriodo] = useState(() => PRESETS_PERIODO.find((p) => p.chave === 'esteMes').calcular());
  const [categoria, setCategoria] = useState('');
  const [fornecedorId, setFornecedorId] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('');
  const [situacao, setSituacao] = useState('');

  const [listas, setListas] = useState(null);
  const [fornecedores, setFornecedores] = useState([]);
  const [opcoes, setOpcoes] = useState({ formasPagamento: [] });
  const [relatorio, setRelatorio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  const refEvolucao = useRefGrafico();
  const refCategorias = useRefGrafico();
  const refMeses = useRefGrafico();

  useEffect(() => {
    Promise.all([
      api.get('/listas'),
      api.get('/fornecedores'),
      api.get('/compras/opcoes').catch(() => ({ formasPagamento: [] })),
    ]).then(([l, f, o]) => {
      setListas(l);
      setFornecedores(f);
      setOpcoes(o);
    });
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (periodo.inicio) p.set('data_inicio', periodo.inicio);
    if (periodo.fim) p.set('data_fim', periodo.fim);
    if (categoria) p.set('categoria', categoria);
    if (fornecedorId) p.set('fornecedor_id', fornecedorId);
    if (formaPagamento) p.set('forma_pagamento', formaPagamento);
    if (situacao) p.set('situacao', situacao);
    return p;
  }, [periodo, categoria, fornecedorId, formaPagamento, situacao]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`/compras/relatorio?${params.toString()}`)
      .then(setRelatorio)
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }, [params]);

  const chips = [];
  chips.push({ chave: 'periodo', rotulo: 'Período', valor: textoPeriodo(periodo.inicio, periodo.fim) });
  if (categoria) chips.push({ chave: 'cat', rotulo: 'Categoria', valor: categoria, onRemover: () => setCategoria('') });
  if (fornecedorId) {
    const f = fornecedores.find((x) => String(x.id) === String(fornecedorId));
    chips.push({ chave: 'forn', rotulo: 'Fornecedor', valor: f?.nome || fornecedorId, onRemover: () => setFornecedorId('') });
  }
  if (formaPagamento) chips.push({ chave: 'forma', rotulo: 'Pagamento', valor: formaPagamento, onRemover: () => setFormaPagamento('') });
  if (situacao) chips.push({ chave: 'sit', rotulo: 'Situação', valor: SITUACAO_LABEL[situacao] || situacao, onRemover: () => setSituacao('') });

  const evolucao = useMemo(() => (
    (relatorio?.porDia || []).map((d) => ({ ...d, rotulo: dataBr(d.data), total: Number(d.total) }))
  ), [relatorio]);

  const meses = useMemo(() => (
    (relatorio?.porMes || []).map((m) => ({ ...m, rotulo: rotuloMes(m.mes), total: Number(m.total) }))
  ), [relatorio]);

  const rosca = useMemo(() => (
    (relatorio?.porCategoria || []).map((c) => ({ rotulo: c.categoria, valor: Number(c.total) }))
  ), [relatorio]);

  const rankingFornecedores = useMemo(() => (
    (relatorio?.porFornecedor || []).slice(0, 12).map((f) => ({
      rotulo: f.fornecedor_nome,
      detalhe: `${formatQtd(f.quantidade)} compra(s)`,
      valor: Number(f.total),
      id: f.fornecedor_id,
    }))
  ), [relatorio]);

  const rankingPagamento = useMemo(() => (
    (relatorio?.porFormaPagamento || []).map((f) => ({
      rotulo: f.forma,
      detalhe: `${formatQtd(f.quantidade)} compra(s)`,
      valor: Number(f.total),
    }))
  ), [relatorio]);

  // Dia a dia só faz sentido em recorte curto; acima disso o mês a mês é o
  // gráfico legível.
  const usarMeses = evolucao.length > 62;

  async function montarRelatorio(tipo) {
    if (!relatorio) return null;
    let dados = relatorio;
    if (tipo === 'completo') {
      const p = new URLSearchParams(params);
      p.set('incluir_itens', '1');
      dados = await api.get(`/compras/relatorio?${p.toString()}`);
    }
    if (dados.quantidadeCompras === 0 && dados.quantidadeCancelada === 0) return null;
    const graficos = await capturarGraficos([
      { titulo: usarMeses ? 'Evolução mês a mês' : 'Evolução dia a dia', ref: usarMeses ? refMeses : refEvolucao },
      { titulo: 'Gasto por categoria', ref: refCategorias },
    ]);
    return definicaoRelatorioCompras({
      tipo,
      relatorio: dados,
      filtros: chips.map((c) => `${c.rotulo}: ${c.valor}`),
      graficos,
      formatadores: { brl, formatQtd, numeroBr },
    });
  }

  const indicadores = relatorio ? indicadoresCompras(relatorio, { brl, formatQtd, numeroBr }) : [];

  return (
    <div className="page-wide">
      <div className="no-print">
        <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/compras')}>
          <ArrowLeft size={14} /> Voltar para compras
        </button>

        <div className="pagina-topo">
          <div>
            <h2>Relatório de Compras</h2>
            <p className="page-sub">
              Escolha o período e, se quiser, filtre. Tudo abaixo — números, gráficos e tabelas — responde
              exatamente ao recorte escolhido.
            </p>
          </div>
          <div className="pagina-topo-acoes">
            <BotaoRelatorio
              montar={montarRelatorio}
              disabled={!relatorio || (relatorio.quantidadeCompras === 0 && relatorio.quantidadeCancelada === 0)}
              descricaoResumo="Os indicadores, os dois gráficos e as quebras por categoria, fornecedor, pagamento e situação."
              descricaoCompleto="O resumo mais a evolução mês a mês, o comparativo, todas as compras, os itens um a um e o ranking de itens."
            />
            <button className="btn btn-ghost" onClick={() => window.print()}>
              <Printer size={14} /> Imprimir
            </button>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 8 }}>
          <div className="card-head">Recorte</div>
          <div className="filtros-barra" style={{ marginBottom: 0 }}>
            <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
          </div>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Categoria">
              <Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                <option value="">Todas</option>
                {listas?.categoria_compra.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
              </Select>
            </Field>
            <Field label="Fornecedor">
              <Select value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)}>
                <option value="">Todos</option>
                {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </Select>
            </Field>
            <Field label="Forma de pagamento">
              <Select value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)}>
                <option value="">Todas</option>
                {opcoes.formasPagamento.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Situação" hint="Compra cancelada nunca entra nos totais, mesmo se escolhida aqui.">
              <Select value={situacao} onChange={(e) => setSituacao(e.target.value)}>
                <option value="">Pendentes e recebidas</option>
                <option value="pendente">Só pendentes</option>
                <option value="recebido">Só recebidas</option>
              </Select>
            </Field>
          </div>
        </div>

        <ChipsFiltros itens={chips} />
        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        {loading && <p className="page-sub">Gerando…</p>}
      </div>

      {relatorio && (
        <>
          <div className="print-only" style={{ marginBottom: 12 }}>
            <h2>Relatório de Compras</h2>
            <p className="page-sub">{textoPeriodo(periodo.inicio, periodo.fim)}</p>
          </div>

          <div className="indicadores-faixa" style={{ marginTop: 14 }}>
            <IndicadorDestaque
              destaque
              rotulo="Total gasto no período"
              valor={brl(relatorio.totalGeral)}
              variacao={relatorio.comparativo
                ? <Variacao atual={relatorio.totalGeral} anterior={relatorio.comparativo.totalGeral} />
                : null}
              explicacao="Soma do total líquido das compras do recorte — já com frete somado e desconto abatido."
            />
            {indicadores.slice(1).map((i) => (
              <IndicadorDestaque key={i.rotulo} rotulo={i.rotulo} valor={i.valor} explicacao={i.detalhe} tom={i.tom} />
            ))}
          </div>

          <div className="nota-precisao">
            <Info size={14} />
            <span>
              Calculado sobre <strong>{formatQtd(relatorio.quantidadeCompras)} compra(s)</strong> e{' '}
              <strong>{formatQtd(relatorio.quantidadeItens)} item(ns)</strong>.
              {relatorio.quantidadeCancelada > 0 && (
                <> {formatQtd(relatorio.quantidadeCancelada)} compra(s) cancelada(s), somando {brl(relatorio.totalCancelado)}, ficaram de fora.</>
              )}
              {relatorio.comparativo && (
                <> O comparativo usa {textoPeriodo(relatorio.comparativo.periodo.inicio, relatorio.comparativo.periodo.fim)} — a mesma quantidade de dias, logo antes.</>
              )}
            </span>
          </div>

          {usarMeses ? (
            <CartaoGrafico
              titulo="Evolução mês a mês"
              explicacao="Cada barra é um mês com compra dentro do recorte. Mês sem nenhuma compra não aparece — barra ausente quer dizer 'nenhum lançamento', não 'R$ 0,00 gasto'."
              refGrafico={refMeses}
              altura={280}
              vazio={meses.length === 0 ? 'Nenhuma compra no período.' : null}
            >
              <GraficoColunas dados={meses} series={[{ chave: 'total', nome: 'Comprado' }]} altura={280} />
            </CartaoGrafico>
          ) : (
            <CartaoGrafico
              titulo="Evolução dia a dia"
              explicacao="Cada ponto é um dia com compra. Dias sem compra não entram no eixo, então a linha liga um dia de compra ao próximo."
              refGrafico={refEvolucao}
              altura={280}
              vazio={evolucao.length === 0 ? 'Nenhuma compra no período.' : null}
              rodape={evolucao.length > 0 ? `${formatQtd(evolucao.length)} dia(s) com compra no período.` : null}
            >
              <GraficoEvolucao dados={evolucao} series={[{ chave: 'total', nome: 'Comprado' }]} altura={280} />
            </CartaoGrafico>
          )}

          <div className="coluna-larga">
            <div className="card">
              <div className="card-head">Com quem a empresa mais gastou</div>
              <p className="grafico-explicacao">
                Os doze maiores do período. Clique para abrir a ficha do fornecedor.
              </p>
              <BarraRanking
                itens={rankingFornecedores}
                aoClicar={(item) => item.id && navigate(`/fornecedores/${item.id}`)}
                vazio="Nenhuma compra no período."
              />
            </div>

            <CartaoGrafico
              titulo="Gasto por categoria"
              explicacao="A divisão do gasto do período. O valor no meio é o total."
              refGrafico={refCategorias}
              altura={250}
              vazio={rosca.length === 0 ? 'Nenhuma compra no período.' : null}
            >
              <GraficoRosca dados={rosca} altura={250} totalRotulo="Total gasto" />
            </CartaoGrafico>
          </div>

          <div className="duas-colunas">
            <div className="card">
              <div className="card-head">Como foi pago</div>
              <p className="grafico-explicacao">
                “(não informada)” é compra lançada sem preencher a forma de pagamento — não é um meio de
                pagamento, é um campo em branco esperando alguém.
              </p>
              <BarraRanking itens={rankingPagamento} vazio="Nenhuma compra no período." />
            </div>

            <div className="card">
              <div className="card-head">Situação das compras</div>
              <p className="grafico-explicacao">
                Pendente é compra lançada que ainda não foi marcada como recebida.
              </p>
              <DataTable>
                <table className="data-table">
                  <thead><tr><th>Situação</th><th>Compras</th><th>Total</th></tr></thead>
                  <tbody>
                    {relatorio.porSituacao.map((s) => (
                      <tr key={s.situacao}>
                        <td><span className={'stamp sm ' + (s.situacao === 'recebido' ? 'tone-saudavel' : 'tone-atencao')}>{SITUACAO_LABEL[s.situacao] || s.situacao}</span></td>
                        <td className="mono">{formatQtd(s.quantidade)}</td>
                        <td className="mono">{brl(s.total)}</td>
                      </tr>
                    ))}
                    {relatorio.quantidadeCancelada > 0 && (
                      <tr>
                        <td><span className="stamp sm tone-prejuizo">Cancelada</span></td>
                        <td className="mono">{formatQtd(relatorio.quantidadeCancelada)}</td>
                        <td className="mono">{brl(relatorio.totalCancelado)}</td>
                      </tr>
                    )}
                    {relatorio.porSituacao.length === 0 && <tr><td colSpan="3">Nenhuma compra no período.</td></tr>}
                  </tbody>
                </table>
              </DataTable>
              <div className="grafico-rodape">
                A linha de canceladas está aqui só para constar — ela não entra em nenhum outro número
                deste relatório.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head-linha">
              <div className="card-head">Gasto por categoria, em número</div>
            </div>
            <DataTable>
              <table className="data-table">
                <thead><tr><th>Categoria</th><th>Compras</th><th>Itens</th><th>Total</th><th>% do total</th></tr></thead>
                <tbody>
                  {relatorio.porCategoria.map((c) => (
                    <tr key={c.categoria}>
                      <td>{c.categoria}</td>
                      <td className="mono">{formatQtd(c.quantidade)}</td>
                      <td className="mono">{formatQtd(c.itens)}</td>
                      <td className="mono">{brl(c.total)}</td>
                      <td className="mono">{relatorio.totalGeral ? `${numeroBr((c.total / relatorio.totalGeral) * 100, 1)}%` : '—'}</td>
                    </tr>
                  ))}
                  {relatorio.porCategoria.length === 0 && <tr><td colSpan="5">Nenhuma compra no período.</td></tr>}
                </tbody>
                {relatorio.porCategoria.length > 0 && (
                  <tbody>
                    <tr className="linha-total">
                      <td><strong>Total</strong></td>
                      <td className="mono">{formatQtd(relatorio.quantidadeCompras)}</td>
                      <td className="mono">{formatQtd(relatorio.quantidadeItens)}</td>
                      <td className="mono">{brl(relatorio.totalGeral)}</td>
                      <td className="mono">100,0%</td>
                    </tr>
                  </tbody>
                )}
              </table>
            </DataTable>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head-linha">
              <div className="card-head">Compras no período</div>
              <span className="page-sub" style={{ margin: 0 }}>{formatQtd(relatorio.compras.length)} lançamento(s)</span>
            </div>
            <DataTable>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Nº</th><th>Data</th><th>Fornecedor</th><th>Categoria</th>
                    <th>Pagamento</th><th>Situação</th><th>Total Líquido</th>
                  </tr>
                </thead>
                <tbody>
                  {relatorio.compras.map((c) => (
                    <tr key={c.id} className="clickable-row" onClick={() => navigate(`/compras/${c.id}`)}>
                      <td className="mono">#{c.numero}</td>
                      <td className="mono">{dataBr(String(c.data_compra).slice(0, 10))}</td>
                      <td>{c.fornecedor_nome || '—'}</td>
                      <td>{c.categoria}</td>
                      <td>{c.forma_pagamento || '—'}</td>
                      <td><span className={'stamp sm ' + (c.situacao === 'recebido' ? 'tone-saudavel' : 'tone-atencao')}>{SITUACAO_LABEL[c.situacao] || c.situacao}</span></td>
                      <td className="mono">{brl(c.total_liquido)}</td>
                    </tr>
                  ))}
                  {relatorio.compras.length === 0 && <tr><td colSpan="7">Nenhuma compra no período.</td></tr>}
                </tbody>
              </table>
            </DataTable>
          </div>
        </>
      )}
    </div>
  );
}
