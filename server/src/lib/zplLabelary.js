// Reserva do conversor de etiqueta: a API pública da Labelary.
//
// Quando usar: só quando o render local não dá conta — etiqueta com imagem
// embutida (^GF/~DG), QR Code (^BQ) ou fonte carregada. O render local
// (`zpl.js`) é o caminho normal, porque não depende de rede, não tem limite
// diário e não manda dado de pedido para fora da casa.
//
// ⚠️ O QUE SAI DAQUI: o ZPL da etiqueta inteira vai para um serviço de
// terceiro. Uma etiqueta de transporte contém NOME e ENDEREÇO do comprador.
// Por isso a reserva é OPT-IN: nunca acontece sozinha. A rota só chama isto
// quando quem está na tela pede, sabendo o que está fazendo.
//
// Limites da conta gratuita, segundo a documentação: 3 requisições por segundo,
// 5.000 por dia e 50 etiquetas por chamada.

const LABELARY = 'https://api.labelary.com/v1/printers';

async function converterPelaLabelary(zpl, { dpmm = 8, larguraPol = 4, alturaPol = 6, timeoutMs = 20000 } = {}) {
  const url = `${LABELARY}/${dpmm}dpmm/labels/${larguraPol}x${alturaPol}/`;
  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/pdf', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: zpl,
      signal: controle.signal,
    });
    if (!resposta.ok) {
      const texto = await resposta.text().catch(() => '');
      throw Object.assign(
        new Error(`A Labelary recusou a etiqueta (HTTP ${resposta.status}). ${texto.slice(0, 200)}`),
        { status: 502 }
      );
    }
    const buf = Buffer.from(await resposta.arrayBuffer());
    if (buf.slice(0, 4).toString() !== '%PDF') {
      throw Object.assign(new Error('A Labelary devolveu algo que não é PDF.'), { status: 502 });
    }
    return buf;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(
        new Error('A Labelary não respondeu a tempo. A etiqueta não foi convertida.'),
        { status: 504 }
      );
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { converterPelaLabelary };
