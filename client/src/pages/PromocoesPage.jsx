import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, X, Tag, Zap, Ticket, Package, Layers, Plus, Trash2,
  AlertTriangle, TrendingDown, History, ExternalLink, Search, Check,
  CircleSlash, Calendar, Store, ArrowLeft, ListChecks, Pencil,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, CampoBusca, ChipsFiltros, IndicadorDestaque,
  Checkbox, NumInput, Field, Paginacao,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { useTabela } from '../lib/useTabela';
import { brl, pct, formatQtd, tempoRelativo } from '../lib/format';
import { SeloPlataforma, nomeDaLoja } from '../lib/canalMarketplace';

// A lista de lojas vem de /promocoes/lojas, e NÃO do CAMINHO_LOJAS de
// Anúncios: as duas rotas devolvem o mesmo cadastro, mas o estado de
// sincronização é de varreduras DIFERENTES. Lendo o de Anúncios, a tela
// afirmaria "as lojas foram lidas e não havia promoção" no primeiro dia,
// quando na verdade nenhuma promoção tinha sido buscada ainda.
const CAMINHO_LOJAS_PROMOCOES = '/promocoes/lojas';

// Marketplace › Promoções.
//
// Por que esta aba existe: até 06/09/2026 o Hub não tinha UMA informação
// sobre promoção. A casa entrava em campanha pelo painel de cada plataforma,
// sem nunca saber quanto de margem sobrava no preço promocional — que é o
// jeito mais silencioso de perder dinheiro que existe num marketplace.
//
// O editor imita o painel da Shopee de propósito (é o formato que a equipe já
// lê), com uma coluna que aquele painel não tem e que é o motivo desta tela:
// A MARGEM, item por item, no preço promocional.
//
// Três travas, decididas pela dona em 06/09/2026:
//   1. nenhuma ação em massa sai daqui sem a prévia — ela vê linha por linha;
//   2. prejuízo é AVISADO em vermelho, e ela decide (queimar estoque parado
//      às vezes compensa; o Hub não decide isso por ela);
//   3. tudo o que sai daqui vira histórico com o nome de quem mandou.

const TIPO_ROTULO = {
  desconto: 'Desconto de loja',
  relampago: 'Relâmpago',
  campanha_plataforma: 'Campanha da plataforma',
  campanha_vendedor: 'Campanha da loja',
  combo: 'Combo (leve N pague M)',
  brinde_adicional: 'Brinde adicional',
  cupom: 'Cupom',
  volume: 'Desconto por volume',
  desconto_item: 'Desconto individual',
};

const TIPO_ICONE = {
  desconto: Tag,
  relampago: Zap,
  cupom: Ticket,
  combo: Package,
  brinde_adicional: Package,
  campanha_plataforma: Store,
  campanha_vendedor: Store,
  volume: Layers,
  desconto_item: Tag,
};

const STATUS_ROTULO = {
  ativa: 'No ar',
  agendada: 'Agendada',
  encerrada: 'Encerrada',
  inativa: 'Desativada',
  // A plataforma respondeu uma situação que o sistema não conhece. NÃO vira
  // "encerrada": uma promoção no ar marcada como encerrada faz a dona deixar
  // de mexer numa coisa que está custando dinheiro agora.
  desconhecido: 'Situação não reconhecida',
};

const JANELA_ROTULO = {
  no_ar: 'No ar agora',
  futuras: 'Ainda vão começar',
  encerradas: 'Já terminaram',
};

const STATUS_TOM = {
  ativa: 'tone-saudavel',
  agendada: 'tone-elevada',
  encerrada: 'tone-neutro',
  inativa: 'tone-neutro',
  desconhecido: 'tone-atencao',
};

// O que cada plataforma deixa CRIAR daqui. Fica explícito na tela em vez de
// aparecer como erro depois de a pessoa preencher o formulário inteiro.
const CRIAVEL_POR_PLATAFORMA = {
  shopee: ['desconto', 'relampago'],
  tiktok_shop: ['desconto', 'relampago'],
  mercado_livre: ['desconto_item'],
  shein: [],
};

// Colunas ordenáveis da listagem. "No ar primeiro" já vem do servidor; aqui
// é a ordenação que a pessoa escolhe.
const COLUNAS_ORDENAVEIS = {
  nome: (p) => p.nome,
  loja: (p) => `${p.loja_marketplace}${p.loja_nome || ''}`,
  inicio: (p) => (p.inicio_em ? new Date(p.inicio_em).getTime() : null),
  fim: (p) => (p.fim_em ? new Date(p.fim_em).getTime() : null),
  itens: (p) => Number(p.itens_ativos || 0),
  desconto: (p) => (p.maior_desconto_pct != null ? Number(p.maior_desconto_pct) : null),
};

// O <input type="datetime-local"> entrega "2026-09-10T14:00" — hora de parede,
// SEM fuso. Mandar esse texto cru faz o servidor (e o Postgres) lerem como
// UTC: a dona digita 14h e a promoção começa às 11h no Brasil. Aqui a hora
// digitada é convertida para ISO COM o deslocamento do navegador, que é o que
// ela quis dizer.
function horaLocalParaIso(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Caminho inverso de horaLocalParaIso: o timestamp que veio do servidor volta
// para o texto "2026-09-10T14:00" que o <input type="datetime-local"> entende,
// já na hora de parede do navegador. Sem isso, abrir o formulário de edição
// mostrava o campo vazio e salvar apagaria a data.
function isoParaHoraLocal(valor) {
  if (!valor) return '';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function chaveDaLinha(l) {
  return `${l.anuncio_id_externo}::${l.variacao_id_externa || ''}`;
}

// Rótulo do desconto. Sem os dois preços NÃO inventa percentual — mostra
// travessão. Um "0%" aqui seria lido como "promoção sem desconto".
function rotuloDesconto(precoDe, precoPor) {
  const de = Number(precoDe);
  const por = Number(precoPor);
  if (!Number.isFinite(de) || !Number.isFinite(por) || de <= 0) return '—';
  return pct((de - por) / de, 0);
}

// ===========================================================================
// Margem ao vivo
// ===========================================================================
// A margem que vem do servidor é a do preço QUE O SERVIDOR calculou. No
// instante em que alguém digita outro preço, aquele número passa a ser
// mentira — e mostrar "margem saudável" em verde ao lado de um preço que a
// pessoa acabou de derrubar abaixo do custo é exatamente o erro que esta aba
// existe pra evitar.
//
// Então toda edição de preço dispara uma pergunta nova ao servidor, e quem
// responde continua sendo o motor de cálculo (REGRA 1). Nada de margem
// calculada no navegador: o custo, os impostos da empresa e as taxas moram lá.
//
// Enquanto a resposta não chega, o selo mostra que está recalculando — em vez
// de mostrar o número velho como se fosse o novo.
function useMargensAoVivo(pendentes) {
  const [margens, setMargens] = useState({});
  const [recalculando, setRecalculando] = useState(false);

  // A chave serializada evita refazer a chamada a cada re-render: só muda
  // quando um preço muda de verdade.
  const assinatura = JSON.stringify(
    (pendentes || []).map((p) => [p.chave, p.produto_id, p.preco])
  );

  useEffect(() => {
    const itens = JSON.parse(assinatura)
      .map(([chave, produto_id, preco]) => ({ chave, produto_id, preco }))
      .filter((i) => i.produto_id != null && Number(i.preco) > 0);
    if (itens.length === 0) { setMargens({}); setRecalculando(false); return undefined; }

    setRecalculando(true);
    let cancelado = false;
    // Espera a digitação parar: sem isso, cada tecla vira uma chamada.
    const timer = setTimeout(() => {
      api.post('/promocoes/margem', { itens })
        .then((d) => {
          if (cancelado) return;
          const mapa = {};
          for (const r of d.itens) mapa[r.chave] = r;
          setMargens(mapa);
        })
        .catch(() => { if (!cancelado) setMargens({}); })
        .finally(() => { if (!cancelado) setRecalculando(false); });
    }, 400);
    return () => { cancelado = true; clearTimeout(timer); };
  }, [assinatura]);

  return { margens, recalculando };
}

// ===========================================================================
// Selo de margem — o componente que dá sentido à aba inteira
// ===========================================================================
function SeloMargem({ margem, indisponivel, compacto = false, recalculando = false }) {
  if (recalculando) {
    return (
      <span className="promocao-margem tone-neutro" title="Recalculando a margem para o preço novo…">
        …
      </span>
    );
  }
  if (indisponivel) {
    return (
      <span className="promocao-margem tone-neutro" title={indisponivel}>
        <CircleSlash size={12} /> {compacto ? '—' : indisponivel}
      </span>
    );
  }
  if (!margem || margem.lucroPct == null) return <span className="promocao-margem tone-neutro">—</span>;

  // Prejuízo é o único vermelho forte. Abaixo da mínima é laranja: continua
  // sendo decisão dela.
  const tom = margem.prejuizo ? 'tone-prejuizo' : (margem.abaixoDoMinimo ? 'tone-atencao' : 'tone-saudavel');
  return (
    <span
      className={`promocao-margem ${tom}`}
      title={`Lucro de ${brl(margem.lucroRS)} por peça neste preço. Preço mínimo aceitável: ${brl(margem.precoMinimo)}.`}
    >
      {margem.prejuizo && <AlertTriangle size={12} />}
      {pct(margem.lucroPct, 1)}
      {!compacto && margem.lucroRS != null && <small>{brl(margem.lucroRS)}</small>}
    </span>
  );
}

// ===========================================================================
// Cartão de promoção
// ===========================================================================
function CartaoPromocao({ promocao, onAbrir, selecionada }) {
  const Icone = TIPO_ICONE[promocao.tipo] || Tag;
  const plataforma = promocao.loja_marketplace || promocao.marketplace;
  const itens = Number(promocao.itens_ativos || 0);
  const recusados = Number(promocao.itens_recusados || 0);

  return (
    <button
      type="button"
      className={`promocao-card plataforma-${plataforma} ${selecionada ? 'selecionado' : ''}`}
      onClick={() => onAbrir(promocao)}
    >
      <div className="promocao-card-faixa" />
      <div className="promocao-card-topo">
        <span className="promocao-card-loja">
          <SeloPlataforma chave={plataforma} size={16} />
          <span>{nomeDaLoja({ marketplace: plataforma, nome: promocao.loja_nome })}</span>
        </span>
        <span className={`selo ${STATUS_TOM[promocao.status] || 'tone-neutro'}`}>
          {STATUS_ROTULO[promocao.status] || promocao.status}
        </span>
      </div>

      <div className="promocao-card-corpo">
        <span className="promocao-card-tipo"><Icone size={13} /> {TIPO_ROTULO[promocao.tipo] || promocao.tipo}</span>
        <h3 className="promocao-card-nome">{promocao.nome || `Promoção ${promocao.promocao_id_externo}`}</h3>
        <span className="promocao-card-janela">
          <Calendar size={12} />
          {promocao.inicio_em ? new Date(promocao.inicio_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'sem início'}
          {' → '}
          {promocao.fim_em ? new Date(promocao.fim_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'sem fim'}
        </span>
      </div>

      <div className="promocao-card-rodape">
        <span title="Anúncios dentro desta promoção">
          <ListChecks size={12} /> {formatQtd(itens)} {itens === 1 ? 'anúncio' : 'anúncios'}
        </span>
        {promocao.maior_desconto_pct != null && (
          <span title="Maior desconto entre os itens desta promoção">
            <TrendingDown size={12} /> até {pct(promocao.maior_desconto_pct, 0)}
          </span>
        )}
        {recusados > 0 && (
          <span className="promocao-card-recusados" title="Itens que a plataforma recusou nesta promoção">
            <AlertTriangle size={12} /> {formatQtd(recusados)} recusado{recusados === 1 ? '' : 's'}
          </span>
        )}
        {promocao.criada_no_hub && <span className="promocao-card-selo-hub" title="Criada aqui no HBN Hub">Hub</span>}
      </div>
    </button>
  );
}

// ===========================================================================
// Regra de preço em massa
// ===========================================================================
// Os três modos que a dona pediu ("promoção x e y para tal valor"), mais o de
// margem — que é o único que responde a pergunta certa: "quanto eu POSSO
// descontar?" em vez de "quanto eu quero descontar?".
function RegraDePreco({ regra, onChange }) {
  return (
    <div className="promocao-regra">
      <Field label="Como calcular o preço promocional">
        <Select value={regra.tipo} onChange={(e) => onChange({ ...regra, tipo: e.target.value, valor: '' })}>
          <option value="desconto_pct">Desconto percentual sobre o preço de hoje</option>
          <option value="preco_fixo">Preço fixo, igual para todos</option>
          <option value="margem_alvo">Preço que deixa a margem que eu quero</option>
        </Select>
      </Field>

      {regra.tipo === 'desconto_pct' && (
        <Field label="Desconto (%)" hint="Aplicado sobre o preço lido da plataforma, variação por variação.">
          <NumInput
            value={regra.valorBruto ?? ''}
            onChange={(v) => onChange({ ...regra, valorBruto: v, valor: v === '' ? '' : Number(v) / 100 })}
            step="1"
            suffix="%"
          />
        </Field>
      )}
      {regra.tipo === 'preco_fixo' && (
        <Field label="Preço promocional" hint="O mesmo valor em todos os itens selecionados.">
          <NumInput
            value={regra.valorBruto ?? ''}
            onChange={(v) => onChange({ ...regra, valorBruto: v, valor: v === '' ? '' : Number(v) })}
            step="0.01"
            suffix="R$"
          />
        </Field>
      )}
      {regra.tipo === 'margem_alvo' && (
        <Field
          label="Margem desejada (%)"
          hint="O motor de precificação responde, produto a produto, qual preço deixa exatamente essa margem — considerando o custo, os impostos da empresa e as taxas."
        >
          <NumInput
            value={regra.valorBruto ?? ''}
            onChange={(v) => onChange({ ...regra, valorBruto: v, valor: v === '' ? '' : Number(v) / 100 })}
            step="1"
            suffix="%"
          />
        </Field>
      )}
    </div>
  );
}

// ===========================================================================
// Tabela da prévia — o que a dona vê ANTES de qualquer coisa sair daqui
// ===========================================================================
function TabelaPrevia({ previa, editaveis, onEditarPreco, onEditarEstoque, exigeEstoque }) {
  // Só as linhas cujo preço foi mexido à mão precisam de margem nova. As
  // outras continuam com a que o servidor já mandou junto da prévia.
  const { margens, recalculando } = useMargensAoVivo(
    (previa?.linhas || [])
      .filter((l) => l.preco_editado)
      .map((l) => ({ chave: chaveDaLinha(l), produto_id: l.produto_id, preco: l.preco_promocional }))
  );
  if (!previa) return null;
  const { linhas } = previa;

  // A margem que vale é sempre a do preço que está no campo AGORA. Enquanto a
  // resposta do servidor não chega, o selo diz que está recalculando — nunca
  // repete o número antigo como se fosse o do preço novo.
  function margemDaLinha(l) {
    if (!l.preco_editado) return { margem: l.margem, indisponivel: l.margem_indisponivel, recalculando: false };
    const viva = margens[chaveDaLinha(l)];
    if (viva) return { margem: viva.margem, indisponivel: viva.margem_indisponivel, recalculando: false };
    // Linha que o servidor nunca vai conseguir responder (sem produto
    // vinculado, ou com o preço apagado) NÃO fica em "…" pra sempre: volta a
    // dizer por que não dá. `recalculando` é o estado real da chamada.
    if (l.produto_id == null || !(Number(l.preco_promocional) > 0)) {
      return {
        margem: null,
        indisponivel: l.margem_indisponivel || (l.produto_id == null
          ? 'anúncio sem produto vinculado'
          : 'sem preço promocional definido'),
        recalculando: false,
      };
    }
    return { margem: null, indisponivel: null, recalculando };
  }

  // O resumo é recontado a partir da margem que vale AGORA, e não do que o
  // servidor mandou junto da prévia. Sem isto, a pessoa derrubava um preço
  // abaixo do custo, a linha ficava vermelha — e o cartão "Com prejuízo" logo
  // acima continuava marcando zero. A faixa de indicadores é o primeiro lugar
  // onde alguém olha.
  const efetivas = linhas.map((l) => ({ linha: l, m: margemDaLinha(l) }));
  const aplicaveis = efetivas.filter(({ linha }) => !linha.impedimento && Number(linha.preco_promocional) > 0);
  const resumo = {
    total: linhas.length,
    aplicaveis: aplicaveis.length,
    impedidos: linhas.length - aplicaveis.length,
    com_prejuizo: efetivas.filter(({ m }) => m.margem?.prejuizo).length,
    abaixo_do_minimo: efetivas.filter(({ m }) => m.margem?.abaixoDoMinimo && !m.margem?.prejuizo).length,
    sem_margem_calculavel: efetivas.filter(({ m }) => m.indisponivel).length,
    renuncia_por_peca: aplicaveis.reduce(
      (s, { linha }) => s + (linha.preco_atual != null ? (linha.preco_atual - linha.preco_promocional) : 0), 0
    ),
  };

  return (
    <div className="promocao-previa">
      <div className="promocao-previa-resumo">
        <IndicadorDestaque rotulo="Itens" valor={formatQtd(resumo.total)} />
        <IndicadorDestaque
          rotulo="Vão entrar"
          valor={formatQtd(resumo.aplicaveis)}
          explicacao={resumo.impedidos > 0 ? `${resumo.impedidos} sem preço calculável` : undefined}
        />
        <IndicadorDestaque
          rotulo="Com prejuízo"
          valor={formatQtd(resumo.com_prejuizo)}
          tom={resumo.com_prejuizo > 0 ? 'negativo' : undefined}
          explicacao="Neste preço a peça sai abaixo do custo total."
        />
        <IndicadorDestaque
          rotulo="Abaixo da margem mínima"
          valor={formatQtd(resumo.abaixo_do_minimo)}
          tom={resumo.abaixo_do_minimo > 0 ? 'atencao' : undefined}
        />
        <IndicadorDestaque
          rotulo="Desconto total por peça"
          valor={brl(resumo.renuncia_por_peca)}
          explicacao="Somando uma venda de cada item selecionado. É estimativa, não previsão de venda."
        />
        {resumo.sem_margem_calculavel > 0 && (
          <IndicadorDestaque
            rotulo="Sem margem calculável"
            valor={formatQtd(resumo.sem_margem_calculavel)}
            tom="atencao"
            explicacao="Anúncio sem produto vinculado ou produto sem custo cadastrado. O Hub prefere dizer que não sabe a mostrar zero."
          />
        )}
      </div>

      <div className="tabela-rolagem">
        <table className="tabela-promocao">
          <thead>
            <tr>
              <th>Anúncio</th>
              <th>Variação</th>
              <th className="num">Preço hoje</th>
              <th className="num">Preço promocional</th>
              <th className="num">Desconto</th>
              {exigeEstoque && <th className="num">Estoque reservado</th>}
              <th className="num">Margem</th>
              <th>Avisos</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={chaveDaLinha(l)} className={margemDaLinha(l).margem?.prejuizo ? 'linha-prejuizo' : (l.impedimento ? 'linha-impedida' : '')}>
                <td>
                  <div className="promocao-celula-anuncio">
                    {l.foto_url
                      ? <img src={l.foto_url} alt="" loading="lazy" />
                      : <span className="promocao-foto-vazia"><Package size={14} /></span>}
                    <span>
                      <strong>{l.referencia || l.titulo || l.anuncio_id_externo}</strong>
                      <small>
                        <SeloPlataforma chave={l.marketplace} size={12} /> {l.loja_nome}
                      </small>
                    </span>
                  </div>
                </td>
                <td>{[l.cor, l.tamanho].filter(Boolean).join(' · ') || <span className="ink-faint">única</span>}</td>
                <td className="num">{l.preco_atual != null ? brl(l.preco_atual) : '—'}</td>
                <td className="num">
                  {editaveis
                    ? (
                      <NumInput
                        value={l.preco_promocional ?? ''}
                        onChange={(v) => onEditarPreco(chaveDaLinha(l), v)}
                        step="0.01"
                      />
                    )
                    : (l.preco_promocional != null ? <strong>{brl(l.preco_promocional)}</strong> : '—')}
                </td>
                <td className="num">{rotuloDesconto(l.preco_atual, l.preco_promocional)}</td>
                {exigeEstoque && (
                  <td className="num">
                    <NumInput
                      value={l.estoque_promocional ?? ''}
                      onChange={(v) => onEditarEstoque(chaveDaLinha(l), v)}
                      step="1"
                      placeholder={l.estoque != null ? String(l.estoque) : ''}
                    />
                  </td>
                )}
                <td className="num">
                  {(() => {
                    const m = margemDaLinha(l);
                    return <SeloMargem margem={m.margem} indisponivel={m.indisponivel} recalculando={m.recalculando} compacto />;
                  })()}
                </td>
                <td>
                  {l.impedimento && <span className="selo tone-prejuizo">{l.impedimento}</span>}
                  {(l.avisos || []).map((a) => (
                    <span key={a} className="selo tone-atencao">{a}</span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===========================================================================
// Seletor de anúncios
// ===========================================================================
function SeletorAnuncios({ integracaoId, selecionados, onAlternar, onSelecionarTodos }) {
  const [candidatos, setCandidatos] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [semPromocao, setSemPromocao] = useState(true);

  useEffect(() => {
    if (!integracaoId) { setCandidatos([]); return; }
    let cancelado = false;
    setCarregando(true);
    const params = new URLSearchParams({ integracao_id: String(integracaoId) });
    if (buscaAplicada) params.set('busca', buscaAplicada);
    if (semPromocao) params.set('sem_promocao', 'true');
    api.get(`/promocoes/catalogo/candidatos?${params.toString()}`)
      .then((d) => { if (!cancelado) setCandidatos(d); })
      .catch(() => { if (!cancelado) setCandidatos([]); })
      .finally(() => { if (!cancelado) setCarregando(false); });
    return () => { cancelado = true; };
  }, [integracaoId, buscaAplicada, semPromocao]);

  return (
    <div className="promocao-seletor">
      <div className="promocao-seletor-barra">
        <CampoBusca
          valor={busca}
          onChange={setBusca}
          onSubmit={() => setBuscaAplicada(busca)}
          placeholder="Referência, título ou SKU"
        />
        <Checkbox
          checked={semPromocao}
          onChange={(e) => setSemPromocao(e.target.checked)}
        />
        <span className="promocao-seletor-rotulo">
          Só os que não estão em nenhuma promoção
          <small>Evita empilhar dois descontos no mesmo anúncio e derrubar o preço pela metade.</small>
        </span>
        <button type="button" className="btn-sec" onClick={() => onSelecionarTodos(candidatos.map((c) => c.id))}>
          Selecionar os {candidatos.length}
        </button>
      </div>

      {carregando && <Skeleton height={180} />}
      {!carregando && candidatos.length === 0 && (
        <EstadoVazio
          Icone={Search}
          titulo="Nenhum anúncio para escolher"
          descricao={integracaoId
            ? 'Ou a loja não tem anúncios ativos sincronizados, ou todos já estão em alguma promoção. Rode a sincronização na aba de Anúncios.'
            : 'Escolha a loja primeiro.'}
        />
      )}

      {!carregando && candidatos.length > 0 && (
        <div className="promocao-seletor-grade">
          {candidatos.map((c) => {
            const marcado = selecionados.includes(c.id);
            return (
              <button
                type="button"
                key={c.id}
                className={`promocao-candidato ${marcado ? 'marcado' : ''}`}
                onClick={() => onAlternar(c.id)}
              >
                <span className="promocao-candidato-marca">{marcado && <Check size={12} />}</span>
                {c.foto_url
                  ? <img src={c.foto_url} alt="" loading="lazy" />
                  : <span className="promocao-foto-vazia"><Package size={16} /></span>}
                <span className="promocao-candidato-texto">
                  <strong>{c.referencia || c.titulo}</strong>
                  <small>{c.titulo}</small>
                  <span className="promocao-candidato-numeros">
                    {c.preco != null ? brl(c.preco) : 'sem preço'}
                    {' · '}
                    {c.estoque != null ? `${formatQtd(c.estoque)} em estoque` : 'estoque desconhecido'}
                  </span>
                  <SeloMargem margem={c.margem} indisponivel={c.margem_indisponivel} compacto />
                </span>
                {Number(c.promocoes_ativas) > 0 && (
                  <span className="selo tone-atencao" title="Já está em outra promoção no ar ou agendada">
                    já em promoção
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Criar promoção
// ===========================================================================
function CriarPromocao({ lojas, onFechar, onCriada }) {
  const [integracaoId, setIntegracaoId] = useState('');
  // Destino do lote: promoção nova ou promoção que já existe (09/09/2026).
  //
  // POR QUE: POST /promocoes/:id/itens existia e nenhuma tela chamava. Quem
  // esquecia uma referência tinha que criar OUTRA promoção com o mesmo nome —
  // duas promoções concorrendo pela mesma peça na plataforma. Todo o resto do
  // fluxo (selecionar anúncios, regra de preço, prévia com margem, aviso de
  // prejuízo) é o mesmo; só muda para onde o lote vai no fim.
  const [destino, setDestino] = useState('nova');
  const [promocaoDestinoId, setPromocaoDestinoId] = useState('');
  const [promocoesDaLoja, setPromocoesDaLoja] = useState([]);
  const [tipo, setTipo] = useState('desconto');
  const [nome, setNome] = useState('');
  const [inicio, setInicio] = useState('');
  const [fim, setFim] = useState('');
  const [horarios, setHorarios] = useState(null);
  const [timeslotId, setTimeslotId] = useState('');
  const [selecionados, setSelecionados] = useState([]);
  const [regra, setRegra] = useState({ tipo: 'desconto_pct', valor: '', valorBruto: '' });
  const [previa, setPrevia] = useState(null);
  const [carregandoPrevia, setCarregandoPrevia] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);

  const loja = lojas.find((l) => String(l.id) === String(integracaoId));
  const horarioEscolhido = (horarios?.horarios || []).find((h) => String(h.timeslotId) === String(timeslotId));
  const criaveis = loja ? (CRIAVEL_POR_PLATAFORMA[loja.marketplace] || []) : [];
  const exigeEstoque = loja?.marketplace === 'shopee' && tipo === 'relampago';

  // Trocar de loja invalida a seleção: os ids de anúncio são de OUTRA loja.
  // Manter a seleção aqui mandaria anúncios da MELI Origem para a Shopee.
  useEffect(() => {
    setSelecionados([]);
    setPrevia(null);
    setTimeslotId('');
    setHorarios(null);
    setPromocaoDestinoId('');
  }, [integracaoId]);

  // Só promoções que ainda dá para alimentar: no ar ou agendadas. Oferecer uma
  // encerrada como destino seria oferecer um envio que a plataforma recusa.
  useEffect(() => {
    if (!integracaoId) { setPromocoesDaLoja([]); return; }
    api.get(`/promocoes?integracao_id=${integracaoId}`)
      .then((lista) => setPromocoesDaLoja(lista.filter((p) => p.status === 'ativa' || p.status === 'agendada')))
      .catch(() => setPromocoesDaLoja([]));
  }, [integracaoId]);

  const promocaoDestino = promocoesDaLoja.find((p) => String(p.id) === String(promocaoDestinoId));

  // A prévia julga cada item pelas regras do TIPO da promoção (a relâmpago da
  // Shopee, por exemplo, exige estoque reservado e faixa de desconto). Ao
  // acrescentar itens, o tipo que vale é o da promoção de destino — não o que
  // ficou no seletor. Sem isso, a prévia aprovaria um item que a plataforma
  // recusaria no envio.
  useEffect(() => {
    if (destino === 'existente' && promocaoDestino?.tipo) setTipo(promocaoDestino.tipo);
  }, [destino, promocaoDestino?.tipo]);

  // ⚠️ A dependência é o CONTEÚDO da seleção, não o tamanho dela. Com
  // `selecionados.length`, desmarcar um anúncio e marcar outro (tamanho
  // igual) mantinha a prévia antiga — e `aplicar()` envia as linhas dessa
  // prévia. A promoção era criada com o anúncio que a pessoa acabou de
  // TIRAR e sem o que ela acabou de PÔR, sem nada na tela indicando isso.
  const chaveSelecao = selecionados.join(',');
  useEffect(() => { setPrevia(null); }, [regra.tipo, regra.valor, chaveSelecao, tipo]);

  useEffect(() => {
    if (tipo !== 'relampago' || !integracaoId) return;
    api.get(`/promocoes/relampago/horarios?integracao_id=${integracaoId}`)
      .then(setHorarios)
      .catch((e) => setErro(e.message));
  }, [tipo, integracaoId]);

  const gerarPrevia = useCallback(async () => {
    setErro(null);
    setCarregandoPrevia(true);
    try {
      const d = await api.post('/promocoes/previa', {
        anuncio_ids: selecionados,
        regra: { tipo: regra.tipo, valor: regra.valor },
        tipo,
        integracao_id: integracaoId,
      });
      // Na relâmpago o estoque reservado é obrigatório: começa igual ao
      // estoque do anúncio e fica editável linha a linha. Sem esse padrão, o
      // pedido saía sem estoque e a Shopee recusava DEPOIS de a relâmpago já
      // ter sido criada, deixando uma promoção vazia na loja.
      setPrevia(exigeEstoque
        ? { ...d, linhas: d.linhas.map((l) => ({ ...l, estoque_promocional: l.estoque_promocional ?? l.estoque })) }
        : d);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoPrevia(false);
    }
  }, [selecionados, regra, tipo, integracaoId, exigeEstoque]);

  function editarLinha(chave, campo, valor) {
    setPrevia((p) => ({
      ...p,
      linhas: p.linhas.map((l) => (chaveDaLinha(l) === chave
        // `preco_editado` é o que diz à tabela que a margem que veio do
        // servidor não vale mais para esta linha.
        ? { ...l, [campo]: valor === '' ? null : Number(valor), ...(campo === 'preco_promocional' ? { preco_editado: true } : {}) }
        : l)),
    }));
  }

  async function aplicar() {
    if (!previa) return;
    const aplicaveis = previa.linhas.filter((l) => !l.impedimento && Number(l.preco_promocional) > 0);
    if (aplicaveis.length === 0) { setErro('Nenhum item aplicável na prévia.'); return; }

    // Pergunta a margem DE NOVO, com os preços que estão nos campos agora.
    // Sem isso, um preço editado à mão depois da prévia entraria com a
    // margem do preço antigo escrita na confirmação — e a confirmação é o
    // último lugar onde alguém ainda pode voltar atrás.
    let comPrejuizo = 0;
    try {
      const r = await api.post('/promocoes/margem', {
        itens: aplicaveis.map((l) => ({ chave: chaveDaLinha(l), produto_id: l.produto_id, preco: l.preco_promocional })),
      });
      comPrejuizo = r.itens.filter((x) => x.margem?.prejuizo).length;
    } catch (e) {
      setErro(`Não deu para conferir a margem antes de enviar: ${e.message}`);
      return;
    }

    const quantos = `${aplicaveis.length} ${aplicaveis.length === 1 ? 'item' : 'itens'}`;
    const ressalvaPrejuizo = comPrejuizo > 0
      ? ` — e ${comPrejuizo} ${comPrejuizo === 1 ? 'entra' : 'entram'} COM PREJUÍZO`
      : '';
    const acrescentando = destino === 'existente';
    const texto = acrescentando
      ? `Vai acrescentar ${quantos} à promoção "${promocaoDestino?.nome || promocaoDestino?.tipo}"${ressalvaPrejuizo}. Isso altera a loja de verdade.`
      : `Vai criar a promoção com ${quantos} na ${nomeDaLoja(loja)}${ressalvaPrejuizo}. Isso altera a loja de verdade.`;
    if (!await confirmar(texto, {
      titulo: acrescentando ? 'Acrescentar itens à promoção' : 'Criar promoção na plataforma',
      confirmarTexto: acrescentando ? 'Acrescentar' : 'Criar',
      perigo: comPrejuizo > 0,
    })) return;

    setEnviando(true);
    setErro(null);
    try {
      if (acrescentando) {
        const r = await api.post(`/promocoes/${promocaoDestinoId}/itens`, {
          confirmar: true,
          itens: aplicaveis.map((l) => ({
            anuncio_id: l.anuncio_id,
            produto_id: l.produto_id,
            anuncio_id_externo: l.anuncio_id_externo,
            variacao_id_externa: l.variacao_id_externa,
            preco_atual: l.preco_atual,
            preco_promocional: l.preco_promocional,
            estoque_promocional: l.estoque_promocional,
            limite_por_compra: l.limite_por_compra,
          })),
        });
        // A rota devolve total/aplicados/falhas. Item recusado pela plataforma
        // não pode virar silêncio: quem mandou 30 e teve 4 recusados precisa
        // saber disso agora, não na próxima sincronização.
        if (r.falhas && r.falhas.length > 0) {
          setErro(`${r.aplicados} de ${r.total} entraram. Recusados: ${r.falhas
            .map((f) => `${f.anuncioIdExterno || f.anuncio_id_externo || 'item'} (${f.motivo || f.erro || 'sem motivo informado'})`)
            .join('; ')}`);
        } else {
          onCriada({ id: Number(promocaoDestinoId) });
        }
        return;
      }
      const r = await api.post('/promocoes', {
        confirmar: true,
        aceitar_prejuizo: comPrejuizo > 0,
        integracao_id: Number(integracaoId),
        tipo,
        nome: nome || null,
        inicio: horaLocalParaIso(inicio),
        fim: horaLocalParaIso(fim),
        timeslot_id: timeslotId || null,
        // A relâmpago não tem início digitado: a janela é a do horário
        // escolhido. Sem mandar isso, a promoção nascia como "No ar" e "sem
        // início" até a próxima sincronização corrigir.
        timeslot_inicio: horarioEscolhido?.inicioEm || null,
        timeslot_fim: horarioEscolhido?.fimEm || null,
        itens: aplicaveis.map((l) => ({
          anuncio_id: l.anuncio_id,
          produto_id: l.produto_id,
          anuncio_id_externo: l.anuncio_id_externo,
          variacao_id_externa: l.variacao_id_externa,
          preco_atual: l.preco_atual,
          preco_promocional: l.preco_promocional,
          estoque_promocional: l.estoque_promocional,
          limite_por_compra: l.limite_por_compra,
        })),
      });
      onCriada(r);
    } catch (e) {
      setErro(e.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="promocao-fluxo">
      <div className="promocao-fluxo-topo">
        <button type="button" className="btn-icone" onClick={onFechar} aria-label="Voltar"><ArrowLeft size={16} /></button>
        <h2>{destino === 'existente' ? 'Acrescentar itens a uma promoção' : 'Nova promoção'}</h2>
      </div>

      <section className="card">
        <h3 className="card-titulo">1 · Onde e o quê</h3>
        <div className="grid-campos">
          <Field label="Loja">
            <Select value={integracaoId} onChange={(e) => setIntegracaoId(e.target.value)} placeholder="Escolha a loja">
              {lojas.filter((l) => l.conectada && l.ativo).map((l) => (
                <option key={l.id} value={l.id}>{nomeDaLoja(l)}</option>
              ))}
            </Select>
          </Field>

          <Field
            label="Destino"
            hint={destino === 'existente'
              ? 'O preço e a prévia funcionam igual; no fim os itens entram na promoção escolhida em vez de numa nova.'
              : undefined}
          >
            <Select value={destino} onChange={(e) => setDestino(e.target.value)} disabled={!integracaoId}>
              <option value="nova">Criar uma promoção nova</option>
              <option value="existente" disabled={promocoesDaLoja.length === 0}>
                {promocoesDaLoja.length === 0
                  ? 'Acrescentar a uma existente (nenhuma no ar ou agendada)'
                  : `Acrescentar a uma existente (${promocoesDaLoja.length})`}
              </option>
            </Select>
          </Field>

          {destino === 'existente' && (
            <Field label="Promoção" hint="Só aparecem as que estão no ar ou agendadas.">
              <Select
                value={promocaoDestinoId}
                onChange={(e) => setPromocaoDestinoId(e.target.value)}
                placeholder="Escolha a promoção"
              >
                {promocoesDaLoja.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {(pr.nome || `Promoção ${pr.promocao_id_externo}`)} · {TIPO_ROTULO[pr.tipo] || pr.tipo} · {STATUS_ROTULO[pr.status] || pr.status}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {destino === 'nova' && <Field
            label="Tipo"
            hint={loja && criaveis.length === 0
              ? 'Essa plataforma ainda não deixa criar promoção pela API — só ler o que existe.'
              : undefined}
          >
            <Select value={tipo} onChange={(e) => setTipo(e.target.value)} disabled={!loja}>
              {criaveis.map((t) => <option key={t} value={t}>{TIPO_ROTULO[t]}</option>)}
            </Select>
          </Field>}

          {destino === 'nova' && tipo !== 'relampago' && (
            <>
              <Field label="Nome da promoção">
                <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Setembro Dry Fit" />
              </Field>
              <Field label="Início" hint="A Shopee exige pelo menos 1 hora à frente de agora.">
                <input type="datetime-local" value={inicio} onChange={(e) => setInicio(e.target.value)} />
              </Field>
              <Field label="Fim" hint="No máximo 180 dias depois do início, na Shopee.">
                <input type="datetime-local" value={fim} onChange={(e) => setFim(e.target.value)} />
              </Field>
            </>
          )}

          {destino === 'nova' && tipo === 'relampago' && (
            <Field
              label="Horário"
              hint="A relâmpago só existe em faixas fixas de horário definidas pela plataforma — não dá pra escolher um horário qualquer."
            >
              {horarios?.aplicavel === false
                ? <p className="ink-soft">{horarios.motivo}</p>
                : (
                  <Select value={timeslotId} onChange={(e) => setTimeslotId(e.target.value)} placeholder="Escolha o horário">
                    {(horarios?.horarios || []).map((h) => (
                      <option key={h.timeslotId} value={h.timeslotId}>
                        {new Date(h.inicioEm).toLocaleString('pt-BR')} → {new Date(h.fimEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </option>
                    ))}
                  </Select>
                )}
            </Field>
          )}
        </div>

        {destino === 'nova' && horarios?.criterios && tipo === 'relampago' && (
          <p className="promocao-criterios">
            <AlertTriangle size={13} />
            A Shopee exige, para a relâmpago: desconto entre {horarios.criterios.min_discount ?? '—'}% e {horarios.criterios.max_discount ?? '—'}%
            {horarios.criterios.min_promo_stock != null && `, estoque reservado a partir de ${horarios.criterios.min_promo_stock}`}
            {horarios.criterios.min_product_rating != null && `, nota mínima ${horarios.criterios.min_product_rating}`}.
            A prévia avisa item a item quem não passa.
          </p>
        )}
      </section>

      <section className="card">
        <h3 className="card-titulo">2 · Quais anúncios</h3>
        <SeletorAnuncios
          integracaoId={integracaoId}
          selecionados={selecionados}
          onAlternar={(id) => setSelecionados((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
          onSelecionarTodos={(ids) => setSelecionados(ids)}
        />
        {selecionados.length > 0 && (
          <p className="promocao-contagem">{selecionados.length} {selecionados.length === 1 ? 'anúncio selecionado' : 'anúncios selecionados'}</p>
        )}
      </section>

      <section className="card">
        <h3 className="card-titulo">3 · Por qual preço</h3>
        <RegraDePreco regra={regra} onChange={setRegra} />
        <button
          type="button"
          className="btn"
          onClick={gerarPrevia}
          disabled={selecionados.length === 0 || regra.valor === '' || carregandoPrevia}
        >
          {carregandoPrevia ? 'Calculando…' : 'Ver a prévia'}
        </button>
        <p className="ink-soft promocao-nota">
          Nada é enviado para a loja antes da prévia. Ela mostra, item por item, o preço que vai valer e quanto sobra de margem.
        </p>
      </section>

      {previa && (
        <section className="card">
          <h3 className="card-titulo">4 · Confira antes de mandar</h3>
          <TabelaPrevia
            previa={previa}
            editaveis
            exigeEstoque={exigeEstoque}
            onEditarPreco={(chave, v) => editarLinha(chave, 'preco_promocional', v)}
            onEditarEstoque={(chave, v) => editarLinha(chave, 'estoque_promocional', v)}
          />
          {erro && <p className="erro-inline">{erro}</p>}
          <div className="promocao-acoes">
            <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
            <button
              type="button"
              className="btn"
              onClick={aplicar}
              disabled={enviando || (destino === 'existente' && !promocaoDestinoId)}
            >
              {enviando
                ? 'Enviando para a plataforma…'
                : (destino === 'existente' ? 'Acrescentar à promoção' : 'Criar promoção')}
            </button>
          </div>
        </section>
      )}

      {erro && !previa && <p className="erro-inline">{erro}</p>}
    </div>
  );
}

// ===========================================================================
// Relâmpago em massa
// ===========================================================================
// O pedido literal: "criar promoções relâmpago em massa". Na Shopee cada
// relâmpago é UM horário — então "em massa" quer dizer o mesmo conjunto de
// anúncios entrando em vários horários de uma vez.
function RelampagoEmMassa({ lojas, onFechar, onCriadas }) {
  const [integracaoId, setIntegracaoId] = useState('');
  const [dados, setDados] = useState(null);
  const [escolhidos, setEscolhidos] = useState([]);
  const [selecionados, setSelecionados] = useState([]);
  const [regra, setRegra] = useState({ tipo: 'desconto_pct', valor: '', valorBruto: '' });
  const [previa, setPrevia] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);
  const [resultado, setResultado] = useState(null);

  useEffect(() => {
    setEscolhidos([]); setSelecionados([]); setPrevia(null); setResultado(null);
    if (!integracaoId) { setDados(null); return; }
    api.get(`/promocoes/relampago/horarios?integracao_id=${integracaoId}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [integracaoId]);

  async function gerarPrevia() {
    setErro(null);
    try {
      const d = await api.post('/promocoes/previa', {
        anuncio_ids: selecionados,
        regra: { tipo: regra.tipo, valor: regra.valor },
        tipo: 'relampago',
        integracao_id: integracaoId,
      });
      // Estoque reservado começa igual ao estoque do anúncio — é o padrão que
      // a equipe usa hoje, e fica editável linha a linha na tabela.
      setPrevia({
        ...d,
        linhas: d.linhas.map((l) => ({ ...l, estoque_promocional: l.estoque_promocional ?? l.estoque })),
      });
    } catch (e) {
      setErro(e.message);
    }
  }

  async function criar() {
    const aplicaveis = (previa?.linhas || []).filter((l) => !l.impedimento && Number(l.preco_promocional) > 0);
    if (aplicaveis.length === 0 || escolhidos.length === 0) return;

    // Margem conferida de novo com os preços que estão nos campos agora —
    // mesmo motivo da criação avulsa, e aqui pesa mais: são até 20 relâmpagos
    // de uma vez.
    let comPrejuizo = 0;
    try {
      const r = await api.post('/promocoes/margem', {
        itens: aplicaveis.map((l) => ({ chave: chaveDaLinha(l), produto_id: l.produto_id, preco: l.preco_promocional })),
      });
      comPrejuizo = r.itens.filter((x) => x.margem?.prejuizo).length;
    } catch (e) {
      setErro(`Não deu para conferir a margem antes de enviar: ${e.message}`);
      return;
    }

    const texto = `Vai criar ${escolhidos.length} ${escolhidos.length === 1 ? 'relâmpago' : 'relâmpagos'}, cada uma com os mesmos ${aplicaveis.length} itens`
      + (comPrejuizo > 0 ? `, sendo ${comPrejuizo} COM PREJUÍZO` : '')
      + '. Isso altera a loja de verdade.';
    if (!await confirmar(texto, { titulo: 'Criar relâmpagos', confirmarTexto: 'Criar todas', perigo: comPrejuizo > 0 })) return;

    setEnviando(true);
    setErro(null);
    try {
      const r = await api.post('/promocoes/relampago-em-massa', {
        confirmar: true,
        aceitar_prejuizo: comPrejuizo > 0,
        integracao_id: Number(integracaoId),
        timeslots: escolhidos.map((id) => {
          const h = dados.horarios.find((x) => String(x.timeslotId) === String(id));
          return { timeslot_id: id, inicio_em: h?.inicioEm || null, fim_em: h?.fimEm || null };
        }),
        itens: aplicaveis.map((l) => ({
          anuncio_id: l.anuncio_id,
          produto_id: l.produto_id,
          anuncio_id_externo: l.anuncio_id_externo,
          variacao_id_externa: l.variacao_id_externa,
          preco_atual: l.preco_atual,
          preco_promocional: l.preco_promocional,
          estoque_promocional: l.estoque_promocional,
          limite_por_compra: l.limite_por_compra,
        })),
      });
      setResultado(r);
      onCriadas();
    } catch (e) {
      setErro(e.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="promocao-fluxo">
      <div className="promocao-fluxo-topo">
        <button type="button" className="btn-icone" onClick={onFechar} aria-label="Voltar"><ArrowLeft size={16} /></button>
        <h2><Zap size={18} /> Relâmpagos em massa</h2>
      </div>

      <section className="card">
        <h3 className="card-titulo">1 · Loja e horários</h3>
        <Field label="Loja">
          <Select value={integracaoId} onChange={(e) => setIntegracaoId(e.target.value)} placeholder="Escolha a loja">
            {lojas.filter((l) => l.conectada && l.ativo && l.marketplace === 'shopee').map((l) => (
              <option key={l.id} value={l.id}>{nomeDaLoja(l)}</option>
            ))}
          </Select>
        </Field>
        <p className="ink-soft promocao-nota">
          Hoje só a Shopee tem criação de relâmpago pela API. Nas outras, a aba lê o que existe mas não cria.
        </p>

        {dados?.horarios?.length > 0 && (
          <div className="promocao-horarios">
            {dados.horarios.map((h) => {
              const marcado = escolhidos.includes(String(h.timeslotId));
              return (
                <button
                  type="button"
                  key={h.timeslotId}
                  className={`promocao-horario ${marcado ? 'marcado' : ''}`}
                  onClick={() => setEscolhidos((s) => (marcado
                    ? s.filter((x) => x !== String(h.timeslotId))
                    : [...s, String(h.timeslotId)]))}
                >
                  <Zap size={13} />
                  <span>
                    <strong>{new Date(h.inicioEm).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</strong>
                    <small>
                      {new Date(h.inicioEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      {' – '}
                      {new Date(h.fimEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </small>
                  </span>
                  {marcado && <Check size={14} />}
                </button>
              );
            })}
          </div>
        )}
        {dados && dados.horarios?.length === 0 && (
          <p className="ink-soft">A Shopee não devolveu nenhum horário disponível nos próximos 14 dias.</p>
        )}
      </section>

      <section className="card">
        <h3 className="card-titulo">2 · Quais anúncios</h3>
        <SeletorAnuncios
          integracaoId={integracaoId}
          selecionados={selecionados}
          onAlternar={(id) => setSelecionados((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
          onSelecionarTodos={(ids) => setSelecionados(ids)}
        />
      </section>

      <section className="card">
        <h3 className="card-titulo">3 · Preço e prévia</h3>
        <RegraDePreco regra={regra} onChange={setRegra} />
        <button
          type="button"
          className="btn"
          onClick={gerarPrevia}
          disabled={selecionados.length === 0 || regra.valor === ''}
        >
          Ver a prévia
        </button>
      </section>

      {previa && (
        <section className="card">
          <h3 className="card-titulo">4 · Confira antes de mandar</h3>
          <p className="ink-soft promocao-nota">
            A relâmpago da Shopee exige estoque reservado em cada variação. O padrão veio do estoque do anúncio — ajuste onde precisar.
          </p>
          <TabelaPrevia
            previa={previa}
            editaveis
            exigeEstoque
            onEditarPreco={(chave, v) => setPrevia((p) => ({
              ...p,
              linhas: p.linhas.map((l) => (chaveDaLinha(l) === chave
                ? { ...l, preco_promocional: v === '' ? null : Number(v), preco_editado: true }
                : l)),
            }))}
            onEditarEstoque={(chave, v) => setPrevia((p) => ({
              ...p,
              linhas: p.linhas.map((l) => (chaveDaLinha(l) === chave ? { ...l, estoque_promocional: v === '' ? null : Number(v) } : l)),
            }))}
          />
          <div className="promocao-acoes">
            <span className="ink-soft">
              {/* Conta as linhas que estão aplicáveis AGORA, e não o número que
                  veio com a prévia — um preço apagado à mão muda essa conta. */}
              {escolhidos.length} {escolhidos.length === 1 ? 'horário' : 'horários'}
              {' × '}
              {previa.linhas.filter((l) => !l.impedimento && Number(l.preco_promocional) > 0).length} itens
            </span>
            <button type="button" className="btn" onClick={criar} disabled={enviando || escolhidos.length === 0}>
              {enviando ? 'Criando…' : `Criar ${escolhidos.length} relâmpago${escolhidos.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </section>
      )}

      {resultado && (
        <section className="card">
          <h3 className="card-titulo">Resultado</h3>
          <p><strong>{resultado.criadas}</strong> de {resultado.total} criadas.</p>
          <ul className="promocao-resultado">
            {resultado.resultado.map((r) => (
              <li key={r.timeslotId} className={r.ok ? 'ok' : 'falha'}>
                {r.ok
                  ? <>Horário {r.timeslotId}: criada com {r.itens} itens{r.falhas?.length > 0 && ` (${r.falhas.length} recusados pela Shopee)`}</>
                  : <>Horário {r.timeslotId}: {r.erro}</>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {erro && <p className="erro-inline">{erro}</p>}
    </div>
  );
}

// ===========================================================================
// Painel de uma promoção — o editor no formato do painel da Shopee
// ===========================================================================
function PainelPromocao({ promocaoId, onFechar, onMudou }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [aba, setAba] = useState('itens');
  const [historico, setHistorico] = useState(null);
  const [edicoes, setEdicoes] = useState({});
  const [marcados, setMarcados] = useState([]);
  const [regra, setRegra] = useState({ tipo: 'desconto_pct', valor: '', valorBruto: '' });
  const [erro, setErro] = useState(null);
  const [salvando, setSalvando] = useState(false);
  // Editar nome/janela e excluir uma promoção que ainda não começou: as duas
  // rotas (PUT /promocoes/:id e POST /promocoes/:id/excluir) existiam e
  // nenhuma tela chamava. Sem elas, corrigir o nome de uma promoção ou
  // desfazer uma agendada por engano só dava para fazer no painel da
  // plataforma — fora do Hub, sem histórico aqui.
  const [editando, setEditando] = useState(false);
  const [formPromo, setFormPromo] = useState({ nome: '', inicio: '', fim: '' });

  const recarregar = useCallback(() => {
    setCarregando(true);
    api.get(`/promocoes/${promocaoId}`)
      .then((d) => { setDados(d); setEdicoes({}); setMarcados([]); })
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [promocaoId]);

  useEffect(() => { recarregar(); }, [recarregar]);

  useEffect(() => {
    if (aba !== 'historico' || historico) return;
    api.get(`/promocoes/${promocaoId}/historico`).then(setHistorico).catch(() => setHistorico({ historico: [] }));
  }, [aba, historico, promocaoId]);

  const itens = dados?.itens || [];
  const promocao = dados?.promocao;

  // Aplica a regra de preço só nos itens MARCADOS. Se nada estiver marcado,
  // aplica em todos — é o comportamento que a equipe espera de uma barra de
  // ação em massa, e a confirmação depois diz quantos são.
  async function aplicarRegraNaSelecao() {
    const alvo = marcados.length > 0 ? itens.filter((i) => marcados.includes(i.id)) : itens;
    const novas = { ...edicoes };
    const semBase = [];

    if (regra.tipo === 'margem_alvo') {
      // O preço que dá a margem pedida é resposta do MOTOR, produto a produto
      // (o custo de cada peça é diferente) — não dá pra aproximar aqui.
      setErro(null);
      try {
        const r = await api.post('/promocoes/margem', {
          margem_alvo: Number(regra.valor),
          itens: alvo.map((i) => ({ chave: String(i.id), produto_id: i.produto_id, preco: i.preco_promocional })),
        });
        for (const linha of r.itens) {
          if (linha.preco_sugerido != null) novas[Number(linha.chave)] = linha.preco_sugerido;
          else semBase.push(linha.chave);
        }
      } catch (e) {
        setErro(e.message);
        return;
      }
    } else {
      for (const i of alvo) {
        // ATENÇÃO ao null: `Number(null)` é 0, e um 0 passa em Number.isFinite.
        // Sem a checagem explícita, um item cujo anúncio ainda não foi
        // sincronizado (preco_anuncio nulo) recebia 0 × (1 − desconto) = 0 e
        // o preço promocional ia para a plataforma como R$ 0,00.
        const bruto = i.preco_original ?? i.preco_anuncio;
        const base = bruto == null ? null : Number(bruto);
        let novo = null;
        if (regra.tipo === 'preco_fixo') novo = Number(regra.valor);
        else if (regra.tipo === 'desconto_pct') {
          if (base != null && Number.isFinite(base) && base > 0) novo = base * (1 - Number(regra.valor));
          else semBase.push(i.id);
        }
        // Arredondar só no valor final, e pra baixo (REGRA 2).
        if (novo != null && Number.isFinite(novo) && novo > 0) novas[i.id] = Math.floor(novo * 100) / 100;
      }
    }

    setEdicoes(novas);
    // Dizer quantos ficaram de fora, em vez de deixar a pessoa achar que a
    // regra pegou em todos.
    setErro(semBase.length > 0
      ? `${semBase.length} ${semBase.length === 1 ? 'item ficou' : 'itens ficaram'} sem preço novo: sem preço de partida lido da plataforma, ou sem custo cadastrado.`
      : null);
  }

  // Uma lista só, usada pelo botão (para acender ou não) e pela função (para
  // saber o que enviar). Antes eram dois critérios diferentes.
  const itensAlterados = itens.filter(
    (i) => edicoes[i.id] != null && Number(edicoes[i.id]) !== Number(i.preco_promocional)
  );

  async function salvarPrecos() {
    const alterados = itensAlterados;
    if (alterados.length === 0) return;
    // Pergunta a margem DE NOVO com os preços que estão nos campos agora. Sem
    // isto, clicar dentro dos 400ms do recálculo mostrava a confirmação sem a
    // frase "COM PREJUÍZO" — e prejuízo pode acontecer, mas nunca calado.
    let comPrejuizo = 0;
    try {
      const conferencia = await api.post('/promocoes/margem', {
        itens: alterados.map((i) => ({ chave: String(i.id), produto_id: i.produto_id, preco: edicoes[i.id] })),
      });
      comPrejuizo = conferencia.itens.filter((x) => x.margem?.prejuizo).length;
    } catch (e) {
      setErro(`Não deu para conferir a margem antes de enviar: ${e.message}`);
      return;
    }

    if (!await confirmar(
      `Vai alterar o preço promocional de ${alterados.length} ${alterados.length === 1 ? 'item' : 'itens'} direto na plataforma.`
      + (comPrejuizo > 0 ? ` ${comPrejuizo} ${comPrejuizo === 1 ? 'fica' : 'ficam'} COM PREJUÍZO neste preço.` : ''),
      { titulo: 'Alterar preços na plataforma', confirmarTexto: 'Alterar', perigo: comPrejuizo > 0 }
    )) return;

    setSalvando(true);
    setErro(null);
    try {
      const r = await api.put(`/promocoes/${promocaoId}/itens`, {
        confirmar: true,
        aceitar_prejuizo: comPrejuizo > 0,
        itens: alterados.map((i) => ({
          anuncio_id: i.anuncio_id,
          produto_id: i.produto_id,
          anuncio_id_externo: i.anuncio_id_externo,
          variacao_id_externa: i.variacao_id_externa,
          preco_atual: i.preco_original,
          preco_promocional: edicoes[i.id],
        })),
      });
      if (r.falhas?.length > 0) {
        setErro(`${r.alterados} alterados. ${r.falhas.length} recusados: ${r.falhas.map((f) => f.erro).join(' · ')}`);
      }
      recarregar();
      onMudou();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  async function removerMarcados() {
    if (marcados.length === 0) return;
    if (!await confirmar(
      `Vai tirar ${marcados.length} ${marcados.length === 1 ? 'item' : 'itens'} desta promoção na plataforma.`,
      { titulo: 'Tirar da promoção', confirmarTexto: 'Tirar' }
    )) return;
    setSalvando(true);
    try {
      await api.post(`/promocoes/${promocaoId}/itens/remover`, {
        confirmar: true,
        itens: itens.filter((i) => marcados.includes(i.id)).map((i) => ({
          anuncio_id_externo: i.anuncio_id_externo,
          variacao_id_externa: i.variacao_id_externa,
          preco_promocional: i.preco_promocional,
        })),
      });
      recarregar();
      onMudou();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  async function encerrar() {
    if (!await confirmar(
      `Vai encerrar "${promocao.nome || promocao.tipo}" na ${promocao.loja_nome}. Os itens saem da promoção na plataforma.`,
      { titulo: 'Encerrar promoção', confirmarTexto: 'Encerrar' }
    )) return;
    setSalvando(true);
    try {
      await api.post(`/promocoes/${promocaoId}/encerrar`, { confirmar: true });
      recarregar();
      onMudou();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  function abrirEdicao() {
    setErro(null);
    setFormPromo({
      nome: promocao.nome || '',
      inicio: isoParaHoraLocal(promocao.inicio_em),
      fim: isoParaHoraLocal(promocao.fim_em),
    });
    setEditando(true);
  }

  async function salvarPromocao(e) {
    e.preventDefault();
    if (!await confirmar(
      `Vai alterar "${promocao.nome || promocao.tipo}" na ${promocao.loja_nome}. A mudança vai para a plataforma.`,
      { titulo: 'Salvar alterações da promoção', confirmarTexto: 'Salvar' }
    )) return;
    setSalvando(true);
    setErro(null);
    try {
      await api.put(`/promocoes/${promocaoId}`, {
        confirmar: true,
        nome: formPromo.nome.trim() || null,
        inicio: horaLocalParaIso(formPromo.inicio),
        fim: horaLocalParaIso(formPromo.fim),
      });
      setEditando(false);
      recarregar();
      onMudou();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function excluir() {
    if (!await confirmar(
      `Vai excluir "${promocao.nome || promocao.tipo}" na ${promocao.loja_nome}. Só funciona em promoção que ainda não começou.`,
      { titulo: 'Excluir promoção', confirmarTexto: 'Excluir', perigo: true }
    )) return;
    setSalvando(true);
    setErro(null);
    try {
      const r = await api.post(`/promocoes/${promocaoId}/excluir`, { confirmar: true });
      onMudou();
      if (r?.observacao) setErro(r.observacao);
      else onFechar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  // Margem recalculada para as linhas cujo preço foi mexido — mesma razão da
  // prévia: a margem que veio do servidor é a do preço anterior.
  const { margens: margensVivas, recalculando: recalculandoMargem } = useMargensAoVivo(
    itens
      .filter((i) => edicoes[i.id] != null && Number(edicoes[i.id]) !== Number(i.preco_promocional))
      .map((i) => ({ chave: String(i.id), produto_id: i.produto_id, preco: edicoes[i.id] }))
  );

  function margemDoItem(i) {
    const foiEditado = edicoes[i.id] != null && Number(edicoes[i.id]) !== Number(i.preco_promocional);
    if (!foiEditado) return { margem: i.margem, indisponivel: i.margem_indisponivel, recalculando: false };
    const viva = margensVivas[String(i.id)];
    if (viva) return { margem: viva.margem, indisponivel: viva.margem_indisponivel, recalculando: false };
    return { margem: null, indisponivel: null, recalculando: recalculandoMargem };
  }

  // O que cada plataforma deixa mexer, dito uma vez só:
  //  · Mercado Livre — a janela vive em cada item, não na promoção.
  //  · Shopee relâmpago — o horário é fixo, escolhido na criação.
  //  · Excluir — só antes de começar; depois de no ar, o caminho é encerrar.
  const podeEditarJanela = Boolean(promocao)
    && promocao.loja_marketplace !== 'mercado_livre'
    && !(promocao.loja_marketplace === 'shopee' && promocao.tipo === 'relampago');
  const podeExcluir = Boolean(promocao)
    && promocao.status !== 'ativa'
    && promocao.loja_marketplace !== 'mercado_livre';

  // Mesma razão do resumo da prévia: os totais têm que refletir os preços que
  // estão nos campos agora, não os que vieram do servidor.
  const totais = useMemo(() => {
    const efetivas = itens.map((i) => margemDoItem(i));
    return {
      itens: itens.length,
      prejuizo: efetivas.filter((m) => m.margem?.prejuizo).length,
      abaixo: efetivas.filter((m) => m.margem?.abaixoDoMinimo && !m.margem?.prejuizo).length,
      semMargem: efetivas.filter((m) => m.indisponivel).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itens, edicoes, margensVivas, recalculandoMargem]);

  return (
    <>
      <div className="anuncio-painel-fundo" onClick={onFechar} aria-hidden="true" />
      <aside className="anuncio-painel" role="dialog" aria-label="Promoção">
        <div className="anuncio-painel-topo">
          {carregando || !promocao
            ? <Skeleton width={220} height={20} />
            : (
              <div className="promocao-painel-cabecalho">
                <span className="promocao-card-loja">
                  <SeloPlataforma chave={promocao.loja_marketplace} size={16} />
                  <span>{nomeDaLoja({ marketplace: promocao.loja_marketplace, nome: promocao.loja_nome })}</span>
                </span>
                <h2>{promocao.nome || `Promoção ${promocao.promocao_id_externo}`}</h2>
                <div className="promocao-painel-selos">
                  <span className={`selo ${STATUS_TOM[promocao.status] || 'tone-neutro'}`}>
                    {STATUS_ROTULO[promocao.status] || promocao.status}
                  </span>
                  <span className="selo tone-neutro">{TIPO_ROTULO[promocao.tipo] || promocao.tipo}</span>
                  {promocao.criada_no_hub && <span className="selo tone-elevada">Criada no Hub</span>}
                </div>
              </div>
            )}
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </div>

        <div className="anuncio-painel-corpo">
          <div className="subtab-row">
            <button type="button" className={`subtab-btn ${aba === 'itens' ? 'active' : ''}`} onClick={() => setAba('itens')}>
              Itens ({totais.itens})
            </button>
            <button type="button" className={`subtab-btn ${aba === 'historico' ? 'active' : ''}`} onClick={() => setAba('historico')}>
              Histórico
            </button>
          </div>

          {aba === 'itens' && (
            <>
              {editando && promocao && (
                <form className="promocao-form-edicao" onSubmit={salvarPromocao}>
                  <div className="field">
                    <span className="field-label">Nome da promoção</span>
                    <input value={formPromo.nome} onChange={(e) => setFormPromo((f) => ({ ...f, nome: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span className="field-label">Início</span>
                    <input type="datetime-local" value={formPromo.inicio} onChange={(e) => setFormPromo((f) => ({ ...f, inicio: e.target.value }))} />
                  </div>
                  <div className="field">
                    <span className="field-label">Fim</span>
                    <input type="datetime-local" value={formPromo.fim} onChange={(e) => setFormPromo((f) => ({ ...f, fim: e.target.value }))} />
                  </div>
                  <div className="promocao-form-edicao-acoes">
                    <button type="submit" className="btn" disabled={salvando}>
                      {salvando ? 'Enviando…' : 'Salvar na plataforma'}
                    </button>
                    <button type="button" className="btn-sec" onClick={() => setEditando(false)} disabled={salvando}>
                      Cancelar
                    </button>
                  </div>
                </form>
              )}

              <div className="promocao-painel-indicadores">
                <IndicadorDestaque rotulo="Itens" valor={formatQtd(totais.itens)} />
                <IndicadorDestaque
                  rotulo="Com prejuízo"
                  valor={formatQtd(totais.prejuizo)}
                  tom={totais.prejuizo > 0 ? 'negativo' : undefined}
                />
                <IndicadorDestaque
                  rotulo="Abaixo do mínimo"
                  valor={formatQtd(totais.abaixo)}
                  tom={totais.abaixo > 0 ? 'atencao' : undefined}
                />
                {totais.semMargem > 0 && (
                  <IndicadorDestaque
                    rotulo="Sem margem calculável"
                    valor={formatQtd(totais.semMargem)}
                    explicacao="Anúncio sem produto vinculado ou produto sem custo cadastrado."
                  />
                )}
              </div>

              <div className="promocao-barra-massa">
                <RegraDePreco regra={regra} onChange={setRegra} />
                <button type="button" className="btn-sec" onClick={aplicarRegraNaSelecao} disabled={regra.valor === ''}>
                  Aplicar {marcados.length > 0 ? `nos ${marcados.length} marcados` : 'em todos'}
                </button>
                <button type="button" className="btn-sec perigo" onClick={removerMarcados} disabled={marcados.length === 0}>
                  <Trash2 size={14} /> Tirar {marcados.length > 0 ? marcados.length : ''} da promoção
                </button>
              </div>

              {carregando && <Skeleton height={240} />}
              {!carregando && itens.length === 0 && (
                <EstadoVazio
                  Icone={Tag}
                  titulo="Nenhum item nesta promoção"
                  descricao="Ou a promoção está vazia na plataforma, ou os itens dela ainda não foram lidos. Rode a sincronização."
                />
              )}

              {!carregando && itens.length > 0 && (
                <div className="tabela-rolagem">
                  <table className="tabela-promocao">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>
                          <Checkbox
                            checked={marcados.length === itens.length && itens.length > 0}
                            onChange={(e) => setMarcados(e.target.checked ? itens.map((i) => i.id) : [])}
                          />
                        </th>
                        <th>Anúncio</th>
                        <th>Variação</th>
                        <th className="num">Preço de</th>
                        <th className="num">Preço promocional</th>
                        <th className="num">Desconto</th>
                        <th className="num">Margem</th>
                        <th>Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itens.map((i) => {
                        const editado = edicoes[i.id];
                        const precoMostrado = editado ?? i.preco_promocional;
                        return (
                          <tr key={i.id} className={margemDoItem(i).margem?.prejuizo ? 'linha-prejuizo' : ''}>
                            <td>
                              <Checkbox
                                checked={marcados.includes(i.id)}
                                onChange={(e) => setMarcados((s) => (e.target.checked ? [...s, i.id] : s.filter((x) => x !== i.id)))}
                              />
                            </td>
                            <td>
                              <div className="promocao-celula-anuncio">
                                {i.foto_url
                                  ? <img src={i.foto_url} alt="" loading="lazy" />
                                  : <span className="promocao-foto-vazia"><Package size={14} /></span>}
                                <span>
                                  <strong>{i.referencia || i.titulo || i.anuncio_id_externo}</strong>
                                  <small>{i.titulo}</small>
                                  {!i.produto_id && (
                                    <span className="selo tone-atencao" title="Sem produto vinculado, então a margem não pode ser calculada.">
                                      sem vínculo
                                    </span>
                                  )}
                                </span>
                              </div>
                            </td>
                            <td>{[i.cor, i.tamanho].filter(Boolean).join(' · ') || <span className="ink-faint">única</span>}</td>
                            <td className="num">{i.preco_original != null ? brl(i.preco_original) : '—'}</td>
                            <td className="num">
                              <NumInput
                                value={precoMostrado ?? ''}
                                onChange={(v) => setEdicoes((e) => ({ ...e, [i.id]: v === '' ? null : Number(v) }))}
                                step="0.01"
                                className={editado != null && Number(editado) !== Number(i.preco_promocional) ? 'editado' : ''}
                              />
                            </td>
                            <td className="num">{rotuloDesconto(i.preco_original, precoMostrado)}</td>
                            <td className="num">
                              {(() => {
                                const m = margemDoItem(i);
                                return <SeloMargem margem={m.margem} indisponivel={m.indisponivel} recalculando={m.recalculando} compacto />;
                              })()}
                            </td>
                            <td>
                              {i.status_item === 'recusado' && (
                                <span className="selo tone-prejuizo" title={i.motivo_recusa || undefined}>
                                  recusado
                                </span>
                              )}
                              {i.url && (
                                <a href={i.url} target="_blank" rel="noreferrer" className="btn-icone" title="Abrir na plataforma">
                                  <ExternalLink size={13} />
                                </a>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {erro && <p className="erro-inline">{erro}</p>}

              <div className="promocao-acoes">
                {/* Editar e excluir só aparecem onde a plataforma aceita.
                    Mostrar um botão que sempre devolve erro 400 é pior do que
                    não mostrar botão nenhum: aqui o motivo fica no title e o
                    botão some, em vez de a pessoa descobrir depois de clicar. */}
                {promocao && podeEditarJanela && (
                  <button type="button" className="btn-sec" onClick={abrirEdicao} disabled={salvando || editando}>
                    <Pencil size={14} /> Editar nome e datas
                  </button>
                )}
                <button type="button" className="btn-sec perigo" onClick={encerrar} disabled={salvando || !promocao}>
                  Encerrar promoção
                </button>
                {promocao && podeExcluir && (
                  <button type="button" className="btn-sec perigo" onClick={excluir} disabled={salvando}>
                    <Trash2 size={14} /> Excluir
                  </button>
                )}
                {/* O botão olha a MESMA lista que salvarPrecos usa. Com
                    `Object.keys(edicoes)`, apagar o campo de preço de um item
                    registrava `edicoes[id] = null`: o botão acendia e o clique
                    não fazia nada, sem mensagem nenhuma. */}
                <button
                  type="button"
                  className="btn"
                  onClick={salvarPrecos}
                  disabled={salvando || itensAlterados.length === 0}
                >
                  {salvando ? 'Enviando…' : 'Salvar preços na plataforma'}
                </button>
              </div>
            </>
          )}

          {aba === 'historico' && (
            <>
              {!historico && <Skeleton height={160} />}
              {historico && historico.historico.length === 0 && (
                <EstadoVazio
                  Icone={History}
                  titulo="Nada registrado ainda"
                  descricao={historico.gravadoDesde
                    ? `O histórico desta promoção começou a ser gravado em ${new Date(historico.gravadoDesde).toLocaleDateString('pt-BR')}. O que aconteceu antes disso não foi registrado.`
                    : 'O histórico começa na primeira sincronização.'}
                />
              )}
              {historico && historico.historico.length > 0 && (
                <ul className="promocao-historico">
                  {historico.historico.map((h) => (
                    <li key={h.id}>
                      <span className="promocao-historico-quando">{tempoRelativo(h.registrado_em)}</span>
                      <span className="promocao-historico-texto">
                        <strong>{h.campo}</strong>
                        {h.anuncio_id_externo && <em> · {h.anuncio_id_externo}</em>}
                        {h.valor_antes != null && <> de <code>{h.valor_antes}</code></>}
                        {h.valor_depois != null && <> para <code>{h.valor_depois}</code></>}
                      </span>
                      <span className="promocao-historico-origem">
                        {h.origem === 'hbn_hub' ? (h.usuario_nome || 'pelo Hub') : 'na plataforma'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// ===========================================================================
// Página
// ===========================================================================
export default function PromocoesPage() {
  const [lojas, setLojas] = useState([]);
  const [promocoes, setPromocoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [estadoSync, setEstadoSync] = useState(null);
  const [vista, setVista] = useState('lista');
  const [abertaId, setAbertaId] = useState(null);
  const [erro, setErro] = useState(null);

  const [filtroLoja, setFiltroLoja] = useState('');
  const [filtroTipo, setFiltroTipo] = useState('');
  const [filtroJanela, setFiltroJanela] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  // Ordenação e paginação pelo mesmo hook das outras listas do sistema: o
  // estado mora na URL, então dá pra mandar o link com a tela exatamente como
  // está aberta.

  const carregar = useCallback(() => {
    const params = new URLSearchParams();
    if (filtroLoja) params.set('integracao_id', filtroLoja);
    if (filtroTipo) params.set('tipo', filtroTipo);
    if (filtroJanela) params.set('janela', filtroJanela);
    if (buscaAplicada) params.set('busca', buscaAplicada);
    setCarregando(true);
    api.get(`/promocoes?${params.toString()}`)
      .then(setPromocoes)
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [filtroLoja, filtroTipo, filtroJanela, buscaAplicada]);

  useEffect(() => { api.get(CAMINHO_LOJAS_PROMOCOES).then(setLojas).catch(() => setLojas([])); }, []);
  useEffect(() => { carregar(); }, [carregar]);

  // Enquanto a varredura roda em segundo plano, a tela pergunta o andamento.
  // Sem isso ela ficaria parada e alguém clicaria em sincronizar de novo.
  useEffect(() => {
    if (!sincronizando) return undefined;
    const timer = setInterval(async () => {
      try {
        const d = await api.get('/promocoes/sincronizacao/estado');
        setEstadoSync(d);
        if (!d.emAndamento) {
          setSincronizando(false);
          carregar();
        }
      } catch { /* uma leitura de andamento que falha não derruba a tela */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [sincronizando, carregar]);

  async function sincronizar() {
    setErro(null);
    try {
      await api.post('/promocoes/sincronizar', filtroLoja ? { integracao_id: Number(filtroLoja) } : {});
      setSincronizando(true);
    } catch (e) {
      setErro(e.message);
    }
  }

  const chips = useMemo(() => {
    const itens = [];
    if (filtroLoja) {
      const l = lojas.find((x) => String(x.id) === String(filtroLoja));
      itens.push({ chave: 'loja', rotulo: 'Loja', valor: l ? nomeDaLoja(l) : filtroLoja, onRemover: () => setFiltroLoja('') });
    }
    if (filtroTipo) itens.push({ chave: 'tipo', rotulo: 'Tipo', valor: TIPO_ROTULO[filtroTipo] || filtroTipo, onRemover: () => setFiltroTipo('') });
    if (filtroJanela) itens.push({ chave: 'janela', rotulo: 'Período', valor: JANELA_ROTULO[filtroJanela] || filtroJanela, onRemover: () => setFiltroJanela('') });
    if (buscaAplicada) itens.push({ chave: 'busca', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } });
    return itens;
  }, [filtroLoja, filtroTipo, filtroJanela, buscaAplicada, lojas]);

  const totais = useMemo(() => ({
    total: promocoes.length,
    noAr: promocoes.filter((p) => p.status === 'ativa').length,
    agendadas: promocoes.filter((p) => p.status === 'agendada').length,
    itens: promocoes.reduce((s, p) => s + Number(p.itens_ativos || 0), 0),
    recusados: promocoes.reduce((s, p) => s + Number(p.itens_recusados || 0), 0),
  }), [promocoes]);

  const tabela = useTabela(promocoes, {
    colunas: COLUNAS_ORDENAVEIS,
    colunaPadrao: 'inicio',
    direcaoPadrao: 'desc',
    tamanhoPadrao: 25,
  });

  if (vista === 'criar') {
    return (
      <CriarPromocao
        lojas={lojas}
        onFechar={() => setVista('lista')}
        onCriada={() => { setVista('lista'); carregar(); }}
      />
    );
  }
  if (vista === 'relampago') {
    return <RelampagoEmMassa lojas={lojas} onFechar={() => setVista('lista')} onCriadas={carregar} />;
  }

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Tag size={22} /> Promoções</h1>
          <p className="ink-soft">
            Todas as promoções das lojas conectadas, com a margem que sobra em cada preço promocional.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={sincronizar} disabled={sincronizando}>
            <RefreshCw size={15} className={sincronizando ? 'girando' : ''} />
            {sincronizando ? 'Lendo as lojas…' : 'Sincronizar'}
          </button>
          <button type="button" className="btn-sec" onClick={() => setVista('relampago')}>
            <Zap size={15} /> Relâmpagos em massa
          </button>
          <button type="button" className="btn" onClick={() => setVista('criar')}>
            <Plus size={15} /> Nova promoção
          </button>
        </div>
      </header>

      {sincronizando && estadoSync && (
        <div className="promocao-andamento">
          {estadoSync.lojas.map((l) => (
            <span key={l.origem_integracao_id} className={l.em_andamento ? 'lendo' : 'pronto'}>
              <SeloPlataforma chave={l.marketplace} size={13} />
              {l.nome}
              {l.em_andamento
                ? ' · lendo…'
                : ` · ${formatQtd(l.promocoes_lidas || 0)} promoções`}
            </span>
          ))}
        </div>
      )}

      <div className="indicadores-linha">
        <IndicadorDestaque rotulo="Promoções" valor={formatQtd(totais.total)} Icone={Tag} />
        <IndicadorDestaque rotulo="No ar agora" valor={formatQtd(totais.noAr)} tom={totais.noAr > 0 ? 'positivo' : undefined} />
        <IndicadorDestaque rotulo="Agendadas" valor={formatQtd(totais.agendadas)} />
        <IndicadorDestaque rotulo="Anúncios em promoção" valor={formatQtd(totais.itens)} />
        {totais.recusados > 0 && (
          <IndicadorDestaque
            rotulo="Itens recusados"
            valor={formatQtd(totais.recusados)}
            tom="atencao"
            explicacao="A plataforma aceitou a promoção mas recusou esses itens. Abra a promoção para ver o motivo."
          />
        )}
      </div>

      <div className="filtros-linha">
        <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)} placeholder="Nome da promoção" />
        <Select value={filtroLoja} onChange={(e) => setFiltroLoja(e.target.value)} placeholder="Todas as lojas">
          {lojas.map((l) => <option key={l.id} value={l.id}>{nomeDaLoja(l)}</option>)}
        </Select>
        <Select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)} placeholder="Todos os tipos">
          {Object.entries(TIPO_ROTULO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={filtroJanela} onChange={(e) => setFiltroJanela(e.target.value)} placeholder="Qualquer período">
          <option value="no_ar">No ar agora</option>
          <option value="futuras">Ainda vão começar</option>
          <option value="encerradas">Já terminaram</option>
        </Select>
      </div>

      {chips.length > 0 && (
        <ChipsFiltros
          itens={chips}
          onLimparTudo={() => {
            setFiltroLoja(''); setFiltroTipo(''); setFiltroJanela('');
            setBusca(''); setBuscaAplicada('');
          }}
        />
      )}

      {erro && <p className="erro-inline">{erro}</p>}

      {carregando && (
        <div className="promocoes-grade">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={168} radius={12} />)}
        </div>
      )}

      {!carregando && promocoes.length === 0 && (
        <EstadoVazio
          Icone={Tag}
          titulo="Nenhuma promoção por aqui"
          descricao={lojas.some((l) => l.ultima_sincronizacao)
            ? 'As lojas foram lidas e não havia promoção nos filtros escolhidos.'
            : 'As lojas ainda não foram lidas. Clique em Sincronizar para trazer o que já existe nas plataformas.'}
          acaoLabel="Sincronizar agora"
          onAcao={sincronizar}
          IconeAcao={RefreshCw}
        />
      )}

      {!carregando && promocoes.length > 0 && (
        <>
          <div className="promocoes-grade">
            {tabela.itensPagina.map((p) => (
              <CartaoPromocao
                key={p.id}
                promocao={p}
                selecionada={abertaId === p.id}
                onAbrir={() => setAbertaId(p.id)}
              />
            ))}
          </div>
          <Paginacao
            pagina={tabela.pagina}
            totalPaginas={tabela.totalPaginas}
            tamanho={tabela.tamanho}
            totalItens={tabela.totalItens}
            inicio={tabela.inicio}
            fim={tabela.fim}
            setPagina={tabela.setPagina}
            setTamanho={tabela.setTamanho}
          />
        </>
      )}

      {abertaId && (
        <PainelPromocao
          promocaoId={abertaId}
          onFechar={() => setAbertaId(null)}
          onMudou={carregar}
        />
      )}
    </div>
  );
}
