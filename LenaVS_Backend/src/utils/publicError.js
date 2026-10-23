/**
 * Mensagens públicas de erro da API do LenaVS.
 *
 * Regra do produto:
 *  - O usuário só vê mensagens curtas sobre o que ELE pode fazer
 *    (enviar um arquivo, corrigir um dado, entrar novamente, etc.).
 *  - Falhas internas (Supabase, banco, Storage, FFmpeg, Demucs, Stripe,
 *    Pagar.me, fila de vídeo) NUNCA expõem detalhe técnico ao navegador.
 *    O detalhe completo continua sendo registrado no log do servidor.
 */

export const GENERIC_ERROR_MESSAGE =
  'Não foi possível concluir a operação. Tente novamente.';

/**
 * Códigos do multer -> mensagem curta e acionável.
 * O status HTTP original é preservado pelo chamador.
 */
export const MULTER_CODE_MESSAGES = {
  LIMIT_FILE_SIZE: 'O arquivo é muito grande. Envie um arquivo menor.',
  LIMIT_FILE_COUNT: 'Envie um arquivo por vez.',
  LIMIT_UNEXPECTED_FILE:
    'Não foi possível enviar este arquivo. Recarregue a página e tente novamente.',
  LIMIT_PART_COUNT: 'O envio tem partes demais. Envie menos arquivos por vez.',
  LIMIT_FIELD_KEY:
    'O envio do arquivo falhou. Recarregue a página e tente novamente.',
  LIMIT_FIELD_VALUE: 'Um dos dados enviados é grande demais.',
  LIMIT_FIELD_COUNT: 'Envie menos campos no formulário.',
};

export const multerMessage = (code) =>
  MULTER_CODE_MESSAGES[code] || 'Não foi possível enviar o arquivo. Tente novamente.';

/**
 * Registra o detalhe técnico apenas no log do servidor.
 * @param {string} context origem do erro (rota/serviço)
 * @param {unknown} error erro original
 * @param {Record<string, unknown>} [extra] dados úteis para manutenção
 */
export const logInternalError = (context, error, extra = undefined) => {
  const detail = {
    context,
    message: error?.message || String(error || ''),
    code: error?.code || error?.status || undefined,
    stack: error?.stack || undefined,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };

  console.error(`[erro:${context}]`, JSON.stringify(detail));
};

/**
 * Resposta de erro causado por uma ação do usuário.
 * A mensagem precisa ser curta, clara e acionável.
 */
export const respondUserError = (res, status, code, message) =>
  res.status(status).json({
    ...(code ? { code } : {}),
    error: message,
  });

/**
 * Resposta de falha interna: loga o detalhe e devolve a mensagem neutra.
 */
export const respondInternalError = (res, { context, error, status = 500, code = 'INTERNAL_ERROR' }) => {
  logInternalError(context, error);

  return res.status(status).json({
    code,
    error: GENERIC_ERROR_MESSAGE,
  });
};
