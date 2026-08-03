/**
 * Processador de letras
 * Separa texto em estrofes e normaliza acentuação
 */

import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';

/**
 * Normaliza texto preservando acentos e caracteres especiais
 */
export const normalizeText = (text) => {
  if (!text) return '';
  
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
};

/**
 * Separa texto em estrofes
 */
export const separateIntoStanzas = (text) => {
  const normalizedText = normalizeText(text);
  
  const hasBlankLines = /\n\s*\n/.test(normalizedText);
  
  if (hasBlankLines) {
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
    const lines = normalizedText
      .split('\n')
      .filter(line => line.trim().length > 0);
    
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
 * Lê arquivo .txt corrigindo automaticamente encoding
 */
const readTextFileWithEncodingFix = (filePath) => {
  const buffer = fs.readFileSync(filePath);

  // Tenta UTF-8 primeiro
  const utf8Text = buffer.toString('utf8');

  // Se detectar caractere inválido, converte de Windows-1252
  if (utf8Text.includes('�')) {
    return iconv.decode(buffer, 'win1252');
  }

  return utf8Text;
};

/**
 * Processa arquivo de letra (.txt, .docx, .pdf)
 */
export const processLyricsFile = async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  
  try {
    if (ext === '.txt') {
      text = readTextFileWithEncodingFix(filePath);
    } 
    else if (ext === '.docx') {
      throw new Error('Processamento de arquivos .docx será implementado em breve');
    } 
    else if (ext === '.pdf') {
      throw new Error('Processamento de arquivos .pdf será implementado em breve');
    } 
    else {
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
  
  const digits = time.replace(/\D/g, '');
  const limited = digits.slice(0, 4).padStart(4, '0');
  
  const minutes = limited.slice(0, 2);
  const seconds = limited.slice(2, 4);
  
  const validSeconds = Math.min(parseInt(seconds), 59)
    .toString()
    .padStart(2, '0');
  
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
  return `${mins.toString().padStart(2, '0')}:${secs
    .toString()
    .padStart(2, '0')}`;
};
