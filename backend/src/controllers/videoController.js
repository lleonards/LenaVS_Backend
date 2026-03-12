import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  getAudioDuration,
  imageToVideo,
  adjustVideoToAudioDuration,
  resizeImage,
  createColorBackground,
  generateFinalVideo,
  cleanupTempFiles,
} from '../utils/videoProcessor.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const BASE_URL = process.env.BACKEND_URL;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =====================================================
   MAPA DE RESOLUÇÕES
===================================================== */
const RESOLUTIONS = {
  '480p':  { width: 854,  height: 480  },
  '720p':  { width: 1280, height: 720  },
  '1080p': { width: 1920, height: 1080 },
  '4k':    { width: 3840, height: 2160 },
};

const getResolution = (res) => RESOLUTIONS[res] || RESOLUTIONS['720p'];

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

    return res.status(200).json({ success: true, files: uploadedFiles });
  } catch (error) {
    console.error('Erro no upload:', error);
    return res.status(500).json({ error: 'Erro ao fazer upload' });
  }
};

/* =====================================================
   🎬 GERAR VÍDEO
===================================================== */
export const generateVideo = async (req, res) => {
  let tempFiles = [];

  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Usuário não autenticado' });

    const {
      projectName,
      audioPath,
      backgroundType,
      backgroundPath,
      backgroundColor,
      resolution = '720p',
      is_public  = false,
    } = req.body;

    if (!projectName || !audioPath) {
      return res.status(400).json({ error: 'Dados insuficientes' });
    }

    const { width, height } = getResolution(resolution);

    const audioRealPath = path.join(
      __dirname, '../../uploads',
      audioPath.split('/uploads/')[1]
    );

    if (!fs.existsSync(audioRealPath)) {
      return res.status(404).json({ error: 'Áudio não encontrado' });
    }

    const audioDuration = await getAudioDuration(audioRealPath);

    const tempDir = path.join(__dirname, '../../uploads/temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let processedBackgroundPath;

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = path.join(__dirname, '../../uploads', backgroundPath.split('/uploads/')[1]);
      processedBackgroundPath = path.join(tempDir, `bg_video_${Date.now()}.mp4`);
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath, width, height);
      tempFiles.push(processedBackgroundPath);

    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = path.join(__dirname, '../../uploads', backgroundPath.split('/uploads/')[1]);
      const resizedImage = path.join(tempDir, `resized_${Date.now()}.jpg`);
      await resizeImage(realImg, resizedImage, width, height);
      tempFiles.push(resizedImage);

      processedBackgroundPath = path.join(tempDir, `bg_image_${Date.now()}.mp4`);
      await imageToVideo(resizedImage, audioDuration, processedBackgroundPath, width, height);
      tempFiles.push(processedBackgroundPath);

    } else {
      processedBackgroundPath = path.join(tempDir, `bg_color_${Date.now()}.mp4`);
      await createColorBackground(
        backgroundColor || '000000', audioDuration, processedBackgroundPath, width, height
      );
      tempFiles.push(processedBackgroundPath);
    }

    const outputFileName = `${projectName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.mp4`;
    const outputPath     = path.join(tempDir, outputFileName);

    await generateFinalVideo(processedBackgroundPath, audioRealPath, outputPath);

    const videoUrl = `${BASE_URL}/api/video/download/${outputFileName}`;

    // Salva / atualiza projeto automaticamente
    await supabase.from('projects').upsert({
      user_id:    userId,
      name:       projectName,
      config:     { lastVideoUrl: videoUrl },
      is_public,
      resolution,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,name' });

    return res.status(200).json({ success: true, videoUrl });

  } catch (error) {
    console.error('Erro ao gerar vídeo:', error);
    await cleanupTempFiles(tempFiles);
    return res.status(500).json({ error: 'Erro ao gerar vídeo' });
  }
};

/* =====================================================
   ⬇ DOWNLOAD
===================================================== */
export const downloadVideo = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Usuário não autenticado' });

    const { fileName } = req.params;
    if (!fileName.endsWith('.mp4')) {
      return res.status(400).json({ error: 'Arquivo inválido' });
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

    if (error || !user) return res.status(403).json({ error: 'Usuário não encontrado' });

    const isPro = user.plan === 'pro' && user.subscription_status === 'active';

    if (!isPro) {
      if (!user.credits || user.credits <= 0) {
        return res.status(403).json({ error: 'Créditos esgotados', code: 'NO_CREDITS' });
      }
      const { error: updateError } = await supabase
        .from('users')
        .update({ credits: user.credits - 1 })
        .eq('id', userId)
        .gt('credits', 0);

      if (updateError) return res.status(500).json({ error: 'Erro ao atualizar créditos' });
    }

    return res.download(filePath, fileName);

  } catch (error) {
    console.error('Erro no download:', error);
    return res.status(500).json({ error: 'Erro ao fazer download' });
  }
};
