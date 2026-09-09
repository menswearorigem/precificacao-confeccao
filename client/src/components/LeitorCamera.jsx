import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, X, RefreshCw, Zap, ZapOff, Keyboard } from 'lucide-react';
import { somAcerto, somErro } from '../lib/somConferencia';

// Leitor de código de barras pela câmera do celular (09/09/2026).
//
// POR QUE EXISTE: a venda de balcão e a de feira acontecem com o celular na
// mão, sem leitor de mesa. Digitar treze dígitos de EAN com o cliente
// esperando é onde nasce o item errado no pedido.
//
// COMO LÊ, em duas camadas:
//
//   1. `BarcodeDetector` — decodificador nativo do navegador (Chrome no
//      Android, Edge, Chrome no desktop). É o caminho bom: roda no
//      compilado do navegador, gasta pouca bateria e não baixa nada.
//   2. `@zxing/browser` — carregado SOB DEMANDA (nunca no bundle inicial,
//      igual ao que o sistema já faz com xlsx e jspdf) quando o nativo não
//      existe. É o caso do Safari do iPhone, que não tem BarcodeDetector.
//
// Se as duas falharem, a tela não fica muda: diz o que houve e oferece
// digitar o código à mão, que é o caminho que sempre funcionou.
//
// Sobre o retorno: o mesmo código lido duas vezes em menos de 1,8s é
// ignorado. Sem isso, uma etiqueta parada na frente da câmera lançava a
// mesma peça dez vezes por segundo — o erro de estoque mais caro que esta
// tela poderia causar.

const FORMATOS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code'];
const INTERVALO_MESMO_CODIGO_MS = 1800;

function vibrar(padrao) {
  try {
    if (navigator.vibrate) navigator.vibrate(padrao);
  } catch {
    /* vibração é enfeite: nunca pode derrubar a leitura */
  }
}

export default function LeitorCamera({
  aberto,
  onLer,
  onFechar,
  titulo = 'Bipar com a câmera',
  subtitulo = 'Aponte para o código de barras da etiqueta.',
  ultimaLeitura = null,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const pararRef = useRef(null);
  const ultimoCodigoRef = useRef({ codigo: '', em: 0 });

  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [motor, setMotor] = useState('');
  const [temLanterna, setTemLanterna] = useState(false);
  const [lanternaLigada, setLanternaLigada] = useState(false);
  const [cameraTraseira, setCameraTraseira] = useState(true);
  const [lidos, setLidos] = useState(0);

  const registrarLeitura = useCallback((codigoBruto) => {
    const codigo = String(codigoBruto || '').trim();
    if (!codigo) return;
    const agora = Date.now();
    const anterior = ultimoCodigoRef.current;
    if (anterior.codigo === codigo && agora - anterior.em < INTERVALO_MESMO_CODIGO_MS) return;
    ultimoCodigoRef.current = { codigo, em: agora };
    setLidos((n) => n + 1);
    vibrar(60);
    somAcerto();
    onLer(codigo);
  }, [onLer]);

  // Encerra tudo: laço de leitura, faixas de vídeo e o elemento.
  const encerrar = useCallback(() => {
    if (pararRef.current) {
      try { pararRef.current(); } catch { /* já parado */ }
      pararRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try { track.stop(); } catch { /* já parado */ }
      }
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setTemLanterna(false);
    setLanternaLigada(false);
  }, []);

  useEffect(() => {
    if (!aberto) { encerrar(); return undefined; }

    let cancelado = false;
    setErro('');
    setCarregando(true);
    setLidos(0);
    ultimoCodigoRef.current = { codigo: '', em: 0 };

    async function iniciar() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setErro('Este navegador não deixa a página usar a câmera. Dá para bipar com um leitor comum ou digitar o código.');
        setCarregando(false);
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: cameraTraseira ? { ideal: 'environment' } : { ideal: 'user' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (err) {
        // Mensagem por causa: "permissão negada" e "câmera ocupada" pedem
        // ações diferentes de quem está com o celular na mão.
        const nome = err?.name || '';
        if (nome === 'NotAllowedError' || nome === 'SecurityError') {
          setErro('O navegador bloqueou a câmera. Toque no cadeado da barra de endereço e permita a câmera para este site.');
        } else if (nome === 'NotFoundError' || nome === 'OverconstrainedError') {
          setErro('Não achei uma câmera nesse aparelho.');
        } else if (nome === 'NotReadableError') {
          setErro('A câmera está ocupada por outro aplicativo. Feche o outro app e tente de novo.');
        } else {
          setErro(`Não deu para abrir a câmera: ${err?.message || nome || 'erro desconhecido'}`);
        }
        setCarregando(false);
        return;
      }
      if (cancelado) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // `playsInline` é o que impede o iPhone de abrir o vídeo em tela
        // cheia própria e engolir a interface.
        videoRef.current.setAttribute('playsinline', 'true');
        try { await videoRef.current.play(); } catch { /* autoplay bloqueado: o usuário toca na tela */ }
      }

      const track = stream.getVideoTracks()[0];
      try {
        const capacidades = track.getCapabilities ? track.getCapabilities() : {};
        setTemLanterna(Boolean(capacidades.torch));
      } catch { /* nem todo navegador expõe capacidades */ }

      // Camada 1 — decodificador nativo.
      if ('BarcodeDetector' in window) {
        try {
          const suportados = await window.BarcodeDetector.getSupportedFormats();
          const formatos = FORMATOS.filter((f) => suportados.includes(f));
          const detector = new window.BarcodeDetector({ formats: formatos.length > 0 ? formatos : undefined });
          setMotor('nativo');
          setCarregando(false);
          let rodando = true;
          pararRef.current = () => { rodando = false; };
          const laco = async () => {
            while (rodando && !cancelado) {
              try {
                if (videoRef.current && videoRef.current.readyState >= 2) {
                  const codigos = await detector.detect(videoRef.current);
                  if (codigos.length > 0) registrarLeitura(codigos[0].rawValue);
                }
              } catch { /* quadro ruim: o próximo resolve */ }
              // 8 leituras por segundo: rápido para a mão humana, leve para
              // a bateria.
              await new Promise((r) => setTimeout(r, 125));
            }
          };
          laco();
          return;
        } catch { /* cai para o ZXing abaixo */ }
      }

      // Camada 2 — ZXing sob demanda.
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        if (cancelado) return;
        const leitor = new BrowserMultiFormatReader();
        setMotor('zxing');
        setCarregando(false);
        const controles = await leitor.decodeFromStream(stream, videoRef.current, (resultado) => {
          if (resultado) registrarLeitura(resultado.getText());
        });
        // Se o leitor foi fechado ENQUANTO este await estava pendente, o
        // cleanup já rodou com pararRef vazio: sem esta checagem, o
        // decodificador ficaria rodando e o pararRef desta sessão morta
        // sobreviveria para a próxima — que então pararia a sessão errada.
        if (cancelado) { try { controles.stop(); } catch { /* já parado */ } return; }
        pararRef.current = () => { try { controles.stop(); } catch { /* já parado */ } };
      } catch (err) {
        setMotor('');
        setCarregando(false);
        setErro(
          'Este navegador não consegue ler código de barras pela câmera. '
          + 'No celular, o Chrome (Android) costuma funcionar. Enquanto isso, dá para digitar o código no campo ao lado.'
        );
        somErro();
        console.error('Leitor de câmera indisponível:', err);
      }
    }

    iniciar();
    return () => { cancelado = true; encerrar(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, cameraTraseira]);

  async function alternarLanterna() {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !lanternaLigada }] });
      setLanternaLigada((v) => !v);
    } catch {
      setTemLanterna(false);
    }
  }

  if (!aberto) return null;

  return createPortal(
    <div className="leitor-camera" role="dialog" aria-label={titulo}>
      <div className="leitor-camera-topo">
        <div className="leitor-camera-titulo">
          <Camera size={16} />
          <div>
            <strong>{titulo}</strong>
            <span>{subtitulo}</span>
          </div>
        </div>
        <button type="button" className="leitor-camera-fechar" onClick={onFechar} aria-label="Fechar leitor">
          <X size={20} />
        </button>
      </div>

      <div className="leitor-camera-palco">
        <video ref={videoRef} className="leitor-camera-video" muted playsInline autoPlay />
        <div className="leitor-camera-mira" aria-hidden="true">
          <span /><span /><span /><span />
        </div>
        {carregando && <p className="leitor-camera-aviso">Abrindo a câmera…</p>}
        {erro && (
          <div className="leitor-camera-erro" role="alert">
            <p>{erro}</p>
            <button type="button" className="btn btn-ghost" onClick={onFechar}>
              <Keyboard size={14} /> Digitar o código
            </button>
          </div>
        )}
      </div>

      <div className="leitor-camera-rodape">
        <div className="leitor-camera-status">
          {lidos > 0 && <span className="selo tone-saudavel">{lidos} {lidos === 1 ? 'peça bipada' : 'peças bipadas'}</span>}
          {ultimaLeitura && <span className="leitor-camera-ultima mono">{ultimaLeitura}</span>}
          {!ultimaLeitura && !erro && !carregando && (
            <span className="leitor-camera-dica">
              {motor === 'zxing' ? 'Leitor compatível ativo — segure firme por um instante.' : 'Aproxime até o código preencher a moldura.'}
            </span>
          )}
        </div>
        <div className="leitor-camera-acoes">
          {temLanterna && (
            <button type="button" className="btn btn-ghost" onClick={alternarLanterna}>
              {lanternaLigada ? <ZapOff size={14} /> : <Zap size={14} />}
              {lanternaLigada ? 'Apagar' : 'Lanterna'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setCameraTraseira((v) => !v)}>
            <RefreshCw size={14} /> Virar
          </button>
          <button type="button" className="btn btn-primary" onClick={onFechar}>Concluir</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
