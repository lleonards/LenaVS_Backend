import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { supabase } from '../config/supabase.js';

const router = express.Router();

/**
 * POST /api/auth/check-email
 * Verifica se o e-mail existe para permitir uma mensagem de login mais útil.
 * A resposta expõe apenas um booleano, sem dados do usuário.
 */
router.post('/check-email', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      code: 'INVALID_EMAIL',
      error: 'Digite um e-mail válido.',
    });
  }

  try {
    const { data, error } = await supabase.auth.admin.getUserByEmail(email);

    if (error && !/not found|user not found/i.test(String(error.message || ''))) {
      console.error('Erro ao verificar e-mail de login:', error);
      return res.status(500).json({
        code: 'EMAIL_CHECK_ERROR',
        error: 'Não foi possível verificar o e-mail agora.',
      });
    }

    return res.json({
      success: true,
      exists: Boolean(data?.user),
    });
  } catch (error) {
    console.error('Erro inesperado ao verificar e-mail de login:', error);
    return res.status(500).json({
      code: 'EMAIL_CHECK_ERROR',
      error: 'Não foi possível verificar o e-mail agora.',
    });
  }
});

/**
 * GET /api/auth/me
 * Retorna apenas dados básicos do usuário autenticado
 * (dados completos devem vir de /api/user/me)
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    return res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email
      }
    });

  } catch (err) {
    console.error('Erro na rota /api/auth/me:', err);
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Erro interno'
    });
  }
});

export default router;
