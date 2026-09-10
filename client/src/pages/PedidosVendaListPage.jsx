import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, ClipboardList, ChevronRight, User, Tags, LayoutGrid, List as ListIcon,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, dataBr } from '../lib/format';
import {
  Select, SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio,
  FiltrosAvancados, ChipsFiltros, AvisoDeFalha, Skeleton,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import DataTable from '../components/DataTable';
import { useTabela } from '../lib/useTabela';
import { novaAba } from '../lib/novaAba';

// Lista de pedidos de venda direta — repaginada em 09/09/2026.
//
// Separada de PedidosListPage (que continua servindo o Marketplace) porque as
// duas telas passaram a fazer perguntas diferentes: lá é "o que a plataforma
// mandou hoje"; aqui é "quem vendeu o quê, por qual tabela, e quanto ainda
// está em aberto". Manter as duas no mesmo componente significaria uma fila
// crescente de `isMarketplace ? … : …` em cada linha.
//
// No celular a lista é de CARTÕES, não de tabela: linha de tabela com sete
// colunas rola de lado e esconde justamente o valor.

const SITUACAO_TONE = { aberto: 'tone-atencao', faturado: 'tone-saudavel', cancelado: 'tone-prejuizo' };
const SITUACAO_LABEL = { aberto: 'Aberto', faturado: 'Faturado', cancelado: 'Cancelado' };

const PRESET_PADRAO = PRESETS_PERIODO.find((p) => p.chave === '30dias').calcular();

const COLUNAS_ORDENAVEIS = {
  numero: (p) => Number(p.numero) || 0,
  data: (p) => new Date(p.data_pedido).getTime(),
  cliente: (p) => p.cliente_nome,
  vendedor: (p) => p.vendedor_nome || p.vendedor,
  canal: (p) => p.canal_venda,
  tabela: (p) => p.tabela_preco_nome,
  qtd: (p) => Number(p.quantidade_pecas) || 0,
  total: (p) => Number(p.total_liquido) || 0,
  situacao: (p) => p.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (p) => p.numero },
  { rotulo: 'Data', valor: (p) => new Date(p.data_pedido).toLocaleDateString('pt-BR') },
  { rotulo: 'Cliente', valor: (p) => p.cliente_nome || '' },
  { rotulo: 'Vendedor', valor: (p) => p.vendedor_nome || p.vendedor || '' },
  { rotulo: 'Canal', valor: (p) => p.canal_venda || '' },
  { rotulo: 'Tabela de preço', valor: (p) => p.tabela_preco_nome || '' },
  { rotulo: 'Forma de pagamento', valor: (p) => p.forma_pagamento || '' },
  { rotulo: 'Qtd. peças', valor: (p) => formatQtd(p.quantidade_pecas) },
  { rotulo: 'Total bruto', valor: (p) => brl(p.total_bruto) },
  { rotulo: 'Descontos', valor: (p) => brl(p.total_desconto) },
  { rotulo: 'Total líquido', valor: (p) => brl(p.total_liquido) },
  { rotulo: 'Situação', valor: (p) => SITUACAO_LABEL[p.situacao] || p.situacao },
];

export default function PedidosVendaListPage() {
  const navigate = useNavigate();
  const [pedidos, setPedidos] = useState([]);
  const [vendedores, setVendedores] = useState([]);
  const [tabelas, setTabelas] = useState([]);
  const [listas, setListas] = useState(null);

  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('');
  const [vendedorId, setVendedorId] = useState('');
  const [tabelaId, setTabelaId] = useState('');
  const [canal, setCanal] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('');
  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(PRESET_PADRAO);
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [modo, setModo] = useState(() => {
    try { return localStorage.getItem('hbn_vendas_modo') || 'cartoes'; } catch { return 'cartoes'; }
  });

  const [loading, setLoading] = useState(true);
  const [erroCarga, setErroCarga] = useState('');
  const [criando, setCriando] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/vendedores').catch(() => []),
      api.get('/tabelas-preco').catch(() => []),
      api.get('/listas').catch(() => null),
    ]).then(([v, t, l]) => { setVendedores(v); setTabelas(t); setListas(l); });
  }, []);

  useEffect(() => {
    try { localStorage.setItem('hbn_vendas_modo', modo); } catch { /* preferência de tela, não é crítico */ }
  }, [modo]);

  // `geracao` descarta resposta de um filtro que já não é o que está na tela.
  // O atraso da busca evita chamadas demais, não respostas fora de ordem:
  // trocar o período duas vezes rápido podia deixar a lista mostrando o
  // resultado do filtro ANTIGO, com a barra de filtros dizendo outra coisa.
  const geracao = useRef(0);

  function load() {
    const minha = ++geracao.current;
    setLoading(true);
    setErroCarga('');
    const params = new URLSearchParams({ origem: 'manual' });
    if (busca) params.set('busca', busca);
    if (situacao) params.set('situacao', situacao);
    if (vendedorId) params.set('vendedor_id', vendedorId);
    if (tabelaId) params.set('tabela_preco_id', tabelaId);
    if (canal) params.set('canal_venda', canal);
    if (formaPagamento) params.set('forma_pagamento', formaPagamento);
    if (dataInicio) params.set('data_inicio', dataInicio);
    if (dataFim) params.set('data_fim', dataFim);
    api.get(`/pedidos?${params.toString()}`)
      .then((data) => { if (minha === geracao.current) setPedidos(data); })
      .catch((e) => { if (minha === geracao.current) setErroCarga(e.message); })
      .finally(() => { if (minha === geracao.current) setLoading(false); });
  }

  // Busca por texto entra sozinha, com um atraso curto para não disparar uma
  // chamada por tecla.
  useEffect(() => {
    const t = setTimeout(load, busca ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busca, situacao, vendedorId, tabelaId, canal, formaPagamento, dataInicio, dataFim]);

  const tabela = useTabela(pedidos, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  const resumo = useMemo(() => {
    const validos = pedidos.filter((p) => p.situacao !== 'cancelado');
    const abertos = validos.filter((p) => p.situacao === 'aberto');
    const faturados = validos.filter((p) => p.situacao === 'faturado');
    const soma = (lista) => lista.reduce((s, p) => s + (Number(p.total_liquido) || 0), 0);
    return {
      pedidos: validos.length,
      total: soma(validos),
      pecas: validos.reduce((s, p) => s + (Number(p.quantidade_pecas) || 0), 0),
      emAberto: soma(abertos),
      abertos: abertos.length,
      faturado: soma(faturados),
      ticket: validos.length > 0 ? soma(validos) / validos.length : 0,
      semVendedor: validos.filter((p) => !p.vendedor_id).length,
    };
  }, [pedidos]);

  const chips = useMemo(() => {
    const itens = [];
    if (situacao) itens.push({ chave: 'situacao', rotulo: 'Situação', valor: SITUACAO_LABEL[situacao], onRemover: () => setSituacao('') });
    if (vendedorId) {
      itens.push({
        chave: 'vendedor',
        rotulo: 'Vendedor',
        valor: vendedores.find((v) => String(v.id) === String(vendedorId))?.nome || vendedorId,
        onRemover: () => setVendedorId(''),
      });
    }
    if (tabelaId) {
      itens.push({
        chave: 'tabela',
        rotulo: 'Tabela',
        valor: tabelas.find((t) => String(t.id) === String(tabelaId))?.nome || tabelaId,
        onRemover: () => setTabelaId(''),
      });
    }
    if (canal) itens.push({ chave: 'canal', rotulo: 'Canal', valor: canal, onRemover: () => setCanal('') });
    if (formaPagamento) itens.push({ chave: 'forma', rotulo: 'Pagamento', valor: formaPagamento, onRemover: () => setFormaPagamento('') });
    return itens;
  }, [situacao, vendedorId, tabelaId, canal, formaPagamento, vendedores, tabelas]);

  function limparFiltros() {
    setSituacao(''); setVendedorId(''); setTabelaId(''); setCanal(''); setFormaPagamento('');
  }

  async function novoPedido() {
    setCriando(true);
    try {
      const data = await api.post('/pedidos', {});
      navigate(`/pedidos/${data.pedido.id}`);
    } catch (err) {
      setErroCarga(err.message);
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="page-wide">
      <div className="pagina-topo">
        <div>
          <h1>Pedidos de Venda</h1>
          <p className="page-sub">
            As vendas lançadas por aqui — balcão, WhatsApp, atacado e viagem. Cada pedido guarda
            quem vendeu e com qual tabela de preço, e é isso que alimenta a comissão e a lucratividade.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <div className="view-toggle">
            <button
              type="button"
              className={modo === 'cartoes' ? 'active' : ''}
              onClick={() => setModo('cartoes')}
              title="Ver em cartões"
            >
              <LayoutGrid size={14} /> Cartões
            </button>
            <button
              type="button"
              className={modo === 'tabela' ? 'active' : ''}
              onClick={() => setModo('tabela')}
              title="Ver em tabela"
            >
              <ListIcon size={14} /> Tabela
            </button>
          </div>
          <BotaoExportar
            nomeBase="pedidos-de-venda"
            colunas={COLUNAS_EXPORTACAO}
            itens={tabela.itensOrdenados}
            disabled={tabela.totalItens === 0}
          />
          <button className="btn btn-primary" onClick={novoPedido} disabled={criando}>
            <Plus size={14} /> {criando ? 'Abrindo…' : 'Nova venda'}
          </button>
        </div>
      </div>

      <div className="stat-strip">
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Vendido no período</span>
            <span className="stat-card-value">{brl(resumo.total)}</span>
            <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
              {formatQtd(resumo.pedidos)} pedido(s) · {formatQtd(resumo.pecas)} peça(s)
            </span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Já faturado</span>
            <span className="stat-card-value">{brl(resumo.faturado)}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Ainda em aberto</span>
            <span className="stat-card-value">{brl(resumo.emAberto)}</span>
            <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
              {formatQtd(resumo.abertos)} pedido(s) sem faturar
            </span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Ticket médio</span>
            <span className="stat-card-value">{brl(resumo.ticket)}</span>
          </div>
        </div>
      </div>

      <div className="filtros-barra">
        <PeriodoFiltro inicio={dataInicio} fim={dataFim} onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })} />
        <div className="filtros-barra-busca">
          <Search size={14} />
          <input
            placeholder="Cliente, vendedor, telefone ou nº do pedido"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
        <Select value={situacao} onChange={(e) => setSituacao(e.target.value)} style={{ maxWidth: 170 }}>
          <option value="">Todas as situações</option>
          <option value="aberto">Aberto</option>
          <option value="faturado">Faturado</option>
          <option value="cancelado">Cancelado</option>
        </Select>
        <Select value={vendedorId} onChange={(e) => setVendedorId(e.target.value)} style={{ maxWidth: 190 }}>
          <option value="">Todos os vendedores</option>
          {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
        </Select>
      </div>

      <FiltrosAvancados
        ativos={[tabelaId, canal, formaPagamento].filter(Boolean).length}
        aberto={filtrosAbertos}
        onAlternar={() => setFiltrosAbertos((v) => !v)}
        resumo="Tabela de preço, canal de venda e forma de pagamento."
      >
        <div className="filtros-linha">
          <Select value={tabelaId} onChange={(e) => setTabelaId(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Todas as tabelas de preço</option>
            {tabelas.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
          </Select>
          <Select value={canal} onChange={(e) => setCanal(e.target.value)} style={{ maxWidth: 190 }}>
            <option value="">Todos os canais</option>
            {listas?.canal_venda?.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
          </Select>
          <Select value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Todas as formas de pagamento</option>
            {listas?.forma_pagamento?.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
          </Select>
        </div>
      </FiltrosAvancados>

      <ChipsFiltros itens={chips} onLimparTudo={limparFiltros} />

      <AvisoDeFalha mensagem={erroCarga} aoTentarDeNovo={load} />

      {!loading && resumo.semVendedor > 0 && (
        <div className="aviso-inline" style={{ marginBottom: 12 }}>
          <User size={14} />
          <span>
            {formatQtd(resumo.semVendedor)} pedido(s) deste período estão sem vendedor vinculado —
            eles contam no faturamento, mas ficam de fora do relatório de comissão.
          </span>
        </div>
      )}

      {!loading && (
        <p className="page-sub" style={{ marginTop: 0, marginBottom: 12 }}>
          {tabela.totalItens.toLocaleString('pt-BR')} pedido(s) encontrados.
        </p>
      )}

      {loading && pedidos.length === 0 && modo === 'tabela' && (
        <div className="card"><Skeleton height={220} /></div>
      )}

      {!loading && pedidos.length === 0 && (
        <EstadoVazio
          Icone={ClipboardList}
          titulo={busca || chips.length > 0 ? 'Nenhum pedido com esses filtros' : 'Nenhuma venda no período'}
          descricao={busca || chips.length > 0
            ? 'Tente outro termo, amplie o período ou limpe os filtros.'
            : 'As vendas lançadas à mão (balcão, WhatsApp, atacado) aparecem aqui.'}
          onAcao={novoPedido}
          acaoLabel="Nova venda"
          IconeAcao={Plus}
        />
      )}

      {modo === 'cartoes' && pedidos.length > 0 && (
        <>
          <Paginacao {...tabela} posicao="topo" />
          <div className="vendas-cards">
            {tabela.itensPagina.map((p) => (
              <button key={p.id} type="button" className="venda-pedido-card" {...novaAba(`/pedidos/${p.id}`)} onClick={() => navigate(`/pedidos/${p.id}`)}>
                <div className="venda-pedido-topo">
                  <div style={{ minWidth: 0 }}>
                    <div className="venda-pedido-numero">#{p.numero} · {dataBr(String(p.data_pedido).slice(0, 10))}</div>
                    <div className="venda-pedido-cliente">{p.cliente_nome || 'Consumidor sem cadastro'}</div>
                  </div>
                  <span className={'stamp sm ' + (SITUACAO_TONE[p.situacao] || 'tone-neutro')}>
                    {SITUACAO_LABEL[p.situacao] || p.situacao}
                  </span>
                </div>

                <div className="venda-pedido-meta">
                  {p.vendedor_nome || p.vendedor ? (
                    <span className="venda-selo-vendedor"><User size={11} /> {p.vendedor_nome || p.vendedor}</span>
                  ) : (
                    <span className="venda-selo-vendedor sem-vendedor"><User size={11} /> sem vendedor</span>
                  )}
                  {p.tabela_preco_nome && <span className="venda-selo-tabela"><Tags size={11} /> {p.tabela_preco_nome}</span>}
                  {p.canal_venda && <span>{p.canal_venda}</span>}
                </div>

                <div className="venda-pedido-rodape">
                  <div className="venda-pedido-valor">
                    {brl(p.total_liquido)}
                    <small>{formatQtd(p.quantidade_pecas)} peça(s){p.forma_pagamento ? ` · ${p.forma_pagamento}` : ''}</small>
                  </div>
                  <ChevronRight size={18} style={{ color: 'var(--ink-soft)' }} />
                </div>
              </button>
            ))}
          </div>
          <Paginacao {...tabela} />
        </>
      )}

      {modo === 'tabela' && pedidos.length > 0 && (
        <div className="card">
          <Paginacao {...tabela} posicao="topo" />
          <DataTable>
            <table className="data-table">
              <thead>
                <tr>
                  <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 78 }}>Nº</ThOrdenavel>
                  <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 84 }}>Data</ThOrdenavel>
                  <ThOrdenavel coluna="cliente" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cliente</ThOrdenavel>
                  <ThOrdenavel coluna="vendedor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Vendedor</ThOrdenavel>
                  <ThOrdenavel coluna="tabela" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Tabela</ThOrdenavel>
                  <ThOrdenavel coluna="canal" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Canal</ThOrdenavel>
                  <ThOrdenavel coluna="qtd" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Peças</ThOrdenavel>
                  <ThOrdenavel coluna="total" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Total</ThOrdenavel>
                  <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading && pedidos.length === 0 && <SkeletonLinhasTabela colunas={10} />}
                {tabela.itensPagina.map((p) => (
                  <tr key={p.id} className="clickable-row" {...novaAba(`/pedidos/${p.id}`)} onClick={() => navigate(`/pedidos/${p.id}`)}>
                    <td className="mono">#{p.numero}</td>
                    <td className="mono">{dataBr(String(p.data_pedido).slice(0, 10))}</td>
                    <td className="col-truncar">{p.cliente_nome || '—'}</td>
                    <td className="col-truncar">{p.vendedor_nome || p.vendedor || <span className="ink-faint">sem vendedor</span>}</td>
                    <td className="col-truncar">{p.tabela_preco_nome || <span className="ink-faint">—</span>}</td>
                    <td className="col-truncar">{p.canal_venda || '—'}</td>
                    <td className="num">{formatQtd(p.quantidade_pecas)}</td>
                    <td className="num">{brl(p.total_liquido)}</td>
                    <td>
                      <span className={'stamp sm ' + (SITUACAO_TONE[p.situacao] || 'tone-neutro')}>
                        {SITUACAO_LABEL[p.situacao] || p.situacao}
                      </span>
                    </td>
                    <td><ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
          <Paginacao {...tabela} />
        </div>
      )}
    </div>
  );
}
