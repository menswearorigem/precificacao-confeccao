import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Factory, RefreshCw, AlertTriangle, Info, Clock, CheckCircle2, Layers, Search,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton, IndicadorDestaque, Select } from '../components/ui';
import { formatQtd, dataBr, tempoRelativo } from '../lib/format';

// Produção › Produção no Wik.
//
// Espelho SOMENTE LEITURA da Ordem de Produção do Wik Sistemas. A API pública
// do Wik não expõe OP; este dado vem do backend web deles por cookie de sessão
// (ver server/src/lib/wikWeb.js). Atualiza sozinho a cada 15 min; o botão
// "Atualizar do Wik" força um ciclo na hora.
//
// O que esta tela mostra que a do Wik não mostra direito:
//   - a GRADE de verdade (cor × tamanho, previsto × realizado × perda × 2ª);
//   - o ATRASO calculado por nós: a tela do Wik pinta "ATRASADO" com 0 dias
//     quando a OP não tem previsão; aqui atrasado é previsão < hoje, de fato.

const ROTA = '/producao-wik';

const SITUACOES = [
  { v: '', t: 'Todas as situações' },
  { v: '0', t: 'Aguardando Início' },
  { v: '1', t: 'Iniciada' },
  { v: '2', t: 'Finalizada' },
  { v: '4', t: 'Finalizada Parcial' },
  { v: '5', t: 'Cancelada' },
  { v: '6', t: 'Baixada' },
];

export default function ProducaoWikPage() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [resumo, setResumo] = useState(null);
  const [ops, setOps] = useState([]);
  const [busca, setBusca] = useState('');
  const [marcaId, setMarcaId] = useState('');
  const [situacao, setSituacao] = useState('');
  const [emProducao, setEmProducao] = useState('true');
  const [sincronizando, setSincronizando] = useState(false);
  const [detalhe, setDetalhe] = useState(null); // { empId, op }
  const [detalheDados, setDetalheDados] = useState(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try {
      const params = new URLSearchParams();
      if (busca.trim()) params.set('busca', busca.trim());
      if (marcaId) params.set('marcaId', marcaId);
      if (situacao) params.set('situacao', situacao);
      params.set('emProducao', emProducao);
      const [r, l] = await Promise.all([
        api.get(`${ROTA}/resumo`),
        api.get(`${ROTA}/ops?${params.toString()}`),
      ]);
      setResumo(r);
      setOps(l.ops || []);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [busca, marcaId, situacao, emProducao]);

  useEffect(() => { carregar(); }, [carregar]);

  const sincronizar = async () => {
    setSincronizando(true);
    try {
      await api.post(`${ROTA}/sincronizar`, {});
      // dá um tempo pro ciclo começar e recarrega o resumo/lista
      setTimeout(carregar, 4000);
    } catch (e) {
      setErro(e.message);
    } finally {
      setTimeout(() => setSincronizando(false), 4000);
    }
  };

  const abrirDetalhe = async (op) => {
    if (detalhe && detalhe.empId === op.emp_id && detalhe.op === op.op) {
      setDetalhe(null); setDetalheDados(null); return;
    }
    setDetalhe({ empId: op.emp_id, op: op.op });
    setCarregandoDetalhe(true); setDetalheDados(null);
    try {
      const d = await api.get(`${ROTA}/ops/${op.emp_id}/${op.op}`);
      setDetalheDados(d);
    } catch (e) {
      setDetalheDados({ erro: e.message });
    } finally {
      setCarregandoDetalhe(false);
    }
  };

  const marcas = resumo?.porMarca || [];
  const st = resumo?.status || {};

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Factory size={20} /> Produção no Wik</h1>
          <p className="ink-soft">
            Ordens de produção espelhadas do Wik — situação, grade (cor × tamanho) e onde as peças estão.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-pri" onClick={sincronizar} disabled={sincronizando}>
            <RefreshCw size={16} className={sincronizando ? 'girando' : ''} /> Atualizar do Wik
          </button>
        </div>
      </header>

      <p className="ink-faint" style={{ fontSize: 12, marginTop: -4 }}>
        <Info size={12} /> Integração não-oficial (lê as telas do Wik por sessão). Atualiza sozinha a cada 15 min.
        {st.producao_ultima_sincronizacao && ` Última: ${tempoRelativo(st.producao_ultima_sincronizacao)}.`}
        {st.producao_status === 'rodando' && ' Sincronizando agora…'}
        {st.producao_status === 'erro' && st.producao_erro && ` Erro: ${st.producao_erro}`}
      </p>

      {erro && <p className="erro-inline">{erro}</p>}

      {resumo && (
        <div className="indicadores-linha">
          <IndicadorDestaque rotulo="OPs em produção" valor={formatQtd(resumo.totais.em_producao)} Icone={Factory} />
          <IndicadorDestaque rotulo="Peças previstas" valor={formatQtd(resumo.totais.pecas_previstas)} Icone={Layers} />
          <IndicadorDestaque rotulo="Peças realizadas" valor={formatQtd(resumo.totais.pecas_realizadas)} Icone={CheckCircle2} tom="ok" />
          <IndicadorDestaque rotulo="OPs atrasadas" valor={formatQtd(resumo.opsAtrasadas)} Icone={Clock} tom={resumo.opsAtrasadas > 0 ? 'ruim' : undefined} explicacao="Previsão de entrega já passou (cálculo nosso, não o do Wik)." />
        </div>
      )}

      <div className="card">
        <div className="filtros-linha" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <Search size={16} style={{ position: 'absolute', left: 10, top: 10, opacity: 0.5 }} />
            <input
              className="input" style={{ paddingLeft: 32, width: '100%' }}
              placeholder="OP, referência ou produto…"
              value={busca} onChange={(e) => setBusca(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && carregar()}
            />
          </div>
          <Select value={marcaId} onChange={setMarcaId} placeholder="Todas as marcas">
            <option value="">Todas as marcas</option>
            {marcas.filter((m) => m.marca).map((m) => (
              <option key={m.marca_id} value={m.marca_id}>{m.marca}</option>
            ))}
          </Select>
          <Select value={situacao} onChange={setSituacao}>
            {SITUACOES.map((s) => <option key={s.v} value={s.v}>{s.t}</option>)}
          </Select>
          <Select value={emProducao} onChange={setEmProducao}>
            <option value="true">Em produção agora</option>
            <option value="false">Fora de produção</option>
            <option value="">Todas</option>
          </Select>
        </div>

        {carregando ? (
          <div style={{ marginTop: 12 }}><Skeleton height={220} /></div>
        ) : ops.length === 0 ? (
          <EstadoVazio Icone={Factory} titulo="Nenhuma OP encontrada" descricao="Ajuste os filtros ou clique em Atualizar do Wik." />
        ) : (
          <div className="tabela-rolagem" style={{ marginTop: 12 }}>
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>OP</th><th>Marca</th><th>Referência</th><th>Produto</th>
                  <th>Situação</th><th>Etapas</th>
                  <th className="num">Prev.</th><th className="num">Real.</th>
                  <th>Previsão</th>
                </tr>
              </thead>
              <tbody>
                {ops.map((op) => {
                  const aberta = detalhe && detalhe.empId === op.emp_id && detalhe.op === op.op;
                  return (
                    <Fragment key={`${op.emp_id}-${op.op}`}>
                      <tr onClick={() => abrirDetalhe(op)} style={{ cursor: 'pointer' }} className={aberta ? 'linha-ativa' : ''}>
                        <td><strong>{op.op}</strong></td>
                        <td>{op.marca || <span className="ink-faint">—</span>}</td>
                        <td>{op.referencia || <span className="ink-faint">—</span>}</td>
                        <td className="ink-soft" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{op.produto_descricao}</td>
                        <td>
                          <span className={`selo ${op.situacao_codigo === 2 ? 'tone-ok' : op.situacao_codigo === 0 ? 'tone-neutro' : 'tone-atencao'}`}>
                            {op.situacao_label || (op.grade_sincronizada_em ? '—' : 'aguardando grade')}
                          </span>
                          {op.atrasada && <span className="selo tone-ruim" style={{ marginLeft: 4 }}>atrasada</span>}
                        </td>
                        <td className="ink-soft" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={op.etapas || ''}>{op.etapas || '—'}</td>
                        <td className="num">{formatQtd(op.qtd_prevista)}</td>
                        <td className="num">{formatQtd(op.qtd_realizada)}</td>
                        <td>{op.previsao_fim ? dataBr(op.previsao_fim) : <span className="ink-faint">sem previsão</span>}</td>
                      </tr>
                      {aberta && (
                        <tr className="linha-detalhe">
                          <td colSpan={9}>
                            {carregandoDetalhe ? <Skeleton height={120} />
                              : detalheDados?.erro ? <p className="erro-inline">{detalheDados.erro}</p>
                              : detalheDados ? <DetalheOp dados={detalheDados} />
                              : null}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function DetalheOp({ dados }) {
  const { grade, etapas } = dados;
  // monta matriz cor × tamanho
  const tamanhos = useMemo(() => {
    const s = new Set(); grade.forEach((g) => s.add(g.tamanho)); return [...s];
  }, [grade]);
  const porCor = useMemo(() => {
    const m = new Map();
    grade.forEach((g) => {
      if (!m.has(g.cor_descricao)) m.set(g.cor_descricao, {});
      m.get(g.cor_descricao)[g.tamanho] = g;
    });
    return m;
  }, [grade]);

  return (
    <div style={{ display: 'grid', gap: 16, padding: '8px 4px' }}>
      <div>
        <h3 className="card-titulo" style={{ marginBottom: 6 }}><Layers size={15} /> Grade (previsto / realizado)</h3>
        {grade.length === 0 ? (
          <p className="ink-faint">Grade ainda não sincronizada — ela chega no próximo ciclo (a leitura da grade é feita em lotes).</p>
        ) : (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th>Cor</th>{tamanhos.map((t) => <th key={t} className="num">{t}</th>)}<th className="num">Total</th></tr>
              </thead>
              <tbody>
                {[...porCor.entries()].map(([cor, linha]) => {
                  const tot = tamanhos.reduce((a, t) => a + (linha[t] ? Number(linha[t].qtd_prevista) : 0), 0);
                  return (
                    <tr key={cor}>
                      <td>{cor}</td>
                      {tamanhos.map((t) => {
                        const c = linha[t];
                        if (!c) return <td key={t} className="num ink-faint">—</td>;
                        const prev = Number(c.qtd_prevista), real = Number(c.qtd_realizada);
                        return (
                          <td key={t} className="num" title={`Previsto ${prev} · Realizado ${real}${Number(c.qtd_perda) ? ` · Perda ${c.qtd_perda}` : ''}${Number(c.qtd_ld) ? ` · 2ª ${c.qtd_ld}` : ''}`}>
                            {formatQtd(prev)}
                            {real !== prev && <span style={{ color: real >= prev ? 'var(--ok, green)' : 'var(--aviso, #b26b00)', fontSize: 11 }}> /{formatQtd(real)}</span>}
                          </td>
                        );
                      })}
                      <td className="num"><strong>{formatQtd(tot)}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <h3 className="card-titulo" style={{ marginBottom: 6 }}><Factory size={15} /> Onde estão as peças</h3>
        {etapas.length === 0 ? (
          <p className="ink-faint">Nenhuma etapa em produção no momento.</p>
        ) : (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th>Departamento / etapa</th><th className="num">Qtd</th><th>Entrada</th><th>Previsão</th><th>Situação</th></tr>
              </thead>
              <tbody>
                {etapas.map((e) => (
                  <tr key={e.dep_id}>
                    <td>{e.departamento}</td>
                    <td className="num">{formatQtd(e.qtd)}</td>
                    <td>{e.entrada ? dataBr(e.entrada) : <span className="ink-faint">—</span>}</td>
                    <td>{e.previsao ? dataBr(e.previsao) : <span className="ink-faint">sem previsão</span>}</td>
                    <td>{e.atrasado_real ? <span className="selo tone-ruim">atrasada</span> : <span className="selo tone-ok">no prazo</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
