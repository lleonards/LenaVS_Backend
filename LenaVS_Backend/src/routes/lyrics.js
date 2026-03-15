import express from 'express';
import {
  processManualLyrics,
  processLyricsFileUpload,
  voiceSync
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

// Sincronização automática baseada na voz do áudio original
// Recebe: { audioUrl: string, stanzaCount: number }
// Retorna: { segments: [{ start, end }] }
router.post(
  '/voice-sync',
  authenticateToken,
  requireActiveAccess,
  voiceSync
);

export default router;
