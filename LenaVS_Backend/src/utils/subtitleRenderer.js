const DEFAULT_TIMECODE = '00:00';
const DEFAULT_LEAD_IN = 0.5;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const parseFixedTimecode = (value) => {
  const normalized = String(value ?? '').trim();

  if (!normalized || normalized === DEFAULT_TIMECODE) {
    return normalized === DEFAULT_TIMECODE ? 0 : null;
  }

  const match = normalized.match(/^(\d{2,}):(\d{2})(?:\.(\d{1,2}))?$/);
  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const centiseconds = Number(match[3] || 0);

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) {
    return null;
  }

  return (minutes * 60) + seconds + (centiseconds / 100);
};

const hasConfiguredTiming = (stanza = {}) => {
  const start = parseFixedTimecode(stanza.startTime);
  const end = parseFixedTimecode(stanza.endTime);

  if (start === null || end === null || end < start) {
    return false;
  }

  if (stanza?.hasManualStart && stanza?.hasManualEnd) {
    return true;
  }

  const rawStart = String(stanza?.startTime ?? '').trim();
  const rawEnd = String(stanza?.endTime ?? '').trim();

  return !(rawStart === DEFAULT_TIMECODE && rawEnd === DEFAULT_TIMECODE);
};

const getDisplayStart = (stanza = {}) => {
  const start = parseFixedTimecode(stanza.startTime);
  if (start === null) return null;

  const leadIn = Number.isFinite(Number(stanza?.leadIn))
    ? Number(stanza.leadIn)
    : DEFAULT_LEAD_IN;

  return Math.max(0, start - leadIn);
};

const toAssTime = (seconds) => {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = Math.floor(safeSeconds % 60);
  const centiseconds = Math.round((safeSeconds - Math.floor(safeSeconds)) * 100);

  const normalizedSecs = centiseconds === 100 ? secs + 1 : secs;
  const normalizedCentiseconds = centiseconds === 100 ? 0 : centiseconds;
  const overflowMinutes = normalizedSecs >= 60 ? 1 : 0;
  const finalSecs = normalizedSecs % 60;
  const finalMinutes = minutes + overflowMinutes;
  const overflowHours = finalMinutes >= 60 ? 1 : 0;
  const safeMinutes = finalMinutes % 60;
  const safeHours = hours + overflowHours;

  return `${safeHours}:${String(safeMinutes).padStart(2, '0')}:${String(finalSecs).padStart(2, '0')}.${String(normalizedCentiseconds).padStart(2, '0')}`;
};

const hexToAssColor = (hex = '#FFFFFF') => {
  const normalized = String(hex || '#FFFFFF').trim().replace('#', '');
  const sixDigits = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized.padEnd(6, 'F').slice(0, 6);

  const r = sixDigits.slice(0, 2);
  const g = sixDigits.slice(2, 4);
  const b = sixDigits.slice(4, 6);

  return `&H00${b}${g}${r}&`;
};

const escapeAssText = (value = '') => {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n/g, '\\N')
    .replace(/\r/g, '\\N')
    .replace(/\n/g, '\\N');
};

const escapePathForFfmpegSubtitles = (value = '') => {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
};

const normalizeTransition = (value) => {
  const allowed = new Set(['fade', 'slide', 'zoom-in', 'zoom-out']);
  const normalized = String(value || 'fade').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : 'fade';
};

const getTransitionTags = (stanza = {}, width = 1280, height = 720) => {
  const transition = normalizeTransition(stanza.transition);
  const durationMs = Math.round(clamp(Number(stanza.transitionDuration) || 1, 0.1, 5) * 1000);
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height / 2);
  const scaleX = Math.round((Number(stanza.scaleX) || 1) * 100);
  const scaleY = Math.round((Number(stanza.scaleY) || 1) * 100);

  const baseTags = [`\\an5`, `\\pos(${centerX},${centerY})`, `\\fscx${scaleX}`, `\\fscy${scaleY}`];

  switch (transition) {
    case 'slide':
      return `${baseTags.join('')}\\move(${centerX},${centerY + 30},${centerX},${centerY},0,${durationMs})`;
    case 'zoom-in':
      return `${baseTags.join('')}\\fscx${Math.round(scaleX * 0.82)}\\fscy${Math.round(scaleY * 0.82)}\\t(0,${durationMs},\\fscx${scaleX}\\fscy${scaleY})`;
    case 'zoom-out':
      return `${baseTags.join('')}\\fscx${Math.round(scaleX * 1.18)}\\fscy${Math.round(scaleY * 1.18)}\\t(0,${durationMs},\\fscx${scaleX}\\fscy${scaleY})`;
    case 'fade':
    default:
      return `${baseTags.join('')}\\fad(${durationMs},0)`;
  }
};

const buildStyleLine = (stanza = {}, index = 0) => {
  const styleName = `Stanza${index + 1}`;
  const fontSize = clamp(Math.round(Number(stanza.fontSize) || 32), 12, 120);
  const fontFamily = String(stanza.fontFamily || 'Montserrat').replace(/,/g, ' ');
  const primaryColor = hexToAssColor(stanza.color || '#FFFFFF');
  const outlineColor = hexToAssColor(stanza.outlineColor || '#000000');
  const bold = stanza.bold ? -1 : 0;
  const italic = stanza.italic ? -1 : 0;
  const underline = stanza.underline ? -1 : 0;

  return `Style: ${styleName},${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},&H00000000&,${bold},${italic},${underline},0,100,100,0,0,1,2,0,5,32,32,32,1`;
};

export const buildAssSubtitleContent = (stanzas = [], resolution = { width: 1280, height: 720 }) => {
  const width = Number(resolution?.width) || 1280;
  const height = Number(resolution?.height) || 720;

  const validStanzas = Array.isArray(stanzas)
    ? stanzas.filter((stanza) => hasConfiguredTiming(stanza))
    : [];

  const styleLines = [];
  const dialogueLines = [];

  validStanzas.forEach((stanza, index) => {
    const start = getDisplayStart(stanza);
    const end = parseFixedTimecode(stanza.endTime);

    if (start === null || end === null || end <= start) {
      return;
    }

    styleLines.push(buildStyleLine(stanza, index));

    const tags = getTransitionTags(stanza, width, height);
    const text = escapeAssText(stanza.text || '');
    const styleName = `Stanza${index + 1}`;

    dialogueLines.push(
      `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},${styleName},,0,0,0,,{${tags}}${text}`
    );
  });

  if (!dialogueLines.length) {
    return null;
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...dialogueLines,
    '',
  ].join('\n');
};

export const buildSubtitleFilter = (subtitlePath) => {
  return `subtitles='${escapePathForFfmpegSubtitles(subtitlePath)}'`;
};
