const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TINY_MODEL = path.join(__dirname, '..', 'models', 'ggml-tiny.en.bin');
const BASE_MODEL = path.join(__dirname, '..', 'models', 'ggml-base.en.bin');
// tiny.en trades a little accuracy for a lot of speed; plenty for highlight/caption purposes.
const MODEL_PATH = fs.existsSync(TINY_MODEL) ? TINY_MODEL : BASE_MODEL;
const WHISPER_BIN = 'whisper-cli';
const THREADS = Math.max(2, Math.min(8, require('os').cpus().length));
let whisperAvailable = fs.existsSync(MODEL_PATH);

function runWhisper(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(WHISPER_BIN, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1500)))));
  });
}

// Runs local word-level transcription (whisper.cpp) on a wav file.
// Returns { words: [{start,end,text}], segments: [{start,end,text}] } or null if unavailable.
async function transcribeLocal(wavPath) {
  if (!whisperAvailable) return null;
  const outBase = path.join(os.tmpdir(), `whisper_${crypto.randomBytes(6).toString('hex')}`);
  try {
    await runWhisper([
      '-m', MODEL_PATH,
      '-f', wavPath,
      '-ml', '1', '-sow',
      '-oj', '-of', outBase,
      '-np', '-nt',
      '-t', String(THREADS),
    ]);
    const jsonPath = `${outBase}.json`;
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    fs.unlink(jsonPath, () => {});
    const words = (data.transcription || [])
      .map((t) => ({
        start: (t.offsets?.from || 0) / 1000,
        end: (t.offsets?.to || 0) / 1000,
        text: (t.text || '').trim(),
      }))
      .filter((w) => w.text);
    return { words, segments: words };
  } catch (err) {
    console.warn('Local transcription failed:', err.message);
    return null;
  }
}

// Optional cloud fallback if OPENAI_API_KEY is set and local whisper isn't available/failed.
async function transcribeOpenAI(wavPath) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const OpenAI = require('openai');
    const client = new OpenAI();
    const resp = await client.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    const segments = (resp.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text }));
    return { words: segments, segments };
  } catch (err) {
    console.warn('OpenAI transcription skipped:', err.message);
    return null;
  }
}

async function transcribeIfAvailable(wavPath) {
  const local = await transcribeLocal(wavPath);
  if (local) return local;
  return transcribeOpenAI(wavPath);
}

module.exports = { transcribeIfAvailable, isLocalAvailable: () => whisperAvailable };
