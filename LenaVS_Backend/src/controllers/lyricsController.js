import { separateIntoStanzas, processLyricsFile } from '../utils/lyricsProcessor.js';
import { removeLocalFileSilently } from '../services/storageService.js';
import { syncStanzasWithWhisperAnchors } from '../utils/voiceSync.js';

/**
 * Distribui estrofes proporcionalmente pela duração do áudio (sem API de IA).
 * Usa contagem de palavras como peso para cada estrofe.
 */
function distributeStanzasProportionally(stanzas, totalDuration) {
  if (!stanzas.length || !totalDuration) {
    return stanzas.map((s) => ({ ...s, startTime: 0, endTime: 0 }));
  }
  const wordCounts = stanzas.map((s) =>
    Math.max(1, String(s.text || '').split(/\s+/).filter(Boolean).length)
  );
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return stanzas.map((s, i) => {
    const fraction = wordCounts[i] / totalWords;
    const dur = fraction * totalDuration;
    const start = cursor;
    const end = cursor + dur;
    cursor = end;
    return { id: s.id, text: s.text, startTime: start, endTime: end };
  });
}

export const processManualLyrics = async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Texto da letra não fornecido' });
    }

    const result = separateIntoStanzas(text);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Erro ao processar letra:', error);
    return res.status(500).json({ error: 'Erro ao processar letra' });
  }
};

export const processLyricsFileUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo de letra não fornecido' });
    }

    const result = await processLyricsFile(req.file.path);

    return res.status(200).json({
      success: true,
      fileName: req.file.originalname,
      ...result,
    });
  } catch (error) {
    console.error('Erro ao processar arquivo de letra:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    await removeLocalFileSilently(req.file?.path);
  }
};

/**
 * POST /lyrics/sync
 * Sincroniza automaticamente as estrofes com o áudio usando Whisper (com fallback proporcional).
 *
 * Body: { audioUrl: string, stanzas: [{id, text}], audioDuration?: number }
 * Response: { success: true, stanzas: [{id, text, startTime, endTime}], method: string }
 */
export const syncLyricsWithAudio = async (req, res) => {
  const { audioUrl, stanzas, audioDuration } = req.body;

  if (!audioUrl || typeof audioUrl !== 'string' || !audioUrl.startsWith('http')) {
    return res.status(400).json({ error: 'audioUrl inválido ou ausente' });
  }

  if (!Array.isArray(stanzas) || stanzas.length === 0) {
    return res.status(400).json({ error: 'stanzas deve ser um array não-vazio' });
  }

  const sanitizedStanzas = stanzas.map((s) => ({
    id: s.id,
    text: String(s.text || '').trim(),
  })).filter((s) => s.text.length > 0);

  if (sanitizedStanzas.length === 0) {
    return res.status(400).json({ error: 'Nenhuma estrofe com texto válido' });
  }

  // Tentativa 1: sincronização precisa via Whisper (requer OPENAI_API_KEY ou WhisperX)
  try {
    const synced = await syncStanzasWithWhisperAnchors(audioUrl, sanitizedStanzas);

    const result = sanitizedStanzas.map((s, i) => ({
      id: s.id,
      text: s.text,
      startTime: synced[i]?.startTime ?? null,
      endTime: synced[i]?.endTime ?? null,
    }));

    return res.status(200).json({ success: true, stanzas: result, method: 'whisper' });
  } catch (whisperError) {
    console.warn(
      '[syncLyricsWithAudio] Whisper indisponível, usando fallback proporcional:',
      whisperError.message
    );
  }

  // Fallback: distribuição proporcional por contagem de palavras
  const totalDuration = Number(audioDuration) > 0 ? Number(audioDuration) : 180;
  const result = distributeStanzasProportionally(sanitizedStanzas, totalDuration);

  return res.status(200).json({ success: true, stanzas: result, method: 'proportional' });
};
