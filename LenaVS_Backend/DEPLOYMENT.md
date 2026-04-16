# Manual de deployment — LenaVS Backend

## 1) Pré-requisitos
- Node.js 20.x
- FFmpeg instalado no servidor
- Projeto Supabase configurado
- Conta Stripe configurada
- Conta SellX configurada

## 2) Variáveis de ambiente
Use o arquivo `.env.example` como base.

### Obrigatórias no Render
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
SELLX_API_KEY=...
SELLX_WEBHOOK_SECRET=...
UNLIMITED_PRICE_BRL=39.90
UNLIMITED_PRICE_USD=9.90
```

### Opcionais recomendadas
```env
SELLX_STORE_SLUG=seu-store-slug
SELLX_API_BASE=https://sell.app/api
SELLX_USE_ALL_PAYMENT_METHODS=true
SELLX_PAYMENT_METHODS=
UPLOAD_DIR=
ERRO_SUPPORT=
```

## 3) O que preencher em cada variável
- `BACKEND_URL`: URL pública do backend no Render.
- `FRONTEND_URL`: URL pública do frontend.
- `ALLOWED_ORIGINS`: domínios permitidos para o frontend acessar a API.
- `SUPABASE_URL`: URL do projeto Supabase.
- `SUPABASE_ANON_KEY`: chave pública do Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: chave privada do backend no Supabase.
- `SUPABASE_JWT_SECRET`: JWT Secret do projeto Supabase.
- `STRIPE_SECRET_KEY`: chave secreta do Stripe.
- `STRIPE_WEBHOOK_SECRET`: segredo do webhook do Stripe.
- `STRIPE_PRICE_BRL`: price ID do Stripe em BRL.
- `STRIPE_PRICE_USD`: price ID do Stripe em USD.
- `SELLX_API_KEY`: API key da sua conta SellX / Sell.app.
- `SELLX_STORE_SLUG`: slug da loja no SellX, caso sua conta tenha mais de uma store.
- `SELLX_WEBHOOK_SECRET`: segredo do webhook criado no painel do SellX.
- `SELLX_USE_ALL_PAYMENT_METHODS`: deixe `true` para o checkout mostrar os métodos ativos da sua loja.
- `SELLX_PAYMENT_METHODS`: opcional. Se quiser limitar os métodos, use valores separados por vírgula, como `STRIPE,PAYPAL`.
- `UNLIMITED_PRICE_BRL`: valor do upgrade de 30 dias em real.
- `UNLIMITED_PRICE_USD`: valor do upgrade de 30 dias em dólar.

## 4) Instalação
```bash
npm install
```

## 5) Desenvolvimento
```bash
npm run dev
```

## 6) Produção
```bash
npm start
```

## 7) Deploy no Render
1. Crie um Web Service apontando para a pasta do backend.
2. Defina `Node 20`.
3. Configure as variáveis acima no painel do serviço.
4. Use o script `render-build.sh` no build para instalar FFmpeg e fontes.
5. Garanta que `BACKEND_URL` e `FRONTEND_URL` estejam com as URLs finais públicas.

## 8) Webhooks
- Stripe: `POST https://seu-backend/api/payment/webhook/stripe`
- SellX: `POST https://seu-backend/api/payment/webhook/sellx`

## 9) Banco / Supabase
Execute o arquivo `supabase_schema_corrigido.sql` no SQL Editor do Supabase antes de usar o sistema em produção.

## 10) Observações
- O Stripe continua como checkout internacional recomendado.
- O SellX substitui o Mercado Pago no fluxo brasileiro.
- O backend não precisa de `node_modules` no pacote final.
