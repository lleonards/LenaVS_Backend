import express from 'express';
import {
  createPaymentSession,
  getSubscriptionStatus
} from '../controllers/paymentController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// ✅ Criar sessão de pagamento (usuário precisa estar logado)
router.post('/create-session', authenticateToken, createPaymentSession);

// ❌ NÃO colocar webhook aqui
// O webhook já está registrado diretamente no server.js
// com express.raw()

// ✅ Obter status da assinatura
router.get('/subscription', authenticateToken, getSubscriptionStatus);

export default router;