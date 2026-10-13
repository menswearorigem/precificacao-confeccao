# Catálogo da API externa — todas as rotas

> Gerado automaticamente do código em 13/10/2026. A versão sempre atualizada, filtrada pelo que **cada chave** alcança, é `GET /api/externa/v1/catalogo`.
>
> **Módulos** = o usuário vinculado à chave precisa ter **pelo menos um** deles. Sem o módulo, a rota responde 403.

Total: **63 áreas, 585 rotas.**

## alertas

Módulos: Produtos, Análises

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/alertas` |

## analises-estoque

Módulos: Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/analises-estoque/parado` |
| GET | `/api/externa/v1/analises-estoque/curva-tamanho` |

## anuncios

Módulos: Marketplace

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/anuncios/lojas` |
| GET | `/api/externa/v1/anuncios` |
| GET | `/api/externa/v1/anuncios/sincronizacao` |
| GET | `/api/externa/v1/anuncios/:id` |
| GET | `/api/externa/v1/anuncios/:id/visitas-dia` |
| GET | `/api/externa/v1/anuncios/:id/historico` |
| POST | `/api/externa/v1/anuncios/sincronizar` |
| PUT | `/api/externa/v1/anuncios/:id/vinculo` |
| POST | `/api/externa/v1/anuncios/:id/publicar` |
| POST | `/api/externa/v1/anuncios/situacao-em-lote` |
| GET | `/api/externa/v1/anuncios/exportacao/planilha` |

## busca

Módulos: (qualquer usuário logado)

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/busca` |

## calendario

Módulos: Calendário

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/calendario/eventos` |
| GET | `/api/externa/v1/calendario/resumo` |
| GET | `/api/externa/v1/calendario/notificacoes` |
| GET | `/api/externa/v1/calendario/usuarios` |
| GET | `/api/externa/v1/calendario/templates` |
| POST | `/api/externa/v1/calendario/templates` |
| PUT | `/api/externa/v1/calendario/templates/:id` |
| GET | `/api/externa/v1/calendario/produtos-busca` |
| GET | `/api/externa/v1/calendario/fornecedores-busca` |
| GET | `/api/externa/v1/calendario/cores-distintas` |
| GET | `/api/externa/v1/calendario/tamanhos-distintos` |
| GET | `/api/externa/v1/calendario/fornecedores` |
| GET | `/api/externa/v1/calendario/produtos/:id/variantes-sugeridas` |
| GET | `/api/externa/v1/calendario/eventos/:id` |
| POST | `/api/externa/v1/calendario/eventos` |
| PUT | `/api/externa/v1/calendario/eventos/:id` |
| DELETE | `/api/externa/v1/calendario/eventos/:id` |
| POST | `/api/externa/v1/calendario/eventos/:id/duplicar` |
| POST | `/api/externa/v1/calendario/eventos/:id/comentarios` |
| POST | `/api/externa/v1/calendario/eventos/:id/anexos` |
| GET | `/api/externa/v1/calendario/anexos/:id` |
| DELETE | `/api/externa/v1/calendario/anexos/:id` |
| GET | `/api/externa/v1/calendario/rascunhos/:data` |
| PUT | `/api/externa/v1/calendario/rascunhos/:data` |
| DELETE | `/api/externa/v1/calendario/rascunhos/:data` |
| POST | `/api/externa/v1/calendario/ordem-producao/ler` |

## clientes

Módulos: Vendas

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/clientes` |
| GET | `/api/externa/v1/clientes/:id` |
| GET | `/api/externa/v1/clientes/:id/historico` |
| POST | `/api/externa/v1/clientes` |
| PUT | `/api/externa/v1/clientes/:id` |
| DELETE | `/api/externa/v1/clientes/:id` |
| POST | `/api/externa/v1/clientes/importar-wik` |

## compras

Módulos: Compras

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/compras` |
| GET | `/api/externa/v1/compras/opcoes` |
| GET | `/api/externa/v1/compras/relatorio` |
| GET | `/api/externa/v1/compras/:id` |
| POST | `/api/externa/v1/compras` |
| PUT | `/api/externa/v1/compras/:id` |
| DELETE | `/api/externa/v1/compras/:id` |
| POST | `/api/externa/v1/compras/:id/itens` |
| PUT | `/api/externa/v1/compras/:id/itens/:itemId` |
| DELETE | `/api/externa/v1/compras/:id/itens/:itemId` |

## conferencia

Módulos: Marketplace

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/conferencia/fila` |
| GET | `/api/externa/v1/conferencia/abrir/:codigo` |
| POST | `/api/externa/v1/conferencia/pedidos/:pedidoId/iniciar` |
| POST | `/api/externa/v1/conferencia/lista/:listaId/iniciar` |
| POST | `/api/externa/v1/conferencia/:id/leitura` |
| POST | `/api/externa/v1/conferencia/:id/confirmar-manual` |
| POST | `/api/externa/v1/conferencia/:id/desfazer` |
| POST | `/api/externa/v1/conferencia/:id/concluir` |
| POST | `/api/externa/v1/conferencia/:id/abandonar` |
| POST | `/api/externa/v1/conferencia/lista` |
| GET | `/api/externa/v1/conferencia/lista` |
| POST | `/api/externa/v1/conferencia/pedidos/:pedidoId/vincular-rastreio` |
| GET | `/api/externa/v1/conferencia/relatorio` |

## configuracoes

Módulos: Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/configuracoes` |
| PUT | `/api/externa/v1/configuracoes` |

## cotacoes

Módulos: Compras

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/cotacoes` |
| GET | `/api/externa/v1/cotacoes/:id` |
| POST | `/api/externa/v1/cotacoes` |
| PUT | `/api/externa/v1/cotacoes/:id` |
| POST | `/api/externa/v1/cotacoes/:id/respostas` |
| POST | `/api/externa/v1/cotacoes/:id/vencedor` |
| POST | `/api/externa/v1/cotacoes/:id/gerar-pedidos` |

## custos-indiretos

Módulos: Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/custos-indiretos` |
| POST | `/api/externa/v1/custos-indiretos` |
| PUT | `/api/externa/v1/custos-indiretos/producao-mensal` |
| PUT | `/api/externa/v1/custos-indiretos/:id` |
| DELETE | `/api/externa/v1/custos-indiretos/:id` |

## depositos

Módulos: Estoque, Produção

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/depositos` |
| POST | `/api/externa/v1/depositos` |
| PUT | `/api/externa/v1/depositos/:id` |
| POST | `/api/externa/v1/depositos/:id/inativar` |
| GET | `/api/externa/v1/depositos/panorama` |
| GET | `/api/externa/v1/depositos/:id/saldo` |
| GET | `/api/externa/v1/depositos/transferencias` |
| GET | `/api/externa/v1/depositos/transferencias/:id` |
| POST | `/api/externa/v1/depositos/transferencias` |
| POST | `/api/externa/v1/depositos/transferencias/:id/enviar` |
| POST | `/api/externa/v1/depositos/transferencias/:id/receber` |
| POST | `/api/externa/v1/depositos/transferencias/:id/estornar` |
| POST | `/api/externa/v1/depositos/transferencias/:id/baixar-divergencia` |
| DELETE | `/api/externa/v1/depositos/transferencias/:id` |

## devolucoes

Módulos: Marketplace, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/devolucoes/opcoes` |
| GET | `/api/externa/v1/devolucoes` |
| GET | `/api/externa/v1/devolucoes/panorama` |
| GET | `/api/externa/v1/devolucoes/:id` |
| POST | `/api/externa/v1/devolucoes` |
| POST | `/api/externa/v1/devolucoes/:id/receber` |
| POST | `/api/externa/v1/devolucoes/:id/avaliar` |
| POST | `/api/externa/v1/devolucoes/:id/cancelar` |
| GET | `/api/externa/v1/devolucoes/pedido/:pedidoId/itens` |

## empresas

Módulos: (qualquer usuário logado)

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/empresas` |
| POST | `/api/externa/v1/empresas` |
| PUT | `/api/externa/v1/empresas/:id` |
| DELETE | `/api/externa/v1/empresas/:id` |

## estoque

Módulos: Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/estoque/produtos-referencia` |
| GET | `/api/externa/v1/estoque/variantes` |
| GET | `/api/externa/v1/estoque/buscar-ean/:ean` |
| POST | `/api/externa/v1/estoque/variantes` |
| PUT | `/api/externa/v1/estoque/variantes/:id` |
| DELETE | `/api/externa/v1/estoque/variantes/:id` |
| POST | `/api/externa/v1/estoque/variantes/:id/movimento` |
| POST | `/api/externa/v1/estoque/bipar` |
| GET | `/api/externa/v1/estoque/movimentos` |
| POST | `/api/externa/v1/estoque/importacao/preview` |
| POST | `/api/externa/v1/estoque/importacao/confirmar` |
| PUT | `/api/externa/v1/estoque/variantes/:id/ean` |
| POST | `/api/externa/v1/estoque/ean-mapeamento/preview` |
| POST | `/api/externa/v1/estoque/ean-mapeamento/confirmar` |
| GET | `/api/externa/v1/estoque/ean-mapeamento` |
| DELETE | `/api/externa/v1/estoque/ean-mapeamento/:id` |
| GET | `/api/externa/v1/estoque/ficha` |
| GET | `/api/externa/v1/estoque/indicadores` |
| GET | `/api/externa/v1/estoque/wik-status` |
| POST | `/api/externa/v1/estoque/wik-sincronizar-referencias` |

## estoque-locais

Módulos: Estoque, Produção

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/estoque-locais` |
| GET | `/api/externa/v1/estoque-locais/faccao` |
| GET | `/api/externa/v1/estoque-locais/variante/:id` |
| POST | `/api/externa/v1/estoque-locais/mover` |
| PUT | `/api/externa/v1/estoque-locais/variante/:id/endereco` |
| POST | `/api/externa/v1/estoque-locais/enderecar-lote` |

## estoque-minimo

Módulos: Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/estoque-minimo/produtos` |
| GET | `/api/externa/v1/estoque-minimo/produtos/:id/foto` |
| GET | `/api/externa/v1/estoque-minimo/produtos/:id/grade` |
| PUT | `/api/externa/v1/estoque-minimo/produtos/:id/reposicao` |
| GET | `/api/externa/v1/estoque-minimo/insumos` |

## estoque-reserva

Módulos: Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/estoque-reserva/politica` |
| PUT | `/api/externa/v1/estoque-reserva/politica` |
| GET | `/api/externa/v1/estoque-reserva/disponivel` |
| GET | `/api/externa/v1/estoque-reserva/reservas` |
| GET | `/api/externa/v1/estoque-reserva/reservas/vencidas` |
| POST | `/api/externa/v1/estoque-reserva/reservas` |
| POST | `/api/externa/v1/estoque-reserva/reservas/:id/liberar` |
| POST | `/api/externa/v1/estoque-reserva/reservas/:id/consumir` |
| POST | `/api/externa/v1/estoque-reserva/pedidos/:id/reservar` |
| POST | `/api/externa/v1/estoque-reserva/pedidos/:id/resolver` |

## etiquetas

Módulos: Marketplace, Estoque

| Método | Caminho |
|---|---|
| POST | `/api/externa/v1/etiquetas/zpl/analisar` |
| POST | `/api/externa/v1/etiquetas/zpl/pdf` |
| POST | `/api/externa/v1/etiquetas/zpl/lote` |
| POST | `/api/externa/v1/etiquetas/picking` |
| POST | `/api/externa/v1/etiquetas/picking/pdf` |

## faccoes

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/faccoes/categorias` |
| POST | `/api/externa/v1/faccoes/categorias` |
| PUT | `/api/externa/v1/faccoes/categorias/:id` |
| DELETE | `/api/externa/v1/faccoes/categorias/:id` |
| GET | `/api/externa/v1/faccoes` |
| GET | `/api/externa/v1/faccoes/opcoes` |
| GET | `/api/externa/v1/faccoes/:id` |
| POST | `/api/externa/v1/faccoes` |
| PUT | `/api/externa/v1/faccoes/:id` |
| DELETE | `/api/externa/v1/faccoes/:id` |
| POST | `/api/externa/v1/faccoes/:id/precos` |
| POST | `/api/externa/v1/faccoes/precos/:precoId/encerrar` |
| POST | `/api/externa/v1/faccoes/importar-wik` |

## ficha-tecnica

Módulos: Produtos, Vendas

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/ficha-tecnica` |

## financeiro

Módulos: Financeiro

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/financeiro/extrato` |
| GET | `/api/externa/v1/financeiro/repasses` |
| GET | `/api/externa/v1/financeiro/conciliacao` |
| GET | `/api/externa/v1/financeiro/status` |
| POST | `/api/externa/v1/financeiro/sincronizar` |
| POST | `/api/externa/v1/financeiro/revincular` |

## financeiro-nucleo

Módulos: Financeiro

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/financeiro-nucleo/plano` |
| POST | `/api/externa/v1/financeiro-nucleo/plano` |
| GET | `/api/externa/v1/financeiro-nucleo/centros-custo` |
| POST | `/api/externa/v1/financeiro-nucleo/centros-custo` |
| GET | `/api/externa/v1/financeiro-nucleo/contas` |
| POST | `/api/externa/v1/financeiro-nucleo/contas` |
| PUT | `/api/externa/v1/financeiro-nucleo/contas/:id` |
| DELETE | `/api/externa/v1/financeiro-nucleo/contas/:id` |
| GET | `/api/externa/v1/financeiro-nucleo/titulos` |
| GET | `/api/externa/v1/financeiro-nucleo/titulos/:id` |
| POST | `/api/externa/v1/financeiro-nucleo/titulos` |
| POST | `/api/externa/v1/financeiro-nucleo/titulos/parcelado` |
| POST | `/api/externa/v1/financeiro-nucleo/titulos/:id/cancelar` |
| GET | `/api/externa/v1/financeiro-nucleo/titulos/:id/encargos` |
| POST | `/api/externa/v1/financeiro-nucleo/titulos/:id/baixar` |
| POST | `/api/externa/v1/financeiro-nucleo/baixas/:id/estornar` |
| POST | `/api/externa/v1/financeiro-nucleo/extrato/importar` |
| GET | `/api/externa/v1/financeiro-nucleo/extrato` |
| GET | `/api/externa/v1/financeiro-nucleo/extrato/:id/sugestoes` |
| POST | `/api/externa/v1/financeiro-nucleo/extrato/:id/conciliar` |
| GET | `/api/externa/v1/financeiro-nucleo/aging` |
| GET | `/api/externa/v1/financeiro-nucleo/fluxo-caixa` |
| GET | `/api/externa/v1/financeiro-nucleo/dre` |
| GET | `/api/externa/v1/financeiro-nucleo/exportar-contador` |
| GET | `/api/externa/v1/financeiro-nucleo/recorrencias` |
| POST | `/api/externa/v1/financeiro-nucleo/recorrencias` |
| POST | `/api/externa/v1/financeiro-nucleo/recorrencias/gerar` |
| GET | `/api/externa/v1/financeiro-nucleo/wik/status` |
| PUT | `/api/externa/v1/financeiro-nucleo/wik/config` |
| PUT | `/api/externa/v1/financeiro-nucleo/wik/empresas/:id` |
| POST | `/api/externa/v1/financeiro-nucleo/wik/sincronizar` |
| POST | `/api/externa/v1/financeiro-nucleo/wik/diagnostico` |
| GET | `/api/externa/v1/financeiro-nucleo/wik/duplicados` |
| POST | `/api/externa/v1/financeiro-nucleo/titulos/:id/duplicado` |

## financeiro-ponte

Módulos: Financeiro

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/financeiro-ponte/origens` |
| PUT | `/api/externa/v1/financeiro-ponte/origens/:codigo` |
| GET | `/api/externa/v1/financeiro-ponte/pendencias` |
| GET | `/api/externa/v1/financeiro-ponte/pendencias/resumo` |
| POST | `/api/externa/v1/financeiro-ponte/pendencias/:id/atender` |
| POST | `/api/externa/v1/financeiro-ponte/pendencias/:id/dispensar` |
| POST | `/api/externa/v1/financeiro-ponte/pendencias/:id/reabrir` |
| GET | `/api/externa/v1/financeiro-ponte/cobertura` |
| POST | `/api/externa/v1/financeiro-ponte/cobertura/importar` |
| GET | `/api/externa/v1/financeiro-ponte/documento/:codigo/:id` |
| GET | `/api/externa/v1/financeiro-ponte/documentos/:codigo` |

## financeiro-ponte/documento

Módulos: Financeiro, Produção, Compras, Vendas, Marketplace, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/financeiro-ponte/documento/origens` |
| PUT | `/api/externa/v1/financeiro-ponte/documento/origens/:codigo` |
| GET | `/api/externa/v1/financeiro-ponte/documento/pendencias` |
| GET | `/api/externa/v1/financeiro-ponte/documento/pendencias/resumo` |
| POST | `/api/externa/v1/financeiro-ponte/documento/pendencias/:id/atender` |
| POST | `/api/externa/v1/financeiro-ponte/documento/pendencias/:id/dispensar` |
| POST | `/api/externa/v1/financeiro-ponte/documento/pendencias/:id/reabrir` |
| GET | `/api/externa/v1/financeiro-ponte/documento/cobertura` |
| POST | `/api/externa/v1/financeiro-ponte/documento/cobertura/importar` |
| GET | `/api/externa/v1/financeiro-ponte/documento/documento/:codigo/:id` |
| GET | `/api/externa/v1/financeiro-ponte/documento/documentos/:codigo` |

## financeiro-ponte/documentos

Módulos: Financeiro, Produção, Compras, Vendas, Marketplace, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/financeiro-ponte/documentos/origens` |
| PUT | `/api/externa/v1/financeiro-ponte/documentos/origens/:codigo` |
| GET | `/api/externa/v1/financeiro-ponte/documentos/pendencias` |
| GET | `/api/externa/v1/financeiro-ponte/documentos/pendencias/resumo` |
| POST | `/api/externa/v1/financeiro-ponte/documentos/pendencias/:id/atender` |
| POST | `/api/externa/v1/financeiro-ponte/documentos/pendencias/:id/dispensar` |
| POST | `/api/externa/v1/financeiro-ponte/documentos/pendencias/:id/reabrir` |
| GET | `/api/externa/v1/financeiro-ponte/documentos/cobertura` |
| POST | `/api/externa/v1/financeiro-ponte/documentos/cobertura/importar` |
| GET | `/api/externa/v1/financeiro-ponte/documentos/documento/:codigo/:id` |
| GET | `/api/externa/v1/financeiro-ponte/documentos/documentos/:codigo` |

## fornecedores

Módulos: Compras

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/fornecedores/opcoes` |
| GET | `/api/externa/v1/fornecedores` |
| GET | `/api/externa/v1/fornecedores/:id` |
| GET | `/api/externa/v1/fornecedores/:id/historico` |
| POST | `/api/externa/v1/fornecedores` |
| PUT | `/api/externa/v1/fornecedores/:id` |
| DELETE | `/api/externa/v1/fornecedores/:id` |

## full

Módulos: Marketplace

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/full/lojas` |
| GET | `/api/externa/v1/full` |
| GET | `/api/externa/v1/full/anuncios/:integracaoId/:anuncioIdExterno` |
| POST | `/api/externa/v1/full/plano` |
| GET | `/api/externa/v1/full/referencias` |
| PUT | `/api/externa/v1/full/anuncios/:anuncioId/vinculo` |
| GET | `/api/externa/v1/full/itens/:id/composicao` |
| PUT | `/api/externa/v1/full/itens/:id/composicao` |
| GET | `/api/externa/v1/full/anuncios/:integracaoId/:anuncioIdExterno/vendas` |
| GET | `/api/externa/v1/full/parametros` |
| PUT | `/api/externa/v1/full/parametros/:integracaoId` |
| PUT | `/api/externa/v1/full/itens/:id` |
| GET | `/api/externa/v1/full/envios` |
| POST | `/api/externa/v1/full/envios` |
| PUT | `/api/externa/v1/full/envios/:id` |
| POST | `/api/externa/v1/full/diagnostico-envios` |
| POST | `/api/externa/v1/full/sincronizar` |

## importacao

Módulos: Produtos

| Método | Caminho |
|---|---|
| POST | `/api/externa/v1/importacao/preview` |
| POST | `/api/externa/v1/importacao/confirmar` |

## importacao-massa

Módulos: Produtos

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/importacao-massa/modelos` |
| GET | `/api/externa/v1/importacao-massa/modelo/:tipo.xlsx` |
| POST | `/api/externa/v1/importacao-massa/simular` |
| GET | `/api/externa/v1/importacao-massa` |
| GET | `/api/externa/v1/importacao-massa/:id` |
| POST | `/api/externa/v1/importacao-massa/:id/aplicar` |
| POST | `/api/externa/v1/importacao-massa/:id/desfazer` |
| DELETE | `/api/externa/v1/importacao-massa/:id` |
| GET | `/api/externa/v1/importacao-massa/historico/:entidade/:id` |

## inicio

Módulos: (qualquer usuário logado)

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/inicio` |

## insumos

Módulos: Compras

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/insumos` |
| GET | `/api/externa/v1/insumos/:id` |
| POST | `/api/externa/v1/insumos` |
| PUT | `/api/externa/v1/insumos/:id` |
| POST | `/api/externa/v1/insumos/vincular-ficha` |
| GET | `/api/externa/v1/insumos/diagnostico/fichas-defasadas` |
| POST | `/api/externa/v1/insumos/aplicar-na-ficha` |
| POST | `/api/externa/v1/insumos/notas/ler-xml` |
| POST | `/api/externa/v1/insumos/notas` |
| GET | `/api/externa/v1/insumos/notas/lista` |

## kits

Módulos: Produtos

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/kits/automaticos` |
| GET | `/api/externa/v1/kits/manuais` |
| POST | `/api/externa/v1/kits/manuais` |
| PUT | `/api/externa/v1/kits/manuais/:id` |
| DELETE | `/api/externa/v1/kits/manuais/:id` |

## listas

Módulos: (qualquer usuário logado)

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/listas` |
| GET | `/api/externa/v1/listas/:tipo` |
| POST | `/api/externa/v1/listas/:tipo` |
| PUT | `/api/externa/v1/listas/:tipo/:id` |
| DELETE | `/api/externa/v1/listas/:tipo/:id` |

## manu

Módulos: (qualquer usuário logado)

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/manu/briefing` |
| POST | `/api/externa/v1/manu/perguntar` |
| GET | `/api/externa/v1/manu/perguntas` |

## marketplace-taxas

Módulos: Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/marketplace-taxas` |
| POST | `/api/externa/v1/marketplace-taxas/comissao` |
| PUT | `/api/externa/v1/marketplace-taxas/comissao/:id` |
| DELETE | `/api/externa/v1/marketplace-taxas/comissao/:id` |
| POST | `/api/externa/v1/marketplace-taxas/frete` |
| PUT | `/api/externa/v1/marketplace-taxas/frete/:id` |
| DELETE | `/api/externa/v1/marketplace-taxas/frete/:id` |

## mix-tributario

Módulos: Análises

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/mix-tributario` |

## pedidos

Módulos: Vendas, Marketplace

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/pedidos/buscar-estoque` |
| GET | `/api/externa/v1/pedidos/buscar-produtos` |
| POST | `/api/externa/v1/pedidos/importar-marketplace/preview` |
| POST | `/api/externa/v1/pedidos/importar-marketplace/confirmar` |
| POST | `/api/externa/v1/pedidos/marketplace/revincular-custos` |
| GET | `/api/externa/v1/pedidos/marketplace/duplicatas-suspeitas` |
| GET | `/api/externa/v1/pedidos/:id/diagnostico-marketplace` |
| GET | `/api/externa/v1/pedidos/marketplace/buscar-por-origem/:origemPedidoId` |
| PUT | `/api/externa/v1/pedidos/itens/:itemId/produto` |
| GET | `/api/externa/v1/pedidos/relatorio-lucratividade` |
| GET | `/api/externa/v1/pedidos/relatorio-lucratividade/resumo-produto` |
| GET | `/api/externa/v1/pedidos/relatorio-lucratividade/resumo-anuncio` |
| GET | `/api/externa/v1/pedidos/relatorio-lucratividade/serie-diaria` |
| GET | `/api/externa/v1/pedidos/relatorio-lucratividade/dashboard-executivo` |
| GET | `/api/externa/v1/pedidos/metricas/resumo` |
| GET | `/api/externa/v1/pedidos/metricas/serie` |
| GET | `/api/externa/v1/pedidos/metricas/por-loja` |
| GET | `/api/externa/v1/pedidos/metricas/movimento-estoque` |
| GET | `/api/externa/v1/pedidos/relatorio-taxas` |
| GET | `/api/externa/v1/pedidos` |
| GET | `/api/externa/v1/pedidos/:id` |
| POST | `/api/externa/v1/pedidos` |
| POST | `/api/externa/v1/pedidos/:id/duplicar` |
| PUT | `/api/externa/v1/pedidos/:id` |
| DELETE | `/api/externa/v1/pedidos/:id` |
| POST | `/api/externa/v1/pedidos/:id/itens` |
| PUT | `/api/externa/v1/pedidos/:id/itens/:itemId` |
| DELETE | `/api/externa/v1/pedidos/:id/itens/:itemId` |
| POST | `/api/externa/v1/pedidos/:id/reaplicar-tabela-preco` |
| POST | `/api/externa/v1/pedidos/:id/faturar` |
| POST | `/api/externa/v1/pedidos/:id/cancelar` |
| POST | `/api/externa/v1/pedidos/importar-wik-vendas` |
| GET | `/api/externa/v1/pedidos/wik-vendas/status` |
| POST | `/api/externa/v1/pedidos/wik-vendas/preencher-itens` |

## pedidos-compra

Módulos: Compras

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/pedidos-compra` |
| GET | `/api/externa/v1/pedidos-compra/:id` |
| POST | `/api/externa/v1/pedidos-compra` |
| POST | `/api/externa/v1/pedidos-compra/:id/aprovar` |
| POST | `/api/externa/v1/pedidos-compra/:id/cancelar` |
| GET | `/api/externa/v1/pedidos-compra/:id/confronto` |

## planejamento

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| POST | `/api/externa/v1/planejamento/gerar` |
| GET | `/api/externa/v1/planejamento/apoio` |
| GET | `/api/externa/v1/planejamento/produtos/:id/foto` |
| GET | `/api/externa/v1/planejamento` |
| PUT | `/api/externa/v1/planejamento/sugestoes/:id` |
| POST | `/api/externa/v1/planejamento/sugestoes/:id/recusar` |
| POST | `/api/externa/v1/planejamento/sugestoes/:id/aprovar` |
| GET | `/api/externa/v1/planejamento/sazonalidade` |
| PUT | `/api/externa/v1/planejamento/sazonalidade/:produtoId` |
| GET | `/api/externa/v1/planejamento/eventos` |
| POST | `/api/externa/v1/planejamento/eventos` |
| PUT | `/api/externa/v1/planejamento/eventos/:id` |
| DELETE | `/api/externa/v1/planejamento/eventos/:id` |

## pos-venda

Módulos: Marketplace, Produtos, Análises

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/pos-venda/opcoes` |
| GET | `/api/externa/v1/pos-venda/painel` |
| GET | `/api/externa/v1/pos-venda/eventos` |
| GET | `/api/externa/v1/pos-venda/evolucao` |
| GET | `/api/externa/v1/pos-venda/comparar` |
| PUT | `/api/externa/v1/pos-venda/eventos/:id` |
| POST | `/api/externa/v1/pos-venda/eventos/:id/responder` |
| POST | `/api/externa/v1/pos-venda/sincronizar` |
| GET | `/api/externa/v1/pos-venda/sincronizacao` |

## preco-por-canal

Módulos: Produtos, Análises

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/preco-por-canal/:produtoId` |

## preco-regra

Módulos: Marketplace, Produtos, Análises, Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/preco-regra/regras` |
| POST | `/api/externa/v1/preco-regra/regras` |
| PUT | `/api/externa/v1/preco-regra/regras/:id` |
| DELETE | `/api/externa/v1/preco-regra/regras/:id` |
| GET | `/api/externa/v1/preco-regra/auditoria` |
| POST | `/api/externa/v1/preco-regra/avaliar` |
| POST | `/api/externa/v1/preco-regra/simular` |
| POST | `/api/externa/v1/preco-regra/simulacoes` |
| GET | `/api/externa/v1/preco-regra/simulacoes` |
| GET | `/api/externa/v1/preco-regra/simulacoes/:id` |
| GET | `/api/externa/v1/preco-regra/concorrentes` |
| POST | `/api/externa/v1/preco-regra/concorrentes` |
| PUT | `/api/externa/v1/preco-regra/concorrentes/:id` |
| DELETE | `/api/externa/v1/preco-regra/concorrentes/:id` |
| POST | `/api/externa/v1/preco-regra/concorrentes/ler` |
| GET | `/api/externa/v1/preco-regra/concorrentes/:id/historico` |
| GET | `/api/externa/v1/preco-regra/excecoes` |

## producao

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| POST | `/api/externa/v1/producao/wik/sincronizar` |
| GET | `/api/externa/v1/producao/wik/diagnostico/:op` |
| POST | `/api/externa/v1/producao/wik/grade-op/:op` |
| POST | `/api/externa/v1/producao/calendario/sincronizar` |
| POST | `/api/externa/v1/producao/wik/grade-marketplace` |
| GET | `/api/externa/v1/producao/operacoes/:produtoId` |
| POST | `/api/externa/v1/producao/operacoes` |
| PUT | `/api/externa/v1/producao/operacoes/:id` |
| GET | `/api/externa/v1/producao/consumo-tamanho/:produtoId` |
| POST | `/api/externa/v1/producao/consumo-tamanho` |
| GET | `/api/externa/v1/producao/apoio` |
| GET | `/api/externa/v1/producao/produto-grade/:produtoId` |
| GET | `/api/externa/v1/producao/wip` |
| GET | `/api/externa/v1/producao/ordens` |
| GET | `/api/externa/v1/producao/ordens/:id` |
| POST | `/api/externa/v1/producao/ordens/previa` |
| POST | `/api/externa/v1/producao/ordens` |
| PUT | `/api/externa/v1/producao/ordens/:id` |
| POST | `/api/externa/v1/producao/ordens/:id/situacao` |
| POST | `/api/externa/v1/producao/ordens/:id/insumos` |
| DELETE | `/api/externa/v1/producao/ordens/:id/insumos/:itemId` |
| POST | `/api/externa/v1/producao/ordens/:id/aplicar-custo-na-ficha` |
| POST | `/api/externa/v1/producao/ordens/:id/reservar` |
| POST | `/api/externa/v1/producao/ordens/:id/apontar` |
| POST | `/api/externa/v1/producao/ordens/:id/concluir` |
| POST | `/api/externa/v1/producao/faccao/movimento` |
| GET | `/api/externa/v1/producao/faccao/saldos` |

## producao-cobranca

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/producao-cobranca` |
| POST | `/api/externa/v1/producao-cobranca/registrar` |

## producao-corte

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/producao-corte/ops` |
| POST | `/api/externa/v1/producao-corte/previa` |
| POST | `/api/externa/v1/producao-corte` |
| GET | `/api/externa/v1/producao-corte` |
| GET | `/api/externa/v1/producao-corte/sobras` |
| GET | `/api/externa/v1/producao-corte/:id` |
| PUT | `/api/externa/v1/producao-corte/:id/lancar` |
| POST | `/api/externa/v1/producao-corte/:id/cancelar` |
| POST | `/api/externa/v1/producao-corte/:id/corrigir-ficha` |

## producao-insumos

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/producao-insumos` |
| GET | `/api/externa/v1/producao-insumos/resumo` |
| PUT | `/api/externa/v1/producao-insumos/:id/unidade` |
| GET | `/api/externa/v1/producao-insumos/sugestao-unidade` |
| GET | `/api/externa/v1/producao-insumos/vinculos` |
| POST | `/api/externa/v1/producao-insumos/vincular` |
| POST | `/api/externa/v1/producao-insumos/vincular-exatos` |
| POST | `/api/externa/v1/producao-insumos/preencher-tudo` |
| GET | `/api/externa/v1/producao-insumos/distribuicao` |
| POST | `/api/externa/v1/producao-insumos/distribuicao/aplicar` |

## producao-materia-prima

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/producao-materia-prima` |
| GET | `/api/externa/v1/producao-materia-prima/tecidos` |
| PUT | `/api/externa/v1/producao-materia-prima/produtos/:id/config` |
| PUT | `/api/externa/v1/producao-materia-prima/produtos/:id/cores` |
| PUT | `/api/externa/v1/producao-materia-prima/tecidos/:id/saldo` |

## producao-movimentacao

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/producao-movimentacao/etapas` |
| POST | `/api/externa/v1/producao-movimentacao/etapas` |
| PUT | `/api/externa/v1/producao-movimentacao/etapas/:id` |
| GET | `/api/externa/v1/producao-movimentacao/motivos` |
| GET | `/api/externa/v1/producao-movimentacao/ordens/:id/posicao` |
| GET | `/api/externa/v1/producao-movimentacao/ordens/:id/movimentos` |
| POST | `/api/externa/v1/producao-movimentacao/movimentos` |
| POST | `/api/externa/v1/producao-movimentacao/movimentos/:id/estornar` |
| GET | `/api/externa/v1/producao-movimentacao/ordens-servico` |
| GET | `/api/externa/v1/producao-movimentacao/ordens-servico/:id` |
| POST | `/api/externa/v1/producao-movimentacao/ordens-servico/:id/retorno` |
| POST | `/api/externa/v1/producao-movimentacao/ordens-servico/:id/encerrar-quebra` |
| POST | `/api/externa/v1/producao-movimentacao/ordens-servico/:id/cancelar` |
| POST | `/api/externa/v1/producao-movimentacao/ordens-servico/:id/gerar-titulo` |
| GET | `/api/externa/v1/producao-movimentacao/faccao-precos` |
| POST | `/api/externa/v1/producao-movimentacao/faccao-precos` |
| GET | `/api/externa/v1/producao-movimentacao/faccao-precos/vigente` |
| GET | `/api/externa/v1/producao-movimentacao/carga` |
| GET | `/api/externa/v1/producao-movimentacao/ranking-faccao` |

## producao-projecao

Módulos: Produção, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/producao-projecao` |
| POST | `/api/externa/v1/producao-projecao/ordens/:id/baixa` |

## produto-grade

Módulos: Produtos, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/produto-grade/:produtoId` |
| PUT | `/api/externa/v1/produto-grade/:produtoId` |
| POST | `/api/externa/v1/produto-grade/:produtoId/gerar-variantes` |
| POST | `/api/externa/v1/produto-grade/:produtoId/importar-do-estoque` |
| GET | `/api/externa/v1/produto-grade/catalogo/valores` |

## produtos

Módulos: Produtos, Análises

| Método | Caminho |
|---|---|
| POST | `/api/externa/v1/produtos/calcular` |
| GET | `/api/externa/v1/produtos` |
| GET | `/api/externa/v1/produtos/acrescimo-custo` |
| PUT | `/api/externa/v1/produtos/acrescimo-custo` |
| POST | `/api/externa/v1/produtos/acrescimo-custo/puxar-do-wik` |
| GET | `/api/externa/v1/produtos/:id` |
| GET | `/api/externa/v1/produtos/:id/foto` |
| POST | `/api/externa/v1/produtos/:id/foto` |
| DELETE | `/api/externa/v1/produtos/:id/foto` |
| POST | `/api/externa/v1/produtos` |
| PUT | `/api/externa/v1/produtos/:id` |
| DELETE | `/api/externa/v1/produtos/:id` |
| GET | `/api/externa/v1/produtos/:id/historico` |

## produtos-marketplace

Módulos: Produtos, Estoque, Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/produtos-marketplace` |
| GET | `/api/externa/v1/produtos-marketplace/candidatos` |
| POST | `/api/externa/v1/produtos-marketplace/conferir` |
| POST | `/api/externa/v1/produtos-marketplace` |
| POST | `/api/externa/v1/produtos-marketplace/remover` |

## promocoes

Módulos: Marketplace

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/promocoes/lojas` |
| GET | `/api/externa/v1/promocoes` |
| GET | `/api/externa/v1/promocoes/:id` |
| GET | `/api/externa/v1/promocoes/:id/historico` |
| POST | `/api/externa/v1/promocoes/sincronizar` |
| GET | `/api/externa/v1/promocoes/sincronizacao/estado` |
| GET | `/api/externa/v1/promocoes/catalogo/candidatos` |
| POST | `/api/externa/v1/promocoes/previa` |
| POST | `/api/externa/v1/promocoes/margem` |
| POST | `/api/externa/v1/promocoes` |
| POST | `/api/externa/v1/promocoes/:id/itens` |
| PUT | `/api/externa/v1/promocoes/:id/itens` |
| POST | `/api/externa/v1/promocoes/:id/itens/remover` |
| PUT | `/api/externa/v1/promocoes/:id` |
| POST | `/api/externa/v1/promocoes/:id/encerrar` |
| POST | `/api/externa/v1/promocoes/:id/excluir` |
| GET | `/api/externa/v1/promocoes/relampago/horarios` |
| POST | `/api/externa/v1/promocoes/relampago-em-massa` |

## recebimentos

Módulos: Compras

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/recebimentos` |
| GET | `/api/externa/v1/recebimentos/:id` |
| POST | `/api/externa/v1/recebimentos` |
| PUT | `/api/externa/v1/recebimentos/:id/itens` |
| POST | `/api/externa/v1/recebimentos/:id/conferir` |
| POST | `/api/externa/v1/recebimentos/:id/cancelar` |
| POST | `/api/externa/v1/recebimentos/:id/nota` |

## romaneios

Módulos: Marketplace, Estoque

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/romaneios/prazos` |
| PUT | `/api/externa/v1/romaneios/prazos/:canal` |
| GET | `/api/externa/v1/romaneios/expedicao/hoje` |
| GET | `/api/externa/v1/romaneios/expedicao/pendencias` |
| GET | `/api/externa/v1/romaneios/expedicao/enviados` |
| GET | `/api/externa/v1/romaneios/expedicao/coletas` |
| GET | `/api/externa/v1/romaneios/expedicao/indicadores` |
| GET | `/api/externa/v1/romaneios/expedicao/diagnostico/:pedidoId` |
| POST | `/api/externa/v1/romaneios/expedicao/sincronizar` |
| GET | `/api/externa/v1/romaneios/coleta` |
| GET | `/api/externa/v1/romaneios` |
| GET | `/api/externa/v1/romaneios/:id` |
| POST | `/api/externa/v1/romaneios` |
| POST | `/api/externa/v1/romaneios/:id/pedidos` |
| POST | `/api/externa/v1/romaneios/:id/pedidos/:pedidoId/liberar` |
| POST | `/api/externa/v1/romaneios/:id/fechar` |
| POST | `/api/externa/v1/romaneios/:id/reabrir` |
| POST | `/api/externa/v1/romaneios/:id/coletar` |
| POST | `/api/externa/v1/romaneios/:id/cancelar` |
| GET | `/api/externa/v1/romaneios/:id/pdf` |

## saude-integracao

Módulos: Marketplace

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/saude-integracao` |
| POST | `/api/externa/v1/saude-integracao/falhas/:id/tentar-novamente` |
| POST | `/api/externa/v1/saude-integracao/falhas/:id/encerrar` |
| POST | `/api/externa/v1/saude-integracao/conexoes/:id/sincronizar` |

## simulacao

Módulos: Análises

| Método | Caminho |
|---|---|
| POST | `/api/externa/v1/simulacao` |

## tabelas-preco

Módulos: Vendas, Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/tabelas-preco` |
| GET | `/api/externa/v1/tabelas-preco/:id` |
| GET | `/api/externa/v1/tabelas-preco/:id/simular` |
| POST | `/api/externa/v1/tabelas-preco` |
| PUT | `/api/externa/v1/tabelas-preco/:id` |
| DELETE | `/api/externa/v1/tabelas-preco/:id` |
| GET | `/api/externa/v1/tabelas-preco/:id/produtos` |
| POST | `/api/externa/v1/tabelas-preco/:id/itens` |
| POST | `/api/externa/v1/tabelas-preco/:id/itens/em-lote` |
| DELETE | `/api/externa/v1/tabelas-preco/:id/itens/:itemId` |

## taxas-venda

Módulos: Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/taxas-venda` |
| POST | `/api/externa/v1/taxas-venda` |
| PUT | `/api/externa/v1/taxas-venda/:id` |
| DELETE | `/api/externa/v1/taxas-venda/:id` |

## vendas

Módulos: Vendas

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/vendas/relatorio/dados` |
| GET | `/api/externa/v1/vendas/despesas` |
| POST | `/api/externa/v1/vendas/despesas` |
| PUT | `/api/externa/v1/vendas/despesas/:id` |
| DELETE | `/api/externa/v1/vendas/despesas/:id` |
| GET | `/api/externa/v1/vendas/metricas/resumo` |
| GET | `/api/externa/v1/vendas/metricas/serie` |
| GET | `/api/externa/v1/vendas/metricas/quebras` |
| GET | `/api/externa/v1/vendas/metricas/produtos` |
| GET | `/api/externa/v1/vendas/metricas/movimento-estoque` |
| GET | `/api/externa/v1/vendas/metricas/clientes` |
| GET | `/api/externa/v1/vendas/lucratividade` |

## vendedores

Módulos: Vendas, Configurações

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/vendedores` |
| GET | `/api/externa/v1/vendedores/usuarios-disponiveis` |
| GET | `/api/externa/v1/vendedores/:id` |
| POST | `/api/externa/v1/vendedores` |
| PUT | `/api/externa/v1/vendedores/:id` |
| DELETE | `/api/externa/v1/vendedores/:id` |

## viagens

Módulos: Viagens

| Método | Caminho |
|---|---|
| GET | `/api/externa/v1/viagens` |
| POST | `/api/externa/v1/viagens` |
| GET | `/api/externa/v1/viagens/:id` |
| PUT | `/api/externa/v1/viagens/:id` |
| DELETE | `/api/externa/v1/viagens/:id` |
| GET | `/api/externa/v1/viagens/produtos/:produtoId/foto` |
| GET | `/api/externa/v1/viagens/:id/buscar-produtos` |
| POST | `/api/externa/v1/viagens/:id/produtos` |
| DELETE | `/api/externa/v1/viagens/:id/produtos/:produtoId` |
| GET | `/api/externa/v1/viagens/:id/produtos` |
| POST | `/api/externa/v1/viagens/:id/estoque/entrada` |
| POST | `/api/externa/v1/viagens/:id/vender` |
| GET | `/api/externa/v1/viagens/:id/vendas` |
| GET | `/api/externa/v1/viagens/:id/resumo` |

