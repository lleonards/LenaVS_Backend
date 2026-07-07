import nodemailer from 'nodemailer';

/**
 * Configuração do transporter de email (exemplo genérico)
 * Adapte conforme seu provedor de email
 */
const createTransporter = () => {
  // Esta é uma configuração de exemplo
  // Você precisará configurar com suas credenciais reais
  return nodemailer.createTransporter({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
};

/**
 * Envia email de relatório de erro
 */
export const sendErrorReport = async (errorData) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: process.env.ERROR_REPORT_EMAIL,
      subject: `[LenaVS] Relatório de Erro - ${new Date().toLocaleString('pt-BR')}`,
      html: `
        <h2>Relatório de Erro - LenaVS</h2>
        <p><strong>Usuário:</strong> ${errorData.userEmail || 'Anônimo'}</p>
        <p><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-BR')}</p>
        <p><strong>Descrição:</strong></p>
        <p>${errorData.description}</p>
        <hr>
        <p><strong>Informações Técnicas:</strong></p>
        <pre>${JSON.stringify(errorData.technicalInfo || {}, null, 2)}</pre>
      `
    };

    await transporter.sendMail(mailOptions);
    return { success: true, message: 'Relatório enviado com sucesso' };
  } catch (error) {
    console.error('Erro ao enviar email:', error);
    throw new Error('Falha ao enviar relatório de erro');
  }
};
