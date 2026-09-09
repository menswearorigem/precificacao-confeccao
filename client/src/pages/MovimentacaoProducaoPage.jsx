import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight, RefreshCw, Plus, X, AlertTriangle, Check, Info,
  Truck, Undo2, Factory, Layers, ClipboardList,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, IndicadorDestaque, NumInput, Field, DateInput,
} from '../components/ui';
import NovaFaccaoModal from '../components/NovaFaccaoModal';
import { brl, formatQtd, dataBr, numeroBr, uid } from '../lib/format';

// Produção › Gerar Movimentação.
//
// É a cópia da tela "Gerar Movimentação" da versão antiga do Wik (vídeo de
// 09/09/2026): um par ORIGEM → DESTINO com VÁRIOS destinos numa operação só,
// porque é assim que a fábrica trabalha — metade das peças vai para uma
// facção e metade para outra, no mesmo ato.
//
// O que esta tela faz de diferente do Wik:
//
//   1. A peça tem COR E TAMANHO. Lá se movimenta "50 peças" e ninguém sabe
//      quais; aqui cada linha da grade anda por conta própria, e é por isso
//      que o saldo por variante fecha.
//   2. O SALDO DA ORIGEM aparece na tela antes de qualquer digitação. Não se
//      tira do corte o que não está no corte.
//   3. REPROCESSO separa a etapa que CAUSOU o defeito da que o IDENTIFICOU —
//      sem isso a culpa cai sempre em quem achou o problema, normalmente a
//      revisão, e o ranking de qualidade sai invertido.
//   4. O CUSTO DA REMESSA aparece ANTES de gravar, pelo preço vigente da
//      facção naquela etapa. Sem preço cadastrado a tela escreve isso — não
//      mostra R$ 0,00, que seria mentira.
//
// REGRA 1: nada aqui lê ou escreve preço de venda, margem ou markup. O preço
// que aparece é o do SERVIÇO contratado da facção, já cadastrado.
//
// REGRA 4: movimento não se apaga. O extrato mostra tudo, e o que foi
// estornado aparece riscado — nunca some.

const ROTA = '/producao-movimentacao';

const TIPOS_MOVIMENTO = [
  {
    valor: 'normal',
    rotulo: 'Normal — a peça anda para a frente',
    ajuda: 'O caminho comum: a peça terminou aqui e segue para a próxima etapa.',
  },
  {
    valor: 'reprocesso',
    rotulo: 'Reprocesso — volta para refazer',
    ajuda: 'A peça voltou para trás por defeito. Exige motivo e a etapa que identificou o problema.',
  },
  {
    valor: 'retorno',
    rotulo: 'Retorno — está voltando de fora',
    ajuda: 'A peça está voltando de uma etapa externa por fora do fluxo normal da O.S.',
  },
];

const TOM_TIPO_MOV = {
  normal: 'tone-neutro',
  retorno: 'tone-saudavel',
  reprocesso: 'tone-atencao',
  perda: 'tone-prejuizo',
  segunda: 'tone-atencao',
  conclusao: 'tone-saudavel',
  estorno: 'tone-prejuizo',
};

function chaveGrade(cor, tamanho) {
  return `${cor || ''}|${tamanho || ''}`;
}

function rotuloGrade(cor, tamanho) {
  const partes = [cor || null, tamanho || null].filter(Boolean);
  return partes.length ? partes.join(' / ') : 'sem cor e sem tamanho';
}

function chaveOrigem(etapaId, fornecedorId) {
  return `${etapaId ?? ''}|${fornecedorId ?? ''}`;
}

function destinoVazio() {
  return {
    uid: uid(),
    etapa_destino_id: '',
    fornecedor_destino_id: '',
    previsao_retorno: '',
    tipo: 'normal',
    motivo_id: '',
    etapa_identificadora_id: '',
    observacao: '',
    itens: {},
  };
}

// ---------------------------------------------------------------------------
// Um destino da operação
// ---------------------------------------------------------------------------
function CartaoDestino({
  destino, indice, total, etapas, fornecedores, motivos, linhasGrade,
  produtoId, data, onAlterar, onRemover, onPreco, onNovaFaccao,
}) {
  const [preco, setPreco] = useState(null);
  const [precoCarregando, setPrecoCarregando] = useState(false);
  const [precoErro, setPrecoErro] = useState('');

  const etapa = etapas.find((e) => String(e.id) === String(destino.etapa_destino_id)) || null;
  const externa = etapa?.natureza === 'externa';

  const pecas = useMemo(
    () => Object.values(destino.itens).reduce((s, q) => s + (Number(q) || 0), 0),
    [destino.itens]
  );

  // O preço vigente da facção naquela etapa, na data da movimentação. É o
  // mesmo que o backend vai congelar na O.S. — mostrar aqui é o que evita
  // mandar 800 peças para uma facção sem preço cadastrado e descobrir isso
  // só na hora de pagar.
  useEffect(() => {
    let vivo = true;
    if (!externa || !destino.fornecedor_destino_id || !destino.etapa_destino_id) {
      setPreco(null);
      setPrecoErro('');
      onPreco(destino.uid, null);
      return () => { vivo = false; };
    }
    setPrecoCarregando(true);
    const qs = new URLSearchParams({
      fornecedor_id: String(destino.fornecedor_destino_id),
      etapa_id: String(destino.etapa_destino_id),
    });
    if (produtoId) qs.set('produto_id', String(produtoId));
    if (data) qs.set('data', data);
    api.get(`${ROTA}/faccao-precos/vigente?${qs}`)
      .then((r) => {
        if (!vivo) return;
        setPreco(r);
        setPrecoErro('');
        onPreco(destino.uid, r);
      })
      .catch((e) => {
        if (!vivo) return;
        setPreco(null);
        setPrecoErro(e.message);
        onPreco(destino.uid, null);
      })
      .finally(() => { if (vivo) setPrecoCarregando(false); });
    return () => { vivo = false; };
  }, [externa, destino.fornecedor_destino_id, destino.etapa_destino_id, destino.uid, produtoId, data, onPreco]);

  const valorPorPeca = preco?.valor_por_peca != null ? Number(preco.valor_por_peca) : null;
  const custoRemessa = valorPorPeca != null ? valorPorPeca * pecas : null;
  const tipoEscolhido = TIPOS_MOVIMENTO.find((t) => t.valor === destino.tipo);

  return (
    <div className="card mov-destino">
      <div className="card-head-linha">
        <h3 className="card-titulo">
          <Truck size={16} /> Destino {indice + 1} de {total}
          {externa && <span className="selo tone-atencao" title="Etapa externa: esta remessa gera uma Ordem de Serviço de facção.">gera O.S.</span>}
        </h3>
        {total > 1 && (
          <button type="button" className="btn-icone" aria-label={`Remover o destino ${indice + 1}`} onClick={onRemover}>
            <X size={16} />
          </button>
        )}
      </div>

      <div className="form-linha">
        <Field label="Etapa de destino" hint="Para onde a peça vai.">
          <Select
            value={destino.etapa_destino_id}
            placeholder="Escolha a etapa"
            onChange={(e) => onAlterar({ etapa_destino_id: e.target.value })}
          >
            {etapas.map((et) => (
              <option key={et.id} value={et.id}>
                {et.sequencia}. {et.nome} ({et.natureza})
              </option>
            ))}
          </Select>
        </Field>

        {/* Facção só aparece quando a etapa é externa: é a própria etapa que
            diz, pelo campo `natureza`, se existe alguém de fora envolvido.
            Pedir facção numa etapa interna seria pedir um dado que não
            existe. */}
        {externa && (
          <Field label="Facção que vai receber" hint="Obrigatória: a etapa é externa.">
            <div className="campo-com-acao">
              <Select
                value={destino.fornecedor_destino_id}
                placeholder="Escolha a facção"
                onChange={(e) => onAlterar({ fornecedor_destino_id: e.target.value })}
              >
                {fornecedores.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.nome}{f.categoria_nome ? ` · ${f.categoria_nome}` : ''}
                  </option>
                ))}
              </Select>
              {/* Cadastrar a facção SEM SAIR DAQUI. Pedido da dona: a facção
                  nova aparece na hora de mandar a peça, e obrigar a abrir outra
                  tela, cadastrar e voltar faz perder o que já foi digitado no
                  formulário de movimentação. */}
              {onNovaFaccao && (
                <button
                  type="button" className="btn-sec btn-mini" onClick={onNovaFaccao}
                  title="Cadastrar uma facção nova sem sair desta tela."
                ><Plus size={14} /> Nova</button>
              )}
            </div>
          </Field>
        )}

        {externa && (
          <Field label="Previsão de retorno" hint="Obrigatória: sem prazo prometido não há como medir atraso.">
            <DateInput
              value={destino.previsao_retorno}
              onChange={(e) => onAlterar({ previsao_retorno: e.target.value })}
            />
          </Field>
        )}

        <Field label="Tipo do movimento">
          <Select value={destino.tipo} onChange={(e) => onAlterar({ tipo: e.target.value })}>
            {TIPOS_MOVIMENTO.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
          </Select>
        </Field>

        {destino.tipo === 'reprocesso' && (
          <Field label="Motivo do reprocesso" hint="Obrigatório: é o que permite ranquear defeito por causa.">
            <Select
              value={destino.motivo_id}
              placeholder="Escolha o motivo"
              onChange={(e) => onAlterar({ motivo_id: e.target.value })}
            >
              {motivos.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
            </Select>
          </Field>
        )}

        {destino.tipo === 'reprocesso' && (
          <Field
            label="Etapa que identificou o defeito"
            hint="Quem ACHOU o problema — diferente de quem causou."
          >
            <Select
              value={destino.etapa_identificadora_id}
              placeholder="Não informada"
              onChange={(e) => onAlterar({ etapa_identificadora_id: e.target.value })}
            >
              {etapas.map((et) => <option key={et.id} value={et.id}>{et.nome}</option>)}
            </Select>
          </Field>
        )}

        <Field label="Observação">
          <input
            className="input"
            value={destino.observacao}
            onChange={(e) => onAlterar({ observacao: e.target.value })}
            placeholder="Vai junto no romaneio"
          />
        </Field>
      </div>

      {tipoEscolhido && <p className="ink-soft ajuda-bloco"><Info size={14} /> {tipoEscolhido.ajuda}</p>}

      {destino.tipo === 'reprocesso' && (
        <p className="ink-soft ajuda-bloco">
          A etapa que identificou é registrada separada da que causou porque, sem essa
          separação, o defeito fica sempre contado contra quem revisou a peça — e o
          ranking de qualidade aponta para o lado errado da fábrica.
        </p>
      )}

      {linhasGrade.length === 0 ? (
        <p className="aviso-inline">
          <AlertTriangle size={14} /> Não há grade para digitar: escolha primeiro de onde a peça sai.
        </p>
      ) : (
        <div className="tabela-rolagem">
          <table className="tabela-nota">
            <thead>
              <tr>
                <th>Cor</th><th>Tamanho</th>
                <th className="num">Disponível na origem</th>
                <th className="num">Vai neste destino</th>
              </tr>
            </thead>
            <tbody>
              {linhasGrade.map((l) => {
                const chave = chaveGrade(l.cor, l.tamanho);
                return (
                  <tr key={chave}>
                    <td>{l.cor || '—'}</td>
                    <td>{l.tamanho || '—'}</td>
                    <td className="num">
                      {l.disponivel == null ? '—' : formatQtd(l.disponivel)}
                    </td>
                    <td className="num">
                      <NumInput
                        step="1"
                        value={destino.itens[chave] ?? ''}
                        onChange={(v) => onAlterar({ itens: { ...destino.itens, [chave]: v } })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="indicadores-linha">
        <IndicadorDestaque
          rotulo="Peças neste destino"
          valor={formatQtd(pecas)}
          explicacao="A soma do que você digitou na grade acima."
        />
        {externa && (
          <IndicadorDestaque
            rotulo="Preço do serviço"
            valor={precoCarregando
              ? '…'
              : (valorPorPeca != null ? `${brl(valorPorPeca)} / peça` : 'sem preço cadastrado')}
            tom={!precoCarregando && valorPorPeca == null ? 'atencao' : undefined}
            explicacao={valorPorPeca != null
              ? 'Preço vigente desta facção nesta etapa, na data da movimentação. É ele que a O.S. vai congelar.'
              : 'Não há preço cadastrado para essa facção nesta etapa. A O.S. nasce sem valor, e o custo do serviço vai aparecer como "—" até alguém cadastrar o preço — não como R$ 0,00.'}
          />
        )}
        {externa && (
          <IndicadorDestaque
            rotulo="Custo desta remessa"
            valor={custoRemessa != null ? brl(custoRemessa) : 'não dá para dizer'}
            tom={custoRemessa == null ? 'atencao' : undefined}
            explicacao={custoRemessa != null
              ? 'Peças deste destino × preço vigente por peça. É o que a facção vai cobrar se tudo voltar bom.'
              : 'Sem preço cadastrado não há conta a fazer. Zero seria um número errado escrito com confiança.'}
          />
        )}
      </div>

      {precoErro && <p className="erro-inline">{precoErro}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extrato de movimentos da ordem
// ---------------------------------------------------------------------------
function Extrato({ movimentos, onEstornado, onErro }) {
  const [estornando, setEstornando] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function confirmarEstorno(id) {
    if (!motivo.trim()) return;
    setSalvando(true);
    try {
      await api.post(`${ROTA}/movimentos/${id}/estornar`, { motivo });
      setEstornando(null);
      setMotivo('');
      await onEstornado();
    } catch (e) {
      onErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  if (movimentos.length === 0) {
    return (
      <EstadoVazio
        Icone={ClipboardList}
        titulo="Esta ordem ainda não andou"
        descricao="Nenhuma peça foi movimentada nesta ordem até agora. Assim que a primeira remessa for gravada, cada movimento aparece aqui com data, quem fez e para onde foi — e continua aparecendo mesmo depois de estornado."
      />
    );
  }

  return (
    <div className="tabela-rolagem">
      <table className="tabela-nota">
        <thead>
          <tr>
            <th>Data</th><th>De</th><th>Para</th><th>Grade</th>
            <th className="num">Peças</th><th>Tipo</th><th>O.S.</th><th>Quem</th><th />
          </tr>
        </thead>
        <tbody>
          {movimentos.map((m) => {
            const estornado = Boolean(m.estornado_em);
            const ehEstorno = m.tipo === 'estorno';
            return (
              <tr key={m.id} className={estornado ? 'linha-estornada' : undefined}>
                <td>{dataBr(m.data_movimento)}</td>
                <td>
                  {m.etapa_origem_nome || 'entrada no fluxo'}
                  {m.fornecedor_origem_nome ? <span className="ink-soft"> · {m.fornecedor_origem_nome}</span> : ''}
                </td>
                <td>
                  {m.etapa_destino_nome || 'saiu do fluxo'}
                  {m.fornecedor_destino_nome ? <span className="ink-soft"> · {m.fornecedor_destino_nome}</span> : ''}
                </td>
                <td>{rotuloGrade(m.cor, m.tamanho)}</td>
                <td className="num">{formatQtd(m.quantidade)}</td>
                <td>
                  <span className={`selo ${TOM_TIPO_MOV[m.tipo] || 'tone-neutro'}`}>{m.tipo}</span>
                  {m.motivo_nome && <span className="ink-soft"> {m.motivo_nome}</span>}
                  {m.etapa_identificadora_nome && (
                    <span className="ink-soft"> · achado em {m.etapa_identificadora_nome}</span>
                  )}
                  {estornado && <span className="selo tone-prejuizo" title="Este movimento foi desfeito por um estorno. Ele fica aqui de propósito: movimento não se apaga.">estornado</span>}
                </td>
                <td>{m.os_numero ? `O.S. ${m.os_numero}` : '—'}</td>
                <td>{m.usuario_nome || '—'}</td>
                <td>
                  {!estornado && !ehEstorno && estornando !== m.id && (
                    <button type="button" className="btn-sec" onClick={() => { setEstornando(m.id); setMotivo(''); }}>
                      <Undo2 size={14} /> Estornar
                    </button>
                  )}
                  {estornando === m.id && (
                    <span className="painel-acoes-inline">
                      <input
                        className="input"
                        value={motivo}
                        autoFocus
                        placeholder="Por que está estornando?"
                        onChange={(e) => setMotivo(e.target.value)}
                      />
                      <button
                        type="button" className="btn" disabled={!motivo.trim() || salvando}
                        onClick={() => confirmarEstorno(m.id)}
                      ><Check size={14} /> Confirmar</button>
                      <button type="button" className="btn-sec" onClick={() => setEstornando(null)}>Cancelar</button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function MovimentacaoProducaoPage() {
  const [ordens, setOrdens] = useState([]);
  const [etapas, setEtapas] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [motivos, setMotivos] = useState([]);
  const [ordemId, setOrdemId] = useState('');
  const [ordemDetalhe, setOrdemDetalhe] = useState(null);
  const [posicao, setPosicao] = useState(null);
  const [movimentos, setMovimentos] = useState([]);
  const [origem, setOrigem] = useState('');
  const [destinos, setDestinos] = useState([destinoVazio()]);
  const [precos, setPrecos] = useState({});
  const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
  const [carregando, setCarregando] = useState(true);
  const [carregandoOrdem, setCarregandoOrdem] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [resultado, setResultado] = useState(null);
  const [novaFaccao, setNovaFaccao] = useState(false);

  const carregarApoio = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [o, et, apoio, mot] = await Promise.all([
        api.get('/producao/ordens'),
        api.get(`${ROTA}/etapas`),
        api.get('/producao/apoio').catch(() => ({ fornecedores: [] })),
        api.get(`${ROTA}/motivos?tipo=reprocesso`).catch(() => []),
      ]);
      setOrdens(o.filter((r) => !['cancelada', 'concluida'].includes(r.situacao)));
      setEtapas(et);
      // A lista do combo passa a ser a de FACÇÕES (0063), não a de
      // fornecedores em geral: mandar 800 peças para o fornecedor de embalagem
      // é um erro que só aparecia na hora de pagar. Se ainda não houver
      // nenhuma facção marcada, cai para a lista antiga — a tela não pode
      // ficar sem opção nenhuma no primeiro deploy.
      setFornecedores((apoio.faccoes || []).length > 0 ? apoio.faccoes : (apoio.fornecedores || []));
      setMotivos(mot);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregarApoio(); }, [carregarApoio]);

  const carregarOrdem = useCallback(async (id) => {
    if (!id) { setPosicao(null); setMovimentos([]); setOrdemDetalhe(null); return; }
    setCarregandoOrdem(true);
    setErro('');
    try {
      const [p, m, d] = await Promise.all([
        api.get(`${ROTA}/ordens/${id}/posicao`),
        api.get(`${ROTA}/ordens/${id}/movimentos`),
        api.get(`/producao/ordens/${id}`).catch(() => null),
      ]);
      setPosicao(p);
      setMovimentos(m);
      setOrdemDetalhe(d);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoOrdem(false);
    }
  }, []);

  useEffect(() => { carregarOrdem(ordemId); }, [ordemId, carregarOrdem]);

  const ordemEscolhida = ordens.find((o) => String(o.id) === String(ordemId)) || null;

  // As origens possíveis: cada par (etapa, facção) que tem peça de verdade.
  const origens = useMemo(() => {
    const mapa = new Map();
    for (const r of posicao?.posicao || []) {
      if (Number(r.quantidade) <= 0) continue;
      const chave = chaveOrigem(r.etapa_id, r.fornecedor_id);
      const atual = mapa.get(chave) || {
        chave,
        etapa_id: r.etapa_id,
        fornecedor_id: r.fornecedor_id,
        etapa_nome: r.etapa_nome || 'sem etapa',
        fornecedor_nome: r.fornecedor_nome || null,
        pecas: 0,
        linhas: [],
      };
      atual.pecas += Number(r.quantidade);
      atual.linhas.push(r);
      mapa.set(chave, atual);
    }
    return [...mapa.values()];
  }, [posicao]);

  const origemEscolhida = origens.find((o) => o.chave === origem) || null;
  const entradaNoFluxo = origem === 'entrada';

  // A grade que pode ser digitada: o saldo da origem escolhida, ou — quando a
  // peça está ENTRANDO no fluxo — a grade planejada da própria ordem, que é a
  // única lista de cor/tamanho que existe antes do primeiro movimento.
  const linhasGrade = useMemo(() => {
    if (entradaNoFluxo) {
      return (ordemDetalhe?.grade || []).map((g) => ({
        cor: g.cor, tamanho: g.tamanho, disponivel: null,
      }));
    }
    if (!origemEscolhida) return [];
    return origemEscolhida.linhas.map((l) => ({
      cor: l.cor, tamanho: l.tamanho, disponivel: Number(l.quantidade),
    }));
  }, [entradaNoFluxo, ordemDetalhe, origemEscolhida]);

  const registrarPreco = useCallback((chave, preco) => {
    setPrecos((atual) => {
      const valor = preco?.valor_por_peca != null ? Number(preco.valor_por_peca) : null;
      if (atual[chave] === valor) return atual;
      return { ...atual, [chave]: valor };
    });
  }, []);

  function alterarDestino(chave, mudanca) {
    setDestinos((atual) => atual.map((d) => (d.uid === chave ? { ...d, ...mudanca } : d)));
  }

  // Total pedido por linha da grade, somando TODOS os destinos — é essa soma
  // que precisa caber no saldo, não cada destino sozinho.
  const pedidoPorLinha = useMemo(() => {
    const mapa = new Map();
    for (const d of destinos) {
      for (const [chave, qtd] of Object.entries(d.itens)) {
        const n = Number(qtd) || 0;
        if (n <= 0) continue;
        mapa.set(chave, (mapa.get(chave) || 0) + n);
      }
    }
    return mapa;
  }, [destinos]);

  const excessos = useMemo(() => {
    if (entradaNoFluxo || !origemEscolhida) return [];
    const disponivel = new Map(
      origemEscolhida.linhas.map((l) => [chaveGrade(l.cor, l.tamanho), Number(l.quantidade)])
    );
    const lista = [];
    for (const [chave, qtd] of pedidoPorLinha) {
      const tem = disponivel.get(chave) || 0;
      if (qtd > tem) {
        const [cor, tamanho] = chave.split('|');
        lista.push({ chave, rotulo: rotuloGrade(cor, tamanho), tem, qtd });
      }
    }
    return lista;
  }, [entradaNoFluxo, origemEscolhida, pedidoPorLinha]);

  const totalPecas = useMemo(
    () => [...pedidoPorLinha.values()].reduce((s, n) => s + n, 0),
    [pedidoPorLinha]
  );

  // O custo total da operação: só os destinos externos custam serviço, e só
  // os que têm preço cadastrado entram na soma. Quantos ficaram de fora é
  // dito por escrito — fora da conta não é zero.
  const custo = useMemo(() => {
    let total = 0;
    let semPreco = 0;
    for (const d of destinos) {
      const etapa = etapas.find((e) => String(e.id) === String(d.etapa_destino_id));
      if (etapa?.natureza !== 'externa') continue;
      const pecas = Object.values(d.itens).reduce((s, q) => s + (Number(q) || 0), 0);
      if (pecas <= 0) continue;
      const valor = precos[d.uid];
      if (valor == null) { semPreco += 1; continue; }
      total += valor * pecas;
    }
    return { total, semPreco };
  }, [destinos, etapas, precos]);

  const faltaExterno = useMemo(() => destinos.some((d) => {
    const etapa = etapas.find((e) => String(e.id) === String(d.etapa_destino_id));
    if (etapa?.natureza !== 'externa') return false;
    const pecas = Object.values(d.itens).reduce((s, q) => s + (Number(q) || 0), 0);
    if (pecas <= 0) return false;
    return !d.fornecedor_destino_id || !d.previsao_retorno;
  }), [destinos, etapas]);

  const faltaMotivo = useMemo(() => destinos.some((d) => {
    if (d.tipo !== 'reprocesso') return false;
    const pecas = Object.values(d.itens).reduce((s, q) => s + (Number(q) || 0), 0);
    return pecas > 0 && !d.motivo_id;
  }), [destinos]);

  const podeGravar = Boolean(ordemId)
    && Boolean(origem)
    && totalPecas > 0
    && excessos.length === 0
    && !faltaExterno
    && !faltaMotivo
    && !salvando;

  async function gravar() {
    setErro('');
    setResultado(null);
    setSalvando(true);
    try {
      const corpo = {
        ordem_id: Number(ordemId),
        etapa_origem_id: entradaNoFluxo ? null : (origemEscolhida?.etapa_id || null),
        fornecedor_origem_id: entradaNoFluxo ? null : (origemEscolhida?.fornecedor_id || null),
        data,
        destinos: destinos.map((d) => ({
          etapa_destino_id: d.etapa_destino_id ? Number(d.etapa_destino_id) : null,
          fornecedor_destino_id: d.fornecedor_destino_id ? Number(d.fornecedor_destino_id) : null,
          tipo: d.tipo,
          motivo_id: d.motivo_id ? Number(d.motivo_id) : null,
          etapa_identificadora_id: d.etapa_identificadora_id ? Number(d.etapa_identificadora_id) : null,
          previsao_retorno: d.previsao_retorno || null,
          observacao: d.observacao || null,
          itens: Object.entries(d.itens)
            .map(([chave, qtd]) => {
              const [cor, tamanho] = chave.split('|');
              return { cor, tamanho, quantidade: Number(qtd) || 0 };
            })
            .filter((i) => i.quantidade > 0),
        })).filter((d) => d.itens.length > 0),
      };
      const r = await api.post(`${ROTA}/movimentos`, corpo);
      setResultado(r);
      setDestinos([destinoVazio()]);
      setPrecos({});
      setOrigem('');
      await carregarOrdem(ordemId);
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><ArrowLeftRight size={22} /> Gerar movimentação</h1>
          <p className="ink-soft">
            Tira a peça de uma etapa e põe em outra — em vários destinos de uma vez, como
            na fábrica. O saldo da origem é conferido antes de gravar, e cada remessa para
            fora gera a Ordem de Serviço da facção.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={() => { carregarApoio(); carregarOrdem(ordemId); }} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <div className="filtros-linha">
        <Select
          value={ordemId}
          placeholder="Escolha a ordem de produção"
          chaveRecentes="mov_producao_ordem"
          onChange={(e) => {
            setOrdemId(e.target.value);
            setOrigem('');
            setDestinos([destinoVazio()]);
            setPrecos({});
            setResultado(null);
          }}
        >
          {ordens.map((o) => (
            <option key={o.id} value={o.id}>
              OP {o.numero} · {o.referencia} — {o.produto_descricao}
            </option>
          ))}
        </Select>
        <Field label="Data do movimento">
          <DateInput value={data} onChange={(e) => setData(e.target.value)} />
        </Field>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}

      {resultado && (
        <div className="card">
          <p className="sucesso-inline">
            <Check size={14} />
            {formatQtd(resultado.movimentos.length)} movimento(s) gravado(s)
            {resultado.ordensServico.length > 0
              ? ` e ${formatQtd(resultado.ordensServico.length)} ordem(ns) de serviço criada(s): ${resultado.ordensServico.map((os) => `O.S. ${os.numero}`).join(', ')}.`
              : '.'}
          </p>
          {resultado.avisos.map((a, i) => (
            <p key={i} className="aviso-inline"><AlertTriangle size={14} /> {a}</p>
          ))}
        </div>
      )}

      {carregando && <Skeleton height={220} />}

      {!carregando && !ordemId && (
        <EstadoVazio
          Icone={Factory}
          titulo="Escolha uma ordem de produção"
          descricao="A movimentação sempre acontece dentro de uma ordem: é ela que diz quais peças existem, em qual grade, e onde cada uma está agora. Ordens canceladas e concluídas não aparecem na lista porque não movimentam."
        />
      )}

      {ordemId && carregandoOrdem && <Skeleton height={280} />}

      {ordemId && !carregandoOrdem && (
        <>
          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Peças dentro do fluxo"
              valor={formatQtd(posicao?.total_em_producao || 0)}
              Icone={Layers}
              explicacao="Somando todas as etapas desta ordem. É o que ainda está no meio do caminho — não inclui o que já saiu para o estoque."
            />
            <IndicadorDestaque
              rotulo="Peças nesta movimentação"
              valor={formatQtd(totalPecas)}
              explicacao="A soma de todos os destinos que você preencheu abaixo."
            />
            <IndicadorDestaque
              rotulo="Custo de serviço desta operação"
              valor={custo.semPreco > 0
                ? (custo.total > 0 ? `${brl(custo.total)} (incompleto)` : 'não dá para dizer')
                : brl(custo.total)}
              tom={custo.semPreco > 0 ? 'atencao' : undefined}
              explicacao={custo.semPreco > 0
                ? `${custo.semPreco} destino(s) externo(s) sem preço cadastrado ficaram de FORA desta soma. Fora não é zero — cadastre o preço da facção para a conta fechar.`
                : 'O que as facções vão cobrar por esta remessa, pelo preço vigente de cada uma. Só destino externo custa serviço.'}
            />
          </div>

          <div className="grid-2">
            {/* ---------------- ORIGEM ---------------- */}
            <div className="card">
              <h2 className="card-titulo"><Layers size={16} /> Origem — de onde a peça sai</h2>

              {origens.length === 0 && (
                <EstadoVazio
                  Icone={Layers}
                  titulo="Nenhuma peça em etapa nenhuma"
                  descricao="Esta ordem ainda não tem peça no fluxo. O primeiro movimento é a entrada: escolha 'entrada no fluxo' abaixo e a grade planejada da ordem aparece para digitar."
                />
              )}

              {origens.length > 0 && (
                <div className="tabela-rolagem">
                  <table className="tabela-nota">
                    <thead>
                      <tr><th>Etapa</th><th>Facção</th><th className="num">Peças aqui</th></tr>
                    </thead>
                    <tbody>
                      {origens.map((o) => (
                        <tr
                          key={o.chave}
                          className={`linha-clicavel${o.chave === origem ? ' linha-nova' : ''}`}
                          onClick={() => { setOrigem(o.chave); setDestinos([destinoVazio()]); setPrecos({}); }}
                        >
                          <td>{o.etapa_nome}</td>
                          <td>{o.fornecedor_nome || 'interna'}</td>
                          <td className="num">{formatQtd(o.pecas)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <Field label="Tirar de" hint="A posição atual da ordem, etapa por etapa.">
                <Select
                  value={origem}
                  placeholder="Escolha a origem"
                  onChange={(e) => { setOrigem(e.target.value); setDestinos([destinoVazio()]); setPrecos({}); }}
                >
                  <option value="entrada">Entrada no fluxo — a peça ainda não está em etapa nenhuma</option>
                  {origens.map((o) => (
                    <option key={o.chave} value={o.chave}>
                      {o.etapa_nome}{o.fornecedor_nome ? ` · ${o.fornecedor_nome}` : ''} — {formatQtd(o.pecas)} peça(s)
                    </option>
                  ))}
                </Select>
              </Field>

              {entradaNoFluxo && (
                <p className="ink-soft ajuda-bloco">
                  <Info size={14} /> A peça está entrando no fluxo agora: não há saldo a conferir,
                  e a grade abaixo é a planejada da ordem.
                </p>
              )}

              {(entradaNoFluxo || origemEscolhida) && (
                <>
                  <h3 className="card-titulo">Saldo por cor e tamanho</h3>
                  {linhasGrade.length === 0 ? (
                    <p className="aviso-inline">
                      <AlertTriangle size={14} /> Esta ordem não tem grade cadastrada, então não há
                      cor e tamanho para movimentar.
                    </p>
                  ) : (
                    <div className="tabela-rolagem">
                      <table className="tabela-nota">
                        <thead>
                          <tr><th>Cor</th><th>Tamanho</th><th className="num">Disponível</th><th className="num">Vai sair</th></tr>
                        </thead>
                        <tbody>
                          {linhasGrade.map((l) => {
                            const chave = chaveGrade(l.cor, l.tamanho);
                            const pedido = pedidoPorLinha.get(chave) || 0;
                            const passou = l.disponivel != null && pedido > l.disponivel;
                            return (
                              <tr key={chave} className={passou ? 'linha-prejuizo' : undefined}>
                                <td>{l.cor || '—'}</td>
                                <td>{l.tamanho || '—'}</td>
                                <td className="num">{l.disponivel == null ? '—' : formatQtd(l.disponivel)}</td>
                                <td className={`num ${passou ? 'ink-prejuizo' : ''}`}>{formatQtd(pedido)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ---------------- DESTINO ---------------- */}
            <div className="card mov-coluna">
              <h2 className="card-titulo"><Truck size={16} /> Destino — para onde ela vai</h2>
              <p className="ink-soft ajuda-bloco">
                Uma movimentação pode ter vários destinos: metade da grade para uma facção e
                metade para outra sai num ato só, e o saldo da origem é conferido contra a
                SOMA de todos — não destino por destino.
              </p>

              {!origem && (
                <EstadoVazio
                  Icone={Truck}
                  titulo="Escolha primeiro a origem"
                  descricao="Sem saber de onde a peça sai não há grade para digitar nem saldo para conferir."
                />
              )}

              {origem && destinos.map((d, i) => (
                <CartaoDestino
                  key={d.uid}
                  destino={d}
                  indice={i}
                  total={destinos.length}
                  etapas={etapas}
                  fornecedores={fornecedores}
                  motivos={motivos}
                  linhasGrade={linhasGrade}
                  produtoId={ordemEscolhida?.produto_id}
                  data={data}
                  onPreco={registrarPreco}
                  onNovaFaccao={() => setNovaFaccao(true)}
                  onAlterar={(mudanca) => alterarDestino(d.uid, mudanca)}
                  onRemover={() => setDestinos((atual) => atual.filter((x) => x.uid !== d.uid))}
                />
              ))}

              {origem && (
                <div className="painel-acoes-inline">
                  <button type="button" className="btn-sec" onClick={() => setDestinos((a) => [...a, destinoVazio()])}>
                    <Plus size={15} /> Adicionar destino
                  </button>
                </div>
              )}
            </div>
          </div>

          {excessos.length > 0 && (
            <div className="bloco-alerta">
              <p><AlertTriangle size={15} /> <strong>Está saindo mais do que existe na origem.</strong></p>
              <ul>
                {excessos.map((x) => (
                  <li key={x.chave}>
                    {x.rotulo}: a origem tem {formatQtd(x.tem)} e os destinos somam {formatQtd(x.qtd)}.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {faltaExterno && (
            <p className="aviso-inline">
              <AlertTriangle size={14} /> Há destino em etapa externa sem facção ou sem previsão de
              retorno. Os dois são obrigatórios: sem facção não se sabe quem está com a peça, e sem
              prazo prometido não existe atraso para medir.
            </p>
          )}
          {faltaMotivo && (
            <p className="aviso-inline">
              <AlertTriangle size={14} /> Há reprocesso sem motivo. O motivo é o que permite saber
              depois qual etapa causou o defeito.
            </p>
          )}

          <div className="painel-acoes-inline">
            <button type="button" className="btn" disabled={!podeGravar} onClick={gravar}>
              <Check size={15} /> Gravar movimentação
            </button>
            <span className="ink-soft">
              {totalPecas > 0
                ? `${formatQtd(totalPecas)} peça(s) em ${formatQtd(destinos.length)} destino(s).`
                : 'Digite a quantidade de pelo menos uma linha da grade.'}
            </span>
          </div>

          <div className="card">
            <h2 className="card-titulo"><ClipboardList size={16} /> Extrato desta ordem</h2>
            <p className="ink-soft ajuda-bloco">
              Todo movimento fica aqui, inclusive o que foi desfeito: estornar cria um movimento
              novo de pontas invertidas em vez de apagar o original. É isso que responde "quem tirou
              200 peças do corte na sexta".
            </p>
            <Extrato
              movimentos={movimentos}
              onEstornado={() => carregarOrdem(ordemId)}
              onErro={setErro}
            />
          </div>

          {posicao?.posicao?.length > 0 && (
            <div className="card">
              <h2 className="card-titulo"><Layers size={16} /> Posição completa por etapa e grade</h2>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr><th>Etapa</th><th>Facção</th><th>Cor</th><th>Tamanho</th><th className="num">Peças</th></tr>
                  </thead>
                  <tbody>
                    {posicao.posicao.map((r) => (
                      <tr key={`${r.etapa_id}-${r.fornecedor_id}-${r.cor}-${r.tamanho}`}>
                        <td>{r.etapa_nome || 'sem etapa'}</td>
                        <td>{r.fornecedor_nome || 'interna'}</td>
                        <td>{r.cor || '—'}</td>
                        <td>{r.tamanho || '—'}</td>
                        <td className={`num ${Number(r.quantidade) < 0 ? 'ink-prejuizo' : ''}`}>
                          {numeroBr(r.quantidade, 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {novaFaccao && (
        <NovaFaccaoModal
          compacto
          onFechar={() => setNovaFaccao(false)}
          onSalva={(f) => {
            setNovaFaccao(false);
            // Entra na lista na hora e já fica escolhida no destino que está
            // sem facção — que é o motivo de ter aberto o cadastro.
            setFornecedores((atual) => [...atual, f].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));
            setDestinos((atual) => {
              const alvo = atual.find((d) => !d.fornecedor_destino_id);
              if (!alvo) return atual;
              return atual.map((d) => (d.uid === alvo.uid ? { ...d, fornecedor_destino_id: String(f.id) } : d));
            });
          }}
        />
      )}
    </div>
  );
}
