import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight, ClipboardList, Plug } from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd } from '../lib/format';
import { Select, MultiSelect, SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoDeHoje } from '../lib/periodos';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import {
  CanalMarketplace, carimbarCanal, indiceDeLojas, nomeDaLoja, CAMINHO_LOJAS,
} from '../lib/canalMarketplace';
import DataTable from '../components/DataTable';
import CopiarBotao from '../components/CopiarBotao';
import { useTabela } from '../lib/useTabela';
import { novaAba } from '../lib/novaAba';

const SITUACAO_TONE = {
  aberto: 'tone-atencao',
  faturado: 'tone-saudavel',
  cancelado: 'tone-prejuizo',
};

const SITUACAO_LABEL = {
  aberto: 'Aberto',
  faturado: 'Faturado',
  cancelado: 'Cancelado',
};

const COLUNAS_ORDENAVEIS = {
  numero: (p) => Number(p.numero) || 0,
  data: (p) => new Date(p.data_pedido).getTime(),
  cliente: (p) => p.cliente_nome,
  canal: (p) => p._canal?.texto || p.canal_venda,
  qtd: (p) => Number(p.quantidade_pecas) || 0,
  total: (p) => Number(p.total_liquido) || 0,
  situacao: (p) => p.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (p) => p.numero },
  { rotulo: 'Data', valor: (p) => new Date(p.data_pedido).toLocaleDateString('pt-BR') },
  { rotulo: 'Cliente', valor: (p) => p.cliente_nome || '' },
  // Exportação leva o NOME DA LOJA ("MELI Origem"), não o canal genérico —
  // é o que a planilha precisa pra separar as duas contas da mesma plataforma.
  { rotulo: 'Canal', valor: (p) => p._canal?.texto || p.canal_venda || '' },
  { rotulo: 'Qtd. Peças', valor: (p) => formatQtd(p.quantidade_pecas) },
  { rotulo: 'Total Líquido', valor: (p) => brl(p.total_liquido) },
  { rotulo: 'Situação', valor: (p) => SITUACAO_LABEL[p.situacao] || p.situacao },
];

export default function PedidosListPage({ origemFiltro }) {
  const navigate = useNavigate();
  const isMarketplace = origemFiltro === 'marketplace';
  const [pedidos, setPedidos] = useState([]);
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('');
  // Plataforma e loja aceitam VÁRIAS de uma vez (10/09/2026), como no
  // UpSeller — ver MultiSelect em components/ui.jsx.
  const [plataformas, setPlataformas] = useState([]);
  const [lojaIds, setLojaIds] = useState([]);
  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(periodoDeHoje());
  const [integracoes, setIntegracoes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erroCarga, setErroCarga] = useState('');
  const [criando, setCriando] = useState(false);

  useEffect(() => { if (isMarketplace) api.get(CAMINHO_LOJAS).then(setIntegracoes).catch(() => {}); }, [isMarketplace]);

  const indiceLojas = useMemo(() => indiceDeLojas(integracoes), [integracoes]);
  const pedidosComCanal = useMemo(() => carimbarCanal(pedidos, indiceLojas), [pedidos, indiceLojas]);

  const lojasDisponiveis = useMemo(() => (
    integracoes.filter((i) => plataformas.length === 0 || plataformas.includes(PLATAFORMA_LABEL[i.marketplace]))
  ), [integracoes, plataformas]);

  const opcoesPlataformas = useMemo(
    () => Object.values(PLATAFORMA_LABEL).map((label) => ({ valor: label, rotulo: label })),
    []
  );
  const opcoesLojas = useMemo(
    () => lojasDisponiveis.map((i) => ({ valor: String(i.id), rotulo: nomeDaLoja(i) })),
    [lojasDisponiveis]
  );

  // Tirar uma plataforma do filtro solta as lojas dela — senão sobraria um
  // filtro de loja que não pode casar com nada e a lista voltaria vazia.
  function mudarPlataformas(valores) {
    setPlataformas(valores);
    if (valores.length === 0) return;
    setLojaIds((atuais) => atuais.filter((id) => {
      const loja = integracoes.find((i) => String(i.id) === String(id));
      return loja && valores.includes(PLATAFORMA_LABEL[loja.marketplace]);
    }));
  }

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    if (situacao) params.set('situacao', situacao);
    if (origemFiltro) params.set('origem', origemFiltro);
    if (isMarketplace && plataformas.length) params.set('canal_venda', plataformas.join(','));
    if (isMarketplace && lojaIds.length) params.set('origem_integracao_id', lojaIds.join(','));
    if (isMarketplace && dataInicio) params.set('data_inicio', dataInicio);
    if (isMarketplace && dataFim) params.set('data_fim', dataFim);
    setErroCarga('');
    api.get(`/pedidos?${params.toString()}`)
      .then((data) => { setPedidos(data); })
      // Sem catch, uma falha (sessão expirada, servidor fora) deixava a tela
      // no esqueleto para sempre, sem nenhuma mensagem.
      .catch((e) => setErroCarga(e.message))
      .finally(() => setLoading(false));
  }

  // Busca por texto entra na hora (sem precisar apertar Enter/clicar em
  // nada) — só um pequeno atraso pra não disparar uma chamada a cada tecla.
  useEffect(() => {
    const t = setTimeout(load, busca ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [situacao, plataformas, lojaIds, dataInicio, dataFim, busca]);

  const tabela = useTabela(pedidosComCanal, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  async function novoPedido() {
    setCriando(true);
    try {
      const data = await api.post('/pedidos', {});
      navigate(`/pedidos/${data.pedido.id}`);
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h1>{origemFiltro === 'marketplace' ? 'Pedidos de Marketplace' : 'Pedidos de Venda'}</h1>
          <p className="page-sub">
            {origemFiltro === 'marketplace'
              ? 'Pedidos importados do Mercado Livre, Shopee, TikTok Shop e demais marketplaces (sincronização automática ou planilha).'
              : 'Pedidos lançados manualmente (loja física, WhatsApp etc). Versão de teste — ainda não emite nota fiscal.'}
          </p>
        </div>

      {erroCarga && <p className="login-error">{erroCarga}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <BotaoExportar nomeBase={isMarketplace ? 'pedidos-marketplace' : 'pedidos'} colunas={COLUNAS_EXPORTACAO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
          {origemFiltro !== 'marketplace' && (
            <button className="btn btn-primary" onClick={novoPedido} disabled={criando}>
              <Plus size={14} /> Novo pedido
            </button>
          )}
        </div>
      </div>

      <div className="filtros-barra">
        {isMarketplace && (
          <PeriodoFiltro inicio={dataInicio} fim={dataFim} onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })} />
        )}
        <div className="filtros-barra-busca">
          <Search size={14} />
          <input
            placeholder="Buscar por cliente ou nº do pedido"
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
        {isMarketplace && (
          <>
            <MultiSelect
              valor={plataformas}
              onChange={mudarPlataformas}
              opcoes={opcoesPlataformas}
              rotuloTudo="Todas as plataformas"
              rotuloVazio="Todas as plataformas"
              larguraMinima={180}
            />
            <MultiSelect
              valor={lojaIds}
              onChange={setLojaIds}
              opcoes={opcoesLojas}
              rotuloTudo="Todas as lojas"
              rotuloVazio="Todas as lojas"
              larguraMinima={180}
            />
          </>
        )}
      </div>

      {!loading && <p className="page-sub" style={{ marginTop: -8, marginBottom: 12 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</p>}

      <div className="card">
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 86 }}>Nº</ThOrdenavel>
              <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 84 }}>Data</ThOrdenavel>
              <ThOrdenavel coluna="cliente" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cliente</ThOrdenavel>
              <ThOrdenavel coluna="canal" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Canal</ThOrdenavel>
              <ThOrdenavel coluna="qtd" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Qtd. Peças</ThOrdenavel>
              <ThOrdenavel coluna="total" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Total Líquido</ThOrdenavel>
              <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && pedidos.length === 0 && <SkeletonLinhasTabela colunas={8} />}
            {tabela.itensPagina.map((p) => (
              <tr key={p.id} className="clickable-row" {...novaAba(`/pedidos/${p.id}`)} onClick={() => navigate(`/pedidos/${p.id}`)}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    #{p.numero}
                    <CopiarBotao valor={p.numero} label="Copiar nº do pedido" />
                  </span>
                </td>
                <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                <td>{p.cliente_nome || '—'}</td>
                <td><CanalMarketplace registro={p} indiceLojas={indiceLojas} /></td>
                <td className="mono">{formatQtd(p.quantidade_pecas)} {Number(p.quantidade_pecas) === 1 ? 'peça' : 'peças'}</td>
                <td className="mono">{brl(p.total_liquido)}</td>
                <td><span className={'stamp sm ' + (SITUACAO_TONE[p.situacao] || 'tone-neutro')}>{SITUACAO_LABEL[p.situacao] || p.situacao}</span></td>
                <td>
                  <ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </DataTable>
        {!loading && pedidos.length === 0 && (
          isMarketplace ? (
            <EstadoVazio
              Icone={Plug}
              titulo="Nenhum pedido de marketplace no período"
              descricao="Pedidos chegam automaticamente das lojas conectadas em Integrações, a cada 5 minutos, ou por importação de planilha."
              href="/integracoes"
              acaoLabel="Ver integrações"
              IconeAcao={Plug}
            />
          ) : (
            <EstadoVazio
              Icone={ClipboardList}
              titulo={busca || situacao ? 'Nenhum pedido encontrado' : 'Nenhum pedido lançado ainda'}
              descricao={busca || situacao
                ? 'Tente outro termo de busca ou limpe o filtro de situação.'
                : 'Pedidos lançados manualmente (loja física, WhatsApp etc.) aparecem aqui.'}
              onAcao={novoPedido}
              acaoLabel="Novo pedido"
              IconeAcao={Plus}
            />
          )
        )}
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
