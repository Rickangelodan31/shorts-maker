// Pure crop/scale geometry, shared by effects.js (which needs it to VALIDATE a proposed
// face crop against landmarks before finalizing a layout plan) and render.js (which needs
// it to actually build the ffmpeg filter graph). Keeping this in one place means effects.js
// doesn't have to depend on render.js (or vice versa) just for box math — see the
// architecture-layers note in the project plan: effects.js decides layout, render.js is
// purely mechanical, and both need the same crop-rect arithmetic to agree on what a "valid"
// crop even is.

const OUT_W = 1080;
const OUT_H = 1920;

function evenify(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

// Computes a crop box (w,h,x,y), in source pixels, that matches targetAR, centered on
// (cx,cy) (normalized 0..1).
function cropBoxFor(srcW, srcH, cx, cy, targetAR) {
  const srcAR = srcW / srcH;
  let w, h;
  if (srcAR > targetAR) {
    h = srcH;
    w = h * targetAR;
  } else {
    w = srcW;
    h = w / targetAR;
  }
  w = evenify(w);
  h = evenify(h);
  let x = Math.round(cx * srcW - w / 2);
  let y = Math.round(cy * srcH - h / 2);
  x = Math.max(0, Math.min(srcW - w, x));
  y = Math.max(0, Math.min(srcH - h, y));
  return { w, h, x, y };
}

// Like cropBoxFor, but sized to comfortably contain a specific normalized region
// {cx,cy,w,h} (plus marginFrac extra padding) rather than just centering on a point —
// used to frame a small facecam overlay tightly, or a content region loosely.
function cropBoxForRegion(srcW, srcH, region, targetAR, marginFrac = 0.25) {
  let desiredW = region.w * srcW * (1 + marginFrac);
  let desiredH = region.h * srcH * (1 + marginFrac);

  if (desiredW / desiredH > targetAR) {
    desiredH = desiredW / targetAR;
  } else {
    desiredW = desiredH * targetAR;
  }
  if (desiredW > srcW) {
    desiredW = srcW;
    desiredH = desiredW / targetAR;
  }
  if (desiredH > srcH) {
    desiredH = srcH;
    desiredW = desiredH * targetAR;
  }

  const w = evenify(desiredW);
  const h = evenify(desiredH);
  let x = Math.round(region.cx * srcW - w / 2);
  let y = Math.round(region.cy * srcH - h / 2);
  x = Math.max(0, Math.min(srcW - w, x));
  y = Math.max(0, Math.min(srcH - h, y));
  return { w, h, x, y };
}

// Shared between effects.js (which validates a face crop against landmarks BEFORE
// finalizing a layout) and render.js (which actually builds the crop). These must be the
// SAME values in both places — if effects.js validates margin X but render.js then builds
// the crop with a different hardcoded margin, the crop that actually gets rendered was
// never the one that was checked. Index 0 is the default (tightest/most "zoomed in" on the
// reactor); later entries are progressively wider fallbacks tried only if the tight crop
// would cut off part of the face.
const FACE_CROP_MARGIN_STEPS = [0.15, 0.35, 0.6, 1.0];
// Content (the video being reacted to) should fill its region edge-to-edge with minimal
// extra padding — the whole point is for it to read clearly, not add margin around it.
const CONTENT_CROP_MARGIN = 0.05;
// The small picture-in-picture face inset's aspect ratio (reaction-inset layout) — shared
// so effects.js's crop-validation checks the exact same AR render.js will actually crop to.
const INSET_FACE_AR = 0.75;

module.exports = {
  OUT_W, OUT_H, evenify, cropBoxFor, cropBoxForRegion,
  FACE_CROP_MARGIN_STEPS, CONTENT_CROP_MARGIN, INSET_FACE_AR,
};
