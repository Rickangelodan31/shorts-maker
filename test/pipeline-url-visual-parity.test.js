// Tests for plan doc M8 (AI Editorial Upgrade): URL job visual-candidate parity. No test
// here touches the network or yt-dlp/ffmpeg — tryBuildUrlVisualInterest accepts injectable
// `deps` (downloadLowResVideoProxy/computeVisualInterestTimeline) specifically so this stays
// fast and deterministic, mirroring how mapLimit is already injected elsewhere in this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { shouldAttemptUrlVisualProxy, tryBuildUrlVisualInterest } = require('../src/pipeline');

test('shouldAttemptUrlVisualProxy: true for a reasonable duration under the default ceiling', () => {
  assert.equal(shouldAttemptUrlVisualProxy(600), true); // 10 min
});

test('shouldAttemptUrlVisualProxy: false when duration exceeds the ceiling', () => {
  assert.equal(shouldAttemptUrlVisualProxy(5000, 1800), false);
});

test('shouldAttemptUrlVisualProxy: true exactly at the ceiling (inclusive boundary)', () => {
  assert.equal(shouldAttemptUrlVisualProxy(1800, 1800), true);
});

test('shouldAttemptUrlVisualProxy: false for missing/zero/negative duration (never attempt on bad data)', () => {
  assert.equal(shouldAttemptUrlVisualProxy(0), false);
  assert.equal(shouldAttemptUrlVisualProxy(-5), false);
  assert.equal(shouldAttemptUrlVisualProxy(undefined), false);
  assert.equal(shouldAttemptUrlVisualProxy(null), false);
});

test('shouldAttemptUrlVisualProxy: DISABLE_VISUAL_SCAN=1 disables the URL proxy path too (same flag as uploads)', () => {
  process.env.DISABLE_VISUAL_SCAN = '1';
  try {
    assert.equal(shouldAttemptUrlVisualProxy(600), false);
  } finally {
    delete process.env.DISABLE_VISUAL_SCAN;
  }
});

test('tryBuildUrlVisualInterest: over the duration ceiling -> null WITHOUT attempting any download', async () => {
  let downloadCalled = false;
  const result = await tryBuildUrlVisualInterest('https://example.com/v', 'job1', '/tmp', 5000, () => {}, {
    downloadLowResVideoProxy: async () => { downloadCalled = true; return '/tmp/proxy.mp4'; },
    computeVisualInterestTimeline: async () => ({ visualInterest: [1, 2, 3], hopSec: 0.5 }),
  });
  assert.equal(result, null);
  assert.equal(downloadCalled, false, 'must not attempt a download when over the ceiling');
});

test('tryBuildUrlVisualInterest: under the ceiling -> downloads the proxy and returns the scan result', async () => {
  let downloadArgs = null;
  let scanArgs = null;
  const result = await tryBuildUrlVisualInterest('https://example.com/v', 'job1', '/tmp', 600, () => {}, {
    downloadLowResVideoProxy: async (url, jobId, jobTmp) => { downloadArgs = { url, jobId, jobTmp }; return '/tmp/job1_visualproxy.mp4'; },
    computeVisualInterestTimeline: async (proxyPath, durationSec) => { scanArgs = { proxyPath, durationSec }; return { visualInterest: [1, 2, 3], hopSec: 0.5 }; },
  });
  assert.deepEqual(result, { visualInterest: [1, 2, 3], hopSec: 0.5 });
  assert.deepEqual(downloadArgs, { url: 'https://example.com/v', jobId: 'job1', jobTmp: '/tmp' });
  assert.equal(scanArgs.proxyPath, '/tmp/job1_visualproxy.mp4');
  assert.equal(scanArgs.durationSec, 600);
});

test('tryBuildUrlVisualInterest: a failed download degrades to null, never throws', async () => {
  const result = await tryBuildUrlVisualInterest('https://example.com/v', 'job1', '/tmp', 600, () => {}, {
    downloadLowResVideoProxy: async () => { throw new Error('yt-dlp exploded'); },
    computeVisualInterestTimeline: async () => ({ visualInterest: [1], hopSec: 0.5 }),
  });
  assert.equal(result, null);
});

test('tryBuildUrlVisualInterest: a failed scan degrades to null, never throws', async () => {
  const result = await tryBuildUrlVisualInterest('https://example.com/v', 'job1', '/tmp', 600, () => {}, {
    downloadLowResVideoProxy: async () => '/tmp/job1_visualproxy.mp4',
    computeVisualInterestTimeline: async () => { throw new Error('ffmpeg scene-score pass failed'); },
  });
  assert.equal(result, null);
});

test('tryBuildUrlVisualInterest: cleans up the downloaded proxy file even when the scan fails', async () => {
  const rmSpy = [];
  const originalRm = fs.rm;
  fs.rm = (p, cb) => { rmSpy.push(p); cb(null); };
  try {
    await tryBuildUrlVisualInterest('https://example.com/v', 'job1', '/tmp', 600, () => {}, {
      downloadLowResVideoProxy: async () => '/tmp/job1_visualproxy.mp4',
      computeVisualInterestTimeline: async () => { throw new Error('boom'); },
    });
    assert.deepEqual(rmSpy, ['/tmp/job1_visualproxy.mp4']);
  } finally {
    fs.rm = originalRm;
  }
});

test('tryBuildUrlVisualInterest: does not attempt cleanup when the download itself never produced a path', async () => {
  const rmSpy = [];
  const originalRm = fs.rm;
  fs.rm = (p, cb) => { rmSpy.push(p); cb(null); };
  try {
    await tryBuildUrlVisualInterest('https://example.com/v', 'job1', '/tmp', 600, () => {}, {
      downloadLowResVideoProxy: async () => { throw new Error('network error'); },
      computeVisualInterestTimeline: async () => ({ visualInterest: [], hopSec: 0.5 }),
    });
    assert.deepEqual(rmSpy, []);
  } finally {
    fs.rm = originalRm;
  }
});
