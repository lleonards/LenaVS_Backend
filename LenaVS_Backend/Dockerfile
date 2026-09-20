FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

WORKDIR /app

# =========================================================
# Dependências do sistema
# =========================================================
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    ffmpeg \
    ca-certificates \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

# =========================================================
# Dependências Node.js
# =========================================================
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

# =========================================================
# Ambiente Python do Demucs
# =========================================================
COPY requirements-demucs.txt ./

# Criamos um ambiente virtual para evitar o bloqueio
# PEP 668 do Python/Debian.
RUN python3 -m venv /opt/lenavs-demucs \
  && /opt/lenavs-demucs/bin/python -m pip install \
       --upgrade pip setuptools wheel \
  && /opt/lenavs-demucs/bin/python -m pip install \
       -r requirements-demucs.txt

# Faz com que "python", "python3" e "pip" apontem
# primeiro para o ambiente virtual do LenaVS.
ENV PATH="/opt/lenavs-demucs/bin:$PATH"

# =========================================================
# Código da aplicação
# =========================================================
COPY . .

EXPOSE 10000

CMD ["npm", "start"]
