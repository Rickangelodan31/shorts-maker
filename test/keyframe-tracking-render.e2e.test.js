// End-to-end regression test for plan doc M7 (continuous subject tracking): proves the
// ANIMATED crop actually pans in a real ffmpeg render, not just that the expression math is
// correct in isolation (see geometry-interpolation.test.js for that). A source video has a
// small red marker that jumps from the LEFT side (t<1s) to the RIGHT side (t>=1s) — a static
// crop built from only the first keyframe would have the marker drift entirely out of frame
// by the second half; a correctly panning crop keeps it centered at both sample times.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderSegmented } = require('../src/render');
const { FFMPEG_BIN } = require('../src/ffutil');

const SRC_W = 1920, SRC_H = 1080;
const OUT_W = 1080, OUT_H = 1920;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyframe-tracking-e2e-'));
test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

function makeJumpingMarkerVideo() {
  const outPath = path.join(workDir, 'src_jumping_marker.mp4');
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=black:s=${SRC_W}x${SRC_H}:d=2`,
    '-f', 'lavfi', '-i', 'sine=duration=2',
    '-filter_complex',
    // A 200x200 red square at source x=500 for t in [0,1), then jumps to x=1300 for t in [1,2).
    "[0:v]drawbox=x=500:y=440:w=200:h=200:color=red:t=fill:enable='between(t,0,1)'," +
    "drawbox=x=1300:y=440:w=200:h=200:color=red:t=fill:enable='between(t,1,2)'[v]",
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', outPath,
  ], { stdio: 'pipe' });
  return outPath;
}

function averageColor(videoPath, atSec, cropFilter) {
  const raw = execFileSync(FFMPEG_BIN, [
    '-y', '-ss', String(atSec), '-i', videoPath,
    '-vf', `${cropFilter},scale=1:1:flags=area`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  return { r: raw[0], g: raw[1], b: raw[2] };
}

function isRedDominant(c) { return c.r > 120 && c.r > c.g + 60 && c.r > c.b + 60; }

test('animated single-layout crop pans to follow the keyframed position: marker stays centered at both t=0.1 and t=1.9', async () => {
  const srcPath = makeJumpingMarkerVideo();
  const outPath = path.join(workDir, 'out_panning.mp4');

  // cx for a marker centered at source x=600 (500+100 half-width) -> 600/1920 = 0.3125;
  // cx for x=1400 (1300+100) -> 1400/1920 ≈ 0.7292. Both comfortably away from source edges
  // so the crop's own edge-clamping never kicks in and confounds the result.
  const keyframes = [{ t: 0, cx: 0.3125, cy: 0.5 }, { t: 1, cx: 0.7292, cy: 0.5 }];
  const targetAR = OUT_W / OUT_H;
  const h = SRC_H;
  const w = Math.round(h * targetAR / 2) * 2; // even, matches cropBoxFor's own AR-fit math
  const layout = { type: 'single', slot: { cx: keyframes[0].cx, cy: 0.5 }, keyframes, keyframeSize: { w, h } };

  await renderSegmented({
    inputPath: srcPath, srcW: SRC_W, srcH: SRC_H,
    segments: [{ start: 0, end: 2, rate: 1, layout }],
    captionsAssPath: null, outputPath: outPath, outW: OUT_W, outH: OUT_H,
  });
  assert.ok(fs.existsSync(outPath));

  // Sample a centered horizontal band in the OUTPUT frame at both halves of the clip — if
  // the crop correctly panned to follow the marker, red should dominate the center at BOTH
  // times. A static (first-keyframe-only) crop would show red at t=0.1 but NOT at t=1.9
  // (the marker would have moved entirely out of that fixed crop window).
  const centerBand = `crop=iw*0.3:ih*0.15:iw*0.35:ih*0.425`;
  const early = averageColor(outPath, 0.1, centerBand);
  const late = averageColor(outPath, 1.9, centerBand);
  assert.ok(isRedDominant(early), `expected marker centered at t=0.1, got rgb(${early.r},${early.g},${early.b})`);
  assert.ok(isRedDominant(late), `expected marker STILL centered at t=1.9 (pan must follow it), got rgb(${late.r},${late.g},${late.b})`);
});

test('static crop (no keyframes) is unchanged: the SAME jump would leave the marker out of frame at t=1.9', async () => {
  // Negative control proving the test above is actually discriminating: using only the
  // first keyframe's position as a plain static crop must FAIL to show the marker at t=1.9
  // — this is what "byte-identical to pre-M7 behavior when keyframes are absent" looks like
  // rendered, and confirms the positive test isn't trivially passing regardless of panning.
  const srcPath = makeJumpingMarkerVideo();
  const outPath = path.join(workDir, 'out_static.mp4');
  const targetAR = OUT_W / OUT_H;
  const h = SRC_H;
  const w = Math.round(h * targetAR / 2) * 2;
  const layout = { type: 'single', slot: { cx: 0.3125, cy: 0.5 } }; // no keyframes -> static, today's exact path

  await renderSegmented({
    inputPath: srcPath, srcW: SRC_W, srcH: SRC_H,
    segments: [{ start: 0, end: 2, rate: 1, layout }],
    captionsAssPath: null, outputPath: outPath, outW: OUT_W, outH: OUT_H,
  });

  const centerBand = `crop=iw*0.3:ih*0.15:iw*0.35:ih*0.425`;
  const early = averageColor(outPath, 0.1, centerBand);
  const late = averageColor(outPath, 1.9, centerBand);
  assert.ok(isRedDominant(early), `sanity check: marker should still be centered at t=0.1, got rgb(${early.r},${early.g},${early.b})`);
  assert.ok(!isRedDominant(late), `sanity check failed: a static crop should NOT show the marker after it jumped, got rgb(${late.r},${late.g},${late.b})`);
});
