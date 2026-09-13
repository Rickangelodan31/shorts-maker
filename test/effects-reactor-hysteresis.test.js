// Tests for plan doc M3 (AI Editorial Upgrade): cross-chunk speaker/reactor-switch hysteresis
// (nextReactorHysteresisState) and the preferredFraming advisory nudge on reactionAdjustedScore.
const test = require('node:test');
const assert = require('node:assert/strict');

const { nextReactorHysteresisState, reactionAdjustedScore, pickPrimaryReactor } = require('../src/effects');

function primary(index, margin) {
  return { mode: 'primary', slot: { fake: index }, index, margin };
}

test('nextReactorHysteresisState: first confident pick is confirmed immediately (no prior state)', () => {
  const state = nextReactorHysteresisState(null, primary(0, 0.5));
  assert.equal(state.useIndex, 0);
  assert.equal(state.confirmedIndex, 0);
});

test('nextReactorHysteresisState: the SAME index re-affirms without touching pending state', () => {
  let state = nextReactorHysteresisState(null, primary(0, 0.5));
  state = nextReactorHysteresisState(state, primary(0, 0.4));
  assert.equal(state.useIndex, 0);
  assert.equal(state.pendingStreak, 0);
});

test('nextReactorHysteresisState: one noisy chunk favoring a different index does NOT flip the target', () => {
  let state = nextReactorHysteresisState(null, primary(0, 0.5)); // confirm 0
  state = nextReactorHysteresisState(state, primary(1, 0.3)); // one noisy chunk favoring 1 (below fast-path margin)
  assert.equal(state.useIndex, 0, 'must hold the prior confirmed target after a single noisy chunk');
  assert.equal(state.pendingIndex, 1);
  assert.equal(state.pendingStreak, 1);
});

test('nextReactorHysteresisState: switch requires REACTOR_CONFIRM_CHUNKS consecutive confirmations (default 2)', () => {
  let state = nextReactorHysteresisState(null, primary(0, 0.5)); // confirm 0
  state = nextReactorHysteresisState(state, primary(1, 0.3)); // pending streak 1 for index 1 -> still holds 0
  assert.equal(state.useIndex, 0);
  state = nextReactorHysteresisState(state, primary(1, 0.3)); // 2nd consecutive confirmation for index 1
  assert.equal(state.useIndex, 1, 'must switch once the confirm-chunk threshold is reached');
  assert.equal(state.confirmedIndex, 1);
  assert.equal(state.pendingStreak, 0);
});

test('nextReactorHysteresisState: a low-confidence stretch (alternating candidates) holds the prior target indefinitely', () => {
  let state = nextReactorHysteresisState(null, primary(0, 0.5)); // confirm 0
  state = nextReactorHysteresisState(state, primary(1, 0.3)); // pending 1, streak 1 -> hold 0
  state = nextReactorHysteresisState(state, primary(0, 0.3)); // back to 0 -> re-affirms 0, resets pending
  assert.equal(state.useIndex, 0);
  state = nextReactorHysteresisState(state, primary(1, 0.3)); // pending 1 again, streak resets to 1 -> hold 0
  assert.equal(state.useIndex, 0, 'alternating noisy candidates must never accumulate a streak against the confirmed target');
  assert.equal(state.pendingStreak, 1);
});

test('nextReactorHysteresisState: a very-high-margin pick switches immediately (fast path)', () => {
  let state = nextReactorHysteresisState(null, primary(0, 0.5)); // confirm 0
  state = nextReactorHysteresisState(state, primary(1, 0.95)); // margin well above REACTOR_HIGH_CONFIDENCE_MARGIN (0.7)
  assert.equal(state.useIndex, 1, 'a decisive pick must switch immediately without waiting for consecutive confirmations');
  assert.equal(state.confirmedIndex, 1);
});

test('nextReactorHysteresisState: an ambiguous ("widen") or absent pick resets to no confirmed target', () => {
  let state = nextReactorHysteresisState(null, primary(0, 0.5));
  state = nextReactorHysteresisState(state, { mode: 'widen', slot: {} });
  assert.equal(state.useIndex, null);
  assert.equal(state.confirmedIndex, null);
  const stateAfterNull = nextReactorHysteresisState(state, null);
  assert.equal(stateAfterNull.useIndex, null);
});

test('pickPrimaryReactor: single-slot case returns index=0, margin=1 (backward-compatible addition)', () => {
  const result = pickPrimaryReactor([{ w: 0.3, h: 0.3 }], []);
  assert.equal(result.mode, 'primary');
  assert.equal(result.index, 0);
  assert.equal(result.margin, 1);
});

test('pickPrimaryReactor: primary-mode result includes index/margin without changing which slot wins', () => {
  const slots = [
    { w: 0.1, h: 0.1, speakingScore: null, speakingConfidence: 0 },
    { w: 0.5, h: 0.5, speakingScore: null, speakingConfidence: 0 },
  ];
  const result = pickPrimaryReactor(slots, []);
  assert.equal(result.mode, 'primary');
  assert.equal(result.slot, slots[1]); // bigger face wins, as before
  assert.equal(result.index, 1);
  assert.ok(result.margin > 0 && result.margin <= 1);
});

test('reactionAdjustedScore: preferredFraming absent/non-"reaction" -> byte-identical to pre-M3 behavior', () => {
  const mo = { score: 0.6 };
  const slot = { speakingScore: null, speakingConfidence: 0 };
  assert.equal(reactionAdjustedScore(mo, slot), reactionAdjustedScore(mo, slot, null));
  assert.equal(reactionAdjustedScore(mo, slot, 'speaker'), reactionAdjustedScore(mo, slot));
});

test('reactionAdjustedScore: preferredFraming="reaction" applies a bounded boost, never a hard override', () => {
  const mo = { score: 0.6 };
  const slot = { speakingScore: null, speakingConfidence: 0 };
  const base = reactionAdjustedScore(mo, slot);
  const boosted = reactionAdjustedScore(mo, slot, 'reaction');
  assert.ok(boosted > base, 'reaction preference must increase the score');
  assert.ok(boosted < base * 1.5, 'the boost must stay small/bounded, not a dramatic override');
});

test('reactionAdjustedScore: preferredFraming="reaction" still respects the speaker-deprioritization penalty', () => {
  const mo = { score: 0.6 };
  const likelySpeakerSlot = { speakingScore: 0.9, speakingConfidence: 0.9 };
  const boosted = reactionAdjustedScore(mo, likelySpeakerSlot, 'reaction');
  const unpenalizedNonSpeaker = reactionAdjustedScore(mo, { speakingScore: null, speakingConfidence: 0 }, null);
  assert.ok(boosted < unpenalizedNonSpeaker, 'the speaker penalty must still apply even with a reaction preference boost on top');
});
