// The ONE place in the Cartoon Studio subsystem that talks to an AI provider. Everything
// else (story.js, characters.js, locations.js, video.js) calls through here, never
// `ai`/`@ai-sdk/*` directly — swapping models or providers later means editing this file
// only. Deliberately separate from src/llm.js (the unrelated video-clipper's own OpenAI-direct
// adapter), though the quota/cooldown circuit-breaker pattern below mirrors it.
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

// Real, current pricing (ai.google.dev, fetched live — not assumed) for the exact models this
// app uses on the direct-Google path. Only that path gets real cost tracking: the Gateway
// fallback isn't the configured/used path in practice, and its pricing isn't fetched here.
const TEXT_PRICE_PER_M_TOKENS = { input: 0.75, output: 3.75 }; // gemini-3.6-flash, through 2026-12-31
const IMAGE_PRICE_PER_IMAGE = 0.067; // gemini-3.1-flash-image at ~1024x1024 ("1K image" tier)

// Veo 3.1 — video generation only works on the direct Google path (billed key), not the
// Vercel Gateway path, so callers must check isVideoAvailable() before spending time
// building a prompt. Real, verified pricing (ai.google.dev, fetched live) — used for cost
// estimates and actual spend tracking, not just display copy.
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

// --- Quota/rate-limit circuit breaker ---
// Google gates Veo (and, less commonly, text/image) with hard per-day request quotas tied to
// your account's usage tier — completely separate from credit balance, and each Veo tier
// (lite/fast/standard) has its OWN separate daily pool. Once one kind hits it, every further
// call of that same kind is guaranteed to fail identically until the quota window resets, so
// retrying immediately just burns time (the SDK already retries 3x per call internally) and
// produces a raw, unhelpful SDK error. Cache "this kind just hit a quota wall" briefly and
// fail fast with a clear explanation instead — mirrors src/llm.js's noteFailure/cooldown
// pattern for the unrelated video-clipper subsystem.
const QUOTA_COOLDOWN_MS = parseInt(process.env.CARTOON_QUOTA_COOLDOWN_MS || '300000', 10); // 5 min
const quotaExceededUntil = {}; // kind -> timestamp

function isQuotaOrAuthError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode;
  if (status === 401 || status === 403 || status === 429) return true;
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('quota') || msg.includes('rate limit') || msg.includes('exceeded your current');
}

function friendlyQuotaError(err, kind) {
  return new Error(
    `Google API quota exceeded for ${kind} generation. This is usually a per-day request limit tied to ` +
    `your account's usage tier (each Veo tier has its own separate daily pool) — it is NOT about your ` +
    `credit balance. Check your current limits at https://ai.dev/rate-limit. (Original error: ${err.message})`
  );
}

function checkCooldown(kind) {
  const until = quotaExceededUntil[kind] || 0;
  if (Date.now() < until) {
    const secs = Math.ceil((until - Date.now()) / 1000);
    throw new Error(
      `${kind} generation hit a Google API quota limit moments ago and is assumed still exhausted for ` +
      `~${secs}s more (avoiding a guaranteed-to-fail retry) — check https://ai.dev/rate-limit before trying again.`
    );
  }
}

function noteResult(kind, err) {
  if (err && isQuotaOrAuthError(err)) {
    quotaExceededUntil[kind] = Date.now() + QUOTA_COOLDOWN_MS;
    console.warn(`[cartoon/ai] quota error for ${kind} — treating as exhausted for ${Math.round(QUOTA_COOLDOWN_MS / 1000)}s to avoid guaranteed-fail retries`);
  }
}

// Structured generation (characters, locations, stories, scenes) — schema is a zod schema
// from schemas.js. Throws on failure (unlike the video-clipper's llm.js, which swallows
// errors and returns null) because Cartoon Studio generation is a direct, user-initiated
// action with its own request/response cycle — the caller (an Express route) is expected to
// catch and turn this into a clean error response, not silently fall back to nothing.
// Returns { object, costUsd } — costUsd is computed from real token usage when available
// (direct-Google path only), else 0.
async function generateStructured({ system, prompt, schema, schemaName = 'result', temperature = 0.8 }) {
  if (!isAvailable()) throw unavailableError();
  checkCooldown('text');
  const model = hasGoogleDirect() ? google(GOOGLE_TEXT_MODEL) : GATEWAY_TEXT_MODEL;
  try {
    const result = await generateObject({ model, system, prompt, schema, schemaName, temperature });
    let costUsd = 0;
    if (hasGoogleDirect() && result.usage) {
      const inputTokens = result.usage.inputTokens || 0;
      const outputTokens = result.usage.outputTokens || 0;
      costUsd = (inputTokens / 1e6) * TEXT_PRICE_PER_M_TOKENS.input + (outputTokens / 1e6) * TEXT_PRICE_PER_M_TOKENS.output;
    }
    return { object: result.object, costUsd };
  } catch (err) {
    noteResult('text', err);
    throw isQuotaOrAuthError(err) ? friendlyQuotaError(err, 'text') : err;
  }
}

// Reference image generation — returns { buffer, contentType, costUsd } ready to hand to
// blob.js:uploadReferenceImage. `prompt` should already include the visual style + full
// character/location description (built by characters.js/locations.js).
async function generateReferenceImage({ prompt, size = '1024x1024', aspectRatio = '1:1' }) {
  if (!isAvailable()) throw unavailableError();
  checkCooldown('image');

  try {
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
      return { buffer: Buffer.from(imageFile.uint8Array), contentType: imageFile.mediaType || 'image/png', costUsd: IMAGE_PRICE_PER_IMAGE };
    }

    const result = await generateImage({ model: GATEWAY_IMAGE_MODEL, prompt, size, n: 1 });
    const file = result.image;
    return { buffer: Buffer.from(file.uint8Array), contentType: file.mediaType || 'image/png', costUsd: 0 };
  } catch (err) {
    noteResult('image', err);
    throw isQuotaOrAuthError(err) ? friendlyQuotaError(err, 'image') : err;
  }
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
// is carried in the text prompt instead. Returns { buffer, contentType, costUsd } ready for
// blob.js, mirroring generateReferenceImage's return shape. Each Veo tier has its own
// separate daily quota, so the cooldown circuit breaker is keyed per-tier, not globally.
async function generateSceneVideo({ prompt, tier = 'lite', durationSec = 6, aspectRatio = '9:16', referenceImage = null }) {
  if (!isVideoAvailable()) {
    throw new Error(
      'Video generation requires direct Google access (GOOGLE_GENERATIVE_AI_API_KEY) — the Vercel AI ' +
      'Gateway path does not have a video model configured in this app.'
    );
  }
  const kind = `video:${tier}`;
  checkCooldown(kind);
  const modelId = VEO_TIER_MODELS[tier] || VEO_TIER_MODELS.lite;
  const promptArg = referenceImage?.buffer ? { image: referenceImage.buffer, text: prompt } : prompt;

  try {
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
    const priceTable = VEO_PRICE_PER_SEC[tier] || VEO_PRICE_PER_SEC.lite;
    const costUsd = durationSec * priceTable['720p'];
    return { buffer: Buffer.from(file.uint8Array), contentType: file.mediaType || 'video/mp4', costUsd };
  } catch (err) {
    noteResult(kind, err);
    throw isQuotaOrAuthError(err) ? friendlyQuotaError(err, `video (${tier} tier)`) : err;
  }
}

module.exports = {
  isAvailable, generateStructured, generateReferenceImage, isVideoAvailable, generateSceneVideo,
  GOOGLE_TEXT_MODEL, GOOGLE_IMAGE_MODEL, GATEWAY_TEXT_MODEL, GATEWAY_IMAGE_MODEL,
  VEO_TIER_MODELS, VEO_PRICE_PER_SEC, TEXT_PRICE_PER_M_TOKENS, IMAGE_PRICE_PER_IMAGE,
};
