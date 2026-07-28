# Precificação Confecção

Sistema de formação de preço de venda para a indústria de confecção (Miss
Manu, Origem, Hoggar, Hebron), substituindo a planilha de precificação.

## Stack

- **Backend:** Node.js + Express, API REST, Postgres (via `pg`)
- **Frontend:** React (Vite)
- **Deploy:** Render (Web Service + Postgres gerenciado)

## Estrutura do repositório

```
server/           API Express
  src/
    app.js        Monta rotas e middlewares
    index.js      Ponto de entrada (lê .env, sobe o servidor)
    db/
      pool.js         Pool de conexão Postgres
      migrate.js       Executa as migrations em server/src/db/migrations
      migrations/      Arquivos .sql, aplicados em ordem e uma única vez
    middleware/
      auth.js      Verifica o cookie de sessão
    lib/
      authToken.js Cria/valida o token de sessão assinado (HMAC)
    routes/        Um arquivo de rotas por recurso da API
client/            Frontend React (Vite)
  src/
    pages/         Uma tela por módulo do sistema
    components/    Shell (cabeçalho/menu) e componentes de formulário
    api/client.js  Wrapper de fetch para a API
    styles/theme.css  Paleta terrosa/couro, tipografia serifada + monoespaçada
```

Em produção, o Express serve o build do React (`client/dist`) diretamente —
um único serviço no Render, como no projeto `conferencia-de-pedidos`.

## Rodando localmente

Pré-requisitos: Node 18+, Postgres rodando localmente.

```bash
# 1. instalar dependências (server + client, é um workspace)
npm install

# 2. criar o banco local
createdb precificacao_confeccao

# 3. configurar variáveis de ambiente do servidor
cp server/.env.example server/.env
# edite server/.env com a DATABASE_URL do seu Postgres local,
# e defina APP_PASSWORD/SESSION_SECRET (podem ser qualquer coisa em dev)

# 4. aplicar as migrations (cria as tabelas e os dados padrão)
npm run migrate

# 5. rodar o backend (porta 3000) e o frontend (porta 5173) em dois terminais
npm run dev:server
npm run dev:client
```

Acesse http://localhost:5173 (o Vite já faz proxy de `/api` para o
backend). A senha de login é a que você definiu em `APP_PASSWORD`.

## Status do desenvolvimento

- [x] Etapa 1 — estrutura do repositório, banco de dados e API base
      (autenticação, configurações, empresas/regimes tributários, listas
      editáveis, taxas de venda, custos indiretos)
- [ ] Etapa 2 — cadastro de produto, materiais, custos industriais, custo
      total e formação de preço
- [ ] Etapa 3 — importação em massa
- [ ] Etapa 4 — simulador de cenários e dashboard executivo
- [ ] Etapa 5 — kits e ficha técnica
- [ ] Etapa 6 — ajustes visuais finais + guia de deploy no Render
