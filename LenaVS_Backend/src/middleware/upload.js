import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Criar diretório de uploads se não existir
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuração de armazenamento
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user?.id || 'anonymous';
    const userDir = path.join(uploadDir, userId);
    
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext);
    cb(null, `${baseName}-${uniqueSuffix}${ext}`);
  }
});

// Filtro de tipos de arquivo
const fileFilter = (req, file, cb) => {
  const allowedTypes = {
    audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma'],
    video: ['.mp4', '.mov', '.avi', '.mkv'],
    image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp'],
    lyrics: ['.txt', '.docx', '.pdf', '.doc']
  };

  const ext = path.extname(file.originalname).toLowerCase();
  const allAllowed = Object.values(allowedTypes).flat();

  if (allAllowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de arquivo não permitido: ${ext}`));
  }
};

// Configuração do multer
export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024 // 500MB padrão
  }
});

// Middleware de upload múltiplo
export const uploadFiles = upload.fields([
  { name: 'musicaOriginal', maxCount: 1 },
  { name: 'musicaInstrumental', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'imagem', maxCount: 1 },
  { name: 'letra', maxCount: 1 }
]);

// Middleware de tratamento de erros do multer
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
