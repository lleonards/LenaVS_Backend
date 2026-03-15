/**
 * voiceSync.js  —  v2 (Whisper-based)
 * ─────────────────────────────────────────────────────────────────────────────
 * Sincroniza estrofes com o áudio original usando OpenAI Whisper API.
 *
 * Estratégia em 3 camadas (da mais precisa à mais robusta):
 *
 *   1. MATCH POR PALAVRAS  — transcreve o áudio, extrai palavras com timestamps
 *      e faz matching sequencial das palavras de cada estrofe na transcrição.
 *      Funciona muito bem quando a letra bate com o que foi cantado/gravado.
 *
 *   2. MATCH PROPORCIONAL (Whisper timeline) — se o matching de palavras falhar,
 *      usa a linha do tempo real detectada pelo Whisper (início/fim da fala)
 *      e distribui as estrofes proporcionalmente dentro dela.
 *      Elimina os problemas de intro/outro longo que afetavam o silence-detect.
 *
 *   3. FALLBACK LINEAR — se o Whisper falhar completamente, distribui as
 *      estrofes de forma uniforme pela duração total do áudio.
 *
 * Dependências: openai (npm package), fluent-ffmpeg, node-fetch nativo (Node 18+)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import ffmpeg from 'fluent-ffmpeg';

// ─── Inicializa cliente OpenAI ────────────────────────────────────────────────
// A chave é lida de process.env.OPENAI_API_KEY automaticamente
const openai = new OpenAI();

// ─── Normaliza uma palavra para comparação ───────────────────────────────────
function normalizeWord(word) {
  return String(word)
    .toLowerCase()
    .normalize('NFD')                        // decompõe acentos
    .replace(/[\u0300-\u036f]/g, '')         // remove diacríticos
    .replace(/[^\w]/g, '');                  // remove pontuação
}

// ─── Extrai lista de palavras normalizadas de um texto ───────────────────────
function extractWords(text) {
  return String(text)
    .split(/\s+/)
    .map(normalizeWord)
    .filter(w => w.length > 1);
}

// ─── Baixa o áudio para arquivo temporário ───────────────────────────────────
function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const ext  = path.extname(new URL(url).pathname) || '.mp3';
    const dest = path.join(os.tmpdir(), `lena_whisper_${Date.now()}${ext}`);
    const file = fs.createWriteStream(dest);
    const prot = url.startsWith('https') ? https : http;

    prot.get(url, (resp) => {
      if (resp.statusCode >= 400) {
        return reject(new Error(`HTTP ${resp.statusCode} ao baixar áudio`));
      }
      resp.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', reject);
  });
}

// ─── Obtém duração total via ffprobe ─────────────────────────────────────────
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });
}

// ─── Converte áudio para mp3 mono 16kHz (menor → mais rápido no Whisper) ─────
function convertToMp3(inputPath) {
  return new Promise((resolve, reject) => {
    const output = inputPath.replace(/\.[^.]+$/, '_converted.mp3');
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
// CAMADA 1: matching sequencial de palavras
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Para cada estrofe, tenta encontrar suas palavras na lista de palavras
 * transcritas pelo Whisper de forma sequencial (não repete posições já usadas).
 *
 * whisperWords: [ { word, start, end }, ... ]
 * stanzas:      [ { text, ... }, ... ]
 *
 * Retorna: [ { start, end } | null, ... ]
 *   null  →  estrofe não teve match suficiente (será tratado pela Camada 2)
 */
function matchByWords(stanzas, whisperWords) {
  if (!whisperWords || whisperWords.length === 0) return null;

  const ww = whisperWords.map(w => ({ ...w, norm: normalizeWord(w.word) }));
  const results = [];
  let searchCursor = 0; // posição a partir de onde buscar na próxima estrofe

  for (const stanza of stanzas) {
    const sw = extractWords(stanza.text);

    if (sw.length === 0) {
      results.push(null);
      continue;
    }

    // Tamanho da janela de busca: no máximo 4x as palavras da estrofe + 30
    const windowSize = Math.min(
      ww.length - searchCursor,
      sw.length * 4 + 30
    );

    let bestScore  = 0;
    let bestWStart = searchCursor;
    let bestWEnd   = searchCursor;

    for (let j = searchCursor; j < searchCursor + windowSize; j++) {
      let matched = 0;
      let k = j;

      for (let m = 0; m < sw.length && k < ww.length; m++) {
        // Aceita: igual, contém, ou substring com ≥3 chars em comum
        const look = Math.min(k + 3, ww.length);
        let found = false;
        for (let l = k; l < look; l++) {
          const wn = ww[l].norm;
          const sn = sw[m];
          if (wn === sn || wn.includes(sn) || sn.includes(wn)) {
            matched++;
            k = l + 1;
            found = true;
            break;
          }
        }
        if (!found) k++;
      }

      const score = matched / sw.length;
      if (score > bestScore) {
        bestScore  = score;
        bestWStart = j;
        bestWEnd   = Math.max(j, k - 1);
      }
      if (bestScore >= 0.65) break; // suficientemente bom
    }

    const MATCH_THRESHOLD = 0.25; // mínimo aceitável
    if (bestScore >= MATCH_THRESHOLD && bestWEnd < ww.length) {
      results.push({
        start: ww[bestWStart].start,
        end:   ww[Math.min(bestWEnd, ww.length - 1)].end
      });
      searchCursor = bestWEnd + 1;
    } else {
      results.push(null);
    }
  }

  // Verifica se há resultados suficientes para ser útil
  const matched = results.filter(r => r !== null).length;
  if (matched < stanzas.length * 0.4) return null; // <40% → não foi bom

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 2: distribuição proporcional dentro da timeline do Whisper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Usa o início/fim da fala detectada pelo Whisper como "timeline ativa"
 * e distribui as estrofes proporcionalmente (por número de palavras) dentro dela.
 *
 * Muito melhor que silence-detect porque ignora intro/outro/silence corretamente.
 */
function matchProportional(stanzas, whisperWords) {
  if (!whisperWords || whisperWords.length === 0) return null;

  const activeStart = whisperWords[0].start;
  const activeEnd   = whisperWords[whisperWords.length - 1].end;
  const duration    = activeEnd - activeStart;

  if (duration < 1) return null;

  const wordCounts  = stanzas.map(s => Math.max(extractWords(s.text).length, 1));
  const totalWords  = wordCounts.reduce((a, b) => a + b, 0);
  const GAP         = Math.min(0.25, duration / (stanzas.length * 10));

  let cursor = activeStart;
  const totalGap = GAP * (stanzas.length - 1);
  const availableDuration = duration - totalGap;

  return stanzas.map((_, i) => {
    const proportion = wordCounts[i] / totalWords;
    const stanzaDur  = availableDuration * proportion;
    const start      = cursor;
    const end        = Math.min(activeEnd, cursor + stanzaDur);
    cursor           = end + GAP;
    return { start, end };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMADA 3: fallback linear (sem Whisper)
// ─────────────────────────────────────────────────────────────────────────────
function matchLinear(stanzas, totalDuration) {
  const GAP      = 0.25;
  const stanzaDur = Math.max(1, (totalDuration - GAP * (stanzas.length - 1)) / stanzas.length);
  let cursor = 0;

  return stanzas.map(() => {
    const start = cursor;
    const end   = Math.min(totalDuration, cursor + stanzaDur);
    cursor      = end + GAP;
    return { start, end };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PREENCHE nulls interpolando entre os resultados válidos
// ─────────────────────────────────────────────────────────────────────────────
function fillNulls(results, totalDuration) {
  const filled = [...results];
  const n = filled.length;

  // Passa 1: interpola entre vizinhos conhecidos
  for (let i = 0; i < n; i++) {
    if (filled[i] !== null) continue;

    // Acha vizinho anterior e posterior válidos
    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) { if (filled[j]) { prev = { seg: filled[j], idx: j }; break; } }
    for (let j = i + 1; j <  n; j++) { if (filled[j]) { next = { seg: filled[j], idx: j }; break; } }

    if (prev && next) {
      // Interpola linearmente no gap entre prev.end e next.start
      const gap       = next.seg.start - prev.seg.end;
      const slots     = next.idx - prev.idx;
      const slotSize  = gap / slots;
      const slot      = i - prev.idx;
      filled[i] = {
        start: prev.seg.end + slotSize * (slot - 1) + 0.1,
        end:   prev.seg.end + slotSize * slot
      };
    } else if (prev) {
      const slotSize = (totalDuration - prev.seg.end) / (n - prev.idx);
      const slot     = i - prev.idx;
      filled[i] = {
        start: prev.seg.end + slotSize * (slot - 1) + 0.1,
        end:   prev.seg.end + slotSize * slot
      };
    } else if (next) {
      const slotSize = next.seg.start / (next.idx + 1);
      filled[i] = {
        start: slotSize * i,
        end:   slotSize * (i + 1) - 0.1
      };
    }
  }

  // Garante que nenhum segmento está fora dos limites
  return filled.map(seg => seg ? {
    start: Math.max(0, seg.start),
    end:   Math.min(totalDuration, seg.end)
  } : { start: 0, end: totalDuration / filled.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// API PÚBLICA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * syncStanzasWithWhisper(audioUrl, stanzas)
 *
 * @param {string}   audioUrl  URL pública do áudio original
 * @param {Array}    stanzas   Array de { id, text, ... }
 * @returns {Array}            Array de { start, end } em segundos
 */
export async function syncStanzasWithWhisper(audioUrl, stanzas) {
  let tempRaw       = null;
  let tempConverted = null;

  try {
    // ── 1. Baixa e converte para mp3 leve ──────────────────────────
    tempRaw       = await downloadToTemp(audioUrl);
    tempConverted = await convertToMp3(tempRaw);

    const totalDuration = await getAudioDuration(tempRaw);

    // ── 2. Transcreve com Whisper ───────────────────────────────────
    let whisperWords = null;

    try {
      const transcription = await openai.audio.transcriptions.create({
        file:                     fs.createReadStream(tempConverted),
        model:                    'whisper-1',
        response_format:          'verbose_json',
        timestamp_granularities:  ['word']
      });

      whisperWords = transcription.words || [];
      console.log(`[voiceSync] Whisper: ${whisperWords.length} palavras transcritas`);
    } catch (whisperErr) {
      console.warn('[voiceSync] Whisper falhou:', whisperErr.message);
    }

    // ── 3. Tenta Camada 1: matching por palavras ────────────────────
    if (whisperWords && whisperWords.length > 0) {
      const wordMatch = matchByWords(stanzas, whisperWords);
      if (wordMatch) {
        console.log('[voiceSync] Usando: matching por palavras (Whisper)');
        const filled = fillNulls(wordMatch, totalDuration);
        return filled;
      }

      // ── 4. Tenta Camada 2: proporcional na timeline do Whisper ─────
      const propMatch = matchProportional(stanzas, whisperWords);
      if (propMatch) {
        console.log('[voiceSync] Usando: proporcional na timeline Whisper');
        return propMatch;
      }
    }

    // ── 5. Camada 3: fallback linear ────────────────────────────────
    console.log('[voiceSync] Usando: distribuição linear (fallback)');
    return matchLinear(stanzas, totalDuration || 180);

  } finally {
    for (const f of [tempRaw, tempConverted]) {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
  }
}

// ── Mantém compatibilidade com o controller antigo ───────────────────────────
export async function detectVoiceSegments(audioUrl, stanzaCount) {
  const fakStanzas = Array.from({ length: stanzaCount }, (_, i) => ({ id: i, text: '' }));
  return syncStanzasWithWhisper(audioUrl, fakStanzas);
}
