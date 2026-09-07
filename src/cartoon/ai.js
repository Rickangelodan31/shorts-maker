// The ONE place in the Cartoon Studio subsystem that talks to an AI provider. Everything
// else (story.js, characters.js, locations.js) calls through here, never `ai`/`@ai-sdk/*`
// directly — swapping models or providers later means editing this file only. Deliberately
// separate from src/llm.js (the unrelated video-clipper's own OpenAI-direct adapter).
//
// Two provider paths, tried in this order:
//  1. Direct Google (Gemini) via a free Google AI Studio key (GOOGLE_GENERATIVE_AI_API_KEY)
//     — genuinely free tier, no credit card required. Preferred default so this subsystem
//     works without spending anything.
//  2. Vercel AI Gateway (VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY) — unified multi-provider
//     routing, but Vercel currently requires a card on file even to use free credits.
// Whichever is configured is used transparently; callers never know which one ran.
const { generateObject, generateText, generateImage, experimental_generateVideo: generateVideo } = require('ai');
const { google } = require('@ai-sdk/google');

const GOOGLE_TEXT_MODEL = process.env.CARTOON_GOOGLE_TEXT_MODEL || 'gemini-3.6-flash';
// Gemini's own image-OUTPUT model (multimodal generateText, not a dedicated image API) —
// this is the free-tier-eligible path. Model availability changes; override via env if this
// slug 404s on your key.
const GOOGLE_IMAGE_MODEL = process.env.CARTOON_GOOGLE_IMAGE_MODEL || 'gemini-3.1-flash-image';

const GATEWAY_TEXT_MODEL = process.env.CARTOON_TEXT_MODEL || 'openai/gpt-5.4';
const GATEWAY_IMAGE_MODEL = process.env.CARTOON_IMAGE_MODEL || 'google/imagen-4.0-generate-001';

// Veo 3.1 — video generation only works on the direct Google path (billed key), not the
// Vercel Gateway path, so callers must check isVideoAvailable() before spending time
// building a prompt. Real, verified pricing (ai.google.dev, fetched live) — used by
// video.js for cost estimates and actual spend tracking, not just display copy.
const VEO_TIER_MODELS = {
  lite: 'veo-3.1-lite-generate-preview',
  fast: 'veo-3.1-fast-generate-preview',
  standard: 'veo-3.1-generate-preview',
};
const VEO_PRICE_PER_SEC = {
  lite: { '720p': 0.05, '1080p': 0.08 },
  fast: { '720p': 0.10, '1080p': 0.12 },
  standard: { '720p': 0.40, '1080p': 0.40 },
};

function hasGoogleDirect() {
  return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}
function hasGateway() {
  return !!(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY);
}

function isAvailable() {
  return hasGoogleDirect() || hasGateway();
}

function unavailableError() {
  return new Error(
    'No AI provider is configured yet. Easiest free option: get a free key (no credit card) at ' +
    'https://aistudio.google.com/apikey and set GOOGLE_GENERATIVE_AI_API_KEY in .env. ' +
    'Alternatively, enable Vercel AI Gateway for this project (Settings → AI Gateway) and run ' +
    '`vercel env pull .env.local --yes` — note Vercel currently requires a card on file even for free credits.'
  );
}

// Structured generation (characters, locations, stories, scenes) — schema is a zod schema
// from schemas.js. Throws on failure (unlike the video-clipper's llm.js, which swallows
// errors and returns null) because Cartoon Studio generation is a direct, user-initiated
// action with its own request/response cycle — the caller (an Express route) is expected to
// catch and turn this into a clean error response, not silently fall back to nothing.
async function generateStructured({ system, prompt, schema, schemaName = 'result', temperature = 0.8 }) {
  if (!isAvailable()) throw unavailableError();
  const model = hasGoogleDirect() ? google(GOOGLE_TEXT_MODEL) : GATEWAY_TEXT_MODEL;
  const { object } = await generateObject({ model, system, prompt, schema, schemaName, temperature });
  return object;
}

// Reference image generation — returns { buffer, contentType } ready to hand to
// blob.js:uploadReferenceImage. `prompt` should already include the visual style + full
// character/location description (built by characters.js/locations.js).
async function generateReferenceImage({ prompt, size = '1024x1024', aspectRatio = '1:1' }) {
  if (!isAvailable()) throw unavailableError();

  if (hasGoogleDirect()) {
    // Gemini's free-tier path: an image-output multimodal model via generateText, not the
    // dedicated generateImage()/ImageModel API (that's for Imagen, which needs Vertex/GCP
    // billing, not the free AI Studio key). Without an explicit aspectRatio the model
    // defaults to a wide landscape composition, which is a poor fit for a single-subject
    // reference image — square is a better default for character/location references.
    const result = await generateText({
      model: google(GOOGLE_IMAGE_MODEL),
      prompt,
      providerOptions: { google: { imageConfig: { aspectRatio } } },
    });
    const imageFile = (result.files || []).find((f) => f.mediaType?.startsWith('image/'));
    if (!imageFile) {
      throw new Error(
        `${GOOGLE_IMAGE_MODEL} did not return an image. If this model slug is wrong/unavailable on your ` +
        'key, set CARTOON_GOOGLE_IMAGE_MODEL to a current Gemini image-output model.'
      );
    }
    return { buffer: Buffer.from(imageFile.uint8Array), contentType: imageFile.mediaType || 'image/png' };
  }

  const result = await generateImage({ model: GATEWAY_IMAGE_MODEL, prompt, size, n: 1 });
  const file = result.image;
  return { buffer: Buffer.from(file.uint8Array), contentType: file.mediaType || 'image/png' };
}

// Video generation is Veo-only (direct Google path) — the gateway route has no video model
// wired up here, so this is a hard requirement, not a soft fallback.
function isVideoAvailable() {
  return hasGoogleDirect();
}

// Generates one short scene clip. `referenceImage` (an already-fetched {buffer, contentType})
// anchors the clip's visual look via the `prompt:{image,text}` image-to-video shape.
// NOTE: Veo's multi-image `inputReferences`/`referenceImages` mechanism was tried first (to
// combine a location image AND a character image in one call) but the live API rejects it on
// these preview model slugs ("`referenceImages` isn't supported by this model") — confirmed
// against the real endpoint, not assumed. Falling back to a single reference image is the
// verified-working path; the rest of the scene's visual context (location, other characters)
// is carried in the text prompt instead. Returns {buffer, contentType} ready for blob.js,
// mirroring generateReferenceImage's return shape.
async function generateSceneVideo({ prompt, tier = 'lite', durationSec = 25, aspectRatio = '9:16', referenceImage = null }) {
  if (!isVideoAvailable()) {
    throw new Error(
      'Video generation requires direct Google access (GOOGLE_GENERATIVE_AI_API_KEY) — the Vercel AI ' +
      'Gateway path does not have a video model configured in this app.'
    );
  }
  const modelId = VEO_TIER_MODELS[tier] || VEO_TIER_MODELS.lite;
  const promptArg = referenceImage?.buffer ? { image: referenceImage.buffer, text: prompt } : prompt;

  const result = await generateVideo({
    model: google.video(modelId),
    prompt: promptArg,
    duration: durationSec,
    aspectRatio,
    generateAudio: true,
    // Veo runs as an async predictLongRunning operation under the hood; the SDK's poll
    // option hides that behind a normal await. 10 min covers the slowest (Standard) tier
    // with margin — verified real Lite-tier generations complete in well under a minute.
    poll: { intervalMs: 5000, timeoutMs: 600000 },
  });
  const file = result.video;
  if (!file) {
    throw new Error(`${modelId} did not return a video. If this model slug is wrong/unavailable on your key, edit VEO_TIER_MODELS in ai.js.`);
  }
  return { buffer: Buffer.from(file.uint8Array), contentType: file.mediaType || 'video/mp4' };
}

module.exports = {
  isAvailable, generateStructured, generateReferenceImage, isVideoAvailable, generateSceneVideo,
  GOOGLE_TEXT_MODEL, GOOGLE_IMAGE_MODEL, GATEWAY_TEXT_MODEL, GATEWAY_IMAGE_MODEL,
  VEO_TIER_MODELS, VEO_PRICE_PER_SEC,
};
