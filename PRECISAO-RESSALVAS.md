# Ressalvas — Onda 4 (Inteligência do sistema)

Formato pedido no Bloco 0 do prompt da Onda 4: cada entrada traz o que foi
pedido, por que não foi feito do jeito pedido, o que seria preciso pra
fazer direito, e o que foi feito no lugar (ou "nada").

## 1. Gráfico de composição de custo no Dashboard Executivo (TAREFA 4.1)

**O QUE FOI PEDIDO:** um gráfico de composição de custo (material / mão de
obra / indireto) no novo Dashboard Executivo, no mesmo espírito do donut
que já existe na Ficha de Precificação.

**POR QUE NÃO FIZ:** a própria Onda 4 manda medir isso primeiro (TAREFA
4.0), e a auditoria de qualidade do dado mostrou que só 3 de 67 referências
cadastradas neste ambiente têm custo de material maior que zero — as
outras 64 têm material zerado ou preço sugerido zerado por falta de dado.
Um gráfico de composição agregando isso mostraria "material ≈ 0% do custo,
mão de obra ≈ 100%" pra quase toda a operação — tecnicamente a soma exata
do que está cadastrado, mas praticamente uma leitura errada (não é que a
operação não usa material, é que o dado não foi preenchido). Isso é
exatamente o cenário que o prompt descreve como proibido: "o número
estaria tecnicamente certo e praticamente errado".

**O QUE SERIA PRECISO:** cadastrar o valor unitário dos materiais nas
referências que já têm material cadastrado com quantidade > 0 (a lista
exata está em `/qualidade-dados`, seção "Material cadastrado com valor
unitário zerado") e completar o custo das referências com preço sugerido
zerado. Só depois disso o gráfico de composição passa a refletir a
operação de verdade.

**O QUE FIZ NO LUGAR:** nenhum gráfico de composição de custo no Dashboard
Executivo. No lugar, o rodapé do painel traz o `<SeloDeConfianca>` com o
link direto pra auditoria completa, e a auditoria já está pronta e visível
em `/qualidade-dados`. Quando o dado estiver completo o bastante (a
auditoria mostrar a maioria das referências com custo de material
positivo), o gráfico pode ser adicionado — é só ligar a mesma composição
que a Ficha de Precificação já calcula por referência, agora somada pro
período.

## 2. Margem consolidada e rankings por produto excluem pedidos com custo incompleto

Não é bem uma ressalva de "não fiz" — é uma decisão de precisão que TOMEI,
registrada aqui porque muda o número exibido em relação ao que o motor
`calcularRelatorioPedidos` (usado por Vendas/Marketplace › Lucratividade)
mostra hoje. Esse motor, ao montar `totalGeral`, trata item sem custo de
produção conhecido como custo zero — o que já era assim antes desta onda e
não foi alterado (proibido mexer na fórmula). Só que o Bloco 0 desta onda
pede explicitamente o oposto pro Dashboard Executivo: "pedido sem custo de
produção conhecido NÃO entra no cálculo de lucro". Resolvi o conflito
assim: o Dashboard Executivo recalcula seus PRÓPRIOS totais (margem
consolidada, ranking por produto, vendas por canal) filtrando fora todo
pedido com `custoIncompleto = true` ANTES de somar — usando os mesmos
números de receita/lucro por pedido que o motor já calculou, só mudando
quais pedidos entram na soma. O quanto ficou de fora aparece no
`<SeloDeConfianca>` ("N pedidos com custo de produção incompleto").

---

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

**Atualização (Onda 4.3): implementado.** O dono autorizou explicitamente
mexer em autenticação pra isso. Agora existe fluxo completo:
`POST /auth/esqueci-senha` (recebe o nome de usuário, gera um token de
uso único válido por 1h, guarda só o hash sha256 dele, envia por e-mail
via SMTP) e `POST /auth/redefinir-senha` (valida o token, troca a senha,
marca o token como usado). Telas `/esqueci-senha` e `/redefinir-senha` no
front, e o link "Esqueci minha senha" agora aparece de verdade na tela de
login. Ver DEPLOY.md pra configurar as variáveis SMTP_* — sem elas, o
token é gerado mas o e-mail não sai (só um aviso no log do servidor).

Login continua por nome (LOG-02 permanece fora de escopo, por pedido
explícito do dono).

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
