import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Warehouse, ArrowLeftRight, Info, AlertTriangle, Check, X, RefreshCw, Plus,
  Truck, PackageCheck, Undo2, Boxes, MapPin, Store, Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, IndicadorDestaque, Select, Field, NumInput,
  CampoBusca, ChipsFiltros,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { formatQtd, tempoRelativo } from '../lib/format';
import { CampoTextoLimitado } from '../components/campos';

// Estoque › Depósitos e transferências.
//
// A tela existe por causa de uma pergunta que o sistema não sabia responder:
// "quanto tem NA EXPEDIÇÃO?". Até aqui o estoque tinha um total e uma
// natureza de lugar ("no galpão", "na facção"), e o galpão era um balde só.
//
// As duas coisas que a tela promete e cumpre:
//
//   · MANDAR NÃO ENTREGA. O envio tira da origem e põe em trânsito; só o
//     aceite credita o destino. Enquanto a carga está na rua, ela não está
//     disponível em lugar nenhum — que é a verdade.
//   · FALTA NÃO VIRA AJUSTE SOZINHA. Chegou menos do que saiu, a diferença
//     volta a ser saldo "sem depósito" e fica marcada. Baixar como perda é um
//     segundo ato, com motivo escrito.

const BASE = '/depositos';

const NATUREZAS = [
  { valor: 'proprio', rotulo: 'Nosso', frase: 'Aqui dentro. É o único tipo de onde se vende pelo canal normal.' },
  { valor: 'faccao', rotulo: 'Facção', frase: 'Costura, lavanderia, bordado. Continua sendo nosso e continua valendo dinheiro — mas não dá para vender hoje.' },
  { valor: 'terceiro', rotulo: 'Terceiro', frase: 'Consignado, showroom, ML Full, Shopee 3PL. Nosso, fora daqui, e não vendável pelo canal normal.' },
];

const CANAIS = [
  { valor: '', rotulo: 'Nenhum canal' },
  { valor: 'mercado_livre', rotulo: 'Mercado Livre' },
  { valor: 'shopee', rotulo: 'Shopee' },
  { valor: 'tiktok', rotulo: 'TikTok Shop' },
  { valor: 'shein', rotulo: 'Shein' },
];

const SITUACOES = [
  { valor: 'rascunho', rotulo: 'Rascunho' },
  { valor: 'em_transito', rotulo: 'Em trânsito' },
  { valor: 'recebida', rotulo: 'Recebida' },
  { valor: 'cancelada', rotulo: 'Cancelada' },
];

const rotuloSituacao = (s) => SITUACOES.find((x) => x.valor === s)?.rotulo || s;
const rotuloNatureza = (n) => NATUREZAS.find((x) => x.valor === n)?.rotulo || n;
const ouTraco = (v) => (v === null || v === undefined || v === '' ? '—' : v);
const mensagem = (e) => e?.data?.error || e?.data?.erro || e?.message || 'Erro inesperado.';

// ---------------------------------------------------------------- cadastro

function PainelDeposito({ deposito, fornecedores, onFechar, onPronto }) {
  const novo = !deposito;
  const [form, setForm] = useState(() => ({
    codigo: deposito?.codigo || '',
    nome: deposito?.nome || '',
    natureza: deposito?.natureza || 'proprio',
    fornecedor_id: deposito?.fornecedor_id || '',
    canal: deposito?.canal || '',
    endereco: deposito?.endereco || '',
    padrao: deposito?.padrao || false,
  }));
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const def = NATUREZAS.find((n) => n.valor === form.natureza);

  async function salvar() {
    setErro('');
    setSalvando(true);
    try {
      const corpo = { ...form, fornecedor_id: form.fornecedor_id || null, canal: form.canal || null };
      const r = novo ? await api.post(BASE, corpo) : await api.put(`${BASE}/${deposito.id}`, corpo);
      onPronto(r);
    } catch (e) { setErro(mensagem(e)); } finally { setSalvando(false); }
  }

  return (
    <div className="anuncio-painel-fundo" onClick={onFechar} role="presentation">
      <div className="anuncio-painel" onClick={(e) => e.stopPropagation()} role="presentation">
        <div className="anuncio-painel-topo">
          <strong>{novo ? 'Novo depósito' : `Depósito ${deposito.nome}`}</strong>
          <button type="button" className="btn-icone" onClick={onFechar} title="Fechar"><X size={16} /></button>
        </div>
        <div className="anuncio-painel-corpo">
          <Field label="Código">
            <input
              value={form.codigo}
              onChange={(e) => setForm({ ...form, codigo: e.target.value })}
              placeholder="EXP"
              maxLength={20}
            />
          </Field>
          <Field label="Nome">
            <CampoTextoLimitado
              value={form.nome}
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
              placeholder="Expedição"
            />
          </Field>
          <Field label="Natureza">
            <Select value={form.natureza} onChange={(e) => setForm({ ...form, natureza: e.target.value })}>
              {NATUREZAS.map((n) => <option key={n.valor} value={n.valor}>{n.rotulo}</option>)}
            </Select>
          </Field>
          <p className="ink-soft ajuda-bloco"><Info size={14} /> {def?.frase}</p>

          {form.natureza === 'faccao' && (
            <Field label="De quem é a casa">
              <Select value={form.fornecedor_id} onChange={(e) => setForm({ ...form, fornecedor_id: e.target.value })}>
                <option value="">Escolha o fornecedor</option>
                {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </Select>
            </Field>
          )}

          <Field label="Canal (quando o depósito é de uma plataforma)">
            <Select value={form.canal} onChange={(e) => setForm({ ...form, canal: e.target.value })}>
              {CANAIS.map((c) => <option key={c.valor} value={c.valor}>{c.rotulo}</option>)}
            </Select>
          </Field>
          {form.canal && (
            <p className="ink-soft ajuda-bloco">
              <Info size={14} /> O canal é informativo por enquanto: o saldo que o Hub envia às
              plataformas <strong>não muda</strong> por causa dele. Mudar isso muda o que o
              comprador enxerga, e é decisão sua — não efeito colateral de um cadastro.
            </p>
          )}

          <Field label="Endereço ou observação de lugar">
            <input
              value={form.endereco}
              onChange={(e) => setForm({ ...form, endereco: e.target.value })}
              placeholder="Rua B, fundo do galpão"
              maxLength={160}
            />
          </Field>

          {erro && <p className="erro-inline">{erro}</p>}
        </div>
        <div className="painel-rodape">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button type="button" className="btn btn-primary" onClick={salvar} disabled={salvando}>
            <Check size={15} /> {salvando ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- nova remessa

function PainelTransferencia({ depositos, onFechar, onPronto }) {
  const [origem, setOrigem] = useState('');
  const [destino, setDestino] = useState('');
  const [numero, setNumero] = useState('');
  const [transportador, setTransportador] = useState('');
  const [saldoOrigem, setSaldoOrigem] = useState(null);
  const [busca, setBusca] = useState('');
  const [linhas, setLinhas] = useState([]);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!origem) { setSaldoOrigem(null); return; }
    let vivo = true;
    api.get(`${BASE}/${origem}/saldo`)
      .then((r) => { if (vivo) setSaldoOrigem(r); })
      .catch((e) => setErro(mensagem(e)));
    return () => { vivo = false; };
  }, [origem]);

  const candidatos = useMemo(() => {
    if (!saldoOrigem) return [];
    const alvo = busca.trim().toLowerCase();
    const pecas = saldoOrigem.pecas.map((p) => ({
      chave: `v${p.variante_id}`, tipo: 'peca', id: p.variante_id,
      rotulo: `${p.referencia} · ${p.cor} · ${p.tamanho}`, unidade: 'pç', tem: Number(p.quantidade),
    }));
    const insumos = saldoOrigem.insumos.map((i) => ({
      chave: `i${i.insumo_id}`, tipo: 'insumo', id: i.insumo_id,
      rotulo: i.nome, unidade: i.unidade, tem: Number(i.quantidade),
    }));
    const todos = [...pecas, ...insumos];
    if (!alvo) return todos.slice(0, 60);
    return todos.filter((c) => c.rotulo.toLowerCase().includes(alvo)).slice(0, 60);
  }, [saldoOrigem, busca]);

  function incluir(c) {
    if (linhas.some((l) => l.chave === c.chave)) return;
    setLinhas([...linhas, { ...c, quantidade: c.tem }]);
  }

  async function salvar() {
    setErro('');
    setSalvando(true);
    try {
      const r = await api.post(`${BASE}/transferencias`, {
        numero: numero || null,
        origem_deposito_id: Number(origem),
        destino_deposito_id: Number(destino),
        transportador: transportador || null,
        itens: linhas.map((l) => (l.tipo === 'peca'
          ? { variante_id: l.id, quantidade: l.quantidade }
          : { insumo_id: l.id, quantidade: l.quantidade })),
      });
      onPronto(r);
    } catch (e) { setErro(mensagem(e)); } finally { setSalvando(false); }
  }

  const ativos = depositos.filter((d) => d.ativo);

  return (
    <div className="anuncio-painel-fundo" onClick={onFechar} role="presentation">
      <div className="anuncio-painel" onClick={(e) => e.stopPropagation()} role="presentation">
        <div className="anuncio-painel-topo">
          <strong>Nova transferência</strong>
          <button type="button" className="btn-icone" onClick={onFechar} title="Fechar"><X size={16} /></button>
        </div>
        <div className="anuncio-painel-corpo">
          <div className="filtros-linha">
            <Field label="De">
              <Select value={origem} onChange={(e) => { setOrigem(e.target.value); setLinhas([]); }}>
                <option value="">Escolha a origem</option>
                {ativos.map((d) => <option key={d.id} value={d.id}>{d.nome}</option>)}
              </Select>
            </Field>
            <Field label="Para">
              <Select value={destino} onChange={(e) => setDestino(e.target.value)}>
                <option value="">Escolha o destino</option>
                {ativos.filter((d) => String(d.id) !== String(origem)).map((d) => (
                  <option key={d.id} value={d.id}>{d.nome}</option>
                ))}
              </Select>
            </Field>
            <Field label="Número (opcional)">
              <input value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={20} placeholder="T-1042" />
            </Field>
            <Field label="Quem leva (opcional)">
              <input value={transportador} onChange={(e) => setTransportador(e.target.value)} maxLength={120} />
            </Field>
          </div>

          <p className="ink-soft ajuda-bloco">
            <Info size={14} /> Criar a transferência <strong>não move estoque</strong>. Rascunho é
            intenção: a peça só sai da origem quando você mandar enviar.
          </p>

          {origem && (
            <>
              <CampoBusca valor={busca} onChange={setBusca} placeholder="Referência, cor, tamanho ou insumo" />
              {!saldoOrigem && <Skeleton height={120} />}
              {saldoOrigem && candidatos.length === 0 && (
                <EstadoVazio
                  Icone={Boxes}
                  titulo="Nada endereçado neste depósito ainda"
                  descricao="Dá para transferir mesmo assim: o envio puxa do saldo que ainda não tem depósito, e avisa exatamente quanto veio de lá."
                />
              )}
              {saldoOrigem && candidatos.length > 0 && (
                <>
                  <p className="ink-soft">Clique na linha para incluir na remessa.</p>
                  {/* Duas colunas, e não três com um botão: com a coluna do botão a
                      tabela ficava mais larga que o painel de 680px, e clicar em
                      "Incluir" rolava a tabela para o lado — o nome do item saía da
                      tela no exato momento em que a pessoa o escolhia. Achado na
                      passada de navegador, não no teste. */}
                  <div className="tabela-rolagem">
                    <table className="tabela-nota tabela-estreita">
                      <thead>
                        <tr><th>Item</th><th className="num">Tem aqui</th></tr>
                      </thead>
                      <tbody>
                        {candidatos.map((c) => {
                          const jaEsta = linhas.some((l) => l.chave === c.chave);
                          return (
                            <tr
                              key={c.chave}
                              className={jaEsta ? 'linha-nova' : 'linha-clicavel'}
                              onClick={() => incluir(c)}
                            >
                              <td>{jaEsta ? <Check size={13} /> : <Plus size={13} />} {c.rotulo}</td>
                              <td className="num">{formatQtd(c.tem)} {c.unidade}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {linhas.length > 0 && (
            <div className="tabela-rolagem">
              <table className="tabela-nota tabela-estreita">
                <thead>
                  <tr><th>Vai nesta remessa</th><th className="num">Quantidade</th><th /></tr>
                </thead>
                <tbody>
                  {linhas.map((l, i) => (
                    <tr key={l.chave}>
                      <td>{l.rotulo}</td>
                      <td className="num">
                        <NumInput
                          value={l.quantidade}
                          onChange={(v) => {
                            const copia = [...linhas];
                            copia[i] = { ...l, quantidade: v };
                            setLinhas(copia);
                          }}
                        />
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn-icone perigo"
                          title="Tirar da remessa"
                          onClick={() => setLinhas(linhas.filter((x) => x.chave !== l.chave))}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {erro && <p className="erro-inline">{erro}</p>}
        </div>
        <div className="painel-rodape">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={salvar}
            disabled={salvando || !origem || !destino || linhas.length === 0}
          >
            <Check size={15} /> {salvando ? 'Salvando…' : 'Criar rascunho'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ aceite

function PainelAceite({ transferencia, onFechar, onPronto }) {
  const [itens, setItens] = useState(null);
  const [conferido, setConferido] = useState({});
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    api.get(`${BASE}/transferencias/${transferencia.id}`)
      .then((r) => {
        setItens(r.itens);
        // ⚠️ Os campos nascem VAZIOS, e não preenchidos com o que foi enviado.
        // Nascer preenchido faz o aceite virar um clique — e transferência que
        // nunca acusa falta é transferência que não está sendo conferida.
        setConferido({});
      })
      .catch((e) => setErro(mensagem(e)));
  }, [transferencia.id]);

  const faltaConferir = (itens || []).filter((i) => conferido[i.id] === undefined || conferido[i.id] === '');

  async function salvar() {
    setErro('');
    setSalvando(true);
    try {
      const r = await api.post(`${BASE}/transferencias/${transferencia.id}/receber`, {
        itens: (itens || []).map((i) => ({ id: i.id, quantidadeRecebida: Number(conferido[i.id]) })),
      });
      onPronto(r);
    } catch (e) { setErro(mensagem(e)); } finally { setSalvando(false); }
  }

  return (
    <div className="anuncio-painel-fundo" onClick={onFechar} role="presentation">
      <div className="anuncio-painel" onClick={(e) => e.stopPropagation()} role="presentation">
        <div className="anuncio-painel-topo">
          <strong>
            Conferir a chegada · {transferencia.origem_nome} → {transferencia.destino_nome}
          </strong>
          <button type="button" className="btn-icone" onClick={onFechar} title="Fechar"><X size={16} /></button>
        </div>
        <div className="anuncio-painel-corpo">
          <p className="ink-soft ajuda-bloco">
            <Info size={14} /> Conte o que chegou e escreva o número. Zero também é um número — e
            é uma afirmação diferente de deixar em branco. A diferença entre o que saiu e o que
            chegou <strong>não vira ajuste sozinha</strong>: ela volta a ser saldo sem depósito e
            fica marcada aqui até alguém decidir se foi perda.
          </p>

          {!itens && <Skeleton height={180} />}
          {itens && itens.map((i) => {
            const rec = conferido[i.id];
            const dif = rec === undefined || rec === '' ? null : Number(rec) - Number(i.quantidade_enviada);
            return (
              <div className="aceite-item" key={i.id}>
                <div>
                  <strong>
                    {i.variante_id
                      ? `${ouTraco(i.referencia)} · ${ouTraco(i.cor)} · ${ouTraco(i.tamanho)}`
                      : `${ouTraco(i.insumo_nome)} (${ouTraco(i.insumo_unidade)})`}
                  </strong>
                  <p className="ink-soft">Saíram {formatQtd(i.quantidade_enviada)}</p>
                </div>
                <div className="aceite-item-conta">
                  <div className="aceite-item-campo">
                    <Field label="Chegou">
                      <NumInput
                        value={rec === undefined ? '' : rec}
                        onChange={(v) => setConferido({ ...conferido, [i.id]: v })}
                      />
                    </Field>
                  </div>
                  <span className={`aceite-item-dif ${dif < 0 ? 'tone-prejuizo' : ''}`}>
                    {dif === null ? '—' : (dif > 0 ? `+${formatQtd(dif)}` : formatQtd(dif))}
                  </span>
                </div>
              </div>
            );
          })}

          {faltaConferir.length > 0 && itens && (
            <p className="aviso-inline">
              <AlertTriangle size={14} /> Faltam {faltaConferir.length} item(ns) sem número. Todos
              precisam de um para o aceite fechar.
            </p>
          )}
          {erro && <p className="erro-inline">{erro}</p>}
        </div>
        <div className="painel-rodape">
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Cancelar</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={salvar}
            disabled={salvando || !itens || faltaConferir.length > 0}
          >
            <PackageCheck size={15} /> {salvando ? 'Registrando…' : 'Registrar chegada'}
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- tela

export default function DepositosPage() {
  const [panorama, setPanorama] = useState(null);
  const [depositos, setDepositos] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [transferencias, setTransferencias] = useState([]);
  const [situacao, setSituacao] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const [avisos, setAvisos] = useState([]);
  const [editando, setEditando] = useState(undefined);
  const [criandoRemessa, setCriandoRemessa] = useState(false);
  const [aceitando, setAceitando] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [p, d, t] = await Promise.all([
        api.get(`${BASE}/panorama`),
        api.get(`${BASE}?todos=true`),
        api.get(`${BASE}/transferencias${situacao ? `?situacao=${situacao}` : ''}`),
      ]);
      setPanorama(p);
      setDepositos(d);
      setTransferencias(t);
    } catch (e) { setErro(mensagem(e)); } finally { setCarregando(false); }
  }, [situacao]);

  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    api.get('/fornecedores').then((r) => setFornecedores(Array.isArray(r) ? r : (r?.itens || []))).catch(() => {});
  }, []);

  async function enviar(t) {
    const ok = await confirmar(
      'A partir daqui as peças saem da origem e ficam em trânsito. Elas não estarão '
      + 'disponíveis em lugar nenhum até alguém conferir a chegada.',
      { titulo: `Enviar para ${t.destino_nome}?`, confirmarTexto: 'Enviar', perigo: false }
    );
    if (!ok) return;
    setErro(''); setSucesso(''); setAvisos([]);
    try {
      const r = await api.post(`${BASE}/transferencias/${t.id}/enviar`);
      setSucesso('Carga em trânsito.');
      setAvisos(r.avisos || []);
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function estornar(t) {
    const motivo = window.prompt('Por que a carga voltou? (fica gravado na transferência)');
    if (!motivo) return;
    setErro(''); setSucesso('');
    try {
      await api.post(`${BASE}/transferencias/${t.id}/estornar`, { motivo });
      setSucesso('Estornada: as peças voltaram para o depósito de origem.');
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  async function baixarFalta(t) {
    const motivo = window.prompt('Baixar a falta como perda. Escreva o motivo:');
    if (!motivo) return;
    const ok = await confirmar(
      'Esta é a única ação desta tela que muda o total do estoque. Ela some com as peças que '
      + 'faltaram, com trilha e com o seu motivo escrito. Não tem como desfazer com um clique.',
      { titulo: 'Baixar a falta como perda?', confirmarTexto: 'Baixar como perda', perigo: true }
    );
    if (!ok) return;
    try {
      const r = await api.post(`${BASE}/transferencias/${t.id}/baixar-divergencia`, { motivo });
      setSucesso(`Baixa registrada em ${r.baixados.length} item(ns).`);
      if (r.ignorados?.length > 0) {
        setAvisos([`${r.ignorados.length} item(ns) de insumo não foram baixados: o total de insumo `
          + 'é mantido por outra máquina, e escrever um segundo caminho para o mesmo número é '
          + 'exatamente o que este módulo evita. Ajuste pelo estoque de insumos.']);
      }
      carregar();
    } catch (e) { setErro(mensagem(e)); }
  }

  const chips = [
    situacao && { chave: 's', rotulo: 'Situação', valor: rotuloSituacao(situacao), onRemover: () => setSituacao('') },
  ].filter(Boolean);

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Warehouse size={22} /> Depósitos e transferências</h1>
          <p className="ink-soft">
            Onde cada peça está, e o que está a caminho de onde.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn btn-ghost" onClick={() => setEditando(null)}>
            <Plus size={15} /> Novo depósito
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCriandoRemessa(true)}>
            <ArrowLeftRight size={15} /> Nova transferência
          </button>
          <button type="button" className="btn btn-ghost" onClick={carregar}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <p className="ink-soft ajuda-bloco">
        <Info size={14} /> Mandar não entrega: o envio tira da origem e põe em trânsito, e só o
        aceite credita o destino. É o que impede a Expedição de prometer peça que ainda está na van
        — e é o que faz a diferença entre o que saiu e o que chegou ter onde aparecer.
      </p>

      {erro && <p className="erro-inline">{erro}</p>}
      {sucesso && <p className="sucesso-inline"><Check size={14} /> {sucesso}</p>}
      {avisos.map((a, i) => <p className="aviso-inline" key={i}><AlertTriangle size={14} /> {a}</p>)}

      {/* 1. Indicadores ---------------------------------------------------- */}
      {!panorama && <Skeleton height={96} />}
      {panorama && (
        <div className="indicadores-linha">
          <IndicadorDestaque
            rotulo="Depósitos ativos"
            valor={formatQtd(panorama.depositos.filter((d) => d.ativo).length)}
            Icone={Warehouse}
            explicacao="Lugares onde o estoque pode estar endereçado. Depósito com saldo dentro não se apaga — se inativa."
          />
          <IndicadorDestaque
            rotulo="Peças em trânsito"
            valor={formatQtd(panorama.pecasEmTransito)}
            tom={panorama.pecasEmTransito > 0 ? 'atencao' : undefined}
            Icone={Truck}
            explicacao="Saiu de um depósito e ainda não foi conferido no outro. Não está disponível em lugar nenhum, de propósito."
          />
          <IndicadorDestaque
            rotulo="Peças sem depósito"
            valor={formatQtd(panorama.pecasSemDeposito)}
            Icone={MapPin}
            explicacao="Está numa natureza de lugar conhecida, mas ninguém disse em qual depósito. O sistema não chuta — e este número é o tamanho do que ainda falta endereçar."
          />
          <IndicadorDestaque
            rotulo="Peças fora do mapa"
            valor={formatQtd(panorama.pecasSemLocal)}
            tom={panorama.inconsistente ? 'prejuizo' : undefined}
            Icone={AlertTriangle}
            explicacao="Entram no total do estoque e não aparecem em detalhamento nenhum — nem depósito, nem natureza de lugar. É o saldo antigo, de antes de existir endereçamento. Diferente de 'sem depósito', que ao menos sabe se está aqui ou na facção."
          />
        </div>
      )}

      {panorama?.inconsistente && (
        <p className="erro-inline">
          O detalhamento por lugar está somando <strong>mais</strong> que o total do estoque. Isso é
          defeito de lançamento, não é possível na operação. Vale conferir os saldos por depósito
          antes de confiar nos números desta tela.
        </p>
      )}

      {/* 2. Depósitos ------------------------------------------------------ */}
      <div className="card">
        <h2 className="card-titulo"><Warehouse size={16} /> Depósitos</h2>
        {carregando && <Skeleton height={160} />}
        {!carregando && depositos.length === 0 && (
          <EstadoVazio
            Icone={Warehouse}
            titulo="Nenhum depósito ainda"
            descricao="Crie o primeiro para começar a dizer onde cada peça está."
          />
        )}
        {!carregando && depositos.length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Depósito</th><th>Natureza</th><th>Canal</th>
                  <th className="num">Peças</th><th className="num">Insumos</th>
                  <th>Vende daqui?</th><th />
                </tr>
              </thead>
              <tbody>
                {(panorama?.depositos || depositos).map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.nome}</strong> <span className="ink-soft">{d.codigo}</span>
                      {d.padrao && <span className="stamp sm tone-saudavel">padrão</span>}
                      {!d.ativo && <span className="stamp sm tone-neutro">inativo</span>}
                    </td>
                    <td>{rotuloNatureza(d.natureza)}</td>
                    <td>{d.canal ? (CANAIS.find((c) => c.valor === d.canal)?.rotulo || d.canal) : '—'}</td>
                    <td className="num">{formatQtd(d.pecas ?? 0)}</td>
                    <td className="num">{formatQtd(d.insumos ?? 0)}</td>
                    <td>{d.vendavel ? 'Sim' : 'Não'}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setEditando(depositos.find((x) => x.id === d.id) || d)}
                      >
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ink-soft">
          <Store size={13} /> Depósito de canal (ML Full, Shopee 3PL) entra como <strong>terceiro</strong>:
          a peça é nossa, está fisicamente lá, e não pode ser prometida para um pedido de outra
          plataforma.
        </p>
      </div>

      {/* 3. Transferências ------------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><ArrowLeftRight size={16} /> Transferências</h2>

        <div className="filtros-linha">
          <Select value={situacao} onChange={(e) => setSituacao(e.target.value)}>
            <option value="">Todas as situações</option>
            {SITUACOES.map((s) => <option key={s.valor} value={s.valor}>{s.rotulo}</option>)}
          </Select>
        </div>
        <ChipsFiltros itens={chips} onLimparTudo={() => setSituacao('')} />

        {carregando && <Skeleton height={200} />}
        {!carregando && transferencias.length === 0 && (
          <EstadoVazio
            Icone={ArrowLeftRight}
            titulo="Nenhuma transferência"
            descricao="Quando a carga sair de um depósito para outro, ela aparece aqui — com o que saiu e o que chegou."
          />
        )}
        {!carregando && transferencias.length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Documento</th><th>Rota</th><th>Situação</th>
                  <th className="num">Itens</th><th className="num">Quantidade</th>
                  <th>Divergência</th><th>Quando</th><th />
                </tr>
              </thead>
              <tbody>
                {transferencias.map((t) => (
                  <tr key={t.id}>
                    <td>{ouTraco(t.numero) === '—' ? `#${t.id}` : t.numero}</td>
                    <td>{t.origem_nome} → {t.destino_nome}</td>
                    <td>{rotuloSituacao(t.situacao)}</td>
                    <td className="num">{formatQtd(t.itens)}</td>
                    <td className="num">{formatQtd(t.quantidade)}</td>
                    <td className={Number(t.divergencias) > 0 ? 'tone-prejuizo' : ''}>
                      {t.situacao === 'recebida'
                        ? (Number(t.divergencias) > 0 ? `${t.divergencias} item(ns)` : 'Bateu')
                        : '—'}
                    </td>
                    <td>{tempoRelativo(t.recebido_em || t.enviado_em || t.criado_em)}</td>
                    <td className="num painel-acoes-inline">
                      {t.situacao === 'rascunho' && (
                        <button type="button" className="btn btn-primary" onClick={() => enviar(t)}>
                          <Truck size={13} /> Enviar
                        </button>
                      )}
                      {t.situacao === 'em_transito' && (
                        <>
                          <button type="button" className="btn btn-primary" onClick={() => setAceitando(t)}>
                            <PackageCheck size={13} /> Conferir
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => estornar(t)}>
                            <Undo2 size={13} /> Estornar
                          </button>
                        </>
                      )}
                      {t.situacao === 'recebida' && Number(t.divergencias) > 0 && (
                        <button type="button" className="btn btn-ghost" onClick={() => baixarFalta(t)}>
                          Baixar falta
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editando !== undefined && (
        <PainelDeposito
          deposito={editando}
          fornecedores={fornecedores}
          onFechar={() => setEditando(undefined)}
          onPronto={() => { setEditando(undefined); setSucesso('Depósito salvo.'); carregar(); }}
        />
      )}
      {criandoRemessa && (
        <PainelTransferencia
          depositos={depositos}
          onFechar={() => setCriandoRemessa(false)}
          onPronto={() => { setCriandoRemessa(false); setSucesso('Rascunho criado. O estoque só sai quando você mandar enviar.'); carregar(); }}
        />
      )}
      {aceitando && (
        <PainelAceite
          transferencia={aceitando}
          onFechar={() => setAceitando(null)}
          onPronto={(r) => {
            setAceitando(null);
            setSucesso('Chegada registrada.');
            setAvisos(r.divergencias.map((d) => (
              `${d.nome}: saíram ${formatQtd(d.enviada)} e chegaram ${formatQtd(d.recebida)}. `
              + `A diferença de ${formatQtd(Math.abs(d.diferenca))} voltou a ser saldo sem depósito e está marcada nesta transferência.`
            )));
            carregar();
          }}
        />
      )}
    </div>
  );
}
