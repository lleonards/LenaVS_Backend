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
 * Retorna dados do usuário autenticado
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('users')
      .select('id, email, subscription_status, trial_end')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        error: 'Usuário não encontrado'
      });
    }

    const now = new Date();
    const trialEnd = data.trial_end ? new Date(data.trial_end) : null;

    let trialDaysRemaining = 0;
    let hasAccess = false;

    if (data.subscription_status === 'active') {
      hasAccess = true;
    } else if (
      data.subscription_status === 'trial' &&
      trialEnd &&
      now <= trialEnd
    ) {
      hasAccess = true;

      const diffTime = trialEnd - now;
      trialDaysRemaining = Math.ceil(
        diffTime / (1000 * 60 * 60 * 24)
      );
    }

    return res.json({
      id: data.id,
      email: data.email,
      subscription_status: data.subscription_status,
      trial_end: data.trial_end,
      trial_days_remaining: trialDaysRemaining,
      has_access: hasAccess
    });

  } catch (err) {
    console.error('Erro na rota /me:', err);
    return res.status(500).json({
      error: 'Erro interno'
    });
  }
});

export default router;
