import express from 'express';
import {
  processManualLyrics,
  processLyricsFileUpload,
  syncLyricsWithAudio,
} from '../controllers/lyricsController.js';

import { authenticateToken } from '../middleware/auth.js';
import { requireActiveAccess } from '../middleware/requireActiveAccess.js';
import { upload } from '../middleware/upload.js';

const router = express.Router();

/*
  🔐 PROTEÇÃO:
  1. Usuário autenticado
  2. Trial ativo OU assinatura ativa
*/

// Processar letra colada manualmente
router.post(
  '/manual',
  authenticateToken,
  requireActiveAccess,
  processManualLyrics
);

// Processar arquivo de letra
router.post(
  '/upload',
  authenticateToken,
  requireActiveAccess,
  upload.single('letra'),
  processLyricsFileUpload
);

// Sincronizar estrofes com áudio automaticamente (Whisper + fallback proporcional)
router.post(
  '/sync',
  authenticateToken,
  requireActiveAccess,
  syncLyricsWithAudio
);

export default router;
