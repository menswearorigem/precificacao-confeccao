#!/usr/bin/env node
/*
 * Seed de DESENVOLVIMENTO das Rotinas (15/10/2026) — para olhar as telas com
 * dado de verdade. NUNCA roda em produção (sai com erro se NODE_ENV=production
 * ou se o banco tem mais de 50 usuários, sinal de banco real).
 *
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/seed-rotinas-dev.js
 *
 * Cria (se faltar) um administrador "Arthur" e três pessoas da equipe, quatro
 * referências com variantes e estoque, e os três modelos pedidos:
 *   1. contagem cíclica por variante, comparando com o estoque do sistema;
 *   2. conferência da coleta com foto obrigatória ("qualquer um resolve");
 *   3. uma tarefa simples, sem passos.
 * Gera as tarefas de hoje e responde algumas, para a Equipe ter o que mostrar.
 * Senha de todos: "trigo azul de setembro".
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');
const rot = require('../src/lib/rotinas');
const { hojeEmBrasilia } = require('../src/lib/dataBrasil');

const SENHA = 'trigo azul de setembro';

async function usuario(nome, role, modulos) {
  const email = `${nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}@hbn.dev`;
  const { rows } = await pool.query('SELECT id FROM usuarios WHERE nome = $1', [nome]);
  if (rows.length) return rows[0].id;
  const hash = await bcrypt.hash(SENHA, 10);
  const { rows: [u] } = await pool.query('INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ($1, $2, $3, $4) RETURNING id', [nome, email, hash, role]);
  for (const m of modulos) await pool.query('INSERT INTO usuario_modulos (usuario_id, modulo) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, m]);
  return u.id;
}

async function produto(referencia, descricao, marca, grupo, grade) {
  let { rows } = await pool.query('SELECT id FROM produtos WHERE referencia = $1', [referencia]);
  if (!rows.length) ({ rows } = await pool.query('INSERT INTO produtos (referencia, descricao, marca, wik_grupo) VALUES ($1, $2, $3, $4) RETURNING id', [referencia, descricao, marca, grupo]));
  const id = rows[0].id;
  for (const [cor, tamanho, q, local] of grade) {
    await pool.query(
      `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, localizacao) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (produto_id, cor, tamanho) DO NOTHING`, [id, cor, tamanho, q, local]
    );
  }
  return id;
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Seed de desenvolvimento: não roda em produção.');
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM usuarios');
  if (n > 50) throw new Error('Este banco parece real (mais de 50 usuários). Seed cancelado.');

  const arthur = await usuario('Arthur', 'admin', []);
  const eri = await usuario('Erizânia', 'limitado', ['rotinas', 'estoque']);
  const nath = await usuario('Nath', 'limitado', ['rotinas', 'marketplace']);
  const silencio = await usuario('Silêncio', 'limitado', ['rotinas']);

  const p1 = await produto('1042', 'Camiseta Dry Fit Básica', 'Origem', '1 - CAMISETAS', [['Preto', 'P', 14, 'B/3'], ['Preto', 'M', 22, 'B/3'], ['Preto', 'G', 9, 'B/4'], ['Branco', 'M', 17, 'B/5']]);
  const p2 = await produto('1108', 'Regata Dry Fit', 'Origem', '3 - REGATAS', [['Marinho', 'M', 6, 'C/1'], ['Marinho', 'G', 11, 'C/1']]);
  await produto('2001', 'Blusa Suplex Gola Alta', 'Miss Manu', '7 - BLUSAS', [['Rosa', 'P', 8, 'A/2'], ['Rosa', 'M', 5, 'A/2']]);
  await produto('3010', 'Bermuda Tactel', 'Hoggar', '5 - BERMUDAS', [['Cinza', '40', 12, 'D/1']]);

  const { rows: ja } = await pool.query("SELECT 1 FROM rotina_modelos WHERE titulo = 'Contagem cíclica — curva A' LIMIT 1");
  if (ja.length) { console.log('Modelos de exemplo já existem — nada a fazer.'); return; }

  const criar = async (corpo, opts = {}) => rot.salvarModelo(await rot.normalizarModelo(corpo, pool, opts), arthur);

  const contagem = await criar({
    titulo: 'Contagem cíclica — curva A',
    instrucaoHtml: '<p>Contar <b>fisicamente</b> cada variante abaixo e lançar a quantidade.</p><ul><li>Conte a prateleira inteira, inclusive o que está atrás.</li><li>Se divergir mais de 2 peças do sistema, fotografe a prateleira.</li></ul>',
    motivo: 'O saldo do sistema desvia da prateleira toda semana.',
    setor: 'estoque', marcas: ['Origem'], canais: ['mercado_livre', 'shopee'],
    anexos: { links: [{ rotulo: 'Vídeo: como contar', url: 'https://exemplo.com/treino-contagem' }] },
    modoProdutos: 'fixa', produtos: [{ produtoId: p1, varianteId: null }, { produtoId: p2, varianteId: null }],
    passos: [
      { texto: 'Quantidade contada', tipo: 'numero', unidade: 'peças', porProduto: true, obrigatorio: true, provaFoto: 'problema', faixa: { estoque: true, tolerancia: 2 } },
      { texto: 'Prateleira organizada e etiquetada?', tipo: 'sim_nao', obrigatorio: true, provaFoto: 'problema' },
      { texto: 'Algo mais que precisamos saber?', tipo: 'texto', obrigatorio: false },
    ],
    responsaveis: [eri], modoAtribuicao: 'cada_um',
    recorrencia: { tipo: 'dias_semana', dias: [1, 2, 3, 4, 5, 6, 7], pularFeriados: false },
    horaLimite: '10:00', minutosEstimados: 30, prioridade: 'alta', conferirDepois: true,
    correcaoAutomatica: { responsavelId: silencio }, lembreteMin: 30,
  });
  const coleta = await criar({
    titulo: 'Conferir coleta Mercado Livre',
    instrucaoHtml: '<p>Antes do motorista sair, fotografe a pilha de caixas com as etiquetas viradas para a câmera e confira a quantidade com o romaneio.</p>',
    setor: 'expedicao', canais: ['mercado_livre'],
    passos: [
      { texto: 'Foto da pilha antes da coleta', tipo: 'foto', obrigatorio: true },
      { texto: 'Quantidade de volumes bate com o romaneio?', tipo: 'ok_problema', obrigatorio: true, provaFoto: 'problema' },
      { texto: 'Situação da coleta', tipo: 'escolha', opcoes: ['No horário', 'Atrasou', 'Não veio'], obrigatorio: true },
    ],
    responsaveis: [nath, silencio], modoAtribuicao: 'qualquer_um',
    recorrencia: { tipo: 'dias_semana', dias: [1, 2, 3, 4, 5, 6, 7], pularFeriados: false },
    horaLimite: '14:00', prioridade: 'urgente',
  });
  await criar({
    titulo: 'Ligar para a facção sobre a OP 4471',
    instrucaoHtml: '<p>Confirmar a data de entrega da OP 4471 e anotar no Calendário.</p>',
    setor: 'producao', responsaveis: [eri], recorrencia: { data: hojeEmBrasilia() }, horaLimite: '08:00', prioridade: 'normal',
  }, { avulsa: true });

  await rot.gerarDia(hojeEmBrasilia(), { forcar: true });

  // Uma contagem respondida pela metade, com um problema, para a tela ter cor.
  const { rows: [oc] } = await pool.query('SELECT id, snapshot, produtos_resolvidos FROM rotina_ocorrencias WHERE modelo_id = $1', [contagem]);
  const passo = oc.snapshot.passos[0];
  const chaves = rot.chavesDeProduto(oc.produtos_resolvidos);
  for (const [i, c] of chaves.slice(0, 3).entries()) {
    const sistema = c.variante.quantidade;
    const numero = i === 1 ? sistema - 5 : sistema;
    await pool.query(
      `INSERT INTO rotina_respostas (ocorrencia_id, passo_id, chave_produto, produto_id, variante_id, valor, problema, respondido_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [oc.id, passo.id, c.chave, c.produtoId, c.varianteId, JSON.stringify({ numero, sistema }), i === 1, eri]
    );
  }
  await pool.query("UPDATE rotina_ocorrencias SET status = 'em_andamento', iniciada_em = now() WHERE id = $1", [oc.id]);
  console.log(`Seed pronto: modelos ${contagem}, ${coleta} e uma avulsa. Entre como Arthur / Erizânia / Nath com a senha "${SENHA}".`);
}

main().then(() => pool.end()).catch(async (err) => { console.error(err.message); await pool.end(); process.exit(1); });
