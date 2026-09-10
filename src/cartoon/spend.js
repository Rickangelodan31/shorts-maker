// Unified real-money spend ledger for a Cartoon Studio project, covering every AI call this
// subsystem makes — text (story/character/location generation), reference images, and video —
// not just video like the original Phase 2 tracker. `totalUsd` is a strictly monotonic running
// total of REAL money spent: every call that actually reached the provider and cost something
// adds to it, even if the result is later discarded or regenerated. That reflects your actual
// bill and real quota usage, not just "the cost of whatever is currently stored" (which is what
// a recompute-from-current-state approach would under-count on a regeneration).
function ensureSpend(project) {
  if (!project.spend) {
    // Migrate the original video-only tracker forward so existing projects don't lose history.
    project.spend = project.videoSpend
      ? { totalUsd: project.videoSpend.totalUsd || 0, log: [...(project.videoSpend.log || [])] }
      : { totalUsd: 0, log: [] };
  }
  return project.spend;
}

// entry: { kind: 'text'|'image'|'video', context: string, costUsd, ...extra fields }
function record(project, entry) {
  const spend = ensureSpend(project);
  const costUsd = Math.round((entry.costUsd || 0) * 100) / 100;
  spend.totalUsd = Math.round((spend.totalUsd + costUsd) * 100) / 100;
  spend.log.push({ ...entry, costUsd, totalAfterUsd: spend.totalUsd, at: new Date().toISOString() });
  if (spend.log.length > 300) spend.log = spend.log.slice(-300);
  return spend;
}

module.exports = { ensureSpend, record };
