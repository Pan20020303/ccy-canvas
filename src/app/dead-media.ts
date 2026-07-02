// Shared safety guard for auto-removing unloadable history/asset media.
//
// Auto-delete is destructive, so two safeguards keep a transient outage from
// wiping a user's library:
//   1. Offline → never auto-delete (the data is probably fine once back online).
//   2. A per-session BUDGET for UNCERTAIN failures — a remote/relative URL that
//      404s could be a server/proxy blip that fails EVERY tile at once. CERTAIN
//      dead (empty or blob: src, which can never load again) bypasses the budget.
//
// When the budget is exhausted we stop auto-deleting for the rest of the session
// (assume outage, not genuinely-dead data) and fall back to showing placeholders.

let uncertainDeleteBudget = 40;

/**
 * Run `remove` to auto-delete an unloadable entry, subject to the safeguards.
 * `certain` = the media can never load (empty / blob: src). Uncertain failures
 * (a remote/relative URL that errored) are budget-limited.
 */
export function reportDeadMedia(certain: boolean, remove: () => void): void {
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (!online) return;
  if (!certain) {
    if (uncertainDeleteBudget <= 0) return;
    uncertainDeleteBudget -= 1;
  }
  remove();
}

/** True when the src can never successfully load (empty or a stale blob: URL). */
export function isCertainlyDeadSrc(src: string): boolean {
  return !src || src.startsWith('blob:');
}
