import { useCallback, useEffect, useState } from 'react';
import {
  MapPin, RefreshCw, AlertTriangle, Info, Check, ArrowLeftRight, Truck, X, Pencil,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, IndicadorDestaque, Select, Field, NumInput, CampoBusca, Checkbox,
} from '../components/ui';
import { formatQtd, dataBr, tempoRelativo } from '../lib/format';

// Estoque › Onde Está a Peça.
//
// Duas perguntas que o sistema não respondia:
//   · em que prateleira está a referência? (endereço)
//   · quantas peças estão aqui e quantas estão na facção? (saldo por local)
//
// ⚠️ O que esta tela NÃO faz: mudar o saldo. O total da variante continua
// sendo o total do que é nosso, esteja onde estiver — movimento entre locais é
// soma zero. O que ela acrescenta é a repartição desse total, e o número novo
// que sai dela: DISPONÍVEL = total − o que está fora daqui.
//
// O saldo que já existia antes de 08/09/2026 entra como "não endereçado", de
// propósito. Presumir que ele está todo no galpão seria mentira para toda peça
// que está numa facção agora — que é justamente o caso que este módulo veio
// resolver. Quem sabe onde está é gente, e o botão de endereçar em lote existe
// para quando essa gente decidir.

function PainelMover({ item, locais, fornecedores, onFechar, onPronto }) {
  const [localOrigem, setLocalOrigem] = useState('proprio');
  const [fornOrigem, setFornOrigem] = useState('');
  const [localDestino, setLocalDestino] = useState('faccao');
  const [fornDestino, setFornDestino] = useState('');
  const [quantidade, setQuantidade] = useState(0);
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const defOrigem = locais[localOrigem];
  const defDestino = locais[localDestino];

  async function salvar() {
    setErro('');
    setSalvando(true);
    try {
      const r = await api.post('/estoque-locais/mover', {
        variante_id: item.varianteId,
        quantidade,
        local_origem: localOrigem,
        fornecedor_origem_id: fornOrigem || null,
        local_destino: localDestino,
        fornecedor_destino_id: fornDestino || null,
        motivo,
      });
      onPronto(r.aviso || `${formatQtd(quantidade)} peça(s) movida(s).`);
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="anuncio-painel-fundo" onClick={onFechar} role="presentation">
      <div className="anuncio-painel" onClick={(e) => e.stopPropagation()} role="presentation">
        <div className="anuncio-painel-topo">
          <strong>{item.referencia} · {item.cor} · {item.tamanho}</strong>
          <button type="button" className="btn-icone" onClick={onFechar} title="Fechar" aria-label="Fechar"><X size={16} /></button>
        </div>
        <div className="anuncio-painel-corpo">
          <p className="ink-soft ajuda-bloco">
            Total da variante: <strong>{formatQtd(item.total)}</strong> peça(s).
            {item.linhas.length > 0 && ` Hoje: ${item.linhas.map((l) => `${formatQtd(l.quantidade)} ${l.rotulo.toLowerCase()}${l.fornecedorNome ? ` (${l.fornecedorNome})` : ''}`).join(', ')}.`}
            {item.naoEnderecado > 0 && ` Ainda sem lugar: ${formatQtd(item.naoEnderecado)}.`}
          </p>

          <div className="form-linha">
            <Field label="Sai de">
              <Select value={localOrigem} onChange={(e) => setLocalOrigem(e.target.value)}>
                {Object.values(locais).map((l) => <option key={l.chave} value={l.chave}>{l.rotulo}</option>)}
              </Select>
            </Field>
            {defOrigem?.exigeFornecedor && (
              <Field label="De qual facção">
                <Select value={fornOrigem} onChange={(e) => setFornOrigem(e.target.value)} placeholder="Escolha a facção">
                  {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Vai para">
              <Select value={localDestino} onChange={(e) => setLocalDestino(e.target.value)}>
                {Object.values(locais).map((l) => <option key={l.chave} value={l.chave}>{l.rotulo}</option>)}
              </Select>
            </Field>
            {defDestino?.exigeFornecedor && (
              <Field label="Para qual facção">
                <Select value={fornDestino} onChange={(e) => setFornDestino(e.target.value)} placeholder="Escolha a facção">
                  {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Quantas peças">
              <NumInput value={quantidade} step="1" onChange={(v) => setQuantidade(v || 0)} />
            </Field>
            <Field label="Motivo" hint="Aparece no histórico da variante">
              <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: foi para lavanderia" />
            </Field>
          </div>

          {defDestino && !defDestino.disponivelParaVenda && (
            <p className="aviso-inline">
              <AlertTriangle size={14} />
              {defDestino.explicacao} Estas peças continuam no total do estoque e saem do disponível para venda.
            </p>
          )}
          {erro && <p className="erro-inline">{erro}</p>}
        </div>
        <div className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
          <button type="button" className="btn btn-primary" onClick={salvar} disabled={salvando || !(quantidade > 0)}>
            <ArrowLeftRight size={15} /> Mover
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EstoqueLocaisPage() {
  const [dados, setDados] = useState(null);
  const [faccao, setFaccao] = useState(null);
  const [fornecedores, setFornecedores] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [soPendentes, setSoPendentes] = useState(false);
  const [soForaDaqui, setSoForaDaqui] = useState(false);
  const [movendo, setMovendo] = useState(null);
  const [editandoEndereco, setEditandoEndereco] = useState(null);
  const [textoEndereco, setTextoEndereco] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams();
      if (buscaAplicada) qs.set('busca', buscaAplicada);
      if (soPendentes) qs.set('pendentes', 'true');
      if (soForaDaqui) qs.set('fora', 'true');
      const [d, f, forn] = await Promise.all([
        api.get(`/estoque-locais?${qs}`),
        api.get('/estoque-locais/faccao').catch(() => null),
        api.get('/producao/apoio').then((a) => a.fornecedores || []).catch(() => []),
      ]);
      setDados(d);
      setFaccao(f);
      setFornecedores(forn);
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [buscaAplicada, soPendentes, soForaDaqui]);

  useEffect(() => { carregar(); }, [carregar]);

  async function salvarEndereco(item) {
    try {
      await api.put(`/estoque-locais/variante/${item.varianteId}/endereco`, { localizacao: textoEndereco });
      setEditandoEndereco(null);
      await carregar();
    } catch (e) { setErro(e.message); }
  }

  async function enderecarLote() {
    const texto = 'Isto declara que TODO o saldo ainda sem lugar está no galpão.\n\n'
      + 'Se alguma dessas peças estiver numa facção agora, lance a remessa dela ANTES — '
      + 'senão o saldo dela vai passar a constar aqui dentro.\n\nConfirma?';
    // `confirmar()` do sistema em vez do window.confirm nativo: é o padrão do
    // projeto (components/ConfirmDialog) e o nativo chega a ser BLOQUEADO em
    // alguns navegadores quando a tela roda como aplicativo instalado.
    const ok = await confirmar(texto, { titulo: 'Endereçar tudo no galpão', confirmarTexto: 'Endereçar', perigo: true });
    if (!ok) return;
    setErro('');
    try {
      const r = await api.post('/estoque-locais/enderecar-lote', { confirmar: true });
      setAviso(`${r.variantes} variante(s) endereçadas no galpão. ${r.aviso}`);
      await carregar();
    } catch (e) { setErro(e.message); }
  }

  const r = dados?.resumo;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><MapPin size={22} /> Onde está a peça</h1>
          <p className="ink-soft">
            Em que prateleira ela mora, e quanto dela está aqui, na facção ou a caminho.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={carregar} disabled={carregando}>
            <RefreshCw size={15} className={carregando ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      {dados?.explicacao && <p className="ink-soft ajuda-bloco"><Info size={14} /> {dados.explicacao}</p>}
      {erro && <p className="erro-inline">{erro}</p>}
      {aviso && <p className="sucesso-inline"><Check size={14} /> {aviso}</p>}

      {r && (
        <div className="indicadores-linha">
          <IndicadorDestaque rotulo="Total no estoque" valor={formatQtd(r.total)} explicacao="Tudo que é nosso, esteja onde estiver." />
          <IndicadorDestaque
            rotulo="Disponível para vender"
            valor={formatQtd(r.disponivel)}
            explicacao="Total menos o que está fora daqui. É este número que sustenta o prazo prometido ao cliente."
          />
          <IndicadorDestaque
            rotulo="Fora daqui"
            valor={formatQtd(r.emTerceiro)}
            tom={r.emTerceiro > 0 ? 'atencao' : undefined}
            Icone={Truck}
            explicacao="Em facção, trânsito ou com terceiro. Continua sendo nosso e continua valendo dinheiro."
          />
          <IndicadorDestaque
            rotulo="Ainda sem lugar"
            valor={formatQtd(r.naoEnderecado)}
            tom={r.naoEnderecado > 0 ? 'atencao' : undefined}
            explicacao="Saldo anterior a este módulo. Ninguém disse ainda onde ele está — e o sistema não chuta."
          />
        </div>
      )}

      {r?.variantesInconsistentes > 0 && (
        <p className="erro-inline">
          {r.variantesInconsistentes} variante(s) têm mais peça endereçada do que peça no estoque.
          Isto é defeito de lançamento, não arredondamento — use o filtro e resolva antes de confiar
          no disponível.
        </p>
      )}
      {r?.variantesComNegativo > 0 && (
        <p className="aviso-inline">
          <AlertTriangle size={14} />
          {r.variantesComNegativo} variante(s) com saldo negativo em algum local: saiu mais peça de lá
          do que havia. Confira as remessas de facção dessas referências.
        </p>
      )}

      <div className="filtros-linha">
        <CampoBusca valor={busca} onChange={setBusca} onSubmit={() => setBuscaAplicada(busca)} placeholder="Referência, descrição ou endereço" />
        <label className="check-linha">
          <Checkbox checked={soPendentes} onChange={(e) => setSoPendentes(e.target.checked)} />
          Só o que falta endereçar
        </label>
        <label className="check-linha">
          <Checkbox checked={soForaDaqui} onChange={(e) => setSoForaDaqui(e.target.checked)} />
          Só o que está fora daqui
        </label>
        {r?.naoEnderecado > 0 && (
          <button type="button" className="btn-sec" onClick={enderecarLote}>
            Endereçar tudo que falta no galpão
          </button>
        )}
      </div>

      {carregando && <Skeleton height={280} />}

      {!carregando && faccao?.grupos?.length > 0 && (
        <div className="card">
          <h2 className="card-titulo"><Truck size={16} /> Peça pronta que está com facção</h2>
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr><th>Facção</th><th className="num">Peças</th><th className="num">Variantes</th><th>Mais antiga saiu</th></tr>
              </thead>
              <tbody>
                {faccao.grupos.map((g) => (
                  <tr key={g.fornecedorId ?? 0}>
                    <td><strong>{g.nome}</strong></td>
                    <td className="num">{formatQtd(g.pecas)}</td>
                    <td className="num">{formatQtd(g.variantes)}</td>
                    <td className="ink-soft">{g.maisAntigoEm ? `${dataBr(String(g.maisAntigoEm).slice(0, 10))} (${tempoRelativo(g.maisAntigoEm)})` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ink-soft ajuda-bloco">{faccao.explicacao}</p>
        </div>
      )}

      {!carregando && dados?.itens.length === 0 && (
        <EstadoVazio Icone={MapPin} titulo="Nenhuma variante nesse filtro" descricao="Ajuste a busca ou desmarque os filtros." />
      )}

      {!carregando && dados?.itens.length > 0 && (
        <div className="card">
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Referência</th><th>Cor</th><th>Tam.</th><th>Endereço</th>
                  <th className="num">Total</th><th className="num">Disponível</th>
                  <th>Onde está</th><th />
                </tr>
              </thead>
              <tbody>
                {dados.itens.map((i) => (
                  <tr key={i.varianteId} className={i.inconsistente ? 'linha-prejuizo' : (i.naoEnderecado > 0 ? 'linha-pendente' : undefined)}>
                    <td className="mono">{i.referencia}</td>
                    <td>{i.cor}</td>
                    <td>{i.tamanho}</td>
                    <td>
                      {editandoEndereco === i.varianteId ? (
                        <span className="painel-acoes-inline">
                          <input
                            value={textoEndereco}
                            onChange={(e) => setTextoEndereco(e.target.value)}
                            placeholder="Ex.: rua B / prat. 3"
                            style={{ maxWidth: 140 }}
                          />
                          <button type="button" className="btn-icone" onClick={() => salvarEndereco(i)} title="Salvar" aria-label="Salvar"><Check size={15} /></button>
                          <button type="button" className="btn-icone" onClick={() => setEditandoEndereco(null)} title="Cancelar" aria-label="Cancelar"><X size={15} /></button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn-icone"
                          title="Editar endereço"
                          onClick={() => { setEditandoEndereco(i.varianteId); setTextoEndereco(i.localizacao || ''); }}
                        >
                          {i.localizacao || <span className="ink-faint">sem endereço</span>} <Pencil size={13} />
                        </button>
                      )}
                    </td>
                    <td className="num">{formatQtd(i.total)}</td>
                    <td className={`num ${i.emTerceiro > 0 ? 'ink-atencao' : ''}`}>{formatQtd(i.disponivel)}</td>
                    <td className="ink-soft">
                      {i.linhas.length === 0 && i.naoEnderecado > 0 && <span className="selo tone-atencao">sem lugar</span>}
                      {i.linhas.map((l) => (
                        <span key={`${l.local}-${l.fornecedorId ?? 0}`} className={`selo ${l.disponivelParaVenda ? 'tone-saudavel' : 'tone-atencao'}`}>
                          {formatQtd(l.quantidade)} {l.rotulo}{l.fornecedorNome ? ` · ${l.fornecedorNome}` : ''}
                        </span>
                      ))}
                      {i.linhas.length > 0 && i.naoEnderecado > 0 && (
                        <span className="selo tone-neutro" title="Saldo anterior a este módulo, ainda sem lugar declarado">
                          {formatQtd(i.naoEnderecado)} sem lugar
                        </span>
                      )}
                    </td>
                    <td>
                      <button type="button" className="btn-sec" onClick={() => setMovendo(i)}>
                        <ArrowLeftRight size={14} /> Mover
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {movendo && (
        <PainelMover
          item={movendo}
          locais={dados.locais}
          fornecedores={fornecedores}
          onFechar={() => setMovendo(null)}
          onPronto={(msg) => { setMovendo(null); setAviso(msg); carregar(); }}
        />
      )}
    </div>
  );
}
