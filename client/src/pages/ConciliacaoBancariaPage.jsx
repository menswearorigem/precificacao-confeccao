import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload, X, Landmark, ListChecks, AlertTriangle, Info, ArrowLeftRight, Link2,
  CheckCircle2, Hourglass, Tags,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, dataBr, formatQtd, tempoRelativo } from '../lib/format';
import DataTable from '../components/DataTable';
import {
  SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar, EstadoVazio,
  IndicadorDestaque, Checkbox, Field, Select,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { useTabela } from '../lib/useTabela';

// Conciliação bancária: casar o que o BANCO diz que aconteceu com o que o
// sistema registrou.
//
// O extrato é a verdade do banco e fica separado das baixas de propósito — um
// extrato que já nascesse casado não conciliaria nada. Cada linha pendente tem
// três destinos possíveis, e nenhum outro:
//
//   · é um título        -> conciliar gera a baixa, com a data e a conta do banco
//   · não é título nenhum -> classificar numa categoria (tarifa, rendimento)
//   · é dinheiro próprio mudando de conta -> marcar como transferência, ligando o par
//
// REGRA 2: linha do OFX que não deu para interpretar NÃO vira zero e não some.
// Ela volta em `avisos` e esta tela mostra todos eles, um a um.

const BASE = '/financeiro-nucleo';

function mensagemErro(err) {
  return err?.data?.error || err?.message || 'Não consegui completar a ação.';
}

function dataIso(valor) {
  return valor ? String(valor).slice(0, 10) : '';
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Um lançamento pode estar em quatro estados, e só o primeiro é trabalho.
function estadoDe(l) {
  if (l.baixa_id) return 'titulo';
  if (l.plano_id) return 'categoria';
  if (l.transferencia_par_id) return 'transferencia';
  return 'pendente';
}

const ESTADO_LABEL = {
  pendente: 'Pendente',
  titulo: 'Conciliado com título',
  categoria: 'Classificado',
  transferencia: 'Transferência entre contas',
};

const ESTADO_TONE = {
  pendente: 'tone-atencao',
  titulo: 'tone-saudavel',
  categoria: 'tone-saudavel',
  transferencia: 'tone-neutro',
};

// O <input type="file"> devolve bytes; o endpoint quer base64 (nada de
// multipart). btoa não aceita string de mais de ~64k de uma vez em alguns
// navegadores, então a conversão vai em pedaços.
function paraBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const pedaco = 0x8000;
  let binario = '';
  for (let i = 0; i < bytes.length; i += pedaco) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + pedaco));
  }
  return btoa(binario);
}

function ValorAssinado({ valor }) {
  const n = num(valor);
  const cor = n > 0 ? 'var(--success)' : n < 0 ? 'var(--danger)' : undefined;
  return <span className="mono" style={{ color: cor }}>{n > 0 ? '+' : ''}{brl(n)}</span>;
}

const COLUNAS_ORDENAVEIS = {
  data: (l) => dataIso(l.data_lancamento),
  historico: (l) => l.historico || '',
  documento: (l) => l.documento || '',
  valor: (l) => num(l.valor),
  estado: (l) => estadoDe(l),
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Data', valor: (l) => dataBr(dataIso(l.data_lancamento)) },
  { rotulo: 'Conta', valor: (l) => l.conta_nome || '' },
  { rotulo: 'Histórico', valor: (l) => l.historico || '' },
  { rotulo: 'Documento', valor: (l) => l.documento || '' },
  { rotulo: 'Valor', valor: (l) => brl(l.valor) },
  { rotulo: 'Situação', valor: (l) => ESTADO_LABEL[estadoDe(l)] },
  { rotulo: 'Categoria', valor: (l) => l.plano_nome || '' },
  { rotulo: 'Arquivo de origem', valor: (l) => l.arquivo_origem || '' },
];

// ---------------------------------------------------------------------------
// O painel de conciliação de UMA linha
// ---------------------------------------------------------------------------

function ModalConciliar({ lancamento, plano, onFechar, onConciliado }) {
  const [sugestoes, setSugestoes] = useState(null);
  const [candidatos, setCandidatos] = useState([]);
  const [planoId, setPlanoId] = useState('');
  const [parId, setParId] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const valorAbs = Math.abs(num(lancamento.valor));
  const ehSaida = num(lancamento.valor) < 0;

  useEffect(() => {
    let vivo = true;
    api.get(`${BASE}/extrato/${lancamento.id}/sugestoes`)
      .then((r) => { if (vivo) setSugestoes(r.sugestoes || []); })
      .catch((err) => { if (vivo) { setSugestoes([]); setErro(mensagemErro(err)); } });
    return () => { vivo = false; };
  }, [lancamento.id]);

  // O par de uma transferência é o MESMO dinheiro visto do outro lado: outra
  // conta, sinal contrário, valor igual, poucos dias de diferença. A janela é
  // de sete dias porque transferência entre bancos diferentes leva até isso
  // para aparecer nos dois extratos.
  useEffect(() => {
    let vivo = true;
    const dia = dataIso(lancamento.data_lancamento);
    const inicio = new Date(`${dia}T00:00:00`);
    inicio.setDate(inicio.getDate() - 7);
    const fim = new Date(`${dia}T00:00:00`);
    fim.setDate(fim.getDate() + 7);
    const p = new URLSearchParams();
    p.set('de', inicio.toISOString().slice(0, 10));
    p.set('ate', fim.toISOString().slice(0, 10));
    api.get(`${BASE}/extrato?${p.toString()}`)
      .then((r) => {
        if (!vivo) return;
        const lista = (Array.isArray(r) ? r : []).filter((o) => (
          o.id !== lancamento.id
          && o.conta_id !== lancamento.conta_id
          && Math.sign(num(o.valor)) === -Math.sign(num(lancamento.valor))
          && Math.abs(Math.abs(num(o.valor)) - valorAbs) < 0.01
          && !o.transferencia_par_id
        ));
        setCandidatos(lista);
      })
      .catch(() => { if (vivo) setCandidatos([]); });
    return () => { vivo = false; };
  }, [lancamento.id, lancamento.conta_id, lancamento.data_lancamento, valorAbs, lancamento.valor]);

  async function conciliar(corpo) {
    setSalvando(true);
    setErro('');
    try {
      await api.post(`${BASE}/extrato/${lancamento.id}/conciliar`, corpo);
      onConciliado();
    } catch (err) {
      setErro(mensagemErro(err));
    } finally {
      setSalvando(false);
    }
  }

  const analiticas = plano.filter((p) => p.analitica);

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <div className="card viagem-modal">
        <div className="card-head-linha">
          <div className="card-head">Conciliar o lançamento de {dataBr(dataIso(lancamento.data_lancamento))}</div>
          <button type="button" className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>
        <p className="page-sub">
          <strong>{lancamento.historico || 'Sem histórico no arquivo'}</strong> ·{' '}
          <ValorAssinado valor={lancamento.valor} /> · {lancamento.conta_nome}
          {lancamento.documento && <> · documento {lancamento.documento}</>}
        </p>

        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

        <div className="card">
          <div className="card-head">1. É um título? {ehSaida ? '(a pagar)' : '(a receber)'}</div>
          <p className="grafico-explicacao">
            Os títulos em aberto que podem ser este lançamento, do mais parecido para o menos: primeiro o
            valor mais próximo, depois a data. Conciliar gera a baixa com a data e a conta do banco.
          </p>
          {sugestoes === null && <p className="page-sub">Procurando títulos parecidos…</p>}
          {sugestoes?.length === 0 && (
            <p className="page-sub">
              Nenhum título em aberto com vencimento a até 30 dias desta data. Ou o título ainda não foi
              lançado, ou este dinheiro não é título nenhum — nesse caso, use a classificação abaixo.
            </p>
          )}
          {sugestoes?.length > 0 && (
            <DataTable>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vencimento</th><th>Contraparte</th><th>Descrição</th>
                    <th>Saldo em aberto</th><th>Diferença</th><th />
                  </tr>
                </thead>
                <tbody>
                  {sugestoes.map((s) => {
                    const saldo = num(s.saldo_aberto);
                    const cabe = valorAbs <= saldo + 0.001;
                    return (
                      <tr key={s.id}>
                        <td className="mono">{dataBr(dataIso(s.data_vencimento))}</td>
                        <td>{s.fornecedor_nome || s.cliente_nome || '—'}</td>
                        <td>
                          <span className="cel-dupla">
                            <strong>{s.descricao || '—'}</strong>
                            {s.documento && <small>{s.documento}</small>}
                          </span>
                        </td>
                        <td className="mono">{brl(saldo)}</td>
                        <td>
                          <span className="cel-dupla">
                            <strong className="mono">{num(s.diferenca_valor) < 0.005 ? 'valor exato' : brl(s.diferenca_valor)}</strong>
                            <small>{num(s.diferenca_dias) === 0 ? 'mesmo dia' : `${formatQtd(s.diferenca_dias)} dia(s) de diferença`}</small>
                          </span>
                        </td>
                        <td>
                          {cabe ? (
                            <button type="button" className="btn btn-primary" disabled={salvando} onClick={() => conciliar({ titulo_id: s.id })}>
                              <Link2 size={13} /> Conciliar
                            </button>
                          ) : (
                            <span className="stamp sm tone-atencao" title="A baixa seria maior que o saldo do título e o servidor recusaria.">
                              maior que o saldo
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTable>
          )}
        </div>

        <div className="card">
          <div className="card-head">2. Não é título nenhum: classificar numa categoria</div>
          <p className="grafico-explicacao">
            Para tarifa bancária, rendimento de aplicação, IOF — dinheiro que se move sem existir título.
            A categoria é o que leva esse valor ao lugar certo do resultado.
          </p>
          <Field label="Categoria do plano financeiro">
            <Select value={planoId} onChange={(e) => setPlanoId(e.target.value)}>
              <option value="">Escolha a categoria</option>
              {analiticas.map((p) => <option key={p.id} value={String(p.id)}>{`${p.codigo} · ${p.nome}`}</option>)}
            </Select>
          </Field>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!planoId || salvando}
            onClick={() => conciliar({ plano_id: Number(planoId) })}
          >
            <Tags size={13} /> Classificar nesta categoria
          </button>
        </div>

        <div className="card">
          <div className="card-head">3. É o mesmo dinheiro mudando de conta</div>
          <p className="grafico-explicacao">
            Transferência entre contas próprias aparece duas vezes — débito numa, crédito noutra. Ligar o
            par é o que impede o mesmo dinheiro de ser contado duas vezes no resultado.
          </p>
          {candidatos.length === 0 ? (
            <p className="page-sub">
              Nenhum lançamento de outra conta, com sinal contrário e mesmo valor, nos sete dias em volta
              desta data. Sem os dois lados importados, não há par para ligar.
            </p>
          ) : (
            <>
              <Field label="O outro lado da transferência">
                <Select value={parId} onChange={(e) => setParId(e.target.value)}>
                  <option value="">Escolha o lançamento</option>
                  {candidatos.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {`${dataBr(dataIso(c.data_lancamento))} · ${c.conta_nome} · ${brl(c.valor)}${c.historico ? ` · ${c.historico}` : ''}`}
                    </option>
                  ))}
                </Select>
              </Field>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!parId || salvando}
                onClick={() => conciliar({ transferencia_par_id: Number(parId) })}
              >
                <ArrowLeftRight size={13} /> Marcar como transferência
              </button>
            </>
          )}
        </div>

        <div className="confirm-modal-acoes">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Fechar sem conciliar</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

export default function ConciliacaoBancariaPage() {
  const [contas, setContas] = useState([]);
  const [plano, setPlano] = useState([]);
  const [contaId, setContaId] = useState('');
  const [periodo, setPeriodo] = useState({ inicio: '', fim: '' });
  const [soPendentes, setSoPendentes] = useState(true);

  const [extrato, setExtrato] = useState([]);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [recarregar, setRecarregar] = useState(0);

  const [importando, setImportando] = useState(false);
  const [importacao, setImportacao] = useState(null);
  const [erroImportacao, setErroImportacao] = useState('');
  const [conciliando, setConciliando] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api.get(`${BASE}/contas`)
      .then((r) => {
        const lista = Array.isArray(r) ? r : [];
        setContas(lista);
        if (lista.length === 1) setContaId(String(lista[0].conta_id));
      })
      .catch((err) => setErro(mensagemErro(err)));
    api.get(`${BASE}/plano`).then((r) => setPlano(Array.isArray(r) ? r : [])).catch(() => setPlano([]));
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (contaId) p.set('conta_id', contaId);
    if (periodo.inicio) p.set('de', periodo.inicio);
    if (periodo.fim) p.set('ate', periodo.fim);
    if (soPendentes) p.set('pendentes', 'true');
    return p;
  }, [contaId, periodo, soPendentes]);

  useEffect(() => {
    if (!contaId) { setExtrato([]); return; }
    setLoading(true);
    setErro('');
    api.get(`${BASE}/extrato?${params.toString()}`)
      .then((r) => setExtrato(Array.isArray(r) ? r : []))
      .catch((err) => setErro(mensagemErro(err)))
      .finally(() => setLoading(false));
  }, [params, contaId, recarregar]);

  const tabela = useTabela(extrato, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  const conta = contas.find((c) => String(c.conta_id) === String(contaId)) || null;

  const resumo = useMemo(() => {
    const pendentes = extrato.filter((l) => estadoDe(l) === 'pendente');
    return {
      lancamentos: extrato.length,
      pendentesQtd: pendentes.length,
      pendentesValor: pendentes.reduce((s, l) => s + Math.abs(num(l.valor)), 0),
      conciliados: extrato.length - pendentes.length,
    };
  }, [extrato]);

  async function importarArquivo(arquivo) {
    if (!arquivo) return;
    if (!contaId) { setErroImportacao('Escolha a conta bancária antes de mandar o arquivo.'); return; }
    setImportando(true);
    setErroImportacao('');
    setImportacao(null);
    try {
      const buffer = await arquivo.arrayBuffer();
      const resposta = await api.post(`${BASE}/extrato/importar`, {
        conta_id: Number(contaId),
        arquivo_base64: paraBase64(buffer),
        arquivo_nome: arquivo.name,
      });
      setImportacao(resposta);
      setRecarregar((n) => n + 1);
      api.get(`${BASE}/contas`).then((r) => setContas(Array.isArray(r) ? r : [])).catch(() => {});
    } catch (err) {
      setErroImportacao(mensagemErro(err));
    } finally {
      setImportando(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const semConta = contas.length === 0;

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h2>Conciliação bancária</h2>
          <p className="page-sub">
            O extrato do banco, lido do arquivo OFX, ao lado do que o sistema registrou. Cada linha
            pendente é uma pergunta em aberto: isso é um título, é uma tarifa, ou é o mesmo dinheiro
            mudando de conta?
          </p>
        </div>
      </div>

      <div className="filtros-barra no-print">
        <Select value={contaId} onChange={(e) => setContaId(e.target.value)}>
          <option value="">Escolha a conta</option>
          {contas.map((c) => (
            <option key={c.conta_id} value={String(c.conta_id)}>
              {`${c.nome}${c.empresa_nome ? ` · ${c.empresa_nome}` : ''}`}
            </option>
          ))}
        </Select>
        <PeriodoFiltro
          inicio={periodo.inicio}
          fim={periodo.fim}
          permitirTudo
          onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })}
        />
        <label className="check-linha">
          <Checkbox checked={soPendentes} onChange={(e) => setSoPendentes(e.target.checked)} />
          Só pendentes
        </label>
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
          <BotaoExportar
            nomeBase="extrato-bancario"
            colunas={COLUNAS_EXPORTACAO}
            itens={tabela.itensOrdenados}
            disabled={tabela.totalItens === 0}
          />
        </div>
      </div>

      {semConta && (
        <div className="aviso-compacto tone-atencao">
          Nenhuma conta bancária cadastrada ainda. Sem conta não há onde guardar o extrato — cadastre a
          conta da empresa antes de importar o OFX.
        </div>
      )}
      {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}

      <div className="card no-print">
        <div className="card-head"><Upload size={14} /> Importar o extrato (OFX)</div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Mande o arquivo <strong>OFX</strong> que o banco exporta. O arquivo é lido no seu navegador e
          enviado ao servidor. Reimportar o mesmo mês é normal e esperado: lançamento repetido é
          reconhecido e ignorado, não duplicado.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".ofx,application/x-ofx,text/plain"
          onChange={(e) => importarArquivo(e.target.files?.[0])}
          hidden
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!contaId || importando}
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={14} /> {importando ? 'Lendo o arquivo…' : 'Escolher o arquivo OFX'}
        </button>
        {!contaId && !semConta && (
          <p className="page-sub" style={{ marginBottom: 0 }}>Escolha a conta acima para liberar a importação.</p>
        )}
        {erroImportacao && <div className="aviso-compacto tone-prejuizo">{erroImportacao}</div>}
      </div>

      {importacao && (
        <div className="card no-print">
          <div className="card-head">O que veio no arquivo</div>
          <div className="indicadores-faixa compacta">
            <IndicadorDestaque
              rotulo="Lançamentos lidos"
              valor={formatQtd(importacao.lidos)}
              explicacao="Linhas que o leitor conseguiu interpretar dentro do arquivo."
            />
            <IndicadorDestaque
              destaque
              rotulo="Novos, gravados agora"
              valor={formatQtd(importacao.novos)}
              explicacao="Lançamentos que ainda não existiam nesta conta. São eles que aparecem como pendentes na lista abaixo."
            />
            <IndicadorDestaque
              rotulo="Repetidos, ignorados"
              valor={formatQtd(importacao.repetidos)}
              explicacao="Já estavam gravados nesta conta. Repetido não é erro: reimportar o mesmo mês é comum e o sistema não duplica."
            />
            <IndicadorDestaque
              tom={importacao.avisos?.length > 0 ? 'atencao' : undefined}
              rotulo="Avisos de leitura"
              valor={importacao.avisos?.length ? formatQtd(importacao.avisos.length) : '—'}
              explicacao={importacao.avisos?.length
                ? 'Linhas que ficaram de fora ou que merecem conferência. Estão escritas logo abaixo, uma a uma.'
                : 'Nenhuma linha ficou de fora e nada precisou de conferência.'}
            />
          </div>
          <p className="page-sub">
            Período do arquivo:{' '}
            {importacao.periodo?.de ? dataBr(dataIso(importacao.periodo.de)) : '—'} a{' '}
            {importacao.periodo?.ate ? dataBr(dataIso(importacao.periodo.ate)) : '—'}
            {importacao.periodo?.saldo_final !== null && importacao.periodo?.saldo_final !== undefined && (
              <> · saldo final informado pelo banco: {brl(importacao.periodo.saldo_final)}</>
            )}
            {importacao.conta_arquivo?.conta && (
              <> · conta no arquivo: {importacao.conta_arquivo.banco || '—'} / ag. {importacao.conta_arquivo.agencia || '—'} / c. {importacao.conta_arquivo.conta}</>
            )}
          </p>
          {(importacao.avisos || []).map((aviso, i) => (
            <div key={i} className="aviso-compacto tone-atencao">
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
              {aviso}
            </div>
          ))}
          {importacao.avisos?.length > 0 && (
            <div className="nota-precisao">
              <Info size={14} />
              <span>
                Cada aviso acima é <strong>dinheiro que existe no arquivo e ficou de fora da lista</strong>,
                ou uma repetição que pode ser duplicidade de verdade. Nada disso vira zero em silêncio: sem
                ler estas linhas, o extrato parece ter fechado quando não fechou.
              </span>
            </div>
          )}
        </div>
      )}

      {conta && (
        <div className="indicadores-faixa" style={{ marginTop: 14 }}>
          <IndicadorDestaque
            destaque
            Icone={Landmark}
            rotulo="Saldo da conta hoje"
            valor={brl(conta.saldo_atual)}
            explicacao={`Saldo inicial de ${brl(conta.saldo_inicial)} mais tudo que entrou e saiu no extrato importado${conta.ultimo_lancamento ? `. Último lançamento em ${dataBr(dataIso(conta.ultimo_lancamento))}` : ''}.`}
          />
          <IndicadorDestaque
            Icone={ListChecks}
            rotulo="Lançamentos no recorte"
            valor={resumo.lancamentos === 0 ? '—' : formatQtd(resumo.lancamentos)}
            explicacao={soPendentes
              ? 'Com o filtro "só pendentes" ligado, aqui só entram as linhas que ainda não foram conciliadas.'
              : 'Todas as linhas do extrato desta conta no período escolhido.'}
          />
          <IndicadorDestaque
            Icone={Hourglass}
            tom={resumo.pendentesQtd > 0 ? 'atencao' : undefined}
            rotulo="Ainda pendentes"
            valor={resumo.pendentesQtd === 0 ? '—' : formatQtd(resumo.pendentesQtd)}
            explicacao={resumo.pendentesQtd === 0
              ? 'Nenhuma linha pendente neste recorte.'
              : `Somam ${brl(resumo.pendentesValor)} em módulo (entradas e saídas juntas). Cada uma é uma pergunta em aberto.`}
          />
          <IndicadorDestaque
            Icone={CheckCircle2}
            rotulo="Já conciliados"
            valor={resumo.conciliados === 0 ? '—' : formatQtd(resumo.conciliados)}
            explicacao="Linhas que já viraram baixa de título, classificação de categoria ou par de transferência."
          />
        </div>
      )}

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Extrato</div>
          <span className="page-sub" style={{ margin: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} lançamento(s)</span>
        </div>
        <p className="page-sub" style={{ marginTop: 0 }}>
          Entrada em verde, saída em vermelho — o sinal vem do próprio arquivo do banco, não é adivinhado
          pelo tipo do lançamento. Transferência marcada continua aparecendo no filtro “só pendentes”: ela
          não gera baixa nem categoria, só liga os dois lados.
        </p>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} style={{ width: 110 }}>Data</ThOrdenavel>
                <ThOrdenavel coluna="historico" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Histórico</ThOrdenavel>
                <ThOrdenavel coluna="documento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Documento</ThOrdenavel>
                <ThOrdenavel coluna="valor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Valor</ThOrdenavel>
                <ThOrdenavel coluna="estado" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                <th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {loading && extrato.length === 0 && <SkeletonLinhasTabela colunas={6} />}
              {tabela.itensPagina.map((l) => {
                const estado = estadoDe(l);
                return (
                  <tr key={l.id}>
                    <td className="mono">{dataBr(dataIso(l.data_lancamento))}</td>
                    <td>
                      <span className="cel-dupla">
                        <strong>{l.historico || '—'}</strong>
                        {l.arquivo_origem && <small>{l.arquivo_origem}</small>}
                      </span>
                    </td>
                    <td className="mono">{l.documento || '—'}</td>
                    <td><ValorAssinado valor={l.valor} /></td>
                    <td>
                      <span className="cel-dupla">
                        <span className={'stamp sm ' + ESTADO_TONE[estado]}>{ESTADO_LABEL[estado]}</span>
                        {estado === 'categoria' && l.plano_nome && <small>{l.plano_nome}</small>}
                        {estado !== 'pendente' && l.conciliado_em && <small>{tempoRelativo(l.conciliado_em)}</small>}
                      </span>
                    </td>
                    <td className="no-print">
                      {estado === 'pendente' && (
                        <button type="button" className="btn btn-ghost" onClick={() => setConciliando(l)}>
                          <Link2 size={13} /> Conciliar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DataTable>
        {!loading && extrato.length === 0 && (
          <EstadoVazio
            Icone={Landmark}
            titulo={!contaId ? 'Escolha uma conta para ver o extrato' : soPendentes ? 'Nada pendente nesta conta' : 'Nenhum lançamento neste recorte'}
            descricao={!contaId
              ? 'O extrato é sempre de uma conta específica — é ela que define quais lançamentos existem e qual é o saldo.'
              : soPendentes
                ? 'Todo lançamento importado neste período já foi conciliado. Desmarque "só pendentes" para conferir o que já foi feito.'
                : 'Ou o OFX deste período ainda não foi importado, ou não houve movimentação. Importe o arquivo do banco acima.'}
          />
        )}
        <Paginacao {...tabela} />
      </div>

      {conciliando && (
        <ModalConciliar
          lancamento={conciliando}
          plano={plano}
          onFechar={() => setConciliando(null)}
          onConciliado={() => { setConciliando(null); setRecarregar((n) => n + 1); }}
        />
      )}
    </div>
  );
}
