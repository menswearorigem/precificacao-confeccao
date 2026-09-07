import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Timer, AlertTriangle, TrendingDown, Package, RefreshCw, Info, Boxes,
  CircleSlash, ShoppingCart, Layers, Activity, HelpCircle,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, CampoBusca, ChipsFiltros, IndicadorDestaque,
  Paginacao, NumInput, Field,
} from '../components/ui';
import { useTabela } from '../lib/useTabela';
import { brl, pct, formatQtd, numeroBr } from '../lib/format';

// Estoque › Cobertura e Estoque Mínimo.
//
// A pergunta que abre esta tela é a que a dona fez primeiro: "quanto tempo
// dura o estoque de cada referência?". A resposta completa exige três coisas
// que o Hub não tinha, e que agora estão aqui:
//
//   1. COBERTURA — saldo ÷ venda por dia. A conta é trivial; as armadilhas
//      não são, e por isso cada linha carrega as ressalvas dela.
//   2. COMPORTAMENTO — o método de cálculo do mínimo MUDA com o jeito que a
//      referência vende. Aplicar a fórmula estatística num item que vende de
//      vez em quando dá número errado nos dois sentidos.
//   3. ESTOQUE MÍNIMO e PONTO DE PEDIDO — que são coisas DIFERENTES, e a
//      tela nunca chama os dois de "mínimo".
//
// O que ela não faz de propósito: inventar número. Item sem histórico, item
// que ficou zerado, referência sem custo — os três aparecem com a causa
// escrita, nunca com um valor plausível.

const SITUACAO = {
  sem_estoque: { rotulo: 'Sem estoque', tom: 'tone-prejuizo', ordem: 0 },
  comprar_agora: { rotulo: 'Repor agora', tom: 'tone-prejuizo', ordem: 1 },
  atencao: { rotulo: 'Chegando no limite', tom: 'tone-atencao', ordem: 2 },
  indeterminado: { rotulo: 'Não dá para dizer', tom: 'tone-neutro', ordem: 3 },
  ok: { rotulo: 'Tranquilo', tom: 'tone-saudavel', ordem: 4 },
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

function SeloComportamento({ comportamento }) {
  const p = comportamento?.politica;
  if (!p) {
    return <span className="selo tone-neutro" title={comportamento?.motivo || undefined}>—</span>;
  }
  return (
    <span
      className={`selo ${p.confiavel ? 'tone-elevada' : 'tone-atencao'}`}
      title={p.explicacao}
    >
      {p.rotulo}
    </span>
  );
}

// O número com a explicação embaixo. Quando não há número, o MOTIVO ocupa o
// lugar dele — nunca um travessão mudo.
function ValorOuMotivo({ valor, motivo, sufixo, casas = 0, titulo }) {
  if (valor == null) {
    return (
      <span className="cobertura-sem-valor" title={motivo || titulo}>
        <CircleSlash size={11} /> {motivo ? motivo : '—'}
      </span>
    );
  }
  return (
    <span className="mono" title={titulo}>
      {numeroBr(valor, casas)}{sufixo ? ` ${sufixo}` : ''}
    </span>
  );
}

export default function CoberturaEstoquePage() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);

  // Os dois parâmetros que mudam TODO o resultado, e por isso ficam na tela e
  // não escondidos no código.
  const [leadTime, setLeadTime] = useState(21);
  const [janelaSemanas, setJanelaSemanas] = useState(26);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [filtroSituacao, setFiltroSituacao] = useState('');
  const [filtroComportamento, setFiltroComportamento] = useState('');
  const [filtroCurva, setFiltroCurva] = useState('');
  const [mostrarComoCalcula, setMostrarComoCalcula] = useState(false);

  const carregar = useCallback(() => {
    setCarregando(true);
    setErro(null);
    const params = new URLSearchParams({ semanas: String(janelaSemanas) });
    if (Number(leadTime) > 0) params.set('lead_time_dias', String(leadTime));
    api.get(`/estoque-minimo/produtos?${params.toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [leadTime, janelaSemanas]);

  useEffect(() => { carregar(); }, [carregar]);

  const filtradas = useMemo(() => {
    let linhas = dados?.linhas || [];
    if (buscaAplicada) {
      const t = buscaAplicada.toLowerCase();
      linhas = linhas.filter((l) => `${l.referencia} ${l.descricao || ''}`.toLowerCase().includes(t));
    }
    if (filtroSituacao) linhas = linhas.filter((l) => l.situacao === filtroSituacao);
    if (filtroComportamento) linhas = linhas.filter((l) => l.comportamento?.quadrante === filtroComportamento);
    if (filtroCurva) linhas = linhas.filter((l) => l.curva?.classe === filtroCurva);
    return linhas;
  }, [dados, buscaAplicada, filtroSituacao, filtroComportamento, filtroCurva]);

  const colunas = useMemo(() => ({
    referencia: (l) => l.referencia,
    cobertura: (l) => l.cobertura?.dias ?? null,
    saldo: (l) => l.saldo,
    venda: (l) => l.venda_media_dia ?? null,
    minimo: (l) => l.estoque_seguranca?.valor ?? null,
    ponto: (l) => l.ponto_de_pedido?.valor ?? null,
    situacao: (l) => SITUACAO[l.situacao]?.ordem ?? 9,
    curva: (l) => l.curva?.classe || 'Z',
  }), []);

  const tabela = useTabela(filtradas, {
    colunas, colunaPadrao: 'situacao', direcaoPadrao: 'asc', tamanhoPadrao: 50,
  });

  const totais = useMemo(() => {
    const l = dados?.linhas || [];
    return {
      referencias: l.length,
      semEstoque: l.filter((x) => x.situacao === 'sem_estoque').length,
      reporAgora: l.filter((x) => x.situacao === 'comprar_agora').length,
      indeterminado: l.filter((x) => x.situacao === 'indeterminado').length,
      censurados: l.filter((x) => x.censura_de_demanda).length,
      // Cobertura mediana em vez de média: uma referência com 3 anos de
      // estoque parado puxaria a média para cima e esconderia o resto.
      coberturaMediana: (() => {
        const dias = l.map((x) => x.cobertura?.dias).filter((d) => d != null).sort((a, b) => a - b);
        if (dias.length === 0) return null;
        const meio = Math.floor(dias.length / 2);
        return dias.length % 2 ? dias[meio] : (dias[meio - 1] + dias[meio]) / 2;
      })(),
    };
  }, [dados]);

  const chips = useMemo(() => {
    const itens = [];
    if (buscaAplicada) itens.push({ chave: 'busca', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } });
    if (filtroSituacao) itens.push({ chave: 'sit', rotulo: 'Situação', valor: SITUACAO[filtroSituacao]?.rotulo || filtroSituacao, onRemover: () => setFiltroSituacao('') });
    if (filtroComportamento) itens.push({ chave: 'comp', rotulo: 'Comportamento', valor: filtroComportamento, onRemover: () => setFiltroComportamento('') });
    if (filtroCurva) itens.push({ chave: 'curva', rotulo: 'Curva', valor: filtroCurva, onRemover: () => setFiltroCurva('') });
    return itens;
  }, [buscaAplicada, filtroSituacao, filtroComportamento, filtroCurva]);

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Timer size={22} /> Cobertura e Estoque Mínimo</h1>
          <p className="ink-soft">
            Quanto tempo dura o estoque de cada referência, e quanto ela precisa ter
            para não faltar — pelo método certo para o jeito que ela vende.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={() => setMostrarComoCalcula((v) => !v)}>
            <HelpCircle size={15} /> Como isso é calculado
          </button>
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {/* Os dois parâmetros que mudam tudo ficam à vista, não escondidos. */}
      <section className="card cobertura-parametros">
        <Field
          label="Prazo para repor uma peça (dias)"
          hint="Quanto tempo leva entre decidir produzir e a peça estar disponível para vender. Sem ele dá para ver a cobertura, mas não o mínimo nem o ponto de pedido."
        >
          <NumInput value={leadTime} onChange={setLeadTime} step="1" suffix="dias" />
        </Field>
        <Field
          label="Janela de análise"
          hint="Quantas semanas de histórico entram na conta. Menos de 24 semanas deixa o cálculo frágil; muito mais que isso mistura coleções diferentes."
        >
          <Select value={String(janelaSemanas)} onChange={(e) => setJanelaSemanas(Number(e.target.value))}>
            <option value="13">13 semanas (3 meses)</option>
            <option value="26">26 semanas (6 meses)</option>
            <option value="52">52 semanas (1 ano)</option>
          </Select>
        </Field>
      </section>

      {mostrarComoCalcula && (
        <section className="card cobertura-explicacao">
          <h3 className="card-titulo"><Activity size={16} /> Como cada número é calculado</h3>
          <div className="cobertura-explicacao-grade">
            <div>
              <h4>Cobertura</h4>
              <p>Saldo dividido pela venda média por dia. Diz quantos dias o estoque dura se a venda continuar no ritmo da janela escolhida.</p>
            </div>
            <div>
              <h4>Comportamento</h4>
              <p>
                O sistema mede duas coisas: de quanto em quanto tempo a referência vende, e o quanto a quantidade varia.
                Com isso ela cai em um de quatro grupos, e <strong>cada grupo tem um método de cálculo diferente</strong>.
                Usar a fórmula estatística num item que vende de vez em quando dá número errado nos dois sentidos.
              </p>
            </div>
            <div>
              <h4>Estoque mínimo</h4>
              <p>
                É o colchão contra a variação — o quanto sobra quando tudo dá certo.
                O tamanho dele depende do nível de proteção da curva:
                <strong> A 97,5%, B 95%, C 90%</strong>. O que mais vende ganha mais proteção; o que menos vende não prende dinheiro.
              </p>
            </div>
            <div>
              <h4>Ponto de pedido</h4>
              <p>
                É <strong>outra coisa</strong>: o nível em que você precisa mandar produzir, porque já inclui o que vai
                vender enquanto a peça fica pronta. É sempre maior que o mínimo, e é ele que dispara a decisão.
              </p>
            </div>
            <div>
              <h4>Raro e imprevisível</h4>
              <p>
                Quando a referência vende raramente e em quantidade que pula muito, <strong>nenhuma fórmula funciona</strong>.
                O sistema não inventa um número: ele diz que a decisão certa é produzir sob encomenda ou trabalhar com lote fixo.
              </p>
            </div>
            <div>
              <h4>Nível de proteção</h4>
              <p>
                Os 95% significam <em>a chance de não faltar em nenhum momento entre duas reposições</em>.
                O percentual de pedidos atendidos costuma ser maior que esse número — os dois não são a mesma medida.
              </p>
            </div>
          </div>
        </section>
      )}

      <div className="indicadores-linha">
        <IndicadorDestaque rotulo="Referências" valor={formatQtd(totais.referencias)} Icone={Boxes} />
        <IndicadorDestaque
          rotulo="Sem estoque"
          valor={formatQtd(totais.semEstoque)}
          tom={totais.semEstoque > 0 ? 'negativo' : undefined}
          explicacao="Saldo zerado. Se vendeu na janela, está deixando de vender agora."
        />
        <IndicadorDestaque
          rotulo="Precisa repor"
          valor={formatQtd(totais.reporAgora)}
          tom={totais.reporAgora > 0 ? 'atencao' : undefined}
          explicacao="O saldo já caiu abaixo do ponto de pedido."
        />
        <IndicadorDestaque
          rotulo="Cobertura mediana"
          valor={totais.coberturaMediana != null ? `${numeroBr(totais.coberturaMediana, 0)} dias` : '—'}
          explicacao="Metade das referências dura menos que isso. É mediana, e não média, porque uma peça encalhada distorceria a média."
        />
        {totais.indeterminado > 0 && (
          <IndicadorDestaque
            rotulo="Sem resposta"
            valor={formatQtd(totais.indeterminado)}
            explicacao="Faltou histórico ou prazo de reposição. O sistema prefere dizer que não sabe."
          />
        )}
      </div>

      {(dados?.avisos || []).length > 0 && (
        <div className="cobertura-avisos">
          {dados.avisos.map((a) => (
            <p key={a}><Info size={13} /> {a}</p>
          ))}
        </div>
      )}

      <div className="filtros-linha">
        <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)} placeholder="Referência ou descrição" />
        <Select value={filtroSituacao} onChange={(e) => setFiltroSituacao(e.target.value)} placeholder="Qualquer situação">
          {Object.entries(SITUACAO).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
        </Select>
        <Select value={filtroComportamento} onChange={(e) => setFiltroComportamento(e.target.value)} placeholder="Qualquer comportamento">
          <option value="smooth">Constante</option>
          <option value="erratic">Volume instável</option>
          <option value="intermittent">Vende de vez em quando</option>
          <option value="lumpy">Raro e imprevisível</option>
          <option value="sem_venda">Sem venda no período</option>
        </Select>
        <Select value={filtroCurva} onChange={(e) => setFiltroCurva(e.target.value)} placeholder="Qualquer curva">
          <option value="A">Curva A</option>
          <option value="B">Curva B</option>
          <option value="C">Curva C</option>
          <option value="negativo">Margem negativa</option>
        </Select>
      </div>

      {chips.length > 0 && (
        <ChipsFiltros
          itens={chips}
          onLimparTudo={() => {
            setBusca(''); setBuscaAplicada(''); setFiltroSituacao('');
            setFiltroComportamento(''); setFiltroCurva('');
          }}
        />
      )}

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && <Skeleton height={320} />}

      {!carregando && filtradas.length === 0 && (
        <EstadoVazio
          Icone={Package}
          titulo="Nenhuma referência nos filtros"
          descricao={dados?.linhas?.length ? 'Os filtros escolhidos não deixaram nada de fora do outro lado.' : 'Não há referência com variante de estoque ativa.'}
        />
      )}

      {!carregando && filtradas.length > 0 && (
        <>
          <div className="tabela-rolagem">
            <table className="tabela-cobertura">
              <thead>
                <tr>
                  <th>Referência</th>
                  <th>Comportamento</th>
                  <th className="num">Curva</th>
                  <th className="num">Saldo</th>
                  <th className="num">Venda/dia</th>
                  <th className="num">Dura</th>
                  <th className="num">Mínimo</th>
                  <th className="num">Repor em</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {tabela.itensPagina.map((l) => {
                  const sit = SITUACAO[l.situacao] || SITUACAO.indeterminado;
                  return (
                    <tr key={l.produto_id} className={l.situacao === 'sem_estoque' || l.situacao === 'comprar_agora' ? 'linha-prejuizo' : ''}>
                      <td>
                        <div className="cobertura-ref">
                          <strong>{l.referencia}</strong>
                          <small>{l.descricao}</small>
                          {l.censura_de_demanda && (
                            <span
                              className="selo tone-atencao"
                              title={`Esta referência ficou sem estoque em ${l.semanas_zeradas} semana(s) da janela. A venda medida é menor que a demanda real, então o mínimo abaixo está otimista.`}
                            >
                              ficou sem estoque
                            </span>
                          )}
                          {l.comportamento?.historicoSuficiente === false && (
                            <span
                              className="selo tone-neutro"
                              title={`O histórico tem ${l.comportamento.total} semanas, abaixo das ${l.comportamento.periodosMinimos} que dão uma média estável.`}
                            >
                              histórico curto
                            </span>
                          )}
                        </div>
                      </td>
                      <td><SeloComportamento comportamento={l.comportamento} /></td>
                      <td className="num">
                        {l.curva?.classe
                          ? <span className={`selo ${l.curva.classe === 'negativo' ? 'tone-prejuizo' : 'tone-neutro'}`}>{l.curva.classe}</span>
                          : '—'}
                      </td>
                      <td className="num mono">{formatQtd(l.saldo)}</td>
                      <td className="num">
                        <ValorOuMotivo valor={l.venda_media_dia} casas={2} titulo="Média por dia na janela escolhida" />
                      </td>
                      <td className="num">
                        {l.cobertura?.dias != null
                          ? (
                            <span className={`selo ${tomDaCobertura(l.cobertura.dias)}`} title={(l.cobertura.ressalvas || []).join(' ')}>
                              {numeroBr(l.cobertura.dias, 0)} dias
                            </span>
                          )
                          : <ValorOuMotivo valor={null} motivo={l.cobertura?.motivo} />}
                      </td>
                      <td className="num">
                        <ValorOuMotivo
                          valor={l.estoque_seguranca?.valor}
                          motivo={l.estoque_seguranca?.motivo}
                          casas={0}
                          titulo={l.estoque_seguranca?.explicacao || l.estoque_seguranca?.formula}
                        />
                      </td>
                      <td className="num">
                        <ValorOuMotivo
                          valor={l.ponto_de_pedido?.valor}
                          motivo={l.ponto_de_pedido?.motivo}
                          casas={0}
                          titulo={
                            l.ponto_de_pedido?.valor != null
                              ? `Consumo durante o prazo: ${numeroBr(l.ponto_de_pedido.consumoNoPrazo, 0)} + colchão de ${numeroBr(l.ponto_de_pedido.estoqueSeguranca, 0)}`
                              : undefined
                          }
                        />
                      </td>
                      <td><span className={`selo ${sit.tom}`}>{sit.rotulo}</span></td>
                    </tr>
                  );
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
    </div>
  );
}
