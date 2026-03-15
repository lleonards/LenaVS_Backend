/**
 * voiceSync.js  —  v3 (Forced Alignment + Whisper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Implementa a mesma técnica usada pelo Youka (Whisper AI mode):
 *
 *   CAMADA 1 — Whisper + Forced Alignment (Needleman-Wunsch)
 *     • Transcreve o áudio original com OpenAI Whisper API
 *     • Obtém timestamps palavra por palavra
 *     • Alinha as palavras da letra com as palavras transcritas usando o
 *       algoritmo Needleman-Wunsch (alinhamento de sequências globais,
 *       o mesmo conceito usado em aeneas / WhisperX / forced aligners)
 *     • Cada estrofe recebe o intervalo [primeira_palavra, última_palavra]
 *
 *   CAMADA 2 — Whisper proporcional (fallback de matching)
 *     • Se o alinhamento global tiver baixa cobertura
 *     • Usa a timeline de fala detectada pelo Whisper
 *     • Distribui estrofes proporcionalmente por nº de palavras
 *
 *   CAMADA 3 — FFmpeg silence-detect multi-threshold (sem API key)
 *     • Usado quando o Whisper falha (sem OPENAI_API_KEY ou erro de rede)
 *     • Testa múltiplos thresholds: -20 → -40 dB
 *     • Agrupa/divide segmentos de silêncio para casar com o nº de estrofes
 *
 *   CAMADA 4 — Distribuição linear uniforme (último recurso)
 *
 * Requer: openai, fluent-ffmpeg
 * Env var: OPENAI_API_KEY (opcional — sem ela cai no silêncio/linear)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import ffmpeg from 'fluent-ffmpeg';

// ─── Helpers de texto ─────────────────────────────────────────────────────────

function normalizeWord(w) {
  return String(w)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^\w]/g, '');          // remove pontuação
}

function extractWordList(text) {
  return String(text || '')
    .split(/\s+/)
    .map(normalizeWord)
    .filter(w => w.length > 1);
}

// ─── Download e conversão de áudio ───────────────────────────────────────────

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext  = path.extname(new URL(url).pathname) || '.mp3';
    const dest = path.join(os.tmpdir(), `lena_sync_${Date.now()}${ext}`);
    const file = fs.createWriteStream(dest);
    const prot = url.startsWith('https') ? https : http;
    prot.get(url, (resp) => {
      if (resp.statusCode >= 400)
        return reject(new Error(`HTTP ${resp.statusCode} ao baixar áudio`));
      resp.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', reject);
  });
}

function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });
}

/** Converte para mp3 mono 16 kHz — Whisper processa mais rápido */
function convertToMp3Light(inputPath) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `lena_light_${Date.now()}.mp3`);
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .toFormat('mp3')
      .on('end', () => resolve(output))
      .on('error', reject)
      .save(output);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 1 — NEEDLEMAN-WUNSCH FORCED ALIGNMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alinha lyricsSeq (palavras da letra) com whisperSeq (palavras do Whisper)
 * usando Needleman-Wunsch global alignment.
 *
 * Retorna: array de { lyricsIdx: number|null, whisperIdx: number|null }
 * - lyricsIdx != null && whisperIdx != null → match (com timestamp)
 * - lyricsIdx != null && whisperIdx == null → palavra da letra sem match
 * - lyricsIdx == null && whisperIdx != null → palavra extra no Whisper (ruído)
 */
function needlemanWunsch(lyricsWords, whisperWords) {
  const n = lyricsWords.length;
  const m = whisperWords.length;

  if (n === 0 || m === 0) return [];

  const MATCH    =  2;
  const PARTIAL  =  1;   // substring match
  const MISMATCH = -1;
  const GAP      = -0.4;

  const wordScore = (a, b) => {
    if (a === b) return MATCH;
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)))
      return PARTIAL;
    return MISMATCH;
  };

  // DP matrix (flat array para performance)
  const dp = new Float32Array((n + 1) * (m + 1));
  const idx = (i, j) => i * (m + 1) + j;

  for (let i = 0; i <= n; i++) dp[idx(i, 0)] = i * GAP;
  for (let j = 0; j <= m; j++) dp[idx(0, j)] = j * GAP;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[idx(i, j)] = Math.max(
        dp[idx(i - 1, j - 1)] + wordScore(lyricsWords[i - 1], whisperWords[j - 1]),
        dp[idx(i - 1, j)] + GAP,
        dp[idx(i, j - 1)] + GAP
      );
    }
  }

  // Traceback
  const alignment = [];
  let i = n, j = m;

  while (i > 0 || j > 0) {
    if (
      i > 0 && j > 0 &&
      dp[idx(i, j)] === dp[idx(i - 1, j - 1)] + wordScore(lyricsWords[i - 1], whisperWords[j - 1])
    ) {
      alignment.unshift({ lyricsIdx: i - 1, whisperIdx: j - 1 });
      i--; j--;
    } else if (i > 0 && dp[idx(i, j)] === dp[idx(i - 1, j)] + GAP) {
      alignment.unshift({ lyricsIdx: i - 1, whisperIdx: null });
      i--;
    } else {
      alignment.unshift({ lyricsIdx: null, whisperIdx: j - 1 });
      j--;
    }
  }

  return alignment;
}

/**
 * Usa o alinhamento NW para atribuir { start, end } a cada estrofe.
 *
 * @param {Array} stanzas        [{text, ...}]
 * @param {Array} whisperWords   [{word, start, end}]
 * @returns {Array|null}         [{start, end}] ou null se cobertura < 30%
 */
function alignWithNW(stanzas, whisperWords) {
  if (!whisperWords || whisperWords.length === 0) return null;

  // Constrói as sequências
  const wNorm = whisperWords.map(w => normalizeWord(w.word));

  // Lista de todas as palavras da letra com referência de estrofe
  const lyricsFlat = []; // [{word, stanzaIdx}]
  stanzas.forEach((s, si) => {
    extractWordList(s.text).forEach(w => lyricsFlat.push({ word: w, stanzaIdx: si }));
  });

  if (lyricsFlat.length === 0) return null;

  const lNorm = lyricsFlat.map(lw => lw.word);

  // Alinhamento global
  const alignment = needlemanWunsch(lNorm, wNorm);

  // Para cada estrofe, encontra min(start) e max(end) das palavras alinhadas
  const stanzaRanges = stanzas.map(() => ({ startSec: Infinity, endSec: -Infinity, matchCount: 0 }));
  let totalMatched = 0;

  for (const { lyricsIdx, whisperIdx } of alignment) {
    if (lyricsIdx === null || whisperIdx === null) continue;

    const si  = lyricsFlat[lyricsIdx].stanzaIdx;
    const ww  = whisperWords[whisperIdx];

    if (ww.start < stanzaRanges[si].startSec) stanzaRanges[si].startSec = ww.start;
    if (ww.end   > stanzaRanges[si].endSec)   stanzaRanges[si].endSec   = ww.end;
    stanzaRanges[si].matchCount++;
    totalMatched++;
  }

  // Verifica cobertura mínima
  const coverage = totalMatched / lyricsFlat.length;
  console.log(`[voiceSync] NW coverage: ${(coverage * 100).toFixed(1)}%`);

  if (coverage < 0.25) return null; // Whisper não transcreveu bem o suficiente

  // Converte para {start, end}, mantendo null para estrofes sem match
  const result = stanzaRanges.map(r =>
    r.startSec === Infinity
      ? null
      : { start: Math.max(0, r.startSec - 0.05), end: r.endSec + 0.05 }
  );

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 2 — PROPORCIONAL NA TIMELINE DO WHISPER
// ─────────────────────────────────────────────────────────────────────────────

function alignProportional(stanzas, whisperWords) {
  if (!whisperWords || whisperWords.length === 0) return null;

  const activeStart = whisperWords[0].start;
  const activeEnd   = whisperWords[whisperWords.length - 1].end;
  const duration    = activeEnd - activeStart;
  if (duration < 1) return null;

  const counts     = stanzas.map(s => Math.max(extractWordList(s.text).length, 1));
  const total      = counts.reduce((a, b) => a + b, 0);
  const GAP        = Math.min(0.3, duration / (stanzas.length * 8));
  const available  = duration - GAP * (stanzas.length - 1);

  let cursor = activeStart;
  return stanzas.map((_, i) => {
    const dur   = available * (counts[i] / total);
    const start = cursor;
    const end   = Math.min(activeEnd, start + dur);
    cursor      = end + GAP;
    return { start, end };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 3 — FFMPEG SILENCE-DETECT MULTI-THRESHOLD
// ─────────────────────────────────────────────────────────────────────────────

const THRESHOLDS = [
  { noise: -20, dur: 0.3 },
  { noise: -25, dur: 0.3 },
  { noise: -30, dur: 0.4 },
  { noise: -35, dur: 0.4 },
  { noise: -40, dur: 0.5 },
];

function runSilenceDetect(audioPath, noise, dur) {
  return new Promise((resolve, reject) => {
    const lines = [];
    ffmpeg(audioPath)
      .audioFilters(`silencedetect=noise=${noise}dB:d=${dur}`)
      .format('null').output('-')
      .on('stderr', l => lines.push(l))
      .on('end',    () => resolve(lines.join('\n')))
      .on('error',  reject)
      .run();
  });
}

function parseSilences(out, totalDur) {
  const starts = [...out.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => +m[1]);
  const ends   = [...out.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => +m[1]);
  const count  = Math.min(starts.length, ends.length);
  const sils   = Array.from({ length: count }, (_, i) => ({ start: starts[i], end: ends[i] }));
  if (starts.length > ends.length)
    sils.push({ start: starts[starts.length - 1], end: totalDur });
  return sils;
}

function silencesToSpeech(sils, totalDur) {
  const segs = [];
  let cursor = 0;
  for (const s of sils) {
    if (s.start > cursor + 0.05) segs.push({ start: cursor, end: s.start });
    cursor = s.end;
  }
  if (cursor < totalDur - 0.1) segs.push({ start: cursor, end: totalDur });
  return segs;
}

function mergeToTarget(segs, target) {
  let s = [...segs];
  while (s.length > target) {
    let minGap = Infinity, minIdx = 0;
    for (let i = 0; i < s.length - 1; i++) {
      const g = s[i + 1].start - s[i].end;
      if (g < minGap) { minGap = g; minIdx = i; }
    }
    s.splice(minIdx, 2, { start: s[minIdx].start, end: s[minIdx + 1].end });
  }
  return s;
}

function splitToTarget(segs, target) {
  let s = [...segs];
  while (s.length < target) {
    let maxDur = 0, maxIdx = 0;
    for (let i = 0; i < s.length; i++) {
      const d = s[i].end - s[i].start;
      if (d > maxDur) { maxDur = d; maxIdx = i; }
    }
    const seg = s[maxIdx];
    const mid = (seg.start + seg.end) / 2;
    s.splice(maxIdx, 1,
      { start: seg.start, end: mid - 0.1 },
      { start: mid + 0.1, end: seg.end }
    );
  }
  return s;
}

async function alignWithSilence(audioPath, totalDur, stanzaCount) {
  for (const { noise, dur } of THRESHOLDS) {
    try {
      const out   = await runSilenceDetect(audioPath, noise, dur);
      const sils  = parseSilences(out, totalDur);
      const segs  = silencesToSpeech(sils, totalDur);
      if (segs.length >= 1) {
        let final = segs.length > stanzaCount
          ? mergeToTarget(segs, stanzaCount)
          : segs.length < stanzaCount
          ? splitToTarget(segs, stanzaCount)
          : segs;
        return final.map(s => ({
          start: Math.max(0, s.start - 0.1),
          end:   Math.min(totalDur, s.end)
        }));
      }
    } catch (_) { /* tenta próximo threshold */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 4 — LINEAR UNIFORME
// ─────────────────────────────────────────────────────────────────────────────

function alignLinear(stanzas, totalDur) {
  const n   = stanzas.length;
  const GAP = 0.25;
  const dur = Math.max(1, (totalDur - GAP * (n - 1)) / n);
  let cursor = 0;
  return stanzas.map(() => {
    const start = cursor;
    const end   = Math.min(totalDur, start + dur);
    cursor = end + GAP;
    return { start, end };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERPOLA nulls entre segmentos válidos
// ─────────────────────────────────────────────────────────────────────────────

function fillNulls(results, totalDur) {
  const n = results.length;
  const r = [...results];

  for (let i = 0; i < n; i++) {
    if (r[i] !== null) continue;

    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) if (r[j]) { prev = { v: r[j], i: j }; break; }
    for (let j = i + 1; j < n;  j++) if (r[j]) { next = { v: r[j], i: j }; break; }

    if (prev && next) {
      const slots = next.i - prev.i;
      const step  = (next.v.start - prev.v.end) / slots;
      const k     = i - prev.i;
      r[i] = {
        start: prev.v.end + step * (k - 1) + 0.05,
        end:   prev.v.end + step * k
      };
    } else if (prev) {
      const step = (totalDur - prev.v.end) / (n - prev.i);
      const k    = i - prev.i;
      r[i] = {
        start: prev.v.end + step * (k - 1) + 0.05,
        end:   prev.v.end + step * k
      };
    } else if (next) {
      const step = next.v.start / (next.i + 1);
      r[i] = { start: step * i, end: step * (i + 1) - 0.05 };
    } else {
      const step = totalDur / n;
      r[i] = { start: step * i, end: step * (i + 1) };
    }
  }

  return r.map(s => s ? {
    start: Math.max(0, s.start),
    end:   Math.min(totalDur, s.end)
  } : { start: 0, end: totalDur / n });
}

// ─────────────────────────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * syncStanzasWithWhisper(audioUrl, stanzas)
 *
 * @param {string} audioUrl   URL pública do áudio original
 * @param {Array}  stanzas    [{ id, text, ... }]
 * @returns {Array}           [{ start, end }]  em segundos
 */
export async function syncStanzasWithWhisper(audioUrl, stanzas) {
  const files = [];

  const cleanup = () => {
    for (const f of files)
      if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
  };

  try {
    // 1. Download
    const rawPath = await downloadToTemp(audioUrl);
    files.push(rawPath);

    const totalDur = await getAudioDuration(rawPath);

    // ── CAMADA 1 + 2: Whisper ──────────────────────────────────────
    if (process.env.OPENAI_API_KEY) {
      try {
        const lightPath = await convertToMp3Light(rawPath);
        files.push(lightPath);

        const openai = new OpenAI();
        const transcription = await openai.audio.transcriptions.create({
          file:                    fs.createReadStream(lightPath),
          model:                   'whisper-1',
          response_format:         'verbose_json',
          timestamp_granularities: ['word']
        });

        const words = transcription.words || [];
        console.log(`[voiceSync] Whisper: ${words.length} palavras`);

        if (words.length > 0) {
          // Camada 1: Needleman-Wunsch forced alignment
          const nwResult = alignWithNW(stanzas, words);
          if (nwResult) {
            console.log('[voiceSync] ✅ NW Forced Alignment');
            return fillNulls(nwResult, totalDur);
          }

          // Camada 2: proporcional na timeline do Whisper
          const propResult = alignProportional(stanzas, words);
          if (propResult) {
            console.log('[voiceSync] ✅ Proporcional Whisper timeline');
            return propResult;
          }
        }
      } catch (whisperErr) {
        console.warn('[voiceSync] Whisper falhou:', whisperErr.message);
      }
    } else {
      console.log('[voiceSync] OPENAI_API_KEY não definida — pulando Whisper');
    }

    // ── CAMADA 3: FFmpeg silence-detect ────────────────────────────
    const silResult = await alignWithSilence(rawPath, totalDur, stanzas.length);
    if (silResult) {
      console.log('[voiceSync] ✅ Silence-detect (ffmpeg)');
      return silResult;
    }

    // ── CAMADA 4: Linear ───────────────────────────────────────────
    console.log('[voiceSync] ✅ Linear (fallback final)');
    return alignLinear(stanzas, totalDur || 180);

  } finally {
    cleanup();
  }
}

// Compat com o controller
export async function detectVoiceSegments(audioUrl, stanzaCount) {
  const dummy = Array.from({ length: stanzaCount }, (_, i) => ({ id: i, text: '' }));
  return syncStanzasWithWhisper(audioUrl, dummy);
}
