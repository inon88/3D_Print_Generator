const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLayers, recolorLayer, mergeLayers, removeLayer } = require('../svg-layers.cjs');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100.000mm" height="50.000mm" viewBox="0 0 200 100">'
  + '<g id="c0" fill="#DC1E28"><path d="M0 0L10 0L10 10Z"/></g>'
  + '<g id="c1" fill="#1E5AD2"><path d="M20 0L30 0L30 10Z"/><path d="M40 0L50 0L50 10Z"/></g>'
  + '<g id="c2" fill="#141414"><path d="M60 0L70 0L70 10Z"/></g>'
  + '</svg>';
const areas = [0.5, 0.3, 0.2];

test('parses the traced layer format', () => {
  const parsed = parseLayers(svg);
  assert.equal(parsed.layers.length, 3);
  assert.deepEqual(parsed.layers.map(layer => layer.fill), ['#DC1E28', '#1E5AD2', '#141414']);
  assert.throws(() => parseLayers('<svg><path d="M0 0Z"/></svg>'), /not a traced color image/);
  assert.throws(() => parseLayers('hello'), /not a traced color image/);
});

test('recolors a layer and validates the color', () => {
  const next = recolorLayer(svg, areas, 1, '#00ff00');
  assert.deepEqual(next.colors, ['#DC1E28', '#00FF00', '#141414']);
  assert.match(next.svg, /<g id="c1" fill="#00FF00"><path d="M20 0L30 0L30 10Z"\/><path d="M40 0L50 0L50 10Z"\/><\/g>/);
  assert.throws(() => recolorLayer(svg, areas, 1, 'green'), /#RRGGBB/);
  assert.throws(() => recolorLayer(svg, areas, 5, '#00FF00'), /no longer in the palette/);
});

test('merges a layer into another and renumbers the ids', () => {
  const next = mergeLayers(svg, areas, 2, 0);
  assert.deepEqual(next.colors, ['#DC1E28', '#1E5AD2']);
  assert.deepEqual(next.areas, [0.7, 0.3]);
  assert.match(next.svg, /<g id="c0" fill="#DC1E28"><path d="M0 0L10 0L10 10Z"\/><path d="M60 0L70 0L70 10Z"\/><\/g><g id="c1" fill="#1E5AD2">/);
  assert.doesNotMatch(next.svg, /id="c2"/);
  // Merging into a later layer keeps every path once.
  const forward = mergeLayers(svg, areas, 0, 2);
  assert.deepEqual(forward.colors, ['#1E5AD2', '#141414']);
  assert.equal((forward.svg.match(/<path/g) || []).length, 4);
});

test('removes a layer, renormalises the areas, and keeps at least one color', () => {
  const next = removeLayer(svg, areas, 0);
  assert.deepEqual(next.colors, ['#1E5AD2', '#141414']);
  assert.deepEqual(next.areas.map(value => Math.round(value * 100)), [60, 40]);
  assert.match(next.svg, /^<svg[^>]*><g id="c0" fill="#1E5AD2">/);
  const single = removeLayer(removeLayer(svg, areas, 0).svg, [0.6, 0.4], 0);
  assert.throws(() => removeLayer(single.svg, single.areas, 0), /at least one color/);
});
