const os = require('os');
const { run, FFMPEG_BIN, HAS_CAPTIONS, HAS_VIDEOTOOLBOX } = require('./ffutil');
const {
  OUT_W: DEFAULT_OUT_W, OUT_H: DEFAULT_OUT_H,
  evenify, cropBoxFor, cropBoxForRegion, regionBoundedCropBox, regionToPixelBox,
  FACE_CROP_MARGIN_STEPS, INSET_FACE_AR, buildAnimatedCropExprs,
} = require('./geometry');

// When several clips render concurrently, cap each ffmpeg's thread count so they share
// cores instead of each grabbing all of them and thrashing. (Only meaningful for the
// software encoder — VideoToolbox doesn't expose a -threads knob at all.)
const THREADS_PER_RENDER = Math.max(2, Math.floor(os.cpus().length / 3));
const XFADE_DUR = 0.35;
const USE_HW_ENCODE = HAS_VIDEOTOOLBOX && process.env.DISABLE_HW_ENCODE !== '1';
const HW_BITRATE = process.env.RENDER_VIDEO_BITRATE || '8M';

// Content-preserving "fit": optionally crops to a source region first (box — a normalized
// center-based {cx,cy,w,h}; pass null to use the whole frame), then contains that region
// inside targetW x targetH with a blurred, cropped-to-fill copy of the SAME pixels as
// background filler instead of hard-cropping whatever doesn't match the target AR. Shared
// by the whole-frame 'fit' layout and by reaction-split/reaction-inset's content half,
// which is exactly why it's parametrized on an arbitrary (vBase, vOut) pair rather than
// assuming it's the only thing happening in the filter graph.
function fitBoxFilter(vBase, vOut, box, srcW, srcH, targetW, targetH) {
  const parts = [];
  let src = `[${vBase}]`;
  if (box) {
    const region = regionToPixelBox(srcW, srcH, box);
    parts.push(`${src}crop=${region.w}:${region.h}:${region.x}:${region.y}[${vBase}reg]`);
    src = `[${vBase}reg]`;
  }
  parts.push(`${src}split=2[${vBase}bg][${vBase}fg]`);
  parts.push(
    `[${vBase}bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,` +
    `crop=${targetW}:${targetH},gblur=sigma=25[${vBase}bgblur]`
  );
  parts.push(`[${vBase}fg]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[${vBase}fgfit]`);
  parts.push(`[${vBase}bgblur][${vBase}fgfit]overlay=(W-w)/2:(H-h)/2,setsar=1[${vOut}]`);
  return parts;
}

// Plan doc M7 — continuous subject tracking. Builds an ffmpeg crop filter string: a plain
// static crop when no keyframes are present (today's exact behavior, byte-identical), or a
// smoothly panning crop when effects.js attached `layout.keyframes`/`layout.keyframeSize`
// (buildKeyframesForRun). render.js stays purely mechanical here — it never decides WHETHER
// interpolation is safe (effects.js already re-validated every keyframe before attaching
// them); this only turns already-validated data into filter syntax. `x='EXPR'`/`y='EXPR'`
// (quoted) is ffmpeg's documented form for a crop filter's x/y in per-frame expression mode.
function cropFilterStr(layout, staticBox, srcW, srcH) {
  if (layout?.keyframes?.length >= 2 && layout.keyframeSize) {
    const { w, h } = layout.keyframeSize;
    const { xExpr, yExpr } = buildAnimatedCropExprs(layout.keyframes, srcW, srcH, w, h);
    return `crop=${w}:${h}:x='${xExpr}':y='${yExpr}'`;
  }
  return `crop=${staticBox.w}:${staticBox.h}:${staticBox.x}:${staticBox.y}`;
}

// Builds the filter_complex for one segment's layout (single crop, split-screen, fit, or a
// reaction/facecam-composite layout), operating on an already-trimmed/retimed stream label.
// render.js is purely mechanical here — it never decides WHETHER a layout is valid or which
// fallback to use, only how to turn an already-finalized layout object into filter syntax.
// outW/outH: target output canvas — defaults to the app's standard 1080x1920 short, but a
// job may request any size (see pipeline.js job.options.outputWidth/outputHeight). Must
// match whatever effects.js used when it crop-validated this layout, or the crop that gets
// built here could be one that was never actually checked.
function layoutFilter(vBase, layout, srcW, srcH, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  const parts = [];
  const vOut = `${vBase}out`;
  if (layout.type === 'split') {
    const bandH = evenify(outH / 2);
    const targetAR = outW / bandH;
    const [s1, s2] = layout.slots;
    const box1 = cropBoxFor(srcW, srcH, s1.cx, s1.cy, targetAR);
    const box2 = cropBoxFor(srcW, srcH, s2.cx, s2.cy, targetAR);
    parts.push(`[${vBase}]split=2[${vBase}x][${vBase}y]`);
    parts.push(`[${vBase}x]crop=${box1.w}:${box1.h}:${box1.x}:${box1.y},scale=${outW}:${bandH},setsar=1[${vBase}p1]`);
    parts.push(`[${vBase}y]crop=${box2.w}:${box2.h}:${box2.x}:${box2.y},scale=${outW}:${bandH},setsar=1[${vBase}p2]`);
    parts.push(`[${vBase}p1][${vBase}p2]vstack=inputs=2[${vOut}]`);
  } else if (layout.type === 'reaction-split') {
    // Two INDEPENDENTLY framed regions (the reacting face, and the content being reacted
    // to) rather than two arbitrary point-centered slots — layout.faceBox/contentBox come
    // from effects.js's facecam-vs-content separation, already crop-validated.
    const bandH = evenify(outH / 2);
    const targetAR = outW / bandH;
    // Use exactly the margin effects.js validated against face landmarks (defaulting to
    // the tightest step when no validation ran, e.g. no face ever detected) — a "cover"
    // crop that fills the band, zoomed in enough that the reactor reads as prominent
    // rather than small-with-lots-of-background.
    const faceMargin = layout.faceMargin ?? FACE_CROP_MARGIN_STEPS[0];
    const faceCrop = cropBoxForRegion(srcW, srcH, layout.faceBox, targetAR, faceMargin);
    parts.push(`[${vBase}]split=2[${vBase}x][${vBase}y]`);
    parts.push(`[${vBase}x]${cropFilterStr(layout, faceCrop, srcW, srcH)},scale=${outW}:${bandH},setsar=1[${vBase}p1]`);
    // The content half gets its OWN framing decision (effects.js:decideContentFraming) —
    // a cover-crop when little would be lost, or a content-preserving contain+blur fit
    // when a crop would have to cut off gameplay/UI/action to fill the band. Both branches
    // must still land in exactly outW x bandH so the vstack below lines up.
    if (layout.contentFraming?.mode === 'fit') {
      parts.push(...fitBoxFilter(`${vBase}y`, `${vBase}p2`, layout.contentBox, srcW, srcH, outW, bandH));
    } else {
      // regionBoundedCropBox, NOT cropBoxForRegion: the content box's own edge IS the
      // boundary with the reactor's excluded region — a crop that grows past it (which
      // cropBoxForRegion does deliberately, for face margins) would bleed the reactor's
      // pixels into the content panel instead of showing content.
      const contentCrop = regionBoundedCropBox(srcW, srcH, layout.contentBox, targetAR);
      parts.push(`[${vBase}y]crop=${contentCrop.w}:${contentCrop.h}:${contentCrop.x}:${contentCrop.y},scale=${outW}:${bandH},setsar=1[${vBase}p2]`);
    }
    parts.push(`[${vBase}p1][${vBase}p2]vstack=inputs=2[${vOut}]`);
  } else if (layout.type === 'reaction-inset') {
    // Content fills the frame; a small fixed-position (bottom-right) face inset overlays
    // it — used when the facecam is small relative to the content. Plain rectangular PiP
    // for v1; rounded corners/border are a deferred nice-to-have, not implemented here.
    const faceMargin = layout.faceMargin ?? FACE_CROP_MARGIN_STEPS[0];
    const faceCrop = cropBoxForRegion(srcW, srcH, layout.faceBox, INSET_FACE_AR, faceMargin);
    const insetW = evenify(outW * 0.42);
    const insetH = evenify(insetW / INSET_FACE_AR);
    const marginPx = 40;
    parts.push(`[${vBase}]split=2[${vBase}bg][${vBase}fg]`);
    // Same content-preserving decision as reaction-split's content half, just filling the
    // whole canvas instead of one band since there's no separate content panel here.
    if (layout.contentFraming?.mode === 'fit') {
      parts.push(...fitBoxFilter(`${vBase}bg`, `${vBase}bgout`, layout.contentBox, srcW, srcH, outW, outH));
    } else {
      // See the reaction-split content branch above: bounded-within-region, never grown
      // past the content box's own edge into the reactor's excluded territory.
      const contentCrop = regionBoundedCropBox(srcW, srcH, layout.contentBox, outW / outH);
      parts.push(`[${vBase}bg]crop=${contentCrop.w}:${contentCrop.h}:${contentCrop.x}:${contentCrop.y},scale=${outW}:${outH},setsar=1[${vBase}bgout]`);
    }
    parts.push(`[${vBase}fg]${cropFilterStr(layout, faceCrop, srcW, srcH)},scale=${insetW}:${insetH},setsar=1[${vBase}fgout]`);
    parts.push(`[${vBase}bgout][${vBase}fgout]overlay=W-w-${marginPx}:H-h-${marginPx}[${vOut}]`);
  } else if (layout.type === 'fit') {
    // Show the WHOLE frame (or, if layout.box is set, just that source region — see
    // effects.js:buildContentOnlyLayout) letterboxed over a blurred, zoomed-in copy of the
    // same pixels as filler — used whenever a hard crop would have to cut off someone's
    // face, or (content regions) would destroy gameplay/UI/action that must stay visible.
    parts.push(...fitBoxFilter(vBase, vOut, layout.box || null, srcW, srcH, outW, outH));
  } else {
    // Manually-edited segments (see effects.js:mapUserTypeToLayout) attach `manualCrop`, a
    // sized region (so a zoom nudge has something to act on) — auto-generated 'single'
    // layouts never set this and keep the original fixed-max-size crop unchanged.
    // `regionBounded` (see effects.js:buildContentOnlyLayout) marks a manualCrop that is a
    // content region carved out by contentRegionExcludingFacecam — must stay bounded within
    // its own footprint, same reasoning as reaction-split/reaction-inset's content branch.
    const targetAR = outW / outH;
    const box = layout.regionBounded
      ? regionBoundedCropBox(srcW, srcH, layout.manualCrop, targetAR)
      : layout.manualCrop
        ? cropBoxForRegion(srcW, srcH, layout.manualCrop, targetAR, layout.manualCropMargin ?? 0.15)
        : cropBoxFor(srcW, srcH, layout.slot.cx, layout.slot.cy, targetAR);
    parts.push(`[${vBase}]${cropFilterStr(layout, box, srcW, srcH)},scale=${outW}:${outH},setsar=1[${vOut}]`);
  }
  return { parts, vOut };
}

// A segment is a candidate crossfade boundary only if it's part of the new dynamic-beat
// machinery (a reaction/content-beat splice, or a reaction/facecam-composite layout) —
// ordinary scene-change boundaries between single/split/fit keep today's hard cut, since
// those weren't reported as a problem and a universal crossfade would add render cost and
// touch working behavior for no requested benefit.
function isCrossfadeCandidate(seg) {
  return seg.tag === 'reaction' || seg.tag === 'content-beat'
    || seg.layout.type === 'reaction-split' || seg.layout.type === 'reaction-inset';
}

// segments: [{ start, end, rate, layout: {type:..., ...}, tag? }] in the INPUT's local
// time (after any -ss seek already applied by the caller). NOT assumed to be chronological
// — a hook cold-open may place a later-in-source segment first.
function buildSegmentedFilter(segments, srcW, srcH, captionsAssPath, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H) {
  const filterParts = [];

  const segOut = segments.map((seg, i) => {
    const rate = seg.rate || 1;
    const vBase = `v${i}b`;
    const aBase = `a${i}`;

    const vSetpts = rate === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${rate}`;
    filterParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=${vSetpts}[${vBase}]`);

    let aChain = `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS`;
    if (rate !== 1) aChain += `,atempo=${Math.min(2, Math.max(0.5, rate))}`;
    aChain += `[${aBase}]`;
    filterParts.push(aChain);

    const { parts, vOut } = layoutFilter(vBase, seg.layout, srcW, srcH, outW, outH);
    filterParts.push(...parts);
    const outLen = (seg.end - seg.start) / rate;
    return { v: `[${vOut}]`, a: `[${aBase}]`, outLen, rate, crossfadeCandidate: isCrossfadeCandidate(seg) };
  });

  let vLabel;
  let aLabel;
  if (segOut.length === 1) {
    vLabel = segOut[0].v;
    aLabel = segOut[0].a;
  } else {
    let curV = segOut[0].v;
    let curA = segOut[0].a;
    let cumulativeLen = segOut[0].outLen;
    for (let i = 1; i < segOut.length; i++) {
      const prev = segOut[i - 1];
      const next = segOut[i];
      const outV = `xc${i}v`;
      const outA = `xc${i}a`;
      const canCrossfade = (prev.crossfadeCandidate || next.crossfadeCandidate)
        && prev.rate === 1 && next.rate === 1
        && cumulativeLen > XFADE_DUR && next.outLen > XFADE_DUR;

      if (canCrossfade) {
        const offset = (cumulativeLen - XFADE_DUR).toFixed(3);
        // xfade requires BOTH inputs to share a timebase, but a plain source trim, a prior
        // concat's output, and a prior xfade's output can each carry a different internal
        // timebase — chaining them straight into xfade intermittently fails with
        // "timebase do not match" once the graph mixes concat and xfade nodes. Forcing a
        // fixed, explicit timebase on both inputs right before every xfade call makes the
        // result independent of whatever produced them upstream.
        const tbA = `${outV}tba`;
        const tbB = `${outV}tbb`;
        filterParts.push(`${curV}settb=1/1000000[${tbA}]`);
        filterParts.push(`${next.v}settb=1/1000000[${tbB}]`);
        filterParts.push(`[${tbA}][${tbB}]xfade=transition=fade:duration=${XFADE_DUR}:offset=${offset}[${outV}]`);
        filterParts.push(`${curA}${next.a}acrossfade=d=${XFADE_DUR}[${outA}]`);
        cumulativeLen = cumulativeLen + next.outLen - XFADE_DUR;
      } else {
        filterParts.push(`${curV}${next.v}concat=n=2:v=1:a=0[${outV}]`);
        filterParts.push(`${curA}${next.a}concat=n=2:v=0:a=1[${outA}]`);
        cumulativeLen += next.outLen;
      }
      curV = `[${outV}]`;
      curA = `[${outA}]`;
    }
    vLabel = curV;
    aLabel = curA;
  }

  if (captionsAssPath && HAS_CAPTIONS) {
    const escaped = captionsAssPath.replace(/:/g, '\\:').replace(/'/g, "\\'");
    filterParts.push(`${vLabel}subtitles='${escaped}'[vfinal]`);
    vLabel = '[vfinal]';
  }

  return { filter: filterParts.join(';'), vLabel, aLabel };
}

function doubledBitrate(bitrateStr) {
  const m = String(bitrateStr).match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  return m ? `${parseFloat(m[1]) * 2}${m[2]}` : bitrateStr;
}
const HW_BUFSIZE = doubledBitrate(HW_BITRATE);

function videoCodecArgs(hw) {
  return hw
    ? ['-c:v', 'h264_videotoolbox', '-b:v', HW_BITRATE, '-maxrate', HW_BITRATE, '-bufsize', HW_BUFSIZE, '-allow_sw', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', String(THREADS_PER_RENDER)];
}

// seek: optional -ss applied before -i (fast input seek into a large local source file).
// Use 0 when inputPath is already a pre-trimmed small clip (e.g. from a URL section download).
// outW/outH: final output canvas size (default 1080x1920) — see pipeline.js job.options.
async function renderSegmented({ inputPath, seek = 0, srcW, srcH, segments, captionsAssPath, outputPath, outW = DEFAULT_OUT_W, outH = DEFAULT_OUT_H }) {
  const { filter, vLabel, aLabel } = buildSegmentedFilter(segments, srcW, srcH, captionsAssPath, outW, outH);
  const baseArgs = ['-y'];
  if (seek > 0) baseArgs.push('-ss', String(seek));
  baseArgs.push('-i', inputPath, '-filter_complex', filter, '-map', vLabel, '-map', aLabel);
  const tailArgs = ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputPath];

  if (USE_HW_ENCODE) {
    try {
      await run(FFMPEG_BIN, [...baseArgs, ...videoCodecArgs(true), ...tailArgs]);
      return;
    } catch (err) {
      // VideoToolbox can be listed as available yet still fail at runtime in some
      // environments (headless CI, a sandboxed/remote session with no GPU access) — fall
      // back to the software encoder rather than let the whole render fail.
      console.warn('[render] hardware encode failed, falling back to software libx264:', err.message);
    }
  }
  await run(FFMPEG_BIN, [...baseArgs, ...videoCodecArgs(false), ...tailArgs]);
}

module.exports = { renderSegmented, buildSegmentedFilter, layoutFilter, OUT_W: DEFAULT_OUT_W, OUT_H: DEFAULT_OUT_H };
