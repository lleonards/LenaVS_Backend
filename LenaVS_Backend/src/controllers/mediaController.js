import axios from 'axios';
import {
  downloadUrlToLocalFile,
  buildStorageObjectPath,
  uploadLocalFileToStorage,
  removeLocalFileSilently,
  createTempFilePath,
} from '../services/storageService.js';

/*
  ──────────────────────────────────────────────────────────────────────────────
  Configuração do Replicate — Demucs HTDemucs
  ──────────────────────────────────────────────────────────────────────────────
  Variáveis de ambiente necessárias no servidor (Render):

    REPLICATE_API_TOKEN   — Token da API do Replicate (obrigatório)
                            Obtenha em: https://replicate.com/account/api-tokens

  ──────────────────────────────────────────────────────────────────────────────
*/
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

const POLL_INTERVAL_MS = 4000;   // intervalo entre polls (4 s)
const MAX_POLL_ATTEMPTS = 120;   // ~8 minutos de timeout total

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers Replicate ───────────────────────────────────────────────────────

const replicateHeaders = () => ({
  Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
  'Content-Type': 'application/json',
  'Prefer': 'wait',
});

/**
 * Usa o endpoint por nome do modelo (sem pinnar versão),
 * assim sempre executa na versão mais recente do darius-wan/demucs.
 */
const startPrediction = (audioUrl) =>
  axios.post(
    'https://api.replicate.com/v1/models/darius-wan/demucs/predictions',
    {
      input: {
        audio: audioUrl,
        model: 'htdemucs',
        two_stems: 'vocals',
        output_format: 'mp3',
        shifts: 1,
      },
    },
    { headers: replicateHeaders(), timeout: 30000 },
  );

const getPrediction = (predictionUrl) =>
  axios.get(predictionUrl, {
    headers: replicateHeaders(),
    timeout: 15000,
  });

/**
 * Aguarda a conclusão de uma predição no Replicate via polling.
 * Retorna o objeto `output` quando status === 'succeeded'.
 */
const waitForPrediction = async (predictionUrl) => {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const { data } = await getPrediction(predictionUrl);

    if (data.status === 'succeeded') {
      return data.output;
    }

    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(
        `Replicate: o processamento falhou — ${data.error || data.status}`,
      );
    }

    // status 'starting' ou 'processing' → continua aguardando
  }

  throw new Error(
    'Timeout: o Demucs demorou mais do que o esperado. Tente novamente.',
  );
};

/**
 * Extrai a URL da faixa instrumental (sem voz) do output do Replicate.
 *
 * O Demucs com two_stems='vocals' retorna:
 *   { vocals: "url", no_vocals: "url" }
 * ou às vezes:
 *   { vocals: "url", accompaniment: "url" }
 * ou em versões mais antigas um array:
 *   [ "vocals_url", "no_vocals_url" ]
 */
const extractInstrumentalUrl = (output) => {
  if (!output) return null;

  // Objeto com chave explícita (formato mais comum)
  if (typeof output === 'object' && !Array.isArray(output)) {
    return output.no_vocals || output.accompaniment || output.other || null;
  }

  // Array — índice 1 costuma ser a faixa sem voz
  if (Array.isArray(output) && output.length >= 2) {
    return output[1] || null;
  }

  return null;
};

// ── Controller ───────────────────────────────────────────────────────────────

/**
 * POST /api/media/instrumental
 *
 * Gera versão instrumental (sem voz) usando o modelo HTDemucs via Replicate.
 * Após o processamento, faz upload do resultado para o Supabase Storage e
 * retorna a URL pública.
 *
 * Body:    { audioUrl: string }
 * Response: { success: true, instrumentalUrl: string }
 */
export const createInstrumental = async (req, res) => {
  const userId = req.user?.id || req.user?.sub || 'anonymous';
  const { audioUrl } = req.body;

  if (!audioUrl || typeof audioUrl !== 'string' || !audioUrl.startsWith('http')) {
    return res.status(400).json({ error: 'audioUrl inválido ou ausente' });
  }

  if (!REPLICATE_API_TOKEN) {
    return res.status(500).json({
      error:
        'REPLICATE_API_TOKEN não está configurado no servidor. '
        + 'Adicione a variável de ambiente no Render.',
    });
  }

  let localPath = null;

  try {
    // 1. Iniciar a predição no Replicate
    console.log('[createInstrumental] Iniciando Demucs no Replicate…');
    const { data: prediction } = await startPrediction(audioUrl);

    if (!prediction?.urls?.get) {
      throw new Error('Replicate não retornou URL de status da predição.');
    }

    // 2. Verificar se já terminou (resposta síncrona) ou aguardar via polling
    let output = prediction.output ?? null;

    if (!output) {
      console.log('[createInstrumental] Aguardando Demucs concluir…');
      output = await waitForPrediction(prediction.urls.get);
    }

    // 3. Extrair a URL do instrumental
    const instrumentalFileUrl = extractInstrumentalUrl(output);

    if (!instrumentalFileUrl) {
      throw new Error(
        'Demucs não retornou a faixa instrumental. '
        + `Output recebido: ${JSON.stringify(output)}`,
      );
    }

    console.log('[createInstrumental] Demucs concluído. Baixando resultado…');

    // 4. Baixar o arquivo gerado pelo Demucs para disco temporário
    localPath = await createTempFilePath({
      prefix: 'instrumental',
      originalName: 'instrumental.mp3',
      mimeType: 'audio/mpeg',
      folder: 'instrumental',
    });
    await downloadUrlToLocalFile(instrumentalFileUrl, localPath);

    // 5. Upload para o Supabase Storage
    const storagePath = buildStorageObjectPath({
      category: 'media/instrumental',
      userId,
      prefix: 'instrumental',
      originalName: 'instrumental.mp3',
      mimeType: 'audio/mpeg',
      fallbackExtension: '.mp3',
    });

    const { publicUrl } = await uploadLocalFileToStorage({
      localPath,
      storagePath,
      contentType: 'audio/mpeg',
    });

    console.log('[createInstrumental] Instrumental enviado ao Supabase:', publicUrl);

    return res.status(200).json({
      success: true,
      instrumentalUrl: publicUrl,
    });
  } catch (error) {
    console.error('[createInstrumental] Erro:', error.message);
    return res.status(500).json({
      error: error.message || 'Erro ao criar instrumental com Demucs',
    });
  } finally {
    await removeLocalFileSilently(localPath);
  }
};
