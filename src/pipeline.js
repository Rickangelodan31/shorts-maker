const fs = require('fs');
const path = require('path');
const os = require('os');
const { probe, extractAudioWav } = require('./ffutil');
const { findHighlightClips, computeEnergyTimeline } = require('./highlight');
const { transcribeIfAvailable } = require('./transcribe');
const { detectLayoutTimeline } = require('./facedetect');
const { renderSegmented } = require('./render');
const { planClipSegments } = require('./effects');
const { buildCaptionsAss } = require('./captions');
const { probeUrlMeta, downloadAudioOnly, downloadSection } = require('./ingest');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const AUTO_CLIP_COUNT = 10;
const CANDIDATE_POOL = 20;
const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length - 1));

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

async function renderOneClip(job, ctx, entry, candidateIndex) {
  const cand = job.candidates[candidateIndex];
  if (!cand) throw new Error('No more distinct highlights found');
  const win = { start: cand.start, length: cand.length };

  const clipTmp = path.join(ctx.jobTmp, `render_${candidateIndex}`);
  fs.mkdirSync(clipTmp, { recursive: true });

  let sourceForRender, seek, widthForCrop, heightForCrop, detectBase;

  if (ctx.isUrl) {
    entry.status = 'downloading clip';
    entry.progress = 0;
    sourceForRender = await downloadSection(
      ctx.url, job.id, candidateIndex, win.start, win.start + win.length, ctx.jobTmp,
      (pct) => { entry.progress = pct; }
    );
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

  entry.status = 'finding faces';
  const layoutTimeline = await detectLayoutTimeline(sourceForRender, detectBase, win.length, clipTmp, widthForCrop, heightForCrop);

  const localWords = ctx.words
    .filter((w) => w.start >= win.start - 0.2 && w.end <= win.start + win.length + 0.2)
    .map((w) => ({
      start: Math.max(0, w.start - win.start),
      end: Math.min(win.length, w.end - win.start),
      text: w.text,
    }));

  entry.status = 'planning shot';
  const segments = planClipSegments({
    length: win.length, layoutTimeline, energy: ctx.energy, hopSec: ctx.hopSec, absStart: win.start,
    srcW: widthForCrop, srcH: heightForCrop,
    words: localWords, tightenPacing: !!job.options.tightenPacing,
  });

  let captionsAssPath = null;
  if (job.options.captionTheme !== 'none' && localWords.length) {
    captionsAssPath = buildCaptionsAss({
      words: localWords, segments,
      theme: job.options.captionTheme, emojis: job.options.emojis,
      outPath: path.join(clipTmp, 'captions.ass'),
    });
  }

  entry.status = 'rendering';
  const fileName = `short_${candidateIndex}.mp4`;
  const outputPath = path.join(ctx.jobOut, fileName);
  await renderSegmented({
    inputPath: sourceForRender, seek, srcW: widthForCrop, srcH: heightForCrop,
    segments, captionsAssPath, outputPath,
  });

  Object.assign(entry, {
    status: 'done',
    url: `/output/${job.id}/${fileName}`,
    start: Math.round(win.start * 10) / 10,
    length: Math.round(win.length * 10) / 10,
    faceCount: Math.max(0, ...layoutTimeline.map((c) => c.people.faceCount)),
    layoutSwitches: segments.filter((s) => !s.tag).length - 1,
    effect: segments.find((s) => s.tag)?.tag || null,
    candidateIndex,
  });

  fs.rm(clipTmp, { recursive: true, force: true }, () => {});
}

async function runPipeline(job, { url, uploadedPath, options }) {
  job.options = {
    captionTheme: 'none',
    emojis: true,
    tightenPacing: false,
    ...(options || {}),
  };

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

    job.message = 'Finding highlight moments...';
    job.candidates = findHighlightClips(energy, hopSec, ctx.info.duration, ctx.words, CANDIDATE_POOL);

    const autoCount = Math.min(AUTO_CLIP_COUNT, job.candidates.length);
    job.results = Array.from({ length: autoCount }, (_, i) => ({ candidateIndex: i, status: 'pending' }));
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
  }
}

async function renderMore(job) {
  const ctx = job._ctx;
  if (!job.candidates || !ctx) throw new Error('This job has no more highlight candidates available');
  const usedCount = job.results.length;
  if (usedCount >= job.candidates.length) throw new Error('No more distinct highlights found');
  const entry = { candidateIndex: usedCount, status: 'pending' };
  job.results.push(entry);
  await renderOneClip(job, ctx, entry, usedCount);
  return entry;
}

module.exports = { runPipeline, renderMore, OUTPUT_DIR, TMP_DIR };
