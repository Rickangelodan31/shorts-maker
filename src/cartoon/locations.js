const { newId } = require('./store');
const ai = require('./ai');
const blob = require('./blob');
const spend = require('./spend');
const { locationGenSchema } = require('./schemas');
const { styleDescription } = require('./style');

function findLocation(project, locId) {
  const location = project.locations.find((l) => l.id === locId);
  if (!location) throw new Error('Location not found');
  return location;
}

function describeLocation(l) {
  return `${l.name} — ${l.description}`;
}

function normalizeLocationFields(fields) {
  return { name: fields.name || 'Unnamed Location', description: fields.description || '' };
}

function addLocation(project, fields) {
  const now = new Date().toISOString();
  const location = { id: newId(), ...normalizeLocationFields(fields), referenceImageUrl: null, locked: false, createdAt: now, updatedAt: now };
  project.locations.push(location);
  return location;
}

async function generateLocation(project, instruction) {
  const existingNames = project.locations.map((l) => l.name).join(', ') || 'none yet';
  const system = `You invent an original location for a children's cartoon project. ` +
    `Visual style: ${styleDescription(project.style)}. ` +
    `Existing locations in this project (do not duplicate any of them): ${existingNames}. ` +
    `Create a wholesome, original location — never copy a real/existing show's backgrounds or proprietary designs.`;
  const { object: location, costUsd } = await ai.generateStructured({
    system,
    prompt: instruction || 'Create a fitting new location for this project.',
    schema: locationGenSchema,
    schemaName: 'location',
  });
  spend.record(project, { kind: 'text', context: `location-generate:${location.name}`, costUsd });
  return addLocation(project, location);
}

function addGeneratedLocation(project, generated) {
  return addLocation(project, generated);
}

function updateLocation(project, locId, patch) {
  const location = findLocation(project, locId);
  if (patch.locked === true || patch.locked === false) location.locked = patch.locked;
  if (typeof patch.name === 'string') location.name = patch.name;
  if (typeof patch.description === 'string') location.description = patch.description;
  location.updatedAt = new Date().toISOString();
  return location;
}

function removeLocation(project, locId) {
  const idx = project.locations.findIndex((l) => l.id === locId);
  if (idx === -1) throw new Error('Location not found');
  const [removed] = project.locations.splice(idx, 1);
  return removed;
}

// mode: 'newAngle' (same locked design, different view/lighting moment) or 'redesign'
// (updates the stored description; requires force:true if locked). 'upload' is handled by
// the caller before this is invoked.
async function generateLocationImage(project, locId, { mode = 'newAngle', instruction = '', force = false }) {
  const location = findLocation(project, locId);
  if (mode === 'redesign') {
    if (location.locked && !force) {
      throw new Error(`"${location.name}" is locked. Unlock it first, or pass force to confirm an intentional redesign.`);
    }
    if (instruction) {
      const system = `You are updating ONE existing children's cartoon location's description based on a specific ` +
        `requested change. Keep everything else identical — only change what the instruction asks for. ` +
        `Current description: ${describeLocation(location)}`;
      const { object: updated, costUsd: redesignCostUsd } = await ai.generateStructured({
        system,
        prompt: `Requested change: ${instruction}. Return the location's full updated name + description.`,
        schema: locationGenSchema,
        schemaName: 'location_redesign',
      });
      spend.record(project, { kind: 'text', context: `location-redesign:${location.name}`, costUsd: redesignCostUsd });
      updateLocation(project, locId, updated);
    }
  }

  const anglePrompt = mode === 'newAngle' && instruction ? ` Specific moment/angle/lighting for this image only (does not change the permanent design): ${instruction}.` : '';
  const prompt = `Location/background reference image, ${styleDescription(project.style)}. ${describeLocation(location)}${anglePrompt} ` +
    `Wide establishing shot suitable for reuse as a consistent background across scenes.`;

  const { buffer, contentType, costUsd } = await ai.generateReferenceImage({ prompt });
  spend.record(project, { kind: 'image', context: `location-image:${location.name}:${mode}`, costUsd });
  const url = await blob.uploadReferenceImage({ projectId: project._id, kind: 'locations', entityId: location.id, buffer, contentType });
  await blob.deleteReferenceImage(location.referenceImageUrl);
  location.referenceImageUrl = url;
  location.updatedAt = new Date().toISOString();
  return location;
}

async function setLocationImageFromUpload(project, locId, buffer, contentType) {
  const location = findLocation(project, locId);
  const url = await blob.uploadReferenceImage({ projectId: project._id, kind: 'locations', entityId: location.id, buffer, contentType });
  await blob.deleteReferenceImage(location.referenceImageUrl);
  location.referenceImageUrl = url;
  location.updatedAt = new Date().toISOString();
  return location;
}

module.exports = {
  findLocation, describeLocation, normalizeLocationFields, addLocation, generateLocation,
  addGeneratedLocation, updateLocation, removeLocation, generateLocationImage, setLocationImageFromUpload,
};
