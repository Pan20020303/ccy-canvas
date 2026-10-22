// Mechanical, reproducible excerpts. Vendor files stay byte-for-byte unchanged.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../resources/creative-workbench/', import.meta.url));
const catalog = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8'));
const checksums = JSON.parse(await readFile(path.join(root, `v${catalog.version}/SHA256SUMS.json`), 'utf8'));
const checkOnly = process.argv.includes('--check');
if (!checkOnly) await mkdir(path.join(root, 'modules'), { recursive: true });
for (const doc of catalog.documents) {
  const source = await readFile(path.join(root, `v${catalog.version}/skills`, doc.path));
  const hash = createHash('sha256').update(source).digest('hex');
  if (hash !== checksums[`skills/${doc.path}`]) throw new Error(`Source changed: ${doc.path}`);
  const text = source.toString('utf8').replace(/\r\n/g, '\n');
  // Only H2 headings outside code fences delimit a section; preserve complete examples/tables.
  const sections = new Map(); let heading = '', lines = [], fence = '';
  const flush = () => { if (heading) sections.set(heading, lines.join('\n').trim()); };
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = ''; }
    if (!fence && line.startsWith('## ')) { flush(); heading = line.slice(3).trim(); lines = []; }
    lines.push(line);
  }
  flush();
  const body = doc.sections ? doc.sections.map(title => {
    if (!sections.has(title)) throw new Error(`Missing section ${doc.path}: ${title}`);
    return sections.get(title);
  }).join('\n\n') : text.trim();
  const result = `<!-- Source: v${catalog.version}/skills/${doc.path}; sha256:${hash}; excerpt only -->\n${body}\n`;
  const destination = path.join(root, 'modules', `${doc.id}.md`);
  if (checkOnly) {
    if (await readFile(destination, 'utf8') !== result) throw new Error(`Stale excerpt: ${doc.id}`);
  } else await writeFile(destination, result, 'utf8');
  console.log(`${doc.id}: ${body.length} characters`);
}
