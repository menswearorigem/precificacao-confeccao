import { useEffect, useMemo, useState } from 'react';
import {
  UserPlus, Search, Trash2, Pencil, BadgePercent, Target, Link2, Link2Off, Users, Info,
} from 'lucide-react';
import { api } from '../api/client';
import { Field, Select, NumInput, Toggle, Checkbox, EstadoVazio, AvisoDeFalha, Skeleton } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import { confirmar } from '../components/ConfirmDialog';
import { brl, pct, formatQtd, dataBr } from '../lib/format';
import { CampoNome, CampoTelefone, CampoEmail } from '../components/campos';

// Cadastro de vendedores (09/09/2026).
//
// Vive em dois lugares de propósito, com o MESMO componente: em Configurações
// › Vendedores (é lá que a comissão é definida, e Configurações é o módulo de
// quem define) e como sub-aba de Acessos › Vendedores (é lá que quem
// administra usuários já está quando pensa "essa pessoa vai vender"). Uma
// tela só, dois caminhos — duas telas iguais divergem no primeiro ajuste
// feito só de um lado.

const PRESET_MES = PRESETS_PERIODO.find((p) => p.chave === 'esteMes').calcular();

const TIPOS_COMISSAO = [
  { valor: 'percentual_receita', rotulo: '% sobre o faturamento', ajuda: 'Percentual do valor vendido no pedido.' },
  { valor: 'percentual_lucro', rotulo: '% sobre o lucro', ajuda: 'Percentual do lucro do pedido (receita menos custo da peça e imposto).' },
  { valor: 'valor_por_peca', rotulo: 'R$ por peça', ajuda: 'Valor fixo para cada peça vendida.' },
];

function rotuloComissao(vendedor) {
  const valor = Number(vendedor.comissao_valor) || 0;
  if (valor <= 0) return 'Sem comissão';
  if (vendedor.comissao_tipo === 'valor_por_peca') return `${brl(valor)} por peça`;
  const base = vendedor.comissao_tipo === 'percentual_lucro' ? 'do lucro' : 'do faturamento';
  return `${pct(valor)} ${base}`;
}

function vendedorVazio() {
  return {
    nome: '', apelido: '', usuario_id: '', telefone: '', email: '',
    comissao_tipo: 'percentual_receita', comissao_valor: 0,
    comissao_somente_faturado: true, meta_mensal: 0, observacao: '',
  };
}

function FormularioVendedor({ valor, onChange, usuarios, mostrarUsuario = true }) {
  const tipo = TIPOS_COMISSAO.find((t) => t.valor === valor.comissao_tipo) || TIPOS_COMISSAO[0];
  const porPeca = valor.comissao_tipo === 'valor_por_peca';
  return (
    <>
      <div className="form-grid">
        <Field label="Nome">
          <CampoNome
            value={valor.nome}
            onChange={(e) => onChange({ nome: e.target.value })}
            placeholder="Como aparece no pedido e no relatório"
          />
        </Field>
        <Field label="Apelido (opcional)" hint="Usado nos cartões estreitos do celular.">
          <input value={valor.apelido || ''} onChange={(e) => onChange({ apelido: e.target.value })} />
        </Field>
        <Field label="Telefone">
          <CampoTelefone value={valor.telefone || ''} onChange={(e) => onChange({ telefone: e.target.value })} />
        </Field>
        <Field label="E-mail">
          <CampoEmail value={valor.email || ''} onChange={(e) => onChange({ email: e.target.value })} />
        </Field>
        {mostrarUsuario && (
          <Field
            label="Conta de acesso ao sistema"
            hint="Ligando a conta, todo pedido que essa pessoa criar já nasce no nome dela."
          >
            <Select value={valor.usuario_id || ''} onChange={(e) => onChange({ usuario_id: e.target.value })}>
              <option value="">Vendedor sem login no sistema</option>
              {usuarios.map((u) => (
                <option key={u.id} value={u.id}>{u.nome}{u.ativo ? '' : ' (conta desativada)'}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Meta de faturamento no mês" hint="Deixe zero se essa pessoa não tem meta.">
          <NumInput value={valor.meta_mensal} onChange={(v) => onChange({ meta_mensal: v })} suffix="R$" />
        </Field>
      </div>

      <div className="card-head" style={{ marginTop: 18 }}>Comissão</div>
      <div className="form-grid">
        <Field label="Como é calculada" hint={tipo.ajuda}>
          <Select value={valor.comissao_tipo} onChange={(e) => onChange({ comissao_tipo: e.target.value })}>
            {TIPOS_COMISSAO.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
          </Select>
        </Field>
        <Field label={porPeca ? 'Valor por peça' : 'Percentual'}>
          {porPeca ? (
            <NumInput value={valor.comissao_valor} onChange={(v) => onChange({ comissao_valor: v })} suffix="R$" />
          ) : (
            <NumInput
              value={(Number(valor.comissao_valor) || 0) * 100}
              onChange={(v) => onChange({ comissao_valor: (Number(v) || 0) / 100 })}
              suffix="%"
            />
          )}
        </Field>
      </div>
      <label className="toggle" style={{ marginTop: 10 }}>
        <Checkbox
          checked={valor.comissao_somente_faturado !== false}
          onChange={(e) => onChange({ comissao_somente_faturado: e.target.checked })}
        />
        Só contar comissão depois que o pedido for faturado
      </label>
      {valor.comissao_tipo === 'percentual_lucro' && (
        <div className="venda-ressalva">
          <Info size={14} />
          <span>
            Comissão sobre o lucro precisa do custo da peça cadastrado. Pedido com item sem custo
            fica marcado como <strong>não calculável</strong> no relatório, em vez de entrar como
            comissão zero — assim ninguém paga a menos sem saber.
          </span>
        </div>
      )}
      <Field label="Observação">
        <textarea rows={2} value={valor.observacao || ''} onChange={(e) => onChange({ observacao: e.target.value })} />
      </Field>
    </>
  );
}

export default function VendedoresPage({ embutido = false }) {
  const [vendedores, setVendedores] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [mostrarInativos, setMostrarInativos] = useState(false);
  const [{ inicio, fim }, setPeriodo] = useState(PRESET_MES);

  const [criando, setCriando] = useState(false);
  const [novo, setNovo] = useState(vendedorVazio());
  const [salvando, setSalvando] = useState(false);
  const [editandoId, setEditandoId] = useState(null);
  const [rascunho, setRascunho] = useState(null);

  function carregar() {
    setLoading(true);
    setErro('');
    const params = new URLSearchParams({ com_resumo: '1', incluir_inativos: '1' });
    if (inicio) params.set('data_inicio', inicio);
    if (fim) params.set('data_fim', fim);
    Promise.all([
      api.get(`/vendedores?${params.toString()}`),
      api.get('/vendedores/usuarios-disponiveis').catch(() => []),
    ])
      .then(([v, u]) => { setVendedores(v); setUsuarios(u); })
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(carregar, [inicio, fim]);

  const lista = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return vendedores.filter((v) => {
      if (!mostrarInativos && !v.ativo) return false;
      if (!termo) return true;
      return [v.nome, v.apelido, v.email, v.telefone, v.usuario_nome]
        .some((c) => String(c || '').toLowerCase().includes(termo));
    });
  }, [vendedores, busca, mostrarInativos]);

  const totais = useMemo(() => {
    const ativos = vendedores.filter((v) => v.ativo);
    return {
      ativos: ativos.length,
      comLogin: ativos.filter((v) => v.usuario_id).length,
      receita: vendedores.reduce((s, v) => s + (v.resumo?.receita || 0), 0),
      comMeta: ativos.filter((v) => Number(v.meta_mensal) > 0).length,
    };
  }, [vendedores]);

  async function salvarNovo(e) {
    e.preventDefault();
    if (!novo.nome.trim()) return;
    setSalvando(true);
    setErro('');
    try {
      await api.post('/vendedores', { ...novo, usuario_id: novo.usuario_id || null });
      setNovo(vendedorVazio());
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
      await api.put(`/vendedores/${id}`, { ...rascunho, usuario_id: rascunho.usuario_id || null });
      setEditandoId(null);
      setRascunho(null);
      carregar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarAtivo(vendedor) {
    if (vendedor.ativo && !(await confirmar(
      `Desativar "${vendedor.nome}"? Ele some dos seletores de venda novos, mas continua aparecendo `
      + 'em todo pedido e relatório de comissão que já existe.',
      { confirmarTexto: 'Desativar', perigo: false }
    ))) return;
    try {
      await api.put(`/vendedores/${vendedor.id}`, { ativo: !vendedor.ativo });
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function excluir(vendedor) {
    if (!(await confirmar(`Excluir o vendedor "${vendedor.nome}"?`))) return;
    try {
      await api.del(`/vendedores/${vendedor.id}`);
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  const conteudo = (
    <>
      {!embutido && (
        <p className="page-sub">
          Quem vende, como a comissão de cada um é calculada e qual é a meta do mês. O vendedor
          escolhido no pedido é o que aparece no relatório de lucratividade e no cálculo de comissão.
        </p>
      )}

      <div className="stat-strip">
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Vendedores ativos</span>
            <span className="stat-card-value">{formatQtd(totais.ativos)}</span>
          </div>
          <Users size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Com login no sistema</span>
            <span className="stat-card-value">{formatQtd(totais.comLogin)}</span>
          </div>
          <Link2 size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Vendido no período</span>
            <span className="stat-card-value">{brl(totais.receita)}</span>
          </div>
          <BadgePercent size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
        </div>
        <div className="stat-card">
          <div className="stat-card-corpo">
            <span className="stat-card-label">Com meta definida</span>
            <span className="stat-card-value">{formatQtd(totais.comMeta)}</span>
          </div>
          <Target size={18} className="stat-card-icone" style={{ color: 'var(--brass)' }} />
        </div>
      </div>

      <div className="filtros-barra">
        <PeriodoFiltro inicio={inicio} fim={fim} onChange={({ inicio: i, fim: f }) => setPeriodo({ inicio: i, fim: f })} />
        <div className="filtros-barra-busca">
          <Search size={14} />
          <input placeholder="Nome, apelido, telefone ou conta" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <label className="toggle">
          <Toggle checked={mostrarInativos} onChange={(e) => setMostrarInativos(e.target.checked)} />
          Mostrar desativados
        </label>
        <div className="filtros-barra-acoes">
          <button type="button" className="btn btn-primary" onClick={() => setCriando((v) => !v)}>
            <UserPlus size={14} /> Novo vendedor
          </button>
        </div>
      </div>

      <AvisoDeFalha mensagem={erro} aoTentarDeNovo={carregar} />

      {criando && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={salvarNovo}>
          <div className="card-head">Novo vendedor</div>
          <FormularioVendedor valor={novo} onChange={(patch) => setNovo((v) => ({ ...v, ...patch }))} usuarios={usuarios} />
          <div className="painel-acoes-inline" style={{ marginTop: 14 }}>
            <button type="submit" className="btn btn-primary" disabled={salvando || !novo.nome.trim()}>
              {salvando ? 'Salvando…' : 'Cadastrar vendedor'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setCriando(false); setNovo(vendedorVazio()); }}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {loading && vendedores.length === 0 && <Skeleton height={180} />}

      {!loading && lista.length === 0 && (
        <EstadoVazio
          Icone={Users}
          titulo={busca ? 'Nenhum vendedor com esse nome' : 'Nenhum vendedor cadastrado ainda'}
          descricao={busca
            ? 'Tente outro termo ou marque "Mostrar desativados".'
            : 'Cadastre quem vende para poder vincular cada pedido a uma pessoa e acompanhar comissão e meta.'}
          onAcao={() => setCriando(true)}
          acaoLabel="Novo vendedor"
          IconeAcao={UserPlus}
        />
      )}

      <div className="vendas-cards">
        {lista.map((v) => {
          const emEdicao = editandoId === v.id;
          const meta = Number(v.meta_mensal) || 0;
          const receita = v.resumo?.receita || 0;
          const atingido = meta > 0 ? receita / meta : null;
          return (
            <div key={v.id} className={'vendedor-card' + (v.ativo ? '' : ' inativo')}>
              <div className="vendedor-card-topo">
                <div style={{ minWidth: 0 }}>
                  <div className="vendedor-nome">{v.nome}</div>
                  <div className="vendedor-sub">
                    {rotuloComissao(v)}
                    {v.comissao_somente_faturado === false && ' · conta mesmo em aberto'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                    {v.usuario_id ? (
                      <span className="venda-selo-vendedor"><Link2 size={11} /> {v.usuario_nome || 'conta ligada'}</span>
                    ) : (
                      <span className="venda-selo-vendedor sem-vendedor"><Link2Off size={11} /> sem login</span>
                    )}
                    {!v.ativo && <span className="selo tone-neutro">desativado</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className="btn-icone"
                    title="Editar"
                    onClick={() => { setEditandoId(emEdicao ? null : v.id); setRascunho({ ...v }); }}
                  >
                    <Pencil size={15} />
                  </button>
                  {(v.resumo?.pedidos || 0) === 0 && (
                    <button type="button" className="icon-btn perigo" title="Excluir" onClick={() => excluir(v)}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>

              {!emEdicao && (
                <>
                  <div className="vendedor-numeros">
                    <div>
                      <div className="vendedor-numero-rotulo">Vendido</div>
                      <div className="vendedor-numero-valor">{brl(receita)}</div>
                    </div>
                    <div>
                      <div className="vendedor-numero-rotulo">Pedidos</div>
                      <div className="vendedor-numero-valor">{formatQtd(v.resumo?.pedidos || 0)}</div>
                    </div>
                    <div>
                      <div className="vendedor-numero-rotulo">Peças</div>
                      <div className="vendedor-numero-valor">{formatQtd(v.resumo?.pecas || 0)}</div>
                    </div>
                    <div>
                      <div className="vendedor-numero-rotulo">Última venda</div>
                      <div className="vendedor-numero-valor" style={{ fontSize: 12.5 }}>
                        {v.resumo?.ultimaVenda ? dataBr(String(v.resumo.ultimaVenda).slice(0, 10)) : '—'}
                      </div>
                    </div>
                  </div>

                  {meta > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--ink-soft)' }}>
                        <span>Meta do mês: <span className="mono">{brl(meta)}</span></span>
                        <span className="mono">{pct(atingido)}</span>
                      </div>
                      <div className="meta-barra">
                        <span
                          className={atingido >= 1 ? 'batida' : undefined}
                          style={{ width: `${Math.min(100, Math.max(0, atingido * 100))}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="painel-acoes-inline">
                    <button type="button" className="btn btn-ghost sm" onClick={() => alternarAtivo(v)}>
                      {v.ativo ? 'Desativar' : 'Reativar'}
                    </button>
                  </div>
                </>
              )}

              {emEdicao && rascunho && (
                <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
                  <FormularioVendedor
                    valor={rascunho}
                    onChange={(patch) => setRascunho((r) => ({ ...r, ...patch }))}
                    usuarios={rascunho.usuario_id
                      ? [{ id: rascunho.usuario_id, nome: rascunho.usuario_nome || 'conta ligada', ativo: true }, ...usuarios]
                      : usuarios}
                  />
                  <div className="painel-acoes-inline" style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-primary" onClick={() => salvarEdicao(v.id)} disabled={salvando}>
                      {salvando ? 'Salvando…' : 'Salvar'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => { setEditandoId(null); setRascunho(null); }}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  if (embutido) return conteudo;
  return (
    <div className="page-wide">
      <h1>Vendedores</h1>
      {conteudo}
    </div>
  );
}
