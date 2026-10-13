# API externa do HBN Hub

Porta de entrada para os **outros sites internos da empresa** lerem e gravarem
no Hub. Funciona de qualquer hospedagem (Render ou outra).

- Endereço base: `https://SEU-HUB.onrender.com/api/externa/v1`
- Autenticação: chave no cabeçalho `x-api-key` (ou `Authorization: Bearer <chave>`)
- Formato: JSON
- Catálogo completo de rotas: [API-EXTERNA-CATALOGO.md](API-EXTERNA-CATALOGO.md)
  (63 áreas, 585 rotas) — ou, sempre atualizado, `GET /api/externa/v1/catalogo`

---

## 1. Como funciona, em uma figura

```
Site de vendas ──x-api-key──►  /api/externa/v1/produtos
                                   │
                                   ├─ confere a chave        (lib/apiExterna.js)
                                   ├─ confere a origem (CORS)
                                   ├─ carrega o USUÁRIO do Hub ligado à chave
                                   │
                                   ▼
                               /api/produtos   ← a MESMA rota que as telas usam
                                   │              (mesmas validações, mesmo cálculo,
                                   │               mesma trava de módulo)
                                   ▼
                               histórico: "[API · site-vendas] POST /api/produtos"
```

**Cada site = uma chave = um usuário do Hub.** O site enxerga e mexe exatamente
no que esse usuário enxerga e mexe. A permissão se controla na tela de
**Acessos**, como de qualquer pessoa:

| Quero… | Faço… |
|---|---|
| dar acesso a um módulo para o site | marco o módulo no usuário do site |
| tirar um módulo | desmarco no usuário |
| desligar o site na hora | desativo o usuário |
| deixar o site só lendo, sem gravar | `"somenteLeitura": true` na configuração |

Regras fixas:
- Usuário **administrador** não pode ser ligado a chave (a API recusa).
- Áreas que **nunca** abrem pela API: login/senha, usuários e grupos,
  integrações (tokens de marketplace), Wik, histórico de auditoria, e-mail,
  ferramentas de administrador e a API de conteúdo (que tem chave própria).
- Toda gravação pela API entra no **histórico de alterações** com o nome do site.
- **Nenhuma tabela nova** no banco (REGRA 4): a configuração mora numa variável
  de ambiente e as permissões no cadastro de usuários que já existe.

---

## 2. Configuração (variável `HBN_API_CLIENTES`)

Uma variável de ambiente no servidor do Hub, com a lista de sites em JSON:

```json
[
  {
    "nome": "site-vendas",
    "usuario": "API Site Vendas",
    "chave": "kq3V…64 caracteres…",
    "origens": ["https://site-vendas.onrender.com"]
  },
  {
    "nome": "painel-tv",
    "usuario": "API Painel",
    "chave": "Zx9…",
    "somenteLeitura": true
  }
]
```

| Campo | Obrigatório | O que é |
|---|---|---|
| `nome` | sim | apelido do site (2–50 letras, números, `-` ou `_`). Aparece no histórico. |
| `usuario` | sim | **nome** de um usuário do Hub (o mesmo do login). Não pode ser administrador. |
| `chave` | sim | segredo com **no mínimo 32 caracteres**. Pode ser uma lista `["nova","antiga"]` durante a troca. |
| `origens` | não | endereços que podem chamar **direto do navegador** (CORS). Chamada de servidor para servidor não precisa. |
| `somenteLeitura` | não | `true` recusa qualquer gravação. |

Gerar chave e a linha pronta:

```bash
node server/scripts/gerar-chave-api.js --nome site-vendas --usuario "API Site Vendas" \
     --origem https://site-vendas.onrender.com
```

Sem a variável, a API responde **503** (desligada). Entrada com erro é ignorada
com aviso no log (`[api-externa] …`) — o Hub sobe normalmente.

---

## 3. Hospedagem: Render ou qualquer outro lugar

A API não depende de onde o site está. Duas formas de chamar:

**a) Do servidor do site (recomendado).** A chave fica numa variável de
ambiente do site e nunca chega ao navegador. Funciona de qualquer hospedagem,
sem configurar `origens`.

**b) Direto do navegador.** Exige o endereço do site em `origens`. ⚠️ Nesse
caso a chave vai junto no código da página e **qualquer pessoa que abrir o
site consegue copiá-la**. Use só para site que já fica atrás de login próprio
e, de preferência, com `somenteLeitura` ou um usuário com poucos módulos.

Mudou o site de hospedagem? Se ele chama pelo servidor, nada muda. Se chama do
navegador, acrescente o endereço novo em `origens`.

---

## 4. Rotas próprias da API

### `GET /api/externa/v1/status`
Confere a chave e mostra o que ela libera.

```json
{
  "ok": true,
  "api": "hbn-hub-externa",
  "versao": 1,
  "site": "site-vendas",
  "usuario": "API Site Vendas",
  "modulos": ["produto", "vendas"],
  "somenteLeitura": false,
  "agora": "2026-10-13T19:30:00.000Z"
}
```

### `GET /api/externa/v1/catalogo`
Lista **todas as rotas que esta chave alcança**, agrupadas por área, gerada do
próprio código — tela nova no Hub aparece aqui sozinha.

```json
{
  "site": "site-vendas",
  "base": "/api/externa/v1",
  "totalRotas": 47,
  "areas": [
    {
      "area": "produtos",
      "modulos": ["produto", "analises"],
      "rotas": [
        { "metodos": ["GET"],  "caminho": "/api/externa/v1/produtos" },
        { "metodos": ["POST"], "caminho": "/api/externa/v1/produtos" },
        { "metodos": ["GET"],  "caminho": "/api/externa/v1/produtos/:id" }
      ]
    }
  ]
}
```

## 5. Todas as outras rotas

São as rotas internas do Hub com o prefixo trocado:

| Na tela do Hub | Pela API |
|---|---|
| `/api/produtos` | `/api/externa/v1/produtos` |
| `/api/pedidos/123` | `/api/externa/v1/pedidos/123` |
| `/api/estoque/...` | `/api/externa/v1/estoque/...` |

Mesmos parâmetros, mesmo corpo, mesma resposta. Lista completa em
[API-EXTERNA-CATALOGO.md](API-EXTERNA-CATALOGO.md).

### Exemplo — ler e gravar um produto (JavaScript, no servidor do site)

```js
const HUB = process.env.HBN_HUB_URL;      // https://SEU-HUB.onrender.com
const CHAVE = process.env.HBN_HUB_CHAVE;  // a chave do site

async function hub(caminho, { metodo = 'GET', corpo } = {}) {
  const r = await fetch(`${HUB}/api/externa/v1${caminho}`, {
    method: metodo,
    headers: { 'x-api-key': CHAVE, 'content-type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${dados.error}`);
  return dados;
}

const produtos = await hub('/produtos');
const novo = await hub('/produtos', {
  metodo: 'POST',
  corpo: { referencia: 'OG9999', descricao: 'Camiseta nova', marca: 'Origem' },
});
```

---

## 6. Erros

Todo erro vem em JSON: `{ "error": "mensagem legível" }`.

| Código | Quando |
|---|---|
| 400 | dado inválido (a mesma validação da tela — ex.: produto sem referência) |
| 401 | chave ausente ou errada |
| 403 | módulo que o usuário do site não tem · site somente leitura tentando gravar · origem não liberada · usuário desativado/admin/inexistente · área bloqueada |
| 404 | rota que não existe |
| 413 | corpo grande demais (padrão 1 MB; importações 15 MB, como nas telas) |
| 429 | limite de requisições (600 por minuto por endereço de internet) |
| 503 | API desligada (`HBN_API_CLIENTES` vazia) |

---

## 7. Troca de chave sem derrubar o site

1. Gere uma chave nova e coloque as duas: `"chave": ["NOVA", "ANTIGA"]`.
2. Troque a chave no site.
3. Tire a antiga: `"chave": "NOVA"`.

Chave vazou? Desative o usuário do site no Hub (corta na hora, sem esperar
reinício) e depois troque a chave.

---

## 8. Arquivos

| Arquivo | Papel |
|---|---|
| `server/src/lib/apiExterna.js` | lê e valida `HBN_API_CLIENTES`, acha o site pela chave |
| `server/src/middleware/apiExterna.js` | a porta: CORS, chave, usuário, reescrita de caminho, status e catálogo |
| `server/src/middleware/auth.js` | `requireAuth` aceita a requisição já autenticada pela chave |
| `server/src/middleware/seguranca.js` | trava de origem (CSRF) não se aplica à chave |
| `server/src/lib/auditoria.js` | histórico marca `[API · nome-do-site]` |
| `server/scripts/gerar-chave-api.js` | gera chave e a configuração pronta |
| `server/scripts/teste-api-externa.js` | 53 verificações de ponta a ponta |
