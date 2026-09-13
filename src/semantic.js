const llm = require('./llm');

const MAX_BOUNDARY_ADJUST_SEC = parseFloat(process.env.SEMANTIC_MAX_BOUNDARY_ADJUST_SEC || '5');
const HOOK_FRAME_COUNT = parseInt(process.env.SEMANTIC_HOOK_FRAME_COUNT || '8', 10);
const HOOK_SWITCH_MARGIN = parseFloat(process.env.HOOK_SWITCH_MARGIN || '0.15');
const VISION_BUDGET = parseInt(process.env.SEMANTIC_VISION_BUDGET || '15', 10);
const NARRATIVE_ARC_BUCKET_SEC = parseFloat(process.env.NARRATIVE_ARC_BUCKET_SEC || '8');
const NARRATIVE_ARC_MAX_INPUT_CHARS = parseInt(process.env.NARRATIVE_ARC_MAX_INPUT_CHARS || '12000', 10);
const NARRATIVE_BEAT_PROXIMITY_SEC = parseFloat(process.env.NARRATIVE_BEAT_PROXIMITY_SEC || '20');

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
    primary_emotion: { type: 'string', enum: ['neutral', 'joy', 'surprise', 'anger', 'sadness', 'fear', 'disgust'] },
    emotion_intensity: { type: 'number' },
    start_adjust_sec: { type: 'number' },
    end_adjust_sec: { type: 'number' },
    topic_summary: { type: 'string' },
    rationale: { type: 'string' },
    // Moment-signal enrichment (plan doc M1) — separate, evidence-based editorial dimensions
    // layered ON TOP of the fields above, never replacing them. Each is 0..1 and must reflect
    // only what the given transcript window actually supports — never invent an event/emotion
    // not present in the text. A quiet, well-told story can score high on payoff_strength and
    // quotability while scoring low on reaction_value; a loud moment with no real content can
    // be the reverse. These are additive signals for computeMomentSignalBonus below, not a
    // replacement for semantic_completion/reaction_value/narrative_completion above.
    hook_strength: { type: 'number' },
    humor: { type: 'number' },
    surprise: { type: 'number' },
    curiosity: { type: 'number' },
    controversy: { type: 'number' },
    quotability: { type: 'number' },
    uniqueness: { type: 'number' },
    payoff_strength: { type: 'number' },
    context_completeness: { type: 'number' },
    // Advisory only in this milestone — captured for future boundary-widening work, NOT
    // applied to the candidate's actual start/end here (that is explicitly out of scope for
    // M1; see the plan doc). Same clamp/units as start_adjust_sec/end_adjust_sec.
    setup_start_adjust_sec: { type: 'number' },
    payoff_end_adjust_sec: { type: 'number' },
    // Advisory framing hint for M3 (speaker-switch hysteresis) — 'none' when the window has
    // no strong preference; never a hard override of crop-validated framing.
    preferred_framing: { type: 'string', enum: ['speaker', 'reaction', 'group', 'wide', 'none'] },
  },
  required: [
    'semantic_completion', 'mid_sentence_penalty_start', 'mid_sentence_penalty_end',
    'mid_action_penalty', 'continuity_break_penalty', 'reaction_value', 'narrative_completion',
    'primary_emotion', 'emotion_intensity',
    'start_adjust_sec', 'end_adjust_sec', 'topic_summary', 'rationale',
    'hook_strength', 'humor', 'surprise', 'curiosity', 'controversy', 'quotability',
    'uniqueness', 'payoff_strength', 'context_completeness',
    'setup_start_adjust_sec', 'payoff_end_adjust_sec', 'preferred_framing',
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
through the window, that is good continuity regardless of anything visual.

Also classify the dominant emotion of this specific window as primary_emotion (one of:
neutral, joy, surprise, anger, sadness, fear, disgust) with emotion_intensity (0..1) for how
strongly it reads, judged from the words/tone in the transcript alone — this is independent
of reaction_value (which measures how share-worthy/reaction-driving the moment is, not its
emotional category or strength).

Additionally, score these separate editorial dimensions (each 0..1), evidence-based ONLY from
the transcript given — never manufacture an emotion, joke, or event the words don't actually
support. A quiet, well-told emotional story can and should outscore a loud moment with no real
content:
- hook_strength: how strong the opening of THIS window would be as a hook.
- humor: how funny this window reads.
- surprise: how unexpected/surprising the content is.
- curiosity: how much it makes a viewer want to keep watching to find out more.
- controversy: how likely this is to be a divisive/debated statement.
- quotability: how quotable/shareable the exact wording is on its own.
- uniqueness: how distinct this moment is from a generic/common statement.
- payoff_strength: how strong a resolution/punchline/payoff this window delivers.
- context_completeness: whether a viewer with NO other context would understand what's
  happening (low if key context is clearly missing).

Also propose setup_start_adjust_sec/payoff_end_adjust_sec (same units/sign convention as
start_adjust_sec/end_adjust_sec, seconds) ONLY if you can see clear evidence that meaningful
setup context sits just before the window or a payoff/punchline sits just after it — these are
advisory hints, not settled boundary changes, so 0 is the right answer when you don't have
clear evidence either way.

Finally, give preferred_framing: 'speaker' if the current speaker should stay framed,
'reaction' if another person's reaction is clearly more interesting than the speaker here,
'group' if wide/group framing matters more than any one person, or 'none' if you have no
strong preference (never guess — 'none' is the safe default: this is an advisory hint for
framing, not a command, and it can never override the app's crop-safety validation).`;

const CUT_SCORE_WEIGHTS = {
  audio: parseFloat(process.env.CUT_SCORE_WEIGHT_AUDIO || '0.35'),
  completion: parseFloat(process.env.CUT_SCORE_WEIGHT_COMPLETION || '0.18'),
  narrative: parseFloat(process.env.CUT_SCORE_WEIGHT_NARRATIVE || '0.15'),
  reaction: parseFloat(process.env.CUT_SCORE_WEIGHT_REACTION || '0.10'),
  midStart: parseFloat(process.env.CUT_SCORE_WEIGHT_MID_START || '0.12'),
  midEnd: parseFloat(process.env.CUT_SCORE_WEIGHT_MID_END || '0.12'),
  midAction: parseFloat(process.env.CUT_SCORE_WEIGHT_MID_ACTION || '0.06'),
  continuity: parseFloat(process.env.CUT_SCORE_WEIGHT_CONTINUITY || '0.08'),
  // Additive signals layered on top of the original 8 weights above — never a replacement
  // for them. audioSplit+visualSplit together replace what the single `audio` weight would
  // have contributed for a candidate that has BOTH an audio and visual score (see
  // computeCutScore below); for a single-source candidate `audio` alone still applies
  // unchanged.
  audioSplit: parseFloat(process.env.CUT_SCORE_WEIGHT_AUDIO_SPLIT || '0.20'),
  visualSplit: parseFloat(process.env.CUT_SCORE_WEIGHT_VISUAL_SPLIT || '0.15'),
  emotionIntensity: parseFloat(process.env.CUT_SCORE_WEIGHT_EMOTION_INTENSITY || '0.05'),
  narrativeBeat: parseFloat(process.env.CUT_SCORE_WEIGHT_NARRATIVE_BEAT || '0.06'),
  // Plan doc M1 — one new bounded, weighted, capped term folding in the richer moment
  // signals above. Deliberately small relative to the original 8 weights: a nudge among
  // already-plausible candidates, not a re-ranking engine (same philosophy as narrativeBeat).
  momentSignals: parseFloat(process.env.CUT_SCORE_WEIGHT_MOMENT_SIGNALS || '0.08'),
};

// Sub-weights for computeMomentSignalBonus below — sum to 1.0 so a candidate with every
// dimension maxed out produces a bonus of exactly CUT_SCORE_WEIGHTS.momentSignals, never more.
const MOMENT_SIGNAL_SUBWEIGHTS = {
  hook_strength: 0.20,
  payoff_strength: 0.15,
  surprise: 0.15,
  quotability: 0.10,
  uniqueness: 0.10,
  curiosity: 0.10,
  humor: 0.10,
  controversy: 0.05,
  context_completeness: 0.05,
};

// Pure, bounded blend of the M1 moment signals into a single 0..1 bonus. Missing/partial
// fields simply contribute 0 (never throws, never treats "missing" as "bad") — this is what
// lets M2's quality floor stay safe against partial LLM output, and what makes this whole
// milestone a strict zero-cost no-op when momentSignals is absent: computeCutScore only ever
// adds `weight * this`, and this is 0 for a null/undefined input.
function computeMomentSignalBonus(momentSignals) {
  if (!momentSignals) return 0;
  let sum = 0;
  for (const [key, weight] of Object.entries(MOMENT_SIGNAL_SUBWEIGHTS)) {
    const v = momentSignals[key];
    if (typeof v === 'number' && Number.isFinite(v)) sum += Math.max(0, Math.min(1, v)) * weight;
  }
  return sum;
}

// Blends pass-1's audio/visual score with the semantic completion signals. Falls back to
// the plain normalized score when no semantic signal exists (LLM unavailable/failed) —
// this is the "identity passthrough" no-op path, untouched by anything below.
//
// `extras.source` ({kind, audioNorm, visualNorm}): when the candidate has BOTH an
// independently-normalized audio and visual score (kind==='both'), splits the single
// `audio` weight into two — un-collapsing signal that candidates.js already computes
// (audioScore/visualScore) but was previously discarded behind one merged `score`. A
// single-source candidate (the common case) gets the exact original `w.audio *
// normalizedScore` term, unchanged.
// `extras.narrativeBonus` (0..1): proximity to a whole-video narrative beat (see
// analyzeNarrativeArc/narrativeProximityBonus below). `extras.momentSignalBonus` (0..1, plan
// doc M1): see computeMomentSignalBonus above. All extras default to absent, in which case
// this function is byte-identical to its pre-existing behavior.
function computeCutScore(normalizedScore, semantic, extras = {}) {
  if (!semantic) return normalizedScore;
  const w = CUT_SCORE_WEIGHTS;
  const { source, narrativeBonus, momentSignalBonus } = extras;
  const sourceTerm = (source?.kind === 'both' && source.audioNorm != null && source.visualNorm != null)
    ? w.audioSplit * source.audioNorm + w.visualSplit * source.visualNorm
    : w.audio * normalizedScore;
  return (
    sourceTerm +
    w.completion * semantic.semantic_completion +
    w.narrative * semantic.narrative_completion +
    w.reaction * semantic.reaction_value +
    w.emotionIntensity * (semantic.emotion_intensity || 0) +
    w.narrativeBeat * (narrativeBonus || 0) +
    w.momentSignals * (momentSignalBonus || 0) -
    w.midStart * semantic.mid_sentence_penalty_start -
    w.midEnd * semantic.mid_sentence_penalty_end -
    w.midAction * semantic.mid_action_penalty -
    w.continuity * semantic.continuity_break_penalty
  );
}

// Linear decay from 1 (a candidate's midpoint sits exactly on a beat) to 0 at
// NARRATIVE_BEAT_PROXIMITY_SEC or farther away. Uses only the single closest beat — being
// near several beats isn't "more" narratively significant than being near the closest one.
function narrativeProximityBonus(candidate, beats) {
  if (!beats || !beats.length) return 0;
  const mid = (candidate.start + candidate.end) / 2;
  let best = Infinity;
  for (const b of beats) {
    const d = Math.abs(mid - b.approxTimeSec);
    if (d < best) best = d;
  }
  if (!Number.isFinite(best)) return 0;
  return Math.max(0, 1 - best / NARRATIVE_BEAT_PROXIMITY_SEC);
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
async function rankCandidatesSemantic(candidates, words, { narrativeBeats = [], mapLimit = defaultMapLimit, concurrency = 4 } = {}) {
  if (!candidates.length) return candidates;

  if (!isAvailable()) {
    candidates.forEach((c) => { c.cutScore = c.score; });
    return [...candidates].sort((a, b) => b.cutScore - a.cutScore);
  }

  const scores = candidates.map((c) => c.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const range = maxScore - minScore || 1;

  // Per-source (audio-scale vs visual-scale numbers aren't directly comparable) min-max
  // normalization, mirroring candidates.js:selectCandidatesForSemanticPass's own per-source
  // relevance calc — feeds computeCutScore's audioSplit/visualSplit terms (Component 1).
  const audioVals = candidates.map((c) => c.audioScore).filter((v) => v != null);
  const minAudio = audioVals.length ? Math.min(...audioVals) : 0;
  const audioRange = (audioVals.length ? Math.max(...audioVals) : 0) - minAudio || 1;
  const visualVals = candidates.map((c) => c.visualScore).filter((v) => v != null);
  const minVisual = visualVals.length ? Math.min(...visualVals) : 0;
  const visualRange = (visualVals.length ? Math.max(...visualVals) : 0) - minVisual || 1;

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
      primary_emotion: result.primary_emotion,
      emotion_intensity: result.emotion_intensity,
      topic_summary: result.topic_summary,
      rationale: result.rationale,
      start_adjust_sec: startAdjust,
      end_adjust_sec: endAdjust,
    };

    // Plan doc M1 — stored separately from semanticEvent (which feeds the ORIGINAL 8-weight
    // formula unchanged) so this stays a clearly-scoped additive layer. Every field here is
    // possibly absent/partial by contract (computeMomentSignalBonus treats missing as 0, never
    // as a penalty) — any future consumer (M2 diversity categories, M3 preferredFraming, M4
    // reaction relevance) must uphold that same contract.
    candidate.momentSignals = {
      hook_strength: result.hook_strength,
      humor: result.humor,
      surprise: result.surprise,
      curiosity: result.curiosity,
      controversy: result.controversy,
      quotability: result.quotability,
      uniqueness: result.uniqueness,
      payoff_strength: result.payoff_strength,
      context_completeness: result.context_completeness,
      setup_start_adjust_sec: result.setup_start_adjust_sec,
      payoff_end_adjust_sec: result.payoff_end_adjust_sec,
      preferred_framing: result.preferred_framing && result.preferred_framing !== 'none' ? result.preferred_framing : null,
    };

    const source = {
      kind: candidate.source,
      audioNorm: candidate.audioScore != null ? (candidate.audioScore - minAudio) / audioRange : null,
      visualNorm: candidate.visualScore != null ? (candidate.visualScore - minVisual) / visualRange : null,
    };
    const narrativeBonus = narrativeProximityBonus(candidate, narrativeBeats);
    const momentSignalBonus = computeMomentSignalBonus(candidate.momentSignals);

    candidate.cutScore = computeCutScore(normalizedScore, candidate.semanticEvent, { source, narrativeBonus, momentSignalBonus });
    console.log(`[stage=semantic] candidate start=${candidate.start.toFixed(1)} cutScore=${candidate.cutScore.toFixed(3)} topic="${result.topic_summary}" emotion=${result.primary_emotion}/${(result.emotion_intensity ?? 0).toFixed(2)} adjust=[${startAdjust.toFixed(1)},${endAdjust.toFixed(1)}]`);
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
    emotional_importance: { type: 'number' },
  },
  required: [
    'chronological_hook_score', 'use_cold_open', 'hook_start_sec', 'hook_end_sec', 'hook_score', 'hook_reason',
    'is_reaction_composite', 'facecam_x', 'facecam_y', 'facecam_w', 'facecam_h', 'facecam_confidence',
    'renderable', 'rejection_reasons', 'editorial_would_use', 'editorial_reason', 'emotional_importance',
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

2. REACTION COMPOSITE: determine whether this single video frame shows a person reacting
   to separate content sharing the SAME frame with them, in EITHER of two arrangements:
   (a) a small facecam overlay, usually in a fixed corner/edge position, on top of content
   like gameplay/video/screen recording; or (b) a genuine side-by-side split where the
   reactor occupies roughly half the frame (left/right or top/bottom) next to separate
   content occupying the other half. Both count as is_reaction_composite=true. Give the
   REACTOR's own bounding box (not the content's) as fractions of frame width/height,
   TOP-LEFT origin (facecam_x, facecam_y, facecam_w, facecam_h, each 0..1) — for a
   side-by-side split this box should span roughly the reactor's whole half of the frame,
   not just their face — and a confidence (0..1). If neither arrangement applies (e.g. the
   reactor's own single camera fills the whole frame, or there is no reactor at all), set
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
   exact moment and framing — with a one-line editorial_reason.

4. EMOTIONAL IMPORTANCE: separately from the hook/renderability judgments above, rate how
   emotionally significant this moment looks VISUALLY (not just from the transcript) as
   emotional_importance (0..1) — a genuine emotional peak (a strong reaction, a meaningful
   group moment, visible tension/joy/surprise) scores higher than a visually flat or
   administrative moment, independent of whether it makes a good hook.`;

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
    emotionalImportance: typeof result.emotional_importance === 'number' ? result.emotional_importance : null,
    renderable: result.renderable,
    rejectionReasons: result.rejection_reasons || [],
    editorialVerdict: { wouldUse: result.editorial_would_use, reason: result.editorial_reason },
  };
}

const NARRATIVE_ARC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    beats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approxTimeSec: { type: 'number' },
          kind: { type: 'string', enum: ['setup', 'buildup', 'turn', 'payoff', 'callback', 'other'] },
          description: { type: 'string' },
        },
        required: ['approxTimeSec', 'kind', 'description'],
      },
    },
    // Plan doc M1 — additive enrichment of the SAME whole-video call, not a new pass.
    // Both default to empty arrays when nothing genuinely stands out; never forced.
    recurringTopics: { type: 'array', items: { type: 'string' } },
    weakSections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approxTimeSec: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['approxTimeSec', 'reason'],
      },
    },
  },
  required: ['summary', 'beats', 'recurringTopics', 'weakSections'],
};

const NARRATIVE_ARC_SYSTEM = `You read the FULL word-timed transcript of a longer video (bucketed into short time
windows, "t" in seconds, "text" the words spoken in that window) and identify its narrative
arc — how it develops as ONE continuous piece over time, not isolated moments.

Give a short summary (1-3 sentences) of the overall arc, then list at most 12 of the most
significant narrative beats as {approxTimeSec, kind, description}: setup (establishes
context/stakes), buildup (tension/anticipation increasing), turn (a pivot/twist/reveal),
payoff (a resolution/punchline/climax), callback (references an earlier beat), or other.
Only include beats that are genuinely significant to the video's own story — do not force
one of every kind, and do not list more beats than the video actually has distinct moments
for. approxTimeSec should be your best estimate of where in the video (in seconds from the
start) that beat happens, based on the bucket times given.

Also list recurringTopics: short phrases naming people/topics that come up repeatedly across
the video (empty array if nothing genuinely recurs — do not force entries), and weakSections:
{approxTimeSec, reason} for stretches that are repetitive, low-value, or filler relative to
the rest of the video (empty array if the video doesn't have any — do not manufacture weak
sections just to fill the list).`;

// Builds a compact [{t, text}] transcript (one entry per ~NARRATIVE_ARC_BUCKET_SEC-second
// bucket, not one per word) so a whole-video narrative pass stays cheap even for a long
// source video.
function bucketTranscript(words, bucketSec) {
  if (!words || !words.length) return [];
  const buckets = new Map();
  for (const w of words) {
    const key = Math.floor(w.start / bucketSec) * bucketSec;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(w.text);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, texts]) => ({ t, text: texts.join(' ') }));
}

// Evenly downsamples (not head-truncates) buckets to fit a char budget, so a long video's
// narrative pass isn't just "the first N minutes" — every part of the video keeps some
// representation.
function downsampleToCharBudget(buckets, maxChars) {
  const totalChars = buckets.reduce((sum, b) => sum + b.text.length, 0);
  if (totalChars <= maxChars || buckets.length <= 1) return buckets;
  const keepFrac = maxChars / totalChars;
  const stride = Math.max(1, Math.round(1 / keepFrac));
  return buckets.filter((_, i) => i % stride === 0);
}

// ONE call per video (not per-candidate) — ordinary "null means no signal" contract, same
// as every other function in this file: callers must pass an empty beats array onward when
// this returns null (LLM unavailable/failed/disabled/no transcript).
async function analyzeNarrativeArc(words, totalDurationSec) {
  if (process.env.SEMANTIC_NARRATIVE_DISABLE === '1') return null;
  if (!isAvailable() || !words || !words.length) return null;

  const buckets = downsampleToCharBudget(
    bucketTranscript(words, NARRATIVE_ARC_BUCKET_SEC),
    NARRATIVE_ARC_MAX_INPUT_CHARS
  );
  if (!buckets.length) return null;

  const result = await llm.completeJSON({
    system: NARRATIVE_ARC_SYSTEM,
    user: { totalDurationSec, transcript: buckets },
    schema: NARRATIVE_ARC_SCHEMA,
    schemaName: 'narrative_arc',
    maxTokens: 1200,
  });
  if (!result) return null;

  const beats = (Array.isArray(result.beats) ? result.beats : [])
    .filter((b) => b && typeof b.approxTimeSec === 'number' && b.approxTimeSec >= 0 && (!totalDurationSec || b.approxTimeSec <= totalDurationSec));
  const recurringTopics = Array.isArray(result.recurringTopics) ? result.recurringTopics.filter((t) => typeof t === 'string' && t.trim()) : [];
  const weakSections = (Array.isArray(result.weakSections) ? result.weakSections : [])
    .filter((s) => s && typeof s.approxTimeSec === 'number' && s.approxTimeSec >= 0 && (!totalDurationSec || s.approxTimeSec <= totalDurationSec));
  console.log(`[stage=narrative] beats=${beats.length} recurringTopics=${recurringTopics.length} weakSections=${weakSections.length} summary="${result.summary}"`);
  return { summary: result.summary, beats, recurringTopics, weakSections };
}

module.exports = {
  isAvailable, rankCandidatesSemantic, computeCutScore, runVisionValidation, pickHookSampleTimes,
  dedupeByOverlap, VISION_BUDGET, HOOK_FRAME_COUNT, HOOK_SWITCH_MARGIN,
  analyzeNarrativeArc, narrativeProximityBonus, CUT_SCORE_WEIGHTS,
  CUT_QUALITY_SCHEMA, HOOK_VALIDATION_SCHEMA, NARRATIVE_ARC_SCHEMA,
  computeMomentSignalBonus, MOMENT_SIGNAL_SUBWEIGHTS,
};
