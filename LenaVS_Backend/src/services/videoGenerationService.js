import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BASE_URL = (
  process.env.BACKEND_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'http://localhost:10000'
).replace(/\/$/, '');

export const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi']);

const resolveUploadsRoot = () => path.join(__dirname, '../../uploads');
const resolveTempRoot = () => path.join(resolveUploadsRoot(), 'temp');
const resolveExportsRoot = () => path.join(resolveUploadsRoot(), 'exports');

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  return dirPath;
};

export const ensureTempDir = () => ensureDir(resolveTempRoot());
export const ensureExportsDir = () => ensureDir(resolveExportsRoot());

export const ensureUserExportDir = (userId) => {
  const safeUserId = sanitizeProjectName(String(userId || 'anonymous'));
  return ensureDir(path.join(ensureExportsDir(), safeUserId));
};

export const sanitizeProjectName = (value = 'video') => {
  return (
    String(value || 'video')
      .trim()
      .replace(/[^a-z0-9-_]+/gi, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'video'
  );
};

export const sanitizeDownloadBaseName = (value = 'video') => {
  return (
    String(value || 'video')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[.\s]+$/g, '')
      .trim() || 'video'
  );
};

export const buildDownloadFileName = (projectName, format) => {
  const safeFormat = normalizeOutputFormat(format);
  const safeBaseName = sanitizeDownloadBaseName(projectName);
  return `${safeBaseName}.${safeFormat}`;
};

export const resolveUploadPathFromUrl = (fileUrl) => {
  if (!fileUrl || !String(fileUrl).includes('/uploads/')) {
    return null;
  }

  const relativeUploadPath = String(fileUrl).split('/uploads/')[1];
  if (!relativeUploadPath) {
    return null;
  }

  return path.join(resolveUploadsRoot(), relativeUploadPath);
};

export const resolveGeneratedVideoPath = (userId, fileName) => {
  if (!userId || !fileName) {
    return null;
  }

  return path.join(ensureUserExportDir(userId), fileName);
};

export const fileExists = (filePath) => Boolean(filePath && fs.existsSync(filePath));

const notifyProgress = async (onProgress, data) => {
  if (typeof onProgress === 'function') {
    await onProgress(data);
  }
};

export const processVideoGenerationTask = async ({
  taskId,
  userId,
  payload = {},
  onProgress,
}) => {
  const tempFiles = [];
  let outputPath = null;

  try {
    const {
      projectName,
      audioPath,
      backgroundType,
      backgroundPath,
      backgroundColor,
      resolution = '720p',
      videoFormat = 'mp4',
      stanzas = [],
    } = payload;

    if (!userId) {
      throw new Error('Usuário não autenticado');
    }

    if (!projectName || !audioPath) {
      throw new Error('Dados insuficientes para gerar o vídeo');
    }

    await notifyProgress(onProgress, {
      progress: 5,
      stage: 'preparing',
      message: 'Preparando arquivos do projeto',
    });

    const audioRealPath = resolveUploadPathFromUrl(audioPath);
    if (!fileExists(audioRealPath)) {
      throw new Error('Áudio não encontrado');
    }

    const audioDuration = await getAudioDuration(audioRealPath);
    const tempDir = ensureTempDir();
    const exportDir = ensureUserExportDir(userId);

    await notifyProgress(onProgress, {
      progress: 18,
      stage: 'background',
      message: 'Processando fundo do vídeo',
    });

    let processedBackgroundPath;

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = resolveUploadPathFromUrl(backgroundPath);

      if (!fileExists(realBg)) {
        throw new Error('Vídeo de fundo não encontrado');
      }

      processedBackgroundPath = path.join(tempDir, `bg_video_${taskId}.mp4`);
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = resolveUploadPathFromUrl(backgroundPath);

      if (!fileExists(realImg)) {
        throw new Error('Imagem de fundo não encontrada');
      }

      const resizedImage = path.join(tempDir, `resized_${taskId}.jpg`);
      await resizeImageTo16_9(realImg, resizedImage, resolution);
      tempFiles.push(resizedImage);

      processedBackgroundPath = path.join(tempDir, `bg_image_${taskId}.mp4`);
      await imageToVideo(resizedImage, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    } else {
      processedBackgroundPath = path.join(tempDir, `bg_color_${taskId}.mp4`);
      await createColorBackground(backgroundColor || '#000000', audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    }

    let subtitlesPath = null;

    if (Array.isArray(stanzas) && stanzas.length > 0) {
      await notifyProgress(onProgress, {
        progress: 42,
        stage: 'subtitles',
        message: 'Aplicando letras e estilos',
      });

      subtitlesPath = path.join(tempDir, `lyrics_${taskId}.ass`);
      await createAssSubtitleFile(stanzas, subtitlesPath, resolution);
      tempFiles.push(subtitlesPath);
    }

    const safeFormat = normalizeOutputFormat(videoFormat);
    const safeProjectName = sanitizeProjectName(projectName);
    const storedFileName = `${safeProjectName}_${taskId}.${safeFormat}`;
    const downloadFileName = buildDownloadFileName(projectName, safeFormat);
    outputPath = path.join(exportDir, storedFileName);

    if (fs.existsSync(outputPath)) {
      await fs.promises.unlink(outputPath);
    }

    await notifyProgress(onProgress, {
      progress: 68,
      stage: 'rendering',
      message: 'Renderizando vídeo final',
    });

    await generateFinalVideo({
      backgroundPath: processedBackgroundPath,
      audioPath: audioRealPath,
      outputPath,
      subtitlesPath,
      format: safeFormat,
    });

    await notifyProgress(onProgress, {
      progress: 96,
      stage: 'finalizing',
      message: 'Finalizando exportação',
    });

    await cleanupTempFiles(tempFiles);

    return {
      fileName: storedFileName,
      downloadFileName,
      outputPath,
      videoUrl: `${BASE_URL}/api/video/download/${storedFileName}?downloadName=${encodeURIComponent(downloadFileName)}`,
    };
  } catch (error) {
    await cleanupTempFiles(tempFiles);

    if (outputPath && fs.existsSync(outputPath)) {
      try {
        await fs.promises.unlink(outputPath);
      } catch (cleanupError) {
        console.error('Erro ao remover saída parcial:', cleanupError);
      }
    }

    throw error;
  }
};
