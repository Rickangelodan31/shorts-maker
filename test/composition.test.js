// Tests for the content-preserving composition decision (geometry.js:decideCropOrFit and
// effects.js's use of it). These cover the concrete scenarios the reaction/content
// composition engine must get right: a reaction video's content region should crop only
// when little is lost, full-screen landscape content going vertical must never blindly
// center-crop, and a chunk with no detected face must never guess a crop.
const test = require('node:test');
const assert = require('node:assert/strict');

const { decideCropOrFit, CONTENT_FIT_LOSS_THRESHOLD } = require('../src/geometry');
const { pickBaseLayout, buildReactionLayout, buildContentOnlyLayout } = require('../src/effects');

const OUT_W = 1080;
const OUT_H = 1920;
const PORTRAIT_AR = OUT_W / OUT_H;

test('decideCropOrFit: matching aspect ratio never loses anything, always crops', () => {
  const region = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  const { mode, lossFraction } = decideCropOrFit(region, OUT_W, OUT_H, PORTRAIT_AR);
  assert.equal(mode, 'crop');
  assert.ok(lossFraction < 0.01);
});

// Spec TEST 10: full-screen 16:9 landscape content going into a 9:16 vertical output must
// not be blindly center-cropped — cropping to fill would discard ~68% of the frame width.
test('decideCropOrFit: full-frame 16:9 content into 9:16 output chooses fit, not crop', () => {
  const srcW = 1920, srcH = 1080;
  const region = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  const { mode, lossFraction } = decideCropOrFit(region, srcW, srcH, PORTRAIT_AR);
  assert.equal(mode, 'fit');
  assert.ok(lossFraction > CONTENT_FIT_LOSS_THRESHOLD);
});

// A near-square screen recording (4:3) still loses more than the threshold going vertical.
test('decideCropOrFit: 4:3 screen-recording content into 9:16 output chooses fit', () => {
  const srcW = 1600, srcH = 1200;
  const region = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  const { mode } = decideCropOrFit(region, srcW, srcH, PORTRAIT_AR);
  assert.equal(mode, 'fit');
});

// Spec TEST 1: a genuine half-frame reactor+content split — the content half's own aspect
// ratio (~0.89) is already reasonably close to the band it renders into (~1.125), so a
// crop only trims ~20% (headroom/legroom), which is an acceptable crop, not a fit.
test('decideCropOrFit: a half-frame content panel close to the target band AR still crops', () => {
  const srcW = 1920, srcH = 1080;
  const region = { cx: 0.75, cy: 0.5, w: 0.5, h: 1 }; // right half of a 16:9 frame
  const bandAR = OUT_W / (OUT_H / 2);
  const { mode, lossFraction } = decideCropOrFit(region, srcW, srcH, bandAR);
  assert.equal(mode, 'crop');
  assert.ok(lossFraction < CONTENT_FIT_LOSS_THRESHOLD);
});

test('buildContentOnlyLayout: chooses type=fit and preserves the source box for lossy content', () => {
  const contentBox = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  const layout = buildContentOnlyLayout(contentBox, 1920, 1080, OUT_W, OUT_H);
  assert.equal(layout.type, 'fit');
  assert.deepEqual(layout.box, contentBox);
});

test('buildContentOnlyLayout: chooses type=single (crop) when loss is acceptable', () => {
  const contentBox = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  // Source already close to the target AR -> cropping barely loses anything.
  const layout = buildContentOnlyLayout(contentBox, OUT_W, OUT_H, OUT_W, OUT_H);
  assert.equal(layout.type, 'single');
});

test('buildReactionLayout: wide side-by-side facecam box picks reaction-split (not inset)', () => {
  const srcW = 1920, srcH = 1080;
  const people = { faceCount: 1, slots: [{ cx: 0.25, cy: 0.5, w: 0.15, h: 0.3 }], expressiveMoments: [] };
  const reactionComposite = {
    isReactionComposite: true,
    facecamBox: { cx: 0.25, cy: 0.5, w: 0.5, h: 1 }, // left half of frame
    confidence: 0.8, source: 'vision-llm',
  };
  const layout = buildReactionLayout(people, srcW, srcH, reactionComposite, OUT_W, OUT_H);
  assert.equal(layout.type, 'reaction-split');
  assert.ok(layout.contentBox);
  assert.ok(layout.contentFraming);
});

test('buildReactionLayout: small corner overlay facecam with wide content picks fit for content', () => {
  const srcW = 1920, srcH = 1080;
  const people = { faceCount: 1, slots: [{ cx: 0.85, cy: 0.85, w: 0.15, h: 0.2 }], expressiveMoments: [] };
  const reactionComposite = {
    isReactionComposite: true,
    facecamBox: { cx: 0.85, cy: 0.85, w: 0.2, h: 0.2 }, // small bottom-right overlay
    confidence: 0.8, source: 'vision-llm',
  };
  const layout = buildReactionLayout(people, srcW, srcH, reactionComposite, OUT_W, OUT_H);
  assert.equal(layout.type, 'reaction-inset'); // small facecam area -> PiP variant
  assert.equal(layout.contentFraming.mode, 'fit'); // wide leftover content region -> preserve it
});

// Spec TEST 8 / fallback rule: no face detected anywhere in a chunk must never produce a
// guessed crop — the safest fallback is to preserve everything, not zoom in on a made-up point.
test('pickBaseLayout: faceCount=0 always falls back to fit, never a guessed crop', () => {
  const people = { faceCount: 0, slots: [{ cx: 0.5, cy: 0.42, w: 0.3, h: 0.3 }], expressiveMoments: [] };
  const layout = pickBaseLayout(people, 1920, 1080, null, OUT_W, OUT_H);
  assert.equal(layout.type, 'fit');
});

test('pickBaseLayout: a real single detected face still gets a normal centered crop', () => {
  const people = { faceCount: 1, slots: [{ cx: 0.5, cy: 0.42, w: 0.3, h: 0.3 }], expressiveMoments: [] };
  const layout = pickBaseLayout(people, 1920, 1080, null, OUT_W, OUT_H);
  assert.equal(layout.type, 'single');
});
