// Icon library: icon packs are folders of SVG files inside one root folder
// (userData/icon-packs). Each top-level folder is a pack, its sub-folders are kept in the
// icon path (useful as categories), and SVG files directly in the root form "Loose icons".
// Hidden entries and symbolic links are skipped; reads are confined to the root folder.
const fs = require('node:fs/promises');
const path = require('node:path');

const ICON_LIMITS = Object.freeze({ maxIcons: 50000, maxDepth: 8, maxBytes: 1024 * 1024 });
// The pack name used for SVG files placed directly in the root folder.
const LOOSE_PACK = '';

function iconName(fileName) {
  return fileName.replace(/\.svg$/i, '').replace(/[-_.]+/g, ' ').trim();
}

const byName = (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });

async function indexIconPacks(root) {
  await fs.mkdir(root, { recursive: true });
  const icons = [];
  const counts = new Map();
  let truncated = false;

  const add = (pack, relativePath, fileName) => {
    if (icons.length >= ICON_LIMITS.maxIcons) { truncated = true; return; }
    icons.push({ pack, path: relativePath, name: iconName(fileName) });
    counts.set(pack, (counts.get(pack) || 0) + 1);
  };

  async function walk(pack, directory, relative, depth) {
    if (depth > ICON_LIMITS.maxDepth || truncated) return;
    let entries;
    try { entries = (await fs.readdir(directory, { withFileTypes: true })).sort(byName); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(pack, path.join(directory, entry.name), relativePath, depth + 1);
      else if (entry.isFile() && /\.svg$/i.test(entry.name)) add(pack, relativePath, entry.name);
    }
  }

  const top = (await fs.readdir(root, { withFileTypes: true })).sort(byName);
  for (const entry of top) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(entry.name, path.join(root, entry.name), '', 0);
    else if (entry.isFile() && /\.svg$/i.test(entry.name)) add(LOOSE_PACK, entry.name, entry.name);
  }
  const packs = [...counts].map(([name, count]) => ({ name, count }));
  return { root, packs, icons, truncated };
}

// Resolves a pack-relative icon path inside root, rejecting anything that could leave it.
function resolveIconPath(root, pack, relativePath) {
  if (typeof pack !== 'string' || typeof relativePath !== 'string'
    || /[\\/:]/.test(pack) || pack === '.' || pack === '..' || pack.startsWith('.')) {
    throw new Error('That icon is not in the icon library.');
  }
  const segments = relativePath.split('/');
  if (!/\.svg$/i.test(relativePath) || relativePath.includes('\\') || relativePath.includes(':')
    || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))
    || (pack === LOOSE_PACK && segments.length !== 1)) {
    throw new Error('That icon is not in the icon library.');
  }
  const base = path.resolve(root, pack);
  const full = path.resolve(base, ...segments);
  if (!full.startsWith(base + path.sep)) throw new Error('That icon is not in the icon library.');
  return full;
}

async function readIcon(root, pack, relativePath) {
  const full = resolveIconPath(root, pack, relativePath);
  const stat = await fs.lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That icon is not in the icon library.');
  if (stat.size > ICON_LIMITS.maxBytes) throw new Error('That icon file is larger than 1 MB.');
  const svg = await fs.readFile(full, 'utf8');
  if (!/<svg(?:\s|>)/i.test(svg)) throw new Error('That file is not an SVG image.');
  return svg;
}

module.exports = { ICON_LIMITS, LOOSE_PACK, indexIconPacks, resolveIconPath, readIcon };
