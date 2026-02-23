import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Garante que as variáveis sejam carregadas antes de qualquer outra coisa
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Verificação de segurança para o log do servidor (ajuda muito no deploy)
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ ERRO: Variáveis de ambiente do Supabase não encontradas no Backend!');
}

// 🔐 Cliente Administrativo (Service Role) - Ignora RLS
// Use este para operações que o usuário não pode fazer sozinho (ex: criar user na tabela)
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// 🔑 Cliente Público (Anon Key) - Respeita RLS
export const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

export const supabaseConfig = {
  url: supabaseUrl,
  jwtSecret: process.env.SUPABASE_JWT_SECRET
};
