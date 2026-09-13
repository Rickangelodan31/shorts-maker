require('dotenv').config();
// Additive: `vercel env pull .env.local` (the Cartoon Studio's AI Gateway setup step) writes
// here. Loaded after .env so nothing in .env is overridden — the two files hold disjoint
// vars in practice (video-clipper secrets vs VERCEL_OIDC_TOKEN).
require('dotenv').config({ path: '.env.local' });
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { runPipeline, renderMore, applyManualEdit, OUTPUT_DIR, TMP_DIR } = require('./src/pipeline');
const { computeUserTypeOptions, inferUserTypeFromLayout } = require('./src/effects');
const { UPLOAD_DIR } = require('./src/ingest');
const captionAi = require('./src/captionAi/generator');
const auth = require('./src/auth');
const youtube = require('./src/social/youtube');
const tiktok = require('./src/social/tiktok');
const instagram = require('./src/social/instagram');
const cartoonStore = require('./src/cartoon/store');
const cartoonCharacters = require('./src/cartoon/characters');
const cartoonLocations = require('./src/cartoon/locations');
const cartoonStory = require('./src/cartoon/story');
const cartoonStyle = require('./src/cartoon/style');
const cartoonVideo = require('./src/cartoon/video');
const cartoonAi = require('./src/cartoon/ai');

const PLATFORMS = { youtube, tiktok, instagram };

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// --- Auth (public routes) ---
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.createUser(username, password);
    req.session.userId = user.id;
    res.json({ ok: true, username: user.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.verifyUser(username, password);
    if (!user) return res.status(401).json({ error: 'Wrong username or password' });
    req.session.userId = user.id;
    res.json({ ok: true, username: user.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/login.html', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'style.css')));

// --- Everything below requires a signed-in session ---
app.use(auth.requireAuth);

app.get('/api/me', (req, res) => {
  const user = auth.getUser(req.session.userId);
  const connected = {};
  for (const name of Object.keys(PLATFORMS)) {
    connected[name] = {
      configured: PLATFORMS[name].isConfigured(),
      connected: !!user.connected?.[name],
    };
  }
  res.json({ username: user.username, connected });
});

// --- Social connect (OAuth) ---
app.get('/connect/:platform', (req, res) => {
  const platform = PLATFORMS[req.params.platform];
  if (!platform) return res.status(404).send('Unknown platform');
  if (!platform.isConfigured()) {
    return res.status(400).send(
      `${req.params.platform} isn't configured yet — add its client ID/secret to .env first (see README).`
    );
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.oauthPlatform = req.params.platform;
  res.redirect(platform.getAuthUrl(state));
});

app.get('/connect/:platform/callback', async (req, res) => {
  const name = req.params.platform;
  const platform = PLATFORMS[name];
  if (!platform) return res.status(404).send('Unknown platform');
  if (req.query.state !== req.session.oauthState) return res.status(400).send('State mismatch — try connecting again.');
  try {
    const tokens = await platform.exchangeCode(req.query.code);
    auth.setConnectedAccount(req.session.userId, name, tokens);
    res.redirect('/?connected=' + name);
  } catch (err) {
    res.status(500).send(`Failed to connect ${name}: ${err.message}`);
  }
});

app.post('/api/connect/:platform/disconnect', (req, res) => {
  auth.removeConnectedAccount(req.session.userId, req.params.platform);
  res.json({ ok: true });
});

// --- Post a rendered clip to a connected platform ---
app.post('/api/social/post', async (req, res) => {
  const { platform: name, clipUrl, title, caption, privacyStatus, videoUrl } = req.body || {};
  const platform = PLATFORMS[name];
  if (!platform) return res.status(400).json({ error: 'Unknown platform' });

  const user = auth.getUser(req.session.userId);
  const tokens = user.connected?.[name];
  if (!tokens) return res.status(400).json({ error: `Connect your ${name} account first` });

  try {
    let result;
    if (name === 'youtube') {
      const filePath = path.join(OUTPUT_DIR, clipUrl.replace(/^\/output\//, ''));
      if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Clip file not found' });
      result = await youtube.uploadVideo({ tokens, filePath, title: title || 'Short', description: caption || '', privacyStatus: privacyStatus || 'private' });
    } else if (name === 'tiktok') {
      const filePath = path.join(OUTPUT_DIR, clipUrl.replace(/^\/output\//, ''));
      if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Clip file not found' });
      result = await tiktok.uploadVideo({ tokens, filePath, title: title || caption || 'Short' });
    } else if (name === 'instagram') {
      result = await instagram.uploadVideo({ tokens, videoUrl, caption: caption || title || '' });
    }
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Shorts pipeline (unchanged) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const jobId = req.jobId;
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${jobId}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

const jobs = new Map();

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

// Bounded so a mistyped/malicious value can't blow up render time or memory (an earlier,
// hard-learned lesson: this app runs fine on machines with limited RAM, and every extra
// output pixel costs real encode time/memory per clip).
const MIN_OUTPUT_DIM = 200;
const MAX_OUTPUT_DIM = 1920;

function parseDimension(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < MIN_OUTPUT_DIM || n > MAX_OUTPUT_DIM) return fallback;
  return n % 2 === 0 ? n : n - 1; // h264 requires even dimensions
}

function parseOptions(body) {
  const theme = ['none', 'bold', 'clean', 'meme'].includes(body.captionTheme) ? body.captionTheme : 'none';
  const emojis = body.emojis === 'false' || body.emojis === false ? false : true;
  const tightenPacing = body.tightenPacing === 'true' || body.tightenPacing === true;
  const outputWidth = parseDimension(body.outputWidth, 1080);
  const outputHeight = parseDimension(body.outputHeight, 1920);
  return { captionTheme: theme, emojis, tightenPacing, outputWidth, outputHeight };
}

app.post('/api/jobs/upload', (req, res, next) => {
  req.jobId = newJobId();
  next();
}, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file received' });
  const job = { id: req.jobId, status: 'queued', message: 'Queued', results: [] };
  jobs.set(job.id, job);
  runPipeline(job, { uploadedPath: req.file.path, options: parseOptions(req.body) });
  res.json({ jobId: job.id });
});

app.post('/api/jobs/url', (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid video URL is required' });
  }
  const jobId = newJobId();
  const job = { id: jobId, status: 'queued', message: 'Queued', results: [] };
  jobs.set(jobId, job);
  runPipeline(job, { url, options: parseOptions(req.body) });
  res.json({ jobId });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { _ctx, ...safe } = job;
  res.json(safe);
});

app.post('/api/jobs/:id/more', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.candidates) return res.status(400).json({ error: 'Job is not ready yet' });
  renderMore(job).catch((err) => {
    job.results.push({ candidateIndex: -1, status: 'error', message: err.message });
  });
  res.json({ ok: true });
});

const USER_TYPES = ['full', 'split', 'reactor', 'content'];

function validateEditedSegments(segments, clipLength) {
  if (!Array.isArray(segments) || !segments.length) return 'segments must be a non-empty array';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (typeof s.start !== 'number' || typeof s.end !== 'number' || !Number.isFinite(s.start) || !Number.isFinite(s.end)) {
      return `segment ${i} has an invalid start/end`;
    }
    if (s.end - s.start < 0.3) return `segment ${i} is shorter than the 0.3s minimum`;
    if (!USER_TYPES.includes(s.userType)) return `segment ${i} has an invalid layout type`;
    if (i > 0 && Math.abs(s.start - segments[i - 1].end) > 0.05) return `segment ${i} is not contiguous with the previous one`;
  }
  if (segments[0].start < -0.05) return 'segments must start at 0';
  if (typeof clipLength === 'number' && Math.abs(segments[segments.length - 1].end - clipLength) > 0.5) {
    return 'segments must cover the full clip duration';
  }
  return null;
}

// Debug/visualization support (see spec: "build a debug mode so I can understand why the
// AI made a framing decision"). Reports exactly the layout data the render actually used —
// no re-computation, no guessing — so this can never drift from what was rendered.
function debugInfoForSegment(seg) {
  const l = seg.layout || {};
  const info = { layoutType: l.type || null };
  if (l.type === 'single') {
    info.crop = l.slot ? { cx: l.slot.cx, cy: l.slot.cy, w: l.slot.w ?? null, h: l.slot.h ?? null } : null;
    info.manual = !!l.manualCrop;
  } else if (l.type === 'split') {
    info.slots = (l.slots || []).map((s) => ({ cx: s.cx, cy: s.cy }));
  } else if (l.type === 'reaction-split' || l.type === 'reaction-inset') {
    info.faceBox = l.faceBox ? { cx: l.faceBox.cx, cy: l.faceBox.cy, w: l.faceBox.w, h: l.faceBox.h } : null;
    info.faceMargin = l.faceMargin ?? null;
    info.contentBox = l.contentBox ? { cx: l.contentBox.cx, cy: l.contentBox.cy, w: l.contentBox.w, h: l.contentBox.h } : null;
  } else if (l.type === 'fit') {
    info.box = l.box ? { cx: l.box.cx, cy: l.box.cy, w: l.box.w, h: l.box.h } : null; // null box = whole frame
  }
  if (l.contentFraming) {
    info.contentFraming = {
      mode: l.contentFraming.mode,
      retainedPct: Math.round(l.contentFraming.retainedFraction * 100),
    };
  }
  return info;
}

app.get('/api/jobs/:id/clips/:index/timeline', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const index = parseInt(req.params.index, 10);
  const entry = job.results?.find((r) => r.candidateIndex === index);
  const cand = job.candidates?.[index];
  if (!entry || !cand || entry.status !== 'done') return res.status(404).json({ error: 'Clip not found or not ready' });
  const segments = (entry.segments || []).map((s) => ({
    start: s.start, end: s.end, userType: inferUserTypeFromLayout(s), debug: debugInfoForSegment(s),
  }));
  const userTypeOptions = computeUserTypeOptions(cand.layoutTimeline, cand.resolvedReactionComposite);
  const reactionComposite = cand.resolvedReactionComposite
    ? {
      isReactionComposite: cand.resolvedReactionComposite.isReactionComposite,
      confidence: cand.resolvedReactionComposite.confidence,
      source: cand.resolvedReactionComposite.source,
    }
    : null;
  res.json({ segments, userTypeOptions, clipLength: entry.length, reactionComposite });
});

app.post('/api/jobs/:id/clips/:index/timeline', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const index = parseInt(req.params.index, 10);
  const entry = job.results?.find((r) => r.candidateIndex === index);
  if (!entry || entry.status !== 'done') return res.status(400).json({ error: 'Clip is not ready to edit' });

  const { segments } = req.body || {};
  const error = validateEditedSegments(segments, entry.length);
  if (error) return res.status(400).json({ error });

  applyManualEdit(job, index, segments).catch(() => {}); // entry.status/message already set on failure
  res.json({ ok: true });
});

// --- AI Cartoon & Story Studio (Phase 1: story/character/location system) ---
// Separate subsystem (src/cartoon/*) — persisted in MongoDB, images in Vercel Blob, AI via
// the Gateway adapter in src/cartoon/ai.js. Does not touch the video-clipper code above.
const cartoonImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Video generation jobs (Phase 2) — same ephemeral in-memory-Map + polling pattern as the
// video-clipper's `jobs` above. Only progress tracking lives here; the real result
// (scene/episode videoUrl, spend log) is persisted to MongoDB via cartoonStore.withProject,
// so a finished video survives a server restart even though an in-flight job doesn't.
const cartoonVideoJobs = new Map();

// Async route handlers don't auto-forward rejections to Express error handling — wrap them
// so a thrown Error (e.g. "Project not found", "AI Gateway not configured") becomes a clean
// JSON error response instead of an unhandled rejection.
function ah(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error('[cartoon] request failed:', err.message);
    res.status(400).json({ error: err.message });
  });
}

// --- AI on-screen hook/caption generator (src/captionAi/*) ---
// Sits strictly AFTER video generation (the initial hook is generated automatically inside
// pipeline.js:renderOneClip once a clip is done) and never touches the composition/render
// pipeline. These two routes only ever read/write entry.hook on the same in-memory
// job/candidate the manual-editor timeline routes above already use.
function findClipForCaptions(jobId, candidateIndex) {
  const job = jobs.get(jobId);
  if (!job) return { error: 'Job not found' };
  const entry = job.results?.find((r) => r.candidateIndex === candidateIndex);
  const cand = job.candidates?.[candidateIndex];
  if (!entry || !cand || entry.status !== 'done') return { error: 'Clip not found or not ready' };
  return { job, entry, cand };
}

const EMPTY_HOOK = { status: 'ready', primary: null, alternatives: [], caption: null, hashtags: [], selectedText: null };

app.post('/api/captions/generate', ah(async (req, res) => {
  const { videoId, candidateIndex, action, style, userCaption } = req.body || {};
  const index = parseInt(candidateIndex, 10);
  if (!videoId || Number.isNaN(index)) return res.status(400).json({ error: 'videoId and candidateIndex are required' });
  const { entry, cand, error } = findClipForCaptions(videoId, index);
  if (error) return res.status(404).json({ error });

  const analysis = entry.hook?.analysis || null;
  const priorTexts = [entry.hook?.primary?.text, ...(entry.hook?.alternatives || []).map((a) => a.text)].filter(Boolean);

  // "retry" re-runs the FULL initial (vision) analysis — used by the "AI caption
  // unavailable -> Try Again" UI when there was never a usable analysis to build on.
  if (action === 'retry') {
    const fileName = `short_${index}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, videoId, fileName);
    const tmpDir = path.join(TMP_DIR, videoId, `hookretry_${index}_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      entry.hook = await captionAi.generateInitial({ entry, cand, outputPath, tmpDir });
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    }
    return res.json(entry.hook);
  }

  let result;
  if (action === 'improve') {
    if (!userCaption || !userCaption.trim()) return res.status(400).json({ error: 'userCaption is required for action=improve' });
    result = await captionAi.improveCaption({ entry, cand, analysis, userCaption, excludeTexts: priorTexts });
  } else if (action === 'more') {
    result = await captionAi.generateMore({ entry, cand, analysis, style, excludeTexts: priorTexts });
  } else {
    return res.status(400).json({ error: 'action must be "more", "improve", or "retry"' });
  }

  if (result.status === 'unavailable') return res.json({ status: 'unavailable', alternatives: [] });
  if (result.status !== 'ready') return res.json({ status: 'error', alternatives: [] });

  // Merge fresh alternatives into the persisted hook state — never touches the primary or
  // any already-shown alternative, so re-opening the clip later still shows every option
  // that was ever generated for it (the caching requirement: no AI call on a plain reopen).
  entry.hook = entry.hook || { ...EMPTY_HOOK };
  entry.hook.alternatives = [...(entry.hook.alternatives || []), ...result.alternatives];
  entry.hook.status = 'ready';
  res.json({ status: 'ready', alternatives: result.alternatives, hook: entry.hook });
}));

// Records the user's final choice (a generated option as-is, or hand-edited text) — no AI
// call, just persistence, exactly like the caching requirement asks for.
app.post('/api/captions/select', (req, res) => {
  const { videoId, candidateIndex, text, style } = req.body || {};
  const index = parseInt(candidateIndex, 10);
  if (!videoId || Number.isNaN(index) || typeof text !== 'string') {
    return res.status(400).json({ error: 'videoId, candidateIndex and text are required' });
  }
  const { entry, error } = findClipForCaptions(videoId, index);
  if (error) return res.status(404).json({ error });
  entry.hook = entry.hook || { ...EMPTY_HOOK };
  entry.hook.selectedText = text.trim();
  if (style) entry.hook.selectedStyle = style;
  res.json({ ok: true, hook: entry.hook });
});

app.get('/api/cartoon/styles', (req, res) => res.json({ presets: cartoonStyle.listPresets() }));

app.post('/api/cartoon/projects', ah(async (req, res) => {
  const project = await cartoonStore.createProject(req.session.userId, req.body?.name);
  res.json(project);
}));

app.get('/api/cartoon/projects', ah(async (req, res) => {
  const projects = await cartoonStore.listProjects(req.session.userId);
  res.json(projects);
}));

app.get('/api/cartoon/projects/:id', ah(async (req, res) => {
  const project = await cartoonStore.getProject(req.session.userId, req.params.id);
  res.json(project);
}));

app.patch('/api/cartoon/projects/:id', ah(async (req, res) => {
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    if (typeof req.body.name === 'string') p.name = req.body.name;
    if (req.body.style) p.style = { ...p.style, ...req.body.style };
    if (req.body.storyBible) p.storyBible = { ...p.storyBible, ...req.body.storyBible };
  });
  res.json(project);
}));

app.delete('/api/cartoon/projects/:id', ah(async (req, res) => {
  await cartoonStore.deleteProject(req.session.userId, req.params.id);
  res.json({ ok: true });
}));

// --- Characters ---
app.post('/api/cartoon/projects/:id/characters', ah(async (req, res) => {
  let created;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    created = req.body?.instruction
      ? await cartoonCharacters.generateCharacter(p, req.body.instruction)
      : cartoonCharacters.addCharacter(p, req.body || {});
  });
  res.json({ project, character: created });
}));

app.patch('/api/cartoon/projects/:id/characters/:charId', ah(async (req, res) => {
  let updated;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    updated = cartoonCharacters.updateCharacter(p, req.params.charId, req.body || {});
  });
  res.json({ project, character: updated });
}));

app.delete('/api/cartoon/projects/:id/characters/:charId', ah(async (req, res) => {
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    cartoonCharacters.removeCharacter(p, req.params.charId);
  });
  res.json({ project });
}));

app.post('/api/cartoon/projects/:id/characters/:charId/image', cartoonImageUpload.single('file'), ah(async (req, res) => {
  let updated;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    if (req.file) {
      updated = await cartoonCharacters.setCharacterImageFromUpload(p, req.params.charId, req.file.buffer, req.file.mimetype);
    } else {
      updated = await cartoonCharacters.generateCharacterImage(p, req.params.charId, {
        mode: req.body.mode || 'newPose',
        instruction: req.body.instruction || '',
        force: req.body.force === 'true' || req.body.force === true,
      });
    }
  });
  res.json({ project, character: updated });
}));

// --- Locations ---
app.post('/api/cartoon/projects/:id/locations', ah(async (req, res) => {
  let created;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    created = req.body?.instruction
      ? await cartoonLocations.generateLocation(p, req.body.instruction)
      : cartoonLocations.addLocation(p, req.body || {});
  });
  res.json({ project, location: created });
}));

app.patch('/api/cartoon/projects/:id/locations/:locId', ah(async (req, res) => {
  let updated;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    updated = cartoonLocations.updateLocation(p, req.params.locId, req.body || {});
  });
  res.json({ project, location: updated });
}));

app.delete('/api/cartoon/projects/:id/locations/:locId', ah(async (req, res) => {
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    cartoonLocations.removeLocation(p, req.params.locId);
  });
  res.json({ project });
}));

app.post('/api/cartoon/projects/:id/locations/:locId/image', cartoonImageUpload.single('file'), ah(async (req, res) => {
  let updated;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    if (req.file) {
      updated = await cartoonLocations.setLocationImageFromUpload(p, req.params.locId, req.file.buffer, req.file.mimetype);
    } else {
      updated = await cartoonLocations.generateLocationImage(p, req.params.locId, {
        mode: req.body.mode || 'newAngle',
        instruction: req.body.instruction || '',
        force: req.body.force === 'true' || req.body.force === true,
      });
    }
  });
  res.json({ project, location: updated });
}));

// --- Story / nursery rhyme / scenes ---
app.post('/api/cartoon/projects/:id/story', ah(async (req, res) => {
  let episode;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    episode = await cartoonStory.generateStory(p, {
      mode: req.body.userStoryText ? 'user' : 'ai',
      idea: req.body.idea || '',
      userStoryText: req.body.userStoryText || '',
    });
  });
  res.json({ project, episode });
}));

app.post('/api/cartoon/projects/:id/nursery-rhyme', ah(async (req, res) => {
  let episode;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    episode = await cartoonStory.generateNurseryRhyme(p, { idea: req.body.idea || '', length: req.body.length });
  });
  res.json({ project, episode });
}));

app.post('/api/cartoon/projects/:id/episodes/:epId/scenes/:sceneId/regenerate', ah(async (req, res) => {
  let scene;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    scene = await cartoonStory.regenerateScene(p, req.params.epId, req.params.sceneId, req.body?.instruction || '');
  });
  res.json({ project, scene });
}));

app.patch('/api/cartoon/projects/:id/episodes/:epId/scenes/:sceneId', ah(async (req, res) => {
  let scene;
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    scene = cartoonStory.updateSceneManual(p, req.params.epId, req.params.sceneId, req.body || {});
  });
  res.json({ project, scene });
}));

app.post('/api/cartoon/projects/:id/episodes/:epId/scenes/reorder', ah(async (req, res) => {
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    cartoonStory.reorderScenes(p, req.params.epId, req.body?.sceneIds || []);
  });
  res.json({ project });
}));

app.delete('/api/cartoon/projects/:id/episodes/:epId', ah(async (req, res) => {
  const project = await cartoonStore.withProject(req.session.userId, req.params.id, (p) => {
    cartoonStory.removeEpisode(p, req.params.epId);
  });
  res.json({ project });
}));

// --- Video generation (Phase 2, Veo 3.1) ---
app.get('/api/cartoon/video/available', (req, res) => res.json({ available: cartoonAi.isVideoAvailable() }));

app.get('/api/cartoon/projects/:id/episodes/:epId/video/estimate', ah(async (req, res) => {
  const project = await cartoonStore.getProject(req.session.userId, req.params.id);
  const episode = cartoonStory.findEpisode(project, req.params.epId);
  const tier = ['lite', 'fast', 'standard'].includes(req.query.tier) ? req.query.tier : 'lite';
  res.json(cartoonVideo.estimateEpisodeCost(episode, tier));
}));

// Starts an async job that generates every scene's clip then stitches the episode. Returns
// {jobId} immediately (mirrors POST /api/jobs/url's fire-and-forget shape); poll it via
// GET /api/cartoon/video-jobs/:jobId. Real money is spent here — the frontend is required to
// have already shown the /estimate figure and gotten explicit confirmation before calling this.
app.post('/api/cartoon/projects/:id/episodes/:epId/video', ah(async (req, res) => {
  if (!cartoonAi.isVideoAvailable()) throw new Error('Video generation is not configured (needs GOOGLE_GENERATIVE_AI_API_KEY).');
  const tier = ['lite', 'fast', 'standard'].includes(req.body?.tier) ? req.body.tier : 'lite';
  const project = await cartoonStore.getProject(req.session.userId, req.params.id);
  const episode = cartoonStory.findEpisode(project, req.params.epId);

  const jobId = cartoonStore.newId();
  const job = {
    id: jobId, status: 'running', kind: 'episode', episodeId: episode.id,
    scenes: episode.scenes.map((s) => ({ sceneId: s.id, status: 'queued' })),
    episodeVideoUrl: null, episodeCostUsd: null, totalSpendUsd: null, error: null,
  };
  cartoonVideoJobs.set(jobId, job);

  cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    const ep = cartoonStory.findEpisode(p, req.params.epId);
    await cartoonVideo.generateEpisodeVideo(p, ep, tier, (update) => {
      if (update.status === 'stitching') { job.status = 'stitching'; return; }
      const s = job.scenes.find((x) => x.sceneId === update.sceneId);
      if (s) Object.assign(s, update);
    });
    return p;
  }).then((savedProject) => {
    const ep = cartoonStory.findEpisode(savedProject, req.params.epId);
    job.status = 'done';
    job.episodeVideoUrl = ep.videoUrl;
    job.episodeCostUsd = ep.videoCostUsd;
    job.totalSpendUsd = savedProject.spend?.totalUsd ?? null;
  }).catch((err) => {
    console.error('[cartoon/video] episode job failed:', err.message);
    job.status = 'error';
    job.error = err.message;
  });

  res.json({ jobId });
}));

// Regenerates ONE scene's clip only. Does not auto-restitch the episode — the episode's
// existing video is marked stale on save; the user re-runs the full episode job to pick it up.
app.post('/api/cartoon/projects/:id/episodes/:epId/scenes/:sceneId/video', ah(async (req, res) => {
  if (!cartoonAi.isVideoAvailable()) throw new Error('Video generation is not configured (needs GOOGLE_GENERATIVE_AI_API_KEY).');
  const tier = ['lite', 'fast', 'standard'].includes(req.body?.tier) ? req.body.tier : 'lite';

  const jobId = cartoonStore.newId();
  const job = {
    id: jobId, status: 'running', kind: 'scene', episodeId: req.params.epId,
    scenes: [{ sceneId: req.params.sceneId, status: 'generating' }],
    sceneVideoUrl: null, sceneCostUsd: null, totalSpendUsd: null, error: null,
  };
  cartoonVideoJobs.set(jobId, job);

  cartoonStore.withProject(req.session.userId, req.params.id, async (p) => {
    const ep = cartoonStory.findEpisode(p, req.params.epId);
    const scene = cartoonStory.findScene(ep, req.params.sceneId);
    await cartoonVideo.generateSingleSceneVideo(p, ep, scene, tier);
    return p;
  }).then((savedProject) => {
    const ep = cartoonStory.findEpisode(savedProject, req.params.epId);
    const scene = cartoonStory.findScene(ep, req.params.sceneId);
    job.status = 'done';
    job.scenes[0] = { sceneId: scene.id, status: 'done', videoUrl: scene.videoUrl, costUsd: scene.videoCostUsd };
    job.sceneVideoUrl = scene.videoUrl;
    job.sceneCostUsd = scene.videoCostUsd;
    job.totalSpendUsd = savedProject.spend?.totalUsd ?? null;
  }).catch((err) => {
    console.error('[cartoon/video] scene job failed:', err.message);
    job.status = 'error';
    job.error = err.message;
    job.scenes[0] = { sceneId: req.params.sceneId, status: 'error', error: err.message };
  });

  res.json({ jobId });
}));

app.get('/api/cartoon/video-jobs/:jobId', (req, res) => {
  const job = cartoonVideoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.use('/output', express.static(OUTPUT_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Shorts Maker running at http://localhost:${PORT}`);
});
