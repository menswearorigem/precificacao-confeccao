import { useEffect, useMemo, useState } from 'react';
import {
  Landmark, TrendingDown, ArrowDownCircle, ArrowUpCircle, AlertTriangle, Info,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  BotaoExportar, EstadoVazio, IndicadorDestaque, Field, Select, DateInput,
} from '../components/ui';
import {
  CartaoGrafico, GraficoLinha, GraficoColunas, useRefGrafico,
} from '../components/graficos';
import { usePaletaGrafico, corPorIndice } from '../lib/coresGrafico';

// Fluxo de caixa — previsto × realizado, dia a dia, e o saldo acumulado.
//
// A pergunta que esta tela existe para responder é uma só: QUANDO O CAIXA FICA
// NEGATIVO. Tudo o mais (as duas linhas, a tabela) está aqui para explicar por
// que a resposta é aquela.
//
// Duas decisões que mudam o número e por isso ficam escritas na própria tela:
//
//   · previsto e realizado NUNCA são somados. Previsto é título em aberto pela
//     data de vencimento; realizado é baixa pela data em que o dinheiro andou.
//     Somados, o mesmo título entraria duas vezes;
//   · o acumulado parte do SALDO ATUAL DAS CONTAS e soma só o previsto. O
//     realizado já está dentro desse saldo — somá-lo de novo contaria o mesmo
//     dinheiro duas vezes e adiantaria o dia do vermelho.

const BASE = '/financeiro-nucleo';

function mensagemErro(err) {
  return err?.data?.error || err?.message || 'Não consegui completar a ação.';
}

function dataIso(valor) {
  return valor ? String(valor).slice(0, 10) : '';
}

function isoDe(d) {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function hojeIso() {
  return isoDe(new Date());
}

function emDias(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDe(d);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Data', valor: (d) => dataBr(d.data) },
  { rotulo: 'Previsto a receber', valor: (d) => (d.prevEntrada ? brl(d.prevEntrada) : '—') },
  { rotulo: 'Previsto a pagar', valor: (d) => (d.prevSaida ? brl(d.prevSaida) : '—') },
  { rotulo: 'Previsto no dia', valor: (d) => (d.temPrevisto ? brl(d.previsto) : '—') },
  { rotulo: 'Realizado recebido', valor: (d) => (d.realEntrada ? brl(d.realEntrada) : '—') },
  { rotulo: 'Realizado pago', valor: (d) => (d.realSaida ? brl(d.realSaida) : '—') },
  { rotulo: 'Realizado no dia', valor: (d) => (d.temRealizado ? brl(d.realizado) : '—') },
  { rotulo: 'Saldo acumulado projetado', valor: (d) => brl(d.acumulado) },
];

export default function FluxoCaixaPage() {
  const paleta = usePaletaGrafico();
  const [de, setDe] = useState(hojeIso());
  const [ate, setAte] = useState(emDias(90));
  const [empresaId, setEmpresaId] = useState('');
  const [empresas, setEmpresas] = useState([]);

  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  const refMovimento = useRefGrafico();
  const refAcumulado = useRefGrafico();

  useEffect(() => {
    api.get('/empresas').then((r) => setEmpresas(Array.isArray(r) ? r : [])).catch(() => setEmpresas([]));
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (de) p.set('de', de);
    if (ate) p.set('ate', ate);
    if (empresaId) p.set('empresa_id', empresaId);
    return p;
  }, [de, ate, empresaId]);

  useEffect(() => {
    setLoading(true);
    setErro('');
    api.get(`${BASE}/fluxo-caixa?${params.toString()}`)
      .then(setDados)
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params]);

  const saldoInicial = num(dados?.saldo_inicial);

  // Um registro por dia COM movimento. Dia sem nada não entra: o acumulado só
  // muda quando dinheiro se move, e uma tabela com 90 linhas vazias esconde as
  // que importam.
  const dias = useMemo(() => {
    const mapa = new Map();
    for (const l of (dados?.linhas || [])) {
      const dia = dataIso(l.data);
      if (!dia) continue;
      const atual = mapa.get(dia) || {
        data: dia, prevEntrada: 0, prevSaida: 0, realEntrada: 0, realSaida: 0,
      };
      const valor = num(l.valor);
      if (l.visao === 'previsto') {
        if (l.natureza === 'receber') atual.prevEntrada += valor;
        else atual.prevSaida += valor;
      } else if (l.natureza === 'receber') {
        atual.realEntrada += valor;
      } else {
        atual.realSaida += valor;
      }
      mapa.set(dia, atual);
    }
    const lista = [...mapa.values()].sort((a, b) => (a.data < b.data ? -1 : 1));
    let acumulado = saldoInicial;
    return lista.map((d) => {
      const previsto = d.prevEntrada - d.prevSaida;
      const realizado = d.realEntrada - d.realSaida;
      acumulado += previsto;
      return {
        ...d,
        previsto,
        realizado,
        temPrevisto: d.prevEntrada !== 0 || d.prevSaida !== 0,
        temRealizado: d.realEntrada !== 0 || d.realSaida !== 0,
        acumulado,
        rotulo: dataBr(d.data),
      };
    });
  }, [dados, saldoInicial]);

  const resumo = useMemo(() => {
    const primeiroNegativo = dias.find((d) => d.acumulado < 0) || null;
    return {
      aReceber: dias.reduce((s, d) => s + d.prevEntrada, 0),
      aPagar: dias.reduce((s, d) => s + d.prevSaida, 0),
      recebido: dias.reduce((s, d) => s + d.realEntrada, 0),
      pago: dias.reduce((s, d) => s + d.realSaida, 0),
      final: dias.length > 0 ? dias[dias.length - 1].acumulado : saldoInicial,
      primeiroNegativo,
      diasNegativos: dias.filter((d) => d.acumulado < 0).length,
    };
  }, [dias, saldoInicial]);

  // O acumulado como colunas, e não como linha, por um motivo prático: coluna
  // aceita cor por barra, então o dia em que o caixa vira vermelho aparece
  // vermelho, sem precisar de legenda.
  const barrasAcumulado = useMemo(() => dias.map((d) => ({
    rotulo: d.rotulo,
    acumulado: d.acumulado,
    cor: d.acumulado < 0 ? paleta.negativo : paleta.positivo,
  })), [dias, paleta]);

  const empresaNome = empresas.find((e) => String(e.id) === String(empresaId))?.nome;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Fluxo de caixa</h2>
          <p className="page-sub">
            O que ainda vai entrar e sair (previsto, pela data de vencimento) ao lado do que já entrou e
            saiu (realizado, pela data em que o dinheiro andou). O saldo acumulado responde a única
            pergunta que importa aqui: <strong>até quando o caixa aguenta</strong>.
          </p>
        </div>
      </div>

      <div className="filtros-barra no-print">
        <Field label="De" hint="O fluxo costuma começar hoje.">
          <DateInput value={de} onChange={(e) => setDe(e.target.value)} />
        </Field>
        <Field label="Até" hint="Pode ser uma data futura — é uma projeção.">
          <DateInput value={ate} onChange={(e) => setAte(e.target.value)} />
        </Field>
        <Field label="Empresa">
          <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
            <option value="">Todas as empresas</option>
            {empresas.map((e) => <option key={e.id} value={String(e.id)}>{e.nome}</option>)}
          </Select>
        </Field>
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase="fluxo-de-caixa"
            colunas={COLUNAS_EXPORTACAO}
            itens={dias}
            disabled={dias.length === 0}
          />
        </div>
      </div>

      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="indicadores-faixa">
        <IndicadorDestaque
          destaque
          Icone={Landmark}
          rotulo="Saldo de onde a projeção parte"
          valor={brl(saldoInicial)}
          explicacao={`Saldo atual somado de todas as contas${empresaNome ? ` da ${empresaNome}` : ''}: saldo inicial de cada uma mais o extrato bancário já importado. É o ponto de partida da linha acumulada.`}
        />
        <IndicadorDestaque
          Icone={ArrowDownCircle}
          tom="positivo"
          rotulo="Previsto a receber"
          valor={resumo.aReceber === 0 ? '—' : brl(resumo.aReceber)}
          explicacao={resumo.aReceber === 0
            ? 'Nenhum título a receber vence dentro deste período.'
            : 'Soma do saldo em aberto dos títulos a receber que vencem no período. Não é o que já entrou.'}
        />
        <IndicadorDestaque
          Icone={ArrowUpCircle}
          tom="negativo"
          rotulo="Previsto a pagar"
          valor={resumo.aPagar === 0 ? '—' : brl(resumo.aPagar)}
          explicacao={resumo.aPagar === 0
            ? 'Nenhum título a pagar vence dentro deste período.'
            : 'Soma do saldo em aberto dos títulos a pagar que vencem no período. Não é o que já saiu.'}
        />
        <IndicadorDestaque
          Icone={TrendingDown}
          tom={resumo.final < 0 ? 'negativo' : undefined}
          rotulo="Saldo projetado no fim do período"
          valor={brl(resumo.final)}
          explicacao="O saldo de partida mais tudo que está previsto entrar e sair até o último dia do período."
        />
        <IndicadorDestaque
          Icone={AlertTriangle}
          tom={resumo.primeiroNegativo ? 'negativo' : undefined}
          rotulo="Quando o caixa fica negativo"
          valor={resumo.primeiroNegativo ? dataBr(resumo.primeiroNegativo.data) : '—'}
          explicacao={resumo.primeiroNegativo
            ? `Nesse dia o acumulado chega a ${brl(resumo.primeiroNegativo.acumulado)}. É a data-limite para antecipar recebimento, adiar pagamento ou buscar caixa.`
            : 'O acumulado não fica negativo em nenhum dia deste período — por isso não há data para mostrar. Não é zero: é ausência de dia negativo.'}
        />
      </div>

      <div className="nota-precisao">
        <Info size={14} />
        <span>
          <strong>Previsto</strong> e <strong>realizado</strong> nunca são somados: um é título em aberto
          pela data de vencimento, o outro é baixa pela data em que o dinheiro andou — somados, o mesmo
          título contaria duas vezes. O acumulado parte do saldo das contas e soma <em>só o previsto</em>,
          porque o realizado já está dentro desse saldo.
        </span>
      </div>

      <CartaoGrafico
        titulo="Previsto × realizado, dia a dia"
        explicacao="Cada ponto é o líquido do dia (o que entra menos o que sai). Acima de zero o dia sobra dinheiro; abaixo, consome. Só aparecem dias com movimento — dia sem nada não vira ponto, porque não houve queda a zero: não houve dia."
        refGrafico={refMovimento}
        altura={280}
        vazio={dias.length === 0
          ? 'Nenhum título vence e nenhuma baixa acontece neste período — não há o que projetar.'
          : null}
        rodape={`${formatQtd(dias.length)} dia(s) com movimento no período.`}
        legenda={[
          { rotulo: 'Previsto (títulos em aberto)', valor: brl(resumo.aReceber - resumo.aPagar), cor: corPorIndice(paleta, 0) },
          { rotulo: 'Realizado (baixas)', valor: brl(resumo.recebido - resumo.pago), cor: corPorIndice(paleta, 1) },
        ]}
      >
        <GraficoLinha
          dados={dias}
          series={[
            { chave: 'previsto', nome: 'Previsto no dia' },
            { chave: 'realizado', nome: 'Realizado no dia', tracejada: true },
          ]}
          altura={280}
        />
      </CartaoGrafico>

      <CartaoGrafico
        titulo="Saldo acumulado projetado"
        explicacao="A barra é o saldo que sobraria na conta ao fim de cada dia, partindo do saldo atual das contas e somando o previsto. Barra vermelha é dia em que o caixa está negativo — dinheiro que a empresa não tem."
        refGrafico={refAcumulado}
        altura={280}
        vazio={dias.length === 0
          ? 'Sem título vencendo no período, o acumulado seria uma linha reta no saldo atual — não há projeção a fazer.'
          : null}
        rodape={resumo.primeiroNegativo
          ? `O caixa fica negativo pela primeira vez em ${dataBr(resumo.primeiroNegativo.data)}, e passa ${formatQtd(resumo.diasNegativos)} dia(s) no vermelho dentro do período.`
          : 'Nenhuma barra vermelha: o acumulado não fica negativo em nenhum dia deste período.'}
      >
        <GraficoColunas
          dados={barrasAcumulado}
          series={[{ chave: 'acumulado', nome: 'Saldo acumulado' }]}
          altura={280}
          comZero
        />
      </CartaoGrafico>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Dia a dia</div>
          <span className="page-sub" style={{ margin: 0 }}>{formatQtd(dias.length)} dia(s) com movimento</span>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Um traço quer dizer que não houve nada daquele tipo no dia — não que o valor foi zero. A linha em
          vermelho é o primeiro dia em que o acumulado fica negativo.
        </p>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Data</th>
                <th>Previsto a receber</th>
                <th>Previsto a pagar</th>
                <th>Previsto no dia</th>
                <th>Recebido</th>
                <th>Pago</th>
                <th>Realizado no dia</th>
                <th>Saldo acumulado</th>
              </tr>
            </thead>
            <tbody>
              {dias.map((d) => {
                const ehPrimeiroNegativo = resumo.primeiroNegativo && d.data === resumo.primeiroNegativo.data;
                return (
                  <tr key={d.data}>
                    <td className="mono">{dataBr(d.data)}</td>
                    <td className="mono">{d.prevEntrada ? brl(d.prevEntrada) : '—'}</td>
                    <td className="mono">{d.prevSaida ? brl(d.prevSaida) : '—'}</td>
                    <td className="mono">{d.temPrevisto ? brl(d.previsto) : '—'}</td>
                    <td className="mono">{d.realEntrada ? brl(d.realEntrada) : '—'}</td>
                    <td className="mono">{d.realSaida ? brl(d.realSaida) : '—'}</td>
                    <td className="mono">{d.temRealizado ? brl(d.realizado) : '—'}</td>
                    <td>
                      {d.acumulado < 0 ? (
                        <span className={'stamp sm tone-prejuizo'} title={ehPrimeiroNegativo ? 'Primeiro dia em que o caixa fica negativo' : 'Caixa negativo neste dia'}>
                          {brl(d.acumulado)}{ehPrimeiroNegativo ? ' · primeiro dia negativo' : ''}
                        </span>
                      ) : (
                        <span className="mono">{brl(d.acumulado)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
        {!loading && dias.length === 0 && (
          <EstadoVazio
            Icone={Landmark}
            titulo="Nenhum movimento neste período"
            descricao="Nenhum título vence e nenhuma baixa acontece entre as datas escolhidas. Amplie o período, ou lance os títulos a pagar e a receber para que o fluxo tenha o que projetar."
          />
        )}
      </div>
    </div>
  );
}
