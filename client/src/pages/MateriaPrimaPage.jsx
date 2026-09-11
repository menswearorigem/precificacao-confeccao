import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scissors, RefreshCw, ChevronDown, ChevronRight, Info, ShoppingCart,
  CalendarClock, CheckCircle2, HelpCircle, Save, Wand2, Layers, Factory,
  Boxes, TriangleAlert, ArrowRight, X,
} from 'lucide-react';
import { api } from '../api/client';
import { EstadoVazio, Skeleton } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoTresMeses } from '../lib/periodos';
import { formatQtd } from '../lib/format';

// Produção › Matéria-Prima.
//
// ---------------------------------------------------------------------------
// A primeira versão foi reprovada, e com razão
// ---------------------------------------------------------------------------
// "não dá para entender nada, está extremamente confuso". Rodando a tela com
// dados de verdade, os três motivos aparecem na primeira olhada:
//
//   1. CINCO PARÁGRAFOS de aviso antes de qualquer número. Umas 150 palavras
//      de explicação ocupando a dobra inteira. Quem abre para trabalhar não
//      lê nada disso — e quem lê desiste antes de chegar na tabela.
//
//   2. SETE CARTÕES GIGANTES, cada um com uma linha de texto e um oceano de
//      branco. Sete referências não cabiam numa tela. Lista tem de ser lista.
//
//   3. QUATRO MATRIZES IGUAIS lado a lado — mesma cor, mesma fonte, título de
//      9px — que viram uma parede de números indistinguíveis. E a quarta
//      ficava cortada.
//
// ---------------------------------------------------------------------------
// O que esta versão faz diferente
// ---------------------------------------------------------------------------
// **Três quadros com nome de gente, não quatro com nome de sistema:**
//
//        PRECISO          TENHO              FALTA
//        (mínimo)         (galpão + facção)  (o que produzir)
//
// "Estoque PA" e "Em produção" estavam separados sem motivo. A pergunta é
// "tenho quanto", e "117 no galpão + 38 na facção" é UMA resposta — é o
// formato que a Projeção de Estoque já usa e que a casa já lê. Cada quadro tem
// cor própria: couro para o alvo, neutro para o que existe, vermelho para o
// buraco. De relance dá para ver qual é qual sem ler o título.
//
// **Os avisos saíram da frente.** O que exige AÇÃO virou um painel com
// contador e botão; o resto virou um "como esta tela calcula" que abre. Nada
// se perdeu de rigor — mudou de lugar, que é o mesmo que a planilha faz ao
// pintar as colunas do meio de caramelo e sugerir ocultá-las.
//
// **A lista virou lista:** 44px por linha, com uma faixa de quadradinhos — um
// por cor — que mostra onde falta antes de abrir qualquer coisa.

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

const SITUACOES = {
  comprar: { rotulo: 'Comprar', Icone: ShoppingCart },
  atrasado: { rotulo: 'Atrasado', Icone: CalendarClock },
  atencao: { rotulo: 'No limite', Icone: TriangleAlert },
  ok: { rotulo: 'OK', Icone: CheckCircle2 },
  sem_calculo: { rotulo: 'Falta cadastro', Icone: HelpCircle },
};

function Situacao({ chave }) {
  const s = SITUACOES[chave] || SITUACOES.sem_calculo;
  const { Icone } = s;
  return <span className={`mp-sit mp-sit-${chave}`}><Icone size={13} />{s.rotulo}</span>;
}

// ---------------------------------------------------------------------------
// Um dos três quadros
// ---------------------------------------------------------------------------
// `celula` devolve o conteúdo já formatado — é o que deixa o quadro "TENHO"
// mostrar dois números na mesma célula sem precisar de um componente próprio.
function Quadro({ variante, titulo, Icone, rodape, tamanhos, cores, celula, totalCor, totalTamanho, total }) {
  return (
    <div className={`mp-quadro mp-q-${variante}`}>
      <h4><Icone size={13} /> {titulo}{rodape ? <small>{rodape}</small> : null}</h4>
      <table className="mp-tab">
        <thead>
          <tr>
            <th>Cor</th>
            {tamanhos.map((t) => <th key={t}>{t}</th>)}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {cores.map((c) => (
            <tr key={c.cor}>
              <td><Swatch hex={c.hex} cor={c.cor} />{c.cor || SEM_COR}</td>
              {tamanhos.map((t) => <td key={t}>{celula(c, t)}</td>)}
              <td>{totalCor(c)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            {tamanhos.map((t) => <td key={t}>{totalTamanho(t)}</td>)}
            <td>{total()}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// O cartão do tecido — a resposta do bloco
// ---------------------------------------------------------------------------
function CartaoTecido({ referencia, tecidos, onSalvarCores, onSalvarSaldo }) {
  const [rascunho, setRascunho] = useState({});
  const [saldos, setSaldos] = useState({});
  const [salvando, setSalvando] = useState(false);
  const unidade = referencia.config?.unidadeConsumo || '';

  const sujo = Object.keys(rascunho).length > 0 || Object.keys(saldos).length > 0;
  const coresDoInsumo = useCallback((id) => (tecidos.find((x) => x.id === id)?.cores || []).map((c) => c.cor), [tecidos]);

  const pendentes = referencia.cores.filter(
    (c) => !c.corInsumo && c.sugestaoCor && c.sugestaoCor.candidatos.length === 1
  );

  const confirmarSugestoes = () => {
    const novo = { ...rascunho };
    for (const c of referencia.cores) {
      if (c.corInsumoOrigem === 'confirmada') continue;
      const alvo = c.corInsumo || (c.sugestaoCor?.candidatos.length === 1 ? c.sugestaoCor.candidatos[0] : null);
      if (alvo) novo[c.cor] = alvo;
    }
    setRascunho(novo);
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      if (Object.keys(rascunho).length > 0) {
        await onSalvarCores(referencia.cores
          .filter((c) => rascunho[c.cor] !== undefined)
          .map((c) => ({
            corProduto: c.cor,
            ...(c.override || {}),
            insumoId: c.override?.insumoId ?? c.insumoId,
            corInsumo: rascunho[c.cor] || null,
          })));
      }
      for (const [chave, valor] of Object.entries(saldos)) {
        const [insumoId, cor] = chave.split('|');
        await onSalvarSaldo(Number(insumoId), [{ cor, quantidade: valor === '' ? null : Number(valor) }]);
      }
      setRascunho({}); setSaldos({});
    } finally { setSalvando(false); }
  };

  return (
    <div className="mp-tecido-cartao">
      <div className="mp-tecido-topo">
        <Scissors size={14} />
        <h4>Tecido · o que comprar</h4>
        <div className="mp-acoes">
          {(pendentes.length > 0 || Object.keys(rascunho).length > 0) && (
            <button type="button" className="btn-sec btn-mini" onClick={confirmarSugestoes}
              title="Preenche a cor do tecido com a que o sistema encontrou. Você confere e salva.">
              <Wand2 size={13} /> Preencher {pendentes.length === 1 ? '1 sugestão'
                : (pendentes.length > 1 ? `${pendentes.length} sugestões` : 'sugestões')}
            </button>
          )}
          {sujo && (
            <button type="button" className="btn btn-primary btn-mini" onClick={salvar} disabled={salvando}>
              <Save size={13} /> {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          )}
        </div>
      </div>
      <table className="mp-tecido-tab">
        <thead>
          <tr>
            <th>Cor da peça</th>
            <th>Cor do tecido</th>
            <th>Preciso{unidade ? ` (${unidade})` : ''}</th>
            <th>Tenho</th>
            <th>Falta</th>
          </tr>
        </thead>
        <tbody>
          {referencia.cores.map((c) => {
            const escolhido = rascunho[c.cor] !== undefined ? rascunho[c.cor] : (c.corInsumo || '');
            const chaveSaldo = `${c.insumoId}|${escolhido}`;
            const editado = saldos[chaveSaldo];
            const saldo = editado !== undefined ? (editado === '' ? null : Number(editado)) : c.saldoTecido;
            const disp = saldo == null ? null : saldo + num(c.emCompras);
            const falta = (disp == null || c.necessidade == null) ? null : Math.max(0, c.necessidade - disp);

            return (
              <tr key={c.cor}>
                <td>
                  <Swatch hex={c.hex} cor={c.cor} />{c.cor || SEM_COR}
                  {c.compartilhadoCom?.length > 0 && (
                    <span className="mp-selo mp-selo-dividido" style={{ marginLeft: 6 }}
                      title={`Este tecido nesta cor também é usado por ${c.compartilhadoCom.join(', ')}. A compra é decidida no quadro do topo, somando todas.`}>
                      +{c.compartilhadoCom.length} ref{c.compartilhadoCom.length > 1 ? 's' : ''}
                    </span>
                  )}
                </td>
                <td>
                  <select value={escolhido}
                    onChange={(e) => setRascunho({ ...rascunho, [c.cor]: e.target.value })}
                    className={rascunho[c.cor] !== undefined ? 'mp-sujo' : ''}>
                    <option value="">— escolher —</option>
                    {coresDoInsumo(c.insumoId).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  {rascunho[c.cor] === undefined && c.corInsumoOrigem === 'confirmada' && (
                    <span className="mp-selo mp-selo-confirmada" style={{ marginLeft: 6 }}>ok</span>
                  )}
                  {rascunho[c.cor] === undefined && c.corInsumoOrigem === 'sugerida_exata' && (
                    <span className="mp-selo mp-selo-sugerida" style={{ marginLeft: 6 }}
                      title="Encontrada por nome igual. Confirme para gravar.">sugerida</span>
                  )}
                  {!escolhido && c.sugestaoCor?.candidatos.length > 0 && (
                    <span className="mp-selo mp-selo-pendente" style={{ marginLeft: 6 }}
                      title={`Parecida com: ${c.sugestaoCor.candidatos.join(', ')}`}>
                      {c.sugestaoCor.criterio === 'empate' ? 'escolha' : 'parecida'}
                    </span>
                  )}
                  {!escolhido && !c.sugestaoCor?.candidatos.length && (
                    <span className="mp-selo mp-selo-pendente" style={{ marginLeft: 6 }}>falta</span>
                  )}
                </td>
                {/* Zero exato sai como "0", não "0,0": a casa decimal num zero
                    faz a coluna parecer ter um número quebrado quando não tem. */}
                <td>{c.necessidade == null
                  ? <span className="mp-vazio" title={c.motivoSemNecessidade || ''}>—</span>
                  : (Number(c.necessidade) === 0
                    ? <span style={{ color: 'var(--muted)' }} title="Nada a produzir nesta cor agora">0</span>
                    : q(c.necessidade, 1))}</td>
                <td>
                  {escolhido ? (
                    <input className="mp-saldo" type="number" step="0.01" placeholder="não sei"
                      value={editado !== undefined ? editado : (c.saldoTecido ?? '')}
                      onChange={(e) => setSaldos({ ...saldos, [chaveSaldo]: e.target.value })} />
                  ) : <span className="mp-vazio">—</span>}
                </td>
                <td>
                  {falta == null ? <span className="mp-vazio">—</span>
                    : (falta > 0 ? <b className="mp-falta-n">{q(falta, 1)}</b> : <span style={{ color: 'var(--success)' }}>0</span>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mp-nota" style={{ padding: '0 14px 12px' }}>
        <Info size={13} />
        <span>
          Este <b>falta</b> é só desta referência. O pedido ao fornecedor sai do quadro
          <b> Comprar por tecido</b>, lá em cima, que soma todas as referências que usam o mesmo rolo.
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Parametros({ referencia, tecidos, onSalvar }) {
  const cfg = referencia.config || {};
  const [form, setForm] = useState(null);
  const atual = form || {
    insumoId: cfg.insumoId || '',
    consumoPorPeca: cfg.consumoPorPeca ?? '',
    perdaPct: cfg.perdaFracao == null ? '' : Number((cfg.perdaFracao * 100).toFixed(2)),
    prazoEntregaDias: cfg.prazoEntregaDias ?? '',
    barca: cfg.barca ?? '',
    sazonalidade: cfg.sazonalidade ?? '',
    unidadeConfirmada: cfg.unidadeConfirmada === true,
  };
  const muda = (campo) => (e) => setForm({ ...atual, [campo]: e.target.value });
  const sujo = form != null;
  const tecido = tecidos.find((t) => t.id === Number(atual.insumoId));
  const und = tecido ? tecido.unidade : (cfg.unidadeConsumo || '');

  return (
    <div className="mp-params">
      <div className="mp-param">
        <label>Tecido</label>
        <select value={atual.insumoId} onChange={muda('insumoId')} className={sujo ? 'mp-sujo' : ''}>
          <option value="">— escolher —</option>
          {tecidos.map((t) => (
            <option key={t.id} value={t.id}>{t.nome} ({t.unidade})</option>
          ))}
        </select>
      </div>
      <div className="mp-param">
        <label>Cada peça gasta</label>
        <span className="mp-campo">
          <input type="number" step="0.001" value={atual.consumoPorPeca} onChange={muda('consumoPorPeca')}
            className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">{und || '—'}</span>
        </span>
      </div>
      <div className="mp-param">
        <label title="Quanto de tecido se perde no corte. Sem isso, a necessidade sai baixa.">Perda no corte</label>
        <span className="mp-campo">
          <input type="number" step="0.1" min="0" max="99" placeholder="—"
            value={atual.perdaPct} onChange={muda('perdaPct')} className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">%</span>
        </span>
      </div>
      <div className="mp-param">
        <label title="Quanto tempo o fornecedor leva para entregar. É o que define o 'pedir até'.">Fornecedor leva</label>
        <span className="mp-campo">
          <input type="number" step="1" min="1" value={atual.prazoEntregaDias} onChange={muda('prazoEntregaDias')}
            className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">dias</span>
        </span>
      </div>
      <div className="mp-param">
        <label title="Lote mínimo do fornecedor. O pedido sobe para o múltiplo seguinte.">Compra de</label>
        <span className="mp-campo">
          <input type="number" step="0.1" min="0" value={atual.barca} onChange={muda('barca')}
            className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">em {atual.barca || '—'} {und}</span>
        </span>
      </div>
      <div className="mp-param">
        <label title="Multiplicador de temporada. 1 = sem efeito.">Temporada</label>
        <span className="mp-campo">
          <input type="number" step="0.05" min="0.1" max="5" value={atual.sazonalidade} onChange={muda('sazonalidade')}
            className={sujo ? 'mp-sujo' : ''} />
          <span className="mp-unid">×</span>
        </span>
      </div>
      {tecido && tecido.unidade_confianca && (
        <div className="mp-param">
          <label>Unidade</label>
          <label className="mp-unid" style={{ display: 'flex', gap: 6, alignItems: 'center', height: 31, fontSize: 12 }}>
            <input type="checkbox" style={{ width: 'auto', height: 'auto' }} checked={!!atual.unidadeConfirmada}
              onChange={(e) => setForm({ ...atual, unidadeConfirmada: e.target.checked })} />
            confirmo que é <b>{tecido.unidade}</b>
          </label>
        </div>
      )}
      {sujo && (
        <div className="mp-param">
          <label>&nbsp;</label>
          <span className="mp-campo">
            <button type="button" className="btn btn-primary btn-mini"
              onClick={async () => { await onSalvar(atual); setForm(null); }}>
              <Save size={13} /> Salvar
            </button>
            <button type="button" className="btn-sec btn-mini" onClick={() => setForm(null)}>Cancelar</button>
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Referencia({ r, tecidos, aberta, onAlternar, onSalvarConfig, onSalvarCores, onSalvarSaldo }) {
  const mapa = useMemo(() => {
    const m = new Map();
    for (const c of r.cores) {
      const linha = new Map();
      for (const cel of c.celulas) linha.set(cel.tamanho, cel);
      m.set(c.cor, linha);
    }
    return m;
  }, [r.cores]);

  const cel = (c, t, campo) => num(mapa.get(c.cor)?.get(t)?.[campo]);
  const falta = (c, t) => num(c.porTamanho.find((x) => x.tamanho === t)?.falta);
  const somaT = (t, f) => r.cores.reduce((s, c) => s + f(c, t), 0);
  const somaC = (c, f) => r.tamanhos.reduce((s, t) => s + f(c, t), 0);
  const somaTudo = (f) => r.cores.reduce((s, c) => s + somaC(c, f), 0);
  const n = (v) => (v ? formatQtd(v) : <span className="mp-vazio">–</span>);

  const unidade = r.config?.unidadeConsumo || '';
  const semCadastro = r.cores.some((c) => !c.corInsumo) || !r.config?.insumoId;

  return (
    <div className={`mp-ref${aberta ? ' mp-ref-aberta' : ''}`}>
      <button type="button" className="mp-ref-topo" onClick={onAlternar} aria-expanded={aberta}>
        {aberta ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="mp-ref-id">
          <b>{r.referencia}</b>
          <span>{r.descricao}</span>
        </span>
        <span className="mp-faixa" title="Uma marca por cor: vermelho falta, verde está coberto, listrado falta cadastro">
          {r.cores.slice(0, 12).map((c) => (
            <i key={c.cor} className={!c.corInsumo ? 'mp-f-sem' : (c.aProduzir > 0 ? 'mp-f-falta' : 'mp-f-ok')}
              title={`${c.cor}: ${!c.corInsumo ? 'falta cadastrar a cor do tecido' : (c.aProduzir > 0 ? `faltam ${formatQtd(c.aProduzir)} peças` : 'coberto')}`} />
          ))}
        </span>
        <span className="mp-ref-num">
          <b>{formatQtd(r.totais.minimoPecas)}</b><span>mínimo</span>
        </span>
        <span className={`mp-ref-num${r.totais.aProduzir > 0 ? ' mp-ref-num-alerta' : ''}`}>
          <b>{formatQtd(r.totais.aProduzir)}</b><span>produzir</span>
        </span>
        <span className="mp-ref-num">
          <b>{r.totais.tecido ? `${q(r.totais.tecido, 1)}${unidade ? ` ${unidade}` : ''}` : '—'}</b>
          <span>tecido</span>
        </span>
      </button>

      {aberta && (
        <div className="mp-ref-corpo">
          <Parametros referencia={r} tecidos={tecidos} onSalvar={(f) => onSalvarConfig(r.produtoId, f)} />

          {r.pecasEmKitSemGrade > 0 && (
            <p className="mp-nota" style={{ marginBottom: 12 }}>
              <TriangleAlert size={13} color="var(--warning)" />
              <span>
                <b>{formatQtd(r.pecasEmKitSemGrade)} peças</b> saíram dentro de kit e não têm cor
                nem tamanho — o mínimo por cor abaixo está baixo nessa proporção.
              </span>
            </p>
          )}

          <div className="mp-quadros">
            <Quadro
              variante="preciso" titulo="Preciso" Icone={Boxes} rodape="estoque mínimo"
              tamanhos={r.tamanhos} cores={r.cores}
              celula={(c, t) => n(cel(c, t, 'minimo'))}
              totalCor={(c) => n(somaC(c, (x, y) => cel(x, y, 'minimo')))}
              totalTamanho={(t) => n(somaT(t, (c, tt) => cel(c, tt, 'minimo')))}
              total={() => n(somaTudo((c, t) => cel(c, t, 'minimo')))}
            />
            <Quadro
              variante="tenho" titulo="Tenho" Icone={Factory} rodape="galpão + facção"
              tamanhos={r.tamanhos} cores={r.cores}
              celula={(c, t) => {
                const s = cel(c, t, 'saldo'); const p = cel(c, t, 'emProducao');
                if (!s && !p) return <span className="mp-vazio">–</span>;
                return <>{s ? formatQtd(s) : '0'}{p ? <span className="mp-prod">+{formatQtd(p)}</span> : null}</>;
              }}
              totalCor={(c) => n(somaC(c, (x, y) => cel(x, y, 'saldo') + cel(x, y, 'emProducao')))}
              totalTamanho={(t) => n(somaT(t, (c, tt) => cel(c, tt, 'saldo') + cel(c, tt, 'emProducao')))}
              total={() => n(somaTudo((c, t) => cel(c, t, 'saldo') + cel(c, t, 'emProducao')))}
            />
            <Quadro
              variante="falta" titulo="Falta produzir" Icone={TriangleAlert} rodape="por tamanho"
              tamanhos={r.tamanhos} cores={r.cores}
              celula={(c, t) => {
                const v = falta(c, t);
                return v ? <b className="mp-falta-n mp-falta-n-bg">&nbsp;{formatQtd(v)}&nbsp;</b> : <span className="mp-vazio">–</span>;
              }}
              totalCor={(c) => n(somaC(c, falta))}
              totalTamanho={(t) => n(somaT(t, falta))}
              total={() => n(somaTudo(falta))}
            />
          </div>

          <CartaoTecido referencia={r} tecidos={tecidos}
            onSalvarCores={(cores) => onSalvarCores(r.produtoId, cores)}
            onSalvarSaldo={onSalvarSaldo} />

          {semCadastro && (
            <p className="mp-nota">
              <Info size={13} />
              <span>
                As cores marcadas com <span className="mp-selo mp-selo-pendente">falta</span> ou{' '}
                <span className="mp-selo mp-selo-pendente">parecida</span> ainda não sabem de qual cor do
                tecido saem — enquanto isso, elas não entram no pedido de compra.
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Consolidado({ linhas }) {
  const [aberta, setAberta] = useState(null);
  if (linhas.length === 0) return null;
  const comprar = linhas.filter((g) => g.situacao === 'comprar' || g.situacao === 'atrasado');
  const resto = linhas.filter((g) => !comprar.includes(g));

  const Linha = ({ g }) => {
    const chave = `${g.insumoId}|${g.corInsumo ?? ''}`;
    const ab = aberta === chave;
    return (
      <>
        <tr onClick={() => setAberta(ab ? null : chave)} style={{ cursor: 'pointer' }}>
          <td>
            {ab ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {g.insumo}
            <span className="mp-unid" style={{ marginLeft: 5 }}>{g.unidadeInsumo}</span>
          </td>
          <td>
            {g.corInsumo || <span className="mp-selo mp-selo-pendente">falta cadastrar</span>}
            {g.compartilhado && (
              <span className="mp-selo mp-selo-dividido" style={{ marginLeft: 6 }}
                title={`Somado de ${g.contribuintes.length} referências: ${[...new Set(g.contribuintes.map((c) => c.referencia))].join(', ')}`}>
                {g.contribuintes.length} refs
              </span>
            )}
          </td>
          <td>{Number(g.necessidade) === 0 ? <span style={{ color: 'var(--muted)' }}>0</span> : q(g.necessidade, 1)}</td>
          <td>{g.saldo == null
            ? <span className="mp-selo mp-selo-pendente" title="Ninguém informou o saldo desta cor. Não é zero — é 'não sei'.">não sei</span>
            : q(g.saldo, 1)}</td>
          <td>{g.pedido?.valor == null
            ? <span className="mp-vazio">—</span>
            : (g.pedido.valor > 0
              ? <b className="mp-falta-n">{q(g.pedido.valor, 1)}</b>
              : <span style={{ color: 'var(--success)' }}>0</span>)}
          </td>
          {/* Cobertura tem teto: "em 1340 d" não é informação, é ruído — nenhum
              tecido é comprado com quatro anos de antecedência. Acima de meio
              ano a resposta útil é "sobra", e o número exato fica no title. */}
          <td>{g.folgaDias == null
            ? <span className="mp-vazio" title={g.motivo || ''}>—</span>
            : (g.folgaDias < 0
              ? <b style={{ color: 'var(--danger)' }}>há {Math.abs(g.folgaDias)} d</b>
              : (g.folgaDias > 180
                ? <span style={{ color: 'var(--muted)' }} title={`Dá para esperar ${formatQtd(g.folgaDias)} dias`}>de sobra</span>
                : `em ${g.folgaDias} d`))}
          </td>
          <td style={{ textAlign: 'left' }}><Situacao chave={g.situacao} /></td>
        </tr>
        {ab && (
          <tr>
            <td colSpan={7} className="mp-contrib">
              {g.contribuintes.map((c, i) => (
                <span key={`${c.produtoId}-${c.corProduto}`}>
                  {i > 0 && ' · '}
                  <b>{c.referencia}</b> {c.corProduto}: {formatQtd(c.pecas)} pç × {q(c.consumoPorPeca, 3)} = {q(c.necessidade, 1)} {g.unidadeInsumo}
                </span>
              ))}
              {g.unidadeNaoConfirmada && (
                <div style={{ marginTop: 6, color: 'var(--warning)' }}>
                  <TriangleAlert size={12} /> A unidade deste tecido ainda não foi confirmada. Metro e quilo
                  mudam o resultado por três vezes — confirme antes de comprar.
                </div>
              )}
              {g.perdaNaoCadastrada && (
                <div style={{ marginTop: 4 }}>Sem perda de corte cadastrada: o número acima está <b>baixo</b>.</div>
              )}
            </td>
          </tr>
        )}
      </>
    );
  };

  return (
    <section className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
      <div className="mp-tecido-topo">
        <Layers size={14} />
        <h4>Comprar por tecido</h4>
        <span style={{ fontSize: 12, opacity: .8 }}>
          o mesmo rolo somado entre todas as referências — é daqui que sai o pedido
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="mp-tecido-tab">
          <thead>
            <tr>
              <th>Tecido</th><th>Cor</th><th>Preciso</th><th>Tenho</th>
              <th>Comprar</th><th>Pedir</th><th style={{ textAlign: 'left' }}>Situação</th>
            </tr>
          </thead>
          <tbody>
            {comprar.map((g) => <Linha key={`${g.insumoId}|${g.corInsumo}`} g={g} />)}
            {resto.map((g) => <Linha key={`${g.insumoId}|${g.corInsumo}`} g={g} />)}
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
  const [ajuda, setAjuda] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro(null);
    try {
      const qs = new URLSearchParams({ inicio: periodo.inicio, fim: periodo.fim, base });
      if (todas) qs.set('todas', '1');
      const [d, t] = await Promise.all([
        api.get(`/producao-materia-prima?${qs}`),
        api.get('/producao-materia-prima/tecidos'),
      ]);
      setDados(d); setTecidos(t.tecidos || []);
    } catch (e) { setErro(e.message); } finally { setCarregando(false); }
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

  // O quanto falta para a tela conseguir responder. É isto que vai para o
  // topo — não os cinco parágrafos de antes.
  const setup = useMemo(() => {
    if (!dados) return null;
    const totalCores = dados.referencias.reduce((s, r) => s + r.cores.length, 0);
    const mapeadas = dados.referencias.reduce((s, r) => s + r.cores.filter((c) => c.corInsumo).length, 0);
    const comSaldo = dados.consolidado.filter((g) => g.saldo != null).length;
    const unidadesOk = dados.referencias.filter((r) => r.config?.unidadeConfirmada).length;
    const totalRefs = dados.referencias.length;
    const pronto = mapeadas === totalCores && comSaldo === dados.consolidado.length && unidadesOk === totalRefs;
    return { totalCores, mapeadas, comSaldo, totalTecidos: dados.consolidado.length, unidadesOk, totalRefs, pronto };
  }, [dados]);

  const Passo = ({ feito, total, texto }) => (
    <span className="mp-passo">
      {feito === total
        ? <CheckCircle2 size={14} className="mp-passo-ok" />
        : <span className="mp-barra-progresso"><i style={{ width: `${total ? (feito / total) * 100 : 0}%` }} /></span>}
      <span className={feito === total ? 'mp-passo-ok' : 'mp-passo-falta'}>
        <b>{feito}/{total}</b> {texto}
      </span>
    </span>
  );

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Scissors size={20} /> Matéria-Prima</h1>
          <p className="page-sub">
            Quanto de tecido cada referência precisa, quanto existe, e o que comprar.
          </p>
        </div>
        <div className="pagina-acoes mp-barra">
          <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
          {dados && (
            <span className="mp-seg">
              {Object.entries(dados.bases).map(([k, v]) => (
                <button key={k} type="button" aria-pressed={base === k} onClick={() => setBase(k)} title={v.explicacao}>
                  {v.rotulo}
                </button>
              ))}
            </span>
          )}
          <button type="button" className="btn-sec" onClick={() => setTodas(!todas)}>
            {todas ? 'Só as configuradas' : 'Ver catálogo inteiro'}
          </button>
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {erro && <p className="erro-inline">{erro}</p>}
      {carregando && !dados && (
        <div style={{ display: 'grid', gap: 10 }}>
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={58} radius={8} />)}
        </div>
      )}

      {dados && (
        <>
          {setup && !setup.pronto && (
            <div className="mp-setup">
              <div>
                <h3><TriangleAlert size={16} color="var(--warning)" /> Falta cadastro para a tela poder comprar</h3>
                <p>
                  Enquanto estes três estiverem incompletos, as linhas aparecem como{' '}
                  <b>falta cadastro</b> em vez de virarem pedido — o sistema não chuta.
                </p>
                <div className="mp-passos">
                  <Passo feito={setup.mapeadas} total={setup.totalCores} texto="cores ligadas à cor do tecido" />
                  <Passo feito={setup.comSaldo} total={setup.totalTecidos} texto="tecidos com saldo informado" />
                  <Passo feito={setup.unidadesOk} total={setup.totalRefs} texto="unidades confirmadas (kg ou m)" />
                </div>
              </div>
              <button type="button" className="btn btn-primary"
                onClick={() => setAbertos(new Set(dados.referencias.map((r) => r.produtoId)))}>
                Abrir tudo para cadastrar <ArrowRight size={14} />
              </button>
            </div>
          )}

          <div className="mp-kpis">
            <div className={`mp-kpi${dados.totais.aComprar > 0 ? ' mp-kpi-perigo' : ' mp-kpi-bom'}`}>
              <span className="mp-kpi-rotulo"><ShoppingCart size={12} /> Comprar agora</span>
              <strong>{dados.totais.aComprar}</strong>
              <small>tecidos abaixo do necessário</small>
            </div>
            <div className={`mp-kpi${dados.totais.atrasados > 0 ? ' mp-kpi-perigo' : ''}`}>
              <span className="mp-kpi-rotulo"><CalendarClock size={12} /> Pedido atrasado</span>
              <strong>{dados.totais.atrasados}</strong>
              <small>o estoque acaba antes de o fornecedor entregar</small>
            </div>
            <div className={`mp-kpi${dados.totais.semCalculo > 0 ? ' mp-kpi-alerta' : ''}`}>
              <span className="mp-kpi-rotulo"><HelpCircle size={12} /> Falta cadastro</span>
              <strong>{dados.totais.semCalculo}</strong>
              <small>sem cor, saldo ou unidade — não entram na compra</small>
            </div>
            <div className="mp-kpi">
              <span className="mp-kpi-rotulo"><Scissors size={12} /> Referências</span>
              <strong>{dados.totais.referencias}</strong>
              <small>{dados.totais.tecidos} tecido(s) envolvido(s)</small>
            </div>
          </div>

          <Consolidado linhas={dados.consolidado} />

          {dados.referencias.length === 0 ? (
            <EstadoVazio
              titulo="Nenhuma referência com tecido cadastrado"
              descricao="Use 'Ver catálogo inteiro' para escolher a referência e dizer qual tecido ela usa e quanto cada peça gasta."
            />
          ) : (
            <div className="mp-lista">
              {dados.referencias.map((r) => (
                <Referencia
                  key={r.produtoId} r={r} tecidos={tecidos}
                  aberta={abertos.has(r.produtoId)}
                  onAlternar={() => alternar(r.produtoId)}
                  onSalvarConfig={salvarConfig}
                  onSalvarCores={salvarCores}
                  onSalvarSaldo={salvarSaldo}
                />
              ))}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button type="button" className="mp-ajuda-btn" onClick={() => setAjuda(!ajuda)}>
              {ajuda ? <X size={13} /> : <Info size={13} />} Como esta tela calcula
            </button>
            {ajuda && (
              <div className="mp-ajuda" style={{ marginTop: 8 }}>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {dados.bases[base] && (
                    <li>
                      <b>{dados.bases[base].rotulo}:</b> {dados.bases[base].explicacao}{' '}
                      <code>{dados.bases[base].formula}</code>
                    </li>
                  )}
                  {dados.avisos.map((a) => <li key={a}>{a}</li>)}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
