import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Factory, RefreshCw, AlertTriangle, ChevronDown, ChevronRight, Layers,
  TriangleAlert, CalendarClock, CheckCircle2, Boxes, PackageCheck, Info,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, CampoBusca, Paginacao, BotaoRelatorio,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoTresMeses } from '../lib/periodos';
import { useTabela } from '../lib/useTabela';
import { formatQtd, dataBr } from '../lib/format';
import { montarDefinicaoProjecao } from '../lib/projecaoRelatorio';

// Produção › Projeção de estoque.
//
// A tela que cruza duas perguntas que o sistema já respondia separadas: a
// Cobertura diz o que falta, a Produção diz o que está vindo. O cruzamento é
// o que decide — a ordem que já está aberta resolve a falta, ou chega curta?
//
// Ela é a versão em massa, e por variante, do relatório em PDF de três camadas
// aprovado em 10/09/2026:
//
//   Camada 1 — a soma das ordens vivas, na grade cor × tamanho da OP.
//   Camada 2 — o saldo físico com o que está a caminho ao lado, em azul.
//   Camada 3 — o projetado, em duas colunas: o teto bruto e o líquido, este
//              descontando a venda prevista até a chegada da última ordem.
//
// O QUARTO NÚMERO do topo — "a produção não resolve" — é o motivo de a tela
// existir. Sem ele isto seria mais uma tela de somar estoque.

const SEM_COR = '—';

// Swatch da cor. `hex` vem de `produto_cores` (seed na migration 0066); cor
// sem hex cadastrado desenha um quadrado neutro em vez de inventar uma cor —
// inventar faria a grade mentir de relance, que é justamente o que o swatch
// veio evitar.
function Swatch({ hex, cor, ehQualidade }) {
  if (ehQualidade) {
    return <span className="pe-swatch pe-swatch-qualidade" title="Classificação de qualidade, não é uma cor" />;
  }
  if (!hex) {
    return <span className="pe-swatch pe-swatch-vazio" title={`${cor} — sem cor de tela cadastrada`} />;
  }
  const nome = String(cor || '').toUpperCase();
  const estilo = nome.includes('MESCLA')
    ? { backgroundImage: `repeating-linear-gradient(45deg, ${hex} 0 2px, ${hex}99 2px 4px)` }
    : { background: hex };
  return <span className="pe-swatch" style={estilo} title={`${cor} ${hex}`} />;
}

function Celula({ valor, classe = '' }) {
  if (!valor) return <td className="pe-n pe-zero">–</td>;
  return <td className={`pe-n ${classe}`}>{formatQtd(valor)}</td>;
}

// ---------------------------------------------------------------------------
// As três camadas de uma referência
// ---------------------------------------------------------------------------
function Camadas({ dados: r, tamanhos }) {
  const linhasPorCor = useMemo(() => {
    const mapa = new Map();
    for (const l of r.linhas) {
      const atual = mapa.get(l.cor) || { cor: l.cor, hex: l.hex, ehQualidade: l.ehQualidade, porTamanho: new Map() };
      atual.porTamanho.set(l.tamanho, l);
      mapa.set(l.cor, atual);
    }
    return [...mapa.values()];
  }, [r.linhas]);

  const somaCol = (extrair) => tamanhos.map((t) => linhasPorCor.reduce(
    (acc, c) => acc + (c.ehQualidade ? 0 : extrair(c.porTamanho.get(t))), 0
  ));
  const q = (l, campo) => (l ? Number(l[campo]) || 0 : 0);

  const cabecalho = (
    <thead>
      <tr>
        <th className="pe-hcor">Cor</th>
        {tamanhos.map((t) => <th key={t}>{t || SEM_COR}</th>)}
        <th className="pe-htot">Total</th>
      </tr>
    </thead>
  );

  const totaisProducao = somaCol((l) => q(l, 'producao'));
  const totaisSaldo = somaCol((l) => q(l, 'saldo'));
  const totaisBruto = somaCol((l) => q(l, 'bruto'));

  const comProducao = linhasPorCor.filter((c) => [...c.porTamanho.values()].some((l) => l.producao > 0));

  return (
    <div className="pe-camadas">
      {/* ---------------- CAMADA 1 ---------------- */}
      <div className="pe-camada-topo">
        <span className="pe-tag">Camada 1</span>
        <div className="pe-camada-tit">
          Produção agrupada por referência
          <span className="pe-camada-sub">Soma das ordens vivas, na mesma grade cor × tamanho da OP</span>
        </div>
      </div>

      <div className="pe-chips">
        {r.ordens.map((o) => (
          <span key={o.id} className={`pe-chip ${o.semData ? 'pe-chip-alerta' : ''}`}>
            <b>OP {o.numero}</b>
            {o.semData
              ? <span className="pe-chip-sem-data"><CalendarClock size={11} /> sem data prevista</span>
              : <span>{dataBr(o.dataPrevista)}</span>}
            <span>{formatQtd(o.pendente)} pçs</span>
            {o.faccao ? <span className="pe-chip-faccao">{o.faccao}</span> : null}
          </span>
        ))}
      </div>

      {comProducao.length === 0 ? (
        <p className="pe-vazio-camada">Nenhuma ordem viva com saldo pendente para esta referência.</p>
      ) : (
        <div className="pe-rolagem">
          <table className="pe-grade pe-producao">
            {cabecalho}
            <tbody>
              {comProducao.map((c) => {
                const total = tamanhos.reduce((a, t) => a + q(c.porTamanho.get(t), 'producao'), 0);
                return (
                  <tr key={c.cor}>
                    <td className="pe-cor"><Swatch hex={c.hex} cor={c.cor} ehQualidade={c.ehQualidade} />{c.cor || SEM_COR}</td>
                    {tamanhos.map((t) => <Celula key={t} valor={q(c.porTamanho.get(t), 'producao')} />)}
                    <td className="pe-tot">{formatQtd(total)}</td>
                  </tr>
                );
              })}
              <tr className="pe-totrow">
                <td className="pe-cor">TOTALIZADOR</td>
                {totaisProducao.map((v, i) => <Celula key={i} valor={v} />)}
                <td className="pe-tot">{formatQtd(r.totais.producao)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- CAMADA 2 ---------------- */}
      <div className="pe-camada-topo">
        <span className="pe-tag">Camada 2</span>
        <div className="pe-camada-tit">
          Estoque real + em produção
          <span className="pe-camada-sub">
            Leitura: <b className="pe-e">estoque físico</b> <b className="pe-p">+ em produção</b>
          </span>
        </div>
      </div>

      <div className="pe-rolagem">
        <table className="pe-grade">
          {cabecalho}
          <tbody>
            {linhasPorCor.map((c) => {
              const saldo = tamanhos.reduce((a, t) => a + q(c.porTamanho.get(t), 'saldo'), 0);
              const prod = tamanhos.reduce((a, t) => a + q(c.porTamanho.get(t), 'producao'), 0);
              return (
                <tr key={c.cor} className={c.ehQualidade ? 'pe-linha-qualidade' : ''}>
                  <td className="pe-cor">
                    <Swatch hex={c.hex} cor={c.cor} ehQualidade={c.ehQualidade} />
                    {c.cor || SEM_COR}
                    {c.ehQualidade ? <span className="pe-selo-qualidade">2ª qualidade</span> : null}
                  </td>
                  {tamanhos.map((t) => {
                    const l = c.porTamanho.get(t);
                    const s = q(l, 'saldo'); const p = q(l, 'producao');
                    if (!s && !p) return <td key={t} className="pe-n pe-zero">–</td>;
                    return (
                      <td key={t} className="pe-n pe-dual">
                        <span className="pe-e">{formatQtd(s)}</span>
                        {p ? <span className="pe-p">+{formatQtd(p)}</span> : null}
                      </td>
                    );
                  })}
                  <td className="pe-tot pe-dual">
                    <span className="pe-e">{formatQtd(saldo)}</span>
                    {prod ? <span className="pe-p">+{formatQtd(prod)}</span> : null}
                  </td>
                </tr>
              );
            })}
            <tr className="pe-totrow">
              <td className="pe-cor">TOTALIZADOR</td>
              {tamanhos.map((t, i) => (
                <td key={t} className="pe-n pe-dual">
                  <span className="pe-e">{formatQtd(totaisSaldo[i])}</span>
                  {totaisProducao[i] ? <span className="pe-p">+{formatQtd(totaisProducao[i])}</span> : null}
                </td>
              ))}
              <td className="pe-tot pe-dual">
                <span className="pe-e">{formatQtd(r.totais.estoque)}</span>
                <span className="pe-p">+{formatQtd(r.totais.producao)}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ---------------- CAMADA 3 ---------------- */}
      <div className="pe-camada-topo">
        <span className="pe-tag">Camada 3</span>
        <div className="pe-camada-tit">
          Estoque projetado após entrega das ordens
          <span className="pe-camada-sub">
            {r.diasHorizonte == null
              ? 'Sem data prevista nas ordens — só o teto bruto pode ser calculado'
              : r.atrasada
                ? `Ordem vencida há ${r.diasAtraso} dia(s): não há janela de venda a descontar, então o Líquido sai igual ao Bruto`
                : `Teto bruto e, ao lado, o líquido: descontando a venda prevista dos próximos ${r.diasHorizonte} dias`}
          </span>
        </div>
      </div>

      <div className="pe-rolagem">
        <table className="pe-grade pe-final">
          <thead>
            <tr>
              <th className="pe-hcor">Cor</th>
              {tamanhos.map((t) => <th key={t}>{t || SEM_COR}</th>)}
              <th className="pe-htot">Bruto</th>
              <th className="pe-htot pe-hliq">Líquido</th>
            </tr>
          </thead>
          <tbody>
            {linhasPorCor.map((c) => {
              const bruto = tamanhos.reduce((a, t) => a + q(c.porTamanho.get(t), 'bruto'), 0);
              const temLiq = [...c.porTamanho.values()].some((l) => l.liquido != null);
              const liq = tamanhos.reduce((a, t) => {
                const l = c.porTamanho.get(t);
                return a + (l && l.liquido != null ? Number(l.liquido) : q(l, 'bruto'));
              }, 0);
              return (
                <tr key={c.cor} className={c.ehQualidade ? 'pe-linha-qualidade' : ''}>
                  <td className="pe-cor">
                    <Swatch hex={c.hex} cor={c.cor} ehQualidade={c.ehQualidade} />
                    {c.cor || SEM_COR}
                  </td>
                  {tamanhos.map((t) => {
                    const l = c.porTamanho.get(t);
                    const v = q(l, 'bruto');
                    const naoResolve = l && !l.resolvida && !c.ehQualidade;
                    if (!v) return <td key={t} className="pe-n pe-zero">–</td>;
                    return (
                      <td key={t} className={`pe-n ${l && l.producao ? 'pe-up' : ''} ${naoResolve ? 'pe-falta' : ''}`}
                        title={naoResolve ? `Continua abaixo do ponto de pedido (${formatQtd(l.pontoDePedido)}) mesmo depois da ordem chegar.` : undefined}>
                        {formatQtd(v)}
                      </td>
                    );
                  })}
                  <td className="pe-tot">{formatQtd(bruto)}</td>
                  <td className={`pe-tot pe-liq ${temLiq ? '' : 'pe-sem-liq'}`}>
                    {temLiq ? formatQtd(liq) : '—'}
                  </td>
                </tr>
              );
            })}
            <tr className="pe-totrow">
              <td className="pe-cor">TOTALIZADOR</td>
              {totaisBruto.map((v, i) => <Celula key={i} valor={v} />)}
              <td className="pe-tot">{formatQtd(r.totais.bruto)}</td>
              <td className="pe-tot pe-liq">
                {r.diasHorizonte == null ? '—' : formatQtd(r.totais.liquido)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Ressalvas da referência — escritas, nunca escondidas. */}
      <div className="pe-ressalvas">
        {r.atrasada ? (
          <p className="pe-ressalva pe-ressalva-alerta">
            <CalendarClock size={13} />
            A data prevista mais distante desta referência venceu há <b>{r.diasAtraso} dia(s)</b>.
            Uma ordem vencida não chega hoje — enquanto a data não for replanejada, o Líquido
            não tem janela para descontar e sai igual ao Bruto.
          </p>
        ) : null}
        {r.semDataPrevista ? (
          <p className="pe-ressalva pe-ressalva-alerta">
            <CalendarClock size={13} />
            Há ordem sem data prevista nesta referência. Sem data não existe janela para projetar
            venda, então a coluna Líquido fica vazia — não se inventa data.
          </p>
        ) : null}
        {r.pecasEmKitSemGrade > 0 ? (
          <p className="pe-ressalva">
            <Info size={13} />
            {formatQtd(r.pecasEmKitSemGrade)} peças desta referência foram vendidas <b>em kit</b> no
            período, e item de kit não tem cor e tamanho. A demanda por variante — e portanto o
            Líquido — está subestimada aqui.
          </p>
        ) : null}
        {r.suspeitasEntregaParcial.length > 0 ? (
          <div className="pe-ressalva pe-ressalva-alerta">
            <TriangleAlert size={13} />
            <div>
              <b>Possível entrega parcial não baixada.</b> O saldo de algumas variantes subiu desde a
              abertura da ordem, mas a grade continua declarando tudo pendente — as peças podem estar
              contadas duas vezes.
              <ul className="pe-suspeitas">
                {r.suspeitasEntregaParcial.map((s) => (
                  <li key={s.ordemId}>
                    OP {s.numero}: até <b>{formatQtd(s.total)} peças</b> podem já ter entrado.
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {r.ordensEncerradasComPendencia.length > 0 ? (
          <p className="pe-ressalva pe-ressalva-alerta">
            <AlertTriangle size={13} />
            <span>
              <b>Ordem encerrada com saldo pendente:</b>{' '}
              {r.ordensEncerradasComPendencia.map((o) => `OP ${o.numero} (${formatQtd(o.pendente)} pçs)`).join(', ')}.
              Ordem concluída deveria ter dado entrada de tudo — ou a entrada foi parcial, ou a grade
              não foi fechada. Não entra na soma.
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function ProjecaoEstoquePage() {
  const [periodo, setPeriodo] = useState(periodoTresMeses);
  const [todas, setTodas] = useState(false);
  const [busca, setBusca] = useState('');
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [abertas, setAbertas] = useState(() => new Set());

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try {
      const p = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim });
      if (todas) p.set('todas', '1');
      setDados(await api.get(`/producao-projecao?${p.toString()}`));
    } catch (e) {
      setErro(e.message || 'Não consegui carregar a projeção.');
    } finally {
      setCarregando(false);
    }
  }, [periodo, todas]);

  useEffect(() => { carregar(); }, [carregar]);

  const referencias = dados?.referencias || [];

  const filtradas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    if (!t) return referencias;
    return referencias.filter((r) => `${r.referencia} ${r.descricao || ''} ${r.marca || ''}`
      .toLowerCase().includes(t));
  }, [referencias, busca]);

  const tabela = useTabela(filtradas, {
    colunas: {
      referencia: (r) => r.referencia,
      naoResolve: (r) => r.totais.naoResolve,
      producao: (r) => r.totais.producao,
      estoque: (r) => r.totais.estoque,
    },
    colunaPadrao: 'naoResolve',
    direcaoPadrao: 'desc',
    tamanhoPadrao: 25,
  });

  const alternar = (id) => setAbertas((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const totais = dados?.totais;

  return (
    <div className="pagina pe-pagina">
      <header className="pagina-topo">
        <div>
          <h1><Factory size={20} /> Projeção de estoque</h1>
          <p className="pagina-sub">
            O que você vai ter em cada cor e tamanho quando a produção chegar — e onde ela não
            vai ser suficiente.
          </p>
        </div>
        <div className="pagina-acoes">
          <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
          <button type="button" className="botao-secundario" onClick={carregar} disabled={carregando}>
            <RefreshCw size={14} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
          <BotaoRelatorio
            disabled={carregando || !dados}
            rotulo="Exportar"
            descricaoResumo="Os quatro números e uma linha por referência — cabe em poucas páginas."
            descricaoCompleto="As três camadas de cada referência, na grade cor × tamanho."
            montar={(tipo) => montarDefinicaoProjecao({ dados, filtradas, periodo, tipo })}
          />
        </div>
      </header>

      {/* Os quatro números. O quarto é o que justifica a tela. */}
      <section className="pe-kpis">
        <div className="pe-kpi">
          <span className="pe-kl"><Boxes size={13} /> Estoque hoje</span>
          <strong>{carregando ? '—' : formatQtd(totais?.estoque || 0)}</strong>
          <small>peças em saldo, sem contar 2ª qualidade</small>
        </div>
        <div className="pe-kpi pe-kpi-prod">
          <span className="pe-kl"><Factory size={13} /> Em produção</span>
          <strong>+{carregando ? '—' : formatQtd(totais?.producao || 0)}</strong>
          <small>{referencias.length} referência(s) com ordem viva</small>
        </div>
        <div className="pe-kpi pe-kpi-proj">
          <span className="pe-kl"><PackageCheck size={13} /> Projetado</span>
          <strong>{carregando ? '—' : formatQtd(totais?.projetadoBruto || 0)}</strong>
          <small>
            líquido: {carregando ? '—' : formatQtd(totais?.projetadoLiquido || 0)} peças
          </small>
        </div>
        <div className={`pe-kpi pe-kpi-falta ${(totais?.naoResolve || 0) > 0 ? 'pe-kpi-alerta' : ''}`}>
          <span className="pe-kl"><TriangleAlert size={13} /> A produção não resolve</span>
          <strong>{carregando ? '—' : formatQtd(totais?.naoResolve || 0)}</strong>
          <small>variantes que seguem abaixo do ponto mesmo depois da ordem chegar</small>
        </div>
      </section>

      <div className="pe-filtros">
        <CampoBusca valor={busca} onChange={setBusca} placeholder="Referência, descrição ou marca…" />
        <label className="pe-check">
          <input type="checkbox" checked={todas} onChange={(e) => setTodas(e.target.checked)} />
          Mostrar também referências sem ordem aberta
        </label>
      </div>

      {erro ? <div className="alerta-erro"><AlertTriangle size={15} /> {erro}</div> : null}

      {carregando ? (
        <div className="pe-carregando">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={58} radius={8} />)}
        </div>
      ) : null}

      {!carregando && filtradas.length === 0 ? (
        <EstadoVazio
          Icone={Factory}
          titulo="Nenhuma ordem de produção viva"
          descricao={
            'Quando houver, esta tela mostra o que a produção vai acrescentar em cada cor e '
            + 'tamanho — e, principalmente, onde ela não vai ser suficiente.'
          }
        />
      ) : null}

      {!carregando && filtradas.length > 0 ? (
        <>
          {/* Paginação no início E no fim, como em toda lista do sistema. */}
          <Paginacao {...tabela} posicao="topo" />

          <div className="pe-lista">
            {tabela.itensPagina.map((r) => {
              const aberta = abertas.has(r.produtoId);
              // A ordem canônica de tamanho vem pronta do servidor (a mesma
              // ORDEM_TAMANHOS da casa). Preservar a ordem de primeira
              // aparição basta — reordenar aqui alfabeticamente colocaria o
              // GG antes do M.
              const tamanhosOrdenados = [];
              for (const l of r.linhas) if (!tamanhosOrdenados.includes(l.tamanho)) tamanhosOrdenados.push(l.tamanho);

              return (
                <article key={r.produtoId} className={`pe-card ${aberta ? 'pe-card-aberto' : ''}`}>
                  <button type="button" className="pe-card-topo" onClick={() => alternar(r.produtoId)}>
                    <span className="pe-card-seta">
                      {aberta ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                    <span className="pe-card-id">
                      <b>{r.referencia}</b>
                      <span>{r.descricao}</span>
                    </span>
                    <span className="pe-card-nums">
                      <span className="pe-card-num">
                        <small>Estoque</small>{formatQtd(r.totais.estoque)}
                      </span>
                      <span className="pe-card-num pe-card-prod">
                        <small>Em produção</small>+{formatQtd(r.totais.producao)}
                      </span>
                      <span className="pe-card-num pe-card-proj">
                        <small>Projetado</small>{formatQtd(r.totais.bruto)}
                      </span>
                      {r.atrasada ? (
                        <span className="pe-card-num pe-card-atraso" title={`Ordem vencida há ${r.diasAtraso} dia(s)`}>
                          <small>Atraso</small>{r.diasAtraso}d
                        </span>
                      ) : null}
                      {r.totais.naoResolve > 0 ? (
                        <span className="pe-card-num pe-card-falta">
                          <small>Não resolve</small>{formatQtd(r.totais.naoResolve)}
                        </span>
                      ) : (
                        <span className="pe-card-num pe-card-ok">
                          <small>&nbsp;</small><CheckCircle2 size={15} />
                        </span>
                      )}
                    </span>
                  </button>
                  {aberta ? <Camadas dados={r} tamanhos={tamanhosOrdenados} /> : null}
                </article>
              );
            })}
          </div>

          <Paginacao {...tabela} posicao="rodape" />
        </>
      ) : null}

      {dados?.ressalvas?.length ? (
        <section className="pe-notas">
          <h3><Layers size={14} /> Como este número é feito</h3>
          <ul>{dados.ressalvas.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}
