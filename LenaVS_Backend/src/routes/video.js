import express from 'express';
import {
  uploadMedia,
  generateVideo,
  downloadVideo
} from '../controllers/videoController.js';

import { authenticateToken } from '../middleware/auth.js';
import { requireActiveAccess } from '../middleware/requireActiveAccess.js';
import { uploadFiles, handleUploadError } from '../middleware/upload.js';

const router = express.Router();

/*
  🔐 PROTEÇÃO:
  1. Usuário precisa estar autenticado
  2. Trial ativo OU assinatura ativa
*/

// Upload de arquivos de mídia
router.post(
  '/upload',
  authenticateToken,
  requireActiveAccess,
  uploadFiles,
  handleUploadError,
  uploadMedia
);

// Gerar vídeo final (🔥 mais importante)
router.post(
  '/generate',
  authenticateToken,
  requireActiveAccess,
  generateVideo
);

// Download do vídeo gerado
// (Pode deixar público ou proteger se quiser)
router.get(
  '/download/:fileName',
  downloadVideo
);

export default router;
