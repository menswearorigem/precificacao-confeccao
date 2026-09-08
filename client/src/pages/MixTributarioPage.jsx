import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scale, CalendarClock, HelpCircle, RefreshCw, Building2, Users, Info,
  ShieldQuestion, FileWarning,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, IndicadorDestaque, Field, Toggle,
} from '../components/ui';
import { CartaoGrafico, GraficoColunas, useRefGrafico, corPorIndice } from '../components/graficos';
import { usePaletaGrafico } from '../lib/coresGrafico';
import { brl, pct, formatQtd } from '../lib/format';

// Análises › Mix B2B × B2C.
//
// Esta tela existe para responder UMA pergunta com prazo: quanto do
// faturamento de cada empresa vai para cliente que aproveita crédito de
// IBS/CBS (CNPJ) e quanto vai para consumidor final (CPF e marketplace).
// A janela de opção do Simples Nacional pelo regime regular vai de 1 a 30 de
// setembro de 2026, com efeito em 2027.
//
// O QUE ELA NÃO FAZ, DE PROPÓSITO: não recomenda regime tributário. Essa
// decisão é do contador, com o número na mão — não do software. A tela
// entrega o número, diz de que ele é feito, e para por aí.
//
// O que ela faz de diferente de um gráfico comum é mostrar o TAMANHO DA
// DÚVIDA. Cliente sem CPF nem CNPJ no cadastro não é empurrado para um dos
// lados: ele vira faixa. Quem lê vê "entre 31% e 44% de B2B" em vez de um
// número redondo que ninguém consegue defender numa reunião.

const MESES_ROTULO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function rotuloDoMes(mes) {
  const [ano, m] = String(mes).split('-').map(Number);
  if (!Number.isFinite(ano) || !Number.isFinite(m)) return mes;
  return `${MESES_ROTULO[m - 1]}/${String(ano).slice(2)}`;
}

// O documento aparece na tela mascarado, mas nunca inteiro: os quatro
// últimos bastam para a pessoa reconhecer o cliente, e o resto do número não
// precisa ficar exposto num painel que fica aberto na tela.
function documentoCurto(digitos) {
  if (!digitos) return null;
  const d = String(digitos);
  return `•••${d.slice(-4)}`;
}

function ConfiancaSelo({ confianca }) {
  const tom = {
    confirmada: 'tone-saudavel',
    declarada: 'tone-elevada',
    presumida: 'tone-atencao',
    nenhuma: 'tone-neutro',
  }[confianca] || 'tone-neutro';
  return <span className={`selo ${tom}`}>{confianca}</span>;
}

export default function MixTributarioPage() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);

  const [empresaId, setEmpresaId] = useState('');
  const [meses, setMeses] = useState(12);
  // O botão que mede a própria presunção: com ele ligado, marketplace deixa
  // de contar como consumidor final e vira "não classificado".
  const [soDocumentado, setSoDocumentado] = useState(false);
  const [mostrarComoClassifica, setMostrarComoClassifica] = useState(false);

  const paleta = usePaletaGrafico();
  const refGrafico = useRefGrafico();

  const carregar = useCallback(() => {
    setCarregando(true);
    setErro(null);
    const params = new URLSearchParams({ meses: String(meses) });
    if (empresaId) params.set('empresa_id', empresaId);
    api.get(`/mix-tributario?${params.toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [empresaId, meses]);

  useEffect(() => { carregar(); }, [carregar]);

  const agregado = soDocumentado ? dados?.somente_documentado : dados?.com_presuncao;

  const serie = useMemo(() => (agregado?.meses || []).map((m) => ({
    rotulo: rotuloDoMes(m.mes),
    b2b: m.b2b,
    b2c: m.b2c,
    indefinido: m.indefinido,
  })), [agregado]);

  const empresaSelecionada = useMemo(
    () => (dados?.empresas || []).find((e) => String(e.id) === String(empresaId)) || null,
    [dados, empresaId]
  );

  const criterios = useMemo(() => {
    const entradas = Object.entries(agregado?.porCriterio || {});
    return entradas.sort((a, b) => b[1].valor - a[1].valor);
  }, [agregado]);

  const prazo = dados?.prazo_opcao_simples;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Scale size={22} /> Mix B2B × B2C</h1>
          <p className="ink-soft">
            Quanto do faturamento vai para cliente que aproveita crédito de IBS/CBS (CNPJ) e quanto
            vai para consumidor final. É o número que embasa a conversa com o contador — não a decisão.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={() => setMostrarComoClassifica((v) => !v)}>
            <HelpCircle size={15} /> Como cada venda é classificada
          </button>
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {/* O prazo é um FATO com data, e por isso fica no alto. O que vem
          depois dele é escolha da dona com o contador — a tela não opina. */}
      {prazo?.dias_restantes != null && (
        <div className="mix-prazo">
          <CalendarClock size={18} />
          <div>
            <strong>
              Faltam {formatQtd(prazo.dias_restantes)} dia(s) para 30/09/2026
            </strong>
            <p>
              {prazo.fonte} Esta tela mede o mix; <strong>ela não recomenda regime tributário</strong> — essa
              decisão é do seu contador.
            </p>
          </div>
        </div>
      )}

      <section className="card mix-parametros">
        <Field label="Empresa" hint="A decisão do Simples é por CNPJ. Sem filtro, o número é o do grupo inteiro e não serve para a opção.">
          <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)} placeholder="Todas as empresas">
            {(dados?.empresas || []).map((e) => (
              <option key={e.id} value={e.id}>{e.nome} — {e.regime_tributario}</option>
            ))}
          </Select>
        </Field>
        <Field label="Janela" hint="Quantos meses de histórico entram na conta.">
          <Select value={String(meses)} onChange={(e) => setMeses(Number(e.target.value))}>
            <option value="6">6 meses</option>
            <option value="12">12 meses</option>
            <option value="24">24 meses</option>
          </Select>
        </Field>
        <Field
          label="Só o que está documentado"
          hint="Ligado, o marketplace deixa de contar como consumidor final e vira não classificado. É a maneira de ver o tamanho da presunção em vez de acreditar nela."
        >
          <div className="check-linha">
            <Toggle checked={soDocumentado} onChange={setSoDocumentado} />
            <span>{soDocumentado ? 'Presunção do canal desligada' : 'Marketplace contado como consumidor final'}</span>
          </div>
        </Field>
      </section>

      {mostrarComoClassifica && (
        <section className="card mix-explicacao">
          <h3 className="card-titulo"><ShieldQuestion size={16} /> Como cada venda é classificada</h3>
          <div className="mix-explicacao-grade">
            <div>
              <h4>Pelo documento</h4>
              <p>
                CNPJ no cadastro do cliente é <strong>B2B</strong>; CPF é <strong>B2C</strong>. Os dígitos
                verificadores são conferidos de verdade — não basta o tamanho do número.
              </p>
            </div>
            <div>
              <h4>Pelo canal</h4>
              <p>
                Pedido de marketplace conta como consumidor final, mas com confiança <strong>presumida</strong>:
                o marketplace não informa o documento do comprador. O botão acima desliga essa presunção.
              </p>
            </div>
            <div>
              <h4>Por que “PJ” vale e “PF” não</h4>
              <p>
                No cadastro, <strong>PF é o valor padrão da coluna</strong> — ninguém afirmou nada.
                <strong> PJ alguém digitou.</strong> Por isso PJ sem documento entra como B2B declarado, e
                PF sem documento <strong>não entra em lado nenhum</strong>.
              </p>
            </div>
            <div>
              <h4>Por que o resultado é uma faixa</h4>
              <p>
                O faturamento sem classificação não é dividido nem chutado. A tela mostra o mínimo (se todos
                fossem consumidor final) e o máximo (se todos fossem lojista). <strong>A faixa fecha sozinha
                conforme o cadastro é preenchido.</strong>
              </p>
            </div>
          </div>
        </section>
      )}

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && <Skeleton height={340} />}

      {!carregando && agregado && (
        <>
          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Faturamento no período"
              valor={brl(agregado.totais.total)}
              Icone={Building2}
              explicacao={empresaSelecionada ? `Só ${empresaSelecionada.nome}.` : 'Todas as empresas somadas.'}
            />
            <IndicadorDestaque
              rotulo="B2B — cliente com CNPJ"
              valor={agregado.participacao.b2b != null ? pct(agregado.participacao.b2b) : '—'}
              tom={agregado.participacao.b2b != null ? 'positivo' : undefined}
              explicacao={
                agregado.participacao.b2b != null
                  ? `${brl(agregado.totais.b2b)} sobre o faturamento classificado. É este lado que passa a se importar com o crédito da nota.`
                  : agregado.participacao.motivo
              }
            />
            <IndicadorDestaque
              rotulo="B2C — consumidor final"
              valor={agregado.participacao.b2c != null ? pct(agregado.participacao.b2c) : '—'}
              explicacao={agregado.participacao.b2c != null ? brl(agregado.totais.b2c) : agregado.participacao.motivo}
            />
            {agregado.faixa && agregado.faixa.amplitude > 0 && (
              <IndicadorDestaque
                rotulo="B2B na dúvida"
                valor={`${pct(agregado.faixa.minimo)} – ${pct(agregado.faixa.maximo)}`}
                tom="atencao"
                explicacao={`${brl(agregado.totais.indefinido)} sem documento no cadastro. A faixa é o quanto isso mexe na resposta.`}
              />
            )}
          </div>

          {(agregado.avisos || []).concat(dados.avisos || []).length > 0 && (
            <div className="mix-avisos">
              {Array.from(new Set((agregado.avisos || []).concat(dados.avisos || []))).map((a) => (
                <p key={a}><Info size={13} /> {a}</p>
              ))}
            </div>
          )}

          <CartaoGrafico
            titulo="Faturamento por mês, separado por lado"
            explicacao="Cada barra é um mês. A parte de cima é o faturamento que não deu para classificar — ela não foi distribuída entre os dois lados."
            refGrafico={refGrafico}
            altura={280}
            vazio={agregado.totais.total === 0 ? 'Nenhum faturamento no período escolhido.' : null}
            legenda={[
              { rotulo: 'B2B (CNPJ)', valor: brl(agregado.totais.b2b), cor: corPorIndice(paleta, 0) },
              { rotulo: 'B2C (consumidor final)', valor: brl(agregado.totais.b2c), cor: corPorIndice(paleta, 1) },
              { rotulo: 'Não classificado', valor: brl(agregado.totais.indefinido), cor: corPorIndice(paleta, 2) },
            ]}
          >
            <GraficoColunas
              dados={serie}
              series={[
                { chave: 'b2b', nome: 'B2B (CNPJ)' },
                { chave: 'b2c', nome: 'B2C (consumidor final)' },
                { chave: 'indefinido', nome: 'Não classificado' },
              ]}
              altura={280}
              empilhado
            />
          </CartaoGrafico>

          {agregado.variacao && (
            <p className="ajuda-bloco ink-soft">
              A participação de B2B saiu de <strong className="mono">{pct(agregado.variacao.primeiro)}</strong> em{' '}
              {rotuloDoMes(agregado.variacao.primeiroMes)} para <strong className="mono">{pct(agregado.variacao.ultimo)}</strong> em{' '}
              {rotuloDoMes(agregado.variacao.ultimoMes)}. São dois meses medidos e a diferença entre eles — não é projeção.
            </p>
          )}

          <section className="card">
            <h3 className="card-titulo"><FileWarning size={16} /> De onde veio cada real</h3>
            <p className="grafico-explicacao">
              O mesmo faturamento, separado pelo que o sistema realmente sabia na hora de classificar.
            </p>
            <div className="tabela-rolagem">
              <table className="tabela-mix-criterios">
                <thead>
                  <tr>
                    <th>Critério</th>
                    <th>Confiança</th>
                    <th className="num">Pedidos</th>
                    <th className="num">Faturamento</th>
                    <th>O que ele significa</th>
                  </tr>
                </thead>
                <tbody>
                  {criterios.map(([chave, c]) => (
                    <tr key={chave}>
                      <td><strong>{c.rotulo}</strong></td>
                      <td><ConfiancaSelo confianca={c.confianca} /></td>
                      <td className="num mono">
                        {formatQtd(c.pedidos)}
                        {c.semValor > 0 && <small className="ink-faint"> ({formatQtd(c.semValor)} sem total)</small>}
                      </td>
                      <td className="num mono">{brl(c.valor)}</td>
                      <td className="ink-soft">{c.explicacao}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {(dados.ranking_b2b || []).length > 0 && (
            <section className="card">
              <h3 className="card-titulo"><Users size={16} /> Os clientes do lado B2B</h3>
              <p className="grafico-explicacao">
                São estes que, a partir de 2027, passam a comparar o crédito que a sua nota dá com o de
                outro fornecedor. Do maior para o menor no período.
              </p>
              <div className="tabela-rolagem">
                <table className="tabela-mix-clientes">
                  <thead>
                    <tr>
                      <th>Cliente</th>
                      <th>Documento</th>
                      <th>Como foi classificado</th>
                      <th className="num">Pedidos</th>
                      <th className="num">Faturamento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.ranking_b2b.map((c) => (
                      <tr key={c.cliente_id ?? c.nome}>
                        <td>{c.nome}</td>
                        <td className="mono">{documentoCurto(c.documento) || <span className="ink-faint">sem documento</span>}</td>
                        <td>
                          <span className={`selo ${c.criterio === 'documento' ? 'tone-saudavel' : 'tone-elevada'}`}>
                            {dados.criterios?.[c.criterio]?.rotulo || c.criterio}
                          </span>
                        </td>
                        <td className="num mono">{formatQtd(c.pedidos)}</td>
                        <td className="num mono">{brl(c.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {!carregando && agregado && agregado.totais.pedidos.total === 0 && (
        <EstadoVazio
          Icone={Scale}
          titulo="Nenhum pedido no período"
          descricao="Aumente a janela ou tire o filtro de empresa. Pedido cancelado nunca entra nesta conta."
        />
      )}
    </div>
  );
}
