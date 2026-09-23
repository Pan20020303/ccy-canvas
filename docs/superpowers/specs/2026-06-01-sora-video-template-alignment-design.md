# Sora Video Template Alignment Design

- Date: 2026-06-01
- Scope: Align front-end video model templates with the behavior documented in `relay-video-test (1)(4).html`.

## Goal

Make the node prompt parameter bar show the correct controls and options for:

- `sora-2`
- `sora-v3-pro`
- `sora-v3-fast`

The alignment is limited to template-driven UI capability metadata. This round does not add new prompt-bar controls for `scenario`, `reference_mode`, `audio_mode`, or multi-reference-video orchestration.

## Approved Decisions

1. Keep the current template-driven rendering architecture.
2. Update only `src/app/model-templates.ts` and its tests.
3. Match the HTML reference for visible parameter capabilities and option lists.

## Template Rules

### `sora-2`

- Service type: `video`
- No separate `mode` control
- No auto aspect ratio
- Aspect ratios: `16:9`, `9:16`
- Resolutions: `720p`
- Durations: `4`, `8`, `12`
- No reference-video capability encoded in this round

### `sora-v3-pro`

- Service type: `video`
- No separate `mode` control
- No auto aspect ratio
- Aspect ratios: `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9`
- Resolutions: `480p`, `720p`
- Durations: `5` through `15`

### `sora-v3-fast`

- Same front-end parameter capabilities as `sora-v3-pro`

## Implementation Notes

- Keep existing request mapping behavior unchanged for this round.
- Use tests to lock exact option lists so future template edits do not silently drift from the HTML reference.

## Verification

- `npm test -- src/app/model-templates.test.ts`
- `npm run build`
