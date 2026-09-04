const os = require('os');
const { run, FFMPEG_BIN, HAS_CAPTIONS } = require('./ffutil');

const OUT_W = 1080;
const OUT_H = 1920;
// When several clips render concurrently, cap each ffmpeg's thread count so they share
// cores instead of each grabbing all of them and thrashing.
const THREADS_PER_RENDER = Math.max(2, Math.floor(os.cpus().length / 3));

function evenify(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

// Computes a crop box (w,h,x,y) from the source that matches targetAR, centered on (cx,cy) (normalized 0..1).
function cropBoxFor(srcW, srcH, cx, cy, targetAR) {
  const srcAR = srcW / srcH;
  let w, h;
  if (srcAR > targetAR) {
    h = srcH;
    w = h * targetAR;
  } else {
    w = srcW;
    h = w / targetAR;
  }
  w = evenify(w);
  h = evenify(h);
  let x = Math.round(cx * srcW - w / 2);
  let y = Math.round(cy * srcH - h / 2);
  x = Math.max(0, Math.min(srcW - w, x));
  y = Math.max(0, Math.min(srcH - h, y));
  return { w, h, x, y };
}

// Builds the filter_complex for one segment's layout (single crop, or 2-way split-screen),
// operating on an already-trimmed/retimed stream label.
function layoutFilter(vBase, layout, srcW, srcH) {
  const parts = [];
  const vOut = `${vBase}out`;
  if (layout.type === 'split') {
    const bandH = evenify(OUT_H / 2);
    const targetAR = OUT_W / bandH;
    const [s1, s2] = layout.slots;
    const box1 = cropBoxFor(srcW, srcH, s1.cx, s1.cy, targetAR);
    const box2 = cropBoxFor(srcW, srcH, s2.cx, s2.cy, targetAR);
    parts.push(`[${vBase}]split=2[${vBase}x][${vBase}y]`);
    parts.push(`[${vBase}x]crop=${box1.w}:${box1.h}:${box1.x}:${box1.y},scale=${OUT_W}:${bandH},setsar=1[${vBase}p1]`);
    parts.push(`[${vBase}y]crop=${box2.w}:${box2.h}:${box2.x}:${box2.y},scale=${OUT_W}:${bandH},setsar=1[${vBase}p2]`);
    parts.push(`[${vBase}p1][${vBase}p2]vstack=inputs=2[${vOut}]`);
  } else if (layout.type === 'fit') {
    // Show the WHOLE frame (nobody cropped out) letterboxed over a blurred, zoomed-in copy
    // of the same frame as filler — used when a hard crop would have to cut someone off.
    parts.push(`[${vBase}]split=2[${vBase}bg][${vBase}fg]`);
    parts.push(
      `[${vBase}bg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,` +
      `crop=${OUT_W}:${OUT_H},gblur=sigma=25[${vBase}bgblur]`
    );
    parts.push(`[${vBase}fg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[${vBase}fgfit]`);
    parts.push(`[${vBase}bgblur][${vBase}fgfit]overlay=(W-w)/2:(H-h)/2,setsar=1[${vOut}]`);
  } else {
    const slot = layout.slot;
    const box = cropBoxFor(srcW, srcH, slot.cx, slot.cy, OUT_W / OUT_H);
    parts.push(`[${vBase}]crop=${box.w}:${box.h}:${box.x}:${box.y},scale=${OUT_W}:${OUT_H},setsar=1[${vOut}]`);
  }
  return { parts, vOut };
}

// segments: [{ start, end, rate, layout: {type:'single'|'split', ...} }] in the INPUT's local
// time (after any -ss seek already applied by the caller).
function buildSegmentedFilter(segments, srcW, srcH, captionsAssPath) {
  const filterParts = [];
  const pairLabels = [];

  segments.forEach((seg, i) => {
    const rate = seg.rate || 1;
    const vBase = `v${i}b`;
    const aBase = `a${i}`;

    const vSetpts = rate === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${rate}`;
    filterParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=${vSetpts}[${vBase}]`);

    let aChain = `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS`;
    if (rate !== 1) aChain += `,atempo=${Math.min(2, Math.max(0.5, rate))}`;
    aChain += `[${aBase}]`;
    filterParts.push(aChain);

    const { parts, vOut } = layoutFilter(vBase, seg.layout, srcW, srcH);
    filterParts.push(...parts);
    pairLabels.push({ v: `[${vOut}]`, a: `[${aBase}]` });
  });

  let vLabel;
  let aLabel;
  if (segments.length === 1) {
    vLabel = pairLabels[0].v;
    aLabel = pairLabels[0].a;
  } else {
    const concatInputs = pairLabels.map((l) => `${l.v}${l.a}`).join('');
    filterParts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
    vLabel = '[vcat]';
    aLabel = '[acat]';
  }

  if (captionsAssPath && HAS_CAPTIONS) {
    const escaped = captionsAssPath.replace(/:/g, '\\:').replace(/'/g, "\\'");
    filterParts.push(`${vLabel}subtitles='${escaped}'[vfinal]`);
    vLabel = '[vfinal]';
  }

  return { filter: filterParts.join(';'), vLabel, aLabel };
}

// seek: optional -ss applied before -i (fast input seek into a large local source file).
// Use 0 when inputPath is already a pre-trimmed small clip (e.g. from a URL section download).
async function renderSegmented({ inputPath, seek = 0, srcW, srcH, segments, captionsAssPath, outputPath }) {
  const { filter, vLabel, aLabel } = buildSegmentedFilter(segments, srcW, srcH, captionsAssPath);
  const args = ['-y'];
  if (seek > 0) args.push('-ss', String(seek));
  args.push('-i', inputPath);
  args.push(
    '-filter_complex', filter,
    '-map', vLabel,
    '-map', aLabel,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', String(THREADS_PER_RENDER),
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outputPath
  );
  await run(FFMPEG_BIN, args);
}

module.exports = { renderSegmented, buildSegmentedFilter, cropBoxFor, OUT_W, OUT_H };
