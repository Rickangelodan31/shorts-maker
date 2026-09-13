// Gathers everything the hook/caption generator needs about a clip, reusing data already
// produced by the existing pipeline instead of re-deriving or re-scanning anything:
//   - transcript          <- cand.localWords (persisted by pipeline.js:renderOneClip)
//   - scenes              <- entry.segments (already persisted for the manual editor)
//   - detected subjects   <- cand.layoutTimeline / cand.resolvedReactionComposite
// Text-only, on purpose: generation runs against a local Ollama text model (llama3.2), which
// has no vision input, so unlike the old OpenAI-vision flow this never extracts or reads
// video frames.
const { inferUserTypeFromLayout } = require('../effects');

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

// Everything the generator needs about a clip — transcript/scenes/subjects, no frame
// extraction/IO. Reused by every generation call (initial, Generate More, Generate Better
// Versions), so a regeneration never has to re-touch the rendered file at all.
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

module.exports = { gatherTextContext };
