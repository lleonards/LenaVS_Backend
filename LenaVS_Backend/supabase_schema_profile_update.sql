-- Atualização opcional do schema para perfil do usuário no LenaVS
-- Execute este script no Supabase SQL Editor se quiser persistir
-- nome e avatar também na tabela public.users.
-- O backend continua funcionando mesmo sem essas colunas,
-- usando user_metadata do Supabase Auth como fallback.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS avatar_url text;

COMMENT ON COLUMN public.users.display_name IS 'Nome público/editável do usuário exibido na interface.';
COMMENT ON COLUMN public.users.avatar_url IS 'URL pública da foto de perfil do usuário.';
