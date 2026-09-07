const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffutil = require('../ffutil');

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download clip (${res.status}): ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// Concatenates per-scene Veo clips (already uploaded to Blob, referenced by URL) into one
// episode video. All clips come from the same model/tier/settings, so codecs should match —
// `-c copy` (fast, no quality loss) is tried first, falling back to a real re-encode only if
// that fails (e.g. a scene was regenerated on a different tier). Returns a local temp file
// path; the caller reads it into a Buffer for blob.js and is responsible for deleting it.
async function stitchSceneClips(clipUrls) {
  if (!clipUrls.length) throw new Error('No clips to stitch.');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoon-stitch-'));
  try {
    const localPaths = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const p = path.join(workDir, `clip-${i}.mp4`);
      await downloadToFile(clipUrls[i], p);
      localPaths.push(p);
    }

    if (localPaths.length === 1) {
      const finalPath = path.join(os.tmpdir(), `cartoon-episode-${crypto.randomBytes(4).toString('hex')}.mp4`);
      fs.copyFileSync(localPaths[0], finalPath);
      return finalPath;
    }

    const listPath = path.join(workDir, 'concat.txt');
    fs.writeFileSync(listPath, localPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const outPath = path.join(workDir, 'stitched.mp4');
    try {
      await ffutil.run(ffutil.FFMPEG_BIN, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    } catch (err) {
      console.warn('[cartoon/videoStitch] stream-copy concat failed, re-encoding instead:', err.message);
      await ffutil.run(ffutil.FFMPEG_BIN, [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', outPath,
      ]);
    }

    const finalPath = path.join(os.tmpdir(), `cartoon-episode-${crypto.randomBytes(4).toString('hex')}.mp4`);
    fs.copyFileSync(outPath, finalPath);
    return finalPath;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { stitchSceneClips };
