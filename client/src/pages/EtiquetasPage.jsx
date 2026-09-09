import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Printer, FileText, Layers, ListChecks, AlertTriangle, CheckCircle2,
  Download, MapPin, Package, Trash2, ExternalLink, ShieldAlert, Loader2,
} from 'lucide-react';
import { api } from '../api/client';
import {
  Checkbox, ChipsFiltros, EstadoVazio, Field, IndicadorDestaque, NumInput, Select,
} from '../components/ui';
import FileDropzone from '../components/FileDropzone';
import { formatQtd, numeroBr } from '../lib/format';

// Etiquetas (09/09/2026). A dor é diária e concreta: a etiqueta do Mercado
// Livre Full sai em ZPL (linguagem de impressora térmica Zebra) e a impressora
// da casa só imprime PDF. Até aqui isso era resolvido colando o ZPL num site
// qualquer — o que manda nome e endereço de comprador pra fora sem ninguém
// decidir isso. O backend converte LOCALMENTE por padrão; a Labelary é reserva
// e só entra quando quem está na tela marca a caixa, de propósito.
//
// A tela mora no módulo `marketplace` (mesma chave que o backend já exige em
// /api/etiquetas) — nenhuma permissão nova.

const ABAS = [
  { chave: 'converter', rotulo: 'Converter etiqueta', Icone: FileText },
  { chave: 'lote', rotulo: 'Lote da expedição', Icone: Layers },
  { chave: 'picking', rotulo: 'Lista de separação', Icone: ListChecks },
];

const VAZIO = '—';

// 10 × 15 cm é o tamanho da etiqueta de envio de todos os marketplaces daqui.
const PADRAO_TAMANHO = { dpmm: 8, larguraMm: 101.6, alturaMm: 152.4 };

// O `api` do sistema só sabe falar JSON, e estas três rotas devolvem PDF
// binário. Mesmo tratamento de erro (o backend responde JSON quando recusa),
// mesmo `credentials: 'include'` — só a leitura da resposta muda.
async function pedirPdf(caminho, corpo) {
  const res = await fetch(`/api${caminho}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!res.ok) {
    let mensagem = `Erro na requisição (${res.status})`;
    let dados = null;
    try {
      dados = await res.json();
      if (dados?.error) mensagem = dados.error;
    } catch {
      // Resposta sem JSON (erro de rede/proxy) — fica a mensagem genérica.
    }
    const err = new Error(mensagem);
    err.status = res.status;
    err.data = dados;
    throw err;
  }
  return {
    blob: await res.blob(),
    etiquetas: res.headers.get('X-Etiquetas'),
    motor: res.headers.get('X-Motor-Conversao'),
  };
}

function abrirEmNovaAba(blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  // Revoga só depois: revogar na hora fecha a aba recém-aberta em alguns
  // navegadores, antes de o leitor de PDF terminar de ler o blob.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function baixarArquivo(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function corpoTamanho(tamanho) {
  return {
    dpmm: tamanho.dpmm,
    largura_mm: tamanho.larguraMm,
    altura_mm: tamanho.alturaMm,
  };
}

// ---------------------------------------------------------------------------
// Tamanho da etiqueta — compartilhado entre "Converter" e "Lote"
// ---------------------------------------------------------------------------
function CamposTamanho({ tamanho, onMudar }) {
  return (
    <>
      <div className="form-linha">
        <Field label="Densidade da impressora" hint="8 dpmm é o padrão das térmicas de etiqueta de envio.">
          <Select
            value={String(tamanho.dpmm)}
            onChange={(e) => onMudar({ ...tamanho, dpmm: Number(e.target.value) })}
          >
            <option value="8">8 dpmm — 203 dpi</option>
            <option value="12">12 dpmm — 300 dpi</option>
          </Select>
        </Field>
        <Field label="Largura da etiqueta" hint="Em milímetros.">
          <NumInput
            value={tamanho.larguraMm}
            step="0.1"
            suffix="mm"
            onChange={(v) => onMudar({ ...tamanho, larguraMm: v === '' ? '' : v })}
          />
        </Field>
        <Field label="Altura da etiqueta" hint="Em milímetros.">
          <NumInput
            value={tamanho.alturaMm}
            step="0.1"
            suffix="mm"
            onChange={(v) => onMudar({ ...tamanho, alturaMm: v === '' ? '' : v })}
          />
        </Field>
      </div>
      <p className="page-sub">
        O padrão é 10 × 15 cm (101,6 × 152,4 mm), o tamanho da etiqueta de envio dos marketplaces.
        Mude só se a sua bobina for outra — o PDF sai no tamanho escrito aqui, e uma medida errada
        imprime a etiqueta cortada ou encolhida no meio da folha.
      </p>
    </>
  );
}

// Bloco de escolha explícita da reserva. Desmarcado sempre que aparece: a
// pergunta é sobre mandar endereço de comprador pra fora, e essa resposta não
// pode vir marcada de fábrica.
function EscolhaLabelary({ marcada, onMarcar, naoEntendidos }) {
  return (
    <div className="bloco-alerta">
      <span>
        <ShieldAlert size={15} /> O conversor local não desenha{' '}
        <strong className="mono">{naoEntendidos?.length ? naoEntendidos.join(', ') : VAZIO}</strong>.
        Esses comandos sairiam em branco na etiqueta impressa.
      </span>
      <label className="painel-acoes-inline">
        <Checkbox checked={marcada} onChange={(e) => onMarcar(e.target.checked)} />
        <span>
          Usar a Labelary (o conteúdo da etiqueta, com nome e endereço do comprador, sai da empresa)
        </span>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seção 1 — Converter uma etiqueta
// ---------------------------------------------------------------------------
function AbaConverter({ tamanho, onMudarTamanho }) {
  const [zpl, setZpl] = useState('');
  const [analise, setAnalise] = useState(null);
  const [analisando, setAnalisando] = useState(false);
  const [erro, setErro] = useState('');
  const [labelary, setLabelary] = useState(false);
  const [gerando, setGerando] = useState(false);
  const [motor, setMotor] = useState('');

  // Analisa sozinho depois de colar/soltar — a pessoa não deveria ter que
  // clicar em "analisar" pra descobrir se dá pra converter aqui dentro.
  useEffect(() => {
    const conteudo = zpl.trim();
    setMotor('');
    if (!conteudo) { setAnalise(null); setErro(''); return undefined; }
    const t = setTimeout(async () => {
      setAnalisando(true);
      try {
        setAnalise(await api.post('/etiquetas/zpl/analisar', { zpl }));
        setErro('');
      } catch (err) {
        setAnalise(null);
        setErro(err.message);
      } finally {
        setAnalisando(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [zpl]);

  // Toda vez que o conteúdo muda, a autorização de mandar pra fora volta a
  // zero: quem autorizou a etiqueta anterior não autorizou esta.
  useEffect(() => { setLabelary(false); }, [zpl]);

  async function lerArquivo(e) {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;
    setErro('');
    try {
      setZpl(await arquivo.text());
    } catch {
      setErro('Não consegui ler esse arquivo aqui no navegador. Abra e cole o conteúdo no campo acima.');
    }
  }

  async function gerar() {
    setGerando(true);
    setErro('');
    try {
      const r = await pedirPdf('/etiquetas/zpl/pdf', {
        zpl,
        ...corpoTamanho(tamanho),
        ...(labelary ? { usar_labelary: true } : {}),
      });
      setMotor(r.motor || '');
      abrirEmNovaAba(r.blob);
    } catch (err) {
      setErro(err.message);
    } finally {
      setGerando(false);
    }
  }

  const podeGerar = Boolean(analise) && (analise.local || labelary) && !gerando;

  return (
    <>
      <div className="card">
        <div className="card-head">O ZPL da etiqueta</div>
        <p className="page-sub">
          Cole aqui o conteúdo que veio do marketplace, ou solte o arquivo abaixo. O arquivo é lido
          no seu navegador — ele não sobe pro servidor antes de você decidir converter.
        </p>
        <textarea
          value={zpl}
          onChange={(e) => setZpl(e.target.value)}
          className="mono"
          rows={9}
          spellCheck={false}
          style={{ resize: 'vertical' }}
          placeholder="^XA ^FO50,50 ^A0N,40,40 ^FDetiqueta^FS ^XZ"
          aria-label="Conteúdo ZPL da etiqueta"
        />
        <FileDropzone
          accept=".zpl,.txt"
          onChange={lerArquivo}
          formatosTexto="Arquivos .zpl ou .txt"
          className="no-print"
        />
      </div>

      <CamposTamanho tamanho={tamanho} onMudar={onMudarTamanho} />

      {erro && <p className="erro-inline">{erro}</p>}

      {!zpl.trim() && !erro && (
        <EstadoVazio
          Icone={FileText}
          titulo="Nada pra converter ainda"
          descricao="Assim que você colar o ZPL ou soltar o arquivo, eu conto quantas etiquetas tem dentro e digo se dá pra converter aqui mesmo, sem mandar nada pra fora."
        />
      )}

      {analisando && (
        <p className="page-sub"><Loader2 size={14} /> Lendo o conteúdo…</p>
      )}

      {analise && !analisando && (
        <>
          <div className="indicadores-faixa">
            <IndicadorDestaque
              rotulo="Etiquetas neste conteúdo"
              valor={formatQtd(analise.etiquetas)}
              Icone={Printer}
              destaque
              explicacao="Cada trecho entre ^XA e ^XZ é uma etiqueta — e vira uma página do PDF."
            />
            <IndicadorDestaque
              rotulo="Onde a conversão acontece"
              valor={analise.local ? 'Aqui dentro' : 'Precisa de reserva'}
              tom={analise.local ? 'saudavel' : 'atencao'}
              Icone={analise.local ? CheckCircle2 : AlertTriangle}
              explicacao={analise.local
                ? 'O conversor da casa desenha tudo que esta etiqueta usa: nada sai da empresa.'
                : 'A etiqueta usa comandos que o conversor da casa não desenha — sem a reserva, sairia incompleta.'}
            />
            <IndicadorDestaque
              rotulo="Comandos não desenhados"
              valor={analise.naoEntendidos?.length ? formatQtd(analise.naoEntendidos.length) : VAZIO}
              Icone={ShieldAlert}
              explicacao={analise.naoEntendidos?.length
                ? `São eles: ${analise.naoEntendidos.join(', ')}.`
                : 'Nenhum comando ficou de fora da leitura desta etiqueta.'}
            />
          </div>

          <div className={analise.local ? 'sucesso-inline' : 'aviso-inline'}>
            {analise.local ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <span>{analise.recomendacao || VAZIO}</span>
          </div>

          {!analise.local && (
            <EscolhaLabelary
              marcada={labelary}
              onMarcar={setLabelary}
              naoEntendidos={analise.naoEntendidos}
            />
          )}

          <div className="painel-acoes-inline">
            <button
              type="button"
              className="btn btn-primary"
              onClick={gerar}
              disabled={!podeGerar}
              title={!analise.local && !labelary
                ? 'Marque a opção da Labelary pra converter esta etiqueta — ou converta uma etiqueta que o conversor da casa dê conta.'
                : undefined}
            >
              <ExternalLink size={15} /> {gerando ? 'Gerando…' : 'Gerar PDF'}
            </button>
            {motor && (
              <span className={`stamp sm ${motor === 'local' ? 'tone-elevada' : 'tone-atencao'}`}>
                convertido {motor === 'local' ? 'aqui dentro' : 'pela Labelary'}
              </span>
            )}
          </div>
          <p className="page-sub">
            O PDF abre numa aba nova, pronto pra mandar na impressora comum de casa.
          </p>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Seção 2 — Lote da expedição
// ---------------------------------------------------------------------------
function AbaLote({ tamanho, onMudarTamanho }) {
  const [itens, setItens] = useState([]); // [{ id, nome, zpl }]
  const [colado, setColado] = useState('');
  const [erro, setErro] = useState('');
  const [gerando, setGerando] = useState(false);
  const [resultado, setResultado] = useState(null); // { etiquetas }
  const [labelary, setLabelary] = useState(false);
  const [naoEntendidos, setNaoEntendidos] = useState(null);
  const proximoId = useRef(1);

  function adicionar(novos) {
    setItens((atuais) => [...atuais, ...novos]);
    setResultado(null);
    setLabelary(false);
    setNaoEntendidos(null);
  }

  async function soltarArquivos(e) {
    const arquivos = Array.from(e.target.files || []);
    if (arquivos.length === 0) return;
    setErro('');
    try {
      const lidos = await Promise.all(arquivos.map(async (f) => ({
        id: proximoId.current++,
        nome: f.name,
        zpl: await f.text(),
      })));
      adicionar(lidos.filter((x) => x.zpl.trim()));
    } catch {
      setErro('Não consegui ler um dos arquivos aqui no navegador.');
    }
  }

  function adicionarColado() {
    if (!colado.trim()) return;
    adicionar([{ id: proximoId.current++, nome: 'colado à mão', zpl: colado }]);
    setColado('');
  }

  function remover(id) {
    setItens((atuais) => atuais.filter((i) => i.id !== id));
    setResultado(null);
  }

  async function gerarLote() {
    setGerando(true);
    setErro('');
    try {
      const r = await pedirPdf('/etiquetas/zpl/lote', {
        itens: itens.map((i) => ({ zpl: i.zpl })),
        ...corpoTamanho(tamanho),
        ...(labelary ? { usar_labelary: true } : {}),
      });
      setResultado({ etiquetas: r.etiquetas });
      setNaoEntendidos(null);
      baixarArquivo(r.blob, 'lote-etiquetas.pdf');
    } catch (err) {
      setErro(err.message);
      // 422 é o backend dizendo "tem comando que não desenho aqui" — é o
      // único momento em que faz sentido oferecer a reserva no lote.
      if (err.status === 422) setNaoEntendidos(err.data?.naoEntendidos || []);
    } finally {
      setGerando(false);
    }
  }

  return (
    <>
      <p className="page-sub">
        Junte as etiquetas do dia num PDF só e mande imprimir uma vez. É o que tira a expedição de
        abrir o painel de cada marketplace, uma etiqueta por vez. A ordem do PDF é a ordem da lista
        abaixo. O limite do servidor é de 500 etiquetas por lote.
      </p>

      <div className="card">
        <div className="card-head">Arquivos do lote</div>
        <FileDropzone
          accept=".zpl,.txt"
          multiple
          onChange={soltarArquivos}
          formatosTexto="Vários arquivos .zpl ou .txt de uma vez"
        />
        <Field label="Ou cole o ZPL de mais uma etiqueta">
          <textarea
            value={colado}
            onChange={(e) => setColado(e.target.value)}
            className="mono"
            rows={4}
            spellCheck={false}
            style={{ resize: 'vertical' }}
            placeholder="^XA … ^XZ"
          />
        </Field>
        <div className="painel-acoes-inline">
          <button type="button" className="btn btn-ghost" onClick={adicionarColado} disabled={!colado.trim()}>
            Adicionar ao lote
          </button>
        </div>
      </div>

      <CamposTamanho tamanho={tamanho} onMudar={onMudarTamanho} />

      {erro && <p className="erro-inline">{erro}</p>}

      {naoEntendidos && (
        <EscolhaLabelary marcada={labelary} onMarcar={setLabelary} naoEntendidos={naoEntendidos} />
      )}

      {itens.length === 0 ? (
        <EstadoVazio
          Icone={Layers}
          titulo="O lote está vazio"
          descricao="Solte os arquivos ZPL do dia aqui em cima — ou cole um por um. Enquanto não houver nenhum, não há o que juntar num PDF."
        />
      ) : (
        <>
          <div className="indicadores-faixa">
            <IndicadorDestaque
              rotulo="Arquivos no lote"
              valor={formatQtd(itens.length)}
              Icone={Layers}
              destaque
              explicacao="Cada um vira uma ou mais páginas, na ordem em que está na lista."
            />
            <IndicadorDestaque
              rotulo="Etiquetas no PDF gerado"
              valor={resultado?.etiquetas ? formatQtd(resultado.etiquetas) : VAZIO}
              Icone={Printer}
              explicacao={resultado?.etiquetas
                ? 'Contagem informada pelo servidor depois de montar o PDF — confira contra o número de caixas da expedição.'
                : 'Aparece depois de gerar: é o servidor quem conta quantas etiquetas entraram no PDF.'}
            />
          </div>

          <div className="card">
            <div className="card-head">O que vai no PDF</div>
            <div className="tabela-rolagem">
              <table className="calendario-lista-tabela">
                <thead>
                  <tr><th>#</th><th>Arquivo</th><th>Tamanho do conteúdo</th><th aria-label="Remover" /></tr>
                </thead>
                <tbody>
                  {itens.map((i, indice) => (
                    <tr key={i.id}>
                      <td className="mono">{indice + 1}</td>
                      <td>{i.nome || VAZIO}</td>
                      <td className="mono">{numeroBr(i.zpl.length / 1024, 1)} kB</td>
                      <td>
                        <button type="button" className="btn btn-ghost" onClick={() => remover(i.id)}>
                          <Trash2 size={14} /> Tirar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="painel-acoes-inline">
            <button type="button" className="btn btn-primary" onClick={gerarLote} disabled={gerando}>
              <Download size={15} /> {gerando ? 'Montando o PDF…' : 'Gerar PDF do lote'}
            </button>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Seção 3 — Lista de separação
// ---------------------------------------------------------------------------
function AbaPicking() {
  const [texto, setTexto] = useState('');
  const [dados, setDados] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [imprimindo, setImprimindo] = useState(false);
  const [erro, setErro] = useState('');

  // Aceita vírgula, ponto-e-vírgula, espaço ou quebra de linha: quem cola uma
  // coluna inteira do painel do marketplace não deveria ter que arrumar nada.
  const ids = useMemo(() => {
    const brutos = String(texto).split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean);
    const numeros = brutos.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
    return [...new Set(numeros)];
  }, [texto]);

  const removerId = useCallback((id) => {
    setTexto((atual) => {
      const restantes = String(atual).split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean)
        .filter((v) => Number(v) !== id);
      return restantes.join(', ');
    });
  }, []);

  async function buscar() {
    setBuscando(true);
    setErro('');
    try {
      setDados(await api.post('/etiquetas/picking', { pedido_ids: ids }));
    } catch (err) {
      setDados(null);
      setErro(err.message);
    } finally {
      setBuscando(false);
    }
  }

  async function imprimir() {
    setImprimindo(true);
    setErro('');
    try {
      const r = await pedirPdf('/etiquetas/picking/pdf', { pedido_ids: ids });
      baixarArquivo(r.blob, 'separacao.pdf');
    } catch (err) {
      setErro(err.message);
    } finally {
      setImprimindo(false);
    }
  }

  const chips = ids.map((id) => ({
    chave: `pedido-${id}`,
    rotulo: 'Pedido',
    valor: `#${id}`,
    onRemover: () => removerId(id),
  }));

  return (
    <>
      <div className="card">
        <div className="card-head">Quais pedidos vão nesta separação</div>
        <p className="page-sub">
          Escreva os números internos dos pedidos separados por vírgula, ou cole a lista inteira —
          uma por linha também serve. Número repetido entra uma vez só.
        </p>
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          className="mono"
          rows={4}
          spellCheck={false}
          style={{ resize: 'vertical' }}
          placeholder="1024, 1025, 1031"
          aria-label="Números dos pedidos"
        />
        <ChipsFiltros itens={chips} onLimparTudo={chips.length > 0 ? () => setTexto('') : undefined} />
        <div className="painel-acoes-inline">
          <button type="button" className="btn btn-primary" onClick={buscar} disabled={ids.length === 0 || buscando}>
            <ListChecks size={15} /> {buscando ? 'Montando a lista…' : 'Montar lista de separação'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Por que a lista é agregada por SKU</div>
        <p className="ajuda-bloco">
          A lista não é uma folha por pedido: ela soma a mesma referência, cor e tamanho de todos os
          pedidos numa linha só, ordenada pelo endereço no galpão. Quem separa anda o galpão uma vez
          por referência — pega as 7 camisetas pretas P de uma vez — em vez de andar o mesmo corredor
          uma vez por pedido, buscando a mesma peça sete vezes. Numa confecção com grade cor ×
          tamanho, essa é a maior economia de tempo da expedição. A divisão por caixa acontece
          depois, na bipagem da Conferência, que é onde o erro de caixa trocada é pego.
        </p>
      </div>

      {erro && <p className="erro-inline">{erro}</p>}

      {!dados && !erro && (
        <EstadoVazio
          Icone={ListChecks}
          titulo="Nenhuma lista montada ainda"
          descricao="Informe os pedidos acima e clique em montar. Sem saber quais pedidos entram na leva, não há o que somar por referência."
        />
      )}

      {dados && (
        <>
          <div className="indicadores-faixa">
            <IndicadorDestaque
              rotulo="Pedidos nesta leva"
              valor={formatQtd(dados.pedidos)}
              Icone={Package}
              explicacao="Quantos pedidos serão montados com o que sair desta única volta pelo galpão."
            />
            <IndicadorDestaque
              rotulo="Linhas pra separar"
              valor={formatQtd(dados.linhas)}
              Icone={ListChecks}
              destaque
              explicacao="Cada linha é uma referência em uma cor e um tamanho — é quantas paradas quem separa vai fazer."
            />
            <IndicadorDestaque
              rotulo="Peças no total"
              valor={formatQtd(dados.total_pecas)}
              Icone={Printer}
              explicacao="Soma de todas as peças da leva — é o que tem que estar na bancada no fim da volta."
            />
          </div>

          <div className="card">
            <div className="card-head-linha">
              <div className="card-head">O que coletar</div>
              <button type="button" className="btn btn-ghost" onClick={imprimir} disabled={imprimindo}>
                <Printer size={14} /> {imprimindo ? 'Gerando…' : 'Imprimir lista'}
              </button>
            </div>
            {dados.itens.length === 0 ? (
              <EstadoVazio
                Icone={MapPin}
                titulo="Esses pedidos não têm item nenhum"
                descricao="Os números foram aceitos, mas nenhum item foi encontrado neles. Confira se são os números internos dos pedidos e não os números da plataforma."
              />
            ) : (
              <div className="tabela-rolagem">
                <table className="calendario-lista-tabela">
                  <thead>
                    <tr>
                      <th>Local</th>
                      <th>Produto</th>
                      <th>Cor</th>
                      <th>Tamanho</th>
                      <th>Quantidade</th>
                      <th>Em quantos pedidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.itens.map((item, indice) => (
                      <tr key={`${item.produto_id}-${item.cor}-${item.tamanho}-${indice}`}>
                        <td className="mono">{item.localizacao || VAZIO}</td>
                        <td>
                          {item.descricao || VAZIO}
                          {item.referencia && <> · <span className="mono">{item.referencia}</span></>}
                        </td>
                        <td>{item.cor || VAZIO}</td>
                        <td>{item.tamanho || VAZIO}</td>
                        <td className="mono">{formatQtd(item.quantidade)}</td>
                        <td className="mono">{formatQtd(item.pedidos)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="page-sub">
              Sem endereço cadastrado, o local sai como {VAZIO} e a linha vai pro fim da lista — são
              justamente as peças que fazem quem separa procurar. Cadastrar o endereço em
              <strong> Estoque › Onde Está a Peça</strong> tira essa procura da rotina.
            </p>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
export default function EtiquetasPage() {
  const [aba, setAba] = useState('converter');
  const [tamanho, setTamanho] = useState(PADRAO_TAMANHO);

  return (
    <div className="page-wide">
      <h2><Printer size={22} style={{ verticalAlign: -3, marginRight: 8 }} />Etiquetas de Envio</h2>
      <p className="page-sub">
        A etiqueta do Mercado Livre Full sai em ZPL, a linguagem das impressoras térmicas Zebra, e a
        impressora comum da casa não entende esse arquivo. Aqui ele vira PDF — por padrão convertido
        dentro da própria empresa, sem que nome e endereço de comprador saiam daqui.
      </p>

      <div className="view-toggle">
        {ABAS.map(({ chave, rotulo, Icone }) => (
          <button key={chave} type="button" className={aba === chave ? 'active' : ''} onClick={() => setAba(chave)}>
            <Icone size={13} /> {rotulo}
          </button>
        ))}
      </div>

      {aba === 'converter' && <AbaConverter tamanho={tamanho} onMudarTamanho={setTamanho} />}
      {aba === 'lote' && <AbaLote tamanho={tamanho} onMudarTamanho={setTamanho} />}
      {aba === 'picking' && <AbaPicking />}
    </div>
  );
}
