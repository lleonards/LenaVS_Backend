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
  🔐 PROTEÇÃO OFICIAL DA LenaVS

  Ordem de execução:
  1️⃣ authenticateToken → valida JWT do Supabase
  2️⃣ requireActiveAccess → valida:
       - Se plano = pro → permite
       - Se plano = free → verifica créditos
       - Se credits > 0 → permite
       - Se credits = 0 → bloqueia
  3️⃣ Controller executa geração
*/

/* =====================================================
   📤 Upload de mídia
===================================================== */

router.post(
  '/upload',
  authenticateToken,
  requireActiveAccess,
  uploadFiles,
  handleUploadError,
  uploadMedia
);

/* =====================================================
   🎬 Gerar vídeo (ROTA CRÍTICA)
===================================================== */

router.post(
  '/generate',
  authenticateToken,
  requireActiveAccess,
  generateVideo
);

/* =====================================================
   ⬇ Download de vídeo
   (Pode proteger depois se quiser)
===================================================== */

router.get(
  '/download/:fileName',
  downloadVideo
);

export default router;