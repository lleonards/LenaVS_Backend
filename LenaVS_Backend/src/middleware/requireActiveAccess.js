import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const requireActiveAccess = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('trial_end, subscription_status')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Usuário não encontrado' });
    }

    const now = new Date();
    const trialEnd = user.trial_end ? new Date(user.trial_end) : null;

    const trialActive = trialEnd && trialEnd > now;
    const subscriptionActive = user.subscription_status === 'active';

    if (!trialActive && !subscriptionActive) {
      return res.status(403).json({
        error: 'Acesso expirado. Assine para continuar.'
      });
    }

    next();

  } catch (err) {
    console.error('Erro verificação acesso:', err);
    return res.status(500).json({
      error: 'Erro interno ao verificar acesso'
    });
  }
};
