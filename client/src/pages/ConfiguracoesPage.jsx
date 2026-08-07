import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Field, NumInput } from '../components/ui';

const PCT_FIELDS_MARGEM = [
  ['margem_minima', 'Margem mínima aceitável'],
  ['limite_atencao', 'Limite de atenção'],
  ['limite_saudavel_ate', 'Limite de margem saudável até'],
  ['margem_ideal', 'Margem ideal (usada no preço sugerido)'],
  ['margem_premium', 'Margem premium'],
];

const PCT_FIELDS_ALERTA = [
  ['alerta_materiais_pct', 'Alerta se materiais > % do custo total'],
  ['alerta_mao_obra_pct', 'Alerta se mão de obra industrial > % do custo total'],
  ['alerta_impostos_pct', 'Alerta se impostos > % do preço de venda'],
  ['alerta_frete_pct', 'Alerta se frete > % do custo industrial'],
  ['alerta_indireto_pct', 'Alerta se custo indireto > % do custo total'],
  ['meta_lucro_pct', 'Meta de lucro por peça'],
];

const PCT_FIELDS_KIT = [
  ['desconto_kit_pct', 'Desconto sugerido no kit vs. venda avulsa'],
  ['margem_alvo_kit_pct', 'Margem alvo para preço de kit'],
];

export default function ConfiguracoesPage() {
  const [config, setConfig] = useState(null);
  const [saveState, setSaveState] = useState('idle');

  useEffect(() => {
    api.get('/configuracoes').then(setConfig);
  }, []);

  function updateField(field, pctValue) {
    setConfig((c) => ({ ...c, [field]: pctValue }));
  }

  async function handleBlurSave() {
    setSaveState('saving');
    try {
      const updated = await api.put('/configuracoes', config);
      setConfig(updated);
      setSaveState('saved');
    } catch (e) {
      setSaveState('idle');
    }
  }

  if (!config) return <div className="page">Carregando…</div>;

  function renderPctFields(list) {
    return list.map(([field, label]) => (
      <Field label={label} key={field}>
        <NumInput
          value={Number(config[field]) * 100}
          onChange={(v) => updateField(field, (Number(v) || 0) / 100)}
          onBlur={handleBlurSave}
          suffix="%"
        />
      </Field>
    ));
  }

  return (
    <div className="page">
      <h2>Configurações Gerais</h2>
      <p className="page-sub">
        Metas usadas em toda a ferramenta para calcular preços sugeridos e status de margem.
        {saveState === 'saving' && ' Salvando…'}
        {saveState === 'saved' && ' Salvo.'}
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Metas de Margem</div>
        <div className="form-grid">
          {renderPctFields(PCT_FIELDS_MARGEM)}
          <Field label="Preço máximo recomendado (x sobre o premium)">
            <NumInput
              value={config.preco_max_mult}
              onChange={(v) => updateField('preco_max_mult', Number(v) || 0)}
              onBlur={handleBlurSave}
              suffix="x"
            />
          </Field>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Limites de Alerta (inteligência do sistema)</div>
        <div className="form-grid">{renderPctFields(PCT_FIELDS_ALERTA)}</div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Parâmetros de Kits (marketplace)</div>
        <div className="form-grid">{renderPctFields(PCT_FIELDS_KIT)}</div>
      </div>

      <div className="card">
        <div className="card-head">Lucratividade de Marketplace</div>
        <div className="form-grid">
          <Field label="Custo de embalagem por pedido">
            <NumInput
              value={config.custo_embalagem_marketplace}
              onChange={(v) => updateField('custo_embalagem_marketplace', Number(v) || 0)}
              onBlur={handleBlurSave}
              suffix="R$"
            />
          </Field>
          <Field label="Pílula vermelha até (margem crítica)" hint="Margem igual ou abaixo disso aparece em vermelho.">
            <NumInput
              value={Number(config.margem_pedido_vermelho_max) * 100}
              onChange={(v) => updateField('margem_pedido_vermelho_max', (Number(v) || 0) / 100)}
              onBlur={handleBlurSave}
              suffix="%"
            />
          </Field>
          <Field label="Pílula amarela até (margem de atenção)" hint="Acima do vermelho e até aqui aparece em amarelo; acima disso, verde.">
            <NumInput
              value={Number(config.margem_pedido_amarelo_max) * 100}
              onChange={(v) => updateField('margem_pedido_amarelo_max', (Number(v) || 0) / 100)}
              onBlur={handleBlurSave}
              suffix="%"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
