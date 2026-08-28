import { Children, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  ChevronDown, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CalendarDays,
  ArrowUp, ArrowDown, ChevronsUpDown, FileSpreadsheet, FileText, FileImage, FileCode, FileArchive, File as FileGenerico,
} from 'lucide-react';
import { TAMANHOS_PAGINA } from '../lib/useTabela';
import { exportarCsv, exportarXlsx } from '../lib/exportar';
import { Download } from 'lucide-react';

// Painéis flutuantes (lista do Select, calendário do DateInput) precisam
// escapar de qualquer ancestral com overflow:hidden/auto (todo .card do
// sistema tem overflow-x:auto, o que na prática também corta o eixo Y) —
// em vez de position:absolute dentro do próprio campo, calcula a posição em
// coordenadas de tela e usa um portal direto pro <body>, recalculando se a
// página rolar ou a janela mudar de tamanho enquanto o painel está aberto.
function usePosicaoFlutuante(aberto, gatilhoRef) {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!aberto) { setPos(null); return undefined; }
    function atualizar() {
      const el = gatilhoRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, width: r.width });
    }
    atualizar();
    window.addEventListener('scroll', atualizar, true);
    window.addEventListener('resize', atualizar);
    return () => {
      window.removeEventListener('scroll', atualizar, true);
      window.removeEventListener('resize', atualizar);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);
  return pos;
}

export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// Quantas casas decimais o campo aceita, a partir do `step` (já existia
// como prop — não é API nova): '0.01' (padrão) -> 2, '1' -> 0, etc.
function casasDecimaisDoStep(step) {
  const s = String(step);
  const ponto = s.indexOf('.');
  return ponto === -1 ? 0 : s.length - ponto - 1;
}

// "1.500,00" ou "1500,00" ou "1500" -> 1500 (number). Um ponto SEM vírgula
// junto é tratado como separador decimal (não de milhar) — cobre digitação
// livre tipo "12.5" — enquanto ponto(s) na presença de vírgula são sempre
// separador de milhar (formato BR de colar valor, ex. "1.500,00").
function textoParaNumero(texto) {
  const s = String(texto ?? '').trim();
  if (s === '' || s === '-') return '';
  const comVirgula = s.includes(',');
  const normalizado = comVirgula ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalizado);
  return Number.isNaN(n) ? '' : n;
}

// Texto pra EDITAR (campo em foco) — vírgula decimal, sem separador de
// milhar no meio (mexer num número com pontos de milhar enquanto digita é
// confuso). Formatação "de verdade" (milhar + casas fixas) só acontece no
// blur, ver formatarNumeroExibicao abaixo.
function numeroParaTextoEdicao(value) {
  if (value === '' || value === null || value === undefined) return '';
  return String(value).replace('.', ',');
}

// `forcarCasas` (suffix "R$": sempre 2 casas, ex. "1.500,00") vs os demais
// sufixos/campos sem sufixo — não força zeros à direita, pra não regredir
// telas que hoje mostram um inteiro cru (ex. "3 dias") com 2 casas coladas
// por causa só do `step` padrão do componente.
function formatarNumeroExibicao(value, casas, forcarCasas) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  if (Number.isNaN(n)) return '';
  return n.toLocaleString('pt-BR', {
    maximumFractionDigits: casas,
    minimumFractionDigits: forcarCasas ? casas : 0,
  });
}

// CORRIGIDO: o campo é controlado direto por `value` (um number, formatado
// com 2 casas fixas por quem chama, ex. "0.00") — a cada tecla, o pai
// recalculava e devolvia um valor já arredondado/formatado, o <input
// type="number"> nativo reescrevia o próprio value no meio da digitação e o
// cursor pulava pro fim (só sobravam as setinhas, de centavo em centavo).
// A correção: enquanto o campo está em foco, o texto exibido é um ESTADO
// LOCAL (não o `value` externo) — só sincroniza de volta com `value` quando
// o campo NÃO está em foco (valor inicial, ou troca vinda de fora enquanto
// o campo está solto). onChange continua disparando a cada tecla, com
// number (ou '') — nenhum contrato muda pra quem já usa NumInput.
export function NumInput({ value, onChange, step = '0.01', suffix, onFocus, onBlur, ...props }) {
  const casas = casasDecimaisDoStep(step);
  const forcarCasas = suffix === 'R$';
  const [focado, setFocado] = useState(false);
  const [texto, setTexto] = useState(() => formatarNumeroExibicao(value, casas, forcarCasas));

  useEffect(() => {
    if (!focado) setTexto(formatarNumeroExibicao(value, casas, forcarCasas));
  }, [value, casas, forcarCasas, focado]);

  function aoDigitar(e) {
    // Filtra qualquer coisa que não seja dígito/separador/sinal — cobre
    // colar texto com prefixo ("R$ 1.500,00") sem deixar lixo no campo.
    const limpo = e.target.value.replace(/[^0-9,.\-]/g, '');
    setTexto(limpo);
    onChange(textoParaNumero(limpo));
  }

  function aoFocar(e) {
    setFocado(true);
    setTexto(numeroParaTextoEdicao(value));
    onFocus?.(e);
  }

  function aoDesfocar(e) {
    setFocado(false);
    const numero = textoParaNumero(texto);
    setTexto(formatarNumeroExibicao(numero, casas, forcarCasas));
    if (numero !== value) onChange(numero);
    onBlur?.(e);
  }

  return (
    <div className="numwrap">
      <input
        type="text"
        inputMode="decimal"
        value={texto}
        onChange={aoDigitar}
        onFocus={aoFocar}
        onBlur={aoDesfocar}
        {...props}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

// Substituto do <input type="checkbox"> cru do navegador — mesma API
// (checked/onChange recebe o evento normal, com target.checked, então troca
// só a tag em qualquer lugar sem mexer no resto do código). O <input> real
// continua no DOM (só visualmente escondido) pra manter teclado/leitor de
// tela funcionando de graça, com foco visível via :focus-visible no irmão.
export function Checkbox({ checked, onChange, disabled, className = '', ...props }) {
  return (
    <label className={`checkbox-custom${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}>
      <input type="checkbox" checked={Boolean(checked)} onChange={onChange} disabled={disabled} {...props} />
      <span className="checkbox-custom-caixa"><Check size={12} /></span>
    </label>
  );
}

// Mesma ideia, mas com a metáfora de chave liga/desliga — usado quando a
// pergunta é "ativo ou não" em vez de uma seleção múltipla.
export function Toggle({ checked, onChange, disabled, className = '', ...props }) {
  return (
    <label className={`toggle-custom${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}>
      <input type="checkbox" checked={Boolean(checked)} onChange={onChange} disabled={disabled} {...props} />
      <span className="toggle-custom-trilho"><span className="toggle-custom-bolinha" /></span>
    </label>
  );
}

// Cartão de indicador usado em faixas de KPI (dentro de um .stat-strip).
// `value` cobre o caso comum (número/texto simples, vira um
// stat-card-value); `children` é extra — tanto serve pra um valor com
// componente próprio (ex.: MargemPill com cor semântica, que já sai com a
// classe stat-card-value embutida) quanto pra um selo de variação abaixo do
// valor (ex.: VariacaoBadge), podendo os dois coexistir.
// `variant` (opcional: "danger"/"warning"/"success") dá uma barra lateral +
// ícone (se `Icone` for passado) na cor cheia do indicador — pra KPIs onde a
// cor por si só já diz se é bom ou ruim (ex.: "Atrasados"), em vez dos três
// cartões de uma faixa saírem todos iguais em bege neutro.
// `Icone` é opcional e reaproveitável por qualquer módulo (não só o
// Calendário, que foi o primeiro a usar): um componente de ícone (ex. de
// lucide-react) renderizado à direita, na mesma cor do `variant`.
export function StatCard({ label, value, children, variant, Icone }) {
  return (
    <div className={`stat-card${variant ? ` stat-card-${variant}` : ''}`}>
      <div className="stat-card-corpo">
        <span className="stat-card-label">{label}</span>
        {value !== undefined && <span className="stat-card-value">{value}</span>}
        {children}
      </div>
      {Icone && <Icone size={22} className="stat-card-icone" />}
    </div>
  );
}

// Estado vazio com ícone + frase explicando o que apareceria ali + botão de
// ação (opcional, um <Link> quando `href` é passado, ou um <button> comum
// quando `onAcao` é passado) — no lugar da frase solta ("Nenhum pedido
// encontrado.") que não dizia o que fazer a respeito.
export function EstadoVazio({ Icone, titulo, descricao, acaoLabel, href, onAcao, IconeAcao }) {
  return (
    <div className="estado-vazio">
      {Icone && <Icone size={30} />}
      {titulo && <div className="estado-vazio-titulo">{titulo}</div>}
      {descricao && <p className="estado-vazio-descricao">{descricao}</p>}
      {href && (
        <Link to={href} className="btn btn-primary" style={{ marginTop: 4 }}>
          {IconeAcao && <IconeAcao size={14} />} {acaoLabel}
        </Link>
      )}
      {onAcao && !href && (
        <button type="button" className="btn btn-primary" style={{ marginTop: 4 }} onClick={onAcao}>
          {IconeAcao && <IconeAcao size={14} />} {acaoLabel}
        </button>
      )}
    </div>
  );
}

// Bloco cinza com brilho suave pra ocupar o lugar de algo que ainda está
// carregando, em vez da tela piscar vazia por um instante. Respeita
// prefers-reduced-motion via CSS (a animação vira um tom fixo).
export function Skeleton({ width, height = 14, radius, className = '', style }) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

// Linhas de esqueleto pra colocar dentro de um <tbody> enquanto a
// primeira página de uma lista carrega — mesma quantidade de colunas da
// tabela real, só que com barras cinza no lugar do texto.
export function SkeletonLinhasTabela({ colunas, linhas = 5 }) {
  return (
    <>
      {Array.from({ length: linhas }).map((_, i) => (
        <tr key={i} className="skeleton-row">
          {Array.from({ length: colunas }).map((_, j) => (
            <td key={j}><Skeleton width={j === 0 ? '60%' : `${60 + ((i + j) % 3) * 10}%`} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function Row({ label, value, strong, big }) {
  return (
    <div className={'row-line' + (strong ? ' strong' : '') + (big ? ' big' : '')}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

// Cabeçalho de coluna clicável pra ordenar uma tabela (usado com o hook
// useTabela) — mostra uma seta de duas pontas discreta quando a coluna
// não é a ordenação atual, e uma seta cheia na direção certa quando é.
export function ThOrdenavel({ coluna, atual, direcao, onClick, children, className = '', style, title }) {
  const ativa = coluna === atual;
  return (
    <th className={className} style={style} title={title}>
      <button
        type="button"
        className={'th-ordenavel' + (ativa ? ' is-ativa' : '')}
        onClick={() => onClick(coluna)}
      >
        {children}
        {ativa ? (direcao === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ChevronsUpDown size={12} />}
      </button>
    </th>
  );
}

// Rodapé de paginação — contagem "mostrando 1–50 de 1.926", seletor de
// tamanho de página e navegação anterior/próxima. `totalItens` já é o
// total depois de qualquer filtro/busca aplicado pela própria página.
export function Paginacao({ pagina, totalPaginas, tamanho, tamanhos = TAMANHOS_PAGINA, totalItens, inicio, fim, setPagina, setTamanho }) {
  if (totalItens === 0) return null;
  return (
    <div className="paginacao-barra">
      <span className="paginacao-contagem">
        Mostrando {(inicio + 1).toLocaleString('pt-BR')}–{fim.toLocaleString('pt-BR')} de {totalItens.toLocaleString('pt-BR')}
      </span>
      <div className="paginacao-controles">
        <Select value={String(tamanho)} onChange={(e) => setTamanho(Number(e.target.value))} className="paginacao-tamanho">
          {tamanhos.map((t) => <option key={t} value={String(t)}>{t} por página</option>)}
        </Select>
        <button type="button" className="icon-btn" disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)} aria-label="Página anterior">
          <ChevronLeft size={16} />
        </button>
        <span className="paginacao-pagina">Página {pagina} de {totalPaginas}</span>
        <button type="button" className="icon-btn" disabled={pagina >= totalPaginas} onClick={() => setPagina(pagina + 1)} aria-label="Próxima página">
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

// Mapa extensão -> { Icone, cor } — cor é a base do degradê aplicado em
// .file-type-icon (ver theme.css: linear-gradient 150deg até um tom mais
// escuro da mesma cor, ícone branco), mesma técnica já usada em
// .module-badge pro círculo colorido da barra lateral. Estilo "cartão de
// arquivo" tipo Google Drive: ícone identificável de longe, cor consistente
// por tipo em qualquer lugar do sistema que baixe/exporte arquivo.
const CORES_TIPO_ARQUIVO = {
  xlsx: { Icone: FileSpreadsheet, cor: '#1f9d55' },
  xls: { Icone: FileSpreadsheet, cor: '#1f9d55' },
  csv: { Icone: FileSpreadsheet, cor: '#1f9d55' },
  pdf: { Icone: FileText, cor: '#d64545' },
  docx: { Icone: FileText, cor: '#2563eb' },
  doc: { Icone: FileText, cor: '#2563eb' },
  png: { Icone: FileImage, cor: '#a855c7' },
  jpg: { Icone: FileImage, cor: '#a855c7' },
  jpeg: { Icone: FileImage, cor: '#a855c7' },
  html: { Icone: FileCode, cor: '#db2777' },
  zip: { Icone: FileArchive, cor: '#6b7280' },
  rar: { Icone: FileArchive, cor: '#6b7280' },
  txt: { Icone: FileText, cor: '#9ca3af' },
};
const TIPO_ARQUIVO_PADRAO = { Icone: FileGenerico, cor: '#9ca3af' };

function extensaoDe(nomeArquivo) {
  const partes = String(nomeArquivo || '').split('.');
  return partes.length > 1 ? partes.pop().toLowerCase() : '';
}

// Componente reaproveitável em qualquer lista de arquivo/anexo/exportação do
// sistema (anexos do Calendário, BotaoExportar, dropzone de upload etc.) —
// recebe o nome do arquivo (ou a extensão direto) e resolve ícone + cor
// sozinho. `size` controla o tamanho do quadrado (o ícone interno escala
// junto, a ~55% do tamanho do quadrado).
export function FileTypeIcon({ nomeArquivo, extensao, size = 32 }) {
  const ext = (extensao || extensaoDe(nomeArquivo)).toLowerCase();
  const { Icone, cor } = CORES_TIPO_ARQUIVO[ext] || TIPO_ARQUIVO_PADRAO;
  return (
    <span
      className="file-type-icon"
      style={{ '--file-icon-color': cor, width: size, height: size }}
    >
      <Icone size={Math.round(size * 0.55)} />
    </span>
  );
}

// Botão de exportar (CSV ou XLSX) — recebe as colunas (`{ chave, rotulo,
// valor(item) }`) e a lista JÁ com o filtro/ordenação aplicados pela
// própria tela (não só a página visível), e exporta os dois formatos com
// cabeçalho em português e valor formatado igual à tela.
export function BotaoExportar({ nomeBase, colunas, itens, disabled }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="exportar">
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setAberto((v) => !v)}>
        <Download size={14} /> Exportar
      </button>
      {aberto && (
        <>
          <div className="exportar-backdrop" onClick={() => setAberto(false)} />
          <div className="exportar-menu">
            <button type="button" className="exportar-item" onClick={() => { exportarCsv(nomeBase, colunas, itens); setAberto(false); }}>
              <FileTypeIcon extensao="csv" size={22} /> Exportar como CSV
            </button>
            <button type="button" className="exportar-item" onClick={() => { exportarXlsx(nomeBase, colunas, itens); setAberto(false); }}>
              <FileTypeIcon extensao="xlsx" size={22} /> Exportar como XLSX
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function normalizarTexto(valor) {
  return String(valor ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const LIMITE_RECENTES = 5;

// Exportado pra telas como Dashboard/Simulador oferecerem um atalho pras
// últimas referências consultadas antes mesmo de abrir o Select.
export function lerRecentes(chave) {
  if (!chave) return [];
  try {
    const lista = JSON.parse(localStorage.getItem(`hbn_select_recentes_${chave}`) || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

function gravarRecente(chave, valor) {
  if (!chave || !valor) return;
  const atuais = lerRecentes(chave).filter((v) => v !== valor);
  atuais.unshift(valor);
  try {
    localStorage.setItem(`hbn_select_recentes_${chave}`, JSON.stringify(atuais.slice(0, LIMITE_RECENTES)));
  } catch {
    // localStorage cheio ou bloqueado — não é crítico, só perde a lista de recentes
  }
}

// Aceita tanto <option> soltos quanto agrupados em <optgroup label="...">
// (usado pelo seletor de visibilidade do Calendário — "Grupos"/"Pessoas"
// como seções visualmente separadas dentro do mesmo Select). Nenhum uso
// existente passa <optgroup>, então isso não muda nada pra quem já usa
// Select hoje.
function extrairOpcoes(children) {
  const opcoes = [];
  Children.forEach(children, (child) => {
    if (!child || typeof child !== 'object' || !child.props) return;
    if (child.type === 'option') {
      const valor = child.props.value !== undefined ? String(child.props.value) : String(child.props.children ?? '');
      opcoes.push({ valor, rotulo: child.props.children, desabilitada: Boolean(child.props.disabled) });
      return;
    }
    if (child.type === 'optgroup') {
      Children.forEach(child.props.children, (neto) => {
        if (!neto || typeof neto !== 'object' || !neto.props || neto.type !== 'option') return;
        const valor = neto.props.value !== undefined ? String(neto.props.value) : String(neto.props.children ?? '');
        opcoes.push({ valor, rotulo: neto.props.children, desabilitada: Boolean(neto.props.disabled), grupo: child.props.label });
      });
    }
  });
  return opcoes;
}

// Substituto do <select> nativo — mesma API (value/onChange recebe um evento
// sintético com target.value, igual ao select de verdade, então dá pra trocar
// só a tag em qualquer lugar do sistema sem mexer no resto do código) só que
// com um menu próprio, estilizado como o resto do sistema em vez do combo
// cinza do navegador.
export function Select({ value, onChange, children, disabled, className = '', style, placeholder, chaveRecentes }) {
  const [aberto, setAberto] = useState(false);
  const [destaque, setDestaque] = useState(-1);
  const [filtro, setFiltro] = useState('');
  const raizRef = useRef(null);
  const gatilhoRef = useRef(null);
  const listaRef = useRef(null);
  const buscaInputRef = useRef(null);
  const buscaRef = useRef({ termo: '', timeout: null });
  const pos = usePosicaoFlutuante(aberto, gatilhoRef);

  const opcoes = useMemo(() => extrairOpcoes(children), [children]);
  const valorAtual = value === undefined || value === null ? '' : String(value);
  const selecionada = opcoes.find((o) => o.valor === valorAtual) || null;

  // Lista grande (referência de produto, cliente etc.) ganha uma busca
  // dentro do próprio painel — antes, digitar só pulava pra primeira letra
  // igual, o que não ajuda em nada numa lista de centenas de itens.
  const comBusca = opcoes.length > 15;
  const recentes = useMemo(() => (comBusca ? lerRecentes(chaveRecentes) : []), [comBusca, chaveRecentes, aberto]);

  const opcoesFiltradas = useMemo(() => {
    if (!comBusca) return opcoes;
    if (!filtro) {
      if (recentes.length === 0) return opcoes;
      const opcoesRecentes = recentes.map((v) => opcoes.find((o) => o.valor === v)).filter(Boolean);
      if (opcoesRecentes.length === 0) return opcoes;
      const resto = opcoes.filter((o) => !recentes.includes(o.valor));
      return [...opcoesRecentes, ...resto];
    }
    const alvo = normalizarTexto(filtro);
    return opcoes.filter((o) => normalizarTexto(o.rotulo).includes(alvo));
  }, [opcoes, filtro, comBusca, recentes]);
  // Quantas opções recentes realmente entraram no topo da lista (pode ser
  // menos que LIMITE_RECENTES se algum valor recente não existir mais nas
  // opções atuais) — usado só pra saber onde desenhar os cabeçalhos de seção.
  const qtdRecentesNoTopo = (!filtro && comBusca) ? recentes.filter((v) => opcoes.some((o) => o.valor === v)).length : 0;

  useEffect(() => {
    function aoClicarFora(e) {
      if (raizRef.current?.contains(e.target)) return;
      if (listaRef.current?.contains(e.target)) return;
      setAberto(false);
    }
    document.addEventListener('mousedown', aoClicarFora);
    return () => document.removeEventListener('mousedown', aoClicarFora);
  }, []);

  useEffect(() => {
    if (!aberto) { setFiltro(''); return; }
    if (comBusca) setTimeout(() => buscaInputRef.current?.focus(), 0);
  }, [aberto]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!aberto) return;
    const idx = opcoesFiltradas.findIndex((o) => o.valor === valorAtual);
    setDestaque(idx >= 0 ? idx : opcoesFiltradas.findIndex((o) => !o.desabilitada));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, filtro]);

  useEffect(() => {
    if (!aberto || !listaRef.current) return;
    const el = listaRef.current.querySelector(`[data-idx="${destaque}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [destaque, aberto]);

  function confirmar(idx) {
    const opcao = opcoesFiltradas[idx];
    if (!opcao || opcao.desabilitada) return;
    if (chaveRecentes) gravarRecente(chaveRecentes, opcao.valor);
    onChange?.({ target: { value: opcao.valor } });
    setAberto(false);
  }

  function mover(direcao) {
    if (opcoesFiltradas.length === 0) return;
    setDestaque((atual) => {
      let idx = atual;
      for (let i = 0; i < opcoesFiltradas.length; i += 1) {
        idx = (idx + direcao + opcoesFiltradas.length) % opcoesFiltradas.length;
        if (!opcoesFiltradas[idx].desabilitada) return idx;
      }
      return atual;
    });
  }

  function buscar(tecla) {
    const estado = buscaRef.current;
    clearTimeout(estado.timeout);
    estado.termo += tecla.toLowerCase();
    estado.timeout = setTimeout(() => { estado.termo = ''; }, 600);
    const idx = opcoes.findIndex((o) => !o.desabilitada && String(o.rotulo ?? '').toLowerCase().startsWith(estado.termo));
    if (idx < 0) return;
    if (aberto) setDestaque(idx); else confirmar(idx);
  }

  function aoTeclar(e) {
    if (disabled) return;
    if (e.key === 'Escape') { if (aberto) { e.preventDefault(); setAberto(false); } return; }
    if (!aberto) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setAberto(true);
        return;
      }
      if (e.key.length === 1) buscar(e.key);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); mover(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mover(-1); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmar(destaque); return; }
    if (e.key === 'Tab') { setAberto(false); return; }
    if (!comBusca && e.key.length === 1) buscar(e.key);
  }

  // A busca digitada dentro do painel reaproveita as mesmas teclas de
  // navegação (setas/Enter/Esc) do botão-gatilho — só não deixa a tecla
  // "vazar" pro type-ahead do botão, que não faz sentido aqui.
  function aoTeclarBusca(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); mover(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mover(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); confirmar(destaque); return; }
    if (e.key === 'Escape') { e.preventDefault(); setAberto(false); gatilhoRef.current?.focus(); }
  }

  return (
    <div
      ref={raizRef}
      className={`select-custom${aberto ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <button
        type="button"
        ref={gatilhoRef}
        className="select-custom-trigger"
        aria-haspopup="listbox"
        aria-expanded={aberto}
        disabled={disabled}
        onClick={() => setAberto((a) => !a)}
        onKeyDown={aoTeclar}
      >
        <span className={`select-custom-valor${!selecionada ? ' is-placeholder' : ''}`}>
          {selecionada ? selecionada.rotulo : (placeholder || '—')}
        </span>
        <ChevronDown size={14} className="select-custom-seta" />
      </button>
      {aberto && pos && createPortal(
        <div
          className="select-custom-painel"
          ref={listaRef}
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {comBusca && (
            <div className="select-custom-busca">
              <input
                ref={buscaInputRef}
                type="text"
                placeholder="Digite pra filtrar…"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                onKeyDown={aoTeclarBusca}
              />
            </div>
          )}
          <ul className="select-custom-lista" role="listbox">
            {opcoesFiltradas.length === 0 && (
              <li className="select-custom-vazio">Nada encontrado.</li>
            )}
            {opcoesFiltradas.map((o, idx) => (
              <Fragment key={`${o.valor}-${idx}`}>
                {!filtro && idx === 0 && qtdRecentesNoTopo > 0 && (
                  <li className="select-custom-secao">Usadas recentemente</li>
                )}
                {!filtro && idx === qtdRecentesNoTopo && qtdRecentesNoTopo > 0 && (
                  <li className="select-custom-secao">Todas</li>
                )}
                {o.grupo && o.grupo !== opcoesFiltradas[idx - 1]?.grupo && (
                  <li className="select-custom-secao">{o.grupo}</li>
                )}
                <li
                  role="option"
                  data-idx={idx}
                  aria-selected={o.valor === valorAtual}
                  aria-disabled={o.desabilitada}
                  className={`select-custom-opcao${idx === destaque ? ' is-destaque' : ''}${o.valor === valorAtual ? ' is-selecionada' : ''}${o.desabilitada ? ' is-desabilitada' : ''}`}
                  onMouseEnter={() => !o.desabilitada && setDestaque(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => confirmar(idx)}
                >
                  <span>{o.rotulo}</span>
                  {o.valor === valorAtual && <Check size={13} className="select-custom-check" />}
                </li>
              </Fragment>
            ))}
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
}

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// Uma cor por dia da semana (só de propósito — pra não ficar um calendário
// monocromático) que colore tanto o cabeçalho quanto uma leve tonalidade de
// fundo nas células daquela coluna, deixando fácil "escanear" a semana.
const DIAS_SEMANA = [
  { rotulo: 'Dom', cor: 'var(--danger)' },
  { rotulo: 'Seg', cor: 'var(--info)' },
  { rotulo: 'Ter', cor: 'var(--teal)' },
  { rotulo: 'Qua', cor: 'var(--brass)' },
  { rotulo: 'Qui', cor: 'var(--plum)' },
  { rotulo: 'Sex', cor: 'var(--terracotta)' },
  { rotulo: 'Sáb', cor: 'var(--success)' },
];

function paraData(iso) {
  if (!iso) return null;
  const [ano, mes, dia] = String(iso).split('-').map(Number);
  if (!ano || !mes || !dia) return null;
  return new Date(ano, mes - 1, dia);
}

function paraIso(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function formatarBr(data) {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${data.getFullYear()}`;
}

function gerarCelulas(ano, mes) {
  const primeiroDoMes = new Date(ano, mes, 1);
  const inicioGrade = new Date(primeiroDoMes);
  inicioGrade.setDate(primeiroDoMes.getDate() - primeiroDoMes.getDay());
  const celulas = [];
  for (let i = 0; i < 42; i += 1) {
    const data = new Date(inicioGrade);
    data.setDate(inicioGrade.getDate() + i);
    celulas.push({ data, foraDoMes: data.getMonth() !== mes });
  }
  return celulas;
}

const LARGURA_PAINEL = 272; // precisa bater com a largura fixa de .date-custom-painel no CSS

function hojeSemHora() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Substituto do <input type="date"> nativo — mesma API (value em
// "AAAA-MM-DD", onChange recebe um evento sintético com target.value, dá pra
// trocar só a tag em qualquer tela sem mexer no resto do código) só que com
// um calendário próprio em vez do widget do sistema operacional.
export function DateInput({ value, onChange, onBlur, disabled, placeholder = 'dd/mm/aaaa', className = '', style }) {
  const [aberto, setAberto] = useState(false);
  const raizRef = useRef(null);
  const gatilhoRef = useRef(null);
  const painelRef = useRef(null);
  const selecionada = useMemo(() => paraData(value), [value]);
  const [cursor, setCursor] = useState(() => selecionada || new Date());
  const hoje = hojeSemHora();
  const pos = usePosicaoFlutuante(aberto, gatilhoRef);

  // Guarda sempre a versão mais recente do onBlur: em telas que fazem
  // onChange (só troca o estado local) + onBlur (salva de fato, lendo o
  // estado mais recente do componente pai), disparar os dois no mesmo evento
  // chamaria uma versão do onBlur "presa" no estado de ANTES da troca. O ref
  // é atualizado depois de cada render (useEffect), então quando o fechar()
  // adia a chamada pro próximo tick, ela já pega o onBlur atualizado.
  const onBlurRef = useRef(onBlur);
  useEffect(() => { onBlurRef.current = onBlur; });

  useEffect(() => {
    if (aberto) setCursor(selecionada || new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  function fechar() {
    setAberto(false);
    setTimeout(() => onBlurRef.current?.(), 0);
  }

  useEffect(() => {
    if (!aberto) return undefined;
    function aoClicarFora(e) {
      if (raizRef.current?.contains(e.target)) return;
      if (painelRef.current?.contains(e.target)) return;
      fechar();
    }
    document.addEventListener('mousedown', aoClicarFora);
    return () => document.removeEventListener('mousedown', aoClicarFora);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  function selecionar(data) {
    onChange?.({ target: { value: paraIso(data) } });
    fechar();
  }

  function limpar(e) {
    e.stopPropagation();
    onChange?.({ target: { value: '' } });
    fechar();
  }

  function aoTeclar(e) {
    if (disabled) return;
    if (!aberto) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setAberto(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); fechar(); }
  }

  // Sem isso, o mousedown no botão do dia move o FOCO pra ele antes do
  // click disparar; como esse botão some do DOM assim que o dia é
  // selecionado (o painel fecha), o navegador precisa "realocar" o foco na
  // hora — e acaba reabrindo o calendário sozinho ao focar (e re-clicar) o
  // botão-gatilho. Prevenindo o foco no mousedown, isso nunca acontece.
  function semFoco(e) { e.preventDefault(); }

  const celulas = useMemo(() => gerarCelulas(cursor.getFullYear(), cursor.getMonth()), [cursor]);

  return (
    <div
      ref={raizRef}
      className={`date-custom${aberto ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      // O campo costuma vir dentro de um <label> (componente Field). Sem isso,
      // o navegador "repassa" todo clique aqui dentro pro primeiro <button>
      // de verdade que existir (o de limpar, ou o de navegação do mês) --
      // um comportamento nativo de label pensado pra <input>, que aqui só
      // reabria o calendário sozinho logo depois de escolher uma data.
      onClick={(e) => e.preventDefault()}
    >
      <div
        ref={gatilhoRef}
        className="date-custom-trigger"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && setAberto((a) => !a)}
        onKeyDown={aoTeclar}
      >
        <CalendarDays size={14} className="date-custom-icone" />
        <span className={`date-custom-valor${!selecionada ? ' is-placeholder' : ''}`}>
          {selecionada ? formatarBr(selecionada) : placeholder}
        </span>
      </div>
      {selecionada && !disabled && (
        // Fica FORA da trigger de propósito (não aninhado): um botão dentro
        // de outro elemento clicável levou o Chrome a "avançar o foco" pra
        // ele sozinho assim que o calendário abria, reabrindo tudo na hora
        // errada — como irmão, isso não acontece mais.
        <button
          type="button"
          className="date-custom-limpar"
          aria-label="Limpar data"
          onMouseDown={semFoco}
          onClick={limpar}
        >
          ×
        </button>
      )}
      {aberto && pos && createPortal(
        <div
          ref={painelRef}
          className="date-custom-painel"
          role="dialog"
          aria-label="Escolher data"
          style={{ top: pos.top, left: Math.max(8, Math.min(pos.left, window.innerWidth - LARGURA_PAINEL - 8)) }}
        >
          <div className="date-custom-cabecalho">
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear() - 1, c.getMonth(), 1))} aria-label="Ano anterior"><ChevronsLeft size={14} /></button>
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))} aria-label="Mês anterior"><ChevronLeft size={14} /></button>
            <span className="date-custom-titulo">{MESES[cursor.getMonth()]} {cursor.getFullYear()}</span>
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))} aria-label="Próximo mês"><ChevronRight size={14} /></button>
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear() + 1, c.getMonth(), 1))} aria-label="Próximo ano"><ChevronsRight size={14} /></button>
          </div>
          <div className="date-custom-semana">
            {DIAS_SEMANA.map((d) => (
              <span key={d.rotulo} className="date-custom-semana-item" style={{ color: d.cor }}>{d.rotulo}</span>
            ))}
          </div>
          <div className="date-custom-grade">
            {celulas.map((c) => {
              const cor = DIAS_SEMANA[c.data.getDay()].cor;
              const isSelecionado = selecionada && c.data.getTime() === selecionada.getTime();
              const isHoje = c.data.getTime() === hoje.getTime();
              return (
                <button
                  key={c.data.getTime()}
                  type="button"
                  className={`date-custom-dia${c.foraDoMes ? ' is-fora' : ''}${isSelecionado ? ' is-selecionado' : ''}${isHoje && !isSelecionado ? ' is-hoje' : ''}`}
                  style={{ '--cor-coluna': cor }}
                  onMouseDown={semFoco}
                  onClick={() => selecionar(c.data)}
                >
                  {c.data.getDate()}
                </button>
              );
            })}
          </div>
          <div className="date-custom-rodape">
            <button type="button" className="date-custom-acao" onMouseDown={semFoco} onClick={() => selecionar(new Date())}>Hoje</button>
            {selecionada && <button type="button" className="date-custom-acao" onMouseDown={semFoco} onClick={limpar}>Limpar</button>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
