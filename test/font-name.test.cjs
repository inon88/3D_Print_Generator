const test = require('node:test');
const assert = require('node:assert/strict');
const { fontFamilyFromArrayBuffer } = require('../font-name.cjs');

function createFont(names) {
  const records = [];
  const strings = [];
  let stringLength = 0;
  for (const [nameId, value] of names) {
    const encoded = Buffer.from([...value].flatMap(character => [0, character.charCodeAt(0)]));
    records.push({ nameId, encoded, offset: stringLength });
    stringLength += encoded.length;
    strings.push(encoded);
  }
  const nameLength = 6 + records.length * 12 + stringLength;
  const font = Buffer.alloc(12 + 16 + nameLength);
  font.writeUInt16BE(1, 4);
  font.write('name', 12, 4, 'ascii');
  font.writeUInt32BE(28, 20);
  font.writeUInt32BE(nameLength, 24);
  font.writeUInt16BE(0, 28);
  font.writeUInt16BE(records.length, 30);
  font.writeUInt16BE(6 + records.length * 12, 32);
  records.forEach((record, index) => {
    const offset = 34 + index * 12;
    font.writeUInt16BE(3, offset);
    font.writeUInt16BE(1, offset + 2);
    font.writeUInt16BE(0x0409, offset + 4);
    font.writeUInt16BE(record.nameId, offset + 6);
    font.writeUInt16BE(record.encoded.length, offset + 8);
    font.writeUInt16BE(record.offset, offset + 10);
  });
  Buffer.concat(strings).copy(font, 34 + records.length * 12);
  return font;
}

test('reads the family and style from a local TrueType font', () => {
  const font = createFont([[1, 'Sample Sans'], [2, 'Bold']]);
  assert.equal(fontFamilyFromArrayBuffer(font), 'Sample Sans:style=Bold');
});

test('prefers typographic family names over legacy names', () => {
  const font = createFont([[1, 'Legacy Name'], [2, 'Regular'], [16, 'Modern Family'], [17, 'SemiBold']]);
  assert.equal(fontFamilyFromArrayBuffer(font), 'Modern Family:style=SemiBold');
});

test('rejects files without a font name table', () => {
  assert.throws(() => fontFamilyFromArrayBuffer(new Uint8Array(20)), /font names/);
});
