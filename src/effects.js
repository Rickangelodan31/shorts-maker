const { validateFaceCrop } = require('./facedetect');
const {
  OUT_W: DEFAULT_OUT_W, OUT_H: DEFAULT_OUT_H,
  evenify, cropBoxFor, cropBoxForRegion, FACE_CROP_MARGIN_STEPS, INSET_FACE_AR,
  decideCropOrFit,
} = require('./geometry');

const MIN_SEGMENT = 1.0;
const FACECAM_AREA_INSET_THRESHOLD = 0.12;
// Speaker/emotional-importance signal tuning (see plan doc Component 6) — every one of
// these degrades to today's exact original behavior when the underlying signal
// (speakingScore / emotionalImportance) is absent or low-confidence.
const REACTOR_SPEAKING_WEIGHT = parseFloat(process.env.REACTOR_SPEAKING_WEIGHT || '0.25');
const REACTOR_MIN_SPEAKING_CONFIDENCE = parseFloat(process.env.REACTOR_MIN_SPEAKING_CONFIDENCE || '0.5');
const REACTION_CUTAWAY_SPEAKER_PENALTY = parseFloat(process.env.REACTION_CUTAWAY_SPEAKER_PENALTY || '0.3');
const REACTION_CUTAWAY_SPEAKER_THRESHOLD = parseFloat(process.env.REACTION_CUTAWAY_SPEAKER_THRESHOLD || '0.6');
const REACTION_CUTAWAY_MIN_SPEAKING_CONFIDENCE = parseFloat(process.env.REACTION_CUTAWAY_MIN_SPEAKING_CONFIDENCE || '0.5');
const LAYOUT_EMOTIONAL_FIT_BIAS_THRESHOLD = parseFloat(process.env.LAYOUT_EMOTIONAL_FIT_BIAS_THRESHOLD || '0.7');
const LAYOUT_EMOTIONAL_FIT_SPAN_RELAX = parseFloat(process.env.LAYOUT_EMOTIONAL_FIT_SPAN_RELAX || '0.15');
const MIN_CONTENT_AREA_FRAC = parseFloat(process.env.MIN_CONTENT_AREA_FRAC || '0.35');
const MIN_COMPOSITE_CONFIDENCE = { 'vision-llm': 0.35, 'cv-fallback': 0.6 };
// A raw facecam-overlay estimate (from CV-fallback detection) is deliberately padded out
// generously so the CONTENT-exclusion band never clips into the reactor's face — but using
// that same padded box directly as the reactor's FRAMING box (when no fresh face was
// re-detected in a given chunk) is what made the reactor look small/zoomed-out with lots of
// background around them. Shrink it back down toward a face-sized box for framing purposes.
const FALLBACK_FACE_SHRINK = 1.8;
// Manually-edited 'single' crops carry an explicit size (unlike auto-generated ones, which
// always get the maximal AR-matching box via cropBoxFor) so a zoom nudge has something to
// act on. This is the default margin around that size when none is specified.
const DEFAULT_MANUAL_CROP_MARGIN = 0.15;

// Plan doc M4 — reaction-timeline tuning. The single BEST reaction moment (rank 0) is always
// eligible for a cutaway, exactly as before this milestone; these only govern whether
// additional moments beyond it are also allowed to become cutaways.
const MAX_REACTION_CUTAWAYS = parseInt(process.env.MAX_REACTION_CUTAWAYS || '2', 10);
const REACTION_BEAT_PROXIMITY_SEC = parseFloat(process.env.REACTION_BEAT_PROXIMITY_SEC || '8');
const REACTION_MOMENT_SIGNAL_THRESHOLD = parseFloat(process.env.REACTION_MOMENT_SIGNAL_THRESHOLD || '0.6');
const REACTION_CUTAWAY_MIN_SPACING_SEC = parseFloat(process.env.REACTION_CUTAWAY_MIN_SPACING_SEC || '4');

// Finds a single standout loud/energetic instant inside [absStart, absStart+length] of the
// full-video energy timeline. Returns null if nothing clearly stands out (so slow-mo is only
// applied "when needed", not on every clip).
function findDistinctPeak(energy, hopSec, absStart, length) {
  const startHop = Math.round(absStart / hopSec);
  const endHop = Math.min(energy.length, Math.round((absStart + length) / hopSec));
  if (endHop - startHop < 6) return null;

  let sum = 0;
  let peakHop = startHop;
  let peakVal = -Infinity;
  for (let h = startHop; h < endHop; h++) {
    sum += energy[h];
    if (energy[h] > peakVal) {
      peakVal = energy[h];
      peakHop = h;
    }
  }
  const avg = sum / (endHop - startHop);
  if (avg <= 0 || peakVal < avg * 1.4) return null;
  return { localT: peakHop * hopSec - absStart, value: peakVal };
}

// Decides the base (non-effect) layout for the whole clip from detected people.
//  - reaction/facecam composite (confidently classified)  -> reaction-split/reaction-inset
//  - 0/1 person -> single centered crop (or a full-frame "fit" if centering would clip them)
//  - 2 people   -> half/half split screen (podcast style)
//  - 3+ people  -> a group crop if everyone fits with room to spare, else a full-frame "fit"
//                  (blurred zoomed-out background) so nobody gets cropped out of frame
// outW/outH: target output canvas size — defaults to the app's standard 1080x1920 short,
// but a job may request any size (see pipeline.js job.options.outputWidth/outputHeight);
// every crop-fit decision below is relative to THIS aspect ratio, not a hardcoded one.
// `emotionalImportance` (optional, 0..1, whole-clip scalar from Stage 2 vision validation —
// see semantic.js:runVisionValidation): when high AND this is a 3+-person group moment,
// relaxes the group-crop span threshold so more cases stay wide (fit) rather than
// tight-cropping to a subset of the group. Applies uniformly across a clip's chunks (Stage
// 2 samples across the whole candidate window, not per-chunk) — a real granularity
// mismatch, noted rather than hidden. Omitting the param (existing call sites) reproduces
// today's exact 0.85 threshold.
function pickBaseLayout(people, srcW, srcH, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H, emotionalImportance = null, opts = {}) {
  if (reactionComposite?.isReactionComposite) {
    const threshold = MIN_COMPOSITE_CONFIDENCE[reactionComposite.source] ?? 0.5;
    if (reactionComposite.confidence >= threshold) {
      return buildReactionLayout(people, srcW, srcH, reactionComposite, outW, outH, opts);
    }
  }

  // No face anywhere in this chunk (detectPeopleInWindow's "nothing found" fallback still
  // hands back one fake centered slot so callers never have to null-check .slots, but
  // faceCount stays 0 — that's the real signal). Guessing a face-shaped crop around a made-
  // up point would be worse than doing nothing: per the fallback rule ("preserve more
  // information, not zoom in more"), show the whole frame content-preserving instead.
  if (people.faceCount === 0) return { type: 'fit' };

  const n = people.slots.length;
  if (n === 2) {
    return { type: 'split', slots: [people.slots[0], people.slots[1]] };
  }

  const outAR = outW / outH;
  const maxCropWidthPx = srcW && srcH ? srcH * outAR : Infinity;

  if (n >= 3) {
    const cxs = people.slots.map((s) => s.cx);
    const cys = people.slots.map((s) => s.cy);
    const minCx = Math.min(...cxs);
    const maxCx = Math.max(...cxs);
    const avgCy = cys.reduce((a, b) => a + b, 0) / cys.length;
    const spanWidthPx = (maxCx - minCx) * srcW;
    const highImportance = (emotionalImportance ?? 0) >= LAYOUT_EMOTIONAL_FIT_BIAS_THRESHOLD;
    const spanFitFrac = highImportance ? (0.85 - LAYOUT_EMOTIONAL_FIT_SPAN_RELAX) : 0.85;
    if (spanWidthPx > maxCropWidthPx * spanFitFrac) {
      return { type: 'fit' };
    }
    return { type: 'single', slot: { cx: (minCx + maxCx) / 2, cy: avgCy } };
  }

  const slot = people.slots[0] || { cx: 0.5, cy: 0.42 };
  // If the face sits close enough to the source's left/right edge that a centered crop would
  // have to clamp (pushing the subject off-center), show the full frame instead of cropping
  // them toward an edge.
  if (srcW && srcH) {
    const halfCropFrac = (maxCropWidthPx / 2) / srcW;
    if (slot.cx < halfCropFrac * 0.9 || slot.cx > 1 - halfCropFrac * 0.9) {
      return { type: 'fit' };
    }
  }
  return { type: 'single', slot };
}

// When the facecam region contains more than one detected face, pick a primary reactor
// (biggest + most expressive) rather than arbitrarily cropping between two people; if the
// scores are close, return a "widen" union box instead of guessing.
function pickPrimaryReactor(slots, expressiveMoments) {
  if (!slots.length) return null;
  if (slots.length === 1) return { mode: 'primary', slot: slots[0], index: 0, margin: 1 };

  // Only blend in speakingScore when EVERY slot has a confident reading — a partial reading
  // (one confident, one not) would arbitrarily bias toward whichever face happened to get
  // cleaner mouth-landmark data, unrelated to who's actually speaking. Falls back to the
  // exact original area+expression formula otherwise (today's universal state, since no
  // caller currently threads transcript words into face detection at all — see
  // facedetect.js Component 5).
  const allSlotsConfident = slots.every((s) => s.speakingScore != null && s.speakingConfidence >= REACTOR_MIN_SPEAKING_CONFIDENCE);

  const scored = slots.map((s, i) => {
    const exprScores = (expressiveMoments || []).filter((m) => m.clusterIndex === i).map((m) => m.score);
    const bestExpr = exprScores.length ? Math.max(...exprScores) : 0;
    const areaExprScore = (s.w * s.h) * 0.4 + bestExpr * 0.6;
    const score = allSlotsConfident
      ? areaExprScore * (1 - REACTOR_SPEAKING_WEIGHT) + s.speakingScore * REACTOR_SPEAKING_WEIGHT
      : areaExprScore;
    return { slot: s, index: i, score };
  });
  scored.sort((a, b) => b.score - a.score);

  if (scored.length >= 2 && scored[1].score >= scored[0].score * 0.8) {
    const cxs = slots.map((s) => s.cx);
    const cys = slots.map((s) => s.cy);
    const minCx = Math.min(...cxs), maxCx = Math.max(...cxs);
    const minCy = Math.min(...cys), maxCy = Math.max(...cys);
    const maxW = Math.max(...slots.map((s) => s.w));
    const maxH = Math.max(...slots.map((s) => s.h));
    return {
      mode: 'widen',
      slot: { cx: (minCx + maxCx) / 2, cy: (minCy + maxCy) / 2, w: (maxCx - minCx) + maxW, h: (maxCy - minCy) + maxH, landmarkBox: null },
    };
  }
  // Margin (plan doc M3): how decisively the winner cleared the runner-up, normalized 0..1
  // (1 = no real competition, just above 0.2 = barely cleared the widen threshold above —
  // scored[1] < scored[0]*0.8 is guaranteed here, so margin > 0.2 always holds in this
  // branch). Consumed only by buildLayoutSegments' cross-chunk hysteresis as a fast-path
  // signal; pickPrimaryReactor itself stays a single-chunk, memoryless decision exactly as
  // before — every existing caller that only reads `.slot`/`.mode` is unaffected.
  const margin = Math.max(0, 1 - scored[1].score / Math.max(scored[0].score, 1e-9));
  return { mode: 'primary', slot: scored[0].slot, index: scored[0].index, margin };
}

// Static band-exclusion: excludes the facecam rectangle from the frame (top/bottom/left/
// right, whichever leaves more area) and centers on what's left. This is explicitly NOT
// gameplay/content saliency or object tracking — that's out of scope for this phase. Input
// and output are both top-left-based {x,y,w,h}, normalized 0..1.
function contentRegionExcludingFacecam(rect) {
  const cutTop = rect.y < 0.5;
  const bandH = cutTop ? rect.y + rect.h : 1 - rect.y;
  const areaA = 1 - bandH;
  const cutLeft = rect.x < 0.5;
  const bandW = cutLeft ? rect.x + rect.w : 1 - rect.x;
  const areaB = 1 - bandW;
  if (areaA >= areaB) {
    return cutTop ? { x: 0, y: bandH, w: 1, h: 1 - bandH } : { x: 0, y: 0, w: 1, h: 1 - bandH };
  }
  return cutLeft ? { x: bandW, y: 0, w: 1 - bandW, h: 1 } : { x: 0, y: 0, w: 1 - bandW, h: 1 };
}

// Builds the reaction/facecam-composite layout: two independently-framed regions instead
// of one blind split/center-crop. Fails safe to {type:'fit'} whenever the geometry can't
// confidently support a two-region crop (this must never be described as gameplay
// saliency — it's a static exclusion, not content-aware tracking).
function buildReactionLayout(people, srcW, srcH, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H, opts = {}) {
  const facecamBox = reactionComposite.facecamBox; // center-based {cx,cy,w,h}
  const facecamRectTopLeft = { x: facecamBox.cx - facecamBox.w / 2, y: facecamBox.cy - facecamBox.h / 2, w: facecamBox.w, h: facecamBox.h };

  let faceBox;
  // Plan doc M3 — forcedReactorIndex (optional): when the caller's cross-chunk hysteresis
  // (buildLayoutSegments) decided to HOLD the previously-confirmed reactor instead of
  // switching to this chunk's fresh pick, it forces that exact slot here instead of letting
  // pickPrimaryReactor re-decide. Omitted (every pre-existing call site) reproduces today's
  // exact memoryless per-chunk behavior.
  if (opts.forcedReactorIndex != null && people.slots[opts.forcedReactorIndex]) {
    faceBox = people.slots[opts.forcedReactorIndex];
  } else if (people.slots.length) {
    const picked = pickPrimaryReactor(people.slots, people.expressiveMoments);
    faceBox = picked ? picked.slot : facecamBox;
  } else {
    // No face re-detected in this chunk — fall back to the facecam overlay's position, but
    // shrunk back down from its generous content-exclusion padding toward a face-sized
    // estimate, so the reactor still reads as prominent rather than zoomed way out.
    faceBox = {
      cx: facecamBox.cx, cy: facecamBox.cy,
      w: facecamBox.w / FALLBACK_FACE_SHRINK, h: facecamBox.h / FALLBACK_FACE_SHRINK,
      landmarkBox: null,
    };
  }

  const contentRectTopLeft = contentRegionExcludingFacecam(facecamRectTopLeft);
  if (contentRectTopLeft.w * contentRectTopLeft.h < MIN_CONTENT_AREA_FRAC) {
    console.log('[stage=layout] reactionComposite content region too small -> fallback type=fit');
    return { type: 'fit' };
  }
  const contentBox = {
    cx: contentRectTopLeft.x + contentRectTopLeft.w / 2,
    cy: contentRectTopLeft.y + contentRectTopLeft.h / 2,
    w: contentRectTopLeft.w,
    h: contentRectTopLeft.h,
  };

  const variant = facecamBox.w * facecamBox.h < FACECAM_AREA_INSET_THRESHOLD ? 'reaction-inset' : 'reaction-split';
  // The content panel gets its OWN composition decision — see geometry.js:decideCropOrFit.
  // reaction-split's content band is outW x (outH/2); reaction-inset's content background
  // fills the whole outW x outH canvas (the face is a small overlay on top of it), so each
  // variant judges the loss against the AR it will actually be rendered into.
  const contentTargetAR = variant === 'reaction-inset' ? outW / outH : outW / evenify(outH / 2);
  const contentFraming = decideCropOrFit(contentBox, srcW, srcH, contentTargetAR);
  console.log(
    `[stage=layout] reactionComposite content framing=${contentFraming.mode} ` +
    `(retained=${(contentFraming.retainedFraction * 100).toFixed(0)}% of content region)`
  );
  return { type: variant, faceBox, contentBox, contentFraming };
}

// Builds a content-only layout (used for a full-screen content-beat cutaway, the manual
// editor's "content" type, and any other case where ONLY the reacted-to content should
// fill the whole outW x outH canvas — no separate reactor panel). Same crop-vs-fit
// decision as buildReactionLayout's content half, just judged against the full canvas AR
// instead of one band. This is what makes full-screen content its own composition instead
// of reusing whatever crop math a face panel would use (spec: full-screen mode must not
// just be "scale + center crop").
function buildContentOnlyLayout(contentBox, srcW, srcH, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  const targetAR = outW / outH;
  const framing = decideCropOrFit(contentBox, srcW, srcH, targetAR);
  console.log(
    `[stage=layout] content-only framing=${framing.mode} (retained=${(framing.retainedFraction * 100).toFixed(0)}%)`
  );
  // regionBounded tells render.js to crop WITHIN contentBox's own footprint (never growing
  // past its edge into whatever this region deliberately excluded) instead of the generic
  // manualCrop path, which grows outward — correct for a face nudge, wrong for content.
  const layout = framing.mode === 'fit'
    ? { type: 'fit', box: contentBox, contentFraming: framing }
    : { type: 'single', slot: contentBox, manualCrop: contentBox, regionBounded: true, contentFraming: framing };
  // contentBox never carries a landmarkBox, so this is a no-op today (content has no face
  // to validate) — routed through anyway so every layout this module hands to render.js,
  // with no exceptions, has passed through the one invariant gate.
  return finalizeLayoutWithCropValidation(layout, srcW, srcH, outW, outH);
}

function landmarkCenterNorm(landmarkBox, srcW, srcH) {
  return {
    cx: (landmarkBox.minX + landmarkBox.maxX) / 2 / srcW,
    cy: (landmarkBox.minY + landmarkBox.maxY) / 2 / srcH,
  };
}

// The hard invariant: a face-containing layout must never be handed to render.js without
// first checking it against the ACTUAL crop box render.js will compute (same geometry
// math, via geometry.js) and the real facial landmarks. Widen -> reposition -> fall back
// to a different layout type -> 'fit' is the terminal, always-valid fallback.
function finalizeLayoutWithCropValidation(layout, srcW, srcH, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  if (layout.type === 'single') {
    const slot = layout.slot;
    const targetAR = outW / outH;
    // Manual edits (see mapUserTypeToLayout) attach an explicit sized region + margin so a
    // zoom nudge is meaningful; auto-generated 'single' layouts never set this and keep
    // using the original fixed-max-size crop, so this doesn't change existing behavior.
    const boxFor = (s) => layout.manualCrop
      ? cropBoxForRegion(srcW, srcH, s, targetAR, layout.manualCropMargin ?? DEFAULT_MANUAL_CROP_MARGIN)
      : cropBoxFor(srcW, srcH, s.cx, s.cy, targetAR);
    if (!slot.landmarkBox) return layout;
    let box = boxFor(slot);
    if (validateFaceCrop(slot.landmarkBox, box).ok) return layout;
    const center = landmarkCenterNorm(slot.landmarkBox, srcW, srcH);
    const repositioned = { ...slot, cx: center.cx, cy: center.cy };
    box = boxFor(repositioned);
    if (validateFaceCrop(repositioned.landmarkBox, box).ok) {
      console.log('[stage=layout] cropValidation=repositioned');
      return { ...layout, slot: repositioned, manualCrop: layout.manualCrop ? repositioned : undefined };
    }
    console.log('[stage=layout] cropValidation=fallback reason=single-crop-too-tight-for-face');
    return { type: 'fit' };
  }

  if (layout.type === 'split') {
    const bandH = evenify(outH / 2);
    const targetAR = outW / bandH;
    const slots = layout.slots.map((s) => ({ ...s }));
    let allOk = true;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s.landmarkBox) continue;
      let box = cropBoxFor(srcW, srcH, s.cx, s.cy, targetAR);
      if (validateFaceCrop(s.landmarkBox, box).ok) continue;
      const center = landmarkCenterNorm(s.landmarkBox, srcW, srcH);
      const repositioned = { ...s, cx: center.cx, cy: center.cy };
      box = cropBoxFor(srcW, srcH, repositioned.cx, repositioned.cy, targetAR);
      if (validateFaceCrop(repositioned.landmarkBox, box).ok) {
        slots[i] = repositioned;
      } else {
        allOk = false;
      }
    }
    if (!allOk) {
      console.log('[stage=layout] cropValidation=fallback reason=split-crop-too-tight-for-face');
      return { type: 'fit' };
    }
    return { ...layout, slots };
  }

  if (layout.type === 'reaction-split' || layout.type === 'reaction-inset') {
    const bandH = evenify(outH / 2);
    const targetAR = layout.type === 'reaction-inset' ? INSET_FACE_AR : (outW / bandH);
    const faceBox = layout.faceBox;
    if (!faceBox.landmarkBox) {
      console.log('[stage=layout] cropValidation=pass (no landmark data)');
      return layout;
    }
    for (const margin of FACE_CROP_MARGIN_STEPS) {
      const box = cropBoxForRegion(srcW, srcH, faceBox, targetAR, margin);
      if (validateFaceCrop(faceBox.landmarkBox, box).ok) {
        // Store exactly which margin validated — render.js must use THIS margin, not its
        // own separate default, or the crop it actually builds is one that was never checked.
        console.log(margin === FACE_CROP_MARGIN_STEPS[0] ? '[stage=layout] cropValidation=pass' : `[stage=layout] cropValidation=widened margin=${margin}`);
        return { ...layout, faceMargin: margin };
      }
    }
    const center = landmarkCenterNorm(faceBox.landmarkBox, srcW, srcH);
    const repositioned = { ...faceBox, cx: center.cx, cy: center.cy };
    const widestMargin = FACE_CROP_MARGIN_STEPS[FACE_CROP_MARGIN_STEPS.length - 1];
    const box = cropBoxForRegion(srcW, srcH, repositioned, targetAR, widestMargin);
    if (validateFaceCrop(repositioned.landmarkBox, box).ok) {
      console.log('[stage=layout] cropValidation=repositioned');
      return { ...layout, faceBox: repositioned, faceMargin: widestMargin };
    }
    console.log('[stage=layout] cropValidation=fallback reason=reaction-crop-too-tight-for-face');
    return { type: 'fit' };
  }

  return layout; // 'fit' is always trivially valid — nothing cropped out
}

// Finds dead-air/filler gaps worth jump-cutting for a tighter, more "vibes" edit — long
// silences or pauses between words. Capped so it can't gut the clip: at most `maxCuts` cuts,
// removing at most `maxRemovedFrac` of the total length.
function findDeadAirGaps(words, length, opts = {}) {
  const minGap = opts.minGap ?? 1.2;
  const maxCuts = opts.maxCuts ?? 4;
  const maxRemovedFrac = opts.maxRemovedFrac ?? 0.35;
  if (!words || words.length < 2) return [];

  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    const gapStart = words[i - 1].end;
    const gapEnd = words[i].start;
    const gapLen = gapEnd - gapStart;
    if (gapLen >= minGap && gapStart >= 0 && gapEnd <= length) {
      gaps.push({ start: gapStart, end: gapEnd, len: gapLen });
    }
  }
  gaps.sort((a, b) => b.len - a.len);

  const totalAllowed = length * maxRemovedFrac;
  let removed = 0;
  const chosen = [];
  for (const g of gaps) {
    if (chosen.length >= maxCuts) break;
    if (removed + g.len > totalAllowed) continue;
    // Leave a small buffer so the cut doesn't land right up against speech.
    const buffered = { start: g.start + 0.25, end: g.end - 0.25 };
    if (buffered.end - buffered.start < 0.5) continue;
    chosen.push(buffered);
    removed += buffered.end - buffered.start;
  }
  return chosen.sort((a, b) => a.start - b.start);
}

// Removes `cuts` (sorted, non-overlapping ranges) from a segment list, splitting/shrinking
// segments as needed while preserving each one's layout/rate/tag.
function applyCutsToSegments(segments, cuts) {
  if (!cuts.length) return segments;
  const result = [];
  for (const seg of segments) {
    let cursor = seg.start;
    for (const cut of cuts) {
      if (cut.end <= cursor || cut.start >= seg.end) continue;
      const cutStart = Math.max(cut.start, cursor);
      const cutEnd = Math.min(cut.end, seg.end);
      if (cutStart > cursor) result.push({ ...seg, start: cursor, end: cutStart });
      cursor = cutEnd;
    }
    if (cursor < seg.end) result.push({ ...seg, start: cursor, end: seg.end });
  }
  return result.filter((s) => s.end - s.start > 0.3);
}

// The "keep" counterpart to applyCutsToSegments — extracts the portion of a segment list
// falling inside [rangeStart, rangeEnd], used to pull a hook cold-open to the front.
function extractSegmentRange(segments, rangeStart, rangeEnd) {
  const result = [];
  for (const seg of segments) {
    const start = Math.max(seg.start, rangeStart);
    const end = Math.min(seg.end, rangeEnd);
    if (end - start > 0.3) result.push({ ...seg, start, end });
  }
  return result;
}

// Two layouts count as "the same shot" (so adjacent chunks merge instead of causing a switch).
function layoutsMatch(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'fit') return true;
  if (a.type === 'single') return Math.abs(a.slot.cx - b.slot.cx) < 0.15 && Math.abs(a.slot.cy - b.slot.cy) < 0.15;
  if (a.type === 'split') {
    return Math.abs(a.slots[0].cx - b.slots[0].cx) < 0.15 && Math.abs(a.slots[1].cx - b.slots[1].cx) < 0.15;
  }
  if (a.type === 'reaction-split' || a.type === 'reaction-inset') {
    return Math.abs(a.faceBox.cx - b.faceBox.cx) < 0.15 && Math.abs(a.faceBox.cy - b.faceBox.cy) < 0.15;
  }
  return false;
}

// Plan doc M3 — mirrors facedetect.js:detectLayoutTimeline's own pendingTopology/
// pendingStreak/CONFIRM_CHUNKS hysteresis (which gates FACE-COUNT/topology changes),
// applied here to a different, previously memoryless decision: WHICH detected face inside a
// reaction-composite facecam gets framed as the primary reactor (pickPrimaryReactor today
// re-decides fresh every single chunk with zero memory of the prior chunk's choice). A new
// candidate only becomes the confirmed target after REACTOR_CONFIRM_CHUNKS consecutive
// chunks agreeing on it, or immediately on a very-high-margin pick (mirrors the existing
// HIGH_CONFIDENCE fast path in detectLayoutTimeline). Pure state-in/state-out so this is
// unit-testable without any video/detection machinery — buildLayoutSegments below just
// threads it through a loop, same shape as detectLayoutTimeline's own `prior` variable.
const REACTOR_CONFIRM_CHUNKS = parseInt(process.env.REACTOR_CONFIRM_CHUNKS || '2', 10);
const REACTOR_HIGH_CONFIDENCE_MARGIN = parseFloat(process.env.REACTOR_HIGH_CONFIDENCE_MARGIN || '0.7');

function nextReactorHysteresisState(state, rawPick) {
  const prior = state || { confirmedIndex: null, pendingIndex: null, pendingStreak: 0 };
  if (!rawPick || rawPick.mode !== 'primary') {
    // Ambiguous ("widen" — two candidates too close to call) or nothing detected at all:
    // there is no confident identity to hold onto, so reset rather than keep pretending a
    // stale target is still right. This is the "low confidence -> fall back to safe existing
    // framing" case from the plan — widen's own union-box framing IS that safe fallback.
    return { confirmedIndex: null, pendingIndex: null, pendingStreak: 0, useIndex: null };
  }
  if (prior.confirmedIndex == null || rawPick.index === prior.confirmedIndex) {
    return { confirmedIndex: rawPick.index, pendingIndex: null, pendingStreak: 0, useIndex: rawPick.index };
  }
  // rawPick.index differs from the currently-confirmed target.
  if (rawPick.margin >= REACTOR_HIGH_CONFIDENCE_MARGIN) {
    return { confirmedIndex: rawPick.index, pendingIndex: null, pendingStreak: 0, useIndex: rawPick.index };
  }
  if (prior.pendingIndex === rawPick.index) {
    const streak = prior.pendingStreak + 1;
    if (streak >= REACTOR_CONFIRM_CHUNKS) {
      return { confirmedIndex: rawPick.index, pendingIndex: null, pendingStreak: 0, useIndex: rawPick.index };
    }
    return { confirmedIndex: prior.confirmedIndex, pendingIndex: rawPick.index, pendingStreak: streak, useIndex: prior.confirmedIndex };
  }
  return { confirmedIndex: prior.confirmedIndex, pendingIndex: rawPick.index, pendingStreak: 1, useIndex: prior.confirmedIndex };
}

// Turns per-chunk face detections into a layout timeline: full/single <-> split <-> reaction
// can switch partway through a clip, but only where the scene actually changes — adjacent
// chunks whose detected layout is close enough get merged into one run instead of switching
// every chunk. Every raw chunk's layout is crop-validated (finalizeLayoutWithCropValidation)
// BEFORE merging, so an invalid crop never survives into the segment list.
function buildLayoutSegments(layoutTimeline, srcW, srcH, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H, emotionalImportance = null) {
  let reactorState = null;
  const raw = layoutTimeline.map((c) => {
    let opts = {};
    // Only meaningful when the facecam genuinely contains 2+ candidate faces — with 0 or 1,
    // there's nothing ambiguous to hold a decision about, so state is simply left untouched
    // (not reset) rather than destroyed by a momentary single-face/occluded chunk.
    if (reactionComposite?.isReactionComposite && c.people.slots.length >= 2) {
      const rawPick = pickPrimaryReactor(c.people.slots, c.people.expressiveMoments);
      reactorState = nextReactorHysteresisState(reactorState, rawPick);
      if (reactorState.useIndex != null && reactorState.useIndex !== rawPick?.index) {
        opts = { forcedReactorIndex: reactorState.useIndex };
      }
    }
    const layout = finalizeLayoutWithCropValidation(pickBaseLayout(c.people, srcW, srcH, reactionComposite, outW, outH, emotionalImportance, opts), srcW, srcH, outW, outH);
    return { start: c.start, end: c.end, layout, people: c.people };
  });
  const merged = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && layoutsMatch(prev.layout, seg.layout)) {
      prev.end = seg.end;
      prev.chunks.push(seg);
    } else {
      merged.push({ start: seg.start, end: seg.end, layout: seg.layout, chunks: [seg] });
    }
  }

  // Plan doc M7 — attach position keyframes to runs where smooth panning is provably safe
  // (see buildKeyframesForRun). This can only ever ADD a `keyframes`/`keyframeSize` field to
  // an already-crop-validated layout — it never changes which layout was chosen, and a run
  // that isn't eligible (or fails re-validation) is left completely untouched, i.e. today's
  // exact static-per-run behavior.
  for (const run of merged) {
    const kf = buildKeyframesForRun(run, srcW, srcH, outW, outH);
    if (kf) run.layout = { ...run.layout, keyframes: kf.keyframes, keyframeSize: { w: kf.fixedW, h: kf.fixedH } };
  }

  return merged;
}

// Plan doc M7 — continuous subject tracking, v1 (position-only pan within a merged run; see
// geometry.js:buildAnimatedCropExprs for how render.js turns this into an actual ffmpeg
// filter). A merged run currently collapses several detected chunks into ONE static crop for
// the whole run — this instead builds a set of position keyframes (one per underlying chunk)
// so render.js can pan smoothly between them, but ONLY when doing so is provably as safe as
// today's static crop: every keyframe's position, AT THE SAME FIXED crop size the run will
// actually use, must independently pass validateFaceCrop against that keyframe's own
// landmarks (a keyframe with no landmark data is trivially safe — same convention
// finalizeLayoutWithCropValidation already uses elsewhere in this file). Returns null (the
// caller then leaves the run exactly as today's static-per-run behavior) whenever there are
// fewer than 2 distinct chunks, or any keyframe fails that re-check — the "automatic fallback
// when tracking is sparse/unreliable" the plan requires, not just a comment.
const LAYOUT_KEYFRAME_MIN_CHUNKS = 2;

function keyframePositionForChunk(chunk, layoutType) {
  if (layoutType === 'single') {
    const slot = chunk.layout?.slot;
    return slot ? { cx: slot.cx, cy: slot.cy, landmarkBox: slot.landmarkBox || null } : null;
  }
  if (layoutType === 'reaction-split' || layoutType === 'reaction-inset') {
    const faceBox = chunk.layout?.faceBox;
    return faceBox ? { cx: faceBox.cx, cy: faceBox.cy, landmarkBox: faceBox.landmarkBox || null } : null;
  }
  return null;
}

function buildKeyframesForRun(run, srcW, srcH, outW, outH) {
  const layoutType = run.layout?.type;
  if (layoutType !== 'single' && layoutType !== 'reaction-split' && layoutType !== 'reaction-inset') return null;
  if (!run.chunks || run.chunks.length < LAYOUT_KEYFRAME_MIN_CHUNKS) return null;

  const positions = run.chunks.map((c) => keyframePositionForChunk(c, layoutType));
  if (positions.some((p) => !p)) return null; // a chunk without the expected shape -> stay safe, no interpolation

  const targetAR = layoutType === 'reaction-inset'
    ? INSET_FACE_AR
    : (layoutType === 'reaction-split' ? outW / evenify(outH / 2) : outW / outH);

  // Fixed crop size for the whole run: for 'single' this is naturally constant (cropBoxFor's
  // size depends only on srcW/srcH/targetAR, never position) — computing it from any one
  // keyframe gives the identical result every other keyframe's own validation already used.
  // For reaction-*, sizes CAN legitimately differ chunk-to-chunk (detected face size varies),
  // so the run uses the LARGEST size any chunk needed — strictly more generous than what any
  // individual chunk's own validation required, then independently re-checked below anyway.
  let fixedW, fixedH;
  if (layoutType === 'single') {
    const box = cropBoxFor(srcW, srcH, positions[0].cx, positions[0].cy, targetAR);
    fixedW = box.w;
    fixedH = box.h;
  } else {
    const margin = run.layout.faceMargin ?? FACE_CROP_MARGIN_STEPS[0];
    fixedW = 0;
    fixedH = 0;
    for (const c of run.chunks) {
      const faceBox = c.layout?.faceBox;
      if (!faceBox) continue;
      const box = cropBoxForRegion(srcW, srcH, faceBox, targetAR, margin);
      fixedW = Math.max(fixedW, box.w);
      fixedH = Math.max(fixedH, box.h);
    }
    if (!fixedW || !fixedH) return null;
  }

  // Re-validate EVERY keyframe's position at the fixed size — never trust that a size chosen
  // for one keyframe (or the largest across the run) is automatically fine for another; a box
  // clamped near a frame edge can shift off-center in a way a smaller/differently-placed box
  // wouldn't. A keyframe with no landmark data has nothing to violate (same "trivially OK"
  // convention as finalizeLayoutWithCropValidation).
  for (const p of positions) {
    if (!p.landmarkBox) continue;
    const x = Math.max(0, Math.min(srcW - fixedW, p.cx * srcW - fixedW / 2));
    const y = Math.max(0, Math.min(srcH - fixedH, p.cy * srcH - fixedH / 2));
    if (!validateFaceCrop(p.landmarkBox, { x, y, w: fixedW, h: fixedH }).ok) return null;
  }

  const keyframes = run.chunks.map((c, i) => ({ t: c.start - run.start, cx: positions[i].cx, cy: positions[i].cy }));
  return { keyframes, fixedW, fixedH };
}

// Builds the segment list for a clip. The base is a layout TIMELINE (full/single/split, or
// reaction-split/reaction-inset for facecam-composite footage, can switch wherever the
// detected scene changes) rather than one static layout for the whole clip. On top of that,
// dynamic beats get spliced in — never blindly, always crop-validated:
//  - ordinary clips: at most ONE reaction cutaway (best expression spike in a real 2-person
//    split run) — unchanged from before.
//  - reaction-composite clips ONLY: additionally, at most one face-beat AND one content-beat
//    (a deliberate, narrowly-scoped loosening of the "one special moment" rule, limited to
//    this feature).
//  - a hook cold-open (reorders, not removes, a validated later window to the front).
// `tightenPacing` (opt-in): also jump-cuts dead air/filler for a snappier, more "vibes" edit.
// Deprioritizes (never excludes) a candidate reaction/face-beat moment when that face is
// the likely CURRENT speaker — a reacting listener is usually the more interesting cutaway
// than the person already being heard (see plan doc Component 6b). Falls back to `mo.score`
// unchanged when speakingScore is unavailable/low-confidence for that slot (today's
// universal state, and any ambiguous chunk going forward) — the comparison this feeds is
// then provably identical to the original `mo.score > best.score`.
// `preferredFraming` (optional, plan doc M1/M3): the whole-candidate advisory hint from
// semantic.js's momentSignals ('speaker'|'reaction'|'group'|'wide'|null). Only 'reaction' has
// any effect here — a small, bounded boost making an already-plausible reaction cutaway MORE
// likely to be the one chosen, never a hard override (it cannot make an unqualified moment,
// below the mo.score < 0.45 gate at the call site, become eligible), and it has no effect
// past this score comparison — crop validation downstream is completely unaffected by it.
const REACTION_PREFERRED_FRAMING_BOOST = parseFloat(process.env.REACTION_PREFERRED_FRAMING_BOOST || '0.15');

function reactionAdjustedScore(mo, slot, preferredFraming = null) {
  const isLikelySpeaker = slot?.speakingScore != null
    && slot.speakingConfidence >= REACTION_CUTAWAY_MIN_SPEAKING_CONFIDENCE
    && slot.speakingScore >= REACTION_CUTAWAY_SPEAKER_THRESHOLD;
  const score = isLikelySpeaker ? mo.score * (1 - REACTION_CUTAWAY_SPEAKER_PENALTY) : mo.score;
  return preferredFraming === 'reaction' ? score * (1 + REACTION_PREFERRED_FRAMING_BOOST) : score;
}

// Plan doc M4 — editorial-relevance gate for a SECOND-OR-LATER reaction cutaway (the single
// best moment, rank 0, is always eligible regardless of this — see selectReactionCutaways).
// `narrativeBeats` ({approxTimeSec,...}[], whole-video absolute seconds — same convention
// analyzeNarrativeArc/narrativeProximityBonus already use in semantic.js) and `momentSignals`
// (the whole-candidate M1 signals) both default to absent, in which case this always returns
// false for anything past rank 0 — i.e. today's exact single-cutaway behavior is preserved
// whenever neither new signal is available.
function isEditoriallyRelevantReaction(clipLocalT, absStart, narrativeBeats, momentSignals) {
  const absT = absStart + clipLocalT;
  const nearBeat = (narrativeBeats || []).some((b) => Math.abs(b.approxTimeSec - absT) <= REACTION_BEAT_PROXIMITY_SEC);
  if (nearBeat) return true;
  const surprise = momentSignals?.surprise;
  const humor = momentSignals?.humor;
  return (typeof surprise === 'number' && surprise >= REACTION_MOMENT_SIGNAL_THRESHOLD)
    || (typeof humor === 'number' && humor >= REACTION_MOMENT_SIGNAL_THRESHOLD);
}

// Selects up to `maxCutaways` non-overlapping reaction moments from `candidates`
// ({clipLocalT, adjustedScore, ...} — same shape today's single-best reduction already
// produced), sorted by score, chronologically ordered on return (ready to splice in order).
// Rank 0 (the single best) is ALWAYS accepted — with maxCutaways=1, or with no
// narrativeBeats/momentSignals, this is provably identical to today's "just take the single
// best" behavior. Every later pick needs BOTH: no already-accepted pick within
// REACTION_CUTAWAY_MIN_SPACING_SEC (so two cutaways can never crowd the same moment) AND
// isEditoriallyRelevantReaction above — never randomly inserted, per the spec.
function selectReactionCutaways(candidates, { maxCutaways = MAX_REACTION_CUTAWAYS, absStart = 0, narrativeBeats = [], momentSignals = null } = {}) {
  const sorted = [...candidates].sort((a, b) => b.adjustedScore - a.adjustedScore);
  const accepted = [];
  for (const cand of sorted) {
    if (accepted.length >= maxCutaways) break;
    const tooClose = accepted.some((a) => Math.abs(a.clipLocalT - cand.clipLocalT) < REACTION_CUTAWAY_MIN_SPACING_SEC);
    if (tooClose) continue;
    if (accepted.length === 0 || isEditoriallyRelevantReaction(cand.clipLocalT, absStart, narrativeBeats, momentSignals)) {
      accepted.push(cand);
    }
  }
  return accepted.sort((a, b) => a.clipLocalT - b.clipLocalT);
}

// Plan doc M6 — selective, capped editorial-effects wiring using ONLY existing mechanisms:
// applyCropAdjust + finalizeLayoutWithCropValidation (already power the manual editor's zoom
// nudge) for punch-in, and segment.rate (already drives atempo/setpts in render.js, already
// used for the reaction/content-beat splice pattern) for slow-motion/speed-up. No new asset,
// no new render primitive. Capped at MAX_EDITORIAL_EFFECTS_PER_CLIP total across all three
// effect types so a clip is never decorated indiscriminately — never applied without a real
// signal, and every effect defaults to a strict no-op when its signal is absent.
const MAX_EDITORIAL_EFFECTS_PER_CLIP = parseInt(process.env.MAX_EDITORIAL_EFFECTS_PER_CLIP || '2', 10);
const PUNCH_IN_MOMENT_SIGNAL_THRESHOLD = parseFloat(process.env.PUNCH_IN_MOMENT_SIGNAL_THRESHOLD || '0.65');
const PUNCH_IN_DZOOM = parseFloat(process.env.PUNCH_IN_DZOOM || '0.85'); // <1 = applyCropAdjust zooms in
const PAYOFF_SLOWMO_THRESHOLD = parseFloat(process.env.PAYOFF_SLOWMO_THRESHOLD || '0.65');
const PAYOFF_SLOWMO_RATE = parseFloat(process.env.PAYOFF_SLOWMO_RATE || '0.6');
const PAYOFF_SLOWMO_WINDOW_SEC = parseFloat(process.env.PAYOFF_SLOWMO_WINDOW_SEC || '1.5');
const HIGH_ENERGY_SPEEDUP_RATE = parseFloat(process.env.HIGH_ENERGY_SPEEDUP_RATE || '1.25');
const HIGH_ENERGY_MULTIPLIER = parseFloat(process.env.HIGH_ENERGY_MULTIPLIER || '1.5');
const HIGH_ENERGY_MIN_DURATION_SEC = parseFloat(process.env.HIGH_ENERGY_MIN_DURATION_SEC || '3');

// "Clear emotional/comedic peak" from M1's momentSignals — the gate for punching in on an
// already-confirmed M4 reaction cutaway. False (no punch-in) whenever momentSignals is absent.
function shouldPunchInReaction(momentSignals) {
  const humor = momentSignals?.humor;
  const surprise = momentSignals?.surprise;
  return (typeof humor === 'number' && humor >= PUNCH_IN_MOMENT_SIGNAL_THRESHOLD)
    || (typeof surprise === 'number' && surprise >= PUNCH_IN_MOMENT_SIGNAL_THRESHOLD);
}

// Applies a modest zoom-in to an already-crop-validated 'single' layout, re-validating the
// result through finalizeLayoutWithCropValidation — the same gate every other layout in this
// file goes through, no exceptions. If the tighter crop can't clear crop validation (would
// cut off part of the face), the ORIGINAL layout is returned unchanged: a punch-in must never
// trade a valid framing for a worse one. manualCrop/manualCropMargin (mirrors
// mapUserTypeToLayout's manual-zoom construction) are required here because render.js's
// auto-generated 'single' path (no manualCrop) ignores slot.w/h entirely and always uses the
// maximal AR-matching box — without manualCrop, a dzoom adjustment would silently have zero
// effect on the actual rendered crop.
function tryPunchIn(layout, srcW, srcH, outW, outH) {
  if (layout?.type !== 'single' || !layout.slot) return layout;
  const zoomedSlot = applyCropAdjust(layout.slot, { dzoom: PUNCH_IN_DZOOM });
  const punched = finalizeLayoutWithCropValidation(
    { type: 'single', slot: zoomedSlot, manualCrop: zoomedSlot, manualCropMargin: DEFAULT_MANUAL_CROP_MARGIN },
    srcW, srcH, outW, outH
  );
  return punched.type === 'single' ? punched : layout;
}

// Splits whichever segment currently contains [start, start+duration] into up to 3 pieces —
// the exact same splice shape already used for the reaction/content-beat cutaways above,
// generalized to set `rate` instead of swapping in a new layout. No-ops (returns false, no
// mutation) unless the window fits inside one segment with MIN_SEGMENT of room on both sides,
// the same conservative guard used everywhere else in this file — a rate effect can never
// produce a degenerate segment.
function applyRateWindow(segments, start, duration, rate) {
  const end = start + duration;
  const segIdx = segments.findIndex((s) => start >= s.start && start <= s.end);
  if (segIdx < 0) return false;
  const seg = segments[segIdx];
  const cutStart = Math.max(seg.start, start);
  const cutEnd = Math.min(seg.end, end);
  if (!(cutStart - seg.start > MIN_SEGMENT && seg.end - cutEnd > MIN_SEGMENT) || cutEnd <= cutStart) return false;
  segments.splice(segIdx, 1,
    { start: seg.start, end: cutStart, rate: seg.rate || 1, layout: seg.layout, tag: seg.tag },
    { start: cutStart, end: cutEnd, rate, layout: seg.layout, tag: rate < 1 ? 'slowmo' : 'speedup' },
    { start: cutEnd, end: seg.end, rate: seg.rate || 1, layout: seg.layout, tag: seg.tag }
  );
  return true;
}

// Finds the longest contiguous stretch (within this candidate's window of the whole-video
// energy timeline — same array/hopSec convention as findDistinctPeak above) whose energy
// stays above HIGH_ENERGY_MULTIPLIER times this clip's OWN average, lasting at least
// HIGH_ENERGY_MIN_DURATION_SEC. Returns clip-local {start, end}, or null if nothing qualifies
// — speed-up is only applied "when needed," same philosophy as findDistinctPeak's gating.
function findSustainedHighEnergyWindow(energy, hopSec, absStart, length) {
  const startHop = Math.round(absStart / hopSec);
  const endHop = Math.min(energy.length, Math.round((absStart + length) / hopSec));
  if (endHop - startHop < 6) return null;
  let sum = 0;
  for (let h = startHop; h < endHop; h++) sum += energy[h];
  const avg = sum / (endHop - startHop);
  if (avg <= 0) return null;
  const threshold = avg * HIGH_ENERGY_MULTIPLIER;
  const minHops = Math.max(1, Math.round(HIGH_ENERGY_MIN_DURATION_SEC / hopSec));

  let bestLen = 0;
  let bestStartHop = -1;
  let curStart = -1;
  for (let h = startHop; h <= endHop; h++) {
    const above = h < endHop && energy[h] >= threshold;
    if (above) {
      if (curStart === -1) curStart = h;
    } else if (curStart !== -1) {
      const runLen = h - curStart;
      if (runLen > bestLen) { bestLen = runLen; bestStartHop = curStart; }
      curStart = -1;
    }
  }
  if (bestLen < minHops) return null;
  return { start: (bestStartHop - startHop) * hopSec, end: (bestStartHop - startHop + bestLen) * hopSec };
}

// Orchestrates the three effect types above against the clip's final segment list, under one
// shared budget. Called once per clip from planClipSegments, after reaction/content-beat
// cutaways are in place and before hookSplice/tightenPacing. Every branch is a strict no-op
// when its underlying signal (momentSignals, a 'payoff' narrative beat inside this clip's
// window, a sustained energy stretch) is absent — with none of them present, this returns
// `segments` completely unchanged.
function applyEditorialEmphasis(segments, { srcW, srcH, outW, outH, absStart, length, energy, hopSec, momentSignals, narrativeBeats }) {
  let budget = MAX_EDITORIAL_EFFECTS_PER_CLIP;
  if (budget <= 0) return segments;

  if (shouldPunchInReaction(momentSignals)) {
    for (const seg of segments) {
      if (budget <= 0) break;
      if (seg.tag !== 'reaction') continue;
      const punched = tryPunchIn(seg.layout, srcW, srcH, outW, outH);
      if (punched !== seg.layout) {
        seg.layout = punched;
        budget--;
      }
    }
  }

  if (budget > 0 && typeof momentSignals?.payoff_strength === 'number' && momentSignals.payoff_strength >= PAYOFF_SLOWMO_THRESHOLD) {
    const payoffBeat = (narrativeBeats || []).find((b) => b.kind === 'payoff' && (b.approxTimeSec - absStart) >= 0 && (b.approxTimeSec - absStart) <= length);
    if (payoffBeat) {
      const clipLocalT = payoffBeat.approxTimeSec - absStart;
      if (applyRateWindow(segments, clipLocalT, PAYOFF_SLOWMO_WINDOW_SEC, PAYOFF_SLOWMO_RATE)) budget--;
    }
  }

  if (budget > 0 && energy && energy.length) {
    const hot = findSustainedHighEnergyWindow(energy, hopSec, absStart, length);
    if (hot) {
      if (applyRateWindow(segments, hot.start, hot.end - hot.start, HIGH_ENERGY_SPEEDUP_RATE)) budget--;
    }
  }

  return segments;
}

function planClipSegments({ length, layoutTimeline, energy, hopSec, absStart, srcW, srcH, words, tightenPacing, hookSplice, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H, emotionalImportance = null, preferredFraming = null, narrativeBeats = [], momentSignals = null }) {
  const merged = buildLayoutSegments(layoutTimeline, srcW, srcH, reactionComposite, outW, outH, emotionalImportance);
  let segments = merged.map((m) => ({ start: m.start, end: m.end, rate: 1, layout: m.layout }));

  // Expression spike(s) found across any ORDINARY split-screen run, for reaction cutaway(s)
  // — deprioritizing the likely-current-speaker's own face when speaker info is confidently
  // available. Plan doc M4: collects EVERY qualifying moment (not just the single best) and
  // hands them to selectReactionCutaways, which always takes the single best (byte-identical
  // to pre-M4 behavior when narrativeBeats/momentSignals are absent or maxCutaways=1) and
  // only ever adds more when they clear the editorial-relevance gate.
  const splitReactionCandidates = [];
  merged.forEach((m) => {
    if (m.layout.type !== 'split') return;
    for (const chunk of m.chunks) {
      for (const mo of chunk.people.expressiveMoments || []) {
        if (mo.score < 0.45) continue;
        const clipLocalT = chunk.start + mo.localT;
        const adjustedScore = reactionAdjustedScore(mo, chunk.people.slots[mo.clusterIndex], preferredFraming);
        splitReactionCandidates.push({ score: mo.score, adjustedScore, clipLocalT, clusterIndex: mo.clusterIndex, slots: chunk.people.slots });
      }
    }
  });
  for (const best of selectReactionCutaways(splitReactionCandidates, { absStart, narrativeBeats, momentSignals })) {
    const segIdx = segments.findIndex((s) => best.clipLocalT >= s.start && best.clipLocalT <= s.end);
    if (segIdx < 0) continue;
    const seg = segments[segIdx];
    const cutStart = Math.max(seg.start, best.clipLocalT - 0.9);
    const cutEnd = Math.min(seg.end, best.clipLocalT + 0.9);
    if (cutStart - seg.start > MIN_SEGMENT && seg.end - cutEnd > MIN_SEGMENT) {
      const reactionSlot = best.slots[best.clusterIndex] || best.slots[0];
      const reactionLayout = finalizeLayoutWithCropValidation({ type: 'single', slot: reactionSlot }, srcW, srcH, outW, outH);
      segments.splice(segIdx, 1,
        { start: seg.start, end: cutStart, rate: 1, layout: seg.layout },
        { start: cutStart, end: cutEnd, rate: 1, layout: reactionLayout, tag: 'reaction' },
        { start: cutEnd, end: seg.end, rate: 1, layout: seg.layout }
      );
    }
  }

  if (reactionComposite?.isReactionComposite) {
    const faceReactionCandidates = [];
    merged.forEach((m) => {
      if (m.layout.type !== 'reaction-split' && m.layout.type !== 'reaction-inset') return;
      for (const chunk of m.chunks) {
        for (const mo of chunk.people.expressiveMoments || []) {
          if (mo.score < 0.45) continue;
          const clipLocalT = chunk.start + mo.localT;
          const adjustedScore = reactionAdjustedScore(mo, chunk.people.slots[mo.clusterIndex], preferredFraming);
          faceReactionCandidates.push({ score: mo.score, adjustedScore, clipLocalT, faceBox: m.layout.faceBox });
        }
      }
    });
    for (const bestFace of selectReactionCutaways(faceReactionCandidates, { absStart, narrativeBeats, momentSignals })) {
      const segIdx = segments.findIndex((s) => bestFace.clipLocalT >= s.start && bestFace.clipLocalT <= s.end);
      if (segIdx < 0) continue;
      const seg = segments[segIdx];
      const cutStart = Math.max(seg.start, bestFace.clipLocalT - 0.9);
      const cutEnd = Math.min(seg.end, bestFace.clipLocalT + 0.9);
      if (cutStart - seg.start > MIN_SEGMENT && seg.end - cutEnd > MIN_SEGMENT) {
        const faceLayout = finalizeLayoutWithCropValidation({ type: 'single', slot: bestFace.faceBox }, srcW, srcH, outW, outH);
        segments.splice(segIdx, 1,
          { start: seg.start, end: cutStart, rate: 1, layout: seg.layout },
          { start: cutStart, end: cutEnd, rate: 1, layout: faceLayout, tag: 'reaction' },
          { start: cutEnd, end: seg.end, rate: 1, layout: seg.layout }
        );
      }
    }

    const peak = findDistinctPeak(energy, hopSec, absStart, length);
    if (peak) {
      const run = merged.find((m) => (m.layout.type === 'reaction-split' || m.layout.type === 'reaction-inset') && peak.localT >= m.start && peak.localT <= m.end);
      if (run) {
        const segIdx = segments.findIndex((s) => peak.localT >= s.start && peak.localT <= s.end);
        if (segIdx >= 0) {
          const seg = segments[segIdx];
          const cutStart = Math.max(seg.start, peak.localT - 0.9);
          const cutEnd = Math.min(seg.end, peak.localT + 0.9);
          if (cutStart - seg.start > MIN_SEGMENT && seg.end - cutEnd > MIN_SEGMENT) {
            const contentLayout = buildContentOnlyLayout(run.layout.contentBox, srcW, srcH, outW, outH);
            segments.splice(segIdx, 1,
              { start: seg.start, end: cutStart, rate: 1, layout: seg.layout },
              { start: cutStart, end: cutEnd, rate: 1, layout: contentLayout, tag: 'content-beat' },
              { start: cutEnd, end: seg.end, rate: 1, layout: seg.layout }
            );
          }
        }
      }
    }
  }

  // Plan doc M6 — selective punch-in/slow-motion/speed-up, applied after reaction/content-beat
  // cutaways are in place and before hookSplice (a strict no-op when momentSignals/energy/
  // narrativeBeats carry no qualifying signal — see applyEditorialEmphasis above).
  segments = applyEditorialEmphasis(segments, { srcW, srcH, outW, outH, absStart, length, energy, hopSec, momentSignals, narrativeBeats });

  if (hookSplice && hookSplice.end > hookSplice.start) {
    const hookSegs = extractSegmentRange(segments, hookSplice.start, hookSplice.end).map((s) => ({ ...s, tag: s.tag || 'hook' }));
    if (hookSegs.length) {
      const remainder = applyCutsToSegments(segments, [hookSplice]);
      segments = [...hookSegs, ...remainder];
    }
  }

  if (tightenPacing && words?.length) {
    const cuts = findDeadAirGaps(words, length);
    if (cuts.length) segments = applyCutsToSegments(segments, cuts);
  }

  return segments;
}

// --- Manual editor support (post-generation timeline editing) ---
// Everything below is purely additive: it reuses the same layout-building blocks above
// (pickPrimaryReactor, buildReactionLayout's box math, contentRegionExcludingFacecam,
// finalizeLayoutWithCropValidation) for a USER-CHOSEN time range/type instead of an
// auto-detected one. None of it is invoked by the auto-generation path
// (planClipSegments/buildLayoutSegments), so it cannot change existing behavior.

// Shifts/zooms a normalized {cx,cy,w,h} box by a small user-provided delta. Clamped so a
// nudge can never produce a degenerate (zero/negative/oversized) box; still goes through
// finalizeLayoutWithCropValidation afterward, which is what actually guarantees the face
// can't end up cut off.
function applyCropAdjust(box, adjust) {
  if (!adjust || !box) return box;
  const dzoom = Math.max(0.4, Math.min(2.5, adjust.dzoom ?? 1));
  return {
    ...box,
    cx: Math.max(0, Math.min(1, box.cx + (adjust.dcx || 0))),
    cy: Math.max(0, Math.min(1, box.cy + (adjust.dcy || 0))),
    w: box.w != null ? Math.max(0.03, Math.min(1, box.w * dzoom)) : box.w,
    h: box.h != null ? Math.max(0.03, Math.min(1, box.h * dzoom)) : box.h,
  };
}

// Finds whichever layoutTimeline chunk (raw per-~12s-window face/composite detection) best
// represents a user-chosen [start,end] time range — most-overlapping chunk if any overlaps,
// else the nearest one by center distance (a manually-drawn boundary won't generally align
// with the original 12s chunk grid).
function findBestChunk(layoutTimeline, start, end) {
  if (!layoutTimeline || !layoutTimeline.length) return null;
  let best = null;
  let bestOverlap = -Infinity;
  for (const c of layoutTimeline) {
    const overlap = Math.min(end, c.end) - Math.max(start, c.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = c;
    }
  }
  if (bestOverlap > 0) return best;
  const mid = (start + end) / 2;
  let bestDist = Infinity;
  for (const c of layoutTimeline) {
    const d = Math.abs((c.start + c.end) / 2 - mid);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// Which user-facing layout choices make sense for THIS clip at all — 'split' needs either
// a real 2nd person ever detected or a reaction composite; 'content' only makes sense for a
// reaction composite (there's no general "content region" concept otherwise).
function computeUserTypeOptions(layoutTimeline, reactionComposite) {
  const types = ['full'];
  const maxFaceCount = Math.max(0, ...(layoutTimeline || []).map((c) => c.people?.faceCount || 0));
  const isComposite = !!reactionComposite?.isReactionComposite;
  if (maxFaceCount >= 2 || isComposite) types.push('split');
  if (maxFaceCount >= 1 || isComposite) types.push('reactor');
  if (isComposite) types.push('content');
  return types;
}

// Best-effort guess at which user-facing type an auto-generated segment corresponds to —
// used only to seed the editor's initial state; the user can always change it explicitly.
function inferUserTypeFromLayout(seg) {
  if (seg.tag === 'reaction') return 'reactor';
  if (seg.tag === 'content-beat') return 'content';
  if (seg.layout?.type === 'split' || seg.layout?.type === 'reaction-split' || seg.layout?.type === 'reaction-inset') return 'split';
  return 'full';
}

// The core of the manual editor: turns a user's chosen {userType, timeRange, cropAdjust}
// into a real, crop-validated layout object, using whichever face/composite data was
// actually detected near that time (via findBestChunk) — same building blocks as
// pickBaseLayout/buildReactionLayout, just driven by an explicit user choice instead of an
// auto decision.
function mapUserTypeToLayout(userType, timeRange, layoutTimeline, reactionComposite, srcW, srcH, cropAdjust, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  const chunk = findBestChunk(layoutTimeline, timeRange.start, timeRange.end);
  const people = chunk?.people || { slots: [], faceCount: 0, expressiveMoments: [] };
  const isComposite = !!reactionComposite?.isReactionComposite;
  let layout;

  if (userType === 'split') {
    if (isComposite) {
      layout = buildReactionLayout(people, srcW, srcH, reactionComposite, outW, outH);
      if (layout.faceBox) layout.faceBox = applyCropAdjust(layout.faceBox, cropAdjust?.face);
      if (layout.contentBox) layout.contentBox = applyCropAdjust(layout.contentBox, cropAdjust?.content);
    } else if (people.slots.length >= 2) {
      layout = { type: 'split', slots: [people.slots[0], people.slots[1]] };
    } else {
      layout = { type: 'fit' }; // nothing to split with — fail safe rather than guess
    }
  } else if (userType === 'content') {
    // Full-screen content gets its own crop-vs-fit composition decision (buildContentOnlyLayout)
    // instead of always being force-fit into a manual cover-crop — same reasoning as the
    // auto-generated content-beat cutaway (pipeline.js) and reaction-split's content half.
    let contentBox;
    if (isComposite) {
      const fb = reactionComposite.facecamBox;
      const rectTL = { x: fb.cx - fb.w / 2, y: fb.cy - fb.h / 2, w: fb.w, h: fb.h };
      const contentRect = contentRegionExcludingFacecam(rectTL);
      contentBox = { cx: contentRect.x + contentRect.w / 2, cy: contentRect.y + contentRect.h / 2, w: contentRect.w, h: contentRect.h };
    } else {
      contentBox = { cx: 0.5, cy: 0.5, w: 0.9, h: 0.9 }; // no known content region — center fallback
    }
    contentBox = applyCropAdjust(contentBox, cropAdjust);
    layout = buildContentOnlyLayout(contentBox, srcW, srcH, outW, outH);
  } else if (userType === 'reactor' || userType === 'full') {
    let slot;
    if (userType === 'reactor') {
      if (people.slots.length) {
        slot = pickPrimaryReactor(people.slots, people.expressiveMoments)?.slot || people.slots[0];
      } else if (isComposite) {
        const fb = reactionComposite.facecamBox;
        slot = { cx: fb.cx, cy: fb.cy, w: fb.w / FALLBACK_FACE_SHRINK, h: fb.h / FALLBACK_FACE_SHRINK };
      } else {
        slot = { cx: 0.5, cy: 0.42, w: 0.3, h: 0.4 };
      }
    } else {
      // 'full' — one unified frame, not split, centered on whatever's actually there
      if (people.slots.length === 1) slot = { ...people.slots[0] };
      else if (people.slots.length >= 2) {
        const cxs = people.slots.map((s) => s.cx);
        const cys = people.slots.map((s) => s.cy);
        slot = { cx: (Math.min(...cxs) + Math.max(...cxs)) / 2, cy: cys.reduce((a, b) => a + b, 0) / cys.length, w: 0.5, h: 0.6 };
      } else if (isComposite) {
        slot = { cx: 0.5, cy: 0.5, w: 0.9, h: 0.9 };
      } else {
        slot = { cx: 0.5, cy: 0.42, w: 0.5, h: 0.6 };
      }
    }
    slot = applyCropAdjust(slot, cropAdjust);
    layout = { type: 'single', slot, manualCrop: slot, manualCropMargin: DEFAULT_MANUAL_CROP_MARGIN };
  } else {
    layout = { type: 'fit' };
  }

  return finalizeLayoutWithCropValidation(layout, srcW, srcH, outW, outH);
}

module.exports = {
  planClipSegments, findDistinctPeak, pickBaseLayout, findDeadAirGaps, applyCutsToSegments,
  extractSegmentRange, buildLayoutSegments, pickPrimaryReactor, buildReactionLayout,
  finalizeLayoutWithCropValidation, contentRegionExcludingFacecam, buildContentOnlyLayout,
  applyCropAdjust, findBestChunk, computeUserTypeOptions, inferUserTypeFromLayout, mapUserTypeToLayout,
  reactionAdjustedScore, nextReactorHysteresisState,
  selectReactionCutaways, isEditoriallyRelevantReaction,
  applyEditorialEmphasis, shouldPunchInReaction, tryPunchIn, applyRateWindow, findSustainedHighEnergyWindow,
  buildKeyframesForRun,
};
