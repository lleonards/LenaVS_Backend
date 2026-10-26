import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import { supabase } from '../config/supabase.js';
import {
  ALLOWED_VIDEO_EXTENSIONS,
  buildDownloadFileName,
} from '../services/videoGenerationService.js';
import { getVideoTaskQueue } from '../services/videoTaskQueue.js';
import { hasUnlimitedAccess } from '../utils/access.js';
import { GENERIC_ERROR_MESSAGE, logInternalError } from '../utils/publicError.js';
import {
  STORAGE_BUCKET,
  getStorageAccessUrl,
  inferContentType,
  removeLocalFileSilently,
  uploadRequestFileToStorage,
} from '../services/storageService.js';

const queue = getVideoTaskQueue();
const MAX_AUDIO_DURATION_MINUTES = Number(process.env.MAX_AUDIO_DURATION_MINUTES || 15);
const MAX_AUDIO_DURATION_SECONDS = Math.max(60, MAX_AUDIO_DURATION_MINUTES * 60);
const AUDIO_UPLOAD_FIELDS = new Set(['musicaOriginal', 'musicaInstrumental']);

const roundDuration = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Number(numeric.toFixed(3)) : null;
};

const getMediaDurationInSeconds = (filePath, streamType = null) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(filePath, (error, metadata) => {
    if (error) {
      reject(error);
      return;
    }

    const matchingStream = streamType
      ? metadata?.streams?.find((stream) => stream.codec_type === streamType)
      : metadata?.streams?.find((stream) => stream.codec_type === 'video') || metadata?.streams?.find((stream) => stream.codec_type === 'audio');

    const duration = Number(matchingStream?.duration || metadata?.format?.duration || 0);
    resolve(duration);
  });
});

const getAudioDurationInSeconds = (filePath) => getMediaDurationInSeconds(filePath, 'audio');

const getUploadedMediaKind = (fieldName, file) => {
  if (fieldName === 'imagem') return 'image';
  if (fieldName === 'video') return 'video';
  if (AUDIO_UPLOAD_FIELDS.has(fieldName)) return 'audio';

  const normalizedMime = String(file?.mimetype || '').toLowerCase();
  if (normalizedMime.startsWith('video/')) return 'video';
  return 'audio';
};

const extractUploadedMediaMetadata = async (fieldName, file) => {
  const kind = getUploadedMediaKind(fieldName, file);

  if (kind === 'image') {
    return { kind, duration: null };
  }

  try {
    const duration = await getMediaDurationInSeconds(file.path, kind === 'video' ? 'video' : 'audio');
    return {
      kind,
      duration: roundDuration(duration),
    };
  } catch (error) {
    console.warn(`Não foi possível extrair metadados de ${fieldName}:`, error.message);
    return { kind, duration: null };
  }
};

const validateAudioUploadDurations = async (filesMap = {}) => {
  for (const [fieldName, files] of Object.entries(filesMap || {})) {
    if (!AUDIO_UPLOAD_FIELDS.has(fieldName)) continue;

    for (const file of files || []) {
      let durationInSeconds;

      try {
        durationInSeconds = await getAudioDurationInSeconds(file.path);
      } catch (error) {
        await removeLocalFileSilently(file.path);
        const readError = new Error(
          `Não foi possível ler o áudio "${file.originalname}". Confirme que ele abre normalmente e tente novamente.`
        );
        readError.code = 'MEDIA_READ_ERROR';
        readError.fileName = file.originalname;
        readError.status = 422;
        throw readError;
      }

      if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) {
        await removeLocalFileSilently(file.path);
        const error = new Error(
          `Não foi possível ler a duração do áudio "${file.originalname}". Tente novamente com outro arquivo.`
        );
        error.code = 'MEDIA_READ_ERROR';
        error.fileName = file.originalname;
        error.status = 400;
        throw error;
      }

      if (durationInSeconds > MAX_AUDIO_DURATION_SECONDS) {
        await removeLocalFileSilently(file.path);
        const error = new Error(`O áudio passa de ${MAX_AUDIO_DURATION_MINUTES} minutos. Envie uma música com até ${MAX_AUDIO_DURATION_MINUTES} minutos.`);
        error.code = 'AUDIO_TOO_LONG';
        error.fileName = file.originalname;
        error.status = 400;
        throw error;
      }
    }
  }
};

const encodeDownloadFileName = (fileName) => encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const streamPublicFileToResponse = async ({ publicUrl, res, downloadName, fallbackContentType }) => {
  const response = await axios({
    url: publicUrl,
    method: 'GET',
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 120000,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');
  res.setHeader('Content-Type', response.headers['content-type'] || fallbackContentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeDownloadFileName(downloadName)}`);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (response.headers['content-length']) {
    res.setHeader('Content-Length', response.headers['content-length']);
  }

  response.data.pipe(res);
};

export const uploadMedia = async (req, res) => {
  let activeFileName = null;

  try {
    const userId = req.user?.id;
    const uploadedFiles = {};
    const uploadedMetadata = {};

    if (!userId) {
      return res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Entre na sua conta para continuar.',
      });
    }

    if (req.files) {
      await validateAudioUploadDurations(req.files);

      for (const [fieldName, files] of Object.entries(req.files)) {
        const file = files?.[0];
        if (!file) continue;
        activeFileName = file.originalname;

        const extractedMetadata = await extractUploadedMediaMetadata(fieldName, file);
        const uploaded = await uploadRequestFileToStorage(file, {
          userId,
          category: `media/${fieldName}`,
          prefix: fieldName,
        });

        uploadedFiles[fieldName] = uploaded.publicUrl;
        uploadedMetadata[fieldName] = {
          ...extractedMetadata,
          publicUrl: uploaded.publicUrl,
          storagePath: uploaded.storagePath,
          bucket: uploaded.bucket,
        };
      }
    }

    if (!Object.keys(uploadedFiles).length) {
      return res.status(400).json({
        code: 'NO_FILE_UPLOADED',
        error: 'Escolha um arquivo para enviar.',
      });
    }

    return res.status(200).json({
      success: true,
      files: uploadedFiles,
      metadata: uploadedMetadata,
    });
  } catch (error) {
    // Erros previstos (arquivo grande/longo/ilegível) têm mensagem própria e
    // acionável. Qualquer outro é falha interna: detalhe só no log do servidor.
    const isUserActionable = Boolean(error?.code) && Number(error?.status) > 0 && Number(error?.status) < 500;

    if (!isUserActionable) {
      logInternalError('video:upload', error, { fileName: error?.fileName || activeFileName });
    }

    return res.status(error.status || 500).json({
      code: error.code || 'UPLOAD_ERROR',
      fileName: error.fileName || activeFileName,
      error: isUserActionable
        ? error.message
        : 'Não foi possível enviar o arquivo. Tente novamente.',
    });
  }
};

export const generateVideo = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Entre na sua conta para continuar.',
      });
    }

    const {
      projectName,
      audioPath,
      backgroundType,
      backgroundPath,
      backgroundColor,
      mediaAnimation = undefined,
      resolution = '720p',
      videoFormat = 'mp4',
      stanzas = [],
      audioBucket = STORAGE_BUCKET,
      backgroundBucket = STORAGE_BUCKET,
    } = req.body || {};

    if (!projectName || !audioPath) {
      return res.status(400).json({
        code: 'MISSING_EXPORT_DATA',
        error: !projectName
          ? 'Dê um nome ao projeto antes de exportar.'
          : 'Faça o upload da música para exportar o vídeo.',
      });
    }

    const task = await queue.enqueueTask({
      userId,
      payload: {
        projectName,
        audioPath,
        audioBucket,
        backgroundType,
        backgroundPath,
        backgroundBucket,
        backgroundColor,
        mediaAnimation,
        resolution,
        videoFormat,
        stanzas,
      },
    });

    const publicTask = await queue.getPublicTaskStatus(task.id, userId);
    return res.status(202).json({
      success: true,
      taskId: task.id,
      ...(publicTask || {
        status: 'processing',
        progress: 0,
        message: 'Seu vídeo está sendo processado',
      }),
    });
  } catch (error) {
    logInternalError('video:generate', error);

    if (Number(error?.status) === 503) {
      return res.status(503).json({
        code: 'QUEUE_BUSY',
        error: 'Estamos com muitas exportações no momento. Tente novamente em instantes.',
      });
    }

    return res.status(error.status || 500).json({
      code: error.code || 'GENERATE_FAILED',
      error: error.status && error.status < 500
        ? error.message
        : 'Não foi possível iniciar a exportação. Tente novamente.',
    });
  }
};

export const getVideoProcessingStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { taskId } = req.params;

    if (!userId) {
      return res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Entre na sua conta para continuar.',
      });
    }

    const task = await queue.getPublicTaskStatus(taskId, userId);
    if (!task) {
      return res.status(404).json({
        code: 'TASK_NOT_FOUND',
        error: 'Não encontramos esta exportação. Inicie a exportação novamente.',
      });
    }

    return res.status(200).json({
      success: true,
      ...task,
    });
  } catch (error) {
    logInternalError('video:status', error);
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: GENERIC_ERROR_MESSAGE,
    });
  }
};

export const downloadVideo = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        code: 'AUTH_REQUIRED',
        error: 'Entre na sua conta para continuar.',
      });
    }

    const { fileName } = req.params;
    const extension = path.extname(fileName || '').toLowerCase();

    if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
      return res.status(400).json({
        code: 'INVALID_DOWNLOAD_FILE',
        error: 'Não foi possível baixar este arquivo. Exporte o vídeo novamente.',
      });
    }

    const storagePath = String(req.query?.storagePath || '').trim();
    if (!storagePath) {
      return res.status(400).json({
        code: 'MISSING_DOWNLOAD_REFERENCE',
        error: 'Não encontramos o vídeo gerado. Exporte novamente.',
      });
    }

    const storageSegments = storagePath.split('/').filter(Boolean);
    if (storageSegments.length < 2 || storageSegments[1] !== String(userId)) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: 'Este vídeo não está disponível na sua conta.',
      });
    }

    const accessUrl = await getStorageAccessUrl(storagePath, { bucket: STORAGE_BUCKET });
    if (!accessUrl) {
      return res.status(404).json({
        code: 'VIDEO_NOT_FOUND',
        error: 'O vídeo não foi encontrado. Exporte novamente.',
      });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status, unlimited_access_until')
      .eq('id', userId)
      .single();

    if (error || !user) {
      logInternalError('video:download:user', error);
      return res.status(403).json({
        code: 'USER_NOT_FOUND',
        error: 'Não foi possível confirmar sua conta. Entre novamente para continuar.',
      });
    }

    const isPro = hasUnlimitedAccess(user);

    if (!isPro) {
      if (!user.credits || user.credits <= 0) {
        return res.status(403).json({
          error: 'Seus créditos acabaram. Escolha o plano ilimitado para continuar.',
          code: 'NO_CREDITS',
        });
      }

      const { error: updateError } = await supabase
        .from('users')
        .update({ credits: user.credits - 1 })
        .eq('id', userId)
        .gt('credits', 0);

      if (updateError) {
        logInternalError('video:download:credits', updateError);
        return res.status(500).json({
          code: 'INTERNAL_ERROR',
          error: 'Não foi possível concluir a operação. Tente novamente.',
        });
      }
    }

    const requestedDownloadName = req.query?.downloadName;
    const downloadName = buildDownloadFileName(
      typeof requestedDownloadName === 'string' && requestedDownloadName.trim()
        ? requestedDownloadName.replace(/\.[a-z0-9]+$/i, '')
        : path.parse(fileName).name,
      extension.replace('.', '')
    );

    await streamPublicFileToResponse({
      publicUrl: accessUrl,
      res,
      downloadName,
      fallbackContentType: inferContentType({ originalName: fileName }),
    });
  } catch (error) {
    logInternalError('video:download', error);
    const status = error?.response?.status === 404 ? 404 : 500;

    return res.status(status).json({
      code: status === 404 ? 'VIDEO_NOT_FOUND' : 'DOWNLOAD_FAILED',
      error: status === 404
        ? 'O vídeo não foi encontrado. Exporte novamente.'
        : 'Não foi possível baixar o vídeo. Tente novamente.',
    });
  }
};
