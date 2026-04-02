import ffmpeg from 'fluent-ffmpeg';
import Jimp from 'jimp';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const unlinkAsync = promisify(fs.unlink);

/* =====================================================
   RESOLUÇÕES DISPONÍVEIS
===================================================== */
const RESOLUTIONS = {
  '360p':  { width: 640,  height: 360  },
  '480p':  { width: 854,  height: 480  },
  '720p':  { width: 1280, height: 720  },
  '1080p': { width: 1920, height: 1080 },
  '4K':    { width: 3840, height: 2160 },
};

/**
 * Retorna dimensões { width, height } para a resolução informada.
 * Padrão: 720p caso a resolução não seja reconhecida.
 */
export const getResolutionDimensions = (resolution = '720p') => {
  return RESOLUTIONS[resolution] || RESOLUTIONS['720p'];
};

/**
 * Obtém duração de um arquivo de áudio
 */
export const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
};

/**
 * Obtém duração de um arquivo de vídeo
 */
export const getVideoDuration = (videoPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
};

/**
 * Converte imagem em vídeo estático com duração específica
 * @param {string} imagePath
 * @param {number} duration
 * @param {string} outputPath
 * @param {string} resolution  ex: '720p', '1080p'
 */
export const imageToVideo = async (imagePath, duration, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions([
        '-loop 1',
        `-t ${duration}`
      ])
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-pix_fmt yuv420p',
        '-r 30'
      ])
      .size(`${width}x${height}`)
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

/**
 * Corta ou faz loop de vídeo para igualar duração do áudio
 * @param {string} videoPath
 * @param {number} audioDuration
 * @param {string} outputPath
 * @param {string} resolution
 */
export const adjustVideoToAudioDuration = async (videoPath, audioDuration, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  const videoDuration = await getVideoDuration(videoPath);

  return new Promise((resolve, reject) => {
    const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

    if (videoDuration >= audioDuration) {
      ffmpeg()
        .input(videoPath)
        .setDuration(audioDuration)
        .videoFilter(scaleFilter)
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err))
        .run();
    } else {
      const loops = Math.ceil(audioDuration / videoDuration);
      ffmpeg()
        .input(videoPath)
        .inputOptions([`-stream_loop ${loops}`])
        .setDuration(audioDuration)
        .videoFilter(scaleFilter)
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err))
        .run();
    }
  });
};

/**
 * Redimensiona imagem para a proporção 16:9 na resolução escolhida
 * @param {string} imagePath
 * @param {string} outputPath
 * @param {string} resolution
 */
export const resizeImageTo16_9 = async (imagePath, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  try {
    const image = await Jimp.read(imagePath);
    await image
      .cover(width, height)
      .quality(85)
      .writeAsync(outputPath);
    return outputPath;
  } catch (error) {
    throw new Error(`Erro ao redimensionar imagem: ${error.message}`);
  }
};

/**
 * Cria vídeo de fundo colorido na resolução escolhida
 * @param {string} color
 * @param {number} duration
 * @param {string} outputPath
 * @param {string} resolution
 */
export const createColorBackground = (color, duration, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=${color}:s=${width}x${height}:d=${duration}`)
      .inputFormat('lavfi')
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-pix_fmt yuv420p',
        '-r 30'
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

/**
 * Mescla vídeo de fundo com áudio
 */
export const mergeVideoAndAudio = (videoPath, audioPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-shortest'
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

/**
 * Gera vídeo final
 */
export const generateFinalVideo = async (backgroundPath, audioPath, outputPath) => {
  try {
    const finalVideo = await mergeVideoAndAudio(backgroundPath, audioPath, outputPath);
    return finalVideo;
  } catch (error) {
    throw new Error(`Erro ao gerar vídeo final: ${error.message}`);
  }
};

/**
 * Limpa arquivos temporários
 */
export const cleanupTempFiles = async (files) => {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        await unlinkAsync(file);
      }
    } catch (error) {
      console.error(`Erro ao limpar arquivo ${file}:`, error);
    }
  }
};
