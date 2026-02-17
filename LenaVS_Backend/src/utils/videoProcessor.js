import ffmpeg from 'fluent-ffmpeg';
import Jimp from 'jimp';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const unlinkAsync = promisify(fs.unlink);

// Resolução padrão otimizada para VPS de 1GB
const WIDTH = 1280;
const HEIGHT = 720;

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
 */
export const imageToVideo = async (imagePath, duration, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions([
        '-loop 1',
        `-t ${duration}`
      ])
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast', // Mais leve para VPS
        '-pix_fmt yuv420p',
        '-r 30'
      ])
      .size(`${WIDTH}x${HEIGHT}`)
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

/**
 * Corta ou faz loop de vídeo para igualar duração do áudio
 */
export const adjustVideoToAudioDuration = async (videoPath, audioDuration, outputPath) => {
  const videoDuration = await getVideoDuration(videoPath);

  return new Promise((resolve, reject) => {
    if (videoDuration >= audioDuration) {
      ffmpeg()
        .input(videoPath)
        .setDuration(audioDuration)
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err))
        .run();
    } else {
      const loops = Math.ceil(audioDuration / videoDuration);
      ffmpeg()
        .input(videoPath)
        .inputOptions([
          `-stream_loop ${loops}`
        ])
        .setDuration(audioDuration)
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', (err) => reject(err))
        .run();
    }
  });
};

/**
 * Redimensiona imagem para resolução 16:9 (1280x720)
 */
export const resizeImageTo16_9 = async (imagePath, outputPath) => {
  try {
    const image = await Jimp.read(imagePath);
    await image
      .cover(WIDTH, HEIGHT)
      .quality(85) // Leve ajuste para reduzir peso
      .writeAsync(outputPath);
    return outputPath;
  } catch (error) {
    throw new Error(`Erro ao redimensionar imagem: ${error.message}`);
  }
};

/**
 * Cria vídeo de fundo colorido em 720p
 */
export const createColorBackground = (color, duration, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=${color}:s=${WIDTH}x${HEIGHT}:d=${duration}`)
      .inputFormat('lavfi')
      .outputOptions([
        '-c:v libx264',
        '-preset veryfast', // Mais leve
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
