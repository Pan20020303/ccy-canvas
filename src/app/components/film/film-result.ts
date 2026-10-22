import { parseExtractedAssetsResponse, parseStoryboardResponse, type AutomationAsset } from '../../automation-workflow';

// Recover complete records only. Never repair an unfinished string/object with
// invented values, or treat braces and array delimiters inside prompts as JSON.
export function completeArrayPrefix(text: string, key: string): unknown[] {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    const from = i++;
    for (; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') break;
    }
    if (text.slice(from, i + 1) === JSON.stringify(key)) {
      const match = /^\s*:\s*\[/.exec(text.slice(i + 1));
      if (match) { start = i + 1 + match[0].length; break; }
    }
  }
  if (start < 0) return [];
  const records: unknown[] = [];
  let pos = start;
  while (pos < text.length) {
    while (/\s/.test(text[pos] || '') && pos < text.length) pos++;
    if (text[pos] !== '{') break;
    const from = pos;
    let depth = 0, quoted = false, complete = false;
    for (; pos < text.length; pos++) {
      const ch = text[pos];
      if (quoted) { if (ch === '\\') pos++; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        if (--depth === 0) { pos++; complete = true; break; }
      }
    }
    if (!complete) break;
    try { records.push(JSON.parse(text.slice(from, pos))); } catch { break; }
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (text[pos] !== ',') break;
    pos++;
  }
  return records;
}

export function prepareFilmResult(kind: 'extract' | 'split', raw: string, assets: AutomationAsset[]) {
  const parse = (text: string) => kind === 'split' ? parseStoryboardResponse(text, assets) : parseExtractedAssetsResponse(text).filter(a => a.type !== 'audio');
  try {
    const count = parse(raw).length;
    if (!count) throw new Error('模型没有返回可用的完整记录。');
    return { content: raw, count, warning: undefined as string | undefined };
  } catch (originalError) {
    const key = kind === 'split' ? 'shots' : 'assetsList';
    const records = completeArrayPrefix(raw, key);
    if (!records.length) throw originalError;
    const content = JSON.stringify({ [key]: records });
    const count = parse(content).length;
    if (!count) throw originalError;
    return { content, count, warning: `模型输出不完整或被截断，已恢复 ${count} ${kind === 'split' ? '个完整分镜' : '个完整资产'}；未完成的内容未导入。原始返回已缓存，可下载检查。` };
  }
}
