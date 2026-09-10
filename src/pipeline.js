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
const { probeUrlMeta, downloadAudioOnly, downloadSection } = require('./ingest');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const AUTO_CLIP_COUNT = 10;
const CANDIDATE_POOL = 20;
// Scene-change score is noisy — most visually-"different" moments in edited footage are
// editorially meaningless. The visual pool gets a smaller raw cap than the audio pool
// (further trimmed again in candidates.js's semantic-pass selection).
const VISUAL_CANDIDATE_POOL = 10;
const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length - 1));
// Vision calls are network-bound (not CPU-bound), so a slightly higher bound than render
// concurrency is safe here, but still capped so we don't hammer the API or spawn unbounded
// ffmpeg frame-extraction processes at once.
const VISION_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.SEMANTIC_VISION_CONCURRENCY || '3', 10)));

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

  entry.status = 'finding faces';
  const layoutTimeline = await detectLayoutTimeline(sourceForRender, detectBase, win.length, clipTmp, widthForCrop, heightForCrop, 12, reactionComposite);
  // Persisted (not just used once) so the manual editor can later reconstruct an alternate
  // layout for a user-chosen time range/type without re-running face detection.
  cand.layoutTimeline = layoutTimeline;
  cand.resolvedReactionComposite = reactionComposite;

  const localWords = ctx.words
    .filter((w) => w.start >= win.start - 0.2 && w.end <= win.start + win.length + 0.2)
    .map((w) => ({
      start: Math.max(0, w.start - win.start),
      end: Math.min(win.length, w.end - win.start),
      text: w.text,
    }));

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
      job.message = 'Fetching video info...';
      const meta = await probeUrlMeta(url);
      job.duration = meta.duration;
      ctx.info = meta;

      job.message = 'Downloading audio for analysis...';
      job.progress = 0;
      wavPath = await downloadAudioOnly(url, job.id, jobTmp, (pct) => {
        job.progress = pct;
        job.message = `Downloading audio for analysis... ${pct.toFixed(0)}%`;
      });
    } else {
      ctx.sourcePath = uploadedPath;
      job.status = 'analyzing';
      job.message = 'Reading video...';
      ctx.info = await probe(uploadedPath);
      job.duration = ctx.info.duration;
      wavPath = path.join(jobTmp, 'audio.wav');
      job.message = 'Extracting audio...';
      await extractAudioWav(uploadedPath, wavPath);
    }

    job.status = 'analyzing';
    job.message = 'Analyzing audio for uptempo / emotional moments...';
    const { energy, hopSec } = computeEnergyTimeline(wavPath);
    ctx.energy = energy;
    ctx.hopSec = hopSec;

    job.message = 'Transcribing (local)...';
    const transcript = await transcribeIfAvailable(wavPath);
    ctx.words = transcript?.words || [];

    const candidateGenT0 = Date.now();
    job.message = 'Finding highlight moments...';
    const audioCandidates = findHighlightClips(energy, hopSec, ctx.info.duration, ctx.words, CANDIDATE_POOL);
    audioCandidates.forEach((c) => console.log(`[stage=generate] source=audio start=${c.start.toFixed(1)} end=${c.end.toFixed(1)} score=${c.score.toFixed(3)}`));

    // Visual candidate generation needs actual video frames. For uploaded files the source
    // is already local (cheap); for URL jobs only audio has been downloaded at this point
    // (the whole point of the fast path), so the visual pass is skipped there rather than
    // forcing a full video download just to run it — audio-only candidates still apply.
    let visualCandidates = [];
    if (!url && process.env.DISABLE_VISUAL_SCAN !== '1') {
      job.message = 'Scanning for visual highlights...';
      const { visualInterest, hopSec: visualHopSec } = await computeVisualInterestTimeline(uploadedPath, ctx.info.duration);
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

    job.message = 'Refining cut boundaries with semantic analysis...';
    const semanticT0 = Date.now();
    const ranked = await semantic.rankCandidatesSemantic(selected, ctx.words, { mapLimit });
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
    job.message = 'Validating top candidates...';
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

    const accepted = [];
    for (let poolIndex = 0; poolIndex < job.candidates.length && accepted.length < autoCount; poolIndex++) {
      const cand = job.candidates[poolIndex];
      if (cand.visionChecked === undefined) cand.visionChecked = false;
      const report = cand.visionChecked ? cand.visionReport : undefined;
      const rejected = !!(report && (report.renderable === false || report.editorialVerdict?.wouldUse === false));
      console.log(`[stage=select] candidate=${poolIndex} ${rejected ? 'REJECTED' : 'accepted'} visionChecked=${cand.visionChecked}`);
      if (!rejected) accepted.push(poolIndex);
    }
    const budgetExhausted = accepted.length < autoCount;
    if (budgetExhausted) {
      console.log(`[stage=select] budgetExhausted=${checkBudgetCount < job.candidates.length} — ${autoCount - accepted.length} slot(s) may be filled without a vision veto`);
    }

    job.results = accepted.map((poolIndex) => ({ candidateIndex: poolIndex, status: 'pending' }));
    job.status = 'rendering';

    // Render clips concurrently instead of one-at-a-time so the wait scales with clip count
    // divided by CPU cores, not multiplied by it.
    await mapLimit(job.results, CONCURRENCY, async (entry) => {
      try {
        await renderOneClip(job, ctx, entry, entry.candidateIndex);
      } catch (err) {
        entry.status = 'error';
        entry.message = err.message;
        console.error(`Clip ${entry.candidateIndex} failed:`, err);
      }
    });

    job._ctx = ctx; // kept alive for "generate more" requests
    job.status = 'done';
    job.message = 'Done.';
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

module.exports = { runPipeline, renderMore, applyManualEdit, OUTPUT_DIR, TMP_DIR };
