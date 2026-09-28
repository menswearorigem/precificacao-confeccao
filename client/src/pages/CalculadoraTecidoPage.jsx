import { useEffect, useMemo, useState } from 'react';
import {
  Calculator, Copy, Check, Printer, RotateCcw, Plus, X, AlertTriangle, Info,
  Ruler, Weight, Save, Scissors, Users, Palette,
} from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Select, Skeleton } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { calcularTecido, rotuloGrade, textoResumo, UNIDADES } from '../lib/calculoTecido';
import './CalculadoraTecidoPage.css';

// Produção › Calculadora de Tecido (28/09/2026).
//
// A planilha "Cálculo de tecido por pedido" levada para dentro do Hub. A
// pergunta é uma só: "quanto tecido eu preciso para este pedido?".
//
// O que o Hub acrescenta à planilha: escolhendo a referência, as CORES, os
// TAMANHOS e o CONSUMO POR TAMANHO já vêm da ficha do produto (as mesmas
// rotas que a Nova Ordem usa — /producao/produto-grade e
// /producao/consumo-tamanho). Nada é gravado ao calcular: a tela é uma
// calculadora. A única escrita é o botão "Guardar consumo na ficha", que usa a
// rota que já existia (POST /producao/consumo-tamanho) — nenhuma tabela nova,
// nenhuma permissão nova (REGRA 4 não se aplica).
//
// O rascunho fica no navegador de quem está usando, para não perder o pedido
// digitado se a aba fechar.

const CHAVE_RASCUNHO = 'hbn.calculadoraTecido.v1';
const TAMANHOS_PADRAO = ['P', 'M', 'G', 'GG'];

const fmt = (n, casas = 2) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const fmtInt = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

function novoTamanho(tamanho, grade = 1) {
  return { tamanho, grade, consumo: { kg: '', m: '' } };
}

function estadoInicial() {
  return {
    produtoId: '',
    referencia: '',
    descricao: '',
    unidade: 'kg',
    modo: 'tamanho',
    perdaPct: 0,
    consumoUnico: { kg: '', m: '' },
    tamanhos: TAMANHOS_PADRAO.map((t) => novoTamanho(t)),
    clientes: ['Cliente 1'],
    cores: [{ cor: '', hex: null, qtds: [''] }],
    materialId: '',
  };
}

function lerRascunho() {
  try {
    const bruto = window.localStorage.getItem(CHAVE_RASCUNHO);
    if (!bruto) return null;
    const r = JSON.parse(bruto);
    return r && Array.isArray(r.tamanhos) && Array.isArray(r.cores) ? { ...estadoInicial(), ...r } : null;
  } catch { return null; }
}

function Swatch({ hex, cor }) {
  if (!hex) return <span className="pe-swatch pe-swatch-vazio" title={cor ? `${cor} — sem cor de tela cadastrada` : ''} />;
  const estilo = String(cor || '').toUpperCase().includes('MESCLA')
    ? { backgroundImage: `repeating-linear-gradient(45deg, ${hex} 0 2px, ${hex}99 2px 4px)` }
    : { background: hex };
  return <span className="pe-swatch" style={estilo} title={`${cor} ${hex}`} />;
}

// Field do sistema é um <label>: com botões dentro, o clique no rótulo cairia
// no primeiro botão. Para o seletor de opções o invólucro é uma <div>.
function Campo({ label, children }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

function Segmentado({ opcoes, valor, onChange }) {
  return (
    <div className="segmentado ct-seg" role="radiogroup">
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          role="radio"
          aria-checked={valor === o.valor}
          className={valor === o.valor ? 'ativo' : ''}
          onClick={() => onChange(o.valor)}
        >
          {o.Icone && <o.Icone size={14} />} {o.rotulo}
        </button>
      ))}
    </div>
  );
}

export default function CalculadoraTecidoPage() {
  const [s, setS] = useState(() => lerRascunho() || estadoInicial());
  const [referencias, setReferencias] = useState([]);
  const [materiais, setMateriais] = useState([]);
  const [consumoFicha, setConsumoFicha] = useState(null); // o que veio da ficha, para saber se mudou
  const [carregandoRef, setCarregandoRef] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [copiado, setCopiado] = useState(false);
  const [novaCor, setNovaCor] = useState('');

  const up = (patch) => setS((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) }));

  // Rascunho: guardado a cada mudança. Falhar aqui (aba anônima, bloqueio)
  // não pode quebrar a tela — a conta continua funcionando sem ele.
  useEffect(() => {
    try { window.localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify(s)); } catch { /* sem rascunho */ }
  }, [s]);

  useEffect(() => {
    api.get('/producao/apoio')
      .then((r) => setReferencias(r.referencias || []))
      .catch((e) => setErro(e.message));
  }, []);

  // Ficha da referência escolhida → materiais (para o botão de guardar).
  useEffect(() => {
    if (!s.produtoId) { setMateriais([]); setConsumoFicha(null); return; }
    api.get(`/producao/consumo-tamanho/${s.produtoId}`)
      .then((c) => {
        const tecidos = (c.materiais || []).filter((m) => ['kg', 'm'].includes(unidadeDoMaterial(m)));
        setMateriais(tecidos);
        setConsumoFicha(c);
      })
      .catch(() => { setMateriais([]); setConsumoFicha(null); });
  }, [s.produtoId]);

  async function escolherReferencia(id) {
    setErro(''); setAviso('');
    if (!id) { up({ produtoId: '', referencia: '', descricao: '', materialId: '' }); return; }
    const ref = referencias.find((r) => String(r.id) === String(id));
    const temPedido = s.cores.some((c) => c.qtds.some((q) => Number(q) > 0));
    if (temPedido && !(await confirmar(
      'Trocar a referência troca as cores, os tamanhos e o consumo pelos da ficha dela. As quantidades digitadas serão apagadas.',
      { titulo: 'Trocar de referência', confirmarTexto: 'Trocar', perigo: false }
    ))) return;

    setCarregandoRef(true);
    try {
      const [grade, consumo] = await Promise.all([
        api.get(`/producao/produto-grade/${id}`),
        api.get(`/producao/consumo-tamanho/${id}`).catch(() => null),
      ]);
      const tecidos = (consumo?.materiais || []).filter((m) => ['kg', 'm'].includes(unidadeDoMaterial(m)));
      const material = tecidos[0] || null;
      const tamanhosCad = (grade.tamanhos || []).filter((t) => t.ativo !== false).map((t) => t.tamanho);
      const coresCad = (grade.cores || []).filter((c) => c.ativo !== false);

      const base = estadoInicial();
      const tamanhos = (tamanhosCad.length ? tamanhosCad : TAMANHOS_PADRAO).map((t) => novoTamanho(t));
      const pre = preencherDaFicha(tamanhos, material, consumo);

      up({
        ...base,
        unidade: pre.unidade || s.unidade,
        modo: s.modo,
        clientes: s.clientes,
        produtoId: String(id),
        referencia: ref?.referencia || '',
        descricao: ref?.descricao || '',
        materialId: material ? String(material.id) : '',
        perdaPct: pre.perdaPct ?? 0,
        consumoUnico: pre.consumoUnico,
        tamanhos: pre.tamanhos,
        cores: coresCad.length
          ? coresCad.map((c) => ({ cor: c.cor, hex: c.hex || null, qtds: s.clientes.map(() => '') }))
          : [{ cor: '', hex: null, qtds: s.clientes.map(() => '') }],
      });
      const partes = [];
      if (coresCad.length) partes.push(`${coresCad.length} cores`);
      if (tamanhosCad.length) partes.push(`${tamanhosCad.length} tamanhos`);
      if (pre.veioConsumo) partes.push('o consumo por peça');
      setAviso(partes.length
        ? `Preenchido pela ficha da ${ref?.referencia}: ${partes.join(', ')}. Confira a grade e digite as quantidades.`
        : `A ${ref?.referencia} ainda não tem cores, tamanhos nem consumo na ficha. Preencha aqui mesmo.`);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoRef(false);
    }
  }

  function trocarMaterial(id) {
    const material = materiais.find((m) => String(m.id) === String(id)) || null;
    const pre = preencherDaFicha(s.tamanhos.map((t) => ({ ...t, consumo: { kg: '', m: '' } })), material, consumoFicha);
    up({ materialId: id, unidade: pre.unidade || s.unidade, tamanhos: pre.tamanhos, consumoUnico: pre.consumoUnico, perdaPct: pre.perdaPct ?? s.perdaPct });
  }

  // ---- edição da grade -------------------------------------------------------
  const mudarTamanho = (i, patch) => up((x) => ({ tamanhos: x.tamanhos.map((t, k) => (k === i ? { ...t, ...patch } : t)) }));
  const mudarConsumo = (i, v) => up((x) => ({ tamanhos: x.tamanhos.map((t, k) => (k === i ? { ...t, consumo: { ...t.consumo, [x.unidade]: v } } : t)) }));
  const tirarTamanho = (i) => up((x) => ({ tamanhos: x.tamanhos.filter((_, k) => k !== i) }));
  const addTamanho = () => up((x) => ({ tamanhos: [...x.tamanhos, novoTamanho('', 0)] }));

  // ---- edição do pedido ------------------------------------------------------
  const mudarQtd = (ci, j, v) => up((x) => ({ cores: x.cores.map((c, k) => (k === ci ? { ...c, qtds: c.qtds.map((q, jj) => (jj === j ? v : q)) } : c)) }));
  const mudarCor = (ci, patch) => up((x) => ({ cores: x.cores.map((c, k) => (k === ci ? { ...c, ...patch } : c)) }));
  const tirarCor = (ci) => up((x) => ({ cores: x.cores.length > 1 ? x.cores.filter((_, k) => k !== ci) : [{ cor: '', hex: null, qtds: x.clientes.map(() => '') }] }));
  const addCor = (nome = '') => up((x) => ({ cores: [...x.cores, { cor: nome, hex: null, qtds: x.clientes.map(() => '') }] }));
  const addCliente = () => up((x) => ({
    clientes: [...x.clientes, `Cliente ${x.clientes.length + 1}`],
    cores: x.cores.map((c) => ({ ...c, qtds: [...c.qtds, ''] })),
  }));
  const tirarCliente = (j) => up((x) => (x.clientes.length <= 1 ? {} : {
    clientes: x.clientes.filter((_, k) => k !== j),
    cores: x.cores.map((c) => ({ ...c, qtds: c.qtds.filter((_, k) => k !== j) })),
  }));
  const mudarCliente = (j, nome) => up((x) => ({ clientes: x.clientes.map((c, k) => (k === j ? nome : c)) }));

  async function limpar() {
    if (!(await confirmar('Apagar a referência, a grade e todas as quantidades digitadas?', { titulo: 'Começar de novo', confirmarTexto: 'Apagar tudo' }))) return;
    setS(estadoInicial()); setAviso(''); setErro('');
  }

  // ---- conta -----------------------------------------------------------------
  const u = UNIDADES[s.unidade];
  const entrada = useMemo(() => ({
    unidade: s.unidade,
    modo: s.modo,
    perdaPct: s.perdaPct,
    consumoUnico: s.consumoUnico[s.unidade],
    tamanhos: s.tamanhos.map((t) => ({ tamanho: t.tamanho || '?', grade: t.grade, consumo: t.consumo[s.unidade] })),
    cores: s.cores.map((c) => ({ cor: c.cor || 'Sem nome', hex: c.hex, qtds: c.qtds })),
  }), [s]);
  const r = useMemo(() => calcularTecido(entrada), [entrada]);
  const somaGrade = s.tamanhos.reduce((a, t) => a + (Number(t.grade) || 0), 0);
  const gradeTexto = rotuloGrade(entrada.tamanhos);
  const maiorCor = Math.max(0, ...r.linhas.map((l) => l.tecido));
  const usaGrade = s.modo === 'tamanho';

  async function copiarResumo() {
    const texto = textoResumo({ ...s, tamanhos: entrada.tamanhos }, r);
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch { setErro('O navegador não deixou copiar. Selecione o resultado e copie com Ctrl+C.'); }
  }

  // ---- guardar consumo na ficha ---------------------------------------------
  const material = materiais.find((m) => String(m.id) === String(s.materialId)) || null;
  const unidadeFicha = material ? unidadeDoMaterial(material) : null;
  const podeGuardar = usaGrade && material && unidadeFicha === s.unidade
    && s.tamanhos.some((t) => Number(t.consumo[s.unidade]) > 0 && t.tamanho);

  async function guardarNaFicha() {
    const linhas = s.tamanhos
      .filter((t) => t.tamanho && Number(t.consumo[s.unidade]) > 0)
      .map((t) => ({
        material_id: Number(material.id),
        tamanho: t.tamanho,
        consumo_por_peca: s.unidade === 'kg' ? Number(t.consumo.kg) / 1000 : Number(t.consumo.m),
      }));
    const ok = await confirmar(
      `Guardar o consumo de ${linhas.length} tamanhos na ficha da ${s.referencia} (${material.insumo_nome || material.material})? As próximas ordens de produção e esta calculadora passam a usar esses valores.`,
      { titulo: 'Guardar consumo na ficha', confirmarTexto: 'Guardar', perigo: false }
    );
    if (!ok) return;
    try {
      await api.post('/producao/consumo-tamanho', { linhas });
      setAviso(`Consumo por tamanho guardado na ficha da ${s.referencia}.`);
      const c = await api.get(`/producao/consumo-tamanho/${s.produtoId}`);
      setConsumoFicha(c);
    } catch (e) { setErro(e.message); }
  }

  return (
    <div className="pagina ct-pagina">
      <header className="pagina-topo">
        <div>
          <h1><Calculator size={22} /> Calculadora de Tecido</h1>
          <p className="ink-soft">
            Quanto tecido comprar para um pedido, em quilo ou em metro, somando vários clientes e já
            separando as peças por tamanho para o corte.
          </p>
        </div>
        <div className="pagina-acoes no-print">
          <button type="button" className="btn btn-primary" onClick={copiarResumo} disabled={r.totalPecas === 0}>
            {copiado ? <Check size={15} /> : <Copy size={15} />} {copiado ? 'Copiado' : 'Copiar resumo'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => window.print()} disabled={r.totalPecas === 0}>
            <Printer size={15} /> Imprimir
          </button>
          <button type="button" className="btn btn-ghost" onClick={limpar}>
            <RotateCcw size={15} /> Começar de novo
          </button>
        </div>
      </header>

      {erro && <p className="erro-inline no-print">{erro}</p>}
      {aviso && <p className="aviso-inline ct-aviso no-print"><Info size={14} /> {aviso}</p>}

      <div className="ct-layout">
        <div className="ct-entradas no-print">
          {/* 1 ─ Referência e medida */}
          <section className="card ct-passo">
            <h2 className="card-titulo"><span className="ct-num">1</span> Referência e medida</h2>
            <div className="ct-linha">
              <Field label="Referência" hint="Escolha e o Hub traz cores, tamanhos e consumo da ficha.">
                <Select value={s.produtoId} onChange={(e) => escolherReferencia(e.target.value)} placeholder="Escolha a referência" chaveRecentes="calculadoraTecido">
                  {referencias.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
                </Select>
              </Field>
              <Campo label="Medir o tecido em">
                <Segmentado
                  valor={s.unidade}
                  onChange={(v) => up({ unidade: v })}
                  opcoes={[{ valor: 'kg', rotulo: 'Quilo (kg)', Icone: Weight }, { valor: 'm', rotulo: 'Metro (m)', Icone: Ruler }]}
                />
              </Campo>
              <Campo label="Consumo por peça">
                <Segmentado
                  valor={s.modo}
                  onChange={(v) => up({ modo: v })}
                  opcoes={[{ valor: 'tamanho', rotulo: 'Por tamanho' }, { valor: 'unico', rotulo: 'Igual p/ todos' }]}
                />
              </Campo>
              <Field label="Perda no corte" hint="Opcional. Compra um pouco a mais.">
                <NumInput value={s.perdaPct} onChange={(v) => up({ perdaPct: v === '' ? 0 : Math.min(100, v) })} step="0.1" min={0} suffix="%" />
              </Field>
            </div>
            {materiais.length > 1 && (
              <div className="ct-linha ct-linha-extra">
                <Field label="Tecido da ficha" hint="A referência tem mais de um tecido. Escolha qual calcular.">
                  <Select value={s.materialId} onChange={(e) => trocarMaterial(e.target.value)}>
                    {materiais.map((m) => <option key={m.id} value={m.id}>{m.insumo_nome || m.material} · {unidadeDoMaterial(m)}</option>)}
                  </Select>
                </Field>
              </div>
            )}
            {carregandoRef && <Skeleton height={16} />}
          </section>

          {/* 2 ─ Grade e consumo */}
          <section className="card ct-passo">
            <h2 className="card-titulo">
              <span className="ct-num">2</span> {usaGrade ? 'Grade e consumo por tamanho' : 'Consumo por peça'}
            </h2>
            {usaGrade ? (
              <>
                <div className="tabela-rolagem">
                  <table className="ct-grade">
                    <thead>
                      <tr>
                        <th />
                        {s.tamanhos.map((t, i) => (
                          <th key={i}>
                            <div className="ct-th-tam">
                              <input className="ct-input-tam" value={t.tamanho} maxLength={6} placeholder="?" onChange={(e) => mudarTamanho(i, { tamanho: e.target.value.toUpperCase() })} />
                              <button type="button" className="ct-x" title={`Tirar o tamanho ${t.tamanho}`} onClick={() => tirarTamanho(i)}><X size={11} /></button>
                            </div>
                          </th>
                        ))}
                        <th><button type="button" className="btn btn-dashed sm" onClick={addTamanho}><Plus size={12} /> tamanho</button></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="ct-rot">Grade <small>proporção</small></td>
                        {s.tamanhos.map((t, i) => (
                          <td key={i}><NumInput value={t.grade} onChange={(v) => mudarTamanho(i, { grade: v === '' ? 0 : v })} step="1" min={0} /></td>
                        ))}
                        <td className="ct-soma">{somaGrade} <small>por grade</small></td>
                      </tr>
                      <tr>
                        <td className="ct-rot">Cada peça gasta <small>{u.porPecaLongo}</small></td>
                        {s.tamanhos.map((t, i) => (
                          <td key={i}>
                            <NumInput
                              value={t.consumo[s.unidade]}
                              onChange={(v) => mudarConsumo(i, v)}
                              step={s.unidade === 'kg' ? '1' : '0.001'}
                              min={0}
                              suffix={u.porPeca}
                              className={Number(t.grade) > 0 && !(Number(t.consumo[s.unidade]) > 0) ? 'ct-falta' : ''}
                            />
                          </td>
                        ))}
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="ct-grade-rodape">
                  <span className="ink-soft">{gradeTexto ? <>Grade: <b>{gradeTexto}</b></> : 'Tamanho com grade 0 não é cortado.'}</span>
                  <span className="ct-atalhos">
                    <button type="button" className="btn btn-ghost sm" onClick={() => up((x) => ({ tamanhos: x.tamanhos.map((t) => ({ ...t, grade: 1 })) }))}>1 de cada</button>
                    {podeGuardar && (
                      <button type="button" className="btn btn-ghost sm" onClick={guardarNaFicha} title="Grava estes consumos na ficha do produto">
                        <Save size={12} /> Guardar consumo na ficha
                      </button>
                    )}
                  </span>
                </div>
                {material && unidadeFicha !== s.unidade && (
                  <p className="ajuda-bloco ink-soft ct-dica">
                    A ficha da {s.referencia} está em {unidadeFicha === 'kg' ? 'quilo' : 'metro'}. Em {u.rotulo.toLowerCase()} o consumo precisa ser digitado aqui.
                  </p>
                )}
              </>
            ) : (
              <div className="ct-linha">
                <Field label={`Cada peça gasta (${u.porPecaLongo})`} hint={s.unidade === 'kg' ? 'Ex.: 180 para 180 gramas.' : 'Ex.: 0,45 para 45 centímetros.'}>
                  <NumInput
                    value={s.consumoUnico[s.unidade]}
                    onChange={(v) => up((x) => ({ consumoUnico: { ...x.consumoUnico, [x.unidade]: v } }))}
                    step={s.unidade === 'kg' ? '1' : '0.001'}
                    min={0}
                    suffix={u.porPeca}
                  />
                </Field>
              </div>
            )}
          </section>

          {/* 3 ─ Pedidos */}
          <section className="card ct-passo">
            <h2 className="card-titulo"><span className="ct-num">3</span> Pedidos — peças por cor</h2>
            <p className="ajuda-bloco ink-soft">Uma linha por cor, uma coluna por cliente. Dois clientes pedindo a mesma cor? A tela soma.</p>
            <div className="tabela-rolagem">
              <table className="ct-pedidos">
                <thead>
                  <tr>
                    <th className="ct-col-cor"><Palette size={13} /> Cor</th>
                    {s.clientes.map((c, j) => (
                      <th key={j}>
                        <div className="ct-th-cli">
                          <input className="ct-input-cli" value={c} maxLength={30} onChange={(e) => mudarCliente(j, e.target.value)} />
                          {s.clientes.length > 1 && (
                            <button type="button" className="ct-x" title="Tirar este cliente" onClick={() => tirarCliente(j)}><X size={11} /></button>
                          )}
                        </div>
                      </th>
                    ))}
                    <th><button type="button" className="btn btn-dashed sm" onClick={addCliente}><Users size={12} /> cliente</button></th>
                    <th className="num">Peças</th>
                    <th className="num">Tecido</th>
                  </tr>
                </thead>
                <tbody>
                  {s.cores.map((c, ci) => {
                    const l = r.linhas[ci];
                    return (
                      <tr key={ci}>
                        <td className="ct-col-cor">
                          <div className="ct-cor">
                            <Swatch hex={c.hex} cor={c.cor} />
                            <input className="ct-input-cor" value={c.cor} placeholder="Nome da cor" maxLength={40} onChange={(e) => mudarCor(ci, { cor: e.target.value })} />
                            <button type="button" className="ct-x" title="Tirar esta cor" onClick={() => tirarCor(ci)}><X size={11} /></button>
                          </div>
                        </td>
                        {c.qtds.map((q, j) => (
                          <td key={j}><NumInput value={q} onChange={(v) => mudarQtd(ci, j, v)} step="1" min={0} placeholder="0" /></td>
                        ))}
                        <td />
                        <td className="num"><b>{l?.pecas ? fmtInt(l.pecas) : '—'}</b></td>
                        <td className="num"><b>{l?.pecas ? `${fmt(l.tecido, u.casas)} ${u.resultado}` : '—'}</b></td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td>
                      <form className="ct-add-cor" onSubmit={(e) => { e.preventDefault(); addCor(novaCor.trim()); setNovaCor(''); }}>
                        <input value={novaCor} placeholder="+ nova cor" maxLength={40} onChange={(e) => setNovaCor(e.target.value)} />
                        <button type="submit" className="btn btn-dashed sm" title="Acrescentar cor"><Plus size={12} /></button>
                      </form>
                    </td>
                    {r.porCliente.map((q, j) => <td key={j} className="num">{q ? fmtInt(q) : '—'}</td>)}
                    <td />
                    <td className="num"><b>{fmtInt(r.totalPecas)}</b></td>
                    <td className="num"><b>{fmt(r.totalTecido, u.casas)} {u.resultado}</b></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </div>

        {/* Resultado — é o que imprime */}
        <aside className="ct-resultado">
          <div className="card ct-total">
            <div className="print-only ct-print-topo">
              <b>{s.referencia || 'Pedido'}</b>{s.descricao ? ` · ${s.descricao}` : ''}
              {usaGrade && gradeTexto ? ` · grade ${gradeTexto}` : ''}
            </div>
            <span className="ct-total-rot">Preciso de</span>
            <span className="ct-total-num">{fmt(r.totalTecido, u.casas)} <small>{u.resultado}</small></span>
            <span className="ct-total-sub">
              de tecido para <b>{fmtInt(r.totalPecas)}</b> peças{s.referencia ? <> da <b>{s.referencia}</b></> : ''}
              {Number(s.perdaPct) > 0 ? ` · já com ${fmt(s.perdaPct, 1)}% de perda` : ''}
            </span>
            {r.totalPecas > 0 && r.totalTecido > 0 && (
              <div className="ct-rendimento">
                <span><small>média por peça</small><b>{fmt(r.totalTecido * UNIDADES[s.unidade].divisor / r.totalPecas, s.unidade === 'kg' ? 0 : 3)} {u.porPeca}</b></span>
                <span><small>rendimento</small><b>1 {u.resultado} ≈ {fmt(r.rendimento, 1)} peças</b></span>
              </div>
            )}

            {r.pendencias.length > 0 && r.totalPecas > 0 && (
              <div className="ct-pendencias">
                {r.pendencias.map((p) => <p key={p}><AlertTriangle size={13} /> {p}</p>)}
              </div>
            )}

            {r.totalPecas === 0 ? (
              <p className="ink-soft ct-vazio">Digite as quantidades no passo 3 e o resultado aparece aqui.</p>
            ) : (
              <ul className="ct-por-cor">
                {r.linhas.filter((l) => l.pecas > 0).map((l, i) => (
                  <li key={`${l.cor}-${i}`}>
                    <div className="ct-por-cor-topo">
                      <span><Swatch hex={l.hex} cor={l.cor} />{l.cor}</span>
                      <b>{fmt(l.tecido, u.casas)} {u.resultado}</b>
                    </div>
                    <div className="ct-barra"><span style={{ width: `${maiorCor > 0 ? Math.max(3, (l.tecido / maiorCor) * 100) : 0}%` }} /></div>
                    <small className="ink-soft">{fmtInt(l.pecas)} peças</small>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {usaGrade && r.totalPecas > 0 && somaGrade > 0 && (
            <div className="card ct-corte">
              <h2 className="card-titulo"><Scissors size={15} /> Peças por tamanho <small className="ink-soft">para o corte</small></h2>
              <div className="tabela-rolagem">
                <table className="tabela-nota tabela-estreita ct-corte-tab">
                  <thead>
                    <tr>
                      <th>Cor</th>
                      {s.tamanhos.map((t, i) => (Number(t.grade) > 0 ? <th key={i} className="num">{t.tamanho || '?'}</th> : null))}
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.linhas.filter((l) => l.pecas > 0).map((l, i) => (
                      <tr key={`${l.cor}-${i}`}>
                        <td><Swatch hex={l.hex} cor={l.cor} />{l.cor}</td>
                        {s.tamanhos.map((t, k) => (Number(t.grade) > 0 ? <td key={k} className="num">{fmtInt(l.porTamanho[k])}</td> : null))}
                        <td className="num"><b>{fmtInt(l.pecas)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      {s.tamanhos.map((t, k) => (Number(t.grade) > 0 ? <td key={k} className="num">{fmtInt(r.porTamanhoTotal[k])}</td> : null))}
                      <td className="num"><b>{fmtInt(r.totalPecas)}</b></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="ajuda-bloco ink-soft">
                Quando a conta não fecha exata, a peça que sobra vai para o tamanho mais perto de
                ganhar mais uma. O total sempre bate com o pedido.
              </p>
            </div>
          )}

          <details className="ct-como no-print">
            <summary>Como esta tela calcula</summary>
            <p>
              <b>Por tamanho:</b> as peças de cada cor são repartidas pela grade e cada tamanho é
              multiplicado pelo que a peça dele gasta. <b>Igual p/ todos:</b> peças × consumo único.
              Em quilo o consumo é digitado em gramas e o total é dividido por 1.000. A perda entra
              uma vez só, sobre o total de cada cor.
            </p>
            <p>
              Nada aqui é gravado no sistema — é uma calculadora. O que você digitou fica guardado só
              neste navegador até clicar em <b>Começar de novo</b>. A exceção é o botão
              <b> Guardar consumo na ficha</b>, que grava o consumo por tamanho no produto.
            </p>
          </details>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ficha → campos da tela
// ---------------------------------------------------------------------------
function unidadeDoMaterial(m) {
  const bruto = String(m?.unidade_consumo || m?.unidade || '').trim().toLowerCase();
  if (['kg', 'kgs', 'quilo', 'quilos'].includes(bruto)) return 'kg';
  if (['m', 'mt', 'mts', 'metro', 'metros'].includes(bruto)) return 'm';
  return bruto || null;
}

// Consumo na ficha está na unidade de CONSUMO do insumo: kg (0,19) ou m
// (1,25). A tela mostra kg em GRAMAS, por isso o × 1000.
function preencherDaFicha(tamanhos, material, consumo) {
  const vazio = { tamanhos, consumoUnico: { kg: '', m: '' }, unidade: null, perdaPct: null, veioConsumo: false };
  if (!material) return vazio;
  const un = unidadeDoMaterial(material);
  if (un !== 'kg' && un !== 'm') return vazio;
  const escala = un === 'kg' ? 1000 : 1;
  const arred = (v) => (un === 'kg' ? Math.round(v * escala * 10) / 10 : Math.round(v * 10000) / 10000);
  const porTamanho = new Map(
    (consumo?.consumos || [])
      .filter((c) => String(c.material_id) === String(material.id))
      .map((c) => [String(c.tamanho), Number(c.consumo_por_peca)])
  );
  const geral = Number(material.consumo_por_peca);
  const temGeral = Number.isFinite(geral) && geral > 0;
  let veio = false;
  const novos = tamanhos.map((t) => {
    const v = porTamanho.has(String(t.tamanho)) ? porTamanho.get(String(t.tamanho)) : (temGeral ? geral : null);
    if (v == null || !(v > 0)) return t;
    veio = true;
    return { ...t, consumo: { ...t.consumo, [un]: arred(v) } };
  });
  const perda = Number(material.perda_pct);
  return {
    tamanhos: novos,
    consumoUnico: { kg: '', m: '', [un]: temGeral ? arred(geral) : '' },
    unidade: un,
    perdaPct: Number.isFinite(perda) && perda > 0 ? Math.round(perda * 1000) / 10 : null,
    veioConsumo: veio || temGeral,
  };
}
