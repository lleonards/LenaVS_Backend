/**
 * voiceSync.js  -  v8 (Alinhamento Sequencial Robusto por Janela Temporal)
 * -----------------------------------------------------------------------------
 *
 * Sincroniza automaticamente as estrofes da letra com a m�sica usando:
 *
 *   ETAPA 1 � Whisper API (word-level timestamps)
 *     � Transcreve o �udio com OpenAI Whisper (verbose_json + word timestamps)
 *     � Cada palavra transcrita tem { word, start, end }
 *
 *   ETAPA 2 � Alinhamento Sequencial Robusto por Janela Temporal (v8)
 *     � Para cada estrofe gera TOP-K candidatos sobre o �udio COMPLETO
 *       usando Inverted Index para efici�ncia (O(n) por estrofe)
 *     � Similaridade melhorada: F1 token + bigram order + anchor bonus
 *       + edit distance suave para erros de transcri��o
 *     � Beam Search global (largura=5): seleciona a sequ�ncia de matches
 *       com melhor combina��o de similaridade + consist�ncia temporal
 *     � Cursor flex�vel: sem bloqueio r�gido � penalidade suave por dist�ncia
 *     � Penaliza sobreposi��o e gaps muito grandes entre estrofes
 *     � Detecta "palavras �ncora" (raras, alta confian�a) para guiar o alinhamento
 *     � Fallback inteligente: janela maior ? threshold reduzido ? null
 *
 *   FALLBACKS (sem API key ou Whisper falhar):
 *     CAMADA 3 � FFmpeg silence-detect (detecta segmentos de fala)
 *     CAMADA 4 � Distribui��o proporcional por n� de palavras
 *
 * --- Exports p�blicos -------------------------------------------------------
 *
 *  syncStanzasWithWhisper(audioUrl, stanzas, opts?)
 *    ? Promise<[{ start, end, lines:[{start,end,text}] }]>
 *
 *  syncStanzasWithWhisperAnchors(audioUrl, stanzas, opts?)
 *    ? Promise<[{ text, startTime, endTime }]>
 *
 *  chooseBestAudioCandidateByLyrics(audioUrls, stanzas, opts?)
 *    ? Promise<{ bestUrl, bestIndex, ranking }>
 *
 * Requer: openai, fluent-ffmpeg
 * Env:    OPENAI_API_KEY (opcional � fallback sem API)
 * -----------------------------------------------------------------------------
 */

import OpenAI  from 'openai';
import fs      from 'fs';
import path    from 'path';
import os      from 'os';
import https   from 'https';
import http    from 'http';
import ffmpeg  from 'fluent-ffmpeg';
import { spawn } from 'child_process';

// -----------------------------------------------------------------------------
// SE��O 1 � HELPERS DE TEXTO
// -----------------------------------------------------------------------------

/** Normaliza uma palavra: lowercase, sem acento, s� alfanum�rico */
function normalizeWord(w) {
  return String(w || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w]/g, '');
}

/** Extrai lista de palavras normalizadas (m�n. 2 chars) */
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
 * Remove repeti��es consecutivas (p/ reduzir "vocal sustentado" / stutter).
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

// -----------------------------------------------------------------------------
// SE��O 2 � ALINHAMENTO SEQUENCIAL ROBUSTO (v8)
// -----------------------------------------------------------------------------

/**
 * fuzzyMatchStanzas  �  v6
 * -----------------------------------------------------------------------------
 *
 * Algoritmo refatorado com:
 *  1. Gera��o de TOP-K candidatos por estrofe (busca no �udio inteiro via
 *     inverted index � eficiente)
 *  2. Scoring melhorado: F1 token + bigram order + anchor bonus + edit-distance suave
 *  3. Beam Search global (largura BEAM_WIDTH) para consist�ncia temporal
 *  4. Penalidade suave por dist�ncia temporal (sem cursor r�gido)
 *  5. Penalidade por sobreposi��o e grandes gaps
 *  6. Detec��o de palavras �ncora (raras + presentes no Whisper)
 *  7. Fallback por janela maior se score insuficiente
 *
 * @param {Array} stanzas      [{text}]
 * @param {Array} whisperWords [{word, start, end}]
 * @returns {Array} [{text, startIdx, endIdx, startTime, endTime, score}|null]
 */
function fuzzyMatchStanzas(stanzas, whisperWords, opts = {}) {
  const cfg = {
    searchWindowSecMin: opts.searchWindowSecMin ?? 10,
    searchWindowSecMax: Math.min(28, opts.searchWindowSecMax ?? 22),
    fallbackExpansionSec: opts.fallbackExpansionSec ?? 5,
    minScoreCandidate: opts.minScoreCandidate ?? 0.30,
    minScoreAccept: opts.minScoreAccept ?? 0.56,
    minScoreAcceptRepeated: opts.minScoreAcceptRepeated ?? 0.64,
    minWindowWords: opts.minWindowWords ?? 3,
    maxCandidatesPerStanza: opts.maxCandidatesPerStanza ?? 14,
    maxStartStepWords: opts.maxStartStepWords ?? 2,
    maxCandidateDurationSec: opts.maxCandidateDurationSec ?? 22,
    minCandidateDurationSec: opts.minCandidateDurationSec ?? 0.55,
    overlapRejectRatio: opts.overlapRejectRatio ?? 0.28,
    overlapPenaltyWeight: opts.overlapPenaltyWeight ?? 0.62,
    timeDistancePenaltyWeight: opts.timeDistancePenaltyWeight ?? 0.22,
    anchorBonusWeight: opts.anchorBonusWeight ?? 0.10,
    densityWeight: opts.densityWeight ?? 0.07,
    durationPenaltyWeight: opts.durationPenaltyWeight ?? 0.20,
    repeatPenaltyWeight: opts.repeatPenaltyWeight ?? 0.34,
    gapPenaltyWeight: opts.gapPenaltyWeight ?? 0.10,
    transitionRewardWeight: opts.transitionRewardWeight ?? 0.08,
    minProgressSec: Math.max(0.70, opts.minProgressSec ?? 0.90),
    repeatMinGapSec: Math.max(6.0, opts.repeatMinGapSec ?? 8.0),
    similarRepeatExtraGapSec: Math.max(3.0, opts.similarRepeatExtraGapSec ?? 6.0),
    nullAdvanceBaseSec: opts.nullAdvanceBaseSec ?? 2.6,
    nullAdvancePerWordSec: opts.nullAdvancePerWordSec ?? 0.13,
    repeatedStanzaSimilarity: opts.repeatedStanzaSimilarity ?? 0.82,
    mergeUsedRegionGapSec: opts.mergeUsedRegionGapSec ?? 0.18,
    acceptPaddingStartSec: opts.acceptPaddingStartSec ?? 0.05,
    acceptPaddingEndSec: opts.acceptPaddingEndSec ?? 0.10,
    beamWidth: Math.max(2, Math.min(8, opts.beamWidth ?? 5)),
    beamBranchPerStanza: Math.max(2, Math.min(6, opts.beamBranchPerStanza ?? 4)),
    lookaheadDepth: Math.max(0, Math.min(3, opts.lookaheadDepth ?? 2)),
    lookaheadWeight: opts.lookaheadWeight ?? 0.18,
    avgSecPerWord: opts.avgSecPerWord ?? 0.38,
    minExpectedDurationSec: opts.minExpectedDurationSec ?? 0.95,
    maxExpectedDurationSec: opts.maxExpectedDurationSec ?? 14,
    durationToleranceMin: opts.durationToleranceMin ?? 0.52,
    durationToleranceMax: opts.durationToleranceMax ?? 1.95,
    debug: opts.debug === true
  };

  const normalizedWhisperWords = (whisperWords || []).map((w, idx) => ({
    idx,
    word: normalizeWord(w?.word),
    start: Number.isFinite(w?.start) ? w.start : 0,
    end: Number.isFinite(w?.end) ? w.end : (Number.isFinite(w?.start) ? w.start : 0)
  }));

  const totalDur = normalizedWhisperWords.length
    ? (normalizedWhisperWords[normalizedWhisperWords.length - 1]?.end
      ?? normalizedWhisperWords[normalizedWhisperWords.length - 1]?.start
      ?? 0)
    : 0;

  if (!stanzas?.length || normalizedWhisperWords.length === 0) {
    const empty = (stanzas || []).map(() => null);
    return opts.returnMeta
      ? { matches: empty, candidates: empty.map(() => []), totalDur, debug: [], usedRegions: [], metrics: {} }
      : empty;
  }

  const spokenWordIndexes = normalizedWhisperWords
    .filter((w) => w.word)
    .map((w) => w.idx);

  if (!spokenWordIndexes.length) {
    const empty = (stanzas || []).map(() => null);
    return opts.returnMeta
      ? { matches: empty, candidates: empty.map(() => []), totalDur, debug: [], usedRegions: [], metrics: {} }
      : empty;
  }

  const observedWordRate = totalDur > 0
    ? spokenWordIndexes.length / Math.max(totalDur, 1)
    : (1 / Math.max(cfg.avgSecPerWord, 0.01));
  const secPerWordObserved = observedWordRate > 0 ? (1 / observedWordRate) : cfg.avgSecPerWord;
  const blendedSecPerWord = clamp((cfg.avgSecPerWord * 0.55) + (secPerWordObserved * 0.45), 0.20, 0.85);

  const stanzaData = stanzas.map((stanza, idx) => {
    const text = String(stanza?.text || '');
    const wordsRaw = extractWordsAllowShort(text);
    const words = removeConsecutiveDuplicates(wordsRaw);
    const wordSet = new Set(words);
    const bigrams = new Set();
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.add(`${words[i]}|${words[i + 1]}`);
    }

    const expectedDuration = clamp(
      Math.max(wordsRaw.length, 1) * blendedSecPerWord,
      cfg.minExpectedDurationSec,
      cfg.maxExpectedDurationSec
    );

    const minExpectedDuration = clamp(
      expectedDuration * cfg.durationToleranceMin,
      cfg.minCandidateDurationSec,
      cfg.maxCandidateDurationSec
    );

    const maxExpectedDuration = clamp(
      expectedDuration * cfg.durationToleranceMax,
      Math.max(cfg.minCandidateDurationSec + 0.25, minExpectedDuration + 0.25),
      cfg.maxCandidateDurationSec
    );

    return {
      index: idx,
      text,
      wordsRaw,
      words,
      wordSet,
      bigrams,
      signature: createStanzaSignature(text),
      expectedDuration,
      minExpectedDuration,
      maxExpectedDuration
    };
  });

  const lyricFreq = new Map();
  for (const stanza of stanzaData) {
    for (const word of stanza.words) {
      lyricFreq.set(word, (lyricFreq.get(word) || 0) + 1);
    }
  }

  const whisperSet = new Set(normalizedWhisperWords.map((w) => w.word).filter(Boolean));
  const anchorPool = new Set();
  for (const [word, freq] of lyricFreq.entries()) {
    if (freq <= 2 && word.length >= 4 && whisperSet.has(word)) {
      anchorPool.add(word);
    }
  }

  const stanzaAnchors = stanzaData.map((stanza) => {
    const anchors = [];
    stanza.words.forEach((word, idx) => {
      if (anchorPool.has(word)) anchors.push({ word, lyricIndex: idx });
    });
    return anchors;
  });

  const invertedIndex = new Map();
  for (const item of normalizedWhisperWords) {
    if (!item.word) continue;
    if (!invertedIndex.has(item.word)) invertedIndex.set(item.word, []);
    invertedIndex.get(item.word).push(item.idx);
  }

  function _editDistanceCapped(a, b, cap) {
    const la = a.length;
    const lb = b.length;
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

  function _wordSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 3 || b.length < 3) return 0;
    if (Math.abs(a.length - b.length) > 2) return 0;
    const cap = Math.min(2, Math.floor(Math.max(a.length, b.length) * 0.34));
    const dist = _editDistanceCapped(a, b, cap);
    if (dist > cap) return 0;
    return 1 - (dist / Math.max(a.length, b.length));
  }

  function _tokenSetSimilarity(wordsA, wordsB) {
    const a = new Set(wordsA || []);
    const b = new Set(wordsB || []);
    if (!a.size || !b.size) return 0;
    let hit = 0;
    for (const word of a) {
      if (b.has(word)) hit += 1;
    }
    const precision = hit / a.size;
    const recall = hit / b.size;
    return (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  }

  function _isRepeatedLike(stanzaA, stanzaB) {
    if (!stanzaA || !stanzaB) return false;
    if (stanzaA.signature && stanzaB.signature && stanzaA.signature === stanzaB.signature) {
      return true;
    }
    if (stanzaA.words.length < 4 || stanzaB.words.length < 4) return false;
    return _tokenSetSimilarity(stanzaA.words, stanzaB.words) >= cfg.repeatedStanzaSimilarity;
  }

  function _getWindowWordIndexes(searchStartTime, searchEndTime) {
    const result = [];
    for (const item of normalizedWhisperWords) {
      if (!item.word) continue;
      const st = Number.isFinite(item.start) ? item.start : 0;
      const en = Number.isFinite(item.end) ? item.end : st;
      if (en < searchStartTime - 0.12) continue;
      if (st > searchEndTime + 0.12) continue;
      result.push(item.idx);
    }
    return result;
  }

  function _moveToValidWordIndex(startIdx, windowSet, maxIdx) {
    let idx = Math.max(0, startIdx);
    while (idx <= maxIdx) {
      if (windowSet.has(idx) && normalizedWhisperWords[idx]?.word) return idx;
      idx += 1;
    }
    return null;
  }

  function _findEndIdxByWordCount(startIdx, desiredWordCount, maxIdx) {
    let counted = 0;
    let endIdx = null;
    for (let idx = startIdx; idx <= maxIdx; idx++) {
      if (!normalizedWhisperWords[idx]?.word) continue;
      counted += 1;
      endIdx = idx;
      if (counted >= desiredWordCount) return endIdx;
    }
    return counted >= cfg.minWindowWords ? endIdx : null;
  }

  function _greedyTokenStats(lyricWords, windowWords) {
    if (!lyricWords.length || !windowWords.length) {
      return {
        matchedWeight: 0,
        matchedCount: 0,
        precision: 0,
        recall: 0,
        f1: 0
      };
    }

    const used = new Set();
    let matchedWeight = 0;
    let matchedCount = 0;

    for (const lyricWord of lyricWords) {
      let bestIdx = -1;
      let bestSim = 0;
      for (let j = 0; j < windowWords.length; j++) {
        if (used.has(j)) continue;
        const sim = _wordSim(lyricWord, windowWords[j]);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = j;
        }
      }
      if (bestIdx >= 0 && bestSim >= 0.72) {
        used.add(bestIdx);
        matchedWeight += bestSim;
        matchedCount += 1;
      }
    }

    const precision = matchedWeight / Math.max(1, windowWords.length);
    const recall = matchedWeight / Math.max(1, lyricWords.length);
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    return {
      matchedWeight,
      matchedCount,
      precision,
      recall,
      f1
    };
  }

  function _scoreWindow(stanza, anchors, windowWords, startTime, searchStartTime, searchEndTime) {
    const dedupedWindowWords = removeConsecutiveDuplicates(windowWords.filter(Boolean));
    const tokenStats = _greedyTokenStats(stanza.words, dedupedWindowWords);

    const windowBigrams = new Set();
    for (let i = 0; i < dedupedWindowWords.length - 1; i++) {
      windowBigrams.add(`${dedupedWindowWords[i]}|${dedupedWindowWords[i + 1]}`);
    }

    let bigramHits = 0;
    for (const bg of stanza.bigrams) {
      if (windowBigrams.has(bg)) bigramHits += 1;
    }
    const orderCoverage = stanza.bigrams.size > 0
      ? bigramHits / stanza.bigrams.size
      : tokenStats.recall;

    let anchorHits = 0;
    for (const anchor of anchors) {
      if (dedupedWindowWords.some((word) => _wordSim(anchor.word, word) >= 0.84)) {
        anchorHits += 1;
      }
    }
    const anchorCoverage = anchors.length > 0 ? anchorHits / anchors.length : 0;

    const coverageBalance = 1 - clamp(
      Math.abs(dedupedWindowWords.length - stanza.words.length) / Math.max(1, stanza.words.length),
      0,
      1
    );

    const density = clamp(
      Math.min(
        dedupedWindowWords.length / Math.max(1, stanza.words.length),
        stanza.words.length / Math.max(1, dedupedWindowWords.length || 1)
      ),
      0,
      1
    );

    const timeCloseness = 1 - clamp(
      (startTime - searchStartTime) / Math.max(0.001, searchEndTime - searchStartTime),
      0,
      1
    );

    const rawScore = clamp(
      tokenStats.f1 * 0.54
        + orderCoverage * 0.18
        + anchorCoverage * cfg.anchorBonusWeight
        + density * cfg.densityWeight
        + coverageBalance * 0.08,
      0,
      1
    );

    return {
      rawScore,
      lexicalCoverage: tokenStats.recall,
      precision: tokenStats.precision,
      orderCoverage,
      anchorCoverage,
      matchedCount: tokenStats.matchedCount,
      lenRatio: dedupedWindowWords.length / Math.max(1, stanza.words.length),
      density,
      timeCloseness
    };
  }

  function _cloneUsedRegions(usedRegions) {
    return (usedRegions || []).map((region) => ({ ...region }));
  }

  function _getSimilarAcceptedHistory(stanza, acceptedHistory) {
    return (acceptedHistory || []).filter((item) => _isRepeatedLike(item.stanza, stanza));
  }

  function _getRequiredRepeatGap(stanza, prevItem) {
    if (!stanza || !prevItem?.stanza) return cfg.repeatMinGapSec;
    const sameSignature = stanza.signature && prevItem.stanza.signature && stanza.signature === prevItem.stanza.signature;
    return sameSignature
      ? (cfg.repeatMinGapSec + cfg.similarRepeatExtraGapSec)
      : cfg.repeatMinGapSec;
  }

  function _getDynamicWindowSec(stanza) {
    const expected = stanza?.expectedDuration || cfg.searchWindowSecMin;
    return clamp(
      (expected * 2.6) + 4,
      cfg.searchWindowSecMin,
      cfg.searchWindowSecMax
    );
  }

  function _durationPenalty(stanza, candidateDuration) {
    const expected = Math.max(0.3, stanza?.expectedDuration || 1);
    const ratio = candidateDuration / expected;
    const spread = Math.abs(Math.log(Math.max(0.05, ratio)) / Math.log(2.2));
    return clamp(spread, 0, 1);
  }

  function _distancePenalty(startTime, baseMinStart, searchSpanSec) {
    const delta = Math.max(0, startTime - baseMinStart);
    return clamp(delta / Math.max(1, searchSpanSec), 0, 1);
  }

  function _gapPenalty(lastAccepted, candidate) {
    if (!lastAccepted || !candidate) return 0;
    const gap = Math.max(0, candidate.startTime - lastAccepted.endTime);
    return clamp(gap / 10, 0, 1);
  }

  function _transitionReward(lastAccepted, candidate) {
    if (!lastAccepted || !candidate) return 0;
    const gap = Math.max(0, candidate.startTime - lastAccepted.endTime);
    if (gap < 0.02) return -0.08;
    return 1 - clamp(gap / 4.0, 0, 1);
  }

  function _generateCandidatesForWindow(stanzaIdx, searchStartTime, searchEndTime, usedRegions, similarHistory, baseMinStart) {
    const stanza = stanzaData[stanzaIdx];
    const anchors = stanzaAnchors[stanzaIdx] || [];
    const windowWordIndexes = _getWindowWordIndexes(searchStartTime, searchEndTime);
    if (!windowWordIndexes.length) {
      return { window: { startTime: searchStartTime, endTime: searchEndTime }, candidates: [], rejected: [] };
    }

    const firstIdx = windowWordIndexes[0];
    const lastIdx = windowWordIndexes[windowWordIndexes.length - 1];
    const windowSet = new Set(windowWordIndexes);
    const candidateStarts = new Set();

    for (let i = 0; i < windowWordIndexes.length; i += Math.max(1, cfg.maxStartStepWords)) {
      candidateStarts.add(windowWordIndexes[i]);
    }
    candidateStarts.add(firstIdx);

    for (const anchor of anchors) {
      const occurrences = invertedIndex.get(anchor.word) || [];
      for (const occurrenceIdx of occurrences) {
        const occurrence = normalizedWhisperWords[occurrenceIdx];
        if (!occurrence) continue;
        if (occurrence.start < searchStartTime - 0.12 || occurrence.start > searchEndTime + 0.12) continue;
        const estimatedStart = occurrenceIdx - anchor.lyricIndex;
        const validStart = _moveToValidWordIndex(estimatedStart, windowSet, lastIdx);
        if (validStart !== null) candidateStarts.add(validStart);
      }
    }

    const expectedWords = Math.max(cfg.minWindowWords, stanza.words.length || stanza.wordsRaw.length || 3);
    const targetWordCenter = Math.max(expectedWords, Math.round((stanza.expectedDuration || 1) / Math.max(secPerWordObserved, 0.1)));
    const lengthOptions = Array.from(new Set([
      Math.max(cfg.minWindowWords, Math.round(targetWordCenter * 0.68)),
      Math.max(cfg.minWindowWords, Math.round(targetWordCenter * 0.84)),
      Math.max(cfg.minWindowWords, Math.round(targetWordCenter)),
      Math.max(cfg.minWindowWords, Math.round(targetWordCenter * 1.12)),
      Math.max(cfg.minWindowWords, Math.round(targetWordCenter * 1.30))
    ])).sort((a, b) => a - b);

    const rawCandidates = [];
    const rejected = [];
    const searchSpanSec = Math.max(1, searchEndTime - searchStartTime);

    for (const startIdx of candidateStarts) {
      const startTime = normalizedWhisperWords[startIdx]?.start ?? 0;
      if (startTime < searchStartTime - 0.15) continue;
      if (startTime > searchEndTime + 0.15) continue;

      for (const targetWords of lengthOptions) {
        const endIdx = _findEndIdxByWordCount(startIdx, targetWords, lastIdx);
        if (endIdx === null || endIdx < startIdx) continue;

        const endTime = normalizedWhisperWords[endIdx]?.end
          ?? normalizedWhisperWords[endIdx]?.start
          ?? startTime;
        const duration = endTime - startTime;
        if (endTime <= startTime) {
          rejected.push({ start: startTime, end: endTime, reason: 'duracao-invalida' });
          continue;
        }
        if (duration > cfg.maxCandidateDurationSec) {
          rejected.push({ start: startTime, end: endTime, reason: 'duracao-maior-que-maximo-global' });
          continue;
        }
        if (duration < cfg.minCandidateDurationSec) {
          rejected.push({ start: startTime, end: endTime, reason: 'duracao-menor-que-minimo-global' });
          continue;
        }
        if (duration < stanza.minExpectedDuration || duration > stanza.maxExpectedDuration) {
          rejected.push({
            start: Number(startTime.toFixed(3)),
            end: Number(endTime.toFixed(3)),
            reason: `duracao-fora-faixa:${duration.toFixed(2)}s!=[${stanza.minExpectedDuration.toFixed(2)},${stanza.maxExpectedDuration.toFixed(2)}]`
          });
          continue;
        }
        if (endTime > searchEndTime + 0.40) continue;
        if (startTime < baseMinStart - 0.001) {
          rejected.push({ start: Number(startTime.toFixed(3)), end: Number(endTime.toFixed(3)), reason: 'antes-do-cursor' });
          continue;
        }

        const candidateRange = { startTime, endTime, startIdx, endIdx };
        const hardOverlapRatio = getMaxUsedRegionOverlapRatio(candidateRange, usedRegions);
        if (hardOverlapRatio > cfg.overlapRejectRatio) {
          rejected.push({
            start: Number(startTime.toFixed(3)),
            end: Number(endTime.toFixed(3)),
            reason: `sobreposicao-regiao-usada:${hardOverlapRatio.toFixed(2)}`
          });
          continue;
        }

        const repeatedConflict = similarHistory.find((prev) => {
          const requiredGap = _getRequiredRepeatGap(stanza, prev);
          return startTime < (prev.endTime + requiredGap);
        });
        if (repeatedConflict) {
          const requiredGap = _getRequiredRepeatGap(stanza, repeatedConflict);
          rejected.push({
            start: Number(startTime.toFixed(3)),
            end: Number(endTime.toFixed(3)),
            reason: `repeticao-muito-proxima:${startTime.toFixed(2)}<${(repeatedConflict.endTime + requiredGap).toFixed(2)}`
          });
          continue;
        }

        const windowWords = normalizedWhisperWords
          .slice(startIdx, endIdx + 1)
          .map((w) => w.word)
          .filter(Boolean);
        if (windowWords.length < cfg.minWindowWords) continue;

        const breakdown = _scoreWindow(stanza, anchors, windowWords, startTime, searchStartTime, searchEndTime);
        const distancePenalty = _distancePenalty(startTime, baseMinStart, searchSpanSec);
        const durationPenalty = _durationPenalty(stanza, duration);
        const gapPenalty = 0;
        const repeatPenalty = 0;

        let finalScore = breakdown.rawScore;
        finalScore += breakdown.timeCloseness * 0.08;
        finalScore -= hardOverlapRatio * cfg.overlapPenaltyWeight;
        finalScore -= distancePenalty * cfg.timeDistancePenaltyWeight;
        finalScore -= durationPenalty * cfg.durationPenaltyWeight;
        finalScore = clamp(finalScore, 0, 1);

        if (finalScore < cfg.minScoreCandidate) continue;

        rawCandidates.push({
          text: stanza.text,
          startIdx,
          endIdx,
          startTime,
          endTime,
          duration,
          score: finalScore,
          scoreFinal: finalScore,
          rawScore: breakdown.rawScore,
          lexicalCoverage: breakdown.lexicalCoverage,
          precision: breakdown.precision,
          orderCoverage: breakdown.orderCoverage,
          anchorCoverage: breakdown.anchorCoverage,
          matchedCount: breakdown.matchedCount,
          lenRatio: breakdown.lenRatio,
          density: breakdown.density,
          timeCloseness: breakdown.timeCloseness,
          overlapRatio: hardOverlapRatio,
          distancePenalty,
          durationPenalty,
          repeatPenalty,
          gapPenalty,
          expectedDuration: stanza.expectedDuration,
          minExpectedDuration: stanza.minExpectedDuration,
          maxExpectedDuration: stanza.maxExpectedDuration,
          searchWindowStart: searchStartTime,
          searchWindowEnd: searchEndTime
        });
      }
    }

    rawCandidates.sort((a, b) => {
      if ((b.scoreFinal ?? b.score) !== (a.scoreFinal ?? a.score)) return (b.scoreFinal ?? b.score) - (a.scoreFinal ?? a.score);
      if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
      if (a.overlapRatio !== b.overlapRatio) return a.overlapRatio - b.overlapRatio;
      if (a.startTime !== b.startTime) return a.startTime - b.startTime;
      return a.endTime - b.endTime;
    });

    const deduped = [];
    for (const candidate of rawCandidates) {
      const duplicated = deduped.some((kept) => (
        Math.abs(candidate.startTime - kept.startTime) < 0.20
        || overlapRatioBetweenCandidates(candidate, kept) >= 0.80
      ));
      if (duplicated) continue;
      deduped.push(candidate);
      if (deduped.length >= cfg.maxCandidatesPerStanza) break;
    }

    return {
      window: { startTime: searchStartTime, endTime: searchEndTime },
      candidates: deduped,
      rejected
    };
  }

  function _rankCandidatesForBeam(stanza, candidates, baseMinStart, acceptThreshold, usedRegions, similarHistory, lastAccepted, repeatedLike) {
    const valid = [];
    const rejected = [];

    for (const candidate of candidates) {
      const reasons = [];
      if ((candidate.scoreFinal ?? candidate.score) < acceptThreshold) {
        reasons.push(`score-baixo:${(candidate.scoreFinal ?? candidate.score).toFixed(3)}<${acceptThreshold.toFixed(3)}`);
      }
      if (candidate.startTime < baseMinStart - 0.001) {
        reasons.push(`antes-do-cursor:${candidate.startTime.toFixed(2)}<${baseMinStart.toFixed(2)}`);
      }

      const overlapRatio = getMaxUsedRegionOverlapRatio(candidate, usedRegions);
      if (overlapRatio > cfg.overlapRejectRatio) {
        reasons.push(`sobreposicao-regiao-usada:${overlapRatio.toFixed(2)}`);
      }

      const repeatedConflict = similarHistory.find((prev) => {
        const requiredGap = _getRequiredRepeatGap(stanza, prev);
        return candidate.startTime < (prev.endTime + requiredGap);
      });
      if (repeatedConflict) {
        const requiredGap = _getRequiredRepeatGap(stanza, repeatedConflict);
        reasons.push(`repeticao-muito-proxima:${candidate.startTime.toFixed(2)}<${(repeatedConflict.endTime + requiredGap).toFixed(2)}`);
      }

      if (candidate.endTime <= candidate.startTime) reasons.push('duracao-invalida');
      if (candidate.duration < stanza.minExpectedDuration || candidate.duration > stanza.maxExpectedDuration) {
        reasons.push('duracao-fora-da-faixa-esperada');
      }

      const distancePenalty = _distancePenalty(candidate.startTime, baseMinStart, Math.max(1, candidate.searchWindowEnd - candidate.searchWindowStart));
      const gapPenalty = _gapPenalty(lastAccepted, candidate);
      const transitionReward = _transitionReward(lastAccepted, candidate);

      let repeatPenalty = 0;
      if (similarHistory.length > 0) {
        const closestGap = Math.min(
          ...similarHistory.map((prev) => Math.max(0, candidate.startTime - prev.endTime))
        );
        const requiredGap = Math.max(...similarHistory.map((prev) => _getRequiredRepeatGap(stanza, prev)));
        repeatPenalty = clamp(1 - (closestGap / Math.max(requiredGap * 1.5, 0.1)), 0, 1) * cfg.repeatPenaltyWeight;
      }

      const durationPenalty = candidate.durationPenalty ?? _durationPenalty(stanza, candidate.duration);

      const scoreFinal = clamp(
        (candidate.rawScore ?? candidate.score ?? 0)
          + (candidate.anchorCoverage || 0) * 0.04
          + transitionReward * cfg.transitionRewardWeight
          - distancePenalty * cfg.timeDistancePenaltyWeight
          - durationPenalty * cfg.durationPenaltyWeight
          - repeatPenalty
          - gapPenalty * cfg.gapPenaltyWeight
          - (candidate.overlapRatio || 0) * cfg.overlapPenaltyWeight,
        0,
        1
      );

      const enriched = {
        ...candidate,
        distancePenalty,
        durationPenalty,
        repeatPenalty,
        gapPenalty,
        transitionReward,
        scoreFinal,
        score: scoreFinal,
        repeatedLike
      };

      if (!reasons.length) {
        valid.push(enriched);
      } else {
        rejected.push({
          start: Number(candidate.startTime.toFixed(3)),
          end: Number(candidate.endTime.toFixed(3)),
          score: Number(scoreFinal.toFixed(3)),
          motivoRejeicao: reasons.join('|')
        });
      }
    }

    valid.sort((a, b) => {
      if (b.scoreFinal !== a.scoreFinal) return b.scoreFinal - a.scoreFinal;
      if ((b.rawScore ?? 0) !== (a.rawScore ?? 0)) return (b.rawScore ?? 0) - (a.rawScore ?? 0);
      if (a.startTime !== b.startTime) return a.startTime - b.startTime;
      return a.endTime - b.endTime;
    });

    return { valid, rejected };
  }

  function _estimateLookahead(stanzaIdx, cursorTime, usedRegions, acceptedHistory, depth) {
    if (depth <= 0 || stanzaIdx >= stanzaData.length) return 0;

    let localCursor = cursorTime;
    let localUsed = _cloneUsedRegions(usedRegions);
    let localHistory = (acceptedHistory || []).map((item) => ({ ...item, stanza: item.stanza }));
    let sum = 0;

    for (let step = 0; step < depth && (stanzaIdx + step) < stanzaData.length; step++) {
      const currentIdx = stanzaIdx + step;
      const stanza = stanzaData[currentIdx];
      const prevStanza = currentIdx > 0 ? stanzaData[currentIdx - 1] : null;
      const repeatedLike = _isRepeatedLike(prevStanza, stanza) || localHistory.some((item) => _isRepeatedLike(item.stanza, stanza));
      const similarHistory = _getSimilarAcceptedHistory(stanza, localHistory);
      const repeatedFloor = similarHistory.reduce((maxTime, item) => {
        const requiredGap = _getRequiredRepeatGap(stanza, item);
        return Math.max(maxTime, item.endTime + requiredGap);
      }, 0);
      const baseMinStart = Math.max(localCursor, repeatedFloor);
      const searchEnd = Math.min(totalDur, baseMinStart + _getDynamicWindowSec(stanza));
      const generated = _generateCandidatesForWindow(currentIdx, baseMinStart, searchEnd, localUsed, similarHistory, baseMinStart);
      const acceptThreshold = repeatedLike ? cfg.minScoreAcceptRepeated : cfg.minScoreAccept;
      const ranked = _rankCandidatesForBeam(
        stanza,
        generated.candidates,
        baseMinStart,
        acceptThreshold,
        localUsed,
        similarHistory,
        null,
        repeatedLike
      );

      const best = ranked.valid[0] || null;
      if (!best) {
        sum -= 0.08;
        localCursor = Math.min(totalDur, baseMinStart + clamp(
          cfg.nullAdvanceBaseSec + (stanza.wordsRaw.length * cfg.nullAdvancePerWordSec),
          2.0,
          4.4
        ));
        continue;
      }

      sum += best.scoreFinal * 0.25;
      addUsedRegion(localUsed, { start: best.startTime, end: best.endTime }, cfg.mergeUsedRegionGapSec);
      localHistory.push({ stanza, startTime: best.startTime, endTime: best.endTime, signature: stanza.signature });
      localCursor = Math.max(baseMinStart, best.endTime + cfg.minProgressSec);
    }

    return sum;
  }

  let beams = [{
    score: 0,
    matches: [],
    candidateLists: [],
    debug: [],
    usedRegions: [],
    acceptedHistory: [],
    cursorTime: 0,
    lastAccepted: null
  }];

  for (let stanzaIdx = 0; stanzaIdx < stanzaData.length; stanzaIdx++) {
    const stanza = stanzaData[stanzaIdx];
    const prevStanza = stanzaIdx > 0 ? stanzaData[stanzaIdx - 1] : null;
    const expandedBeams = [];

    for (const beam of beams) {
      const repeatedLike = _isRepeatedLike(prevStanza, stanza) || beam.acceptedHistory.some((item) => _isRepeatedLike(item.stanza, stanza));
      const similarHistory = _getSimilarAcceptedHistory(stanza, beam.acceptedHistory);
      const repeatedFloor = similarHistory.reduce((maxTime, item) => {
        const requiredGap = _getRequiredRepeatGap(stanza, item);
        return Math.max(maxTime, item.endTime + requiredGap);
      }, 0);

      const baseMinStart = beam.lastAccepted
        ? Math.max(beam.cursorTime, beam.lastAccepted.endTime + cfg.minProgressSec, repeatedFloor)
        : Math.max(beam.cursorTime, repeatedFloor, 0);

      const dynamicWindowSec = _getDynamicWindowSec(stanza);
      const primarySearchEnd = Math.min(totalDur, baseMinStart + dynamicWindowSec);
      let generated = _generateCandidatesForWindow(
        stanzaIdx,
        baseMinStart,
        primarySearchEnd,
        beam.usedRegions,
        similarHistory,
        baseMinStart
      );

      if (!generated.candidates.length && primarySearchEnd < totalDur) {
        generated = _generateCandidatesForWindow(
          stanzaIdx,
          baseMinStart,
          Math.min(totalDur, primarySearchEnd + cfg.fallbackExpansionSec),
          beam.usedRegions,
          similarHistory,
          baseMinStart
        );
      }

      const acceptThreshold = repeatedLike ? cfg.minScoreAcceptRepeated : cfg.minScoreAccept;
      const ranked = _rankCandidatesForBeam(
        stanza,
        generated.candidates,
        baseMinStart,
        acceptThreshold,
        beam.usedRegions,
        similarHistory,
        beam.lastAccepted,
        repeatedLike
      );

      const debugEntryBase = {
        stanzaIdx,
        repeatedLike,
        cursorBefore: Number(beam.cursorTime.toFixed(3)),
        baseMinStart: Number(baseMinStart.toFixed(3)),
        windowStart: Number(generated.window.startTime.toFixed(3)),
        windowEnd: Number(generated.window.endTime.toFixed(3)),
        candidateCount: generated.candidates.length,
        usedRegionsCount: beam.usedRegions.length,
        candidatePreview: generated.candidates.slice(0, 8).map((candidate) => ({
          start: Number(candidate.startTime.toFixed(3)),
          end: Number(candidate.endTime.toFixed(3)),
          duration: Number((candidate.duration || 0).toFixed(3)),
          score: Number((candidate.scoreFinal ?? candidate.score ?? 0).toFixed(3)),
          rawScore: Number((candidate.rawScore || 0).toFixed(3)),
          lexicalCoverage: Number((candidate.lexicalCoverage || 0).toFixed(3)),
          orderCoverage: Number((candidate.orderCoverage || 0).toFixed(3)),
          distancePenalty: Number((candidate.distancePenalty || 0).toFixed(3)),
          durationPenalty: Number((candidate.durationPenalty || 0).toFixed(3)),
          overlapRatio: Number((candidate.overlapRatio || 0).toFixed(3))
        })),
        rejectedPreview: [...generated.rejected.slice(0, 6), ...ranked.rejected.slice(0, 6)].slice(0, 10)
      };

      const branchCandidates = ranked.valid.slice(0, cfg.beamBranchPerStanza);

      for (const candidate of branchCandidates) {
        const nextUsedRegions = _cloneUsedRegions(beam.usedRegions);
        addUsedRegion(nextUsedRegions, { start: candidate.startTime, end: candidate.endTime }, cfg.mergeUsedRegionGapSec);

        const accepted = {
          text: stanza.text,
          startIdx: candidate.startIdx,
          endIdx: candidate.endIdx,
          startTime: Math.max(0, candidate.startTime - cfg.acceptPaddingStartSec),
          endTime: Math.min(totalDur, candidate.endTime + cfg.acceptPaddingEndSec),
          score: candidate.scoreFinal,
          rawScore: candidate.rawScore,
          lexicalCoverage: candidate.lexicalCoverage,
          precision: candidate.precision,
          orderCoverage: candidate.orderCoverage,
          anchorCoverage: candidate.anchorCoverage,
          density: candidate.density,
          duration: candidate.duration,
          durationPenalty: candidate.durationPenalty,
          distancePenalty: candidate.distancePenalty,
          repeatPenalty: candidate.repeatPenalty,
          gapPenalty: candidate.gapPenalty,
          expectedDuration: candidate.expectedDuration,
          sequential: true,
          repeatedLike,
          usedRegionsSnapshot: beam.usedRegions.length
        };

        const lookaheadBonus = cfg.lookaheadDepth > 0
          ? _estimateLookahead(
              stanzaIdx + 1,
              Math.max(baseMinStart, accepted.endTime),
              nextUsedRegions,
              [...beam.acceptedHistory, { stanza, startTime: accepted.startTime, endTime: accepted.endTime, signature: stanza.signature }],
              cfg.lookaheadDepth
            ) * cfg.lookaheadWeight
          : 0;

        expandedBeams.push({
          score: beam.score + candidate.scoreFinal + lookaheadBonus,
          matches: [...beam.matches, accepted],
          candidateLists: [...beam.candidateLists, generated.candidates],
          debug: [...beam.debug, {
            ...debugEntryBase,
            accepted: true,
            bestScore: Number(candidate.scoreFinal.toFixed(3)),
            chosen: {
              start: Number(candidate.startTime.toFixed(3)),
              end: Number(candidate.endTime.toFixed(3)),
              duration: Number((candidate.duration || 0).toFixed(3)),
              score: Number(candidate.scoreFinal.toFixed(3)),
              lookaheadBonus: Number(lookaheadBonus.toFixed(3))
            },
            cursorAfter: Number(Math.max(baseMinStart, accepted.endTime).toFixed(3))
          }],
          usedRegions: nextUsedRegions,
          acceptedHistory: [...beam.acceptedHistory, { stanza, startTime: accepted.startTime, endTime: accepted.endTime, signature: stanza.signature }],
          cursorTime: Math.max(baseMinStart, accepted.endTime),
          lastAccepted: accepted
        });
      }

      const fallbackAdvance = clamp(
        cfg.nullAdvanceBaseSec + (stanza.wordsRaw.length * cfg.nullAdvancePerWordSec),
        2.0,
        4.4
      );
      const nullPenalty = 0.16 + Math.min(0.18, stanza.wordsRaw.length * 0.006);
      expandedBeams.push({
        score: beam.score - nullPenalty,
        matches: [...beam.matches, null],
        candidateLists: [...beam.candidateLists, generated.candidates],
        debug: [...beam.debug, {
          ...debugEntryBase,
          accepted: false,
          bestScore: ranked.valid[0] ? Number(ranked.valid[0].scoreFinal.toFixed(3)) : null,
          motivoRejeicao: ranked.rejected.slice(0, 8),
          cursorAfter: Number(Math.min(totalDur, baseMinStart + fallbackAdvance).toFixed(3))
        }],
        usedRegions: _cloneUsedRegions(beam.usedRegions),
        acceptedHistory: [...beam.acceptedHistory],
        cursorTime: Math.min(totalDur, baseMinStart + fallbackAdvance),
        lastAccepted: beam.lastAccepted
      });
    }

    expandedBeams.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aAccepted = a.matches.filter(Boolean).length;
      const bAccepted = b.matches.filter(Boolean).length;
      if (bAccepted !== aAccepted) return bAccepted - aAccepted;
      return a.cursorTime - b.cursorTime;
    });

    beams = expandedBeams.slice(0, cfg.beamWidth);
  }

  const bestBeam = beams[0] || {
    matches: stanzaData.map(() => null),
    candidateLists: stanzaData.map(() => []),
    debug: [],
    usedRegions: []
  };

  if (cfg.debug) {
    for (const entry of bestBeam.debug) {
      console.log({
        trecho: stanzaData[entry.stanzaIdx]?.text || '',
        start: entry.chosen?.start ?? null,
        end: entry.chosen?.end ?? null,
        score: entry.chosen?.score ?? entry.bestScore ?? null,
        candidatoFinal: entry.chosen || null,
        candidatos: entry.candidatePreview,
        motivoRejeicao: entry.motivoRejeicao || entry.rejectedPreview || [],
        janela: {
          start: entry.windowStart,
          end: entry.windowEnd
        },
        cursor: entry.cursorBefore
      });
    }
  }

  const metrics = {
    beamScore: Number((bestBeam.score || 0).toFixed(4)),
    acceptedMatches: bestBeam.matches.filter(Boolean).length,
    nullMatches: bestBeam.matches.filter((item) => !item).length,
    usedRegionCount: (bestBeam.usedRegions || []).length
  };

  if (opts.returnMeta) {
    return {
      matches: bestBeam.matches,
      candidates: bestBeam.candidateLists,
      totalDur,
      debug: bestBeam.debug,
      usedRegions: bestBeam.usedRegions,
      metrics
    };
  }

  return bestBeam.matches;
}

function calculateRegionOverlap(a, b) {
  if (!a || !b) return 0;
  const start = Math.max(a.start ?? 0, b.start ?? 0);
  const end = Math.min(a.end ?? 0, b.end ?? 0);
  return Math.max(0, end - start);
}

function calculateRegionOverlapRatio(a, b) {
  if (!a || !b) return 0;
  const overlap = calculateRegionOverlap(a, b);
  if (overlap <= 0) return 0;
  const lenA = Math.max(0.001, (a.end ?? 0) - (a.start ?? 0));
  const lenB = Math.max(0.001, (b.end ?? 0) - (b.start ?? 0));
  return overlap / Math.max(0.001, Math.min(lenA, lenB));
}

function getMaxUsedRegionOverlapRatio(candidate, usedRegions) {
  let maxRatio = 0;
  for (const region of usedRegions || []) {
    maxRatio = Math.max(maxRatio, calculateRegionOverlapRatio(candidate, region));
  }
  return maxRatio;
}

function addUsedRegion(usedRegions, region, mergeGapSec = 0.18) {
  if (!region || !Number.isFinite(region.start) || !Number.isFinite(region.end)) return usedRegions;
  const normalized = {
    start: Math.max(0, Math.min(region.start, region.end)),
    end: Math.max(region.start, region.end)
  };

  if (normalized.end <= normalized.start) return usedRegions;

  const next = [...(usedRegions || []), normalized].sort((a, b) => a.start - b.start);
  const merged = [];

  for (const current of next) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...current });
      continue;
    }

    if (current.start <= last.end + mergeGapSec) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  usedRegions.length = 0;
  usedRegions.push(...merged);
  return usedRegions;
}

/**
 * Preenche estrofes sem match (null) interpolando entre vizinhos com match.
 *
 * @param {Array}  matches   sa�da de fuzzyMatchStanzas
 * @param {Array}  stanzas   [{text}]
 * @param {number} totalDur  dura��o total do �udio em segundos
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createStanzaSignature(text) {
  return removeConsecutiveDuplicates(extractWordsAllowShort(text)).join(' ');
}

function getWordsInTimeRange(whisperWords, startTime, endTime, padding = 0.12) {
  return (whisperWords || []).filter((w) => {
    const st = Number.isFinite(w?.start) ? w.start : null;
    const en = Number.isFinite(w?.end) ? w.end : st;
    if (st === null && en === null) return false;
    const safeStart = st ?? en;
    const safeEnd = en ?? st ?? safeStart;
    return safeEnd >= (startTime - padding) && safeStart <= (endTime + padding);
  });
}

function makeBigramSet(words) {
  const set = new Set();
  for (let i = 0; i < words.length - 1; i++) {
    set.add(`${words[i]}|${words[i + 1]}`);
  }
  return set;
}

function evaluateMatchQuality(stanza, match, whisperWords, totalDur) {
  const stanzaText = String(stanza?.text || '');
  const lyricWords = removeConsecutiveDuplicates(extractWordsAllowShort(stanzaText));

  if (!match) {
    return {
      signature: createStanzaSignature(stanzaText),
      recognizedWords: 0,
      lyricWordCount: lyricWords.length,
      lexicalCoverage: 0,
      orderCoverage: 0,
      vocalPresence: false,
      confidence: 0,
      verified: false,
      lowConfidence: true,
      reason: 'sem-match'
    };
  }

  const windowWordsRaw = getWordsInTimeRange(whisperWords, match.startTime, match.endTime)
    .map((w) => normalizeWord(w.word))
    .filter(Boolean);
  const windowWords = removeConsecutiveDuplicates(windowWordsRaw);
  const windowSet = new Set(windowWords);

  let matched = 0;
  for (const word of lyricWords) {
    if (windowSet.has(word)) matched += 1;
  }

  const lyricBigrams = makeBigramSet(lyricWords);
  const windowBigrams = makeBigramSet(windowWords);
  let bigramHits = 0;
  for (const bg of lyricBigrams) {
    if (windowBigrams.has(bg)) bigramHits += 1;
  }

  const lexicalCoverage = lyricWords.length > 0 ? matched / lyricWords.length : 0;
  const orderCoverage = lyricBigrams.size > 0 ? bigramHits / lyricBigrams.size : lexicalCoverage;
  const recognizedWords = windowWords.length;
  const vocalPresence = recognizedWords > 0;
  const expectedFraction = totalDur > 0 ? (match.startTime / totalDur) : 0;
  const timingPenalty = Math.min(0.12, Math.abs(expectedFraction - clamp(expectedFraction, 0, 1)) * 0.12);
  const confidence = clamp(
    (match.score || 0) * 0.52
      + lexicalCoverage * 0.28
      + orderCoverage * 0.15
      + (vocalPresence ? 0.05 : -0.12)
      - timingPenalty,
    0,
    1
  );
  const verified = vocalPresence && confidence >= 0.38;

  return {
    signature: createStanzaSignature(stanzaText),
    recognizedWords,
    lyricWordCount: lyricWords.length,
    lexicalCoverage,
    orderCoverage,
    vocalPresence,
    confidence,
    verified,
    lowConfidence: !verified,
    reason: !vocalPresence ? 'sem-vocal-detectado' : (verified ? 'ok' : 'baixa-confianca')
  };
}

function overlapRatioBetweenCandidates(a, b) {
  if (!a || !b) return 0;
  const start = Math.max(a.startIdx ?? 0, b.startIdx ?? 0);
  const end = Math.min(a.endIdx ?? -1, b.endIdx ?? -1);
  if (end < start) return 0;
  const overlap = end - start + 1;
  const lenA = Math.max(1, (a.endIdx ?? 0) - (a.startIdx ?? 0) + 1);
  const lenB = Math.max(1, (b.endIdx ?? 0) - (b.startIdx ?? 0) + 1);
  return overlap / Math.max(1, Math.min(lenA, lenB));
}

function stabilizeRepeatedStanzaMatches(stanzas, matches, candidateLists, totalDur) {
  const stabilized = matches.map((m) => (m ? { ...m } : null));
  const groups = new Map();

  stanzas.forEach((stanza, idx) => {
    const signature = createStanzaSignature(stanza?.text || '');
    if (!signature || extractWords(signature).length < 4) return;
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(idx);
  });

  let adjustedCount = 0;
  let repeatedGroups = 0;

  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    repeatedGroups += 1;

    const usedCandidates = [];
    const firstIdx = indexes[0];
    const lastIdx = indexes[indexes.length - 1];

    const prevFixed = stabilized
      .slice(0, firstIdx)
      .reverse()
      .find(Boolean) || null;

    const nextFixed = stabilized
      .slice(lastIdx + 1)
      .find(Boolean) || null;

    let cursor = prevFixed?.endTime || 0;

    indexes.forEach((idx, localIndex) => {
      const expectedStart = totalDur > 0
        ? totalDur * (idx / Math.max(1, stanzas.length - 1))
        : cursor;
      const pool = (candidateLists?.[idx] || []).filter(Boolean);
      if (!pool.length) return;

      const remaining = indexes.length - localIndex - 1;
      const minReserveGap = 0.35;
      const upperBound = nextFixed
        ? Math.max(cursor + 0.3, nextFixed.startTime - (remaining * minReserveGap))
        : totalDur;

      let best = null;
      let bestScore = -Infinity;

      for (const cand of pool) {
        if (cand.startTime < cursor - 0.25) continue;
        if (nextFixed && cand.endTime > upperBound + 0.8) continue;

        const temporalPenalty = totalDur > 0
          ? Math.abs((cand.startTime - expectedStart) / Math.max(totalDur, 1)) * 0.9
          : 0;
        const transitionPenalty = cand.startTime < cursor ? 0.28 : 0;
        const overlapPenalty = usedCandidates.some((used) => overlapRatioBetweenCandidates(cand, used) >= 0.45)
          ? 0.42
          : 0;
        const futurePenalty = nextFixed && cand.startTime > nextFixed.startTime
          ? 0.55
          : 0;
        const candidateScore = (cand.score || 0)
          - temporalPenalty
          - transitionPenalty
          - overlapPenalty
          - futurePenalty;

        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          best = cand;
        }
      }

      if (!best) {
        best = pool.find((cand) => cand.startTime >= cursor - 0.25) || pool[0] || null;
      }

      if (best && (!stabilized[idx]
        || Math.abs((stabilized[idx].startTime || 0) - best.startTime) > 0.30
        || (stabilized[idx].score || 0) + 0.03 < (best.score || 0)
        || stabilized[idx].repetitionAdjusted !== true)) {
        stabilized[idx] = {
          text: String(stanzas[idx]?.text || ''),
          startIdx: best.startIdx,
          endIdx: best.endIdx,
          startTime: Math.max(0, best.startTime - 0.05),
          endTime: best.endTime + 0.10,
          score: best.score,
          rawScore: best.score,
          repetitionAdjusted: true
        };
        adjustedCount += 1;
      }

      if (best) {
        usedCandidates.push(best);
      }

      if (stabilized[idx]) {
        cursor = Math.max(cursor, (stabilized[idx].endTime || cursor) + 0.02);
      }
    });
  }

  return { matches: stabilized, adjustedCount, repeatedGroups };
}

function repairLowConfidenceMatches(stanzas, matches, candidateLists, whisperWords, totalDur) {
  const repaired = matches.map((m) => (m ? { ...m } : null));
  let repairedCount = 0;

  for (let i = 0; i < repaired.length; i++) {
    const analysis = evaluateMatchQuality(stanzas[i], repaired[i], whisperWords, totalDur);
    if (!analysis.lowConfidence) continue;

    const prev = repaired.slice(0, i).reverse().find(Boolean) || null;
    const next = repaired.slice(i + 1).find(Boolean) || null;
    const pool = (candidateLists?.[i] || []).filter(Boolean);

    let bestMatch = repaired[i];
    let bestComposite = analysis.confidence + ((repaired[i]?.score || 0) * 0.35);

    for (const cand of pool) {
      const candidate = {
        text: String(stanzas[i]?.text || ''),
        startIdx: cand.startIdx,
        endIdx: cand.endIdx,
        startTime: Math.max(0, cand.startTime - 0.05),
        endTime: cand.endTime + 0.10,
        score: cand.score,
        rawScore: cand.score
      };

      if (prev && candidate.startTime < prev.endTime - 0.25) continue;
      if (next && candidate.endTime > next.startTime + 0.25) continue;

      const candidateAnalysis = evaluateMatchQuality(stanzas[i], candidate, whisperWords, totalDur);
      const composite = candidateAnalysis.confidence + ((cand.score || 0) * 0.35);

      if (composite > bestComposite + 0.03) {
        bestComposite = composite;
        bestMatch = { ...candidate, repairedByAnalysis: true };
      }
    }

    const changed = JSON.stringify(bestMatch) !== JSON.stringify(repaired[i]);
    repaired[i] = bestMatch;
    if (changed) repairedCount += 1;
  }

  return { matches: repaired, repairedCount };
}

function buildAlignmentMetrics(stanzas, matches, whisperWords, totalDur) {
  const aligned = matches
    .map((match, idx) => ({ match, idx }))
    .filter((item) => item.match);

  let overlapViolations = 0;
  let orderViolations = 0;
  let reusedAudioPairs = 0;
  let repeatedNearbyViolations = 0;
  let estimatedBoundaryErrorSum = 0;
  let estimatedBoundaryErrorCount = 0;

  for (let i = 0; i < aligned.length; i++) {
    const current = aligned[i].match;
    const prev = i > 0 ? aligned[i - 1].match : null;

    if (prev) {
      if ((current.startTime ?? 0) < (prev.startTime ?? 0)) orderViolations += 1;
      if ((current.startTime ?? 0) < (prev.endTime ?? 0)) overlapViolations += 1;
      if (calculateRegionOverlapRatio(
        { start: current.startTime, end: current.endTime },
        { start: prev.startTime, end: prev.endTime }
      ) > 0.18) {
        reusedAudioPairs += 1;
      }
    }

    const wordsInRange = getWordsInTimeRange(whisperWords, current.startTime, current.endTime, 0.04);
    if (wordsInRange.length > 0) {
      const firstWord = wordsInRange[0];
      const lastWord = wordsInRange[wordsInRange.length - 1];
      const boundaryError = (
        Math.abs((current.startTime ?? 0) - (firstWord.start ?? current.startTime ?? 0))
        + Math.abs((current.endTime ?? 0) - (lastWord.end ?? lastWord.start ?? current.endTime ?? 0))
      ) / 2;
      estimatedBoundaryErrorSum += boundaryError;
      estimatedBoundaryErrorCount += 1;
    }
  }

  for (let i = 0; i < stanzas.length; i++) {
    for (let j = i + 1; j < stanzas.length; j++) {
      const a = stanzas[i];
      const b = stanzas[j];
      if (!matches[i] || !matches[j]) continue;
      if (!a || !b) continue;
      const signatureA = createStanzaSignature(a.text || '');
      const signatureB = createStanzaSignature(b.text || '');
      const similar = signatureA && signatureB && (
        signatureA === signatureB
        || _stringSimilarityFromSignature(signatureA, signatureB) >= 0.82
      );
      if (!similar) continue;
      const gap = Math.abs((matches[j].startTime ?? 0) - (matches[i].endTime ?? 0));
      if (gap < 8) repeatedNearbyViolations += 1;
    }
  }

  const validDurations = aligned.filter(({ match }) => (match.endTime ?? 0) > (match.startTime ?? 0));
  const avgDuration = validDurations.length
    ? validDurations.reduce((sum, { match }) => sum + ((match.endTime ?? 0) - (match.startTime ?? 0)), 0) / validDurations.length
    : 0;

  return {
    estimatedAlignmentErrorSec: Number((estimatedBoundaryErrorCount > 0 ? (estimatedBoundaryErrorSum / estimatedBoundaryErrorCount) : 0).toFixed(3)),
    correctOrderPercent: Number((stanzas.length > 0 ? ((stanzas.length - orderViolations) / stanzas.length) * 100 : 100).toFixed(2)),
    overlapViolations,
    reusedAudioPairs,
    repeatedNearbyViolations,
    unmatchedStanzas: matches.filter((m) => !m).length,
    matchedStanzas: matches.filter(Boolean).length,
    avgSegmentDurationSec: Number(avgDuration.toFixed(3)),
    totalDurationSec: Number((totalDur || 0).toFixed(3))
  };
}

function _stringSimilarityFromSignature(a, b) {
  const wa = removeConsecutiveDuplicates(extractWordsAllowShort(a));
  const wb = removeConsecutiveDuplicates(extractWordsAllowShort(b));
  if (!wa.length || !wb.length) return 0;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let intersection = 0;
  for (const word of sa) {
    if (sb.has(word)) intersection += 1;
  }
  const precision = intersection / Math.max(sa.size, 1);
  const recall = intersection / Math.max(sb.size, 1);
  return (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

function buildSyncAnalysis(stanzas, matches, whisperWords, totalDur, meta = {}) {
  const stanzaAnalysis = stanzas.map((stanza, idx) => {
    const match = matches[idx];
    const quality = evaluateMatchQuality(stanza, match, whisperWords, totalDur);
    return {
      index: idx,
      textPreview: String(stanza?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      startTime: match?.startTime ?? null,
      endTime: match?.endTime ?? null,
      confidence: Number((quality.confidence || 0).toFixed(3)),
      verified: quality.verified,
      lowConfidence: quality.lowConfidence,
      vocalPresence: quality.vocalPresence,
      lexicalCoverage: Number((quality.lexicalCoverage || 0).toFixed(3)),
      orderCoverage: Number((quality.orderCoverage || 0).toFixed(3)),
      recognizedWords: quality.recognizedWords,
      lyricWordCount: quality.lyricWordCount,
      reason: quality.reason,
      speechActivityDetected: Boolean(match?.speechActivityDetected)
    };
  });

  const verifiedCount = stanzaAnalysis.filter((item) => item.verified).length;
  const lowConfidenceCount = stanzaAnalysis.filter((item) => item.lowConfidence).length;
  const withVocalCount = stanzaAnalysis.filter((item) => item.vocalPresence).length;
  const alignmentMetrics = buildAlignmentMetrics(stanzas, matches, whisperWords, totalDur);

  return {
    source: meta.source || 'original',
    transcriptionEngine: meta.engine || 'unknown',
    mode: meta.mode || 'original+vocal-guide',
    stanzaCount: stanzas.length,
    verifiedCount,
    lowConfidenceCount,
    withVocalCount,
    repeatedGroups: meta.repeatedGroups || 0,
    repeatedAdjustments: meta.repeatedAdjustments || 0,
    repairedByAnalysis: meta.repairedByAnalysis || 0,
    speechSegmentsDetected: meta.speechSegmentsDetected || 0,
    speechRefinements: meta.speechRefinements || 0,
    speechDetectionSource: meta.speechDetectionSource || 'none',
    timelineStabilizations: meta.timelineStabilizations || 0,
    searchMetrics: meta.searchMetrics || {},
    metrics: alignmentMetrics,
    stanzas: stanzaAnalysis
  };
}

function appendAnalysisToMatches(matches, analysis) {
  return matches.map((match, idx) => {
    if (!match) return null;
    const stanzaAnalysis = analysis?.stanzas?.[idx] || {};
    return {
      ...match,
      confidence: stanzaAnalysis.confidence ?? null,
      verified: stanzaAnalysis.verified ?? false,
      lowConfidence: stanzaAnalysis.lowConfidence ?? true,
      showOnlyDuringVocal: true,
      vocalPresence: stanzaAnalysis.vocalPresence ?? false,
      speechActivityDetected: stanzaAnalysis.speechActivityDetected ?? false
    };
  });
}

function findSpeechWindowForRange(speechSegments, startTime, endTime, maxDistance = 0.55) {
  if (!Array.isArray(speechSegments) || speechSegments.length === 0) return null;

  const overlapping = speechSegments.filter(
    (seg) => seg.end >= startTime - 0.12 && seg.start <= endTime + 0.12
  );

  if (overlapping.length > 0) {
    return {
      start: overlapping[0].start,
      end: overlapping[overlapping.length - 1].end,
      distance: 0,
      overlap: true
    };
  }

  let nearest = null;
  let bestDistance = Infinity;

  for (const seg of speechSegments) {
    const distance = seg.end < startTime
      ? startTime - seg.end
      : seg.start > endTime
        ? seg.start - endTime
        : 0;

    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = seg;
    }
  }

  if (!nearest || bestDistance > maxDistance) return null;

  return {
    start: nearest.start,
    end: nearest.end,
    distance: bestDistance,
    overlap: false
  };
}

function normalizeMatchWindow(startTime, endTime, totalDur) {
  const safeStart = clamp(Number.isFinite(startTime) ? startTime : 0, 0, totalDur);
  const safeEnd = clamp(Number.isFinite(endTime) ? endTime : safeStart + 0.12, safeStart + 0.12, totalDur);
  return {
    startTime: safeStart,
    endTime: safeEnd
  };
}

function refineMatchesWithSpeechActivity(matches, stanzas, speechSegments, whisperWords, totalDur) {
  if (!Array.isArray(speechSegments) || speechSegments.length === 0) {
    return { matches, refinedCount: 0 };
  }

  const refined = matches.map((match) => (match ? { ...match } : null));
  let refinedCount = 0;

  for (let i = 0; i < refined.length; i++) {
    const match = refined[i];
    if (!match) continue;

    const speechWindow = findSpeechWindowForRange(speechSegments, match.startTime, match.endTime);
    if (!speechWindow) continue;

    const quality = evaluateMatchQuality(stanzas[i], match, whisperWords, totalDur);
    const prev = i > 0 ? refined[i - 1] : null;
    const next = i < refined.length - 1 ? refined[i + 1] : null;

    let targetStart = quality.vocalPresence
      ? Math.max(speechWindow.start, match.startTime - 0.04)
      : speechWindow.start;

    let targetEnd = quality.vocalPresence
      ? Math.min(speechWindow.end, match.endTime + 0.06)
      : speechWindow.end;

    if (prev) {
      targetStart = Math.max(targetStart, prev.endTime + 0.02);
    }
    if (next) {
      targetEnd = Math.min(targetEnd, next.startTime - 0.02);
    }

    const normalized = normalizeMatchWindow(targetStart, targetEnd, totalDur);
    const changed = Math.abs(normalized.startTime - match.startTime) > 0.04
      || Math.abs(normalized.endTime - match.endTime) > 0.04;

    refined[i] = {
      ...match,
      startTime: normalized.startTime,
      endTime: normalized.endTime,
      speechActivityDetected: true,
      speechActivityRefined: changed || match.speechActivityRefined === true
    };

    if (changed) refinedCount += 1;
  }

  return { matches: refined, refinedCount };
}


function stabilizeMatchTimeline(matches, totalDur) {
  const stabilized = matches.map((match) => (match ? { ...match } : null));
  let adjustedCount = 0;
  let lastEnd = 0;

  for (let i = 0; i < stabilized.length; i++) {
    const match = stabilized[i];
    if (!match) continue;

    const safeTotal = Math.max(totalDur || 0, 0.12);
    const minStart = i === 0 ? 0 : lastEnd + 0.02;
    let nextStart = safeTotal;

    for (let j = i + 1; j < stabilized.length; j++) {
      if (stabilized[j]) {
        nextStart = stabilized[j].startTime;
        break;
      }
    }

    let startTime = clamp(match.startTime, minStart, safeTotal);
    let endTime = Math.max(match.endTime, startTime + 0.12);

    if (nextStart < safeTotal) {
      endTime = Math.min(endTime, Math.max(startTime + 0.12, nextStart - 0.02));
    }

    endTime = clamp(endTime, startTime + 0.12, safeTotal);

    if (Math.abs(startTime - match.startTime) > 0.01 || Math.abs(endTime - match.endTime) > 0.01) {
      adjustedCount += 1;
    }

    stabilized[i] = {
      ...match,
      startTime,
      endTime,
      timelineStabilized: true
    };
    lastEnd = endTime;
  }

  return { matches: stabilized, adjustedCount };
}

async function detectSpeechActivityBest(rawAudioPath, vocalGuidePath, totalDur) {
  const candidates = [
    { label: 'vocal-guide', path: vocalGuidePath },
    { label: 'original', path: rawAudioPath }
  ].filter((candidate) => candidate.path);

  for (const candidate of candidates) {
    const segments = await detectSpeechActivity(candidate.path, totalDur).catch(() => []);
    if (segments.length > 0) {
      return { segments, source: candidate.label };
    }
  }

  return { segments: [], source: 'none' };
}

// -----------------------------------------------------------------------------
// SE��O 3 � �UDIO: DOWNLOAD, CONVERS�O, TRANSCRI��O
// -----------------------------------------------------------------------------

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
        return reject(new Error(`HTTP ${resp.statusCode} ao baixar �udio`));
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
 * Converte �udio para MP3 mono 16kHz leve (ideal para Whisper).
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

async function extractVocalGuideTrack(inputPath) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `lena_vocal_guide_${Date.now()}.wav`);
    ffmpeg(inputPath)
      .audioFilters([
        'pan=mono|c0=0.5*c0+0.5*c1',
        'highpass=f=120',
        'lowpass=f=4200',
        'acompressor=threshold=-20dB:ratio=3:attack=5:release=50',
        'loudnorm=I=-16:TP=-1.5:LRA=11'
      ])
      .audioChannels(1)
      .audioFrequency(16000)
      .toFormat('wav')
      .on('end', () => resolve(output))
      .on('error', reject)
      .save(output);
  });
}

async function getBestWordTimestampsForSync(rawAudioPath, stanzas, files = [], opts = {}) {
  const candidates = [];
  const vocalGuidePath = opts?.vocalGuidePath || null;

  if (vocalGuidePath) {
    candidates.push({ label: 'vocal-guide', path: vocalGuidePath, bias: 0.08 });
  } else {
    try {
      const extractedVocalGuidePath = await extractVocalGuideTrack(rawAudioPath);
      files.push(extractedVocalGuidePath);
      candidates.push({ label: 'vocal-guide', path: extractedVocalGuidePath, bias: 0.08 });
    } catch (err) {
      console.warn('[voiceSync] N�o foi poss�vel gerar guia vocal:', err.message);
    }
  }

  candidates.push({ label: 'original', path: rawAudioPath, bias: 0 });

  let best = { words: [], engine: 'none', source: 'original', score: -Infinity };

  for (const candidate of candidates) {
    try {
      const { words, engine } = await getWordTimestamps(candidate.path);
      if (!words.length) continue;

      const raw = fuzzyMatchStanzas(stanzas, words, { returnMeta: true });
      const matched = raw.matches.filter((m) => m && (m.score || 0) >= 0.48).length;
      const avgScore = raw.matches.length
        ? raw.matches.reduce((sum, item) => sum + (item?.score || 0), 0) / raw.matches.length
        : 0;
      const score = matched * 1000 + avgScore * 100 + Math.min(words.length, 500) * 0.1 + candidate.bias * 100;

      if (score > best.score) {
        best = {
          words,
          engine,
          source: candidate.label,
          score
        };
      }
    } catch (err) {
      console.warn(`[voiceSync] Falha ao transcrever ${candidate.label}:`, err.message);
    }
  }

  return best;
}

/**
 * Transcreve �udio com Whisper API e retorna array de palavras com timestamps.
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
 * Converte �udio para WAV mono 16kHz (mais est�vel para WhisperX).
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

// -----------------------------------------------------------------------------
// SE��O 4 � FALLBACKS SEM WHISPER
// -----------------------------------------------------------------------------

// -- Fallback 3: FFmpeg silence-detect ----------------------------------------

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
async function detectSpeechActivity(audioPath, totalDur) {
  for (const { noise, dur } of SILENCE_THRESHOLDS) {
    try {
      const out = await runSilenceDetect(audioPath, noise, dur);
      const sils = parseSilences(out, totalDur);
      const segs = silencesToSpeech(sils, totalDur)
        .map((seg) => ({
          start: Math.max(0, seg.start),
          end: Math.min(totalDur, seg.end)
        }))
        .filter((seg) => seg.end - seg.start > 0.18);

      if (segs.length >= 1) {
        return segs;
      }
    } catch (_) { /* tenta pr�ximo threshold */ }
  }

  return [];
}

async function fallbackSilenceDetect(audioPath, totalDur, stanzas) {
  try {
    const segs = await detectSpeechActivity(audioPath, totalDur);

    if (segs.length >= 1) {
      const adjusted = adjustSegmentCount(segs, stanzas.length);
      return stanzas.map((s, i) => ({
        text:      s.text,
        startTime: Math.max(0, adjusted[i].start - 0.1),
        endTime:   Math.min(totalDur, adjusted[i].end)
      }));
    }
  } catch (_) { /* cai para o pr�ximo fallback */ }

  return null;
}

// -- Fallback 4: Distribui��o proporcional por palavras -----------------------

/**
 * Fallback 4: distribui estrofes linearmente pela dura��o total,
 * pesando pelo n�mero de palavras de cada estrofe.
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

// -----------------------------------------------------------------------------
// SE��O 5 � CONVERS�O DE FORMATOS
// -----------------------------------------------------------------------------

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

    return {
      start,
      end,
      lines: lineSegs,
      confidence: seg.confidence ?? null,
      verified: seg.verified ?? false,
      lowConfidence: seg.lowConfidence ?? true,
      showOnlyDuringVocal: seg.showOnlyDuringVocal ?? false,
      vocalPresence: seg.vocalPresence ?? false
    };
  });
}

// -----------------------------------------------------------------------------
// SE��O 6 � EXPORTA��ES P�BLICAS
// -----------------------------------------------------------------------------

/**
 * syncStanzasWithWhisper
 * ----------------------
 * Sincroniza estrofes com o audio usando Whisper + alinhamento sequencial por janela temporal (v7).
 *
 * @param {string} audioUrl  URL p�blica do �udio
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

    let speechSegments = [];
    let speechDetectionSource = 'none';
    let vocalGuidePath = null;

    try {
      vocalGuidePath = await extractVocalGuideTrack(rawPath);
      if (vocalGuidePath) files.push(vocalGuidePath);
    } catch (err) {
      console.warn('[voiceSync] N�o foi poss�vel preparar a guia vocal principal:', err.message);
    }

    // -- Word timestamps + guia vocal + detec��o de trechos com/sem vocal -----
    try {
      const [ts, speechDetection] = await Promise.all([
        getBestWordTimestampsForSync(rawPath, stanzas, files, { vocalGuidePath }),
        detectSpeechActivityBest(rawPath, vocalGuidePath, totalDur)
      ]);

      speechSegments = speechDetection?.segments || [];
      speechDetectionSource = speechDetection?.source || 'none';

      const words = ts.words || [];
      const engine = ts.engine || 'none';
      const source = ts.source || 'original';

      if (words.length > 0) {
        console.log(`[voiceSync] ? ${engine}/${source}: ${words.length} palavras com timestamps`);

        const raw = fuzzyMatchStanzas(stanzas, words, { returnMeta: true });
        const repeated = stabilizeRepeatedStanzaMatches(
          stanzas,
          raw.matches,
          raw.candidates,
          totalDur
        );
        const repaired = repairLowConfidenceMatches(
          stanzas,
          repeated.matches,
          raw.candidates,
          words,
          totalDur
        );
        const filled = fillNullMatches(repaired.matches, stanzas, totalDur);
        const speechRefined = refineMatchesWithSpeechActivity(filled, stanzas, speechSegments, words, totalDur);
        const timelineStabilized = stabilizeMatchTimeline(speechRefined.matches, totalDur);
        const analysis = buildSyncAnalysis(stanzas, timelineStabilized.matches, words, totalDur, {
          source,
          engine,
          mode: 'sequential-windowed+beam-search+speech-activity',
          repeatedGroups: repeated.repeatedGroups,
          repeatedAdjustments: repeated.adjustedCount,
          repairedByAnalysis: repaired.repairedCount,
          speechSegmentsDetected: speechSegments.length,
          speechRefinements: speechRefined.refinedCount,
          speechDetectionSource,
          timelineStabilizations: timelineStabilized.adjustedCount,
          searchMetrics: raw.metrics || {}
        });
        const enriched = appendAnalysisToMatches(timelineStabilized.matches, analysis);
        const result = toLineLevelFormat(enriched, stanzas, totalDur);

        console.log('[voiceSync] ? Sincroniza��o autom�tica validada por an�lise de confian�a e sil�ncio');
        return {
          segments: result,
          analysis
        };
      }
      console.log(`[voiceSync] ?? ${engine}/${source}: sem palavras � usando fallbacks`);
    } catch (tsErr) {
      console.warn('[voiceSync] Timestamps falharam:', tsErr.message);
    }

    if (!process.env.OPENAI_API_KEY && !isWhisperXEnabled()) {
      console.log('[voiceSync] OPENAI_API_KEY ausente e WHISPERX_ENABLED desativado � usando fallback silence-detect');
    }

    // -- Fallback 3: silence-detect --------------------------------------------
    const silResult = await fallbackSilenceDetect(rawPath, totalDur, stanzas);
    if (silResult) {
      console.log('[voiceSync] ? Fallback: silence-detect');
      const analysis = {
        source: 'original',
        transcriptionEngine: 'fallback-silence-detect',
        mode: 'fallback',
        stanzaCount: stanzas.length,
        verifiedCount: 0,
        lowConfidenceCount: stanzas.length,
        withVocalCount: 0,
        repeatedGroups: 0,
        repeatedAdjustments: 0,
        repairedByAnalysis: 0,
        speechSegmentsDetected: speechSegments.length,
        speechRefinements: speechSegments.length ? stanzas.length : 0,
        speechDetectionSource,
        timelineStabilizations: 0,
        stanzas: stanzas.map((stanza, idx) => ({
          index: idx,
          textPreview: String(stanza?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          startTime: silResult[idx]?.startTime ?? null,
          endTime: silResult[idx]?.endTime ?? null,
          confidence: 0,
          verified: false,
          lowConfidence: true,
          vocalPresence: false,
          lexicalCoverage: 0,
          orderCoverage: 0,
          recognizedWords: 0,
          lyricWordCount: extractWordsAllowShort(stanza?.text || '').length,
          reason: 'fallback-silence-detect',
          speechActivityDetected: true
        }))
      };
      const result = toLineLevelFormat(
        silResult.map((seg) => ({ ...seg, confidence: 0, verified: false, lowConfidence: true, showOnlyDuringVocal: true, vocalPresence: false })),
        stanzas,
        totalDur
      );
      return { segments: result, analysis };
    }

    // -- Fallback 4: proporcional ----------------------------------------------
    console.log('[voiceSync] ? Fallback: distribui��o proporcional');
    const propResult = fallbackProportional(stanzas, totalDur || 180);
    const analysis = {
      source: 'original',
      transcriptionEngine: 'fallback-proportional',
      mode: 'fallback',
      stanzaCount: stanzas.length,
      verifiedCount: 0,
      lowConfidenceCount: stanzas.length,
      withVocalCount: 0,
      repeatedGroups: 0,
      repeatedAdjustments: 0,
      repairedByAnalysis: 0,
      speechSegmentsDetected: 0,
      speechRefinements: 0,
      speechDetectionSource: 'none',
      timelineStabilizations: 0,
      stanzas: stanzas.map((stanza, idx) => ({
        index: idx,
        textPreview: String(stanza?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        startTime: propResult[idx]?.startTime ?? null,
        endTime: propResult[idx]?.endTime ?? null,
        confidence: 0,
        verified: false,
        lowConfidence: true,
        vocalPresence: false,
        lexicalCoverage: 0,
        orderCoverage: 0,
        recognizedWords: 0,
        lyricWordCount: extractWordsAllowShort(stanza?.text || '').length,
        reason: 'fallback-proportional',
        speechActivityDetected: false
      }))
    };
    const result = toLineLevelFormat(
      propResult.map((seg) => ({ ...seg, confidence: 0, verified: false, lowConfidence: true, showOnlyDuringVocal: true, vocalPresence: false })),
      stanzas,
      totalDur || 180
    );
    return { segments: result, analysis };

  } finally {
    cleanup();
  }
}

/**
 * resegmentAndSyncStanzas
 * -----------------------
 * Faz a separa��o autom�tica das estrofes *com base no �udio* (pausas/gaps)
 * e em seguida sincroniza as novas estrofes.
 *
 * Objetivo: quando o usu�rio clicar em �Sincronizar automaticamente�, o backend
 * pode re-segmentar a letra e devolver os blocos j� prontos para o editor.
 *
 * @param {string} audioUrl
 * @param {string} lyricsText  letra completa (pode ter \n)
 * @param {Object} opts
 * @returns {Promise<{stanzas:Array<{id:number,text:string}>, segments:Array, method:string}>}
 */
export async function resegmentAndSyncStanzas(audioUrl, lyricsText, opts = {}) {
  const files   = [];
  const cleanup = () => {
    for (const f of files)
      if (f && fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
  };

  // Normaliza a letra inteira
  const fullText = String(lyricsText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  if (!fullText) {
    throw new Error('lyricsText vazio');
  }

  // Linhas n�o-vazias como unidade m�nima (melhor p/ editor)
  const lyricLines = fullText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lyricLines.length === 0) {
    throw new Error('Letra n�o possui linhas v�lidas');
  }

  // Helper: cria stanzas agrupando linhas por distribui��o de "peso" (palavras)
  const buildStanzasFromSegments = (segments) => {
    const lineData = lyricLines.map((line) => ({
      line,
      words: Math.max(extractWords(line).length, 1)
    }));

    const totalWords = lineData.reduce((a, b) => a + b.words, 0);

    // Se n�o vier segmentos (ou vier ruim), cai em uma estrofe �nica
    const segs = Array.isArray(segments) && segments.length
      ? segments
      : [{ start: 0, end: 1 }];

    const totalSegDur = segs.reduce((a, s) => a + Math.max(0.1, (s.end - s.start)), 0.1);

    const targetCount = Math.max(1, Math.min(segs.length, lineData.length, 120));

    // Alvos de palavras por segmento (proporcional ao tempo do segmento)
    const targets = Array.from({ length: targetCount }, (_, i) => {
      const seg = segs[i] || segs[segs.length - 1];
      const dur = Math.max(0.1, (seg.end - seg.start));
      const tw  = Math.max(1, Math.round(totalWords * (dur / totalSegDur)));
      return tw;
    });

    // Ajuste fino para somar exatamente totalWords (evita sobras gigantes)
    let sumTargets = targets.reduce((a, b) => a + b, 0);
    while (sumTargets > totalWords) {
      const i = targets.findIndex(t => t > 1);
      if (i === -1) break;
      targets[i] -= 1;
      sumTargets -= 1;
    }
    while (sumTargets < totalWords) {
      targets[targets.length - 1] += 1;
      sumTargets += 1;
    }

    const out = [];
    let li = 0;
    for (let si = 0; si < targetCount; si++) {
      const mustLeave = targetCount - si - 1;
      const maxEnd = lineData.length - mustLeave; // garante 1 linha p/ cada estrofe restante

      const collected = [];
      let acc = 0;
      const target = targets[si];

      while (li < maxEnd) {
        collected.push(lineData[li].line);
        acc += lineData[li].words;
        li++;
        if (acc >= target && collected.length >= 1) break;
      }

      // Se por alguma raz�o ficou vazio, for�a 1 linha
      if (collected.length === 0 && li < lineData.length) {
        collected.push(lineData[li].line);
        li++;
      }

      out.push({
        id: si,
        text: collected.join('\n').trim()
      });
    }

    // Se sobrou linha, anexa na �ltima estrofe
    if (li < lineData.length && out.length) {
      const rest = lineData.slice(li).map(x => x.line).join('\n');
      out[out.length - 1].text = (out[out.length - 1].text + '\n' + rest).trim();
    }

    // Remove estrofes vazias (defensivo)
    return out.filter(s => String(s.text || '').trim().length > 0);
  };

  // Helper: extrai segmentos de fala usando gaps entre palavras
  const speechSegmentsFromWords = (words, totalDur) => {
    const GAP_SEC = 0.75;      // gap m�nimo para �quebra�
    const MIN_DUR = 1.2;       // segmentos menores que isso tendem a ser respira��o

    const w = (words || []).filter(Boolean);
    if (w.length === 0) return [];

    const segs = [];
    let segStart = Math.max(0, w[0].start ?? 0);
    let prevEnd  = Math.max(segStart, w[0].end ?? segStart);

    for (let i = 1; i < w.length; i++) {
      const st = w[i].start ?? prevEnd;
      const en = w[i].end ?? st;
      const gap = st - prevEnd;
      if (gap >= GAP_SEC) {
        segs.push({ start: segStart, end: prevEnd });
        segStart = st;
      }
      prevEnd = Math.max(prevEnd, en);
    }
    segs.push({ start: segStart, end: prevEnd });

    // 1) remove/mescla segmentos muito curtos
    const merged = [];
    for (const s of segs) {
      const dur = Math.max(0, s.end - s.start);
      if (merged.length === 0) {
        merged.push({ ...s });
        continue;
      }
      if (dur < MIN_DUR) {
        // cola no anterior
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
      } else {
        merged.push({ ...s });
      }
    }

    // 2) clamp dentro da dura��o total
    return merged
      .map(s => ({
        start: Math.max(0, Math.min(totalDur, s.start)),
        end:   Math.max(0, Math.min(totalDur, s.end))
      }))
      .filter(s => s.end - s.start > 0.2)
      .slice(0, 120);
  };

  try {
    const rawPath  = await downloadToTemp(audioUrl);
    files.push(rawPath);
    const totalDur = await getAudioDuration(rawPath);

    // Tenta timestamps por palavra (WhisperX ou Whisper API)
    let words = [];
    let engine = 'none';
    try {
      const ts = await getWordTimestamps(rawPath);
      words = ts.words || [];
      engine = ts.engine || 'none';
    } catch (e) {
      // ignora e cai nos fallbacks
    }

    // -- Caso 1: temos palavras com timestamps ? resegmenta por gaps e sincroniza com fuzzyMatch
    if (words.length > 0) {
      const speechSegs = speechSegmentsFromWords(words, totalDur || (words[words.length - 1]?.end || 0));
      const newStanzas = buildStanzasFromSegments(speechSegs);

      const rawMatches = fuzzyMatchStanzas(newStanzas, words);
      const filled     = fillNullMatches(rawMatches, newStanzas, totalDur);
      const segments   = toLineLevelFormat(filled, newStanzas, totalDur);

      return {
        stanzas: newStanzas.map((s, i) => ({ id: s.id ?? i, text: s.text })),
        segments,
        method: `resegment+${engine}`
      };
    }

    // -- Caso 2: sem Whisper ? usa silence-detect para obter segmentos de fala e resegmentar
    const silences = await (async () => {
      try {
        // Reusa a mesma rotina de fallback j� existente
        const dummy = Array.from({ length: Math.min(lyricLines.length, 60) }, (_, i) => ({ id: i, text: 'x' }));
        const sil = await fallbackSilenceDetect(rawPath, totalDur || 180, dummy);
        return (sil || []).map(s => ({ start: s.startTime, end: s.endTime }));
      } catch (_) {
        return [];
      }
    })();

    const newStanzas = buildStanzasFromSegments(silences);

    // Para tempos: se silence-detect deu algo, usa; sen�o, proporcional
    let timing;
    if (silences.length >= 1) {
      // Ajusta contagem para bater com n� de estrofes
      const adjusted = adjustSegmentCount(
        silences.map(s => ({ start: s.start, end: s.end })),
        newStanzas.length
      );
      timing = newStanzas.map((s, i) => ({
        text: s.text,
        startTime: Math.max(0, adjusted[i].start),
        endTime:   Math.max(0.1, adjusted[i].end)
      }));
    } else {
      timing = fallbackProportional(newStanzas, totalDur || 180);
    }

    const segments = toLineLevelFormat(timing, newStanzas, totalDur || 180);
    return {
      stanzas: newStanzas.map((s, i) => ({ id: s.id ?? i, text: s.text })),
      segments,
      method: 'resegment+fallback'
    };

  } finally {
    cleanup();
  }
}

/**
 * syncStanzasWithWhisperAnchors
 * ------------------------------
 * Vers�o que retorna o formato simples por estrofe (sem subdivis�o em linhas).
 *
 * @param {string} audioUrl  URL p�blica do �udio
 * @param {Array}  stanzas   [{ id?, text }]
 * @param {Object} opts      { respectOrder? }
 * @returns {Promise<Array>} [{ text, startTime, endTime }]
 */
export async function syncStanzasWithWhisperAnchors(audioUrl, stanzas, opts = {}) {
  if (!process.env.OPENAI_API_KEY && !isWhisperXEnabled()) {
    throw new Error('OPENAI_API_KEY n�o definida e WHISPERX_ENABLED desativado � necess�rio para gerar timestamps');
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
 * ---------------------------------
 * Dentre v�rios �udios candidatos, escolhe aquele que melhor cobre a letra.
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
    throw new Error('OPENAI_API_KEY n�o definida e WHISPERX_ENABLED desativado � necess�rio para auto-sele��o');
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
      const strongMatches = matches.filter(m => m && (m.score || 0) >= 0.48).length;
      const avgScore = matches.length
        ? matches.reduce((sum, m) => sum + (m?.score || 0), 0) / matches.length
        : 0;
      const score   = (strongMatches / Math.max(stanzas.length, 1)) * 1000
                    + (avgScore * 200)
                    + Math.min(words.length, 300) * 0.5;

      results.push({
        index: i, url, score,
        coverage:     strongMatches / Math.max(stanzas.length, 1),
        matched: strongMatches,
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

// -- Compat retrocompat�vel ----------------------------------------------------
export async function detectVoiceSegments(audioUrl, stanzaCount) {
  const dummy = Array.from({ length: stanzaCount }, (_, i) => ({ id: i, text: '' }));
  return syncStanzasWithWhisper(audioUrl, dummy);
}

// -----------------------------------------------------------------------------
// SE��O 7 � UTILIT�RIOS INTERNOS AUXILIARES
// -----------------------------------------------------------------------------

/** Gera um snippet de �udio para score r�pido sem transcrever o arquivo inteiro */
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
