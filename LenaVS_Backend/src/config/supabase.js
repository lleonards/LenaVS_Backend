import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const readEnv = (...names) => {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
};

const supabaseUrl = readEnv('SUPABASE_URL').replace(/\/+$/, '');
const supabaseServiceKey = readEnv('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');
const supabaseAnonKey = readEnv('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

const PLACEHOLDER_PATTERN = /dummy|example\.com|your[-_]|changeme|troque|coloque|xxxx/i;

const configIssues = [];

if (!supabaseUrl) {
  configIssues.push('SUPABASE_URL não definida.');
} else if (!/^https?:\/\//i.test(supabaseUrl)) {
  configIssues.push('SUPABASE_URL inválida (precisa começar com https://).');
} else if (PLACEHOLDER_PATTERN.test(supabaseUrl)) {
  configIssues.push('SUPABASE_URL ainda contém valor de exemplo.');
}

if (!supabaseServiceKey) {
  configIssues.push('SUPABASE_SERVICE_ROLE_KEY não definida.');
} else if (PLACEHOLDER_PATTERN.test(supabaseServiceKey)) {
  configIssues.push('SUPABASE_SERVICE_ROLE_KEY ainda contém valor de exemplo.');
}

if (!supabaseAnonKey) {
  configIssues.push('SUPABASE_ANON_KEY não definida (cadastro e login dependem dela).');
} else if (PLACEHOLDER_PATTERN.test(supabaseAnonKey)) {
  configIssues.push('SUPABASE_ANON_KEY ainda contém valor de exemplo.');
}

if (configIssues.length) {
  console.error('❌ Configuração do Supabase incompleta no backend:');
  configIssues.forEach((issue) => console.error(`   • ${issue}`));
  console.error('   Cadastro e login vão falhar até essas variáveis serem corrigidas.');
}

/* =====================================================
   🔐 CLIENTE ADMIN (SERVICE ROLE)
   Ignora RLS. Nunca use este cliente para validar a
   senha do usuário — use o cliente ANON para isso.
===================================================== */

const safeUrl = supabaseUrl || 'http://127.0.0.1:54321';
const safeServiceKey = supabaseServiceKey || 'missing-service-role-key';
const safeAnonKey = supabaseAnonKey || safeServiceKey;

const supabase = createClient(safeUrl, safeServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

/* =====================================================
   🔑 CLIENTE PÚBLICO (ANON)
   -----------------------------------------------------
   CORRIGIDO: no servidor estes dois parâmetros precisam
   ficar desligados. Com persistSession/autoRefreshToken
   ligados (padrão do SDK no navegador), o cliente ANON
   guardava sessão em memória no processo Node, podia
   iniciar timers de refresh e vazar a sessão de um
   usuário para a requisição de outro.
===================================================== */

const supabaseAnon = createClient(safeUrl, safeAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

/* =====================================================
   EXPORTS (COMPATÍVEL COM TODO O PROJETO)
===================================================== */

export { supabase, supabaseAnon };

export default supabase;

export const supabaseConfig = {
  url: safeUrl,
  jwtSecret: process.env.SUPABASE_JWT_SECRET,
  hasAnonKey: Boolean(supabaseAnonKey),
  issues: configIssues,
};

export const hasSupabaseAuthConfig = Boolean(supabaseUrl && supabaseAnonKey) && configIssues.length === 0;
