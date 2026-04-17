const DEFAULT_TIMECODE = '00:00';
const DEFAULT_FONT_SIZE = 32;
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 120;
const OUTLINE_WIDTH_MIN = 1;
const OUTLINE_WIDTH_MAX = 10;
const SCALE_X_MIN = 0.6;
const SCALE_X_MAX = 1.8;
const SCALE_Y_MIN = 0.35;
const SCALE_Y_MAX = 4;
const TRANSITION_DURATION_MIN = 0.1;
const TRANSITION_DURATION_MAX = 5;
const VALID_TRANSITIONS = new Set(['fade', 'slide', 'zoom-in', 'zoom-out']);

const DEFAULT_POSITION = {
  x: 50,
  y: 78,
};

const DEFAULT_TRANSFORM = {
  scaleX: 1,
  scaleY: 1,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeScaleX = (value) => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return DEFAULT_TRANSFORM.scaleX;
  }

  return Number(clamp(numeric, SCALE_X_MIN, SCALE_X_MAX).toFixed(2));
};

const normalizeScaleY = (value) => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return DEFAULT_TRANSFORM.scaleY;
  }

  return Number(clamp(numeric, SCALE_Y_MIN, SCALE_Y_MAX).toFixed(3));
};

const normalizeOutlineWidth = (value) => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 2;
  }

  return Math.round(clamp(numeric, OUTLINE_WIDTH_MIN, OUTLINE_WIDTH_MAX));
};

const normalizeFontSize = (value) => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return DEFAULT_FONT_SIZE;
  }

  return Math.round(clamp(numeric, FONT_SIZE_MIN, FONT_SIZE_MAX));
};

const normalizeTransition = (value) => {
  const normalized = String(value || 'fade').trim().toLowerCase();
  return VALID_TRANSITIONS.has(normalized) ? normalized : 'fade';
};

const normalizeTransitionDuration = (value) => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 1;
  }

  return Number(clamp(numeric, TRANSITION_DURATION_MIN, TRANSITION_DURATION_MAX).toFixed(2));
};

export const normalizeProjectStanzas = (stanzas = []) => {
  if (!Array.isArray(stanzas)) return [];

  return stanzas.map((stanza, index) => ({
    id: stanza?.id ?? `stanza-${index + 1}`,
    text: String(stanza?.text || ''),
    startTime: String(stanza?.startTime || DEFAULT_TIMECODE),
    endTime: String(stanza?.endTime || DEFAULT_TIMECODE),
    fontSize: normalizeFontSize(stanza?.fontSize),
    fontFamily: String(stanza?.fontFamily || 'Montserrat'),
    color: String(stanza?.color || '#FFFFFF'),
    outlineColor: String(stanza?.outlineColor || '#000000'),
    outlineWidth: normalizeOutlineWidth(stanza?.outlineWidth),
    bold: Boolean(stanza?.bold),
    italic: Boolean(stanza?.italic),
    underline: Boolean(stanza?.underline),
    transition: normalizeTransition(stanza?.transition),
    transitionDuration: normalizeTransitionDuration(stanza?.transitionDuration),
    alignment: String(stanza?.alignment || 'center'),
    leadIn: Number(stanza?.leadIn ?? 0.5),
    lines: Array.isArray(stanza?.lines) ? stanza.lines : [],
    hasManualStart: Boolean(stanza?.hasManualStart),
    hasManualEnd: Boolean(stanza?.hasManualEnd),
    isDuplicateCopy: Boolean(stanza?.isDuplicateCopy),
    position: {
      ...DEFAULT_POSITION,
      ...(stanza?.position || {}),
    },
    scaleX: normalizeScaleX(stanza?.scaleX ?? DEFAULT_TRANSFORM.scaleX),
    scaleY: normalizeScaleY(stanza?.scaleY ?? DEFAULT_TRANSFORM.scaleY),
  }));
};

export const normalizeProjectPayload = (payload = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  return {
    ...payload,
    stanzas: normalizeProjectStanzas(payload.stanzas || []),
  };
};
