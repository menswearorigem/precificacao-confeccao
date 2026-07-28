import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api/client';
import Shell from './components/Shell';
import LoginPage from './pages/LoginPage';
import ConfiguracoesPage from './pages/ConfiguracoesPage';
import EmpresasPage from './pages/EmpresasPage';
import ListasPage from './pages/ListasPage';
import TaxasVendaPage from './pages/TaxasVendaPage';
import CustosIndiretosPage from './pages/CustosIndiretosPage';
import EmConstrucaoPage from './pages/EmConstrucaoPage';
import ProdutosListPage from './pages/ProdutosListPage';
import ProdutoFichaPage from './pages/ProdutoFichaPage';
import ImportacaoPage from './pages/ImportacaoPage';

function RequireAuth({ authed, children }) {
  const location = useLocation();
  if (authed === null) return null;
  if (!authed) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

export default function App() {
  const [authed, setAuthed] = useState(null);

  useEffect(() => {
    api
      .get('/auth/me')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage onLoggedIn={() => setAuthed(true)} />} />
      <Route
        path="/*"
        element={
          <RequireAuth authed={authed}>
            <Shell>
              <Routes>
                <Route path="/produtos" element={<ProdutosListPage />} />
                <Route path="/produtos/:id" element={<ProdutoFichaPage />} />
                <Route path="/importacao" element={<ImportacaoPage />} />
                <Route path="/simulador" element={<EmConstrucaoPage titulo="Simulador de Cenários" />} />
                <Route path="/dashboard" element={<EmConstrucaoPage titulo="Dashboard Executivo" />} />
                <Route path="/kits" element={<EmConstrucaoPage titulo="Kits" />} />
                <Route path="/ficha-tecnica" element={<EmConstrucaoPage titulo="Ficha Técnica" />} />
                <Route path="/configuracoes" element={<ConfiguracoesPage />} />
                <Route path="/empresas" element={<EmpresasPage />} />
                <Route path="/listas" element={<ListasPage />} />
                <Route path="/taxas-venda" element={<TaxasVendaPage />} />
                <Route path="/custos-indiretos" element={<CustosIndiretosPage />} />
                <Route path="*" element={<Navigate to="/produtos" replace />} />
              </Routes>
            </Shell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
