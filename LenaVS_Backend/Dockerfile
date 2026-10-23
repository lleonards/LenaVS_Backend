FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    ASS_FONTS_DIR=/usr/share/fonts/truetype/montserrat

WORKDIR /app

# ---------------------------------------------------------
# Sistema: Python + FFmpeg + ferramentas necessarias
#
# IMPORTANTE: no Debian bookworm NAO existe o pacote
# "fonts-montserrat" (ele existe no Ubuntu). Por isso a
# Montserrat e copiada da pasta fonts/ do proprio projeto.
# ---------------------------------------------------------
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    ffmpeg \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    ca-certificates \
    curl \
    build-essential \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------
# Fontes usadas na renderizacao do karaoke (libass/ffmpeg)
# ---------------------------------------------------------
COPY fonts/ /usr/share/fonts/truetype/montserrat/

RUN fc-cache -f && fc-list | grep -i montserrat | head -n 5

# ---------------------------------------------------------
# Dependencias Node.js
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

ENV PATH="/opt/lenavs-demucs/bin:$PATH"

# ---------------------------------------------------------
# Codigo da aplicacao
# ---------------------------------------------------------
COPY . .

EXPOSE 10000

CMD ["npm", "start"]
