import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  History, ShieldAlert, LogIn, KeyRound, Pencil, PlusCircle, Trash2, Mail,
  CircleAlert, Send, RefreshCw,
} from 'lucide-react';
import { api } from '../api/client';
import DataTable from '../components/DataTable';
import {
  Field, Select, DateInput, CampoBusca, ChipsFiltros, Paginacao, EstadoVazio,
  SkeletonLinhasTabela, IndicadorDestaque, BotaoExportar, Checkbox,
} from '../components/ui';

// Histórico de alteração por usuário (varredura de segurança, 03/09/2026).
//
// Responde três perguntas que o sistema não sabia responder: quem mexeu nisso,
// quem entrou (ou tentou entrar) e quando, e o que exatamente mudou.
//
// A paginação é do SERVIDOR, não do useTabela: o histórico só cresce, e
// carregar tudo pro navegador ordenar travaria a tela em poucos meses.

const TAMANHOS = [50, 100, 200];

const ICONE_POR_ACAO = {
  criou: PlusCircle,
  alterou: Pencil,
  excluiu: Trash2,
  entrou: LogIn,
  saiu: LogIn,
  'pediu senha': KeyRound,
  'pediu usuário': Mail,
  testou: Send,
  'tentou configurar': ShieldAlert,
};

const ROTULO_ENTIDADE = {
  usuario: 'Usuários', usuarios: 'Usuários', senha: 'Senhas', sessao: 'Entradas no sistema',
  email: 'E-mail', produtos: 'Produtos', pedidos: 'Pedidos', estoque: 'Estoque',
  compras: 'Compras', fornecedores: 'Fornecedores', clientes: 'Clientes',
  financeiro: 'Financeiro', integracoes: 'Integrações', configuracoes: 'Configurações',
  calendario: 'Calendário', viagens: 'Viagens', kits: 'Kits', importacao: 'Importação',
  wik: 'Wik Sistemas', sistema: 'Sistema', grupos: 'Grupos', listas: 'Listas',
  empresas: 'Empresas', taxas: 'Taxas', 'taxas-venda': 'Taxas de venda',
  'custos-indiretos': 'Custos indiretos', 'marketplace-taxas': 'Taxas de marketplace',
  'produtos-marketplace': 'Produtos de marketplace', 'ficha-tecnica': 'Ficha técnica',
  simulacao: 'Simulador',
};

function rotuloEntidade(e) {
  if (!e) return '—';
  const raiz = String(e).split('/')[0];
  return ROTULO_ENTIDADE[raiz] || raiz;
}

function dataHora(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

const hoje = () => new Date().toISOString().slice(0, 10);
function diasAtras(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Mostra só o que mudou, campo a campo, em vez de despejar JSON na tela.
function ResumoMudanca({ antes, depois }) {
  const chaves = [...new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})])];
  if (chaves.length === 0) return null;
  const mostrar = (v) => (v === null || v === undefined ? '(vazio)' : typeof v === 'string' ? v : JSON.stringify(v));
  return (
    <ul style={{ margin: '7px 0 2px', paddingLeft: 16, fontSize: 12, lineHeight: 1.8, color: 'var(--ink-soft)' }}>
      {chaves.slice(0, 10).map((k) => (
        <li key={k}>
          <strong>{k}</strong>:{' '}
          {antes && k in antes && (
            <span className="mono" style={{ textDecoration: 'line-through', opacity: 0.65 }}>{mostrar(antes[k])}</span>
          )}
          {antes && depois && k in antes && k in depois ? ' → ' : null}
          {depois && k in depois && <span className="mono">{mostrar(depois[k])}</span>}
        </li>
      ))}
      {chaves.length > 10 && <li>… e mais {chaves.length - 10} campo(s)</li>}
    </ul>
  );
}

export default function HistoricoPage() {
  const [dados, setDados] = useState({ registros: [], total: 0 });
  const [opcoes, setOpcoes] = useState({ acoes: [], entidades: [], usuarios: [] });
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aberto, setAberto] = useState(null);

  const [pagina, setPagina] = useState(1);
  const [tamanho, setTamanho] = useState(100);
  const [usuarioId, setUsuarioId] = useState('');
  const [acao, setAcao] = useState('');
  const [entidade, setEntidade] = useState('');
  const [somenteFalhas, setSomenteFalhas] = useState(false);
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [dataInicio, setDataInicio] = useState(diasAtras(30));
  const [dataFim, setDataFim] = useState(hoje());

  // Diagnóstico do e-mail. Fica no topo desta tela porque é aqui que alguém
  // vem quando uma pessoa diz "pedi a redefinição e não chegou nada".
  const [smtp, setSmtp] = useState(null);
  const [testando, setTestando] = useState(false);
  const [avisoEmail, setAvisoEmail] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const q = new URLSearchParams({ pagina: String(pagina), tamanho: String(tamanho) });
      if (usuarioId) q.set('usuario_id', usuarioId);
      if (acao) q.set('acao', acao);
      if (entidade) q.set('entidade', entidade);
      if (somenteFalhas) q.set('somente_falhas', '1');
      if (buscaAplicada.trim()) q.set('busca', buscaAplicada.trim());
      if (dataInicio) q.set('data_inicio', dataInicio);
      if (dataFim) q.set('data_fim', dataFim);
      setDados(await api.get(`/auditoria?${q.toString()}`));
    } catch (err) {
      setErro(err.message);
    } finally {
      setCarregando(false);
    }
  }, [pagina, tamanho, usuarioId, acao, entidade, somenteFalhas, buscaAplicada, dataInicio, dataFim]);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    api.get('/auditoria/filtros').then(setOpcoes).catch(() => {});
    api.get('/email/status').then(setSmtp).catch(() => {});
  }, []);

  // Mudar filtro volta pra primeira página — senão a pessoa fica olhando a
  // página 7 de um resultado que agora tem 2.
  useEffect(() => { setPagina(1); }, [usuarioId, acao, entidade, somenteFalhas, buscaAplicada, dataInicio, dataFim, tamanho]);

  const chips = useMemo(() => {
    const itens = [];
    if (usuarioId) {
      const u = opcoes.usuarios.find((x) => String(x.id) === String(usuarioId));
      itens.push({ chave: 'u', rotulo: 'Usuário', valor: u?.nome || usuarioId, onRemover: () => setUsuarioId('') });
    }
    if (acao) itens.push({ chave: 'a', rotulo: 'Ação', valor: acao, onRemover: () => setAcao('') });
    if (entidade) itens.push({ chave: 'e', rotulo: 'Área', valor: rotuloEntidade(entidade), onRemover: () => setEntidade('') });
    if (somenteFalhas) itens.push({ chave: 'f', rotulo: 'Mostrando', valor: 'só o que falhou', onRemover: () => setSomenteFalhas(false) });
    if (buscaAplicada.trim()) {
      itens.push({ chave: 'b', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } });
    }
    return itens;
  }, [usuarioId, acao, entidade, somenteFalhas, buscaAplicada, opcoes.usuarios]);

  const falhasNaTela = dados.registros.filter((r) => !r.sucesso).length;
  const entradasNaTela = dados.registros.filter((r) => r.entidade === 'sessao').length;
  const totalPaginas = Math.max(1, Math.ceil(dados.total / tamanho));
  const inicio = (pagina - 1) * tamanho;

  async function testarEmail() {
    setTestando(true);
    setAvisoEmail('');
    try {
      const r = await api.post('/email/teste', {});
      setAvisoEmail(r.mensagem || 'E-mail de teste enviado.');
    } catch (err) {
      setAvisoEmail(err.message);
    } finally {
      setTestando(false);
      api.get('/email/status').then(setSmtp).catch(() => {});
    }
  }

  return (
    <div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Tudo que muda no sistema fica registrado aqui: quem fez, o quê, quando e de qual endereço.
        Entradas no sistema e tentativas que falharam também aparecem — é por aqui que se percebe
        se alguém está tentando adivinhar uma senha. O histórico começou a ser gravado na
        atualização de segurança; nada anterior a ela existe.
      </p>

      {smtp && (
        <div
          className="card"
          style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            marginBottom: 16, borderLeft: `3px solid var(${smtp.ok ? '--success' : '--warning'})`,
          }}
        >
          <Mail size={17} style={{ color: `var(${smtp.ok ? '--success' : '--warning'})`, flexShrink: 0 }} />
          <div style={{ flex: '1 1 320px', fontSize: 13, lineHeight: 1.6 }}>
            {smtp.ok ? (
              <>
                <strong>Envio de e-mail funcionando.</strong> Servidor {smtp.servidor}, remetente{' '}
                {smtp.remetente}. A recuperação de senha e o lembrete de usuário chegam normalmente.
              </>
            ) : (
              <>
                <strong>O envio de e-mail não está funcionando.</strong> {smtp.motivo}
                {' '}Enquanto estiver assim, quem pedir “esqueci minha senha” não recebe nada, e a
                única saída é um administrador definir a senha na aba Usuários.
              </>
            )}
          </div>
          <button type="button" className="btn btn-ghost" onClick={testarEmail} disabled={testando}>
            <Send size={14} /> {testando ? 'Enviando…' : 'Enviar e-mail de teste'}
          </button>
        </div>
      )}
      {avisoEmail && <div className="aviso-compacto" style={{ marginBottom: 14 }}>{avisoEmail}</div>}

      <div className="indicadores-faixa" style={{ marginBottom: 16 }}>
        <IndicadorDestaque
          rotulo="Registros no período"
          valor={dados.total.toLocaleString('pt-BR')}
          explicacao="Total de ações gravadas dentro dos filtros escolhidos. É sobre esta base que os outros números falam."
          Icone={History}
        />
        <IndicadorDestaque
          rotulo="Entradas nesta página"
          valor={entradasNaTela}
          explicacao="Logins e saídas entre os registros mostrados agora. Zero aqui não quer dizer zero no período — só nesta página."
          Icone={LogIn}
        />
        <IndicadorDestaque
          rotulo="Falhas nesta página"
          valor={falhasNaTela}
          explicacao="Ações recusadas: senha errada, acesso negado, e-mail que não saiu. Várias seguidas no mesmo nome merecem atenção."
          tom={falhasNaTela > 0 ? 'atencao' : undefined}
          Icone={CircleAlert}
        />
      </div>

      <div className="filtros-barra">
        <div className="filtros-barra-busca">
          <CampoBusca
            valor={busca}
            onChange={setBusca}
            onSubmit={(v) => setBuscaAplicada(v === '' ? '' : busca)}
            placeholder="Buscar por pessoa, descrição, registro…"
          />
        </div>
        <Field label="Usuário">
          <Select value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)}>
            <option value="">Todos</option>
            {opcoes.usuarios.map((u) => <option key={u.id} value={String(u.id)}>{u.nome}</option>)}
          </Select>
        </Field>
        <Field label="Ação">
          <Select value={acao} onChange={(e) => setAcao(e.target.value)}>
            <option value="">Todas</option>
            {opcoes.acoes.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </Field>
        <Field label="Área">
          <Select value={entidade} onChange={(e) => setEntidade(e.target.value)}>
            <option value="">Todas</option>
            {opcoes.entidades.map((e) => <option key={e} value={e}>{rotuloEntidade(e)}</option>)}
          </Select>
        </Field>
        <Field label="De">
          <DateInput value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
        </Field>
        <Field label="Até">
          <DateInput value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
        </Field>
        <Field label="Só o que falhou">
          <Checkbox checked={somenteFalhas} onChange={(e) => setSomenteFalhas(e.target.checked)} />
        </Field>
        <button type="button" className="btn btn-ghost" onClick={carregar}>
          <RefreshCw size={14} /> Atualizar
        </button>
        <BotaoExportar
          nomeBase="historico-hbn-hub"
          colunas={[
            { chave: 'criado_em', titulo: 'Quando' },
            { chave: 'usuario_nome', titulo: 'Quem' },
            { chave: 'acao', titulo: 'Ação' },
            { chave: 'entidade', titulo: 'Área' },
            { chave: 'entidade_id', titulo: 'Registro' },
            { chave: 'descricao', titulo: 'O que aconteceu' },
            { chave: 'ip', titulo: 'Endereço' },
            { chave: 'sucesso', titulo: 'Deu certo?' },
          ]}
          itens={dados.registros}
          disabled={dados.registros.length === 0}
        />
      </div>

      <ChipsFiltros
        itens={chips}
        onLimparTudo={() => {
          setUsuarioId(''); setAcao(''); setEntidade(''); setSomenteFalhas(false);
          setBusca(''); setBuscaAplicada('');
        }}
      />

      {erro && <div className="aviso-compacto tone-prejuizo" style={{ marginBottom: 12 }}>{erro}</div>}

      <Paginacao
        pagina={pagina} totalPaginas={totalPaginas} tamanho={tamanho} tamanhos={TAMANHOS}
        totalItens={dados.total} inicio={inicio} fim={Math.min(inicio + dados.registros.length, dados.total)}
        setPagina={setPagina} setTamanho={setTamanho} posicao="topo"
      />

      <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 132 }}>Quando</th>
              <th style={{ width: 130 }}>Quem</th>
              <th style={{ width: 118 }}>Ação</th>
              <th style={{ width: 150 }}>Área</th>
              <th>O que aconteceu</th>
              <th style={{ width: 118 }}>Endereço</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <SkeletonLinhasTabela colunas={6} linhas={8} />
            ) : dados.registros.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EstadoVazio
                    Icone={History}
                    titulo="Nada registrado nesse período"
                    descricao="Mude as datas ou limpe os filtros. Lembrando que o histórico só existe a partir da atualização de segurança — o que aconteceu antes dela não foi gravado."
                  />
                </td>
              </tr>
            ) : (
              dados.registros.map((r) => {
                const Icone = ICONE_POR_ACAO[r.acao] || Pencil;
                const temDetalhe = Boolean(r.dados_antes || r.dados_depois);
                return (
                  <tr
                    key={r.id}
                    onClick={() => temDetalhe && setAberto(aberto === r.id ? null : r.id)}
                    style={{ cursor: temDetalhe ? 'pointer' : 'default' }}
                  >
                    <td className="mono">{dataHora(r.criado_em)}</td>
                    <td>{r.usuario_nome_atual || r.usuario_nome || <span style={{ opacity: 0.55 }}>—</span>}</td>
                    <td>
                      <Icone size={12} style={{ verticalAlign: -2, marginRight: 5, opacity: 0.7 }} />
                      {r.acao}
                    </td>
                    <td>
                      {rotuloEntidade(r.entidade)}
                      {r.entidade_id && <span className="mono" style={{ opacity: 0.55 }}> #{r.entidade_id}</span>}
                    </td>
                    <td>
                      {!r.sucesso && (
                        <ShieldAlert size={12} style={{ verticalAlign: -2, marginRight: 5, color: 'var(--danger)' }} />
                      )}
                      <span style={!r.sucesso ? { color: 'var(--danger)' } : undefined}>
                        {r.descricao || <span className="mono">{r.metodo} {r.rota}</span>}
                      </span>
                      {aberto === r.id && <ResumoMudanca antes={r.dados_antes} depois={r.dados_depois} />}
                      {temDetalhe && aberto !== r.id && (
                        <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 6 }}>clique para ver o que mudou</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.ip || '—'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </DataTable>

      <Paginacao
        pagina={pagina} totalPaginas={totalPaginas} tamanho={tamanho} tamanhos={TAMANHOS}
        totalItens={dados.total} inicio={inicio} fim={Math.min(inicio + dados.registros.length, dados.total)}
        setPagina={setPagina} setTamanho={setTamanho}
      />

      <p className="page-sub" style={{ fontSize: 12, marginTop: 16 }}>
        O nome de quem fez a ação é guardado junto do registro: se a conta for excluída depois, o
        histórico continua dizendo quem foi. Senha, token de marketplace e chave de integração
        nunca são gravados aqui — no lugar deles aparece “••• (não guardado)”.
      </p>
    </div>
  );
}
