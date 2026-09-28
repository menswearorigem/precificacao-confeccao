import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  Scissors, Plus, RefreshCw, AlertTriangle, Layers, PackageOpen, ArrowRight, RotateCcw,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, Select, NumInput, Field, Paginacao } from '../components/ui';
import Gaveta from '../components/Gaveta';
import { useTabela } from '../lib/useTabela';
import { formatQtd, dataBr, plural } from '../lib/format';
import { SwatchCor, qtdTecido, SeloSituacaoCorte, SeloDesvio } from '../components/CorteComum';
import './Corte.css';

// Produção › Corte (28/09/2026).
//
// A ordem de corte nasce da OP: a grade do risco (quantas vezes cada tamanho
// entra no enfesto), as camadas de cada cor e o tecido a separar. A folha e o
// lançamento do consumo real ficam em /producao/corte/:id.
//
// A sobra é SÓ registro (decisão da dona, 28/09/2026): a aba "Sobras" mostra o
// que voltou para a prateleira em cada corte, sem mexer no saldo de tecido.

const ROTA = '/producao-corte';

export default function CortePage() {
  const [aba, setAba] = useState('cortes');
  const [cortes, setCortes] = useState([]);
  const [sobras, setSobras] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [params, setParams] = useSearchParams();
  const [novaAberta, setNovaAberta] = useState(Boolean(params.get('op')));

  const carregar = useCallback(async () => {
    setCarregando(true); setErro('');
    try {
      const [c, s] = await Promise.all([api.get(ROTA), api.get(`${ROTA}/sobras`)]);
      setCortes(c); setSobras(s);
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const abertos = cortes.filter((c) => c.situacao === 'aberta');
  const cortados = cortes.filter((c) => c.situacao === 'cortada');
  const comDesvio = cortados.filter((c) => c.desvio != null);
  const desvioMedio = useMemo(() => {
    const prev = comDesvio.reduce((s, c) => s + c.tecido_real / (1 + c.desvio), 0);
    const real = comDesvio.reduce((s, c) => s + c.tecido_real, 0);
    return prev > 0 ? real / prev - 1 : null;
  }, [comDesvio]);

  const tabela = useTabela(aba === 'cortes' ? cortes : sobras, { colunas: {}, prefixo: `corte-${aba}` });

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Scissors size={22} /> Corte</h1>
          <p className="ink-soft">
            A folha do cortador de cada OP — grade do risco, camadas por cor e tecido a separar — e,
            depois do corte, quanto foi gasto de verdade.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn btn-ghost" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setNovaAberta(true)}>
            <Plus size={15} /> Nova ordem de corte
          </button>
        </div>
      </header>

      {erro && <p className="erro-inline">{erro}</p>}

      <div className="indicadores-linha co-kpis">
        <div className="co-kpi"><small>Esperando corte</small><b>{abertos.length}</b></div>
        <div className="co-kpi"><small>Cortados</small><b>{cortados.length}</b></div>
        <div className={`co-kpi ${desvioMedio != null && Math.abs(desvioMedio) >= 0.05 ? 'co-kpi-alerta' : ''}`}>
          <small>Real × ficha (média)</small>
          <b>{desvioMedio == null ? '—' : <SeloDesvio desvio={desvioMedio} grande />}</b>
        </div>
        <div className="co-kpi"><small>Sobras registradas</small><b>{sobras.length}</b></div>
      </div>

      <div className="segmentado co-abas">
        <button type="button" className={aba === 'cortes' ? 'ativo' : ''} onClick={() => setAba('cortes')}><Scissors size={14} /> Ordens de corte</button>
        <button type="button" className={aba === 'sobras' ? 'ativo' : ''} onClick={() => setAba('sobras')}><PackageOpen size={14} /> Sobras</button>
      </div>

      {carregando ? <Skeleton height={240} /> : (
        <div className="card">
          {aba === 'cortes' && (cortes.length === 0 ? (
            <EstadoVazio
              Icone={Scissors}
              titulo="Nenhuma ordem de corte ainda"
              descricao="Escolha uma OP e o Hub monta a folha do cortador com a grade do risco, as camadas de cada cor e quanto tecido separar."
              acaoLabel="Nova ordem de corte"
              onAcao={() => setNovaAberta(true)}
              IconeAcao={Plus}
            />
          ) : (
            <div className="tabela-rolagem">
              <Paginacao {...tabela} posicao="topo" />
              <table className="tabela-nota">
                <thead>
                  <tr>
                    <th>Corte</th><th>OP</th><th>Referência</th><th>Grade</th>
                    <th className="num">Camadas</th><th className="num">Peças</th>
                    <th className="num">Previsto</th><th className="num">Real</th><th>Real × ficha</th><th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {tabela.itensPagina.map((c) => (
                    <tr key={c.id} className="co-linha">
                      <td><Link to={`/producao/corte/${c.id}`}><b>Nº {c.numero}</b></Link><br /><small className="ink-soft">{dataBr(c.data_corte || c.criado_em)}</small></td>
                      <td>OP {c.ordem_numero_exibicao}</td>
                      <td><b>{c.referencia}</b><br /><small className="ink-soft">{c.produto_descricao}</small></td>
                      <td className="co-grade-txt">{(c.grade || []).filter((g) => g.unidades > 0).map((g) => `${g.tamanho}${g.unidades}`).join(' ')}</td>
                      <td className="num">{formatQtd(c.camadas)}</td>
                      <td className="num">{formatQtd(c.pecas)}</td>
                      <td className="num">{c.tecido_previsto == null ? <span className="ink-soft" title="A ficha não tem consumo para algum tamanho">sem ficha</span> : qtdTecido(c.tecido_previsto, c.unidade)}</td>
                      <td className="num">{c.tecido_real == null ? '—' : qtdTecido(c.tecido_real, c.unidade)}</td>
                      <td>{c.desvio == null ? '—' : <SeloDesvio desvio={c.desvio} />}</td>
                      <td><SeloSituacaoCorte situacao={c.situacao} /> <Link className="co-abrir" to={`/producao/corte/${c.id}`} title="Abrir"><ArrowRight size={14} /></Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Paginacao {...tabela} posicao="rodape" />
            </div>
          ))}

          {aba === 'sobras' && (sobras.length === 0 ? (
            <EstadoVazio
              Icone={PackageOpen}
              titulo="Nenhuma sobra registrada"
              descricao="Quando o cortador lança quanto sobrou de cada cor, a sobra aparece aqui. É só registro: o saldo de tecido não muda."
            />
          ) : (
            <div className="tabela-rolagem">
              <p className="ajuda-bloco ink-soft">
                O que voltou para a prateleira depois de cada corte. É só registro — o saldo de tecido da
                Matéria-Prima continua sendo o que foi digitado ou conferido lá.
              </p>
              <Paginacao {...tabela} posicao="topo" />
              <table className="tabela-nota tabela-estreita">
                <thead><tr><th>Tecido</th><th>Cor</th><th className="num">Sobrou</th><th>Do corte</th><th>Data</th></tr></thead>
                <tbody>
                  {tabela.itensPagina.map((s) => (
                    <tr key={`${s.corte_id}-${s.cor}`}>
                      <td>{s.tecido || '—'}</td>
                      <td><SwatchCor cor={s.cor} />{s.cor}</td>
                      <td className="num"><b>{qtdTecido(s.sobra, s.unidade)}</b></td>
                      <td><Link to={`/producao/corte/${s.corte_id}`}>Nº {s.corte_numero}</Link> · OP {s.ordem_numero_exibicao} · {s.referencia}</td>
                      <td>{dataBr(s.data_corte)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {novaAberta && (
        <NovaOrdemCorte
          opInicial={params.get('op')}
          onFechar={() => { setNovaAberta(false); if (params.get('op')) { params.delete('op'); setParams(params, { replace: true }); } }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nova ordem de corte (gaveta)
// ---------------------------------------------------------------------------
function NovaOrdemCorte({ opInicial, onFechar }) {
  const navigate = useNavigate();
  const [ops, setOps] = useState([]);
  const [ordemId, setOrdemId] = useState(opInicial || '');
  const [materialId, setMaterialId] = useState('');
  const [grade, setGrade] = useState(null); // null = usar a sugerida
  const [camadas, setCamadas] = useState({});
  const [cortador, setCortador] = useState('');
  const [previa, setPrevia] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState('');
  const seq = useRef(0);

  useEffect(() => { api.get(`${ROTA}/ops`).then(setOps).catch((e) => setErro(e.message)); }, []);

  // Prévia recalculada a cada mudança. `seq` descarta respostas velhas: quem
  // digita rápido na camada não pode ver a folha de duas teclas atrás.
  useEffect(() => {
    if (!ordemId) { setPrevia(null); return undefined; }
    const minha = ++seq.current;
    const t = setTimeout(async () => {
      setCarregando(true); setErro('');
      try {
        const r = await api.post(`${ROTA}/previa`, {
          ordem_id: Number(ordemId),
          material_id: materialId ? Number(materialId) : undefined,
          grade: grade || undefined,
          camadas,
        });
        if (minha !== seq.current) return;
        setPrevia(r);
        if (!materialId && r.material) setMaterialId(String(r.material.id));
      } catch (e) {
        if (minha === seq.current) { setErro(e.message); setPrevia(null); }
      } finally {
        if (minha === seq.current) setCarregando(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [ordemId, materialId, grade, camadas]); // eslint-disable-line react-hooks/exhaustive-deps

  function trocarOp(id) {
    setOrdemId(id); setMaterialId(''); setGrade(null); setCamadas({});
  }

  const plano = previa?.plano;
  const gradeAtual = grade || plano?.grade || [];
  const un = previa?.material?.unidade || 'kg';

  function mudarGrade(i, v) {
    const base = (grade || plano?.grade || []).map((g) => ({ ...g }));
    base[i] = { ...base[i], unidades: v === '' ? 0 : v };
    setGrade(base);
    setCamadas({}); // grade nova → camadas voltam a ser sugeridas
  }

  async function criar() {
    setGravando(true); setErro('');
    try {
      const r = await api.post(ROTA, {
        ordem_id: Number(ordemId),
        material_id: materialId ? Number(materialId) : undefined,
        grade: gradeAtual,
        camadas,
        cortador,
      });
      navigate(`/producao/corte/${r.id}`);
    } catch (e) { setErro(e.message); } finally { setGravando(false); }
  }

  const podeCriar = plano && plano.pecasPorGrade > 0 && plano.cores.some((c) => c.camadas > 0) && !carregando;

  return (
    <Gaveta
      aberta
      larga
      onFechar={onFechar}
      Icone={Scissors}
      titulo="Nova ordem de corte"
      subtitulo="Escolha a OP. O Hub sugere a grade do risco e as camadas; ajuste se o enfesto for diferente."
      rodape={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Fechar</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" disabled={!podeCriar || gravando} onClick={criar}>
            <Scissors size={14} /> {gravando ? 'Gravando…' : 'Criar e abrir a folha'}
          </button>
        </>
      )}
    >
      {erro && <p className="erro-inline">{erro}</p>}
      <Field label="Ordem de produção">
        <Select value={ordemId} onChange={(e) => trocarOp(e.target.value)} placeholder="Escolha a OP" chaveRecentes="corte-op">
          {ops.map((o) => (
            <option key={o.id} value={o.id}>
              {`OP ${o.numero_exibicao} · ${o.referencia} · ${formatQtd(o.pecas)} pç${o.data_prevista ? ` · até ${dataBr(o.data_prevista)}` : ''}${o.cortes ? ` · já tem ${plural(o.cortes, 'corte')}` : ''}`}
            </option>
          ))}
        </Select>
      </Field>

      {ordemId && !previa && carregando && <Skeleton height={160} />}

      {previa && (
        <>
          <div className="co-gaveta-linha">
            <Field label="Tecido">
              {previa.tecidos.length > 1 ? (
                <Select value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
                  {previa.tecidos.map((t) => <option key={t.id} value={t.id}>{t.nome} · {t.unidade}</option>)}
                </Select>
              ) : (
                <div className="co-fixo">{previa.material ? `${previa.material.nome} · ${previa.material.unidade}` : 'sem tecido na ficha'}</div>
              )}
            </Field>
            <Field label="Cortador" hint="Opcional.">
              <input className="input" value={cortador} maxLength={80} onChange={(e) => setCortador(e.target.value)} placeholder="Quem vai cortar" />
            </Field>
          </div>

          <div className="co-bloco">
            <div className="co-bloco-topo">
              <b><Layers size={14} /> Grade do risco</b>
              <span className="ink-soft">{plano.pecasPorGrade} peças por camada</span>
              {grade && <button type="button" className="btn btn-ghost sm" onClick={() => { setGrade(null); setCamadas({}); }}><RotateCcw size={12} /> Voltar à sugerida</button>}
            </div>
            <div className="co-grade-edit">
              {gradeAtual.map((g, i) => (
                <label key={g.tamanho} className="co-grade-cel">
                  <span>{g.tamanho}</span>
                  <NumInput value={g.unidades} onChange={(v) => mudarGrade(i, v)} step="1" min={0} />
                </label>
              ))}
            </div>
          </div>

          {plano.pendencias.length > 0 && (
            <div className="co-pendencias">
              {plano.pendencias.map((p) => <p key={p}><AlertTriangle size={13} /> {p}</p>)}
            </div>
          )}

          <div className="tabela-rolagem">
            <table className="tabela-nota tabela-estreita co-previa">
              <thead>
                <tr>
                  <th>Cor</th><th className="num">OP</th><th className="num">Camadas</th>
                  {plano.grade.filter((g) => g.unidades > 0).map((g) => <th key={g.tamanho} className="num">{g.tamanho}</th>)}
                  <th className="num">Total</th><th className="num">Separar</th>
                </tr>
              </thead>
              <tbody>
                {plano.cores.map((c) => (
                  <tr key={c.cor}>
                    <td><SwatchCor cor={c.cor} hex={c.hex} />{c.cor || 'sem cor'}</td>
                    <td className="num">{formatQtd(c.pecasOp)}</td>
                    <td className="num co-cel-camada">
                      <NumInput value={c.camadas} onChange={(v) => setCamadas((x) => ({ ...x, [c.cor]: v === '' ? 0 : v }))} step="1" min={0} />
                    </td>
                    {plano.grade.filter((g) => g.unidades > 0).map((g) => <td key={g.tamanho} className="num">{formatQtd(c.pecasPrevistas[g.tamanho] || 0)}</td>)}
                    <td className="num">
                      <b>{formatQtd(c.pecasPrevistasTotal)}</b>
                      {c.diferencaOp !== 0 && <small className={c.diferencaOp > 0 ? 'co-mais' : 'co-menos'}> {c.diferencaOp > 0 ? '+' : ''}{c.diferencaOp}</small>}
                    </td>
                    <td className="num"><b>{c.tecidoPrevisto == null ? '—' : qtdTecido(c.tecidoPrevisto, un)}</b></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{formatQtd(plano.totais.pecasOp)}</td>
                  <td className="num">{formatQtd(plano.totais.camadas)}</td>
                  {plano.grade.filter((g) => g.unidades > 0).map((g) => (
                    <td key={g.tamanho} className="num">{formatQtd(plano.cores.reduce((s, c) => s + (c.pecasPrevistas[g.tamanho] || 0), 0))}</td>
                  ))}
                  <td className="num"><b>{formatQtd(plano.totais.pecasPrevistas)}</b></td>
                  <td className="num"><b>{plano.totais.tecidoPrevisto == null ? '—' : qtdTecido(plano.totais.tecidoPrevisto, un)}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="ajuda-bloco ink-soft">
            O número pequeno ao lado do total é a diferença para a OP: a camada inteira nem sempre
            fecha exato. Ajuste as camadas se preferir cortar a mais ou a menos.
          </p>
        </>
      )}
    </Gaveta>
  );
}
