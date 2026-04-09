import path from 'path';
import fs from 'fs';
import axios from 'axios';
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
  if (!relativeUploadPath) return null;

  return path.join(resolveUploadsRoot(), relativeUploadPath);
};

export const resolveGeneratedVideoPath = (userId, fileName) => {
  if (!userId || !fileName) return null;
  return path.join(ensureUserExportDir(userId), fileName);
};

export const fileExists = (filePath) => Boolean(filePath && fs.existsSync(filePath));

const notifyProgress = async (onProgress, data) => {
  if (typeof onProgress === 'function') {
    await onProgress(data);
  }
};

//////////////////////////////////////////////////////
// 🔥 NOVO: DOWNLOAD DE ARQUIVOS REMOTOS
//////////////////////////////////////////////////////

const downloadRemoteFile = async (url, outputPath) => {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);

    response.data.pipe(writer);

    writer.on('finish', () => resolve(outputPath));
    writer.on('error', reject);
  });
};

//////////////////////////////////////////////////////
// 🔥 NOVO: RESOLVER LOCAL OU REMOTO
//////////////////////////////////////////////////////

const resolveMedia = async (fileUrl, tempDir, tempFiles, prefix) => {
  // arquivo local
  if (fileUrl.includes('/uploads/')) {
    const localPath = resolveUploadPathFromUrl(fileUrl);
    if (!fileExists(localPath)) {
      throw new Error('Arquivo não encontrado');
    }
    return localPath;
  }

  // arquivo remoto (biblioteca)
  const ext = path.extname(fileUrl).split('?')[0] || '.tmp';
  const tempPath = path.join(tempDir, `${prefix}_${Date.now()}${ext}`);

  await downloadRemoteFile(fileUrl, tempPath);

  tempFiles.push(tempPath);

  return tempPath;
};

//////////////////////////////////////////////////////
// 🎬 PROCESSAMENTO PRINCIPAL
//////////////////////////////////////////////////////

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

    const tempDir = ensureTempDir();
    const exportDir = ensureUserExportDir(userId);

    await notifyProgress(onProgress, {
      progress: 5,
      stage: 'preparing',
    });

    //////////////////////////////////////////////////////
    // 🔥 ÁUDIO (CORRIGIDO)
    //////////////////////////////////////////////////////
    const audioRealPath = await resolveMedia(
      audioPath,
      tempDir,
      tempFiles,
      'audio'
    );

    const audioDuration = await getAudioDuration(audioRealPath);

    //////////////////////////////////////////////////////
    // 🔥 BACKGROUND (CORRIGIDO)
    //////////////////////////////////////////////////////
    let processedBackgroundPath;

    await notifyProgress(onProgress, {
      progress: 18,
      stage: 'background',
    });

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = await resolveMedia(
        backgroundPath,
        tempDir,
        tempFiles,
        'bg'
      );

      processedBackgroundPath = path.join(tempDir, `bg_video_${taskId}.mp4`);
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath, resolution);
      tempFiles.push(processedBackgroundPath);
    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = await resolveMedia(
        backgroundPath,
        tempDir,
        tempFiles,
        'img'
      );

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

    //////////////////////////////////////////////////////
    // LEGENDAS
    //////////////////////////////////////////////////////
    let subtitlesPath = null;

    if (Array.isArray(stanzas) && stanzas.length > 0) {
      await notifyProgress(onProgress, {
        progress: 42,
        stage: 'subtitles',
      });

      subtitlesPath = path.join(tempDir, `lyrics_${taskId}.ass`);
      await createAssSubtitleFile(stanzas, subtitlesPath, resolution);
      tempFiles.push(subtitlesPath);
    }

    //////////////////////////////////////////////////////
    // RENDER FINAL
    //////////////////////////////////////////////////////
    const safeFormat = normalizeOutputFormat(videoFormat);
    const safeProjectName = sanitizeProjectName(projectName);
    const storedFileName = `${safeProjectName}_${taskId}.${safeFormat}`;
    const downloadFileName = buildDownloadFileName(projectName, safeFormat);

    outputPath = path.join(exportDir, storedFileName);

    await notifyProgress(onProgress, {
      progress: 70,
      stage: 'rendering',
    });

    await generateFinalVideo({
      backgroundPath: processedBackgroundPath,
      audioPath: audioRealPath,
      outputPath,
      subtitlesPath,
      format: safeFormat,
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
      } catch {}
    }

    throw error;
  }
};