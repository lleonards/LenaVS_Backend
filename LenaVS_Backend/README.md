# LenaVS Backend

Backend do LenaVS, responsável por autenticação protegida via Supabase, upload de mídia, salvamento de projetos, controle de créditos e geração do vídeo karaokê final.

## O que este backend faz hoje

- recebe uploads de áudio, vídeo, imagem e letra
- processa letras por arquivo ou texto manual
- salva projetos do editor
- controla histórico e biblioteca pública
- gera o vídeo final com:
  - fundo por cor, imagem ou vídeo
  - áudio original ou instrumental
  - renderização das estrofes com estilo e transição
- libera o download do vídeo com consumo de crédito no plano free

---

## Stack

- Node.js
- Express
- Supabase
- FFmpeg
- Multer
- Jimp

---

## Requisitos

- Node.js 18+
- FFmpeg instalado
- projeto Supabase configurado
- variáveis de ambiente válidas

---

## Instalação

```bash
npm install
```

## Executar em desenvolvimento

```bash
npm run dev
```

## Executar em produção

```bash
npm start
```

Servidor padrão:

```bash
http://localhost:10000
```

---

## Variáveis de ambiente principais

Exemplo mínimo:

```env
PORT=10000
BACKEND_URL=http://localhost:10000
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
SUPABASE_ANON_KEY=sua-anon-key
ALLOWED_ORIGINS=http://localhost:5173,https://seu-frontend.onrender.com
NODE_ENV=production
```

Se usar Render, também pode aproveitar `RENDER_EXTERNAL_URL` como fallback para a URL pública do backend.

---

## Fluxo atual de exportação

1. frontend salva ou atualiza o projeto
2. frontend chama `POST /api/video/generate`
3. backend monta o fundo final:
   - vídeo ajustado à duração do áudio
   - imagem convertida em vídeo
   - ou fundo por cor
4. backend gera um arquivo `.ass` com as estrofes para aplicar no vídeo
5. backend renderiza o vídeo final com FFmpeg
6. frontend chama `GET /api/video/download/:fileName`
7. no plano free, o download consome 1 crédito

---

## Créditos

### Regra atual

- usuário novo recebe **3 créditos** ao ser sincronizado pela primeira vez
- plano free consome **1 crédito por download de vídeo**
- a geração e o download fazem parte do fluxo do botão exportar no frontend
- o desconto acontece no endpoint de download

---

## Renderização das letras

O backend gera o vídeo final com base nas estrofes salvas no projeto e respeita os campos atuais do editor:

- texto
- tempo inicial e final
- fonte
- tamanho da fonte
- cor do texto
- cor da borda
- negrito
- itálico
- sublinhado
- alinhamento
- transição
- duração da transição

As legendas são convertidas para ASS e aplicadas sobre o vídeo final no FFmpeg.

---

## Uploads aceitos

### Áudio

- mp3
- wav
- ogg
- m4a
- aac
- flac
- wma

### Vídeo

- mp4
- mov
- avi
- mkv

### Imagem

- jpg
- jpeg
- png
- gif
- bmp

### Letras

- txt
- docx
- pdf
- doc

---

## Formatos de saída do vídeo

- mp4
- avi
- mov
- mkv

---

## Rotas principais

### Saúde

- `GET /`
- `GET /health`

### Auth / usuário

- `GET /api/auth/me`
- `GET /api/user/me`
- `POST /api/user/consume-credit`

### Letras

- `POST /api/lyrics/upload`
- `POST /api/lyrics/manual`

### Vídeo

- `POST /api/video/upload`
- `POST /api/video/generate`
- `GET /api/video/download/:fileName`

### Projetos

- `GET /api/projects`
- `POST /api/projects`
- `PUT /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/projects/library`
- `PATCH /api/projects/:id/toggle-public`
- `POST /api/projects/:id/fork`

---

## Deploy no Render

Use o script `render-build.sh`.

Ele instala:

- ffmpeg
- fonts-dejavu-core
- fonts-liberation
- fonts-montserrat

Isso ajuda a renderização do texto no vídeo final.

---

## Observações importantes

- uploads ficam em `uploads/<user_id>/`
- arquivos temporários de geração ficam em `uploads/temp/`
- downloads de vídeo são protegidos por autenticação
- o frontend precisa enviar o token do Supabase nas rotas protegidas

---

## Licença

MIT
