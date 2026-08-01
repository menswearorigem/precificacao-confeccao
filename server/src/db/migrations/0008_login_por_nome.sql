-- Login passa a ser feito por nome (não e-mail) — precisa que o nome seja
-- único (comparação sem diferenciar maiúsculas/minúsculas, já que é assim
-- que o login busca o usuário).
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_nome_lower_idx ON usuarios (LOWER(nome));
