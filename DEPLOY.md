# Deploy no Render

Passo a passo para publicar o sistema no Render, do mesmo jeito que o
`conferencia-de-pedidos`: um Web Service Node.js conectado ao GitHub, mais um
banco Postgres gerenciado pelo próprio Render (nada de disco local — é
exatamente isso que evita a perda de dados que você teve antes).

## 1. Criar o banco Postgres no Render

1. No painel do Render, clique em **New +** → **PostgreSQL**.
2. Dê um nome (ex: `precificacao-confeccao-db`), escolha a região mais
   próxima (ex: Ohio/Oregon para o Brasil costuma ter boa latência) e o
   plano.
   - **Importante:** evite o plano **Free** para uso real — bancos Postgres
     gratuitos do Render expiram automaticamente depois de um tempo e são
     apagados. Para não correr o risco de perder os dados de novo, use pelo
     menos o plano pago mais barato (**Basic**).
3. Clique em **Create Database** e espere ficar "Available".
4. Abra o banco criado e copie a **Internal Database URL** (vai usar no
   passo 3). Não precisa da "External" — o Web Service e o banco vão rodar
   na mesma rede interna do Render.

## 2. Conectar o repositório do GitHub

1. No painel do Render, clique em **New +** → **Web Service**.
2. Conecte sua conta do GitHub (se ainda não conectou) e selecione o
   repositório `menswearorigem/precificacao-confeccao`.
3. Escolha a branch que você quer publicar (ex: `main`, depois que o PR
   desta branch for revisado e mesclado).

## 3. Configurar o Web Service

Na tela de configuração do serviço:

- **Name:** `precificacao-confeccao` (ou o nome que preferir)
- **Region:** a mesma do banco, para menor latência
- **Runtime:** Node
- **Build Command:**
  ```
  npm install && npm run build:client && npm run migrate
  ```
  (isso instala as dependências, gera o build do React e aplica as
  migrations do banco — é seguro rodar em todo deploy, cada migration só
  roda uma vez)
- **Start Command:**
  ```
  npm start
  ```
- **Instance Type:** o plano **Free** do Web Service é suficiente para
  começar (diferente do banco, o serviço web "dormir" e reiniciar não causa
  perda de dados, já que os dados ficam no Postgres).

### Variáveis de ambiente

Ainda na tela de criação (ou depois em **Environment**), adicione:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a Internal Database URL copiada no passo 1 |
| `DATABASE_SSL` | `true` |
| `APP_PASSWORD` | a senha que a equipe vai usar para entrar no sistema (escolha uma senha de verdade, não deixe a padrão) |
| `SESSION_SECRET` | qualquer texto longo e aleatório (ex: gere com `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |
| `APP_URL` | a URL pública do serviço, ex: `https://precificacao-confeccao.onrender.com` (sem barra no final) — usada nas integrações com marketplaces (Mercado Livre/Shopee) pra montar o link de retorno da autorização, e também no link de "esqueci minha senha" |

Não precisa definir `PORT` — o Render define isso sozinho.

#### E-mail (recuperação de senha)

Sem estas variáveis, o link de "esqueci minha senha" é gerado normalmente
mas o **e-mail não é enviado** — fica só um aviso no log do servidor. Pra
funcionar de verdade em produção, defina (exemplo com Gmail, mas qualquer
provedor SMTP serve — SendGrid, Mailgun, etc.):

| Variável | Valor |
|---|---|
| `SMTP_HOST` | ex: `smtp.gmail.com` |
| `SMTP_PORT` | ex: `587` |
| `SMTP_SECURE` | `false` para porta 587 (STARTTLS), `true` para porta 465 |
| `SMTP_USER` | o e-mail/usuário da conta SMTP |
| `SMTP_PASS` | a senha — no Gmail, precisa ser uma [senha de app](https://myaccount.google.com/apppasswords), não a senha normal da conta |
| `SMTP_FROM` | o remetente que aparece no e-mail (pode ser igual a `SMTP_USER`) |

4. Clique em **Create Web Service**. O Render vai clonar o repositório,
   instalar, buildar, migrar o banco e subir o servidor. Acompanhe pela aba
   **Logs** — a última linha deve ser algo como:
   ```
   Precificação Confecção — servidor no ar
   ```

## 4. Testar

1. Abra a URL que o Render deu ao serviço (algo como
   `https://precificacao-confeccao.onrender.com`).
2. Você deve cair na tela de login. Entre com a senha definida em
   `APP_PASSWORD`.
3. Confira `https://SEU-SERVICO.onrender.com/api/health` — deve responder
   `{"ok":true,...}`.

## 5. Deploys futuros

Com o serviço conectado ao GitHub, todo `git push` na branch configurada
gera um novo deploy automático (build + migrations + restart). Se você
adicionar uma nova migration (`server/src/db/migrations/000X_algo.sql`),
ela roda sozinha no próximo deploy — não precisa fazer nada manual.

## 6. Backup do banco (recomendado)

No painel do banco Postgres no Render, a aba **Backups** permite ativar
snapshots automáticos (em planos pagos) e também fazer um dump manual a
qualquer momento (`pg_dump` usando a External Database URL). Vale a pena
configurar isso já no início, especialmente antes de uma importação em
massa grande.

## 7. Integrações com marketplaces (Mercado Livre / Shopee)

Em **Configurações → Integrações** (só administrador) dá pra conectar o
Mercado Livre e a Shopee pra puxar os pedidos pagos automaticamente (a cada
15 minutos, ou na hora clicando em "Sincronizar agora"). Pra cada um:

- **Mercado Livre:** crie um app em https://developers.mercadolivre.com.br,
  registre o redirect URI `SEU-SERVICO.onrender.com/api/integracoes/mercado_livre/callback`
  e cadastre o Client ID/Secret na tela de Integrações.
- **Shopee:** crie um app no Open Platform (Seller Center → Open API), pegue
  o Partner ID/Key e cadastre na tela de Integrações. O redirect é gerado
  automaticamente na hora de conectar, não precisa registrar antes.

Depois de cadastrar as credenciais, clique em **Conectar** — você vai ser
levado pra tela de login do próprio marketplace pra autorizar o acesso.

## Rodando localmente (para desenvolvimento)

Veja o `README.md` na raiz do projeto — resumo rápido:

```bash
npm install
cp server/.env.example server/.env   # edite DATABASE_URL, APP_PASSWORD, SESSION_SECRET
npm run migrate
npm run dev:server    # porta 3000
npm run dev:client    # porta 5173, com proxy para a API
```
