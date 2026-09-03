import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus, ChevronRight, Truck, Users, Wallet, Clock, Info, CheckCircle2,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, dataBr } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, EstadoVazio, ThOrdenavel, Paginacao, BotaoExportar, BotaoRelatorio,
  IndicadorDestaque, CampoBusca, ChipsFiltros, FiltrosAvancados, Select, NumInput, Field,
} from '../components/ui';
import { CartaoGrafico, GraficoRosca, BarraRanking, useRefGrafico, capturarGraficos } from '../components/graficos';
import { useTabela } from '../lib/useTabela';

// Cadastro de fornecedores — agora com o que a operação sabe sobre cada um.
//
// A busca varre nome, razão social, fantasia, CPF/CNPJ, telefone, e-mail,
// endereço, inscrição estadual, chave PIX e observações. Dá pra restringir a
// um campo só quando a pessoa sabe onde procurar, mas o padrão é procurar em
// tudo — que é o que alguém espera ao digitar num campo de busca.
//
// Os números de cada fornecedor (total comprado, ticket médio, forma de
// pagamento mais usada, última compra) vêm somados pelo backend a partir das
// compras já lançadas. Compra cancelada não entra em nenhum deles (REGRA 2).

const COLUNAS_ORDENAVEIS = {
  nome: (f) => f.nome,
  documento: (f) => f.cpf_cnpj,
  telefone: (f) => f.telefone,
  cidade: (f) => `${f.cidade || ''}${f.uf || ''}`,
  categoria: (f) => f.categoria_principal,
  pagamento: (f) => f.forma_pagamento_comum,
  compras: (f) => Number(f.compras_qtd) || 0,
  total: (f) => Number(f.total_comprado) || 0,
  ticket: (f) => (f.ticket_medio === null ? -1 : Number(f.ticket_medio)),
  ultima: (f) => (f.ultima_compra ? new Date(f.ultima_compra).getTime() : 0),
  ativo: (f) => (f.ativo ? 1 : 0),
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nome / Razão social', valor: (f) => f.nome },
  { rotulo: 'Nome fantasia', valor: (f) => f.nome_fantasia || '' },
  { rotulo: 'Tipo', valor: (f) => (f.tipo_pessoa === 'PF' ? 'Pessoa física' : 'Pessoa jurídica') },
  { rotulo: 'CPF/CNPJ', valor: (f) => f.cpf_cnpj || '' },
  { rotulo: 'Inscrição estadual', valor: (f) => (f.ie_isento ? 'Isento' : f.ie || '') },
  { rotulo: 'Telefone', valor: (f) => f.telefone || '' },
  { rotulo: 'E-mail', valor: (f) => f.email || '' },
  { rotulo: 'Cidade', valor: (f) => f.cidade || '' },
  { rotulo: 'UF', valor: (f) => f.uf || '' },
  { rotulo: 'Categoria principal', valor: (f) => f.categoria_principal || '' },
  { rotulo: 'Condição de pagamento padrão', valor: (f) => f.condicao_pagamento_padrao || '' },
  { rotulo: 'Forma de pagamento mais usada', valor: (f) => f.forma_pagamento_comum || '' },
  { rotulo: 'Chave PIX', valor: (f) => f.chave_pix || '' },
  { rotulo: 'Compras', valor: (f) => formatQtd(f.compras_qtd) },
  { rotulo: 'Total comprado', valor: (f) => brl(f.total_comprado) },
  { rotulo: 'Ticket médio', valor: (f) => (f.ticket_medio === null ? '—' : brl(f.ticket_medio)) },
  { rotulo: 'Última compra', valor: (f) => (f.ultima_compra ? dataBr(String(f.ultima_compra).slice(0, 10)) : '—') },
  { rotulo: 'Ativo', valor: (f) => (f.ativo ? 'Sim' : 'Não') },
];

const FILTROS_VAZIOS = {
  categoria: '',
  uf: '',
  cidade: '',
  tipoPessoa: '',
  ativo: '',
  formaPagamento: '',
  condicaoPagamento: '',
  comCompras: '',
  gastoMin: '',
  gastoMax: '',
  semComprarDias: '',
};

export default function FornecedoresListPage() {
  const navigate = useNavigate();

  const [fornecedores, setFornecedores] = useState([]);
  const [opcoes, setOpcoes] = useState({ ufs: [], cidades: [], categorias: [], formasPagamento: [], condicoesPagamento: [], camposBusca: [] });
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [campo, setCampo] = useState('');
  const [filtros, setFiltros] = useState(FILTROS_VAZIOS);
  const [painelAberto, setPainelAberto] = useState(false);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  const refCategorias = useRefGrafico();

  useEffect(() => {
    api.get('/fornecedores/opcoes').then(setOpcoes).catch(() => {});
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (buscaAplicada.trim()) p.set('busca', buscaAplicada.trim());
    if (campo) p.set('campo', campo);
    if (filtros.categoria) p.set('categoria', filtros.categoria);
    if (filtros.uf) p.set('uf', filtros.uf);
    if (filtros.cidade) p.set('cidade', filtros.cidade);
    if (filtros.tipoPessoa) p.set('tipo_pessoa', filtros.tipoPessoa);
    if (filtros.ativo) p.set('ativo', filtros.ativo);
    if (filtros.formaPagamento) p.set('forma_pagamento', filtros.formaPagamento);
    if (filtros.condicaoPagamento) p.set('condicao_pagamento', filtros.condicaoPagamento);
    if (filtros.comCompras) p.set('com_compras', filtros.comCompras);
    if (filtros.gastoMin !== '' && filtros.gastoMin !== null) p.set('gasto_min', filtros.gastoMin);
    if (filtros.gastoMax !== '' && filtros.gastoMax !== null) p.set('gasto_max', filtros.gastoMax);
    if (filtros.semComprarDias) p.set('sem_comprar_dias', filtros.semComprarDias);
    return p;
  }, [buscaAplicada, campo, filtros]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`/fornecedores?${params.toString()}`)
      .then(setFornecedores)
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }, [params]);

  const tabela = useTabela(fornecedores, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'total', direcaoPadrao: 'desc' });

  const resumo = useMemo(() => {
    const total = fornecedores.reduce((s, f) => s + Number(f.total_comprado || 0), 0);
    const ativos = fornecedores.filter((f) => f.ativo).length;
    const comCompra = fornecedores.filter((f) => Number(f.compras_qtd) > 0);
    const parados = comCompra.filter((f) => (f.dias_sem_comprar ?? 0) > 90);
    const pendente = fornecedores.reduce((s, f) => s + Number(f.total_pendente || 0), 0);
    return { total, ativos, comCompra: comCompra.length, parados: parados.length, pendente };
  }, [fornecedores]);

  const porCategoria = useMemo(() => {
    const mapa = new Map();
    for (const f of fornecedores) {
      const chave = f.categoria_principal || '(sem categoria)';
      const atual = mapa.get(chave) || { rotulo: chave, valor: 0 };
      atual.valor += Number(f.total_comprado || 0);
      mapa.set(chave, atual);
    }
    return [...mapa.values()].filter((c) => c.valor > 0).sort((a, b) => b.valor - a.valor);
  }, [fornecedores]);

  const porForma = useMemo(() => {
    const mapa = new Map();
    for (const f of fornecedores) {
      if (!f.forma_pagamento_comum) continue;
      const atual = mapa.get(f.forma_pagamento_comum) || { rotulo: f.forma_pagamento_comum, valor: 0, quantidade: 0 };
      atual.valor += Number(f.total_comprado || 0);
      atual.quantidade += 1;
      mapa.set(f.forma_pagamento_comum, atual);
    }
    return [...mapa.values()]
      .sort((a, b) => b.valor - a.valor)
      .map((f) => ({ ...f, detalhe: `${formatQtd(f.quantidade)} fornecedor(es) pagos assim` }));
  }, [fornecedores]);

  const maiores = useMemo(() => (
    [...fornecedores]
      .filter((f) => Number(f.total_comprado) > 0)
      .sort((a, b) => Number(b.total_comprado) - Number(a.total_comprado))
      .slice(0, 10)
      .map((f) => ({
        id: f.id,
        rotulo: f.nome,
        detalhe: `${formatQtd(f.compras_qtd)} compra(s) · ${f.forma_pagamento_comum || 'pagamento não informado'}`,
        valor: Number(f.total_comprado),
      }))
  ), [fornecedores]);

  // ---- filtros ativos ------------------------------------------------------
  const rotuloCampo = opcoes.camposBusca.find((c) => c.chave === campo)?.rotulo;
  const chips = [];
  if (buscaAplicada.trim()) {
    chips.push({
      chave: 'busca',
      rotulo: rotuloCampo ? `Busca em ${rotuloCampo}` : 'Busca',
      valor: buscaAplicada.trim(),
      onRemover: () => { setBusca(''); setBuscaAplicada(''); },
    });
  }
  const rotulos = {
    categoria: 'Categoria', uf: 'UF', cidade: 'Cidade', tipoPessoa: 'Tipo',
    formaPagamento: 'Paga mais em', condicaoPagamento: 'Condição padrão',
  };
  for (const chave of Object.keys(rotulos)) {
    if (filtros[chave]) {
      chips.push({
        chave, rotulo: rotulos[chave],
        valor: chave === 'tipoPessoa' ? (filtros[chave] === 'PF' ? 'Pessoa física' : 'Pessoa jurídica') : filtros[chave],
        onRemover: () => setFiltros((f) => ({ ...f, [chave]: '' })),
      });
    }
  }
  if (filtros.ativo) chips.push({ chave: 'ativo', rotulo: 'Situação', valor: filtros.ativo === 'sim' ? 'Só ativos' : 'Só inativos', onRemover: () => setFiltros((f) => ({ ...f, ativo: '' })) });
  if (filtros.comCompras) chips.push({ chave: 'comCompras', rotulo: 'Histórico', valor: filtros.comCompras === 'sim' ? 'Com compras' : 'Sem nenhuma compra', onRemover: () => setFiltros((f) => ({ ...f, comCompras: '' })) });
  if (filtros.gastoMin !== '') chips.push({ chave: 'gmin', rotulo: 'Comprado a partir de', valor: brl(filtros.gastoMin), onRemover: () => setFiltros((f) => ({ ...f, gastoMin: '' })) });
  if (filtros.gastoMax !== '') chips.push({ chave: 'gmax', rotulo: 'Comprado até', valor: brl(filtros.gastoMax), onRemover: () => setFiltros((f) => ({ ...f, gastoMax: '' })) });
  if (filtros.semComprarDias) chips.push({ chave: 'parado', rotulo: 'Sem comprar há mais de', valor: `${filtros.semComprarDias} dias`, onRemover: () => setFiltros((f) => ({ ...f, semComprarDias: '' })) });

  const avancadosAtivos = Object.entries(filtros).filter(([, v]) => v !== '' && v !== null).length;

  function limparTudo() {
    setBusca('');
    setBuscaAplicada('');
    setCampo('');
    setFiltros(FILTROS_VAZIOS);
  }

  async function montarRelatorio(tipo) {
    if (fornecedores.length === 0) return null;
    const completo = tipo === 'completo';
    const graficos = await capturarGraficos([{ titulo: 'Gasto por categoria de fornecedor', ref: refCategorias }]);
    const totalGeral = resumo.total;

    const secoes = [{
      titulo: 'Maiores fornecedores',
      descricao: 'Ordenado pelo total já comprado, considerando todas as compras não canceladas do histórico.',
      colunas: [
        { rotulo: 'Fornecedor', tipo: 'texto' },
        { rotulo: 'Cidade/UF', tipo: 'texto', larguraExcel: 22 },
        { rotulo: 'Compras', tipo: 'numero' },
        { rotulo: 'Total comprado', tipo: 'moeda' },
        { rotulo: '% do total', tipo: 'percentual' },
        { rotulo: 'Paga mais em', tipo: 'texto', larguraExcel: 20 },
      ],
      linhas: [...fornecedores]
        .sort((a, b) => Number(b.total_comprado) - Number(a.total_comprado))
        .slice(0, completo ? fornecedores.length : 15)
        .map((f) => [
          f.nome,
          [f.cidade, f.uf].filter(Boolean).join('/') || '',
          f.compras_qtd,
          f.total_comprado,
          totalGeral ? Number(f.total_comprado) / totalGeral : null,
          f.forma_pagamento_comum || '',
        ]),
      totais: ['Total', '', fornecedores.reduce((s, f) => s + Number(f.compras_qtd || 0), 0), totalGeral, totalGeral ? 1 : null],
    }];

    if (porForma.length) {
      secoes.push({
        titulo: 'Como a empresa paga cada fornecedor',
        descricao: 'Agrupado pela forma de pagamento MAIS USADA nas compras reais de cada fornecedor — não pelo campo do cadastro.',
        colunas: [
          { rotulo: 'Forma de pagamento', tipo: 'texto' },
          { rotulo: 'Fornecedores', tipo: 'numero' },
          { rotulo: 'Total comprado', tipo: 'moeda' },
        ],
        linhas: porForma.map((f) => [f.rotulo, f.quantidade, f.valor]),
      });
    }

    if (completo) {
      secoes.push({
        titulo: 'Cadastro completo',
        descricao: 'Todos os fornecedores que passaram nos filtros, com o cadastro inteiro e os números de compra.',
        colunas: [
          { rotulo: 'Nome / Razão social', tipo: 'texto' },
          { rotulo: 'Nome fantasia', tipo: 'texto' },
          { rotulo: 'Tipo', tipo: 'texto', larguraExcel: 16 },
          { rotulo: 'CPF/CNPJ', tipo: 'texto', larguraExcel: 20 },
          { rotulo: 'Inscrição estadual', tipo: 'texto', larguraExcel: 18 },
          { rotulo: 'Telefone', tipo: 'texto', larguraExcel: 18 },
          { rotulo: 'E-mail', tipo: 'texto', larguraExcel: 28 },
          { rotulo: 'Endereço', tipo: 'texto', larguraExcel: 40 },
          { rotulo: 'Cidade', tipo: 'texto', larguraExcel: 20 },
          { rotulo: 'UF', tipo: 'texto', larguraExcel: 6 },
          { rotulo: 'CEP', tipo: 'texto', larguraExcel: 12 },
          { rotulo: 'Categoria principal', tipo: 'texto', larguraExcel: 24 },
          { rotulo: 'Condição padrão', tipo: 'texto', larguraExcel: 20 },
          { rotulo: 'Paga mais em', tipo: 'texto', larguraExcel: 20 },
          { rotulo: 'Chave PIX', tipo: 'texto', larguraExcel: 26 },
          { rotulo: 'Compras', tipo: 'numero' },
          { rotulo: 'Total comprado', tipo: 'moeda' },
          { rotulo: 'Ticket médio', tipo: 'moeda' },
          { rotulo: 'Primeira compra', tipo: 'data' },
          { rotulo: 'Última compra', tipo: 'data' },
          { rotulo: 'Ativo', tipo: 'texto', larguraExcel: 8 },
        ],
        linhas: fornecedores.map((f) => [
          f.nome, f.nome_fantasia || '', f.tipo_pessoa === 'PF' ? 'Pessoa física' : 'Pessoa jurídica',
          f.cpf_cnpj || '', f.ie_isento ? 'Isento' : f.ie || '', f.telefone || '', f.email || '',
          [f.logradouro, f.numero, f.complemento, f.bairro].filter(Boolean).join(', '),
          f.cidade || '', f.uf || '', f.cep || '', f.categoria_principal || '',
          f.condicao_pagamento_padrao || '', f.forma_pagamento_comum || '', f.chave_pix || '',
          f.compras_qtd, f.total_comprado, f.ticket_medio,
          f.primeira_compra, f.ultima_compra, f.ativo ? 'Sim' : 'Não',
        ]),
      });

      const parados = fornecedores.filter((f) => Number(f.compras_qtd) > 0 && (f.dias_sem_comprar ?? 0) > 90);
      if (parados.length) {
        secoes.push({
          titulo: 'Fornecedores parados há mais de 90 dias',
          descricao: 'Já tiveram compra, mas não recebem pedido há mais de três meses. Não é um problema por si só — é uma lista para conferir.',
          colunas: [
            { rotulo: 'Fornecedor', tipo: 'texto' },
            { rotulo: 'Última compra', tipo: 'data' },
            { rotulo: 'Dias sem comprar', tipo: 'numero' },
            { rotulo: 'Total já comprado', tipo: 'moeda' },
          ],
          linhas: parados
            .sort((a, b) => (b.dias_sem_comprar || 0) - (a.dias_sem_comprar || 0))
            .map((f) => [f.nome, f.ultima_compra, f.dias_sem_comprar, f.total_comprado]),
        });
      }
    }

    return {
      nomeBase: `fornecedores-${completo ? 'completo' : 'resumo'}`,
      titulo: 'Fornecedores',
      subtitulo: completo ? 'Cadastro completo e histórico de compra' : 'Resumo executivo',
      periodoTexto: 'Histórico completo de compras registrado no sistema',
      filtros: chips.map((c) => `${c.rotulo}: ${c.valor}`),
      indicadores: [
        { rotulo: 'Fornecedores na lista', valor: formatQtd(fornecedores.length) },
        { rotulo: 'Ativos', valor: formatQtd(resumo.ativos) },
        { rotulo: 'Total já comprado', valor: brl(resumo.total) },
        { rotulo: 'Parados há +90 dias', valor: formatQtd(resumo.parados), tom: resumo.parados > 0 ? 'negativo' : 'positivo' },
      ],
      graficos,
      secoes,
      notas: [
        'Compra cancelada não entra em nenhum total, ticket médio ou "forma de pagamento mais usada".',
        '"Paga mais em" é a forma de pagamento que mais aparece nas compras reais daquele fornecedor, não o campo preenchido no cadastro.',
        'Fornecedor sem nenhuma compra aparece com total zero e ticket médio "—": o ticket não existe, não é zero.',
      ],
      abaUnica: !completo,
      orientacao: completo ? 'l' : 'p',
      rodape: 'HBN Hub · módulo Compras — cadastro de fornecedores.',
    };
  }

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Fornecedores</h2>
          <p className="page-sub">
            Quem a empresa compra, quanto já foi comprado de cada um e como cada um costuma ser pago.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <BotaoExportar
            nomeBase="fornecedores"
            colunas={COLUNAS_EXPORTACAO}
            itens={tabela.itensOrdenados}
            disabled={tabela.totalItens === 0}
          />
          <BotaoRelatorio
            montar={montarRelatorio}
            disabled={fornecedores.length === 0}
            rotulo="Relatórios"
            descricaoResumo="Os indicadores, o gráfico por categoria e o ranking dos maiores fornecedores."
            descricaoCompleto="O cadastro inteiro campo a campo, mais o histórico de compra e os fornecedores parados."
          />
          <Link to="/fornecedores/novo" className="btn btn-primary"><Plus size={14} /> Novo fornecedor</Link>
        </div>
      </div>

      <div style={{ marginBottom: 12 }} className="no-print">
        <CampoBusca
          valor={busca}
          onChange={setBusca}
          onSubmit={() => setBuscaAplicada(busca)}
          campos={opcoes.camposBusca}
          campo={campo}
          onCampo={(v) => { setCampo(v); setBuscaAplicada(busca); }}
          placeholder="Nome, razão social, fantasia, CPF/CNPJ, telefone, e-mail, cidade, PIX…"
        />
      </div>

      <div className="filtros-barra no-print">
        <FiltrosAvancados ativos={avancadosAtivos} aberto={painelAberto} onAlternar={() => setPainelAberto((a) => !a)} />
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <span className="page-sub" style={{ margin: 0 }}>{fornecedores.length.toLocaleString('pt-BR')} fornecedor(es)</span>
        </div>
      </div>

      {painelAberto && (
        <div className="card filtros-avancados-painel no-print">
          <div className="card-head">Filtrar por</div>
          <div className="form-grid">
            <Field label="Categoria principal">
              <Select value={filtros.categoria} onChange={(e) => setFiltros((f) => ({ ...f, categoria: e.target.value }))}>
                <option value="">Todas</option>
                {opcoes.categorias.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Forma de pagamento mais usada" hint="Vem das compras reais, não do cadastro.">
              <Select value={filtros.formaPagamento} onChange={(e) => setFiltros((f) => ({ ...f, formaPagamento: e.target.value }))}>
                <option value="">Todas</option>
                {opcoes.formasPagamento.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Condição de pagamento padrão">
              <Select value={filtros.condicaoPagamento} onChange={(e) => setFiltros((f) => ({ ...f, condicaoPagamento: e.target.value }))}>
                <option value="">Todas</option>
                {opcoes.condicoesPagamento.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="UF">
              <Select value={filtros.uf} onChange={(e) => setFiltros((f) => ({ ...f, uf: e.target.value }))}>
                <option value="">Todas</option>
                {opcoes.ufs.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Cidade">
              <Select value={filtros.cidade} onChange={(e) => setFiltros((f) => ({ ...f, cidade: e.target.value }))}>
                <option value="">Todas</option>
                {opcoes.cidades.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Tipo de pessoa">
              <Select value={filtros.tipoPessoa} onChange={(e) => setFiltros((f) => ({ ...f, tipoPessoa: e.target.value }))}>
                <option value="">Todos</option>
                <option value="PJ">Pessoa jurídica</option>
                <option value="PF">Pessoa física</option>
              </Select>
            </Field>
            <Field label="Cadastro">
              <Select value={filtros.ativo} onChange={(e) => setFiltros((f) => ({ ...f, ativo: e.target.value }))}>
                <option value="">Ativos e inativos</option>
                <option value="sim">Só ativos</option>
                <option value="nao">Só inativos</option>
              </Select>
            </Field>
            <Field label="Histórico de compra">
              <Select value={filtros.comCompras} onChange={(e) => setFiltros((f) => ({ ...f, comCompras: e.target.value }))}>
                <option value="">Tanto faz</option>
                <option value="sim">Só quem já teve compra</option>
                <option value="nao">Só quem nunca teve compra</option>
              </Select>
            </Field>
            <Field label="Sem comprar há mais de">
              <Select value={filtros.semComprarDias} onChange={(e) => setFiltros((f) => ({ ...f, semComprarDias: e.target.value }))}>
                <option value="">Tanto faz</option>
                <option value="30">30 dias</option>
                <option value="90">90 dias</option>
                <option value="180">180 dias</option>
                <option value="365">1 ano</option>
              </Select>
            </Field>
            <Field label="Total comprado a partir de">
              <NumInput value={filtros.gastoMin} onChange={(v) => setFiltros((f) => ({ ...f, gastoMin: v }))} />
            </Field>
            <Field label="Total comprado até">
              <NumInput value={filtros.gastoMax} onChange={(v) => setFiltros((f) => ({ ...f, gastoMax: v }))} />
            </Field>
          </div>
        </div>
      )}

      <ChipsFiltros itens={chips} onLimparTudo={chips.length ? limparTudo : undefined} />

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="indicadores-faixa" style={{ marginTop: 14 }}>
        <IndicadorDestaque
          destaque
          Icone={Wallet}
          rotulo="Total já comprado"
          valor={brl(resumo.total)}
          explicacao="Somando todas as compras não canceladas dos fornecedores desta lista, desde sempre."
        />
        <IndicadorDestaque
          Icone={Users}
          rotulo="Fornecedores na lista"
          valor={formatQtd(fornecedores.length)}
          explicacao={`${formatQtd(resumo.comCompra)} já tiveram pelo menos uma compra lançada.`}
        />
        <IndicadorDestaque
          Icone={CheckCircle2}
          rotulo="Cadastros ativos"
          valor={formatQtd(resumo.ativos)}
          explicacao="Fornecedor inativo continua no sistema e no histórico, só não deveria receber pedido novo."
        />
        <IndicadorDestaque
          Icone={Clock}
          tom={resumo.parados > 0 ? 'atencao' : undefined}
          rotulo="Parados há +90 dias"
          valor={formatQtd(resumo.parados)}
          explicacao="Já compraram alguma vez, mas não recebem pedido há mais de três meses."
        />
      </div>

      <div className="coluna-larga">
        <div className="card">
          <div className="card-head">Maiores fornecedores</div>
          <p className="grafico-explicacao">
            Pelo total já comprado, do maior para o menor. Clique para abrir a ficha.
          </p>
          <BarraRanking
            itens={maiores}
            aoClicar={(item) => navigate(`/fornecedores/${item.id}`)}
            vazio="Nenhum fornecedor com compra lançada nesta lista."
          />
        </div>

        <CartaoGrafico
          titulo="Gasto por categoria de fornecedor"
          explicacao="Pela categoria principal do cadastro. Fornecedor sem categoria aparece como “(sem categoria)”."
          refGrafico={refCategorias}
          altura={240}
          vazio={porCategoria.length === 0 ? 'Nenhum fornecedor com compra lançada.' : null}
        >
          <GraficoRosca dados={porCategoria} altura={240} totalRotulo="Total comprado" />
        </CartaoGrafico>
      </div>

      {porForma.length > 0 && (
        <div className="card">
          <div className="card-head">Como a empresa paga</div>
          <p className="grafico-explicacao">
            Cada fornecedor entra pela forma de pagamento que <strong>mais aparece nas compras dele</strong> —
            não pelo que está escrito no cadastro. O valor é o total já comprado desses fornecedores.
          </p>
          <BarraRanking itens={porForma} vazio="Nenhuma compra com forma de pagamento preenchida." />
        </div>
      )}

      <div className="nota-precisao">
        <Info size={14} />
        <span>
          Os números por fornecedor consideram <strong>todo o histórico</strong> de compras, não um período —
          e compra cancelada fica de fora de soma, média e da forma de pagamento mais usada.
        </span>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Cadastro</div>
          <span className="page-sub" style={{ margin: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</span>
        </div>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="nome" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Fornecedor</ThOrdenavel>
                <ThOrdenavel coluna="documento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>CPF/CNPJ</ThOrdenavel>
                <ThOrdenavel coluna="telefone" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Contato</ThOrdenavel>
                <ThOrdenavel coluna="cidade" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cidade</ThOrdenavel>
                <ThOrdenavel coluna="categoria" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Categoria</ThOrdenavel>
                <ThOrdenavel coluna="pagamento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Paga mais em</ThOrdenavel>
                <ThOrdenavel coluna="compras" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Compras</ThOrdenavel>
                <ThOrdenavel coluna="total" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Total comprado</ThOrdenavel>
                <ThOrdenavel coluna="ticket" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Ticket médio</ThOrdenavel>
                <ThOrdenavel coluna="ultima" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Última compra</ThOrdenavel>
                <ThOrdenavel coluna="ativo" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cadastro</ThOrdenavel>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && fornecedores.length === 0 && <SkeletonLinhasTabela colunas={12} />}
              {tabela.itensPagina.map((f) => (
                <tr key={f.id} className="clickable-row" onClick={() => navigate(`/fornecedores/${f.id}`)}>
                  <td>
                    <span className="cel-dupla">
                      <strong>{f.nome}</strong>
                      {f.nome_fantasia && <small>{f.nome_fantasia}</small>}
                    </span>
                  </td>
                  <td className="mono">{f.cpf_cnpj || '—'}</td>
                  <td>
                    <span className="cel-dupla">
                      <strong className="mono">{f.telefone || '—'}</strong>
                      {f.email && <small>{f.email}</small>}
                    </span>
                  </td>
                  <td>{f.cidade ? `${f.cidade}${f.uf ? `/${f.uf}` : ''}` : '—'}</td>
                  <td>{f.categoria_principal || '—'}</td>
                  <td>
                    <span className="cel-dupla">
                      <strong>{f.forma_pagamento_comum || '—'}</strong>
                      {f.condicao_pagamento_padrao && <small>padrão: {f.condicao_pagamento_padrao}</small>}
                    </span>
                  </td>
                  <td className="mono">{formatQtd(f.compras_qtd)}</td>
                  <td className="mono">{brl(f.total_comprado)}</td>
                  <td className="mono">{f.ticket_medio === null ? '—' : brl(f.ticket_medio)}</td>
                  <td className="mono">
                    {f.ultima_compra ? (
                      <span className="cel-dupla">
                        <strong className="mono">{dataBr(String(f.ultima_compra).slice(0, 10))}</strong>
                        {f.dias_sem_comprar > 90 && <small>há {formatQtd(f.dias_sem_comprar)} dias</small>}
                      </span>
                    ) : '—'}
                  </td>
                  <td>
                    <span className={'stamp sm ' + (f.ativo ? 'tone-saudavel' : 'tone-neutro')}>{f.ativo ? 'Ativo' : 'Inativo'}</span>
                  </td>
                  <td>
                    <Link to={`/fornecedores/${f.id}`} className="icon-btn" style={{ color: 'var(--ink-soft)' }} onClick={(e) => e.stopPropagation()}>
                      <ChevronRight size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        {!loading && fornecedores.length === 0 && (
          <EstadoVazio
            Icone={Truck}
            titulo={chips.length ? 'Nenhum fornecedor encontrado' : 'Nenhum fornecedor cadastrado ainda'}
            descricao={chips.length
              ? 'A busca varre nome, razão social, fantasia, CPF/CNPJ, telefone, e-mail, endereço, PIX e observações. Se não achou, tente um pedaço menor do termo ou limpe os filtros.'
              : 'Aqui aparecem os fornecedores usados nos lançamentos de compra.'}
            href={chips.length ? undefined : '/fornecedores/novo'}
            onAcao={chips.length ? limparTudo : undefined}
            acaoLabel={chips.length ? 'Limpar filtros' : 'Novo fornecedor'}
            IconeAcao={chips.length ? undefined : Plus}
          />
        )}
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
