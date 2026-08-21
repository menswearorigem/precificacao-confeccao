import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '../api/client';

// Selo de confiança reutilizável — pensado pra ir no topo de painéis
// agregados (Dashboard Executivo, Indicadores de Estoque). Não substitui a
// tela de Qualidade do Dado: só avisa que ela existe quando há algo pra
// olhar, e some sozinho quando os três critérios acompanhados estão limpos.
export default function SeloConfianca() {
  const [dados, setDados] = useState(null);

  useEffect(() => {
    api.get('/qualidade-dados').then(setDados).catch(() => {});
  }, []);

  if (!dados) return null;

  if (dados.total === 0) {
    return (
      <Link to="/qualidade-dados" className="stamp sm tone-saudavel" style={{ textDecoration: 'none' }}>
        <ShieldCheck size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
        Dado íntegro nos critérios acompanhados
      </Link>
    );
  }

  return (
    <Link to="/qualidade-dados" className="stamp sm tone-atencao" style={{ textDecoration: 'none' }}>
      <ShieldAlert size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
      {dados.total} lacuna(s) de dado a conferir antes de confiar 100% nestes números
    </Link>
  );
}
