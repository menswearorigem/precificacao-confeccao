# API de Conteúdo (app Manu Conteúdo)

Rota **somente leitura** que entrega ao app de rotina de conteúdo do TikTok Shop
o que cada produto vende, por canal, e o estoque — para o app decidir qual
produto precisa de vídeo.

## 1. Ligar (uma vez, no Render)

No serviço do Hub → **Environment** → adicionar:

| Variável | Valor |
|---|---|
| `HBN_CONTEUDO_API_KEY` | uma chave longa e aleatória (mínimo 32 caracteres) |

Para gerar uma chave: abra https://www.uuidgenerator.net/ e junte dois códigos
(ou peça para o Claude gerar). Salve e espere o Render reiniciar.
Sem essa variável a rota responde **503** (desligada). Não precisa de migration.

Para trocar a chave sem parar o app: coloque a nova e a antiga separadas por
vírgula, troque no app, e depois apague a antiga.

## 2. Configurar no app Manu Conteúdo

Em **Configurações → HBN Hub**:
- **Endereço do Hub**: `https://SEU-HUB.onrender.com`
- **Chave de acesso**: a mesma da variável acima

## 3. Rotas

Todas com o cabeçalho `x-api-key: <chave>`.

### `GET /api/conteudo/v1/status`
```json
{ "ok": true, "api": "conteudo", "versao": 1, "agora": "2026-10-13T16:48:50.685Z" }
```

### `GET /api/conteudo/v1/produtos?dias=30`
- `dias` — janela curta (7 a 180, padrão 30)
- `todos=1` — inclui produto sem venda e fora do marketplace

Venda em **peças** (kit convertido em peças; devolução/troca não contam) — o
mesmo cálculo da Cobertura e do Estoque Mínimo.

```json
{
  "geradoEm": "2026-10-13T16:48:50.685Z",
  "janelaDias": 30,
  "unidade": "peças (kit convertido em peças; devolução e troca não contam)",
  "total": 1,
  "produtos": [
    {
      "codigo": "OG1620",
      "codigoInterno": null,
      "descricao": "GOLA POLO",
      "marca": "Origem",
      "categoria": "",
      "empresa": "ORIGEM",
      "marketplace": true,
      "vendas": {
        "pecas30d": 4,
        "faturamento30d": 239.6,
        "pecas90d": 6,
        "pecas365d": 6,
        "porCanal": { "tiktok_shop": 2, "shopee": 0, "mercado_livre": 0, "fora_do_marketplace": 2 },
        "ultimaVenda": "2026-10-10"
      },
      "estoque": 50,
      "coberturaDias": 375
    }
  ]
}
```
`porCanal` é da janela curta. Lista ordenada por peças vendidas na janela curta.

## Erros
| Código | Quando |
|---|---|
| 401 | chave ausente ou errada |
| 405 | método diferente de GET |
| 503 | `HBN_CONTEUDO_API_KEY` não configurada |
