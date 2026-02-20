import path from 'path';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  getAudioDuration,
  imageToVideo,
  adjustVideoToAudioDuration,
  resizeImageTo16_9,
  createColorBackground,
  generateFinalVideo,
  cleanupTempFiles
} from '../utils/videoProcessor.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.BACKEND_URL || 'https://lenavs-backend.onrender.com';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

      if (req.files.musicaOriginal)
        uploadedFiles.musicaOriginal = mapFile(req.files.musicaOriginal[0]);

      if (req.files.musicaInstrumental)
        uploadedFiles.musicaInstrumental = mapFile(req.files.musicaInstrumental[0]);

      if (req.files.video)
        uploadedFiles.video = mapFile(req.files.video[0]);

      if (req.files.imagem)
        uploadedFiles.imagem = mapFile(req.files.imagem[0]);

      if (req.files.letra)
        uploadedFiles.letra = mapFile(req.files.letra[0]);
    }

    return res.status(200).json({
      success: true,
      files: uploadedFiles,
      message: 'Arquivos enviados com sucesso'
    });

  } catch (error) {
    console.error('Erro no upload de mídia:', error);
    return res.status(500).json({ error: 'Erro ao fazer upload dos arquivos' });
  }
};

/* =====================================================
   🎬 GERAR VÍDEO
   ❌ NÃO CONSOME CRÉDITO AQUI
===================================================== */

export const generateVideo = async (req, res) => {
  let tempFiles = [];

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
      backgroundColor
    } = req.body;

    if (!projectName || !audioPath) {
      return res.status(400).json({ error: 'Dados insuficientes para gerar vídeo' });
    }

    // Apenas valida existência do usuário
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(403).json({ error: 'Usuário não encontrado' });
    }

    /* =============================
       🎬 PROCESSAMENTO DO VÍDEO
    ============================= */

    const audioRealPath = path.join(
      __dirname,
      '../../uploads',
      audioPath.split('/uploads/')[1]
    );

    const audioDuration = await getAudioDuration(audioRealPath);

    const tempDir = path.join(__dirname, '../../uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let processedBackgroundPath;

    if (backgroundType === 'video' && backgroundPath) {
      const realBg = path.join(__dirname, '../../uploads', backgroundPath.split('/uploads/')[1]);
      processedBackgroundPath = path.join(tempDir, `bg_video_${Date.now()}.mp4`);
      await adjustVideoToAudioDuration(realBg, audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);

    } else if (backgroundType === 'image' && backgroundPath) {
      const realImg = path.join(__dirname, '../../uploads', backgroundPath.split('/uploads/')[1]);
      const resizedImage = path.join(tempDir, `resized_${Date.now()}.jpg`);
      await resizeImageTo16_9(realImg, resizedImage);
      tempFiles.push(resizedImage);

      processedBackgroundPath = path.join(tempDir, `bg_image_${Date.now()}.mp4`);
      await imageToVideo(resizedImage, audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);

    } else {
      processedBackgroundPath = path.join(tempDir, `bg_color_${Date.now()}.mp4`);
      await createColorBackground(backgroundColor || '000000', audioDuration, processedBackgroundPath);
      tempFiles.push(processedBackgroundPath);
    }

    const outputFileName = `${projectName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.mp4`;
    const outputPath = path.join(tempDir, outputFileName);

    await generateFinalVideo(processedBackgroundPath, audioRealPath, outputPath);

    return res.status(200).json({
      success: true,
      videoUrl: `${BASE_URL}/api/video/download/${outputFileName}`
    });

  } catch (error) {
    console.error('Erro ao gerar vídeo:', error);
    await cleanupTempFiles(tempFiles);
    return res.status(500).json({ error: 'Erro ao gerar vídeo' });
  }
};

/* =====================================================
   ⬇ DOWNLOAD
   🔥 CONSOME CRÉDITO AQUI
===================================================== */

export const downloadVideo = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Usuário não autenticado' });
    }

    const { fileName } = req.params;
    const filePath = path.join(__dirname, '../../uploads/temp', fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Vídeo não encontrado' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('plan, credits, credits_reset_at, subscription_status')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(403).json({ error: 'Usuário não encontrado' });
    }

    const now = new Date();
    const lastReset = new Date(user.credits_reset_at);
    const diffInDays = (now - lastReset) / (1000 * 60 * 60 * 24);

    const isPro =
      user.plan === 'pro' &&
      user.subscription_status === 'active';

    if (!isPro) {

      // Reset automático 15 dias
      if (diffInDays >= 15) {
        await supabase
          .from('users')
          .update({
            credits: 3,
            credits_reset_at: now.toISOString()
          })
          .eq('id', userId);

        user.credits = 3;
      }

      if (!user.credits || user.credits <= 0) {
        return res.status(403).json({
          error: 'Créditos esgotados. Faça upgrade para continuar.'
        });
      }

      // 🔥 CONSUME CRÉDITO AGORA
      await supabase
        .from('users')
        .update({ credits: user.credits - 1 })
        .eq('id', userId);
    }

    return res.download(filePath, fileName);

  } catch (error) {
    console.error('Erro no download:', error);
    return res.status(500).json({ error: 'Erro ao fazer download do vídeo' });
  }
};