const fs = require('fs');
const ai = require('./ai');
const blob = require('./blob');
const spend = require('./spend');
const { styleDescription } = require('./style');
const videoStitch = require('./videoStitch');

// A single Veo call is capped at a short clip in this phase (disclosed limitation — no
// frame-chaining across calls yet). 6s sits comfortably inside the proven 4-8s window.
const SCENE_CLIP_DURATION_SEC = 6;
const RESOLUTION_TIER = '720p'; // pricing bucket used for both estimate and actual spend

// Bounds total concurrent Veo calls across one episode generation run — same reasoning as
// pipeline.js's `heavyOps` Semaphore (real API calls, real cost, real rate limits; firing
// every scene at once would be both wasteful and likely to hit provider concurrency limits).
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async run(fn) {
    if (this.current >= this.max) await new Promise((resolve) => this.queue.push(resolve));
    this.current++;
    try { return await fn(); }
    finally { this.current--; const next = this.queue.shift(); if (next) next(); }
  }
}
const VIDEO_CONCURRENCY = Math.max(1, parseInt(process.env.CARTOON_VIDEO_CONCURRENCY || '2', 10));

function pricePerSec(tier) {
  return (ai.VEO_PRICE_PER_SEC[tier] || ai.VEO_PRICE_PER_SEC.lite)[RESOLUTION_TIER];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function estimateEpisodeCost(episode, tier) {
  const perSceneSeconds = SCENE_CLIP_DURATION_SEC;
  const totalDurationSec = episode.scenes.length * perSceneSeconds;
  const estimatedCostUsd = round2(totalDurationSec * pricePerSec(tier));
  return { estimatedCostUsd, totalDurationSec, perSceneSeconds, tier };
}

// episode.videoCostUsd reflects the cost of the CURRENTLY stored clips only (recomputed from
// scratch each time) — a display convenience, separate from project.spend.totalUsd (the real,
// monotonic running total of everything ever actually spent, tracked via spend.record below,
// which correctly still counts money spent on a scene that was later regenerated/discarded).
function recomputeCurrentEpisodeCost(episode) {
  episode.videoCostUsd = round2((episode.scenes || []).reduce((sum, s) => sum + (s.videoCostUsd || 0), 0));
}

async function fetchImageBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch reference image (${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: res.headers.get('content-type') || 'image/png' };
}

function buildScenePrompt(project, scene, location, sceneCharacters) {
  const dialogueText = (scene.dialogue || [])
    .map((d) => {
      const c = sceneCharacters.find((ch) => ch.id === d.characterId);
      return c ? `${c.name}: "${d.line}"` : null;
    })
    .filter(Boolean)
    .join(' ');
  const castText = sceneCharacters.length
    ? sceneCharacters.map((c) => `${c.name} (${c.appearance})`).join('; ')
    : 'no characters on screen';

  return [
    `${styleDescription(project.style)}.`,
    location ? `Setting: ${location.name} — ${location.description}.` : '',
    `Characters: ${castText}.`,
    `Action: ${scene.action}.`,
    scene.cameraDirection ? `Camera: ${scene.cameraDirection}.` : '',
    scene.expressions ? `Expressions/mood: ${scene.expressions}.` : '',
    dialogueText ? `Dialogue: ${dialogueText}.` : '',
    scene.soundEffects ? `Sound: ${scene.soundEffects}.` : '',
    'Short continuous animated shot, matching the reference images for character and location design exactly.',
  ].filter(Boolean).join(' ');
}

// Generates ONE scene's clip, uploads it, and records its cost on the scene — used both by
// the full-episode batch below and by single-scene regeneration.
async function generateSceneVideoForScene(project, episode, scene, tier) {
  const location = project.locations.find((l) => l.id === scene.locationId);
  const sceneCharacters = scene.characterIds.map((id) => project.characters.find((c) => c.id === id)).filter(Boolean);

  // Veo's live API rejects multi-image reference sets on these model slugs (verified against
  // the real endpoint — see ai.js's generateSceneVideo comment), so only one image anchors
  // the clip. The primary on-screen character matters most for recognizability; fall back to
  // the location when the scene has no characters in it.
  const primaryCharacter = sceneCharacters.find((c) => c.referenceImageUrl);
  const anchorUrl = primaryCharacter?.referenceImageUrl || location?.referenceImageUrl || null;
  let referenceImage = null;
  if (anchorUrl) {
    try { referenceImage = await fetchImageBuffer(anchorUrl); }
    catch (err) { console.warn(`[cartoon/video] failed to fetch reference image: ${err.message}`); }
  }

  const prompt = buildScenePrompt(project, scene, location, sceneCharacters);
  const { buffer, contentType, costUsd } = await ai.generateSceneVideo({
    prompt, tier, durationSec: SCENE_CLIP_DURATION_SEC, aspectRatio: '9:16', referenceImage,
  });
  const url = await blob.uploadVideo({ projectId: project._id, kind: 'scenes', entityId: scene.id, buffer, contentType });
  await blob.deleteReferenceImage(scene.videoUrl); // best-effort cleanup of a prior clip, if any

  scene.videoUrl = url;
  scene.videoStatus = 'done';
  scene.videoTier = tier;
  scene.videoError = null;
  scene.videoCostUsd = round2(costUsd);
  spend.record(project, { kind: 'video', context: `scene-video:${episode.title}`, tier, sceneId: scene.id, costUsd });
  return scene;
}

// Regenerates a single scene's clip. Does NOT re-stitch the episode — the episode's existing
// stitched video (if any) is marked stale so the UI can prompt the user to re-run the full
// episode generation to pick up the change, rather than silently going out of sync.
async function generateSingleSceneVideo(project, episode, scene, tier) {
  await generateSceneVideoForScene(project, episode, scene, tier);
  if (episode.videoUrl) episode.videoStatus = 'stale';
  recomputeCurrentEpisodeCost(episode);
  return scene;
}

// Generates every scene's clip (bounded concurrency), then stitches them into one episode
// video. `onProgress` is called on every scene state change and again once stitching starts,
// so the caller (server.js's async job) can report live progress via polling.
async function generateEpisodeVideo(project, episode, tier, onProgress) {
  const sem = new Semaphore(VIDEO_CONCURRENCY);
  const scenesSorted = [...episode.scenes].sort((a, b) => a.order - b.order);

  await Promise.all(scenesSorted.map((scene) => sem.run(async () => {
    scene.videoStatus = 'generating';
    onProgress?.({ sceneId: scene.id, status: 'generating' });
    try {
      await generateSceneVideoForScene(project, episode, scene, tier);
      onProgress?.({ sceneId: scene.id, status: 'done', videoUrl: scene.videoUrl, costUsd: scene.videoCostUsd });
    } catch (err) {
      console.error(`[cartoon/video] scene ${scene.id} failed:`, err.message);
      scene.videoStatus = 'error';
      scene.videoError = err.message;
      onProgress?.({ sceneId: scene.id, status: 'error', error: err.message });
    }
  })));

  const doneScenes = scenesSorted.filter((s) => s.videoStatus === 'done' && s.videoUrl);
  if (!doneScenes.length) {
    episode.videoStatus = 'error';
    throw new Error('No scene clips were generated successfully — check individual scene errors and retry.');
  }

  onProgress?.({ status: 'stitching' });
  const stitchedPath = await videoStitch.stitchSceneClips(doneScenes.map((s) => s.videoUrl));
  try {
    const stitchedBuffer = fs.readFileSync(stitchedPath);
    const episodeUrl = await blob.uploadVideo({ projectId: project._id, kind: 'episodes', entityId: episode.id, buffer: stitchedBuffer, contentType: 'video/mp4' });
    await blob.deleteReferenceImage(episode.videoUrl); // best-effort cleanup of a prior stitched cut

    episode.videoUrl = episodeUrl;
    episode.videoStatus = 'done';
    episode.videoTier = tier;
  } finally {
    fs.unlink(stitchedPath, () => {});
  }

  recomputeCurrentEpisodeCost(episode);
  const totalSpendUsd = spend.ensureSpend(project).totalUsd;

  return {
    episodeUrl: episode.videoUrl,
    scenesCompleted: doneScenes.length,
    scenesTotal: scenesSorted.length,
    episodeCostUsd: episode.videoCostUsd,
    totalSpendUsd,
  };
}

module.exports = {
  SCENE_CLIP_DURATION_SEC, estimateEpisodeCost, generateEpisodeVideo, generateSingleSceneVideo,
};
