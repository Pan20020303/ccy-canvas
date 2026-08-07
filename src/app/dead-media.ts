// Shared safety guard for auto-removing unloadable history/asset media.
//
// Auto-delete is destructive, so the safeguards err on the side of KEEPING
// data — a placeholder tile is annoying, a deleted asset is gone forever:
//   1. Offline → never auto-delete (the data is probably fine once back online).
//   2. A per-session BUDGET for UNCERTAIN failures — a remote/relative URL that
//      404s could be a server/proxy blip that fails EVERY tile at once. CERTAIN
//      dead (a stale blob: src, which can never load again) bypasses the budget.
//   3. An EMPTY src is NOT deletable at all: the persist layer strips heavy
//      data:/blob: values to '' locally while the server may still hold the
//      real copy — hydration restores it. (Deleting empty-src entries on sight
//      is exactly how saved assets used to vanish permanently.)
//
// When the budget is exhausted we stop auto-deleting for the rest of the session
// (assume outage, not genuinely-dead data) and fall back to showing placeholders.

let uncertainDeleteBudget = 12;

/**
 * Run `remove` to auto-delete an unloadable entry, subject to the safeguards.
 * `certain` = the media can never load (stale blob: src). Uncertain failures
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

/** True when the src can never successfully load again (a stale blob: URL).
 *  NOTE: an empty src is deliberately NOT "certainly dead" — see header. */
export function isCertainlyDeadSrc(src: string): boolean {
  return src.startsWith('blob:');
}
