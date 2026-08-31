import { useEffect } from 'react';
import { Check } from 'lucide-react';

// Barra fixa no rodapé da área de conteúdo — some quando não há nada sujo,
// aparece assim que o primeiro campo muda. O componente é "burro" de
// propósito: quem chama é quem sabe o que está sujo (um diff de estado
// local vs. o que veio da API) e o que "salvar"/"descartar" significa pra
// aquela tela — aqui só existe a UI, o atalho de teclado e o aviso de saída.
//
// Uso típico (ver CustosIndiretosPage.jsx, ParametrosPage.jsx etc.):
//   const [rascunho, setRascunho] = useState(dadosDoServidor);
//   const sujo = JSON.stringify(rascunho) !== JSON.stringify(dadosDoServidor);
//   <BarraAlteracoes
//     quantidade={contarCamposAlterados(rascunho, dadosDoServidor)}
//     salvando={salvando}
//     mensagemSalvo={mensagemSalvo}         // ex.: "Salvo · há instantes", por alguns segundos
//     detalhe="Margem ideal · Saudável até"  // opcional, quais campos mudaram
//     onSalvar={salvar}
//     onDescartar={() => setRascunho(dadosDoServidor)}
//   />
export default function BarraAlteracoes({ quantidade = 0, salvando, mensagemSalvo, detalhe, onSalvar, onDescartar }) {
  const visivel = quantidade > 0 || Boolean(mensagemSalvo);

  useEffect(() => {
    function aoTeclar(e) {
      const teclaSalvar = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
      if (!teclaSalvar) return;
      if (quantidade === 0 || salvando) return;
      e.preventDefault();
      onSalvar?.();
    }
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [quantidade, salvando, onSalvar]);

  useEffect(() => {
    if (quantidade === 0) return undefined;
    function aoSair(e) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', aoSair);
    return () => window.removeEventListener('beforeunload', aoSair);
  }, [quantidade]);

  if (!visivel) return null;

  return (
    <div className="cfg-barra-alteracoes">
      <div className="cfg-barra-alteracoes-texto">
        {quantidade > 0 ? (
          <>
            <span className="cfg-barra-alteracoes-ponto" />
            <span>
              <strong>{quantidade} {quantidade === 1 ? 'alteração não salva' : 'alterações não salvas'}</strong>
              {detalhe && <span className="cfg-barra-alteracoes-detalhe">{detalhe}</span>}
            </span>
          </>
        ) : (
          <span className="cfg-barra-alteracoes-salvo"><Check size={14} /> {mensagemSalvo}</span>
        )}
      </div>
      {quantidade > 0 && (
        <div className="cfg-barra-alteracoes-acoes">
          <span className="cfg-barra-alteracoes-atalho">Ctrl+S</span>
          <button type="button" className="btn btn-ghost" onClick={onDescartar} disabled={salvando}>Descartar</button>
          <button type="button" className="btn btn-primary" onClick={onSalvar} disabled={salvando}>
            {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      )}
    </div>
  );
}
