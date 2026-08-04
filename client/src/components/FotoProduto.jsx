import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import Lightbox from './Lightbox';

// Miniatura da foto do produto (ou um placeholder discreto se não tiver
// foto), clicável pra ampliar em tela cheia. `urlBase` deixa reaproveitar em
// contextos que não têm acesso ao módulo Produto (ex.: Viagens usa
// /viagens/produtos/:id/foto em vez de /produtos/:id/foto).
export default function FotoProduto({ produtoId, temFoto, urlBase = '/produtos', size = 48, alt = '', rounded = true }) {
  const [ampliada, setAmpliada] = useState(false);
  const estilo = { width: size, height: size, borderRadius: rounded ? 'var(--radius-sm)' : 0 };

  if (!temFoto) {
    return (
      <div className="foto-produto-placeholder" style={estilo}>
        <ImageOff size={Math.max(12, size * 0.4)} />
      </div>
    );
  }

  const src = `/api${urlBase}/${produtoId}/foto`;
  return (
    <>
      <img
        src={src}
        alt={alt}
        className="foto-produto-thumb"
        style={estilo}
        onClick={() => setAmpliada(true)}
      />
      {ampliada && <Lightbox src={src} alt={alt} onClose={() => setAmpliada(false)} />}
    </>
  );
}
