import ffmpeg from 'fluent-ffmpeg';
import { getResolutionDimensions, normalizeOutputFormat } from './videoProcessor.js';

const sanitizeHexColor = (value, fallback = '#000000') => {
  const raw = String(value || '').trim();
  const match = raw.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : fallback;
};

const escapeAssFilterPath = (filePath) => {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
};

const getVideoCodecOptionsByFormat = (format = 'mp4') => {
  const normalized = normalizeOutputFormat(format);

  if (normalized === 'avi') {
    return [
      '-c:v mpeg4',
      '-q:v 4',
      '-pix_fmt yuv420p',
      '-c:a libmp3lame',
      '-b:a 192k',
      '-shortest',
      '-max_muxing_queue_size 2048',
    ];
  }

  const preset = String(process.env.VIDEO_X264_PRESET || 'veryfast').trim() || 'veryfast';
  const crf = String(process.env.VIDEO_X264_CRF || '20').trim() || '20';

  const baseOptions = [
    '-c:v libx264',
    `-preset ${preset}`,
    `-crf ${crf}`,
    '-pix_fmt yuv420p',
    '-r 30',
    '-c:a aac',
    '-b:a 192k',
    '-shortest',
    '-max_muxing_queue_size 2048',
  ];

  if (normalized === 'mp4' || normalized === 'mov') {
    return [...baseOptions, '-movflags +faststart'];
  }

  return baseOptions;
};

const buildVideoBackgroundFilter = ({ width, height }) => {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
};

const buildImageBackgroundFilter = ({ width, height }) => {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
};

export const generateOptimizedFinalVideo = async ({
  backgroundType = 'color',
  backgroundPath = null,
  backgroundColor = '#000000',
  audioPath,
  audioDuration,
  outputPath,
  subtitlesPath = null,
  format = 'mp4',
  resolution = '720p',
}) => {
  const { width, height } = getResolutionDimensions(resolution);
  const normalizedFormat = normalizeOutputFormat(format);
  const safeDuration = Math.max(0.1, Number(audioDuration) || 0.1);

  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    let videoFilter = null;
    let audioInputIndex = 1;

    if (backgroundType === 'video' && backgroundPath) {
      command
        .input(backgroundPath)
        .inputOptions(['-stream_loop -1']);
      videoFilter = buildVideoBackgroundFilter({ width, height });
    } else if (backgroundType === 'image' && backgroundPath) {
      command
        .input(backgroundPath)
        .inputOptions(['-loop 1', '-framerate 30']);
      videoFilter = buildImageBackgroundFilter({ width, height });
    } else {
      const safeColor = sanitizeHexColor(backgroundColor, '#000000');
      command
        .input(`color=c=${safeColor}:s=${width}x${height}:r=30:d=${safeDuration}`)
        .inputOptions(['-f lavfi']);
      videoFilter = 'setsar=1';
    }

    command.input(audioPath);

    const filterChain = [videoFilter].filter(Boolean);
    if (subtitlesPath) {
      filterChain.push(`ass='${escapeAssFilterPath(subtitlesPath)}'`);
    }

    command
      .outputOptions([
        '-map 0:v:0',
        `-map ${audioInputIndex}:a:0`,
        `-t ${safeDuration}`,
        ...getVideoCodecOptionsByFormat(normalizedFormat),
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (error) => reject(new Error(`Erro ao gerar vídeo final: ${error.message}`)));

    if (filterChain.length > 0) {
      command.videoFilters(filterChain);
    }

    command.run();
  });
};
