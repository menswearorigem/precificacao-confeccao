import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Timer, RefreshCw, Info, Package, CircleSlash, HelpCircle, Flame, CalendarClock,
  Boxes, PauseCircle, CheckCircle2, ChevronDown, ChevronRight, Grid3x3,
  Copy, Check, AlertTriangle, Factory, Sparkles,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, CampoBusca, ChipsFiltros, Paginacao,
  NumInput, Field, BotaoExportar,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoTresMeses } from '../lib/periodos';
import { useTabela } from '../lib/useTabela';
import { brl, formatQtd, numeroBr, dataBr } from '../lib/format';

// Estoque › Cobertura e Reposição.
//
// Repaginada em 10/09/2026, depois de a dona dizer que a versão anterior
// estava confusa. O diagnóstico não foi da conta — o motor sempre esteve
// certo — e sim da ORGANIZAÇÃO: a tela respondia com vocabulário de
// estatística (comportamento, curva, Z, ponto de pedido) uma pergunta que é
// de operação: o que eu produzo esta semana, e em que cor e tamanho.
//
// Três mudanças de forma, todas vindas da planilha que a casa já usa:
//
//   1. A tela abre AGRUPADA POR AÇÃO — produzir esta semana · programar no
//      mês · parado · sem cálculo — e não numa lista única de 994 linhas.
//      Os quatro cartões do topo são os grupos: clicar num troca a lista.
//
//   2. A GRADE cor × tamanho é a resposta final. É o formato da aba
//      "Produtos que Vamos Permanecer" e é o formato em que a facção recebe
//      o pedido. Abre dentro da linha, carregada sob demanda.
//
//   3. A cadência (semanal · quinzenal · mensal · sob demanda) é editável na
//      própria linha. Ela decide o prazo usado no cálculo, e a escolha à mão
//      vence a sugerida pela venda — porque tricoline que leva três semanas
//      na facção não vira "semanal" por ter vendido bem em agosto.
//
// O jargão não sumiu: mudou de lugar. Curva, comportamento, nível de serviço
// e as fórmulas vivem no painel "como cheguei nesse número", dentro da linha.
// É o mesmo que a planilha faz ao pintar as colunas do meio e sugerir ocultá-las.

const SITUACAO = {
  sem_estoque: { rotulo: 'Sem estoque', tom: 'tone-prejuizo', ordem: 0 },
  comprar_agora: { rotulo: 'Repor agora', tom: 'tone-prejuizo', ordem: 1 },
  atencao: { rotulo: 'Chegando no limite', tom: 'tone-atencao', ordem: 2 },
  indeterminado: { rotulo: 'Não dá para dizer', tom: 'tone-neutro', ordem: 3 },
  ok: { rotulo: 'Tranquilo', tom: 'tone-saudavel', ordem: 4 },
};

// Os grupos de AÇÃO. `blocos` diz quais valores vindos da API caem em cada um
// — "parado" e "sobrando" moram juntos na tela porque a decisão é a mesma
// (escoar), embora o motivo seja diferente e a linha diga qual é.
const SECOES = [
  {
    chave: 'produzir_agora',
    blocos: ['produzir_agora'],
    rotulo: 'Produzir esta semana',
    curto: 'Produzir agora',
    Icone: Flame,
    tom: 'negativo',
    descricao: 'Já faltou, ou vai faltar antes da próxima rodada. Ordenado por dinheiro em risco.',
  },
  {
    chave: 'programar',
    blocos: ['programar'],
    rotulo: 'Programar no mês',
    curto: 'Programar',
    Icone: CalendarClock,
    tom: 'atencao',
    descricao: 'Abaixo do ponto de pedido, mas em cadência quinzenal ou mensal — entra na próxima ordem.',
  },
  {
    chave: 'sobrando',
    blocos: ['sobrando', 'parado'],
    rotulo: 'Parado e sobrando',
    curto: 'Parado',
    Icone: PauseCircle,
    tom: 'neutro',
    descricao: 'Estoque muito acima do que o ciclo pede, ou sem venda nenhuma na janela. É dinheiro preso.',
  },
  {
    chave: 'ok',
    blocos: ['ok'],
    rotulo: 'Tranquilo',
    curto: 'Tranquilo',
    Icone: CheckCircle2,
    tom: 'positivo',
    descricao: 'Acima do ponto de pedido e dentro do esperado para o ciclo.',
  },
  {
    chave: 'sem_calculo',
    blocos: ['sem_calculo'],
    rotulo: 'Sem cálculo possível',
    curto: 'Sem cálculo',
    Icone: CircleSlash,
    tom: 'neutro',
    descricao: 'O sistema não inventa número. Cada linha diz por que não deu.',
  },
];

const CADENCIA_TOM = {
  semanal: 'tone-prejuizo',
  quinzenal: 'tone-atencao',
  mensal: 'tone-neutro',
  sob_demanda: 'tone-neutro',
};

const NIVEL_TOM = {
  essencial: 'tone-elevada',
  intermediario: 'tone-saudavel',
  sob_demanda: 'tone-neutro',
  a_descontinuar: 'tone-atencao',
};

// Cor da faixa de cobertura. Os cortes são de leitura, não de teoria — servem
// para a tela dar um sinal de relance, e a decisão continua sendo o ponto de
// pedido, que é o número com fundamento.
function tomDaCobertura(dias) {
  if (dias == null) return 'tone-neutro';
  if (dias < 15) return 'tone-prejuizo';
  if (dias < 30) return 'tone-atencao';
  if (dias > 180) return 'tone-elevada';
  return 'tone-saudavel';
}

// A frase por extenso é a coisa certa no painel de detalhe e a coisa errada
// espremida numa coluna numérica: ela empurra a linha para três alturas e
// some com a tabela. Aqui ela vira um rótulo curto — e o texto inteiro
// continua acessível no title, sem nada se perder.
const MOTIVOS_CURTOS = [
  [/não teve venda no período/i, 'sem venda no período'],
  [/faltam a venda média ou o prazo/i, 'falta o prazo de produção'],
  [/sem venda medida/i, 'sem venda medida'],
  [/sem cadência definida/i, 'sem cadência'],
  [/sob demanda/i, 'sob demanda'],
  [/sem posição de estoque/i, 'sem posição'],
  [/sem saldo de estoque/i, 'sem saldo'],
];

function encurtarMotivo(motivo) {
  if (!motivo) return null;
  const achado = MOTIVOS_CURTOS.find(([re]) => re.test(motivo));
  if (achado) return achado[1];
  return motivo.length > 34 ? `${motivo.slice(0, 32)}…` : motivo;
}

// O número com a explicação embaixo. Quando não há número, o MOTIVO ocupa o
// lugar dele — nunca um travessão mudo.
function ValorOuMotivo({ valor, motivo, sufixo, casas = 0, titulo }) {
  if (valor == null) {
    return (
      <span className="cobertura-sem-valor" title={motivo || titulo}>
        <CircleSlash size={11} /> {motivo ? encurtarMotivo(motivo) : '—'}
      </span>
    );
  }
  return (
    <span className="mono" title={titulo}>
      {numeroBr(valor, casas)}{sufixo ? ` ${sufixo}` : ''}
    </span>
  );
}

// A saúde da GRADE num relance: quantas variantes estão zeradas.
// É a informação que o número por referência esconde — o P esgotado e o GG
// encalhado se cancelam dentro do mesmo saldo, e é justamente a diferença
// entre os dois que decide o que produzir.
function FaixaDaGrade({ total, zeradas }) {
  if (!total) return <span className="ink-faint">—</span>;
  const cheias = total - zeradas;
  const titulo = zeradas > 0
    ? `${zeradas} de ${total} variante(s) desta referência estão zeradas. Clique para abrir a grade por cor e tamanho.`
    : `As ${total} variantes têm saldo. Clique para abrir a grade por cor e tamanho.`;
  // Até 24 quadradinhos; acima disso vira barra proporcional, senão a faixa
  // ocuparia meia tela numa referência de 56 variantes.
  if (total <= 24) {
    return (
      <span className="grade-faixa" title={titulo}>
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={i < zeradas ? 'vazia' : 'cheia'} />
        ))}
      </span>
    );
  }
  return (
    <span className="grade-faixa grade-faixa-barra" title={titulo}>
      <i className="vazia" style={{ flexGrow: zeradas || 0.001 }} />
      <i className="cheia" style={{ flexGrow: cheias || 0.001 }} />
      <small className="mono">{zeradas}/{total}</small>
    </span>
  );
}

// ---------------------------------------------------------------------------
// A grade cor × tamanho — o formato da planilha da casa
// ---------------------------------------------------------------------------
// Carregada só quando a linha abre. `medida` alterna entre o saldo e a venda
// da janela: a mesma matriz responde "o que eu tenho" e "o que sai", que são
// as duas perguntas que decidem a grade da próxima ordem.
function GradeDaReferencia({ produtoId, periodo, referencia }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [medida, setMedida] = useState('saldo');
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro(null);
    const p = new URLSearchParams();
    if (periodo.inicio) p.set('inicio', periodo.inicio);
    if (periodo.fim) p.set('fim', periodo.fim);
    api.get(`/estoque-minimo/produtos/${produtoId}/grade?${p.toString()}`)
      .then((d) => { if (vivo) setDados(d); })
      .catch((e) => { if (vivo) setErro(e.message); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [produtoId, periodo.inicio, periodo.fim]);

  const mapa = useMemo(() => {
    const m = new Map();
    for (const c of dados?.celulas || []) m.set(`${c.cor}||${c.tamanho}`, c);
    return m;
  }, [dados]);

  if (carregando) return <Skeleton height={140} />;
  if (erro) return <p className="erro-inline">{erro}</p>;
  if (!dados || dados.celulas.length === 0) {
    return <p className="ink-soft" style={{ fontSize: 12 }}>Esta referência não tem variantes de cor e tamanho cadastradas.</p>;
  }

  const valorDe = (c) => (c ? (medida === 'saldo' ? c.saldo : c.pecas) : null);
  const totalCor = (cor) => dados.tamanhos.reduce((s, t) => s + (valorDe(mapa.get(`${cor}||${t}`)) || 0), 0);
  const totalTamanho = (tam) => dados.cores.reduce((s, c) => s + (valorDe(mapa.get(`${c}||${tam}`)) || 0), 0);
  const totalGeral = dados.cores.reduce((s, c) => s + totalCor(c), 0);

  // Texto colável no WhatsApp da facção. A grade é o pedido; copiar é o
  // caminho mais curto entre a tela e a ordem de produção de verdade.
  function copiarGrade() {
    const cab = ['Cor', ...dados.tamanhos, 'Total'].join('\t');
    const linhas = dados.cores.map((cor) => [
      cor,
      ...dados.tamanhos.map((t) => {
        const c = mapa.get(`${cor}||${t}`);
        return c ? numeroBr(valorDe(c), 0) : '—';
      }),
      numeroBr(totalCor(cor), 0),
    ].join('\t'));
    const rodape = ['Total', ...dados.tamanhos.map((t) => numeroBr(totalTamanho(t), 0)), numeroBr(totalGeral, 0)].join('\t');
    const texto = [`${referencia} — ${medida === 'saldo' ? 'saldo em estoque' : 'peças vendidas na janela'}`, cab, ...linhas, rodape].join('\n');
    navigator.clipboard?.writeText(texto).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    });
  }

  return (
    <div className="grade-bloco">
      <div className="grade-topo">
        <div className="segmentado segmentado-mini">
          <button type="button" className={medida === 'saldo' ? 'ativo' : ''} onClick={() => setMedida('saldo')}>
            Saldo em estoque
          </button>
          <button type="button" className={medida === 'venda' ? 'ativo' : ''} onClick={() => setMedida('venda')}>
            Vendeu na janela
          </button>
        </div>
        <button type="button" className="btn btn-ghost btn-mini" onClick={copiarGrade}>
          {copiado ? <><Check size={13} /> Copiado</> : <><Copy size={13} /> Copiar grade</>}
        </button>
      </div>

      <div className="grade-rolagem">
        <table className="tabela-grade">
          <thead>
            <tr>
              <th>Cor</th>
              {dados.tamanhos.map((t) => <th key={t} className="num">{t}</th>)}
              <th className="num total">Total / cor</th>
            </tr>
          </thead>
          <tbody>
            {dados.cores.map((cor) => (
              <tr key={cor}>
                <th scope="row">{cor}</th>
                {dados.tamanhos.map((t) => {
                  const c = mapa.get(`${cor}||${t}`);
                  // "—" não é erro: é a combinação que não existe no
                  // catálogo, e a planilha da casa já dizia isso assim.
                  if (!c) return <td key={t} className="num vazia" title="Esta combinação de cor e tamanho não existe no catálogo">—</td>;
                  const v = valorDe(c);
                  const zerada = medida === 'saldo' && v <= 0;
                  return (
                    <td
                      key={t}
                      className={'num' + (zerada ? ' celula-zerada' : '') + (v > 0 && medida === 'venda' ? ' celula-venda' : '')}
                      title={`${cor} ${t} — saldo ${numeroBr(c.saldo, 0)}, vendeu ${numeroBr(c.pecas, 0)} na janela`}
                    >
                      {numeroBr(v, 0)}
                    </td>
                  );
                })}
                <td className="num total">{numeroBr(totalCor(cor), 0)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total / tamanho</th>
              {dados.tamanhos.map((t) => <td key={t} className="num total">{numeroBr(totalTamanho(t), 0)}</td>)}
              <td className="num total geral">{numeroBr(totalGeral, 0)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {(dados.avisos || []).map((a) => (
        <p key={a} className="grade-aviso"><AlertTriangle size={12} /> {a}</p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// O painel que abre dentro da linha
// ---------------------------------------------------------------------------
function DetalheDaLinha({ linha, periodo, parametros, aoSalvarReposicao }) {
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);

  async function salvar(campos) {
    setSalvando(true);
    setErro(null);
    try {
      const { produto } = await api.put(`/estoque-minimo/produtos/${linha.produto_id}/reposicao`, campos);
      aoSalvarReposicao(linha.produto_id, produto);
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  const cad = linha.cadencia || {};
  const niveis = parametros?.niveis || {};

  return (
    <div className="linha-detalhe">
      <div className="detalhe-colunas">
        {/* 1. A decisão — fica primeiro porque é o que a pessoa veio fazer. */}
        <section className="detalhe-bloco">
          <h4><Sparkles size={14} /> Como esta referência é reposta</h4>
          <div className="detalhe-campos">
            <Field label="Cadência" hint="Decide o prazo usado no cálculo. A escolha à mão vence a sugerida pela venda.">
              <Select
                value={linha.cadencia_manual || ''}
                onChange={(e) => salvar({ cadencia: e.target.value || null })}
                disabled={salvando}
                placeholder="Sugerida pelo cálculo"
              >
                <option value="semanal">Semanal — 7 + 3 dias</option>
                <option value="quinzenal">Quinzenal — 15 + 5 dias</option>
                <option value="mensal">Mensal — 30 + 7 dias</option>
                <option value="sob_demanda">Sob demanda — só quando pedirem</option>
              </Select>
            </Field>
            <Field label="Nível" hint="O quanto a referência é estratégica. É por ele que a tela abre filtrada.">
              <Select
                value={linha.nivel_reposicao || ''}
                onChange={(e) => salvar({ nivel: e.target.value || null })}
                disabled={salvando}
                placeholder="Não classificada"
              >
                {Object.values(niveis).map((n) => (
                  <option key={n.chave} value={n.chave}>{n.rotulo}</option>
                ))}
              </Select>
            </Field>
            <Field label="Prazo próprio (dias)" hint="Só quando esta peça demora diferente das outras da mesma cadência. Em branco, vale o prazo da cadência.">
              <NumInput
                value={linha.lead_time_producao_dias ?? ''}
                onChange={(v) => salvar({ lead_time_dias: v === '' || v == null ? null : Number(v) })}
                step="1"
                suffix="dias"
                disabled={salvando}
              />
            </Field>
          </div>
          <p className="detalhe-nota">
            {cad.origem === 'manual'
              ? 'Cadência escolhida à mão. O recálculo não sobrescreve.'
              : (cad.explicacao || cad.motivo || '—')}
          </p>
          {erro && <p className="erro-inline">{erro}</p>}
        </section>

        {/* 2. A conta, por extenso. */}
        <section className="detalhe-bloco">
          <h4><HelpCircle size={14} /> Como cheguei nesse número</h4>
          <dl className="detalhe-lista">
            <div>
              <dt>Vende por dia</dt>
              <dd>
                {linha.venda_media_dia != null
                  ? `${numeroBr(linha.venda_media_dia, 2)} peça/dia — ${formatQtd(linha.pecas_vendidas)} peça(s) na janela${linha.pecas_vendidas_em_kit > 0 ? `, das quais ${formatQtd(linha.pecas_vendidas_em_kit)} saíram em kit` : ''}`
                  : 'sem venda medida na janela'}
              </dd>
            </div>
            <div>
              <dt>Prazo usado</dt>
              <dd>
                {linha.lead_time?.dias != null
                  ? `${linha.lead_time.dias} dias — ${linha.lead_time.origem === 'referencia' ? 'prazo próprio desta referência' : `padrão da cadência ${cad.rotulo || ''}`}`
                  : 'sem prazo definido'}
              </dd>
            </div>
            <div>
              <dt>Estoque mínimo</dt>
              <dd>
                {linha.estoque_seguranca?.valor != null
                  ? `${formatQtd(Math.ceil(linha.estoque_seguranca.valor))} peças — ${linha.estoque_seguranca.formula || 'colchão contra a variação'}`
                  : (linha.estoque_seguranca?.motivo || '—')}
              </dd>
            </div>
            <div>
              <dt>Ponto de pedido</dt>
              <dd>
                {linha.ponto_de_pedido?.valor != null
                  ? `${formatQtd(Math.ceil(linha.ponto_de_pedido.valor))} peças = ${formatQtd(Math.ceil(linha.ponto_de_pedido.consumoNoPrazo))} que vendem durante o prazo + ${formatQtd(Math.ceil(linha.ponto_de_pedido.estoqueSeguranca))} de colchão`
                  : (linha.ponto_de_pedido?.motivo || '—')}
              </dd>
            </div>
            <div>
              <dt>Quanto produzir</dt>
              <dd>
                {linha.produzir?.valor != null
                  ? (linha.produzir.naoPrecisaAinda
                    ? `nada agora — a posição (${formatQtd(linha.posicao)}) ainda está acima do ponto de pedido`
                    : `${formatQtd(linha.produzir.valor)} peças. Alvo do ciclo: ${formatQtd(linha.produzir.alvo)} peças (${linha.produzir.cicloDias} dias), menos a posição de ${formatQtd(linha.posicao)}`)
                  : (linha.produzir?.motivo || '—')}
              </dd>
            </div>
            <div>
              <dt>Posição de estoque</dt>
              <dd>
                {formatQtd(linha.saldo)} no galpão
                {linha.em_producao > 0 ? ` + ${formatQtd(linha.em_producao)} na facção` : ' (nada na facção)'}
              </dd>
            </div>
            <div>
              <dt>Comportamento</dt>
              <dd>
                {linha.comportamento?.politica?.rotulo || '—'}
                {linha.comportamento?.politica?.explicacao ? ` — ${linha.comportamento.politica.explicacao}` : ''}
              </dd>
            </div>
            <div>
              <dt>Curva e proteção</dt>
              <dd>
                {linha.curva?.classe
                  ? `classe ${linha.curva.classe} por ${linha.curva.criterio} — nível de serviço ${numeroBr(linha.nivel_servico * 100, 1)}% (Z = ${numeroBr(linha.z, 4)})`
                  : '—'}
              </dd>
            </div>
            {linha.censura_de_demanda && (
              <div>
                <dt>Ressalva</dt>
                <dd className="ressalva">
                  Ficou sem estoque em {linha.semanas_zeradas} semana(s) da janela. A venda medida é menor que a demanda real — este mínimo está otimista.
                </dd>
              </div>
            )}
          </dl>
        </section>
      </div>

      {/* 3. A grade — a resposta final, no formato do pedido. */}
      <section className="detalhe-bloco detalhe-grade">
        <h4><Grid3x3 size={14} /> Grade por cor e tamanho</h4>
        <GradeDaReferencia produtoId={linha.produto_id} periodo={periodo} referencia={linha.referencia} />
      </section>
    </div>
  );
}

export default function CoberturaEstoquePage() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);

  const [periodo, setPeriodo] = useState(periodoTresMeses);
  const [secao, setSecao] = useState('produzir_agora');
  const [aberta, setAberta] = useState(null);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [filtroNivel, setFiltroNivel] = useState('');
  const [filtroCadencia, setFiltroCadencia] = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState('');
  const [mostrarComoCalcula, setMostrarComoCalcula] = useState(false);
  const [mostrarPrazos, setMostrarPrazos] = useState(false);

  // Os prazos de cada cadência: vieram da planilha (7/15/30 + 3/5/7) e são
  // suposição. Suposição que manda no resultado fica à mão de quem sabe o
  // prazo real da facção, não escondida no código.
  const [prazos, setPrazos] = useState({
    semanal: { lt: 7, seg: 3 },
    quinzenal: { lt: 15, seg: 5 },
    mensal: { lt: 30, seg: 7 },
  });

  const carregar = useCallback(() => {
    setCarregando(true);
    setErro(null);
    const p = new URLSearchParams();
    if (periodo.inicio) p.set('inicio', periodo.inicio);
    if (periodo.fim) p.set('fim', periodo.fim);
    for (const [chave, v] of Object.entries(prazos)) {
      p.set(`lt_${chave}`, String(v.lt));
      p.set(`seg_${chave}`, String(v.seg));
    }
    api.get(`/estoque-minimo/produtos?${p.toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [periodo, prazos]);

  useEffect(() => { carregar(); }, [carregar]);

  // A escolha feita no painel volta para a linha sem recarregar a tela
  // inteira — mas os números dependem da cadência, então o recálculo é
  // pedido logo em seguida, e a tela diz que está recalculando.
  const aoSalvarReposicao = useCallback((produtoId, produto) => {
    setDados((d) => (d ? {
      ...d,
      linhas: d.linhas.map((l) => (l.produto_id === produtoId
        ? {
          ...l,
          nivel_reposicao: produto.nivel_reposicao,
          cadencia_manual: produto.cadencia_reposicao,
          lead_time_producao_dias: produto.lead_time_producao_dias,
        }
        : l)),
    } : d));
    carregar();
  }, [carregar]);

  const categorias = useMemo(() => (
    [...new Set((dados?.linhas || []).map((l) => l.categoria).filter(Boolean))].sort()
  ), [dados]);

  // Filtros que valem para TODAS as seções — os cartões do topo contam sobre
  // a lista já filtrada, senão o número do cartão não bate com a lista.
  const base = useMemo(() => {
    let linhas = dados?.linhas || [];
    if (buscaAplicada) {
      const t = buscaAplicada.toLowerCase();
      linhas = linhas.filter((l) => `${l.referencia} ${l.descricao || ''}`.toLowerCase().includes(t));
    }
    if (filtroNivel === 'principais') {
      linhas = linhas.filter((l) => l.nivel_reposicao === 'essencial' || l.nivel_reposicao === 'intermediario');
    } else if (filtroNivel) {
      linhas = linhas.filter((l) => l.nivel_reposicao === filtroNivel);
    }
    if (filtroCadencia) linhas = linhas.filter((l) => l.cadencia?.chave === filtroCadencia);
    if (filtroCategoria) linhas = linhas.filter((l) => l.categoria === filtroCategoria);
    return linhas;
  }, [dados, buscaAplicada, filtroNivel, filtroCadencia, filtroCategoria]);

  const porSecao = useMemo(() => {
    const mapa = Object.fromEntries(SECOES.map((s) => [s.chave, []]));
    for (const l of base) {
      const s = SECOES.find((x) => x.blocos.includes(l.bloco));
      if (s) mapa[s.chave].push(l);
    }
    return mapa;
  }, [base]);

  const resumo = useMemo(() => {
    const produzir = porSecao.produzir_agora || [];
    const programar = porSecao.programar || [];
    const parado = porSecao.sobrando || [];
    const soma = (lista, f) => lista.reduce((s, l) => s + (f(l) || 0), 0);
    return {
      faltando: produzir.filter((l) => l.saldo <= 0).length,
      receitaEmRisco: soma(produzir.filter((l) => l.saldo <= 0), (l) => l.faturamento),
      pecasSemana: soma(produzir, (l) => l.produzir?.valor),
      pecasMes: soma(programar, (l) => l.produzir?.valor),
      pecasParadas: soma(parado, (l) => l.excesso?.pecas),
      dinheiroParado: soma(parado, (l) => l.excesso?.valor),
      semValorDeParado: parado.some((l) => l.excesso?.pecas > 0 && l.excesso?.valor == null),
    };
  }, [porSecao]);

  const lista = porSecao[secao] || [];

  const colunas = useMemo(() => ({
    referencia: (l) => l.referencia,
    dinheiro: (l) => l.faturamento ?? 0,
    venda: (l) => l.venda_media_dia ?? -1,
    cobertura: (l) => l.cobertura?.dias ?? -1,
    saldo: (l) => l.saldo,
    ponto: (l) => l.ponto_de_pedido?.valor ?? -1,
    produzir: (l) => l.produzir?.valor ?? -1,
    prazo: (l) => (l.pedir_ate?.dias ?? 9999),
    parado: (l) => l.excesso?.valor ?? l.excesso?.pecas ?? -1,
  }), []);

  // Cada seção abre ordenada pelo que importa nela: o que produzir agora, por
  // dinheiro em risco; o que está parado, por dinheiro preso.
  const ordemPadrao = secao === 'sobrando' ? 'parado' : (secao === 'produzir_agora' ? 'dinheiro' : 'produzir');

  const tabela = useTabela(lista, {
    colunas, colunaPadrao: ordemPadrao, direcaoPadrao: 'desc', tamanhoPadrao: 25, prefixo: secao,
  });

  const chips = useMemo(() => {
    const itens = [];
    if (buscaAplicada) itens.push({ chave: 'busca', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } });
    if (filtroNivel) itens.push({ chave: 'nivel', rotulo: 'Nível', valor: filtroNivel === 'principais' ? 'Essenciais e intermediárias' : (dados?.parametros?.niveis?.[filtroNivel]?.rotulo || filtroNivel), onRemover: () => setFiltroNivel('') });
    if (filtroCadencia) itens.push({ chave: 'cad', rotulo: 'Cadência', valor: filtroCadencia, onRemover: () => setFiltroCadencia('') });
    if (filtroCategoria) itens.push({ chave: 'cat', rotulo: 'Categoria', valor: filtroCategoria, onRemover: () => setFiltroCategoria('') });
    return itens;
  }, [buscaAplicada, filtroNivel, filtroCadencia, filtroCategoria, dados]);

  const secaoAtual = SECOES.find((s) => s.chave === secao);

  const colunasExportar = useMemo(() => ([
    { chave: 'referencia', rotulo: 'Referência', valor: (l) => l.referencia },
    { chave: 'descricao', rotulo: 'Descrição', valor: (l) => l.descricao },
    { chave: 'categoria', rotulo: 'Categoria', valor: (l) => l.categoria },
    { chave: 'nivel', rotulo: 'Nível', valor: (l) => l.nivel?.rotulo || '' },
    { chave: 'cadencia', rotulo: 'Cadência', valor: (l) => l.cadencia?.rotulo || '' },
    { chave: 'venda_dia', rotulo: 'Venda/dia', valor: (l) => l.venda_media_dia },
    { chave: 'dura', rotulo: 'Dura (dias)', valor: (l) => l.cobertura?.dias },
    { chave: 'saldo', rotulo: 'Saldo', valor: (l) => l.saldo },
    { chave: 'em_producao', rotulo: 'Na facção', valor: (l) => l.em_producao },
    { chave: 'minimo', rotulo: 'Estoque mínimo', valor: (l) => l.estoque_seguranca?.valor },
    { chave: 'ponto', rotulo: 'Ponto de pedido', valor: (l) => l.ponto_de_pedido?.valor },
    { chave: 'produzir', rotulo: 'Produzir agora', valor: (l) => l.produzir?.valor },
    { chave: 'pedir_ate', rotulo: 'Pedir até', valor: (l) => l.pedir_ate?.data },
  ]), []);

  return (
    <div className="pagina pagina-cobertura">
      <header className="pagina-topo">
        <div>
          <h1><Timer size={22} /> Cobertura e Reposição</h1>
          <p className="ink-soft">
            O que produzir nesta semana, o que programar no mês e o que já está parado —
            por referência, e com a grade de cor e tamanho de cada uma.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={() => setMostrarPrazos((v) => !v)}>
            <Factory size={15} /> Prazos de produção
          </button>
          <button type="button" className="btn-sec" onClick={() => setMostrarComoCalcula((v) => !v)}>
            <HelpCircle size={15} /> Como isso é calculado
          </button>
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {/* A barra de comando: período, recorte e busca, tudo numa linha só. */}
      <div className="cobertura-barra">
        <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
        <span className="cobertura-janela" title="A venda é medida por semana, então as duas pontas do período são arredondadas para a semana inteira.">
          {dados?.parametros?.semanas ? `${dados.parametros.semanas} semanas cheias` : '—'}
        </span>
        <Select value={filtroNivel} onChange={(e) => setFiltroNivel(e.target.value)} placeholder="Todos os níveis">
          <option value="principais">Essenciais e intermediárias</option>
          {Object.values(dados?.parametros?.niveis || {}).map((n) => (
            <option key={n.chave} value={n.chave}>{n.rotulo}</option>
          ))}
        </Select>
        <Select value={filtroCadencia} onChange={(e) => setFiltroCadencia(e.target.value)} placeholder="Qualquer cadência">
          <option value="semanal">Semanal</option>
          <option value="quinzenal">Quinzenal</option>
          <option value="mensal">Mensal</option>
          <option value="sob_demanda">Sob demanda</option>
        </Select>
        <Select value={filtroCategoria} onChange={(e) => setFiltroCategoria(e.target.value)} placeholder="Todas as categorias">
          {categorias.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)} placeholder="Referência ou descrição" />
      </div>

      {chips.length > 0 && (
        <ChipsFiltros
          itens={chips}
          onLimparTudo={() => {
            setBusca(''); setBuscaAplicada(''); setFiltroNivel('');
            setFiltroCadencia(''); setFiltroCategoria('');
          }}
        />
      )}

      {mostrarPrazos && (
        <section className="card cobertura-prazos">
          <h3 className="card-titulo"><Factory size={16} /> Quanto tempo leva para repor</h3>
          <p className="ink-soft">
            Cada cadência tem o prazo dela. Estes valores vieram da planilha de estoque mínimo da casa
            e são <strong>suposição</strong> — o prazo real da facção manda no resultado mais do que
            qualquer outro número desta tela.
          </p>
          <div className="prazos-grade">
            {['semanal', 'quinzenal', 'mensal'].map((chave) => (
              <div key={chave} className="prazo-cartao">
                <span className={`selo ${CADENCIA_TOM[chave]}`}>{chave}</span>
                <Field label="Prazo de produção">
                  <NumInput
                    value={prazos[chave].lt}
                    onChange={(v) => setPrazos((p) => ({ ...p, [chave]: { ...p[chave], lt: Number(v) || 0 } }))}
                    step="1" suffix="dias"
                  />
                </Field>
                <Field label="Segurança">
                  <NumInput
                    value={prazos[chave].seg}
                    onChange={(v) => setPrazos((p) => ({ ...p, [chave]: { ...p[chave], seg: Number(v) || 0 } }))}
                    step="1" suffix="dias"
                  />
                </Field>
              </div>
            ))}
          </div>
        </section>
      )}

      {mostrarComoCalcula && (
        <section className="card cobertura-explicacao">
          <h3 className="card-titulo">Como cada número é calculado</h3>
          <div className="cobertura-explicacao-grade">
            <div>
              <h4>Cadência</h4>
              <p>
                É como a casa repõe: <strong>alto giro toda semana</strong>; o que vende menos, ou demora
                mais para produzir, no mês ou sob demanda. Ela decide o prazo usado no cálculo — 7, 15 ou
                30 dias — em vez de um prazo único para o catálogo inteiro. O cálculo sugere pela venda
                medida; a escolha feita à mão vence e não é sobrescrita.
              </p>
            </div>
            <div>
              <h4>Quanto produzir</h4>
              <p>
                Com reposição periódica, repor só até o mínimo faz o item furar antes da próxima rodada.
                O alvo cobre o ciclo inteiro: <strong>venda/dia × (prazo + segurança + intervalo até a
                próxima rodada)</strong>, menos a posição de estoque.
              </p>
            </div>
            <div>
              <h4>Posição de estoque</h4>
              <p>
                Saldo no galpão <strong>mais o que já está na facção</strong>. É com ela que o ponto de
                pedido se compara — senão o sistema manda produzir de novo o que está para chegar.
              </p>
            </div>
            <div>
              <h4>Pedir até</h4>
              <p>
                O estoque dura X dias e a peça leva Y para ficar pronta. A folga é a diferença, e quando
                ela é negativa <strong>o pedido já está atrasado</strong> — a tela usa essa palavra.
              </p>
            </div>
            <div>
              <h4>Grade por cor e tamanho</h4>
              <p>
                O número por referência esconde a grade: o P esgotado e o GG encalhado se cancelam dentro
                do mesmo saldo. A faixinha de cada linha mostra quantas variantes estão zeradas, e a linha
                abre na matriz cor × tamanho. <strong>Peça vendida dentro de kit não tem cor nem tamanho</strong> —
                ela conta no total da referência e fica de fora da grade, e a grade diz isso.
              </p>
            </div>
            <div>
              <h4>Estoque mínimo e ponto de pedido</h4>
              <p>
                São <strong>coisas diferentes</strong>. O mínimo é o colchão contra a variação; o ponto de
                pedido já inclui o que vai vender enquanto a peça fica pronta, e é ele que dispara a
                decisão. A proteção vem da curva: <strong>A 97,5%, B 95%, C 90%</strong>.
              </p>
            </div>
            <div>
              <h4>Quando o sistema não sabe</h4>
              <p>
                Item que vende raramente e em quantidade que pula muito não tem fórmula que sirva. Ele vai
                para <em>Sem cálculo possível</em> com o motivo escrito, em vez de receber um número
                plausível.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Os cartões são a navegação: cada um é um grupo de ação. */}
      <div className="cobertura-cartoes">
        {SECOES.map((s) => {
          const qtd = (porSecao[s.chave] || []).length;
          const destaque = {
            produzir_agora: resumo.pecasSemana > 0 ? `${formatQtd(resumo.pecasSemana)} peças` : null,
            programar: resumo.pecasMes > 0 ? `${formatQtd(resumo.pecasMes)} peças` : null,
            sobrando: resumo.dinheiroParado > 0 ? brl(resumo.dinheiroParado) : (resumo.pecasParadas > 0 ? `${formatQtd(resumo.pecasParadas)} peças` : null),
            ok: null,
            sem_calculo: null,
          }[s.chave];
          return (
            <button
              type="button"
              key={s.chave}
              className={'cartao-secao' + (secao === s.chave ? ' ativo' : '') + ` cartao-${s.tom}`}
              onClick={() => { setSecao(s.chave); setAberta(null); }}
            >
              <span className="cartao-topo">
                <s.Icone size={16} />
                <span className="cartao-rotulo">{s.rotulo}</span>
              </span>
              <span className="mono cartao-valor">{formatQtd(qtd)}</span>
              <span className="cartao-sub">
                {qtd === 1 ? 'referência' : 'referências'}
                {destaque ? ` · ${destaque}` : ''}
              </span>
            </button>
          );
        })}
      </div>

      {resumo.faltando > 0 && secao === 'produzir_agora' && (
        <p className="cobertura-alerta">
          <AlertTriangle size={14} />
          <span>
            <strong>{formatQtd(resumo.faltando)} referência(s) estão zeradas agora</strong> e venderam{' '}
            {brl(resumo.receitaEmRisco)} na janela. Enquanto estiverem assim, essa venda não está acontecendo.
          </span>
        </p>
      )}

      {(dados?.avisos || []).length > 0 && (
        <details className="cobertura-avisos-caixa">
          <summary><Info size={13} /> Ressalvas do método ({dados.avisos.length})</summary>
          <div className="cobertura-avisos">
            {dados.avisos.map((a) => <p key={a}>{a}</p>)}
          </div>
        </details>
      )}

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && <Skeleton height={360} />}

      {!carregando && (
        <section className="card cobertura-lista">
          <div className="cobertura-lista-topo">
            <div>
              <h3 className="card-titulo"><secaoAtual.Icone size={16} /> {secaoAtual.rotulo}</h3>
              <p className="ink-soft">{secaoAtual.descricao}</p>
            </div>
            <BotaoExportar
              nomeBase={`cobertura-${secao}`}
              colunas={colunasExportar}
              itens={lista}
              disabled={lista.length === 0}
            />
          </div>

          {lista.length === 0 ? (
            <EstadoVazio
              Icone={Package}
              titulo={`Nada em "${secaoAtual.rotulo}"`}
              descricao={
                base.length === 0
                  ? 'Os filtros escolhidos não deixaram nenhuma referência.'
                  : 'Neste recorte, nenhuma referência caiu neste grupo. Os outros cartões continuam com conteúdo.'
              }
            />
          ) : (
            <>
              <div className="tabela-rolagem">
                <table className="tabela-cobertura">
                  <thead>
                    <tr>
                      <th style={{ width: 26 }} />
                      <th>Referência</th>
                      <th>Grade</th>
                      <th className="num">Vende/dia</th>
                      <th className="num">Dura</th>
                      <th className="num">Tem</th>
                      <th className="num">Precisa</th>
                      <th className="num">{secao === 'sobrando' ? 'Sobrando' : 'Produzir'}</th>
                      <th>{secao === 'sobrando' ? 'Motivo' : 'Pedir até'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabela.itensPagina.map((l) => {
                      // Numa linha que está em "Parado e sobrando", o selo
                      // "Tranquilo" contaria a história oposta à da seção.
                      // Quem manda no rótulo é o bloco, que é o agrupamento
                      // que a pessoa escolheu ver.
                      const sit = l.bloco === 'sobrando'
                        ? { rotulo: 'Sobrando', tom: 'tone-elevada' }
                        : (l.bloco === 'parado'
                          ? { rotulo: 'Parado', tom: 'tone-neutro' }
                          : (SITUACAO[l.situacao] || SITUACAO.indeterminado));
                      const abertaAqui = aberta === l.produto_id;
                      return [
                        <tr
                          key={l.produto_id}
                          className={
                            (l.situacao === 'sem_estoque' || l.situacao === 'comprar_agora' ? 'linha-prejuizo' : '')
                            + (abertaAqui ? ' linha-aberta' : '')
                          }
                        >
                          <td>
                            <button
                              type="button"
                              className="btn-expandir"
                              aria-label={abertaAqui ? 'Fechar detalhe' : 'Abrir detalhe'}
                              onClick={() => setAberta(abertaAqui ? null : l.produto_id)}
                            >
                              {abertaAqui ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                          </td>
                          <td>
                            <div className="cobertura-ref">
                              <strong>{l.referencia}</strong>
                              <small>{l.descricao}</small>
                              <span className="cobertura-selos">
                                {l.nivel && <span className={`selo ${NIVEL_TOM[l.nivel.chave] || 'tone-neutro'}`}>{l.nivel.rotulo}</span>}
                                {l.cadencia?.chave && (
                                  <span
                                    className={`selo ${CADENCIA_TOM[l.cadencia.chave]}`}
                                    title={l.cadencia.origem === 'manual' ? 'Cadência escolhida à mão' : l.cadencia.explicacao}
                                  >
                                    {l.cadencia.rotulo}{l.cadencia.origem === 'manual' ? ' ·' : ''}
                                  </span>
                                )}
                                <span className={`selo ${sit.tom}`}>{sit.rotulo}</span>
                                {l.censura_de_demanda && (
                                  <span className="selo tone-atencao" title={`Ficou sem estoque em ${l.semanas_zeradas} semana(s) da janela — a venda medida é menor que a real.`}>
                                    ficou sem estoque
                                  </span>
                                )}
                              </span>
                            </div>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="grade-botao"
                              onClick={() => setAberta(abertaAqui ? null : l.produto_id)}
                            >
                              <FaixaDaGrade total={l.variantes} zeradas={l.variantes_zeradas} />
                            </button>
                          </td>
                          <td className="num">
                            <ValorOuMotivo valor={l.venda_media_dia} casas={2} titulo={`${formatQtd(l.pecas_vendidas)} peças na janela`} />
                          </td>
                          <td className="num">
                            {l.cobertura?.dias != null
                              ? (
                                <span className={`selo ${tomDaCobertura(l.cobertura.dias)}`} title={(l.cobertura.ressalvas || []).join(' ')}>
                                  {numeroBr(l.cobertura.dias, 0)} d
                                </span>
                              )
                              : <ValorOuMotivo valor={null} motivo={l.cobertura?.motivo} />}
                          </td>
                          <td className="num">
                            <span className="mono" title={l.em_producao > 0 ? `${formatQtd(l.saldo)} no galpão + ${formatQtd(l.em_producao)} na facção` : 'Saldo no galpão'}>
                              {formatQtd(l.saldo)}
                            </span>
                            {l.em_producao > 0 && (
                              <small className="ink-soft" style={{ display: 'block' }}>
                                +{formatQtd(l.em_producao)} na facção
                              </small>
                            )}
                          </td>
                          <td className="num">
                            <ValorOuMotivo
                              valor={l.ponto_de_pedido?.valor != null ? Math.ceil(l.ponto_de_pedido.valor) : null}
                              motivo={l.ponto_de_pedido?.motivo}
                              titulo="Ponto de pedido: o nível em que é preciso mandar produzir"
                            />
                          </td>
                          <td className="num">
                            {secao === 'sobrando'
                              ? (
                                <span className="mono" title={l.excesso?.motivo || 'Peças acima do que o ciclo pede'}>
                                  {l.excesso?.pecas != null ? formatQtd(l.excesso.pecas) : '—'}
                                  {l.excesso?.valor != null && (
                                    <small className="ink-soft" style={{ display: 'block' }}>{brl(l.excesso.valor)}</small>
                                  )}
                                </span>
                              )
                              : (
                                l.produzir?.valor != null && l.produzir.valor > 0
                                  ? <strong className="mono produzir-valor">{formatQtd(l.produzir.valor)}</strong>
                                  : (
                                    <ValorOuMotivo
                                      valor={null}
                                      motivo={
                                        // "Ainda não precisa" numa linha SEM ESTOQUE só faz
                                        // sentido se a tela disser o motivo: o que segura a
                                        // sugestão é a peça que já está na facção.
                                        l.produzir?.naoPrecisaAinda
                                          ? (l.em_producao > 0
                                            ? `já vem ${formatQtd(l.em_producao)} da facção`
                                            : 'ainda não precisa')
                                          : l.produzir?.motivo
                                      }
                                    />
                                  )
                              )}
                          </td>
                          <td>
                            {secao === 'sobrando'
                              ? (
                                <span className="ink-soft" style={{ fontSize: 11.5 }}>
                                  {l.bloco === 'parado' ? 'não vendeu na janela' : 'estoque acima do ciclo'}
                                </span>
                              )
                              : (l.pedir_ate?.dias != null
                                ? (
                                  <span className={`selo ${l.pedir_ate.atrasado ? 'tone-prejuizo' : (l.pedir_ate.dias <= 7 ? 'tone-atencao' : 'tone-neutro')}`} title={l.pedir_ate.explicacao}>
                                    {l.pedir_ate.atrasado
                                      ? `atrasado ${l.pedir_ate.diasFaltando} d`
                                      : dataBr(l.pedir_ate.data)}
                                  </span>
                                )
                                : <span className="ink-faint" style={{ fontSize: 11 }}>—</span>)}
                          </td>
                        </tr>,
                        abertaAqui && (
                          <tr key={`${l.produto_id}-detalhe`} className="linha-detalhe-tr">
                            <td colSpan={9}>
                              <DetalheDaLinha
                                linha={l}
                                periodo={periodo}
                                parametros={dados?.parametros}
                                aoSalvarReposicao={aoSalvarReposicao}
                              />
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
              <Paginacao
                pagina={tabela.pagina}
                totalPaginas={tabela.totalPaginas}
                tamanho={tabela.tamanho}
                totalItens={tabela.totalItens}
                inicio={tabela.inicio}
                fim={tabela.fim}
                setPagina={tabela.setPagina}
                setTamanho={tabela.setTamanho}
              />
            </>
          )}
        </section>
      )}

      {!carregando && dados && (
        <p className="cobertura-rodape">
          <Boxes size={13} />
          {formatQtd(dados.linhas.length)} referências com variante ativa ·{' '}
          {formatQtd(dados.parametros.pecasNaJanela)} peças vendidas na janela
          {dados.parametros.pecasEmKitNaJanela > 0 && ` (${formatQtd(dados.parametros.pecasEmKitNaJanela)} dentro de kit)`} ·
          janela de {dados.parametros.janela.inicio} a {dados.parametros.janela.fim}
        </p>
      )}
    </div>
  );
}
