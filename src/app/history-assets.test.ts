import { describe, expect, it } from "vitest";

import type { HistoryItem } from "./store";
import {
  canPreviewHistoryItem,
  computeBatchActionAvailability,
  countHistoryByMediaType,
  filterHistoryByMediaType,
  getHistoryPreviewSequence,
  getPreviewCursor,
  getHistoryItemAssetUrl,
  getZoomLayout,
  groupHistoryByDate,
} from "./history-assets";

const sampleHistory: HistoryItem[] = [
  {
    id: "image-1",
    spaceId: "space-personal",
    spaceType: "personal",
    projectId: "p-default",
    title: "Image 1",
    type: "image",
    mediaType: "image",
    timestamp: new Date("2026-06-01T10:00:00+08:00").getTime(),
    thumbnail: "https://example.com/image-1.png",
    aspectRatio: "square",
  },
  {
    id: "video-1",
    spaceId: "space-personal",
    spaceType: "personal",
    projectId: "p-default",
    title: "Video 1",
    type: "video",
    mediaType: "video",
    timestamp: new Date("2026-06-01T09:00:00+08:00").getTime(),
    thumbnail: "https://example.com/video-1.mp4",
    aspectRatio: "landscape",
  },
  {
    id: "audio-1",
    spaceId: "space-personal",
    spaceType: "personal",
    projectId: "p-default",
    title: "Audio 1",
    type: "audio",
    mediaType: "audio",
    timestamp: new Date("2026-05-31T18:00:00+08:00").getTime(),
    thumbnail: "https://example.com/audio-1.mp3",
    aspectRatio: "text",
  },
];

describe("history assets helpers", () => {
  it("filters history by media type", () => {
    expect(filterHistoryByMediaType(sampleHistory, "image").map((item) => item.id)).toEqual(["image-1"]);
    expect(filterHistoryByMediaType(sampleHistory, "video").map((item) => item.id)).toEqual(["video-1"]);
    expect(filterHistoryByMediaType(sampleHistory, "audio").map((item) => item.id)).toEqual(["audio-1"]);
  });

  it("counts history by media type", () => {
    expect(countHistoryByMediaType(sampleHistory)).toEqual({
      image: 1,
      video: 1,
      audio: 1,
    });
  });

  it("groups history by descending date and descending timestamp inside each group", () => {
    const groups = groupHistoryByDate([
      sampleHistory[2],
      sampleHistory[1],
      sampleHistory[0],
    ]);

    expect(groups.map((group) => group.dateLabel)).toEqual(["2026-06-01", "2026-05-31"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["image-1", "video-1"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["audio-1"]);
  });

  it("maps zoom percentages to layout tokens", () => {
    expect(getZoomLayout(75)).toMatchObject({ percentage: 75, columns: 7 });
    expect(getZoomLayout(100)).toMatchObject({ percentage: 100, columns: 6 });
    expect(getZoomLayout(125)).toMatchObject({ percentage: 125, columns: 5 });
  });

  it("computes batch action availability from selected items", () => {
    expect(computeBatchActionAvailability([])).toEqual({
      canDelete: false,
      canDownload: false,
      canUse: false,
    });

    expect(computeBatchActionAvailability([sampleHistory[0], sampleHistory[1]])).toEqual({
      canDelete: true,
      canDownload: true,
      canUse: true,
    });

    // Audio history is insertable too (reuseHistoryItems maps it to a
    // referenceAudioNode), so an audio-only selection enables 使用.
    expect(computeBatchActionAvailability([sampleHistory[2]])).toEqual({
      canDelete: true,
      canDownload: true,
      canUse: true,
    });
  });

  it("returns the asset url for preview and download when available", () => {
    expect(getHistoryItemAssetUrl(sampleHistory[0])).toBe("https://example.com/image-1.png");
    expect(getHistoryItemAssetUrl(sampleHistory[1])).toBe("https://example.com/video-1.mp4");
  });

  it("resolves backend-relative upload urls for previews", () => {
    const uploadHistory: HistoryItem = {
      ...sampleHistory[0],
      id: "image-upload",
      thumbnail: "/uploads/2026-06/example.png",
    };

    expect(getHistoryItemAssetUrl(uploadHistory, "http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/uploads/2026-06/example.png",
    );
    expect(canPreviewHistoryItem(uploadHistory, "http://127.0.0.1:8080")).toBe(true);
  });

  it("marks image, video, and audio history items as previewable when they have a backing url", () => {
    expect(canPreviewHistoryItem(sampleHistory[0])).toBe(true);
    expect(canPreviewHistoryItem(sampleHistory[1])).toBe(true);
    expect(canPreviewHistoryItem(sampleHistory[2])).toBe(true);
  });

  it("builds preview sequence from the current filtered tab in descending time order", () => {
    const sequence = getHistoryPreviewSequence([
      sampleHistory[2],
      sampleHistory[1],
      sampleHistory[0],
    ]);

    expect(sequence.map((item) => item.id)).toEqual(["image-1", "video-1", "audio-1"]);
  });

  it("computes previous and next preview cursor positions", () => {
    const sequence = getHistoryPreviewSequence(sampleHistory);

    expect(getPreviewCursor(sequence, "image-1")).toEqual({
      currentIndex: 0,
      total: 3,
      hasPrevious: false,
      hasNext: true,
      previousItem: null,
      nextItem: sampleHistory[1],
    });

    expect(getPreviewCursor(sequence, "video-1")).toEqual({
      currentIndex: 1,
      total: 3,
      hasPrevious: true,
      hasNext: true,
      previousItem: sampleHistory[0],
      nextItem: sampleHistory[2],
    });
  });
});
