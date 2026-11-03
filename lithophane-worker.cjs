// Worker thread for the lithophane generator: reads the height map, builds the mesh with
// lithophane.cjs, and writes STL or 3MF. Same reply shape as scad-render-worker.cjs.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const { decodeGrayPng } = require('./heightmap.cjs');
const { buildLithophaneMesh, cropBorder, meshToStl, threeMfEntries } = require('./lithophane.cjs');
const { writeZip } = require('./mesh-transform.cjs');

async function main() {
  const { imagePath, values, format, preview, name } = workerData;
  let image = null;
  if (imagePath) {
    const bytes = new Uint8Array(await fs.readFile(imagePath));
    image = cropBorder(decodeGrayPng(bytes, data => new Uint8Array(zlib.inflateSync(data))));
  }
  const mesh = buildLithophaneMesh(image, values, { preview });
  let output;
  if (format === 'stl') {
    output = meshToStl(mesh);
  } else {
    const entries = threeMfEntries(mesh, { name, color: values.plate_color });
    output = writeZip(entries.map(entry => ({
      name: entry.name,
      data: entry.parts ? Buffer.concat(entry.parts.map(part => Buffer.from(part, 'utf8'))) : Buffer.from(entry.text, 'utf8')
    })));
  }
  const result = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  // Same text as OpenSCAD's echo("formforge-item", ...), parsed by transform.cjs in the main process.
  const itemEchoes = mesh.items.map(item => 'ECHO: ' + JSON.stringify(['formforge-item', item.id, ...item.center, ...item.size, item.rotation]).slice(1, -1));
  parentPort.postMessage({ output: result, itemEchoes, info: { ...mesh.info, demo: !image } }, [result]);
}

main().catch(error => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }));
