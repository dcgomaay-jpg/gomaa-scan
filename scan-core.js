/* Shared OpenCV operations. Runs in a worker, or on the main thread as a fallback. */
(function (root) {
  'use strict';
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function orderPoints(points) {
    const center = points.reduce((sum, p) => ({ x: sum.x + p.x / 4, y: sum.y + p.y / 4 }), { x: 0, y: 0 });
    const sorted = points.map(p => ({ ...p })).sort((a, b) =>
      Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
    const start = sorted.reduce((best, p, i) => p.x + p.y < sorted[best].x + sorted[best].y ? i : best, 0);
    return sorted.slice(start).concat(sorted.slice(0, start));
  }
  function insetQuad(width, height, inset = 0.025) {
    const x = (width - 1) * inset, y = (height - 1) * inset;
    return [{ x, y }, { x: width - 1 - x, y }, { x: width - 1 - x, y: height - 1 - y }, { x, y: height - 1 - y }];
  }
  function validQuad(points) {
    if (points.length !== 4 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
    let sign = 0, area = 0;
    for (let i = 0; i < 4; i++) {
      const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-8 || (sign && Math.sign(cross) !== sign)) return false;
      sign = Math.sign(cross); area += a.x * b.y - b.x * a.y;
    }
    return sign > 0 && area / 2 > 0;
  }
  function create(cv) {
    // Every Mat/MatVector allocated by an operation is released, including errors.
    function managed(operation) {
      const objects = [], keep = value => (objects.push(value), value);
      try { return operation(keep); }
      finally { for (let i = objects.length - 1; i >= 0; i--) objects[i].delete(); }
    }
    function read(frame, keep) {
      return keep(cv.matFromArray(frame.height, frame.width, cv.CV_8UC4, frame.data));
    }
    function pixels(mat, keep) {
      let rgba = mat;
      if (mat.channels() !== 4) {
        rgba = keep(new cv.Mat());
        cv.cvtColor(mat, rgba, mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
      }
      // Copy before deleting the Mat; returned buffers must not alias WASM memory.
      return { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
    }
    function blockSize(mat, desired = 31) {
      const limit = Math.min(mat.rows, mat.cols);
      return Math.max(3, Math.min(desired, limit % 2 ? limit : limit - 1));
    }
    function findQuad(mask, keep) {
      const contours = keep(new cv.MatVector()), hierarchy = keep(new cv.Mat());
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const total = mask.rows * mask.cols;
      let best = null, bestArea = total * 0.20;
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i), approx = new cv.Mat();
        try {
          const area = Math.abs(cv.contourArea(contour));
          if (area <= bestArea || area >= total * 0.985) continue;
          const perimeter = cv.arcLength(contour, true);
          for (const epsilon of [0.02, 0.03, 0.04]) {
            cv.approxPolyDP(contour, approx, perimeter * epsilon, true);
            if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
            if (Math.abs(cv.contourArea(approx)) <= total * 0.20) continue;
            const points = Array.from({ length: 4 }, (_, j) => ({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] }));
            const ordered = orderPoints(points);
            if (validQuad(ordered)) { best = ordered; bestArea = area; break; }
          }
        } finally { approx.delete(); contour.delete(); }
      }
      return best;
    }
    function confidence(points, gray) {
      // Check the actual paper/background boundary, not just a rectangular contour.
      const sample = (x, y) => gray.data[Math.round(Math.max(0, Math.min(gray.rows - 1, y))) * gray.cols + Math.round(Math.max(0, Math.min(gray.cols - 1, x)))];
      const contrasts = [];
      for (let edge = 0; edge < 4; edge++) {
        const a = points[edge], b = points[(edge + 1) % 4], length = distance(a, b);
        const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
        let supported = 0, difference = 0;
        for (let i = 1; i <= 18; i++) {
          const t = i / 19, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          const delta = sample(x + nx * 6, y + ny * 6) - sample(x - nx * 6, y - ny * 6);
          difference += delta; if (delta > 8) supported++;
        }
        contrasts.push({ mean: difference / 18, support: supported / 18 });
      }
      const clipped = points.some(p => p.x < 3 || p.y < 3 || p.x > gray.cols - 4 || p.y > gray.rows - 4);
      const mean = contrasts.reduce((sum, edge) => sum + edge.mean, 0) / 4;
      const weakest = Math.min(...contrasts.map(edge => edge.support));
      const score = Math.max(0, Math.min(1, 0.35 + Math.min(0.4, Math.max(0, mean) / 100) + weakest * 0.25));
      return { confidence: score, safeToCrop: !clipped && mean > 12 && weakest >= 0.5 && score >= 0.72,
        reason: clipped ? 'clipped' : weakest < 0.5 ? 'uncertainBoundary' : 'boundary', boundaryContrast: mean };
    }
    function detect(frame, options = {}) {
      return managed(keep => {
        const src = read(frame, keep), small = keep(new cv.Mat());
        const scale = Math.min(1, 500 / frame.height, 900 / frame.width);
        cv.resize(src, small, new cv.Size(Math.max(2, Math.round(frame.width * scale)), Math.max(2, Math.round(frame.height * scale))), 0, 0, cv.INTER_AREA);
        const gray = keep(new cv.Mat()), blur = keep(new cv.Mat()), mask = keep(new cv.Mat());
        cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
        let points = null, method = 'canny';
        if (!options.thresholdOnly) {
          cv.Canny(blur, mask, 45, 135);
          cv.dilate(mask, mask, keep(cv.Mat.ones(3, 3, cv.CV_8U)));
          points = findQuad(mask, keep);
        }
        if (!points && Math.min(blur.rows, blur.cols) >= 3) {
          method = 'adaptive';
          const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
          for (const threshold of [cv.THRESH_BINARY, cv.THRESH_BINARY_INV]) {
            cv.adaptiveThreshold(blur, mask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, threshold, blockSize(blur, 51), 7);
            cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
            points = findQuad(mask, keep);
            if (points) break;
          }
        }
        if (!points) return { found: false, safeToCrop: false, confidence: 0, method: 'full', points: insetQuad(frame.width, frame.height, 0) };
        return { found: true, method, ...confidence(points, gray), points: points.map(p => ({
          x: p.x * (frame.width - 1) / (small.cols - 1), y: p.y * (frame.height - 1) / (small.rows - 1)
        })) };
      });
    }
    function warp(frame, corners) {
      return managed(keep => {
        const points = orderPoints(corners);
        if (!validQuad(points)) throw new Error('invalidCorners');
        const width = Math.max(2, Math.round(Math.max(distance(points[0], points[1]), distance(points[3], points[2]))));
        const height = Math.max(2, Math.round(Math.max(distance(points[0], points[3]), distance(points[1], points[2]))));
        const src = read(frame, keep), dst = keep(new cv.Mat());
        const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, points.flatMap(p => [p.x, p.y])));
        const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]));
        const transform = keep(cv.getPerspectiveTransform(from, to));
        cv.warpPerspective(src, dst, transform, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
        return pixels(dst, keep);
      });
    }
    function enhance(frame, options = {}) {
      return managed(keep => {
        const src = read(frame, keep), result = keep(new cv.Mat()), gray = keep(new cv.Mat());
        const filter = options.filter || 'original';
        if (['auto', 'document', 'gray', 'bw', 'shadows'].includes(filter)) cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        if (filter === 'auto') {
          const small = keep(new cv.Mat()), background = keep(new cv.Mat()), fullBackground = keep(new cv.Mat());
          const scale = Math.min(1, 600 / Math.max(frame.width, frame.height));
          cv.resize(gray, small, new cv.Size(Math.max(2, Math.round(frame.width * scale)), Math.max(2, Math.round(frame.height * scale))), 0, 0, cv.INTER_AREA);
          // Estimate illumination at low resolution; no binary thresholding of colored ink.
          const size = blockSize(small, 21), kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size)));
          cv.morphologyEx(small, background, cv.MORPH_CLOSE, kernel);
          cv.GaussianBlur(background, background, new cv.Size(0, 0), 9);
          cv.resize(background, fullBackground, new cv.Size(frame.width, frame.height), 0, 0, cv.INTER_LINEAR);
          const rgb = keep(new cv.Mat()), denoised = keep(new cv.Mat()), normalized = keep(new cv.Mat()), softened = keep(new cv.Mat());
          cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
          cv.bilateralFilter(rgb, denoised, 5, 16, 3, cv.BORDER_REPLICATE);
          denoised.copyTo(normalized);
          for (let i = 0; i < fullBackground.data.length; i++) {
            const gain = Math.min(3.5, 245 / Math.max(40, fullBackground.data[i]));
            for (let c = 0; c < 3; c++) normalized.data[i * 3 + c] = Math.min(255, denoised.data[i * 3 + c] * gain);
          }
          cv.GaussianBlur(normalized, softened, new cv.Size(0, 0), 0.8);
          normalized.copyTo(result);
          // Thresholded, mild unsharp mask: preserve fine ink and avoid sharpening noise.
          for (let i = 0; i < result.data.length; i++) {
            const detail = normalized.data[i] - softened.data[i];
            if (Math.abs(detail) >= 3) result.data[i] = Math.max(0, Math.min(255, normalized.data[i] + detail * 0.28));
          }
        } else if (filter === 'document' || filter === 'shadows') {
          const background = keep(new cv.Mat());
          // Scale the background estimate to the image size, preserving small text strokes.
          let size = Math.max(7, Math.round(Math.min(frame.width, frame.height) * 0.025));
          if (!(size % 2)) size++;
          const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size)));
          cv.dilate(gray, background, kernel);
          cv.GaussianBlur(background, background, new cv.Size(0, 0), Math.max(3, size * 0.7));
          if (filter === 'document') {
            for (let i = 0; i < background.data.length; i++) background.data[i] = Math.max(32, background.data[i]);
            const foregroundFloat = keep(new cv.Mat()), backgroundFloat = keep(new cv.Mat()), normalized = keep(new cv.Mat());
            gray.convertTo(foregroundFloat, cv.CV_32F); background.convertTo(backgroundFloat, cv.CV_32F);
            cv.divide(foregroundFloat, backgroundFloat, normalized, 255);
            normalized.convertTo(result, cv.CV_8U, 1.10, -20);
          } else {
            src.copyTo(result);
            for (let i = 0; i < background.data.length; i++) {
              const gain = 250 / Math.max(32, background.data[i]);
              for (let c = 0; c < 3; c++) result.data[i * 4 + c] = Math.min(255, src.data[i * 4 + c] * gain);
            }
          }
        } else if (filter === 'bw') {
          cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
          if (Math.min(gray.rows, gray.cols) >= 3) cv.adaptiveThreshold(gray, result, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize(gray), 11);
          else cv.threshold(gray, result, 127, 255, cv.THRESH_BINARY);
        } else if (filter === 'gray') gray.copyTo(result);
        else if (filter === 'magic') {
          const blur = keep(new cv.Mat()), boosted = keep(new cv.Mat());
          src.convertTo(boosted, -1, 1.12, 3);
          cv.GaussianBlur(boosted, blur, new cv.Size(0, 0), 1);
          cv.addWeighted(boosted, 1.35, blur, -0.35, 0, result);
        } else if (filter === 'lighten') src.convertTo(result, -1, 1.08, 22);
        else src.copyTo(result);
        const output = pixels(result, keep), brightness = Number(options.brightness || 0), contrast = Number(options.contrast || 0);
        if (brightness || contrast) {
          const gain = (100 + contrast) / 100;
          for (let i = 0; i < output.data.length; i += 4) for (let c = 0; c < 3; c++)
            output.data[i + c] = (output.data[i + c] - 128) * gain + 128 + brightness * 2;
        }
        return output;
      });
    }
    return { detect, warp, enhance };
  }
  root.GomaaScanCore = { create, orderPoints, validQuad, insetQuad };
})(typeof self !== 'undefined' ? self : globalThis);
