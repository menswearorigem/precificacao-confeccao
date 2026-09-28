import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Scissors, Printer, ArrowLeft, Save, AlertTriangle, CheckCircle2, Wand2, XCircle, Layers, Info,
} from 'lucide-react';
import { api } from '../api/client';
import { Skeleton, NumInput, Field, DateInput } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { formatQtd, dataBr, hojeIso } from '../lib/format';
import { SwatchCor, qtdTecido, SeloSituacaoCorte, SeloDesvio } from '../components/CorteComum';
import './Corte.css';

// Produção › Corte › Folha (28/09/2026).
//
// Em cima, a FOLHA DO CORTADOR — é ela que imprime, com colunas em branco para
// ele anotar à caneta o que separou, o que sobrou e as camadas que fez.
// Embaixo, o LANÇAMENTO dessas anotações e a comparação com o previsto.
//
// "Gastou" = separou − sobrou. Quem não pesa o que separou pode digitar o
// gasto direto. A sobra fica só registrada (decisão da dona): não mexe no
// saldo de tecido.

const ROTA = '/producao-corte';
const temNumero = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));

export default function CorteDetalhePage() {
  const { id } = useParams();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [lanc, setLanc] = useState({});
  const [dataCorte, setDataCorte] = useState(hojeIso());
  const [cortador, setCortador] = useState('');
  const [gravando, setGravando] = useState(false);

  const carregar = useCallback(async () => {
    setErro('');
    try {
      const r = await api.get(`${ROTA}/${id}`);
      setDados(r);
      setLanc(Object.fromEntries(r.cores.map((c) => [c.cor, {
        camadas_reais: c.camadas_reais ?? '',
        tecido_separado: c.tecido_separado ?? '',
        sobra: c.sobra ?? '',
        tecido_real: c.tecido_separado == null ? (c.tecido_real ?? '') : '',
      }])));
      setDataCorte(r.corte.data_corte ? String(r.corte.data_corte).slice(0, 10) : hojeIso());
      setCortador(r.corte.cortador || '');
    } catch (e) { setErro(e.message); }
  }, [id]);
  useEffect(() => { carregar(); }, [carregar]);

  const corte = dados?.corte;
  const un = corte?.unidade || 'kg';
  const grade = useMemo(() => (corte?.grade || []).filter((g) => g.unidades > 0), [corte]);

  function gasto(cor) {
    const l = lanc[cor] || {};
    if (temNumero(l.tecido_separado)) return Number(l.tecido_separado) - (temNumero(l.sobra) ? Number(l.sobra) : 0);
    if (temNumero(l.tecido_real)) return Number(l.tecido_real);
    return null;
  }
  const mudar = (cor, campo, v) => setLanc((x) => ({ ...x, [cor]: { ...x[cor], [campo]: v } }));

  async function salvar() {
    setGravando(true); setErro(''); setAviso('');
    try {
      await api.put(`${ROTA}/${id}/lancar`, {
        data_corte: dataCorte,
        cortador,
        cores: dados.cores.map((c) => {
          const l = lanc[c.cor] || {};
          return {
            cor: c.cor,
            camadas_reais: l.camadas_reais,
            tecido_separado: temNumero(l.tecido_separado) ? l.tecido_separado : null,
            sobra: temNumero(l.sobra) ? l.sobra : null,
            tecido_real: temNumero(l.tecido_separado) ? null : (temNumero(l.tecido_real) ? l.tecido_real : null),
          };
        }),
      });
      setAviso('Corte lançado.');
      await carregar();
      // O resultado (e a sugestão de corrigir a ficha) aparece no alto da tela.
      document.querySelector('.shell-main')?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setErro(e.message); } finally { setGravando(false); }
  }

  async function cancelar() {
    if (!(await confirmar('Cancelar esta ordem de corte? A folha deixa de valer; a OP não muda.', { titulo: 'Cancelar corte', confirmarTexto: 'Cancelar corte' }))) return;
    try { await api.post(`${ROTA}/${id}/cancelar`, {}); await carregar(); } catch (e) { setErro(e.message); }
  }

  async function corrigirFicha() {
    const s = dados.sugestao;
    const pct = ((s.fator - 1) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    const ok = await confirmar(
      `Multiplicar o consumo de tecido da ficha da ${corte.referencia} por ${String(s.fator).replace('.', ',')} (${s.fator > 1 ? '+' : ''}${pct}%), em todos os tamanhos? As próximas OPs, cortes e a calculadora passam a usar o consumo novo. O custo do produto NÃO é recalculado sozinho.`,
      { titulo: 'Corrigir a ficha', confirmarTexto: 'Corrigir a ficha', perigo: false }
    );
    if (!ok) return;
    try {
      const r = await api.post(`${ROTA}/${id}/corrigir-ficha`, {});
      setAviso(`Ficha corrigida pelo fator ${String(r.fator).replace('.', ',')}, com base em ${r.cortes} cortes reais.`);
      await carregar();
    } catch (e) { setErro(e.message); }
  }

  if (!dados) {
    return (
      <div className="pagina">
        {erro ? <p className="erro-inline">{erro}</p> : <Skeleton height={320} />}
      </div>
    );
  }

  const { cores, comparacao, sugestao } = dados;
  const cancelada = corte.situacao === 'cancelada';
  const totalPecas = cores.reduce((s, c) => s + grade.reduce((a, g) => a + Number(c.pecas_previstas?.[g.tamanho] || 0), 0), 0);
  const totalPrevisto = cores.every((c) => c.tecido_previsto != null) ? cores.reduce((s, c) => s + c.tecido_previsto, 0) : null;
  const temReal = comparacao.total.real != null;

  return (
    <div className="pagina co-detalhe">
      <header className="pagina-topo no-print">
        <div>
          <Link to="/producao/corte" className="co-voltar"><ArrowLeft size={14} /> Corte</Link>
          <h1><Scissors size={22} /> Corte nº {corte.numero} <SeloSituacaoCorte situacao={corte.situacao} /></h1>
          <p className="ink-soft">
            OP {corte.ordem_numero_exibicao} · <b>{corte.referencia}</b> {corte.produto_descricao}
            {corte.fornecedor_nome ? ` · facção ${corte.fornecedor_nome}` : ''}
            {corte.data_prevista ? ` · OP até ${dataBr(corte.data_prevista)}` : ''}
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={15} /> Imprimir folha</button>
          {corte.situacao === 'aberta' && (
            <button type="button" className="btn btn-danger" onClick={cancelar}><XCircle size={15} /> Cancelar</button>
          )}
        </div>
      </header>

      {erro && <p className="erro-inline no-print">{erro}</p>}
      {aviso && <p className="co-ok no-print"><CheckCircle2 size={14} /> {aviso}</p>}

      {sugestao?.sugerir && !cancelada && (
        <div className="co-sugestao no-print">
          <Wand2 size={18} />
          <div>
            <b>{sugestao.motivo}</b>
            <p>Corrigir a ficha faz as próximas OPs, cortes e a calculadora usarem o consumo real.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={corrigirFicha}>
            Corrigir a ficha (× {String(sugestao.fator).replace('.', ',')})
          </button>
        </div>
      )}

      {/* ─── Folha do cortador (imprime) ─────────────────────────────── */}
      <section className="card co-folha">
        <div className="co-folha-topo">
          <div>
            <span className="co-folha-rot">Folha do cortador</span>
            <h2>Corte nº {corte.numero} · OP {corte.ordem_numero_exibicao} · {corte.referencia}</h2>
            <p className="ink-soft">{corte.produto_descricao}{corte.tecido_nome ? ` · tecido ${corte.tecido_nome}` : ''}</p>
          </div>
          <div className="co-folha-grade">
            <span className="co-folha-rot"><Layers size={12} /> Grade do risco</span>
            <div className="co-chips">
              {grade.map((g) => <span key={g.tamanho} className="co-chip"><b>{g.tamanho}</b> {g.unidades}</span>)}
            </div>
            <small className="ink-soft">{corte.pecas_por_grade} peças por camada</small>
          </div>
        </div>

        <div className="tabela-rolagem">
          <table className="tabela-nota tabela-estreita co-folha-tab">
            <thead>
              <tr>
                <th>Cor</th>
                <th className="num">Camadas</th>
                {grade.map((g) => <th key={g.tamanho} className="num">{g.tamanho}</th>)}
                <th className="num">Peças</th>
                <th className="num">Separar</th>
                <th className="print-only co-anotar">Separei</th>
                <th className="print-only co-anotar">Sobrou</th>
                <th className="print-only co-anotar">Camadas feitas</th>
              </tr>
            </thead>
            <tbody>
              {cores.map((c) => {
                const pecas = grade.reduce((a, g) => a + Number(c.pecas_previstas?.[g.tamanho] || 0), 0);
                return (
                  <tr key={c.cor}>
                    <td><SwatchCor cor={c.cor} hex={c.hex} /><b>{c.cor || 'sem cor'}</b></td>
                    <td className="num co-camadas">{formatQtd(c.camadas_previstas)}</td>
                    {grade.map((g) => <td key={g.tamanho} className="num">{formatQtd(c.pecas_previstas?.[g.tamanho] || 0)}</td>)}
                    <td className="num"><b>{formatQtd(pecas)}</b></td>
                    <td className="num"><b>{c.tecido_previsto == null ? '—' : qtdTecido(c.tecido_previsto, un)}</b></td>
                    <td className="print-only co-anotar" />
                    <td className="print-only co-anotar" />
                    <td className="print-only co-anotar" />
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{formatQtd(cores.reduce((s, c) => s + c.camadas_previstas, 0))}</td>
                {grade.map((g) => <td key={g.tamanho} className="num">{formatQtd(cores.reduce((s, c) => s + Number(c.pecas_previstas?.[g.tamanho] || 0), 0))}</td>)}
                <td className="num"><b>{formatQtd(totalPecas)}</b></td>
                <td className="num"><b>{totalPrevisto == null ? '—' : qtdTecido(totalPrevisto, un)}</b></td>
                <td className="print-only co-anotar" /><td className="print-only co-anotar" /><td className="print-only co-anotar" />
              </tr>
            </tfoot>
          </table>
        </div>
        {totalPrevisto == null && (
          <p className="ajuda-bloco ink-soft"><Info size={12} /> "Separar" em branco: a ficha não tem consumo para algum tamanho desta cor.</p>
        )}
        <div className="print-only co-assinatura">
          <span>Cortador: ____________________________</span>
          <span>Data: ____/____/______</span>
        </div>
      </section>

      {/* ─── Lançamento ───────────────────────────────────────────────── */}
      {!cancelada && (
        <section className="card no-print">
          <h2 className="card-titulo"><Save size={16} /> {corte.situacao === 'cortada' ? 'Corte lançado — corrigir se precisar' : 'Lançar o corte'}</h2>
          <p className="ajuda-bloco ink-soft">
            Digite o que o cortador anotou. <b>Gastou</b> = separou − sobrou. Se não pesou o que
            separou, deixe em branco e digite o gasto direto.
          </p>
          <div className="co-lanc-topo">
            <Field label="Data do corte"><DateInput value={dataCorte} onChange={(e) => setDataCorte(e.target.value)} /></Field>
            <Field label="Cortador"><input className="input" value={cortador} maxLength={80} onChange={(e) => setCortador(e.target.value)} /></Field>
          </div>
          <div className="tabela-rolagem">
            <table className="tabela-nota tabela-estreita co-lanc">
              <thead>
                <tr>
                  <th>Cor</th><th className="num">Camadas feitas</th>
                  <th className="num">Separei ({un})</th><th className="num">Sobrou ({un})</th>
                  <th className="num">Gastou ({un})</th><th className="num">Previsto</th><th>Real × ficha</th>
                </tr>
              </thead>
              <tbody>
                {cores.map((c) => {
                  const l = lanc[c.cor] || {};
                  const g = gasto(c.cor);
                  const desvio = g != null && c.tecido_previsto ? g / c.tecido_previsto - 1 : null;
                  const sobraDemais = temNumero(l.sobra) && temNumero(l.tecido_separado) && Number(l.sobra) > Number(l.tecido_separado);
                  return (
                    <tr key={c.cor}>
                      <td><SwatchCor cor={c.cor} hex={c.hex} />{c.cor || 'sem cor'}</td>
                      <td className="num"><NumInput value={l.camadas_reais} onChange={(v) => mudar(c.cor, 'camadas_reais', v)} step="1" min={0} placeholder={String(c.camadas_previstas)} /></td>
                      <td className="num"><NumInput value={l.tecido_separado} onChange={(v) => mudar(c.cor, 'tecido_separado', v)} step="0.01" min={0} /></td>
                      <td className="num"><NumInput value={l.sobra} onChange={(v) => mudar(c.cor, 'sobra', v)} step="0.01" min={0} className={sobraDemais ? 'co-invalido' : ''} /></td>
                      <td className="num">
                        {temNumero(l.tecido_separado)
                          ? <b className={sobraDemais ? 'co-menos' : ''}>{g == null ? '—' : qtdTecido(g, un)}</b>
                          : <NumInput value={l.tecido_real} onChange={(v) => mudar(c.cor, 'tecido_real', v)} step="0.01" min={0} />}
                      </td>
                      <td className="num">{c.tecido_previsto == null ? '—' : qtdTecido(c.tecido_previsto, un)}</td>
                      <td>{desvio == null ? '—' : <SeloDesvio desvio={desvio} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="co-lanc-rodape">
            <button type="button" className="btn btn-primary" onClick={salvar} disabled={gravando}>
              <Save size={15} /> {gravando ? 'Gravando…' : (corte.situacao === 'cortada' ? 'Salvar correção' : 'Lançar corte')}
            </button>
          </div>
        </section>
      )}

      {/* ─── Previsto × real ─────────────────────────────────────────── */}
      {temReal && (
        <section className="card no-print">
          <h2 className="card-titulo">Previsto × real</h2>
          <div className="co-resumo">
            <div><small>Previsto</small><b>{qtdTecido(comparacao.total.previsto, un)}</b></div>
            <div><small>Gasto de verdade</small><b>{qtdTecido(comparacao.total.real, un)}</b></div>
            <div><small>Diferença</small><b>{comparacao.total.diferenca > 0 ? '+' : ''}{qtdTecido(comparacao.total.diferenca, un)}</b></div>
            <div><small>Real × ficha</small><b><SeloDesvio desvio={comparacao.total.desvio} grande /></b></div>
          </div>
          {comparacao.total.coresSemComparacao > 0 && (
            <p className="ajuda-bloco ink-soft"><AlertTriangle size={12} /> {comparacao.total.coresSemComparacao} cor(es) ficaram fora da conta: sem previsto (ficha incompleta) ou sem lançamento.</p>
          )}
          {!sugestao?.sugerir && sugestao?.cortes > 0 && (
            <p className="ajuda-bloco ink-soft"><Info size={12} /> {sugestao.motivo}</p>
          )}
          {dados.historico.length > 1 && (
            <div className="co-historico">
              <small className="ink-soft">Últimos cortes da {corte.referencia}:</small>
              {dados.historico.slice(0, 5).map((h) => (
                <Link key={h.id} to={`/producao/corte/${h.id}`} className="co-hist-item">
                  Nº {h.numero} <SeloDesvio desvio={h.previsto ? h.real / h.previsto - 1 : null} />
                </Link>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
