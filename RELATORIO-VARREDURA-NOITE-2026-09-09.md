# Varredura da noite — 09/09/2026

Tudo menos Produção e Financeiro, que estão com outro cowork.

**Entregue:** 8 commits em cima de `208967b`, 85 arquivos, +3.405 / −592 linhas.
Patch único: `hbn-varredura-noite-2026-09-09.patch`.

**Verificação:** as 53 rotas do sistema abertas num navegador de verdade contra
um Postgres com dados — 0 erro de JavaScript, 0 requisição falha, 0 tela sem
título. As 18 suítes de teste passam (≈800 asserções), incluindo as 51 do Mix
Tributário, as 30 da Saúde de Integração e as 54 da varredura de segurança.
O produto **36155** continua com o mesmo preço, o mesmo custo e a mesma margem
de antes (REGRA 1).

---

# PARTE 1 — O QUE EU **NÃO** MEXI: os cálculos

São oito. Verifiquei cada um no código e reproduzi cada um com números. Nenhum
foi tocado, como você pediu. Estão em ordem de quanto custam.

---

## 1. 🔴 Na viagem, "desconto máximo" vira **100%** quando a ficha de custo está vazia

**`server/src/routes/viagens.routes.js:37-40`**

```js
const precoIdeal  = Number(calculo.formacaoPreco.precoAtivo)  || 0;
const precoMinimo = Number(calculo.formacaoPreco.precoMinimo) || 0;
const descontoMaximoPct = precoIdeal > 0 ? Math.max(0, (precoIdeal - precoMinimo) / precoIdeal) : 0;
```

`precoMinimo` vem de `calc.js:69-74`, que **devolve 0 quando o produto não tem
ficha de custo** (`subtotalProducao === 0`). Ou seja: "não sei calcular o
mínimo" chega aqui como "o mínimo é R$ 0,00".

**O que acontece na feira.** Camiseta com preço digitado de R$ 89,90 e ficha de
custo vazia. `precoMaximo = (89,90 − 0) / 89,90 = 1,0`. O card da viagem
escreve **"Desc. máximo 100,0%"** e **"Desc. ideal 50,0%"**. A vendedora dá 50%
achando que está dentro do limite e vende a R$ 44,95 uma peça que custa R$ 52.
O servidor não trava nada: `POST /:id/vender` só faz `Math.min(1, Math.max(0, …))`.

**É o único achado desta noite que causa prejuízo direto, na hora, em dinheiro.**

O certo seria `precoMinimo = null` e o card dizer "sem ficha de custo — desconto
máximo indisponível" em vez de 100%.

---

## 2. 🔴 Promoção publica **um centavo a menos** do que você digitou

**`server/src/routes/promocoes.routes.js:511`**

```js
if (precoPromocional != null) precoPromocional = Math.floor(precoPromocional * 100) / 100;
```

O arredondamento para baixo está certo para o preço **calculado** (regra de
desconto, margem alvo). O problema é que ele também pega o modo `preco_fixo`
(linha 486), onde `regra.valor` é o preço que **você digitou**.

Em ponto flutuante, `19,99 × 100` cai um fio abaixo de 1999, e o `floor` derruba
o centavo:

| você digita | vai para a plataforma |
|---|---|
| R$ 19,99 | R$ 19,98 |
| R$ 4,35 | R$ 4,34 |
| R$ 8,20 | R$ 8,19 |
| R$ 0,29 | R$ 0,28 |

R$ 29,99 e R$ 9,99 passam ilesos — **o erro é intermitente**, o que é pior:
não dá para perceber por padrão.

**O que acontece.** Campanha de 300 anúncios a "preço fixo R$ 19,99": todos vão
a R$ 19,98. A prévia mostra 19,98 também, então nada na tela avisa que o número
publicado é diferente do digitado.

---

## 3. 🔴 Peças **somem** na curva de tamanho

**`server/src/lib/curvaTamanho.js:219-227`**

```js
if (l.quantidade > 0 && l.quantidade < min) {
  const maior = linhas.reduce((a, b) => (b.participacao > a.participacao ? b : a));
  maior.quantidade += l.quantidade;
  l.quantidade = 0;
}
```

Quando o tamanho que está abaixo do mínimo **é ele próprio** o de maior
participação, `maior` e `l` são o mesmo objeto: a linha soma nele mesmo e a
linha seguinte zera tudo.

**Reproduzido.** Curva P 40% · M 30% · G 30%, lote de 10 peças, mínimo 5:

| passo | P | M | G |
|---|---|---|---|
| distribuição | 4 | 3 | 3 |
| P abaixo do mínimo → P recebe de P e zera | **0** | 3 | 3 |
| M abaixo do mínimo → vai para P | 3 | 0 | 3 |
| G abaixo do mínimo → vai para P | 6 | 0 | 0 |

**Ordem de corte de 6 peças para um lote de 10.** A tela avisa
(`somaConfere = false`, linha 236), mas o que sai impresso está errado em 4
peças. Com tamanho único, lote 3 e mínimo 5, a grade sai **zerada**.

---

## 4. 🔴 Taxa **desconhecida** entra na conta como taxa **zero**

**`server/src/routes/pedidos.routes.js:986`**

```js
const taxaMarketplace = Number(p.taxa_marketplace) || 0;
```

`Number(null)` é `0`. Não há ramo nenhum separando "esta venda não tem comissão"
de "ainda não sabemos a comissão desta venda".

O próprio arquivo já sabe que NULL significa outra coisa: na conferência de
taxas (`pedidos.routes.js:1919` e `:1960`) o NULL é **excluído** e contado como
pendente, e `marketplaceSync.js:723` trata `IS NULL` como "falta buscar".
No relatório de lucratividade, não.

**O que acontece.** 100 pedidos de Shopee de R$ 100,00 importados antes de a
comissão conciliar. O relatório soma R$ 0,00 de taxa e mostra o lucro cheio.
Com a comissão real de 20%, o lucro exibido está **R$ 2.000 acima do real** e a
margem vem ~20 pontos inflada — sem aviso, porque esses pedidos não entram nem
em `pedidosExcluidosPorCustoIncompleto` nem em `pedidosNaoAvaliaveis`.

Mesmo problema na agregação de pacotes, linha 945.

---

## 5. 🟠 Repasse **confirmado** somado com **estimativa** no mesmo total

**`server/src/routes/pedidos.routes.js:1187`** (e `:1419`, na série diária)

```js
totalGeral.liquidoMarketplace = pedidosValidos.reduce(
  (s, p) => s + (p.calculoReal ? p.valorRecebido : p.receita - p.taxaMarketplace), 0);
```

Duas grandezas diferentes num acumulador só: o repasse que a plataforma
confirmou, e um preço menos uma taxa estimada (que, pelo item 4, pode ser zero).
`calculoReal` existe por pedido mas não é agregado — o número que chega na tela
não diz quanto dele é dinheiro e quanto é chute.

**O que acontece.** Mês com 200 pedidos de R$ 100,00. 120 conciliados, repasse
médio real R$ 72,00 → R$ 8.640. 80 sem conciliar, taxa NULL → contribuem R$ 100
cada → R$ 8.000. A tela mostra **R$ 16.640 como dinheiro líquido**. Quando os 80
conciliarem, o mesmo mês vale **R$ 14.400** — R$ 2.240 a menos, e nada na tela
anterior indicava que 40% do número era estimativa.

---

## 6. 🟠 A mesma referência mostra **margens diferentes em telas diferentes**

**`server/src/routes/produtos.routes.js:37-40` e `:105-109`** não trazem
`usa_aliquota_media` nem `aliquota_media_pct` da empresa. `calc.js:16` faz:

```js
if (empresa.usa_aliquota_media) return Number(empresa.aliquota_media_pct) || 0;
```

Coluna ausente → `undefined` → cai no cálculo detalhado, ignorando a alíquota
média que você configurou.

**Trazem certo:** `analisesEstoque.routes.js:34`, `estoqueMinimo.routes.js:126`,
`producao.routes.js:541`, `promocaoMargem.js:34`.
**Omitem, com o mesmo defeito:** `alertas.routes.js:48`, `kits.routes.js:24`,
`estoque.routes.js:629` e `:728`, `qualidadeDados.routes.js:26`,
`anunciosExportacao.js:163-164`.

**O que acontece.** Empresa no Simples com `simples_aliquota = 7%` e
`usa_aliquota_media = true, aliquota_media_pct = 12%`. Numa peça de R$ 100:
imposto de R$ 7 na Ficha de Custo e na lista de produtos, R$ 12 em Estoque
Mínimo, Produção, Análises e na prévia de Promoções. **A mesma referência
aparece com ~5 pontos de margem a mais na tela de precificação.**

É uma correção pequena (acrescentar duas colunas a dois SELECTs) e por isso
mesmo perigosa: muda o número de precificação de todas as referências de
empresas que usam alíquota média. É sua decisão, não minha.

---

## 7. 🟠 **Cobertura** e **Curva ABC** têm duas fórmulas cada, e elas discordam

### Cobertura — duas implementações, ambas por referência

| | onde | fórmula |
|---|---|---|
| A | `estoque.routes.js:814-834` | saldo ÷ (unidades vendidas em 30 dias ÷ 30) |
| B | `estoqueMinimo.js:411-436` | saldo ÷ (média **semanal** da série ÷ 7) |

**O que acontece.** Referência com 60 peças que vendeu 30 unidades em 30 dias,
mas concentradas (25 na primeira semana). Tela de Estoque: **60 dias**. Tela de
Estoque Mínimo: **~168 dias**. Só B carrega as ressalvas de demanda censurada e
histórico curto; só B conta peças vendidas em kit.

Nenhuma das duas é por **variante**. O GG parado e o P esgotado se cancelam
dentro do mesmo número — e é exatamente essa a informação que decide a compra.

### Curva ABC — duas implementações, critérios opostos

| | onde | critério |
|---|---|---|
| A | `estoque.routes.js:792-812` | **valor imobilizado a custo** (não olha venda) |
| B | `estoqueMinimo.js:446-473` | **margem de contribuição do período** |

**O que acontece.** 400 peças paradas a R$ 30 de custo, zero venda: **classe A**
na tela de Estoque (topo do imobilizado), **classe C** na tela de Estoque Mínimo
(margem zero). E a classe C fixa o nível de serviço mais baixo
(`estoqueMinimo.routes.js:169`) — a mesma referência é "prioridade máxima" numa
tela e "pode faltar" na outra.

---

## 8. 🟡 O movimento de estoque não atualiza o **saldo por local**

**`server/src/lib/estoqueMovimento.js`** (22 linhas) escreve em
`estoque_variantes` e `estoque_movimentos`, e **não toca em
`estoque_variante_saldos`**. Chamadores: faturamento e estorno de pedido,
sincronização de marketplace, Wik, importação de saldo, viagens.

**O que acontece.** Variante com 50 peças, todas endereçadas ao galpão. Vende 10:
o total vai a 40, o endereçamento continua em 50. `estoqueLocais.js:150-160`
calcula `40 − 50 = −10` e marca **"Há 10 peça(s) endereçadas que não existem no
estoque"**. A própria migration `0052` diz que soma maior que o total "é
defeito".

**Toda venda de peça endereçada gera um alerta falso de inconsistência**, e o
"Disponível" da tela de locais fica acima do real. O risco é o de sempre com
alarme falso: a pessoa se acostuma a ignorar e deixa passar o alerta verdadeiro.

---

## Menores, do mesmo lote (todos verificados, nenhum tocado)

- **`viagens.routes.js:231-235` e `418-426`** — falha de cálculo é gravada como
  **zero**. O item entra no carrinho a R$ 0,00 e o servidor aceita, baixando
  estoque com receita zero. No resumo, o custo do produto vira 0: numa viagem
  com um produto que falhou, o lucro pode sair R$ 17.000 / 63% onde o real é
  R$ 12.000 / 44%.
- **`viagens.routes.js:429-434`** — a receita é o preço **praticado** (com
  desconto), mas o custo carrega imposto e taxa calculados sobre o **preço de
  tabela**. Peça de R$ 89,90 a 40% de desconto: R$ 2,87 de lucro somem por peça.
  E `margemPct` devolve `0` sem receita, que na tela se lê como "vendemos com
  margem zero".
- **`calcContext.js:26`** — `producao_mensal_pecas` em branco zera o rateio de
  custo indireto silenciosamente. Com R$ 40.000/mês de indiretos, cada peça
  perde ~R$ 8 de custo e o preço mínimo cai ~R$ 13.
- **`kits.routes.js`** — `margemEstimada` devolve `0` quando o preço do kit é 0.
  "Não dá para calcular" e "margem zero" viram o mesmo número.
- **`ViagemDetailPage.jsx:535`** — o campo de desconto arredonda só a exibição.
  Digitando 33,35 a tela escreve "33,4" e o total cobra 33,35%.
- **`compras.routes.js:24`** — `total_bruto` é recalculado sem arredondar, sobre
  `quantidade(14,4) × valor(14,4)`, enquanto `compra_itens.total` já veio
  arredondado do banco. A coluna "Total" e o "Total Bruto" logo abaixo podem não
  fechar por centavos, na mesma tela.
- **`viagens.routes.js:320-326`** — venda avulsa cria um cliente novo a cada
  `cliente_nome_avulso`, sem tentar casar com o cadastro. A mesma compradora em
  duas feiras vira dois clientes e o histórico dela racha ao meio. (Ver Parte 2:
  a Ficha do Cliente agora mostra esse histórico — o que torna a rachadura
  visível.)
- **`ViagemDetailPage.jsx:567`** — forma de pagamento é texto livre, enquanto o
  resto do sistema usa a tabela `listas`. "Pix", "PIX" e "pix " viram três
  linhas em qualquer quebra por forma de pagamento.

**Compras e Fornecedores: nenhum achado de cálculo.** Ticket médio é sempre
soma÷contagem; sem base devolve `null` e a tela imprime "—"; cancelados ficam
fora de todo total de forma consistente; agrupamento por `fornecedor_id`, não
por nome; lista e relatório montam o mesmo filtro. É o módulo mais bem-feito do
sistema nesse quesito.

---

# PARTE 2 — O QUE EU MEXI

## Defeitos que matavam funções inteiras

- **Sincronização de anúncios respondia 500, sempre.** `GET /anuncios/sincronizacao`
  estava declarada **depois** de `GET /anuncios/:id`, então "sincronizacao" era
  lida como um id. Movida para antes.
- **Métricas de marketplace liam `i.conectado`**, campo que não existe (o certo é
  `i.conectada`) — 6 ocorrências. A tela tratava toda loja como desconectada.
- **`.login-error` era usada em 77 lugares e não estava definida no CSS.** Toda
  mensagem de erro do sistema saía como texto solto, sem cor, sem caixa.
- **Bipagem: o campo de quantidade estava dentro do `<form>`.** Enter na
  quantidade submetia o formulário, e o leitor de código de barras manda Enter.
- **Promoções: a prévia usava `selecionados.length` como dependência.** Desmarcar
  um anúncio e marcar outro (mesmo tamanho) mantinha a prévia antiga — e a
  promoção era criada com o anúncio que você acabou de **tirar**.
- **Nove telas sem `.catch`**, mais nove no segundo lote e mais nove no terceiro
  (ver abaixo).

## O que já existia no banco e não tinha tela

Sete rotas prontas no servidor que nenhuma tela chamava:

| o que | rota |
|---|---|
| Extrato de movimentos da variante | `GET /estoque/movimentos?variante_id=` |
| Vendas da viagem | `GET /viagens/:id/vendas` |
| EANs já importados (listar e apagar) | `GET`/`DELETE /estoque/ean-mapeamento` |
| Editar kit manual | `PUT /kits/manuais/:id` |
| Ficha do insumo | `GET /insumos/:id` |
| Editar / excluir promoção | `PUT /promocoes/:id`, `POST /:id/excluir` |
| Acrescentar itens a uma promoção | `POST /promocoes/:id/itens` |

Mais duas coisas novas:

- **Histórico do cliente** (rota nova `GET /clientes/:id/historico`): quanto ele
  já comprou, quando foi a última vez, o que ele mais leva, por qual canal. A
  ficha do cliente era um catálogo de endereços.
- **Valor na lista de clientes**: "Total comprado" (com nº de pedidos e ticket
  médio embaixo) e "Última compra", as duas ordenáveis. A lista de cadastro vira
  lista de trabalho.
- **Duplicar pedido** (rota nova `POST /pedidos/:id/duplicar`): o cliente de
  atacado repete quase o mesmo mix todo mês. **Nada é recalculado** — os valores
  são copiados exatamente como estão gravados. Pedido de marketplace não é
  duplicável (a cópia entraria nos relatórios como venda da plataforma sem
  existir lá).

Três detalhes que valem menção porque cada um é um defeito silencioso:

- Um EAN errado guardado **bloqueia o EAN certo** numa importação seguinte (a
  coluna é UNIQUE) — e até agora não havia como vê-lo nem apagá-lo.
- O `PUT` de kit aceitava `itens: []`: apagava todas as peças e deixava um kit
  oco que a tela mostrava como R$ 0,00. Agora recusa, como o `POST` sempre
  recusou.
- A Saúde da Sincronização dizia "N resolvidas" e carregava as linhas do banco
  (30 dias) **para descartá-las**. Conferir se o pedido de ontem voltou é
  justamente o que faz alguém abrir a tela no dia seguinte.

## A tela em branco deixa de ser uma resposta

Nove telas chamavam a API sem **nenhum** tratamento de falha: Parâmetros,
Empresas, Custos Indiretos, Taxas de Venda, Listas, Central de Alertas, Ficha de
Precificação, Simulador e Taxas de Marketplace. Sessão expirada, servidor fora,
403 — a tela ficava em branco ou no estado inicial vazio, **indistinguível de
"não há nada cadastrado"**.

Os piores:

- **Pedido de venda** — `if (loading || !pedido) return null;`. Falhando, a tela
  ficava literalmente branca, sem uma palavra escrita.
- **Integrações** — "Carregando…" para sempre. Nessa tela isso parece "nenhuma
  loja conectada".
- **Buscas** (global, cliente, fornecedor, produto da viagem, variantes) —
  falhando, mantinham o resultado da busca **anterior** com o termo novo na
  caixa. Pior que lista vazia: é resposta errada com cara de certa.
- **Simulador e Ficha de Precificação** — uma simulação que falhava apenas não
  atualizava, e o painel seguia mostrando o cenário anterior como se fosse o
  novo. Numa tela de preço, é o defeito mais caro possível.

Saíram também os três últimos `alert()` nativos e o último `window.confirm` do
sistema.

## Estética e uso diário

- **Contraste:** `--ink-faint` estava em 2,92:1 (o mínimo legível é 4,5:1).
  Passou a 4,53:1.
- **Fonte tabular** (`--font-mono` com `tabular-nums`) aplicada globalmente a
  toda célula numérica — antes os R$ não alinhavam na coluna.
- **44 páginas usavam `<h2>` como título principal** e nenhuma tinha `<h1>`.
- **69 botões dentro de formulários sem `type="button"`** — cada um submetia o
  formulário ao ser clicado. **21 botões só de ícone sem nome acessível.**
- **Paletas de gráfico**: quatro telas tinham cores fixas no código, que ficavam
  ilegíveis no tema escuro. Todas passaram a usar `usePaletaGrafico`.
- **Rosca da Ficha de Precificação** deixou de "grampear" o prejuízo em zero — um
  produto no vermelho aparecia como se estivesse no zero a zero.
- **Fuso horário**: `hojeEmBrasilia()` novo no servidor e `hojeIso()` no cliente;
  cinco comparações `concluida_em::date` na conferência passaram a converter para
  `America/Sao_Paulo` antes de comparar. Antes das 21h isso não muda nada;
  depois das 21h, mudava o dia inteiro.
- **Conferência de pedidos**: os dois `window.prompt` viraram campos na própria
  tela; a aba de bipagem deixou de desmontar ao trocar de aba (perdia a fila).
- **"Disponível para vender"** contava saldo negativo de terceiros como se fosse
  peça em facção, inflando o número.

## O menu

Estoque tinha 10 abas numa fileira lisa, Marketplace 9, Configurações 9 — nada
distinguia a tela aberta todo dia da tela aberta uma vez por mês.

Agora cada página declara um grupo. **Sem página nova, sem rota nova, sem nome
mudado, sem tocar em permissão** (REGRA 4):

- **Estoque** — *Dia a dia* (Estoque · Bipagem · Onde Está a Peça) · *Para
  decidir* (Cobertura · Dinheiro Parado · Curva de Tamanho) · *Entradas e papel*
  (Importar Saldo · Importar EAN · Ficha de Estoque). Bipagem e "Onde Está a
  Peça" subiram: são as duas usadas **em pé, no galpão**, e estavam depois de
  duas telas de importação.
- **Marketplace** — *Dia a dia* (Conferência · Pedidos) · *Catálogo* (Anúncios ·
  Promoções) · *Resultado* (Lucratividade · Métricas · Taxas) · *Quando falta
  algo* (Importar Pedidos · Saúde da Sincronização).
- **Análises** — *Panorama* · *Preço* · *Tributário*.
- **Configurações** — os quatro grupos que o redesenho de 28/08 descreveu num
  comentário e o Shell nunca renderizou. Agora existem na tela.

## Rodar os testes deixa de mentir

Cada `teste-*.js` diz que roda "contra um Postgres LIMPO", e cada um semeia as
próprias referências. Rodando todos em sequência no mesmo banco — que é o que
qualquer pessoa faz — o segundo tropeça nos dados do primeiro.

Não é só barulho: **sete asserções de `teste-analises-rotas` falhavam dizendo
coisas que não são verdade** ("veio 6141,53" onde o teste esperava R$ 30,00).
Quem visse isso concluiria que a análise de dinheiro parado está quebrada. Não
está — as 28 asserções passam num banco limpo.

`npm test` cria um banco vazio por suíte, migra, roda e apaga. Nenhuma suíte foi
alterada. **18 de 18 passam.**

---

# PARTE 3 — O QUE EU SUGIRO E NÃO FIZ

Estas mudam URL, permissão ou o significado de um número. Nenhuma cabe numa
noite sem você olhar.

1. **Unificar as duas telas de Lucratividade** (Vendas › Lucratividade e
   Marketplace › Lucratividade). São a mesma pergunta com filtros diferentes, e
   hoje respondem números diferentes pelos itens 4 e 5 acima. Unificar sem antes
   resolver o item 4 só esconderia a divergência.
2. **Cobertura e Curva ABC: uma fórmula cada.** Escolher qual, e as telas
   passarem a chamar a mesma função. Hoje são duas de cada, e discordam.
3. **Cobertura por variante**, não por referência. É a cor e o tamanho que
   faltam, não a referência.
4. **Separar Insumos de Entradas por Nota** dentro de Compras. Hoje "Insumos e
   Notas" é uma aba só com três coisas dentro (cadastro, notas, fichas
   defasadas). O cadastro é semanal; a nota é diária.
5. **Ficha de Venda sair de Vendas.** É uma tela de impressão, não de venda —
   fica junto de Ficha de Estoque, em "papel".
6. **Levar Bipagem para dentro da Conferência.** As duas são a mesma pessoa, com
   o mesmo leitor, na mesma bancada. Hoje são módulos diferentes.
7. **Venda avulsa de viagem casar com o cadastro de clientes** antes de criar um
   novo (item da Parte 1). Agora que a Ficha do Cliente mostra o histórico, a
   rachadura ficou visível.

---

## Uma coisa que não é defeito e vale saber

`calcContext.js:18-19` soma o percentual de **todas** as taxas de venda ativas,
sem filtrar por canal — é o desenho do motor: uma configuração global de taxas
para a empresa. Se você tiver Mercado Livre, Shopee e TikTok cadastrados como
taxas ativas ao mesmo tempo, o preço mínimo de **toda** peça carrega os três
somados. A tela **Análises › Preço por Canal** existe exatamente para responder
por canal. Não mexi, e não é bug — mas se a soma das taxas ativas hoje não
corresponde a um canal real, o preço mínimo do sistema inteiro está mais alto do
que precisa.
