// Tests for the framing-decision wiring added on top of the speakingScore/emotionalImportance
// signals (Component 6 of the plan doc). Each of these proves the specific claim the plan made:
// every new signal degrades to today's EXACT original behavior when absent/low-confidence, and
// only changes behavior when the new signal is confidently present.
const test = require('node:test');
const assert = require('node:assert/strict');

const { pickPrimaryReactor, reactionAdjustedScore, pickBaseLayout } = require('../src/effects');

const OUT_W = 1080;
const OUT_H = 1920;

test('pickPrimaryReactor: falls back to the exact original area+expression formula when speaking confidence is not universal', () => {
  const slots = [
    { w: 0.1, h: 0.1, speakingScore: 0.95, speakingConfidence: 0.9 }, // small area, "speaking", but...
    { w: 0.5, h: 0.5, speakingScore: null, speakingConfidence: 0 },   // ...the other slot has no reading at all
  ];
  const picked = pickPrimaryReactor(slots, []);
  // Not-all-confident -> pure area*0.4 formula decides -> the bigger face (slot 1) wins,
  // regardless of slot 0's high speakingScore.
  assert.equal(picked.mode, 'primary');
  assert.equal(picked.slot, slots[1]);
});

test('pickPrimaryReactor: blends speakingScore in only when every slot has a confident reading', () => {
  const slots = [
    { w: 0.3, h: 0.3, speakingScore: 0.9, speakingConfidence: 0.9 }, // same area as slot 1, but speaking
    { w: 0.3, h: 0.3, speakingScore: 0.1, speakingConfidence: 0.9 }, // same area, not speaking
  ];
  const picked = pickPrimaryReactor(slots, []);
  // Equal area+expression scores alone would be a tie; the speaking blend must be what
  // decides it in favor of slot 0.
  assert.equal(picked.mode, 'primary');
  assert.equal(picked.slot, slots[0]);
});

test('pickPrimaryReactor: single slot always short-circuits to primary regardless of speaking data', () => {
  const slots = [{ w: 0.3, h: 0.3, speakingScore: null, speakingConfidence: 0 }];
  const picked = pickPrimaryReactor(slots, []);
  assert.equal(picked.mode, 'primary');
  assert.equal(picked.slot, slots[0]);
});

test('reactionAdjustedScore: no speakingScore on the slot -> unchanged mo.score (today\'s exact behavior)', () => {
  const mo = { score: 0.8 };
  assert.equal(reactionAdjustedScore(mo, undefined), 0.8);
  assert.equal(reactionAdjustedScore(mo, { speakingScore: null, speakingConfidence: 0 }), 0.8);
});

test('reactionAdjustedScore: low-confidence speakingScore does not trigger the penalty', () => {
  const mo = { score: 0.8 };
  const slot = { speakingScore: 0.95, speakingConfidence: 0.1 }; // confidently speaking, but low CONFIDENCE
  assert.equal(reactionAdjustedScore(mo, slot), 0.8);
});

test('reactionAdjustedScore: confidently-speaking slot gets penalized (deprioritized, not excluded)', () => {
  const mo = { score: 0.8 };
  const slot = { speakingScore: 0.9, speakingConfidence: 0.9 };
  const adjusted = reactionAdjustedScore(mo, slot);
  assert.ok(adjusted < mo.score);
  assert.ok(adjusted > 0); // deprioritized, never zeroed out entirely
});

test('pickBaseLayout: n>=3 group crop is unaffected by emotionalImportance when the span is comfortably within threshold', () => {
  const people = { faceCount: 3, slots: [{ cx: 0.45, cy: 0.4 }, { cx: 0.5, cy: 0.4 }, { cx: 0.55, cy: 0.4 }] };
  const withoutImportance = pickBaseLayout(people, 1920, 1080, null, OUT_W, OUT_H);
  const withImportance = pickBaseLayout(people, 1920, 1080, null, OUT_W, OUT_H, 0.95);
  assert.equal(withoutImportance.type, 'single');
  assert.equal(withImportance.type, 'single');
});

test('pickBaseLayout: n>=3 group crop switches to fit under high emotionalImportance for a span that would otherwise still crop', () => {
  // Chosen so spanWidthPx falls strictly between the relaxed (0.70) and default (0.85)
  // fit-threshold fractions of maxCropWidthPx for this srcW/srcH/outW/outH combination.
  const people = { faceCount: 3, slots: [{ cx: 0.30, cy: 0.4 }, { cx: 0.42, cy: 0.4 }, { cx: 0.5448, cy: 0.4 }] };

  const withoutImportance = pickBaseLayout(people, 1920, 1080, null, OUT_W, OUT_H);
  assert.equal(withoutImportance.type, 'single', 'sanity check: default threshold should NOT trigger fit for this span');

  const withHighImportance = pickBaseLayout(people, 1920, 1080, null, OUT_W, OUT_H, 0.95);
  assert.equal(withHighImportance.type, 'fit', 'high emotionalImportance should relax the threshold enough to trigger fit');
});

test('pickBaseLayout: n===2 split is completely unaffected by emotionalImportance (out of this component\'s scope)', () => {
  const people = { faceCount: 2, slots: [{ cx: 0.3, cy: 0.4 }, { cx: 0.7, cy: 0.4 }] };
  const layout = pickBaseLayout(people, 1920, 1080, null, OUT_W, OUT_H, 0.99);
  assert.equal(layout.type, 'split');
});
