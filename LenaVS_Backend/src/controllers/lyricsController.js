import { separateIntoStanzas, processLyricsFile } from '../utils/lyricsProcessor.js';
import {
  syncStanzasWithWhisper,
  syncStanzasWithWhisperRetrying,
  syncStanzasWithWhisperAnchors,
  chooseBestAudioCandidateByLyrics,
  resegmentAndSyncStanzas
} from '../utils/voiceSync.js';

/**
 * Processa letra colada manualmente
 */
export const processManualLyrics = async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Texto da letra não fornecido' });
    }

    const result = separateIntoStanzas(text);

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Erro ao processar letra:', error);
    return res.status(500).json({ error: 'Erro ao processar letra' });
  }
};

/**
 * Processa arquivo de letra enviado
 */
export const processLyricsFileUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo de letra não fornecido' });
    }

    const result = await processLyricsFile(req.file.path);

    return res.status(200).json({
      success: true,
      fileName: req.file.originalname,
      ...result
    });
  } catch (error) {
    console.error('Erro ao processar arquivo de letra:', error);
    return res.status(500).json({ error: error.message });
  }
};

/**
 * Sincronização automática via OpenAI Whisper (line-level)
 *
 * Body esperado:
 *   { audioUrl: string, stanzas: [ { id, text, ... } ] }
 *
 * Retorna:
 *   { segments: [{ start, end, lines: [{start, end, text}] }] }
 */
export const voiceSync = async (req, res) => {
  try {
    const { audioUrl, stanzas, stanzaCount } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    let stanzaList;
    if (Array.isArray(stanzas) && stanzas.length > 0) {
      stanzaList = stanzas.map((s, i) => ({
        id:   s.id ?? i,
        text: String(s.text || '')
      }));
    } else if (stanzaCount && Number(stanzaCount) > 0) {
      const count = Math.min(Number(stanzaCount), 200);
      stanzaList  = Array.from({ length: count }, (_, i) => ({ id: i, text: '' }));
    } else {
      return res.status(400).json({ error: 'Forneça stanzas (array) ou stanzaCount' });
    }

    // Pedido: sincronização automática deve usar SOMENTE a música original (com vocal)
    // Instrumental é obrigatório no projeto, mas não entra no algoritmo.
    const { segments, report, method } = await syncStanzasWithWhisperRetrying(audioUrl, stanzaList, {
      forceOriginalOnly: true,
      maxAttempts: 5
    });

    return res.status(200).json({
      success: true,
      segments,
      report,
      method
    });

  } catch (error) {
    console.error('Erro na sincronização Whisper:', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar com Whisper: ' + error.message
    });
  }
};

/**
 * Sincronização automática de ESTROFES via âncoras (3 primeiras + 3 últimas palavras)
 *
 * Body esperado:
 *   { audioUrl: string, stanzas: [ { id?, text } ], respectOrder?: boolean }
 *
 * Retorna:
 *   { stanzas: [{ text, startTime, endTime }] }
 */
export const voiceSyncAnchors = async (req, res) => {
  try {
    const { audioUrl, stanzas, respectOrder } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    if (!Array.isArray(stanzas) || stanzas.length === 0) {
      return res.status(400).json({ error: 'stanzas (array) é obrigatório' });
    }

    const stanzaList = stanzas.map((s, i) => ({
      id:   s.id ?? i,
      text: String(s.text || '')
    }));

    const synced = await syncStanzasWithWhisperAnchors(audioUrl, stanzaList, {
      respectOrder: respectOrder !== false
    });

    return res.status(200).json({
      success: true,
      stanzas: synced,
      method: 'whisper-anchors'
    });

  } catch (error) {
    console.error('Erro na sincronização Whisper (anchors):', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar com Whisper (anchors): ' + error.message
    });
  }
};

/**
 * Auto-seleciona qual áudio “é o certo” com base na letra enviada.
 *
 * Casos que resolve:
 *  - usuário trocou original/instrumental
 *  - usuário enviou 2 áudios com voz diferentes
 *
 * Estratégia:
 *  1) para cada candidato, faz um Whisper curto (snippet)
 *  2) mede cobertura de palavras da letra via Needleman‑Wunsch
 *  3) escolhe o maior score e roda a sync completa nesse áudio
 *
 * Body:
 *  { audioCandidates: string[], stanzas: [{id?, text}] }
 */
/**
 * Sincronização automática + re-segmentação das estrofes baseada no áudio.
 *
 * Body:
 *  { audioUrl: string, lyricsText?: string, stanzas?: [{id?, text}] }
 *
 * Retorna:
 *  { stanzas: [{id, text}], segments: [{ start, end, lines:[...] }] }
 */
export const voiceSyncResegment = async (req, res) => {
  try {
    const { audioUrl, lyricsText, stanzas } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    let text = String(lyricsText || '').trim();

    // fallback: monta lyricsText a partir das stanzas atuais
    if (!text && Array.isArray(stanzas) && stanzas.length > 0) {
      text = stanzas
        .map((s) => String(s?.text || '').trim())
        .filter(Boolean)
        .join('\n\n');
    }

    if (!text) {
      return res.status(400).json({ error: 'Forneça lyricsText (string) ou stanzas (array)' });
    }

    const { stanzas: newStanzas, segments, method } = await resegmentAndSyncStanzas(
      audioUrl,
      text,
      { forceOriginalOnly: true }
    );

    return res.status(200).json({
      success: true,
      stanzas: newStanzas,
      segments,
      method
    });

  } catch (error) {
    console.error('Erro na sincronização + resegmentação:', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar + resegmentar: ' + error.message
    });
  }
};

export const voiceSyncAuto = async (req, res) => {
  try {
    const { audioCandidates, stanzas } = req.body;

    if (!Array.isArray(audioCandidates) || audioCandidates.length === 0) {
      return res.status(400).json({ error: 'audioCandidates (array) é obrigatório' });
    }

    if (!Array.isArray(stanzas) || stanzas.length === 0) {
      return res.status(400).json({ error: 'stanzas (array) é obrigatório' });
    }

    const stanzaList = stanzas.map((s, i) => ({
      id:   s.id ?? i,
      text: String(s.text || '')
    }));

    const { bestUrl, ranking } = await chooseBestAudioCandidateByLyrics(
      audioCandidates,
      stanzaList,
      {
        snippetStartSec: 20,
        snippetDurationSec: 60,
        maxLyricsWords: 260
      }
    );

    if (!bestUrl) {
      return res.status(422).json({
        error: 'Não foi possível selecionar um áudio com base na letra',
        ranking
      });
    }

    // Aqui força sincronização em cima do áudio escolhido (com voz), sem tentar mistura/subtração.
    const segments = await syncStanzasWithWhisper(bestUrl, stanzaList, {
      forceOriginalOnly: true
    });

    return res.status(200).json({
      success: true,
      segments,
      chosenAudioUrl: bestUrl,
      ranking,
      method: 'auto-audio-select+whisper-nw-line-level'
    });

  } catch (error) {
    console.error('Erro na sincronização automática (auto-select):', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar (auto-select): ' + error.message
    });
  }
};
