const path = require('path');
const express = require('express');

const { requireAuth, requireModulo, requireAdmin } = require('./middleware/auth');
const authRoutes = require('./routes/auth.routes');
const usuariosRoutes = require('./routes/usuarios.routes');
const configuracoesRoutes = require('./routes/configuracoes.routes');
const empresasRoutes = require('./routes/empresas.routes');
const listasRoutes = require('./routes/listas.routes');
const taxasVendaRoutes = require('./routes/taxasVenda.routes');
const custosIndiretosRoutes = require('./routes/custosIndiretos.routes');
const produtosRoutes = require('./routes/produtos.routes');
const importacaoRoutes = require('./routes/importacao.routes');
const simulacaoRoutes = require('./routes/simulacao.routes');
const kitsRoutes = require('./routes/kits.routes');
const fichaTecnicaRoutes = require('./routes/fichaTecnica.routes');
const estoqueRoutes = require('./routes/estoque.routes');
const clientesRoutes = require('./routes/clientes.routes');
const pedidosRoutes = require('./routes/pedidos.routes');
const fornecedoresRoutes = require('./routes/fornecedores.routes');
const comprasRoutes = require('./routes/compras.routes');
const integracoesRoutes = require('./routes/integracoes.routes');
const marketplaceTaxasRoutes = require('./routes/marketplaceTaxas.routes');
const viagensRoutes = require('./routes/viagens.routes');
const wikRoutes = require('./routes/wik.routes');
const conferenciaDadosRoutes = require('./routes/conferenciaDados.routes');
const qualidadeDadosRoutes = require('./routes/qualidadeDados.routes');

const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');

function createApp() {
  const app = express();

  // O Render (como qualquer proxy reverso) entrega HTTPS pro navegador mas
  // repassa a requisição pro servidor como HTTP puro — sem isso, req.protocol
  // sempre voltava "http", quebrando o redirect_uri das integrações de
  // marketplace (que precisa bater exatamente com o cadastrado no app).
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
  });

  app.use('/api/auth', authRoutes);

  // Gestão de usuários é só pra administrador (checado dentro do próprio router).
  app.use('/api/usuarios', requireAuth, usuariosRoutes);

  // Listas e empresas alimentam dropdowns usados em quase toda tela do
  // sistema — leitura fica liberada pra qualquer usuário autenticado, e só a
  // edição (cadastro/config) exige o módulo "configuracoes".
  app.use('/api/listas', requireAuth, listasRoutes);
  app.use('/api/empresas', requireAuth, empresasRoutes);

  app.use('/api/configuracoes', requireAuth, requireModulo('configuracoes'), configuracoesRoutes);
  app.use('/api/taxas-venda', requireAuth, requireModulo('configuracoes'), taxasVendaRoutes);
  app.use('/api/custos-indiretos', requireAuth, requireModulo('configuracoes'), custosIndiretosRoutes);
  app.use('/api/marketplace-taxas', requireAuth, requireModulo('configuracoes'), marketplaceTaxasRoutes);

  // Análises (dashboard/simulador) trabalha em cima dos mesmos dados de
  // custo/preço do módulo Produto — por isso também libera acesso a produtos.
  app.use('/api/produtos', requireAuth, requireModulo(['produto', 'analises']), produtosRoutes);
  app.use('/api/importacao', requireAuth, requireModulo('produto'), importacaoRoutes);
  app.use('/api/kits', requireAuth, requireModulo('produto'), kitsRoutes);
  app.use('/api/ficha-tecnica', requireAuth, requireModulo(['produto', 'vendas']), fichaTecnicaRoutes);
  app.use('/api/simulacao', requireAuth, requireModulo('analises'), simulacaoRoutes);

  app.use('/api/estoque', requireAuth, requireModulo('estoque'), estoqueRoutes);
  app.use('/api/clientes', requireAuth, requireModulo('vendas'), clientesRoutes);
  app.use('/api/pedidos', requireAuth, requireModulo(['vendas', 'marketplace']), pedidosRoutes);
  app.use('/api/fornecedores', requireAuth, requireModulo('compras'), fornecedoresRoutes);
  app.use('/api/compras', requireAuth, requireModulo('compras'), comprasRoutes);
  app.use('/api/viagens', requireAuth, requireModulo('viagens'), viagensRoutes);

  // Callbacks OAuth são chamados pelo redirect do próprio marketplace — sem
  // sessão nossa nesse momento, então ficam fora do requireAuth. A validação
  // de segurança é o "state" de uso único gravado em integracoes_oauth_state.
  app.use('/api/integracoes/mercado_livre/callback', integracoesRoutes.callbackMercadoLivre);
  app.use('/api/integracoes/shopee/callback', integracoesRoutes.callbackShopee);
  app.use('/api/integracoes/tiktok_shop/callback', integracoesRoutes.callbackTikTokShop);
  app.use('/api/integracoes/mercado_livre/notificacoes', integracoesRoutes.notificacoesMercadoLivre);
  app.use('/api/integracoes', requireAuth, requireAdmin, integracoesRoutes);
  app.use('/api/wik', requireAuth, requireAdmin, wikRoutes);
  app.use('/api/conferencia-dados', requireAuth, requireAdmin, conferenciaDadosRoutes);
  app.use('/api/qualidade-dados', requireAuth, requireAdmin, qualidadeDadosRoutes);

  // Build do React em produção (um único serviço no Render).
  app.use(express.static(CLIENT_DIST));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
      if (err) res.status(404).send('Build do frontend não encontrado. Rode "npm run build:client".');
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  return app;
}

module.exports = createApp;
