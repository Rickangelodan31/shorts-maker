// Prompts and style metadata for the AI on-screen hook + caption + hashtag generator, run
// locally via Ollama (see src/captionAi/ollamaClient.js). Kept separate from src/captions.js
// (which burns word-timed subtitles into the video via .ass) — this module is a different
// concept: short text ABOUT the clip (an on-screen hook) plus a social post caption and
// hashtags, generated after rendering, never burned into the video automatically.
//
// The local model gets no image input (text/metadata only — see analyzer.js's
// gatherTextContext), and no OpenAI-style structured-output enforcement, so the prompt itself
// does the structuring: an explicit XML shape the model must reproduce exactly, parsed back
// out by xmlParser.js.

// "punchy" stands in for the spec's "Short/Punchy" style; keys are lowercase, no spaces, so
// they round-trip cleanly through prompt text, XML attributes, and CSS class names.
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

const HOOK_RULES = `You write ON-SCREEN HOOK text for a short-form vertical video (TikTok/Reels/Shorts) — the
3-10 word line a creator would overlay on the video itself — plus a social-media post caption
and hashtags for the same clip. You are given the clip's word-timed transcript and scene/
subject metadata. You are NOT shown the video frames, so never invent visuals, expressions, or
anything else you weren't told about — base everything strictly on the transcript/metadata given.

Hard rules for hooks:
- Base every hook on what ACTUALLY happens in the clip per the transcript. Never invent
  events, quotes, or claims that aren't supported by the transcript you were given.
- Do not default to generic hooks ("OMG 😱", "This is crazy!", "You won't believe this!")
  unless the clip genuinely earns that reaction — prefer specific, concrete language over
  generic hype.
- Length: prefer 3-10 words, a hard ceiling of ~15 words unless there is a strong reason to go
  longer (state that reason nowhere — just don't exceed it without one).
- Emojis: 0-3 per hook, only when they reinforce the actual emotion (😂 funny, 😭 disbelief/
  laughing, 💀 absurd/funny, 😳 shock, 👀 curiosity, 🔥 impressive, 🤯 surprising, 😬
  uncomfortable, ❤️ emotional). Never force an emoji onto a hook that doesn't need one.
- Sound like a human short-form creator wrote it, not an AI. No corporate or "content
  marketing" phrasing.
- Never claim a verified identity for anyone shown — describe role/reaction, not asserted names.
- Use ONLY styles that genuinely fit this specific clip, chosen from: ${STYLE_KEYS.join(', ')}.

Hard rules for the caption:
- 1-3 sentences, written the way a creator writes a post caption (distinct from the on-screen
  hook — not a summary/description of the clip) — it should make someone want to comment,
  share, or watch again.
- Grounded in the transcript, no invented claims.

Hard rules for hashtags:
- Exactly 3, relevant to the clip's actual topic/niche, one word each (no spaces), no leading
  "#" (it will be added automatically).
- No generic filler tags ("fyp", "viral", "foryou") unless nothing more specific genuinely fits.`;

// Explicit brackets/XML tags, repeated exact counts, and a blunt "nothing else" instruction —
// small local models drift toward conversational filler ("Sure, here are..."/trailing notes)
// far more than hosted frontier models, so the format has to be spelled out this literally.
const INITIAL_OUTPUT_FORMAT = `Respond with ONLY the structure below. No preamble, no explanation, no markdown code
fences, no conversational filler before or after it — your entire response must be exactly
this structure and nothing else:

<hooks>
<hook style="STYLE_KEY">first hook text</hook>
<hook style="STYLE_KEY">second hook text</hook>
<hook style="STYLE_KEY">third hook text</hook>
</hooks>
<caption>the engaging post caption text</caption>
<hashtags>
<hashtag>firsttag</hashtag>
<hashtag>secondtag</hashtag>
<hashtag>thirdtag</hashtag>
</hashtags>

Replace STYLE_KEY with one of: ${STYLE_KEYS.join(', ')}. Output exactly 3 <hook> tags, exactly
one <caption> tag, and exactly 3 <hashtag> tags — nothing more, nothing less.`;

const HOOKS_ONLY_OUTPUT_FORMAT = `Respond with ONLY the structure below. No preamble, no explanation, no markdown code
fences, no conversational filler before or after it — your entire response must be exactly
this structure and nothing else:

<hooks>
<hook style="STYLE_KEY">first hook text</hook>
<hook style="STYLE_KEY">second hook text</hook>
<hook style="STYLE_KEY">third hook text</hook>
</hooks>

Replace STYLE_KEY with one of: ${STYLE_KEYS.join(', ')}. Output 3-5 <hook> tags — new
alternatives, not a caption or hashtags.`;

// Full initial generation — the only call that also produces a caption and hashtags.
const INITIAL_SYSTEM = `${HOOK_RULES}

${INITIAL_OUTPUT_FORMAT}`;

// Cheaper follow-up call ("Generate More") — hooks only, reusing the same transcript/scene
// data (no separate cached "analysis" step now that generation is text-only end to end).
const MORE_OPTIONS_SYSTEM = `${HOOK_RULES}

Generate NEW hook alternatives for this clip. Do not repeat any hook already listed as
"already shown" almost verbatim — give genuinely different phrasing/angles. If a specific
style was requested, every alternative must be in that style; only fall back to a different
style if that requested style truly doesn't fit this clip (explain nothing, just don't force it).

${HOOKS_ONLY_OUTPUT_FORMAT}`;

// "Generate Better Versions" — same shape as MORE_OPTIONS, but seeded with the user's own
// draft so the model strengthens it instead of writing something unrelated.
const IMPROVE_CAPTION_SYSTEM = `${HOOK_RULES}

The user wrote their own draft hook for this clip (given below). Generate stronger
alternatives that PRESERVE the user's intended meaning/angle while making the hook more
engaging, specific, and natural — do not change what the user is trying to say, only how well
it's said.

${HOOKS_ONLY_OUTPUT_FORMAT}`;

module.exports = {
  STYLE_KEYS, STYLE_META,
  INITIAL_SYSTEM, MORE_OPTIONS_SYSTEM, IMPROVE_CAPTION_SYSTEM,
};
