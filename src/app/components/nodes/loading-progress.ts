export function getGenerationProgressPercent(startedAt: number, now = Date.now()): number {
  const elapsed = Math.max(0, now - startedAt);
  const eased = 100 * (1 - Math.exp(-elapsed / 18000));
  return Math.max(3, Math.min(95, Math.round(eased)));
}
