/**
 * voiceSync.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detecta segmentos de VOZ/ENERGIA no áudio usando ffmpeg silence-detection.
 *
 * Estratégia aprimorada:
 *   1. Baixa o arquivo de áudio da URL pública (ou usa path local).
 *   2. Tenta múltiplos thresholds (do mais sensível ao menos sensível) até
 *      encontrar uma quantidade de segmentos útil.
 *   3. Quando há mais segmentos que estrofes → mescla os menores para reduzir.
 *   4. Quando há menos segmentos que estrofes → subdivide os maiores.
 *   5. Fallback robusto: distribuição linear uniforme.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';

// ─── Thresholds a tentar (do mais sensível ao menos) ─────────────────────────
// Para músicas instrumentais simples, thresholds mais altos (-20dB) funcionam
// melhor pois detectam pausas mais curtas entre seções
const THRESHOLD_CANDIDATES = [
  { noise: -20, duration: 0.3 },
  { noise: -25, duration: 0.3 },
  { noise: -30, duration: 0.4 },
  { noise: -35, duration: 0.4 },
  { noise: -40, duration: 0.5 },
];

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

// ─── Roda ffmpeg silence-detect com parâmetros específicos ───────────────────
function runSilenceDetect(audioPath, noise, duration) {
  return new Promise((resolve, reject) => {
    const lines = [];

    ffmpeg(audioPath)
      .audioFilters(`silencedetect=noise=${noise}dB:d=${duration}`)
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

  // Silêncio final não fechado
  if (starts.length > ends.length) {
    silences.push({ start: starts[starts.length - 1], end: totalDuration });
  }

  return silences;
}

// ─── Inverte silêncios → segmentos de voz/energia ────────────────────────────
function silencesToSpeech(silences, totalDuration) {
  const speech = [];
  let cursor = 0;

  for (const sil of silences) {
    if (sil.start > cursor + 0.05) {
      speech.push({ start: cursor, end: sil.start });
    }
    cursor = sil.end;
  }

  if (cursor < totalDuration - 0.1) {
    speech.push({ start: cursor, end: totalDuration });
  }

  return speech;
}

// ─── Mescla segmentos vizinhos até atingir a quantidade alvo ─────────────────
function mergeSegmentsToTarget(segments, target) {
  let segs = [...segments];

  while (segs.length > target) {
    // Encontra o par de segmentos adjacentes com menor gap entre eles
    // (ou seja, o par mais "próximo" — fundir os mais contíguos primeiro)
    let minGap = Infinity;
    let minIdx = 0;

    for (let i = 0; i < segs.length - 1; i++) {
      const gap = segs[i + 1].start - segs[i].end;
      if (gap < minGap) {
        minGap = gap;
        minIdx = i;
      }
    }

    // Funde o par
    const merged = {
      start: segs[minIdx].start,
      end: segs[minIdx + 1].end
    };
    segs.splice(minIdx, 2, merged);
  }

  return segs;
}

// ─── Subdivide segmentos longos para atingir a quantidade alvo ───────────────
function splitSegmentsToTarget(segments, target) {
  let segs = [...segments];

  while (segs.length < target) {
    // Divide o segmento mais longo ao meio
    let maxDur = 0;
    let maxIdx = 0;

    for (let i = 0; i < segs.length; i++) {
      const dur = segs[i].end - segs[i].start;
      if (dur > maxDur) {
        maxDur = dur;
        maxIdx = i;
      }
    }

    const seg = segs[maxIdx];
    const mid = (seg.start + seg.end) / 2;
    const gap = 0.15; // pequena pausa virtual entre os dois novos segmentos
    const half1 = { start: seg.start, end: mid - gap / 2 };
    const half2 = { start: mid + gap / 2, end: seg.end };
    segs.splice(maxIdx, 1, half1, half2);
  }

  return segs;
}

// ─── Tenta detectar segmentos com múltiplos thresholds ───────────────────────
async function tryDetectSegments(audioPath, totalDuration, stanzaCount) {
  for (const { noise, duration } of THRESHOLD_CANDIDATES) {
    try {
      const output   = await runSilenceDetect(audioPath, noise, duration);
      const silences = parseSilences(output, totalDuration);
      const speech   = silencesToSpeech(silences, totalDuration);

      // Aceita se detectou ao menos 1 segmento
      if (speech.length >= 1) {
        return speech;
      }
    } catch (_) {
      // Tenta o próximo threshold
    }
  }

  return []; // nenhum threshold funcionou
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

    // 3. Detecta segmentos com múltiplos thresholds
    let speechSegs = await tryDetectSegments(tempFile, totalDuration, stanzaCount);

    // 4. Fallback: distribuição linear uniforme
    if (speechSegs.length === 0) {
      const gap = 0.25;
      const stanzaDur = Math.max(1, (totalDuration - gap * (stanzaCount - 1)) / stanzaCount);
      speechSegs = Array.from({ length: stanzaCount }, (_, i) => ({
        start: i * (stanzaDur + gap),
        end:   Math.min(i * (stanzaDur + gap) + stanzaDur, totalDuration)
      }));
      return speechSegs;
    }

    // 5. Ajusta quantidade de segmentos para bater com stanzaCount
    let finalSegs;
    if (speechSegs.length > stanzaCount) {
      finalSegs = mergeSegmentsToTarget(speechSegs, stanzaCount);
    } else if (speechSegs.length < stanzaCount) {
      finalSegs = splitSegmentsToTarget(speechSegs, stanzaCount);
    } else {
      finalSegs = speechSegs;
    }

    // 6. Aplica pequeno lead-in e garante que não ultrapassa a duração
    return finalSegs.map(seg => ({
      start: Math.max(0, seg.start - 0.1),
      end:   Math.min(totalDuration, seg.end)
    }));

  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  }
}
