// Tests for facedetect.js's mouth-openness helper (Component 5 of the plan doc — the
// speakingScore signal). facedetect.js has no prior test coverage at all, so this covers the
// one pure, easily-testable piece: the mouth-aspect-ratio-like proxy computed from face-api
// landmark points. The rest of the speakingScore pipeline (variance aggregation, confidence
// gating) lives inside detectPeopleInWindow, which needs a real video frame + face-api model
// to exercise — out of scope for a fast unit test, same as the rest of this file's detection
// logic.
const test = require('node:test');
const assert = require('node:assert/strict');

const { mouthOpenness, isCornerAnchoredOverlay } = require('../src/facedetect');

// A minimal fake landmarks object — mouthOpenness only calls .getMouth(), returning the
// 20-point outer+inner lip contour face-api provides.
function fakeLandmarks(points) {
  return { getMouth: () => points };
}

test('mouthOpenness: a closed mouth (small vertical span, wide horizontal span) scores low', () => {
  const closed = fakeLandmarks([
    { x: 40, y: 100 }, { x: 60, y: 98 }, { x: 80, y: 100 }, // top lip, barely curved
    { x: 60, y: 102 }, // bottom lip, almost touching top
    { x: 40, y: 101 }, { x: 80, y: 101 },
  ]);
  const ratio = mouthOpenness(closed);
  assert.ok(ratio < 0.2, `expected a low openness ratio for a closed mouth, got ${ratio}`);
});

test('mouthOpenness: an open mouth (large vertical span relative to width) scores high', () => {
  const open = fakeLandmarks([
    { x: 40, y: 90 }, { x: 60, y: 88 }, { x: 80, y: 90 }, // top lip
    { x: 60, y: 130 }, // bottom lip, far below
    { x: 40, y: 100 }, { x: 80, y: 100 },
  ]);
  const ratio = mouthOpenness(open);
  assert.ok(ratio > 0.5, `expected a high openness ratio for an open mouth, got ${ratio}`);
});

test('mouthOpenness: openness ratio increases monotonically as the mouth opens wider', () => {
  const widthPts = (topY, botY) => [
    { x: 40, y: topY }, { x: 60, y: topY - 2 }, { x: 80, y: topY },
    { x: 60, y: botY },
    { x: 40, y: (topY + botY) / 2 }, { x: 80, y: (topY + botY) / 2 },
  ];
  const slightlyOpen = mouthOpenness(fakeLandmarks(widthPts(100, 108)));
  const wideOpen = mouthOpenness(fakeLandmarks(widthPts(100, 140)));
  assert.ok(wideOpen > slightlyOpen);
});

test('mouthOpenness: zero-width degenerate contour does not throw or divide by zero into Infinity', () => {
  const degenerate = fakeLandmarks([{ x: 50, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 105 }]);
  const ratio = mouthOpenness(degenerate);
  assert.ok(Number.isFinite(ratio));
});

// Tests for isCornerAnchoredOverlay — the corner-anchoring signal added to
// detectReactionComposite's CV-fallback confidence score. Regression case: a real energetic
// reactor (job 9ec2078a8e44f37a, an IShowSpeed-style facecam-over-gameplay clip) was
// confidently, repeatedly detected in the same bottom-left corner (agreementFrac=0.89,
// spreadMax=0.027, both comfortably inside the existing gates) but the old position-stability
// -only score (0.488) still fell short of the 0.6 cv-fallback threshold, so the composite was
// silently discarded in favor of a plain single-person crop.
test('isCornerAnchoredOverlay: a small box flush against two edges (a corner overlay) qualifies', () => {
  // Roughly the diagnosed real-world box: left+bottom edges, ~23% of frame area.
  assert.equal(isCornerAnchoredOverlay(0, 0.42, 0.4, 1.0), true);
});

test('isCornerAnchoredOverlay: a centered box (a stationary talking-head shot) does not qualify', () => {
  // This is the exact case the CV-fallback path must stay conservative against — a single
  // motionless tripod-mounted talking head must never be mistaken for an overlay.
  assert.equal(isCornerAnchoredOverlay(0.25, 0.1, 0.75, 0.9), false);
});

test('isCornerAnchoredOverlay: a near-full-frame box does not qualify even if it touches an edge', () => {
  assert.equal(isCornerAnchoredOverlay(0, 0, 0.95, 0.95), false);
});

test('isCornerAnchoredOverlay: touching only a horizontal edge (not also a vertical one) does not qualify', () => {
  assert.equal(isCornerAnchoredOverlay(0, 0.3, 0.3, 0.7), false);
});
