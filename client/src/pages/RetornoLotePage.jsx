import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  PackageCheck, Minus, Plus, CheckCheck, ScanLine, CheckCircle2, AlertTriangle, Printer, ClipboardList,
} from 'lucide-react';
import { api } from '../api/client';
import { Skeleton, Select, NumInput } from '../components/ui';
import LeitorCamera from '../components/LeitorCamera';
import { loteDoCodigo } from '../components/QrCodigo';
import { formatQtd, dataBr, hojeIso } from '../lib/format';
import { compararTamanhosCliente } from './loteComum';
import './Lote.css';

// Produção › Retorno do lote (28/09/2026) — o que o QR da ficha abre.
//
// Feita para o CELULAR, em pé, com o saco de peças na mão: um cartão por cor e
// tamanho, botões grandes de + e −, e "voltou tudo bom" para o caso comum.
// Grava pela MESMA rota da tela de Ordens de Serviço
// (POST /producao-movimentacao/ordens-servico/:id/retorno): a mesma regra de
// etapa de destino, o mesmo título no financeiro, a mesma quebra medida.

const ROTA = '/producao-movimentacao';

function Contador({ valor, onChange, max, rotulo, tom }) {
  const v = Number(valor) || 0;
  return (
    <div className={`lt-contador ${tom || ''}`}>
      <span className="lt-contador-rot">{rotulo}</span>
      <div className="lt-contador-linha">
        <button type="button" onClick={() => onChange(Math.max(0, v - 1))} aria-label={`Menos ${rotulo}`}><Minus size={18} /></button>
        <NumInput value={valor} onChange={(x) => onChange(x === '' ? '' : Math.max(0, Math.floor(x)))} step="1" min={0} inputMode="numeric" />
        <button type="button" onClick={() => onChange(max != null ? Math.min(max, v + 1) : v + 1)} aria-label={`Mais ${rotulo}`}><Plus size={18} /></button>
      </div>
    </div>
  );
}

export default function RetornoLotePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dados, setDados] = useState(null);
  const [etapas, setEtapas] = useState([]);
  const [etapaDestino, setEtapaDestino] = useState('');
  const [ret, setRet] = useState({});
  const [erro, setErro] = useState('');
  const [feito, setFeito] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [camera, setCamera] = useState(false);

  const carregar = useCallback(async () => {
    setErro('');
    try {
      const [d, e] = await Promise.all([api.get(`${ROTA}/ordens-servico/${id}`), api.get(`${ROTA}/etapas`)]);
      setDados(d); setEtapas(e); setRet({});
    } catch (x) { setErro(x.message); }
  }, [id]);
  useEffect(() => { setFeito(null); setDados(null); setEtapaDestino(''); carregar(); }, [carregar]);

  const internas = useMemo(() => etapas.filter((e) => e.natureza !== 'externa' && e.ativo !== false), [etapas]);
  // Mesma escolha da tela de O.S.: a próxima etapa interna depois da etapa
  // desta O.S. — sem destino a peça boa sairia da facção e sumiria.
  useEffect(() => {
    if (etapaDestino || !dados || internas.length === 0) return;
    const atual = etapas.find((e) => e.id === dados.ordem_servico.etapa_id);
    const proxima = internas.find((e) => e.sequencia > (atual?.sequencia ?? -1));
    setEtapaDestino(String((proxima || internas[0]).id));
  }, [dados, etapas, internas, etapaDestino]);

  const itens = useMemo(() => [...(dados?.itens || [])]
    .filter((i) => Number(i.pendente) > 0)
    .sort((a, b) => String(a.cor).localeCompare(String(b.cor), 'pt-BR') || compararTamanhosCliente(a.tamanho, b.tamanho)), [dados]);

  const mudar = (itemId, campo, v) => setRet((x) => ({ ...x, [itemId]: { ...x[itemId], [campo]: v } }));
  const tudoBom = () => setRet(Object.fromEntries(itens.map((i) => [i.id, { boa: Number(i.pendente), segunda: 0, perdida: 0 }])));

  const linhas = itens.map((i) => {
    const r = ret[i.id] || {};
    const boa = Number(r.boa) || 0; const segunda = Number(r.segunda) || 0; const perdida = Number(r.perdida) || 0;
    return { i, boa, segunda, perdida, soma: boa + segunda + perdida, excedeu: boa + segunda + perdida > Number(i.pendente) };
  });
  const aGravar = linhas.filter((l) => l.soma > 0);
  const excedeu = linhas.some((l) => l.excedeu);
  const totais = aGravar.reduce((t, l) => ({ boa: t.boa + l.boa, segunda: t.segunda + l.segunda, perdida: t.perdida + l.perdida }), { boa: 0, segunda: 0, perdida: 0 });

  async function registrar() {
    setSalvando(true); setErro('');
    try {
      const r = await api.post(`${ROTA}/ordens-servico/${id}/retorno`, {
        etapa_destino_id: etapaDestino ? Number(etapaDestino) : null,
        data: hojeIso(),
        observacao: 'Retorno lançado pelo QR do lote.',
        itens: aGravar.map((l) => ({
          cor: l.i.cor, tamanho: l.i.tamanho,
          quantidade_retornada: l.boa, quantidade_segunda: l.segunda, quantidade_perdida: l.perdida,
        })),
      });
      setFeito({ ...totais, concluida: r.situacao === 'concluida' });
      await carregar();
    } catch (x) { setErro(x.message); } finally { setSalvando(false); }
  }

  const leitor = (
    <LeitorCamera
      aberto={camera}
      onFechar={() => setCamera(false)}
      titulo="Ler o QR de outro lote"
      subtitulo="Aponte para o QR da ficha ou da etiqueta do amarrado."
      onLer={(codigo) => {
        const n = loteDoCodigo(codigo);
        if (n) { setCamera(false); navigate(`/producao/lote/${n}`); }
      }}
    />
  );

  if (!dados) return <div className="pagina lt-retorno">{erro ? <p className="erro-inline">{erro}</p> : <Skeleton height={320} />}</div>;

  const os = dados.ordem_servico;
  const fechada = ['concluida', 'cancelada'].includes(os.situacao);
  const atraso = Number(os.dias_atraso || 0);

  return (
    <div className="pagina lt-retorno">
      <header className="lt-ret-topo">
        <span className="lt-rot">Retorno do lote</span>
        <h1>O.S. {os.numero} · {os.fornecedor_nome}</h1>
        <p>
          <b>{os.produto_referencia}</b> {os.produto_descricao} · OP {os.ordem_numero} · {os.etapa_nome}
        </p>
        <div className="lt-ret-selos">
          <span className="selo tone-neutro">{formatQtd(os.remetido)} saíram</span>
          {Number(os.quebra) > 0 && <span className="selo tone-atencao">{formatQtd(os.quebra)} faltam voltar</span>}
          {!fechada && atraso > 0 && <span className="selo tone-prejuizo">{atraso} dias de atraso</span>}
          {!fechada && os.previsao_retorno && atraso === 0 && <span className="selo tone-saudavel">até {dataBr(os.previsao_retorno)}</span>}
          {os.situacao === 'concluida' && <span className="selo tone-saudavel">concluída</span>}
        </div>
      </header>

      {erro && <p className="erro-inline">{erro}</p>}

      {feito && (
        <div className="lt-feito">
          <CheckCircle2 size={22} />
          <div>
            <b>Retorno registrado.</b>
            <p>{formatQtd(feito.boa)} boas · {formatQtd(feito.segunda)} de 2ª · {formatQtd(feito.perdida)} perdidas. {feito.concluida ? 'A O.S. foi concluída.' : 'Ainda há peça na facção.'}</p>
          </div>
        </div>
      )}

      {fechada ? (
        <p className="lt-fechada">
          Esta O.S. está <b>{os.situacao === 'concluida' ? 'concluída' : 'cancelada'}</b>: não há mais nada a receber.
        </p>
      ) : itens.length === 0 ? (
        <p className="lt-fechada">Nenhuma peça pendente neste lote.</p>
      ) : (
        <>
          <button type="button" className="btn btn-ghost lt-tudo" onClick={tudoBom}><CheckCheck size={16} /> Voltou tudo bom</button>
          <div className="lt-cartoes">
            {linhas.map(({ i, excedeu: passou }) => {
              const r = ret[i.id] || {};
              return (
                <div key={i.id} className={`lt-cartao ${passou ? 'lt-cartao-erro' : ''}`}>
                  <div className="lt-cartao-topo">
                    <b>{i.cor || 'sem cor'} · {i.tamanho}</b>
                    <span>faltam {formatQtd(i.pendente)}</span>
                  </div>
                  <div className="lt-contadores">
                    <Contador rotulo="Boas" valor={r.boa ?? ''} max={Number(i.pendente)} onChange={(v) => mudar(i.id, 'boa', v)} tom="lt-boa" />
                    <Contador rotulo="2ª qualidade" valor={r.segunda ?? ''} onChange={(v) => mudar(i.id, 'segunda', v)} tom="lt-segunda" />
                    <Contador rotulo="Perdidas" valor={r.perdida ?? ''} onChange={(v) => mudar(i.id, 'perdida', v)} tom="lt-perdida" />
                  </div>
                  {passou && <p className="lt-cartao-aviso"><AlertTriangle size={13} /> Mais do que falta voltar.</p>}
                </div>
              );
            })}
          </div>

          <div className="lt-destino">
            <span>As boas vão para</span>
            <Select value={etapaDestino} onChange={(e) => setEtapaDestino(e.target.value)}>
              {internas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
            </Select>
          </div>

          <div className="lt-rodape">
            <button type="button" className="btn btn-primary lt-gravar" disabled={salvando || aGravar.length === 0 || excedeu || !etapaDestino} onClick={registrar}>
              <PackageCheck size={18} />
              {salvando ? 'Gravando…' : aGravar.length === 0 ? 'Marque o que voltou' : `Registrar ${formatQtd(totais.boa + totais.segunda + totais.perdida)} peças`}
            </button>
          </div>
        </>
      )}

      <div className="lt-links">
        <button type="button" className="btn btn-ghost" onClick={() => setCamera(true)}><ScanLine size={15} /> Ler outro lote</button>
        <Link className="btn btn-ghost" to={`/producao/lote/${id}/ficha`}><Printer size={15} /> Ficha do lote</Link>
        <Link className="btn btn-ghost" to={`/producao/ordens-servico?os=${id}`}><ClipboardList size={15} /> Abrir a O.S.</Link>
      </div>
      {leitor}
    </div>
  );
}
