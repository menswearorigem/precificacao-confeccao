import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Home, Monitor, Briefcase, Truck, Layers } from 'lucide-react';
import { api } from '../api/client';
import { NumInput } from '../components/ui';
import BarraAlteracoes from '../components/BarraAlteracoes';
import { brl, pct } from '../lib/format';

function normalizarTexto(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Agrupamento por natureza — o cadastro (custos_indiretos_itens) não tem
// coluna de categoria (mudar o schema pra isso não está autorizado nesta
// tarefa), então isto é uma classificação por PALAVRA-CHAVE no nome,
// só pra organizar a tela — não é gravado em lugar nenhum, é recalculado
// toda vez a partir do nome atual do item. Um nome que não bate com nada
// cai em "Outros".
const GRUPOS = [
  { chave: 'instalacoes', label: 'Instalações', Icone: Home, regex: /aluguel|energia|eletric|agua|limpeza|manutenc|predial|condomini|seguranca|iptu/ },
  { chave: 'tecnologia', label: 'Tecnologia', Icone: Monitor, regex: /sistema|erp|software|licenc|internet|telefone|hospedagem|dominio|\bti\b/ },
  { chave: 'administrativo', label: 'Administrativo', Icone: Briefcase, regex: /contad|contabil|juridic|administra|escritorio|\brh\b|folha|honorario/ },
  { chave: 'logistica', label: 'Logística', Icone: Truck, regex: /frete|transporte|logistic|combustivel|entrega|armazenagem/ },
  { chave: 'outros', label: 'Outros', Icone: Layers, regex: null },
];

function classificar(nome) {
  const n = normalizarTexto(nome);
  return GRUPOS.find((g) => g.regex && g.regex.test(n)) || GRUPOS[GRUPOS.length - 1];
}

// Grupo some sozinho se ficar pequeno demais em relação ao total — economiza
// rolagem pros grupos que hoje representam a maior parte do custo fixo.
const LIMIAR_COLAPSO_PCT = 0.1;

export default function CustosIndiretosPage() {
  const [servidor, setServidor] = useState(null);
  const [itensRascunho, setItensRascunho] = useState([]);
  const [producaoRascunho, setProducaoRascunho] = useState(0);
  const [gruposAbertos, setGruposAbertos] = useState(() => new Set());
  const [salvando, setSalvando] = useState(false);
  const [mensagemSalvo, setMensagemSalvo] = useState('');

  function load() {
    api.get('/custos-indiretos').then((r) => {
      setServidor(r);
      setItensRascunho(r.itens);
      setProducaoRascunho(r.producaoMensal);
    });
  }

  useEffect(load, []);

  const totalMensalRascunho = useMemo(() => itensRascunho.reduce((s, i) => s + (Number(i.valor_mensal) || 0), 0), [itensRascunho]);
  const custoPorPecaRascunho = useMemo(() => (
    Number(producaoRascunho) === 0 ? 0 : totalMensalRascunho / Number(producaoRascunho)
  ), [totalMensalRascunho, producaoRascunho]);

  const grupos = useMemo(() => {
    const porGrupo = new Map(GRUPOS.map((g) => [g.chave, { ...g, itens: [], subtotal: 0 }]));
    for (const item of itensRascunho) {
      const g = classificar(item.nome);
      const alvo = porGrupo.get(g.chave);
      alvo.itens.push(item);
      alvo.subtotal += Number(item.valor_mensal) || 0;
    }
    return [...porGrupo.values()].filter((g) => g.itens.length > 0);
  }, [itensRascunho]);

  // Abre por padrão os grupos "grandes" (>= 10% do total) assim que os dados
  // chegam — grupos pequenos/vazios começam recolhidos, mas o estado de
  // aberto/fechado depois disso é todo do usuário (não recalcula sozinho a
  // cada tecla, senão um grupo que a pessoa abriu manualmente fecharia de
  // volta ao cruzar o limiar pra baixo).
  useEffect(() => {
    if (!servidor) return;
    const iniciais = new Set(
      grupos.filter((g) => totalMensalRascunho === 0 || g.subtotal / totalMensalRascunho >= LIMIAR_COLAPSO_PCT).map((g) => g.chave)
    );
    setGruposAbertos(iniciais);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servidor]);

  function alternarGrupo(chave) {
    setGruposAbertos((atual) => {
      const novo = new Set(atual);
      if (novo.has(chave)) novo.delete(chave); else novo.add(chave);
      return novo;
    });
  }

  function atualizarItem(id, patch) {
    setItensRascunho((lista) => lista.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  async function addItem() {
    const resumo = await api.post('/custos-indiretos', { nome: 'Novo item', valor_mensal: 0, ordem: itensRascunho.length + 1 });
    setServidor(resumo);
    setItensRascunho(resumo.itens);
  }

  async function removerItem(id) {
    const resumo = await api.del(`/custos-indiretos/${id}`);
    setServidor(resumo);
    setItensRascunho(resumo.itens);
  }

  const camposAlterados = useMemo(() => {
    if (!servidor) return [];
    const alterados = [];
    for (const item of itensRascunho) {
      const original = servidor.itens.find((i) => i.id === item.id);
      if (!original) continue;
      if (original.nome !== item.nome) alterados.push(`${item.nome || 'item'} (nome)`);
      if (Number(original.valor_mensal) !== Number(item.valor_mensal)) alterados.push(item.nome);
    }
    if (Number(servidor.producaoMensal) !== Number(producaoRascunho)) alterados.push('Produção do mês');
    return alterados;
  }, [servidor, itensRascunho, producaoRascunho]);

  async function salvar() {
    setSalvando(true);
    try {
      const chamadas = [];
      for (const item of itensRascunho) {
        const original = servidor.itens.find((i) => i.id === item.id);
        if (!original) continue;
        if (original.nome !== item.nome || Number(original.valor_mensal) !== Number(item.valor_mensal)) {
          chamadas.push(api.put(`/custos-indiretos/${item.id}`, { nome: item.nome, valor_mensal: Number(item.valor_mensal) || 0 }));
        }
      }
      if (Number(servidor.producaoMensal) !== Number(producaoRascunho)) {
        chamadas.push(api.put('/custos-indiretos/producao-mensal', { producao_mensal_pecas: Number(producaoRascunho) || 0 }));
      }
      const resultados = await Promise.all(chamadas);
      const ultimoResumo = resultados[resultados.length - 1];
      if (ultimoResumo) {
        setServidor(ultimoResumo);
        setItensRascunho(ultimoResumo.itens);
        setProducaoRascunho(ultimoResumo.producaoMensal);
      } else {
        setServidor((s) => ({ ...s, itens: itensRascunho, producaoMensal: producaoRascunho }));
      }
      setMensagemSalvo('Salvo · há instantes');
      setTimeout(() => setMensagemSalvo(''), 3000);
    } finally {
      setSalvando(false);
    }
  }

  function descartar() {
    setItensRascunho(servidor.itens);
    setProducaoRascunho(servidor.producaoMensal);
  }

  if (!servidor) return <div className="page">Carregando…</div>;

  return (
    <div className="page-wide">
      <h2>Custos Indiretos</h2>
      <p className="page-sub">O custo fixo que não é de nenhuma peça em particular, rateado por toda a produção do mês.</p>

      <div className="card cfg-simulador" style={{ marginBottom: 16 }}>
        <div className="cfg-simulador-campo">
          <span className="cfg-simulador-campo-label">Total fixo do mês</span>
          <strong className="mono" style={{ fontSize: 20 }}>{brl(totalMensalRascunho)}</strong>
          <span className="page-sub" style={{ margin: 0, fontSize: 11 }}>{itensRascunho.length} item(ns) lançado(s)</span>
        </div>
        <div style={{ fontSize: 20, color: 'var(--ink-faint)' }}>÷</div>
        <div className="cfg-simulador-campo">
          <span className="cfg-simulador-campo-label">Produção do mês</span>
          <NumInput value={producaoRascunho} onChange={setProducaoRascunho} step="1" suffix="peças" style={{ maxWidth: 160 }} />
          <span className="page-sub" style={{ margin: 0, fontSize: 11 }}>editável — muda o rateio na hora</span>
        </div>
        <div style={{ fontSize: 20, color: 'var(--ink-faint)' }}>=</div>
        <div className="cfg-simulador-recebe" style={{ background: 'var(--warning-bg, var(--surface-alt))' }}>
          <div className="cfg-simulador-recebe-label" style={{ color: 'var(--terracotta)' }}>Custo indireto por peça</div>
          <div className="cfg-simulador-recebe-valor" style={{ color: 'var(--terracotta)' }}>{brl(custoPorPecaRascunho)}</div>
          <div className="page-sub" style={{ margin: 0, fontSize: 10.5 }}>entra no custo de toda peça cadastrada</div>
        </div>
      </div>

      {grupos.map((g) => {
        const aberto = gruposAbertos.has(g.chave);
        const percentualGrupo = totalMensalRascunho === 0 ? 0 : g.subtotal / totalMensalRascunho;
        return (
          <div key={g.chave} className="card" style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
            <button type="button" className="cfg-colapsavel-cabecalho" style={{ borderRadius: 0, justifyContent: 'space-between' }} onClick={() => alternarGrupo(g.chave)}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
                {aberto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <g.Icone size={15} />
                {g.label}
                <span className="page-sub" style={{ margin: 0, fontWeight: 400 }}>{g.itens.length} item(ns)</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <strong className="mono">{brl(g.subtotal)}</strong>
                <span className="mono" style={{ color: 'var(--ink-soft)', fontSize: 12 }}>{pct(percentualGrupo)}</span>
              </span>
            </button>
            {aberto && (
              <div style={{ padding: '4px 16px 12px' }}>
                {g.itens.map((item) => {
                  const percentualItem = totalMensalRascunho === 0 ? 0 : (Number(item.valor_mensal) || 0) / totalMensalRascunho;
                  return (
                    <div key={item.id} className="cfg-linha-hover" style={{ display: 'grid', gridTemplateColumns: '1.6fr 2fr 140px 60px 28px', gap: 14, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-soft)' }}>
                      <input value={item.nome} onChange={(e) => atualizarItem(item.id, { nome: e.target.value })} style={{ fontWeight: 400, color: 'var(--ink-soft)' }} />
                      <div className="cfg-barra"><div className="cfg-barra-preenchimento" style={{ width: `${Math.min(100, percentualItem * 100)}%` }} /></div>
                      <NumInput value={item.valor_mensal} onChange={(v) => atualizarItem(item.id, { valor_mensal: v })} suffix="R$" />
                      <span className="mono" style={{ color: 'var(--ink-soft)', fontSize: 12, textAlign: 'right' }}>{pct(percentualItem)}</span>
                      <button className="icon-btn cfg-lixeira" onClick={() => removerItem(item.id)}><Trash2 size={13} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <button className="btn btn-dashed" style={{ marginTop: 6 }} onClick={addItem}>
        <Plus size={13} /> Novo custo
      </button>

      <BarraAlteracoes
        quantidade={camposAlterados.length}
        salvando={salvando}
        mensagemSalvo={mensagemSalvo}
        detalhe={camposAlterados.slice(0, 3).join(' · ')}
        onSalvar={salvar}
        onDescartar={descartar}
      />
    </div>
  );
}
