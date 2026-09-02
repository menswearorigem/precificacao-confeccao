import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import ManuPainel from './ManuPainel';

const CHAVE_APRESENTADA = 'hbn_manu_apresentada';

// Solta a arte da mascote em client/public/manu.png quando ela chegar (já
// está — 240×253px, fundo próprio, sem transparência). Formato esperado:
// imagem quadrada ou quase quadrada, ~12% de respiro interno em volta da
// figura — o <img> usa object-fit: cover dentro de um círculo, então uma
// imagem já enquadrada rente às bordas corta a mascote. Se o arquivo faltar
// ou falhar ao carregar, cai pro ícone MessageCircleQuestion do
// lucide-react sem quebrar nada — é o que o onError abaixo faz.
const CAMINHO_MASCOTE = '/manu.png';

// Elementos fixos que já disputam o canto inferior da tela — a Manu não
// pode cobrir nenhum dos dois (checagem obrigatória, ver relatório da
// tarefa). Em vez de um valor de altura fixo "no chute", medimos o próprio
// elemento quando ele está visível e subimos o botão o suficiente.
const SELETORES_COLISAO = ['.cfg-barra-alteracoes', '.viagem-carrinho-flutuante'];

function useDesvioDeColisao() {
  const [desvio, setDesvio] = useState(0);

  useEffect(() => {
    function medir() {
      let maiorAltura = 0;
      for (const seletor of SELETORES_COLISAO) {
        const el = document.querySelector(seletor);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        // só conta quem está realmente visível perto do rodapé da tela.
        const visivel = rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
        if (visivel) maiorAltura = Math.max(maiorAltura, rect.height);
      }
      setDesvio(maiorAltura > 0 ? maiorAltura + 14 : 0);
    }
    medir();
    // Sem MutationObserver de propósito: os dois elementos aparecem/somem
    // por causa de scroll, resize ou uma mudança de estado da própria
    // página (rascunho sujo, carrinho de viagem) — um intervalo curto pega
    // os três casos sem precisar instrumentar toda tela que os usa.
    const intervalo = setInterval(medir, 500);
    window.addEventListener('scroll', medir, true);
    window.addEventListener('resize', medir);
    return () => {
      clearInterval(intervalo);
      window.removeEventListener('scroll', medir, true);
      window.removeEventListener('resize', medir);
    };
  }, []);

  return desvio;
}

export default function ManuBotao() {
  const [aberto, setAberto] = useState(false);
  const [imagemFalhou, setImagemFalhou] = useState(false);
  const [balaoVisivel, setBalaoVisivel] = useState(false);
  const botaoRef = useRef(null);
  const desvio = useDesvioDeColisao();

  // Balão de boas-vindas: só na primeira visita, some sozinho depois de 8s
  // ou no primeiro clique, e nunca mais volta.
  useEffect(() => {
    let jaViu = true;
    try {
      jaViu = localStorage.getItem(CHAVE_APRESENTADA) === '1';
    } catch {
      // localStorage indisponível — trata como se já tivesse visto, pra
      // não arriscar mostrar o balão em todo carregamento de página.
    }
    if (jaViu) return undefined;
    const abrirTimer = setTimeout(() => setBalaoVisivel(true), 600);
    const fecharTimer = setTimeout(() => marcarApresentada(), 8600);
    return () => {
      clearTimeout(abrirTimer);
      clearTimeout(fecharTimer);
    };
  }, []);

  function marcarApresentada() {
    setBalaoVisivel(false);
    try {
      localStorage.setItem(CHAVE_APRESENTADA, '1');
    } catch {
      // sem localStorage, o balão pode voltar na próxima visita — não é
      // grave o bastante pra travar nada por causa disso.
    }
  }

  function abrirPainel() {
    if (balaoVisivel) marcarApresentada();
    setAberto(true);
  }

  function fecharPainel() {
    setAberto(false);
    // devolve o foco pro botão que abriu o painel — sem isso quem navega
    // por teclado perde a posição na página ao fechar.
    botaoRef.current?.focus();
  }

  return (
    <>
      <div
        className="manu-botao-wrap"
        style={desvio > 0 ? { '--manu-desvio': `${desvio}px` } : undefined}
      >
        {balaoVisivel && (
          <div className="manu-balao" role="status">
            Oi! Sou a Manu. Qualquer dúvida do sistema, é só me perguntar.
          </div>
        )}
        <button
          ref={botaoRef}
          type="button"
          className="manu-botao"
          aria-label="Falar com a Manu"
          title="Falar com a Manu"
          onClick={abrirPainel}
        >
          {imagemFalhou ? (
            <MessageCircleQuestion size={26} />
          ) : (
            <img
              src={CAMINHO_MASCOTE}
              alt=""
              className="manu-botao-img"
              onError={() => setImagemFalhou(true)}
            />
          )}
          <span className="manu-botao-rotulo">Falar com a Manu</span>
        </button>
      </div>

      {aberto && <ManuPainel variante="flutuante" onFechar={fecharPainel} />}
    </>
  );
}
