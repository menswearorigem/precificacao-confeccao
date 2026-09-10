import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, UsersRound, History, BadgePercent } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import UsuariosPage from './UsuariosPage';
import GruposPage from './GruposPage';
import HistoricoPage from './HistoricoPage';
import VendedoresPage from './VendedoresPage';

// Página fundida (Etapa 2): "Usuários" e "Grupos" viravam 2 abas separadas
// — agora são sub-abas de "Acessos". Conteúdo de cada uma inalterado.
//
// ATENÇÃO (não é só apresentação, é uma diferença de permissão real que a
// fusão escancarou): a API de /usuarios exige admin (requireAdmin, sem
// meio-termo), mas /grupos só exige o módulo "configuracoes" (qualquer
// usuário com acesso a Configurações podia gerenciar Grupos antes da fusão,
// mesmo sem ser admin). Colocar as duas sob UM flag adminOnly em
// modules.js perderia esse acesso de quem não é admin. Por isso a aba
// "Acessos" em si NÃO é adminOnly (ver modules.js) — quem não é admin
// enxerga só a sub-aba Grupos aqui dentro, exatamente como antes da fusão.
const SUBABAS_ADMIN = [
  { chave: 'usuarios', label: 'Usuários', Icone: ShieldCheck },
  { chave: 'grupos', label: 'Grupos', Icone: UsersRound },
  // Vendedores (09/09/2026). É a MESMA tela de Configurações › Vendedores,
  // o mesmo componente — aparece aqui porque quem administra os usuários já
  // está nesta tela quando pensa "essa pessoa também vai vender". Nenhuma
  // permissão nova: a rota de escrita continua exigindo `configuracoes`,
  // e quem não tem só enxerga (o backend recusa a gravação).
  { chave: 'vendedores', label: 'Vendedores', Icone: BadgePercent },
  // Histórico é só de administrador: mostra IP, tentativa de login que falhou
  // e o que cada pessoa alterou. Fica aqui, ao lado de Usuários, porque é a
  // mesma pergunta vista pelos dois lados — "quem tem acesso" e "o que essa
  // pessoa fez com o acesso que tem".
  { chave: 'historico', label: 'Histórico', Icone: History },
];
const SUBABAS_LIMITADO = [
  { chave: 'grupos', label: 'Grupos', Icone: UsersRound },
];

export default function AcessosPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const subabas = isAdmin ? SUBABAS_ADMIN : SUBABAS_LIMITADO;
  const [searchParams, setSearchParams] = useSearchParams();
  const abaUrl = searchParams.get('aba');
  const abaPedida = ['grupos', 'historico', 'vendedores'].includes(abaUrl) ? abaUrl : 'usuarios';
  const inicial = isAdmin ? abaPedida : 'grupos';
  const [aba, setAba] = useState(inicial);

  function trocarAba(chave) {
    setAba(chave);
    setSearchParams(chave === 'usuarios' ? {} : { aba: chave }, { replace: true });
  }

  return (
    <div className="page-wide">
      <h1>Acessos</h1>
      {subabas.length > 1 && (
        <div className="subtab-row">
          {subabas.map((s) => (
            <button
              key={s.chave}
              type="button"
              className={'subtab-btn' + (aba === s.chave ? ' active' : '')}
              onClick={() => trocarAba(s.chave)}
            >
              <s.Icone size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
              {s.label}
            </button>
          ))}
        </div>
      )}

      {!isAdmin ? <GruposPage />
        : aba === 'grupos' ? <GruposPage />
          : aba === 'historico' ? <HistoricoPage />
            : aba === 'vendedores' ? <VendedoresPage embutido />
              : <UsuariosPage />}
    </div>
  );
}
