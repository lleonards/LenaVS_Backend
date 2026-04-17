import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { authenticateToken } from '../middleware/auth.js';
import { buildAccessSnapshot, hasUnlimitedAccess } from '../utils/access.js';

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
        subscription_status,
        unlimited_access_until
      `)
      .eq('id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const now = new Date();
    const resetDate = new Date(data.credits_reset_at);

    if (!hasUnlimitedAccess(data) && (data.plan === 'free' || !data.plan)) {
      const diffDays = (now - resetDate) / (1000 * 60 * 60 * 24);

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

    const snapshot = buildAccessSnapshot(data);

    return res.json({
      id: data.id,
      email: data.email,
      plan: snapshot.plan,
      credits: data.credits,
      credits_remaining: snapshot.credits_remaining,
      subscription_status: snapshot.subscription_status,
      unlimited_access_until: snapshot.unlimited_access_until,
      unlimited: snapshot.unlimited,
    });
  } catch (err) {
    console.error('Erro na rota /me:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/consume-credit', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status, unlimited_access_until')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (hasUnlimitedAccess(user)) {
      return res.json({
        success: true,
        message: 'Plano unlimited - acesso liberado',
        unlimited: true,
      });
    }

    if (user.credits <= 0) {
      return res.status(403).json({
        error: 'Sem créditos disponíveis',
        code: 'NO_CREDITS',
      });
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({ credits: user.credits - 1 })
      .eq('id', userId);

    if (updateError) {
      return res.status(500).json({ error: 'Erro ao consumir crédito' });
    }

    return res.json({
      success: true,
      remaining_credits: user.credits - 1,
      unlimited: false,
    });
  } catch (err) {
    console.error('Erro ao consumir crédito:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

export default router;
