// Reference-mode capability registry.
//
// The video-node prompt panel shows tabs like 首尾帧 / 多图参考 / 动作模仿 /
// 全能参考 / 视频编辑. Each tab is NOT just a visual toggle — it changes the
// shape of the upstream request (which reference inputs are required, how
// they map to backend `reference_mode`, and what each thumbnail slot
// means). This registry is the single source of truth tying those three
// concerns together so the UI can gate tabs honestly and runNode can build
// a correct payload.
//
// See docs/dev/2026-06-reference-mode-capability-plan.md

export type ReferenceModeKey =
  | "first-frame"
  | "first-last"
  | "multi-image"
  | "motion-mimic"
  | "all-in-one"
  | "video-edit";

/** Backend `reference_mode` vocabulary. Must stay in sync with the Go
 *  side (ReferenceMode field in service.go). */
export type BackendReferenceMode =
  | "auto"
  | "first_frame"
  | "start_end"
  | "image_reference"
  | "motion_mimic"
  | "video_edit";

export type ReferenceModeSpec = {
  key: ReferenceModeKey;
  /** Display label (zh / en). */
  label: { zh: string; en: string };
  /** Input requirements — drives whether the tab is selectable. */
  requires: {
    images: { min: number; max: number };
    videos: { min: number; max: number };
  };
  /** How this mode maps onto the backend's reference_mode field. */
  backendMode: BackendReferenceMode;
  /** Named thumbnail slots. Empty array → use plain numbered badges.
   *  When present, the strip labels each slot in order. A trailing
   *  "(可选)" marks an optional slot the user may leave empty. */
  slots: { zh: string; en: string; optional?: boolean }[];
  /** Short hint shown when the tab is disabled, explaining the prereq. */
  disabledHint: { zh: string; en: string };
};

export const REFERENCE_MODE_SPECS: Record<ReferenceModeKey, ReferenceModeSpec> = {
  "first-last": {
    key: "first-last",
    label: { zh: "首尾帧", en: "First / Last" },
    requires: { images: { min: 1, max: 2 }, videos: { min: 0, max: 0 } },
    backendMode: "start_end",
    slots: [
      { zh: "首帧", en: "First frame" },
      { zh: "尾帧", en: "Last frame", optional: true },
    ],
    disabledHint: {
      zh: "首尾帧需要连接 1~2 张图片",
      en: "First/Last needs 1–2 reference images",
    },
  },
  // 首帧专用（HappyHorse 图生 i2v 等只支持单张首帧的模型）。
  // 不接受尾帧，避免误导用户连两张。
  "first-frame": {
    key: "first-frame",
    label: { zh: "首帧", en: "First frame" },
    requires: { images: { min: 1, max: 1 }, videos: { min: 0, max: 0 } },
    backendMode: "first_frame",
    slots: [
      { zh: "首帧", en: "First frame" },
    ],
    disabledHint: {
      zh: "首帧模式需要连接 1 张图片",
      en: "First-frame mode needs exactly 1 image",
    },
  },
  "multi-image": {
    key: "multi-image",
    label: { zh: "多图参考", en: "Multi-image" },
    requires: { images: { min: 1, max: 9 }, videos: { min: 0, max: 0 } },
    backendMode: "image_reference",
    slots: [], // plain numbered badges
    disabledHint: {
      zh: "多图参考需要连接至少 1 张图片",
      en: "Multi-image needs at least 1 image",
    },
  },
  "motion-mimic": {
    key: "motion-mimic",
    label: { zh: "动作模仿", en: "Motion mimic" },
    requires: { images: { min: 0, max: 1 }, videos: { min: 1, max: 1 } },
    backendMode: "motion_mimic",
    slots: [
      { zh: "动作视频", en: "Motion video" },
      { zh: "形象参考", en: "Identity ref", optional: true },
    ],
    disabledHint: {
      zh: "动作模仿需要连接 1 个视频节点",
      en: "Motion mimic needs 1 connected video",
    },
  },
  "all-in-one": {
    key: "all-in-one",
    label: { zh: "全能参考", en: "All-in-one" },
    requires: { images: { min: 0, max: 9 }, videos: { min: 0, max: 2 } },
    backendMode: "image_reference",
    slots: [],
    disabledHint: {
      zh: "全能参考可混合图片与视频引用",
      en: "All-in-one mixes image and video references",
    },
  },
  "video-edit": {
    key: "video-edit",
    label: { zh: "视频编辑", en: "Video edit" },
    // DashScope video-edit: exactly 1 source video + 0~5 reference images.
    requires: { images: { min: 0, max: 5 }, videos: { min: 1, max: 1 } },
    backendMode: "video_edit",
    slots: [
      { zh: "源视频", en: "Source video" },
      { zh: "参考图", en: "Reference", optional: true },
    ],
    disabledHint: {
      zh: "视频编辑需要连接 1 个源视频节点",
      en: "Video edit needs 1 connected source video",
    },
  },
};

/** Ordered list used to render tabs left-to-right. */
export const REFERENCE_MODE_ORDER: ReferenceModeKey[] = [
  "first-frame",
  "first-last",
  "multi-image",
  "motion-mimic",
  "all-in-one",
  "video-edit",
];

export type ReferenceInputCounts = { images: number; videos: number };

/** Whether the given input counts satisfy a mode's requirements. */
export function isModeSatisfied(
  key: ReferenceModeKey,
  counts: ReferenceInputCounts,
): boolean {
  const spec = REFERENCE_MODE_SPECS[key];
  if (!spec) return false;
  const { images, videos } = spec.requires;
  return (
    counts.images >= images.min &&
    counts.images <= images.max &&
    counts.videos >= videos.min &&
    counts.videos <= videos.max
  );
}

/** The modes a given model supports, intersected with the registry.
 *  Falls back to ['multi-image'] for models that don't declare any —
 *  the most conservative option that still lets a single image through. */
export function modesForModel(supported: string[] | undefined): ReferenceModeKey[] {
  if (!supported || supported.length === 0) return ["multi-image"];
  return REFERENCE_MODE_ORDER.filter((k) => supported.includes(k));
}

/**
 * Whether a HappyHorse mode suffix (t2v / i2v / r2v / video-edit) is valid for
 * the given upstream reference counts, per the DashScope contract:
 *   - t2v:        no references at all.
 *   - i2v:        EXACTLY 1 image, 0 video (the video's first frame).
 *   - r2v:        1~9 images, 0 video.
 *   - video-edit: EXACTLY 1 source video + 0~5 reference images.
 * Pure + exported so the node UI gating and its unit tests share one source of
 * truth (the component's isHappyHorseSuffixSatisfied just closes over refCounts).
 */
export function happyHorseSuffixSatisfied(
  suffix: string,
  counts: ReferenceInputCounts,
): boolean {
  switch (suffix) {
    case "t2v":
      return counts.images === 0 && counts.videos === 0;
    case "i2v":
      return counts.images === 1 && counts.videos === 0;
    case "r2v":
      return counts.images >= 1 && counts.images <= 9 && counts.videos === 0;
    case "video-edit":
      return counts.videos === 1 && counts.images <= 5;
    default:
      return true;
  }
}

/** Pick the first satisfied mode from a candidate list, or the first
 *  candidate as a last resort (so a node never has an empty mode). Used
 *  for auto-fallback when inputs change. */
export function firstSatisfiedMode(
  candidates: ReferenceModeKey[],
  counts: ReferenceInputCounts,
): ReferenceModeKey | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.find((k) => isModeSatisfied(k, counts)) ?? candidates[0];
}
