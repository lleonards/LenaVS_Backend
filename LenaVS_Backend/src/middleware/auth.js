import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Verifica se o usuário tem acesso (trial ou assinatura ativa)
 */
const checkUserAccess = async (userId) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('trial_end, subscription_status')
      .eq('id', userId)
      .single();

    if (error || !data) {
      console.error('Erro ao verificar assinatura:', error);
      return false;
    }

    const now = new Date();
    const trialEnd = data.trial_end ? new Date(data.trial_end) : null;

    const trialExpired = trialEnd && now > trialEnd;
    const isActiveSubscriber = data.subscription_status === 'active';

    // Permite se:
    // - trial ainda válido
    // OU
    // - assinatura ativa
    if (!trialExpired || isActiveSubscriber) {
      return true;
    }

    return false;

  } catch (err) {
    console.error('Erro em checkUserAccess:', err);
    return false;
  }
};


/**
 * Middleware de autenticação + verificação de trial/assinatura
 */
export const authenticateToken = async (req, res, next) => {
  try {

    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Token de autenticação não fornecido'
      });
    }

    // Valida token Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(403).json({
        error: 'Token inválido'
      });
    }

    const userId = data.user.id;

    // Verifica trial / assinatura
    const hasAccess = await checkUserAccess(userId);

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Trial expirado. Assine para continuar usando o LenaVS.',
        code: 'TRIAL_EXPIRED'
      });
    }

    // Usuário autenticado e autorizado
    req.user = {
      id: userId,
      email: data.user.email,
      role: data.user.role || 'user'
    };

    next();

  } catch (err) {

    console.error('Erro na autenticação:', err);

    return res.status(500).json({
      error: 'Erro interno de autenticação'
    });

  }
};


/**
 * Middleware opcional (não bloqueia trial expirado)
 * Usado para páginas públicas
 */
export const optionalAuth = async (req, res, next) => {

  try {

    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) return next();

    const { data, error } = await supabase.auth.getUser(token);

    if (!error && data?.user) {

      req.user = {
        id: data.user.id,
        email: data.user.email,
        role: data.user.role || 'user'
      };

    }

    next();

  } catch {

    next();

  }

};
