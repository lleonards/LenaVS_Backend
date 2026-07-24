import express from 'express';
import {
  createPaymentSession,
  getSubscriptionStatus,
} from '../controllers/paymentController.js';
import { createBillingPortalSession } from '../controllers/billingPortalController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/create-session', authenticateToken, createPaymentSession);
router.post('/billing-portal', authenticateToken, createBillingPortalSession);
router.get('/subscription', authenticateToken, getSubscriptionStatus);

export default router;
