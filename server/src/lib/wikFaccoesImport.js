// Importa as FACÇÕES do Wik para o HBN Hub.
//
// Fonte: o cadastro de Departamento do Wik (web, cookie de sessão), puxado por
// wikWeb.carregarGridDepartamentos. Cada departamento liga um Fornecedor
// (DepFornId "id - nome") a uma etapa/categoria (DepTipoDep) — a facção de
// verdade é o Fornecedor. Consolidamos por fornecedor (uma facção pode aparecer
// em várias etapas) e escolhemos a categoria principal por prioridade.
//
// IDEMPOTENTE e NÃO-DESTRUTIVO (a dona edita as facções à mão — CNPJ, PIX etc.):
//   · facção já vinculada (wik_forn_id) -> não mexe;
//   · fornecedor com o mesmo nome já existe -> só VINCULA (marca eh_faccao,
//     preenche categoria se estiver vazia), sem sobrescrever o resto;
//   · não existe -> CRIA a facção com nome/razão/categoria/status.
//
// O que ESTE passo traz: nome, razão social, categoria e status (ativo/inativo).
// O que NÃO vem daqui (fica para um segundo passo de enriquecimento pelo cadastro
// de Pessoas do Wik): CNPJ, contato, endereço, PIX. Por isso a facção nasce com
// esses campos em branco, prontos para a casa completar.

const pool = require('../db/pool');
const wikWeb = require('./wikWeb');
const { obterSessao, renovarSessao, integracaoWik } = require('./wikWebSessao');

// Etapa do Wik (DepTipoDep, sem o código) -> nome da categoria no Hub
// (faccao_categorias, semeadas na 0063).
const MAP_CATEGORIA = {
  'FACÇÃO': 'Costureira / Facção',
  'FACCAO': 'Costureira / Facção',
  'ACABAMENTO': 'Acabamento',
  'LAVANDERIA': 'Lavanderia',
  'LAVAÇÃO DE ROUPAS': 'Lavanderia',
  'ROUPAS LAVADAS': 'Lavanderia',
  'BORDADO': 'Bordado',
  'ESTAMPARIA': 'Estamparia',
  'CORTE': 'Corte',
  'DIFERENÇA DE CORTE': 'Corte',
  'ABERTURA': 'Corte',
  'CASEADO': 'Caseado e travete',
  'TRAVETE': 'Caseado e travete',
};
// Prioridade para escolher a categoria PRINCIPAL de uma facção multi-etapa.
const PRIORIDADE = [
  'Costureira / Facção', 'Lavanderia', 'Bordado', 'Estamparia',
  'Corte', 'Caseado e travete', 'Acabamento', 'Outros serviços',
];

function categoriaDaEtapa(depTipoDep) {
  const etapa = String(depTipoDep || '').split(' - ')[1] || String(depTipoDep || '');
  return MAP_CATEGORIA[etapa.trim().toUpperCase()] || MAP_CATEGORIA[etapa.trim()] || 'Outros serviços';
}
function parseForn(depFornId) {
  const m = String(depFornId || '').trim().match(/^(\d+)\s*-\s*(.*)$/);
  if (!m) return null;
  return { id: Number(m[1]), nome: m[2].trim() };
}

// Consolida as linhas de departamento em uma lista de facções distintas.
function consolidar(departamentos) {
  const porForn = new Map();
  for (const d of departamentos) {
    const interno = /1\s*-\s*Interno/i.test(d.DepTipo || '');
    const forn = parseForn(d.DepFornId);
    if (interno || !forn || !forn.id) continue; // interno/sem fornecedor não é facção
    const cat = categoriaDaEtapa(d.DepTipoDep);
    const etapa = (String(d.DepTipoDep || '').split(' - ')[1] || '').trim();
    if (!porForn.has(forn.id)) {
      porForn.set(forn.id, { wikFornId: forn.id, nome: forn.nome, categorias: new Set(), etapas: new Set(), ativo: false });
    }
    const f = porForn.get(forn.id);
    f.categorias.add(cat);
    if (etapa) f.etapas.add(etapa);
    if (/ativo/i.test(d.Situacao || '') && !/inativo/i.test(d.Situacao || '')) f.ativo = true;
    if (forn.nome && forn.nome.length > f.nome.length) f.nome = forn.nome; // nome mais completo
  }
  return [...porForn.values()].map((f) => {
    const cats = [...f.categorias];
    const principal = PRIORIDADE.find((p) => cats.includes(p)) || 'Outros serviços';
    return {
      wikFornId: f.wikFornId,
      nome: (f.nome || `Facção Wik ${f.wikFornId}`).slice(0, 160),
      categoriaPrincipal: principal,
      categorias: cats,
      etapas: [...f.etapas],
      ativo: f.ativo,
    };
  });
}

let importando = false;

async function importarFaccoesDoWik() {
  if (importando) return { pulado: 'importação já em andamento' };
  importando = true;
  try {
    const integracao = await integracaoWik();
    if (!integracao || !integracao.ativo) throw new Error('Integração Wik não configurada ou inativa.');
    let sessao = await obterSessao(integracao);

    let departamentos;
    try {
      departamentos = await wikWeb.carregarGridDepartamentos(sessao);
    } catch (e) {
      if (e.sessaoExpirada) { sessao = await renovarSessao(integracao); departamentos = await wikWeb.carregarGridDepartamentos(sessao); }
      else throw e;
    }

    const faccoes = consolidar(departamentos);

    // mapa nome-da-categoria -> id
    const { rows: catRows } = await pool.query('SELECT id, nome FROM faccao_categorias');
    const catId = new Map(catRows.map((c) => [c.nome, c.id]));
    const outrosId = catId.get('Outros serviços') || null;

    const resumo = { totalWik: faccoes.length, criadas: 0, vinculadas: 0, jaExistiam: 0, erros: [] };

    for (const f of faccoes) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // já vinculada por wik_forn_id?
        const jaLig = await client.query('SELECT id FROM fornecedores WHERE wik_forn_id = $1', [f.wikFornId]);
        if (jaLig.rows[0]) { resumo.jaExistiam += 1; await client.query('COMMIT'); continue; }

        const fcatId = catId.get(f.categoriaPrincipal) || outrosId;
        const extras = JSON.stringify({ wik_forn_id: f.wikFornId, wik_categorias: f.categorias, wik_etapas: f.etapas });

        // mesmo nome já cadastrado? então VINCULA em vez de duplicar
        const mesmoNome = await client.query(
          "SELECT id, eh_faccao, faccao_categoria_id FROM fornecedores WHERE lower(btrim(nome)) = lower(btrim($1)) ORDER BY id LIMIT 1",
          [f.nome]
        );
        if (mesmoNome.rows[0]) {
          const ex = mesmoNome.rows[0];
          await client.query(
            `UPDATE fornecedores
                SET wik_forn_id = $1,
                    eh_faccao = TRUE,
                    faccao_categoria_id = COALESCE(faccao_categoria_id, $2),
                    campos_adicionais = campos_adicionais || $3::jsonb,
                    updated_at = now()
              WHERE id = $4`,
            [f.wikFornId, fcatId, extras, ex.id]
          );
          resumo.vinculadas += 1;
          await client.query('COMMIT');
          continue;
        }

        // cria nova facção
        await client.query(
          `INSERT INTO fornecedores
             (tipo_pessoa, nome, razao_social, categoria_principal, eh_faccao, faccao_categoria_id,
              ativo, campos_adicionais, wik_forn_id)
           VALUES ('PF', $1, $1, 'Facção', TRUE, $2, $3, $4::jsonb, $5)`,
          [f.nome, fcatId, f.ativo, extras, f.wikFornId]
        );
        resumo.criadas += 1;
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        resumo.erros.push(`${f.wikFornId} ${f.nome}: ${e.message}`);
      } finally {
        client.release();
      }
    }
    resumo.erros = resumo.erros.slice(0, 10);
    return resumo;
  } finally {
    importando = false;
  }
}

module.exports = { importarFaccoesDoWik, consolidar };
