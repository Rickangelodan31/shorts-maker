// Pool assembly/selection policy — sits between the raw candidate generators
// (highlight.js: audio, visualscan.js: visual) and the semantic layer (semantic.js).
// Knows nothing about transcripts, LLMs, or rendering — purely about which windows of
// source time are worth considering and how many of them to spend semantic analysis on.

function overlaps(a, b) {
  const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  return ov > Math.min(a.length, b.length) * 0.4;
}

// Merges the two independently-generated candidate pools, deduping overlapping windows
// (same overlap rule already used inside findHighlightClips) rather than dropping either
// pool's unique finds. This is the concrete fix for "a silent visual gag or gameplay event
// must not be excluded just because it scores low on transcript/audio" — it now has its
// own path into the pool instead of only ever being audio-derived.
function mergeCandidatePools(audioPool, visualPool) {
  const audio = (audioPool || []).map((c) => ({ ...c, source: 'audio', audioScore: c.score, visualScore: null }));
  const visual = (visualPool || []).map((c) => ({ ...c, source: 'visual', audioScore: null, visualScore: c.score }));

  const merged = [];
  const usedVisual = new Set();

  for (const a of audio) {
    let matchIdx = null;
    for (let i = 0; i < visual.length; i++) {
      if (usedVisual.has(i)) continue;
      if (overlaps(a, visual[i])) { matchIdx = i; break; }
    }
    if (matchIdx !== null) {
      usedVisual.add(matchIdx);
      const v = visual[matchIdx];
      const primary = a.score >= v.score ? a : v; // keep the stronger window's exact boundaries
      merged.push({ ...primary, source: 'both', audioScore: a.score, visualScore: v.score, score: Math.max(a.score, v.score) });
    } else {
      merged.push(a);
    }
  }
  visual.forEach((v, i) => { if (!usedVisual.has(i)) merged.push(v); });

  return merged;
}

// Adaptive selection for the (transcript-only) semantic ranking stage — NOT a hard-coded
// top-N slice. Scores are normalized per-source (audio-scale and visual-scale numbers
// aren't comparable) before comparing "how close to that source's own best moment", so a
// visually-sourced candidate isn't rank-cut just because audio-sourced candidates happen
// to dominate a flat top-N list.
function selectCandidatesForSemanticPass(mergedPool, opts = {}) {
  const floor = opts.floor ?? parseInt(process.env.SEMANTIC_CANDIDATE_FLOOR || '8', 10);
  const ceiling = opts.ceiling ?? parseInt(process.env.SEMANTIC_CANDIDATE_CEILING || '20', 10);
  const relativeThreshold = opts.relativeThreshold ?? parseFloat(process.env.SEMANTIC_RELATIVE_THRESHOLD || '0.4');
  // Scene-change score is a much noisier signal than audio+keyword — plenty of visually
  // "different" moments are editorially meaningless (an ordinary hard cut in edited
  // footage). Cap how many visual-ONLY candidates (not corroborated by any audio signal)
  // can consume semantic-analysis budget, so scene-change noise can't flood the pipeline.
  const maxVisualOnly = opts.maxVisualOnly ?? parseInt(process.env.SEMANTIC_MAX_VISUAL_ONLY || '4', 10);

  if (!mergedPool.length) return [];

  const maxAudio = Math.max(0, ...mergedPool.map((c) => c.audioScore || 0));
  const maxVisual = Math.max(0, ...mergedPool.map((c) => c.visualScore || 0));

  const withRelevance = mergedPool.map((candidate) => {
    const audioRel = maxAudio > 0 && candidate.audioScore != null ? candidate.audioScore / maxAudio : 0;
    const visualRel = maxVisual > 0 && candidate.visualScore != null ? candidate.visualScore / maxVisual : 0;
    return { candidate, relevance: Math.max(audioRel, visualRel) };
  });
  withRelevance.sort((a, b) => b.relevance - a.relevance);

  const cutoff = 1 - relativeThreshold;
  let selected = withRelevance.filter((w) => w.relevance >= cutoff).map((w) => w.candidate);

  if (selected.length < Math.min(floor, withRelevance.length)) {
    selected = withRelevance.slice(0, floor).map((w) => w.candidate);
  }
  if (selected.length > ceiling) selected = selected.slice(0, ceiling);

  let visualOnlyCount = 0;
  selected = selected.filter((c) => {
    if (c.source !== 'visual') return true;
    visualOnlyCount++;
    return visualOnlyCount <= maxVisualOnly;
  });

  return selected;
}

module.exports = { mergeCandidatePools, selectCandidatesForSemanticPass };
