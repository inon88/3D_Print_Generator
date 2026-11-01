// Viewport transform (move / rotate / scale) shared by the renderer (preview) and the main process (export).
// Each of the nine channels is owned either by a tool parameter that follows a naming convention, or by an
// app parameter in the automatic "Transform" group. App-owned channels never reach OpenSCAD: the preview applies
// them in Three.js and export applies the same matrix to the rendered mesh.

const AXES = ['x', 'y', 'z'];
const KINDS = ['move', 'rotate', 'scale'];
const APP_PARAMETER_PREFIX = 'formforge_';
const TRANSFORM_GROUP = 'Transform';

// Tool parameter names recognized per channel, in order of preference.
const TOOL_PARAMETER_NAMES = {
  move: axis => [`move_${axis}`, `position_${axis}`, `pos_${axis}`, `translate_${axis}`, `${axis}_position`],
  rotate: axis => [`rotate_${axis}`, `rotation_${axis}`, `rot_${axis}`, `${axis}_rotation`,
    ...(axis === 'z' ? ['rotation_deg', 'rotation', 'rotate', 'rotation_angle'] : [])],
  scale: axis => [`scale_${axis}`, `${axis}_scale`]
};
const UNIFORM_SCALE_NAMES = ['scale', 'scale_factor', 'scale_percent'];

const APP_LIMITS = {
  move: { min: -500, max: 500, step: 0.1, default: 0, unit: 'mm', label: 'Move' },
  rotate: { min: -180, max: 180, step: 1, default: 0, unit: '°', label: 'Rotate' },
  scale: { min: 1, max: 1000, step: 1, default: 100, unit: '%', label: 'Scale' }
};

function isTransformableParameter(parameter) {
  return parameter && parameter.type === 'number' && !parameter.options?.length;
}

// Tool scale parameters are factors (1 = 100 %) unless they are clearly percentages.
function scaleUnit(parameter) {
  return /_percent$|_pct$/.test(parameter.name) || Number(parameter.default) >= 10 ? 'percent' : 'factor';
}

// Returns owners[kind][axisIndex] = { source: 'tool' | 'app', name, unit?, uniform? }.
function transformOwners(parameters = []) {
  const byName = new Map(parameters.filter(isTransformableParameter).map(parameter => [parameter.name, parameter]));
  const owners = {};
  for (const kind of KINDS) {
    owners[kind] = AXES.map(axis => {
      const match = TOOL_PARAMETER_NAMES[kind](axis).find(name => byName.has(name));
      if (match) return { source: 'tool', name: match, ...(kind === 'scale' ? { unit: scaleUnit(byName.get(match)) } : {}) };
      return { source: 'app', name: appParameterName(kind, axis) };
    });
  }
  // A single "scale" parameter owns all three scale axes when the tool has no per-axis scale.
  const uniform = UNIFORM_SCALE_NAMES.find(name => byName.has(name));
  if (uniform && owners.scale.every(owner => owner.source === 'app')) {
    owners.scale = AXES.map(() => ({ source: 'tool', name: uniform, unit: scaleUnit(byName.get(uniform)), uniform: true }));
  }
  return owners;
}

function appParameterName(kind, axis) {
  return `${APP_PARAMETER_PREFIX}${kind}_${axis}`;
}

function isAppTransformParameterName(name) {
  return /^formforge_(move|rotate|scale)_[xyz]$/.test(String(name));
}

// Parameter definitions for the automatic Transform group (only channels the tool does not own).
function appTransformParameters(owners) {
  const parameters = [];
  for (const kind of KINDS) {
    owners[kind].forEach((owner, index) => {
      if (owner.source !== 'app') return;
      const limits = APP_LIMITS[kind];
      parameters.push({
        name: owner.name,
        label: `${limits.label} ${AXES[index].toUpperCase()} (${limits.unit})`,
        type: 'number',
        default: limits.default,
        min: limits.min,
        max: limits.max,
        step: limits.step,
        group: TRANSFORM_GROUP,
        appTransform: { kind, axis: index }
      });
    });
  }
  return parameters;
}

// App-owned transform from parameter values. Tool-owned channels stay neutral: OpenSCAD already applied them.
// Shape: { move: [mm×3], rotate: [deg×3], scale: [factor×3] }.
function appTransformFromValues(values, owners) {
  const read = (kind, index, fallback) => {
    const owner = owners[kind][index];
    if (owner.source !== 'app') return fallback;
    const value = Number(values?.[owner.name]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    move: AXES.map((_, index) => read('move', index, 0)),
    rotate: AXES.map((_, index) => read('rotate', index, 0)),
    scale: AXES.map((_, index) => read('scale', index, 100) / 100)
  };
}

function isIdentityTransform(transform) {
  return transform.move.every(value => value === 0)
    && transform.rotate.every(value => value % 360 === 0)
    && transform.scale.every(value => value === 1);
}

// --- 4×4 matrices, row-major internally: m[row * 4 + column] ------------------------------------------------

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[row * 4 + k] * b[k * 4 + column];
      out[row * 4 + column] = sum;
    }
  }
  return out;
}

function translation(x, y, z) {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

function scaling(x, y, z) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

function rotationX(degrees) {
  const r = degrees * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}

function rotationY(degrees) {
  const r = degrees * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

function rotationZ(degrees) {
  const r = degrees * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// Same order as OpenSCAD rotate([x, y, z]): X first, then Y, then Z.
function rotationXYZ([x, y, z]) {
  return multiply(rotationZ(z), multiply(rotationY(y), rotationX(x)));
}

// Plate-space matrix for a mesh with bounds { min: [x,y,z], max: [x,y,z] }:
//   M = T(move + [0,0,dropZ]) · T(c − b) · R · S · T(−c)
// c is the bounds center (rotate/scale pivot) and b the bottom center the model rests on. With an identity
// transform M equals the viewer's "center on the plate" placement. keepAxes[i] leaves axis i where the
// tool put it (the tool owns that move channel), so it is neither centered nor dropped.
function transformMatrix(bounds, transform, keepAxes = [false, false, false], dropZ = 0) {
  const center = AXES.map((_, i) => (bounds.min[i] + bounds.max[i]) / 2);
  const base = [center[0], center[1], bounds.min[2]].map((value, i) => (keepAxes[i] ? 0 : value));
  const pivot = center.map((value, i) => value - base[i]);
  const [mx, my, mz] = transform.move;
  return multiply(
    translation(mx + pivot[0], my + pivot[1], mz + dropZ + pivot[2]),
    multiply(rotationXYZ(transform.rotate), multiply(scaling(...transform.scale), translation(-center[0], -center[1], -center[2])))
  );
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11]
  ];
}

// Three.js Matrix4.fromArray() expects column-major order.
function toColumnMajor(m) {
  return [0, 1, 2, 3].flatMap(column => [0, 1, 2, 3].map(row => m[row * 4 + column]));
}

// Validates the export payload sent by the renderer. Returns null for "leave the mesh untouched".
function normalizeTransformPayload(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid transform.');
  const vector = (value, min, max, label) => {
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => !Number.isFinite(item) || item < min || item > max)) {
      throw new Error(`Transform ${label} is outside the allowed range.`);
    }
    return value.map(Number);
  };
  const flags = value => (Array.isArray(value) && value.length === 3 ? value.map(item => item === true) : [false, false, false]);
  const transform = {
    move: vector(payload.move, -10000, 10000, 'move'),
    rotate: vector(payload.rotate, -360, 360, 'rotation'),
    scale: vector(payload.scale, 0.001, 100, 'scale'),
    keepOnPlate: payload.keepOnPlate === true,
    keepAxes: flags(payload.keepAxes)
  };
  if (transform.keepOnPlate && !transform.keepAxes[2]) transform.move[2] = 0;
  return isIdentityTransform(transform) ? null : transform;
}

// Final export matrix for a mesh given a vertex visitor: visit(callback(x, y, z)) calls back for every vertex.
function exportMatrix(visit, transform) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  visit((x, y, z) => {
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  });
  if (!Number.isFinite(min[0])) return null;
  const bounds = { min, max };
  let dropZ = 0;
  if (transform.keepOnPlate && !transform.keepAxes[2]) {
    const settled = transformMatrix(bounds, { ...transform, move: [0, 0, 0] }, transform.keepAxes);
    let lowest = Infinity;
    visit((x, y, z) => {
      const height = settled[8] * x + settled[9] * y + settled[10] * z + settled[11];
      if (height < lowest) lowest = height;
    });
    dropZ = -lowest;
  }
  return transformMatrix(bounds, transform, transform.keepAxes, dropZ);
}

// --- Movable items --------------------------------------------------------------------------------------------
// A tool announces parts the viewport may pick and transform on their own with
//   echo("formforge-item", id, cx, cy, cz, width, depth, rotation_deg);
// (model coordinates, box centered on cx/cy, rotated about Z, cz = top surface). The id is either a parameter
// prefix — the item is then driven by <id>_x, <id>_y and optionally <id>_rot / <id>_size — or
// "<nested-tree parameter>:<element path>" such as "decorative_layers:0.1" for a nested element.

const ITEM_ID = /^[A-Za-z_]\w{0,63}(?::\d{1,3}(?:\.\d{1,3}){0,7})?$/;

function parseItemEchoes(lines = []) {
  const items = [];
  const seen = new Set();
  for (const line of lines) {
    if (typeof line !== 'string' || !line.startsWith('ECHO: ')) continue;
    let values;
    try { values = JSON.parse(`[${line.slice(6)}]`); } catch { continue; }
    if (values[0] !== 'formforge-item' || values.length !== 8 || typeof values[1] !== 'string') continue;
    const numbers = values.slice(2);
    if (!ITEM_ID.test(values[1]) || seen.has(values[1]) || numbers.some(value => !Number.isFinite(value))) continue;
    seen.add(values[1]);
    const [cx, cy, cz, width, depth, rotation] = numbers;
    items.push({ id: values[1], center: [cx, cy, cz], size: [Math.max(Math.abs(width), 0.5), Math.max(Math.abs(depth), 0.5)], rotation });
    if (items.length >= 500) break;
  }
  return items;
}

// Number of build plates a tool laid its parts on: echo("formforge-plates", n). null when not announced.
// Tools that announce plates also have an `export_plate` parameter (0 = all, n = only plate n moved onto plate 1).
const MAX_EXPORT_PLATES = 64;

function parsePlateCount(lines = []) {
  for (const line of lines) {
    if (typeof line !== 'string' || !line.startsWith('ECHO: "formforge-plates"')) continue;
    let values;
    try { values = JSON.parse(`[${line.slice(6)}]`); } catch { continue; }
    const count = values[1];
    if (values.length === 2 && Number.isInteger(count) && count >= 1) return Math.min(count, MAX_EXPORT_PLATES);
  }
  return null;
}

// Which values an item writes to. Returns null when the tool has no matching parameters.
//   { kind: 'parameters', x, y, rotate?, size? }  — parameter names
//   { kind: 'nested', tree, path: [indexes] }
function itemTarget(id, parameters = []) {
  const [prefix, elementPath] = String(id).split(':');
  const byName = new Map(parameters.map(parameter => [parameter.name, parameter]));
  if (elementPath !== undefined) {
    return byName.get(prefix)?.type === 'nested-tree' ? { kind: 'nested', tree: prefix, path: elementPath.split('.').map(Number) } : null;
  }
  const numeric = name => (isTransformableParameter(byName.get(name)) ? name : undefined);
  const x = numeric(`${prefix}_x`);
  const y = numeric(`${prefix}_y`);
  if (!x || !y) return null;
  return {
    kind: 'parameters',
    x,
    y,
    rotate: numeric(`${prefix}_rot`) || numeric(`${prefix}_rotation`),
    size: numeric(`${prefix}_size`) || numeric(`${prefix}_scale`)
  };
}

module.exports = {
  ITEM_ID,
  MAX_EXPORT_PLATES,
  parseItemEchoes,
  parsePlateCount,
  itemTarget,
  AXES,
  KINDS,
  APP_LIMITS,
  TRANSFORM_GROUP,
  transformOwners,
  appParameterName,
  isAppTransformParameterName,
  appTransformParameters,
  appTransformFromValues,
  isIdentityTransform,
  identity,
  multiply,
  transformMatrix,
  transformPoint,
  toColumnMajor,
  normalizeTransformPayload,
  exportMatrix
};
