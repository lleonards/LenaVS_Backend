import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  getAudioDuration,
  imageToVideo,
  adjustVideoToAudioDuration,
  resizeImageTo16_9,
  createColorBackground,
  generateFinalVideo,
  cleanupTempFiles,
  getResolutionDimensions,
} from '../utils/videoProcessor.js';
import { buildAssSubtitleContent } from '../utils/subtitleRenderer.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = (
  process.env.BACKEND_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'http://localhost:10000'
).replace(/\/$/, '');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TEMP_UPLOADS_DIR = path.join(__dirname, '../../uploads/temp');
const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4']);

const ensureTempDir = () => {
  if (!fs.existsSync(TEMP_UPLOADS_DIR)) {
    fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });
  }
};

const resolveUploadedFilePath = (uploadedUrl) => {
  if (!uploadedUrl || typeof uploadedUrl !== 'string' || !uploadedUrl.includes('/uploads/')) {
    return null;
  }

  return path.join(__dirname, '../../uploads', uploadedUrl.split('/uploads/')[1]);
};

const sanitizeProjectFileName = (value = 'Projeto') => {
  const sanitized = String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return sanitized || 'Projeto';
};

/* =====================================================
   📤 UPLOAD
===================================================== */

export const uploadMedia = async (req, res) => {
  try {
    const uploadedFiles = {};

    if (req.files) {
      const mapFile = (file) => {
        const relativePath = file.path.split('uploads')[1].replace(/\\/g, '/');
        return `${BASE_URL}/uploads${relativePath}`;
      };

      Object.keys(req.files).forEach((key) => {
        uploadedFiles[key] = mapFile(req.files[key][0]);
      });
    }

    return res.status(200).json({
      success: true,
      files: uploadedFiles
    });

  } catch (error) {
    console.error('Erro no upload:', error);
    return res.status(500).json({ error: 'Erro ao fazer upload' });
  }
};

/* =====================================================
   🎬 GERAR VÍDEO
===================================================== */

export const generateVideo = async (req, res) => {
  const tempFiles = [];

  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const {
      projectName,
      audioPath,
      backgroundType,
      backgroundPath,
      backgroundColor,
      resolution = '720p',
      stanzas = [],
    } = req.body;

    if (!projectName || !audioPath) {
      return res.status(400).json({ error: 'Dados insuficientes para exportação' });
    }

    const audioRealPath = resolveUploadedFilePath(audioPath);

    if (!audioRealPath || !fs.existsSync(audioRealPath)) {
      return res.status(404).json({ error: 'Áudio não encontrado' });
    }

    ensureTempDir();

    const audioDuration = await getAudioDuration(audioRealPath);
    let processedBackgroundPath;

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = resolveUploadedFilePath(backgroundPath);

      if (!realBg || !fs.existsSync(realBg)) {
        return res.status(404).json({ error: 'Vídeo de fundo não encontrado' });
      }

      processedBackgroundPath = path.join(TEMP_UPLOADS_DIR, `bg_video_${Date.now()}.mp4`);
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);

    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = resolveUploadedFilePath(backgroundPath);

      if (!realImg || !fs.existsSync(realImg)) {
        return res.status(404).json({ error: 'Imagem de fundo não encontrada' });
      }

      const resizedImage = path.join(TEMP_UPLOADS_DIR, `resized_${Date.now()}.jpg`);
      await resizeImageTo16_9(realImg, resizedImage, resolution);
      tempFiles.push(resizedImage);

      processedBackgroundPath = path.join(TEMP_UPLOADS_DIR, `bg_image_${Date.now()}.mp4`);
      await imageToVideo(resizedImage, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);

    } else {
      processedBackgroundPath = path.join(TEMP_UPLOADS_DIR, `bg_color_${Date.now()}.mp4`);
      await createColorBackground(backgroundColor || '000000', audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    }

    const dimensions = getResolutionDimensions(resolution);
    const assSubtitleContent = buildAssSubtitleContent(stanzas, dimensions);
    let subtitlePath = null;

    if (assSubtitleContent) {
      subtitlePath = path.join(TEMP_UPLOADS_DIR, `subtitles_${Date.now()}.ass`);
      fs.writeFileSync(subtitlePath, assSubtitleContent, 'utf8');
      tempFiles.push(subtitlePath);
    }

    const outputFileName = `${sanitizeProjectFileName(projectName)}_${Date.now()}.mp4`;
    const outputPath = path.join(TEMP_UPLOADS_DIR, outputFileName);

    await generateFinalVideo(processedBackgroundPath, audioRealPath, outputPath, subtitlePath);
    await cleanupTempFiles(tempFiles);

    return res.status(200).json({
      success: true,
      fileName: outputFileName,
      downloadPath: `/api/video/download/${encodeURIComponent(outputFileName)}`,
      videoUrl: `${BASE_URL}/api/video/download/${encodeURIComponent(outputFileName)}`,
    });

  } catch (error) {
    console.error('Erro ao gerar vídeo:', error);
    await cleanupTempFiles(tempFiles);
    return res.status(500).json({ error: 'Erro ao gerar vídeo' });
  }
};

/* =====================================================
   ⬇ DOWNLOAD (1 DOWNLOAD = 1 CRÉDITO)
===================================================== */

export const downloadVideo = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const { fileName } = req.params;
    const extension = path.extname(String(fileName || '')).toLowerCase();

    if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
      return res.status(400).json({ error: 'Arquivo inválido' });
    }

    const filePath = path.join(TEMP_UPLOADS_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Usuário não encontrado' });
    }

    const isPro =
      user.plan === 'pro' &&
      user.subscription_status === 'active';

    if (!isPro) {
      const availableCredits = Number(user.credits) || 0;

      if (availableCredits <= 0) {
        return res.status(403).json({
          error: 'Créditos esgotados',
          code: 'NO_CREDITS'
        });
      }

      const { error: updateError } = await supabase
        .from('users')
        .update({ credits: availableCredits - 1 })
        .eq('id', userId)
        .gt('credits', 0);

      if (updateError) {
        return res.status(500).json({ error: 'Erro ao atualizar créditos' });
      }
    }

    return res.download(filePath, fileName);

  } catch (error) {
    console.error('Erro no download:', error);
    return res.status(500).json({ error: 'Erro ao fazer download' });
  }
};
