// Tests for plan doc M6 (AI Editorial Upgrade): selective punch-in/slow-motion/speed-up,
// wired using ONLY existing mechanisms (applyCropAdjust+finalizeLayoutWithCropValidation,
// segment.rate) — never a new render primitive, never applied without a real signal.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldPunchInReaction, tryPunchIn, applyRateWindow, findSustainedHighEnergyWindow,
  applyEditorialEmphasis, finalizeLayoutWithCropValidation,
} = require('../src/effects');

const SRC_W = 1920;
const SRC_H = 1080;
const OUT_W = 1080;
const OUT_H = 1920;

test('shouldPunchInReaction: false with no momentSignals (default, no-op state)', () => {
  assert.equal(shouldPunchInReaction(null), false);
  assert.equal(shouldPunchInReaction({}), false);
});

test('shouldPunchInReaction: true when humor or surprise clears the threshold', () => {
  assert.equal(shouldPunchInReaction({ humor: 0.9 }), true);
  assert.equal(shouldPunchInReaction({ surprise: 0.7 }), true);
  assert.equal(shouldPunchInReaction({ humor: 0.2, surprise: 0.1 }), false);
});

test('tryPunchIn: applies a tighter, still-valid crop for a well-centered face with room to zoom', () => {
  const layout = { type: 'single', slot: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.3, landmarkBox: null } };
  const punched = tryPunchIn(layout, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.equal(punched.type, 'single');
  assert.ok(punched.manualCrop, 'a punched-in layout must set manualCrop so render.js actually uses the tighter size');
});

test('tryPunchIn: non-"single" layout is returned unchanged (nothing to punch in on)', () => {
  const fitLayout = { type: 'fit' };
  assert.equal(tryPunchIn(fitLayout, SRC_W, SRC_H, OUT_W, OUT_H), fitLayout);
});

test('tryPunchIn: falls back to the ORIGINAL layout when the tighter crop would cut off the face (never a cut-off face)', () => {
  // A face landmark box that fills nearly the whole frame — zooming in further must fail
  // crop validation, and tryPunchIn must return the original, untouched layout rather than
  // a degraded 'fit' fallback.
  const landmarkBox = { minX: 10, maxX: SRC_W - 10, minY: 10, maxY: SRC_H - 10 };
  const layout = { type: 'single', slot: { cx: 0.5, cy: 0.5, w: 0.98, h: 0.98, landmarkBox } };
  const punched = tryPunchIn(layout, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.equal(punched, layout, 'must return the exact original layout object, not a degraded fallback');
});

test('applyRateWindow: splits the containing segment and sets rate on the middle piece', () => {
  const segments = [{ start: 0, end: 20, rate: 1, layout: { type: 'fit' } }];
  const ok = applyRateWindow(segments, 10, 2, 0.6);
  assert.equal(ok, true);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].rate, 0.6);
  assert.equal(segments[1].tag, 'slowmo');
  assert.ok(segments[0].end <= 10 && segments[2].start >= 10);
});

test('applyRateWindow: speed-up (rate > 1) is tagged "speedup"', () => {
  const segments = [{ start: 0, end: 20, rate: 1, layout: { type: 'fit' } }];
  applyRateWindow(segments, 10, 2, 1.3);
  assert.equal(segments[1].tag, 'speedup');
});

test('applyRateWindow: refuses to create a degenerate segment (respects MIN_SEGMENT on both sides)', () => {
  const segments = [{ start: 0, end: 3, rate: 1, layout: { type: 'fit' } }]; // too short for a 2s window with MIN_SEGMENT margin
  const ok = applyRateWindow(segments, 1.5, 1, 0.6);
  assert.equal(ok, false);
  assert.equal(segments.length, 1, 'must not mutate segments when the window does not fit safely');
});

test('applyRateWindow: window entirely outside any segment is a no-op', () => {
  const segments = [{ start: 0, end: 10, rate: 1, layout: { type: 'fit' } }];
  const ok = applyRateWindow(segments, 50, 2, 0.6);
  assert.equal(ok, false);
  assert.equal(segments.length, 1);
});

test('findSustainedHighEnergyWindow: null when energy is flat (nothing stands out)', () => {
  const energy = new Array(120).fill(0.5); // 60s at hopSec=0.5, perfectly flat
  assert.equal(findSustainedHighEnergyWindow(energy, 0.5, 0, 60), null);
});

test('findSustainedHighEnergyWindow: finds a genuinely sustained hot stretch above the multiplier', () => {
  const energy = new Array(120).fill(0.2); // avg baseline
  for (let i = 40; i < 56; i++) energy[i] = 1.0; // 8s hot stretch, well above 1.5x avg
  const hot = findSustainedHighEnergyWindow(energy, 0.5, 0, 60);
  assert.ok(hot, 'expected a sustained high-energy window to be found');
  assert.ok(hot.end - hot.start >= 3, 'must respect the minimum duration');
});

test('findSustainedHighEnergyWindow: a brief spike shorter than the minimum duration does not qualify', () => {
  const energy = new Array(120).fill(0.2);
  energy[40] = 5.0; // one single hop spike, way too short
  assert.equal(findSustainedHighEnergyWindow(energy, 0.5, 0, 60), null);
});

test('applyEditorialEmphasis: no signals at all -> segments returned completely unchanged', () => {
  const segments = [
    { start: 0, end: 20, rate: 1, layout: { type: 'single', slot: { cx: 0.5, cy: 0.5, w: 0.3, h: 0.3 } }, tag: 'reaction' },
    { start: 20, end: 40, rate: 1, layout: { type: 'fit' } },
  ];
  const before = JSON.stringify(segments);
  const result = applyEditorialEmphasis(segments, {
    srcW: SRC_W, srcH: SRC_H, outW: OUT_W, outH: OUT_H, absStart: 0, length: 40,
    energy: new Array(80).fill(0.5), hopSec: 0.5, momentSignals: null, narrativeBeats: [],
  });
  assert.equal(JSON.stringify(result), before, 'with no qualifying signal, output must be byte-identical to the input');
});

test('applyEditorialEmphasis: punches in a reaction segment when momentSignals shows a strong comedic peak', () => {
  const reactionLayout = { type: 'single', slot: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.3, landmarkBox: null } };
  const segments = [
    { start: 0, end: 20, rate: 1, layout: reactionLayout, tag: 'reaction' },
    { start: 20, end: 40, rate: 1, layout: { type: 'fit' } },
  ];
  applyEditorialEmphasis(segments, {
    srcW: SRC_W, srcH: SRC_H, outW: OUT_W, outH: OUT_H, absStart: 0, length: 40,
    energy: [], hopSec: 0.5, momentSignals: { humor: 0.9 }, narrativeBeats: [],
  });
  assert.ok(segments[0].layout.manualCrop, 'expected the reaction segment to be punched in');
});

test('applyEditorialEmphasis: applies slow-motion at a "payoff" narrative beat inside the clip window', () => {
  const segments = [{ start: 0, end: 40, rate: 1, layout: { type: 'fit' } }];
  applyEditorialEmphasis(segments, {
    srcW: SRC_W, srcH: SRC_H, outW: OUT_W, outH: OUT_H, absStart: 100, length: 40,
    energy: [], hopSec: 0.5, momentSignals: { payoff_strength: 0.9 }, narrativeBeats: [{ kind: 'payoff', approxTimeSec: 120 }],
  });
  const slowSeg = segments.find((s) => s.tag === 'slowmo');
  assert.ok(slowSeg, 'expected a slow-motion segment around the payoff beat');
  assert.equal(slowSeg.rate < 1, true);
});

test('applyEditorialEmphasis: a "payoff" beat OUTSIDE this clip\'s window is ignored', () => {
  const segments = [{ start: 0, end: 40, rate: 1, layout: { type: 'fit' } }];
  applyEditorialEmphasis(segments, {
    srcW: SRC_W, srcH: SRC_H, outW: OUT_W, outH: OUT_H, absStart: 100, length: 40,
    energy: [], hopSec: 0.5, momentSignals: { payoff_strength: 0.9 }, narrativeBeats: [{ kind: 'payoff', approxTimeSec: 500 }],
  });
  assert.equal(segments.length, 1, 'a beat outside this clip must never trigger a splice');
});

test('applyEditorialEmphasis: respects MAX_EDITORIAL_EFFECTS_PER_CLIP total budget across effect types', () => {
  const reactionLayout = { type: 'single', slot: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.3, landmarkBox: null } };
  const energy = new Array(160).fill(0.2);
  for (let i = 40; i < 56; i++) energy[i] = 1.0; // qualifying hot stretch
  const segments = [
    { start: 0, end: 40, rate: 1, layout: reactionLayout, tag: 'reaction' },
    { start: 40, end: 80, rate: 1, layout: { type: 'fit' } },
  ];
  applyEditorialEmphasis(segments, {
    srcW: SRC_W, srcH: SRC_H, outW: OUT_W, outH: OUT_H, absStart: 0, length: 80,
    energy, hopSec: 0.5, momentSignals: { humor: 0.9, payoff_strength: 0.9 },
    narrativeBeats: [{ kind: 'payoff', approxTimeSec: 60 }],
  });
  // 3 possible effects (punch-in, slow-motion, speed-up) but budget defaults to 2 — at most
  // 2 of the 3 signals may have actually been applied.
  const punchedIn = segments.some((s) => s.layout?.manualCrop);
  const rateEffects = segments.filter((s) => s.tag === 'slowmo' || s.tag === 'speedup').length;
  const totalApplied = (punchedIn ? 1 : 0) + rateEffects;
  assert.ok(totalApplied <= 2, `expected at most 2 effects applied under the default budget, got ${totalApplied}`);
});
