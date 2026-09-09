import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Gauge, RefreshCw, AlertTriangle, Info, Timer, Trophy, Truck,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, IndicadorDestaque } from '../components/ui';
import { brl, pct, formatQtd, numeroBr } from '../lib/format';

// Produção › Carga e gargalo.
//
// A ideia é do Consistem (CCTCO800) e é a que muda a conversa: o gargalo não
// aparece em número de peças, aparece em MINUTOS de trabalho pendentes. Uma
// etapa com 200 peças de 30 segundos está folgada; a mesma 200 peças de 8
// minutos cada está travada há uma semana.
//
// REGRA 2: etapa cujo roteiro não tem tempo cadastrado aparece escrita como
// "sem tempo no roteiro" — nunca como 0 minuto. Zero minuto diria que aquela
// etapa está livre, que é exatamente o contrário do que se sabe sobre ela: não
// se sabe nada.
//
// Na mesma tela, o ranking de facção — quem quebra, quem entrega no prazo e
// quanto cada uma custa. É o que fecha o ciclo: sem isso, escolher facção
// continua sendo pelo telefone.

const ROTA = '/producao-movimentacao';

export default function CargaProducaoPage() {
  const [carga, setCarga] = useState(null);
  const [ranking, setRanking] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [c, r] = await Promise.all([
        api.get(`${ROTA}/carga`),
        api.get(`${ROTA}/ranking-faccao`),
      ]);
      setCarga(c);
      setRanking(r);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const linhas = carga?.carga || [];

  const resumo = useMemo(() => {
    const comTempo = linhas.filter((l) => l.minutos != null);
    const minutos = comTempo.reduce((s, l) => s + Number(l.minutos), 0);
    const pecas = linhas.reduce((s, l) => s + Number(l.pecas || 0), 0);
    const maiorMinutos = comTempo.length
      ? comTempo.reduce((a, b) => (Number(a.minutos) >= Number(b.minutos) ? a : b))
      : null;
    const maiorPecas = linhas.length
      ? linhas.reduce((a, b) => (Number(a.pecas) >= Number(b.pecas) ? a : b))
      : null;
    return { minutos, pecas, maiorMinutos, maiorPecas, comTempo: comTempo.length };
  }, [linhas]);

  // A barra é proporcional à maior carga em minutos. Etapa sem tempo não tem
  // barra nenhuma de propósito: desenhar uma barra vazia sugeriria folga.
  const maiorCarga = useMemo(
    () => linhas.reduce((m, l) => Math.max(m, l.minutos == null ? 0 : Number(l.minutos)), 0),
    [linhas]
  );

  const semTempo = Number(carga?.etapas_sem_tempo || 0);

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Gauge size={22} /> Carga e gargalo</h1>
          <p className="ink-soft">
            Onde a produção está represada, em peças e em minutos de trabalho — e como cada
            facção vem se comportando em quebra, segunda qualidade, prazo e custo.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && <Skeleton height={280} />}

      {!carregando && (
        <>
          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Peças paradas em alguma etapa"
              valor={formatQtd(resumo.pecas)}
              explicacao="Somando todas as etapas de todas as ordens abertas. É o trabalho que já entrou e ainda não saiu."
            />
            <IndicadorDestaque
              rotulo="Trabalho pendente"
              valor={resumo.comTempo > 0
                ? `${numeroBr(resumo.minutos / 60, 1)} h`
                : 'não dá para dizer'}
              tom={resumo.comTempo === 0 ? 'atencao' : undefined}
              Icone={Timer}
              explicacao={resumo.comTempo > 0
                ? 'Soma dos minutos de trabalho das etapas que têm tempo no roteiro. As que não têm ficaram de FORA — fora não é zero.'
                : 'Nenhuma etapa tem tempo casado no roteiro, então não há minutos a somar. Cadastre o tempo das operações para esta conta existir.'}
            />
            <IndicadorDestaque
              rotulo="Gargalo por minutos"
              valor={resumo.maiorMinutos
                ? `${resumo.maiorMinutos.etapa_nome} — ${numeroBr(Number(resumo.maiorMinutos.minutos) / 60, 1)} h`
                : 'não dá para dizer'}
              tom={resumo.maiorMinutos ? 'prejuizo' : 'atencao'}
              explicacao={resumo.maiorMinutos
                ? 'A etapa com mais minutos de trabalho acumulados. É por ela que a produção inteira vai passar mais devagar.'
                : 'Sem tempo cadastrado no roteiro não há como dizer qual etapa é o gargalo — a que tem mais peças pode ser a mais rápida.'}
            />
            <IndicadorDestaque
              rotulo="Maior fila em peças"
              valor={resumo.maiorPecas
                ? `${resumo.maiorPecas.etapa_nome} — ${formatQtd(resumo.maiorPecas.pecas)}`
                : '—'}
              explicacao="A etapa com mais peças esperando. Nem sempre é o gargalo: muita peça rápida atravanca menos que pouca peça lenta."
            />
          </div>

          {semTempo > 0 && (
            <p className="aviso-inline">
              <AlertTriangle size={14} />
              {formatQtd(semTempo)} etapa(s) estão sem tempo no roteiro e por isso NÃO entram na
              conta de minutos. Elas aparecem na lista abaixo escritas como "sem tempo no roteiro",
              não como zero — o tempo delas é desconhecido, e desconhecido não é folga. Para
              incluí-las, cadastre o tempo da operação com o mesmo nome da etapa, no roteiro do
              produto.
            </p>
          )}

          <div className="card">
            <h2 className="card-titulo"><Gauge size={16} /> Carga por etapa</h2>
            <p className="ink-soft ajuda-bloco">
              Ordenado por minutos de trabalho pendentes, do mais travado para o mais folgado.
              A barra é proporcional à maior carga da fábrica.
            </p>

            {linhas.length === 0 ? (
              <EstadoVazio
                Icone={Gauge}
                titulo="Nenhuma peça em etapa nenhuma"
                descricao="Não há peça parada em etapa alguma agora — ou porque nada foi movimentado ainda, ou porque tudo que entrou já saiu. A carga aparece aqui assim que a primeira movimentação de produção for gravada."
              />
            ) : (
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th>Etapa</th><th>Onde</th>
                      <th className="num">Ordens</th><th className="num">Peças</th>
                      <th className="num">Trabalho pendente</th><th>Carga</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.map((l) => {
                      const minutos = l.minutos == null ? null : Number(l.minutos);
                      const largura = maiorCarga > 0 && minutos != null
                        ? Math.max(2, (minutos / maiorCarga) * 100)
                        : 0;
                      return (
                        <tr key={`${l.etapa_id}-${l.fornecedor_id ?? 'interna'}`}>
                          <td>
                            <strong>{l.etapa_nome}</strong>
                            {l.natureza === 'externa' && (
                              <span className="selo tone-neutro" title="Etapa feita fora, por facção.">externa</span>
                            )}
                          </td>
                          <td>{l.fornecedor_nome || (l.natureza === 'externa' ? 'facção não informada' : 'interna')}</td>
                          <td className="num">{formatQtd(l.ordens)}</td>
                          <td className="num">{formatQtd(l.pecas)}</td>
                          <td className="num">
                            {minutos == null
                              ? <span className="selo tone-atencao" title="Nenhuma operação do roteiro do produto casa com o nome desta etapa, então o tempo dela é desconhecido — e desconhecido não é zero.">sem tempo no roteiro</span>
                              : `${numeroBr(minutos / 60, 1)} h`}
                          </td>
                          <td>
                            {minutos == null ? (
                              <span className="ink-faint">—</span>
                            ) : (
                              <div className="curva-barra-trilho">
                                <div className="curva-barra-preenchida" style={{ width: `${largura}%` }} />
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="card-titulo"><Trophy size={16} /> Ranking de facção</h2>
            <p className="ink-soft ajuda-bloco">
              <Info size={14} /> Somando todas as ordens de serviço de cada facção. Quebra é peça
              que saiu e não voltou; segunda é peça que voltou torta. Prazo só conta O.S. já
              concluída que tinha previsão de retorno — o resto não tem como ser julgado.
            </p>

            {ranking.length === 0 ? (
              <EstadoVazio
                Icone={Truck}
                titulo="Nenhuma facção com ordem de serviço"
                descricao="O ranking se alimenta das O.S. de facção. Enquanto nenhuma peça tiver sido remetida para uma etapa externa, não há o que comparar entre facções."
              />
            ) : (
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th>Facção</th><th className="num">O.S.</th>
                      <th className="num">Remetido</th><th className="num">Voltou bom</th>
                      <th className="num">Quebra</th><th className="num">% quebra</th>
                      <th className="num">% segunda</th><th className="num">No prazo</th>
                      <th className="num">Custo do serviço</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.map((f) => {
                      const quebra = Number(f.quebra || 0);
                      const comPrazo = Number(f.concluidas_com_prazo || 0);
                      return (
                        <tr key={f.fornecedor_id}>
                          <td><strong>{f.fornecedor_nome}</strong></td>
                          <td className="num">{formatQtd(f.ordens_servico)}</td>
                          <td className="num">{formatQtd(f.remetido)}</td>
                          <td className="num">{formatQtd(f.retornado_bom)}</td>
                          <td className={`num ${quebra > 0 ? 'ink-prejuizo' : ''}`}>{formatQtd(quebra)}</td>
                          <td className="num">
                            {f.quebra_fracao == null
                              ? '—'
                              : (
                                <span className={Number(f.quebra_fracao) > 0 ? 'ink-prejuizo' : ''}>
                                  {pct(f.quebra_fracao, 1)}
                                </span>
                              )}
                          </td>
                          <td className="num">
                            {f.segunda_fracao == null
                              ? '—'
                              : (
                                <span className={Number(f.segunda_fracao) > 0 ? 'ink-atencao' : ''}>
                                  {pct(f.segunda_fracao, 1)}
                                </span>
                              )}
                          </td>
                          <td className="num">
                            {comPrazo === 0
                              ? <span className="ink-faint" title="Nenhuma O.S. desta facção foi concluída com previsão de retorno cadastrada, então não há prazo a julgar.">sem O.S. com prazo</span>
                              : `${formatQtd(f.no_prazo)} de ${formatQtd(comPrazo)}`}
                          </td>
                          <td className="num">{brl(f.valor_servico)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
