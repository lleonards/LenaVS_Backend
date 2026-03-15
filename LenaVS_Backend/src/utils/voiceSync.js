/**
 * voiceSync.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detecta segmentos de VOZ no áudio original usando ffmpeg silence-detection.
 *
 * Estratégia:
 *   1. Baixa o arquivo de áudio da URL pública (ou usa path local).
 *   2. Executa ffmpeg com o filtro `silencedetect` para obter
 *      os timestamps de início/fim de cada silêncio.
 *   3. Inverte os silêncios → obtém segmentos de fala.
 *   4. Agrupa os segmentos de fala em `stanzaCount` blocos
 *      (um bloco por estrofe), distribuindo proporcionalmente.
 *
 * Dependências: fluent-ffmpeg (já no package.json), node-fetch ou https nativo
 * ─────────────────────────────────────────────────────────────────────────────
 */

import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { pipeline } from 'stream/promises';

// ─── Configurações do detector de silêncio ────────────────────────────────────
// noise  : threshold de ruído (dBFS) — aumentar para ambientes ruidosos
// duration: duração mínima de silêncio para ser considerado separador (seg)
const SILENCE_NOISE_DB  = -35;
const SILENCE_DURATION  = 0.4;   // segundos de silêncio para separar segmentos

// ─── Baixa o áudio para um arquivo temporário ─────────────────────────────────
async function downloadToTemp(url) {
  const ext  = path.extname(new URL(url).pathname) || '.mp3';
  const dest = path.join(os.tmpdir(), `lena_vsync_${Date.now()}${ext}`);

  const protocol = url.startsWith('https') ? https : http;

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    protocol.get(url, (resp) => {
      if (resp.statusCode >= 400) {
        reject(new Error(`HTTP ${resp.statusCode} ao baixar áudio`));
        return;
      }
      resp.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });

  return dest;
}

// ─── Roda ffmpeg silence-detect e parseia a saída ─────────────────────────────
function runSilenceDetect(audioPath, duration) {
  return new Promise((resolve, reject) => {
    const lines = [];

    ffmpeg(audioPath)
      .audioFilters(
        `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_DURATION}`
      )
      .format('null')
      .output('-')
      .on('stderr', (line) => lines.push(line))
      .on('end',   () => resolve(lines.join('\n')))
      .on('error', reject)
      .run();
  });
}

// ─── Obtém duração total do áudio ─────────────────────────────────────────────
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });
}

// ─── Parseia a saída do silencedetect ─────────────────────────────────────────
function parseSilences(output, totalDuration) {
  const silences = [];
  const startRe  = /silence_start:\s*([\d.]+)/g;
  const endRe    = /silence_end:\s*([\d.]+)/g;

  const starts = [...output.matchAll(startRe)].map(m => parseFloat(m[1]));
  const ends   = [...output.matchAll(endRe)].map(m => parseFloat(m[1]));

  const count = Math.min(starts.length, ends.length);
  for (let i = 0; i < count; i++) {
    silences.push({ start: starts[i], end: ends[i] });
  }

  // Se o áudio termina em silêncio, adiciona silêncio final
  if (starts.length > ends.length) {
    silences.push({ start: starts[starts.length - 1], end: totalDuration });
  }

  return silences;
}

// ─── Inverte silêncios → segmentos de voz ─────────────────────────────────────
function silencesToSpeech(silences, totalDuration) {
  const speech = [];
  let cursor = 0;

  for (const sil of silences) {
    if (sil.start > cursor + 0.1) {
      speech.push({ start: cursor, end: sil.start });
    }
    cursor = sil.end;
  }

  if (cursor < totalDuration - 0.2) {
    speech.push({ start: cursor, end: totalDuration });
  }

  return speech;
}

// ─── Agrupa segmentos de fala em N estrofes ───────────────────────────────────
function groupSegments(speechSegments, stanzaCount) {
  if (speechSegments.length === 0) return [];

  // Se há pelo menos tantos segmentos quanto estrofes → mapeia 1:1 (ou N:1)
  // Distribuição: divide os segmentos proporcionalmente entre as estrofes
  const total = speechSegments.length;
  const result = [];

  for (let i = 0; i < stanzaCount; i++) {
    // Índice de início/fim dentro de speechSegments para esta estrofe
    const startIdx = Math.round((i / stanzaCount) * total);
    const endIdx   = Math.round(((i + 1) / stanzaCount) * total) - 1;

    const safeStart = Math.min(startIdx, total - 1);
    const safeEnd   = Math.min(endIdx, total - 1);

    const segStart = speechSegments[safeStart].start;
    const segEnd   = speechSegments[safeEnd].end;

    result.push({
      start: Math.max(0, segStart - 0.1),   // pequeno lead-in
      end:   segEnd
    });
  }

  return result;
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────
/**
 * detectVoiceSegments(audioUrl, stanzaCount)
 * Retorna array de { start, end } em segundos para cada estrofe.
 */
export async function detectVoiceSegments(audioUrl, stanzaCount) {
  let tempFile = null;

  try {
    // 1. Baixa o áudio
    tempFile = await downloadToTemp(audioUrl);

    // 2. Duração total
    const totalDuration = await getAudioDuration(tempFile);

    if (!totalDuration || totalDuration < 1) {
      throw new Error('Duração do áudio inválida ou muito curta');
    }

    // 3. Detecta silêncios
    const ffmpegOutput = await runSilenceDetect(tempFile, totalDuration);

    // 4. Parseia silêncios → segmentos de voz
    const silences = parseSilences(ffmpegOutput, totalDuration);
    let speechSegs  = silencesToSpeech(silences, totalDuration);

    // Se não detectou segmentos de voz, distribui linearmente
    if (speechSegs.length === 0) {
      const chunkDur = totalDuration / stanzaCount;
      speechSegs = Array.from({ length: stanzaCount }, (_, i) => ({
        start: i * chunkDur,
        end:   Math.min((i + 1) * chunkDur, totalDuration)
      }));
      return speechSegs;
    }

    // 5. Agrupa em N estrofes
    return groupSegments(speechSegs, stanzaCount);

  } finally {
    // Limpa arquivo temporário
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  }
}
