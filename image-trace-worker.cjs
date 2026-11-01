// Runs vtracer off the main thread so large images do not freeze the app.
const { parentPort, workerData } = require('node:worker_threads');
const { traceImage } = require('./image-trace.cjs');

try {
  const { svg, colors, areas } = traceImage({ ...workerData, rgba: new Uint8Array(workerData.rgba) });
  parentPort.postMessage({ svg, colors, areas });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
