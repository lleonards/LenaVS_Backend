#!/bin/bash
# Script de build para Render.com
# Instala FFmpeg, Python/Demucs e dependências do Node.js

set -e

export PIP_ROOT_USER_ACTION=ignore

echo "📦 Instalando FFmpeg, Python e fontes..."
apt-get update -qq
apt-get install -y -qq ffmpeg python3 python3-pip python3-venv fonts-dejavu-core fonts-liberation fonts-montserrat

echo "📦 Atualizando pip e instalando PyTorch CPU + Demucs..."
python3 -m pip install --no-input --upgrade pip setuptools wheel
python3 -m pip install --no-input -r requirements-demucs.txt

echo "📦 Instalando dependências do Node.js..."
npm install

echo "✅ Build concluído com Demucs local!"
