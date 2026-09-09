// Interpretador de ZPL → PDF.
//
// ---------------------------------------------------------------------------
// Por que isto existe
// ---------------------------------------------------------------------------
// A etiqueta do Mercado Livre Full sai em ZPL, e a impressora da casa só
// imprime PDF. Hoje isso trava a expedição todo dia. O pedido de um conversor
// dentro do próprio Hub é de 03/09/2026 e ficou adiado desde então.
//
// Vale registrar o que a pesquisa de 09/09 mostrou: o UpSeller, que a casa tem
// instalado, **não resolve** — a documentação dele diz textualmente que o
// plugin de impressão não suporta ZPL e que é preciso ter uma impressora Zebra
// de verdade com o Zebra Browser Print. Ou seja, ele repassa o ZPL; não
// rasteriza. Por isso construir aqui não é reinventar roda: é a única saída.
//
// ---------------------------------------------------------------------------
// Motor híbrido, como combinado em 03/09
// ---------------------------------------------------------------------------
// 1. RENDER LOCAL (este arquivo): interpreta o subconjunto de ZPL que aparece
//    em etiqueta de transporte — posição, texto, caixa, linha e código de
//    barras Code128. Não depende de rede, não tem limite diário e não manda
//    dado de pedido para fora.
// 2. LABELARY como RESERVA (`zplLabelary.js`): quando a etiqueta usa algo que
//    o render local não conhece — imagem embutida (^GF/~DG), fonte carregada,
//    QR Code — o Hub pode cair para a API pública, que rasteriza qualquer ZPL.
//
// A decisão de quando cair para a reserva é explícita: `analisar()` devolve o
// que não foi entendido, e a rota decide. Nada é renderizado "mais ou menos"
// em silêncio — etiqueta errada volta como pacote errado.

const { DocumentoPdf } = require('./pdfMinimo');

// ---------------------------------------------------------------------------
// Code 128
// ---------------------------------------------------------------------------
// Tabela padrão: 107 símbolos, cada um com as larguras de 6 elementos
// (barra, espaço, barra, espaço, barra, espaço). O último, a parada, tem 7.
const C128 = ('212222,222122,222221,121223,121322,131222,122213,122312,132212,221213,'
  + '221312,231212,112232,122132,122231,113222,123122,123221,223211,221132,'
  + '221231,213212,223112,312131,311222,321122,321221,312212,322112,322211,'
  + '212123,212321,232121,111323,131123,131321,112313,132113,132311,211313,'
  + '231113,231311,112133,112331,132131,113123,113321,133121,313121,211331,'
  + '231131,213113,213311,213131,311123,311321,331121,312113,312311,332111,'
  + '314111,221411,431111,111224,111422,121124,121421,141122,141221,112214,'
  + '112412,122114,122411,142112,142211,241211,221114,413111,241112,134111,'
  + '111242,121142,121241,114212,124112,124211,411212,421112,421211,212141,'
  + '214121,412121,111143,111341,131141,114113,114311,411113,411311,113141,'
  + '114131,311141,411131,211412,211214,211232,2331112').split(',');

const INICIO_B = 104;
const INICIO_C = 105;
const PARADA = 106;
const TROCA_C = 99;
const TROCA_B = 100;

// Codifica em Code128 com troca automática para o subconjunto C em corridas de
// dígito — é o que reduz o tamanho da barra em código de rastreio, que costuma
// ser todo numérico.
function codificarCode128(texto) {
  const s = String(texto ?? '');
  const valores = [];
  let i = 0;

  const digitosAPartirDe = (p) => {
    let n = 0;
    while (p + n < s.length && s[p + n] >= '0' && s[p + n] <= '9') n += 1;
    return n;
  };

  let modo = null;
  const inicioDigitos = digitosAPartirDe(0);
  if (inicioDigitos >= 4 && inicioDigitos % 2 === 0) { valores.push(INICIO_C); modo = 'C'; }
  else { valores.push(INICIO_B); modo = 'B'; }

  while (i < s.length) {
    if (modo === 'C') {
      const n = digitosAPartirDe(i);
      if (n >= 2) {
        valores.push(Number(s.substr(i, 2)));
        i += 2;
        continue;
      }
      valores.push(TROCA_B); modo = 'B';
      continue;
    }
    const n = digitosAPartirDe(i);
    if (n >= 6 && n % 2 === 0) { valores.push(TROCA_C); modo = 'C'; continue; }
    const cod = s.charCodeAt(i);
    // Code B cobre ASCII 32..126 -> valores 0..94.
    valores.push(cod >= 32 && cod <= 126 ? cod - 32 : 0);
    i += 1;
  }

  const inicio = valores[0];
  let soma = inicio;
  for (let k = 1; k < valores.length; k += 1) soma += valores[k] * k;
  valores.push(soma % 103);
  valores.push(PARADA);

  // Vira lista de larguras alternando barra/espaço, começando por barra.
  const elementos = [];
  for (const v of valores) {
    for (const ch of C128[v]) elementos.push(Number(ch));
  }
  return elementos;
}

// ---------------------------------------------------------------------------
// Interpretador
// ---------------------------------------------------------------------------

// Comandos que existem em etiqueta de transporte e que NÃO alteram o desenho —
// ignorar é correto, e não conta como "não entendido".
const IGNORAR = new Set([
  'CI', 'MD', 'PR', 'MN', 'LS', 'LT', 'PO', 'JMA', 'MM', 'MT', 'MU',
  'XZ', 'XA', 'FS', 'CT', 'JUS', 'SZ', 'PM', 'PQ', 'FW', 'FR', 'LR', 'CC', 'CW',
]);

// Comandos que MUDAM o desenho e que este render não sabe fazer. A presença de
// qualquer um manda a etiqueta para a reserva — desenhar sem eles produziria
// uma etiqueta bonita e errada.
const NAO_SUPORTADOS = new Set(['GF', 'DG', 'DY', 'IM', 'XG', 'BQ', 'B3', 'BX', 'B7']);

function separarComandos(zpl) {
  // Cada comando começa com ^ ou ~. `^FD` leva dado livre até `^FS`.
  const bruto = String(zpl || '');
  const cmds = [];
  // O nome do comando tem EXATAMENTE 2 caracteres. Aceitar 1 a 3 fazia o
  // regex engolir o primeiro dígito do argumento: `^FO30,30` virava o comando
  // "FO3" com argumento "0,30", e a etiqueta saía em branco.
  // `^A0N,40,40` é o comando `^A` com fonte `0` — cai como nome "A0" e
  // orientação no início dos argumentos, que é como o interpretador espera.
  const re = /([\^~])([A-Z][A-Z0-9])([^\^~]*)/gi;
  let m;
  while ((m = re.exec(bruto))) {
    cmds.push({ prefixo: m[1], nome: m[2].toUpperCase(), args: m[3] });
  }
  return cmds;
}

function separarEtiquetas(zpl) {
  const partes = String(zpl || '').split(/\^XA/i).slice(1);
  return partes.map((p) => `^XA${p.split(/\^XZ/i)[0]}^XZ`);
}

// Analisa sem desenhar: diz se dá para renderizar localmente.
function analisar(zpl) {
  const etiquetas = separarEtiquetas(zpl);
  const naoEntendidos = new Set();
  for (const et of etiquetas) {
    for (const c of separarComandos(et)) {
      // Comparação por PREFIXO, não por igualdade: `^GFA` e `^GFB` são a
      // mesma família de `^GF`, e `~DGR:` é `~DG`. Comparar o nome inteiro
      // deixava a imagem embutida passar batida — a etiqueta saía sem o
      // logotipo e sem ninguém saber.
      const familia = [...NAO_SUPORTADOS].find((n) => c.nome.startsWith(n));
      if (familia) naoEntendidos.add(familia);
    }
  }
  return {
    etiquetas: etiquetas.length,
    local: naoEntendidos.size === 0 && etiquetas.length > 0,
    naoEntendidos: [...naoEntendidos],
  };
}

// Renderiza UMA etiqueta numa página.
function desenharEtiqueta(pagina, comandos, { dots2pt, larguraDots }) {
  let x = 0; let y = 0;
  let homeX = 0; let homeY = 0;
  let alturaFonte = 20; let larguraFonte = 0;
  let byLargura = 2; let byAltura = 40;
  let barcodePendente = null;
  let blocoLargura = null;
  let inverso = false;

  const num = (v, padrao = 0) => {
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : padrao;
  };

  for (const c of comandos) {
    const partes = c.args.split(',');
    switch (c.nome) {
      case 'LH':
        homeX = num(partes[0]); homeY = num(partes[1]);
        break;
      case 'FO':
      case 'FT':
        x = homeX + num(partes[0]);
        y = homeY + num(partes[1]);
        // ^FT posiciona pela LINHA DE BASE; ^FO pelo topo. Guardar a diferença
        // evita texto subindo meia linha na etiqueta inteira.
        y = c.nome === 'FT' ? y - alturaFonte : y;
        break;
      case 'A':
      case 'A0':
      case 'AD':
      case 'AA':
      case 'AB': {
        // ^A0N,altura,largura
        const p = c.args.replace(/^[0-9A-Z]/i, '').split(',');
        alturaFonte = num(p[1], alturaFonte) || alturaFonte;
        larguraFonte = num(p[2], 0);
        break;
      }
      case 'CF':
        alturaFonte = num(partes[1], alturaFonte) || alturaFonte;
        break;
      case 'BY':
        byLargura = num(partes[0], byLargura) || byLargura;
        byAltura = num(partes[2], byAltura) || byAltura;
        break;
      case 'BC':
        barcodePendente = {
          altura: num(partes[1], byAltura) || byAltura,
          linhaTexto: String(partes[2] || 'Y').toUpperCase() !== 'N',
        };
        break;
      case 'FB':
        blocoLargura = num(partes[0], null);
        break;
      case 'GB': {
        const w = num(partes[0]);
        const h = num(partes[1]);
        const esp = num(partes[2], 1) || 1;
        // No ZPL, ^GB com largura ou altura menor que a espessura é uma LINHA.
        if (w <= esp || h <= esp) {
          pagina.retangulo(dots2pt(x), dots2pt(y),
            dots2pt(Math.max(w, esp)), dots2pt(Math.max(h, esp)));
        } else {
          pagina.moldura(dots2pt(x), dots2pt(y), dots2pt(w), dots2pt(h), dots2pt(esp));
        }
        break;
      }
      case 'FR':
        inverso = true;
        break;
      case 'FD': {
        const dado = c.args.replace(/\^FS.*$/i, '');
        if (barcodePendente) {
          const elementos = codificarCode128(dado);
          const alturaPt = dots2pt(barcodePendente.altura);
          let cursor = x;
          let barra = true;
          for (const largura of elementos) {
            const larguraDots = largura * byLargura;
            if (barra) pagina.retangulo(dots2pt(cursor), dots2pt(y), dots2pt(larguraDots), alturaPt);
            cursor += larguraDots;
            barra = !barra;
          }
          if (barcodePendente.linhaTexto) {
            pagina.texto(dots2pt(x), dots2pt(y + barcodePendente.altura) + 9, dado, { tamanho: 8 });
          }
          barcodePendente = null;
        } else {
          const tamanhoPt = Math.max(5, dots2pt(alturaFonte) * 0.95);
          // ^FB quebra o texto na largura pedida. Sem ele, texto longo vazava
          // para fora da etiqueta e sumia na impressão.
          if (blocoLargura) {
            const larguraPt = dots2pt(blocoLargura);
            const porLinha = Math.max(8, Math.floor(larguraPt / (tamanhoPt * 0.5)));
            const palavras = dado.split(/\s+/);
            let linha = '';
            let linhaY = y + alturaFonte;
            for (const p of palavras) {
              if ((`${linha} ${p}`).trim().length > porLinha && linha) {
                pagina.texto(dots2pt(x), dots2pt(linhaY), linha, { tamanho: tamanhoPt, negrito: inverso });
                linha = p; linhaY += alturaFonte * 1.15;
              } else linha = (`${linha} ${p}`).trim();
            }
            if (linha) pagina.texto(dots2pt(x), dots2pt(linhaY), linha, { tamanho: tamanhoPt, negrito: inverso });
            blocoLargura = null;
          } else {
            pagina.texto(dots2pt(x), dots2pt(y + alturaFonte), dado, { tamanho: tamanhoPt, negrito: inverso });
          }
        }
        inverso = false;
        break;
      }
      default:
        break;
    }
  }
}

// Converte ZPL em PDF. `dpmm` é a densidade da impressora que GEROU o ZPL
// (8 = 203dpi, o padrão de etiqueta de transporte).
function zplParaPdf(zpl, { dpmm = 8, larguraMm = 101.6, alturaMm = 152.4 } = {}) {
  const info = analisar(zpl);
  if (info.etiquetas === 0) {
    throw Object.assign(new Error('Não encontrei nenhuma etiqueta no arquivo (falta ^XA ... ^XZ).'), { status: 400 });
  }

  const dots2pt = (d) => (Number(d) || 0) / dpmm / 25.4 * 72;
  const larguraPt = larguraMm / 25.4 * 72;
  const alturaPt = alturaMm / 25.4 * 72;

  const doc = new DocumentoPdf();
  for (const et of separarEtiquetas(zpl)) {
    const pagina = doc.novaPagina(larguraPt, alturaPt);
    desenharEtiqueta(pagina, separarComandos(et), { dots2pt, larguraDots: larguraMm * dpmm });
  }

  return { pdf: doc.buffer(), info };
}

module.exports = { zplParaPdf, analisar, codificarCode128, separarEtiquetas };
