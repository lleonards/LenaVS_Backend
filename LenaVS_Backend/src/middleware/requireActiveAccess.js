import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const requireActiveAccess = async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({
        error: 'Usuário não autenticado'
      });
    }

    const userId = req.user.id;

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(403).json({
        error: 'Usuário não encontrado'
      });
    }

    /* =====================================================
       💎 PLANO PRO → ACESSO TOTAL
    ===================================================== */

    const isPro =
      user.plan === 'pro' &&
      user.subscription_status === 'active';

    if (isPro) {
      return next();
    }

    /* =====================================================
       🎁 PLANO FREE → VERIFICAR CRÉDITOS
    ===================================================== */

    if (user.plan === 'free') {

      if (!user.credits || user.credits <= 0) {
        return res.status(403).json({
          error: 'Créditos esgotados',
          code: 'NO_CREDITS',
          action: 'UPGRADE_REQUIRED'
        });
      }

      return next();
    }

    /* =====================================================
       ❌ CASO INVÁLIDO
    ===================================================== */

    return res.status(403).json({
      error: 'Plano inválido ou acesso não permitido'
    });

  } catch (err) {
    console.error('Erro no requireActiveAccess:', err);

    return res.status(500).json({
      error: 'Erro interno ao verificar acesso'
    });
  }
};
