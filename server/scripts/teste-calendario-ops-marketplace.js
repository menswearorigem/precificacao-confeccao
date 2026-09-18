/*
 * OPs de produto de MARKETPLACE no calendário (16/09/2026).
 *
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-calendario-ops-marketplace.js
 *
 * Pedido: "toda vez que uma OP dos produtos de marketplace for alimentada no
 * sistema, entra no calendário com todos os dados; se for atualizada, atualiza
 * (prazos, grade, cores, estado); se for concluída, conclui no calendário".
 *
 * Cobre:
 *   1. OP do Wik entrando pelo grid (com prazo em dd/mm/aaaa e /Date()/) vira
 *      evento — e OP de produto que NÃO é de marketplace não vira.
 *   2. Grade lida do Wik (tier 2) leva cores, tamanhos e totais ao evento.
 *   3. Mudança de prazo e de estado atualiza o evento; conclusão conclui.
 *   4. Passada sem mudança não grava nada (atualizado_em do evento parado).
 *   5. Campos da pessoa (descrição, anotações) sobrevivem; campos da OP não
 *      podem ser editados pelo calendário.
 *   6. Quem tem o módulo produção enxerga o evento da OP; quem só tem
 *      calendário, não. "Meus eventos" não mistura OP.
 *   7. Duplicar evento de OP gera evento comum, sem dados da OP.
 */

require('dotenv').config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'liberacao-de-teste-123';

const createApp = require('../src/app');
const pool = require('../src/db/pool');
const cal = require('../src/lib/producaoCalendario');
const wik = require('../src/lib/wikProducaoSync');

let passou = 0;
let falhou = 0;
const falhas = [];
function ok(titulo, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✓ ${titulo}`); }
  else { falhou += 1; falhas.push(titulo); console.log(`  ✗ ${titulo}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function secao(n) { console.log(`\n${n}`); }
const SENHA = 'trigo azul de setembro';

async function evento(ordemId) {
  const { rows } = await pool.query('SELECT * FROM calendario_eventos WHERE ordem_producao_id = $1', [ordemId]);
  return rows[0] || null;
}
async function ordemPorWik(op) {
  const { rows } = await pool.query("SELECT * FROM ordens_producao WHERE origem='wik' AND wik_op=$1", [op]);
  return rows[0] || null;
}
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

async function main() {
  const app = createApp();
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  function novaSessao() {
    const estado = { cookie: '' };
    return async (caminho, { metodo = 'GET', corpo } = {}) => {
      const headers = { 'Content-Type': 'application/json', Origin: base };
      if (estado.cookie) headers.Cookie = estado.cookie;
      const res = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
      const set = res.headers.get('set-cookie');
      if (set) estado.cookie = set.split(';')[0];
      let dados = null; try { dados = await res.json(); } catch { /* */ }
      return { status: res.status, dados };
    };
  }
  const admin = novaSessao();
  const producao = novaSessao();
  const soCalendario = novaSessao();

  try {
    await pool.query(`INSERT INTO produtos (referencia, descricao, marca, marketplace) VALUES
      ('OG100', 'Camiseta Dryfit', 'Origem', TRUE),
      ('HB200', 'Calça Social', 'Hebron', FALSE)`);

    secao('1. OP do Wik entra pelo grid');
    const r1 = await wik._upsertOpsDoGrid([
      { OprId: 7045, ProdDescricao: 'OG100 - Camiseta Dryfit', Situacao: '0 - Aguardando Início',
        OprQtdPecas: 300, OprQtdRealizada: 0, OprQtdLd: 0, OprDatacad: '/Date(1788912000000)/',
        OprDtPrevFim: '30/09/2026', OprDtPrevInicio: '18/09/2026', OprDescricao: 'Lote setembro' },
      { OprId: 7046, ProdDescricao: 'HB200 - Calça Social', Situacao: '1 - Iniciada',
        OprQtdPecas: 50, OprQtdRealizada: 0, OprQtdLd: 0, OprDtPrevFim: '2026-10-05T00:00:00' },
      { OprId: 7047, ProdDescricao: 'OG100 - Camiseta Dryfit', Situacao: '1 - Iniciada',
        OprQtdPecas: 100, OprQtdRealizada: 0, OprQtdLd: 0 },
    ]);
    ok('duas OPs de marketplace + uma de atacado criadas', r1.criadas === 3, JSON.stringify(r1));
    const op45 = await ordemPorWik(7045);
    ok('prazo dd/mm/aaaa gravado certo (não vira mês/dia)', iso(op45.data_prevista) === '2026-09-30', iso(op45.data_prevista));
    ok('início previsto gravado', iso(op45.data_inicio) === '2026-09-18');
    ok('data de abertura vem do Wik (/Date()/)', iso(op45.data_abertura) === '2026-09-09', iso(op45.data_abertura));
    ok('Aguardando Início = planejada', op45.situacao === 'planejada');

    const rec1 = await cal.reconciliarCalendario(pool);
    ok('reconciliação cria 1 evento (a OP sem prazo fica de fora)', rec1.criados === 1 && !(await evento((await ordemPorWik(7047)).id)), JSON.stringify(rec1));
    const ev45 = await evento(op45.id);
    ok('evento da OP 7045 existe', !!ev45);
    ok('título usa o número do Wik', ev45.titulo.startsWith('OP 7045 · OG100'), ev45.titulo);
    ok('prazo e início do evento = os da OP', iso(ev45.data_prevista_fim) === '2026-09-30' && iso(ev45.data_inicio) === '2026-09-18');
    ok('status não iniciado', ev45.status === 'nao_iniciado');
    ok('dados da OP no evento (marca, origem, situação, quantidade)',
      ev45.campos_extra.marca === 'Origem' && ev45.campos_extra.origem_op === 'wik'
      && ev45.campos_extra.situacao_op === 'planejada' && ev45.campos_extra.quantidade === 300
      && ev45.campos_extra.wik_situacao === '0 - Aguardando Início', JSON.stringify(ev45.campos_extra));
    const op46 = await ordemPorWik(7046);
    ok('OP de produto que não é de marketplace NÃO vai ao calendário', !(await evento(op46.id)));

    secao('2. Grade do Wik chega ao evento');
    await wik._atualizarGradeDaOp(op45.id, {
      cabecalho: { situacao: 1, dtPrevFim: '02/10/2026', dtPrevInicio: '18/09/2026', obs: 'Tecido chega dia 20' },
      grade: [
        { CorDescricao: 'Preto', OpriTamanho: 'P', OpriQtdPrevista: 50, OpriQtdRealizada: 0, OpriQtdLd: 0 },
        { CorDescricao: 'Preto', OpriTamanho: 'M', OpriQtdPrevista: 100, OpriQtdRealizada: 0, OpriQtdLd: 0 },
        { CorDescricao: 'Branco', OpriTamanho: 'M', OpriQtdPrevista: 150, OpriQtdRealizada: 0, OpriQtdLd: 0 },
      ],
    });
    const rec2 = await cal.reconciliarCalendario(pool);
    ok('reconciliação atualiza o evento', rec2.atualizados === 1, JSON.stringify(rec2));
    let ev = await evento(op45.id);
    ok('novo prazo (02/10) no evento', iso(ev.data_prevista_fim) === '2026-10-02', iso(ev.data_prevista_fim));
    ok('Iniciada = em andamento', ev.status === 'em_andamento');
    ok('cores e tamanhos no evento', JSON.stringify(ev.campos_extra.cores) === '["Branco","Preto"]'
      && ev.campos_extra.tamanhos.includes('P') && ev.campos_extra.tamanhos.includes('M'), JSON.stringify(ev.campos_extra.cores));
    ok('grade por cor somada', ev.campos_extra.grade_por_cor.find((c) => c.cor === 'Preto').planejada === 150);
    ok('observação do Wik chega', ev.campos_extra.observacoes_op === 'Tecido chega dia 20');
    const { rows: gradeEv } = await pool.query('SELECT cor, tamanho, quantidade FROM calendario_eventos_grade WHERE evento_id=$1 ORDER BY cor, tamanho', [ev.id]);
    ok('grade do evento com 3 linhas', gradeEv.length === 3 && gradeEv.every((g) => g.quantidade > 0), JSON.stringify(gradeEv));
    const { rows: hist } = await pool.query("SELECT alteracoes FROM calendario_historico WHERE evento_id=$1 AND acao='editado'", [ev.id]);
    ok('histórico registra mudança de status e de prazo', hist.some((h) => h.alteracoes.status && h.alteracoes.data_prevista_fim));

    secao('3. Passada sem mudança não grava');
    const antes = ev.atualizado_em.getTime();
    await wik._upsertOpsDoGrid([{ OprId: 7045, ProdDescricao: 'OG100 - Camiseta Dryfit', Situacao: '1 - Iniciada', OprQtdPecas: 300, OprQtdRealizada: 0, OprQtdLd: 0 }]);
    const opDepois = await ordemPorWik(7045);
    ok('grid igual não mexe no atualizado_em da OP', opDepois.atualizado_em.getTime() === (await ordemPorWik(7045)).atualizado_em.getTime()
      && iso(opDepois.data_prevista) === '2026-10-02');
    const rec3 = await cal.reconciliarCalendario(pool);
    ok('nada a reconciliar', rec3.verificadas === 0 && rec3.atualizados === 0, JSON.stringify(rec3));
    const rec3b = await cal.reconciliarCalendario(pool, { todas: true });
    ok('revisão forçada confere tudo e não regrava', rec3b.atualizados === 0 && rec3b.criados === 0, JSON.stringify(rec3b));
    ev = await evento(op45.id);
    ok('atualizado_em do evento parado', ev.atualizado_em.getTime() === antes);

    secao('4. Calendário: pessoas, travas e visibilidade');
    await admin('/api/auth/setup', { metodo: 'POST', corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Ana', email: 'ana@t.com', senha: SENHA } });
    const u1 = await admin('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Bruno', email: 'b@t.com', senha: SENHA, role: 'limitado', modulos: ['calendario', 'producao'] } });
    const u2 = await admin('/api/usuarios', { metodo: 'POST', corpo: { nome: 'Carla', email: 'c@t.com', senha: SENHA, role: 'limitado', modulos: ['calendario'] } });
    ok('usuários criados', u1.status === 201 && u2.status === 201, JSON.stringify([u1.dados, u2.dados]));
    await producao('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Bruno', senha: SENHA } });
    await soCalendario('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Carla', senha: SENHA } });

    const listaB = await producao('/api/calendario/eventos');
    ok('quem tem produção vê o evento da OP', listaB.status === 200 && listaB.dados.some((e) => e.id === ev.id), JSON.stringify(listaB.dados).slice(0, 200));
    const listaBmeus = await producao('/api/calendario/eventos?escopo=meus');
    ok('"Meus eventos" não inclui a OP', !listaBmeus.dados.some((e) => e.id === ev.id));
    const listaC = await soCalendario('/api/calendario/eventos');
    ok('quem só tem calendário não vê', listaC.status === 200 && !listaC.dados.some((e) => e.id === ev.id));
    const detB = await producao(`/api/calendario/eventos/${ev.id}`);
    ok('detalhe traz ordem_producao_id e os dados', detB.status === 200 && detB.dados.ordem_producao_id === op45.id && detB.dados.campos_extra.numero_op === '7045');
    ok('sem liberação, não edita', (await producao(`/api/calendario/eventos/${ev.id}`, { metodo: 'PUT', corpo: { descricao: 'x' } })).status === 404);

    const put = await admin(`/api/calendario/eventos/${ev.id}`, {
      metodo: 'PUT',
      corpo: {
        titulo: 'Título à mão', data_prevista_fim: '2027-01-01', status: 'concluido',
        descricao: 'Cobrar a facção na segunda', prioridade: 'alta',
        campos_extra: { anotacao: 'minha', numero_op: '9999', quantidade: 1 },
        grade: [{ cor: 'Azul', tamanho: 'G', quantidade: 1 }],
      },
    });
    ok('PUT aceito', put.status === 200, JSON.stringify(put.dados));
    ev = await evento(op45.id);
    ok('título, prazo e status da OP não mudam pelo calendário',
      ev.titulo.startsWith('OP 7045') && iso(ev.data_prevista_fim) === '2026-10-02' && ev.status === 'em_andamento');
    ok('descrição e prioridade da pessoa mudam', ev.descricao === 'Cobrar a facção na segunda' && ev.prioridade === 'alta');
    ok('anotação própria fica; número e quantidade da OP ganham',
      ev.campos_extra.anotacao === 'minha' && ev.campos_extra.numero_op === '7045' && ev.campos_extra.quantidade === 300,
      JSON.stringify(ev.campos_extra));
    const { rows: g2 } = await pool.query('SELECT count(*)::int n FROM calendario_eventos_grade WHERE evento_id=$1', [ev.id]);
    ok('grade da OP não é trocada pelo calendário', g2[0].n === 3);

    secao('5. Conclusão da OP conclui o evento');
    // ⚠️ CONTRATO ATUALIZADO NO CHECAPE DE 18/09/2026.
    // Antes, uma OP que chegava "2 - Finalizada" SEM data de fim ganhava
    // `data_conclusao = CURRENT_DATE` — ou seja, uma OP terminada em junho era
    // carimbada como "concluída hoje", e qualquer relatório de produção por
    // data saía errado (em produção, as 273 OPs concluídas estavam todas com a
    // data da importação). Agora a data de conclusão só vem do Wik
    // (`OprDtFim`, que o grid entrega em 754 das 837 OPs); sem ela, fica NULA,
    // e o calendário usa o prazo como referência, sem inventar nada.
    await wik._upsertOpsDoGrid([{ OprId: 7045, ProdDescricao: 'OG100 - Camiseta Dryfit', Situacao: '2 - Finalizada', OprQtdPecas: 300, OprQtdRealizada: 290, OprQtdLd: 10 }]);
    const opFim = await ordemPorWik(7045);
    ok('OP concluída, e SEM data de conclusão inventada (o Wik não mandou OprDtFim)',
      opFim.situacao === 'concluida' && opFim.data_conclusao === null, iso(opFim.data_conclusao));
    await cal.reconciliarCalendario(pool);
    ev = await evento(op45.id);
    ok('evento concluído (o calendário usa o prazo quando o Wik não deu data de fim)',
      ev.status === 'concluido' && iso(ev.data_conclusao_real) === iso(opFim.data_prevista),
      `${ev.status} / ${iso(ev.data_conclusao_real)}`);
    // E quando o Wik MANDA a data de fim, é ela que vale — nunca "hoje".
    await wik._upsertOpsDoGrid([{ OprId: 7045, ProdDescricao: 'OG100 - Camiseta Dryfit', Situacao: '2 - Finalizada', OprQtdPecas: 300, OprQtdRealizada: 290, OprQtdLd: 10, OprDtFim: '2026-06-22T00:00:00' }]);
    const opFimReal = await ordemPorWik(7045);
    ok('⚠️ data de conclusão vem do OprDtFim do Wik (22/06), não de hoje',
      iso(opFimReal.data_conclusao) === '2026-06-22', iso(opFimReal.data_conclusao));
    await cal.reconciliarCalendario(pool);
    ev = await evento(op45.id);
    ok('produzidas e segunda no evento', ev.campos_extra.quantidade_produzida === 290 && ev.campos_extra.quantidade_segunda === 10);
    ok('anotação e descrição continuam', ev.campos_extra.anotacao === 'minha' && ev.descricao === 'Cobrar a facção na segunda');

    // Leitura da grade (Finalizada = 2) não "desconclui" mais a OP.
    await wik._atualizarGradeDaOp(op45.id, { cabecalho: { situacao: 2 }, grade: [{ CorDescricao: 'Preto', OpriTamanho: 'P', OpriQtdPrevista: 300, OpriQtdRealizada: 290, OpriQtdLd: 10 }] });
    ok('leitura da grade mantém concluída', (await ordemPorWik(7045)).situacao === 'concluida');

    secao('6. OP reaberta / cancelada');
    await wik._upsertOpsDoGrid([{ OprId: 7045, ProdDescricao: 'OG100 - Camiseta Dryfit', Situacao: '5 - Cancelada', OprQtdPecas: 300, OprQtdRealizada: 290, OprQtdLd: 10 }]);
    await cal.reconciliarCalendario(pool);
    ev = await evento(op45.id);
    ok('cancelada = cancelado, sem data de conclusão', ev.status === 'cancelado' && ev.data_conclusao_real === null);

    secao('7. Produto passa a ser de marketplace depois');
    await pool.query("UPDATE ordens_producao SET data_prevista = '2026-10-10' WHERE id = $1", [op46.id]);
    await pool.query("UPDATE produtos SET marketplace = TRUE WHERE referencia = 'HB200'");
    const rec7 = await cal.reconciliarCalendario(pool);
    ok('OP antiga entra no calendário na próxima passada', rec7.criados === 1 && !!(await evento(op46.id)), JSON.stringify(rec7));

    secao('8. Duplicar evento de OP');
    const dup = await admin(`/api/calendario/eventos/${ev.id}/duplicar`, { metodo: 'POST' });
    ok('cópia criada sem vínculo e sem dados da OP', dup.status === 201 && !dup.dados.ordem_producao_id
      && dup.dados.campos_extra.numero_op === undefined && dup.dados.campos_extra.anotacao === 'minha', JSON.stringify(dup.dados.campos_extra));

    secao('9. Rota manual');
    const rota = await admin('/api/producao/calendario/sincronizar', { metodo: 'POST', corpo: { todas: true } });
    ok('POST /producao/calendario/sincronizar responde', rota.status === 200 && typeof rota.dados.verificadas === 'number', JSON.stringify(rota.dados));
  } catch (e) {
    ok('sem exceção', false, e.stack);
  } finally {
    servidor.close();
    await pool.end();
  }
  console.log(`\n${passou} passaram, ${falhou} falharam`);
  if (falhou) { console.log(falhas.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
}
main();
