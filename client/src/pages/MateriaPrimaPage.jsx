import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scissors, RefreshCw, AlertTriangle, ChevronDown, ChevronRight, Info,
  ShoppingCart, CalendarClock, CheckCircle2, HelpCircle, Save, Wand2, Layers,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoTresMeses } from '../lib/periodos';
import { formatQtd } from '../lib/format';

// Produção › Matéria-Prima.
//
// Pedido da dona (11/09/2026): "da mesma maneira que a planilha está
// organizada, separado por tabela por referência e de uma maneira extremamente
// intuitiva e prática de ser feita".
//
// Então é isto: um BLOCO por referência, com as mesmas quatro matrizes
// cor × tamanho da aba "Produtos que Vamos Permanecer" lado a lado —
//
//   ESTOQUE MÍNIMO │ ESTOQUE PA │ EM PRODUÇÃO │ SALDO A PRODUZIR
//
// e, à direita, o quadro do TECIDO, que é por cor e não por tamanho, porque
// rolo de malha não tem tamanho.
//
// ---------------------------------------------------------------------------
// As duas coisas que a tela faz e a planilha não fazia
// ---------------------------------------------------------------------------
// 1. O CONSOLIDADO POR TECIDO, no topo. A planilha compara a necessidade de
//    CADA bloco com o estoque INTEIRO do rolo — e o ROVACEL está em cinco
//    blocos. O consolidado soma a necessidade e conta o saldo uma vez só. Cada
//    bloco continua mostrando a parte dele, agora com o selo "dividido com".
//
// 2. O DE-PARA DE COR é escolhido, não adivinhado. A planilha casava a cor por
//    `SEARCH` dentro da descrição do insumo; aqui o sistema sugere (e a
//    sugestão exata já vem marcada) mas quem confirma é gente. O botão
//    "confirmar sugestões" resolve o bloco inteiro de uma vez — é o que torna
//    o preenchimento prático sem torná-lo cego.

const SEM_COR = '—';
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function q(v, casas = 0) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

function Swatch({ hex, cor }) {
  if (!hex) return <span className="pe-swatch pe-swatch-vazio" title={`${cor} — sem cor de tela cadastrada`} />;
  const nome = String(cor || '').toUpperCase();
  const estilo = nome.includes('MESCLA')
    ? { backgroundImage: `repeating-linear-gradient(45deg, ${hex} 0 2px, ${hex}99 2px 4px)` }
    : { background: hex };
  return <span className="pe-swatch" style={estilo} title={`${cor} ${hex}`} />;
}

function Celula({ valor, classe = '' }) {
  if (!valor) return <td className="pe-n pe-zero">–</td>;
  return <td className={`pe-n ${classe}`}>{formatQtd(valor)}</td>;
}

const SITUACOES = {
  comprar: { rotulo: 'Comprar', Icone: ShoppingCart },
  atrasado: { rotulo: 'Atrasado', Icone: CalendarClock },
  atencao: { rotulo: 'Atenção', Icone: AlertTriangle },
  ok: { rotulo: 'OK', Icone: CheckCircle2 },
  sem_calculo: { rotulo: 'Sem cálculo', Icone: HelpCircle },
};

function Situacao({ chave }) {
  const s = SITUACOES[chave] || SITUACOES.sem_calculo;
  const { Icone } = s;
  return <span className={`mp-sit mp-sit-${chave}`}><Icone size={14} />{s.rotulo}</span>;
}

// ---------------------------------------------------------------------------
// Uma matriz cor × tamanho — o tijolo que se repete quatro vezes
// ---------------------------------------------------------------------------
function Matriz({ titulo, destaque, tamanhos, cores, valor, classe = '' }) {
  const total = cores.reduce((s, c) => s + tamanhos.reduce((t, tam) => t + num(valor(c, tam)), 0), 0);
  return (
    <div className={`mp-bloco${destaque ? ' mp-destaque' : ''}`}>
      <h4>{titulo}</h4>
      <table className={`pe-grade ${classe}`}>
        <thead>
          <tr>
            <th className="pe-hcor">Cor</th>
            {tamanhos.map((t) => <th key={t}>{t}</th>)}
            <th className="pe-htot">Total</th>
          </tr>
        </thead>
        <tbody>
          {cores.map((c) => {
            const soma = tamanhos.reduce((t, tam) => t + num(valor(c, tam)), 0);
            return (
              <tr key={c.cor}>
                <td className="pe-cor"><Swatch hex={c.hex} cor={c.cor} />{c.cor || SEM_COR}</td>
                {tamanhos.map((t) => <Celula key={t} valor={num(valor(c, t))} />)}
                <td className="pe-tot">{soma ? formatQtd(soma) : '–'}</td>
              </tr>
            );
          })}
          <tr className="pe-totrow">
            <td className="pe-cor">Total</td>
            {tamanhos.map((t) => (
              <td key={t} className="pe-n">
                {formatQtd(cores.reduce((s, c) => s + num(valor(c, t)), 0))}
              </td>
            ))}
            <td className="pe-tot">{formatQtd(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// O quadro do tecido — colunas AD:AK da planilha
// ---------------------------------------------------------------------------
function QuadroTecido({ referencia, unidade, onSalvarCores, onSalvarSaldo, tecidos }) {
  const [rascunho, setRascunho] = useState({});
  const [saldoRascunho, setSaldoRascunho] = useState({});
  const [salvando, setSalvando] = useState(false);

  const sujo = Object.keys(rascunho).length > 0 || Object.keys(saldoRascunho).length > 0;

  const coresDoInsumo = useCallback((insumoId) => {
    const t = tecidos.find((x) => x.id === insumoId);
    return t ? t.cores.map((c) => c.cor) : [];
  }, [tecidos]);

  const confirmarSugestoes = () => {
    const novo = { ...rascunho };
    let n = 0;
    for (const c of referencia.cores) {
      const jaTem = c.corInsumoOrigem === 'confirmada';
      const sug = c.sugestaoCor;
      const alvo = c.corInsumo || (sug && sug.candidatos.length === 1 ? sug.candidatos[0] : null);
      if (!jaTem && alvo) { novo[c.cor] = alvo; n += 1; }
    }
    if (n > 0) setRascunho(novo);
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      if (Object.keys(rascunho).length > 0) {
        await onSalvarCores(referencia.cores
          .filter((c) => rascunho[c.cor] !== undefined)
          .map((c) => ({
            corProduto: c.cor,
            // O que já estava gravado para esta cor vai de volta inteiro: a
            // gravação substitui a linha, então mandar `null` no consumo
            // apagaria um ajuste que alguém fez para aquela cor só.
            ...(c.override || {}),
            insumoId: c.override?.insumoId ?? c.insumoId,
            corInsumo: rascunho[c.cor] || null,
          })));
      }
      for (const [chave, valor] of Object.entries(saldoRascunho)) {
        const [insumoId, cor] = chave.split('|');
        await onSalvarSaldo(Number(insumoId), [{ cor, quantidade: valor === '' ? null : Number(valor) }]);
      }
      setRascunho({});
      setSaldoRascunho({});
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="mp-bloco mp-destaque" style={{ flex: '1 1 520px', minWidth: 420 }}>
      <h4>
        Tecido — estoque mínimo &amp; necessidade de compra
        {sujo && (
          <button type="button" className="btn btn-primary btn-mini" style={{ marginLeft: 12 }}
            onClick={salvar} disabled={salvando}>
            <Save size={13} /> {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        )}
        <button type="button" className="btn-sec btn-mini" style={{ marginLeft: 8 }}
          onClick={confirmarSugestoes} title="Preenche o de-para com a cor que o sistema sugeriu, para você conferir antes de salvar">
          <Wand2 size={13} /> Confirmar sugestões
        </button>
      </h4>
      <table className="pe-grade mp-tecido">
        <thead>
          <tr>
            <th className="pe-hcor">Cor</th>
            <th style={{ textAlign: 'left' }}>Cor do tecido</th>
            <th>Precisa{unidade ? ` (${unidade})` : ''}</th>
            <th>Tem</th>
            <th>A caminho</th>
            <th>Saldo</th>
            <th className="mp-hped">Pedido</th>
          </tr>
        </thead>
        <tbody>
          {referencia.cores.map((c) => {
            const escolhido = rascunho[c.cor] !== undefined ? rascunho[c.cor] : (c.corInsumo || '');
            const saldoChave = `${c.insumoId}|${escolhido}`;
            const saldoEditado = saldoRascunho[saldoChave];
            const saldo = saldoEditado !== undefined
              ? (saldoEditado === '' ? null : Number(saldoEditado))
              : c.saldoTecido;
            const disponivel = saldo == null ? null : saldo + num(c.emCompras);
            const falta = (disponivel == null || c.necessidade == null)
              ? null : Math.max(0, c.necessidade - disponivel);
            const opcoes = coresDoInsumo(c.insumoId);

            return (
              <tr key={c.cor}>
                <td className="pe-cor">
                  <Swatch hex={c.hex} cor={c.cor} />{c.cor || SEM_COR}
                  {c.compartilhadoCom && c.compartilhadoCom.length > 0 && (
                    <span className="mp-selo mp-selo-dividido"
                      title={`Este tecido nesta cor também é usado por: ${c.compartilhadoCom.join(', ')}. O pedido de compra é feito no consolidado do topo, somando todas.`}>
                      +{c.compartilhadoCom.length}
                    </span>
                  )}
                </td>
                <td>
                  <select className="mp-depara" value={escolhido}
                    onChange={(e) => setRascunho({ ...rascunho, [c.cor]: e.target.value })}>
                    <option value="">— escolher —</option>
                    {opcoes.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  {c.corInsumoOrigem === 'confirmada' && rascunho[c.cor] === undefined && (
                    <span className="mp-selo mp-selo-confirmada">confirmada</span>
                  )}
                  {c.corInsumoOrigem === 'sugerida_exata' && rascunho[c.cor] === undefined && (
                    <span className="mp-selo mp-selo-sugerida" title="O sistema encontrou uma cor de mesmo nome. Confirme para gravar.">sugerida</span>
                  )}
                  {!escolhido && c.sugestaoCor && c.sugestaoCor.candidatos.length > 0 && (
                    <span className="mp-selo mp-selo-pendente"
                      title={`Parecida com: ${c.sugestaoCor.candidatos.join(', ')}`}>
                      {c.sugestaoCor.criterio === 'empate' ? 'empate' : 'parecida'}
                    </span>
                  )}
                  {!escolhido && c.sugestaoCor && c.sugestaoCor.candidatos.length === 0 && (
                    <span className="mp-selo mp-selo-pendente">sem candidato</span>
                  )}
                </td>
                <td className="pe-n">
                  {c.necessidade == null
                    ? <span title={c.motivoSemNecessidade || 'sem consumo cadastrado'}>—</span>
                    : q(c.necessidade, 2)}
                </td>
                <td className="pe-n">
                  {escolhido ? (
                    <input className="mp-saldo" type="number" step="0.01"
                      placeholder="não sei"
                      value={saldoEditado !== undefined ? saldoEditado : (c.saldoTecido ?? '')}
                      onChange={(e) => setSaldoRascunho({ ...saldoRascunho, [saldoChave]: e.target.value })} />
                  ) : <span className="pe-zero">–</span>}
                </td>
                <td className="pe-n">{c.emCompras ? q(c.emCompras, 2) : <span className="pe-zero">–</span>}</td>
                <td className="pe-n">
                  {disponivel == null || c.necessidade == null
                    ? <span className="pe-zero">–</span>
                    : <span style={{ color: disponivel - c.necessidade < 0 ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>
                      {q(disponivel - c.necessidade, 2)}
                    </span>}
                </td>
                <td className={`mp-ped ${falta > 0 ? 'mp-ped-sim' : 'mp-ped-nao'}`}>
                  {falta == null ? '—' : (falta > 0 ? q(falta, 2) : '0')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mp-aviso" style={{ marginTop: 10 }}>
        <Info size={14} />
        <span>
          O <b>pedido</b> desta tabela é a falta <i>desta referência</i>. O pedido que se
          faz ao fornecedor sai do <b>consolidado por tecido</b>, no topo, que soma
          todas as referências que usam o mesmo rolo e conta o saldo uma vez só.
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// O cabeçalho editável do bloco — o que a planilha tinha em AF4/AI4/AJ/X4
// ---------------------------------------------------------------------------
function Parametros({ referencia, tecidos, onSalvar }) {
  const cfg = referencia.config || {};
  const [form, setForm] = useState(null);
  const atual = form || {
    insumoId: cfg.insumoId || '',
    consumoPorPeca: cfg.consumoPorPeca ?? '',
    perdaPct: cfg.perdaFracao == null ? '' : (cfg.perdaFracao * 100),
    prazoEntregaDias: cfg.prazoEntregaDias ?? '',
    barca: cfg.barca ?? '',
    sazonalidade: cfg.sazonalidade ?? '',
    unidadeConfirmada: cfg.unidadeConfirmada === true,
  };
  const muda = (campo) => (e) => setForm({ ...atual, [campo]: e.target.value });
  const sujo = form != null;
  const tecido = tecidos.find((t) => t.id === Number(atual.insumoId));

  return (
    <div className="mp-params">
      <div className="mp-param mp-param-largo">
        <label>Tecido</label>
        <select value={atual.insumoId} onChange={muda('insumoId')} className={sujo ? 'mp-sujo' : ''}>
          <option value="">— escolher —</option>
          {tecidos.map((t) => (
            <option key={t.id} value={t.id}>{t.nome} ({t.unidade}){t.fornecedor_nome ? ` · ${t.fornecedor_nome}` : ''}</option>
          ))}
        </select>
      </div>
      <div className="mp-param">
        <label>Consumo por peça</label>
        <span>
          <input type="number" step="0.001" value={atual.consumoPorPeca} onChange={muda('consumoPorPeca')}
            className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">{tecido ? tecido.unidade : (cfg.unidadeConsumo || '')}/peça</span>
        </span>
      </div>
      <div className="mp-param">
        <label title="Perda de corte. Digitada em %, guardada em fração.">Perda de corte</label>
        <span>
          <input type="number" step="0.1" min="0" max="99" placeholder="não cadastrada"
            value={atual.perdaPct} onChange={muda('perdaPct')} className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">%</span>
        </span>
      </div>
      <div className="mp-param">
        <label title="Prazo do fornecedor de tecido. É ele que define o 'pedir até'.">Prazo de entrega</label>
        <span>
          <input type="number" step="1" min="1" value={atual.prazoEntregaDias} onChange={muda('prazoEntregaDias')}
            className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">dias</span>
        </span>
      </div>
      <div className="mp-param">
        <label title="Lote mínimo do fornecedor. O pedido sobe para o múltiplo seguinte.">Barca (lote mínimo)</label>
        <input type="number" step="0.1" min="0" value={atual.barca} onChange={muda('barca')}
          className={sujo ? 'mp-sujo' : ''} />
      </div>
      <div className="mp-param">
        <label title="Multiplicador de temporada. 1 = sem efeito.">Sazonalidade</label>
        <input type="number" step="0.05" min="0.1" max="5" value={atual.sazonalidade} onChange={muda('sazonalidade')}
          className={sujo ? 'mp-sujo' : ''} />
      </div>
      {tecido && tecido.unidade_confianca && (
        <div className="mp-param">
          <label>Unidade</label>
          <label style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, fontWeight: 400, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={!!atual.unidadeConfirmada}
              onChange={(e) => setForm({ ...atual, unidadeConfirmada: e.target.checked })} />
            confirmo que é <b>{tecido.unidade}</b>
          </label>
        </div>
      )}
      {sujo && (
        <div className="mp-param">
          <label>&nbsp;</label>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-primary btn-mini"
              onClick={async () => { await onSalvar(atual); setForm(null); }}>
              <Save size={13} /> Salvar
            </button>
            <button type="button" className="btn-sec btn-mini" onClick={() => setForm(null)}>
              Cancelar
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// O bloco de uma referência
// ---------------------------------------------------------------------------
function BlocoReferencia({ referencia: r, tecidos, aberto, onAlternar, onSalvarConfig, onSalvarCores, onSalvarSaldo }) {
  const porCorTamanho = useMemo(() => {
    const mapa = new Map();
    for (const c of r.cores) {
      const linha = new Map();
      for (const cel of c.celulas) linha.set(cel.tamanho, cel);
      mapa.set(c.cor, linha);
    }
    return mapa;
  }, [r.cores]);

  const pega = (c, tamanho, campo) => {
    const cel = porCorTamanho.get(c.cor)?.get(tamanho);
    return cel ? num(cel[campo]) : 0;
  };
  const falta = (c, tamanho) => {
    const linha = c.porTamanho.find((x) => x.tamanho === tamanho);
    return linha ? num(linha.falta) : 0;
  };

  const unidade = r.config?.unidadeConsumo || null;

  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <header
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '14px 16px' }}
        onClick={onAlternar}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onAlternar(); }}
      >
        {aberto ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        <strong style={{ fontSize: 15 }}>{r.referencia}</strong>
        <span style={{ color: 'var(--muted)' }}>{r.descricao}</span>
        {r.categoria && <span className="mp-selo mp-selo-dividido">{r.categoria}</span>}
        {r.nivel && <span className="mp-selo mp-selo-dividido">{r.nivel}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 18, fontSize: 13 }}>
          <span><b>{formatQtd(r.totais.minimoPecas)}</b> <span style={{ color: 'var(--muted)' }}>mínimo</span></span>
          <span><b>{formatQtd(r.totais.aProduzir)}</b> <span style={{ color: 'var(--muted)' }}>a produzir</span></span>
          <span>
            <b>{r.totais.tecido ? q(r.totais.tecido, 1) : '—'}</b>{' '}
            <span style={{ color: 'var(--muted)' }}>{unidade || 'tecido'}</span>
          </span>
        </span>
      </header>

      {aberto && (
        <div style={{ padding: '0 16px 16px' }}>
          <Parametros referencia={r} tecidos={tecidos} onSalvar={(f) => onSalvarConfig(r.produtoId, f)} />

          {r.pecasEmKitSemGrade > 0 && (
            <p className="mp-aviso">
              <AlertTriangle size={14} />
              <span>
                <b>{formatQtd(r.pecasEmKitSemGrade)} peça(s)</b> desta referência saíram dentro de
                KIT na janela. Kit não guarda cor nem tamanho, então elas ficam de fora da grade
                abaixo — e o mínimo por cor, junto com a necessidade de tecido, está subestimado
                nessa proporção. Não se rateia kit pela grade: seria um número inventado com cara
                de medido.
              </span>
            </p>
          )}

          <div className="mp-blocos pe-rolagem">
            <Matriz titulo="Estoque mínimo" destaque tamanhos={r.tamanhos} cores={r.cores}
              valor={(c, t) => pega(c, t, 'minimo')} />
            <Matriz titulo="Estoque PA" tamanhos={r.tamanhos} cores={r.cores}
              valor={(c, t) => pega(c, t, 'saldo')} />
            <Matriz titulo="Em produção" tamanhos={r.tamanhos} cores={r.cores} classe="pe-producao"
              valor={(c, t) => pega(c, t, 'emProducao')} />
            <Matriz titulo="Saldo a produzir" destaque tamanhos={r.tamanhos} cores={r.cores}
              valor={(c, t) => falta(c, t)} />
          </div>

          <div className="mp-blocos" style={{ marginTop: 18 }}>
            <QuadroTecido referencia={r} unidade={unidade} tecidos={tecidos}
              onSalvarCores={(cores) => onSalvarCores(r.produtoId, cores)}
              onSalvarSaldo={onSalvarSaldo} />
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// O consolidado — a tela de compra de verdade
// ---------------------------------------------------------------------------
function Consolidado({ linhas }) {
  const [abertaChave, setAbertaChave] = useState(null);
  if (linhas.length === 0) return null;

  return (
    <section className="card" style={{ marginBottom: 18 }}>
      <header style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Layers size={18} />
        <strong style={{ fontSize: 15 }}>Consolidado por tecido</strong>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>
          a decisão de compra — o mesmo rolo somado entre todas as referências
        </span>
      </header>
      <div className="pe-rolagem" style={{ padding: '0 16px 16px' }}>
        <table className="pe-grade mp-tecido">
          <thead>
            <tr>
              <th className="pe-hcor">Tecido</th>
              <th style={{ textAlign: 'left' }}>Cor</th>
              <th>Referências</th>
              <th>Precisa</th>
              <th>Tem</th>
              <th>A caminho</th>
              <th className="mp-hped">Comprar</th>
              <th>Pedir até</th>
              <th style={{ textAlign: 'left' }}>Situação</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((g) => {
              const chave = `${g.insumoId}|${g.corInsumo ?? ''}`;
              const aberta = abertaChave === chave;
              return [
                <tr key={chave} onClick={() => setAbertaChave(aberta ? null : chave)} style={{ cursor: 'pointer' }}>
                  <td className="pe-cor">
                    {aberta ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {g.insumo}
                    <span className="mp-unid" style={{ color: 'var(--muted)', marginLeft: 6 }}>{g.unidadeInsumo}</span>
                  </td>
                  <td>
                    {g.corInsumo || <span className="mp-selo mp-selo-pendente">cor não mapeada</span>}
                    {g.compartilhado && (
                      <span className="mp-selo mp-selo-dividido">{g.contribuintes.length} refs</span>
                    )}
                  </td>
                  <td className="pe-n">{g.contribuintes.length}</td>
                  <td className="pe-n">{q(g.necessidade, 1)}</td>
                  <td className="pe-n">
                    {g.saldo == null
                      ? <span className="mp-selo mp-selo-pendente" title="Saldo por cor deste tecido não informado. Não é zero — é 'não sei'.">não informado</span>
                      : q(g.saldo, 1)}
                  </td>
                  <td className="pe-n">{g.emCompras ? q(g.emCompras, 1) : <span className="pe-zero">–</span>}</td>
                  <td className={`mp-ped ${num(g.pedido?.valor) > 0 ? 'mp-ped-sim' : 'mp-ped-nao'}`}
                    title={g.pedido?.motivo || (g.pedido?.arredondado ? `Arredondado para múltiplo de ${g.pedido.barcaUsada}` : '')}>
                    {g.pedido?.valor == null ? '—' : q(g.pedido.valor, 1)}
                  </td>
                  <td className="pe-n">
                    {g.folgaDias == null
                      ? <span className="pe-zero" title={g.motivo || ''}>–</span>
                      : (g.folgaDias < 0
                        ? <b style={{ color: 'var(--danger)' }}>atrasado {Math.abs(g.folgaDias)} d</b>
                        : `em ${g.folgaDias} d`)}
                  </td>
                  <td><Situacao chave={g.situacao} /></td>
                </tr>,
                aberta ? (
                  <tr key={`${chave}-det`}>
                    <td colSpan={9} className="mp-contrib">
                      Formado por:{' '}
                      {g.contribuintes.map((c, i) => (
                        <span key={`${c.produtoId}-${c.corProduto}`}>
                          {i > 0 && ' · '}
                          <b>{c.referencia}</b> {c.corProduto} — {formatQtd(c.pecas)} pç ×{' '}
                          {q(c.consumoPorPeca, 3)} = {q(c.necessidade, 1)} {g.unidadeInsumo}
                        </span>
                      ))}
                      {g.unidadeNaoConfirmada && (
                        <div style={{ marginTop: 6, color: 'var(--warning)' }}>
                          A unidade deste tecido ainda é dedução do sistema. Metro e quilo mudam o
                          resultado por um fator de três — confirme a unidade antes de comprar.
                        </div>
                      )}
                      {g.perdaNaoCadastrada && (
                        <div style={{ marginTop: 6 }}>
                          Sem perda de corte cadastrada: a necessidade acima está <b>subestimada</b>.
                        </div>
                      )}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
export default function MateriaPrimaPage() {
  const [periodo, setPeriodo] = useState(periodoTresMeses);
  const [base, setBase] = useState('plano');
  const [todas, setTodas] = useState(false);
  const [dados, setDados] = useState(null);
  const [tecidos, setTecidos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [abertos, setAbertos] = useState(() => new Set());

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim, base });
      if (todas) qs.set('todas', '1');
      const [d, t] = await Promise.all([
        api.get(`/producao-materia-prima?${qs}`),
        api.get('/producao-materia-prima/tecidos'),
      ]);
      setDados(d);
      setTecidos(t.tecidos || []);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [periodo, base, todas]);

  useEffect(() => { carregar(); }, [carregar]);

  const salvarConfig = async (produtoId, form) => {
    await api.put(`/producao-materia-prima/produtos/${produtoId}/config`, {
      insumoId: form.insumoId === '' ? null : Number(form.insumoId),
      consumoPorPeca: form.consumoPorPeca === '' ? null : Number(form.consumoPorPeca),
      perdaPct: form.perdaPct === '' ? null : Number(form.perdaPct),
      prazoEntregaDias: form.prazoEntregaDias === '' ? null : Number(form.prazoEntregaDias),
      barca: form.barca === '' ? null : Number(form.barca),
      sazonalidade: form.sazonalidade === '' ? null : Number(form.sazonalidade),
      unidadeConfirmada: !!form.unidadeConfirmada,
    });
    await carregar();
  };

  const salvarCores = async (produtoId, cores) => {
    await api.put(`/producao-materia-prima/produtos/${produtoId}/cores`, { cores });
    await carregar();
  };

  const salvarSaldo = async (insumoId, cores) => {
    await api.put(`/producao-materia-prima/tecidos/${insumoId}/saldo`, { cores });
    await carregar();
  };

  const alternar = (id) => {
    const novo = new Set(abertos);
    if (novo.has(id)) novo.delete(id); else novo.add(id);
    setAbertos(novo);
  };

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Scissors size={22} /> Matéria-Prima</h1>
          <p className="page-sub">
            Estoque mínimo de tecido por referência e por cor, e o que precisa ser comprado —
            no mesmo formato da planilha da casa.
          </p>
        </div>
        <div className="pagina-acoes">
          <PeriodoFiltro valor={periodo} onChange={setPeriodo} />
          <select value={base} onChange={(e) => setBase(e.target.value)}
            title="Como medir a necessidade de tecido">
            {dados && Object.entries(dados.bases).map(([k, v]) => (
              <option key={k} value={k}>{v.rotulo}</option>
            ))}
          </select>
          <button type="button" className="btn-sec" onClick={() => setTodas(!todas)}>
            {todas ? 'Só as configuradas' : 'Ver catálogo inteiro'}
          </button>
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {dados && dados.bases[base] && (
        <p className="mp-aviso">
          <Info size={14} />
          <span>
            <b>{dados.bases[base].rotulo}:</b> {dados.bases[base].explicacao}{' '}
            <code style={{ fontSize: 11.5 }}>{dados.bases[base].formula}</code>
          </span>
        </p>
      )}

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && !dados && (
        <div style={{ display: 'grid', gap: 10 }}>
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={58} radius={8} />)}
        </div>
      )}

      {dados && (
        <>
          <section className="pe-kpis">
            <div className="pe-kpi">
              <span className="pe-kl"><ShoppingCart size={13} /> Tecidos a comprar</span>
              <strong>{dados.totais.aComprar}</strong>
              <small>combinações de tecido e cor abaixo do necessário</small>
            </div>
            <div className="pe-kpi">
              <span className="pe-kl"><CalendarClock size={13} /> Já atrasados</span>
              <strong>{dados.totais.atrasados}</strong>
              <small>o estoque não cobre o prazo do fornecedor</small>
            </div>
            <div className="pe-kpi">
              <span className="pe-kl"><HelpCircle size={13} /> Sem cálculo possível</span>
              <strong>{dados.totais.semCalculo}</strong>
              <small>falta de-para de cor, saldo ou unidade confirmada</small>
            </div>
            <div className="pe-kpi">
              <span className="pe-kl"><Scissors size={13} /> Referências</span>
              <strong>{dados.totais.referencias}</strong>
              <small>{dados.totais.tecidos} tecido(s) envolvido(s)</small>
            </div>
          </section>

          {dados.avisos.map((a) => (
            <p className="mp-aviso" key={a}><Info size={14} /><span>{a}</span></p>
          ))}

          <Consolidado linhas={dados.consolidado} />

          {dados.referencias.length === 0 ? (
            <EstadoVazio
              titulo="Nenhuma referência com matéria-prima configurada"
              descricao="Use 'Ver catálogo inteiro' para escolher a referência e cadastrar o tecido, o consumo por peça e o prazo do fornecedor."
            />
          ) : dados.referencias.map((r) => (
            <BlocoReferencia
              key={r.produtoId}
              referencia={r}
              tecidos={tecidos}
              aberto={abertos.has(r.produtoId)}
              onAlternar={() => alternar(r.produtoId)}
              onSalvarConfig={salvarConfig}
              onSalvarCores={salvarCores}
              onSalvarSaldo={salvarSaldo}
            />
          ))}
        </>
      )}
    </div>
  );
}
