import { api } from '../api/client';
import { confirmar } from '../components/ConfirmDialog';

// Pausar, arquivar e excluir (22/10/2026) — a mesma pergunta e o mesmo
// recado na lista de Modelos e dentro do modelo. Devolvem a frase do aviso,
// ou null quando a pessoa desistiu.

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

export async function mudarStatusModelo(id, titulo, status) {
  if (status === 'pausado' && !(await confirmar(
    `Pausar "${titulo}"? As tarefas dela que ainda não foram feitas saem da tela da equipe agora, e ela para de gerar novas. O que já foi feito continua no histórico. Para voltar, é só ativar.`,
    { titulo: 'Pausar', confirmarTexto: 'Pausar', perigo: false }
  ))) return null;
  if (status === 'arquivado' && !(await confirmar(
    `Arquivar "${titulo}"? Sai da tela da equipe agora e para de gerar tarefas. O histórico continua na Equipe.`,
    { titulo: 'Arquivar', confirmarTexto: 'Arquivar' }
  ))) return null;
  const r = await api.post(`/rotinas/modelos/${id}/status`, { status });
  if (status === 'ativo') return `"${titulo}" ativada — a de hoje aparece de novo no Meu dia de quem faz.`;
  const verbo = status === 'pausado' ? 'pausada' : 'arquivada';
  return `"${titulo}" ${verbo}.${r.removidas ? ` ${plural(r.removidas, 'tarefa em aberto saiu', 'tarefas em aberto saíram')} da tela da equipe.` : ''}`;
}

export async function excluirModelo(id, titulo) {
  const imp = await api.get(`/rotinas/modelos/${id}/impacto`).catch(() => null);
  const partes = [];
  if (imp?.abertas) partes.push(plural(imp.abertas, 'tarefa em aberto', 'tarefas em aberto'));
  if (imp?.historico) partes.push(`o histórico de ${plural(imp.historico, 'tarefa feita', 'tarefas feitas')} (com respostas e fotos)`);
  const oQue = partes.length ? ` Vai junto: ${partes.join(' e ')}.` : '';
  if (!(await confirmar(
    `Excluir "${titulo}" de vez? Some da tela de todo mundo e não dá para desfazer.${oQue} Se quiser só parar por um tempo, use Pausar.`,
    { titulo: 'Excluir de vez', confirmarTexto: 'Excluir de vez' }
  ))) return null;
  await api.del(`/rotinas/modelos/${id}`);
  return `"${titulo}" excluída.`;
}

export async function excluirTarefa(item) {
  if (!(await confirmar(
    `Excluir esta tarefa${item.horario ? ` das ${item.horario}` : ''} de ${item.responsavelNome || 'equipe'}? Ela sai da tela de todo mundo, com o que já foi respondido. A rotina continua — as próximas nascem normalmente.`,
    { titulo: 'Excluir tarefa', confirmarTexto: 'Excluir' }
  ))) return false;
  await api.del(`/rotinas/ocorrencias/${item.id}`);
  return true;
}
