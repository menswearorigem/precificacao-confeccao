import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Tags, Plus, Search, Trash2, Star, Pencil, ClipboardPaste, Info, Calculator, X,
} from 'lucide-react';
import { api } from '../api/client';
import { Field, Select, NumInput, Toggle, EstadoVazio, AvisoDeFalha, Skeleton } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { brl, pct, formatQtd } from '../lib/format';
import DataTable from '../components/DataTable';

// Tabelas de preço (09/09/2026).
//
// Atacado, lojista, revenda e varejo pagam preços diferentes pela mesma peça.
// Cada tabela tem um desconto GERAL e, quando é o caso, um desconto por
// REFERÊNCIA — ou um preço travado, que ignora o desconto.
//
// REGRA 1, dita na própria tela (não só no código): o preço de partida
// continua sendo o preço que o sistema já calcula. A tabela só desconta em
// cima dele. Nada aqui recalcula margem, markup ou preço sugerido.

const TIPOS_ITEM = [
  { valor: 'percentual', rotulo: 'Desconto em %' },
  { valor: 'valor', rotulo: 'Desconto em R$' },
  { valor: 'preco_fixo', rotulo: 'Preço travado' },
];

function descricaoDesconto(tabela) {
  const valor = Number(tabela.desconto_geral) || 0;
  if (valor <= 0) return { numero: 'Sem desconto', texto: 'O preço vai igual ao preço do sistema.' };
  if (tabela.tipo_desconto === 'valor') {
    return { numero: `− ${brl(valor)}`, texto: 'abatidos de cada peça' };
  }
  return { numero: `− ${pct(valor)}`, texto: 'sobre o preço de cada peça' };
}

function tabelaVazia() {
  return { nome: '', descricao: '', tipo_desconto: 'percentual', desconto_geral: 0, padrao: false, observacao: '' };
}

// Na colagem, o percentual é digitado como percentual ("15"), e o sistema
// guarda fração ("0,15"). A conversão é aqui, e só aqui — o resto do valor
// vai cru para o servidor, que sabe ler vírgula decimal.
function percentualParaFracao(texto) {
  const limpo = String(texto || '').replace(/[%\s]/g, '');
  const numero = limpo.includes(',')
    ? Number(limpo.replace(/\./g, '').replace(',', '.'))
    : Number(limpo);
  if (!Number.isFinite(numero)) return texto;
  return numero / 100;
}

// Simulador: mostra, para um preço qualquer, quanto a tabela deixa. Roda no
// próprio navegador com a mesma regra do servidor — é conferência visual,
// nada é gravado.
function simular(tabela, precoBase) {
  const base = Number(precoBase) || 0;
  const valor = Number(tabela.desconto_geral) || 0;
  if (valor <= 0) return base;
  if (tabela.tipo_desconto === 'valor') return Math.max(0, base - valor);
  return base * (1 - valor);
}

function LinhaItem({ item, onRemover }) {
  const rotulo = item.tipo_desconto === 'preco_fixo'
    ? brl(item.preco_fixo)
    : item.tipo_desconto === 'valor'
      ? `− ${brl(item.desconto)}`
      : `− ${pct(item.desconto)}`;
  const tom = item.tipo_desconto === 'preco_fixo' ? 'tone-elevada' : 'tone-atencao';
  return (
    <tr>
      <td className="mono-ref">{item.referencia}</td>
      <td className="col-truncar">{item.descricao}</td>
      <td>
        <span className={'selo ' + tom}>
          {TIPOS_ITEM.find((t) => t.valor === item.tipo_desconto)?.rotulo || item.tipo_desconto}
        </span>
      </td>
      <td className="num">{rotulo}</td>
      <td style={{ textAlign: 'right' }}>
        <button type="button" className="icon-btn" title="Tirar da tabela" onClick={() => onRemover(item)}>
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

export default function TabelasPrecoPage() {
  const [tabelas, setTabelas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [mostrarInativas, setMostrarInativas] = useState(false);

  const [criando, setCriando] = useState(false);
  const [nova, setNova] = useState(tabelaVazia());
  const [salvando, setSalvando] = useState(false);

  const [abertaId, setAbertaId] = useState(null);
  const [aberta, setAberta] = useState(null);
  const [editando, setEditando] = useState(false);
  const [rascunho, setRascunho] = useState(null);

  const [buscaProduto, setBuscaProduto] = useState('');
  const [resultados, setResultados] = useState([]);
  const [novoItem, setNovoItem] = useState({ tipo_desconto: 'percentual', desconto: 0, preco_fixo: 0 });
  const [produtoEscolhido, setProdutoEscolhido] = useState(null);
  const buscaTimer = useRef(null);

  const [colando, setColando] = useState(false);
  const [textoColado, setTextoColado] = useState('');
  const [resultadoColagem, setResultadoColagem] = useState(null);

  const [precoSimulado, setPrecoSimulado] = useState(100);

  function carregar() {
    setLoading(true);
    setErro('');
    api.get('/tabelas-preco?incluir_inativas=1')
      .then(setTabelas)
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(carregar, []);

  useEffect(() => {
    if (!abertaId) { setAberta(null); return; }
    api.get(`/tabelas-preco/${abertaId}`).then(setAberta).catch((e) => setErro(e.message));
  }, [abertaId]);

  useEffect(() => {
    if (buscaTimer.current) clearTimeout(buscaTimer.current);
    if (!abertaId || !buscaProduto.trim()) { setResultados([]); return undefined; }
    buscaTimer.current = setTimeout(() => {
      api.get(`/tabelas-preco/${abertaId}/produtos?busca=${encodeURIComponent(buscaProduto)}`)
        .then(setResultados)
        .catch(() => setResultados([]));
    }, 300);
    return () => clearTimeout(buscaTimer.current);
  }, [buscaProduto, abertaId]);

  const lista = useMemo(
    () => tabelas.filter((t) => mostrarInativas || t.ativo),
    [tabelas, mostrarInativas]
  );

  async function criar(e) {
    e.preventDefault();
    if (!nova.nome.trim()) return;
    setSalvando(true);
    setErro('');
    try {
      const criada = await api.post('/tabelas-preco', nova);
      setNova(tabelaVazia());
      setCriando(false);
      carregar();
      setAbertaId(criada.id);
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function salvarEdicao() {
    setSalvando(true);
    setErro('');
    try {
      const atualizada = await api.put(`/tabelas-preco/${abertaId}`, rascunho);
      setAberta(atualizada);
      setEditando(false);
      carregar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function tornarPadrao(tabela) {
    try {
      await api.put(`/tabelas-preco/${tabela.id}`, { padrao: true });
      carregar();
      if (abertaId === tabela.id) setAberta((a) => ({ ...a, padrao: true }));
    } catch (err) {
      setErro(err.message);
    }
  }

  async function excluir(tabela) {
    if (!(await confirmar(`Excluir a tabela "${tabela.nome}"?`))) return;
    try {
      await api.del(`/tabelas-preco/${tabela.id}`);
      if (abertaId === tabela.id) setAbertaId(null);
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function adicionarItem() {
    if (!produtoEscolhido) return;
    setErro('');
    try {
      const atualizada = await api.post(`/tabelas-preco/${abertaId}/itens`, {
        produto_id: produtoEscolhido.id,
        tipo_desconto: novoItem.tipo_desconto,
        desconto: novoItem.desconto,
        preco_fixo: novoItem.preco_fixo,
      });
      setAberta(atualizada);
      setProdutoEscolhido(null);
      setBuscaProduto('');
      setResultados([]);
      setNovoItem({ tipo_desconto: novoItem.tipo_desconto, desconto: 0, preco_fixo: 0 });
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function removerItem(item) {
    try {
      const atualizada = await api.del(`/tabelas-preco/${abertaId}/itens/${item.id}`);
      setAberta(atualizada);
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  // Colar da planilha: uma linha por referência, separador ; , TAB ou espaço.
  // Referência que não existe no cadastro é RELATADA, nunca casada por
  // semelhança de nome (REGRA 2).
  async function importarColagem() {
    const linhas = textoColado
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((linha) => {
        // A VÍRGULA NÃO É SEPARADOR aqui: ela é a vírgula decimal do jeito
        // que a planilha escreve ("OG1620 ; 45,90"). Usá-la para separar
        // colunas partia o número em dois e gravava 45 no lugar de 45,90 —
        // e a tela dizia "importado com sucesso".
        const partes = linha.split(/[;\t]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
        const referencia = partes[0];
        const bruto = partes.slice(1).join(' ').trim();
        // O valor vai CRU para o servidor, que sabe ler "45,90", "1.234,50" e
        // "45.90" — e que recusa a linha quando não dá para ler, em vez de
        // transformá-la em zero.
        return {
          referencia,
          desconto: novoItem.tipo_desconto === 'percentual' ? percentualParaFracao(bruto) : bruto,
          preco_fixo: bruto,
          tipo_desconto: novoItem.tipo_desconto,
        };
      });
    if (linhas.length === 0) return;
    setErro('');
    try {
      const resposta = await api.post(`/tabelas-preco/${abertaId}/itens/em-lote`, {
        linhas,
        tipo_desconto: novoItem.tipo_desconto,
      });
      setAberta(resposta.tabela);
      setResultadoColagem(resposta);
      setTextoColado('');
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <div className="page-wide">
      <div className="pagina-topo">
        <div>
          <h1>Tabelas de Preço</h1>
          <p className="page-sub">
            Um preço para cada tipo de cliente. A tabela parte do preço que o sistema já calcula e
            aplica em cima dela o desconto que você definir — em percentual ou em reais. Nenhum
            custo, margem ou markup é alterado por aqui.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <label className="toggle">
            <Toggle checked={mostrarInativas} onChange={(e) => setMostrarInativas(e.target.checked)} />
            Mostrar desativadas
          </label>
          <button type="button" className="btn btn-primary" onClick={() => setCriando((v) => !v)}>
            <Plus size={14} /> Nova tabela
          </button>
        </div>
      </div>

      <AvisoDeFalha mensagem={erro} aoTentarDeNovo={carregar} />

      {criando && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={criar}>
          <div className="card-head">Nova tabela de preço</div>
          <div className="form-grid">
            <Field label="Nome" hint='Como você chama esse preço: "Atacado", "Lojista", "Revenda".'>
              <input value={nova.nome} onChange={(e) => setNova((t) => ({ ...t, nome: e.target.value }))} />
            </Field>
            <Field label="Descrição (opcional)">
              <input value={nova.descricao} onChange={(e) => setNova((t) => ({ ...t, descricao: e.target.value }))} />
            </Field>
            <Field label="Tipo do desconto geral">
              <Select value={nova.tipo_desconto} onChange={(e) => setNova((t) => ({ ...t, tipo_desconto: e.target.value }))}>
                <option value="percentual">Percentual (%)</option>
                <option value="valor">Valor em reais (R$ por peça)</option>
              </Select>
            </Field>
            <Field label={nova.tipo_desconto === 'valor' ? 'Desconto por peça' : 'Desconto geral'}>
              {nova.tipo_desconto === 'valor' ? (
                <NumInput value={nova.desconto_geral} onChange={(v) => setNova((t) => ({ ...t, desconto_geral: v }))} suffix="R$" />
              ) : (
                <NumInput
                  value={(Number(nova.desconto_geral) || 0) * 100}
                  onChange={(v) => setNova((t) => ({ ...t, desconto_geral: (Number(v) || 0) / 100 }))}
                  suffix="%"
                />
              )}
            </Field>
          </div>
          <label className="toggle" style={{ marginTop: 10 }}>
            <Toggle checked={nova.padrao} onChange={(e) => setNova((t) => ({ ...t, padrao: e.target.checked }))} />
            Usar como tabela padrão — todo pedido novo já nasce com ela
          </label>
          <div className="painel-acoes-inline" style={{ marginTop: 14 }}>
            <button type="submit" className="btn btn-primary" disabled={salvando || !nova.nome.trim()}>
              {salvando ? 'Criando…' : 'Criar tabela'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setCriando(false); setNova(tabelaVazia()); }}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {loading && tabelas.length === 0 && <Skeleton height={160} />}

      {!loading && lista.length === 0 && (
        <EstadoVazio
          Icone={Tags}
          titulo="Nenhuma tabela de preço cadastrada"
          descricao="Crie uma tabela para cada tipo de cliente (atacado, lojista, varejo) e escolha qual usar em cada venda."
          onAcao={() => setCriando(true)}
          acaoLabel="Nova tabela"
          IconeAcao={Plus}
        />
      )}

      <div className="vendas-cards">
        {lista.map((t) => {
          const desconto = descricaoDesconto(t);
          return (
            <div
              key={t.id}
              className={'tabela-preco-card'
                + (abertaId === t.id ? ' selecionada' : '')
                + (t.ativo ? '' : ' inativa')}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="vendedor-nome">{t.nome}</div>
                  {t.descricao && <div className="vendedor-sub">{t.descricao}</div>}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                    {t.padrao && <span className="selo tone-saudavel"><Star size={11} /> padrão</span>}
                    {!t.ativo && <span className="selo tone-neutro">desativada</span>}
                    {t.itens_especificos > 0 && (
                      <span className="venda-selo-tabela">{formatQtd(t.itens_especificos)} com preço próprio</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {!t.padrao && t.ativo && (
                    <button type="button" className="btn-icone" title="Tornar padrão" onClick={() => tornarPadrao(t)}>
                      <Star size={15} />
                    </button>
                  )}
                  {t.pedidos_usando === 0 && (
                    <button type="button" className="icon-btn" title="Excluir" onClick={() => excluir(t)}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>

              <div className="tabela-preco-desconto">
                {desconto.numero}
                <small>{desconto.texto}</small>
              </div>

              <div className="vendedor-sub">
                {t.pedidos_usando > 0
                  ? `${formatQtd(t.pedidos_usando)} pedido(s) já vendidos com esta tabela`
                  : 'Ainda não usada em nenhum pedido'}
              </div>

              <button
                type="button"
                className={'btn ' + (abertaId === t.id ? 'btn-ghost' : 'btn-dashed')}
                onClick={() => { setAbertaId(abertaId === t.id ? null : t.id); setEditando(false); }}
              >
                {abertaId === t.id ? 'Fechar' : 'Abrir e ajustar'}
              </button>
            </div>
          );
        })}
      </div>

      {aberta && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-head-linha">
            <div className="card-head">{aberta.nome} — ajustes</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setEditando((v) => !v); setRascunho({ ...aberta }); }}
              >
                <Pencil size={14} /> {editando ? 'Cancelar edição' : 'Editar dados'}
              </button>
              <button type="button" className="btn-icone" onClick={() => setAbertaId(null)} title="Fechar">
                <X size={16} />
              </button>
            </div>
          </div>

          {editando && rascunho && (
            <div style={{ marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid var(--border-soft)' }}>
              <div className="form-grid">
                <Field label="Nome">
                  <input value={rascunho.nome} onChange={(e) => setRascunho((r) => ({ ...r, nome: e.target.value }))} />
                </Field>
                <Field label="Descrição">
                  <input value={rascunho.descricao || ''} onChange={(e) => setRascunho((r) => ({ ...r, descricao: e.target.value }))} />
                </Field>
                <Field label="Tipo do desconto geral">
                  <Select value={rascunho.tipo_desconto} onChange={(e) => setRascunho((r) => ({ ...r, tipo_desconto: e.target.value }))}>
                    <option value="percentual">Percentual (%)</option>
                    <option value="valor">Valor em reais (R$ por peça)</option>
                  </Select>
                </Field>
                <Field label={rascunho.tipo_desconto === 'valor' ? 'Desconto por peça' : 'Desconto geral'}>
                  {rascunho.tipo_desconto === 'valor' ? (
                    <NumInput value={rascunho.desconto_geral} onChange={(v) => setRascunho((r) => ({ ...r, desconto_geral: v }))} suffix="R$" />
                  ) : (
                    <NumInput
                      value={(Number(rascunho.desconto_geral) || 0) * 100}
                      onChange={(v) => setRascunho((r) => ({ ...r, desconto_geral: (Number(v) || 0) / 100 }))}
                      suffix="%"
                    />
                  )}
                </Field>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
                <label className="toggle">
                  <Toggle checked={rascunho.padrao} onChange={(e) => setRascunho((r) => ({ ...r, padrao: e.target.checked }))} />
                  Tabela padrão
                </label>
                <label className="toggle">
                  <Toggle checked={rascunho.ativo} onChange={(e) => setRascunho((r) => ({ ...r, ativo: e.target.checked }))} />
                  Ativa
                </label>
              </div>
              <div className="painel-acoes-inline" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-primary" onClick={salvarEdicao} disabled={salvando}>
                  {salvando ? 'Salvando…' : 'Salvar'}
                </button>
              </div>
            </div>
          )}

          {/* Simulador — conferência visual, nada é gravado. */}
          <div className="duas-colunas" style={{ marginBottom: 18 }}>
            <div>
              <div className="card-head"><Calculator size={13} /> Como fica o preço</div>
              <div className="filtros-linha">
                <Field label="Preço no sistema">
                  <NumInput value={precoSimulado} onChange={setPrecoSimulado} suffix="R$" />
                </Field>
                <div style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
                  <div className="vendedor-numero-rotulo">Nesta tabela</div>
                  <div className="tabela-preco-desconto" style={{ fontSize: 22 }}>
                    {brl(simular(aberta, precoSimulado))}
                  </div>
                </div>
              </div>
              <div className="venda-ressalva">
                <Info size={14} />
                <span>
                  O preço de partida é o <strong>preço sugerido que o sistema já calcula</strong> para
                  a referência. Esta tela não muda custo, margem nem markup de nada — só o desconto
                  comercial aplicado na hora da venda.
                </span>
              </div>
            </div>

            <div>
              <div className="card-head">Preço próprio para uma referência</div>
              <Field label="Buscar referência" hint="Só entra quem existe no cadastro, casado pela referência exata.">
                <div className="campo-com-icone">
                  <Search size={14} />
                  <input
                    value={buscaProduto}
                    onChange={(e) => { setBuscaProduto(e.target.value); setProdutoEscolhido(null); }}
                    placeholder="Referência ou descrição"
                  />
                </div>
              </Field>
              {produtoEscolhido ? (
                <div className="venda-busca-linha" style={{ cursor: 'default', marginTop: 8 }}>
                  <div className="venda-busca-info">
                    <div className="venda-item-referencia">{produtoEscolhido.referencia}</div>
                    <div className="venda-item-descricao">{produtoEscolhido.descricao}</div>
                  </div>
                  <button type="button" className="btn-icone" title="Escolher outra referência" onClick={() => setProdutoEscolhido(null)}><X size={14} /></button>
                </div>
              ) : (
                resultados.length > 0 && (
                  <div className="venda-busca-resultados">
                    {resultados.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="venda-busca-linha"
                        onClick={() => setProdutoEscolhido(p)}
                      >
                        <div className="venda-busca-info">
                          <div className="venda-item-referencia">{p.referencia}</div>
                          <div className="venda-item-descricao">{p.descricao}</div>
                        </div>
                        {p.ja_na_tabela && <span className="selo tone-atencao">já tem preço próprio</span>}
                      </button>
                    ))}
                  </div>
                )
              )}

              <div className="form-linha" style={{ marginTop: 10 }}>
                <Field label="Como">
                  <Select value={novoItem.tipo_desconto} onChange={(e) => setNovoItem((n) => ({ ...n, tipo_desconto: e.target.value }))}>
                    {TIPOS_ITEM.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
                  </Select>
                </Field>
                <Field label={novoItem.tipo_desconto === 'preco_fixo' ? 'Preço' : 'Desconto'}>
                  {novoItem.tipo_desconto === 'percentual' ? (
                    <NumInput
                      value={(Number(novoItem.desconto) || 0) * 100}
                      onChange={(v) => setNovoItem((n) => ({ ...n, desconto: (Number(v) || 0) / 100 }))}
                      suffix="%"
                    />
                  ) : novoItem.tipo_desconto === 'valor' ? (
                    <NumInput value={novoItem.desconto} onChange={(v) => setNovoItem((n) => ({ ...n, desconto: v }))} suffix="R$" />
                  ) : (
                    <NumInput value={novoItem.preco_fixo} onChange={(v) => setNovoItem((n) => ({ ...n, preco_fixo: v }))} suffix="R$" />
                  )}
                </Field>
              </div>
              <div className="painel-acoes-inline" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-primary" onClick={adicionarItem} disabled={!produtoEscolhido}>
                  <Plus size={14} /> Acrescentar à tabela
                </button>
                <button type="button" className="btn btn-dashed" onClick={() => setColando((v) => !v)}>
                  <ClipboardPaste size={14} /> Colar lista da planilha
                </button>
              </div>

              {colando && (
                <div style={{ marginTop: 12 }}>
                  <Field
                    label="Uma referência por linha"
                    hint="Formato: referência ; valor. Ex.: OG1620 ; 15 — com o tipo escolhido acima."
                  >
                    <textarea rows={5} value={textoColado} onChange={(e) => setTextoColado(e.target.value)} />
                  </Field>
                  <div className="painel-acoes-inline" style={{ marginTop: 8 }}>
                    <button type="button" className="btn btn-primary" onClick={importarColagem} disabled={!textoColado.trim()}>
                      Importar
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => { setColando(false); setTextoColado(''); setResultadoColagem(null); }}>
                      Fechar
                    </button>
                  </div>
                  {resultadoColagem && (() => {
                    const problemas = (resultadoColagem.naoEncontradas?.length || 0)
                      + (resultadoColagem.valorIlegivel?.length || 0)
                      + (resultadoColagem.ambiguas?.length || 0);
                    return (
                      <div className={problemas > 0 ? 'aviso-inline' : 'sucesso-inline'} style={{ marginTop: 10 }}>
                        <span>
                          {formatQtd(resultadoColagem.aplicadas)} referência(s) aplicada(s).
                          {resultadoColagem.naoEncontradas?.length > 0 && (
                            <> Não existem no cadastro: <span className="mono">{resultadoColagem.naoEncontradas.join(', ')}</span>.</>
                          )}
                          {resultadoColagem.valorIlegivel?.length > 0 && (
                            <> Valor que não deu para ler (a linha ficou de fora, não virou zero):{' '}
                              <span className="mono">{resultadoColagem.valorIlegivel.join(', ')}</span>.
                            </>
                          )}
                          {resultadoColagem.ambiguas?.length > 0 && (
                            <> Existe mais de uma referência com esse nome, mudando só maiúsculas —
                              deixei de fora para não descontar na errada:{' '}
                              <span className="mono">{resultadoColagem.ambiguas.join(', ')}</span>.
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>

          <div className="card-head">
            Referências com preço próprio ({formatQtd(aberta.itens?.length || 0)})
          </div>
          {(aberta.itens || []).length === 0 ? (
            <p className="page-sub" style={{ margin: 0 }}>
              Nenhuma referência com preço próprio. Todas seguem o desconto geral da tabela.
            </p>
          ) : (
            <DataTable>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Referência</th>
                    <th>Descrição</th>
                    <th>Como</th>
                    <th className="num">Valor</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {aberta.itens.map((item) => (
                    <LinhaItem key={item.id} item={item} onRemover={removerItem} />
                  ))}
                </tbody>
              </table>
            </DataTable>
          )}
        </div>
      )}
    </div>
  );
}
