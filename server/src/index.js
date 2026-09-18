require('dotenv').config();
const createApp = require('./app');
const pool = require('./db/pool');
const { sincronizarTodasAtivas } = require('./lib/marketplaceSync');
const { sincronizarExtratoTodasAtivas } = require('./lib/financeiroExtrato');
const { sincronizarFullTodasAtivas } = require('./lib/fullSync');
// TODAS as sincronizações do Wik rodam por UM maestro só, em sequência, pra
// nunca duas baterem na mesma sessão do Wik (ver server/src/lib/wikCiclo.js).
const { cicloWikCompleto } = require('./lib/wikCiclo');
const { reconciliarCalendario } = require('./lib/producaoCalendario');

// ── AUTO-CURA de travas ÓRFÃS do Wik no boot ────────────────────────────────
// `web_job_ativo` e `producao_job_ativo` são FLAGS no banco (não advisory
// locks), então NÃO soltam sozinhas quando o processo morre. Todo deploy no
// Render DRENA a instância antiga — se ela estava no meio de um job do Wik
// (produção/financeiro), a flag fica PRESA e bloqueia financeiro, vendas e a
// própria produção por até 25 min (o guarda de tempo), deixando a tela em
// "outro job do Wik está rodando" / "sessão web ocupada" sem nada rodando.
//
// No boot, esta instância acabou de subir: não criou nenhuma trava ainda, e a
// instância anterior (se existir) está sendo drenada. Então qualquer trava
// parada há mais de 3 min é órfã e pode ser solta com segurança — uma trava
// FRESCA (< 3 min, um "Sincronizar agora" recém-disparado numa instância que
// ainda esteja de pé no overlap do deploy) é poupada. Idem para status preso
// em 'rodando'. Isso faz o financeiro/vendas destravarem no ato do deploy, em
// vez de esperar o guarda de 25 min.
async function soltarTravasOrfasWik() {
  try {
    const r = await pool.query(`
      UPDATE integracoes_wik SET
        web_job_ativo = CASE WHEN web_job_ativo_desde < now() - interval '3 minutes' THEN NULL ELSE web_job_ativo END,
        web_job_ativo_desde = CASE WHEN web_job_ativo_desde < now() - interval '3 minutes' THEN NULL ELSE web_job_ativo_desde END,
        producao_job_ativo = CASE WHEN producao_job_ativo_desde < now() - interval '3 minutes' THEN NULL ELSE producao_job_ativo END,
        producao_job_ativo_desde = CASE WHEN producao_job_ativo_desde < now() - interval '3 minutes' THEN NULL ELSE producao_job_ativo_desde END,
        -- CORRIGIDO (18/09/2026): a trava da porta da API (wik_job_ativo) e o
        -- preview de estoque NÃO eram soltos no boot. Se o Render drenava a
        -- instância no meio de um job, todo botão do Wik era recusado por até
        -- 30 min sem nada rodando, e o preview ficava "rodando" para sempre.
        wik_job_ativo = CASE WHEN wik_job_ativo_desde < now() - interval '3 minutes' THEN NULL ELSE wik_job_ativo END,
        wik_job_ativo_desde = CASE WHEN wik_job_ativo_desde < now() - interval '3 minutes' THEN NULL ELSE wik_job_ativo_desde END,
        preview_status = CASE WHEN preview_status = 'rodando' AND preview_iniciado_em < now() - interval '3 minutes' THEN 'idle' ELSE preview_status END,
        financeiro_status = CASE WHEN financeiro_status = 'rodando' THEN 'idle' ELSE financeiro_status END
      WHERE web_job_ativo IS NOT NULL OR producao_job_ativo IS NOT NULL
         OR wik_job_ativo IS NOT NULL OR preview_status = 'rodando' OR financeiro_status = 'rodando'
      RETURNING id`);
    if (r.rowCount) console.log('[wik-boot] travas órfãs do Wik soltas (deploy anterior foi drenado no meio de um job)');
  } catch (err) {
    console.error('[wik-boot] falha ao soltar travas órfãs:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
// Pedidos novos + valor recebido do marketplace — intervalo mais curto que
// os outros porque é a informação que mais muda minuto a minuto (pedido
// pago, pagamento confirmado, saldo liberado). Cada ciclo é só uma
// dúzia de chamadas na API do Mercado Livre (pedidos + no máximo 50
// pagamentos a reconferir), bem dentro do limite generoso da API deles —
// se algum dia começar a bater rate limit, aparece em "Última tentativa
// falhou" na tela de Integrações, e dá pra alongar esse intervalo de novo.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
// UM maestro do Wik roda o ciclo inteiro a cada 15 min. Ele chama TODAS as
// sincronizações do Wik em sequência (token, estoque, produção, clientes,
// vendas, financeiro, catálogo, ficha), e cada etapa tem a sua própria cadência
// interna — as caras (catálogo/ficha: 6h) só rodam quando vencem. Como é uma
// execução só, nunca duas caem na mesma sessão do Wik. Ver lib/wikCiclo.js.
const WIK_CICLO_INTERVAL_MS = 15 * 60 * 1000;
// Extrato financeiro dos marketplaces. Ritmo bem mais lento que o de
// pedidos de propósito: extrato não muda minuto a minuto (a plataforma
// fecha repasse uma ou duas vezes por semana), e no Mercado Livre cada
// ciclo custa a GERAÇÃO de um relatório do lado deles — pedir de 5 em 5
// minutos seria desperdício puro. 30min também é o cooldown interno da
// própria sincronização (COOLDOWN_MS em financeiroExtrato.js).
const EXTRATO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
// Fulfillment (aba Marketplace › Full, 11/09/2026). 3h, e a razão é que este
// laço tem uma função que os outros não têm: ele GRAVA O RETRATO DO DIA do
// saldo no centro de distribuição — o histórico que nenhuma plataforma
// devolve e do qual saem "está no Full há N dias", "ficou zerado N dias" e a
// dedução de chegada de remessa. Rodar uma vez por dia bastaria para o
// retrato; 3h existe para o servidor poder ficar algumas horas fora do ar sem
// abrir buraco na série, porque um dia sem retrato é um dia que não volta.
//
// O custo é baixo: uma chamada por unidade de estoque no Full, e só das lojas
// que têm fulfillment. Não toca a API de pedidos nem a de Ads.
const FULL_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;

const app = createApp();

app.listen(PORT, () => {
  console.log('');
  console.log('==================================================');
  console.log('  Precificação Confecção — servidor no ar');
  console.log('  Porta: ' + PORT);
  console.log('==================================================');
  console.log('');

  // Solta travas órfãs do Wik ANTES de qualquer ciclo (o maestro só roda 15s
  // depois, então a limpeza termina primeiro). Destrava financeiro/vendas no
  // ato do deploy em vez de esperar o guarda de 25 min.
  soltarTravasOrfasWik();

  // Puxa pedidos novos dos marketplaces conectados (Mercado Livre, Shopee)
  // periodicamente, sem depender de o usuário clicar em "sincronizar agora".
  setInterval(() => {
    sincronizarTodasAtivas().catch((err) => console.error('[marketplace-sync]', err.message));
  }, SYNC_INTERVAL_MS);

  // Extrato financeiro (módulo Financeiro). Espera 2min na subida pra não
  // concorrer com o primeiro ciclo de pedidos pelo mesmo token.
  setTimeout(() => {
    sincronizarExtratoTodasAtivas().catch((err) => console.error('[financeiro-extrato]', err.message));
  }, 2 * 60 * 1000);
  setInterval(() => {
    sincronizarExtratoTodasAtivas().catch((err) => console.error('[financeiro-extrato]', err.message));
  }, EXTRATO_SYNC_INTERVAL_MS);

  // Fulfillment. Espera 4min na subida para entrar DEPOIS do primeiro ciclo
  // de pedidos e do extrato: os três usam o mesmo token de marketplace, e
  // disputá-lo no primeiro minuto é a única forma conhecida de fazer uma
  // renovação de token concorrer consigo mesma.
  setTimeout(() => {
    sincronizarFullTodasAtivas().catch((err) => console.error('[full-sync]', err.message));
  }, 4 * 60 * 1000);
  setInterval(() => {
    sincronizarFullTodasAtivas().catch((err) => console.error('[full-sync]', err.message));
  }, FULL_SYNC_INTERVAL_MS);

  // ── O MAESTRO DO WIK ──────────────────────────────────────────────────────
  // Uma execução só, tudo em sequência, pra nunca duas sincronizações caírem na
  // mesma sessão do Wik (o Wik só deixa UMA sessão por login — no token da API
  // E no cookie da web). Cada etapa tem cadência própria dentro do maestro, então
  // chamar de 15 em 15 min já cobre estoque/produção sem rodar catálogo/ficha à
  // toa (essas só vencem a cada 6h). Ver lib/wikCiclo.js.
  //
  // Primeiro ciclo 15s após subir (popula tudo de uma vez no boot); depois a
  // cada 15 min. O próprio maestro pula um tick que caia enquanto o anterior
  // ainda está rodando.
  setTimeout(() => {
    cicloWikCompleto('boot').catch((err) => console.error('[wik-ciclo]', err.message));
  }, 15 * 1000);
  // Calendário × OPs de marketplace. O ciclo de produção do Wik já reconcilia
  // no fim de cada passada; esta rodada independente cobre o boot (OPs que já
  // estavam no banco antes deste recurso) e o caso de o Wik estar desligado.
  // Só toca OP que mudou — a passada sem novidade não grava nada.
  const reconciliar = () => reconciliarCalendario(pool)
    .then((r) => { if (r.criados || r.atualizados || r.erros.length) console.log('[calendario-op]', JSON.stringify({ ...r, erros: r.erros.slice(0, 3) })); })
    .catch((err) => console.error('[calendario-op]', err.message));
  setTimeout(reconciliar, 60 * 1000);
  setInterval(reconciliar, 60 * 60 * 1000);
  setInterval(() => {
    cicloWikCompleto('agenda').catch((err) => console.error('[wik-ciclo]', err.message));
  }, WIK_CICLO_INTERVAL_MS);
});
