// Stable per-user color for collaboration presence. Anchored on user.id (the
// same UUID string the backend session claims and member rows use), so a person
// keeps the same color across sessions, devices, and reloads. Never key on name
// (collisions — the historical same-name bug) or list index (drifts on add/remove).

// A dozen hues that read clearly on the dark canvas (#16181c).
const PALETTE = [
  "#f87171", // red
  "#fb923c", // orange
  "#fbbf24", // amber
  "#a3e635", // lime
  "#34d399", // emerald
  "#22d3ee", // cyan
  "#60a5fa", // blue
  "#818cf8", // indigo
  "#c084fc", // purple
  "#f472b6", // pink
  "#fb7185", // rose
  "#2dd4bf", // teal
];

export function colorForUid(uid: string | undefined | null): string {
  if (!uid) return PALETTE[0];
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
