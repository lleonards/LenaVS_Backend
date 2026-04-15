# Manual de deployment — LenaVS Backend

## 1) Pré-requisitos
- Node.js 20.x
- FFmpeg instalado no servidor
- Projeto Supabase configurado
- Conta Stripe configurada
- Conta Mercado Pago configurada

## 2) Variáveis de ambiente
Use o arquivo `.env.example` como base e crie um `.env` com, no mínimo:

```env
PORT=10000
NODE_ENV=production
BACKEND_URL=https://seu-backend.onrender.com
FRONTEND_URL=https://seu-frontend.onrender.com
ALLOWED_ORIGINS=https://seu-frontend.onrender.com,http://localhost:5173
MAX_FILE_SIZE=524288000
MAX_AUDIO_DURATION_MINUTES=15
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_PRICE_BRL=...
STRIPE_PRICE_USD=...
MERCADO_PAGO_ACCESS_TOKEN=...
MERCADO_PAGO_WEBHOOK_SECRET=...
UNLIMITED_PRICE_BRL=39.90
UNLIMITED_PRICE_USD=9.90
```

## 3) Instalação
```bash
npm install
```

## 4) Desenvolvimento
```bash
npm run dev
```

## 5) Produção
```bash
npm start
```

## 6) Deploy no Render
1. Crie um Web Service apontando para a pasta do backend.
2. Defina `Node 20`.
3. Configure as variáveis do `.env` no painel do serviço.
4. Use o script `render-build.sh` no build para instalar FFmpeg e fontes.
5. Garanta que `BACKEND_URL` e `FRONTEND_URL` apontem para as URLs públicas corretas.

## 7) Webhooks
- Stripe: `POST https://seu-backend/api/payment/webhook/stripe`
- Mercado Pago: `POST https://seu-backend/api/payment/webhook/mercadopago`

## 8) Banco / Supabase
Execute o arquivo `supabase_schema_corrigido.sql` no SQL Editor do Supabase antes de usar o sistema em produção.

## 9) Observações
- Upload de música original e instrumental: até 15 minutos.
- O backend devolve erro 400 se a duração do áudio exceder o limite.
- Não envie `node_modules` no deploy.
