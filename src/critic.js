// Plan doc M5 — the post-render quality critic. Every other quality check in this app runs
// BEFORE render, on sampled SOURCE frames (semantic.js:runVisionValidation) — nothing today
// evaluates the actual FINISHED clip. This module fills that one genuinely new gap, using the
// exact same schema-driven llm.js pattern the rest of the app already uses (never a competing
// provider/engine): a single completeVisionJSON call per rendered clip returning a
// pass/reject verdict, reasons, and confidence. Like every other function in this codebase's
// LLM call sites, this NEVER throws — null means "no signal, unavailable/failed," and the
// caller (pipeline.js) must never treat null as a rejection.
const fs = require('fs');
const path = require('path');
const { extractFrame } = require('./ffutil');
const llm = require('./llm');

function isAvailable() {
  return llm.isAvailable();
}

const CRITIC_FRAME_COUNT = parseInt(process.env.CRITIC_FRAME_COUNT || '5', 10);

// Evenly-spaced sample times across the finished clip's own duration — this is judging the
// WHOLE rendered clip (not a hook zone), so unlike semantic.js:pickHookSampleTimes there's no
// reason to bias toward the early seconds.
function pickCritiqueSampleTimes(durationSec, count = CRITIC_FRAME_COUNT) {
  const n = Math.max(1, count);
  return Array.from({ length: n }, (_, i) => (durationSec * (i + 0.5)) / n);
}

const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'reject'] },
    reasons: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['verdict', 'reasons', 'confidence'],
};

const CRITIC_SYSTEM = `You are the final quality check for a finished short-form vertical video clip, seen right
before it would be shown to the user as one of their generated shorts. You are given sampled
frames from the ACTUAL RENDERED CLIP (not the original long-form source) plus its word-timed
transcript and a summary of which framing/layout segments make up its timeline.

Judge only what's given. REJECT the clip ONLY for a genuine, significant problem a viewer
would actually notice — never for stylistic preference or a minor imperfection. Specifically
check:
- Does the clip make sense as a standalone piece of content, without the original long video?
- Is there an actual reason to watch (a hook, a story, a laugh, an emotional or surprising
  moment) — or is it a flat, uneventful stretch with nothing happening?
- Is the correct/most relevant person visible and in frame for the moments that matter?
- Is any face awkwardly cropped, cut off, or otherwise obscured?
- Is there a sustained shot of mostly empty background/table/wall with no visible subject,
  when the source clearly has a person available to show instead?
- Is there a large stretch of dead air/silence with nothing happening on screen?
- Are captions (if visible in the frames) legible and not obscuring something important?
- Is anything visually broken or clearly wrong (a garbled/black frame, a wildly wrong crop)?

Prefer PASS when in doubt — only REJECT for a clear, real problem you can point to in
reasons. Give confidence (0..1) in your verdict. Never claim a verified identity for anyone
shown — describe role/reaction, not asserted names.`;

// Returns { verdict: 'pass'|'reject', reasons: string[], confidence: number } or null on
// failure/unavailable/no-frames — callers MUST treat null as "no signal, do not reject."
async function critiqueRenderedClip({ outputPath, words, segments, durationSec, tmpDir }) {
  if (!isAvailable() || !durationSec) return null;

  const sampleTimes = pickCritiqueSampleTimes(durationSec);
  const framePaths = [];
  for (const t of sampleTimes) {
    const framePath = path.join(tmpDir, `critique_${Math.round(t * 10)}.jpg`);
    try {
      await extractFrame(outputPath, t, framePath, { maxWidth: 512 });
      framePaths.push({ t, path: framePath });
    } catch (err) {
      console.warn(`[stage=critic] frame sample @ t=${t.toFixed(1)}s failed: ${err.message}`);
    }
  }
  if (!framePaths.length) return null;

  const wordsSummary = (words || []).map((w) => ({ t: Math.round(w.start * 100) / 100, w: w.text }));
  const scenesSummary = (segments || []).map((s) => ({
    start: Math.round(s.start * 10) / 10,
    end: Math.round(s.end * 10) / 10,
    type: s.tag || s.layout?.type || 'unknown',
  }));

  let result;
  try {
    result = await llm.completeVisionJSON({
      system: CRITIC_SYSTEM,
      user: { durationSec, transcript: wordsSummary, scenes: scenesSummary, frameTimes: framePaths.map((f) => f.t) },
      images: framePaths,
      schema: CRITIC_SCHEMA,
      schemaName: 'clip_critic',
    });
  } finally {
    framePaths.forEach((f) => fs.unlink(f.path, () => {}));
  }
  if (!result) return null;

  const verdict = {
    verdict: result.verdict === 'reject' ? 'reject' : 'pass',
    reasons: Array.isArray(result.reasons) ? result.reasons : [],
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
  };
  console.log(`[stage=critic] verdict=${verdict.verdict} confidence=${verdict.confidence ?? 'n/a'} reasons=${JSON.stringify(verdict.reasons)}`);
  return verdict;
}

module.exports = { isAvailable, critiqueRenderedClip, pickCritiqueSampleTimes, CRITIC_SCHEMA };
