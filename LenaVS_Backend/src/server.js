import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';

// Rotas
import lyricsRoutes from './routes/lyrics.js';
import videoRoutes from './routes/video.js';
import projectRoutes from './routes/projects.js';
import supportRoutes from './routes/support.js';
import paymentRoutes from './routes/payment.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

/* =====================================================
   🔓 CORS LIVRE PARA MÍDIA (OBRIGATÓRIO)
===================================================== */
app.use('/uploads', cors({ origin: '*' }));

/* =====================================================
   📂 SERVIR UPLOADS PUBLICAMENTE
===================================================== */
app.use(
  '/uploads',
  express.static(path.join(process.cwd(), 'uploads'), {
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  })
);

/* =====================================================
   🌐 CORS PARA API (COM TOKEN)
===================================================== */
app.use(
  cors({
    origin: process.env.CORS_ORIGINS?.split(',') || '*',
    credentials: true
  })
);

/* =====================================================
   🧱 MIDDLEWARES GLOBAIS
===================================================== */
app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);

app.use(morgan('combined'));
app.use(compression());

/* =====================================================
   📦 BODY PARSERS
===================================================== */
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payment/webhook') {
    next();
  } else {
    express.json({ limit: '50mb' })(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
   🚀 ROTAS DA API
===================================================== */
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
    error: err.message || 'Erro interno'
  });
});

/* =====================================================
   ▶ START
===================================================== */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LenaVS Backend rodando na porta ${PORT}`);
});
