import { useLocation } from 'react-router-dom';
import { moduloDaRota } from '../modules';

// A "roupa" da Manu por módulo (13/10/2026). É SÓ COSMÉTICO: muda o nome que
// aparece na tela e a foto. Não mexe em nada do que ela responde, calcula ou
// busca — o motor (lib/manu/analista.js, lib/manu/conversa.js, /api/manu)
// continua exatamente igual em qualquer tela.
//
// Fotos: client/public/manu/<slug>.png — mesma Manu de /manu.png, mesma
// pose e enquadramento, só a roupa trocada. Enquanto a foto de um módulo não
// existir, o avatar cai sozinho para /manu.png (ver AvatarManu).
//
// Módulo de vídeos: quando ele for criado com key 'videos', a Manu
// Influenciadora já entra sozinha — nada a mudar aqui.

export const PERSONA_PADRAO = { nome: 'Manu', papel: null, foto: '/manu.png' };

const PERSONAS = {
  produto:       { papel: 'Estilista',     slug: 'estilista' },
  estoque:       { papel: 'Estoquista',    slug: 'estoquista' },
  producao:      { papel: 'Costureira',    slug: 'costureira' },
  vendas:        { papel: 'Vendedora',     slug: 'vendedora' },
  marketplace:   { papel: 'Analista',      slug: 'analista' },
  financeiro:    { papel: 'Contadora',     slug: 'contadora' },
  viagens:       { papel: 'Representante', slug: 'representante' },
  compras:       { papel: 'Compradora',    slug: 'compradora' },
  analises:      { papel: 'Estrategista',  slug: 'estrategista' },
  calendario:    { papel: 'Secretária',    slug: 'secretaria' },
  configuracoes: { papel: 'Técnica',       slug: 'tecnica' },
  videos:        { papel: 'Influenciadora', slug: 'influenciadora' },
};

export function personaDaRota(pathname) {
  // Início e a central de ajuda não são de módulo nenhum: Manu "de casa".
  if (!pathname || pathname.startsWith('/ajuda') || pathname.startsWith('/inicio')) return PERSONA_PADRAO;
  const mod = moduloDaRota(pathname);
  const p = mod && PERSONAS[mod.key];
  if (!p) return PERSONA_PADRAO;
  return { nome: `Manu ${p.papel}`, papel: p.papel, foto: `/manu/${p.slug}.png` };
}

export function usePersonaManu() {
  const { pathname } = useLocation();
  return personaDaRota(pathname);
}
