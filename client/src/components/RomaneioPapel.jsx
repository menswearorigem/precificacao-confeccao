import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Truck, ClipboardList, AlertTriangle, Check, X, Plus, Printer, Undo2, Ban, FileText, PackageCheck,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, CampoBusca, Checkbox, Paginacao } from './ui';
import { useTabela } from '../lib/useTabela';
import { confirmar } from './ConfirmDialog';
import { formatQtd, tempoRelativo, plural } from '../lib/format';
import { CanalMarketplace } from '../lib/canalMarketplace';

// O romaneio de papel — o documento que o motorista assina (28/09/2026).
//
// Até a 0094 este papel era o ÚNICO jeito de parar o relógio da coleta, e
// por isso a tela inteira dependia dele. Agora a saída do pedido vem da
// plataforma; o romaneio continua existindo como era (escolha do dono em
// 28/09/2026: "manter como está"), só que numa sub-aba própria.
//
// ⚠️ O código de rastreio é congelado quando o pedido entra no romaneio: o
// pedido pode ser reetiquetado depois, e o papel assinado tem que continuar
// dizendo o que dizia.

const BASE = '/romaneios';
const SITUACOES = { aberto: 'Aberto', fechado: 'Fechado', coletado: 'Coletado', cancelado: 'Cancelado' };
const mensagem = (e) => e?.data?.error || e?.data?.erro || e?.message || 'Erro inesperado.';
const ouTraco = (v) => (v === null || v === undefined || v === '' ? '—' : v);

export default function RomaneioPapel({ pendentesTodos = [], indiceLojas, aoMudar }) {
  const [romaneios, setRomaneios] = useState([]);
  const [aberto, setAberto] = useState(null);
  const [situacao, setSituacao] = useState('');
  const [busca, setBusca] = useState('');
  const [selecionados, setSelecionados] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const [avisos, setAvisos] = useState([]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try { setRomaneios(await api.get(`${BASE}${situacao ? `?situacao=${situacao}` : ''}`)); }
    catch (e) { setErro(mensagem(e)); } finally { setCarregando(false); }
  }, [situacao]);
  useEffect(() => { carregar(); }, [carregar]);

  const pendentes = useMemo(() => {
    const alvo = busca.trim().toLowerCase();
    return pendentesTodos
      .filter((i) => !i.romaneio_id)
      .filter((i) => !alvo || [i.numero, i.origem_pedido_id, i.loja, (i.codigos_rastreio || []).join(' ')]
        .some((c) => String(c || '').toLowerCase().includes(alvo)));
  }, [pendentesTodos, busca]);

  const tabela = useTabela(pendentes, {
    colunas: { numero: (i) => Number(i.numero || 0), prazo: (i) => i.coletar_ate || '' },
    colunaPadrao: 'prazo', prefixo: 'papel',
  });

  async function abrir(id) {
    setErro('');
    try { setAberto(await api.get(`${BASE}/${id}`)); } catch (e) { setErro(mensagem(e)); }
  }

  async function novoRomaneio() {
    setErro(''); setSucesso('');
    try {
      const r = await api.post(BASE, { transportadora: null, canal: null });
      await abrir(r.id);
      setSucesso(`Romaneio ${r.numero} criado. Marque os pedidos e feche para imprimir.`);
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function acrescentar() {
    if (!aberto || selecionados.length === 0) return;
    setErro(''); setSucesso(''); setAvisos([]);
    try {
      const r = await api.post(`${BASE}/${aberto.romaneio.id}/pedidos`, {
        pedidos: selecionados.map((id) => ({ pedido_id: id })),
      });
      setSelecionados([]);
      setSucesso(`${plural(r.entraram.length, 'pedido')} no romaneio.`);
      // Os recusados sobem um por um, com o motivo.
      setAvisos(r.recusados.map((x) => `Pedido ${x.numero ?? x.pedidoId}: ${x.motivo}`));
      await abrir(aberto.romaneio.id);
      carregar(); aoMudar?.();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function acao(tipo) {
    const r = aberto.romaneio;
    setErro(''); setSucesso(''); setAvisos([]);
    try {
      if (tipo === 'fechar') {
        const ok = await confirmar(
          'Fechar é imprimir: depois disto o romaneio não recebe mais pedido, porque o papel na mão do '
          + 'motorista não pode discordar do sistema. Dá para reabrir enquanto ninguém coletou.',
          { titulo: `Fechar o romaneio ${r.numero}?`, confirmarTexto: 'Fechar', perigo: false }
        );
        if (!ok) return;
        await api.post(`${BASE}/${r.id}/fechar`);
        setSucesso('Fechado. O papel já pode ser impresso.');
      }
      if (tipo === 'reabrir') {
        const motivo = window.prompt('Por que está reabrindo?');
        if (!motivo) return;
        await api.post(`${BASE}/${r.id}/reabrir`, { motivo });
        setSucesso('Reaberto.');
      }
      if (tipo === 'coletar') {
        const motorista = window.prompt('Nome de quem está levando:');
        if (!motorista) return;
        const placa = window.prompt('Placa do veículo (opcional):') || '';
        await api.post(`${BASE}/${r.id}/coletar`, { motorista, placa });
        setSucesso('Coleta registrada no papel.');
      }
      if (tipo === 'cancelar') {
        const motivo = window.prompt('Motivo do cancelamento:');
        if (!motivo) return;
        await api.post(`${BASE}/${r.id}/cancelar`, { motivo });
        setSucesso('Cancelado. Os pedidos voltaram a poder entrar em outro romaneio.');
      }
      await abrir(r.id);
      carregar(); aoMudar?.();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function tirar(pedidoId) {
    const motivo = window.prompt('Por que este pedido está saindo do romaneio?');
    if (!motivo) return;
    setErro('');
    try {
      await api.post(`${BASE}/${aberto.romaneio.id}/pedidos/${pedidoId}/liberar`, { motivo });
      await abrir(aberto.romaneio.id);
      carregar(); aoMudar?.();
    } catch (e) { setErro(mensagem(e)); }
  }

  const noRomaneio = (aberto?.itens || []).filter((i) => !i.liberado_em);
  const liberados = (aberto?.itens || []).filter((i) => i.liberado_em);
  const podeMandar = aberto && aberto.romaneio.situacao === 'aberto';

  return (
    <>
      <div className="exp-barra">
        <p className="ink-soft">O papel que o motorista assina. É opcional: a saída do pedido já vem da plataforma.</p>
        <button type="button" className="btn btn-primary" onClick={novoRomaneio}><Plus size={15} /> Novo romaneio</button>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}
      {sucesso && <p className="sucesso-inline"><Check size={14} /> {sucesso}</p>}
      {avisos.map((a, i) => <p className="aviso-inline" key={i}><AlertTriangle size={14} /> {a}</p>)}

      {aberto && (
        <div className="card">
          <div className="card-head-linha">
            <h2 className="card-titulo">
              <ClipboardList size={16} /> Romaneio {aberto.romaneio.numero}
              <span className="stamp sm tone-neutro">{SITUACOES[aberto.romaneio.situacao]}</span>
            </h2>
            <div className="painel-acoes-inline">
              {aberto.romaneio.situacao === 'aberto' && (
                <button type="button" className="btn btn-primary" onClick={() => acao('fechar')}><Check size={15} /> Fechar</button>
              )}
              {aberto.romaneio.situacao === 'fechado' && (
                <>
                  <a className="btn btn-primary" href={`/api${BASE}/${aberto.romaneio.id}/pdf`} target="_blank" rel="noreferrer"><Printer size={15} /> Imprimir</a>
                  <button type="button" className="btn btn-ghost" onClick={() => acao('coletar')}><Truck size={15} /> Registrar coleta</button>
                  <button type="button" className="btn btn-ghost" onClick={() => acao('reabrir')}><Undo2 size={15} /> Reabrir</button>
                </>
              )}
              {aberto.romaneio.situacao === 'coletado' && (
                <a className="btn btn-ghost" href={`/api${BASE}/${aberto.romaneio.id}/pdf`} target="_blank" rel="noreferrer"><FileText size={15} /> Ver o papel</a>
              )}
              {['aberto', 'fechado'].includes(aberto.romaneio.situacao) && (
                <button type="button" className="btn btn-danger" onClick={() => acao('cancelar')}><Ban size={15} /> Cancelar</button>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setAberto(null)}><X size={15} /> Fechar tela</button>
            </div>
          </div>
          <p className="ink-soft">
            {plural(noRomaneio.length, 'pedido')} · {formatQtd(noRomaneio.reduce((s, i) => s + Number(i.volumes || 1), 0))} volume(s)
            {aberto.romaneio.coletado_em && (
              <> · levado por <strong>{ouTraco(aberto.romaneio.motorista)}</strong>
                {aberto.romaneio.placa ? ` (${aberto.romaneio.placa})` : ''} {tempoRelativo(aberto.romaneio.coletado_em)}</>
            )}
          </p>
          {Number(aberto.romaneio.sem_rastreio) > 0 && (
            <p className="aviso-inline">
              <AlertTriangle size={14} /> {plural(aberto.romaneio.sem_rastreio, 'pedido')} sem código de rastreio.
              Eles vão para o papel escritos como <strong>SEM RASTREIO</strong>.
            </p>
          )}
          {noRomaneio.length === 0 && (
            <EstadoVazio Icone={ClipboardList} titulo="Romaneio vazio" descricao="Marque pedidos na lista abaixo e mande para cá." />
          )}
          {noRomaneio.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead><tr><th className="num">Pedido</th><th>Canal</th><th>Rastreio (congelado)</th><th className="num">Volumes</th><th /></tr></thead>
                <tbody>
                  {noRomaneio.map((i) => (
                    <tr key={i.id}>
                      <td className="num">{i.pedido_numero}</td>
                      <td>{ouTraco(i.origem_marketplace || i.canal_venda)}</td>
                      <td className={i.codigo_rastreio ? '' : 'tone-prejuizo'}>{i.codigo_rastreio || 'SEM RASTREIO'}</td>
                      <td className="num">{i.volumes}</td>
                      <td className="num">
                        {aberto.romaneio.situacao === 'aberto' && (
                          <button type="button" className="btn btn-ghost" onClick={() => tirar(i.pedido_id)}>Tirar</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {liberados.length > 0 && (
            <>
              <p className="ink-soft">Saíram deste romaneio ({liberados.length}). A linha fica no histórico de propósito:</p>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead><tr><th className="num">Pedido</th><th>Quando</th><th>Por quê</th></tr></thead>
                  <tbody>
                    {liberados.map((i) => (
                      <tr key={i.id}>
                        <td className="num">{i.pedido_numero}</td>
                        <td>{tempoRelativo(i.liberado_em)}</td>
                        <td className="ink-soft">{ouTraco(i.liberado_motivo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2 className="card-titulo"><PackageCheck size={16} /> Esperando coleta, fora de romaneio</h2>
        <div className="exp-barra">
          <CampoBusca valor={busca} onChange={setBusca} placeholder="Pedido, loja ou rastreio" />
          <button type="button" className="btn btn-primary" onClick={acrescentar} disabled={!podeMandar || selecionados.length === 0}>
            <Plus size={15} /> Mandar {selecionados.length || ''} para o romaneio{aberto ? ` ${aberto.romaneio.numero}` : ''}
          </button>
        </div>
        {!aberto && <p className="ink-soft">Abra ou crie um romaneio para poder mandar pedidos.</p>}
        {pendentes.length === 0 && <EstadoVazio Icone={PackageCheck} titulo="Nada esperando coleta" descricao="Todo pedido pendente já está num romaneio." />}
        {pendentes.length > 0 && (
          <>
            <Paginacao {...tabela} posicao="topo" />
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead><tr><th /><th className="num">Pedido</th><th>Loja</th><th>Prazo da plataforma</th><th>Rastreio</th></tr></thead>
                <tbody>
                  {tabela.itensPagina.map((i) => (
                    <tr key={i.pedido_id}>
                      <td>
                        <Checkbox
                          checked={selecionados.includes(i.pedido_id)}
                          onChange={(e) => setSelecionados(e.target.checked
                            ? [...selecionados, i.pedido_id]
                            : selecionados.filter((x) => x !== i.pedido_id))}
                        />
                      </td>
                      <td className="num">{i.origem_pedido_id || i.numero}</td>
                      <td><CanalMarketplace registro={{ canal_venda: i.canal, origem_integracao_id: i.origem_integracao_id }} indiceLojas={indiceLojas} /></td>
                      <td>{i.coletar_ate ? tempoRelativo(i.coletar_ate) : '—'}</td>
                      <td>{(i.codigos_rastreio || []).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Paginacao {...tabela} posicao="rodape" />
          </>
        )}
      </div>

      <div className="card">
        <h2 className="card-titulo"><Truck size={16} /> Romaneios</h2>
        <div className="exp-chips">
          {[['', 'Todos'], ...Object.entries(SITUACOES)].map(([k, v]) => (
            <button key={k || 'todos'} type="button" className={`exp-chip${situacao === k ? ' ativo' : ''}`} onClick={() => setSituacao(k)}>{v}</button>
          ))}
        </div>
        {carregando && <Skeleton height={120} />}
        {!carregando && romaneios.length === 0 && (
          <EstadoVazio Icone={ClipboardList} titulo="Nenhum romaneio" descricao="Crie um quando a transportadora pedir o papel assinado." />
        )}
        {!carregando && romaneios.length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th className="num">Nº</th><th>Situação</th><th className="num">Pedidos</th><th className="num">Volumes</th>
                  <th className="num">Sem rastreio</th><th>Quem levou</th><th>Quando</th></tr>
              </thead>
              <tbody>
                {romaneios.map((r) => (
                  <tr key={r.id} className="linha-clicavel" onClick={() => abrir(r.id)}>
                    <td className="num">{r.numero}</td>
                    <td><span className="stamp sm tone-neutro">{SITUACOES[r.situacao] || r.situacao}</span></td>
                    <td className="num">{formatQtd(r.pedidos)}</td>
                    <td className="num">{formatQtd(r.volumes)}</td>
                    <td className={`num ${Number(r.sem_rastreio) > 0 ? 'tone-prejuizo' : ''}`}>{formatQtd(r.sem_rastreio)}</td>
                    <td>{ouTraco(r.motorista)}</td>
                    <td>{tempoRelativo(r.coletado_em || r.fechado_em || r.criado_em)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
