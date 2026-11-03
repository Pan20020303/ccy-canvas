import { apiClient } from './client';
import { extractOriginalMediaUrl } from '../reference-media';

export type LocalVideoTrimResult = {
 url: string; engine: 'ffmpeg'; duration: number; width: number; height: number; has_audio: boolean;
};
export function trimLocalVideo(payload: {
 media_url: string; start: number; end: number; mute: boolean; node_id: string;
}) {
 // Unwrap persisted media proxy URLs; never send a browser blob URL to FFmpeg.
 return apiClient.post<LocalVideoTrimResult>('/api/app/video/trim',
  { ...payload, media_url: extractOriginalMediaUrl(payload.media_url) },
  AbortSignal.timeout(330_000));
}
