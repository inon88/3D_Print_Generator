const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { exportsSeparateObjects, findMissingReferencedAssets, referencedAssetPaths } = require('../scad-assets.cjs');

test('detects the separate 3MF objects marker only as its own comment line', () => {
  assert.equal(exportsSeparateObjects('// @formforge-3mf-objects\ncube(1);'), true);
  assert.equal(exportsSeparateObjects('cube(1);\n   //@formforge-3mf-objects  (one object per color)\n'), true);
  assert.equal(exportsSeparateObjects('cube(1);'), false);
  assert.equal(exportsSeparateObjects('x = "// @formforge-3mf-objects";'), false);
  assert.equal(exportsSeparateObjects('// see @formforge-3mf-objects-later'), false);
});

test('extracts surface and import paths while ignoring comments', () => {
  const source = `
// surface("commented.png");
/*
  import("also-commented.stl");
*/
surface("surface_image.png", center = true);
import("parts/mesh.stl");
`;

  assert.deepEqual(referencedAssetPaths(source), ['surface_image.png', 'parts/mesh.stl']);
});

test('reports only referenced assets absent from the project folder', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'formforge-assets-'));
  try {
    await fs.writeFile(path.join(directory, 'present.png'), 'asset');
    const missing = await findMissingReferencedAssets(
      'surface("present.png"); surface("surface_image.png");',
      directory
    );

    assert.deepEqual(missing, ['surface_image.png']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
