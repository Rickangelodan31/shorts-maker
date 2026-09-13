// Tests for plan doc M5 (AI Editorial Upgrade): the post-render quality critic. No test here
// depends on an external API — llm.isAvailable() is false in this environment (no
// OPENAI_API_KEY exported into the test process), which is exactly the "no signal, never
// throw, never reject" fast path every other LLM call site in this app already relies on.
const test = require('node:test');
const assert = require('node:assert/strict');

const { isAvailable, critiqueRenderedClip, pickCritiqueSampleTimes, CRITIC_SCHEMA } = require('../src/critic');
const { applyCriticVerdict } = require('../src/pipeline');

test('critic.isAvailable(): false in this environment (no OPENAI_API_KEY) — sanity check for every other test here', () => {
  assert.equal(isAvailable(), false);
});

test('pickCritiqueSampleTimes: returns the requested count, evenly spaced within [0, duration]', () => {
  const times = pickCritiqueSampleTimes(50, 5);
  assert.equal(times.length, 5);
  for (const t of times) {
    assert.ok(t > 0 && t < 50);
  }
  // Evenly spaced: consecutive gaps should all be equal (duration/count).
  const gap = times[1] - times[0];
  for (let i = 2; i < times.length; i++) {
    assert.ok(Math.abs((times[i] - times[i - 1]) - gap) < 1e-9);
  }
});

test('pickCritiqueSampleTimes: at least 1 sample even for a tiny/zero count', () => {
  assert.equal(pickCritiqueSampleTimes(10, 0).length, 1);
});

test('CRITIC_SCHEMA: required matches properties (same strict-schema discipline as semantic.js)', () => {
  const propKeys = Object.keys(CRITIC_SCHEMA.properties).sort();
  const required = [...CRITIC_SCHEMA.required].sort();
  assert.deepEqual(required, propKeys);
});

test('critiqueRenderedClip: unavailable (no API key) -> null, no I/O attempted, never throws', async () => {
  const result = await critiqueRenderedClip({ outputPath: '/nonexistent/path.mp4', words: [], segments: [], durationSec: 30, tmpDir: '/tmp' });
  assert.equal(result, null);
});

test('critiqueRenderedClip: missing/zero durationSec -> null rather than throwing', async () => {
  assert.equal(await critiqueRenderedClip({ outputPath: 'x.mp4', durationSec: 0, tmpDir: '/tmp' }), null);
  assert.equal(await critiqueRenderedClip({ outputPath: 'x.mp4', tmpDir: '/tmp' }), null);
});

// --- applyCriticVerdict (the pure promotion-gate bookkeeping) ---

function fakeJobWithEntry(candidateIndex = 3) {
  const entry = { candidateIndex, status: 'done', length: 20 };
  const job = { id: 'testjob', results: [entry] };
  return { job, entry };
}

test('applyCriticVerdict: null verdict (critic unavailable/failed) never rejects — entry untouched', () => {
  const { job, entry } = fakeJobWithEntry();
  const opened = applyCriticVerdict(job, entry, null, '/tmp/nonexistent-output-dir');
  assert.equal(opened, false);
  assert.equal(job.results.length, 1);
  assert.equal(job.results[0], entry);
  assert.equal(entry.criticVerdict, undefined);
});

test('applyCriticVerdict: a "pass" verdict keeps the entry and records the verdict for transparency', () => {
  const { job, entry } = fakeJobWithEntry();
  const verdict = { verdict: 'pass', reasons: [], confidence: 0.9 };
  const opened = applyCriticVerdict(job, entry, verdict, '/tmp/nonexistent-output-dir');
  assert.equal(opened, false);
  assert.equal(job.results.length, 1);
  assert.equal(entry.criticVerdict, verdict);
});

// This is the direct regression test the plan requires: a rejected render must NEVER remain
// in job.results (and therefore can never leak into the /api/jobs/:id response, which returns
// job.results verbatim) — proven here by asserting the array no longer contains the entry at
// all, not merely that it carries some "rejected" status a consumer would need to know to check.
test('applyCriticVerdict: a "reject" verdict removes the entry from job.results entirely (true promotion gate)', () => {
  const { job, entry } = fakeJobWithEntry();
  const verdict = { verdict: 'reject', reasons: ['face cut off for most of the clip'], confidence: 0.85 };
  const opened = applyCriticVerdict(job, entry, verdict, '/tmp/nonexistent-output-dir-for-critic-test');
  assert.equal(opened, true);
  assert.equal(job.results.length, 0, 'the rejected entry must be fully removed, not just marked');
  assert.equal(job.results.includes(entry), false);
});

test('applyCriticVerdict: rejecting one entry never touches sibling entries in job.results', () => {
  const rejectedEntry = { candidateIndex: 1, status: 'done', length: 20 };
  const keptEntry = { candidateIndex: 2, status: 'done', length: 25 };
  const job = { id: 'testjob2', results: [rejectedEntry, keptEntry] };
  applyCriticVerdict(job, rejectedEntry, { verdict: 'reject', reasons: [], confidence: 0.7 }, '/tmp/nonexistent-output-dir-2');
  assert.deepEqual(job.results, [keptEntry]);
});

test('applyCriticVerdict: an unrecognized verdict string is treated as pass, not reject (fail-safe default)', () => {
  const { job, entry } = fakeJobWithEntry();
  const opened = applyCriticVerdict(job, entry, { verdict: 'maybe', reasons: [], confidence: 0.5 }, '/tmp/x');
  assert.equal(opened, false);
  assert.equal(job.results.length, 1);
});
