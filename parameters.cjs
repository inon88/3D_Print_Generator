const PARAMETER_PARSER_VERSION = 6;

// Built-in icons of a nested tree unless the marker lists the tool's own (icons=A,B,…).
const NESTED_TREE_ICONS = ['Star', 'Heart', 'Flower', 'Diamond', 'Plus', 'Lightning', 'Balloon', 'Crown'];
const NESTED_DEFAULT_FONT = 'Liberation Sans:style=Bold';

// font_name plus extra font pickers such as name_font.
function isFontParameterName(name) {
  return name === 'font_name' || /^[A-Za-z]\w*_font$/.test(String(name));
}

function nestedTreeDefault() {
  return [{
    type: 'Text', text: 'Love', font: NESTED_DEFAULT_FONT, icon: 'Star', svgPath: '',
    x: 0, y: 0, size: 34, thickness: 2, bold: 0.4, placement: 'Above', overlap: 0, rotation: 0,
    children: [{
      type: 'SVG', text: 'SVG', font: NESTED_DEFAULT_FONT, icon: 'Heart', svgPath: '',
      x: 8, y: 8, size: 24, thickness: 1.6, bold: 0, placement: 'Above', overlap: 0, rotation: 0,
      children: [{
        type: 'Icon', text: 'Icon', font: NESTED_DEFAULT_FONT, icon: 'Star', svgPath: '',
        x: 4, y: 4, size: 15, thickness: 1.2, bold: 0.2, placement: 'Inset', overlap: 0.8, rotation: 0,
        children: [{
          type: 'Text', text: '4', font: NESTED_DEFAULT_FONT, icon: 'Star', svgPath: '',
          x: 2, y: 2, size: 8, thickness: 0.8, bold: 0.1, placement: 'Above', overlap: 0, rotation: 0,
          children: []
        }]
      }]
    }]
  }];
}

// Tool-supplied default tree (// @formforge-nested-default [...]): missing fields get safe defaults,
// numbers are clamped to the editor's ranges. Returns null when the JSON is unusable.
function normalizeNestedDefault(json, icons, maxDepth) {
  let tree;
  try { tree = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(tree) || !tree.length) return null;
  let count = 0;
  const number = (value, fallback, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
  const normalizeList = (nodes, depth) => (depth > maxDepth || !Array.isArray(nodes) ? [] : nodes.filter(node => node && typeof node === 'object' && !Array.isArray(node) && ++count <= 200).map(node => ({
    type: ['Text', 'SVG', 'Icon'].includes(node.type) ? node.type : 'Text',
    text: typeof node.text === 'string' ? node.text.slice(0, 500) : 'Text',
    font: typeof node.font === 'string' && node.font ? node.font.slice(0, 250) : NESTED_DEFAULT_FONT,
    icon: icons.includes(node.icon) ? node.icon : icons[0],
    svgPath: '',
    x: number(node.x, 0, -128, 128),
    y: number(node.y, 0, -128, 128),
    size: number(node.size, 24, 1, 210),
    thickness: number(node.thickness, 1.6, 0.4, 20),
    bold: number(node.bold, 0, 0, 8),
    placement: node.placement === 'Inset' ? 'Inset' : 'Above',
    overlap: number(node.overlap, 0, 0, 20),
    rotation: number(node.rotation, 0, -180, 180),
    color: typeof node.color === 'string' && /^#[0-9a-f]{6}$/i.test(node.color) ? node.color : '#111827',
    children: normalizeList(node.children, depth + 1)
  })));
  const normalized = normalizeList(tree, 1);
  return normalized.length ? normalized : null;
}

function parseParameters(source) {
  const parameters = [];
  let group = 'Parameters';
  let description = '';
  let nestedTreeDepth = null;
  let nestedTreeIcons = null;
  let nestedTreeDefaultJson = null;
  const lines = source.split(/\r?\n/);
  const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*;\s*(?:\/\/\s*(.*))?$/;
  let braceDepth = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const nestedTree = line.match(/^\s*\/\/\s*@formforge-nested-tree\s+max-depth\s*=\s*(\d+)(?:\s+icons\s*=\s*([A-Za-z][\w ]*(?:,\s*[A-Za-z][\w ]*)*))?\s*$/i);
    if (nestedTree) {
      nestedTreeDepth = Math.max(1, Math.min(4, Number(nestedTree[1])));
      const icons = nestedTree[2] ? [...new Set(nestedTree[2].split(',').map(icon => icon.trim()).filter(Boolean))].slice(0, 64) : null;
      nestedTreeIcons = icons?.length ? icons : null;
      continue;
    }
    const nestedDefault = line.match(/^\s*\/\/\s*@formforge-nested-default\s+(\[.*\])\s*$/i);
    if (nestedDefault) {
      nestedTreeDefaultJson = nestedDefault[1];
      continue;
    }
    const section = line.match(/^\s*\/\*\s*\[([^\]]+)\]\s*\*\/\s*$/);
    if (section) {
      group = section[1].trim();
      description = '';
      continue;
    }
    const isTopLevel = braceDepth === 0 && !inBlockComment;
    // Like the OpenSCAD Customizer, only a comment directly above an assignment describes it.
    if (isTopLevel && /^\s*$/.test(line)) description = '';
    const comment = line.match(/^\s*\/\/\s*(.+)$/);
    if (isTopLevel && comment) {
      description = comment[1].trim();
      const updatedDepth = updateBraceDepth(line, braceDepth, inBlockComment);
      braceDepth = updatedDepth.depth;
      inBlockComment = updatedDepth.inBlockComment;
      continue;
    }
    const parsed = isTopLevel ? line.match(assignment) : null;
    if (parsed) {
      const [, name, expression, annotation = ''] = parsed;
      let value;
      let type;
      const raw = expression.trim();
      if (nestedTreeDepth !== null && raw === '[]') {
        type = 'nested-tree';
        value = (nestedTreeDefaultJson && normalizeNestedDefault(nestedTreeDefaultJson, nestedTreeIcons || NESTED_TREE_ICONS, nestedTreeDepth)) || nestedTreeDefault();
      } else if (/^(true|false)$/.test(raw)) {
        type = 'boolean';
        value = raw === 'true';
      } else if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
        type = 'number';
        value = Number(raw);
      } else if (/^"(?:\\.|[^"\\])*"$/.test(raw) || /^'(?:\\.|[^'\\])*'$/.test(raw)) {
        type = 'string';
        value = raw.slice(1, -1);
      } else if (/^\[.*\]$/.test(raw)) {
        const vector = raw.slice(1, -1).split(',').map(part => Number(part.trim()));
        if (vector.length && vector.every(Number.isFinite)) {
          type = 'vector';
          value = vector;
        }
      }

      if (type) {
        const range = annotation.match(/\[\s*(-?\d+(?:\.\d+)?)\s*:\s*(?:(-?\d+(?:\.\d+)?)\s*:\s*)?(-?\d+(?:\.\d+)?)\s*\]/);
        const choices = annotation.match(/\[([^\]]+)\]/);
        let options = null;
        let optionLabels = null;
        if (choices && !range) {
          const parsedChoices = parseCustomizerChoices(choices[1], type);
          options = parsedChoices.map(choice => choice.value);
          if (parsedChoices.some(choice => choice.label !== String(choice.value))) {
            optionLabels = parsedChoices.map(choice => choice.label);
          }
          if (!options.length) options = null;
        }
        const minimum = range ? Number(range[1]) : undefined;
        const maximum = range ? Number(range[3]) : undefined;
        const step = range
          ? Number(range[2] ?? (Number.isInteger(minimum) && Number.isInteger(maximum)
            ? 1
            : Math.min(1, (maximum - minimum) / 100)))
          : undefined;
        parameters.push({
          name,
          label: name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, character => character.toUpperCase()),
          type,
          default: value,
          group,
          description,
          ...(range ? { min: minimum, step, max: maximum } : {}),
          ...(options ? { options } : {}),
          ...(optionLabels ? { optionLabels } : {}),
          source: 'scad',
          ...(type === 'nested-tree' ? { maxDepth: nestedTreeDepth, ...(nestedTreeIcons ? { icons: nestedTreeIcons } : {}) } : {})
        });
        nestedTreeDepth = null;
        nestedTreeIcons = null;
        nestedTreeDefaultJson = null;
      }
      description = '';
    } else if (isTopLevel && !comment && !/^\s*$/.test(line)) {
      description = '';
    }
    const updatedDepth = updateBraceDepth(line, braceDepth, inBlockComment);
    braceDepth = updatedDepth.depth;
    inBlockComment = updatedDepth.inBlockComment;
  }
  return parameters;
}

function parseCustomizerChoices(source, type) {
  const delimiter = source.includes('|') ? '|' : ',';
  const choices = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      current += character;
      if (character === '\\' && index + 1 < source.length) current += source[++index];
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
      current += character;
    } else if (character === delimiter) {
      if (current.trim()) choices.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) choices.push(current.trim());

  return choices.map(choice => {
    const separator = choice.indexOf(':');
    const rawValue = (separator < 0 ? choice : choice.slice(0, separator)).trim();
    const rawLabel = separator < 0 ? rawValue : choice.slice(separator + 1).trim();
    const valueText = unquoteCustomizerValue(rawValue);
    const label = unquoteCustomizerValue(rawLabel);
    let value = valueText;
    if (type === 'number' && /^-?\d+(?:\.\d+)?$/.test(valueText)) value = Number(valueText);
    else if (type === 'boolean' && /^(true|false)$/.test(valueText)) value = valueText === 'true';
    return { value, label: label || String(value) };
  });
}

function unquoteCustomizerValue(value) {
  const match = value.match(/^(["'])(.*)\1$/);
  return match ? match[2].replace(/\\(["'\\])/g, '$1') : value;
}

function updateBraceDepth(line, initialDepth, initialBlockComment) {
  let depth = initialDepth;
  let inBlockComment = initialBlockComment;
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    const next = line[index + 1];
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && next === '/') break;
    if (character === '/' && next === '*') {
      inBlockComment = true;
      index++;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '{') depth++;
    else if (character === '}') depth = Math.max(0, depth - 1);
  }
  return { depth, inBlockComment };
}

module.exports = { PARAMETER_PARSER_VERSION, NESTED_TREE_ICONS, parseParameters, isFontParameterName };
