import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Factory, RefreshCw, Plus, AlertTriangle, Check, Truck, Timer,
  Scissors, ClipboardList, X, ArrowLeftRight, Package, Info, Layers,
  Building2, LayoutGrid, List, CalendarDays, Wallet,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, CampoBusca, IndicadorDestaque,
  Paginacao, NumInput, Field, Checkbox, DateInput,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import NovaOrdemProducao from '../components/NovaOrdemProducao';
import ProducaoKanban from '../components/ProducaoKanban';
import FaccoesAba from '../components/FaccoesAba';
import NovaFaccaoModal from '../components/NovaFaccaoModal';
import { useTabela } from '../lib/useTabela';
import { brl, pct, formatQtd, numeroBr, dataBr } from '../lib/format';

// Estoque › Produção.
//
// A ordem de produção que o Hub não tinha, com as duas coisas que o Wik não
// faz (levantamento de 06/09/2026):
//
//   1. CONSUMO POR TAMANHO — lá o consumo é da grade inteira, então o GG sai
//      pelo mesmo custo do P por construção. Aqui, quando o detalhe existe,
//      ele manda, e a tela diz de onde veio cada número.
//   2. CUSTO REAL DA ORDEM — o que de fato foi gasto (material reservado pelo
//      custo do dia + mão de obra apontada), COMPARADO com o custo padrão
//      congelado na abertura.
//
// REGRA 1: esta tela LÊ o custo padrão do snapshot da ordem. Ela não
// recalcula preço, margem nem markup, e o custo real não realimenta nada —
// quem decide corrigir a ficha é uma pessoa.
//
// REGRA 2: o que não dá para calcular aparece escrito. Ficha sem insumo
// vinculado, tamanho sem consumo, insumo sem custo — os três viram pendência
// na prévia, e nenhum deles vira zero.

const SITUACAO = {
  rascunho: { rotulo: 'Rascunho', tom: 'tone-neutro' },
  planejada: { rotulo: 'Planejada', tom: 'tone-elevada' },
  em_producao: { rotulo: 'Em produção', tom: 'tone-atencao' },
  concluida: { rotulo: 'Concluída', tom: 'tone-saudavel' },
  cancelada: { rotulo: 'Cancelada', tom: 'tone-prejuizo' },
};

const ORIGEM_CONSUMO = {
  por_tamanho: { rotulo: 'por tamanho', tom: 'tone-saudavel', ajuda: 'A necessidade deste insumo saiu do consumo cadastrado para cada tamanho. É a conta certa: o GG come mais malha que o P.' },
  unico: { rotulo: 'valor único', tom: 'tone-atencao', ajuda: 'A necessidade saiu do consumo geral da ficha, igual para todos os tamanhos. Enquanto for assim, o P subsidia o GG e o custo por tamanho é uniforme por construção — não porque a realidade seja uniforme.' },
};

function SeloSituacao({ situacao }) {
  const s = SITUACAO[situacao] || { rotulo: situacao, tom: 'tone-neutro' };
  return <span className={`selo ${s.tom}`}>{s.rotulo}</span>;
}


// ---------------------------------------------------------------------------
// Detalhe da ordem: insumos, apontamentos, custo real x padrão
// ---------------------------------------------------------------------------
function DetalheOrdem({ ordemId, fornecedores, insumos: catalogoInsumos = [], onFechar, onAbrirOutra, onMudou }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState(null);
  const [operacoes, setOperacoes] = useState([]);
  const [datas, setDatas] = useState({ data_inicio: '', data_prevista: '' });
  const [novoInsumo, setNovoInsumo] = useState({ insumo_id: '', quantidade: '', custo_unitario: '' });
  const [apontamento, setApontamento] = useState({
    operacao_id: '', cor: '', tamanho: '', quantidade: '', quantidade_refugo: '',
    valor_por_peca: '', conta_como_produzida: false,
  });

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await api.get(`/producao/ordens/${ordemId}`);
      setDados(r);
      setDatas({
        data_inicio: (r.ordem.data_inicio || '').slice(0, 10),
        data_prevista: (r.ordem.data_prevista || '').slice(0, 10),
      });
      const ops = await api.get(`/producao/operacoes/${r.ordem.produto_id}`).catch(() => ({ operacoes: [] }));
      setOperacoes(ops.operacoes || []);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [ordemId]);

  useEffect(() => { carregar(); }, [carregar]);

  async function acao(caminho, corpo, mensagemOk) {
    setErro('');
    setAviso(null);
    try {
      const r = await api.post(`/producao/ordens/${ordemId}/${caminho}`, { confirmar: true, ...corpo });
      setAviso({ tipo: 'ok', texto: mensagemOk, detalhe: r });
      await carregar();
      onMudou();
    } catch (e) {
      setErro(e.message);
    }
  }

  if (carregando) return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel"><div className="anuncio-painel painel-largo"><Skeleton height={320} /></div></div>
  );
  if (!dados) return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel"><div className="anuncio-painel"><p className="erro-inline">{erro}</p>
      <button type="button" className="btn-sec" onClick={onFechar}>Fechar</button></div></div>
  );

  const { ordem, grade, insumos, apontamentos, faccao, custoReal, comparacao, filhas = [] } = dados;
  const podeMexer = !['concluida', 'cancelada'].includes(ordem.situacao);
  const ehKit = ordem.tipo === 'kit';

  async function salvarDatas() {
    setErro(''); setAviso(null);
    try {
      const r = await api.put(`/producao/ordens/${ordemId}`, datas);
      setAviso({
        tipo: 'ok',
        texto: r.calendario?.acao === 'criado' ? 'Datas salvas e ordem colocada no calendário.'
          : r.calendario?.acao === 'atualizado' ? 'Datas salvas — o calendário acompanhou.'
            : `Datas salvas. ${r.calendario?.motivo || ''}`,
      });
      await carregar();
      onMudou();
    } catch (e) { setErro(e.message); }
  }

  return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel" role="dialog" aria-modal="true">
      <div className="anuncio-painel painel-largo">
        <header className="anuncio-painel-topo">
          <h2>
            {ehKit ? <Layers size={18} /> : <Factory size={18} />}
            OP {ordem.numero} · {ehKit ? (ordem.nome || ordem.kit_nome || 'Kit') : ordem.referencia}
            <SeloSituacao situacao={ordem.situacao} />
            {ordem.evento_calendario_id && (
              <span className="selo tone-neutro" title="Esta ordem tem evento no calendário, com a data de início e a de chegada.">
                <CalendarDays size={12} /> no calendário
              </span>
            )}
          </h2>
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </header>

        <div className="anuncio-painel-corpo">
          <p className="ink-soft">{ehKit ? `${filhas.length} referência(s)` : ordem.produto_descricao}</p>

          {/* ---- Datas: são elas que colocam a ordem no calendário ---- */}
          <div className="form-linha">
            <Field label="Início">
              <DateInput value={datas.data_inicio} onChange={(e) => setDatas((d) => ({ ...d, data_inicio: e.target.value }))} />
            </Field>
            <Field label="Chegada prevista" hint="Sem ela a ordem não entra no calendário e não tem como atrasar.">
              <DateInput value={datas.data_prevista} onChange={(e) => setDatas((d) => ({ ...d, data_prevista: e.target.value }))} />
            </Field>
            <Field label=" ">
              <button
                type="button" className="btn-sec"
                disabled={datas.data_inicio === (ordem.data_inicio || '').slice(0, 10)
                  && datas.data_prevista === (ordem.data_prevista || '').slice(0, 10)}
                onClick={salvarDatas}
              ><CalendarDays size={15} /> Salvar datas</button>
            </Field>
          </div>

          {/* ---- As referências de um kit ---- */}
          {ehKit && (
            <>
              <h3 className="card-titulo"><Layers size={16} /> Referências deste kit</h3>
              <p className="ink-soft ajuda-bloco">
                Cada uma é uma ordem de produção completa — com roteiro, material, movimentação e
                ordem de serviço. Esta ordem existe para responder se o kit está pronto; quem entra
                no estoque é sempre a referência.
              </p>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr><th className="num">OP</th><th>Referência</th><th>Situação</th><th className="num">Planejadas</th><th className="num">Produzidas</th><th className="num">2ª</th></tr>
                  </thead>
                  <tbody>
                    {filhas.map((f) => (
                      <tr key={f.id} className="linha-clicavel" onClick={() => onAbrirOutra?.(f.id)}>
                        <td className="num">{f.numero}</td>
                        <td>{f.referencia}<span className="ink-soft"> · {f.produto_descricao}</span></td>
                        <td><SeloSituacao situacao={f.situacao} /></td>
                        <td className="num">{formatQtd(f.quantidade_planejada)}</td>
                        <td className="num">{formatQtd(f.quantidade_produzida)}</td>
                        <td className="num">{formatQtd(f.quantidade_segunda)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ---- Custo real x padrão: o número que o Wik não dá ---- */}
          <div className="indicadores-linha">
            <IndicadorDestaque rotulo="Planejadas" valor={formatQtd(ordem.quantidade_planejada)} />
            <IndicadorDestaque rotulo="Produzidas" valor={formatQtd(ordem.quantidade_produzida)} />
            <IndicadorDestaque
              rotulo="Custo padrão / peça"
              valor={ordem.custo_padrao_unitario != null ? brl(ordem.custo_padrao_unitario) : '—'}
              explicacao="Congelado na abertura da ordem, direto do motor de cálculo. Não muda depois — é o retrato contra o qual o real é comparado."
            />
            <IndicadorDestaque
              rotulo="Custo real / peça"
              valor={custoReal.custoUnitarioReal != null ? brl(custoReal.custoUnitarioReal) : 'ainda não dá'}
              tom={comparacao?.acimaDoPadrao ? 'prejuizo' : (custoReal.completo ? 'saudavel' : 'atencao')}
              variacao={comparacao?.diferencaPct != null ? pct(comparacao.diferencaPct, 1) : undefined}
              explicacao={custoReal.completo
                ? 'Material reservado pelo custo do dia da reserva, mais a mão de obra apontada.'
                : 'Incompleto: há insumo sem custo ou operação sem valor apontado. O que falta não entrou como zero.'}
            />
          </div>

          {comparacao?.acimaDoPadrao && (
            <p className="aviso-inline"><AlertTriangle size={14} /> O custo real desta ordem está{' '}
              <strong>{pct(comparacao.diferencaPct, 1)}</strong> acima do padrão da ficha. A ficha continua
              como está: corrigir o cadastro é decisão de quem cuida do produto, não desta tela.
            </p>
          )}
          {!custoReal.completo && (
            <p className="aviso-inline"><Info size={14} /> {
              custoReal.semCusto.length > 0
                ? `Custo real incompleto: ${custoReal.semCusto.map((c) => `${c.nome} (${c.motivo})`).join('; ')}. O que falta ficou de FORA da soma — não entrou como zero.`
                : 'Nenhuma peça boa apontada ainda, então não há custo por peça para mostrar.'
            }</p>
          )}

          {erro && <p className="erro-inline">{erro}</p>}
          {aviso?.tipo === 'ok' && <p className="sucesso-inline"><Check size={14} /> {aviso.texto}</p>}
          {aviso?.detalhe?.parciais?.length > 0 && (
            <div className="bloco-alerta">
              <p><AlertTriangle size={15} /> Faltou material para reservar tudo:</p>
              <ul>
                {aviso.detalhe.parciais.map((p, i) => (
                  <li key={i}>{p.insumo}: faltaram {numeroBr(p.faltando, 3)} (saldo {numeroBr(p.saldo, 3)})</li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- Grade ---- */}
          <h3 className="card-titulo"><Layers size={16} /> Grade</h3>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th>Cor</th><th>Tamanho</th><th className="num">Planejadas</th><th className="num">Produzidas</th><th className="num">2ª qualidade</th></tr>
              </thead>
              <tbody>
                {grade.map((g) => (
                  <tr key={g.id}>
                    <td>{g.cor || '—'}</td><td>{g.tamanho || '—'}</td>
                    <td className="num">{formatQtd(g.quantidade_planejada)}</td>
                    <td className="num">{formatQtd(g.quantidade_produzida)}</td>
                    <td className="num">{formatQtd(g.quantidade_segunda)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---- Insumos ---- */}
          <h3 className="card-titulo"><Package size={16} /> Material</h3>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Insumo</th><th>Origem</th><th className="num">Necessário</th>
                  <th className="num">Reservado</th><th className="num">Saldo próprio</th><th className="num">Custo</th><th />
                </tr>
              </thead>
              <tbody>
                {insumos.map((i) => {
                  const origem = ORIGEM_CONSUMO[i.origem_consumo];
                  const falta = Number(i.quantidade_necessaria) - Number(i.quantidade_reservada);
                  const manual = i.origem_lancamento === 'manual';
                  return (
                    <tr key={i.id}>
                      <td>
                        {i.insumo_nome}
                        {manual && <span className="selo tone-elevada" title="Lançado à mão nesta ordem: não veio da ficha técnica.">à mão</span>}
                      </td>
                      <td>{origem ? <span className={`selo ${origem.tom}`} title={origem.ajuda}>{origem.rotulo}</span> : '—'}</td>
                      <td className="num">{numeroBr(i.quantidade_necessaria, 3)} {i.unidade}</td>
                      <td className={`num ${falta > 0.0001 ? 'ink-atencao' : ''}`}>{numeroBr(i.quantidade_reservada, 3)}</td>
                      <td className="num">{numeroBr(i.saldo_disponivel, 3)}</td>
                      <td className="num">
                        {i.custo_unitario == null
                          ? <span className="selo tone-atencao" title="Sem custo conhecido na abertura da ordem.">sem custo</span>
                          : brl(i.custo_unitario)}
                      </td>
                      <td>
                        {podeMexer && Number(i.quantidade_reservada) === 0 && Number(i.quantidade_consumida) === 0 && (
                          <button
                            type="button" className="btn-icone" aria-label={`Tirar ${i.insumo_nome} da ordem`}
                            title="Tira o insumo desta ordem. Só é possível enquanto nada foi reservado."
                            onClick={async () => {
                              setErro(''); setAviso(null);
                              try {
                                await api.del(`/producao/ordens/${ordemId}/insumos/${i.id}`);
                                await carregar(); onMudou();
                              } catch (e) { setErro(e.message); }
                            }}
                          ><X size={15} /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ---- Lançar o material que foi de fato gasto ---- */}
          {podeMexer && (
            <>
              <div className="form-linha">
                <Field label="Acrescentar ou corrigir insumo gasto" hint="Insumo que a ficha já previa tem a quantidade substituída, não somada.">
                  <Select
                    value={novoInsumo.insumo_id}
                    placeholder="Escolha o insumo"
                    onChange={(e) => setNovoInsumo((n) => ({ ...n, insumo_id: e.target.value }))}
                  >
                    {catalogoInsumos.map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
                  </Select>
                </Field>
                <Field label="Quantidade">
                  <NumInput step="0.001" value={novoInsumo.quantidade} onChange={(v) => setNovoInsumo((n) => ({ ...n, quantidade: v }))} />
                </Field>
                <Field label="Custo unitário" hint="Em branco usa o custo cadastrado do insumo.">
                  <NumInput value={novoInsumo.custo_unitario} onChange={(v) => setNovoInsumo((n) => ({ ...n, custo_unitario: v }))} />
                </Field>
              </div>
              <div className="painel-acoes-inline">
                <button
                  type="button" className="btn-sec"
                  disabled={!novoInsumo.insumo_id || !(Number(novoInsumo.quantidade) > 0)}
                  onClick={async () => {
                    setErro(''); setAviso(null);
                    try {
                      const r = await api.post(`/producao/ordens/${ordemId}/insumos`, {
                        insumo_id: Number(novoInsumo.insumo_id),
                        quantidade: Number(novoInsumo.quantidade),
                        custo_unitario: novoInsumo.custo_unitario === '' ? null : Number(novoInsumo.custo_unitario),
                      });
                      setNovoInsumo({ insumo_id: '', quantidade: '', custo_unitario: '' });
                      if (r.aviso) setAviso({ tipo: 'ok', texto: r.aviso });
                      await carregar(); onMudou();
                    } catch (e) { setErro(e.message); }
                  }}
                ><Plus size={15} /> Lançar material gasto</button>
                <span className="ink-soft">
                  Corrigir a quantidade aqui muda o custo real da ordem e <strong>não</strong> mexe no que
                  já foi reservado — reserva é movimento de estoque.
                </span>
              </div>
            </>
          )}

          {/* ---- O ato humano que a REGRA 1 exige ---- */}
          {comparacao?.diferencaPct != null && (
            <div className="painel-acoes-inline">
              <button
                type="button" className="btn-sec"
                title="Copia o custo apurado nesta ordem para a ficha técnica da referência. Altera o custo e o preço sugerido de toda venda futura dela."
                onClick={async () => {
                  if (!(await confirmar(
                    `Levar o custo apurado nesta ordem para a ficha de ${ordem.referencia}?\n\n`
                    + 'Isto altera a ficha técnica: o custo e o preço sugerido de toda venda futura desta '
                    + 'referência passam a sair daqui. As vendas já feitas continuam com o custo que tinham, '
                    + 'e cada alteração fica registrada com quem fez e quando.',
                    { titulo: 'Atualizar a ficha do produto', confirmarTexto: 'Atualizar a ficha' }
                  ))) return;
                  setErro(''); setAviso(null);
                  try {
                    const r = await api.post(`/producao/ordens/${ordemId}/aplicar-custo-na-ficha`, { confirmar: true });
                    setAviso({
                      tipo: 'ok',
                      texto: `${r.aplicadas.length} linha(s) da ficha atualizada(s).`
                        + (r.ignoradas.length ? ` ${r.ignoradas.length} ficaram de fora: ${r.ignoradas.map((x) => `${x.insumo} — ${x.motivo}`).join('; ')}` : ''),
                    });
                    await carregar(); onMudou();
                  } catch (e) { setErro(e.message); }
                }}
              ><Wallet size={15} /> Levar este custo para a ficha do produto</button>
              <span className="ink-soft">
                O custo real não realimenta o cadastro sozinho: uma ordem ruim não pode reescrever o
                preço da referência inteira. Quem decide é você, e fica registrado.
              </span>
            </div>
          )}

          {/* ---- Apontamento ---- */}
          {podeMexer && (
            <>
              <h3 className="card-titulo"><ClipboardList size={16} /> Apontar produção</h3>
              <div className="form-linha">
                <Field label="Operação">
                  <Select
                    value={apontamento.operacao_id}
                    onChange={(e) => setApontamento((a) => ({ ...a, operacao_id: e.target.value }))}
                    placeholder="Sem roteiro"
                  >
                    {operacoes.map((o) => <option key={o.id} value={o.id}>{o.sequencia}. {o.nome}</option>)}
                  </Select>
                </Field>
                <Field label="Cor"><input className="input" value={apontamento.cor} onChange={(e) => setApontamento((a) => ({ ...a, cor: e.target.value }))} /></Field>
                <Field label="Tamanho"><input className="input" value={apontamento.tamanho} onChange={(e) => setApontamento((a) => ({ ...a, tamanho: e.target.value }))} /></Field>
                <Field label="Peças"><NumInput step="1" value={apontamento.quantidade} onChange={(v) => setApontamento((a) => ({ ...a, quantidade: v }))} /></Field>
                <Field label="2ª qualidade"><NumInput step="1" value={apontamento.quantidade_refugo} onChange={(v) => setApontamento((a) => ({ ...a, quantidade_refugo: v }))} /></Field>
                <Field label="R$ por peça" hint="Em branco usa o valor do roteiro.">
                  <NumInput value={apontamento.valor_por_peca} onChange={(v) => setApontamento((a) => ({ ...a, valor_por_peca: v }))} />
                </Field>
              </div>
              <label className="check-linha">
                <Checkbox
                  checked={apontamento.conta_como_produzida}
                  onChange={(e) => setApontamento((a) => ({ ...a, conta_como_produzida: e.target.checked }))}
                />
                Esta é a última operação: contar estas peças como prontas.
              </label>
              <p className="ink-soft ajuda-bloco">
                Marque só na ÚLTIMA operação do roteiro. A mesma peça passa pelo corte, pela
                costura e pelo acabamento — contar em todas somaria a peça três vezes. Quando
                marcado, a cor e o tamanho precisam ser de uma linha da grade, senão a peça
                subiria no total e não entraria no estoque na conclusão.
              </p>
              <div className="painel-acoes-inline">
                <button
                  type="button" className="btn-sec"
                  disabled={!(Number(apontamento.quantidade) > 0)}
                  onClick={async () => {
                    setErro(''); setAviso(null);
                    try {
                      await api.post(`/producao/ordens/${ordemId}/apontar`, {
                        ...apontamento,
                        operacao_id: apontamento.operacao_id ? Number(apontamento.operacao_id) : null,
                      });
                      setApontamento((a) => ({ ...a, quantidade: '', quantidade_refugo: '' }));
                      await carregar();
                      onMudou();
                    } catch (e) { setErro(e.message); }
                  }}
                ><Plus size={15} /> Lançar apontamento</button>
              </div>
            </>
          )}

          {apontamentos.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead>
                  <tr><th>Data</th><th>Operação</th><th>Cor / tamanho</th><th className="num">Peças</th><th className="num">2ª</th><th className="num">Valor</th><th>Quem</th></tr>
                </thead>
                <tbody>
                  {apontamentos.map((a) => (
                    <tr key={a.id}>
                      <td>{dataBr(a.data_apontamento)}</td>
                      <td>{a.operacao_nome || '—'}{a.fornecedor_nome ? ` · ${a.fornecedor_nome}` : ''}</td>
                      <td>{[a.cor, a.tamanho].filter(Boolean).join(' / ') || '—'}</td>
                      <td className="num">{formatQtd(a.quantidade)}</td>
                      <td className="num">{formatQtd(a.quantidade_refugo)}</td>
                      <td className="num">{a.valor_total != null ? brl(a.valor_total) : '—'}</td>
                      <td>{a.usuario_nome || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {faccao.length > 0 && (
            <>
              <h3 className="card-titulo"><Truck size={16} /> Facção</h3>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead><tr><th>Data</th><th>Facção</th><th>Tipo</th><th>O quê</th><th className="num">Qtd</th><th>Nota</th></tr></thead>
                  <tbody>
                    {faccao.map((m) => (
                      <tr key={m.id}>
                        <td>{dataBr(m.data_movimento)}</td>
                        <td>{m.fornecedor_nome}</td>
                        <td><span className={`selo ${m.tipo === 'remessa' ? 'tone-atencao' : 'tone-saudavel'}`}>{m.tipo}</span></td>
                        <td>{m.insumo_nome || [m.cor, m.tamanho].filter(Boolean).join(' / ') || '—'}</td>
                        <td className="num">{numeroBr(m.quantidade, 3)}</td>
                        <td>{m.nota_numero || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <footer className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Fechar</button>
          {podeMexer && (
            <button
              type="button" className="btn-sec"
              onClick={() => acao('reservar', {}, 'Material reservado.')}
            ><Package size={15} /> Reservar material</button>
          )}
          {podeMexer && (
            <button
              type="button" className="btn"
              disabled={!(Number(ordem.quantidade_produzida) > 0)}
              title={Number(ordem.quantidade_produzida) > 0 ? undefined : 'Nenhuma peça apontada como pronta ainda.'}
              onClick={() => acao('concluir', {}, 'Peças no estoque.')}
            ><Check size={15} /> Concluir e dar entrada no estoque</button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roteiro de operações e consumo por tamanho
// ---------------------------------------------------------------------------
function RoteiroEConsumo({ produtos, fornecedores }) {
  const [produtoId, setProdutoId] = useState('');
  const [roteiro, setRoteiro] = useState(null);
  const [consumo, setConsumo] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState('');
  const [salvo, setSalvo] = useState('');
  const [nova, setNova] = useState({ nome: '', setor: '', sequencia: '', tempo_segundos: '', valor_por_peca: '', fornecedor_id: '' });
  const [edicoes, setEdicoes] = useState({});

  const carregar = useCallback(async (id) => {
    if (!id) { setRoteiro(null); setConsumo(null); return; }
    setCarregando(true);
    setErro('');
    try {
      const [r, c] = await Promise.all([
        api.get(`/producao/operacoes/${id}`),
        api.get(`/producao/consumo-tamanho/${id}`),
      ]);
      setRoteiro(r);
      setConsumo(c);
      setEdicoes({});
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(produtoId); }, [produtoId, carregar]);

  const consumoAtual = useMemo(() => {
    const mapa = new Map();
    for (const c of consumo?.consumos || []) mapa.set(`${c.material_id}|${c.tamanho}`, c.consumo_por_peca);
    return mapa;
  }, [consumo]);

  async function salvarConsumo() {
    setErro(''); setSalvo('');
    try {
      const linhas = Object.entries(edicoes).map(([chave, valor]) => {
        const [materialId, tamanho] = chave.split('|');
        return { material_id: Number(materialId), tamanho, consumo_por_peca: valor };
      });
      if (linhas.length === 0) return;
      await api.post('/producao/consumo-tamanho', { linhas });
      setSalvo('Consumo por tamanho salvo. A partir de agora as ordens deste produto usam ele.');
      await carregar(produtoId);
    } catch (e) { setErro(e.message); }
  }

  return (
    <>
      <div className="filtros-linha">
        <Select value={produtoId} onChange={(e) => setProdutoId(e.target.value)} placeholder="Escolha a referência">
          {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
        </Select>
      </div>

      {!produtoId && (
        <EstadoVazio
          Icone={Timer}
          titulo="Escolha uma referência"
          descricao="O roteiro diz por quais operações a peça passa, quanto tempo leva em cada uma e quanto custa. Os dois números que saem daí — tempo padrão e mão de obra por peça — hoje não existem em lugar nenhum do sistema."
        />
      )}

      {carregando && <Skeleton height={220} />}
      {erro && <p className="erro-inline">{erro}</p>}
      {salvo && <p className="sucesso-inline"><Check size={14} /> {salvo}</p>}

      {!carregando && roteiro && (
        <>
          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Tempo padrão / peça"
              valor={roteiro.tempoPadrao.segundos != null
                ? `${numeroBr(roteiro.tempoPadrao.minutos, 1)} min${roteiro.tempoPadrao.incompleto ? ' (parcial)' : ''}`
                : 'não dá para dizer'}
              tom={roteiro.tempoPadrao.segundos == null || roteiro.tempoPadrao.incompleto ? 'atencao' : undefined}
              explicacao={roteiro.tempoPadrao.segundos == null
                ? roteiro.tempoPadrao.motivo + '. Sem tempo não há capacidade, e sem capacidade não há prazo confiável.'
                : roteiro.tempoPadrao.incompleto
                  ? `${roteiro.tempoPadrao.operacoesSemTempo} operação(ões) sem tempo cadastrado ficaram de fora desta soma. O total é um piso, não o tempo da peça.`
                  : 'Soma do tempo das operações do roteiro.'}
            />
            <IndicadorDestaque
              rotulo="Mão de obra / peça"
              valor={roteiro.custoMaoDeObra.valor != null
                ? `${brl(roteiro.custoMaoDeObra.valor)}${roteiro.custoMaoDeObra.incompleto ? ' (parcial)' : ''}`
                : 'não dá para dizer'}
              tom={roteiro.custoMaoDeObra.valor == null || roteiro.custoMaoDeObra.incompleto ? 'atencao' : undefined}
              explicacao={roteiro.custoMaoDeObra.valor == null
                ? roteiro.custoMaoDeObra.motivo
                : roteiro.custoMaoDeObra.incompleto
                  ? `${roteiro.custoMaoDeObra.operacoesSemValor} operação(ões) sem valor por peça ficaram de fora. O número é menor que a mão de obra real.`
                  : 'Soma do valor por peça de cada operação. É o que a facção cobra, operação por operação.'}
            />
            <IndicadorDestaque rotulo="Operações" valor={formatQtd(roteiro.operacoes.length)} />
          </div>

          <h3 className="card-titulo"><ClipboardList size={16} /> Roteiro</h3>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th className="num">#</th><th>Operação</th><th>Setor</th><th className="num">Tempo (s)</th><th className="num">R$/peça</th><th>Facção</th></tr>
              </thead>
              <tbody>
                {roteiro.operacoes.map((o) => (
                  <tr key={o.id}>
                    <td className="num">{o.sequencia}</td>
                    <td>{o.nome}</td>
                    <td>{o.setor || '—'}</td>
                    <td className="num">{o.tempo_segundos != null ? formatQtd(o.tempo_segundos) : <span className="selo tone-atencao">sem tempo</span>}</td>
                    <td className="num">{o.valor_por_peca != null ? brl(o.valor_por_peca) : <span className="selo tone-atencao">sem valor</span>}</td>
                    <td>{o.fornecedor_nome || (o.terceirizada ? 'terceirizada' : 'interna')}</td>
                  </tr>
                ))}
                <tr className="linha-nova">
                  <td className="num"><NumInput step="1" value={nova.sequencia} onChange={(v) => setNova((n) => ({ ...n, sequencia: v }))} /></td>
                  <td><input className="input" placeholder="Costura" value={nova.nome} onChange={(e) => setNova((n) => ({ ...n, nome: e.target.value }))} /></td>
                  <td><input className="input" placeholder="Setor" value={nova.setor} onChange={(e) => setNova((n) => ({ ...n, setor: e.target.value }))} /></td>
                  <td className="num"><NumInput step="1" value={nova.tempo_segundos} onChange={(v) => setNova((n) => ({ ...n, tempo_segundos: v }))} /></td>
                  <td className="num"><NumInput value={nova.valor_por_peca} onChange={(v) => setNova((n) => ({ ...n, valor_por_peca: v }))} /></td>
                  <td>
                    <Select value={nova.fornecedor_id} onChange={(e) => setNova((n) => ({ ...n, fornecedor_id: e.target.value }))} placeholder="Interna">
                      {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                    </Select>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="painel-acoes-inline">
            <button
              type="button" className="btn-sec" disabled={!nova.nome.trim()}
              onClick={async () => {
                setErro('');
                try {
                  await api.post('/producao/operacoes', {
                    produto_id: Number(produtoId),
                    ...nova,
                    sequencia: nova.sequencia === '' ? roteiro.operacoes.length + 1 : Number(nova.sequencia),
                    fornecedor_id: nova.fornecedor_id ? Number(nova.fornecedor_id) : null,
                    terceirizada: Boolean(nova.fornecedor_id),
                  });
                  setNova({ nome: '', setor: '', sequencia: '', tempo_segundos: '', valor_por_peca: '', fornecedor_id: '' });
                  await carregar(produtoId);
                } catch (e) { setErro(e.message); }
              }}
            ><Plus size={15} /> Adicionar operação</button>
          </div>

          {/* ---- Consumo por tamanho ---- */}
          <h3 className="card-titulo"><Scissors size={16} /> Consumo por tamanho</h3>
          <p className="ink-soft ajuda-bloco">{consumo?.aviso}</p>

          {(consumo?.tamanhos || []).length === 0 && (
            <p className="aviso-inline"><Info size={14} /> Esta referência não tem tamanhos cadastrados no estoque, então não há por onde detalhar o consumo.</p>
          )}

          {(consumo?.tamanhos || []).length > 0 && (
            <>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th>Material</th><th className="num">Ficha (geral)</th>
                      {consumo.tamanhos.map((t) => <th key={t} className="num">{t}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {consumo.materiais.map((m) => (
                      <tr key={m.id}>
                        <td>
                          {m.material}
                          {!m.insumo_nome && (
                            <span className="selo tone-prejuizo" title="Esta linha da ficha não está vinculada a nenhum insumo cadastrado. Ela não vai ser reservada nem custeada em ordem nenhuma.">sem insumo</span>
                          )}
                        </td>
                        <td className="num">{m.consumo_por_peca != null ? numeroBr(m.consumo_por_peca, 4) : <span className="selo tone-atencao">sem consumo</span>}</td>
                        {consumo.tamanhos.map((t) => {
                          const chave = `${m.id}|${t}`;
                          const valor = edicoes[chave] !== undefined ? edicoes[chave] : (consumoAtual.get(chave) ?? '');
                          return (
                            <td key={t} className="num">
                              <NumInput
                                step="0.0001" value={valor}
                                onChange={(v) => setEdicoes((e) => ({ ...e, [chave]: v }))}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="painel-acoes-inline">
                <button type="button" className="btn" disabled={Object.keys(edicoes).length === 0} onClick={salvarConsumo}>
                  <Check size={15} /> Salvar consumo por tamanho
                </button>
                <span className="ink-soft">Célula vazia volta a usar o consumo geral da ficha — que é diferente de consumo zero.</span>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Facção: saldos e movimentos
// ---------------------------------------------------------------------------
function Faccao({ fornecedores, insumos, onMudou }) {
  const [saldos, setSaldos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [mov, setMov] = useState({
    fornecedor_id: '', item: 'insumo', insumo_id: '', variante_id: '',
    buscaPeca: '', tipo: 'remessa', quantidade: '', nota_numero: '',
  });
  const [variantes, setVariantes] = useState([]);

  // Peça PRONTA que está na facção. Até 07/09 este número não existia: a
  // remessa de peça pronta era registrada mas não movia saldo nenhum, porque
  // o estoque não tinha lugar. A migration 0052 (08/09) deu o lugar, e agora
  // a mesma tela responde pelas duas coisas que saem daqui — o material e a
  // peça.
  const [pecas, setPecas] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [s, p] = await Promise.all([
        api.get('/producao/faccao/saldos'),
        api.get('/estoque-locais/faccao').catch(() => null),
      ]);
      setSaldos(s);
      setPecas(p);
    } catch (e) { setErro(e.message); }
    finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const total = useMemo(
    () => saldos.reduce((s, l) => s + (l.valor != null ? Number(l.valor) : 0), 0),
    [saldos]
  );
  const semCusto = saldos.filter((l) => l.valor == null).length;

  return (
    <>
      <div className="indicadores-linha">
        <IndicadorDestaque
          rotulo="Material em facção"
          valor={semCusto > 0 ? `${brl(total)} (incompleto)` : brl(total)}
          tom={semCusto > 0 ? 'atencao' : undefined}
          explicacao={semCusto > 0
            ? `${semCusto} item(ns) sem custo conhecido ficaram de fora deste total. Fora não é zero.`
            : 'Nosso material que está na mão de terceiro. Continua sendo estoque da empresa.'}
        />
        <IndicadorDestaque
          rotulo="Peça pronta em facção"
          valor={pecas ? `${formatQtd(pecas.resumo.pecas)} peça(s)` : '—'}
          tom={pecas && pecas.resumo.pecas > 0 ? 'atencao' : undefined}
          Icone={Truck}
          explicacao="Peça acabada que saiu daqui e continua sendo nossa. Conta no total do estoque e NÃO conta no disponível para venda."

        />
        <IndicadorDestaque rotulo="Facções com material" valor={formatQtd(new Set(saldos.map((s) => s.fornecedor_id)).size)} />
      </div>

      <h3 className="card-titulo"><ArrowLeftRight size={16} /> Lançar movimento</h3>
      <div className="form-linha">
        <Field label="Facção">
          <Select value={mov.fornecedor_id} onChange={(e) => setMov((m) => ({ ...m, fornecedor_id: e.target.value }))} placeholder="Escolha">
            {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </Select>
        </Field>
        <Field label="Tipo">
          <Select value={mov.tipo} onChange={(e) => setMov((m) => ({ ...m, tipo: e.target.value }))}>
            <option value="remessa">Remessa (sai daqui)</option>
            <option value="retorno">Retorno (volta pra cá)</option>
          </Select>
        </Field>
        <Field label="O que está indo">
          <Select
            value={mov.item}
            onChange={(e) => setMov((m) => ({ ...m, item: e.target.value, insumo_id: '', variante_id: '' }))}
          >
            <option value="insumo">Material (malha, aviamento)</option>
            <option value="peca">Peça pronta</option>
          </Select>
        </Field>
        {mov.item === 'insumo' ? (
          <Field label="Insumo">
            <Select value={mov.insumo_id} onChange={(e) => setMov((m) => ({ ...m, insumo_id: e.target.value }))} placeholder="Escolha">
              {insumos.map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Peça" hint="Digite a referência e escolha a cor/tamanho">
            <input
              className="input"
              value={mov.buscaPeca}
              onChange={(e) => setMov((m) => ({ ...m, buscaPeca: e.target.value }))}
              onKeyDown={async (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                try {
                  const r = await api.get(`/estoque-locais?busca=${encodeURIComponent(mov.buscaPeca)}`);
                  setVariantes(r.itens.slice(0, 200));
                } catch (err) { setErro(err.message); }
              }}
              placeholder="Referência e Enter"
            />
          </Field>
        )}
        {mov.item === 'peca' && variantes.length > 0 && (
          <Field label="Cor e tamanho">
            <Select value={mov.variante_id} onChange={(e) => setMov((m) => ({ ...m, variante_id: e.target.value }))} placeholder="Escolha">
              {variantes.map((v) => (
                <option key={v.varianteId} value={v.varianteId}>
                  {v.referencia} · {v.cor} · {v.tamanho} — {formatQtd(v.disponivel)} aqui
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Quantidade"><NumInput step={mov.item === 'peca' ? '1' : '0.001'} value={mov.quantidade} onChange={(v) => setMov((m) => ({ ...m, quantidade: v }))} /></Field>
        <Field label="Nota"><input className="input" value={mov.nota_numero} onChange={(e) => setMov((m) => ({ ...m, nota_numero: e.target.value }))} /></Field>
      </div>
      <div className="painel-acoes-inline">
        <button
          type="button" className="btn"
          disabled={!mov.fornecedor_id
            || !(mov.item === 'insumo' ? mov.insumo_id : mov.variante_id)
            || !(Number(mov.quantidade) > 0)}
          onClick={async () => {
            setErro(''); setAviso('');
            try {
              // O backend recusa insumo E variante juntos de propósito: um
              // movimento é de material OU de peça, nunca dos dois, e mandar
              // os dois faria o saldo mexer em dois lugares por um evento só.
              const r = await api.post('/producao/faccao/movimento', {
                fornecedor_id: Number(mov.fornecedor_id),
                tipo: mov.tipo,
                nota_numero: mov.nota_numero,
                insumo_id: mov.item === 'insumo' ? Number(mov.insumo_id) : null,
                variante_id: mov.item === 'peca' ? Number(mov.variante_id) : null,
                quantidade: Number(mov.quantidade),
              });
              setAviso(r.aviso || (mov.item === 'peca'
                ? 'Movimento lançado: a peça mudou de lugar. Ela continua no total do estoque e saiu do disponível para venda.'
                : 'Movimento lançado: o material mudou de lugar, não sumiu.'));
              setMov((m) => ({ ...m, quantidade: '', nota_numero: '' }));
              await carregar();
              onMudou();
            } catch (e) { setErro(e.message); }
          }}
        ><ArrowLeftRight size={15} /> Lançar</button>
      </div>
      {erro && <p className="erro-inline">{erro}</p>}
      {aviso && <p className="sucesso-inline"><Check size={14} /> {aviso}</p>}

      {carregando && <Skeleton height={180} />}
      {!carregando && saldos.length === 0 && (
        <EstadoVazio
          Icone={Truck}
          titulo="Nenhum material em facção"
          descricao="Quando a malha sai daqui para a oficina, ela some do saldo próprio e aparece aqui — em vez de simplesmente desaparecer do estoque, que é o que acontece hoje."
        />
      )}
      {!carregando && saldos.length > 0 && (
        <div className="tabela-rolagem">
          <table className="tabela-nota">
            <thead><tr><th>Facção</th><th>Insumo</th><th className="num">Quantidade</th><th className="num">Valor</th></tr></thead>
            <tbody>
              {saldos.map((s) => (
                <tr key={`${s.fornecedor_id}-${s.insumo_id}`}>
                  <td>{s.fornecedor_nome}</td>
                  <td>{s.insumo_nome}</td>
                  <td className="num">{numeroBr(s.quantidade, 3)} {s.unidade}</td>
                  <td className="num">{s.valor != null ? brl(s.valor) : <span className="selo tone-atencao">sem custo</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Onde está a produção — WIP por etapa
// ---------------------------------------------------------------------------
// O apontamento já existia; o que faltava era lê-lo como FLUXO. As peças
// "em espera" numa etapa são as que passaram por ela e ainda não foram
// apontadas na seguinte, descontado o refugo.
//
// Duas coisas ficam à vista porque são elas que fazem o número valer:
//   · apontamento que não casa com o roteiro NÃO some da conta — ele aparece
//     numa lista, e o resultado é marcado como não confiável enquanto existir;
//   · costurar mais peças do que se cortou é impossível, então o negativo
//     vira aviso, não vira zero calado.
function Wip() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [abertas, setAbertas] = useState({});

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try { setDados(await api.get('/producao/wip')); }
    catch (e) { setErro(e.message); }
    finally { setCarregando(false); }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  if (carregando) return <Skeleton height={260} />;
  if (erro) return <p className="erro-inline">{erro}</p>;
  if (!dados) return null;

  const r = dados.resumo;

  return (
    <>
      <p className="ink-soft ajuda-bloco"><Info size={14} /> {dados.explicacao}</p>

      <div className="indicadores-linha">
        <IndicadorDestaque
          rotulo="Peças dentro da fábrica"
          valor={formatQtd(r.emProcesso)}
          Icone={Factory}
          explicacao="Já começaram e ainda não terminaram. Não inclui o que nem foi cortado nem o que já está pronto esperando entrada."
        />
        <IndicadorDestaque
          rotulo="Prontas aguardando entrada"
          valor={formatQtd(r.aguardandoEntrada)}
          tom={r.aguardandoEntrada > 0 ? 'atencao' : undefined}
          explicacao="Passaram pela última etapa e ainda não foram lançadas no estoque. É isto que costuma explicar peça que 'sumiu'."
        />
        <IndicadorDestaque rotulo="Ainda não começaram" valor={formatQtd(r.naoIniciado)} />
        <IndicadorDestaque
          rotulo="Ordens atrasadas"
          valor={formatQtd(r.atrasadas)}
          tom={r.atrasadas > 0 ? 'prejuizo' : undefined}
          explicacao="Passaram da data prevista e ainda têm peça no meio do caminho."
        />
      </div>

      {(r.comApontamentoSolto > 0 || r.comInconsistencia > 0 || r.semRoteiro > 0) && (
        <p className="aviso-inline">
          <AlertTriangle size={14} />
          Os números acima estão incompletos:
          {r.semRoteiro > 0 && ` ${r.semRoteiro} ordem(ns) sem roteiro cadastrado (não há sequência para medir);`}
          {r.comApontamentoSolto > 0 && ` ${r.comApontamentoSolto} com apontamento fora do roteiro;`}
          {r.comInconsistencia > 0 && ` ${r.comInconsistencia} com apontamento que não fecha entre etapas.`}
        </p>
      )}

      {dados.etapas.length > 0 && (
        <div className="card">
          <h2 className="card-titulo"><Layers size={16} /> Fila por etapa, somando todas as ordens</h2>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th>Etapa</th><th>Setor</th><th className="num">Peças esperando</th><th className="num">Ordens</th><th className="num">Sem apontamento há</th></tr>
              </thead>
              <tbody>
                {dados.etapas.map((e) => (
                  <tr key={e.nome}>
                    <td><strong>{e.nome}</strong></td>
                    <td className="ink-soft">{e.setores.join(', ')}</td>
                    <td className="num">{formatQtd(e.pecas)}</td>
                    <td className="num">{formatQtd(e.ordens)}</td>
                    <td className={`num ${e.maisParadoDias > 14 ? 'ink-prejuizo' : ''}`}>
                      {e.maisParadoDias == null ? '—' : `${formatQtd(e.maisParadoDias)} dias`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dados.ordens.length === 0 && (
        <EstadoVazio Icone={Factory} titulo="Nenhuma ordem aberta" descricao="Sem ordem planejada ou em produção não há nada em processo." />
      )}

      {dados.ordens.map((o) => (
        <div className="card" key={o.ordem.id}>
          <div className="pagina-topo">
            <h2 className="card-titulo">
              OP {o.ordem.numero} · {o.ordem.referencia}
              {o.atrasada && <span className="selo tone-prejuizo">atrasada</span>}
              {!o.confiavel && <span className="selo tone-atencao">apontamento incompleto</span>}
            </h2>
            <span className="ink-soft">
              {o.etapaAtual
                ? `Parada em ${o.etapaAtual.nome} — ${formatQtd(o.etapaAtual.pecas)} peça(s)${o.etapaAtual.paradoHaDias != null ? `, sem apontamento há ${o.etapaAtual.paradoHaDias} dia(s)` : ''}`
                : 'Sem peça em espera no meio do roteiro'}
            </span>
          </div>

          {o.motivo && <p className="aviso-inline"><AlertTriangle size={14} /> {o.motivo}</p>}

          {o.etapas.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead>
                  <tr>
                    <th>#</th><th>Etapa</th><th className="num">Passaram</th><th className="num">Refugo</th>
                    <th className="num">Em espera</th><th className="num">Último apontamento</th>
                  </tr>
                </thead>
                <tbody>
                  {o.etapas.map((e) => (
                    <tr key={e.sequencia} className={e.saldoNegativo > 0 ? 'linha-pendente' : undefined}>
                      <td className="num">{e.sequencia}</td>
                      <td>
                        <strong>{e.nome}</strong>
                        {e.ehUltima && <span className="selo tone-neutro" title="O que está parado aqui é peça pronta esperando lançamento no estoque">última</span>}
                      </td>
                      <td className="num">{formatQtd(e.passaram)}</td>
                      <td className={`num ${e.refugo > 0 ? 'ink-atencao' : ''}`}>{formatQtd(e.refugo)}</td>
                      <td className="num"><strong>{formatQtd(e.emEspera)}</strong></td>
                      <td className="num ink-soft">
                        {e.paradoHaDias == null ? 'nunca' : `há ${formatQtd(e.paradoHaDias)} dia(s)`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {o.inconsistencias.length > 0 && (
            <div className="bloco-alerta">
              <p><AlertTriangle size={14} /> Apontamento que não fecha entre etapas</p>
              <ul>{o.inconsistencias.map((i) => <li key={`${i.de}-${i.para}`}>{i.texto}</li>)}</ul>
            </div>
          )}

          {o.foraDoRoteiro.length > 0 && (
            <>
              <button type="button" className="btn-sec" onClick={() => setAbertas((a) => ({ ...a, [o.ordem.id]: !a[o.ordem.id] }))}>
                <ClipboardList size={14} /> {o.foraDoRoteiro.length} apontamento(s) fora do roteiro
              </button>
              {abertas[o.ordem.id] && (
                <ul className="ink-soft ajuda-bloco">
                  {o.foraDoRoteiro.map((f, n) => (
                    <li key={`${f.operacao}-${n}`}>
                      {f.operacao}{f.quantidade != null ? ` — ${formatQtd(f.quantidade)} peça(s)` : ''}: {f.motivo}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
}

export default function ProducaoPage() {
  const [aba, setAba] = useState('ordens');
  const [ordens, setOrdens] = useState([]);
  const [produtos, setProdutos] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [insumos, setInsumos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [filtroSituacao, setFiltroSituacao] = useState('');
  const [novaOrdem, setNovaOrdem] = useState(false);
  const [ordemAberta, setOrdemAberta] = useState(null);
  const [faccoes, setFaccoes] = useState([]);
  const [etapas, setEtapas] = useState([]);
  const [kits, setKits] = useState([]);
  const [faccaoRapida, setFaccaoRapida] = useState(false);
  const [avisoQuadro, setAvisoQuadro] = useState('');
  // Lista ou quadro. A escolha fica no navegador de quem usa: quem toca o chão
  // de fábrica vive no quadro, quem confere números vive na lista, e obrigar os
  // dois a reescolher a cada visita é atrito puro.
  const [visao, setVisao] = useState(() => {
    try { return localStorage.getItem('hbn:producao:visao') || 'lista'; } catch { return 'lista'; }
  });
  useEffect(() => {
    try { localStorage.setItem('hbn:producao:visao', visao); } catch { /* navegador sem storage */ }
  }, [visao]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams();
      if (buscaAplicada) qs.set('busca', buscaAplicada);
      if (filtroSituacao) qs.set('situacao', filtroSituacao);
      // As listas de apoio vêm de UMA rota do próprio módulo Produção
      // (08/09/2026). Antes vinham de /produtos, /fornecedores e /insumos,
      // que são de outros módulos: quem recebesse só a chave `producao`
      // tomaria 403 nas três e abriria esta tela com todos os seletores
      // vazios, sem mensagem de erro nenhuma.
      const [o, apoio] = await Promise.all([
        api.get(`/producao/ordens?${qs}`),
        api.get('/producao/apoio').catch(() => ({ referencias: [], fornecedores: [], insumos: [] })),
      ]);
      setOrdens(o);
      setProdutos(apoio.referencias || []);
      setFornecedores(apoio.fornecedores || []);
      setInsumos(apoio.insumos || []);
      setFaccoes(apoio.faccoes || []);
      setEtapas(apoio.etapas || []);
      setKits(apoio.kits || []);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [buscaAplicada, filtroSituacao]);

  // Arrastar o cartão no quadro. Atualiza a tela na hora e desfaz se o servidor
  // recusar — sem isso, a ordem "pula de volta" só depois da ida e volta da
  // rede, e quem arrastou acha que não funcionou e arrasta de novo.
  async function mudarSituacao(ordem, destino, confirmarPerda = false) {
    const anterior = ordens;
    setAvisoQuadro('');
    setOrdens((atual) => atual.map((o) => (o.id === ordem.id ? { ...o, situacao: destino } : o)));
    try {
      const r = await api.post(`/producao/ordens/${ordem.id}/situacao`, {
        situacao: destino, confirmar: confirmarPerda,
      });
      if (r.aviso) setAvisoQuadro(r.aviso);
      await carregar();
    } catch (e) {
      setOrdens(anterior);
      if (e.data?.exige === 'abrir_ordem') {
        setAvisoQuadro(e.message);
        setOrdemAberta(ordem.id);
        return;
      }
      if (e.data?.exige === 'confirmar') {
        if (await confirmar(e.message, { titulo: 'Cancelar a ordem', confirmarTexto: 'Cancelar assim mesmo', perigo: true })) {
          await mudarSituacao(ordem, destino, true);
        }
        return;
      }
      setErro(e.message);
    }
  }

  useEffect(() => { carregar(); }, [carregar]);

  const totais = useMemo(() => ({
    abertas: ordens.filter((o) => ['rascunho', 'planejada', 'em_producao'].includes(o.situacao)).length,
    pecasEmProducao: ordens
      .filter((o) => o.situacao === 'em_producao')
      .reduce((s, o) => s + (Number(o.quantidade_planejada) - Number(o.quantidade_produzida)), 0),
    semCusto: ordens.filter((o) => Number(o.insumos_sem_custo) > 0).length,
  }), [ordens]);

  const colunas = useMemo(() => ({
    numero: (o) => Number(o.numero),
    referencia: (o) => o.referencia,
    situacao: (o) => o.situacao,
    planejada: (o) => Number(o.quantidade_planejada),
    produzida: (o) => Number(o.quantidade_produzida),
    abertura: (o) => o.data_abertura || '',
  }), []);
  const tabela = useTabela(ordens, { colunas, colunaPadrao: 'numero', direcaoPadrao: 'desc', tamanhoPadrao: 50, prefixo: 'op' });

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Factory size={22} /> Produção</h1>
          <p className="ink-soft">
            A ordem de produção com grade, material reservado e o custo REAL comparado
            com o padrão da ficha — que é o número que ninguém tinha.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
          <button type="button" className="btn" onClick={() => setNovaOrdem(true)}>
            <Plus size={15} /> Nova ordem
          </button>
        </div>
      </header>

      <div className="indicadores-linha">
        <IndicadorDestaque rotulo="Ordens abertas" valor={formatQtd(totais.abertas)} Icone={Factory} />
        <IndicadorDestaque
          rotulo="Peças em produção"
          valor={formatQtd(totais.pecasEmProducao)}
          explicacao="Planejado menos produzido nas ordens que já começaram."
        />
        <IndicadorDestaque
          rotulo="Ordens com insumo sem custo"
          valor={formatQtd(totais.semCusto)}
          tom={totais.semCusto > 0 ? 'atencao' : undefined}
          explicacao="Nessas, o custo material está incompleto — e incompleto não é zero. Lance a nota do insumo para fechar a conta."
        />
      </div>

      <div className="subtab-row">
        <button type="button" className={`subtab-btn ${aba === 'ordens' ? 'active' : ''}`} onClick={() => setAba('ordens')}>
          Ordens ({ordens.length})
        </button>
        <button type="button" className={`subtab-btn ${aba === 'roteiro' ? 'active' : ''}`} onClick={() => setAba('roteiro')}>
          Roteiro e consumo
        </button>
        <button type="button" className={`subtab-btn ${aba === 'wip' ? 'active' : ''}`} onClick={() => setAba('wip')}>
          Onde está a produção
        </button>
        <button type="button" className={`subtab-btn ${aba === 'faccao' ? 'active' : ''}`} onClick={() => setAba('faccao')}>
          Material em facção
        </button>
        <button type="button" className={`subtab-btn ${aba === 'faccoes' ? 'active' : ''}`} onClick={() => setAba('faccoes')}>
          Cadastro de facção
        </button>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}

      {aba === 'ordens' && (
        <>
          <div className="filtros-linha">
            <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)} placeholder="Referência, descrição ou número da OP" />
            <Select value={filtroSituacao} onChange={(e) => setFiltroSituacao(e.target.value)} placeholder="Todas as situações">
              {Object.entries(SITUACAO).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
            </Select>
            <div className="view-toggle">
              <button
                type="button" className={visao === 'lista' ? 'active' : ''}
                onClick={() => setVisao('lista')}
              ><List size={14} /> Lista</button>
              <button
                type="button" className={visao === 'quadro' ? 'active' : ''}
                onClick={() => setVisao('quadro')}
              ><LayoutGrid size={14} /> Quadro</button>
            </div>
          </div>

          {avisoQuadro && <p className="aviso-inline"><AlertTriangle size={14} /> {avisoQuadro}</p>}

          {carregando && <Skeleton height={240} />}
          {!carregando && ordens.length === 0 && (
            <EstadoVazio
              Icone={Factory}
              titulo="Nenhuma ordem de produção"
              descricao="A ordem é o que liga a ficha técnica ao estoque: ela explode o material que a grade vai consumir, reserva esse material, recebe o apontamento de cada operação e, no fim, dá entrada nas peças prontas — apurando quanto a peça custou de verdade."
              acaoLabel="Abrir a primeira ordem"
              onAcao={() => setNovaOrdem(true)}
              IconeAcao={Plus}
            />
          )}

          {!carregando && ordens.length > 0 && visao === 'quadro' && (
            <>
              <p className="ink-soft ajuda-bloco">
                <Info size={14} /> Arraste o cartão para mudar a situação da ordem. Clique nele para
                abrir. <strong>Concluir não é arrastar</strong>: dar entrada das peças no estoque passa
                pela conferência do financeiro e tem confirmação própria, dentro da ordem.
              </p>
              <ProducaoKanban
                ordens={ordens}
                onMudarSituacao={mudarSituacao}
                onClickCartao={(id) => setOrdemAberta(id)}
              />
            </>
          )}

          {!carregando && ordens.length > 0 && visao === 'lista' && (
            <>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th className="num">OP</th><th>Referência</th><th>Situação</th>
                      <th className="num">Planejadas</th><th className="num">Produzidas</th>
                      <th className="num">Material</th><th className="num">Mão de obra</th>
                      <th>Facção</th><th>Início</th><th>Chegada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabela.itensPagina.map((o) => (
                      <tr key={o.id} className="linha-clicavel" onClick={() => setOrdemAberta(o.id)}>
                        <td className="num">{o.numero}</td>
                        <td>
                          {o.tipo === 'kit'
                            ? (
                              <>
                                <span className="selo tone-elevada"><Layers size={11} /> kit</span>
                                {' '}{o.nome || 'Kit'}
                                <span className="ink-soft"> · {o.referencias_do_kit || 'sem referência'}</span>
                              </>
                            )
                            : <>{o.referencia}<span className="ink-soft"> · {o.produto_descricao}</span></>}
                        </td>
                        <td><SeloSituacao situacao={o.situacao} /></td>
                        <td className="num">{formatQtd(o.quantidade_planejada)}</td>
                        <td className="num">{formatQtd(o.quantidade_produzida)}</td>
                        <td className="num">
                          {brl(o.custo_material_reservado)}
                          {Number(o.insumos_sem_custo) > 0 && (
                            <span className="selo tone-atencao" title={`${o.insumos_sem_custo} insumo(s) sem custo conhecido ficaram de fora deste valor.`}>parcial</span>
                          )}
                        </td>
                        <td className="num">{o.gasto_mao_de_obra != null ? brl(o.gasto_mao_de_obra) : '—'}</td>
                        <td>{o.fornecedor_nome || 'interna'}</td>
                        <td>{dataBr(o.data_inicio || o.data_abertura)}</td>
                        <td>
                          {o.data_prevista
                            ? (
                              <>
                                {dataBr(o.data_prevista)}
                                {o.evento_calendario_id && (
                                  <span className="selo tone-neutro" title="Esta ordem está no calendário."><CalendarDays size={11} /></span>
                                )}
                              </>
                            )
                            : <span className="selo tone-atencao" title="Sem chegada prevista, a ordem não entra no calendário e não tem como atrasar.">sem prazo</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Paginacao
                pagina={tabela.pagina} totalPaginas={tabela.totalPaginas} tamanho={tabela.tamanho}
                totalItens={tabela.totalItens} inicio={tabela.inicio} fim={tabela.fim}
                setPagina={tabela.setPagina} setTamanho={tabela.setTamanho}
              />
            </>
          )}
        </>
      )}

      {aba === 'wip' && <Wip />}
      {aba === 'roteiro' && <RoteiroEConsumo produtos={produtos} fornecedores={fornecedores} />}
      {aba === 'faccao' && <Faccao fornecedores={faccoes.length > 0 ? faccoes : fornecedores} insumos={insumos} onMudou={carregar} />}
      {aba === 'faccoes' && <FaccoesAba etapas={etapas} produtos={produtos} onMudou={carregar} />}

      {novaOrdem && (
        <NovaOrdemProducao
          produtos={produtos}
          faccoes={faccoes.length > 0 ? faccoes : fornecedores}
          insumos={insumos}
          kits={kits}
          onFechar={() => setNovaOrdem(false)}
          onNovaFaccao={() => setFaccaoRapida(true)}
          onCriada={(r) => { setNovaOrdem(false); carregar(); setOrdemAberta(r.ordem.id); }}
        />
      )}
      {faccaoRapida && (
        <NovaFaccaoModal
          compacto
          onFechar={() => setFaccaoRapida(false)}
          onSalva={() => { setFaccaoRapida(false); carregar(); }}
        />
      )}
      {ordemAberta && (
        <DetalheOrdem
          ordemId={ordemAberta}
          fornecedores={faccoes.length > 0 ? faccoes : fornecedores}
          insumos={insumos}
          onFechar={() => setOrdemAberta(null)}
          onAbrirOutra={(id) => setOrdemAberta(id)}
          onMudou={carregar}
        />
      )}
    </div>
  );
}
