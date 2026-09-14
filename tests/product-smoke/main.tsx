// Isolated development fixture. Browser harness blocks every API and upload
// request. It never binds to a backend project or starts a generation task.
import { createRoot } from 'react-dom/client';
import { AuthProvider } from '../../src/app/auth/AuthProvider';
import { Canvas } from '../../src/app/components/Canvas';
import { Toolbar } from '../../src/app/components/Toolbar';
import { useStore } from '../../src/app/store';
import '../../src/styles/index.css';

const poster = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#334155"/></svg>');

function seed(count: number) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `fixture-${i}`, type: i % 4 === 0 ? 'textNode' : i % 4 === 1 ? 'imageNode' : i % 4 === 2 ? 'videoNode' : 'audioNode',
    position: { x: (i % 40) * 380, y: Math.floor(i / 40) * 340 }, width: 300, height: 220,
    data: { customTitle: `Fixture ${i}`, content: i % 4 === 0 ? 'Isolated canvas text '.repeat(60) : '',
      url: i % 4 === 0 ? undefined : i % 4 === 1 ? poster : `/fixture/${i % 4 === 2 ? 'video.mp4' : 'audio.wav'}`,
      thumbnail: i % 4 === 2 ? poster : undefined, mediaWidth: 320, mediaHeight: 180, status: 'done' },
  }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, source: nodes[i].id, target: node.id, type: 'flow' }));
  useStore.setState({ nodes, edges, groups: [], undoStack: [], redoStack: [], activeBackendProjectId: null,
    activeProjectId: 'isolated-fixture', canvasHydrated: true, backendSyncing: false,
    backendModels: [{ id: 'fixture-provider', name: 'Fixture', vendor: 'Fixture', service_type: 'video', status: 'enabled', model_list: ['custom-video'], capabilities: ['video'], parameter_schema: { resolution_options: ['720p'], duration_options: [5] } } as never] });
}

function inputFixture() {
  seed(0);
  useStore.setState({ nodes: [
    { id: 'image', type: 'referenceImageNode', position: { x: 80, y: 100 }, data: { url: poster, mediaWidth: 320, mediaHeight: 180 } },
    { id: 'audio', type: 'referenceAudioNode', position: { x: 80, y: 400 }, data: { url: '/fixture/audio.wav', sourceName: 'Reference audio' } },
    { id: 'video', type: 'videoNode', position: { x: 700, y: 150 }, data: { promptDraft: 'Ocean', generationParams: { model: 'custom-video', vendor: 'Fixture', durationSeconds: 5, resolution: '720p' } } },
  ], edges: [{ id: 'image-video', source: 'image', target: 'video', type: 'flow' }, { id: 'audio-video', source: 'audio', target: 'video', type: 'flow' }] });
  useStore.getState().requestCanvasFocus('video');
}

(window as unknown as { productFixture: unknown }).productFixture = {
  seed, inputFixture, focus: (id: string) => useStore.getState().requestCanvasFocus(id),
  snapshot: () => ({ count: useStore.getState().nodes.length, pending: useStore.getState().pendingRunConfirm,
    nodes: useStore.getState().nodes.map(n => ({ id: n.id, position: n.position, status: n.data.status })) }),
};
seed(100);
document.documentElement.classList.add('dark');
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<AuthProvider><div className="relative h-screen w-full overflow-hidden bg-[#16181c]"><Toolbar /><Canvas /></div></AuthProvider>);
