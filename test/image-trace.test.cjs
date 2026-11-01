const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTraceRequest, buildLayeredSvg, traceImage, TRACE_LIMITS } = require('../image-trace.cjs');

function rgbaImage(width, height, pixelAt) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(pixelAt(x, y), (y * width + x) * 4);
    }
  }
  return pixels;
}

// White background, red disc, blue bar, black stripes (anti-aliasing is not needed for vtracer).
function logo(x, y) {
  if (Math.hypot(x - 50, y - 50) < 32) return [220, 30, 40, 255];
  if (x > 100 && x < 180 && y > 20 && y < 50) return [30, 90, 210, 255];
  if (x > 100 && x < 180 && y > 60 && y < 85 && Math.floor((x - 100) / 10) % 2 === 0) return [20, 20, 20, 255];
  return [255, 255, 255, 255];
}

test('validates trace requests', () => {
  const pixels = new Uint8Array(4 * 4 * 4);
  assert.deepEqual(validateTraceRequest(pixels.buffer, 4, 4, { maxColors: 3, removeBackground: true }).width, 4);
  assert.throws(() => validateTraceRequest(pixels, 5, 4, { maxColors: 3, removeBackground: true }), /could not be read/);
  assert.throws(() => validateTraceRequest(pixels, 4, 4, { maxColors: 1, removeBackground: true }), /Auto or between 2 and 12/);
  assert.throws(() => validateTraceRequest(pixels, 4, 4, { maxColors: 13, removeBackground: true }), /Auto or between 2 and 12/);
  assert.equal(validateTraceRequest(pixels, 4, 4, { maxColors: 0, removeBackground: true }).maxColors, 0);
  assert.equal(validateTraceRequest(pixels, 4, 4, { maxColors: 3, removeBackground: true }).detail, 'medium');
  assert.throws(() => validateTraceRequest(pixels, 4, 4, { maxColors: 3, removeBackground: true, detail: 'ultra' }), /detail level/);
  assert.throws(() => validateTraceRequest(pixels, 4, 4, { maxColors: 3, removeBackground: 'yes' }), /background/);
  assert.throws(() => validateTraceRequest('pixels', 4, 4, { maxColors: 3, removeBackground: true }), /could not be read/);
  const huge = TRACE_LIMITS.maxPixels + 1;
  assert.throws(() => validateTraceRequest(new Uint8Array(huge * 4), huge, 1, { maxColors: 3, removeBackground: true }), /could not be read/);
});

test('groups paths by color, merges near-identical colors, and drops the background', () => {
  const pixels = rgbaImage(10, 10, (x, y) => (x > 2 && x < 7 && y > 2 && y < 7 ? [200, 0, 0, 255] : [255, 255, 255, 255]));
  const raw = '<svg><path d="M0 0L10 0L10 10L0 10Z" fill="#FFFFFF"/>'
    + '<path d="M3 3L7 3L7 7L3 7Z" fill="#C80000" transform="translate(1,1)"/>'
    + '<path d="M4 4L5 4L5 5Z" fill="#C30505"/></svg>';
  const { svg, colors } = buildLayeredSvg(raw, pixels, 10, 10, { maxColors: 4, removeBackground: true });

  assert.deepEqual(colors, ['#C80000']);
  assert.match(svg, /width="100\.000mm" height="100\.000mm" viewBox="0 0 10 10"/);
  assert.match(svg, /<g id="c0" fill="#C80000"><path d="M3 3L7 3L7 7L3 7Z" transform="translate\(1,1\)"\/><path d="M4 4L5 4L5 5Z"\/><\/g>/);
  assert.doesNotMatch(svg, /#FFFFFF/);
});

test('keeps the background when requested and merges extra colors instead of dropping them', () => {
  const pixels = rgbaImage(10, 10, (x) => (x < 4 ? [255, 255, 255, 255] : x < 7 ? [0, 0, 255, 255] : [0, 0, 200, 255]));
  const raw = '<svg><path d="M0 0Z" fill="#FFFFFF"/><path d="M4 0Z" fill="#0000FF"/><path d="M7 0Z" fill="#0000C8"/></svg>';
  const { svg, colors } = buildLayeredSvg(raw, pixels, 10, 10, { maxColors: 2, removeBackground: false });

  assert.equal(colors.length, 2);
  assert.equal((svg.match(/<path/g) || []).length, 3);
});

test('reports images that contain only background', () => {
  const pixels = rgbaImage(4, 4, () => [255, 255, 255, 255]);
  assert.throws(() => buildLayeredSvg('<svg><path d="M0 0Z" fill="#FFFFFF"/></svg>', pixels, 4, 4, { maxColors: 3, removeBackground: true }), /Only background/);
  assert.throws(() => buildLayeredSvg('<svg></svg>', pixels, 4, 4, { maxColors: 3, removeBackground: true }), /No shapes/);
});

test('traces a color logo with vtracer into one layer per color', () => {
  const width = 200;
  const height = 100;
  const { svg, colors } = traceImage({ rgba: rgbaImage(width, height, logo), width, height, maxColors: 4, removeBackground: true });

  assert.deepEqual([...colors].sort(), ['#141414', '#1E5AD2', '#DC1E28']);
  assert.match(svg, /width="100\.000mm" height="50\.000mm"/);
  for (let index = 0; index < colors.length; index++) assert.match(svg, new RegExp(`<g id="c${index}" fill="${colors[index]}"><path `));
});

test('automatic palette keeps distinct colors, folds shades, and reports areas', () => {
  const width = 200;
  const height = 100;
  // Two shades of blue (distance ~35) next to red and black on white.
  const pixels = rgbaImage(width, height, (x, y) => {
    if (x > 110 && x < 140 && y > 20 && y < 50) return [40, 100, 220, 255];
    return logo(x, y);
  });
  const auto = traceImage({ rgba: pixels, width, height, maxColors: 0, removeBackground: true, detail: 'high' });
  assert.deepEqual([...auto.colors].sort(), ['#141414', '#1E5AD2', '#DC1E28']);
  assert.equal(Math.round(auto.areas.reduce((sum, value) => sum + value, 0) * 1000), 1000);
  assert.ok(auto.areas.every((value, index) => index === 0 || value <= auto.areas[index - 1]), 'layers are ordered by area');
});

test('treats transparent pixels as background', () => {
  const pixels = rgbaImage(120, 80, (x, y) => (Math.hypot(x - 60, y - 40) < 25 ? [20, 160, 60, 255] : [0, 0, 0, 0]));
  const { colors } = traceImage({ rgba: pixels, width: 120, height: 80, maxColors: 3, removeBackground: true });
  assert.deepEqual(colors, ['#14A03C']);
});
