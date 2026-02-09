import { separateIntoStanzas, processLyricsFile } from '../utils/lyricsProcessor.js';

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
