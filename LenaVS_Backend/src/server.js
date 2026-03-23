import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ROTAS
import lyricsRoutes from './routes/lyrics.js';
import videoRoutes from './routes/video.js';
import projectRoutes from './routes/projects.js';
import supportRoutes from './routes/support.js';
import paymentRoutes from './routes/payment.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';

// Stripe Webhook
import { handlePaymentWebhook } from './controllers/paymentController.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =====================================================
   🌍 CORS
===================================================== */

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : [];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  },
  credentials: true
}));

/* =====================================================
   🧱 SEGURANÇA E PERFORMANCE
===================================================== */

app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);

app.use(morgan('combined'));
app.use(compression());

/* =====================================================
   🔥 STRIPE WEBHOOK
===================================================== */

app.post(
  '/api/payment/webhook',
  express.raw({ type: 'application/json' }),
  handlePaymentWebhook
);

/* =====================================================
   📦 BODY PARSER
===================================================== */

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

/* =====================================================
   📂 SERVIR UPLOADS
===================================================== */

app.use(
  '/uploads',
  express.static(path.join(__dirname, '../uploads'), {
    setHeaders: (res, filePath) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      if (filePath.endsWith('.mp3')) res.setHeader('Content-Type', 'audio/mpeg');
      if (filePath.endsWith('.wav')) res.setHeader('Content-Type', 'audio/wav');
      if (filePath.endsWith('.ogg')) res.setHeader('Content-Type', 'audio/ogg');
      if (filePath.endsWith('.m4a')) res.setHeader('Content-Type', 'audio/mp4');
      if (filePath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
    }
  })
);

/* =====================================================
   ❤️ HEALTH CHECK
===================================================== */

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'LenaVS Backend API',
    status: 'online'
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

/* =====================================================
   🚀 ROTAS
===================================================== */

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/lyrics', lyricsRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/payment', paymentRoutes);

/* =====================================================
   ❌ 404
===================================================== */

app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    path: req.originalUrl
  });
});

/* =====================================================
   💥 ERRO GLOBAL
===================================================== */

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);

  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor'
  });
});

/* =====================================================
   ▶ START
===================================================== */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LenaVS Backend rodando na porta ${PORT}`);
});