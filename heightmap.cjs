// Image → grayscale heightmap PNG for OpenSCAD surface() reliefs (filament painting).
// surface() reads a PNG as one point per pixel with height = brightness 0..100 and puts the
// solid's base 1 unit below the darkest pixel, so every heightmap gets a 1 px black border:
// the base then always sits at the lowest level and the relief keeps its full height range.
// Pure functions without Node or DOM dependencies, shared by the renderer and the main process.

const HEIGHTMAP_LIMITS = Object.freeze({ minSide: 8, maxSide: 600, maxBytes: 2 * 1024 * 1024 });
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// rgba: width*height*4 bytes. Returns { width, height, gray } with the border included
// (width + 2 by height + 2). Transparent pixels count as black (lowest).
function prepareHeightmap(rgba, width, height, { autoLevels = true, gamma = 1, invert = false } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error('The selected image could not be read.');
  }
  if (!(gamma > 0)) throw new Error('Invalid gamma.');
  const luminance = new Float32Array(width * height);
  for (let index = 0; index < luminance.length; index++) {
    const pixel = index * 4;
    const alpha = rgba[pixel + 3] / 255;
    const value = (0.2126 * rgba[pixel] + 0.7152 * rgba[pixel + 1] + 0.0722 * rgba[pixel + 2]) / 255;
    luminance[index] = invert ? (1 - value) * alpha : value * alpha;
  }
  // Auto levels stretch the 1st..99th percentile to the full range, like a photo editor.
  let low = 0;
  let high = 1;
  if (autoLevels) {
    const sorted = Float32Array.from(luminance).sort();
    low = sorted[Math.floor((sorted.length - 1) * 0.01)];
    high = sorted[Math.ceil((sorted.length - 1) * 0.99)];
    if (high - low < 1e-3) { low = 0; high = 1; }
  }
  const outWidth = width + 2;
  const outHeight = height + 2;
  const gray = new Uint8Array(outWidth * outHeight);   // border stays 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, Math.max(0, (luminance[y * width + x] - low) / (high - low)));
      gray[(y + 1) * outWidth + x + 1] = Math.round(255 * Math.pow(t, gamma));
    }
  }
  return { width: outWidth, height: outHeight, gray };
}

// --- minimal PNG (8-bit grayscale) writer and checker -------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

const u32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];

function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function pngChunk(type, data) {
  const body = concatBytes([Uint8Array.from([...type].map(character => character.charCodeAt(0))), data]);
  return concatBytes([Uint8Array.from(u32(data.length)), body, Uint8Array.from(u32(crc32(body)))]);
}

// zlib stream with stored (uncompressed) blocks: no compression library is needed in the
// sandboxed renderer, and heightmaps are small (600 x 600 px is about 360 KB).
function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let block = 0; block < blocks; block++) {
    const start = block * 65535;
    const length = Math.min(65535, raw.length - start);
    out[at] = block === blocks - 1 ? 1 : 0;
    out[at + 1] = length & 255;
    out[at + 2] = length >>> 8;
    out[at + 3] = ~length & 255;
    out[at + 4] = (~length >>> 8) & 255;
    out.set(raw.subarray(start, start + length), at + 5);
    at += 5 + length;
  }
  out.set(u32(adler32(raw)), at);
  return out;
}

function encodeGrayPng({ width, height, gray }) {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const header = Uint8Array.from([...u32(width), ...u32(height), 8, 0, 0, 0, 0]);
  return concatBytes([Uint8Array.from(PNG_SIGNATURE), pngChunk('IHDR', header), pngChunk('IDAT', zlibStored(raw)), pngChunk('IEND', new Uint8Array(0))]);
}

// Checks the PNG header the main process writes as an asset: 8-bit grayscale within limits.
function validateHeightmapPng(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
  const fail = () => { throw new Error('The relief image could not be saved.'); };
  if (!data || data.length < 33 || data.length > HEIGHTMAP_LIMITS.maxBytes) fail();
  if (PNG_SIGNATURE.some((byte, index) => data[index] !== byte)) fail();
  const type = String.fromCharCode(...data.subarray(12, 16));
  const read = offset => ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
  const width = read(16);
  const height = read(20);
  if (type !== 'IHDR' || data[24] !== 8 || data[25] !== 0) fail();
  if (width < HEIGHTMAP_LIMITS.minSide || height < HEIGHTMAP_LIMITS.minSide
    || width > HEIGHTMAP_LIMITS.maxSide + 2 || height > HEIGHTMAP_LIMITS.maxSide + 2) fail();
  return { data, width, height };
}

module.exports = { HEIGHTMAP_LIMITS, prepareHeightmap, encodeGrayPng, validateHeightmapPng };
