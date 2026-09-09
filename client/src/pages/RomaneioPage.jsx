import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Truck, ClipboardList, Info, AlertTriangle, Check, X, RefreshCw, Plus, Printer,
  Clock, PackageCheck, Undo2, Timer, Ban, FileText,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, IndicadorDestaque, Select, Field, NumInput,
  CampoBusca, ChipsFiltros, Checkbox,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { formatQtd, tempoRelativo } from '../lib/format';

// Marketplace › Romaneio.
//
// A expedição do Hub terminava na etiqueta. Depois dela faltavam três coisas:
//
//   · o papel que o motorista assina — sem ele, quando um pedido some, não há
//     como provar que ele saiu daqui;
//   · a pergunta "o que já devia ter sido coletado e não foi?", que em Shopee e
//     Mercado Livre custa reputação antes de custar dinheiro;
//   · a trava que impede a mesma caixa de entrar em duas remessas.
//
// ⚠️ O código de rastreio é congelado quando o pedido entra no romaneio: o
// pedido pode ser reetiquetado depois, e o papel assinado tem que continuar
// dizendo o que dizia.

const BASE = '/romaneios';

const SITUACOES = {
  aberto: 'Aberto', fechado: 'Fechado', coletado: 'Coletado', cancelado: 'Cancelado',
};

const COLETA = {
  atrasado: { rotulo: 'Atrasado', tom: 'tone-prejuizo', frase: 'Passou do prazo de coleta do canal. Cada um destes é reputação em risco.' },
  apertado: { rotulo: 'Apertado', tom: 'tone-atencao', frase: 'Já passou de dois terços do prazo. Ainda dá, mas não sobra dia.' },
  no_prazo: { rotulo: 'No prazo', tom: 'tone-saudavel', frase: 'Dentro do prazo do canal.' },
  sem_prazo: { rotulo: 'Sem prazo conhecido', tom: 'tone-neutro', frase: 'O canal não tem prazo cadastrado. Não é "em dia" — é "ninguém sabe". Cadastre o prazo para este canal entrar na conta.' },
  nao_faturado: { rotulo: 'Não faturado', tom: 'tone-neutro', frase: 'O relógio só começa no faturamento.' },
};

const mensagem = (e) => e?.data?.error || e?.data?.erro || e?.message || 'Erro inesperado.';
const ouTraco = (v) => (v === null || v === undefined || v === '' ? '—' : v);

export default function RomaneioPage() {
  const [coleta, setColeta] = useState(null);
  const [prazos, setPrazos] = useState([]);
  const [romaneios, setRomaneios] = useState([]);
  const [aberto, setAberto] = useState(null);
  const [situacao, setSituacao] = useState('');
  const [filtroColeta, setFiltroColeta] = useState('');
  const [busca, setBusca] = useState('');
  const [selecionados, setSelecionados] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const [avisos, setAvisos] = useState([]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [c, r, p] = await Promise.all([
        api.get(`${BASE}/coleta${filtroColeta ? `?situacao_coleta=${filtroColeta}` : ''}`),
        api.get(`${BASE}${situacao ? `?situacao=${situacao}` : ''}`),
        api.get(`${BASE}/prazos`),
      ]);
      setColeta(c); setRomaneios(r); setPrazos(p);
    } catch (e) { setErro(mensagem(e)); } finally { setCarregando(false); }
  }, [situacao, filtroColeta]);

  useEffect(() => { carregar(); }, [carregar]);

  const pendentes = useMemo(() => {
    const alvo = busca.trim().toLowerCase();
    return (coleta?.itens || [])
      .filter((i) => !i.romaneio_id)
      .filter((i) => !alvo || [i.numero, i.canal, (i.codigos_rastreio || []).join(' ')]
        .some((c) => String(c || '').toLowerCase().includes(alvo)));
  }, [coleta, busca]);

  async function novoRomaneio() {
    setErro(''); setSucesso('');
    try {
      const r = await api.post(BASE, { transportadora: null, canal: null });
      await abrir(r.id);
      setSucesso(`Romaneio ${r.numero} criado. Acrescente os pedidos e feche para imprimir.`);
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function abrir(id) {
    setErro('');
    try { setAberto(await api.get(`${BASE}/${id}`)); }
    catch (e) { setErro(mensagem(e)); }
  }

  async function acrescentar() {
    if (!aberto || selecionados.length === 0) return;
    setErro(''); setSucesso(''); setAvisos([]);
    try {
      const r = await api.post(`${BASE}/${aberto.romaneio.id}/pedidos`, {
        pedidos: selecionados.map((id) => ({ pedido_id: id })),
      });
      setSelecionados([]);
      setSucesso(`${r.entraram.length} pedido(s) no romaneio.`);
      // ⚠️ Os recusados sobem como aviso, um por um, com o motivo. Somar "2 de
      // 5 entraram" e calar sobre os 3 é o que faz a caixa ficar para trás sem
      // ninguém notar.
      setAvisos(r.recusados.map((x) => `Pedido ${x.numero ?? x.pedidoId}: ${x.motivo}`));
      await abrir(aberto.romaneio.id);
      carregar();
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
        setSucesso('Coleta registrada. O relógio parou para estes pedidos.');
      }
      if (tipo === 'cancelar') {
        const motivo = window.prompt('Motivo do cancelamento:');
        if (!motivo) return;
        await api.post(`${BASE}/${r.id}/cancelar`, { motivo });
        setSucesso('Cancelado. Os pedidos voltaram a poder entrar em outro romaneio.');
      }
      await abrir(r.id);
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function tirar(pedidoId) {
    const motivo = window.prompt('Por que este pedido está saindo do romaneio?');
    if (!motivo) return;
    setErro('');
    try {
      await api.post(`${BASE}/${aberto.romaneio.id}/pedidos/${pedidoId}/liberar`, { motivo });
      await abrir(aberto.romaneio.id);
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  const chips = [
    situacao && { chave: 's', rotulo: 'Romaneios', valor: SITUACOES[situacao], onRemover: () => setSituacao('') },
    filtroColeta && { chave: 'c', rotulo: 'Coleta', valor: COLETA[filtroColeta]?.rotulo, onRemover: () => setFiltroColeta('') },
    busca.trim() && { chave: 'b', rotulo: 'Busca', valor: busca.trim(), onRemover: () => setBusca('') },
  ].filter(Boolean);

  const noRomaneio = (aberto?.itens || []).filter((i) => !i.liberado_em);
  const liberados = (aberto?.itens || []).filter((i) => i.liberado_em);

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><ClipboardList size={22} /> Romaneio de expedição</h1>
          <p className="ink-soft">O que já devia ter saído, e o papel que o motorista assina.</p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn btn-primary" onClick={novoRomaneio}>
            <Plus size={15} /> Novo romaneio
          </button>
          <button type="button" className="btn btn-ghost" onClick={carregar}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <p className="ink-soft ajuda-bloco">
        <Info size={14} /> O relógio começa no faturamento e para quando o romaneio é coletado.
        O código de rastreio é congelado na entrada: reetiquetar o pedido depois não muda o que o
        papel assinado diz.
      </p>

      {erro && <p className="erro-inline">{erro}</p>}
      {sucesso && <p className="sucesso-inline"><Check size={14} /> {sucesso}</p>}
      {avisos.map((a, i) => <p className="aviso-inline" key={i}><AlertTriangle size={14} /> {a}</p>)}

      {/* 1. O relógio -------------------------------------------------------- */}
      {!coleta && <Skeleton height={96} />}
      {coleta && (
        <div className="indicadores-linha">
          <IndicadorDestaque
            rotulo="Atrasados" valor={formatQtd(coleta.resumo.atrasado)} Icone={AlertTriangle}
            tom={coleta.resumo.atrasado > 0 ? 'prejuizo' : undefined}
            explicacao={COLETA.atrasado.frase}
          />
          <IndicadorDestaque
            rotulo="Apertados" valor={formatQtd(coleta.resumo.apertado)} Icone={Timer}
            tom={coleta.resumo.apertado > 0 ? 'atencao' : undefined}
            explicacao={COLETA.apertado.frase}
          />
          <IndicadorDestaque
            rotulo="No prazo" valor={formatQtd(coleta.resumo.no_prazo)} Icone={Clock}
            explicacao={COLETA.no_prazo.frase}
          />
          <IndicadorDestaque
            rotulo="Sem prazo conhecido" valor={formatQtd(coleta.resumo.sem_prazo)} Icone={Info}
            explicacao={COLETA.sem_prazo.frase}
          />
        </div>
      )}

      {coleta?.resumo.sem_prazo > 0 && (
        <p className="aviso-inline">
          <AlertTriangle size={14} /> {formatQtd(coleta.resumo.sem_prazo)} pedido(s) estão em canais
          sem prazo de coleta cadastrado. Eles não entram na conta de atraso — o sistema não chuta um
          prazo que não conhece. Cadastre o prazo do canal para eles passarem a ser cobrados.
        </p>
      )}

      {/* 2. Pendentes de coleta ---------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><Clock size={16} /> Esperando coleta</h2>
        <p className="ink-soft">
          Pedidos faturados que ainda não estão em nenhum romaneio. Marque e mande para o romaneio
          aberto.
        </p>

        <div className="filtros-linha">
          <CampoBusca valor={busca} onChange={setBusca} placeholder="Número do pedido, canal ou rastreio" />
          <Select value={filtroColeta} onChange={(e) => setFiltroColeta(e.target.value)}>
            <option value="">Todas as situações</option>
            {Object.entries(COLETA).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
          </Select>
        </div>
        <ChipsFiltros itens={chips} onLimparTudo={() => { setSituacao(''); setFiltroColeta(''); setBusca(''); }} />

        {carregando && <Skeleton height={180} />}
        {!carregando && pendentes.length === 0 && (
          <EstadoVazio Icone={PackageCheck} titulo="Nada esperando coleta" descricao="Todo pedido faturado já está num romaneio." />
        )}
        {!carregando && pendentes.length > 0 && (
          <>
            <div className="painel-acoes-inline">
              <button
                type="button" className="btn btn-primary"
                onClick={acrescentar}
                disabled={!aberto || aberto.romaneio.situacao !== 'aberto' || selecionados.length === 0}
              >
                <Plus size={15} /> Mandar {selecionados.length || ''} para o romaneio
                {aberto ? ` ${aberto.romaneio.numero}` : ''}
              </button>
              {!aberto && <span className="ink-soft">Abra ou crie um romaneio para poder mandar.</span>}
            </div>
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead>
                  <tr>
                    <th /><th className="num">Pedido</th><th>Canal</th><th>Situação</th>
                    <th>Coletar até</th><th>Faturado</th><th>Rastreio</th>
                  </tr>
                </thead>
                <tbody>
                  {pendentes.slice(0, 300).map((i) => {
                    const s = COLETA[i.situacao_coleta] || {};
                    return (
                      <tr key={i.pedido_id}>
                        <td>
                          <Checkbox
                            checked={selecionados.includes(i.pedido_id)}
                            onChange={(e) => setSelecionados(e.target.checked
                              ? [...selecionados, i.pedido_id]
                              : selecionados.filter((x) => x !== i.pedido_id))}
                          />
                        </td>
                        <td className="num">{i.numero}</td>
                        <td>{ouTraco(i.canal || i.canal_venda)}</td>
                        <td><span className={`stamp sm ${s.tom || 'tone-neutro'}`}>{s.rotulo || i.situacao_coleta}</span></td>
                        <td>{i.coletar_ate ? tempoRelativo(i.coletar_ate) : '—'}</td>
                        <td>{i.faturado_em ? tempoRelativo(i.faturado_em) : '—'}</td>
                        <td>{(i.codigos_rastreio || []).join(', ') || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* 3. O romaneio aberto ------------------------------------------------ */}
      {aberto && (
        <div className="card">
          <div className="card-head-linha">
            <h2 className="card-titulo">
              <ClipboardList size={16} /> Romaneio {aberto.romaneio.numero}
              <span className="stamp sm tone-neutro">{SITUACOES[aberto.romaneio.situacao]}</span>
            </h2>
            <div className="painel-acoes-inline">
              {aberto.romaneio.situacao === 'aberto' && (
                <button type="button" className="btn btn-primary" onClick={() => acao('fechar')}>
                  <Check size={15} /> Fechar
                </button>
              )}
              {aberto.romaneio.situacao === 'fechado' && (
                <>
                  <a className="btn btn-primary" href={`/api${BASE}/${aberto.romaneio.id}/pdf`} target="_blank" rel="noreferrer">
                    <Printer size={15} /> Imprimir
                  </a>
                  <button type="button" className="btn btn-ghost" onClick={() => acao('coletar')}>
                    <Truck size={15} /> Registrar coleta
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => acao('reabrir')}>
                    <Undo2 size={15} /> Reabrir
                  </button>
                </>
              )}
              {aberto.romaneio.situacao === 'coletado' && (
                <a className="btn btn-ghost" href={`/api${BASE}/${aberto.romaneio.id}/pdf`} target="_blank" rel="noreferrer">
                  <FileText size={15} /> Ver o papel
                </a>
              )}
              {['aberto', 'fechado'].includes(aberto.romaneio.situacao) && (
                <button type="button" className="btn btn-danger" onClick={() => acao('cancelar')}>
                  <Ban size={15} /> Cancelar
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setAberto(null)}>
                <X size={15} /> Fechar tela
              </button>
            </div>
          </div>

          <p className="ink-soft">
            {formatQtd(noRomaneio.length)} pedido(s) ·
            {' '}{formatQtd(noRomaneio.reduce((s, i) => s + Number(i.volumes || 1), 0))} volume(s)
            {aberto.romaneio.coletado_em && (
              <> · levado por <strong>{ouTraco(aberto.romaneio.motorista)}</strong>
                {aberto.romaneio.placa ? ` (${aberto.romaneio.placa})` : ''} {tempoRelativo(aberto.romaneio.coletado_em)}</>
            )}
          </p>

          {Number(aberto.romaneio.sem_rastreio) > 0 && (
            <p className="aviso-inline">
              <AlertTriangle size={14} /> {formatQtd(aberto.romaneio.sem_rastreio)} pedido(s) sem
              código de rastreio. Eles vão para o papel escritos como <strong>SEM RASTREIO</strong> —
              é uma pergunta a se fazer antes de o motorista sair, não depois.
            </p>
          )}

          {noRomaneio.length === 0 && (
            <EstadoVazio Icone={ClipboardList} titulo="Romaneio vazio" descricao="Marque pedidos na lista acima e mande para cá." />
          )}
          {noRomaneio.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead>
                  <tr>
                    <th className="num">Pedido</th><th>Canal</th><th>Rastreio (congelado)</th>
                    <th className="num">Volumes</th><th />
                  </tr>
                </thead>
                <tbody>
                  {noRomaneio.map((i) => (
                    <tr key={i.id}>
                      <td className="num">{i.pedido_numero}</td>
                      <td>{ouTraco(i.origem_marketplace || i.canal_venda)}</td>
                      <td className={i.codigo_rastreio ? '' : 'tone-prejuizo'}>
                        {i.codigo_rastreio || 'SEM RASTREIO'}
                      </td>
                      <td className="num">{i.volumes}</td>
                      <td className="num">
                        {aberto.romaneio.situacao === 'aberto' && (
                          <button type="button" className="btn btn-ghost" onClick={() => tirar(i.pedido_id)}>
                            Tirar
                          </button>
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
              <p className="ink-soft">
                Saíram deste romaneio ({liberados.length}) — a linha fica no histórico de propósito:
              </p>
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

      {/* 4. Romaneios --------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><Truck size={16} /> Romaneios</h2>
        <div className="filtros-linha">
          <Select value={situacao} onChange={(e) => setSituacao(e.target.value)}>
            <option value="">Todas as situações</option>
            {Object.entries(SITUACOES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </div>
        {carregando && <Skeleton height={160} />}
        {!carregando && romaneios.length === 0 && (
          <EstadoVazio Icone={ClipboardList} titulo="Nenhum romaneio" descricao="Crie o primeiro e mande os pedidos que estão esperando coleta." />
        )}
        {!carregando && romaneios.length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th className="num">Nº</th><th>Transportadora</th><th>Situação</th>
                  <th className="num">Pedidos</th><th className="num">Volumes</th>
                  <th className="num">Sem rastreio</th><th>Quem levou</th><th>Quando</th>
                </tr>
              </thead>
              <tbody>
                {romaneios.map((r) => (
                  <tr key={r.id} className="linha-clicavel" onClick={() => abrir(r.id)}>
                    <td className="num">{r.numero}</td>
                    <td>{ouTraco(r.transportadora)}</td>
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

      {/* 5. Prazos ------------------------------------------------------------ */}
      <div className="card">
        <h2 className="card-titulo"><Timer size={16} /> Prazo de coleta por canal</h2>
        <p className="ink-soft">
          É daqui que sai a conta de atraso. Os números vieram do padrão divulgado de cada
          plataforma e servem como ponto de partida — o prazo real depende do plano da loja, da
          modalidade de envio e da região, e muda sem aviso. <strong>Confira no painel de cada
          canal.</strong>
        </p>
        <div className="tabela-rolagem">
          <table className="tabela-nota">
            <thead><tr><th>Canal</th><th className="num">Horas para coletar</th><th>Observação</th></tr></thead>
            <tbody>
              {prazos.map((p) => (
                <tr key={p.id}>
                  <td>{p.canal}</td>
                  <td className="num">
                    <NumInput
                      value={p.horas_para_coleta}
                      onChange={async (v) => {
                        if (!(Number(v) > 0)) return;
                        try {
                          await api.put(`${BASE}/prazos/${p.canal}`, { horas_para_coleta: Number(v) });
                          carregar();
                        } catch (e) { setErro(mensagem(e)); }
                      }}
                    />
                  </td>
                  <td className="ink-soft">{ouTraco(p.observacao)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
