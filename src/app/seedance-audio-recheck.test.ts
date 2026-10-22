import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { orderedReferenceConnections } from './reference-connections';
import { migrateMentionTags, resolvePromptMentionTags, synchronizeReferenceMentions } from './reference-mentions';

// Explicit local fixture opt-in. This never connects to the app, DB or provider.
const directory = process.env.CCY_AUDIO_RECHECK_DIR;
const bindingsOnly = process.env.CCY_AUDIO_RECHECK_MODE === 'bindings';
const records: unknown[] = [];
describe.skipIf(!directory)('actual project Seedance audio request audit (offline)', () => {
  const canvas = directory ? JSON.parse(readFileSync(join(directory, 'canvas_before.json'), 'utf8').replace(/^\uFEFF/, '')) : {};
  const providers = directory ? JSON.parse(readFileSync(join(directory, 'frontend_providers.json'), 'utf8').replace(/^\uFEFF/, '')) : [];
  const patch = directory && bindingsOnly ? JSON.parse(readFileSync(join(directory, 'patch_payload.json'), 'utf8').replace(/^\uFEFF/, '')) : null;
  beforeEach(() => {
    vi.resetModules();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), key: (index: number) => [...storage.keys()][index] ?? null, get length() { return storage.size; } });
  });
  afterAll(() => {
    if (directory) writeFileSync(join(directory, bindingsOnly ? 'frontend_binding_request_capture.json' : 'frontend_request_capture.json'), JSON.stringify({
      canvas_version: canvas.version, snapshot_sha256: createHash('sha256').update(readFileSync(join(directory, 'canvas_before.json'))).digest('hex'),
      method: 'actual useStore.runNode -> providerConfigs.generate -> apiClient.post -> intercepted fetch JSON body',
      network_access: false, real_generation_calls: 0, scenarios: records,
    }, null, 2));
    vi.unstubAllGlobals();
  });
  for (let segment = 1; segment <= 7; segment++) {
    for (const variant of (bindingsOnly ? ['patched-bindings'] : ['current', 'multi-image', 'all-in-one'])) {
      it(`P${String(segment).padStart(2, '0')} / ${variant}`, async () => {
        const captured: Record<string, any>[] = [];
        const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
          if (!/\/api\/app\/generate$/.test(String(input))) {
            // The store may start its local task status poller. Keep it offline too.
            return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          captured.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ error: { code: 'offline_audit', message: 'Intercepted locally; no request was sent.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const { useStore } = await import('./store');
        const nodes = structuredClone(canvas.nodes);
        if (patch) for (const update of patch.data_updates) {
          const node = nodes.find((candidate: any) => candidate.id === update.id);
          Object.assign(node.data, update.set);
          for (const key of update.unset ?? []) delete node.data[key];
        }
        const targetId = `sd25-P${String(segment).padStart(2, '0')}-video`;
        const target = nodes.find((node: any) => node.id === targetId);
        if (variant === 'multi-image' || variant === 'all-in-one') target.data.generationParams.referenceVariant = variant;
        useStore.setState({ nodes, edges: structuredClone(canvas.edges), groups: structuredClone(canvas.groups),
          activeBackendProjectId: canvas.project_id, activeProjectId: canvas.project_id, canvasHydrated: true,
          backendProjects: [{ id: canvas.project_id, name: '山海变第一集离线审计', my_role: 'creator', created_at: '', updated_at: '' }],
          backendModels: providers, confirmBeforeGenerate: false, language: 'zh' });
        const refs = orderedReferenceConnections(nodes, canvas.edges, targetId);
        const expectedAudio = refs.filter(ref => ref.kind === 'audio').map(ref => ref.node.data.url);
        const expectedImages = refs.filter(ref => ref.kind === 'image').map(ref => ref.node.data.url);
        let submittedPrompt = target.data.promptDraft;
        let chipRoundTrip: Record<string, unknown> | undefined;
        if (patch) {
          const mentionRefs = refs.map(ref => ({ id: ref.node.id, label: `${ref.kind === 'image' ? '图片' : ref.kind === 'audio' ? '音频' : '视频'}${ref.index}`, kind: ref.kind, thumb: ref.kind === 'image' ? String(ref.node.data.url ?? '') : '' }));
          const migrated = migrateMentionTags(target.data.promptDraft, target.data.promptMentions) ?? { text: target.data.promptDraft, mentions: target.data.promptMentions };
          const chips = synchronizeReferenceMentions(migrated.text, migrated.mentions, mentionRefs);
          submittedPrompt = resolvePromptMentionTags(chips.text, chips.mentions, mentionRefs, true);
          chipRoundTrip = { original_prompt_sha256: createHash('sha256').update(target.data.promptDraft).digest('hex'),
            resolved_prompt_sha256: createHash('sha256').update(submittedPrompt).digest('hex'),
            chip_text: chips.text, stable_bindings: chips.mentions,
            exact_round_trip: submittedPrompt === target.data.promptDraft };
          expect(chips.mentions).toHaveLength(expectedImages.length + expectedAudio.length);
          expect(chips.text).toContain('\u2060\u3000');
          expect(submittedPrompt).toBe(target.data.promptDraft);
          expect(submittedPrompt).not.toContain('\u2060');
        }
        await useStore.getState().runNode(targetId, { prompt: submittedPrompt, model: target.data.generationParams.model });
        const request = captured[0];
        const actualAudio = request ? [...(request.reference_audio ? [request.reference_audio] : []), ...(request.reference_audios ?? [])] : [];
        records.push({ targetId, scenario: variant, persistedVariant: target.data.generationParams.referenceVariant,
          referenceInputSource: target.data.generationParams.referenceInputSource,
          draft_matches_prompt: target.data.promptDraft === target.data.prompt,
          media: refs.filter(ref => ['image', 'video', 'audio'].includes(ref.kind)).map(ref => ({
            id: ref.node.id, kind: ref.kind, index: ref.index, type: ref.node.type, url: ref.node.data.url, sourceName: ref.node.data.sourceName,
            registered_mention: (target.data.promptMentions ?? []).some((mention: any) => mention.id === ref.node.id),
          })), request, expected_audio: expectedAudio, captured_audio: actualAudio,
          final_error: useStore.getState().nodes.find(node => node.id === targetId)?.data.error,
          intercepted_fetch_urls: fetchMock.mock.calls.map(call => String(call[0])),
          chip_round_trip: chipRoundTrip,
        });
        expect(captured).toHaveLength(1);
        expect(request.reference_images).toEqual(expectedImages);
        expect(actualAudio).toEqual(expectedAudio);
        expect(request.prompt).toBe(target.data.promptDraft);
        expect(request.duration).toBe(30);
        expect(request.model).toBe('dreamina-seedance-2-5-260628');
      });
    }
  }
});
