import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Barcode, Camera, Search, Trash2, UserPlus, CheckCircle2, XCircle, Copy,
  Plus, Minus, Tags, User, Info, RefreshCw, ChevronDown, ChevronUp, Printer, X,
} from 'lucide-react';
import { api } from '../api/client';
import { somAcerto, somErro } from '../lib/somConferencia';
import { Field, NumInput, Select, DateInput, Skeleton } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { brl, pct, formatQtd } from '../lib/format';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import LeitorCamera from '../components/LeitorCamera';
import { CampoNome, CampoTelefone, CampoCpfCnpj, CampoDesconto } from '../components/campos';

// Pedido de venda — repaginado em 09/09/2026.
//
// A tela mudou de lugar de uso: ela é aberta EM PÉ, no celular, com o cliente
// esperando. Três consequências que explicam quase todas as decisões daqui:
//
//   1. o campo de bipagem é a primeira coisa da tela e fica com o foco —
//      antes ele vinha depois de onze campos de cabeçalho;
//   2. o cabeçalho (empresa, operação, condição de pagamento…) começa
//      RECOLHIDO: no balcão só importa cliente, vendedor e tabela de preço;
//   3. cada item é um cartão com botões de 40px, não uma linha de tabela com
//      campos de 64px de largura — dedo não acerta campo de tabela.
//
// A bipagem tem dois caminhos, e os dois lançam pelo MESMO endpoint: leitor
// de código de barras comum (que digita no campo e dá Enter) e a câmera do
// celular (ver components/LeitorCamera.jsx).
//
// Pedido vindo de marketplace continua abrindo aqui, em modo leitura, com os
// blocos de taxa e repasse que já existiam — nada do módulo Marketplace mudou.

const SITUACAO_TONE = { aberto: 'tone-atencao', faturado: 'tone-saudavel', cancelado: 'tone-prejuizo' };
const SITUACAO_LABEL = { aberto: 'Aberto', faturado: 'Faturado', cancelado: 'Cancelado' };

function emptyNovoCliente() {
  return { tipo_pessoa: 'PF', nome: '', telefone: '', cpf_cnpj: '' };
}

export default function PedidoFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [pedido, setPedido] = useState(null);
  const [itens, setItens] = useState([]);
  const [listas, setListas] = useState(null);
  const [empresas, setEmpresas] = useState([]);
  const [vendedores, setVendedores] = useState([]);
  const [tabelas, setTabelas] = useState([]);
  const [error, setError] = useState('');
  const [duplicando, setDuplicando] = useState(false);
  const [salvandoHeader, setSalvandoHeader] = useState(false);
  const [detalhesAbertos, setDetalhesAbertos] = useState(false);

  const [buscaCliente, setBuscaCliente] = useState('');
  const [resultadosCliente, setResultadosCliente] = useState([]);
  const [mostrarNovoCliente, setMostrarNovoCliente] = useState(false);
  const [novoCliente, setNovoCliente] = useState(emptyNovoCliente());
  const buscaClienteTimer = useRef(null);

  const [ean, setEan] = useState('');
  const [qtdEan, setQtdEan] = useState(1);
  const eanRef = useRef(null);
  const [retorno, setRetorno] = useState(null);
  const [cameraAberta, setCameraAberta] = useState(false);
  const [ultimoItemId, setUltimoItemId] = useState(null);

  const [buscaProduto, setBuscaProduto] = useState('');
  const [resultadosProduto, setResultadosProduto] = useState([]);
  const [buscandoProduto, setBuscandoProduto] = useState(false);
  const [reaplicando, setReaplicando] = useState(false);

  // Faturamento e o contas a receber.
  //
  // Desde a ponte financeira (09/09/2026), faturar é o ato que cria o direito
  // de receber — e o servidor recusa o faturamento sem empresa, vencimento e
  // categoria do DRE. Recusa certa: título sem categoria some do DRE, e o
  // relatório que fecha bonito e está errado é pior que o relatório que falta.
  //
  // Só que devolver esse erro depois do clique deixaria a vendedora com um
  // recado que ela não sabe resolver, com o cliente na frente. Então os três
  // campos são pedidos ANTES, já preenchidos com o que dá para deduzir do
  // próprio pedido.
  const [fecharAberto, setFecharAberto] = useState(false);
  const [plano, setPlano] = useState([]);
  const [faturamento, setFaturamento] = useState({ empresa_id: '', plano_id: '', data_vencimento: '' });
  const [faturando, setFaturando] = useState(false);

  const aberto = pedido?.situacao === 'aberto';
  const deMarketplace = Boolean(pedido?.origem_marketplace);
  const voltarPara = deMarketplace ? '/marketplace/pedidos' : '/pedidos';

  function aplicarResposta(data) {
    setPedido(data.pedido);
    setItens(data.itens);
  }

  const load = useCallback(() => {
    setError('');
    api.get(`/pedidos/${id}`)
      .then(aplicarResposta)
      // Sem catch, um pedido que não carrega (excluído, sem permissão, sessão
      // caída) deixava a tela presa numa página em branco.
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    Promise.all([
      api.get('/listas'),
      api.get('/empresas'),
      api.get('/vendedores').catch(() => []),
      api.get('/tabelas-preco').catch(() => []),
      // O plano de contas pode não estar liberado para quem só tem Vendas —
      // nesse caso o seletor aparece vazio e a mensagem do servidor orienta.
      api.get('/financeiro-nucleo/plano').catch(() => []),
    ])
      .then(([l, e, v, t, p]) => {
        setListas(l); setEmpresas(e); setVendedores(v); setTabelas(t);
        setPlano(Array.isArray(p) ? p : []);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  // Foco no campo de bipagem — inclusive depois de escolher o cliente, que
  // refaz o pedido inteiro e deixava o cursor em lugar nenhum.
  useEffect(() => {
    if (pedido?.situacao === 'aberto' && !cameraAberta) eanRef.current?.focus();
  }, [pedido?.situacao, pedido?.cliente_id, cameraAberta]);

  useEffect(() => {
    if (buscaClienteTimer.current) clearTimeout(buscaClienteTimer.current);
    if (!buscaCliente.trim()) { setResultadosCliente([]); return undefined; }
    let vivo = true;
    buscaClienteTimer.current = setTimeout(() => {
      api.get(`/clientes?busca=${encodeURIComponent(buscaCliente)}`)
        .then((r) => { if (vivo) setResultadosCliente(r); })
        .catch(() => { if (vivo) setResultadosCliente([]); });
    }, 300);
    // Sair da tela com uma busca pendente disparava a chamada e o setState
    // depois do desmonte.
    return () => { vivo = false; clearTimeout(buscaClienteTimer.current); };
  }, [buscaCliente]);

  function setHeader(patch) {
    setPedido((p) => ({ ...p, ...patch }));
  }

  async function salvarHeader(patchExtra) {
    setSalvandoHeader(true);
    setError('');
    try {
      const body = patchExtra || {
        data_pedido: pedido.data_pedido?.slice(0, 10),
        cliente_id: pedido.cliente_id,
        empresa_id: pedido.empresa_id,
        vendedor: pedido.vendedor,
        vendedor_id: pedido.vendedor_id,
        tabela_preco_id: pedido.tabela_preco_id,
        operacao: pedido.operacao,
        canal_venda: pedido.canal_venda,
        condicao_pagamento: pedido.condicao_pagamento,
        forma_pagamento: pedido.forma_pagamento,
        desconto_pct: pedido.desconto_pct,
        desconto_valor: pedido.desconto_valor,
        acrescimo: pedido.acrescimo,
        valor_frete: pedido.valor_frete,
        observacao: pedido.observacao,
      };
      const data = await api.put(`/pedidos/${id}`, body);
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSalvandoHeader(false);
    }
  }

  // Trocar o vendedor grava também o nome em texto: o campo antigo continua
  // alimentado, para nenhum relatório ou exportação anterior ficar vazio.
  function trocarVendedor(valor) {
    const vendedorId = valor ? Number(valor) : null;
    const vendedor = vendedores.find((v) => v.id === vendedorId);
    setHeader({ vendedor_id: vendedorId, vendedor: vendedor?.nome || null });
    salvarHeader({ vendedor_id: vendedorId, vendedor: vendedor?.nome || null });
  }

  async function trocarTabela(valor) {
    const tabelaId = valor ? Number(valor) : null;
    setHeader({ tabela_preco_id: tabelaId });
    await salvarHeader({ tabela_preco_id: tabelaId });
    if (tabelaId && itens.length > 0) {
      const tabela = tabelas.find((t) => t.id === tabelaId);
      const querReaplicar = await confirmar(
        `Refazer o preço dos ${itens.length} ${itens.length === 1 ? 'item já lançado' : 'itens já lançados'} `
        + `com a tabela "${tabela?.nome || 'escolhida'}"? Quem já teve o preço digitado à mão também será refeito.`,
        { confirmarTexto: 'Refazer preços', perigo: false }
      );
      if (querReaplicar) reaplicarTabela(tabelaId);
    }
  }

  async function reaplicarTabela(tabelaId) {
    setReaplicando(true);
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/reaplicar-tabela-preco`, { tabela_preco_id: tabelaId || pedido.tabela_preco_id });
      aplicarResposta(data);
      if (data.reaplicacao?.semPreco?.length > 0) {
        setRetorno({
          ok: false,
          texto: `Refiz ${data.reaplicacao.atualizados} item(ns). Ficaram como estavam (sem preço no cadastro): ${data.reaplicacao.semPreco.join(', ')}.`,
        });
      } else {
        setRetorno({ ok: true, texto: `Preços refeitos em ${data.reaplicacao?.atualizados || 0} item(ns).` });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setReaplicando(false);
    }
  }

  function selecionarCliente(cliente) {
    setHeader({
      cliente_id: cliente.id,
      cliente_nome: cliente.nome,
      cliente_cpf_cnpj: cliente.cpf_cnpj,
      cliente_telefone: cliente.telefone,
    });
    setBuscaCliente('');
    setResultadosCliente([]);
    // Cliente com tabela e vendedor próprios traz os dois junto — é o que
    // evita vender no preço de varejo para um lojista por esquecimento.
    const patch = { cliente_id: cliente.id };
    if (cliente.tabela_preco_id && !pedido.tabela_preco_id) patch.tabela_preco_id = cliente.tabela_preco_id;
    if (cliente.vendedor_id && !pedido.vendedor_id) {
      patch.vendedor_id = cliente.vendedor_id;
      const v = vendedores.find((x) => x.id === cliente.vendedor_id);
      if (v) patch.vendedor = v.nome;
    }
    salvarHeader(patch);
  }

  async function criarClienteRapido(e) {
    e.preventDefault();
    if (!novoCliente.nome.trim()) return;
    try {
      const created = await api.post('/clientes', novoCliente);
      selecionarCliente(created);
      setNovoCliente(emptyNovoCliente());
      setMostrarNovoCliente(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // Um caminho só para as duas formas de bipar (leitor e câmera).
  const lancarCodigo = useCallback(async (codigo, quantidade = 1) => {
    const limpo = String(codigo || '').trim();
    if (!limpo) return;
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/itens`, { ean: limpo, quantidade: Number(quantidade) || 1 });
      aplicarResposta(data);
      setUltimoItemId(data.itemAdicionado?.id || null);
      const item = data.itemAdicionado;
      const semEstoque = Number(data.estoqueDisponivel) <= 0;
      setRetorno({
        ok: true,
        texto: `${item?.referencia || limpo} · ${[item?.cor, item?.tamanho].filter(Boolean).join(' ')} · ${brl(item?.valor_unitario)}`
          + (data.tabelaAplicada ? ` · tabela ${data.tabelaAplicada.nome}` : ''),
        aviso: semEstoque ? 'Sem saldo em estoque para essa grade.' : null,
      });
      setEan('');
      // A quantidade volta para 1. Quem digitava 5 numa peça e bipava a
      // próxima lançava 5 unidades da segunda sem perceber — é o erro de
      // estoque mais caro e mais provável desta tela.
      setQtdEan(1);
      somAcerto();
    } catch (err) {
      setRetorno({ ok: false, texto: err.message });
      somErro();
    } finally {
      if (!cameraAberta) eanRef.current?.focus();
    }
  }, [id, cameraAberta]);

  function lancarPorEan(e) {
    e.preventDefault();
    if (!ean.trim()) { eanRef.current?.focus(); return; }
    lancarCodigo(ean, qtdEan);
  }

  async function buscarProduto(e) {
    e?.preventDefault();
    if (!buscaProduto.trim()) { setResultadosProduto([]); return; }
    setBuscandoProduto(true);
    try {
      const params = new URLSearchParams({ busca: buscaProduto, com_preco: '1' });
      if (pedido?.tabela_preco_id) params.set('tabela_preco_id', pedido.tabela_preco_id);
      const data = await api.get(`/pedidos/buscar-estoque?${params.toString()}`);
      setResultadosProduto(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBuscandoProduto(false);
    }
  }

  async function adicionarVariante(variante) {
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/itens`, { variante_id: variante.id, quantidade: 1 });
      aplicarResposta(data);
      setUltimoItemId(data.itemAdicionado?.id || null);
      setRetorno({
        ok: true,
        texto: `${variante.referencia} · ${[variante.cor, variante.tamanho].filter(Boolean).join(' ')} · ${brl(data.itemAdicionado?.valor_unitario)}`,
      });
      somAcerto();
    } catch (err) {
      setError(err.message);
      somErro();
    }
  }

  async function atualizarItem(itemId, patch) {
    try {
      const data = await api.put(`/pedidos/${id}/itens/${itemId}`, patch);
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  // Preço e desconto gravam sozinhos 600ms depois de parar de digitar.
  //
  // Por que não no `blur`: o campo de número devolve o valor pelo onChange e
  // dispara o blur no MESMO ciclo — o handler de blur enxergaria o valor
  // anterior e gravaria o número errado. Com o atraso, o que vai para o
  // servidor é sempre o último valor digitado.
  const timersItem = useRef({});
  function alterarCampoItem(itemId, campo, valor) {
    setItens((lista) => lista.map((x) => (x.id === itemId ? { ...x, [campo]: valor } : x)));
    const chave = `${itemId}:${campo}`;
    clearTimeout(timersItem.current[chave]);
    timersItem.current[chave] = setTimeout(() => atualizarItem(itemId, { [campo]: valor }), 600);
  }

  useEffect(() => () => {
    for (const t of Object.values(timersItem.current)) clearTimeout(t);
  }, []);

  async function mudarQuantidade(item, delta) {
    const nova = Math.max(1, (Number(item.quantidade) || 1) + delta);
    await atualizarItem(item.id, { quantidade: nova });
  }

  async function removerItem(item) {
    if (!(await confirmar(`Tirar ${item.referencia || 'este item'} do pedido?`, { confirmarTexto: 'Tirar do pedido' }))) return;
    try {
      const data = await api.del(`/pedidos/${id}/itens/${item.id}`);
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  // Vencimento sugerido: hoje para pagamento à vista, e 30 dias quando a
  // condição do pedido fala em prazo. É sugestão — quem fecha confere.
  function vencimentoSugerido() {
    const dias = /30\/60\/90/.test(pedido?.condicao_pagamento || '') ? 90
      : /30\/60/.test(pedido?.condicao_pagamento || '') ? 60
        : /30/.test(pedido?.condicao_pagamento || '') ? 30 : 0;
    const base = new Date();
    base.setDate(base.getDate() + dias);
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  }

  function abrirFaturamento() {
    setFaturamento({
      empresa_id: pedido.empresa_id ? String(pedido.empresa_id) : '',
      plano_id: '',
      data_vencimento: vencimentoSugerido(),
    });
    setFecharAberto(true);
  }

  async function faturarPedido() {
    setError('');
    setFaturando(true);
    try {
      const data = await api.post(`/pedidos/${id}/faturar`, {
        empresa_id: faturamento.empresa_id || null,
        plano_id: faturamento.plano_id || null,
        data_vencimento: faturamento.data_vencimento || null,
      });
      aplicarResposta(data);
      setFecharAberto(false);
      setRetorno({ ok: true, texto: 'Pedido faturado. O estoque foi baixado e o contas a receber foi criado.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setFaturando(false);
    }
  }

  async function cancelarPedido() {
    const msg = pedido.situacao === 'faturado'
      ? 'Cancelar este pedido faturado? O estoque de cada item será estornado (devolvido) automaticamente.'
      : 'Cancelar este pedido?';
    if (!(await confirmar(msg, { confirmarTexto: 'Cancelar pedido' }))) return;
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/cancelar`, {});
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  // Duplicar: mesmo mix, pedido novo. Os valores são COPIADOS pelo servidor,
  // não recalculados — se o preço mudou, quem decide é quem está vendendo.
  async function duplicarPedido() {
    if (!(await confirmar(
      `Criar um pedido novo com os mesmos ${itens.length} ${itens.length === 1 ? 'item' : 'itens'} deste? `
      + 'Os preços vêm copiados exatamente como estão aqui — se algum mudou, ajuste no pedido novo.',
      { confirmarTexto: 'Duplicar', perigo: false }
    ))) return;
    setError('');
    setDuplicando(true);
    try {
      const data = await api.post(`/pedidos/${id}/duplicar`, {});
      navigate(`/pedidos/${data.pedido.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDuplicando(false);
    }
  }

  async function excluirPedido() {
    if (!(await confirmar('Excluir este pedido em aberto? Essa ação não pode ser desfeita.'))) return;
    try {
      await api.del(`/pedidos/${id}`);
      navigate(voltarPara);
    } catch (err) {
      setError(err.message);
    }
  }

  const vendedoresDisponiveis = useMemo(() => {
    // Vendedor desativado que já está neste pedido continua aparecendo no
    // seletor — senão o campo abriria vazio e a primeira gravação apagaria
    // o vendedor de uma venda antiga.
    const lista = vendedores.filter((v) => v.ativo);
    if (pedido?.vendedor_id && !lista.some((v) => v.id === pedido.vendedor_id)) {
      lista.unshift({ id: pedido.vendedor_id, nome: pedido.vendedor_nome || pedido.vendedor || 'vendedor desativado' });
    }
    return lista;
  }, [vendedores, pedido?.vendedor_id, pedido?.vendedor_nome, pedido?.vendedor]);

  const tabelasDisponiveis = useMemo(() => {
    const lista = tabelas.filter((t) => t.ativo);
    if (pedido?.tabela_preco_id && !lista.some((t) => t.id === pedido.tabela_preco_id)) {
      lista.unshift({ id: pedido.tabela_preco_id, nome: pedido.tabela_preco_nome || 'tabela desativada' });
    }
    return lista;
  }, [tabelas, pedido?.tabela_preco_id, pedido?.tabela_preco_nome]);

  if (!pedido) {
    return (
      <div className="page-wide">
        <button type="button" className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate(voltarPara)}>
          <ArrowLeft size={14} /> Voltar para pedidos
        </button>
        {error
          ? <div className="login-error" role="alert">Não deu para abrir este pedido: {error}</div>
          : <Skeleton height={200} />}
      </div>
    );
  }

  const totalPecas = Number(pedido.quantidade_pecas) || 0;

  return (
    <div className="page-wide">
      <button type="button" className="btn btn-ghost" style={{ marginBottom: 12 }} onClick={() => navigate(voltarPara)}>
        <ArrowLeft size={14} /> Voltar para pedidos
      </button>

      <div className="venda-topo">
        <div className="venda-topo-identidade">
          <h1>Pedido #{pedido.numero}</h1>
          <span className={'stamp sm ' + (SITUACAO_TONE[pedido.situacao] || 'tone-neutro')}>
            {SITUACAO_LABEL[pedido.situacao] || pedido.situacao}
          </span>
          {pedido.vendedor_nome && (
            <span className="venda-selo-vendedor"><User size={11} /> {pedido.vendedor_nome}</span>
          )}
          {pedido.tabela_preco_nome && (
            <span className="venda-selo-tabela"><Tags size={11} /> {pedido.tabela_preco_nome}</span>
          )}
        </div>
        <div className="venda-topo-acoes">
          {/* Duplicar vale para pedido em qualquer situação: o caso mais
              comum é justamente repetir um pedido JÁ FATURADO do mês
              passado. Pedido de marketplace não entra — a cópia seria uma
              venda manual carregando o canal da plataforma, sem existir lá. */}
          {!deMarketplace && !pedido.origem_pedido_id && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={duplicarPedido}
              disabled={itens.length === 0 || duplicando}
              title={itens.length === 0 ? 'Um pedido sem itens não tem o que duplicar.' : 'Cria um pedido novo com os mesmos itens e preços.'}
            >
              <Copy size={14} /> {duplicando ? 'Duplicando…' : 'Duplicar'}
            </button>
          )}
          {pedido.situacao !== 'aberto' && (
            <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
              <Printer size={14} /> Imprimir
            </button>
          )}
          {pedido.situacao !== 'cancelado' && (
            <button type="button" className="btn btn-ghost" onClick={cancelarPedido}>
              <XCircle size={14} /> Cancelar pedido
            </button>
          )}
          {aberto && (
            <button type="button" className="btn btn-ghost" onClick={excluirPedido} style={{ color: 'var(--danger)' }}>
              <Trash2 size={14} /> Excluir
            </button>
          )}
        </div>
      </div>

      {error && <div className="login-error" role="alert">{error}</div>}

      {/* Os quatro números que precisam ficar visíveis o tempo todo. */}
      <div className="venda-resumo-fixo no-print">
        <div className="venda-resumo-item">
          <span className="venda-resumo-rotulo">Peças</span>
          <span className="venda-resumo-valor">{formatQtd(totalPecas)}</span>
        </div>
        <div className="venda-resumo-item">
          <span className="venda-resumo-rotulo">Bruto</span>
          <span className="venda-resumo-valor">{brl(pedido.total_bruto)}</span>
        </div>
        <div className="venda-resumo-item">
          <span className="venda-resumo-rotulo">Descontos</span>
          <span className="venda-resumo-valor">{brl(pedido.total_desconto)}</span>
        </div>
        <div className="venda-resumo-item destaque">
          <span className="venda-resumo-rotulo">Total da venda</span>
          <span className="venda-resumo-valor">{brl(pedido.total_liquido)}</span>
        </div>
      </div>

      {/* ---- Bipagem: o primeiro bloco da tela, com o foco ---- */}
      {aberto && !deMarketplace && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Lançar peça</div>
          <form className="venda-bipagem" onSubmit={lancarPorEan}>
            <div className="venda-bipagem-campo">
              <Field label="Código de barras — bipe, digite ou use a câmera">
                <input
                  ref={eanRef}
                  value={ean}
                  onChange={(e) => setEan(e.target.value)}
                  autoComplete="off"
                  inputMode="numeric"
                  placeholder="Bipe a etiqueta"
                />
              </Field>
            </div>
            <div className="venda-bipagem-acoes">
              <div style={{ width: 120 }}>
                <Field label="Qtd.">
                  <div className="venda-qtd">
                    <button type="button" onClick={() => setQtdEan((q) => Math.max(1, Number(q) - 1))} aria-label="Menos um">
                      <Minus size={15} />
                    </button>
                    <input
                      type="number"
                      min="1"
                      value={qtdEan}
                      onChange={(e) => setQtdEan(e.target.value)}
                      aria-label="Quantidade a lançar"
                    />
                    <button type="button" onClick={() => setQtdEan((q) => Number(q) + 1)} aria-label="Mais um">
                      <Plus size={15} />
                    </button>
                  </div>
                </Field>
              </div>
              <button type="submit" className="btn btn-primary"><Barcode size={15} /> Lançar</button>
              <button
                type="button"
                className="btn btn-ghost venda-bipagem-camera"
                onClick={() => setCameraAberta(true)}
                title="Ler o código com a câmera do celular"
              >
                <Camera size={16} />
              </button>
            </div>
          </form>

          {retorno && (
            <div className={'venda-bipagem-retorno ' + (retorno.ok ? 'ok' : 'erro')} role="status">
              {retorno.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              <span>
                {retorno.texto}
                {retorno.aviso && <> — <strong>{retorno.aviso}</strong></>}
              </span>
              <button
                type="button"
                className="btn-icone"
                style={{ marginLeft: 'auto' }}
                onClick={() => setRetorno(null)}
                aria-label="Fechar aviso"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Busca por referência — o caminho para peça sem etiqueta. */}
          <form onSubmit={buscarProduto} style={{ marginTop: 14 }}>
            <Field label="Ou procure por referência, descrição ou SKU">
              <div className="campo-com-icone">
                <Search size={14} />
                <input
                  value={buscaProduto}
                  onChange={(e) => setBuscaProduto(e.target.value)}
                  placeholder="Ex.: OG1620, camiseta dry fit"
                />
              </div>
            </Field>
          </form>
          {buscandoProduto && <p className="page-sub" style={{ marginTop: 8 }}>Procurando…</p>}
          {resultadosProduto.length > 0 && (
            <div className="venda-busca-resultados">
              {resultadosProduto.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className="venda-busca-linha"
                  onClick={() => adicionarVariante(v)}
                >
                  <div className="venda-busca-info">
                    <div className="venda-item-referencia">{v.referencia}</div>
                    <div className="venda-item-descricao">{v.descricao}</div>
                    <div className="venda-item-grade">
                      {[v.cor, v.tamanho].filter(Boolean).join(' · ')}
                      {' · '}
                      <span className={Number(v.quantidade) > 0 ? '' : 'ink-prejuizo'}>
                        {formatQtd(v.quantidade)} em estoque
                      </span>
                    </div>
                  </div>
                  <div className="venda-busca-preco">
                    {v.precoVenda != null ? (
                      <>
                        <span className="mono">{brl(v.precoVenda)}</span>
                        {v.precoBase != null && v.precoVenda < v.precoBase && (
                          <small>de {brl(v.precoBase)}</small>
                        )}
                      </>
                    ) : <small>sem preço no cadastro</small>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Cliente, vendedor e tabela: o que importa no balcão ---- */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Quem compra e quem vende</div>

        {pedido.cliente_id ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <strong>{pedido.cliente_nome}</strong>
              <div className="venda-item-grade">
                {[pedido.cliente_cpf_cnpj, pedido.cliente_telefone].filter(Boolean).join(' · ') || 'Sem documento ou telefone cadastrado'}
              </div>
            </div>
            {aberto && !deMarketplace && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setHeader({ cliente_id: null, cliente_nome: '', cliente_cpf_cnpj: '', cliente_telefone: '' })}
              >
                Trocar cliente
              </button>
            )}
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div className="campo-com-icone" style={{ flex: 1, minWidth: 200 }}>
                <Search size={14} />
                <input
                  placeholder="Buscar cliente por nome, CPF/CNPJ ou telefone"
                  value={buscaCliente}
                  onChange={(e) => setBuscaCliente(e.target.value)}
                />
              </div>
              <button type="button" className="btn btn-dashed" onClick={() => setMostrarNovoCliente((v) => !v)}>
                <UserPlus size={14} /> Novo cliente
              </button>
            </div>
            {resultadosCliente.length > 0 && (
              <div className="venda-busca-resultados">
                {resultadosCliente.map((c) => (
                  <button key={c.id} type="button" className="venda-busca-linha" onClick={() => selecionarCliente(c)}>
                    <div className="venda-busca-info">
                      <strong>{c.nome}</strong>
                      <div className="venda-item-grade">
                        {[c.cpf_cnpj, c.telefone].filter(Boolean).join(' · ') || 'sem documento'}
                      </div>
                    </div>
                    <span className="selo tone-neutro">selecionar</span>
                  </button>
                ))}
              </div>
            )}
            {mostrarNovoCliente && (
              <form onSubmit={criarClienteRapido} className="form-linha" style={{ marginTop: 12, alignItems: 'flex-end' }}>
                <Field label="Nome">
                  <CampoNome pessoaFisica={novoCliente.tipo_pessoa !== 'PJ'} value={novoCliente.nome} onChange={(e) => setNovoCliente((c) => ({ ...c, nome: e.target.value }))} />
                </Field>
                <Field label="Telefone">
                  <CampoTelefone value={novoCliente.telefone} onChange={(e) => setNovoCliente((c) => ({ ...c, telefone: e.target.value }))} />
                </Field>
                <Field label="CPF/CNPJ">
                  <CampoCpfCnpj value={novoCliente.cpf_cnpj} onChange={(e) => setNovoCliente((c) => ({ ...c, cpf_cnpj: e.target.value }))} />
                </Field>
                <button className="btn btn-primary" type="submit">Criar e usar</button>
              </form>
            )}
            <p className="page-sub" style={{ marginTop: 10, marginBottom: 0 }}>
              Venda sem cliente cadastrado funciona — só não entra nos relatórios por cliente.
            </p>
          </div>
        )}

        {!deMarketplace && (
          <div className="form-grid" style={{ marginTop: 16 }}>
            <Field
              label="Vendedor"
              hint={pedido.vendedor_id ? undefined : 'Sem vendedor, a venda não entra no relatório de comissão.'}
            >
              <Select
                disabled={!aberto}
                value={pedido.vendedor_id || ''}
                onChange={(e) => trocarVendedor(e.target.value)}
              >
                <option value="">Sem vendedor</option>
                {vendedoresDisponiveis.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
              </Select>
            </Field>
            <Field label="Tabela de preço" hint="Muda o preço das próximas peças lançadas.">
              <Select
                disabled={!aberto}
                value={pedido.tabela_preco_id || ''}
                onChange={(e) => trocarTabela(e.target.value)}
              >
                <option value="">Preço cheio (sem tabela)</option>
                {tabelasDisponiveis.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
              </Select>
            </Field>
          </div>
        )}

        {aberto && !deMarketplace && pedido.tabela_preco_id && itens.length > 0 && (
          <div className="painel-acoes-inline" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-dashed sm" onClick={() => reaplicarTabela()} disabled={reaplicando}>
              <RefreshCw size={13} /> {reaplicando ? 'Refazendo…' : 'Refazer preços com esta tabela'}
            </button>
          </div>
        )}
      </div>

      {/* ---- Itens ---- */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head-linha">
          <div className="card-head">Itens da venda ({formatQtd(itens.length)})</div>
          {itens.length > 0 && (
            <span className="page-sub" style={{ margin: 0 }}>{formatQtd(totalPecas)} peça(s)</span>
          )}
        </div>

        {itens.length === 0 ? (
          <p className="page-sub" style={{ margin: 0 }}>
            {aberto
              ? 'Nenhuma peça lançada ainda. Bipe a etiqueta ou procure pela referência acima.'
              : 'Este pedido não tem itens.'}
          </p>
        ) : (
          <div className="venda-itens-lista">
            {itens.map((it) => (
              <div key={it.id} className={'venda-item-card' + (ultimoItemId === it.id ? ' recem-lancado' : '')}>
                <div className="venda-item-cabecalho">
                  <div className="venda-item-identidade">
                    <div className="venda-item-referencia">{it.referencia || it.sku_externo || '—'}</div>
                    <div className="venda-item-descricao">{it.descricao || it.titulo_externo || 'Sem descrição'}</div>
                    <div className="venda-item-grade">
                      {[it.cor, it.tamanho].filter(Boolean).join(' · ') || 'sem grade'}
                    </div>
                  </div>
                  <div className="venda-item-total">{brl(it.total)}</div>
                </div>

                {aberto && !deMarketplace ? (
                  <>
                    <div className="venda-item-campos">
                      <Field label="Quantidade">
                        <div className="venda-qtd">
                          <button
                            type="button"
                            onClick={() => mudarQuantidade(it, -1)}
                            disabled={Number(it.quantidade) <= 1}
                            aria-label="Menos um"
                          >
                            <Minus size={15} />
                          </button>
                          <input
                            type="number"
                            min="0.01"
                            step="1"
                            value={it.quantidade}
                            onChange={(e) => setItens((lista) => lista.map((x) => (x.id === it.id ? { ...x, quantidade: e.target.value } : x)))}
                            onBlur={(e) => atualizarItem(it.id, { quantidade: e.target.value })}
                            aria-label="Quantidade"
                          />
                          <button type="button" onClick={() => mudarQuantidade(it, 1)} aria-label="Mais um">
                            <Plus size={15} />
                          </button>
                        </div>
                      </Field>
                      <Field label="Preço unitário">
                        <NumInput
                          value={it.valor_unitario}
                          onChange={(v) => alterarCampoItem(it.id, 'valor_unitario', v)}
                          suffix="R$"
                        />
                      </Field>
                      <Field label="Desconto">
                        <CampoDesconto
                          value={(Number(it.desconto_pct) || 0) * 100}
                          onChange={(v) => alterarCampoItem(it.id, 'desconto_pct', (Number(v) || 0) / 100)}
                        />
                      </Field>
                    </div>
                    <div className="venda-item-rodape">
                      <span className="venda-item-nota">
                        {Number(it.desconto_valor) > 0
                          ? `Desconto de ${brl(it.desconto_valor)} nesta linha`
                          : 'Sem desconto nesta linha'}
                      </span>
                      <button type="button" className="icon-btn perigo" onClick={() => removerItem(it)} title="Tirar do pedido">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="venda-item-rodape">
                    <span className="venda-item-nota">
                      {formatQtd(it.quantidade)} × {brl(it.valor_unitario)}
                      {Number(it.desconto_pct) > 0 && ` · ${pct(it.desconto_pct)} de desconto`}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Cabeçalho completo: recolhido por padrão ---- */}
      <div className="card" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="card-head-linha"
          onClick={() => setDetalhesAbertos((v) => !v)}
          style={{ width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          <div className="card-head">Dados do pedido, desconto e frete</div>
          {detalhesAbertos ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        {detalhesAbertos && (
          <>
            <div className="form-grid">
              <Field label="Data do pedido">
                <DateInput
                  disabled={!aberto}
                  value={pedido.data_pedido?.slice(0, 10) || ''}
                  onChange={(e) => setHeader({ data_pedido: e.target.value })}
                  onBlur={() => salvarHeader()}
                />
              </Field>
              <Field label="Empresa (emitente)">
                <Select
                  disabled={!aberto}
                  value={pedido.empresa_id || ''}
                  onChange={(e) => { setHeader({ empresa_id: e.target.value || null }); salvarHeader({ empresa_id: e.target.value || null }); }}
                >
                  <option value="">—</option>
                  {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
                </Select>
              </Field>
              <Field label="Operação">
                <Select
                  disabled={!aberto}
                  value={pedido.operacao || ''}
                  onChange={(e) => { setHeader({ operacao: e.target.value }); salvarHeader({ operacao: e.target.value }); }}
                >
                  {listas?.operacao.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
                </Select>
              </Field>
              <Field label="Canal de venda">
                <Select
                  disabled={!aberto}
                  value={pedido.canal_venda || ''}
                  onChange={(e) => { setHeader({ canal_venda: e.target.value }); salvarHeader({ canal_venda: e.target.value }); }}
                >
                  <option value="">—</option>
                  {listas?.canal_venda.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
                </Select>
              </Field>
              <Field label="Condição de pagamento">
                <Select
                  disabled={!aberto}
                  value={pedido.condicao_pagamento || ''}
                  onChange={(e) => { setHeader({ condicao_pagamento: e.target.value }); salvarHeader({ condicao_pagamento: e.target.value }); }}
                >
                  <option value="">—</option>
                  {listas?.condicao_pagamento.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
                </Select>
              </Field>
              <Field label="Forma de pagamento">
                <Select
                  disabled={!aberto}
                  value={pedido.forma_pagamento || ''}
                  onChange={(e) => { setHeader({ forma_pagamento: e.target.value }); salvarHeader({ forma_pagamento: e.target.value }); }}
                >
                  <option value="">—</option>
                  {listas?.forma_pagamento.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
                </Select>
              </Field>
              <Field label="Desconto no total (%)">
                <CampoDesconto
                  disabled={!aberto}
                  value={(Number(pedido.desconto_pct) || 0) * 100}
                  onChange={(v) => setHeader({ desconto_pct: (Number(v) || 0) / 100 })}
                  onBlur={() => salvarHeader()}
                />
              </Field>
              <Field label="Desconto no total (R$)" hint="Use um ou outro — o percentual manda quando os dois estão preenchidos.">
                <NumInput
                  disabled={!aberto}
                  value={pedido.desconto_valor}
                  onChange={(v) => setHeader({ desconto_valor: v })}
                  onBlur={() => salvarHeader()}
                  suffix="R$"
                />
              </Field>
              <Field label="Acréscimo">
                <NumInput disabled={!aberto} value={pedido.acrescimo} onChange={(v) => setHeader({ acrescimo: v })} onBlur={() => salvarHeader()} suffix="R$" />
              </Field>
              <Field label="Frete cobrado">
                <NumInput disabled={!aberto} value={pedido.valor_frete} onChange={(v) => setHeader({ valor_frete: v })} onBlur={() => salvarHeader()} suffix="R$" />
              </Field>
            </div>
            <Field label="Observação">
              <textarea
                disabled={!aberto}
                rows={2}
                value={pedido.observacao || ''}
                onChange={(e) => setHeader({ observacao: e.target.value })}
                onBlur={() => salvarHeader()}
              />
            </Field>
            {salvandoHeader && <p className="page-sub" style={{ marginTop: 6 }}>Salvando…</p>}
          </>
        )}
      </div>

      {/* ---- Totais e, no marketplace, o repasse ---- */}
      <div className="card">
        <div className="card-head">Totais</div>
        <div className="cascata-lucro">
          <div className="cascata-linha">
            <span className="cascata-rotulo">Peças</span>
            <span className="cascata-valor">{formatQtd(totalPecas)}</span>
          </div>
          <div className="cascata-linha">
            <span className="cascata-rotulo">Total bruto</span>
            <span className="cascata-valor">{brl(pedido.total_bruto)}</span>
          </div>
          <div className="cascata-linha subtrai">
            <span className="cascata-rotulo">Descontos</span>
            <span className="cascata-valor">− {brl(pedido.total_desconto)}</span>
          </div>
          {Number(pedido.acrescimo) > 0 && (
            <div className="cascata-linha">
              <span className="cascata-rotulo">Acréscimo</span>
              <span className="cascata-valor">{brl(pedido.acrescimo)}</span>
            </div>
          )}
          {Number(pedido.valor_frete) > 0 && (
            <div className="cascata-linha">
              <span className="cascata-rotulo">Frete cobrado</span>
              <span className="cascata-valor">{brl(pedido.valor_frete)}</span>
            </div>
          )}
          <div className="cascata-linha final">
            <span className="cascata-rotulo">Total da venda</span>
            <span className="cascata-valor">{brl(pedido.total_liquido)}</span>
          </div>
        </div>

        {deMarketplace && (
          <div style={{ marginTop: 14 }}>
            <div className="card-head">Marketplace</div>
            <div className="cascata-lucro">
              <div className="cascata-linha">
                <span className="cascata-rotulo">Taxa da plataforma</span>
                <span className="cascata-valor">{pedido.taxa_marketplace != null ? brl(pedido.taxa_marketplace) : '—'}</span>
              </div>
              {(pedido.origem_marketplace === 'mercado_livre' || pedido.origem_marketplace === 'shopee') && (
                <div className="cascata-linha">
                  <span className="cascata-rotulo">Valor recebido ({PLATAFORMA_LABEL[pedido.origem_marketplace]})</span>
                  <span className="cascata-valor">
                    {pedido.valor_recebido_marketplace != null ? (
                      <>
                        {brl(pedido.valor_recebido_marketplace)}{' '}
                        <span className={'stamp sm ' + (pedido.valor_recebido_status === 'liberado' ? 'tone-elevada' : 'tone-atencao')}>
                          {pedido.valor_recebido_status === 'liberado' ? 'liberado' : 'confirmado'}
                        </span>
                        {pedido.valor_recebido_status !== 'liberado' && pedido.valor_recebido_liberacao_em && (
                          <> — libera em {new Date(pedido.valor_recebido_liberacao_em).toLocaleDateString('pt-BR')}</>
                        )}
                      </>
                    ) : 'ainda sem confirmação'}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {aberto && !deMarketplace && !pedido.vendedor_id && (
          <div className="venda-ressalva">
            <Info size={14} />
            <span>
              Este pedido está <strong>sem vendedor</strong>. Ele continua contando no faturamento,
              mas fica de fora do relatório de comissão — escolha alguém no campo acima antes de faturar.
            </span>
          </div>
        )}
      </div>

      {/* Faturar fica no rodapé, ao alcance do polegar depois de rolar a
          lista de itens — era o botão mais importante e estava no alto. */}
      {aberto && !deMarketplace && (
        <div className="venda-acao-fixa no-print">
          <div className="venda-acao-fixa-total">
            <span>Total da venda</span>
            <strong>{brl(pedido.total_liquido)}</strong>
          </div>
          <button type="button" className="btn btn-primary" onClick={abrirFaturamento} disabled={itens.length === 0}>
            <CheckCircle2 size={16} /> Faturar pedido
          </button>
        </div>
      )}

      {/* Fechamento da venda: baixa de estoque + contas a receber, num passo só. */}
      {fecharAberto && (
        <>
          <div className="viagem-modal-overlay" onClick={() => setFecharAberto(false)} />
          <div className="viagem-modal" role="dialog" aria-label="Faturar pedido">
            <div className="card-head-linha">
              <div className="card-head">Faturar o pedido #{pedido.numero}</div>
              <button type="button" className="btn-icone" onClick={() => setFecharAberto(false)} aria-label="Fechar">
                <X size={16} />
              </button>
            </div>
            <p className="page-sub" style={{ marginTop: 0 }}>
              Faturar baixa o estoque de cada item e cria o contas a receber desta venda,
              no valor de <strong className="mono">{brl(pedido.total_liquido)}</strong>.
            </p>

            <div className="form-grid">
              <Field label="Empresa (emitente)">
                <Select
                  value={faturamento.empresa_id}
                  onChange={(e) => setFaturamento((f) => ({ ...f, empresa_id: e.target.value }))}
                >
                  <option value="">Escolha…</option>
                  {empresas.map((e) => <option key={e.id} value={String(e.id)}>{e.nome}</option>)}
                </Select>
              </Field>
              <Field label="Vencimento" hint="Quando este dinheiro deve entrar.">
                <DateInput
                  value={faturamento.data_vencimento}
                  onChange={(e) => setFaturamento((f) => ({ ...f, data_vencimento: e.target.value }))}
                />
              </Field>
              <Field
                label="Categoria do DRE"
                hint="Sem categoria o valor cai na linha “sem classificação” do relatório."
              >
                <Select
                  value={faturamento.plano_id}
                  onChange={(e) => setFaturamento((f) => ({ ...f, plano_id: e.target.value }))}
                >
                  <option value="">Escolha…</option>
                  {plano.filter((p) => p.analitica).map((p) => (
                    <option key={p.id} value={String(p.id)}>{p.codigo} — {p.nome}</option>
                  ))}
                </Select>
              </Field>
            </div>

            {plano.length === 0 && (
              <div className="aviso-inline" style={{ marginTop: 12 }}>
                <Info size={14} />
                <span>
                  A lista de categorias do DRE não carregou — ela pertence ao módulo Financeiro.
                  Dá para faturar assim mesmo: o lançamento fica na
                  <strong> Caixa de Entrada do Financeiro</strong> esperando a classificação.
                </span>
              </div>
            )}

            {error && <div className="login-error" style={{ marginTop: 12 }} role="alert">{error}</div>}

            <div className="painel-acoes-inline" style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-primary" onClick={faturarPedido} disabled={faturando}>
                <CheckCircle2 size={15} /> {faturando ? 'Faturando…' : 'Faturar e baixar o estoque'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setFecharAberto(false)}>Cancelar</button>
            </div>
          </div>
        </>
      )}

      <LeitorCamera
        aberto={cameraAberta}
        onFechar={() => { setCameraAberta(false); setTimeout(() => eanRef.current?.focus(), 100); }}
        onLer={(codigo) => lancarCodigo(codigo, 1)}
        titulo={`Bipar no pedido #${pedido.numero}`}
        subtitulo="Cada leitura lança uma peça. O mesmo código só conta de novo depois de 2 segundos."
        ultimaLeitura={retorno?.ok ? retorno.texto : null}
      />
    </div>
  );
}
