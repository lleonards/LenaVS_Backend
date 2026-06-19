import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { handleUploadError, upload } from '../middleware/upload.js';
import {
  consumeCredit,
  getCurrentUser,
  submitCancellationFeedback,
  updateCurrentUserProfile,
} from '../controllers/userController.js';

const router = express.Router();

router.get('/me', authenticateToken, getCurrentUser);
router.put('/profile', authenticateToken, upload.single('avatar'), handleUploadError, updateCurrentUserProfile);
router.post('/cancellation-feedback', authenticateToken, submitCancellationFeedback);
router.post('/consume-credit', authenticateToken, consumeCredit);

export default router;
