function fontFamiliesFromArrayBuffer(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.byteLength < 12) throw new Error('The selected font file is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  const faceCount = signature === 'ttcf' ? view.getUint32(8) : 1;
  if (!faceCount || faceCount > 256 || (signature === 'ttcf' && 12 + faceCount * 4 > bytes.length)) {
    throw new Error('The selected font file has an invalid font collection.');
  }

  const families = [];
  for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
    const faceOffset = signature === 'ttcf' ? view.getUint32(12 + faceIndex * 4) : 0;
    if (faceOffset + 12 > bytes.length) continue;
    const tableCount = view.getUint16(faceOffset + 4);
    let nameOffset = -1;
    let nameLength = 0;
    for (let index = 0; index < tableCount; index++) {
      const record = faceOffset + 12 + index * 16;
      if (record + 16 > bytes.length) break;
      const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
      if (tag === 'name') {
        nameOffset = view.getUint32(record + 8);
        nameLength = view.getUint32(record + 12);
        break;
      }
    }
    if (nameOffset < 0 || nameOffset + nameLength > bytes.length || nameLength < 6) continue;

    const count = view.getUint16(nameOffset + 2);
    const stringOffset = view.getUint16(nameOffset + 4);
    const names = new Map();
    for (let index = 0; index < count; index++) {
      const record = nameOffset + 6 + index * 12;
      if (record + 12 > nameOffset + nameLength) break;
      const platform = view.getUint16(record);
      const language = view.getUint16(record + 4);
      const nameId = view.getUint16(record + 6);
      if (![1, 2, 16, 17, 4].includes(nameId) || (platform !== 0 && platform !== 3)) continue;
      const length = view.getUint16(record + 8);
      const offset = nameOffset + stringOffset + view.getUint16(record + 10);
      if (offset + length > bytes.length || length % 2 !== 0) continue;
      let value = '';
      for (let cursor = offset; cursor < offset + length; cursor += 2) value += String.fromCharCode(view.getUint16(cursor));
      value = value.replace(/\0/g, '').trim();
      if (!value) continue;
      const priority = (platform === 3 ? 4 : 2) + (language === 0x0409 ? 1 : 0);
      const previous = names.get(nameId);
      if (!previous || priority > previous.priority) names.set(nameId, { value, priority });
    }
    const family = names.get(16)?.value || names.get(1)?.value || names.get(4)?.value;
    if (!family) continue;
    const style = names.get(17)?.value || names.get(2)?.value;
    families.push(style && !/^regular$/i.test(style) ? family + ':style=' + style : family);
  }
  const unique = [...new Set(families)];
  if (!unique.length) throw new Error('The selected file does not contain readable font names.');
  return unique;
}

function fontFamilyFromArrayBuffer(source) {
  return fontFamiliesFromArrayBuffer(source)[0];
}

function fontSupportsOpenScadWasm(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  const faceCount = signature === 'ttcf' ? view.getUint32(8) : 1;
  if (!faceCount || faceCount > 256 || (signature === 'ttcf' && 12 + faceCount * 4 > bytes.length)) return false;

  for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
    const faceOffset = signature === 'ttcf' ? view.getUint32(12 + faceIndex * 4) : 0;
    if (faceOffset + 12 > bytes.length) return false;
    const tableCount = view.getUint16(faceOffset + 4);
    let hasTrueTypeOutlines = false;
    let hasHintProgram = false;
    for (let index = 0; index < tableCount; index++) {
      const record = faceOffset + 12 + index * 16;
      if (record + 16 > bytes.length) return false;
      const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
      const length = view.getUint32(record + 12);
      if (tag === 'glyf') hasTrueTypeOutlines = true;
      if (tag === 'fpgm' && length > 0) hasHintProgram = true;
    }
    // OpenSCAD WASM's FreeType build traps on TrueType outlines without a font program.
    if (hasTrueTypeOutlines && !hasHintProgram) return false;
  }
  return true;
}

module.exports = { fontFamilyFromArrayBuffer, fontFamiliesFromArrayBuffer, fontSupportsOpenScadWasm };
