const fs = require('fs');

// Thin, swappable LLM adapter — OpenAI-backed today. Every call site in this app talks to
// this module, never to the `openai` package directly, so swapping providers later is a
// small change here rather than a rewrite across semantic.js/pipeline.js.
const TEXT_MODEL = process.env.SEMANTIC_TEXT_MODEL || 'gpt-4o-mini';
const VISION_MODEL = process.env.SEMANTIC_VISION_MODEL || 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = parseInt(process.env.SEMANTIC_TIMEOUT_MS || '20000', 10);
const QUOTA_COOLDOWN_MS = parseInt(process.env.SEMANTIC_QUOTA_COOLDOWN_MS || '300000', 10); // 5 min

let client = null;
function getClient() {
  if (client) return client;
  const OpenAI = require('openai');
  client = new OpenAI({ timeout: REQUEST_TIMEOUT_MS });
  return client;
}

// A key can EXIST but still be unusable (out of credits, revoked, org disabled) — treating
// "has a key" as "the API works" was the exact bug that made a URL job download a full
// video section for every one of the vision-check budget's candidates, back-to-back,
// before finding out (again and again) that the account has no credits. Once a call fails
// with a clear quota/auth error, stop attempting ANY further calls for a cooldown window
// (checked fresh by every caller, mid-batch included) instead of paying that cost per
// candidate — a transient/unrelated error does NOT trip this, only a quota/auth failure.
let quotaExceededUntil = 0;

function isQuotaOrAuthError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 401 || status === 429) return true;
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('credit') || msg.includes('quota') || msg.includes('insufficient_quota');
}

function noteFailure(err) {
  if (isQuotaOrAuthError(err) && Date.now() >= quotaExceededUntil) {
    quotaExceededUntil = Date.now() + QUOTA_COOLDOWN_MS;
    console.warn(`[llm] quota/auth error — disabling further LLM calls for ${Math.round(QUOTA_COOLDOWN_MS / 1000)}s to avoid paying per-candidate download/analysis cost for calls that will keep failing`);
  }
}

function isAvailable() {
  return !!process.env.OPENAI_API_KEY && process.env.SEMANTIC_DISABLE !== '1' && Date.now() >= quotaExceededUntil;
}

// Returns the parsed object matching `schema`, or null on ANY failure (network, refusal,
// malformed JSON, disabled). Callers must treat null as "no semantic signal, fall back."
async function completeJSON({ system, user, schema, schemaName = 'result', model = TEXT_MODEL, maxTokens = 800, temperature = 0.2 }) {
  if (!isAvailable()) return null;
  try {
    const resp = await getClient().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
      ],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
      max_tokens: maxTokens,
      temperature,
    });
    const text = resp.choices?.[0]?.message?.content;
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.warn(`[llm] completeJSON(${schemaName}) failed:`, err.message);
    noteFailure(err);
    return null;
  }
}

// Same contract, but `images` is [{ path, label? }] of local JPEG files, embedded as
// low-detail base64 data URLs to bound token cost.
async function completeVisionJSON({ system, user, images, schema, schemaName = 'result', model = VISION_MODEL, maxTokens = 800, temperature = 0.2 }) {
  if (!isAvailable()) return null;
  try {
    const content = [{ type: 'text', text: typeof user === 'string' ? user : JSON.stringify(user) }];
    for (const img of images || []) {
      const b64 = fs.readFileSync(img.path).toString('base64');
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } });
    }
    const resp = await getClient().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
      max_tokens: maxTokens,
      temperature,
    });
    const text = resp.choices?.[0]?.message?.content;
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.warn(`[llm] completeVisionJSON(${schemaName}) failed:`, err.message);
    noteFailure(err);
    return null;
  }
}

module.exports = { isAvailable, completeJSON, completeVisionJSON, TEXT_MODEL, VISION_MODEL };
