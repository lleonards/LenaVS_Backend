import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Garante que o usuário exista na tabela users
 * Se não existir → cria com trial de 3 dias
 */
const ensureUserExists = async (user) => {
  const { data: existingUser } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();

  if (existingUser) return existingUser;

  // 🔥 Cria usuário automaticamente
  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + 3);

  const { data, error } = await supabase
    .from('users')
    .insert({
      id: user.id,
      email: user.email,
      subscription_status: 'trial',
      trial_end: trialEnd.toISOString(),
      credits: 3
    })
    .select()
    .single();

  if (error) {
    console.error('Erro ao criar usuário:', error);
    return null;
  }

  return data;
};

/**
 * Verifica acesso
 */
const checkUserAccess = async (userRecord) => {
  const now = new Date();
  const trialEnd = userRecord.trial_end
    ? new Date(userRecord.trial_end)
    : null;

  const isActiveSubscriber =
    userRecord.subscription_status === 'active';

  if (isActiveSubscriber) return true;

  if (
    userRecord.subscription_status === 'trial' &&
    trialEnd &&
    now <= trialEnd
  ) {
    return true;
  }

  return false;
};

/**
 * Middleware principal
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

    // 🔐 Valida token Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(403).json({
        error: 'Token inválido ou expirado'
      });
    }

    const supabaseUser = data.user;

    // 🔥 Garante que exista na tabela users
    const userRecord = await ensureUserExists(supabaseUser);

    if (!userRecord) {
      return res.status(500).json({
        error: 'Erro ao preparar usuário'
      });
    }

    const hasAccess = await checkUserAccess(userRecord);

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Seu período de teste expirou.',
        code: 'TRIAL_EXPIRED'
      });
    }

    req.user = {
      id: supabaseUser.id,
      email: supabaseUser.email,
      role: supabaseUser.role || 'user'
    };

    next();

  } catch (err) {
    console.error('Erro na autenticação:', err);

    return res.status(500).json({
      error: 'Erro interno de autenticação'
    });
  }
};

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
