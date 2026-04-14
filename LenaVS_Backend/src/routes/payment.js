import express from 'express';
import {
  createPaymentSession,
  getSubscriptionStatus,
  handleMercadoPagoWebhook,
} from '../controllers/paymentController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/create-session', authenticateToken, createPaymentSession);
router.get('/subscription', authenticateToken, getSubscriptionStatus);
router.post('/webhook/mercadopago', handleMercadoPagoWebhook);
router.get('/webhook/mercadopago', handleMercadoPagoWebhook);

export default router;
