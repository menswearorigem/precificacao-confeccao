import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Factory, Layers, X, Plus, Check, Scissors, AlertTriangle, Info, Package,
  CalendarDays, Trash2, PackageX,
} from 'lucide-react';
import { api } from '../api/client';
import { Field, Select, NumInput, Checkbox, DateInput, IndicadorDestaque } from './ui';
import { brl, formatQtd, numeroBr } from '../lib/format';

// NOVA ORDEM DE PRODUÇÃO — de um produto ou de um KIT.
//
// O que mudou em relação à versão anterior desta tela, e por quê:
//
// 1. A GRADE NÃO É MAIS DIGITADA. Escolhida a referência, a tela desenha a
//    matriz cor × tamanho que está no cadastro do produto e pede só as
//    quantidades. Antes, cada linha era um par de campos de texto livre — e é
//    assim que "Azul" e "Azl" viram duas cores, e que uma OP sai com um tamanho
//    que a referência não tem.
//
// 2. INSUMO GASTO PODE SER LANÇADO E CORRIGIDO. A ficha explode o previsto; o
//    que se gastou de verdade entra aqui, e o custo previsto da ordem muda na
//    hora.
//
// 3. MATERIAL INSUFICIENTE AVISA, EM CIMA, E NÃO TRAVA. A casa produz com
//    material chegando no mesmo dia; travar faria alguém mentir a quantidade
//    para conseguir abrir a ordem — que é pior que abrir sabendo.
//
// 4. DATA DE INÍCIO E DATA DE CHEGADA. Com as duas, a ordem entra sozinha no
//    calendário como um período, e não como um ponto no dia da entrega.
//
// 5. ORDEM DE KIT. Uma referência de cada vez, as cores dentro daquela
//    referência, as quantidades — nessa ordem, que é a que o dono descreveu.
//    Cada referência do kit vira uma ordem de produção completa.

const chave = (cor, tamanho) => `${cor || ''}|${tamanho || ''}`;

// ---------------------------------------------------------------------------
// A matriz de uma referência: cores nas linhas, tamanhos nas colunas
// ---------------------------------------------------------------------------
function MatrizGrade({ grade, quantidades, onAlterar, onPreencherLinha }) {
  if (!grade) return null;
  if (!grade.matriz || grade.matriz.linhas.length === 0) {
    return (
      <p className="aviso-inline">
        <AlertTriangle size={14} /> Esta referência não tem cores nem grade cadastradas. Cadastre em
        Produtos › ficha da referência › Cores e grade — sem isso a ordem não sabe por qual linha
        dar entrada das peças no fim.
      </p>
    );
  }

  const total = Object.values(quantidades).reduce((s, q) => s + (Number(q) || 0), 0);

  return (
    <>
      {(grade.avisos || []).map((a, i) => (
        <p key={i} className="aviso-inline"><Info size={14} /> {a}</p>
      ))}
      <div className="tabela-rolagem">
        <table className="tabela-nota grade-matriz">
          <thead>
            <tr>
              <th>Cor</th>
              {grade.matriz.tamanhos.map((t) => <th key={t} className="num">{t || '—'}</th>)}
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {grade.matriz.linhas.map((linha) => {
              const somaLinha = linha.celulas.reduce(
                (s, c) => s + (Number(quantidades[chave(c.cor, c.tamanho)]) || 0), 0
              );
              return (
                <tr key={linha.cor}>
                  <td>
                    <span className="grade-bolinha" style={{ background: linha.hex || 'var(--border)' }} />
                    {linha.cor || '—'}
                  </td>
                  {linha.celulas.map((c) => (
                    <td key={chave(c.cor, c.tamanho)} className="num">
                      <NumInput
                        step="1"
                        value={quantidades[chave(c.cor, c.tamanho)] ?? ''}
                        onChange={(v) => onAlterar(c, v)}
                      />
                    </td>
                  ))}
                  <td className="num"><strong>{formatQtd(somaLinha)}</strong></td>
                  <td>
                    <button
                      type="button" className="btn-sec btn-mini"
                      title="Repete em todos os tamanhos desta cor a primeira quantidade preenchida na linha."
                      onClick={() => onPreencherLinha(linha)}
                    >= </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Total</strong></td>
              {grade.matriz.tamanhos.map((t) => {
                const soma = grade.matriz.linhas.reduce(
                  (s, l) => s + (Number(quantidades[chave(l.cor, t)]) || 0), 0
                );
                return <td key={t} className="num">{soma > 0 ? formatQtd(soma) : ''}</td>;
              })}
              <td className="num"><strong>{formatQtd(total)}</strong></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// O aviso de material insuficiente — pop-up, e só aviso
// ---------------------------------------------------------------------------
function AvisoInsumoInsuficiente({ previa, onFechar }) {
  return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel" role="alertdialog" aria-modal="true" style={{ zIndex: 1200 }}>
      <div className="anuncio-painel">
        <header className="anuncio-painel-topo">
          <h2><PackageX size={18} /> Material insuficiente</h2>
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </header>
        <div className="anuncio-painel-corpo">
          <p>
            O saldo próprio de hoje não cobre esta ordem. <strong>Isto é só um aviso</strong> — dá para
            abrir a ordem assim mesmo, que é o normal quando o material está a caminho.
          </p>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Insumo</th><th className="num">Precisa</th><th className="num">Tem</th>
                  <th className="num">Falta</th><th className="num">Sai até</th>
                </tr>
              </thead>
              <tbody>
                {previa.faltas.map((f) => (
                  <tr key={f.insumoId}>
                    <td>{f.insumo}</td>
                    <td className="num">{numeroBr(f.necessidade, 3)} {f.unidade}</td>
                    <td className="num">{numeroBr(f.saldo, 3)}</td>
                    <td className="num ink-prejuizo">{numeroBr(f.falta, 3)}</td>
                    <td className="num">{f.pecasPossiveis != null ? `${formatQtd(f.pecasPossiveis)} peças` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ink-soft ajuda-bloco">
            Com o material que existe hoje, esta ordem sai até{' '}
            <strong>{formatQtd(previa.resumo.pecasPossiveis)}</strong> peça(s) de{' '}
            {formatQtd(previa.resumo.totalPecas)}. Reservar o material na abertura pega o que houver
            e deixa a falta à vista — não cria saldo negativo.
          </p>
        </div>
        <footer className="painel-rodape">
          <button type="button" className="btn" onClick={onFechar}>Entendi</button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Insumos: o previsto pela ficha e o que foi gasto de verdade
// ---------------------------------------------------------------------------
function BlocoInsumos({ previa, insumosCatalogo, extras, onExtras }) {
  const [novo, setNovo] = useState({ insumo_id: '', quantidade: '', custo_unitario: '' });

  return (
    <>
      <h3 className="card-titulo"><Package size={16} /> Material gasto</h3>
      <p className="ink-soft ajuda-bloco">
        A ficha explode o previsto. O que se gastou de verdade entra aqui — e o custo previsto da
        ordem muda junto. Corrigir a quantidade aqui <strong>não</strong> mexe no que já foi
        reservado: reserva é movimento de estoque e se desfaz por movimento de estoque.
      </p>

      <div className="tabela-rolagem">
        <table className="tabela-nota">
          <thead>
            <tr>
              <th>Insumo</th><th>Origem</th><th className="num">Necessidade</th>
              <th className="num">Saldo</th><th className="num">Falta</th>
              <th className="num">Custo unit.</th><th className="num">Custo previsto</th><th />
            </tr>
          </thead>
          <tbody>
            {previa.insumos.map((i) => {
              const manual = i.origemLancamento === 'manual';
              return (
                <tr key={`${i.insumoId}-${i.materialId || 'manual'}`}>
                  <td>
                    {i.insumoNome || i.material}
                    {manual && <span className="selo tone-elevada" title="Lançado à mão nesta ordem.">à mão</span>}
                    {i.perdaNaoCadastrada && !manual && (
                      <span className="selo tone-atencao" title="Sem perda de corte cadastrada: a necessidade está subestimada.">sem perda</span>
                    )}
                  </td>
                  <td>
                    <span className={`selo ${i.origemConsumo === 'por_tamanho' ? 'tone-saudavel' : i.origemConsumo === 'manual' ? 'tone-elevada' : 'tone-atencao'}`}>
                      {i.origemConsumo === 'por_tamanho' ? 'por tamanho' : i.origemConsumo === 'manual' ? 'digitado' : 'valor único'}
                    </span>
                  </td>
                  <td className="num">{numeroBr(i.necessidade, 3)} {i.unidade || ''}</td>
                  <td className="num">{numeroBr(i.saldoDisponivel, 3)}</td>
                  <td className={`num ${i.falta > 0 ? 'ink-prejuizo' : ''}`}>{i.falta > 0 ? numeroBr(i.falta, 3) : '—'}</td>
                  <td className="num">{i.custoUnitario != null ? brl(i.custoUnitario) : <span className="selo tone-atencao">sem custo</span>}</td>
                  <td className="num">{i.semCusto ? '—' : brl(i.custoPrevisto)}</td>
                  <td>
                    {manual && (
                      <button
                        type="button" className="btn-icone" aria-label="Tirar da ordem"
                        onClick={() => onExtras(extras.filter((e) => Number(e.insumo_id) !== Number(i.insumoId)))}
                      ><Trash2 size={14} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="form-linha">
        <Field label="Acrescentar insumo gasto">
          <Select
            value={novo.insumo_id}
            onChange={(e) => setNovo((n) => ({ ...n, insumo_id: e.target.value }))}
            placeholder="Escolha o insumo"
          >
            {insumosCatalogo.map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
          </Select>
        </Field>
        <Field label="Quantidade">
          <NumInput step="0.001" value={novo.quantidade} onChange={(v) => setNovo((n) => ({ ...n, quantidade: v }))} />
        </Field>
        <Field label="Custo unitário" hint="Em branco usa o custo cadastrado do insumo.">
          <NumInput value={novo.custo_unitario} onChange={(v) => setNovo((n) => ({ ...n, custo_unitario: v }))} />
        </Field>
      </div>
      <div className="painel-acoes-inline">
        <button
          type="button" className="btn-sec"
          disabled={!novo.insumo_id || !(Number(novo.quantidade) > 0)}
          onClick={() => {
            onExtras([
              ...extras.filter((e) => Number(e.insumo_id) !== Number(novo.insumo_id)),
              { ...novo, insumo_id: Number(novo.insumo_id), quantidade: Number(novo.quantidade) },
            ]);
            setNovo({ insumo_id: '', quantidade: '', custo_unitario: '' });
          }}
        ><Plus size={15} /> Lançar insumo</button>
        <span className="ink-soft">
          Insumo que a ficha já previa e você lançar aqui tem a quantidade <strong>substituída</strong>,
          não somada — somar reservaria o dobro.
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------
export default function NovaOrdemProducao({
  produtos, faccoes, insumos, kits = [], onFechar, onCriada, onNovaFaccao,
}) {
  const [tipo, setTipo] = useState('produto');

  // Cabeçalho comum às duas formas.
  const [nomeKit, setNomeKit] = useState('');
  const [kitId, setKitId] = useState('');
  const [quantidadeKits, setQuantidadeKits] = useState('');
  const [fornecedorId, setFornecedorId] = useState('');
  const [dataInicio, setDataInicio] = useState(new Date().toISOString().slice(0, 10));
  const [dataPrevista, setDataPrevista] = useState('');
  const [observacoes, setObservacoes] = useState('');

  // Produto único.
  const [produtoId, setProdutoId] = useState('');
  const [grade, setGrade] = useState(null);
  const [quantidades, setQuantidades] = useState({});
  const [extras, setExtras] = useState([]);

  // Kit: uma linha por referência.
  const [componentes, setComponentes] = useState([]);

  const [previa, setPrevia] = useState(null);
  const [mostrarFalta, setMostrarFalta] = useState(false);
  const [carregandoPrevia, setCarregandoPrevia] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aceitarIncompleta, setAceitarIncompleta] = useState(false);

  // ---- grade do produto único
  useEffect(() => {
    if (tipo !== 'produto' || !produtoId) { setGrade(null); return; }
    setPrevia(null);
    api.get(`/producao/produto-grade/${produtoId}`)
      .then((r) => { setGrade(r); setQuantidades({}); })
      .catch((e) => setErro(e.message));
  }, [produtoId, tipo]);

  const linhasDeGrade = useCallback((quantidadesDe, gradeDe) => {
    if (!gradeDe?.matriz) return [];
    const linhas = [];
    for (const l of gradeDe.matriz.linhas) {
      for (const c of l.celulas) {
        const q = Number(quantidadesDe[chave(c.cor, c.tamanho)]) || 0;
        if (q > 0) linhas.push({ cor: c.cor, tamanho: c.tamanho, variante_id: c.variante_id, quantidade_planejada: q });
      }
    }
    return linhas;
  }, []);

  const gradeProduto = useMemo(() => linhasDeGrade(quantidades, grade), [quantidades, grade, linhasDeGrade]);

  function preencherLinha(linha, quantidadesDe, setQuantidadesDe) {
    const primeira = linha.celulas
      .map((c) => Number(quantidadesDe[chave(c.cor, c.tamanho)]))
      .find((v) => v > 0);
    if (!primeira) return;
    setQuantidadesDe((atual) => {
      const novo = { ...atual };
      for (const c of linha.celulas) novo[chave(c.cor, c.tamanho)] = primeira;
      return novo;
    });
  }

  // ---- componentes do kit
  async function acrescentarComponente(idProduto) {
    if (!idProduto) return;
    if (componentes.some((c) => String(c.produto_id) === String(idProduto))) {
      setErro('Esta referência já está no kit. Ponha todas as cores dela na mesma linha — '
        + 'duas ordens da mesma referência dariam duas entradas separadas no estoque.');
      return;
    }
    setErro('');
    try {
      const g = await api.get(`/producao/produto-grade/${idProduto}`);
      const p = produtos.find((x) => String(x.id) === String(idProduto));
      setComponentes((atual) => [...atual, {
        produto_id: Number(idProduto),
        referencia: p?.referencia || '',
        descricao: p?.descricao || '',
        grade: g,
        quantidades: {},
      }]);
      setPrevia(null);
    } catch (e) { setErro(e.message); }
  }

  const totalKit = componentes.reduce(
    (s, c) => s + linhasDeGrade(c.quantidades, c.grade).reduce((t, l) => t + l.quantidade_planejada, 0), 0
  );

  const prontoParaPrevia = tipo === 'produto'
    ? (!!produtoId && gradeProduto.length > 0)
    : componentes.some((c) => linhasDeGrade(c.quantidades, c.grade).length > 0);

  async function pedirPrevia() {
    setErro('');
    setCarregandoPrevia(true);
    try {
      if (tipo === 'produto') {
        const r = await api.post('/producao/ordens/previa', {
          produto_id: Number(produtoId), grade: gradeProduto, insumos_extra: extras,
        });
        setPrevia(r);
        if (!r.materialSuficiente) setMostrarFalta(true);
      } else {
        // No kit, cada referência é explodida por si. A tela soma as prévias
        // para mostrar um número só, mas guarda cada uma: é por referência que
        // o material falta, e juntar tudo esconderia qual delas trava.
        const partes = [];
        for (const c of componentes) {
          const linhas = linhasDeGrade(c.quantidades, c.grade);
          if (linhas.length === 0) continue;
          const r = await api.post('/producao/ordens/previa', {
            produto_id: c.produto_id, grade: linhas, insumos_extra: c.extras || [],
          });
          partes.push({ referencia: c.referencia, ...r });
        }
        const juntas = {
          porReferencia: partes,
          insumos: partes.flatMap((p) => p.insumos.map((i) => ({ ...i, referencia: p.referencia }))),
          pendencias: partes.flatMap((p) => p.pendencias),
          faltas: partes.flatMap((p) => p.faltas.map((f) => ({ ...f, insumo: `${f.insumo} (${p.referencia})` }))),
          materialSuficiente: partes.every((p) => p.materialSuficiente),
          resumo: {
            totalPecas: partes.reduce((s, p) => s + p.resumo.totalPecas, 0),
            custoMaterialPrevisto: partes.reduce((s, p) => s + (p.resumo.custoMaterialPrevisto || 0), 0),
            custoMaterialPorPeca: null,
            insumosSemCusto: partes.reduce((s, p) => s + p.resumo.insumosSemCusto, 0),
            insumosFaltando: partes.reduce((s, p) => s + p.resumo.insumosFaltando, 0),
            pecasPossiveis: partes.reduce((s, p) => s + (p.resumo.pecasPossiveis || 0), 0),
          },
          avisos: [...new Set(partes.flatMap((p) => p.avisos))],
        };
        juntas.resumo.custoMaterialPorPeca = juntas.resumo.totalPecas > 0
          ? juntas.resumo.custoMaterialPrevisto / juntas.resumo.totalPecas : null;
        setPrevia(juntas);
        if (!juntas.materialSuficiente) setMostrarFalta(true);
      }
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoPrevia(false);
    }
  }

  async function abrir(situacao) {
    setErro('');
    setSalvando(true);
    try {
      const comum = {
        confirmar: true,
        aceitar_ficha_incompleta: aceitarIncompleta,
        fornecedor_id: fornecedorId ? Number(fornecedorId) : null,
        data_inicio: dataInicio || null,
        data_prevista: dataPrevista || null,
        observacoes: observacoes || null,
        situacao,
      };
      const r = tipo === 'produto'
        ? await api.post('/producao/ordens', {
          ...comum, produto_id: Number(produtoId), grade: gradeProduto, insumos_extra: extras,
        })
        : await api.post('/producao/ordens', {
          ...comum,
          tipo: 'kit',
          nome: nomeKit || null,
          kit_id: kitId ? Number(kitId) : null,
          quantidade_kits: quantidadeKits === '' ? null : Number(quantidadeKits),
          componentes: componentes
            .map((c) => ({
              produto_id: c.produto_id,
              grade: linhasDeGrade(c.quantidades, c.grade),
              insumos_extra: c.extras || [],
            }))
            .filter((c) => c.grade.length > 0),
        });
      onCriada(r);
    } catch (e) {
      setErro(e.message);
      if (e.data?.exige === 'aceitar_ficha_incompleta') setAceitarIncompleta(false);
    } finally {
      setSalvando(false);
    }
  }

  const pendenciasGraves = (previa?.pendencias || []).filter((p) => p.grave);
  const semPrazo = !dataPrevista;

  return (
    <>
      {mostrarFalta && previa && (
        <AvisoInsumoInsuficiente previa={previa} onFechar={() => setMostrarFalta(false)} />
      )}

      <div className="anuncio-painel-fundo painel-fundo-clicavel" role="dialog" aria-modal="true">
        <div className="anuncio-painel painel-largo">
          <header className="anuncio-painel-topo">
            <h2>
              {tipo === 'kit' ? <Layers size={18} /> : <Factory size={18} />}
              Nova ordem de produção
            </h2>
            <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
          </header>

          <div className="anuncio-painel-corpo">
            <div className="subtab-row">
              <button
                type="button" className={`subtab-btn ${tipo === 'produto' ? 'active' : ''}`}
                onClick={() => { setTipo('produto'); setPrevia(null); }}
              >Uma referência</button>
              <button
                type="button" className={`subtab-btn ${tipo === 'kit' ? 'active' : ''}`}
                onClick={() => { setTipo('kit'); setPrevia(null); }}
              >Kit</button>
            </div>

            {/* ---------------- cabeçalho ---------------- */}
            {tipo === 'kit' && (
              <div className="form-linha">
                <Field label="Kit cadastrado" hint="Opcional: traz as referências do kit de uma vez.">
                  <Select
                    value={kitId}
                    placeholder="Montar na hora"
                    onChange={async (e) => {
                      setKitId(e.target.value);
                      const k = kits.find((x) => String(x.id) === String(e.target.value));
                      if (!k) return;
                      setNomeKit((n) => n || k.nome);
                      setComponentes([]);
                      for (const item of k.itens || []) {
                        // eslint-disable-next-line no-await-in-loop
                        await acrescentarComponente(item.produto_id);
                      }
                    }}
                  >
                    {kits.map((k) => <option key={k.id} value={k.id}>{k.nome}</option>)}
                  </Select>
                </Field>
                <Field label="Nome do kit">
                  <input className="input" value={nomeKit} onChange={(e) => setNomeKit(e.target.value)} placeholder="Kit 3 camisetas dryfit" />
                </Field>
                <Field label="Quantos kits" hint="Só informativo: o que a fábrica produz é a peça.">
                  <NumInput step="1" value={quantidadeKits} onChange={setQuantidadeKits} />
                </Field>
              </div>
            )}

            <div className="form-linha">
              {tipo === 'produto' && (
                <Field label="Referência">
                  <Select value={produtoId} onChange={(e) => setProdutoId(e.target.value)} placeholder="Escolha a referência">
                    {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Facção / oficina" hint="Opcional. Quem vai costurar, quando não é interno.">
                <Select value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)} placeholder="Produção interna">
                  {faccoes.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.nome}{f.categoria_nome ? ` · ${f.categoria_nome}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Início">
                <DateInput value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
              </Field>
              <Field label="Chegada prevista" hint="É ela que coloca a ordem no calendário.">
                <DateInput value={dataPrevista} onChange={(e) => setDataPrevista(e.target.value)} />
              </Field>
            </div>

            <p className={semPrazo ? 'aviso-inline' : 'ink-soft ajuda-bloco'}>
              <CalendarDays size={14} />{' '}
              {semPrazo
                ? 'Sem chegada prevista, a ordem NÃO entra no calendário — e sem prazo prometido não existe atraso para medir. Dá para abrir assim e preencher depois.'
                : 'Com início e chegada preenchidos, esta ordem entra no calendário sozinha, como um período, e a grade dela vai junto.'}
            </p>

            {/* ---------------- grade ---------------- */}
            {tipo === 'produto' && (
              <>
                <h3 className="card-titulo"><Layers size={16} /> Grade</h3>
                <p className="ink-soft ajuda-bloco">
                  As cores e os tamanhos são os do cadastro da referência. Preencha as quantidades —
                  é por linha da grade que a peça entra no estoque no fim.
                </p>
                <MatrizGrade
                  grade={grade}
                  quantidades={quantidades}
                  onAlterar={(c, v) => { setQuantidades((q) => ({ ...q, [chave(c.cor, c.tamanho)]: v })); setPrevia(null); }}
                  onPreencherLinha={(l) => preencherLinha(l, quantidades, setQuantidades)}
                />
              </>
            )}

            {tipo === 'kit' && (
              <>
                <h3 className="card-titulo"><Layers size={16} /> Referências do kit</h3>
                <p className="ink-soft ajuda-bloco">
                  Uma referência de cada vez: escolha a referência, marque as cores dentro dela e as
                  quantidades. Cada referência vira uma ordem de produção completa, com roteiro,
                  material, movimentação e ordem de serviço — a ordem do kit é o documento que
                  responde se ele está pronto.
                </p>

                <div className="form-linha">
                  <Field label="Acrescentar referência">
                    <Select
                      value=""
                      placeholder="Escolha a referência"
                      onChange={(e) => acrescentarComponente(e.target.value)}
                    >
                      {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
                    </Select>
                  </Field>
                </div>

                {componentes.map((c, idx) => (
                  <div className="card" key={c.produto_id} style={{ marginTop: 10 }}>
                    <div className="card-head-linha">
                      <h3 className="card-titulo">{c.referencia} <span className="ink-soft">{c.descricao}</span></h3>
                      <button
                        type="button" className="btn-icone" aria-label={`Tirar ${c.referencia} do kit`}
                        onClick={() => { setComponentes((l) => l.filter((_, i) => i !== idx)); setPrevia(null); }}
                      ><X size={16} /></button>
                    </div>
                    <MatrizGrade
                      grade={c.grade}
                      quantidades={c.quantidades}
                      onAlterar={(cel, v) => {
                        setComponentes((l) => l.map((x, i) => (i === idx
                          ? { ...x, quantidades: { ...x.quantidades, [chave(cel.cor, cel.tamanho)]: v } }
                          : x)));
                        setPrevia(null);
                      }}
                      onPreencherLinha={(linha) => {
                        setComponentes((l) => l.map((x, i) => {
                          if (i !== idx) return x;
                          const primeira = linha.celulas
                            .map((cel) => Number(x.quantidades[chave(cel.cor, cel.tamanho)]))
                            .find((v) => v > 0);
                          if (!primeira) return x;
                          const novo = { ...x.quantidades };
                          for (const cel of linha.celulas) novo[chave(cel.cor, cel.tamanho)] = primeira;
                          return { ...x, quantidades: novo };
                        }));
                        setPrevia(null);
                      }}
                    />
                  </div>
                ))}

                {componentes.length > 0 && (
                  <p className="ink-soft ajuda-bloco">
                    Total do kit: <strong>{formatQtd(totalKit)}</strong> peça(s) em{' '}
                    {componentes.length} referência(s).
                  </p>
                )}
              </>
            )}

            <div className="painel-acoes-inline">
              <button
                type="button" className="btn-sec"
                disabled={!prontoParaPrevia || carregandoPrevia}
                onClick={pedirPrevia}
              >
                <Scissors size={15} className={carregandoPrevia ? 'girando' : ''} /> Ver o que a ficha vai consumir
              </button>
              {onNovaFaccao && (
                <button type="button" className="btn-sec" onClick={onNovaFaccao}>
                  <Plus size={15} /> Nova facção
                </button>
              )}
            </div>

            {/* ---------------- prévia ---------------- */}
            {previa && (
              <div className="previa-explosao card">
                <h3 className="card-titulo"><Scissors size={16} /> Explosão da ficha</h3>

                <div className="indicadores-linha">
                  <IndicadorDestaque rotulo="Peças" valor={formatQtd(previa.resumo.totalPecas)} />
                  <IndicadorDestaque
                    rotulo="Material previsto"
                    valor={previa.resumo.insumosSemCusto > 0
                      ? `${brl(previa.resumo.custoMaterialPrevisto)} (incompleto)`
                      : brl(previa.resumo.custoMaterialPrevisto)}
                    tom={previa.resumo.insumosSemCusto > 0 ? 'atencao' : undefined}
                    explicacao={previa.resumo.insumosSemCusto > 0
                      ? 'Há insumo sem custo conhecido nesta ordem. O total está incompleto — não é o custo real.'
                      : undefined}
                  />
                  <IndicadorDestaque
                    rotulo="Por peça"
                    valor={previa.resumo.custoMaterialPorPeca != null ? brl(previa.resumo.custoMaterialPorPeca) : '—'}
                  />
                  <IndicadorDestaque
                    rotulo="Insumos faltando"
                    valor={formatQtd(previa.resumo.insumosFaltando)}
                    tom={previa.resumo.insumosFaltando > 0 ? 'prejuizo' : undefined}
                    explicacao="Insumos com saldo próprio menor que a necessidade desta ordem. É aviso, não trava."
                  />
                </div>

                {!previa.materialSuficiente && (
                  <p className="aviso-inline">
                    <AlertTriangle size={14} /> Material insuficiente para a ordem inteira.{' '}
                    <button type="button" className="botao-link" onClick={() => setMostrarFalta(true)}>
                      Ver o que falta
                    </button>
                  </p>
                )}
                {(previa.avisos || []).map((a, i) => (
                  <p key={i} className="aviso-inline"><AlertTriangle size={14} /> {a}</p>
                ))}

                {tipo === 'produto' ? (
                  <BlocoInsumos
                    previa={previa} insumosCatalogo={insumos} extras={extras}
                    onExtras={(l) => { setExtras(l); setPrevia(null); }}
                  />
                ) : (
                  <div className="tabela-rolagem">
                    <table className="tabela-nota">
                      <thead>
                        <tr><th>Referência</th><th>Insumo</th><th className="num">Necessidade</th><th className="num">Falta</th><th className="num">Custo previsto</th></tr>
                      </thead>
                      <tbody>
                        {previa.insumos.map((i, n) => (
                          <tr key={`${i.referencia}-${i.insumoId}-${n}`}>
                            <td>{i.referencia}</td>
                            <td>{i.insumoNome || i.material}</td>
                            <td className="num">{numeroBr(i.necessidade, 3)} {i.unidade || ''}</td>
                            <td className={`num ${i.falta > 0 ? 'ink-prejuizo' : ''}`}>{i.falta > 0 ? numeroBr(i.falta, 3) : '—'}</td>
                            <td className="num">{i.semCusto ? <span className="selo tone-atencao">sem custo</span> : brl(i.custoPrevisto)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {pendenciasGraves.length > 0 && (
                  <div className="bloco-alerta">
                    <p><AlertTriangle size={15} /> <strong>A ficha está incompleta para esta grade.</strong></p>
                    <ul>
                      {pendenciasGraves.map((p, i) => <li key={i}>{p.material || p.insumo}: {p.motivo}</li>)}
                    </ul>
                    <label className="check-linha">
                      <Checkbox checked={aceitarIncompleta} onChange={(e) => setAceitarIncompleta(e.target.checked)} />
                      Abrir mesmo assim. Eu sei que o material desses tamanhos ficou de fora da conta.
                    </label>
                  </div>
                )}
              </div>
            )}

            <Field label="Observações">
              <textarea className="input" rows={2} value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
            </Field>

            {erro && <p className="erro-inline">{erro}</p>}
          </div>

          <footer className="painel-rodape">
            <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
            <button
              type="button" className="btn-sec"
              disabled={!previa || salvando || (pendenciasGraves.length > 0 && !aceitarIncompleta)}
              onClick={() => abrir('rascunho')}
            >Salvar como rascunho</button>
            <button
              type="button" className="btn"
              disabled={!previa || salvando || (pendenciasGraves.length > 0 && !aceitarIncompleta)}
              onClick={() => abrir('planejada')}
            ><Check size={15} /> Abrir a ordem</button>
          </footer>
        </div>
      </div>
    </>
  );
}
