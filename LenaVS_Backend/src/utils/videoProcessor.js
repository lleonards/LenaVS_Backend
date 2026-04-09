import ffmpeg from 'fluent-ffmpeg';
import Jimp from 'jimp';
import fs from 'fs';
import { promisify } from 'util';

const unlinkAsync = promisify(fs.unlink);

const RESOLUTIONS = {
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4K': { width: 3840, height: 2160 },
};

const BASE_EXPORT_SIZE = RESOLUTIONS['720p'];
const OUTPUT_FORMATS = new Set(['mp4', 'mov', 'mkv', 'avi']);

const FONT_FAMILY_MAP = {
  Montserrat: 'Montserrat',
  Arial: 'Arial',
  Impact: 'Impact',
  Verdana: 'Verdana',
  Georgia: 'Georgia',
  'Courier New': 'Courier New',
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeNumber = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const parseFixedTimecode = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const parts = raw.split(':').map((segment) => Number(segment));
  if (parts.some((segment) => !Number.isFinite(segment) || segment < 0)) {
    return null;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  return null;
};

const formatAssTimestamp = (seconds) => {
  const totalCentiseconds = Math.max(0, Math.round((Number(seconds) || 0) * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;

  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
};

const sanitizeHexColor = (value, fallback = '#FFFFFF') => {
  const raw = String(value || '').trim();
  const match = raw.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : fallback;
};

const assColorFromHex = (value, alpha = '00') => {
  const safeHex = sanitizeHexColor(value).replace('#', '');
  const rr = safeHex.slice(0, 2);
  const gg = safeHex.slice(2, 4);
  const bb = safeHex.slice(4, 6);
  return `&H${alpha}${bb}${gg}${rr}&`;
};

const normalizeOutputFormat = (value = 'mp4') => {
  const normalized = String(value || 'mp4').trim().toLowerCase();
  return OUTPUT_FORMATS.has(normalized) ? normalized : 'mp4';
};

const getCodecOptionsByFormat = (format = 'mp4') => {
  const normalized = normalizeOutputFormat(format);

  if (normalized === 'avi') {
    return [
      '-c:v mpeg4',
      '-q:v 5',
      '-pix_fmt yuv420p',
      '-c:a libmp3lame',
      '-b:a 192k',
      '-shortest',
    ];
  }

  const baseOptions = [
    '-c:v libx264',
    '-preset medium',
    '-crf 18',
    '-pix_fmt yuv420p',
    '-c:a aac',
    '-b:a 192k',
    '-shortest',
  ];

  if (normalized === 'mp4' || normalized === 'mov') {
    return [...baseOptions, '-movflags +faststart'];
  }

  return baseOptions;
};

const getAlignmentCode = (alignment = 'center') => {
  switch (String(alignment || '').toLowerCase()) {
    case 'left':
      return 4;
    case 'right':
      return 6;
    case 'center':
    default:
      return 5;
  }
};

const getResolutionScale = (resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  return Math.min(width / BASE_EXPORT_SIZE.width, height / BASE_EXPORT_SIZE.height);
};

const scaleFromPreview = (value, resolution, options = {}) => {
  const { min = 1, max = Number.POSITIVE_INFINITY, round = true } = options;
  const numericValue = normalizeNumber(value, min);
  const scaledValue = numericValue * getResolutionScale(resolution);
  const clampedValue = clamp(scaledValue, min, max);
  return round ? Math.round(clampedValue) : clampedValue;
};

const getAnchorX = (alignment, width) => {
  const safePadding = Math.round(width * 0.07);

  switch (String(alignment || '').toLowerCase()) {
    case 'left':
      return safePadding;
    case 'right':
      return width - safePadding;
    case 'center':
    default:
      return Math.round(width / 2);
  }
};

const wrapParagraph = (paragraph, maxWidth, measureText) => {
  const normalizedParagraph = String(paragraph ?? '');
  const words = normalizedParagraph.trim().split(/\s+/).filter(Boolean);

  if (!words.length) {
    return [''];
  }

  const lines = [];
  let currentLine = '';

  words.forEach((word) => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (!currentLine || measureText(candidate) <= maxWidth) {
      currentLine = candidate;
      return;
    }

    lines.push(currentLine);
    currentLine = word;
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
};

const wrapTextForAss = (stanza, resolution) => {
  const { width } = getResolutionDimensions(resolution);
  const scaledFontSize = clamp(
    scaleFromPreview(normalizeNumber(stanza?.fontSize, 32), resolution, { min: 12, max: 220 }),
    12,
    220
  );
  const text = String(stanza?.text || '').replace(/\r/g, '');
  const paragraphs = text.split('\n');
  const widthFactor = stanza?.bold ? 0.62 : 0.58;
  const maxWidth = Math.max(200, width - Math.round(width * 0.12));
  const measureText = (line) => String(line || '').length * scaledFontSize * widthFactor;

  const wrappedLines = paragraphs.flatMap((paragraph) => wrapParagraph(paragraph, maxWidth, measureText));

  return wrappedLines
    .map((line) => line.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')'))
    .join('\\N')
    .trim();
};

const buildSubtitleTags = (stanza, resolution) => {
  const { width, height } = getResolutionDimensions(resolution);
  const alignment = String(stanza?.alignment || 'center').toLowerCase();
  const alignCode = getAlignmentCode(alignment);
  const anchorX = getAnchorX(alignment, width);
  const anchorY = Math.round(height / 2);
  const durationSeconds = clamp(normalizeNumber(stanza?.transitionDuration, 1), 0.1, 5);
  const durationMs = Math.max(100, Math.round(durationSeconds * 1000));
  const scaleX = clamp(Math.round(normalizeNumber(stanza?.scaleX, 1) * 100), 35, 400);
  const scaleY = clamp(Math.round(normalizeNumber(stanza?.scaleY, 1) * 100), 35, 400);
  const fontFamily = FONT_FAMILY_MAP[stanza?.fontFamily] || 'Arial';
  const scaledFontSize = clamp(
    scaleFromPreview(normalizeNumber(stanza?.fontSize, 32), resolution, { min: 12, max: 220 }),
    12,
    220
  );
  const outlineSize = clamp(
    scaleFromPreview(normalizeNumber(stanza?.outlineWidth, 2), resolution, { min: 1, max: 12 }),
    1,
    12
  );
  const slideOffset = clamp(scaleFromPreview(30, resolution, { min: 12, max: 120 }), 12, 120);

  const tags = [
    `\\an${alignCode}`,
    `\\fn${fontFamily}`,
    `\\fs${scaledFontSize}`,
    `\\1c${assColorFromHex(stanza?.color || '#FFFFFF')}`,
    `\\3c${assColorFromHex(stanza?.outlineColor || '#000000')}`,
    `\\bord${outlineSize}`,
    '\\shad0',
    `\\b${stanza?.bold ? 1 : 0}`,
    `\\i${stanza?.italic ? 1 : 0}`,
    `\\u${stanza?.underline ? 1 : 0}`,
  ];

  const transition = String(stanza?.transition || 'fade').toLowerCase();

  if (transition === 'slide') {
    tags.push(`\\move(${anchorX},${anchorY + slideOffset},${anchorX},${anchorY},0,${durationMs})`);
  } else {
    tags.push(`\\pos(${anchorX},${anchorY})`);
  }

  if (transition === 'fade') {
    tags.push(`\\fad(${durationMs},0)`);
  } else if (transition === 'zoom-in') {
    tags.push(`\\fscx${Math.max(35, Math.round(scaleX * 0.82))}`);
    tags.push(`\\fscy${Math.max(35, Math.round(scaleY * 0.82))}`);
    tags.push(`\\t(0,${durationMs},\\fscx${scaleX}\\fscy${scaleY})`);
  } else if (transition === 'zoom-out') {
    tags.push(`\\fscx${Math.min(400, Math.round(scaleX * 1.18))}`);
    tags.push(`\\fscy${Math.min(400, Math.round(scaleY * 1.18))}`);
    tags.push(`\\t(0,${durationMs},\\fscx${scaleX}\\fscy${scaleY})`);
  } else {
    tags.push(`\\fscx${scaleX}`);
    tags.push(`\\fscy${scaleY}`);
  }

  if (transition !== 'zoom-in' && transition !== 'zoom-out') {
    tags.push(`\\fscx${scaleX}`);
    tags.push(`\\fscy${scaleY}`);
  }

  return tags.join('');
};

export const getResolutionDimensions = (resolution = '720p') => {
  return RESOLUTIONS[resolution] || RESOLUTIONS['720p'];
};

export const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
};

export const getVideoDuration = (videoPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
};

export const imageToVideo = async (imagePath, duration, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop 1', `-t ${duration}`])
      .outputOptions(['-c:v libx264', '-preset veryfast', '-pix_fmt yuv420p', '-r 30'])
      .size(`${width}x${height}`)
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
};

export const adjustVideoToAudioDuration = async (videoPath, audioDuration, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  const videoDuration = await getVideoDuration(videoPath);

  return new Promise((resolve, reject) => {
    const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;

    if (videoDuration >= audioDuration) {
      ffmpeg()
        .input(videoPath)
        .setDuration(audioDuration)
        .videoFilter(scaleFilter)
        .outputOptions(['-c:v libx264', '-preset veryfast', '-pix_fmt yuv420p', '-r 30'])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .run();
    } else {
      const loops = Math.max(1, Math.ceil(audioDuration / Math.max(videoDuration, 0.1)));

      ffmpeg()
        .input(videoPath)
        .inputOptions([`-stream_loop ${loops}`])
        .setDuration(audioDuration)
        .videoFilter(scaleFilter)
        .outputOptions(['-c:v libx264', '-preset veryfast', '-pix_fmt yuv420p', '-r 30'])
        .output(outputPath)
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .run();
    }
  });
};

export const resizeImageTo16_9 = async (imagePath, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);

  try {
    const image = await Jimp.read(imagePath);
    await image.cover(width, height).quality(90).writeAsync(outputPath);
    return outputPath;
  } catch (error) {
    throw new Error(`Erro ao redimensionar imagem: ${error.message}`);
  }
};

export const createColorBackground = async (color, duration, outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  const safeColor = sanitizeHexColor(color || '#000000', '#000000');
  const tempImagePath = `${outputPath}.jpg`;

  try {
    const image = await new Jimp(width, height, safeColor);
    await image.quality(100).writeAsync(tempImagePath);
    await imageToVideo(tempImagePath, duration, outputPath, resolution);
    await cleanupTempFiles([tempImagePath]);
    return outputPath;
  } catch (error) {
    await cleanupTempFiles([tempImagePath]);
    throw new Error(`Erro ao criar fundo colorido: ${error.message}`);
  }
};

export const createAssSubtitleFile = async (stanzas = [], outputPath, resolution = '720p') => {
  const { width, height } = getResolutionDimensions(resolution);
  const dialogueLines = (Array.isArray(stanzas) ? stanzas : [])
    .map((stanza) => {
      const start = parseFixedTimecode(stanza?.startTime);
      const end = parseFixedTimecode(stanza?.endTime);
      const leadIn = Math.max(0, normalizeNumber(stanza?.leadIn, 0.5));
      const displayStart = stanza?.showOnlyDuringVocal ? start : Math.max(0, (start ?? 0) - leadIn);

      if (start === null || end === null || end <= start) {
        return null;
      }

      const text = wrapTextForAss(stanza, resolution);
      if (!text) {
        return null;
      }

      const tags = buildSubtitleTags(stanza, resolution);
      return `Dialogue: 0,${formatAssTimestamp(displayStart)},${formatAssTimestamp(end)},Default,,0,0,0,,{${tags}}${text}`;
    })
    .filter(Boolean);

  const assContent = [
    '[Script Info]',
    'Title: LenaVS Export',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.601',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,32,${assColorFromHex('#FFFFFF')},${assColorFromHex('#FFFFFF')},${assColorFromHex('#000000')},&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,32,32,32,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogueLines,
    '',
  ].join('\n');

  await fs.promises.writeFile(outputPath, assContent, 'utf8');
  return outputPath;
};

const escapeAssFilterPath = (filePath) => {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
};

export const generateFinalVideo = async ({
  backgroundPath,
  audioPath,
  outputPath,
  subtitlesPath = null,
  format = 'mp4',
}) => {
  const normalizedFormat = normalizeOutputFormat(format);

  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(backgroundPath)
      .input(audioPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        ...getCodecOptionsByFormat(normalizedFormat),
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (error) => reject(new Error(`Erro ao gerar vídeo final: ${error.message}`)));

    if (subtitlesPath) {
      command.videoFilters([`ass='${escapeAssFilterPath(subtitlesPath)}'`]);
    }

    command.run();
  });
};

export const cleanupTempFiles = async (files = []) => {
  for (const file of files) {
    try {
      if (file && fs.existsSync(file)) {
        await unlinkAsync(file);
      }
    } catch (error) {
      console.error(`Erro ao limpar arquivo ${file}:`, error);
    }
  }
};

export { normalizeOutputFormat };
