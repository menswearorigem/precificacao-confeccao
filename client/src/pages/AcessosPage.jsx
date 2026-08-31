import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, UsersRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import UsuariosPage from './UsuariosPage';
import GruposPage from './GruposPage';

// Página fundida (Etapa 2): "Usuários" e "Grupos" viravam 2 abas separadas
// — agora são sub-abas de "Acessos". Conteúdo de cada uma inalterado.
//
// ATENÇÃO (não é só apresentação, é uma diferença de permissão real que a
// fusão escancarou): a API de /usuarios exige admin (requireAdmin, sem
// meio-termo), mas /grupos só exige o módulo "configuracoes" (qualquer
// usuária com acesso a Configurações podia gerenciar Grupos antes da fusão,
// mesmo sem ser admin). Colocar as duas sob UM flag adminOnly em
// modules.js perderia esse acesso de quem não é admin. Por isso a aba
// "Acessos" em si NÃO é adminOnly (ver modules.js) — quem não é admin
// enxerga só a sub-aba Grupos aqui dentro, exatamente como antes da fusão.
const SUBABAS_ADMIN = [
  { chave: 'usuarios', label: 'Usuários', Icone: ShieldCheck },
  { chave: 'grupos', label: 'Grupos', Icone: UsersRound },
];
const SUBABAS_LIMITADO = [
  { chave: 'grupos', label: 'Grupos', Icone: UsersRound },
];

export default function AcessosPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const subabas = isAdmin ? SUBABAS_ADMIN : SUBABAS_LIMITADO;
  const [searchParams, setSearchParams] = useSearchParams();
  const abaPedida = searchParams.get('aba') === 'grupos' ? 'grupos' : 'usuarios';
  const inicial = isAdmin ? abaPedida : 'grupos';
  const [aba, setAba] = useState(inicial);

  function trocarAba(chave) {
    setAba(chave);
    setSearchParams(chave === 'usuarios' ? {} : { aba: chave }, { replace: true });
  }

  return (
    <div className="page-wide">
      <h2>Acessos</h2>
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

      {aba === 'usuarios' && isAdmin ? <UsuariosPage /> : <GruposPage />}
    </div>
  );
}
