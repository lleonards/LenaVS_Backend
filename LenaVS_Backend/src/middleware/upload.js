import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';

const uploadDir = path.join(os.tmpdir(), 'lenavs', 'incoming-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext);
    cb(null, `${baseName}-${uniqueSuffix}${ext}`);
  },
});

const FILE_RULES = {
  audio: {
    extensions: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', '.opus', '.weba'],
    mimeTypes: [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg',
      'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/x-ms-wma', 'audio/opus',
      'audio/webm', 'video/mp4',
    ],
    label: 'áudio',
  },
  video: {
    extensions: ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpeg', '.mpg', '.3gp'],
    mimeTypes: [
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/webm',
      'video/x-m4v', 'video/mpeg', 'video/3gpp',
    ],
    label: 'vídeo',
  },
  image: {
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'],
    mimeTypes: [
      'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/webp',
    ],
    label: 'imagem',
  },
  lyrics: {
    extensions: ['.txt', '.docx', '.pdf', '.doc'],
    mimeTypes: [
      'text/plain', 'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream',
    ],
    label: 'letra',
  },
};

const FIELD_RULES_MAP = {
  musicaOriginal: FILE_RULES.audio,
  musicaInstrumental: FILE_RULES.audio,
  video: FILE_RULES.video,
  imagem: FILE_RULES.image,
  letra: FILE_RULES.lyrics,
};

const fileFilter = (req, file, cb) => {
  const rule = FIELD_RULES_MAP[file.fieldname];

  if (!rule) {
    cb(new Error('Campo de upload não suportado.'));
    return;
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const normalizedMime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
  const extensionAllowed = rule.extensions.includes(ext);
  const mimeAllowed = !normalizedMime || normalizedMime === 'application/octet-stream' || rule.mimeTypes.includes(normalizedMime);

  if (extensionAllowed && mimeAllowed) {
    cb(null, true);
    return;
  }

  cb(new Error(`Tipo de ${rule.label} não permitido: ${ext || normalizedMime || 'arquivo sem extensão'}`));
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 500 * 1024 * 1024,
  },
});

export const uploadFiles = upload.fields([
  { name: 'musicaOriginal', maxCount: 1 },
  { name: 'musicaInstrumental', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'imagem', maxCount: 1 },
  { name: 'letra', maxCount: 1 },
]);

export const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Arquivo muito grande' });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err) {
    return res.status(400).json({ error: err.message });
  }

  next();
};
