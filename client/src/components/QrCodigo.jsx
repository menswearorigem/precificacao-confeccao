import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// QR code desenhado no navegador (28/09/2026). Sem serviço externo: a ficha
// do lote imprime mesmo sem internet fora do Hub.
export default function QrCodigo({ texto, tamanho = 160, className = '' }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let vivo = true;
    QRCode.toDataURL(String(texto || ''), { margin: 1, width: tamanho * 2, errorCorrectionLevel: 'M' })
      .then((url) => { if (vivo) setSrc(url); })
      .catch(() => { if (vivo) setSrc(''); });
    return () => { vivo = false; };
  }, [texto, tamanho]);
  if (!src) return <span className={`qr-vazio ${className}`} style={{ width: tamanho, height: tamanho }} />;
  return <img className={className} src={src} width={tamanho} height={tamanho} alt={`QR: ${texto}`} />;
}

/** Endereço que o QR do lote abre. */
export function urlDoLote(ordemServicoId) {
  return `${window.location.origin}/producao/lote/${ordemServicoId}`;
}

/** Lê o que o leitor devolveu (a URL do QR do lote) e acha a O.S. */
export function loteDoCodigo(codigo) {
  const url = String(codigo || '').trim().match(/\/producao\/lote\/(\d+)/);
  return url ? Number(url[1]) : null;
}
