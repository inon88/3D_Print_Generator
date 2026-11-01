const fs = require('node:fs/promises');
const path = require('node:path');

function referencedAssetPaths(source) {
  let code = '';
  let quote = '';
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        code += '\n';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      code += character;
      if (character === '\\' && index + 1 < source.length) {
        code += source[++index];
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index++;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      index++;
    } else {
      code += character;
      if (character === '"' || character === "'") quote = character;
    }
  }

  const references = [];
  const assetCall = /\b(?:surface|import)\s*\(\s*(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\1/g;
  for (const match of code.matchAll(assetCall)) {
    references.push(match[2].replace(/\\(["'\\])/g, '$1'));
  }
  return [...new Set(references)];
}

async function findMissingReferencedAssets(source, sourceDirectory) {
  const missing = [];
  for (const reference of referencedAssetPaths(source)) {
    const assetPath = path.isAbsolute(reference)
      ? reference
      : path.resolve(sourceDirectory, reference);
    try {
      await fs.access(assetPath);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      missing.push(reference);
    }
  }
  return missing;
}

// Tools opt into one 3MF object per top-level statement (one per color part) with a
// "// @formforge-3mf-objects" line; OpenSCAD then exports with lazy-union.
function exportsSeparateObjects(source) {
  return /^[ \t]*\/\/[ \t]*@formforge-3mf-objects\b/m.test(source);
}

module.exports = { exportsSeparateObjects, findMissingReferencedAssets, referencedAssetPaths };
