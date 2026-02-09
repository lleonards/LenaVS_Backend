import express from 'express';
import { processManualLyrics, processLyricsFileUpload } from '../controllers/lyricsController.js';
import { authenticateToken } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';

const router = express.Router();

// Processar letra colada manualmente
router.post('/manual', authenticateToken, processManualLyrics);

// Processar arquivo de letra
router.post('/upload', authenticateToken, upload.single('letra'), processLyricsFileUpload);

export default router;
