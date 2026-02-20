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

    // 🔎 Buscar dados necessários do usuário
    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Usuário não encontrado' });
    }

    const isPro =
      user.plan === 'pro' &&
      user.subscription_status === 'active';

    // 🟢 Se for PRO, acesso liberado
    if (isPro) {
      return next();
    }

    // 🔓 Se for FREE, verificar créditos
    if (user.plan === 'free') {

      if (!user.credits || user.credits <= 0) {
        return res.status(403).json({
          error: 'Créditos esgotados. Assine o plano Pro para continuar.'
        });
      }

      // 🔥 Importante:
      // Não decrementamos aqui ainda.
      // Vamos decrementar APÓS gerar vídeo com sucesso.
      return next();
    }

    // Caso inesperado
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
