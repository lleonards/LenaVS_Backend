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

/**
 * Processa upload de arquivos de mídia
 */
export const uploadMedia = async (req, res) => {
  try {
    const uploadedFiles = {};

    if (req.files) {
      if (req.files.musicaOriginal) {
        uploadedFiles.musicaOriginal = req.files.musicaOriginal[0].path;
      }
      if (req.files.musicaInstrumental) {
        uploadedFiles.musicaInstrumental = req.files.musicaInstrumental[0].path;
      }
      if (req.files.video) {
        uploadedFiles.video = req.files.video[0].path;
      }
      if (req.files.imagem) {
        uploadedFiles.imagem = req.files.imagem[0].path;
      }
      if (req.files.letra) {
        uploadedFiles.letra = req.files.letra[0].path;
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
      audioType, // 'original' ou 'instrumental'
      audioPath,
      backgroundType, // 'video', 'image', 'color'
      backgroundPath,
      backgroundColor,
      stanzas // Array de estrofes com timings e estilos
    } = req.body;

    if (!projectName || !audioPath) {
      return res.status(400).json({ error: 'Dados insuficientes para gerar vídeo' });
    }

    // Obter duração do áudio
    const audioDuration = await getAudioDuration(audioPath);

    // Processar background
    let processedBackgroundPath;
    const tempDir = path.join(__dirname, '../../uploads/temp');
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    if (backgroundType === 'video' && backgroundPath) {
      // Ajustar vídeo para duração do áudio
      processedBackgroundPath = path.join(tempDir, `bg_video_${Date.now()}.mp4`);
      await adjustVideoToAudioDuration(backgroundPath, audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);
    } else if (backgroundType === 'image' && backgroundPath) {
      // Redimensionar imagem e converter em vídeo
      const resizedImagePath = path.join(tempDir, `resized_${Date.now()}.jpg`);
      await resizeImageTo16_9(backgroundPath, resizedImagePath);
      tempFiles.push(resizedImagePath);

      processedBackgroundPath = path.join(tempDir, `bg_image_${Date.now()}.mp4`);
      await imageToVideo(resizedImagePath, audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);
    } else {
      // Criar fundo colorido
      const color = backgroundColor || '000000';
      processedBackgroundPath = path.join(tempDir, `bg_color_${Date.now()}.mp4`);
      await createColorBackground(color, audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);
    }

    // Gerar vídeo final
    const outputFileName = `${projectName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.mp4`;
    const outputPath = path.join(tempDir, outputFileName);
    
    await generateFinalVideo(processedBackgroundPath, audioPath, outputPath);

    // Retornar URL para download
    // Nota: Em produção, você deve servir este arquivo através de uma rota segura
    return res.status(200).json({
      success: true,
      message: 'Vídeo gerado com sucesso',
      videoUrl: `/api/video/download/${outputFileName}`,
      fileName: outputFileName
    });

  } catch (error) {
    console.error('Erro ao gerar vídeo:', error);
    
    // Limpar arquivos temporários em caso de erro
    if (tempFiles.length > 0) {
      await cleanupTempFiles(tempFiles);
    }

    return res.status(500).json({ error: 'Erro ao gerar vídeo' });
  }
};

/**
 * Faz download do vídeo gerado
 */
export const downloadVideo = async (req, res) => {
  try {
    const { fileName } = req.params;
    const filePath = path.join(__dirname, '../../uploads/temp', fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('Erro ao fazer download:', err);
        return res.status(500).json({ error: 'Erro ao fazer download do vídeo' });
      }

      // Limpar arquivo após download (opcional)
      // setTimeout(() => {
      //   cleanupTempFiles([filePath]);
      // }, 60000); // 1 minuto
    });
  } catch (error) {
    console.error('Erro no download:', error);
    return res.status(500).json({ error: 'Erro ao fazer download do vídeo' });
  }
};
