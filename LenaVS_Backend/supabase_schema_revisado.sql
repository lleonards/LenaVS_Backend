-- =========================================
-- LENA VS - SUPABASE SCHEMA COMPLETO E REVISADO
-- Compatível com:
-- - histórico de projetos
-- - biblioteca pública
-- - publicar / despublicar
-- - fork/cópia de projeto público
-- - contador de downloads/forks
-- - middleware auth.js / requireActiveAccess.js do backend
--
-- OBSERVAÇÃO IMPORTANTE:
-- A principal correção desta versão está na migração do campo legado
-- `project_data` -> `config`. Na versão anterior, o COALESCE priorizava
-- `config` mesmo quando ele já existia apenas com '{}'::jsonb, o que podia
-- impedir a migração real dos dados antigos.
-- =========================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =========================================
-- TABELA USERS
-- =========================================

CREATE TABLE IF NOT EXISTS public.users (
  id                   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                text UNIQUE NOT NULL,
  plan                 text NOT NULL DEFAULT 'free',
  credits              integer NOT NULL DEFAULT 3,
  credits_reset_at     timestamptz NOT NULL DEFAULT now(),
  subscription_status  text NOT NULL DEFAULT 'trial',
  stripe_customer_id   text,
  trial_end            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro')),
  CONSTRAINT users_subscription_status_check CHECK (
    subscription_status IN ('inactive', 'trial', 'active', 'past_due', 'canceled')
  ),
  CONSTRAINT users_credits_check CHECK (credits >= 0)
);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS credits integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS credits_reset_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS trial_end timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.users
SET trial_end = COALESCE(trial_end, created_at + interval '3 days')
WHERE trial_end IS NULL;

-- =========================================
-- FUNÇÃO GERAL updated_at
-- =========================================

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_updated_at ON public.users;
CREATE TRIGGER users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE PROCEDURE public.update_updated_at();

-- =========================================
-- RLS USERS
-- =========================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_select_own" ON public.users;
DROP POLICY IF EXISTS "users_update_own" ON public.users;
DROP POLICY IF EXISTS "users_insert_own" ON public.users;

CREATE POLICY "users_select_own"
  ON public.users FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "users_update_own"
  ON public.users FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "users_insert_own"
  ON public.users FOR INSERT
  WITH CHECK (auth.uid() = id);

-- =========================================
-- FUNÇÃO: CRIAR USUÁRIO AUTOMATICAMENTE
-- =========================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id,
    email,
    plan,
    credits,
    credits_reset_at,
    subscription_status,
    trial_end,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    'free',
    3,
    now(),
    'trial',
    now() + interval '3 days',
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE PROCEDURE public.handle_new_user();

-- =========================================
-- TABELA PROJECTS
-- =========================================

CREATE TABLE IF NOT EXISTS public.projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_public      boolean NOT NULL DEFAULT false,
  resolution     text NOT NULL DEFAULT '720p',
  description    text NOT NULL DEFAULT '',
  download_count integer NOT NULL DEFAULT 0,
  forked_from    uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT projects_download_count_check CHECK (download_count >= 0)
);

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolution text NOT NULL DEFAULT '720p',
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS download_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forked_from uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Migração automática caso o schema antigo use project_data
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'projects'
      AND column_name = 'project_data'
  ) THEN
    EXECUTE $migration$
      UPDATE public.projects
      SET config = CASE
        WHEN config IS NULL OR config = '{}'::jsonb THEN COALESCE(project_data, '{}'::jsonb)
        ELSE config
      END
      WHERE project_data IS NOT NULL
    $migration$;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS projects_user_id_idx ON public.projects(user_id);
CREATE INDEX IF NOT EXISTS projects_is_public_idx ON public.projects(is_public);
CREATE INDEX IF NOT EXISTS projects_created_at_idx ON public.projects(created_at DESC);
CREATE INDEX IF NOT EXISTS projects_forked_from_idx ON public.projects(forked_from);
CREATE INDEX IF NOT EXISTS projects_name_search_idx
  ON public.projects USING gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '')));

DROP TRIGGER IF EXISTS projects_updated_at ON public.projects;
CREATE TRIGGER projects_updated_at
BEFORE UPDATE ON public.projects
FOR EACH ROW
EXECUTE PROCEDURE public.update_updated_at();

-- =========================================
-- RLS PROJECTS
-- =========================================

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select_own" ON public.projects;
DROP POLICY IF EXISTS "projects_select_public" ON public.projects;
DROP POLICY IF EXISTS "projects_insert_own" ON public.projects;
DROP POLICY IF EXISTS "projects_update_own" ON public.projects;
DROP POLICY IF EXISTS "projects_delete_own" ON public.projects;

CREATE POLICY "projects_select_own"
  ON public.projects FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "projects_select_public"
  ON public.projects FOR SELECT
  USING (is_public = true);

CREATE POLICY "projects_insert_own"
  ON public.projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "projects_update_own"
  ON public.projects FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "projects_delete_own"
  ON public.projects FOR DELETE
  USING (auth.uid() = user_id);

-- =========================================
-- FUNÇÃO RPC: INCREMENTAR DOWNLOAD COUNT
-- =========================================

CREATE OR REPLACE FUNCTION public.increment_download_count(project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.projects
  SET download_count = download_count + 1
  WHERE id = project_id;
END;
$$;

-- =========================================
-- TABELA PROJECT_DOWNLOADS
-- Histórico de forks/downloads de projetos públicos
-- =========================================

CREATE TABLE IF NOT EXISTS public.project_downloads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  downloaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pdl_project_idx ON public.project_downloads(project_id);
CREATE INDEX IF NOT EXISTS pdl_user_idx ON public.project_downloads(user_id);
CREATE INDEX IF NOT EXISTS pdl_downloaded_at_idx ON public.project_downloads(downloaded_at DESC);

ALTER TABLE public.project_downloads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pdl_insert_own" ON public.project_downloads;
DROP POLICY IF EXISTS "pdl_select_own" ON public.project_downloads;

CREATE POLICY "pdl_insert_own"
  ON public.project_downloads FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "pdl_select_own"
  ON public.project_downloads FOR SELECT
  USING (auth.uid() = user_id);
