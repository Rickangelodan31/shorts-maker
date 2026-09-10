const { newId } = require('./store');
const ai = require('./ai');
const spend = require('./spend');
const characters = require('./characters');
const locations = require('./locations');
const { styleDescription } = require('./style');
const { storyGenSchema, nurseryRhymeGenSchema, sceneRegenSchema } = require('./schemas');

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

// The section-17 consistency mechanism: every generation call that can touch existing
// characters/locations gets this injected as system-prompt context, with locked entities
// marked as non-negotiable. This is what makes "reuse Max exactly as designed" work.
function buildBibleContext(project) {
  const charBlock = project.characters.length
    ? project.characters.map((c) => `- ${c.name}${c.locked ? ' [LOCKED — reuse exactly, do not alter]' : ' [not locked — prefer reuse, minor refinement allowed]'}: ${characters.describeCharacter(c)}`).join('\n')
    : '(no characters yet)';
  const locBlock = project.locations.length
    ? project.locations.map((l) => `- ${l.name}${l.locked ? ' [LOCKED — reuse exactly, do not alter]' : ' [not locked — prefer reuse, minor refinement allowed]'}: ${locations.describeLocation(l)}`).join('\n')
    : '(no locations yet)';
  const continuity = project.storyBible.continuityNotes.length
    ? project.storyBible.continuityNotes.slice(-10).join('\n')
    : '(no prior episodes yet)';
  const worldRules = project.storyBible.worldRules.length ? project.storyBible.worldRules.join('\n') : '(none set)';

  return `PROJECT: ${project.name}
VISUAL STYLE: ${styleDescription(project.style)}

EXISTING CHARACTERS (the Character Bible):
${charBlock}

EXISTING LOCATIONS (the Location Bible):
${locBlock}

WORLD RULES:
${worldRules}

STORY CONTINUITY SO FAR:
${continuity}

CRITICAL: reuse existing characters/locations by name whenever the story calls for them — do
NOT redesign or reinterpret a LOCKED entity's appearance, personality, or details. Only
invent a brand-new character/location if the story genuinely needs someone/something not
listed above. Never depict real/existing copyrighted characters, shows, or brands.`;
}

function findCharacterIdByName(project, name) {
  const found = project.characters.find((c) => c.name.toLowerCase() === (name || '').toLowerCase());
  return found ? found.id : null;
}
function findLocationIdByName(project, name) {
  const found = project.locations.find((l) => l.name.toLowerCase() === (name || '').toLowerCase());
  return found ? found.id : null;
}

// Registers any brand-new characters/locations the model introduced (skips ones that
// already exist under that name — the model was told to reuse, this is a safety net).
function resolveEntities(project, generated) {
  for (const nc of generated.newCharacters || []) {
    if (!findCharacterIdByName(project, nc.name)) characters.addGeneratedCharacter(project, nc);
  }
  for (const nl of generated.newLocations || []) {
    if (!findLocationIdByName(project, nl.name)) locations.addGeneratedLocation(project, nl);
  }
}

function resolveScene(project, sceneGen, order) {
  const dialogue = (sceneGen.dialogue || [])
    .map((d) => ({ characterId: findCharacterIdByName(project, d.characterName), line: d.line }))
    .filter((d) => d.characterId);
  return {
    id: newId(),
    order,
    locationId: findLocationIdByName(project, sceneGen.locationName),
    characterIds: (sceneGen.characterNames || []).map((n) => findCharacterIdByName(project, n)).filter(Boolean),
    action: sceneGen.action,
    cameraDirection: sceneGen.cameraDirection,
    expressions: sceneGen.expressions,
    dialogue,
    narration: sceneGen.narration,
    soundEffects: sceneGen.soundEffects,
    musicInstructions: sceneGen.musicInstructions,
    animationInstructions: sceneGen.animationInstructions,
    approxDurationSec: sceneGen.approxDurationSec,
  };
}

// Reference images for anything newly introduced by this generation — bounded concurrency,
// each failure logged but non-fatal (the text/story result is still good even if one image
// generation call fails; the user can retry that specific character/location's image later).
async function generateImagesForNewEntities(project, generated) {
  const newCharNames = new Set((generated.newCharacters || []).map((c) => c.name.toLowerCase()));
  const newLocNames = new Set((generated.newLocations || []).map((l) => l.name.toLowerCase()));
  const charsToImage = project.characters.filter((c) => newCharNames.has(c.name.toLowerCase()) && !c.referenceImageUrl);
  const locsToImage = project.locations.filter((l) => newLocNames.has(l.name.toLowerCase()) && !l.referenceImageUrl);

  await mapLimit(charsToImage, 3, async (c) => {
    try { await characters.generateCharacterImage(project, c.id, { mode: 'newPose' }); }
    catch (err) { console.warn(`[cartoon] reference image failed for character "${c.name}":`, err.message); }
  });
  await mapLimit(locsToImage, 3, async (l) => {
    try { await locations.generateLocationImage(project, l.id, { mode: 'newAngle' }); }
    catch (err) { console.warn(`[cartoon] reference image failed for location "${l.name}":`, err.message); }
  });
}

// mode: 'ai' (idea -> full original story) or 'user' (paste a storyline -> preserve it,
// just structure it into scenes).
async function generateStory(project, { mode, idea, userStoryText }) {
  const bible = buildBibleContext(project);
  let system;
  let prompt;
  if (mode === 'user') {
    system = `${bible}\n\nYou are adapting the USER's own storyline into a structured animated episode script. ` +
      `Preserve their core story, characters, plot, and ending exactly — do not invent a different plot or change the ` +
      `ending. You may still flesh out scene-by-scene animation detail (camera direction, actions, dialogue, sound) as ` +
      `long as it stays faithful to what they wrote.`;
    prompt = `User's storyline:\n${userStoryText}\n\nTurn this into a full animated episode following the required structure.`;
  } else {
    system = `${bible}\n\nYou expand a simple idea into a complete original animated children's episode: concept, ` +
      `characters, locations, a beginning/middle/ending, and a full scene-by-scene breakdown with dialogue, narration, ` +
      `camera direction, and animation instructions.`;
    prompt = `Idea: ${idea}`;
  }

  const { object: generated, costUsd } = await ai.generateStructured({ system, prompt, schema: storyGenSchema, schemaName: 'story' });
  spend.record(project, { kind: 'text', context: `story-generate:${generated.title}`, costUsd });
  resolveEntities(project, generated);
  const scenes = generated.scenes.map((s, i) => resolveScene(project, s, i));

  const now = new Date().toISOString();
  const episode = {
    id: newId(), title: generated.title, order: project.episodes.length, kind: 'episode',
    targetLengthSec: null, summary: generated.summary, lyrics: null, scenes,
    createdAt: now, updatedAt: now,
  };
  project.episodes.push(episode);
  project.storyBible.continuityNotes.push(`Episode "${episode.title}": ${generated.summary}`);

  await generateImagesForNewEntities(project, generated);
  return episode;
}

const LENGTH_PRESETS = { '30s': 30, '1m': 60, '2m': 120, '3m': 180, '5m': 300 };

function resolveTargetLength(length) {
  if (!length || length === 'random') return null; // null = let the model choose
  if (LENGTH_PRESETS[length]) return LENGTH_PRESETS[length];
  const n = parseInt(length, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function generateNurseryRhyme(project, { idea, length }) {
  const bible = buildBibleContext(project);
  const targetSec = resolveTargetLength(length);
  const lengthInstruction = targetSec
    ? `Target length: approximately ${targetSec} seconds.`
    : `No fixed length was requested — choose whatever length best fits this idea (typically 30-180 seconds) and report it as targetLengthSec.`;
  const system = `${bible}\n\nYou write ORIGINAL nursery rhyme lyrics for a children's cartoon — never copy or closely ` +
    `paraphrase any existing/copyrighted nursery rhyme — with a repeating chorus, verses, and a full scene-by-scene ` +
    `breakdown showing what happens and who's on screen during each part. ${lengthInstruction}`;
  const prompt = `Nursery rhyme idea: ${idea}`;

  const { object: generated, costUsd } = await ai.generateStructured({ system, prompt, schema: nurseryRhymeGenSchema, schemaName: 'nursery_rhyme' });
  spend.record(project, { kind: 'text', context: `nursery-rhyme-generate:${generated.title}`, costUsd });
  resolveEntities(project, generated);
  const scenes = generated.scenes.map((s, i) => resolveScene(project, s, i));

  const now = new Date().toISOString();
  const episode = {
    id: newId(), title: generated.title, order: project.episodes.length, kind: 'nurseryRhyme',
    targetLengthSec: generated.targetLengthSec || targetSec,
    summary: `Nursery rhyme: ${generated.title}`,
    lyrics: { chorus: generated.chorus, verses: generated.verses },
    scenes, createdAt: now, updatedAt: now,
  };
  project.episodes.push(episode);
  project.storyBible.continuityNotes.push(`Nursery rhyme "${episode.title}" was created.`);

  await generateImagesForNewEntities(project, generated);
  return episode;
}

function findEpisode(project, episodeId) {
  const episode = project.episodes.find((e) => e.id === episodeId);
  if (!episode) throw new Error('Episode not found');
  return episode;
}
function findScene(episode, sceneId) {
  const scene = episode.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error('Scene not found');
  return scene;
}

// "Regenerate Scene 7 but keep the characters and location exactly the same" — the location/
// characters are passed as fixed context and the schema's enum is restricted to the
// project's EXISTING names, so the model can't silently swap them out; it only changes cast/
// location if the instruction explicitly asks for that (e.g. "put all three in the playground").
async function regenerateScene(project, episodeId, sceneId, instruction) {
  const episode = findEpisode(project, episodeId);
  const scene = findScene(episode, sceneId);
  const originalLocation = project.locations.find((l) => l.id === scene.locationId);
  const originalCharNames = scene.characterIds
    .map((id) => project.characters.find((c) => c.id === id)?.name)
    .filter(Boolean);

  const bible = buildBibleContext(project);
  const characterNames = project.characters.map((c) => c.name);
  const locationNames = project.locations.map((l) => l.name);
  const schema = sceneRegenSchema(characterNames, locationNames);

  const system = `${bible}\n\nYou are regenerating ONE scene of an existing episode ("${episode.title}"). This scene ` +
    `currently takes place at "${originalLocation?.name || 'unknown'}" with these characters: ` +
    `${originalCharNames.join(', ') || 'none'}. Keep the location and characters exactly as they are UNLESS the ` +
    `instruction below explicitly asks to change them.`;
  const prompt = instruction
    ? `Regenerate this scene. Instruction: ${instruction}`
    : 'Regenerate this scene with fresh creative details, keeping location, characters, and story continuity exactly the same.';

  const { object: generated, costUsd } = await ai.generateStructured({ system, prompt, schema, schemaName: 'scene_regen' });
  spend.record(project, { kind: 'text', context: `scene-regen:${episode.title}`, costUsd });
  const dialogue = (generated.dialogue || [])
    .map((d) => ({ characterId: findCharacterIdByName(project, d.characterName), line: d.line }))
    .filter((d) => d.characterId);

  Object.assign(scene, {
    action: generated.action, cameraDirection: generated.cameraDirection, expressions: generated.expressions,
    dialogue, narration: generated.narration, soundEffects: generated.soundEffects,
    musicInstructions: generated.musicInstructions, animationInstructions: generated.animationInstructions,
    approxDurationSec: generated.approxDurationSec,
  });
  episode.updatedAt = new Date().toISOString();
  return scene;
}

// Manual (non-AI) edits: dialogue text, duration, swapping a locked-in character/location,
// etc. — a pure patch, same "never regenerate on rename"-style guarantee as characters.js.
function updateSceneManual(project, episodeId, sceneId, patch) {
  const episode = findEpisode(project, episodeId);
  const scene = findScene(episode, sceneId);
  for (const key of ['action', 'cameraDirection', 'expressions', 'narration', 'soundEffects', 'musicInstructions', 'animationInstructions']) {
    if (typeof patch[key] === 'string') scene[key] = patch[key];
  }
  if (typeof patch.approxDurationSec === 'number') scene.approxDurationSec = patch.approxDurationSec;
  if (Array.isArray(patch.dialogue)) scene.dialogue = patch.dialogue;
  if (Array.isArray(patch.characterIds)) scene.characterIds = patch.characterIds;
  if (typeof patch.locationId === 'string') scene.locationId = patch.locationId;
  episode.updatedAt = new Date().toISOString();
  return scene;
}

function reorderScenes(project, episodeId, orderedSceneIds) {
  const episode = findEpisode(project, episodeId);
  const byId = new Map(episode.scenes.map((s) => [s.id, s]));
  const reordered = orderedSceneIds.map((id) => byId.get(id)).filter(Boolean);
  const missing = episode.scenes.filter((s) => !orderedSceneIds.includes(s.id));
  episode.scenes = [...reordered, ...missing].map((s, i) => ({ ...s, order: i }));
  episode.updatedAt = new Date().toISOString();
  return episode;
}

function removeEpisode(project, episodeId) {
  const idx = project.episodes.findIndex((e) => e.id === episodeId);
  if (idx === -1) throw new Error('Episode not found');
  project.episodes.splice(idx, 1);
}

module.exports = {
  buildBibleContext, generateStory, generateNurseryRhyme, regenerateScene,
  updateSceneManual, reorderScenes, findEpisode, findScene, removeEpisode,
};
