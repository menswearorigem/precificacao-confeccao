import { useEffect, useMemo, useState } from 'react';
import { Scissors, Copy, Check, AlertTriangle, Minus, Plus, RotateCcw } from 'lucide-react';
import './GradeDeCorte.css';

/**
 * Grade de corte — a sugestão de corte como proporção de enfesto.
 *
 * Recebe o bloco `gradeCorte` da rota /api/analises-estoque/curva-tamanho. Não
 * calcula grade nenhuma: escolhe qual das grades já calculadas está
 * selecionada, seja uma das sugeridas, seja o tamanho digitado à mão — todas
 * saem do mesmo catálogo que o servidor mandou.
 */

const pct = (fracao) => `${(fracao * 100).toLocaleString('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})}%`;

const pp = (valor) => `${valor.toLocaleString('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})} p.p.`;

/** Entrada compacta do catálogo → o mesmo formato das grades sugeridas. */
function expandirDoCatalogo(entrada, modelo, loteAlvo) {
  const N = entrada.pecasPorGrade;
  const proporcao = modelo.map((p, i) => ({
    tamanho: p.tamanho,
    unidades: entrada.unidades[i],
    participacaoGrade: entrada.unidades[i] / N,
    participacaoReal: p.participacaoReal,
    esgotado: p.esgotado,
  }));
  const repeticoes = loteAlvo > 0 ? Math.max(1, Math.round(loteAlvo / N)) : null;
  const totalPecas = repeticoes === null ? null : repeticoes * N;
  return {
    pecasPorGrade: N,
    proporcao,
    rotulo: proporcao.filter((p) => p.unidades > 0).map((p) => p.unidades).join(' : '),
    erroMaximoPP: entrada.erroMaximoPP,
    equivaleA: entrada.equivaleA,
    repeticoes,
    totalPecas,
    diferencaParaLote: totalPecas === null ? null : totalPecas - loteAlvo,
    pecas: repeticoes === null
      ? null
      : proporcao.map((p) => ({ tamanho: p.tamanho, quantidade: p.unidades * repeticoes })),
  };
}

function textoParaFaccao(grade) {
  const naGrade = grade.proporcao.filter((p) => p.unidades > 0);
  const linhas = [
    `${naGrade.map((p) => `${p.tamanho} ${p.unidades}`).join(' · ')}   (grade de ${grade.pecasPorGrade})`,
  ];
  if (grade.repeticoes) {
    linhas.push(
      `${grade.repeticoes} grades = ${grade.totalPecas} peças:  `
      + naGrade.map((p) => `${p.tamanho} ${p.unidades * grade.repeticoes}`).join(' · '),
    );
  }
  return linhas.join('\n');
}

function BotaoCopiar({ grade }) {
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    if (!copiado) return undefined;
    const t = setTimeout(() => setCopiado(false), 2000);
    return () => clearTimeout(t);
  }, [copiado]);

  async function copiar() {
    const texto = textoParaFaccao(grade);
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      const area = document.createElement('textarea');
      area.value = texto;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopiado(true);
  }

  return (
    <button type="button" className="gc-copiar" onClick={copiar}>
      {copiado ? <Check size={15} /> : <Copy size={15} />}
      {copiado ? 'Copiado' : 'Copiar grade'}
    </button>
  );
}

export default function GradeDeCorte({ grade, loteAlvo }) {
  const [escolhida, setEscolhida] = useState(null);
  const [manual, setManual] = useState('');

  useEffect(() => { setEscolhida(null); setManual(''); }, [grade]);

  const opcoes = useMemo(() => {
    if (!grade?.aplicavel) return [];
    return [...(grade.alternativas || []), grade.recomendada];
  }, [grade]);

  const indiceRecomendada = opcoes.length - 1;
  const indice = escolhida === null ? indiceRecomendada : Math.min(escolhida, indiceRecomendada);

  const minimo = grade?.minimoPecasPorGrade ?? 1;
  const maximo = grade?.maximoPecasPorGrade ?? 100;

  // O campo manual sai do mesmo catálogo do servidor. Número fora da faixa não
  // vira grade aproximada: vira recusa com o motivo escrito.
  const { gradeManual, motivoManual } = useMemo(() => {
    if (!grade?.aplicavel || manual === '') return { gradeManual: null, motivoManual: null };
    const N = Number(manual);
    if (!Number.isFinite(N) || N <= 0) {
      return { gradeManual: null, motivoManual: 'informe quantas peças a grade tem' };
    }
    const entrada = (grade.catalogo || []).find((c) => c.pecasPorGrade === Math.round(N));
    if (!entrada) {
      return {
        gradeManual: null,
        motivoManual: Math.round(N) < minimo
          ? `uma grade de ${Math.round(N)} peça(s) não comporta esta curva sem zerar um tamanho — o mínimo aqui é ${minimo}`
          : `o máximo é ${maximo} peças por grade`,
      };
    }
    return {
      gradeManual: expandirDoCatalogo(entrada, grade.recomendada.proporcao, loteAlvo),
      motivoManual: null,
    };
  }, [grade, manual, loteAlvo, minimo, maximo]);

  if (!grade) return null;

  if (!grade.aplicavel) {
    return (
      <section className="gc-cartao gc-cartao--vazio">
        <h3 className="gc-titulo"><Scissors size={17} /> Grade de corte</h3>
        <p className="gc-motivo">{grade.motivoNaoAplicavel}</p>
        {grade.foraDaGrade?.length > 0 && (
          <ul className="gc-fora">
            {grade.foraDaGrade.map((f) => (
              <li key={f.tamanho}><strong>{f.tamanho}</strong> — {f.motivo}</li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  const atual = gradeManual || opcoes[indice];
  const naGrade = atual.proporcao.filter((p) => p.unidades > 0);
  const esgotados = naGrade.filter((p) => p.esgotado).map((p) => p.tamanho);

  function passo(delta) {
    const atualN = manual === '' ? atual.pecasPorGrade : Number(manual) || atual.pecasPorGrade;
    const alvo = Math.min(maximo, Math.max(minimo, Math.round(atualN) + delta));
    setManual(String(alvo));
  }

  return (
    <>
      <section className="gc-cartao">
        <h3 className="gc-titulo"><Scissors size={17} /> Grade de corte</h3>
        <p className="gc-legenda">
          Quantas vezes cada tamanho entra no risco. Repita a grade quantas vezes
          couber no enfesto.
        </p>

        <div className="gc-quadros">
          {naGrade.map((p) => (
            <div className="gc-quadro" key={p.tamanho}>
              <span className="gc-quadro-tamanho">{p.tamanho}</span>
              <span className="gc-quadro-unidades">{p.unidades}</span>
            </div>
          ))}
          <div className="gc-total">
            <strong>{atual.pecasPorGrade}</strong>
            <span>peças<br />por grade</span>
          </div>
        </div>

        <div className="gc-rodape">
          <span className="gc-erro">
            {atual.erroMaximoPP === 0
              ? 'Fecha exatamente a curva de venda.'
              : `Fiel à curva: erro máximo de ${pp(atual.erroMaximoPP)}`}
          </span>
          <BotaoCopiar grade={atual} />
        </div>

        {atual.equivaleA && (
          <p className="gc-nota-reducao">
            <AlertTriangle size={13} /> Esta grade é a de {atual.equivaleA} peças
            repetida {atual.pecasPorGrade / atual.equivaleA}×. Mesma proporção, o
            dobro do colchão — só vale a pena se o enfesto pedir.
          </p>
        )}

        {opcoes.length > 1 && (
          <div className="gc-alternativas">
            <span className="gc-alternativas-titulo">Grades mais curtas</span>
            <div className="gc-chips">
              {opcoes.map((op, i) => (
                <button
                  type="button"
                  key={op.pecasPorGrade}
                  className={`gc-chip${!gradeManual && i === indice ? ' gc-chip--ativo' : ''}`}
                  onClick={() => { setEscolhida(i); setManual(''); }}
                >
                  <span className="gc-chip-rotulo">{op.rotulo}</span>
                  <span className="gc-chip-detalhe">
                    {op.pecasPorGrade} peças · erro {pp(op.erroMaximoPP)}
                    {i === indiceRecomendada ? ' · recomendada' : ''}
                  </span>
                </button>
              ))}
            </div>
            <p className="gc-aviso-curta">
              Grade curta é mais fácil no enfesto e mais distante da curva real.
            </p>
          </div>
        )}

        <div className="gc-manual">
          <span className="gc-alternativas-titulo">Ou o tamanho que o seu enfesto pede</span>
          <div className="gc-manual-linha">
            <div className={`gc-campo${motivoManual ? ' gc-campo--recusado' : ''}`}>
              <button
                type="button"
                className="gc-campo-passo"
                onClick={() => passo(-1)}
                aria-label="Uma peça a menos por grade"
              >
                <Minus size={15} />
              </button>
              <input
                type="number"
                className="gc-campo-entrada"
                inputMode="numeric"
                min={minimo}
                max={maximo}
                placeholder={String(atual.pecasPorGrade)}
                value={manual}
                onChange={(e) => setManual(e.target.value)}
              />
              <button
                type="button"
                className="gc-campo-passo"
                onClick={() => passo(1)}
                aria-label="Uma peça a mais por grade"
              >
                <Plus size={15} />
              </button>
            </div>
            <span className="gc-manual-unidade">peças por grade</span>
            {gradeManual && (
              <button type="button" className="gc-voltar" onClick={() => setManual('')}>
                <RotateCcw size={13} /> voltar para a recomendada
              </button>
            )}
          </div>
          {motivoManual
            ? <p className="gc-manual-recusa">{motivoManual}</p>
            : <p className="gc-aviso-curta">De {minimo} a {maximo} peças. A proporção se ajusta ao número que você escolher.</p>}
        </div>

        {(grade.foraDaGrade?.length > 0 || esgotados.length > 0) && (
          <ul className="gc-fora">
            {grade.foraDaGrade?.map((f) => (
              <li key={f.tamanho}>
                <AlertTriangle size={13} /> <strong>{f.tamanho}</strong> não entra na grade — {f.motivo}
              </li>
            ))}
            {esgotados.length > 0 && (
              <li>
                <AlertTriangle size={13} /> {esgotados.join(', ')} esgotou no período — a
                participação está subestimada, e a grade também.
              </li>
            )}
          </ul>
        )}
      </section>

      {atual.repeticoes && (
        <section className="gc-cartao">
          <h4 className="gc-lote">
            Para um lote de <strong>{loteAlvo}</strong> peças:{' '}
            <strong>{atual.repeticoes} grades = {atual.totalPecas} peças</strong>
            {atual.diferencaParaLote !== 0 && (
              <span className="gc-diferenca">
                {' '}({Math.abs(atual.diferencaParaLote)}{' '}
                {atual.diferencaParaLote < 0 ? 'a menos' : 'a mais'})
              </span>
            )}
          </h4>

          <table className="gc-tabela">
            <thead>
              <tr>
                <th>Tamanho</th>
                <th>Grade</th>
                <th>× {atual.repeticoes} grades</th>
                <th>Participação</th>
                <th>Curva real</th>
              </tr>
            </thead>
            <tbody>
              {naGrade.map((p) => (
                <tr key={p.tamanho}>
                  <td className="gc-td-tamanho">{p.tamanho}</td>
                  <td>{p.unidades}</td>
                  <td><strong>{p.unidades * atual.repeticoes}</strong></td>
                  <td>{pct(p.participacaoGrade)}</td>
                  <td className="gc-td-fraca">{pct(p.participacaoReal)}</td>
                </tr>
              ))}
              <tr className="gc-tr-total">
                <td>Total</td>
                <td>{atual.pecasPorGrade}</td>
                <td><strong>{atual.totalPecas}</strong></td>
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
