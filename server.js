require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { runPipeline, renderMore, OUTPUT_DIR } = require('./src/pipeline');
const { UPLOAD_DIR } = require('./src/ingest');
const auth = require('./src/auth');
const youtube = require('./src/social/youtube');
const tiktok = require('./src/social/tiktok');
const instagram = require('./src/social/instagram');

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

function parseOptions(body) {
  const theme = ['none', 'bold', 'clean', 'meme'].includes(body.captionTheme) ? body.captionTheme : 'none';
  const emojis = body.emojis === 'false' || body.emojis === false ? false : true;
  const tightenPacing = body.tightenPacing === 'true' || body.tightenPacing === true;
  return { captionTheme: theme, emojis, tightenPacing };
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

app.use('/output', express.static(OUTPUT_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Shorts Maker running at http://localhost:${PORT}`);
});
