const DEFAULT_TIMECODE = '00:00';

const DEFAULT_POSITION = {
  x: 50,
  y: 78,
};

const DEFAULT_TRANSFORM = {
  scaleX: 1,
  scaleY: 1,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalizeScale = (value) => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return DEFAULT_TRANSFORM.scaleX;
  }

  return Number(clamp(numeric, 0.35, 4).toFixed(3));
};

export const normalizeProjectStanzas = (stanzas = []) => {
  if (!Array.isArray(stanzas)) return [];

  return stanzas.map((stanza, index) => ({
    id: stanza?.id ?? `stanza-${index + 1}`,
    text: String(stanza?.text || ''),
    startTime: String(stanza?.startTime || DEFAULT_TIMECODE),
    endTime: String(stanza?.endTime || DEFAULT_TIMECODE),
    fontSize: Number(stanza?.fontSize || 32),
    fontFamily: String(stanza?.fontFamily || 'Montserrat'),
    color: String(stanza?.color || '#FFFFFF'),
    outlineColor: String(stanza?.outlineColor || '#000000'),
    bold: Boolean(stanza?.bold),
    italic: Boolean(stanza?.italic),
    underline: Boolean(stanza?.underline),
    transition: String(stanza?.transition || 'fade'),
    transitionDuration: Number(stanza?.transitionDuration || 1),
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
    scaleX: normalizeScale(stanza?.scaleX ?? DEFAULT_TRANSFORM.scaleX),
    scaleY: normalizeScale(stanza?.scaleY ?? DEFAULT_TRANSFORM.scaleY),
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
