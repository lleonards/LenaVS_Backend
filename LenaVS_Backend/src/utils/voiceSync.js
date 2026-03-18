/**
 * voiceSync.js  —  v5 (Fuzzy Block Matching)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sincroniza automaticamente as estrofes da letra com a música usando:
 *
 *   ETAPA 1 — Whisper API (word-level timestamps)
 *     • Transcreve o áudio com OpenAI Whisper (verbose_json + word timestamps)
 *     • Cada palavra transcrita tem { word, start, end }
 *
 *   ETAPA 2 — Fuzzy Block Matching
 *     • Para cada estrofe da letra:
 *         - Monta uma "janela deslizante" sobre as palavras do Whisper
 *           com tamanho proporcional ao número de palavras da estrofe
 *         - Compara o bloco de texto da janela com o texto da estrofe
 *           usando similaridade de texto (Jaccard + bonus de bigrams)
 *         - A janela com maior similaridade (≥ 0.6) é o match
 *         - startTime = start da primeira palavra da janela vencedora
 *         - endTime   = end   da última  palavra da janela vencedora
 *     • Estrofes são processadas sequencialmente:
 *         a busca sempre começa depois do fim da estrofe anterior
 *         garantindo ordem correta e sem sobreposições
 *
 *   FALLBACKS (sem API key ou Whisper falhar):
 *     CAMADA 3 — FFmpeg silence-detect (detecta segmentos de fala)
 *     CAMADA 4 — Distribuição proporcional por nº de palavras
 *
 * ─── Exports públicos ───────────────────────────────────────────────────────
 *
 *  syncStanzasWithWhisper(audioUrl, stanzas, opts?)
 *    → Promise<[{ start, end, lines:[{start,end,text}] }]>
 *    (formato compatível com /voice-sync)
 *
 *  syncStanzasWithWhisperAnchors(audioUrl, stanzas, opts?)
 *    → Promise<[{ text, startTime, endTime }]>
 *    (formato compatível com /voice-sync-anchors)
 *
 *  chooseBestAudioCandidateByLyrics(audioUrls, stanzas, opts?)
 *    → Promise<{ bestUrl, bestIndex, ranking }>
 *    (formato compatível com /voice-sync-auto)
 *
 * Requer: openai, fluent-ffmpeg
 * Env:    OPENAI_API_KEY (opcional — fallback sem API)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import OpenAI  from 'openai';
import fs      from 'fs';
import path    from 'path';
import os      from 'os';
import https   from 'https';
import http    from 'http';
import ffmpeg  from 'fluent-ffmpeg';

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 1 — HELPERS DE TEXTO
// ═════════════════════════════════════════════════════════════════════════════

/** Normaliza uma palavra: lowercase, sem acento, só alfanumérico */
function normalizeWord(w) {
  return String(w || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w]/g, '');
}

/** Extrai lista de palavras normalizadas (mín. 2 chars) */
function extractWords(text) {
  return String(text || '')
    .split(/\s+/)
    .map(normalizeWord)
    .filter(w => w.length >= 2);
}

/** Extrai lista de palavras normalizadas (permite 1 char) */
function extractWordsAllowShort(text) {
  return String(text || '')
    .split(/\s+/)
    .map(normalizeWord)
    .filter(w => w.length > 0);
}

/** Divide texto de estrofe em linhas (sem vazias) */
function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 2 — FUZZY MATCHING DE BLOCOS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Calcula similaridade entre dois arrays de palavras normalizadas.
 *
 * Combina:
 *  - Jaccard sobre unigrams  (peso 0.6)
 *  - Jaccard sobre bigrams   (peso 0.4) — captura ordem
 *
 * @param {string[]} aWords  palavras do bloco de consulta (estrofe)
 * @param {string[]} bWords  palavras do bloco candidato (janela Whisper)
 * @returns {number} similaridade [0, 1]
 */
function blockSimilarity(aWords, bWords) {
  if (aWords.length === 0 || bWords.length === 0) return 0;

  // ── Jaccard de unigrams ───────────────────────────────────────────────────
  const setA = new Set(aWords);
  const setB = new Set(bWords);

  let uniIntersect = 0;
  for (const w of setA) {
    if (setB.has(w)) uniIntersect++;
  }
  const uniUnion   = setA.size + setB.size - uniIntersect;
  const jaccard1   = uniUnion > 0 ? uniIntersect / uniUnion : 0;

  // ── Jaccard de bigrams ────────────────────────────────────────────────────
  function makeBigrams(words) {
    const bg = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      bg.add(words[i] + '|' + words[i + 1]);
    }
    return bg;
  }

  const bgA = makeBigrams(aWords);
  const bgB = makeBigrams(bWords);

  let bgIntersect = 0;
  for (const bg of bgA) {
    if (bgB.has(bg)) bgIntersect++;
  }
  const bgUnion  = bgA.size + bgB.size - bgIntersect;
  const jaccard2 = bgUnion > 0 ? bgIntersect / bgUnion : 0;

  return 0.6 * jaccard1 + 0.4 * jaccard2;
}

/**
 * Core: encontra os índices das palavras Whisper que correspondem a cada estrofe.
 *
 * Algoritmo:
 *  Para cada estrofe (em ordem):
 *    1) Calcula o tamanho ideal da janela = max(nWordsEstrofe * WINDOW_RATIO, MIN_WINDOW)
 *    2) Desliza a janela sobre words[cursor..] com step = 1
 *    3) Para cada posição calcula blockSimilarity(stanzaWords, windowWords)
 *    4) Se max_similarity >= MIN_SIMILARITY → match encontrado
 *       cursor avança para o fim do match (evita sobreposição)
 *    5) Se não encontrar → estrofe sem match (retorna null para ela)
 *
 * @param {Array}  stanzas      [{id, text}]
 * @param {Array}  whisperWords [{word, start, end}]
 * @returns {Array} [{text, startIdx, endIdx, startTime, endTime}|null]
 */
function fuzzyMatchStanzas(stanzas, whisperWords) {
  const MIN_SIMILARITY = 0.45;
  const WINDOW_RATIO   = 1.1;   // janela um pouco maior que a estrofe (canto varia)
  const MIN_WINDOW     = 4;     // mínimo de palavras na janela

  const wNorm = whisperWords.map(w => normalizeWord(w.word));
  const total = wNorm.length;
  const results = [];

  let cursor = 0; // onde começa a busca da próxima estrofe

  for (const stanza of stanzas) {
    const stanzaText  = String(stanza.text || '');
    const stanzaWords = extractWordsAllowShort(stanzaText);

    if (stanzaWords.length === 0) {
      results.push(null);
      continue;
    }

    const winSize = Math.max(MIN_WINDOW, Math.round(stanzaWords.length * WINDOW_RATIO));

    let bestScore = -1;
    let bestStart = -1;
    let bestEnd   = -1;

    // Desliza a janela a partir do cursor
    for (let i = cursor; i <= total - Math.max(1, stanzaWords.length - 2); i++) {
      // Usa janela adaptativa: testa ±25% do tamanho ideal
      const winMin = Math.max(MIN_WINDOW, Math.floor(winSize * 0.75));
      const winMax = Math.min(total - i, Math.ceil(winSize * 1.25));

      // Itera tamanhos de janela em torno do ideal
      for (let w = winMin; w <= winMax; w++) {
        if (i + w > total) break;

        const windowWords = wNorm.slice(i, i + w);
        const score       = blockSimilarity(stanzaWords, windowWords);

        if (score > bestScore) {
          bestScore = score;
          bestStart = i;
          bestEnd   = i + w - 1;
        }
      }

      // Poda: se já encontramos score muito alto, não precisa continuar
      if (bestScore >= 0.92) break;
    }

    if (bestScore >= MIN_SIMILARITY && bestStart >= 0) {
      const startTime = whisperWords[bestStart]?.start ?? 0;
      const endTime   = whisperWords[bestEnd]?.end   ?? whisperWords[bestEnd]?.start ?? 0;

      results.push({
        text:      stanzaText,
        startIdx:  bestStart,
        endIdx:    bestEnd,
        startTime: Math.max(0, startTime - 0.05),
        endTime:   endTime + 0.10,
        score:     bestScore
      });

      // Avança cursor para não sobrepor com a próxima estrofe
      cursor = bestEnd + 1;
    } else {
      console.log(`[voiceSync] fuzzy: estrofe sem match (score=${bestScore.toFixed(3)}): "${stanzaText.slice(0, 40)}..."`);
      results.push(null);
    }
  }

  return results;
}

/**
 * Preenche estrofes sem match (null) interpolando entre vizinhos com match.
 *
 * @param {Array}  matches   saída de fuzzyMatchStanzas
 * @param {Array}  stanzas   [{text}]
 * @param {number} totalDur  duração total do áudio em segundos
 * @returns {Array} matches sem nulls
 */
function fillNullMatches(matches, stanzas, totalDur) {
  const n = matches.length;
  const r = matches.map(m => (m ? { ...m } : null));

  for (let i = 0; i < n; i++) {
    if (r[i] !== null) continue;

    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) { if (r[j]) { prev = { v: r[j], i: j }; break; } }
    for (let j = i + 1; j < n;  j++) { if (r[j]) { next = { v: r[j], i: j }; break; } }

    let startTime, endTime;

    if (prev && next) {
      const slots = next.i - prev.i;
      const step  = (next.v.startTime - prev.v.endTime) / slots;
      const k     = i - prev.i;
      startTime = prev.v.endTime + step * (k - 1) + 0.1;
      endTime   = prev.v.endTime + step * k;
    } else if (prev) {
      const step = 3.5;
      const k    = i - prev.i;
      startTime = prev.v.endTime + step * (k - 1) + 0.1;
      endTime   = startTime + step - 0.1;
    } else if (next) {
      const step = next.v.startTime / (next.i + 1);
      startTime  = Math.max(0, step * i);
      endTime    = step * (i + 1) - 0.1;
    } else {
      startTime = (totalDur / n) * i;
      endTime   = (totalDur / n) * (i + 1);
    }

    r[i] = {
      text:      stanzas[i]?.text || '',
      startTime: Math.max(0, startTime),
      endTime:   Math.min(totalDur, endTime),
      score:     0
    };
  }

  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 3 — ÁUDIO: DOWNLOAD, CONVERSÃO, TRANSCRIÇÃO
// ═════════════════════════════════════════════════════════════════════════════

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

/**
 * Converte áudio para MP3 mono 16kHz leve (ideal para Whisper).
 * Reduz custo e tempo de transcrição.
 */
function convertToMp3Light(inputPath) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `lena_light_${Date.now()}.mp3`);
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .toFormat('mp3')
      .on('end',   () => resolve(output))
      .on('error', reject)
      .save(output);
  });
}

/**
 * Transcreve áudio com Whisper API e retorna array de palavras com timestamps.
 * @returns {Promise<Array<{word:string, start:number, end:number}>>}
 */
async function transcribeWithWhisper(localAudioPath) {
  const lightPath = await convertToMp3Light(localAudioPath);

  try {
    const openai = new OpenAI();
    const result = await openai.audio.transcriptions.create({
      file:                    fs.createReadStream(lightPath),
      model:                   'whisper-1',
      response_format:         'verbose_json',
      timestamp_granularities: ['word']
    });
    return result.words || [];
  } finally {
    try { fs.unlinkSync(lightPath); } catch (_) {}
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 4 — FALLBACKS SEM WHISPER
// ═════════════════════════════════════════════════════════════════════════════

// ── Fallback 3: FFmpeg silence-detect ────────────────────────────────────────

const SILENCE_THRESHOLDS = [
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

function adjustSegmentCount(segs, target) {
  let s = [...segs];

  // Merge: une segmentos mais próximos até atingir o target
  while (s.length > target) {
    let minGap = Infinity, minIdx = 0;
    for (let i = 0; i < s.length - 1; i++) {
      const g = s[i + 1].start - s[i].end;
      if (g < minGap) { minGap = g; minIdx = i; }
    }
    s.splice(minIdx, 2, { start: s[minIdx].start, end: s[minIdx + 1].end });
  }

  // Split: divide o segmento mais longo até atingir o target
  while (s.length < target) {
    let maxDur = 0, maxIdx = 0;
    for (let i = 0; i < s.length; i++) {
      const d = s[i].end - s[i].start;
      if (d > maxDur) { maxDur = d; maxIdx = i; }
    }
    const seg = s[maxIdx];
    const mid = (seg.start + seg.end) / 2;
    s.splice(maxIdx, 1,
      { start: seg.start,    end: mid - 0.1 },
      { start: mid + 0.1,   end: seg.end    }
    );
  }

  return s;
}

/**
 * Fallback 3: distribui estrofes nos segmentos de fala detectados pelo FFmpeg.
 * Retorna no formato { text, startTime, endTime }[].
 */
async function fallbackSilenceDetect(audioPath, totalDur, stanzas) {
  for (const { noise, dur } of SILENCE_THRESHOLDS) {
    try {
      const out  = await runSilenceDetect(audioPath, noise, dur);
      const sils = parseSilences(out, totalDur);
      const segs = silencesToSpeech(sils, totalDur);

      if (segs.length >= 1) {
        const adjusted = adjustSegmentCount(segs, stanzas.length);
        return stanzas.map((s, i) => ({
          text:      s.text,
          startTime: Math.max(0, adjusted[i].start - 0.1),
          endTime:   Math.min(totalDur, adjusted[i].end)
        }));
      }
    } catch (_) { /* tenta próximo threshold */ }
  }
  return null;
}

// ── Fallback 4: Distribuição proporcional por palavras ───────────────────────

/**
 * Fallback 4: distribui estrofes linearmente pela duração total,
 * pesando pelo número de palavras de cada estrofe.
 * Retorna no formato { text, startTime, endTime }[].
 */
function fallbackProportional(stanzas, totalDur) {
  const counts = stanzas.map(s => Math.max(extractWords(s.text).length, 1));
  const total  = counts.reduce((a, c) => a + c, 0);
  const GAP    = Math.min(0.3, totalDur / (stanzas.length * 6));
  const avail  = Math.max(1, totalDur - GAP * (stanzas.length - 1));

  let cursor = 0;
  return stanzas.map((s, i) => {
    const dur   = avail * (counts[i] / total);
    const start = cursor;
    const end   = Math.min(totalDur, start + dur);
    cursor = end + GAP;
    return { text: s.text, startTime: start, endTime: end };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 5 — CONVERSÃO DE FORMATOS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Converte o formato simples [{text, startTime, endTime}]
 * para o formato esperado pelo /voice-sync:
 *   [{ start, end, lines:[{start, end, text}] }]
 *
 * Cada linha dentro da estrofe recebe timestamps interpolados
 * proporcionalmente ao número de palavras.
 */
function toLineLevelFormat(synced, stanzas, totalDur) {
  return synced.map((seg, i) => {
    const stanzaText = stanzas[i]?.text || seg.text || '';
    const lines      = splitLines(stanzaText);
    const start      = Math.max(0, seg.startTime);
    const end        = Math.min(totalDur, seg.endTime);
    const duration   = Math.max(0.1, end - start);

    if (lines.length === 0) {
      return { start, end, lines: [] };
    }

    // Pesa cada linha pelo número de palavras
    const weights   = lines.map(l => Math.max(extractWords(l).length, 1));
    const totalW    = weights.reduce((a, w) => a + w, 0);
    const LINE_GAP  = Math.min(0.1, duration / (lines.length * 8));
    const available = Math.max(0.1, duration - LINE_GAP * (lines.length - 1));

    let cursor    = start;
    const lineSegs = lines.map((lineText, li) => {
      const dur     = available * (weights[li] / totalW);
      const lineStart = cursor;
      const lineEnd   = Math.min(end, lineStart + dur);
      cursor = lineEnd + LINE_GAP;
      return { start: lineStart, end: lineEnd, text: lineText };
    });

    return { start, end, lines: lineSegs };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 6 — EXPORTAÇÕES PÚBLICAS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * syncStanzasWithWhisper
 * ──────────────────────
 * Sincroniza estrofes com o áudio usando Whisper + Fuzzy Block Matching.
 *
 * @param {string} audioUrl  URL pública do áudio
 * @param {Array}  stanzas   [{ id, text }]
 * @param {Object} opts      { forceOriginalOnly?, instrumentalUrl? }
 * @returns {Promise<Array>} [{ start, end, lines:[{start,end,text}] }]
 */
export async function syncStanzasWithWhisper(audioUrl, stanzas, opts = {}) {
  const files   = [];
  const cleanup = () => {
    for (const f of files)
      if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
  };

  try {
    const rawPath  = await downloadToTemp(audioUrl);
    files.push(rawPath);
    const totalDur = await getAudioDuration(rawPath);

    // ── Whisper + Fuzzy Block Matching ────────────────────────────────────────
    if (process.env.OPENAI_API_KEY) {
      try {
        const words = await transcribeWithWhisper(rawPath);
        console.log(`[voiceSync] Whisper: ${words.length} palavras transcritas`);

        if (words.length > 0) {
          const rawMatches = fuzzyMatchStanzas(stanzas, words);
          const filled     = fillNullMatches(rawMatches, stanzas, totalDur);
          const result     = toLineLevelFormat(filled, stanzas, totalDur);
          console.log('[voiceSync] ✅ Fuzzy Block Matching concluído');
          return result;
        }
      } catch (whisperErr) {
        console.warn('[voiceSync] Whisper falhou:', whisperErr.message);
      }
    } else {
      console.log('[voiceSync] OPENAI_API_KEY não definida — usando fallback silence-detect');
    }

    // ── Fallback 3: silence-detect ────────────────────────────────────────────
    const silResult = await fallbackSilenceDetect(rawPath, totalDur, stanzas);
    if (silResult) {
      console.log('[voiceSync] ✅ Fallback: silence-detect');
      return toLineLevelFormat(silResult, stanzas, totalDur);
    }

    // ── Fallback 4: proporcional ──────────────────────────────────────────────
    console.log('[voiceSync] ✅ Fallback: distribuição proporcional');
    const propResult = fallbackProportional(stanzas, totalDur || 180);
    return toLineLevelFormat(propResult, stanzas, totalDur || 180);

  } finally {
    cleanup();
  }
}

/**
 * syncStanzasWithWhisperAnchors
 * ──────────────────────────────
 * Versão que retorna o formato simples por estrofe (sem subdivisão em linhas).
 * Usa o mesmo Fuzzy Block Matching internamente.
 *
 * @param {string} audioUrl  URL pública do áudio
 * @param {Array}  stanzas   [{ id?, text }]
 * @param {Object} opts      { respectOrder? }
 * @returns {Promise<Array>} [{ text, startTime, endTime }]
 */
export async function syncStanzasWithWhisperAnchors(audioUrl, stanzas, opts = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não definida — necessário para Whisper');
  }

  const files   = [];
  const cleanup = () => {
    for (const f of files)
      if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
  };

  try {
    const rawPath  = await downloadToTemp(audioUrl);
    files.push(rawPath);
    const totalDur = await getAudioDuration(rawPath);

    const words = await transcribeWithWhisper(rawPath);
    console.log(`[voiceSync/anchors] Whisper: ${words.length} palavras`);

    if (!words.length) return [];

    const rawMatches = fuzzyMatchStanzas(stanzas, words);
    const filled     = fillNullMatches(rawMatches, stanzas, totalDur);

    // Retorna só o formato simples (text, startTime, endTime)
    return filled.map(m => ({
      text:      m.text,
      startTime: m.startTime,
      endTime:   m.endTime
    }));

  } finally {
    cleanup();
  }
}

/**
 * chooseBestAudioCandidateByLyrics
 * ─────────────────────────────────
 * Dentre vários áudios candidatos, escolhe aquele que melhor cobre a letra.
 * Útil quando o usuário pode ter enviado original/instrumental invertidos.
 *
 * Estratégia:
 *  1) Para cada candidato: transcription rápida (snippet) com Whisper
 *  2) Mede cobertura das palavras da letra com fuzzy block matching
 *  3) Retorna o candidato com maior score
 *
 * @param {string[]} audioUrls  URLs candidatas
 * @param {Array}    stanzas    [{ id?, text }]
 * @param {Object}   opts       { snippetStartSec?, snippetDurationSec?, maxLyricsWords? }
 * @returns {Promise<{bestUrl, bestIndex, ranking}>}
 */
export async function chooseBestAudioCandidateByLyrics(audioUrls, stanzas, opts = {}) {
  const {
    snippetStartSec    = 20,
    snippetDurationSec = 60
  } = opts;

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não definida — necessário para auto-seleção via Whisper');
  }

  const candidates = (audioUrls || []).filter(Boolean);
  if (candidates.length === 0) throw new Error('audioUrls vazio');

  const results = [];

  for (let i = 0; i < candidates.length; i++) {
    const url     = candidates[i];
    const files   = [];
    const cleanup = () => {
      for (const f of files)
        if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
    };

    try {
      const local = await downloadToTemp(url);
      files.push(local);

      // Extrai snippet do áudio para não gastar Whisper no arquivo inteiro
      const snip  = await makeAudioSnippet(local, snippetStartSec, snippetDurationSec);
      files.push(snip);

      const words = await transcribeWithWhisper(snip);

      // Usa fuzzy matching para calcular cobertura
      const matches = fuzzyMatchStanzas(stanzas, words);
      const matched = matches.filter(m => m !== null).length;
      const score   = (matched / Math.max(stanzas.length, 1)) * 1000
                    + Math.min(words.length, 300) * 0.5;

      results.push({
        index: i,
        url,
        score,
        coverage:     matched / Math.max(stanzas.length, 1),
        matched,
        stanzaCount:  stanzas.length,
        whisperCount: words.length
      });
    } catch (err) {
      results.push({
        index: i,
        url,
        score: -1,
        coverage: 0,
        matched: 0,
        stanzaCount: stanzas.length,
        whisperCount: 0,
        error: err.message
      });
    } finally {
      cleanup();
    }
  }

  results.sort((a, b) => b.score - a.score);

  const best = results[0];
  return {
    bestUrl:   best?.url,
    bestIndex: best?.index,
    ranking:   results
  };
}

// ── Compat retrocompatível ────────────────────────────────────────────────────
export async function detectVoiceSegments(audioUrl, stanzaCount) {
  const dummy = Array.from({ length: stanzaCount }, (_, i) => ({ id: i, text: '' }));
  return syncStanzasWithWhisper(audioUrl, dummy);
}

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 7 — UTILITÁRIOS INTERNOS AUXILIARES
// ═════════════════════════════════════════════════════════════════════════════

/** Gera um snippet de áudio para score rápido sem transcrever o arquivo inteiro */
function makeAudioSnippet(inputPath, startSec = 0, durationSec = 60) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `lena_snip_${Date.now()}.mp3`);
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .duration(durationSec)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .toFormat('mp3')
      .on('end',   () => resolve(output))
      .on('error', reject)
      .save(output);
  });
}
