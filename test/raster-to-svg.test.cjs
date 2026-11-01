const test = require('node:test');
const assert = require('node:assert/strict');
const { rasterToSvg } = require('../raster-to-svg.cjs');

function rgbaImage(width, height, pixelAt) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(pixelAt(x, y), (y * width + x) * 4);
    }
  }
  return pixels;
}

test('traces a high-contrast raster icon into a closed SVG path', () => {
  const pixels = rgbaImage(5, 5, (x, y) =>
    x >= 1 && x <= 3 && y >= 1 && y <= 3 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const svg = rasterToSvg(5, 5, pixels);

  assert.match(svg, /<svg[^>]+viewBox="0 0 100 100"/);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /<path[^>]+d="M/);
  assert.match(svg, /Z"/);
});

test('preserves holes in transparent raster icons', () => {
  const pixels = rgbaImage(7, 7, (x, y) =>
    x >= 1 && x <= 5 && y >= 1 && y <= 5 && !(x >= 3 && x <= 4 && y >= 3 && y <= 4)
      ? [10, 10, 10, 255] : [0, 0, 0, 0]);
  const svg = rasterToSvg(7, 7, pixels);

  assert.equal((svg.match(/M/g) || []).length, 2);
});

test('rejects an image with no detectable icon shape', () => {
  const pixels = rgbaImage(4, 4, () => [255, 255, 255, 255]);
  assert.throws(() => rasterToSvg(4, 4, pixels), /No clear icon shape/);
});
