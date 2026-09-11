import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import logoHbnHub from '../assets/logo-hbn-hub.png';
import { dataBr, formatQtd, numeroBr } from '../lib/format';

// O PAPEL DA REMESSA AO FULL (11/09/2026).
//
// Duas folhas, porque são dois processos e cada um precisa de uma informação
// diferente — foi exatamente o pedido da dona:
//
//   1. KIT MONTADO — quantos kits de cada combinação e de cada tamanho vão
//      nesta remessa. É o papel de QUEM MONTA E DESPACHA: ele conta caixas de
//      kit, não camisas soltas.
//
//   2. KIT DESMEMBRADO — a grade cor × tamanho em peças unitárias, no mesmo
//      formato da grade de estoque que a casa já lê. É o papel de QUEM CORTA:
//      a fábrica não sabe o que é "Preto-Marinho-Marrom", ela sabe quantas
//      pretas P, quantas marinho M.
//
// POR QUE ISTO NÃO É O MODAL IMPRESSO
//
// Mandar `window.print()` no modal não funcionava, e não era questão de
// ajuste: o modal é `position: fixed` dentro de um overlay com `inset: 0` e
// `overflow-y: auto`. Elemento fixo imprime UMA página e o que passa disso é
// cortado; a rolagem interna some. O resultado era a primeira dobra da tela e
// mais nada — "não aparece opção".
//
// Aqui o documento é outro: um bloco próprio, em fluxo normal, montado num
// portal no <body>. No `@media print` o resto da aplicação fica invisível e
// só ele aparece, em página A4, com quebra controlada entre os cartões.

// Uma cor de tela para a bolinha. `hex` vem do cadastro (migration 0066);
// sem ele, um cinza neutro — inventar uma cor faria o papel mentir de
// relance, que é justamente o que a bolinha veio evitar.
function Bolinha({ hex, cor }) {
  const nome = String(cor || '').toUpperCase();
  const estilo = hex
    ? (nome.includes('MESCLA')
      ? { backgroundImage: `repeating-linear-gradient(45deg, ${hex} 0 3px, ${hex}88 3px 6px)` }
      : { background: hex })
    : undefined;
  return <span className={`imp-bolinha${hex ? '' : ' imp-bolinha-vazia'}`} style={estilo} />;
}

function Chip({ cor, hex }) {
  return (
    <span className="imp-chip"><Bolinha hex={hex} cor={cor} />{cor}</span>
  );
}

// A ordem em que a casa lê tamanho. Tamanho fora da lista vai para o fim, em
// ordem alfabética — nunca sumindo da grade.
const ORDEM_TAMANHO = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG', 'U', 'ÚNICO', 'UNICO'];
function compararTamanho(a, b) {
  const ia = ORDEM_TAMANHO.indexOf(String(a).toUpperCase());
  const ib = ORDEM_TAMANHO.indexOf(String(b).toUpperCase());
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
}
function ordenarTamanhos(lista) {
  return [...lista].sort(compararTamanho);
}

// A mesma normalização que o plano usa para agrupar cor e tamanho no
// servidor (full.js: normalizar). Tem de ser a mesma, ou a grade separa o que
// o plano juntou.
function normalizarCor(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

// Soma que sabe a diferença entre zero e "não medido" (REGRA 2).
//
// Somar tratando nulo como 0 imprime um total que parece medido e não é —
// e num papel que manda cortar, um zero falso é pior que um traço.
function somaOuTraco(itens, campo) {
  let houve = false;
  let soma = 0;
  for (const x of itens || []) {
    const v = x?.[campo];
    if (v == null) continue;
    houve = true;
    soma += Number(v) || 0;
  }
  return houve ? soma : null;
}

// ---------------------------------------------------------------------------
// Folha 1 — KIT MONTADO
// ---------------------------------------------------------------------------
// Um número só quando ele é único de verdade.
//
// Dois anúncios podem ter períodos diferentes (um com cobertura manual de 20
// dias, outro com os 60 da loja) e janelas de medição diferentes (cada loja
// mede no seu período). Carimbar o número do PRIMEIRO anúncio no papel
// inteiro é afirmar uma premissa que não vale para metade dele — e a tela já
// não faz isso (REGRA 2).
function numeroUnico(lista) {
  const limpa = [...new Set((lista || []).filter((x) => x != null))];
  return limpa.length === 1 ? limpa[0] : null;
}
function textoDePeriodo(lista, sufixo) {
  const unico = numeroUnico(lista);
  if (unico != null) return `${unico} ${sufixo}`;
  const limpa = [...new Set((lista || []).filter((x) => x != null))].sort((a, b) => a - b);
  if (limpa.length === 0) return `— ${sufixo}`;
  return `${limpa.join(', ')} ${sufixo} (varia por anúncio)`;
}

function FolhaKitMontado({ anuncios, plano }) {
  // Um cartão por COMBINAÇÃO de kit (a cor da variação), com uma linha por
  // tamanho. É a unidade em que a expedição trabalha.
  //
  // Cada cartão carrega o ANÚNCIO dele. Período, janela de medição, mínimo e
  // loja são premissas de cada anúncio, não do papel: num plano com dois
  // anúncios, escrever os números do primeiro em cima do segundo manda
  // separar a quantidade errada.
  const kits = [];
  for (const a of anuncios) {
    const porCombinacao = new Map();
    for (const u of a.unidades) {
      const combinacao = u.cor || '(sem combinação)';
      if (!porCombinacao.has(combinacao)) {
        porCombinacao.set(combinacao, {
          anuncio: a,
          combinacao,
          pecas: (u.composicao || []).map((c) => ({ cor: c.cor, hex: c.hex })),
          linhas: [],
        });
      }
      const alvo = porCombinacao.get(combinacao);
      if (alvo.pecas.length === 0 && (u.composicao || []).length > 0) {
        alvo.pecas = u.composicao.map((c) => ({ cor: c.cor, hex: c.hex }));
      }
      alvo.linhas.push({
        id: u.id,
        sku: u.sku || null,
        tamanho: u.tamanho || null,
        vendido: u.vendasNaBase,
        mediaDia: u.velocidadeDia,
        // O MÍNIMO É O MÍNIMO DO FULL, medido, e não a demanda do período.
        // O mínimo do sistema é o que o anúncio vende no prazo de recebimento
        // mais a margem de segurança — é o que a tela mostra e é o que a
        // observação no pé desta própria folha define. Recalculá-lo aqui como
        // velocidade × período imprimia 60 onde a tela diz 20, e quem
        // conferisse os dois concluiria que um deles está quebrado.
        minimo: u.estoqueMinimo ?? null,
        enviar: u.precisaEnviarUnidade || 0,
      });
    }
    for (const k of porCombinacao.values()) {
      // P, M, G, GG — a ordem em que a casa lê, não a alfabética (que poria
      // GG antes de M). O comparador tem de ser consistente: o de antes
      // devolvia 1 para tamanhos iguais e embaralhava a grade.
      k.linhas.sort((x, y) => compararTamanho(x.tamanho || '', y.tamanho || ''));
      // Tamanho que não vendeu e não precisa de envio é ruído no papel — mas
      // um que vendeu e não precisa de nada FICA, porque a ausência dele
      // pareceria esquecimento.
      k.linhas = k.linhas.filter((l) => (l.enviar || 0) > 0 || (l.vendido || 0) > 0);
      k.total = {
        vendido: somaOuTraco(k.linhas, 'vendido'),
        mediaDia: somaOuTraco(k.linhas, 'mediaDia'),
        minimo: somaOuTraco(k.linhas, 'minimo'),
        enviar: k.linhas.reduce((s, l) => s + (l.enviar || 0), 0),
      };
      k.diasAlvo = k.anuncio?.reposicao?.diasAlvo ?? null;
      k.janela = k.anuncio?.velocidade?.dias ?? null;
      k.baseGeral = k.anuncio?.velocidade?.base === 'geral';
      kits.push(k);
    }
  }
  kits.sort((a, b) => b.total.enviar - a.total.enviar);

  const totalEnviar = kits.reduce((s, k) => s + k.total.enviar, 0);
  const totalVendido = somaOuTraco(kits.map((k) => k.total), 'vendido');
  const variosAnuncios = anuncios.length > 1;
  const a0 = anuncios[0];
  // As premissas do DOCUMENTO saem da lista que a rota devolve, não do
  // primeiro anúncio.
  const diasAlvoLista = plano.diasAlvoUsados?.length
    ? plano.diasAlvoUsados
    : anuncios.map((a) => a?.reposicao?.diasAlvo);
  const janelaLista = plano.janelasUsadas?.length
    ? plano.janelasUsadas
    : anuncios.map((a) => a?.velocidade?.dias);
  const diasAlvoUnico = numeroUnico(diasAlvoLista);
  const janelaUnica = numeroUnico(janelaLista);
  const segurancaLista = anuncios.map((a) => a?.parametros?.dias_seguranca ?? null);
  const segurancaUnica = numeroUnico(segurancaLista);
  const leadUnico = numeroUnico(anuncios.map((a) => a?.parametros?.lead_time_dias ?? null));
  // Alguma base é a venda GERAL do anúncio (menos de 30 dias no Full)? Então
  // a coluna "vendido" não é venda do Full no período, e o papel diz isso.
  const algumaBaseGeral = kits.some((k) => k.baseGeral);

  return (
    <section className="imp-folha">
      <header className="imp-cabeca">
        <img className="imp-logo" src={logoHbnHub} alt="" />
        <div className="imp-titulo">
          <h1>{variosAnuncios ? `Remessa ao Full — ${anuncios.length} anúncios` : (a0?.titulo || 'Remessa Full')}</h1>
          <p>PLANEJAMENTO DE ENVIO · KIT MONTADO</p>
        </div>
        <div className="imp-cabeca-direita">
          <div>Vendas analisadas: {textoDePeriodo(janelaLista, 'dias')}</div>
          <div>Emitido em: {dataBr(plano.hoje) || ''}</div>
        </div>
      </header>

      <div className="imp-intro">
        Este relatório define as quantidades a enviar na remessa ao Full para{' '}
        <b>{kits.length === 1 ? 'a combinação abaixo' : `as ${kits.length} combinações abaixo`}</b>, com base na
        venda real de cada anúncio. As quantidades cobrem{' '}
        <b>{textoDePeriodo(diasAlvoLista, 'dias')} até a próxima remessa</b>
        {segurancaUnica > 0 && <>, já com {segurancaUnica} dias de margem de segurança para evitar ruptura no Full</>}
        {segurancaUnica == null && <>, já com a margem de segurança de cada loja</>}.
      </div>

      <h2 className="imp-secao">QUANTIDADE POR KIT / TAMANHO — ENVIAR AGORA</h2>

      {kits.map((k, i) => (
        <article className="imp-kit" key={`${k.anuncio?.chave || ''}-${k.combinacao}-${i}`}>
          <div className="imp-kit-num">{i + 1}</div>
          <div className="imp-kit-corpo">
            <div className="imp-kit-topo">
              <div className="imp-kit-nome">
                {k.pecas.length > 0
                  ? k.pecas.map((p) => p.cor).join(' · ')
                  : k.combinacao}
                {/* Com mais de um anúncio no papel, cada cartão diz de qual
                    anúncio e de qual loja ele é — sem isso, quem despacha não
                    tem como saber que metade da folha é de outra loja. */}
                {variosAnuncios && (
                  <small className="imp-kit-origem">{k.anuncio?.titulo} · {k.anuncio?.lojaNome}</small>
                )}
              </div>
              <div className="imp-kit-total">
                <b>{formatQtd(k.total.enviar)} un.</b>
                <span>
                  {k.total.vendido != null ? `${formatQtd(k.total.vendido)} un. vendidas` : 'venda não medida'}
                  {k.janela != null && ` em ${k.janela} dias`}
                  {k.baseGeral && ' (venda geral do anúncio)'}
                </span>
              </div>
            </div>
            {k.pecas.length > 0 && (
              <div className="imp-chips">
                {k.pecas.map((p, j) => <Chip key={`${p.cor}-${j}`} cor={p.cor} hex={p.hex} />)}
              </div>
            )}
            <table className="imp-tabela">
              <thead>
                <tr>
                  <th>TAMANHO</th>
                  <th className="n">VENDIDO {k.janela != null ? `${k.janela}D` : '—'}</th>
                  <th className="n">MÉDIA/DIA</th>
                  <th className="n">MÍNIMO NO FULL</th>
                  <th className="n destaque">
                    {(k.anuncio?.parametros?.dias_seguranca ?? 0) > 0 ? 'ENVIAR (C/ MARGEM)' : 'ENVIAR'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {k.linhas.map((l) => (
                  <tr key={l.id ?? `${l.tamanho}-${l.sku}`}>
                    <td className="imp-tam">
                      {l.tamanho || <span className="imp-vazio">sem tamanho lido{l.sku ? ` · ${l.sku}` : ''}</span>}
                    </td>
                    <td className="n">{l.vendido != null ? formatQtd(l.vendido) : '—'}</td>
                    <td className="n">{l.mediaDia != null ? numeroBr(l.mediaDia, 2) : '—'}</td>
                    <td className="n">{l.minimo != null ? formatQtd(l.minimo) : '—'}</td>
                    <td className="n destaque">{formatQtd(l.enviar)}</td>
                  </tr>
                ))}
                <tr className="imp-total">
                  <td>Total</td>
                  <td className="n">{k.total.vendido != null ? formatQtd(k.total.vendido) : '—'}</td>
                  <td className="n">{k.total.mediaDia != null ? numeroBr(k.total.mediaDia, 2) : '—'}</td>
                  <td className="n">{k.total.minimo != null ? formatQtd(k.total.minimo) : '—'}</td>
                  <td className="n destaque">{formatQtd(k.total.enviar)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      ))}

      <div className="imp-kpis">
        <div className="imp-kpi"><b>{formatQtd(totalEnviar)} un.</b><span>TOTAL DESTA REMESSA</span></div>
        <div className="imp-kpi">
          <b>{totalVendido != null ? `${formatQtd(totalVendido)} un.` : '—'}</b>
          <span>
            VENDIDAS {kits.length > 1 ? `NOS ${kits.length} KITS` : 'NO KIT'}
            {janelaUnica != null ? ` (${janelaUnica}D)` : ''}
          </span>
        </div>
        <div className="imp-kpi">
          <b>{diasAlvoUnico != null ? `${diasAlvoUnico} dias` : 'varia'}</b>
          <span>COBERTURA ATÉ A PRÓXIMA REMESSA</span>
        </div>
        <div className="imp-kpi">
          <b>{segurancaUnica != null ? `${segurancaUnica} dias` : 'varia'}</b>
          <span>MARGEM DE SEGURANÇA</span>
        </div>
      </div>

      <h2 className="imp-secao">
        PRÓXIMA REMESSA — {diasAlvoUnico != null ? `EM ${diasAlvoUnico} DIAS` : 'CONFORME O PERÍODO DE CADA ANÚNCIO'}
      </h2>
      <div className="imp-caixa">
        Recalcule com base na venda real do Full nesse período — não repita simplesmente os mesmos números. Se o
        ritmo se mantiver estável, espere uma remessa semelhante, ajustando para cima os tamanhos que girarem mais.
      </div>

      <h3 className="imp-obs-titulo">OBSERVAÇÕES</h3>
      <ul className="imp-obs">
        <li>
          Quantidades = média diária da venda medida × o período de cobertura do anúncio, mais o estoque mínimo do
          Full, descontando o que já está lá dentro e o que já está a caminho.
        </li>
        <li>
          O mínimo do Full é o que o anúncio vende no prazo de recebimento
          {leadUnico != null ? ` (${leadUnico} dias)` : ' de cada loja'} mais a margem de segurança
          {segurancaUnica != null ? ` (${segurancaUnica} dias)` : ' de cada loja'} — é a coluna MÍNIMO NO FULL
          acima.
        </li>
        {algumaBaseGeral && (
          <li className="imp-alerta">
            Parte dos números vem da venda GERAL do anúncio, e não da venda dentro do Full: esses anúncios estão
            no fulfillment há menos tempo que a janela de medição. A coluna diz qual.
          </li>
        )}
        {plano.ressalvas?.composicaoSuposta?.length > 0 && (
          <li className="imp-alerta">
            Atenção: {plano.ressalvas.composicaoSuposta.length} linha(s) supõem que o kit é de uma cor só, porque a
            composição daquelas variações não foi registrada. Confira antes de cortar.
          </li>
        )}
      </ul>

      <footer className="imp-rodape">
        <span>Relatório interno · {variosAnuncios ? `${anuncios.length} anúncios` : (a0?.titulo || '')} · Remessa Full</span>
        <span>{variosAnuncios ? [...new Set(anuncios.map((a) => a.lojaNome).filter(Boolean))].join(' · ') : (a0?.lojaNome || '')}</span>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Folha 2 — KIT DESMEMBRADO
// ---------------------------------------------------------------------------
// A grade cor × tamanho em PEÇAS UNITÁRIAS, no mesmo formato da grade de
// estoque que a casa já lê. É o papel de quem corta: a fábrica não sabe o que
// é "Preto-Marinho-Marrom", ela sabe quantas pretas P e quantas marinho M.
//
// Três grades, e as três importam por motivos diferentes:
//   · A ENVIAR   — o que o Full precisa receber, em peça;
//   · JÁ NA CASA — o que sai da prateleira e não passa pelo corte;
//   · A PRODUZIR — o que vira ordem de produção. É a única que a facção lê.
function GradeCorTamanho({ linhas, campo, titulo, legenda }) {
  // AGRUPA POR COR NORMALIZADA, e não pelo texto cru.
  //
  // O plano guarda cada linha com a grafia com que ela foi gravada, e a mesma
  // cor pode ter sido registrada como "Preto" numa variação e "PRETO" noutra.
  // Agrupando pelo texto, a grade imprimia DUAS linhas de cor — uma com valor
  // só no P e outra só no M, cada uma com metade do total. O totalizador
  // fechava e a leitura era falsa.
  const porCor = new Map();
  for (const l of linhas) {
    const rotulo = l.cor || '—';
    const chave = normalizarCor(rotulo);
    if (!porCor.has(chave)) porCor.set(chave, { rotulo, hex: l.hex || null, chave });
    const c = porCor.get(chave);
    if (!c.hex && l.hex) c.hex = l.hex;
  }
  const cores = [...porCor.values()].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
  const tamanhos = ordenarTamanhos([...new Set(linhas.map((l) => l.tamanho || '—'))]);
  const valor = (chaveCor, tam) => linhas
    .filter((l) => normalizarCor(l.cor || '—') === chaveCor && (l.tamanho || '—') === tam)
    .reduce((s, l) => s + (l[campo] || 0), 0);
  const totalGeral = linhas.reduce((s, l) => s + (l[campo] || 0), 0);
  if (totalGeral === 0) return null;

  return (
    <div className="imp-grade-bloco">
      <div className="imp-grade-titulo">{titulo}<small>{legenda}</small></div>
      <table className="imp-grade">
        <thead>
          <tr>
            <th>COR</th>
            {tamanhos.map((t) => <th key={t} className="n">{t}</th>)}
            <th className="n imp-grade-tot">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {cores.map((c) => {
            const total = tamanhos.reduce((s, t) => s + valor(c.chave, t), 0);
            return (
              <tr key={c.chave}>
                <td className="imp-grade-cor"><Bolinha hex={c.hex} cor={c.rotulo} />{c.rotulo}</td>
                {tamanhos.map((t) => {
                  const v = valor(c.chave, t);
                  return <td key={t} className={`n${v ? '' : ' imp-zero'}`}>{v ? formatQtd(v) : '–'}</td>;
                })}
                <td className="n imp-grade-tot">{formatQtd(total)}</td>
              </tr>
            );
          })}
          <tr className="imp-total">
            <td>TOTALIZADOR</td>
            {tamanhos.map((t) => {
              const v = cores.reduce((s, c) => s + valor(c.chave, t), 0);
              return <td key={t} className={`n${v ? '' : ' imp-zero'}`}>{v ? formatQtd(v) : '–'}</td>;
            })}
            <td className="n imp-grade-tot">{formatQtd(totalGeral)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function FolhaDesmembrado({ anuncios, plano }) {
  const a0 = anuncios[0];
  const variosAnuncios = anuncios.length > 1;
  // A janela é a que MEDIU, por anúncio — e o papel só carimba um número
  // quando ele vale para todos. O "últimos 30 dias" cravado de antes escrevia
  // 30 sobre números de 90 quando a loja media em 90 (REGRA 2).
  const janelaLista = plano.janelasUsadas?.length
    ? plano.janelasUsadas
    : anuncios.map((a) => a?.velocidade?.dias);

  return (
    <section className="imp-folha imp-quebra">
      <header className="imp-cabeca">
        <img className="imp-logo" src={logoHbnHub} alt="" />
        <div className="imp-titulo">
          <h1>{variosAnuncios ? `Remessa ao Full — ${anuncios.length} anúncios` : (a0?.titulo || 'Remessa Full')}</h1>
          <p>NECESSIDADE POR PEÇA · KIT DESMEMBRADO</p>
        </div>
        <div className="imp-cabeca-direita">
          <div>Vendas analisadas: {textoDePeriodo(janelaLista, 'dias')}</div>
          <div>Emitido em: {dataBr(plano.hoje) || ''}</div>
        </div>
      </header>

      <div className="imp-intro">
        A mesma remessa da folha anterior, aberta em <b>peças unitárias</b>. Os kits foram desmembrados nas cores
        e tamanhos que os compõem — é esta grade que a facção corta.{' '}
        {(plano.ressalvas?.foraDaGrade?.length > 0 || plano.naoVinculados?.length > 0)
          ? 'A soma daqui NÃO é a remessa inteira: veja a ressalva no fim da folha.'
          : 'A soma daqui é a mesma remessa, contada em camisas em vez de em kits.'}
      </div>

      {plano.produtos.map((p) => (
        <div className="imp-produto" key={p.produtoId}>
          <div className="imp-produto-cabeca">
            <div>
              <b>{p.referencia || `Referência ${p.produtoId}`}</b>
              <small>{p.descricao || ''}</small>
            </div>
            <div className="imp-produto-num">
              <span>enviar <b>{formatQtd(p.totais.aEnviar)}</b> pçs</span>
              <span>da casa <b>{formatQtd(p.totais.daCasa)}</b></span>
              <span className="imp-forte">produzir <b>{formatQtd(p.totais.aProduzir)}</b></span>
              {p.dataLimiteEnvio && <span>sair até <b>{dataBr(p.dataLimiteEnvio)}</b></span>}
            </div>
          </div>

          <GradeCorTamanho
            linhas={p.linhas}
            campo="aProduzir"
            titulo="A PRODUZIR"
            legenda="é esta grade que vai para a facção"
          />
          <GradeCorTamanho
            linhas={p.linhas}
            campo="daCasa"
            titulo="JÁ NA CASA"
            legenda="sai da prateleira, não passa pelo corte"
          />
          <GradeCorTamanho
            linhas={p.linhas}
            campo="aEnviar"
            titulo="A ENVIAR AO FULL"
            legenda="o total da remessa, em peças"
          />
        </div>
      ))}

      {plano.naoVinculados?.length > 0 && (
        <div className="imp-caixa imp-caixa-alerta">
          <b>{plano.naoVinculados.length} anúncio(s) não entraram nesta grade</b> porque não estão ligados a
          nenhuma referência do cadastro — sem saber qual peça é, não há o que cortar. Eles somam{' '}
          {formatQtd(plano.naoVinculados.reduce((s, x) => s + (x.pecasAEnviar ?? x.aEnviar ?? 0), 0))} peças a
          enviar.
        </div>
      )}

      {/* VINCULAÇÃO PARCIAL: o anúncio entrou, mas uma das cores dele não.
          Essas variações caíam fora da grade em silêncio, e a frase acima
          ("é a mesma remessa da folha anterior") ficava falsa por peças que
          ninguém ia cortar. */}
      {plano.ressalvas?.foraDaGrade?.length > 0 && (
        <div className="imp-caixa imp-caixa-alerta">
          <b>{plano.ressalvas.foraDaGrade.length} variação(ões) ficaram de fora desta grade</b> porque ainda não
          estão ligadas a uma referência do cadastro, embora o anúncio delas esteja no plano. São{' '}
          {formatQtd(plano.ressalvas.foraDaGrade.reduce((s, x) => s + (x.pecasAEnviar || 0), 0))} peças que a
          folha anterior conta e esta não:{' '}
          {plano.ressalvas.foraDaGrade
            .map((x) => [x.cor, x.tamanho].filter(Boolean).join(' ') || x.sku || 'variação sem cor lida')
            .join(', ')}.
        </div>
      )}

      <footer className="imp-rodape">
        <span>
          Relatório interno · {variosAnuncios ? `${anuncios.length} anúncios` : (a0?.titulo || '')} ·
          {' '}Necessidade por peça
        </span>
        <span>{a0?.lojaNome || ''}</span>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// O documento
// ---------------------------------------------------------------------------
// Montado num portal no <body>, fora da árvore do modal: é isso que faz a
// impressão sair inteira em vez de parar na primeira dobra.
export default function FullRemessaImpressao({ anuncios, plano, visivel = false, onFechar }) {
  // Esc fecha a PRÉVIA, não o modal atrás dela.
  //
  // A prévia cobre a tela inteira; sem isto, a única saída é achar o botão, e
  // o Esc fechava o plano inteiro por baixo — quem só queria sair da prévia
  // perdia o plano que acabou de montar. Em fase de captura, para chegar
  // antes do Esc do modal.
  useEffect(() => {
    if (!visivel) return undefined;
    function aoTeclar(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onFechar?.();
    }
    document.addEventListener('keydown', aoTeclar, true);
    return () => document.removeEventListener('keydown', aoTeclar, true);
  }, [visivel, onFechar]);

  if (!plano) return null;
  return createPortal(
    <div
      id="impressao-full"
      className={`imp-doc${visivel ? ' imp-visivel' : ''}`}
      aria-hidden={visivel ? undefined : 'true'}
    >
      {visivel && (
        <div className="imp-previa-barra">
          <span>Prévia do papel — é assim que vai sair na impressora.</span>
          <button type="button" className="btn btn-ghost" onClick={onFechar}>Fechar prévia</button>
        </div>
      )}
      <FolhaKitMontado anuncios={anuncios} plano={plano} />
      <FolhaDesmembrado anuncios={anuncios} plano={plano} />
    </div>,
    document.body
  );
}
