const path = require('path');
const express = require('express');

const { requireAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth.routes');
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

const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist');

function createApp() {
  const app = express();

  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
  });

  app.use('/api/auth', authRoutes);

  // Todas as rotas de dados abaixo exigem sessão válida.
  app.use('/api/configuracoes', requireAuth, configuracoesRoutes);
  app.use('/api/empresas', requireAuth, empresasRoutes);
  app.use('/api/listas', requireAuth, listasRoutes);
  app.use('/api/taxas-venda', requireAuth, taxasVendaRoutes);
  app.use('/api/custos-indiretos', requireAuth, custosIndiretosRoutes);
  app.use('/api/produtos', requireAuth, produtosRoutes);
  app.use('/api/importacao', requireAuth, importacaoRoutes);
  app.use('/api/simulacao', requireAuth, simulacaoRoutes);
  app.use('/api/kits', requireAuth, kitsRoutes);
  app.use('/api/ficha-tecnica', requireAuth, fichaTecnicaRoutes);

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
