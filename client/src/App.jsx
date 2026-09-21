import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { DensidadeProvider } from './contexts/DensidadeContext';
import Shell from './components/Shell';
import { ConfirmDialogRoot } from './components/ConfirmDialog';
import { MotivoDialogRoot } from './components/MotivoDialog';
import { canAccessPath, getDefaultPath } from './lib/modules';
import { instalarCliqueDoMeio } from './lib/novaAba';
import LoginPage from './pages/LoginPage';

// ---------------------------------------------------------------------------
// Carregamento por rota (14/09/2026).
//
// O pacote de JavaScript era UM arquivo de 2,88 MB (766 KB comprimidos), com
// as 86 telas do sistema dentro dele — tudo baixado antes da primeira tela
// aparecer. Isso é o que a pessoa da expedição espera no 4G do galpão para
// abrir a Bipagem, e é banda do Render em cada visita nova (a conta que já
// derrubou o plano uma vez).
//
// Com `lazy`, cada tela vira um pedaço próprio e só desce quando alguém abre
// aquela rota. A tela de login continua estática de propósito: ela é a
// primeira coisa que carrega, e não faria sentido pedir um segundo arquivo
// para mostrar um formulário de duas linhas.
//
// `Suspense` com um fallback vazio, e não um spinner: as telas já trazem os
// próprios esqueletos de carregamento, e um spinner de meio segundo entre a
// casca e o esqueleto pisca mais do que informa.
// ---------------------------------------------------------------------------
const ConfiguracoesPage = lazy(() => import('./pages/ConfiguracoesPage'));
const EmpresasPage = lazy(() => import('./pages/EmpresasPage'));
const ListasPage = lazy(() => import('./pages/ListasPage'));
const CustosIndiretosPage = lazy(() => import('./pages/CustosIndiretosPage'));
const IntegracoesPage = lazy(() => import('./pages/IntegracoesPage'));
const TaxasPage = lazy(() => import('./pages/TaxasPage'));
const AcessosPage = lazy(() => import('./pages/AcessosPage'));
const SaudeDadosPage = lazy(() => import('./pages/SaudeDadosPage'));
const ProdutosMarketplacePage = lazy(() => import('./pages/ProdutosMarketplacePage'));
const CalendarioPage = lazy(() => import('./pages/CalendarioPage'));
const TemplatesCalendarioPage = lazy(() => import('./pages/TemplatesCalendarioPage'));
const EventoImpressaoPage = lazy(() => import('./pages/EventoImpressaoPage'));
const ProdutosListPage = lazy(() => import('./pages/ProdutosListPage'));
const ProdutoFichaPage = lazy(() => import('./pages/ProdutoFichaPage'));
const ImportacaoPage = lazy(() => import('./pages/ImportacaoPage'));
const ImportacaoMassaPage = lazy(() => import('./pages/ImportacaoMassaPage'));
const SimuladorPage = lazy(() => import('./pages/SimuladorPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const FichaPrecificacaoPage = lazy(() => import('./pages/FichaPrecificacaoPage'));
const AlertasPage = lazy(() => import('./pages/AlertasPage'));
const KitsPage = lazy(() => import('./pages/KitsPage'));
const FichaTecnicaPage = lazy(() => import('./pages/FichaTecnicaPage'));
const FichaVendaPage = lazy(() => import('./pages/FichaVendaPage'));
const EstoquePage = lazy(() => import('./pages/EstoquePage'));
const BipagemPage = lazy(() => import('./pages/BipagemPage'));
const EstoqueImportacaoPage = lazy(() => import('./pages/EstoqueImportacaoPage'));
const EstoqueEanImportacaoPage = lazy(() => import('./pages/EstoqueEanImportacaoPage'));
const FichaEstoquePage = lazy(() => import('./pages/FichaEstoquePage'));
const ClientesListPage = lazy(() => import('./pages/ClientesListPage'));
const ClienteFichaPage = lazy(() => import('./pages/ClienteFichaPage'));
const PedidosListPage = lazy(() => import('./pages/PedidosListPage'));
const PedidosVendaListPage = lazy(() => import('./pages/PedidosVendaListPage'));
const PedidoFormPage = lazy(() => import('./pages/PedidoFormPage'));
const MetricasVendasPage = lazy(() => import('./pages/MetricasVendasPage'));
const LucratividadeVendasPage = lazy(() => import('./pages/LucratividadeVendasPage'));
const DespesasVendasPage = lazy(() => import('./pages/DespesasVendasPage'));
const VendedoresPage = lazy(() => import('./pages/VendedoresPage'));
const TabelasPrecoPage = lazy(() => import('./pages/TabelasPrecoPage'));
const FornecedoresListPage = lazy(() => import('./pages/FornecedoresListPage'));
const FornecedorFichaPage = lazy(() => import('./pages/FornecedorFichaPage'));
const ComprasListPage = lazy(() => import('./pages/ComprasListPage'));
const CompraFormPage = lazy(() => import('./pages/CompraFormPage'));
const RelatorioComprasPage = lazy(() => import('./pages/RelatorioComprasPage'));
const CotacoesPage = lazy(() => import('./pages/CotacoesPage'));
const PedidosCompraPage = lazy(() => import('./pages/PedidosCompraPage'));
const RecebimentosPage = lazy(() => import('./pages/RecebimentosPage'));
const RelatorioLucratividadePage = lazy(() => import('./pages/RelatorioLucratividadePage'));
const MetricasMarketplacePage = lazy(() => import('./pages/MetricasMarketplacePage'));
const AnunciosPage = lazy(() => import('./pages/AnunciosPage'));
const CoberturaEstoquePage = lazy(() => import('./pages/CoberturaEstoquePage'));
const ProducaoPage = lazy(() => import('./pages/ProducaoPage'));
const MovimentacaoProducaoPage = lazy(() => import('./pages/MovimentacaoProducaoPage'));
const OrdensServicoPage = lazy(() => import('./pages/OrdensServicoPage'));
const CargaProducaoPage = lazy(() => import('./pages/CargaProducaoPage'));
const ProjecaoEstoquePage = lazy(() => import('./pages/ProjecaoEstoquePage'));
const MateriaPrimaPage = lazy(() => import('./pages/MateriaPrimaPage'));
const PlanejamentoPage = lazy(() => import('./pages/PlanejamentoPage'));
const PisoPrecoPage = lazy(() => import('./pages/PisoPrecoPage'));
const PosVendaPage = lazy(() => import('./pages/PosVendaPage'));
const InsumosPage = lazy(() => import('./pages/InsumosPage'));
const PromocoesPage = lazy(() => import('./pages/PromocoesPage'));
const FullPage = lazy(() => import('./pages/FullPage'));
const MixTributarioPage = lazy(() => import('./pages/MixTributarioPage'));
const EstoqueParadoPage = lazy(() => import('./pages/EstoqueParadoPage'));
const EstoqueLocaisPage = lazy(() => import('./pages/EstoqueLocaisPage'));
const ReservaEstoquePage = lazy(() => import('./pages/ReservaEstoquePage'));
const DepositosPage = lazy(() => import('./pages/DepositosPage'));
const CurvaTamanhoPage = lazy(() => import('./pages/CurvaTamanhoPage'));
const PrecoPorCanalPage = lazy(() => import('./pages/PrecoPorCanalPage'));
const SaudeIntegracaoPage = lazy(() => import('./pages/SaudeIntegracaoPage'));
const RelatorioTaxasPage = lazy(() => import('./pages/RelatorioTaxasPage'));
const ImportarPedidosPage = lazy(() => import('./pages/ImportarPedidosPage'));
const ConferenciaPedidosPage = lazy(() => import('./pages/ConferenciaPedidosPage'));
const EtiquetasPage = lazy(() => import('./pages/EtiquetasPage'));
const RomaneioPage = lazy(() => import('./pages/RomaneioPage'));
const FinanceiroPage = lazy(() => import('./pages/FinanceiroPage'));
const TitulosPage = lazy(() => import('./pages/TitulosPage'));
const ConciliacaoBancariaPage = lazy(() => import('./pages/ConciliacaoBancariaPage'));
const ContasBancariasPage = lazy(() => import('./pages/ContasBancariasPage'));
const FluxoCaixaPage = lazy(() => import('./pages/FluxoCaixaPage'));
const DrePage = lazy(() => import('./pages/DrePage'));
const CaixaEntradaFinanceiroPage = lazy(() => import('./pages/CaixaEntradaFinanceiroPage'));
const CoberturaFinanceiraPage = lazy(() => import('./pages/CoberturaFinanceiraPage'));
const ViagensListPage = lazy(() => import('./pages/ViagensListPage'));
const ViagemDetailPage = lazy(() => import('./pages/ViagemDetailPage'));
const AjudaPage = lazy(() => import('./pages/AjudaPage'));

import EsqueciSenhaPage from './pages/EsqueciSenhaPage';
import RedefinirSenhaPage from './pages/RedefinirSenhaPage';
// Repaginação do módulo Vendas (09/09/2026).

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

  // Clique do meio do mouse (scroll pressionado) abre em nova aba — vale para
  // linha de tabela e cartão clicável em todos os módulos. Ver lib/novaAba.js.
  useEffect(() => instalarCliqueDoMeio(), []);

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
                {/* O fallback é vazio de propósito — ver a nota sobre `lazy`
                    no topo do arquivo. */}
                <Suspense fallback={null}>
                <Routes>
                  <Route path="/produtos" element={<ProdutosListPage />} />
                  <Route path="/produtos/:id" element={<ProdutoFichaPage />} />
                  <Route path="/importacao" element={<ImportacaoPage />} />
                  <Route path="/importacao-massa" element={<ImportacaoMassaPage />} />
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
                  <Route path="/producao/projecao" element={<ProjecaoEstoquePage />} />
                  {/* Materia-prima (11/09/2026): estoque minimo de TECIDO por
                      referencia e por cor, no formato da planilha da casa.
                      Depois da Projecao porque le' o mesmo "em producao" dela e
                      responde a pergunta seguinte: da' para produzir isso? */}
                  <Route path="/producao/materia-prima" element={<MateriaPrimaPage />} />
                  <Route path="/producao/planejamento" element={<PlanejamentoPage />} />
                  <Route path="/marketplace/piso" element={<PisoPrecoPage />} />
                  <Route path="/marketplace/pos-venda" element={<PosVendaPage />} />
                  <Route path="/estoque/locais" element={<EstoqueLocaisPage />} />
                  {/* Reserva de estoque (09/09/2026): saldo × disponível.
                      Mesmo módulo `estoque` das demais telas de saldo —
                      nenhuma permissão nova (REGRA 4). */}
                  <Route path="/estoque/reserva" element={<ReservaEstoquePage />} />
                  <Route path="/estoque/depositos" element={<DepositosPage />} />
                  <Route path="/estoque/ean" element={<EstoqueEanImportacaoPage />} />
                  <Route path="/estoque/ficha" element={<FichaEstoquePage />} />
                  <Route path="/clientes" element={<ClientesListPage />} />
                  <Route path="/clientes/:id" element={<ClienteFichaPage />} />
                  {/* Módulo Vendas repaginado (09/09/2026). A lista de venda
                      direta ganhou tela própria: PedidosListPage continua
                      servindo o Marketplace, cujas colunas e filtros são
                      outros. A ficha do pedido (/pedidos/:id) continua sendo a
                      mesma para os dois — pedido de marketplace abre lá em
                      modo leitura, como antes. */}
                  <Route path="/pedidos" element={<PedidosVendaListPage />} />
                  <Route path="/pedidos/:id" element={<PedidoFormPage />} />
                  <Route path="/ficha-venda" element={<FichaVendaPage />} />
                  <Route path="/vendas/metricas" element={<MetricasVendasPage />} />
                  <Route path="/vendas/lucratividade" element={<LucratividadeVendasPage />} />
                  <Route path="/vendas/despesas" element={<DespesasVendasPage />} />
                  {/* /vendas/lucratividade agora abre a tela NOVA — é a mesma
                      pergunta, respondida melhor, então quem tinha o link
                      salvo continua chegando ao lugar certo. A versão antiga
                      (o componente compartilhado com o Marketplace) fica no
                      caminho abaixo, para conferência lado a lado no primeiro
                      mês. */}
                  <Route path="/vendas/lucratividade-classica" element={<RelatorioLucratividadePage origemFiltro="manual" />} />
                  <Route path="/marketplace/anuncios" element={<AnunciosPage />} />
                  <Route path="/marketplace/promocoes" element={<PromocoesPage />} />
                  <Route path="/marketplace/full" element={<FullPage />} />
                  <Route path="/marketplace/pedidos" element={<PedidosListPage origemFiltro="marketplace" />} />
                  <Route path="/marketplace/lucratividade" element={<RelatorioLucratividadePage origemFiltro="marketplace" />} />
                  <Route path="/marketplace/metricas" element={<MetricasMarketplacePage />} />
                  <Route path="/marketplace/taxas" element={<RelatorioTaxasPage />} />
                  <Route path="/marketplace/importar-pedidos" element={<ImportarPedidosPage />} />
                  <Route path="/marketplace/conferencia" element={<ConferenciaPedidosPage />} />
                  {/* Etiquetas (09/09/2026): ZPL -> PDF, lote da expedição e
                      lista de separação. Módulo Marketplace, igual ao backend. */}
                  <Route path="/marketplace/etiquetas" element={<EtiquetasPage />} />
                  {/* Romaneio (09/09/2026): o passo seguinte à etiqueta. */}
                  <Route path="/marketplace/romaneio" element={<RomaneioPage />} />
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
                  <Route path="/financeiro/contas-bancarias" element={<ContasBancariasPage />} />
                  <Route path="/financeiro/conciliacao-bancaria" element={<ConciliacaoBancariaPage />} />
                  <Route path="/financeiro/fluxo-caixa" element={<FluxoCaixaPage />} />
                  <Route path="/financeiro/dre" element={<DrePage />} />
                  {/* A ponte com os módulos (09/09/2026). A Caixa de Entrada é
                      o que a operação comprometeu e o financeiro ainda não
                      registrou; a Cobertura é a varredura que prova que nada
                      passou por fora. Mesma chave `financeiro`. */}
                  <Route path="/financeiro/entradas" element={<CaixaEntradaFinanceiroPage />} />
                  <Route path="/financeiro/cobertura" element={<CoberturaFinanceiraPage />} />
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
                  {/* Vendedores e tabelas de preço vivem em Configurações
                      porque é lá que a comissão e o preço são DEFINIDOS. A
                      mesma tela de vendedores aparece como sub-aba de Acessos
                      (mesmo componente, ver AcessosPage.jsx). */}
                  <Route path="/configuracoes/vendedores" element={<VendedoresPage />} />
                  <Route path="/configuracoes/tabelas-preco" element={<TabelasPrecoPage />} />
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
                </Suspense>
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
        <MotivoDialogRoot />
      </DensidadeProvider>
    </AuthProvider>
  );
}
