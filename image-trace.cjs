// Color tracing of raster images into layered SVG for OpenSCAD.
// vtracer (WASM) produces one path per color region; this module merges near-identical
// colors, optionally drops the background, and groups the paths as <g id="c0">, <g id="c1">…
// so a .scad file can import every color with import(file, id = "cN"). Importing the file
// without an id still yields the union of all layers, i.e. a plain silhouette.

// maxColors 0 means automatic: the palette keeps every clearly different color, up to the maximum.
const TRACE_LIMITS = Object.freeze({ maxPixels: 2048 * 2048, minColors: 2, maxColors: 12 });
const TRACE_DETAILS = Object.freeze(['low', 'medium', 'high']);
// Colors closer than this (RGB distance) are anti-aliasing variants of the same color.
const MERGE_DISTANCE = 28;
// Automatic palettes also fold shades that a printed part would not distinguish.
const AUTO_MERGE_DISTANCE = 48;
// Speck filter per detail level: specks smaller than about 1/n of the image size are absorbed by
// their neighbours (like Vector Magic's detail setting).
const SPECKLE_DIVISOR = Object.freeze({ low: 36, medium: 64, high: 128 });

function validateTraceRequest(rgba, width, height, options) {
  const bytes = rgba instanceof Uint8Array ? rgba
    : rgba instanceof ArrayBuffer ? new Uint8Array(rgba)
    : null;
  if (!bytes || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width * height > TRACE_LIMITS.maxPixels || bytes.length !== width * height * 4) {
    throw new Error('The selected image could not be read for tracing.');
  }
  const maxColors = options?.maxColors;
  if (!Number.isInteger(maxColors) || (maxColors !== 0 && (maxColors < TRACE_LIMITS.minColors || maxColors > TRACE_LIMITS.maxColors))) {
    throw new Error(`Choose Auto or between ${TRACE_LIMITS.minColors} and ${TRACE_LIMITS.maxColors} colors.`);
  }
  if (typeof options.removeBackground !== 'boolean') throw new Error('Invalid background option.');
  const detail = options.detail ?? 'medium';
  if (!TRACE_DETAILS.includes(detail)) throw new Error('Invalid detail level.');
  return { rgba: bytes, width, height, maxColors, removeBackground: options.removeBackground, detail };
}

function traceOptions(width, height, maxColors, removeBackground, detail = 'medium') {
  return {
    hierarchical: 'cutout',          // regions do not overlap, so every layer is exact
    // Straight segments stay within ~0.05 mm of the spline output on a 100 mm image, but
    // OpenSCAD splits every spline curve into many pieces: a traced logo rendered ~80x slower
    // (48 s vs 0.6 s for an outlined badge) with mode 'spline'.
    mode: 'polygon',
    // vtracer's quantizer blends distinct colors when the target is small (e.g. blue and black
    // become one navy), so trace with headroom and let mergeClusters reduce to maxColors.
    // One extra color is reserved for the background, which is dropped afterwards.
    maxColors: maxColors === 0 ? 16 : Math.min(16, maxColors * 2 + (removeBackground ? 2 : 1)),
    filterSpeckle: Math.max(2, Math.round(Math.sqrt(width * height) / SPECKLE_DIVISOR[detail])),
    pathPrecision: 2
  };
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function colorDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

// Counts opaque pixels (overall and on the border) per nearest traced color.
function countPixels(rgba, width, height, colors) {
  const total = new Array(colors.length).fill(0);
  const border = new Array(colors.length).fill(0);
  let borderPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (onBorder) borderPixels++;
      if (rgba[index + 3] < 128) continue;
      let best = 0;
      let bestDistance = Infinity;
      for (let color = 0; color < colors.length; color++) {
        const distance = colorDistance(colors[color], [rgba[index], rgba[index + 1], rgba[index + 2]]);
        if (distance < bestDistance) { bestDistance = distance; best = color; }
      }
      total[best]++;
      if (onBorder) border[best]++;
    }
  }
  return { total, border, borderPixels };
}

// Merges the closest pair of colors (into the larger one) while any pair is closer than
// minDistance or there are more clusters than the limit, so no region is ever dropped.
function mergeClusters(input, limit, minDistance = MERGE_DISTANCE) {
  let clusters = input;
  for (;;) {
    let pair = null;
    for (let left = 0; left < clusters.length; left++) {
      for (let right = left + 1; right < clusters.length; right++) {
        const distance = colorDistance(clusters[left].rgb, clusters[right].rgb);
        if (!pair || distance < pair.distance) pair = { left, right, distance };
      }
    }
    if (!pair || (pair.distance >= minDistance && clusters.length <= limit)) return clusters;
    const [keep, drop] = clusters[pair.left].pixels >= clusters[pair.right].pixels
      ? [clusters[pair.left], clusters[pair.right]]
      : [clusters[pair.right], clusters[pair.left]];
    keep.members.push(...drop.members);
    keep.pixels += drop.pixels;
    keep.border += drop.border;
    clusters = clusters.filter(cluster => cluster !== drop);
  }
}

function buildLayeredSvg(rawSvg, rgba, width, height, { maxColors, removeBackground }) {
  const paths = [...String(rawSvg).matchAll(/<path\b[^>]*>/g)].map(match => {
    const element = match[0];
    const fill = (element.match(/\sfill="(#[0-9a-fA-F]{6})"/) || [])[1];
    return fill ? { fill: fill.toUpperCase(), element: element.replace(/\sfill="[^"]*"/, '').replace(/\s*\/?>$/, '/>') } : null;
  }).filter(Boolean);
  if (!paths.length) throw new Error('No shapes were found in the image. Try more colors or an image with clearer contrast.');

  const fills = [...new Set(paths.map(path => path.fill))];
  const rgb = fills.map(hexToRgb);
  const { total, border, borderPixels } = countPixels(rgba, width, height, rgb);
  // Each cluster keeps the exact traced color of its largest member.
  let clusters = fills.map((fill, index) => ({ fill, rgb: rgb[index], members: [fill], pixels: total[index], border: border[index] }));

  const limit = maxColors === 0 ? TRACE_LIMITS.maxColors : maxColors;
  const distance = maxColors === 0 ? AUTO_MERGE_DISTANCE : MERGE_DISTANCE;
  clusters = mergeClusters(clusters, removeBackground ? limit + 1 : limit, distance);
  if (removeBackground) {
    // Opaque images: the color covering most of the border is the background.
    // Transparent pixels are never traced, so a transparent background is already gone.
    const background = clusters.reduce((best, cluster) => (cluster.border > best.border ? cluster : best));
    if (background.border >= borderPixels * 0.5) clusters = clusters.filter(cluster => cluster !== background);
  }
  clusters = mergeClusters(clusters, limit, distance);
  clusters.sort((left, right) => right.pixels - left.pixels);
  const opaquePixels = clusters.reduce((sum, cluster) => sum + cluster.pixels, 0) || 1;

  const layerOf = new Map();
  clusters.forEach((cluster, index) => cluster.members.forEach(fill => layerOf.set(fill, index)));
  const groups = clusters.map(() => []);
  for (const path of paths) {
    const layer = layerOf.get(path.fill);
    if (layer !== undefined) groups[layer].push(path.element);
  }
  if (!groups.some(group => group.length)) throw new Error('Only background was found in the image. Turn off "Remove background" or choose another image.');

  // Longest side is 100 mm, matching the silhouette converter.
  const scale = 100 / Math.max(width, height);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" '
    + `width="${(width * scale).toFixed(3)}mm" height="${(height * scale).toFixed(3)}mm" viewBox="0 0 ${width} ${height}">`
    + clusters.map((cluster, index) => `<g id="c${index}" fill="${cluster.fill}">${groups[index].join('')}</g>`).join('')
    + '</svg>';
  return {
    svg,
    colors: clusters.map(cluster => cluster.fill),
    // Share of the kept artwork covered by each layer, for the palette editor.
    areas: clusters.map(cluster => cluster.pixels / opaquePixels)
  };
}

function traceImage({ rgba, width, height, maxColors, removeBackground, detail = 'medium' }) {
  const vtracer = require('@visioncortex/vtracer');
  const raw = vtracer.convertPixels(rgba, width, height, traceOptions(width, height, maxColors, removeBackground, detail));
  return buildLayeredSvg(raw, rgba, width, height, { maxColors, removeBackground });
}

module.exports = { TRACE_LIMITS, TRACE_DETAILS, validateTraceRequest, traceOptions, buildLayeredSvg, traceImage };
