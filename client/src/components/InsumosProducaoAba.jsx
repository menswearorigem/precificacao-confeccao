// Aba de INSUMOS dentro do módulo Produção (10/09/2026).
//
// Três telas dentro de uma aba, na ordem em que o trabalho acontece:
//
//   1. Insumos      — a lista de matéria-prima com custo e unidade, e a fila
//                     de unidades que o sistema inferiu e alguém precisa
//                     confirmar.
//   2. Vínculos     — quais linhas de ficha técnica ainda não apontam para um
//                     insumo cadastrado, com candidatos ordenados. Casamento
//                     exato pode ir em lote; parecido é escolha humana.
//   3. Distribuição — a prévia e a aplicação da redistribuição de custo:
//                     tira do custo industrial o que na verdade é
//                     matéria-prima, sem mexer no custo total da peça.
//
// REGRA 1 — esta tela não recalcula preço, margem nem markup. Ela mostra o
// que o servidor calculou e pede confirmação antes de gravar.
// REGRA 2 — tudo que não dá para calcular aparece escrito, com o motivo, em
// vez de virar R$ 0,00 ou de casar por semelhança em silêncio.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes, CircleSlash, AlertTriangle, Link2, Scale, ArrowLeftRight, Check, Info, Wand2,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, CampoBusca, IndicadorDestaque, Paginacao, Checkbox, Field,
} from './ui';
import { confirmar } from './ConfirmDialog';
import { useTabela } from '../lib/useTabela';
import { brl, formatQtd, numeroBr } from '../lib/format';

const TIPO_INSUMO = {
  tecido: 'Tecido', aviamento: 'Aviamento', embalagem: 'Embalagem',
  etiqueta: 'Etiqueta', servico: 'Serviço', outro: 'Outro',
};

const UNIDADES = [
  ['un', 'unidade'], ['m', 'metro'], ['kg', 'quilo'], ['rolo', 'rolo'],
  ['cone', 'cone'], ['milheiro', 'milheiro'], ['par', 'par'], ['peca', 'peça'], ['l', 'litro'],
];

const CONFIANCA = {
  alta: { rotulo: 'inferida (alta)', tom: 'tone-atencao' },
  media: { rotulo: 'inferida (média)', tom: 'tone-atencao' },
  baixa: { rotulo: 'PALPITE', tom: 'tone-prejuizo' },
};

// As frases que a tela usa para cada situação de referência na distribuição.
// Ficam aqui, e não no servidor, só para o texto ser curto na tabela — o
// motivo completo vem do servidor e aparece na linha expandida.
const SITUACAO_DIST = {
  ok: { rotulo: 'Pronta', tom: 'tone-saudavel' },
  nada_a_fazer: { rotulo: 'Nada a mudar', tom: 'tone-neutro' },
  sem_custo_industrial: { rotulo: 'Sem custo industrial', tom: 'tone-atencao' },
  industrial_insuficiente: { rotulo: 'Material > industrial', tom: 'tone-prejuizo' },
  diferenca_acima_do_limite: { rotulo: 'Conta não fecha', tom: 'tone-prejuizo' },
};

function SeloUnidade({ insumo }) {
  const c = insumo.unidade_confianca ? CONFIANCA[insumo.unidade_confianca] : null;
  return (
    <span className="insumo-unidade-selo">
      <span className="mono">{insumo.unidade}</span>
      {c && <span className={`selo ${c.tom}`}>{c.rotulo}</span>}
    </span>
  );
}

function Custo({ valor, casas = 4 }) {
  if (valor === null || valor === undefined) {
    return (
      <span className="cobertura-sem-valor" title="Nenhuma nota entrou e ninguém digitou. Sem custo não é R$ 0,00.">
        <CircleSlash size={13} /> sem custo
      </span>
    );
  }
  return <span className="mono">{brl(Number(valor), casas)}</span>;
}

// ===========================================================================
// 1. Lista de insumos
// ===========================================================================
function ListaInsumos({ insumos, carregando, onConfirmarUnidade }) {
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [tipo, setTipo] = useState('');
  const [somenteAConfirmar, setSomenteAConfirmar] = useState(false);
  const [somenteSemCusto, setSomenteSemCusto] = useState(false);
  const [editando, setEditando] = useState(null);

  const filtrados = useMemo(() => insumos.filter((i) => {
    if (tipo && i.tipo !== tipo) return false;
    if (somenteAConfirmar && !i.unidade_confianca) return false;
    if (somenteSemCusto && i.custo_atual !== null) return false;
    if (buscaAplicada) {
      const t = buscaAplicada.toLowerCase();
      if (!`${i.nome} ${i.codigo || ''} ${i.especificacao || ''}`.toLowerCase().includes(t)) return false;
    }
    return true;
  }), [insumos, tipo, somenteAConfirmar, somenteSemCusto, buscaAplicada]);

  const colunas = useMemo(() => ({
    codigo: (i) => i.codigo || '',
    nome: (i) => i.nome || '',
    tipo: (i) => i.tipo || '',
    unidade: (i) => i.unidade || '',
    custo: (i) => (i.custo_atual === null ? -1 : Number(i.custo_atual)),
    fichas: (i) => Number(i.fichas_que_usam || 0),
  }), []);
  const tabela = useTabela(filtrados, { colunas, colunaPadrao: 'nome', tamanhoPadrao: 50, prefixo: 'pins' });

  return (
    <>
      <div className="filtros-linha">
        <CampoBusca
          valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)}
          placeholder="Nome, código ou especificação do insumo"
        />
        <Select value={tipo} onChange={(e) => setTipo(e.target.value)} placeholder="Todos os tipos">
          {Object.entries(TIPO_INSUMO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <label className="filtro-marcavel">
          <Checkbox checked={somenteAConfirmar} onChange={(e) => setSomenteAConfirmar(e.target.checked)} />
          Só unidade a confirmar
        </label>
        <label className="filtro-marcavel">
          <Checkbox checked={somenteSemCusto} onChange={(e) => setSomenteSemCusto(e.target.checked)} />
          Só sem custo
        </label>
      </div>

      {carregando && <Skeleton height={280} />}
      {!carregando && filtrados.length === 0 && (
        <EstadoVazio
          Icone={Boxes}
          titulo="Nenhum insumo com esses filtros"
          descricao="A lista de matéria-prima do Wik entrou inteira no cadastro. Limpe os filtros para ver tudo."
        />
      )}

      {!carregando && filtrados.length > 0 && (
        <>
          <Paginacao {...tabela} posicao="topo" />
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Insumo</th>
                  <th>Tipo</th>
                  <th>Unidade</th>
                  <th className="num">Custo atual</th>
                  <th className="num">Fichas que usam</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tabela.itensPagina.map((i) => (
                  <tr key={i.id} className={i.unidade_confianca === 'baixa' ? 'linha-pendente' : undefined}>
                    <td className="mono ink-soft">{i.codigo || '—'}</td>
                    <td>
                      <div className="insumo-item-nota">
                        <strong>{i.nome}</strong>
                        {i.unidade_confianca && (
                          <small>
                            A unidade foi deduzida da descrição, não veio do Wik. Confirme antes que ela vire custo de produto.
                          </small>
                        )}
                      </div>
                    </td>
                    <td>{TIPO_INSUMO[i.tipo] || i.tipo}</td>
                    <td><SeloUnidade insumo={i} /></td>
                    <td className="num"><Custo valor={i.custo_atual} /></td>
                    <td className="num mono">{formatQtd(i.fichas_que_usam || 0)}</td>
                    <td className="num">
                      <button type="button" className="btn-sec btn-mini" onClick={() => setEditando(i)}>
                        <Scale size={13} /> unidade
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Paginacao {...tabela} />
        </>
      )}

      {editando && (
        <ConfirmarUnidade
          insumo={editando}
          onFechar={() => setEditando(null)}
          onSalvo={() => { setEditando(null); onConfirmarUnidade(); }}
        />
      )}
    </>
  );
}

// ===========================================================================
// Confirmar/corrigir a unidade de um insumo
// ===========================================================================
function ConfirmarUnidade({ insumo, onFechar, onSalvo }) {
  const [unidade, setUnidade] = useState(insumo.unidade || 'un');
  const [unidadeConsumo, setUnidadeConsumo] = useState(insumo.unidade_consumo || '');
  const [fator, setFator] = useState(insumo.fator_conversao ?? '');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const explicacao = useMemo(() => {
    const obs = String(insumo.observacoes || '');
    const m = obs.match(/Unidade "[^"]+" definida por regra automática \([^)]*\): ([^.]+\.)/);
    return m ? m[1] : null;
  }, [insumo.observacoes]);

  async function salvar() {
    setSalvando(true);
    setErro('');
    try {
      await api.put(`/producao-insumos/${insumo.id}/unidade`, {
        unidade,
        unidade_consumo: unidadeConsumo || null,
        fator_conversao: fator === '' ? null : Number(fator),
      });
      onSalvo();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="anuncio-painel-fundo" onClick={onFechar}>
      <aside className="anuncio-painel" onClick={(e) => e.stopPropagation()}>
        <header className="anuncio-painel-topo">
          <div>
            <h2>{insumo.nome}</h2>
            <p className="ink-soft">{insumo.codigo || 'sem código'}</p>
          </div>
          <button type="button" className="btn-icone" onClick={onFechar}>✕</button>
        </header>

        <div className="anuncio-painel-corpo">
        {insumo.unidade_confianca && (
          <p className="grafico-explicacao">
            <Info size={14} /> O Wik não informa unidade de medida. O sistema deduziu <strong>{insumo.unidade}</strong>
            {explicacao ? ` porque ${explicacao.toLowerCase()}` : '.'} Enquanto ninguém confirmar, este insumo
            não entra no custo de nenhum produto.
          </p>
        )}

        <Field label="Unidade de compra e estoque">
          <Select value={unidade} onChange={(e) => setUnidade(e.target.value)}>
            {UNIDADES.map(([k, v]) => <option key={k} value={k}>{`${k} — ${v}`}</option>)}
          </Select>
        </Field>

        <Field
          label="A ficha consome em outra unidade?"
          hint="Só preencha quando comprar e consumir forem grandezas diferentes — malha comprada em quilo e consumida em metro, por exemplo."
        >
          <Select value={unidadeConsumo} onChange={(e) => setUnidadeConsumo(e.target.value)} placeholder="Mesma unidade da compra">
            {UNIDADES.map(([k, v]) => <option key={k} value={k}>{`${k} — ${v}`}</option>)}
          </Select>
        </Field>

        {unidadeConsumo && unidadeConsumo !== unidade && (
          <Field
            label={`Quantos ${unidade} tem em 1 ${unidadeConsumo}?`}
            hint={`Exemplo: se 1 metro dessa malha pesa 0,32 kg, o fator é 0,32. Sem esse número o custo sairia trocado — quilo virando metro muda o custo da peça por um fator de três.`}
          >
            <input
              className="input" type="number" step="0.000001" value={fator}
              onChange={(e) => setFator(e.target.value)}
            />
          </Field>
        )}

        {erro && <p className="erro-inline">{erro}</p>}
        </div>

        <div className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={salvando} onClick={salvar}>
            <Check size={14} /> Confirmar unidade
          </button>
        </div>
      </aside>
    </div>
  );
}

// ===========================================================================
// 2. Vínculos ficha ↔ insumo
// ===========================================================================
function Vinculos({ onMudou }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [aplicando, setAplicando] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [tamanho, setTamanho] = useState(50);
  const [situacao, setSituacao] = useState('');

  // A paginação é do SERVIDOR, e não da tela: com 3.267 linhas de ficha, baixar
  // tudo e desenhar tudo era o que deixava esta aba carregando para sempre.
  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams({ pagina: String(pagina), tamanho: String(tamanho) });
      if (buscaAplicada) qs.set('busca', buscaAplicada);
      if (situacao) qs.set('situacao', situacao);
      setDados(await api.get(`/producao-insumos/vinculos?${qs}`));
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [buscaAplicada, pagina, tamanho, situacao]);

  useEffect(() => { carregar(); }, [carregar]);

  async function ligarExatos() {
    const previa = await api.post('/producao-insumos/vincular-exatos', {});
    if (previa.total === 0) {
      setErro('Nenhuma linha de ficha bate exatamente com o nome de um insumo cadastrado. As parecidas continuam na lista para escolha à mão.');
      return;
    }
    const segue = await confirmar(
      `${previa.total} linha(s) de ficha têm o nome EXATAMENTE igual ao de um insumo cadastrado. `
      + 'Só essas serão vinculadas — nome parecido não entra. Vincular agora?',
      { titulo: 'Vincular por nome exato', confirmarTexto: 'Vincular', perigo: false }
    );
    if (!segue) return;
    setAplicando(true);
    try {
      await api.post('/producao-insumos/vincular-exatos', { confirmar: true });
      await carregar();
      onMudou?.();
    } catch (e) {
      setErro(e.message);
    } finally {
      setAplicando(false);
    }
  }

  async function ligar(materialId, insumoId) {
    try {
      await api.post('/producao-insumos/vincular', { material_id: materialId, insumo_id: insumoId });
      await carregar();
      onMudou?.();
    } catch (e) {
      setErro(e.message);
    }
  }

  if (carregando) return <Skeleton height={280} />;
  if (erro && !dados) return <p className="erro-inline">{erro}</p>;
  if (!dados) return null;

  return (
    <>
      <p className="grafico-explicacao">
        <Info size={14} /> A ficha técnica guarda o material como texto livre ("malha dry fit"), e o cadastro de
        insumo guarda outro texto ("MALHA DRY FIT PRETA 1,80"). Enquanto os dois não estiverem ligados, o custo
        do insumo não chega na ficha. Ligar por nome <strong>igual</strong> pode ir em lote; nome{' '}
        <strong>parecido</strong> é escolha de gente, uma por uma — casar por semelhança já colocou malha errada
        em ficha em muito sistema por aí.
      </p>

      <div className="indicadores-linha">
        <IndicadorDestaque rotulo="Linhas sem vínculo" valor={formatQtd(dados.total)} Icone={Link2}
          explicacao="Linhas de ficha técnica que ainda não apontam para um insumo do cadastro." />
        <IndicadorDestaque rotulo="Casam por nome exato" valor={formatQtd(dados.exatos)} tom={dados.exatos > 0 ? 'saudavel' : undefined}
          explicacao="Nome idêntico ao de um único insumo. Essas dá para vincular em lote com segurança." />
        <IndicadorDestaque rotulo="Empatadas" valor={formatQtd(dados.ambiguos)} tom={dados.ambiguos > 0 ? 'atencao' : undefined}
          explicacao="O nome bate com mais de um insumo. Empate nunca casa sozinho." />
        <IndicadorDestaque rotulo="Só parecidas" valor={formatQtd(dados.sugestoes)} tom={dados.sugestoes > 0 ? 'atencao' : undefined}
          explicacao="Existem candidatos, mas nenhum com o nome igual. Escolha à mão." />
        <IndicadorDestaque rotulo="Sem candidato" valor={formatQtd(dados.sem_candidato)}
          explicacao="Nada no cadastro se parece com esse texto — talvez o insumo ainda não exista." />
      </div>

      <div className="filtros-linha">
        <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => { setPagina(1); setBuscaAplicada(busca); }}
          placeholder="Referência do produto ou texto do material" />
        <Select value={situacao} onChange={(e) => { setPagina(1); setSituacao(e.target.value); }} placeholder="Todas as situações">
          <option value="exato">Nome exato</option>
          <option value="ambiguo">Empate</option>
          <option value="sugestao">Só parecidas</option>
          <option value="nenhum">Sem candidato</option>
        </Select>
        <button type="button" className="btn btn-primary" disabled={aplicando || dados.exatos === 0} onClick={ligarExatos}>
          <Link2 size={14} /> Vincular as {formatQtd(dados.exatos)} de nome exato
        </button>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}

      {dados.linhas.length === 0 ? (
        <EstadoVazio Icone={Check} titulo="Nenhuma linha de ficha sem vínculo"
          descricao="Todas as linhas de ficha técnica já apontam para um insumo cadastrado." />
      ) : (
        <>
        <Paginacao
          pagina={dados.pagina} totalPaginas={dados.total_paginas} tamanho={dados.tamanho}
          totalItens={dados.total_filtrado} inicio={dados.inicio} fim={dados.fim}
          setPagina={setPagina} setTamanho={(t) => { setPagina(1); setTamanho(t); }} posicao="topo"
        />
        <div className="tabela-rolagem">
          <table className="tabela-nota">
            <thead>
              <tr>
                <th>Referência</th>
                <th>Material na ficha</th>
                <th className="num">Qtd.</th>
                <th>Situação</th>
                <th>Insumo</th>
              </tr>
            </thead>
            <tbody>
              {dados.linhas.map((l) => (
                <tr key={l.id} className={l.casamento === 'exato' ? undefined : 'linha-pendente'}>
                  <td className="mono">{l.referencia}</td>
                  <td>
                    <div className="insumo-item-nota">
                      <strong>{l.material || '(sem nome)'}</strong>
                      {l.motivo && <small>{l.motivo}</small>}
                    </div>
                  </td>
                  <td className="num mono">
                    {numeroBr(l.quantidade, 4)} {l.unidade || <span className="ink-faint">sem unidade</span>}
                  </td>
                  <td>
                    <span className={`selo ${l.casamento === 'exato' ? 'tone-saudavel' : l.casamento === 'nenhum' ? 'tone-neutro' : 'tone-atencao'}`}>
                      {l.casamento === 'exato' ? 'nome exato' : l.casamento === 'ambiguo' ? 'empate' : l.casamento === 'sugestao' ? 'parecido' : 'sem candidato'}
                    </span>
                  </td>
                  <td>
                    {l.candidatos.length === 0 ? (
                      <span className="ink-faint">—</span>
                    ) : (
                      <Select
                        value=""
                        onChange={(e) => e.target.value && ligar(l.id, Number(e.target.value))}
                        placeholder={l.casamento === 'exato' ? `${l.insumo_sugerido?.nome} (vincular)` : 'Escolher insumo…'}
                      >
                        {l.candidatos.map((c) => (
                          <option key={c.id} value={String(c.id)}>
                            {`${c.nome} · ${c.unidade} · ${c.custo_atual === null ? 'sem custo' : brl(Number(c.custo_atual), 4)}${c.unidade_confianca ? ' · unidade a confirmar' : ''}`}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Paginacao
          pagina={dados.pagina} totalPaginas={dados.total_paginas} tamanho={dados.tamanho}
          totalItens={dados.total_filtrado} inicio={dados.inicio} fim={dados.fim}
          setPagina={setPagina} setTamanho={(t) => { setPagina(1); setTamanho(t); }}
        />
        </>
      )}
    </>
  );
}

// ===========================================================================
// 3. Distribuição do custo
// ===========================================================================
function Distribuicao({ onMudou }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aceitarPalpite, setAceitarPalpite] = useState(false);
  const [somenteAplicaveis, setSomenteAplicaveis] = useState(true);
  const [marcados, setMarcados] = useState(() => new Set());
  const [aberta, setAberta] = useState(null);
  const [aplicando, setAplicando] = useState(false);
  const [pagina, setPagina] = useState(1);
  const [tamanho, setTamanho] = useState(50);

  // Paginação do SERVIDOR: os indicadores do topo somam TODAS as referências,
  // mas só a página pedida vem na resposta. Com 1.926 referências, devolver
  // todos os planos de uma vez dava um JSON de vários MB por requisição.
  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams({ pagina: String(pagina), tamanho: String(tamanho) });
      if (aceitarPalpite) qs.set('aceitar_unidade_nao_confirmada', 'true');
      if (somenteAplicaveis) qs.set('somente_aplicaveis', 'true');
      const r = await api.get(`/producao-insumos/distribuicao?${qs}`);
      setDados(r);
      setMarcados(new Set(r.aplicaveis_ids || []));
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [aceitarPalpite, pagina, tamanho, somenteAplicaveis]);

  useEffect(() => { carregar(); }, [carregar]);

  const visiveis = useMemo(() => (dados ? dados.planos : []), [dados]);

  async function aplicar() {
    const ids = [...marcados];
    if (ids.length === 0) return;
    // O total vem do indicador do topo, que soma o cadastro inteiro — a
    // página carregada tem só uma fatia dos planos.
    const total = ids.length === (dados.aplicaveis_ids || []).length
      ? dados.valor_a_mover
      : dados.planos.filter((p) => marcados.has(p.produto_id)).reduce((s, p) => s + p.delta, 0);
    const segue = await confirmar(
      `${ids.length} referência(s) vão ter ${brl(total)} tirados do custo industrial e lançados como matéria-prima na ficha. `
      + 'O custo de produção de cada peça continua o mesmo — muda só onde o custo está. '
      + 'Depois de gravar, o sistema relê do banco e confere referência por referência; se alguma mudar de custo, nada é gravado.',
      { titulo: 'Redistribuir o custo', confirmarTexto: 'Redistribuir', perigo: false }
    );
    if (!segue) return;
    setAplicando(true);
    setErro('');
    try {
      const r = await api.post('/producao-insumos/distribuicao/aplicar', {
        produto_ids: ids, confirmar: true, aceitar_unidade_nao_confirmada: aceitarPalpite,
      });
      await carregar();
      onMudou?.();
      if (r.aviso) setErro(r.aviso);
    } catch (e) {
      setErro(e.message);
    } finally {
      setAplicando(false);
    }
  }

  if (carregando) return <Skeleton height={320} />;
  if (erro && !dados) return <p className="erro-inline">{erro}</p>;
  if (!dados) return null;

  const marcadosAplicaveis = (dados.aplicaveis_ids || []).filter((id) => marcados.has(id));

  return (
    <>
      <p className="grafico-explicacao">
        <Info size={14} /> Hoje boa parte das referências tem a ficha de materiais zerada e o custo inteiro
        empilhado em custo industrial. O custo da peça está certo; o que está errado é a repartição. Esta tela
        move o valor de uma parcela para a outra <strong>mantendo a soma</strong>: se a matéria-prima cresce
        R$ 12,30, o custo industrial encolhe R$ 12,30. Preço, margem e markup não mudam.
      </p>

      <div className="indicadores-linha">
        <IndicadorDestaque rotulo="Referências prontas" valor={formatQtd(dados.aplicaveis)} Icone={ArrowLeftRight}
          tom={dados.aplicaveis > 0 ? 'saudavel' : undefined}
          explicacao="Têm ficha vinculada, quantidade, unidade compatível e custo industrial suficiente." />
        <IndicadorDestaque rotulo="Custo a reposicionar" valor={brl(dados.valor_a_mover || 0)} Icone={Scale}
          explicacao="Soma do que sai do custo industrial e entra na ficha de materiais. Não é aumento de custo." />
        <IndicadorDestaque rotulo="Maior diferença por peça" valor={brl(dados.maior_diferenca || 0, 4)}
          tom={(dados.maior_diferenca || 0) > 0.005 ? 'prejuizo' : 'saudavel'}
          explicacao="O quanto o custo de produção mudaria. O limite é meio centavo — a precisão de duas casas da coluna de custo industrial. Acima disso nada é gravado." />
        <IndicadorDestaque rotulo="Referências travadas" valor={formatQtd(dados.total - dados.aplicaveis)}
          tom={(dados.total - dados.aplicaveis) > 0 ? 'atencao' : undefined} Icone={AlertTriangle}
          explicacao="Falta vínculo, quantidade, unidade confirmada ou custo industrial. Cada uma diz o que falta." />
      </div>

      <div className="filtros-linha">
        <label className="filtro-marcavel">
          <Checkbox checked={somenteAplicaveis} onChange={(e) => { setPagina(1); setSomenteAplicaveis(e.target.checked); }} />
          Só as que dá para aplicar
        </label>
        <label className="filtro-marcavel" title="Insumo cuja unidade o sistema deduziu da descrição e ninguém confirmou ainda. Marcar isto deixa o palpite entrar no custo.">
          <Checkbox checked={aceitarPalpite} onChange={(e) => { setPagina(1); setAceitarPalpite(e.target.checked); }} />
          Aceitar insumos com unidade ainda não confirmada
        </label>
        <button type="button" className="btn btn-primary" disabled={aplicando || marcadosAplicaveis.length === 0} onClick={aplicar}>
          <ArrowLeftRight size={14} /> Redistribuir {formatQtd(marcadosAplicaveis.length)} referência(s)
        </button>
      </div>

      {aceitarPalpite && (
        <p className="aviso-inline">
          <AlertTriangle size={14} /> Você está deixando entrar no custo insumos cuja unidade o sistema deduziu
          da descrição — o Wik não informa unidade. Se a unidade estiver errada, o custo do material sai errado
          na mesma proporção (quilo por metro erra por um fator de três).
        </p>
      )}

      {erro && <p className="erro-inline">{erro}</p>}

      {visiveis.length === 0 ? (
        <EstadoVazio Icone={ArrowLeftRight} titulo="Nenhuma referência pronta para redistribuir"
          descricao="Comece pela aba de Vínculos: enquanto a linha da ficha não apontar para um insumo, não há custo de matéria-prima para calcular." />
      ) : (
        <>
          <Paginacao
            pagina={dados.pagina} totalPaginas={dados.total_paginas} tamanho={dados.tamanho}
            totalItens={dados.total_filtrado} inicio={dados.inicio} fim={dados.fim}
            setPagina={setPagina} setTamanho={(t) => { setPagina(1); setTamanho(t); }} posicao="topo"
          />
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th />
                  <th>Referência</th>
                  <th className="num">Material hoje</th>
                  <th className="num">Material depois</th>
                  <th className="num">Industrial hoje</th>
                  <th className="num">Industrial depois</th>
                  <th className="num">Custo de produção</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map((p) => (
                  <Fragment key={p.produto_id}>
                    <tr
                      className={`linha-clicavel ${p.aplicavel ? '' : 'linha-pendente'}`}
                      onClick={() => setAberta(aberta === p.produto_id ? null : p.produto_id)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={marcados.has(p.produto_id)}
                          disabled={!p.aplicavel}
                          onChange={(e) => {
                            const s = new Set(marcados);
                            if (e.target.checked) s.add(p.produto_id); else s.delete(p.produto_id);
                            setMarcados(s);
                          }}
                        />
                      </td>
                      <td>
                        <div className="insumo-item-nota">
                          <strong className="mono">{p.referencia}</strong>
                          <small>{p.descricao}</small>
                        </div>
                      </td>
                      <td className="num mono">{brl(p.totalMateriaisAtual)}</td>
                      <td className="num mono">{brl(p.totalMateriaisNovo)}</td>
                      <td className="num mono">{brl(p.totalIndustrialAtual)}</td>
                      <td className="num mono">{brl(p.totalIndustrialNovo)}</td>
                      <td className="num mono">
                        {brl(p.subtotalAtual)}
                        {Math.abs(p.diferenca || 0) > 0.0000001 && (
                          <small className="ink-soft"> (dif. {brl(p.diferenca, 4)})</small>
                        )}
                      </td>
                      <td>
                        <span className={`selo ${(SITUACAO_DIST[p.situacao] || {}).tom || 'tone-neutro'}`}>
                          {(SITUACAO_DIST[p.situacao] || {}).rotulo || p.situacao}
                        </span>
                      </td>
                    </tr>
                    {aberta === p.produto_id && (
                      <tr>
                        <td colSpan={8}>
                          {p.motivo && <p className="aviso-inline"><AlertTriangle size={14} /> {p.motivo}</p>}
                          <table className="tabela-nota tabela-embutida">
                            <thead>
                              <tr>
                                <th>Linha da ficha</th>
                                <th>Insumo</th>
                                <th className="num">Qtd.</th>
                                <th className="num">Valor hoje</th>
                                <th className="num">Valor depois</th>
                                <th>O que acontece</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.linhas.map((l) => (
                                <tr key={l.id} className={l.situacao === 'ok' ? undefined : 'linha-pendente'}>
                                  <td>{l.material || '(sem nome)'}</td>
                                  <td className="ink-soft">{l.insumo_nome || '—'}</td>
                                  <td className="num mono">{numeroBr(l.quantidade, 4)} {l.unidade || ''}</td>
                                  <td className="num mono">{brl(l.valor_unitario_atual, 4)}</td>
                                  <td className="num mono">{brl(l.valor_unitario_novo, 4)}</td>
                                  <td className="ink-soft">
                                    {l.situacao === 'ok'
                                      ? (l.ressalva || (l.fator_conversao && l.fator_conversao !== 1
                                        ? `convertido pelo fator ${numeroBr(l.fator_conversao, 6)} (${l.insumo_unidade} → ${l.unidade})`
                                        : 'custo do insumo aplicado direto'))
                                      : l.motivo}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <table className="tabela-nota tabela-embutida">
                            <thead>
                              <tr>
                                <th>Custo industrial</th>
                                <th className="num">Hoje</th>
                                <th className="num">Depois</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.industriais.map((c) => (
                                <tr key={c.id}>
                                  <td>{c.tipo}{c.observacao ? ` — ${c.observacao}` : ''}</td>
                                  <td className="num mono">{brl(c.valor_atual)}</td>
                                  <td className="num mono">{brl(c.valor_novo)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Paginacao
            pagina={dados.pagina} totalPaginas={dados.total_paginas} tamanho={dados.tamanho}
            totalItens={dados.total_filtrado} inicio={dados.inicio} fim={dados.fim}
            setPagina={setPagina} setTamanho={(t) => { setPagina(1); setTamanho(t); }}
          />
        </>
      )}
    </>
  );
}

// ===========================================================================
// Preencher tudo de uma vez
// ===========================================================================
// O pedido foi "preencha o custo de matéria prima de todos os produtos
// cadastrados". Fazer isso em três telas é transformar um pedido em tarefa.
// Este botão faz a corrente inteira num clique — vincular por nome exato,
// calcular, abater do industrial e conferir — sem afrouxar nenhuma trava:
// o que não dá para calcular continua ficando de fora, com o motivo escrito.
function PreencherTudo({ aceitarPalpite, onFeito }) {
  const [rodando, setRodando] = useState(false);
  const [erro, setErro] = useState('');
  const [resultado, setResultado] = useState(null);

  async function rodar() {
    setRodando(true);
    setErro('');
    setResultado(null);
    try {
      const previa = await api.post('/producao-insumos/preencher-tudo', {
        aceitar_unidade_nao_confirmada: aceitarPalpite,
      });
      if (previa.referencias_preenchidas === 0) {
        setResultado(previa);
        setErro('Nenhuma referência está pronta para preencher. O quadro abaixo diz o que falta em cada uma.');
        return;
      }
      const segue = await confirmar(
        `${previa.vinculos_criados} linha(s) de ficha serão ligadas ao insumo de mesmo nome, e `
        + `${previa.referencias_preenchidas} referência(s) terão ${brl(previa.valor_movido)} tirados do custo industrial `
        + 'e lançados como matéria-prima na ficha.\n\n'
        + 'O custo de produção de cada peça NÃO muda — muda só onde o custo está. '
        + `A maior diferença é de ${brl(previa.maior_diferenca, 4)}, e o sistema recusa qualquer coisa acima de meio centavo.\n\n`
        + `${previa.travadas?.length || 0} referência(s) ficam de fora, cada uma com o motivo escrito.`,
        { titulo: 'Preencher o custo de matéria-prima', confirmarTexto: 'Preencher', perigo: false }
      );
      if (!segue) return;
      const r = await api.post('/producao-insumos/preencher-tudo', {
        confirmar: true, aceitar_unidade_nao_confirmada: aceitarPalpite,
      });
      setResultado(r);
      onFeito?.();
    } catch (e) {
      setErro(e.message);
      if (e.data) setResultado(e.data);
    } finally {
      setRodando(false);
    }
  }

  return (
    <div className="preencher-tudo">
      <div className="preencher-tudo-texto">
        <strong>Preencher o custo de matéria-prima de todos os produtos</strong>
        <p className="ink-soft">
          Liga cada linha de ficha ao insumo de nome idêntico, calcula o custo do material pela unidade certa
          e abate exatamente o mesmo valor do custo industrial. <strong>O custo da peça não muda</strong> — e o
          sistema confere isso relendo do banco depois de gravar. O que não der para calcular fica de fora,
          com o motivo escrito.
        </p>
      </div>
      <button type="button" className="btn btn-primary" disabled={rodando} onClick={rodar}>
        <Wand2 size={14} /> {rodando ? 'Preenchendo…' : 'Preencher tudo'}
      </button>

      {erro && <p className="erro-inline">{erro}</p>}

      {resultado && (
        <div className="preencher-tudo-resultado">
          {resultado.confirmado && (
            <p className="aviso-inline aviso-bom">
              <Check size={14} /> Pronto: {formatQtd(resultado.referencias_preenchidas)} referência(s) preenchidas,
              {' '}{brl(resultado.valor_movido)} movidos do custo industrial para a ficha. Maior mudança no custo
              da peça: {brl(resultado.maior_diferenca, 4)}.
            </p>
          )}
          <div className="tabela-rolagem">
            <table className="tabela-nota tabela-embutida">
              <tbody>
                <tr><td>Vínculos criados por nome exato</td><td className="num mono">{formatQtd(resultado.vinculos_criados)}</td></tr>
                <tr><td>Linhas de ficha que continuam sem vínculo</td><td className="num mono">{formatQtd(resultado.linhas_sem_vinculo_restantes)}</td></tr>
                <tr className="ink-soft"><td>— o nome bate com mais de um insumo (empate)</td><td className="num mono">{formatQtd(resultado.linhas_que_nao_casaram?.ambiguo || 0)}</td></tr>
                <tr className="ink-soft"><td>— só parecidas, casar por semelhança é proibido</td><td className="num mono">{formatQtd(resultado.linhas_que_nao_casaram?.sugestao || 0)}</td></tr>
                <tr className="ink-soft"><td>— nada parecido no cadastro</td><td className="num mono">{formatQtd(resultado.linhas_que_nao_casaram?.nenhum || 0)}</td></tr>
                <tr><td>Referências preenchidas</td><td className="num mono">{formatQtd(resultado.referencias_preenchidas)}</td></tr>
                <tr><td>Referências que ficaram de fora</td><td className="num mono">{formatQtd(resultado.travadas?.length || 0)}</td></tr>
              </tbody>
            </table>
          </div>
          {resultado.travadas?.length > 0 && (
            <details className="preencher-tudo-detalhe">
              <summary>Ver por que {formatQtd(resultado.travadas.length)} ficaram de fora</summary>
              <div className="tabela-rolagem">
                <table className="tabela-nota tabela-embutida">
                  <thead><tr><th>Referência</th><th>O que falta</th></tr></thead>
                  <tbody>
                    {resultado.travadas.slice(0, 200).map((t) => (
                      <tr key={t.referencia}>
                        <td className="mono">{t.referencia}</td>
                        <td className="ink-soft">{t.motivo || t.pendencias?.[0] || t.situacao}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// A aba
// ===========================================================================
export default function InsumosProducaoAba() {
  const [sub, setSub] = useState('insumos');
  const [aceitarPalpite, setAceitarPalpite] = useState(false);
  const [insumos, setInsumos] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [lista, r] = await Promise.all([
        api.get('/producao-insumos'),
        api.get('/producao-insumos/resumo').catch(() => null),
      ]);
      setInsumos(lista);
      setResumo(r);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  return (
    <div className="aba-insumos-producao">
      {resumo && (
        <div className="indicadores-linha">
          <IndicadorDestaque rotulo="Insumos cadastrados" valor={formatQtd(resumo.insumos)} Icone={Boxes}
            explicacao="Matéria-prima e aviamento no cadastro, incluindo a lista inteira que veio do Wik." />
          <IndicadorDestaque rotulo="Sem custo" valor={formatQtd(resumo.sem_custo)} Icone={CircleSlash}
            tom={resumo.sem_custo > 0 ? 'atencao' : undefined}
            explicacao="Nunca receberam nota nem preço. Sem custo é diferente de custo zero — esses não entram em conta nenhuma." />
          <IndicadorDestaque rotulo="Unidade a confirmar" valor={formatQtd(resumo.unidade_a_confirmar)} Icone={Scale}
            tom={resumo.unidade_a_confirmar > 0 ? 'atencao' : undefined}
            explicacao="O Wik não informa unidade de medida. Nesses, o sistema deduziu da descrição e está esperando alguém confirmar." />
          <IndicadorDestaque rotulo="Linhas de ficha sem vínculo" valor={formatQtd(resumo.linhas_sem_vinculo)} Icone={Link2}
            tom={resumo.linhas_sem_vinculo > 0 ? 'atencao' : undefined}
            explicacao="Materiais escritos à mão na ficha que ainda não apontam para um insumo do cadastro." />
          <IndicadorDestaque rotulo="Referências com material zerado" valor={formatQtd(resumo.produtos_material_zerado)} Icone={AlertTriangle}
            tom={resumo.produtos_material_zerado > 0 ? 'prejuizo' : undefined}
            explicacao="Têm ficha de materiais somando R$ 0,00 — todo o custo está empilhado no custo industrial. É o problema que a aba de Distribuição resolve." />
        </div>
      )}

      <PreencherTudo aceitarPalpite={aceitarPalpite} onFeito={carregar} />

      <div className="subtab-row">
        <button type="button" className={`subtab-btn ${sub === 'insumos' ? 'active' : ''}`} onClick={() => setSub('insumos')}>
          Insumos ({formatQtd(insumos.length)})
        </button>
        <button type="button" className={`subtab-btn ${sub === 'vinculos' ? 'active' : ''}`} onClick={() => setSub('vinculos')}>
          Vínculos com a ficha
        </button>
        <button type="button" className={`subtab-btn ${sub === 'distribuicao' ? 'active' : ''}`} onClick={() => setSub('distribuicao')}>
          Distribuição do custo
        </button>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}

      {sub === 'insumos' && <ListaInsumos insumos={insumos} carregando={carregando} onConfirmarUnidade={carregar} />}
      {sub === 'vinculos' && <Vinculos onMudou={carregar} />}
      {sub === 'distribuicao' && <Distribuicao onMudou={carregar} />}
    </div>
  );
}
