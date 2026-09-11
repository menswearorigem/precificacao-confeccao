import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Warehouse, RefreshCw, X, ExternalLink, Factory, Truck, AlertTriangle,
  Timer, CalendarClock, TrendingUp, TrendingDown, LayoutGrid, Table2,
  Settings2, Send, Info, CheckCircle2, Ban, Sparkles, History, Printer,
  Boxes, ArrowRight, Flame, Layers, Link2, Search, ShoppingBag, Plus, Trash2, Eye,
} from 'lucide-react';
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../api/client';
import {
  EstadoVazio, Select, MultiSelect, Skeleton, CampoBusca, ChipsFiltros, FiltrosAvancados,
  IndicadorDestaque, Paginacao, Checkbox, Toggle, Field, BotaoExportar,
} from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import FullRemessaImpressao from '../components/FullRemessaImpressao';
import { useTabela } from '../lib/useTabela';
import { brl, numeroBr, formatQtd, dataBr, tempoRelativo } from '../lib/format';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import { SeloPlataforma, nomeDaLoja, chaveDaPlataforma } from '../lib/canalMarketplace';
import { usePaletaGrafico } from '../lib/coresGrafico';

// Marketplace › Full.
//
// A tela do estoque que a casa tem e não vê: o que está dentro do centro de
// distribuição do marketplace. Ele não aparece no Wik, não entra na Cobertura
// e não entra na Projeção de Estoque — some do controle sem sair do
// patrimônio. Enquanto isso é ele que decide se o anúncio continua ganhando
// vitrine ou cai.
//
// A tela responde, na ordem em que a pergunta aparece na vida real:
//
//   1. o que está lá dentro, e com que cara (foto, loja, preço, saldo);
//   2. desde quando está lá, e o que já foi mandado (primeiro envio, último,
//      histórico completo);
//   3. quanto vendeu e como foi o desempenho;
//   4. quanto tempo o saldo ainda dura;
//   5. qual o mínimo para o anúncio não cair;
//   6. quanto mandar, e até que dia a caixa precisa sair daqui;
//   7. dessas peças, quantas já estão na casa e quantas precisam ser
//      PRODUZIDAS — que é o botão "plano de produção".
//
// A REGRA DOS 30 DIAS, que é o miolo do cálculo e a coisa que a tela mais
// precisa deixar clara: um anúncio que está no Full há menos de 30 dias tem a
// velocidade medida pela venda GERAL dele, incluindo o período em que ainda
// não estava lá. Acima de 30, pela venda recente. Cada cartão diz qual das
// duas bases usou — "dura 12 dias" medido de dois jeitos são dois números
// diferentes, e quem decide precisa saber qual está lendo.

const URGENCIAS = {
  ruptura: { rotulo: 'Zerado no Full', tom: 'perigo', Icone: Flame, peso: 6 },
  atrasado: { rotulo: 'Envio atrasado', tom: 'perigo', Icone: AlertTriangle, peso: 5 },
  urgente: { rotulo: 'Mandar esta semana', tom: 'atencao', Icone: CalendarClock, peso: 4 },
  // O anúncio como um todo está abastecido, mas alguma COR já zerou lá
  // dentro. Não é ruptura do anúncio (dizer isso com 362 peças no Full seria
  // mentira) e também não é "tudo bem".
  cor_zerada: { rotulo: 'Cor zerada no Full', tom: 'atencao', Icone: Layers, peso: 3 },
  planejar: { rotulo: 'Planejar envio', tom: 'neutro', Icone: Truck, peso: 2 },
  ok: { rotulo: 'Abastecido', tom: 'bom', Icone: CheckCircle2, peso: 1 },
  ignorado: { rotulo: 'Fora da reposição', tom: 'neutro', Icone: Ban, peso: 0 },
  sem_medida: { rotulo: 'Sem venda para medir', tom: 'neutro', Icone: Info, peso: 0 },
};

const OPCOES_URGENCIA = [
  { valor: 'ruptura', rotulo: 'Zerado no Full' },
  { valor: 'atrasado', rotulo: 'Envio atrasado' },
  { valor: 'urgente', rotulo: 'Mandar esta semana' },
  { valor: 'cor_zerada', rotulo: 'Cor zerada no Full' },
  { valor: 'planejar', rotulo: 'Planejar envio' },
  { valor: 'ok', rotulo: 'Abastecido' },
  { valor: 'sem_medida', rotulo: 'Sem venda para medir' },
];

// Os períodos que a casa costuma querer que um envio dure. O campo livre
// continua ao lado — a lista é atalho, não limite.
const PERIODOS_RAPIDOS = [15, 30, 45, 60, 90];

const JANELAS_VENDA = [
  { valor: 7, rotulo: 'últimos 7 dias' },
  { valor: 14, rotulo: 'últimos 14 dias' },
  { valor: 30, rotulo: 'últimos 30 dias' },
  { valor: 60, rotulo: 'últimos 60 dias' },
  { valor: 90, rotulo: 'últimos 90 dias' },
];

function fotoDoFull(a) {
  return a.fotoUrl || (a.produtoTemFoto && a.produtoId ? `/api/produtos/${a.produtoId}/foto` : null);
}

function fotoDeReservaFull(a) {
  return a.fotoUrl && a.produtoTemFoto && a.produtoId ? `/api/produtos/${a.produtoId}/foto` : null;
}

// A foto do anúncio com duas quedas, igual à aba de Anúncios: endereço
// gravado → foto do cadastro → a referência escrita por extenso. Nunca um
// ícone de imagem quebrada, nunca um quadrado cinza mudo.
function FotoFull({ anuncio, alturaAuto }) {
  const [falhou, setFalhou] = useState(false);
  const [tentouReserva, setTentouReserva] = useState(false);
  const principal = fotoDoFull(anuncio);
  const reserva = fotoDeReservaFull(anuncio);
  const foto = falhou ? null : (tentouReserva ? reserva : principal);

  useEffect(() => { setFalhou(false); setTentouReserva(false); }, [anuncio.chave, principal]);

  if (foto) {
    return (
      <img
        src={foto}
        alt=""
        loading="lazy"
        decoding="async"
        style={alturaAuto ? { height: 'auto' } : undefined}
        // A CDN do Mercado Livre recusa requisição com referer de outro site.
        referrerPolicy="no-referrer"
        onError={() => {
          if (!tentouReserva && reserva) setTentouReserva(true);
          else setFalhou(true);
        }}
      />
    );
  }
  return (
    <div className="full-foto-vazia">
      {anuncio.referencia || anuncio.anuncioIdExterno}
      <small>{falhou ? 'foto não abriu' : 'sem foto'}</small>
    </div>
  );
}

// A barra de cobertura. Mostra três coisas no mesmo desenho: onde está o
// saldo de hoje, onde fica o mínimo e até onde vai o alvo. É o gráfico que
// responde "está apertado?" antes de qualquer número ser lido.
function BarraCobertura({ reposicao, velocidade }) {
  const cobertura = reposicao.coberturaDias;
  const alvo = reposicao.diasAlvo || 60;
  const minimoDias = reposicao.diasDeMinimo || 0;

  if (cobertura == null) {
    return (
      <div className="full-barra full-barra-vazia" title={velocidade?.motivo || 'Sem venda medida no período.'}>
        <span>sem medida de venda</span>
      </div>
    );
  }
  const escala = Math.max(alvo, cobertura, minimoDias || 1);
  const largura = Math.min(100, (cobertura / escala) * 100);
  const marcaMinimo = Math.min(100, (minimoDias / escala) * 100);
  const tom = cobertura <= minimoDias ? 'perigo' : (cobertura <= minimoDias * 1.6 ? 'atencao' : 'bom');

  return (
    <div
      className={`full-barra tom-${tom}`}
      title={`Cobertura de ${numeroBr(cobertura, 1)} dias. O mínimo para ficar de pé no Full é ${minimoDias} dias de venda; `
        + `o alvo desta tela é ${alvo} dias.`}
    >
      <div className="full-barra-trilho">
        <div className="full-barra-preenchida" style={{ width: `${largura}%` }} />
        {minimoDias > 0 && <span className="full-barra-marca" style={{ left: `${marcaMinimo}%` }} />}
      </div>
      <span className="full-barra-rotulo">{numeroBr(cobertura, 1)} d</span>
    </div>
  );
}

function SeloUrgencia({ urgencia, compacto }) {
  const u = URGENCIAS[urgencia] || URGENCIAS.sem_medida;
  const Icone = u.Icone;
  return (
    <span className={`full-selo tom-${u.tom}${compacto ? ' compacto' : ''}`}>
      <Icone size={compacto ? 10 : 12} /> {u.rotulo}
    </span>
  );
}

// Quanto tempo está no Full, dito do jeito que alguém fala. O número cru de
// dias fica no title — é ele que se confere.
function tempoNoFull(dias) {
  if (dias == null) return 'entrada não registrada';
  if (dias < 1) return 'entrou hoje';
  if (dias === 1) return 'há 1 dia';
  if (dias < 60) return `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  return `há ${meses} meses`;
}

// Uma data de prazo que já passou não pode ser apresentada como prazo. O
// painel mostrava "as peças têm que estar lá em 21/08" com 21/08 no mês
// passado, o que não quer dizer nada — o que a pessoa precisa ler é que o
// prazo venceu e há quantos dias.
function Prazo({ data, hoje, sufixoFuturo }) {
  if (!data) return <>—</>;
  const dias = hoje ? diasEntreIso(hoje, data) : null;
  if (dias == null) return <>{dataBr(data)}</>;
  if (dias < 0) {
    return (
      <span className="full-prazo-vencido" title={`Venceu em ${dataBr(data)}`}>
        venceu há {Math.abs(dias)} {Math.abs(dias) === 1 ? 'dia' : 'dias'}
      </span>
    );
  }
  return <>{dataBr(data)}{sufixoFuturo || ''}</>;
}

// Dias entre duas datas ISO, do jeito que o servidor calcula (meio-dia UTC,
// para o horário de verão não tirar nem pôr um dia).
function diasEntreIso(de, ate) {
  const a = new Date(`${de}T12:00:00Z`).getTime();
  const b = new Date(`${ate}T12:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// A unidade importa: num anúncio de kit, o Full conta KITS e a fábrica conta
// PEÇAS. Escrever "pç/dia" onde o número é de kits foi o que escondeu um erro
// de três vezes na cobertura (ver migration 0073).
function textoBaseVelocidade(velocidade, ehKit) {
  if (velocidade?.porDia == null) return 'sem venda na base medida';
  return `${numeroBr(velocidade.porDia, 2)} ${ehKit ? 'kit' : 'pç'}/dia · ${velocidade.rotuloBase}`;
}

// ---------------------------------------------------------------------------
// A faixa de lojas
// ---------------------------------------------------------------------------
// Mesma ideia da faixa da aba de Anúncios: dizer de relance o que cada loja
// tem lá dentro e quando foi lida pela última vez. A diferença é a bandeira
// `temLeitura` — loja de plataforma que este sistema ainda não sabe ler
// aparece DIZENDO isso, em vez de aparecer com zero e mentir.
function FaixaLojasFull({ lojas, onSincronizar, sincronizando }) {
  if (!lojas || lojas.length === 0) return null;
  return (
    <div className="full-lojas">
      {lojas.map((l) => {
        const chave = chaveDaPlataforma(l.marketplace);
        return (
          <div key={l.id} className={`full-loja plataforma-${chave}${l.temLeitura ? '' : ' sem-leitura'}`}>
            <SeloPlataforma chave={chave} size={20} />
            <div className="full-loja-corpo">
              <strong>{nomeDaLoja(l)}</strong>
              {!l.temLeitura ? (
                <span className="full-loja-aviso" title={l.motivoSemLeitura || ''}>
                  fulfillment ainda não lido nesta plataforma
                </span>
              ) : !l.conectada ? (
                <span className="full-loja-aviso">loja não conectada</span>
              ) : (
                <span className="full-loja-numeros">
                  <b>{formatQtd(l.anuncios_no_full || 0)}</b> anúncios ·{' '}
                  <b>{l.pecas_no_full != null ? formatQtd(l.pecas_no_full) : '—'}</b> peças
                </span>
              )}
              <span className="full-loja-data">
                {l.em_andamento
                  ? 'lendo agora…'
                  : l.ultima_sincronizacao
                    ? `lido ${tempoRelativo(l.ultima_sincronizacao)}`
                    : 'nunca lido'}
              </span>
              {l.ultimo_erro && <span className="full-loja-erro" title={l.ultimo_erro}>última leitura falhou</span>}
              {!l.ultimo_erro && l.ultimo_aviso && (
                <span className="full-loja-aviso" title={l.ultimo_aviso}>histórico de remessa incompleto</span>
              )}
            </div>
            {l.temLeitura && l.conectada && (
              <button
                type="button"
                className="icon-btn"
                title={`Ler o fulfillment de ${nomeDaLoja(l)} agora`}
                disabled={sincronizando}
                onClick={() => onSincronizar(l.id)}
              >
                <RefreshCw size={13} className={l.em_andamento ? 'girando' : ''} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// O cartão
// ---------------------------------------------------------------------------
function CartaoFull({ anuncio, marcado, onMarcar, onAbrir, hoje }) {
  const chave = chaveDaPlataforma(anuncio.marketplace);
  const r = anuncio.reposicao;
  const enviar = r.precisaEnviar;

  return (
    <article className={`full-card plataforma-${chave}${marcado ? ' selecionado' : ''} urgencia-${r.urgencia}`}>
      <div className="full-card-faixa" />
      {/* Link esticado: o cartão inteiro clica, mas continua sendo um
          <article>, então a caixa de seleção cabe dentro dele. */}
      <button type="button" className="full-card-alvo" onClick={onAbrir}>
        Abrir {anuncio.titulo || 'anúncio'}
      </button>

      <div className="full-card-foto">
        <FotoFull anuncio={anuncio} />
        <span className="full-card-loja">
          <SeloPlataforma chave={chave} size={13} />
          <span>{nomeDaLoja({ marketplace: anuncio.marketplace, nome: anuncio.lojaNome })}</span>
        </span>
        <span className="full-card-selecao">
          <Checkbox checked={marcado} onChange={onMarcar} aria-label={`Marcar ${anuncio.titulo || 'anúncio'}`} />
        </span>
        <span className="full-card-tempo" title={anuncio.desde ? `No fulfillment desde ${dataBr(anuncio.desde)}` : undefined}>
          <Warehouse size={10} /> {tempoNoFull(anuncio.diasNoFull)}
        </span>
      </div>

      <div className="full-card-corpo">
        <p className="full-card-titulo">{anuncio.titulo || '(sem título)'}</p>
        <div className="full-card-ref">
          <span>{anuncio.referencia || 'sem vínculo no cadastro'}</span>
          <span className="full-card-preco">{anuncio.preco != null ? brl(anuncio.preco) : '—'}</span>
        </div>

        <div className="full-card-saldos">
          <span
            className={anuncio.leitura?.completa === false ? 'full-saldo-parcial' : undefined}
            title={anuncio.leitura?.completa === false
              ? (anuncio.saldo.disponivel != null
                ? `Pelo menos ${formatQtd(anuncio.saldo.disponivel)} peças: ${anuncio.leitura.naoLidas} de `
                  + `${anuncio.leitura.unidades} variações não tiveram o saldo lido nesta sincronização.`
                : 'Nenhuma variação deste anúncio teve o saldo lido na última sincronização.')
              : 'Peças disponíveis para venda dentro do centro de distribuição'}
          >
            <Warehouse size={11} />
            {/* O "≥" só faz sentido na frente de um número. Sem saldo lido, o
                que se mostra é o travessão — "≥ 0 peças" seria o zero
                afirmativo que este aviso existe para evitar. */}
            {anuncio.leitura?.completa === false && anuncio.saldo.disponivel != null && '≥ '}
            {anuncio.saldo.disponivel != null ? formatQtd(anuncio.saldo.disponivel) : '—'}
            <small>{anuncio.ehKit ? 'kits no Full' : 'no Full'}</small>
          </span>
          <span title="Peças já despachadas e ainda não disponíveis lá dentro">
            <Truck size={11} /> {anuncio.saldo.emTransito != null ? formatQtd(anuncio.saldo.emTransito) : '—'}
            <small>a caminho</small>
          </span>
          <span
            title={'Saldo da mesma peça no nosso galpão, já descontada a reserva de pedido de cliente — '
              + 'é o que pode sair amanhã, sem produzir nada.'
              + (anuncio.estoqueCasaReservado ? ` Há ${formatQtd(anuncio.estoqueCasaReservado)} peças reservadas, fora desta conta.` : '')
              + (anuncio.unidades?.[0]?.estoqueCasaOrigem === 'referencia'
                ? ' Nesta loja o fulfillment é lido no nível do anúncio, então o saldo mostrado é o da referência inteira, somando todas as cores.'
                : '')}
          >
            <Boxes size={11} /> {anuncio.estoqueCasa != null ? formatQtd(anuncio.estoqueCasa) : '—'}
            <small>na casa</small>
          </span>
        </div>

        <BarraCobertura reposicao={r} velocidade={anuncio.velocidade} />

        {/* Com a barra já dizendo "sem medida de venda", repetir a mesma
            frase aqui embaixo era ruído. Só aparece quando há o que dizer. */}
        <div className="full-card-velocidade" title={anuncio.velocidade.motivo}>
          {anuncio.velocidade.porDia != null
            ? textoBaseVelocidade(anuncio.velocidade, anuncio.ehKit)
            : (anuncio.referencia ? '' : ' ')}
          {anuncio.velocidade.base === 'geral' && anuncio.velocidade.porDia != null && (
            <span className="full-tag-base" title={anuncio.velocidade.motivo}>venda geral</span>
          )}
        </div>
      </div>

      <div className="full-card-acao">
        {enviar > 0 ? (
          <>
            <span className="full-card-enviar">
              <Send size={12} /> mandar <b>{formatQtd(enviar)}</b>{' '}
              {anuncio.ehKit
                ? <>kits <small>({formatQtd(enviar * anuncio.pecasPorUnidade)} peças)</small></>
                : 'peças'}
            </span>
            <span className="full-card-quando">
              {r.dataLimiteEnvio
                ? <>sair daqui até <b><Prazo data={r.dataLimiteEnvio} hoje={hoje} /></b></>
                : 'sem data calculável'}
            </span>
          </>
        ) : (
          <span className="full-card-enviar sem">
            {r.urgencia === 'ignorado' ? 'fora da reposição' : 'nada a mandar agora'}
          </span>
        )}
        <SeloUrgencia urgencia={r.urgencia} compacto />
        {anuncio.leitura?.completa === false && (
          <span
            className="full-card-parcial"
            title={`${anuncio.leitura.naoLidas} de ${anuncio.leitura.unidades} variações não tiveram o saldo lido. `
              + 'Os números deste cartão são um piso, não o total.'}
          >
            <AlertTriangle size={10} /> leitura incompleta
          </span>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// A tabela (para varrer muita coisa de uma vez)
// ---------------------------------------------------------------------------
function TabelaFull({ itens, marcados, onMarcar, onAbrir, hoje }) {
  return (
    <div className="data-table-outer">
      <div className="data-table-wrap">
        <table className="data-table full-tabela">
          <thead>
            <tr>
              <th style={{ width: 34 }} />
              <th>Anúncio</th>
              <th>Loja</th>
              <th className="num">No Full</th>
              <th className="num">A caminho</th>
              <th className="num">Na casa</th>
              <th className="num">Venda/dia</th>
              <th className="num">Dura</th>
              <th className="num">Mínimo</th>
              <th className="num">Mandar</th>
              <th>Sair até</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((a) => (
              <tr key={a.chave} className="clickable-row" onClick={() => onAbrir(a)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={marcados.has(a.chave)}
                    onChange={() => onMarcar(a.chave)}
                    aria-label={`Marcar ${a.titulo || a.anuncioIdExterno}`}
                  />
                </td>
                <td className="col-truncar">
                  <div className="full-linha-titulo">
                    <span className="full-linha-foto"><FotoFull anuncio={a} /></span>
                    <span>
                      <b>{a.titulo || a.anuncioIdExterno}</b>
                      <small>{a.referencia || 'sem vínculo'} · {tempoNoFull(a.diasNoFull)}</small>
                    </span>
                  </div>
                </td>
                <td>
                  <span className="full-linha-loja">
                    <SeloPlataforma chave={chaveDaPlataforma(a.marketplace)} size={13} />
                    {nomeDaLoja({ marketplace: a.marketplace, nome: a.lojaNome })}
                  </span>
                </td>
                <td className="num">{a.saldo.disponivel != null ? formatQtd(a.saldo.disponivel) : '—'}</td>
                <td className="num">{a.saldo.emTransito != null ? formatQtd(a.saldo.emTransito) : '—'}</td>
                <td className="num">{a.estoqueCasa != null ? formatQtd(a.estoqueCasa) : '—'}</td>
                <td className="num" title={a.velocidade.motivo}>
                  {a.velocidade.porDia != null ? numeroBr(a.velocidade.porDia, 2) : '—'}
                </td>
                <td className="num">
                  {a.reposicao.coberturaDias != null ? `${numeroBr(a.reposicao.coberturaDias, 1)} d` : '—'}
                </td>
                <td className="num">{a.reposicao.estoqueMinimo != null ? formatQtd(a.reposicao.estoqueMinimo) : '—'}</td>
                <td className="num"><b>{a.reposicao.precisaEnviar ? formatQtd(a.reposicao.precisaEnviar) : '—'}</b></td>
                <td><Prazo data={a.reposicao.dataLimiteEnvio} hoje={hoje} /></td>
                <td><SeloUrgencia urgencia={a.reposicao.urgencia} compacto /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// O painel de um anúncio
// ---------------------------------------------------------------------------
function PainelFull({ alvo, janela, diasAlvo, onFechar, onAlterado }) {
  const [dado, setDado] = useState(null);
  const [aba, setAba] = useState('resumo');
  const [erro, setErro] = useState('');
  const painelRef = useRef(null);
  const focoAnterior = useRef(null);

  const recarregar = useCallback(() => {
    const p = new URLSearchParams();
    p.set('janela', String(janela));
    if (diasAlvo) p.set('dias_alvo', String(diasAlvo));
    api.get(`/full/anuncios/${alvo.integracaoId}/${encodeURIComponent(alvo.anuncioIdExterno)}?${p}`)
      .then(setDado)
      .catch((e) => setErro(e.message));
  }, [alvo.integracaoId, alvo.anuncioIdExterno, janela, diasAlvo]);

  useEffect(recarregar, [recarregar]);

  // Esc fecha, o foco entra no painel e volta para onde estava ao sair —
  // mesma armadilha de foco da aba de Anúncios.
  useEffect(() => {
    focoAnterior.current = document.activeElement;
    painelRef.current?.focus();
    function aoTeclar(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onFechar(); return; }
      if (e.key !== 'Tab') return;
      const foco = painelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!foco || foco.length === 0) return;
      const primeiro = foco[0];
      const ultimo = foco[foco.length - 1];
      if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
    }
    document.addEventListener('keydown', aoTeclar);
    const anterior = focoAnterior.current;
    return () => {
      document.removeEventListener('keydown', aoTeclar);
      anterior?.focus?.();
    };
  }, [onFechar]);

  const a = dado?.anuncio;

  return (
    <>
      <div className="anuncio-painel-fundo" onClick={onFechar} aria-hidden="true" />
      <aside
        className="anuncio-painel full-painel"
        ref={painelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={a?.titulo || 'Detalhe do anúncio no fulfillment'}
      >
        <div className="anuncio-painel-topo">
          <SeloPlataforma chave={a?.marketplace} size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, lineHeight: 1.35 }}>
              {a?.titulo || <Skeleton height={13} width="70%" />}
            </div>
            <div className="page-sub" style={{ margin: '2px 0 0', fontSize: 11 }}>
              {a && `${nomeDaLoja({ marketplace: a.marketplace, nome: a.lojaNome })} · ${a.anuncioIdExterno}`}
            </div>
          </div>
          {a?.url && (
            <a className="icon-btn" href={a.url} target="_blank" rel="noreferrer" title="Abrir na plataforma">
              <ExternalLink size={14} />
            </a>
          )}
          <button className="icon-btn" onClick={onFechar} title="Fechar (Esc)" aria-label="Fechar (Esc)"><X size={16} /></button>
        </div>

        <div className="subtab-row" style={{ padding: '0 18px' }}>
          {/* A aba de Composição aparece SEMPRE. Escondê-la atrás de
              `ehKit` criava um impasse: `ehKit` vem do padrão de SKU, então
              um kit cujo SKU não segue o padrão nunca virava kit, nunca podia
              registrar a composição, e o plano mandava produzir uma peça por
              kit vendido — um terço do necessário. */}
          {[['resumo', 'Resumo'], ['vendas', 'Vendas'], ['estoque', 'Saldo no Full'], ['envios', 'Envios'],
            ['variacoes', 'Cores e tamanhos'], ['composicao', 'Composição'], ['ajustes', 'Ajustes']]
            .map(([chave, rotulo]) => (
              <button
                key={chave}
                type="button"
                className={'subtab-btn' + (aba === chave ? ' active' : '')}
                onClick={() => setAba(chave)}
              >
                {rotulo}
              </button>
          ))}
        </div>

        <div className="anuncio-painel-corpo">
          {erro && <div className="login-error">{erro}</div>}
          {!dado ? <Skeleton height={240} /> : (
            <>
              {aba === 'resumo' && <AbaResumoFull a={a} hoje={dado.hoje} onVinculado={() => { recarregar(); onAlterado(); }} />}
              {aba === 'vendas' && <AbaVendasFull alvo={alvo} a={a} />}
              {aba === 'estoque' && <AbaEstoqueFull a={a} curva={dado.curva} />}
              {aba === 'composicao' && (
                <AbaComposicaoFull a={a} onGravado={() => { recarregar(); onAlterado(); }} />
              )}
              {aba === 'envios' && (
                <AbaEnviosFull a={a} envios={dado.envios} onAlterado={() => { recarregar(); onAlterado(); }} />
              )}
              {aba === 'variacoes' && <AbaVariacoesFull a={a} />}
              {aba === 'ajustes' && <AbaAjustesFull a={a} onGravado={() => { recarregar(); onAlterado(); }} />}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Linha({ rotulo, valor, ajuda, forte }) {
  return (
    <div className="full-linha-dado" title={ajuda}>
      <span>{rotulo}</span>
      <b className={forte ? 'forte' : undefined}>{valor}</b>
    </div>
  );
}

function AbaResumoFull({ a, hoje, onVinculado }) {
  const r = a.reposicao;
  const d = a.desempenho;
  const tendencia = d.tendencia;

  return (
    <>
      <div className="full-resumo-topo">
        <div className="full-resumo-foto"><FotoFull anuncio={a} alturaAuto /></div>
        <div className="full-resumo-cabeca">
          <SeloUrgencia urgencia={r.urgencia} />
          <div className="full-resumo-grande">
            {r.coberturaDias != null
              ? <><b>{numeroBr(r.coberturaDias, 1)}</b> dias de estoque no Full</>
              : <span className="full-sem-medida">sem venda para medir a duração</span>}
          </div>
          <p className="full-resumo-motivo">{a.velocidade.motivo}</p>
          {r.dataRuptura && (
            <p className="full-resumo-motivo">
              No ritmo de agora, o saldo zera em <b>{dataBr(r.dataRuptura)}</b>.
            </p>
          )}
        </div>
      </div>

      {a.reposicao.coresZeradas?.parcial && (
        <div className="full-aviso">
          <Layers size={14} />
          <span>
            <b>{a.reposicao.coresZeradas.quantidade} de {a.reposicao.coresZeradas.total} cores</b> já estão zeradas
            dentro do centro de distribuição{a.reposicao.coresZeradas.nomes.length > 0
              ? <> ({a.reposicao.coresZeradas.nomes.join(', ')})</> : null}.
            O anúncio como um todo ainda tem saldo — os números acima são do anúncio inteiro. A aba
            <b> Cores e tamanhos</b> mostra cor por cor.
          </span>
        </div>
      )}

      {a.ehKit && (
        <div className="full-aviso full-aviso-info">
          <Info size={14} />
          <span>
            Este anúncio é vendido em <b>kit de {a.pecasPorUnidade}</b>. O centro de distribuição conta
            <b> unidades do anúncio</b> (kits), então saldo, velocidade, mínimo e "mandar" estão em kits. O plano
            de produção converte para peças — uma unidade lá dentro são {a.pecasPorUnidade} peças aqui.
          </span>
        </div>
      )}

      {!a.referencia && <VincularReferencia anuncio={a} onVinculado={onVinculado} />}

      <div className="card-head">O que fazer</div>
      <div className="full-blocos">
        <div className="full-bloco destaque">
          <span className="full-bloco-rotulo">Mandar</span>
          <span className="full-bloco-valor">{r.precisaEnviar != null ? formatQtd(r.precisaEnviar) : '—'}</span>
          <small>
            {a.ehKit
              ? <>kits — {formatQtd((r.precisaEnviar || 0) * a.pecasPorUnidade)} peças —, para o envio durar {r.diasAlvo} dias</>
              : <>peças, para o envio durar {r.diasAlvo} dias</>}
          </small>
        </div>
        <div className="full-bloco">
          <span className="full-bloco-rotulo">Peças têm que estar lá</span>
          <span className="full-bloco-valor"><Prazo data={r.dataPrecisaEstarLa} hoje={hoje} /></span>
          <small>quando o saldo encosta no mínimo de {formatQtd(r.estoqueMinimo || 0)} peças</small>
        </div>
        <div className="full-bloco">
          <span className="full-bloco-rotulo">Sair daqui até</span>
          <span className="full-bloco-valor"><Prazo data={r.dataLimiteEnvio} hoje={hoje} /></span>
          <small>
            {r.diasAteLimite != null
              ? (r.diasAteLimite < 0
                ? `o prazo já venceu — descontando ${a.parametros.lead_time_dias} dias de recebimento`
                : `faltam ${r.diasAteLimite} dias`)
              : `descontando ${a.parametros.lead_time_dias} dias de recebimento`}
          </small>
        </div>
        <div className="full-bloco">
          <span className="full-bloco-rotulo">Mínimo no Full</span>
          <span className="full-bloco-valor">{r.estoqueMinimo != null ? formatQtd(r.estoqueMinimo) : '—'}</span>
          <small>
            {r.estoqueMinimoManual != null
              ? 'definido à mão'
              : r.estoqueMinimoParcial
                ? `parte à mão, parte calculada (${r.diasDeMinimo} dias de venda)`
                : `${r.diasDeMinimo} dias de venda (recebimento + segurança)`}
          </small>
        </div>
      </div>

      <div className="card-head">Onde estão as peças</div>
      <Linha
        rotulo={a.ehKit ? 'Disponível no Full (kits)' : 'Disponível no Full'}
        valor={a.saldo.disponivel != null
          ? (a.ehKit
            ? `${formatQtd(a.saldo.disponivel)} · ${formatQtd(a.saldo.disponivel * a.pecasPorUnidade)} peças`
            : formatQtd(a.saldo.disponivel))
          : '—'}
        forte
      />
      <Linha
        rotulo="Indisponível no Full"
        valor={a.saldo.indisponivel != null ? formatQtd(a.saldo.indisponivel) : '—'}
        ajuda="Peça que está no centro de distribuição mas não pode ser vendida: reservada para pedido, em conferência ou avariada."
      />
      <Linha
        rotulo="A caminho do Full"
        valor={a.saldo.emTransito != null ? formatQtd(a.saldo.emTransito) : '—'}
        ajuda={'O maior entre o que a plataforma declara em trânsito e o que a nossa expedição registrou como '
          + 'despachado e ainda não recebido. Somar os dois contaria a mesma remessa duas vezes assim que a '
          + 'plataforma passasse a enxergá-la.'
          + (a.saldo.emTransitoRegistrado ? ` Registrado por nós: ${formatQtd(a.saldo.emTransitoRegistrado)} peças.` : '')
          + (a.saldo.emTransitoPlataforma != null ? ` Declarado pela plataforma: ${formatQtd(a.saldo.emTransitoPlataforma)}.` : '')}
      />
      <Linha
        rotulo="No nosso galpão"
        valor={a.estoqueCasa != null ? formatQtd(a.estoqueCasa) : '—'}
        ajuda={'Saldo da mesma peça no estoque da casa, já descontada a reserva de pedido de cliente — peça '
          + 'reservada não pode ser prometida ao Full.'
          + (a.estoqueCasaReservado ? ` Reservadas: ${formatQtd(a.estoqueCasaReservado)}.` : '')}
      />
      {a.leitura?.completa === false && (
        <div className="full-aviso" style={{ marginTop: 10 }}>
          <AlertTriangle size={14} />
          <span>
            <b>{a.leitura.naoLidas} de {a.leitura.unidades} variações</b> não tiveram o saldo lido na última
            sincronização, então os totais acima são um piso e não o número fechado.
            {a.leitura.motivos.length > 0 && <> Motivo: {a.leitura.motivos.join(' · ')}</>}
          </span>
        </div>
      )}

      <div className="card-head">Tempo no fulfillment</div>
      <Linha rotulo="Está no Full" valor={tempoNoFull(a.diasNoFull)} ajuda={a.desde ? `Primeiro dia observado: ${dataBr(a.desde)}` : undefined} />
      <Linha rotulo="Primeiro envio" valor={a.envio.primeiro ? dataBr(a.envio.primeiro) : 'não registrado'} />
      <Linha rotulo="Último envio" valor={a.envio.ultimo ? dataBr(a.envio.ultimo) : 'não registrado'} />
      <Linha rotulo="Envios registrados" valor={`${formatQtd(a.envio.envios)} · ${formatQtd(a.envio.pecas)} peças`} />

      <div className="card-head">Como foi o desempenho</div>
      <Linha
        rotulo={`Vendas ${a.ehKit ? 'em kits' : 'em peças'} (${a.velocidade.rotuloBase})`}
        valor={d.vendasDaBase != null
          ? (a.ehKit
            ? `${formatQtd(d.vendasDaBase)} · ${formatQtd(d.vendasDaBase * a.pecasPorUnidade)} peças`
            : formatQtd(d.vendasDaBase))
          : '—'}
        ajuda={'É o número que a velocidade usou — a mesma base escrita no rótulo, e na mesma unidade que o '
          + 'centro de distribuição conta.'}
        forte
      />
      <Linha
        rotulo="Vendas na janela recente"
        valor={`${formatQtd(d.vendasJanela)} ${a.ehKit ? 'kits' : 'peças'}`}
        ajuda="A janela recente, para comparar com o período anterior logo abaixo."
      />
      <Linha
        rotulo="Contra o período anterior"
        valor={tendencia != null
          ? <span className={tendencia >= 0 ? 'full-sobe' : 'full-desce'}>
            {tendencia >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {' '}{numeroBr(Math.abs(tendencia) * 100, 0)}%
          </span>
          : 'sem período anterior para comparar'}
      />
      <Linha rotulo="Receita no período" valor={d.receitaJanela != null ? brl(d.receitaJanela) : '—'} />
      <Linha rotulo="Ticket médio" valor={d.ticketMedio != null ? brl(d.ticketMedio) : '—'} />
      <Linha
        rotulo="Vendas acumuladas do anúncio"
        valor={d.vendasTotalAnuncio != null
          ? `${formatQtd(d.vendasTotalAnuncio)} ${a.ehKit ? 'kits' : 'peças'}${d.pecasTotal != null && a.ehKit ? ` · ${formatQtd(d.pecasTotal)} peças` : ''}`
          : '—'}
        ajuda="Peças e vendas são medidas diferentes: um kit de três é uma venda e três peças."
      />
      <Linha rotulo="Visitas (plataforma)" valor={d.visitas != null ? formatQtd(d.visitas) : '—'} />
      <Linha
        rotulo="Conversão (plataforma)"
        valor={d.conversao != null ? `${numeroBr(d.conversao * 100, 2)}%` : '—'}
        ajuda={'Venda acumulada dividida por visitas acumuladas, as duas informadas pela própria plataforma e '
          + 'no mesmo período. Não usa a nossa contagem de pedidos, que só alcança até onde a importação foi — '
          + 'dividir uma pela outra daria uma conversão menor que a real.'
          + (d.vendasPlataforma != null ? ` A plataforma informa ${formatQtd(d.vendasPlataforma)} vendas acumuladas.` : '')}
      />
      <Linha rotulo="Última venda" valor={d.ultimaVenda ? `${dataBr(d.ultimaVenda)} (${d.diasSemVender} dias)` : 'sem venda registrada'} />
      <Linha
        rotulo="Dias zerado no Full"
        valor={d.diasRetratados > 0
          ? `${formatQtd(d.diasZerado)} de ${formatQtd(d.diasRetratados)} dias observados`
          : 'ainda sem dias observados'}
        ajuda={'O sistema guarda um retrato por dia do saldo no centro de distribuição. '
          + 'Dia zerado é venda perdida que não aparece em relatório nenhum. '
          + (d.primeiroRetrato ? `O primeiro retrato desta peça é de ${dataBr(d.primeiroRetrato)}.` : '')}
      />
    </>
  );
}

// Vincular o anúncio a uma referência sem sair da tela.
//
// Sem vínculo, o item do Full não tem saldo de casa nem plano de produção — e
// é aqui, olhando o anúncio, que a pessoa percebe que falta. Mandá-la à aba
// Anúncios para achar o mesmo anúncio de novo era o caminho mais longo entre
// o problema e a solução.
function VincularReferencia({ anuncio, onVinculado }) {
  const [busca, setBusca] = useState('');
  const [opcoes, setOpcoes] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState('');

  const skuLido = anuncio.unidades.map((u) => u.sku).filter(Boolean)[0] || null;

  useEffect(() => {
    if (busca.trim().length < 2) { setOpcoes([]); return undefined; }
    // Espera a pessoa parar de digitar: uma consulta por tecla encheria o
    // servidor de buscas que ninguém vai ler.
    const t = setTimeout(() => {
      setCarregando(true);
      api.get(`/full/referencias?busca=${encodeURIComponent(busca.trim())}`)
        .then(setOpcoes)
        .catch((e) => setErro(e.message))
        .finally(() => setCarregando(false));
    }, 300);
    return () => clearTimeout(t);
  }, [busca]);

  async function vincular(produtoId) {
    setGravando(true);
    setErro('');
    try {
      const r = await api.put(`/full/anuncios/${anuncio.anuncioId}/vinculo`, { produto_id: produtoId });
      if (r.composicoesRemovidas > 0) {
        // A composição descreve o trio de UMA referência. Trocada a
        // referência, ela não vale mais — e quem trocou precisa saber que vai
        // ter de registrar de novo, em vez de descobrir na fábrica.
        setErro(`Vinculado. Atenção: ${r.composicoesRemovidas} linha(s) de composição de kit foram apagadas `
          + 'porque eram da referência anterior — registre o kit de novo na aba Composição.');
      }
      onVinculado();
    } catch (e) {
      setErro(e.message);
    } finally {
      setGravando(false);
    }
  }

  return (
    <div className="full-vincular">
      <div className="full-vincular-topo">
        <Link2 size={14} />
        <div>
          <b>Este anúncio não está vinculado a nenhuma referência</b>
          <small>
            Sem vínculo não há saldo da casa nem plano de produção — o cálculo de quanto mandar continua valendo,
            mas não dá para saber o que produzir.
            {skuLido
              ? <> O SKU lido da plataforma foi <code>{skuLido}</code>, e ele não bateu com nenhuma referência do cadastro.</>
              : <> A plataforma não devolveu SKU para este anúncio, então não havia por onde casar.</>}
          </small>
        </div>
      </div>
      <div className="full-vincular-busca">
        <Search size={13} />
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Procurar referência ou descrição…"
          aria-label="Procurar a referência do cadastro"
        />
      </div>
      {carregando && <Skeleton height={18} />}
      {opcoes.length > 0 && (
        <ul className="full-vincular-lista">
          {opcoes.map((p) => (
            <li key={p.id}>
              <button type="button" disabled={gravando} onClick={() => vincular(p.id)}>
                <b>{p.referencia}</b>
                <span>{p.descricao}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {busca.trim().length >= 2 && !carregando && opcoes.length === 0 && (
        <p className="full-nota" style={{ borderTop: 0, paddingTop: 0 }}>Nenhuma referência encontrada com esse texto.</p>
      )}
      {erro && <div className="login-error" style={{ marginTop: 8 }}>{erro}</div>}
    </div>
  );
}

// A quantidade vendida, com clareza — foi o que a dona pediu: um lugar que
// responda "quanto este anúncio vendeu" sem precisar interpretar velocidade,
// cobertura ou base de medição.
//
// Três leituras da mesma venda: o total do período, a curva dia a dia e a
// grade cor × tamanho, que é como a produção pensa.
// A COMPOSIÇÃO DO KIT — o que sai da expedição quando uma unidade daquela
// variação é vendida.
//
// Existe porque o kit da casa é SORTIDO: uma unidade do "Kit 3" são três
// camisas de cores diferentes, em combinação fixa por variação. O padrão de
// SKU ("KIT-3-REF-COR-TAM") descreve outra coisa — três peças iguais —, e o
// plano montado em cima dele manda cortar o triplo de uma cor e nenhuma das
// outras duas.
//
// "Aplicar a todas as variações" não é conveniência: um anúncio de dez
// tamanhos exigiria dez preenchimentos idênticos, e o resultado previsível é
// ninguém preencher nenhum. O trio de cores se repete; o tamanho vem de cada
// variação.
function AbaComposicaoFull({ a, onGravado }) {
  const [itemId, setItemId] = useState(a.unidades[0]?.id ?? null);
  const [dados, setDados] = useState(null);
  const [linhas, setLinhas] = useState([]);
  // Nasce DESLIGADO. Ligado por padrão, um "gravar" feito para corrigir uma
  // quantidade no tamanho M apagava os trios já registrados de P, G, GG e
  // XGG — sem aviso e sem desfazer.
  const [aplicarEmTodas, setAplicarEmTodas] = useState(false);
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  const carregar = useCallback(() => {
    if (!itemId) return;
    setDados(null);
    api.get(`/full/itens/${itemId}/composicao`)
      .then((r) => {
        setDados(r);
        if (r.composicao.length > 0) {
          setLinhas(r.composicao.map((c) => ({
            produtoId: c.produtoId, cor: c.cor, tamanho: c.tamanho, quantidade: c.quantidade,
          })));
        } else if (r.sugestao?.linhas) {
          // A sugestão veio do NOME da variação ("Preto-Marinho-Marrom"), com
          // todas as partes batendo com cores do cadastro. Já é o trio certo
          // na maioria dos casos — falta só conferir e gravar.
          setLinhas(r.sugestao.linhas.map((l) => ({ ...l })));
        } else if (r.sugestao) {
          setLinhas([{ ...r.sugestao }]);
        } else {
          setLinhas([]);
        }
      })
      .catch((e) => setErro(e.message));
  }, [itemId]);

  useEffect(carregar, [carregar]);

  function mudar(i, campo, valor) {
    setLinhas((atual) => atual.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)));
  }

  function acrescentar() {
    const base = dados?.sugestao || linhas[0] || {};
    setLinhas((atual) => [...atual, {
      produtoId: base.produtoId ?? dados?.item?.produtoId ?? null,
      cor: '',
      tamanho: base.tamanho ?? dados?.item?.tamanho ?? '',
      quantidade: 1,
    }]);
  }

  async function gravar(e) {
    e.preventDefault();
    setErro('');
    setAviso('');
    setGravando(true);
    try {
      if (aplicarEmTodas) {
        const outrasComComposicao = a.unidades
          .filter((u) => u.id !== itemId && (u.composicao?.length || 0) > 0).length;
        if (outrasComComposicao > 0) {
          const segue = await confirmar(
            `${outrasComComposicao} outra(s) variação(ões) deste anúncio já têm composição própria. `
            + 'Repetir esta vai apagar as delas e colocar este trio no lugar, com o tamanho de cada uma. '
            + 'Não dá para desfazer.',
            { titulo: 'Sobrescrever composições já registradas?', confirmarTexto: 'Sobrescrever' }
          );
          if (!segue) { setGravando(false); return; }
        }
      }
      const r = await api.put(`/full/itens/${itemId}/composicao`, {
        linhas: linhas.map((l) => ({
          produto_id: l.produtoId,
          cor: l.cor,
          tamanho: l.tamanho,
          quantidade: Number(l.quantidade) || 0,
        })),
        aplicar_em_todas: aplicarEmTodas,
      });
      setAviso(`Composição gravada em ${r.aplicadaEm} variação(ões).`
        + (r.sobrescreveu > 0 ? ` ${r.sobrescreveu} tinha(m) composição própria e foi(ram) substituída(s).` : ''));
      carregar();
      onGravado();
    } catch (err) {
      setErro(err.message);
    } finally {
      setGravando(false);
    }
  }

  const total = linhas.reduce((acc, l) => acc + (Number(l.quantidade) || 0), 0);
  const coresDoCadastro = [...new Set((dados?.variantes || []).map((v) => v.cor).filter(Boolean))];
  const tamanhosDoCadastro = [...new Set((dados?.variantes || []).map((v) => v.tamanho).filter(Boolean))];

  return (
    <>
      <p className="page-sub" style={{ marginTop: 0 }}>
        O que sai da expedição quando <b>uma unidade</b> desta variação é vendida. É daqui que o plano de produção
        tira o que cortar — sem isto, ele supõe que o kit é de uma cor só e manda o triplo de uma, zero das
        outras.
      </p>
      {dados?.sugestao?.origem === 'nome-da-variacao' && (
        <div className="full-aviso full-aviso-info">
          <Info size={14} />
          <span>
            As linhas abaixo vieram do <b>nome da variação</b> — cada parte bateu com uma cor do cadastro desta
            referência. Confira e grave; nada foi gravado sozinho.
          </span>
        </div>
      )}

      {a.unidades.length > 1 && (
        <Field label="Variação do anúncio" hint="A composição é por variação. Grave uma e mande repetir nas outras.">
          <Select value={String(itemId ?? '')} onChange={(e) => setItemId(Number(e.target.value))}>
            {a.unidades.map((u) => (
              <option key={u.id} value={u.id}>
                {[u.cor, u.tamanho].filter(Boolean).join(' · ') || u.sku || `variação ${u.variacaoIdExterna}`}
                {(u.composicao?.length || 0) > 0 ? ' ✓' : ''}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {!dados ? <Skeleton height={180} /> : (
        <form onSubmit={gravar}>
          <div className="full-composicao-cabeca">
            <span>Peça</span>
            <span>Cor</span>
            <span>Tamanho</span>
            <span className="num">Qtd.</span>
            <span />
          </div>
          {linhas.map((l, i) => (
            <div className="full-composicao-linha" key={i}>
              <span className="full-composicao-ref">{dados.item.referencia || 'sem referência'}</span>
              <input
                list="full-cores-cadastro"
                value={l.cor}
                onChange={(e) => mudar(i, 'cor', e.target.value)}
                placeholder="cor"
                aria-label="Cor"
              />
              <input
                list="full-tamanhos-cadastro"
                value={l.tamanho}
                onChange={(e) => mudar(i, 'tamanho', e.target.value)}
                placeholder="tamanho"
                aria-label="Tamanho"
              />
              <input
                type="number"
                min="1"
                className="num"
                value={l.quantidade}
                onChange={(e) => mudar(i, 'quantidade', e.target.value)}
                aria-label="Quantidade"
              />
              <button
                type="button"
                className="icon-btn"
                title="Tirar esta peça do kit"
                onClick={() => setLinhas((atual) => atual.filter((_, idx) => idx !== i))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <datalist id="full-cores-cadastro">
            {coresDoCadastro.map((c) => <option key={c} value={c} />)}
          </datalist>
          <datalist id="full-tamanhos-cadastro">
            {tamanhosDoCadastro.map((t) => <option key={t} value={t} />)}
          </datalist>

          <div className="full-composicao-rodape">
            <button type="button" className="btn btn-ghost" onClick={acrescentar}>
              <Plus size={13} /> Acrescentar peça
            </button>
            <span className="full-composicao-total">
              <b>{formatQtd(total)}</b> peças por unidade vendida
              {dados.item.pecasPorUnidade > 1 && total !== dados.item.pecasPorUnidade && (
                <em> — o SKU diz {dados.item.pecasPorUnidade}</em>
              )}
            </span>
          </div>

          {a.unidades.length > 1 && (
            <div className="full-toggle-linha">
              <Toggle checked={aplicarEmTodas} onChange={() => setAplicarEmTodas((v) => !v)} />
              <div>
                <b>Repetir nas outras {a.unidades.length - 1} variações deste anúncio</b>
                <small>
                  As mesmas cores e quantidades, com o <b>tamanho de cada variação</b> no lugar deste. É o caso
                  normal: o trio se repete, o que muda é o tamanho.
                </small>
              </div>
            </div>
          )}

          {(dados.composicao || []).some((c) => c.varianteId == null) && (
            <div className="full-aviso">
              <AlertTriangle size={14} />
              <span>
                Alguma linha não casou com uma variante do cadastro — a cor ou o tamanho não existem nessa
                referência. A ordem de produção nasce sem variante nessas linhas, e alguém vai ter que completar
                à mão. Use as sugestões dos campos, que vêm do cadastro.
              </span>
            </div>
          )}

          {erro && <div className="login-error" style={{ marginBottom: 8 }}>{erro}</div>}
          {aviso && <div className="full-aviso full-aviso-info"><CheckCircle2 size={14} /><span>{aviso}</span></div>}
          <button className="btn btn-primary" disabled={gravando || linhas.length === 0}>
            {gravando ? 'Gravando…' : 'Gravar composição'}
          </button>
        </form>
      )}

      <p className="full-nota">
        Esta composição é do ANÚNCIO — do que sai da caixa. Ela não altera o kit da Ficha de Precificação, que
        continua sendo o que compõe o preço.
      </p>
    </>
  );
}

function AbaVendasFull({ alvo, a }) {
  const paleta = usePaletaGrafico();
  const [dias, setDias] = useState(90);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setDados(null);
    api.get(`/full/anuncios/${alvo.integracaoId}/${encodeURIComponent(alvo.anuncioIdExterno)}/vendas?dias=${dias}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [alvo.integracaoId, alvo.anuncioIdExterno, dias]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <Skeleton height={240} />;

  const r = dados.resumo;
  const unidade = a.ehKit ? 'kits' : 'peças';
  const porDia = r.unidades > 0 && dias > 0 ? r.unidades / dias : 0;
  const serie = dados.serie.map((d) => ({ ...d, dia: dataBr(d.data)?.slice(0, 5) }));

  return (
    <>
      <div className="full-vendas-topo">
        <div className="modo-exibicao" role="group" aria-label="Período das vendas">
          {[30, 60, 90, 180, 365].map((d) => (
            <button
              key={d}
              type="button"
              className={'modo-btn' + (dias === d ? ' active' : '')}
              onClick={() => setDias(d)}
            >
              {d} dias
            </button>
          ))}
        </div>
      </div>

      <div className="full-blocos">
        <div className="full-bloco destaque">
          <span className="full-bloco-rotulo">Vendeu</span>
          <span className="full-bloco-valor">{formatQtd(r.unidades)}</span>
          <small>
            {unidade} em {dias} dias
            {a.ehKit && <> · {formatQtd(r.unidades * a.pecasPorUnidade)} peças</>}
          </small>
        </div>
        <div className="full-bloco">
          <span className="full-bloco-rotulo">Por dia</span>
          <span className="full-bloco-valor">{numeroBr(porDia, 2)}</span>
          <small>{unidade} por dia, no período inteiro</small>
        </div>
        <div className="full-bloco">
          <span className="full-bloco-rotulo">Pedidos</span>
          <span className="full-bloco-valor">{formatQtd(r.pedidos)}</span>
          <small>{r.diasComVenda} dias com venda de {dias}</small>
        </div>
        <div className="full-bloco">
          <span className="full-bloco-rotulo">Receita</span>
          <span className="full-bloco-valor">{brl(r.receita)}</span>
          <small>{r.unidades > 0 ? `${brl(r.receita / r.unidades)} por ${a.ehKit ? 'kit' : 'peça'}` : 'sem venda'}</small>
        </div>
      </div>

      {serie.length === 0 ? (
        <EstadoVazio
          Icone={ShoppingBag}
          titulo="Sem venda no período"
          descricao="Nenhum pedido deste anúncio caiu no recorte escolhido. Aumente o período para procurar mais para trás."
        />
      ) : (
        <>
          <div className="card-head">Dia a dia</div>
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={serie} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={paleta.grade} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="dia" tick={{ fontSize: 10, fill: paleta.rotulo }} stroke={paleta.eixo} />
                <YAxis tick={{ fontSize: 10, fill: paleta.rotulo }} stroke={paleta.eixo} allowDecimals={false} />
                <Tooltip
                  formatter={(v) => [formatQtd(v), unidade]}
                  labelFormatter={(l) => `Dia ${l}`}
                />
                <Area type="monotone" dataKey="unidades" stroke={paleta.series[1]} fill={paleta.series[1]} fillOpacity={0.2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {dados.grade.length > 0 && (
        <>
          <div className="card-head" style={{ marginTop: 16 }}>O que saiu, por cor e tamanho</div>
          <div className="data-table-outer">
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Cor</th>
                    <th>Tamanho</th>
                    <th className="num">Vendeu</th>
                    <th className="num">Receita</th>
                    <th className="num">Participação</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.grade.map((g) => (
                    <tr key={`${g.cor}|${g.tamanho}`}>
                      <td>{g.cor || <span className="full-sem-medida">—</span>}</td>
                      <td>{g.tamanho || <span className="full-sem-medida">—</span>}</td>
                      <td className="num"><b>{formatQtd(g.unidades)}</b></td>
                      <td className="num">{brl(g.receita)}</td>
                      <td className="num">
                        {r.unidades > 0 ? `${numeroBr((g.unidades / r.unidades) * 100, 1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="full-nota">
            É esta grade que reparte o envio entre as cores. Venda dentro de kit aparece pela cor gravada no
            pedido — quando o kit é sortido, quem manda no que produzir é a <b>Composição do kit</b>, não esta
            tabela.
          </p>
        </>
      )}
    </>
  );
}

function AbaEstoqueFull({ a, curva }) {
  const paleta = usePaletaGrafico();
  const dados = (curva || []).map((c) => ({ ...c, dia: dataBr(c.data)?.slice(0, 5) }));

  if (dados.length === 0) {
    return (
      <EstadoVazio
        Icone={History}
        titulo="Ainda não há retrato do saldo"
        descricao={'A curva do saldo no Full é construída por este sistema, um retrato por dia — nenhuma plataforma '
          + 'devolve o histórico dela. Ela começa a existir a partir da primeira leitura e ganha forma em alguns dias.'}
      />
    );
  }

  return (
    <>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Saldo disponível dentro do centro de distribuição, um ponto por dia. A linha tracejada é o mínimo
        calculado para este anúncio — abaixo dela, a reposição já devia estar a caminho.
      </p>
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={dados} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid stroke={paleta.grade} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="dia" tick={{ fontSize: 10, fill: paleta.rotulo }} stroke={paleta.eixo} />
            <YAxis tick={{ fontSize: 10, fill: paleta.rotulo }} stroke={paleta.eixo} allowDecimals={false} />
            <Tooltip
              formatter={(v, nome) => [formatQtd(v), nome === 'disponivel' ? 'Disponível' : 'A caminho']}
              labelFormatter={(l) => `Dia ${l}`}
            />
            <Area type="monotone" dataKey="disponivel" stroke={paleta.series[0]} fill={paleta.series[0]} fillOpacity={0.2} />
            <Area type="monotone" dataKey="emTransito" stroke={paleta.series[2]} fill={paleta.series[2]} fillOpacity={0.12} />
            {a.reposicao.estoqueMinimo != null && (
              <ReferenceLine y={a.reposicao.estoqueMinimo} stroke={paleta.negativo} strokeDasharray="5 4" />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="full-nota">
        O histórico começa em {a.desempenho.primeiroRetrato ? dataBr(a.desempenho.primeiroRetrato) : 'agora'} —
        é a data da primeira leitura deste item, não a data em que ele entrou no Full.
      </div>
    </>
  );
}

const ORIGEM_ENVIO = {
  plataforma: { rotulo: 'da plataforma', ajuda: 'Remessa lida da API da plataforma — tem número conferível no painel.' },
  manual: { rotulo: 'registrada aqui', ajuda: 'Alguém da expedição registrou esta remessa no sistema.' },
  inferido: {
    rotulo: 'deduzida do saldo',
    ajuda: 'Ninguém registrou esta remessa: o sistema deduziu a chegada porque o saldo no centro de distribuição '
      + 'subiu de um dia para o outro. Não é um número de remessa e não pode ser conferida no painel.',
  },
};

function AbaEnviosFull({ a, envios, onAlterado }) {
  const [quantidade, setQuantidade] = useState('');
  const [data, setData] = useState('');
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState('');
  const unidade = a.unidades[0];

  async function registrar(e) {
    e.preventDefault();
    setErro('');
    setGravando(true);
    try {
      await api.post('/full/envios', {
        integracao_id: a.integracaoId,
        enviado_em: data || null,
        status: 'em_transito',
        itens: [{ full_item_id: unidade.id, quantidade: Number(quantidade) }],
      });
      setQuantidade('');
      setData('');
      onAlterado();
    } catch (err) {
      setErro(err.message);
    } finally {
      setGravando(false);
    }
  }

  return (
    <>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Todo envio que este anúncio já recebeu, do mais recente para o mais antigo. Cada linha diz de onde a
        informação veio — e isso importa: remessa deduzida do saldo não é remessa conferida no painel.
      </p>

      {(!envios || envios.length === 0) ? (
        <>
          <EstadoVazio
            Icone={Truck}
            titulo="Nenhum envio veio da plataforma"
            descricao={'O Mercado Livre tem mais de uma forma documentada para a API de remessas, e o portal de '
              + 'desenvolvedor deles recusa leitura automatizada — então o caminho certo para esta conta nunca '
              + 'foi confirmado. O diagnóstico abaixo pergunta à API, com o token da loja, qual deles responde.'}
          />
          <DiagnosticoEnvios integracaoId={a.integracaoId} />
        </>
      ) : (
        <div className="full-timeline">
          {envios.map((e) => {
            const origem = ORIGEM_ENVIO[e.origem] || ORIGEM_ENVIO.manual;
            return (
              <div key={e.id} className={`full-timeline-item origem-${e.origem}`}>
                <span className="full-timeline-ponto" />
                <div className="full-timeline-corpo">
                  <div className="full-timeline-topo">
                    <b>{dataBr(e.recebidoEm || e.enviadoEm) || 'sem data'}</b>
                    <span className={`full-selo-origem origem-${e.origem}`} title={origem.ajuda}>{origem.rotulo}</span>
                    {e.envioIdExterno && <span className="full-timeline-id">nº {e.envioIdExterno}</span>}
                  </div>
                  <div className="full-timeline-numeros">
                    <span><b>{formatQtd(e.pecasDestesItens)}</b> peças deste anúncio</span>
                    {e.itensNoEnvio > 1 && <span>· {e.itensNoEnvio} itens na remessa</span>}
                    {e.status && <span className={`full-status-envio ${e.status}`}>{e.status.replace('_', ' ')}</span>}
                  </div>
                  {e.enviadoEm && e.recebidoEm && (
                    <div className="full-timeline-prazo">
                      saiu {dataBr(e.enviadoEm)} · chegou {dataBr(e.recebidoEm)}
                    </div>
                  )}
                  {e.observacoes && <p className="full-timeline-obs">{e.observacoes}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="card-head" style={{ marginTop: 18 }}>Registrar um envio</div>
      <form onSubmit={registrar} className="full-form-envio">
        <Field
          label={a.ehKit ? `Unidades despachadas (kits de ${a.pecasPorUnidade})` : 'Peças despachadas'}
          hint={a.ehKit
            ? `O centro de distribuição conta unidades do anúncio. Informe KITS — ${quantidade
              ? `${formatQtd(Number(quantidade) * a.pecasPorUnidade)} peças` : 'a conversão aparece aqui'}.`
            : undefined}
        >
          <input
            type="number"
            min="1"
            value={quantidade}
            onChange={(e) => setQuantidade(e.target.value)}
            required
          />
        </Field>
        <Field label="Saiu daqui em">
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} />
        </Field>
        <button className="btn btn-primary" disabled={gravando || !quantidade || !unidade}>
          <Send size={13} /> {gravando ? 'Registrando…' : 'Registrar'}
        </button>
      </form>
      {erro && <div className="login-error" style={{ marginTop: 8 }}>{erro}</div>}
      <p className="full-nota">
        O registro vale por anúncio inteiro, na primeira variação, e na MESMA unidade que o marketplace conta
        (unidades do anúncio — kits, quando for kit). É o que faz o "a caminho" abater a reposição sem sobrar nem
        faltar. Ele existe para a data do último envio não se perder quando a plataforma não devolve o histórico.
      </p>
    </>
  );
}

// Pergunta à API do Mercado Livre qual caminho de remessas responde nesta
// conta, e mostra o que cada um devolveu.
//
// É o oposto de deixar "não respondeu" no ar: com o resultado, a leitura de
// envios passa a ser uma linha de código em vez de um chute — e, se nenhum
// responder, fica provado que a conta não tem esse acesso, o que também é uma
// resposta.
function DiagnosticoEnvios({ integracaoId }) {
  const [rodando, setRodando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');

  async function rodar() {
    setRodando(true);
    setErro('');
    try {
      setResultado(await api.post('/full/diagnostico-envios', { integracao_id: integracaoId }));
    } catch (e) {
      setErro(e.message);
    } finally {
      setRodando(false);
    }
  }

  return (
    <div className="full-diagnostico">
      <button type="button" className="btn btn-ghost" onClick={rodar} disabled={rodando}>
        <Search size={13} /> {rodando ? 'Perguntando à API…' : 'Descobrir por que os envios não vieram'}
      </button>
      {erro && <div className="login-error" style={{ marginTop: 8 }}>{erro}</div>}
      {resultado && (
        <div className="full-diagnostico-saida">
          {resultado.funcionou.length > 0 ? (
            <div className="full-aviso full-aviso-info">
              <CheckCircle2 size={14} />
              <span>
                <b>{resultado.funcionou.length} caminho(s) responderam.</b> Mande esta tela para quem cuida do
                sistema: com o formato da resposta em mãos, a leitura de envios entra na próxima versão.
              </span>
            </div>
          ) : (
            <div className="full-aviso">
              <AlertTriangle size={14} />
              <span>
                Nenhum caminho conhecido respondeu para a loja <b>{resultado.loja}</b> (vendedor{' '}
                {resultado.sellerId}). Isso costuma querer dizer que o aplicativo desta conta não tem a permissão
                de fulfillment — o que se resolve no painel de desenvolvedor do Mercado Livre, não aqui.
              </span>
            </div>
          )}
          <ul className="full-diagnostico-lista">
            {resultado.tentativas.map((t) => (
              <li key={t.caminho} className={t.ok ? 'ok' : 'falhou'}>
                <code>{t.caminho}</code>
                <span>
                  {t.ok
                    ? `200 · ${t.registros != null ? `${t.registros} registro(s)` : 'sem lista'}${t.chaves ? ` · campos: ${t.chaves.join(', ')}` : ''}`
                    : `${t.status || 'erro'} · ${t.erro}`}
                </span>
                {t.ok && t.amostra && <pre>{t.amostra}</pre>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AbaVariacoesFull({ a }) {
  const rateioPorIgual = a.unidades.some((u) => u.participacaoOrigem === 'igual');
  return (
    <>
      <p className="page-sub" style={{ marginTop: 0 }}>
        O saldo no Full é por cor e tamanho — e é aqui que se vê qual cor está segurando o anúncio de pé e qual
        já zerou. A coluna "mandar" reparte o envio do anúncio pela grade que de fato vendeu no período.
      </p>
      {rateioPorIgual && (
        <div className="full-aviso">
          <AlertTriangle size={14} />
          <span>
            Este anúncio não teve venda registrada por cor e tamanho no período, então a repartição foi feita
            <b> por igual</b> entre as variações. Trate o número por cor como ponto de partida, não como medição.
          </span>
        </div>
      )}
      <div className="data-table-outer">
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Cor</th>
                <th>Tamanho</th>
                <th className="num">No Full</th>
                <th className="num">A caminho</th>
                <th className="num">Na casa</th>
                <th className="num">Venda/dia</th>
                <th className="num">Dura</th>
                <th className="num">Mínimo</th>
                <th className="num">Mandar</th>
              </tr>
            </thead>
            <tbody>
              {a.unidades.map((u) => (
                <tr key={u.id} className={u.disponivel === 0 ? 'full-linha-zerada' : undefined}>
                  <td>{u.cor || <span className="full-sem-medida">—</span>}</td>
                  <td>{u.tamanho || <span className="full-sem-medida">—</span>}</td>
                  <td className="num">{u.disponivel != null ? formatQtd(u.disponivel) : <span title={u.naoLido || ''}>não lido</span>}</td>
                  <td className="num">{u.emTransito != null ? formatQtd(u.emTransito) : '—'}</td>
                  <td className="num">{u.estoqueCasa != null ? formatQtd(u.estoqueCasa) : '—'}</td>
                  <td className="num">{u.velocidadeDia != null ? numeroBr(u.velocidadeDia, 2) : '—'}</td>
                  <td className="num">{u.coberturaDias != null ? `${numeroBr(u.coberturaDias, 1)} d` : '—'}</td>
                  <td className="num">{u.estoqueMinimo != null ? formatQtd(u.estoqueMinimo) : '—'}</td>
                  <td className="num"><b>{u.precisaEnviarUnidade ? formatQtd(u.precisaEnviarUnidade) : '—'}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="full-nota">
        A soma da coluna "mandar" é exatamente o total do anúncio: o múltiplo de envio da loja é aplicado uma vez
        só, no total, e o resultado é repartido de volta entre as cores pela participação de cada uma na venda —
        arredondar cada cor por conta própria inflaria a remessa inteira.
      </p>
    </>
  );
}

function AbaAjustesFull({ a, onGravado }) {
  const unidade = a.unidades[0];
  const [minimo, setMinimo] = useState(a.reposicao.estoqueMinimoManual ?? '');
  const [dias, setDias] = useState(unidade?.diasCoberturaManual ?? '');
  const [ignorar, setIgnorar] = useState(a.unidades.every((u) => u.ignorarReposicao));
  const [gravando, setGravando] = useState(false);
  const [erro, setErro] = useState('');

  async function gravar(e) {
    e.preventDefault();
    setErro('');
    setGravando(true);
    try {
      // O campo é o mínimo do ANÚNCIO INTEIRO — é o número que a tela mostra
      // ao lado ("hoje a conta dá X peças"). Como o mínimo é gravado por
      // variação, ele é REPARTIDO entre elas pela mesma participação que
      // reparte o envio.
      //
      // Gravar o mesmo valor em cada variação, que era o que esta tela fazia,
      // multiplicava o mínimo pelo número de cores: quem digitasse os 80
      // sugeridos num anúncio de 8 cores criava um mínimo de 640 e jogava o
      // anúncio inteiro para "envio atrasado" na hora.
      const alvo = minimo === '' ? null : Math.max(0, Number(minimo));
      const pesos = a.unidades.map((u) => (u.participacao > 0 ? u.participacao : 0));
      const somaPesos = pesos.reduce((acc, p) => acc + p, 0) || a.unidades.length;
      let restante = alvo;
      await Promise.all(a.unidades.map((u, i) => {
        let parte = null;
        if (alvo != null) {
          const ultimo = i === a.unidades.length - 1;
          // A última variação leva a sobra, para a soma bater exatamente com
          // o que a pessoa digitou.
          parte = ultimo ? Math.max(0, restante) : Math.round(alvo * ((pesos[i] || 1 / a.unidades.length) / somaPesos));
          restante -= parte;
        }
        return api.put(`/full/itens/${u.id}`, {
          estoque_minimo_manual: parte,
          dias_cobertura_manual: dias === '' ? null : Number(dias),
          ignorar_reposicao: ignorar,
        });
      }));
      onGravado();
    } catch (err) {
      setErro(err.message);
    } finally {
      setGravando(false);
    }
  }

  return (
    <form onSubmit={gravar}>
      <p className="page-sub" style={{ marginTop: 0 }}>
        O cálculo automático serve para a maioria. Estes campos existem para as exceções — e ficam vazios enquanto
        ninguém os preencher, porque campo vazio quer dizer "use a conta".
      </p>
      <Field
        label="Estoque mínimo no Full (anúncio inteiro)"
        hint={`Vazio = calculado. Hoje a conta dá ${a.reposicao.estoqueMinimoCalculado != null
          ? formatQtd(a.reposicao.estoqueMinimoCalculado) : '—'} peças (${a.reposicao.diasDeMinimo} dias de venda).`
          + (a.unidades.length > 1
            ? ` O valor é repartido entre as ${a.unidades.length} variações pela participação de cada uma na venda.`
            : '')}
      >
        <input type="number" min="0" value={minimo} onChange={(e) => setMinimo(e.target.value)} placeholder="calculado" />
      </Field>
      <Field
        label="Quantos dias o envio deve durar"
        hint={`Vazio = o padrão da loja (${a.parametros.dias_cobertura_alvo} dias).`}
      >
        <input type="number" min="1" value={dias} onChange={(e) => setDias(e.target.value)} placeholder="padrão da loja" />
      </Field>
      <div className="full-toggle-linha">
        <Toggle checked={ignorar} onChange={() => setIgnorar((v) => !v)} />
        <div>
          <b>Não repor este anúncio</b>
          <small>
            Peça em fim de linha. Ela continua aparecendo na tela, marcada, mas fica fora do "precisa mandar" e do
            plano de produção.
          </small>
        </div>
      </div>
      {erro && <div className="login-error" style={{ marginBottom: 8 }}>{erro}</div>}
      <button className="btn btn-primary" disabled={gravando}>{gravando ? 'Gravando…' : 'Gravar ajustes'}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// O plano de produção
// ---------------------------------------------------------------------------
// O botão que fecha o ciclo. Ele não manda produzir o que precisa ser
// enviado: manda produzir o que precisa ser enviado E NÃO ESTÁ NA CASA. Sem
// essa subtração o plano mandaria cortar tecido para peça que já está na
// prateleira — o erro mais caro que uma tela de reposição pode cometer.
//
// O período é escolhido aqui, e recalcula na hora: "quero que este envio dure
// 45 dias" muda a quantidade de todo mundo.
function ModalPlano({ alvos, janela, diasAlvoInicial, onFechar }) {
  // Nasce vazio quando a tela não escolheu nada: quem responde qual é o
  // período é o servidor, com o parâmetro da loja — e o valor volta marcado
  // nos botões. Chutar 60 aqui faria os Ajustes do Full parecerem ignorados.
  const [diasAlvo, setDiasAlvo] = useState(diasAlvoInicial ? Number(diasAlvoInicial) : null);
  const [usarCasa, setUsarCasa] = useState(true);
  const [plano, setPlano] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [abrindo, setAbrindo] = useState(null);
  const [abertas, setAbertas] = useState({});
  const [conferindoPapel, setConferindoPapel] = useState(false);

  const montar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await api.post('/full/plano', {
        anuncios: alvos.map((a) => ({ integracaoId: a.integracaoId, anuncioIdExterno: a.anuncioIdExterno })),
        dias_alvo: diasAlvo || null,
        janela: janela || null,
        usar_estoque_casa: usarCasa,
      });
      setPlano(r);
      // Nada de `setDiasAlvo(r.diasAlvo)` aqui: isso re-disparava o cálculo e
      // o segundo pedido carimbava o período do PRIMEIRO anúncio em todos os
      // outros — um anúncio com período próprio de 20 dias encolhia o plano
      // inteiro para um terço, e era esse número que virava ordem de
      // produção. O período que o servidor aplicou é só EXIBIDO, abaixo.
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [alvos, diasAlvo, janela, usarCasa]);

  useEffect(() => { montar(); }, [montar]);

  // O período que está valendo: o escolhido aqui, ou — enquanto ninguém
  // escolheu — o que o servidor aplicou a partir do parâmetro da loja.
  const diasAlvoExibido = diasAlvo
    ?? (plano?.diasAlvoUsados?.length === 1 ? plano.diasAlvoUsados[0] : null);
  const textoAlvo = diasAlvoExibido != null
    ? `${diasAlvoExibido} dias`
    : `${(plano?.diasAlvoUsados || []).join(', ')} dias (varia por anúncio)`;

  async function abrirOrdem(produto) {
    setAbrindo(produto.produtoId);
    setErro('');
    try {
      const r = await api.post('/producao/ordens', {
        confirmar: true,
        produto_id: produto.produtoId,
        grade: produto.gradeParaOrdem,
        situacao: 'rascunho',
        data_prevista: produto.dataLimiteEnvio || null,
        // A ordem nasce dizendo de onde veio. Sem isto, daqui a duas semanas
        // ninguém sabe por que aquela OP existe.
        // A observação carrega o período de CADA anúncio, não um número só:
        // ela fica gravada na ordem, e um período errado ali é uma pista
        // falsa que ninguém tem como conferir depois.
        observacoes: `Reposição do fulfillment — plano gerado em ${dataBr(plano.hoje)}. `
          + `Anúncios: ${produto.anuncios
            .map((x) => `${x.lojaNome} (${x.titulo}) — envio para durar ${x.diasAlvo} dias`)
            .join(' · ')}.`,
        aceitar_ficha_incompleta: true,
      });
      setAbertas((v) => ({ ...v, [produto.produtoId]: r.ordem }));
    } catch (e) {
      setErro(e.status === 403
        ? 'Para abrir a ordem de produção é preciso ter o módulo Produção. O plano continua aqui para ser exportado ou impresso.'
        : e.message);
    } finally {
      setAbrindo(null);
    }
  }

  // A IMPRESSÃO.
  //
  // `window.print()` no modal não funcionava, e não era ajuste de CSS: o modal
  // é `position: fixed` dentro de um overlay com rolagem interna. Elemento
  // fixo imprime UMA página e o resto é cortado — saía a primeira dobra e
  // mais nada. Agora quem vai para o papel é um documento próprio, montado
  // num portal no <body> (ver components/FullRemessaImpressao.jsx).
  //
  // O `setTimeout` não é superstição: o navegador precisa de um quadro para
  // aplicar o CSS de impressão antes de abrir a caixa de diálogo. Sem ele, o
  // Chrome abre a prévia com o documento ainda invisível.
  function imprimir() {
    setConferindoPapel(false);
    setTimeout(() => window.print(), 60);
  }

  const colunasExportacao = [
    { chave: 'referencia', rotulo: 'Referência', valor: (l) => l.referencia },
    { chave: 'cor', rotulo: 'Cor', valor: (l) => l.cor },
    { chave: 'tamanho', rotulo: 'Tamanho', valor: (l) => l.tamanho },
    { chave: 'enviar', rotulo: 'A enviar', valor: (l) => l.aEnviar },
    { chave: 'casa', rotulo: 'Já na casa', valor: (l) => l.daCasa },
    { chave: 'produzir', rotulo: 'A produzir', valor: (l) => l.aProduzir },
    { chave: 'limite', rotulo: 'Sair daqui até', valor: (l) => (l.dataLimiteEnvio ? dataBr(l.dataLimiteEnvio) : '') },
  ];
  const linhasExportacao = (plano?.produtos || []).flatMap((p) => p.linhas.map((l) => ({
    ...l, referencia: p.referencia, dataLimiteEnvio: p.dataLimiteEnvio,
  })));

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <div className="card full-modal" role="dialog" aria-modal="true" aria-label="Plano de produção para o Full">
        <div className="full-modal-topo">
          <div>
            <h2><Factory size={18} /> Plano de produção</h2>
            <p className="page-sub" style={{ margin: 0 }}>
              {alvos.length} anúncio{alvos.length > 1 ? 's' : ''} escolhido{alvos.length > 1 ? 's' : ''}.
              O plano separa o que precisa ser <b>enviado</b>, o que <b>já está na casa</b> e o que de fato precisa
              ser <b>produzido</b>.
            </p>
          </div>
          <button className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>

        <div className="full-periodo">
          <span className="full-periodo-rotulo">
            Quero que este envio dure
            {diasAlvo == null && (
              <small className="full-periodo-padrao"> (agora: {textoAlvo}, do parâmetro de cada loja)</small>
            )}
          </span>
          <div className="modo-exibicao" role="group" aria-label="Período que o envio deve durar">
            {PERIODOS_RAPIDOS.map((d) => (
              <button
                key={d}
                type="button"
                className={'modo-btn' + (diasAlvoExibido === d ? ' active' : '')}
                onClick={() => setDiasAlvo(d)}
              >
                {d} dias
              </button>
            ))}
          </div>
          <span className="full-periodo-livre">
            ou
            <input
              type="number"
              min="1"
              max="365"
              value={diasAlvoExibido ?? ''}
              onChange={(e) => setDiasAlvo(Math.max(1, Number(e.target.value) || 1))}
              aria-label="Período personalizado, em dias"
            />
            dias
          </span>
          <label className="full-periodo-casa">
            <Checkbox checked={usarCasa} onChange={() => setUsarCasa((v) => !v)} />
            <span title="Desmarque para ver o volume cheio a produzir, ignorando o que já está no galpão.">
              descontar o que já está na casa
            </span>
          </label>
        </div>

        {erro && <div className="login-error">{erro}</div>}

        {plano && (
          <FullRemessaImpressao
            /* OS ANÚNCIOS RECALCULADOS pela própria rota do plano — e não os
               `alvos`, que são o retrato do painel com o período do FILTRO da
               página. Quando alguém troca o período aqui dentro, é o plano que
               recalcula; imprimir a partir de `alvos` fazia a folha do kit
               montado sair com os números antigos e a folha da grade com os
               novos, no mesmo grampo. */
            anuncios={plano.anuncios?.length ? plano.anuncios : alvos}
            plano={plano}
            visivel={conferindoPapel}
            onFechar={() => setConferindoPapel(false)}
          />
        )}

        {carregando ? <Skeleton height={220} /> : plano && (
          <>
            <div className="full-plano-totais">
              <div className="full-bloco">
                <span className="full-bloco-rotulo">A enviar</span>
                <span className="full-bloco-valor">{formatQtd(plano.totais.aEnviar)}</span>
                <small>
                  peças que o Full precisa receber
                  {plano.totais.unidadesAEnviar !== plano.totais.aEnviar && (
                    <> — <b>{formatQtd(plano.totais.unidadesAEnviar)}</b> unidades de anúncio, porque há kit
                    entre elas</>
                  )}
                  {plano.naoVinculados?.length > 0 && (
                    <> — {formatQtd(plano.naoVinculados.reduce((acc, x) => acc + (x.pecasAEnviar ?? x.aEnviar ?? 0), 0))}{' '}
                    delas são de anúncios sem referência</>
                  )}
                </small>
              </div>
              <div className="full-bloco">
                <span className="full-bloco-rotulo">Já na casa</span>
                <span className="full-bloco-valor">{formatQtd(plano.totais.daCasa)}</span>
                <small>podem sair sem produzir nada</small>
              </div>
              <div className="full-bloco destaque">
                <span className="full-bloco-rotulo">A produzir</span>
                <span className="full-bloco-valor">{formatQtd(plano.totais.aProduzir)}</span>
                <small>o que vira ordem de produção</small>
              </div>
            </div>

            {/* Anúncios sem referência: têm quantidade a enviar, mas não podem
                virar ordem de produção. Aparecem ANTES do resto porque é o
                que está travando o plano. */}
            {plano.naoVinculados?.length > 0 && (
              <div className="full-plano-travados">
                <div className="card-head">Precisam de vínculo antes de virar produção</div>
                <p className="page-sub" style={{ marginTop: 0 }}>
                  Estes anúncios têm quantidade a enviar calculada, mas não estão ligados a nenhuma referência do
                  cadastro — sem saber qual peça é, não há o que produzir. Abra o anúncio na tela e use
                  "Vincular referência"; o plano passa a incluí-los na hora.
                </p>
                {plano.naoVinculados.map((a) => (
                  <div key={a.chave} className="full-plano-travado">
                    <span className="full-plano-chip">
                      <SeloPlataforma chave={chaveDaPlataforma(a.marketplace)} size={12} />
                      {a.lojaNome}
                    </span>
                    <div className="full-plano-travado-corpo">
                      <b>{a.titulo || a.anuncioIdExterno}</b>
                      <small>
                        {a.sku ? <>SKU lido: <code>{a.sku}</code></> : 'a plataforma não devolveu SKU'}
                        {' · '}envio para durar {a.diasAlvo} dias
                      </small>
                    </div>
                    <div className="full-plano-travado-num">
                      <b>{a.aEnviar != null ? formatQtd(a.aEnviar) : '—'}</b>
                      <small>
                        a enviar
                        {a.pecasPorUnidade > 1 && a.pecasAEnviar != null
                          && <> · {formatQtd(a.pecasAEnviar)} peças</>}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {plano.produtos.length === 0 && (
              <EstadoVazio
                Icone={plano.naoVinculados?.length > 0 ? Link2 : CheckCircle2}
                titulo={plano.naoVinculados?.length > 0
                  ? 'Nada a produzir — falta o vínculo'
                  : 'Nada a produzir'}
                descricao={plano.naoVinculados?.length > 0
                  ? 'Os anúncios escolhidos precisam de envio, mas nenhum deles está ligado a uma referência do '
                    + 'cadastro. Assim que o SKU for vinculado, o plano passa a dizer quanto produzir de cada cor.'
                  : 'Com este período, nenhum dos anúncios escolhidos precisa de peça nova. Aumente o período para ver o que seria preciso.'}
              />
            )}

            {plano.produtos.map((p) => (
              <div key={p.produtoId} className="full-plano-produto">
                <div className="full-plano-cabeca">
                  <div>
                    <b>{p.referencia}</b>
                    <small>{p.descricao}</small>
                    <div className="full-plano-anuncios">
                      {p.anuncios.map((an) => (
                        <span key={an.chave} className="full-plano-chip">
                          <SeloPlataforma chave={chaveDaPlataforma(an.marketplace)} size={12} />
                          {an.lojaNome} · {formatQtd(an.pecasAEnviar ?? an.aEnviar ?? 0)} pçs
                          {an.pecasPorUnidade > 1 && <> ({formatQtd(an.aEnviar || 0)} kits)</>}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="full-plano-numeros">
                    <span>
                      enviar <b>{formatQtd(p.totais.aEnviar)}</b> pçs
                      {p.ehKit && <> ({formatQtd(p.totais.unidadesAEnviar)} kits)</>}
                    </span>
                    <span>da casa <b>{formatQtd(p.totais.daCasa)}</b></span>
                    <span className="destaque">produzir <b>{formatQtd(p.totais.aProduzir)}</b></span>
                    {p.dataLimiteEnvio && (
                      <span className="full-plano-prazo"><CalendarClock size={12} /> sair até {dataBr(p.dataLimiteEnvio)}</span>
                    )}
                  </div>
                </div>

                <div className="data-table-outer">
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Cor</th>
                          <th>Tamanho</th>
                          <th className="num">A enviar</th>
                          <th className="num">Já na casa</th>
                          <th className="num">A produzir</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.linhas.map((l) => (
                          <tr key={`${l.cor}|${l.tamanho}`}>
                            <td>{l.cor || <span className="full-sem-medida">sem cor lida</span>}</td>
                            <td>{l.tamanho || <span className="full-sem-medida">sem tamanho lido</span>}</td>
                            <td className="num">{formatQtd(l.aEnviar)}</td>
                            <td className="num">{formatQtd(l.daCasa)}</td>
                            <td className="num"><b>{formatQtd(l.aProduzir)}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="full-plano-acoes">
                  {abertas[p.produtoId] ? (
                    <span className="full-ordem-ok">
                      <CheckCircle2 size={14} /> Ordem {abertas[p.produtoId].numero} aberta como rascunho
                    </span>
                  ) : (
                    <button
                      className="btn btn-primary"
                      disabled={abrindo === p.produtoId || p.gradeParaOrdem.length === 0}
                      onClick={() => abrirOrdem(p)}
                      title={p.gradeParaOrdem.length === 0
                        ? 'Não há grade cor × tamanho suficiente para abrir uma ordem — complete a cor e o tamanho na aba Anúncios.'
                        : 'Abre uma ordem de produção como rascunho, com esta grade já preenchida.'}
                    >
                      <Factory size={14} /> {abrindo === p.produtoId ? 'Abrindo…' : 'Abrir ordem de produção'}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {(plano.ressalvas.semVinculo.length > 0 || plano.ressalvas.semMedida.length > 0
              || plano.ressalvas.gradeIncerta.length > 0 || plano.ressalvas.rateioPorIgual.length > 0
              || plano.ressalvas.composicaoSuposta?.length > 0) && (
              <div className="full-ressalvas">
                <div className="card-head">O que este plano não conseguiu medir</div>
                {plano.ressalvas.semVinculo.length > 0 && (
                  <p>
                    <b>{plano.ressalvas.semVinculo.length} anúncio(s) sem referência no cadastro</b> entraram no
                    total a enviar, mas ficaram de fora da produção — estão listados acima, um a um.
                  </p>
                )}
                {plano.ressalvas.semMedida.length > 0 && (
                  <p>
                    <b>{plano.ressalvas.semMedida.length} anúncio(s) sem venda no período</b> entraram sem quantidade
                    calculada — a velocidade deles não pôde ser medida.
                  </p>
                )}
                {plano.ressalvas.composicaoSuposta?.length > 0 && (
                  <p className="full-ressalva-forte">
                    <b>{plano.ressalvas.composicaoSuposta.length} linha(s) supõem que o kit é de uma cor só.</b>{' '}
                    Ninguém registrou a composição dessas variações, então o plano repetiu a cor da própria
                    variação. Se o kit for sortido, isto manda cortar o triplo de uma cor e nenhuma das outras —
                    abra o anúncio e preencha a aba <b>Composição</b> antes de abrir a ordem.
                  </p>
                )}
                {plano.ressalvas.rateioPorIgual.length > 0 && (
                  <p>
                    <b>{plano.ressalvas.rateioPorIgual.length} linha(s)</b> tiveram a grade repartida <b>por igual</b>,
                    por falta de venda registrada por cor e tamanho. Confira antes de cortar.
                  </p>
                )}
                {plano.ressalvas.gradeIncerta.length > 0 && (
                  <p>
                    <b>{plano.ressalvas.gradeIncerta.length} linha(s)</b> vieram da plataforma sem cor nem tamanho e
                    não entram na ordem — elas aparecem na tabela para serem completadas à mão.
                  </p>
                )}
              </div>
            )}

            <div className="full-modal-rodape">
              <BotaoExportar nomeBase="plano_producao_full" colunas={colunasExportacao} itens={linhasExportacao} />
              <button
                className="btn btn-ghost"
                onClick={() => setConferindoPapel((v) => !v)}
                title="Ver o papel como ele vai sair, antes de mandar imprimir"
              >
                <Eye size={14} /> {conferindoPapel ? 'Fechar prévia' : 'Ver o papel'}
              </button>
              <button className="btn btn-primary" onClick={imprimir} disabled={!plano?.produtos}>
                <Printer size={14} /> Imprimir remessa
              </button>
              <button className="btn btn-ghost" onClick={onFechar}>Fechar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Os parâmetros por loja
// ---------------------------------------------------------------------------
function ModalParametros({ lojas, onFechar }) {
  const [dados, setDados] = useState(null);
  const [salvando, setSalvando] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => { api.get('/full/parametros').then(setDados).catch((e) => setErro(e.message)); }, []);

  function valorDaLoja(lojaId, campo) {
    const gravado = dados?.lojas?.find((l) => l.origem_integracao_id === lojaId);
    return gravado?.[campo] ?? dados?.padrao?.[campo] ?? '';
  }

  function mudar(lojaId, campo, valor) {
    setDados((d) => {
      const lojasNovas = [...(d.lojas || [])];
      const i = lojasNovas.findIndex((l) => l.origem_integracao_id === lojaId);
      const base = i >= 0 ? lojasNovas[i] : { origem_integracao_id: lojaId, ...d.padrao };
      const atualizada = { ...base, [campo]: valor };
      if (i >= 0) lojasNovas[i] = atualizada; else lojasNovas.push(atualizada);
      return { ...d, lojas: lojasNovas };
    });
  }

  async function salvar(lojaId) {
    setSalvando(lojaId);
    setErro('');
    try {
      const l = dados.lojas.find((x) => x.origem_integracao_id === lojaId) || dados.padrao;
      await api.put(`/full/parametros/${lojaId}`, {
        dias_cobertura_alvo: Number(l.dias_cobertura_alvo),
        lead_time_dias: Number(l.lead_time_dias),
        dias_seguranca: Number(l.dias_seguranca),
        multiplo_envio: Number(l.multiplo_envio),
        janela_vendas_dias: Number(l.janela_vendas_dias),
      });
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(null);
    }
  }

  const comFull = (lojas || []).filter((l) => l.temLeitura && l.conectada);

  return (
    <div className="viagem-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar(); }}>
      <div className="card full-modal estreito" role="dialog" aria-modal="true" aria-label="Ajustes do Full">
        <div className="full-modal-topo">
          <div>
            <h2><Settings2 size={18} /> Ajustes do Full</h2>
            <p className="page-sub" style={{ margin: 0 }}>
              Ficam por loja, e não num ajuste único, porque o prazo de recebimento do Mercado Livre não é o mesmo
              do da Shopee — e as duas contas da casa não mandam no mesmo ritmo.
            </p>
          </div>
          <button className="icon-btn" onClick={onFechar} aria-label="Fechar"><X size={16} /></button>
        </div>

        {erro && <div className="login-error">{erro}</div>}
        {!dados ? <Skeleton height={180} /> : comFull.map((loja) => (
          <div key={loja.id} className="full-param-loja">
            <div className="full-param-cabeca">
              <SeloPlataforma chave={chaveDaPlataforma(loja.marketplace)} size={16} />
              <b>{nomeDaLoja(loja)}</b>
            </div>
            <div className="full-param-campos">
              <Field label="Envio deve durar (dias)" hint="O padrão da tela ao abrir.">
                <input type="number" min="1" value={valorDaLoja(loja.id, 'dias_cobertura_alvo')}
                  onChange={(e) => mudar(loja.id, 'dias_cobertura_alvo', e.target.value)} />
              </Field>
              <Field label="Recebimento (dias)" hint="Da nossa expedição até a peça ficar vendável lá dentro.">
                <input type="number" min="0" value={valorDaLoja(loja.id, 'lead_time_dias')}
                  onChange={(e) => mudar(loja.id, 'lead_time_dias', e.target.value)} />
              </Field>
              <Field label="Segurança (dias)" hint="Colchão por cima do recebimento, para atraso.">
                <input type="number" min="0" value={valorDaLoja(loja.id, 'dias_seguranca')}
                  onChange={(e) => mudar(loja.id, 'dias_seguranca', e.target.value)} />
              </Field>
              <Field label="Múltiplo de envio" hint="Caixa fechada ou grade. 1 = sem arredondamento.">
                <input type="number" min="1" value={valorDaLoja(loja.id, 'multiplo_envio')}
                  onChange={(e) => mudar(loja.id, 'multiplo_envio', e.target.value)} />
              </Field>
              <Field label="Janela de venda (dias)" hint="Período usado para medir a velocidade dos anúncios já estabelecidos.">
                <input type="number" min="1" value={valorDaLoja(loja.id, 'janela_vendas_dias')}
                  onChange={(e) => mudar(loja.id, 'janela_vendas_dias', e.target.value)} />
              </Field>
            </div>
            <button className="btn btn-primary" disabled={salvando === loja.id} onClick={() => salvar(loja.id)}>
              {salvando === loja.id ? 'Gravando…' : 'Gravar'}
            </button>
          </div>
        ))}
        <div className="full-modal-rodape">
          <button className="btn btn-ghost" onClick={onFechar}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------
const COLUNAS_ORDENAVEIS = {
  urgencia: (a) => -(URGENCIAS[a.reposicao.urgencia]?.peso ?? 0),
  titulo: (a) => a.titulo,
  loja: (a) => `${a.marketplace}${a.lojaNome || ''}`,
  saldo: (a) => a.saldo.disponivel,
  cobertura: (a) => a.reposicao.coberturaDias,
  enviar: (a) => a.reposicao.precisaEnviar,
  limite: (a) => a.reposicao.dataLimiteEnvio,
  velocidade: (a) => a.velocidade.porDia,
  tempo: (a) => a.diasNoFull,
  vendas: (a) => a.desempenho.vendasJanela,
};

const ORDENS = [
  { chave: 'urgencia', rotulo: 'Urgência' },
  { chave: 'limite', rotulo: 'Data limite' },
  { chave: 'cobertura', rotulo: 'Dias que dura' },
  { chave: 'enviar', rotulo: 'Peças a mandar' },
  { chave: 'vendas', rotulo: 'Vendas' },
  { chave: 'velocidade', rotulo: 'Velocidade' },
  { chave: 'saldo', rotulo: 'Saldo no Full' },
  { chave: 'tempo', rotulo: 'Tempo no Full' },
  { chave: 'titulo', rotulo: 'Título' },
  { chave: 'loja', rotulo: 'Loja' },
];

export default function FullPage() {
  const [lojas, setLojas] = useState([]);
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [sincronizando, setSincronizando] = useState(false);

  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [lojaIds, setLojaIds] = useState([]);
  const [plataformas, setPlataformas] = useState([]);
  const [urgencias, setUrgencias] = useState([]);
  const [soRepor, setSoRepor] = useState(false);
  // Vazio quer dizer "usa o parâmetro gravado da loja". Cravar 60 e 30 aqui
  // e mandar sempre os dois era o que fazia os Ajustes do Full gravarem
  // campos que não mudavam número nenhum na tela.
  const [janela, setJanela] = useState('');
  const [diasAlvo, setDiasAlvo] = useState('');
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);

  const [modo, setModo] = useState('cartoes');
  const [marcados, setMarcados] = useState(new Set());
  const [aberto, setAberto] = useState(null);
  const [planoAberto, setPlanoAberto] = useState(null);
  const [parametrosAbertos, setParametrosAbertos] = useState(false);

  const carregarLojas = useCallback(() => {
    api.get('/full/lojas').then(setLojas).catch(() => {});
  }, []);

  const carregar = useCallback(() => {
    setCarregando(true);
    const p = new URLSearchParams();
    if (buscaAplicada) p.set('busca', buscaAplicada);
    if (lojaIds.length) p.set('integracao_id', lojaIds.join(','));
    if (plataformas.length) p.set('marketplace', plataformas.join(','));
    if (urgencias.length) p.set('urgencia', urgencias.join(','));
    if (soRepor) p.set('so_repor', 'true');
    if (janela) p.set('janela', String(janela));
    if (diasAlvo) p.set('dias_alvo', String(diasAlvo));
    api.get(`/full?${p}`)
      .then((r) => { setDados(r); setErro(''); })
      .catch((e) => setErro(e.message))
      .finally(() => setCarregando(false));
  }, [buscaAplicada, lojaIds, plataformas, urgencias, soRepor, janela, diasAlvo]);

  useEffect(carregarLojas, [carregarLojas]);
  useEffect(carregar, [carregar]);

  async function sincronizar(integracaoId) {
    setSincronizando(true);
    setErro('');
    setAviso('');
    try {
      const r = await api.post('/full/sincronizar', { integracao_id: integracaoId || null });
      const falhas = (r.lojas || []).filter((l) => !l.ok);
      const avisos = (r.lojas || []).filter((l) => l.ok && l.aviso);
      if (falhas.length) setErro(falhas.map((f) => `${f.nome || 'loja'}: ${f.erro}`).join(' · '));
      if (avisos.length) setAviso(avisos.map((v) => v.aviso).join(' · '));
      carregarLojas();
      carregar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSincronizando(false);
    }
  }

  const anuncios = dados?.anuncios || [];
  const resumo = dados?.resumo;
  // O período que VALEU: o escolhido na tela, ou o que o servidor aplicou a
  // partir do parâmetro da loja. A tela nunca escreve o estado vazio.
  // O período que valeu, dito com honestidade: um número quando é um só, e a
  // lista quando lojas ou itens têm períodos diferentes. Afirmar o do
  // primeiro anúncio fazia a frase mudar conforme a pessoa filtrava.
  const alvosUsados = dados?.premissas?.diasAlvoUsados || [];
  const diasAlvoEfetivo = diasAlvo
    ? `${diasAlvo} dias`
    : (alvosUsados.length === 1 ? `${alvosUsados[0]} dias`
      : (alvosUsados.length > 1 ? `${alvosUsados.join(', ')} dias (varia por loja)` : '—'));

  const tabela = useTabela(anuncios, {
    colunas: COLUNAS_ORDENAVEIS,
    colunaPadrao: 'urgencia',
    direcaoPadrao: 'asc',
    tamanhoPadrao: 50,
  });

  const opcoesLojas = useMemo(() => lojas
    .filter((l) => l.temLeitura)
    .map((l) => ({ valor: String(l.id), rotulo: nomeDaLoja(l) })), [lojas]);

  const opcoesPlataformas = useMemo(() => {
    const presentes = [...new Set(lojas.filter((l) => l.temLeitura).map((l) => l.marketplace))];
    return presentes.map((m) => ({ valor: m, rotulo: PLATAFORMA_LABEL[m] || m }));
  }, [lojas]);

  const alvosMarcados = useMemo(
    () => anuncios.filter((a) => marcados.has(a.chave)),
    [anuncios, marcados]
  );

  function alternarMarca(chave) {
    setMarcados((atual) => {
      const novo = new Set(atual);
      if (novo.has(chave)) novo.delete(chave); else novo.add(chave);
      return novo;
    });
  }

  function marcarTudoQuePrecisa() {
    setMarcados(new Set(anuncios.filter((a) => (a.reposicao.precisaEnviar || 0) > 0).map((a) => a.chave)));
  }

  const chips = useMemo(() => {
    const itens = [];
    if (buscaAplicada) {
      itens.push({ chave: 'busca', rotulo: 'Busca', valor: buscaAplicada, onRemover: () => { setBusca(''); setBuscaAplicada(''); } });
    }
    if (lojaIds.length) {
      itens.push({
        chave: 'loja',
        rotulo: lojaIds.length > 1 ? 'Lojas' : 'Loja',
        valor: lojaIds.map((id) => nomeDaLoja(lojas.find((x) => String(x.id) === String(id)))).join(', '),
        onRemover: () => setLojaIds([]),
      });
    }
    if (plataformas.length) {
      itens.push({
        chave: 'mkt',
        rotulo: 'Plataforma',
        valor: plataformas.map((m) => PLATAFORMA_LABEL[m] || m).join(', '),
        onRemover: () => setPlataformas([]),
      });
    }
    if (urgencias.length) {
      itens.push({
        chave: 'urgencia',
        rotulo: 'Situação',
        valor: urgencias.map((u) => URGENCIAS[u]?.rotulo || u).join(', '),
        onRemover: () => setUrgencias([]),
      });
    }
    if (soRepor) {
      itens.push({ chave: 'repor', rotulo: 'Recorte', valor: 'só o que precisa repor', onRemover: () => setSoRepor(false) });
    }
    if (janela) {
      itens.push({
        chave: 'janela',
        rotulo: 'Venda medida por',
        valor: JANELAS_VENDA.find((j) => String(j.valor) === String(janela))?.rotulo || `${janela} dias`,
        onRemover: () => setJanela(''),
      });
    }
    if (diasAlvo) {
      itens.push({
        chave: 'alvo',
        rotulo: 'Envio deve durar',
        valor: `${diasAlvo} dias`,
        onRemover: () => setDiasAlvo(''),
      });
    }
    return itens;
  }, [buscaAplicada, lojaIds, lojas, plataformas, urgencias, soRepor, janela, diasAlvo]);

  const nenhumaLojaComFull = lojas.length > 0 && lojas.every((l) => !l.temLeitura || !l.conectada);
  const jaLeuAlguma = lojas.some((l) => l.ultima_sincronizacao);

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Full</h1>
          <p className="page-sub">
            O estoque que está dentro do centro de distribuição do marketplace — o único que a casa tem e não vê no
            galpão. Aqui: o que está lá, desde quando, quanto vendeu, quanto tempo ainda dura, quanto precisa
            mandar e até que dia a caixa tem que sair daqui.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => setParametrosAbertos(true)}>
            <Settings2 size={14} /> Ajustes do Full
          </button>
          <button
            className="btn btn-primary"
            onClick={() => sincronizar(null)}
            disabled={sincronizando || nenhumaLojaComFull}
          >
            <RefreshCw size={14} className={sincronizando ? 'girando' : ''} />
            {sincronizando ? 'Lendo o fulfillment…' : 'Atualizar das lojas'}
          </button>
        </div>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && (
        <div className="full-aviso" style={{ marginBottom: 12 }}>
          <Info size={14} /><span>{aviso}</span>
        </div>
      )}

      <FaixaLojasFull lojas={lojas} onSincronizar={sincronizar} sincronizando={sincronizando} />

      {/* ---- filtros ---- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <CampoBusca
            valor={busca}
            onChange={setBusca}
            onSubmit={(valor) => setBuscaAplicada(valor === '' ? '' : busca)}
            placeholder="Título, SKU, código do anúncio ou referência"
          />
          <MultiSelect
            valor={lojaIds}
            onChange={setLojaIds}
            opcoes={opcoesLojas}
            rotuloTudo="Todas as lojas"
            rotuloVazio="Todas as lojas"
            larguraMinima={190}
          />
          {/* O período do envio mora no filtro, e não escondido no plano, de
              propósito: ele muda TODAS as contas da tela ao mesmo tempo — a
              quantidade a mandar, a data limite e a urgência. */}
          <span className="full-filtro-alvo" title="Quanto tempo o próximo envio deve durar dentro do Full. Muda a quantidade e a data de toda a tela.">
            <Timer size={13} />
            <span>envio deve durar</span>
            <Select value={String(diasAlvo)} onChange={(e) => setDiasAlvo(e.target.value)} style={{ maxWidth: 150 }}>
              <option value="">o padrão da loja</option>
              {PERIODOS_RAPIDOS.map((d) => <option key={d} value={d}>{d} dias</option>)}
            </Select>
          </span>
          <FiltrosAvancados
            ativos={(plataformas.length ? 1 : 0) + (urgencias.length ? 1 : 0) + (soRepor ? 1 : 0) + (janela ? 1 : 0)}
            aberto={filtrosAbertos}
            onAlternar={() => setFiltrosAbertos((v) => !v)}
            resumo="Plataforma, situação da reposição e janela de venda."
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <MultiSelect
                valor={plataformas}
                onChange={setPlataformas}
                opcoes={opcoesPlataformas}
                rotuloTudo="Todas as plataformas"
                rotuloVazio="Todas as plataformas"
                larguraMinima={180}
              />
              <MultiSelect
                valor={urgencias}
                onChange={setUrgencias}
                opcoes={OPCOES_URGENCIA}
                rotuloTudo="Qualquer situação"
                rotuloVazio="Qualquer situação"
                larguraMinima={200}
              />
              <span className="full-filtro-alvo" title="Período usado para medir a venda dos anúncios que já estão há mais de 30 dias no Full.">
                <span>medir venda por</span>
                <Select value={String(janela)} onChange={(e) => setJanela(e.target.value)} style={{ maxWidth: 190 }}>
                  <option value="">a janela padrão da loja</option>
                  {JANELAS_VENDA.map((j) => <option key={j.valor} value={j.valor}>{j.rotulo}</option>)}
                </Select>
              </span>
              <label className="full-toggle-inline">
                <Toggle checked={soRepor} onChange={() => setSoRepor((v) => !v)} />
                <span>só o que precisa repor</span>
              </label>
            </div>
          </FiltrosAvancados>
        </div>
        {chips.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <ChipsFiltros
              itens={chips}
              onLimparTudo={() => {
                setBusca(''); setBuscaAplicada(''); setLojaIds([]); setPlataformas([]);
                setUrgencias([]); setSoRepor(false); setJanela(''); setDiasAlvo('');
              }}
            />
          </div>
        )}
      </div>

      {/* ---- indicadores ---- */}
      {!carregando && resumo && anuncios.length > 0 && (
        <div className="indicadores-faixa compacta" style={{ marginBottom: 16 }}>
          <IndicadorDestaque
            destaque
            Icone={Warehouse}
            rotulo="Peças no Full"
            valor={resumo.pecasNoFull != null ? formatQtd(resumo.pecasNoFull) : '—'}
            explicacao={`Distribuídas em ${formatQtd(resumo.anuncios)} anúncio(s).`
              + (resumo.temKit && resumo.unidadesNoFull != null
                ? ` São ${formatQtd(resumo.unidadesNoFull)} unidades de anúncio — há kit no recorte, e o marketplace conta unidades, não peças.`
                : '')
              + (resumo.emTransito ? ` Outras ${formatQtd(resumo.emTransito)} peças estão a caminho.` : '')}
          />
          <IndicadorDestaque
            Icone={Send}
            tom={resumo.precisamRepor > 0 ? 'atencao' : undefined}
            rotulo="Precisam de envio"
            valor={formatQtd(resumo.precisamRepor)}
            explicacao={`Somam ${formatQtd(resumo.pecasAEnviar)} peças para o envio durar ${diasAlvoEfetivo}`
              + (resumo.temKit ? ` (${formatQtd(resumo.unidadesAEnviar)} unidades de anúncio)` : '')
              + ' — '
              + `${resumo.estoqueCasa != null ? `há ${formatQtd(resumo.estoqueCasa)} peças dessas referências no galpão.` : 'o saldo do galpão não pôde ser lido.'}`}
          />
          <IndicadorDestaque
            Icone={Flame}
            tom={resumo.emRuptura > 0 ? 'perigo' : undefined}
            rotulo="Zerados no Full"
            valor={formatQtd(resumo.emRuptura)}
            explicacao="Anúncios com saldo zero dentro do centro de distribuição. Cada dia assim é venda perdida que não aparece em relatório nenhum."
          />
          <IndicadorDestaque
            Icone={AlertTriangle}
            tom={resumo.atrasados > 0 ? 'perigo' : undefined}
            rotulo="Envio atrasado"
            valor={formatQtd(resumo.atrasados)}
            explicacao="A data limite de saída daqui já passou — mesmo mandando hoje, a peça chega depois de o saldo encostar no mínimo."
          />
          <IndicadorDestaque
            Icone={Info}
            rotulo="Sem venda para medir"
            valor={formatQtd(resumo.semMedida)}
            explicacao="Anúncios sem venda na base medida. Eles não ganham previsão de duração — um número inventado seria pior que nenhum."
          />
        </div>
      )}

      {/* ---- barra de modo e seleção ---- */}
      {anuncios.length > 0 && (
        <div className="full-barra-topo">
          <div className="modo-exibicao" role="group" aria-label="Como ver a lista">
            <button
              type="button"
              className={'modo-btn' + (modo === 'cartoes' ? ' active' : '')}
              onClick={() => setModo('cartoes')}
            >
              <LayoutGrid size={13} /> Cartões
            </button>
            <button
              type="button"
              className={'modo-btn' + (modo === 'tabela' ? ' active' : '')}
              onClick={() => setModo('tabela')}
            >
              <Table2 size={13} /> Tabela
            </button>
          </div>

          <div className="full-ordenar">
            <span>Ordenar por</span>
            <Select
              value={tabela.coluna}
              onChange={(e) => { if (e.target.value !== tabela.coluna) tabela.ordenarPor(e.target.value); }}
              style={{ maxWidth: 180 }}
            >
              {ORDENS.map((o) => <option key={o.chave} value={o.chave}>{o.rotulo}</option>)}
            </Select>
            {/* Inverter fica num botão próprio: escolher a coluna de novo no
                seletor para virar a ordem é um atalho que ninguém descobre. */}
            <button
              type="button"
              className="icon-btn"
              onClick={() => tabela.ordenarPor(tabela.coluna)}
              title={tabela.direcao === 'asc' ? 'Inverter: do maior para o menor' : 'Inverter: do menor para o maior'}
              aria-label="Inverter a ordem"
            >
              <ArrowRight size={14} style={{ transform: tabela.direcao === 'asc' ? 'rotate(90deg)' : 'rotate(-90deg)' }} />
            </button>
          </div>

          <div className="full-selecao-acoes">
            <button className="btn btn-ghost" onClick={marcarTudoQuePrecisa}>
              <Sparkles size={13} /> Marcar tudo que precisa de envio
            </button>
            {marcados.size > 0 && (
              <>
                <button className="btn btn-ghost" onClick={() => setMarcados(new Set())}>Limpar seleção</button>
                <button
                  className="btn btn-primary"
                  onClick={() => setPlanoAberto(alvosMarcados)}
                  disabled={alvosMarcados.length === 0}
                >
                  <Factory size={14} /> Plano de produção ({marcados.size})
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- a lista ---- */}
      {carregando ? (
        <div className="full-grade">
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={330} radius={12} />)}
        </div>
      ) : anuncios.length === 0 ? (
        <EstadoVazio
          Icone={Warehouse}
          titulo={jaLeuAlguma ? 'Nenhum anúncio no fulfillment com estes filtros' : 'O fulfillment ainda não foi lido'}
          descricao={jaLeuAlguma
            ? 'Nenhum anúncio bate com o recorte atual. Limpe os filtros para ver tudo que está no Full.'
            : 'Clique em "Atualizar das lojas" para ler o que está no centro de distribuição de cada marketplace. '
              + 'A leitura usa os anúncios que a aba Anúncios já trouxe — se ela nunca foi sincronizada, comece por lá.'}
          acaoLabel={jaLeuAlguma ? undefined : 'Atualizar das lojas'}
          onAcao={jaLeuAlguma ? undefined : () => sincronizar(null)}
          IconeAcao={RefreshCw}
        />
      ) : modo === 'cartoes' ? (
        <>
          <div className="full-grade">
            {tabela.itensPagina.map((a) => (
              <CartaoFull
                key={a.chave}
                anuncio={a}
                hoje={dados?.hoje}
                marcado={marcados.has(a.chave)}
                onMarcar={() => alternarMarca(a.chave)}
                onAbrir={() => setAberto(a)}
              />
            ))}
          </div>
          <Paginacao {...tabela} />
        </>
      ) : (
        <>
          <TabelaFull
            itens={tabela.itensPagina}
            marcados={marcados}
            onMarcar={alternarMarca}
            onAbrir={setAberto}
            hoje={dados?.hoje}
          />
          <Paginacao {...tabela} />
        </>
      )}

      {/* ---- o rodapé que explica a conta ---- */}
      {!carregando && anuncios.length > 0 && dados?.premissas && (
        <p className="full-premissas">
          Contas desta tela: a velocidade de um anúncio com <b>30 dias ou mais</b> no fulfillment vem da venda dos
          últimos <b>{(dados.premissas.janelasUsadas || []).join(' / ') || dados.premissas.janelaDias} dias</b>;
          abaixo disso, vem da <b>venda geral do anúncio</b>,
          incluindo o período em que ele ainda não estava lá. O mínimo é o que o anúncio vende no prazo de
          recebimento mais a margem de segurança da loja, e a quantidade a mandar cobre <b>{diasAlvoEfetivo}</b> além
          desse mínimo. O saldo dentro do centro de distribuição foi lido na última sincronização; o histórico do
          saldo é retratado por este sistema, um retrato por dia — nenhuma plataforma o devolve.
        </p>
      )}

      {aberto && (
        <PainelFull
          alvo={aberto}
          janela={janela}
          diasAlvo={diasAlvo}
          onFechar={() => setAberto(null)}
          onAlterado={carregar}
        />
      )}
      {planoAberto && (
        <ModalPlano
          alvos={planoAberto}
          janela={janela}
          diasAlvoInicial={diasAlvo}
          onFechar={() => setPlanoAberto(null)}
        />
      )}
      {parametrosAbertos && (
        <ModalParametros lojas={lojas} onFechar={() => { setParametrosAbertos(false); carregar(); }} />
      )}
    </div>
  );
}
