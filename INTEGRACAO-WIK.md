# Integração com o Wik Sistemas (ERP)

Documenta o comportamento da API do Wik confirmado pelo suporte técnico deles
e as decisões de projeto da sincronização automática de estoque/produtos/ficha
de custo (código em `server/src/lib/wik.js`, `wikSync.js`,
`wikProdutosImport.js`, `wikFichaCustoImport.js`, `routes/wik.routes.js`).

## Causa raiz confirmada pelo suporte da Wik (27/08/2026): TOKEN DUPLICADO

Rodadas anteriores de diagnóstico (24/08 e 26/08) tinham descartado a hipótese
de "sessão única" e chutado "acesso de dados revogado/suspenso" como causa dos
403 em toda chamada de dado. Essa hipótese também estava errada. O dono do
projeto ligou para o suporte técnico do Wik em 27/08/2026 e eles destravaram a
conta manualmente, explicando o mecanismo real: **a conta estava bloqueada por
TOKEN DUPLICADO no mesmo login** — e o próprio padrão de relogin-ao-detectar-403
que a rodada anterior tinha implementado aqui era exatamente o que causava o
bloqueio. Citação literal do suporte:

> "Se você ficar abrindo muito o login e ficar tentando usar simultaneamente,
> a gente vai travar o usuário."

> "A aplicação bloqueia. Ela está tentando algum tipo de ataque, por tentativa
> de login usar token que não está ativo."

E, sobre o que acontece quando dois tokens do mesmo login coexistem:

> "Se ela tentar usar o token antigo vai travar. E se muitas consultas
> tentarem usar o token antigo, vai travar esse usuário."

Ou seja: reagir a um 403 relogando (mesmo com limite de 1 a cada 10 minutos)
é o anti-padrão. Cada login novo gera um token novo; se qualquer parte do
sistema ainda estiver com o token anterior em memória e tentar usá-lo depois
que um outro login já rodou, isso é lido pelo Wik como "token duplicado" /
possível ataque, e a conta inteira é bloqueada.

### Disciplina de token daqui pra frente (regras ditadas pelo suporte)

1. **Logar UMA única vez e guardar o token** — nunca logar por operação, nunca
   logar em reação a uma falha.
2. **Renovar por AGENDA, nunca por reação a erro**: de 2 em 2 horas (nunca mais
   que isso), ou antecipadamente quando faltar 30 minutos para o campo
   `expiracao` que vem na resposta do login — o que vier primeiro.
3. **Troca atômica**: ao renovar, TODOS os consumidores passam a usar o token
   novo na mesma hora. Nenhum job pode segurar uma cópia própria do token em
   memória — existe um único provedor de token (`tokenBoxGlobal` em
   `wikSync.js`), consultado a cada chamada, nunca cacheado por job.
4. **Máximo 3 requisições por segundo**, com limitador de verdade (fila serial
   — ver seção abaixo).
5. **Ao receber 401/403 de token: PARAR, registrar e mostrar alerta na tela.
   NÃO relogar, NÃO retentar.** Entrar em modo degradado e esperar intervenção
   humana (abrir chamado com o suporte do Wik).

Essas 5 regras substituem por completo o mecanismo de relogin-on-403 (com ou
sem limite de 1/10min) das rodadas de 24–26/08 — esse mecanismo foi removido
do código.

### Implementação da disciplina (`server/src/lib/wikSync.js`)

- `tokenBoxGlobal`: objeto único `{ atual: token }` compartilhado por TODO o
  processo — não existe token por job.
- `renovarTokenAgora(integracao)`: faz o login de verdade e troca
  `tokenBoxGlobal.atual` de forma atômica (memória) + grava no banco
  (`access_token`, `token_renovado_em`). É o único lugar do código que faz um
  login real fora do botão de diagnóstico manual.
- `renovarTokenWikSeNecessario()`: função "gate" chamada por agenda (ver
  `WIK_TOKEN_CHECK_INTERVAL_MS` em `index.js`, a cada 10min) — só chama
  `renovarTokenAgora` se: não existe token ainda, ou já se passaram 2 horas
  desde a última renovação, ou faltam menos de 30 minutos para `expiracao`.
  Fora dessas condições não faz nenhuma chamada de rede.
- `obterTokenBoxAtual(integracao)`: accessor usado por todo consumidor de
  dado (estoque/produtos/ficha de custo) — nunca dispara login sozinho fora
  do bootstrap inicial se o box ainda estiver vazio.
- `esquecerTokenEmMemoria()`: chamado quando uma credencial nova é salva
  (`POST /wik`), pra garantir que o box em memória não sirva um token da
  credencial antiga depois da troca.
- **`chamarApi` (`wik.js`) nunca reloga nem retenta.** Ao classificar um erro
  como `token`, registra o evento (`aoDetectarTokenMorto`) e lança o erro na
  hora com `erro.causaWikToken = true` — quem chamou decide o que fazer
  (normalmente: aparece no selo/banner como `rejeitado`, sem nova tentativa).
- **Exceção deliberada**: os botões "Testar conexão" e "Testar conexão
  completa" (`POST /wik/testar`, `POST /wik/testar-completo`) SÃO permitidos
  a fazer um login de verdade via `renovarTokenAgora`, porque são acionados
  por uma pessoa clicando — não é reação automática a erro, é a "intervenção
  humana" que a regra 5 do suporte pede.

## Fila serial global (nunca duas chamadas Wik em voo ao mesmo tempo)

Um limitador de taxa (esperar entre chamadas) não impede, sozinho, que duas
chamadas fiquem *em voo* ao mesmo tempo se o código disparar duas em paralelo
(ex.: `Promise.all`). Como o próprio suporte confirmou que múltiplos acessos
simultâneos com o mesmo login/token derrubam a conta, a proteção agora tem
duas camadas complementares:

- **`enfileirarAcessoWik` (`wik.js`)**: fila-mutex por promise-chain — literal
  UMA requisição HTTP ao Wik (login ou qualquer endpoint) em voo por vez, no
  processo inteiro. Toda chamada passa por aqui, incluindo o login. Cada
  chamada tem timeout (`AbortSignal.timeout(25000)`, `sinalComTimeout()`) pra
  a fila nunca travar de vez se uma chamada específica ficar pendurada.
- **Login com single-flight** (`loginEmVoo`): se já existe um login em voo,
  quem chamar de novo recebe a MESMA promise, em vez de disparar um segundo
  login real — evita literalmente o cenário que gera "token duplicado".
- **Trava global de job por integração** (`reservarJobWik` /
  `liberarJobWik` / `jobAtivoNoMomento`, `wikSync.js`): claim atômico
  (`UPDATE ... WHERE`) nas colunas `wik_job_ativo` / `wik_job_ativo_desde` de
  `integracoes_wik` — nunca dois jobs do Wik (estoque, produtos, ficha de
  custo, testes, diagnósticos) rodando ao mesmo tempo, mesmo sob concorrência
  real entre processos/requisições (o Postgres serializa o UPDATE na mesma
  linha). Tem um timeout de 30min pra destravar sozinho se um processo morrer
  com o job "preso". Todas as rotas que disparam job em background
  (`/estoque/preview`, `/produtos/preview`, `/ficha-custo/preview`,
  `/testar`, `/testar-completo`, `/ficha-custo/diagnosticar`) reservam antes
  de começar e liberam no `finally`, devolvendo HTTP 409 se já tiver um job
  ativo.
- Chamadas antes paralelas (`Promise.all` de insumos+operações na ficha de
  custo) foram trocadas para sequenciais (`await` um de cada vez) como defesa
  redundante, mesmo com a fila de baixo nível já garantindo isso.

Essas duas camadas continuam valendo independente de qualquer decisão futura
sobre o mecanismo de token — são a parte mais importante da proteção contra
bloqueio, junto com a disciplina de renovação por agenda acima.

## Mapa de caminhos (reconfirmado pelo suporte, 27/08/2026)

A documentação oficial da Wik troca de lugar os dois prefixos de URL da API.
O suporte confirmou por telefone que a documentação deles está errada nesse
ponto e que vai ser corrigida do lado deles — até lá, valem os caminhos
testados na prática:

| Endpoint | Base correta |
|---|---|
| `saldo_estoque_get` | `apiwiki` |
| todos os demais endpoints | `wiki_v2` |

Chamar no caminho errado devolve **HTTP 404 "Recurso não Encontrado"**
(`body.errors.code = 40`) — não é erro de token, é erro de CAMINHO (ver
próxima seção). O mapa fica em `CAMINHO_POR_ENDPOINT`, no topo de
`server/src/lib/wik.js`.

## Classificação de erro por causa, nunca só pelo HTTP status

A API devolve tanto **HTTP 403** quanto **HTTP 200 com `body.status` 403**
para o MESMO erro de token — e a doc oficial da Wik só documenta 401 pra
token, o 403 nem consta lá. Por isso o código lê SEMPRE `body.status`, nunca
só `res.status` (`classificarErroWik` em `wik.js`). Três causas distintas:

- **TOKEN** (401/403, HTTP ou body): token rejeitado — NÃO reloga, NÃO
  retenta (ver disciplina de token acima). Registra e para.
- **CAMINHO** (404, HTTP ou body, ou `errors.code` 40): endpoint no prefixo
  errado — é bug de mapeamento, não de credencial.
- **PARÂMETRO** (400): faltou ou veio errado um parâmetro obrigatório.

Cada uma sai com uma mensagem prefixada ("Erro de CAMINHO...", "Erro de
PARÂMETRO...") pra nunca ficar ambíguo no log/tela qual dessas foi.

## Validade do token: SEMPRE `retorno.expiracao`, nunca calculada aqui

Rodadas anteriores chutaram durações fixas (4h, depois 1h) como padrão pra
quando a resposta de login não trouxesse a expiração explícita — achismo
proibido pela REGRA 2. O código (`wik.js`, `loginDeVerdade()`) só lê
`retorno.expiracao` — se o campo faltar ou vier num formato que não parseia,
`expiraEm` sai `null` e fica marcado `expiracaoSuspeita: true`, sem chutar
nenhum prazo. A margem de renovação antecipada é de 30 minutos antes da
expiração real (`MARGEM_ANTECIPADA_RENOVACAO_MS`, `wikSync.js`), e o teto
entre renovações é de 2 horas (`INTERVALO_MAXIMO_RENOVACAO_MS`) mesmo que o
token ainda não esteja perto de expirar.

## Modo degradado (a partir de 5 rejeições de token seguidas)

A partir de **5 rejeições consecutivas** de chamada de dado
(`rejeicoes_consecutivas_token`, `LIMIAR_MODO_DEGRADADO` em `wikSync.js`):

- Os ciclos automáticos (estoque/produtos/ficha de custo) passam a tentar
  **1x por hora** em vez do ritmo normal (`cicloDevePular`) — só pra reduzir
  tráfego inútil contra uma conta bloqueada, não afeta a renovação de token
  (que já é só por agenda, independente disso).
- Volta ao normal sozinho na primeira chamada de DADO bem-sucedida
  (`registrarSucessoWik` zera o contador) ou quando a credencial é salva de
  novo na tela (`POST /wik` também zera).

## Selo da tela e mensagens

- `ultima_tentativa`/`ultimo_erro`/`ultima_rejeicao_token` só são gravados
  por CHAMADAS DE DADO de verdade — login de rotina (renovação por agenda)
  não limpa nem grava esse estado, só `registrarSucessoWik` (chamado depois
  de uma operação de dado bem-sucedida) limpa.
- O selo (`calcularStatusToken`, compartilhado entre `wik.routes.js` e
  `estoque.routes.js`) reflete o resultado da ÚLTIMA CHAMADA DE DADO
  (`nao_testado` / `valido` / `rejeitado` / `erro_outro`), nunca a
  existência de um token no banco nem um teste de login isolado.
- Enquanto `rejeitado`, o banner de Estoque e o card de Integrações mostram:
  "O Wik bloqueou o acesso desta conta (geralmente por token duplicado) — é
  preciso abrir chamado no suporte da Wik pra destravar. Não adianta tentar
  de novo por aqui." — nada de relogin automático nem texto técnico cru, e
  destacam a data do último saldo sincronizado, porque quem olha estoque
  precisa saber que o número pode estar desatualizado.
- Jobs de importação (estoque/produtos/ficha de custo) que ficam presos em
  "rodando" além do próprio limiar de trava são corrigidos pra "erro" na
  hora de LER o status (`corrigirJobsPresos`), em vez de ficar mostrando
  "rodando" por horas.

## Botão de diagnóstico manual ("Testar conexão completa")

Reproduz na tela um teste isolado: 1 login (mostra
criação/expiração/usuarioMaster/empresaAcesso, nunca o token) → espera 2s →
1 chamada de `apiwiki/saldo_estoque_get` → 1 chamada de `wiki_v2/tamanhos_get`,
mostrando HTTP status, `body.status` e o corpo bruto de cada uma. Usa
`renovarTokenAgora` (o mesmo caminho atômico de troca que o agendador usa),
protegido pela trava global de job — não dispara em paralelo com nenhum
outro job do Wik. Não participa do modo degradado. Rota:
`POST /api/wik/testar-completo`.

## Regras oficiais da API (documentação + suporte da Wik)

- Limite de 3 requisições por segundo, valendo pra TODAS as chamadas
  autenticadas (login incluso) — reforçado pela fila serial, não só por um
  limitador de taxa.
- Não é permitido múltiplos acessos simultâneos com o mesmo token/login —
  confirmado por telefone como a causa raiz real do bloqueio (token
  duplicado), não só uma regra na letra da documentação.
- Token de validade de 4 horas — sempre lido de `retorno.expiracao`, nunca
  calculado por conta própria; renovação por agenda (2h/2h ou 30min antes de
  expirar), nunca em reação a erro.
- É necessária permissão de administrador em todos os endpoints usados aqui.
- É necessário ativar o produto para integração no painel do Wik (ajuste do
  lado deles, fora do nosso controle).
- A doc oficial só documenta 401 pra erro de token — o 403 (usado na
  prática, inclusive com HTTP 200 e `body.status` 403) não consta na
  documentação.
- A doc oficial troca os prefixos `apiwiki`/`wiki_v2` de lugar — confirmado
  como erro da própria documentação pelo suporte, correção prometida do lado
  deles.

## Tipos de pessoa (tabela de referência do Wik)

Usada nos endpoints de pessoa/cliente/fornecedor do Wik:

| Código | Tipo |
|---|---|
| 1 | Cliente |
| 2 | Fornecedor |
| 3 | Assessor |
| 4 | Funcionário |
| 5 | Vendedor |

## Onde mexer

- `server/src/lib/wik.js`: cliente HTTP baixo nível, `enfileirarAcessoWik`
  (fila serial global), `loginEmVoo`/`loginDeVerdade` (single-flight de
  login), `CAMINHO_POR_ENDPOINT` (mapa explícito de base por endpoint),
  `classificarErroWik` (token/caminho/parâmetro), `chamarApi` (nunca reloga
  nem retenta em erro de token) e `chamarBrutoDiagnostico` (usado só pelo
  botão de diagnóstico manual).
- `server/src/lib/wikSync.js`: `tokenBoxGlobal`/`renovarTokenAgora`/
  `renovarTokenWikSeNecessario`/`obterTokenBoxAtual`/`esquecerTokenEmMemoria`
  (disciplina de token só por agenda), `reservarJobWik`/`liberarJobWik`/
  `jobAtivoNoMomento` (trava global de job por integração),
  `registrarTentativaWik`/`registrarFalhaWik`/`registrarSucessoWik`
  (registro de tentativa/erro/sucesso), `cicloDevePular`/`emModoDegradado`
  (modo degradado), `calcularStatusToken` (selo compartilhado) e
  `corrigirJobsPresos` (jobs presos em "rodando").
- `server/src/index.js`: `renovarTokenWikSeNecessario` chamado por
  `setInterval` a cada 10min (`WIK_TOKEN_CHECK_INTERVAL_MS`) — único
  disparador de renovação de token fora dos botões de teste manual.
- `server/src/routes/wik.routes.js`: `/testar` e `/testar-completo` usam
  `renovarTokenAgora` (login real permitido, é ação humana). `POST /`
  (salvar credencial) chama `esquecerTokenEmMemoria()` pra não deixar o box
  em memória servindo o token da credencial antiga. Rotas de preview/job
  reservam e liberam a trava global de job.
- `client/src/components/WikIntegracaoCard.jsx` e `WikStatusBanner.jsx`:
  selo de status e mensagem "token duplicado" na tela quando `rejeitado`.
