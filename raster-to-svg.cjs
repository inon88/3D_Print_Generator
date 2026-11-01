function rasterToSvg(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width * height > 192 * 192 || rgba.length !== width * height * 4) {
    throw new Error('The selected image could not be converted to an icon.');
  }

  const luminance = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  let transparentPixels = 0;
  let borderLuminance = 0;
  let borderCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const pixel = index * 4;
      const alpha = rgba[pixel + 3];
      if (alpha < 240) transparentPixels++;
      const value = Math.round(0.2126 * rgba[pixel] + 0.7152 * rgba[pixel + 1] + 0.0722 * rgba[pixel + 2]);
      luminance[index] = value;
      histogram[value]++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        borderLuminance += value;
        borderCount++;
      }
    }
  }

  const hasTransparency = transparentPixels > width * height * 0.01;
  const threshold = otsuThreshold(histogram, width * height);
  const darkForeground = borderLuminance / borderCount > threshold;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) {
    const alpha = rgba[index * 4 + 3];
    mask[index] = hasTransparency
      ? Number(alpha >= 96)
      : Number(darkForeground ? luminance[index] <= threshold : luminance[index] > threshold);
  }

  const edges = [];
  const outgoing = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const start = `${x1},${y1}`;
    const edge = { x1, y1, x2, y2, start, end: `${x2},${y2}`, used: false };
    edges.push(edge);
    if (!outgoing.has(start)) outgoing.set(start, []);
    outgoing.get(start).push(edge);
  };
  const filled = (x, y) => x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const contours = [];
  for (const first of edges) {
    if (first.used) continue;
    const contour = [];
    let edge = first;
    while (!edge.used) {
      edge.used = true;
      contour.push([edge.x1, edge.y1]);
      if (edge.end === first.start) break;
      const candidates = (outgoing.get(edge.end) || []).filter(candidate => !candidate.used);
      if (!candidates.length) break;
      const direction = edgeDirection(edge);
      candidates.sort((left, right) => turnPriority(direction, edgeDirection(left)) - turnPriority(direction, edgeDirection(right)));
      edge = candidates[0];
    }
    const simplified = simplifyContour(contour);
    if (simplified.length >= 3 && Math.abs(signedArea(simplified)) >= 2) contours.push(simplified);
  }
  if (!contours.length) throw new Error('No clear icon shape was found. Choose an image with a high-contrast foreground and background.');

  const scale = 100 / Math.max(width, height);
  const xOffset = (100 - width * scale) / 2;
  const yOffset = (100 - height * scale) / 2;
  const paths = contours.map(contour => {
    const points = contour.map(([x, y]) => [
      (x * scale + xOffset).toFixed(2),
      (y * scale + yOffset).toFixed(2)
    ]);
    return `M${points[0][0]} ${points[0][1]}${points.slice(1).map(([x, y]) => `L${x} ${y}`).join('')}Z`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path fill="#000" fill-rule="evenodd" d="${paths.join('')}"/></svg>`;
}

function otsuThreshold(histogram, pixelCount) {
  let total = 0;
  for (let value = 0; value < histogram.length; value++) total += value * histogram[value];
  let backgroundCount = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let value = 0; value < histogram.length; value++) {
    backgroundCount += histogram[value];
    if (!backgroundCount) continue;
    const foregroundCount = pixelCount - backgroundCount;
    if (!foregroundCount) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundCount;
    const foregroundMean = (total - backgroundSum) / foregroundCount;
    const variance = backgroundCount * foregroundCount * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  return threshold;
}

function edgeDirection(edge) {
  if (edge.x2 > edge.x1) return 0;
  if (edge.y2 > edge.y1) return 1;
  if (edge.x2 < edge.x1) return 2;
  return 3;
}

function turnPriority(previous, next) {
  const turn = (next - previous + 4) % 4;
  return turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3;
}

function simplifyContour(points) {
  if (points.length < 4) return points;
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    return (point[0] - previous[0]) * (next[1] - point[1])
      !== (point[1] - previous[1]) * (next[0] - point[0]);
  });
}

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

module.exports = { rasterToSvg };
