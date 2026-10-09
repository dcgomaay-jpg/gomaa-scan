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
    function findQuads(mask, keep, minimumArea = 0.20) {
      const contours = keep(new cv.MatVector()), hierarchy = keep(new cv.Mat());
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const total = mask.rows * mask.cols, candidates = [];
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i), approx = new cv.Mat();
        try {
          const area = Math.abs(cv.contourArea(contour));
          if (area <= total * minimumArea || area >= total * 0.985) continue;
          for (const epsilon of [0.012, 0.02, 0.03, 0.04]) {
            cv.approxPolyDP(contour, approx, cv.arcLength(contour, true) * epsilon, true);
            if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
            const points = orderPoints(Array.from({ length: 4 }, (_, j) => ({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] })));
            if (validQuad(points) && quadArea(points) > total * minimumArea) candidates.push({ points, area });
            break;
          }
        } finally { approx.delete(); contour.delete(); }
      }
      return candidates.sort((a, b) => b.area - a.area).slice(0, 24);
    }
    function quadArea(points) {
      return points.reduce((sum, p, i) => {
        const next = points[(i + 1) % 4]; return sum + p.x * next.y - next.x * p.y;
      }, 0) / 2;
    }
    function sampler(mat, channel = 0) {
      const data = mat.data, width = mat.cols, height = mat.rows, channels = mat.channels();
      return (x, y) => data[(Math.round(Math.max(0, Math.min(height - 1, y))) * width + Math.round(Math.max(0, Math.min(width - 1, x)))) * channels + channel];
    }
    function insideFrame(points, width, height) {
      return points.every(p => p.x >= 3 && p.y >= 3 && p.x <= width - 4 && p.y <= height - 4);
    }
    function surfacePoint(points, u, v) {
      return {
        x: (1 - v) * ((1 - u) * points[0].x + u * points[1].x) + v * ((1 - u) * points[3].x + u * points[2].x),
        y: (1 - v) * ((1 - u) * points[0].y + u * points[1].y) + v * ((1 - u) * points[3].y + u * points[2].y)
      };
    }
    function inkAt(sample, x, y) {
      return (sample(x - 2, y) + sample(x + 2, y) + sample(x, y - 2) + sample(x, y + 2)) / 4 - sample(x, y);
    }
    function inkCount(points, gray) {
      const sample = sampler(gray); let count = 0;
      for (let row = 0; row < 28; row++) for (let col = 0; col < 20; col++) {
        const p = surfacePoint(points, 0.07 + col / 19 * 0.86, 0.07 + row / 27 * 0.86);
        if (inkAt(sample, p.x, p.y) > 6) count++;
      }
      return count;
    }
    function cutsContent(points, gray, lab) {
      // Look for text just outside a proposed crop on the SAME paper material.
      // Colored fabric/desk patterns are not treated as text belonging to the page.
      const g = sampler(gray), a = sampler(lab, 1), b = sampler(lab, 2);
      const short = Math.min(...points.map((p, i) => distance(p, points[(i + 1) % 4])));
      let count = 0, nearCount = 0;
      for (let edge = 0; edge < 4; edge++) {
        const p = points[edge], q = points[(edge + 1) % 4], length = distance(p, q);
        const nx = -(q.y - p.y) / length, ny = (q.x - p.x) / length;
        // A crop can bisect a letter only 1–3 analysis pixels from its edge.
        // Sample densely along the edge; tangential contrast avoids confusing
        // the paper's physical border with text that continues outside it.
        const ux = (q.x - p.x) / length, uy = (q.y - p.y) / length;
        const steps = Math.ceil(length);
        for (let j = 1; j < steps; j++) {
          const t = j / steps, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
          for (const depth of [1, 2, 3]) {
            const ox = x - nx * depth, oy = y - ny * depth;
            const ridge = (g(ox - ux * 2, oy - uy * 2) + g(ox + ux * 2, oy + uy * 2)) / 2 - g(ox, oy);
            if (ridge <= 20) continue;
            const referenceA = a(x + nx * 8, y + ny * 8), referenceB = b(x + nx * 8, y + ny * 8);
            const backgroundA = (a(ox - ux * 3, oy - uy * 3) + a(ox + ux * 3, oy + uy * 3)) / 2;
            const backgroundB = (b(ox - ux * 3, oy - uy * 3) + b(ox + ux * 3, oy + uy * 3)) / 2;
            if (Math.abs(backgroundA - referenceA) < 3.5 && Math.abs(backgroundB - referenceB) < 3.5 && ++nearCount > 8) return true;
          }
        }
        for (let j = 1; j <= 70; j++) {
          const t = j / 71, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
          for (let d = 4; d < Math.min(28, short * 0.18); d += 3) {
            const ox = x - nx * d, oy = y - ny * d;
            if (inkAt(g, ox, oy) <= 6) continue;
            const referenceA = a(x + nx * 8, y + ny * 8), referenceB = b(x + nx * 8, y + ny * 8);
            const backgroundA = (a(ox - 3, oy) + a(ox + 3, oy) + a(ox, oy - 3) + a(ox, oy + 3)) / 4;
            const backgroundB = (b(ox - 3, oy) + b(ox + 3, oy) + b(ox, oy - 3) + b(ox, oy + 3)) / 4;
            if (Math.abs(backgroundA - referenceA) < 3.5 && Math.abs(backgroundB - referenceB) < 3.5 && ++count > 8) return true;
          }
        }
      }
      return false;
    }
    function strongConfidence(points, gray) {
      if (!insideFrame(points, gray.cols, gray.rows)) return 0;
      const sample = sampler(gray), contrasts = [];
      for (let edge = 0; edge < 4; edge++) {
        const a = points[edge], b = points[(edge + 1) % 4], length = distance(a, b);
        const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
        let support = 0, mean = 0;
        for (let i = 1; i <= 18; i++) {
          const t = i / 19, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          const delta = sample(x + nx * 6, y + ny * 6) - sample(x - nx * 6, y - ny * 6);
          mean += delta; if (delta > 8) support++;
        }
        contrasts.push({ mean: mean / 18, support: support / 18 });
      }
      const mean = contrasts.reduce((sum, edge) => sum + edge.mean, 0) / 4;
      const weakest = Math.min(...contrasts.map(edge => edge.support));
      const score = Math.min(1, 0.35 + Math.min(0.4, Math.max(0, mean) / 100) + weakest * 0.25);
      return mean > 12 && weakest >= 0.5 && score >= 0.72 ? score : 0;
    }
    function regionQuality(points, mask) {
      if (!insideFrame(points, mask.cols, mask.rows)) return 0;
      const sample = sampler(mask); let fill = 0, weakest = 1;
      for (let row = 0; row < 28; row++) for (let col = 0; col < 20; col++) {
        const p = surfacePoint(points, 0.05 + col / 19 * 0.9, 0.05 + row / 27 * 0.9);
        fill += sample(p.x, p.y) / 255;
      }
      fill /= 560; if (fill < 0.85) return 0;
      for (let edge = 0; edge < 4; edge++) {
        const a = points[edge], b = points[(edge + 1) % 4], length = distance(a, b);
        const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
        let inside = 0, outside = 0;
        for (let i = 1; i <= 50; i++) {
          const t = i / 51, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          inside += sample(x + nx * 4, y + ny * 4) / 255;
          outside += sample(x - nx * 4, y - ny * 4) / 255;
        }
        inside /= 50; outside /= 50;
        if (inside < 0.72 || outside > 0.38) return 0;
        weakest = Math.min(weakest, inside - outside);
      }
      return fill + weakest;
    }
    function outsidePageContent(points, gray, lab) {
      // A shaded printed table can look like a separate sheet. Check the whole
      // remaining image for ink on the same paper, including distant headers.
      const g = sampler(gray), a = sampler(lab, 1), b = sampler(lab, 2);
      // Estimate paper from a bright interior sample, not a letter or colored
      // stamp that could accidentally match an object in the background.
      let reference = surfacePoint(points, 0.1, 0.1), brightness = -1;
      for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
        const p = surfacePoint(points, 0.1 + col * 0.2, 0.1 + row * 0.2), value = g(p.x, p.y);
        if (value > brightness) { brightness = value; reference = p; }
      }
      const referenceA = a(reference.x, reference.y), referenceB = b(reference.x, reference.y);
      let count = 0;
      for (let y = 3; y < gray.rows - 3; y += 2) for (let x = 3; x < gray.cols - 3; x += 2) {
        let inside = true;
        for (let i = 0; i < 4; i++) {
          const p = points[i], q = points[(i + 1) % 4];
          if ((q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x) < 0) { inside = false; break; }
        }
        if (inside || inkAt(g, x, y) < 12) continue;
        const backgroundLight = (g(x - 3, y) + g(x + 3, y) + g(x, y - 3) + g(x, y + 3)) / 4;
        // Neutral dark desk edges may share paper chroma. They still need a
        // paper-like surrounding brightness before being counted as lost ink.
        if (backgroundLight < brightness * 0.55) continue;
        const backgroundA = (a(x - 3, y) + a(x + 3, y) + a(x, y - 3) + a(x, y + 3)) / 4;
        const backgroundB = (b(x - 3, y) + b(x + 3, y) + b(x, y - 3) + b(x, y + 3)) / 4;
        if (Math.abs(backgroundA - referenceA) < 3.5 && Math.abs(backgroundB - referenceB) < 3.5 && ++count > 8) return true;
      }
      return false;
    }
    function colorRegions(lab, gray, keep) {
      const channel = keep(new cv.Mat(lab.rows, lab.cols, cv.CV_8UC1));
      const blur = keep(new cv.Mat()), mask = keep(new cv.Mat()), kernel = keep(cv.Mat.ones(5, 5, cv.CV_8U));
      const total = lab.rows * lab.cols, candidates = [];
      let blockedRefinement = false;
      // Chroma separates gray paper from similarly bright colored backgrounds.
      // Thresholds come from this photo's histogram, never a fixed paper color.
      // If chroma is inconclusive, also test lightness for white-on-white paper.
      for (const index of [1, 2, 0]) {
        if (index === 0 && candidates.length) break;
        // Lightness also separates ink, so close text-sized holes before testing
        // the paper material. Still require filled paper and a change on all sides.
        const regionKernel = index === 0 ? keep(cv.Mat.ones(11, 11, cv.CV_8U)) : kernel;
        const colors = lab.data, values = channel.data;
        for (let i = 0; i < total; i++) values[i] = colors[i * 3 + index];
        cv.GaussianBlur(channel, blur, new cv.Size(3, 3), 0);
        const histogram = new Uint32Array(256); for (const value of blur.data) histogram[value]++;
        const thresholds = new Set(), quantiles = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];
        let cumulative = 0, quantile = 0;
        for (let value = 0; value < 256; value++) {
          cumulative += histogram[value];
          while (quantile < quantiles.length && cumulative >= total * quantiles[quantile]) {
            for (const delta of [-1, 0, 1]) if (value + delta > 0 && value + delta < 255) thresholds.add(value + delta);
            quantile++;
          }
        }
        for (const threshold of thresholds) for (const polarity of [cv.THRESH_BINARY, cv.THRESH_BINARY_INV]) {
          cv.threshold(blur, mask, threshold, 255, polarity);
          cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, regionKernel);
          // Release each contour collection immediately to bound mobile memory.
          const quads = managed(local => findQuads(mask, local));
          for (const quad of quads) {
            const quality = regionQuality(quad.points, mask);
            // The region mask already requires this material to stop outside
            // all four sides. Ink on a different surface (e.g. floral fabric)
            // must not be mistaken for text cut off from this page.
            if (!quality || inkCount(quad.points, gray) < 6) continue;
            if (index === 0 && outsidePageContent(quad.points, gray, lab)) {
              // Do not later recover this excluded table through line fitting.
              blockedRefinement = true; continue;
            }
            candidates.push({ ...quad, quality, method: 'colorRegion', confidence: Math.min(0.94, 0.7 + quality * 0.12) });
          }
        }
      }
      return { quads: candidates.sort((a, b) => b.quality - a.quality).slice(0, 5), blockedRefinement };
    }
    function intersectLines(a, b) {
      const cross = a.ux * b.uy - a.uy * b.ux;
      if (Math.abs(cross) < 0.1) return null;
      const t = ((b.mx - a.mx) * b.uy - (b.my - a.my) * b.ux) / cross;
      return { x: a.mx + t * a.ux, y: a.my + t * a.uy };
    }
    function expandQuad(points, margin, width, height) {
      const lines = points.map((p, i) => {
        const q = points[(i + 1) % 4], length = distance(p, q), ux = (q.x - p.x) / length, uy = (q.y - p.y) / length;
        return { mx: p.x + uy * margin, my: p.y - ux * margin, ux, uy };
      });
      return lines.map((line, i) => intersectLines(lines[(i + 3) % 4], line)).map(p => ({ x: Math.max(0, Math.min(width - 1, p.x)), y: Math.max(0, Math.min(height - 1, p.y)) }));
    }
    function refineOutline(points, gray, lab) {
      const width = gray.cols, height = gray.rows, sample = sampler(gray);
      const short = Math.min(...points.map((p, i) => distance(p, points[(i + 1) % 4]))), groups = [];
      for (let edge = 0; edge < 4; edge++) {
        const a = points[edge], b = points[(edge + 1) % 4], angle = Math.atan2(b.y - a.y, b.x - a.x);
        const length = distance(a, b), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const nx = -Math.sin(angle), ny = Math.cos(angle), candidates = [];
        // Search close to an observed contour. Do not extrapolate distant desk
        // lines into a page or invent a page-sized rectangle around the text.
        for (let shift = -Math.ceil(short * 0.10); shift <= short * 0.10; shift++) for (const delta of [-0.10, -0.05, 0, 0.05, 0.10]) {
          const ux = Math.cos(angle + delta), uy = Math.sin(angle + delta), vx = -uy, vy = ux;
          const mx = cx - nx * shift, my = cy - ny * shift;
          let support = 0, strength = 0, ink = 0, outsideInk = 0;
          for (let k = 0; k < 50; k++) {
            const t = (k / 49 - 0.5) * length * 0.88, x = mx + ux * t, y = my + uy * t;
            if (x < 10 || y < 10 || x > width - 11 || y > height - 11) continue;
            const step = Math.abs((sample(x + vx * 2, y + vy * 2) + sample(x + vx * 4, y + vy * 4) - sample(x - vx * 2, y - vy * 2) - sample(x - vx * 4, y - vy * 4)) / 2);
            const ridge = (sample(x + vx * 4, y + vy * 4) + sample(x - vx * 4, y - vy * 4)) / 2 - sample(x, y);
            const value = Math.max(step, ridge); if (value > 1) support++; strength += Math.min(8, value);
          }
          support /= 50; if (support < 0.64) continue;
          for (let k = 0; k < 40; k++) {
            const t = (k / 39 - 0.5) * length * 0.85;
            for (const depth of [5, 9, 14]) if (inkAt(sample, mx + ux * t + vx * depth, my + uy * t + vy * depth) > 5) ink++;
          }
          const blank = 1 - ink / 120; if (blank < 0.92) continue;
          for (let k = 0; k < 60; k++) {
            const t = (k / 59 - 0.5) * length * 0.9;
            for (let depth = 4; depth < Math.min(28, short * 0.18); depth += 3)
              if (inkAt(sample, mx + ux * t - vx * depth, my + uy * t - vy * depth) > 5) outsideInk++;
          }
          if (outsideInk >= 5) continue;
          candidates.push({ mx, my, ux, uy, support, score: strength / 50 + support * 3 + blank * 5 - Math.abs(shift) / short * 0.5 });
        }
        candidates.sort((a, b) => b.score - a.score);
        if (!candidates.length) return null;
        groups.push(candidates.slice(0, 3));
      }
      const combinations = [];
      for (const top of groups[0]) for (const right of groups[1]) for (const bottom of groups[2]) for (const left of groups[3]) {
        const lines = [top, right, bottom, left], quad = lines.map((line, i) => intersectLines(lines[(i + 3) % 4], line));
        if (quad.some(p => !p) || !validQuad(quad) || !insideFrame(quad, width, height) || quadArea(quad) < width * height * 0.20) continue;
        combinations.push({ points: quad, quality: lines.reduce((sum, line) => sum + line.score, 0) / 4 });
      }
      combinations.sort((a, b) => b.quality - a.quality);
      const best = combinations.find(candidate => !cutsContent(candidate.points, gray, lab));
      return best ? { ...best, area: quadArea(best.points), method: 'refinedOutline', confidence: 0.84 } : null;
    }
    function detectAtScale(frame, height, options) {
      return managed(keep => {
        const src = read(frame, keep), small = keep(new cv.Mat());
        const scale = Math.min(1, height / frame.height, 1000 / frame.width);
        cv.resize(src, small, new cv.Size(Math.max(2, Math.round(frame.width * scale)), Math.max(2, Math.round(frame.height * scale))), 0, 0, cv.INTER_AREA);
        const gray = keep(new cv.Mat()), blur = keep(new cv.Mat()), mask = keep(new cv.Mat());
        cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
        const candidates = [], collect = method => {
          for (const quad of managed(local => findQuads(mask, local))) {
            const confidence = strongConfidence(quad.points, gray);
            if (confidence) candidates.push({ ...quad, confidence, method, strong: true });
          }
        };
        if (!options.thresholdOnly) {
          cv.Canny(blur, mask, 45, 135); cv.dilate(mask, mask, keep(cv.Mat.ones(3, 3, cv.CV_8U))); collect('canny');
        }
        if (!candidates.length && Math.min(gray.rows, gray.cols) >= 3) {
          const kernel = keep(cv.Mat.ones(9, 9, cv.CV_8U));
          for (const threshold of [cv.THRESH_BINARY, cv.THRESH_BINARY_INV]) {
            cv.adaptiveThreshold(blur, mask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, threshold, blockSize(blur, 51), 7);
            cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel); collect('adaptive');
            if (candidates.length) break;
          }
        }
        if (!options.fast && !options.thresholdOnly) {
          const rgb = keep(new cv.Mat()), lab = keep(new cv.Mat());
          cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
          for (let i = candidates.length - 1; i >= 0; i--)
            if (cutsContent(candidates[i].points, gray, lab) || outsidePageContent(candidates[i].points, gray, lab)) candidates.splice(i, 1);
          let blockedRefinement = false;
          if (!candidates.length) {
            const regions = colorRegions(lab, gray, keep);
            candidates.push(...regions.quads); blockedRefinement = regions.blockedRefinement;
          }
          if (!candidates.length && !blockedRefinement) {
            const kernel = keep(cv.Mat.ones(5, 5, cv.CV_8U)), seeds = [];
            for (const low of [15, 6, 35]) {
              cv.Canny(blur, mask, low, low * 3); cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
              for (const quad of managed(local => findQuads(mask, local, 0.10))) {
                if (!insideFrame(quad.points, small.cols, small.rows) || quad.area > small.cols * small.rows * 0.85) continue;
                if (!seeds.some(seed => quad.points.every((p, i) => distance(p, seed.points[i]) < 5))) seeds.push(quad);
              }
            }
            seeds.sort((a, b) => b.area - a.area);
            for (const seed of seeds.slice(0, 4)) {
              if (inkCount(seed.points, gray) < 6) continue;
              const candidate = refineOutline(seed.points, gray, lab); if (candidate) candidates.push(candidate);
            }
          }
        }
        return candidates.map(candidate => ({ ...candidate, analysisHeight: small.rows, points: candidate.points.map(p => ({
          x: p.x * (frame.width - 1) / (small.cols - 1), y: p.y * (frame.height - 1) / (small.rows - 1)
        })) }));
      });
    }
    function detect(frame, options = {}) {
      const fallback = { found: false, safeToCrop: false, confidence: 0, method: 'full', points: insetQuad(frame.width, frame.height, 0) };
      const firstHeight = Math.min(500, frame.height);
      const heights = options.fast || options.thresholdOnly ? [firstHeight] : [...new Set([firstHeight, Math.min(700, frame.height) === firstHeight ? Math.round(firstHeight * 0.8) : Math.min(700, frame.height), Math.round(firstHeight * 0.9)])];
      const candidates = [];
      for (const height of heights) {
        const found = detectAtScale(frame, height, options);
        const strong = found.find(candidate => candidate.strong);
        if (strong) {
          const { area, quality, strong: flag, ...result } = strong;
          return { ...result, found: true, safeToCrop: true };
        }
        candidates.push(...found);
        // Weak/colored boundaries must agree at independent analysis sizes.
        // This prevents a one-off desk line or printed table from defining a crop.
        const tolerance = Math.min(frame.width, frame.height) * 0.035;
        for (const candidate of candidates) {
          const match = candidates.find(other => other.analysisHeight !== candidate.analysisHeight && candidate.points.every((p, i) => distance(p, other.points[i]) < tolerance));
          if (!match) continue;
          const selected = (candidate.quality || 0) >= (match.quality || 0) ? candidate : match;
          const { area, quality, ...result } = selected;
          const margin = 2.5 * (frame.height - 1) / (selected.analysisHeight - 1);
          return { ...result, found: true, safeToCrop: true, scaleAgreement: 2, points: expandQuad(selected.points, margin, frame.width, frame.height) };
        }
      }
      return fallback;
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
          cv.GaussianBlur(rgb, denoised, new cv.Size(3, 3), 0.7, 0.7, cv.BORDER_REPLICATE);
          // Keep strong ink edges intact while smoothing low-amplitude noise.
          const raw = rgb.data, smooth = denoised.data;
          for (let i = 0; i < raw.length; i += 3) {
            const edge = Math.max(Math.abs(raw[i] - smooth[i]), Math.abs(raw[i + 1] - smooth[i + 1]), Math.abs(raw[i + 2] - smooth[i + 2]));
            for (let c = 0; c < 3; c++) smooth[i + c] = edge >= 10 ? raw[i + c] : smooth[i + c] * 0.75 + raw[i + c] * 0.25;
          }
          denoised.copyTo(normalized);
          const illumination = fullBackground.data, normalizedData = normalized.data, normalizationInput = denoised.data;
          for (let i = 0; i < illumination.length; i++) {
            const gain = Math.min(3.5, 245 / Math.max(40, illumination[i]));
            for (let c = 0; c < 3; c++) normalizedData[i * 3 + c] = Math.min(255, normalizationInput[i * 3 + c] * gain);
          }
          cv.GaussianBlur(normalized, softened, new cv.Size(0, 0), 0.8);
          normalized.copyTo(result);
          // Thresholded, mild unsharp mask: preserve fine ink and avoid sharpening noise.
          const sharpenInput = normalized.data, softenedData = softened.data, resultData = result.data;
          for (let i = 0; i < resultData.length; i++) {
            const detail = sharpenInput[i] - softenedData[i];
            if (Math.abs(detail) >= 3) resultData[i] = Math.max(0, Math.min(255, sharpenInput[i] + detail * 0.28));
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
            const backgroundData = background.data;
            for (let i = 0; i < backgroundData.length; i++) backgroundData[i] = Math.max(32, backgroundData[i]);
            const foregroundFloat = keep(new cv.Mat()), backgroundFloat = keep(new cv.Mat()), normalized = keep(new cv.Mat());
            gray.convertTo(foregroundFloat, cv.CV_32F); background.convertTo(backgroundFloat, cv.CV_32F);
            cv.divide(foregroundFloat, backgroundFloat, normalized, 255);
            normalized.convertTo(result, cv.CV_8U, 1.10, -20);
          } else {
            src.copyTo(result);
            const backgroundData = background.data, sourceData = src.data, resultData = result.data;
            for (let i = 0; i < backgroundData.length; i++) {
              const gain = 250 / Math.max(32, backgroundData[i]);
              for (let c = 0; c < 3; c++) resultData[i * 4 + c] = Math.min(255, sourceData[i * 4 + c] * gain);
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
