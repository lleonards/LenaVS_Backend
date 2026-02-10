import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Cliente Supabase para operações administrativas
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cliente Supabase para operações do usuário (anon key)
export const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export const supabaseConfig = {
  url: process.env.SUPABASE_URL,
  jwtSecret: process.env.SUPABASE_JWT_SECRET
};
