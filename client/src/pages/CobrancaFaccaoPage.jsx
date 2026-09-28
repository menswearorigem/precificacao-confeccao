import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BellRing, RefreshCw, MessageCircle, Copy, Check, Phone, Clock, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton } from '../components/ui';
import { formatQtd, dataBr, tempoRelativo, plural } from '../lib/format';
import './Cobranca.css';

// Produção › Cobrança de facção (28/09/2026).
//
// Tudo que passou do prazo, agrupado por facção, com a mensagem pronta para o
// WhatsApp. Junta a O.S. atrasada (lote que saiu pelo Hub) e a OP vencida sem
// O.S. — que é o caso das OPs do Wik. Não cria tabela: "cobrei" fica na
// auditoria, para a tela dizer "cobrada há 3 dias" e ninguém cobrar duas
// vezes no mesmo dia sem saber.

const ROTA = '/producao-cobranca';
const FILTROS = [
  { valor: 0, rotulo: 'Todas' },
  { valor: 7, rotulo: 'Mais de 7 dias' },
  { valor: 30, rotulo: 'Mais de 30 dias' },
];

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

function montarMensagem(g) {
  const saud = g.contato ? `Olá, ${primeiroNome(g.contato)}! Tudo bem?` : `Olá, pessoal da ${g.nome}! Tudo bem?`;
  const linhas = g.itens.map((i) => {
    const qual = i.tipo === 'os' ? `O.S. ${i.os_numero} (OP ${i.op})` : `OP ${i.op}`;
    return `• ${qual} — ${i.referencia}: ${formatQtd(i.pendente)} peças, prazo era ${dataBr(i.prazo)} (${plural(i.dias_atraso, 'dia')} de atraso)`;
  });
  return [
    saud,
    '',
    g.itens.length > 1 ? 'Estas ordens estão com vocês e já passaram do prazo:' : 'Esta ordem está com vocês e já passou do prazo:',
    ...linhas,
    '',
    'Consegue me passar a nova previsão de entrega? Obrigado!',
  ].join('\n');
}

export default function CobrancaFaccaoPage() {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [minimo, setMinimo] = useState(0);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro('');
    try { setDados(await api.get(ROTA)); } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const grupos = useMemo(() => (dados?.faccoes || [])
    .map((g) => ({ ...g, itens: g.itens.filter((i) => i.dias_atraso > minimo) }))
    .filter((g) => g.itens.length > 0), [dados, minimo]);

  const r = dados?.resumo;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><BellRing size={22} /> Cobrança de facção</h1>
          <p className="ink-soft">
            Toda OP e O.S. que passou do prazo, por facção, com a mensagem pronta para o WhatsApp.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn btn-ghost" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {erro && <p className="erro-inline">{erro}</p>}

      {r && (
        <div className="indicadores-linha cb-kpis">
          <div className="cb-kpi"><small>Facções com atraso</small><b>{r.faccoes}</b></div>
          <div className="cb-kpi"><small>Ordens atrasadas</small><b>{r.itens}</b></div>
          <div className="cb-kpi"><small>Peças pendentes</small><b>{formatQtd(r.pendente)}</b></div>
          <div className={`cb-kpi ${r.maior_atraso > 30 ? 'cb-kpi-ruim' : ''}`}><small>Maior atraso</small><b>{plural(r.maior_atraso, 'dia')}</b></div>
        </div>
      )}

      <div className="segmentado cb-filtro">
        {FILTROS.map((f) => (
          <button key={f.valor} type="button" className={minimo === f.valor ? 'ativo' : ''} onClick={() => setMinimo(f.valor)}>{f.rotulo}</button>
        ))}
      </div>

      {carregando && !dados ? <Skeleton height={260} /> : grupos.length === 0 ? (
        <div className="card">
          <EstadoVazio
            Icone={CheckCircle2}
            titulo="Nada atrasado"
            descricao={minimo ? 'Nenhuma ordem com esse atraso. Tire o filtro para ver todas.' : 'Nenhuma OP ou O.S. passou do prazo. Quando passar, ela aparece aqui com a mensagem pronta.'}
          />
        </div>
      ) : (
        <div className="cb-lista">
          {grupos.map((g) => <CartaoFaccao key={g.fornecedor_id || 'sem'} g={g} onCobrou={carregar} />)}
        </div>
      )}
    </div>
  );
}

function CartaoFaccao({ g, onCobrou }) {
  const [texto, setTexto] = useState(() => montarMensagem(g));
  const [copiado, setCopiado] = useState(false);
  const [aviso, setAviso] = useState('');
  useEffect(() => { setTexto(montarMensagem(g)); }, [g]);

  const semFaccao = !g.fornecedor_id;
  const pendente = g.itens.reduce((s, i) => s + i.pendente, 0);
  const maior = g.itens.reduce((m, i) => Math.max(m, i.dias_atraso), 0);

  async function registrar(canal) {
    if (semFaccao) return;
    try {
      await api.post(`${ROTA}/registrar`, { fornecedor_id: g.fornecedor_id, canal, itens: g.itens.map((i) => i.chave) });
      onCobrou();
    } catch (e) { setAviso(e.message); }
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true); setTimeout(() => setCopiado(false), 1800);
      registrar('copiado');
    } catch { setAviso('O navegador não deixou copiar. Selecione a mensagem e copie com Ctrl+C.'); }
  }

  const linkWhats = g.whatsapp ? `https://wa.me/${g.whatsapp}?text=${encodeURIComponent(texto)}` : null;

  return (
    <section className={`card cb-cartao ${maior > 30 ? 'cb-cartao-grave' : ''}`}>
      <header className="cb-topo">
        <div>
          <h2>{g.nome}{g.categoria ? <small> · {g.categoria}</small> : null}</h2>
          <p className="ink-soft">
            {plural(g.itens.length, 'ordem', 'ordens')} · <b>{formatQtd(pendente)}</b> peças · maior atraso <b>{plural(maior, 'dia')}</b>
            {g.telefone && <> · <Phone size={12} /> {g.telefone}</>}
          </p>
        </div>
        <div className="cb-ultima">
          {semFaccao ? (
            <span className="selo tone-atencao">defina a facção na OP</span>
          ) : g.ultima_cobranca ? (
            <span className="selo tone-neutro" title={`Por ${g.ultima_cobranca.por || 'alguém'}`}><Clock size={11} /> cobrada {tempoRelativo(g.ultima_cobranca.em)}</span>
          ) : (
            <span className="selo tone-prejuizo">ainda não cobrada</span>
          )}
        </div>
      </header>

      <div className="tabela-rolagem">
        <table className="tabela-nota tabela-estreita cb-tab">
          <thead><tr><th>Ordem</th><th>Referência</th><th className="num">Faltam</th><th>Prazo</th><th className="num">Atraso</th><th>Onde está</th></tr></thead>
          <tbody>
            {g.itens.map((i) => (
              <tr key={i.chave}>
                <td>
                  {i.tipo === 'os'
                    ? <Link to={`/producao/ordens-servico?os=${i.ordem_servico_id}`}>O.S. {i.os_numero}</Link>
                    : <span>OP {i.op}</span>}
                  {i.tipo === 'os' && <small className="ink-soft"> · OP {i.op}</small>}
                  {i.origem === 'wik' && <span className="selo tone-neutro cb-wik">Wik</span>}
                </td>
                <td><b>{i.referencia}</b> <small className="ink-soft">{i.produto_descricao}</small></td>
                <td className="num"><b>{formatQtd(i.pendente)}</b></td>
                <td>{dataBr(i.prazo)}</td>
                <td className="num"><span className={`selo ${i.dias_atraso > 30 ? 'tone-prejuizo' : i.dias_atraso > 7 ? 'tone-atencao' : 'tone-neutro'}`}>{plural(i.dias_atraso, 'dia')}</span></td>
                <td className="cb-onde">{i.etapa || i.onde || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!semFaccao && (
        <details className="cb-msg">
          <summary><MessageCircle size={14} /> Mensagem para a facção</summary>
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={Math.min(14, texto.split('\n').length + 1)} />
        </details>
      )}
      {aviso && <p className="erro-inline">{aviso}</p>}
      {!semFaccao && (
        <div className="cb-acoes">
          {linkWhats ? (
            <a className="btn btn-primary cb-whats" href={linkWhats} target="_blank" rel="noreferrer" onClick={() => registrar('whatsapp')}>
              <MessageCircle size={15} /> Cobrar no WhatsApp
            </a>
          ) : (
            <span className="cb-sem-tel"><AlertTriangle size={13} /> Sem telefone no cadastro da facção — copie a mensagem ou cadastre o telefone.</span>
          )}
          <button type="button" className="btn btn-ghost" onClick={copiar}>
            {copiado ? <Check size={15} /> : <Copy size={15} />} {copiado ? 'Copiada' : 'Copiar mensagem'}
          </button>
        </div>
      )}
    </section>
  );
}
