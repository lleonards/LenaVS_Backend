import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    // =============================
    // RESET AUTOMÁTICO A CADA 30 DIAS (FREE)
    // =============================

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

export default router;
