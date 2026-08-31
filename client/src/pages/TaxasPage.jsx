import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Percent, ReceiptText } from 'lucide-react';
import TaxasVendaPage from './TaxasVendaPage';
import MarketplaceTaxasPage from './MarketplaceTaxasPage';

// Página fundida (Etapa 2 do redesenho de Configurações): "Taxas de Venda"
// e "Taxas de Marketplace" viravam 2 abas separadas do mesmo grupo — agora
// são sub-abas de uma página só, com o conteúdo de cada uma inalterado
// (TaxasVendaPage/MarketplaceTaxasPage continuam existindo como
// componentes de conteúdo, só sem o wrapper .page-wide/h2 próprio).
const SUBABAS = [
  { chave: 'venda', label: 'Venda', Icone: Percent },
  { chave: 'marketplace', label: 'Marketplace', Icone: ReceiptText },
];

export default function TaxasPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const inicial = searchParams.get('aba') === 'marketplace' ? 'marketplace' : 'venda';
  const [aba, setAba] = useState(inicial);

  function trocarAba(chave) {
    setAba(chave);
    setSearchParams(chave === 'venda' ? {} : { aba: chave }, { replace: true });
  }

  return (
    <div className="page-wide">
      <h2>Taxas</h2>
      <div className="subtab-row">
        {SUBABAS.map((s) => (
          <button
            key={s.chave}
            type="button"
            className={'subtab-btn' + (aba === s.chave ? ' active' : '')}
            onClick={() => trocarAba(s.chave)}
          >
            <s.Icone size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
            {s.label}
          </button>
        ))}
      </div>

      {aba === 'venda' ? <TaxasVendaPage /> : <MarketplaceTaxasPage />}
    </div>
  );
}
