/**
 * voiceSync.js  —  v6 (Beam Search + Fuzzy Matching Robusto)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sincroniza automaticamente as estrofes da letra com a música usando:
 *
 *   ETAPA 1 — Whisper API (word-level timestamps)
 *     • Transcreve o áudio com OpenAI Whisper (verbose_json + word timestamps)
 *     • Cada palavra transcrita tem { word, start, end }
 *
 *   ETAPA 2 — Beam Search Fuzzy Matching (v6)
 *     • Para cada estrofe gera TOP-K candidatos sobre o áudio COMPLETO
 *       usando Inverted Index para eficiência (O(n) por estrofe)
 *     • Similaridade melhorada: F1 token + bigram order + anchor bonus
 *       + edit distance suave para erros de transcrição
 *     • Beam Search global (largura=5): seleciona a sequência de matches
 *       com melhor combinação de similaridade + consistência temporal
 *     • Cursor flexível: sem bloqueio rígido — penalidade suave por distância
 *     • Penaliza sobreposição e gaps muito grandes entre estrofes
 *     • Detecta "palavras âncora" (raras, alta confiança) para guiar o alinhamento
 *     • Fallback inteligente: janela maior → threshold reduzido → null
 *
 *   FALLBACKS (sem API key ou Whisper falhar):
 *     CAMADA 3 — FFmpeg silence-detect (detecta segmentos de fala)
 *     CAMADA 4 — Distribuição proporcional por nº de palavras
 *
 * ─── Exports públicos ───────────────────────────────────────────────────────
 *
 *  syncStanzasWithWhisper(audioUrl, stanzas, opts?)
 *    → Promise<[{ start, end, lines:[{start,end,text}] }]>
 *
 *  syncStanzasWithWhisperAnchors(audioUrl, stanzas, opts?)
 *    → Promise<[{ text, startTime, endTime }]>
 *
 *  chooseBestAudioCandidateByLyrics(audioUrls, stanzas, opts?)
 *    → Promise<{ bestUrl, bestIndex, ranking }>
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
import { spawn } from 'child_process';

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

/**
 * Remove repetições consecutivas (p/ reduzir "vocal sustentado" / stutter).
 */
function removeConsecutiveDuplicates(words) {
  const out = [];
  for (const w of words || []) {
    if (!w) continue;
    if (out.length === 0 || out[out.length - 1] !== w) out.push(w);
  }
  return out;
}

/** Divide texto de estrofe em linhas (sem vazias) */
function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 2 — FUZZY MATCHING DE BLOCOS (v6 — Beam Search)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * fuzzyMatchStanzas  —  v6
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Algoritmo refatorado com:
 *  1. Geração de TOP-K candidatos por estrofe (busca no áudio inteiro via
 *     inverted index — eficiente)
 *  2. Scoring melhorado: F1 token + bigram order + anchor bonus + edit-distance suave
 *  3. Beam Search global (largura BEAM_WIDTH) para consistência temporal
 *  4. Penalidade suave por distância temporal (sem cursor rígido)
 *  5. Penalidade por sobreposição e grandes gaps
 *  6. Detecção de palavras âncora (raras + presentes no Whisper)
 *  7. Fallback por janela maior se score insuficiente
 *
 * @param {Array} stanzas      [{text}]
 * @param {Array} whisperWords [{word, start, end}]
 * @returns {Array} [{text, startIdx, endIdx, startTime, endTime, score}|null]
 */
function fuzzyMatchStanzas(stanzas, whisperWords) {

  // ── Configuração ──────────────────────────────────────────────────────────
  const BEAM_WIDTH      = 5;    // largura do beam search
  const TOP_K           = 6;    // candidatos por estrofe
  const MIN_SCORE       = 0.22; // score mínimo para aceitar um match
  const WINDOW_RATIO    = 1.15; // janela ~15% maior que a estrofe
  const WINDOW_FLEX     = 0.45; // ±45% de flexibilidade no tamanho
  const MIN_WINDOW      = 3;    // janela mínima em palavras
  const TEMPORAL_W      = 0.18; // peso da consistência temporal no beam score
  const ANCHOR_BONUS    = 0.14; // bônus por palavra âncora encontrada
  const OVERLAP_PENALTY = 0.28; // penalidade por sobreposição
  const GAP_PENALTY_MAX = 0.08; // penalidade máxima por gap muito longo
  const NULL_PENALTY    = 0.06; // penalidade por estrofe sem match

  const wNorm = whisperWords.map(w => normalizeWord(w.word));
  const total = wNorm.length;

  if (total === 0 || stanzas.length === 0) {
    return stanzas.map(() => null);
  }

  const totalDur = whisperWords[total - 1]?.end
    ?? whisperWords[total - 1]?.start
    ?? 0;

  // ── 1. Pré-computação dos dados por estrofe ───────────────────────────────

  const stanzaData = stanzas.map(stanza => {
    const text     = String(stanza.text || '');
    const wordsRaw = extractWordsAllowShort(text);
    const words    = removeConsecutiveDuplicates(wordsRaw);
    const wordSet  = new Set(words);
    const bigrams  = _makeBigramSet(words);
    return { text, words, wordSet, wordsRaw, bigrams };
  });

  // ── 2. Detecção de palavras âncora ───────────────────────────────────────
  // Âncoras = palavras raras na letra (≤ 2 ocorrências) que também estão
  // no Whisper — são pontos de alta confiança no alinhamento.

  const globalLyricFreq = new Map();
  for (const { words } of stanzaData) {
    for (const w of words) {
      globalLyricFreq.set(w, (globalLyricFreq.get(w) || 0) + 1);
    }
  }
  const whisperSet = new Set(wNorm);
  const anchorPool = new Set();
  for (const [word, freq] of globalLyricFreq) {
    if (freq <= 2 && word.length >= 4 && whisperSet.has(word)) {
      anchorPool.add(word);
    }
  }

  // Âncoras por estrofe
  const stanzaAnchors = stanzaData.map(({ words }) => {
    const a = new Set();
    for (const w of words) { if (anchorPool.has(w)) a.add(w); }
    return a;
  });

  // ── 3. Inverted index: palavra → [posições no Whisper] ───────────────────

  const invertedIndex = new Map();
  for (let i = 0; i < wNorm.length; i++) {
    const w = wNorm[i];
    if (!invertedIndex.has(w)) invertedIndex.set(w, []);
    invertedIndex.get(w).push(i);
  }

  // ── 4. Funções de scoring ─────────────────────────────────────────────────

  /** Edit distance com early-exit (custo O(la*lb), cap = máx. erros aceitos) */
  function _editDistanceCapped(a, b, cap) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > cap) return cap + 1;
    const row = Array.from({ length: lb + 1 }, (_, i) => i);
    for (let i = 1; i <= la; i++) {
      let prev = row[0];
      row[0] = i;
      let minRow = row[0];
      for (let j = 1; j <= lb; j++) {
        const tmp = row[j];
        row[j] = a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, row[j], row[j - 1]);
        prev = tmp;
        minRow = Math.min(minRow, row[j]);
      }
      if (minRow > cap) return cap + 1;
    }
    return row[lb];
  }

  /**
   * Similaridade suave entre duas palavras normalizadas.
   * Usa edit distance com pré-filtros para máxima eficiência.
   */
  function _wordSim(a, b) {
    if (a === b) return 1.0;
    if (a.length < 3 || b.length < 3) return 0;
    const lenDiff = Math.abs(a.length - b.length);
    if (lenDiff > 3) return 0;
    // Pré-filtro: pelo menos 1 dos 2 primeiros chars deve coincidir
    if (a[0] !== b[0] && a[0] !== b[1] && a[1] !== b[0]) return 0;
    const cap  = Math.min(2, Math.floor(Math.max(a.length, b.length) * 0.35));
    const dist = _editDistanceCapped(a, b, cap);
    if (dist > cap) return 0;
    return 1 - dist / Math.max(a.length, b.length);
  }

  /** Cria Set de bigramas "w1|w2" a partir de array de palavras */
  function _makeBigramSet(words) {
    const bg = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      bg.add(words[i] + '|' + words[i + 1]);
    }
    return bg;
  }

  /**
   * Score de uma janela em relação a uma estrofe.
   *
   * Componentes:
   *  - recall:    fração das palavras da estrofe presentes na janela (exato + fuzzy)
   *  - precision: fração das palavras da janela cobertas pela estrofe
   *  - f1:        média harmônica de recall e precision
   *  - bigram:    fração dos bigramas da estrofe presentes na janela
   *  - anchor:    fração das palavras âncora da estrofe encontradas na janela
   *
   * Combinação final:
   *   score = 0.50*f1 + 0.25*bigram + 0.15*recall + anchor_bonus
   */
  function _scoreWindow(sd, anchors, windowWords) {
    const { words: sWords, wordSet: sSet, bigrams: sBigrams } = sd;
    if (sWords.length === 0 || windowWords.length === 0) return 0;

    const windowSet  = new Set(windowWords);
    const wBigrams   = _makeBigramSet(windowWords);

    // ── Token matching (exact + fuzzy) ───────────────────────
    let matchedS = 0;            // stanza words matched
    const usedW  = new Set();    // window words already matched

    for (const sw of sWords) {
      if (sSet.has(sw) && windowSet.has(sw)) {
        // Exact match (fast path)
        matchedS++;
        usedW.add(sw);
      } else {
        // Fuzzy match
        let best = 0, bestW = null;
        for (const ww of windowWords) {
          if (usedW.has(ww)) continue;
          const sim = _wordSim(sw, ww);
          if (sim > best) { best = sim; bestW = ww; }
        }
        if (best >= 0.70) { matchedS++; if (bestW) usedW.add(bestW); }
      }
    }

    const recall    = matchedS / sWords.length;
    const precision = windowWords.length > 0 ? usedW.size / windowWords.length : 0;
    const f1 = (recall + precision > 0)
      ? 2 * recall * precision / (recall + precision)
      : 0;

    // ── Bigram order bonus ───────────────────────────────────
    let bgHits = 0;
    for (const bg of sBigrams) { if (wBigrams.has(bg)) bgHits++; }
    const bigramScore = sBigrams.size > 0 ? bgHits / sBigrams.size : 0;

    // ── Anchor bonus ─────────────────────────────────────────
    let anchorScore = 0;
    if (anchors && anchors.size > 0) {
      let hits = 0;
      for (const aw of anchors) { if (windowSet.has(aw)) hits++; }
      anchorScore = hits / anchors.size;
    }

    // ── Combinação final ─────────────────────────────────────
    let score = 0.50 * f1 + 0.25 * bigramScore + 0.15 * recall + 0.10 * precision;

    // Âncora: bônus aditivo
    if (anchorScore > 0) {
      score = Math.min(1.0, score + ANCHOR_BONUS * anchorScore);
    }

    // Penalidade suave por diferença de comprimento extrema
    const lenRatio = Math.min(sWords.length, windowWords.length)
                   / Math.max(sWords.length, windowWords.length);
    if (lenRatio < 0.45) score *= 0.65 + 0.35 * (lenRatio / 0.45);

    return Math.max(0, Math.min(1, score));
  }

  // ── 5. Geração de candidatos por estrofe ─────────────────────────────────

  /**
   * Gera os TOP-K candidatos de janela para uma estrofe.
   *
   * Usa inverted index para pré-filtrar posições onde pelo menos uma palavra
   * da estrofe aparece no Whisper — evita varrer o áudio inteiro.
   *
   * Fallback automático: se candidatos insuficientes, expande janela e
   * reduz threshold.
   */
  function _generateCandidates(stanzaIdx, sd, anchors, K) {
    if (sd.words.length === 0) return [];

    const winBase = Math.max(MIN_WINDOW,
      Math.round(sd.wordsRaw.length * WINDOW_RATIO));
    const winMin  = Math.max(MIN_WINDOW, Math.floor(winBase * (1 - WINDOW_FLEX)));
    const winMax  = Math.ceil(winBase * (1 + WINDOW_FLEX));

    // Posições candidatas via inverted index
    const candStarts = new Set();
    for (const w of sd.words) {
      for (const pos of (invertedIndex.get(w) || [])) {
        // A palavra pode estar em qualquer posição dentro da janela
        for (let s = Math.max(0, pos - winMax + 1); s <= pos; s++) {
          candStarts.add(s);
        }
      }
    }

    // Adiciona posições âncora com prioridade
    for (const aw of (anchors || [])) {
      for (const pos of (invertedIndex.get(aw) || [])) {
        for (let s = Math.max(0, pos - winMax + 1); s <= pos; s++) {
          candStarts.add(s);
        }
      }
    }

    // Fallback: se poucas posições, usa expected position + vizinhança
    if (candStarts.size < 5) {
      const exp = Math.floor((stanzaIdx / Math.max(1, stanzas.length - 1)) * total);
      const r   = Math.floor(total * 0.35);
      for (let p = Math.max(0, exp - r); p <= Math.min(total - winMin, exp + r); p++) {
        candStarts.add(p);
      }
    }

    const threshold = MIN_SCORE * 0.65; // threshold relaxado para candidatos
    const raw = [];

    for (const startPos of candStarts) {
      // Testa 3 tamanhos de janela: mínimo, base, máximo
      for (const w of [winMin, winBase, winMax]) {
        if (startPos + w > total) continue;
        const windowWordsRaw = wNorm.slice(startPos, startPos + w);
        const windowWords    = removeConsecutiveDuplicates(windowWordsRaw);
        const score = _scoreWindow(sd, anchors, windowWords);
        if (score >= threshold) {
          const startTime = whisperWords[startPos]?.start ?? 0;
          const endTime   = whisperWords[startPos + w - 1]?.end
            ?? whisperWords[startPos + w - 1]?.start
            ?? startTime;
          raw.push({ startIdx: startPos, endIdx: startPos + w - 1, startTime, endTime, score });
        }
      }
    }

    // ── Fallback inteligente: janela maior / threshold menor ─────────────────
    if (raw.filter(c => c.score >= MIN_SCORE).length < 2) {
      const bigWin  = Math.ceil(winMax * 1.5);
      const softThr = MIN_SCORE * 0.5;
      for (const startPos of candStarts) {
        if (startPos + bigWin > total) continue;
        const windowWords = removeConsecutiveDuplicates(wNorm.slice(startPos, startPos + bigWin));
        const score = _scoreWindow(sd, anchors, windowWords);
        if (score >= softThr) {
          const startTime = whisperWords[startPos]?.start ?? 0;
          const endTime   = whisperWords[startPos + bigWin - 1]?.end
            ?? whisperWords[startPos + bigWin - 1]?.start
            ?? startTime;
          raw.push({ startIdx: startPos, endIdx: startPos + bigWin - 1, startTime, endTime, score });
        }
      }
    }

    // Ordenar por score desc
    raw.sort((a, b) => b.score - a.score);

    // Desduplicar: remove candidatos que cobrem ≥60% da mesma região
    const deduped = [];
    for (const c of raw) {
      let dup = false;
      for (const d of deduped) {
        const overS = Math.max(c.startIdx, d.startIdx);
        const overE = Math.min(c.endIdx,   d.endIdx);
        if (overE >= overS) {
          const overlapRatio = (overE - overS + 1) / (c.endIdx - c.startIdx + 1);
          if (overlapRatio >= 0.60) { dup = true; break; }
        }
      }
      if (!dup) deduped.push(c);
      if (deduped.length >= K * 2) break;
    }

    return deduped.slice(0, K);
  }

  // ── 6. Geração de candidatos para todas as estrofes ───────────────────────

  console.log('[voiceSync] v6: gerando candidatos via inverted index...');
  const allCandidates = stanzaData.map((sd, idx) =>
    _generateCandidates(idx, sd, stanzaAnchors[idx], TOP_K)
  );

  // ── 7. Beam Search global ─────────────────────────────────────────────────
  //
  // Estado de cada beam:
  //   assignments: Array<candidato|null>   (um elemento por estrofe)
  //   lastEndIdx:  índice da última palavra usada
  //   lastEndTime: tempo final da última estrofe matched
  //   score:       score acumulado do beam
  //
  // Expansão: para cada estrofe, cada beam tenta cada candidato (com
  // penalidades temporais) + opção null.
  // Poda: mantém apenas BEAM_WIDTH beams de maior score.

  /** Calcula score de um candidato numa transição de beam */
  function _transitionScore(beam, cand, stanzaIdx) {
    // Hard constraint: não pode voltar muito no tempo (tolerância de 1 s)
    if (cand.startTime < beam.lastEndTime - 1.0) return null; // inválido

    // Consistência temporal: esperamos progressão suave
    const expectedFraction = stanzaIdx / Math.max(1, stanzas.length - 1);
    const actualFraction   = totalDur > 0 ? cand.startTime / totalDur : 0;
    const timeDelta        = Math.abs(actualFraction - expectedFraction);
    const temporalBonus    = Math.max(0, 1 - timeDelta * 2.0);

    // Penalidade por sobreposição com a estrofe anterior
    const overlap = beam.lastEndIdx >= 0 && cand.startIdx <= beam.lastEndIdx
      ? OVERLAP_PENALTY
      : 0;

    // Penalidade por gap muito longo (> 30s sem letra)
    const gap = cand.startTime - beam.lastEndTime;
    const gapPenalty = gap > 30
      ? GAP_PENALTY_MAX * Math.min(1, (gap - 30) / 60)
      : 0;

    return cand.score * (1 + TEMPORAL_W * temporalBonus) - overlap - gapPenalty;
  }

  // Inicializa beam
  let beams = [{
    assignments: [],
    lastEndIdx:  -1,
    lastEndTime: 0,
    score:       0
  }];

  for (let si = 0; si < stanzas.length; si++) {
    const candidates = allCandidates[si];
    const newBeams   = [];

    for (const beam of beams) {
      // Opção A: atribuir um candidato a esta estrofe
      for (const cand of candidates) {
        const ts = _transitionScore(beam, cand, si);
        if (ts === null) continue; // hard constraint violada

        newBeams.push({
          assignments: [...beam.assignments, { ...cand }],
          lastEndIdx:  cand.endIdx,
          lastEndTime: cand.endTime,
          score:       beam.score + ts
        });
      }

      // Opção B: estrofe sem match (null)
      newBeams.push({
        assignments: [...beam.assignments, null],
        lastEndIdx:  beam.lastEndIdx,
        lastEndTime: beam.lastEndTime,
        score:       beam.score - NULL_PENALTY
      });
    }

    // Poda: mantém TOP BEAM_WIDTH
    newBeams.sort((a, b) => b.score - a.score);
    beams = newBeams.slice(0, BEAM_WIDTH);
  }

  // ── 8. Resultado do melhor beam ──────────────────────────────────────────

  const bestBeam = beams[0];

  return bestBeam.assignments.map((match, i) => {
    if (!match || match.score < MIN_SCORE) {
      console.log(
        `[voiceSync] v6: estrofe sem match (score=${match ? match.score.toFixed(3) : 'null'}): ` +
        `"${String(stanzas[i]?.text || '').slice(0, 40)}..."`
      );
      return null;
    }

    const stanzaText = String(stanzas[i]?.text || '');
    return {
      text:      stanzaText,
      startIdx:  match.startIdx,
      endIdx:    match.endIdx,
      startTime: Math.max(0, match.startTime - 0.05),
      endTime:   match.endTime + 0.10,
      score:     match.score,
      rawScore:  match.score
    };
  });
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

function isWhisperXEnabled() {
  const v = String(process.env.WHISPERX_ENABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Seleciona a fonte de timestamps por palavra.
 * Prioridade:
 *  1) WhisperX (local) se WHISPERX_ENABLED=1
 *  2) OpenAI Whisper API se OPENAI_API_KEY existe
 */
async function getWordTimestamps(localAudioPath) {
  if (isWhisperXEnabled()) {
    const words = await transcribeWithWhisperX(localAudioPath);
    return { words, engine: 'whisperx' };
  }

  if (process.env.OPENAI_API_KEY) {
    const words = await transcribeWithWhisper(localAudioPath);
    return { words, engine: 'openai-whisper' };
  }

  return { words: [], engine: 'none' };
}


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

/**
 * Converte áudio para WAV mono 16kHz (mais estável para WhisperX).
 */
function convertToWav16kMono(inputPath) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `lena_wx_${Date.now()}.wav`);
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .toFormat('wav')
      .on('end',   () => resolve(output))
      .on('error', reject)
      .save(output);
  });
}

/**
 * Executa WhisperX via Python e retorna words com timestamps.
 *
 * Requer:
 *  - python3
 *  - pip install whisperx (e deps)
 *
 * Env:
 *  - WHISPERX_ENABLED=1
 *  - WHISPERX_MODEL=small|medium|large-v2...
 *  - WHISPERX_DEVICE=cpu|cuda
 *  - WHISPERX_LANGUAGE=pt (opcional)
 */
async function transcribeWithWhisperX(localAudioPath) {
  const pythonBin  = process.env.WHISPERX_PYTHON || 'python3';
  const scriptPath = process.env.WHISPERX_SCRIPT
    || path.join(process.cwd(), 'scripts', 'whisperx_transcribe.py');

  const wavPath = await convertToWav16kMono(localAudioPath);

  try {
    const args = [scriptPath, '--audio', wavPath];

    const out = await new Promise((resolve, reject) => {
      const child = spawn(pythonBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`WhisperX falhou (code=${code}). ${stderr || ''}`.trim()));
        }
        resolve({ stdout, stderr });
      });
    });

    const json = JSON.parse(out.stdout);
    return json.words || [];

  } finally {
    try { fs.unlinkSync(wavPath); } catch (_) {}
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

  while (s.length > target) {
    let minGap = Infinity, minIdx = 0;
    for (let i = 0; i < s.length - 1; i++) {
      const g = s[i + 1].start - s[i].end;
      if (g < minGap) { minGap = g; minIdx = i; }
    }
    s.splice(minIdx, 2, { start: s[minIdx].start, end: s[minIdx + 1].end });
  }

  while (s.length < target) {
    let maxDur = 0, maxIdx = 0;
    for (let i = 0; i < s.length; i++) {
      const d = s[i].end - s[i].start;
      if (d > maxDur) { maxDur = d; maxIdx = i; }
    }
    const seg = s[maxIdx];
    const mid = (seg.start + seg.end) / 2;
    s.splice(maxIdx, 1,
      { start: seg.start,  end: mid - 0.1 },
      { start: mid + 0.1, end: seg.end    }
    );
  }

  return s;
}

/**
 * Fallback 3: distribui estrofes nos segmentos de fala detectados pelo FFmpeg.
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

    const weights   = lines.map(l => Math.max(extractWords(l).length, 1));
    const totalW    = weights.reduce((a, w) => a + w, 0);
    const LINE_GAP  = Math.min(0.1, duration / (lines.length * 8));
    const available = Math.max(0.1, duration - LINE_GAP * (lines.length - 1));

    let cursor    = start;
    const lineSegs = lines.map((lineText, li) => {
      const dur       = available * (weights[li] / totalW);
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
 * Sincroniza estrofes com o áudio usando Whisper + Beam Search Fuzzy Matching (v6).
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

    // ── Word timestamps + Beam Search Fuzzy Matching ─────────────────────────
    try {
      const { words, engine } = await getWordTimestamps(rawPath);
      if (words.length > 0) {
        console.log(`[voiceSync] ✅ ${engine}: ${words.length} palavras com timestamps`);
        const rawMatches = fuzzyMatchStanzas(stanzas, words);
        const filled     = fillNullMatches(rawMatches, stanzas, totalDur);
        const result     = toLineLevelFormat(filled, stanzas, totalDur);
        console.log('[voiceSync] ✅ Beam Search Fuzzy Matching v6 concluído');
        return result;
      }
      console.log(`[voiceSync] ⚠️ ${engine}: sem palavras — usando fallbacks`);
    } catch (tsErr) {
      console.warn('[voiceSync] Timestamps falharam:', tsErr.message);
    }

    if (!process.env.OPENAI_API_KEY && !isWhisperXEnabled()) {
      console.log('[voiceSync] OPENAI_API_KEY ausente e WHISPERX_ENABLED desativado — usando fallback silence-detect');
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
 *
 * @param {string} audioUrl  URL pública do áudio
 * @param {Array}  stanzas   [{ id?, text }]
 * @param {Object} opts      { respectOrder? }
 * @returns {Promise<Array>} [{ text, startTime, endTime }]
 */
export async function syncStanzasWithWhisperAnchors(audioUrl, stanzas, opts = {}) {
  if (!process.env.OPENAI_API_KEY && !isWhisperXEnabled()) {
    throw new Error('OPENAI_API_KEY não definida e WHISPERX_ENABLED desativado — necessário para gerar timestamps');
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

    const { words, engine } = await getWordTimestamps(rawPath);
    console.log(`[voiceSync/anchors] ${engine}: ${words.length} palavras`);

    if (!words.length) return [];

    const rawMatches = fuzzyMatchStanzas(stanzas, words);
    const filled     = fillNullMatches(rawMatches, stanzas, totalDur);

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
 *
 * @param {string[]} audioUrls  URLs candidatas
 * @param {Array}    stanzas    [{ id?, text }]
 * @param {Object}   opts       { snippetStartSec?, snippetDurationSec? }
 * @returns {Promise<{bestUrl, bestIndex, ranking}>}
 */
export async function chooseBestAudioCandidateByLyrics(audioUrls, stanzas, opts = {}) {
  const {
    snippetStartSec    = 20,
    snippetDurationSec = 60
  } = opts;

  if (!process.env.OPENAI_API_KEY && !isWhisperXEnabled()) {
    throw new Error('OPENAI_API_KEY não definida e WHISPERX_ENABLED desativado — necessário para auto-seleção');
  }

  const candidates = (audioUrls || []).filter(Boolean);
  if (candidates.length === 0) throw new Error('audioUrls vazio');

  const results = [];

  for (let i = 0; i < candidates.length; i++) {
    const url   = candidates[i];
    const files = [];
    const cleanup = () => {
      for (const f of files)
        if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
    };

    try {
      const local = await downloadToTemp(url);
      files.push(local);

      const snip = await makeAudioSnippet(local, snippetStartSec, snippetDurationSec);
      files.push(snip);

      const { words } = await getWordTimestamps(snip);

      const matches = fuzzyMatchStanzas(stanzas, words);
      const matched = matches.filter(m => m !== null).length;
      const score   = (matched / Math.max(stanzas.length, 1)) * 1000
                    + Math.min(words.length, 300) * 0.5;

      results.push({
        index: i, url, score,
        coverage:     matched / Math.max(stanzas.length, 1),
        matched,
        stanzaCount:  stanzas.length,
        whisperCount: words.length
      });
    } catch (err) {
      results.push({
        index: i, url, score: -1, coverage: 0, matched: 0,
        stanzaCount: stanzas.length, whisperCount: 0,
        error: err.message
      });
    } finally {
      cleanup();
    }
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  return { bestUrl: best?.url, bestIndex: best?.index, ranking: results };
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
