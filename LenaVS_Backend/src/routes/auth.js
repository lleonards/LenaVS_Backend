import express from 'express';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

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
