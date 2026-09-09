import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Upload, FileSpreadsheet, Info, AlertTriangle, Check, X, RefreshCw, Download,
  Play, Undo2, Trash2, Layers, PencilLine, Tags, History,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, IndicadorDestaque, Select, Field, ChipsFiltros,
} from '../components/ui';
import FileDropzone from '../components/FileDropzone';
import { confirmar } from '../components/ConfirmDialog';
import { tempoRelativo } from '../lib/format';

// Produto › Importar em massa.
//
// A tela existe porque coleção nova é um dia de digitação: 12 referências × 4
// cores × 5 tamanhos são 240 variantes, e o dia que termina assim termina com
// dois tamanhos faltando e ninguém sabendo quais.
//
// O fluxo é sempre o mesmo, de propósito: enviar → SIMULAR → conferir a conta
// → aplicar. Nada é gravado quando o arquivo sobe. E, depois de aplicado, dá
// para desfazer.
//
// ⚠️ O desfazer é condicional: só volta o campo que ainda está com o valor que
// aquela importação gravou. O que alguém corrigiu à mão depois fica como está.

const BASE = '/importacao-massa';

const ICONES = { grade: Layers, cadastro: PencilLine, variante: Tags };

const SITUACOES = {
  simulada: 'Simulada',
  aplicada: 'Aplicada',
  desfeita: 'Desfeita',
  descartada: 'Descartada',
};

const ACOES = {
  criar: { rotulo: 'Criar', tom: 'tone-saudavel' },
  atualizar: { rotulo: 'Atualizar', tom: 'tone-atencao' },
  ignorar: { rotulo: 'Já está assim', tom: 'tone-neutro' },
  erro: { rotulo: 'Erro', tom: 'tone-prejuizo' },
};

const mensagem = (e) => e?.data?.error || e?.data?.erro || e?.message || 'Erro inesperado.';
const ouTraco = (v) => (v === null || v === undefined || v === '' ? '—' : v);

// Mostra {colecao: 'Verão 26'} como "Coleção: Verão 26" — a pessoa não lê JSON,
// e mostrar JSON numa tela de conferência é o mesmo que não mostrar.
function comoTexto(obj) {
  if (!obj || typeof obj !== 'object') return '—';
  const partes = Object.entries(obj)
    .filter(([k]) => !['produto_existe', 'linha_produto'].includes(k))
    .map(([k, v]) => `${k}: ${v === null || v === '' ? '(vazio)' : v}`);
  return partes.length ? partes.join(' · ') : '—';
}

export default function ImportacaoMassaPage() {
  const [modelos, setModelos] = useState([]);
  const [tipo, setTipo] = useState('grade');
  const [lista, setLista] = useState([]);
  const [aberta, setAberta] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const [avisos, setAvisos] = useState([]);
  const [filtroAcao, setFiltroAcao] = useState('');
  const arquivoRef = useRef(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try { setLista(await api.get(BASE)); }
    catch (e) { setErro(mensagem(e)); } finally { setCarregando(false); }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => { api.get(`${BASE}/modelos`).then(setModelos).catch(() => {}); }, []);

  const modelo = modelos.find((m) => m.tipo === tipo);

  async function simular() {
    const arquivo = arquivoRef.current?.files?.[0];
    if (!arquivo) { setErro('Escolha a planilha.'); return; }
    setErro(''); setSucesso(''); setAvisos([]);
    setEnviando(true);
    try {
      const form = new FormData();
      form.append('tipo', tipo);
      form.append('arquivo', arquivo);
      const r = await api.upload(`${BASE}/simular`, form);
      setAberta(r);
      setFiltroAcao('');
      if (arquivoRef.current) arquivoRef.current.value = '';
      carregar();
    } catch (e) { setErro(mensagem(e)); } finally { setEnviando(false); }
  }

  async function abrir(id) {
    setErro(''); setSucesso('');
    try { setAberta(await api.get(`${BASE}/${id}`)); setFiltroAcao(''); }
    catch (e) { setErro(mensagem(e)); }
  }

  async function aplicar() {
    const imp = aberta.importacao;
    const ok = await confirmar(
      `Serão criadas ${imp.total_criar} e atualizadas ${imp.total_atualizar} linha(s). `
      + `${imp.total_ignorar} já estão como a planilha pede e ${imp.total_erro} não entram. `
      + 'Depois de aplicar ainda dá para desfazer.',
      { titulo: 'Aplicar esta importação?', confirmarTexto: 'Aplicar', perigo: false }
    );
    if (!ok) return;
    setErro(''); setSucesso('');
    try {
      const r = await api.post(`${BASE}/${imp.id}/aplicar`);
      setAberta(r.detalhe);
      setSucesso(`${r.criadas} criada(s) e ${r.atualizadas} atualizada(s).`);
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function desfazer() {
    const motivo = window.prompt('Por que está desfazendo? (fica gravado)');
    if (!motivo) return;
    const ok = await confirmar(
      'O desfazer volta cada campo ao que era ANTES desta importação — mas só onde o valor ainda '
      + 'é o que ela gravou. O que alguém corrigiu à mão depois fica como está, e a tela diz quais.',
      { titulo: 'Desfazer esta importação?', confirmarTexto: 'Desfazer', perigo: true }
    );
    if (!ok) return;
    setErro(''); setSucesso(''); setAvisos([]);
    try {
      const r = await api.post(`${BASE}/${aberta.importacao.id}/desfazer`, { motivo });
      // ⚠️ `abrir` limpa as mensagens (é o certo quando quem clica é a pessoa,
      // numa outra linha do histórico). Então o recado do desfazer é escrito
      // DEPOIS dele — antes, ele saía da tela no mesmo instante em que nascia.
      await abrir(aberta.importacao.id);
      setSucesso(`${r.revertidas.length} linha(s) voltaram ao estado anterior.`);
      setAvisos(r.mantidas.map((m) => `${m.chave}: ${m.motivo}`));
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function descartar(id) {
    try { await api.del(`${BASE}/${id}`); setAberta(null); carregar(); }
    catch (e) { setErro(mensagem(e)); }
  }

  const linhas = (aberta?.linhas || []).filter((l) => !filtroAcao || l.acao === filtroAcao);
  const chips = filtroAcao
    ? [{ chave: 'a', rotulo: 'Mostrando', valor: ACOES[filtroAcao]?.rotulo || filtroAcao, onRemover: () => setFiltroAcao('') }]
    : [];

  const Icone = ICONES[tipo] || Upload;
  const aplicada = aberta?.importacao?.situacao === 'aplicada' || aberta?.importacao?.situacao === 'desfeita';

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><FileSpreadsheet size={22} /> Importar em massa</h1>
          <p className="ink-soft">
            Grade, cadastro e variante por planilha — com a conta antes de gravar, e desfazer depois.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn btn-ghost" onClick={carregar}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <p className="ink-soft ajuda-bloco">
        <Info size={14} /> Enviar a planilha <strong>não grava nada</strong>. O sistema mostra a
        conta — quantas criar, quantas atualizar, quantas já estão como a planilha pede, quantas
        deram erro — e você decide. Célula vazia não apaga o que está no sistema; para apagar de
        propósito, escreva <strong>-</strong> na célula.
      </p>

      {erro && <p className="erro-inline">{erro}</p>}
      {sucesso && <p className="sucesso-inline"><Check size={14} /> {sucesso}</p>}
      {avisos.map((a, i) => <p className="aviso-inline" key={i}><AlertTriangle size={14} /> {a}</p>)}

      {/* 1. Enviar ---------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><Upload size={16} /> Enviar planilha</h2>

        <div className="filtros-linha">
          <Field label="O que a planilha traz">
            <Select value={tipo} onChange={(e) => setTipo(e.target.value)}>
              {modelos.map((m) => <option key={m.tipo} value={m.tipo}>{m.titulo}</option>)}
            </Select>
          </Field>
          {modelo && (
            <a className="btn btn-ghost" href={`/api${BASE}/modelo/${tipo}.xlsx`}>
              <Download size={15} /> Baixar modelo
            </a>
          )}
        </div>

        {modelo && (
          <>
            <p className="ink-soft ajuda-bloco"><Icone size={14} /> {modelo.frase}</p>
            <p className="ink-soft">
              Colunas: {modelo.colunas.join(' · ')}
            </p>
          </>
        )}

        <FileDropzone accept=".xlsx,.csv" ref={arquivoRef} formatosTexto="Formatos aceitos: .xlsx ou .csv" />

        <div className="painel-acoes-inline">
          <button type="button" className="btn btn-primary" onClick={simular} disabled={enviando}>
            <Play size={15} /> {enviando ? 'Conferindo…' : 'Conferir sem gravar'}
          </button>
        </div>
      </div>

      {/* 2. A importação aberta --------------------------------------------- */}
      {aberta && (
        <div className="card">
          <div className="card-head-linha">
            <h2 className="card-titulo">
              <FileSpreadsheet size={16} /> {ouTraco(aberta.importacao.arquivo_nome)}
              <span className="stamp sm tone-neutro">{SITUACOES[aberta.importacao.situacao]}</span>
            </h2>
            <div className="painel-acoes-inline">
              {aberta.importacao.situacao === 'simulada' && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={aplicar}
                    disabled={aberta.importacao.total_criar + aberta.importacao.total_atualizar === 0}
                  >
                    <Check size={15} /> Aplicar
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => descartar(aberta.importacao.id)}>
                    <Trash2 size={15} /> Descartar
                  </button>
                </>
              )}
              {aberta.importacao.situacao === 'aplicada' && (
                <button type="button" className="btn btn-danger" onClick={desfazer}>
                  <Undo2 size={15} /> Desfazer
                </button>
              )}
              <button type="button" className="btn btn-ghost" onClick={() => setAberta(null)}>
                <X size={15} /> Fechar
              </button>
            </div>
          </div>

          {/* Depois de aplicada, o cartão descreve o que ACONTECEU, não o que
              vai acontecer. Indicador em tempo futuro numa importação já
              aplicada faz a pessoa procurar um botão que não existe mais. */}
          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo={aplicada ? 'Criadas' : 'A criar'} valor={aberta.importacao.total_criar} Icone={Layers}
              explicacao={aplicada
                ? 'Linhas que não existiam e foram cadastradas por esta importação.'
                : 'Linhas que ainda não existem no sistema e serão cadastradas.'}
            />
            <IndicadorDestaque
              rotulo={aplicada ? 'Atualizadas' : 'A atualizar'} valor={aberta.importacao.total_atualizar} Icone={PencilLine}
              tom={aberta.importacao.total_atualizar > 0 ? 'atencao' : undefined}
              explicacao={aplicada
                ? 'Linhas que existiam e tiveram ao menos um campo trocado. Só os campos diferentes foram tocados, e o valor anterior de cada um ficou gravado.'
                : 'Linhas que existem e têm ao menos um campo diferente do que a planilha pede. Só os campos diferentes são tocados.'}
            />
            <IndicadorDestaque
              rotulo="Já estão assim" valor={aberta.importacao.total_ignorar} Icone={Check}
              explicacao="Existem e já estão exatamente como a planilha pede. Contá-las como alteração faria toda reimportação parecer que mudou o mundo inteiro."
            />
            <IndicadorDestaque
              rotulo="Com erro" valor={aberta.importacao.total_erro} Icone={AlertTriangle}
              tom={aberta.importacao.total_erro > 0 ? 'prejuizo' : undefined}
              explicacao={aplicada
                ? 'Não entraram, e o resto do arquivo entrou assim mesmo. Cada uma diz o número da linha na sua planilha e o motivo.'
                : 'Não entram, e o resto do arquivo entra assim mesmo. Cada uma diz o número da linha na sua planilha e o motivo.'}
            />
          </div>

          {aberta.importacao.situacao === 'aplicada' && (
            <p className="ink-soft ajuda-bloco">
              <History size={14} /> Aplicada {tempoRelativo(aberta.importacao.aplicado_em)}
              {aberta.importacao.aplicado_por_nome ? ` por ${aberta.importacao.aplicado_por_nome}` : ''}.
              Cada linha guardou o valor que estava lá antes — é o que permite desfazer e é o que
              responde, daqui a três meses, quem trocou o quê.
            </p>
          )}
          {aberta.importacao.situacao === 'desfeita' && (
            <p className="ink-soft ajuda-bloco">
              <Undo2 size={14} /> Desfeita {tempoRelativo(aberta.importacao.desfeito_em)}:
              {' '}{ouTraco(aberta.importacao.desfeito_motivo)}
            </p>
          )}

          <div className="filtros-linha">
            <Select value={filtroAcao} onChange={(e) => setFiltroAcao(e.target.value)}>
              <option value="">Todas as linhas</option>
              {Object.entries(ACOES).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
            </Select>
          </div>
          <ChipsFiltros itens={chips} onLimparTudo={() => setFiltroAcao('')} />

          {linhas.length === 0 && (
            <EstadoVazio Icone={FileSpreadsheet} titulo="Nenhuma linha neste filtro" descricao="Tire o filtro para ver o arquivo inteiro." />
          )}
          {linhas.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead>
                  <tr>
                    <th className="num">Linha</th><th>O quê</th><th>Item</th>
                    <th>O que a planilha pede</th><th>Como estava</th><th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.slice(0, 500).map((l) => (
                    <tr key={l.id}>
                      <td className="num">{ouTraco(l.linha_numero)}</td>
                      <td><span className={`stamp sm ${ACOES[l.acao]?.tom || 'tone-neutro'}`}>{ACOES[l.acao]?.rotulo || l.acao}</span></td>
                      <td>{ouTraco(l.chave)}</td>
                      <td>{comoTexto(l.dados)}</td>
                      <td className="ink-soft">{l.antes ? comoTexto(l.antes) : '—'}</td>
                      <td className="ink-soft">{ouTraco(l.motivo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {linhas.length > 500 && (
            <p className="ink-soft">Mostrando as primeiras 500 de {linhas.length} linhas.</p>
          )}
        </div>
      )}

      {/* 3. Histórico -------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><History size={16} /> Importações anteriores</h2>
        <p className="ink-soft">
          Importação aplicada fica aqui para sempre: é ela que responde &ldquo;quem mudou isto, e
          quando?&rdquo;.
        </p>
        {carregando && <Skeleton height={160} />}
        {!carregando && lista.length === 0 && (
          <EstadoVazio Icone={FileSpreadsheet} titulo="Nenhuma importação ainda" descricao="A primeira planilha que você conferir aparece aqui." />
        )}
        {!carregando && lista.length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Arquivo</th><th>O quê</th><th>Situação</th>
                  <th className="num">Criar</th><th className="num">Atualizar</th>
                  <th className="num">Já estavam</th><th className="num">Erro</th>
                  <th>Quando</th><th>Quem</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((i) => (
                  <tr key={i.id} className="linha-clicavel" onClick={() => abrir(i.id)}>
                    <td>{ouTraco(i.arquivo_nome)}</td>
                    <td>{i.tipo}</td>
                    <td><span className="stamp sm tone-neutro">{SITUACOES[i.situacao] || i.situacao}</span></td>
                    <td className="num">{i.total_criar}</td>
                    <td className="num">{i.total_atualizar}</td>
                    <td className="num">{i.total_ignorar}</td>
                    <td className={`num ${i.total_erro > 0 ? 'tone-prejuizo' : ''}`}>{i.total_erro}</td>
                    <td>{tempoRelativo(i.criado_em)}</td>
                    <td>{ouTraco(i.criado_por_nome)}</td>
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
