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

// --- Output size preset ---
const aspectPreset = document.getElementById('aspect-preset');
const dimensionInputs = document.getElementById('dimension-inputs');
const outputWidthInput = document.getElementById('output-width');
const outputHeightInput = document.getElementById('output-height');

aspectPreset.addEventListener('change', () => {
  if (aspectPreset.value === 'custom') {
    dimensionInputs.classList.remove('hidden');
    return;
  }
  dimensionInputs.classList.add('hidden');
  const [w, h] = aspectPreset.value.split('x');
  outputWidthInput.value = w;
  outputHeightInput.value = h;
});

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
  if (effect === 'content-beat') return '<span class="badge reaction">content beat</span>';
  if (effect === 'hook') return '<span class="badge reaction">cold-open hook</span>';
  return '';
}

function peopleNote(faceCount, layoutSwitches) {
  const base = faceCount >= 3 ? 'group shot' : faceCount === 2 ? 'split screen' : 'single crop';
  return layoutSwitches > 0 ? `${base} (switches ${layoutSwitches}x)` : base;
}

// --- AI on-screen hook/caption generator ---
// Renders from entry.hook (see server.js POST /api/captions/generate and
// src/captionAi/*) — a NEW feature that runs after rendering; it never affects the video
// pixels or the composition/layout editor above it on the card.
const STYLE_META = {
  curiosity: { label: 'Curiosity', emoji: '👀' },
  shock: { label: 'Shock', emoji: '😳' },
  controversial: { label: 'Controversial', emoji: '💀' },
  funny: { label: 'Funny', emoji: '😂' },
  reaction: { label: 'Reaction', emoji: '😭' },
  story: { label: 'Story / Context', emoji: '' },
  punchy: { label: 'Short / Punchy', emoji: '💀' },
  question: { label: 'Question', emoji: '👀' },
};

function hookCard(item, { primary = false } = {}) {
  const meta = STYLE_META[item.style] || { label: item.style, emoji: '' };
  const card = document.createElement('div');
  card.className = primary ? 'hook-card hook-card-primary' : 'hook-card';
  card.innerHTML = `
    <div class="hook-card-style">${primary ? '🔥 AI RECOMMENDED' : `${meta.emoji} ${meta.label}`}</div>
    <div class="hook-card-text" contenteditable="true" spellcheck="false"></div>
    <div class="hook-card-actions">
      <button type="button" class="hook-use-btn">Use</button>
      <button type="button" class="hook-copy-btn">Copy</button>
    </div>
  `;
  // Set as a DOM property, not embedded in the template string above, so AI-generated text
  // can't break out of the HTML regardless of what characters it contains.
  card.querySelector('.hook-card-text').textContent = item.text;
  return card;
}

function buildHookSection(entry, jobId) {
  const wrap = document.createElement('div');
  wrap.className = 'hook-section';

  if (entry.hook === undefined) {
    wrap.innerHTML = '<div class="hook-header">AI CAPTION</div><p class="hint">Analyzing the clip for a hook...</p>';
    return wrap;
  }

  const hook = entry.hook;
  if (hook.status === 'unavailable') {
    wrap.innerHTML = '<div class="hook-header">AI CAPTION</div><p class="hint">AI captions aren\'t configured for this app right now.</p>';
    return wrap;
  }

  wrap.innerHTML = '<div class="hook-header">AI CAPTION</div>';
  const body = document.createElement('div');
  wrap.appendChild(body);

  function useThisText(text, style) {
    fetch('/api/captions/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: jobId, candidateIndex: entry.candidateIndex, text, style }),
    }).then(() => { hook.selectedText = text; refresh(); }).catch(() => {});
  }

  function wireCard(card, item) {
    const textEl = card.querySelector('.hook-card-text');
    card.querySelector('.hook-use-btn').addEventListener('click', () => useThisText(textEl.textContent, item.style));
    card.querySelector('.hook-copy-btn').addEventListener('click', () => {
      navigator.clipboard?.writeText(textEl.textContent).catch(() => {});
    });
    if (hook.selectedText && hook.selectedText === item.text) card.classList.add('hook-card-selected');
  }

  function refresh() {
    body.innerHTML = '';

    if (hook.status === 'error' && !hook.primary && !hook.alternatives.length) {
      const errBox = document.createElement('div');
      errBox.className = 'hook-error';
      errBox.innerHTML = '<p class="hint">AI caption generation failed.</p>';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.textContent = 'Try Again';
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying...';
        try {
          const res = await fetch('/api/captions/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId: jobId, candidateIndex: entry.candidateIndex, action: 'retry' }),
          });
          Object.assign(hook, await res.json());
        } finally {
          refresh();
        }
      });
      errBox.appendChild(retryBtn);
      body.appendChild(errBox);
      return;
    }

    if (hook.primary) {
      const primaryCard = hookCard(hook.primary, { primary: true });
      wireCard(primaryCard, hook.primary);
      body.appendChild(primaryCard);
    }

    if (hook.alternatives && hook.alternatives.length) {
      const moreLabel = document.createElement('div');
      moreLabel.className = 'hook-more-label';
      moreLabel.textContent = 'MORE OPTIONS';
      body.appendChild(moreLabel);
      const altWrap = document.createElement('div');
      altWrap.className = 'hook-alt-list';
      hook.alternatives.forEach((item) => {
        const card = hookCard(item);
        wireCard(card, item);
        altWrap.appendChild(card);
      });
      body.appendChild(altWrap);
    }

    const controls = document.createElement('div');
    controls.className = 'hook-controls';
    controls.innerHTML = `
      <div class="hook-generate-row">
        <select class="hook-style-select">
          <option value="">Auto</option>
          ${Object.entries(STYLE_META).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}
        </select>
        <button type="button" class="hook-more-btn">Generate More</button>
      </div>
      <div class="hook-own-row">
        <textarea class="hook-own-input" rows="2" placeholder="Write your own caption..."></textarea>
        <button type="button" class="hook-improve-btn">✨ Generate Better Versions</button>
      </div>
    `;
    body.appendChild(controls);

    const moreBtn = controls.querySelector('.hook-more-btn');
    moreBtn.addEventListener('click', async () => {
      moreBtn.disabled = true;
      moreBtn.textContent = 'Generating...';
      try {
        const style = controls.querySelector('.hook-style-select').value;
        const res = await fetch('/api/captions/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: jobId, candidateIndex: entry.candidateIndex, action: 'more', style: style || undefined }),
        });
        const data = await res.json();
        if (data.status === 'ready' && data.hook) Object.assign(hook, data.hook);
      } finally {
        moreBtn.disabled = false;
        moreBtn.textContent = 'Generate More';
        refresh();
      }
    });

    const improveBtn = controls.querySelector('.hook-improve-btn');
    improveBtn.addEventListener('click', async () => {
      const own = controls.querySelector('.hook-own-input').value.trim();
      if (!own) return;
      improveBtn.disabled = true;
      improveBtn.textContent = 'Generating...';
      try {
        const res = await fetch('/api/captions/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: jobId, candidateIndex: entry.candidateIndex, action: 'improve', userCaption: own }),
        });
        const data = await res.json();
        if (data.status === 'ready' && data.hook) Object.assign(hook, data.hook);
        else if (data.status === 'unavailable') alert('AI captions aren\'t configured for this app right now.');
      } finally {
        improveBtn.disabled = false;
        improveBtn.textContent = '✨ Generate Better Versions';
        refresh();
      }
    });
  }

  refresh();
  return wrap;
}

async function postToSocial(clipUrl, platform, caption, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Posting...';
  try {
    // Instagram's API fetches the video from a public URL rather than accepting an uploaded
    // file (unlike YouTube/TikTok, which read the rendered file straight off disk server-side)
    // — clipUrl is only a relative /output/... path, so build the absolute URL Instagram needs.
    const videoUrl = new URL(clipUrl, window.location.origin).href;
    const res = await fetch('/api/social/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, clipUrl, videoUrl, title: caption ? caption.slice(0, 90) : 'Short', caption }),
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

const TYPE_LABELS = { full: 'Full screen', split: 'Split screen', reactor: 'Reactor only', content: 'Content only' };

function renderCard(entry, jobId) {
  if (entry.status === 'done') {
    const div = document.createElement('div');
    div.className = 'result-item';
    const connectedNames = Object.keys(connectedPlatforms).filter((p) => connectedPlatforms[p].connected);
    const postControls = connectedNames.length
      ? `<div class="post-row">
          <textarea class="post-caption" rows="2" placeholder="Caption for this post&hellip;"></textarea>
          <div class="post-row-controls">
            <select class="post-platform">${connectedNames.map((p) => `<option value="${p}">${PLATFORM_LABELS[p]}</option>`).join('')}</select>
            <button class="post-btn">Post</button>
          </div>
        </div>`
      : '';
    div.innerHTML = `
      <video src="${entry.url}" controls playsinline muted></video>
      <div class="label">${labelForLength(entry.length)} ${effectBadge(entry.effect)}</div>
      <div class="meta">from ${entry.start}s &middot; ${peopleNote(entry.faceCount, entry.layoutSwitches)}</div>
      <div class="actions-row">
        <a href="${entry.url}" download>Download</a>
        <button class="edit-layout-btn">Edit layout</button>
      </div>
      ${postControls}
      <div class="editor-panel hidden"></div>
    `;
    if (connectedNames.length) {
      // Set via the DOM property (not embedded in the template string above) so the
      // AI-generated caption text can't break out of the HTML regardless of what characters
      // it contains — no manual escaping needed this way.
      div.querySelector('.post-caption').value = entry.caption || '';
      const select = div.querySelector('.post-platform');
      const captionInput = div.querySelector('.post-caption');
      const btn = div.querySelector('.post-btn');
      btn.addEventListener('click', () => postToSocial(entry.url, select.value, captionInput.value, btn));
    }
    const editBtn = div.querySelector('.edit-layout-btn');
    const panel = div.querySelector('.editor-panel');
    const video = div.querySelector('video');
    editBtn.addEventListener('click', () => toggleEditor(jobId, entry, panel, video, editBtn));
    div.appendChild(buildHookSection(entry, jobId));
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
    resultsGrid.appendChild(renderCard(entry, job.id));
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

  // A 'done' clip's AI hook (see buildHookSection) finishes generating slightly AFTER the
  // clip itself is marked done (pipeline.js runs it as a trailing step) — entry.hook stays
  // undefined in between. Keep polling through that window too, or the UI would stop
  // refreshing right before the hook actually arrives.
  const stillWorking = !job.results?.length || job.results.some((e) => (
    (e.status !== 'done' && e.status !== 'error') || (e.status === 'done' && e.hook === undefined)
  ));
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
  const outputWidth = document.getElementById('output-width').value;
  const outputHeight = document.getElementById('output-height').value;

  try {
    let jobId;
    if (activeTab === 'url') {
      const url = document.getElementById('url-input').value.trim();
      if (!url) throw new Error('Enter a video URL first.');
      const res = await fetch('/api/jobs/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, captionTheme, emojis, tightenPacing, outputWidth, outputHeight }),
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
      form.append('outputWidth', outputWidth);
      form.append('outputHeight', outputHeight);
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

// --- Manual layout editor ---

async function toggleEditor(jobId, entry, panel, video, editBtn) {
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    editBtn.textContent = 'Edit layout';
    return;
  }
  editBtn.textContent = 'Close editor';
  panel.classList.remove('hidden');
  panel.innerHTML = '<p class="hint">Loading timeline...</p>';
  try {
    const res = await fetch(`/api/jobs/${jobId}/clips/${entry.candidateIndex}/timeline`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load timeline');
    const state = {
      jobId, index: entry.candidateIndex, clipLength: data.clipLength,
      segments: data.segments.map((s) => ({ ...s })), userTypeOptions: data.userTypeOptions,
      reactionComposite: data.reactionComposite || null,
      selectedIdx: null,
    };
    buildEditorUI(state, panel, video, editBtn);
  } catch (err) {
    panel.innerHTML = `<p class="hint">Failed to load editor: ${err.message}</p>`;
  }
}

function adjust(seg, key, fn) {
  if (key) {
    seg.cropAdjust = seg.cropAdjust || {};
    seg.cropAdjust[key] = seg.cropAdjust[key] || { dcx: 0, dcy: 0, dzoom: 1 };
    fn(seg.cropAdjust[key]);
  } else {
    seg.cropAdjust = seg.cropAdjust || { dcx: 0, dcy: 0, dzoom: 1 };
    fn(seg.cropAdjust);
  }
}

function buildNudgePad(seg, key, label, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'nudge-group';
  const title = document.createElement('div');
  title.className = 'nudge-label';
  title.textContent = label;
  wrap.appendChild(title);
  const pad = document.createElement('div');
  pad.className = 'nudge-pad';
  const STEP = 0.03;
  const dirs = [
    ['←', () => adjust(seg, key, (a) => { a.dcx -= STEP; })],
    ['→', () => adjust(seg, key, (a) => { a.dcx += STEP; })],
    ['↑', () => adjust(seg, key, (a) => { a.dcy -= STEP; })],
    ['↓', () => adjust(seg, key, (a) => { a.dcy += STEP; })],
    ['zoom +', () => adjust(seg, key, (a) => { a.dzoom *= 0.9; })],
    ['zoom −', () => adjust(seg, key, (a) => { a.dzoom *= 1.1; })],
  ];
  dirs.forEach(([symbol, fn]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nudge-btn';
    b.textContent = symbol;
    b.addEventListener('click', () => { fn(); onChange(); });
    pad.appendChild(b);
  });
  wrap.appendChild(pad);
  return wrap;
}

const LAYOUT_TYPE_LABELS = {
  single: 'Single crop', split: 'Split screen', 'reaction-split': 'Reaction split (2 panels)',
  'reaction-inset': 'Reaction inset (PiP)', fit: 'Content-preserving fit (letterboxed)',
};

// "Why did it frame it this way?" panel — surfaces exactly the layout data the render
// actually used (see server.js:debugInfoForSegment), so a human can see the composition
// engine's real decision instead of guessing from the output video alone.
function buildDebugPanel(seg, state) {
  const wrap = document.createElement('details');
  wrap.className = 'debug-panel';
  const d = seg.debug || {};
  const lines = [];
  lines.push(`<div><b>Layout:</b> ${LAYOUT_TYPE_LABELS[d.layoutType] || d.layoutType || '—'}</div>`);
  if (d.contentFraming) {
    const modeLabel = d.contentFraming.mode === 'fit' ? 'Preserved (fit + blur)' : 'Cropped';
    lines.push(`<div><b>Content framing:</b> ${modeLabel} — ${d.contentFraming.retainedPct}% of the content region kept</div>`);
  }
  if (d.faceBox) {
    lines.push(`<div><b>Face box:</b> center (${d.faceBox.cx.toFixed(2)}, ${d.faceBox.cy.toFixed(2)}), margin ${d.faceMargin ?? '—'}</div>`);
  }
  if (d.contentBox) {
    lines.push(`<div><b>Content box:</b> center (${d.contentBox.cx.toFixed(2)}, ${d.contentBox.cy.toFixed(2)}), size ${(d.contentBox.w * 100).toFixed(0)}%×${(d.contentBox.h * 100).toFixed(0)}%</div>`);
  }
  if (d.crop) {
    lines.push(`<div><b>Crop center:</b> (${d.crop.cx.toFixed(2)}, ${d.crop.cy.toFixed(2)})${d.manual ? ' (manual)' : ''}</div>`);
  }
  if (d.box) {
    lines.push(`<div><b>Preserved region:</b> center (${d.box.cx.toFixed(2)}, ${d.box.cy.toFixed(2)}), size ${(d.box.w * 100).toFixed(0)}%×${(d.box.h * 100).toFixed(0)}%</div>`);
  } else if (d.layoutType === 'fit') {
    lines.push('<div><b>Preserved region:</b> whole frame</div>');
  }
  const rc = state.reactionComposite;
  if (rc?.isReactionComposite) {
    lines.push(`<div><b>Reaction-composite detection:</b> confidence ${(rc.confidence * 100).toFixed(0)}% (${rc.source})</div>`);
  }
  wrap.innerHTML = `<summary>Why this framing?</summary><div class="debug-panel-body">${lines.join('')}</div>`;
  return wrap;
}

function buildEditorUI(state, panel, video, editBtn) {
  panel.innerHTML = `
    <div class="timeline-bar"></div>
    <div class="editor-controls"><button type="button" class="split-here-btn">Split at current time</button></div>
    <div class="inspector"></div>
    <div class="editor-actions">
      <button type="button" class="editor-cancel-btn">Cancel</button>
      <button type="button" class="editor-save-btn">Save &amp; re-render</button>
    </div>
  `;
  const bar = panel.querySelector('.timeline-bar');
  const inspector = panel.querySelector('.inspector');

  function refresh() {
    renderTimelineBar();
    renderInspector();
  }

  function renderTimelineBar() {
    bar.innerHTML = '';
    state.segments.forEach((seg, i) => {
      const block = document.createElement('div');
      block.className = `timeline-block type-${seg.userType}${i === state.selectedIdx ? ' selected' : ''}`;
      block.style.left = `${(seg.start / state.clipLength) * 100}%`;
      block.style.width = `${Math.max(0.5, ((seg.end - seg.start) / state.clipLength) * 100)}%`;
      block.title = `${TYPE_LABELS[seg.userType]} (${seg.start.toFixed(1)}s–${seg.end.toFixed(1)}s)`;
      block.addEventListener('click', () => { state.selectedIdx = i; refresh(); });
      bar.appendChild(block);

      if (i < state.segments.length - 1) {
        const handle = document.createElement('div');
        handle.className = 'timeline-handle';
        handle.style.left = `${(seg.end / state.clipLength) * 100}%`;
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const barRect = bar.getBoundingClientRect();
          const onMove = (moveEvent) => {
            const x = moveEvent.clientX - barRect.left;
            let t = (x / barRect.width) * state.clipLength;
            const minLen = 0.3;
            t = Math.max(state.segments[i].start + minLen, Math.min(state.segments[i + 1].end - minLen, t));
            state.segments[i].end = t;
            state.segments[i + 1].start = t;
            renderTimelineBar();
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
        bar.appendChild(handle);
      }
    });
  }

  function renderInspector() {
    inspector.innerHTML = '';
    if (state.selectedIdx == null || !state.segments[state.selectedIdx]) {
      inspector.innerHTML = '<p class="hint">Click a segment on the timeline to edit it.</p>';
      return;
    }
    const seg = state.segments[state.selectedIdx];

    const header = document.createElement('div');
    header.className = 'inspector-header';
    header.innerHTML = `<span>${seg.start.toFixed(1)}s – ${seg.end.toFixed(1)}s</span>`;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'delete-segment-btn';
    delBtn.textContent = 'Delete';
    delBtn.disabled = state.segments.length <= 1;
    delBtn.addEventListener('click', () => {
      const i = state.selectedIdx;
      if (state.segments.length <= 1) return;
      if (i === 0) {
        state.segments[1].start = state.segments[0].start;
        state.segments.splice(0, 1);
      } else {
        state.segments[i - 1].end = state.segments[i].end;
        state.segments.splice(i, 1);
      }
      state.selectedIdx = null;
      refresh();
    });
    header.appendChild(delBtn);
    inspector.appendChild(header);

    const typeRow = document.createElement('div');
    typeRow.className = 'type-switcher';
    for (const t of ['full', 'split', 'reactor', 'content']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = TYPE_LABELS[t];
      btn.className = 'type-btn' + (seg.userType === t ? ' active' : '');
      btn.disabled = !state.userTypeOptions.includes(t);
      btn.addEventListener('click', () => { seg.userType = t; seg.cropAdjust = null; refresh(); });
      typeRow.appendChild(btn);
    }
    inspector.appendChild(typeRow);

    if (seg.userType !== 'full') {
      let groups = [[null, 'Position / zoom']];
      if (seg.userType === 'split') {
        groups = state.userTypeOptions.includes('content')
          ? [['face', 'Reactor position'], ['content', 'Content position']]
          : []; // ordinary 2-person split isn't crop-adjustable yet
      }
      groups.forEach(([key, label]) => inspector.appendChild(buildNudgePad(seg, key, label, refresh)));
    }

    inspector.appendChild(buildDebugPanel(seg, state));
  }

  refresh();

  panel.querySelector('.split-here-btn').addEventListener('click', () => {
    const t = video.currentTime;
    const idx = state.segments.findIndex((s) => t > s.start + 0.15 && t < s.end - 0.15);
    if (idx === -1) return;
    const seg = state.segments[idx];
    const clone = { ...seg, cropAdjust: seg.cropAdjust ? JSON.parse(JSON.stringify(seg.cropAdjust)) : null };
    seg.end = t;
    clone.start = t;
    state.segments.splice(idx + 1, 0, clone);
    state.selectedIdx = idx + 1;
    refresh();
  });

  panel.querySelector('.editor-cancel-btn').addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    editBtn.textContent = 'Edit layout';
  });

  panel.querySelector('.editor-save-btn').addEventListener('click', async () => {
    const btn = panel.querySelector('.editor-save-btn');
    btn.disabled = true;
    btn.textContent = 'Re-rendering...';
    try {
      const res = await fetch(`/api/jobs/${state.jobId}/clips/${state.index}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: state.segments }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      pollJob(state.jobId, { immediate: true });
    } catch (err) {
      alert('Failed to save: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Save & re-render';
    }
  });
}
