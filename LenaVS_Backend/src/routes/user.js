import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * GET /me
 * Retorna dados do usuário + créditos
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('users')
      .select(`
        id,
        email,
        plan,
        credits,
        credits_reset_at,
        subscription_status
      `)
      .eq('id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const now = new Date();
    const resetDate = new Date(data.credits_reset_at);

    // Reset automático a cada 30 dias (apenas FREE)
    if (data.plan === 'free') {
      const diffDays =
        (now - resetDate) / (1000 * 60 * 60 * 24);

      if (diffDays >= 30) {
        await supabase
          .from('users')
          .update({
            credits: 3,
            credits_reset_at: now.toISOString()
          })
          .eq('id', userId);

        data.credits = 3;
      }
    }

    const creditsRemaining =
      data.plan === 'pro' ? 'unlimited' : data.credits;

    return res.json({
      id: data.id,
      email: data.email,
      plan: data.plan,
      subscription_status: data.subscription_status,
      credits_remaining: creditsRemaining
    });

  } catch (err) {
    console.error('Erro na rota /me:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});


/**
 * POST /consume-credit
 * Consome 1 crédito se for FREE
 */
router.post('/consume-credit', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Plano PRO → acesso liberado sempre
    if (user.plan === 'pro') {
      return res.json({
        success: true,
        message: 'Plano pro - acesso ilimitado'
      });
    }

    // FREE sem créditos
    if (user.credits <= 0) {
      return res.status(403).json({
        error: 'Sem créditos disponíveis'
      });
    }

    // Consome 1 crédito
    const { error: updateError } = await supabase
      .from('users')
      .update({ credits: user.credits - 1 })
      .eq('id', userId);

    if (updateError) {
      return res.status(500).json({ error: 'Erro ao consumir crédito' });
    }

    return res.json({
      success: true,
      remaining_credits: user.credits - 1
    });

  } catch (err) {
    console.error('Erro ao consumir crédito:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

export default router;