const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  LITHOPHANE_PARAMETERS, LITHOPHANE_SHAPES, lithophaneManifest, buildLithophaneMesh, meshToStl, threeMfEntries,
  cropBorder, distanceTransform
} = require('../lithophane.cjs');
const { prepareHeightmap, encodeGrayPng, decodeGrayPng } = require('../heightmap.cjs');

function solidImage(width, height, value) {
  return { width, height, gray: new Uint8Array(width * height).fill(value) };
}

function gradientImage(width, height) {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = Math.round(255 * x / (width - 1));
  return { width, height, gray };
}

// Closed and consistently oriented: every directed edge once, and its reverse once.
function checkClosed({ positions, indices }) {
  const edges = new Map();
  const vertexCount = positions.length / 3;
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k], b = indices[t + (k + 1) % 3];
      assert.ok(a < vertexCount && b < vertexCount, 'index in range');
      assert.notEqual(a, b, 'no degenerate triangle');
      const key = a * vertexCount + b;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    assert.equal(count, 1, 'directed edge used once');
    const a = Math.floor(key / vertexCount), b = key % vertexCount;
    assert.equal(edges.get(b * vertexCount + a), 1, 'every edge has a twin');
  }
}

function volume({ positions: p, indices }) {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    sum += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

function bounds({ positions }) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[i + a]); max[a] = Math.max(max[a], positions[i + a]); }
  }
  return { min, max };
}

test('every shape gives a closed, outward-facing mesh (with and without frame/hanger)', () => {
  const image = gradientImage(120, 80);
  for (const shape of LITHOPHANE_SHAPES) {
    for (const frame_mm of [0, 3]) {
      const values = { shape, frame_mm, hanger: true, size_mm: 60, resolution_mm: 0.5 };
      const mesh = buildLithophaneMesh(image, values, { preview: true });
      checkClosed(mesh);
      assert.ok(volume(mesh) > 0, `${shape} frame ${frame_mm}: positive volume`);
    }
  }
  for (const light_hole_mm of [0, 30]) {
    const mesh = buildLithophaneMesh(image, { shape: 'Sphere', light_hole_mm, size_mm: 60, resolution_mm: 0.5 }, { preview: true });
    checkClosed(mesh);
    assert.ok(volume(mesh) > 0);
  }
});

test('flat: dark is thick, light is thin, size follows the image', () => {
  const base = { shape: 'Flat', frame_mm: 0, hanger: false, size_mm: 100, max_thickness_mm: 3, min_thickness_mm: 0.8, resolution_mm: 0.5 };
  const white = bounds(buildLithophaneMesh(solidImage(200, 100, 255), base));
  assert.ok(Math.abs(white.max[2] - 0.8) < 1e-4, 'white → min thickness');
  assert.ok(Math.abs(white.min[2]) < 1e-6);
  assert.ok(Math.abs(white.max[0] - 50) < 1e-3 && Math.abs(white.min[1] + 25) < 1e-3, 'width 100, height 50');
  const black = bounds(buildLithophaneMesh(solidImage(200, 100, 0), base));
  assert.ok(Math.abs(black.max[2] - 3) < 1e-4, 'black → max thickness');
  const negative = bounds(buildLithophaneMesh(solidImage(200, 100, 255), { ...base, image_mode: 'Negative' }));
  assert.ok(Math.abs(negative.max[2] - 3) < 1e-4, 'negative: white → max thickness');
});

test('flat: frame and hanger are solid at the frame thickness and enlarge the outline', () => {
  const values = { shape: 'Flat', frame_mm: 4, frame_thickness_mm: 5, hanger: true, hanger_diameter_mm: 10, size_mm: 100, resolution_mm: 0.5 };
  const box = bounds(buildLithophaneMesh(solidImage(200, 100, 255), values));
  assert.ok(Math.abs(box.max[2] - 5) < 1e-4);
  assert.ok(box.max[0] >= 53.5 && box.max[0] <= 55, 'frame adds 4 mm per side');
  assert.ok(box.max[1] > 25 + 4 + 5, 'hanger above the frame');
});

test('upright shapes stand on z = 0 with the requested height or diameter', () => {
  const image = gradientImage(300, 100);
  const cylinder = bounds(buildLithophaneMesh(image, { shape: 'Cylinder', size_mm: 80, frame_mm: 0, resolution_mm: 0.5 }));
  assert.ok(Math.abs(cylinder.min[2]) < 1e-4 && Math.abs(cylinder.max[2] - 80) < 1e-3, 'cylinder height = size');
  const radius = 80 * 3 / (2 * Math.PI);
  assert.ok(cylinder.max[0] > radius && cylinder.max[0] < radius + 3.01, 'cylinder radius from the image aspect');
  const sphere = bounds(buildLithophaneMesh(image, { shape: 'Sphere', size_mm: 80, light_hole_mm: 0, resolution_mm: 1 }));
  assert.ok(Math.abs(sphere.min[2]) < 1e-3 && sphere.max[2] > 80 && sphere.max[2] < 86.1, 'closed sphere');
  const box = bounds(buildLithophaneMesh(image, { shape: 'Box', size_mm: 60, frame_mm: 0, resolution_mm: 0.5 }));
  assert.ok(box.max[0] >= 22.5 && box.max[0] <= 22.5 + 3.01, 'box side = perimeter / 4');
});

test('preview shows the export grid unless the piece is very large', () => {
  const image = gradientImage(400, 300);
  const values = { size_mm: 100, resolution_mm: 0.2, frame_mm: 0, hanger: false };
  const fine = buildLithophaneMesh(image, values);
  const preview = buildLithophaneMesh(image, values, { preview: true });
  assert.equal(fine.info.columns, 500);
  assert.equal(preview.info.columns, 500, 'same detail as the export');
  const large = { size_mm: 250, resolution_mm: 0.1, frame_mm: 0, hanger: false };
  const bigExport = buildLithophaneMesh(image, large);
  const bigPreview = buildLithophaneMesh(image, large, { preview: true });
  assert.ok(bigExport.info.columns * bigExport.info.rows <= 500 * 1000 * 1.01);
  assert.ok(bigPreview.info.columns * bigPreview.info.rows <= 200 * 1000 * 1.01);
  assert.ok(bigPreview.info.columns < bigExport.info.columns);
});

test('outlines are smoothed within the grid cell, straight edges stay exact', () => {
  const image = solidImage(200, 200, 128);
  const circle = buildLithophaneMesh(image, { shape: 'Circle', size_mm: 100, frame_mm: 0, hanger: false, resolution_mm: 0.5 });
  checkClosed(circle);
  // The rim (farthest vertex in every 1° direction) lies close to the true circle of radius 50;
  // without smoothing the stair corners stray by up to half a cell diagonal (0.35 mm here).
  const rim = new Float64Array(360);
  for (let i = 0; i < circle.positions.length; i += 3) {
    const x = circle.positions[i], y = circle.positions[i + 1];
    const bin = Math.floor((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
    rim[bin] = Math.max(rim[bin], Math.hypot(x, y));
  }
  const worst = Math.max(...Array.from(rim, r => Math.abs(r - 50)));
  assert.ok(worst < 0.2, `rim within 0.2 mm of the circle (worst ${worst.toFixed(3)})`);
  const flat = bounds(buildLithophaneMesh(image, { shape: 'Flat', size_mm: 100, frame_mm: 0, hanger: false, resolution_mm: 0.5 }));
  assert.ok(Math.abs(flat.max[0] - 50) < 1e-4 && Math.abs(flat.min[1] + 50) < 1e-4);
});

test('STL and 3MF writers', () => {
  const mesh = buildLithophaneMesh(gradientImage(40, 30), { size_mm: 40, resolution_mm: 1 });
  const stl = meshToStl(mesh);
  const view = new DataView(stl.buffer);
  assert.equal(view.getUint32(80, true), mesh.indices.length / 3);
  assert.equal(stl.length, 84 + 50 * mesh.indices.length / 3);
  const entries = threeMfEntries(mesh, { name: 'A & B', color: 'Ivory' });
  assert.deepEqual(entries.map(entry => entry.name), ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
  const xml = entries[2].parts.join('');
  assert.match(xml, /name="A &amp; B"/);
  assert.match(xml, /displaycolor="#FFFFF0FF"/);
  assert.equal((xml.match(/<vertex /g) || []).length, mesh.positions.length / 3);
  assert.equal((xml.match(/<triangle /g) || []).length, mesh.indices.length / 3);
});

test('height map PNG round trip and border crop', () => {
  const rgba = new Uint8Array(30 * 20 * 4);
  for (let i = 0; i < 600; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = i % 256; rgba[i * 4 + 3] = 255; }
  const map = prepareHeightmap(rgba, 30, 20, { autoLevels: false });
  const decoded = decodeGrayPng(encodeGrayPng(map), bytes => zlib.inflateSync(bytes));
  assert.equal(decoded.width, 32);
  assert.deepEqual(Array.from(decoded.gray), Array.from(map.gray));
  const cropped = cropBorder(decoded);
  assert.equal(cropped.width, 30);
  assert.equal(cropped.gray[0], map.gray[33]);
  // Rows written with every PNG filter type (other encoders use them).
  const size = 9;
  const gray = Uint8Array.from({ length: size * size }, (_, i) => (i * 37 + (i >> 3) * 11) & 255);
  const raw = [];
  for (let y = 0; y < size; y++) {
    const filter = y % 5;
    raw.push(filter);
    for (let x = 0; x < size; x++) {
      const v = gray[y * size + x], a = x ? gray[y * size + x - 1] : 0, b = y ? gray[(y - 1) * size + x] : 0, c = x && y ? gray[(y - 1) * size + x - 1] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      raw.push((v - predictor) & 255);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
  const filtered = decodeGrayPng(new Uint8Array(png), bytes => zlib.inflateSync(bytes));
  assert.deepEqual(Array.from(filtered.gray), Array.from(gray));
});

test('distance transform and generator manifest', () => {
  const set = new Uint8Array(25); set[12] = 1;
  const distance = distanceTransform(set, 5, 5);
  assert.equal(distance[12], 0);
  assert.equal(distance[0], Math.SQRT2 * 2);
  const manifest = lithophaneManifest('2026-11-03T00:00:00.000Z');
  assert.equal(manifest.kind, 'generator');
  assert.equal(manifest.parameters.length, LITHOPHANE_PARAMETERS.length);
  for (const item of manifest.parameters) {
    if (item.type === 'number') assert.ok(item.default >= item.min && item.default <= item.max, item.name);
    if (item.options) assert.ok(item.options.includes(item.default), item.name);
  }
});

test('photo position: offset, zoom, rotation, fill outside, and the viewport item', () => {
  // Black square marker in the top-left corner of a white photo.
  const width = 100, height = 100, gray = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) gray[y * width + x] = 0;
  const image = { width, height, gray };
  const base = { shape: 'Flat', size_mm: 100, frame_mm: 0, hanger: false, resolution_mm: 1, max_thickness_mm: 3, min_thickness_mm: 0.8 };
  const thickAt = (mesh, x, y) => {
    let best = null, distance = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const d = Math.hypot(mesh.positions[i] - x, mesh.positions[i + 1] - y);
      if (d < distance || (d === distance && mesh.positions[i + 2] > best)) { distance = d; best = mesh.positions[i + 2]; }
    }
    return best;
  };
  const plain = buildLithophaneMesh(image, base);
  assert.ok(Math.abs(thickAt(plain, -40, 40) - 3) < 1e-3, 'marker top-left is thick');
  const moved = buildLithophaneMesh(image, { ...base, image_x: 60, image_y: -60 });
  assert.ok(Math.abs(thickAt(moved, 20, -20) - 3) < 1e-3, 'marker follows the offset');
  assert.ok(Math.abs(thickAt(moved, -40, 40) - 0.8) < 1e-3, 'uncovered area is Light (thin) by default');
  const dark = buildLithophaneMesh(image, { ...base, image_x: 60, image_y: -60, outside_image: 'Dark' });
  assert.ok(Math.abs(thickAt(dark, -40, 40) - 3) < 1e-3, 'Dark fill is thick');
  const turned = buildLithophaneMesh(image, { ...base, image_rot: 90 });
  assert.ok(Math.abs(thickAt(turned, -40, -40) - 3) < 1e-3, '90° counter-clockwise moves top-left to bottom-left');
  const zoomed = buildLithophaneMesh(image, { ...base, image_size: 200 });
  assert.ok(Math.abs(thickAt(zoomed, -40, 40) - 0.8) < 1e-3, 'zoom 200 % pushes the corner marker out of view');
  checkClosed(moved);
  assert.deepEqual(moved.items, [{ id: 'image', center: [60, -60, 3], size: [100, 100], rotation: 0 }]);
  // Wrapping shapes repeat the photo sideways; upright shapes have no viewport item.
  const cylinder = buildLithophaneMesh(gradientImage(300, 100), { shape: 'Cylinder', size_mm: 50, image_x: 40, resolution_mm: 1 });
  checkClosed(cylinder);
  assert.deepEqual(cylinder.items, []);
});
