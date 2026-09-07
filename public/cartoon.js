// --- AI Cartoon & Story Studio frontend ---
// Talks only to /api/cartoon/* — completely separate from app.js's shorts-maker logic.

// --- Top-level app tab switching (Shorts Maker <-> Cartoon Studio) ---
const appTabs = document.querySelectorAll('.app-tab');
const appPanels = { shorts: document.getElementById('app-shorts'), cartoon: document.getElementById('app-cartoon') };
appTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    appTabs.forEach((t) => t.classList.toggle('active', t === tab));
    const target = tab.dataset.appTab;
    Object.entries(appPanels).forEach(([key, el]) => el.classList.toggle('hidden', key !== target));
  });
});

async function cartoonFetch(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showCartoonError(message) {
  const card = document.getElementById('cartoon-error-card');
  document.getElementById('cartoon-error-message').textContent = message;
  card.classList.remove('hidden');
  setTimeout(() => card.classList.add('hidden'), 6000);
}

let currentProject = null;
let stylePresets = [];

// --- Video generation (Phase 2, Veo 3.1) ---
// Mirrors src/cartoon/ai.js's VEO_PRICE_PER_SEC (720p bucket) and src/cartoon/video.js's
// SCENE_CLIP_DURATION_SEC — used only for the up-front confirm-dialog estimate shown before
// a single-scene regen (the episode-level estimate comes from the real server endpoint).
const VEO_PRICE_PER_SEC = { lite: 0.05, fast: 0.10, standard: 0.40 };
const SCENE_CLIP_DURATION_SEC = 6;
const TIER_LABELS = {
  lite: `Lite ($${(VEO_PRICE_PER_SEC.lite * SCENE_CLIP_DURATION_SEC).toFixed(2)}/scene)`,
  fast: `Fast ($${(VEO_PRICE_PER_SEC.fast * SCENE_CLIP_DURATION_SEC).toFixed(2)}/scene)`,
  standard: `Standard ($${(VEO_PRICE_PER_SEC.standard * SCENE_CLIP_DURATION_SEC).toFixed(2)}/scene)`,
};

function formatUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

let videoGenAvailable = null;
async function checkVideoAvailable() {
  if (videoGenAvailable !== null) return videoGenAvailable;
  try {
    const data = await cartoonFetch('/api/cartoon/video/available');
    videoGenAvailable = !!data.available;
  } catch (err) {
    videoGenAvailable = false;
  }
  return videoGenAvailable;
}

function tierSelectHtml(cls) {
  return `<select class="${cls}">${Object.entries(TIER_LABELS).map(([v, label]) => `<option value="${v}"${v === 'lite' ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
}

async function pollCartoonVideoJob(jobId, onUpdate) {
  let job;
  try {
    const res = await fetch(`/api/cartoon/video-jobs/${jobId}`);
    job = await res.json();
    if (!res.ok) { onUpdate({ status: 'error', error: job.error || 'Job not found' }); return; }
  } catch (err) {
    onUpdate({ status: 'error', error: err.message });
    return;
  }
  onUpdate(job);
  if (job.status === 'done' || job.status === 'error') return;
  setTimeout(() => pollCartoonVideoJob(jobId, onUpdate), 3000);
}

async function refreshCurrentProject() {
  currentProject = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}`);
  renderEpisodes();
}

// --- Project picker ---
async function loadProjects() {
  try {
    const projects = await cartoonFetch('/api/cartoon/projects');
    const grid = document.getElementById('cartoon-projects-grid');
    grid.innerHTML = '';
    if (!projects.length) {
      grid.innerHTML = '<p class="hint">No projects yet — create one below to get started.</p>';
      return;
    }
    for (const p of projects) {
      const tile = document.createElement('div');
      tile.className = 'cartoon-project-tile';
      tile.innerHTML = `<div class="cartoon-project-name">${escapeHtml(p.name)}</div><div class="cartoon-project-meta">Updated ${new Date(p.updatedAt).toLocaleDateString()}</div>`;
      tile.addEventListener('click', () => openProject(p._id));
      grid.appendChild(tile);
    }
  } catch (err) {
    showCartoonError('Failed to load projects: ' + err.message);
  }
}

document.getElementById('cartoon-new-project-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('cartoon-new-project-name');
  try {
    const project = await cartoonFetch('/api/cartoon/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameInput.value.trim() || undefined }),
    });
    nameInput.value = '';
    await loadProjects();
    openProject(project._id);
  } catch (err) {
    showCartoonError('Failed to create project: ' + err.message);
  }
});

document.getElementById('cartoon-back-btn').addEventListener('click', () => {
  currentProject = null;
  document.getElementById('cartoon-workspace-card').classList.add('hidden');
  document.getElementById('cartoon-projects-card').classList.remove('hidden');
  loadProjects();
});

async function openProject(id) {
  try {
    currentProject = await cartoonFetch(`/api/cartoon/projects/${id}`);
    document.getElementById('cartoon-projects-card').classList.add('hidden');
    document.getElementById('cartoon-workspace-card').classList.remove('hidden');
    document.getElementById('cartoon-project-title').textContent = currentProject.name;
    renderWorkspace();
  } catch (err) {
    showCartoonError('Failed to open project: ' + err.message);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderWorkspace() {
  renderCharacterLibrary();
  renderLocationLibrary();
  renderStoryBible();
  renderEpisodes();
  renderSettings();
}

// --- Workspace tab switching ---
document.querySelectorAll('.cartoon-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.cartoon-tab').forEach((t) => t.classList.toggle('active', t === tab));
    const target = tab.dataset.cartoonTab;
    document.querySelectorAll('.cartoon-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.cartoonPanel !== target));
  });
});

// --- Create Story / Rhyme panel ---
let createMode = 'story';
const IDEA_PLACEHOLDERS = {
  story: 'e.g. A puppy gets lost on his first day at school.',
  nursery: 'e.g. Make a fun nursery rhyme about a dinosaur learning to share.',
  userstory: "Paste your own storyline here. The AI will preserve your plot, characters, and ending, and turn it into a scene-by-scene animated script.",
};
document.querySelectorAll('.cartoon-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cartoon-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
    createMode = btn.dataset.mode;
    document.getElementById('cartoon-idea-input').placeholder = IDEA_PLACEHOLDERS[createMode];
    document.getElementById('cartoon-idea-label').textContent = createMode === 'userstory' ? 'Your storyline' : 'Story idea';
    document.getElementById('cartoon-length-row').classList.toggle('hidden', createMode !== 'nursery');
  });
});

document.getElementById('cartoon-length').addEventListener('change', (e) => {
  document.getElementById('cartoon-length-custom-wrap').classList.toggle('hidden', e.target.value !== 'custom');
});

document.getElementById('cartoon-generate-btn').addEventListener('click', async () => {
  if (!currentProject) return;
  const idea = document.getElementById('cartoon-idea-input').value.trim();
  if (!idea) return showCartoonError('Enter an idea or storyline first.');
  const btn = document.getElementById('cartoon-generate-btn');
  const spinner = document.getElementById('cartoon-generating');
  btn.disabled = true;
  spinner.classList.remove('hidden');
  try {
    let result;
    if (createMode === 'nursery') {
      let length = document.getElementById('cartoon-length').value;
      if (length === 'custom') length = document.getElementById('cartoon-length-custom').value;
      result = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/nursery-rhyme`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea, length }),
      });
    } else if (createMode === 'userstory') {
      result = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/story`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userStoryText: idea }),
      });
    } else {
      result = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/story`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea }),
      });
    }
    currentProject = result.project;
    document.getElementById('cartoon-idea-input').value = '';
    renderWorkspace();
    document.querySelector('.cartoon-tab[data-cartoon-tab="episodes"]').click();
  } catch (err) {
    showCartoonError('Generation failed: ' + err.message);
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
});

// --- Character Library ---
function characterCard(c) {
  const div = document.createElement('div');
  div.className = 'cartoon-entity-card';
  div.innerHTML = `
    <div class="cartoon-entity-image">${c.referenceImageUrl ? `<img src="${c.referenceImageUrl}" alt="${escapeHtml(c.name)}" />` : '<div class="cartoon-entity-noimage">No image yet</div>'}</div>
    <input class="cartoon-entity-name" value="${escapeHtml(c.name)}" />
    <div class="cartoon-entity-meta">${escapeHtml(c.species || '')} ${escapeHtml(c.ageCategory || '')}</div>
    <label class="cartoon-lock-row"><input type="checkbox" class="cartoon-lock-toggle" ${c.locked ? 'checked' : ''} /> Lock Character</label>
    <div class="cartoon-entity-actions">
      <button class="cartoon-small-btn cartoon-edit-toggle">Edit Image</button>
      <button class="cartoon-small-btn cartoon-delete-btn">Delete</button>
    </div>
    <div class="cartoon-edit-panel hidden">
      <input type="text" class="cartoon-edit-instruction" placeholder="e.g. give him a red scarf (redesign) or make him wave (new pose)" />
      <div class="cartoon-edit-row">
        <select class="cartoon-edit-mode">
          <option value="newPose">New pose/expression (design unchanged)</option>
          <option value="redesign">Redesign (change appearance)</option>
        </select>
        <button class="cartoon-small-btn cartoon-regen-btn">Generate</button>
      </div>
      <div class="cartoon-edit-row">
        <input type="file" accept="image/*" class="cartoon-upload-input" />
      </div>
    </div>
  `;

  div.querySelector('.cartoon-entity-name').addEventListener('change', async (e) => {
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/characters/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: e.target.value }),
      });
      currentProject = res.project;
    } catch (err) { showCartoonError(err.message); }
  });
  div.querySelector('.cartoon-lock-toggle').addEventListener('change', async (e) => {
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/characters/${c.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: e.target.checked }),
      });
      currentProject = res.project;
    } catch (err) { showCartoonError(err.message); }
  });
  div.querySelector('.cartoon-delete-btn').addEventListener('click', async () => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/characters/${c.id}`, { method: 'DELETE' });
      currentProject = res.project;
      renderCharacterLibrary();
    } catch (err) { showCartoonError(err.message); }
  });
  div.querySelector('.cartoon-edit-toggle').addEventListener('click', () => div.querySelector('.cartoon-edit-panel').classList.toggle('hidden'));
  div.querySelector('.cartoon-regen-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Working...';
    try {
      const mode = div.querySelector('.cartoon-edit-mode').value;
      const instruction = div.querySelector('.cartoon-edit-instruction').value.trim();
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/characters/${c.id}/image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, instruction, force: c.locked }),
      });
      currentProject = res.project;
      renderCharacterLibrary();
    } catch (err) { showCartoonError(err.message); } finally { btn.disabled = false; btn.textContent = 'Generate'; }
  });
  div.querySelector('.cartoon-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/cartoon/projects/${currentProject._id}/characters/${c.id}/image`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      currentProject = data.project;
      renderCharacterLibrary();
    } catch (err) { showCartoonError(err.message); }
  });

  return div;
}

function renderCharacterLibrary() {
  const grid = document.getElementById('cartoon-characters-grid');
  grid.innerHTML = '';
  if (!currentProject.characters.length) {
    grid.innerHTML = '<p class="hint">No characters yet — generate a story or create one manually above.</p>';
    return;
  }
  currentProject.characters.forEach((c) => grid.appendChild(characterCard(c)));
}

document.getElementById('cartoon-new-character-btn').addEventListener('click', async () => {
  const input = document.getElementById('cartoon-new-character-instruction');
  const btn = document.getElementById('cartoon-new-character-btn');
  btn.disabled = true;
  try {
    const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/characters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: input.value.trim() }),
    });
    currentProject = res.project;
    input.value = '';
    renderCharacterLibrary();
  } catch (err) { showCartoonError(err.message); } finally { btn.disabled = false; }
});

// --- Location Library (same pattern as characters) ---
function locationCard(l) {
  const div = document.createElement('div');
  div.className = 'cartoon-entity-card';
  div.innerHTML = `
    <div class="cartoon-entity-image">${l.referenceImageUrl ? `<img src="${l.referenceImageUrl}" alt="${escapeHtml(l.name)}" />` : '<div class="cartoon-entity-noimage">No image yet</div>'}</div>
    <input class="cartoon-entity-name" value="${escapeHtml(l.name)}" />
    <div class="cartoon-entity-meta">${escapeHtml((l.description || '').slice(0, 80))}</div>
    <label class="cartoon-lock-row"><input type="checkbox" class="cartoon-lock-toggle" ${l.locked ? 'checked' : ''} /> Lock Location</label>
    <div class="cartoon-entity-actions">
      <button class="cartoon-small-btn cartoon-edit-toggle">Edit Image</button>
      <button class="cartoon-small-btn cartoon-delete-btn">Delete</button>
    </div>
    <div class="cartoon-edit-panel hidden">
      <input type="text" class="cartoon-edit-instruction" placeholder="e.g. make it sunset (new angle) or add a treehouse (redesign)" />
      <div class="cartoon-edit-row">
        <select class="cartoon-edit-mode">
          <option value="newAngle">New angle/moment (design unchanged)</option>
          <option value="redesign">Redesign (change the location)</option>
        </select>
        <button class="cartoon-small-btn cartoon-regen-btn">Generate</button>
      </div>
      <div class="cartoon-edit-row">
        <input type="file" accept="image/*" class="cartoon-upload-input" />
      </div>
    </div>
  `;

  div.querySelector('.cartoon-entity-name').addEventListener('change', async (e) => {
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/locations/${l.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: e.target.value }),
      });
      currentProject = res.project;
    } catch (err) { showCartoonError(err.message); }
  });
  div.querySelector('.cartoon-lock-toggle').addEventListener('change', async (e) => {
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/locations/${l.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: e.target.checked }),
      });
      currentProject = res.project;
    } catch (err) { showCartoonError(err.message); }
  });
  div.querySelector('.cartoon-delete-btn').addEventListener('click', async () => {
    if (!confirm(`Delete ${l.name}?`)) return;
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/locations/${l.id}`, { method: 'DELETE' });
      currentProject = res.project;
      renderLocationLibrary();
    } catch (err) { showCartoonError(err.message); }
  });
  div.querySelector('.cartoon-edit-toggle').addEventListener('click', () => div.querySelector('.cartoon-edit-panel').classList.toggle('hidden'));
  div.querySelector('.cartoon-regen-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Working...';
    try {
      const mode = div.querySelector('.cartoon-edit-mode').value;
      const instruction = div.querySelector('.cartoon-edit-instruction').value.trim();
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/locations/${l.id}/image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, instruction, force: l.locked }),
      });
      currentProject = res.project;
      renderLocationLibrary();
    } catch (err) { showCartoonError(err.message); } finally { btn.disabled = false; btn.textContent = 'Generate'; }
  });
  div.querySelector('.cartoon-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/cartoon/projects/${currentProject._id}/locations/${l.id}/image`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      currentProject = data.project;
      renderLocationLibrary();
    } catch (err) { showCartoonError(err.message); }
  });

  return div;
}

function renderLocationLibrary() {
  const grid = document.getElementById('cartoon-locations-grid');
  grid.innerHTML = '';
  if (!currentProject.locations.length) {
    grid.innerHTML = '<p class="hint">No locations yet — generate a story or create one manually above.</p>';
    return;
  }
  currentProject.locations.forEach((l) => grid.appendChild(locationCard(l)));
}

document.getElementById('cartoon-new-location-btn').addEventListener('click', async () => {
  const input = document.getElementById('cartoon-new-location-instruction');
  const btn = document.getElementById('cartoon-new-location-btn');
  btn.disabled = true;
  try {
    const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/locations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: input.value.trim() }),
    });
    currentProject = res.project;
    input.value = '';
    renderLocationLibrary();
  } catch (err) { showCartoonError(err.message); } finally { btn.disabled = false; }
});

// --- Story Bible ---
function renderStoryBible() {
  const el = document.getElementById('cartoon-bible-view');
  const b = currentProject.storyBible;
  el.innerHTML = `
    <h3>World Rules</h3>
    <p class="hint">${b.worldRules.length ? b.worldRules.map(escapeHtml).join('<br/>') : 'None set yet.'}</p>
    <h3>Continuity (what has happened so far)</h3>
    <p class="hint">${b.continuityNotes.length ? b.continuityNotes.map(escapeHtml).join('<br/>') : 'Nothing yet — generate your first episode.'}</p>
    <h3>Characters (${currentProject.characters.length})</h3>
    <p class="hint">${currentProject.characters.map((c) => escapeHtml(c.name)).join(', ') || 'None yet.'}</p>
    <h3>Locations (${currentProject.locations.length})</h3>
    <p class="hint">${currentProject.locations.map((l) => escapeHtml(l.name)).join(', ') || 'None yet.'}</p>
  `;
}

// --- Episodes / scene timeline ---
function sceneCard(episode, scene, index) {
  const location = currentProject.locations.find((l) => l.id === scene.locationId);
  const sceneCharacters = scene.characterIds.map((id) => currentProject.characters.find((c) => c.id === id)).filter(Boolean);
  const charNames = sceneCharacters.map((c) => c.name);
  const div = document.createElement('div');
  div.className = 'cartoon-scene-card';

  const visualHtml = `
    <div class="cartoon-scene-visual"${location?.referenceImageUrl ? ` style="background-image:url('${location.referenceImageUrl}')"` : ''}>
      ${!location?.referenceImageUrl ? '<div class="cartoon-scene-visual-empty">No location image yet</div>' : ''}
      <div class="cartoon-scene-avatars">
        ${sceneCharacters.map((c) => `
          <div class="cartoon-scene-avatar" title="${escapeHtml(c.name)}">
            ${c.referenceImageUrl ? `<img src="${c.referenceImageUrl}" alt="${escapeHtml(c.name)}" />` : `<span>${escapeHtml(c.name[0] || '?')}</span>`}
          </div>
        `).join('')}
      </div>
    </div>`;

  div.innerHTML = `
    ${visualHtml}
    <div class="cartoon-scene-header">
      <strong>Scene ${index + 1}</strong>
      <span class="cartoon-scene-meta">${escapeHtml(location?.name || 'Unknown location')} &middot; ${escapeHtml(charNames.join(', ') || 'no characters')} &middot; ~${scene.approxDurationSec || '?'}s</span>
    </div>
    <div class="cartoon-scene-body">
      <p><em>${escapeHtml(scene.action)}</em></p>
      <p class="hint">Camera: ${escapeHtml(scene.cameraDirection)} &middot; Expressions: ${escapeHtml(scene.expressions)}</p>
      ${scene.dialogue.map((d) => `<p>&ldquo;${escapeHtml(d.line)}&rdquo; &mdash; ${escapeHtml(currentProject.characters.find((c) => c.id === d.characterId)?.name || '?')}</p>`).join('')}
      ${scene.narration ? `<p class="hint">Narration: ${escapeHtml(scene.narration)}</p>` : ''}
      ${scene.soundEffects ? `<p class="hint">SFX: ${escapeHtml(scene.soundEffects)}</p>` : ''}
      ${scene.musicInstructions ? `<p class="hint">Music: ${escapeHtml(scene.musicInstructions)}</p>` : ''}
    </div>
    <div class="cartoon-scene-video-panel">
      ${scene.videoUrl ? `<video class="cartoon-scene-video" src="${scene.videoUrl}" controls playsinline></video>` : ''}
      <div class="cartoon-scene-video-controls">
        ${tierSelectHtml('cartoon-scene-video-tier')}
        <button class="cartoon-small-btn cartoon-scene-video-btn">${scene.videoUrl ? 'Regenerate clip' : 'Generate clip'}</button>
      </div>
      <div class="cartoon-scene-video-status hint"></div>
      ${scene.videoCostUsd ? `<p class="hint">Clip cost: ${formatUsd(scene.videoCostUsd)}</p>` : ''}
    </div>
    <div class="cartoon-scene-actions">
      <button class="cartoon-small-btn cartoon-scene-up">&uarr;</button>
      <button class="cartoon-small-btn cartoon-scene-down">&darr;</button>
      <input type="text" class="cartoon-scene-instruction" placeholder="Regenerate instruction (optional), e.g. close-up on ${escapeHtml(charNames[0] || 'the character')} crying" />
      <button class="cartoon-small-btn cartoon-scene-regen">Regenerate</button>
    </div>
  `;

  div.querySelector('.cartoon-scene-regen').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Working...';
    try {
      const instruction = div.querySelector('.cartoon-scene-instruction').value.trim();
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/episodes/${episode.id}/scenes/${scene.id}/regenerate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }),
      });
      currentProject = res.project;
      renderEpisodes();
    } catch (err) { showCartoonError(err.message); } finally { btn.disabled = false; btn.textContent = 'Regenerate'; }
  });

  const move = async (dir) => {
    const ids = episode.scenes.map((s) => s.id);
    const i = ids.indexOf(scene.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/episodes/${episode.id}/scenes/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sceneIds: ids }),
      });
      currentProject = res.project;
      renderEpisodes();
    } catch (err) { showCartoonError(err.message); }
  };
  div.querySelector('.cartoon-scene-up').addEventListener('click', () => move(-1));
  div.querySelector('.cartoon-scene-down').addEventListener('click', () => move(1));

  const videoBtn = div.querySelector('.cartoon-scene-video-btn');
  const videoStatusEl = div.querySelector('.cartoon-scene-video-status');
  checkVideoAvailable().then((available) => {
    if (!available) {
      videoBtn.disabled = true;
      videoStatusEl.textContent = 'Video generation not configured on this server.';
    }
  });
  videoBtn.addEventListener('click', async () => {
    const tier = div.querySelector('.cartoon-scene-video-tier').value;
    const cost = (VEO_PRICE_PER_SEC[tier] * SCENE_CLIP_DURATION_SEC).toFixed(2);
    if (!confirm(`Generate a ~${SCENE_CLIP_DURATION_SEC}s clip for this scene on the ${tier} tier for approximately $${cost}. Continue?`)) return;
    videoBtn.disabled = true;
    videoStatusEl.textContent = 'Starting...';
    try {
      const { jobId } = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/episodes/${episode.id}/scenes/${scene.id}/video`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }),
      });
      pollCartoonVideoJob(jobId, (job) => {
        if (job.status === 'error') {
          videoStatusEl.textContent = `Failed: ${job.error}`;
          videoBtn.disabled = false;
          return;
        }
        if (job.status === 'done') {
          videoStatusEl.textContent = `Done — clip cost ${formatUsd(job.sceneCostUsd)}. Project total spend: ${formatUsd(job.totalSpendUsd)}.`;
          refreshCurrentProject();
        } else {
          videoStatusEl.textContent = 'Generating clip...';
        }
      });
    } catch (err) {
      videoStatusEl.textContent = '';
      showCartoonError('Failed to start scene video: ' + err.message);
      videoBtn.disabled = false;
    }
  });

  return div;
}

function episodeCard(episode) {
  const div = document.createElement('div');
  div.className = 'cartoon-episode-card';
  const lyricsHtml = episode.lyrics
    ? `<div class="cartoon-lyrics"><strong>Chorus:</strong> ${escapeHtml(episode.lyrics.chorus)}<br/>${episode.lyrics.verses.map((v, i) => `<strong>Verse ${i + 1}:</strong> ${escapeHtml(v)}`).join('<br/>')}</div>`
    : '';
  const staleNotice = episode.videoUrl && episode.videoStatus === 'stale'
    ? '<p class="hint cartoon-video-stale">A scene was regenerated since this episode video was made — click Generate Video again to update it.</p>' : '';

  div.innerHTML = `
    <div class="cartoon-episode-header">
      <h3>${escapeHtml(episode.title)} <span class="badge">${episode.kind === 'nurseryRhyme' ? 'Nursery Rhyme' : 'Episode'}</span></h3>
      <button class="cartoon-small-btn cartoon-delete-episode-btn">Delete Episode</button>
    </div>
    <p class="hint">${escapeHtml(episode.summary)}</p>
    ${lyricsHtml}
    <div class="cartoon-episode-video-panel">
      ${episode.videoUrl ? `<video class="cartoon-episode-video" src="${episode.videoUrl}" controls playsinline></video>` : ''}
      <div class="cartoon-episode-video-controls">
        ${tierSelectHtml('cartoon-episode-video-tier')}
        <button class="cartoon-small-btn cartoon-generate-video-btn">${episode.videoUrl ? 'Regenerate Episode Video' : 'Generate Video'}</button>
      </div>
      <div class="cartoon-episode-video-status hint"></div>
      ${staleNotice}
      ${episode.videoCostUsd ? `<p class="hint">This episode's video has cost ${formatUsd(episode.videoCostUsd)} so far.</p>` : ''}
    </div>
    <div class="cartoon-scenes-list"></div>
  `;
  const list = div.querySelector('.cartoon-scenes-list');
  episode.scenes.forEach((scene, i) => list.appendChild(sceneCard(episode, scene, i)));

  div.querySelector('.cartoon-delete-episode-btn').addEventListener('click', async () => {
    if (!confirm(`Delete episode "${episode.title}"?`)) return;
    try {
      const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/episodes/${episode.id}`, { method: 'DELETE' });
      currentProject = res.project;
      renderEpisodes();
    } catch (err) { showCartoonError(err.message); }
  });

  const genVideoBtn = div.querySelector('.cartoon-generate-video-btn');
  const videoStatusEl = div.querySelector('.cartoon-episode-video-status');
  checkVideoAvailable().then((available) => {
    if (!available) {
      genVideoBtn.disabled = true;
      videoStatusEl.textContent = 'Video generation not configured on this server (needs a Veo-capable Google API key).';
    }
  });
  genVideoBtn.addEventListener('click', async () => {
    const tier = div.querySelector('.cartoon-episode-video-tier').value;
    let estimate;
    try {
      estimate = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/episodes/${episode.id}/video/estimate?tier=${tier}`);
    } catch (err) {
      showCartoonError('Could not estimate cost: ' + err.message);
      return;
    }
    const ok = confirm(
      `This will generate ~${estimate.totalDurationSec}s of video across ${episode.scenes.length} scene(s) on the ` +
      `${tier} tier for approximately ${formatUsd(estimate.estimatedCostUsd)}. Continue?`
    );
    if (!ok) return;

    genVideoBtn.disabled = true;
    videoStatusEl.textContent = 'Starting...';
    try {
      const { jobId } = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}/episodes/${episode.id}/video`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }),
      });
      pollCartoonVideoJob(jobId, (job) => {
        if (job.status === 'error') {
          videoStatusEl.textContent = `Failed: ${job.error}`;
          genVideoBtn.disabled = false;
          return;
        }
        const doneCount = (job.scenes || []).filter((s) => s.status === 'done').length;
        const total = (job.scenes || []).length;
        if (job.status === 'stitching') {
          videoStatusEl.textContent = 'Stitching final episode video...';
        } else if (job.status === 'done') {
          videoStatusEl.textContent = `Done! This episode cost ${formatUsd(job.episodeCostUsd)}. Project total spend: ${formatUsd(job.totalSpendUsd)}.`;
          refreshCurrentProject();
        } else {
          videoStatusEl.textContent = `Generating scene clips... ${doneCount}/${total} done`;
        }
      });
    } catch (err) {
      videoStatusEl.textContent = '';
      showCartoonError('Failed to start video generation: ' + err.message);
      genVideoBtn.disabled = false;
    }
  });

  return div;
}

function renderEpisodes() {
  const el = document.getElementById('cartoon-episodes-list');
  const spend = currentProject.videoSpend || { totalUsd: 0, log: [] };
  el.innerHTML = `
    <div class="cartoon-phase-banner">
      <strong>Script, visuals &amp; video.</strong> Each scene below is a full storyboard panel — location image,
      characters, dialogue, camera direction. Once a scene looks right, generate a real animated clip for it
      (Veo 3.1) and stitch the episode together to get a playable video. Video generation costs real money per
      run, so you'll always see a cost estimate and have to confirm before anything is generated.
    </div>
    <div class="cartoon-spend-tracker">Project video spend so far: <strong>${formatUsd(spend.totalUsd)}</strong></div>`;
  if (!currentProject.episodes.length) {
    el.innerHTML += '<p class="hint">No episodes yet — use "Create Story / Rhyme" to generate your first one.</p>';
    return;
  }
  [...currentProject.episodes].sort((a, b) => a.order - b.order).forEach((ep) => el.appendChild(episodeCard(ep)));
}

// --- Project Settings ---
async function loadStylePresets() {
  if (stylePresets.length) return stylePresets;
  const data = await cartoonFetch('/api/cartoon/styles');
  stylePresets = data.presets;
  return stylePresets;
}

async function renderSettings() {
  const presets = await loadStylePresets().catch(() => []);
  const select = document.getElementById('cartoon-style-preset');
  select.innerHTML = presets.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
  select.value = currentProject.style.preset;
  document.getElementById('cartoon-style-custom').value = currentProject.style.customPrompt || '';
  document.getElementById('cartoon-style-locked').checked = !!currentProject.style.locked;
}

document.getElementById('cartoon-save-settings-btn').addEventListener('click', async () => {
  try {
    const style = {
      preset: document.getElementById('cartoon-style-preset').value,
      customPrompt: document.getElementById('cartoon-style-custom').value,
      locked: document.getElementById('cartoon-style-locked').checked,
    };
    const res = await cartoonFetch(`/api/cartoon/projects/${currentProject._id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ style }),
    });
    currentProject = res.project;
  } catch (err) { showCartoonError(err.message); }
});

// Load the project list once the Cartoon Studio tab is first opened (not on page load, to
// avoid an unnecessary request for users who never touch this tab).
let cartoonLoaded = false;
document.querySelector('.app-tab[data-app-tab="cartoon"]').addEventListener('click', () => {
  if (!cartoonLoaded) {
    cartoonLoaded = true;
    loadProjects();
    loadStylePresets().catch(() => {});
  }
});
