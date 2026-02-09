/**
 * Processador de letras
 * Separa texto em estrofes e normaliza acentuação
 */

/**
 * Normaliza texto preservando acentos e caracteres especiais
 */
export const normalizeText = (text) => {
  if (!text) return '';
  
  // Preserva acentos e ç
  // Remove apenas caracteres de controle indesejados
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
};

/**
 * Separa texto em estrofes
 * Se já tiver separação por linhas em branco, mantém
 * Caso contrário, separa automaticamente em blocos de 4 linhas
 */
export const separateIntoStanzas = (text) => {
  const normalizedText = normalizeText(text);
  
  // Verificar se já tem separação por linhas em branco
  const hasBlankLines = /\n\s*\n/.test(normalizedText);
  
  if (hasBlankLines) {
    // Já tem estrofes separadas - mantém a estrutura
    const stanzas = normalizedText
      .split(/\n\s*\n/)
      .map(stanza => stanza.trim())
      .filter(stanza => stanza.length > 0);
    
    return {
      stanzas,
      autoSeparated: false,
      message: 'Letra carregada com separação original preservada'
    };
  } else {
    // Não tem separação - separa automaticamente em blocos de 4 linhas
    const lines = normalizedText.split('\n').filter(line => line.trim().length > 0);
    const stanzas = [];
    
    for (let i = 0; i < lines.length; i += 4) {
      const stanza = lines.slice(i, i + 4).join('\n');
      stanzas.push(stanza);
    }
    
    return {
      stanzas,
      autoSeparated: true,
      message: 'Letra separada automaticamente em estrofes de 4 linhas'
    };
  }
};

/**
 * Processa arquivo de letra (.txt, .docx, .pdf)
 */
export const processLyricsFile = async (filePath) => {
  const fs = await import('fs');
  const path = await import('path');
  
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  
  try {
    if (ext === '.txt') {
      text = fs.readFileSync(filePath, 'utf-8');
    } else if (ext === '.docx') {
      // Para .docx seria necessário uma biblioteca como mammoth
      // Por enquanto, retorna erro para implementação futura
      throw new Error('Processamento de arquivos .docx será implementado em breve');
    } else if (ext === '.pdf') {
      // Para .pdf seria necessário uma biblioteca como pdf-parse
      // Por enquanto, retorna erro para implementação futura
      throw new Error('Processamento de arquivos .pdf será implementado em breve');
    } else {
      throw new Error('Formato de arquivo não suportado');
    }
    
    return separateIntoStanzas(text);
  } catch (error) {
    throw new Error(`Erro ao processar arquivo de letra: ${error.message}`);
  }
};

/**
 * Valida tempo no formato mm:ss
 */
export const validateTimeFormat = (time) => {
  if (!time) return '00:00';
  
  // Remove tudo que não é número
  const digits = time.replace(/\D/g, '');
  
  // Pega apenas os 4 primeiros dígitos
  const limited = digits.slice(0, 4).padStart(4, '0');
  
  // Formata como mm:ss
  const minutes = limited.slice(0, 2);
  const seconds = limited.slice(2, 4);
  
  // Valida segundos (máximo 59)
  const validSeconds = Math.min(parseInt(seconds), 59).toString().padStart(2, '0');
  
  return `${minutes}:${validSeconds}`;
};

/**
 * Converte tempo mm:ss para segundos
 */
export const timeToSeconds = (time) => {
  const [minutes, seconds] = time.split(':').map(Number);
  return minutes * 60 + seconds;
};

/**
 * Converte segundos para formato mm:ss
 */
export const secondsToTime = (seconds) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};
