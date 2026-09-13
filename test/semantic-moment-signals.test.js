// Tests for plan doc M1 (AI Editorial Upgrade): the richer per-candidate moment signals
// layered onto the existing cutScore ranking, and the byte-identical-when-absent contract
// that makes this an additive extension rather than a competing scoring engine.
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeCutScore, computeMomentSignalBonus, MOMENT_SIGNAL_SUBWEIGHTS, CUT_SCORE_WEIGHTS } = require('../src/semantic');

test('computeMomentSignalBonus: null/undefined momentSignals -> 0 (zero-cost no-op)', () => {
  assert.equal(computeMomentSignalBonus(null), 0);
  assert.equal(computeMomentSignalBonus(undefined), 0);
});

test('computeMomentSignalBonus: every dimension maxed out -> exactly the sum of sub-weights (1.0)', () => {
  const maxed = {};
  for (const key of Object.keys(MOMENT_SIGNAL_SUBWEIGHTS)) maxed[key] = 1;
  const bonus = computeMomentSignalBonus(maxed);
  assert.ok(Math.abs(bonus - 1) < 1e-9, `expected bonus ~1, got ${bonus}`);
});

test('computeMomentSignalBonus: missing fields contribute 0, not a penalty (partial signal is safe)', () => {
  const partial = { hook_strength: 1 }; // every other sub-weighted field absent
  const bonus = computeMomentSignalBonus(partial);
  assert.ok(Math.abs(bonus - MOMENT_SIGNAL_SUBWEIGHTS.hook_strength) < 1e-9);
});

test('computeMomentSignalBonus: out-of-range values are clamped to [0,1]', () => {
  const overshoot = { hook_strength: 5, surprise: -5 };
  const bonus = computeMomentSignalBonus(overshoot);
  // hook_strength clamps to 1 (contributes its full weight), surprise clamps to 0 (contributes 0)
  assert.ok(Math.abs(bonus - MOMENT_SIGNAL_SUBWEIGHTS.hook_strength) < 1e-9);
});

test('computeMomentSignalBonus: non-numeric/garbage fields are ignored, not thrown on', () => {
  const garbage = { hook_strength: 'high', humor: null, surprise: undefined, curiosity: NaN };
  assert.equal(computeMomentSignalBonus(garbage), 0);
});

// Regression test directly proving the earlier review concern does NOT hold: the
// pre-existing narrativeBonus term must survive unchanged, and momentSignalBonus is a pure
// ADDITION on top of it — never a replacement, never cancelling it.
test('computeCutScore: narrativeBonus and momentSignalBonus are both additive and independent', () => {
  const semantic = {
    semantic_completion: 0.5, narrative_completion: 0.5, reaction_value: 0.5, emotion_intensity: 0.5,
    mid_sentence_penalty_start: 0, mid_sentence_penalty_end: 0, mid_action_penalty: 0, continuity_break_penalty: 0,
  };
  const w = CUT_SCORE_WEIGHTS;
  const base = w.audio * 0.6 + w.completion * 0.5 + w.narrative * 0.5 + w.reaction * 0.5 + w.emotionIntensity * 0.5;

  const withNarrativeOnly = computeCutScore(0.6, semantic, { narrativeBonus: 0.8 });
  const withBothBonuses = computeCutScore(0.6, semantic, { narrativeBonus: 0.8, momentSignalBonus: 0.5 });

  assert.ok(Math.abs(withNarrativeOnly - (base + w.narrativeBeat * 0.8)) < 1e-9, 'narrativeBonus term must be exactly as before');
  // Adding momentSignalBonus must shift the score by EXACTLY w.momentSignals * 0.5, and the
  // narrativeBonus contribution must be identical in both calls (not cancelled/doubled).
  assert.ok(Math.abs((withBothBonuses - withNarrativeOnly) - w.momentSignals * 0.5) < 1e-9);
});

test('computeCutScore: momentSignalBonus absent from extras -> byte-identical to pre-M1 behavior', () => {
  const semantic = {
    semantic_completion: 0.7, narrative_completion: 0.3, reaction_value: 0.9, emotion_intensity: 0.2,
    mid_sentence_penalty_start: 0.1, mid_sentence_penalty_end: 0.2, mid_action_penalty: 0, continuity_break_penalty: 0.1,
  };
  const withoutMomentField = computeCutScore(0.4, semantic, { narrativeBonus: 0.3 });
  const withExplicitZero = computeCutScore(0.4, semantic, { narrativeBonus: 0.3, momentSignalBonus: 0 });
  assert.equal(withoutMomentField, withExplicitZero);
});

test('computeCutScore: no semantic signal at all -> still the untouched normalizedScore passthrough', () => {
  assert.equal(computeCutScore(0.42, null, { momentSignalBonus: 0.9 }), 0.42);
});
