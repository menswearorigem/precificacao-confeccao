import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Field, NumInput } from '../components/ui';
import BarraAlteracoes from '../components/BarraAlteracoes';
import { brl } from '../lib/format';

const LABELS_CAMPOS = {
  margem_minima: 'Mínima', limite_atencao: 'Atenção', margem_ideal: 'Margem ideal',
  limite_saudavel_ate: 'Saudável até', margem_premium: 'Premium', preco_max_mult: 'Teto',
};

const PCT_FIELDS_ALERTA = [
  ['alerta_materiais_pct', 'Materiais acima de', '% do custo', 'Tecido pesando demais no custo da peça.'],
  ['alerta_mao_obra_pct', 'Mão de obra acima de', '% do custo', 'Costura consumindo mais do que deveria.'],
  ['alerta_impostos_pct', 'Impostos acima de', '% do preço', 'Regime tributário da empresa saindo caro.'],
  ['alerta_frete_pct', 'Frete acima de', '% do industrial', 'Transporte do lote pesando na peça.'],
  ['alerta_indireto_pct', 'Custo indireto acima de', '% do custo', 'Rateio do custo fixo alto para a produção do mês.'],
  ['meta_lucro_pct', 'Lucro mínimo por peça', '%', 'Abaixo disso a peça entra na Central de Alertas.'],
];

const CUSTO_EXEMPLO = 34.99;
const ESCALA_MAX_PCT = 80;

// Ordem esperada mínima ≤ atenção ≤ ideal ≤ saudável ≤ premium — a mesma
// régua usa essa ordem tanto pra desenhar as zonas coloridas quanto pra
// validar (o teto/preco_max_mult fica DE FORA da régua, é um multiplicador
// sobre o premium, não uma margem).
const PONTOS_REGUA = [
  { chave: 'margem_minima', rotulo: 'Mínima', tom: 'danger' },
  { chave: 'limite_atencao', rotulo: 'Atenção', tom: 'warning' },
  { chave: 'margem_ideal', rotulo: 'Ideal', tom: 'terracotta', destaque: true },
  { chave: 'limite_saudavel_ate', rotulo: 'Saudável até', tom: 'info' },
  { chave: 'margem_premium', rotulo: 'Premium', tom: 'info' },
];

function validarOrdemRegua(cfg) {
  for (let i = 1; i < PONTOS_REGUA.length; i += 1) {
    const anterior = PONTOS_REGUA[i - 1];
    const atual = PONTOS_REGUA[i];
    const vAnterior = Number(cfg[anterior.chave]) * 100;
    const vAtual = Number(cfg[atual.chave]) * 100;
    if (vAtual < vAnterior) {
      return {
        atual: { ...atual, valor: vAtual },
        anterior: { ...anterior, valor: vAnterior },
      };
    }
  }
  return null;
}

// Mesma fórmula do motor de cálculo (calc.js: precoParaMargem), com
// impostos/taxas zerados de propósito — Parâmetros não sabe qual empresa
// nem quais taxas estarão ativas na hora de vender, então o exemplo ao vivo
// isola só o efeito da margem, igual ao motor faria pra pImp=pTax=0.
function precoParaMargemExemplo(custo, margem) {
  const denom = 1 - Number(margem);
  if (denom <= 0) return 0;
  return custo / denom;
}

function ReguaMargens({ cfg, onChange, disabled }) {
  const violacao = validarOrdemRegua(cfg);

  function posPct(chave) {
    return Math.min(100, Math.max(0, (Number(cfg[chave]) * 100 / ESCALA_MAX_PCT) * 100));
  }

  const zonas = [
    { de: 0, ate: posPct('margem_minima'), tom: 'var(--danger-ring)' },
    { de: posPct('margem_minima'), ate: posPct('limite_atencao'), tom: 'var(--warning)' },
    { de: posPct('limite_atencao'), ate: posPct('limite_saudavel_ate'), tom: 'var(--success-ring, var(--success))' },
    { de: posPct('limite_saudavel_ate'), ate: posPct('margem_premium'), tom: 'var(--info)' },
    { de: posPct('margem_premium'), ate: 100, tom: 'var(--border-soft)' },
  ];

  return (
    <div style={{ marginTop: 8 }}>
      <div className="cfg-regua-wrap">
        {PONTOS_REGUA.map((p, idx) => (
          idx % 2 === 0 && (
            <div key={p.chave} className="cfg-regua-marcador" style={{ left: `${posPct(p.chave)}%` }}>
              <span className="cfg-regua-marcador-label">{p.rotulo.toUpperCase()}</span>
              <NumInput
                value={Number(cfg[p.chave]) * 100}
                onChange={(v) => onChange(p.chave, (Number(v) || 0) / 100)}
                suffix="%"
                disabled={disabled}
                className={'cfg-regua-input' + (p.destaque ? ' destaque' : '')}
              />
            </div>
          )
        ))}
        <div className="cfg-regua-trilho">
          {zonas.map((z, i) => (
            <div key={i} style={{ position: 'absolute', left: `${z.de}%`, width: `${Math.max(0, z.ate - z.de)}%`, top: 0, bottom: 0, background: z.tom }} />
          ))}
          {PONTOS_REGUA.map((p) => (
            <div key={p.chave} className="cfg-regua-tique" style={{ left: `${posPct(p.chave)}%`, background: `var(--${p.tom === 'terracotta' ? 'terracotta' : p.tom === 'danger' ? 'danger-ring' : p.tom})` }} />
          ))}
        </div>
        {PONTOS_REGUA.map((p, idx) => (
          idx % 2 === 1 && (
            <div key={`${p.chave}-baixo`} className="cfg-regua-marcador abaixo" style={{ left: `${posPct(p.chave)}%` }}>
              <NumInput
                value={Number(cfg[p.chave]) * 100}
                onChange={(v) => onChange(p.chave, (Number(v) || 0) / 100)}
                suffix="%"
                disabled={disabled}
                className="cfg-regua-input"
              />
              <span className="cfg-regua-marcador-label">{p.rotulo.toUpperCase()}</span>
            </div>
          )
        ))}
      </div>
      <div className="cfg-regua-eixo">
        <span>0%</span>
        <span>{ESCALA_MAX_PCT}%</span>
      </div>

      {violacao && (
        <div className="login-error" style={{ marginTop: 12 }}>
          <strong>A ordem das faixas não fecha</strong>
          <p style={{ margin: '4px 0 0' }}>
            "{violacao.atual.rotulo} {violacao.atual.valor.toFixed(0)}%" está abaixo de "{violacao.anterior.rotulo} {violacao.anterior.valor.toFixed(0)}%"
            — o esperado é mínima ≤ atenção ≤ ideal ≤ saudável ≤ premium.
          </p>
        </div>
      )}
    </div>
  );
}

function ExemploAoVivo({ cfg }) {
  const minimo = precoParaMargemExemplo(CUSTO_EXEMPLO, cfg.margem_minima);
  const sugerido = precoParaMargemExemplo(CUSTO_EXEMPLO, cfg.margem_ideal);
  const premium = precoParaMargemExemplo(CUSTO_EXEMPLO, cfg.margem_premium);
  const teto = premium * Number(cfg.preco_max_mult || 1);

  return (
    <div className="cfg-exemplo-vivo">
      <div className="cfg-exemplo-vivo-cabecalho">
        Com estes valores, uma peça de custo <strong className="mono">{brl(CUSTO_EXEMPLO)}</strong> sai a:
      </div>
      <div className="cfg-exemplo-vivo-grade">
        <div><span>Mínimo</span><strong className="mono">{brl(minimo)}</strong></div>
        <div><span>Sugerido</span><strong className="mono" style={{ color: 'var(--terracotta)' }}>{brl(sugerido)}</strong></div>
        <div><span>Premium</span><strong className="mono">{brl(premium)}</strong></div>
        <div><span>Teto ({Number(cfg.preco_max_mult || 1).toFixed(2)}x)</span><strong className="mono">{brl(teto)}</strong></div>
      </div>
    </div>
  );
}

export default function ConfiguracoesPage() {
  const [servidor, setServidor] = useState(null);
  const [rascunho, setRascunho] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [mensagemSalvo, setMensagemSalvo] = useState('');

  function load() {
    api.get('/configuracoes').then((c) => { setServidor(c); setRascunho(c); });
  }

  useEffect(load, []);

  function atualizar(campo, valor) {
    setRascunho((r) => ({ ...r, [campo]: valor }));
  }

  const camposAlterados = useMemo(() => {
    if (!servidor || !rascunho) return [];
    return Object.keys(rascunho).filter((k) => String(rascunho[k]) !== String(servidor[k]));
  }, [servidor, rascunho]);

  async function salvar() {
    setSalvando(true);
    try {
      const atualizado = await api.put('/configuracoes', rascunho);
      setServidor(atualizado);
      setRascunho(atualizado);
      setMensagemSalvo('Salvo · há instantes');
      setTimeout(() => setMensagemSalvo(''), 3000);
    } finally {
      setSalvando(false);
    }
  }

  function descartar() {
    setRascunho(servidor);
  }

  if (!rascunho) return <div className="page">Carregando…</div>;

  return (
    <div className="page-wide">
      <h2>Parâmetros</h2>
      <p className="page-sub">
        As metas que o sistema usa para sugerir preço e julgar margem. Mudar qualquer coisa aqui muda o preço de todas as peças.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head-linha">
          <div className="card-head">Faixas de margem</div>
          <span className="cfg-usado-em">usado em: Ficha de Precificação · Central de Alertas · Lucratividade</span>
        </div>
        <ReguaMargens cfg={rascunho} onChange={atualizar} />
        <div className="form-grid" style={{ marginTop: 16, maxWidth: 320 }}>
          <Field label="Preço máximo recomendado (teto, x sobre o premium)" hint="Fica fora da régua — é um multiplicador sobre o preço premium, não uma margem.">
            <NumInput value={rascunho.preco_max_mult} onChange={(v) => atualizar('preco_max_mult', Number(v) || 0)} suffix="x" />
          </Field>
        </div>
        <ExemploAoVivo cfg={rascunho} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head-linha">
          <div className="card-head">Quando o sistema deve reclamar</div>
          <span className="cfg-usado-em">usado em: Central de Alertas · Ficha do Produto</span>
        </div>
        <div className="form-grid">
          {PCT_FIELDS_ALERTA.map(([campo, label, sufixoLabel, dica]) => (
            <Field key={campo} label={`${label} (${sufixoLabel})`} hint={dica}>
              <NumInput value={Number(rascunho[campo]) * 100} onChange={(v) => atualizar(campo, (Number(v) || 0) / 100)} suffix="%" />
            </Field>
          ))}
        </div>
      </div>

      <div className="grid-3" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-head">Kits</div>
          <Field label="Desconto vs. avulso" hint="Quanto o preço do kit sai mais barato que comprar as peças avulsas.">
            <NumInput value={Number(rascunho.desconto_kit_pct) * 100} onChange={(v) => atualizar('desconto_kit_pct', (Number(v) || 0) / 100)} suffix="%" />
          </Field>
          <Field label="Margem alvo do kit" hint="Meta de margem usada só na formação de preço de kits.">
            <NumInput value={Number(rascunho.margem_alvo_kit_pct) * 100} onChange={(v) => atualizar('margem_alvo_kit_pct', (Number(v) || 0) / 100)} suffix="%" />
          </Field>
        </div>
        <div className="card">
          <div className="card-head">Marketplace</div>
          <Field label="Embalagem por pedido" hint="Custo fixo somado na lucratividade de marketplace.">
            <NumInput value={rascunho.custo_embalagem_marketplace} onChange={(v) => atualizar('custo_embalagem_marketplace', Number(v) || 0)} suffix="R$" />
          </Field>
          <Field label="Pílula vermelha até" hint="Margem igual ou abaixo disso aparece em vermelho.">
            <NumInput value={Number(rascunho.margem_pedido_vermelho_max) * 100} onChange={(v) => atualizar('margem_pedido_vermelho_max', (Number(v) || 0) / 100)} suffix="%" />
          </Field>
          <Field label="Pílula amarela até" hint="Acima do vermelho e até aqui aparece em amarelo; acima disso, verde.">
            <NumInput value={Number(rascunho.margem_pedido_amarelo_max) * 100} onChange={(v) => atualizar('margem_pedido_amarelo_max', (Number(v) || 0) / 100)} suffix="%" />
          </Field>
        </div>
        <div className="card">
          <div className="card-head">Alertas do calendário</div>
          <Field label="Primeiro aviso" hint="A partir de quantos dias antes do prazo o evento aparece no sino de notificações.">
            <NumInput value={rascunho.calendario_alerta_dias_1} onChange={(v) => atualizar('calendario_alerta_dias_1', Math.max(0, Math.round(Number(v) || 0)))} suffix="dias" />
          </Field>
          <Field label="Vira urgente" hint="A partir de quantos dias antes do prazo o evento vira urgente.">
            <NumInput value={rascunho.calendario_alerta_dias_2} onChange={(v) => atualizar('calendario_alerta_dias_2', Math.max(0, Math.round(Number(v) || 0)))} suffix="dia" />
          </Field>
        </div>
      </div>

      <BarraAlteracoes
        quantidade={camposAlterados.length}
        salvando={salvando}
        mensagemSalvo={mensagemSalvo}
        detalhe={camposAlterados.slice(0, 4).map((c) => LABELS_CAMPOS[c] || PCT_FIELDS_ALERTA.find((f) => f[0] === c)?.[1] || c).join(' · ')}
        onSalvar={salvar}
        onDescartar={descartar}
      />
    </div>
  );
}
