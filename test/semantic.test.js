// Tests for the richer-signal additions to the best-moment ranking system (see the plan
// doc "Richer signals for best-moment ranking and framing"): computeCutScore's audio/visual
// split and additive emotion/narrative terms, narrativeProximityBonus, and the strict-schema
// required/properties discipline that OpenAI's `strict: true` mode demands (easy to violate
// silently — see semantic.js's own comment on this).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeCutScore, narrativeProximityBonus,
  CUT_QUALITY_SCHEMA, HOOK_VALIDATION_SCHEMA, NARRATIVE_ARC_SCHEMA,
} = require('../src/semantic');

test('computeCutScore: no semantic signal -> plain normalizedScore passthrough (untouched no-op path)', () => {
  assert.equal(computeCutScore(0.42, null), 0.42);
});

test('computeCutScore: single-source candidate (no extras) reproduces the original 8-weight formula exactly', () => {
  const semantic = {
    semantic_completion: 0.8, narrative_completion: 0.7, reaction_value: 0.6,
    mid_sentence_penalty_start: 0.1, mid_sentence_penalty_end: 0.05,
    mid_action_penalty: 0.02, continuity_break_penalty: 0.03,
    // no primary_emotion/emotion_intensity — an "old-shape" semantic object
  };
  const normalizedScore = 0.5;
  const expected = 0.35 * normalizedScore + 0.18 * 0.8 + 0.15 * 0.7 + 0.10 * 0.6
    - 0.12 * 0.1 - 0.12 * 0.05 - 0.06 * 0.02 - 0.08 * 0.03;
  const actual = computeCutScore(normalizedScore, semantic);
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

test('computeCutScore: both-source candidate uses the split audio/visual weights instead of the single audio weight', () => {
  const semantic = {
    semantic_completion: 0, narrative_completion: 0, reaction_value: 0,
    mid_sentence_penalty_start: 0, mid_sentence_penalty_end: 0,
    mid_action_penalty: 0, continuity_break_penalty: 0,
  };
  const source = { kind: 'both', audioNorm: 0.9, visualNorm: 0.2 };
  const actual = computeCutScore(0.5 /* ignored for 'both' */, semantic, { source });
  const expected = 0.20 * 0.9 + 0.15 * 0.2; // audioSplit*audioNorm + visualSplit*visualNorm
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

test('computeCutScore: single-source-labeled candidate ignores audioNorm/visualNorm and uses the plain audio weight', () => {
  const semantic = {
    semantic_completion: 0, narrative_completion: 0, reaction_value: 0,
    mid_sentence_penalty_start: 0, mid_sentence_penalty_end: 0,
    mid_action_penalty: 0, continuity_break_penalty: 0,
  };
  const source = { kind: 'audio', audioNorm: 0.9, visualNorm: null };
  const actual = computeCutScore(0.5, semantic, { source });
  assert.ok(Math.abs(actual - 0.35 * 0.5) < 1e-9);
});

test('computeCutScore: emotion_intensity and narrativeBonus are zero-cost when absent, additive when present', () => {
  const base = {
    semantic_completion: 0, narrative_completion: 0, reaction_value: 0,
    mid_sentence_penalty_start: 0, mid_sentence_penalty_end: 0,
    mid_action_penalty: 0, continuity_break_penalty: 0,
  };
  const withoutExtras = computeCutScore(0, base);
  assert.equal(withoutExtras, 0);

  const withEmotion = computeCutScore(0, { ...base, emotion_intensity: 0.8 });
  assert.ok(Math.abs(withEmotion - 0.05 * 0.8) < 1e-9);

  const withNarrative = computeCutScore(0, base, { narrativeBonus: 1 });
  assert.ok(Math.abs(withNarrative - 0.06 * 1) < 1e-9);
});

test('narrativeProximityBonus: a beat exactly at the candidate midpoint scores 1', () => {
  const candidate = { start: 100, end: 110 }; // midpoint 105
  const bonus = narrativeProximityBonus(candidate, [{ approxTimeSec: 105, kind: 'payoff' }]);
  assert.equal(bonus, 1);
});

test('narrativeProximityBonus: a beat far outside the proximity window scores 0, not negative', () => {
  const candidate = { start: 100, end: 110 };
  const bonus = narrativeProximityBonus(candidate, [{ approxTimeSec: 500, kind: 'setup' }]);
  assert.equal(bonus, 0);
});

test('narrativeProximityBonus: no beats at all scores 0', () => {
  const candidate = { start: 100, end: 110 };
  assert.equal(narrativeProximityBonus(candidate, []), 0);
  assert.equal(narrativeProximityBonus(candidate, null), 0);
});

test('narrativeProximityBonus: picks the closest of several beats', () => {
  const candidate = { start: 100, end: 110 }; // midpoint 105
  const bonus = narrativeProximityBonus(candidate, [
    { approxTimeSec: 300, kind: 'setup' },
    { approxTimeSec: 110, kind: 'turn' }, // 5s away -> bonus 0.75 at default 20s window
    { approxTimeSec: 0, kind: 'other' },
  ]);
  assert.ok(Math.abs(bonus - 0.75) < 1e-9);
});

// OpenAI's `strict: true` schema mode requires every property to be listed in `required` —
// silently forgetting one breaks the call entirely rather than failing gracefully. This test
// makes that discipline self-enforcing for every schema this plan added a field to.
function assertRequiredMatchesProperties(schema, label) {
  const propKeys = Object.keys(schema.properties).sort();
  const required = [...schema.required].sort();
  assert.deepEqual(required, propKeys, `${label}: required must list exactly the schema's properties`);
}

test('CUT_QUALITY_SCHEMA: required matches properties (including the new emotion fields)', () => {
  assertRequiredMatchesProperties(CUT_QUALITY_SCHEMA, 'CUT_QUALITY_SCHEMA');
  assert.ok('primary_emotion' in CUT_QUALITY_SCHEMA.properties);
  assert.ok('emotion_intensity' in CUT_QUALITY_SCHEMA.properties);
});

test('HOOK_VALIDATION_SCHEMA: required matches properties (including the new emotional_importance field)', () => {
  assertRequiredMatchesProperties(HOOK_VALIDATION_SCHEMA, 'HOOK_VALIDATION_SCHEMA');
  assert.ok('emotional_importance' in HOOK_VALIDATION_SCHEMA.properties);
});

test('NARRATIVE_ARC_SCHEMA: required matches properties, including the nested beat item schema', () => {
  assertRequiredMatchesProperties(NARRATIVE_ARC_SCHEMA, 'NARRATIVE_ARC_SCHEMA');
  assertRequiredMatchesProperties(NARRATIVE_ARC_SCHEMA.properties.beats.items, 'NARRATIVE_ARC_SCHEMA.beats.items');
});

test('NARRATIVE_ARC_SCHEMA: M1 enrichment (recurringTopics/weakSections) is present and self-consistent', () => {
  assert.ok('recurringTopics' in NARRATIVE_ARC_SCHEMA.properties);
  assert.ok('weakSections' in NARRATIVE_ARC_SCHEMA.properties);
  assertRequiredMatchesProperties(NARRATIVE_ARC_SCHEMA.properties.weakSections.items, 'NARRATIVE_ARC_SCHEMA.weakSections.items');
});

test('CUT_QUALITY_SCHEMA: M1 moment-signal fields are present', () => {
  for (const key of ['hook_strength', 'humor', 'surprise', 'curiosity', 'controversy', 'quotability', 'uniqueness', 'payoff_strength', 'context_completeness', 'setup_start_adjust_sec', 'payoff_end_adjust_sec', 'preferred_framing']) {
    assert.ok(key in CUT_QUALITY_SCHEMA.properties, `expected CUT_QUALITY_SCHEMA to have property "${key}"`);
  }
});
