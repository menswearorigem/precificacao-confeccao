import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardList, RefreshCw, AlertTriangle, Check, X, Truck,
  ReceiptText, PackageCheck, Info,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Select, Skeleton, CampoBusca, ChipsFiltros, IndicadorDestaque,
  Paginacao, NumInput, Field, Checkbox, DateInput,
} from '../components/ui';
import { useTabela } from '../lib/useTabela';
import SeloFinanceiro, { useSelosFinanceiros } from '../components/SeloFinanceiro';
import { brl, pct, formatQtd, dataBr } from '../lib/format';

// Produção › Ordens de Serviço de facção.
//
// A O.S. é o documento que vai junto com a mercadoria: o que a facção tem que
// fazer, por quanto e até quando. Ela nasce sozinha quando alguém movimenta
// peça para uma etapa externa.
//
// O número que esta tela existe para mostrar é a QUEBRA: remetido menos o que
// voltou bom, menos a segunda qualidade, menos a perda declarada. O que sobra
// é peça que sumiu — e é onde o dinheiro some sem ninguém perceber, porque
// hoje essa conta não é feita em lugar nenhum.
//
// REGRA 1: nada aqui mexe em preço de venda, margem ou markup. O valor do
// serviço é o preço CONGELADO na remessa × o que voltou bom.
//
// REGRA 2: o que não dá para calcular aparece escrito. O.S. sem preço de
// serviço mostra "—" no valor, não R$ 0,00; O.S. sem previsão de retorno
// mostra "sem prazo", não zero dia de atraso.

const ROTA = '/producao-movimentacao';

const SITUACAO = {
  aberta: { rotulo: 'Aberta', tom: 'tone-neutro' },
  remetida: { rotulo: 'Remetida', tom: 'tone-atencao' },
  parcial: { rotulo: 'Parcial', tom: 'tone-atencao' },
  concluida: { rotulo: 'Concluída', tom: 'tone-saudavel' },
  cancelada: { rotulo: 'Cancelada', tom: 'tone-prejuizo' },
};

function SeloSituacao({ situacao }) {
  const s = SITUACAO[situacao] || { rotulo: situacao, tom: 'tone-neutro' };
  return <span className={`selo ${s.tom}`}>{s.rotulo}</span>;
}

// ---------------------------------------------------------------------------
// Gerar o título a pagar da facção
// ---------------------------------------------------------------------------
function GerarTitulo({ os, onGerado, onErro }) {
  const [aberto, setAberto] = useState(false);
  const [vencimento, setVencimento] = useState('');
  const [reterInss, setReterInss] = useState(false);
  const [aliquota, setAliquota] = useState(11);
  const [salvando, setSalvando] = useState(false);

  const pecasBoas = Number(os.retornado_bom || 0);
  const valorPorPeca = os.valor_por_peca != null ? Number(os.valor_por_peca) : null;
  const base = valorPorPeca != null ? pecasBoas * valorPorPeca : null;
  const retencao = base != null && reterInss ? base * (Number(aliquota) || 0) / 100 : 0;

  async function gerar() {
    setSalvando(true);
    try {
      const r = await api.post(`${ROTA}/ordens-servico/${os.ordem_servico_id}/gerar-titulo`, {
        data_vencimento: vencimento,
        reter_inss: reterInss,
        aliquota_inss: (Number(aliquota) || 0) / 100,
      });
      setAberto(false);
      await onGerado(r);
    } catch (e) {
      onErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  if (!aberto) {
    return (
      <button type="button" className="btn" onClick={() => setAberto(true)}>
        <ReceiptText size={15} /> Gerar título a pagar
      </button>
    );
  }

  return (
    <div className="card">
      <h3 className="card-titulo"><ReceiptText size={16} /> Título a pagar da facção</h3>

      <div className="indicadores-linha">
        <IndicadorDestaque
          rotulo="Peças boas"
          valor={formatQtd(pecasBoas)}
          explicacao="Só o que voltou BOM é serviço prestado. Segunda qualidade e quebra não entram — se a casa decidir pagar a segunda, isso é negociação e entra como ajuste no título."
        />
        <IndicadorDestaque
          rotulo="Preço por peça"
          valor={valorPorPeca != null ? brl(valorPorPeca) : 'sem preço cadastrado'}
          tom={valorPorPeca == null ? 'atencao' : undefined}
          explicacao={valorPorPeca != null
            ? 'Preço congelado no dia da remessa. Reajuste posterior não reescreve O.S. antiga.'
            : 'Esta O.S. saiu sem preço de serviço. Cadastre o preço da facção antes de gerar o título — não há como apurar o valor.'}
        />
        <IndicadorDestaque
          rotulo="Base do título"
          valor={base != null ? brl(base) : 'não dá para dizer'}
          destaque
          tom={base == null ? 'atencao' : undefined}
          explicacao="Peças boas × preço por peça. É o valor bruto do serviço."
        />
        {reterInss && (
          <IndicadorDestaque
            rotulo="Retenção de INSS"
            valor={base != null ? brl(retencao) : '—'}
            explicacao="Descontada do bruto. A alíquota não é assumida pelo sistema: quem lança diz se retém e quanto, porque a regra depende da empresa, do serviço e do regime da facção."
          />
        )}
      </div>

      <div className="form-linha">
        <Field label="Vencimento" hint="Obrigatório: título sem vencimento não entra no fluxo de caixa.">
          <DateInput value={vencimento} onChange={(e) => setVencimento(e.target.value)} />
        </Field>
        {reterInss && (
          <Field label="Alíquota do INSS (%)">
            <NumInput value={aliquota} onChange={setAliquota} />
          </Field>
        )}
      </div>

      <label className="check-linha">
        <Checkbox checked={reterInss} onChange={(e) => setReterInss(e.target.checked)} />
        Reter INSS nesta nota de serviço (cessão de mão de obra).
      </label>
      <p className="ink-soft ajuda-bloco">
        O sistema não decide sozinho se há retenção: chutar 11% para todo mundo produziria
        guia errada. Marque só quando a sua contabilidade disser que este caso retém.
      </p>

      <div className="painel-acoes-inline">
        <button type="button" className="btn-sec" onClick={() => setAberto(false)}>Cancelar</button>
        <button type="button" className="btn" disabled={!vencimento || salvando || !(base > 0)} onClick={gerar}>
          <Check size={15} /> Gerar o título
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe da O.S.: itens, registro de retorno e título
// ---------------------------------------------------------------------------
function DetalheOS({ ordemServicoId, etapas, onFechar, onMudou }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [retorno, setRetorno] = useState({});
  const [etapaDestino, setEtapaDestino] = useState('');
  const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await api.get(`${ROTA}/ordens-servico/${ordemServicoId}`);
      setDados(r);
      setRetorno({});
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [ordemServicoId]);

  useEffect(() => { carregar(); }, [carregar]);

  function alterar(id, campo, valor) {
    setRetorno((atual) => ({ ...atual, [id]: { ...atual[id], [campo]: valor } }));
  }

  const linhasRetorno = useMemo(() => {
    const lista = [];
    for (const item of dados?.itens || []) {
      const r = retorno[item.id] || {};
      const boa = Number(r.retornada) || 0;
      const segunda = Number(r.segunda) || 0;
      const perdida = Number(r.perdida) || 0;
      if (boa + segunda + perdida <= 0) continue;
      lista.push({
        item, boa, segunda, perdida,
        cor: item.cor, tamanho: item.tamanho,
        excedeu: boa + segunda + perdida > Number(item.pendente),
      });
    }
    return lista;
  }, [dados, retorno]);

  const excedidas = linhasRetorno.filter((l) => l.excedeu);

  async function registrarRetorno() {
    setErro('');
    setAviso('');
    setSalvando(true);
    try {
      const r = await api.post(`${ROTA}/ordens-servico/${ordemServicoId}/retorno`, {
        etapa_destino_id: etapaDestino ? Number(etapaDestino) : null,
        data,
        itens: linhasRetorno.map((l) => ({
          cor: l.cor,
          tamanho: l.tamanho,
          quantidade_retornada: l.boa,
          quantidade_segunda: l.segunda,
          quantidade_perdida: l.perdida,
        })),
      });
      setAviso(
        r.situacao === 'concluida'
          ? 'Retorno registrado e a O.S. foi concluída: tudo que foi remetido já voltou de alguma forma.'
          : 'Retorno registrado. A O.S. continua aberta porque ainda há peça na facção.'
      );
      await carregar();
      onMudou();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return (
      <div className="anuncio-painel-fundo painel-fundo-clicavel">
        <div className="anuncio-painel painel-largo"><Skeleton height={320} /></div>
      </div>
    );
  }

  if (!dados) {
    return (
      <div className="anuncio-painel-fundo painel-fundo-clicavel">
        <div className="anuncio-painel">
          <p className="erro-inline">{erro}</p>
          <button type="button" className="btn-sec" onClick={onFechar}>Fechar</button>
        </div>
      </div>
    );
  }

  const os = dados.ordem_servico;
  const quebra = Number(os.quebra || 0);
  const podeReceber = !['concluida', 'cancelada'].includes(os.situacao);

  return (
    <div className="anuncio-painel-fundo painel-fundo-clicavel" role="dialog" aria-modal="true">
      <div className="anuncio-painel painel-largo">
        <header className="anuncio-painel-topo">
          <h2>
            <ClipboardList size={18} /> O.S. {os.numero} · {os.fornecedor_nome}
            <SeloSituacao situacao={os.situacao} />
          </h2>
          <button type="button" className="btn-icone" onClick={onFechar} aria-label="Fechar"><X size={18} /></button>
        </header>

        <div className="anuncio-painel-corpo">
          <p className="ink-soft">
            {os.etapa_nome} · OP {os.ordem_numero} · {os.produto_referencia}
            {os.produto_descricao ? ` — ${os.produto_descricao}` : ''}
          </p>

          <div className="indicadores-linha">
            <IndicadorDestaque
              rotulo="Remetido"
              valor={formatQtd(os.remetido)}
              explicacao="Quantas peças saíram daqui para esta facção nesta O.S."
            />
            <IndicadorDestaque
              rotulo="Voltou bom"
              valor={formatQtd(os.retornado_bom)}
              explicacao="Peça aprovada. É só sobre ela que se paga serviço."
            />
            <IndicadorDestaque
              rotulo="Quebra"
              valor={formatQtd(quebra)}
              tom={quebra > 0 ? 'prejuizo' : 'saudavel'}
              explicacao="Remetido menos o que voltou bom, menos segunda, menos perda declarada. É peça que sumiu — e ela é medida, nunca digitada."
            />
            <IndicadorDestaque
              rotulo="Valor do serviço"
              valor={os.valor_por_peca != null ? brl(os.valor_servico) : 'sem preço cadastrado'}
              tom={os.valor_por_peca == null ? 'atencao' : undefined}
              explicacao={os.valor_por_peca != null
                ? 'Peças boas × preço congelado na remessa.'
                : 'Esta O.S. saiu sem preço de serviço. Enquanto não houver preço da facção nesta etapa, o valor não existe — e não é zero.'}
            />
            <IndicadorDestaque
              rotulo="Prazo"
              valor={os.previsao_retorno
                ? `${dataBr(os.previsao_retorno)}${Number(os.dias_atraso) > 0 ? ` (${formatQtd(os.dias_atraso)} d de atraso)` : ''}`
                : 'sem prazo'}
              tom={Number(os.dias_atraso) > 0 ? 'prejuizo' : undefined}
              explicacao={os.previsao_retorno
                ? 'A data que a facção prometeu. Atraso é contado a partir dela.'
                : 'Esta O.S. não tem previsão de retorno, então não há como medir atraso nenhum.'}
            />
          </div>

          {erro && <p className="erro-inline">{erro}</p>}
          {aviso && <p className="sucesso-inline"><Check size={14} /> {aviso}</p>}

          <h3 className="card-titulo"><PackageCheck size={16} /> Itens e registro de retorno</h3>
          <p className="ink-soft ajuda-bloco">
            As três colunas de retorno são separadas de propósito: peça boa é serviço a pagar,
            segunda qualidade sai do fluxo e perda é peça declarada como destruída. O que não
            entrar em nenhuma das três vira QUEBRA sozinho — não existe campo para digitar quebra.
          </p>

          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Cor</th><th>Tamanho</th>
                  <th className="num">Remetido</th><th className="num">Já voltou bom</th>
                  <th className="num">Já voltou 2ª</th><th className="num">Perda</th>
                  <th className="num">Pendente</th>
                  {podeReceber && <th className="num">Volta bom</th>}
                  {podeReceber && <th className="num">Volta 2ª</th>}
                  {podeReceber && <th className="num">Perdeu</th>}
                </tr>
              </thead>
              <tbody>
                {dados.itens.map((i) => {
                  const r = retorno[i.id] || {};
                  const soma = (Number(r.retornada) || 0) + (Number(r.segunda) || 0) + (Number(r.perdida) || 0);
                  const excedeu = soma > Number(i.pendente);
                  return (
                    <tr key={i.id} className={excedeu ? 'linha-prejuizo' : undefined}>
                      <td>{i.cor || '—'}</td>
                      <td>{i.tamanho || '—'}</td>
                      <td className="num">{formatQtd(i.quantidade_remetida)}</td>
                      <td className="num">{formatQtd(i.quantidade_retornada)}</td>
                      <td className="num">{formatQtd(i.quantidade_segunda)}</td>
                      <td className="num">{formatQtd(i.quantidade_perdida)}</td>
                      <td className="num"><strong>{formatQtd(i.pendente)}</strong></td>
                      {podeReceber && (
                        <td className="num">
                          <NumInput step="1" value={r.retornada ?? ''} onChange={(v) => alterar(i.id, 'retornada', v)} />
                        </td>
                      )}
                      {podeReceber && (
                        <td className="num">
                          <NumInput step="1" value={r.segunda ?? ''} onChange={(v) => alterar(i.id, 'segunda', v)} />
                        </td>
                      )}
                      {podeReceber && (
                        <td className="num">
                          <NumInput step="1" value={r.perdida ?? ''} onChange={(v) => alterar(i.id, 'perdida', v)} />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {podeReceber && (
            <>
              <div className="form-linha">
                <Field label="Etapa que recebe a peça boa" hint="Para onde ela vai depois de voltar.">
                  <Select value={etapaDestino} placeholder="Fora do fluxo" onChange={(e) => setEtapaDestino(e.target.value)}>
                    {etapas.map((e) => <option key={e.id} value={e.id}>{e.sequencia}. {e.nome}</option>)}
                  </Select>
                </Field>
                <Field label="Data do retorno">
                  <DateInput value={data} onChange={(e) => setData(e.target.value)} />
                </Field>
              </div>

              {excedidas.length > 0 && (
                <div className="bloco-alerta">
                  <p><AlertTriangle size={15} /> <strong>Está voltando mais do que foi remetido.</strong></p>
                  <ul>
                    {excedidas.map((l) => (
                      <li key={l.item.id}>
                        {l.cor || 'sem cor'} {l.tamanho || 'sem tamanho'}: pendente {formatQtd(l.item.pendente)},
                        e este retorno soma {formatQtd(l.boa + l.segunda + l.perdida)}.
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="painel-acoes-inline">
                <button
                  type="button" className="btn"
                  disabled={linhasRetorno.length === 0 || excedidas.length > 0 || salvando}
                  onClick={registrarRetorno}
                ><PackageCheck size={15} /> Registrar retorno</button>
                <span className="ink-soft">
                  {linhasRetorno.length === 0
                    ? 'Digite o que voltou em pelo menos uma linha.'
                    : `${formatQtd(linhasRetorno.reduce((s, l) => s + l.boa + l.segunda + l.perdida, 0))} peça(s) neste retorno.`}
                </span>
              </div>
            </>
          )}

          {quebra > 0 && (
            <p className="aviso-inline">
              <AlertTriangle size={14} /> {formatQtd(quebra)} peça(s) não voltaram de jeito nenhum
              — nem boas, nem como segunda, nem declaradas como perda. É esta a conta a levar para
              a facção; o sistema não a esconde nem a arredonda.
            </p>
          )}

          <GerarTitulo
            os={os}
            onErro={setErro}
            onGerado={async (r) => {
              setAviso(
                `Título gerado: ${brl(r.titulo.valor_bruto)} bruto, de ${formatQtd(r.base.pecas_boas)} peça(s) boa(s)`
                + `${Number(r.base.quebra) > 0 ? `. A quebra de ${formatQtd(r.base.quebra)} peça(s) NÃO entrou no valor.` : '.'}`
              );
              await carregar();
              onMudou();
            }}
          />
        </div>

        <footer className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Fechar</button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function OrdensServicoPage() {
  const [lista, setLista] = useState([]);
  const [etapas, setEtapas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [atrasadas, setAtrasadas] = useState(false);
  const [comQuebra, setComQuebra] = useState(false);
  const [situacao, setSituacao] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [aberta, setAberta] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams();
      if (atrasadas) qs.set('atrasadas', 'true');
      if (comQuebra) qs.set('com_quebra', 'true');
      if (situacao) qs.set('situacao', situacao);
      const [r, et] = await Promise.all([
        api.get(`${ROTA}/ordens-servico?${qs}`),
        api.get(`${ROTA}/etapas`).catch(() => []),
      ]);
      setLista(r);
      setEtapas(et);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [atrasadas, comQuebra, situacao]);

  useEffect(() => { carregar(); }, [carregar]);

  const filtradas = useMemo(() => {
    if (!buscaAplicada) return lista;
    const alvo = buscaAplicada.toLowerCase();
    return lista.filter((o) => [
      o.numero, o.fornecedor_nome, o.etapa_nome, o.ordem_numero, o.produto_referencia,
    ].some((v) => String(v ?? '').toLowerCase().includes(alvo)));
  }, [lista, buscaAplicada]);

  const resumo = useMemo(() => {
    const emCurso = filtradas.filter((o) => ['remetida', 'parcial'].includes(o.situacao));
    const remetido = filtradas.reduce((s, o) => s + Number(o.remetido || 0), 0);
    const quebra = filtradas.reduce((s, o) => s + Number(o.quebra || 0), 0);
    const semPreco = filtradas.filter((o) => o.valor_por_peca == null).length;
    const valor = filtradas.reduce((s, o) => s + (o.valor_por_peca == null ? 0 : Number(o.valor_servico || 0)), 0);
    return {
      emCurso: emCurso.length,
      pecasFora: emCurso.reduce((s, o) => s + Math.max(0, Number(o.remetido || 0) - Number(o.retornado_bom || 0) - Number(o.retornado_segunda || 0) - Number(o.perda_declarada || 0)), 0),
      quebra,
      quebraFracao: remetido > 0 ? quebra / remetido : null,
      atrasadas: filtradas.filter((o) => Number(o.dias_atraso) > 0).length,
      valor,
      semPreco,
    };
  }, [filtradas]);

  const colunas = useMemo(() => ({
    numero: (o) => Number(o.numero),
    faccao: (o) => o.fornecedor_nome || '',
    etapa: (o) => o.etapa_nome || '',
    remetido: (o) => Number(o.remetido || 0),
    bom: (o) => Number(o.retornado_bom || 0),
    quebra: (o) => Number(o.quebra || 0),
    valor: (o) => Number(o.valor_servico || 0),
    atraso: (o) => Number(o.dias_atraso || 0),
  }), []);
  // Uma chamada só para as O.S. da página — nunca uma por linha.
  const selos = useSelosFinanceiros(
    'ordem_servico',
    (filtradas || []).map((o) => o.ordem_servico_id).filter(Boolean)
  );

  const tabela = useTabela(filtradas, {
    colunas, colunaPadrao: 'quebra', direcaoPadrao: 'desc', tamanhoPadrao: 50, prefixo: 'os',
  });

  const chips = [
    atrasadas && { chave: 'atrasadas', rotulo: 'Situação', valor: 'só atrasadas', onRemover: () => setAtrasadas(false) },
    comQuebra && { chave: 'quebra', rotulo: 'Quebra', valor: 'só com peça sumida', onRemover: () => setComQuebra(false) },
    situacao && { chave: 'situacao', rotulo: 'Situação', valor: SITUACAO[situacao]?.rotulo || situacao, onRemover: () => setSituacao('') },
    buscaAplicada && { chave: 'busca', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } },
  ].filter(Boolean);

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><ClipboardList size={22} /> Ordens de serviço de facção</h1>
          <p className="ink-soft">
            O que cada facção tem na mão, por quanto, até quando — e quantas peças não
            voltaram. A quebra é medida pelo sistema, peça por peça da grade.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <div className="indicadores-linha">
        <IndicadorDestaque
          rotulo="O.S. em curso"
          valor={formatQtd(resumo.emCurso)}
          Icone={Truck}
          explicacao="Remetidas ou parcialmente devolvidas — ainda há peça nossa na mão de terceiro."
        />
        <IndicadorDestaque
          rotulo="Peças fora daqui"
          valor={formatQtd(resumo.pecasFora)}
          explicacao="O que foi remetido nas O.S. em curso e ainda não voltou de forma nenhuma. Continua sendo estoque da empresa."
        />
        <IndicadorDestaque
          rotulo="Quebra acumulada"
          valor={resumo.quebraFracao != null
            ? `${formatQtd(resumo.quebra)} (${pct(resumo.quebraFracao, 1)})`
            : formatQtd(resumo.quebra)}
          tom={resumo.quebra > 0 ? 'prejuizo' : 'saudavel'}
          explicacao="Peça que saiu e não voltou nem boa, nem como segunda, nem declarada como perda. Nas O.S. filtradas."
        />
        <IndicadorDestaque
          rotulo="O.S. atrasadas"
          valor={formatQtd(resumo.atrasadas)}
          tom={resumo.atrasadas > 0 ? 'prejuizo' : undefined}
          explicacao="Passaram da previsão de retorno e ainda não foram concluídas. O.S. sem prazo não conta aqui — não há atraso a medir."
        />
        <IndicadorDestaque
          rotulo="Serviço apurado"
          valor={resumo.semPreco > 0 ? `${brl(resumo.valor)} (incompleto)` : brl(resumo.valor)}
          tom={resumo.semPreco > 0 ? 'atencao' : undefined}
          explicacao={resumo.semPreco > 0
            ? `${resumo.semPreco} O.S. sem preço de serviço ficaram de FORA desta soma. Fora não é zero — cadastre o preço da facção.`
            : 'Peças boas × preço congelado, somando as O.S. filtradas.'}
        />
      </div>

      <div className="filtros-linha">
        <CampoBusca
          valor={busca}
          onChange={setBusca}
          onSubmit={() => setBuscaAplicada(busca)}
          placeholder="Número da O.S., facção, etapa ou referência"
        />
        <Select value={situacao} placeholder="Todas as situações" onChange={(e) => setSituacao(e.target.value)}>
          {Object.entries(SITUACAO).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
        </Select>
        <label className="check-linha">
          <Checkbox checked={atrasadas} onChange={(e) => setAtrasadas(e.target.checked)} />
          Só atrasadas
        </label>
        <label className="check-linha">
          <Checkbox checked={comQuebra} onChange={(e) => setComQuebra(e.target.checked)} />
          Só com quebra
        </label>
      </div>

      <ChipsFiltros
        itens={chips}
        onLimparTudo={chips.length > 0 ? () => {
          setAtrasadas(false); setComQuebra(false); setSituacao(''); setBusca(''); setBuscaAplicada('');
        } : undefined}
      />

      {erro && <p className="erro-inline">{erro}</p>}

      {carregando && <Skeleton height={260} />}

      {!carregando && filtradas.length === 0 && (
        <EstadoVazio
          Icone={ClipboardList}
          titulo={chips.length > 0 ? 'Nenhuma O.S. com esses filtros' : 'Nenhuma ordem de serviço'}
          descricao={chips.length > 0
            ? 'Os filtros acima estão estreitando a lista — remova um deles para ver o resto. "Só com quebra" esconde toda O.S. em que nada sumiu, que é o caso normal.'
            : 'A O.S. nasce sozinha quando alguém movimenta peça para uma etapa externa, na tela de Gerar Movimentação. Ela é o documento que vai com a mercadoria: o que fazer, por quanto e até quando.'}
        />
      )}

      {!carregando && filtradas.length > 0 && (
        <>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th className="num">O.S.</th><th>Facção</th><th>Etapa</th>
                  <th className="num">Remetido</th><th className="num">Voltou bom</th>
                  <th className="num">Segunda</th><th className="num">Perda</th>
                  <th className="num">Quebra</th><th className="num">% quebra</th>
                  <th className="num">Valor do serviço</th><th className="num">Atraso</th>
                  <th>Situação</th><th>Financeiro</th>
                </tr>
              </thead>
              <tbody>
                {tabela.itensPagina.map((o) => {
                  const quebra = Number(o.quebra || 0);
                  const atraso = o.dias_atraso == null ? null : Number(o.dias_atraso);
                  return (
                    <tr
                      key={o.ordem_servico_id}
                      className="linha-clicavel"
                      onClick={() => setAberta(o.ordem_servico_id)}
                    >
                      <td className="num">{o.numero}</td>
                      <td>{o.fornecedor_nome || '—'}</td>
                      <td>{o.etapa_nome || '—'}</td>
                      <td className="num">{formatQtd(o.remetido)}</td>
                      <td className="num">{formatQtd(o.retornado_bom)}</td>
                      <td className="num">{formatQtd(o.retornado_segunda)}</td>
                      <td className="num">{formatQtd(o.perda_declarada)}</td>
                      <td className="num">
                        {quebra > 0
                          ? <span className="selo tone-prejuizo" title="Peça que saiu e não voltou de jeito nenhum.">{formatQtd(quebra)}</span>
                          : formatQtd(quebra)}
                      </td>
                      <td className={`num ${quebra > 0 ? 'ink-prejuizo' : ''}`}>
                        {o.quebra_fracao == null ? '—' : pct(o.quebra_fracao, 1)}
                      </td>
                      <td className="num">
                        {o.valor_por_peca == null
                          ? <span className="selo tone-atencao" title="O.S. remetida sem preço de serviço cadastrado. O valor é desconhecido, e desconhecido não é zero.">sem preço</span>
                          : brl(o.valor_servico)}
                      </td>
                      <td className={`num ${atraso > 0 ? 'ink-prejuizo' : ''}`}>
                        {atraso == null ? 'sem prazo' : (atraso > 0 ? `${formatQtd(atraso)} d` : '—')}
                      </td>
                      <td><SeloSituacao situacao={o.situacao} /></td>
                      {/* A ligação vista do lado de quem opera: dá para ver,
                          na própria lista, se o compromisso com a facção
                          chegou ao financeiro. Sem isto a ponte existiria só
                          para o financeiro, e quem cria o custo continuaria
                          sem saber se ele virou alguma coisa. */}
                      <td><SeloFinanceiro info={selos[o.ordem_servico_id]} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Paginacao
            pagina={tabela.pagina} totalPaginas={tabela.totalPaginas} tamanho={tabela.tamanho}
            totalItens={tabela.totalItens} inicio={tabela.inicio} fim={tabela.fim}
            setPagina={tabela.setPagina} setTamanho={tabela.setTamanho}
          />
          <p className="ink-soft ajuda-bloco">
            <Info size={14} /> Clique numa linha para registrar o retorno da facção e gerar o
            título a pagar. Quebra negativa quer dizer peça a MAIS do que foi remetido — quase
            sempre erro de contagem na remessa, e é melhor descobrir aqui do que no inventário.
          </p>
        </>
      )}

      {aberta && (
        <DetalheOS
          ordemServicoId={aberta}
          etapas={etapas}
          onFechar={() => setAberta(null)}
          onMudou={carregar}
        />
      )}
    </div>
  );
}
