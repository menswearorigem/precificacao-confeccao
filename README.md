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

## Módulos

1. **Configurações** — metas de margem, limites de alerta, parâmetros de kit
2. **Empresas** — uma por PJ/regime tributário (Simples Nacional, Lucro
   Presumido ou Lucro Real), cada produto é associado a uma delas
3. **Listas** — categorias, marcas, coleções, linhas, materiais, unidades e
   tipos de custo industrial, editáveis pela interface
4. **Taxas de venda** e **Custos indiretos** (rateio mensal)
5. **Produtos** — cadastro, materiais, custos industriais, custo total,
   formação de preço (markup divisor), indicadores e alertas automáticos,
   com histórico de precificação salvo a cada gravação
6. **Importação em massa** — .xlsx (abas Cadastro_Produto/Materiais/
   Custos_Industriais) ou .csv, com pré-visualização antes de gravar
7. **Simulador de cenários** — testa ajustes de custo/frete/impostos sem
   alterar os dados reais
8. **Dashboard executivo** — KPIs, composição do preço de venda e
   indicador de faixa de preço
9. **Kits** — automáticos (2 a 8 peças, Dryfit/Polo/Bermuda) e manuais
   (combinando referências diferentes)
10. **Ficha técnica** — busca multi-referência com impressão/exportação
    em PDF

## Deploy

Veja [`DEPLOY.md`](./DEPLOY.md) para o passo a passo de publicação no
Render (Web Service + Postgres gerenciado).
