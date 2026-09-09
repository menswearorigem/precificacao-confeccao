import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, RefreshCw, AlertTriangle, PlugZap, PackageX, CheckCircle2,
  RotateCw, Archive, Info, Clock, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Select, Skeleton, IndicadorDestaque } from '../components/ui';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import { brl, formatQtd, tempoRelativo, dataBr } from '../lib/format';

// Marketplace › Saúde da Sincronização.
//
// O DEFEITO QUE ESTA TELA TORNA VISÍVEL: quando a importação de um pedido
// falhava, o erro ia para o log e para `ultimo_erro` da conexão — que guarda
// UM erro e é sobrescrito no ciclo seguinte, cinco minutos depois. E quando
// a data daquele pedido passava dos sete dias da janela de ressincronização,
// ele saía da busca. Nunca mais era tentado, e ninguém nunca foi avisado.
//
// Uma venda paga pelo cliente simplesmente não existia no sistema, e
// estoque, lucratividade e conferência passavam a trabalhar em cima de um
// faturamento incompleto sem nenhum sinal disso.
//
// A tela separa três coisas que o sistema tratava como uma só:
//   · conexão parada — enquanto estiver assim, NADA novo entra;
//   · pedido que falhou mas ainda está na janela — vai ser tentado sozinho;
//   · pedido que falhou e já saiu da janela — está fora, e fica fora até
//     alguém mandar buscar. É o único que tem botão.

function rotuloPlataforma(marketplace) {
  return PLATAFORMA_LABEL[marketplace] || marketplace;
}

function SeloSituacao({ situacao }) {
  if (!situacao) return null;
  return <span className={`selo ${situacao.tom}`} title={situacao.motivo || undefined}>{situacao.rotulo}</span>;
}

export default function SaudeIntegracaoPage() {
  // O placar já dizia "N resolvidas" e não havia como ver QUAIS — a lista era
  // carregada do banco (30 dias) e descartada. Conferir se o pedido de ontem
  // voltou mesmo é justamente o que faz alguém abrir esta tela no dia
  // seguinte.
  const [verResolvidas, setVerResolvidas] = useState(false);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [ocupado, setOcupado] = useState(null);
  const [recado, setRecado] = useState(null);
  const [filtroSituacao, setFiltroSituacao] = useState('');

  const carregar = useCallback(() => {
    setCarregando(true);
    setErro(null);
    api.get('/saude-integracao')
      .then(setDados)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  async function acao(chave, executar, sucesso) {
    setOcupado(chave);
    setRecado(null);
    try {
      const r = await executar();
      setRecado({ tom: 'sucesso', texto: r?.mensagem || sucesso });
      carregar();
    } catch (e) {
      setRecado({ tom: 'erro', texto: e.message });
    } finally {
      setOcupado(null);
    }
  }

  const falhas = useMemo(() => {
    const lista = dados?.resumo?.lista || [];
    if (!filtroSituacao) return lista;
    return lista.filter((f) => f.situacao?.situacao === filtroSituacao);
  }, [dados, filtroSituacao]);

  const resumo = dados?.resumo;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Activity size={22} /> Saúde da Sincronização</h1>
          <p className="ink-soft">
            O que o sistema deixou de saber — e o que ele não vai descobrir sozinho.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {erro && <p className="erro-inline">{erro}</p>}
      {recado && <p className={recado.tom === 'erro' ? 'erro-inline' : 'sucesso-inline'}>{recado.texto}</p>}
      {carregando && !dados && <Skeleton height={320} />}

      {dados && (
        <>
          {/* A frase que alguém com pressa lê. Fala do pior caso primeiro e
              nunca arredonda para melhor. */}
          <div className={`saude-frase ${dados.frase.tom}`}>
            {dados.frase.tom === 'tone-saudavel' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span>{dados.frase.texto}</span>
          </div>

          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Fora do sistema"
              valor={formatQtd(resumo.abandonadas)}
              Icone={PackageX}
              tom={resumo.abandonadas > 0 ? 'negativo' : undefined}
              explicacao={`Pedidos que falharam e já saíram da janela de ${dados.janela_dias} dias. Não vão ser procurados de novo sozinhos.`}
            />
            <IndicadorDestaque
              rotulo="Ainda vai tentar"
              valor={formatQtd(resumo.emFila)}
              Icone={Clock}
              tom={resumo.emFila > 0 ? 'atencao' : undefined}
              explicacao={`Falharam, mas o pedido ainda está na janela — a sincronização volta sozinha a cada ${dados.ciclo_minutos} min.`}
            />
            <IndicadorDestaque
              rotulo="Valor que não entrou"
              valor={brl(resumo.valor.total)}
              explicacao={
                resumo.valor.semValor > 0
                  ? `Soma de ${formatQtd(resumo.valor.comValor)} pedido(s). Outros ${formatQtd(resumo.valor.semValor)} não têm valor conhecido e NÃO entraram como R$ 0,00 — o total real é maior.`
                  : `Soma dos itens de ${formatQtd(resumo.valor.comValor)} pedido(s), como o marketplace mandou.`
              }
            />
            <IndicadorDestaque
              rotulo="Mais antigo"
              valor={resumo.maisAntiga ? tempoRelativo(resumo.maisAntiga) : '—'}
              explicacao="Data do pedido mais velho que ainda está faltando."
            />
          </div>

          <section className="card">
            <h3 className="card-titulo"><PlugZap size={16} /> As conexões</h3>
            <p className="grafico-explicacao">
              Uma conexão parada é pior que qualquer pedido perdido: enquanto ela estiver assim,
              nenhum pedido novo entra por ela.
            </p>
            <div className="tabela-rolagem">
              <table className="tabela-saude-conexoes">
                <thead>
                  <tr>
                    <th>Loja</th>
                    <th>Plataforma</th>
                    <th>Situação</th>
                    <th>Última sincronização</th>
                    <th>Motivo</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {dados.conexoes.map((c) => (
                    <tr key={c.id} className={['parada', 'sem_autorizacao', 'token_vencido'].includes(c.situacao.situacao) ? 'linha-prejuizo' : ''}>
                      <td><strong>{c.nome}</strong></td>
                      <td>{rotuloPlataforma(c.marketplace)}</td>
                      <td><SeloSituacao situacao={c.situacao} /></td>
                      <td className="mono">{tempoRelativo(c.ultima_sincronizacao)}</td>
                      <td className="ink-soft">{c.situacao.motivo || '—'}</td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn-sec"
                          disabled={ocupado === `conexao-${c.id}` || !c.ativo}
                          onClick={() => acao(
                            `conexao-${c.id}`,
                            () => api.post(`/saude-integracao/conexoes/${c.id}/sincronizar`),
                            'Ciclo concluído.'
                          )}
                        >
                          <RotateCw size={14} className={ocupado === `conexao-${c.id}` ? 'girando' : ''} /> Sincronizar agora
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="filtros-linha">
            <Select value={filtroSituacao} onChange={(e) => setFiltroSituacao(e.target.value)} placeholder="Todas as pendências">
              <option value="abandonada">Só as que estão fora do sistema</option>
              <option value="em_fila">Só as que ainda vão ser tentadas</option>
            </Select>
          </div>

          {falhas.length === 0 && (
            <EstadoVazio
              Icone={CheckCircle2}
              titulo={resumo.abertas === 0 ? 'Nenhum pedido ficou de fora' : 'Nada neste filtro'}
              descricao={
                resumo.abertas === 0
                  ? `Toda importação que falhou desde então já foi resolvida. O histórico dos últimos ${dados.dias_de_historico} dias fica guardado.`
                  : 'Tire o filtro para ver as demais pendências.'
              }
            />
          )}

          {falhas.length > 0 && (
            <section className="card">
              <h3 className="card-titulo"><PackageX size={16} /> Pedidos que não entraram</h3>
              <p className="grafico-explicacao">
                Cada linha é uma venda que o marketplace tem e o sistema não. “Buscar de novo” vai lá,
                pega o pedido pelo ID e tenta importar outra vez — é o único caminho para os que já
                saíram da janela de {dados.janela_dias} dias.
              </p>
              <div className="tabela-rolagem">
                <table className="tabela-saude-falhas">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Loja</th>
                      <th>Data</th>
                      <th className="num">Valor dos itens</th>
                      <th>Situação</th>
                      <th>O que aconteceu</th>
                      <th className="num">Tentativas</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {falhas.map((f) => {
                      const categoria = dados.categorias[f.categoria] || dados.categorias.desconhecido;
                      return (
                        <tr key={f.id} className={f.situacao.situacao === 'abandonada' ? 'linha-prejuizo' : ''}>
                          <td className="mono">{f.id_externo}</td>
                          <td>
                            {f.integracao_nome}
                            <small className="ink-faint"> · {rotuloPlataforma(f.marketplace)}</small>
                          </td>
                          <td className="mono">{f.data_pedido ? dataBr(String(f.data_pedido).slice(0, 10)) : <span className="ink-faint">sem data</span>}</td>
                          <td className="num mono">
                            {f.valor_itens != null ? brl(f.valor_itens) : <span className="ink-faint">desconhecido</span>}
                          </td>
                          <td><SeloSituacao situacao={f.situacao} /></td>
                          <td>
                            <div className="saude-erro">
                              <strong>{categoria.rotulo}</strong>
                              <small className="ink-soft">{categoria.oQueFazer}</small>
                              <code title={f.erro}>{f.erro}</code>
                            </div>
                          </td>
                          <td className="num mono">{formatQtd(f.tentativas)}</td>
                          <td className="num saude-acoes">
                            <button
                              type="button"
                              className="btn-sec"
                              disabled={ocupado === `falha-${f.id}`}
                              onClick={() => acao(
                                `falha-${f.id}`,
                                () => api.post(`/saude-integracao/falhas/${f.id}/tentar-novamente`),
                                'Pedido importado.'
                              )}
                            >
                              <RotateCw size={14} className={ocupado === `falha-${f.id}` ? 'girando' : ''} /> Buscar de novo
                            </button>
                            <button
                              type="button"
                              className="btn-sec"
                              disabled={ocupado === `encerrar-${f.id}`}
                              title="Some da lista sem importar. Nada é apagado: fica registrado quem encerrou e quando."
                              onClick={() => acao(
                                `encerrar-${f.id}`,
                                () => api.post(`/saude-integracao/falhas/${f.id}/encerrar`),
                                'Pendência encerrada.'
                              )}
                            >
                              <Archive size={14} /> Encerrar
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="ajuda-bloco ink-soft">
                <Info size={13} /> A janela de {dados.janela_dias} dias conta a partir da <strong>data do pedido</strong>,
                não da data da falha — um pedido antigo que só falhou hoje já está fora dela.
              </p>
            </section>
          )}

          {resumo.resolvidas > 0 && (
            <section className="card">
              <button
                type="button"
                className="saude-resolvidas-toggle"
                aria-expanded={verResolvidas}
                onClick={() => setVerResolvidas((v) => !v)}
              >
                {verResolvidas ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <CheckCircle2 size={16} />
                <span>
                  {formatQtd(resumo.resolvidas)} {resumo.resolvidas === 1 ? 'pendência resolvida' : 'pendências resolvidas'}
                  {' '}nos últimos {dados.dias_de_historico} dias
                </span>
              </button>

              {verResolvidas && (
                <>
                  <p className="grafico-explicacao">
                    Nada aqui está em aberto. A lista existe para conferir o que voltou — e como voltou:
                    “importado” quer dizer que o pedido entrou; “encerrado por uma pessoa” quer dizer que
                    alguém decidiu que ele não devia entrar.
                  </p>
                  <div className="tabela-rolagem">
                    <table className="tabela-saude-falhas">
                      <thead>
                        <tr>
                          <th>Pedido</th>
                          <th>Loja</th>
                          <th>Data</th>
                          <th className="num">Valor dos itens</th>
                          <th>Como saiu</th>
                          <th>Quando</th>
                          <th className="num">Tentativas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(resumo.listaResolvidas || []).map((f) => (
                          <tr key={f.id}>
                            <td className="mono">{f.id_externo}</td>
                            <td>
                              {f.integracao_nome}
                              <small className="ink-faint"> · {rotuloPlataforma(f.marketplace)}</small>
                            </td>
                            <td className="mono">{f.data_pedido ? dataBr(String(f.data_pedido).slice(0, 10)) : <span className="ink-faint">sem data</span>}</td>
                            <td className="num mono">
                              {f.valor_itens != null ? brl(f.valor_itens) : <span className="ink-faint">desconhecido</span>}
                            </td>
                            <td>
                              <span className="selo tone-elevada">
                                {f.resolvido_como === 'manual' ? 'encerrado por uma pessoa' : 'importado'}
                              </span>
                            </td>
                            <td>
                              <span title={f.resolvido_em ? new Date(f.resolvido_em).toLocaleString('pt-BR') : undefined}>
                                {tempoRelativo(f.resolvido_em)}
                              </span>
                            </td>
                            <td className="num mono">{formatQtd(f.tentativas)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
