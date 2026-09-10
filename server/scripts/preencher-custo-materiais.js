#!/usr/bin/env node
// Preenche o custo de matéria-prima das fichas de TODOS os produtos, de uma
// vez, direto no servidor — sem precisar abrir tela nenhuma.
//
//   Ver o que aconteceria (não grava nada):
//     node server/scripts/preencher-custo-materiais.js
//
//   Fazer de verdade:
//     node server/scripts/preencher-custo-materiais.js --confirmar
//
//   Aceitar também os insumos cuja unidade o sistema deduziu e ninguém
//   confirmou ainda (leia o aviso que o script imprime antes de usar):
//     node server/scripts/preencher-custo-materiais.js --confirmar --aceitar-unidade-nao-confirmada
//
// O que ele faz, na ordem, e tudo numa transação só:
//   1. liga cada linha de ficha ao insumo cujo nome é EXATAMENTE igual;
//   2. calcula o custo de matéria-prima de cada referência a partir do custo
//      do insumo, respeitando a unidade (metro, quilo, unidade);
//   3. abate exatamente o mesmo valor do custo industrial;
//   4. relê do banco e confere que o custo de produção de cada peça continua
//      o mesmo — se alguma mudar além de meio centavo, desfaz TUDO.
//
// O que ele NÃO faz: não casa nome parecido, não inventa custo para insumo
// sem preço, não converte quilo em metro sem fator cadastrado, e não usa
// unidade que ainda é palpite do sistema (salvo com a opção acima). O que
// sobra desses casos sai listado no fim, com o motivo.

require('dotenv').config();
const pool = require('../src/db/pool');
const { preencherTudo } = require('../src/lib/preencherCustoMaterial');

const confirmar = process.argv.includes('--confirmar');
const aceitarUnidadeNaoConfirmada = process.argv.includes('--aceitar-unidade-nao-confirmada');

const brl = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const brl4 = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

const MOTIVO_CURTO = {
  sem_custo_industrial: 'não tem custo industrial de onde tirar',
  industrial_insuficiente: 'a matéria-prima calculada é maior que todo o custo industrial',
  diferenca_acima_do_limite: 'a conta não fechou dentro de meio centavo',
};

async function main() {
  console.log('');
  console.log(confirmar
    ? '== PREENCHENDO o custo de matéria-prima das fichas =='
    : '== PRÉVIA — nada será gravado (rode com --confirmar para valer) ==');
  if (aceitarUnidadeNaoConfirmada) {
    console.log('');
    console.log('  ATENÇÃO: você está deixando entrar no custo insumos cuja unidade o sistema');
    console.log('  DEDUZIU da descrição — o relatório de preços do Wik não informa unidade.');
    console.log('  Se a unidade estiver errada, o custo do material sai errado na mesma');
    console.log('  proporção (quilo por metro erra por um fator de três).');
  }
  console.log('');

  const client = await pool.connect();
  let r;
  try {
    r = await preencherTudo(client, { confirmar, aceitarUnidadeNaoConfirmada });
  } finally {
    client.release();
  }

  console.log('Vínculos ficha → insumo');
  console.log(`  criados por nome exato ............. ${r.vinculos_criados}`);
  console.log(`  linhas que continuam sem vínculo ... ${r.linhas_sem_vinculo_restantes}`);
  const nc = r.linhas_que_nao_casaram || {};
  console.log(`     empate de nome ................. ${nc.ambiguo || 0}  (o nome bate com mais de um insumo)`);
  console.log(`     só parecidas ................... ${nc.sugestao || 0}  (casar por semelhança é proibido — escolha na tela)`);
  console.log(`     sem candidato .................. ${nc.nenhum || 0}  (talvez o insumo ainda não exista)`);
  console.log('');

  console.log('Distribuição do custo');
  console.log(`  referências olhadas ............... ${r.referencias_olhadas}`);
  console.log(`  referências preenchidas ........... ${r.referencias_preenchidas}`);
  console.log(`  valor movido do industrial p/ ficha  ${brl(r.valor_movido)}`);
  console.log(`  maior mudança no custo da peça .... ${brl4(r.maior_diferenca)}  (limite: ${brl4(r.tolerancia)})`);
  console.log('');

  if (r.travadas && r.travadas.length > 0) {
    console.log(`Referências que NÃO deu para preencher: ${r.travadas.length}`);
    const porMotivo = {};
    for (const t of r.travadas) {
      const chave = MOTIVO_CURTO[t.situacao] || 'falta vínculo, quantidade ou unidade confirmada na ficha';
      porMotivo[chave] = (porMotivo[chave] || 0) + 1;
    }
    for (const [motivo, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${motivo}`);
    }
    console.log('');
    console.log('  Exemplos (as 10 primeiras):');
    for (const t of r.travadas.slice(0, 10)) {
      console.log(`    ${t.referencia} — ${t.pendencias[0] || t.motivo || t.situacao}`);
    }
    console.log('');
  }

  if (r.erro) {
    console.log('NADA FOI GRAVADO.');
    console.log(`  ${r.erro}`);
    for (const f of r.referencias_fora.slice(0, 10)) {
      console.log(`    ${f.referencia}: ${brl4(f.diferenca)}`);
    }
    process.exitCode = 1;
    return;
  }

  if (r.confirmado) {
    console.log('Gravado. O custo de produção de cada peça continua o mesmo —');
    console.log('conferido relendo do banco, referência por referência.');
    if (r.referencias.length > 0) {
      console.log('');
      console.log('  As 10 maiores mudanças de composição:');
      const top = [...r.referencias].sort((a, b) => (b.material_depois - b.material_antes) - (a.material_depois - a.material_antes)).slice(0, 10);
      for (const p of top) {
        console.log(`    ${String(p.referencia).padEnd(12)} material ${brl(p.material_antes)} → ${brl(p.material_depois)}   |   industrial ${brl(p.industrial_antes)} → ${brl(p.industrial_depois)}   |   custo ${brl(p.subtotal_antes)} → ${brl(p.subtotal_depois)}`);
      }
    }
  } else {
    console.log('Prévia encerrada — nada foi gravado.');
    console.log('Para fazer de verdade:  node server/scripts/preencher-custo-materiais.js --confirmar');
  }
  console.log('');
}

main()
  .catch((err) => { console.error('Falhou:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
