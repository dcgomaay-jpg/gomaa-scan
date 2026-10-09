/* Lightweight lazy loader and transferable pixel bridge. No OpenCV load at startup. */
(function (root) {
  'use strict';
  const CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js';
  function create() {
    let worker = null, main = null, readyPromise = null, sequence = 0;
    const pending = new Map();
    function stopWorker(error) {
      worker?.terminate(); worker = null;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
    }
    function request(type, payload = {}, transfer = []) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          const error = new Error('Scanner timed out');
          stopWorker(error); readyPromise = null;
        }, type === 'init' ? 95000 : 45000);
        pending.set(id, { resolve, reject, timer });
        try { worker.postMessage({ id, type, ...payload }, transfer); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    }
    async function loadMain() {
      if (!root.cv) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = CV_URL; script.crossOrigin = 'anonymous';
        const timer = setTimeout(() => { script.remove(); reject(new Error('OpenCV download timed out')); }, 90000);
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('OpenCV download failed')); };
        document.head.append(script);
      });
      let cv = root.cv;
      if (Object.prototype.toString.call(cv) === '[object Promise]') cv = await cv;
      const start = Date.now();
      while (!cv?.Mat) {
        if (Date.now() - start > 90000) throw new Error('OpenCV initialization timed out');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (typeof cv.then === 'function') delete cv.then;
      main = root.GomaaScanCore.create(cv);
      return { mode: 'main' };
    }
    function ready() {
      if (readyPromise) return readyPromise;
      readyPromise = (async () => {
        if (typeof Worker !== 'undefined') {
          try {
            worker = new Worker(new URL('./scan-worker.js', document.baseURI));
            worker.onmessage = event => {
              const entry = pending.get(event.data.id); if (!entry) return;
              pending.delete(event.data.id); clearTimeout(entry.timer);
              if (event.data.error) entry.reject(new Error(event.data.error)); else entry.resolve(event.data.result);
            };
            worker.onerror = event => { stopWorker(new Error(event.message || 'Scanner worker failed')); readyPromise = null; };
            return await request('init', { cvUrl: CV_URL });
          } catch (error) { stopWorker(error); }
        }
        // Browsers without Worker/CSP support still get the same scanner pipeline.
        return loadMain();
      })().catch(error => { readyPromise = null; throw error; });
      return readyPromise;
    }
    async function run(type, source, options = {}, corners) {
      await ready();
      const ctx = source.getContext('2d', { willReadFrequently: true });
      const image = ctx.getImageData(0, 0, source.width, source.height);
      const frame = { width: source.width, height: source.height, data: image.data };
      if (worker) return request(type, { frame, options, corners }, [image.data.buffer]);
      // Yield so loading indicators paint before the main-thread fallback.
      await new Promise(resolve => setTimeout(resolve, 0));
      return type === 'warp' ? main.warp(frame, corners) : main[type](frame, options);
    }
    async function detect(source, options) {
      // Keep live analysis small; after capture use more detail for faint edges.
      // Neither path transfers the full-resolution camera photo for detection.
      const scale = Math.min(1, (options?.thorough ? 900 : 500) / source.height, (options?.thorough ? 1200 : 900) / source.width);
      let sample = source;
      if (scale < 1) {
        sample = document.createElement('canvas');
        sample.width = Math.max(2, Math.round(source.width * scale)); sample.height = Math.max(2, Math.round(source.height * scale));
        sample.getContext('2d').drawImage(source, 0, 0, sample.width, sample.height);
      }
      const result = await run('detect', sample, options);
      result.points = result.points.map(p => ({ x: p.x * (source.width - 1) / (sample.width - 1), y: p.y * (source.height - 1) / (sample.height - 1) }));
      return result;
    }
    return {
      ready, detect,
      warp: (source, corners) => run('warp', source, {}, corners),
      enhance: (source, options) => run('enhance', source, options),
      dispose: () => { stopWorker(new Error('Scanner closed')); main = null; readyPromise = null; }
    };
  }
  root.GomaaScanEngine = { create, CV_URL };
})(window);
