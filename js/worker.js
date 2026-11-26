// Web Worker: Corner Detection, Perspective Warp, & Scan Filters (Zero Main-Thread Lag)

self.onmessage = function (e) {
  const { id, task, payload } = e.data;
  try {
    if (task === 'detect') {
      const corners = detectCornersFromPixels(
        new Uint8ClampedArray(payload.buffer),
        payload.width,
        payload.height
      );
      self.postMessage({ id, result: corners });
    } else if (task === 'warp') {
      const res = warpPixels(
        new Uint8ClampedArray(payload.buffer),
        payload.srcW,
        payload.srcH,
        payload.corners,
        payload.dstW,
        payload.dstH
      );
      self.postMessage({ id, result: res }, [res.buffer]);
    } else if (task === 'filter') {
      const res = applyFilterPixels(
        new Uint8ClampedArray(payload.buffer),
        payload.width,
        payload.height,
        payload.filterMode,
        payload.contrast
      );
      self.postMessage({ id, result: res }, [res.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};

function detectCornersFromPixels(data, w, h) {
  let rimBright = 0, rimCount = 0;
  const rimR = [], rimG = [], rimB = [];
  for (let x = 0; x < w; x++) {
    for (const y of [0, 1, h - 2, h - 1]) {
      const i = (y * w + x) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 165) rimBright++;
      rimCount++;
      rimR.push(data[i]); rimG.push(data[i + 1]); rimB.push(data[i + 2]);
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, 1, w - 2, w - 1]) {
      const i = (y * w + x) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 165) rimBright++;
      rimCount++;
      rimR.push(data[i]); rimG.push(data[i + 1]); rimB.push(data[i + 2]);
    }
  }

  const rimBrightRatio = rimBright / rimCount;
  const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const bgR = median(rimR), bgG = median(rimG), bgB = median(rimB);

  if (rimBrightRatio < 0.78) {
    const distMap = new Uint8Array(w * h);
    const hist = new Int32Array(256);
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const d = Math.min(255, ((Math.abs(data[p] - bgR) + Math.abs(data[p + 1] - bgG) + Math.abs(data[p + 2] - bgB)) >> 1));
      distMap[i] = d;
      hist[d]++;
    }
    const thresh1 = Math.max(20, otsuThreshold(hist, w * h));
    const mask1 = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask1[i] = distMap[i] >= thresh1 ? 1 : 0;

    const quad1 = extractQuadFromMask(morphClose(mask1, w, h, 2), w, h);
    if (quad1 && isValidDocQuad(quad1, w, h)) return quad1;
  }

  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  const blurred = boxBlur(boxBlur(gray, w, h), w, h);
  const edgeMag = new Float32Array(w * h);
  let sum = 0, sumSq = 0, count = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const gx = -blurred[(y - 1) * w + (x - 1)] + blurred[(y - 1) * w + (x + 1)]
                 - 2 * blurred[y * w + (x - 1)] + 2 * blurred[y * w + (x + 1)]
                 - blurred[(y + 1) * w + (x - 1)] + blurred[(y + 1) * w + (x + 1)];
      const gy = -blurred[(y - 1) * w + (x - 1)] - 2 * blurred[(y - 1) * w + x] - blurred[(y - 1) * w + (x + 1)]
                 + blurred[(y + 1) * w + (x - 1)] + 2 * blurred[(y + 1) * w + x] + blurred[(y + 1) * w + (x + 1)];
      const g = Math.hypot(gx, gy);
      edgeMag[y * w + x] = g;
      sum += g; sumSq += g * g; count++;
    }
  }
  const mean = sum / count;
  const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  const edgeMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) edgeMask[i] = edgeMag[i] > (mean + 1.15 * std) ? 1 : 0;

  const quad2 = extractQuadFromMask(morphDilate(edgeMask, w, h, 2), w, h);
  if (quad2 && isValidDocQuad(quad2, w, h) && !(rimBrightRatio >= 0.72 && quadArea(quad2) < w * h * 0.72)) {
    return quad2;
  }

  if (rimBrightRatio >= 0.72) {
    const px = w * 0.015, py = h * 0.015;
    return [{ x: px, y: py }, { x: w - px, y: py }, { x: w - px, y: h - py }, { x: px, y: h - py }];
  }
  return null;
}

function quadArea(q) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += q[i].x * q[j].y - q[j].x * q[i].y;
  }
  return Math.abs(area) / 2;
}

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 30;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}

function boxBlur(src, w, h) {
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) { s += src[yy * w + xx]; c++; }
        }
      }
      dst[y * w + x] = s / c;
    }
  }
  return dst;
}

function morphDilate(mask, w, h, rad) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -rad; dy <= rad && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && mask[yy * w + xx]) { hit = 1; break; }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

function morphErode(mask, w, h, rad) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let dy = -rad; dy <= rad && ok; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) { ok = 0; break; }
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || !mask[yy * w + xx]) { ok = 0; break; }
        }
      }
      out[y * w + x] = ok;
    }
  }
  return out;
}

function morphClose(mask, w, h, rad) {
  return morphErode(morphDilate(mask, w, h, rad), w, h, rad);
}

function extractQuadFromMask(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let bestComp = null;

  for (let i = 0; i < w * h; i++) {
    if (mask[i] && !visited[i]) {
      let head = 0, tail = 0;
      queue[tail++] = i; visited[i] = 1;
      while (head < tail) {
        const idx = queue[head++];
        const cx = idx % w, cy = (idx / w) | 0;
        const nbs = [cx > 0 ? idx - 1 : -1, cx < w - 1 ? idx + 1 : -1, cy > 0 ? idx - w : -1, cy < h - 1 ? idx + w : -1];
        for (const nb of nbs) {
          if (nb !== -1 && mask[nb] && !visited[nb]) { visited[nb] = 1; queue[tail++] = nb; }
        }
      }
      if (!bestComp || tail > bestComp.length) bestComp = queue.slice(0, tail);
    }
  }
  if (!bestComp || bestComp.length < w * h * 0.22) return null;

  const boundary = [];
  for (let k = 0; k < bestComp.length; k++) {
    const idx = bestComp[k];
    const cx = idx % w, cy = (idx / w) | 0;
    if (cx === 0 || cx === w - 1 || cy === 0 || cy === h - 1 ||
        !mask[idx - 1] || !mask[idx + 1] || !mask[idx - w] || !mask[idx + w]) {
      boundary.push({ x: cx, y: cy });
    }
  }
  if (boundary.length < 16) return null;

  const hull = convexHull(boundary);
  if (hull.length < 4) return null;

  const pts = hull.slice();
  while (pts.length > 4) {
    const n = pts.length;
    let minArea = Infinity, minIdx = 0;
    for (let i = 0; i < n; i++) {
      const area = Math.abs(cross2D(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]));
      if (area < minArea) { minArea = area; minIdx = i; }
    }
    pts.splice(minIdx, 1);
  }
  return pts.length === 4 ? orderQuad(pts) : null;
}

function cross2D(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function orderQuad(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let tlIdx = 0, minSum = Infinity;
  sorted.forEach((p, i) => {
    if (p.x + p.y < minSum) { minSum = p.x + p.y; tlIdx = i; }
  });
  return [sorted[tlIdx], sorted[(tlIdx + 1) % 4], sorted[(tlIdx + 2) % 4], sorted[(tlIdx + 3) % 4]];
}

function isValidDocQuad(q, w, h) {
  const area = quadArea(q);
  if (area < w * h * 0.22 || area > w * h * 0.96) return false;
  const d = [0, 1, 2, 3].map(i => Math.hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y));
  if (Math.min(...d) < 25) return false;
  if (Math.min(d[0], d[2]) / Math.max(d[0], d[2]) < 0.55) return false;
  if (Math.min(d[1], d[3]) / Math.max(d[1], d[3]) < 0.55) return false;

  for (let i = 0; i < 4; i++) {
    const pPrev = q[(i + 3) % 4], pCurr = q[i], pNext = q[(i + 1) % 4];
    const v1x = pPrev.x - pCurr.x, v1y = pPrev.y - pCurr.y;
    const v2x = pNext.x - pCurr.x, v2y = pNext.y - pCurr.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-6);
    if (Math.abs(cos) > 0.65) return false;
  }

  const ratio = ((d[0] + d[2]) / 2) / ((d[1] + d[3]) / 2);
  return (ratio >= 1.08 && ratio <= 2.35) || (ratio >= 0.42 && ratio <= 0.92);
}

function warpPixels(sPix, srcW, srcH, corners, dstW, dstH) {
  const [tl, tr, br, bl] = corners;
  const dPix = new Uint8ClampedArray(dstW * dstH * 4);

  const x0 = tl.x, y0 = tl.y, x1 = tr.x, y1 = tr.y, x2 = br.x, y2 = br.y, x3 = bl.x, y3 = bl.y;
  const dx1 = x1 - x2, dy1 = y1 - y2, dx2 = x3 - x2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;

  let a, b, c, d, e, f, g, h;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-6 || (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6)) {
    g = 0; h = 0; a = x1 - x0; b = x3 - x0; c = x0; d = y1 - y0; e = y3 - y0; f = y0;
  } else {
    g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }

  const maxU = srcW - 1.001, maxV = srcH - 1.001;
  for (let y = 0; y < dstH; y++) {
    const t = y / (dstH - 1);
    for (let x = 0; x < dstW; x++) {
      const s = x / (dstW - 1);
      const wDen = g * s + h * t + 1;
      let u = (a * s + b * t + c) / wDen;
      let v = (d * s + e * t + f) / wDen;
      u = u < 0 ? 0 : (u > maxU ? maxU : u);
      v = v < 0 ? 0 : (v > maxV ? maxV : v);

      const u0 = u | 0, v0 = v | 0;
      const u1 = u0 + 1 < srcW ? u0 + 1 : srcW - 1;
      const v1 = v0 + 1 < srcH ? v0 + 1 : srcH - 1;
      const du = u - u0, dv = v - v0;

      const i00 = (v0 * srcW + u0) * 4, i10 = (v0 * srcW + u1) * 4;
      const i01 = (v1 * srcW + u0) * 4, i11 = (v1 * srcW + u1) * 4;
      const w00 = (1 - du) * (1 - dv), w10 = du * (1 - dv);
      const w01 = (1 - du) * dv, w11 = du * dv;

      const di = (y * dstW + x) * 4;
      dPix[di]     = sPix[i00] * w00     + sPix[i10] * w10     + sPix[i01] * w01     + sPix[i11] * w11;
      dPix[di + 1] = sPix[i00 + 1] * w00 + sPix[i10 + 1] * w10 + sPix[i01 + 1] * w01 + sPix[i11 + 1] * w11;
      dPix[di + 2] = sPix[i00 + 2] * w00 + sPix[i10 + 2] * w10 + sPix[i01 + 2] * w01 + sPix[i11 + 2] * w11;
      dPix[di + 3] = 255;
    }
  }
  return { buffer: dPix.buffer, width: dstW, height: dstH };
}

function applyFilterPixels(pix, w, h, filterMode, contrast) {
  if (filterMode === 'magic' || filterMode === 'bw') {
    // Estimate local illumination on downsampled grid directly in buffer
    const gw = w >= h ? 36 : 26;
    const gh = w >= h ? 26 : 36;
    const grid = new Float32Array(gw * gh * 3);
    const sxStep = w / gw, syStep = h / gh;

    for (let gy = 0; gy < gh; gy++) {
      const sy = Math.min(h - 1, Math.floor((gy + 0.5) * syStep));
      for (let gx = 0; gx < gw; gx++) {
        const sx = Math.min(w - 1, Math.floor((gx + 0.5) * sxStep));
        const si = (sy * w + sx) * 4;
        const gi = (gy * gw + gx) * 3;
        grid[gi] = pix[si]; grid[gi + 1] = pix[si + 1]; grid[gi + 2] = pix[si + 2];
      }
    }

    const maxBuf = new Float32Array(gw * gh * 3);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let mr = 0, mg = 0, mb = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy < 0 ? 0 : (y + dy >= gh ? gh - 1 : y + dy);
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx < 0 ? 0 : (x + dx >= gw ? gw - 1 : x + dx);
            const idx = (yy * gw + xx) * 3;
            if (grid[idx] > mr) mr = grid[idx];
            if (grid[idx + 1] > mg) mg = grid[idx + 1];
            if (grid[idx + 2] > mb) mb = grid[idx + 2];
          }
        }
        const di = (y * gw + x) * 3;
        maxBuf[di] = mr > 90 ? mr : 90;
        maxBuf[di + 1] = mg > 90 ? mg : 90;
        maxBuf[di + 2] = mb > 90 ? mb : 90;
      }
    }

    const smoothGrid = new Float32Array(gw * gh * 3);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let sr = 0, sg = 0, sb = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy < 0 ? 0 : (y + dy >= gh ? gh - 1 : y + dy);
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx < 0 ? 0 : (x + dx >= gw ? gw - 1 : x + dx);
            const idx = (yy * gw + xx) * 3;
            sr += maxBuf[idx]; sg += maxBuf[idx + 1]; sb += maxBuf[idx + 2]; c++;
          }
        }
        const oi = (y * gw + x) * 3;
        smoothGrid[oi] = sr / c; smoothGrid[oi + 1] = sg / c; smoothGrid[oi + 2] = sb / c;
      }
    }

    // Bilinear sample illumination per pixel
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * (gh - 1);
      const y0 = fy | 0, y1 = y0 + 1 < gh ? y0 + 1 : gh - 1, dy = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * (gw - 1);
        const x0 = fx | 0, x1 = x0 + 1 < gw ? x0 + 1 : gw - 1, dx = fx - x0;

        const g00 = (y0 * gw + x0) * 3, g10 = (y0 * gw + x1) * 3;
        const g01 = (y1 * gw + x0) * 3, g11 = (y1 * gw + x1) * 3;
        const w00 = (1 - dx) * (1 - dy), w10 = dx * (1 - dy);
        const w01 = (1 - dx) * dy, w11 = dx * dy;

        const ir = smoothGrid[g00] * w00 + smoothGrid[g10] * w10 + smoothGrid[g01] * w01 + smoothGrid[g11] * w11;
        const ig = smoothGrid[g00 + 1] * w00 + smoothGrid[g10 + 1] * w10 + smoothGrid[g01 + 1] * w01 + smoothGrid[g11 + 1] * w11;
        const ib = smoothGrid[g00 + 2] * w00 + smoothGrid[g10 + 2] * w10 + smoothGrid[g01 + 2] * w01 + smoothGrid[g11 + 2] * w11;

        const i = (y * w + x) * 4;
        let r = 128 + ((pix[i] / ir) * 255 - 128) * contrast;
        let g = 128 + ((pix[i + 1] / ig) * 255 - 128) * contrast;
        let b = 128 + ((pix[i + 2] / ib) * 255 - 128) * contrast;

        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const chroma = mx - mn;

        if (lum > 186 && chroma < 48) {
          if (lum >= 204) { r = g = b = 255; }
          else {
            const t = (lum - 186) / 18;
            r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t;
          }
        } else if (lum < 115) {
          r *= 0.86; g *= 0.86; b *= 0.86;
        } else if (filterMode === 'magic' && chroma > 22) {
          const avg = (r + g + b) / 3;
          r = avg + (r - avg) * 1.14; g = avg + (g - avg) * 1.14; b = avg + (b - avg) * 1.14;
        }

        if (filterMode === 'bw') {
          let gray = 0.299 * r + 0.587 * g + 0.114 * b;
          gray = 128 + (gray - 128) * 1.3;
          if (gray > 205) gray = 255;
          r = g = b = gray;
        }

        pix[i] = r < 0 ? 0 : (r > 255 ? 255 : r);
        pix[i + 1] = g < 0 ? 0 : (g > 255 ? 255 : g);
        pix[i + 2] = b < 0 ? 0 : (b > 255 ? 255 : b);
      }
    }
  } else if (filterMode === 'bright') {
    for (let i = 0; i < pix.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = 128 + (pix[i + c] * 1.1 + 10 - 128) * contrast;
        pix[i + c] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }
  }
  return { buffer: pix.buffer, width: w, height: h };
}
