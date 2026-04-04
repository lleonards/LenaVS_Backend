import express from 'express';
import {
  uploadMedia,
  generateVideo,
  downloadVideo
} from '../controllers/videoController.js';

import { authenticateToken } from '../middleware/auth.js';
import { uploadFiles, handleUploadError } from '../middleware/upload.js';

const router = express.Router();

/* =====================================================
   📤 Upload de mídia
   Preview é livre para edição; não consome crédito.
===================================================== */

router.post(
  '/upload',
  authenticateToken,
  uploadFiles,
  handleUploadError,
  uploadMedia
);

/* =====================================================
   🎬 Gerar vídeo
   Gera conforme o preview/export panel, sem consumir crédito.
   O crédito é debitado apenas no download.
===================================================== */

router.post(
  '/generate',
  authenticateToken,
  generateVideo
);

/* =====================================================
   ⬇ Download de vídeo
   1 download = 1 crédito (somente usuário autenticado).
===================================================== */

router.get(
  '/download/:fileName',
  authenticateToken,
  downloadVideo
);

export default router;
