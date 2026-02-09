import express from 'express';
import { uploadMedia, generateVideo, downloadVideo } from '../controllers/videoController.js';
import { authenticateToken } from '../middleware/auth.js';
import { uploadFiles, handleUploadError } from '../middleware/upload.js';

const router = express.Router();

// Upload de arquivos de mídia
router.post('/upload', authenticateToken, uploadFiles, handleUploadError, uploadMedia);

// Gerar vídeo final
router.post('/generate', authenticateToken, generateVideo);

// Download do vídeo gerado
router.get('/download/:fileName', downloadVideo);

export default router;
