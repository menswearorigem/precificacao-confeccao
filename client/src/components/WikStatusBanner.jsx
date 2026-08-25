import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { api } from '../api/client';

// Limiar pra considerar a sincronização "parada" — o ciclo automático roda a
// cada 15min (ver WIK_SYNC_INTERVAL_MS em index.js), então passar disso é
// sinal de algo errado (processo dormindo no plano gratuito do Render,
// token travado etc.), não só uma demora normal.
const HORAS_LIMITE = 1;

function horasDesde(dataIso) {
  if (!dataIso) return Infinity;
  return (Date.now() - new Date(dataIso).getTime()) / (1000 * 60 * 60);
}

function formatarTempo(horas) {
  if (horas < 1) return `${Math.round(horas * 60)} minuto(s)`;
  if (horas < 48) return `${Math.round(horas)} hora(s)`;
  return `${Math.round(horas / 24)} dia(s)`;
}

function SincronizarReferenciasModal({ onClose, onSincronizado }) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');

  async function sincronizar() {
    const referencias = texto.split(/[\n,]/).map((r) => r.trim()).filter(Boolean);
    if (referencias.length === 0) return;
    setEnviando(true);
    setErro('');
    setResultado(null);
    try {
      const data = await api.post('/estoque/wik-sincronizar-referencias', { referencias });
      setResultado(data);
      onSincronizado?.();
    } catch (err) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="card" style={{ maxWidth: 480, width: '92%' }}>
        <div className="card-head-linha">
          <div className="card-head">Sincronizar referências específicas agora</div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Uma referência por linha (ou separadas por vírgula). Busca o saldo de todas as empresas configuradas no Wik
          e aplica só nas referências listadas — não mexe em mais nada do catálogo.
        </p>
        <textarea
          rows={5}
          style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
          placeholder={'OG1192\nOG1620\nMM6387'}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
        {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
        {resultado && (
          <div className="aviso-compacto tone-saudavel" style={{ marginTop: 10 }}>
            {resultado.criados} variante(s) criada(s), {resultado.atualizados} atualizada(s).
            {resultado.referenciasEncontradas.length > 0
              ? ` Referências encontradas no Wik: ${resultado.referenciasEncontradas.join(', ')}.`
              : ' Nenhuma dessas referências apareceu no saldo do Wik agora.'}
          </div>
        )}
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={sincronizar} disabled={enviando || !texto.trim()}>
          {enviando ? 'Sincronizando…' : 'Sincronizar agora'}
        </button>
      </div>
    </div>
  );
}

// Aviso visível quando a sincronização de estoque com o Wik Sistemas está
// atrasada ou deu erro — sem isso, um problema (token expirado, integração
// desconectada) pode passar dias sem ninguém perceber, porque o saldo
// simplesmente para de atualizar em silêncio. Também dispara a
// sincronização oportunista ao carregar a tela (ver sincronizarEstoqueSeNecessario
// em wikSync.js) — o próprio GET /estoque/wik-status já tenta de novo sozinho.
export default function WikStatusBanner() {
  const [status, setStatus] = useState(null);
  const [modalAberto, setModalAberto] = useState(false);

  function carregar() {
    api.get('/estoque/wik-status').then(setStatus).catch(() => {});
  }

  useEffect(() => { carregar(); }, []);

  if (!status || !status.configurado || !status.ativo) return null;

  const horas = horasDesde(status.ultimaSincronizacao);
  const parado = horas > HORAS_LIMITE;
  if (!status.ultimoErro && !parado) return null;

  return (
    <>
      <div className="aviso-compacto tone-atencao no-print" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {status.ultimoErro ? (
              <>Sincronização com o Wik Sistemas com erro: <strong>{status.ultimoErro}</strong></>
            ) : (
              <>Sincronização com o Wik Sistemas parada há {formatarTempo(horas)}</>
            )}
            {status.ultimaSincronizacao && (
              <> — última sincronização bem-sucedida em {new Date(status.ultimaSincronizacao).toLocaleString('pt-BR')}.</>
            )}
          </span>
        </div>
        <button type="button" className="btn btn-ghost" style={{ flexShrink: 0 }} onClick={() => setModalAberto(true)}>
          <RefreshCw size={13} /> Sincronizar referências
        </button>
      </div>
      {modalAberto && (
        <SincronizarReferenciasModal onClose={() => setModalAberto(false)} onSincronizado={carregar} />
      )}
    </>
  );
}
