# Integração com o Wik Sistemas (ERP)

Documenta o comportamento da API do Wik confirmado por teste direto e as
decisões de projeto da sincronização automática de estoque/produtos/ficha
de custo (código em `server/src/lib/wik.js`, `wikSync.js`,
`wikProdutosImport.js`, `wikFichaCustoImport.js`, `routes/wik.routes.js`).

## Causa raiz confirmada (27/08/2026): acesso de DADOS revogado, não sessão

Diagnóstico de produção em duas rodadas (24/08 e 26/08) tinha levantado a
hipótese de "sessão única por usuário" (logar na web derrubaria o token da
API). Essa hipótese foi **descartada** por um teste direto na API, feito
fora do sistema, por PowerShell, com um login ISOLADO (nada mais rodando,
ninguém na web) e uma chamada por vez:

```
Login OK
  criacao       : 2026-08-27 11:44:38
  expiracao     : 2026-08-27 15:44:38     ← 4 HORAS de validade real
  usuarioMaster : 1
  empresaAcesso : 192,193,198,202

Com esse token, segundos depois:
  GET /api/apiwiki/saldo_estoque_get?empId=202&pagina=1
      → HTTP 403  {"errors":{"code":0,"type":"Token","message":"token inválido ou expirado!"},"status":403}
  GET /api/wiki_v2/operacoes_get
      → HTTP 200 com body.status 403, mesmo erro de token
  GET /api/wiki_v2/tamanhos_get
      → HTTP 200 com body.status 403, mesmo erro de token
```

Ou seja: **o login sempre funciona**, mas **toda chamada de DADO é
rejeitada**, mesmo com uma credencial isolada que ninguém mais está usando.
A conclusão do dono do projeto (chamado já aberto com o Wik): o acesso de
dados da conta foi revogado ou suspenso do lado deles em algum momento
próximo a 17/08/2026 — não é comportamento do nosso código, e reautenticar
não resolve nada nesse estado (a hipótese de "sessão única" NÃO explica um
login isolado sendo rejeitado da mesma forma).

### Recomendação: credencial de API dedicada

Mesmo com a causa raiz sendo revogação de acesso (não sessão), continua
valendo cadastrar aqui um usuário do Wik dedicado só à integração — facilita
auditar/ajustar as permissões dela junto ao suporte do Wik sem depender da
conta de uma pessoa.

## Mapa de caminhos (item verificado por teste direto, 27/08/2026)

A documentação oficial da Wik troca de lugar os dois prefixos de URL da API
e não avisa. Testado na prática, endpoint por endpoint:

| Endpoint | Base correta | Confirmado |
|---|---|---|
| `saldo_estoque_get` | `apiwiki` | ✅ teste direto 27/08 |
| `produto_get` | `wiki_v2` | ✅ |
| `tamanhos_get` | `wiki_v2` | ✅ teste direto 27/08 |
| `operacoes_get` | `wiki_v2` | ✅ teste direto 27/08 |
| `insumosfichatecnica_get` | `wiki_v2` | herdado (não testado isoladamente) |
| `operacoesfichatecnica_get` | `wiki_v2` | herdado (não testado isoladamente) |
| `materiaprima_get` | `wiki_v2` | herdado (não testado isoladamente) |
| `categoria_get` | `wiki_v2` | herdado (não testado isoladamente) |
| `cor_get` | `wiki_v2` | herdado (não testado isoladamente) |

Chamar no caminho errado devolve **HTTP 404 "Recurso não Encontrado"**
(`body.errors.code = 40`) — não é erro de token, é erro de CAMINHO (ver
próxima seção). O mapa fica em `CAMINHO_POR_ENDPOINT`, no topo de
`server/src/lib/wik.js` — qualquer endpoint novo deveria ser testado
isoladamente e adicionado lá antes de usado de verdade, em vez de assumir.

## Classificação de erro por causa, nunca só pelo HTTP status

Confirmado por teste direto: a API devolve tanto **HTTP 403** quanto **HTTP
200 com `body.status` 403** para o MESMO erro de token — e a doc oficial da
Wik só documenta 401 pra token, o 403 nem consta lá. Por isso o código lê
SEMPRE `body.status`/`body.success`, nunca só `res.status`, e trata 403
igual a 401 (`classificarErroWik` em `wik.js`). Três causas distintas:

- **TOKEN** (401/403, HTTP ou body): token morto — dispara relogin (sujeito
  ao limite/modo degradado abaixo).
- **CAMINHO** (404, HTTP ou body, ou `errors.code` 40): endpoint no prefixo
  errado — não tenta relogar, é um bug de mapeamento, não de credencial.
- **PARÂMETRO** (400): faltou ou veio errado um parâmetro obrigatório.

Cada uma sai com uma mensagem prefixada ("Erro de CAMINHO...", "Erro de
PARÂMETRO...") pra nunca ficar ambíguo no log/tela qual dessas foi.

## Validade do token: SEMPRE `retorno.expiracao`, nunca calculada aqui

Rodadas anteriores chutaram durações fixas (4h, depois 1h) como padrão pra
quando a resposta de login não trouxesse a expiração explícita — os dois
eram achismo (REGRA 2 proíbe inventar dado que não veio da fonte). O teste
direto de 27/08 confirmou o valor real: **4 horas exatas** entre `criacao` e
`expiracao`. O código (`wik.js`, `login()`) agora só lê `retorno.expiracao`
— se o campo faltar ou vier num formato que não parseia, `expiraEm` sai
`null` (tratado como já expirado, sem chutar nenhum prazo) e fica registrado
em `ultima_expiracao_suspeita`. Margem de renovação: 10 minutos
(`wikSync.js`, `obterTokenValido`).

## Modo degradado (a partir de 5 rejeições de token seguidas)

Em 24h chegou a 224 rejeições de token — cerca de uma a cada 6 minutos,
tráfego inútil contra uma conta com acesso revogado, e um risco de ser lido
como abuso pelo fornecedor. A partir de **5 rejeições consecutivas**
(`rejeicoes_consecutivas_token`, `LIMIAR_MODO_DEGRADADO` em `wikSync.js`):

- Os ciclos automáticos (estoque/produtos/ficha de custo) passam a tentar
  **1x por hora** em vez do ritmo normal (`cicloDevePular`).
- O relogin forçado dentro de um ciclo é **desativado** (`renovarToken`
  recusa na hora, sem nem checar a trava de 10min) — sem sentido insistir
  em relogar quando já sabemos que o login não é o problema.
- Volta ao normal sozinho na primeira chamada de DADO bem-sucedida
  (`registrarSucessoWik` zera o contador) ou quando a credencial é salva de
  novo na tela (`POST /wik` também zera).

## Selo da tela e mensagens

- `ultima_tentativa`/`ultimo_erro`/`ultima_rejeicao_token` só são gravados
  por CHAMADAS DE DADO de verdade — "Testar conexão" é só um login e nunca
  grava aqui, porque login bem-sucedido não prova que uma chamada de dado
  real vai funcionar. `obterTokenValido` (usado por TODOS os ciclos) também
  não limpa esse estado num login de rotina — só `registrarSucessoWik`
  (chamado depois de uma operação de dado bem-sucedida) limpa.
- O selo (`calcularStatusToken`, compartilhado entre `wik.routes.js` e
  `estoque.routes.js`) reflete o resultado da ÚLTIMA CHAMADA DE DADO
  (`nao_testado` / `valido` / `rejeitado` / `erro_outro`), nunca a
  existência de um token no banco nem um teste de login isolado.
- Enquanto `rejeitado`, o banner de Estoque e o card de Integrações mostram
  uma mensagem honesta (sem texto técnico cru) explicando que o login
  funciona mas os dados são recusados, e destacam a data do último saldo
  sincronizado — quem olha estoque precisa saber que o número pode estar
  desatualizado.
- Jobs de importação (estoque/produtos/ficha de custo) que ficam presos em
  "rodando" além do próprio limiar de trava (10min estoque, 30min
  produtos/ficha) são corrigidos pra "erro" na hora de LER o status
  (`corrigirJobsPresos`), em vez de ficar mostrando "rodando" por horas.

## Trava de reautenticação (1 relogin forçado / 10min)

Independente do modo degradado acima: dentro de QUALQUER ciclo, no máximo 1
login forçado a cada 10 minutos, pra não bater relogin a cada chamada
paginada. Login manual bem-sucedido ("Testar conexão" ou salvar credencial
nova) LIMPA essa trava — sem isso, uma trava deixada por um relogin forçado
anterior podia bloquear a recuperação automática mesmo logo depois de
confirmar manualmente que o login funciona.

## Botão de diagnóstico manual ("Testar conexão completa")

Reproduz na tela o mesmo teste feito por PowerShell fora do sistema: 1
login (mostra criação/expiração/usuarioMaster/empresaAcesso, nunca o token)
→ espera 2s → 1 chamada de `apiwiki/saldo_estoque_get` → 1 chamada de
`wiki_v2/tamanhos_get`, mostrando HTTP status, `body.status` e o corpo bruto
de cada uma. Não participa do job/status normal da integração (não conta
pro modo degradado, não é bloqueado por ele) — é diagnóstico isolado pra não
depender de terminal na próxima vez. Rota: `POST /api/wik/testar-completo`.

## Regras oficiais da API (documentação da Wik)

- Limite de 3 requisições por segundo, valendo pra TODAS as chamadas
  autenticadas (login incluso).
- Não é permitido múltiplos acessos simultâneos com o mesmo token/login.
- Token de validade de 4 horas (ver seção de validade acima — sempre lido
  de `retorno.expiracao`, nunca calculado por conta própria).
- É necessária permissão de administrador em todos os endpoints usados
  aqui.
- É necessário ativar o produto para integração no painel do Wik (ajuste do
  lado deles, fora do nosso controle).
- A doc oficial só documenta 401 pra erro de token — o 403 (usado na
  prática, inclusive com HTTP 200 e `body.status` 403) não consta na
  documentação.

## Onde mexer

- `server/src/lib/wik.js`: cliente HTTP baixo nível, limitador de taxa
  (3 req/s), `CAMINHO_POR_ENDPOINT` (mapa explícito de base por endpoint),
  `classificarErroWik` (token/caminho/parâmetro), a marcação
  `causaWikToken` na causa raiz, e `chamarBrutoDiagnostico` (usado só pelo
  botão de diagnóstico manual).
- `server/src/lib/wikSync.js`: `registrarTentativaWik` /
  `registrarFalhaWik` / `registrarSucessoWik` (registro de
  tentativa/erro/sucesso), `criarOpcoesTokenComLimite` (limite de
  1 relogin/10min + modo degradado), `cicloDevePular`/`emModoDegradado`
  (modo degradado), `calcularStatusToken` (selo compartilhado) e
  `corrigirJobsPresos` (jobs presos em "rodando").
- `server/src/routes/wik.routes.js`: `/testar` e `POST /` (salvar
  credencial) limpam a trava de reautenticação e o contador de rejeições
  seguidas em login bem-sucedido, mas NÃO tocam nas colunas de status de
  chamada de dado. `/testar-completo` é o botão de diagnóstico manual.
- `client/src/components/WikIntegracaoCard.jsx` e `WikStatusBanner.jsx`:
  selo de status e mensagens honestas na tela.
