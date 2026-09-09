import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2, ChevronDown, ChevronRight, FileUp, Users } from 'lucide-react';
import { api } from '../api/client';
import { Select, DateInput, Checkbox, Toggle, FileTypeIcon } from './ui';
import { confirmar } from './ConfirmDialog';
import FotoProduto from './FotoProduto';
import FileDropzone from './FileDropzone';
import GradeVariacoes from './GradeVariacoes';
import { dataBr } from '../lib/format';

const STATUS_OPCOES = [
  { valor: 'nao_iniciado', rotulo: 'Não iniciado' },
  { valor: 'em_andamento', rotulo: 'Em andamento' },
  { valor: 'concluido', rotulo: 'Concluído' },
  { valor: 'cancelado', rotulo: 'Cancelado' },
];
const PRIORIDADE_OPCOES = [
  { valor: 'baixa', rotulo: 'Baixa' },
  { valor: 'media', rotulo: 'Média' },
  { valor: 'alta', rotulo: 'Alta' },
];

// Corte e Meta têm formulário próprio (campos bem específicos, com busca de
// fornecedor/produto etc.) — qualquer outro modelo cai no motor genérico
// abaixo, guiado só pela definição de campos do modelo (nome/tipo/opções).
const NOMES_TEMPLATE_FIXOS = ['Previsão de chegada de corte', 'Meta'];

function CampoGenerico({ campo, valor, onChange, disabled }) {
  const label = campo.nome + (campo.obrigatorio ? ' *' : '');
  if (campo.tipo === 'numero') {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <input type="number" value={valor ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </div>
    );
  }
  if (campo.tipo === 'data') {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <DateInput value={valor || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </div>
    );
  }
  if (campo.tipo === 'booleano') {
    return (
      <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Checkbox checked={Boolean(valor)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        {label}
      </label>
    );
  }
  if (campo.tipo === 'select') {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <Select value={valor || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {(campo.opcoesResolvidas || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      </div>
    );
  }
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <input value={valor || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    </div>
  );
}

// Recolhível genérico ("Detalhes avançados") — fechado por padrão, pra
// campos secundários (hoje só Categoria) não competirem com
// título/data/status na primeira tela do formulário.
function SecaoRecolhivel({ titulo, aberto, onToggle, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <button type="button" className="secao-recolhivel-cabecalho" onClick={onToggle}>
        {aberto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {titulo}
      </button>
      {aberto && <div className="secao-recolhivel-corpo">{children}</div>}
    </div>
  );
}

function useDebounce(valor, ms) {
  const [debounced, setDebounced] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return debounced;
}

// Select-com-busca que dispara uma função de busca no servidor em vez de
// filtrar uma lista já carregada (produto/fornecedor podem ter centenas de
// linhas — não faz sentido trazer tudo de uma vez só pra vincular um evento).
function BuscaAssincrona({ buscarFn, valor, aoEscolher, rotuloVazio, renderOpcao }) {
  const [termo, setTermo] = useState('');
  const termoDebounced = useDebounce(termo, 300);
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);

  useEffect(() => {
    if (!termoDebounced || termoDebounced.trim().length < 2) { setResultados([]); return; }
    setBuscando(true);
    buscarFn(termoDebounced).then(setResultados).finally(() => setBuscando(false));
  }, [termoDebounced]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {valor ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
          {renderOpcao(valor)}
          <button type="button" className="btn btn-ghost" onClick={() => aoEscolher(null)}>Trocar</button>
        </div>
      ) : (
        <>
          <input
            placeholder={rotuloVazio}
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
          />
          {buscando && <p className="page-sub" style={{ margin: '4px 0' }}>Buscando…</p>}
          {resultados.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto' }}>
              {resultados.map((r) => (
                <div
                  key={r.id}
                  onClick={() => { aoEscolher(r); setTermo(''); setResultados([]); }}
                  style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border-soft)' }}
                  className="busca-assincrona-item"
                >
                  {renderOpcao(r)}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Adiciona itens de uma lista (usuário ou usuário+grupo) um de cada vez via
// Select, mostra os já escolhidos como linha com nome + botão de remover —
// e, quando `comNivel` é true, um toggle visualizar/editar por linha
// (usado no seletor de visibilidade do evento).
function SeletorMultiplo({ usuarios, grupos, itens, onChange, comNivel }) {
  const [selecaoAtual, setSelecaoAtual] = useState('');

  function chaveDe(item) { return item.grupoId ? `g${item.grupoId}` : `u${item.usuarioId}`; }

  function adicionar(valor) {
    if (!valor) return;
    const [tipo, id] = valor.split(':');
    const novoItem = tipo === 'grupo'
      ? { grupoId: Number(id), nivel: 'visualizar' }
      : { usuarioId: Number(id), nivel: 'visualizar' };
    if (itens.some((i) => chaveDe(i) === chaveDe(novoItem))) { setSelecaoAtual(''); return; }
    onChange([...itens, novoItem]);
    setSelecaoAtual('');
  }

  function remover(item) {
    onChange(itens.filter((i) => chaveDe(i) !== chaveDe(item)));
  }

  function mudarNivel(item, nivel) {
    onChange(itens.map((i) => (chaveDe(i) === chaveDe(item) ? { ...i, nivel } : i)));
  }

  function nomeDe(item) {
    if (item.grupoId) return grupos.find((g) => g.id === item.grupoId)?.nome || '—';
    return usuarios.find((u) => u.id === item.usuarioId)?.nome || '—';
  }

  return (
    <div>
      <Select value={selecaoAtual} onChange={(e) => adicionar(e.target.value)} placeholder="Adicionar…">
        {grupos.length > 0 && (
          <optgroup label="Grupos">
            {grupos.map((g) => <option key={`g${g.id}`} value={`grupo:${g.id}`}>{g.nome}</option>)}
          </optgroup>
        )}
        <optgroup label="Pessoas">
          {usuarios.map((u) => <option key={`u${u.id}`} value={`usuario:${u.id}`}>{u.nome}</option>)}
        </optgroup>
      </Select>
      {itens.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {itens.map((item) => (
            <div key={chaveDe(item)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>{item.grupoId ? `👥 ${nomeDe(item)}` : nomeDe(item)}</span>
              {comNivel && (
                <Select value={item.nivel} onChange={(e) => mudarNivel(item, e.target.value)} style={{ maxWidth: 130 }}>
                  <option value="visualizar">Visualizar</option>
                  <option value="editar">Editar</option>
                </Select>
              )}
              <button type="button" className="icon-btn" onClick={() => remover(item)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CAMPOS_EXTRA_VAZIOS = {};

export default function EventoCalendarioModal({ eventoId, dataPadrao, onClose, onSalvo }) {
  const [carregando, setCarregando] = useState(Boolean(eventoId));
  const [templates, setTemplates] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [grupos, setGrupos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [tiposAdicao, setTiposAdicao] = useState([]);
  const [novaCategoria, setNovaCategoria] = useState('');

  const [templateId, setTemplateId] = useState(null);
  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [categoria, setCategoria] = useState('');
  const [dataInicio, setDataInicio] = useState(dataPadrao || '');
  const [dataPrevistaFim, setDataPrevistaFim] = useState(dataPadrao || '');
  const [dataConclusaoReal, setDataConclusaoReal] = useState('');
  const [status, setStatus] = useState('nao_iniciado');
  const [prioridade, setPrioridade] = useState('media');
  const [produto, setProduto] = useState(null);
  const [campoExtra, setCampoExtra] = useState(CAMPOS_EXTRA_VAZIOS);
  const [fornecedor, setFornecedor] = useState(null);
  const [responsaveisIds, setResponsaveisIds] = useState([]);
  const [permissoes, setPermissoes] = useState([]);
  const [variantesSugeridas, setVariantesSugeridas] = useState([]);
  const [anexos, setAnexos] = useState([]);
  const [comentarios, setComentarios] = useState([]);
  const [novoComentario, setNovoComentario] = useState('');
  const [podeEditar, setPodeEditar] = useState(true);
  const [avancadoAberto, setAvancadoAberto] = useState(false);

  // Grade de variações (Seção 1) — opções vindas das mesmas fontes
  // pré-prontas do sistema usadas pelo campo 'select' de modelo (Seção 2).
  const [usaGrade, setUsaGrade] = useState(false);
  const [grade, setGrade] = useState([]);
  const [coresOpcoes, setCoresOpcoes] = useState([]);
  const [tamanhosOpcoes, setTamanhosOpcoes] = useState([]);
  const [fornecedoresTodos, setFornecedoresTodos] = useState([]);

  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  // ------------------------------------------------------------------
  // Rascunho: sair sem terminar e retomar depois
  // ------------------------------------------------------------------
  // `snapshotInicial` é o formulário como ele estava assim que abriu. Tudo o
  // que a tela chama de "não salvo" é a comparação com isso — não um
  // sinalizador levantado no primeiro clique, que acusaria alteração até em
  // quem só abriu e fechou.
  const snapshotInicial = useRef(null);
  const [importandoOp, setImportandoOp] = useState(false);
  const [avisosOp, setAvisosOp] = useState([]);
  const [resumoOp, setResumoOp] = useState(null);
  const [retomouRascunho, setRetomouRascunho] = useState(false);
  // Enquanto for `false`, o formulário ainda não sabe se existe um rascunho
  // daquela data — e por isso não tira a "foto" inicial nem deixa fechar
  // achando que nada mudou. Evento já existente não tem rascunho: nasce
  // verificado.
  const [rascunhoVerificado, setRascunhoVerificado] = useState(Boolean(eventoId) || !dataPadrao);

  const template = useMemo(() => templates.find((t) => t.id === templateId) || null, [templates, templateId]);
  const nomeTemplate = template?.nome || '';
  // Toggle da grade só aparece pro modelo fixo "Corte" (formulário próprio,
  // sem motor genérico) ou pra qualquer modelo que declare um campo tipo
  // 'grade' no construtor (Seção 2) — nunca pra "evento simples" ou modelo
  // sem essa declaração explícita.
  const templateTemGrade = nomeTemplate === 'Previsão de chegada de corte'
    || (template?.campos || []).some((c) => c.tipo === 'grade');

  useEffect(() => {
    Promise.all([
      api.get('/calendario/templates'),
      api.get('/calendario/usuarios'),
      api.get('/grupos'),
      api.get('/listas/calendario_categoria'),
      api.get('/listas/calendario_tipo_adicao'),
      api.get('/calendario/cores-distintas'),
      api.get('/calendario/tamanhos-distintos'),
      api.get('/calendario/fornecedores'),
    ]).then(([t, u, g, cat, tipos, cores, tamanhos, fornecedores]) => {
      setTemplates(t);
      setUsuarios(u);
      setGrupos(g.filter((gr) => gr.ativo));
      setCategorias(cat);
      setTiposAdicao(tipos);
      setCoresOpcoes(cores);
      setTamanhosOpcoes(tamanhos);
      setFornecedoresTodos(fornecedores);
    });
  }, []);

  // Resolve a fonte pré-pronta de um campo 'select' de modelo genérico EM
  // TEMPO REAL (nunca a lista estática gravada no modelo) — se a lista de
  // cores/tamanhos/fornecedores mudar depois, o campo acompanha sozinho.
  function opcoesResolvidasCampo(campo) {
    if (!campo.fonte || campo.fonte === 'custom') return campo.opcoes || [];
    if (campo.fonte === 'cores') return coresOpcoes;
    if (campo.fonte === 'tamanhos') return tamanhosOpcoes;
    if (campo.fonte === 'fornecedores') return fornecedoresTodos.map((f) => f.nome_fantasia || f.nome);
    if (campo.fonte === 'categorias') return categorias.map((c) => c.valor);
    if (campo.fonte === 'responsaveis') return usuarios.map((u) => u.nome);
    return [];
  }

  function alternarUsaGrade(ligado) {
    setUsaGrade(ligado);
    if (ligado && grade.length === 0 && variantesSugeridas.length > 0) {
      setGrade(variantesSugeridas.map((v) => ({ cor: v.cor, tamanho: v.tamanho, quantidade: '' })));
    }
  }

  useEffect(() => {
    if (!eventoId) return;
    api.get(`/calendario/eventos/${eventoId}`).then((e) => {
      setTemplateId(e.template_id);
      setTitulo(e.titulo);
      setDescricao(e.descricao || '');
      setCategoria(e.categoria || '');
      setDataInicio(e.data_inicio ? e.data_inicio.slice(0, 10) : '');
      setDataPrevistaFim(e.data_prevista_fim.slice(0, 10));
      setDataConclusaoReal(e.data_conclusao_real ? e.data_conclusao_real.slice(0, 10) : '');
      setStatus(e.status);
      setPrioridade(e.prioridade);
      setProduto(e.produto ? { id: e.produto.id, referencia: e.produto.referencia, descricao: e.produto.descricao, tem_foto: e.produto.tem_foto } : null);
      setCampoExtra(e.campos_extra || {});
      setResponsaveisIds(e.responsaveis.map((r) => r.id));
      setPermissoes((e.permissoes || []).map((p) => (
        p.grupo_id ? { grupoId: p.grupo_id, nivel: p.nivel } : { usuarioId: p.usuario_id, nivel: p.nivel }
      )));
      setAnexos(e.anexos || []);
      setComentarios(e.comentarios || []);
      setPodeEditar(e.podeEditar);
      setUsaGrade(Boolean(e.usa_grade));
      setGrade((e.grade || []).map((g) => ({ cor: g.cor, tamanho: g.tamanho, quantidade: g.quantidade })));
      if (e.categoria) setAvancadoAberto(true); // já tinha categoria escolhida — abre a seção pra não esconder um valor já preenchido
      if (e.campos_extra?.fornecedor_id) {
        setFornecedor({ id: e.campos_extra.fornecedor_id, nome: e.campos_extra.fornecedor_nome || `Fornecedor #${e.campos_extra.fornecedor_id}` });
      }
      setCarregando(false);
    }).catch((err) => { setErro(err.message); setCarregando(false); });
  }, [eventoId]);

  // Evento inacabado daquela data (ver 0046_calendario_rascunho.sql). Roda uma
  // vez, na abertura de um evento NOVO. O servidor já devolve "não existe"
  // pro rascunho vencido (mais de 1 semana), então aqui não há conta de prazo
  // nenhuma — a regra mora num lugar só.
  useEffect(() => {
    if (eventoId || !dataPadrao) return;
    let cancelado = false;
    api.get(`/calendario/rascunhos/${dataPadrao}`)
      .then(async (r) => {
        if (cancelado || !r?.existe) { setRascunhoVerificado(true); return; }
        const quando = r.atualizado_em ? dataBr(String(r.atualizado_em).slice(0, 10)) : 'outro dia';
        const retomar = await confirmar(
          `Você tem um evento desta data que ficou pela metade (parou em ${quando}). Quer continuar de onde parou ou começar um novo?`,
          {
            titulo: 'Evento não terminado',
            perigo: false,
            confirmarTexto: 'Continuar de onde parei',
            cancelarTexto: 'Começar um novo',
          }
        );
        if (cancelado) return;
        if (retomar) {
          aplicarCorpo(r.dados);
          setRetomouRascunho(true);
        }
        // Escolhendo "começar um novo", o rascunho NÃO é apagado aqui de
        // propósito: fechar a janela por engano não pode custar o trabalho
        // guardado. Ele é substituído na próxima saída sem salvar, e some
        // sozinho quando um evento daquela data é salvo de verdade.
        setRascunhoVerificado(true);
      })
      .catch(() => { if (!cancelado) setRascunhoVerificado(true); });
    return () => { cancelado = true; };
  }, [eventoId, dataPadrao]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!produto?.id) { setVariantesSugeridas([]); return; }
    api.get(`/calendario/produtos/${produto.id}/variantes-sugeridas`).then(setVariantesSugeridas).catch(() => setVariantesSugeridas([]));
  }, [produto?.id]);

  async function escolherProduto(p) {
    setProduto(p);
    if (p && !campoExtra.referencia_texto) {
      setCampoExtra((atual) => ({ ...atual, referencia_texto: p.referencia }));
    }
  }

  async function adicionarCategoria() {
    if (!novaCategoria.trim()) return;
    try {
      const nova = await api.post('/listas/calendario_categoria', { valor: novaCategoria.trim() });
      setCategorias((atual) => [...atual, nova]);
      setCategoria(nova.valor);
      setNovaCategoria('');
    } catch (err) {
      setErro(err.message);
    }
  }

  function atualizarCampoExtra(nome, valor) {
    setCampoExtra((atual) => ({ ...atual, [nome]: valor }));
  }

  // O formulário inteiro num objeto só. Serve pra três coisas ao mesmo tempo:
  // mandar pro servidor ao salvar, guardar como rascunho ao sair sem salvar,
  // e comparar com o estado inicial pra saber se há mudança pendente. Uma
  // fonte só evita o clássico "o rascunho salvou um campo a menos que o save".
  function montarCorpo() {
    const campos_extra = { ...campoExtra };
    if (fornecedor) { campos_extra.fornecedor_id = fornecedor.id; campos_extra.fornecedor_nome = fornecedor.nome; }
    return {
      template_id: templateId,
      titulo: titulo.trim(),
      descricao: descricao.trim() || null,
      categoria: categoria || null,
      data_inicio: dataInicio || null,
      data_prevista_fim: dataPrevistaFim,
      data_conclusao_real: status === 'concluido' ? (dataConclusaoReal || new Date().toISOString().slice(0, 10)) : null,
      status,
      prioridade,
      produto_id: produto?.id || null,
      // O produto vai junto (não só o id) porque o rascunho precisa
      // reconstruir o cartão do produto sem uma busca a mais ao retomar.
      produto_snapshot: produto || null,
      campos_extra,
      responsaveis_ids: responsaveisIds,
      permissoes: permissoes.map((p) => (
        p.grupoId ? { grupo_id: p.grupoId, nivel: p.nivel } : { usuario_id: p.usuarioId, nivel: p.nivel }
      )),
      usa_grade: templateTemGrade && usaGrade,
      grade: templateTemGrade && usaGrade ? grade.filter((l) => l.cor || l.tamanho) : [],
    };
  }

  function aplicarCorpo(dados) {
    if (!dados) return;
    setTemplateId(dados.template_id ?? null);
    setTitulo(dados.titulo || '');
    setDescricao(dados.descricao || '');
    setCategoria(dados.categoria || '');
    setDataInicio(dados.data_inicio || '');
    setDataPrevistaFim(dados.data_prevista_fim || '');
    setDataConclusaoReal(dados.data_conclusao_real || '');
    setStatus(dados.status || 'nao_iniciado');
    setPrioridade(dados.prioridade || 'media');
    setProduto(dados.produto_snapshot || null);
    setCampoExtra(dados.campos_extra || {});
    setResponsaveisIds(dados.responsaveis_ids || []);
    setPermissoes((dados.permissoes || []).map((p) => (
      p.grupo_id ? { grupoId: p.grupo_id, nivel: p.nivel } : { usuarioId: p.usuario_id, nivel: p.nivel }
    )));
    setUsaGrade(Boolean(dados.usa_grade));
    setGrade(dados.grade || []);
    if (dados.campos_extra?.fornecedor_id) {
      setFornecedor({ id: dados.campos_extra.fornecedor_id, nome: dados.campos_extra.fornecedor_nome || `Fornecedor #${dados.campos_extra.fornecedor_id}` });
    }
    if (dados.categoria) setAvancadoAberto(true);
  }

  // Chave do rascunho: a data que a pessoa escolheu no calendário. Só existe
  // pra evento NOVO — editar um evento já salvo não gera rascunho, porque o
  // que está no banco continua valendo mesmo se ela fechar a janela.
  const chaveRascunho = !eventoId ? (dataPadrao || '') : '';

  // Guarda a "foto" do formulário recém-aberto, uma vez só, depois que os
  // dados terminaram de entrar (evento carregado, ou rascunho aplicado).
  useEffect(() => {
    if (carregando) return;
    if (snapshotInicial.current !== null) return;
    // Os modelos precisam ter chegado: `templateTemGrade` depende deles, e uma
    // foto tirada antes disso mostraria "usa_grade: false" num evento que usa
    // grade — e a janela acusaria alteração pendente em quem só abriu e fechou.
    if (templates.length === 0) return;
    if (!eventoId && chaveRascunho && !rascunhoVerificado) return; // espera a pergunta do rascunho
    snapshotInicial.current = JSON.stringify(montarCorpo());
  }); // eslint-disable-line react-hooks/exhaustive-deps

  function temAlteracaoPendente() {
    if (snapshotInicial.current === null) return false;
    return JSON.stringify(montarCorpo()) !== snapshotInicial.current;
  }

  async function salvar() {
    if (!titulo.trim() || !dataPrevistaFim) {
      setErro('Preencha ao menos o título e a data prevista de fim.');
      return;
    }
    if (template && !NOMES_TEMPLATE_FIXOS.includes(nomeTemplate)) {
      const faltando = template.campos.find((c) => c.tipo !== 'grade' && c.obrigatorio && !campoExtra[c.nome] && campoExtra[c.nome] !== 0);
      if (faltando) {
        setErro(`Preencha o campo "${faltando.nome}".`);
        return;
      }
    }
    setSalvando(true);
    setErro('');
    const { produto_snapshot: _snapshot, ...body } = montarCorpo();
    try {
      if (eventoId) {
        await api.put(`/calendario/eventos/${eventoId}`, body);
      } else {
        await api.post('/calendario/eventos', body);
        // Salvou de verdade: o rascunho daquela data não serve mais e sai do
        // caminho, pra não perguntar "quer retomar?" de um evento que já existe.
        if (chaveRascunho) await api.del(`/calendario/rascunhos/${chaveRascunho}`).catch(() => {});
      }
      onSalvo();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  // Fechar a janela. Se houver coisa preenchida e não salva, pergunta antes —
  // e, ao sair, guarda o que estava preenchido como rascunho daquela data.
  async function tentarFechar() {
    if (!temAlteracaoPendente()) { onClose(); return; }

    const guardaRascunho = Boolean(chaveRascunho);
    const ok = await confirmar(
      guardaRascunho
        ? 'Você começou a preencher este evento e ainda não salvou. Se sair agora, guardo o que já está preenchido por 1 semana — quando clicar nesse mesmo dia de novo, eu pergunto se você quer retomar.'
        : 'Você alterou este evento e ainda não salvou. Se sair agora, as alterações se perdem.',
      {
        titulo: guardaRascunho ? 'Sair sem terminar?' : 'Sair sem salvar?',
        perigo: !guardaRascunho,
        confirmarTexto: guardaRascunho ? 'Sair e guardar' : 'Sair sem salvar',
        cancelarTexto: 'Continuar preenchendo',
      }
    );
    if (!ok) return;

    if (guardaRascunho) {
      try {
        await api.put(`/calendario/rascunhos/${chaveRascunho}`, { dados: montarCorpo() });
      } catch {
        // Falhar em guardar o rascunho não pode prender a pessoa na janela —
        // ela pediu pra sair. O aviso acima já dizia "guardo"; se não deu,
        // ela descobre ao voltar e o formulário estar limpo.
      }
    }
    onClose();
  }

  async function excluir() {
    if (!window.confirm('Excluir este evento? Essa ação não pode ser desfeita.')) return;
    try {
      await api.del(`/calendario/eventos/${eventoId}`);
      onSalvo();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function duplicar() {
    try {
      await api.post(`/calendario/eventos/${eventoId}/duplicar`);
      onSalvo();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function enviarComentario() {
    if (!novoComentario.trim()) return;
    try {
      const c = await api.post(`/calendario/eventos/${eventoId}/comentarios`, { texto: novoComentario.trim() });
      setComentarios((atual) => [...atual, c]);
      setNovoComentario('');
    } catch (err) {
      setErro(err.message);
    }
  }

  async function enviarAnexo(e) {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;
    const formData = new FormData();
    formData.append('arquivo', arquivo);
    try {
      await api.upload(`/calendario/eventos/${eventoId}/anexos`, formData);
      const atualizado = await api.get(`/calendario/eventos/${eventoId}`);
      setAnexos(atualizado.anexos);
    } catch (err) {
      setErro(err.message);
    }
  }

  // Anexar a Ordem de Produção e deixar o sistema preencher o formulário.
  // O servidor lê o arquivo e devolve SÓ o que conseguiu identificar com
  // certeza — o que não deu, volta em `avisos` e continua em branco (o leitor
  // não chuta referência nem fornecedor). Aqui a gente só aplica o que veio.
  async function importarOrdemProducao(e) {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;
    setImportandoOp(true);
    setErro('');
    setAvisosOp([]);
    setResumoOp(null);
    const formData = new FormData();
    formData.append('arquivo', arquivo);
    try {
      const r = await api.upload('/calendario/ordem-producao/ler', formData);
      const achado = r.encontrado || {};
      if (achado.produto) {
        setProduto(achado.produto);
        setCampoExtra((atual) => ({ ...atual, referencia_texto: atual.referencia_texto || achado.produto.referencia }));
      }
      if (achado.fornecedor) setFornecedor(achado.fornecedor);
      if (achado.quantidade !== null && achado.quantidade !== undefined) {
        setCampoExtra((atual) => ({ ...atual, quantidade: achado.quantidade }));
      }
      if (achado.cor_tecido) setCampoExtra((atual) => ({ ...atual, cor_tecido: achado.cor_tecido }));
      if (achado.numero_op) setCampoExtra((atual) => ({ ...atual, numero_op: achado.numero_op }));
      if ((r.grade || []).length > 0) {
        setGrade(r.grade.map((l) => ({ cor: l.cor, tamanho: l.tamanho, quantidade: l.quantidade, origem: 'wiki_op' })));
        setUsaGrade(true);
      }
      // Título só é sugerido quando está vazio — nunca por cima do que a
      // pessoa já escreveu.
      if (!titulo.trim() && achado.produto) {
        setTitulo(`Chegada de corte ${achado.produto.referencia}${achado.numero_op ? ` — OP ${achado.numero_op}` : ''}`);
      }
      setAvisosOp(r.avisos || []);
      setResumoOp({
        arquivo: arquivo.name,
        linhasGrade: (r.grade || []).length,
        quantidade: achado.quantidade ?? null,
        numeroOp: achado.numero_op || null,
      });
    } catch (err) {
      setErro(err.message);
    } finally {
      setImportandoOp(false);
      e.target.value = ''; // permite reenviar o mesmo arquivo depois de corrigir
    }
  }

  async function removerAnexo(id) {
    try {
      await api.del(`/calendario/anexos/${id}`);
      setAnexos((atual) => atual.filter((a) => a.id !== id));
    } catch (err) {
      setErro(err.message);
    }
  }

  if (carregando) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
        <div className="card" style={{ maxWidth: 560, width: '92%' }}><p className="page-sub">Carregando…</p></div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) tentarFechar(); }}>
      <div className="card" style={{ maxWidth: 640, width: '94%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="card-head-linha">
          <div className="card-head">{eventoId ? 'Editar evento' : 'Novo evento'}</div>
          <button className="icon-btn" onClick={tentarFechar}><X size={16} /></button>
        </div>

        {retomouRascunho && (
          <p className="page-sub" style={{ marginTop: 0 }}>
            Retomado do que você tinha deixado pela metade nesta data. Salve pra valer quando terminar.
          </p>
        )}

        {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

        {!eventoId && (
          <div className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Modelo</span>
            <Select value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Evento simples (sem modelo)</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
            </Select>
          </div>
        )}

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Título</span>
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)} disabled={!podeEditar} autoFocus placeholder="Ex.: Corte da referência OG1192" />
        </div>

        <div className="form-grid">
          <div className="field">
            <span className="field-label">Prioridade</span>
            <Select value={prioridade} onChange={(e) => setPrioridade(e.target.value)} disabled={!podeEditar}>
              {PRIORIDADE_OPCOES.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
            </Select>
          </div>
          <div className="field">
            <span className="field-label">Status</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled={!podeEditar}>
              {STATUS_OPCOES.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
            </Select>
          </div>
          <div className="field">
            <span className="field-label">Data início</span>
            <DateInput value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} disabled={!podeEditar} />
          </div>
          <div className="field">
            <span className="field-label">Data prevista de fim</span>
            <DateInput value={dataPrevistaFim} onChange={(e) => setDataPrevistaFim(e.target.value)} disabled={!podeEditar} />
          </div>
          {status === 'concluido' && (
            <div className="field">
              <span className="field-label">Data de conclusão real</span>
              <DateInput value={dataConclusaoReal} onChange={(e) => setDataConclusaoReal(e.target.value)} disabled={!podeEditar} />
            </div>
          )}
        </div>

        <div className="field" style={{ marginTop: 12, marginBottom: 12 }}>
          <span className="field-label">Descrição</span>
          <textarea rows={3} value={descricao} onChange={(e) => setDescricao(e.target.value)} disabled={!podeEditar} />
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Produto vinculado (opcional)</span>
          <BuscaAssincrona
            valor={produto}
            aoEscolher={escolherProduto}
            buscarFn={(termo) => api.get(`/calendario/produtos-busca?busca=${encodeURIComponent(termo)}`)}
            rotuloVazio="Buscar por referência, código ou descrição…"
            renderOpcao={(p) => (
              <>
                <FotoProduto produtoId={p.id} temFoto={p.tem_foto} size={32} alt={p.referencia} urlBase="/produtos" />
                <strong className="mono" style={{ marginLeft: 8 }}>{p.referencia}</strong>
                {p.descricao && <span style={{ marginLeft: 8, color: 'var(--ink-soft)' }}>{p.descricao}</span>}
              </>
            )}
          />
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Referência / SKU (texto livre, se não for produto cadastrado)</span>
          <input
            value={campoExtra.referencia_texto || ''}
            onChange={(e) => atualizarCampoExtra('referencia_texto', e.target.value)}
            disabled={!podeEditar}
            placeholder="Ex.: NOVO-123 (ainda sem cadastro)"
          />
        </div>

        {templateTemGrade && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: podeEditar ? 'pointer' : 'default' }}>
              <Toggle checked={usaGrade} onChange={(e) => alternarUsaGrade(e.target.checked)} disabled={!podeEditar} />
              Detalhar por variação (cor/tamanho)
            </label>
            {usaGrade && (
              <div style={{ marginTop: 10 }}>
                <GradeVariacoes
                  linhas={grade}
                  onChange={setGrade}
                  coresOpcoes={coresOpcoes}
                  tamanhosOpcoes={tamanhosOpcoes}
                  disabled={!podeEditar}
                />
              </div>
            )}
          </div>
        )}

        {/* Anexar a Ordem de Produção e deixar o resto se preencher sozinho.
            Aparece nos modelos que têm grade (Corte e qualquer modelo com
            campo do tipo 'grade'), que é onde a OP faz sentido. O Wik não
            expõe endpoint de Ordem de Produção hoje — por isso a OP entra
            pelo arquivo; as linhas gravadas já saem marcadas com a origem que
            a estrutura do banco reservou pra ela. */}
        {templateTemGrade && podeEditar && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <div className="card-head" style={{ marginBottom: 4 }}>
              <FileUp size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
              Puxar da Ordem de Produção
            </div>
            <p className="page-sub" style={{ marginTop: 0 }}>
              Anexe a OP em Excel, CSV, texto ou PDF e eu preencho referência, fornecedor, quantidade e a grade
              de cor e tamanho. Aí você só escolhe a data. O que eu não conseguir identificar com certeza fica
              em branco e eu aviso — não preencho no chute.
            </p>
            <FileDropzone onChange={importarOrdemProducao} formatosTexto="Excel (.xlsx), CSV, texto ou PDF, até 8MB" />
            {importandoOp && <p className="page-sub">Lendo a ordem de produção…</p>}
            {resumoOp && (
              <p className="page-sub" style={{ marginBottom: 4 }}>
                Li <strong>{resumoOp.arquivo}</strong>
                {resumoOp.numeroOp && <> · OP <span className="mono">{resumoOp.numeroOp}</span></>}
                {resumoOp.linhasGrade > 0 && <> · {resumoOp.linhasGrade} linha(s) de grade</>}
                {resumoOp.quantidade !== null && <> · <span className="mono">{resumoOp.quantidade}</span> peças no total</>}
              </p>
            )}
            {avisosOp.length > 0 && (
              <ul className="calendario-op-avisos">
                {avisosOp.map((a) => <li key={a}>{a}</li>)}
              </ul>
            )}
          </div>
        )}

        {nomeTemplate === 'Previsão de chegada de corte' && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <div className="card-head" style={{ marginBottom: 8 }}>Campos de Corte</div>
            <div className="form-grid">
              <div className="field">
                <span className="field-label">Fornecedor</span>
                <BuscaAssincrona
                  valor={fornecedor}
                  aoEscolher={setFornecedor}
                  buscarFn={(termo) => api.get(`/calendario/fornecedores-busca?busca=${encodeURIComponent(termo)}`)}
                  rotuloVazio="Buscar fornecedor…"
                  renderOpcao={(f) => <span>{f.nome}</span>}
                />
              </div>
              <div className="field">
                <span className="field-label">Tipo de adição</span>
                <Select value={campoExtra.tipo_adicao || ''} onChange={(e) => atualizarCampoExtra('tipo_adicao', e.target.value)} disabled={!podeEditar}>
                  {tiposAdicao.map((t) => <option key={t.id} value={t.valor}>{t.valor}</option>)}
                </Select>
              </div>
              <div className="field">
                <span className="field-label">Quantidade</span>
                <input type="number" value={campoExtra.quantidade ?? ''} onChange={(e) => atualizarCampoExtra('quantidade', e.target.value)} disabled={!podeEditar} />
              </div>
              <div className="field">
                <span className="field-label">Cor / tecido</span>
                <input value={campoExtra.cor_tecido || ''} onChange={(e) => atualizarCampoExtra('cor_tecido', e.target.value)} disabled={!podeEditar} />
                {variantesSugeridas.length > 0 && (
                  <span className="field-hint">Sugestões: {variantesSugeridas.map((v) => `${v.cor}/${v.tamanho}`).join(', ')}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {nomeTemplate === 'Meta' && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <div className="card-head" style={{ marginBottom: 8 }}>Campos de Meta</div>
            <div className="field">
              <span className="field-label">Valor / indicador alvo</span>
              <input type="number" value={campoExtra.valor_alvo ?? ''} onChange={(e) => atualizarCampoExtra('valor_alvo', e.target.value)} disabled={!podeEditar} />
            </div>
          </div>
        )}

        {template && !NOMES_TEMPLATE_FIXOS.includes(nomeTemplate) && template.campos.some((c) => c.tipo !== 'grade') && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <div className="card-head" style={{ marginBottom: 8 }}>Campos de {nomeTemplate}</div>
            <div className="form-grid">
              {template.campos.filter((c) => c.tipo !== 'grade').map((campo) => (
                <CampoGenerico
                  key={campo.nome}
                  campo={{ ...campo, opcoesResolvidas: opcoesResolvidasCampo(campo) }}
                  valor={campoExtra[campo.nome]}
                  onChange={(v) => atualizarCampoExtra(campo.nome, v)}
                  disabled={!podeEditar}
                />
              ))}
            </div>
          </div>
        )}

        <SecaoRecolhivel titulo="Detalhes avançados" aberto={avancadoAberto} onToggle={() => setAvancadoAberto((v) => !v)}>
          <div className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Categoria</span>
            <Select value={categoria} onChange={(e) => setCategoria(e.target.value)} disabled={!podeEditar} placeholder="Sem categoria">
              {categorias.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
            </Select>
            {podeEditar && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input placeholder="Nova categoria…" value={novaCategoria} onChange={(e) => setNovaCategoria(e.target.value)} style={{ fontSize: 12 }} />
                <button type="button" className="btn btn-ghost" onClick={adicionarCategoria}><Plus size={12} /></button>
              </div>
            )}
          </div>
        </SecaoRecolhivel>

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Responsáveis</span>
          <SeletorMultiplo
            usuarios={usuarios}
            grupos={[]}
            itens={responsaveisIds.map((id) => ({ usuarioId: id }))}
            onChange={(itens) => setResponsaveisIds(itens.map((i) => i.usuarioId))}
          />
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Quem vê / quem edita este evento</span>
          <p className="page-sub" style={{ marginTop: 0 }}>
            Você (quem criou), os administradores e quem estiver como <strong>responsável</strong> sempre enxergam
            este evento. Fora esses, só quem for liberado aqui.
          </p>
          <SeletorMultiplo usuarios={usuarios} grupos={grupos} itens={permissoes} onChange={setPermissoes} comNivel />
          {/* Resumo em português do que está selecionado. Até 04/09/2026 essa
              lista sumia depois de salva e a liberação parecia enfeite — é
              esta linha que mostra, ali mesmo, quem passa a enxergar. */}
          <p className="calendario-quem-ve-resumo">
            <Users size={12} />
            {(() => {
              const nomeDe = (p) => (p.grupoId
                ? `Grupo ${grupos.find((g) => g.id === p.grupoId)?.nome || '—'}`
                : usuarios.find((u) => u.id === p.usuarioId)?.nome || '—');
              const responsaveisNomes = responsaveisIds
                .map((id) => usuarios.find((u) => u.id === id)?.nome)
                .filter(Boolean);
              const veem = permissoes.filter((p) => p.nivel !== 'editar').map(nomeDe);
              const editam = permissoes.filter((p) => p.nivel === 'editar').map(nomeDe);
              const partes = [];
              if (responsaveisNomes.length > 0) partes.push(`${responsaveisNomes.join(', ')} (responsável, vê)`);
              if (veem.length > 0) partes.push(`${veem.join(', ')} (só vê)`);
              if (editam.length > 0) partes.push(`${editam.join(', ')} (vê e edita)`);
              if (partes.length === 0) return 'Hoje só você e os administradores enxergam este evento.';
              return `Além de você e dos administradores, enxergam: ${partes.join(' · ')}.`;
            })()}
          </p>
        </div>

        {eventoId && (
          <div className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Anexos ({anexos.length}/5, até 8MB cada)</span>
            {anexos.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <FileTypeIcon nomeArquivo={a.nome_arquivo} size={26} />
                <a href={`/api/calendario/anexos/${a.id}`} target="_blank" rel="noreferrer" style={{ flex: 1 }}>{a.nome_arquivo}</a>
                {podeEditar && <button type="button" className="icon-btn" onClick={() => removerAnexo(a.id)}><Trash2 size={13} /></button>}
              </div>
            ))}
            {podeEditar && anexos.length < 5 && (
              <FileDropzone onChange={enviarAnexo} formatosTexto="qualquer arquivo até 8MB" />
            )}
          </div>
        )}

        {eventoId && (
          <div className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Comentários</span>
            {comentarios.map((c) => (
              <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{c.usuario_nome} · {dataBr(c.criado_em.slice(0, 10))}</div>
                <div>{c.texto}</div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input placeholder="Escrever um comentário…" value={novoComentario} onChange={(e) => setNovoComentario(e.target.value)} />
              <button type="button" className="btn btn-ghost" onClick={enviarComentario}>Enviar</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {eventoId && (
              <a className="btn btn-ghost" href={`/calendario/eventos/${eventoId}/imprimir`} target="_blank" rel="noreferrer">
                Imprimir / Exportar PDF
              </a>
            )}
            {eventoId && podeEditar && (
              <>
                <button type="button" className="btn btn-ghost" onClick={duplicar}>Duplicar</button>
                <button type="button" className="btn btn-ghost" onClick={excluir}>Excluir</button>
              </>
            )}
          </div>
          {podeEditar && (
            <button type="button" className="btn btn-primary" onClick={salvar} disabled={salvando}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
