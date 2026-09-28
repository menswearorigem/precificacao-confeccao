// SAÚDE DA CONTA DIÁRIA + MÉTRICAS EXTRAS DO ADS DO ML — 28/09/2026
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-saude-conta-e-ads-ml-2026-09-28.js
const pool = require('../src/db/pool');
const { sincronizarSaudeContaTodasAtivas, resumoMercadoLivre, resumoShopee } = require('../src/lib/saudeContaSync');
const { _gravarMetricasAdsDoDia: gravarAds } = require('../src/lib/marketplaceSync');

let falhas = 0;
const ok = (m, c, d) => { if (c) console.log(`  ok   ${m}`); else { falhas += 1; console.log(`  FALHA ${m}${d !== undefined ? ` -> ${d}` : ''}`); } };
const q = async (s, p) => (await pool.query(s, p)).rows;

// formato real de /users/me (campos usados pela tela de reputação)
const USUARIO_ML = { nickname: 'ORIGEM', seller_reputation: { level_id: '5_green', power_seller_status: 'gold',
  metrics: { claims: { rate: 0.012 }, cancellations: { rate: 0.004 }, delayed_handling_time: { rate: 0.03 }, sales: { completed: 1200 } } } };
const DESEMPENHO_SHOPEE = { notaGeral: 3, metricas: [
  { id: 1, nome: 'Late shipment rate', valorAtual: 5, meta: 3, comparadorMeta: '<' },      // reprovada
  { id: 2, nome: 'Chat response rate', valorAtual: 90, meta: 70, comparadorMeta: '>=' },   // ok
  { id: 3, nome: 'Sem meta', valorAtual: 1, meta: null, comparadorMeta: null },            // não conta
] };

(async () => {
  console.log('\n1. Resumos');
  const rml = resumoMercadoLivre(USUARIO_ML);
  ok('ML: nível e selo', rml.nivel === '5_green' && rml.selo === 'gold');
  ok('ML: taxas', rml.reclamacoes_pct === 0.012 && rml.cancelamentos_pct === 0.004 && rml.atraso_pct === 0.03);
  const rsp = resumoShopee(DESEMPENHO_SHOPEE);
  ok('Shopee: 1 métrica reprovada (sem meta não conta)', rsp.reprovadas === 1, rsp.reprovadas);
  ok('Shopee: nota geral', rsp.nota_geral === 3);
  ok('ML sem reputação → nulos, não zeros', resumoMercadoLivre({}).reclamacoes_pct === null);

  console.log('\n2. Foto do dia');
  const futuro = new Date(Date.now() + 86400000).toISOString();
  const [ml] = await q("INSERT INTO integracoes_marketplace (marketplace, nome, access_token, token_expira_em) VALUES ('mercado_livre','MELI Origem','x',$1) RETURNING id", [futuro]);
  const [sp] = await q("INSERT INTO integracoes_marketplace (marketplace, nome, access_token, token_expira_em, conta_externa_id) VALUES ('shopee','Shopee Origem','x',$1,'1') RETURNING id", [futuro]);
  let falhaShopee = false;
  const plataformas = {
    mercadoLivre: { buscarUsuario: async () => USUARIO_ML },
    shopee: { buscarDesempenhoLoja: async () => { if (falhaShopee) throw new Error('403'); return DESEMPENHO_SHOPEE; } },
  };
  const r1 = await sincronizarSaudeContaTodasAtivas({ plataformas });
  ok('duas lojas lidas', r1.length === 2 && r1.every((x) => x.ok), JSON.stringify(r1));
  await sincronizarSaudeContaTodasAtivas({ plataformas });
  const linhas = await q('SELECT * FROM saude_conta_diaria ORDER BY origem_integracao_id');
  ok('uma linha por loja por dia (segunda leitura sobrescreve)', linhas.length === 2, linhas.length);
  ok('ML gravado com nível', linhas.find((l) => l.origem_integracao_id === ml.id).nivel === '5_green');
  falhaShopee = true;
  const r3 = await sincronizarSaudeContaTodasAtivas({ plataformas });
  ok('falha de uma loja não derruba a outra', r3.find((x) => x.loja === 'Shopee Origem').ok === false && r3.find((x) => x.loja === 'MELI Origem').ok);
  const [spLinha] = await q('SELECT reprovadas FROM saude_conta_diaria WHERE origem_integracao_id = $1', [sp.id]);
  ok('a foto boa do dia continua lá (falha não zera)', spLinha.reprovadas === 1);

  console.log('\n3. Métricas extras do Ads do ML');
  await gravarAds(ml.id, '2026-09-27', [{ itemId: 'MLB1', impressoes: 100, cliques: 5, custo: 2,
    vendasDiretasQtd: 1, vendasDiretasValor: 70, vendasIndiretasQtd: 0, vendasIndiretasValor: 0,
    parcelaImpressoes: 42.5, perdidasPorOrcamento: 30, perdidasPorClassificacao: 27.5, vendasOrganicasQtd: 3, vendasOrganicasValor: 210, parcelaVendaAds: 25 }]);
  let [a] = await q("SELECT * FROM ads_metricas_diarias WHERE anuncio_id_marketplace = 'MLB1'");
  ok('extras gravadas', Number(a.perdidas_por_orcamento) === 30 && Number(a.perdidas_por_classificacao) === 27.5 && a.vendas_organicas_qtd === 3 && Number(a.parcela_venda_ads) === 25, JSON.stringify(a));
  // releitura do dia sem as extras (API recusou) não apaga o que já estava
  await gravarAds(ml.id, '2026-09-27', [{ itemId: 'MLB1', impressoes: 110, cliques: 6, custo: 2.5,
    vendasDiretasQtd: 1, vendasDiretasValor: 70, vendasIndiretasQtd: 0, vendasIndiretasValor: 0 }]);
  [a] = await q("SELECT * FROM ads_metricas_diarias WHERE anuncio_id_marketplace = 'MLB1'");
  ok('releitura sem extras mantém as extras e atualiza o básico', a.impressoes === 110 && Number(a.perdidas_por_orcamento) === 30, JSON.stringify(a));
  await gravarAds(sp.id, '2026-09-27', [{ itemId: '999', impressoes: 50, cliques: 2, custo: 1 }]);
  const [s] = await q("SELECT * FROM ads_metricas_diarias WHERE anuncio_id_marketplace = '999'");
  ok('Shopee: extras ficam nulas (não zero)', s.perdidas_por_orcamento === null && s.vendas_organicas_qtd === null);

  console.log(`\n${falhas === 0 ? 'TUDO OK' : `${falhas} FALHA(S)`}`);
  await pool.end(); process.exit(falhas ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
