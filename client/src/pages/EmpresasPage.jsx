import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Select, Toggle } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import BarraAlteracoes from '../components/BarraAlteracoes';

const REGIMES = ['Simples Nacional', 'Lucro Presumido', 'Lucro Real'];

const CAMPOS_SALVOS = [
  'nome', 'regime_tributario', 'usa_aliquota_media', 'aliquota_media_pct',
  'simples_aliquota', 'icms', 'pis', 'cofins', 'ipi', 'iss', 'outros_impostos',
];

export default function EmpresasPage() {
  const [servidor, setServidor] = useState([]);
  const [rascunho, setRascunho] = useState([]);
  const [salvando, setSalvando] = useState(false);
  const [mensagemSalvo, setMensagemSalvo] = useState('');

  function load() {
    api.get('/empresas').then((data) => { setServidor(data); setRascunho(data); });
  }

  useEffect(load, []);

  function atualizar(id, patch) {
    setRascunho((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  async function addEmpresa() {
    const created = await api.post('/empresas', {
      nome: 'Nova Empresa',
      regime_tributario: 'Simples Nacional',
      ordem: rascunho.length + 1,
    });
    setServidor((list) => [...list, created]);
    setRascunho((list) => [...list, created]);
  }

  async function removeEmpresa(id) {
    if (!(await confirmar('Remover esta empresa? Só é possível se não houver produtos vinculados a ela.'))) return;
    try {
      await api.del(`/empresas/${id}`);
      setServidor((list) => list.filter((e) => e.id !== id));
      setRascunho((list) => list.filter((e) => e.id !== id));
    } catch (e) {
      alert(e.message);
    }
  }

  const camposAlterados = useMemo(() => {
    const nomes = [];
    for (const e of rascunho) {
      const original = servidor.find((s) => s.id === e.id);
      if (!original) continue;
      if (JSON.stringify(original) !== JSON.stringify(e)) nomes.push(e.nome || 'empresa');
    }
    return nomes;
  }, [rascunho, servidor]);

  async function salvar() {
    setSalvando(true);
    try {
      const alteradas = rascunho.filter((e) => {
        const original = servidor.find((s) => s.id === e.id);
        return original && JSON.stringify(original) !== JSON.stringify(e);
      });
      const resultados = await Promise.all(alteradas.map((e) => {
        const patch = {};
        for (const campo of CAMPOS_SALVOS) patch[campo] = e[campo];
        return api.put(`/empresas/${e.id}`, patch);
      }));
      const porId = new Map(resultados.map((r) => [r.id, r]));
      setServidor((list) => list.map((e) => porId.get(e.id) || e));
      setRascunho((list) => list.map((e) => porId.get(e.id) || e));
      setMensagemSalvo('Salvo · há instantes');
      setTimeout(() => setMensagemSalvo(''), 3000);
    } finally {
      setSalvando(false);
    }
  }

  function descartar() {
    setRascunho(servidor);
  }

  return (
    <div className="page-wide">
      <h2>Empresas / Pessoas Jurídicas</h2>
      <p className="page-sub">
        Cada empresa tem seu próprio regime tributário e alíquotas. Cada produto será associado
        a uma delas para saber qual conjunto de impostos usar na formação de preço.
      </p>

      {rascunho.map((emp) => (
        <div className="card" style={{ marginBottom: 16 }} key={emp.id}>
          <div className="card-head-linha">
            <div className="card-head">{emp.nome || 'Empresa'}</div>
            <button className="icon-btn" onClick={() => removeEmpresa(emp.id)}>
              <Trash2 size={14} />
            </button>
          </div>
          <div className="form-grid">
            <Field label="Nome / Razão Social">
              <input
                value={emp.nome}
                onChange={(e) => atualizar(emp.id, { nome: e.target.value })}
              />
            </Field>
            <Field label="Regime Tributário">
              <Select
                value={emp.regime_tributario}
                onChange={(e) => atualizar(emp.id, { regime_tributario: e.target.value })}
              >
                {REGIMES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="form-grid" style={{ marginTop: 14 }}>
            <Field label="Usar alíquota média provisória?" hint="Ative se ainda não tem os dados fiscais detalhados — usa uma % única no lugar do detalhamento abaixo, em todos os cálculos (Ficha de Custo, preço e lucratividade).">
              <label className="toggle">
                <Toggle
                  checked={emp.usa_aliquota_media}
                  onChange={(e) => atualizar(emp.id, { usa_aliquota_media: e.target.checked })}
                />
                {emp.usa_aliquota_media ? 'Sim' : 'Não'}
              </label>
            </Field>
            {emp.usa_aliquota_media && (
              <Field label="% média de imposto (provisório)">
                <NumInput
                  value={emp.aliquota_media_pct * 100}
                  onChange={(v) => atualizar(emp.id, { aliquota_media_pct: (Number(v) || 0) / 100 })}
                  suffix="%"
                />
              </Field>
            )}
          </div>

          {emp.usa_aliquota_media ? null : emp.regime_tributario === 'Simples Nacional' ? (
            <div className="form-grid" style={{ marginTop: 14 }}>
              <Field
                label="Alíquota efetiva do Simples Nacional"
                hint="Use a alíquota EFETIVA (conforme Fator R e anexo da empresa), não a nominal da tabela."
              >
                <NumInput
                  value={emp.simples_aliquota * 100}
                  onChange={(v) => atualizar(emp.id, { simples_aliquota: (Number(v) || 0) / 100 })}
                  suffix="%"
                />
              </Field>
            </div>
          ) : (
            <div className="form-grid" style={{ marginTop: 14 }}>
              <Field label="ICMS">
                <NumInput value={emp.icms * 100} onChange={(v) => atualizar(emp.id, { icms: (Number(v) || 0) / 100 })} suffix="%" />
              </Field>
              <Field label="PIS">
                <NumInput value={emp.pis * 100} onChange={(v) => atualizar(emp.id, { pis: (Number(v) || 0) / 100 })} suffix="%" />
              </Field>
              <Field label="COFINS">
                <NumInput value={emp.cofins * 100} onChange={(v) => atualizar(emp.id, { cofins: (Number(v) || 0) / 100 })} suffix="%" />
              </Field>
              <Field label="IPI">
                <NumInput value={emp.ipi * 100} onChange={(v) => atualizar(emp.id, { ipi: (Number(v) || 0) / 100 })} suffix="%" />
              </Field>
              <Field label="ISS (se serviço)">
                <NumInput value={emp.iss * 100} onChange={(v) => atualizar(emp.id, { iss: (Number(v) || 0) / 100 })} suffix="%" />
              </Field>
            </div>
          )}

          {!emp.usa_aliquota_media && (
            <div className="form-grid" style={{ marginTop: 14 }}>
              <Field label="Outros impostos / taxas fiscais">
                <NumInput
                  value={emp.outros_impostos * 100}
                  onChange={(v) => atualizar(emp.id, { outros_impostos: (Number(v) || 0) / 100 })}
                  suffix="%"
                />
              </Field>
            </div>
          )}

          <div className="total-banner" style={{ marginTop: 14 }}>
            % total de impostos sobre o preço de venda
            <span className="mono">
              {(
                emp.usa_aliquota_media
                  ? Number(emp.aliquota_media_pct)
                  : (emp.regime_tributario === 'Simples Nacional'
                      ? Number(emp.simples_aliquota)
                      : Number(emp.icms) + Number(emp.pis) + Number(emp.cofins) + Number(emp.ipi) + Number(emp.iss)) +
                    Number(emp.outros_impostos)
              ).toLocaleString('pt-BR', { style: 'percent', minimumFractionDigits: 1 })}
            </span>
          </div>
        </div>
      ))}

      <button className="btn btn-dashed" onClick={addEmpresa}>
        <Plus size={13} /> Adicionar empresa
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
