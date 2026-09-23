import { create } from 'zustand';

export const CANVAS_THEMES = [
  ['midnight','深夜黑','#050505'],['obsidian','黑曜石','#0b0b0b'],['graphite','炭灰','#111111'],['black','玄黑','#161616'],['stone','石墨灰','#1b1b1b'],['steel','钢铁灰','#222222'],['silver','银灰','#292929'],['smoke','烟灰','#303030'],['cement','水泥灰','#383838'],
  ['pebble','卵石灰','#414141'],['mist','薄雾灰','#494949'],['cloud','云灰','#505050'],['space','宇宙蓝','#0b0b1c'],['deep-sea','深海蓝','#0c1425'],['slate','石板蓝','#111c30'],['glow','暮光蓝','#1c2c40'],['navy','海军蓝','#23334b'],['sky','天青蓝','#273e52'],
  ['blue-steel','钢蓝','#294651'],['azure','天空蓝','#315164'],['glacier','冰川蓝','#365f73'],['lake','湖水蓝','#426d82'],['frost','霜云蓝','#4a748b'],['nebula','星云紫','#100d18'],['grape','葡萄紫','#1c111d'],['lavender','薰衣草','#241d30'],['iris','紫罗兰','#2e243d'],
  ['amethyst','紫水晶','#372c48'],['plum','梅子紫','#40304f'],['lilac','丁香紫','#4b3a5a'],['violet','鸢尾紫','#534363'],['berry','浆果紫','#5b4a6b'],['emerald','翡翠绿','#071b17'],['forest','森林绿','#11231b'],['moss','苔藓绿','#1b281c'],['sage','鼠尾草','#273627'],
  ['olive','橄榄绿','#293524'],['bamboo','竹青','#283f32'],['ink-jade','墨玉','#2d493c'],['fern','蕨绿','#345243'],['mint','薄荷绿','#41614b'],['pine','松绿','#496b57'],['wine','酒红','#341923'],['coffee','咖啡棕','#211811'],['mocha','摩卡','#30221a'],
  ['rose','玫瑰棕','#482a35'],['cocoa','可可棕','#4b352d'],['terracotta','陶土','#5a3f35'],['sand','沙丘','#5b4f3c'],['ochre','赭石','#604638'],['warm','暖棕','#6b5047'],['clay','黏土','#755d53'],['copper','铜褐','#5a3424'],['orange','橙暮','#613b2c'],
] as const;
export const EDGE_COLORS = [
  ['default','默认','#b6b6bb'],['ink','墨黑','#45464c'],['stone','石墨','#6b6d72'],['clay','泥土','#8e8178'],['titanium','钛金','#a09b91'],['smoke','烟灰','#a3a3a9'],['silver','秘银','#c7cbd4'],['white','白金','#e2e1db'],['bright','星光','#eee9e5'],
  ['soft','柔白','#d4d4d8'],['volcano','火山','#b34540'],['rouge','胭脂','#b94669'],['crimson','绯红','#d06371'],['neon','霓虹粉','#e7498d'],['watermelon','西瓜','#ca6f82'],['coral','珊瑚','#d1887f'],['rose','玫红','#ce718e'],['sakura','樱粉','#e2a9bd'],
  ['dawn','云霞','#bd9fae'],['peach','蜜桃','#d3a6a3'],['fruit','柔荑粉','#efbbca'],['pink','覆盆子','#ba4364'],['flamingo','火烈鸟','#dc6a8e'],['candy','棉花糖','#e2b7d0'],['cherry','樱花','#dfc0ce'],['strawberry','草莓粉','#e9a6aa'],['maple','枫叶','#b76f49'],
  ['wood','原木','#bd9a68'],['warm','暖橙','#ce854f'],['apricot','杏色','#dba36e'],['gold','焕金','#d3b374'],['amber','琥珀','#d1a044'],['lemon','柠檬','#d9cf67'],['cream','奶黄','#e4d5a1'],['cypress','松柏','#6e9380'],['bamboo','青竹','#84a379'],
  ['spruce','墨竹','#589877'],['olive','橄榄','#a1a775'],['leaf','落叶','#9ea785'],['jade','翠绿','#68af9a'],['aurora','极光','#87c6b3'],['mint','薄荷绿','#83bfa3'],['cyan','冰青','#84c4cf'],['sea','海蓝','#6c99b5'],['blue','雾蓝','#91afc7'],
  ['orchid','兰花紫','#b285bf'],['magenta','品红','#b966b1'],['snow','雪青','#b8a4c7'],['violet','紫藤','#9683ba'],['iris','鸢尾','#9289d0'],['lilac','丁香','#c5aed2'],['custom','自定义','#f26a48'],
] as const;
export const SIMPLE_PALETTES = [
  ['theme','跟随主题',['#7d7d83','#77777d','#8e8e94','#727278','#66666d','#96969b']],
  ['classic','经典柔光',['#75a9cb','#a4b88e','#bd93b9','#d4bb77','#bd927b','#d98b9e']],
  ['wood','浅灰木质',['#ada79c','#bcb4aa','#99968f','#cabaa4','#b5aaa1','#968f83']],
  ['slate','冷灰石板',['#8e9fb3','#a3acb4','#72828e','#9fa6b0','#7b8d9e','#adb5c0']],
  ['nordic','北欧晨雾',['#aab7ba','#a0b5aa','#bfada7','#adabc2','#d0c4b5','#909faa']],
  ['meadow','静谧草木',['#8eaa91','#b6ba8c','#789c82','#ada48b','#a0b79a','#c0c6a3']],
  ['glass','雅致灰褐',['#ab9d97','#b9b2a5','#928a87','#bda69a','#8f9393','#bdb7af']],
  ['morandi','高级莫兰迪',['#c2a6a6','#a2b1b4','#b5b69d','#b4a6ba','#c4b49b','#a1aaa4']],
  ['rock','温暖沙石',['#c1ad93','#b7a691','#bba599','#c9b7a1','#afa59a','#d0b8a3']],
  ['blue','迷雾靛蓝',['#8792b1','#949fbc','#727f9f','#a5aeca','#8993ac','#b7bfd5']],
  ['matcha','幽谷抹茶',['#8ca387','#a6b29a','#7f977f','#b4bea7','#91aa96','#bec8b4']],
  ['pottery','陶土复古',['#ba9a8d','#baae90','#ac8f8a','#cab39e','#a99687','#c7b2a7']],
  ['lavender','薰衣草灰',['#ad9cbd','#bcaac9','#918aa7','#c6b7ce','#a69db5','#d0c6d8']],
  ['oak','暗影橄榄',['#7e907c','#8e967e','#a1a68d','#859180','#9caa93','#6f7e6b']],
  ['nordic-blue','霜冻北欧',['#a3b6c6','#bed0da','#899eae','#9ab6bd','#c3d3d8','#a9bcc2']],
  ['ocean','大漠绿洲',['#b4b398','#8eb4a4','#d0bd94','#95aaa7','#b9c5b4','#9da788']],
  ['autumn','秋水寒烟',['#a5abad','#b1a3a1','#959c9b','#b7b6af','#adbbbf','#c1b0a9']],
  ['gold','墨玉留金',['#81968e','#b6a982','#758780','#c1b391','#8c9e94','#a9a38c']],
  ['ore','矿层回响',['#aa9495','#8294a0','#a8a087','#8e9a97','#b4a2ac','#9ba4ad']],
  ['coast','海岸夕暮',['#b7a397','#91b1bc','#b8b4a4','#9ba7b8','#c3ac9e','#9ab9b1']],
  ['berries','林深浆果',['#a78a9b','#8e9f8c','#ba9aaf','#798e84','#bcadb2','#91a59b']],
  ['books','古籍书卷',['#b4a389','#a6a48f','#c2b093','#9c9484','#c7bda9','#b3ad9f']],
  ['city','迷雾港湾',['#8a9ea7','#a3aeb3','#9aa7a0','#a0a2b3','#b1bab8','#88999c']],
  ['night','都市极简',['#8d9199','#a5a5ac','#747880','#b6b5bc','#858a92','#c1c1c6']],
  ['zen','禅茶一味',['#a3a18a','#b8b5a0','#8f9887','#c6bba5','#9eab99','#b5b3a3']],
  ['mountain','山岚风光',['#9baaab','#adbbb1','#849999','#b9bdaa','#9eafb3','#c0c8bd']],
  ['film','经典胶片',['#b5a48c','#9ba59a','#ad9996','#bec1ac','#8f9c99','#c4b39d']],
  ['ice','冰川幽谷',['#a1b6bd','#90a7b3','#b9c9cf','#90b2b3','#a4c0c5','#c3d2d4']],
] as const;

export const DEFAULT_CANVAS_PREFERENCES = {
  panSensitivity: 1.5, focusAnimationLimit: 100, submitDelay: 0, connectionRadius: 150,
  blankAction: 'double' as 'context' | 'double', wheelAction: 'pan' as 'pan' | 'zoom', mentionNaming: 'name' as 'name' | 'number',
  snapToGrid: false, alignmentGuides: true, dragFocus: true, blurAfterSubmit: false, compactZoom: false, linkedPreview: true, hoverVideo: true,
  notifyCompleted: true, notifyFailed: true, notifyWhen: 'away' as 'away' | 'always', systemNotifications: false, sound: false, onlyOwn: true, soundStyle: 'clear',
  edgeWidth: 2, edgeHitWidth: 12, edgeHover: true, edgeAnimation: true, onlyFocusedEdges: false,
  gridGap: 24, gridDotSize: 2, showGrid: true, ambientGlow: false, showMiniMap: false,
  horizontalGap: 150, verticalGap: 140, groupPadding: 80, groupLabelScale: 1, topToolbarScale: 1, bottomToolbarScale: 1, groupOccludesEdges: true,
  backgroundEnabled: false, backgroundNodeId: '', backgroundOpacity: 25, backgroundBlur: 8, backgroundMode: 'cover' as 'cover' | 'contain' | 'tile', backgroundTileSize: 100,
  themeId: 'graphite', edgeColorId: 'default', customEdgeColor: '#f26a48', simplePaletteId: 'theme',
};
export type CanvasPreferences = typeof DEFAULT_CANVAS_PREFERENCES;
export const NUMERIC_PREFERENCE_LIMITS: Partial<Record<keyof CanvasPreferences, [number, number, number]>> = {
  panSensitivity: [.25, 3, .25], focusAnimationLimit: [0, 1000, 10], submitDelay: [0, 10, 1], connectionRadius: [10, 300, 10],
  edgeWidth: [1, 6, .5], edgeHitWidth: [4, 40, 2], gridGap: [10, 100, 2], gridDotSize: [1, 6, .5],
  horizontalGap: [20, 400, 10], verticalGap: [20, 400, 10], groupPadding: [8, 160, 4], groupLabelScale: [.5, 2, .1], topToolbarScale: [.7, 1.5, .1], bottomToolbarScale: [.7, 1.5, .1],
  backgroundOpacity: [0, 100, 1], backgroundBlur: [0, 30, 1], backgroundTileSize: [10, 200, 10],
};
export const SOUND_STYLES = [['clear','清脆'],['soft','柔和'],['bell','铃声'],['bubble','气泡'],['melody','旋律'],['piano','竖琴'],['wood','木琴'],['horn','号角'],['crystal','水晶'],['light','晨光']] as const;
const enumValues: Partial<Record<keyof CanvasPreferences, readonly string[]>> = {
  blankAction: ['context','double'], wheelAction: ['pan','zoom'], mentionNaming: ['name','number'], notifyWhen: ['away','always'], backgroundMode: ['cover','contain','tile'],
  themeId: CANVAS_THEMES.map(item => item[0]), edgeColorId: EDGE_COLORS.map(item => item[0]), simplePaletteId: SIMPLE_PALETTES.map(item => item[0]), soundStyle: SOUND_STYLES.map(item => item[0]),
};
export function normalizeCanvasPreferences(raw: unknown): CanvasPreferences {
  const result = { ...DEFAULT_CANVAS_PREFERENCES };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(result) as (keyof CanvasPreferences)[]) {
    const value = source[key]; const fallback = result[key];
    if (typeof fallback === 'boolean' && typeof value === 'boolean') Object.assign(result, { [key]: value });
    else if (typeof fallback === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      const [min,max] = NUMERIC_PREFERENCE_LIMITS[key]!; Object.assign(result, { [key]: Math.min(max, Math.max(min, value)) });
    } else if (typeof value === 'string' && typeof fallback === 'string') {
      if (key === 'backgroundNodeId' && value.length <= 200 || key === 'customEdgeColor' && /^#[0-9a-f]{6}$/i.test(value) || enumValues[key]?.includes(value)) Object.assign(result, { [key]: value });
    }
  }
  return result;
}
type PreferenceState = {
  values: CanvasPreferences;
  userId: string;
  persistenceError: boolean;
  setPreference: <K extends keyof CanvasPreferences>(key: K, value: CanvasPreferences[K]) => void;
  restoreDefaults: () => void;
  retrySave: () => void;
};
const keyFor = (id: string) => `ccy-canvas-preferences@${id || 'anon'}`;
function save(values: CanvasPreferences, userId: string): boolean {
  try { localStorage.setItem(keyFor(userId), JSON.stringify({ version: 1, values })); return true; } catch { return false; }
}
export const useCanvasPreferences = create<PreferenceState>((set, get) => ({
  values: { ...DEFAULT_CANVAS_PREFERENCES }, userId: '', persistenceError: false,
  setPreference: (key, value) => { const values = normalizeCanvasPreferences({ ...get().values, [key]: value }); set({ values, persistenceError: !save(values, get().userId) }); },
  restoreDefaults: () => { const values = { ...DEFAULT_CANVAS_PREFERENCES }; set({ values, persistenceError: !save(values, get().userId) }); },
  retrySave: () => set({ persistenceError: !save(get().values, get().userId) }),
}));
export function bindCanvasPreferences(userId: string, legacy?: { snapToGrid?: boolean; showMiniMap?: boolean }) {
  let values = normalizeCanvasPreferences(legacy);
  try { const raw = localStorage.getItem(keyFor(userId)); if (raw) values = normalizeCanvasPreferences(JSON.parse(raw)?.values); } catch { /* Invalid or inaccessible storage must not leak the previous account's settings. */ }
  useCanvasPreferences.setState({ values, userId, persistenceError: false });
}
export function mixColor(base: string, overlay: string, amount: number): string {
  const channels = [1,3,5].map(offset => Math.round(parseInt(base.slice(offset, offset + 2),16) * (1 - amount) + parseInt(overlay.slice(offset, offset + 2),16) * amount).toString(16).padStart(2,'0'));
  return `#${channels.join('')}`;
}
export function canvasThemeVariables(values: CanvasPreferences, appearance: 'light' | 'dark' = 'dark') {
  const light = appearance === 'light' && values.themeId === 'graphite';
  const base = light ? '#e8eaed' : CANVAS_THEMES.find(item => item[0] === values.themeId)?.[2] || '#111111';
  const ink = light ? '#000000' : '#ffffff';
  const colors = simplePaletteColors(values);
  return { '--canvas-bg': base, '--canvas-panel': mixColor(base, ink, .12), '--canvas-card': mixColor(base, ink, .16), '--canvas-active': mixColor(base, ink, .25), '--canvas-grid': mixColor(base, ink, .19),
    // Keep alpha on the surface, never on its contents: images and text retain
    // their original contrast, while the canvas grid shows through empty nodes.
    '--canvas-node-surface': `${mixColor(base, light ? '#ffffff' : '#aab5c8', light ? .65 : .09)}99`,
    '--canvas-ui-surface': `${mixColor(base, light ? '#ffffff' : '#aab5c8', light ? .9 : .11)}e8`,
    '--canvas-menu-surface': `${mixColor(base, light ? '#ffffff' : '#aab5c8', light ? .95 : .055)}f7`,
    '--canvas-ui-soft': `${mixColor(base, ink, .12)}b3`,
    '--canvas-ui-hover': `${mixColor(base, ink, .2)}cc`,
    '--canvas-ui-selected': mixColor(base, ink, light ? .15 : .2),
    '--canvas-ui-border': light ? '#00000012' : '#ffffff10',
    '--canvas-ui-text': light ? '#272930' : '#f0f0f2',
    '--canvas-ui-muted': mixColor(base, light ? '#22252a' : '#ffffff', .68),
    '--canvas-ui-dim': mixColor(base, light ? '#22252a' : '#ffffff', .43),
    '--canvas-simple-text': colors[0], '--canvas-simple-image': colors[1], '--canvas-simple-video': colors[2], '--canvas-simple-audio': colors[3], '--canvas-simple-other': colors[4] };
}
export function simplePaletteColors(values: CanvasPreferences, id = values.simplePaletteId): readonly string[] {
  if (id !== 'theme') return (SIMPLE_PALETTES.find(item => item[0] === id) || SIMPLE_PALETTES[0])[2];
  const base = CANVAS_THEMES.find(item => item[0] === values.themeId)?.[2] || '#111111';
  return [.36,.4,.46,.32,.3,.5].map(amount => mixColor(base, '#ffffff', amount));
}
export function selectedEdgeColor(values: CanvasPreferences) { return values.edgeColorId === 'custom' ? values.customEdgeColor : EDGE_COLORS.find(item => item[0] === values.edgeColorId)?.[2] || '#b6b6bb'; }
