import path from 'path';
import fs from 'fs';
import {
  getAudioDuration,
  imageToVideo,
  adjustVideoToAudioDuration,
  resizeImageTo16_9,
  createColorBackground,
  generateFinalVideo,
  cleanupTempFiles
} from '../utils/videoProcessor.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// URL base do backend (Render)
const BASE_URL = process.env.BACKEND_URL || 'https://lenavs-backend.onrender.com';

/**
 * Upload de arquivos de mídia
 */
export const uploadMedia = async (req, res) => {
  try {
    const uploadedFiles = {};

    if (req.files) {
      const mapFile = (file) => {
        // pega tudo após /uploads
        const relativePath = file.path.split('uploads')[1].replace(/\\/g, '/');
        return `${BASE_URL}/uploads${relativePath}`;
      };

      if (req.files.musicaOriginal) {
        uploadedFiles.musicaOriginal = mapFile(req.files.musicaOriginal[0]);
      }

      if (req.files.musicaInstrumental) {
        uploadedFiles.musicaInstrumental = mapFile(req.files.musicaInstrumental[0]);
      }

      if (req.files.video) {
        uploadedFiles.video = mapFile(req.files.video[0]);
      }

      if (req.files.imagem) {
        uploadedFiles.imagem = mapFile(req.files.imagem[0]);
      }

      if (req.files.letra) {
        uploadedFiles.letra = mapFile(req.files.letra[0]);
      }
    }

    return res.status(200).json({
      success: true,
      files: uploadedFiles,
      message: 'Arquivos enviados com sucesso'
    });
  } catch (error) {
    console.error('Erro no upload de mídia:', error);
    return res.status(500).json({ error: 'Erro ao fazer upload dos arquivos' });
  }
};

/**
 * Gera vídeo final com karaokê
 */
export const generateVideo = async (req, res) => {
  let tempFiles = [];

  try {
    const {
      projectName,
      audioPath,
      backgroundType,
      backgroundPath,
      backgroundColor,
      stanzas
    } = req.body;

    if (!projectName || !audioPath) {
      return res.status(400).json({ error: 'Dados insuficientes para gerar vídeo' });
    }

    // converter URL pública em path real
    const audioRealPath = path.join(
      __dirname,
      '../../uploads',
      audioPath.split('/uploads/')[1]
    );

    const audioDuration = await getAudioDuration(audioRealPath);

    const tempDir = path.join(__dirname, '../../uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let processedBackgroundPath;

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = path.join(__dirname, '../../uploads', backgroundPath.split('/uploads/')[1]);
      processedBackgroundPath = path.join(tempDir, `bg_video_${Date.now()}.mp4`);
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);
    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = path.join(__dirname, '../../uploads', backgroundPath.split('/uploads/')[1]);
      const resizedImage = path.join(tempDir, `resized_${Date.now()}.jpg`);
      await resizeImageTo16_9(realImg, resizedImage);
      tempFiles.push(resizedImage);

      processedBackgroundPath = path.join(tempDir, `bg_image_${Date.now()}.mp4`);
      await imageToVideo(resizedImage, audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);
    } else {
      processedBackgroundPath = path.join(tempDir, `bg_color_${Date.now()}.mp4`);
      await createColorBackground(backgroundColor || '000000', audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);
    }

    const outputFileName = `${projectName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.mp4`;
    const outputPath = path.join(tempDir, outputFileName);

    await generateFinalVideo(processedBackgroundPath, audioRealPath, outputPath);

    return res.status(200).json({
      success: true,
      videoUrl: `${BASE_URL}/api/video/download/${outputFileName}`
    });

  } catch (error) {
    console.error('Erro ao gerar vídeo:', error);
    await cleanupTempFiles(tempFiles);
    return res.status(500).json({ error: 'Erro ao gerar vídeo' });
  }
};

/**
 * Download do vídeo final
 */
export const downloadVideo = async (req, res) => {
  try {
    const { fileName } = req.params;
    const filePath = path.join(__dirname, '../../uploads/temp', fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    res.download(filePath, fileName);
  } catch (error) {
    console.error('Erro no download:', error);
    return res.status(500).json({ error: 'Erro ao fazer download do vídeo' });
  }
};
