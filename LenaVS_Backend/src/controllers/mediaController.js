import path from 'path';
import {
  buildStorageObjectPath,
  uploadLocalFileToStorage,
  removeLocalFileSilently,
  downloadSourceValueToTempFile,
  inferContentType,
} from '../services/storageService.js';
import {
  createInstrumentalWithDemucsFromLocalFile,
  removeDirectorySilently,
} from '../services/demucsService.js';
import { GENERIC_ERROR_MESSAGE, logInternalError } from '../utils/publicError.js';

// A separação de voz/instrumental roda em um serviço interno (Demucs).
// Qualquer falha dele é problema do sistema: o usuário recebe uma mensagem
// neutra e o detalhe técnico fica registrado apenas no log do servidor.
const normalizeDemucsError = (error) => {
  if (error?.code === 'DEMUCS_TIMEOUT') {
    return 'A separação do áudio demorou mais que o esperado. Tente novamente com uma música mais curta.';
  }

  return GENERIC_ERROR_MESSAGE;
};

/**
 * POST /api/media/instrumental
 *
 * Gera versão instrumental (sem voz) usando Demucs executado localmente no servidor.
 * Faz upload do resultado para o Supabase Storage e retorna a URL pública.
 *
 * Body:    { audioUrl: string }
 * Response: { success: true, instrumentalUrl: string, duration?: number }
 */
export const createInstrumental = async (req, res) => {
  const userId = req.user?.id || req.user?.sub || 'anonymous';
  const rawAudioUrl = req.body?.audioUrl;
  const audioUrl = typeof rawAudioUrl === 'string' ? rawAudioUrl.trim() : '';

  if (!audioUrl) {
    return res.status(400).json({
      code: 'AUDIO_REQUIRED',
      error: 'Faça o upload da música original para continuar.',
    });
  }

  let sourceAudioPath = null;
  let demucsJobRoot = null;
  let instrumentalLocalPath = null;

  try {
    console.log('[createInstrumental] Baixando áudio de origem para processamento local…');

    const fallbackName = (() => {
      try {
        return path.basename(new URL(audioUrl).pathname) || 'musica-original.mp3';
      } catch {
        return 'musica-original.mp3';
      }
    })();

    sourceAudioPath = await downloadSourceValueToTempFile(audioUrl, {
      prefix: 'instrumental-source',
      fallbackName,
      mimeType: 'audio/mpeg',
      folder: 'instrumental-source',
    });

    console.log('[createInstrumental] Executando Demucs local…');
    const demucsResult = await createInstrumentalWithDemucsFromLocalFile(sourceAudioPath);
    demucsJobRoot = demucsResult.jobRoot;
    instrumentalLocalPath = demucsResult.instrumentalPath;

    const storagePath = buildStorageObjectPath({
      category: 'media/instrumental',
      userId,
      prefix: 'instrumental',
      originalName: path.basename(instrumentalLocalPath || 'instrumental.mp3'),
      mimeType: 'audio/mpeg',
      fallbackExtension: '.mp3',
    });

    const uploaded = await uploadLocalFileToStorage({
      localPath: instrumentalLocalPath,
      storagePath,
      contentType: inferContentType({ originalName: instrumentalLocalPath, mimeType: 'audio/mpeg' }),
    });

    console.log('[createInstrumental] Instrumental enviado ao Supabase:', uploaded.publicUrl);

    // CORRIGIDO: alem da URL de acesso (assinada, expira em 1h), devolvemos o
    // caminho e o bucket no Storage. O frontend guarda isso em mediaMetadata e
    // o backend consegue re-assinar a URL na hora do export/preview, mesmo que
    // a assinatura tenha expirado (antes o instrumental "sumia" depois de 1h).
    return res.status(200).json({
      success: true,
      instrumentalUrl: uploaded.publicUrl,
      storagePath: uploaded.storagePath,
      bucket: uploaded.bucket,
      duration: demucsResult.duration,
      engine: 'demucs-local',
    });
  } catch (error) {
    logInternalError('media:instrumental', error, {
      demucsCode: error?.code || null,
      stderr: error?.stderr ? String(error.stderr).slice(0, 2000) : undefined,
    });

    const status = error?.code === 'DEMUCS_TIMEOUT' ? 504 : 500;

    return res.status(status).json({
      code: 'INSTRUMENTAL_FAILED',
      error: normalizeDemucsError(error),
    });
  } finally {
    await removeLocalFileSilently(sourceAudioPath);
    await removeLocalFileSilently(instrumentalLocalPath);
    await removeDirectorySilently(demucsJobRoot);
  }
};
