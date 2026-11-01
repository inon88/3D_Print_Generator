const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { prepareHeightmap, encodeGrayPng, validateHeightmapPng } = require('../heightmap.cjs');

function rgbaImage(width, height, pixelAt) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(pixelAt(x, y), (y * width + x) * 4);
  return pixels;
}

test('adds a black border and maps brightness to gray', () => {
  const pixels = rgbaImage(3, 2, x => [x * 127, x * 127, x * 127, 255]);
  const map = prepareHeightmap(pixels, 3, 2, { autoLevels: false });
  assert.equal(map.width, 5);
  assert.equal(map.height, 4);
  // Border is black, inside follows the brightness 0, 127, 254.
  assert.deepEqual([...map.gray.subarray(0, 5)], [0, 0, 0, 0, 0]);
  assert.deepEqual([...map.gray.subarray(5, 10)], [0, 0, 127, 254, 0]);
});

test('auto levels stretch the range, invert swaps it, transparent pixels are lowest', () => {
  const pixels = rgbaImage(10, 10, x => [100 + x * 5, 100 + x * 5, 100 + x * 5, x === 0 ? 0 : 255]);
  const leveled = prepareHeightmap(pixels, 10, 10, { autoLevels: true });
  const row = [...leveled.gray.subarray(12 + 1, 12 + 11)];
  assert.equal(row[0], 0, 'transparent pixel is black');
  assert.equal(Math.max(...row), 255, 'brightest pixel reaches white');
  const inverted = prepareHeightmap(pixels, 10, 10, { autoLevels: false, invert: true });
  const invertedRow = [...inverted.gray.subarray(12 + 1, 12 + 11)];
  assert.ok(invertedRow[1] > invertedRow[9], 'darker pixels are higher when inverted');
  assert.throws(() => prepareHeightmap(pixels, 9, 10), /could not be read/);
});

test('gamma below 1 lifts the mid tones', () => {
  const pixels = rgbaImage(1, 1, () => [128, 128, 128, 255]);
  const linear = prepareHeightmap(pixels, 1, 1, { autoLevels: false, gamma: 1 }).gray[4];
  const lifted = prepareHeightmap(pixels, 1, 1, { autoLevels: false, gamma: 0.6 }).gray[4];
  assert.ok(lifted > linear);
});

test('encodes a valid grayscale PNG that decodes to the same pixels', () => {
  const map = prepareHeightmap(rgbaImage(300, 250, (x, y) => [(x + y) % 256, (x + y) % 256, (x + y) % 256, 255]), 300, 250, { autoLevels: false });
  const png = encodeGrayPng(map);
  const { width, height } = validateHeightmapPng(png);
  assert.deepEqual([width, height], [302, 252]);
  // Read the IDAT back with zlib and compare the scanlines.
  const idatLength = (png[33] << 24 | png[34] << 16 | png[35] << 8 | png[36]) >>> 0;
  const raw = zlib.inflateSync(Buffer.from(png.subarray(41, 41 + idatLength)));
  for (let y = 0; y < height; y += 37) {
    assert.equal(raw[y * (width + 1)], 0, 'filter byte');
    assert.deepEqual([...raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1))], [...map.gray.subarray(y * width, (y + 1) * width)]);
  }
});

test('rejects images that are not suitable heightmap PNGs', () => {
  const good = encodeGrayPng(prepareHeightmap(rgbaImage(20, 20, () => [9, 9, 9, 255]), 20, 20));
  assert.ok(validateHeightmapPng(good));
  assert.throws(() => validateHeightmapPng(new Uint8Array(40)), /could not be saved/);
  const rgb = Uint8Array.from(good); rgb[25] = 2;            // color type RGB
  assert.throws(() => validateHeightmapPng(rgb), /could not be saved/);
  const huge = encodeGrayPng(prepareHeightmap(rgbaImage(700, 8, () => [1, 1, 1, 255]), 700, 8));
  assert.throws(() => validateHeightmapPng(huge), /could not be saved/);
  assert.throws(() => validateHeightmapPng('png'), /could not be saved/);
});
