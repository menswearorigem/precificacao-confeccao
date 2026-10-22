import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CircleCheck, Clock, RefreshCw, BellRing, Users, CalendarClock, ChevronDown, Printer } from 'lucide-react';
import { api } from '../api/client';
import { NumeroAnimado } from '../components/ui';
import { CartaoRotina, CartaoEvento, Vazio } from '../components/RotinaCartoes';
import { NOME_PRIORIDADE, diaLongo, horaDe, diaCurto, agruparPorRotina, situacaoDoGrupo } from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Meu dia — refeita em 21/10/2026 a pedido do dono: cartões em vez
// de lista. Cada cartão traz tudo resumido; a rotina de vários horários fica
// num cartão só, com os horários (feito / agora / atrasado / depois) em fila.
// Eventos (treinamento, reunião) aparecem em cima: sem baixa e sem atraso.

const precisaAtencao = (g) => {
  const s = situacaoDoGrupo(g).tom;
  return s === 'perigo' || s === 'atencao';
};
const encerrado = (g) => ['ok', 'roxo', 'neutro'].includes(situacaoDoGrupo(g).tom);

export default function RotinasMeuDiaPage() {
  const [ver, setVer] = useState('hoje');
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [agora, setAgora] = useState(() => new Date());
  const [verFeitas, setVerFeitas] = useState(false);
  const navigate = useNavigate();

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await api.get(`/rotinas/meu-dia${ver !== 'hoje' ? `?ver=${ver}` : ''}`));
      setAgora(new Date());
      setErro('');
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, [ver]);

  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    const t = setInterval(carregar, 2 * 60000);
    return () => clearInterval(t);
  }, [carregar]);

  // Horários que outra pessoa pegou entram só no cartão de uma rotina que a
  // pessoa também tem hoje — nunca viram cartão sozinhos.
  const grupos = useMemo(() => {
    const meus = [...(dados?.abertas || []), ...(dados?.feitas || [])];
    const modelos = new Set(meus.map((x) => x.modeloId));
    return agruparPorRotina([...meus, ...(dados?.daEquipe || []).filter((x) => modelos.has(x.modeloId))]);
  }, [dados]);
  const atencao = grupos.filter(precisaAtencao);
  const paraHoje = grupos.filter((g) => !precisaAtencao(g) && !encerrado(g));
  const feitas = grupos.filter((g) => !precisaAtencao(g) && encerrado(g));
  const abrir = (item) => navigate(`/rotinas/tarefa/${item.id}`);
  const c = dados?.contadores;

  // Semana/amanhã: agrupa por dia e, dentro do dia, por rotina (horários juntos).
  const futuro = useMemo(() => {
    const dias = new Map();
    for (const f of dados?.futuro || []) {
      if (!dias.has(f.data)) dias.set(f.data, new Map());
      const m = dias.get(f.data);
      if (!m.has(f.modeloId)) m.set(f.modeloId, { ...f, horas: [] });
      if (f.horaLimite) m.get(f.modeloId).horas.push(f.horaLimite);
    }
    return [...dias.entries()].map(([dia, m]) => [dia, [...m.values()]]);
  }, [dados]);

  const grade = (lista) => (
    <div className="rt-cartoes">
      {lista.map((g) => <CartaoRotina key={g.chave} grupo={g} hoje={dados.hoje} onAbrir={abrir} />)}
    </div>
  );

  return (
    <div className="page-wide rotinas">
      <header className="rt-topo">
        <div>
          <h1>Meu dia</h1>
          <p className="ink-soft">{dados ? diaLongo(dados.hoje) : '…'}</p>
        </div>
        <div className="rt-topo-acoes">
          <div className="segmentado" role="tablist" aria-label="Ver">
            {[['hoje', 'Hoje'], ['amanha', 'Amanhã'], ['semana', 'Semana']].map(([k, l]) => (
              <button key={k} type="button" className={ver === k ? 'ativo' : ''} onClick={() => setVer(k)}>{l}</button>
            ))}
          </div>
          <Link to="/rotinas/papel" className="btn-icone" title="Imprimir minha rotina (PDF)" aria-label="Imprimir minha rotina"><Printer size={15} /></Link>
          <button type="button" className="btn-icone" onClick={carregar} title="Atualizar" aria-label="Atualizar">
            <RefreshCw size={15} className={carregando ? 'girando' : ''} />
          </button>
        </div>
      </header>

      {erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}

      {ver === 'hoje' && dados?.lembretes?.length > 0 && (
        <div className="rt-aviso rt-tom-atencao" role="status">
          <BellRing size={16} />
          <span>
            {dados.lembretes.map((l, i) => (
              <span key={l.id}>{i > 0 && ' · '}<Link to={`/rotinas/tarefa/${l.id}`}><b>{l.titulo}</b></Link> {l.minutos < 1 ? 'vence agora' : `vence em ${l.minutos} min`}</span>
            ))}
          </span>
        </div>
      )}

      {ver === 'hoje' && (
        <div className="rt-resumo-dia">
          <span className="rt-resumo-n rt-tom-perigo"><b><NumeroAnimado valor={c?.atrasadas ?? 0} /></b> atrasada{c?.atrasadas === 1 ? '' : 's'}</span>
          <span className="rt-resumo-n rt-tom-info"><b><NumeroAnimado valor={c?.paraHoje ?? 0} /></b> para fazer</span>
          <span className="rt-resumo-n rt-tom-ok"><b><NumeroAnimado valor={c?.feitas ?? 0} /></b> feita{c?.feitas === 1 ? '' : 's'} hoje</span>
        </div>
      )}

      {ver === 'hoje' && dados?.eventos?.length > 0 && (
        <section className="rt-secao">
          <h2 className="rt-secao-h"><CalendarClock size={15} />Eventos de hoje <small>só para saber — ninguém atrasa</small></h2>
          <div className="rt-eventos">
            {dados.eventos.map((ev, i) => <CartaoEvento key={`${ev.modeloId}-${ev.horario || i}`} ev={ev} agora={agora} />)}
          </div>
        </section>
      )}

      {ver === 'hoje' && dados && (
        <>
          {atencao.length > 0 && (
            <section className="rt-secao">
              <h2 className="rt-secao-h rt-txt-perigo">Precisa de atenção <small>{atencao.length}</small></h2>
              {grade(atencao)}
            </section>
          )}
          <section className="rt-secao">
            <h2 className="rt-secao-h">Para hoje <small>{paraHoje.length}</small></h2>
            {paraHoje.length ? grade(paraHoje) : (
              <Vazio titulo={atencao.length ? 'O resto do dia está em dia.' : 'Nada pendente.'} texto="Quando um administrador passar uma tarefa, ela aparece aqui." />
            )}
          </section>
          {feitas.length > 0 && (
            <section className="rt-secao">
              <button type="button" className="rt-secao-h rt-secao-toggle" onClick={() => setVerFeitas((x) => !x)} aria-expanded={verFeitas}>
                <CircleCheck size={15} />Feitas hoje <small>{feitas.length}</small><ChevronDown size={15} className={verFeitas ? 'virado' : ''} />
              </button>
              {verFeitas && grade(feitas)}
            </section>
          )}
        </>
      )}

      {ver !== 'hoje' && dados && (
        <section className="rt-futuro">
          {futuro.length === 0 && <Vazio icone={Clock} titulo="Nada programado." />}
          {futuro.map(([dia, itens]) => (
            <div key={dia} className="rt-futuro-dia">
              <h3>{diaLongo(dia)}</h3>
              <div className="rt-cartoes rt-cartoes-mini">
                {itens.map((f) => (
                  <article key={f.modeloId} className={`rt-cartao rt-cartao-estatico ${f.tipo === 'evento' ? 'rt-faixa-info' : 'rt-faixa-neutro'}`}>
                    <header className="rt-cartao-topo">
                      <span className="rt-cartao-tags">
                        {f.tipo === 'evento' && <i className="rt-tag"><CalendarClock size={11} />evento</i>}
                        {(f.prioridade === 'alta' || f.prioridade === 'urgente') && <i className={`rt-chip rt-pri-${f.prioridade}`}>{NOME_PRIORIDADE[f.prioridade]}</i>}
                        {f.dividida && <i className="rt-tag"><Users size={11} />equipe divide</i>}
                        {!f.dividida && f.compartilhada && <i className="rt-tag"><Users size={11} />qualquer um</i>}
                      </span>
                    </header>
                    <h3 className="rt-cartao-titulo">{f.titulo}</h3>
                    {f.horas.length > 1 ? (
                      <div className="rt-horas">{f.horas.map((h) => <span key={h} className="rt-hora-slot depois"><b>{h}</b></span>)}</div>
                    ) : (
                      <p className="rt-cartao-info"><span><Clock size={12} />{f.horas[0] ? `${f.tipo === 'evento' ? 'às' : 'até'} ${f.horas[0]}` : 'até o fim do dia'}</span></p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <details className="rt-como">
        <summary>Como funciona</summary>
        <p>Cada cartão é uma tarefa do dia. Toque nele para ler o que fazer, ver os produtos e responder os passos — cada resposta é salva na hora, dá para sair e voltar.</p>
        <p>Tarefa com <b>vários horários</b> (ex.: chat às 9h, 12h, 15h e 18h) fica num cartão só: os horários feitos ficam verdes, o próximo fica destacado e o que passou do horário fica vermelho. Toque no horário para abrir.</p>
        <p><b>Atrasada</b> é a que passou do horário limite: continua aqui até ser concluída ou marcada como "não consegui fazer". Se o administrador <b>devolver</b>, ela volta com o comentário.</p>
        <p><b>Eventos</b> (treinamento, reunião) só avisam o horário: não precisa dar baixa e ninguém fica atrasado.</p>
        {dados && <p className="ink-soft">Atualizado às {horaDe(agora)} · {diaCurto(dados.hoje)}</p>}
      </details>
    </div>
  );
}
