-- =========================================
-- LENA VS - MIGRATION: CANCELLATION SURVEY
-- =========================================
-- Adds cancellation_survey_pending flag to users
-- and creates cancellation_feedback table.
-- Run this in Supabase SQL Editor.
-- =========================================

-- 1. Add cancellation_survey_pending column to users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS cancellation_survey_pending boolean NOT NULL DEFAULT false;

-- 2. Create cancellation_feedback table
CREATE TABLE IF NOT EXISTS public.cancellation_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  email text,
  reason text NOT NULL,
  feedback text,
  plan text,
  subscription_status text,
  stripe_subscription_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_feedback_reason_check CHECK (
    reason IN (
      'not_found',
      'difficult_to_use',
      'alternative_tool',
      'technical_issues',
      'price',
      'no_longer_use',
      'other'
    )
  )
);

CREATE INDEX IF NOT EXISTS cancellation_feedback_user_id_idx
  ON public.cancellation_feedback(user_id);

CREATE INDEX IF NOT EXISTS cancellation_feedback_reason_idx
  ON public.cancellation_feedback(reason);

CREATE INDEX IF NOT EXISTS cancellation_feedback_created_at_idx
  ON public.cancellation_feedback(created_at DESC);

CREATE INDEX IF NOT EXISTS cancellation_feedback_email_idx
  ON public.cancellation_feedback(email);

ALTER TABLE public.cancellation_feedback ENABLE ROW LEVEL SECURITY;

-- Only service_role (backend) can read/write this table
REVOKE ALL ON public.cancellation_feedback FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cancellation_feedback TO service_role;
