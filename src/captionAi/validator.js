const { STYLE_KEYS } = require('./prompt');

const MAX_WORDS_HARD = 20; // beyond this a "hook" has stopped being a hook; drop it rather than trim mid-thought
const MAX_EMOJI = 3;
const HASHTAG_COUNT = 3;
const FALLBACK_STYLE = 'punchy'; // used only when the local model drops/mangles the style attribute

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

// Validates one {text, style} hook item parsed from a <hook> tag. Returns the cleaned item or
// null if it should be dropped entirely — never mutates wording (that risks changing
// meaning), only trims whitespace and enforces hard structural bounds. An unknown/missing
// style falls back to a default rather than dropping the hook: local models frequently
// mangle or omit the style="" attribute even when the hook text itself is perfectly usable.
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
  const style = STYLE_KEYS.includes(item.style) ? item.style : FALLBACK_STYLE;
  return { text, style };
}

// "topic", "1", "#topic" -> "topic"; drops anything that's empty once normalized.
function normalizeHashtag(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^#/, '').replace(/\s+/g, '');
  return cleaned ? `#${cleaned}` : null;
}

// Validates the initial generation's parsed {hooks, caption, hashtags} (see xmlParser.js).
// Returns null if the response is structurally unusable (no hooks survived at all) so the
// caller treats it exactly like an LLM failure — a missing caption/hashtags alone is NOT
// fatal, since hooks are the feature's core output.
function validateInitialResult(parsed) {
  if (!parsed) return null;
  const hooks = (parsed.hooks || []).map(validateHookItem).filter(Boolean);
  if (!hooks.length) return null;

  const caption = typeof parsed.caption === 'string' && parsed.caption.trim() ? parsed.caption.trim() : null;
  const hashtags = (parsed.hashtags || []).map(normalizeHashtag).filter(Boolean).slice(0, HASHTAG_COUNT);

  const [primary, ...alternatives] = hooks;
  return { primary, alternatives, caption, hashtags };
}

// Validates a {hooks: [...]} follow-up response (Generate More / Generate Better Versions).
// Returns null if nothing usable survived.
function validateAlternativesResult(parsed, excludeTexts = []) {
  if (!parsed || !Array.isArray(parsed.hooks)) return null;
  const excluded = new Set(excludeTexts.map((t) => t.trim().toLowerCase()));
  const alternatives = parsed.hooks
    .map(validateHookItem)
    .filter(Boolean)
    .filter((a) => !excluded.has(a.text.toLowerCase()));
  if (!alternatives.length) return null;
  return { alternatives };
}

module.exports = {
  validateHookItem, validateInitialResult, validateAlternativesResult, normalizeHashtag, wordCount, countEmoji,
};
