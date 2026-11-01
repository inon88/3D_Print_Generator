const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { referencedAssetPaths } = require('./scad-assets.cjs');

function describeError(error) {
  if (error instanceof Error) {
    const details = [error.message, error.name && error.name !== 'Error' ? '(' + error.name + ')' : ''];
    for (const key of ['code', 'status', 'errno']) {
      if (error[key] !== undefined) details.push(key + ': ' + String(error[key]));
    }
    if (error.errno === 20) details.push('EEXIST: the virtual path already exists');
    if (error.stack && !error.message) details.push(error.stack);
    return details.filter(Boolean).join(' ') || 'OpenSCAD WASM failed with an error that had no message.';
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const details = {};
    for (const key of ['name', 'message', 'code', 'status', 'errno', 'stack']) {
      if (error[key] !== undefined && typeof error[key] !== 'function') details[key] = error[key];
    }
    if (error.errno === 20) details.code = 'EEXIST';
    try {
      const properties = JSON.stringify(error);
      if (properties && properties !== '{}') details.properties = JSON.parse(properties);
    } catch {}
    const description = JSON.stringify(details);
    if (description && description !== '{}') return 'OpenSCAD WASM failed: ' + description;
  }
  return 'OpenSCAD WASM failed with an unrecognized error value (' + Object.prototype.toString.call(error) + ').';
}

function mkdirTree(module, directory) {
  const parts = directory.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try { module.FS.mkdir(current); } catch (error) {
      if (error.code !== 'EEXIST' && error.errno !== 20) throw new Error('Could not create OpenSCAD virtual directory ' + JSON.stringify(current) + ': ' + describeError(error));
    }
  }
}

function writeVirtualFile(module, target, contents) {
  try {
    module.FS.writeFile(target, contents);
  } catch (error) {
    throw new Error('Could not write OpenSCAD virtual file ' + JSON.stringify(target) + ': ' + describeError(error));
  }
}

async function writeProjectTree(module, sourceDirectory, destinationDirectory) {
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const source = path.join(sourceDirectory, entry.name);
    const target = destinationDirectory + '/' + entry.name.replace(/\\/g, '/');
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      mkdirTree(module, target);
      await writeProjectTree(module, source, target);
    } else if (stat.isFile()) {
      mkdirTree(module, path.posix.dirname(target));
      writeVirtualFile(module, target, await fs.readFile(source));
    }
  }
}

async function main() {
  const lines = [];
  const wasmDirectory = workerData.wasmDirectory;
  const entry = path.join(wasmDirectory, 'openscad.js');
  const imported = await import(pathToFileURL(entry).href);
  const createOpenSCAD = imported.default || imported.OpenSCAD || imported;
  if (typeof createOpenSCAD !== 'function') throw new Error('OpenSCAD WASM module has an unexpected format.');
  const wasmBinary = await require('node:fs/promises').readFile(path.join(wasmDirectory, 'openscad.wasm'));
  const module = await createOpenSCAD({
    noInitialRun: true,
    noExitRuntime: true,
    wasmBinary,
    locateFile: file => path.join(wasmDirectory, file),
    print: line => lines.push(String(line)),
    printErr: line => lines.push(String(line))
  });

  const sourceDirectory = path.dirname(workerData.sourcePath);
  const relativeEntry = path.relative(sourceDirectory, workerData.sourcePath).split(path.sep).join('/');
  const workspace = '/workspace';
  mkdirTree(module, workspace);
  await writeProjectTree(module, sourceDirectory, workspace);

  const fontPaths = [...new Set([workerData.fontPath, ...(workerData.fontPaths || [])].filter(Boolean))];
  if (fontPaths.length) {
    const fontDirectory = '/fonts';
    mkdirTree(module, fontDirectory);
    for (const [index, sourceFontPath] of fontPaths.entries()) {
      const extension = path.extname(sourceFontPath).toLowerCase();
      const fontPath = fontDirectory + '/formforge-font-' + (index + 1) + extension;
      writeVirtualFile(module, fontPath, await fs.readFile(sourceFontPath));
    }
    writeVirtualFile(module, fontDirectory + '/fonts.conf', '<?xml version="1.0" encoding="UTF-8"?><fontconfig><dir>/fonts</dir></fontconfig>');
    if (module.ENV) module.ENV.FONTCONFIG_FILE = fontDirectory + '/fonts.conf';
  }

  const source = await fs.readFile(workerData.sourcePath, 'utf8');
  for (const reference of referencedAssetPaths(source)) {
    if (!path.isAbsolute(reference)) continue;
    const external = path.normalize(reference);
    try {
      const stat = await fs.stat(external);
      if (stat.isFile()) {
        const virtualPath = '/' + external.replace(/^[A-Za-z]:[\\/]/, '').replace(/\\/g, '/');
        mkdirTree(module, path.posix.dirname(virtualPath));
        writeVirtualFile(module, virtualPath, await fs.readFile(external));
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }

  const inputPath = workspace + '/' + relativeEntry;
  const outputPath = workspace + '/formforge-output.' + workerData.format;
  const paramsPath = workspace + '/formforge-parameters.json';
  const parameterSetValues = { ...workerData.values };
  const nestedOverrides = Object.entries(workerData.nestedParameterOverrides || {}).flatMap(([name, value]) => {
    delete parameterSetValues[name];
    return ['-D', name + '=' + JSON.stringify(value)];
  });
  writeVirtualFile(module, paramsPath, JSON.stringify({ fileFormatVersion: '1', parameterSets: { FormForge: parameterSetValues } }));
  const qualityOverrides = workerData.quality
    ? ['-D', '$fn=0', '-D', '$fa=' + workerData.quality.fa, '-D', '$fs=' + workerData.quality.fs]
    : [];
  // Binary STL is lossless for slicers and roughly five times smaller than OpenSCAD's default ASCII STL.
  const formatArguments = workerData.format === 'stl' ? ['--export-format', 'binstl'] : [];
  // lazy-union keeps top-level parts apart, so each becomes its own 3MF object.
  const featureArguments = workerData.separateObjects ? ['--enable=lazy-union'] : [];
  try {
    module.callMain(['-o', outputPath, ...formatArguments, ...featureArguments, '-p', paramsPath, '-P', 'FormForge', ...nestedOverrides, ...qualityOverrides, inputPath]);
  } catch (error) {
    if (error?.name !== 'ExitStatus' || error.status !== 0) {
      const diagnostics = lines.slice(-30).join('\n');
      throw new Error('OpenSCAD rendering failed: ' + describeError(error) + (diagnostics ? '\n\nOpenSCAD output:\n' + diagnostics : ''));
    }
  }
  const diagnostics = lines.join('\n');
  if (/current top level object is empty|geometr(?:y|ies) in cache:\s*0/i.test(diagnostics)) {
    throw new Error('The model produced no geometry. Check the parameter values and make sure the SCAD file generates a 3D object.' + (diagnostics ? '\n\nOpenSCAD output:\n' + diagnostics.slice(-4000) : ''));
  }
  let output;
  try { output = module.FS.readFile(outputPath); } catch {
    throw new Error('OpenSCAD WASM did not produce a ' + workerData.format.toUpperCase() + ' file. The model may contain no 3D geometry or use unsupported features.' + (lines.length ? '\n' + lines.slice(-20).join('\n') : ''));
  }
  if (!output.byteLength) throw new Error('OpenSCAD WASM produced an empty mesh file.');
  const result = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  // Messages for the app (echo("formforge-item", ...), echo("formforge-plates", n)); parsed in the main process.
  const itemEchoes = lines.filter(line => line.startsWith('ECHO: "formforge-')).slice(0, 1000);
  parentPort.postMessage({ output: result, itemEchoes }, [result]);
}

main().catch(error => parentPort.postMessage({ error: describeError(error) }));
