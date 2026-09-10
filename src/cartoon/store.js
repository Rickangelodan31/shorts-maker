const crypto = require('crypto');
const { getCartoonProjectsCollection } = require('./db');
const { DEFAULT_PRESET } = require('./style');

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

async function createProject(ownerId, name) {
  const col = await getCartoonProjectsCollection();
  const now = new Date().toISOString();
  const project = {
    _id: newId(),
    ownerId,
    name: name || 'Untitled Project',
    createdAt: now,
    updatedAt: now,
    style: { preset: DEFAULT_PRESET, customPrompt: '', locked: false },
    storyBible: { worldRules: [], importantObjects: [], continuityNotes: [] },
    characters: [],
    locations: [],
    episodes: [],
    spend: { totalUsd: 0, log: [] },
  };
  await col.insertOne(project);
  return project;
}

// List view omits the (potentially large) nested arrays — the project picker only needs
// name/dates, not every character/scene.
async function listProjects(ownerId) {
  const col = await getCartoonProjectsCollection();
  return col.find({ ownerId }, { projection: { characters: 0, locations: 0, episodes: 0, storyBible: 0 } })
    .sort({ updatedAt: -1 })
    .toArray();
}

async function getProject(ownerId, projectId) {
  const col = await getCartoonProjectsCollection();
  const project = await col.findOne({ _id: projectId, ownerId });
  if (!project) throw new Error('Project not found');
  return project;
}

async function saveProject(project) {
  const col = await getCartoonProjectsCollection();
  project.updatedAt = new Date().toISOString();
  await col.replaceOne({ _id: project._id }, project);
  return project;
}

async function deleteProject(ownerId, projectId) {
  const col = await getCartoonProjectsCollection();
  const result = await col.deleteOne({ _id: projectId, ownerId });
  if (result.deletedCount === 0) throw new Error('Project not found');
}

// Loads a project (ownership-checked via getProject), lets `mutator` change it in place,
// saves the result — mirrors src/auth.js's simple load->mutate->save idiom, just backed by
// Mongo instead of a JSON file.
async function withProject(ownerId, projectId, mutator) {
  const project = await getProject(ownerId, projectId);
  try {
    const result = (await mutator(project)) || project;
    await saveProject(result);
    return result;
  } catch (err) {
    // The mutator may have already mutated `project` in place before failing (e.g. a video
    // generation job that set per-scene error details on some scenes before the batch as a
    // whole was deemed a failure) — best-effort persist that partial state instead of
    // silently discarding it, so the real failure reason survives for the caller to inspect
    // later, not just the in-memory job object. Then rethrow so callers still see the error.
    await saveProject(project).catch(() => {});
    throw err;
  }
}

module.exports = { newId, createProject, listProjects, getProject, saveProject, deleteProject, withProject };
