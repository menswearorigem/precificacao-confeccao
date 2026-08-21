# Ressalvas — redesenho da tela /login

Registro do que ficou de fora do redesenho da tela de login e por quê,
conforme a regra de segurança do próprio pedido: "se qualquer alteração
puder impedir alguém de entrar no sistema, não faça — registre aqui em vez
de simular."

## 1. Caixa "Manter conectado" (Bloco B.2)

**Não foi adicionada.**

O pedido era clara: só adicionar a caixa se o backend já suportar sessão
longa: caso contrário, documentar aqui em vez de simular.

Hoje o backend (`server/src/lib/authToken.js`) usa uma única duração de
sessão fixa para todo mundo — `SESSION_HOURS` (padrão 24×7 = 7 dias),
aplicada sempre, sem distinção entre "lembrar de mim" marcado ou não. Não
existe hoje um conceito de sessão curta vs. longa: toda sessão já dura os
mesmos 7 dias.

Adicionar a caixa de verdade (ou seja, fazendo-a alterar o comportamento
real) exigiria mudar autenticação, o que este pedido proibiu explicitamente:

- `authToken.js`: `createToken(usuarioId, { manterConectado })` teria que
  calcular dois `SESSION_HOURS` diferentes (ex.: sessão curta de algumas
  horas quando desmarcado, e a atual de 7 dias — ou mais — quando marcado).
- `auth.routes.js`: o `POST /auth/login` teria que receber um campo
  `manterConectado` no corpo da requisição e repassar pro `setSessionCookie`,
  que hoje sempre usa o mesmo `maxAge` fixo.

Sem isso, uma caixa "Manter conectado" no visual seria só decoração — ela
pareceria funcionar mas não mudaria nada de verdade. Por isso não entrou.

## 2. Link "Esqueci minha senha"

**Não foi adicionado.**

O mockup de referência anexado trazia esse link, mas só como proposta
visual — a própria nota do mockup já avisava que ele "só passa a funcionar
depois que [o dono] autorizar a parte de acesso, que mexe em autenticação".
O texto oficial do pedido (Blocos A e B) não pede esse link em nenhum dos
itens numerados.

Não existe hoje nenhum fluxo de recuperação de senha no backend (sem rota,
sem envio de e-mail, sem token de redefinição). Um link clicável que não
leva a lugar nenhum seria pior do que não ter o link — pareceria quebrado.
Se você quiser esse recurso, é um pedido novo (fluxo de recuperação de
senha), separado deste redesenho visual.

## O que foi feito sem ressalva

Todo o resto do Bloco A (composição, selo com a logo real
`/src/assets/logo-hbn-hub.png`, tipografia, cartão, animação de entrada,
responsivo) e do Bloco B (olho de mostrar/ocultar senha, autocomplete pro
gerenciador de senhas, formulário real com Enter enviando, mensagem de erro
em `role="alert"` acima dos campos sem revelar qual campo errou, estado de
carregamento/desabilitado, rótulos ligados por `htmlFor`/`id`) foi
implementado sem tocar em `POST /auth/login`, `POST /auth/setup`, rotas,
sessão ou schema de banco. O fluxo de login foi testado de ponta a ponta
(login real com Enter, redirecionamento, mensagem de erro com credenciais
erradas) depois da mudança e continua funcionando exatamente como antes.
