import { supabase } from '../config/supabase.js';
import { hasUnlimitedAccess } from '../utils/access.js';
import { GENERIC_ERROR_MESSAGE, logInternalError } from '../utils/publicError.js';

export const requireActiveAccess = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Entre na sua conta para continuar.'
      });
    }

    const userId = req.user.id;

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status, unlimited_access_until')
      .eq('id', userId)
      .single();

    if (error || !user) {
      console.error('Erro ao buscar usuário no banco:', error);
      // CORRIGIDO: falha de consulta/infraestrutura não é "acesso negado".
      // Antes devolvia 403 e o front interpretava como sessão inválida,
      // deslogando o usuário no meio de fluxos longos (upload/export).
      return res.status(503).json({
        error: GENERIC_ERROR_MESSAGE,
        code: 'SERVICE_UNAVAILABLE'
      });
    }

    if (hasUnlimitedAccess(user)) {
      return next();
    }

    if ((user.plan === 'free' || !user.plan) && (Number(user.credits) || 0) > 0) {
      return next();
    }

    return res.status(403).json({
      error: 'Seus créditos acabaram. Escolha o plano ilimitado para continuar.',
      code: 'NO_CREDITS',
      action: 'UPGRADE_REQUIRED'
    });
  } catch (err) {
    logInternalError('requireActiveAccess', err);
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: GENERIC_ERROR_MESSAGE
    });
  }
};
