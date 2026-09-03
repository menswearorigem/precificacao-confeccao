import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, ChevronRight, ShoppingCart, Wallet, Receipt, Users, Clock, Info,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, numeroBr, dataBr } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, BotaoRelatorio, EstadoVazio,
  IndicadorDestaque, CampoBusca, ChipsFiltros, FiltrosAvancados, Select, NumInput, Field,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import {
  CartaoGrafico, GraficoEvolucao, GraficoRosca, BarraRanking, useRefGrafico, capturarGraficos,
} from '../components/graficos';
import { useTabela } from '../lib/useTabela';
import { definicaoRelatorioCompras, SITUACAO_LABEL } from '../lib/relatorioCompras';
import { textoPeriodo } from '../lib/relatorio';

// Painel de Compras.
//
// A tela antiga era uma lista com um campo de busca. Ela respondia "quais
// compras existem" e nenhuma outra pergunta. Esta responde, na ordem em que
// alguém pergunta:
//
//   1. quanto eu gastei no período           -> faixa de indicadores
//   2. o gasto está subindo ou caindo        -> gráfico de evolução
//   3. onde o dinheiro está indo             -> rosca por categoria
//   4. com quem eu gasto mais                -> ranking de fornecedores
//   5. cadê aquela compra específica         -> busca ampla + filtros + tabela
//
// Nada aqui recalcula preço, margem ou imposto (REGRA 1): os números são soma
// do total líquido que já está gravado em cada compra.

const SITUACAO_TONE = { pendente: 'tone-atencao', recebido: 'tone-saudavel', cancelado: 'tone-prejuizo' };

const COLUNAS_ORDENAVEIS = {
  numero: (c) => Number(c.numero) || 0,
  data: (c) => new Date(c.data_compra).getTime(),
  fornecedor: (c) => c.fornecedor_nome,
  categoria: (c) => c.categoria,
  documento: (c) => c.numero_documento,
  pagamento: (c) => c.forma_pagamento,
  itens: (c) => Number(c.itens_qtd) || 0,
  total: (c) => Number(c.total_liquido) || 0,
  situacao: (c) => c.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (c) => c.numero },
  { rotulo: 'Data', valor: (c) => dataBr(String(c.data_compra).slice(0, 10)) },
  { rotulo: 'Fornecedor', valor: (c) => c.fornecedor_nome || '' },
  { rotulo: 'CPF/CNPJ', valor: (c) => c.fornecedor_cpf_cnpj || '' },
  { rotulo: 'Categoria', valor: (c) => c.categoria },
  { rotulo: 'Documento', valor: (c) => c.numero_documento },
  { rotulo: 'Forma de pagamento', valor: (c) => c.forma_pagamento || '' },
  { rotulo: 'Condição', valor: (c) => c.condicao_pagamento || '' },
  { rotulo: 'Itens', valor: (c) => formatQtd(c.itens_qtd) },
  { rotulo: 'Total Líquido', valor: (c) => brl(c.total_liquido) },
  { rotulo: 'Situação', valor: (c) => SITUACAO_LABEL[c.situacao] || c.situacao },
];

const FILTROS_VAZIOS = {
  situacoes: [],
  formaPagamento: '',
  condicaoPagamento: '',
  fornecedorId: '',
  valorMin: '',
  valorMax: '',
  comDocumento: '',
  comFornecedor: '',
};

function mesDe(iso) {
  return String(iso).slice(0, 7);
}

function rotuloMes(mes) {
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const [ano, m] = mes.split('-');
  return `${nomes[Number(m) - 1]}/${ano.slice(2)}`;
}

export default function ComprasListPage() {
  const navigate = useNavigate();

  const [categorias, setCategorias] = useState([]);
  const [opcoes, setOpcoes] = useState({ formasPagamento: [], condicoesPagamento: [] });
  const [fornecedores, setFornecedores] = useState([]);

  // Abre em "todo o período" de propósito: quem entra em Compras costuma
  // procurar uma compra específica, não fechar um mês. O período fica a um
  // clique de distância pra quem quer o recorte.
  const [periodo, setPeriodo] = useState({ inicio: '', fim: '' });
  const [categoriasAtivas, setCategoriasAtivas] = useState([]);
  const [buscaCampo, setBuscaCampo] = useState('');
  const [busca, setBusca] = useState('');
  // `?fornecedor=` na URL já abre a tela filtrada — é o link "abrir em
  // Compras" da ficha do fornecedor.
  const [filtros, setFiltros] = useState(() => {
    const daUrl = new URLSearchParams(window.location.search).get('fornecedor');
    return daUrl ? { ...FILTROS_VAZIOS, fornecedorId: daUrl } : FILTROS_VAZIOS;
  });
  const [painelAberto, setPainelAberto] = useState(false);

  const [compras, setCompras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState('');

  const refEvolucao = useRefGrafico();
  const refCategorias = useRefGrafico();

  useEffect(() => {
    Promise.all([
      api.get('/listas'),
      api.get('/compras/opcoes').catch(() => ({ formasPagamento: [], condicoesPagamento: [] })),
      api.get('/fornecedores').catch(() => []),
    ]).then(([listas, ops, forns]) => {
      setCategorias(listas.categoria_compra || []);
      setOpcoes(ops);
      setFornecedores(forns);
    });
  }, []);

  // Um lugar só monta os parâmetros: a lista da tela e o relatório exportado
  // saem exatamente do mesmo recorte. Era assim que "o PDF não bate com a
  // tela" nascia em sistema antigo.
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (periodo.inicio) p.set('data_inicio', periodo.inicio);
    if (periodo.fim) p.set('data_fim', periodo.fim);
    if (categoriasAtivas.length) p.set('categoria', categoriasAtivas.join(','));
    if (filtros.situacoes.length) p.set('situacao', filtros.situacoes.join(','));
    if (filtros.formaPagamento) p.set('forma_pagamento', filtros.formaPagamento);
    if (filtros.condicaoPagamento) p.set('condicao_pagamento', filtros.condicaoPagamento);
    if (filtros.fornecedorId) p.set('fornecedor_id', filtros.fornecedorId);
    if (filtros.valorMin !== '' && filtros.valorMin !== null) p.set('valor_min', filtros.valorMin);
    if (filtros.valorMax !== '' && filtros.valorMax !== null) p.set('valor_max', filtros.valorMax);
    if (filtros.comDocumento) p.set('com_documento', filtros.comDocumento);
    if (filtros.comFornecedor) p.set('com_fornecedor', filtros.comFornecedor);
    if (busca.trim()) p.set('busca', busca.trim());
    return p;
  }, [periodo, categoriasAtivas, filtros, busca]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`/compras?${params.toString()}`)
      .then(setCompras)
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }, [params]);

  const tabela = useTabela(compras, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  // ---- os números da faixa -------------------------------------------------
  // Cancelada fora de tudo (REGRA 2), e contada à parte pra não parecer que
  // sumiu.
  const resumo = useMemo(() => {
    const ativas = compras.filter((c) => c.situacao !== 'cancelado');
    const total = ativas.reduce((s, c) => s + Number(c.total_liquido || 0), 0);
    const pendentes = ativas.filter((c) => c.situacao === 'pendente');
    return {
      total,
      quantidade: ativas.length,
      ticket: ativas.length ? total / ativas.length : null,
      fornecedores: new Set(ativas.map((c) => c.fornecedor_id).filter(Boolean)).size,
      pendenteValor: pendentes.reduce((s, c) => s + Number(c.total_liquido || 0), 0),
      pendenteQtd: pendentes.length,
      canceladas: compras.length - ativas.length,
      ativas,
    };
  }, [compras]);

  // Dia a dia quando o recorte é curto; mês a mês quando é longo — 400 pontos
  // num gráfico de 700px de largura viram uma mancha.
  const { evolucao, granularidade } = useMemo(() => {
    const ativas = resumo.ativas;
    if (ativas.length === 0) return { evolucao: [], granularidade: 'dia' };
    const datas = ativas.map((c) => String(c.data_compra).slice(0, 10)).sort();
    const dias = (new Date(datas[datas.length - 1]) - new Date(datas[0])) / 86400000;
    const porMes = dias > 70;
    const mapa = new Map();
    for (const c of ativas) {
      const dia = String(c.data_compra).slice(0, 10);
      const chave = porMes ? mesDe(dia) : dia;
      const atual = mapa.get(chave) || { chave, total: 0, quantidade: 0 };
      atual.total += Number(c.total_liquido || 0);
      atual.quantidade += 1;
      mapa.set(chave, atual);
    }
    return {
      granularidade: porMes ? 'mes' : 'dia',
      evolucao: [...mapa.values()]
        .sort((a, b) => (a.chave < b.chave ? -1 : 1))
        .map((p) => ({ ...p, rotulo: porMes ? rotuloMes(p.chave) : dataBr(p.chave) })),
    };
  }, [resumo.ativas]);

  const porCategoria = useMemo(() => {
    const mapa = new Map();
    for (const c of resumo.ativas) {
      const atual = mapa.get(c.categoria) || { rotulo: c.categoria, valor: 0, quantidade: 0 };
      atual.valor += Number(c.total_liquido || 0);
      atual.quantidade += 1;
      mapa.set(c.categoria, atual);
    }
    return [...mapa.values()].sort((a, b) => b.valor - a.valor);
  }, [resumo.ativas]);

  const porFornecedor = useMemo(() => {
    const mapa = new Map();
    for (const c of resumo.ativas) {
      const chave = c.fornecedor_id || 'sem';
      const atual = mapa.get(chave) || {
        id: c.fornecedor_id,
        rotulo: c.fornecedor_nome || '(sem fornecedor)',
        detalhe: '',
        valor: 0,
        quantidade: 0,
      };
      atual.valor += Number(c.total_liquido || 0);
      atual.quantidade += 1;
      mapa.set(chave, atual);
    }
    return [...mapa.values()]
      .sort((a, b) => b.valor - a.valor)
      .map((f) => ({ ...f, detalhe: `${formatQtd(f.quantidade)} compra(s)` }));
  }, [resumo.ativas]);

  // ---- filtros ativos, escritos na tela -----------------------------------
  const chips = [];
  if (periodo.inicio || periodo.fim) {
    chips.push({ chave: 'periodo', rotulo: 'Período', valor: textoPeriodo(periodo.inicio, periodo.fim), onRemover: () => setPeriodo({ inicio: '', fim: '' }) });
  }
  for (const c of categoriasAtivas) {
    chips.push({ chave: `cat-${c}`, rotulo: 'Categoria', valor: c, onRemover: () => setCategoriasAtivas((a) => a.filter((x) => x !== c)) });
  }
  for (const s of filtros.situacoes) {
    chips.push({ chave: `sit-${s}`, rotulo: 'Situação', valor: SITUACAO_LABEL[s] || s, onRemover: () => setFiltros((f) => ({ ...f, situacoes: f.situacoes.filter((x) => x !== s) })) });
  }
  if (filtros.formaPagamento) chips.push({ chave: 'forma', rotulo: 'Pagamento', valor: filtros.formaPagamento, onRemover: () => setFiltros((f) => ({ ...f, formaPagamento: '' })) });
  if (filtros.condicaoPagamento) chips.push({ chave: 'cond', rotulo: 'Condição', valor: filtros.condicaoPagamento, onRemover: () => setFiltros((f) => ({ ...f, condicaoPagamento: '' })) });
  if (filtros.fornecedorId) {
    const f = fornecedores.find((x) => String(x.id) === String(filtros.fornecedorId));
    chips.push({ chave: 'forn', rotulo: 'Fornecedor', valor: f?.nome || filtros.fornecedorId, onRemover: () => setFiltros((x) => ({ ...x, fornecedorId: '' })) });
  }
  if (filtros.valorMin !== '') chips.push({ chave: 'vmin', rotulo: 'Valor a partir de', valor: brl(filtros.valorMin), onRemover: () => setFiltros((f) => ({ ...f, valorMin: '' })) });
  if (filtros.valorMax !== '') chips.push({ chave: 'vmax', rotulo: 'Valor até', valor: brl(filtros.valorMax), onRemover: () => setFiltros((f) => ({ ...f, valorMax: '' })) });
  if (filtros.comDocumento) chips.push({ chave: 'doc', rotulo: 'Documento', valor: filtros.comDocumento === 'sim' ? 'Com nota/documento' : 'Sem documento', onRemover: () => setFiltros((f) => ({ ...f, comDocumento: '' })) });
  if (filtros.comFornecedor) chips.push({ chave: 'temforn', rotulo: 'Fornecedor', valor: filtros.comFornecedor === 'sim' ? 'Informado' : 'Em branco', onRemover: () => setFiltros((f) => ({ ...f, comFornecedor: '' })) });
  if (busca.trim()) chips.push({ chave: 'busca', rotulo: 'Busca', valor: busca.trim(), onRemover: () => setBusca('') });

  const filtrosAvancadosAtivos = [
    filtros.situacoes.length > 0, filtros.formaPagamento, filtros.condicaoPagamento, filtros.fornecedorId,
    filtros.valorMin !== '', filtros.valorMax !== '', filtros.comDocumento, filtros.comFornecedor,
  ].filter(Boolean).length;

  function limparTudo() {
    setPeriodo({ inicio: '', fim: '' });
    setCategoriasAtivas([]);
    setFiltros(FILTROS_VAZIOS);
    setBusca('');
  }

  function alternarCategoria(valor) {
    setCategoriasAtivas((atuais) => (atuais.includes(valor) ? atuais.filter((c) => c !== valor) : [...atuais, valor]));
  }

  function alternarSituacao(valor) {
    setFiltros((f) => ({
      ...f,
      situacoes: f.situacoes.includes(valor) ? f.situacoes.filter((s) => s !== valor) : [...f.situacoes, valor],
    }));
  }

  async function novaCompra() {
    setCriando(true);
    try {
      const data = await api.post('/compras', categoriasAtivas.length === 1 ? { categoria: categoriasAtivas[0] } : {});
      navigate(`/compras/${data.compra.id}`);
    } finally {
      setCriando(false);
    }
  }

  // O relatório vem do backend com os mesmos filtros da tela — inclusive o
  // comparativo com o período anterior, que a tela não tem como calcular
  // sozinha porque só carregou o período atual.
  async function montarRelatorio(tipo) {
    const p = new URLSearchParams(params);
    if (tipo === 'completo') p.set('incluir_itens', '1');
    const relatorio = await api.get(`/compras/relatorio?${p.toString()}`);
    if (relatorio.quantidadeCompras === 0 && relatorio.quantidadeCancelada === 0) return null;
    const graficos = await capturarGraficos([
      { titulo: granularidade === 'mes' ? 'Evolução do gasto, mês a mês' : 'Evolução do gasto, dia a dia', ref: refEvolucao },
      { titulo: 'Para onde o dinheiro foi, por categoria', ref: refCategorias },
    ]);
    return definicaoRelatorioCompras({
      tipo,
      relatorio,
      filtros: chips.map((c) => `${c.rotulo}: ${c.valor}`),
      graficos,
      formatadores: { brl, formatQtd, numeroBr },
    });
  }

  const semCompraNenhuma = !loading && compras.length === 0;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Compras</h2>
          <p className="page-sub">
            Tudo que a empresa compra — de tecido a material de escritório. Os números abaixo são deste
            recorte: mude o período ou os filtros e eles acompanham.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          {/* Fornecedores e Relatório já estão no submenu do módulo, logo
              acima — repetir aqui só empurrava o botão principal pra longe. */}
          <BotaoRelatorio
            montar={montarRelatorio}
            disabled={semCompraNenhuma}
            rotulo="Relatórios"
            descricaoResumo="Indicadores, os dois gráficos e as quebras por categoria, fornecedor e pagamento."
            descricaoCompleto="O resumo mais a lista de todas as compras, os itens um a um e o comparativo com o período anterior."
          />
          <button className="btn btn-primary" onClick={novaCompra} disabled={criando}>
            <Plus size={14} /> Nova compra
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
        <FiltrosAvancados
          ativos={filtrosAvancadosAtivos}
          aberto={painelAberto}
          onAlternar={() => setPainelAberto((a) => !a)}
        />
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase="compras"
            colunas={COLUNAS_EXPORTACAO}
            itens={tabela.itensOrdenados}
            disabled={tabela.totalItens === 0}
          />
        </div>
      </div>

      <div className="no-print" style={{ marginBottom: 12 }}>
        <CampoBusca
          valor={busca}
          onChange={setBusca}
          campo={buscaCampo}
          onCampo={setBuscaCampo}
          placeholder="Buscar por fornecedor, CNPJ, nº da compra, documento, item comprado ou observação"
        />
      </div>

      {painelAberto && (
        <div className="card filtros-avancados-painel no-print">
          <div className="card-head">Filtrar por</div>
          <div className="form-grid">
            <Field label="Fornecedor">
              <Select value={filtros.fornecedorId} onChange={(e) => setFiltros((f) => ({ ...f, fornecedorId: e.target.value }))}>
                <option value="">Todos</option>
                {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </Select>
            </Field>
            <Field label="Forma de pagamento">
              <Select value={filtros.formaPagamento} onChange={(e) => setFiltros((f) => ({ ...f, formaPagamento: e.target.value }))}>
                <option value="">Todas</option>
                {opcoes.formasPagamento.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Condição de pagamento">
              <Select value={filtros.condicaoPagamento} onChange={(e) => setFiltros((f) => ({ ...f, condicaoPagamento: e.target.value }))}>
                <option value="">Todas</option>
                {opcoes.condicoesPagamento.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Valor a partir de">
              <NumInput value={filtros.valorMin} onChange={(v) => setFiltros((f) => ({ ...f, valorMin: v }))} />
            </Field>
            <Field label="Valor até">
              <NumInput value={filtros.valorMax} onChange={(v) => setFiltros((f) => ({ ...f, valorMax: v }))} />
            </Field>
            <Field label="Nota / documento" hint="Ajuda a achar compra lançada sem documento anexado.">
              <Select value={filtros.comDocumento} onChange={(e) => setFiltros((f) => ({ ...f, comDocumento: e.target.value }))}>
                <option value="">Tanto faz</option>
                <option value="sim">Só as que têm documento</option>
                <option value="nao">Só as sem documento</option>
              </Select>
            </Field>
            <Field label="Fornecedor preenchido">
              <Select value={filtros.comFornecedor} onChange={(e) => setFiltros((f) => ({ ...f, comFornecedor: e.target.value }))}>
                <option value="">Tanto faz</option>
                <option value="sim">Só com fornecedor</option>
                <option value="nao">Só sem fornecedor</option>
              </Select>
            </Field>
          </div>
          <div className="field" style={{ marginTop: 4 }}>
            <span className="field-label">Situação</span>
            <div className="stamp-row">
              {['pendente', 'recebido', 'cancelado'].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={'subtab-btn' + (filtros.situacoes.includes(s) ? ' active' : '')}
                  onClick={() => alternarSituacao(s)}
                >
                  {SITUACAO_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* No celular esta faixa vira uma tira que rola de lado (ver
          .categorias-rolagem): 11 categorias empilhadas empurravam os números
          e os gráficos para fora da primeira tela. */}
      <div className="subtab-row categorias-rolagem no-print" style={{ marginTop: 12 }}>
        <button
          type="button"
          className={'subtab-btn' + (categoriasAtivas.length === 0 ? ' active' : '')}
          onClick={() => setCategoriasAtivas([])}
        >
          Todas as categorias
        </button>
        {categorias.map((c) => (
          <button
            key={c.id}
            type="button"
            className={'subtab-btn' + (categoriasAtivas.includes(c.valor) ? ' active' : '')}
            onClick={() => alternarCategoria(c.valor)}
          >
            {c.valor}
          </button>
        ))}
      </div>

      <ChipsFiltros itens={chips} onLimparTudo={chips.length ? limparTudo : undefined} />

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="indicadores-faixa" style={{ marginTop: 14 }}>
        <IndicadorDestaque
          destaque
          Icone={Wallet}
          rotulo="Total gasto no recorte"
          valor={brl(resumo.total)}
          explicacao="Soma do total líquido (já com frete e desconto) de todas as compras que aparecem na lista abaixo, tirando as canceladas."
        />
        <IndicadorDestaque
          Icone={ShoppingCart}
          rotulo="Compras"
          valor={formatQtd(resumo.quantidade)}
          explicacao={resumo.canceladas > 0
            ? `${formatQtd(resumo.canceladas)} cancelada(s) ficaram de fora dos totais.`
            : 'Quantidade de lançamentos de compra no recorte.'}
        />
        <IndicadorDestaque
          Icone={Receipt}
          rotulo="Ticket médio"
          valor={resumo.ticket === null ? '—' : brl(resumo.ticket)}
          explicacao="Quanto custa, em média, cada compra. É o total dividido pelo número de compras."
        />
        <IndicadorDestaque
          Icone={Users}
          rotulo="Fornecedores"
          valor={formatQtd(resumo.fornecedores)}
          explicacao="Quantos fornecedores diferentes aparecem neste recorte."
        />
        <IndicadorDestaque
          Icone={Clock}
          tom={resumo.pendenteQtd > 0 ? 'atencao' : undefined}
          rotulo="Ainda pendente"
          valor={brl(resumo.pendenteValor)}
          explicacao={`${formatQtd(resumo.pendenteQtd)} compra(s) lançada(s) que ainda não foram marcadas como recebidas.`}
        />
      </div>

      <div className="nota-precisao">
        <Info size={14} />
        <span>
          Todos os números desta tela são calculados sobre as{' '}
          <strong>{formatQtd(resumo.quantidade)} compra(s)</strong> que passaram nos filtros
          {resumo.canceladas > 0 && <> — as {formatQtd(resumo.canceladas)} canceladas aparecem na lista, mas não entram em soma, média nem gráfico</>}.
        </span>
      </div>

      <div className="coluna-larga">
        <CartaoGrafico
          titulo={granularidade === 'mes' ? 'Evolução do gasto, mês a mês' : 'Evolução do gasto, dia a dia'}
          explicacao={granularidade === 'mes'
            ? 'Cada ponto é um mês com compra. Meses sem nenhuma compra não aparecem — a linha liga os meses que existiram, não inventa zero.'
            : 'Cada ponto é um dia com compra. Dias sem compra não aparecem no eixo.'}
          refGrafico={refEvolucao}
          altura={270}
          vazio={evolucao.length === 0 ? 'Nenhuma compra no recorte atual.' : null}
          rodape={evolucao.length > 0 ? `${formatQtd(evolucao.length)} ${granularidade === 'mes' ? 'mês(es)' : 'dia(s)'} com compra no recorte.` : null}
        >
          <GraficoEvolucao
            dados={evolucao}
            series={[{ chave: 'total', nome: 'Gasto' }]}
            altura={270}
          />
        </CartaoGrafico>

        <CartaoGrafico
          titulo="Para onde o dinheiro foi"
          explicacao="A divisão do gasto por categoria de compra. O número no meio é o total do recorte."
          refGrafico={refCategorias}
          altura={250}
          vazio={porCategoria.length === 0 ? 'Nenhuma compra no recorte atual.' : null}
        >
          <GraficoRosca dados={porCategoria} altura={250} totalRotulo="Total gasto" />
        </CartaoGrafico>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Com quem a empresa mais gasta</div>
        </div>
        <p className="grafico-explicacao">
          Do maior para o menor, no recorte atual. Clique num fornecedor para abrir a ficha dele.
        </p>
        <BarraRanking
          itens={porFornecedor.slice(0, 10)}
          aoClicar={(item) => item.id && navigate(`/fornecedores/${item.id}`)}
          vazio="Nenhuma compra no recorte atual."
        />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head-linha">
          <div className="card-head">Compras</div>
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
                <ThOrdenavel coluna="categoria" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Categoria</ThOrdenavel>
                <ThOrdenavel coluna="documento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Documento</ThOrdenavel>
                <ThOrdenavel coluna="pagamento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Pagamento</ThOrdenavel>
                <ThOrdenavel coluna="itens" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Itens</ThOrdenavel>
                <ThOrdenavel coluna="total" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Total Líquido</ThOrdenavel>
                <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && compras.length === 0 && <SkeletonLinhasTabela colunas={10} />}
              {tabela.itensPagina.map((c) => (
                <tr key={c.id} className="clickable-row" onClick={() => navigate(`/compras/${c.id}`)}>
                  <td className="mono">#{c.numero}</td>
                  <td className="mono">{dataBr(String(c.data_compra).slice(0, 10))}</td>
                  <td>
                    <span className="cel-dupla">
                      <strong>{c.fornecedor_nome || '—'}</strong>
                      {(c.fornecedor_cidade || c.fornecedor_cpf_cnpj) && (
                        <small>{[c.fornecedor_cidade && `${c.fornecedor_cidade}${c.fornecedor_uf ? `/${c.fornecedor_uf}` : ''}`, c.fornecedor_cpf_cnpj].filter(Boolean).join(' · ')}</small>
                      )}
                    </span>
                  </td>
                  <td>{c.categoria}</td>
                  <td className="mono">{c.numero_documento || '—'}</td>
                  <td>
                    <span className="cel-dupla">
                      <strong>{c.forma_pagamento || '—'}</strong>
                      {c.condicao_pagamento && <small>{c.condicao_pagamento}</small>}
                    </span>
                  </td>
                  <td className="mono">{formatQtd(c.itens_qtd)}</td>
                  <td className="mono">{brl(c.total_liquido)}</td>
                  <td><span className={'stamp sm ' + (SITUACAO_TONE[c.situacao] || 'tone-neutro')}>{SITUACAO_LABEL[c.situacao] || c.situacao}</span></td>
                  <td><ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        {semCompraNenhuma && (
          <EstadoVazio
            Icone={ShoppingCart}
            titulo={chips.length ? 'Nenhuma compra com esses filtros' : 'Nenhuma compra lançada ainda'}
            descricao={chips.length
              ? 'Os filtros que estão valendo aparecem logo acima da faixa de números — remova um deles ou limpe tudo.'
              : 'Aqui aparecem todas as compras da empresa — de matéria-prima a material de escritório.'}
            onAcao={chips.length ? limparTudo : novaCompra}
            acaoLabel={chips.length ? 'Limpar filtros' : 'Nova compra'}
            IconeAcao={chips.length ? undefined : Plus}
          />
        )}
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
