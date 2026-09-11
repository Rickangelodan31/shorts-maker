const { validateFaceCrop } = require('./facedetect');
const {
  OUT_W: DEFAULT_OUT_W, OUT_H: DEFAULT_OUT_H,
  evenify, cropBoxFor, cropBoxForRegion, FACE_CROP_MARGIN_STEPS, INSET_FACE_AR,
  decideCropOrFit,
} = require('./geometry');

const MIN_SEGMENT = 1.0;
const FACECAM_AREA_INSET_THRESHOLD = 0.12;
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
function pickBaseLayout(people, srcW, srcH, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  if (reactionComposite?.isReactionComposite) {
    const threshold = MIN_COMPOSITE_CONFIDENCE[reactionComposite.source] ?? 0.5;
    if (reactionComposite.confidence >= threshold) {
      return buildReactionLayout(people, srcW, srcH, reactionComposite, outW, outH);
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
    if (spanWidthPx > maxCropWidthPx * 0.85) {
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
  if (slots.length === 1) return { mode: 'primary', slot: slots[0] };

  const scored = slots.map((s, i) => {
    const exprScores = (expressiveMoments || []).filter((m) => m.clusterIndex === i).map((m) => m.score);
    const bestExpr = exprScores.length ? Math.max(...exprScores) : 0;
    return { slot: s, index: i, score: (s.w * s.h) * 0.4 + bestExpr * 0.6 };
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
  return { mode: 'primary', slot: scored[0].slot };
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
function buildReactionLayout(people, srcW, srcH, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  const facecamBox = reactionComposite.facecamBox; // center-based {cx,cy,w,h}
  const facecamRectTopLeft = { x: facecamBox.cx - facecamBox.w / 2, y: facecamBox.cy - facecamBox.h / 2, w: facecamBox.w, h: facecamBox.h };

  let faceBox;
  if (people.slots.length) {
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

// Turns per-chunk face detections into a layout timeline: full/single <-> split <-> reaction
// can switch partway through a clip, but only where the scene actually changes — adjacent
// chunks whose detected layout is close enough get merged into one run instead of switching
// every chunk. Every raw chunk's layout is crop-validated (finalizeLayoutWithCropValidation)
// BEFORE merging, so an invalid crop never survives into the segment list.
function buildLayoutSegments(layoutTimeline, srcW, srcH, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  const raw = layoutTimeline.map((c) => {
    const layout = finalizeLayoutWithCropValidation(pickBaseLayout(c.people, srcW, srcH, reactionComposite, outW, outH), srcW, srcH, outW, outH);
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
  return merged;
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
function planClipSegments({ length, layoutTimeline, energy, hopSec, absStart, srcW, srcH, words, tightenPacing, hookSplice, reactionComposite, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H }) {
  const merged = buildLayoutSegments(layoutTimeline, srcW, srcH, reactionComposite, outW, outH);
  let segments = merged.map((m) => ({ start: m.start, end: m.end, rate: 1, layout: m.layout }));

  // Best expression spike found across any ORDINARY split-screen run, for the existing
  // reaction cutaway (unchanged behavior for non-composite clips).
  let best = null;
  merged.forEach((m) => {
    if (m.layout.type !== 'split') return;
    for (const chunk of m.chunks) {
      for (const mo of chunk.people.expressiveMoments || []) {
        if (mo.score < 0.45) continue;
        const clipLocalT = chunk.start + mo.localT;
        if (!best || mo.score > best.score) {
          best = { score: mo.score, clipLocalT, clusterIndex: mo.clusterIndex, slots: chunk.people.slots };
        }
      }
    }
  });
  if (best) {
    const segIdx = segments.findIndex((s) => best.clipLocalT >= s.start && best.clipLocalT <= s.end);
    if (segIdx >= 0) {
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
  }

  if (reactionComposite?.isReactionComposite) {
    let bestFace = null;
    merged.forEach((m) => {
      if (m.layout.type !== 'reaction-split' && m.layout.type !== 'reaction-inset') return;
      for (const chunk of m.chunks) {
        for (const mo of chunk.people.expressiveMoments || []) {
          if (mo.score < 0.45) continue;
          const clipLocalT = chunk.start + mo.localT;
          if (!bestFace || mo.score > bestFace.score) {
            bestFace = { score: mo.score, clipLocalT, faceBox: m.layout.faceBox };
          }
        }
      }
    });
    if (bestFace) {
      const segIdx = segments.findIndex((s) => bestFace.clipLocalT >= s.start && bestFace.clipLocalT <= s.end);
      if (segIdx >= 0) {
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
};
