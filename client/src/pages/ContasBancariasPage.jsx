import { useEffect, useMemo, useState } from 'react';
import {
  Landmark, Plus, Pencil, Check, X, Trash2, Wallet, PiggyBank, Search, AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client';
import {
  Field, Select, NumInput, DateInput, Toggle, Skeleton, EstadoVazio, AvisoDeFalha, Row,
} from '../components/ui';
import { CampoTextoLimitado } from '../components/campos';
import { confirmar } from '../components/ConfirmDialog';
import { brl, formatQtd, dataBr } from '../lib/format';

// ============================================================================
// Financeiro › Contas Bancárias — 10/09/2026
// ============================================================================
// A tabela `fin_contas` existe desde a migration 0055 e é a espinha do núcleo
// financeiro: é dela que a Conciliação Bancária tira o seletor de conta, é
// nela que a baixa de título registra de onde saiu o dinheiro, e é o saldo
// inicial dela que faz o saldo atual bater com o extrato do banco.
//
// O que faltava era a TELA. Até aqui, conta só nascia pela sincronização do
// Wik ou por uma chamada de API solta — quem digitasse o saldo inicial errado
// não tinha como corrigir, e conta encerrada continuava aparecendo no seletor
// da Conciliação para sempre. Esta aba fecha esse buraco.
//
// Duas decisões que estão no código e merecem estar escritas:
//
//   · Conta que veio do Wik (`wik_grp_id`) tem nome, tipo, agência e conta
//     SOBRESCRITOS a cada sincronização (lib/wikFinanceiroSync.js). Editar
//     esses campos aqui seria trabalho perdido — a tela os trava e diz por
//     quê. Saldo inicial, data do saldo e nome do banco NÃO são tocados pelo
//     Wik: esses ficam livres.
//   · Conta com extrato ou baixa não é excluída, é desativada. A FK do extrato
//     é ON DELETE CASCADE: apagar a conta levaria junto todo o extrato já
//     conciliado, e o DRE de um mês fechado deixaria de bater.

const BASE = '/financeiro-nucleo';

const TIPOS = [
  { valor: 'bancaria', rotulo: 'Conta bancária', Icone: Landmark },
  { valor: 'caixa', rotulo: 'Caixa / cofre', Icone: Wallet },
  { valor: 'aplicacao', rotulo: 'Aplicação', Icone: PiggyBank },
];

const rotuloTipo = (t) => TIPOS.find((x) => x.valor === t)?.rotulo || 'Conta bancária';
const IconeTipo = (t) => TIPOS.find((x) => x.valor === t)?.Icone || Landmark;

const contaVazia = () => ({
  empresa_id: '',
  nome: '',
  tipo: 'bancaria',
  banco_codigo: '',
  banco_nome: '',
  agencia: '',
  conta: '',
  saldo_inicial: 0,
  saldo_inicial_data: '',
});

// Código e número de conta são identificadores do banco: dígito e traço, nunca
// letra. Mesma regra do resto do sistema, só que local — não é um dos campos
// nomeados na padronização de cadastro.
const soNumeroEHifen = (v) => String(v ?? '').replace(/[^0-9\-.]/g, '');

function Formulario({ valor, onChange, empresas, travado, novo }) {
  return (
    <div className="form-grid">
      <Field label="Empresa (CNPJ)" hint={novo ? 'Decide de qual CNPJ é esse dinheiro. Não muda depois.' : 'Não muda depois que a conta tem lançamento.'}>
        <Select
          value={String(valor.empresa_id || '')}
          onChange={(e) => onChange({ empresa_id: e.target.value })}
          disabled={!novo}
          placeholder="Escolha a empresa"
        >
          {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
        </Select>
      </Field>

      <Field label="Nome da conta" hint="Como a casa chama essa conta: “Itaú Origem”, “Caixa da loja”.">
        <CampoTextoLimitado
          value={valor.nome || ''}
          onChange={(e) => onChange({ nome: e.target.value })}
          disabled={travado}
          placeholder="Itaú — Origem"
        />
      </Field>

      <Field label="Tipo">
        <Select value={valor.tipo || 'bancaria'} onChange={(e) => onChange({ tipo: e.target.value })} disabled={travado}>
          {TIPOS.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
        </Select>
      </Field>

      <Field label="Banco">
        <CampoTextoLimitado
          limite={80}
          value={valor.banco_nome || ''}
          onChange={(e) => onChange({ banco_nome: e.target.value })}
          placeholder="Itaú Unibanco"
        />
      </Field>

      <Field label="Código do banco" hint="Os três números do banco (341, 001, 237…).">
        <input
          className="mono"
          inputMode="numeric"
          maxLength={5}
          value={valor.banco_codigo || ''}
          onChange={(e) => onChange({ banco_codigo: soNumeroEHifen(e.target.value) })}
          placeholder="341"
        />
      </Field>

      <Field label="Agência">
        <input
          className="mono"
          inputMode="numeric"
          maxLength={15}
          value={valor.agencia || ''}
          onChange={(e) => onChange({ agencia: soNumeroEHifen(e.target.value) })}
          disabled={travado}
          placeholder="1234"
        />
      </Field>

      <Field label="Conta com dígito">
        <input
          className="mono"
          inputMode="numeric"
          maxLength={25}
          value={valor.conta || ''}
          onChange={(e) => onChange({ conta: soNumeroEHifen(e.target.value) })}
          disabled={travado}
          placeholder="56789-0"
        />
      </Field>

      <Field label="Saldo inicial" hint="O saldo do extrato no dia abaixo. É a partir dele que o saldo atual é calculado.">
        <NumInput value={valor.saldo_inicial ?? 0} onChange={(v) => onChange({ saldo_inicial: v })} suffix="R$" />
      </Field>

      <Field label="Data do saldo inicial" hint="O dia em que aquele saldo era verdade no extrato.">
        <DateInput
          value={valor.saldo_inicial_data ? String(valor.saldo_inicial_data).slice(0, 10) : ''}
          onChange={(e) => onChange({ saldo_inicial_data: e.target.value })}
        />
      </Field>
    </div>
  );
}

export default function ContasBancariasPage() {
  const [contas, setContas] = useState([]);
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [mostrarInativas, setMostrarInativas] = useState(false);

  const [criando, setCriando] = useState(false);
  const [nova, setNova] = useState(contaVazia());
  const [editandoId, setEditandoId] = useState(null);
  const [rascunho, setRascunho] = useState(null);
  const [salvando, setSalvando] = useState(false);

  function carregar() {
    setLoading(true);
    setErro('');
    Promise.all([
      api.get(`${BASE}/contas?todas=true`),
      api.get('/empresas').catch(() => []),
    ])
      .then(([c, e]) => { setContas(c || []); setEmpresas(e || []); })
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(carregar, []);

  const filtradas = useMemo(() => {
    const alvo = busca.trim().toLowerCase();
    return contas
      .filter((c) => (mostrarInativas ? true : c.ativo))
      .filter((c) => !alvo || [c.nome, c.banco_nome, c.agencia, c.conta, c.empresa_nome]
        .filter(Boolean).join(' ').toLowerCase().includes(alvo));
  }, [contas, busca, mostrarInativas]);

  const totais = useMemo(() => {
    const ativas = contas.filter((c) => c.ativo);
    return {
      ativas: ativas.length,
      saldo: ativas.reduce((s, c) => s + Number(c.saldo_atual || 0), 0),
      doWik: contas.filter((c) => c.wik_grp_id).length,
    };
  }, [contas]);

  async function salvarNova(e) {
    e.preventDefault();
    if (!nova.empresa_id) { setErro('Escolha a empresa dona da conta.'); return; }
    if (!String(nova.nome).trim()) { setErro('A conta precisa de um nome.'); return; }
    setSalvando(true);
    setErro('');
    try {
      await api.post(`${BASE}/contas`, {
        ...nova,
        saldo_inicial: Number(nova.saldo_inicial) || 0,
        saldo_inicial_data: nova.saldo_inicial_data || null,
      });
      setNova(contaVazia());
      setCriando(false);
      carregar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function salvarEdicao(id) {
    setSalvando(true);
    setErro('');
    try {
      await api.put(`${BASE}/contas/${id}`, {
        ...rascunho,
        saldo_inicial: Number(rascunho.saldo_inicial) || 0,
        saldo_inicial_data: rascunho.saldo_inicial_data || null,
      });
      setEditandoId(null);
      setRascunho(null);
      carregar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarAtiva(conta) {
    if (conta.ativo && !(await confirmar(
      `Desativar "${conta.nome}"? Ela some do seletor da Conciliação e da baixa de título, mas todo `
      + 'o extrato e as baixas que já existem continuam valendo.',
      { confirmarTexto: 'Desativar', perigo: false }
    ))) return;
    try {
      await api.put(`${BASE}/contas/${conta.conta_id}`, { ativo: !conta.ativo });
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function excluir(conta) {
    if (!(await confirmar(`Excluir a conta "${conta.nome}"?`))) return;
    try {
      await api.del(`${BASE}/contas/${conta.conta_id}`);
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <div className="page-wide">
      <h1><Landmark size={20} /> Contas Bancárias</h1>
      <p className="page-sub">
        As contas, caixas e aplicações por onde o dinheiro entra e sai. É esta lista que abastece o
        seletor da Conciliação Bancária e a baixa de título — e é o saldo inicial daqui que faz o
        saldo do sistema bater com o extrato do banco.
      </p>

      <div className="stat-strip">
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Contas ativas</span>
            <span className="stat-card-value">{formatQtd(totais.ativas)}</span>
          </div>
          <Landmark size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Saldo somado</span>
            <span className="stat-card-value">{brl(totais.saldo)}</span>
          </div>
          <Wallet size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Vindas do Wik</span>
            <span className="stat-card-value">{formatQtd(totais.doWik)}</span>
          </div>
          <AlertTriangle size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
        </div>
      </div>

      <div className="filtros-barra">
        <div className="filtros-barra-busca">
          <Search size={14} />
          <input
            placeholder="Nome, banco, agência ou conta"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
        <label className="toggle">
          <Toggle checked={mostrarInativas} onChange={(e) => setMostrarInativas(e.target.checked)} />
          Mostrar desativadas
        </label>
        <div className="filtros-barra-acoes">
          <button type="button" className="btn btn-primary" onClick={() => setCriando((v) => !v)}>
            <Plus size={14} /> Nova conta
          </button>
        </div>
      </div>

      <AvisoDeFalha mensagem={erro} aoTentarDeNovo={carregar} />

      {criando && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={salvarNova}>
          <div className="card-head">Nova conta</div>
          <Formulario
            valor={nova}
            onChange={(patch) => setNova((c) => ({ ...c, ...patch }))}
            empresas={empresas}
            novo
          />
          <div className="painel-acoes-inline" style={{ marginTop: 14 }}>
            <button type="submit" className="btn btn-primary" disabled={salvando}>
              <Check size={14} /> {salvando ? 'Salvando…' : 'Salvar conta'}
            </button>
            <button type="button" className="btn-sec" onClick={() => { setCriando(false); setNova(contaVazia()); }}>
              <X size={14} /> Cancelar
            </button>
          </div>
        </form>
      )}

      {loading && contas.length === 0 && (
        <div className="card"><Skeleton height={160} /></div>
      )}

      {!loading && filtradas.length === 0 && (
        <EstadoVazio
          Icone={Landmark}
          titulo="Nenhuma conta cadastrada"
          descricao="Cadastre a conta do banco (ou o caixa da loja) para conseguir conciliar o extrato e dar baixa em título."
          acaoLabel="Nova conta"
          onAcao={() => setCriando(true)}
          IconeAcao={Plus}
        />
      )}

      <div className="grid-2" style={{ gap: 16 }}>
        {filtradas.map((c) => {
          const editando = editandoId === c.conta_id;
          const doWik = Boolean(c.wik_grp_id);
          const Icone = IconeTipo(c.tipo);
          return (
            <div className="card" key={c.conta_id} style={{ opacity: c.ativo ? 1 : 0.62 }}>
              <div className="card-head-linha">
                <div className="card-head" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Icone size={15} /> {c.nome}
                  {!c.ativo && <span className="stamp sm tone-neutro">desativada</span>}
                  {doWik && <span className="stamp sm tone-neutro">Wik</span>}
                </div>
                <div className="painel-acoes-inline">
                  {!editando && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Editar conta"
                      aria-label="Editar conta"
                      onClick={() => { setEditandoId(c.conta_id); setRascunho({ ...c }); }}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn perigo"
                    title="Excluir conta"
                    aria-label="Excluir conta"
                    onClick={() => excluir(c)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {!editando && (
                <>
                  <div className="stat-strip" style={{ marginTop: 4 }}>
                    <div className="stat-card">
                      <div className="stat-card-corpo">
                        <span className="stat-card-label">Saldo atual</span>
                        <span className="stat-card-value mono">{brl(c.saldo_atual)}</span>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-card-corpo">
                        <span className="stat-card-label">Saldo inicial</span>
                        <span className="stat-card-value mono">{brl(c.saldo_inicial)}</span>
                      </div>
                    </div>
                  </div>
                  <Row label="Empresa" value={c.empresa_nome || '—'} />
                  <Row label="Tipo" value={rotuloTipo(c.tipo)} />
                  <Row label="Banco" value={`${c.banco_nome || '—'}${c.banco_codigo ? ` (${c.banco_codigo})` : ''}`} />
                  <Row label="Agência / conta" value={[c.agencia, c.conta].filter(Boolean).join(' / ') || '—'} />
                  <Row
                    label="Último lançamento"
                    value={c.ultimo_lancamento ? dataBr(String(c.ultimo_lancamento).slice(0, 10)) : 'nenhum'}
                  />
                  <div className="painel-acoes-inline" style={{ marginTop: 10 }}>
                    <button type="button" className="btn-sec" onClick={() => alternarAtiva(c)}>
                      {c.ativo ? 'Desativar' : 'Reativar'}
                    </button>
                  </div>
                </>
              )}

              {editando && (
                <>
                  {doWik && (
                    <p className="aviso-inline" style={{ marginBottom: 10 }}>
                      <AlertTriangle size={14} />
                      Esta conta vem do Wik: nome, tipo, agência e conta são reescritos na próxima
                      sincronização, então ficam travados aqui. Banco, saldo inicial e a data do saldo
                      são seus — o Wik não mexe neles.
                    </p>
                  )}
                  <Formulario
                    valor={rascunho}
                    onChange={(patch) => setRascunho((r) => ({ ...r, ...patch }))}
                    empresas={empresas}
                    travado={doWik}
                  />
                  <div className="painel-acoes-inline" style={{ marginTop: 14 }}>
                    <button type="button" className="btn btn-primary" disabled={salvando} onClick={() => salvarEdicao(c.conta_id)}>
                      <Check size={14} /> {salvando ? 'Salvando…' : 'Salvar'}
                    </button>
                    <button type="button" className="btn-sec" onClick={() => { setEditandoId(null); setRascunho(null); }}>
                      <X size={14} /> Cancelar
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
