import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Shell from './components/Shell';
import { canAccessPath, getDefaultPath } from './lib/modules';
import LoginPage from './pages/LoginPage';
import ConfiguracoesPage from './pages/ConfiguracoesPage';
import EmpresasPage from './pages/EmpresasPage';
import ListasPage from './pages/ListasPage';
import TaxasVendaPage from './pages/TaxasVendaPage';
import CustosIndiretosPage from './pages/CustosIndiretosPage';
import UsuariosPage from './pages/UsuariosPage';
import IntegracoesPage from './pages/IntegracoesPage';
import ProdutosListPage from './pages/ProdutosListPage';
import ProdutoFichaPage from './pages/ProdutoFichaPage';
import ImportacaoPage from './pages/ImportacaoPage';
import SimuladorPage from './pages/SimuladorPage';
import DashboardPage from './pages/DashboardPage';
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
                  <Route path="/kits" element={<KitsPage />} />
                  <Route path="/ficha-tecnica" element={<FichaTecnicaPage />} />
                  <Route path="/estoque" element={<EstoquePage />} />
                  <Route path="/estoque/bipagem" element={<BipagemPage />} />
                  <Route path="/estoque/importacao" element={<EstoqueImportacaoPage />} />
                  <Route path="/estoque/ean" element={<EstoqueEanImportacaoPage />} />
                  <Route path="/estoque/ficha" element={<FichaEstoquePage />} />
                  <Route path="/clientes" element={<ClientesListPage />} />
                  <Route path="/clientes/:id" element={<ClienteFichaPage />} />
                  <Route path="/pedidos" element={<PedidosListPage />} />
                  <Route path="/pedidos/:id" element={<PedidoFormPage />} />
                  <Route path="/ficha-venda" element={<FichaVendaPage />} />
                  <Route path="/fornecedores" element={<FornecedoresListPage />} />
                  <Route path="/fornecedores/:id" element={<FornecedorFichaPage />} />
                  <Route path="/compras/relatorio" element={<RelatorioComprasPage />} />
                  <Route path="/compras" element={<ComprasListPage />} />
                  <Route path="/compras/:id" element={<CompraFormPage />} />
                  <Route path="/configuracoes" element={<ConfiguracoesPage />} />
                  <Route path="/empresas" element={<EmpresasPage />} />
                  <Route path="/listas" element={<ListasPage />} />
                  <Route path="/taxas-venda" element={<TaxasVendaPage />} />
                  <Route path="/custos-indiretos" element={<CustosIndiretosPage />} />
                  <Route path="/usuarios" element={<UsuariosPage />} />
                  <Route path="/integracoes" element={<IntegracoesPage />} />
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
      <AppRoutes />
    </AuthProvider>
  );
}
