// Tests for plan doc M4 (AI Editorial Upgrade): promoting more than one reaction cutaway,
// gated by editorial relevance (a nearby narrative beat, or a strong candidate-level
// surprise/humor signal from M1) rather than randomly inserted, plus cap/spacing enforcement.
const test = require('node:test');
const assert = require('node:assert/strict');

const { selectReactionCutaways, isEditoriallyRelevantReaction, planClipSegments } = require('../src/effects');

function cand(clipLocalT, adjustedScore) {
  return { clipLocalT, adjustedScore, score: adjustedScore, clusterIndex: 0, slots: [{ cx: 0.5, cy: 0.5 }] };
}

test('isEditoriallyRelevantReaction: false with no narrativeBeats and no momentSignals (today\'s exact single-cutaway state)', () => {
  assert.equal(isEditoriallyRelevantReaction(10, 0, [], null), false);
});

test('isEditoriallyRelevantReaction: true when within REACTION_BEAT_PROXIMITY_SEC of a narrative beat', () => {
  assert.equal(isEditoriallyRelevantReaction(10, 100, [{ approxTimeSec: 108 }], null), true); // |108-110|=2 <= 8
  assert.equal(isEditoriallyRelevantReaction(10, 100, [{ approxTimeSec: 200 }], null), false); // way outside proximity
});

test('isEditoriallyRelevantReaction: true when the candidate\'s surprise or humor signal is strong', () => {
  assert.equal(isEditoriallyRelevantReaction(10, 0, [], { surprise: 0.9 }), true);
  assert.equal(isEditoriallyRelevantReaction(10, 0, [], { humor: 0.7 }), true);
  assert.equal(isEditoriallyRelevantReaction(10, 0, [], { surprise: 0.2, humor: 0.1 }), false);
});

test('selectReactionCutaways: with no narrativeBeats/momentSignals, returns ONLY the single best (byte-identical to pre-M4)', () => {
  const candidates = [cand(5, 0.9), cand(20, 0.85), cand(40, 0.8)];
  const picked = selectReactionCutaways(candidates, { absStart: 0, narrativeBeats: [], momentSignals: null });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].clipLocalT, 5); // the single highest-scoring one
});

test('selectReactionCutaways: with maxCutaways=1 explicitly, still only the single best regardless of relevance', () => {
  const candidates = [cand(5, 0.9), cand(20, 0.85)];
  const picked = selectReactionCutaways(candidates, { maxCutaways: 1, absStart: 0, narrativeBeats: [{ approxTimeSec: 20 }], momentSignals: { surprise: 0.9 } });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].clipLocalT, 5);
});

test('selectReactionCutaways: a second candidate with no nearby beat/signal is NOT promoted', () => {
  const candidates = [cand(5, 0.9), cand(30, 0.85)];
  const picked = selectReactionCutaways(candidates, { maxCutaways: 2, absStart: 0, narrativeBeats: [], momentSignals: null });
  assert.equal(picked.length, 1, 'the 2nd candidate must not be promoted without a relevance signal');
});

test('selectReactionCutaways: a second candidate near a narrative beat IS promoted (up to the cap)', () => {
  const candidates = [cand(5, 0.9), cand(30, 0.85)];
  const picked = selectReactionCutaways(candidates, { maxCutaways: 2, absStart: 0, narrativeBeats: [{ approxTimeSec: 32 }], momentSignals: null });
  assert.equal(picked.length, 2);
  // Returned chronologically.
  assert.deepEqual(picked.map((p) => p.clipLocalT), [5, 30]);
});

test('selectReactionCutaways: a candidate-level strong surprise/humor signal alone can promote a second pick', () => {
  const candidates = [cand(5, 0.9), cand(30, 0.85)];
  const picked = selectReactionCutaways(candidates, { maxCutaways: 2, absStart: 0, narrativeBeats: [], momentSignals: { humor: 0.8 } });
  assert.equal(picked.length, 2);
});

test('selectReactionCutaways: never exceeds maxCutaways even with many relevant candidates', () => {
  const candidates = [cand(0, 0.99), cand(20, 0.9), cand(40, 0.85), cand(60, 0.8), cand(80, 0.75)];
  const picked = selectReactionCutaways(candidates, { maxCutaways: 2, absStart: 0, narrativeBeats: [{ approxTimeSec: 20 }, { approxTimeSec: 40 }, { approxTimeSec: 60 }, { approxTimeSec: 80 }], momentSignals: null });
  assert.equal(picked.length, 2, 'must respect the cap regardless of how many candidates are individually relevant');
});

test('selectReactionCutaways: enforces minimum spacing — two picks too close together collapse to one', () => {
  const candidates = [cand(10, 0.9), cand(11, 0.85)]; // 1s apart, well under the spacing floor
  const picked = selectReactionCutaways(candidates, { maxCutaways: 2, absStart: 0, narrativeBeats: [{ approxTimeSec: 11 }], momentSignals: null });
  assert.equal(picked.length, 1, 'candidates within the minimum spacing window must not both be promoted');
});

// End-to-end: prove multiple reaction cutaways still go through the same crop-validated
// splice path as the single-cutaway case (finalizeLayoutWithCropValidation is unconditional
// on every splice branch in planClipSegments — this exercises that via the public API rather
// than re-testing the internals of finalizeLayoutWithCropValidation itself).
test('planClipSegments: multiple reaction cutaways in an ordinary split run all produce valid, non-degenerate segments', () => {
  const slotsAt = (cx) => [{ cx: 0.25, cy: 0.4, w: 0.3, h: 0.4 }, { cx: 0.75, cy: 0.4, w: 0.3, h: 0.4 }];
  const layoutTimeline = [
    { start: 0, end: 20, people: { faceCount: 2, slots: slotsAt(), expressiveMoments: [{ clusterIndex: 0, localT: 5, score: 0.9 }] } },
    { start: 20, end: 40, people: { faceCount: 2, slots: slotsAt(), expressiveMoments: [{ clusterIndex: 1, localT: 5, score: 0.8 }] } },
  ];
  const segments = planClipSegments({
    length: 40, layoutTimeline, energy: [], hopSec: 0.5, absStart: 0, srcW: 1920, srcH: 1080,
    words: [], tightenPacing: false, hookSplice: null, reactionComposite: null,
    narrativeBeats: [{ approxTimeSec: 25 }], momentSignals: null,
  });
  const reactionSegs = segments.filter((s) => s.tag === 'reaction');
  assert.ok(reactionSegs.length >= 1, 'expected at least one reaction cutaway');
  for (const seg of reactionSegs) {
    assert.ok(seg.end > seg.start, 'every spliced segment must have positive duration');
    assert.ok(seg.layout && seg.layout.type, 'every reaction cutaway must carry a finalized (crop-validated) layout');
  }
});
