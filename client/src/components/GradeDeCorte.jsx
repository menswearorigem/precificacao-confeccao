import { useEffect, useMemo, useState } from 'react';
import { Scissors, Copy, Check, AlertTriangle, Minus, Plus, RotateCcw, Info, X } from 'lucide-react';
import './GradeDeCorte.css';

/**
 * Grade de corte — a sugestão de corte como proporção de enfesto.
 *
 * Recebe o bloco `gradeCorte` da rota /api/analises-estoque/curva-tamanho. Não
 * calcula grade nenhuma: escolhe qual das grades já calculadas está
 * selecionada, seja uma das sugeridas, seja o tamanho digitado à mão — todas
 * saem do mesmo catálogo que o servidor mandou.
 *
 * 17/09/2026 — a marcação passou a usar as peças do sistema (`.card`,
 * `.card-titulo`, `.tabela-nota`, `.selo`, `.btn`, `.ajuda-bloco`) em vez de
 * um visual próprio com cores e medidas fora dos tokens. Só apresentação: os
 * números, as regras e a rota continuam iguais.
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
    <button type="button" className="btn btn-ghost sm gc-copiar" onClick={copiar}>
      {copiado ? <Check size={14} /> : <Copy size={14} />}
      {copiado ? 'Copiado' : 'Copiar grade'}
    </button>
  );
}

/**
 * Os tamanhos da curva como chips de liga/desliga (23/09/2026). Cheio = entra
 * no corte; vazado e riscado = fora. Tamanho sem venda no período não tem o
 * que ligar: aparece apagado, com o motivo no título.
 */
function SeletorTamanhos({ tamanhos, excluidos, onAlternar, sugeridos = [] }) {
  if (!tamanhos?.length || !onAlternar) return null;
  const fora = new Set(excluidos.map((t) => t.toUpperCase()));
  const sug = new Set(sugeridos.map((t) => t.toUpperCase()));
  return (
    <div className="gc-tamanhos">
      <span className="field-label">Tamanhos no corte</span>
      <div className="gc-tamanhos-lista" role="group" aria-label="Tamanhos no corte">
        {tamanhos.map(({ tamanho, semVenda }) => {
          const tirado = fora.has(tamanho.toUpperCase());
          const sugerido = !tirado && sug.has(tamanho.toUpperCase());
          return (
            <button
              type="button"
              key={tamanho}
              className={`gc-tam${tirado ? ' fora' : ''}${sugerido ? ' sugerido' : ''}`}
              aria-pressed={!tirado && !semVenda}
              disabled={semVenda}
              title={semVenda
                ? 'Sem venda no período — já fica fora da grade'
                : tirado ? `Devolver o ${tamanho} ao corte` : `Tirar o ${tamanho} do corte`}
              onClick={() => onAlternar(tamanho)}
            >
              {tamanho}
              {!semVenda && (tirado ? <Plus size={12} /> : <X size={12} />)}
            </button>
          );
        })}
      </div>
      <p className="ink-faint gc-dica">
        Toque num tamanho para tirá-lo ou devolvê-lo. A proporção é refeita só
        entre os que ficam.
      </p>
    </div>
  );
}

export default function GradeDeCorte({
  grade, loteAlvo, abas = null, antes = null, tamanhos = [], excluidos = [],
  onAlternarTamanho = null, sugeridos = [], atualizando = false,
}) {
  const [escolhida, setEscolhida] = useState(null);
  const [manual, setManual] = useState('');

  // Ao tirar/devolver um tamanho a grade chega nova, mas o enfesto é o mesmo:
  // o número digitado à mão fica (e é recusado com motivo se não couber mais).
  useEffect(() => { setEscolhida(null); }, [grade]);

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

  // Os tirados à mão já aparecem nos chips; a lista de "fora da grade" fica
  // só com o que o cálculo tirou sozinho, que é o que precisa de explicação.
  const foraAutomatico = (grade.foraDaGrade || []).filter((f) => !f.manual);

  const seletor = (
    <SeletorTamanhos
      tamanhos={tamanhos}
      excluidos={excluidos}
      onAlternar={onAlternarTamanho}
      sugeridos={sugeridos}
    />
  );

  if (!grade.aplicavel) {
    return (
      <div className={`card gc-card${atualizando ? ' gc-atualizando' : ''}`}>
        <div className="card-head-linha gc-cabeca">
          <h2 className="card-titulo"><Scissors size={16} /> Grade de corte</h2>
          {abas}
        </div>
        {antes}
        {seletor}
        {grade.tamanhoUnico ? (
          <div className="gc-quadros">
            <div className="gc-quadro">
              <span className="gc-quadro-tamanho">{grade.tamanhoUnico}</span>
              <span className="gc-quadro-unidades">1</span>
            </div>
            <p className="ink-soft gc-unico">{grade.motivoNaoAplicavel}</p>
          </div>
        ) : (
          <p className="aviso-inline"><AlertTriangle size={14} /> {grade.motivoNaoAplicavel}</p>
        )}
        {foraAutomatico.length > 0 && (
          <ul className="gc-fora">
            {foraAutomatico.map((f) => (
              <li key={f.tamanho}><strong>{f.tamanho}</strong> — {f.motivo}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const atual = gradeManual || opcoes[indice];
  const naGrade = atual.proporcao.filter((p) => p.unidades > 0);
  const esgotados = naGrade.filter((p) => p.esgotado).map((p) => p.tamanho);
  const fora = foraAutomatico;

  function passo(delta) {
    const atualN = manual === '' ? atual.pecasPorGrade : Number(manual) || atual.pecasPorGrade;
    const alvo = Math.min(maximo, Math.max(minimo, Math.round(atualN) + delta));
    setManual(String(alvo));
  }

  return (
    <>
      <div className={`card gc-card${atualizando ? ' gc-atualizando' : ''}`}>
        <div className="card-head-linha gc-cabeca">
          <h2 className="card-titulo"><Scissors size={16} /> Grade de corte</h2>
          {abas}
          <BotaoCopiar grade={atual} />
        </div>
        <p className="ink-soft ajuda-bloco">
          Quantas vezes cada tamanho entra no risco. Repita a grade quantas vezes
          couber no enfesto.
        </p>

        {antes}
        {seletor}

        <div className="gc-quadros">
          {naGrade.map((p) => (
            <div className="gc-quadro" key={p.tamanho}>
              <span className="gc-quadro-tamanho">{p.tamanho}</span>
              <span className="gc-quadro-unidades">{p.unidades}</span>
            </div>
          ))}
          <div className="gc-total">
            <strong className="mono">{atual.pecasPorGrade}</strong>
            <span>peças<br />por grade</span>
          </div>
          <span className={`selo ${atual.erroMaximoPP === 0 ? 'tone-saudavel' : 'tone-neutro'} gc-erro`}>
            {atual.erroMaximoPP === 0
              ? 'fecha exatamente a curva'
              : `erro máximo de ${pp(atual.erroMaximoPP)}`}
          </span>
        </div>

        {atual.equivaleA && (
          <p className="aviso-inline gc-nota-reducao">
            <AlertTriangle size={14} /> Esta grade é a de {atual.equivaleA} peças
            repetida {atual.pecasPorGrade / atual.equivaleA}×. Mesma proporção, o
            dobro do colchão — só vale a pena se o enfesto pedir.
          </p>
        )}

        <div className="gc-escolha">
          {opcoes.length > 1 && (
            <div className="gc-bloco">
              <span className="field-label">Grades mais curtas</span>
              <div className="gc-chips">
                {opcoes.map((op, i) => (
                  <button
                    type="button"
                    key={op.pecasPorGrade}
                    className={`gc-chip${!gradeManual && i === indice ? ' ativo' : ''}`}
                    aria-pressed={!gradeManual && i === indice}
                    onClick={() => { setEscolhida(i); setManual(''); }}
                  >
                    <span className="gc-chip-rotulo mono">{op.rotulo}</span>
                    <span className="gc-chip-detalhe">
                      {op.pecasPorGrade} peças · erro {pp(op.erroMaximoPP)}
                      {i === indiceRecomendada ? ' · recomendada' : ''}
                    </span>
                  </button>
                ))}
              </div>
              <p className="ink-faint gc-dica">
                Grade curta é mais fácil no enfesto e mais distante da curva real.
              </p>
            </div>
          )}

          <div className="gc-bloco">
            <span className="field-label">Ou o tamanho que o seu enfesto pede</span>
            <div className="gc-manual-linha">
              <div className={`gc-campo${motivoManual ? ' recusado' : ''}`}>
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
                  className="gc-campo-entrada mono"
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
              <span className="ink-soft gc-manual-unidade">peças por grade</span>
              {gradeManual && (
                <button type="button" className="btn btn-ghost sm" onClick={() => setManual('')}>
                  <RotateCcw size={13} /> Voltar para a recomendada
                </button>
              )}
            </div>
            {motivoManual
              ? <p className="erro-inline gc-recusa">{motivoManual}</p>
              : <p className="ink-faint gc-dica">De {minimo} a {maximo} peças. A proporção se ajusta ao número que você escolher.</p>}
          </div>
        </div>

        {esgotados.length > 0 && (
          <p className="aviso-inline">
            <AlertTriangle size={14} /> {esgotados.join(', ')} esgotou no período — a
            participação está subestimada, e a grade também.
          </p>
        )}

        {fora.length > 0 && (
          <details className="gc-fora-detalhe">
            <summary>
              <Info size={14} />
              <span>
                {fora.length === 1
                  ? '1 tamanho ficou fora da grade'
                  : `${fora.length} tamanhos ficaram fora da grade`}
              </span>
              <span className="ink-faint gc-fora-amostra">
                {fora.slice(0, 4).map((f) => f.tamanho).join(', ')}{fora.length > 4 ? '…' : ''}
              </span>
            </summary>
            <ul className="gc-fora">
              {fora.map((f) => (
                <li key={f.tamanho}>
                  <strong>{f.tamanho}</strong> — {f.motivo}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {atual.repeticoes && (
        <div className="card">
          <div className="card-head-linha">
            <h2 className="card-titulo">
              <Scissors size={16} /> Para um lote de {loteAlvo} peças
            </h2>
            <span className="gc-lote-resumo">
              <strong className="mono">{atual.repeticoes} grades = {atual.totalPecas} peças</strong>
              {atual.diferencaParaLote !== 0 && (
                <span className="ink-faint">
                  {' '}({Math.abs(atual.diferencaParaLote)}{' '}
                  {atual.diferencaParaLote < 0 ? 'a menos' : 'a mais'})
                </span>
              )}
            </span>
          </div>

          <div className="tabela-rolagem">
            <table className="tabela-nota gc-tabela">
              <thead>
                <tr>
                  <th>Tamanho</th>
                  <th className="num">Grade</th>
                  <th className="num">× {atual.repeticoes} grades</th>
                  <th className="num">Participação</th>
                  <th className="num">Curva real</th>
                </tr>
              </thead>
              <tbody>
                {naGrade.map((p) => (
                  <tr key={p.tamanho}>
                    <td><strong>{p.tamanho}</strong></td>
                    <td className="num">{p.unidades}</td>
                    <td className="num"><strong>{p.unidades * atual.repeticoes}</strong></td>
                    <td className="num">{pct(p.participacaoGrade)}</td>
                    <td className="num ink-faint">{pct(p.participacaoReal)}</td>
                  </tr>
                ))}
                <tr className="linha-total">
                  <td><strong>Total</strong></td>
                  <td className="num">{atual.pecasPorGrade}</td>
                  <td className="num"><strong>{atual.totalPecas}</strong></td>
                  <td className="num" />
                  <td className="num" />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
