// End-to-end regression test for the reaction/content composition engine.
//
// The unit tests in composition.test.js only check the crop-vs-fit DECISION math in
// isolation. They never prove that the reaction panel and the content panel actually pull
// pixels from two different regions of the source video — a bug where both panels show the
// same region (e.g. faceBox accidentally reused as contentBox, or the wrong stream label
// mapped in the ffmpeg filter graph) would pass every one of those tests and still ship a
// broken video. This test renders a REAL synthetic video through the REAL production
// functions (buildLayoutSegments -> render.js:renderSegmented, i.e. exactly what
// pipeline.js calls) and samples actual output pixels to prove:
//   1. reaction-split: TOP panel == the reactor's source region, BOTTOM == the content region.
//   2. reaction-inset: the content background == the content region, not the reactor's.
//   3. a full-screen content-only "fit" layout preserves BOTH halves of the source (nothing
//      cropped away), which is the entire point of choosing fit over crop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderSegmented } = require('../src/render');
const { buildLayoutSegments, buildContentOnlyLayout } = require('../src/effects');
const { FFMPEG_BIN } = require('../src/ffutil');

const SRC_W = 1920, SRC_H = 1080;
const OUT_W = 1080, OUT_H = 1920;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-e2e-'));
test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

// Builds a 2s source video with two UNMISTAKABLY different halves: pure red on the left
// (stands in for "the reactor"), pure green on the right (stands in for "the content").
// Pixel sampling below only has to tell red from green, so flat colors are deliberate —
// anything fancier (text, gradients) would make the pass/fail check fuzzier, not stronger.
function makeSplitSourceVideo() {
  const outPath = path.join(workDir, 'src_left_red_right_green.mp4');
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=${SRC_W / 2}x${SRC_H}:d=2`,
    '-f', 'lavfi', '-i', `color=c=green:s=${SRC_W / 2}x${SRC_H}:d=2`,
    '-f', 'lavfi', '-i', 'sine=duration=2',
    '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]',
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', outPath,
  ], { stdio: 'pipe' });
  return outPath;
}

// Content source for the reaction-inset test: mostly green, with a small red patch at the
// exact facecamBox position — realistic shape for a genuine overlay-style source (unlike
// the hard left/right split above, a small-area facecam over full-frame content doesn't
// cleanly bisect the frame, so the source itself must look like that: overlay, not split).
function makeOverlaySourceVideo(facecamPx) {
  const outPath = path.join(workDir, 'src_green_with_red_corner.mp4');
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=green:s=${SRC_W}x${SRC_H}:d=2`,
    '-f', 'lavfi', '-i', `color=c=red:s=${facecamPx.w}x${facecamPx.h}:d=2`,
    '-f', 'lavfi', '-i', 'sine=duration=2',
    '-filter_complex', `[0:v][1:v]overlay=${facecamPx.x}:${facecamPx.y}[v]`,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', outPath,
  ], { stdio: 'pipe' });
  return outPath;
}

// Downscales one crop of the output to a single pixel (ffmpeg's scale averages/blends the
// source area into it) and reads back its raw RGB bytes — a cheap, dependency-free way to
// get "what color is this region, roughly" without a PNG decoder.
function averageColor(videoPath, cropFilter) {
  const raw = execFileSync(FFMPEG_BIN, [
    '-y', '-i', videoPath,
    '-vf', `${cropFilter},scale=1:1:flags=area`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  return { r: raw[0], g: raw[1], b: raw[2] };
}

function isRedDominant(c) { return c.r > 120 && c.r > c.g + 60 && c.r > c.b + 60; }
function isGreenDominant(c) { return c.g > 120 && c.g > c.r + 60 && c.g > c.b + 60; }

test('reaction-split: TOP panel is the reactor region, BOTTOM panel is the content region (not the same region twice)', async () => {
  const srcPath = makeSplitSourceVideo();
  const outPath = path.join(workDir, 'out_reaction_split.mp4');

  // facecamBox marks the LEFT (red) half as the reactor's region — exactly the shape a
  // genuine side-by-side reaction+content source produces. No real face is detectable in a
  // flat-color synthetic source, so `people` is left empty on purpose: this exercises
  // buildReactionLayout's "no face re-detected" fallback path (faceBox derived from
  // facecamBox itself), which is a real, common runtime case, not a contrived one.
  const reactionComposite = {
    isReactionComposite: true,
    facecamBox: { cx: 0.25, cy: 0.5, w: 0.5, h: 1 },
    confidence: 0.9, source: 'vision-llm',
  };
  const people = { faceCount: 0, slots: [], expressiveMoments: [] };
  const layoutTimeline = [{ start: 0, end: 2, people }];

  // The REAL decision chain (pickBaseLayout -> buildReactionLayout -> crop validation) —
  // not a hand-built layout object — so a bug in that chain would actually be caught here.
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, reactionComposite, OUT_W, OUT_H);
  assert.equal(merged.length, 1);
  const layout = merged[0].layout;
  assert.equal(layout.type, 'reaction-split', `expected reaction-split, got ${layout.type}`);
  // The invariant this whole test exists to prove, checked at the DATA level before we even
  // render: face and content must be different regions, and content must be on the side the
  // facecamBox did NOT claim.
  assert.notDeepEqual(layout.faceBox, layout.contentBox);
  assert.ok(layout.faceBox.cx < 0.5, 'faceBox should sit in the left (reactor) half');
  assert.ok(layout.contentBox.cx > 0.5, 'contentBox should sit in the right (content) half');

  await renderSegmented({
    inputPath: srcPath, srcW: SRC_W, srcH: SRC_H,
    segments: [{ start: 0, end: 2, rate: 1, layout }],
    captionsAssPath: null, outputPath: outPath, outW: OUT_W, outH: OUT_H,
  });
  assert.ok(fs.existsSync(outPath));

  const top = averageColor(outPath, `crop=iw:ih*0.4:0:ih*0.1`); // avoid the exact vstack seam
  const bottom = averageColor(outPath, `crop=iw:ih*0.4:0:ih*0.55`);
  assert.ok(isRedDominant(top), `expected TOP panel to be the reactor (red) region, got rgb(${top.r},${top.g},${top.b})`);
  assert.ok(isGreenDominant(bottom), `expected BOTTOM panel to be the content (green) region, got rgb(${bottom.r},${bottom.g},${bottom.b})`);

  // Sensitive probe at the LEFT EDGE of the content band specifically — this is where the
  // reactor's excluded region sits, so it's where a crop that "contains the content region
  // plus margin" but isn't actually CLAMPED to that region's own footprint would bleed
  // reactor (red) pixels into the content panel. Averaging the full band width (above) can
  // dilute a real bleed below the red/green detection threshold, so this checks the exact
  // strip where it would show up.
  const bottomLeftEdge = averageColor(outPath, `crop=iw*0.15:ih*0.3:0:ih*0.6`);
  assert.ok(
    !isRedDominant(bottomLeftEdge),
    `content panel's left edge is bleeding reactor (red) pixels: rgb(${bottomLeftEdge.r},${bottomLeftEdge.g},${bottomLeftEdge.b})`
  );
});

test('reaction-inset: content fills the background, the reactor is only the small overlay (not the whole frame)', async () => {
  // A genuine small-corner-overlay source: mostly green content, with a small red patch at
  // the EXACT pixel position the facecamBox below claims. This (not a hard left/right
  // split) is the realistic shape for this scenario — contentRegionExcludingFacecam's
  // static band-exclusion only removes a band no bigger than the facecam box itself, so a
  // small facecam can't cleanly bisect a big flat split; it CAN cleanly separate itself from
  // a background that's uniform outside its own small patch, which is what an overlay
  // actually looks like.
  const facecamBox = { cx: 0.08, cy: 0.85, w: 0.15, h: 0.2 }; // area well under FACECAM_AREA_INSET_THRESHOLD
  const facecamPx = {
    x: Math.round((facecamBox.cx - facecamBox.w / 2) * SRC_W),
    y: Math.round((facecamBox.cy - facecamBox.h / 2) * SRC_H),
    w: Math.round(facecamBox.w * SRC_W),
    h: Math.round(facecamBox.h * SRC_H),
  };
  const srcPath = makeOverlaySourceVideo(facecamPx);
  const outPath = path.join(workDir, 'out_reaction_inset.mp4');

  const reactionComposite = { isReactionComposite: true, facecamBox, confidence: 0.9, source: 'vision-llm' };
  const people = { faceCount: 0, slots: [], expressiveMoments: [] };
  const layoutTimeline = [{ start: 0, end: 2, people }];
  const merged = buildLayoutSegments(layoutTimeline, SRC_W, SRC_H, reactionComposite, OUT_W, OUT_H);
  const layout = merged[0].layout;
  assert.equal(layout.type, 'reaction-inset', `expected reaction-inset, got ${layout.type}`);

  await renderSegmented({
    inputPath: srcPath, srcW: SRC_W, srcH: SRC_H,
    segments: [{ start: 0, end: 2, rate: 1, layout }],
    captionsAssPath: null, outputPath: outPath, outW: OUT_W, outH: OUT_H,
  });

  // Sample well away from the inset PiP (bottom-right) — the rest of the frame is the
  // content background and must be green, not red.
  const topLeft = averageColor(outPath, `crop=iw*0.5:ih*0.3:0:0`);
  assert.ok(isGreenDominant(topLeft), `expected content background to dominate, got rgb(${topLeft.r},${topLeft.g},${topLeft.b})`);
  const inset = averageColor(outPath, `crop=iw*0.3:ih*0.15:iw*0.55:ih*0.8`);
  assert.ok(isRedDominant(inset), `expected the reactor inset (bottom-right PiP) to be red, got rgb(${inset.r},${inset.g},${inset.b})`);
});

test('buildContentOnlyLayout fit mode: full-screen content preserves BOTH halves of the source (nothing cropped away)', async () => {
  const srcPath = makeSplitSourceVideo();
  const outPath = path.join(workDir, 'out_content_fit.mp4');

  // Whole 16:9 frame as the "content" region (e.g. a full-screen content-beat cutaway) — a
  // straight cover-crop into 9:16 would have to discard most of the width and could lose an
  // entire half's color; fit must keep both halves visible somewhere in the frame.
  const contentBox = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  const layout = buildContentOnlyLayout(contentBox, SRC_W, SRC_H, OUT_W, OUT_H);
  assert.equal(layout.type, 'fit', `expected fit for a full 16:9 region into 9:16, got ${layout.type}`);

  await renderSegmented({
    inputPath: srcPath, srcW: SRC_W, srcH: SRC_H,
    segments: [{ start: 0, end: 2, rate: 1, layout }],
    captionsAssPath: null, outputPath: outPath, outW: OUT_W, outH: OUT_H,
  });

  // The contained (non-blurred) foreground sits centered; sample its left/right thirds.
  const left = averageColor(outPath, `crop=iw*0.25:ih*0.2:iw*0.1:ih*0.4`);
  const right = averageColor(outPath, `crop=iw*0.25:ih*0.2:iw*0.65:ih*0.4`);
  assert.ok(isRedDominant(left), `expected left side of the preserved content to be red, got rgb(${left.r},${left.g},${left.b})`);
  assert.ok(isGreenDominant(right), `expected right side of the preserved content to be green, got rgb(${right.r},${right.g},${right.b})`);
});
