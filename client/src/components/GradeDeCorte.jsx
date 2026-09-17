import { useEffect, useMemo, useState } from 'react';
import { Scissors, Copy, Check, AlertTriangle } from 'lucide-react';
import './GradeDeCorte.css';

/**
 * Grade de corte — a sugestão de corte como proporção de enfesto.
 *
 * Recebe o bloco `gradeCorte` da rota /api/analises-estoque/curva-tamanho. Não
 * calcula grade nenhuma: só escolhe qual das grades já calculadas está
 * selecionada.
 */

const pct = (fracao) => `${(fracao * 100).toLocaleString('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})}%`;

const pp = (valor) => `${valor.toLocaleString('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})} p.p.`;

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

  const opcoes = useMemo(() => {
    if (!grade?.aplicavel) return [];
    return [...(grade.alternativas || []), grade.recomendada];
  }, [grade]);

  const indiceRecomendada = opcoes.length - 1;
  const indice = escolhida === null ? indiceRecomendada : Math.min(escolhida, indiceRecomendada);
  const atual = opcoes[indice];

  useEffect(() => { setEscolhida(null); }, [grade]);

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

  const naGrade = atual.proporcao.filter((p) => p.unidades > 0);
  const esgotados = naGrade.filter((p) => p.esgotado).map((p) => p.tamanho);

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

        {opcoes.length > 1 && (
          <div className="gc-alternativas">
            <span className="gc-alternativas-titulo">Grades mais curtas</span>
            <div className="gc-chips">
              {opcoes.map((op, i) => (
                <button
                  type="button"
                  key={op.pecasPorGrade}
                  className={`gc-chip${i === indice ? ' gc-chip--ativo' : ''}`}
                  onClick={() => setEscolhida(i)}
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
