# Integração com o Wik Sistemas (ERP)

Documenta o comportamento da API do Wik observado em produção e as
decisões de projeto da sincronização automática de estoque/produtos/ficha
de custo (código em `server/src/lib/wik.js`, `wikSync.js`,
`wikProdutosImport.js`, `wikFichaCustoImport.js`, `routes/wik.routes.js`).

## Por que a API do Wik rejeita um token que parece válido — HIPÓTESE, não fato

Diagnóstico de produção (24/08): a sincronização passou a devolver 403
"token inválido ou expirado" em `saldo_estoque_get` logo depois de o dono
do projeto logar na tela do Wik pelo navegador usando a MESMA credencial
cadastrada aqui na integração. O `token_expira_em` gravado localmente ainda
estava no futuro — ou seja, pelo relógio daqui o token continuava
"válido", mas o Wik rejeitou a chamada mesmo assim.

Um segundo diagnóstico (26/08) mostrou um caso que essa explicação sozinha
não cobre: um login manual (Testar conexão) funcionou às 09:41 emitindo um
token novo, e a MESMA chamada de dado foi rejeitada por esse token novo já
às 09:42 — um minuto depois, sem ninguém ter logado na web nesse intervalo
(pelo que se sabe).

**Não temos como confirmar a causa raiz — há pelo menos duas hipóteses
compatíveis com o que foi observado:**

1. **Sessão única por usuário**: logar na interface web do Wik com a mesma
   credencial usada pela integração invalida o token da API (e um relogin
   forçado feito pela integração derrubaria de volta quem estiver na web).
   Explica o primeiro diagnóstico, mas não explica sozinha o segundo (não
   há evidência de alguém logando na web naquele minuto específico).
2. **Falta de permissão de API para `saldo_estoque_get`** (ou outro
   endpoint específico): o login em si funciona, mas o endpoint de dado
   rejeita o token por um motivo de permissão/configuração da conta,
   independente de sessão. Explicaria o segundo diagnóstico (reautenticar
   não resolve nada se o problema é permissão, não sessão).

O sistema não escolhe entre as duas — ele reage do mesmo jeito nos dois
casos (ver seção abaixo) e deixa o sinal mais forte de qual delas é a real
para quem tem acesso ao painel do Wik: se as rejeições continuarem
acontecendo mesmo logo depois de uma reautenticação bem-sucedida (o
sistema registra isso com uma mensagem própria, ver `causaWikToken` em
`wik.js`), isso pesa mais pra hipótese 2 (permissão) do que pra hipótese 1
(sessão).

### Recomendação: credencial de API dedicada

Nos dois cenários acima, **o ideal é cadastrar aqui um usuário do Wik que
NINGUÉM usa pela interface web** — só a integração loga com ele. Se a causa
for sessão única (hipótese 1), isso elimina o cabo de guerra por completo.
Se a causa for permissão (hipótese 2), uma credencial dedicada também ajuda
indiretamente: fica mais fácil auditar/ajustar as permissões dela sem medo
de afetar o acesso de uma pessoa de verdade.

## Como o sistema reage a um token rejeitado

- Qualquer chamada à API do Wik (estoque, produtos, ficha de custo, teste
  de conexão) que receber 401/403 com sinal de token morto (mensagem
  contendo "token" + "inválido"/"expirado", não só o `type: "Token"` da
  documentação oficial — o texto real visto em produção nem sempre traz
  esse campo) descarta o token em cache, faz login de novo e repete a
  MESMA chamada uma única vez. Se a segunda tentativa também falhar, o
  erro é gravado e a sincronização daquele ciclo é interrompida.
- Para não entrar em loop de relogin, só é permitido **1 login forçado a
  cada 10 minutos**, não importa quantas chamadas dentro do mesmo ciclo
  rejeitem o token. Se o token for rejeitado de novo dentro desses 10
  minutos, a chamada falha direto (sem tentar logar de novo) com uma
  mensagem explicando o motivo.
  - Essa trava é **limpa por um login manual bem-sucedido** ("Testar
    conexão" ou salvar uma credencial nova) — sem isso, uma trava deixada
    por um relogin forçado anterior podia bloquear a recuperação automática
    mesmo logo depois de confirmar manualmente que o login funciona (foi
    exatamente o bug visto em produção em 26/08: login manual às 09:41
    funcionou, a chamada de dado foi rejeitada às 09:42, e a trava recusou
    a nova tentativa).
  - Reautenticar com sucesso e a MESMA chamada ser rejeitada de novo com o
    token novo é tratado como um problema DISTINTO do bloqueio de trava —
    não é cabo de guerra (a reautenticação acabou de funcionar), é
    registrado com sua própria mensagem (ver `causaWikToken` em `wik.js`).
- A classificação de "isso foi causado por rejeição de token" olha pra
  CAUSA RAIZ do erro (`erro.causaWikToken`, marcado no momento em que a
  rejeição é detectada), não só o texto da última mensagem — a mensagem
  final de uma falha pode ser a do bloqueio de trava, não o 403 original,
  e checar só o texto perdia a classificação.
- `ultima_tentativa`/`ultimo_erro`/`ultima_rejeicao_token` só são gravados
  por CHAMADAS DE DADO de verdade (estoque, produtos, ficha de custo) —
  "Testar conexão" é só um login e nunca grava aqui, porque um login
  bem-sucedido não prova que uma chamada de dado real (saldo_estoque_get)
  vai funcionar. Essa separação existe porque, sem ela, o selo da tela
  virava "verde" só por causa de um login isolado, mesmo que a última
  sincronização de verdade tivesse falhado.
- Cada rejeição de token específica é logada em `wik_token_rejeicoes` —
  a tela mostra quantas rejeições aconteceram nas últimas 24h e sugere a
  credencial dedicada quando esse número está alto.
- O selo da tela reflete o resultado da ÚLTIMA CHAMADA DE DADO
  (`nao_testado` / `valido` / `rejeitado` / `erro_outro`), não a existência
  de um token no banco nem o resultado de um teste de login isolado.

## Duração real do token: 1 hora, não 4h

Confirmado em produção (26/08): um token emitido às 09:41 veio com
"válido até 26/08/2026, 10:41:15" — exatamente 1h. O código antes assumia
~4h como padrão quando a resposta de login não trazia a data de expiração
explícita, e usava 5min de margem de renovação — os dois valores foram
revistos: fallback de expiração em 1h (`wik.js`, `login()`) e margem de
renovação de 10min (`wikSync.js`, `obterTokenValido`).

## Onde mexer

- `server/src/lib/wik.js`: cliente HTTP baixo nível, limitador de taxa
  (3 req/s, limite duro documentado pelo Wik), detecção de token morto,
  o retry único por chamada e a marcação `causaWikToken` na causa raiz.
- `server/src/lib/wikSync.js`: `registrarTentativaWik` /
  `registrarFalhaWik` / `registrarSucessoWik` (registro de
  tentativa/erro/sucesso, usado por toda sincronização de dado) e
  `criarOpcoesTokenComLimite` (o limite de 1 relogin/10min).
- `server/src/routes/wik.routes.js`: `/testar` e `POST /` (salvar
  credencial) limpam a trava de reautenticação em login bem-sucedido, mas
  NÃO tocam nas colunas de status de chamada de dado.
- `client/src/components/WikIntegracaoCard.jsx`: selo de status na tela de
  configuração.
