import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Radar, AlertTriangle, Info, Inbox, ShieldCheck, ExternalLink, Settings2, Check,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd, pct } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, EstadoVazio, IndicadorDestaque, Select, Field, NumInput,
  Checkbox, BotaoExportar,
} from '../components/ui';

// Financeiro › Cobertura.
//
// A pergunta que esta tela existe para responder é uma só:
//
//     O QUE GEROU DINHEIRO NO SISTEMA E NÃO CHEGOU AO FINANCEIRO?
//
// Ela é a rede de segurança da ponte. A Caixa de Entrada mostra o que a ponte
// registrou; esta tela varre as TABELAS DE ORIGEM — ordens de serviço, pedidos
// de compra, notas, devoluções, vendas, repasses, custos fixos — e mostra o
// que não tem nem pendência nem título.
//
// A distinção importa: uma varredura que lesse os registros da própria ponte
// só saberia confirmar o que a ponte já sabe, e o que se procura aqui é
// justamente o que passou por fora dela.
//
// É também a rede que pega o PASSADO: todo documento anterior à ponte aparece
// aqui, porque nenhum deles passou por ela.
//
// ⚠️ Duas origens não têm varredura automática, e a tela DIZ isso em vez de
// deixar alguém concluir que está tudo coberto (REGRA 2).

const BASE = '/financeiro-ponte';
const mensagemErro = (err) => err?.data?.error || err?.message || 'Não deu para carregar.';
const iso = (v) => (v ? String(v).slice(0, 10) : '');

const COLUNAS_EXPORTACAO = [
  { chave: 'documento', rotulo: 'Documento' },
  { chave: 'origem_rotulo', rotulo: 'Origem' },
  { chave: 'modulo', rotulo: 'Módulo' },
  { chave: 'contraparte', rotulo: 'Contraparte' },
  { chave: 'valor', rotulo: 'Valor' },
  { chave: 'data', rotulo: 'Data' },
  { chave: 'natureza', rotulo: 'Natureza' },
];

// ---------------------------------------------------------------------------
// O catálogo: a regra de cada origem, editável sem deploy
// ---------------------------------------------------------------------------

// ⚠️ `Checkbox` e `DateInput` mantêm a API do <input> nativo: o `onChange`
// recebe o EVENTO, não o valor. Passar um setter direto (`onChange={setX}`)
// grava um objeto no estado e o campo para de funcionar sem erro nenhum — foi
// o que a passada em navegador pegou nesta rodada.
function Catalogo({ origens, plano, centros, onSalvo }) {
  const [editando, setEditando] = useState(null);
  const [rascunho, setRascunho] = useState({});
  const [erro, setErro] = useState('');

  async function salvar(codigo) {
    setErro('');
    try {
      await api.put(`${BASE}/origens/${codigo}`, rascunho);
      setEditando(null);
      onSalvo();
    } catch (err) { setErro(mensagemErro(err)); }
  }

  return (
    <div className="card">
      <div className="card-head"><Settings2 size={14} /> Os pontos do sistema que movem dinheiro</div>
      <p className="grafico-explicacao">
        Cada linha é um evento que cria ou extingue um compromisso de caixa. A categoria e o prazo são
        sugestão — quem lança pode trocar. Estoque, produção, qualidade e promoções não estão aqui de
        propósito: eles movem <em>custo do produto</em>, não caixa, e esse custo já foi pago quando a nota
        entrou. Criar título para eles contaria o mesmo dinheiro duas vezes.
      </p>
      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <th>Módulo</th><th>Origem</th><th>Natureza</th><th>Momento</th>
              <th>Categoria padrão</th><th>Prazo</th><th>Trava</th>
              <th>Na fila</th><th>Títulos</th><th className="no-print">Ação</th>
            </tr>
          </thead>
          <tbody>
            {origens.map((o) => {
              const emEdicao = editando === o.codigo;
              return (
                <tr key={o.codigo} className={o.ativo ? '' : 'linha-apagada'}>
                  <td>{o.modulo}</td>
                  <td>
                    <span className="cel-dupla">
                      <strong>{o.rotulo}</strong>
                      <small title={o.explicacao}>{(o.explicacao || '').slice(0, 90)}…</small>
                    </span>
                  </td>
                  <td>
                    <span className={`stamp sm ${o.natureza === 'receber' ? 'tone-saudavel' : 'tone-neutro'}`}>
                      {o.natureza === 'receber' ? 'a receber' : 'a pagar'}
                    </span>
                  </td>
                  <td>{o.momento === 'abertura' ? 'Na abertura (previsto)' : 'Na conclusão'}</td>
                  <td style={{ minWidth: 200 }}>
                    {emEdicao ? (
                      <Select
                        value={rascunho.plano_id ?? (o.plano_id || '')}
                        onChange={(e) => setRascunho((r) => ({ ...r, plano_id: e.target.value || null }))}
                      >
                        <option value="">Sem padrão</option>
                        {plano.filter((p) => p.analitica).map((p) => (
                          <option key={p.id} value={String(p.id)}>{p.codigo} — {p.nome}</option>
                        ))}
                      </Select>
                    ) : (o.plano_codigo ? `${o.plano_codigo} — ${o.plano_nome}` : '—')}
                  </td>
                  <td className="mono" style={{ minWidth: 110 }}>
                    {emEdicao ? (
                      <NumInput
                        step="1"
                        value={rascunho.prazo_padrao_dias ?? (o.prazo_padrao_dias ?? '')}
                        onChange={(v) => setRascunho((r) => ({ ...r, prazo_padrao_dias: v }))}
                      />
                    ) : (o.prazo_padrao_dias == null
                      ? <span title="Sem prazo padrão de propósito — inventar vencimento aqui viraria cobrança errada.">—</span>
                      : `${o.prazo_padrao_dias} d`)}
                  </td>
                  <td>
                    {emEdicao ? (
                      <Checkbox
                        checked={rascunho.bloqueia_conclusao ?? o.bloqueia_conclusao}
                        onChange={(e) => setRascunho((r) => ({ ...r, bloqueia_conclusao: e.target.checked }))}
                      />
                    ) : (o.bloqueia_conclusao
                      ? <span className="stamp sm tone-atencao">trava</span>
                      : <span className="mono">—</span>)}
                  </td>
                  <td className="mono">
                    {Number(o.pendencias_abertas) > 0 ? formatQtd(o.pendencias_abertas) : '—'}
                  </td>
                  <td className="mono">
                    {Number(o.titulos_gerados) > 0 ? formatQtd(o.titulos_gerados) : '—'}
                  </td>
                  <td className="no-print">
                    {emEdicao ? (
                      <span className="painel-acoes-inline">
                        <button type="button" className="btn btn-primary" onClick={() => salvar(o.codigo)}>
                          <Check size={13} /> Salvar
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => setEditando(null)}>Cancelar</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => { setEditando(o.codigo); setRascunho({}); }}
                      >
                        Ajustar
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataTable>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function CoberturaFinanceiraPage() {
  const [dados, setDados] = useState(null);
  const [origens, setOrigens] = useState([]);
  const [plano, setPlano] = useState([]);
  const [centros, setCentros] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [recarregar, setRecarregar] = useState(0);
  const [filtroOrigem, setFiltroOrigem] = useState('');
  const [importando, setImportando] = useState(false);
  const [mensagem, setMensagem] = useState('');

  const recarrega = useCallback(() => setRecarregar((n) => n + 1), []);

  useEffect(() => {
    api.get('/financeiro-nucleo/plano').then((r) => setPlano(Array.isArray(r) ? r : [])).catch(() => setPlano([]));
    api.get('/financeiro-nucleo/centros-custo').then((r) => setCentros(Array.isArray(r) ? r : [])).catch(() => setCentros([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    setErro('');
    Promise.all([
      api.get(`${BASE}/cobertura${filtroOrigem ? `?origem=${filtroOrigem}` : ''}`),
      api.get(`${BASE}/origens`),
    ])
      .then(([c, o]) => { setDados(c); setOrigens(Array.isArray(o) ? o : []); })
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [filtroOrigem, recarregar]);

  async function importar(origem) {
    setImportando(true);
    setMensagem('');
    setErro('');
    try {
      const r = await api.post(`${BASE}/cobertura/importar`, { origem: origem || null, limite: 200 });
      setMensagem(
        `${formatQtd(r.criadas)} documento(s) viraram pendência na Caixa de Entrada.`
        + (r.restam ? ' Ainda há mais — rode de novo para trazer o próximo lote.' : '')
      );
      recarrega();
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setImportando(false);
    }
  }

  const totais = useMemo(() => {
    const linhas = dados?.resumo || [];
    const documentos = linhas.reduce((s, l) => s + Number(l.documentos || 0), 0);
    const descobertos = linhas.reduce((s, l) => s + Number(l.descobertos || 0), 0);
    const valorDescoberto = linhas.reduce((s, l) => s + Number(l.valor_descoberto || 0), 0);
    const semValor = linhas.reduce((s, l) => s + Number(l.sem_valor || 0), 0);
    return {
      documentos,
      descobertos,
      valorDescoberto,
      semValor,
      fracao: documentos > 0 ? (documentos - descobertos) / documentos : null,
    };
  }, [dados]);

  const rotaDo = (d) => (d.rota ? d.rota.replace(':id', String(d.origem_id)) : null);

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Cobertura</h2>
          <p className="page-sub">
            O que moveu dinheiro no sistema e não chegou ao financeiro — nem como título, nem como
            pendência. A varredura lê as tabelas de origem, não os registros da ponte: uma varredura que
            lesse a própria ponte só saberia confirmar o que ela já sabe.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <button
            type="button"
            className="btn btn-primary"
            disabled={importando || !totais.descobertos}
            onClick={() => importar(filtroOrigem)}
          >
            <Inbox size={14} />
            {importando ? 'Trazendo…' : `Trazer ${filtroOrigem ? 'esta origem' : 'tudo'} para a Caixa de Entrada`}
          </button>
        </div>
      </div>

      {mensagem && <div className="aviso-compacto tone-saudavel"><Check size={14} /> {mensagem}</div>}
      {erro && <div className="aviso-compacto tone-prejuizo"><AlertTriangle size={14} /> {erro}</div>}

      <div className="indicadores-faixa stat-strip-fluida no-print">
        <IndicadorDestaque
          rotulo="Documentos que movem dinheiro"
          valor={loading ? '—' : formatQtd(totais.documentos)}
          explicacao="Todos os documentos das origens varridas: O.S. remetidas, pedidos aprovados, notas lançadas, compras, devoluções com dinheiro, vendas próprias faturadas, repasses pagos e custos fixos."
          Icone={Radar}
        />
        <IndicadorDestaque
          rotulo="Sem chegar ao financeiro"
          valor={loading ? '—' : formatQtd(totais.descobertos)}
          explicacao="Sem título e sem pendência. Documento anterior à ponte cai aqui por definição — foi feito antes de existir caminho."
          tom={totais.descobertos > 0 ? 'prejuizo' : 'saudavel'}
          Icone={AlertTriangle}
        />
        <IndicadorDestaque
          rotulo="Valor descoberto"
          valor={loading ? '—' : brl(totais.valorDescoberto)}
          explicacao={totais.semValor > 0
            ? `Soma só do que tem valor apurado. ${formatQtd(totais.semValor)} documento(s) sem valor não entram — o número real é maior.`
            : 'Soma do valor dos documentos que não chegaram ao financeiro.'}
          tom={totais.valorDescoberto > 0 ? 'prejuizo' : undefined}
        />
        <IndicadorDestaque
          rotulo="Cobertura"
          valor={totais.fracao == null ? '—' : pct(totais.fracao)}
          explicacao="Quanto dos documentos que movem dinheiro já tem contrapartida no financeiro. 100% é a meta; abaixo disso, a diferença é dinheiro que o DRE e o fluxo de caixa não enxergam."
          tom={totais.fracao === 1 ? 'saudavel' : 'atencao'}
          Icone={ShieldCheck}
        />
      </div>

      <div className="card">
        <div className="card-head">Por origem</div>
        <p className="grafico-explicacao">
          Clique numa linha para filtrar a lista abaixo e trazer só aquela origem.
        </p>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Módulo</th><th>Origem</th><th>Documentos</th><th>Descobertos</th>
                <th>Valor descoberto</th><th>Mais antigo</th>
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonLinhasTabela colunas={6} />}
              {!loading && (dados?.resumo || []).map((l) => (
                <tr
                  key={l.origem_codigo}
                  className="clickable-row"
                  onClick={() => setFiltroOrigem(l.origem_codigo === filtroOrigem ? '' : l.origem_codigo)}
                >
                  <td>{l.modulo}</td>
                  <td>{l.rotulo}</td>
                  <td className="mono">{formatQtd(l.documentos)}</td>
                  <td>
                    {Number(l.descobertos) > 0
                      ? <span className="stamp sm tone-prejuizo">{formatQtd(l.descobertos)}</span>
                      : <span className="stamp sm tone-saudavel">nenhum</span>}
                  </td>
                  <td className="mono">{l.valor_descoberto != null ? brl(l.valor_descoberto) : '—'}</td>
                  <td className="mono">{l.mais_antigo ? dataBr(iso(l.mais_antigo)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      </div>

      {dados?.semVarredura?.length > 0 && (
        <div className="card">
          <div className="card-head"><Info size={14} /> O que esta varredura NÃO alcança</div>
          <p className="grafico-explicacao">
            Está escrito porque o contrário — deixar de fora em silêncio — faria esta tela mentir por
            omissão justamente onde ela deveria ser mais confiável.
          </p>
          <ul className="lista-simples">
            {dados.semVarredura.map((s) => {
              const o = origens.find((x) => x.codigo === s.codigo);
              return <li key={s.codigo}><strong>{o?.rotulo || s.codigo}</strong> — {s.motivo}</li>;
            })}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">
            Documentos descobertos
            {filtroOrigem && ` — ${origens.find((o) => o.codigo === filtroOrigem)?.rotulo || filtroOrigem}`}
          </div>
          <div className="painel-acoes-inline">
            {filtroOrigem && (
              <button type="button" className="btn btn-ghost" onClick={() => setFiltroOrigem('')}>
                Ver todas as origens
              </button>
            )}
            <BotaoExportar
              nomeBase="cobertura-financeira"
              colunas={COLUNAS_EXPORTACAO}
              itens={dados?.descobertos || []}
              disabled={!dados?.descobertos?.length}
            />
          </div>
        </div>
        {dados?.truncado && (
          <div className="aviso-compacto tone-atencao">
            <AlertTriangle size={14} />
            A lista foi cortada em 500 documentos. Os indicadores acima contam todos — só esta tabela é que
            não mostra tudo de uma vez.
          </div>
        )}
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Documento</th><th>Origem</th><th>Contraparte</th>
                <th>Data</th><th>Valor</th><th>Natureza</th><th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonLinhasTabela colunas={7} />}
              {!loading && (dados?.descobertos || []).map((d) => (
                <tr key={`${d.origem_codigo}-${d.origem_id}`}>
                  <td>
                    <span className="cel-dupla">
                      <strong>{d.documento}</strong>
                      <small>{d.modulo}</small>
                    </span>
                  </td>
                  <td>{d.origem_rotulo}</td>
                  <td>{d.contraparte || '—'}</td>
                  <td className="mono">{d.data ? dataBr(iso(d.data)) : '—'}</td>
                  <td className="mono">
                    {d.valor != null ? brl(d.valor) : <span title="O documento não tem valor apurado. Não é zero.">—</span>}
                  </td>
                  <td>
                    <span className={`stamp sm ${d.natureza === 'receber' ? 'tone-saudavel' : 'tone-neutro'}`}>
                      {d.natureza === 'receber' ? 'a receber' : 'a pagar'}
                    </span>
                  </td>
                  <td className="no-print">
                    {rotaDo(d) && (
                      <Link className="btn btn-ghost" to={rotaDo(d)}>
                        <ExternalLink size={13} /> Abrir
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        {!loading && !dados?.descobertos?.length && (
          <EstadoVazio
            Icone={ShieldCheck}
            titulo="Tudo coberto"
            descricao="Todo documento que move dinheiro tem título ou pendência. Confira as duas origens sem varredura automática, listadas acima — elas não entram nesta conta."
          />
        )}
      </div>

      <Catalogo origens={origens} plano={plano} centros={centros} onSalvo={recarrega} />
    </div>
  );
}
