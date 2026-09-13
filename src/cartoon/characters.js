const { newId } = require('./store');
const ai = require('./ai');
const blob = require('./blob');
const { characterGenSchema } = require('./schemas');
const { styleDescription } = require('./style');

const VISUAL_FIELDS = ['appearance', 'clothing', 'hairFur', 'eyeColor', 'bodyShape'];

function findCharacter(project, charId) {
  const character = project.characters.find((c) => c.id === charId);
  if (!character) throw new Error('Character not found');
  return character;
}

// A character's full text description, used both as the image-generation prompt and as the
// "reuse this exactly" block injected into story/scene prompts elsewhere.
function describeCharacter(c) {
  return [
    `${c.name} — ${c.ageCategory} ${c.species}${c.gender ? `, ${c.gender}` : ''}.`,
    `Appearance: ${c.appearance}.`,
    `Clothing: ${c.clothing}.`,
    `Hair/fur: ${c.hairFur}.`,
    `Eye color: ${c.eyeColor}.`,
    `Body shape: ${c.bodyShape}.`,
    `Personality: ${c.personality}.`,
    c.catchphrases?.length ? `Catchphrases: ${c.catchphrases.join(' / ')}.` : '',
  ].filter(Boolean).join(' ');
}

function normalizeCharacterFields(fields) {
  return {
    name: fields.name || 'Unnamed Character',
    ageCategory: fields.ageCategory || '',
    species: fields.species || '',
    gender: fields.gender || '',
    appearance: fields.appearance || '',
    clothing: fields.clothing || '',
    hairFur: fields.hairFur || '',
    eyeColor: fields.eyeColor || '',
    bodyShape: fields.bodyShape || '',
    personality: fields.personality || '',
    voiceDescription: fields.voiceDescription || '',
    accent: fields.accent || '',
    speakingStyle: fields.speakingStyle || '',
    catchphrases: Array.isArray(fields.catchphrases) ? fields.catchphrases : [],
  };claud
}

// Manual creation (user types the fields themselves) — no AI call at all.
function addCharacter(project, fields) {
  const now = new Date().toISOString();
  const character = { id: newId(), ...normalizeCharacterFields(fields), referenceImageUrl: null, locked: false, createdAt: now, updatedAt: now };
  project.characters.push(character);
  return character;
}

// "Ask AI to create a character" — a standalone character, not part of a full story. Informed
// by the project's existing characters (so it doesn't duplicate an existing name/concept) and
// locked style, but this is a lighter-weight call than full story generation.
async function generateCharacter(project, instruction) {
  const existingNames = project.characters.map((c) => c.name).join(', ') || 'none yet';
  const system = `You invent an original animated character for a children's cartoon project. ` +
    `Visual style: ${styleDescription(project.style)}. ` +
    `Existing characters in this project (do not duplicate or closely imitate any of them): ${existingNames}. ` +
    `Create a wholesome, original character — never copy a real/existing show's characters, names, or designs.`;
  const character = await ai.generateStructured({
    system,
    prompt: instruction || 'Create a fun, original supporting character for this project.',
    schema: characterGenSchema,
    schemaName: 'character',
  });
  return addCharacter(project, character);
}

// Adds a character from an already-generated AI object (used by story.js when a full story
// generation introduces a brand-new character inline) — same normalization/ID assignment,
// just skipping a redundant generateStructured call since the object already exists.
function addGeneratedCharacter(project, generated) {
  return addCharacter(project, generated);
}

// Rename/edit fields, lock/unlock — a PURE metadata patch, never an AI call. This is what
// guarantees "Leo the Bear" renamed to "Max" stays the exact same character rather than
// risking a redesign — there is structurally no generation step in this path.
function updateCharacter(project, charId, patch) {
  const character = findCharacter(project, charId);
  if (patch.locked === true || patch.locked === false) character.locked = patch.locked;
  for (const key of ['name', 'ageCategory', 'species', 'gender', 'appearance', 'clothing', 'hairFur', 'eyeColor', 'bodyShape', 'personality', 'voiceDescription', 'accent', 'speakingStyle']) {
    if (typeof patch[key] === 'string') character[key] = patch[key];
  }
  if (Array.isArray(patch.catchphrases)) character.catchphrases = patch.catchphrases;
  character.updatedAt = new Date().toISOString();
  return character;
}

function removeCharacter(project, charId) {
  const idx = project.characters.findIndex((c) => c.id === charId);
  if (idx === -1) throw new Error('Character not found');
  const [removed] = project.characters.splice(idx, 1);
  return removed;
}

// mode:
//  - 'newPose'  — same locked design, different pose/expression/angle (no field changes)
//  - 'redesign' — permanently changes clothing/hair/color/age/etc. (updates stored fields);
//                 requires force:true if the character is locked, representing an explicit,
//                 intentional override rather than an accidental drift
//  - 'upload'   — handled by the caller (server.js) before this is invoked; not an AI path
async function generateCharacterImage(project, charId, { mode = 'newPose', instruction = '', force = false }) {
  const character = findCharacter(project, charId);
  if (mode === 'redesign') {
    if (character.locked && !force) {
      throw new Error(`"${character.name}" is locked. Unlock it first, or pass force to confirm an intentional redesign.`);
    }
    if (instruction) {
      const system = `You are updating ONE existing children's cartoon character's visual design based on a specific ` +
        `requested change. Keep everything else about them identical — only change what the instruction asks for. ` +
        `Current design: ${describeCharacter(character)}`;
      const updatedFields = await ai.generateStructured({
        system,
        prompt: `Requested change: ${instruction}. Return the character's full updated field set (name/personality/voice etc. stay the same unless the instruction says otherwise).`,
        schema: characterGenSchema,
        schemaName: 'character_redesign',
      });
      updateCharacter(project, charId, updatedFields);
    }
  }

  const posePrompt = mode === 'newPose' && instruction ? ` Specific pose/expression/shot for this image only (does not change their permanent design): ${instruction}.` : '';
  const prompt = `Character reference image, ${styleDescription(project.style)}. ${describeCharacter(character)}${posePrompt} ` +
    `Clean single-character reference image on a simple background, consistent with a warm children's animated show.`;

  const { buffer, contentType } = await ai.generateReferenceImage({ prompt });
  const url = await blob.uploadReferenceImage({ projectId: project._id, kind: 'characters', entityId: character.id, buffer, contentType });
  await blob.deleteReferenceImage(character.referenceImageUrl);
  character.referenceImageUrl = url;
  character.updatedAt = new Date().toISOString();
  return character;
}

async function setCharacterImageFromUpload(project, charId, buffer, contentType) {
  const character = findCharacter(project, charId);
  const url = await blob.uploadReferenceImage({ projectId: project._id, kind: 'characters', entityId: character.id, buffer, contentType });
  await blob.deleteReferenceImage(character.referenceImageUrl);
  character.referenceImageUrl = url;
  character.updatedAt = new Date().toISOString();
  return character;
}

module.exports = {
  findCharacter, describeCharacter, normalizeCharacterFields, addCharacter, generateCharacter,
  addGeneratedCharacter, updateCharacter, removeCharacter, generateCharacterImage, setCharacterImageFromUpload,
};
