import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { brl } from '../lib/format';

// O selo financeiro de um documento.
//
// A ligação entre módulo e financeiro precisa ser visível dos DOIS lados: do
// financeiro dá para chegar ao documento (a tela de Cobertura tem o link), e
// do documento precisa dar para ver o dinheiro. Sem isso, quem opera continua
// sem saber se o compromisso que ele criou chegou a algum lugar — que é
// exatamente a queixa que originou a ponte.
//
// Uma chamada para a lista inteira, nunca uma por linha: uma requisição por
// linha transformaria a tela num carrossel de chamadas e a lista de O.S.
// costuma ter dezenas.

const ESTADOS = {
  bloqueado: { rotulo: 'trava o fechamento', tom: 'tone-prejuizo', titulo: 'O compromisso está na Caixa de Entrada do Financeiro e impede o fechamento do documento de origem.' },
  pendente: { rotulo: 'na caixa de entrada', tom: 'tone-atencao', titulo: 'O financeiro foi avisado e ainda não transformou este compromisso em título.' },
  previsto: { rotulo: 'previsto', tom: 'tone-neutro', titulo: 'Já está no fluxo de caixa como previsão. Vira título firme quando o fato se confirmar.' },
  no_financeiro: { rotulo: 'no financeiro', tom: 'tone-saudavel', titulo: 'Já virou título. O dinheiro deste documento está no fluxo de caixa e no DRE.' },
  sem_compromisso: { rotulo: 'sem valor', tom: 'tone-neutro', titulo: 'Este documento ainda não gerou compromisso de dinheiro — ou porque não tem valor apurado, ou porque ainda não chegou ao ponto que o gera.' },
};

// Busca o estado de vários documentos de uma vez. Devolve um mapa id -> estado.
export function useSelosFinanceiros(origemCodigo, ids) {
  const [mapa, setMapa] = useState({});
  const chave = ids.join(',');
  useEffect(() => {
    if (!chave) { setMapa({}); return; }
    api.get(`/financeiro-ponte/documentos/${origemCodigo}?ids=${chave}`)
      // Falhar aqui NÃO pode quebrar a tela do módulo: quem não tem o módulo
      // financeiro recebe 403, e a tela continua sendo a tela de produção.
      .then((r) => setMapa(r && typeof r === 'object' ? r : {}))
      .catch(() => setMapa({}));
  }, [origemCodigo, chave]);
  return mapa;
}

export default function SeloFinanceiro({ info }) {
  if (!info) return <span className="mono">—</span>;
  const e = ESTADOS[info.estado] || ESTADOS.sem_compromisso;
  const alvo = info.estado === 'no_financeiro' || info.estado === 'previsto'
    ? '/financeiro/pagar'
    : '/financeiro/entradas';

  const conteudo = (
    <span className={`stamp sm ${e.tom}`} title={e.titulo}>
      {e.rotulo}
      {info.valor != null && ` · ${brl(info.valor)}`}
    </span>
  );

  if (info.estado === 'sem_compromisso') return conteudo;
  return <Link to={alvo} onClick={(ev) => ev.stopPropagation()}>{conteudo}</Link>;
}
