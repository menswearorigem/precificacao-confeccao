import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Package, FileText, Upload, Plus, RefreshCw, AlertTriangle, Check, X,
  Link2, Link2Off, TrendingUp, CircleSlash, Truck, Info, History, Boxes,
  Pencil, ExternalLink,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, CampoBusca, IndicadorDestaque, Field,
  NumInput, Checkbox, Paginacao,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { useTabela } from '../lib/useTabela';
import { brl, pct, formatQtd, numeroBr, tempoRelativo } from '../lib/format';

// Compras › Insumos e Notas.
//
// A tela da corrente que o Hub não tinha:
//   XML da NF-e → custo real → estoque do insumo → ficha técnica → custo da peça
//
// O ponto que a diferencia de um cadastro qualquer: ela mostra a DEFASAGEM.
// Quando a malha sobe de R$ 28,50 para R$ 31,00, o sistema não muda a ficha
// sozinho — ele mostra quais referências estão com o custo velho, de quanto
// para quanto, e deixa aplicar com um clique. Essa decisão é do dono, não do
// sistema (REGRA 1).

const TIPO_INSUMO = {
  tecido: 'Tecido', aviamento: 'Aviamento', embalagem: 'Embalagem',
  etiqueta: 'Etiqueta', servico: 'Serviço', outro: 'Outro',
};

// O tipo do movimento é gravado como chave ('consumo_producao'). Mostrar a
// chave crua na tela obriga quem lê a traduzir de cabeça.
const TIPO_MOVIMENTO_INSUMO = {
  entrada_nota: 'Entrada por nota',
  consumo_producao: 'Consumo na produção',
  ajuste: 'Ajuste',
  remessa_faccao: 'Remessa para facção',
  retorno_faccao: 'Retorno de facção',
  perda: 'Perda',
  inventario: 'Inventário',
};

// ===========================================================================
// Ficha do insumo
// ===========================================================================
// POR QUE ESTA TELA EXISTE (09/09/2026): GET /insumos/:id devolve saldos por
// local, movimentos, histórico de custo, prazos medidos e — o mais
// importante — QUAIS FICHAS USAM ESTE INSUMO, e por qual valor cada uma está.
// Nenhuma tela chamava. Clicar num insumo abria direto o formulário de
// cadastro: dava para mudar o insumo sem nunca ver o que ele já tinha feito,
// nem quantas referências dependem dele.
//
// REGRA 1: nada aqui recalcula custo, margem ou preço. A ficha mostra os
// valores como estão gravados; quem decide aplicar um custo novo continua
// sendo a aba "Fichas defasadas", com confirmação.
function FichaInsumo({ insumoId, onFechar, onEditar }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [aba, setAba] = useState('fichas');

  useEffect(() => {
    setDados(null);
    setErro('');
    api.get(`/insumos/${insumoId}`).then(setDados).catch((e) => setErro(e.message));
  }, [insumoId]);

  useEffect(() => {
    function aoTeclar(e) { if (e.key === 'Escape') onFechar(); }
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [onFechar]);

  const insumo = dados?.insumo;
  const fichas = dados?.fichas || [];
  const movimentos = dados?.movimentos || [];
  const historico = dados?.historicoCusto || [];
  const leadTimes = dados?.leadTimes || [];
  const saldos = dados?.saldos || [];

  const saldoTotal = saldos.reduce((soma, s) => soma + Number(s.quantidade || 0), 0);

  return (
    <>
      <div className="anuncio-painel-fundo painel-fundo-clicavel" onClick={onFechar} role="presentation" />
      <aside className="anuncio-painel" role="dialog" aria-modal="true" aria-label="Ficha do insumo">
        <header className="anuncio-painel-topo">
          <div>
            <h2 style={{ margin: 0, fontSize: 17 }}>{insumo ? insumo.nome : 'Ficha do insumo'}</h2>
            {insumo && (
              <p className="ink-soft" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
                {[insumo.codigo, TIPO_INSUMO[insumo.tipo] || insumo.tipo, insumo.cor, insumo.especificacao]
                  .filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {insumo && (
              <button type="button" className="btn-icone" title="Editar cadastro" aria-label="Editar cadastro do insumo" onClick={() => onEditar(insumo)}>
                <Pencil size={16} />
              </button>
            )}
            <button type="button" className="btn-icone" onClick={onFechar} title="Fechar" aria-label="Fechar">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="anuncio-painel-corpo">
          {erro && <p className="login-error">{erro}</p>}
          {!dados && !erro && <Skeleton height={280} />}

          {dados && (
            <>
              <div className="promocao-painel-indicadores">
                <IndicadorDestaque
                  rotulo="Saldo"
                  valor={`${numeroBr(saldoTotal, 2)} ${insumo.unidade || ''}`}
                  explicacao={saldos.length > 1 ? `Somado de ${saldos.length} lotes/fornecedores.` : undefined}
                />
                <IndicadorDestaque
                  rotulo="Custo atual"
                  valor={insumo.custo_atual != null ? `${brl(insumo.custo_atual)}/${insumo.unidade}` : '—'}
                  explicacao={insumo.custo_atual == null ? 'Nenhuma nota deste insumo foi lançada ainda.' : undefined}
                />
                <IndicadorDestaque rotulo="Fichas que usam" valor={formatQtd(fichas.length)} />
                {/* O prazo MEDIDO tem uma fórmula só, e ela é do servidor
                    (a lista já traz `lead_time_real_medio`). Recalcular a
                    média aqui criaria um segundo número com o mesmo nome e
                    valores diferentes conforme a tela — exatamente o tipo de
                    divergência que a REGRA 2 existe para impedir. Aqui fica o
                    prometido, com a contagem dos recebimentos. */}
                <IndicadorDestaque
                  rotulo="Prazo prometido"
                  valor={insumo.lead_time_dias != null ? `${insumo.lead_time_dias} d` : '—'}
                  explicacao={leadTimes.length > 0
                    ? `${leadTimes.length} ${leadTimes.length === 1 ? 'recebimento cronometrado' : 'recebimentos cronometrados'} — veja a aba Prazos.`
                    : 'Nenhum recebimento cronometrado ainda.'}
                />
              </div>

              <div className="subtab-row">
                <button type="button" className={`subtab-btn ${aba === 'fichas' ? 'active' : ''}`} onClick={() => setAba('fichas')}>
                  Fichas ({fichas.length})
                </button>
                <button type="button" className={`subtab-btn ${aba === 'custo' ? 'active' : ''}`} onClick={() => setAba('custo')}>
                  Custo ({historico.length})
                </button>
                <button type="button" className={`subtab-btn ${aba === 'movimentos' ? 'active' : ''}`} onClick={() => setAba('movimentos')}>
                  Movimentos ({movimentos.length})
                </button>
                <button type="button" className={`subtab-btn ${aba === 'prazos' ? 'active' : ''}`} onClick={() => setAba('prazos')}>
                  Prazos ({leadTimes.length})
                </button>
              </div>

              {aba === 'fichas' && (
                <>
                  <p className="grafico-explicacao">
                    Quem fica caro se este insumo subir. “Na ficha” é o valor gravado na ficha da
                    referência — quando ele estiver diferente do custo atual, a aba “Fichas
                    defasadas” mostra de quanto para quanto e deixa aplicar.
                  </p>
                  {fichas.length === 0 && (
                    <p className="ink-soft">
                      Nenhuma ficha técnica usa este insumo ainda. Vincule-o em Produto › Ficha de
                      custo para que o preço da nota chegue ao custo da peça.
                    </p>
                  )}
                  {fichas.length > 0 && (
                    <div className="tabela-rolagem">
                      <table className="tabela-nota">
                        <thead>
                          <tr>
                            <th>Referência</th>
                            <th className="num">Consumo por peça</th>
                            <th className="num">Na ficha</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {fichas.map((f) => (
                            <tr key={f.material_id}>
                              <td>
                                <div className="insumo-item-nota">
                                  <strong className="mono">{f.referencia}</strong>
                                  <small>{f.descricao}</small>
                                </div>
                              </td>
                              <td className="num mono">
                                {f.consumo_por_peca != null
                                  ? `${numeroBr(f.consumo_por_peca, 4)} ${insumo.unidade_consumo || insumo.unidade || ''}`
                                  : <span className="ink-faint">—</span>}
                              </td>
                              <td className="num mono">
                                {f.valor_unitario != null ? brl(f.valor_unitario) : <span className="ink-faint">—</span>}
                              </td>
                              <td className="num">
                                <Link to={`/produtos/${f.produto_id}`} className="btn-icone" title="Abrir a ficha da referência" aria-label={`Abrir a ficha de ${f.referencia}`}>
                                  <ExternalLink size={14} />
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {aba === 'custo' && (
                <>
                  <p className="grafico-explicacao">
                    Cada vez que este insumo mudou de preço, e de onde veio o valor. É a resposta
                    para “desde quando essa malha está nesse preço”.
                  </p>
                  {historico.length === 0 && <p className="ink-soft">Nenhuma mudança de custo registrada ainda.</p>}
                  {historico.length > 0 && (
                    <div className="tabela-rolagem">
                      <table className="tabela-nota">
                        <thead>
                          <tr>
                            <th>Quando</th>
                            <th className="num">De</th>
                            <th className="num">Para</th>
                            <th>Fornecedor</th>
                            <th>Origem</th>
                          </tr>
                        </thead>
                        <tbody>
                          {historico.map((h) => (
                            <tr key={h.id}>
                              <td className="mono" title={new Date(h.registrado_em).toLocaleString('pt-BR')}>
                                {tempoRelativo(h.registrado_em)}
                              </td>
                              {/* "de" vazio é a PRIMEIRA nota do insumo, não
                                  custo zero — por isso travessão, nunca R$ 0,00. */}
                              <td className="num mono">
                                {h.custo_anterior != null ? brl(h.custo_anterior) : <span className="ink-faint">primeira</span>}
                              </td>
                              <td className="num mono">{brl(h.custo_novo)}</td>
                              <td>{h.fornecedor_nome || <span className="ink-faint">—</span>}</td>
                              <td>
                                {h.nota_numero
                                  ? <span className="selo tone-neutro">NF {h.nota_numero}</span>
                                  : <span className="selo tone-neutro">{h.origem === 'manual' && h.usuario_nome ? `à mão · ${h.usuario_nome}` : (h.origem || 'à mão')}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {aba === 'movimentos' && (
                <>
                  <p className="grafico-explicacao">
                    Entradas e saídas deste insumo, do mais novo para o mais antigo (200 últimos).
                  </p>
                  {movimentos.length === 0 && <p className="ink-soft">Nenhum movimento registrado ainda.</p>}
                  {movimentos.length > 0 && (
                    <div className="tabela-rolagem">
                      <table className="tabela-nota">
                        <thead>
                          <tr>
                            <th>Quando</th>
                            <th>Tipo</th>
                            <th className="num">Quantidade</th>
                            <th className="num">Resultante</th>
                            <th>Origem</th>
                          </tr>
                        </thead>
                        <tbody>
                          {movimentos.map((m) => {
                            const q = Number(m.quantidade);
                            return (
                              <tr key={m.id}>
                                <td className="mono" title={new Date(m.criado_em).toLocaleString('pt-BR')}>
                                  {tempoRelativo(m.criado_em)}
                                </td>
                                <td><span className="selo tone-neutro">{TIPO_MOVIMENTO_INSUMO[m.tipo] || m.tipo}</span></td>
                                <td className="num mono" style={{ color: q < 0 ? 'var(--danger)' : 'var(--success)' }}>
                                  {q > 0 ? '+' : ''}{numeroBr(q, 2)} {insumo.unidade}
                                </td>
                                <td className="num mono">{m.quantidade_resultante != null ? numeroBr(m.quantidade_resultante, 2) : <span className="ink-faint">—</span>}</td>
                                <td>
                                  {m.nota_numero
                                    ? <span className="selo tone-neutro">NF {m.nota_numero}</span>
                                    : (m.motivo || m.usuario_nome || <span className="ink-faint">—</span>)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {aba === 'prazos' && (
                <>
                  <p className="grafico-explicacao">
                    Quanto tempo cada recebimento levou de verdade. Com três ou mais, o prazo medido
                    passa a valer no lugar do prometido no cadastro.
                  </p>
                  {leadTimes.length === 0 && (
                    <p className="ink-soft">
                      Nenhum recebimento cronometrado ainda. O prazo em uso é o prometido pelo
                      fornecedor{insumo.lead_time_dias != null ? ` (${insumo.lead_time_dias} dias)` : ''}.
                    </p>
                  )}
                  {leadTimes.length > 0 && (
                    <div className="tabela-rolagem">
                      <table className="tabela-nota">
                        <thead>
                          <tr>
                            <th>Recebido em</th>
                            <th>Fornecedor</th>
                            <th className="num">Dias</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leadTimes.map((l) => (
                            <tr key={l.id}>
                              <td className="mono">{l.data_recebimento ? new Date(l.data_recebimento).toLocaleDateString('pt-BR') : '—'}</td>
                              <td>{l.fornecedor_nome || <span className="ink-faint">—</span>}</td>
                              <td className="num mono">{l.dias != null ? formatQtd(l.dias) : <span className="ink-faint">—</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// ===========================================================================
// Importar nota fiscal
// ===========================================================================
function ImportarNota({ insumos, onLancada, onFechar }) {
  const [previa, setPrevia] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState(null);
  const inputRef = useRef(null);

  async function lerArquivo(arquivo) {
    if (!arquivo) return;
    setErro(null);
    setCarregando(true);
    try {
      const fd = new FormData();
      fd.append('arquivo', arquivo);
      const d = await api.upload('/insumos/notas/ler-xml', fd);
      // O vínculo sugerido (do que já foi decidido antes para o mesmo
      // fornecedor) entra preenchido; o resto fica em branco esperando
      // alguém decidir. Nunca casamos por nome parecido (REGRA 2).
      setPrevia({
        ...d,
        itens: d.itens.map((i) => ({
          ...i,
          insumo_id: i.insumo_sugerido_id || null,
          fator_conversao: i.fator_conversao_sugerido || null,
        })),
      });
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }

  function alterarItem(indice, campo, valor) {
    setPrevia((p) => ({
      ...p,
      itens: p.itens.map((i, n) => (n === indice ? { ...i, [campo]: valor } : i)),
    }));
  }

  const semVinculo = (previa?.itens || []).filter((i) => !i.insumo_id);
  const jaImportada = Boolean(previa?.jaExiste);

  async function lancar() {
    if (semVinculo.length > 0 || jaImportada) return;
    const total = previa.itens.length;
    if (!await confirmar(
      `Vai lançar a nota ${previa.nota.numero || ''} com ${total} ${total === 1 ? 'item' : 'itens'}: `
      + 'o estoque dos insumos entra e o custo deles é atualizado a partir dela.',
      { titulo: 'Lançar nota fiscal', confirmarTexto: 'Lançar', perigo: false }
    )) return;

    setEnviando(true);
    setErro(null);
    try {
      const r = await api.post('/insumos/notas', {
        confirmar: true,
        nota: {
          ...previa.nota,
          fornecedor_id: previa.fornecedor?.id || null,
          empresa_id: previa.empresa?.id || null,
          origem: 'xml',
        },
        itens: previa.itens,
      });
      onLancada(r);
    } catch (e) {
      setErro(e.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="card">
      <div className="insumo-fluxo-topo">
        <h3 className="card-titulo"><FileText size={16} /> Importar nota fiscal</h3>
        <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
      </div>

      {!previa && (
        <>
          <p className="ink-soft">
            Mande o arquivo <strong>XML</strong> da nota que o fornecedor enviou. O sistema lê tudo —
            emitente, itens, impostos, frete e parcelas — e calcula o <strong>custo real</strong> de cada
            insumo, que é o valor da nota mais o frete rateado, menos o imposto que a sua empresa recupera.
          </p>
          <div className="insumo-upload">
            <input
              ref={inputRef}
              type="file"
              accept=".xml,text/xml,application/xml"
              onChange={(e) => lerArquivo(e.target.files?.[0])}
              hidden
            />
            <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={carregando}>
              <Upload size={15} /> {carregando ? 'Lendo…' : 'Escolher o XML'}
            </button>
          </div>
        </>
      )}

      {erro && <p className="erro-inline">{erro}</p>}

      {previa && (
        <>
          <div className="insumo-nota-cabecalho">
            <div>
              <span className="ink-faint">Fornecedor</span>
              <strong>{previa.nota.emitenteNome || '—'}</strong>
              {previa.fornecedor
                ? <span className="selo tone-saudavel">cadastrado</span>
                : <span className="selo tone-atencao">não cadastrado</span>}
            </div>
            <div>
              <span className="ink-faint">Nota</span>
              <strong>{previa.nota.numero || '—'} / série {previa.nota.serie || '—'}</strong>
            </div>
            <div>
              <span className="ink-faint">Emissão</span>
              <strong>{previa.nota.dataEmissao ? new Date(`${previa.nota.dataEmissao}T00:00:00`).toLocaleDateString('pt-BR') : '—'}</strong>
            </div>
            <div>
              <span className="ink-faint">Empresa</span>
              <strong>{previa.empresa?.nome || '—'}</strong>
              {previa.empresa && <span className="selo tone-neutro">{previa.empresa.regime_tributario}</span>}
            </div>
            <div>
              <span className="ink-faint">Total</span>
              <strong className="mono">{brl(previa.nota.valorTotal)}</strong>
            </div>
            <div>
              <span className="ink-faint">Custo real</span>
              <strong className="mono">{brl(previa.resumoCusto.custoTotal)}</strong>
              {previa.resumoCusto.creditoIcms > 0 && (
                <span className="selo tone-elevada" title="ICMS que a sua empresa recupera e por isso NÃO entra no custo">
                  −{brl(previa.resumoCusto.creditoIcms)} de crédito
                </span>
              )}
            </div>
          </div>

          {previa.avisos.length > 0 && (
            <div className="insumo-avisos">
              {previa.avisos.map((a) => (
                <p key={a} className={a.includes('JÁ foi importada') ? 'grave' : ''}>
                  <AlertTriangle size={13} /> {a}
                </p>
              ))}
            </div>
          )}

          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Item da nota</th>
                  <th className="num">Qtd</th>
                  <th className="num">Valor da nota</th>
                  <th className="num">Custo real</th>
                  <th>Vira qual insumo?</th>
                  <th className="num">Conversão</th>
                </tr>
              </thead>
              <tbody>
                {previa.itens.map((i, n) => (
                  <tr key={`${i.codigoFornecedor || ''}-${n}`} className={i.insumo_id ? '' : 'linha-pendente'}>
                    <td>
                      <div className="insumo-item-nota">
                        <strong>{i.descricao}</strong>
                        <small>{i.codigoFornecedor} · {i.ncm} · CFOP {i.cfop}</small>
                      </div>
                    </td>
                    <td className="num mono">{numeroBr(i.quantidade, 2)} {i.unidade}</td>
                    <td className="num mono">{brl(i.valorUnitario)}</td>
                    <td className="num">
                      <strong className="mono">{i.custoUnitarioFinal != null ? brl(i.custoUnitarioFinal) : '—'}</strong>
                      {i.composicaoCusto?.frete > 0 && (
                        <small
                          className="insumo-composicao"
                          title={`Valor do produto ${brl(i.composicaoCusto.valorProduto)} + frete rateado ${brl(i.composicaoCusto.frete)}`
                            + (i.composicaoCusto.creditoIcms > 0 ? ` − crédito de ICMS ${brl(i.composicaoCusto.creditoIcms)}` : '')}
                        >
                          + {brl(i.composicaoCusto.frete)} de frete
                        </small>
                      )}
                    </td>
                    <td>
                      <Select
                        value={i.insumo_id ? String(i.insumo_id) : ''}
                        onChange={(e) => alterarItem(n, 'insumo_id', e.target.value ? Number(e.target.value) : null)}
                        placeholder="Escolha o insumo"
                      >
                        {insumos.map((ins) => (
                          <option key={ins.id} value={ins.id}>{ins.nome} ({ins.unidade})</option>
                        ))}
                      </Select>
                    </td>
                    <td className="num">
                      <NumInput
                        value={i.fator_conversao ?? ''}
                        onChange={(v) => alterarItem(n, 'fator_conversao', v === '' ? null : Number(v))}
                        step="0.0001"
                        placeholder="1"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="ink-soft insumo-nota-rodape">
            <Info size={13} /> A conversão só é necessária quando a nota vem numa unidade e o insumo é
            estocado em outra — nota em quilo, estoque em metro, por exemplo. Deixe em branco quando for a mesma.
          </p>

          <div className="insumo-acoes">
            {semVinculo.length > 0 && (
              <span className="selo tone-atencao">
                {semVinculo.length} {semVinculo.length === 1 ? 'item sem insumo' : 'itens sem insumo'} — lançar assim entraria estoque sem saber do quê
              </span>
            )}
            <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
            <button
              type="button"
              className="btn"
              onClick={lancar}
              disabled={enviando || semVinculo.length > 0 || jaImportada}
            >
              {enviando ? 'Lançando…' : 'Lançar a nota'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

// ===========================================================================
// Fichas defasadas — o coração da tela
// ===========================================================================
// ===========================================================================
// Cadastro de insumo
// ===========================================================================
// Faltava: dava para listar e para importar nota, mas criar um insumo novo só
// pela API. Sem cadastro, a corrente inteira do módulo começa quebrada — não
// há o que vincular na ficha, e a nota fiscal não tem em que insumo pousar.
//
// O formulário é curto de propósito. Só `nome` e `unidade` são obrigatórios;
// o resto é o que MELHORA a conta quando existe, e o campo diz o que perde
// quem deixa em branco — em vez de pedir tudo e ser abandonado no meio.
function CadastroInsumo({ insumo, fornecedores, onFechar, onSalvo }) {
  const editando = Boolean(insumo?.id);
  const [f, setF] = useState(() => ({
    codigo: '', nome: '', tipo: 'tecido', unidade: 'kg', unidade_consumo: '',
    fator_conversao: '', especificacao: '', cor: '', largura_cm: '',
    gramatura: '', fornecedor_id: '', lead_time_dias: '', lote_minimo: '',
    multiplo_compra: '', perda_pct: '', observacoes: '', ativo: true,
    ...(insumo || {}),
  }));
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const set = (campo) => (v) => setF((a) => ({ ...a, [campo]: v }));
  const setEv = (campo) => (e) => setF((a) => ({ ...a, [campo]: e.target.value }));

  // A perda é digitada em % (8) e guardada como fração (0,08) — que é como o
  // motor de explosão da ficha lê. Confundir os dois multiplicaria a
  // necessidade de material por 100.
  const perdaPct = f.perda_pct === '' || f.perda_pct == null ? '' : Number(f.perda_pct) * 100;

  async function salvar() {
    setErro('');
    if (!String(f.nome).trim()) { setErro('O insumo precisa de um nome.'); return; }
    if (!String(f.unidade).trim()) { setErro('Diga em que unidade ele é comprado (kg, m, un…).'); return; }
    setSalvando(true);
    try {
      const corpo = {
        ...f,
        fornecedor_id: f.fornecedor_id ? Number(f.fornecedor_id) : null,
      };
      const salvo = editando
        ? await api.put(`/insumos/${insumo.id}`, corpo)
        : await api.post('/insumos', corpo);
      onSalvo(salvo);
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="anuncio-painel-fundo" role="dialog" aria-modal="true">
      <div className="anuncio-painel">
        <header className="anuncio-painel-topo">
          <h2><Package size={18} /> {editando ? `Insumo: ${insumo.nome}` : 'Novo insumo'}</h2>
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </header>

        <div className="anuncio-painel-corpo">
          <div className="form-linha">
            <Field label="Nome">
              <input className="input" value={f.nome} onChange={setEv('nome')} placeholder="Malha PV 30.1" />
            </Field>
            <Field label="Código" hint="Opcional. O código do fornecedor, se houver.">
              <input className="input" value={f.codigo || ''} onChange={setEv('codigo')} />
            </Field>
            <Field label="Tipo">
              <Select value={f.tipo} onChange={setEv('tipo')}>
                {Object.entries(TIPO_INSUMO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
          </div>

          <div className="form-linha">
            <Field label="Unidade de compra" hint="Como vem na nota: kg, m, un, rolo.">
              <input className="input" value={f.unidade} onChange={setEv('unidade')} placeholder="kg" />
            </Field>
            <Field label="Unidade de consumo" hint="Como a ficha usa, quando é diferente da de compra.">
              <input className="input" value={f.unidade_consumo || ''} onChange={setEv('unidade_consumo')} placeholder="m" />
            </Field>
            <Field
              label="Fator de conversão"
              hint="Quanto da unidade de compra tem em 1 de consumo. Malha comprada em kg e usada em metro, com 1 m pesando 0,32 kg → 0,32."
            >
              <NumInput step="0.0001" value={f.fator_conversao} onChange={set('fator_conversao')} />
            </Field>
          </div>

          <div className="form-linha">
            <Field label="Especificação"><input className="input" value={f.especificacao || ''} onChange={setEv('especificacao')} /></Field>
            <Field label="Cor"><input className="input" value={f.cor || ''} onChange={setEv('cor')} /></Field>
            <Field label="Largura (cm)"><NumInput step="0.1" value={f.largura_cm} onChange={set('largura_cm')} /></Field>
            <Field label="Gramatura"><NumInput step="1" value={f.gramatura} onChange={set('gramatura')} /></Field>
          </div>

          <h3 className="card-titulo"><Truck size={16} /> Compra</h3>
          <div className="form-linha">
            <Field label="Fornecedor habitual">
              <Select value={f.fornecedor_id || ''} onChange={setEv('fornecedor_id')} placeholder="Nenhum">
                {fornecedores.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}
              </Select>
            </Field>
            <Field label="Prazo prometido (dias)" hint="O prometido. O REAL o sistema mede sozinho a cada nota lançada, e passa a valer a partir do terceiro recebimento.">
              <NumInput step="1" value={f.lead_time_dias} onChange={set('lead_time_dias')} />
            </Field>
            <Field label="Lote mínimo" hint="O fornecedor não vende menos que isto. Sem ele, o sistema sugere comprar 3 kg de uma malha que só sai em peça de 25.">
              <NumInput step="0.001" value={f.lote_minimo} onChange={set('lote_minimo')} />
            </Field>
            <Field label="Múltiplo de compra" hint="Só vende de tantos em tantos.">
              <NumInput step="0.001" value={f.multiplo_compra} onChange={set('multiplo_compra')} />
            </Field>
          </div>

          <h3 className="card-titulo"><CircleSlash size={16} /> Perda</h3>
          <div className="form-linha">
            <Field
              label="Perda de corte (%)"
              hint="O que se perde entre o que entra e o que vira peça. Deixar em branco NÃO vale zero: a necessidade sai subestimada e a ordem de produção avisa que está assim."
            >
              <NumInput
                step="0.1" suffix="%" value={perdaPct}
                onChange={(v) => setF((a) => ({ ...a, perda_pct: v === '' || v == null ? '' : v / 100 }))}
              />
            </Field>
            <Field label="Observações">
              <input className="input" value={f.observacoes || ''} onChange={setEv('observacoes')} />
            </Field>
          </div>

          <p className="ink-soft ajuda-bloco">
            O custo NÃO se digita aqui. Ele entra pela nota fiscal, que é o que faz o
            custo da peça reagir ao preço do material em vez de envelhecer calado.
            Insumo recém-criado aparece como “sem custo” até a primeira nota — e sem
            custo é diferente de R$ 0,00.
          </p>

          {erro && <p className="erro-inline">{erro}</p>}
        </div>

        <footer className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
          <button type="button" className="btn" onClick={salvar} disabled={salvando}>
            <Check size={15} /> {editando ? 'Salvar' : 'Cadastrar insumo'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function FichasDefasadas({ onAplicou }) {
  const [dados, setDados] = useState(null);
  const [marcados, setMarcados] = useState([]);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState(null);

  const carregar = useCallback(() => {
    api.get('/insumos/diagnostico/fichas-defasadas')
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  const defasadas = useMemo(
    () => (dados?.linhas || []).filter((l) => l.diferenca != null && Math.abs(l.diferenca) > 0.0001),
    [dados]
  );
  const impedidas = useMemo(() => (dados?.linhas || []).filter((l) => l.impedimento), [dados]);

  async function aplicar() {
    if (marcados.length === 0) return;
    if (!await confirmar(
      `Vai atualizar o custo do material em ${marcados.length} ${marcados.length === 1 ? 'ficha' : 'fichas'}. `
      + 'Isso muda o custo da peça e, com ele, o preço mínimo e a margem que o sistema calcula.',
      { titulo: 'Atualizar o custo nas fichas', confirmarTexto: 'Atualizar', perigo: false }
    )) return;
    setSalvando(true);
    setErro(null);
    try {
      const r = await api.post('/insumos/aplicar-na-ficha', { confirmar: true, material_ids: marcados });
      if (r.recusados?.length > 0) {
        setErro(`${r.aplicados.length} aplicadas. ${r.recusados.length} recusadas: ${r.recusados.map((x) => x.motivo).join('; ')}`);
      }
      setMarcados([]);
      carregar();
      onAplicou?.();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  if (!dados) return <Skeleton height={160} />;

  if (defasadas.length === 0 && impedidas.length === 0) {
    return (
      <EstadoVazio
        Icone={Check}
        titulo="Nenhuma ficha desatualizada"
        descricao="Todas as fichas vinculadas a insumo estão com o custo igual ao da última nota. Quando um insumo subir de preço, as referências afetadas aparecem aqui."
      />
    );
  }

  return (
    <>
      <p className="ink-soft insumo-explicacao">
        Quando a matéria-prima muda de preço, o sistema <strong>não altera a ficha sozinho</strong> — ele mostra
        aqui o que ficou para trás e deixa você decidir. É por isso que o custo da peça não envelhece calado.
      </p>

      {defasadas.length > 0 && (
        <>
          <div className="insumo-acoes-topo">
            <button
              type="button"
              className="btn-sec"
              onClick={() => setMarcados(marcados.length === defasadas.length ? [] : defasadas.map((l) => l.material_id))}
            >
              {marcados.length === defasadas.length ? 'Desmarcar todas' : `Marcar as ${defasadas.length}`}
            </button>
            <button type="button" className="btn" onClick={aplicar} disabled={salvando || marcados.length === 0}>
              {salvando ? 'Aplicando…' : `Atualizar ${marcados.length || ''} ${marcados.length === 1 ? 'ficha' : 'fichas'}`}
            </button>
          </div>

          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th style={{ width: 32 }} />
                  <th>Referência</th>
                  <th>Insumo</th>
                  <th className="num">Na ficha</th>
                  <th className="num">Custo hoje</th>
                  <th className="num">Diferença</th>
                </tr>
              </thead>
              <tbody>
                {defasadas.map((l) => (
                  <tr key={l.material_id} className={l.diferenca > 0 ? 'linha-prejuizo' : ''}>
                    <td>
                      <Checkbox
                        checked={marcados.includes(l.material_id)}
                        onChange={(e) => setMarcados((s) => (e.target.checked
                          ? [...s, l.material_id]
                          : s.filter((x) => x !== l.material_id)))}
                      />
                    </td>
                    <td>
                      <div className="insumo-item-nota">
                        <strong>{l.referencia}</strong>
                        <small>{l.produto_descricao}</small>
                      </div>
                    </td>
                    <td>{l.insumo_nome}</td>
                    <td className="num mono">{brl(l.valor_na_ficha)}</td>
                    <td className="num mono">
                      {brl(l.custo_na_unidade_da_ficha)}
                      {l.unidade_consumo && l.unidade_consumo !== l.unidade && (
                        <small className="insumo-composicao" title={`Comprado em ${l.unidade}, consumido em ${l.unidade_consumo}`}>
                          por {l.unidade_consumo}
                        </small>
                      )}
                    </td>
                    <td className="num">
                      <span className={`selo ${l.diferenca > 0 ? 'tone-prejuizo' : 'tone-saudavel'}`}>
                        {l.diferenca > 0 ? '+' : ''}{brl(l.diferenca)}
                        {l.diferenca_pct != null && ` (${pct(l.diferenca_pct, 1)})`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {impedidas.length > 0 && (
        <div className="insumo-avisos">
          <p><AlertTriangle size={13} /> {impedidas.length} linha(s) não puderam ser comparadas:</p>
          {impedidas.slice(0, 5).map((l) => (
            <p key={l.material_id} className="insumo-impedida">
              <strong>{l.referencia}</strong> · {l.insumo_nome} — {l.impedimento}
            </p>
          ))}
        </div>
      )}

      {erro && <p className="erro-inline">{erro}</p>}
    </>
  );
}

// ===========================================================================
// Página
// ===========================================================================
export default function InsumosPage() {
  const [aba, setAba] = useState('insumos');
  const [insumos, setInsumos] = useState([]);
  const [notas, setNotas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [importando, setImportando] = useState(false);
  const [erro, setErro] = useState(null);
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [filtroTipo, setFiltroTipo] = useState('');
  const [resultado, setResultado] = useState(null);
  const [fornecedores, setFornecedores] = useState([]);
  const [editandoInsumo, setEditandoInsumo] = useState(null);
  // Clicar num insumo abria direto o formulário de cadastro. Agora abre a
  // ficha — o que ele já fez, quem depende dele — e o cadastro fica a um
  // clique dali.
  const [fichaDe, setFichaDe] = useState(null);

  const carregar = useCallback(() => {
    setCarregando(true);
    const params = new URLSearchParams();
    if (buscaAplicada) params.set('busca', buscaAplicada);
    if (filtroTipo) params.set('tipo', filtroTipo);
    Promise.all([
      api.get(`/insumos?${params.toString()}`),
      api.get('/insumos/notas/lista'),
      api.get('/fornecedores').catch(() => []),
    ])
      .then(([i, n, f]) => { setInsumos(i); setNotas(n); setFornecedores(f); })
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [buscaAplicada, filtroTipo]);

  useEffect(() => { carregar(); }, [carregar]);

  const totais = useMemo(() => ({
    insumos: insumos.length,
    semCusto: insumos.filter((i) => i.custo_atual == null).length,
    semFornecedor: insumos.filter((i) => !i.fornecedor_id).length,
    valorEmEstoque: insumos.reduce(
      (s, i) => s + (i.custo_atual != null ? Number(i.saldo_total || 0) * Number(i.custo_atual) : 0), 0
    ),
    comLeadTimeReal: insumos.filter((i) => Number(i.lead_time_amostras) >= 3).length,
  }), [insumos]);

  const colunas = useMemo(() => ({
    nome: (i) => i.nome,
    tipo: (i) => i.tipo,
    saldo: (i) => Number(i.saldo_total || 0),
    custo: (i) => (i.custo_atual != null ? Number(i.custo_atual) : null),
    fornecedor: (i) => i.fornecedor_nome || '',
    fichas: (i) => Number(i.fichas_que_usam || 0),
  }), []);
  const tabela = useTabela(insumos, { colunas, colunaPadrao: 'nome', tamanhoPadrao: 50, prefixo: 'ins' });

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Package size={22} /> Insumos e Notas</h1>
          <p className="ink-soft">
            A matéria-prima como cadastro, e o custo dela vindo da nota fiscal —
            para o custo da peça parar de envelhecer calado.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
          <button type="button" className="btn-sec" onClick={() => setEditandoInsumo({})}>
            <Plus size={15} /> Novo insumo
          </button>
          <button type="button" className="btn" onClick={() => setImportando(true)}>
            <Upload size={15} /> Importar nota fiscal
          </button>
        </div>
      </header>

      {resultado && (
        <div className="insumo-resultado card">
          <h3 className="card-titulo"><Check size={16} /> Nota lançada</h3>
          <p>
            {resultado.custosAtualizados.length} insumo(s) tiveram o custo atualizado a partir dela.
          </p>
          <ul>
            {resultado.custosAtualizados.map((c) => (
              <li key={c.insumoId}>
                <strong>{c.descricao}</strong>: {c.custoAnterior != null ? brl(c.custoAnterior) : 'sem custo'} → {brl(c.custoNovo)}
                {c.custoAnterior != null && c.custoAnterior > 0 && (
                  <span className={`selo ${c.custoNovo > c.custoAnterior ? 'tone-prejuizo' : 'tone-saudavel'}`}>
                    {c.custoNovo > c.custoAnterior ? '+' : ''}{pct((c.custoNovo - c.custoAnterior) / c.custoAnterior, 1)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="btn-sec" onClick={() => { setResultado(null); setAba('defasadas'); }}>
            Ver quais fichas ficaram desatualizadas
          </button>
        </div>
      )}

      {fichaDe && !editandoInsumo && (
        <FichaInsumo
          insumoId={fichaDe}
          onFechar={() => setFichaDe(null)}
          onEditar={(i) => setEditandoInsumo(i)}
        />
      )}

      {editandoInsumo && (
        <CadastroInsumo
          insumo={editandoInsumo.id ? editandoInsumo : null}
          fornecedores={fornecedores}
          onFechar={() => setEditandoInsumo(null)}
          onSalvo={() => { setEditandoInsumo(null); setFichaDe(null); carregar(); }}
        />
      )}

      {importando && (
        <ImportarNota
          insumos={insumos}
          onFechar={() => setImportando(false)}
          onLancada={(r) => { setImportando(false); setResultado(r); carregar(); }}
        />
      )}

      <div className="indicadores-linha">
        <IndicadorDestaque rotulo="Insumos" valor={formatQtd(totais.insumos)} Icone={Boxes} />
        <IndicadorDestaque
          rotulo="Sem custo"
          valor={formatQtd(totais.semCusto)}
          tom={totais.semCusto > 0 ? 'atencao' : undefined}
          explicacao="Ainda não entrou nota nenhuma deles. O sistema mostra 'sem custo', nunca R$ 0,00."
        />
        <IndicadorDestaque
          rotulo="Valor em estoque"
          valor={brl(totais.valorEmEstoque)}
          explicacao="Só conta o que tem custo conhecido."
        />
        <IndicadorDestaque
          rotulo="Com prazo medido"
          valor={formatQtd(totais.comLeadTimeReal)}
          explicacao="Insumos com três ou mais recebimentos: aí o prazo REAL do fornecedor passa a valer mais que o prometido."
        />
      </div>

      <div className="subtab-row">
        <button type="button" className={`subtab-btn ${aba === 'insumos' ? 'active' : ''}`} onClick={() => setAba('insumos')}>
          Insumos ({insumos.length})
        </button>
        <button type="button" className={`subtab-btn ${aba === 'defasadas' ? 'active' : ''}`} onClick={() => setAba('defasadas')}>
          Fichas desatualizadas
        </button>
        <button type="button" className={`subtab-btn ${aba === 'notas' ? 'active' : ''}`} onClick={() => setAba('notas')}>
          Notas lançadas ({notas.length})
        </button>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}

      {aba === 'insumos' && (
        <>
          <div className="filtros-linha">
            <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)} placeholder="Nome, código ou especificação" />
            <Select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)} placeholder="Todos os tipos">
              {Object.entries(TIPO_INSUMO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>

          {carregando && <Skeleton height={240} />}
          {!carregando && insumos.length === 0 && (
            <EstadoVazio
              Icone={Package}
              titulo="Nenhum insumo cadastrado"
              descricao="O insumo é a matéria-prima como cadastro: malha, ribana, zíper, linha, etiqueta. É ele que liga a ficha técnica à nota fiscal — sem ele, o custo da peça não reage ao preço do material."
              acaoLabel="Cadastrar o primeiro insumo"
              onAcao={() => setEditandoInsumo({})}
              IconeAcao={Plus}
            />
          )}

          {!carregando && insumos.length > 0 && (
            <>
              <div className="tabela-rolagem">
                <table className="tabela-nota">
                  <thead>
                    <tr>
                      <th>Insumo</th>
                      <th>Tipo</th>
                      <th>Fornecedor</th>
                      <th className="num">Saldo</th>
                      <th className="num">Custo atual</th>
                      <th className="num">Prazo</th>
                      <th className="num">Fichas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabela.itensPagina.map((i) => (
                      <tr key={i.id} className="linha-clicavel" onClick={() => setFichaDe(i.id)}>
                        <td>
                          <div className="insumo-item-nota">
                            <strong>{i.nome}</strong>
                            <small>{[i.codigo, i.cor, i.especificacao].filter(Boolean).join(' · ')}</small>
                          </div>
                        </td>
                        <td><span className="selo tone-neutro">{TIPO_INSUMO[i.tipo] || i.tipo}</span></td>
                        <td>{i.fornecedor_nome || <span className="ink-faint">—</span>}</td>
                        <td className="num mono">
                          {numeroBr(i.saldo_total, 2)} {i.unidade}
                        </td>
                        <td className="num">
                          {i.custo_atual != null
                            ? (
                              <span className="mono" title={`Origem: ${i.custo_origem === 'nota' ? 'última nota fiscal' : i.custo_origem}`}>
                                {brl(i.custo_atual)}/{i.unidade}
                              </span>
                            )
                            : (
                              <span className="cobertura-sem-valor" title="Nenhuma nota deste insumo foi lançada ainda">
                                <CircleSlash size={11} /> sem custo
                              </span>
                            )}
                        </td>
                        <td className="num">
                          {Number(i.lead_time_amostras) >= 3
                            ? (
                              <span
                                className="selo tone-saudavel"
                                title={`Medido em ${i.lead_time_amostras} recebimentos. Prometido: ${i.lead_time_dias ?? '—'} dias.`}
                              >
                                {numeroBr(i.lead_time_real_medio, 0)}d medido
                              </span>
                            )
                            : (i.lead_time_dias != null
                              ? <span className="selo tone-neutro" title="Prazo prometido pelo fornecedor. O real passa a valer com 3 recebimentos.">{i.lead_time_dias}d</span>
                              : <span className="ink-faint">—</span>)}
                        </td>
                        <td className="num mono">{formatQtd(i.fichas_que_usam)}</td>
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

      {aba === 'defasadas' && <FichasDefasadas onAplicou={carregar} />}

      {aba === 'notas' && (
        <>
          {notas.length === 0 && (
            <EstadoVazio
              Icone={FileText}
              titulo="Nenhuma nota lançada"
              descricao="Importe o XML de uma nota de compra para dar entrada no estoque e atualizar o custo do insumo."
            />
          )}
          {notas.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela-nota">
                <thead>
                  <tr>
                    <th>Nota</th>
                    <th>Fornecedor</th>
                    <th>Empresa</th>
                    <th className="num">Emissão</th>
                    <th className="num">Itens</th>
                    <th className="num">Total</th>
                    <th className="num">Custo real</th>
                    <th>Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map((n) => (
                    <tr key={n.id}>
                      <td>
                        <div className="insumo-item-nota">
                          <strong>{n.numero || '—'}</strong>
                          <small>{n.chave_acesso ? `…${String(n.chave_acesso).slice(-8)}` : 'sem chave'}</small>
                        </div>
                      </td>
                      <td>{n.fornecedor_nome || n.emitente_nome || '—'}</td>
                      <td>{n.empresa_nome || <span className="ink-faint">—</span>}</td>
                      <td className="num">{n.data_emissao ? new Date(`${n.data_emissao}T00:00:00`).toLocaleDateString('pt-BR') : '—'}</td>
                      <td className="num mono">{formatQtd(n.qtd_itens)}</td>
                      <td className="num mono">{brl(n.valor_total)}</td>
                      <td className="num mono">{n.custo_total != null ? brl(n.custo_total) : '—'}</td>
                      <td>
                        <span className={`selo ${n.origem === 'xml' ? 'tone-saudavel' : 'tone-neutro'}`}>
                          {n.origem === 'xml' ? 'XML' : 'digitada'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
