import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * GET /api/auth/me
 * Retorna dados do usuário autenticado
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('users')
      .select('id, email, trial_end, subscription_status, created_at')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        error: 'Usuário não encontrado'
      });
    }

    res.json({
      success: true,
      user: data
    });

  } catch (err) {
    console.error('Erro na rota /me:', err);
    res.status(500).json({
      error: 'Erro interno ao buscar usuário'
    });
  }
});

export default router;
