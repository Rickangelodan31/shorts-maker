// Gathers everything the hook generator needs about a clip, reusing data already produced
// by the existing pipeline instead of re-deriving or re-scanning anything:
//   - transcript          <- cand.localWords (persisted by pipeline.js:renderOneClip)
//   - scenes              <- entry.segments (already persisted for the manual editor)
//   - detected subjects   <- cand.layoutTimeline / cand.resolvedReactionComposite
//   - representative frames <- extracted from the ACTUAL RENDERED clip (what the viewer
//     will see), sampled with the same early-weighted timing semantic.js already uses for
//     hook validation, so "the first few seconds matter most" is consistent across the app.
const path = require('path');
const fs = require('fs');
const { extractFrame } = require('../ffutil');
const { pickHookSampleTimes } = require('../semantic');
const { inferUserTypeFromLayout } = require('../effects');

const FRAME_COUNT = parseInt(process.env.HOOK_FRAME_COUNT || '6', 10);

function buildScenes(segments) {
  if (!segments || !segments.length) return [];
  return segments.map((s) => ({
    start: Math.round(s.start * 10) / 10,
    end: Math.round(s.end * 10) / 10,
    type: inferUserTypeFromLayout(s), // 'full' | 'split' | 'reactor' | 'content'
  }));
}

function buildDetectedSubjects(layoutTimeline, reactionComposite) {
  const maxFaceCount = Math.max(0, ...(layoutTimeline || []).map((c) => c.people?.faceCount || 0));
  return {
    maxFaceCount,
    isReactionComposite: !!reactionComposite?.isReactionComposite,
    reactionConfidence: reactionComposite?.confidence ?? null,
  };
}

// The non-visual half of clip context — transcript/scenes/subjects only, no frame
// extraction/IO. Reused by BOTH the initial (vision) generation and the cheaper text-only
// follow-up calls (Generate More / Generate Better Versions), so a regeneration never has
// to re-touch the rendered file just to re-derive transcript/scene data that's already
// sitting on the job's in-memory candidate/entry.
function gatherTextContext({ entry, cand }) {
  const duration = entry.length;
  const transcript = (cand.localWords || []).map((w) => ({
    t: Math.round(w.start * 100) / 100,
    w: w.text,
  }));
  const scenes = buildScenes(entry.segments);
  const detectedSubjects = buildDetectedSubjects(cand.layoutTimeline, cand.resolvedReactionComposite);
  return { duration, transcript, scenes, detectedSubjects };
}

// Full context INCLUDING representative frames extracted from the ACTUAL RENDERED clip —
// only needed for the one initial vision call. tmpDir: caller-owned scratch dir (pipeline.js
// passes the clip's own clipTmp); frames are deleted by the caller after the LLM call, not
// here, so a failed LLM call still leaves cleanup to exactly one place.
async function gatherClipContext({ entry, cand, outputPath, tmpDir }) {
  const textContext = gatherTextContext({ entry, cand });

  const sampleTimes = pickHookSampleTimes(textContext.duration, FRAME_COUNT);
  const framePaths = [];
  for (const t of sampleTimes) {
    const framePath = path.join(tmpDir, `hookcap_${Math.round(t * 10)}.jpg`);
    try {
      await extractFrame(outputPath, t, framePath, { maxWidth: 512 });
      framePaths.push({ t, path: framePath });
    } catch (err) {
      console.warn(`[captionAi] frame sample @ t=${t.toFixed(1)}s failed: ${err.message}`);
    }
  }

  return { ...textContext, framePaths };
}

function cleanupFrames(framePaths) {
  for (const f of framePaths || []) fs.unlink(f.path, () => {});
}

module.exports = { gatherTextContext, gatherClipContext, cleanupFrames };
