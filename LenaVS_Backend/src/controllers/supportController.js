import { sendErrorReport } from '../utils/emailService.js';

/**
 * Envia relatório de erro
 */
export const reportError = async (req, res) => {
  try {
    const { description, technicalInfo } = req.body;
    const userEmail = req.user?.email || null;

    if (!description || description.trim().length === 0) {
      return res.status(400).json({ error: 'Descrição do erro é obrigatória' });
    }

    const errorData = {
      userEmail,
      description,
      technicalInfo: {
        ...technicalInfo,
        timestamp: new Date().toISOString(),
        userAgent: req.headers['user-agent']
      }
    };

    await sendErrorReport(errorData);

    return res.status(200).json({
      success: true,
      message: 'Relatório de erro enviado com sucesso. Obrigado pelo feedback!'
    });
  } catch (error) {
    console.error('Erro ao enviar relatório:', error);
    return res.status(500).json({ 
      error: 'Erro ao enviar relatório. Por favor, tente novamente mais tarde.' 
    });
  }
};
