/**
 * voiceSync.js  —  v4 (Line-Level Forced Alignment + Youka-style)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mesma técnica do Youka (Whisper AI mode) com sincronização por LINHA:
 *
 *   CAMADA 1 — Whisper + Forced Alignment (Needleman-Wunsch) LINE-LEVEL
 *     • Transcreve o áudio com OpenAI Whisper API (word timestamps)
 *     • Alinha palavras da letra com palavras transcritas via Needleman-Wunsch
 *     • Cada LINHA recebe seu intervalo preciso [start, end]
 *     • Cada ESTROFE recebe o intervalo da primeira à última linha
 *
 *   CAMADA 2 — Whisper proporcional por palavras (fallback)
 *     • Se cobertura NW < 25%, usa a timeline de fala do Whisper
 *     • Distribui linhas proporcionalmente por nº de palavras
 *
 *   CAMADA 3 — FFmpeg silence-detect multi-threshold (sem API key)
 *     • Testa múltiplos thresholds: -20 → -40 dB
 *     • Distribui linhas dentro dos segmentos de fala detectados
 *
 *   CAMADA 4 — Distribuição proporcional por palavras (último recurso)
 *     • Distribui linhas por peso proporcional ao nº de palavras
 *
 * Retorno: Array de segmentos por estrofe com linhas individuais:
 *   [ { start, end, lines: [ { start, end, text } ] } ]
 *
 * Requer: openai, fluent-ffmpeg
 * Env var: OPENAI_API_KEY (opcional)
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
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w]/g, '');
}

function extractWordList(text) {
  return String(text || '')
    .split(/\s+/)
    .map(normalizeWord)
    .filter(w => w.length > 1);
}

/**
 * Extrai lista de palavras normalizadas (permite 1 caractere).
 * Útil para âncoras curtas (ex: "i", "a").
 */
function extractWordListAllowShort(text) {
  return String(text || '')
    .split(/\s+/)
    .map(normalizeWord)
    .filter(w => w.length > 0);
}

/** Divide o texto de uma estrofe em linhas (remove linhas vazias) */
function splitIntoLines(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
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
// NEEDLEMAN-WUNSCH FORCED ALIGNMENT
// ─────────────────────────────────────────────────────────────────────────────

function needlemanWunsch(lyricsWords, whisperWords) {
  const n = lyricsWords.length;
  const m = whisperWords.length;

  if (n === 0 || m === 0) return [];

  const MATCH    =  2;
  const PARTIAL  =  1;
  const MISMATCH = -1;
  const GAP      = -0.4;

  const wordScore = (a, b) => {
    if (a === b) return MATCH;
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)))
      return PARTIAL;
    return MISMATCH;
  };

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

// ─────────────────────────────────────────────────────────────────────────────
// ALINHAMENTO LINE-LEVEL (retorna linhas com timestamps)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Usa o alinhamento NW para atribuir { start, end } a cada LINHA de cada estrofe.
 *
 * @param {Array} stanzas      [{id, text, ...}]
 * @param {Array} whisperWords [{word, start, end}]
 * @returns {Array|null}       [{start, end, lines:[{start,end,text}]}] ou null
 */
function alignLineLevelWithNW(stanzas, whisperWords) {
  if (!whisperWords || whisperWords.length === 0) return null;

  const wNorm = whisperWords.map(w => normalizeWord(w.word));

  // Constrói flat list de palavras com referência de (estrofe, linha)
  const lyricsFlat = []; // [{word, stanzaIdx, lineIdx}]
  stanzas.forEach((s, si) => {
    const lines = splitIntoLines(s.text);
    lines.forEach((line, li) => {
      extractWordList(line).forEach(w => {
        lyricsFlat.push({ word: w, stanzaIdx: si, lineIdx: li });
      });
    });
  });

  if (lyricsFlat.length === 0) return null;

  const lNorm = lyricsFlat.map(lw => lw.word);
  const alignment = needlemanWunsch(lNorm, wNorm);

  // Estrutura de ranges por (stanzaIdx, lineIdx)
  const rangeMap = new Map(); // key: `${si}_${li}` → {startSec, endSec, matchCount}

  for (const { lyricsIdx, whisperIdx } of alignment) {
    if (lyricsIdx === null || whisperIdx === null) continue;

    const { stanzaIdx: si, lineIdx: li } = lyricsFlat[lyricsIdx];
    const ww = whisperWords[whisperIdx];
    const key = `${si}_${li}`;

    if (!rangeMap.has(key)) {
      rangeMap.set(key, { startSec: Infinity, endSec: -Infinity, matchCount: 0 });
    }
    const r = rangeMap.get(key);
    if (ww.start < r.startSec) r.startSec = ww.start;
    if (ww.end   > r.endSec)   r.endSec   = ww.end;
    r.matchCount++;
  }

  const totalMatched = [...rangeMap.values()].reduce((a, v) => a + v.matchCount, 0);
  const coverage = totalMatched / lyricsFlat.length;
  console.log(`[voiceSync] NW line-level coverage: ${(coverage * 100).toFixed(1)}%`);

  if (coverage < 0.25) return null;

  // Monta resultado por estrofe com linhas
  const result = stanzas.map((s, si) => {
    const lines = splitIntoLines(s.text);
    const lineSegs = lines.map((lineText, li) => {
      const key = `${si}_${li}`;
      const r = rangeMap.get(key);
      if (!r || r.startSec === Infinity) return { start: null, end: null, text: lineText };
      return {
        start: Math.max(0, r.startSec - 0.05),
        end:   r.endSec + 0.1,
        text:  lineText
      };
    });

    // Interpola linhas sem match dentro do range da estrofe
    const validLines = lineSegs.filter(l => l.start !== null);
    if (validLines.length === 0) return null;

    // Preenche linhas sem match com interpolação
    const filledLines = fillLineNulls(lineSegs);

    const stanzaStart = filledLines[0].start;
    const stanzaEnd   = filledLines[filledLines.length - 1].end;

    return {
      start: stanzaStart,
      end:   stanzaEnd,
      lines: filledLines
    };
  });

  return result;
}

/**
 * Preenche linhas com start/end null interpolando entre vizinhos válidos.
 */
function fillLineNulls(lines) {
  const n = lines.length;
  const r = lines.map(l => ({ ...l }));

  for (let i = 0; i < n; i++) {
    if (r[i].start !== null) continue;

    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) if (r[j].start !== null) { prev = { v: r[j], i: j }; break; }
    for (let j = i + 1; j < n;  j++) if (r[j].start !== null) { next = { v: r[j], i: j }; break; }

    if (prev && next) {
      const slots = next.i - prev.i;
      const step  = (next.v.start - prev.v.end) / slots;
      const k     = i - prev.i;
      r[i] = { ...r[i], start: prev.v.end + step * (k - 1) + 0.05, end: prev.v.end + step * k };
    } else if (prev) {
      const step = 2.0; // assume ~2s por linha se não houver referência
      const k    = i - prev.i;
      r[i] = { ...r[i], start: prev.v.end + step * (k - 1) + 0.05, end: prev.v.end + step * k };
    } else if (next) {
      const step = next.v.start / (next.i + 1);
      r[i] = { ...r[i], start: Math.max(0, step * i), end: step * (i + 1) - 0.05 };
    }
  }

  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 2 — PROPORCIONAL NA TIMELINE DO WHISPER (LINE-LEVEL)
// ─────────────────────────────────────────────────────────────────────────────

function alignProportionalLineLevel(stanzas, whisperWords) {
  if (!whisperWords || whisperWords.length === 0) return null;

  const activeStart = whisperWords[0].start;
  const activeEnd   = whisperWords[whisperWords.length - 1].end;
  const duration    = activeEnd - activeStart;
  if (duration < 1) return null;

  // Coleta todas as linhas flat com contagem de palavras
  const allLines = [];
  stanzas.forEach((s, si) => {
    const lines = splitIntoLines(s.text);
    lines.forEach((lineText, li) => {
      allLines.push({
        stanzaIdx: si,
        lineIdx: li,
        text: lineText,
        wordCount: Math.max(extractWordList(lineText).length, 1)
      });
    });
  });

  if (allLines.length === 0) return null;

  const totalWords = allLines.reduce((a, l) => a + l.wordCount, 0);
  const LINE_GAP   = Math.min(0.2, duration / (allLines.length * 8));
  const available  = duration - LINE_GAP * (allLines.length - 1);

  let cursor = activeStart;
  const lineTimings = allLines.map(l => {
    const dur   = available * (l.wordCount / totalWords);
    const start = cursor;
    const end   = Math.min(activeEnd, start + dur);
    cursor = end + LINE_GAP;
    return { ...l, start, end };
  });

  // Agrupa por estrofe
  return stanzas.map((_, si) => {
    const stanzaLines = lineTimings.filter(l => l.stanzaIdx === si);
    if (stanzaLines.length === 0) return null;
    return {
      start: stanzaLines[0].start,
      end:   stanzaLines[stanzaLines.length - 1].end,
      lines: stanzaLines.map(l => ({ start: l.start, end: l.end, text: l.text }))
    };
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

/**
 * Distribui linhas dentro dos segmentos de fala detectados por silence-detect.
 * Retorna no mesmo formato line-level.
 */
async function alignWithSilenceLineLevel(audioPath, totalDur, stanzas) {
  for (const { noise, dur } of THRESHOLDS) {
    try {
      const out  = await runSilenceDetect(audioPath, noise, dur);
      const sils = parseSilences(out, totalDur);
      const segs = silencesToSpeech(sils, totalDur);

      if (segs.length >= 1) {
        // Coleta linhas flat
        const allLines = [];
        stanzas.forEach((s, si) => {
          const lines = splitIntoLines(s.text);
          lines.forEach((lineText, li) => {
            allLines.push({
              stanzaIdx: si,
              lineIdx: li,
              text: lineText,
              wordCount: Math.max(extractWordList(lineText).length, 1)
            });
          });
        });

        const totalLines = allLines.length;
        if (totalLines === 0) return null;

        // Ajusta nº de segmentos de fala para nº de linhas
        let speechSegs = segs.length > totalLines
          ? mergeToTarget(segs, totalLines)
          : segs.length < totalLines
          ? splitToTarget(segs, totalLines)
          : segs;

        // Associa cada linha a um segmento
        const lineTimings = allLines.map((l, i) => ({
          ...l,
          start: Math.max(0, speechSegs[i].start - 0.1),
          end:   Math.min(totalDur, speechSegs[i].end)
        }));

        // Agrupa por estrofe
        return stanzas.map((_, si) => {
          const stanzaLines = lineTimings.filter(l => l.stanzaIdx === si);
          if (stanzaLines.length === 0) return null;
          return {
            start: stanzaLines[0].start,
            end:   stanzaLines[stanzaLines.length - 1].end,
            lines: stanzaLines.map(l => ({ start: l.start, end: l.end, text: l.text }))
          };
        });
      }
    } catch (_) { /* tenta próximo threshold */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 4 — LINEAR PROPORCIONAL POR PALAVRAS (último recurso)
// ─────────────────────────────────────────────────────────────────────────────

function alignLinearProportional(stanzas, totalDur) {
  const allLines = [];
  stanzas.forEach((s, si) => {
    const lines = splitIntoLines(s.text);
    lines.forEach((lineText, li) => {
      allLines.push({
        stanzaIdx: si,
        lineIdx: li,
        text: lineText,
        wordCount: Math.max(extractWordList(lineText).length, 1)
      });
    });
  });

  if (allLines.length === 0) {
    return stanzas.map(() => ({ start: 0, end: totalDur / stanzas.length, lines: [] }));
  }

  const totalWords = allLines.reduce((a, l) => a + l.wordCount, 0);
  const LINE_GAP   = 0.2;
  const available  = Math.max(1, totalDur - LINE_GAP * (allLines.length - 1));

  let cursor = 0;
  const lineTimings = allLines.map(l => {
    const dur   = available * (l.wordCount / totalWords);
    const start = cursor;
    const end   = Math.min(totalDur, start + dur);
    cursor = end + LINE_GAP;
    return { ...l, start, end };
  });

  return stanzas.map((_, si) => {
    const stanzaLines = lineTimings.filter(l => l.stanzaIdx === si);
    if (stanzaLines.length === 0) return { start: 0, end: totalDur, lines: [] };
    return {
      start: stanzaLines[0].start,
      end:   stanzaLines[stanzaLines.length - 1].end,
      lines: stanzaLines.map(l => ({ start: l.start, end: l.end, text: l.text }))
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERPOLA nulls entre estrofes
// ─────────────────────────────────────────────────────────────────────────────

function fillStanzaNulls(results, stanzas, totalDur) {
  const n = results.length;
  const r = [...results];

  for (let i = 0; i < n; i++) {
    if (r[i] !== null) continue;

    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) if (r[j]) { prev = { v: r[j], i: j }; break; }
    for (let j = i + 1; j < n;  j++) if (r[j]) { next = { v: r[j], i: j }; break; }

    let start, end;

    if (prev && next) {
      const slots = next.i - prev.i;
      const step  = (next.v.start - prev.v.end) / slots;
      const k     = i - prev.i;
      start = prev.v.end + step * (k - 1) + 0.05;
      end   = prev.v.end + step * k;
    } else if (prev) {
      const step = 3.0;
      const k    = i - prev.i;
      start = prev.v.end + step * (k - 1) + 0.05;
      end   = prev.v.end + step * k;
    } else if (next) {
      const step = next.v.start / (next.i + 1);
      start = Math.max(0, step * i);
      end   = step * (i + 1) - 0.05;
    } else {
      start = (totalDur / n) * i;
      end   = (totalDur / n) * (i + 1);
    }

    // Distribui linhas proporcionalmente dentro do intervalo interpolado
    const lines = splitIntoLines(stanzas[i]?.text || '');
    const lineDur = lines.length > 0 ? (end - start) / lines.length : (end - start);
    r[i] = {
      start,
      end,
      lines: lines.map((text, li) => ({
        start: start + lineDur * li,
        end:   start + lineDur * (li + 1) - 0.05,
        text
      }))
    };
  }

  return r.map(s => ({
    ...s,
    start: Math.max(0, s.start),
    end:   Math.min(totalDur, s.end),
    lines: (s.lines || []).map(l => ({
      ...l,
      start: Math.max(0, l.start),
      end:   Math.min(totalDur, l.end)
    }))
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * syncStanzasWithWhisper(audioUrl, stanzas)
 *
 * @param {string} audioUrl   URL pública do áudio original
 * @param {Array}  stanzas    [{ id, text, ... }]
 * @returns {Array}           [{ start, end, lines: [{start, end, text}] }]
 */
export async function syncStanzasWithWhisper(audioUrl, stanzas) {
  const files = [];

  const cleanup = () => {
    for (const f of files)
      if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
  };

  try {
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
          // Camada 1: NW line-level forced alignment
          const nwResult = alignLineLevelWithNW(stanzas, words);
          if (nwResult) {
            console.log('[voiceSync] ✅ NW Line-Level Forced Alignment');
            return fillStanzaNulls(nwResult, stanzas, totalDur);
          }

          // Camada 2: proporcional por palavras na timeline do Whisper
          const propResult = alignProportionalLineLevel(stanzas, words);
          if (propResult) {
            console.log('[voiceSync] ✅ Proporcional Line-Level Whisper');
            return fillStanzaNulls(propResult, stanzas, totalDur);
          }
        }
      } catch (whisperErr) {
        console.warn('[voiceSync] Whisper falhou:', whisperErr.message);
      }
    } else {
      console.log('[voiceSync] OPENAI_API_KEY não definida — pulando Whisper');
    }

    // ── CAMADA 3: FFmpeg silence-detect ────────────────────────────
    const silResult = await alignWithSilenceLineLevel(rawPath, totalDur, stanzas);
    if (silResult) {
      console.log('[voiceSync] ✅ Silence-detect line-level (ffmpeg)');
      return fillStanzaNulls(silResult, stanzas, totalDur);
    }

    // ── CAMADA 4: Linear proporcional ─────────────────────────────
    console.log('[voiceSync] ✅ Linear proporcional (fallback final)');
    return alignLinearProportional(stanzas, totalDur || 180);

  } finally {
    cleanup();
  }
}

// Compat retrocompatível
export async function detectVoiceSegments(audioUrl, stanzaCount) {
  const dummy = Array.from({ length: stanzaCount }, (_, i) => ({ id: i, text: '' }));
  return syncStanzasWithWhisper(audioUrl, dummy);
}

// ─────────────────────────────────────────────────────────────────────────────
// NOVO — SINCRONIZAÇÃO POR ÂNCORAS (3 primeiras + 3 últimas palavras)
// ─────────────────────────────────────────────────────────────────────────────

function findFirstSequence(haystack, needle, startFrom = 0) {
  if (!needle?.length) return -1;
  const n = haystack.length;
  const m = needle.length;

  for (let i = Math.max(0, startFrom); i <= n - m; i++) {
    let ok = true;
    for (let j = 0; j < m; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function findLastSequence(haystack, needle, startFrom = 0) {
  if (!needle?.length) return -1;
  const n = haystack.length;
  const m = needle.length;

  let last = -1;
  for (let i = Math.max(0, startFrom); i <= n - m; i++) {
    let ok = true;
    for (let j = 0; j < m; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) last = i;
  }
  return last;
}

/**
 * syncStanzasWithWhisperAnchors(audioUrl, stanzas)
 *
 * Implementa a lógica solicitada:
 *  1) Whisper verbose_json + timestamps por palavra
 *  2) Para cada estrofe: 3 primeiras + 3 últimas palavras
 *  3) Busca âncoras na transcrição
 *  4) startTime = tempo da primeira ocorrência das 3 primeiras palavras
 *     endTime   = tempo do FINAL da última ocorrência das 3 últimas palavras
 *  5) Se não encontrar, ignora a estrofe
 *
 * Entrada:
 *  - audioUrl (URL pública)
 *  - stanzas: [{ id?, text }]
 *
 * Saída:
 *  - [{ text, startTime, endTime }]
 */
export async function syncStanzasWithWhisperAnchors(audioUrl, stanzas, opts = {}) {
  const { respectOrder = true } = opts;

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não definida — necessário para Whisper');
  }

  const files = [];
  const cleanup = () => {
    for (const f of files)
      if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
  };

  try {
    const rawPath = await downloadToTemp(audioUrl);
    files.push(rawPath);

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
    if (!words.length) return [];

    const tNorm = words.map(w => normalizeWord(w.word));

    const out = [];
    let cursor = 0;

    for (const s of (stanzas || [])) {
      const text = String(s?.text ?? '');

      // mantém o comportamento "3 primeiras/3 últimas" após normalização
      const stanzaWords = extractWordListAllowShort(text);
      if (!stanzaWords.length) continue;

      const kStart = Math.min(3, stanzaWords.length);
      const kEnd   = Math.min(3, stanzaWords.length);
      const startNeedle = stanzaWords.slice(0, kStart);
      const endNeedle   = stanzaWords.slice(stanzaWords.length - kEnd);

      const searchFrom = respectOrder ? cursor : 0;
      const startIdx = findFirstSequence(tNorm, startNeedle, searchFrom);
      if (startIdx < 0) continue;

      // endTime deve estar depois do start
      const endSearchFrom = startIdx + startNeedle.length;
      const endIdx = findLastSequence(tNorm, endNeedle, endSearchFrom);
      if (endIdx < 0) continue;

      const startTime = Number(words[startIdx]?.start);
      const endWord   = words[endIdx + endNeedle.length - 1];
      const endTime   = Number(endWord?.end);

      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
        continue;
      }

      out.push({ text, startTime, endTime });

      if (respectOrder) cursor = endIdx + endNeedle.length;
    }

    return out;
  } finally {
    cleanup();
  }
}
