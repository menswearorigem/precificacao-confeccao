import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Scale, TrendingUp, TrendingDown, Target, Layers, Info, AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, numeroBr, pct } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  BotaoExportar, EstadoVazio, IndicadorDestaque, Select, Field,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { CartaoGrafico, GraficoRosca, useRefGrafico } from '../components/graficos';

// DRE gerencial — o resultado do período, por competência.
//
// Não é contabilidade: é o plano GERENCIAL, que existe para responder três
// perguntas que a contabilidade responde tarde demais:
//
//   · quanto sobra de cada real vendido depois do custo que varia com a venda
//     (margem de contribuição);
//   · quanto a estrutura custa por mês, venda-se muito ou pouco (fixos);
//   · quanto precisa faturar para o resultado ser zero (ponto de equilíbrio).
//
// REGRA 2: quando o ponto de equilíbrio não existe, a tela ESCREVE que não
// existe. Um "0" ali seria uma mentira confortável — daria a entender que
// basta faturar nada para empatar.

const BASE = '/financeiro-nucleo';

function mensagemErro(err) {
  return err?.data?.error || err?.message || 'Não consegui completar a ação.';
}

function isoDe(d) {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function inicioDoAno() {
  const d = new Date();
  return `${d.getFullYear()}-01-01`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Bloco', valor: (l) => l.bloco },
  { rotulo: 'Grupo', valor: (l) => l.grupo },
  { rotulo: 'Código', valor: (l) => l.codigo },
  { rotulo: 'Categoria', valor: (l) => l.plano_nome },
  { rotulo: 'Valor', valor: (l) => brl(l.valor) },
  { rotulo: 'Sobre a receita', valor: (l) => (l.baseReceita > 0 ? pct(num(l.valor) / l.baseReceita) : '—') },
];

// Uma linha do DRE: código + nome à esquerda, valor e peso sobre a receita à
// direita. O peso só existe quando há receita — sem denominador, o percentual
// não é zero, é indefinido.
function LinhaDre({ codigo, nome, valor, receita }) {
  return (
    <tr>
      <td>
        <span className="cel-dupla">
          <strong>{codigo ? `${codigo} · ${nome}` : nome}</strong>
          {!codigo && <small>categoria sem código no plano</small>}
        </span>
      </td>
      <td className="mono">{brl(valor)}</td>
      <td className="mono">{receita > 0 ? pct(num(valor) / receita) : '—'}</td>
    </tr>
  );
}

export default function DrePage() {
  const [periodo, setPeriodo] = useState({ inicio: inicioDoAno(), fim: isoDe(new Date()) });
  const [empresaId, setEmpresaId] = useState('');
  const [empresas, setEmpresas] = useState([]);
  const [plano, setPlano] = useState([]);

  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  const refComposicao = useRefGrafico();

  useEffect(() => {
    api.get('/empresas').then((r) => setEmpresas(Array.isArray(r) ? r : [])).catch(() => setEmpresas([]));
    api.get(`${BASE}/plano?todas=true`).then((r) => setPlano(Array.isArray(r) ? r : [])).catch(() => setPlano([]));
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (periodo.inicio) p.set('de', periodo.inicio);
    if (periodo.fim) p.set('ate', periodo.fim);
    if (empresaId) p.set('empresa_id', empresaId);
    return p;
  }, [periodo, empresaId]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`${BASE}/dre?${params.toString()}`)
      .then(setDados)
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params]);

  const nomePorCodigo = useMemo(() => (
    Object.fromEntries(plano.map((p) => [p.codigo, p.nome]))
  ), [plano]);

  const resumo = dados?.resumo;
  const receita = num(resumo?.receita);

  // Agrupa as categorias analíticas pelo código-raiz ('2.3' -> grupo '2'), que
  // é exatamente como o plano foi desenhado para ser lido no DRE — sem recursão
  // e sem depender de o pai ter sido preenchido.
  const agrupar = useMemo(() => (filtro) => {
    const mapa = new Map();
    for (const l of (dados?.linhas || [])) {
      if (!filtro(l)) continue;
      const raiz = String(l.codigo || '').split('.')[0];
      const grupo = mapa.get(raiz) || {
        raiz,
        nome: nomePorCodigo[raiz] || (raiz ? `Grupo ${raiz}` : 'Sem grupo'),
        total: 0,
        itens: [],
      };
      grupo.itens.push(l);
      grupo.total += num(l.valor);
      mapa.set(raiz, grupo);
    }
    return [...mapa.values()].sort((a, b) => a.raiz.localeCompare(b.raiz, 'pt-BR', { numeric: true }));
  }, [dados, nomePorCodigo]);

  const gruposReceita = useMemo(() => agrupar((l) => l.natureza === 'receita'), [agrupar]);
  const gruposVariaveis = useMemo(() => agrupar((l) => l.natureza === 'despesa' && l.variavel), [agrupar]);
  const gruposFixas = useMemo(() => agrupar((l) => l.natureza === 'despesa' && !l.variavel), [agrupar]);

  const itensExportacao = useMemo(() => {
    const blocos = [
      ['Receita', gruposReceita],
      ['Custos e despesas variáveis', gruposVariaveis],
      ['Despesas fixas', gruposFixas],
    ];
    const saida = [];
    for (const [bloco, grupos] of blocos) {
      for (const g of grupos) {
        for (const item of g.itens) {
          saida.push({ ...item, bloco, grupo: g.nome, baseReceita: receita });
        }
      }
    }
    return saida;
  }, [gruposReceita, gruposVariaveis, gruposFixas, receita]);

  // Composição das saídas: variáveis e fixas por grupo, em módulo. A rosca não
  // sabe desenhar fatia negativa, e é por isso que o valor entra sem o sinal —
  // dito na explicação do gráfico, não escondido.
  const composicao = useMemo(() => (
    [...gruposVariaveis, ...gruposFixas]
      .map((g) => ({ rotulo: g.nome, valor: Math.abs(g.total) }))
      .filter((g) => g.valor > 0)
      .sort((a, b) => b.valor - a.valor)
  ), [gruposVariaveis, gruposFixas]);

  const margem = num(resumo?.margem_contribuicao);
  const margemFracao = resumo?.margem_contribuicao_fracao;
  const pontoEquilibrio = resumo?.ponto_equilibrio;
  const semLancamento = !loading && (dados?.linhas || []).length === 0;

  // O DRE é por competência MENSAL: a view agrupa cada título no dia 1º do mês
  // dele. Um período que começa no meio do mês deixa o mês inteiro de fora, e
  // isso precisa estar escrito — senão parece que o faturamento sumiu.
  const comecaNoMeioDoMes = Boolean(periodo.inicio) && !periodo.inicio.endsWith('-01');

  const empresaNome = empresas.find((e) => String(e.id) === String(empresaId))?.nome;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>DRE gerencial</h2>
          <p className="page-sub">
            O resultado do período por <strong>competência</strong> — quando o fato aconteceu, não quando o
            dinheiro andou. Só título firme entra: previsão e cancelado ficam de fora, e transferência entre
            contas próprias nunca entra (mover dinheiro de bolso não é receita nem despesa).
          </p>
        </div>
      </div>

      <div className="filtros-barra no-print">
        <PeriodoFiltro
          inicio={periodo.inicio}
          fim={periodo.fim}
          onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })}
        />
        <Field label="Empresa">
          <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
            <option value="">Todas as empresas</option>
            {empresas.map((e) => <option key={e.id} value={String(e.id)}>{e.nome}</option>)}
          </Select>
        </Field>
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase="dre-gerencial"
            colunas={COLUNAS_EXPORTACAO}
            itens={itensExportacao}
            disabled={itensExportacao.length === 0}
          />
        </div>
      </div>

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      {comecaNoMeioDoMes && (
        <div className="aviso-compacto tone-atencao">
          <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          O DRE trabalha por <strong>mês de competência</strong> inteiro. Como o período começa em{' '}
          {dataBr(periodo.inicio)}, o mês de {dataBr(`${periodo.inicio.slice(0, 7)}-01`)} fica de fora
          inteiro — não é que o faturamento sumiu. Comece o período no dia 1º para ver o mês completo.
        </div>
      )}

      {resumo && (
        <>
          <div className="indicadores-faixa">
            <IndicadorDestaque
              destaque
              Icone={TrendingUp}
              rotulo="Receita"
              valor={receita === 0 ? '—' : brl(receita)}
              explicacao={receita === 0
                ? 'Nenhum título de receita com competência neste período. Não é zero de venda: é ausência de lançamento.'
                : `Soma do valor bruto dos títulos de receita com competência no período${empresaNome ? `, da ${empresaNome}` : ''}.`}
            />
            <IndicadorDestaque
              Icone={TrendingDown}
              rotulo="Custos e despesas variáveis"
              valor={num(resumo.custos_variaveis) === 0 ? '—' : brl(resumo.custos_variaveis)}
              explicacao="O que só existe porque houve venda: comissão de marketplace, frete, imposto sobre venda, matéria-prima, facção."
            />
            <IndicadorDestaque
              Icone={Scale}
              tom={margem > 0 ? 'positivo' : margem < 0 ? 'negativo' : undefined}
              rotulo="Margem de contribuição"
              valor={receita === 0 && margem === 0 ? '—' : brl(margem)}
              variacao={margemFracao === null || margemFracao === undefined
                ? 'sem receita, não há percentual'
                : `${numeroBr(margemFracao * 100, 1)}% da receita`}
              explicacao="Quanto sobra de cada real vendido depois do custo que varia com a venda. É desta sobra que saem os fixos — e só o que passar dela vira lucro."
            />
            <IndicadorDestaque
              Icone={Layers}
              rotulo="Despesas fixas"
              valor={num(resumo.despesas_fixas) === 0 ? '—' : brl(resumo.despesas_fixas)}
              explicacao="O que a estrutura custa venda-se muito ou pouco: aluguel, salário, contador, software, tarifa."
            />
            <IndicadorDestaque
              Icone={Scale}
              tom={num(resumo.resultado) > 0 ? 'positivo' : num(resumo.resultado) < 0 ? 'negativo' : undefined}
              rotulo="Resultado do período"
              valor={semLancamento ? '—' : brl(resumo.resultado)}
              explicacao="Margem de contribuição menos despesas fixas. É o que sobrou (ou faltou) no período, por competência."
            />
            <IndicadorDestaque
              Icone={Target}
              tom={pontoEquilibrio === null || pontoEquilibrio === undefined ? 'negativo' : undefined}
              rotulo="Ponto de equilíbrio"
              valor={pontoEquilibrio === null || pontoEquilibrio === undefined ? '—' : brl(pontoEquilibrio)}
              explicacao={pontoEquilibrio === null || pontoEquilibrio === undefined
                ? 'Não existe faturamento que cubra os custos fixos com a margem atual: enquanto cada real vendido não deixar sobra, vender mais só aumenta o prejuízo. O caminho é preço, custo variável ou mix — não volume.'
                : 'Quanto precisa faturar, no mesmo mix de produtos deste período, para o resultado ser exatamente zero. Acima disso, cada real vendido vira lucro na proporção da margem.'}
            />
          </div>

          {(pontoEquilibrio === null || pontoEquilibrio === undefined) && !semLancamento && (
            <div className="aviso-compacto tone-prejuizo">
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
              <strong>Não existe ponto de equilíbrio neste período.</strong>{' '}
              {receita <= 0
                ? 'Sem receita lançada não há margem para calcular: o ponto de equilíbrio precisa saber quanto sobra de cada real vendido.'
                : 'A margem de contribuição está zerada ou negativa — cada real vendido não deixa sobra nenhuma para pagar os fixos. Nenhum volume de venda resolve isso; o que resolve é preço, custo variável ou mix.'}
            </div>
          )}

          <div className="nota-precisao">
            <Info size={14} />
            <span>
              A separação entre <strong>variável</strong> e <strong>fixo</strong> vem da marcação de cada
              categoria no plano financeiro — é ela que sustenta a margem de contribuição e o ponto de
              equilíbrio. Categoria marcada errada muda os dois números sem mudar nenhum lançamento.
            </span>
          </div>
        </>
      )}

      <CartaoGrafico
        titulo="Para onde a receita foi"
        explicacao="A divisão dos custos e despesas do período por grupo do plano financeiro. Os valores entram sem o sinal, porque uma rosca não sabe desenhar fatia negativa — todos eles são saída. O número no meio é o total de saídas do período."
        refGrafico={refComposicao}
        altura={260}
        vazio={composicao.length === 0
          ? 'Nenhum custo ou despesa com competência neste período — não há composição a mostrar.'
          : null}
      >
        <GraficoRosca dados={composicao} altura={260} totalRotulo="Custos + despesas" />
      </CartaoGrafico>

      {!dados && (
        <div className="card">
          <p className="page-sub" style={{ margin: 0 }}>
            {loading ? 'Montando o resultado do período…' : 'Nada carregado ainda.'}
          </p>
        </div>
      )}

      {dados && (
      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">
            Demonstração do resultado
            {dados?.periodo && <> · {dataBr(String(dados.periodo.de).slice(0, 10))} a {dataBr(String(dados.periodo.ate).slice(0, 10))}</>}
          </div>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Cada linha é uma categoria do plano financeiro, com o código na frente; a coluna da direita é o
          peso daquela linha sobre a receita do período. Sem receita, o peso aparece como “—”: não é 0%, é
          uma conta sem denominador.
        </p>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Categoria</th>
                <th>Valor no período</th>
                <th>Sobre a receita</th>
              </tr>
            </thead>
            <tbody>
              {gruposReceita.map((g) => (
                <Fragment key={`g-rec-${g.raiz}`}>
                  <tr className="linha-total">
                    <td><strong>{g.raiz} · {g.nome}</strong></td>
                    <td className="mono">{brl(g.total)}</td>
                    <td className="mono">{receita > 0 ? pct(g.total / receita) : '—'}</td>
                  </tr>
                  {g.itens.map((l) => (
                    <LinhaDre key={`rec-${l.codigo}`} codigo={l.codigo} nome={l.plano_nome} valor={l.valor} receita={receita} />
                  ))}
                </Fragment>
              ))}
              {gruposReceita.length === 0 && (
                <tr><td colSpan="3">Nenhuma receita com competência no período.</td></tr>
              )}

              <tr className="linha-total">
                <td><strong>= RECEITA TOTAL</strong></td>
                <td className="mono">{receita === 0 ? '—' : brl(receita)}</td>
                <td className="mono">{receita > 0 ? '100,0%' : '—'}</td>
              </tr>

              {gruposVariaveis.map((g) => (
                <Fragment key={`g-var-${g.raiz}`}>
                  <tr className="linha-total">
                    <td><strong>{g.raiz} · {g.nome}</strong></td>
                    <td className="mono">{brl(g.total)}</td>
                    <td className="mono">{receita > 0 ? pct(g.total / receita) : '—'}</td>
                  </tr>
                  {g.itens.map((l) => (
                    <LinhaDre key={`var-${l.codigo}`} codigo={l.codigo} nome={l.plano_nome} valor={l.valor} receita={receita} />
                  ))}
                </Fragment>
              ))}
              {gruposVariaveis.length === 0 && (
                <tr><td colSpan="3">Nenhum custo variável com competência no período.</td></tr>
              )}

              <tr className="linha-total">
                <td><strong>= MARGEM DE CONTRIBUIÇÃO</strong></td>
                <td className="mono">{receita === 0 && margem === 0 ? '—' : brl(margem)}</td>
                <td className="mono">
                  {margemFracao === null || margemFracao === undefined ? '—' : pct(margemFracao)}
                </td>
              </tr>

              {gruposFixas.map((g) => (
                <Fragment key={`g-fix-${g.raiz}`}>
                  <tr className="linha-total">
                    <td><strong>{g.raiz} · {g.nome}</strong></td>
                    <td className="mono">{brl(g.total)}</td>
                    <td className="mono">{receita > 0 ? pct(g.total / receita) : '—'}</td>
                  </tr>
                  {g.itens.map((l) => (
                    <LinhaDre key={`fix-${l.codigo}`} codigo={l.codigo} nome={l.plano_nome} valor={l.valor} receita={receita} />
                  ))}
                </Fragment>
              ))}
              {gruposFixas.length === 0 && (
                <tr><td colSpan="3">Nenhuma despesa fixa com competência no período.</td></tr>
              )}

              <tr className="linha-total">
                <td><strong>= RESULTADO DO PERÍODO</strong></td>
                <td className="mono">{semLancamento ? '—' : brl(resumo?.resultado)}</td>
                <td className="mono">{receita > 0 ? pct(num(resumo?.resultado) / receita) : '—'}</td>
              </tr>
              <tr className="linha-total">
                <td><strong>Ponto de equilíbrio</strong></td>
                <td className="mono">
                  {pontoEquilibrio === null || pontoEquilibrio === undefined ? '—' : brl(pontoEquilibrio)}
                </td>
                <td>
                  {pontoEquilibrio === null || pontoEquilibrio === undefined
                    ? 'não existe faturamento que cubra os fixos com a margem atual'
                    : 'faturamento que zera o resultado, no mesmo mix'}
                </td>
              </tr>
            </tbody>
          </table>
        </DataTable>
        {semLancamento && (
          <EstadoVazio
            Icone={Scale}
            titulo="Nenhum lançamento com competência neste período"
            descricao="O DRE só enxerga título firme com categoria do plano financeiro preenchida. Título sem categoria não aparece aqui — nem como zero, nem como linha vazia: ele simplesmente não tem lugar no resultado."
          />
        )}
      </div>
      )}
    </div>
  );
}
