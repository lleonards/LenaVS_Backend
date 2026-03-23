import { separateIntoStanzas, processLyricsFile } from '../utils/lyricsProcessor.js';
import {
  syncStanzasWithWhisper,
  syncStanzasWithWhisperRetrying,
  syncStanzasWithWhisperAnchors,
  chooseBestAudioCandidateByLyrics,
  resegmentAndSyncStanzas
} from '../utils/voiceSync.js';

export const processManualLyrics = async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Texto da letra não fornecido' });
    }

    const result = separateIntoStanzas(text);

    return res.status(200).json({
      success: true,
      message: 'Letra processada com sucesso',
      ...result
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
      message: 'Letra processada com sucesso',
      fileName: req.file.originalname,
      ...result
    });
  } catch (error) {
    console.error('Erro ao processar arquivo de letra:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const voiceSync = async (req, res) => {
  try {
    const { audioUrl, stanzas, stanzaCount } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    let stanzaList;
    if (Array.isArray(stanzas) && stanzas.length > 0) {
      stanzaList = stanzas.map((stanza, index) => ({
        id: stanza.id ?? index,
        text: String(stanza.text || '')
      }));
    } else if (stanzaCount && Number(stanzaCount) > 0) {
      const count = Math.min(Number(stanzaCount), 200);
      stanzaList = Array.from({ length: count }, (_, index) => ({ id: index, text: '' }));
    } else {
      return res.status(400).json({ error: 'Forneça stanzas (array) ou stanzaCount' });
    }

    const result = await syncStanzasWithWhisperRetrying(audioUrl, stanzaList, {
      forceOriginalOnly: true,
      maxAttempts: 5
    });

    return res.status(200).json({
      success: true,
      segments: result.segments || [],
      report: result.report || null,
      method: result.method,
      instrumentalOnly: Boolean(result.instrumentalOnly || result.report?.instrumentalOnly)
    });
  } catch (error) {
    console.error('Erro na sincronização Whisper:', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar com Whisper: ' + error.message
    });
  }
};

export const voiceSyncAnchors = async (req, res) => {
  try {
    const { audioUrl, stanzas, respectOrder } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    if (!Array.isArray(stanzas) || stanzas.length === 0) {
      return res.status(400).json({ error: 'stanzas (array) é obrigatório' });
    }

    const stanzaList = stanzas.map((stanza, index) => ({
      id: stanza.id ?? index,
      text: String(stanza.text || '')
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

export const voiceSyncResegment = async (req, res) => {
  try {
    const { audioUrl, lyricsText, stanzas } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    let text = String(lyricsText || '').trim();

    if (!text && Array.isArray(stanzas) && stanzas.length > 0) {
      text = stanzas
        .map((stanza) => String(stanza?.text || '').trim())
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

    const stanzaList = stanzas.map((stanza, index) => ({
      id: stanza.id ?? index,
      text: String(stanza.text || '')
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
