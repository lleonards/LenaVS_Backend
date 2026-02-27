import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ ERRO: Variáveis de ambiente do Supabase não encontradas no Backend!');
}

/* =====================================================
   🔐 CLIENTE ADMIN (SERVICE ROLE)
   Ignora RLS – usar para backend
===================================================== */

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

/* =====================================================
   🔑 CLIENTE PÚBLICO (ANON)
   Respeita RLS
===================================================== */

const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

/* =====================================================
   EXPORTS
===================================================== */

// ✅ Export default (resolve seu erro no deploy)
export default supabaseAdmin;

// Mantém compatibilidade caso você use named imports em outro lugar
export { supabaseAdmin, supabaseAnon };

export const supabaseConfig = {
  url: supabaseUrl,
  jwtSecret: process.env.SUPABASE_JWT_SECRET
};