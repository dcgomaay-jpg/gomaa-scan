/* Optional orientation detection. Its worker is separate from the existing OCR flow. */
(function (root) {
  'use strict';
  function create(options) {
    let worker = null, preparing = null, generation = 0, idleTimer = 0;
    function dispose() {
      generation++; clearTimeout(idleTimer);
      const previous = worker; worker = null; preparing = null;
      if (previous) previous.terminate().catch(() => {});
    }
    function idle() { clearTimeout(idleTimer); idleTimer = setTimeout(dispose, 60000); }
    function prepare() {
      if (preparing) return preparing;
      const token = generation;
      preparing = (async () => {
        const OCR = await options.loadOCR();
        if (token !== generation) return null;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        let url;
        try {
          const response = await fetch(options.workerPath, { signal: controller.signal });
          if (!response.ok) throw new Error('Orientation worker unavailable');
          url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
          const ready = await OCR.createWorker('osd', 0, {
            workerPath: url, workerBlobURL: false, corePath: options.corePath,
            langPath: options.langPath, legacyCore: true, legacyLang: true,
            cachePath: 'gomaa-orientation', errorHandler: () => {}
          });
          if (token !== generation) { await ready.terminate(); return null; }
          worker = ready; idle(); return worker;
        } finally { clearTimeout(timer); if (url) URL.revokeObjectURL(url); }
      })().catch(() => { if (token === generation) preparing = null; return null; });
      return preparing;
    }
    async function bounded(promise, ms) {
      let timer;
      try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
      finally { clearTimeout(timer); }
    }
    async function angle(source) {
      // Never block a capture on a first-time OCR download. Warm up on camera open.
      const ready = worker || await bounded(prepare(), 700);
      if (!ready) return { rotation: 0, confident: false };
      clearTimeout(idleTimer);
      try {
        const result = await bounded(ready.detect(source), 1800);
        if (!result) { dispose(); return { rotation: 0, confident: false }; }
        const degrees = Number(result.data.orientation_degrees), confidence = Number(result.data.orientation_confidence);
        const confident = Number.isFinite(confidence) && confidence >= 15 && [0, 90, 180, 270].includes(degrees);
        // Tesseract.js returns the corrective clockwise rotation, verified on
        // upright, sideways and upside-down pages (not the input camera angle).
        idle(); return { rotation: confident ? degrees : 0, confident, confidence };
      } catch { dispose(); return { rotation: 0, confident: false }; }
    }
    return { prepare, angle, dispose };
  }
  root.GomaaScanOrientation = { create };
})(window);
