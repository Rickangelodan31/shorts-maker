const { run, FFMPEG_BIN } = require('./ffutil');
const { nearestPauseSnap, nextPauseAfter } = require('./highlight');

const HOP_SEC = 0.5; // matches highlight.js's HOP_SEC so audio/visual timelines line up

// One additional cheap ffmpeg pass, same class of cost as the audio-energy pass: downscale
// to a tiny proxy resolution and a low fixed frame rate, then use ffmpeg's built-in scene-
// change score (NOT a per-frame ML model) as a "visual interest" signal independent of
// transcript/audio. This is what lets a silent visual gag or gameplay event surface as a
// candidate even when it has no loudness/keyword signal at all.
async function computeVisualInterestTimeline(videoPath, totalDuration, hopSec = HOP_SEC) {
  const nBins = Math.max(1, Math.ceil(totalDuration / hopSec));
  const visualInterest = new Array(nBins).fill(0);

  try {
    const { stdout } = await run(FFMPEG_BIN, [
      '-i', videoPath,
      '-vf', "fps=4,scale=160:-2,select='gte(scene,0)',metadata=print:file=-",
      '-f', 'null', '-',
    ]);

    let pendingPtsTime = null;
    for (const line of stdout.split('\n')) {
      const ptsMatch = line.match(/pts_time:([\d.]+)/);
      if (ptsMatch) {
        pendingPtsTime = parseFloat(ptsMatch[1]);
        continue;
      }
      const sceneMatch = line.match(/lavfi\.scene_score=([\d.]+)/);
      if (sceneMatch && pendingPtsTime !== null) {
        const bin = Math.min(nBins - 1, Math.floor(pendingPtsTime / hopSec));
        const score = parseFloat(sceneMatch[1]);
        if (score > visualInterest[bin]) visualInterest[bin] = score; // peak per bin, not average
      }
    }
  } catch (err) {
    console.warn('[visualscan] scene-score pass failed, proceeding with an all-zero visual timeline:', err.message);
  }

  return { visualInterest, hopSec };
}

// Same peak-detection/expand/snap shape as highlight.js:findHighlightClips, keyed off
// visual interest instead of audio+keyword interest. Boundary pause-snapping still uses
// the transcript (captions must stay aligned to real speech gaps even for a silent-visual
// candidate window that happens to have some speech near its edges).
function findVisualHighlightClips(visualInterest, hopSec, totalDuration, words, maxClips = 15, opts = {}) {
  const MIN_LEN = opts.minLen || 60;
  const SOFT_MAX_LEN = opts.softMaxLen || 90;
  const HARD_MAX_LEN = opts.hardMaxLen || 120;

  if (totalDuration <= MIN_LEN) return [];

  const n = visualInterest.length;
  const avgInterest = visualInterest.reduce((a, b) => a + b, 0) / Math.max(1, n);
  if (avgInterest <= 0) return []; // nothing detected (scene-score pass unavailable/failed)

  const minSpacingHops = Math.round((MIN_LEN * 0.6) / hopSec);
  const order = visualInterest.map((v, i) => i).sort((a, b) => visualInterest[b] - visualInterest[a]);
  const peakHops = [];
  for (const idx of order) {
    if (visualInterest[idx] <= 0) break; // sorted descending; nothing further is a real peak
    if (peakHops.some((p) => Math.abs(p - idx) < minSpacingHops)) continue;
    peakHops.push(idx);
    if (peakHops.length >= maxClips * 3) break;
  }

  const clips = [];
  for (const peakHop of peakHops) {
    const peakVal = visualInterest[peakHop];
    const threshold = Math.max(avgInterest * 1.05, peakVal * 0.35);
    let lo = peakHop;
    let hi = peakHop;
    const hardMaxHops = Math.round(HARD_MAX_LEN / hopSec);
    while (hi - lo < hardMaxHops) {
      const canLeft = lo > 0 && visualInterest[lo - 1] >= threshold;
      const canRight = hi < n - 1 && visualInterest[hi + 1] >= threshold;
      if (!canLeft && !canRight) break;
      if (canLeft) lo--;
      if (hi - lo >= hardMaxHops) break;
      if (canRight) hi++;
    }

    let start = lo * hopSec;
    let end = hi * hopSec;
    if (end - start < MIN_LEN) {
      const mid = peakHop * hopSec;
      start = Math.max(0, mid - MIN_LEN / 2);
      end = Math.min(totalDuration, start + MIN_LEN);
      start = Math.max(0, end - MIN_LEN);
    } else if (end - start > SOFT_MAX_LEN) {
      const mid = peakHop * hopSec;
      start = Math.max(0, mid - SOFT_MAX_LEN / 2);
      end = Math.min(totalDuration, start + SOFT_MAX_LEN);
      start = Math.max(0, end - SOFT_MAX_LEN);
    }

    start = Math.max(0, nearestPauseSnap(words, start, 2.5));
    const snappedEnd = nearestPauseSnap(words, end, 1.2);
    if (Math.abs(snappedEnd - end) < 1.2) {
      end = snappedEnd;
    } else {
      const forced = nextPauseAfter(words, end, Math.min(totalDuration, start + HARD_MAX_LEN));
      end = forced != null ? forced : Math.min(totalDuration, start + MIN_LEN);
    }
    end = Math.min(totalDuration, end);
    if (end <= start) continue;
    const length = end - start;
    if (length < MIN_LEN * 0.7) continue;

    const startHop = Math.round(start / hopSec);
    const endHop = Math.round(end / hopSec);
    const slice = visualInterest.slice(startHop, Math.max(startHop + 1, endHop));
    const score = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
    clips.push({ start, end, length, score, source: 'visual' });
  }

  clips.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of clips) {
    const overlaps = picked.some((p) => {
      const overlap = Math.min(p.end, c.end) - Math.max(p.start, c.start);
      return overlap > Math.min(p.length, c.length) * 0.4;
    });
    if (!overlaps) picked.push(c);
    if (picked.length >= maxClips) break;
  }
  return picked;
}

module.exports = { computeVisualInterestTimeline, findVisualHighlightClips };
