const { z } = require('zod');

// Shared shape for an AI-invented character (section 2's field list). Scenes reference
// characters/locations by NAME, not ID — the LLM doesn't track this project's internal ID
// scheme, and letting it invent IDs would be unreliable. story.js resolves names to
// existing-or-newly-created IDs after generation; that's application logic, not the model's job.
const characterGenSchema = z.object({
  name: z.string(),
  ageCategory: z.string(),
  species: z.string(),
  gender: z.string(),
  appearance: z.string(),
  clothing: z.string(),
  hairFur: z.string(),
  eyeColor: z.string(),
  bodyShape: z.string(),
  personality: z.string(),
  voiceDescription: z.string(),
  accent: z.string(),
  speakingStyle: z.string(),
  catchphrases: z.array(z.string()),
});

const locationGenSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const dialogueLineSchema = z.object({
  characterName: z.string(),
  line: z.string(),
});

// Open version (used for full story/nursery-rhyme generation, where the model may reference
// brand-new characters/locations that don't have IDs yet).
const sceneGenSchema = z.object({
  order: z.number(),
  locationName: z.string(),
  characterNames: z.array(z.string()),
  action: z.string(),
  cameraDirection: z.string(),
  expressions: z.string(),
  dialogue: z.array(dialogueLineSchema),
  narration: z.string(),
  soundEffects: z.string(),
  musicInstructions: z.string(),
  animationInstructions: z.string(),
  approxDurationSec: z.number(),
});

// Constrained version for single-scene regeneration — locationName/characterNames are
// restricted to an enum of the project's EXISTING names, so the model structurally cannot
// invent a different location/cast for a scene the user asked to keep those fixed. Falls
// back to the open string schema if there's nothing to constrain against (e.g. an empty
// project, which shouldn't normally happen here but keeps this factory safe either way).
function sceneRegenSchema(characterNames, locationNames) {
  return z.object({
    action: z.string(),
    cameraDirection: z.string(),
    expressions: z.string(),
    dialogue: z.array(z.object({
      characterName: characterNames.length ? z.enum(characterNames) : z.string(),
      line: z.string(),
    })),
    narration: z.string(),
    soundEffects: z.string(),
    musicInstructions: z.string(),
    animationInstructions: z.string(),
    approxDurationSec: z.number(),
  });
}

const storyGenSchema = z.object({
  title: z.string(),
  concept: z.string(),
  summary: z.string(),
  newCharacters: z.array(characterGenSchema),
  newLocations: z.array(locationGenSchema),
  beginning: z.string(),
  middle: z.string(),
  ending: z.string(),
  scenes: z.array(sceneGenSchema),
});

const nurseryRhymeGenSchema = z.object({
  title: z.string(),
  chorus: z.string(),
  verses: z.array(z.string()),
  targetLengthSec: z.number(),
  newCharacters: z.array(characterGenSchema),
  newLocations: z.array(locationGenSchema),
  scenes: z.array(sceneGenSchema),
});

module.exports = {
  characterGenSchema, locationGenSchema, sceneGenSchema, sceneRegenSchema,
  storyGenSchema, nurseryRhymeGenSchema,
};
