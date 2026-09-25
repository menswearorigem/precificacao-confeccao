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

// ---------------------------------------------------------------------------
// Texto: ^FH, fonte 0 e negrito por impressão dupla
// ---------------------------------------------------------------------------
// Três coisas que a etiqueta do Mercado Livre faz e que o render antigo não
// entendia — e que juntas deixavam a etiqueta ilegível (25/09/2026):
//
// 1. `^FH` liga o escape hexadecimal: `B_C3_A1sica` são os bytes UTF-8 de
//    "Básica", e `_2D` é o hífen. Sem decodificar, saía o código cru.
// 2. A fonte 0 é CONDENSADA. Desenhar com Helvetica de largura normal faz a
//    linha do SKU passar da borda e ser cortada.
// 3. Negrito em ZPL é o mesmo texto impresso duas vezes, deslocado em poucos
//    pontos. Se as duas cópias caem em alturas diferentes, o código vira
//    "NODP35698" escrito por cima de si mesmo. Aqui as duas cópias viram UM
//    texto em negrito.

// Proporções da fonte 0 medidas contra a Labelary: a altura de maiúscula é
// ~75% da célula (^A0N,h), e ela é NEGRITO condensado — a Helvetica-Bold a
// 80% da largura dá a mesma medida de linha. As fontes de bitmap (A–H) são
// finas e mais largas: Helvetica normal a 100%.
const FONTE0_BASE = 0.75;
const FONTE0_CORPO = 1.045;
const LARGURA_POR_FONTE = { 0: 80 };

function decodificarHex(dado, escape) {
  if (!escape) return dado;
  const esc = escape.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`${esc}[0-9A-Fa-f]{2}`).test(dado)) return dado;
  const bytes = [];
  const re = new RegExp(`${esc}([0-9A-Fa-f]{2})|([\\s\\S])`, 'g');
  let m;
  while ((m = re.exec(dado))) {
    if (m[1]) bytes.push(parseInt(m[1], 16));
    else bytes.push(...Buffer.from(m[2], 'utf8'));
  }
  const buf = Buffer.from(bytes);
  // ^CI28 (UTF-8) é o que o Mercado Livre manda. Se os bytes não formarem
  // UTF-8 válido, a etiqueta veio na página de código antiga (Latin-1).
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return buf.toString('latin1'); }
}

// Renderiza UMA etiqueta numa página.
function desenharEtiqueta(pagina, comandos, { dots2pt, larguraDots }) {
  let x = 0; let y = 0; let modoPos = 'FO';
  let homeX = 0; let homeY = 0;
  let alturaFonte = 20; let larguraFonte = 0; let fonte = '0';
  let byLargura = 2; let byAltura = 40;
  let barcodePendente = null;
  let bloco = null;
  let inverso = false;
  let escapeHex = null;
  const textos = [];

  const num = (v, padrao = 0) => {
    const s = String(v ?? '').trim();
    if (s === '') return padrao;
    const n = Number(s);
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
        // ^FO posiciona pelo TOPO; ^FT pela LINHA DE BASE. A conversão fica
        // para a hora do ^FD, quando a fonte do campo já é conhecida — o ^A
        // costuma vir DEPOIS do ^FT.
        x = homeX + num(partes[0]);
        y = homeY + num(partes[1]);
        modoPos = c.nome;
        break;
      case 'A':
      case 'A0':
      case 'AD':
      case 'AA':
      case 'AB':
      case 'AC':
      case 'AE':
      case 'AF':
      case 'AG':
      case 'AH': {
        // ^A0N,altura,largura
        fonte = c.nome === 'A' ? (c.args.trim()[0] || '0').toUpperCase() : c.nome[1];
        const p = c.args.replace(/^[0-9A-Z]/i, '').split(',');
        alturaFonte = num(p[1], alturaFonte) || alturaFonte;
        larguraFonte = num(p[2], 0);
        break;
      }
      case 'CF':
        fonte = (partes[0] || fonte).trim().toUpperCase() || fonte;
        alturaFonte = num(partes[1], alturaFonte) || alturaFonte;
        larguraFonte = num(partes[2], larguraFonte);
        break;
      case 'FH':
        escapeHex = (c.args.trim()[0]) || '_';
        break;
      case 'BY':
        byLargura = num(partes[0], byLargura) || byLargura;
        byAltura = num(partes[2], byAltura) || byAltura;
        break;
      case 'BC':
        barcodePendente = {
          altura: num(partes[1], byAltura) || byAltura,
          linhaTexto: String(partes[2] || 'Y').trim().toUpperCase() !== 'N',
        };
        break;
      case 'FB':
        bloco = {
          largura: num(partes[0], 0),
          linhas: Math.max(1, num(partes[1], 1)),
          espaco: num(partes[2], 0),
          alinhamento: String(partes[3] || 'L').trim().toUpperCase(),
        };
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
        const dado = decodificarHex(c.args.replace(/\^FS.*$/i, ''), escapeHex);
        if (barcodePendente) {
          const elementos = codificarCode128(dado);
          const topo = modoPos === 'FT' ? y - barcodePendente.altura : y;
          const alturaPt = dots2pt(barcodePendente.altura);
          let cursor = x;
          let barra = true;
          for (const largura of elementos) {
            const larguraBarra = largura * byLargura;
            if (barra) pagina.retangulo(dots2pt(cursor), dots2pt(topo), dots2pt(larguraBarra), alturaPt);
            cursor += larguraBarra;
            barra = !barra;
          }
          if (barcodePendente.linhaTexto) {
            // Centralizado embaixo das barras, como a impressora faz.
            const tam = 9;
            const meio = dots2pt(x + (cursor - x) / 2);
            textos.push({
              xPt: meio, baseDots: topo + barcodePendente.altura, extraPt: tam + 2,
              texto: dado, tamanho: tam, escala: 100, centro: true,
            });
          }
          barcodePendente = null;
        } else {
          const tamanho = Math.max(5, dots2pt(alturaFonte) * FONTE0_CORPO);
          const proporcao = larguraFonte > 0 ? larguraFonte / alturaFonte : 1;
          const larguraBase = LARGURA_POR_FONTE[fonte] ?? 100;
          const escala = Math.min(130, Math.max(45, larguraBase * proporcao));
          const base = modoPos === 'FT' ? y : y + alturaFonte * FONTE0_BASE;
          textos.push({
            x, baseDots: base, texto: dado, tamanho, escala, negrito: inverso || fonte === '0',
            alturaDots: alturaFonte, bloco,
          });
          bloco = null;
        }
        inverso = false;
        escapeHex = null;
        break;
      }
      case 'FS':
        escapeHex = null;
        bloco = null;
        barcodePendente = null;
        break;
      default:
        break;
    }
  }

  escreverTextos(pagina, textos, { dots2pt, larguraDots });
}

// Junta as cópias do "negrito por impressão dupla" e escreve cada texto
// cabendo na etiqueta.
function escreverTextos(pagina, textos, { dots2pt, larguraDots }) {
  const { larguraTexto } = require('./pdfMinimo');
  const TOL_X = 10; const TOL_Y = 14; // em pontos da impressora (~1,3 mm e ~1,8 mm)

  const finais = [];
  for (const t of textos) {
    const gemeo = finais.find((f) => f.texto === t.texto && !f.centro === !t.centro
      && Math.abs((f.x ?? 0) - (t.x ?? 0)) <= TOL_X && Math.abs(f.baseDots - t.baseDots) <= TOL_Y
      && (t.centro ? Math.abs(f.xPt - t.xPt) < 4 : true));
    if (gemeo) { gemeo.negrito = true; gemeo.reforco = true; continue; }
    finais.push({ ...t });
  }
  // Um texto solto que repete a linha legível do código de barras (o ML
  // imprime o código embaixo, à mão, em negrito) também conta como a mesma.
  for (const t of finais) {
    if (!t.centro) continue;
    const manual = finais.find((f) => !f.centro && f.texto === t.texto
      && f.baseDots > t.baseDots - 10 && f.baseDots < t.baseDots + 80);
    if (manual) t.descartar = true;
  }

  const margemPt = 6;
  const larguraPaginaPt = dots2pt(larguraDots);

  for (const t of finais) {
    if (t.descartar) continue;
    if (t.centro) {
      const w = larguraTexto(t.texto, t.tamanho, false);
      pagina.texto(t.xPt - w / 2, dots2pt(t.baseDots) + t.extraPt, t.texto, { tamanho: t.tamanho, negrito: true });
      continue;
    }

    const xPt = dots2pt(t.x);
    const disponivel = t.bloco && t.bloco.largura > 0
      ? dots2pt(t.bloco.largura)
      : Math.max(20, larguraPaginaPt - xPt - Math.max(margemPt, Math.min(xPt, 18)));

    // Encolhe a LARGURA antes do corpo: a letra continua alta e legível, só
    // mais estreita. Abaixo de 60% passa a reduzir o corpo também.
    const cabe = (texto, tamanho, escala) => larguraTexto(texto, tamanho, t.negrito) * (escala / 100);

    if (t.bloco) {
      const linhas = quebrarLinhas(t.texto, (s) => cabe(s, t.tamanho, t.escala), disponivel);
      const maxLinhas = t.bloco.linhas;
      const usadas = linhas.slice(0, maxLinhas);
      if (linhas.length > maxLinhas) {
        // ZPL descarta o que passa do número de linhas; aqui a última linha
        // leva o resto, espremida, para não sumir informação.
        usadas[maxLinhas - 1] = linhas.slice(maxLinhas - 1).join(' ');
      }
      const passo = dots2pt(t.alturaDots + t.bloco.espaco);
      usadas.forEach((linha, i) => {
        const { escala, tamanho } = ajustar(linha, t.tamanho, t.escala, disponivel, cabe);
        const w = cabe(linha, tamanho, escala);
        let lx = xPt;
        if (t.bloco.alinhamento === 'C') lx = xPt + (disponivel - w) / 2;
        else if (t.bloco.alinhamento === 'R') lx = xPt + disponivel - w;
        pagina.texto(lx, dots2pt(t.baseDots) + passo * i, linha, { tamanho, negrito: t.negrito, escalaH: escala, reforco: t.reforco });
      });
      continue;
    }

    const { escala, tamanho } = ajustar(t.texto, t.tamanho, t.escala, disponivel, cabe);
    pagina.texto(xPt, dots2pt(t.baseDots), t.texto, { tamanho, negrito: t.negrito, escalaH: escala, reforco: t.reforco });
  }
}

function ajustar(texto, tamanho, escala, disponivel, cabe) {
  let e = escala; let tam = tamanho;
  const w = cabe(texto, tam, e);
  if (w <= disponivel) return { escala: e, tamanho: tam };
  e = Math.max(60, e * (disponivel / w));
  const w2 = cabe(texto, tam, e);
  if (w2 > disponivel) tam = Math.max(4, tam * (disponivel / w2));
  return { escala: e, tamanho: tam };
}

function quebrarLinhas(texto, medir, largura) {
  const palavras = String(texto).split(/\s+/).filter(Boolean);
  const linhas = [];
  let linha = '';
  for (const p of palavras) {
    const tentativa = linha ? `${linha} ${p}` : p;
    if (linha && medir(tentativa) > largura) { linhas.push(linha); linha = p; }
    else linha = tentativa;
  }
  if (linha) linhas.push(linha);
  return linhas.length ? linhas : [''];
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

module.exports = { zplParaPdf, analisar, codificarCode128, separarEtiquetas, decodificarHex };
