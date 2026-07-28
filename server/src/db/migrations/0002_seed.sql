-- Dados padrão (listas, taxas de venda, itens de rateio, empresas).
-- Tudo aqui é editável pela interface depois - isso só evita começar do zero.

INSERT INTO listas (tipo, valor, ordem) VALUES
  ('categoria', 'Camiseta Dryfit', 1),
  ('categoria', 'Camiseta Polo', 2),
  ('categoria', 'Bermuda', 3),
  ('categoria', 'Vestido', 4),
  ('categoria', 'Camisa', 5),
  ('categoria', 'Calça Jeans', 6),
  ('categoria', 'Jaqueta', 7),
  ('categoria', 'Saia', 8),
  ('categoria', 'Conjunto', 9),
  ('categoria', 'Outro', 10),

  ('marca', 'Miss Manu', 1),
  ('marca', 'Origem', 2),
  ('marca', 'Hoggar', 3),
  ('marca', 'Hebron', 4),
  ('marca', 'Outra', 5),

  ('colecao', 'Verão', 1),
  ('colecao', 'Inverno', 2),
  ('colecao', 'Meia Estação', 3),
  ('colecao', 'Ano Todo', 4),
  ('colecao', 'Edição Limitada', 5),

  ('linha', 'Country/Agro', 1),
  ('linha', 'Elegante Moderno', 2),
  ('linha', 'Casual', 3),
  ('linha', 'Fitness', 4),
  ('linha', 'Básica', 5),

  ('material', 'Tecido', 1),
  ('material', 'Forro', 2),
  ('material', 'Entretela', 3),
  ('material', 'Linha', 4),
  ('material', 'Botões', 5),
  ('material', 'Zíper', 6),
  ('material', 'Elástico', 7),
  ('material', 'Etiquetas', 8),
  ('material', 'Tag', 9),
  ('material', 'Saco Plástico', 10),
  ('material', 'Caixa', 11),
  ('material', 'Cabide', 12),
  ('material', 'Embalagem', 13),
  ('material', 'Silk', 14),
  ('material', 'Bordado', 15),
  ('material', 'Estampa', 16),
  ('material', 'Transfer', 17),
  ('material', 'Pedrarias', 18),
  ('material', 'Acessórios', 19),

  ('unidade', 'un', 1),
  ('unidade', 'm', 2),
  ('unidade', 'cm', 3),
  ('unidade', 'kg', 4),
  ('unidade', 'g', 5),
  ('unidade', 'par', 6),
  ('unidade', 'cj', 7),
  ('unidade', 'rolo', 8),
  ('unidade', 'pct', 9),

  ('tipo_custo_industrial', 'Facção', 1),
  ('tipo_custo_industrial', 'Corte', 2),
  ('tipo_custo_industrial', 'Costura', 3),
  ('tipo_custo_industrial', 'Lavagem', 4),
  ('tipo_custo_industrial', 'Passadoria', 5),
  ('tipo_custo_industrial', 'Acabamento', 6),
  ('tipo_custo_industrial', 'Revisão', 7),
  ('tipo_custo_industrial', 'Controle de Qualidade', 8),
  ('tipo_custo_industrial', 'Embalagem', 9),
  ('tipo_custo_industrial', 'Expedição', 10),
  ('tipo_custo_industrial', 'Frete da Facção', 11),
  ('tipo_custo_industrial', 'Frete de Retorno', 12),
  ('tipo_custo_industrial', 'Frete Interno', 13),
  ('tipo_custo_industrial', 'Terceirizações', 14),
  ('tipo_custo_industrial', 'Outro Custo Industrial', 15)
ON CONFLICT (tipo, valor) DO NOTHING;

INSERT INTO taxas_venda (nome, ativo, percentual, ordem) VALUES
  ('Comissão do Vendedor', TRUE, 0, 1),
  ('Shopee', FALSE, 0, 2),
  ('Mercado Livre', FALSE, 0, 3),
  ('TikTok Shop', FALSE, 0, 4),
  ('Shein', FALSE, 0, 5),
  ('Amazon', FALSE, 0, 6),
  ('Cartão de Crédito', FALSE, 0, 7),
  ('Cartão de Débito', FALSE, 0, 8),
  ('Antecipação de Recebíveis', FALSE, 0, 9),
  ('PIX', TRUE, 0, 10),
  ('Boleto', FALSE, 0, 11),
  ('Gateway de Pagamento', FALSE, 0, 12),
  ('Outras Taxas Financeiras', FALSE, 0, 13)
ON CONFLICT DO NOTHING;

INSERT INTO custos_indiretos_itens (nome, valor_mensal, ordem) VALUES
  ('Aluguel', 0, 1),
  ('Energia Elétrica', 0, 2),
  ('Água', 0, 3),
  ('Internet', 0, 4),
  ('Telefone', 0, 5),
  ('Sistema ERP', 0, 6),
  ('Software/Licenças', 0, 7),
  ('Seguros', 0, 8),
  ('Material de Escritório', 0, 9),
  ('Limpeza', 0, 10),
  ('Manutenção', 0, 11),
  ('Depreciação de Máquinas', 0, 12),
  ('Depreciação de Equipamentos', 0, 13),
  ('Depreciação de Veículos', 0, 14),
  ('Combustível', 0, 15),
  ('Contabilidade', 0, 16),
  ('Consultorias', 0, 17),
  ('Despesas Bancárias', 0, 18),
  ('Taxas Financeiras (fixas)', 0, 19),
  ('Salário Administrativo', 0, 20),
  ('Pró-labore', 0, 21),
  ('Encargos (INSS/FGTS etc.)', 0, 22),
  ('Marketing', 0, 23),
  ('Publicidade', 0, 24),
  ('Fotografia de Produtos', 0, 25),
  ('Plataforma E-commerce', 0, 26),
  ('Taxa Fixa Marketplace', 0, 27),
  ('Comissões Fixas', 0, 28),
  ('Impostos Fixos (taxas/alvará)', 0, 29),
  ('Outros Custos Indiretos', 0, 30)
ON CONFLICT DO NOTHING;

INSERT INTO empresas (nome, regime_tributario, simples_aliquota, ordem)
  SELECT 'Empresa 1 (Simples Nacional)', 'Simples Nacional', 0.06, 1
  WHERE NOT EXISTS (SELECT 1 FROM empresas);

INSERT INTO empresas (nome, regime_tributario, icms, pis, cofins, ipi, iss, ordem)
  SELECT 'Empresa 2 (Lucro Real)', 'Lucro Real', 0, 0, 0, 0, 0, 2
  WHERE (SELECT COUNT(*) FROM empresas) = 1;
