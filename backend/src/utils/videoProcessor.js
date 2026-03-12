import ffmpeg from 'fluent-ffmpeg';
import Jimp from 'jimp';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const unlinkAsync = promisify(fs.unlink);

/* =====================================================
   OBTER DURAÇÃO DE ÁUDIO
===================================================== */
export const getAudioDuration = (audioPath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) reject(err);
      else resolve(meta.format.duration);
    });
  });

/* =====================================================
   OBTER DURAÇÃO DE VÍDEO
===================================================== */
export const getVideoDuration = (videoPath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) reject(err);
      else resolve(meta.format.duration);
    });
  });

/* =====================================================
   IMAGEM → VÍDEO (com resolução dinâmica)
===================================================== */
export const imageToVideo = async (imagePath, duration, outputPath, width = 1280, height = 720) =>
  new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop 1', `-t ${duration}`])
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-pix_fmt yuv420p',
        '-r 30',
      ])
      .size(`${width}x${height}`)
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });

/* =====================================================
   AJUSTAR VÍDEO À DURAÇÃO DO ÁUDIO
===================================================== */
export const adjustVideoToAudioDuration = async (
  videoPath, audioDuration, outputPath, width = 1280, height = 720
) => {
  const videoDuration = await getVideoDuration(videoPath);

  return new Promise((resolve, reject) => {
    const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

    if (videoDuration >= audioDuration) {
      ffmpeg()
        .input(videoPath)
        .videoFilter(scaleFilter)
        .setDuration(audioDuration)
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .run();
    } else {
      const loops = Math.ceil(audioDuration / videoDuration);
      ffmpeg()
        .input(videoPath)
        .inputOptions([`-stream_loop ${loops}`])
        .videoFilter(scaleFilter)
        .setDuration(audioDuration)
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .run();
    }
  });
};

/* =====================================================
   REDIMENSIONAR IMAGEM (resolução dinâmica)
===================================================== */
export const resizeImage = async (imagePath, outputPath, width = 1280, height = 720) => {
  try {
    const image = await Jimp.read(imagePath);
    await image.cover(width, height).quality(85).writeAsync(outputPath);
    return outputPath;
  } catch (error) {
    throw new Error(`Erro ao redimensionar imagem: ${error.message}`);
  }
};

// Alias retrocompatível
export const resizeImageTo16_9 = (imagePath, outputPath) =>
  resizeImage(imagePath, outputPath, 1280, 720);

/* =====================================================
   FUNDO COLORIDO (resolução dinâmica)
===================================================== */
export const createColorBackground = (color, duration, outputPath, width = 1280, height = 720) =>
  new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=${color}:s=${width}x${height}:d=${duration}`)
      .inputFormat('lavfi')
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast',
        '-pix_fmt yuv420p',
        '-r 30',
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });

/* =====================================================
   MESCLAR VÍDEO + ÁUDIO
===================================================== */
export const mergeVideoAndAudio = (videoPath, audioPath, outputPath) =>
  new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });

/* =====================================================
   GERAR VÍDEO FINAL
===================================================== */
export const generateFinalVideo = async (backgroundPath, audioPath, outputPath) => {
  return await mergeVideoAndAudio(backgroundPath, audioPath, outputPath);
};

/* =====================================================
   LIMPAR ARQUIVOS TEMP
===================================================== */
export const cleanupTempFiles = async (files) => {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) await unlinkAsync(file);
    } catch (error) {
      console.error(`Erro ao limpar arquivo ${file}:`, error);
    }
  }
};
