import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  getAudioDuration,
  imageToVideo,
  adjustVideoToAudioDuration,
  resizeImageTo16_9,
  createColorBackground,
  createAssSubtitleFile,
  generateFinalVideo,
  cleanupTempFiles,
  normalizeOutputFormat,
} from '../utils/videoProcessor.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = (
  process.env.BACKEND_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'http://localhost:10000'
).replace(/\/$/, '');

const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi']);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ensureTempDir = () => {
  const tempDir = path.join(__dirname, '../../uploads/temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
};

const sanitizeProjectName = (value = 'video') => {
  return String(value || 'video')
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'video';
};

const sanitizeDownloadBaseName = (value = 'video') => {
  return String(value || 'video')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim() || 'video';
};

const buildDownloadFileName = (projectName, format) => {
  const safeFormat = normalizeOutputFormat(format);
  const safeBaseName = sanitizeDownloadBaseName(projectName);
  return `${safeBaseName}.${safeFormat}`;
};

const resolveUploadPathFromUrl = (fileUrl) => {
  if (!fileUrl || !String(fileUrl).includes('/uploads/')) {
    return null;
  }

  const relativeUploadPath = String(fileUrl).split('/uploads/')[1];
  if (!relativeUploadPath) {
    return null;
  }

  return path.join(__dirname, '../../uploads', relativeUploadPath);
};

const fileExists = (filePath) => Boolean(filePath && fs.existsSync(filePath));

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
      files: uploadedFiles,
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
      videoFormat = 'mp4',
      stanzas = [],
    } = req.body;

    if (!projectName || !audioPath) {
      return res.status(400).json({ error: 'Dados insuficientes para gerar o vídeo' });
    }

    const audioRealPath = resolveUploadPathFromUrl(audioPath);
    if (!fileExists(audioRealPath)) {
      return res.status(404).json({ error: 'Áudio não encontrado' });
    }

    const audioDuration = await getAudioDuration(audioRealPath);
    const tempDir = ensureTempDir();

    let processedBackgroundPath;

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = resolveUploadPathFromUrl(backgroundPath);

      if (!fileExists(realBg)) {
        return res.status(404).json({ error: 'Vídeo de fundo não encontrado' });
      }

      processedBackgroundPath = path.join(tempDir, `bg_video_${Date.now()}.mp4`);
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = resolveUploadPathFromUrl(backgroundPath);

      if (!fileExists(realImg)) {
        return res.status(404).json({ error: 'Imagem de fundo não encontrada' });
      }

      const resizedImage = path.join(tempDir, `resized_${Date.now()}.jpg`);
      await resizeImageTo16_9(realImg, resizedImage, resolution);
      tempFiles.push(resizedImage);

      processedBackgroundPath = path.join(tempDir, `bg_image_${Date.now()}.mp4`);
      await imageToVideo(resizedImage, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    } else {
      processedBackgroundPath = path.join(tempDir, `bg_color_${Date.now()}.mp4`);
      await createColorBackground(backgroundColor || '#000000', audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    }

    let subtitlesPath = null;
    if (Array.isArray(stanzas) && stanzas.length > 0) {
      subtitlesPath = path.join(tempDir, `lyrics_${Date.now()}.ass`);
      await createAssSubtitleFile(stanzas, subtitlesPath, resolution);
      tempFiles.push(subtitlesPath);
    }

    const safeFormat = normalizeOutputFormat(videoFormat);
    const safeProjectName = sanitizeProjectName(projectName);
    const downloadFileName = buildDownloadFileName(projectName, safeFormat);
    const storedFileName = `${safeProjectName}_${Date.now()}.${safeFormat}`;
    const outputPath = path.join(tempDir, storedFileName);

    await generateFinalVideo({
      backgroundPath: processedBackgroundPath,
      audioPath: audioRealPath,
      outputPath,
      subtitlesPath,
      format: safeFormat,
    });

    await cleanupTempFiles(tempFiles);

    return res.status(200).json({
      success: true,
      videoUrl: `${BASE_URL}/api/video/download/${storedFileName}?downloadName=${encodeURIComponent(downloadFileName)}`,
      fileName: storedFileName,
      downloadFileName,
    });
  } catch (error) {
    console.error('Erro ao gerar vídeo:', error);
    await cleanupTempFiles(tempFiles);
    return res.status(500).json({ error: error.message || 'Erro ao gerar vídeo' });
  }
};

/* =====================================================
   ⬇ DOWNLOAD (1 download = 1 crédito para plano free)
===================================================== */

export const downloadVideo = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const { fileName } = req.params;
    const extension = path.extname(fileName || '').toLowerCase();

    if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
      return res.status(400).json({ error: 'Arquivo inválido para download' });
    }

    const filePath = path.join(__dirname, '../../uploads/temp', fileName);

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

    const isPro = user.plan === 'pro' && user.subscription_status === 'active';

    if (!isPro) {
      if (!user.credits || user.credits <= 0) {
        return res.status(403).json({
          error: 'Créditos esgotados',
          code: 'NO_CREDITS',
        });
      }

      const { error: updateError } = await supabase
        .from('users')
        .update({ credits: user.credits - 1 })
        .eq('id', userId)
        .gt('credits', 0);

      if (updateError) {
        return res.status(500).json({ error: 'Erro ao atualizar créditos' });
      }
    }

    const requestedDownloadName = req.query?.downloadName;
    const downloadName = buildDownloadFileName(
      typeof requestedDownloadName === 'string' && requestedDownloadName.trim()
        ? requestedDownloadName.replace(/\.[a-z0-9]+$/i, '')
        : path.parse(fileName).name,
      extension.replace('.', '')
    );

    return res.download(filePath, downloadName);
  } catch (error) {
    console.error('Erro no download:', error);
    return res.status(500).json({ error: 'Erro ao fazer download' });
  }
};
