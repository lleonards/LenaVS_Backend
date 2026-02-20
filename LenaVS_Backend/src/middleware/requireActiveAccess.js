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

    const userId = req.user.id;

    // 🔎 Buscar dados do usuário
    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, credits_reset_at, subscription_status')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Usuário não encontrado' });
    }

    const now = new Date();
    const lastReset = new Date(user.credits_reset_at);
    const diffInDays =
      (now - lastReset) / (1000 * 60 * 60 * 24);

    /* =====================================================
       🟢 PLANO PRO
    ===================================================== */

    const isPro =
      user.plan === 'pro' &&
      user.subscription_status === 'active';

    if (isPro) {
      return next();
    }

    /* =====================================================
       🔵 PLANO FREE
    ===================================================== */

    if (user.plan === 'free') {

      // 🔄 Reset automático a cada 15 dias
      if (diffInDays >= 15) {

        const { error: updateError } = await supabase
          .from('users')
          .update({
            credits: 3,
            credits_reset_at: now.toISOString()
          })
          .eq('id', userId);

        if (updateError) {
          console.error('Erro ao resetar créditos:', updateError);
          return res.status(500).json({
            error: 'Erro ao atualizar créditos'
          });
        }

        // Atualiza variável local
        user.credits = 3;
      }

      // 🚫 Sem créditos
      if (!user.credits || user.credits <= 0) {
        return res.status(403).json({
          error: 'Créditos esgotados. Faça upgrade para continuar.'
        });
      }

      // 🔓 Tem créditos
      return next();
    }

    /* =====================================================
       ❌ CASO INVÁLIDO
    ===================================================== */

    return res.status(403).json({
      error: 'Plano inválido ou acesso não permitido.'
    });

  } catch (err) {
    console.error('Erro verificação acesso:', err);

    return res.status(500).json({
      error: 'Erro interno ao verificar acesso'
    });
  }
};
