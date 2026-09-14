import stellarUrl from "../../../imports/auth/stellar-voyage.webp";
import dragonUrl from "../../../imports/auth/dragon-realm.webp";
import originPosterUrl from "../../../imports/auth/origin-poster.jpg";
import originVideoUrl from "../../../imports/auth/origin-loop.mp4";

export type ShowcaseScene = {
  id: string;
  title: { zh: string; en: string };
  category: string;
  poster: string;
  video?: string;
  position: string;
};

// Add a video URL to an image scene to replace the slow camera move with a film.
// Keep a local poster so reduced-motion and failed autoplay still have a cover.
export const showcaseScenes: readonly ShowcaseScene[] = [
  {
    id: "stellar-voyage",
    title: { zh: "想象，不止于此", en: "Beyond imagination" },
    category: "SCI-FI · 星际远航",
    poster: stellarUrl,
    position: "42% center",
  },
  {
    id: "dragon-realm",
    title: { zh: "让灵感，自成天地", en: "Give your ideas a world" },
    category: "FANTASY · 云上之境",
    poster: dragonUrl,
    position: "38% center",
  },
  {
    id: "origin",
    title: { zh: "每一帧，皆有无限可能", en: "Every frame, a possibility" },
    category: "ORIGINAL · 次元新生",
    poster: originPosterUrl,
    video: originVideoUrl,
    position: "center",
  },
];

export const SHOWCASE_INTERVAL_MS = 10_000;
