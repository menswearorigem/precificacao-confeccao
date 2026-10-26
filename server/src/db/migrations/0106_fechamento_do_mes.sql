-- 0106 — Fechamento do Mês: o financeiro do MARKETPLACE separado da MATRIZ.
--
-- REGRA 4: tabelas e colunas novas AUTORIZADAS pelo dono em 23/10/2026
-- ("Tem a minha autorização"). Nada em usuario_modulos: a aba nova mora no
-- módulo Financeiro, que já existe, e herda o acesso dele.
--
-- O que muda e por quê (pedido de 23/10/2026, planilha RESULTADO_FINANCEIRO_2024
-- do financeiro):
--   * O Wik continua sendo o financeiro da MATRIZ. O do MARKETPLACE vive no Hub,
--     porque a venda de marketplace entra no Wik bipada em lote e o dinheiro cai
--     no Mercado Pago — pelo Wik o caixa do marketplace nunca fecha.
--   * O fechamento segue o modelo da planilha: cada lançamento numa conta do
--     plano, a conta somada no mês, o peso de cada conta sobre a receita
--     operacional, a média e o ideal (orçamento) ao lado. Regime de CAIXA (data
--     do pagamento), igual à planilha — escolha do dono.
--   * Custo dividido com a matriz (aluguel, energia, pessoal...) entra no
--     Marketplace como FATIA FIXA da conta (ex.: 20% do aluguel) — escolha do
--     dono. A Matriz fica com o resto, para o Consolidado não contar duas vezes.

-- 1) Unidade de cada lançamento. Tudo que já existe é da matriz (veio do Wik
--    ou foi lançado antes desta separação).
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS unidade VARCHAR(12) NOT NULL DEFAULT 'matriz';
DO $$ BEGIN
  ALTER TABLE fin_titulos ADD CONSTRAINT fin_titulo_unidade CHECK (unidade IN ('matriz', 'marketplace'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_fin_titulos_unidade ON fin_titulos(unidade);

-- Conta bancária com dono: o que é pago ou recebido numa conta do marketplace
-- (Mercado Pago, carteira da Shopee) é do marketplace, venha de onde vier o
-- título. NULO = a conta não decide, vale a unidade do título.
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS unidade VARCHAR(12);
DO $$ BEGIN
  ALTER TABLE fin_contas ADD CONSTRAINT fin_conta_unidade CHECK (unidade IS NULL OR unidade IN ('matriz', 'marketplace'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) As contas do fechamento — exatamente as da planilha, nos mesmos grupos e
--    na mesma ordem. O plano do Wik tem os mesmos nomes, então a ligação
--    plano -> conta é feita pelo nome (sem acento, sem caixa); o que não casar
--    aparece na tela como "a classificar" e a ligação manual fica gravada em
--    fin_plano.fech_conta_id.
CREATE TABLE IF NOT EXISTS fin_fech_contas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL UNIQUE,
  grupo VARCHAR(40) NOT NULL,
  grupo_ordem INTEGER NOT NULL,
  ordem INTEGER NOT NULL,
  entrada BOOLEAN NOT NULL,           -- grupo de entrada (receitas, transitório entrada)
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fin_fech_contas (nome, grupo, grupo_ordem, ordem, entrada) VALUES
  ('Vendas', 'RECEITA OPERACIONAL', 1, 1, TRUE),
  ('Adiantamento de Clientes', 'RECEITA OPERACIONAL', 1, 2, TRUE),
  ('Recebimento de Inadimplência', 'RECEITA OPERACIONAL', 1, 3, TRUE),
  ('Recuperação de despesas', 'RECEITA OPERACIONAL', 1, 4, TRUE),
  ('Reembolso Frete Venda', 'RECEITA OPERACIONAL', 1, 5, TRUE),
  ('Devoluções de Vendas', 'RECEITA OPERACIONAL', 1, 6, TRUE),
  ('Salarios e Ordenados', 'DESPESA COM PESSOAL', 2, 7, FALSE),
  ('13º Salário', 'DESPESA COM PESSOAL', 2, 8, FALSE),
  ('Acertos e Recisões', 'DESPESA COM PESSOAL', 2, 9, FALSE),
  ('Ajuda de Custo', 'DESPESA COM PESSOAL', 2, 10, FALSE),
  ('Beneficios a Funcionários', 'DESPESA COM PESSOAL', 2, 11, FALSE),
  ('Bonificação', 'DESPESA COM PESSOAL', 2, 12, FALSE),
  ('Comissões Sobre Cobranças', 'DESPESA COM PESSOAL', 2, 13, FALSE),
  ('Despesa com Sindicatos', 'DESPESA COM PESSOAL', 2, 14, FALSE),
  ('Exame Adminissional/Demissional', 'DESPESA COM PESSOAL', 2, 15, FALSE),
  ('Férias', 'DESPESA COM PESSOAL', 2, 16, FALSE),
  ('Fgts / Inss / Irrf / Irpf/darf', 'DESPESA COM PESSOAL', 2, 17, FALSE),
  ('Hora Extra', 'DESPESA COM PESSOAL', 2, 18, FALSE),
  ('Lanches / Refeições', 'DESPESA COM PESSOAL', 2, 19, FALSE),
  ('Premiações e Abonos', 'DESPESA COM PESSOAL', 2, 20, FALSE),
  ('Pro Labore Sócios Erisvania', 'DESPESA COM PESSOAL', 2, 21, FALSE),
  ('Pro Labore Sócios Jean', 'DESPESA COM PESSOAL', 2, 22, FALSE),
  ('Pro Labore Sócios Manuelly', 'DESPESA COM PESSOAL', 2, 23, FALSE),
  ('Seguro de Vida', 'DESPESA COM PESSOAL', 2, 24, FALSE),
  ('Treinamento / Cursos', 'DESPESA COM PESSOAL', 2, 25, FALSE),
  ('Uniformes e EPIs', 'DESPESA COM PESSOAL', 2, 26, FALSE),
  ('Vale Alimentação', 'DESPESA COM PESSOAL', 2, 27, FALSE),
  ('Vale Transporte', 'DESPESA COM PESSOAL', 2, 28, FALSE),
  ('Água e Esgoto', 'DESPESAS ADMINISTRATIVAS', 3, 29, FALSE),
  ('Aluguéis e Condomínios', 'DESPESAS ADMINISTRATIVAS', 3, 30, FALSE),
  ('Cartuchos e Tonners', 'DESPESAS ADMINISTRATIVAS', 3, 31, FALSE),
  ('Combustíveis', 'DESPESAS ADMINISTRATIVAS', 3, 32, FALSE),
  ('Consulta de Crédito Cliente', 'DESPESAS ADMINISTRATIVAS', 3, 33, FALSE),
  ('Coquetéis, festas  e outros eventos', 'DESPESAS ADMINISTRATIVAS', 3, 34, FALSE),
  ('Despesa não Identificada', 'DESPESAS ADMINISTRATIVAS', 3, 35, FALSE),
  ('Despesas com Cartorio', 'DESPESAS ADMINISTRATIVAS', 3, 36, FALSE),
  ('Despesas com Documentos e Xerox', 'DESPESAS ADMINISTRATIVAS', 3, 37, FALSE),
  ('Energia Elétrica', 'DESPESAS ADMINISTRATIVAS', 3, 38, FALSE),
  ('Frete e Transporte de Mercadorias', 'DESPESAS ADMINISTRATIVAS', 3, 39, FALSE),
  ('Honorários Advocatícios', 'DESPESAS ADMINISTRATIVAS', 3, 40, FALSE),
  ('Honorários Contábeis e Consultoria', 'DESPESAS ADMINISTRATIVAS', 3, 41, FALSE),
  ('Iptu', 'DESPESAS ADMINISTRATIVAS', 3, 42, FALSE),
  ('Ipva', 'DESPESAS ADMINISTRATIVAS', 3, 43, FALSE),
  ('Manutenção de Imóveis', 'DESPESAS ADMINISTRATIVAS', 3, 44, FALSE),
  ('Manutenção de Máquinas e Peças', 'DESPESAS ADMINISTRATIVAS', 3, 45, FALSE),
  ('Manutenção de Moveis e Utensílios', 'DESPESAS ADMINISTRATIVAS', 3, 46, FALSE),
  ('Manutenção de Veiculos e Estacionamento', 'DESPESAS ADMINISTRATIVAS', 3, 47, FALSE),
  ('Material de Copa e Cozinha', 'DESPESAS ADMINISTRATIVAS', 3, 48, FALSE),
  ('Material de Escritório', 'DESPESAS ADMINISTRATIVAS', 3, 49, FALSE),
  ('Material de Limpeza e Higiene', 'DESPESAS ADMINISTRATIVAS', 3, 50, FALSE),
  ('Multas de Trânsito', 'DESPESAS ADMINISTRATIVAS', 3, 51, FALSE),
  ('Outras taxas e Tributos', 'DESPESAS ADMINISTRATIVAS', 3, 52, FALSE),
  ('Reembolsos Diversos', 'DESPESAS ADMINISTRATIVAS', 3, 53, FALSE),
  ('Segurança e Monitoramento', 'DESPESAS ADMINISTRATIVAS', 3, 54, FALSE),
  ('Serviços de Terceiros', 'DESPESAS ADMINISTRATIVAS', 3, 55, FALSE),
  ('Taxi e Moto-taxi', 'DESPESAS ADMINISTRATIVAS', 3, 56, FALSE),
  ('Telefonia Fixa e Internet', 'DESPESAS ADMINISTRATIVAS', 3, 57, FALSE),
  ('Telefonia Móvel', 'DESPESAS ADMINISTRATIVAS', 3, 58, FALSE),
  ('Viagens e Estadias', 'DESPESAS ADMINISTRATIVAS', 3, 59, FALSE),
  ('Web Site / Sistema ERP / Software', 'DESPESAS ADMINISTRATIVAS', 3, 60, FALSE),
  ('Acabamento Externo', 'CUSTO DE PRODUÇÃO', 4, 61, FALSE),
  ('Aviamentos e Acessórios', 'CUSTO DE PRODUÇÃO', 4, 62, FALSE),
  ('Bordado Industrial', 'CUSTO DE PRODUÇÃO', 4, 63, FALSE),
  ('Caseado', 'CUSTO DE PRODUÇÃO', 4, 64, FALSE),
  ('Comissão Produtividade', 'CUSTO DE PRODUÇÃO', 4, 65, FALSE),
  ('Criação de Modelos', 'CUSTO DE PRODUÇÃO', 4, 66, FALSE),
  ('Embalagens', 'CUSTO DE PRODUÇÃO', 4, 67, FALSE),
  ('Etiquetas', 'CUSTO DE PRODUÇÃO', 4, 68, FALSE),
  ('Facção', 'CUSTO DE PRODUÇÃO', 4, 69, FALSE),
  ('Frete Compra', 'CUSTO DE PRODUÇÃO', 4, 70, FALSE),
  ('Lavanderia', 'CUSTO DE PRODUÇÃO', 4, 71, FALSE),
  ('Outros Insumos', 'CUSTO DE PRODUÇÃO', 4, 72, FALSE),
  ('Produção Externa', 'CUSTO DE PRODUÇÃO', 4, 73, FALSE),
  ('Tecidos', 'CUSTO DE PRODUÇÃO', 4, 74, FALSE),
  ('Travete', 'CUSTO DE PRODUÇÃO', 4, 75, FALSE),
  ('Comissão de Assessores', 'DESPESAS COM VENDAS', 5, 76, FALSE),
  ('Comissão de Vendedores', 'DESPESAS COM VENDAS', 5, 77, FALSE),
  ('Frete Venda', 'DESPESAS COM VENDAS', 5, 78, FALSE),
  ('Inadimplência / Ch dvlvd', 'DESPESAS COM VENDAS', 5, 79, FALSE),
  ('Marketing', 'DESPESAS COM VENDAS', 5, 80, FALSE),
  ('Sacolas / Caixas / Fardos', 'DESPESAS COM VENDAS', 5, 81, FALSE),
  ('Simples Nacional', 'DESPESAS COM VENDAS', 5, 82, FALSE),
  ('Taxas Boletos Bancários', 'DESPESAS COM VENDAS', 5, 83, FALSE),
  ('Taxas de Recebimento de Cartão / Pic Pay', 'DESPESAS COM VENDAS', 5, 84, FALSE),
  ('Taxas Site / Market Place', 'DESPESAS COM VENDAS', 5, 85, FALSE),
  ('Amortização de Emprestimos', 'INVESTIMENTOS E RETIRADAS', 6, 86, FALSE),
  ('Amortização de Luvas e aquisição de lojas', 'INVESTIMENTOS E RETIRADAS', 6, 87, FALSE),
  ('Aplicações Financeiras', 'INVESTIMENTOS E RETIRADAS', 6, 88, FALSE),
  ('Aplicações Rápidas', 'INVESTIMENTOS E RETIRADAS', 6, 89, FALSE),
  ('Compra de Computadores e Eletrônicos', 'INVESTIMENTOS E RETIRADAS', 6, 90, FALSE),
  ('Compra de Imóveis', 'INVESTIMENTOS E RETIRADAS', 6, 91, FALSE),
  ('Compra de Máquinas e Equipamentos', 'INVESTIMENTOS E RETIRADAS', 6, 92, FALSE),
  ('Compra de Móveis e Utensilios', 'INVESTIMENTOS E RETIRADAS', 6, 93, FALSE),
  ('Compra de Veículos', 'INVESTIMENTOS E RETIRADAS', 6, 94, FALSE),
  ('Consórcio', 'INVESTIMENTOS E RETIRADAS', 6, 95, FALSE),
  ('Empréstimos de Terceiros', 'INVESTIMENTOS E RETIRADAS', 6, 96, FALSE),
  ('Investimentos Tecnologia', 'INVESTIMENTOS E RETIRADAS', 6, 97, FALSE),
  ('Melhorias / Reformas e Construção', 'INVESTIMENTOS E RETIRADAS', 6, 98, FALSE),
  ('Retirada Sócios Erisvania', 'INVESTIMENTOS E RETIRADAS', 6, 99, FALSE),
  ('Retirada Sócios Jean', 'INVESTIMENTOS E RETIRADAS', 6, 100, FALSE),
  ('Títulos de Capitalização', 'INVESTIMENTOS E RETIRADAS', 6, 101, FALSE),
  ('Ajuste de Saldo', 'RECEITA NÃO-OPERACIONAL', 7, 102, TRUE),
  ('Descontos Recebidos', 'RECEITA NÃO-OPERACIONAL', 7, 103, TRUE),
  ('Entrada de Empréstimos', 'RECEITA NÃO-OPERACIONAL', 7, 104, TRUE),
  ('Multas e Juros Recebidos', 'RECEITA NÃO-OPERACIONAL', 7, 105, TRUE),
  ('Outras Entradas', 'RECEITA NÃO-OPERACIONAL', 7, 106, TRUE),
  ('Receita com Aplicações', 'RECEITA NÃO-OPERACIONAL', 7, 107, TRUE),
  ('Resgate de Aplicações Rápidas', 'RECEITA NÃO-OPERACIONAL', 7, 108, TRUE),
  ('Resgate de Títulos / Aplicações', 'RECEITA NÃO-OPERACIONAL', 7, 109, TRUE),
  ('Aporte de Sócios Erisvania', 'ENTRADA DE ATIVOS', 8, 110, TRUE),
  ('Aporte de Sócios Jean', 'ENTRADA DE ATIVOS', 8, 111, TRUE),
  ('Venda de Móveis, Máquinas e Equipamentos', 'ENTRADA DE ATIVOS', 8, 112, TRUE),
  ('Juros Cheque Especial', 'DESPESAS FINANCEIRAS', 9, 113, FALSE),
  ('Juros de Empréstimos', 'DESPESAS FINANCEIRAS', 9, 114, FALSE),
  ('Juros Desconto de Cheques', 'DESPESAS FINANCEIRAS', 9, 115, FALSE),
  ('Multas e Juros por Atraso', 'DESPESAS FINANCEIRAS', 9, 116, FALSE),
  ('Taxas Bancárias', 'DESPESAS FINANCEIRAS', 9, 117, FALSE),
  ('Recebimento de Adiantamento Colaboradores', 'TRANSITÓRIO ENTRADA', 10, 118, TRUE),
  ('Recebimento de adiantamento Fornecedores', 'TRANSITÓRIO ENTRADA', 10, 119, TRUE),
  ('Transitório Entrada', 'TRANSITÓRIO ENTRADA', 10, 120, TRUE),
  ('Adiantamento a Colaboradores', 'TRANSITÓRIO SAÍDA', 11, 121, FALSE),
  ('Adiantamento a Fornecedores', 'TRANSITÓRIO SAÍDA', 11, 122, FALSE),
  ('Transitório Saída', 'TRANSITÓRIO SAÍDA', 11, 123, FALSE)
ON CONFLICT (nome) DO NOTHING;

ALTER TABLE fin_plano ADD COLUMN IF NOT EXISTS fech_conta_id INTEGER REFERENCES fin_fech_contas(id) ON DELETE SET NULL;

-- 3) Fatia fixa que o Marketplace assume de cada conta da matriz.
CREATE TABLE IF NOT EXISTS fin_fech_fatias (
  conta_id INTEGER PRIMARY KEY REFERENCES fin_fech_contas(id) ON DELETE CASCADE,
  percentual NUMERIC(6,3) NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT fin_fech_fatia_faixa CHECK (percentual >= 0 AND percentual <= 100)
);

-- 4) Orçamento (a coluna IDEAL). Valor mensal por conta; o % ideal é o valor
--    sobre a receita orçada da mesma unidade, igual ao ORÇAMENTO 1.
CREATE TABLE IF NOT EXISTS fin_fech_orcamento (
  unidade VARCHAR(12) NOT NULL CHECK (unidade IN ('matriz', 'marketplace')),
  conta_id INTEGER NOT NULL REFERENCES fin_fech_contas(id) ON DELETE CASCADE,
  valor_mensal NUMERIC(14,2) NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  PRIMARY KEY (unidade, conta_id)
);

-- Semente: o ORÇAMENTO 1 da planilha, como meta da MATRIZ (escolha do dono).
-- O Marketplace começa sem meta — a coluna Ideal mostra "—" até alguém definir.
INSERT INTO fin_fech_orcamento (unidade, conta_id, valor_mensal)
SELECT 'matriz', c.id, v.valor
  FROM (VALUES
  ('Vendas', 770000.0),
  ('Salarios e Ordenados', -45000.0),
  ('13º Salário', -2000.0),
  ('Acertos e Recisões', -2000.0),
  ('Ajuda de Custo', -2300.0),
  ('Bonificação', -1000.0),
  ('Despesa com Sindicatos', -50.0),
  ('Férias', -2500.0),
  ('Fgts / Inss / Irrf / Irpf/darf', -6500.0),
  ('Hora Extra', -500.0),
  ('Lanches / Refeições', -1200.0),
  ('Pro Labore Sócios Erisvania', -10000.0),
  ('Pro Labore Sócios Jean', -15000.0),
  ('Seguro de Vida', -755.0),
  ('Treinamento / Cursos', -100.0),
  ('Uniformes e EPIs', -50.0),
  ('Vale Alimentação', -100.0),
  ('Vale Transporte', -2000.0),
  ('Água e Esgoto', -600.0),
  ('Aluguéis e Condomínios', -15000.0),
  ('Cartuchos e Tonners', -200.0),
  ('Combustíveis', -2000.0),
  ('Consulta de Crédito Cliente', -200.0),
  ('Coquetéis, festas  e outros eventos', -500.0),
  ('Despesas com Cartorio', -50.0),
  ('Despesas com Documentos e Xerox', -50.0),
  ('Energia Elétrica', -1800.0),
  ('Frete e Transporte de Mercadorias', -1000.0),
  ('Honorários Advocatícios', -1500.0),
  ('Honorários Contábeis e Consultoria', -4000.0),
  ('Iptu', -450.0),
  ('Ipva', -1000.0),
  ('Manutenção de Imóveis', -500.0),
  ('Manutenção de Máquinas e Peças', -600.0),
  ('Manutenção de Moveis e Utensílios', -300.0),
  ('Manutenção de Veiculos e Estacionamento', -1000.0),
  ('Material de Copa e Cozinha', -500.0),
  ('Material de Escritório', -500.0),
  ('Material de Limpeza e Higiene', -300.0),
  ('Segurança e Monitoramento', -200.0),
  ('Serviços de Terceiros', -100.0),
  ('Taxi e Moto-taxi', -100.0),
  ('Telefonia Fixa e Internet', -400.0),
  ('Telefonia Móvel', -250.0),
  ('Viagens e Estadias', -500.0),
  ('Web Site / Sistema ERP / Software', -1800.0),
  ('Acabamento Externo', -4000.0),
  ('Aviamentos e Acessórios', -15000.0),
  ('Bordado Industrial', -7000.0),
  ('Caseado', -500.0),
  ('Criação de Modelos', -1000.0),
  ('Embalagens', -4000.0),
  ('Etiquetas', -3000.0),
  ('Facção', -80000.0),
  ('Frete Compra', -200.0),
  ('Lavanderia', -15000.0),
  ('Outros Insumos', -2000.0),
  ('Produção Externa', -8000.0),
  ('Tecidos', -250000.0),
  ('Travete', -2000.0),
  ('Comissão de Assessores', -8500.0),
  ('Comissão de Vendedores', -5000.0),
  ('Frete Venda', -200.0),
  ('Inadimplência / Ch dvlvd', -17000.0),
  ('Marketing', -9000.0),
  ('Sacolas / Caixas / Fardos', -1000.0),
  ('Simples Nacional', -25000.0),
  ('Taxas Boletos Bancários', -200.0),
  ('Taxas de Recebimento de Cartão / Pic Pay', -3000.0),
  ('Amortização de Emprestimos', -5000.0),
  ('Compra de Computadores e Eletrônicos', -500.0),
  ('Compra de Máquinas e Equipamentos', -500.0),
  ('Compra de Móveis e Utensilios', -500.0),
  ('Compra de Veículos', -4000.0),
  ('Consórcio', -10000.0),
  ('Investimentos Tecnologia', -100.0),
  ('Melhorias / Reformas e Construção', -1000.0),
  ('Taxas Bancárias', -1000.0)
  ) AS v(nome, valor)
  JOIN fin_fech_contas c ON c.nome = v.nome
ON CONFLICT (unidade, conta_id) DO NOTHING;

-- 5) O mês de cada unidade: saldo de abertura informado (só no primeiro mês;
--    depois ele vem do mês anterior), a posição do fim do mês que não sai de
--    lançamento (estoques, aplicações) e a trava de mês fechado com a foto do
--    resultado no momento do fechamento.
CREATE TABLE IF NOT EXISTS fin_fech_meses (
  unidade VARCHAR(12) NOT NULL CHECK (unidade IN ('matriz', 'marketplace')),
  mes DATE NOT NULL,                     -- sempre o dia 1º
  saldo_inicial NUMERIC(14,2),           -- só quando informado à mão
  posicao JSONB NOT NULL DEFAULT '{}'::jsonb,
  observacao TEXT,
  fechado_em TIMESTAMPTZ,
  fechado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  foto JSONB,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (unidade, mes),
  CONSTRAINT fin_fech_mes_dia1 CHECK (EXTRACT(DAY FROM mes) = 1)
);

-- 6) O plano gerencial que o próprio Hub semeou (0055) ligado às contas da
--    planilha onde a correspondência é uma só. Os ambíguos ("Matéria-prima e
--    aviamento", "Despesas administrativas", "Custo de antecipação") ficam sem
--    ligação de propósito: aparecem como "a classificar" e quem conhece o
--    lançamento escolhe — chutar aqui esconderia o erro dentro de um grupo.
UPDATE fin_plano p SET fech_conta_id = c.id
  FROM (VALUES
    ('1.1', 'Vendas'), ('1.2', 'Vendas'), ('1.3', 'Outras Entradas'),
    ('2.1', 'Taxas Site / Market Place'), ('2.2', 'Frete Venda'), ('2.3', 'Marketing'),
    ('2.4', 'Simples Nacional'), ('2.5', 'Devoluções de Vendas'),
    ('3.2', 'Facção'), ('3.3', 'Salarios e Ordenados'),
    ('4.1', 'Aluguéis e Condomínios'), ('4.3', 'Salarios e Ordenados'),
    ('4.4', 'Honorários Contábeis e Consultoria'), ('4.5', 'Web Site / Sistema ERP / Software'),
    ('5.1', 'Taxas Bancárias'), ('5.2', 'Multas e Juros por Atraso'),
    ('6.1', 'Simples Nacional'), ('6.2', 'Fgts / Inss / Irrf / Irpf/darf')
  ) AS v(codigo, conta)
  JOIN fin_fech_contas c ON c.nome = v.conta
 WHERE p.codigo = v.codigo AND p.fech_conta_id IS NULL;
