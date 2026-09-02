import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Printer, Link2, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { brl, dataBr } from '../lib/format';
import { Select, Checkbox, ThOrdenavel, Paginacao, BotaoExportar, StatCard, EstadoVazio } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import DataTable from '../components/DataTable';
import { useTabela } from '../lib/useTabela';

// Tela do módulo Financeiro. Três abas, mesma fonte de dado (o extrato lido
// da própria plataforma), três perguntas diferentes:
//
//   Movimentação — quanto entrou e saiu, por data e plataforma. É a resposta
//                  direta ao "quanto o marketplace liberou na conta".
//   Repasses     — cada transferência que a plataforma mandou pro banco.
//                  É o nível que casa 1 pra 1 com o extrato bancário.
//   Conferência  — extrato x soma dos pedidos, pra achar o que não bate.
//
// Nada aqui recalcula preço, margem ou imposto — a tela só lê o que a API
// devolve (REGRA 1).

// Chave de tipo -> rótulo em português. A ordem é a ordem em que os chips de
// filtro aparecem: primeiro o que é dinheiro de venda, depois o que sai.
const TIPOS = [
  { chave: 'repasse_venda', rotulo: 'Repasse de venda' },
  { chave: 'devolucao', rotulo: 'Devolução / estorno' },
  { chave: 'ads', rotulo: 'Publicidade (Ads)' },
  { chave: 'taxa', rotulo: 'Taxas e multas' },
  { chave: 'antecipacao', rotulo: 'Antecipação' },
  { chave: 'ajuste', rotulo: 'Ajustes' },
  { chave: 'saque', rotulo: 'Saque para o banco' },
  { chave: 'outros', rotulo: 'Outros' },
];
const TIPO_LABEL = Object.fromEntries(TIPOS.map((t) => [t.chave, t.rotulo]));

const STATUS_LABEL = { liberado: 'Liberado', pendente: 'Pendente' };

// Período padrão da tela: mês passado inteiro. O financeiro trabalha por
// fechamento de mês, não pelo dia de hoje — abrir em "hoje" mostraria uma
// tela quase sempre vazia (repasse não cai todo dia).
function periodoPadrao() {
  return PRESETS_PERIODO.find((p) => p.chave === 'mesPassado').calcular();
}

function dataIso(valor) {
  if (!valor) return '';
  return String(valor).slice(0, 10);
}

// Valor com sinal explícito e cor: entrada em verde, saída em vermelho.
// Sem o sinal, uma coluna de débitos e créditos misturados é ilegível.
function ValorAssinado({ valor, forte }) {
  const n = Number(valor) || 0;
  const cor = n > 0 ? 'var(--success)' : n < 0 ? 'var(--danger)' : undefined;
  return (
    <span className="mono" style={{ color: cor, fontWeight: forte ? 700 : undefined }}>
      {n > 0 ? '+' : ''}{brl(n)}
    </span>
  );
}

export default function FinanceiroPage({ aba = 'movimentacao' }) {
  const { user } = useAuth();
  // A ficha do pedido mora no módulo Vendas/Marketplace. Quem só tem o
  // módulo Financeiro seria redirecionado ao clicar (canAccessPath barra a
  // rota) — então pra essa pessoa o número do pedido aparece como texto, não
  // como link quebrado.
  const podeAbrirPedido = user?.role === 'admin'
    || (user?.modulos || []).some((m) => m === 'vendas' || m === 'marketplace');

  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(periodoPadrao());
  const [marketplace, setMarketplace] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [tiposMarcados, setTiposMarcados] = useState(() => new Set(TIPOS.map((t) => t.chave)));
  const [statusFiltro, setStatusFiltro] = useState('liberado');
  const [comPedido, setComPedido] = useState('');

  const [conexoes, setConexoes] = useState([]);
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [sincronizando, setSincronizando] = useState(false);
  const [aviso, setAviso] = useState('');

  useEffect(() => {
    api.get('/financeiro/status')
      .then((d) => setConexoes(d.conexoes || []))
      .catch(() => {});
  }, []);

  const lojasDisponiveis = useMemo(() => (
    conexoes.filter((c) => c.autorizada && (!marketplace || c.marketplace === marketplace))
  ), [conexoes, marketplace]);

  function mudarPlataforma(valor) {
    setMarketplace(valor);
    if (lojaId && !conexoes.some((c) => String(c.id) === String(lojaId) && (!valor || c.marketplace === valor))) {
      setLojaId('');
    }
  }

  function alternarTipo(chave) {
    setTiposMarcados((antes) => {
      const proximo = new Set(antes);
      if (proximo.has(chave)) proximo.delete(chave);
      else proximo.add(chave);
      return proximo;
    });
  }

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (dataInicio) p.set('data_inicio', dataInicio);
    if (dataFim) p.set('data_fim', dataFim);
    if (marketplace) p.set('marketplace', marketplace);
    if (lojaId) p.set('origem_integracao_id', lojaId);
    // Todos marcados = sem filtro de tipo (evita mandar uma lista enorme na
    // URL só pra dizer "tudo").
    if (tiposMarcados.size > 0 && tiposMarcados.size < TIPOS.length) {
      p.set('tipo', [...tiposMarcados].join(','));
    }
    if (statusFiltro) p.set('status', statusFiltro);
    if (comPedido) p.set('com_pedido', comPedido);
    return p.toString();
  }, [dataInicio, dataFim, marketplace, lojaId, tiposMarcados, statusFiltro, comPedido]);

  useEffect(() => {
    // Nenhum tipo marcado: a lista está vazia por escolha da pessoa, não por
    // falta de dado — não faz sentido chamar a API.
    if (tiposMarcados.size === 0) { setDados(null); return; }
    const rota = aba === 'repasses' ? 'repasses' : aba === 'conferencia' ? 'conciliacao' : 'extrato';
    setLoading(true);
    setErro('');
    api.get(`/financeiro/${rota}?${params}`)
      .then(setDados)
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }, [aba, params, tiposMarcados.size]);

  async function sincronizarAgora() {
    setSincronizando(true);
    setAviso('');
    setErro('');
    try {
      const r = await api.post('/financeiro/sincronizar', {});
      const partes = (r.resultados || []).map((res) => {
        const conexao = conexoes.find((c) => c.id === res.integracaoId);
        const nome = conexao ? (conexao.nome || PLATAFORMA_LABEL[conexao.marketplace]) : `Conexão ${res.integracaoId}`;
        if (res.erro) return `${nome}: ${res.erro}`;
        if (res.pulado) return `${nome}: já sincronizado há pouco`;
        if (res.fase === 'solicitado') return `${nome}: relatório de liberações pedido ao Mercado Pago — ele fica pronto em alguns minutos e será baixado no próximo ciclo`;
        if (res.fase === 'aguardando') return `${nome}: aguardando o Mercado Pago liberar o relatório`;
        return `${nome}: ${res.gravados || 0} lançamento(s) atualizados`;
      });
      setAviso(partes.join(' · ') || 'Nenhuma conexão ativa para sincronizar.');
      const rota = aba === 'repasses' ? 'repasses' : aba === 'conferencia' ? 'conciliacao' : 'extrato';
      setDados(await api.get(`/financeiro/${rota}?${params}`));
      setConexoes((await api.get('/financeiro/status')).conexoes || []);
    } catch (err) {
      setErro(err.message);
    } finally {
      setSincronizando(false);
    }
  }

  const conexoesAutorizadas = conexoes.filter((c) => c.autorizada && c.ativo);
  const semExtrato = conexoesAutorizadas.length > 0
    && conexoesAutorizadas.every((c) => Number(c.lancamentos || 0) === 0);

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>Financeiro</h2>
        <p className="page-sub">
          Movimentação bancária dos marketplaces: quanto cada plataforma liberou (e descontou) na conta, por
          data. É lido do extrato da própria plataforma — inclui o que não pertence a venda nenhuma, como
          publicidade, multa, ajuste e estorno.
        </p>

        <div className="subtab-row">
          {/* Link do react-router, não <a href>: com <a> o navegador recarrega
              a aplicação inteira a cada troca de aba e o filtro de período
              volta pro padrão. */}
          <Link to="/financeiro/movimentacao" className={'subtab-btn' + (aba === 'movimentacao' ? ' active' : '')}>Movimentação</Link>
          <Link to="/financeiro/repasses" className={'subtab-btn' + (aba === 'repasses' ? ' active' : '')}>Repasses</Link>
          <Link to="/financeiro/conferencia" className={'subtab-btn' + (aba === 'conferencia' ? ' active' : '')}>Conferência</Link>
        </div>

        <div className="filtros-barra">
          <PeriodoFiltro inicio={dataInicio} fim={dataFim} onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })} />
          <Select value={marketplace} onChange={(e) => mudarPlataforma(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="">Todas as plataformas</option>
            {Object.entries(PLATAFORMA_LABEL).map(([chave, label]) => (
              <option key={chave} value={chave}>{label}</option>
            ))}
          </Select>
          <Select value={lojaId} onChange={(e) => setLojaId(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="">Todas as lojas</option>
            {lojasDisponiveis.map((c) => (
              <option key={c.id} value={c.id}>{c.nome || PLATAFORMA_LABEL[c.marketplace]}</option>
            ))}
          </Select>
          {aba === 'movimentacao' && (
            <>
              {/* Vale para a LISTA de lançamentos. Os totais e resumos acima
                  sempre mostram liberado e pendente separados, independente
                  do que estiver escolhido aqui. */}
              <Select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value)} style={{ maxWidth: 200 }}>
                <option value="liberado">Lista: só o já liberado</option>
                <option value="pendente">Lista: só o pendente</option>
                <option value="">Lista: liberado + pendente</option>
              </Select>
              <Select value={comPedido} onChange={(e) => setComPedido(e.target.value)} style={{ maxWidth: 190 }}>
                <option value="">Com e sem pedido</option>
                <option value="sim">Só com pedido vinculado</option>
                <option value="nao">Só sem pedido vinculado</option>
              </Select>
            </>
          )}
          <div className="filtros-barra-acoes">
            {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
            <button className="btn btn-ghost" onClick={sincronizarAgora} disabled={sincronizando}>
              <RefreshCw size={14} /> {sincronizando ? 'Puxando extrato…' : 'Puxar extrato agora'}
            </button>
            <button className="btn btn-ghost" onClick={() => window.print()}>
              <Printer size={14} /> Imprimir
            </button>
          </div>
        </div>

        {aba === 'movimentacao' && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">O que aparece na tela</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {TIPOS.map((t) => (
                <label key={t.chave} className="toggle">
                  <Checkbox checked={tiposMarcados.has(t.chave)} onChange={() => alternarTipo(t.chave)} />
                  {t.rotulo}
                </label>
              ))}
            </div>
            {tiposMarcados.size === 0 && (
              <p className="page-sub" style={{ marginBottom: 0 }}>Marque pelo menos um tipo para ver os lançamentos.</p>
            )}
          </div>
        )}

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        {aviso && <div className="aviso-compacto tone-saudavel">{aviso}</div>}
        {semExtrato && (
          <div className="aviso-compacto tone-atencao">
            Nenhum extrato foi lido ainda. Clique em <strong>Puxar extrato agora</strong> — no Mercado Livre o
            relatório de liberações é gerado pelo Mercado Pago e leva alguns minutos, então a primeira carga
            costuma precisar de duas passadas.
          </div>
        )}
        <AvisosDasConexoes conexoes={conexoes} />
      </div>

      {aba === 'movimentacao' && <AbaMovimentacao dados={dados} podeAbrirPedido={podeAbrirPedido} />}
      {aba === 'repasses' && <AbaRepasses dados={dados} />}
      {aba === 'conferencia' && <AbaConferencia dados={dados} />}
    </div>
  );
}

// Ressalva de leitura: linha que a plataforma devolveu e não deu pra
// interpretar. Fica no topo, e não escondida num log — é dinheiro que existe
// e ficou de fora do relatório (REGRA 2).
function AvisosDasConexoes({ conexoes }) {
  const comAviso = conexoes.filter((c) => c.ultimo_aviso);
  const comErro = conexoes.filter((c) => c.ultimo_erro);
  if (comAviso.length === 0 && comErro.length === 0) return null;
  return (
    <>
      {comAviso.map((c) => (
        <div key={`aviso-${c.id}`} className="aviso-compacto tone-atencao">
          <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
          <strong>{c.nome || PLATAFORMA_LABEL[c.marketplace]}:</strong> {c.ultimo_aviso}
        </div>
      ))}
      {comErro.map((c) => (
        <div key={`erro-${c.id}`} className="aviso-compacto tone-prejuizo">
          <strong>{c.nome || PLATAFORMA_LABEL[c.marketplace]}:</strong> a última leitura do extrato falhou — {c.ultimo_erro}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Aba: Movimentação
// ---------------------------------------------------------------------------

const COLUNAS_LANCAMENTO = {
  data: (l) => dataIso(l.data_liberacao),
  plataforma: (l) => PLATAFORMA_LABEL[l.marketplace] || l.marketplace,
  loja: (l) => l.loja_nome || '',
  tipo: (l) => TIPO_LABEL[l.tipo] || l.tipo,
  descricao: (l) => l.descricao_externa || '',
  pedido: (l) => Number(l.pedido_numero) || 0,
  valor: (l) => Number(l.valor) || 0,
  status: (l) => l.status,
};

const EXPORTACAO_LANCAMENTO = [
  { rotulo: 'Data', valor: (l) => dataBr(dataIso(l.data_liberacao)) },
  { rotulo: 'Plataforma', valor: (l) => PLATAFORMA_LABEL[l.marketplace] || l.marketplace },
  { rotulo: 'Loja', valor: (l) => l.loja_nome || '' },
  { rotulo: 'Tipo', valor: (l) => TIPO_LABEL[l.tipo] || l.tipo },
  { rotulo: 'Descrição', valor: (l) => l.descricao_externa || '' },
  { rotulo: 'Pedido', valor: (l) => (l.pedido_numero ? `#${l.pedido_numero}` : '') },
  { rotulo: 'ID na plataforma', valor: (l) => l.lancamento_id_externo },
  { rotulo: 'Valor', valor: (l) => brl(l.valor) },
  { rotulo: 'Situação', valor: (l) => STATUS_LABEL[l.status] || l.status },
];

function AbaMovimentacao({ dados, podeAbrirPedido }) {
  const lancamentos = dados?.lancamentos || [];
  const tabela = useTabela(lancamentos, { colunas: COLUNAS_LANCAMENTO, colunaPadrao: 'data', direcaoPadrao: 'desc', prefixo: 'lanc' });

  // Entradas e saídas somadas separadamente: o líquido sozinho esconde um
  // mês em que entrou muito e saiu quase tudo.
  const entradas = useMemo(() => lancamentos.reduce((s, l) => (Number(l.valor) > 0 ? s + Number(l.valor) : s), 0), [lancamentos]);
  const saidas = useMemo(() => lancamentos.reduce((s, l) => (Number(l.valor) < 0 ? s + Number(l.valor) : s), 0), [lancamentos]);

  // Resumo por data: uma linha por dia, uma coluna por plataforma. É a
  // pergunta original do financeiro — "quanto foi liberado por data e
  // plataforma" — respondida do jeito mais direto possível.
  const { dias, plataformasNaTela, totalPorPlataforma } = useMemo(() => {
    const porDia = new Map();
    const plataformas = new Set();
    const totais = {};
    for (const r of (dados?.resumoPorData || [])) {
      if (r.status !== 'liberado') continue;
      const data = dataIso(r.data_liberacao);
      plataformas.add(r.marketplace);
      const linha = porDia.get(data) || { data, total: 0 };
      linha[r.marketplace] = (linha[r.marketplace] || 0) + Number(r.total || 0);
      linha.total += Number(r.total || 0);
      porDia.set(data, linha);
      totais[r.marketplace] = (totais[r.marketplace] || 0) + Number(r.total || 0);
    }
    return {
      dias: [...porDia.values()].sort((a, b) => (a.data < b.data ? 1 : -1)),
      plataformasNaTela: [...plataformas],
      totalPorPlataforma: totais,
    };
  }, [dados]);

  const porTipo = useMemo(() => {
    const mapa = new Map();
    for (const r of (dados?.resumoPorTipo || [])) {
      // Só o liberado: "para onde o dinheiro foi" é sobre dinheiro que já se
      // moveu. O pendente aparece no indicador próprio, em cima.
      if (r.status !== 'liberado') continue;
      const atual = mapa.get(r.tipo) || { tipo: r.tipo, total: 0, quantidade: 0 };
      atual.total += Number(r.total || 0);
      atual.quantidade += Number(r.quantidade || 0);
      mapa.set(r.tipo, atual);
    }
    return [...mapa.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [dados]);

  if (!dados) return null;
  if (lancamentos.length === 0 && dias.length === 0) {
    return (
      <div className="card">
        <EstadoVazio
          titulo="Nenhum lançamento no período"
          descricao="Ou o extrato desse período ainda não foi lido, ou não houve movimentação. Use 'Puxar extrato agora' para atualizar."
        />
      </div>
    );
  }

  const totalDia = (d) => d.total;

  return (
    <>
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <StatCard label="Liberado no período" value={brl(dados.totais.liberado)} />
        <StatCard label="Entradas" value={brl(entradas)} />
        <StatCard label="Saídas" value={brl(saidas)} />
        <StatCard
          label="Ainda pendente"
          value={brl(dados.totais.pendente)}
        />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Liberado por data e plataforma</div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Só o que já foi liberado — o pendente ({brl(dados.totais.pendente)}, {dados.totais.quantidadePendente}{' '}
          lançamento(s)) fica de fora desta tabela de propósito: ainda não é movimentação bancária.
        </p>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Data</th>
                {plataformasNaTela.map((m) => <th key={m}>{PLATAFORMA_LABEL[m] || m}</th>)}
                <th>Total do dia</th>
              </tr>
            </thead>
            <tbody>
              {dias.map((d) => (
                <tr key={d.data}>
                  <td className="mono">{dataBr(d.data)}</td>
                  {plataformasNaTela.map((m) => (
                    <td key={m} className="mono">{d[m] === undefined ? '—' : <ValorAssinado valor={d[m]} />}</td>
                  ))}
                  <td className="mono"><ValorAssinado valor={totalDia(d)} forte /></td>
                </tr>
              ))}
              {dias.length > 0 && (
                <tr className="linha-total">
                  <td><strong>Total</strong></td>
                  {plataformasNaTela.map((m) => (
                    <td key={m} className="mono"><ValorAssinado valor={totalPorPlataforma[m] || 0} forte /></td>
                  ))}
                  <td className="mono"><ValorAssinado valor={dados.totais.liberado} forte /></td>
                </tr>
              )}
            </tbody>
          </table>
        </DataTable>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Para onde o dinheiro foi</div>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr><th>Tipo</th><th>Lançamentos</th><th>Total</th></tr>
            </thead>
            <tbody>
              {porTipo.map((t) => (
                <tr key={t.tipo}>
                  <td>{TIPO_LABEL[t.tipo] || t.tipo}</td>
                  <td className="mono">{t.quantidade.toLocaleString('pt-BR')}</td>
                  <td className="mono"><ValorAssinado valor={t.total} /></td>
                </tr>
              ))}
              {porTipo.length === 0 && <tr><td colSpan="3">Nada no período.</td></tr>}
            </tbody>
          </table>
        </DataTable>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Lançamentos</div>
          <BotaoExportar nomeBase="extrato-marketplace" colunas={EXPORTACAO_LANCAMENTO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
        </div>
        {dados.listaTruncada && (
          <div className="aviso-compacto tone-atencao">
            A lista detalhada foi cortada em 5.000 lançamentos. Os totais e os resumos acima consideram o
            período inteiro — só esta tabela está incompleta. Estreite o período ou o filtro para ver todos.
          </div>
        )}
        <p className="page-sub" style={{ marginTop: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} lançamento(s)</p>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 100 }}>Data</ThOrdenavel>
                <ThOrdenavel coluna="plataforma" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Plataforma</ThOrdenavel>
                <ThOrdenavel coluna="loja" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Loja</ThOrdenavel>
                <ThOrdenavel coluna="tipo" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Tipo</ThOrdenavel>
                <ThOrdenavel coluna="descricao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Descrição</ThOrdenavel>
                <ThOrdenavel coluna="pedido" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 90 }}>Pedido</ThOrdenavel>
                <ThOrdenavel coluna="valor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Valor</ThOrdenavel>
                <ThOrdenavel coluna="status" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 100 }}>Situação</ThOrdenavel>
              </tr>
            </thead>
            <tbody>
              {tabela.itensPagina.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{dataBr(dataIso(l.data_liberacao))}</td>
                  <td>{PLATAFORMA_LABEL[l.marketplace] || l.marketplace}</td>
                  <td>{l.loja_nome || '—'}</td>
                  <td>{TIPO_LABEL[l.tipo] || l.tipo}</td>
                  <td title={l.lancamento_id_externo}>{l.descricao_externa || '—'}</td>
                  <td className="mono">
                    {l.pedido_numero ? (
                      podeAbrirPedido
                        ? <Link to={`/pedidos/${l.pedido_id}`} title="Abrir o pedido">#{l.pedido_numero}</Link>
                        : <span>#{l.pedido_numero}</span>
                    ) : l.pedido_id_externo ? (
                      <span title={`Pedido ${l.pedido_id_externo} ainda não importado aqui`} className="stamp sm tone-neutro">
                        <Link2 size={11} /> externo
                      </span>
                    ) : '—'}
                  </td>
                  <td className="mono"><ValorAssinado valor={l.valor} /></td>
                  <td>
                    <span className={'stamp sm ' + (l.status === 'liberado' ? 'tone-saudavel' : 'tone-atencao')}>
                      {STATUS_LABEL[l.status] || l.status}
                    </span>
                  </td>
                </tr>
              ))}
              {tabela.totalItens === 0 && <tr><td colSpan="8">Nenhum lançamento com esses filtros.</td></tr>}
            </tbody>
          </table>
        </DataTable>
        <Paginacao {...tabela} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Aba: Repasses
// ---------------------------------------------------------------------------

const COLUNAS_REPASSE = {
  data: (r) => dataIso(r.data_liberacao),
  plataforma: (r) => PLATAFORMA_LABEL[r.marketplace] || r.marketplace,
  loja: (r) => r.loja_nome || '',
  valor: (r) => Number(r.valor_liquido) || 0,
  status: (r) => r.status,
};

const EXPORTACAO_REPASSE = [
  { rotulo: 'Data', valor: (r) => dataBr(dataIso(r.data_liberacao)) },
  { rotulo: 'Plataforma', valor: (r) => PLATAFORMA_LABEL[r.marketplace] || r.marketplace },
  { rotulo: 'Loja', valor: (r) => r.loja_nome || '' },
  { rotulo: 'Identificador', valor: (r) => r.repasse_id_externo },
  { rotulo: 'Valor', valor: (r) => brl(r.valor_liquido) },
  { rotulo: 'Situação', valor: (r) => r.status },
];

function AbaRepasses({ dados }) {
  const repasses = dados?.repasses || [];
  const tabela = useTabela(repasses, { colunas: COLUNAS_REPASSE, colunaPadrao: 'data', direcaoPadrao: 'desc', prefixo: 'rep' });
  const totalPago = repasses.filter((r) => r.status === 'pago').reduce((s, r) => s + (Number(r.valor_liquido) || 0), 0);
  const totalAndamento = repasses.filter((r) => r.status !== 'pago').reduce((s, r) => s + (Number(r.valor_liquido) || 0), 0);

  if (!dados) return null;

  return (
    <>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <StatCard label="Repasses já pagos no período" value={brl(totalPago)} />
        <StatCard label="Em processamento ou previstos" value={brl(totalAndamento)} />
      </div>
      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Repasses</div>
          <BotaoExportar nomeBase="repasses-marketplace" colunas={EXPORTACAO_REPASSE} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Cada linha é uma transferência da plataforma para a conta da empresa — é o nível que casa com o
          extrato bancário. Repasse em processamento ainda não caiu, e por isso é somado separado.
        </p>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 110 }}>Data</ThOrdenavel>
                <ThOrdenavel coluna="plataforma" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Plataforma</ThOrdenavel>
                <ThOrdenavel coluna="loja" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Loja</ThOrdenavel>
                <th>Identificador</th>
                <th style={{ width: 110 }}>Lançamentos</th>
                <ThOrdenavel coluna="valor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Valor</ThOrdenavel>
                <ThOrdenavel coluna="status" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 120 }}>Situação</ThOrdenavel>
              </tr>
            </thead>
            <tbody>
              {tabela.itensPagina.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.data_liberacao ? dataBr(dataIso(r.data_liberacao)) : '—'}</td>
                  <td>{PLATAFORMA_LABEL[r.marketplace] || r.marketplace}</td>
                  <td>{r.loja_nome || '—'}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{r.repasse_id_externo}</td>
                  <td className="mono">{Number(r.lancamentos_vinculados || 0).toLocaleString('pt-BR')}</td>
                  <td className="mono">{r.valor_liquido == null ? '—' : brl(r.valor_liquido)}</td>
                  <td>
                    <span className={'stamp sm ' + (r.status === 'pago' ? 'tone-saudavel' : 'tone-atencao')}>
                      {r.status === 'pago' ? 'Pago' : r.status === 'processando' ? 'Processando' : 'Previsto'}
                    </span>
                  </td>
                </tr>
              ))}
              {tabela.totalItens === 0 && <tr><td colSpan="7">Nenhum repasse no período.</td></tr>}
            </tbody>
          </table>
        </DataTable>
        <Paginacao {...tabela} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Aba: Conferência
// ---------------------------------------------------------------------------

const COLUNAS_CONFERENCIA = {
  data: (l) => l.data,
  plataforma: (l) => PLATAFORMA_LABEL[l.marketplace] || l.marketplace,
  extrato: (l) => (l.extratoTotal === null ? -Infinity : l.extratoTotal),
  pedidos: (l) => (l.pedidosTotal === null ? -Infinity : l.pedidosTotal),
  diferenca: (l) => (l.diferencaNaoExplicada === null ? -Infinity : Math.abs(l.diferencaNaoExplicada)),
};

const EXPORTACAO_CONFERENCIA = [
  { rotulo: 'Data', valor: (l) => dataBr(l.data) },
  { rotulo: 'Plataforma', valor: (l) => PLATAFORMA_LABEL[l.marketplace] || l.marketplace },
  { rotulo: 'Extrato (total liberado)', valor: (l) => (l.extratoTotal === null ? '—' : brl(l.extratoTotal)) },
  { rotulo: 'Extrato — repasse de venda', valor: (l) => (l.extratoRepasseVenda === null ? '—' : brl(l.extratoRepasseVenda)) },
  { rotulo: 'Extrato — outros lançamentos', valor: (l) => (l.extratoOutros === null ? '—' : brl(l.extratoOutros)) },
  { rotulo: 'Soma dos pedidos', valor: (l) => (l.pedidosTotal === null ? '—' : brl(l.pedidosTotal)) },
  { rotulo: 'Diferença não explicada', valor: (l) => (l.diferencaNaoExplicada === null ? '—' : brl(l.diferencaNaoExplicada)) },
];

function AbaConferencia({ dados }) {
  const linhas = dados?.linhas || [];
  const tabela = useTabela(linhas, { colunas: COLUNAS_CONFERENCIA, colunaPadrao: 'data', direcaoPadrao: 'desc', prefixo: 'conf' });
  if (!dados) return null;

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Compara duas leituras independentes do mesmo dia: o <strong>extrato</strong> da plataforma e a{' '}
          <strong>soma do valor recebido dos pedidos</strong> liberados naquele dia. A diferença entre elas
          normalmente <em>não</em> é erro — é exatamente o que o extrato tem e a venda não: publicidade,
          multa, ajuste, estorno. Por isso a coluna que importa é a última: o que sobra depois de descontar
          esses lançamentos.
        </p>
        <div className="row-line">
          <span>Dias com diferença não explicada</span>
          <span className={'stamp sm ' + (dados.diasDivergentes > 0 ? 'tone-atencao' : 'tone-saudavel')}>
            {dados.diasDivergentes}
          </span>
        </div>
        <div className="row-line">
          <span>Dias em que só existe um dos dois lados</span>
          <span className="mono">{dados.diasSemExtrato + dados.diasSemPedidos}</span>
        </div>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Extrato x pedidos, por dia</div>
          <BotaoExportar nomeBase="conferencia-financeira" colunas={EXPORTACAO_CONFERENCIA} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
        </div>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 110 }}>Data</ThOrdenavel>
                <ThOrdenavel coluna="plataforma" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Plataforma</ThOrdenavel>
                <ThOrdenavel coluna="extrato" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Extrato</ThOrdenavel>
                <th>Repasse de venda</th>
                <th>Outros lançamentos</th>
                <ThOrdenavel coluna="pedidos" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Soma dos pedidos</ThOrdenavel>
                <ThOrdenavel coluna="diferenca" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Sobra sem explicação</ThOrdenavel>
              </tr>
            </thead>
            <tbody>
              {tabela.itensPagina.map((l) => (
                <tr key={`${l.data}-${l.marketplace}`}>
                  <td className="mono">{dataBr(l.data)}</td>
                  <td>{PLATAFORMA_LABEL[l.marketplace] || l.marketplace}</td>
                  <td className="mono">{l.extratoTotal === null ? <span title="Extrato desse dia ainda não foi lido">— não lido</span> : brl(l.extratoTotal)}</td>
                  <td className="mono">{l.extratoRepasseVenda === null ? '—' : brl(l.extratoRepasseVenda)}</td>
                  <td className="mono">{l.extratoOutros === null ? '—' : <ValorAssinado valor={l.extratoOutros} />}</td>
                  <td className="mono">{l.pedidosTotal === null ? <span title="Nenhum pedido com repasse liberado nesse dia">— sem pedido</span> : brl(l.pedidosTotal)}</td>
                  <td className="mono">
                    {l.diferencaNaoExplicada === null ? (
                      <span className="stamp sm tone-neutro">não dá pra comparar</span>
                    ) : l.confere ? (
                      <span className="stamp sm tone-saudavel">bate</span>
                    ) : (
                      <ValorAssinado valor={l.diferencaNaoExplicada} forte />
                    )}
                  </td>
                </tr>
              ))}
              {tabela.totalItens === 0 && <tr><td colSpan="7">Nada para conferir no período.</td></tr>}
            </tbody>
          </table>
        </DataTable>
        <Paginacao {...tabela} />
      </div>
    </>
  );
}
