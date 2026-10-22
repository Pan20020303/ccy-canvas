// 多角度/打光 3D 编辑器(PrecisionStudio)的共享数据与纯函数。
// 单独成文件:CustomNodes 的提示词构建也要用,而 PrecisionStudio 引 three,
// 数据放这里避免把 3D 依赖拖进提示词层。

export type StudioLightKind = 'soft' | 'hard';

export type StudioLight = {
  id: string;
  /** 展示名:主光 / 补光 / 轮廓光 / 灯光 */
  name: string;
  /** 方位角,带符号 -180..180,0=正前方,+90=右侧 */
  azi: number;
  /** 仰角 -10..85 */
  ele: number;
  /** 强度 1..10 */
  intensity: number;
  color: string;
  kind: StudioLightKind;
};

let lightSeq = 0;
export const nextLightId = () => `light-${Date.now()}-${(lightSeq += 1)}`;

export const makeLight = (partial: Omit<StudioLight, 'id'>): StudioLight => ({ id: nextLightId(), ...partial });

export const DEFAULT_KEY_LIGHT: Omit<StudioLight, 'id'> = {
  name: '主光', azi: -30, ele: 30, intensity: 5, color: '#FFFFFF', kind: 'soft',
};

export const defaultLightRig = (): StudioLight[] => [makeLight(DEFAULT_KEY_LIGHT)];

export const normalizeAzi = (azi: number) => {
  let a = azi % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
};

/** HUD 用 0..360 表示(参考图 AZI 330°=左前 30°)。 */
export const aziTo360 = (azi: number) => ((Math.round(azi) % 360) + 360) % 360;

const AZI_WORDS_ZH = ['正前方', '右前方', '右侧', '右后方', '正后方', '左后方', '左侧', '左前方'];
const AZI_WORDS_EN = ['front', 'front-right', 'right', 'back-right', 'back', 'back-left', 'left', 'front-left'];

export function aziToWord(azi: number, zh: boolean) {
  const a = aziTo360(azi);
  const idx = Math.round(a / 45) % 8;
  return (zh ? AZI_WORDS_ZH : AZI_WORDS_EN)[idx];
}

export function eleToWord(ele: number, zh: boolean) {
  if (ele >= 65) return zh ? '顶光' : 'overhead';
  if (ele >= 35) return zh ? '高位' : 'high';
  if (ele >= 12) return zh ? '斜上方' : 'raised';
  if (ele >= -5) return zh ? '平视高度' : 'eye level';
  return zh ? '低位' : 'low';
}

// ─── 布光模板(参考图 18 个)────────────────────────────────────────────────
// 每个模板 = 一组灯 + 提示词氛围短语;选中即整组替换灯光列表。

export type LightRigPreset = {
  id: string;
  labelZh: string;
  labelEn: string;
  /** 交给生成提示词的氛围描述 */
  promptZh: string;
  promptEn: string;
  lights: Array<Omit<StudioLight, 'id'>>;
};

export const LIGHT_RIG_PRESETS: LightRigPreset[] = [
  {
    id: 'three-point', labelZh: '三点布光', labelEn: 'Three-point',
    promptZh: '标准三点布光,主光塑形、补光柔化阴影、轮廓光勾边', promptEn: 'classic three-point lighting: key shapes, fill softens shadows, rim separates the subject',
    lights: [
      { name: '主光', azi: -30, ele: 30, intensity: 6, color: '#FFFFFF', kind: 'soft' },
      { name: '补光', azi: 40, ele: 12, intensity: 3, color: '#FFF2E0', kind: 'soft' },
      { name: '轮廓光', azi: 180, ele: 35, intensity: 5, color: '#FFFFFF', kind: 'hard' },
    ],
  },
  {
    id: 'rembrandt', labelZh: '伦勃朗布光', labelEn: 'Rembrandt',
    promptZh: '伦勃朗布光,单侧主光在暗侧脸颊形成三角光斑,古典油画质感', promptEn: 'Rembrandt lighting with a triangle of light on the shadow cheek, classical painterly feel',
    lights: [
      { name: '主光', azi: -45, ele: 45, intensity: 6, color: '#FFE9C9', kind: 'hard' },
      { name: '补光', azi: 45, ele: 8, intensity: 2, color: '#FFFFFF', kind: 'soft' },
    ],
  },
  {
    id: 'split', labelZh: '分割光', labelEn: 'Split',
    promptZh: '分割光,主光从正侧面打来,脸部一半亮一半暗,强烈戏剧张力', promptEn: 'split lighting from the exact side, half lit half shadow, strong drama',
    lights: [{ name: '主光', azi: -90, ele: 10, intensity: 6, color: '#FFFFFF', kind: 'hard' }],
  },
  {
    id: 'butterfly-drama', labelZh: '顶光戏剧', labelEn: 'Top drama',
    promptZh: '顶光戏剧布光,光从正上方倾泻,眼窝与颧骨下方形成深影', promptEn: 'dramatic top light pouring from above, deep shadows under brows and cheekbones',
    lights: [{ name: '主光', azi: 0, ele: 78, intensity: 7, color: '#FFF6E0', kind: 'hard' }],
  },
  {
    id: 'anime-soft', labelZh: '动漫柔光', labelEn: 'Anime soft',
    promptZh: '动漫感柔光,大面积柔和漫射,粉青双色微渐变,通透干净', promptEn: 'anime-style soft diffuse lighting with subtle pink/cyan gradient, clean and airy',
    lights: [
      { name: '主光', azi: -20, ele: 25, intensity: 5, color: '#FFE9F2', kind: 'soft' },
      { name: '补光', azi: 25, ele: 15, intensity: 4, color: '#E0F2FF', kind: 'soft' },
    ],
  },
  {
    id: 'cyberpunk', labelZh: '赛博朋克', labelEn: 'Cyberpunk',
    promptZh: '赛博朋克霓虹双色,品红与青色对冲硬光,潮湿反光高对比', promptEn: 'cyberpunk dual neon: magenta vs cyan hard light, wet reflections, high contrast',
    lights: [
      { name: '主光', azi: -60, ele: 20, intensity: 6, color: '#FF2E9A', kind: 'hard' },
      { name: '轮廓光', azi: 120, ele: 25, intensity: 6, color: '#22D3EE', kind: 'hard' },
    ],
  },
  {
    id: 'natural', labelZh: '自然光', labelEn: 'Natural',
    promptZh: '自然窗光,柔和方向性日光加环境反射,真实通透', promptEn: 'natural window daylight with soft directionality and ambient bounce, realistic',
    lights: [
      { name: '主光', azi: -40, ele: 50, intensity: 5, color: '#FFF8E7', kind: 'soft' },
      { name: '补光', azi: 40, ele: 20, intensity: 2, color: '#DBEAFE', kind: 'soft' },
    ],
  },
  {
    id: 'golden-hour', labelZh: '黄金时刻', labelEn: 'Golden hour',
    promptZh: '黄金时刻暖阳低角度侧逆光,金色光晕与长影,温暖梦幻', promptEn: 'golden-hour warm sun, low side-back light, golden glow and long shadows',
    lights: [
      { name: '主光', azi: -70, ele: 12, intensity: 6, color: '#FFB347', kind: 'soft' },
      { name: '轮廓光', azi: 150, ele: 18, intensity: 3, color: '#FFD9A0', kind: 'soft' },
    ],
  },
  {
    id: 'blue-hour', labelZh: '蓝调时刻', labelEn: 'Blue hour',
    promptZh: '蓝调时刻,天光冷蓝色包裹,多向柔光,安静清冷氛围', promptEn: 'blue hour: cool blue skylight wrapping from multiple directions, quiet and cold mood',
    lights: [
      { name: '主光', azi: 0, ele: 55, intensity: 5, color: '#A7C7E7', kind: 'soft' },
      { name: '灯光', azi: -45, ele: 0, intensity: 6, color: '#A7C7E7', kind: 'soft' },
      { name: '补光', azi: 90, ele: 0, intensity: 4, color: '#8FB3D9', kind: 'soft' },
      { name: '补光', azi: -90, ele: 0, intensity: 4, color: '#A7C7E7', kind: 'soft' },
      { name: '补光', azi: 180, ele: 10, intensity: 3, color: '#7EA2C9', kind: 'soft' },
    ],
  },
  {
    id: 'high-key', labelZh: '高调光', labelEn: 'High key',
    promptZh: '高调光,明亮均匀几乎无影,白净通透商业感', promptEn: 'high-key bright even lighting, nearly shadowless, clean commercial look',
    lights: [
      { name: '主光', azi: 0, ele: 35, intensity: 7, color: '#FFFFFF', kind: 'soft' },
      { name: '补光', azi: 180, ele: 20, intensity: 5, color: '#FFFFFF', kind: 'soft' },
    ],
  },
  {
    id: 'low-key', labelZh: '低调光', labelEn: 'Low key',
    promptZh: '低调光,大面积暗部,单一窄光源雕刻主体,神秘深沉', promptEn: 'low-key: mostly shadow, one narrow source sculpting the subject, mysterious',
    lights: [{ name: '主光', azi: -60, ele: 25, intensity: 4, color: '#FFFFFF', kind: 'hard' }],
  },
  {
    id: 'rim', labelZh: '轮廓光', labelEn: 'Rim light',
    promptZh: '强轮廓光从背后勾出发丝与肩线,主体与背景强分离', promptEn: 'strong rim light from behind outlining hair and shoulders, subject pops from background',
    lights: [
      { name: '轮廓光', azi: 180, ele: 30, intensity: 7, color: '#FFFFFF', kind: 'hard' },
      { name: '补光', azi: 0, ele: 10, intensity: 1, color: '#FFFFFF', kind: 'soft' },
    ],
  },
  {
    id: 'silhouette', labelZh: '剪影', labelEn: 'Silhouette',
    promptZh: '剪影,主体正后方强光,主体压成黑色轮廓,背景明亮', promptEn: 'silhouette: strong light directly behind, subject reduced to a dark outline against bright background',
    lights: [{ name: '主光', azi: 180, ele: 15, intensity: 8, color: '#FFF3D6', kind: 'hard' }],
  },
  {
    id: 'neon', labelZh: '霓虹灯', labelEn: 'Neon',
    promptZh: '霓虹灯氛围,多彩灯管光源混合,粉紫青交织,夜店质感', promptEn: 'neon sign ambience: mixed colorful tube lights, pink/purple/cyan interplay, nightlife feel',
    lights: [
      { name: '主光', azi: -80, ele: 15, intensity: 6, color: '#FF3D81', kind: 'hard' },
      { name: '灯光', azi: 80, ele: 20, intensity: 6, color: '#00E5FF', kind: 'hard' },
      { name: '补光', azi: 180, ele: 40, intensity: 3, color: '#9D4EDD', kind: 'soft' },
    ],
  },
  {
    id: 'practical', labelZh: '实景光', labelEn: 'Practical',
    promptZh: '实景现场光,保留环境原有光源方向与色温,真实自然', promptEn: 'practical on-location light, keeping the scene’s own source direction and color temperature',
    lights: [{ name: '主光', azi: -40, ele: 40, intensity: 5, color: '#FFF4DE', kind: 'soft' }],
  },
  {
    id: 'chiaroscuro', labelZh: '明暗对比', labelEn: 'Chiaroscuro',
    promptZh: '明暗对比强烈的卡拉瓦乔式布光,亮部锐利暗部深邃', promptEn: 'chiaroscuro Caravaggio-style lighting, crisp highlights and deep blacks',
    lights: [
      { name: '主光', azi: -75, ele: 35, intensity: 7, color: '#FFFFFF', kind: 'hard' },
      { name: '补光', azi: 105, ele: 5, intensity: 1, color: '#FFFFFF', kind: 'soft' },
    ],
  },
  {
    id: 'campfire', labelZh: '篝火光', labelEn: 'Campfire',
    promptZh: '篝火光,低位暖橙色跳动光源从下前方打亮,夜色包围', promptEn: 'campfire glow: low warm orange flickering light from below-front, surrounded by night',
    lights: [
      { name: '主光', azi: 20, ele: -5, intensity: 6, color: '#FF9E3D', kind: 'soft' },
      { name: '补光', azi: -20, ele: 5, intensity: 4, color: '#FF6A1F', kind: 'soft' },
    ],
  },
  {
    id: 'moonlit', labelZh: '月夜神秘', labelEn: 'Moonlit',
    promptZh: '月夜冷光,高位冷蓝月光洒落,暗部朦胧,神秘静谧', promptEn: 'moonlit night: high cool-blue moonlight, hazy shadows, mysterious stillness',
    lights: [
      { name: '主光', azi: -160, ele: 45, intensity: 4, color: '#BFD7EA', kind: 'soft' },
      { name: '补光', azi: 20, ele: 10, intensity: 2, color: '#7EA2C9', kind: 'soft' },
    ],
  },
];

// ─── 调色板(参考图两排色票)───────────────────────────────────────────────

export const LIGHT_PALETTE: string[] = [
  '#D99A4E', '#C8A17A', '#D9B23D', '#E3C84B', '#B5533C', '#C9A227', '#FFFFFF', '#9CA3AF', '#7C8CA3',
  '#8195AD', '#A7C7E7', '#9FB8C4', '#3730A3', '#C2409A', '#7C3AED', '#22B8CF', '#3FA34D', '#E2711D',
];

// ─── 多角度机位模板 ──────────────────────────────────────────────────────────

export const ANGLE_STUDIO_PRESETS = [
  { id: 'custom', labelZh: '自定义', labelEn: 'Custom', yaw: 0, pitch: 0, zoom: 50 },
  { id: 'front', labelZh: '正面俯拍', labelEn: 'Front top', yaw: 0, pitch: 28, zoom: 48 },
  { id: 'front-low', labelZh: '正面仰拍', labelEn: 'Front low', yaw: 0, pitch: -24, zoom: 48 },
  { id: 'left', labelZh: '左侧视角', labelEn: 'Left side', yaw: -90, pitch: 0, zoom: 50 },
  { id: 'right', labelZh: '右侧视角', labelEn: 'Right side', yaw: 90, pitch: 0, zoom: 50 },
  { id: 'back', labelZh: '背面视角', labelEn: 'Back', yaw: 180, pitch: 0, zoom: 50 },
  { id: 'top-down', labelZh: '顶部俯瞰', labelEn: 'Top down', yaw: 0, pitch: 55, zoom: 40 },
  { id: 'eye-level', labelZh: '鱼眼视角', labelEn: 'Fisheye', yaw: -18, pitch: 8, zoom: 35 },
  { id: 'tilted', labelZh: '倾斜视角', labelEn: 'Tilted', yaw: 22, pitch: -12, zoom: 55 },
  { id: 'panorama-top', labelZh: '全景俯拍', labelEn: 'Pan top', yaw: 0, pitch: 42, zoom: 22 },
  { id: 'closeup', labelZh: '微距特写', labelEn: 'Close-up', yaw: 0, pitch: 4, zoom: 88 },
] as const;

export const clampStudio = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
