const path = require('path');
const fs = require('fs');
const { extractFrame } = require('./ffutil');

let faceapi = null;
let canvas = null;
let modelsReady = false;
let available = true;

function tryInit() {
  if (faceapi) return true;
  try {
    faceapi = require('@vladmandic/face-api');
    canvas = require('canvas');
    const { Canvas, Image, ImageData } = canvas;
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
    return true;
  } catch (err) {
    console.warn('Face detection unavailable, falling back to center-crop:', err.message);
    available = false;
    return false;
  }
}

async function ensureModels() {
  if (modelsReady) return;
  const modelPath = path.join(require.resolve('@vladmandic/face-api'), '..', '..', 'model');
  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelPath);
  await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(modelPath);
  await faceapi.nets.faceExpressionNet.loadFromDisk(modelPath);
  modelsReady = true;
}

// Two boxes closer together (relative to their own size) than this are treated as the same
// physical face detected twice, not two different people.
function isSameFace(a, b) {
  const avgW = (a.w + b.w) / 2;
  const avgH = (a.h + b.h) / 2;
  return Math.abs(a.cx - b.cx) < avgW * 0.6 && Math.abs(a.cy - b.cy) < avgH * 0.6;
}

function dedupeFaces(faces) {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of sorted) {
    if (!kept.some((k) => isSameFace(k, f))) kept.push(f);
  }
  return kept;
}

function eyeCenter(landmarks, imgW, imgH) {
  const pts = [...landmarks.getLeftEye(), ...landmarks.getRightEye()];
  const sx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const sy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  return { cx: sx / imgW, cy: sy / imgH };
}

// Full-landmark pixel-space bounding box (jaw/brow/nose/mouth/eyes — the 68-point model
// has no hairline/forehead point, so the top edge is a geometric heuristic extension of
// the brow-to-chin span, not a literal landmark). Used only for deterministic crop-margin
// validation (validateFaceCrop below) — no AI call involved, just geometry against
// landmarks already computed for this detection.
function faceLandmarkBoxPx(landmarks) {
  const pts = [
    ...landmarks.getJawOutline(), ...landmarks.getLeftEyeBrow(), ...landmarks.getRightEyeBrow(),
    ...landmarks.getNose(), ...landmarks.getMouth(), ...landmarks.getLeftEye(), ...landmarks.getRightEye(),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const foreheadEstimate = minY - (maxY - minY) * 0.35;
  return { minX, maxX, minY: foreheadEstimate, maxY };
}

// Deterministic, universal, cheap gate: does a proposed pixel-space crop box (x,y,w,h)
// leave enough margin around the actual face landmarks? No LLM call — this is what makes
// "never render an invalid face crop" an actual invariant rather than best-effort, and it
// applies to every rendered clip's face-containing layout, not just vision-budget-covered
// candidates. Returns {ok:true} when the crop is fine, or {ok:false, needed:{left,right,
// top,bottom}} (the minimum pixel rect that must be visible) for the caller (effects.js)
// to use when widening/repositioning/falling back — the actual fallback DECISION is an
// editorial call that belongs in effects.js, not here.
function validateFaceCrop(faceBoxPx, cropBoxPx, opts = {}) {
  if (!faceBoxPx || !cropBoxPx) return { ok: true };
  const marginX = opts.marginX ?? 0.08;
  const marginTop = opts.marginTop ?? 0.10;
  const marginBottom = opts.marginBottom ?? 0.06;

  const faceW = faceBoxPx.maxX - faceBoxPx.minX;
  const faceH = faceBoxPx.maxY - faceBoxPx.minY;
  const needed = {
    left: faceBoxPx.minX - faceW * marginX,
    right: faceBoxPx.maxX + faceW * marginX,
    top: faceBoxPx.minY - faceH * marginTop,
    bottom: faceBoxPx.maxY + faceH * marginBottom,
  };

  const cropLeft = cropBoxPx.x;
  const cropRight = cropBoxPx.x + cropBoxPx.w;
  const cropTop = cropBoxPx.y;
  const cropBottom = cropBoxPx.y + cropBoxPx.h;

  const ok = needed.left >= cropLeft && needed.right <= cropRight && needed.top >= cropTop && needed.bottom <= cropBottom;
  return ok ? { ok: true } : { ok: false, needed };
}

// 1D k-means on x-position, weighted by detection score. Returns k centroids (sorted L-to-R)
// and the index of the nearest centroid for every input point. `seedCentroids` (optional,
// one cx per cluster) biases initial centroid placement toward a prior chunk's slot
// positions so cluster identity ("who is slot 0") doesn't flip chunk-to-chunk before
// temporal smoothing has a chance to blend positions.
function clusterByX(points, k, seedCentroids) {
  if (!points.length) return { centroids: [], assign: [] };
  const xs = points.map((p) => p.cx);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  let centroids = (seedCentroids && seedCentroids.length === k)
    ? [...seedCentroids].sort((a, b) => a - b)
    : Array.from({ length: k }, (_, i) => min + ((max - min) * (i + 0.5)) / k);
  let assign = new Array(points.length).fill(0);

  for (let iter = 0; iter < 6; iter++) {
    assign = points.map((p) => {
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, i) => {
        const d = Math.abs(p.cx - c);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    });
    const sums = Array.from({ length: k }, () => ({ x: 0, w: 0 }));
    points.forEach((p, i) => {
      const c = assign[i];
      const weight = p.score || 1;
      sums[c].x += p.cx * weight;
      sums[c].w += weight;
    });
    centroids = sums.map((s, i) => (s.w > 0 ? s.x / s.w : centroids[i]));
  }

  const order = centroids.map((c, i) => i).sort((a, b) => centroids[a] - centroids[b]);
  const rank = new Array(k);
  order.forEach((origIdx, newIdx) => (rank[origIdx] = newIdx));
  const sortedCentroids = order.map((i) => centroids[i]);
  const remappedAssign = assign.map((a) => rank[a]);
  return { centroids: sortedCentroids, assign: remappedAssign };
}

// Greedy radius-based 2D clustering (unlike clusterByX, which is x-only and needs a fixed
// k) — used only by detectReactionComposite, where the number of distinct regions isn't
// known up front and a facecam overlay can sit anywhere in frame, not just left/right.
function greedyCluster2D(points, radius = 0.1) {
  const clusters = [];
  for (const p of points) {
    let best = null;
    let bestD = Infinity;
    for (const c of clusters) {
      const d = Math.hypot(p.cx - c.cx, p.cy - c.cy);
      if (d < radius && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) {
      const w = p.score || 1;
      best.cx = (best.cx * best.wsum + p.cx * w) / (best.wsum + w);
      best.cy = (best.cy * best.wsum + p.cy * w) / (best.wsum + w);
      best.wsum += w;
      best.points.push(p);
    } else {
      clusters.push({ cx: p.cx, cy: p.cy, wsum: p.score || 1, points: [p] });
    }
  }
  return clusters;
}

// Samples frames inside [start, start+length] of the video, detects faces with landmarks +
// expressions, and returns up to 3 left-to-right "slots" plus any notable expression spikes
// (used for reaction cutaways). All returned times are LOCAL to the window (0..length).
// opts.restrictToBox (normalized center-based {cx,cy,w,h}): when given (reaction-composite
// mode), faces outside this box are discarded before clustering, so content-region imagery
// can't contaminate person detection. opts.seedCentroids: see clusterByX.
async function detectPeopleInWindow(videoPath, start, length, tmpDir, srcW, srcH, sampleCount = 6, opts = {}) {
  const fallback = { faceCount: 0, slots: [{ cx: 0.5, cy: 0.42, w: 0.3, h: 0.3 }], expressiveMoments: [], confidence: 0 };

  if (!tryInit()) return fallback;
  try {
    await ensureModels();
  } catch (err) {
    console.warn('Could not load face-api models, falling back to center-crop:', err.message);
    available = false;
    return fallback;
  }

  const perFrame = [];

  for (let i = 0; i < sampleCount; i++) {
    const tLocal = (length * (i + 0.5)) / sampleCount;
    const tAbs = start + tLocal;
    const framePath = path.join(tmpDir, `sample_${i}.jpg`);
    try {
      await extractFrame(videoPath, tAbs, framePath);
      const img = await canvas.loadImage(framePath);
      // inputSize 608 (up from 416) + a lower threshold catch smaller/farther faces — e.g. a
      // facecam that only takes up a corner of a gameplay frame, which is common streaming
      // content and was likely getting missed at the old settings.
      const detections = await faceapi
        .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.22 }))
        .withFaceLandmarks(true)
        .withFaceExpressions();

      const rawFaces = detections.map((d) => {
        const eye = eyeCenter(d.landmarks, img.width, img.height);
        const expr = d.expressions || {};
        const nonNeutral = 1 - (expr.neutral ?? 1);
        return {
          cx: eye.cx,
          cy: eye.cy,
          w: d.detection.box.width / img.width,
          h: d.detection.box.height / img.height,
          score: d.detection.score,
          nonNeutral,
          tLocal,
          landmarkBox: faceLandmarkBoxPx(d.landmarks),
        };
      });
      // The looser detector threshold can yield two overlapping boxes for one real face;
      // collapse near-duplicates within a single frame before counting them as separate people.
      let faces = dedupeFaces(rawFaces);
      if (opts.restrictToBox) {
        const bx = opts.restrictToBox;
        // A bit more forgiving than the box's own estimated edges — the facecam box is
        // itself an estimate (from a padded CV-fallback detection or an LLM guess), and an
        // overly tight filter here was causing real faces near its edge to be discarded,
        // falling back to a poorer, more-zoomed-out framing more often than necessary.
        const margin = 0.08;
        const left = bx.cx - bx.w / 2 - margin;
        const right = bx.cx + bx.w / 2 + margin;
        const top = bx.cy - bx.h / 2 - margin;
        const bottom = bx.cy + bx.h / 2 + margin;
        faces = faces.filter((f) => f.cx >= left && f.cx <= right && f.cy >= top && f.cy <= bottom);
      }
      perFrame.push(faces);
    } catch (err) {
      console.warn(`  [facedetect] sample ${i} @ t=${tAbs.toFixed(1)}s failed: ${err.message}`);
      perFrame.push([]);
    } finally {
      fs.existsSync(framePath) && fs.unlinkSync(framePath);
    }
  }

  console.log(
    `[facedetect] window start=${start.toFixed(1)}s len=${length.toFixed(1)}s -> per-sample face counts: ` +
    `[${perFrame.map((f) => f.length).join(', ')}]`
  );

  const allPoints = perFrame.flat();
  if (!allPoints.length) {
    console.log('[facedetect] no faces found in any sample -> falling back to center crop');
    return fallback;
  }

  // Pick the LARGEST face count that has reasonable support across samples, rather than the
  // median/mode — TinyFaceDetector routinely misses one of two people in any given frame
  // (angle, occlusion, size), so requiring near-unanimous agreement meant split-screen almost
  // never triggered even when 2 people were genuinely on screen throughout.
  const counts = perFrame.map((f) => f.length);
  const freq = {};
  counts.forEach((c) => {
    if (c > 0) freq[c] = (freq[c] || 0) + 1;
  });
  const minSupport = Math.max(2, Math.ceil(sampleCount * 0.3));
  let faceCount = 1;
  for (let c = 3; c >= 1; c--) {
    if ((freq[c] || 0) >= minSupport) {
      faceCount = c;
      break;
    }
  }
  const confidence = (freq[faceCount] || 0) / sampleCount;
  console.log(`[facedetect] decision -> faceCount=${faceCount} confidence=${confidence.toFixed(2)} (needed >=${minSupport} samples in support)`);

  const { centroids, assign } = clusterByX(allPoints, faceCount, opts.seedCentroids);
  const slotAccum = centroids.map(() => ({ cx: 0, cy: 0, w: 0, h: 0, wsum: 0 }));
  allPoints.forEach((p, i) => {
    const c = assign[i];
    const weight = p.score || 1;
    slotAccum[c].cx += p.cx * weight;
    slotAccum[c].cy += p.cy * weight;
    slotAccum[c].w += p.w * weight;
    slotAccum[c].h += p.h * weight;
    slotAccum[c].wsum += weight;
  });
  let slots = slotAccum
    .map((a) => (a.wsum > 0 ? { cx: a.cx / a.wsum, cy: a.cy / a.wsum, w: a.w / a.wsum, h: a.h / a.wsum } : null))
    .filter(Boolean);

  // Attach a representative (highest-scoring single detection, not averaged — averaging
  // landmark extents across different head angles/poses would be meaningless) landmark
  // box per cluster, for later crop-margin validation.
  const bestByCluster = new Array(centroids.length).fill(null);
  allPoints.forEach((p, i) => {
    const c = assign[i];
    if (!bestByCluster[c] || (p.score || 0) > (bestByCluster[c].score || 0)) bestByCluster[c] = p;
  });
  slots = slots.map((s, i) => ({ ...s, landmarkBox: bestByCluster[i]?.landmarkBox || null }));

  // Safety net: if clustering still produced two "people" that are really the same face
  // (e.g. it wobbled between 2 detections of one person across samples), collapse them —
  // a split screen must never show the same person in both halves.
  if (slots.length === 2 && isSameFace(slots[0], slots[1])) {
    console.log('[facedetect] two clusters look like the same face -> collapsing to 1');
    slots = [{
      cx: (slots[0].cx + slots[1].cx) / 2,
      cy: (slots[0].cy + slots[1].cy) / 2,
      w: Math.max(slots[0].w, slots[1].w),
      h: Math.max(slots[0].h, slots[1].h),
      landmarkBox: slots[0].landmarkBox || slots[1].landmarkBox,
    }];
  }

  if (!slots.length) return fallback;

  // Notable expression spikes per cluster, for optional reaction cutaways.
  const expressiveMoments = [];
  slots.forEach((_, clusterIndex) => {
    const clusterPoints = allPoints.filter((_, i) => assign[i] === clusterIndex);
    if (!clusterPoints.length) return;
    const best = clusterPoints.reduce((a, b) => (b.nonNeutral > a.nonNeutral ? b : a));
    expressiveMoments.push({ clusterIndex, localT: best.tLocal, score: best.nonNeutral });
  });

  return { faceCount: slots.length, slots, expressiveMoments, confidence };
}

// Splits the clip into chunks and detects people separately in each, so the layout can switch
// (full <-> split, or between different people) at points where the scene actually changes,
// instead of one static layout for the whole clip. Uses fewer samples per chunk than a single
// full-clip detection would, to keep the added cost bounded.
//
// Maintains a `prior` (previous chunk's topology/slots) across the loop to smooth out noise:
// occlusion (0 faces detected but a prior exists) carries the prior forward instead of
// collapsing to the hardcoded center-crop fallback; when topology is unchanged, slot
// positions are EMA-blended instead of jumping; when topology changes, it must repeat for
// CONFIRM_CHUNKS consecutive chunks (or arrive with very high confidence) before being
// adopted, so one noisy chunk can't flip the whole clip's layout.
async function detectLayoutTimeline(videoPath, absStart, length, tmpDir, srcW, srcH, chunkSec = 12, reactionComposite = null) {
  const chunks = [];
  let t = 0;
  while (t < length) {
    let end = Math.min(length, t + chunkSec);
    if (length - end < chunkSec * 0.4) end = length; // fold a short tail into the last chunk
    chunks.push({ start: t, end });
    t = end;
  }

  const ALPHA = 0.35;
  const CONFIRM_CHUNKS = 2;
  const HIGH_CONFIDENCE = 0.7;

  const result = [];
  let prior = null; // { faceCount, slots }
  let pendingTopology = null;
  let pendingStreak = 0;

  const restrictToBox = reactionComposite?.isReactionComposite ? reactionComposite.facecamBox : undefined;

  for (const c of chunks) {
    const seedCentroids = prior && prior.slots.length ? prior.slots.map((s) => s.cx) : undefined;
    const raw = await detectPeopleInWindow(
      videoPath, absStart + c.start, c.end - c.start, tmpDir, srcW, srcH, 3,
      { restrictToBox, seedCentroids }
    );

    let people;
    if (raw.faceCount === 0 && prior) {
      people = { ...prior, expressiveMoments: [], occluded: true, confidence: 0 };
    } else if (prior && raw.faceCount === prior.faceCount) {
      const slots = raw.slots.map((s, i) => {
        const p = prior.slots[i];
        if (!p) return s;
        return {
          cx: ALPHA * s.cx + (1 - ALPHA) * p.cx,
          cy: ALPHA * s.cy + (1 - ALPHA) * p.cy,
          w: ALPHA * s.w + (1 - ALPHA) * p.w,
          h: ALPHA * s.h + (1 - ALPHA) * p.h,
          landmarkBox: s.landmarkBox || p.landmarkBox,
        };
      });
      people = { faceCount: raw.faceCount, slots, expressiveMoments: raw.expressiveMoments, confidence: raw.confidence };
      pendingTopology = null;
      pendingStreak = 0;
    } else if (prior) {
      if (raw.confidence >= HIGH_CONFIDENCE) {
        people = raw;
        pendingTopology = null;
        pendingStreak = 0;
      } else if (pendingTopology === raw.faceCount) {
        pendingStreak++;
        if (pendingStreak >= CONFIRM_CHUNKS) {
          people = raw;
          pendingTopology = null;
          pendingStreak = 0;
        } else {
          people = { ...prior, expressiveMoments: raw.expressiveMoments, confidence: prior.confidence };
        }
      } else {
        pendingTopology = raw.faceCount;
        pendingStreak = 1;
        people = { ...prior, expressiveMoments: raw.expressiveMoments, confidence: prior.confidence };
      }
    } else {
      people = raw; // first chunk, nothing to smooth against yet
    }

    result.push({ start: c.start, end: c.end, people });
    if (!people.occluded) prior = { faceCount: people.faceCount, slots: people.slots, confidence: people.confidence };
  }
  return result;
}

// CV-only fallback reaction-composite detector, used when no vision-LLM classification is
// available for this candidate (no API key, or the vision budget was already spent
// elsewhere). Samples sparsely across the WHOLE window (not one chunk) and looks for a
// face cluster whose position barely moves across samples — a real facecam overlay sits
// at a fixed screen position for the entire stream; a real second person doesn't. This
// cannot reliably distinguish an overlay from a genuinely motionless tripod-mounted talking
// head, which is why callers must gate this path behind a HIGHER confidence threshold than
// the vision-LLM path.
async function detectReactionComposite(videoPath, absStart, length, tmpDir, srcW, srcH, opts = {}) {
  const none = { isReactionComposite: false, facecamBox: null, confidence: 0, source: 'cv-fallback' };
  if (!tryInit()) return none;
  try {
    await ensureModels();
  } catch (err) {
    return none;
  }

  const sampleCount = opts.sampleCount ?? 9;
  const points = [];
  for (let i = 0; i < sampleCount; i++) {
    const tAbs = absStart + (length * (i + 0.5)) / sampleCount;
    const framePath = path.join(tmpDir, `composite_sample_${i}.jpg`);
    try {
      await extractFrame(videoPath, tAbs, framePath);
      const img = await canvas.loadImage(framePath);
      const detections = await faceapi
        .detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.22 }))
        .withFaceLandmarks(true);
      const raw = detections.map((d) => {
        const eye = eyeCenter(d.landmarks, img.width, img.height);
        return {
          cx: eye.cx, cy: eye.cy,
          w: d.detection.box.width / img.width, h: d.detection.box.height / img.height,
          score: d.detection.score, sampleIndex: i,
        };
      });
      dedupeFaces(raw).forEach((f) => points.push(f));
    } catch (err) {
      // one bad sample shouldn't fail the whole detection
    } finally {
      fs.existsSync(framePath) && fs.unlinkSync(framePath);
    }
  }

  if (!points.length) return none;

  const clusters = greedyCluster2D(points, 0.1);
  let best = null;
  let bestScore = -Infinity;
  for (const c of clusters) {
    const sampleIdx = new Set(c.points.map((p) => p.sampleIndex));
    const agreementFrac = sampleIdx.size / sampleCount;
    const cxs = c.points.map((p) => p.cx);
    const cys = c.points.map((p) => p.cy);
    const spreadCx = Math.max(...cxs) - Math.min(...cxs);
    const spreadCy = Math.max(...cys) - Math.min(...cys);
    const spreadMax = Math.max(spreadCx, spreadCy);
    if (spreadMax >= 0.06 || agreementFrac < 0.6) continue;
    const score = agreementFrac * (1 - spreadMax / 0.06);
    if (score > bestScore) {
      bestScore = score;
      best = { cx: c.cx, cy: c.cy, agreementFrac, spreadMax, points: c.points };
    }
  }

  if (!best) return none;

  const avgW = best.points.reduce((a, p) => a + p.w, 0) / best.points.length;
  const avgH = best.points.reduce((a, p) => a + p.h, 0) / best.points.length;
  const padScale = 2.4;
  let x0 = best.cx - (avgW * padScale) / 2;
  let y0 = best.cy - (avgH * padScale) / 2;
  let x1 = best.cx + (avgW * padScale) / 2;
  let y1 = best.cy + (avgH * padScale) / 2;
  if (x0 < 0.08) x0 = 0;
  if (y0 < 0.08) y0 = 0;
  if (x1 > 0.92) x1 = 1;
  if (y1 > 0.92) y1 = 1;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);

  const confidence = Math.max(0, Math.min(1, bestScore));
  return {
    isReactionComposite: true,
    facecamBox: { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 },
    confidence,
    source: 'cv-fallback',
  };
}

// Cheap pre-check (ONE small low-res frame, not the 9 full-size samples
// detectReactionComposite needs) used to skip the expensive composite scan entirely when a
// window clearly has no face in it at all — a facecam composite is impossible without one.
// Fails OPEN (returns true, i.e. "maybe a face, don't skip") on any error, so a probe
// failure can never silently suppress real composite detection.
async function quickHasAnyFace(videoPath, tAbs, tmpDir) {
  if (!tryInit()) return true;
  try {
    await ensureModels();
  } catch (err) {
    return true;
  }
  const framePath = path.join(tmpDir, `probe_${Math.round(tAbs * 10)}.jpg`);
  try {
    await extractFrame(videoPath, tAbs, framePath, { maxWidth: 480 });
    const img = await canvas.loadImage(framePath);
    const detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }));
    return detections.length > 0;
  } catch (err) {
    return true;
  } finally {
    fs.existsSync(framePath) && fs.unlinkSync(framePath);
  }
}

module.exports = {
  detectPeopleInWindow, detectLayoutTimeline, detectReactionComposite, quickHasAnyFace,
  validateFaceCrop, faceLandmarkBoxPx, clusterByX,
  isAvailable: () => available,
};
