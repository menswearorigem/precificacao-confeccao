import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer, Loader2, CalendarDays, FileText, LayoutGrid } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { DateInput } from '../components/ui';
import { NOME_SETOR } from '../lib/rotinas';
import '../styles/rotinas.css';
import '../styles/rotina-papel.css';

// Rotinas › Folha de papel (21/10/2026). Pedido do dono: exportar a rotina
// de cada pessoa em PDF, bonita, mas pensada para quem gosta de papel e
// caneta — não uma cópia da tela. Então:
//   · nada de botão, ícone de tela ou cor de status: só o que se faz com
//     caneta — quadradinhos para riscar, bolinhas para marcar, linhas para
//     escrever o número, "feito às __:__" e espaço para anotar;
//   · tarefa de vários horários vira uma GRADE (passos × horários), que é como
//     se controla isso no papel;
//   · duas folhas: a DO DIA (A4 em pé, uma por dia) e a DA SEMANA (A4
//     deitada, uma grade para ticar os sete dias).
// O PDF sai pelo "Salvar como PDF" da janela de impressão.

const SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const SEM_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dt = (d) => new Date(`${d}T12:00:00Z`);
const hojeIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const somar = (d, n) => { const x = dt(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const segundaDe = (d) => { const w = dt(d).getUTCDay(); return somar(d, w === 0 ? -6 : 1 - w); };
const ddmm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const primeiroNome = (n) => String(n || '').split(' ')[0];

function Caixa({ grande = false }) { return <span className={`fl-caixa${grande ? ' grande' : ''}`} aria-hidden="true" />; }
function Bolinha({ rot }) { return <span className="fl-bolinha"><i aria-hidden="true" />{rot}</span>; }
function Linha({ larga = false, rot }) { return <span className={`fl-linha${larga ? ' larga' : ''}`}>{rot && <small>{rot}</small>}</span>; }

// Como cada tipo de resposta vira caneta.
function RespostaPapel({ p }) {
  switch (p.tipo) {
    case 'sim_nao': return <span className="fl-resp"><Bolinha rot="Sim" /><Bolinha rot="Não" /></span>;
    case 'ok_problema': return <span className="fl-resp"><Bolinha rot="OK" /><Bolinha rot="Problema" /></span>;
    case 'numero': return <span className="fl-resp"><Linha />{p.unidade && <small className="fl-un">{p.unidade}</small>}</span>;
    case 'texto': return <span className="fl-resp fl-resp-larga"><Linha larga /></span>;
    case 'escolha': return <span className="fl-resp">{(p.opcoes || []).map((o) => <Bolinha key={o} rot={o} />)}</span>;
    case 'foto': return <span className="fl-resp fl-foto">foto pelo celular <Caixa /></span>;
    default: return null;
  }
}

function PassoPapel({ p, n }) {
  const marca = p.tipo === 'feito';
  return (
    <li className={`fl-passo${marca ? '' : ' com-resp'}`}>
      {marca ? <Caixa /> : <span className="fl-passo-n">{n}</span>}
      <span className="fl-passo-txt">{p.texto}{!p.obrigatorio && <em> (se der)</em>}{p.provaFoto === 'sempre' && <em> · com foto</em>}{p.provaFoto === 'problema' && <em> · foto se der problema</em>}</span>
      <RespostaPapel p={p} />
    </li>
  );
}

// Tarefa de um horário só (ou sem horário).
function TarefaPapel({ t }) {
  const porProduto = t.passos.filter((p) => p.porProduto);
  const gerais = t.passos.filter((p) => !p.porProduto);
  return (
    <article className="fl-tarefa">
      <div className="fl-hora">{t.horarios[0] ? <><small>até</small><b>{t.horarios[0]}</b></> : <><small>no</small><b className="fl-dia-todo">dia</b></>}</div>
      <div className="fl-tarefa-corpo">
        <header className="fl-tarefa-cab">
          <Caixa grande />
          <span className="fl-tarefa-tit">
            <b>{t.titulo}</b>
            <small>{[NOME_SETOR[t.setor], t.minutos && `~${t.minutos} min`, t.modo === 'dividir' && 'a equipe divide', t.modo === 'qualquer_um' && 'quem pegar primeiro', t.conferir && 'vai para conferência', (t.prioridade === 'alta' || t.prioridade === 'urgente') && `prioridade ${t.prioridade}`].filter(Boolean).join(' · ')}</small>
          </span>
          <span className="fl-feito-as">feito às <Linha /></span>
        </header>
        {t.instrucao && <p className="fl-instrucao">{t.instrucao}</p>}
        {gerais.length > 0 && <ol className="fl-passos">{gerais.map((p, i) => <PassoPapel key={i} p={p} n={i + 1} />)}</ol>}
        {porProduto.length > 0 && (t.produtos.length > 0 ? (
          <table className="fl-produtos">
            <thead><tr><th>Produto</th>{porProduto.map((p, i) => <th key={i}>{p.texto}{p.unidade ? ` (${p.unidade})` : ''}</th>)}</tr></thead>
            <tbody>
              {t.produtos.map((x, i) => (
                <tr key={i}>
                  <td><b>{x.referencia}</b> {[x.cor, x.tamanho].filter(Boolean).join(' ') || x.descricao}</td>
                  {porProduto.map((p, j) => <td key={j} className="fl-celula">{p.tipo === 'feito' ? <Caixa /> : ''}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="fl-nota">Para cada produto: {porProduto.map((p) => p.texto).join(', ')} — {t.produtosResumo || 'lista no Hub'}.</p>)}
      </div>
    </article>
  );
}

// Tarefa de vários horários: grade passos × horários.
function GradePapel({ t }) {
  const linhas = t.passos.length ? t.passos : [{ texto: 'Feito', tipo: 'feito', obrigatorio: true }];
  return (
    <article className="fl-tarefa fl-tarefa-grade">
      <div className="fl-hora"><small>{t.horarios.length}×</small><b className="fl-dia-todo">no dia</b></div>
      <div className="fl-tarefa-corpo">
        <header className="fl-tarefa-cab">
          <span className="fl-tarefa-tit">
            <b>{t.titulo}</b>
            <small>{[NOME_SETOR[t.setor], t.modo === 'dividir' && 'a equipe divide — marque o que você fez', t.modo === 'qualquer_um' && 'quem pegar primeiro'].filter(Boolean).join(' · ')}</small>
          </span>
        </header>
        {t.instrucao && <p className="fl-instrucao">{t.instrucao}</p>}
        <table className="fl-grade">
          <thead>
            <tr><th />{t.horarios.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {linhas.map((p, i) => (
              <tr key={i}>
                <td className="fl-grade-passo">{p.texto}{p.unidade ? ` (${p.unidade})` : ''}</td>
                {t.horarios.map((h) => <td key={h} className="fl-celula">{p.tipo === 'feito' || p.tipo === 'foto' ? <Caixa /> : p.tipo === 'sim_nao' || p.tipo === 'ok_problema' ? <span className="fl-mini-op">{p.tipo === 'sim_nao' ? 'S / N' : 'OK / P'}</span> : ''}</td>)}
              </tr>
            ))}
            <tr className="fl-grade-hora">
              <td className="fl-grade-passo">feito às</td>
              {t.horarios.map((h) => <td key={h}><span className="fl-hora-escrever">__:__</span></td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  );
}

function FolhaDia({ pessoa, dia }) {
  const d = dt(dia.data);
  const eventos = dia.itens.filter((t) => t.tipo === 'evento');
  const tarefas = dia.itens.filter((t) => t.tipo !== 'evento');
  return (
    <section className="fl-folha fl-retrato">
      <header className="fl-cab">
        <div className="fl-cab-quem">
          <small>a rotina de</small>
          <h1>{primeiroNome(pessoa.nome)}</h1>
          <div className="fl-escrever">
            <span>cheguei <Linha /></span>
            <span>saí <Linha /></span>
          </div>
        </div>
        <div className="fl-cab-dia">
          <b>{d.getUTCDate()}</b>
          <span>{SEMANA[d.getUTCDay()]}</span>
          <small>{MESES[d.getUTCMonth()]}</small>
        </div>
      </header>
      {dia.feriado && <p className="fl-feriado">Feriado: {dia.feriado}</p>}

      {eventos.length > 0 && (
        <div className="fl-eventos">
          <span className="fl-eventos-rot">hoje tem</span>
          {eventos.map((e, i) => (
            <span key={i} className="fl-evento">{(e.horarios.length ? e.horarios : ['—']).join(', ')} <b>{e.titulo}</b></span>
          ))}
        </div>
      )}

      <div className="fl-tarefas">
        {tarefas.length === 0 && <p className="fl-nada">Nenhuma rotina programada para este dia.</p>}
        {tarefas.map((t) => (t.horarios.length > 1 ? <GradePapel key={t.modeloId} t={t} /> : <TarefaPapel key={t.modeloId} t={t} />))}
      </div>

      <div className="fl-rodape">
        <div className="fl-anotar">
          <span className="fl-rot">anotações</span>
          <div className="fl-pautado" />
        </div>
        <div className="fl-lateral">
          <div className="fl-quadro"><span className="fl-rot">deu algum problema?</span><div className="fl-pautado curto" /></div>
          <div className="fl-assinar"><span className="fl-rot">conferido por</span><Linha larga /></div>
        </div>
      </div>
      <footer className="fl-pe"><span>Grupo HBN · Rotinas</span><span>{pessoa.nome} · {ddmm(dia.data)}</span></footer>
    </section>
  );
}

function FolhaSemana({ pessoa, dias }) {
  // Linhas: cada rotina (com seus horários) que acontece em algum dia da semana.
  const linhas = useMemo(() => {
    const m = new Map();
    for (const d of dias) for (const t of d.itens) {
      if (!m.has(t.modeloId)) m.set(t.modeloId, { ...t, dias: new Set() });
      m.get(t.modeloId).dias.add(d.data);
    }
    return [...m.values()].sort((a, b) => (a.tipo === 'evento') - (b.tipo === 'evento') || String(a.horarios[0] || '99').localeCompare(String(b.horarios[0] || '99')));
  }, [dias]);
  const domingoTem = dias.some((d) => dt(d.data).getUTCDay() === 0 && d.itens.length);
  const colunas = dias.filter((d) => dt(d.data).getUTCDay() !== 0 || domingoTem);
  return (
    <section className="fl-folha fl-paisagem">
      <header className="fl-cab fl-cab-semana">
        <div className="fl-cab-quem">
          <small>a semana de</small>
          <h1>{primeiroNome(pessoa.nome)}</h1>
        </div>
        <div className="fl-cab-periodo">
          <b>{ddmm(dias[0].data)} a {ddmm(dias[dias.length - 1].data)}</b>
          <small>risque o quadradinho quando fizer</small>
        </div>
      </header>
      <table className="fl-semana">
        <thead>
          <tr>
            <th className="fl-semana-tarefa">rotina</th>
            {colunas.map((d) => (
              <th key={d.data} className={d.feriado ? 'feriado' : ''}><b>{SEM_CURTO[dt(d.data).getUTCDay()]}</b><small>{ddmm(d.data)}</small></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((t) => (
            <tr key={t.modeloId} className={t.tipo === 'evento' ? 'evento' : ''}>
              <td className="fl-semana-tarefa">
                <b>{t.titulo}</b>
                <small>{t.tipo === 'evento' ? `evento${t.horarios[0] ? ` às ${t.horarios.join(', ')}` : ''} — só para lembrar` : t.horarios.length > 1 ? `${t.horarios.length}× no dia` : t.horarios[0] ? `até ${t.horarios[0]}` : 'no dia'}</small>
              </td>
              {colunas.map((d) => (
                <td key={d.data} className={t.dias.has(d.data) ? '' : 'nao'}>
                  {t.dias.has(d.data) && (t.tipo === 'evento'
                    ? <span className="fl-evento-marca">◷</span>
                    : <span className="fl-caixas">{(t.horarios.length > 1 ? t.horarios : ['']).map((h, i) => <span key={i} className="fl-caixa-h"><Caixa />{h && <small>{h}</small>}</span>)}</span>)}
                </td>
              ))}
            </tr>
          ))}
          {!linhas.length && <tr><td colSpan={colunas.length + 1} className="fl-nada">Nenhuma rotina nesta semana.</td></tr>}
        </tbody>
      </table>
      <div className="fl-rodape fl-rodape-semana">
        <div className="fl-anotar"><span className="fl-rot">o que ficou para a semana que vem</span><div className="fl-pautado curto" /></div>
        <div className="fl-anotar"><span className="fl-rot">anotações</span><div className="fl-pautado curto" /></div>
      </div>
      <footer className="fl-pe"><span>Grupo HBN · Rotinas</span><span>{pessoa.nome} · semana de {ddmm(dias[0].data)}</span></footer>
    </section>
  );
}

export default function RotinaPapelPage() {
  const { user } = useAuth();
  const souAdmin = user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const folha = params.get('folha') === 'semana' ? 'semana' : 'dia';
  const pessoa = params.get('pessoa') || '';
  const data = params.get('data') || hojeIso();
  const todaSemana = params.get('todos') === '1';
  const [pessoas, setPessoas] = useState([]);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const mudar = (k, v) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  useEffect(() => { if (souAdmin) api.get('/rotinas/pessoas').then((ps) => setPessoas(ps.filter((p) => p.temAcesso))).catch(() => {}); }, [souAdmin]);

  const de = folha === 'semana' || todaSemana ? segundaDe(data) : data;
  const dias = folha === 'semana' || todaSemana ? 7 : 1;
  useEffect(() => {
    setDados(null);
    const q = new URLSearchParams({ de, dias: String(dias) });
    if (souAdmin && pessoa) q.set('pessoa', pessoa);
    api.get(`/rotinas/papel?${q}`).then((d) => { setDados(d); setErro(''); }).catch((e) => setErro(e.message));
  }, [de, dias, pessoa, souAdmin]);

  // Nome do arquivo do PDF = título da aba.
  useEffect(() => {
    if (!dados) return undefined;
    const antes = document.title;
    document.title = `Rotina ${folha === 'semana' ? 'da semana' : 'do dia'} - ${primeiroNome(dados.pessoa.nome)} - ${ddmm(de).replace('/', '-')}`;
    return () => { document.title = antes; };
  }, [dados, folha, de]);

  const diasComFolha = dados ? (todaSemana && folha === 'dia' ? dados.dias.filter((d) => d.itens.length || dt(d.data).getUTCDay() !== 0) : dados.dias) : [];

  return (
    <div className="fl-pagina">
      <style>{`@page { size: A4 ${folha === 'semana' ? 'landscape' : 'portrait'}; margin: 0; }`}</style>
      <div className="fl-controles no-print">
        <Link to={souAdmin ? '/rotinas/modelos' : '/rotinas'} className="rt-voltar"><ArrowLeft size={15} />{souAdmin ? 'Modelos' : 'Meu dia'}</Link>
        <div className="fl-controles-linha">
          <h1>Folha para imprimir</h1>
          <p>Feita para caneta: quadradinhos para riscar, linhas para escrever. Para virar PDF, toque em <b>Salvar em PDF</b> e escolha <b>"Salvar como PDF"</b> na janela que abrir.</p>
        </div>
        <div className="fl-controles-campos">
          {souAdmin && (
            <label><span>Pessoa</span>
              <select value={pessoa} onChange={(e) => mudar('pessoa', e.target.value)}>
                <option value="">{user?.nome} (eu)</option>
                {pessoas.filter((p) => p.id !== user?.id).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
              </select>
            </label>
          )}
          <div className="fl-escolha" role="group" aria-label="Folha">
            <button type="button" className={folha === 'dia' ? 'ativo' : ''} onClick={() => mudar('folha', '')}><FileText size={15} />Folha do dia</button>
            <button type="button" className={folha === 'semana' ? 'ativo' : ''} onClick={() => mudar('folha', 'semana')}><LayoutGrid size={15} />Folha da semana</button>
          </div>
          <label><span>{folha === 'semana' ? 'Semana de' : 'Dia'}</span><DateInput value={data} onChange={(e) => mudar('data', e.target.value)} /></label>
          {folha === 'dia' && (
            <label className="fl-check"><input type="checkbox" checked={todaSemana} onChange={(e) => mudar('todos', e.target.checked ? '1' : '')} />Uma folha para cada dia da semana</label>
          )}
          <button type="button" className="btn btn-primary" onClick={() => window.print()} disabled={!dados}><Printer size={15} />Salvar em PDF</button>
        </div>
      </div>

      {erro && <div className="rt-aviso rt-tom-perigo no-print">{erro}</div>}
      {!dados && !erro && <div className="rt-carregando no-print"><Loader2 className="girando" size={18} /> Montando a folha…</div>}

      {dados && (
        <div className={`fl-folhas ${folha}`}>
          {folha === 'semana'
            ? <FolhaSemana pessoa={dados.pessoa} dias={dados.dias} />
            : diasComFolha.map((d) => <FolhaDia key={d.data} pessoa={dados.pessoa} dia={d} />)}
        </div>
      )}
      {dados && <p className="fl-rodape-tela no-print"><CalendarDays size={13} />O papel mostra o que está programado para a pessoa nos dias escolhidos. Mudou a rotina? É só imprimir de novo.</p>}
    </div>
  );
}
