/* OpenCV stays off the UI thread. No document or camera data leaves this worker. */
'use strict';
importScripts('./scan-core.js');
let processor = null;
async function initialize(url) {
  if (processor) return;
  importScripts(url);
  let cv = self.cv;
  if (Object.prototype.toString.call(cv) === '[object Promise]') cv = await cv;
  const start = Date.now();
  while (!cv?.Mat) {
    if (Date.now() - start > 90000) throw new Error('OpenCV initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // This Emscripten build exposes a self-returning thenable.
  if (typeof cv.then === 'function') delete cv.then;
  processor = GomaaScanCore.create(cv);
}
self.onmessage = async event => {
  const { id, type, cvUrl, frame, options, corners } = event.data;
  try {
    if (type === 'init') { await initialize(cvUrl); self.postMessage({ id, result: { mode: 'worker' } }); return; }
    if (!processor || !['detect', 'warp', 'enhance'].includes(type)) throw new Error('Scanner not ready');
    const result = type === 'warp' ? processor.warp(frame, corners) : processor[type](frame, options);
    self.postMessage({ id, result }, result.data ? [result.data.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
