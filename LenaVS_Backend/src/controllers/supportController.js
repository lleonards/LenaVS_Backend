import { sendSupportContact } from '../utils/emailService.js';
import { logInternalError } from '../utils/publicError.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/support/report-error
 *
 * Body: { name, email, description }
 *
 * Se o usuário estiver autenticado (req.user), name e email podem ser
 * omitidos — o backend usará os dados da conta como fallback.
 */
export const reportError = async (req, res) => {
  try {
    const { name, email, description } = req.body;

    const resolvedName = String(name || req.user?.display_name || '').trim();
    const resolvedEmail = String(email || req.user?.email || '').trim();
    const resolvedDescription = String(description || '').trim();

    if (!resolvedName) {
      return res.status(400).json({ code: 'NAME_REQUIRED', error: 'Informe seu nome para continuar.' });
    }

    if (!resolvedEmail) {
      return res.status(400).json({ code: 'EMAIL_REQUIRED', error: 'Informe seu e-mail para continuar.' });
    }

    if (!EMAIL_REGEX.test(resolvedEmail)) {
      return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Digite um e-mail válido.' });
    }

    if (!resolvedDescription) {
      return res.status(400).json({ code: 'MESSAGE_REQUIRED', error: 'Escreva sua mensagem para continuar.' });
    }

    if (resolvedDescription.length < 10) {
      return res.status(400).json({
        code: 'MESSAGE_TOO_SHORT',
        error: 'Escreva pelo menos 10 caracteres para nos ajudar a entender o problema.',
      });
    }

    await sendSupportContact({
      name: resolvedName,
      email: resolvedEmail,
      description: resolvedDescription,
    });

    return res.status(200).json({
      success: true,
      message: 'Mensagem enviada. Responderemos em até 24 horas.',
    });
  } catch (error) {
    logInternalError('support:report-error', error);
    return res.status(500).json({
      code: 'SUPPORT_SEND_FAILED',
      error: 'Não foi possível enviar sua mensagem. Tente novamente.',
    });
  }
};
