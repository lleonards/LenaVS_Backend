import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { createClient } from '@supabase/supabase-js';
import {
  BASE_URL,
  ALLOWED_VIDEO_EXTENSIONS,
  buildDownloadFileName,
  resolveGeneratedVideoPath,
} from '../services/videoGenerationService.js';
import { getVideoTaskQueue } from '../services/videoTaskQueue.js';
import { hasUnlimitedAccess } from '../utils/access.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const queue = getVideoTaskQueue();
const AVAILABLE_EXPORT_RESOLUTIONS = new Set(['360p', '480p', '720p']);
const SOON_EXPORT_RESOLUTIONS = new Set(['1080p']);
const REMOVED_EXPORT_RESOLUTIONS = new Set(['4k', '4K']);
const AUDIO_DURATION_LIMIT_SECONDS = 15 * 60;
const AUDIO_DURATION_FIELDS = new Set(['musicaOriginal', 'musicaInstrumental']);

const removeUploadedFileIfExists = async (filePath) => {
  if (!filePath) return;

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('Não foi possível remover o arquivo inválido:', filePath, error.message);
    }
  }
};

const getMediaDurationInSeconds = (filePath) => new Promise((resolve, reject) => {
  ffmpeg.ffprobe(filePath, (error, metadata) => {
    if (error) {
      reject(error);
      return;
    }

    resolve(Number(metadata?.format?.duration) || 0);
  });
});

const validateUploadedAudioDurations = async (files = {}) => {
  for (const [fieldName, fieldFiles] of Object.entries(files)) {
    if (!AUDIO_DURATION_FIELDS.has(fieldName)) {
      continue;
    }

    const uploadedFile = fieldFiles?.[0];
    if (!uploadedFile?.path) {
      continue;
    }

    let duration = 0;

    try {
      duration = await getMediaDurationInSeconds(uploadedFile.path);
    } catch (error) {
      await removeUploadedFileIfExists(uploadedFile.path);
      const validationError = new Error('Não foi possível validar a duração do áudio enviado. Tente outro arquivo.');
      validationError.status = 400;
      throw validationError;
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      await removeUploadedFileIfExists(uploadedFile.path);
      const validationError = new Error('Não foi possível validar a duração do áudio enviado. Tente outro arquivo.');
      validationError.status = 400;
      throw validationError;
    }

    if (duration >= AUDIO_DURATION_LIMIT_SECONDS) {
      await removeUploadedFileIfExists(uploadedFile.path);
      const audioLabel = fieldName === 'musicaOriginal' ? 'música original' : 'música instrumental';
      const validationError = new Error(`A ${audioLabel} precisa ter menos de 15 minutos (máximo 14:59).`);
      validationError.status = 400;
      throw validationError;
    }
  }
};

/* =====================================================
   📤 UPLOAD
===================================================== */

export const uploadMedia = async (req, res) => {
  try {
    const uploadedFiles = {};

    if (req.files) {
      await validateUploadedAudioDurations(req.files);
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
    return res.status(error.status || 500).json({ error: error.message || 'Erro ao fazer upload' });
  }
};

/* =====================================================
   🎬 GERAR VÍDEO
===================================================== */

export const generateVideo = async (req, res) => {
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
    } = req.body || {};

    if (!projectName || !audioPath) {
      return res.status(400).json({ error: 'Dados insuficientes para gerar o vídeo' });
    }

    const normalizedResolution = String(resolution || '720p');

    if (SOON_EXPORT_RESOLUTIONS.has(normalizedResolution)) {
      return res.status(400).json({ error: '1080p disponível em breve.' });
    }

    if (REMOVED_EXPORT_RESOLUTIONS.has(normalizedResolution) || !AVAILABLE_EXPORT_RESOLUTIONS.has(normalizedResolution)) {
      return res.status(400).json({ error: 'Resolução inválida para exportação.' });
    }

    const task = await queue.enqueueTask({
      userId,
      payload: {
        projectName,
        audioPath,
        backgroundType,
        backgroundPath,
        backgroundColor,
        resolution: normalizedResolution,
        videoFormat,
        stanzas,
      },
    });

    const completedTask = await queue.waitForCompletion(
      task.id,
      queue.getSynchronousResponseTimeoutMs()
    );

    if (!completedTask) {
      return res.status(500).json({ error: 'Não foi possível acompanhar o processamento do vídeo' });
    }

    if (completedTask.status === 'completed' && completedTask.result) {
      return res.status(200).json({
        success: true,
        taskId: completedTask.id,
        status: 'completed',
        progress: 100,
        videoUrl: completedTask.result.videoUrl,
        fileName: completedTask.result.fileName,
        downloadFileName: completedTask.result.downloadFileName,
      });
    }

    if (completedTask.status === 'error') {
      return res.status(500).json({
        error: completedTask.error || 'Erro ao gerar vídeo',
        taskId: completedTask.id,
        status: 'error',
      });
    }

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
    console.error('Erro ao gerar vídeo:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Erro ao gerar vídeo' });
  }
};

export const getVideoProcessingStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { taskId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const task = await queue.getPublicTaskStatus(taskId, userId);
    if (!task) {
      return res.status(404).json({ error: 'Processamento não encontrado' });
    }

    return res.status(200).json({
      success: true,
      ...task,
    });
  } catch (error) {
    console.error('Erro ao consultar processamento:', error);
    return res.status(500).json({ error: 'Erro ao consultar processamento do vídeo' });
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

    const filePath = resolveGeneratedVideoPath(userId, fileName);

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, subscription_status, unlimited_access_until')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Usuário não encontrado' });
    }

    const isPro = hasUnlimitedAccess(user);

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
