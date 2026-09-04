const MIN_SEGMENT = 1.0;

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

const OUT_AR = 1080 / 1920;

// Decides the base (non-effect) layout for the whole clip from detected people.
//  - 0/1 person -> single centered crop (or a full-frame "fit" if centering would clip them)
//  - 2 people   -> half/half split screen (podcast style)
//  - 3+ people  -> a group crop if everyone fits with room to spare, else a full-frame "fit"
//                  (blurred zoomed-out background) so nobody gets cropped out of frame
function pickBaseLayout(people, srcW, srcH) {
  const n = people.slots.length;
  if (n === 2) {
    return { type: 'split', slots: [people.slots[0], people.slots[1]] };
  }

  const maxCropWidthPx = srcW && srcH ? srcH * OUT_AR : Infinity;

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

// Two layouts count as "the same shot" (so adjacent chunks merge instead of causing a switch).
function layoutsMatch(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'fit') return true;
  if (a.type === 'single') return Math.abs(a.slot.cx - b.slot.cx) < 0.15 && Math.abs(a.slot.cy - b.slot.cy) < 0.15;
  if (a.type === 'split') {
    return Math.abs(a.slots[0].cx - b.slots[0].cx) < 0.15 && Math.abs(a.slots[1].cx - b.slots[1].cx) < 0.15;
  }
  return false;
}

// Turns per-chunk face detections into a layout timeline: full/single <-> split can switch
// partway through a clip, but only where the scene actually changes — adjacent chunks whose
// detected layout is close enough get merged into one run instead of switching every chunk.
function buildLayoutSegments(layoutTimeline, srcW, srcH) {
  const raw = layoutTimeline.map((c) => ({
    start: c.start, end: c.end, layout: pickBaseLayout(c.people, srcW, srcH), people: c.people,
  }));
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

// Builds the segment list for a clip. The base is a layout TIMELINE (full/single can switch to
// split-screen and back, wherever the detected scene changes) rather than one static layout for
// the whole clip. On top of that, at most ONE special moment gets spliced in (a reaction cutaway
// into whichever split-screen run has the best expression spike) — never on every clip.
// `tightenPacing` (opt-in): also jump-cuts dead air/filler for a snappier, more "vibes" edit.
function planClipSegments({ length, layoutTimeline, energy, hopSec, absStart, srcW, srcH, words, tightenPacing }) {
  const merged = buildLayoutSegments(layoutTimeline, srcW, srcH);
  let segments = merged.map((m) => ({ start: m.start, end: m.end, rate: 1, layout: m.layout }));

  // Best expression spike found across any split-screen run, for an optional reaction cutaway.
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
        segments.splice(segIdx, 1,
          { start: seg.start, end: cutStart, rate: 1, layout: seg.layout },
          { start: cutStart, end: cutEnd, rate: 1, layout: { type: 'single', slot: reactionSlot }, tag: 'reaction' },
          { start: cutEnd, end: seg.end, rate: 1, layout: seg.layout }
        );
      }
    }
  }

  // Dramatic slow-mo is available (findDistinctPeak below) but not auto-applied right now,
  // per feedback: "that effect CAN BE ADDED AFTER" as a manual/later pass, not on every clip.

  if (tightenPacing && words?.length) {
    const cuts = findDeadAirGaps(words, length);
    if (cuts.length) segments = applyCutsToSegments(segments, cuts);
  }

  return segments;
}

module.exports = {
  planClipSegments, findDistinctPeak, pickBaseLayout, findDeadAirGaps, applyCutsToSegments, buildLayoutSegments,
};
