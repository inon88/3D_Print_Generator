const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const VERSION = '2026.10.11';
const BASE_URL = 'https://files.openscad.org/snapshots/';
const ARCHIVE = 'OpenSCAD-' + VERSION + '-WebAssembly-web.zip';
const ROOT = path.resolve(__dirname, '..');
const DESTINATION = path.join(ROOT, 'vendor', 'openscad-wasm');

function safePath(root, name) {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error('Unsafe archive path: ' + name);
  const result = path.resolve(root, ...normalized.split('/'));
  if (result !== root && !result.startsWith(root + path.sep)) throw new Error('Unsafe archive path: ' + name);
  return result;
}

async function extractZip(buffer, destination) {
  let eocd = -1;
  const lowerBound = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= lowerBound; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('OpenSCAD WASM archive has no ZIP directory.');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('OpenSCAD WASM archive has an invalid ZIP directory.');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error('Encrypted OpenSCAD WASM archives are not supported.');
    if (name.endsWith('/')) continue;
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method (' + method + ') for ' + name + '.');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP entry: ' + name);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const packed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(packed) : packed;
    if (data.length !== uncompressedSize) throw new Error('Corrupt ZIP entry: ' + name);
    const target = safePath(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
}

async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok) throw new Error('Download failed (' + response.status + '): ' + url);
  return Buffer.from(await response.arrayBuffer());
}

async function ensureModulePackage(directory) {
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n', 'utf8');
}

async function main() {
  try {
    await fs.access(path.join(DESTINATION, 'openscad.js'));
    await fs.access(path.join(DESTINATION, 'openscad.wasm'));
    await fs.access(path.join(DESTINATION, '.web-package'));
    await ensureModulePackage(DESTINATION);
    console.log('OpenSCAD WASM ' + VERSION + ' is ready.');
    return;
  } catch {}

  console.log('Downloading OpenSCAD WASM ' + VERSION + ' from the official OpenSCAD snapshots...');
  const [archive, checksumFile] = await Promise.all([
    fetchBytes(BASE_URL + ARCHIVE),
    fetchBytes(BASE_URL + ARCHIVE + '.sha256')
  ]);
  const expected = checksumFile.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error('OpenSCAD WASM checksum verification failed.');

  const staging = DESTINATION + '.tmp';
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  try {
    await extractZip(archive, staging);
    await fs.access(path.join(staging, 'openscad.js'));
    await fs.access(path.join(staging, 'openscad.wasm'));
    await fs.writeFile(path.join(staging, '.web-package'), VERSION, 'utf8');
    await ensureModulePackage(staging);
    await fs.mkdir(path.dirname(DESTINATION), { recursive: true });
    await fs.rm(DESTINATION, { recursive: true, force: true });
    await fs.rename(staging, DESTINATION);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  console.log('OpenSCAD WASM ' + VERSION + ' downloaded and verified.');
}

main().catch(error => {
  console.error('Could not prepare OpenSCAD WASM: ' + error.message);
  process.exitCode = 1;
});
