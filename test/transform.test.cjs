const test = require('node:test');
const assert = require('node:assert/strict');
const {
  transformOwners, appTransformParameters, appTransformFromValues, transformMatrix, transformPoint,
  normalizeTransformPayload, isAppTransformParameterName
} = require('../transform.cjs');
const { parseItemEchoes, itemTarget, parsePlateCount } = require('../transform.cjs');
const { applyTransformToStl, applyTransformTo3mf, groupObjectsAsParts, readZip, writeZip, parse3mfMatrix, format3mfMatrix } = require('../mesh-transform.cjs');

const near = (actual, expected, message) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `${message}: ${actual} ≠ ${expected}`));

test('tool parameters that follow the naming convention own their channels', () => {
  const owners = transformOwners([
    { name: 'move_x', type: 'number', default: 0 },
    { name: 'rotation_deg', type: 'number', default: 0 },
    { name: 'scale', type: 'number', default: 1 },
    { name: 'pos_y', type: 'string', default: '' },
    { name: 'rotate_x', type: 'number', default: 0, options: [0, 90] }
  ]);
  assert.deepEqual(owners.move.map(owner => owner.source), ['tool', 'app', 'app']);
  assert.equal(owners.rotate[2].name, 'rotation_deg');
  assert.equal(owners.rotate[0].source, 'app', 'option lists are not continuous transforms');
  assert.ok(owners.scale.every(owner => owner.source === 'tool' && owner.uniform && owner.unit === 'factor'));
  const app = appTransformParameters(owners);
  assert.deepEqual(app.map(parameter => parameter.name), ['formforge_move_y', 'formforge_move_z', 'formforge_rotate_x', 'formforge_rotate_y']);
  assert.ok(app.every(parameter => parameter.group === 'Transform' && isAppTransformParameterName(parameter.name)));
});

test('app transform reads only app-owned values', () => {
  const owners = transformOwners([{ name: 'move_x', type: 'number', default: 0 }]);
  const transform = appTransformFromValues({ move_x: 40, formforge_move_y: 5, formforge_scale_z: 200 }, owners);
  assert.deepEqual(transform.move, [0, 5, 0]);
  assert.deepEqual(transform.scale, [1, 1, 2]);
});

test('identity matrix centers the model on the plate', () => {
  const bounds = { min: [10, 20, 5], max: [30, 40, 15] };
  const m = transformMatrix(bounds, { move: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] });
  near(transformPoint(m, 20, 30, 5), [0, 0, 0], 'bottom center');
  near(transformPoint(m, 30, 40, 15), [10, 10, 10], 'top corner');
});

test('rotation follows OpenSCAD order and pivots on the bounds center', () => {
  const bounds = { min: [-10, -5, 0], max: [10, 5, 10] };
  const m = transformMatrix(bounds, { move: [3, 0, 0], rotate: [0, 0, 90], scale: [1, 1, 1] });
  near(transformPoint(m, 10, 0, 5), [3, 10, 5], 'rotated +X end');
  const keep = transformMatrix(bounds, { move: [0, 0, 0], rotate: [0, 0, 0], scale: [2, 2, 2] }, [true, false, false]);
  near(transformPoint(keep, 10, 0, 5), [20, 0, 5], 'kept X axis is not centered');
});

test('payload validation drops identity and locks Z on the plate', () => {
  assert.equal(normalizeTransformPayload(null), null);
  assert.equal(normalizeTransformPayload({ move: [0, 0, 0], rotate: [360, 0, 0], scale: [1, 1, 1] }), null);
  assert.equal(normalizeTransformPayload({ move: [0, 0, 9], rotate: [0, 0, 0], scale: [1, 1, 1], keepOnPlate: true }), null);
  assert.throws(() => normalizeTransformPayload({ move: [0, 0, 0], rotate: [0, 0, 0], scale: [0, 1, 1] }), /scale/);
  assert.throws(() => normalizeTransformPayload({ move: [0, 'a', 0], rotate: [0, 0, 0], scale: [1, 1, 1] }), /move/);
});

function binaryStl(triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => triangle.flat().forEach((value, axis) => buffer.writeFloatLE(value, 84 + index * 50 + 12 + axis * 4)));
  return buffer;
}

function stlVertices(buffer) {
  const count = buffer.readUInt32LE(80);
  const vertices = [];
  for (let index = 0; index < count; index++) {
    for (let vertex = 0; vertex < 3; vertex++) {
      const at = 84 + index * 50 + 12 + vertex * 12;
      vertices.push([buffer.readFloatLE(at), buffer.readFloatLE(at + 4), buffer.readFloatLE(at + 8)]);
    }
  }
  return vertices;
}

test('STL export: rotation then rest on the plate', () => {
  // A 20 × 10 × 4 slab standing at z = 10..14.
  const stl = binaryStl([[[0, 0, 10], [20, 0, 10], [20, 10, 14]], [[0, 0, 10], [20, 10, 14], [0, 10, 14]]]);
  const transform = normalizeTransformPayload({ move: [5, 0, 0], rotate: [0, 90, 0], scale: [1, 1, 1], keepOnPlate: true });
  const vertices = stlVertices(applyTransformToStl(stl, transform));
  const zs = vertices.map(vertex => vertex[2]);
  assert.ok(Math.abs(Math.min(...zs)) < 1e-4, 'rests on z = 0');
  assert.ok(Math.abs(Math.max(...zs) - 20) < 1e-4, 'length is now the height');
  const xs = vertices.map(vertex => vertex[0]);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 5) < 1e-4, 'moved 5 mm along X');
});

test('3MF matrices round-trip and ZIP entries survive a rewrite', () => {
  const m = parse3mfMatrix('1 0 0 0 1 0 0 0 1 4 5 6');
  assert.deepEqual([m[3], m[7], m[11]], [4, 5, 6]);
  assert.equal(format3mfMatrix(m), '1 0 0 0 1 0 0 0 1 4 5 6');
  const zip = writeZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: '3D/b.model', data: Buffer.from('x'.repeat(1000)) }]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map(entry => entry.name), ['a.txt', '3D/b.model']);
  assert.equal(entries[1].data.toString(), 'x'.repeat(1000));
});

test('3MF export composes the transform into build items', () => {
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="20" z="6"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const input = writeZip([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: '3D/3dmodel.model', data: Buffer.from(model) }]);
  const transform = normalizeTransformPayload({ move: [1, 2, 0], rotate: [0, 0, 0], scale: [2, 2, 2], keepOnPlate: true });
  const entries = readZip(applyTransformTo3mf(input, transform));
  const xml = entries.find(entry => entry.name === '3D/3dmodel.model').data.toString();
  assert.ok(xml.includes('<vertex x="10" y="0" z="0"/>'), 'mesh data is untouched');
  const matrix = parse3mfMatrix(/transform="([^"]+)"/.exec(xml)[1]);
  near(transformPoint(matrix, 5, 10, 0), [1, 2, 0], 'bottom center moves to the requested offset');
  near(transformPoint(matrix, 10, 20, 6), [11, 22, 12], 'scaled about the center, resting on the plate');
  assert.equal(entries[0].name, '[Content_Types].xml');
});

test('3MF color parts are grouped into one object with components', () => {
  const mesh = z => `<mesh><vertices><vertex x="0" y="0" z="${z}"/><vertex x="10" y="0" z="${z}"/><vertex x="0" y="10" z="${z + 5}"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>`;
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
<resources><basematerials id="1"><base name="A" displaycolor="#FFFFFFFF"/></basematerials>
<object id="2" type="model" pid="1" pindex="0">${mesh(0)}</object><object id="3" type="model" pid="1" pindex="0">${mesh(40)}</object></resources>
<build p:UUID="b"><item objectid="2" p:UUID="i2"/><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 3" p:UUID="i3"/></build></model>`;
  const input = writeZip([{ name: '3D/3dmodel.model', data: Buffer.from(model) }]);
  const xml = readZip(groupObjectsAsParts(input, 'Bowl')).find(entry => entry.name === '3D/3dmodel.model').data.toString();
  const group = /<object id="4" name="Bowl" type="model"[^>]*>([\s\S]*?)<\/object>/.exec(xml);
  assert.ok(group, 'a composite object with a new id is added');
  assert.ok(xml.indexOf('<object id="4"') > xml.indexOf('<object id="3"'), 'composite is defined after its parts');
  const components = [...group[1].matchAll(/<component\b([^>]*)\/>/g)].map(match => match[1]);
  assert.equal(components.length, 2);
  assert.match(components[0], /objectid="2"/);
  assert.match(components[1], /objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 3"/);
  const items = [...xml.matchAll(/<item\b([^>]*)\/>/g)].map(match => match[1]);
  assert.equal(items.length, 1, 'one build item');
  assert.match(items[0], /objectid="4" p:UUID="[0-9a-f-]{36}"/);
  assert.ok(xml.includes(mesh(40)), 'part meshes are untouched');
  // The viewport transform still works on the grouped model (it walks components).
  const moved = readZip(applyTransformTo3mf(groupObjectsAsParts(input, 'Bowl'), normalizeTransformPayload({ move: [5, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1], keepOnPlate: true })));
  assert.match(moved[0].data.toString(), /<item objectid="4"[^>]*transform="/);
  const single = writeZip([{ name: '3D/3dmodel.model', data: Buffer.from(model.replace(/<item objectid="3"[^>]*\/>/, '')) }]);
  assert.equal(groupObjectsAsParts(single, 'Bowl'), single, 'a single object is left alone');
});

test('movable items come from formforge-item echoes', () => {
  const items = parseItemEchoes([
    'ECHO: "formforge-item", "name", 1.5, -2, 12, 120, 30, 15',
    'ECHO: "formforge-item", "decorative_layers:0.1", 0, 0, 10, 20, 20, 0',
    'ECHO: "formforge-item", "name", 9, 9, 9, 9, 9, 9',
    'ECHO: "formforge-item", "bad id!", 0, 0, 0, 1, 1, 0',
    'ECHO: "formforge-item", "date", undef, 0, 0, 1, 1, 0',
    'ECHO: "something else", 1',
    'WARNING: unrelated'
  ]);
  assert.deepEqual(items.map(item => item.id), ['name', 'decorative_layers:0.1'], 'invalid, duplicate, and unrelated lines are skipped');
  assert.deepEqual(items[0], { id: 'name', center: [1.5, -2, 12], size: [120, 30], rotation: 15 });
});

test('item ids map to parameters or nested elements', () => {
  const parameters = [
    { name: 'name_x', type: 'number', default: 0 }, { name: 'name_y', type: 'number', default: 0 },
    { name: 'name_rot', type: 'number', default: 0 }, { name: 'name_size', type: 'number', default: 20 },
    { name: 'date_x', type: 'number', default: 0 },
    { name: 'decorative_layers', type: 'nested-tree', default: [] }
  ];
  assert.deepEqual(itemTarget('name', parameters), { kind: 'parameters', x: 'name_x', y: 'name_y', rotate: 'name_rot', size: 'name_size' });
  assert.equal(itemTarget('date', parameters), null, 'X and Y are both required');
  assert.deepEqual(itemTarget('decorative_layers:2.0', parameters), { kind: 'nested', tree: 'decorative_layers', path: [2, 0] });
  assert.equal(itemTarget('name_x:1', parameters), null);
});

test('plate count comes from a formforge-plates echo', () => {
  assert.equal(parsePlateCount(['ECHO: "formforge-item", "a", 0, 0, 0, 1, 1, 0', 'ECHO: "formforge-plates", 3']), 3);
  assert.equal(parsePlateCount(['ECHO: "formforge-plates", 500']), 64, 'capped');
  assert.equal(parsePlateCount(['ECHO: "formforge-plates", 0', 'ECHO: "formforge-plates", 1.5', 'ECHO: "formforge-plates", "2"']), null);
  assert.equal(parsePlateCount(['ECHO: "Keychains: 5 on 2 plate(s)"']), null);
});
