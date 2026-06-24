import { separateIntoStanzas, processLyricsFile } from '../utils/lyricsProcessor.js';
import { removeLocalFileSilently } from '../services/storageService.js';
import { syncStanzasWithWhisperAnchors } from '../utils/voiceSync.js';
import https from 'https';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

/**
 * Tenta obter a duração real do áudio via ffprobe.
 * Retorna null se ffprobe não estiver disponível ou falhar.
 */
async function probeAudioDuration(audioUrl) {
  let tmpPath = null;
  try {
    tmpPath = await downloadToTemp(audioUrl);
    return await new Promise((resolve) => {
      execFile(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration',
         '-of', 'default=noprint_wrappers=1:nokey=1', tmpPath],
        (err, stdout) => {
          if (err) { resolve(null); return; }
          const d = parseFloat(stdout.trim());
          resolve(Number.isFinite(d) && d > 0 ? d : null);
        }
      );
    });
  } catch {
    return null;
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
}

/** Download de URL pública para arquivo temporário */
function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext = url.match(/\.(mp3|wav|ogg|flac|m4a|aac|webm)(\?|$)/i)?.[1] || 'mp3';
    const tmpPath = path.join(os.tmpdir(), `lena_probe_${Date.now()}.${ext}`);
    const file = fs.createWriteStream(tmpPath);
    const client = url.startsWith('https://') ? https : http;

    client.get(url, (res) => {
      if (res.statusCode >= 400) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode} ao baixar áudio`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      reject(err);
    });
  });
}

/**
 * Distribui estrofes proporcionalmente pela duração do áudio (sem API de IA).
 * Usa contagem de palavras como peso para cada estrofe.
 * Reserva 5% no início e 5% no fim para silêncio típico de intro/outro.
 */
function distributeStanzasProportionally(stanzas, totalDuration) {
  if (!stanzas.length || !totalDuration) {
    return stanzas.map((s) => ({ ...s, startTime: 0, endTime: 0 }));
  }

  const INTRO_RATIO = 0.05;
  const OUTRO_RATIO = 0.05;
  const usableDuration = totalDuration * (1 - INTRO_RATIO - OUTRO_RATIO);
  const offset = totalDuration * INTRO_RATIO;

  const wordCounts = stanzas.map((s) =>
    Math.max(1, String(s.text || '').split(/\s+/).filter(Boolean).length)
  );
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);
  let cursor = offset;

  return stanzas.map((s, i) => {
    const fraction = wordCounts[i] / totalWords;
    const dur = fraction * usableDuration;
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

  // Determina a duração: usa o valor enviado pelo cliente ou tenta via ffprobe
  let resolvedDuration = Number(audioDuration) > 0 ? Number(audioDuration) : null;

  if (!resolvedDuration) {
    resolvedDuration = await probeAudioDuration(audioUrl).catch(() => null);
    console.log(`[syncLyricsWithAudio] Duração via ffprobe: ${resolvedDuration}s`);
  }

  // Fallback final para duração: 180s (3 minutos típicos)
  const totalDuration = resolvedDuration || 180;

  // Tentativa 1: sincronização precisa via Whisper (requer OPENAI_API_KEY ou WhisperX)
  try {
    const synced = await syncStanzasWithWhisperAnchors(audioUrl, sanitizedStanzas);

    // Valida que o Whisper retornou timestamps reais (não array vazio nem todos null)
    const validCount = Array.isArray(synced)
      ? synced.filter(s => typeof s?.startTime === 'number' && Number.isFinite(s.startTime)).length
      : 0;

    if (validCount === 0) {
      throw new Error('Whisper não detectou fala no áudio — vocais muito baixos ou não reconhecidos');
    }

    // Monta resultado final; estrofes sem match no Whisper recebem null
    // (o frontend manterá o valor anterior para essas)
    const result = sanitizedStanzas.map((s, i) => {
      const ws = synced[i];
      const hasValidStart = typeof ws?.startTime === 'number' && Number.isFinite(ws.startTime);
      const hasValidEnd = typeof ws?.endTime === 'number' && Number.isFinite(ws.endTime);
      return {
        id: s.id,
        text: s.text,
        startTime: hasValidStart ? ws.startTime : null,
        endTime: hasValidEnd ? ws.endTime : null,
      };
    });

    return res.status(200).json({ success: true, stanzas: result, method: 'whisper' });
  } catch (whisperError) {
    console.warn(
      '[syncLyricsWithAudio] Whisper indisponível ou sem resultado, usando fallback proporcional:',
      whisperError.message
    );
  }

  // Fallback: distribuição proporcional por contagem de palavras
  const result = distributeStanzasProportionally(sanitizedStanzas, totalDuration);

  return res.status(200).json({
    success: true,
    stanzas: result,
    method: 'proportional',
    totalDuration,
  });
};
