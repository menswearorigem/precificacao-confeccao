const path = require('path');
const express = require('express');

const { requireAuth, requireModulo, requireAdmin } = require('./middleware/auth');
const { cabecalhosSeguranca, forcarHttps, conferirOrigem } = require('./middleware/seguranca');
const { limitadorAutenticacao, limitadorApi } = require('./lib/rateLimit');
const { middlewareAuditoria } = require('./lib/auditoria');
const authRoutes = require('./routes/auth.routes');
const usuariosRoutes = require('./routes/usuarios.routes');
const configuracoesRoutes = require('./routes/configuracoes.routes');
const empresasRoutes = require('./routes/empresas.routes');
const listasRoutes = require('./routes/listas.routes');
const taxasVendaRoutes = require('./routes/taxasVenda.routes');
const custosIndiretosRoutes = require('./routes/custosIndiretos.routes');
const produtosRoutes = require('./routes/produtos.routes');
const alertasRoutes = require('./routes/alertas.routes');
const buscaRoutes = require('./routes/busca.routes');
const importacaoRoutes = require('./routes/importacao.routes');
const importacaoMassaRoutes = require('./routes/importacaoMassa.routes');
const simulacaoRoutes = require('./routes/simulacao.routes');
const kitsRoutes = require('./routes/kits.routes');
const fichaTecnicaRoutes = require('./routes/fichaTecnica.routes');
const estoqueRoutes = require('./routes/estoque.routes');
const clientesRoutes = require('./routes/clientes.routes');
const pedidosRoutes = require('./routes/pedidos.routes');
const fornecedoresRoutes = require('./routes/fornecedores.routes');
const comprasRoutes = require('./routes/compras.routes');
const cotacoesRoutes = require('./routes/cotacoes.routes');
const { router: pedidosCompraRoutes } = require('./routes/pedidosCompra.routes');
const recebimentosRoutes = require('./routes/recebimentos.routes');
const integracoesRoutes = require('./routes/integracoes.routes');
const marketplaceTaxasRoutes = require('./routes/marketplaceTaxas.routes');
const viagensRoutes = require('./routes/viagens.routes');
const wikRoutes = require('./routes/wik.routes');
const conferenciaDadosRoutes = require('./routes/conferenciaDados.routes');
const qualidadeDadosRoutes = require('./routes/qualidadeDados.routes');
const calendarioRoutes = require('./routes/calendario.routes');
const conferenciaRoutes = require('./routes/conferencia.routes');
const gruposRoutes = require('./routes/grupos.routes');
const produtoMarketplaceRoutes = require('./routes/produtoMarketplace.routes');
const anunciosRoutes = require('./routes/anuncios.routes');
const etiquetasRoutes = require('./routes/etiquetas.routes');
const promocoesRoutes = require('./routes/promocoes.routes');
const insumosRoutes = require('./routes/insumos.routes');
const estoqueMinimoRoutes = require('./routes/estoqueMinimo.routes');
const producaoRoutes = require('./routes/producao.routes');
const producaoMovimentacaoRoutes = require('./routes/producaoMovimentacao.routes');
const mixTributarioRoutes = require('./routes/mixTributario.routes');
const analisesEstoqueRoutes = require('./routes/analisesEstoque.routes');
const estoqueLocaisRoutes = require('./routes/estoqueLocais.routes');
const estoqueReservaRoutes = require('./routes/estoqueReserva.routes');
const depositosRoutes = require('./routes/depositos.routes');
const romaneiosRoutes = require('./routes/romaneios.routes');
const devolucoesRoutes = require('./routes/devolucoes.routes');
const precoPorCanalRoutes = require('./routes/precoPorCanal.routes');
const saudeIntegracaoRoutes = require('./routes/saudeIntegracao.routes');
const financeiroRoutes = require('./routes/financeiro.routes');
const financeiroNucleoRoutes = require('./routes/financeiroNucleo.routes');
const financeiroPonteRoutes = require('./routes/financeiroPonte.routes');
const auditoriaRoutes = require('./routes/auditoria.routes');
const emailRoutes = require('./routes/email.routes');
// Repaginação do módulo Vendas (09/09/2026): vendedores, tabelas de preço e
// o painel próprio de métricas/lucratividade da venda direta.
const vendedoresRoutes = require('./routes/vendedores.routes');
const tabelasPrecoRoutes = require('./routes/tabelasPreco.routes');
const vendasRoutes = require('./routes/vendas.routes');

const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');

function createApp() {
  const app = express();

  // O Render (como qualquer proxy reverso) entrega HTTPS pro navegador mas
  // repassa a requisição pro servidor como HTTP puro — sem isso, req.protocol
  // sempre voltava "http", quebrando o redirect_uri das integrações de
  // marketplace (que precisa bater exatamente com o cadastrado no app).
  app.set('trust proxy', 1);

  // Não anuncia "Express" pra quem estiver catalogando alvos.
  app.disable('x-powered-by');

  // ---------------------------------------------------------------------
  // Blindagem (varredura de segurança de 03/09/2026). A ordem importa:
  // HTTPS antes de qualquer coisa, cabeçalhos em toda resposta, limite de
  // requisições antes de tocar no banco, conferência de origem antes de
  // qualquer rota que muda dado.
  // ---------------------------------------------------------------------
  app.use(forcarHttps);
  app.use(cabecalhosSeguranca);
  app.use('/api', limitadorApi);
  app.use('/api/auth', limitadorAutenticacao);

  // Corpo de requisição: 15MB valia pra TODAS as rotas, inclusive o login —
  // qualquer um podia empurrar 15MB de JSON sem estar logado. Agora o padrão
  // é 1MB e só as rotas que realmente recebem planilha/base64 ficam com o
  // limite grande.
  const jsonGrande = express.json({ limit: '15mb' });
  app.use('/api/importacao', jsonGrande);
  app.use('/api/importacao-massa', jsonGrande);
  app.use('/api/estoque', jsonGrande);
  app.use('/api/pedidos', jsonGrande);
  app.use('/api/produtos', jsonGrande);
  app.use('/api/financeiro', jsonGrande);
  app.use('/api/financeiro-nucleo', jsonGrande);
  app.use(express.json({ limit: '1mb' }));

  app.use(conferirOrigem);
  app.use(middlewareAuditoria);

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRoutes);

  // Gestão de usuários é só pra administrador (checado dentro do próprio router).
  app.use('/api/usuarios', requireAuth, usuariosRoutes);

  // Listas e empresas alimentam dropdowns usados em quase toda tela do
  // sistema — leitura fica liberada pra qualquer usuário autenticado, e só a
  // edição (cadastro/config) exige o módulo "configuracoes".
  app.use('/api/listas', requireAuth, listasRoutes);
  app.use('/api/empresas', requireAuth, empresasRoutes);
  // Grupos alimenta o seletor de visibilidade do Calendário (qualquer
  // usuário autenticado precisa ler nome/membros pra montar a seção
  // "Grupos") — só a edição em /configuracoes/grupos exige o módulo.
  app.use('/api/grupos', requireAuth, gruposRoutes);

  app.use('/api/configuracoes', requireAuth, requireModulo('configuracoes'), configuracoesRoutes);
  app.use('/api/taxas-venda', requireAuth, requireModulo('configuracoes'), taxasVendaRoutes);
  app.use('/api/custos-indiretos', requireAuth, requireModulo('configuracoes'), custosIndiretosRoutes);
  app.use('/api/marketplace-taxas', requireAuth, requireModulo('configuracoes'), marketplaceTaxasRoutes);

  // Análises (dashboard/simulador) trabalha em cima dos mesmos dados de
  // custo/preço do módulo Produto — por isso também libera acesso a produtos.
  app.use('/api/produtos', requireAuth, requireModulo(['produto', 'analises']), produtosRoutes);
  app.use('/api/alertas', requireAuth, requireModulo(['produto', 'analises']), alertasRoutes);
  app.use('/api/busca', requireAuth, buscaRoutes);
  app.use('/api/importacao', requireAuth, requireModulo('produto'), importacaoRoutes);
  // Importação em massa: grade, cadastro e variante. Mesma chave `produto` da
  // importação que já existia — quem podia criar produto por planilha continua
  // podendo, e ninguém ganhou acesso novo (REGRA 4).
  app.use('/api/importacao-massa', requireAuth, requireModulo('produto'), importacaoMassaRoutes);
  app.use('/api/kits', requireAuth, requireModulo('produto'), kitsRoutes);
  app.use('/api/ficha-tecnica', requireAuth, requireModulo(['produto', 'vendas']), fichaTecnicaRoutes);
  app.use('/api/simulacao', requireAuth, requireModulo('analises'), simulacaoRoutes);
  // Mix B2B × B2C (07/09/2026). Leitura pura sobre pedido já gravado, para a
  // decisão da opção do Simples pelo regime regular de IBS/CBS. Fica sob
  // `analises`, o módulo que já tem as telas de leitura consolidada —
  // nenhuma permissão existente muda por causa desta rota nova (REGRA 4).
  app.use('/api/mix-tributario', requireAuth, requireModulo('analises'), mixTributarioRoutes);
  // Preco por canal (08/09/2026). Le o custo e o imposto do MOTOR e forma o
  // preco com a taxa real de cada marketplace. Fica junto de produto/analises
  // porque e' leitura de precificacao -- nao grava preco nenhum (REGRA 1).
  app.use('/api/preco-por-canal', requireAuth, requireModulo(['produto', 'analises']), precoPorCanalRoutes);

  app.use('/api/estoque', requireAuth, requireModulo('estoque'), estoqueRoutes);

  // Seleção "produtos de marketplace". Não devolve preço nem margem — só
  // identificação da referência — então é liberada pros três módulos que
  // precisam dela: Produto (marcar na lista), Estoque (puxar as fichas em
  // lote) e Configurações (administrar a seleção).
  app.use(
    '/api/produtos-marketplace',
    requireAuth,
    requireModulo(['produto', 'estoque', 'configuracoes']),
    produtoMarketplaceRoutes
  );
  // Aba Marketplace › Anúncios (04/09/2026). Fica sob o módulo `marketplace`
  // — o mesmo de Pedidos e Lucratividade — e NÃO sob `configuracoes`: quem
  // cuida de anúncio precisa disto no dia a dia, e nenhuma permissão
  // existente muda por causa desta rota nova.
  app.use('/api/anuncios', requireAuth, requireModulo('marketplace'), anunciosRoutes);
  // Etiquetas: ZPL -> PDF, impressao em lote e lista de separacao
  // (09/09/2026). Pedido de 03/09 que estava adiado. Fica sob `marketplace`,
  // que e' de onde vem a etiqueta -- nenhuma chave de modulo nova (REGRA 4).
  app.use('/api/etiquetas', requireAuth, requireModulo(['marketplace', 'estoque']), etiquetasRoutes);
  // Aba Marketplace › Promoções (06/09/2026). Mesmo módulo de permissão de
  // Anúncios: é a mesma pessoa que cuida de um e de outro, e nenhuma
  // permissão existente muda por causa desta rota nova (REGRA 4).
  app.use('/api/promocoes', requireAuth, requireModulo('marketplace'), promocoesRoutes);
  // Insumos e nota fiscal de entrada (06/09/2026). Ficam sob o modulo
  // `compras` -- e' quem compra que lanca nota e cadastra materia-prima.
  // Nenhuma permissao existente muda por causa desta rota nova (REGRA 4).
  app.use('/api/insumos', requireAuth, requireModulo('compras'), insumosRoutes);
  // Fluxo de compra completo (09/09/2026): cotacao -> pedido -> recebimento.
  // Tudo sob o modulo `compras`, que ja existe -- nenhuma chave de modulo
  // nova, nenhuma permissao existente muda (REGRA 4).
  app.use('/api/cotacoes', requireAuth, requireModulo('compras'), cotacoesRoutes);
  app.use('/api/pedidos-compra', requireAuth, requireModulo('compras'), pedidosCompraRoutes);
  app.use('/api/recebimentos', requireAuth, requireModulo('compras'), recebimentosRoutes);
  // Estoque minimo, cobertura e ponto de pedido (06/09/2026). Fica sob
  // `estoque` -- e' quem cuida do saldo que precisa disto no dia a dia.
  app.use('/api/estoque-minimo', requireAuth, requireModulo('estoque'), estoqueMinimoRoutes);
  // Producao: roteiro de operacoes, ordem de producao e facção (07/09/2026).
  // Fica sob `estoque` de proposito, e NAO sob um modulo novo: uma chave de
  // modulo nova precisaria ser registrada em cinco lugares e mudaria quem
  // enxerga o que, e a REGRA 4 proibe mexer em regra de permissao sem
  // autorizacao. `estoque` e' o dono natural: toda ordem de producao come
  // insumo do saldo e devolve peca pro saldo, e o saldo em faccao e' estoque
  // da empresa que so' esta' na mao de terceiro.
  // Produção ganhou MÓDULO PRÓPRIO em 08/09/2026 (autorizado pela dona).
  //
  // O aceite continua sendo `['producao', 'estoque']`, e não só `producao`,
  // de propósito: quem hoje tem `estoque` já usa a Produção, e trocar a chave
  // de uma vez tiraria a tela dessas pessoas no primeiro deploy. Assim a
  // chave nova ACRESCENTA um caminho de acesso em vez de substituir o antigo
  // — ninguém perde nada, e agora dá para dar Produção a quem não deve ver o
  // saldo do estoque, que era o ponto.
  app.use('/api/producao', requireAuth, requireModulo(['producao', 'estoque']), producaoRoutes);
  // Movimentacao de producao, O.S. de faccao, preco de servico e carga
  // (09/09/2026). Mesma chave de modulo da producao -- nenhuma permissao
  // existente muda (REGRA 4).
  app.use('/api/producao-movimentacao', requireAuth, requireModulo(['producao', 'estoque']), producaoMovimentacaoRoutes);
  // Onde a peça está (08/09/2026): endereço no galpão e saldo por local.
  // Fica em `estoque` — é saldo de peça pronta — e aceita `producao` porque a
  // remessa para facção sai da tela de Produção e precisa ler o saldo por
  // local para não mandar peça que não está aqui.
  app.use('/api/estoque-locais', requireAuth, requireModulo(['estoque', 'producao']), estoqueLocaisRoutes);
  // Reserva de estoque (09/09/2026): separa o que existe do que ainda pode
  // ser vendido. Mesma chave de modulo `estoque` -- nenhuma permissao muda.
  app.use('/api/estoque-reserva', requireAuth, requireModulo('estoque'), estoqueReservaRoutes);
  // Depósito é assunto de estoque, mas quem move tecido para a facção é a
  // Produção — as duas chaves enxergam, como já acontece em estoque-locais.
  app.use('/api/depositos', requireAuth, requireModulo(['estoque', 'producao']), depositosRoutes);
  // Romaneio é o passo seguinte à etiqueta, então as MESMAS chaves de
  // /api/etiquetas: quem imprime a etiqueta é quem monta a remessa. Nenhuma
  // chave de permissão nova (REGRA 4).
  app.use('/api/romaneios', requireAuth, requireModulo(['marketplace', 'estoque']), romaneiosRoutes);
  // Devolução mexe em estoque e nasce de venda de marketplace: as mesmas
  // chaves do romaneio. Nenhuma permissão nova (REGRA 4).
  app.use('/api/devolucoes', requireAuth, requireModulo(['marketplace', 'estoque']), devolucoesRoutes);
  // Estoque parado em R$ e curva de tamanho (08/09/2026). Sob `estoque` pelo
  // mesmo motivo do estoque minimo: as duas leem saldo e historico de venda,
  // e nenhuma tabela nova foi criada (REGRA 4).
  app.use('/api/analises-estoque', requireAuth, requireModulo('estoque'), analisesEstoqueRoutes);
  app.use('/api/clientes', requireAuth, requireModulo('vendas'), clientesRoutes);
  app.use('/api/pedidos', requireAuth, requireModulo(['vendas', 'marketplace']), pedidosRoutes);
  // Vendedores e tabelas de preço: LER exige `vendas` ou `configuracoes` (a
  // tela de pedido precisa dos dois seletores); ESCREVER exige
  // `configuracoes`, aplicado dentro de cada router, rota a rota. Nenhuma
  // chave de módulo nova foi criada (REGRA 4).
  app.use('/api/vendedores', requireAuth, requireModulo(['vendas', 'configuracoes']), vendedoresRoutes);
  app.use('/api/tabelas-preco', requireAuth, requireModulo(['vendas', 'configuracoes']), tabelasPrecoRoutes);
  // Painel do módulo Vendas — métricas, lucratividade com comissão e o
  // lançamento das despesas de publicidade do mês.
  app.use('/api/vendas', requireAuth, requireModulo('vendas'), vendasRoutes);
  app.use('/api/fornecedores', requireAuth, requireModulo('compras'), fornecedoresRoutes);
  app.use('/api/compras', requireAuth, requireModulo('compras'), comprasRoutes);
  app.use('/api/viagens', requireAuth, requireModulo('viagens'), viagensRoutes);

  // Conferência de expedição. Fica no módulo Marketplace porque é ele que
  // traz os pedidos que são conferidos — mas note que a rota NÃO devolve
  // preço, custo nem margem de nada: quem confere caixa precisa saber o que
  // vai dentro, não quanto custou.
  app.use('/api/conferencia', requireAuth, requireModulo('marketplace'), conferenciaRoutes);
  // Saúde da Sincronização (07/09/2026). Mesmo módulo do resto do
  // Marketplace: é quem cuida dos pedidos que precisa saber que um deles não
  // entrou. A rota NÃO devolve preço, custo nem margem — só identificação do
  // pedido e o erro. Nenhuma permissão existente muda (REGRA 4).
  app.use('/api/saude-integracao', requireAuth, requireModulo('marketplace'), saudeIntegracaoRoutes);
  app.use('/api/calendario', requireAuth, requireModulo('calendario'), calendarioRoutes);

  // Financeiro é o nono módulo, e é PROPOSITALMENTE separado de Marketplace:
  // quem cuida do caixa precisa ver a movimentação da conta, e não precisa
  // ver custo de produto, margem nem ficha de precificação. Por isso um
  // módulo próprio em vez de mais uma aba dentro de Marketplace — dar acesso
  // ao módulo Marketplace pra alguém do financeiro abriria junto a
  // Lucratividade e o custo de cada peça.
  app.use('/api/financeiro', requireAuth, requireModulo('financeiro'), financeiroRoutes);
  // Financeiro nucleo (09/09/2026): plano financeiro, centro de custo,
  // contas, titulos a pagar/receber, baixa, extrato OFX, conciliacao,
  // fluxo de caixa e DRE. Mesma chave de modulo `financeiro` -- nenhuma
  // permissao existente muda (REGRA 4). Nao emite documento fiscal.
  app.use('/api/financeiro-nucleo', requireAuth, requireModulo('financeiro'), financeiroNucleoRoutes);
  // Ponte financeira (09/09/2026): a Caixa de Entrada (o que a operacao
  // comprometeu e o financeiro ainda nao registrou), a Cobertura (o que moveu
  // dinheiro e nao chegou ao financeiro por caminho nenhum) e o catalogo de
  // origens. Mesma chave `financeiro` -- nenhuma permissao nova (REGRA 4).
  //
  // As rotas de LEITURA do selo de um documento sao usadas pelas telas dos
  // modulos (O.S., pedido de compra, devolucao), que nem sempre sao de quem
  // tem o modulo financeiro -- por isso `/documento` e `/documentos` ficam
  // abertas a quem tem QUALQUER um dos modulos que geram custo. Elas nao
  // devolvem valor de titulo alheio: so o estado do documento que a pessoa ja
  // enxerga na propria tela.
  app.use('/api/financeiro-ponte/documento', requireAuth,
    requireModulo(['financeiro', 'producao', 'compras', 'vendas', 'marketplace', 'estoque']),
    financeiroPonteRoutes);
  app.use('/api/financeiro-ponte/documentos', requireAuth,
    requireModulo(['financeiro', 'producao', 'compras', 'vendas', 'marketplace', 'estoque']),
    financeiroPonteRoutes);
  app.use('/api/financeiro-ponte', requireAuth, requireModulo('financeiro'), financeiroPonteRoutes);

  // Callbacks OAuth são chamados pelo redirect do próprio marketplace — sem
  // sessão nossa nesse momento, então ficam fora do requireAuth. A validação
  // de segurança é o "state" de uso único gravado em integracoes_oauth_state.
  app.use('/api/integracoes/mercado_livre/callback', integracoesRoutes.callbackMercadoLivre);
  app.use('/api/integracoes/shopee/callback', integracoesRoutes.callbackShopee);
  app.use('/api/integracoes/tiktok_shop/callback', integracoesRoutes.callbackTikTokShop);
  // Publicidade da TikTok é um app separado, com autorização própria — daí
  // um callback próprio, e não um ramo dentro do callback da loja.
  app.use('/api/integracoes/tiktok_ads/callback', integracoesRoutes.callbackTikTokAds);
  app.use('/api/integracoes/mercado_livre/notificacoes', integracoesRoutes.notificacoesMercadoLivre);
  app.use('/api/integracoes', requireAuth, requireAdmin, integracoesRoutes);
  app.use('/api/wik', requireAuth, requireAdmin, wikRoutes);
  app.use('/api/conferencia-dados', requireAuth, requireAdmin, conferenciaDadosRoutes);
  app.use('/api/qualidade-dados', requireAuth, requireAdmin, qualidadeDadosRoutes);

  // Histórico de alteração por usuário e diagnóstico de e-mail — só admin.
  app.use('/api/auditoria', requireAuth, requireAdmin, auditoriaRoutes);
  app.use('/api/email', requireAuth, requireAdmin, emailRoutes);

  // Build do React em produção (um único serviço no Render).
  app.use(express.static(CLIENT_DIST));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
      if (err) res.status(404).send('Build do frontend não encontrado. Rode "npm run build:client".');
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Erros que o multer levanta chegam aqui como 500 e a pessoa via só
    // "Erro interno do servidor" — agora ela lê o motivo.
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'O arquivo é maior que o limite permitido.' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'O conteúdo enviado é maior que o limite permitido.' });
    }
    // Um número curto e aleatório no log e na resposta: a pessoa manda esse
    // número e dá pra achar o erro exato no log, sem expor detalhe interno.
    const marca = Math.random().toString(36).slice(2, 8).toUpperCase();
    console.error(`[erro ${marca}]`, err);
    res.status(500).json({ error: `Erro interno do servidor. Se precisar de ajuda, informe o código ${marca}.` });
  });

  return app;
}

module.exports = createApp;
