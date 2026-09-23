FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

WORKDIR /app

# ---------------------------------------------------------
# Sistema: Python + FFmpeg + ferramentas necessárias
# ---------------------------------------------------------
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    ffmpeg \
    ca-certificates \
    build-essential \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------
# Dependências Node.js
# ---------------------------------------------------------
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

# ---------------------------------------------------------
# Ambiente Python isolado para Demucs
# Evita o erro PEP 668 do Debian Bookworm
# ---------------------------------------------------------
COPY requirements-demucs.txt ./

RUN python3 -m venv /opt/lenavs-demucs \
  && /opt/lenavs-demucs/bin/python -m pip install --upgrade pip setuptools wheel \
  && /opt/lenavs-demucs/bin/python -m pip install -r requirements-demucs.txt

# Faz o Python do ambiente Demucs ficar disponível pelo PATH
ENV PATH="/opt/lenavs-demucs/bin:$PATH"

# ---------------------------------------------------------
# Código da aplicação
# ---------------------------------------------------------
COPY . .

# ---------------------------------------------------------
# Porta usada pelo Render
# ---------------------------------------------------------
EXPOSE 10000

# ---------------------------------------------------------
# Inicialização
# ---------------------------------------------------------
CMD ["npm", "start"]
