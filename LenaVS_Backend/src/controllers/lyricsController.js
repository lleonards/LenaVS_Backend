import { separateIntoStanzas, processLyricsFile } from '../utils/lyricsProcessor.js';
import { syncStanzasWithWhisper } from '../utils/voiceSync.js';

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
 * Sincronização automática via OpenAI Whisper
 *
 * Body esperado:
 *   { audioUrl: string, stanzas: [ { id, text, ... } ] }
 *
 * O frontend envia o array completo de estrofes para que o backend
 * possa fazer matching real das palavras contra a transcrição do Whisper.
 */
export const voiceSync = async (req, res) => {
  try {
    const { audioUrl, stanzas, stanzaCount } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    // Suporta tanto o novo formato (stanzas array) quanto o antigo (stanzaCount)
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

    const segments = await syncStanzasWithWhisper(audioUrl, stanzaList);

    return res.status(200).json({
      success: true,
      segments,
      method: 'whisper'
    });

  } catch (error) {
    console.error('Erro na sincronização Whisper:', error);
    return res.status(500).json({
      error: 'Erro ao sincronizar com Whisper: ' + error.message
    });
  }
};
