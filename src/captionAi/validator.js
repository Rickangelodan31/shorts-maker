const { STYLE_KEYS } = require('./prompt');

const MAX_WORDS_HARD = 20; // beyond this a "hook" has stopped being a hook; drop it rather than trim mid-thought
const MAX_EMOJI = 3;

// Rough emoji counter (counts codepoints outside the BMP, which is what covers ], plus
// common symbol-range emoji like ‼/★ used elsewhere in this app) — good enough for a soft
// quality signal, not used to mutate text.
function countEmoji(text) {
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return matches ? matches.length : 0;
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Validates one {text, style} hook item. Returns the cleaned item or null if it should be
// dropped entirely — never mutates wording (that risks changing meaning), only trims
// whitespace and enforces hard structural bounds.
function validateHookItem(item) {
  if (!item || typeof item.text !== 'string') return null;
  const text = item.text.trim();
  if (!text) return null;
  if (wordCount(text) > MAX_WORDS_HARD) {
    console.warn(`[captionAi] dropping hook (${wordCount(text)} words, over hard cap): "${text}"`);
    return null;
  }
  if (countEmoji(text) > MAX_EMOJI) {
    console.warn(`[captionAi] hook has more than ${MAX_EMOJI} emoji, keeping anyway (soft rule): "${text}"`);
  }
  const style = STYLE_KEYS.includes(item.style) ? item.style : null;
  if (!style) {
    console.warn(`[captionAi] dropping hook with unknown style "${item.style}": "${text}"`);
    return null;
  }
  return { text, style };
}

// Validates the full initial-generation response. Returns null if the response is
// structurally unusable (no primary AND no alternatives survive) so the caller can treat it
// exactly like an LLM failure.
function validateInitialResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const primary = raw.primary ? validateHookItem(raw.primary) : null;
  const primaryConfidence = typeof raw.primary?.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.primary.confidence))
    : null;
  const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .map(validateHookItem)
    .filter(Boolean)
    // Never show the primary again as an "alternative".
    .filter((a) => !primary || a.text !== primary.text);

  if (!primary && !alternatives.length) return null;

  const analysis = {
    topic: typeof raw.topic === 'string' ? raw.topic : null,
    keyMoment: typeof raw.keyMoment === 'string' ? raw.keyMoment : null,
    emotion: typeof raw.emotion === 'string' ? raw.emotion : null,
    whyViewerShouldCare: typeof raw.whyViewerShouldCare === 'string' ? raw.whyViewerShouldCare : null,
  };

  return {
    primary: primary ? { ...primary, confidence: primaryConfidence ?? 0.5 } : (alternatives[0] || null),
    alternatives: primary ? alternatives : alternatives.slice(1),
    analysis,
  };
}

// Validates a {alternatives:[...]} follow-up response (Generate More / Generate Better
// Versions). Returns null if nothing usable survived.
function validateAlternativesResult(raw, excludeTexts = []) {
  if (!raw || !Array.isArray(raw.alternatives)) return null;
  const excluded = new Set(excludeTexts.map((t) => t.trim().toLowerCase()));
  const alternatives = raw.alternatives
    .map(validateHookItem)
    .filter(Boolean)
    .filter((a) => !excluded.has(a.text.toLowerCase()));
  if (!alternatives.length) return null;
  return { alternatives };
}

module.exports = { validateHookItem, validateInitialResult, validateAlternativesResult, wordCount, countEmoji };
