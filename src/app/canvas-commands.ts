const UPLOAD_EVENT = 'ccy:canvas-upload-local';

/** Toolbars and context menus share the canvas' existing file-import path. */
export function requestCanvasUpload(): void {
  window.dispatchEvent(new Event(UPLOAD_EVENT));
}

export function onCanvasUploadRequested(callback: () => void): () => void {
  window.addEventListener(UPLOAD_EVENT, callback);
  return () => window.removeEventListener(UPLOAD_EVENT, callback);
}
