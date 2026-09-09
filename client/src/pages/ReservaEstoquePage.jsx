import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bookmark, AlertTriangle, Info, Check, X, RefreshCw, Timer, Lock, Unlock,
  ShieldAlert, PackageMinus, Save, Boxes, Plus,
} from 'lucide-react';
import { api } from '../api/client';
import {
  EstadoVazio, Skeleton, IndicadorDestaque, Select, Field, NumInput,
  CampoBusca, Checkbox, Toggle, ChipsFiltros,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { formatQtd, tempoRelativo } from '../lib/format';

// Estoque › Reserva.
//
// A tela existe por causa de UM número que hoje sai errado para os
// marketplaces: o saldo. Saldo é o que está no galpão; disponível é o que
// ainda pode ser vendido. A diferença entre os dois é a peça de pedido já
// pago e ainda não separada — ela está no galpão e NÃO pode ser vendida de
// novo. Sem essa separação, a mesma peça é anunciada na Shopee e no Mercado
// Livre ao mesmo tempo e um dos dois pedidos é cancelado por falta.
//
// O que a tela NÃO faz: reservar não move estoque (a peça continua no
// galpão), e nada é liberado sozinho — quem decide é gente. Só CONSUMIR
// baixa saldo de verdade, e isso está escrito na confirmação da ação.

const BASE = '/estoque-reserva';

const SITUACOES = [
  { valor: 'ativa', rotulo: 'Ativas' },
  { valor: 'consumida', rotulo: 'Consumidas' },
  { valor: 'liberada', rotulo: 'Liberadas' },
];

const ORIGENS = {
  pedido_venda: 'Pedido de venda',
  ordem_producao: 'Ordem de produção',
  manual: 'Manual',
};

const POLITICAS_NEGATIVO = [
  {
    valor: 'livre',
    rotulo: 'Livre',
    Icone: Unlock,
    frase: 'Deixa o disponível ficar negativo e não diz nada. Serve para quem vende peça'
      + ' que ainda vai ser produzida e não quer ser interrompido — o preço é descobrir o'
      + ' furo só na hora de separar.',
  },
  {
    valor: 'avisar',
    rotulo: 'Avisar',
    Icone: AlertTriangle,
    frase: 'Deixa a reserva acontecer, mas devolve um aviso escrito dizendo quanto falta.'
      + ' É o padrão do sistema: não trava a operação e ninguém fica sabendo depois.',
  },
  {
    valor: 'bloquear',
    rotulo: 'Bloquear',
    Icone: Lock,
    frase: 'Recusa a reserva que deixaria o disponível negativo. Nunca se promete peça que'
      + ' não existe — em troca, um pedido de peça a produzir passa a exigir a entrada no'
      + ' estoque antes.',
  },
];

const ouTraco = (valor) => (valor === null || valor === undefined || valor === '' ? '—' : valor);

// Reserva manual a partir de uma linha do disponível: é o único lugar da tela
// onde a quantidade reservada nasce à mão. O aviso que o backend devolve
// (política "avisar") sobe para a página inteira — engolir esse aviso seria
// exatamente o defeito que a tela veio evitar.
function PainelReservar({ item, onFechar, onPronto }) {
  const [quantidade, setQuantidade] = useState(1);
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    setErro('');
    setSalvando(true);
    try {
      const r = await api.post(`${BASE}/reservas`, {
        variante_id: item.variante_id,
        quantidade,
        origem_tipo: 'manual',
        motivo,
      });
      onPronto(r);
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
          <strong>
            {ouTraco(item.referencia)} · {ouTraco(item.cor)} · {ouTraco(item.tamanho)}
          </strong>
          <button type="button" className="btn-icone" onClick={onFechar} title="Fechar"><X size={16} /></button>
        </div>
        <div className="anuncio-painel-corpo">
          <p className="ink-soft ajuda-bloco">
            <Info size={14} /> Hoje esta variante tem <strong>{formatQtd(item.saldo)}</strong> no
            galpão, <strong>{formatQtd(item.reservado)}</strong> já reservado e
            <strong> {formatQtd(item.disponivel)}</strong> disponível para vender. Reservar não tira
            a peça do galpão: só tira do que ainda pode ser vendido.
          </p>
          <div className="form-linha">
            <Field label="Quantas peças">
              <NumInput value={quantidade} step="1" onChange={(v) => setQuantidade(v || 0)} />
            </Field>
            <Field label="Motivo" hint="Reserva sem motivo é reserva que ninguém libera depois">
              <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: separação do pedido 4120" />
            </Field>
          </div>
          {erro && <p className="erro-inline">{erro}</p>}
        </div>
        <div className="painel-rodape">
          <button type="button" className="btn-sec" onClick={onFechar}>Cancelar</button>
          <button type="button" className="btn btn-primary" disabled={salvando || !(quantidade > 0)} onClick={salvar}>
            <Bookmark size={15} /> Reservar
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ReservaEstoquePage() {
  const [indicadores, setIndicadores] = useState(null);
  const [erro, setErro] = useState('');
  const [avisos, setAvisos] = useState([]);
  const [sucesso, setSucesso] = useState('');

  // Disponível
  const [produtos, setProdutos] = useState([]);
  const [produtoId, setProdutoId] = useState('');
  const [soComReserva, setSoComReserva] = useState(false);
  const [soNegativos, setSoNegativos] = useState(false);
  const [busca, setBusca] = useState('');
  const [disponivel, setDisponivel] = useState(null);
  const [carregandoDisponivel, setCarregandoDisponivel] = useState(true);
  const [reservando, setReservando] = useState(null);

  // Reservas
  const [aba, setAba] = useState('ativa');
  const [reservas, setReservas] = useState([]);
  const [paradas, setParadas] = useState(null);
  const [carregandoReservas, setCarregandoReservas] = useState(true);
  const [liberando, setLiberando] = useState(null);
  const [motivoLiberacao, setMotivoLiberacao] = useState('');
  const [pedidoId, setPedidoId] = useState('');

  // Política
  const [politica, setPolitica] = useState(null);
  const [salvandoPolitica, setSalvandoPolitica] = useState(false);

  const carregarIndicadores = useCallback(async () => {
    try {
      const [comReserva, negativos, vencidas] = await Promise.all([
        api.get(`${BASE}/disponivel?com_reserva=true`),
        api.get(`${BASE}/disponivel?negativos=true`),
        api.get(`${BASE}/reservas/vencidas`),
      ]);
      const pecasReservadas = (comReserva.itens || []).reduce((s, i) => s + Number(i.reservado || 0), 0);
      setIndicadores({
        variantesComReserva: (comReserva.itens || []).length,
        pecasReservadas,
        variantesNegativas: negativos.variantes_negativas || 0,
        pecasTravadas: vencidas.total_pecas_travadas || 0,
        reservasParadas: (vencidas.reservas || []).length,
      });
    } catch (e) {
      setErro(e.message);
    }
  }, []);

  const carregarDisponivel = useCallback(async () => {
    setCarregandoDisponivel(true);
    try {
      const qs = new URLSearchParams();
      if (produtoId) qs.set('produto_id', produtoId);
      if (soComReserva) qs.set('com_reserva', 'true');
      if (soNegativos) qs.set('negativos', 'true');
      setDisponivel(await api.get(`${BASE}/disponivel?${qs}`));
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoDisponivel(false);
    }
  }, [produtoId, soComReserva, soNegativos]);

  const carregarReservas = useCallback(async () => {
    setCarregandoReservas(true);
    try {
      if (aba === 'paradas') {
        setParadas(await api.get(`${BASE}/reservas/vencidas`));
      } else {
        setReservas(await api.get(`${BASE}/reservas?situacao=${aba}`));
      }
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoReservas(false);
    }
  }, [aba]);

  useEffect(() => {
    api.get('/estoque/produtos-referencia').then(setProdutos).catch(() => setProdutos([]));
    api.get(`${BASE}/politica`).then(setPolitica).catch((e) => setErro(e.message));
  }, []);

  useEffect(() => { carregarIndicadores(); }, [carregarIndicadores]);
  useEffect(() => { carregarDisponivel(); }, [carregarDisponivel]);
  useEffect(() => { carregarReservas(); }, [carregarReservas]);

  function recarregarTudo() {
    carregarIndicadores();
    carregarDisponivel();
    carregarReservas();
  }

  // O backend devolve `aviso` (reserva avulsa) ou `avisos` (pedido inteiro).
  // Os dois caminhos passam por aqui de propósito: aviso descartado vira
  // saldo negativo que ninguém explica depois.
  function guardarAvisos(resposta) {
    const lista = [];
    if (resposta?.aviso) lista.push(resposta.aviso);
    if (Array.isArray(resposta?.avisos)) lista.push(...resposta.avisos);
    setAvisos(lista);
  }

  async function liberarReserva(reserva) {
    setErro('');
    try {
      await api.post(`${BASE}/reservas/${reserva.id}/liberar`, { motivo: motivoLiberacao });
      setLiberando(null);
      setMotivoLiberacao('');
      setSucesso(`Reserva de ${formatQtd(reserva.quantidade)} peça(s) liberada. O saldo voltou a ficar disponível.`);
      recarregarTudo();
    } catch (e) {
      setErro(e.message);
    }
  }

  async function consumirReserva(reserva) {
    const texto = `Consumir dá baixa no estoque de verdade: ${formatQtd(reserva.quantidade)} peça(s) `
      + 'saem do saldo do galpão e não voltam.\n\n'
      + 'Reservar apenas segurava a peça — ela continuava lá. Consumir é o movimento de saída, '
      + 'e só deve ser feito quando a peça foi separada e despachada.\n\nConfirma?';
    if (!(await confirmar(texto, { titulo: 'Consumir a reserva', confirmarTexto: 'Consumir e baixar o estoque' }))) return;
    setErro('');
    try {
      await api.post(`${BASE}/reservas/${reserva.id}/consumir`, {});
      setSucesso(`${formatQtd(reserva.quantidade)} peça(s) baixadas do estoque.`);
      recarregarTudo();
    } catch (e) {
      setErro(e.message);
    }
  }

  async function reservarPedido() {
    setErro('');
    setAvisos([]);
    try {
      const r = await api.post(`${BASE}/pedidos/${pedidoId}/reservar`, {});
      guardarAvisos(r);
      setSucesso(`${(r.reservas || []).length} item(ns) do pedido ${pedidoId} reservado(s).`);
      setPedidoId('');
      recarregarTudo();
    } catch (e) {
      setErro(e.message);
    }
  }

  async function salvarPolitica(campos) {
    setErro('');
    setSalvandoPolitica(true);
    try {
      setPolitica(await api.put(`${BASE}/politica`, campos));
      setSucesso('Política salva.');
      recarregarTudo();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvandoPolitica(false);
    }
  }

  const itensDisponivel = useMemo(() => {
    const lista = disponivel?.itens || [];
    const alvo = busca.trim().toLowerCase();
    if (!alvo) return lista;
    return lista.filter((i) => [i.referencia, i.produto_descricao, i.cor, i.tamanho, i.ean, i.localizacao]
      .some((c) => String(c || '').toLowerCase().includes(alvo)));
  }, [disponivel, busca]);

  const chipsDisponivel = [
    produtoId && {
      chave: 'produto',
      rotulo: 'Referência',
      valor: produtos.find((p) => String(p.id) === String(produtoId))?.referencia || produtoId,
      onRemover: () => setProdutoId(''),
    },
    soComReserva && { chave: 'com_reserva', rotulo: 'Mostrando', valor: 'só com reserva', onRemover: () => setSoComReserva(false) },
    soNegativos && { chave: 'negativos', rotulo: 'Mostrando', valor: 'só disponível negativo', onRemover: () => setSoNegativos(false) },
    busca.trim() && { chave: 'busca', rotulo: 'Busca', valor: busca.trim(), onRemover: () => setBusca('') },
  ].filter(Boolean);

  const temFiltroDisponivel = chipsDisponivel.length > 0;

  return (
    <div className="pagina">
      <header className="pagina-topo">
        <div>
          <h1><Bookmark size={22} /> Reserva de estoque</h1>
          <p className="ink-soft">
            Saldo é o que está no galpão; disponível é o que ainda pode ser vendido.
          </p>
        </div>
        <div className="pagina-acoes">
          <button type="button" className="btn-sec" onClick={recarregarTudo}>
            <RefreshCw size={15} className={carregandoDisponivel ? 'girando' : ''} /> Atualizar
          </button>
        </div>
      </header>

      <p className="ink-soft ajuda-bloco">
        <Info size={14} /> A diferença entre os dois números é o que está reservado para pedido já
        pago e ainda não separado. É isso que evita vender a mesma peça na Shopee e no Mercado
        Livre. Reservar não tira a peça do galpão — só tira do que ainda pode ser vendido.
      </p>

      {erro && <p className="erro-inline">{erro}</p>}
      {sucesso && <p className="sucesso-inline"><Check size={14} /> {sucesso}</p>}
      {avisos.map((a, i) => (
        <p className="aviso-inline" key={i}><AlertTriangle size={14} /> {a}</p>
      ))}

      {/* 1. Indicadores ---------------------------------------------------- */}
      {!indicadores && <Skeleton height={96} />}
      {indicadores && (
        <div className="indicadores-linha">
          <IndicadorDestaque
            rotulo="Variantes com reserva ativa"
            valor={formatQtd(indicadores.variantesComReserva)}
            Icone={Bookmark}
            explicacao="Cor e tamanho que têm peça segurada agora. Elas continuam no galpão, mas já têm dono."
          />
          <IndicadorDestaque
            rotulo="Peças reservadas"
            valor={formatQtd(indicadores.pecasReservadas)}
            Icone={Boxes}
            explicacao="Total de peças que estão no estoque e não podem ser vendidas de novo. É exatamente o que o marketplace não deveria enxergar."
          />
          <IndicadorDestaque
            rotulo="Disponível negativo"
            valor={formatQtd(indicadores.variantesNegativas)}
            tom={indicadores.variantesNegativas > 0 ? 'prejuizo' : undefined}
            Icone={ShieldAlert}
            explicacao="Variantes que já foram vendidas além do que existe no galpão. É peça prometida que não está lá — cada uma vira cancelamento se ninguém produzir ou comprar antes."
          />
          <IndicadorDestaque
            rotulo="Peças travadas em reserva parada"
            valor={formatQtd(indicadores.pecasTravadas)}
            tom={indicadores.pecasTravadas > 0 ? 'atencao' : undefined}
            Icone={Timer}
            explicacao="Reserva mais velha que o prazo da política e ainda ativa. Saldo que ninguém pode vender e ninguém separou — só sai daí quando alguém decidir."
          />
        </div>
      )}

      {/* 2. Disponível ----------------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><Boxes size={16} /> Disponível por variante</h2>
        <p className="ink-soft">
          Saldo menos reservado. É este número, e não o saldo, que deveria ir para as plataformas.
        </p>

        <div className="filtros-linha">
          <CampoBusca
            valor={busca}
            onChange={setBusca}
            placeholder="Referência, descrição, cor, tamanho, EAN ou local"
          />
          <Select value={produtoId} onChange={(e) => setProdutoId(e.target.value)} placeholder="Todas as referências" chaveRecentes="estoque_produto">
            <option value="">Todas as referências</option>
            {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
          </Select>
          <label className="check-linha">
            <Checkbox checked={soComReserva} onChange={(e) => setSoComReserva(e.target.checked)} />
            Só com reserva
          </label>
          <label className="check-linha">
            <Checkbox checked={soNegativos} onChange={(e) => setSoNegativos(e.target.checked)} />
            Só negativos
          </label>
        </div>

        <ChipsFiltros
          itens={chipsDisponivel}
          onLimparTudo={() => { setProdutoId(''); setSoComReserva(false); setSoNegativos(false); setBusca(''); }}
        />

        {disponivel?.variantes_negativas > 0 && (
          <p className="erro-inline">
            {formatQtd(disponivel.variantes_negativas)} variante(s) desta lista estão com disponível
            negativo: já se vendeu mais peça do que existe no galpão. Enquanto isso não for
            produzido, comprado ou liberado, algum pedido vai ser cancelado por falta.
          </p>
        )}

        {carregandoDisponivel && <Skeleton height={220} />}

        {!carregandoDisponivel && itensDisponivel.length === 0 && (
          <EstadoVazio
            Icone={Boxes}
            titulo={temFiltroDisponivel ? 'Nenhuma variante com esses filtros' : 'Nenhuma variante de estoque ainda'}
            descricao={temFiltroDisponivel
              ? 'Os filtros ligados acima estão recortando a lista — se pediu só negativos ou só com reserva, uma lista vazia é uma boa notícia: não há peça vendida a mais nem saldo travado.'
              : 'O disponível nasce das variantes de estoque (referência + cor + tamanho). Cadastre uma variante no Estoque e ela aparece aqui com saldo, reservado e disponível.'}
          />
        )}

        {!carregandoDisponivel && itensDisponivel.length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Referência</th>
                  <th>Produto</th>
                  <th>Cor</th>
                  <th>Tam.</th>
                  <th>Local</th>
                  <th className="num">Saldo</th>
                  <th className="num">Reservado</th>
                  <th className="num">Disponível</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {itensDisponivel.map((i) => {
                  const negativa = Number(i.disponivel) < 0;
                  return (
                    <tr key={i.variante_id} className={negativa ? 'linha-prejuizo' : undefined}>
                      <td className="mono">{ouTraco(i.referencia)}</td>
                      <td>{ouTraco(i.produto_descricao)}</td>
                      <td>{ouTraco(i.cor)}</td>
                      <td>{ouTraco(i.tamanho)}</td>
                      <td className="ink-soft">{i.localizacao || '—'}</td>
                      <td className="num">{formatQtd(i.saldo)}</td>
                      <td className="num">{Number(i.reservado) > 0 ? formatQtd(i.reservado) : '—'}</td>
                      <td className="num">
                        {negativa
                          ? <span className="selo tone-prejuizo" title="Peça vendida que não existe no galpão">{formatQtd(i.disponivel)}</span>
                          : formatQtd(i.disponivel)}
                      </td>
                      <td>
                        <button type="button" className="btn-sec" onClick={() => setReservando(i)}>
                          <Plus size={14} /> Reservar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 3. Reservas ------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><Bookmark size={16} /> Reservas</h2>
        <p className="ink-soft">
          Reserva não se apaga: ou é <strong>liberada</strong> (o pedido caiu e o saldo volta a ser
          vendável) ou <strong>consumida</strong> (a peça saiu de verdade e o estoque baixa). As
          duas ficam no histórico com data e responsável.
        </p>

        <div className="subtab-row">
          {SITUACOES.map((s) => (
            <button
              key={s.valor}
              type="button"
              className={'subtab-btn' + (aba === s.valor ? ' active' : '')}
              onClick={() => setAba(s.valor)}
            >
              {s.rotulo}
            </button>
          ))}
          <button
            type="button"
            className={'subtab-btn' + (aba === 'paradas' ? ' active' : '')}
            onClick={() => setAba('paradas')}
          >
            <Timer size={14} /> Paradas
            {indicadores?.reservasParadas > 0 ? ` (${formatQtd(indicadores.reservasParadas)})` : ''}
          </button>
        </div>

        <div className="filtros-linha">
          <Field label="Reservar um pedido de venda inteiro" hint="Reserva todos os itens do pedido de uma vez; item sem variante identificada volta como aviso">
            <input
              value={pedidoId}
              onChange={(e) => setPedidoId(e.target.value.replace(/\D/g, ''))}
              placeholder="Nº do pedido"
            />
          </Field>
          <button type="button" className="btn-sec" disabled={!pedidoId} onClick={reservarPedido}>
            <Bookmark size={14} /> Reservar o pedido
          </button>
        </div>

        {aba === 'paradas' && paradas && (
          <p className="aviso-inline">
            <AlertTriangle size={14} />
            {formatQtd(paradas.total_pecas_travadas)} peça(s) travadas em {formatQtd((paradas.reservas || []).length)} reserva(s)
            parada(s) há mais tempo que a política permite. Nada é liberado automaticamente — a
            decisão é de quem opera: ou o pedido voltou a andar, ou a reserva precisa ser liberada
            à mão.
          </p>
        )}

        {carregandoReservas && <Skeleton height={200} />}

        {!carregandoReservas && aba !== 'paradas' && reservas.length === 0 && (
          <EstadoVazio
            Icone={Bookmark}
            titulo={`Nenhuma reserva ${aba}`}
            descricao={aba === 'ativa'
              ? 'Nada está segurando saldo agora: disponível é igual ao saldo em todas as variantes. Reservas nascem de um pedido de venda reservado ou de uma reserva manual na lista de disponível acima.'
              : 'Aqui aparecem as reservas já resolvidas. Enquanto ninguém liberar nem consumir uma reserva, esta lista fica vazia.'}
          />
        )}

        {!carregandoReservas && aba !== 'paradas' && reservas.length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Cor</th>
                  <th>Tam.</th>
                  <th className="num">Qtd.</th>
                  <th>Origem</th>
                  <th>Motivo</th>
                  <th className="num">Dias parada</th>
                  <th>Quem criou</th>
                  {aba === 'ativa' && <th />}
                </tr>
              </thead>
              <tbody>
                {reservas.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="mono">{ouTraco(r.referencia)}</span>
                      {r.produto_descricao ? ` · ${r.produto_descricao}` : ''}
                    </td>
                    <td>{ouTraco(r.cor)}</td>
                    <td>{ouTraco(r.tamanho)}</td>
                    <td className="num">{formatQtd(r.quantidade)}</td>
                    <td>
                      {ORIGENS[r.origem_tipo] || r.origem_tipo || '—'}
                      {r.origem_id ? <span className="mono"> nº {r.origem_id}</span> : ''}
                    </td>
                    <td className="ink-soft">{ouTraco(r.motivo)}</td>
                    <td className="num">
                      {r.dias_parada === null || r.dias_parada === undefined
                        ? '—'
                        : `${formatQtd(r.dias_parada)} d`}
                    </td>
                    <td className="ink-soft">
                      {ouTraco(r.usuario_nome)}
                      {r.criado_em ? <span className="ink-faint"> · {tempoRelativo(r.criado_em)}</span> : ''}
                    </td>
                    {aba === 'ativa' && (
                      <td>
                        {liberando === r.id ? (
                          <span className="painel-acoes-inline">
                            <input
                              value={motivoLiberacao}
                              onChange={(e) => setMotivoLiberacao(e.target.value)}
                              placeholder="Motivo da liberação (obrigatório)"
                            />
                            <button
                              type="button"
                              className="btn-icone"
                              title="Confirmar a liberação"
                              disabled={!motivoLiberacao.trim()}
                              onClick={() => liberarReserva(r)}
                            >
                              <Check size={15} />
                            </button>
                            <button type="button" className="btn-icone" title="Cancelar" onClick={() => setLiberando(null)}>
                              <X size={15} />
                            </button>
                          </span>
                        ) : (
                          <span className="painel-acoes-inline">
                            <button
                              type="button"
                              className="btn-sec"
                              onClick={() => { setLiberando(r.id); setMotivoLiberacao(''); }}
                            >
                              <Unlock size={14} /> Liberar
                            </button>
                            <button type="button" className="btn-sec" onClick={() => consumirReserva(r)}>
                              <PackageMinus size={14} /> Consumir
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!carregandoReservas && aba === 'paradas' && (paradas?.reservas || []).length === 0 && (
          <EstadoVazio
            Icone={Timer}
            titulo="Nenhuma reserva parada"
            descricao="Toda reserva ativa está dentro do prazo de validade da política. Quando uma passar do prazo sem ser separada, ela aparece aqui para alguém decidir — o sistema não libera sozinho."
          />
        )}

        {!carregandoReservas && aba === 'paradas' && (paradas?.reservas || []).length > 0 && (
          <div className="tabela-rolagem">
            <table className="tabela-nota">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Cor</th>
                  <th>Tam.</th>
                  <th className="num">Qtd.</th>
                  <th>Origem</th>
                  <th>Motivo</th>
                  <th className="num">Dias parada</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {paradas.reservas.map((r) => (
                  <tr key={r.id} className="linha-pendente">
                    <td>
                      <span className="mono">{ouTraco(r.referencia)}</span>
                      {r.produto_descricao ? ` · ${r.produto_descricao}` : ''}
                    </td>
                    <td>{ouTraco(r.cor)}</td>
                    <td>{ouTraco(r.tamanho)}</td>
                    <td className="num">{formatQtd(r.quantidade)}</td>
                    <td>
                      {ORIGENS[r.origem_tipo] || r.origem_tipo || '—'}
                      {r.origem_id ? <span className="mono"> nº {r.origem_id}</span> : ''}
                    </td>
                    <td className="ink-soft">{ouTraco(r.motivo)}</td>
                    <td className="num">
                      <span className="selo tone-atencao">{formatQtd(r.dias_parada)} d</span>
                    </td>
                    <td>
                      {liberando === r.id ? (
                        <span className="painel-acoes-inline">
                          <input
                            value={motivoLiberacao}
                            onChange={(e) => setMotivoLiberacao(e.target.value)}
                            placeholder="Motivo da liberação (obrigatório)"
                          />
                          <button
                            type="button"
                            className="btn-icone"
                            title="Confirmar a liberação"
                            disabled={!motivoLiberacao.trim()}
                            onClick={() => liberarReserva(r)}
                          >
                            <Check size={15} />
                          </button>
                          <button type="button" className="btn-icone" title="Cancelar" onClick={() => setLiberando(null)}>
                            <X size={15} />
                          </button>
                        </span>
                      ) : (
                        <span className="painel-acoes-inline">
                          <button
                            type="button"
                            className="btn-sec"
                            onClick={() => { setLiberando(r.id); setMotivoLiberacao(''); }}
                          >
                            <Unlock size={14} /> Liberar
                          </button>
                          <button type="button" className="btn-sec" onClick={() => consumirReserva(r)}>
                            <PackageMinus size={14} /> Consumir
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 4. Política ------------------------------------------------------- */}
      <div className="card">
        <h2 className="card-titulo"><ShieldAlert size={16} /> Política de reserva</h2>
        <p className="ink-soft">
          O que o sistema faz quando uma reserva deixaria o disponível negativo — e por quanto tempo
          uma reserva pode ficar parada antes de aparecer na fila de quem decide.
        </p>

        {!politica && <Skeleton height={140} />}

        {politica && (
          <>
            <div className="grid-3">
              {POLITICAS_NEGATIVO.map((o) => (
                <div className="card" key={o.valor}>
                  <label className="check-linha">
                    <Checkbox
                      checked={politica.negativo === o.valor}
                      disabled={salvandoPolitica}
                      onChange={() => salvarPolitica({ negativo: o.valor })}
                      aria-label={`Política de estoque negativo: ${o.rotulo}`}
                    />
                    <o.Icone size={15} /> <strong>{o.rotulo}</strong>
                    {politica.negativo === o.valor && <span className="selo tone-saudavel">em uso</span>}
                  </label>
                  <p className="ink-soft">{o.frase}</p>
                </div>
              ))}
            </div>

            <div className="form-linha">
              <Field
                label="Reserva automática ao importar pedido"
                hint="Nasce DESLIGADA: ligar muda o saldo que vai para os marketplaces"
              >
                <label className="check-linha">
                  <Toggle
                    checked={Boolean(politica.reserva_automatica)}
                    disabled={salvandoPolitica}
                    onChange={() => salvarPolitica({ reserva_automatica: !politica.reserva_automatica })}
                  />
                  {politica.reserva_automatica ? 'Ligada' : 'Desligada'}
                </label>
              </Field>
              <Field
                label="Dias de validade da reserva"
                hint="Passado o prazo, a reserva aparece na aba Paradas — ninguém é liberado sozinho"
              >
                <NumInput
                  value={politica.dias_validade_reserva}
                  step="1"
                  disabled={salvandoPolitica}
                  onChange={(v) => setPolitica({ ...politica, dias_validade_reserva: v })}
                  onBlur={() => salvarPolitica({ dias_validade_reserva: Number(politica.dias_validade_reserva) || 0 })}
                />
              </Field>
            </div>

            <p className="ink-soft ajuda-bloco">
              <Info size={14} /> Com a reserva automática desligada, todo pedido importado continua
              sem segurar saldo — é o comportamento de hoje. Ao ligar, cada pedido importado passa a
              reservar as peças na hora, e o número que sobe para Shopee, Mercado Livre e demais
              canais deixa de ser o saldo do galpão e passa a ser o disponível. É uma decisão de
              operação, não um ajuste técnico.
              {politica.atualizado_em && (
                <span className="ink-faint"> Última alteração {tempoRelativo(politica.atualizado_em)}.</span>
              )}
            </p>
          </>
        )}
      </div>

      {reservando && (
        <PainelReservar
          item={reservando}
          onFechar={() => setReservando(null)}
          onPronto={(r) => {
            setReservando(null);
            guardarAvisos(r);
            setSucesso(r?.ajustada
              ? 'Reserva já existente para esta origem foi ajustada — não foi somada duas vezes.'
              : `Reserva de ${formatQtd(r?.reserva?.quantidade)} peça(s) criada. A peça continua no galpão; só saiu do disponível.`);
            recarregarTudo();
          }}
        />
      )}
    </div>
  );
}
