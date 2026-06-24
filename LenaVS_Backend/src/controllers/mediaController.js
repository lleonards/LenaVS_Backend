import path from 'path';
import os from 'os';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import {
  downloadSourceValueToTempFile,
  buildStorageObjectPath,
  uploadLocalFileToStorage,
  removeLocalFileSilently,
  inferContentType,
} from '../services/storageService.js';

/**
 * POST /api/media/instrumental
 *
 * Gera versão instrumental (sem voz) a partir da música original usando
 * cancelamento de fase (pan filter) do ffmpeg. Funciona melhor em faixas
 * stereo onde os vocais estão centralizados — que é o padrão da grande
 * maioria das músicas comerciais.
 *
 * Body:    { audioUrl: string }
 * Response: { success: true, instrumentalUrl: string, duration: number|null }
 */
export const createInstrumental = async (req, res) => {
  const userId = req.user?.id || req.user?.sub || 'anonymous';
  const { audioUrl } = req.body;

  if (!audioUrl || typeof audioUrl !== 'string' || !audioUrl.startsWith('http')) {
    return res.status(400).json({ error: 'audioUrl inválido ou ausente' });
  }

  let inputPath = null;
  let outputPath = null;

  try {
    // 1. Baixar o áudio original para o disco temporário
    inputPath = await downloadSourceValueToTempFile(audioUrl, {
      prefix: 'original',
      fallbackName: 'musica.mp3',
      mimeType: 'audio/mpeg',
      folder: 'instrumental',
    });

    // 2. Preparar caminho de saída (mesmo formato do input)
    const ext = path.extname(inputPath) || '.mp3';
    const outDir = path.join(os.tmpdir(), 'lenavs', 'instrumental');
    await fs.promises.mkdir(outDir, { recursive: true });
    outputPath = path.join(outDir, `instrumental-${Date.now()}${ext}`);

    // 3. Remoção de voz via ffmpeg — cancelamento de fase do canal central.
    //    O filtro subtrai o canal direito do esquerdo (e vice-versa), eliminando
    //    o sinal em fase (central) onde os vocais costumam estar.
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters('pan=stereo|c0=0.5*c0+-0.5*c1|c1=-0.5*c0+0.5*c1')
        .on('end', resolve)
        .on('error', (err) => reject(new Error(`Erro no ffmpeg: ${err.message}`)))
        .save(outputPath);
    });

    // 4. Obter duração do arquivo gerado (para o frontend atualizar os metadados)
    const duration = await new Promise((resolve) => {
      ffmpeg.ffprobe(outputPath, (err, meta) => {
        if (err) { resolve(null); return; }
        const d = Number(meta?.format?.duration);
        resolve(Number.isFinite(d) && d > 0 ? Number(d.toFixed(3)) : null);
      });
    });

    // 5. Upload para o Supabase Storage
    const storagePath = buildStorageObjectPath({
      category: 'media/instrumental',
      userId,
      prefix: 'instrumental',
      originalName: `instrumental${ext}`,
      mimeType: inferContentType({ originalName: `instrumental${ext}`, fallback: 'audio/mpeg' }),
      fallbackExtension: ext,
    });

    const { publicUrl } = await uploadLocalFileToStorage({
      localPath: outputPath,
      storagePath,
      contentType: inferContentType({ originalName: `instrumental${ext}`, fallback: 'audio/mpeg' }),
    });

    return res.status(200).json({
      success: true,
      instrumentalUrl: publicUrl,
      duration,
    });
  } catch (error) {
    console.error('[createInstrumental] Erro:', error.message);
    return res.status(500).json({
      error: error.message || 'Erro ao criar instrumental',
    });
  } finally {
    await removeLocalFileSilently(inputPath);
    await removeLocalFileSilently(outputPath);
  }
};
