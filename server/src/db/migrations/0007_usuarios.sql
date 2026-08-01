-- Login individual por usuário, com controle de acesso por módulo.
-- role 'admin' tem acesso irrestrito (vê/gerencia usuários e todos os
-- módulos); role 'limitado' só acessa os módulos listados em usuario_modulos.

CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  senha_hash VARCHAR(200) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'limitado', -- 'admin' | 'limitado'
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Módulos: 'produto' | 'estoque' | 'vendas' | 'compras' | 'analises' | 'configuracoes'
CREATE TABLE IF NOT EXISTS usuario_modulos (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo VARCHAR(30) NOT NULL,
  PRIMARY KEY (usuario_id, modulo)
);
