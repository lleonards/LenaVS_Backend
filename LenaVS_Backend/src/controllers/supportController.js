import path from 'path';
import fs from 'fs';

/**
 * Upload de arquivos de mídia
 */
export const uploadMedia = async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const filesResponse = {};

    Object.entries(req.files).forEach(([fieldName, files]) => {
      const file = files[0];

      // URL pública ABSOLUTA (ESSENCIAL para o preview)
      const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${file.filename}`;

      filesResponse[fieldName] = publicUrl;
    });

    return res.status(200).json({
      success: true,
      files: filesResponse
    });

  } catch (error) {
    console.error('Erro no upload de mídia:', error);
    return res.status(500).json({
      error: 'Erro ao fazer upload do arquivo'
    });
  }
};

/**
 * Gerar vídeo final (placeholder por enquanto)
 */
export const generateVideo = async (req, res) => {
  try {
    // Aqui futuramente entra FFmpeg
    return res.status(200).json({
      success: true,
      videoUrl: null,
      message: 'Geração de vídeo ainda não implementada'
    });
  } catch (error) {
    console.error('Erro ao gerar vídeo:', error);
    return res.status(500).json({
      error: 'Erro ao gerar vídeo'
    });
  }
};

/**
 * Download do vídeo gerado
 */
export const downloadVideo = async (req, res) => {
  try {
    const { fileName } = req.params;
    const filePath = path.join('outputs', fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Arquivo não encontrado' });
    }

    return res.download(filePath);
  } catch (error) {
    console.error('Erro no download:', error);
    return res.status(500).json({
      error: 'Erro ao baixar vídeo'
    });
  }
};
