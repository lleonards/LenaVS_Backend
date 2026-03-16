# LenaVS Backend

Backend do sistema LenaVS - Editor de vídeo karaokê com sincronização de letras.

## 🚀 Tecnologias

- **Node.js** (v18+)
- **Express.js** - Framework web
- **Supabase** - Autenticação e banco de dados
- **FFmpeg** - Processamento de vídeo
- **Multer** - Upload de arquivos
- **Jimp** - Processamento de imagens

## 📋 Pré-requisitos

- Node.js 18 ou superior
- FFmpeg instalado no sistema
- Conta no Supabase configurada
- Conta de email SMTP (para relatórios de erro)

## 🔧 Configuração

### 1. Instalar Dependências

```bash
npm install
```

### 2. Configurar Variáveis de Ambiente

Copie o arquivo `.env.example` para `.env` e preencha as variáveis:

```bash
cp .env.example .env
```

Edite o arquivo `.env` com suas credenciais:

```env
PORT=10000
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_ANON_KEY=sua-chave-anon
SUPABASE_SERVICE_KEY=sua-chave-service
SUPABASE_JWT_SECRET=seu-jwt-secret
CORS_ORIGINS=http://localhost:5173,https://seu-frontend.onrender.com
ERROR_REPORT_EMAIL=seu-email@exemplo.com
NODE_ENV=production
```

### 3. Configurar Supabase

Crie as seguintes tabelas no Supabase:

#### Tabela `projects`

```sql
CREATE TABLE projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Políticas de acesso
CREATE POLICY "Usuários podem ver seus próprios projetos"
  ON projects FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Usuários podem criar seus próprios projetos"
  ON projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuários podem atualizar seus próprios projetos"
  ON projects FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Usuários podem deletar seus próprios projetos"
  ON projects FOR DELETE
  USING (auth.uid() = user_id);
```

## 🏃 Executar Localmente

### Modo Desenvolvimento

```bash
npm run dev
```

### Modo Produção

```bash
npm start
```

O servidor estará rodando em `http://localhost:10000`

## 🌐 Deploy no Render

### 1. Criar Web Service no Render

1. Conecte seu repositório GitHub ao Render
2. Escolha "Web Service"
3. Configure:
   - **Name**: lenavs-backend
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free ou Starter

### 2. Configurar Variáveis de Ambiente

No painel do Render, adicione todas as variáveis do arquivo `.env`:

- `PORT` → 10000
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`
- `SUPABASE_JWT_SECRET`
- `CORS_ORIGINS`
- `ERROR_REPORT_EMAIL`
- `NODE_ENV` → production

### 3. Configurar FFmpeg

Adicione um script de build que instale o FFmpeg:

Crie `render-build.sh`:

```bash
#!/bin/bash
apt-get update
apt-get install -y ffmpeg
npm install
```

E configure no Render:
- **Build Command**: `bash render-build.sh`

## 📡 Rotas da API

### Health Check

- `GET /` - Informações da API
- `GET /health` - Status de saúde

### Letras

- `POST /api/lyrics/manual` - Processar letra colada manualmente
- `POST /api/lyrics/upload` - Upload de arquivo de letra

### Vídeo

- `POST /api/video/upload` - Upload de arquivos de mídia
- `POST /api/video/generate` - Gerar vídeo final
- `GET /api/video/download/:fileName` - Download do vídeo

### Projetos

- `POST /api/projects` - Criar projeto
- `GET /api/projects` - Listar projetos
- `GET /api/projects/:id` - Obter projeto
- `PUT /api/projects/:id` - Atualizar projeto
- `DELETE /api/projects/:id` - Deletar projeto

### Suporte

- `POST /api/support/report-error` - Relatar erro

### Pagamento

- `POST /api/payment/create-session` - Criar sessão de pagamento
- `POST /api/payment/webhook` - Webhook de pagamentos
- `GET /api/payment/subscription` - Status da assinatura

## 🔒 Autenticação

Todas as rotas protegidas requerem um token JWT do Supabase no header:

```
Authorization: Bearer <access_token>
```

O backend **NÃO** possui rotas de login/registro próprias. Toda autenticação é feita através do Supabase no frontend.

## 📝 Notas Importantes

- **Autenticação**: 100% gerenciada pelo Supabase
- **Uploads**: Arquivos são salvos em `uploads/<user_id>/`
- **Vídeos temporários**: Salvos em `uploads/temp/` e podem ser limpos periodicamente
- **FFmpeg**: Necessário para processamento de vídeo
- **Pagamentos**: Estrutura genérica preparada para integração futura

## 🐛 Relatórios de Erro

Os usuários podem relatar erros através da rota `/api/support/report-error`. Os relatórios são enviados por email para o endereço configurado em `ERROR_REPORT_EMAIL`.

## 📄 Licença

MIT

## 👨‍💻 Suporte

Para problemas ou dúvidas, entre em contato através do sistema de relatório de erros ou abra uma issue no repositório.
