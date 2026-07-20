import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

const buildConfigError = () =>
  new Error(
    'Configurações do Supabase não encontradas. Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY antes de publicar o frontend.'
  );

const createMockSupabaseClient = () => ({
  auth: {
    getSession: async () => ({ data: { session: null }, error: buildConfigError() }),
    onAuthStateChange: (callback) => {
      if (typeof callback === 'function') {
        queueMicrotask(() => callback('INITIAL_SESSION', null));
      }

      return {
        data: {
          subscription: {
            unsubscribe: () => {},
          },
        },
      };
    },
    signUp: async () => ({ data: null, error: buildConfigError() }),
    signInWithPassword: async () => ({ data: null, error: buildConfigError() }),
    signOut: async () => ({ error: null }),
  },
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: buildConfigError() }),
      }),
    }),
  }),
});

let client;

if (!hasSupabaseConfig) {
  console.error(
    '❌ Configurações do Supabase não encontradas. O app continuará carregando sem travar, mas login/cadastro exigem VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY configuradas no ambiente.'
  );
  client = createMockSupabaseClient();
} else {
  try {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  } catch (error) {
    console.error('❌ Falha ao inicializar o cliente Supabase:', error);
    client = createMockSupabaseClient();
  }
}

export const supabase = client;
