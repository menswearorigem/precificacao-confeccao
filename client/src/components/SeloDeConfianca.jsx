import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatQtd } from '../lib/format';

// Selo de confiança (TAREFA 4.0) — aparece no rodapé de todo painel
// agregado desta onda. Cada painel calcula o próprio "considerado de
// quanto" e o motivo de exclusão (dado ausente NUNCA vira zero — fica de
// fora e é contado aqui). Puramente apresentacional: cada chamador decide
// os números, este componente só formata.
//
// Exemplo: <SeloDeConfianca considerado={312} total={418}
//   excluidos={[{ label: 'sem custo de material', total: 106 }]} />
// renderiza "calculado sobre 312 de 418 referências · 106 sem custo de material"
export default function SeloDeConfianca({ considerado, total, unidade = 'referências', excluidos = [] }) {
  const integro = considerado === total && excluidos.every((e) => e.total === 0);
  return (
    <div
      className={'stamp sm ' + (integro ? 'tone-saudavel' : 'tone-atencao')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12 }}
    >
      {integro ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
      <span>
        calculado sobre {formatQtd(considerado)} de {formatQtd(total)} {unidade}
        {excluidos.filter((e) => e.total > 0).map((e) => ` · ${formatQtd(e.total)} ${e.label}`).join('')}
      </span>
      <Link to="/qualidade-dados" className="login-link" style={{ fontSize: 11 }}>ver auditoria</Link>
    </div>
  );
}
