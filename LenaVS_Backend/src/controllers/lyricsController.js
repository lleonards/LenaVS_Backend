import { separateIntoStanzas, processLyricsFile } from '../utils/lyricsProcessor.js';
import { detectVoiceSegments } from '../utils/voiceSync.js';

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
 * Sincronização automática baseada na análise de voz do áudio original
 * Usa ffmpeg silence detection para identificar segmentos de voz
 * e distribui as estrofes nesses segmentos
 */
export const voiceSync = async (req, res) => {
  try {
    const { audioUrl, stanzaCount } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'URL do áudio não fornecida' });
    }

    if (!stanzaCount || stanzaCount < 1) {
      return res.status(400).json({ error: 'Número de estrofes inválido' });
    }

    const count = Math.min(Number(stanzaCount), 200); // limite de segurança

    const segments = await detectVoiceSegments(audioUrl, count);

    return res.status(200).json({
      success: true,
      segments,
      method: 'voice-detection'
    });

  } catch (error) {
    console.error('Erro na sincronização por voz:', error);
    return res.status(500).json({
      error: 'Erro ao analisar voz do áudio: ' + error.message
    });
  }
};
