// Tests for plan doc M9 (Editorial Shot Quality / Dead-Frame Rejection): tiered quality
// scoring, hold-vs-switch hysteresis with a hard dead-frame safety gate ordered before
// speaker handoff, sustained speaker-handoff confirmation, keyframe edge/movement filtering,
// and protective-wide vs. tight framing. All deterministic — fixture-driven, no video/LLM.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySlotTier, scoreSlotQuality, scoreLayoutQuality, isConfidentlyActiveSpeaker,
  candidateLooksLikeSpeakerHandoff, nextSpeakerHandoffState, decideShotTransition,
  candidateLooksLikeGenuineGroupScene, nextGroupSceneState,
  computeRunPositionVariance, maybeTightenStableShot, buildLayoutSegments,
  finalizeLayoutWithCropValidation,
} = require('../src/effects');

const SRC_W = 1920, SRC_H = 1080, OUT_W = 1080, OUT_H = 1920;

function goodSlot(cx = 0.5, overrides = {}) {
  return { cx, cy: 0.42, w: 0.15, h: 0.2, landmarkBox: null, speakingScore: null, speakingConfidence: 0, ...overrides };
}
function activeSpeakerSlot(cx = 0.5, overrides = {}) {
  return goodSlot(cx, { speakingScore: 0.9, speakingConfidence: 0.9, ...overrides });
}
function tinySlot(cx = 0.5) {
  return { cx, cy: 0.42, w: 0.05, h: 0.05, landmarkBox: null, speakingScore: null, speakingConfidence: 0 };
}
function edgeSlot() {
  return { cx: 0.05, cy: 0.42, w: 0.15, h: 0.2, landmarkBox: null, speakingScore: null, speakingConfidence: 0 };
}

// --- Tier classification & scoring ---

test('classifySlotTier: good-sized, safely-inside slot -> good-speaker', () => {
  assert.equal(classifySlotTier(goodSlot()), 'good-speaker');
});

test('classifySlotTier: tiny face -> weak-edge-tiny', () => {
  assert.equal(classifySlotTier(tinySlot()), 'weak-edge-tiny');
});

test('classifySlotTier: edge-hugging position -> weak-edge-tiny', () => {
  assert.equal(classifySlotTier(edgeSlot()), 'weak-edge-tiny');
});

test('classifySlotTier: no size data at all -> weak-edge-tiny, never "good" by default', () => {
  assert.equal(classifySlotTier({ cx: 0.5, cy: 0.42 }), 'weak-edge-tiny');
});

test('classifySlotTier: no slot at all -> dead-empty', () => {
  assert.equal(classifySlotTier(null), 'dead-empty');
});

// --- scoreLayoutQuality: structural tier separation ---

test('scoreLayoutQuality: fit with faceCount=0 scores in the dead-empty band', () => {
  const q = scoreLayoutQuality({ type: 'fit' }, { faceCount: 0 });
  assert.ok(q <= 0.05);
});

test('scoreLayoutQuality: fit WITH a face detected scores fallback-wide, still clearly below good-speaker', () => {
  const q = scoreLayoutQuality({ type: 'fit' }, { faceCount: 1 });
  assert.ok(q > 0.05 && q <= 0.30);
});

test('scoreLayoutQuality: a good single-speaker slot scores well above fallback-wide, even with max bonuses', () => {
  const q = scoreLayoutQuality({ type: 'single', slot: activeSpeakerSlot(0.5, { landmarkBox: {} }) }, { faceCount: 1 });
  assert.ok(q >= 0.75);
});

test('scoreLayoutQuality: weak/tiny/edge slot CANNOT reach good-speaker territory even with every bonus stacked', () => {
  const maxedWeak = activeSpeakerSlot(0.05, { w: 0.01, h: 0.01, landmarkBox: {} }); // edge AND tiny AND active-speaker AND fresh landmark
  const q = scoreLayoutQuality({ type: 'single', slot: maxedWeak }, { faceCount: 1 });
  assert.ok(q < 0.75, `weak-tier shot must never cross into good-speaker range, got ${q}`);
});

test('scoreLayoutQuality: fallback-wide (fit-with-face) can never beat a good speaker shot regardless of anything else', () => {
  const fitWithFace = scoreLayoutQuality({ type: 'fit' }, { faceCount: 3 });
  const goodSpeaker = scoreLayoutQuality({ type: 'single', slot: goodSlot() }, { faceCount: 1 });
  assert.ok(fitWithFace < goodSpeaker);
});

test('scoreLayoutQuality: split layout is only as good as its WEAKER half', () => {
  const q = scoreLayoutQuality({ type: 'split', slots: [goodSlot(0.25), tinySlot(0.75)] }, { faceCount: 2 });
  assert.ok(q < TierGoodFloor());
  function TierGoodFloor() { return scoreLayoutQuality({ type: 'single', slot: goodSlot() }, { faceCount: 1 }) - 0.01; }
});

// --- isConfidentlyActiveSpeaker ---

test('isConfidentlyActiveSpeaker: null/low-confidence speakingScore is never confident', () => {
  assert.equal(isConfidentlyActiveSpeaker(null), false);
  assert.equal(isConfidentlyActiveSpeaker({ speakingScore: 0.9, speakingConfidence: 0.1 }), false);
  assert.equal(isConfidentlyActiveSpeaker({ speakingScore: 0.1, speakingConfidence: 0.9 }), false);
});

test('isConfidentlyActiveSpeaker: high score + high confidence -> true', () => {
  assert.equal(isConfidentlyActiveSpeaker({ speakingScore: 0.9, speakingConfidence: 0.9 }), true);
});

// --- decideShotTransition: gate ordering + hold/switch rules ---

function run(layout, quality, start = 0) {
  return { layout, quality, start };
}
function chunk(layout, start) {
  return { layout, start };
}
const noHandoff = { streak: 0, confirmed: false };
const confirmedHandoff = { streak: 3, confirmed: true };

// 1. Empty/background candidate loses to a valid speaker candidate.
test('decideShotTransition: dead/empty candidate never replaces a valid current shot', () => {
  const currentRun = run({ type: 'single', slot: goodSlot() }, scoreLayoutQuality({ type: 'single', slot: goodSlot() }, {}), 0);
  const decision = decideShotTransition(currentRun, chunk({ type: 'fit' }, 5), { faceCount: 0 }, noHandoff);
  assert.equal(decision.switch, false);
  assert.equal(decision.reason, 'reject-dead-frame');
});

// 2. Speaker-visible candidate beats a visually-different-but-empty frame (same as above,
// from the other direction: an empty current shot MUST accept a good candidate).
test('decideShotTransition: a good speaker candidate replaces a currently-dead/empty shot', () => {
  const currentRun = run({ type: 'fit' }, scoreLayoutQuality({ type: 'fit' }, { faceCount: 0 }), 0);
  const decision = decideShotTransition(currentRun, chunk({ type: 'single', slot: goodSlot() }, 5), { faceCount: 1 }, noHandoff);
  assert.equal(decision.switch, true);
});

// 3. A slightly-better candidate does NOT replace a good current shot before MIN_SHOT_HOLD_SEC.
test('decideShotTransition: a slightly-better candidate is held before the minimum hold time', () => {
  const currentRun = run({ type: 'single', slot: goodSlot(0.5) }, 0.75, 0);
  const slightlyBetter = { type: 'single', slot: activeSpeakerSlot(0.7, { landmarkBox: {} }) }; // small bonus bump
  const decision = decideShotTransition(currentRun, chunk(slightlyBetter, 1.0), { faceCount: 1 }, noHandoff);
  assert.equal(decision.switch, false);
  assert.equal(decision.reason, 'min-hold');
});

// 4. A strongly-better candidate CAN replace the current shot immediately.
test('decideShotTransition: a strongly-better candidate overrides the hold timer', () => {
  const currentRun = run({ type: 'fit' }, scoreLayoutQuality({ type: 'fit' }, { faceCount: 1 }), 0); // fallback-wide (0.30)
  const decision = decideShotTransition(currentRun, chunk({ type: 'single', slot: goodSlot() }, 0.2), { faceCount: 1 }, noHandoff);
  assert.equal(decision.switch, true);
  assert.equal(decision.reason, 'strong-upgrade');
});

// 5. Same-speaker continuity preferred when candidates are otherwise similar (no switch).
test('decideShotTransition: a candidate with no material quality difference does not switch, even after hold time', () => {
  const currentRun = run({ type: 'single', slot: goodSlot(0.5) }, 0.75, 0);
  const barelyDifferent = { type: 'single', slot: goodSlot(0.5) };
  const decision = decideShotTransition(currentRun, chunk(barelyDifferent, 10), { faceCount: 1 }, noHandoff);
  assert.equal(decision.switch, false);
  assert.equal(decision.reason, 'not-materially-better');
});

// 6. A confirmed, well-composed active speaker triggers a handoff switch.
test('decideShotTransition: a confirmed handoff to a well-composed speaker switches even with a small quality margin', () => {
  const currentRun = run({ type: 'single', slot: goodSlot(0.3) }, 0.75, 0);
  const newSpeaker = { type: 'single', slot: activeSpeakerSlot(0.7) };
  const decision = decideShotTransition(currentRun, chunk(newSpeaker, 0.5), { faceCount: 1 }, confirmedHandoff);
  assert.equal(decision.switch, true);
  assert.equal(decision.reason, 'speaker-handoff');
});

// 11. A single noisy speakingScore spike (1 chunk) does NOT trigger a handoff.
test('nextSpeakerHandoffState: a single chunk never confirms a handoff', () => {
  const state = nextSpeakerHandoffState({ streak: 0, confirmed: false }, true);
  assert.equal(state.confirmed, false);
  assert.equal(state.streak, 1);
});

test('nextSpeakerHandoffState: confirms only after SPEAKER_HANDOFF_CONFIRM_CHUNKS consecutive agreeing chunks', () => {
  let state = { streak: 0, confirmed: false };
  state = nextSpeakerHandoffState(state, true);
  assert.equal(state.confirmed, false);
  state = nextSpeakerHandoffState(state, true);
  assert.equal(state.confirmed, true);
});

test('nextSpeakerHandoffState: a non-handoff chunk resets the streak', () => {
  let state = nextSpeakerHandoffState({ streak: 1, confirmed: false }, false);
  assert.equal(state.streak, 0);
  assert.equal(state.confirmed, false);
});

// 12. A confirmed handoff to a candidate BELOW SPEAKER_HANDOFF_MIN_QUALITY does NOT switch.
test('decideShotTransition: a confirmed handoff to a poorly-composed candidate does not switch on identity alone', () => {
  const currentRun = run({ type: 'single', slot: goodSlot(0.3) }, 0.75, 0);
  const poorlyFramedSpeaker = { type: 'single', slot: activeSpeakerSlot(0.05, { w: 0.02, h: 0.02 }) }; // edge + tiny
  const decision = decideShotTransition(currentRun, chunk(poorlyFramedSpeaker, 0.5), { faceCount: 1 }, confirmedHandoff);
  assert.notEqual(decision.reason, 'speaker-handoff');
  // With no elapsed hold time, it falls through to min-hold (still held).
  assert.equal(decision.switch, false);
});

// 13. The hard dead-frame safety gate wins even when a speaker handoff is simultaneously confirmed.
test('decideShotTransition: dead-frame safety gate wins over a confirmed speaker handoff (gate ordering)', () => {
  const currentRun = run({ type: 'single', slot: goodSlot() }, scoreLayoutQuality({ type: 'single', slot: goodSlot() }, {}), 0);
  // Candidate scores below the dead-frame threshold (fit, faceCount=0) even though a
  // handoff is confirmed — this must never be allowed through.
  const decision = decideShotTransition(currentRun, chunk({ type: 'fit' }, 10), { faceCount: 0 }, confirmedHandoff);
  assert.equal(decision.switch, false);
  assert.equal(decision.reason, 'reject-dead-frame');
});

// --- candidateLooksLikeSpeakerHandoff ---

test('candidateLooksLikeSpeakerHandoff: false when candidate is not a confident active speaker', () => {
  assert.equal(candidateLooksLikeSpeakerHandoff({ type: 'single', slot: goodSlot() }, { type: 'single', slot: goodSlot(0.7) }), false);
});

test('candidateLooksLikeSpeakerHandoff: true when candidate is a confident speaker and current is not', () => {
  assert.equal(candidateLooksLikeSpeakerHandoff({ type: 'single', slot: goodSlot(0.3) }, { type: 'single', slot: activeSpeakerSlot(0.7) }), true);
});

test('candidateLooksLikeSpeakerHandoff: false when both are confident speakers at nearly the same position (same person, noise)', () => {
  assert.equal(candidateLooksLikeSpeakerHandoff({ type: 'single', slot: activeSpeakerSlot(0.5) }, { type: 'single', slot: activeSpeakerSlot(0.52) }), false);
});

// --- 'group-wide' tier & sustained group-scene-change gate ---
// Found via real-video validation (not one of the originally-specced scenarios): a real
// 3-person panel/group scene was being scored identically to a single-face "gave up"
// fallback (both flat 'fallback-wide'), so it could never win against a held good-speaker
// shot no matter how long it genuinely persisted in the source. Fixed by giving a genuine
// multi-person 'fit' its own tier, plus a sustained (never single-blip) confirmation gate.

test('scoreLayoutQuality: a genuine 3+ person fit scores as group-wide, above fallback-wide but below good-speaker', () => {
  const fallback = scoreLayoutQuality({ type: 'fit' }, { faceCount: 1 });
  const group = scoreLayoutQuality({ type: 'fit' }, { faceCount: 3 });
  const goodSpeaker = scoreLayoutQuality({ type: 'single', slot: goodSlot() }, { faceCount: 1 });
  assert.ok(group > fallback, `group-wide (${group}) must score above fallback-wide (${fallback})`);
  assert.ok(group < goodSpeaker, `group-wide (${group}) must still score below good-speaker (${goodSpeaker})`);
});

test('candidateLooksLikeGenuineGroupScene: true only for a fit layout with 3+ detected faces', () => {
  assert.equal(candidateLooksLikeGenuineGroupScene({ type: 'fit' }, { faceCount: 3 }), true);
  assert.equal(candidateLooksLikeGenuineGroupScene({ type: 'fit' }, { faceCount: 1 }), false);
  assert.equal(candidateLooksLikeGenuineGroupScene({ type: 'fit' }, { faceCount: 0 }), false);
  assert.equal(candidateLooksLikeGenuineGroupScene({ type: 'single', slot: goodSlot() }, { faceCount: 3 }), false);
});

test('nextGroupSceneState: a single group-scene-looking chunk never confirms; a non-matching chunk resets the streak', () => {
  let state = { streak: 0, confirmed: false };
  state = nextGroupSceneState(state, true);
  assert.equal(state.confirmed, false);
  state = nextGroupSceneState(state, false);
  assert.equal(state.streak, 0);
});

test('decideShotTransition: an unconfirmed (single-blip) group scene does not override the hold', () => {
  const goodQuality = scoreLayoutQuality({ type: 'single', slot: goodSlot() }, {});
  const currentRun = run({ type: 'single', slot: goodSlot() }, goodQuality, 0);
  const decision = decideShotTransition(
    currentRun, chunk({ type: 'fit' }, 30), { faceCount: 3 }, noHandoff, { streak: 1, confirmed: false }
  );
  assert.equal(decision.switch, false);
});

test('decideShotTransition: a CONFIRMED sustained group scene overrides the hold, even against a held good-speaker shot', () => {
  const goodQuality = scoreLayoutQuality({ type: 'single', slot: goodSlot() }, {});
  const currentRun = run({ type: 'single', slot: goodSlot() }, goodQuality, 0);
  const decision = decideShotTransition(
    currentRun, chunk({ type: 'fit' }, 30), { faceCount: 3 }, noHandoff, { streak: 2, confirmed: true }
  );
  assert.equal(decision.switch, true);
  assert.equal(decision.reason, 'group-scene-change');
});

test('decideShotTransition: the hard dead-frame safety gate still wins over a confirmed group-scene change', () => {
  const goodQuality = scoreLayoutQuality({ type: 'single', slot: goodSlot() }, {});
  const currentRun = run({ type: 'single', slot: goodSlot() }, goodQuality, 0);
  // Confirmed group-scene state, but the candidate itself is actually empty (faceCount=0) —
  // candidateLooksLikeGenuineGroupScene would never set this in practice, but the gate must
  // still hold even if it somehow did, since gate (1) is evaluated first.
  const decision = decideShotTransition(
    currentRun, chunk({ type: 'fit' }, 30), { faceCount: 0 }, noHandoff, { streak: 2, confirmed: true }
  );
  assert.equal(decision.switch, false);
  assert.equal(decision.reason, 'reject-dead-frame');
});

test('buildLayoutSegments: a sustained real 3-person scene eventually overrides a held single-speaker run', () => {
  const singleChunk = (start, end, cx) => ({ start, end, people: { faceCount: 1, slots: [{ cx, cy: 0.42, w: 0.15, h: 0.2, landmarkBox: null, speakingScore: null, speakingConfidence: 0 }], expressiveMoments: [] } });
  const groupChunk = (start, end) => ({ start, end, people: { faceCount: 3, slots: [0.2, 0.5, 0.8].map((cx) => ({ cx, cy: 0.42, w: 0.1, h: 0.15, landmarkBox: null, speakingScore: null, speakingConfidence: 0 })), expressiveMoments: [] } });
  const layoutTimeline = [
    singleChunk(0, 6, 0.5), singleChunk(6, 12, 0.5),
    groupChunk(12, 18), groupChunk(18, 24), groupChunk(24, 30), // sustained, not a single blip
  ];
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, null, OUT_W, OUT_H);
  const lastRun = merged[merged.length - 1];
  assert.equal(lastRun.layout.type, 'fit', 'a sustained real group scene must eventually win, not be held forever');
});

test('buildLayoutSegments: a single stray 3-person chunk amid a single-speaker run is held, not switched to', () => {
  const singleChunk = (start, end, cx) => ({ start, end, people: { faceCount: 1, slots: [{ cx, cy: 0.42, w: 0.15, h: 0.2, landmarkBox: null, speakingScore: null, speakingConfidence: 0 }], expressiveMoments: [] } });
  const groupChunk = (start, end) => ({ start, end, people: { faceCount: 3, slots: [0.2, 0.5, 0.8].map((cx) => ({ cx, cy: 0.42, w: 0.1, h: 0.15, landmarkBox: null, speakingScore: null, speakingConfidence: 0 })), expressiveMoments: [] } });
  const layoutTimeline = [
    singleChunk(0, 6, 0.5), singleChunk(6, 12, 0.5),
    groupChunk(12, 18), // exactly one stray group chunk
    singleChunk(18, 24, 0.5), singleChunk(24, 30, 0.5),
  ];
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, null, OUT_W, OUT_H);
  for (const m of merged) {
    assert.notEqual(m.layout.type, 'fit', 'a single noisy group-shaped chunk must never win a switch');
  }
});

// --- Keyframe edge rejection & movement filtering (via buildLayoutSegments integration) ---

function chunkAt(start, end, cx, landmarkBox = null) {
  return { start, end, people: { faceCount: 1, slots: [{ cx, cy: 0.42, w: 0.15, h: 0.2, landmarkBox }], expressiveMoments: [] } };
}

// Unlike chunkAt (raw layoutTimeline shape, consumed by buildLayoutSegments' own mapping
// step), computeRunPositionVariance/maybeTightenStableShot operate on MERGED-run chunks,
// which already carry a finalized `.layout` (the shape buildLayoutSegments' raw-mapping
// produces internally) rather than raw `.people`.
function mergedChunk(start, end, cx) {
  return { start, end, layout: { type: 'single', slot: { cx, cy: 0.42, w: 0.15, h: 0.2, landmarkBox: null } } };
}

// 7. Invalid/off-edge crop is rejected (keyframe edge re-check falls back to static).
test('buildLayoutSegments: a run whose positions drift into the edge-danger zone does not get animated keyframes', () => {
  const layoutTimeline = [chunkAt(0, 6, 0.5), chunkAt(6, 12, 0.06)]; // second position is edge-hugging
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, null, OUT_W, OUT_H);
  // Either merged into one run without keyframes, or the edge candidate was held/rejected —
  // either way, no animated pan into an edge-danger position should ever be produced.
  for (const m of merged) {
    if (m.layout.keyframes) {
      for (const kf of m.layout.keyframes) {
        const edgeDist = Math.min(kf.cx, 1 - kf.cx);
        assert.ok(edgeDist >= 0.12, `keyframe at cx=${kf.cx} is in the edge-danger zone`);
      }
    }
  }
});

// 8. A valid crop remains unchanged (no new keyframe) when movement is below MIN_KEYFRAME_MOVEMENT.
test('buildLayoutSegments: near-identical positions across chunks collapse to a static (non-animated) crop', () => {
  const layoutTimeline = [chunkAt(0, 6, 0.50), chunkAt(6, 12, 0.505), chunkAt(12, 18, 0.502)]; // sub-1% drift throughout
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, null, OUT_W, OUT_H);
  for (const m of merged) {
    assert.ok(!m.layout.keyframes || m.layout.keyframes.length < 2, 'negligible movement must not produce an animated pan');
  }
});

// 9. Opening-coherence proxy: a noisy blip-to-empty chunk between two good same-position
// chunks does not produce a visible extra segment (it gets held, not switched-to).
test('buildLayoutSegments: a single noisy empty-frame blip between two good chunks does not fragment into 3 segments', () => {
  const layoutTimeline = [
    chunkAt(0, 6, 0.5),
    { start: 6, end: 8, people: { faceCount: 0, slots: [{ cx: 0.5, cy: 0.42, w: 0.3, h: 0.3, speakingScore: null, speakingConfidence: 0 }], expressiveMoments: [] } },
    chunkAt(8, 14, 0.5),
  ];
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, null, OUT_W, OUT_H);
  // The whole 14s should read as ONE held shot, not fragment around the blip.
  assert.equal(merged.length, 1, `expected the noisy blip to be held over, got ${merged.length} segments`);
});

// --- Protective-wide vs. tight framing ---

test('computeRunPositionVariance: stable run (near-identical positions) has low variance', () => {
  const runObj = { layout: { type: 'single' }, chunks: [mergedChunk(0, 6, 0.5), mergedChunk(6, 12, 0.505)] };
  assert.ok(computeRunPositionVariance(runObj) < 0.05);
});

test('computeRunPositionVariance: moving run (large position spread) has high variance', () => {
  const runObj = { layout: { type: 'single' }, chunks: [mergedChunk(0, 6, 0.2), mergedChunk(6, 12, 0.7)] };
  assert.ok(computeRunPositionVariance(runObj) >= 0.05);
});

// 14. Low-movement + good-speaker tier run gets tightened, and the result still validates.
test('maybeTightenStableShot: a stable, well-framed run gets a tighter crop that still passes validation', () => {
  const layout = { type: 'single', slot: goodSlot(0.5) };
  const runObj = {
    layout, quality: scoreLayoutQuality(layout, {}),
    chunks: [mergedChunk(0, 6, 0.5), mergedChunk(6, 12, 0.502)],
  };
  const result = maybeTightenStableShot(runObj, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.equal(result.type, 'single');
  assert.ok(result.manualCrop, 'expected a tightened (manualCrop) layout for a stable, good-quality run');
});

// 15. High-movement run does NOT get tightened (stays protective-wide).
test('maybeTightenStableShot: a moving run is left at its protective-wide default, never tightened', () => {
  const layout = { type: 'single', slot: goodSlot(0.5) };
  const runObj = {
    layout, quality: scoreLayoutQuality(layout, {}),
    chunks: [mergedChunk(0, 6, 0.2), mergedChunk(6, 12, 0.7)],
  };
  const result = maybeTightenStableShot(runObj, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.equal(result, layout, 'a high-movement run must be returned completely untouched');
});

// 16. A tightening attempt that fails crop validation falls back to the untouched original.
test('maybeTightenStableShot: falls back to the original layout if the tightened crop fails validation', () => {
  // A landmark box that spans nearly the whole frame — any further zoom-in must fail
  // validateFaceCrop, forcing the fallback path.
  const hugeLandmark = { minX: 5, maxX: SRC_W - 5, minY: 5, maxY: SRC_H - 5 };
  const layout = { type: 'single', slot: { cx: 0.5, cy: 0.5, w: 0.9, h: 0.9, landmarkBox: hugeLandmark } };
  const runObj = {
    layout, quality: 0.9, // force above the good-speaker floor regardless of tier nuance
    chunks: [
      { start: 0, end: 6, layout: { type: 'single', slot: { cx: 0.5, cy: 0.5, landmarkBox: hugeLandmark } } },
      { start: 6, end: 12, layout: { type: 'single', slot: { cx: 0.502, cy: 0.5, landmarkBox: hugeLandmark } } },
    ],
  };
  const result = maybeTightenStableShot(runObj, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.equal(result, layout, 'must fall back to the exact original layout, never a degraded one');
});

test('maybeTightenStableShot: never re-tightens an already-manual crop', () => {
  const layout = { type: 'single', slot: goodSlot(), manualCrop: goodSlot() };
  const runObj = { layout, quality: 0.9, chunks: [mergedChunk(0, 6, 0.5), mergedChunk(6, 12, 0.5)] };
  assert.equal(maybeTightenStableShot(runObj, SRC_W, SRC_H, OUT_W, OUT_H), layout);
});

// 10 (full existing suite continuing to pass) is verified by running `node --test` as a whole
// alongside this file, not duplicated here.
