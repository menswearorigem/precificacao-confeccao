import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Save, Trash2, MapPinCheck, Wallet, ShoppingCart, Receipt, CalendarClock, Info,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd, dataBr, qtdFracionaria } from '../lib/format';
import {
  Field, Select, Checkbox, Toggle, IndicadorDestaque, BotaoRelatorio, BotaoExportar,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import DataTable from '../components/DataTable';
import { CartaoGrafico, GraficoColunas, GraficoRosca, BarraRanking, useRefGrafico, capturarGraficos } from '../components/graficos';
import { SITUACAO_LABEL } from '../lib/relatorioCompras';

// Ficha do fornecedor em duas abas:
//   Cadastro  — os dados (o formulário que já existia, reorganizado)
//   Histórico — o relacionamento: quanto já foi comprado, em que ritmo, de que
//               categoria, como foi pago e a lista de compras.
//
// A aba de histórico só lê o que a API somou (REGRA 1) e não conta compra
// cancelada em nenhum total (REGRA 2).

const SITUACAO_TONE = { pendente: 'tone-atencao', recebido: 'tone-saudavel', cancelado: 'tone-prejuizo' };

function emptyFornecedor() {
  return {
    tipo_pessoa: 'PJ',
    nome: '',
    nome_fantasia: '',
    cpf_cnpj: '',
    ie: '',
    ie_isento: false,
    telefone: '',
    email: '',
    cep: '',
    logradouro: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    uf: '',
    categoria_principal: '',
    condicao_pagamento_padrao: '',
    chave_pix: '',
    dados_bancarios: '',
    observacoes: '',
    ativo: true,
  };
}

// "Há 0 dia(s)" é uma frase que ninguém fala. Zero é hoje, um é ontem.
function textoDesdeUltimaCompra(dias) {
  const n = Number(dias);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return 'Foi hoje.';
  if (n === 1) return 'Foi ontem.';
  return `Há ${formatQtd(n)} dias.`;
}

function rotuloMes(mes) {
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const [ano, m] = String(mes).split('-');
  return `${nomes[Number(m) - 1] || m}/${ano.slice(2)}`;
}

export default function FornecedorFichaPage() {
  const { id } = useParams();
  const isNew = id === 'novo';
  const navigate = useNavigate();

  const [aba, setAba] = useState('cadastro');
  const [fornecedor, setFornecedor] = useState(emptyFornecedor());
  const [historico, setHistorico] = useState(null);
  const [listas, setListas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [buscandoCep, setBuscandoCep] = useState(false);
  const [error, setError] = useState('');

  const refMeses = useRefGrafico();
  const refCategorias = useRefGrafico();

  useEffect(() => {
    api.get('/listas').then(setListas);
  }, []);

  useEffect(() => {
    if (isNew) {
      setFornecedor(emptyFornecedor());
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get(`/fornecedores/${id}`).then((data) => {
      setFornecedor(data);
      setLoading(false);
    });
  }, [id, isNew]);

  // O histórico só é buscado quando a aba é aberta — numa ficha de fornecedor
  // com 500 compras, carregar isso junto do cadastro atrasaria a tela que a
  // pessoa quer em 90% das vezes (o cadastro).
  useEffect(() => {
    if (isNew || aba !== 'historico' || historico) return;
    api.get(`/fornecedores/${id}/historico`).then(setHistorico).catch((e) => setError(e.message));
  }, [aba, id, isNew, historico]);

  function set(patch) {
    setFornecedor((f) => ({ ...f, ...patch }));
  }

  async function buscarCep() {
    const cepLimpo = (fornecedor.cep || '').replace(/\D/g, '');
    if (cepLimpo.length !== 8) {
      setError('CEP inválido — precisa ter 8 dígitos.');
      return;
    }
    setBuscandoCep(true);
    setError('');
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
      const data = await res.json();
      if (data.erro) {
        setError('CEP não encontrado.');
        return;
      }
      set({
        logradouro: data.logradouro || fornecedor.logradouro,
        bairro: data.bairro || fornecedor.bairro,
        cidade: data.localidade || fornecedor.cidade,
        uf: data.uf || fornecedor.uf,
      });
    } catch {
      setError('Não consegui consultar o CEP agora — preencha o endereço manualmente.');
    } finally {
      setBuscandoCep(false);
    }
  }

  async function handleSalvar() {
    if (!fornecedor.nome.trim()) {
      setError('Nome é obrigatório.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        const created = await api.post('/fornecedores', fornecedor);
        navigate(`/fornecedores/${created.id}`, { replace: true });
      } else {
        const updated = await api.put(`/fornecedores/${id}`, fornecedor);
        // O PUT devolve só a linha da tabela, sem os agregados de compra — se
        // trocasse o objeto inteiro, os números do topo da ficha zerariam
        // depois de salvar. Mescla mantendo o que veio do GET.
        setFornecedor((atual) => ({ ...atual, ...updated }));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemover() {
    if (!(await confirmar('Remover este fornecedor?'))) return;
    try {
      await api.del(`/fornecedores/${id}`);
      navigate('/fornecedores');
    } catch (err) {
      setError(err.message);
    }
  }

  const porMes = useMemo(() => (
    (historico?.porMes || []).map((m) => ({ ...m, rotulo: rotuloMes(m.mes), total: Number(m.total || 0) }))
  ), [historico]);

  const porCategoria = useMemo(() => (
    (historico?.porCategoria || []).map((c) => ({ rotulo: c.categoria, valor: Number(c.total || 0) }))
  ), [historico]);

  const porForma = useMemo(() => (
    (historico?.porFormaPagamento || []).map((f) => ({
      rotulo: f.forma,
      valor: Number(f.total || 0),
      detalhe: `${formatQtd(f.quantidade)} compra(s)`,
    }))
  ), [historico]);

  async function montarRelatorio(tipo) {
    if (!historico) return null;
    const completo = tipo === 'completo';
    const graficos = await capturarGraficos([
      { titulo: 'Compras mês a mês', ref: refMeses },
      { titulo: 'O que se compra deste fornecedor', ref: refCategorias },
    ]);
    const total = Number(fornecedor.total_comprado || 0);

    const secoes = [
      {
        titulo: 'O que se compra deste fornecedor',
        descricao: 'Por categoria de compra, considerando todo o histórico não cancelado.',
        colunas: [
          { rotulo: 'Categoria', tipo: 'texto' },
          { rotulo: 'Compras', tipo: 'numero' },
          { rotulo: 'Total', tipo: 'moeda' },
          { rotulo: '% do total', tipo: 'percentual' },
        ],
        linhas: (historico.porCategoria || []).map((c) => [c.categoria, c.quantidade, Number(c.total), total ? Number(c.total) / total : null]),
      },
      {
        titulo: 'Como este fornecedor é pago',
        descricao: 'Pela forma de pagamento registrada em cada compra.',
        colunas: [
          { rotulo: 'Forma de pagamento', tipo: 'texto' },
          { rotulo: 'Compras', tipo: 'numero' },
          { rotulo: 'Total', tipo: 'moeda' },
        ],
        linhas: (historico.porFormaPagamento || []).map((f) => [f.forma, f.quantidade, Number(f.total)]),
      },
      {
        titulo: 'Compras mês a mês',
        descricao: 'Só os meses com compra — mês sem pedido não aparece como zero.',
        colunas: [
          { rotulo: 'Mês', tipo: 'texto' },
          { rotulo: 'Compras', tipo: 'numero' },
          { rotulo: 'Total', tipo: 'moeda' },
        ],
        linhas: (historico.porMes || []).map((m) => [rotuloMes(m.mes), m.quantidade, Number(m.total)]),
      },
    ];

    if (completo) {
      secoes.push({
        titulo: 'Todas as compras',
        descricao: 'Histórico completo lançado no sistema, inclusive as canceladas (marcadas na coluna Situação).',
        colunas: [
          { rotulo: 'Nº', tipo: 'texto', larguraExcel: 8 },
          { rotulo: 'Data', tipo: 'data' },
          { rotulo: 'Categoria', tipo: 'texto', larguraExcel: 26 },
          { rotulo: 'Documento', tipo: 'texto', larguraExcel: 16 },
          { rotulo: 'Forma de pagamento', tipo: 'texto', larguraExcel: 20 },
          { rotulo: 'Condição', tipo: 'texto', larguraExcel: 16 },
          { rotulo: 'Situação', tipo: 'texto', larguraExcel: 12 },
          { rotulo: 'Itens', tipo: 'numero' },
          { rotulo: 'Desconto', tipo: 'moeda' },
          { rotulo: 'Frete', tipo: 'moeda' },
          { rotulo: 'Total', tipo: 'moeda' },
        ],
        linhas: (historico.compras || []).map((c) => [
          `#${c.numero}`, c.data_compra, c.categoria, c.numero_documento || '',
          c.forma_pagamento || '', c.condicao_pagamento || '',
          SITUACAO_LABEL[c.situacao] || c.situacao, c.itens_qtd,
          c.desconto_valor, c.valor_frete, c.total_liquido,
        ]),
      });
      if (historico.itensMaisComprados?.length) {
        secoes.push({
          titulo: 'Itens mais comprados deste fornecedor',
          descricao: 'Agrupado pela descrição exata do item — descrições escritas de formas diferentes contam separado.',
          colunas: [
            { rotulo: 'Descrição', tipo: 'texto', larguraExcel: 46 },
            { rotulo: 'Unidade', tipo: 'texto', larguraExcel: 10 },
            { rotulo: 'Compras', tipo: 'numero' },
            { rotulo: 'Quantidade', tipo: 'decimal' },
            { rotulo: 'Total', tipo: 'moeda' },
          ],
          linhas: historico.itensMaisComprados.map((i) => [i.descricao, i.unidade, i.compras, Number(i.quantidade), Number(i.total)]),
        });
      }
    }

    return {
      nomeBase: `fornecedor-${fornecedor.nome.slice(0, 24).replace(/\s+/g, '-').toLowerCase()}-${completo ? 'completo' : 'resumo'}`,
      titulo: fornecedor.nome,
      subtitulo: completo ? 'Ficha completa do fornecedor' : 'Resumo do fornecedor',
      periodoTexto: fornecedor.primeira_compra
        ? `Histórico de ${dataBr(String(fornecedor.primeira_compra).slice(0, 10))} até ${dataBr(String(fornecedor.ultima_compra).slice(0, 10))}`
        : 'Sem compra registrada',
      filtros: [
        fornecedor.cpf_cnpj ? `CPF/CNPJ: ${fornecedor.cpf_cnpj}` : null,
        fornecedor.telefone ? `Telefone: ${fornecedor.telefone}` : null,
        fornecedor.cidade ? `Cidade: ${fornecedor.cidade}${fornecedor.uf ? `/${fornecedor.uf}` : ''}` : null,
        fornecedor.categoria_principal ? `Categoria: ${fornecedor.categoria_principal}` : null,
      ].filter(Boolean),
      indicadores: [
        { rotulo: 'Total comprado', valor: brl(fornecedor.total_comprado) },
        { rotulo: 'Compras', valor: formatQtd(fornecedor.compras_qtd) },
        { rotulo: 'Ticket médio', valor: fornecedor.ticket_medio === null ? '—' : brl(fornecedor.ticket_medio) },
        { rotulo: 'Paga mais em', valor: fornecedor.forma_pagamento_comum || '—' },
      ],
      graficos,
      secoes,
      notas: [
        'Compra cancelada não entra em total, ticket médio nem nos gráficos — só aparece na lista de compras do relatório completo.',
        'Ticket médio é o total dividido pelo número de compras deste fornecedor.',
      ],
      abaUnica: !completo,
      orientacao: completo ? 'l' : 'p',
      rodape: `HBN Hub · ficha do fornecedor ${fornecedor.nome}`,
    };
  }

  if (loading) return null;

  return (
    <div className="page-wide">
      <button className="btn btn-ghost no-print" style={{ marginBottom: 14 }} onClick={() => navigate('/fornecedores')}>
        <ArrowLeft size={14} /> Voltar para fornecedores
      </button>

      <div className="pagina-topo">
        <div>
          <h2>{isNew ? 'Novo Fornecedor' : fornecedor.nome}</h2>
          <p className="page-sub">
            {isNew
              ? 'Cadastro completo de fornecedor para uso nos lançamentos de compra.'
              : [fornecedor.nome_fantasia, fornecedor.cpf_cnpj, fornecedor.cidade && `${fornecedor.cidade}${fornecedor.uf ? `/${fornecedor.uf}` : ''}`]
                .filter(Boolean).join(' · ') || 'Cadastro de fornecedor.'}
          </p>
        </div>
        <div className="pagina-topo-acoes no-print">
          {!isNew && aba === 'historico' && (
            <BotaoRelatorio
              montar={montarRelatorio}
              disabled={!historico}
              rotulo="Exportar ficha"
              descricaoResumo="Os indicadores, os gráficos e as quebras por categoria, pagamento e mês."
              descricaoCompleto="O resumo mais todas as compras e o ranking de itens comprados deste fornecedor."
            />
          )}
          <button className="btn btn-primary" onClick={handleSalvar} disabled={saving}>
            <Save size={14} /> Salvar
          </button>
          {!isNew && (
            <button className="btn btn-ghost" onClick={handleRemover} style={{ color: 'var(--danger)' }}>
              <Trash2 size={14} /> Remover
            </button>
          )}
        </div>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      {!isNew && (
        <>
          <div className="indicadores-faixa compacta">
            <IndicadorDestaque
              destaque
              Icone={Wallet}
              rotulo="Total comprado"
              valor={brl(fornecedor.total_comprado)}
              explicacao="Somando todas as compras já lançadas deste fornecedor, sem as canceladas."
            />
            <IndicadorDestaque
              Icone={ShoppingCart}
              rotulo="Compras"
              valor={formatQtd(fornecedor.compras_qtd)}
              explicacao={fornecedor.compras_pendentes > 0
                ? `${formatQtd(fornecedor.compras_pendentes)} ainda pendente(s), somando ${brl(fornecedor.total_pendente)}.`
                : 'Nenhuma compra pendente com este fornecedor.'}
            />
            <IndicadorDestaque
              Icone={Receipt}
              rotulo="Ticket médio"
              valor={fornecedor.ticket_medio === null ? '—' : brl(fornecedor.ticket_medio)}
              explicacao="Quanto costuma custar cada compra feita com ele."
            />
            <IndicadorDestaque
              Icone={CalendarClock}
              tom={fornecedor.dias_sem_comprar > 90 ? 'atencao' : undefined}
              rotulo="Última compra"
              valor={fornecedor.ultima_compra ? dataBr(String(fornecedor.ultima_compra).slice(0, 10)) : '—'}
              explicacao={fornecedor.ultima_compra
                ? `${textoDesdeUltimaCompra(fornecedor.dias_sem_comprar)} A primeira foi em ${dataBr(String(fornecedor.primeira_compra).slice(0, 10))}.`
                : 'Este fornecedor ainda não tem nenhuma compra lançada.'}
            />
            <IndicadorDestaque
              rotulo="Paga mais em"
              valor={fornecedor.forma_pagamento_comum || '—'}
              explicacao={fornecedor.forma_pagamento_comum
                ? `Forma que mais aparece nas compras dele (${formatQtd(fornecedor.forma_pagamento_comum_qtd)} vez(es)). O padrão do cadastro é "${fornecedor.condicao_pagamento_padrao || 'não informado'}".`
                : 'Nenhuma compra dele tem a forma de pagamento preenchida.'}
            />
          </div>

          <div className="subtab-row no-print">
            <button type="button" className={'subtab-btn' + (aba === 'cadastro' ? ' active' : '')} onClick={() => setAba('cadastro')}>Cadastro</button>
            <button type="button" className={'subtab-btn' + (aba === 'historico' ? ' active' : '')} onClick={() => setAba('historico')}>Histórico de compras</button>
          </div>
        </>
      )}

      {(isNew || aba === 'cadastro') && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">Identificação</div>
            <div className="form-grid">
              <Field label="Tipo de Pessoa">
                <Select value={fornecedor.tipo_pessoa} onChange={(e) => set({ tipo_pessoa: e.target.value })}>
                  <option value="PJ">Pessoa Jurídica</option>
                  <option value="PF">Pessoa Física</option>
                </Select>
              </Field>
              <Field label={fornecedor.tipo_pessoa === 'PJ' ? 'Razão Social' : 'Nome'}>
                <input value={fornecedor.nome} onChange={(e) => set({ nome: e.target.value })} />
              </Field>
              {fornecedor.tipo_pessoa === 'PJ' && (
                <Field label="Nome Fantasia">
                  <input value={fornecedor.nome_fantasia || ''} onChange={(e) => set({ nome_fantasia: e.target.value })} />
                </Field>
              )}
              <Field label={fornecedor.tipo_pessoa === 'PJ' ? 'CNPJ' : 'CPF'}>
                <input className="mono" value={fornecedor.cpf_cnpj || ''} onChange={(e) => set({ cpf_cnpj: e.target.value })} />
              </Field>
              {fornecedor.tipo_pessoa === 'PJ' && (
                <Field label="Inscrição Estadual">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      className="mono"
                      value={fornecedor.ie || ''}
                      onChange={(e) => set({ ie: e.target.value })}
                      disabled={fornecedor.ie_isento}
                      style={{ flex: 1 }}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
                      <Checkbox checked={fornecedor.ie_isento} onChange={(e) => set({ ie_isento: e.target.checked, ie: e.target.checked ? '' : fornecedor.ie })} />
                      Isento
                    </label>
                  </div>
                </Field>
              )}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">Contato</div>
            <div className="form-grid">
              <Field label="Telefone / WhatsApp">
                <input className="mono" value={fornecedor.telefone || ''} onChange={(e) => set({ telefone: e.target.value })} />
              </Field>
              <Field label="E-mail">
                <input type="email" value={fornecedor.email || ''} onChange={(e) => set({ email: e.target.value })} />
              </Field>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">Endereço</div>
            <div className="form-grid">
              <Field label="CEP">
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="mono" value={fornecedor.cep || ''} onChange={(e) => set({ cep: e.target.value })} style={{ flex: 1 }} />
                  <button type="button" className="btn btn-ghost" onClick={buscarCep} disabled={buscandoCep} title="Buscar endereço pelo CEP">
                    <MapPinCheck size={14} />
                  </button>
                </div>
              </Field>
              <Field label="Logradouro">
                <input value={fornecedor.logradouro || ''} onChange={(e) => set({ logradouro: e.target.value })} />
              </Field>
              <Field label="Número">
                <input value={fornecedor.numero || ''} onChange={(e) => set({ numero: e.target.value })} />
              </Field>
              <Field label="Complemento">
                <input value={fornecedor.complemento || ''} onChange={(e) => set({ complemento: e.target.value })} />
              </Field>
              <Field label="Bairro">
                <input value={fornecedor.bairro || ''} onChange={(e) => set({ bairro: e.target.value })} />
              </Field>
              <Field label="Cidade">
                <input value={fornecedor.cidade || ''} onChange={(e) => set({ cidade: e.target.value })} />
              </Field>
              <Field label="UF">
                <input value={fornecedor.uf || ''} onChange={(e) => set({ uf: e.target.value.toUpperCase().slice(0, 2) })} style={{ width: 60 }} />
              </Field>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">Comercial</div>
            <div className="form-grid">
              <Field label="Categoria Principal">
                <Select value={fornecedor.categoria_principal || ''} onChange={(e) => set({ categoria_principal: e.target.value })}>
                  <option value="">—</option>
                  {listas?.categoria_compra.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
                </Select>
              </Field>
              <Field
                label="Condição de Pagamento Padrão"
                hint={fornecedor.forma_pagamento_comum ? `Nas compras reais, este fornecedor é pago mais em ${fornecedor.forma_pagamento_comum}.` : undefined}
              >
                <Select value={fornecedor.condicao_pagamento_padrao || ''} onChange={(e) => set({ condicao_pagamento_padrao: e.target.value })}>
                  <option value="">—</option>
                  {listas?.condicao_pagamento.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
                </Select>
              </Field>
              <Field label="Chave PIX">
                <input className="mono" value={fornecedor.chave_pix || ''} onChange={(e) => set({ chave_pix: e.target.value })} />
              </Field>
              <Field label="Ativo?">
                <label className="toggle">
                  <Toggle checked={fornecedor.ativo} onChange={(e) => set({ ativo: e.target.checked })} />
                  {fornecedor.ativo ? 'Sim' : 'Não'}
                </label>
              </Field>
            </div>
            <Field label="Dados Bancários">
              <textarea rows={2} value={fornecedor.dados_bancarios || ''} onChange={(e) => set({ dados_bancarios: e.target.value })} />
            </Field>
            <Field label="Observações">
              <textarea rows={3} value={fornecedor.observacoes || ''} onChange={(e) => set({ observacoes: e.target.value })} />
            </Field>
          </div>
        </>
      )}

      {!isNew && aba === 'historico' && (
        <>
          {!historico && <div className="card"><p className="page-sub" style={{ margin: 0 }}>Carregando o histórico…</p></div>}
          {historico && historico.compras.length === 0 && (
            <div className="card">
              <p className="page-sub" style={{ margin: 0 }}>
                Este fornecedor ainda não tem nenhuma compra lançada. Assim que a primeira for registrada,
                os gráficos e os números aparecem aqui.
              </p>
            </div>
          )}
          {historico && historico.compras.length > 0 && (
            <>
              <div className="nota-precisao">
                <Info size={14} />
                <span>
                  Os gráficos consideram <strong>{formatQtd(fornecedor.compras_qtd)} compra(s) não cancelada(s)</strong>
                  {fornecedor.compras_canceladas > 0 && <> — {formatQtd(fornecedor.compras_canceladas)} cancelada(s) aparecem na lista abaixo, mas fora de qualquer soma</>}.
                </span>
              </div>

              <CartaoGrafico
                titulo="Compras mês a mês"
                explicacao="Quanto foi comprado deste fornecedor em cada mês que teve pedido. Meses sem compra não aparecem — a barra ausente significa 'nenhum pedido', não 'R$ 0,00 gasto'."
                refGrafico={refMeses}
                altura={250}
                vazio={porMes.length === 0 ? 'Sem compra registrada.' : null}
              >
                <GraficoColunas dados={porMes} series={[{ chave: 'total', nome: 'Comprado' }]} altura={250} />
              </CartaoGrafico>

              <div className="coluna-larga">
                <div className="card">
                  <div className="card-head">Como este fornecedor é pago</div>
                  <p className="grafico-explicacao">
                    Pela forma de pagamento registrada em cada compra. “(não informada)” é compra lançada com o
                    campo em branco.
                  </p>
                  <BarraRanking itens={porForma} vazio="Nenhuma compra com forma de pagamento preenchida." />
                </div>

                <CartaoGrafico
                  titulo="O que se compra dele"
                  explicacao="A divisão do total por categoria de compra."
                  refGrafico={refCategorias}
                  altura={230}
                  vazio={porCategoria.length === 0 ? 'Sem compra registrada.' : null}
                >
                  <GraficoRosca dados={porCategoria} altura={230} totalRotulo="Total comprado" />
                </CartaoGrafico>
              </div>

              {historico.itensMaisComprados?.length > 0 && (
                <div className="card">
                  <div className="card-head-linha">
                    <div className="card-head">Itens mais comprados deste fornecedor</div>
                    <BotaoExportar
                      nomeBase={`itens-${fornecedor.nome.slice(0, 20)}`}
                      colunas={[
                        { rotulo: 'Descrição', valor: (i) => i.descricao },
                        { rotulo: 'Unidade', valor: (i) => i.unidade },
                        { rotulo: 'Compras', valor: (i) => formatQtd(i.compras) },
                        { rotulo: 'Quantidade', valor: (i) => qtdFracionaria(i.quantidade) },
                        { rotulo: 'Total', valor: (i) => brl(i.total) },
                      ]}
                      itens={historico.itensMaisComprados}
                    />
                  </div>
                  <p className="grafico-explicacao">
                    Agrupado pela descrição exata escrita no item. “ZIPER 20cm” e “Zíper 20 cm” contam como
                    itens diferentes — o sistema não adivinha que são a mesma coisa.
                  </p>
                  <DataTable>
                    <table className="data-table">
                      <thead>
                        <tr><th>Descrição</th><th>Unidade</th><th>Compras</th><th>Quantidade</th><th>Total</th><th>Preço médio</th></tr>
                      </thead>
                      <tbody>
                        {historico.itensMaisComprados.slice(0, 25).map((i) => (
                          <tr key={`${i.descricao}-${i.unidade}`}>
                            <td>{i.descricao}</td>
                            <td>{i.unidade}</td>
                            <td className="mono">{formatQtd(i.compras)}</td>
                            <td className="mono">{qtdFracionaria(i.quantidade)}</td>
                            <td className="mono">{brl(i.total)}</td>
                            {/* Preço médio = total ÷ quantidade. Sem quantidade
                                não existe preço médio: "—", nunca zero. */}
                            <td className="mono">{Number(i.quantidade) > 0 ? brl(Number(i.total) / Number(i.quantidade)) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </DataTable>
                </div>
              )}

              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-head-linha">
                  <div className="card-head">Todas as compras</div>
                  <span className="page-sub" style={{ margin: 0 }}>{formatQtd(historico.compras.length)} lançamento(s)</span>
                </div>
                <DataTable>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Nº</th><th>Data</th><th>Categoria</th><th>Documento</th>
                        <th>Pagamento</th><th>Itens</th><th>Total</th><th>Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historico.compras.map((c) => (
                        <tr key={c.id} className="clickable-row" onClick={() => navigate(`/compras/${c.id}`)}>
                          <td className="mono">#{c.numero}</td>
                          <td className="mono">{dataBr(String(c.data_compra).slice(0, 10))}</td>
                          <td>{c.categoria}</td>
                          <td className="mono">{c.numero_documento || '—'}</td>
                          <td>
                            <span className="cel-dupla">
                              <strong>{c.forma_pagamento || '—'}</strong>
                              {c.condicao_pagamento && <small>{c.condicao_pagamento}</small>}
                            </span>
                          </td>
                          <td className="mono">{formatQtd(c.itens_qtd)}</td>
                          <td className="mono">{brl(c.total_liquido)}</td>
                          <td><span className={'stamp sm ' + (SITUACAO_TONE[c.situacao] || 'tone-neutro')}>{SITUACAO_LABEL[c.situacao] || c.situacao}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
                {historico.compras.length >= 500 && (
                  <p className="page-sub">
                    A lista mostra as 500 compras mais recentes. Os números do topo consideram o histórico
                    inteiro — só esta tabela está cortada.
                  </p>
                )}
              </div>

              <p className="page-sub" style={{ marginTop: 12 }}>
                Quer ver estes lançamentos junto com os de outros fornecedores?{' '}
                <Link to={`/compras?fornecedor=${fornecedor.id}`}>Abrir em Compras</Link>.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
