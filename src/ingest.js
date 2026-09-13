const path = require('path');
const fs = require('fs');
const { runWithProgress, run } = require('./ffutil');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

function parsePercent(line) {
  const m = line.match(/\[download\]\s+([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

// Fetches duration/width/height without downloading any media (yt-dlp -J metadata dump).
async function probeUrlMeta(url) {
  const { stdout } = await run('yt-dlp', ['-J', '--no-warnings', '--no-playlist', url]);
  const data = JSON.parse(stdout);
  const duration = data.duration || 0;
  let width = data.width;
  let height = data.height;
  if (!width || !height) {
    const vformats = (data.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.height);
    vformats.sort((a, b) => (b.height || 0) - (a.height || 0));
    const pick = vformats.find((f) => f.height <= 1080) || vformats[vformats.length - 1];
    if (pick) {
      width = pick.width;
      height = pick.height;
    }
  }
  return { duration, width: width || 1920, height: height || 1080, title: data.title || '' };
}

// Downloads ONLY the audio track (small + fast) so we can find the highlight moment
// without pulling down the whole video first.
async function downloadAudioOnly(url, jobId, jobTmp, onProgress) {
  const outTemplate = path.join(jobTmp, `${jobId}_audio.%(ext)s`);
  await runWithProgress('yt-dlp', [
    '--no-playlist', '--newline',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'wav',
    '-o', outTemplate,
    url,
  ], (line) => {
    const pct = parsePercent(line);
    if (pct !== null && onProgress) onProgress(pct);
  });
  const files = fs.readdirSync(jobTmp).filter((f) => f.startsWith(`${jobId}_audio.`) && f.endsWith('.wav'));
  if (!files.length) throw new Error('Audio download did not produce a wav file');
  return path.join(jobTmp, files[0]);
}

// Downloads only a specific time range of video+audio (via yt-dlp --download-sections),
// so a highlight clip from a multi-hour VOD doesn't require fetching the whole thing.
async function downloadSection(url, jobId, index, startSec, endSec, jobTmp, onProgress) {
  const outTemplate = path.join(jobTmp, `${jobId}_clip${index}.%(ext)s`);
  const s = Math.max(0, startSec);
  const e = Math.max(s + 1, endSec);
  await runWithProgress('yt-dlp', [
    '--no-playlist', '--newline',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--download-sections', `*${s}-${e}`,
    '--force-keyframes-at-cuts',
    '-o', outTemplate,
    url,
  ], (line) => {
    const pct = parsePercent(line);
    if (pct !== null && onProgress) onProgress(pct);
  });
  const files = fs.readdirSync(jobTmp).filter((f) => f.startsWith(`${jobId}_clip${index}.`));
  if (!files.length) throw new Error('Section download did not produce a file');
  return path.join(jobTmp, files[0]);
}

// Plan doc M8 — a cheap, WHOLE-VIDEO, video-only, low-resolution download used solely to
// feed computeVisualInterestTimeline (visualscan.js), which already downscales internally to
// 160px — a 240p source is already overkill for it. Video-only (no `+ba`) since the visual
// scan never touches audio and this keeps the download as small as possible. Falls through
// to progressively looser format strings (360p, then "worst available") only because some
// sources don't expose a dedicated ≤240p video-only stream; the caller (pipeline.js) treats
// ANY failure here as "no visual proxy available" and degrades to today's audio-only URL
// behavior rather than failing the job.
async function downloadLowResVideoProxy(url, jobId, jobTmp, onProgress) {
  const outTemplate = path.join(jobTmp, `${jobId}_visualproxy.%(ext)s`);
  await runWithProgress('yt-dlp', [
    '--no-playlist', '--newline',
    '-f', 'bv*[height<=240]/bv*[height<=360]/w',
    '-o', outTemplate,
    url,
  ], (line) => {
    const pct = parsePercent(line);
    if (pct !== null && onProgress) onProgress(pct);
  });
  const files = fs.readdirSync(jobTmp).filter((f) => f.startsWith(`${jobId}_visualproxy.`));
  if (!files.length) throw new Error('Visual proxy download did not produce a file');
  return path.join(jobTmp, files[0]);
}

module.exports = { probeUrlMeta, downloadAudioOnly, downloadSection, downloadLowResVideoProxy, UPLOAD_DIR };
