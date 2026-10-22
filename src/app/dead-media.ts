/** Compatibility guard for old preview-error call sites.
 * A failed preview (including a blob URL) cannot establish that an asset or
 * history record should be deleted. Removal must be an explicit user action.
 */
export function reportDeadMedia(_certain: boolean, _remove: () => void): void {
  // Deliberately never invoke a destructive callback from a loading failure.
}

/** A URL alone cannot prove that its owning record is irrecoverable. */
export function isCertainlyDeadSrc(_src: string): boolean {
  return false;
}
