// AI calls for the on-screen hook generator. Every exported function NEVER throws — each
// always resolves to a status object the UI can render directly ({status: 'ready'|
// 'unavailable'|'error', ...}), because a failure here must never be allowed to affect video
// generation (see pipeline.js's one call site) or surface as an unhandled API error.
const llm = require('../llm');
const { gatherClipContext, gatherTextContext, cleanupFrames } = require('./analyzer');
const { validateInitialResult, validateAlternativesResult } = require('./validator');
const {
  INITIAL_HOOK_SCHEMA, INITIAL_HOOK_SYSTEM,
  MORE_OPTIONS_SCHEMA, MORE_OPTIONS_SYSTEM,
  IMPROVE_CAPTION_SYSTEM,
} = require('./prompt');

function isAvailable() {
  return llm.isAvailable();
}

const EMPTY_READY_SHAPE = { primary: null, alternatives: [], analysis: null };

// The one vision call in this feature — analyzes the ACTUAL RENDERED clip (frames + full
// transcript + scene/subject data) and produces both the understanding (topic/keyMoment/
// emotion/whyViewerShouldCare) and the first hook options in one round trip. Called once,
// automatically, right after a clip finishes rendering (pipeline.js:renderOneClip).
async function generateInitial({ entry, cand, outputPath, tmpDir }) {
  if (!isAvailable()) return { status: 'unavailable', ...EMPTY_READY_SHAPE, selectedText: null };

  let framePaths = [];
  try {
    const ctx = await gatherClipContext({ entry, cand, outputPath, tmpDir });
    framePaths = ctx.framePaths;
    if (!framePaths.length) {
      console.warn('[captionAi] no frames could be extracted from the rendered clip — skipping hook generation');
      return { status: 'error', ...EMPTY_READY_SHAPE, selectedText: null };
    }

    const raw = await llm.completeVisionJSON({
      system: INITIAL_HOOK_SYSTEM,
      user: {
        durationSec: ctx.duration, transcript: ctx.transcript,
        scenes: ctx.scenes, detectedSubjects: ctx.detectedSubjects,
        frameTimes: framePaths.map((f) => f.t),
      },
      images: framePaths,
      schema: INITIAL_HOOK_SCHEMA,
      schemaName: 'hook_generation',
    });
    const validated = validateInitialResult(raw);
    if (!validated) return { status: 'error', ...EMPTY_READY_SHAPE, selectedText: null };

    console.log(`[captionAi] candidate=${entry.candidateIndex} primary hook (${validated.primary.style}, conf=${validated.primary.confidence.toFixed(2)}): "${validated.primary.text}"`);
    return { status: 'ready', ...validated, selectedText: null, generatedAt: Date.now() };
  } catch (err) {
    console.warn('[captionAi] initial generation failed:', err.message);
    return { status: 'error', ...EMPTY_READY_SHAPE, selectedText: null };
  } finally {
    cleanupFrames(framePaths);
  }
}

// "Generate More" — cheap text-only call reusing the analysis already cached on
// entry.hook.analysis from the initial vision call, so re-generating alternatives never
// re-extracts frames or re-pays for vision tokens. `style` (optional): constrain to one
// style; `excludeTexts`: hooks already shown, so a regeneration doesn't just repeat itself.
async function generateMore({ entry, cand, analysis, style, excludeTexts = [] }) {
  if (!isAvailable()) return { status: 'unavailable', alternatives: [] };
  try {
    const ctx = gatherTextContext({ entry, cand });
    const raw = await llm.completeJSON({
      system: MORE_OPTIONS_SYSTEM,
      user: {
        durationSec: ctx.duration, transcript: ctx.transcript,
        scenes: ctx.scenes, detectedSubjects: ctx.detectedSubjects,
        priorAnalysis: analysis || null,
        requestedStyle: style || null,
        alreadyShown: excludeTexts,
      },
      schema: MORE_OPTIONS_SCHEMA,
      schemaName: 'hook_more_options',
    });
    const validated = validateAlternativesResult(raw, excludeTexts);
    if (!validated) return { status: 'error', alternatives: [] };
    return { status: 'ready', ...validated };
  } catch (err) {
    console.warn('[captionAi] generateMore failed:', err.message);
    return { status: 'error', alternatives: [] };
  }
}

// "Generate Better Versions" — same shape as generateMore, but seeded with the user's own
// draft so the model strengthens it instead of writing something unrelated.
async function improveCaption({ entry, cand, analysis, userCaption, excludeTexts = [] }) {
  if (!isAvailable()) return { status: 'unavailable', alternatives: [] };
  const draft = (userCaption || '').trim();
  if (!draft) return { status: 'error', alternatives: [] };
  try {
    const ctx = gatherTextContext({ entry, cand });
    const raw = await llm.completeJSON({
      system: IMPROVE_CAPTION_SYSTEM,
      user: {
        durationSec: ctx.duration, transcript: ctx.transcript,
        scenes: ctx.scenes, detectedSubjects: ctx.detectedSubjects,
        priorAnalysis: analysis || null,
        userDraft: draft,
        alreadyShown: excludeTexts,
      },
      schema: MORE_OPTIONS_SCHEMA,
      schemaName: 'hook_improve_options',
    });
    const validated = validateAlternativesResult(raw, excludeTexts);
    if (!validated) return { status: 'error', alternatives: [] };
    return { status: 'ready', ...validated };
  } catch (err) {
    console.warn('[captionAi] improveCaption failed:', err.message);
    return { status: 'error', alternatives: [] };
  }
}

module.exports = { isAvailable, generateInitial, generateMore, improveCaption };
