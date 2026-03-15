// 🔥 IMPORTANTE: Importe o supabase da sua pasta de config/supabase.js
// Isso garante que você use o cliente que já foi inicializado corretamente
import { supabase } from '../config/supabase.js';

/**
 * Garante que o usuário exista na tabela users
 * Se não existir → cria com trial de 3 dias e 3 créditos
 */
const ensureUserExists = async (user) => {
  try {
    const { data: existingUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (existingUser) return existingUser;
    
    // Se o erro não for "não encontrado", houve um erro de conexão/banco
    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Erro ao buscar usuário no banco:', fetchError);
      return null;
    }

    // 🔥 Cria usuário automaticamente se não existir
    const trialDays = 3;
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    const { data, error } = await supabase
      .from('users')
      .insert({
        id: user.id,
        email: user.email,
        subscription_status: 'trial',
        trial_end: trialEnd.toISOString(),
        credits: 3 // Dá 3 créditos iniciais
      })
      .select()
      .single();

    if (error) {
      console.error('Erro ao criar usuário na tabela users:', error);
      return null;
    }

    return data;
  } catch (err) {
    console.error('Exceção em ensureUserExists:', err);
    return null;
  }
};

/**
 * Middleware principal de Autenticação
 */
export const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;

    if (!token) {
      return res.status(401).json({
        error: 'Token não fornecido'
      });
    }

    // 🔐 Valida token diretamente com o Supabase Auth
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      console.warn('Token inválido ou expirado apresentado.');
      return res.status(403).json({
        error: 'Sessão inválida ou expirada. Faça login novamente.'
      });
    }

    const supabaseUser = data.user;

    // 🔥 Garante que o usuário tenha uma linha na nossa tabela 'users'
    const userRecord = await ensureUserExists(supabaseUser);

    if (!userRecord) {
      return res.status(500).json({
        error: 'Erro ao sincronizar seu perfil de usuário.'
      });
    }

    // Passamos os dados para as próximas rotas/middlewares
    req.user = {
      id: supabaseUser.id,
      email: supabaseUser.email,
      role: supabaseUser.role || 'user',
      plan: userRecord.plan,
      subscription_status: userRecord.subscription_status,
      trial_end: userRecord.trial_end
    };

    next();

  } catch (err) {
    console.error('Erro CRÍTICO no middleware authenticateToken:', err);
    return res.status(500).json({
      error: 'Erro interno de autenticação no servidor.'
    });
  }
};

/**
 * Middleware para rotas onde o login é opcional
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    if (!token) return next();

    const { data, error } = await supabase.auth.getUser(token);

    if (!error && data?.user) {
      req.user = {
        id: data.user.id,
        email: data.user.email
      };
    }
    next();
  } catch (err) {
    next();
  }
};
