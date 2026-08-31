import QualidadeDadosPage from './QualidadeDadosPage';
import ConferenciaDadosPage from './ConferenciaDadosPage';

// Página fundida (Etapa 2): "Qualidade do Dado" e "Conferência de Dados"
// viravam 2 abas separadas — sem sub-abas aqui (diferente de Taxas/Acessos):
// os indicadores da Qualidade ficam no topo, seguidos das listas de
// suspeitos da Conferência, como uma única leitura de cima a baixo.
export default function SaudeDadosPage() {
  return (
    <div className="page-wide">
      <h2>Saúde dos Dados</h2>
      <p className="page-sub">
        Um raio-x do que está incompleto ou com cara de dado de teste — nenhuma das duas seções abaixo
        corrige ou apaga nada sozinha.
      </p>
      <QualidadeDadosPage />
      <ConferenciaDadosPage />
    </div>
  );
}
