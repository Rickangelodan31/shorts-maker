const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');
let activeTab = 'url';

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== activeTab));
  });
});

const generateBtn = document.getElementById('generate-btn');
const statusCard = document.getElementById('status-card');
const statusMessage = document.getElementById('status-message');
const statusProgressWrap = document.getElementById('status-progress-wrap');
const statusProgress = document.getElementById('status-progress');
const resultsCard = document.getElementById('results-card');
const resultsGrid = document.getElementById('results-grid');
const errorCard = document.getElementById('error-card');
const errorMessage = document.getElementById('error-message');

let moreInFlight = false;
let connectedPlatforms = {};

const PLATFORM_LABELS = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };

async function loadAccount() {
  const res = await fetch('/api/me');
  if (res.status === 401) {
    window.location.href = '/login.html';
    return;
  }
  const data = await res.json();
  document.getElementById('account-username').textContent = `Signed in as ${data.username}`;
  connectedPlatforms = data.connected;
  renderAccountsGrid(data.connected);
}

function renderAccountsGrid(connected) {
  const grid = document.getElementById('accounts-grid');
  grid.innerHTML = '';
  for (const name of Object.keys(PLATFORM_LABELS)) {
    const info = connected[name] || {};
    const tile = document.createElement('div');
    tile.className = 'account-tile';
    let statusText, statusClass = '';
    if (!info.configured) statusText = 'Not set up (needs API keys in .env)';
    else if (info.connected) { statusText = 'Connected'; statusClass = 'connected'; }
    else statusText = 'Not connected';

    tile.innerHTML = `
      <div class="platform-name">${PLATFORM_LABELS[name]}</div>
      <div class="status ${statusClass}">${statusText}</div>
      <button ${!info.configured ? 'disabled' : ''}>${info.connected ? 'Disconnect' : 'Connect'}</button>
    `;
    const btn = tile.querySelector('button');
    btn.addEventListener('click', async () => {
      if (info.connected) {
        await fetch(`/api/connect/${name}/disconnect`, { method: 'POST' });
        loadAccount();
      } else {
        window.location.href = `/connect/${name}`;
      }
    });
    grid.appendChild(tile);
  }
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

loadAccount();

function labelForLength(sec) {
  if (sec == null) return '';
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m}m ${s}s` : `${m} min`;
  }
  return `${Math.round(sec)}s`;
}

const STATUS_LABELS = {
  pending: 'Waiting...',
  'downloading clip': 'Downloading clip...',
  'finding faces': 'Detecting people...',
  'planning shot': 'Planning camera + effects...',
  rendering: 'Rendering...',
};

function effectBadge(effect) {
  if (effect === 'slowmo') return '<span class="badge slowmo">dramatic slow-mo</span>';
  if (effect === 'reaction') return '<span class="badge reaction">reaction cut</span>';
  return '';
}

function peopleNote(faceCount, layoutSwitches) {
  const base = faceCount >= 3 ? 'group shot' : faceCount === 2 ? 'split screen' : 'single crop';
  return layoutSwitches > 0 ? `${base} (switches ${layoutSwitches}x)` : base;
}

async function postToSocial(clipUrl, platform, btn, select) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Posting...';
  try {
    const res = await fetch('/api/social/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, clipUrl, title: 'Short', caption: '' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Post failed');
    btn.textContent = 'Posted!';
  } catch (err) {
    alert(`${PLATFORM_LABELS[platform] || platform} post failed: ${err.message}`);
    btn.textContent = original;
    btn.disabled = false;
  }
}

function renderCard(entry) {
  if (entry.status === 'done') {
    const div = document.createElement('div');
    div.className = 'result-item';
    const connectedNames = Object.keys(connectedPlatforms).filter((p) => connectedPlatforms[p].connected);
    const postControls = connectedNames.length
      ? `<div class="post-row">
          <select class="post-platform">${connectedNames.map((p) => `<option value="${p}">${PLATFORM_LABELS[p]}</option>`).join('')}</select>
          <button class="post-btn">Post</button>
        </div>`
      : '';
    div.innerHTML = `
      <video src="${entry.url}" controls playsinline muted></video>
      <div class="label">${labelForLength(entry.length)} ${effectBadge(entry.effect)}</div>
      <div class="meta">from ${entry.start}s &middot; ${peopleNote(entry.faceCount, entry.layoutSwitches)}</div>
      <a href="${entry.url}" download>Download</a>
      ${postControls}
    `;
    if (connectedNames.length) {
      const select = div.querySelector('.post-platform');
      const btn = div.querySelector('.post-btn');
      btn.addEventListener('click', () => postToSocial(entry.url, select.value, btn, select));
    }
    return div;
  }
  if (entry.status === 'error') {
    const div = document.createElement('div');
    div.className = 'result-item errored';
    div.innerHTML = `<div class="working-label">Failed: ${entry.message || 'unknown error'}</div>`;
    return div;
  }
  const div = document.createElement('div');
  div.className = 'result-item working';
  const label = STATUS_LABELS[entry.status] || entry.status;
  const pct = typeof entry.progress === 'number' ? ` (${Math.round(entry.progress)}%)` : '';
  div.innerHTML = `<div class="mini-spinner"></div><div class="working-label">${label}${pct}</div>`;
  return div;
}

async function requestMore(jobId, btn) {
  if (moreInFlight) return;
  moreInFlight = true;
  btn.disabled = true;
  btn.textContent = 'Generating...';
  try {
    await fetch(`/api/jobs/${jobId}/more`, { method: 'POST' });
  } finally {
    moreInFlight = false;
    pollJob(jobId, { immediate: true });
  }
}

function renderResults(job) {
  resultsCard.classList.remove('hidden');
  resultsGrid.innerHTML = '';

  const sorted = [...job.results].sort((a, b) => a.candidateIndex - b.candidateIndex);
  for (const entry of sorted) {
    resultsGrid.appendChild(renderCard(entry));
  }

  const totalCandidates = job.candidates?.length;
  const allSettled = sorted.every((e) => e.status === 'done' || e.status === 'error');
  if (typeof totalCandidates === 'number' && allSettled) {
    const btn = document.createElement('button');
    btn.className = 'more-btn';
    const hasMore = sorted.length < totalCandidates;
    btn.textContent = hasMore ? 'Generate another moment' : 'No more distinct highlights found';
    btn.disabled = !hasMore || moreInFlight;
    btn.addEventListener('click', () => requestMore(job.id, btn));
    resultsGrid.appendChild(btn);
  }
}

async function pollJob(jobId, opts = {}) {
  const res = await fetch(`/api/jobs/${jobId}`);
  const job = await res.json();
  job.id = jobId;

  if (job.status === 'error' && (!job.results || !job.results.length)) {
    statusCard.classList.add('hidden');
    resultsCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    errorMessage.textContent = `Something went wrong: ${job.message}`;
    generateBtn.disabled = false;
    return;
  }

  if (job.results && job.results.length) {
    renderResults(job);
  }

  const stillWorking = !job.results?.length || job.results.some((e) => e.status !== 'done' && e.status !== 'error');
  const overallActive = job.status === 'downloading' || job.status === 'analyzing' || (job.status === 'rendering' && stillWorking);

  if (overallActive && (!job.results || !job.results.length)) {
    statusCard.classList.remove('hidden');
    statusMessage.textContent = job.message || job.status;
    if (typeof job.progress === 'number') {
      statusProgressWrap.classList.remove('hidden');
      statusProgress.style.width = `${Math.min(100, job.progress)}%`;
    } else {
      statusProgressWrap.classList.add('hidden');
    }
  } else {
    statusCard.classList.add('hidden');
  }

  if (job.status === 'done' && !stillWorking) {
    generateBtn.disabled = false;
    return;
  }
  if (job.status === 'error') {
    generateBtn.disabled = false;
    return;
  }

  setTimeout(() => pollJob(jobId), opts.immediate ? 400 : 1500);
}

async function startJob() {
  statusCard.classList.remove('hidden');
  resultsCard.classList.add('hidden');
  errorCard.classList.add('hidden');
  resultsGrid.innerHTML = '';
  statusProgressWrap.classList.add('hidden');
  statusMessage.textContent = 'Starting...';
  generateBtn.disabled = true;

  const captionTheme = document.getElementById('caption-theme').value;
  const emojis = document.getElementById('emoji-toggle').checked;
  const tightenPacing = document.getElementById('pacing-toggle').checked;

  try {
    let jobId;
    if (activeTab === 'url') {
      const url = document.getElementById('url-input').value.trim();
      if (!url) throw new Error('Enter a video URL first.');
      const res = await fetch('/api/jobs/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, captionTheme, emojis, tightenPacing }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start job');
      jobId = data.jobId;
    } else {
      const fileInput = document.getElementById('file-input');
      if (!fileInput.files.length) throw new Error('Choose a video file first.');
      const form = new FormData();
      form.append('video', fileInput.files[0]);
      form.append('captionTheme', captionTheme);
      form.append('emojis', String(emojis));
      form.append('tightenPacing', String(tightenPacing));
      const res = await fetch('/api/jobs/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start job');
      jobId = data.jobId;
    }
    pollJob(jobId);
  } catch (err) {
    statusCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    errorMessage.textContent = err.message;
    generateBtn.disabled = false;
  }
}

generateBtn.addEventListener('click', startJob);
