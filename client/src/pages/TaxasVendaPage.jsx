import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { api } from '../api/client';
import { NumInput, Toggle } from '../components/ui';
import BarraAlteracoes from '../components/BarraAlteracoes';
import { brl, pct } from '../lib/format';

const VALOR_REFERENCIA = 100;

// Efeito de uma taxa sobre uma venda de referência — soma o componente
// percentual (sobre o valor) com o componente fixo (por venda), cada um só
// entrando na conta quando o `tipo` realmente o usa (campo tracejado não
// conta, mesmo que ainda tenha um valor antigo guardado).
function efeitoNaVenda(taxa, valorVenda) {
  const usaPct = taxa.tipo !== 'fixo';
  const usaFixo = taxa.tipo !== 'percentual';
  return (usaPct ? Number(taxa.percentual) * valorVenda : 0) + (usaFixo ? Number(taxa.valor_fixo) : 0);
}

function normalizarTexto(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const TIPO_OPCOES = [
  { valor: 'percentual', rotulo: '%' },
  { valor: 'fixo', rotulo: 'R$' },
  { valor: 'ambos', rotulo: '% + R$' },
];

function SeletorTipo({ valor, onChange, disabled }) {
  return (
    <div className="cfg-segmentado">
      {TIPO_OPCOES.map((o) => (
        <button
          key={o.valor}
          type="button"
          className={valor === o.valor ? 'is-ativo' : ''}
          disabled={disabled}
          onClick={() => onChange(o.valor)}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}

function LinhaTaxa({ taxa, onChange, onRemover }) {
  return (
    <tr className="cfg-linha-hover">
      <td><input value={taxa.nome} onChange={(e) => onChange({ nome: e.target.value })} /></td>
      <td>
        <label className="toggle">
          <Toggle checked={taxa.ativo} onChange={(e) => onChange({ ativo: e.target.checked })} />
          {taxa.ativo ? 'Sim' : 'Não'}
        </label>
      </td>
      <td><SeletorTipo valor={taxa.tipo} onChange={(tipo) => onChange({ tipo })} /></td>
      <td className={taxa.tipo === 'fixo' ? 'cfg-campo-tracejado' : ''}>
        <NumInput value={taxa.percentual * 100} onChange={(v) => onChange({ percentual: (Number(v) || 0) / 100 })} suffix="%" disabled={taxa.tipo === 'fixo'} />
      </td>
      <td className={taxa.tipo === 'percentual' ? 'cfg-campo-tracejado' : ''}>
        <NumInput value={taxa.valor_fixo} onChange={(v) => onChange({ valor_fixo: Number(v) || 0 })} suffix="R$" disabled={taxa.tipo === 'percentual'} />
      </td>
      <td className="cfg-efeito-valor">- {brl(efeitoNaVenda(taxa, VALOR_REFERENCIA))}</td>
      <td><button className="icon-btn cfg-lixeira" onClick={onRemover}><Trash2 size={13} /></button></td>
    </tr>
  );
}

export default function TaxasVendaPage() {
  const [servidor, setServidor] = useState([]);
  const [rascunho, setRascunho] = useState([]);
  const [valorSimulado, setValorSimulado] = useState(VALOR_REFERENCIA);
  const [busca, setBusca] = useState('');
  const [mostrarInativas, setMostrarInativas] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [mensagemSalvo, setMensagemSalvo] = useState('');

  function load() {
    api.get('/taxas-venda').then((data) => { setServidor(data.taxas); setRascunho(data.taxas); });
  }

  useEffect(load, []);

  function atualizar(id, patch) {
    setRascunho((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  async function addTaxa() {
    const created = await api.post('/taxas-venda', { nome: 'Nova taxa', ativo: false, tipo: 'percentual', percentual: 0, ordem: rascunho.length + 1 });
    setServidor((list) => [...list, created]);
    setRascunho((list) => [...list, created]);
  }

  async function removerTaxa(id) {
    await api.del(`/taxas-venda/${id}`);
    setServidor((list) => list.filter((t) => t.id !== id));
    setRascunho((list) => list.filter((t) => t.id !== id));
  }

  const camposAlterados = useMemo(() => {
    const nomes = [];
    for (const t of rascunho) {
      const original = servidor.find((s) => s.id === t.id);
      if (!original) continue;
      if (JSON.stringify(original) !== JSON.stringify(t)) nomes.push(t.nome || 'taxa');
    }
    return nomes;
  }, [rascunho, servidor]);

  async function salvar() {
    setSalvando(true);
    try {
      const alteradas = rascunho.filter((t) => {
        const original = servidor.find((s) => s.id === t.id);
        return original && JSON.stringify(original) !== JSON.stringify(t);
      });
      const resultados = await Promise.all(alteradas.map((t) => api.put(`/taxas-venda/${t.id}`, {
        nome: t.nome, ativo: t.ativo, tipo: t.tipo, percentual: t.percentual, valor_fixo: t.valor_fixo,
      })));
      const porId = new Map(resultados.map((r) => [r.id, r]));
      setServidor((list) => list.map((t) => porId.get(t.id) || t));
      setRascunho((list) => list.map((t) => porId.get(t.id) || t));
      setMensagemSalvo('Salvo · há instantes');
      setTimeout(() => setMensagemSalvo(''), 3000);
    } finally {
      setSalvando(false);
    }
  }

  function descartar() {
    setRascunho(servidor);
  }

  const termo = normalizarTexto(busca);
  const filtradas = rascunho.filter((t) => !termo || normalizarTexto(t.nome).includes(termo));
  const ativas = filtradas.filter((t) => t.ativo);
  const inativas = filtradas.filter((t) => !t.ativo);

  const ativasTodas = rascunho.filter((t) => t.ativo);
  const totalSimulado = ativasTodas.reduce((s, t) => s + efeitoNaVenda(t, Number(valorSimulado) || 0), 0);
  const recebeSimulado = (Number(valorSimulado) || 0) - totalSimulado;
  const totalEm100 = ativasTodas.reduce((s, t) => s + efeitoNaVenda(t, VALOR_REFERENCIA), 0);

  return (
    <div>
      <div className="cfg-page-head">
        <p className="page-sub" style={{ marginTop: 0 }}>
          Tudo que é descontado do preço antes do dinheiro chegar. Cada taxa pode ser percentual, valor fixo, ou os dois.
        </p>
        <div className="cfg-page-head-acoes">
          <div className="cfg-busca">
            <Search size={14} />
            <input placeholder="Buscar taxa…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={addTaxa}><Plus size={14} /> Nova taxa</button>
        </div>
      </div>

      <div className="card cfg-simulador">
        <div className="cfg-simulador-campo">
          <span className="cfg-simulador-campo-label">Numa venda de</span>
          <NumInput value={valorSimulado} onChange={setValorSimulado} suffix="R$" style={{ maxWidth: 130 }} />
        </div>
        <div className="cfg-simulador-resultado">
          <div className="cfg-simulador-resultado-item">
            <div className="cfg-simulador-resultado-label">Taxas</div>
            <div className="cfg-simulador-resultado-valor">- {brl(totalSimulado)}</div>
          </div>
        </div>
        <div className="cfg-simulador-recebe">
          <div className="cfg-simulador-recebe-label">Você recebe</div>
          <div className="cfg-simulador-recebe-valor">{brl(recebeSimulado)}</div>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Canal / Taxa</th>
            <th>Ativa?</th>
            <th>Como cobra</th>
            <th>% do preço</th>
            <th>R$ por venda</th>
            <th>Em {brl(VALOR_REFERENCIA)}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ativas.map((t) => (
            <LinhaTaxa key={t.id} taxa={t} onChange={(patch) => atualizar(t.id, patch)} onRemover={() => removerTaxa(t.id)} />
          ))}
          {ativas.length === 0 && <tr><td colSpan="7" style={{ textAlign: 'center', color: 'var(--ink-faint)' }}>Nenhuma taxa ativa.</td></tr>}
        </tbody>
      </table>

      {inativas.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="cfg-colapsavel-cabecalho" onClick={() => setMostrarInativas((v) => !v)}>
            {mostrarInativas ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {mostrarInativas ? `Ocultar ${inativas.length} taxa(s) desativada(s)` : `Mostrar ${inativas.length} taxa(s) desativada(s)`}
            <span className="page-sub" style={{ margin: 0 }}>— não entram em nenhum cálculo</span>
          </button>
          {mostrarInativas && (
            <table className="data-table" style={{ marginTop: 8, opacity: 0.75 }}>
              <tbody>
                {inativas.map((t) => (
                  <LinhaTaxa key={t.id} taxa={t} onChange={(patch) => atualizar(t.id, patch)} onRemover={() => removerTaxa(t.id)} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="total-banner" style={{ marginTop: 16 }}>
        Efeito total das taxas ativas numa venda de {brl(VALOR_REFERENCIA)}
        <span className="mono">{brl(totalEm100)} ({pct(totalEm100 / VALOR_REFERENCIA)})</span>
      </div>

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
