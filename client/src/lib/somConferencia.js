// Retorno sonoro da Conferência de Pedidos.
//
// Por que isso existe: quem confere está de costas pra tela, com as duas mãos
// ocupadas e um leitor de código de barras na mão. O som é o retorno de
// verdade — a tela é confirmação depois. Foi a parte mais bem resolvida da
// ferramenta antiga da dona e é por isso que veio junto.
//
// Os dois sons são desenhados pra serem distinguíveis a três metros, num
// galpão barulhento, mesmo sem prestar atenção:
//   acerto → dois tons curtos SUBINDO (C6 → G6), timbre limpo
//   erro   → um tom grave DESCENDO, timbre áspero (dente de serra)
// Subir/descer é o que o ouvido pega primeiro, antes até de reconhecer a
// nota; é o mesmo princípio de caixa de supermercado.
//
// Sintetizado em Web Audio, sem arquivo de áudio: nenhum download, nenhuma
// dependência, e funciona offline. O navegador só deixa tocar depois de um
// gesto da pessoa — como o primeiro gesto é sempre bipar, na prática nunca
// atrapalha.

let contexto = null;

function pegarContexto() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!contexto) {
    try {
      contexto = new Ctor();
    } catch {
      return null;
    }
  }
  // Navegador suspende o áudio até haver interação; retomar é barato e não
  // faz nada quando já está rodando.
  if (contexto.state === 'suspended') contexto.resume().catch(() => {});
  return contexto;
}

function tocarNota(ctx, { frequenciaInicial, frequenciaFinal, inicio, duracao, tipo = 'sine', volume = 0.22 }) {
  const oscilador = ctx.createOscillator();
  const ganho = ctx.createGain();
  oscilador.type = tipo;
  oscilador.frequency.setValueAtTime(frequenciaInicial, inicio);
  if (frequenciaFinal && frequenciaFinal !== frequenciaInicial) {
    oscilador.frequency.exponentialRampToValueAtTime(frequenciaFinal, inicio + duracao);
  }
  // Ataque e queda suaves: onda cortada no meio estala no alto-falante.
  ganho.gain.setValueAtTime(0.0001, inicio);
  ganho.gain.exponentialRampToValueAtTime(volume, inicio + 0.012);
  ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + duracao);
  oscilador.connect(ganho);
  ganho.connect(ctx.destination);
  oscilador.start(inicio);
  oscilador.stop(inicio + duracao + 0.02);
}

export function somAcerto() {
  const ctx = pegarContexto();
  if (!ctx) return;
  const agora = ctx.currentTime;
  tocarNota(ctx, { frequenciaInicial: 1046.5, inicio: agora, duracao: 0.075, tipo: 'sine' }); // C6
  tocarNota(ctx, { frequenciaInicial: 1568.0, inicio: agora + 0.075, duracao: 0.11, tipo: 'sine' }); // G6
}

export function somErro() {
  const ctx = pegarContexto();
  if (!ctx) return;
  const agora = ctx.currentTime;
  tocarNota(ctx, { frequenciaInicial: 320, frequenciaFinal: 110, inicio: agora, duracao: 0.34, tipo: 'sawtooth', volume: 0.2 });
}

// Fim da caixa: acorde ascendente mais longo, claramente diferente do acerto
// de uma peça — é ele que diz "pode fechar e pegar a próxima".
export function somPedidoCompleto() {
  const ctx = pegarContexto();
  if (!ctx) return;
  const agora = ctx.currentTime;
  [783.99, 1046.5, 1318.5].forEach((hz, i) => { // G5 · C6 · E6
    tocarNota(ctx, { frequenciaInicial: hz, inicio: agora + i * 0.09, duracao: 0.16, tipo: 'triangle', volume: 0.24 });
  });
}
