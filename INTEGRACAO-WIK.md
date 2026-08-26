# Integração com o Wik Sistemas (ERP)

Documenta o comportamento da API do Wik observado em produção e as
decisões de projeto da sincronização automática de estoque/produtos/ficha
de custo (código em `server/src/lib/wik.js`, `wikSync.js`,
`wikProdutosImport.js`, `wikFichaCustoImport.js`, `routes/wik.routes.js`).

## O Wik parece usar sessão única por usuário

Diagnóstico de produção (24/08): a sincronização passou a devolver 403
"token inválido ou expirado" em `saldo_estoque_get` logo depois de o dono
do projeto logar na tela do Wik pelo navegador usando a MESMA credencial
cadastrada aqui na integração (`arthur@hebron`). O `token_expira_em`
gravado localmente ainda estava no futuro — ou seja, pelo relógio daqui o
token continuava "válido", mas o Wik já tinha derrubado a sessão da API do
lado deles.

Conclusão prática (não documentada oficialmente pelo Wik, inferida do
comportamento observado): **logar na interface web do Wik com a mesma
credencial usada pela integração invalida o token da API**, e cada login
feito pela integração (relogin forçado) provavelmente derruba de volta
quem estiver usando a interface web naquele momento. É um "cabo de guerra"
de sessão, não um bug pontual.

### Recomendação: credencial de API dedicada

**O ideal é cadastrar aqui um usuário do Wik que NINGUÉM usa pela
interface web** — só a integração loga com ele. Isso elimina o cabo de
guerra por completo: a integração pode relogar quando quiser sem nunca
derrubar uma pessoa de verdade, e a pessoa pode logar na web com o próprio
usuário dela sem nunca derrubar a integração.

Sem uma credencial dedicada, o sintoma vai continuar aparecendo toda vez
que alguém logar na web com o mesmo usuário da integração — a mitigação
abaixo reduz o atrito, mas não resolve a causa.

## Como o sistema reage a um token rejeitado

- Qualquer chamada à API do Wik (estoque, produtos, ficha de custo, teste
  de conexão) que receber 401/403 com sinal de token morto (mensagem
  contendo "token" + "inválido"/"expirado", não só o `type: "Token"` da
  documentação oficial — o texto real visto em produção nem sempre traz
  esse campo) descarta o token em cache, faz login de novo e repete a
  MESMA chamada uma única vez. Se a segunda tentativa também falhar, o
  erro é gravado e a sincronização daquele ciclo é interrompida.
- Para não entrar em loop de relogin (o cabo de guerra descrito acima), só
  é permitido **1 login forçado a cada 10 minutos**, não importa quantas
  chamadas dentro do mesmo ciclo rejeitem o token. Se o token for
  rejeitado de novo dentro desses 10 minutos, a chamada falha direto (sem
  tentar logar de novo) com uma mensagem explicando o motivo.
- `ultima_tentativa` é gravada em TODA chamada (sucesso ou falha) — antes
  só existia `ultima_sincronizacao` (só sucesso), o que tornava impossível
  saber se um ciclo automático ou um clique manual sequer chegou a rodar
  (o texto de erro ficava idêntico por dias).
- Cada rejeição de token específica é logada em `wik_token_rejeicoes` —
  a tela mostra quantas rejeições aconteceram nas últimas 24h e sugere a
  credencial dedicada quando esse número está alto.
- O selo da tela reflete o resultado da ÚLTIMA tentativa de verdade
  (`nao_testado` / `valido` / `rejeitado` / `erro_outro`), não apenas "existe
  uma string de token gravada no banco" — antes esses dois estados eram
  independentes, o que fazia o selo "Token válido" aparecer ao lado de
  "última tentativa falhou".

## Onde mexer

- `server/src/lib/wik.js`: cliente HTTP baixo nível, limitador de taxa
  (3 req/s, limite duro documentado pelo Wik), detecção de token morto e
  o retry único por chamada.
- `server/src/lib/wikSync.js`: `registrarTentativaWik` /
  `registrarFalhaWik` / `registrarSucessoWik` (registro de
  tentativa/erro/sucesso, usado por toda sincronização) e
  `criarOpcoesTokenComLimite` (o limite de 1 relogin/10min).
- `client/src/components/WikIntegracaoCard.jsx`: selo de status na tela de
  configuração.
