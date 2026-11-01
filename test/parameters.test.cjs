const test = require('node:test');
const assert = require('node:assert/strict');
const { parseParameters, isFontParameterName } = require('../parameters.cjs');

test('parses two-part and three-part numeric customizer ranges', () => {
  const parameters = parseParameters(`
/* [Dimensions] */
length = 80; // [10:300]
thickness = 6; // [3:0.5:12]
`);

  assert.deepEqual(parameters.map(({ name, type, default: defaultValue, min, step, max, options }) => ({
    name, type, default: defaultValue, min, step, max, options
  })), [
    { name: 'length', type: 'number', default: 80, min: 10, step: 1, max: 300, options: undefined },
    { name: 'thickness', type: 'number', default: 6, min: 3, step: 0.5, max: 12, options: undefined }
  ]);
});

test('parses quoted dropdown options and booleans', () => {
  const parameters = parseParameters(`
part = "ASSEMBLY"; // ["ASSEMBLY","UPPER","BASE"]
enabled = true;
`);

  assert.equal(parameters[0].default, 'ASSEMBLY');
  assert.deepEqual(parameters[0].options, ['ASSEMBLY', 'UPPER', 'BASE']);
  assert.equal(parameters[1].type, 'boolean');
  assert.equal(parameters[1].default, true);
});

test('parses labeled numeric customizer options as numeric values', () => {
  const [parameter] = parseParameters(`
length = 50; // [70:large,50:medium,30:small]
`);

  assert.equal(parameter.type, 'number');
  assert.equal(parameter.default, 50);
  assert.deepEqual(parameter.options, [70, 50, 30]);
  assert.deepEqual(parameter.optionLabels, ['large', 'medium', 'small']);
});

test('parses quoted choices containing commas without splitting inside quotes', () => {
  const [parameter] = parseParameters(`
shape = "round, wide"; // ["round, wide":"Rounded", "square":"Square"]
`);

  assert.deepEqual(parameter.options, ['round, wide', 'square']);
  assert.deepEqual(parameter.optionLabels, ['Rounded', 'Square']);
});

test('uses only the comment directly above an assignment as its description', () => {
  const parameters = parseParameters(`
// File header that describes the whole model.

/* [Text] */
name = "JESSICA";
// Height of the letters
font_size_mm = 20; // [10:1:32]
`);

  assert.equal(parameters[0].description, '');
  assert.equal(parameters[0].group, 'Text');
  assert.equal(parameters[1].description, 'Height of the letters');
});

test('ignores local assignments inside modules and invalid vector expressions', () => {
  const parameters = parseParameters(`
top_level = 10;
module generated() {
  local_value = 42;
  points = [for (i = [0:3]) i];
}
`);

  assert.deepEqual(parameters.map(parameter => parameter.name), ['top_level']);
});

test('nested tree marker accepts tool icons and a default tree', () => {
  const [tree, font] = parseParameters(`
// @formforge-nested-tree max-depth=2 icons=Rainbow, Cloud,Moon
// @formforge-nested-default [{"type":"Icon","icon":"Cloud","x":200,"rotation":30,"color":"#ffffff","children":[{"type":"Text","text":"Hi","children":[{"type":"Text"}]}]}]
decorative_layers = [];
name_font = "Liberation Serif";
`);
  assert.equal(tree.type, 'nested-tree');
  assert.deepEqual(tree.icons, ['Rainbow', 'Cloud', 'Moon']);
  assert.equal(tree.default.length, 1);
  assert.equal(tree.default[0].icon, 'Cloud');
  assert.equal(tree.default[0].x, 128, 'positions are clamped to the plate');
  assert.equal(tree.default[0].rotation, 30);
  assert.equal(tree.default[0].children[0].text, 'Hi');
  assert.deepEqual(tree.default[0].children[0].children, [], 'deeper levels than max-depth are dropped');
  assert.equal(font.type, 'string');
  assert.ok(isFontParameterName('name_font') && isFontParameterName('font_name') && !isFontParameterName('fontsize'));
});

test('nested tree without options keeps the built-in icons and example tree', () => {
  const [tree] = parseParameters('// @formforge-nested-tree max-depth=4\ndecorative_layers = [];');
  assert.equal(tree.icons, undefined);
  assert.equal(tree.default[0].text, 'Love');
  assert.equal(tree.default[0].rotation, 0);
});
