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

// 1D k-means on x-position, weighted by detection score. Returns k centroids (sorted L-to-R)
// and the index of the nearest centroid for every input point.
function clusterByX(points, k) {
  if (!points.length) return { centroids: [], assign: [] };
  const xs = points.map((p) => p.cx);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  let centroids = Array.from({ length: k }, (_, i) => min + ((max - min) * (i + 0.5)) / k);
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

// Samples frames inside [start, start+length] of the video, detects faces with landmarks +
// expressions, and returns up to 3 left-to-right "slots" plus any notable expression spikes
// (used for reaction cutaways). All returned times are LOCAL to the window (0..length).
async function detectPeopleInWindow(videoPath, start, length, tmpDir, srcW, srcH, sampleCount = 6) {
  const fallback = { faceCount: 0, slots: [{ cx: 0.5, cy: 0.42, w: 0.3, h: 0.3 }], expressiveMoments: [] };

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
        };
      });
      // The looser detector threshold can yield two overlapping boxes for one real face;
      // collapse near-duplicates within a single frame before counting them as separate people.
      const faces = dedupeFaces(rawFaces);
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
  console.log(`[facedetect] decision -> faceCount=${faceCount} (needed >=${minSupport} samples in support)`);

  const { centroids, assign } = clusterByX(allPoints, faceCount);
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

  return { faceCount: slots.length, slots, expressiveMoments };
}

// Splits the clip into chunks and detects people separately in each, so the layout can switch
// (full <-> split, or between different people) at points where the scene actually changes,
// instead of one static layout for the whole clip. Uses fewer samples per chunk than a single
// full-clip detection would, to keep the added cost bounded.
async function detectLayoutTimeline(videoPath, absStart, length, tmpDir, srcW, srcH, chunkSec = 12) {
  const chunks = [];
  let t = 0;
  while (t < length) {
    let end = Math.min(length, t + chunkSec);
    if (length - end < chunkSec * 0.4) end = length; // fold a short tail into the last chunk
    chunks.push({ start: t, end });
    t = end;
  }

  const result = [];
  for (const c of chunks) {
    const people = await detectPeopleInWindow(videoPath, absStart + c.start, c.end - c.start, tmpDir, srcW, srcH, 3);
    result.push({ start: c.start, end: c.end, people });
  }
  return result;
}

module.exports = { detectPeopleInWindow, detectLayoutTimeline, isAvailable: () => available };
