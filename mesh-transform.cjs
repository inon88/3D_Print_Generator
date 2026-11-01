// Applies the viewport transform (see transform.cjs) to the meshes OpenSCAD exports.
// STL: vertices and facet normals are rewritten. 3MF: the matrix is composed into each build <item transform>,
// so mesh data and colors stay byte-for-byte untouched. Only used when the app transform is not identity.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { exportMatrix, multiply, identity, transformPoint } = require('./transform.cjs');

function applyTransformToStl(buffer, transform) {
  const source = Buffer.from(buffer);
  if (source.length < 84) throw new Error('The exported STL is too small to transform.');
  const count = source.readUInt32LE(80);
  if (84 + count * 50 !== source.length) throw new Error('Only binary STL files can be transformed.');
  const visit = callback => {
    for (let index = 0; index < count; index++) {
      const offset = 84 + index * 50 + 12;
      for (let vertex = 0; vertex < 3; vertex++) {
        const at = offset + vertex * 12;
        callback(source.readFloatLE(at), source.readFloatLE(at + 4), source.readFloatLE(at + 8));
      }
    }
  };
  const matrix = exportMatrix(visit, transform);
  if (!matrix) return source;
  const output = Buffer.from(source);
  for (let index = 0; index < count; index++) {
    const facet = 84 + index * 50;
    const points = [0, 1, 2].map(vertex => {
      const at = facet + 12 + vertex * 12;
      return transformPoint(matrix, source.readFloatLE(at), source.readFloatLE(at + 4), source.readFloatLE(at + 8));
    });
    points.forEach((point, vertex) => point.forEach((value, axis) => output.writeFloatLE(value, facet + 12 + vertex * 12 + axis * 4)));
    // Recompute the normal: non-uniform scale does not preserve normals.
    const u = [0, 1, 2].map(axis => points[1][axis] - points[0][axis]);
    const v = [0, 1, 2].map(axis => points[2][axis] - points[0][axis]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal) || 1;
    normal.forEach((value, axis) => output.writeFloatLE(value / length, facet + axis * 4));
  }
  return output;
}

// --- Minimal ZIP reader (incl. ZIP64, as written by lib3mf) and writer -------------------------------------

function readZip(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('The exported 3MF is not a valid ZIP archive.');
  let entryCount = buffer.readUInt16LE(end + 10);
  let directoryOffset = buffer.readUInt32LE(end + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    const locator = end - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== 0x07064b50) throw new Error('The exported 3MF has an invalid ZIP64 directory.');
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(record) !== 0x06064b50) throw new Error('The exported 3MF has an invalid ZIP64 directory.');
    entryCount = Number(buffer.readBigUInt64LE(record + 32));
    directoryOffset = Number(buffer.readBigUInt64LE(record + 48));
  }
  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The exported 3MF has a damaged ZIP directory.');
    const method = buffer.readUInt16LE(offset + 10);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    // ZIP64 extra field: values that are 0xFFFFFFFF above follow in this fixed order.
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) { size = Number(buffer.readBigUInt64LE(field)); field += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(buffer.readBigUInt64LE(field)); field += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(buffer.readBigUInt64LE(field)); }
      }
      extra += 4 + length;
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('The exported 3MF has a damaged ZIP entry.');
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error('The exported 3MF uses an unsupported ZIP compression method.');
    if (data.length !== size) throw new Error('The exported 3MF has a damaged ZIP entry.');
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    if (compressed.length >= 0xffffffff || data.length >= 0xffffffff || offset >= 0xffffffff) {
      throw new Error('The transformed 3MF is too large.');
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const directoryBuffer = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBuffer, end]);
}

// --- 3MF ---------------------------------------------------------------------------------------------------

function attribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match ? match[1] : null;
}

// 3MF stores "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" for row vectors; we use column vectors.
function parse3mfMatrix(value) {
  if (!value) return identity();
  const v = value.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some(item => !Number.isFinite(item))) throw new Error('The exported 3MF has an invalid transform.');
  return [v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1];
}

function format3mfMatrix(m) {
  return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10], m[3], m[7], m[11]]
    .map(value => {
      const rounded = Math.abs(value) < 1e-12 ? 0 : Number(value.toPrecision(15));
      return String(rounded);
    })
    .join(' ');
}

function parseModel(xml) {
  const objects = new Map();
  const objectPattern = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  for (let match; (match = objectPattern.exec(xml));) {
    const id = attribute(match[1], 'id');
    const body = match[2];
    const vertices = [];
    const vertexPattern = /<vertex\b([^>]*?)\/?>/g;
    for (let vertex; (vertex = vertexPattern.exec(body));) {
      vertices.push([Number(attribute(vertex[1], 'x')), Number(attribute(vertex[1], 'y')), Number(attribute(vertex[1], 'z'))]);
    }
    const components = [];
    const componentPattern = /<component\b([^>]*?)\/?>/g;
    for (let component; (component = componentPattern.exec(body));) {
      components.push({ objectId: attribute(component[1], 'objectid'), matrix: parse3mfMatrix(attribute(component[1], 'transform')) });
    }
    objects.set(id, { vertices, components });
  }
  return objects;
}

function applyTransformTo3mf(buffer, transform) {
  const entries = readZip(Buffer.from(buffer));
  const models = entries.filter(entry => /^3D\/.+\.model$/i.test(entry.name));
  if (!models.length) throw new Error('The exported 3MF contains no model.');
  for (const entry of models) {
    const xml = entry.data.toString('utf8');
    const objects = parseModel(xml);
    const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
    if (!build) continue;
    const items = [...build[1].matchAll(/<item\b([^>]*?)\/?>/g)].map(match => ({
      objectId: attribute(match[1], 'objectid'),
      matrix: parse3mfMatrix(attribute(match[1], 'transform'))
    }));
    const visitObject = (id, matrix, callback, depth = 0) => {
      const object = objects.get(id);
      if (!object || depth > 16) return;
      for (const [x, y, z] of object.vertices) callback(...transformPoint(matrix, x, y, z));
      for (const component of object.components) visitObject(component.objectId, multiply(matrix, component.matrix), callback, depth + 1);
    };
    const matrix = exportMatrix(callback => items.forEach(item => visitObject(item.objectId, item.matrix, callback)), transform);
    if (!matrix) continue;
    const updatedBuild = build[0].replace(/<item\b([^>]*?)(\/?)>/g, (_whole, attributes, selfClosing) => {
      const combined = multiply(matrix, parse3mfMatrix(attribute(attributes, 'transform')));
      const rest = attributes.replace(/\s+transform\s*=\s*"[^"]*"/, '');
      return `<item${rest} transform="${format3mfMatrix(combined)}"${selfClosing}>`;
    });
    entry.data = Buffer.from(xml.slice(0, build.index) + updatedBuild + xml.slice(build.index + build[0].length), 'utf8');
  }
  return writeZip(entries);
}

// Multi-color tools export one 3MF object per color part, each with its own build item, and slicers drop
// every item to the plate on its own. Wrapping them as components of a single object keeps the parts in
// place: the slicer loads one object whose parts keep their own color/filament.
function groupObjectsAsParts(buffer, name = 'Model') {
  const entries = readZip(Buffer.from(buffer));
  let changed = false;
  for (const entry of entries.filter(item => /^3D\/.+\.model$/i.test(item.name))) {
    const xml = entry.data.toString('utf8');
    const build = /<build\b([^>]*)>([\s\S]*?)<\/build>/.exec(xml);
    const resourcesEnd = xml.lastIndexOf('</resources>');
    if (!build || resourcesEnd < 0) continue;
    const items = [...build[2].matchAll(/<item\b([^>]*?)\/?>/g)].map(match => ({
      objectId: attribute(match[1], 'objectid'),
      transform: attribute(match[1], 'transform')
    }));
    if (items.length < 2) continue;
    const ids = [...xml.matchAll(/<(?:object|basematerials|colorgroup|texture2d|texture2dgroup|compositematerials|multiproperties)\b[^>]*\sid\s*=\s*"(\d+)"/g)].map(match => Number(match[1]));
    const groupId = Math.max(0, ...ids) + 1;
    const usesProduction = /xmlns:p\s*=/.test(xml);
    const uuid = () => (usesProduction ? ` p:UUID="${crypto.randomUUID()}"` : '');
    const components = items.map(item => `\t\t\t\t<component objectid="${item.objectId}"${item.transform ? ` transform="${item.transform}"` : ''}${uuid()}/>`).join('\n');
    const safeName = String(name).replace(/[<>&"]/g, '');
    const group = `\t\t<object id="${groupId}" name="${safeName}" type="model"${uuid()}>\n\t\t\t<components>\n${components}\n\t\t\t</components>\n\t\t</object>\n\t`;
    const newBuild = `<build${build[1]}>\n\t\t<item objectid="${groupId}"${uuid()}/>\n\t</build>`;
    entry.data = Buffer.from(xml.slice(0, resourcesEnd) + group + xml.slice(resourcesEnd, build.index) + newBuild + xml.slice(build.index + build[0].length), 'utf8');
    changed = true;
  }
  return changed ? writeZip(entries) : buffer;
}

function applyMeshTransform(buffer, format, transform) {
  if (!transform) return buffer;
  return format === '3mf' ? applyTransformTo3mf(buffer, transform) : applyTransformToStl(buffer, transform);
}

module.exports = { applyMeshTransform, applyTransformToStl, applyTransformTo3mf, groupObjectsAsParts, readZip, writeZip, parse3mfMatrix, format3mfMatrix };
