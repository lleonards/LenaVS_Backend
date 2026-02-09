import express from 'express';
import {
  createPaymentSession,
  handlePaymentWebhook,
  getSubscriptionStatus
} from '../controllers/paymentController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Criar sessão de pagamento
router.post('/create-session', authenticateToken, createPaymentSession);

// Webhook de pagamentos (não requer autenticação - validado pela assinatura)
router.post('/webhook', express.raw({ type: 'application/json' }), handlePaymentWebhook);

// Obter status da assinatura
router.get('/subscription', authenticateToken, getSubscriptionStatus);

export default router;
