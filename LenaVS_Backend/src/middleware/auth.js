import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Verifica se o usuário ainda tem acesso ao sistema
 * Regras:
 * - Assinatura ativa → acesso liberado
 * - Trial válido → acesso liberado
 * - Trial expirado → bloqueado
 */
const checkUserAccess = async (userId) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('trial_end, subscription_status')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Erro ao buscar usuário:', error.message);
      return false;
    }

    if (!data) {
      console.error('Usuário não encontrado na tabela users');
      return false;
    }

    const now = new Date();
    const trialEnd = data.trial_end ? new Date(data.trial_end) : null;

    const isActiveSubscriber = data.subscription_status === 'active';

    // Se assinatura ativa → libera direto
    if (isActiveSubscriber) {
      return true;
    }

    // Se está em trial e ainda não expirou → libera
    if (data.subscription_status === 'trial' && trialEnd && now <= trialEnd) {
      return true;
    }

    // Qualquer outro caso → bloqueia
    return false;

  } catch (err) {
    console.error('Erro inesperado em checkUserAccess:', err);
    return false;
  }
};


/**
 * Middleware principal de autenticação + verificação de acesso
 */
export const authenticateToken = async (req, res, next) => {
  try {

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;

    if (!token) {
      return res.status(401).json({
        error: 'Token de autenticação não fornecido'
      });
    }

    // Valida token no Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(403).json({
        error: 'Token inválido ou expirado'
      });
    }

    const userId = data.user.id;

    // Verifica se pode acessar o sistema
    const hasAccess = await checkUserAccess(userId);

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Seu período de teste expirou. Assine para continuar usando o LenaVS.',
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
 * Middleware opcional
 * Não bloqueia trial expirado
 * Usado para páginas públicas
 */
export const optionalAuth = async (req, res, next) => {
  try {

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;

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

  } catch (err) {
    console.error('Erro em optionalAuth:', err);
    next();
  }
};
