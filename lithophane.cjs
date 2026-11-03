// Lithophane generator: turns a grayscale height map into a watertight mesh, without OpenSCAD.
// Dark pixels become thick (they block light), light pixels thin. The picture is a grid of
// cells laid on a base surface (flat plate, arc, cylinder, square box or sphere); every vertex
// has an inner point on that surface and an outer point pushed out along the surface normal
// by the local thickness. Active cells get an outer and an inner face, and walls close every
// edge between an active cell and an empty one, so the mesh is closed by construction.
// Pure functions without Node or DOM dependencies, shared by the app worker and the web app.

const LITHOPHANE_GENERATOR_VERSION = 2;
const LITHOPHANE_IMAGE_PARAMETER = 'lithophane_image_file';
const LITHOPHANE_SHAPES = ['Flat', 'Rounded', 'Circle', 'Oval', 'Heart', 'Curved', 'Cylinder', 'Sphere', 'Box'];
const FLAT_SHAPES = new Set(['Flat', 'Rounded', 'Circle', 'Oval', 'Heart']);
const PLATE_COLORS = Object.freeze({
  White: '#F4F4F0', Ivory: '#FFFFF0', Beige: '#F5F5DC', LightGray: '#D3D3D3', LightSkyBlue: '#87CEFA', Pink: '#FFC0CB'
});
// Grid budgets: the export keeps files printable (about 2 million triangles, ~100 MB STL, at
// most; larger pieces get a coarser grid); the preview stays light enough to load in a second.
const MAX_EXPORT_CELLS = 500 * 1000;
// The preview shows the export grid while it stays under this many cells (about 0.8 million
// triangles, which the viewer loads in about a second); larger pieces get a coarser preview.
const MAX_PREVIEW_CELLS = 200 * 1000;

const parameter = (name, label, type, value, group, description, extra = {}) =>
  ({ name, label, type, default: value, group, description, ...extra, source: 'generator' });

const LITHOPHANE_PARAMETERS = Object.freeze([
  parameter(LITHOPHANE_IMAGE_PARAMETER, 'Image', 'string', '', 'Image', 'PNG, JPG, or WebP. Dark areas become thick, light areas thin; adjust levels in the next step.'),
  parameter('image_mode', 'Image mode', 'string', 'Positive', 'Image', 'Positive shows the photo when lit from behind; Negative inverts it.', { options: ['Positive', 'Negative'] }),
  // Photo placement inside the lithophane. image_x/_y/_rot/_size follow the viewport item
  // convention (transform.cjs itemTarget), so on flat shapes the photo can be picked in the
  // viewport and moved (G), turned (R) and scaled (S).
  parameter('image_x', 'Photo offset X (mm)', 'number', 0, 'Photo position', 'Moves the photo right (negative = left). On flat shapes, click the photo in the viewport and press G.', { min: -150, step: 0.5, max: 150 }),
  parameter('image_y', 'Photo offset Y (mm)', 'number', 0, 'Photo position', 'Moves the photo up (negative = down). Cylinder, Box and Sphere wrap sideways moves around.', { min: -150, step: 0.5, max: 150 }),
  parameter('image_rot', 'Photo rotation (°)', 'number', 0, 'Photo position', 'Turns the photo counter-clockwise. In the viewport: R.', { min: -180, step: 1, max: 180 }),
  parameter('image_size', 'Photo zoom (%)', 'number', 100, 'Photo position', '100 % fills the lithophane; larger crops in, smaller leaves a margin. In the viewport: S.', { min: 20, step: 1, max: 400 }),
  parameter('outside_image', 'Outside the photo', 'string', 'Light', 'Photo position', 'What fills the area the photo does not cover after moving or zooming out.', { options: ['Light', 'Dark', 'Stretch edge'] }),
  parameter('shape', 'Shape', 'string', 'Flat', 'Shape', 'Flat shapes lie on the plate; Curved, Cylinder, Sphere and Box stand upright like a lamp shade.', { options: LITHOPHANE_SHAPES }),
  parameter('size_mm', 'Size (mm)', 'number', 100, 'Shape', 'Flat shapes and Curved: picture width. Cylinder and Box: height (the photo wraps once around, so wide panoramas make wider lamps). Sphere: diameter.', { min: 30, step: 1, max: 250 }),
  parameter('curve_angle_deg', 'Curve angle (°)', 'number', 120, 'Shape', 'Curved: how far the picture bends around.', { min: 30, step: 5, max: 240 }),
  parameter('corner_radius_mm', 'Corner radius (mm)', 'number', 8, 'Shape', 'Rounded: radius of the corners.', { min: 1, step: 0.5, max: 60 }),
  parameter('light_hole_mm', 'Light opening (mm)', 'number', 40, 'Shape', 'Sphere: opening at the bottom for a light (0 = closed ball).', { min: 0, step: 1, max: 150 }),
  parameter('max_thickness_mm', 'Max thickness (mm)', 'number', 3, 'Thickness', 'Thickness at the darkest spots.', { min: 1.2, step: 0.1, max: 6 }),
  parameter('min_thickness_mm', 'Min thickness (mm)', 'number', 0.8, 'Thickness', 'Thickness at the lightest spots.', { min: 0.3, step: 0.1, max: 2 }),
  parameter('resolution_mm', 'Detail (mm)', 'number', 0.2, 'Thickness', 'Size of one height step in the exported file. Smaller shows finer detail but makes bigger files. The preview uses a coarser grid.', { min: 0.1, step: 0.05, max: 0.5 }),
  parameter('frame_mm', 'Frame width (mm)', 'number', 3, 'Frame', 'Solid border around the picture; rims at the top and bottom of standing shapes (0 = none).', { min: 0, step: 0.5, max: 15 }),
  parameter('frame_thickness_mm', 'Frame thickness (mm)', 'number', 4, 'Frame', 'Never thinner than the maximum thickness.', { min: 1.2, step: 0.1, max: 10 }),
  parameter('hanger', 'Hanger', 'boolean', true, 'Hanger', 'Flat shapes: ring at the top centre for a string or hook.'),
  parameter('hanger_diameter_mm', 'Hanger diameter (mm)', 'number', 10, 'Hanger', 'Outer diameter of the ring.', { min: 6, step: 0.5, max: 20 }),
  parameter('hanger_hole_mm', 'Hanger hole (mm)', 'number', 4, 'Hanger', 'Hole diameter.', { min: 2, step: 0.5, max: 12 }),
  parameter('plate_color', 'Colour', 'string', 'White', 'Colour', 'Preview and 3MF colour; print lithophanes in white.', { options: Object.keys(PLATE_COLORS) })
]);

const LITHOPHANE_TOOL = Object.freeze({
  id: 'generator-lithophane',
  name: 'Lithophane',
  category: 'Generator',
  kind: 'generator',
  generator: 'lithophane',
  entry: 'generator.json'
});

function lithophaneManifest(createdAt = new Date().toISOString()) {
  return {
    ...LITHOPHANE_TOOL,
    sourceUrl: '',
    parameters: LITHOPHANE_PARAMETERS.map(item => ({ ...item, options: item.options ? [...item.options] : undefined })),
    generatorVersion: LITHOPHANE_GENERATOR_VERSION,
    createdAt
  };
}

// --- options & image ------------------------------------------------------------------------

function readOptions(values = {}) {
  const options = {};
  for (const item of LITHOPHANE_PARAMETERS) {
    let value = Object.hasOwn(values, item.name) ? values[item.name] : item.default;
    if (item.type === 'number') {
      value = Number.isFinite(value) ? Math.min(item.max, Math.max(item.min, value)) : item.default;
    } else if (item.type === 'boolean') value = value === true;
    else if (item.options && !item.options.includes(value)) value = item.default;
    options[item.name] = value;
  }
  options.tMin = options.min_thickness_mm;
  options.tMax = Math.max(options.max_thickness_mm, options.tMin + 0.2);
  options.frameT = Math.max(options.frame_thickness_mm, options.tMax);
  return options;
}

// Height maps from heightmap.cjs carry a 1 px black border for surface(); drop it.
function cropBorder({ width, height, gray }) {
  if (width < 4 || height < 4) return { width, height, gray };
  const out = new Uint8Array((width - 2) * (height - 2));
  for (let y = 1; y < height - 1; y++) out.set(gray.subarray(y * width + 1, y * width + width - 1), (y - 1) * (width - 2));
  return { width: width - 2, height: height - 2, gray: out };
}

// Box filter by an integer factor so a large photo on a coarse grid does not alias.
function downscale(image, factor) {
  if (factor < 2) return image;
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * image.width + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += image.gray[row + dx];
      }
      gray[y * width + x] = Math.round(sum / (factor * factor));
    }
  }
  return { width, height, gray };
}

// Brightness 0..1 at (u, v) in 0..1, bilinear; v = 0 is the top row.
function sampler({ width, height, gray }) {
  return (u, v) => {
    const x = Math.min(Math.max(u, 0), 1) * (width - 1);
    const y = Math.min(Math.max(v, 0), 1) * (height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0, fy = y - y0;
    const top = gray[y0 * width + x0] * (1 - fx) + gray[y0 * width + x1] * fx;
    const bottom = gray[y1 * width + x0] * (1 - fx) + gray[y1 * width + x1] * fx;
    return (top * (1 - fy) + bottom * fy) / 255;
  };
}

// Darkness 0..1 (0 = thin, 1 = thick) at (x, y) in millimetres from the picture centre (y up),
// for a photo of width × height mm placed with the image_* parameters. wrapWidth > 0 repeats
// the photo sideways (shapes that go all the way around).
function photoDarkness(image, options, width, height, wrapWidth = 0) {
  const sample = sampler(image);
  const negative = options.image_mode === 'Negative';
  const angle = options.image_rot * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const scale = options.image_size / 100;
  const fill = options.outside_image;
  return (x, y) => {
    let dx = x - options.image_x;
    if (wrapWidth > 0) dx -= wrapWidth * Math.round(dx / wrapWidth);
    const dy = y - options.image_y;
    // Undo the photo's rotation and zoom to find the image point under (x, y).
    const px = (dx * cos + dy * sin) / scale, py = (-dx * sin + dy * cos) / scale;
    const u = px / width + 0.5, v = 0.5 - py / height;
    const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    if (!inside && fill !== 'Stretch edge') return fill === 'Dark' ? 1 : 0;
    const brightness = sample(u, v);
    return negative ? brightness : 1 - brightness;
  };
}

// Shown before an image is chosen: a soft portrait-like disc with rings on a gradient.
function demoHeightmap(width = 240, height = 180) {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - width / 2) / height, dy = (y - height / 2) / height;
      const r = Math.hypot(dx, dy);
      const value = r < 0.36 ? 0.55 + 0.4 * Math.cos(r * 40) * (1 - r * 2) : 0.2 + 0.6 * x / width;
      gray[y * width + x] = Math.round(255 * Math.min(1, Math.max(0, value)));
    }
  }
  return { width, height, gray };
}

// --- 2D masks for the flat shapes (millimetres, centred on the picture) ----------------------

let heartBounds = null;
function heartImplicit(x, y) {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}
function getHeartBounds() {
  if (heartBounds) return heartBounds;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i <= 600; i++) {
    for (let j = 0; j <= 600; j++) {
      const x = -1.5 + 3 * i / 600, y = -1.5 + 3 * j / 600;
      if (!heartImplicit(x, y)) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  heartBounds = { width: maxX - minX, height: maxY - minY, centerY: (minY + maxY) / 2 };
  return heartBounds;
}

function shapeMask(shape, width, height, cornerRadius) {
  const hw = width / 2, hh = height / 2;
  if (shape === 'Rounded') {
    const r = Math.min(cornerRadius, hw, hh);
    return (x, y) => {
      const qx = Math.abs(x) - (hw - r), qy = Math.abs(y) - (hh - r);
      if (Math.abs(x) > hw || Math.abs(y) > hh) return false;
      return qx <= 0 || qy <= 0 || qx * qx + qy * qy <= r * r;
    };
  }
  if (shape === 'Circle') {
    const r = Math.min(hw, hh);
    return (x, y) => x * x + y * y <= r * r;
  }
  if (shape === 'Oval') return (x, y) => (x / hw) ** 2 + (y / hh) ** 2 <= 1;
  if (shape === 'Heart') {
    const bounds = getHeartBounds();
    const scale = Math.min(width / bounds.width, height / bounds.height);
    return (x, y) => heartImplicit(x / scale, y / scale + bounds.centerY);
  }
  return (x, y) => Math.abs(x) <= hw && Math.abs(y) <= hh;
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) in cells, from set cells.
function distanceTransform(set, cols, rows) {
  const INF = 1e20;
  const grid = new Float64Array(cols * rows);
  for (let i = 0; i < grid.length; i++) grid[i] = set[i] ? 0 : INF;
  const n = Math.max(cols, rows);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = length => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < length; q++) {
      let s;
      do {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) k--;
        else break;
      } while (k >= 0);
      k++;
      v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < length; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  };
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = grid[y * cols + x];
    pass(rows);
    for (let y = 0; y < rows; y++) grid[y * cols + x] = d[y];
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) f[x] = grid[y * cols + x];
    pass(cols);
    for (let x = 0; x < cols; x++) grid[y * cols + x] = Math.sqrt(d[x]);
  }
  return grid;
}

// --- generic grid mesher ---------------------------------------------------------------------

function distance2(positions, a, b) {
  const dx = positions[a * 3] - positions[b * 3], dy = positions[a * 3 + 1] - positions[b * 3 + 1], dz = positions[a * 3 + 2] - positions[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

class GrowableIndices {
  constructor(capacity) { this.data = new Uint32Array(Math.max(1024, capacity)); this.length = 0; }
  push3(a, b, c) {
    if (a === b || b === c || a === c) return;     // collapsed at a pole
    if (this.length + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a; this.data[this.length++] = b; this.data[this.length++] = c;
  }
  result() { return this.data.slice(0, this.length); }
}

// spec: { cols, rows, wrap, poleTop, poleBottom, active(i, j), surface(i, j) → [x, y, z, nx, ny, nz],
// thickness(i, j) }. Cells are (i, j) with 0 ≤ i < cols, 0 ≤ j < rows; vertices (i, j) with
// 0 ≤ i ≤ cols (column cols = column 0 when wrap), 0 ≤ j ≤ rows; j = 0 is the top of the image.
function meshGrid(spec) {
  const { cols, rows, wrap, poleTop, poleBottom } = spec;
  const stride = cols + 1;
  const slots = stride * (rows + 1);
  const inner = new Int32Array(slots).fill(-1);
  const outer = new Int32Array(slots).fill(-1);
  let positions = new Float32Array(Math.min(slots, 1 << 20) * 6);
  let vertexCount = 0;
  const column = i => (wrap ? ((i % cols) + cols) % cols : i);
  const key = (i, j) => ((poleTop && j === 0) || (poleBottom && j === rows) ? 0 : column(i)) + j * stride;
  const addVertex = (x, y, z) => {
    if (vertexCount * 3 + 3 > positions.length) {
      const next = new Float32Array(positions.length * 2);
      next.set(positions);
      positions = next;
    }
    positions[vertexCount * 3] = x; positions[vertexCount * 3 + 1] = y; positions[vertexCount * 3 + 2] = z;
    return vertexCount++;
  };
  const vertex = (i, j, isOuter) => {
    const k = key(i, j);
    const table = isOuter ? outer : inner;
    if (table[k] < 0) {
      const ii = k % stride;
      const [x, y, z, nx, ny, nz] = spec.surface(ii, j);
      if (isOuter) {
        const t = spec.thickness(ii, j);
        table[k] = addVertex(x + nx * t, y + ny * t, z + nz * t);
      } else table[k] = addVertex(x, y, z);
    }
    return table[k];
  };
  const isActive = (i, j) => {
    if (j < 0 || j >= rows) return false;
    if (wrap) return spec.active(column(i), j);
    return i >= 0 && i < cols && spec.active(i, j);
  };
  const indices = new GrowableIndices(cols * rows * 12);
  // Wall on the cell edge p → q (traversed clockwise as seen from outside): faces outwards.
  const wall = (pi, pj, qi, qj) => {
    const ip = vertex(pi, pj, false), iq = vertex(qi, qj, false);
    const op = vertex(pi, pj, true), oq = vertex(qi, qj, true);
    indices.push3(ip, oq, iq);
    indices.push3(ip, op, oq);
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!spec.active(i, j)) continue;
      const A = vertex(i, j, true), B = vertex(i + 1, j, true), C = vertex(i + 1, j + 1, true), D = vertex(i, j + 1, true);
      // Split along the shorter diagonal: the surface follows ridges in the photo instead of
      // zig-zagging across them.
      if (distance2(positions, A, C) <= distance2(positions, B, D)) {
        indices.push3(A, D, C);
        indices.push3(A, C, B);
      } else {
        indices.push3(A, D, B);
        indices.push3(B, D, C);
      }
      const a = vertex(i, j, false), b = vertex(i + 1, j, false), c = vertex(i + 1, j + 1, false), d = vertex(i, j + 1, false);
      indices.push3(a, c, d);
      indices.push3(a, b, c);
      if (!isActive(i, j - 1)) wall(i, j, i + 1, j);
      if (!isActive(i + 1, j)) wall(i + 1, j, i + 1, j + 1);
      if (!isActive(i, j + 1)) wall(i + 1, j + 1, i, j + 1);
      if (!isActive(i - 1, j)) wall(i, j + 1, i, j);
    }
  }
  return { positions: positions.slice(0, vertexCount * 3), indices: indices.result() };
}

// --- shapes ----------------------------------------------------------------------------------

// Two cells that touch only at a corner would make four walls meet on one edge (not
// manifold); fill one of the two empty cells with the solid type until none are left.
function removePinches(type, cols, rows) {
  for (let changed = true; changed;) {
    changed = false;
    for (let j = 0; j + 1 < rows; j++) {
      for (let i = 0; i + 1 < cols; i++) {
        const a = type[j * cols + i], b = type[j * cols + i + 1], c = type[(j + 1) * cols + i], d = type[(j + 1) * cols + i + 1];
        if (a && d && !b && !c) { type[j * cols + i + 1] = 2; changed = true; }
        else if (b && c && !a && !d) { type[j * cols + i] = 2; changed = true; }
      }
    }
  }
}

function pitchFor(areaMm2, longSideMm, options, preview) {
  return Math.max(options.resolution_mm, Math.sqrt(areaMm2 / (preview ? MAX_PREVIEW_CELLS : MAX_EXPORT_CELLS)));
}

// Outlines made of square cells look like stairs. Every vertex on an edge between two cell
// types (picture, frame, empty) that has exactly two such edges is smoothed along its outline
// (Laplacian: stair corners meet half-way, straight edges stay put) and kept within 0.45 cell of
// its grid spot, so circles, hearts, frames and the hanger hole come out round. Returns XY
// offsets per vertex.
function smoothOutlines(type, cols, rows, px, py, iterations = 8) {
  const stride = cols + 1;
  const count = stride * (rows + 1);
  const cell = (i, j) => (i >= 0 && j >= 0 && i < cols && j < rows ? type[j * cols + i] : 0);
  const neighbours = new Int32Array(count * 2).fill(-1);
  const degree = new Uint8Array(count);
  const link = (a, b) => {
    for (const [from, to] of [[a, b], [b, a]]) {
      if (degree[from] < 2) neighbours[from * 2 + degree[from]] = to;
      degree[from]++;
    }
  };
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      if (i < cols && cell(i, j - 1) !== cell(i, j)) link(j * stride + i, j * stride + i + 1);
      if (j < rows && cell(i - 1, j) !== cell(i, j)) link(j * stride + i, (j + 1) * stride + i);
    }
  }
  const offsets = new Float32Array(count * 2);
  const moving = [];
  for (let v = 0; v < count; v++) if (degree[v] === 2) moving.push(v);
  if (!moving.length) return offsets;
  const x = new Float64Array(count), y = new Float64Array(count);
  for (let v = 0; v < count; v++) { x[v] = (v % stride) * px; y[v] = Math.floor(v / stride) * py; }
  const limit = 0.45 * Math.min(px, py);
  const nx = new Float64Array(moving.length), ny = new Float64Array(moving.length);
  const step = factor => {
    moving.forEach((v, k) => {
      const a = neighbours[v * 2], b = neighbours[v * 2 + 1];
      nx[k] = x[v] + factor * ((x[a] + x[b]) / 2 - x[v]);
      ny[k] = y[v] + factor * ((y[a] + y[b]) / 2 - y[v]);
    });
    moving.forEach((v, k) => {
      let dx = nx[k] - (v % stride) * px, dy = ny[k] - Math.floor(v / stride) * py;
      const length = Math.hypot(dx, dy);
      if (length > limit) { dx *= limit / length; dy *= limit / length; }
      x[v] = (v % stride) * px + dx; y[v] = Math.floor(v / stride) * py + dy;
    });
  };
  for (let n = 0; n < iterations; n++) step(0.5);
  for (const v of moving) {
    offsets[v * 2] = x[v] - (v % stride) * px;
    offsets[v * 2 + 1] = -(y[v] - Math.floor(v / stride) * py);   // grid rows run down, y runs up
  }
  return offsets;
}

function flatSpec(image, options, preview) {
  const width = options.size_mm;
  const height = width * image.height / image.width;
  const frame = options.frame_mm;
  const hanger = options.hanger;
  const hangerR = options.hanger_diameter_mm / 2;
  const holeR = Math.min(options.hanger_hole_mm, options.hanger_diameter_mm - 2) / 2;
  const pitch = pitchFor((width + 2 * frame) * (height + 2 * frame), Math.max(width, height), options, preview);
  const picCols = Math.max(8, Math.round(width / pitch));
  const picRows = Math.max(8, Math.round(height / pitch));
  const px = width / picCols, py = height / picRows;
  const margin = Math.ceil(frame / Math.min(px, py)) + 1;
  const top = hanger ? Math.ceil(options.hanger_diameter_mm / py) + 2 : 0;
  const cols = picCols + 2 * margin;
  const rows = picRows + 2 * margin + top;
  const x0 = -width / 2 - margin * px;
  const y0 = height / 2 + (margin + top) * py;     // y of vertex row 0
  const inShape = shapeMask(options.shape, width, height, options.corner_radius_mm);
  const type = new Uint8Array(cols * rows);         // 0 empty, 1 picture, 2 solid (frame, hanger)
  const picture = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (inShape(x0 + (i + 0.5) * px, y0 - (j + 0.5) * py)) { picture[j * cols + i] = 1; type[j * cols + i] = 1; }
    }
  }
  if (frame > 0) {
    // Cells are not square (px ≈ py); the distance in cells uses the smaller pitch, so the
    // frame is never thinner than asked.
    const distance = distanceTransform(picture, cols, rows);
    const limit = frame / Math.min(px, py) + 1e-6;
    for (let k = 0; k < type.length; k++) if (!type[k] && distance[k] <= limit) type[k] = 2;
  }
  if (hanger) {
    let topY = -Infinity;
    for (let j = 0; j < rows && topY === -Infinity; j++) {
      for (let i = 0; i < cols; i++) {
        const x = x0 + (i + 0.5) * px;
        if (type[j * cols + i] && Math.abs(x) <= hangerR * 0.5) { topY = y0 - (j + 0.5) * py; break; }
      }
    }
    const cy = topY + hangerR * 0.6;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const r = Math.hypot(x0 + (i + 0.5) * px, y0 - (j + 0.5) * py - cy);
        if (r <= holeR) { if (type[k] === 2) type[k] = 0; } else if (r <= hangerR && !type[k]) type[k] = 2;
      }
    }
  }
  removePinches(type, cols, rows);
  const offsets = smoothOutlines(type, cols, rows, px, py);
  const darkness = photoDarkness(image, options, width, height);
  const relief = options.tMax - options.tMin;
  const cell = (i, j) => (i >= 0 && j >= 0 && i < cols && j < rows ? type[j * cols + i] : 0);
  return {
    cols, rows, wrap: false,
    active: (i, j) => type[j * cols + i] !== 0,
    surface: (i, j) => {
      const k = (j * (cols + 1) + i) * 2;
      return [x0 + i * px + offsets[k], y0 - j * py + offsets[k + 1], 0, 0, 0, 1];
    },
    thickness: (i, j) => {
      if (cell(i - 1, j - 1) === 2 || cell(i, j - 1) === 2 || cell(i - 1, j) === 2 || cell(i, j) === 2) return options.frameT;
      return options.tMin + relief * darkness(x0 + i * px, y0 - j * py);
    },
    info: { width, height, columns: picCols, rows: picRows, pitch: Math.max(px, py) },
    // Viewport item: the photo's box on the plate (model coordinates, rotated about Z).
    items: [{ id: 'image', center: [options.image_x, options.image_y, options.tMax], size: [width * options.image_size / 100, height * options.image_size / 100], rotation: options.image_rot }]
  };
}

// Upright shapes: a picture strip of picCols × picRows cells plus frame rows at the top and
// bottom (and frame columns at both ends of a curve); place(i, j) maps grid vertices onto the
// base surface.
function uprightSpec(image, options, preview) {
  const shape = options.shape;
  const relief = options.tMax - options.tMin;
  const frame = options.frame_mm;
  let stripWidth, height, place, wrap = false, poleTop = false, poleBottom = false;
  let picCols, picRows, frameRows, frameCols = 0, pitch;
  if (shape === 'Sphere') {
    const radius = options.size_mm / 2;
    const opening = Math.min(options.light_hole_mm, options.size_mm * 0.9);
    const bottom = opening > 0 ? -Math.acos(opening / (2 * radius)) : -Math.PI / 2;
    const meridian = radius * (Math.PI / 2 - bottom);
    stripWidth = 2 * Math.PI * radius;
    height = meridian;
    pitch = pitchFor(stripWidth * meridian, stripWidth, options, preview);
    picCols = Math.max(24, Math.round(stripWidth / pitch));
    picRows = Math.max(12, Math.round(meridian / pitch));
    frameRows = 0;
    wrap = true; poleTop = true; poleBottom = opening === 0;
    const zShift = -radius * Math.sin(bottom);
    place = (i, j) => {
      const theta = Math.PI / 2 + 2 * Math.PI * i / picCols;     // seam at the back
      const phi = Math.PI / 2 - (Math.PI / 2 - bottom) * j / picRows;
      const nx = Math.cos(phi) * Math.cos(theta), ny = Math.cos(phi) * Math.sin(theta), nz = Math.sin(phi);
      // The rim at the light opening is pushed out sideways, so the sphere stands on a flat ring.
      if (j === picRows && !poleBottom) return [radius * nx, radius * ny, radius * nz + zShift, Math.cos(theta), Math.sin(theta), 0];
      return [radius * nx, radius * ny, radius * nz + zShift, nx, ny, nz];
    };
  } else {
    if (shape === 'Curved') {
      stripWidth = options.size_mm;
      height = stripWidth * image.height / image.width;
    } else {
      height = options.size_mm;                       // Cylinder and Box: lamp height
      stripWidth = height * image.width / image.height;
    }
    pitch = pitchFor((stripWidth + 2 * frame) * (height + 2 * frame), Math.max(stripWidth, height), options, preview);
    picCols = Math.max(16, Math.round(stripWidth / pitch));
    if (shape === 'Box') picCols = Math.max(16, Math.round(picCols / 8) * 8);
    picRows = Math.max(8, Math.round(height / pitch));
    const columnPitch = stripWidth / picCols, rowPitch = height / picRows;
    frameRows = frame > 0 ? Math.max(1, Math.round(frame / rowPitch)) : 0;
    const totalRows = picRows + 2 * frameRows;
    const z = j => (totalRows - j) * rowPitch;
    if (shape === 'Curved') {
      frameCols = frame > 0 ? Math.max(1, Math.round(frame / columnPitch)) : 0;
      const angle = options.curve_angle_deg * Math.PI / 180;
      const radius = stripWidth / angle;
      const totalCols = picCols + 2 * frameCols;
      place = (i, j) => {
        const theta = -Math.PI / 2 + (i - totalCols / 2) * columnPitch / radius;
        const nx = Math.cos(theta), ny = Math.sin(theta);
        return [radius * nx, radius * ny + radius, z(j), nx, ny, 0];
      };
    } else if (shape === 'Cylinder') {
      wrap = true;
      const radius = stripWidth / (2 * Math.PI);
      place = (i, j) => {
        const theta = Math.PI / 2 + 2 * Math.PI * i / picCols;     // seam at the back
        const nx = Math.cos(theta), ny = Math.sin(theta);
        return [radius * nx, radius * ny, z(j), nx, ny, 0];
      };
    } else {
      wrap = true;
      const side = stripWidth / 4, half = side / 2, perSide = picCols / 4;
      const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      // Start half-way along the back face so the picture's centre lands on the front face.
      const offset = picCols * 5 / 8;
      place = (column, j) => {
        const i = (column + offset) % picCols;
        const k = Math.floor(i / perSide) % 4, t = (i % perSide) / perSide * side;
        const points = [[-half + t, -half], [half, -half + t], [half - t, half], [-half, half - t]];
        const [x, y] = points[k];
        let [nx, ny] = normals[k];
        if (i % perSide === 0) {                      // corner: mitre, so both faces keep their thickness
          const [px, py] = normals[(k + 3) % 4];
          nx += px; ny += py;
        }
        return [x, y, z(j), nx, ny, 0];
      };
    }
  }
  const cols = picCols + 2 * frameCols;
  const rows = picRows + 2 * frameRows;
  // Sphere: the frame is a rim at the light opening, drawn over the lowest picture rows.
  // Photo coordinates along the surface: x around (arc length), y up, both from the picture centre.
  const darkness = photoDarkness(image, options, stripWidth, height, wrap ? stripWidth : 0);
  const columnPitch = stripWidth / picCols, rowPitch = height / picRows;
  const sphereRim = shape === 'Sphere' && frame > 0 && !poleBottom ? Math.max(1, Math.round(frame / (height / picRows))) : 0;
  return {
    cols, rows, wrap, poleTop, poleBottom,
    active: () => true,
    surface: place,
    thickness: (i, j) => {
      if (j < frameRows || j > frameRows + picRows || i < frameCols || i > frameCols + picCols || j > rows - sphereRim) return options.frameT;
      return options.tMin + relief * darkness((i - frameCols - picCols / 2) * columnPitch, (picRows / 2 - (j - frameRows)) * rowPitch);
    },
    info: { width: stripWidth, height, columns: picCols, rows: picRows, pitch: stripWidth / picCols },
    items: []
  };
}

// image: { width, height, gray } with the 1 px border already removed, or null for the demo.
function buildLithophaneMesh(image, values = {}, { preview = false } = {}) {
  const options = readOptions(values);
  let source = image && image.width >= 2 && image.height >= 2 ? image : demoHeightmap();
  const spec = FLAT_SHAPES.has(options.shape) ? flatSpec(source, options, preview) : uprightSpec(source, options, preview);
  // Average the photo down to about the grid size first (sharper than sampling a huge image).
  const factor = Math.floor(source.width / Math.max(1, spec.info.columns));
  if (factor >= 2) {
    source = downscale(source, factor);
    const again = FLAT_SHAPES.has(options.shape) ? flatSpec(source, options, preview) : uprightSpec(source, options, preview);
    Object.assign(spec, again);
  }
  const mesh = meshGrid(spec);
  if (!FLAT_SHAPES.has(options.shape)) {
    let minZ = Infinity;
    for (let k = 2; k < mesh.positions.length; k += 3) minZ = Math.min(minZ, mesh.positions[k]);
    for (let k = 2; k < mesh.positions.length; k += 3) mesh.positions[k] -= minZ;
  }
  return { ...mesh, items: spec.items, info: { ...spec.info, shape: options.shape, minThickness: options.tMin, maxThickness: options.tMax, triangles: mesh.indices.length / 3 } };
}

// --- writers ---------------------------------------------------------------------------------

function meshToStl({ positions, indices }) {
  const count = indices.length / 3;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const header = 'BonaStudio lithophane';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, count, true);
  let offset = 84;
  for (let t = 0; t < count; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    view.setFloat32(offset, nx, true); view.setFloat32(offset + 4, ny, true); view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (const index of [a, b, c]) {
      view.setFloat32(offset, positions[index], true);
      view.setFloat32(offset + 4, positions[index + 1], true);
      view.setFloat32(offset + 8, positions[index + 2], true);
      offset += 12;
    }
    offset += 2;
  }
  return new Uint8Array(buffer);
}

const xmlEscape = text => String(text).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const number = value => String(Math.round(value * 10000) / 10000);

// 3MF package as text entries; the caller zips them (node:zlib in the app, fflate on the web).
function threeMfEntries({ positions, indices }, { name = 'Lithophane', color = 'White' } = {}) {
  const display = (PLATE_COLORS[color] || PLATE_COLORS.White) + 'FF';
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ' <resources>\n',
    `  <basematerials id="1"><base name="${xmlEscape(color)}" displaycolor="${display}"/></basematerials>\n`,
    `  <object id="2" type="model" name="${xmlEscape(name)}" pid="1" pindex="0">\n   <mesh>\n    <vertices>\n`
  ];
  let chunk = [];
  const flush = () => { parts.push(chunk.join('')); chunk = []; };
  for (let v = 0; v < positions.length; v += 3) {
    chunk.push(`     <vertex x="${number(positions[v])}" y="${number(positions[v + 1])}" z="${number(positions[v + 2])}"/>\n`);
    if (chunk.length >= 8192) flush();
  }
  flush();
  parts.push('    </vertices>\n    <triangles>\n');
  for (let t = 0; t < indices.length; t += 3) {
    chunk.push(`     <triangle v1="${indices[t]}" v2="${indices[t + 1]}" v3="${indices[t + 2]}"/>\n`);
    if (chunk.length >= 8192) flush();
  }
  flush();
  parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="2"/>\n </build>\n</model>\n');
  return [
    { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n' },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n' },
    { name: '3D/3dmodel.model', parts }
  ];
}

module.exports = {
  LITHOPHANE_GENERATOR_VERSION,
  LITHOPHANE_IMAGE_PARAMETER,
  LITHOPHANE_PARAMETERS,
  LITHOPHANE_SHAPES,
  LITHOPHANE_TOOL,
  PLATE_COLORS,
  lithophaneManifest,
  readOptions,
  cropBorder,
  demoHeightmap,
  distanceTransform,
  meshGrid,
  buildLithophaneMesh,
  meshToStl,
  threeMfEntries
};
