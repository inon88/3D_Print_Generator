const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { indexIconPacks, readIcon, resolveIconPath, LOOSE_PACK } = require('../icon-library.cjs');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>';

async function withLibrary(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'formforge-icons-'));
  try {
    await fs.mkdir(path.join(root, 'Tabler', 'filled'), { recursive: true });
    await fs.mkdir(path.join(root, 'Game icons'), { recursive: true });
    await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
    await fs.writeFile(path.join(root, 'Tabler', 'filled', 'heart-filled.svg'), svg);
    await fs.writeFile(path.join(root, 'Tabler', 'star.svg'), svg);
    await fs.writeFile(path.join(root, 'Tabler', 'readme.txt'), 'not an icon');
    await fs.writeFile(path.join(root, 'Tabler', '.secret.svg'), svg);
    await fs.writeFile(path.join(root, 'Game icons', 'dragon_head.svg'), svg);
    await fs.writeFile(path.join(root, '.hidden', 'x.svg'), svg);
    await fs.writeFile(path.join(root, 'my-logo.svg'), svg);
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('indexes packs, categories, and loose icons while skipping hidden and non-SVG files', async () => {
  await withLibrary(async root => {
    const index = await indexIconPacks(root);
    assert.deepEqual(index.packs, [{ name: 'Game icons', count: 1 }, { name: LOOSE_PACK, count: 1 }, { name: 'Tabler', count: 2 }]);
    assert.deepEqual(index.icons.map(icon => `${icon.pack}|${icon.path}|${icon.name}`).sort(), [
      '|my-logo.svg|my logo',
      'Game icons|dragon_head.svg|dragon head',
      'Tabler|filled/heart-filled.svg|heart filled',
      'Tabler|star.svg|star'
    ].sort());
    assert.equal(index.truncated, false);
  });
});

test('creates the library folder when it does not exist yet', async () => {
  const root = path.join(os.tmpdir(), `formforge-icons-new-${process.pid}-${Date.now()}`);
  try {
    const index = await indexIconPacks(root);
    assert.deepEqual(index.packs, []);
    assert.ok((await fs.stat(root)).isDirectory());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reads icons and rejects paths that leave the library', async () => {
  await withLibrary(async root => {
    assert.equal(await readIcon(root, 'Tabler', 'filled/heart-filled.svg'), svg);
    assert.equal(await readIcon(root, LOOSE_PACK, 'my-logo.svg'), svg);
    for (const [pack, relative] of [
      ['Tabler', '../Game icons/dragon_head.svg'], ['..', 'x.svg'], ['Tabler', 'filled\\heart-filled.svg'],
      ['Tabler', '/etc/passwd.svg'], ['Tabler', 'readme.txt'], ['.hidden', 'x.svg'], ['Tabler', '.secret.svg'],
      ['Tabler', 'C:/x.svg'], [LOOSE_PACK, 'Tabler/star.svg'], ['Ta/bler', 'star.svg'], [42, 'star.svg']
    ]) {
      assert.throws(() => resolveIconPath(root, pack, relative), /not in the icon library/, `${pack} ${relative}`);
    }
  });
});

test('rejects files that are not SVG images or are too large', async () => {
  await withLibrary(async root => {
    await fs.writeFile(path.join(root, 'Tabler', 'fake.svg'), 'hello');
    await assert.rejects(readIcon(root, 'Tabler', 'fake.svg'), /not an SVG/);
    await fs.writeFile(path.join(root, 'Tabler', 'huge.svg'), '<svg>' + ' '.repeat(1024 * 1024 + 10) + '</svg>');
    await assert.rejects(readIcon(root, 'Tabler', 'huge.svg'), /larger than 1 MB/);
  });
});
