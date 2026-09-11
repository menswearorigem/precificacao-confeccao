// Teste do cálculo da aba Marketplace › Full (11/09/2026).
//
//   node server/scripts/teste-full-calculo.js
//
// Roda SEM banco de propósito: tudo o que ele prova é função pura de
// lib/full.js — a regra dos 30 dias, o mínimo, a data limite de saída, a
// quantidade a mandar e a repartição do envio entre as cores. São justamente
// as contas que, se estiverem erradas, mandam produzir peça a mais ou deixam
// o anúncio cair sem ninguém perceber.
//
// O que ele prova:
//   1. anúncio com 30+ dias no Full mede pela JANELA RECENTE;
//   2. anúncio com menos de 30 dias mede pela VENDA GERAL, incluindo o
//      período anterior à entrada no Full — que é a regra pedida;
//   3. sem venda nenhuma a velocidade volta NULA, não zero;
//   4. o mínimo é a venda do prazo de recebimento + segurança;
//   5. a data limite de saída é a data do mínimo MENOS o prazo de
//      recebimento;
//   6. a quantidade a mandar cobre o período escolhido + o mínimo, descontando
//      o que está lá e o que está a caminho, e respeita o múltiplo;
//   7. estoque acima do necessário devolve ZERO ("não precisa"), que é
//      diferente de nulo ("não sei");
//   8. a repartição entre cores soma 100% e a cor sem venda não fica zerada
//      nem estoura o total;
//   9. sem venda por cor, a repartição é por igual E SE DECLARA como tal.
const full = require('../src/lib/full');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function perto(a, b, d, tol = 0.001) {
  ok(a != null && Math.abs(Number(a) - Number(b)) <= tol, d, `esperado ${b}, veio ${a}`);
}
function igual(a, b, d) { ok(a === b, d, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); }

const HOJE = '2026-09-11';

console.log('\n1. A regra dos 30 dias');
{
  // 120 peças em 30 dias = 4/dia, num anúncio que está no Full há 90 dias.
  const v = full.medirVelocidade({
    vendas: { janela: 120, total: 900, primeira: '2025-01-10' },
    diasNoFull: 90, janelaDias: 30, hoje: HOJE,
  });
  igual(v.base, 'full', 'com 90 dias no Full, mede pela venda recente');
  perto(v.porDia, 4, 'a velocidade é 120 ÷ 30 = 4 peças/dia');
}
{
  // Entrou no Full há 12 dias. A venda do anúncio começou em 13/07/2026 —
  // 61 dias de vida até hoje, 122 peças. A regra manda usar a venda GERAL.
  const v = full.medirVelocidade({
    vendas: { janela: 20, total: 122, primeira: '2026-07-13' },
    diasNoFull: 12, janelaDias: 30, hoje: HOJE,
  });
  igual(v.base, 'geral', 'com 12 dias no Full, mede pela venda geral do anúncio');
  perto(v.porDia, 122 / 61, 'usa a vida inteira do anúncio, não só o tempo no Full');
  ok(v.motivo.includes('não estava lá'), 'o motivo explica que conta o período fora do Full');
}
{
  const v = full.medirVelocidade({ vendas: { janela: 0, total: 0, primeira: null }, diasNoFull: 60, janelaDias: 30, hoje: HOJE });
  igual(v.porDia, null, 'sem venda, a velocidade é NULA e não zero');
}

console.log('\n2. Mínimo, datas e quantidade a mandar');
const params = {
  dias_cobertura_alvo: 60, lead_time_dias: 10, dias_seguranca: 10,
  multiplo_envio: 1, janela_vendas_dias: 30,
};
{
  // 4 peças/dia, 200 no Full, nada a caminho, envio para durar 60 dias.
  const r = full.calcularReposicao({
    saldo: { disponivel: 200, emTransito: 0 },
    velocidade: { porDia: 4 }, params, diasAlvo: 60, minimoManual: null, hoje: HOJE,
  });
  igual(r.estoqueMinimo, 80, 'o mínimo é 4/dia × (10 + 10) dias = 80 peças');
  perto(r.coberturaDias, 50, '200 ÷ 4 = 50 dias de cobertura');
  igual(r.dataRuptura, '2026-10-31', 'zera 50 dias depois de hoje');
  // (200 - 80) / 4 = 30 dias até encostar no mínimo -> 11/10.
  igual(r.dataPrecisaEstarLa, '2026-10-11', 'as peças têm que estar lá quando o saldo encosta no mínimo');
  igual(r.dataLimiteEnvio, '2026-10-01', 'a caixa tem que sair 10 dias antes disso');
  // 4 × 60 + 80 - 200 - 0 = 120.
  igual(r.precisaEnviar, 120, 'mandar 120 peças para durar 60 dias além do mínimo');
  igual(r.urgencia, 'planejar', 'com 20 dias de folga, é planejamento e não urgência');
}
{
  // O que já está a caminho abate o envio — senão a casa manda duas vezes.
  const r = full.calcularReposicao({
    saldo: { disponivel: 200, emTransito: 50 },
    velocidade: { porDia: 4 }, params, diasAlvo: 60, minimoManual: null, hoje: HOJE,
  });
  igual(r.precisaEnviar, 70, 'as 50 peças a caminho saem da conta do envio');
}
{
  const r = full.calcularReposicao({
    saldo: { disponivel: 2000, emTransito: 0 },
    velocidade: { porDia: 4 }, params, diasAlvo: 60, minimoManual: null, hoje: HOJE,
  });
  igual(r.precisaEnviar, 0, 'estoque de sobra devolve ZERO, não negativo');
  igual(r.urgencia, 'ok', 'e a situação é "abastecido"');
}
{
  const r = full.calcularReposicao({
    saldo: { disponivel: 0, emTransito: 0 },
    velocidade: { porDia: 4 }, params, diasAlvo: 60, minimoManual: null, hoje: HOJE,
  });
  igual(r.urgencia, 'ruptura', 'saldo zero é ruptura, o pior estado');
}
{
  const r = full.calcularReposicao({
    saldo: { disponivel: 200, emTransito: 0 },
    velocidade: { porDia: null }, params, diasAlvo: 60, minimoManual: null, hoje: HOJE,
  });
  igual(r.estoqueMinimo, null, 'sem velocidade medida não se chuta mínimo');
  igual(r.precisaEnviar, null, 'nem quantidade a mandar');
  igual(r.urgencia, 'sem_medida', 'e a tela diz que não há medida, em vez de dizer "ok"');
}
{
  const r = full.calcularReposicao({
    saldo: { disponivel: 200, emTransito: 0 },
    velocidade: { porDia: 4 }, params: { ...params, multiplo_envio: 24 },
    diasAlvo: 60, minimoManual: null, hoje: HOJE,
  });
  igual(r.precisaEnviar, 120, '120 já é múltiplo de 24 — não sobe à toa');
}
{
  const r = full.calcularReposicao({
    saldo: { disponivel: 210, emTransito: 0 },
    velocidade: { porDia: 4 }, params: { ...params, multiplo_envio: 24 },
    diasAlvo: 60, minimoManual: null, hoje: HOJE,
  });
  igual(r.precisaEnviar, 120, '110 peças arredondam para a caixa fechada de 24 (120)');
}
{
  const r = full.calcularReposicao({
    saldo: { disponivel: 200, emTransito: 0 },
    velocidade: { porDia: 4 }, params, diasAlvo: 60, minimoManual: 300, hoje: HOJE,
  });
  igual(r.estoqueMinimo, 300, 'o mínimo definido à mão vence o calculado');
  igual(r.urgencia, 'atrasado', 'abaixo do mínimo à mão, o envio já está atrasado');
}

console.log('\n3. Repartição do envio entre as cores');
{
  const unidades = [
    { variante_id: 1, cor: 'PRETO', tamanho: 'M' },
    { variante_id: 2, cor: 'BRANCO', tamanho: 'M' },
  ];
  const mix = [
    { varianteId: 1, cor: 'PRETO', tamanho: 'M', quantidade: 75 },
    { varianteId: 2, cor: 'BRANCO', tamanho: 'M', quantidade: 25 },
  ];
  const p = full.repartirEntreUnidades(unidades, mix);
  perto(p[0].participacao, 0.75, 'a cor que vendeu 75% recebe 75% do envio');
  perto(p[1].participacao, 0.25, 'e a outra, 25%');
  perto(p[0].participacao + p[1].participacao, 1, 'as participações somam 100%');
}
{
  // A terceira cor acabou de entrar e não tem venda. Ela não pode ficar
  // zerada para sempre — mas também não pode inflar o total.
  const unidades = [
    { variante_id: 1, cor: 'PRETO', tamanho: 'M' },
    { variante_id: 2, cor: 'BRANCO', tamanho: 'M' },
    { variante_id: 3, cor: 'VERDE', tamanho: 'M' },
  ];
  const mix = [
    { varianteId: 1, cor: 'PRETO', tamanho: 'M', quantidade: 75 },
    { varianteId: 2, cor: 'BRANCO', tamanho: 'M', quantidade: 25 },
  ];
  const p = full.repartirEntreUnidades(unidades, mix);
  ok(p[2].participacao > 0, 'a cor nova não fica com zero');
  ok(p[2].participacao <= p[1].participacao + 1e-9, 'mas não recebe mais que a cor de menor venda');
  perto(p.reduce((s, x) => s + x.participacao, 0), 1, 'o total continua sendo 100%');
  igual(p[2].origem, 'sem_venda', 'e a origem da participação dela é declarada');
}
{
  // Sem venda por cor nenhuma: divide por igual e DIZ que dividiu por igual.
  const unidades = [{ variante_id: 1, cor: 'PRETO' }, { variante_id: 2, cor: 'BRANCO' }];
  const p = full.repartirEntreUnidades(unidades, []);
  perto(p[0].participacao, 0.5, 'sem venda medida, divide por igual');
  igual(p[0].origem, 'igual', 'e marca a divisão como "por igual" para a tela avisar');
}
{
  // Sem variante_id, casa por cor e tamanho normalizados (acento e traço não
  // podem separar "AZUL MARINHO" de "azul-marinho").
  const unidades = [{ variante_id: null, cor: 'Azul Marinho', tamanho: 'GG' }];
  const mix = [{ varianteId: null, cor: 'azul-marinho', tamanho: 'gg', quantidade: 40 }];
  const p = full.repartirEntreUnidades(unidades, mix);
  igual(p[0].origem, 'grade', 'casa pela grade quando não há variante vinculada');
  perto(p[0].participacao, 1, 'e fica com o envio inteiro');
}

console.log('\n4. NULO não pode virar zero');
{
  // O defeito mais caro que este arquivo já teve: `Number(null)` é 0, então
  // uma coluna NULA (= "ninguém definiu") virava um mínimo DEFINIDO como
  // zero, e o mínimo calculado nunca era usado. O sistema pedia um terço das
  // peças e atrasava a data limite em vinte dias, calado.
  igual(full.inteiro(null), null, 'inteiro(null) é NULO, não 0');
  igual(full.inteiro(undefined), null, 'inteiro(undefined) é NULO');
  igual(full.inteiro(''), null, 'inteiro("") é NULO — campo vazio não é zero');
  igual(full.inteiro(null, 60), 60, 'inteiro(null, padrão) devolve o padrão');
  igual(full.inteiro('45'), 45, 'texto numérico continua virando número');
  igual(full.inteiro(0), 0, 'e o zero de verdade continua sendo zero');
  igual(full.numero(null), null, 'numero(null) é NULO');

  // O caso completo, do jeito que a rota chama: coluna nula no banco.
  const r = full.calcularReposicao({
    saldo: { disponivel: 200, emTransito: 0 },
    velocidade: { porDia: 4 }, params,
    diasAlvo: 60, minimoManual: full.inteiro(null), hoje: HOJE,
  });
  igual(r.estoqueMinimo, 80, 'com a coluna NULA, vale o mínimo CALCULADO');
  igual(r.precisaEnviar, 120, 'e a quantidade a mandar volta a ser a certa');
  igual(r.dataLimiteEnvio, '2026-10-01', 'e a data limite não atrasa');
}

console.log('\n5. A soma das cores é exatamente o total do anúncio');
{
  // O múltiplo de envio é aplicado UMA vez, no total, e repartido de volta.
  const partes = full.distribuirInteiros(120, [50, 30, 20.4]);
  igual(partes.reduce((s, x) => s + x, 0), 120, 'as partes somam o total, sem sobra nem falta');
  ok(partes.every((x) => x >= 0), 'nenhuma parte fica negativa');
  igual(full.distribuirInteiros(0, [1, 2]).join(','), '0,0', 'total zero reparte zero');
  igual(full.distribuirInteiros(10, [0, 0]).join(','), '0,0', 'sem peso não se inventa repartição');
  const uma = full.distribuirInteiros(7, [1]);
  igual(uma[0], 7, 'com uma variação só, ela leva tudo');
}

console.log('\n6. O anúncio inteiro montado (montarAnuncio)');

// Um anúncio de 3 cores, do jeito que a consulta devolve as linhas.
function unidade(id, cor, extra = {}) {
  return {
    id,
    origem_integracao_id: 1,
    marketplace: 'mercado_livre',
    anuncio_id: 10,
    anuncio_id_externo: 'MLB111',
    variacao_id_externa: String(id),
    inventory_id: `INV${id}`,
    sku_externo: `OG1190${cor}M`,
    produto_id: 7,
    variante_id: id,
    no_full: true,
    desde: '2026-01-10',
    visto_em: HOJE,
    saiu_em: null,
    estoque_disponivel: 0,
    estoque_indisponivel: 0,
    estoque_total: 0,
    estoque_em_transito: null,
    estoque_minimo_manual: null,
    dias_cobertura_manual: null,
    ignorar_reposicao: false,
    status_full: 'sem_estoque',
    status_externo: null,
    titulo: 'Camiseta Dry',
    preco: 79.9,
    referencia: 'OG1190',
    loja_nome: 'Origem',
    cor,
    tamanho: 'M',
    estoque_casa: 0,
    estoque_casa_reservado: 0,
    ...extra,
  };
}

const MIX_IGUAL = [
  { varianteId: 1, cor: 'PRETO', tamanho: 'M', quantidade: 60 },
  { varianteId: 2, cor: 'BRANCO', tamanho: 'M', quantidade: 60 },
  { varianteId: 3, cor: 'VERDE', tamanho: 'M', quantidade: 60 },
];

function montar(unidades, { transito = new Map(), mix = MIX_IGUAL } = {}) {
  return full.montarAnuncio({
    unidades,
    // 180 peças em 30 dias = 6/dia no anúncio, 2/dia por cor.
    vendas: { janela: 180, total: 1800, unidadesJanela: 180, unidadesTotal: 1800, receita: 14382, primeira: '2025-06-01', ultima: HOJE },
    mix,
    params,
    snapshots: new Map(),
    pontas: new Map(),
    transito,
    hoje: HOJE,
    diasAlvoPedido: 60,
    janelaDias: 30,
  });
}

{
  const a = montar([unidade(1, 'PRETO'), unidade(2, 'BRANCO'), unidade(3, 'VERDE')]);
  // Por cor: 2/dia × 60 dias + mínimo (2 × 20 = 40) − 0 = 160. Três cores = 480.
  igual(a.reposicao.precisaEnviar, 480, 'sem nada a caminho, o anúncio pede 480 peças');
  const somaCores = a.unidades.reduce((s, u) => s + (u.precisaEnviarUnidade || 0), 0);
  igual(somaCores, a.reposicao.precisaEnviar, 'a soma das cores é EXATAMENTE o total do cartão');
  igual(a.reposicao.urgencia, 'ruptura', 'com saldo zero, o anúncio está em ruptura');
  igual(a.leitura.completa, true, 'todas as variações tiveram saldo lido');
}
{
  // O defeito que a revisão pegou: a expedição registra a remessa no ANÚNCIO
  // (o formulário grava na primeira variação). Se o crédito ficasse preso
  // nela, as outras duas cores continuariam pedindo a remessa inteira de
  // novo, e o cartão pediria 320 em vez de 180.
  const transito = new Map([[1, { pecas: 300, desde: '2026-09-09' }]]);
  const a = montar([unidade(1, 'PRETO'), unidade(2, 'BRANCO'), unidade(3, 'VERDE')], { transito });
  igual(a.reposicao.precisaEnviar, 180, '480 menos as 300 já despachadas = 180 (o crédito é do anúncio, não da cor)');
  igual(a.saldo.emTransito, 300, 'e o cartão mostra as 300 peças a caminho');
  const somaCores = a.unidades.reduce((s, u) => s + (u.precisaEnviarUnidade || 0), 0);
  igual(somaCores, 180, 'a soma das cores acompanha o desconto');
}
{
  // A plataforma já enxerga a mesma remessa: não pode descontar duas vezes.
  const transito = new Map([[1, { pecas: 300, desde: '2026-09-09' }]]);
  const a = montar([
    unidade(1, 'PRETO', { estoque_em_transito: 100 }),
    unidade(2, 'BRANCO', { estoque_em_transito: 100 }),
    unidade(3, 'VERDE', { estoque_em_transito: 100 }),
  ], { transito });
  igual(a.saldo.emTransito, 300, 'a caminho continua sendo 300, não 600');
  // Cada cor já descontou 100 (2×60 + 40 − 100 = 60); 3 × 60 = 180, e o
  // crédito registrado não abate nada por cima porque já estava contado.
  igual(a.reposicao.precisaEnviar, 180, 'a mesma remessa não é descontada duas vezes');
}
{
  // Variação sem saldo lido: o total vira um PISO e a tela precisa saber.
  const a = montar([
    unidade(1, 'PRETO', { estoque_disponivel: 120 }),
    unidade(2, 'BRANCO', { estoque_disponivel: null, status_externo: 'inventory_id ausente' }),
    unidade(3, 'VERDE', { estoque_disponivel: 40 }),
  ]);
  igual(a.leitura.completa, false, 'a leitura é declarada incompleta');
  igual(a.leitura.naoLidas, 1, 'com uma variação não lida de três');
  igual(a.saldo.disponivel, 160, 'e o saldo mostrado é a soma do que foi lido');
  ok(a.leitura.motivos.length === 1, 'o motivo da falha vai junto para a tela');
}
{
  // Peça em fim de linha fica fora da reposição, mas continua na tela.
  const a = montar([
    unidade(1, 'PRETO'),
    unidade(2, 'BRANCO', { ignorar_reposicao: true }),
    unidade(3, 'VERDE'),
  ]);
  igual(a.unidades[1].precisaEnviarUnidade, 0, 'a variação ignorada não recebe peça nenhuma');
  igual(a.reposicao.precisaEnviar, 320, 'e o total do anúncio cai para as duas cores restantes');
}
{
  // Múltiplo de envio: arredonda UMA vez, no total, e reparte de volta.
  const a = full.montarAnuncio({
    unidades: [unidade(1, 'PRETO'), unidade(2, 'BRANCO'), unidade(3, 'VERDE')],
    vendas: { janela: 180, total: 1800, unidadesJanela: 180, unidadesTotal: 1800, receita: 14382, primeira: '2025-06-01', ultima: HOJE },
    mix: MIX_IGUAL,
    params: { ...params, multiplo_envio: 50 },
    snapshots: new Map(), pontas: new Map(), transito: new Map(),
    hoje: HOJE, diasAlvoPedido: 60, janelaDias: 30,
  });
  igual(a.reposicao.precisaEnviar, 500, '480 sobe para a caixa fechada de 50 (500)');
  igual(a.unidades.reduce((s, u) => s + u.precisaEnviarUnidade, 0), 500,
    'e as cores somam 500, não 3 arredondamentos separados');
}

{
  // Mínimo à mão em UMA cor só: não pode virar o mínimo do anúncio inteiro.
  // Era um caminho de perda de dado em um clique — a aba Ajustes oferecia o
  // total encolhido de volta no campo, pronto para ser regravado por cima das
  // cores certas.
  const a = montar([
    unidade(1, 'PRETO', { estoque_minimo_manual: 10 }),
    unidade(2, 'BRANCO'),
    unidade(3, 'VERDE'),
  ]);
  igual(a.reposicao.estoqueMinimoManual, null, 'com só uma cor definida à mão, o anúncio NÃO tem mínimo manual');
  igual(a.reposicao.estoqueMinimoParcial, true, 'e a tela é avisada de que o mínimo é misto');
  // 10 (à mão) + 40 + 40 (calculados) = 90.
  igual(a.reposicao.estoqueMinimo, 90, 'o mínimo do anúncio é a soma do efetivo de cada cor');
}
{
  // Todas à mão: aí sim o anúncio tem mínimo definido à mão.
  const a = montar([
    unidade(1, 'PRETO', { estoque_minimo_manual: 10 }),
    unidade(2, 'BRANCO', { estoque_minimo_manual: 20 }),
    unidade(3, 'VERDE', { estoque_minimo_manual: 30 }),
  ]);
  igual(a.reposicao.estoqueMinimoManual, 60, 'com todas definidas à mão, o anúncio soma 60');
  igual(a.reposicao.estoqueMinimoParcial, false, 'e nada é parcial');
}
{
  // O saldo da casa lido no nível da REFERÊNCIA (caso da Shopee) é declarado,
  // e a chave de dedupe passa a ser o produto — senão a mesma prateleira
  // contaria duas vezes ao lado do anúncio do Mercado Livre.
  const a = montar([
    unidade(1, 'PRETO', {
      variante_id: null, estoque_casa: 65, estoque_casa_origem: 'referencia', produto_id: 7,
    }),
  ], { mix: [] });
  igual(a.unidades[0].estoqueCasaOrigem, 'referencia', 'a origem do saldo da casa é declarada');
  igual(a.unidades[0].estoqueCasaChave, 'p7', 'e a dedupe passa a ser pela referência');
}
{
  // O campo por cor que arredondava por conta própria não sai mais na
  // resposta: quem lesse `precisaEnviar` de uma variação somaria mais do que
  // o cartão mostra.
  const a = montar([unidade(1, 'PRETO'), unidade(2, 'BRANCO'), unidade(3, 'VERDE')]);
  igual(a.unidades[0].precisaEnviar, undefined, 'a variação não devolve um "precisaEnviar" próprio');
  ok(a.unidades[0].precisaEnviarUnidade > 0, 'o número por cor é o precisaEnviarUnidade');
}

{
  // O caso que apareceu no primeiro uso real: o anúncio tem 362 peças no
  // Full, mas UMA cor de três está zerada. A primeira versão trazia a data da
  // pior cor para o topo, e o painel mostrava "21,4 dias de estoque" logo
  // acima de "as peças têm que estar lá em 21/08" — uma data do mês passado.
  // Dois números do mesmo bloco falando de coisas diferentes.
  const a = montar([
    unidade(1, 'PRETO', { estoque_disponivel: 200 }),
    unidade(2, 'BRANCO', { estoque_disponivel: 162 }),
    unidade(3, 'VERDE', { estoque_disponivel: 0 }),
  ]);
  igual(a.saldo.disponivel, 362, 'o anúncio tem 362 peças no Full');
  igual(a.reposicao.urgencia, 'cor_zerada', 'a urgência é "cor zerada", não "zerado no Full"');
  igual(a.reposicao.coresZeradas.quantidade, 1, 'uma cor zerada');
  igual(a.reposicao.coresZeradas.total, 3, 'de três');
  igual(a.reposicao.coresZeradas.parcial, true, 'e sobra saldo nas outras');
  ok(a.reposicao.coresZeradas.nomes.includes('VERDE M'), 'a cor zerada é nomeada para a tela');
  // As datas do topo são do ANÚNCIO: 362 peças, 6 pç/dia, mínimo 120.
  // (362 − 120) / 6 = 40 dias até encostar no mínimo.
  ok(a.reposicao.dataPrecisaEstarLa > HOJE, 'a data de estar lá é FUTURA, como a cobertura do anúncio indica');
  ok(a.reposicao.dataLimiteEnvio > HOJE, 'e a data de saída daqui também');
  perto(a.reposicao.coberturaDias, 362 / 6, 'a cobertura continua sendo a do anúncio inteiro', 0.05);
}
{
  // Todas zeradas: aí sim o anúncio está em ruptura, e não é "cor zerada".
  const a = montar([unidade(1, 'PRETO'), unidade(2, 'BRANCO'), unidade(3, 'VERDE')]);
  igual(a.reposicao.urgencia, 'ruptura', 'com tudo zerado, a urgência é ruptura');
  igual(a.reposicao.coresZeradas.parcial, false, 'e não é um caso de "algumas cores"');
}
{
  // O mínimo do anúncio e a data do anúncio saem do MESMO número: a soma do
  // mínimo de cada cor. Antes a tela mostrava um mínimo e calculava a data
  // com outro, por causa do arredondamento por cor.
  const a = montar([
    unidade(1, 'PRETO', { estoque_disponivel: 200 }),
    unidade(2, 'BRANCO', { estoque_disponivel: 200 }),
    unidade(3, 'VERDE', { estoque_disponivel: 200 }),
  ]);
  const somaCores = a.unidades.reduce((s, u) => s + u.estoqueMinimo, 0);
  igual(a.reposicao.estoqueMinimo, somaCores, 'o mínimo do anúncio é a soma do mínimo de cada cor');
  // 600 peças, 6/dia, mínimo somado -> (600 - minimo)/6 dias até encostar.
  const diasEsperados = Math.floor((600 - somaCores) / 6);
  igual(a.reposicao.dataPrecisaEstarLa, full.somarDias(HOJE, diasEsperados),
    'e a data é calculada com esse MESMO mínimo');
}

console.log('\n7. Kit: o Full conta unidades, a fábrica conta peças');
{
  // O caso real: "Kit 3 Camisa Gola Polo", 362 unidades no Full. Uma unidade
  // lá dentro são TRÊS camisas. Antes de 0073, a venda era contada em peças
  // contra um saldo em kits e a cobertura saía três vezes menor.
  const kitU = (id, cor) => unidade(id, cor, {
    estoque_disponivel: 362, pecas_por_unidade: 3, pecas_por_unidade_origem: 'sku',
    sku_externo: `KIT-3-OG1190-${cor}-M`, estoque_casa: 0,
  });
  const a = full.montarAnuncio({
    unidades: [kitU(1, 'PRETO')],
    // 107 KITS vendidos em 30 dias -> 3,57 kits/dia.
    vendas: {
      janela: 107, total: 107, anterior: null, receita: 16039,
      unidadesJanela: 107, unidadesTotal: 107, pecasJanela: 321, pecasTotal: 321,
      primeira: '2026-08-12', ultima: HOJE,
    },
    mix: [], params, snapshots: new Map(), pontas: new Map(), transito: new Map(),
    hoje: HOJE, diasAlvoPedido: 60, janelaDias: 30,
  });
  igual(a.ehKit, true, 'o anúncio é reconhecido como kit');
  igual(a.pecasPorUnidade, 3, 'com 3 peças por unidade, lido do SKU');
  perto(a.velocidade.porDia, 107 / 30, 'a velocidade é em KITS por dia, não em peças');
  // 362 kits / 3,567 kits-dia = 101,5 dias.
  perto(a.reposicao.coberturaDias, 362 / (107 / 30), 'a cobertura compara kits com kits', 0.1);
  ok(a.reposicao.coberturaDias > 100, 'e dá mais de 100 dias — não os 34 de uma conta com unidades trocadas');
  // Mínimo: 3,567 x 20 dias = 72 kits. 362 já cobre, então não precisa mandar.
  igual(a.reposicao.precisaEnviar, 0, 'com 362 kits e 60 dias de alvo, não precisa mandar nada');
  igual(a.reposicao.urgencia, 'ok', 'e a situação é abastecido');
}
{
  // Agora com o saldo apertado, para conferir a conversão do envio.
  const a = full.montarAnuncio({
    unidades: [unidade(1, 'PRETO', {
      estoque_disponivel: 0, pecas_por_unidade: 3, sku_externo: 'KIT-3-OG1190-PRETO-M', estoque_casa: 0,
    })],
    vendas: {
      janela: 60, total: 60, anterior: null, receita: 9000,
      unidadesJanela: 60, unidadesTotal: 60, pecasJanela: 180, pecasTotal: 180,
      primeira: '2026-06-01', ultima: HOJE,
    },
    mix: [], params, snapshots: new Map(), pontas: new Map(), transito: new Map(),
    hoje: HOJE, diasAlvoPedido: 60, janelaDias: 30,
  });
  // 2 kits/dia x 60 dias + mínimo (2 x 20 = 40) = 160 kits.
  igual(a.reposicao.precisaEnviar, 160, 'manda 160 KITS');
  igual(a.unidades[0].precisaEnviarUnidade * a.unidades[0].pecasPorUnidade, 480,
    'que a produção lê como 480 peças');
}

console.log('\n8. A prateleira é uma só');
{
  // O defeito: quando o item do Full não tem variante casada (todo kit caía
  // nisso), o saldo da casa vinha da REFERÊNCIA INTEIRA e era repetido em
  // cada linha. Com 3 cores prometendo as mesmas 200 peças, o "a produzir"
  // caía para zero e a fábrica não cortava nada.
  //
  // A chave de dedupe agora vem da UNIDADE: sem variante, ela é o PRODUTO.
  const a = montar([
    unidade(1, 'PRETO', { variante_id: null, produto_id: 7, estoque_casa: 200, estoque_casa_origem: 'referencia' }),
    unidade(2, 'BRANCO', { variante_id: null, produto_id: 7, estoque_casa: 200, estoque_casa_origem: 'referencia' }),
    unidade(3, 'VERDE', { variante_id: null, produto_id: 7, estoque_casa: 200, estoque_casa_origem: 'referencia' }),
  ]);
  const chaves = new Set(a.unidades.map((u) => u.estoqueCasaChave));
  igual(chaves.size, 1, 'as três cores compartilham UMA chave de saldo da casa');
  igual([...chaves][0], 'p7', 'e a chave é a referência, não a cor');
}
{
  // Com variante casada, cada cor tem a sua prateleira e a chave é própria.
  const a = montar([
    unidade(1, 'PRETO', { estoque_casa: 40, estoque_casa_origem: 'variante' }),
    unidade(2, 'BRANCO', { estoque_casa: 30, estoque_casa_origem: 'variante' }),
  ]);
  const chaves = a.unidades.map((u) => u.estoqueCasaChave);
  igual(new Set(chaves).size, 2, 'cada cor com variante tem chave própria');
  igual(chaves[0], 'v1', 'e a chave é a variante');
}
{
  // Cada cor pode apontar uma referência própria, desde que a varredura
  // resolve o SKU por variação.
  const a = montar([
    unidade(1, 'PRETO', { produto_id: 7 }),
    unidade(2, 'BRANCO', { produto_id: 9 }),
  ]);
  igual(a.unidades[0].produtoId, 7, 'a variação carrega a referência dela');
  igual(a.unidades[1].produtoId, 9, 'e a outra carrega a sua');
}

console.log('\n9. Kit sortido: a composição manda no plano');
{
  // O caso da dona: uma unidade do "Kit 3" são TRÊS camisas de cores
  // diferentes. Sem a composição registrada, o plano supunha três da mesma
  // cor — o triplo de uma e nenhuma das outras duas.
  const comp = [
    { produtoId: 7, cor: 'PRETO', tamanho: 'M', varianteId: 11, quantidade: 1, estoqueCasa: 50 },
    { produtoId: 7, cor: 'BRANCO', tamanho: 'M', varianteId: 12, quantidade: 1, estoqueCasa: 20 },
    { produtoId: 7, cor: 'CINZA', tamanho: 'M', varianteId: 13, quantidade: 1, estoqueCasa: 0 },
  ];
  const a = full.montarAnuncio({
    unidades: [unidade(1, 'SORTIDO', {
      estoque_disponivel: 0, pecas_por_unidade: 3, sku_externo: 'KIT-3-OG1190-SORTIDO-M', estoque_casa: null,
    })],
    vendas: {
      janela: 60, total: 60, anterior: null, receita: 9000,
      unidadesJanela: 60, unidadesTotal: 60, primeira: '2026-06-01', ultima: HOJE,
    },
    mix: [], params, snapshots: new Map(), pontas: new Map(), transito: new Map(),
    composicao: new Map([[1, comp]]),
    hoje: HOJE, diasAlvoPedido: 60, janelaDias: 30,
  });
  igual(a.ehKit, true, 'o anúncio é tratado como kit');
  igual(a.composicaoRegistrada, 1, 'e a variação tem composição registrada');
  igual(a.unidades[0].composicao.length, 3, 'com as três peças do trio');
  // 2 kits/dia x 60 dias + mínimo (2 x 20 = 40) = 160 KITS.
  igual(a.reposicao.precisaEnviar, 160, 'manda 160 kits');
  // E a produção lê 160 de CADA cor, não 480 de uma.
  const porCor = new Map(a.unidades[0].composicao.map((c) => [c.cor, c.quantidade * 160]));
  igual(porCor.get('PRETO'), 160, '160 peças pretas');
  igual(porCor.get('BRANCO'), 160, '160 brancas');
  igual(porCor.get('CINZA'), 160, '160 cinzas');
  igual([...porCor.values()].reduce((s, v) => s + v, 0), 480, 'que somam as mesmas 480 peças');
}
{
  // Sem composição registrada, o plano cai no padrão do SKU e DECLARA isso.
  const a = montar([unidade(1, 'PRETO', {
    estoque_disponivel: 0, pecas_por_unidade: 3, sku_externo: 'KIT-3-OG1190-PRETO-M',
  })], { mix: [] });
  igual(a.composicaoRegistrada, 0, 'nenhuma variação tem composição registrada');
  igual(a.unidades[0].composicao.length, 0, 'e a variação volta sem composição');
  igual(a.unidades[0].pecasPorUnidade, 3, 'valendo o padrão do SKU: 3 peças da própria cor');
}

console.log('\n10. O plano de produção do kit sortido');

// Um anúncio de kit sortido, já montado, do jeito que montarAnuncio devolve.
function anuncioDeKit({ chave = '1|MLB1', unidades }) {
  return {
    chave,
    anuncioId: 10,
    anuncioIdExterno: chave.split('|')[1],
    integracaoId: Number(chave.split('|')[0]),
    marketplace: 'mercado_livre',
    lojaNome: 'hoggar',
    titulo: 'Kit 3 Camisa Gola Polo',
    produtoId: 7,
    referencia: 'OG1190',
    produtoDescricao: 'Camisa Polo',
    produtoTemFoto: true,
    pecasPorUnidade: 3,
    ehKit: true,
    velocidade: { porDia: 2, base: 'full' },
    reposicao: { precisaEnviar: 100, diasAlvo: 60, dataLimiteEnvio: '2026-10-01', dataPrecisaEstarLa: '2026-10-11' },
    unidades,
  };
}

function varComposicao(id, trio, precisaEnviarUnidade) {
  return {
    id,
    cor: 'SORTIDO',
    tamanho: 'M',
    sku: 'KIT-3-OG1190-SORTIDO-M',
    produtoId: 7,
    varianteId: null,
    estoqueCasa: null,
    estoqueCasaChave: null,
    estoqueCasaOrigem: null,
    pecasPorUnidade: 3,
    ignorarReposicao: false,
    precisaEnviarUnidade,
    participacaoOrigem: 'variante',
    composicao: trio,
  };
}

{
  const trio = [
    { produtoId: 7, cor: 'PRETO', tamanho: 'M', varianteId: 11, quantidade: 1, estoqueCasa: 50 },
    { produtoId: 7, cor: 'BRANCO', tamanho: 'M', varianteId: 12, quantidade: 1, estoqueCasa: 20 },
    { produtoId: 7, cor: 'CINZA', tamanho: 'M', varianteId: 13, quantidade: 1, estoqueCasa: 0 },
  ];
  const r = full.montarPlano({ escolhidos: [anuncioDeKit({ unidades: [varComposicao(1, trio, 100)] })] });
  igual(r.produtos.length, 1, 'uma referência no plano');
  const p = r.produtos[0];
  igual(p.linhas.length, 3, 'e três linhas de grade — uma por cor do trio');
  igual(p.totais.aEnviar, 300, '100 kits viram 300 peças');
  igual(p.totais.unidadesAEnviar, 100, 'mas continuam sendo 100 UNIDADES de anúncio, não 300');
  // Prateleira: 50 pretas + 20 brancas + 0 cinzas = 70 da casa; 230 a produzir.
  igual(p.totais.daCasa, 70, 'o que já está na casa é descontado por cor');
  igual(p.totais.aProduzir, 230, 'e o resto vira ordem de produção');
  const porCor = new Map(p.linhas.map((l) => [l.cor, l]));
  igual(porCor.get('PRETO').aProduzir, 50, '50 pretas a produzir (100 − 50 na casa)');
  igual(porCor.get('BRANCO').aProduzir, 80, '80 brancas');
  igual(porCor.get('CINZA').aProduzir, 100, '100 cinzas');
  igual(p.anuncios[0].pecasAEnviar, 300, 'o chip do anúncio mostra as peças DESTA referência');
}
{
  // Kit que mistura DUAS referências: cada card tem de mostrar só as peças
  // dele — repetir o total do anúncio nos dois fazia somar o dobro.
  const trio = [
    { produtoId: 7, cor: 'PRETO', tamanho: 'M', varianteId: 11, quantidade: 2, estoqueCasa: 0 },
    { produtoId: 9, cor: 'AZUL', tamanho: 'M', varianteId: 21, quantidade: 1, estoqueCasa: 0 },
  ];
  const r = full.montarPlano({ escolhidos: [anuncioDeKit({ unidades: [varComposicao(1, trio, 100)] })] });
  igual(r.produtos.length, 2, 'duas referências no plano');
  const porProd = new Map(r.produtos.map((p) => [p.produtoId, p]));
  igual(porProd.get(7).totais.aEnviar, 200, 'a referência de 2 por kit leva 200 peças');
  igual(porProd.get(9).totais.aEnviar, 100, 'a de 1 por kit leva 100');
  igual(porProd.get(7).anuncios[0].pecasAEnviar, 200, 'e o chip de cada card mostra a fatia dele');
  igual(porProd.get(9).anuncios[0].pecasAEnviar, 100, 'não o total do anúncio nos dois');
  igual(porProd.get(7).totais.unidadesAEnviar, 100, 'as unidades do anúncio não se multiplicam por card');
  igual(porProd.get(9).referencia, null, 'a referência que entrou pelo kit vem sem nome, para a rota completar');
}
{
  // A prateleira é uma só: a mesma variante em duas variações do anúncio não
  // pode ser prometida duas vezes.
  const trioM = [{ produtoId: 7, cor: 'PRETO', tamanho: 'M', varianteId: 11, quantidade: 1, estoqueCasa: 60 }];
  const trioG = [{ produtoId: 7, cor: 'PRETO', tamanho: 'M', varianteId: 11, quantidade: 1, estoqueCasa: 60 }];
  const r = full.montarPlano({
    escolhidos: [anuncioDeKit({ unidades: [varComposicao(1, trioM, 50), varComposicao(2, trioG, 50)] })],
  });
  const p = r.produtos[0];
  igual(p.totais.aEnviar, 100, '100 peças no total');
  igual(p.totais.daCasa, 60, 'e só as 60 que existem de verdade saem da casa');
  igual(p.totais.aProduzir, 40, 'as outras 40 são produzidas');
  igual(p.totais.unidadesAEnviar, 100, 'as unidades somam as duas variações');
}
{
  // Sem composição registrada, cai no padrão do SKU e MARCA a linha.
  const r = full.montarPlano({
    escolhidos: [anuncioDeKit({
      unidades: [{ ...varComposicao(1, [], 100), cor: 'PRETO', varianteId: 11, estoqueCasa: 0, estoqueCasaChave: 'v11' }],
    })],
  });
  const l = r.produtos[0].linhas[0];
  igual(l.aEnviar, 300, 'supõe 3 peças da própria cor');
  igual(l.origemComposicao, 'sku', 'e marca a linha como suposição, para a tela avisar');
}

console.log('\n11. Utilidades de data');
igual(full.diasEntre('2026-09-11', '2026-10-01'), 20, 'diasEntre conta 20 dias');
igual(full.somarDias('2026-09-11', -10), '2026-09-01', 'somarDias anda para trás');
igual(full.arredondarParaMultiplo(0, 24), 0, 'zero não vira uma caixa cheia');
igual(full.arredondarParaMultiplo(1, 24), 24, 'uma peça vira a caixa fechada');

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou === 0 ? 0 : 1);
