// Prompts, schemas, and style metadata for the AI on-screen hook generator. Kept separate
// from src/captions.js (which burns word-timed subtitles into the video via .ass) — this
// module is a different concept: one short punchy line ABOUT the clip, generated after
// rendering, never burned in automatically.

// "punchy" stands in for the spec's "Short/Punchy" style; keys are lowercase, no spaces, so
// they round-trip cleanly through JSON schema enums and CSS class names.
const STYLE_KEYS = ['curiosity', 'shock', 'controversial', 'funny', 'reaction', 'story', 'punchy', 'question'];

const STYLE_META = {
  curiosity: { label: 'Curiosity', emoji: '👀' },
  shock: { label: 'Shock', emoji: '😳' },
  controversial: { label: 'Controversial', emoji: '💀' },
  funny: { label: 'Funny', emoji: '😂' },
  reaction: { label: 'Reaction', emoji: '😭' },
  story: { label: 'Story / Context', emoji: '' },
  punchy: { label: 'Short / Punchy', emoji: '💀' },
  question: { label: 'Question', emoji: '👀' },
};

const HOOK_RULES = `You write ON-SCREEN HOOK text for a short-form vertical video (TikTok/Reels/Shorts) —
the 3-10 word line a creator would overlay on the video itself, NOT a social-media post
caption. You are given the clip's actual transcript (word-timed) and sampled frames from the
ACTUAL RENDERED clip, in chronological order, weighted toward the first few seconds because
that's where a viewer decides whether to keep watching.

Before writing anything, you must understand the clip: what happens, who is reacting, what
the reaction is, what the key/payoff moment is, and why a viewer would care. Only THEN write
hooks grounded in that understanding.

Hard rules:
- Base every hook on what ACTUALLY happens in the clip. Never invent events, quotes, or
  claims that aren't supported by the transcript/frames you were given.
- Do not default to generic hooks ("OMG 😱", "This is crazy!", "You won't believe this!")
  unless the clip genuinely earns that reaction — prefer specific, concrete language over
  generic hype.
- Length: prefer 3-10 words, a hard ceiling of ~15 words unless there is a strong reason to
  go longer (state that reason nowhere — just don't exceed it without one).
- Emojis: 0-3 per hook, only when they reinforce the actual emotion (😂 funny, 😭 disbelief/
  laughing, 💀 absurd/funny, 😳 shock, 👀 curiosity, 🔥 impressive, 🤯 surprising, 😬
  uncomfortable, ❤️ emotional). Never force an emoji onto a hook that doesn't need one.
- Sound like a human short-form creator wrote it, not an AI. No corporate or "content
  marketing" phrasing.
- Never claim a verified identity for anyone shown — describe role/reaction, not asserted names.

Available styles (use ONLY ones that genuinely fit this specific clip — never force a style
that doesn't apply): curiosity, shock, controversial, funny, reaction, story, punchy, question.`;

const ANALYSIS_FIELDS_SCHEMA = {
  topic: { type: 'string', description: 'What the clip is actually about, one sentence.' },
  keyMoment: { type: 'string', description: 'The specific moment/line that is the payoff, one sentence.' },
  emotion: { type: 'string', description: 'The dominant emotion of the moment (e.g. shock, humor, tension).' },
  whyViewerShouldCare: { type: 'string', description: 'Why a scrolling viewer would stop and watch, one sentence.' },
};

const HOOK_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    style: { type: 'string', enum: STYLE_KEYS },
  },
  required: ['text', 'style'],
};

// Full initial analysis + generation call (vision — the only call in this feature that pays
// for frame tokens; every regeneration after this reuses the cached analysis via text-only
// calls, see generator.js).
const INITIAL_HOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...ANALYSIS_FIELDS_SCHEMA,
    primary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        style: { type: 'string', enum: STYLE_KEYS },
        confidence: { type: 'number' },
      },
      required: ['text', 'style', 'confidence'],
    },
    alternatives: { type: 'array', items: HOOK_ITEM_SCHEMA },
  },
  required: ['topic', 'keyMoment', 'emotion', 'whyViewerShouldCare', 'primary', 'alternatives'],
};

const INITIAL_HOOK_SYSTEM = `${HOOK_RULES}

Return your understanding of the clip (topic, keyMoment, emotion, whyViewerShouldCare) AND a
primary hook (your single best recommendation, with a confidence 0..1) AND 3-5 alternatives
in different styles that also genuinely fit. Do not repeat the same style twice unless the
clip only supports one style well.`;

// Cheaper follow-up calls (text-only, no frames — reuses the cached analysis from the
// initial vision call) for "Generate More" and "Generate Better Versions".
const MORE_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { alternatives: { type: 'array', items: HOOK_ITEM_SCHEMA } },
  required: ['alternatives'],
};

const MORE_OPTIONS_SYSTEM = `${HOOK_RULES}

You already analyzed this clip earlier; that understanding (topic/keyMoment/emotion/why a
viewer should care) is given to you again below — use it, don't re-derive it from scratch.
Generate 3-5 NEW hook alternatives. Do not repeat any hook already listed as "already shown"
almost verbatim — give genuinely different phrasing/angles. If a specific style was
requested, every alternative must be in that style; only fall back to a different style if
that requested style truly doesn't fit this clip (explain nothing, just don't force it).`;

const IMPROVE_CAPTION_SYSTEM = `${HOOK_RULES}

The user wrote their own draft hook for this clip (given below along with your earlier
analysis of the clip). Generate 3-5 stronger alternatives that PRESERVE the user's intended
meaning/angle while making the hook more engaging, specific, and natural — do not change
what the user is trying to say, only how well it's said.`;

module.exports = {
  STYLE_KEYS, STYLE_META,
  INITIAL_HOOK_SCHEMA, INITIAL_HOOK_SYSTEM,
  MORE_OPTIONS_SCHEMA, MORE_OPTIONS_SYSTEM,
  IMPROVE_CAPTION_SYSTEM,
};
