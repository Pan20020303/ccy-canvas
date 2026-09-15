// Canonical public entry used by every canvas node's lazy preview import.
// Keep one implementation so a tested viewer cannot diverge from production.
export { MediaPreviewModal as default } from './nodes/media-preview/MediaPreviewModal';
export type { MediaPreviewProps } from './nodes/media-preview/MediaPreviewModal';
