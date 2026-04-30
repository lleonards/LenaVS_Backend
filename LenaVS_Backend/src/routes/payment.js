import express from 'express';
import {
  createPaymentSession,
  getSubscriptionStatus,
} from '../controllers/paymentController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/create-session', authenticateToken, createPaymentSession);
router.get('/subscription', authenticateToken, getSubscriptionStatus);

export default router;
