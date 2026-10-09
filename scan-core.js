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
    function findQuads(mask, keep) {
      const contours = keep(new cv.MatVector()), hierarchy = keep(new cv.Mat());
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const total = mask.rows * mask.cols;
      const candidates = [];
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i), approx = new cv.Mat();
        try {
          const area = Math.abs(cv.contourArea(contour));
          if (area <= total * 0.20 || area >= total * 0.985) continue;
          const perimeter = cv.arcLength(contour, true);
          for (const epsilon of [0.02, 0.03, 0.04]) {
            cv.approxPolyDP(contour, approx, perimeter * epsilon, true);
            if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
            if (Math.abs(cv.contourArea(approx)) <= total * 0.20) continue;
            const points = Array.from({ length: 4 }, (_, j) => ({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] }));
            const ordered = orderPoints(points);
            if (validQuad(ordered)) { candidates.push({ points: ordered, area }); break; }
          }
        } finally { approx.delete(); contour.delete(); }
      }
      return candidates.sort((a, b) => b.area - a.area).slice(0, 32);
    }
    function confidence(points, gray, allowWeak = false) {
      // Check the actual paper/background boundary, not just a rectangular contour.
      const values = gray.data;
      const sample = (x, y) => values[Math.round(Math.max(0, Math.min(gray.rows - 1, y))) * gray.cols + Math.round(Math.max(0, Math.min(gray.cols - 1, x)))];
      const contrasts = [];
      for (let edge = 0; edge < 4; edge++) {
        const a = points[edge], b = points[(edge + 1) % 4], length = distance(a, b);
        const nx = -(b.y - a.y) / length, ny = (b.x - a.x) / length;
        let supported = 0, difference = 0, weakSupported = 0, weakDifference = 0;
        for (let i = 1; i <= 18; i++) {
          const t = i / 19, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          const delta = sample(x + nx * 6, y + ny * 6) - sample(x - nx * 6, y - ny * 6);
          difference += delta; if (delta > 8) supported++;
          const step = [3, 5, 7].reduce((sum, offset) => sum + sample(x + nx * offset, y + ny * offset) - sample(x - nx * offset, y - ny * offset), 0) / 3;
          weakDifference += step; if (step >= 1.5) weakSupported++;
        }
        contrasts.push({ mean: difference / 18, support: supported / 18, weakMean: weakDifference / 18, weakSupport: weakSupported / 18 });
      }
      const clipped = points.some(p => p.x < 3 || p.y < 3 || p.x > gray.cols - 4 || p.y > gray.rows - 4);
      const mean = contrasts.reduce((sum, edge) => sum + edge.mean, 0) / 4;
      const weakest = Math.min(...contrasts.map(edge => edge.support));
      const score = Math.max(0, Math.min(1, 0.35 + Math.min(0.4, Math.max(0, mean) / 100) + weakest * 0.25));
      const strong = !clipped && mean > 12 && weakest >= 0.5 && score >= 0.72;
      // A faint paper edge must still form four consistent light/dark steps and
      // enclose actual text/ink. This rejects printed table borders and blank noise.
      const weakBoundary = !clipped && contrasts.every(edge => edge.weakMean >= 1.2 && edge.weakSupport >= 0.44);
      let ink = 0, outsideInk = 0;
      if (allowWeak && !strong && weakBoundary) {
        for (let row = 0; row < 28; row++) for (let col = 0; col < 20; col++) {
          const u = 0.07 + col / 19 * 0.86, v = 0.07 + row / 27 * 0.86;
          const x = (1-v)*((1-u)*points[0].x+u*points[1].x)+v*((1-u)*points[3].x+u*points[2].x);
          const y = (1-v)*((1-u)*points[0].y+u*points[1].y)+v*((1-u)*points[3].y+u*points[2].y);
          const local = (sample(x-2,y)+sample(x+2,y)+sample(x,y-2)+sample(x,y+2))/4;
          if (local - sample(x,y) >= 8) ink++;
        }
        // Reject an interior form/table rectangle if text or stamps continue just
        // outside it. The page boundary must enclose its content, not bisect it.
        for(let edge=0;edge<4;edge++){
          const a=points[edge],b=points[(edge+1)%4],length=distance(a,b),nx=-(b.y-a.y)/length,ny=(b.x-a.x)/length;
          for(let j=1;j<=26;j++)for(const offset of [2,4,6,9,13]){
            const t=j/27,x=a.x+(b.x-a.x)*t-nx*offset,y=a.y+(b.y-a.y)*t-ny*offset;
            const local=(sample(x-2,y)+sample(x+2,y)+sample(x,y-2)+sample(x,y+2))/4;
            if(local-sample(x,y)>=8)outsideInk++;
          }
        }
      }
      const weak = allowWeak && weakBoundary && ink >= 6 && outsideInk<=Math.max(3,ink*.08);
      return { confidence: strong ? score : weak ? 0.75 + Math.min(0.12, Math.min(...contrasts.map(edge=>edge.weakSupport))*0.15) : Math.min(0.69,score),
        safeToCrop: strong || weak, weakBoundary: weak, inkSamples: ink, outsideInkSamples: outsideInk,
        reason: strong ? 'boundary' : weak ? 'recoveredBoundary' : clipped ? 'clipped' : 'uncertainBoundary', boundaryContrast: mean };
    }
    function recoverLines(mask, gray, keep) {
      const lines = keep(new cv.Mat()), groups = { horizontal: [], vertical: [] };
      const min = Math.min(gray.rows, gray.cols);
      const grayData=gray.data,sample=(x,y)=>grayData[Math.round(Math.max(0,Math.min(gray.rows-1,y)))*gray.cols+Math.round(Math.max(0,Math.min(gray.cols-1,x)))];
      cv.HoughLinesP(mask, lines, 1, Math.PI / 180, Math.max(20, Math.round(min*0.09)), min*0.18, min*0.055);
      const values = lines.data32S;
      for (let i=0;i<lines.rows;i++) {
        const [x1,y1,x2,y2] = Array.from(values.subarray(i*4,i*4+4)), dx=x2-x1, dy=y2-y1;
        let direction;
        if (Math.abs(dx)>Math.abs(dy)*2) direction='horizontal';
        else if (Math.abs(dy)>Math.abs(dx)*2) direction='vertical'; else continue;
        const horizontal=direction==='horizontal', slope=horizontal?dy/dx:dx/dy;
        const length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length,steps=[];
        for(let j=1;j<=12;j++){const t=j/13,x=x1+dx*t,y=y1+dy*t;steps.push([3,5,7].reduce((sum,d)=>sum+sample(x+nx*d,y+ny*d)-sample(x-nx*d,y-ny*d),0)/3);}
        const stepMean=steps.reduce((sum,value)=>sum+value,0)/steps.length;
        const consistent=steps.filter(value=>Math.sign(value)===Math.sign(stepMean)&&Math.abs(value)>=1).length/steps.length;
        if(Math.abs(stepMean)<1||consistent<.5)continue;
        const center=horizontal?gray.cols/2:gray.rows/2;
        const offset=horizontal?y1+slope*(center-x1):x1+slope*(center-y1);
        const lo=Math.min(horizontal?x1:y1,horizontal?x2:y2),hi=Math.max(horizontal?x1:y1,horizontal?x2:y2);
        const list=groups[direction],near=list.find(line=>Math.abs(line.offset-offset)<3&&Math.abs(line.slope-slope)<0.035);
        if(near){const weight=near.weight+length;near.slope=(near.slope*near.weight+slope*length)/weight;near.offset=(near.offset*near.weight+offset*length)/weight;near.weight=weight;near.lo=Math.min(near.lo,lo);near.hi=Math.max(near.hi,hi);}
        else list.push({slope,offset,lo,hi,weight:length,horizontal});
      }
      for(const direction of ['horizontal','vertical']) groups[direction]=groups[direction].filter(line=>line.hi-line.lo>min*0.30&&line.offset>3&&line.offset<(line.horizontal?gray.rows:gray.cols)-4).sort((a,b)=>(b.hi-b.lo)-(a.hi-a.lo)).slice(0,14);
      function intersect(h,v){
        const hc=h.offset-h.slope*gray.cols/2,vc=v.offset-v.slope*gray.rows/2,denominator=1-h.slope*v.slope;
        if(Math.abs(denominator)<0.1)return null;
        const y=(h.slope*vc+hc)/denominator;return {x:v.slope*y+vc,y};
      }
      function coverage(line,a,b){const lo=Math.min(line.horizontal?a.x:a.y,line.horizontal?b.x:b.y),hi=Math.max(line.horizontal?a.x:a.y,line.horizontal?b.x:b.y),span=hi-lo;
        return {covered:Math.max(0,Math.min(hi,line.hi)-Math.max(lo,line.lo))/span,extra:(Math.max(0,line.lo-lo)+Math.max(0,hi-line.hi))/span};}
      let best=null;
      const horizontal=groups.horizontal,vertical=groups.vertical;
      for(let i=0;i<horizontal.length;i++)for(let j=i+1;j<horizontal.length;j++){
        const [top,bottom]=[horizontal[i],horizontal[j]].sort((a,b)=>a.offset-b.offset);if(bottom.offset-top.offset<gray.rows*.25)continue;
        for(let k=0;k<vertical.length;k++)for(let l=k+1;l<vertical.length;l++){
          const [left,right]=[vertical[k],vertical[l]].sort((a,b)=>a.offset-b.offset);if(right.offset-left.offset<gray.cols*.25)continue;
          const points=[intersect(top,left),intersect(top,right),intersect(bottom,right),intersect(bottom,left)];
          if(points.some(p=>!p||p.x<3||p.y<3||p.x>gray.cols-4||p.y>gray.rows-4)||!validQuad(points))continue;
          const area=points.reduce((sum,p,index)=>{const next=points[(index+1)%4];return sum+p.x*next.y-next.x*p.y;},0)/2;
          if(area<gray.cols*gray.rows*.20||area>gray.cols*gray.rows*.96)continue;
          const spans=[coverage(top,points[0],points[1]),coverage(right,points[1],points[2]),coverage(bottom,points[2],points[3]),coverage(left,points[3],points[0])];
          if(spans.some(span=>span.covered<.65||span.extra>.30))continue;
          const certainty=confidence(points,gray,true);if(!certainty.safeToCrop)continue;
          const rank=certainty.confidence+spans.reduce((sum,span)=>sum+span.covered*.07-span.extra*.18,0)+area/(gray.cols*gray.rows)*.05;
          if(!best||rank>best.rank)best={points,area,rank,...certainty};
        }
      }
      return best;
    }
    function detect(frame, options = {}) {
      return managed(keep => {
        const src = read(frame, keep), small = keep(new cv.Mat());
        const scale = Math.min(1, (options.thorough ? 900 : 500) / frame.height, (options.thorough ? 1200 : 900) / frame.width);
        cv.resize(src, small, new cv.Size(Math.max(2, Math.round(frame.width * scale)), Math.max(2, Math.round(frame.height * scale))), 0, 0, cv.INTER_AREA);
        const gray = keep(new cv.Mat()), blur = keep(new cv.Mat()), mask = keep(new cv.Mat());
        cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
        let best = null, uncertain = null;
        function consider(candidates, method, allowWeak = false) {
          for (const candidate of candidates) {
            const checked = {...candidate, method, ...confidence(candidate.points,gray,allowWeak)};
            if(checked.safeToCrop){best=checked;return true;}
            if(!uncertain||checked.confidence>uncertain.confidence)uncertain=checked;
          }
          return false;
        }
        if (!options.thresholdOnly) {
          cv.Canny(blur, mask, 45, 135);
          cv.dilate(mask, mask, keep(cv.Mat.ones(3, 3, cv.CV_8U)));
          consider(findQuads(mask, keep),'canny');
        }
        if (!best && Math.min(blur.rows, blur.cols) >= 3) {
          const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
          for (const threshold of [cv.THRESH_BINARY, cv.THRESH_BINARY_INV]) {
            cv.adaptiveThreshold(blur, mask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, threshold, blockSize(blur, 51), 7);
            cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
            if (consider(findQuads(mask, keep),'adaptive')) break;
          }
        }
        if(!best&&!options.fast&&!options.thresholdOnly){
          cv.GaussianBlur(gray,blur,new cv.Size(3,3),0);
          const close=keep(cv.Mat.ones(3,3,cv.CV_8U));
          for(const [low,high] of [[15,45],[6,18]]){
            cv.Canny(blur,mask,low,high);cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,close);
            if(consider(findQuads(mask,keep),'lowContrast',true))break;
          }
          if(!best&&typeof cv.CLAHE==='function'){
            const equalized=keep(new cv.Mat()),clahe=keep(new cv.CLAHE(3,new cv.Size(8,8)));
            clahe.apply(blur,equalized);cv.Canny(equalized,mask,12,36);cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,close);
            consider(findQuads(mask,keep),'localContrast',true);
          }
          if(!best){
            cv.Canny(blur,mask,4,12);cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,close);
            const recovered=recoverLines(mask,gray,keep);
            if(recovered){
              // Keep a small protective margin around recovered faint edges.
              const center=recovered.points.reduce((sum,p)=>({x:sum.x+p.x/4,y:sum.y+p.y/4}),{x:0,y:0});
              recovered.points=recovered.points.map(p=>({x:Math.max(0,Math.min(gray.cols-1,p.x+Math.sign(p.x-center.x)*1.5)),y:Math.max(0,Math.min(gray.rows-1,p.y+Math.sign(p.y-center.y)*1.5))}));
              best={...recovered,method:'edgeLines'};
            }
          }
        }
        if(!best)return {found:!!uncertain,safeToCrop:false,confidence:uncertain?.confidence||0,method:'full',points:insetQuad(frame.width,frame.height,0)};
        const {rank,area,...result}=best;
        return { found: true, ...result, points: result.points.map(p => ({
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
