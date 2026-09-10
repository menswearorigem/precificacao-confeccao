import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import Lightbox from './Lightbox';

// Miniatura da foto do produto (ou um placeholder discreto se não tiver
// foto), clicável pra ampliar em tela cheia. `urlBase` deixa reaproveitar em
// contextos que não têm acesso ao módulo Produto (ex.: Viagens usa
// /viagens/produtos/:id/foto em vez de /produtos/:id/foto).
//
// `url` (10/09/2026): uma foto EXTERNA para quando a referência não tem foto
// no cadastro — hoje é a do anúncio no marketplace. Ela é o segundo lugar
// onde procurar, nunca o primeiro: é um link para a plataforma, não um
// arquivo nosso, e some quando o anúncio é encerrado. Por isso também existe
// o `onError`: link podre vira o placeholder de sempre, não um ícone de
// imagem quebrada.
export default function FotoProduto({
  produtoId, temFoto, url = null, urlBase = '/produtos',
  size = 48, alt = '', rounded = true,
}) {
  const [ampliada, setAmpliada] = useState(false);
  const [falhou, setFalhou] = useState(false);
  const estilo = { width: size, height: size, borderRadius: rounded ? 'var(--radius-sm)' : 0 };

  const src = temFoto ? `/api${urlBase}/${produtoId}/foto` : (url || null);

  if (!src || falhou) {
    return (
      <div className="foto-produto-placeholder" style={estilo}>
        <ImageOff size={Math.max(12, size * 0.4)} />
      </div>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt}
        className="foto-produto-thumb"
        style={estilo}
        loading="lazy"
        onError={() => setFalhou(true)}
        onClick={() => setAmpliada(true)}
      />
      {ampliada && <Lightbox src={src} alt={alt} onClose={() => setAmpliada(false)} />}
    </>
  );
}
