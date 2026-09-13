// Local Ollama-backed LLM client for the AI caption generator (src/captionAi/*). Runs
// entirely against a local Ollama server (https://ollama.com) — no API key, no cloud
// dependency — unlike src/llm.js (OpenAI-backed), which every OTHER AI feature in this app
// (scene/vision analysis in semantic.js/pipeline.js) still uses. Kept separate on purpose so
// swapping this one feature's provider never touches those.
const { ChatOllama } = require('@langchain/ollama');

const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const REQUEST_TIMEOUT_MS = parseInt(process.env.CAPTION_AI_TIMEOUT_MS || '30000', 10);

let model = null;
function getModel() {
  if (model) return model;
  model = new ChatOllama({ model: MODEL, baseUrl: BASE_URL, temperature: 0.7 });
  return model;
}

function isAvailable() {
  return process.env.CAPTION_AI_DISABLE !== '1';
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('');
  }
  return '';
}

// Returns the raw text response, or null on ANY failure (server unreachable, timeout, empty
// response) — same "null means fall back, never throw" contract as src/llm.js's completeJSON.
async function complete({ system, user }) {
  if (!isAvailable()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const userText = typeof user === 'string' ? user : JSON.stringify(user);
    const resp = await getModel().invoke(
      [
        ['system', system],
        ['human', userText],
      ],
      { signal: controller.signal }
    );
    const text = contentToText(resp.content).trim();
    return text || null;
  } catch (err) {
    console.warn(`[captionAi/ollama] completion failed (model=${MODEL}, base=${BASE_URL}):`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isAvailable, complete, MODEL, BASE_URL };
