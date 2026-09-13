// Tests for plan doc M7 (AI Editorial Upgrade): the piecewise-linear interpolation math
// backing continuous subject tracking. buildPiecewiseLinearExpr must be valid, syntactically
// correct ffmpeg expression syntax — this is verified here by actually EVALUATING the
// generated string (via a tiny if/lt-to-JS-ternary shim, not a parallel reimplementation) and
// checking it agrees with interpolateAt, the plain-JS reference for the same semantics.
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPiecewiseLinearExpr, interpolateAt, buildAnimatedCropExprs } = require('../src/geometry');

// Evaluates a generated ffmpeg expression (only ever containing if/lt/arithmetic per
// buildPiecewiseLinearExpr's own output shape) as real JS, by mapping ffmpeg's `if(cond,a,b)`
// and `lt(a,b)` to actual JS functions. This exercises the ACTUAL generated string, not a
// second hand-written interpolation implementation.
function evalFfmpegExpr(expr, t) {
  // `if` is a reserved word and can't be a Function parameter name, so the generated
  // expression's `if(` calls are aliased to `iff(` before evaluating — a pure text
  // substitution, not a reimplementation of the interpolation logic itself.
  const jsExpr = expr.replace(/\bif\(/g, 'iff(');
  // eslint-disable-next-line no-new-func
  const fn = new Function('t', 'iff', 'lt', `return ${jsExpr};`);
  return fn(t, (cond, a, b) => (cond ? a : b), (a, b) => a < b);
}

test('interpolateAt: constant before the first keyframe', () => {
  const kf = [{ t: 5, value: 10 }, { t: 10, value: 20 }];
  assert.equal(interpolateAt(kf, 0), 10);
  assert.equal(interpolateAt(kf, 5), 10);
});

test('interpolateAt: constant after the last keyframe', () => {
  const kf = [{ t: 5, value: 10 }, { t: 10, value: 20 }];
  assert.equal(interpolateAt(kf, 10), 20);
  assert.equal(interpolateAt(kf, 999), 20);
});

test('interpolateAt: linear between two keyframes', () => {
  const kf = [{ t: 0, value: 0 }, { t: 10, value: 100 }];
  assert.equal(interpolateAt(kf, 5), 50);
  assert.equal(interpolateAt(kf, 2.5), 25);
});

test('interpolateAt: correct segment picked among 3+ keyframes', () => {
  const kf = [{ t: 0, value: 0 }, { t: 10, value: 100 }, { t: 20, value: 50 }];
  assert.equal(interpolateAt(kf, 15), 75); // between kf[1] and kf[2]: 100 -> 50
  assert.equal(interpolateAt(kf, 5), 50); // between kf[0] and kf[1]: 0 -> 100
});

test('interpolateAt: a single keyframe is a constant everywhere', () => {
  const kf = [{ t: 5, value: 42 }];
  assert.equal(interpolateAt(kf, 0), 42);
  assert.equal(interpolateAt(kf, 100), 42);
});

test('interpolateAt: no keyframes -> 0, never throws', () => {
  assert.equal(interpolateAt([], 5), 0);
  assert.equal(interpolateAt(null, 5), 0);
});

test('buildPiecewiseLinearExpr: generated ffmpeg expression evaluates identically to interpolateAt across many keyframes and sample points', () => {
  const kf = [{ t: 0, value: 100 }, { t: 3, value: 400 }, { t: 6, value: 150 }, { t: 9, value: 700 }];
  const expr = buildPiecewiseLinearExpr(kf);
  for (const t of [-1, 0, 1.5, 3, 4.5, 6, 7.5, 9, 20]) {
    const expected = interpolateAt(kf, t);
    const actual = evalFfmpegExpr(expr, t);
    assert.ok(Math.abs(actual - expected) < 1e-6, `t=${t}: expected ${expected}, got ${actual} from expr`);
  }
});

test('buildPiecewiseLinearExpr: single keyframe produces a bare constant, no if/lt', () => {
  const expr = buildPiecewiseLinearExpr([{ t: 0, value: 42 }]);
  assert.equal(expr, '42.0000');
});

test('buildPiecewiseLinearExpr: empty input produces a safe constant, never throws', () => {
  assert.equal(buildPiecewiseLinearExpr([]), '0');
  assert.equal(buildPiecewiseLinearExpr(null), '0');
});

test('buildPiecewiseLinearExpr: never emits scientific notation or NaN (would break ffmpeg\'s expression parser)', () => {
  const expr = buildPiecewiseLinearExpr([{ t: 0.0000001, value: 1e-8 }, { t: 5, value: 999999 }]);
  assert.ok(!/e[+-]/i.test(expr), `expression must not contain scientific notation: ${expr}`);
  assert.ok(!/nan/i.test(expr), `expression must not contain NaN: ${expr}`);
});

test('buildAnimatedCropExprs: produces xExpr/yExpr that reproduce each keyframe\'s own clamped position at its own t', () => {
  const srcW = 1920, srcH = 1080, w = 600, h = 1080;
  const keyframes = [{ t: 0, cx: 0.3, cy: 0.5 }, { t: 3, cx: 0.7, cy: 0.5 }];
  const { xExpr, yExpr } = buildAnimatedCropExprs(keyframes, srcW, srcH, w, h);
  const expectedX0 = Math.max(0, Math.min(srcW - w, 0.3 * srcW - w / 2));
  const expectedX1 = Math.max(0, Math.min(srcW - w, 0.7 * srcW - w / 2));
  assert.ok(Math.abs(evalFfmpegExpr(xExpr, 0) - expectedX0) < 1e-3);
  assert.ok(Math.abs(evalFfmpegExpr(xExpr, 3) - expectedX1) < 1e-3);
  // y is identical at both keyframes (cy unchanged) -> yExpr must be constant across t.
  assert.ok(Math.abs(evalFfmpegExpr(yExpr, 0) - evalFfmpegExpr(yExpr, 3)) < 1e-6);
});

test('buildAnimatedCropExprs: clamps a near-edge position exactly like cropBoxFor\'s own clamp', () => {
  const srcW = 1920, srcH = 1080, w = 600, h = 1080;
  const keyframes = [{ t: 0, cx: 0.01, cy: 0.5 }]; // far left -> must clamp to x=0, not go negative
  const { xExpr } = buildAnimatedCropExprs(keyframes, srcW, srcH, w, h);
  assert.equal(evalFfmpegExpr(xExpr, 0), 0);
});
