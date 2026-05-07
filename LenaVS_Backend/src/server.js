import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import dotenv from 'dotenv';

import lyricsRoutes from './routes/lyrics.js';
import videoRoutes from './routes/video.js';
import projectRoutes from './routes/projects.js';
import supportRoutes from './routes/support.js';
import paymentRoutes from './routes/payment.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';

import { handlePagarmeWebhook, handleStripeWebhook } from './controllers/paymentController.js';
import { initializeVideoTaskQueue } from './services/videoTaskQueue.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const allowedOrigins = new Set([
  'https://www.lenavs.com',
  'https://lenavs.com',
  'https://lenavs-frontend.onrender.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;

  return (
    /^https:\/\/(.+\.)?lenavs\.com$/i.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  );
};

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Origem não permitida pelo CORS'));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

app.use(morgan('combined'));
app.use(compression());

app.post('/api/payment/webhook/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.post('/api/payment/webhook/pagarme', express.raw({ type: 'application/json' }), handlePagarmeWebhook);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'LenaVS Backend API',
    status: 'online',
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/lyrics', lyricsRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/payment', paymentRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    path: req.originalUrl,
  });
});

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);

  res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor',
  });
});

const startServer = async () => {
  try {
    await initializeVideoTaskQueue();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 LenaVS Backend rodando na porta ${PORT}`);
      console.log('🎬 Processamento interno de vídeos inicializado');
      console.log(`🗂️ Uploads persistentes via Supabase Storage no bucket ${process.env.SUPABASE_STORAGE_BUCKET || 'videos'}`);
    });
  } catch (error) {
    console.error('Falha ao iniciar servidor:', error);
    process.exit(1);
  }
};

startServer();
