// Palette editing for the layered SVG produced by image-trace.cjs:
// <svg …><g id="c0" fill="#RRGGBB">…paths…</g><g id="c1" …>…</g></svg>
// Pure string functions (no DOM), shared by the renderer and the tests. After every edit the
// layers are numbered c0, c1, … again, so a .scad file can keep importing them by id.

const LAYER = /<g id="c\d+" fill="(#[0-9A-Fa-f]{6})">([\s\S]*?)<\/g>/g;
const HEX = /^#[0-9A-Fa-f]{6}$/;

function parseLayers(svg) {
  const text = String(svg);
  const open = text.match(/^<svg\b[^>]*>/);
  if (!open || !text.endsWith('</svg>')) throw new Error('This is not a traced color image.');
  const layers = [...text.matchAll(LAYER)].map(match => ({ fill: match[1].toUpperCase(), body: match[2] }));
  if (!layers.length) throw new Error('This is not a traced color image.');
  return { header: open[0], layers };
}

function serializeLayers({ header, layers }) {
  return header + layers.map((layer, index) => `<g id="c${index}" fill="${layer.fill}">${layer.body}</g>`).join('') + '</svg>';
}

function result(parsed, areas) {
  return { svg: serializeLayers(parsed), colors: parsed.layers.map(layer => layer.fill), areas };
}

function checkIndex(parsed, index) {
  if (!Number.isInteger(index) || index < 0 || index >= parsed.layers.length) throw new Error('That color is no longer in the palette.');
}

function recolorLayer(svg, areas, index, hex) {
  const parsed = parseLayers(svg);
  checkIndex(parsed, index);
  if (!HEX.test(hex)) throw new Error('Choose a color as #RRGGBB.');
  parsed.layers[index].fill = hex.toUpperCase();
  return result(parsed, [...areas]);
}

// Moves the shapes of one color into another; the merged layer keeps the target's color.
function mergeLayers(svg, areas, from, into) {
  const parsed = parseLayers(svg);
  checkIndex(parsed, from);
  checkIndex(parsed, into);
  if (from === into) return result(parsed, [...areas]);
  parsed.layers[into].body += parsed.layers[from].body;
  const nextAreas = [...areas];
  nextAreas[into] = (nextAreas[into] || 0) + (nextAreas[from] || 0);
  parsed.layers.splice(from, 1);
  nextAreas.splice(from, 1);
  return result(parsed, nextAreas);
}

// Drops a color entirely (its shapes become empty space, like the removed background).
function removeLayer(svg, areas, index) {
  const parsed = parseLayers(svg);
  checkIndex(parsed, index);
  if (parsed.layers.length === 1) throw new Error('Keep at least one color.');
  parsed.layers.splice(index, 1);
  const nextAreas = [...areas];
  nextAreas.splice(index, 1);
  const total = nextAreas.reduce((sum, value) => sum + value, 0) || 1;
  return result(parsed, nextAreas.map(value => value / total));
}

module.exports = { parseLayers, serializeLayers, recolorLayer, mergeLayers, removeLayer };
