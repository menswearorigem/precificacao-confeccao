import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, numeroBr } from '../lib/format';
import { Skeleton } from './ui';

// Histórico de preço e custo (TAREFA 4.6, autorizada explicitamente pelo
// dono do sistema). Não cria nada novo no banco: a tabela
// historico_precificacao já existe desde a implantação do sistema — todo
// salvamento de produto já grava um snapshot completo do cálculo. Esta é
// só a primeira tela que lê esse histórico que já vinha sendo guardado.
//
// Importante: o histórico só existe a partir do primeiro salvamento desta
// referência no sistema. Não há como reconstruir preço/custo de antes
// disso — mostrar isso explicitamente evita a leitura errada de "essa
// referência não tinha preço antes".
export default function HistoricoPrecoCard({ produtoId }) {
  const [historico, setHistorico] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!produtoId || produtoId === 'novo') { setLoading(false); return; }
    api.get(`/produtos/${produtoId}/historico`)
      .then(setHistorico)
      .finally(() => setLoading(false));
  }, [produtoId]);

  if (!produtoId || produtoId === 'novo') return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><History size={14} /> Histórico de Preço e Custo</div>

      {loading && <Skeleton width="60%" height={14} />}

      {!loading && (!historico || historico.length === 0) && (
        <p className="page-sub" style={{ margin: 0 }}>
          Ainda não há snapshot registrado pra esta referência — o histórico começa a contar a
          partir do primeiro salvamento aqui na ficha.
        </p>
      )}

      {!loading && historico && historico.length > 0 && (
        <>
          <p className="page-sub" style={{ marginTop: 0 }}>
            Um snapshot é gravado a cada vez que esta ficha é salva. Mostra a evolução a partir daqui
            — não há como reconstruir valores de antes do primeiro registro abaixo.
          </p>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Preço sugerido</th>
                  <th>Custo total</th>
                  <th>Margem</th>
                  <th>Markup</th>
                </tr>
              </thead>
              <tbody>
                {historico.map((h) => {
                  const s = h.snapshot || {};
                  const fp = s.formacaoPreco || {};
                  const ct = s.custoTotal || {};
                  return (
                    <tr key={h.id}>
                      <td className="mono">{new Date(h.criado_em).toLocaleString('pt-BR')}</td>
                      <td className="mono">{fp.precoSugerido != null ? brl(fp.precoSugerido) : '—'}</td>
                      <td className="mono">{ct.custoTotalPeca != null ? brl(ct.custoTotalPeca) : '—'}</td>
                      <td className="mono">{fp.lucroPct != null ? pct(fp.lucroPct) : '—'}</td>
                      <td className="mono">{fp.markupMult != null ? `${numeroBr(fp.markupMult)}x` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
