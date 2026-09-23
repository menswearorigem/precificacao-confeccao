import { Scissors, AlertTriangle, PackageCheck } from 'lucide-react';
import { formatQtd, numeroBr } from '../lib/format';

/**
 * Aba "Venda + estoque" da Grade de corte (23/09/2026).
 *
 * Mostra, por tamanho, quanto o que a casa já tem (estoque de primeira + em
 * produção) dura no ritmo de venda atual, e SUGERE tirar do corte o tamanho
 * que aguenta o horizonte escolhido. Não tira sozinho: o botão é de quem
 * corta. A conta vem pronta do servidor (server/src/lib/coberturaTamanho.js).
 */
export default function CoberturaPorTamanho({
  dados, excluidos, onAlternar, onTirarSugeridos, horizonte, onHorizonte,
}) {
  if (!dados) return null;
  const fora = new Set(excluidos.map((t) => t.toUpperCase()));
  const pendentes = dados.sugeridos.filter((t) => !fora.has(t.toUpperCase()));

  return (
    <div className="ce-painel">
      <div className="ce-horizonte">
        <span className="field-label">Sai do corte o tamanho cujo estoque dura</span>
        <div className="segmentado" role="group" aria-label="Horizonte em dias">
          {dados.horizontes.map((d) => (
            <button
              type="button"
              key={d}
              className={d === horizonte ? 'ativo' : undefined}
              aria-pressed={d === horizonte}
              onClick={() => onHorizonte(d)}
            >
              {d} dias
            </button>
          ))}
        </div>
      </div>

      <div className="tabela-rolagem">
        <table className="tabela-nota ce-tabela">
          <thead>
            <tr>
              <th>Tamanho</th>
              <th className="num">Vende/mês</th>
              <th className="num">Estoque</th>
              <th className="num">Em produção</th>
              <th className="num">Dura</th>
              <th>&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {dados.linhas.map((l) => {
              const tirado = fora.has(l.tamanho.toUpperCase());
              return (
                <tr key={l.tamanho} className={tirado ? 'ce-linha-fora' : undefined} title={l.motivo}>
                  <td><strong>{l.tamanho}</strong></td>
                  <td className="num">{numeroBr(l.vendaMes, 1)}</td>
                  <td className="num">{formatQtd(l.estoque)}</td>
                  <td className="num ink-soft">{l.emProducao > 0 ? formatQtd(l.emProducao) : '—'}</td>
                  <td className="num">
                    {l.duraDias === null
                      ? <span className="ink-faint">{l.tenho > 0 ? 'sem venda' : '—'}</span>
                      : <strong className={l.sugereTirar ? 'ce-dura-ok' : undefined}>{formatQtd(l.duraDias)} dias</strong>}
                  </td>
                  <td className="ce-acao">
                    {tirado ? (
                      <button type="button" className="btn btn-ghost sm" onClick={() => onAlternar(l.tamanho)}>
                        Devolver ao corte
                      </button>
                    ) : l.sugereTirar ? (
                      <button type="button" className="ce-tirar" onClick={() => onAlternar(l.tamanho)}>
                        <Scissors size={12} /> Tirar do corte
                      </button>
                    ) : (
                      <span className="ink-faint ce-entra">entra no corte</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pendentes.length > 1 && (
        <div className="ce-sugestao">
          <PackageCheck size={15} />
          <span>
            <strong>{pendentes.join(', ')}</strong> aguentam {dados.horizonteDias} dias com o que já tem.
          </span>
          <button type="button" className="ce-tirar" onClick={() => onTirarSugeridos(pendentes)}>
            <Scissors size={12} /> Tirar os {pendentes.length}
          </button>
        </div>
      )}

      {dados.todosCobertos && (
        <p className="aviso-inline">
          <AlertTriangle size={14} /> Todos os tamanhos com venda aguentam {dados.horizonteDias} dias
          com o que já tem — talvez ainda não seja hora de cortar.
        </p>
      )}

      <p className="ink-faint gc-dica ce-rodape">
        Ritmo = venda dos últimos {formatQtd(dados.diasDoRitmo)} dias {dados.escopo}
        {dados.ritmoCaiuParaJanela ? ' (não houve venda nos últimos 90 dias, então vale a janela inteira)' : ''}.
        Estoque = saldo de primeira qualidade; em produção = o que falta chegar das ordens abertas.
        A proporção dos tamanhos que ficam continua sendo a da venda.
      </p>
    </div>
  );
}
