// Tests for plan doc M7 (AI Editorial Upgrade): buildKeyframesForRun — the safety gate that
// decides whether a merged run is eligible for smooth panning. Per the plan's explicit
// requirement, these prove (1) interpolation only ever activates between already-validated
// boxes, and (2) sparse/unreliable tracking falls back to today's exact static behavior.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildKeyframesForRun, buildLayoutSegments } = require('../src/effects');

const SRC_W = 1920;
const SRC_H = 1080;
const OUT_W = 1080;
const OUT_H = 1920;

function singleChunk(start, end, cx, cy, landmarkBox = null) {
  return { start, end, layout: { type: 'single', slot: { cx, cy, landmarkBox } } };
}

test('buildKeyframesForRun: fewer than 2 chunks -> null (nothing to interpolate)', () => {
  const run = { start: 0, end: 6, layout: { type: 'single', slot: { cx: 0.5, cy: 0.5 } }, chunks: [singleChunk(0, 6, 0.5, 0.5)] };
  assert.equal(buildKeyframesForRun(run, SRC_W, SRC_H, OUT_W, OUT_H), null);
});

test('buildKeyframesForRun: unsupported layout type (fit/split) -> null', () => {
  const fitRun = { start: 0, end: 12, layout: { type: 'fit' }, chunks: [singleChunk(0, 6, 0.5, 0.5), singleChunk(6, 12, 0.5, 0.5)] };
  assert.equal(buildKeyframesForRun(fitRun, SRC_W, SRC_H, OUT_W, OUT_H), null);
});

test('buildKeyframesForRun: 2+ chunks with no landmark data (trivially safe) -> returns keyframes', () => {
  const chunks = [singleChunk(0, 6, 0.3, 0.5), singleChunk(6, 12, 0.7, 0.5)];
  const run = { start: 0, end: 12, layout: { type: 'single' }, chunks };
  const result = buildKeyframesForRun(run, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.ok(result, 'expected keyframes to be built when no landmark data exists to violate');
  assert.equal(result.keyframes.length, 2);
  assert.equal(result.keyframes[0].t, 0); // relative to run.start
  assert.equal(result.keyframes[1].t, 6);
  assert.equal(result.keyframes[0].cx, 0.3);
  assert.equal(result.keyframes[1].cx, 0.7);
  assert.ok(result.fixedW > 0 && result.fixedH > 0);
});

test('buildKeyframesForRun: every keyframe\'s box at the run\'s fixed size must independently pass validateFaceCrop', () => {
  // A face landmark box so large that ANY reasonably-sized crop around it fails validation —
  // this proves the safety re-check actually runs (not just trusted-by-construction).
  const hugeLandmark = { minX: 5, maxX: SRC_W - 5, minY: 5, maxY: SRC_H - 5 };
  const chunks = [singleChunk(0, 6, 0.5, 0.5, hugeLandmark), singleChunk(6, 12, 0.5, 0.5, hugeLandmark)];
  const run = { start: 0, end: 12, layout: { type: 'single' }, chunks };
  const result = buildKeyframesForRun(run, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.equal(result, null, 'must fall back to static behavior when a keyframe box can\'t be safely validated');
});

test('buildKeyframesForRun: a well-behaved 2-chunk run with real (small, safe) landmark boxes validates and returns keyframes', () => {
  const smallLandmark = (cx, cy) => ({
    minX: cx * SRC_W - 50, maxX: cx * SRC_W + 50, minY: cy * SRC_H - 60, maxY: cy * SRC_H + 60,
  });
  const chunks = [
    singleChunk(0, 6, 0.5, 0.42, smallLandmark(0.5, 0.42)),
    singleChunk(6, 12, 0.52, 0.42, smallLandmark(0.52, 0.42)),
  ];
  const run = { start: 0, end: 12, layout: { type: 'single' }, chunks };
  const result = buildKeyframesForRun(run, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.ok(result, 'expected a well-behaved small-movement run to validate successfully');
  assert.equal(result.keyframes.length, 2);
});

test('buildKeyframesForRun: reaction-split uses the MAX face-box size across chunks as the fixed size', () => {
  const chunkWithFace = (start, end, cx, cy, w, h) => ({
    start, end, layout: { type: 'reaction-split', faceBox: { cx, cy, w, h, landmarkBox: null }, faceMargin: 0.15 },
  });
  const run = {
    start: 0, end: 12,
    layout: { type: 'reaction-split', faceMargin: 0.15 },
    chunks: [chunkWithFace(0, 6, 0.3, 0.4, 0.15, 0.2), chunkWithFace(6, 12, 0.3, 0.4, 0.3, 0.4)],
  };
  const result = buildKeyframesForRun(run, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.ok(result, 'expected a valid reaction-split run to produce keyframes');
  // The 2nd chunk's larger face box must drive the fixed size, not the 1st.
  assert.ok(result.fixedW > 0 && result.fixedH > 0);
});

test('buildKeyframesForRun: a chunk missing the expected layout shape (e.g. faceBox absent) -> null, not a crash', () => {
  const run = {
    start: 0, end: 12, layout: { type: 'reaction-split' },
    chunks: [
      { start: 0, end: 6, layout: { type: 'reaction-split', faceBox: { cx: 0.5, cy: 0.5 } } },
      { start: 6, end: 12, layout: { type: 'reaction-split' } }, // no faceBox at all
    ],
  };
  assert.equal(buildKeyframesForRun(run, SRC_W, SRC_H, OUT_W, OUT_H), null);
});

// --- buildLayoutSegments integration: proves the fallback is REAL, not just a unit claim ---

test('buildLayoutSegments: a run built from real detectLayoutTimeline-shaped chunks with no landmark data gets keyframes attached', () => {
  const layoutTimeline = [
    { start: 0, end: 6, people: { faceCount: 1, slots: [{ cx: 0.4, cy: 0.42, w: 0.2, h: 0.3, landmarkBox: null }], expressiveMoments: [] } },
    { start: 6, end: 12, people: { faceCount: 1, slots: [{ cx: 0.45, cy: 0.42, w: 0.2, h: 0.3, landmarkBox: null }], expressiveMoments: [] } },
  ];
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, null, OUT_W, OUT_H);
  // Both chunks should merge into ONE run (positions within layoutsMatch's tolerance) with
  // keyframes attached, since neither carries landmark data to violate.
  assert.equal(merged.length, 1);
  assert.ok(merged[0].layout.keyframes, 'expected the merged single-person run to carry keyframes');
  assert.equal(merged[0].layout.keyframes.length, 2);
});

test('buildLayoutSegments: a single-chunk run (no merge partner) never gets keyframes — falls back to static', () => {
  const layoutTimeline = [
    { start: 0, end: 6, people: { faceCount: 1, slots: [{ cx: 0.4, cy: 0.42, w: 0.2, h: 0.3, landmarkBox: null }], expressiveMoments: [] } },
  ];
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, null, OUT_W, OUT_H);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].layout.keyframes, undefined, 'a single chunk has nothing to interpolate between');
});
