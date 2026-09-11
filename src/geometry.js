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

// Cover-crop (fill targetAR, discard whatever doesn't fit) computed STRICTLY WITHIN a
// region's own footprint — the crop can shrink one of the region's dimensions, but can
// NEVER grow past the region's own edges the way cropBoxForRegion (below) deliberately
// does. That growth is exactly right for a face box (there's no boundary to respect —
// growing outward just adds comfortable headroom/shoulders from the same reactor's own
// footage) but is wrong for a "content" region carved out by contentRegionExcludingFacecam:
// that region's edge IS the boundary with the reactor's excluded territory, so a crop that
// grows past it bleeds the reactor's pixels into the content panel. This is also the exact
// math decideCropOrFit's retainedFraction already assumes (a shrink-to-fit cover crop), so
// using this here keeps the crop-vs-fit DECISION and the crop that actually gets rendered
// consistent with each other.
function regionBoundedCropBox(srcW, srcH, region, targetAR) {
  const regionPxW = region.w * srcW;
  const regionPxH = region.h * srcH;
  const regionX = region.cx * srcW - regionPxW / 2;
  const regionY = region.cy * srcH - regionPxH / 2;
  const regionAR = regionPxW / regionPxH;

  let w, h;
  if (regionAR > targetAR) {
    h = regionPxH;
    w = h * targetAR;
  } else {
    w = regionPxW;
    h = w / targetAR;
  }
  w = evenify(Math.min(w, regionPxW));
  h = evenify(Math.min(h, regionPxH));

  let x = Math.round(region.cx * srcW - w / 2);
  let y = Math.round(region.cy * srcH - h / 2);
  // Clamp inside the REGION's own bounds first — this is the actual invariant — then inside
  // the source frame as a final safety net.
  x = Math.max(regionX, Math.min(regionX + regionPxW - w, x));
  y = Math.max(regionY, Math.min(regionY + regionPxH - h, y));
  x = Math.max(0, Math.min(srcW - w, Math.round(x)));
  y = Math.max(0, Math.min(srcH - h, Math.round(y)));
  return { w, h, x, y };
}

// Like cropBoxFor, but sized to comfortably contain a specific normalized region
// {cx,cy,w,h} (plus marginFrac extra padding) rather than just centering on a point —
// used to frame a small facecam overlay tightly. NEVER use this for a "content" region
// carved out by contentRegionExcludingFacecam — it grows past the region's own edges to
// reach targetAR, which for a content region means bleeding into the reactor's excluded
// territory (see regionBoundedCropBox above, which is what content framing must use instead).
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
// The small picture-in-picture face inset's aspect ratio (reaction-inset layout) — shared
// so effects.js's crop-validation checks the exact same AR render.js will actually crop to.
const INSET_FACE_AR = 0.75;

// A cover-crop (fill the target frame, cut off whatever doesn't fit) and a contain-fit
// (show everything, pad/blur what doesn't fit) are the only two honest options once a
// region's aspect ratio doesn't match the target — there is no crop that does both. This
// is the "how much would cropping destroy" measurement the composition decision is based
// on: the fraction of the region's OWN pixels that would survive a cover-crop to targetAR.
// Symmetric in regionAR/targetAR (a region far wider OR far taller than the target both
// lose a lot), always in (0, 1], 1.0 only when the aspect ratios already match exactly.
function coverCropRetainedFraction(regionAR, targetAR) {
  if (!regionAR || !targetAR) return 1;
  return Math.min(regionAR / targetAR, targetAR / regionAR);
}

// Above this fraction of information LOST to a cover-crop, prefer a content-preserving fit
// (contain + blurred background) over cropping. 0.30 was picked empirically: a 16:9 region
// going into a 9:16 band loses ~68% of its width (well past the threshold, so it fits), while
// a region already close to the target AR (e.g. an 8:9 half-panel into a ~1.1 AR band) loses
// well under 30% (so it still crops, since the loss is barely visible).
const CONTENT_FIT_LOSS_THRESHOLD = parseFloat(process.env.CONTENT_FIT_LOSS_THRESHOLD || '0.30');

// The crop-vs-fit decision itself, factored out so effects.js (composition) and any
// debug/reporting code share the exact same math instead of each re-deriving it.
// region: normalized center-based {w,h} (cx/cy irrelevant to the AR math). Returns
// {mode:'crop'|'fit', retainedFraction, lossFraction} — retainedFraction is surfaced in
// debug output so a human can see WHY a given clip chose to fit instead of crop.
function decideCropOrFit(region, srcW, srcH, targetAR, threshold = CONTENT_FIT_LOSS_THRESHOLD) {
  const regionAR = (region.w * srcW) / (region.h * srcH);
  const retainedFraction = coverCropRetainedFraction(regionAR, targetAR);
  const lossFraction = 1 - retainedFraction;
  return { mode: lossFraction > threshold ? 'fit' : 'crop', retainedFraction, lossFraction };
}

// Literal (no aspect-ratio matching) pixel rectangle for a normalized center-based
// {cx,cy,w,h} region — used by the content-preserving "fit" path, which crops to exactly
// the detected/requested region and THEN contains/pads it to the target canvas, rather
// than cropBoxFor's max-size AR-matched box (which is what a cover-crop needs, not a fit).
function regionToPixelBox(srcW, srcH, region) {
  const w = evenify(Math.max(2, Math.min(srcW, region.w * srcW)));
  const h = evenify(Math.max(2, Math.min(srcH, region.h * srcH)));
  let x = Math.round(region.cx * srcW - w / 2);
  let y = Math.round(region.cy * srcH - h / 2);
  x = Math.max(0, Math.min(srcW - w, x));
  y = Math.max(0, Math.min(srcH - h, y));
  return { w, h, x, y };
}

module.exports = {
  OUT_W, OUT_H, evenify, cropBoxFor, cropBoxForRegion, regionBoundedCropBox,
  FACE_CROP_MARGIN_STEPS, INSET_FACE_AR,
  CONTENT_FIT_LOSS_THRESHOLD, coverCropRetainedFraction, decideCropOrFit, regionToPixelBox,
};
