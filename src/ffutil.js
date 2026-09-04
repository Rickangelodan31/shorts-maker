const { spawn } = require('child_process');
const fs = require('fs');

// ffmpeg-full (installed via `brew install ffmpeg-full`) adds libass/freetype/fontconfig
// (caption burning) on top of the base ffmpeg formula. Fall back to plain `ffmpeg` if it's
// not present so the app still runs (just without captions).
const FULL_BIN = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FULL_PROBE = '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe';
const FFMPEG_BIN = fs.existsSync(FULL_BIN) ? FULL_BIN : 'ffmpeg';
const FFPROBE_BIN = fs.existsSync(FULL_PROBE) ? FULL_PROBE : 'ffprobe';
const HAS_CAPTIONS = fs.existsSync(FULL_BIN);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d));
    proc.stderr?.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// Like run(), but streams stdout+stderr line-by-line to onLine (used to parse yt-dlp progress).
function runWithProgress(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let buf = '';
    let tail = '';
    const feed = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      buf += text;
      let idx;
      while ((idx = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim() && onLine) onLine(line.trim());
      }
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${tail}`));
    });
  });
}

async function probe(filePath) {
  const { stdout } = await run(FFPROBE_BIN, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=width,height,codec_type',
    '-of', 'json',
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const duration = parseFloat(data.format?.duration || '0');
  const vstream = (data.streams || []).find((s) => s.codec_type === 'video' && s.width);
  return {
    duration,
    width: vstream?.width || 1920,
    height: vstream?.height || 1080,
  };
}

async function extractAudioWav(inputPath, outPath) {
  await run(FFMPEG_BIN, [
    '-y', '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000',
    '-f', 'wav', outPath,
  ]);
}

async function extractFrame(inputPath, timeSec, outPath) {
  await run(FFMPEG_BIN, [
    '-y', '-ss', String(timeSec), '-i', inputPath,
    '-frames:v', '1', '-q:v', '3', outPath,
  ]);
}

module.exports = {
  run, runWithProgress, probe, extractAudioWav, extractFrame,
  FFMPEG_BIN, FFPROBE_BIN, HAS_CAPTIONS,
};
