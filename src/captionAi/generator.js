// AI calls for the on-screen hook + caption + hashtag generator. Every exported function
// NEVER throws — each always resolves to a status object the UI can render directly
// ({status: 'ready'|'unavailable'|'error', ...}), because a failure here must never be
// allowed to affect video generation (see pipeline.js's one call site) or surface as an
// unhandled API error.
//
// Runs against a local Ollama server (llama3.2), not OpenAI — see ollamaClient.js. Ollama has
// no vision input on this model, so generation is text-only: transcript + scene/subject
// metadata (see analyzer.js:gatherTextContext), never the rendered video's frames.
const llm = require('./ollamaClient');
const { gatherTextContext } = require('./analyzer');
const { validateInitialResult, validateAlternativesResult } = require('./validator');
const { parseHooksCaptionHashtags } = require('./xmlParser');
const { INITIAL_SYSTEM, MORE_OPTIONS_SYSTEM, IMPROVE_CAPTION_SYSTEM } = require('./prompt');

function isAvailable() {
  return llm.isAvailable();
}

const EMPTY_READY_SHAPE = { primary: null, alternatives: [], caption: null, hashtags: [] };

// Analyzes the clip's transcript/scene/subject data and produces the on-screen hooks (exactly
// 3), a post caption, and 3 hashtags in one round trip. Called once, automatically, right
// after a clip finishes rendering (pipeline.js:renderOneClip), and again on "Try Again" if the
// first attempt failed (server.js action=retry). `outputPath`/`tmpDir` are accepted but unused
// here — kept in the destructured signature so existing call sites don't need to change; they
// were needed only by the old OpenAI-vision flow's frame extraction.
async function generateInitial({ entry, cand }) {
  if (!isAvailable()) return { status: 'unavailable', ...EMPTY_READY_SHAPE, selectedText: null };
  try {
    const ctx = gatherTextContext({ entry, cand });
    const raw = await llm.complete({
      system: INITIAL_SYSTEM,
      user: {
        durationSec: ctx.duration, transcript: ctx.transcript,
        scenes: ctx.scenes, detectedSubjects: ctx.detectedSubjects,
      },
    });
    if (!raw) return { status: 'error', ...EMPTY_READY_SHAPE, selectedText: null };

    const validated = validateInitialResult(parseHooksCaptionHashtags(raw));
    if (!validated) return { status: 'error', ...EMPTY_READY_SHAPE, selectedText: null };

    console.log(`[captionAi] candidate=${entry.candidateIndex} primary hook (${validated.primary.style}): "${validated.primary.text}"`);
    return { status: 'ready', ...validated, selectedText: null, generatedAt: Date.now() };
  } catch (err) {
    console.warn('[captionAi] initial generation failed:', err.message);
    return { status: 'error', ...EMPTY_READY_SHAPE, selectedText: null };
  }
}

// "Generate More" — new hook alternatives only (no caption/hashtags regeneration). `style`
// (optional): constrain to one style; `excludeTexts`: hooks already shown, so a regeneration
// doesn't just repeat itself.
async function generateMore({ entry, cand, style, excludeTexts = [] }) {
  if (!isAvailable()) return { status: 'unavailable', alternatives: [] };
  try {
    const ctx = gatherTextContext({ entry, cand });
    const raw = await llm.complete({
      system: MORE_OPTIONS_SYSTEM,
      user: {
        durationSec: ctx.duration, transcript: ctx.transcript,
        scenes: ctx.scenes, detectedSubjects: ctx.detectedSubjects,
        requestedStyle: style || null,
        alreadyShown: excludeTexts,
      },
    });
    if (!raw) return { status: 'error', alternatives: [] };

    const validated = validateAlternativesResult(parseHooksCaptionHashtags(raw), excludeTexts);
    if (!validated) return { status: 'error', alternatives: [] };
    return { status: 'ready', ...validated };
  } catch (err) {
    console.warn('[captionAi] generateMore failed:', err.message);
    return { status: 'error', alternatives: [] };
  }
}

// "Generate Better Versions" — same shape as generateMore, but seeded with the user's own
// draft so the model strengthens it instead of writing something unrelated.
async function improveCaption({ entry, cand, userCaption, excludeTexts = [] }) {
  if (!isAvailable()) return { status: 'unavailable', alternatives: [] };
  const draft = (userCaption || '').trim();
  if (!draft) return { status: 'error', alternatives: [] };
  try {
    const ctx = gatherTextContext({ entry, cand });
    const raw = await llm.complete({
      system: IMPROVE_CAPTION_SYSTEM,
      user: {
        durationSec: ctx.duration, transcript: ctx.transcript,
        scenes: ctx.scenes, detectedSubjects: ctx.detectedSubjects,
        userDraft: draft,
        alreadyShown: excludeTexts,
      },
    });
    if (!raw) return { status: 'error', alternatives: [] };

    const validated = validateAlternativesResult(parseHooksCaptionHashtags(raw), excludeTexts);
    if (!validated) return { status: 'error', alternatives: [] };
    return { status: 'ready', ...validated };
  } catch (err) {
    console.warn('[captionAi] improveCaption failed:', err.message);
    return { status: 'error', alternatives: [] };
  }
}

module.exports = { isAvailable, generateInitial, generateMore, improveCaption };
