# Deploy do Backend no Render

## Tipo de serviço
Web Service

## Runtime
Node 20

## Build Command
```bash
chmod +x render-build.sh && ./render-build.sh
```

## Start Command
```bash
npm start
```

## Health Check Path
```text
/health
```

## Variáveis de ambiente obrigatórias
```env
NODE_ENV=production
PORT=10000
BACKEND_URL=https://SEU-BACKEND.onrender.com
FRONTEND_URL=https://SEU-FRONTEND.onrender.com
FRONTEND_USE_HASH_ROUTER=true
ALLOWED_ORIGINS=https://SEU-FRONTEND.onrender.com,https://seu-dominio.com,https://www.seu-dominio.com

SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_ANON_KEY=SEU_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=SEU_SUPABASE_SERVICE_ROLE_KEY
SUPABASE_JWT_SECRET=SEU_SUPABASE_JWT_SECRET

STRIPE_SECRET_KEY=SEU_STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET=SEU_STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_BRL=SEU_PRICE_ID_BRL
STRIPE_PRICE_USD=SEU_PRICE_ID_USD

MERCADO_PAGO_ACCESS_TOKEN=SEU_MERCADO_PAGO_ACCESS_TOKEN

MAX_FILE_SIZE=52428800
UPLOAD_DIR=uploads
ERRO_SUPPORT=noreply@lenavs.com
```

## Observações importantes
- O backend já foi ajustado para funcionar com `HashRouter` no frontend.
- Com `FRONTEND_USE_HASH_ROUTER=true`, os retornos de pagamento passam a usar URLs com `/#/payment/...`.
- O script `render-build.sh` instala FFmpeg e fontes necessárias para a renderização dos vídeos.
- Não suba `node_modules`.

## Ordem recomendada
1. Suba o backend no Render.
2. Copie a URL pública do backend.
3. Configure essa URL no frontend em `VITE_API_URL`.
4. Depois configure `FRONTEND_URL` no backend com a URL final do frontend.
5. Teste `/health` antes de liberar produção.

## Webhooks
### Stripe
Use no painel da Stripe:
```text
https://SEU-BACKEND.onrender.com/api/payment/webhook/stripe
```

### Mercado Pago
O backend já envia automaticamente a URL:
```text
https://SEU-BACKEND.onrender.com/api/payment/webhook/mercadopago
```
