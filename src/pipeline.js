const fs = require('fs');
const path = require('path');
const os = require('os');
const { probe, extractAudioWav, extractFrame } = require('./ffutil');
const { findHighlightClips, computeEnergyTimeline } = require('./highlight');
const { computeVisualInterestTimeline, findVisualHighlightClips } = require('./visualscan');
const { mergeCandidatePools, selectCandidatesForSemanticPass } = require('./candidates');
const semantic = require('./semantic');
const { transcribeIfAvailable } = require('./transcribe');
const { detectLayoutTimeline, detectReactionComposite, quickHasAnyFace } = require('./facedetect');
const { renderSegmented } = require('./render');
const { planClipSegments, mapUserTypeToLayout } = require('./effects');
const { buildCaptionsAss } = require('./captions');
const { probeUrlMeta, downloadAudioOnly, downloadSection, downloadLowResVideoProxy } = require('./ingest');
const captionAi = require('./captionAi/generator');
const critic = require('./critic');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const AUTO_CLIP_COUNT = 10;
const CANDIDATE_POOL = 20;
// Scene-change score is noisy — most visually-"different" moments in edited footage are
// editorially meaningless. The visual pool gets a smaller raw cap than the audio pool
// (further trimmed again in candidates.js's semantic-pass selection).
const VISUAL_CANDIDATE_POOL = 10;
// Plan doc M8 — URL job visual-candidate parity. A low-res whole-video proxy download is
// only attempted under this duration ceiling (default 30min), so a multi-hour VOD doesn't
// silently trigger a large extra download just for the visual scan — a real, stated
// bandwidth/latency tradeoff, not hidden behind a always-on default. Above the ceiling (or on
// any failure), URL jobs fall back to today's exact audio-only candidate behavior.
const URL_VISUAL_PROXY_MAX_DURATION_SEC = parseFloat(process.env.URL_VISUAL_PROXY_MAX_DURATION_SEC || '1800');

// Pure gate — no I/O — so it's directly testable without touching yt-dlp/ffmpeg. Same
// DISABLE_VISUAL_SCAN flag already gates the upload path, so one env var controls both.
function shouldAttemptUrlVisualProxy(durationSec, maxDurationSec = URL_VISUAL_PROXY_MAX_DURATION_SEC) {
  if (process.env.DISABLE_VISUAL_SCAN === '1') return false;
  return typeof durationSec === 'number' && durationSec > 0 && durationSec <= maxDurationSec;
}

// Sets the job-level status shown in the UI before any clip exists: `message` is the short
// editorial headline, `detail` the plain-language explanation of what's actually happening
// right now. Kept as one helper so every stage uses the same two-line shape consistently.
function setStatus(job, message, detail) {
  job.message = message;
  job.detail = detail;
}

// Plan doc M8 — downloads a low-res whole-video proxy and runs the SAME
// computeVisualInterestTimeline the upload path already uses, for a URL job. Returns null
// (never throws) whenever the job is over the duration ceiling or ANY step fails — the
// caller must treat null exactly like "no visual signal," falling back to today's exact
// pre-M8 audio-only URL behavior. `deps` (optional): override downloadLowResVideoProxy/
// computeVisualInterestTimeline for testing — production call sites never pass it, so they
// always use the real implementations.
async function tryBuildUrlVisualInterest(url, jobId, jobTmp, durationSec, onProgress, deps = {}) {
  if (!shouldAttemptUrlVisualProxy(durationSec)) return null;
  const download = deps.downloadLowResVideoProxy || downloadLowResVideoProxy;
  const scan = deps.computeVisualInterestTimeline || computeVisualInterestTimeline;
  let proxyPath = null;
  try {
    proxyPath = await download(url, jobId, jobTmp, onProgress);
    return await scan(proxyPath, durationSec);
  } catch (err) {
    console.warn(`[stage=generate] URL visual proxy scan failed, falling back to audio-only candidates: ${err.message}`);
    return null;
  } finally {
    if (proxyPath) fs.rm(proxyPath, () => {});
  }
}

const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length - 1));
// Plan doc M7 — denser face-detection keyframes (down from the original 12s), applied ONLY
// here in renderOneClip — i.e. only for a candidate that has already passed vision-veto and
// is actually about to render, never during the cheap selection-scan phase (which never
// calls detectLayoutTimeline at all). This is what buildKeyframesForRun (effects.js) needs
// to have enough distinct chunks per merged run to pan smoothly instead of falling back to
// today's static-per-run crop.
const LAYOUT_CHUNK_SEC = parseFloat(process.env.LAYOUT_CHUNK_SEC || '6');
// Vision calls are network-bound (not CPU-bound), so a slightly higher bound than render
// concurrency is safe here, but still capped so we don't hammer the API or spawn unbounded
// ffmpeg frame-extraction processes at once.
const VISION_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.SEMANTIC_VISION_CONCURRENCY || '3', 10)));
// Secondary reordering weight for Stage 2's emotionalImportance signal (see the promotion
// loop below) — deliberately small; a nudge/tiebreaker among already-vision-checked
// candidates, not a re-ranking engine.
const CUT_SCORE_WEIGHT_VISUAL_IMPORTANCE = parseFloat(process.env.CUT_SCORE_WEIGHT_VISUAL_IMPORTANCE || '0.06');

// Plan doc M2 — an OPT-IN minimum-quality floor for the final promotion loop below. `null`
// (the default) disables it entirely, which reproduces today's exact selection-count
// behavior (fill to autoCount from promotionOrder, including unchecked/unvetoed candidates
// near the tail, exactly as before). Evaluated ONLY against `candidate.cutScore` — the
// pre-existing baseline signal, already inclusive of M1's momentSignalBonus when available —
// never against momentSignals directly, so a candidate can never be independently rejected
// merely because M1's LLM signal was missing or partial.
const MIN_CLIP_QUALITY_FLOOR = process.env.MIN_CLIP_QUALITY_FLOOR != null && process.env.MIN_CLIP_QUALITY_FLOOR !== ''
  ? parseFloat(process.env.MIN_CLIP_QUALITY_FLOOR)
  : null;

// `floor` defaults to the env-configured constant above — the promotion loop's real call
// site (`passesQualityFloor(cand)`) always uses that default. The explicit second parameter
// exists purely so tests can exercise the "floor enabled" branch deterministically without
// needing to set an env var before this module is first required.
function passesQualityFloor(candidate, floor = MIN_CLIP_QUALITY_FLOOR) {
  if (floor == null) return true;
  return candidate.cutScore >= floor;
}

// Plan doc M2 — a lightweight editorial category derived ONLY from signals that already
// exist (M1's momentSignals when available, else the pre-existing semanticEvent emotion
// fields) — never a new classification pass. Used only to diversify PROMOTION ORDER among
// candidates that have already survived time-overlap dedup (semantic.dedupeByOverlap, applied
// upstream in runPipeline before job.candidates is ever built) — it cannot resurrect or admit
// an overlapping candidate, only reorder which of the already-distinct ones goes first.
const MOMENT_CATEGORY_DIMENSIONS = [
  { key: 'humor', category: 'funniest' },
  { key: 'surprise', category: 'surprising' },
  { key: 'payoff_strength', category: 'strongest story' },
  { key: 'controversy', category: 'controversial' },
  { key: 'hook_strength', category: 'strongest hook' },
  { key: 'quotability', category: 'quotable' },
];
const MOMENT_CATEGORY_MIN_SIGNAL = parseFloat(process.env.MOMENT_CATEGORY_MIN_SIGNAL || '0.6');
const EMOTION_FALLBACK_CATEGORY = { joy: 'funny/joyful', surprise: 'surprising', anger: 'intense', sadness: 'emotional', fear: 'intense', disgust: 'intense' };

function deriveMomentCategory(candidate) {
  const signals = candidate.momentSignals;
  let best = null;
  if (signals) {
    for (const { key, category } of MOMENT_CATEGORY_DIMENSIONS) {
      const v = signals[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= MOMENT_CATEGORY_MIN_SIGNAL && (!best || v > best.value)) {
        best = { category, value: v };
      }
    }
  }
  if (best) return best.category;
  const emotion = candidate.semanticEvent?.primary_emotion;
  const intensity = candidate.semanticEvent?.emotion_intensity || 0;
  if (emotion && emotion !== 'neutral' && intensity >= 0.5) return EMOTION_FALLBACK_CATEGORY[emotion] || 'emotional';
  return 'general';
}

// Reorders `promotionOrder` (a permutation of job.candidates indices — never adds or removes
// an entry) so the single best-remaining candidate from each distinct category is promoted
// before a second candidate from an already-represented category. Round-robins across
// categories in the order their best candidate first appears in promotionOrder (i.e.
// category "priority" falls straight out of the existing cutScore-based order — no separate
// category ranking is invented). When every candidate falls into ONE category (the universal
// case until M1's LLM signal is available), this degenerates to a single round-robin "round"
// per candidate in original order — i.e. it is a stable no-op, provably identical to
// `promotionOrder` unchanged.
function buildDiverseOrder(candidates, promotionOrder) {
  const byCategory = new Map();
  for (const poolIndex of promotionOrder) {
    const category = deriveMomentCategory(candidates[poolIndex]);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(poolIndex);
  }
  const categoryOrder = [...byCategory.keys()];
  const cursors = new Map(categoryOrder.map((c) => [c, 0]));
  const result = [];
  let remaining = promotionOrder.length;
  while (remaining > 0) {
    for (const category of categoryOrder) {
      const list = byCategory.get(category);
      const cursor = cursors.get(category);
      if (cursor < list.length) {
        result.push(list[cursor]);
        cursors.set(category, cursor + 1);
        remaining--;
      }
    }
  }
  return result;
}

// Plan doc M5 — safety bound on how many extra renders a run of critic rejections can trigger
// in one job. Backfill is otherwise naturally bounded by the candidate pool, but a
// pathologically bad source video (everything genuinely gets rejected) must not silently
// balloon into rendering far more clips than requested — better to honestly return fewer
// clips (same philosophy as M2's quality floor) than to keep paying for renders forever.
const MAX_CRITIC_BACKFILL_ATTEMPTS = parseInt(process.env.MAX_CRITIC_BACKFILL_ATTEMPTS || String(AUTO_CLIP_COUNT), 10);

// The actual bookkeeping for one critic verdict, separated from the render/critic I/O calls
// so it's directly testable. On 'reject': deletes the rendered artifact and removes `entry`
// from `job.results` SYNCHRONOUSLY (no `await` between the decision and the removal) — since
// Node is single-threaded, no other code (an HTTP handler reading job.results, a concurrent
// mapLimit worker) can ever observe `entry` sitting in job.results with a rejected verdict;
// there is structurally nothing left for a consumer to render. `verdict` absent (critic
// unavailable/failed) or `verdict.verdict === 'pass'` NEVER triggers this path — only an
// explicit 'reject' does. Returns true iff a backfill slot was opened.
function applyCriticVerdict(job, entry, verdict, outputDir = OUTPUT_DIR) {
  if (!verdict) return false;
  if (verdict.verdict !== 'reject') {
    entry.criticVerdict = verdict;
    return false;
  }
  console.log(`[stage=critic] candidate=${entry.candidateIndex} REJECTED reasons=${JSON.stringify(verdict.reasons || [])} confidence=${verdict.confidence}`);
  const idx = job.results.indexOf(entry);
  if (idx >= 0) job.results.splice(idx, 1);
  const outputPath = path.join(outputDir, job.id, `short_${entry.candidateIndex}.mp4`);
  fs.rm(outputPath, () => {});
  return true;
}

// Simple counting semaphore. Unlike `mapLimit` (which only bounds concurrency WITHIN one
// call), an instance of this held at module scope is shared across every job this process
// ever handles, since the module is loaded once. That's the fix for a real problem: nothing
// previously stopped a second submitted job from running its own full CONCURRENCY batch of
// ffmpeg renders and VISION_CONCURRENCY batch of yt-dlp downloads WHILE a first job's were
// still in flight — two jobs at once silently doubled total concurrent heavy processes, and
// that's what exhausted system memory and made the server briefly stop accepting connections.
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.current >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.current++;
    try {
      return await fn();
    } finally {
      this.current--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// Bounds TOTAL concurrent heavy work (video downloads + ffmpeg encodes) across every job
// this process is handling at once, not per-job. Deliberately NOT sized purely off CPU
// core count — each ffmpeg encode/yt-dlp download process uses several hundred MB of RAM,
// and core count says nothing about available memory (this app was observed getting the
// system down to ~100MB free with only 2-3 concurrent processes on an 8-core/8GB machine).
// Configurable via env for machines with more headroom.
const HEAVY_OP_LIMIT = Math.max(1, parseInt(process.env.HEAVY_OP_LIMIT || '2', 10));
const heavyOps = new Semaphore(HEAVY_OP_LIMIT);

// Runs `fn` over `items` with at most `limit` in flight at once.
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function candidateTmpDir(ctx, poolIndex) {
  return path.join(ctx.jobTmp, `cand_${poolIndex}`);
}

// Resolves (and, for URL jobs, downloads) the actual source media for one candidate window,
// cached on the candidate itself so vision validation (selection phase) and the eventual
// render (if accepted) never pay for the download/probe twice. This is the concrete
// "cache-as-invariant" mechanism: the LLM (and the section download it depends on for URL
// jobs) is paid for at most once per candidate window per job.
async function prepareCandidateSource(ctx, job, poolIndex) {
  const cand = job.candidates[poolIndex];
  if (cand._prepared) return cand._prepared;

  const clipTmp = candidateTmpDir(ctx, poolIndex);
  fs.mkdirSync(clipTmp, { recursive: true });
  const win = { start: cand.start, length: cand.length };

  let sourceForRender, seek, widthForCrop, heightForCrop, detectBase;
  if (ctx.isUrl) {
    sourceForRender = await heavyOps.run(() => downloadSection(
      ctx.url, job.id, poolIndex, win.start, win.start + win.length, ctx.jobTmp, () => {}
    ));
    const localInfo = await probe(sourceForRender);
    seek = 0;
    widthForCrop = localInfo.width;
    heightForCrop = localInfo.height;
    detectBase = 0;
    win.length = localInfo.duration;
  } else {
    sourceForRender = ctx.sourcePath;
    seek = win.start;
    widthForCrop = ctx.info.width;
    heightForCrop = ctx.info.height;
    detectBase = win.start;
  }

  cand._prepared = { sourceForRender, seek, widthForCrop, heightForCrop, detectBase, clipTmp, win };
  return cand._prepared;
}

// STAGE 2 (vision validation), invoked lazily and cached on the candidate — never re-runs
// for a candidate that already has a visionReport (undefined = never attempted, null =
// attempted but LLM unavailable/failed, object = a real report). Hook-selection frames are
// requested at a small proxy width: a vision call at 'low' detail downsamples internally
// anyway, so there's no benefit to decoding/encoding a full-resolution JPEG here.
async function validateCandidateVision(ctx, cand, prepared) {
  if (cand.visionReport !== undefined) return cand.visionReport;
  if (!semantic.isAvailable()) {
    cand.visionReport = null;
    return null;
  }

  const localWords = ctx.words
    .filter((w) => w.start >= prepared.win.start - 0.2 && w.end <= prepared.win.start + prepared.win.length + 0.2)
    .map((w) => ({
      start: Math.max(0, w.start - prepared.win.start),
      end: Math.min(prepared.win.length, w.end - prepared.win.start),
      text: w.text,
    }));

  const sampleTimes = semantic.pickHookSampleTimes(prepared.win.length);
  const framePaths = [];
  for (const t of sampleTimes) {
    const framePath = path.join(prepared.clipTmp, `hookframe_${Math.round(t * 10)}.jpg`);
    try {
      await extractFrame(prepared.sourceForRender, prepared.detectBase + t, framePath, { maxWidth: 512 });
      framePaths.push({ t, path: framePath });
    } catch (err) {
      console.warn(`[stage=vision] frame sample @ t=${t.toFixed(1)}s failed: ${err.message}`);
    }
  }

  const report = await semantic.runVisionValidation({ windowLengthSec: prepared.win.length, words: localWords, framePaths });
  framePaths.forEach((f) => fs.unlink(f.path, () => {}));

  cand.visionReport = report;
  console.log(
    `[stage=vision] renderable=${report?.renderable ?? 'n/a'} ` +
    `reasons=${JSON.stringify(report?.rejectionReasons || [])} ` +
    `editorial=${JSON.stringify(report?.editorialVerdict || null)} ` +
    `composite=${report?.reactionComposite?.isReactionComposite ?? false}`
  );
  return report;
}

// Cheap gate in front of the expensive (9-frame) reaction-composite CV scan: skip it
// outright when there's clearly nothing for it to find. Two independent, cheap checks —
// either one triggers a skip:
//  (a) for uploaded videos we already have a whole-video visual-interest (scene-change)
//      timeline for free; if this window has far less visual variety than the video's own
//      average, a facecam+content composite (which needs SOME variety on the content side)
//      is unlikely.
//  (b) a single low-res probe frame at the window's midpoint — if no face at all, a
//      facecam composite is structurally impossible.
// Both fail OPEN (never skip) on missing data/errors, so this can only save cost, never
// silently suppress real composite detection.
async function shouldSkipCompositeScan(ctx, win, sourceForRender, detectBase, clipTmp) {
  if (ctx.visualInterest && ctx.visualHopSec && ctx.visualInterestAvg > 0) {
    const startHop = Math.round(win.start / ctx.visualHopSec);
    const endHop = Math.min(ctx.visualInterest.length, Math.round((win.start + win.length) / ctx.visualHopSec));
    const slice = ctx.visualInterest.slice(startHop, Math.max(startHop + 1, endHop));
    const maxInWindow = slice.length ? Math.max(...slice) : 0;
    if (maxInWindow < ctx.visualInterestAvg * 0.5) {
      console.log('[stage=layout] skip reactionComposite scan: low visual variety in this window');
      return true;
    }
  }
  const hasFace = await quickHasAnyFace(sourceForRender, detectBase + win.length / 2, clipTmp);
  if (!hasFace) {
    console.log('[stage=layout] skip reactionComposite scan: no face in quick probe');
    return true;
  }
  return false;
}

async function renderOneClip(job, ctx, entry, candidateIndex) {
  const cand = job.candidates[candidateIndex];
  if (!cand) throw new Error('No more distinct highlights found');

  entry.status = 'downloading clip';
  const prepared = await prepareCandidateSource(ctx, job, candidateIndex);
  const { sourceForRender, seek, widthForCrop, heightForCrop, detectBase, clipTmp, win } = prepared;

  // If this candidate reached rendering without ever having been vision-validated during
  // selection (e.g. via "generate more", past the original selection pass), give it one
  // chance now, still within the same per-job budget — so the "never render a rejected
  // candidate" rule keeps applying outside the initial auto-render batch too.
  if (cand.visionChecked === undefined && candidateIndex < semantic.VISION_BUDGET) {
    const t0 = Date.now();
    await validateCandidateVision(ctx, cand, prepared);
    cand.visionChecked = semantic.isAvailable();
    job.timings && (job.timings.visionMs += Date.now() - t0);
  }
  if (cand.visionChecked === undefined) cand.visionChecked = false;

  const framingT0 = Date.now();
  let reactionComposite = cand.visionReport?.reactionComposite || null;
  if (!reactionComposite) {
    entry.status = 'finding faces';
    const skip = await shouldSkipCompositeScan(ctx, win, sourceForRender, detectBase, clipTmp);
    reactionComposite = skip
      ? { isReactionComposite: false, facecamBox: null, confidence: 0, source: 'skipped-cheap-gate' }
      : await detectReactionComposite(sourceForRender, detectBase, win.length, clipTmp, widthForCrop, heightForCrop);
    console.log(`[stage=layout] candidate=${candidateIndex} reactionComposite(${reactionComposite.source})=${reactionComposite.isReactionComposite} confidence=${reactionComposite.confidence.toFixed(2)}`);
  }

  const localWords = ctx.words
    .filter((w) => w.start >= win.start - 0.2 && w.end <= win.start + win.length + 0.2)
    .map((w) => ({
      start: Math.max(0, w.start - win.start),
      end: Math.min(win.length, w.end - win.start),
      text: w.text,
    }));
  // Persisted (not just used once) so the AI hook generator can reuse this transcript after
  // render without re-deriving it — see src/captionAi/analyzer.js. Computed BEFORE
  // detectLayoutTimeline (moved up from its original position after that call, a safe
  // reorder — nothing here depends on layoutTimeline) so it can be threaded into face
  // detection for the speakingScore signal — see facedetect.js Component 5.
  cand.localWords = localWords;

  entry.status = 'finding faces';
  const layoutTimeline = await detectLayoutTimeline(sourceForRender, detectBase, win.length, clipTmp, widthForCrop, heightForCrop, LAYOUT_CHUNK_SEC, reactionComposite, localWords);
  // Persisted (not just used once) so the manual editor can later reconstruct an alternate
  // layout for a user-chosen time range/type without re-running face detection.
  cand.layoutTimeline = layoutTimeline;
  cand.resolvedReactionComposite = reactionComposite;

  // Plan doc M4 — the full per-candidate reaction timeline, flattened from data
  // detectLayoutTimeline already computed (expressiveMoments per chunk) and previously just
  // discarded once planClipSegments picked its single best. Persisted for inspection/future
  // consumers (e.g. a manual-editor UI) — planClipSegments itself still derives its own
  // candidate list internally from layoutTimeline, so this is observability, not a second
  // source of truth it reads from.
  cand.reactionTimeline = layoutTimeline.flatMap((c) =>
    (c.people.expressiveMoments || []).map((mo) => ({
      clipLocalT: Math.round((c.start + mo.localT) * 100) / 100,
      score: mo.score,
      clusterIndex: mo.clusterIndex,
    }))
  );

  let hookSplice = null;
  const hook = cand.visionReport?.hook;
  if (hook?.useColdOpen && hook.hookStart != null && hook.hookEnd > hook.hookStart) {
    hookSplice = { start: Math.max(0, hook.hookStart), end: Math.min(win.length, hook.hookEnd) };
    console.log(`[stage=layout] candidate=${candidateIndex} hook cold-open [${hookSplice.start.toFixed(1)},${hookSplice.end.toFixed(1)}] score=${hook.hookScore} vs chronological=${hook.chronologicalHookScore}`);
  }

  entry.status = 'planning shot';
  const { outputWidth: outW, outputHeight: outH } = job.options;
  const segments = planClipSegments({
    length: win.length, layoutTimeline, energy: ctx.energy, hopSec: ctx.hopSec, absStart: win.start,
    srcW: widthForCrop, srcH: heightForCrop,
    words: localWords, tightenPacing: !!job.options.tightenPacing,
    hookSplice, reactionComposite, outW, outH,
    emotionalImportance: cand.visionReport?.emotionalImportance,
    preferredFraming: cand.momentSignals?.preferred_framing || null,
    narrativeBeats: ctx.narrativeBeats || [],
    momentSignals: cand.momentSignals || null,
  });
  job.timings && (job.timings.framingMs += Date.now() - framingT0);

  let captionsAssPath = null;
  if (job.options.captionTheme !== 'none' && localWords.length) {
    captionsAssPath = buildCaptionsAss({
      words: localWords, segments,
      theme: job.options.captionTheme, emojis: job.options.emojis,
      outW, outH,
      outPath: path.join(clipTmp, 'captions.ass'),
    });
  }

  entry.status = 'rendering';
  const renderT0 = Date.now();
  const fileName = `short_${candidateIndex}.mp4`;
  const outputPath = path.join(ctx.jobOut, fileName);
  await heavyOps.run(() => renderSegmented({
    inputPath: sourceForRender, seek, srcW: widthForCrop, srcH: heightForCrop,
    segments, captionsAssPath, outputPath, outW, outH,
  }));
  job.timings && (job.timings.renderMs += Date.now() - renderT0);

  // visionStatus distinguishes "approved" from "not-checked" from "rejected-but-rendered-
  // anyway-because-budget-ran-out" — never treat an unchecked candidate as equivalent to an
  // approved one.
  const visionStatus = !semantic.isAvailable() ? 'unavailable'
    : cand.visionChecked === false ? 'not-checked'
    : !cand.visionReport ? 'checked-no-signal'
    : (cand.visionReport.renderable === false || cand.visionReport.editorialVerdict?.wouldUse === false) ? 'rejected-rendered-anyway'
    : 'approved';

  Object.assign(entry, {
    status: 'done',
    url: `/output/${job.id}/${fileName}`,
    start: Math.round(win.start * 10) / 10,
    length: Math.round(win.length * 10) / 10,
    faceCount: Math.max(0, ...layoutTimeline.map((c) => c.people.faceCount)),
    layoutSwitches: segments.filter((s) => !s.tag).length - 1,
    effect: segments.find((s) => s.tag)?.tag || null,
    // A short, real description of what this clip is about — the semantic pass already
    // produces this to help pick/rank cuts; surfacing it here lets the frontend pre-fill a
    // real caption when posting to a platform instead of always sending an empty string.
    caption: cand.semanticEvent?.topic_summary || null,
    candidateIndex,
    segments, // persisted for the manual editor — GET .../timeline reads this
    visionChecked: cand.visionChecked,
    visionStatus,
    qualityConfidence: {
      semanticallyAnalyzed: !!cand.semanticEvent,
      visuallyValidated: visionStatus === 'approved',
      cropValidated: true, // finalizeLayoutWithCropValidation is an unconditional gate — always ran
      hookEvaluated: !!cand.visionReport?.hook,
      renderedSuccessfully: true,
    },
  });
  entry.qualityConfidenceScore = Object.values(entry.qualityConfidence).filter(Boolean).length / Object.keys(entry.qualityConfidence).length;
  console.log(`[stage=render] candidate=${candidateIndex} status=done visionStatus=${visionStatus} qualityConfidence=${entry.qualityConfidenceScore.toFixed(2)} outputPath=${entry.url}`);

  // AI on-screen hook generation — sits strictly AFTER rendering and analyzes the ACTUAL
  // RENDERED clip, never the composition/layout decision itself. generateInitial() never
  // throws (always resolves to a status object), so a slow/failed LLM call can only ever
  // delay how soon a hook appears, never fail or block the clip finishing successfully.
  entry.hook = await captionAi.generateInitial({ entry, cand, outputPath, tmpDir: clipTmp });

  fs.rm(clipTmp, { recursive: true, force: true }, () => {});
}

async function runPipeline(job, { url, uploadedPath, options }) {
  job.options = {
    captionTheme: 'none',
    emojis: true,
    tightenPacing: false,
    outputWidth: 1080,
    outputHeight: 1920,
    ...(options || {}),
  };
  job.timings = { candidateGenMs: 0, semanticMs: 0, visionMs: 0, framingMs: 0, renderMs: 0, totalMs: 0 };
  const jobStartedAt = Date.now();

  const jobTmp = path.join(TMP_DIR, job.id);
  const jobOut = path.join(OUTPUT_DIR, job.id);
  fs.mkdirSync(jobTmp, { recursive: true });
  fs.mkdirSync(jobOut, { recursive: true });

  const ctx = { jobTmp, jobOut, isUrl: !!url, url };

  try {
    let wavPath;
    if (url) {
      job.status = 'downloading';
      setStatus(job, 'Getting your video ready…', 'Fetching the video details.');
      const meta = await probeUrlMeta(url);
      job.duration = meta.duration;
      ctx.info = meta;

      setStatus(job, 'Getting your video ready…', 'Downloading the audio for analysis.');
      job.progress = 0;
      wavPath = await downloadAudioOnly(url, job.id, jobTmp, (pct) => {
        job.progress = pct;
        setStatus(job, 'Getting your video ready…', `Downloading the audio for analysis… ${pct.toFixed(0)}%`);
      });
    } else {
      ctx.sourcePath = uploadedPath;
      job.status = 'analyzing';
      setStatus(job, 'Getting your video ready…', 'Reading your video file.');
      ctx.info = await probe(uploadedPath);
      job.duration = ctx.info.duration;
      wavPath = path.join(jobTmp, 'audio.wav');
      setStatus(job, 'Getting your video ready…', 'Pulling out the audio track.');
      await extractAudioWav(uploadedPath, wavPath);
    }

    job.status = 'analyzing';
    setStatus(job, 'Listening for energy and emotion…', 'Scanning the audio for exciting, high-energy moments.');
    const { energy, hopSec } = computeEnergyTimeline(wavPath);
    ctx.energy = energy;
    ctx.hopSec = hopSec;

    setStatus(job, 'Transcribing your audio…', 'Listening through the full video to understand what was said.');
    const transcript = await transcribeIfAvailable(wavPath);
    ctx.words = transcript?.words || [];

    // ONE whole-transcript narrative-arc call per video (not per-candidate) — kicked off
    // now and run CONCURRENTLY with the candidate-generation block below (which does no LLM
    // calls), then awaited just before rankCandidatesSemantic needs it, so it adds close to
    // zero wall-clock latency in the common case. See semantic.js:analyzeNarrativeArc.
    const narrativePromise = semantic.analyzeNarrativeArc(ctx.words, ctx.info.duration);

    const candidateGenT0 = Date.now();
    setStatus(job, 'Finding the sweet spots…', 'Looking for strong hooks and sections worth turning into shorts.');
    const audioCandidates = findHighlightClips(energy, hopSec, ctx.info.duration, ctx.words, CANDIDATE_POOL);
    audioCandidates.forEach((c) => console.log(`[stage=generate] source=audio start=${c.start.toFixed(1)} end=${c.end.toFixed(1)} score=${c.score.toFixed(3)}`));

    // Visual candidate generation needs actual video frames. Uploaded files are already
    // local (cheap). Plan doc M8: URL jobs only have audio downloaded at this point (the
    // whole point of the fast path), so a cheap low-res whole-video PROXY is attempted just
    // for this scan (bounded by URL_VISUAL_PROXY_MAX_DURATION_SEC) — on any failure or over
    // the ceiling, tryBuildUrlVisualInterest returns null and this degrades to today's exact
    // pre-M8 audio-only URL behavior, never failing the job.
    let visualCandidates = [];
    let visualScanResult = null;
    if (!url && process.env.DISABLE_VISUAL_SCAN !== '1') {
      setStatus(job, 'Checking the video for visual highlights…', 'Scanning the footage for engaging visual moments.');
      visualScanResult = await computeVisualInterestTimeline(uploadedPath, ctx.info.duration);
    } else if (url && shouldAttemptUrlVisualProxy(ctx.info.duration)) {
      setStatus(job, 'Checking the video for visual highlights…', 'Scanning a quick preview of the footage for engaging visual moments.');
      visualScanResult = await tryBuildUrlVisualInterest(url, job.id, jobTmp, ctx.info.duration, (pct) => {
        setStatus(job, 'Checking the video for visual highlights…', `Downloading a quick preview to scan… ${pct.toFixed(0)}%`);
      });
    }
    if (visualScanResult) {
      const { visualInterest, hopSec: visualHopSec } = visualScanResult;
      ctx.visualInterest = visualInterest;
      ctx.visualHopSec = visualHopSec;
      ctx.visualInterestAvg = visualInterest.length ? visualInterest.reduce((a, b) => a + b, 0) / visualInterest.length : 0;
      visualCandidates = findVisualHighlightClips(visualInterest, visualHopSec, ctx.info.duration, ctx.words, VISUAL_CANDIDATE_POOL);
      visualCandidates.forEach((c) => console.log(`[stage=generate] source=visual start=${c.start.toFixed(1)} end=${c.end.toFixed(1)} score=${c.score.toFixed(3)}`));
    }

    const mergedPool = mergeCandidatePools(audioCandidates, visualCandidates);
    console.log(`[stage=merge] mergedCount=${mergedPool.length} (audio=${audioCandidates.length} visual=${visualCandidates.length})`);

    const selected = selectCandidatesForSemanticPass(mergedPool);
    console.log(`[stage=merge] selected ${selected.length}/${mergedPool.length} for semantic ranking (adaptive, not a fixed top-N)`);
    job.timings.candidateGenMs = Date.now() - candidateGenT0;

    setStatus(job, 'Picking the best clips…', 'Weighing context and story to choose the strongest cuts.');
    const semanticT0 = Date.now();
    const narrativeArc = await narrativePromise;
    // Plan doc M4 — persisted on ctx (not just used once here) so renderOneClip (called later,
    // per-candidate) can also read it when planning reaction cutaways, without re-running the
    // whole-video narrative pass again.
    ctx.narrativeBeats = narrativeArc?.beats || [];
    const ranked = await semantic.rankCandidatesSemantic(selected, ctx.words, { narrativeBeats: ctx.narrativeBeats, mapLimit });
    job.timings.semanticMs = Date.now() - semanticT0;
    const notSelected = mergedPool.filter((c) => !selected.includes(c));
    notSelected.forEach((c) => { c.cutScore = c.score; });
    const allCandidates = semantic.dedupeByOverlap([...ranked, ...notSelected].sort((a, b) => b.cutScore - a.cutScore));
    job.candidates = allCandidates;

    // Candidate promotion: vision-validate the top-of-budget candidates CONCURRENTLY
    // (bounded — never sequential when they can safely run in parallel), then walk the
    // results in rank order to decide the final accepted set — a rejected candidate is
    // skipped and the next-ranked one is promoted in its place. Unchecked candidates (past
    // the budget) are marked visionChecked=false so downstream logic/logs never conflate
    // "not checked" with "approved".
    job.status = 'selecting';
    setStatus(job, 'Double-checking the top picks…', 'Making sure each moment looks right before cutting clips.');
    const autoCount = Math.min(AUTO_CLIP_COUNT, job.candidates.length);
    const visionT0 = Date.now();
    const checkBudgetCount = semantic.isAvailable() ? Math.min(semantic.VISION_BUDGET, job.candidates.length) : 0;
    const candidatesToCheck = job.candidates.slice(0, checkBudgetCount);
    if (candidatesToCheck.length) {
      await mapLimit(candidatesToCheck, VISION_CONCURRENCY, async (cand, i) => {
        // Re-check freshly (not just the once-upfront checkBudgetCount) — for a URL job,
        // preparing a candidate means downloading its video section, which is real cost
        // that must stop the moment the LLM proves unusable (e.g. out of credits), not
        // continue for every remaining candidate in the queue while it keeps failing.
        if (!semantic.isAvailable()) {
          cand.visionChecked = false;
          return;
        }
        try {
          const prepared = await prepareCandidateSource(ctx, job, i);
          await validateCandidateVision(ctx, cand, prepared);
          cand.visionChecked = true;
        } catch (err) {
          console.warn(`[stage=select] candidate=${i} vision prep failed, proceeding without a veto:`, err.message);
          cand.visionChecked = true;
        }
      });
    }
    job.timings.visionMs = Date.now() - visionT0;

    // Secondary reordering signal (Component 4 — see plan doc): among the already-vision-
    // checked, budget-limited slice, nudge promotion order by emotionalImportance. Never
    // mutates job.candidates itself — its index is load-bearing (renderMore, applyManualEdit,
    // and output filenames all key off job.candidates[i]) — this only reorders which INDICES
    // get walked below, and the veto logic in that loop is completely unchanged. When no
    // candidate has an emotionalImportance signal (vision unavailable, or the field absent),
    // every scoreFor() call reduces to cand.cutScore, and since job.candidates is already
    // cutScore-sorted, this re-sort is a stable no-op — provably the same order as today.
    const checkedIndices = Array.from({ length: checkBudgetCount }, (_, i) => i);
    const uncheckedIndices = Array.from({ length: job.candidates.length - checkBudgetCount }, (_, i) => i + checkBudgetCount);
    const scoreFor = (poolIndex) => {
      const cand = job.candidates[poolIndex];
      const importance = cand.visionReport?.emotionalImportance;
      return importance != null ? cand.cutScore + CUT_SCORE_WEIGHT_VISUAL_IMPORTANCE * importance : cand.cutScore;
    };
    checkedIndices.sort((a, b) => scoreFor(b) - scoreFor(a));
    const promotionOrder = buildDiverseOrder(job.candidates, [...checkedIndices, ...uncheckedIndices]);

    // Plan doc M5 — walks the FULL promotionOrder (not just the first autoCount) so every
    // vision-veto/quality-floor-eligible candidate beyond autoCount is available as a
    // backfill reserve for the post-render critic below, in the exact same eligibility order
    // this loop already established. Eligibility criteria themselves are completely
    // unchanged from M2.
    const eligible = [];
    let belowFloorCount = 0;
    for (const poolIndex of promotionOrder) {
      const cand = job.candidates[poolIndex];
      if (cand.visionChecked === undefined) cand.visionChecked = false;
      const report = cand.visionChecked ? cand.visionReport : undefined;
      const rejected = !!(report && (report.renderable === false || report.editorialVerdict?.wouldUse === false));
      if (rejected) {
        console.log(`[stage=select] candidate=${poolIndex} REJECTED visionChecked=${cand.visionChecked}`);
        continue;
      }
      if (!passesQualityFloor(cand)) {
        belowFloorCount++;
        console.log(`[stage=select] candidate=${poolIndex} below quality floor (cutScore=${cand.cutScore.toFixed(3)} < ${MIN_CLIP_QUALITY_FLOOR}) — skipped, not backfilled with a low-confidence clip`);
        continue;
      }
      console.log(`[stage=select] candidate=${poolIndex} eligible visionChecked=${cand.visionChecked} category=${deriveMomentCategory(cand)}`);
      eligible.push(poolIndex);
    }
    const accepted = eligible.slice(0, autoCount);
    const backfillReserve = eligible.slice(autoCount);
    const budgetExhausted = accepted.length < autoCount;
    if (budgetExhausted) {
      // Honest count (plan doc M2): when the quality floor is enabled and genuinely not
      // enough candidates clear it, this now returns FEWER than autoCount rather than
      // backfilling with a low-confidence candidate — the floor is opt-in (MIN_CLIP_QUALITY_FLOOR
      // unset -> null -> passesQualityFloor always true), so with it disabled this log line
      // and the resulting count are byte-identical to pre-M2 behavior.
      console.log(`[stage=select] budgetExhausted=${checkBudgetCount < job.candidates.length} belowFloor=${belowFloorCount} — ${autoCount - accepted.length} slot(s) unfilled`);
    }
    console.log(`[stage=select] initialAccepted=${accepted.length} backfillReserve=${backfillReserve.length}`);

    job.results = accepted.map((poolIndex) => ({ candidateIndex: poolIndex, status: 'pending' }));
    job.status = 'rendering';

    // Render clips concurrently instead of one-at-a-time so the wait scales with clip count
    // divided by CPU cores, not multiplied by it. Plan doc M5 — after each render, run the
    // post-render critic (a no-op whenever it's unavailable, exactly like every other LLM
    // call site in this app); a REJECTED clip's slot is backfilled from `backfillReserve`,
    // one replacement per rejection, up to MAX_CRITIC_BACKFILL_ATTEMPTS total — a
    // pathologically bad source can only ever make the job return fewer clips, never loop
    // forever or force a rejected clip through. `currentBatch` (not job.results) is what
    // mapLimit iterates, so splicing job.results on a rejection can never corrupt a
    // concurrent worker's indexing into the array it's actually walking.
    let currentBatch = job.results;
    let backfillCursor = 0;
    let backfillAttempts = 0;
    while (currentBatch.length) {
      let rejectedCount = 0;
      await mapLimit(currentBatch, CONCURRENCY, async (entry) => {
        try {
          await renderOneClip(job, ctx, entry, entry.candidateIndex);
        } catch (err) {
          entry.status = 'error';
          entry.message = err.message;
          console.error(`Clip ${entry.candidateIndex} failed:`, err);
          return; // pre-existing behavior: a render ERROR is never backfilled, only a critic reject is
        }
        const cand = job.candidates[entry.candidateIndex];
        const critiqueTmp = path.join(ctx.jobTmp, `critique_${entry.candidateIndex}_${Date.now()}`);
        fs.mkdirSync(critiqueTmp, { recursive: true });
        let verdict = null;
        try {
          verdict = await critic.critiqueRenderedClip({
            outputPath: path.join(ctx.jobOut, `short_${entry.candidateIndex}.mp4`),
            words: cand?.localWords || [],
            segments: entry.segments || [],
            durationSec: entry.length,
            tmpDir: critiqueTmp,
          });
        } catch (err) {
          console.warn(`[stage=critic] candidate=${entry.candidateIndex} critique failed, proceeding without a veto:`, err.message);
        } finally {
          fs.rm(critiqueTmp, { recursive: true, force: true }, () => {});
        }
        if (applyCriticVerdict(job, entry, verdict)) rejectedCount++;
      });

      if (!rejectedCount) break;
      const replacements = [];
      while (replacements.length < rejectedCount && backfillCursor < backfillReserve.length && backfillAttempts < MAX_CRITIC_BACKFILL_ATTEMPTS) {
        const poolIndex = backfillReserve[backfillCursor++];
        backfillAttempts++;
        const replacementEntry = { candidateIndex: poolIndex, status: 'pending' };
        job.results.push(replacementEntry);
        replacements.push(replacementEntry);
      }
      if (!replacements.length) {
        console.log(`[stage=critic] backfill exhausted (reserve=${backfillReserve.length - backfillCursor} remaining, attempts=${backfillAttempts}/${MAX_CRITIC_BACKFILL_ATTEMPTS}) — job will return fewer than ${autoCount} clips`);
      }
      currentBatch = replacements;
    }

    job._ctx = ctx; // kept alive for "generate more" requests
    job.status = 'done';
    setStatus(job, 'All done!', 'Your shorts are ready.');
  } catch (err) {
    job.status = 'error';
    job.message = err.message;
    console.error(`Job ${job.id} failed:`, err);
  } finally {
    job.timings.totalMs = Date.now() - jobStartedAt;
    console.log(
      `[stage=timing] candidateGenMs=${job.timings.candidateGenMs} semanticMs=${job.timings.semanticMs} ` +
      `visionMs=${job.timings.visionMs} framingMs(sum across clips)=${job.timings.framingMs} ` +
      `renderMs(sum across clips)=${job.timings.renderMs} totalMs=${job.timings.totalMs}`
    );
  }
}

async function renderMore(job) {
  const ctx = job._ctx;
  if (!job.candidates || !ctx) throw new Error('This job has no more highlight candidates available');
  const usedIndices = new Set(job.results.map((r) => r.candidateIndex));
  let nextIndex = -1;
  for (let i = 0; i < job.candidates.length; i++) {
    if (!usedIndices.has(i)) { nextIndex = i; break; }
  }
  if (nextIndex === -1) throw new Error('No more distinct highlights found');
  const entry = { candidateIndex: nextIndex, status: 'pending' };
  job.results.push(entry);
  await renderOneClip(job, ctx, entry, nextIndex);
  return entry;
}

// Manual editor: re-renders ONE already-rendered clip from a user-edited segment list
// (`[{start,end,userType,cropAdjust?}]`, clip-local seconds) instead of the auto-generated
// plan. Reuses the cached source (`cand._prepared` — no re-download/re-probe), the cached
// per-chunk detections (`cand.layoutTimeline`/`resolvedReactionComposite` — no re-running
// face detection), and the same render/caption machinery as the original render, so audio
// and subtitle timing stay in sync exactly as before. Fires the same crop-safety validation
// as auto-generation (inside mapUserTypeToLayout) — a manual nudge cannot produce a
// cut-off face any more than an auto-generated layout can.
async function applyManualEdit(job, candidateIndex, editedSegments) {
  const ctx = job._ctx;
  const cand = job.candidates?.[candidateIndex];
  const entry = job.results?.find((r) => r.candidateIndex === candidateIndex);
  if (!ctx || !cand || !entry) throw new Error('Clip not found');
  if (!cand._prepared) throw new Error('This clip\'s source is no longer available (job may have restarted)');

  entry.status = 'rendering';
  const { sourceForRender, seek, widthForCrop, heightForCrop, win } = cand._prepared;
  const layoutTimeline = cand.layoutTimeline || [];
  const reactionComposite = cand.resolvedReactionComposite || null;
  const { outputWidth: outW, outputHeight: outH } = job.options;
  const editTmp = path.join(ctx.jobTmp, `edit_${candidateIndex}_${Date.now()}`);
  fs.mkdirSync(editTmp, { recursive: true });

  try {
    const segments = editedSegments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      rate: 1,
      layout: mapUserTypeToLayout(seg.userType, { start: seg.start, end: seg.end }, layoutTimeline, reactionComposite, widthForCrop, heightForCrop, seg.cropAdjust, outW, outH),
    }));

    const localWords = ctx.words
      .filter((w) => w.start >= win.start - 0.2 && w.end <= win.start + win.length + 0.2)
      .map((w) => ({
        start: Math.max(0, w.start - win.start),
        end: Math.min(win.length, w.end - win.start),
        text: w.text,
      }));

    let captionsAssPath = null;
    if (job.options.captionTheme !== 'none' && localWords.length) {
      captionsAssPath = buildCaptionsAss({
        words: localWords, segments,
        theme: job.options.captionTheme, emojis: job.options.emojis,
        outW, outH,
        outPath: path.join(editTmp, 'captions.ass'),
      });
    }

    const fileName = `short_${candidateIndex}.mp4`;
    const outputPath = path.join(ctx.jobOut, fileName);
    await heavyOps.run(() => renderSegmented({
      inputPath: sourceForRender, seek, srcW: widthForCrop, srcH: heightForCrop,
      segments, captionsAssPath, outputPath, outW, outH,
    }));

    Object.assign(entry, {
      status: 'done',
      segments,
      url: `/output/${job.id}/${fileName}?v=${Date.now()}`, // cache-bust: ffmpeg overwrote the same filename
      layoutSwitches: segments.length - 1,
      effect: null,
    });
    console.log(`[stage=render] candidate=${candidateIndex} manual edit applied, status=done`);
  } catch (err) {
    entry.status = 'error';
    entry.message = err.message;
    console.error(`Manual edit for clip ${candidateIndex} failed:`, err);
    throw err;
  } finally {
    fs.rm(editTmp, { recursive: true, force: true }, () => {});
  }
}

module.exports = {
  runPipeline, renderMore, applyManualEdit, OUTPUT_DIR, TMP_DIR,
  deriveMomentCategory, buildDiverseOrder, passesQualityFloor, applyCriticVerdict,
  shouldAttemptUrlVisualProxy, tryBuildUrlVisualInterest,
};
