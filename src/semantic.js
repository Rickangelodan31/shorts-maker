const llm = require('./llm');

const MAX_BOUNDARY_ADJUST_SEC = parseFloat(process.env.SEMANTIC_MAX_BOUNDARY_ADJUST_SEC || '5');
const HOOK_FRAME_COUNT = parseInt(process.env.SEMANTIC_HOOK_FRAME_COUNT || '8', 10);
const HOOK_SWITCH_MARGIN = parseFloat(process.env.HOOK_SWITCH_MARGIN || '0.15');
const VISION_BUDGET = parseInt(process.env.SEMANTIC_VISION_BUDGET || '15', 10);

function isAvailable() {
  return llm.isAvailable();
}

const CUT_QUALITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    semantic_completion: { type: 'number' },
    mid_sentence_penalty_start: { type: 'number' },
    mid_sentence_penalty_end: { type: 'number' },
    mid_action_penalty: { type: 'number' },
    continuity_break_penalty: { type: 'number' },
    reaction_value: { type: 'number' },
    narrative_completion: { type: 'number' },
    start_adjust_sec: { type: 'number' },
    end_adjust_sec: { type: 'number' },
    topic_summary: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: [
    'semantic_completion', 'mid_sentence_penalty_start', 'mid_sentence_penalty_end',
    'mid_action_penalty', 'continuity_break_penalty', 'reaction_value', 'narrative_completion',
    'start_adjust_sec', 'end_adjust_sec', 'topic_summary', 'rationale',
  ],
};

const CUT_QUALITY_SYSTEM = `You judge cut quality for a short-form video clip carved from a longer transcript.
You are given word-timed transcript text ("transcript") with a few seconds of context on
both sides of a currently-proposed clip, plus the proposed start/end times in the same
time units as transcript[].t (seconds, relative to the start of the given window).
Judge only from the words given — you cannot see video, so mid_action_penalty is a
best-effort guess from narration/text cues only, not a real visual judgment.
Never assert who is speaking to whom or claim verified speaker identity — describe only
topic and action. Propose start_adjust_sec/end_adjust_sec (positive = later/further out,
small values in seconds) that would move the cut onto a completed thought instead of
mid-sentence, only if needed.

MOST IMPORTANT RULE: a good clip is not just "an interesting moment" — it needs a
meaningful beginning, development, and ending as ONE coherent piece of content. Score
narrative_completion and continuity_break_penalty based on whether the CONVERSATION or
THOUGHT is complete, never based on whether a camera/scene change happens to fall inside
the window — you are not shown video, so you have no visual scene-change information
anyway; do not infer or penalize for one. If the same exchange/topic clearly continues
through the window, that is good continuity regardless of anything visual.`;

const CUT_SCORE_WEIGHTS = {
  audio: 0.35, completion: 0.18, narrative: 0.15, reaction: 0.10,
  midStart: 0.12, midEnd: 0.12, midAction: 0.06, continuity: 0.08,
};

// Blends pass-1's audio/visual score with the semantic completion signals. Falls back to
// the plain normalized score when no semantic signal exists (LLM unavailable/failed) —
// this is the "identity passthrough" no-op path.
function computeCutScore(normalizedScore, semantic) {
  if (!semantic) return normalizedScore;
  const w = CUT_SCORE_WEIGHTS;
  return (
    w.audio * normalizedScore +
    w.completion * semantic.semantic_completion +
    w.narrative * semantic.narrative_completion +
    w.reaction * semantic.reaction_value -
    w.midStart * semantic.mid_sentence_penalty_start -
    w.midEnd * semantic.mid_sentence_penalty_end -
    w.midAction * semantic.mid_action_penalty -
    w.continuity * semantic.continuity_break_penalty
  );
}

function overlaps(a, b) {
  const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  return ov > Math.min(a.length, b.length) * 0.4;
}

// Drops candidates that now overlap after independent boundary adjustments, keeping the
// higher-cutScore one — same dedup rule already used by the pass-1 generators.
function dedupeByOverlap(sortedCandidates) {
  const kept = [];
  for (const c of sortedCandidates) {
    if (!kept.some((k) => overlaps(k, c))) kept.push(c);
  }
  return kept;
}

async function defaultMapLimit(items, limit, fn) {
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// STAGE 1 — transcript-only semantic ranking. Mutates the given candidates (adding
// `semanticEvent`, `cutScore`, and adjusting start/end/length in place) and returns a
// NEW, re-sorted, deduped array. No-ops (cutScore = score, no semanticEvent) when the LLM
// is unavailable, preserving old ordering/behavior exactly.
async function rankCandidatesSemantic(candidates, words, { mapLimit = defaultMapLimit, concurrency = 4 } = {}) {
  if (!candidates.length) return candidates;

  if (!isAvailable()) {
    candidates.forEach((c) => { c.cutScore = c.score; });
    return [...candidates].sort((a, b) => b.cutScore - a.cutScore);
  }

  const scores = candidates.map((c) => c.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore || 1;

  await mapLimit(candidates, concurrency, async (candidate) => {
    const contextStart = Math.max(0, candidate.start - 8);
    const contextEnd = candidate.end + 8;
    const wordsInWindow = (words || [])
      .filter((w) => w.start >= contextStart && w.end <= contextEnd)
      .map((w) => ({ t: Math.round((w.start - contextStart) * 100) / 100, w: w.text }));

    const proposedStartRel = candidate.start - contextStart;
    const proposedEndRel = candidate.end - contextStart;

    const result = await llm.completeJSON({
      system: CUT_QUALITY_SYSTEM,
      user: { proposedStartRel, proposedEndRel, transcript: wordsInWindow },
      schema: CUT_QUALITY_SCHEMA,
      schemaName: 'cut_quality',
    });

    const normalizedScore = (candidate.score - minScore) / range;

    if (!result) {
      candidate.cutScore = computeCutScore(normalizedScore, null);
      console.log(`[stage=semantic] candidate start=${candidate.start.toFixed(1)} cutScore=${candidate.cutScore.toFixed(3)} (no LLM signal)`);
      return;
    }

    const startAdjust = Math.max(-MAX_BOUNDARY_ADJUST_SEC, Math.min(MAX_BOUNDARY_ADJUST_SEC, result.start_adjust_sec || 0));
    const endAdjust = Math.max(-MAX_BOUNDARY_ADJUST_SEC, Math.min(MAX_BOUNDARY_ADJUST_SEC, result.end_adjust_sec || 0));
    const newStart = Math.max(0, candidate.start + startAdjust);
    const newEnd = candidate.end + endAdjust;
    if (newEnd > newStart) {
      candidate.start = newStart;
      candidate.end = newEnd;
      candidate.length = newEnd - newStart; // pipeline.js reads .length, not .end — must stay in sync
    }

    candidate.semanticEvent = {
      semantic_completion: result.semantic_completion,
      mid_sentence_penalty_start: result.mid_sentence_penalty_start,
      mid_sentence_penalty_end: result.mid_sentence_penalty_end,
      mid_action_penalty: result.mid_action_penalty,
      continuity_break_penalty: result.continuity_break_penalty,
      reaction_value: result.reaction_value,
      narrative_completion: result.narrative_completion,
      topic_summary: result.topic_summary,
      rationale: result.rationale,
      start_adjust_sec: startAdjust,
      end_adjust_sec: endAdjust,
    };
    candidate.cutScore = computeCutScore(normalizedScore, candidate.semanticEvent);
    console.log(`[stage=semantic] candidate start=${candidate.start.toFixed(1)} cutScore=${candidate.cutScore.toFixed(3)} topic="${result.topic_summary}" adjust=[${startAdjust.toFixed(1)},${endAdjust.toFixed(1)}]`);
  });

  const sorted = [...candidates].sort((a, b) => b.cutScore - a.cutScore);
  return dedupeByOverlap(sorted);
}

// Denser sampling in the first 15s (candidate hook zone), sparser across the rest.
function pickHookSampleTimes(length, count = HOOK_FRAME_COUNT) {
  const early = Math.min(length, 15);
  const nEarly = Math.max(1, Math.ceil(count * 0.5));
  const nLate = Math.max(0, count - nEarly);
  const earlyTimes = Array.from({ length: nEarly }, (_, i) => (early * (i + 0.5)) / nEarly);
  const lateTimes = nLate > 0 && length > early
    ? Array.from({ length: nLate }, (_, i) => early + ((length - early) * (i + 0.5)) / nLate)
    : [];
  return [...earlyTimes, ...lateTimes];
}

const HOOK_VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chronological_hook_score: { type: 'number' },
    use_cold_open: { type: 'boolean' },
    hook_start_sec: { type: 'number' },
    hook_end_sec: { type: 'number' },
    hook_score: { type: 'number' },
    hook_reason: { type: 'string' },
    is_reaction_composite: { type: 'boolean' },
    facecam_x: { type: 'number' },
    facecam_y: { type: 'number' },
    facecam_w: { type: 'number' },
    facecam_h: { type: 'number' },
    facecam_confidence: { type: 'number' },
    renderable: { type: 'boolean' },
    rejection_reasons: { type: 'array', items: { type: 'string' } },
    editorial_would_use: { type: 'boolean' },
    editorial_reason: { type: 'string' },
  },
  required: [
    'chronological_hook_score', 'use_cold_open', 'hook_start_sec', 'hook_end_sec', 'hook_score', 'hook_reason',
    'is_reaction_composite', 'facecam_x', 'facecam_y', 'facecam_w', 'facecam_h', 'facecam_confidence',
    'renderable', 'rejection_reasons', 'editorial_would_use', 'editorial_reason',
  ],
};

const HOOK_VALIDATION_SYSTEM = `You are validating one candidate short-form video clip using sampled frames (labeled with
their time in seconds, "t") and its word-timed transcript. Only judge what's given — you
are not shown anything outside this window, and times you return must stay within
[0, window length]. Never identify who is speaking to whom or claim verified identity —
describe topic/visual content only.

1. HOOK: score how strong the CHRONOLOGICAL opening (the first few seconds) is as a hook
   (curiosity/surprise/emotional impact/clarity) as chronological_hook_score (0..1). Then
   check whether some OTHER moment within this same window would make a meaningfully
   stronger opening if moved to the front (a "cold open") — if so set use_cold_open=true
   and give its start/end (1-6 seconds, must start after t=3s in the window) and its own
   hook_score; a cold open must not spoil the entire payoff, just create curiosity. If no
   moment beats the chronological opening, set use_cold_open=false and use -1 for
   hook_start_sec/hook_end_sec.

2. REACTION COMPOSITE: determine whether this footage is a facecam-reaction-over-content
   composite (one person's face, likely in a fixed corner/edge position, overlaid on
   separate content like gameplay/video/screen recording, all within ONE video frame).
   If so, set is_reaction_composite=true and give the facecam's approximate bounding box
   as fractions of frame width/height, TOP-LEFT origin (facecam_x, facecam_y, facecam_w,
   facecam_h, each 0..1) and a confidence (0..1). If not applicable, set
   is_reaction_composite=false and use -1 for facecam_x/y/w/h and 0 for facecam_confidence.

3. RENDERABILITY: decide whether this window is actually usable as a short-form clip.
   Check specifically: is a face obscured or absent when it should be visible, would any
   reasonable crop of what's shown be invalid (nothing framable), is content that should
   be visible (e.g. the thing being reacted to) actually NOT visible, is the overall
   composition unusable, and — if the transcript implies a reaction is happening — is
   there no visual reaction context at all. A camera angle or scene change happening
   partway through this window is NOT by itself a reason to reject it — only reject for a
   genuine visual/composition problem. Set renderable=false and list rejection_reasons
   (short strings) if any of the real problems above are true. Finally give an overall
   editorial_would_use verdict answering: is this a coherent piece of content with a real
   beginning, development, and ending (not just one interesting frame plus interesting
   words stapled together), and would a professional short-form editor actually use this
   exact moment and framing — with a one-line editorial_reason.`;

// STAGE 2 — vision + hook + reaction-composite + renderability, one combined call.
// Returns null on failure/unavailable/no-frames (caller treats as "no vision signal",
// falls back to chronological order + CV-fallback composite detection + always-on
// deterministic crop validation).
async function runVisionValidation({ windowLengthSec, words, framePaths }) {
  if (!isAvailable() || !framePaths || !framePaths.length) return null;

  const wordsSummary = (words || []).map((w) => ({ t: Math.round(w.start * 100) / 100, w: w.text }));
  const result = await llm.completeVisionJSON({
    system: HOOK_VALIDATION_SYSTEM,
    user: { windowLengthSec, transcript: wordsSummary, frameTimes: framePaths.map((f) => f.t) },
    images: framePaths,
    schema: HOOK_VALIDATION_SCHEMA,
    schemaName: 'hook_validation',
  });
  if (!result) return null;

  const coldOpenValid = (
    result.use_cold_open &&
    result.hook_start_sec >= 0 && result.hook_end_sec > result.hook_start_sec &&
    (result.hook_end_sec - result.hook_start_sec) >= 1 && (result.hook_end_sec - result.hook_start_sec) <= 6 &&
    result.hook_start_sec > 3 && result.hook_end_sec <= windowLengthSec &&
    (result.hook_score - result.chronological_hook_score) >= HOOK_SWITCH_MARGIN
  );

  const reactionComposite = (result.is_reaction_composite && result.facecam_x >= 0)
    ? {
      isReactionComposite: true,
      facecamBox: {
        cx: result.facecam_x + result.facecam_w / 2,
        cy: result.facecam_y + result.facecam_h / 2,
        w: result.facecam_w,
        h: result.facecam_h,
      },
      confidence: result.facecam_confidence,
      source: 'vision-llm',
    }
    : null;

  return {
    hook: {
      useColdOpen: coldOpenValid,
      hookStart: coldOpenValid ? result.hook_start_sec : null,
      hookEnd: coldOpenValid ? result.hook_end_sec : null,
      hookScore: result.hook_score,
      chronologicalHookScore: result.chronological_hook_score,
      reason: result.hook_reason,
    },
    reactionComposite,
    renderable: result.renderable,
    rejectionReasons: result.rejection_reasons || [],
    editorialVerdict: { wouldUse: result.editorial_would_use, reason: result.editorial_reason },
  };
}

module.exports = {
  isAvailable, rankCandidatesSemantic, computeCutScore, runVisionValidation, pickHookSampleTimes,
  dedupeByOverlap, VISION_BUDGET, HOOK_FRAME_COUNT, HOOK_SWITCH_MARGIN,
};
