import express from 'express';
import {
  processManualLyrics,
  processLyricsFileUpload,
  voiceSync,
  voiceSyncAnchors,
  voiceSyncAuto
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
// Recebe: { audioUrl: string, stanzaCount?: number, stanzas?: [{id,text}] }
// Retorna: { segments: [{ start, end, lines:[...] }] }
router.post(
  '/voice-sync',
  authenticateToken,
  requireActiveAccess,
  voiceSync
);

// Sincronização automática de ESTROFES via âncoras (3 primeiras + 3 últimas palavras)
// Recebe: { audioUrl: string, stanzas: [{id?,text}], respectOrder?: boolean }
// Retorna: { stanzas: [{ text, startTime, endTime }] }
router.post(
  '/voice-sync-anchors',
  authenticateToken,
  requireActiveAccess,
  voiceSyncAnchors
);

// Auto-seleciona entre áudios enviados (ex: original vs instrumental) baseado na letra
// Recebe: { audioCandidates: [url1,url2], stanzas: [{id?,text}] }
// Retorna: { segments, chosenAudioUrl, ranking }
router.post(
  '/voice-sync-auto',
  authenticateToken,
  requireActiveAccess,
  voiceSyncAuto
);

export default router;
