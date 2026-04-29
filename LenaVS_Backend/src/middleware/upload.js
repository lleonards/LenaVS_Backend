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

const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'],
    video: ['.mp4', '.mov', '.avi', '.mkv'],
    image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'],
    lyrics: ['.txt', '.docx', '.pdf', '.doc'],
  };

  const ext = path.extname(file.originalname).toLowerCase();
  const allAllowed = Object.values(allowedTypes).flat();

  if (allAllowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de arquivo não permitido: ${ext}`));
  }
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
