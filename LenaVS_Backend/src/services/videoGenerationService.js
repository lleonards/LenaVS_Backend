import fs from 'fs';
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
import {
  BACKEND_BASE_URL,
  buildStorageObjectPath,
  createTempFilePath,
  downloadSourceValueToTempFile,
  inferContentType,
  removeLocalFileSilently,
  uploadLocalFileToStorage,
} from './storageService.js';

export const BASE_URL = BACKEND_BASE_URL;
export const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi']);

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

const notifyProgress = async (onProgress, data) => {
  if (typeof onProgress === 'function') {
    await onProgress(data);
  }
};

const resolveMedia = async (fileUrl, {
  prefix,
  fallbackName,
  mimeType = '',
  tempFiles,
}) => {
  const tempPath = await downloadSourceValueToTempFile(fileUrl, {
    prefix,
    fallbackName,
    mimeType,
    folder: 'render-inputs',
  });

  tempFiles.push(tempPath);
  return tempPath;
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

    if (!userId) throw new Error('Usuário não autenticado');
    if (!projectName || !audioPath) {
      throw new Error('Dados insuficientes para gerar o vídeo');
    }

    await notifyProgress(onProgress, {
      progress: 5,
      stage: 'preparing',
      message: 'Preparando arquivos do projeto',
    });

    const audioRealPath = await resolveMedia(audioPath, {
      prefix: 'audio',
      fallbackName: 'audio.mp3',
      tempFiles,
    });

    const audioDuration = await getAudioDuration(audioRealPath);

    let processedBackgroundPath;

    await notifyProgress(onProgress, {
      progress: 18,
      stage: 'background',
      message: 'Preparando fundo do vídeo',
    });

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = await resolveMedia(backgroundPath, {
        prefix: 'background-video',
        fallbackName: 'background.mp4',
        tempFiles,
      });

      processedBackgroundPath = await createTempFilePath({
        prefix: `bg-video-${taskId}`,
        originalName: 'background.mp4',
        fallbackExtension: '.mp4',
        folder: 'render-work',
      });
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = await resolveMedia(backgroundPath, {
        prefix: 'background-image',
        fallbackName: 'background.jpg',
        tempFiles,
      });

      const resizedImage = await createTempFilePath({
        prefix: `resized-${taskId}`,
        originalName: 'background.jpg',
        fallbackExtension: '.jpg',
        folder: 'render-work',
      });
      await resizeImageTo16_9(realImg, resizedImage, resolution);
      tempFiles.push(resizedImage);

      processedBackgroundPath = await createTempFilePath({
        prefix: `bg-image-${taskId}`,
        originalName: 'background.mp4',
        fallbackExtension: '.mp4',
        folder: 'render-work',
      });
      await imageToVideo(resizedImage, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    } else {
      processedBackgroundPath = await createTempFilePath({
        prefix: `bg-color-${taskId}`,
        originalName: 'background.mp4',
        fallbackExtension: '.mp4',
        folder: 'render-work',
      });
      await createColorBackground(backgroundColor || '#000000', audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    }

    let subtitlesPath = null;

    if (Array.isArray(stanzas) && stanzas.length > 0) {
      await notifyProgress(onProgress, {
        progress: 42,
        stage: 'subtitles',
        message: 'Montando legendas do karaokê',
      });

      subtitlesPath = await createTempFilePath({
        prefix: `lyrics-${taskId}`,
        originalName: 'subtitles.ass',
        fallbackExtension: '.ass',
        folder: 'render-work',
      });
      await createAssSubtitleFile(stanzas, subtitlesPath, resolution);
      tempFiles.push(subtitlesPath);
    }

    const safeFormat = normalizeOutputFormat(videoFormat);
    const safeProjectName = sanitizeProjectName(projectName);
    const storedFileName = `${safeProjectName}_${taskId}.${safeFormat}`;
    const downloadFileName = buildDownloadFileName(projectName, safeFormat);

    outputPath = await createTempFilePath({
      prefix: `output-${safeProjectName}`,
      originalName: storedFileName,
      fallbackExtension: `.${safeFormat}`,
      folder: 'render-output',
    });

    await notifyProgress(onProgress, {
      progress: 70,
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
      progress: 92,
      stage: 'uploading',
      message: 'Enviando vídeo final para o Supabase Storage',
    });

    const storagePath = buildStorageObjectPath({
      category: 'generated',
      userId,
      prefix: safeProjectName,
      originalName: storedFileName,
      mimeType: inferContentType({ originalName: storedFileName }),
      fallbackExtension: `.${safeFormat}`,
    });

    const uploadedVideo = await uploadLocalFileToStorage({
      localPath: outputPath,
      storagePath,
      contentType: inferContentType({ originalName: storedFileName }),
    });

    await cleanupTempFiles(tempFiles);
    await removeLocalFileSilently(outputPath);

    return {
      fileName: storedFileName,
      downloadFileName,
      storagePath,
      publicUrl: uploadedVideo.publicUrl,
      videoUrl: `${BASE_URL}/api/video/download/${encodeURIComponent(storedFileName)}?storagePath=${encodeURIComponent(storagePath)}&downloadName=${encodeURIComponent(downloadFileName)}`,
    };
  } catch (error) {
    await cleanupTempFiles(tempFiles);
    await removeLocalFileSilently(outputPath);
    throw error;
  }
};
