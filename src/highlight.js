const fs = require('fs');
const wav = require('node-wav');
const { extractAudioWav } = require('./ffutil');

const HOP_SEC = 0.5; // resolution of the energy timeline

// Decode the wav and compute RMS loudness per HOP_SEC window across the whole track.
function computeEnergyTimeline(wavPath) {
  const buf = fs.readFileSync(wavPath);
  const decoded = wav.decode(buf);
  const samples = decoded.channelData[0]; // mono
  const sr = decoded.sampleRate;
  const hopSamples = Math.round(HOP_SEC * sr);
  const energy = [];
  for (let i = 0; i < samples.length; i += hopSamples) {
    let sumSq = 0;
    const end = Math.min(i + hopSamples, samples.length);
    for (let j = i; j < end; j++) sumSq += samples[j] * samples[j];
    const rms = Math.sqrt(sumSq / Math.max(1, end - i));
    energy.push(rms);
  }
  return { energy, hopSec: HOP_SEC };
}

// Optional: keyword/exclamation based "emotional" boost from a transcript with segment timestamps.
// transcriptSegments: [{ start, end, text }]
const EXCITEMENT_WORDS = [
  'wow', 'insane', 'crazy', 'no way', 'what', 'oh my god', 'omg', 'unbelievable',
  'let\'s go', 'lets go', 'incredible', 'amazing', 'yes', 'holy', 'huge', 'clutch',
  'love', 'haha', 'lol', 'funny', 'hilarious', 'best', 'worst', 'never', 'shocking',
];

function transcriptScoreAt(transcriptSegments, tStart, tEnd) {
  if (!transcriptSegments || !transcriptSegments.length) return 0;
  let score = 0;
  for (const seg of transcriptSegments) {
    if (seg.end < tStart || seg.start > tEnd) continue;
    const text = (seg.text || '').toLowerCase();
    const exclaims = (text.match(/!/g) || []).length;
    score += exclaims * 0.5;
    for (const w of EXCITEMENT_WORDS) {
      if (text.includes(w)) score += 1;
    }
  }
  return score;
}

// Scores every sliding window of `lengthSec` and returns up to `maxCandidates` non-overlapping
// windows, best first (used both for the initial pick and for "generate more" requests).
function bestWindows(energy, hopSec, totalDuration, lengthSec, transcriptSegments, stepSec = 5, maxCandidates = 5) {
  if (totalDuration <= lengthSec) return [{ start: 0, length: totalDuration, score: 0 }];

  const hopsPerWindow = Math.round(lengthSec / hopSec);
  const scored = [];

  for (let t = 0; t + lengthSec <= totalDuration; t += stepSec) {
    const startHop = Math.round(t / hopSec);
    let sum = 0;
    let peakDelta = 0;
    for (let h = startHop; h < startHop + hopsPerWindow && h < energy.length; h++) {
      sum += energy[h];
      if (h > startHop) {
        const d = Math.abs(energy[h] - energy[h - 1]);
        if (d > peakDelta) peakDelta = d;
      }
    }
    const avg = sum / hopsPerWindow;
    const audioScore = avg + 0.5 * peakDelta;
    const textScore = transcriptScoreAt(transcriptSegments, t, t + lengthSec) * 0.02;
    scored.push({ start: t, length: lengthSec, score: audioScore + textScore });
  }

  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  for (const cand of scored) {
    const overlaps = picked.some((p) => {
      const overlap = Math.min(p.start + p.length, cand.start + cand.length) - Math.max(p.start, cand.start);
      return overlap > lengthSec * 0.5;
    });
    if (!overlaps) picked.push(cand);
    if (picked.length >= maxCandidates) break;
  }
  return picked;
}

// Convenience: just the single best window.
function bestWindow(energy, hopSec, totalDuration, lengthSec, transcriptSegments, stepSec = 5) {
  return bestWindows(energy, hopSec, totalDuration, lengthSec, transcriptSegments, stepSec, 1)[0];
}

function nearestPauseSnap(words, t, windowSec) {
  if (!words || !words.length) return t;
  let best = t;
  let bestDist = Infinity;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap < 0.3) continue;
    const mid = (words[i].start + words[i - 1].end) / 2;
    const d = Math.abs(mid - t);
    if (d < windowSec && d < bestDist) {
      bestDist = d;
      best = mid;
    }
  }
  return best;
}

// Finds the next speech pause (word gap) at or after `t`, capped at `maxT`. Returns null if
// none turns up in range (caller then flattens to a fixed length instead of guessing further).
function nextPauseAfter(words, t, maxT) {
  if (!words || !words.length) return null;
  for (let i = 1; i < words.length; i++) {
    if (words[i - 1].end < t) continue;
    if (words[i - 1].start > maxT) return null;
    const gap = words[i].start - words[i - 1].end;
    if (gap >= 0.3) {
      const mid = (words[i].start + words[i - 1].end) / 2;
      return mid <= maxT ? mid : null;
    }
  }
  return null;
}

// AI picks the clip length per moment instead of a fixed preset: finds up to `maxClips`
// highlight peaks, then expands each outward while interest stays high, snapping edges to
// nearby speech pauses so clips don't start/end mid-word. Returns clips sorted best-first.
function findHighlightClips(energy, hopSec, totalDuration, words, maxClips = 15, opts = {}) {
  // Target a flat 60s by default; only stretch longer when a moment's interest genuinely
  // stays elevated past it, or a sentence/thought is left unfinished right at the 60s mark.
  const MIN_LEN = opts.minLen || 60;
  const SOFT_MAX_LEN = opts.softMaxLen || 90;
  const HARD_MAX_LEN = opts.hardMaxLen || 120;

  if (totalDuration <= MIN_LEN) {
    return [{ start: 0, end: totalDuration, length: totalDuration, score: 0 }];
  }

  const n = energy.length;
  const textBoost = new Array(n).fill(0);
  if (words && words.length) {
    for (const w of words) {
      const idx = Math.round(w.start / hopSec);
      const text = (w.text || '').toLowerCase();
      if (EXCITEMENT_WORDS.some((k) => text.includes(k)) && idx >= 0 && idx < n) {
        textBoost[idx] += 1.5;
      }
    }
  }
  const interest = energy.map((e, i) => e + textBoost[i] * 0.3);
  const avgInterest = interest.reduce((a, b) => a + b, 0) / Math.max(1, n);

  const minSpacingHops = Math.round((MIN_LEN * 0.6) / hopSec);
  const order = interest.map((v, i) => i).sort((a, b) => interest[b] - interest[a]);
  const peakHops = [];
  for (const idx of order) {
    if (peakHops.some((p) => Math.abs(p - idx) < minSpacingHops)) continue;
    peakHops.push(idx);
    if (peakHops.length >= maxClips * 3) break;
  }

  const clips = [];
  for (const peakHop of peakHops) {
    const peakVal = interest[peakHop];
    const threshold = Math.max(avgInterest * 1.05, peakVal * 0.35);
    let lo = peakHop;
    let hi = peakHop;
    const hardMaxHops = Math.round(HARD_MAX_LEN / hopSec);
    while (hi - lo < hardMaxHops) {
      const canLeft = lo > 0 && interest[lo - 1] >= threshold;
      const canRight = hi < n - 1 && interest[hi + 1] >= threshold;
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

    // If `end` lands mid-sentence (no natural pause nearby), the thought isn't finished —
    // push forward to the next real pause instead of cutting it off. If no pause turns up
    // reasonably soon either, just settle for a flat MIN_LEN (60s) rather than an odd stub.
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
    const slice = interest.slice(startHop, Math.max(startHop + 1, endHop));
    const score = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
    clips.push({ start, end, length, score });
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

async function analyzeAudio(videoPath, tmpWavPath) {
  await extractAudioWav(videoPath, tmpWavPath);
  return computeEnergyTimeline(tmpWavPath);
}

module.exports = { analyzeAudio, bestWindow, bestWindows, findHighlightClips, computeEnergyTimeline };
