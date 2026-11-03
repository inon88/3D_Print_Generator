const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns/promises');
const { PARAMETER_PARSER_VERSION, NESTED_TREE_ICONS, parseParameters, isFontParameterName } = require('./parameters.cjs');
const { exportsSeparateObjects, findMissingReferencedAssets } = require('./scad-assets.cjs');
const { fontFamiliesFromArrayBuffer, fontSupportsOpenScadWasm } = require('./font-name.cjs');
const { validateTraceRequest } = require('./image-trace.cjs');
const { indexIconPacks, readIcon } = require('./icon-library.cjs');
const { validateHeightmapPng, LITHOPHANE_LIMITS } = require('./heightmap.cjs');
const { LITHOPHANE_GENERATOR_VERSION, LITHOPHANE_IMAGE_PARAMETER, LITHOPHANE_TOOL, lithophaneManifest } = require('./lithophane.cjs');
const { normalizeTransformPayload, parseItemEchoes, parsePlateCount, MAX_EXPORT_PLATES } = require('./transform.cjs');
const { applyMeshTransform, groupObjectsAsParts } = require('./mesh-transform.cjs');

const DEFAULT_APP_TITLE = 'BonaStudio';
const MAX_SCAD_BYTES = 10 * 1024 * 1024;
// Preview favours responsiveness; it keeps the model's own resolution when the source sets one.
const PREVIEW_QUALITY = { fa: 20, fs: 2 };
// Export always uses maximum resolution and overrides the model's top-level $fn/$fa/$fs.
// A 2° angle and 0.2 mm segment keep chord deviation below ~0.015 mm, finer than FDM printing can reproduce;
// higher settings only multiply render time (minkowski/sphere models already take ~50 s at this level).
const EXPORT_QUALITY = { fa: 2, fs: 0.2 };
const PREVIEW_TIMEOUT_MS = 120 * 1000;
const EXPORT_TIMEOUT_MS = 5 * 60 * 1000;
const EXPORT_FALLBACK_TIMEOUT_MS = 2 * 60 * 1000;
const TRACE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_SETTINGS = {
  appTitle: DEFAULT_APP_TITLE,
  exportDirectory: '',
  exportFormat: 'stl',
  autoPreview: true,
  previewDelay: 700,
  theme: 'light',
  // Viewport transform (move / rotate / scale): see transform.cjs.
  transformEnabled: true,
  transformGizmo: true,
  gizmoSize: 1,
  transformShortcuts: true,
  transformShortcutMode: 'modal',
  keepOnPlate: true,
  snapMove: 1,
  snapRotate: 15,
  snapScale: 10,
  // Build plates shown in the viewport: 'auto' (enough to cover the model) or columns x rows of 256 mm plates.
  plateLayout: 'auto'
};

let mainWindow;
let appTitle = DEFAULT_APP_TITLE;
let installedFontsPromise;

function fontDirectories() {
  if (process.platform === 'win32') {
    return [
      path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
      path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')
    ];
  }
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(app.getPath('home'), 'Library', 'Fonts')];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(app.getPath('home'), '.local', 'share', 'fonts'), path.join(app.getPath('home'), '.fonts')];
}

async function listInstalledFonts() {
  if (!installedFontsPromise) {
    installedFontsPromise = (async () => {
      const fonts = [];
      const visited = new Set();
      async function scan(directory) {
        let absolute;
        try { absolute = await fs.realpath(directory); } catch { return; }
        if (visited.has(absolute)) return;
        visited.add(absolute);
        let entries;
        try { entries = await fs.readdir(absolute, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const filePath = path.join(absolute, entry.name);
          if (entry.isDirectory()) { await scan(filePath); continue; }
          if (!entry.isFile() || !/\.(?:ttf|otf|ttc)$/i.test(entry.name)) continue;
          try {
            const data = await fs.readFile(filePath);
            if (!fontSupportsOpenScadWasm(data)) continue;
            for (const name of fontFamiliesFromArrayBuffer(data)) {
              const separator = name.indexOf(':style=');
              const family = separator < 0 ? name : name.slice(0, separator);
              const style = separator < 0 ? 'Regular' : name.slice(separator + 7);
              fonts.push({ name, family, style, filePath });
            }
          } catch {}
        }
      }
      await Promise.all(fontDirectories().map(scan));
      const unique = new Map();
      for (const font of fonts) {
        const key = font.name.toLocaleLowerCase();
        if (!unique.has(key)) unique.set(key, font);
      }
      return [...unique.values()].sort((left, right) => left.family.localeCompare(right.family) || left.style.localeCompare(right.style));
    })().catch(error => { installedFontsPromise = null; throw error; });
  }
  return installedFontsPromise;
}

function dataPaths() {
  const root = path.join(app.getPath('userData'), 'library');
  return { root, tools: path.join(root, 'tools'), settings: path.join(root, 'settings.json'), initialized: path.join(root, '.initialized') };
}

async function ensureLibrary() {
  const { root, tools, initialized } = dataPaths();
  await fs.mkdir(tools, { recursive: true });
  // Print setup moved to the slicer; drop the configuration file written by earlier versions.
  await fs.rm(path.join(root, 'print-configuration.json'), { force: true });
  try {
    await fs.access(initialized);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const samplePath = path.join(__dirname, 'examples', 'bracket.scad');
    try {
      await saveTool(await fs.readFile(samplePath, 'utf8'), 'Mounting bracket', 'Example');
    } catch (error) {
      console.error('Could not create the sample tool:', error);
    }
    await fs.writeFile(initialized, new Date().toISOString(), 'utf8');
  }
  await ensureGeneratorTools(tools);
}

// Built-in generator tools (no .scad; the mesh is built in JavaScript). They have their own
// mode in the sidebar and cannot be deleted, so a missing one is created again.
async function ensureGeneratorTools(tools) {
  const directory = path.join(tools, LITHOPHANE_TOOL.id);
  try {
    await fs.access(path.join(directory, 'manifest.json'));
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, LITHOPHANE_TOOL.entry), JSON.stringify({ generator: LITHOPHANE_TOOL.generator }), 'utf8');
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(lithophaneManifest(), null, 2), 'utf8');
  } catch (error) {
    console.error('Could not create the lithophane generator:', error);
  }
}

const isGenerator = manifest => manifest?.kind === 'generator';

function sanitizeName(name) {
  return String(name || 'model').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 80) || 'model';
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateAddress(mapped);
    }
    return normalized === '::' || normalized === '::1'
      || /^(fc|fd|fe[89ab])/.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8:');
  }
  return true;
}

async function readManifest(toolId) {
  if (typeof toolId !== 'string' || !/^[\w-]+$/.test(toolId)) throw new Error('Invalid tool.');
  const manifestPath = path.join(dataPaths().tools, toolId, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const sourcePath = path.resolve(path.dirname(manifestPath), manifest.entry);
  if (!sourcePath.startsWith(`${path.dirname(manifestPath)}${path.sep}`)) throw new Error('Invalid tool path.');
  if (isGenerator(manifest)) {
    if (manifest.generator !== LITHOPHANE_TOOL.generator) throw new Error('Unknown generator tool.');
    // Parameters come from lithophane.cjs; refresh them when the generator changes.
    if (manifest.generatorVersion !== LITHOPHANE_GENERATOR_VERSION) {
      const fresh = lithophaneManifest(manifest.createdAt);
      Object.assign(manifest, { parameters: fresh.parameters, generatorVersion: fresh.generatorVersion });
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }
    return { manifest, manifestPath, sourcePath };
  }
  if (manifest.parameterParserVersion !== PARAMETER_PARSER_VERSION) {
    const source = await fs.readFile(sourcePath, 'utf8');
    const parsedParameters = parseParameters(source);
    const detectedNames = new Set(parsedParameters.map(parameter => parameter.name));
    const manualParameters = (manifest.parameters || [])
      .filter(parameter => parameter.source === 'manual' || parameter.description === 'Manual parameter')
      .filter(parameter => !detectedNames.has(parameter.name))
      .map(parameter => ({ ...parameter, source: 'manual' }));
    manifest.parameters = [...parsedParameters, ...manualParameters];
    manifest.parameterParserVersion = PARAMETER_PARSER_VERSION;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }
  return { manifest, manifestPath, sourcePath };
}

async function listTools() {
  await ensureLibrary();
  const entries = await fs.readdir(dataPaths().tools, { withFileTypes: true });
  const tools = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const { manifest } = await readManifest(entry.name);
      tools.push(manifest);
    } catch (error) {
      console.error(`Could not load tool ${entry.name}:`, error);
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

async function settingsRead() {
  const settingsPath = dataPaths().settings;
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(settingsPath, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { ...DEFAULT_SETTINGS, exportDirectory: app.getPath('desktop') };
  }
}

function clampSetting(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

// The export folder is later passed to shell.openPath, which would launch a file; accept only existing folders.
async function isExistingDirectory(target) {
  if (typeof target !== 'string' || !target || !path.isAbsolute(target)) return false;
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function settingsWrite(settings) {
  const current = await settingsRead();
  const requestedAppTitle = settings.appTitle;
  if (requestedAppTitle !== undefined
    && (typeof requestedAppTitle !== 'string' || !requestedAppTitle.trim() || requestedAppTitle.trim().length > 60)) {
    throw new Error('Application title must contain 1 to 60 characters.');
  }
  const next = {
    ...current,
    appTitle: requestedAppTitle === undefined ? current.appTitle : requestedAppTitle.trim(),
    exportDirectory: await isExistingDirectory(settings.exportDirectory)
      ? settings.exportDirectory
      : current.exportDirectory,
    exportFormat: ['stl', '3mf'].includes(settings.exportFormat) ? settings.exportFormat : current.exportFormat,
    autoPreview: typeof settings.autoPreview === 'boolean' ? settings.autoPreview : current.autoPreview,
    previewDelay: Number.isFinite(settings.previewDelay) ? Math.min(3000, Math.max(150, settings.previewDelay)) : current.previewDelay,
    theme: ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : current.theme,
    transformEnabled: typeof settings.transformEnabled === 'boolean' ? settings.transformEnabled : current.transformEnabled,
    transformGizmo: typeof settings.transformGizmo === 'boolean' ? settings.transformGizmo : current.transformGizmo,
    gizmoSize: clampSetting(settings.gizmoSize, 0.5, 2, current.gizmoSize),
    transformShortcuts: typeof settings.transformShortcuts === 'boolean' ? settings.transformShortcuts : current.transformShortcuts,
    transformShortcutMode: ['modal', 'gizmo'].includes(settings.transformShortcutMode) ? settings.transformShortcutMode : current.transformShortcutMode,
    keepOnPlate: typeof settings.keepOnPlate === 'boolean' ? settings.keepOnPlate : current.keepOnPlate,
    snapMove: clampSetting(settings.snapMove, 0.1, 100, current.snapMove),
    snapRotate: clampSetting(settings.snapRotate, 1, 90, current.snapRotate),
    snapScale: clampSetting(settings.snapScale, 1, 100, current.snapScale),
    plateLayout: typeof settings.plateLayout === 'string' && /^(auto|[1-4]x[1-4])$/.test(settings.plateLayout) ? settings.plateLayout : current.plateLayout
  };
  await fs.mkdir(path.dirname(dataPaths().settings), { recursive: true });
  await fs.writeFile(dataPaths().settings, JSON.stringify(next, null, 2), 'utf8');
  appTitle = next.appTitle;
  mainWindow?.setTitle(appTitle);
  return next;
}

async function saveTool(source, name, category, sourceUrl = '') {
  const id = randomUUID();
  const directory = path.join(dataPaths().tools, id);
  await fs.mkdir(directory, { recursive: true });
  const entry = 'model.scad';
  await fs.writeFile(path.join(directory, entry), source, 'utf8');
  const manifest = {
    id,
    name: sanitizeName(name || path.basename(sourceUrl ? new URL(sourceUrl).pathname : 'New tool', '.scad')),
    category: sanitizeName(category || 'Custom'),
    entry,
    sourceUrl,
    parameters: parseParameters(source),
    parameterParserVersion: PARAMETER_PARSER_VERSION,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

class RenderTimeoutError extends Error {}

// Checks every value against the manifest (type, range, options); defaults fill the gaps.
function validateParameterValues(manifest, values) {
  const params = {};
  let nestedFontNames = [];
  const nestedParameterOverrides = {};
  for (const parameter of manifest.parameters || []) {
    const value = Object.hasOwn(values || {}, parameter.name) ? values[parameter.name] : parameter.default;
    if (parameter.type === 'nested-tree') {
      const { encoded, fonts } = validateNestedTree(value, parameter.maxDepth || 4, parameter.label || parameter.name, parameter.icons?.length ? parameter.icons : NESTED_TREE_ICONS);
      params[parameter.name] = encoded;
      nestedParameterOverrides[parameter.name] = encoded;
      nestedFontNames = fonts;
      continue;
    } else if (parameter.type === 'number') {
      if (!Number.isFinite(value)) throw new Error('Parameter "' + (parameter.label || parameter.name) + '" must be a number.');
      if ((Number.isFinite(parameter.min) && value < parameter.min) || (Number.isFinite(parameter.max) && value > parameter.max)) {
        throw new Error('Parameter "' + (parameter.label || parameter.name) + '" is outside the allowed range.');
      }
    } else if (parameter.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error('Parameter "' + (parameter.label || parameter.name) + '" must be a true/false value.');
    } else if (parameter.type === 'vector' && (!Array.isArray(value) || value.some(item => !Number.isFinite(item)))) {
      throw new Error('Parameter "' + (parameter.label || parameter.name) + '" must be a numeric vector.');
    } else if (parameter.type === 'string' && (typeof value !== 'string' || value.length > 10000)) {
      throw new Error('Parameter "' + (parameter.label || parameter.name) + '" is invalid.');
    }
    if (parameter.options && !parameter.options.includes(value)) {
      throw new Error('Parameter "' + (parameter.label || parameter.name) + '" is not one of the available options.');
    }
    params[parameter.name] = value;
  }
  return { params, nestedFontNames, nestedParameterOverrides };
}

// Validates the tool, its assets, parameter values, and fonts once; the result can be rendered several times.
async function prepareRenderJob(toolId, values) {
  const { manifest, sourcePath } = await readManifest(toolId);
  const source = await fs.readFile(sourcePath, 'utf8');
  const sourceSetsResolution = /\$(?:fn|fa|fs)\s*=/m.test(source);
  const separateObjects = exportsSeparateObjects(source);
  const missingAssets = await findMissingReferencedAssets(source, path.dirname(sourcePath));
  if (missingAssets.length) {
    const listedAssets = missingAssets.map(asset => '"' + asset + '"').join(', ');
    throw new Error('Required file(s) ' + listedAssets + ' could not be found. Re-import the complete OpenSCAD project with Add tool › Project folder, including any image or mesh files used by surface() or import().');
  }
  const { params, nestedFontNames, nestedParameterOverrides } = validateParameterValues(manifest, values);

  const wasmDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'openscad-wasm')
    : path.join(__dirname, 'vendor', 'openscad-wasm');
  try {
    await fs.access(path.join(wasmDirectory, 'openscad.js'));
    await fs.access(path.join(wasmDirectory, 'openscad.wasm'));
  } catch {
    throw new Error('The bundled OpenSCAD WASM engine is missing. Rebuild the app while connected to the internet.');
  }
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'scad-render-worker.cjs')
    : path.join(__dirname, 'scad-render-worker.cjs');
  const selectedFont = typeof params.font_name === 'string'
    ? (await listInstalledFonts()).find(font => font.name.toLocaleLowerCase() === params.font_name.toLocaleLowerCase())
    : null;
  if (params.font_name && !selectedFont) throw new Error('The selected font is unavailable or incompatible with OpenSCAD WASM. Choose another font from the local font list.');
  const installedFonts = await listInstalledFonts();
  // Extra font pickers (e.g. name_font) next to font_name.
  const extraFontPaths = (manifest.parameters || [])
    .filter(parameter => parameter.type === 'string' && parameter.name !== 'font_name' && isFontParameterName(parameter.name) && params[parameter.name])
    .map(parameter => {
      const font = installedFonts.find(item => item.name.toLocaleLowerCase() === params[parameter.name].toLocaleLowerCase());
      if (!font) throw new Error('The font chosen for "' + (parameter.label || parameter.name) + '" is unavailable or incompatible with OpenSCAD WASM. Choose another font from the local font list.');
      return font.filePath;
    });
  const treeFontPaths =nestedFontNames.map(name => {
    const font = installedFonts.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!font) throw new Error('A nested text element uses a font that is unavailable. Choose an installed font for that element.');
    return font.filePath;
  });
  const fontPaths = [...new Set([selectedFont?.filePath, ...extraFontPaths, ...treeFontPaths].filter(Boolean))];
  return { manifest, sourcePath, sourceSetsResolution, separateObjects, wasmDirectory, workerPath, params, nestedParameterOverrides, fontPaths };
}

// quality: { fa, fs } overrides top-level resolution with $fn=0; null keeps the model's own settings.
function runRenderWorker(job, format, quality, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(job.workerPath, {
      workerData: {
        wasmDirectory: job.wasmDirectory,
        sourcePath: job.sourcePath,
        values: job.params,
        nestedParameterOverrides: job.nestedParameterOverrides,
        format,
        quality,
        fontPaths: job.fontPaths,
        // One 3MF object per color part for tools that ask for it; never for STL,
        // where overlapping objects without a union would not be a valid mesh.
        separateObjects: job.separateObjects && format === '3mf'
      }
    });
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve({ output: Buffer.from(output.output), items: parseItemEchoes(output.itemEchoes), plates: parsePlateCount(output.itemEchoes) });
    };
    const timer = setTimeout(() => finish(new RenderTimeoutError(`Rendering exceeded the ${Math.round(timeoutMs / 1000)}-second time limit.`)), timeoutMs);
    worker.once('message', result => {
      if (result.error) finish(new Error(result.error));
      else if (!(result.output instanceof ArrayBuffer)) finish(new Error('OpenSCAD WASM returned an invalid mesh.'));
      else finish(null, result);
    });
    worker.once('error', error => finish(new Error('OpenSCAD WASM failed: ' + error.message)));
    worker.once('exit', code => {
      if (!settled) finish(new Error('OpenSCAD WASM worker exited with code ' + code + '.'));
    });
  });
}

// Lithophane generator: same reply shape as runRenderWorker, built by lithophane-worker.cjs.
async function prepareGeneratorJob(manifest, sourcePath, values) {
  const { params } = validateParameterValues(manifest, values);
  const reference = params[LITHOPHANE_IMAGE_PARAMETER];
  let imagePath = null;
  if (reference) {
    const toolDirectory = path.dirname(sourcePath);
    imagePath = path.resolve(toolDirectory, reference);
    if (!imagePath.startsWith(toolDirectory + path.sep) || path.extname(imagePath).toLowerCase() !== '.png') {
      throw new Error('The lithophane image is invalid. Choose the image again.');
    }
    try {
      await fs.access(imagePath);
    } catch {
      throw new Error('The lithophane image could not be found. Choose the image again.');
    }
  }
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'lithophane-worker.cjs')
    : path.join(__dirname, 'lithophane-worker.cjs');
  return { workerPath, imagePath, params, name: manifest.name };
}

function runGeneratorWorker(job, format, preview, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(job.workerPath, {
      workerData: { imagePath: job.imagePath, values: job.params, format, preview, name: job.name }
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve({ output: Buffer.from(result.output), items: parseItemEchoes(result.itemEchoes), plates: null, info: result.info });
    };
    const timer = setTimeout(() => finish(new RenderTimeoutError(`The lithophane took longer than ${Math.round(timeoutMs / 1000)} seconds. Use a larger Detail value.`)), timeoutMs);
    worker.once('message', result => {
      if (result.error) finish(new Error(result.error));
      else if (!(result.output instanceof ArrayBuffer)) finish(new Error('The lithophane generator returned an invalid mesh.'));
      else finish(null, result);
    });
    worker.once('error', error => finish(new Error('The lithophane generator failed: ' + error.message)));
    worker.once('exit', code => {
      if (!settled) finish(new Error('The lithophane generator exited with code ' + code + '.'));
    });
  });
}

async function renderPreview(toolId, values) {
  const { manifest, sourcePath } = await readManifest(toolId);
  if (isGenerator(manifest)) return runGeneratorWorker(await prepareGeneratorJob(manifest, sourcePath, values), '3mf', true, PREVIEW_TIMEOUT_MS);
  const job = await prepareRenderJob(toolId, values);
  // Preview is rendered as 3MF so model colors are visible in the viewer.
  return runRenderWorker(job, '3mf', job.sourceSetsResolution ? null : PREVIEW_QUALITY, PREVIEW_TIMEOUT_MS);
}

async function renderExport(toolId, values, format) {
  const { manifest, sourcePath } = await readManifest(toolId);
  if (isGenerator(manifest)) {
    const { output } = await runGeneratorWorker(await prepareGeneratorJob(manifest, sourcePath, values), format, false, EXPORT_TIMEOUT_MS);
    return { output, plates: null, quality: 'maximum', separateObjects: false };
  }
  const job = await prepareRenderJob(toolId, values);
  try {
    const { output, plates } = await runRenderWorker(job, format, EXPORT_QUALITY, EXPORT_TIMEOUT_MS);
    return { output, plates, quality: 'maximum', separateObjects: job.separateObjects };
  } catch (error) {
    if (!(error instanceof RenderTimeoutError)) throw error;
    // Very heavy models (e.g. minkowski with spheres) can exceed the budget at maximum resolution.
    const { output, plates } = await runRenderWorker(job, format, job.sourceSetsResolution ? null : { fa: 4, fs: 0.5 }, EXPORT_FALLBACK_TIMEOUT_MS);
    return { output, plates, quality: 'model', separateObjects: job.separateObjects };
  }
}

function validateNestedTree(value, maxDepth, label, icons = NESTED_TREE_ICONS) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new Error(label + ' must contain between 1 and 200 elements.');
  const fonts = new Set();
  let nodeCount = 0;
  const encodeList = (nodes, depth, prefix = '') => {
    if (!nodes.length) return [];
    if (depth > maxDepth) throw new Error(label + ' exceeds the maximum nesting depth of ' + maxDepth + '.');
    return nodes.map((node, index) => {
      const elementName = 'element ' + prefix + (index + 1);
      nodeCount++;
      if (nodeCount > 200) throw new Error(label + ' cannot contain more than 200 elements.');
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(label + ' contains an invalid element.');
      const { type, text, font, icon, svgPath, x, y, size, thickness, bold, placement, overlap, color, children } = node;
      // Elements saved before rotation existed have none.
      const rotation = node.rotation ?? 0;
      if (!['Text', 'SVG', 'Icon'].includes(type)) throw new Error(label + ' has an unsupported element type.');
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(label + ' has an invalid color. Choose a color from the element palette.');
      for (const [key, number, min, max, unit] of [['X position', x, -128, 128, 'mm'], ['Y position', y, -128, 128, 'mm'], ['size', size, 1, 210, 'mm'], ['thickness', thickness, 0.4, 20, 'mm'], ['bold', bold, 0, 8, 'mm'], ['inset depth', overlap, 0, 20, 'mm'], ['rotation', rotation, -180, 180, '°']]) {
        if (!Number.isFinite(number) || number < min || number > max) {
          throw new Error(label + ' › ' + elementName + ': ' + key + ' must be between ' + min + ' and ' + max + ' ' + unit + '.');
        }
      }
      if (!['Above', 'Inset'].includes(placement)) throw new Error(label + ' has an invalid Z placement.');
      if (!Array.isArray(children)) throw new Error(label + ' contains an invalid nested element list.');
      if (type === 'Text') {
        if (typeof text !== 'string' || text.length > 500) throw new Error(label + ' has invalid text.');
        if (typeof font !== 'string' || font.length > 250) throw new Error(label + ' has an invalid font.');
        fonts.add(font);
      }
      if (type === 'Icon' && !icons.includes(icon)) throw new Error(label + ' has an unsupported icon.');
      if (type === 'SVG' && (typeof svgPath !== 'string' || (svgPath && (!/^user-assets\/[A-Za-z0-9._-]+\.svg$/i.test(svgPath) || svgPath.includes('..'))))) throw new Error(label + ' has an invalid SVG path. Choose an SVG using the file picker.');
      return [type, text || '', font || '', icon || icons[0], svgPath || '', x, y, size, thickness, bold, placement, overlap, encodeList(children, depth + 1, prefix + (index + 1) + '.'), color, rotation];
    });
  };
  return { encoded: encodeList(value, 1), fonts: [...fonts] };
}

async function openScadWasmAvailable() {
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, 'openscad-wasm')
    : path.join(__dirname, 'vendor', 'openscad-wasm');
  try {
    await Promise.all([fs.access(path.join(directory, 'openscad.js')), fs.access(path.join(directory, 'openscad.wasm'))]);
    return true;
  } catch {
    return false;
  }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: '#f5f7f8',
    title: appTitle,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The spellchecker downloads dictionaries into stray folders and is not needed for numeric parameter forms.
      spellcheck: false
    }
  });
  // The renderer only ever shows the bundled index.html: refuse navigation and new windows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// The app was called FormForge before; copy its library, icon packs and presets (Local Storage) once,
// before the window opens, so a renamed install keeps the user's tools.
const LEGACY_APP_TITLE = 'FormForge';
const LEGACY_DATA_FOLDERS = ['FormForge', 'formforge'];
const MIGRATED_ENTRIES = ['library', 'icon-packs', 'Local Storage'];

async function migrateLegacyUserData() {
  const userData = app.getPath('userData');
  try {
    await fs.access(path.join(userData, 'library'));
    return;
  } catch {}
  for (const folder of LEGACY_DATA_FOLDERS) {
    const legacy = path.join(app.getPath('appData'), folder);
    if (path.relative(legacy, userData) === '') continue;
    try {
      await fs.access(path.join(legacy, 'library'));
    } catch {
      continue;
    }
    for (const entry of MIGRATED_ENTRIES) {
      await fs.cp(path.join(legacy, entry), path.join(userData, entry), { recursive: true, errorOnExist: false, force: false })
        .catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const settingsPath = dataPaths().settings;
    try {
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      if (settings.appTitle === LEGACY_APP_TITLE) {
        settings.appTitle = DEFAULT_APP_TITLE;
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return;
  }
}

app.whenReady().then(async () => {
  try {
    await migrateLegacyUserData();
  } catch (error) {
    console.error('Could not copy data from the previous FormForge installation:', error);
  }
  await ensureLibrary();
  appTitle = (await settingsRead()).appTitle;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:initial-state', async () => {
  const settings = await settingsRead();
  return { tools: await listTools(), settings, openscadAvailable: await openScadWasmAvailable(), desktop: app.getPath('desktop'), version: app.getVersion(), platform: process.platform };
});

ipcMain.handle('tools:import-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an OpenSCAD file',
    properties: ['openFile'],
    filters: [{ name: 'OpenSCAD', extensions: ['scad'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const source = await fs.readFile(result.filePaths[0], 'utf8');
  if (Buffer.byteLength(source) > MAX_SCAD_BYTES) throw new Error('The SCAD file exceeds the 10 MB size limit.');
  const tool = await saveTool(source, path.basename(result.filePaths[0], '.scad'), 'Imported');
  return { tool, tools: await listTools() };
});

ipcMain.handle('tools:import-project', async () => {
  const folderResult = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an OpenSCAD project folder',
    properties: ['openDirectory']
  });
  if (folderResult.canceled || !folderResult.filePaths[0]) return null;
  const projectRoot = folderResult.filePaths[0];
  const entryResult = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the main SCAD file',
    defaultPath: projectRoot,
    properties: ['openFile'],
    filters: [{ name: 'OpenSCAD', extensions: ['scad'] }]
  });
  if (entryResult.canceled || !entryResult.filePaths[0]) return null;
  const entrySource = entryResult.filePaths[0];
  const relativeEntry = path.relative(projectRoot, entrySource);
  if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
    throw new Error('The main SCAD file must be inside the selected project folder.');
  }

  const id = randomUUID();
  const destination = path.join(dataPaths().tools, id, 'project');
  await fs.mkdir(destination, { recursive: true });
  let copiedBytes = 0;
  let fileCount = 0;
  async function copyDirectory(source, target) {
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      const details = await fs.lstat(sourcePath);
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) {
        await fs.mkdir(targetPath, { recursive: true });
        await copyDirectory(sourcePath, targetPath);
      } else if (details.isFile()) {
        copiedBytes += details.size;
        fileCount++;
        if (copiedBytes > 150 * 1024 * 1024 || fileCount > 5000) {
          throw new Error('The project folder is too large (maximum 150 MB and 5,000 files).');
        }
        await fs.copyFile(sourcePath, targetPath);
      }
    }
  }
  try {
    await copyDirectory(projectRoot, destination);
    const entryPath = path.join(destination, relativeEntry);
    const entryStats = await fs.stat(entryPath);
    if (entryStats.size > MAX_SCAD_BYTES) throw new Error('The main SCAD file exceeds the 10 MB size limit.');
    const source = await fs.readFile(entryPath, 'utf8');
    const manifest = {
      id,
      name: sanitizeName(path.basename(projectRoot)),
      category: 'Project',
      entry: path.join('project', relativeEntry),
      sourceUrl: '',
      parameters: parseParameters(source),
      parameterParserVersion: PARAMETER_PARSER_VERSION,
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(path.join(dataPaths().tools, id, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { tool: manifest, tools: await listTools() };
  } catch (error) {
    await fs.rm(path.join(dataPaths().tools, id), { recursive: true, force: true });
    throw error;
  }
});

ipcMain.handle('tools:import-url', async (_event, url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (parsed.username || parsed.password) throw new Error('The URL must not include a username or password.');
  if (parsed.protocol !== 'https:') throw new Error('URL imports support HTTPS only.');
  const hostname = parsed.hostname.toLowerCase();
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(normalizedHost);
  const blockedHost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || (ipVersion === 4 && isPrivateAddress(normalizedHost))
    || (ipVersion === 6 && isPrivateAddress(normalizedHost));
  if (blockedHost) throw new Error('Local addresses cannot be used as import sources.');
  if (!parsed.pathname.toLowerCase().endsWith('.scad')) throw new Error('The URL must point directly to a .scad file.');
  if (!ipVersion) {
    const addresses = await dns.lookup(normalizedHost, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(address => isPrivateAddress(address.address))) {
      throw new Error('The import source must be hosted on a public host.');
    }
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}.`);
  if (!response.body) throw new Error('The source did not provide a file body.');
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_SCAD_BYTES) {
      throw new Error('The file exceeds the 10 MB size limit.');
    }
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString('utf8');
  if (!source.trim()) throw new Error('The SCAD file is empty.');
  const tool = await saveTool(source, path.basename(parsed.pathname, '.scad'), 'Imported', parsed.href);
  return { tool, tools: await listTools() };
});

ipcMain.handle('tools:delete', async (_event, toolId) => {
  const { manifest } = await readManifest(toolId);
  if (isGenerator(manifest)) throw new Error('The built-in Lithophane generator cannot be deleted.');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Delete tool', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete tool?',
    message: `Delete "${manifest.name}" from the library?`,
    detail: 'This only deletes the copy stored in BonaStudio.'
  });
  if (result.response !== 0) return { deleted: false, tools: await listTools() };
  await fs.rm(path.join(dataPaths().tools, toolId), { recursive: true, force: false });
  return { deleted: true, tools: await listTools() };
});

ipcMain.handle('tools:add-parameter', async (_event, toolId, parameter) => {
  if (!parameter || typeof parameter.name !== 'string' || !/^[A-Za-z_]\w*$/.test(parameter.name)) {
    throw new Error('Parameter names may contain only letters, numbers, and underscores, and cannot start with a number.');
  }
  const { manifest, manifestPath } = await readManifest(toolId);
  if (isGenerator(manifest)) throw new Error('Generator tools have a fixed set of parameters.');
  if ((manifest.parameters || []).some(item => item.name === parameter.name)) {
    throw new Error(`Parameter "${parameter.name}" already exists.`);
  }
  const value = parameter.type === 'boolean' ? Boolean(parameter.default) : Number(parameter.default);
  if (parameter.type === 'number' && !Number.isFinite(value)) throw new Error('The default numeric value is invalid.');
  manifest.parameters ||= [];
  manifest.parameters.push({
    name: parameter.name,
    label: parameter.label || parameter.name,
    type: parameter.type === 'boolean' ? 'boolean' : 'number',
    default: value,
    group: 'Custom parameters',
    description: 'Manual parameter',
    source: 'manual'
  });
  manifest.parameterParserVersion = PARAMETER_PARSER_VERSION;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { tool: manifest, tools: await listTools() };
});

ipcMain.handle('fonts:list', async () => (await listInstalledFonts()).map(({ name, family, style }) => ({ name, family, style })));

ipcMain.handle('tools:render', async (_event, toolId, values) => {
  const { output: mesh, items, plates } = await renderPreview(toolId, values);
  return { mesh, bytes: mesh.byteLength, items, plates };
});

ipcMain.handle('tools:choose-parameter-file', async (_event, kind) => {
  if (kind !== 'icon' && kind !== 'relief') throw new Error('Unsupported parameter file type.');
  // Reliefs are made from photos and artwork; icons also accept SVG.
  const allowedExtensions = kind === 'relief' ? ['.png', '.jpg', '.jpeg', '.webp'] : ['.svg', '.png', '.jpg', '.jpeg', '.webp'];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'relief' ? 'Select an image for the relief' : 'Select an icon image',
    properties: ['openFile'],
    filters: [{ name: kind === 'relief' ? 'Images' : 'Icon images', extensions: allowedExtensions.map(extension => extension.slice(1)) }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size > 10 * 1024 * 1024) throw new Error('The selected file exceeds the 10 MB limit.');
  const extension = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.includes(extension)) throw new Error('The selected file type is not supported.');
  return {
    fileName: path.basename(filePath),
    extension,
    data: await fs.readFile(filePath)
  };
});

ipcMain.handle('tools:save-icon-asset', async (_event, toolId, parameterName, svg) => {
  if (!['icon_left_file', 'icon_right_file', 'decorative_layers'].includes(parameterName)
    || typeof svg !== 'string'
    || Buffer.byteLength(svg, 'utf8') > 5 * 1024 * 1024
    || !/<svg(?:\s|>)/i.test(svg)) {
    throw new Error('The selected icon could not be saved as a valid SVG.');
  }
  const { manifest, sourcePath } = await readManifest(toolId);
  const parameter = manifest.parameters.find(item => item.name === parameterName);
  if (!parameter || (parameter.type !== 'string' && !(parameterName === 'decorative_layers' && parameter.type === 'nested-tree'))) {
    throw new Error('The selected icon parameter is not available.');
  }
  const assetDirectory = path.join(path.dirname(sourcePath), 'user-assets');
  await fs.mkdir(assetDirectory, { recursive: true });
  const fileName = `${randomUUID()}.svg`;
  await fs.writeFile(path.join(assetDirectory, fileName), svg, 'utf8');
  return { reference: path.posix.join('user-assets', fileName) };
});

// Heightmap PNGs for surface() reliefs, made by the renderer with heightmap.cjs.
ipcMain.handle('tools:save-heightmap-asset', async (_event, toolId, parameterName, png) => {
  if (parameterName !== 'relief_image_file' && parameterName !== LITHOPHANE_IMAGE_PARAMETER) throw new Error('The selected relief parameter is not available.');
  // Lithophane images feed the JavaScript generator, which handles more pixels than surface().
  const { data } = validateHeightmapPng(png, parameterName === LITHOPHANE_IMAGE_PARAMETER ? LITHOPHANE_LIMITS : undefined);
  const { manifest, sourcePath } = await readManifest(toolId);
  const parameter = manifest.parameters.find(item => item.name === parameterName);
  if (!parameter || parameter.type !== 'string') throw new Error('The selected relief parameter is not available.');
  const assetDirectory = path.join(path.dirname(sourcePath), 'user-assets');
  await fs.mkdir(assetDirectory, { recursive: true });
  const fileName = `${randomUUID()}.png`;
  await fs.writeFile(path.join(assetDirectory, fileName), data);
  return { reference: path.posix.join('user-assets', fileName) };
});

// Color tracing runs vtracer (WASM) in a worker so large images do not block the main process.
function runTraceWorker(request) {
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'image-trace-worker.cjs')
    : path.join(__dirname, 'image-trace-worker.cjs');
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: request });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Tracing took longer than 60 seconds. Use fewer colors or a smaller image.')), TRACE_TIMEOUT_MS);
    worker.once('message', result => {
      if (result.error) finish(new Error(result.error));
      else finish(null, { svg: result.svg, colors: result.colors, areas: result.areas });
    });
    worker.once('error', error => finish(new Error('Image tracing failed: ' + error.message)));
    worker.once('exit', code => {
      if (!settled) finish(new Error('Image tracing stopped unexpectedly (code ' + code + ').'));
    });
  });
}

// Icon packs live next to the library so they survive app updates; copy folders of SVGs in.
function iconLibraryRoot() {
  return path.join(app.getPath('userData'), 'icon-packs');
}

ipcMain.handle('icons:index', async () => indexIconPacks(iconLibraryRoot()));

ipcMain.handle('icons:read-many', async (_event, items) => {
  if (!Array.isArray(items) || items.length > 200) throw new Error('Too many icons were requested at once.');
  const root = iconLibraryRoot();
  // A broken file must not hide the rest of the page, so failures come back as null.
  return Promise.all(items.map(async item => {
    try { return await readIcon(root, item?.pack, item?.path); } catch { return null; }
  }));
});

ipcMain.handle('icons:read', async (_event, pack, relativePath) => readIcon(iconLibraryRoot(), pack, relativePath));

ipcMain.handle('icons:open-folder', async () => {
  const root = iconLibraryRoot();
  await fs.mkdir(root, { recursive: true });
  const error = await shell.openPath(root);
  if (error) throw new Error(error);
  return root;
});

ipcMain.handle('tools:trace-image', async (_event, rgba, width, height, options) => {
  const request = validateTraceRequest(rgba, width, height, options);
  return runTraceWorker(request);
});

// options.perPlate: tools that lay parts on several plates (an `export_plate` number parameter plus
// echo("formforge-plates", n)) are rendered once per plate and written as "<name> - plate N.<ext>".
ipcMain.handle('tools:export', async (event, toolId, values, format, transformPayload, options = {}) => {
  if (!['stl', '3mf'].includes(format)) {
    throw new Error('Unsupported export format. Choose STL or 3MF.');
  }
  if (options !== null && (typeof options !== 'object' || Array.isArray(options))) throw new Error('Invalid export options.');
  const perPlate = options?.perPlate === true;
  // Validated before the save dialog opens; null when the viewport transform is identity.
  const transform = normalizeTransformPayload(transformPayload);
  const { manifest } = await readManifest(toolId);
  const plateParameter = (manifest.parameters || []).find(parameter => parameter.name === 'export_plate' && parameter.type === 'number');
  if (perPlate && !plateParameter) throw new Error('This tool cannot export its plates separately (it has no export_plate parameter).');
  const settings = await settingsRead();
  const baseName = sanitizeName(manifest.name);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: perPlate ? `Export plates as ${format.toUpperCase()}` : `Export ${format.toUpperCase()}`,
    defaultPath: path.join(settings.exportDirectory || app.getPath('desktop'), `${baseName}.${format}`),
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const finish = rendered => {
    // Color parts stay together as one object with parts, so the slicer keeps them in place.
    const grouped = format === '3mf' && rendered.separateObjects ? groupObjectsAsParts(rendered.output, manifest.name) : rendered.output;
    return applyMeshTransform(grouped, format, transform);
  };
  if (!perPlate) {
    const rendered = await renderExport(toolId, values, format);
    const output = finish(rendered);
    await fs.writeFile(result.filePath, output);
    await settingsWrite({ exportDirectory: path.dirname(result.filePath) });
    return { canceled: false, filePath: result.filePath, quality: rendered.quality, bytes: output.byteLength };
  }
  // Plate 1 first: its render tells how many plates there are.
  const stem = result.filePath.replace(/\.(stl|3mf)$/i, '');
  const files = [];
  let quality = 'maximum';
  let count = 1;
  for (let plate = 1; plate <= count; plate++) {
    if (Number.isFinite(plateParameter.max) && plate > plateParameter.max) break;
    event.sender.send('export:progress', { plate, count: plate === 1 ? null : count });
    const rendered = await renderExport(toolId, { ...values, export_plate: plate }, format);
    if (plate === 1) count = Math.min(rendered.plates || 1, MAX_EXPORT_PLATES);
    if (rendered.quality !== 'maximum') quality = rendered.quality;
    const output = finish(rendered);
    const filePath = `${stem} - plate ${plate}.${format}`;
    await fs.writeFile(filePath, output);
    files.push({ filePath, bytes: output.byteLength });
  }
  await settingsWrite({ exportDirectory: path.dirname(result.filePath) });
  return { canceled: false, files, filePath: files[0].filePath, quality, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
});

ipcMain.handle('settings:save', async (_event, settings) => settingsWrite(settings));
ipcMain.handle('settings:choose-export-directory', async (_event, current) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the default export folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current || app.getPath('desktop')
  });
  return result.canceled ? '' : result.filePaths[0];
});
ipcMain.handle('settings:open-export-directory', async () => {
  const settings = await settingsRead();
  const target = await isExistingDirectory(settings.exportDirectory) ? settings.exportDirectory : app.getPath('desktop');
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
});
