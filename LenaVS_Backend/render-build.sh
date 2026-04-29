#!/bin/bash
# Script de build para Render.com
# Instala FFmpeg e dependências do Node.js

echo "📦 Instalando FFmpeg e fontes..."
apt-get update -qq
apt-get install -y -qq ffmpeg fonts-dejavu-core fonts-liberation fonts-montserrat

echo "📦 Instalando dependências do Node.js..."
npm install

echo "✅ Build concluído!"
