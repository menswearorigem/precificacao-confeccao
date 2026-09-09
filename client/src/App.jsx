import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { DensidadeProvider } from './contexts/DensidadeContext';
import Shell from './components/Shell';
import { ConfirmDialogRoot } from './components/ConfirmDialog';
import { canAccessPath, getDefaultPath } from './lib/modules';
import LoginPage from './pages/LoginPage';
import EsqueciSenhaPage from './pages/EsqueciSenhaPage';
import RedefinirSenhaPage from './pages/RedefinirSenhaPage';
import ConfiguracoesPage from './pages/ConfiguracoesPage';
import EmpresasPage from './pages/EmpresasPage';
import ListasPage from './pages/ListasPage';
import CustosIndiretosPage from './pages/CustosIndiretosPage';
import IntegracoesPage from './pages/IntegracoesPage';
import TaxasPage from './pages/TaxasPage';
import AcessosPage from './pages/AcessosPage';
import SaudeDadosPage from './pages/SaudeDadosPage';
import ProdutosMarketplacePage from './pages/ProdutosMarketplacePage';
import CalendarioPage from './pages/CalendarioPage';
import TemplatesCalendarioPage from './pages/TemplatesCalendarioPage';
import EventoImpressaoPage from './pages/EventoImpressaoPage';
import ProdutosListPage from './pages/ProdutosListPage';
import ProdutoFichaPage from './pages/ProdutoFichaPage';
import ImportacaoPage from './pages/ImportacaoPage';
import SimuladorPage from './pages/SimuladorPage';
import DashboardPage from './pages/DashboardPage';
import FichaPrecificacaoPage from './pages/FichaPrecificacaoPage';
import AlertasPage from './pages/AlertasPage';
import KitsPage from './pages/KitsPage';
import FichaTecnicaPage from './pages/FichaTecnicaPage';
import FichaVendaPage from './pages/FichaVendaPage';
import EstoquePage from './pages/EstoquePage';
import BipagemPage from './pages/BipagemPage';
import EstoqueImportacaoPage from './pages/EstoqueImportacaoPage';
import EstoqueEanImportacaoPage from './pages/EstoqueEanImportacaoPage';
import FichaEstoquePage from './pages/FichaEstoquePage';
import ClientesListPage from './pages/ClientesListPage';
import ClienteFichaPage from './pages/ClienteFichaPage';
import PedidosListPage from './pages/PedidosListPage';
import PedidoFormPage from './pages/PedidoFormPage';
import FornecedoresListPage from './pages/FornecedoresListPage';
import FornecedorFichaPage from './pages/FornecedorFichaPage';
import ComprasListPage from './pages/ComprasListPage';
import CompraFormPage from './pages/CompraFormPage';
import RelatorioComprasPage from './pages/RelatorioComprasPage';
import CotacoesPage from './pages/CotacoesPage';
import PedidosCompraPage from './pages/PedidosCompraPage';
import RecebimentosPage from './pages/RecebimentosPage';
import RelatorioLucratividadePage from './pages/RelatorioLucratividadePage';
import MetricasMarketplacePage from './pages/MetricasMarketplacePage';
import AnunciosPage from './pages/AnunciosPage';
import CoberturaEstoquePage from './pages/CoberturaEstoquePage';
import ProducaoPage from './pages/ProducaoPage';
import MovimentacaoProducaoPage from './pages/MovimentacaoProducaoPage';
import OrdensServicoPage from './pages/OrdensServicoPage';
import CargaProducaoPage from './pages/CargaProducaoPage';
import InsumosPage from './pages/InsumosPage';
import PromocoesPage from './pages/PromocoesPage';
import MixTributarioPage from './pages/MixTributarioPage';
import EstoqueParadoPage from './pages/EstoqueParadoPage';
import EstoqueLocaisPage from './pages/EstoqueLocaisPage';
import ReservaEstoquePage from './pages/ReservaEstoquePage';
import CurvaTamanhoPage from './pages/CurvaTamanhoPage';
import PrecoPorCanalPage from './pages/PrecoPorCanalPage';
import SaudeIntegracaoPage from './pages/SaudeIntegracaoPage';
import RelatorioTaxasPage from './pages/RelatorioTaxasPage';
import ImportarPedidosPage from './pages/ImportarPedidosPage';
import ConferenciaPedidosPage from './pages/ConferenciaPedidosPage';
import EtiquetasPage from './pages/EtiquetasPage';
import FinanceiroPage from './pages/FinanceiroPage';
import TitulosPage from './pages/TitulosPage';
import ConciliacaoBancariaPage from './pages/ConciliacaoBancariaPage';
import FluxoCaixaPage from './pages/FluxoCaixaPage';
import DrePage from './pages/DrePage';
import ViagensListPage from './pages/ViagensListPage';
import ViagemDetailPage from './pages/ViagemDetailPage';
import AjudaPage from './pages/AjudaPage';

function RequireAuth({ loading, user, children }) {
  const location = useLocation();
  if (loading) return null;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

// Bloqueia navegação direta (por URL) a uma página fora dos módulos
// liberados pro usuário — sem isso a tela tentaria montar e chamar a API
// mesmo assim, e quebraria com um 403 sem tratamento.
function RequireModuloDaRota({ user, children }) {
  const location = useLocation();
  if (!canAccessPath(user, location.pathname)) {
    return <Navigate to={getDefaultPath(user) || '/login'} replace />;
  }
  return children;
}

function AppRoutes() {
  const { user, refreshUser } = useAuth();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, [refreshUser]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage onLoggedIn={refreshUser} />} />
      <Route path="/esqueci-senha" element={<EsqueciSenhaPage />} />
      <Route path="/redefinir-senha" element={<RedefinirSenhaPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth loading={loading} user={user}>
            <RequireModuloDaRota user={user}>
              <Shell>
                <Routes>
                  <Route path="/produtos" element={<ProdutosListPage />} />
                  <Route path="/produtos/:id" element={<ProdutoFichaPage />} />
                  <Route path="/importacao" element={<ImportacaoPage />} />
                  <Route path="/simulador" element={<SimuladorPage />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/ficha-precificacao" element={<FichaPrecificacaoPage />} />
                  <Route path="/alertas" element={<AlertasPage />} />
                  {/* Mix B2B × B2C (07/09/2026). Fica em Análises porque é
                      leitura sobre o faturamento que já existe — não cria
                      módulo novo nem mexe em permissão (REGRA 4). */}
                  <Route path="/analises/mix-tributario" element={<MixTributarioPage />} />
                  <Route path="/analises/preco-por-canal" element={<PrecoPorCanalPage />} />
                  <Route path="/estoque/parado" element={<EstoqueParadoPage />} />
                  <Route path="/estoque/curva-tamanho" element={<CurvaTamanhoPage />} />
                  <Route path="/kits" element={<KitsPage />} />
                  <Route path="/ficha-tecnica" element={<FichaTecnicaPage />} />
                  <Route path="/estoque" element={<EstoquePage />} />
                  <Route path="/estoque/bipagem" element={<BipagemPage />} />
                  <Route path="/estoque/importacao" element={<EstoqueImportacaoPage />} />
                  <Route path="/estoque/cobertura" element={<CoberturaEstoquePage />} />
                  {/* Produção ganhou módulo próprio em 08/09/2026 e saiu de
                      baixo de /estoque. O caminho antigo continua respondendo,
                      redirecionando: link salvo, favorito e aba aberta de quem
                      já usava a tela não podem quebrar por causa de uma
                      reorganização de menu. */}
                  <Route path="/producao" element={<ProducaoPage />} />
                  <Route path="/estoque/producao" element={<Navigate to="/producao" replace />} />
                  {/* Movimentação de produção (09/09/2026): a peça andando
                      entre etapas, a O.S. de facção que nasce disso e a carga
                      por etapa. Mesmo módulo `producao` das ordens — nenhuma
                      permissão nova. */}
                  <Route path="/producao/movimentacao" element={<MovimentacaoProducaoPage />} />
                  <Route path="/producao/ordens-servico" element={<OrdensServicoPage />} />
                  <Route path="/producao/carga" element={<CargaProducaoPage />} />
                  <Route path="/estoque/locais" element={<EstoqueLocaisPage />} />
                  {/* Reserva de estoque (09/09/2026): saldo × disponível.
                      Mesmo módulo `estoque` das demais telas de saldo —
                      nenhuma permissão nova (REGRA 4). */}
                  <Route path="/estoque/reserva" element={<ReservaEstoquePage />} />
                  <Route path="/estoque/ean" element={<EstoqueEanImportacaoPage />} />
                  <Route path="/estoque/ficha" element={<FichaEstoquePage />} />
                  <Route path="/clientes" element={<ClientesListPage />} />
                  <Route path="/clientes/:id" element={<ClienteFichaPage />} />
                  <Route path="/pedidos" element={<PedidosListPage origemFiltro="manual" />} />
                  <Route path="/pedidos/:id" element={<PedidoFormPage />} />
                  <Route path="/ficha-venda" element={<FichaVendaPage />} />
                  <Route path="/vendas/lucratividade" element={<RelatorioLucratividadePage origemFiltro="manual" />} />
                  <Route path="/marketplace/anuncios" element={<AnunciosPage />} />
                  <Route path="/marketplace/promocoes" element={<PromocoesPage />} />
                  <Route path="/marketplace/pedidos" element={<PedidosListPage origemFiltro="marketplace" />} />
                  <Route path="/marketplace/lucratividade" element={<RelatorioLucratividadePage origemFiltro="marketplace" />} />
                  <Route path="/marketplace/metricas" element={<MetricasMarketplacePage />} />
                  <Route path="/marketplace/taxas" element={<RelatorioTaxasPage />} />
                  <Route path="/marketplace/importar-pedidos" element={<ImportarPedidosPage />} />
                  <Route path="/marketplace/conferencia" element={<ConferenciaPedidosPage />} />
                  {/* Etiquetas (09/09/2026): ZPL -> PDF, lote da expedição e
                      lista de separação. Módulo Marketplace, igual ao backend. */}
                  <Route path="/marketplace/etiquetas" element={<EtiquetasPage />} />
                  {/* Saúde da Sincronização (07/09/2026). Fica no módulo
                      Marketplace — é ele que traz os pedidos cuja importação
                      pode falhar. Nenhuma permissão existente muda. */}
                  <Route path="/marketplace/saude" element={<SaudeIntegracaoPage />} />
                  {/* Módulo Financeiro: três rotas, um componente só — as três
                      abas leem a mesma base (o extrato do marketplace) e mudam
                      só a pergunta. Rota própria por aba pra cada uma poder ser
                      salva/compartilhada como link. */}
                  <Route path="/financeiro" element={<Navigate to="/financeiro/movimentacao" replace />} />
                  <Route path="/financeiro/movimentacao" element={<FinanceiroPage aba="movimentacao" />} />
                  <Route path="/financeiro/repasses" element={<FinanceiroPage aba="repasses" />} />
                  <Route path="/financeiro/conferencia" element={<FinanceiroPage aba="conferencia" />} />
                  {/* Núcleo financeiro (09/09/2026). Contas a pagar e a receber
                      são a MESMA tela: a mecânica é idêntica e o que muda é a
                      natureza, lida da própria rota — duas telas iguais
                      divergem no primeiro ajuste feito em só uma delas. */}
                  <Route path="/financeiro/pagar" element={<TitulosPage />} />
                  <Route path="/financeiro/receber" element={<TitulosPage />} />
                  <Route path="/financeiro/conciliacao-bancaria" element={<ConciliacaoBancariaPage />} />
                  <Route path="/financeiro/fluxo-caixa" element={<FluxoCaixaPage />} />
                  <Route path="/financeiro/dre" element={<DrePage />} />
                  <Route path="/viagens" element={<ViagensListPage />} />
                  <Route path="/viagens/:id" element={<ViagemDetailPage />} />
                  <Route path="/fornecedores" element={<FornecedoresListPage />} />
                  <Route path="/fornecedores/:id" element={<FornecedorFichaPage />} />
                  <Route path="/compras/relatorio" element={<RelatorioComprasPage />} />
                  <Route path="/compras/insumos" element={<InsumosPage />} />
                  {/* Cotação → Pedido → Recebimento (09/09/2026). Rotas estáticas
                      antes de /compras/:id de propósito: são o caminho completo da
                      compra, do preço perguntado à mercadoria conferida na doca. */}
                  <Route path="/compras/cotacoes" element={<CotacoesPage />} />
                  <Route path="/compras/pedidos" element={<PedidosCompraPage />} />
                  <Route path="/compras/recebimentos" element={<RecebimentosPage />} />
                  <Route path="/compras" element={<ComprasListPage />} />
                  <Route path="/compras/:id" element={<CompraFormPage />} />
                  <Route path="/configuracoes" element={<ConfiguracoesPage />} />
                  <Route path="/empresas" element={<EmpresasPage />} />
                  <Route path="/listas" element={<ListasPage />} />
                  <Route path="/custos-indiretos" element={<CustosIndiretosPage />} />
                  <Route path="/integracoes" element={<IntegracoesPage />} />
                  {/* Redesenho de Configurações (Etapa 2): 11 abas viraram 8 — as rotas
                      antigas continuam existindo e só redirecionam, pra não quebrar link
                      salvo/favoritado. Agrupamento é só apresentação (Shell.jsx e
                      lib/modules.js não mudam a lógica de permissão). */}
                  <Route path="/taxas" element={<TaxasPage />} />
                  <Route path="/taxas-venda" element={<Navigate to="/taxas" replace />} />
                  <Route path="/marketplace-taxas" element={<Navigate to="/taxas?aba=marketplace" replace />} />
                  <Route path="/acessos" element={<AcessosPage />} />
                  <Route path="/usuarios" element={<Navigate to="/acessos" replace />} />
                  <Route path="/configuracoes/grupos" element={<Navigate to="/acessos?aba=grupos" replace />} />
                  <Route path="/configuracoes/marketplace" element={<ProdutosMarketplacePage />} />
                  <Route path="/saude-dados" element={<SaudeDadosPage />} />
                  <Route path="/qualidade-dados" element={<Navigate to="/saude-dados" replace />} />
                  <Route path="/conferencia-dados" element={<Navigate to="/saude-dados" replace />} />
                  <Route path="/calendario" element={<CalendarioPage />} />
                  <Route path="/calendario/modelos" element={<TemplatesCalendarioPage />} />
                  <Route path="/calendario/eventos/:id/imprimir" element={<EventoImpressaoPage />} />
                  {/* Central de ajuda da Manu: não pertence a nenhum módulo de
                      propósito — liberada pra qualquer usuário autenticado (ver
                      a exceção em lib/modules.js#canAccessPath). */}
                  <Route path="/ajuda" element={<AjudaPage />} />
                  <Route path="*" element={<Navigate to={getDefaultPath(user) || '/produtos'} replace />} />
                </Routes>
              </Shell>
            </RequireModuloDaRota>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <DensidadeProvider>
        <AppRoutes />
        <ConfirmDialogRoot />
      </DensidadeProvider>
    </AuthProvider>
  );
}
