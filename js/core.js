const MAX_PAGES = 50;

const state = {
  activeTab: 'homeTab',
  front: { rawImg: null, warpedCanvas: null, cleanCanvas: null, corners: null },
  back:  { rawImg: null, warpedCanvas: null, cleanCanvas: null, corners: null },
  nextTarget: 'front',
  filter: 'magic',
  size: 'medium',
  docs: [],
  multiFilter: 'magic',
  cropTarget: null,
  cropImg: null,
  corners: [],
  dragHandle: -1,
  isPanningCrop: false,
  lastPointer: null,
  cropView: { scale: 1, x: 0, y: 0, minScale: 0.2 }
};

// ---------------- LAZY SCRIPT & TAB MODULE LOADER ----------------
const _scriptCache = {};
function loadScriptOnce(url, isModule = false) {
  if (_scriptCache[url]) return _scriptCache[url];
  _scriptCache[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    if (isModule) s.type = 'module';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      delete _scriptCache[url];
      reject(new Error('Failed to load: ' + url));
    };
    document.head.appendChild(s);
  });
  return _scriptCache[url];
}

async function ensureJsPDF() {
  if (!window.jspdf?.jsPDF) {
    setProgress(true, 'Loading PDF engine...', 35);
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  }
  return window.jspdf?.jsPDF;
}

async function ensureJSZip() {
  if (!window.JSZip) {
    setProgress(true, 'Loading ZIP engine...', 35);
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  }
  return window.JSZip;
}

async function ensurePdfJs() {
  if (!window.pdfjsLib) {
    setProgress(true, 'Loading PDF reader...', 30);
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }
  return window.pdfjsLib;
}

const TAB_MODULES = {
  cardPrintTab: { url: 'js/cardprint.js', module: false, title: 'Card Print (e-Aadhaar PDF)' },
  aadhaarTab:   { url: null, module: false, title: 'Aadhaar (A4) Scanner' },
  passportTab:  { url: 'js/passport.js', module: true, title: 'Passport Photo Studio' },
  multiTab:     { url: 'js/multipage.js', module: false, title: 'Multi-Page A4 Builder' },
  resizeTab:    { url: 'js/resize.js', module: false, title: 'PDF / JPG Resize' },
  ageTab:       { url: 'js/age.js', module: false, title: 'Age Calculator' }
};

async function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });

  const breadcrumb = document.getElementById('toolBreadcrumb');
  const titleEl = document.getElementById('activeToolTitle');
  if (tabId === 'homeTab') {
    breadcrumb.style.display = 'none';
  } else {
    breadcrumb.style.display = 'flex';
    titleEl.innerText = TAB_MODULES[tabId]?.title || 'Tool';
  }

  const mod = TAB_MODULES[tabId];
  if (mod && mod.url) {
    try {
      await loadScriptOnce(mod.url, mod.module);
      if (tabId === 'multiTab' && window.renderMultiGrid) window.renderMultiGrid();
    } catch (err) {
      console.error(err);
      showToast('Module load error! Check js/ folder on GitHub.');
    }
  }
}

// ---------------- WEB WORKER BRIDGE ----------------
let _worker = null;
let _workerMsgId = 1;
const _workerPending = new Map();

function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker('js/worker.js');
  _worker.onmessage = (e) => {
    const { id, result, error } = e.data;
    const p = _workerPending.get(id);
    if (!p) return;
    _workerPending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  };
  return _worker;
}

function runWorker(task, payload, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = _workerMsgId++;
    _workerPending.set(id, { resolve, reject });
    getWorker().postMessage({ id, task, payload }, transfer);
  });
}

async function detectCardCornersAsync(img) {
  const maxSide = 200;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(40, Math.round(img.width * scale));
  const h = Math.max(40, Math.round(img.height * scale));

  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  off.getContext('2d').drawImage(img, 0, 0, w, h);
  const data = off.getContext('2d').getImageData(0, 0, w, h).data;
  off.width = 0; off.height = 0;

  const corners = await runWorker('detect', { buffer: data.buffer, width: w, height: h }, [data.buffer]);
  return corners ? { corners: corners.map(pt => ({ x: pt.x / scale, y: pt.y / scale })) } : null;
}

async function warpPerspectiveAsync(img, corners, targetW = null, targetH = null) {
  const [tl, tr, br, bl] = corners;
  const avgW = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2;
  const avgH = (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2;
  const ratio = avgW / Math.max(1, avgH);

  let dstW = targetW, dstH = targetH;
  if (!dstW || !dstH) {
    if (ratio >= 1) { dstW = 1100; dstH = Math.max(120, Math.round(1100 / ratio)); }
    else { dstH = 1100; dstW = Math.max(120, Math.round(1100 * ratio)); }
  }

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = img.width; srcCanvas.height = img.height;
  srcCanvas.getContext('2d').drawImage(img, 0, 0);
  const srcData = srcCanvas.getContext('2d').getImageData(0, 0, img.width, img.height).data;
  srcCanvas.width = 0; srcCanvas.height = 0;

  const res = await runWorker(
    'warp',
    { buffer: srcData.buffer, srcW: img.width, srcH: img.height, corners, dstW, dstH },
    [srcData.buffer]
  );

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = res.width; dstCanvas.height = res.height;
  const dctx = dstCanvas.getContext('2d');
  dctx.putImageData(new ImageData(new Uint8ClampedArray(res.buffer), res.width, res.height), 0, 0);
  return dstCanvas;
}

async function applyScanFilterAsync(warpedCanvas, filterMode, contrast) {
  const w = warpedCanvas.width, h = warpedCanvas.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');

  if (filterMode === 'original') {
    octx.drawImage(warpedCanvas, 0, 0);
    return out;
  }

  const data = warpedCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const res = await runWorker(
    'filter',
    { buffer: data.buffer, width: w, height: h, filterMode, contrast },
    [data.buffer]
  );
  octx.putImageData(new ImageData(new Uint8ClampedArray(res.buffer), res.width, res.height), 0, 0);
  return out;
}

// ---------------- UI & FILE HELPERS ----------------
function showToast(msg) {
  const t = document.getElementById('toastMsg');
  t.innerText = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 2400);
}

function setProgress(open, text = '', pct = 0) {
  const m = document.getElementById('progressModal');
  m.classList.toggle('open', open);
  if (open) {
    document.getElementById('progressText').innerText = text;
    document.getElementById('progressBar').style.width = pct + '%';
  }
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

const nextFrame = () => new Promise(r => setTimeout(r, 10));

function canvasToBlob(canvas, mime = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

function loadImageFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function blobToImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await loadImageFromSrc(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createThumbUrlFromCanvas(srcCanvas, maxW = 220) {
  return new Promise((resolve) => {
    const scale = Math.min(1, maxW / srcCanvas.width);
    const tc = document.createElement('canvas');
    tc.width = Math.round(srcCanvas.width * scale);
    tc.height = Math.round(srcCanvas.height * scale);
    tc.getContext('2d').drawImage(srcCanvas, 0, 0, tc.width, tc.height);
    tc.toBlob((blob) => {
      tc.width = 0; tc.height = 0;
      resolve(URL.createObjectURL(blob));
    }, 'image/jpeg', 0.76);
  });
}

function fileToResizedImage(file, maxDim = 1400) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.width > maxDim || img.height > maxDim) {
        const scale = maxDim / Math.max(img.width, img.height);
        const off = document.createElement('canvas');
        off.width = Math.round(img.width * scale);
        off.height = Math.round(img.height * scale);
        off.getContext('2d').drawImage(img, 0, 0, off.width, off.height);
        off.toBlob(async (b) => {
          off.width = 0; off.height = 0;
          resolve(await blobToImage(b));
        }, 'image/jpeg', 0.93);
      } else {
        resolve(img);
      }
    };
    img.src = url;
  });
}

async function addSheetCanvasToMultiPage(sheetCanvas, tagLabel = 'Aadhaar') {
  if (state.docs.length >= MAX_PAGES) {
    alert(`Max ${MAX_PAGES} pages reached.`);
    return;
  }
  const fullBlob = await canvasToBlob(sheetCanvas, 'image/jpeg', 0.94);
  const thumbUrl = await createThumbUrlFromCanvas(sheetCanvas, 220);

  state.docs.push({
    id: Date.now() + Math.random(),
    rawBlob: fullBlob,
    warpedBlob: fullBlob,
    cleanBlob: fullBlob,
    thumbUrl,
    corners: null,
    isAadhaarSheet: true,
    sheetTag: tagLabel
  });

  document.getElementById('pageCountBadge').innerText = `${state.docs.length}/50`;
  if (window.renderMultiGrid) window.renderMultiGrid();
  showToast(`${tagLabel} added to Multi-Page!`);
}

function triggerPrint(dataUrlArray) {
  const sheet = document.getElementById('printSheet');
  sheet.innerHTML = '';
  const promises = dataUrlArray.map(src => new Promise(res => {
    const div = document.createElement('div');
    div.className = 'print-page';
    const img = document.createElement('img');
    img.onload = res;
    img.onerror = res;
    img.src = src;
    div.appendChild(img);
    sheet.appendChild(div);
  }));
  Promise.all(promises).then(() => window.print());
}

// ---------------- GLOBAL PASTE & KEYBOARD ----------------
window.addEventListener('paste', (e) => {
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  const files = [];
  for (const item of items) {
    if (item.type.indexOf('image') !== -1 || item.type === 'application/pdf') {
      files.push(item.getAsFile());
    }
  }
  if (!files.length) return;
  if (state.activeTab === 'aadhaarTab' && window.handleAadhaarFiles) window.handleAadhaarFiles(files);
  else if (state.activeTab === 'cardPrintTab' && window.handleCardPrintUpload) window.handleCardPrintUpload(files[0]);
  else if (state.activeTab === 'passportTab' && window.handlePassportPaste) window.handlePassportPaste(files[0]);
  else if (state.activeTab === 'multiTab' && window.handleMultiFiles) window.handleMultiFiles(files);
  else if (state.activeTab === 'resizeTab' && window.handleResizeUpload) window.handleResizeUpload(files[0]);
});

window.addEventListener('keydown', (e) => {
  if (document.getElementById('cropModal').classList.contains('open')) {
    if (e.key === 'Enter') { e.preventDefault(); applyCrop(); }
    if (e.key === 'Escape') closeCropModal();
  }
});

// ---------------- SHARED ZOOMABLE CROP MODAL + 2.5x LOUPE ----------------
const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');

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

function getDefaultCorners(img, padRatio = 0.03) {
  const px = img.width * padRatio, py = img.height * padRatio;
  return [
    { x: px, y: py },
    { x: img.width - px, y: py },
    { x: img.width - px, y: img.height - py },
    { x: px, y: img.height - py }
  ];
}

function sizeCropViewportCanvas() {
  const stage = document.getElementById('cropStage');
  const w = Math.max(300, stage.clientWidth - 16);
  const h = Math.max(260, stage.clientHeight - 16);
  cropCanvas.width = w;
  cropCanvas.height = h;
  cropCanvas.style.width = w + 'px';
  cropCanvas.style.height = h + 'px';
}

function updateCropZoomPill() {
  const el = document.getElementById('cropZoomLabel');
  if (!el || !state.cropView.minScale) return;
  const pct = Math.round((state.cropView.scale / state.cropView.minScale) * 100);
  el.innerText = pct + '%';
}

function zoomToFullImage() {
  if (!state.cropImg) return;
  const cw = cropCanvas.width, ch = cropCanvas.height;
  const s = Math.min((cw - 24) / state.cropImg.width, (ch - 24) / state.cropImg.height);
  state.cropView.minScale = s * 0.7;
  state.cropView.scale = s;
  state.cropView.x = (cw - state.cropImg.width * s) / 2;
  state.cropView.y = (ch - state.cropImg.height * s) / 2;
  updateCropZoomPill();
  drawCropCanvas();
}

function zoomToCropBox() {
  if (!state.cropImg || !state.corners.length) return;
  const cw = cropCanvas.width, ch = cropCanvas.height;
  const fitAll = Math.min((cw - 24) / state.cropImg.width, (ch - 24) / state.cropImg.height);
  state.cropView.minScale = fitAll * 0.7;

  const xs = state.corners.map(p => p.x);
  const ys = state.corners.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const boxW = Math.max(40, maxX - minX);
  const boxH = Math.max(40, maxY - minY);
  const padW = boxW * 1.18;
  const padH = boxH * 1.35;

  const s = Math.min(4.5, Math.max(fitAll, Math.min(cw / padW, ch / padH)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  state.cropView.scale = s;
  state.cropView.x = cw / 2 - cx * s;
  state.cropView.y = ch / 2 - cy * s;
  updateCropZoomPill();
  drawCropCanvas();
}

function cropZoomBy(factor, pivotX = null, pivotY = null) {
  if (!state.cropImg) return;
  const cx = pivotX !== null ? pivotX : cropCanvas.width / 2;
  const cy = pivotY !== null ? pivotY : cropCanvas.height / 2;
  const oldS = state.cropView.scale;
  const newS = Math.max(state.cropView.minScale, Math.min(6.0, oldS * factor));
  const ratio = newS / oldS;

  state.cropView.x = cx - (cx - state.cropView.x) * ratio;
  state.cropView.y = cy - (cy - state.cropView.y) * ratio;
  state.cropView.scale = newS;
  updateCropZoomPill();
  drawCropCanvas();
}

async function openCropModal(target, img, runAuto, presetCorners = null) {
  state.cropTarget = target;
  state.cropImg = img;

  let title = 'Adjust Crop';
  if (target.mode === 'aadhaar') title = `Crop ${target.side.toUpperCase()}`;
  else if (target.mode === 'cardprint') title = 'Crop Bottom Joint Aadhaar Card';
  else title = `Crop Page ${target.index + 1}`;
  document.getElementById('cropModalTitle').innerText = title;

  const savedCorners = presetCorners || (
    target.mode === 'aadhaar'
      ? state[target.side].corners
      : (target.mode === 'multi' ? state.docs[target.index].corners : null)
  );

  if (!runAuto && savedCorners) {
    state.corners = savedCorners.map(p => ({ ...p }));
  } else {
    const det = await detectCardCornersAsync(img);
    state.corners = det ? det.corners : getDefaultCorners(img, 0.03);
  }

  document.getElementById('cropModal').classList.add('open');
  requestAnimationFrame(() => {
    sizeCropViewportCanvas();
    // Auto-zoom onto the crop box if cropping Card Print OR if crop area is smaller than full image
    const xs = state.corners.map(p => p.x), ys = state.corners.map(p => p.y);
    const boxArea = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    const imgArea = img.width * img.height;
    if (target.mode === 'cardprint' || boxArea < imgArea * 0.78) {
      zoomToCropBox();
    } else {
      zoomToFullImage();
    }
  });
}

async function runAutoDetect() {
  const det = await detectCardCornersAsync(state.cropImg);
  state.corners = det ? det.corners : getDefaultCorners(state.cropImg, 0.03);
  zoomToCropBox();
}

function resetFullCorners() {
  state.corners = getDefaultCorners(state.cropImg, 0.01);
  zoomToFullImage();
}

function closeCropModal() {
  document.getElementById('cropModal').classList.remove('open');
}

function rotateCropImage(deg) {
  const img = state.cropImg;
  const off = document.createElement('canvas');
  off.width = img.height; off.height = img.width;
  const octx = off.getContext('2d');
  octx.translate(off.width / 2, off.height / 2);
  octx.rotate((deg * Math.PI) / 180);
  octx.drawImage(img, -img.width / 2, -img.height / 2);

  off.toBlob(async (blob) => {
    off.width = 0; off.height = 0;
    const rot = await blobToImage(blob);
    state.cropImg = rot;
    if (state.cropTarget.mode === 'aadhaar') state[state.cropTarget.side].rawImg = rot;
    else if (state.cropTarget.mode === 'multi') state.docs[state.cropTarget.index].rawBlob = blob;
    const det = await detectCardCornersAsync(rot);
    state.corners = det ? det.corners : getDefaultCorners(rot, 0.03);
    zoomToFullImage();
  }, 'image/jpeg', 0.93);
}

function getEdgeMidpoints() {
  const c = state.corners;
  return [
    { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 },
    { x: (c[1].x + c[2].x) / 2, y: (c[1].y + c[2].y) / 2 },
    { x: (c[2].x + c[3].x) / 2, y: (c[2].y + c[3].y) / 2 },
    { x: (c[3].x + c[0].x) / 2, y: (c[3].y + c[0].y) / 2 }
  ];
}

function imgToView(pt) {
  return {
    x: pt.x * state.cropView.scale + state.cropView.x,
    y: pt.y * state.cropView.scale + state.cropView.y
  };
}

function viewToImg(vx, vy) {
  return {
    x: Math.max(0, Math.min(state.cropImg.width, (vx - state.cropView.x) / state.cropView.scale)),
    y: Math.max(0, Math.min(state.cropImg.height, (vy - state.cropView.y) / state.cropView.scale))
  };
}

function drawCropCanvas() {
  const img = state.cropImg;
  if (!img) return;
  const cw = cropCanvas.width, ch = cropCanvas.height;
  const v = state.cropView;

  cropCtx.clearRect(0, 0, cw, ch);
  cropCtx.drawImage(img, v.x, v.y, img.width * v.scale, img.height * v.scale);

  const vCorners = state.corners.map(imgToView);

  cropCtx.save();
  cropCtx.fillStyle = 'rgba(6, 11, 25, 0.56)';
  cropCtx.beginPath();
  cropCtx.rect(0, 0, cw, ch);
  cropCtx.moveTo(vCorners[0].x, vCorners[0].y);
  cropCtx.lineTo(vCorners[3].x, vCorners[3].y);
  cropCtx.lineTo(vCorners[2].x, vCorners[2].y);
  cropCtx.lineTo(vCorners[1].x, vCorners[1].y);
  cropCtx.closePath();
  cropCtx.fill('evenodd');
  cropCtx.restore();

  cropCtx.strokeStyle = '#38bdf8';
  cropCtx.lineWidth = 2.5;
  cropCtx.beginPath();
  cropCtx.moveTo(vCorners[0].x, vCorners[0].y);
  for (let i = 1; i < 4; i++) cropCtx.lineTo(vCorners[i].x, vCorners[i].y);
  cropCtx.closePath();
  cropCtx.stroke();

  // Edge midpoint handles
  getEdgeMidpoints().map(imgToView).forEach((pt, idx) => {
    cropCtx.beginPath();
    cropCtx.arc(pt.x, pt.y, 8.5, 0, Math.PI * 2);
    cropCtx.fillStyle = state.dragHandle === (idx + 4) ? '#facc15' : '#10b981';
    cropCtx.fill();
    cropCtx.lineWidth = 2;
    cropCtx.strokeStyle = '#ffffff';
    cropCtx.stroke();
  });

  // Corner handles
  vCorners.forEach((pt, idx) => {
    cropCtx.beginPath();
    cropCtx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
    cropCtx.fillStyle = state.dragHandle === idx ? '#facc15' : '#8b5cf6';
    cropCtx.fill();
    cropCtx.lineWidth = 2.2;
    cropCtx.strokeStyle = '#ffffff';
    cropCtx.stroke();
  });

  // 2.5x Magnifier Loupe when dragging a corner handle (0..3)
  if (state.dragHandle >= 0 && state.dragHandle < 4) {
    const imgPt = state.corners[state.dragHandle];
    const vPt = vCorners[state.dragHandle];
    const r = 52;
    const lx = vPt.x < cw / 2 ? cw - r - 18 : r + 18;
    const ly = r + 18;
    const mag = Math.max(2.2, v.scale * 2.2);

    cropCtx.save();
    cropCtx.beginPath();
    cropCtx.arc(lx, ly, r, 0, Math.PI * 2);
    cropCtx.clip();
    cropCtx.fillStyle = '#060b19';
    cropCtx.fillRect(lx - r, ly - r, r * 2, r * 2);
    cropCtx.drawImage(
      img,
      lx - imgPt.x * mag,
      ly - imgPt.y * mag,
      img.width * mag,
      img.height * mag
    );
    // Crosshair inside loupe
    cropCtx.strokeStyle = '#38bdf8';
    cropCtx.lineWidth = 1.5;
    cropCtx.beginPath();
    cropCtx.moveTo(lx - 14, ly); cropCtx.lineTo(lx + 14, ly);
    cropCtx.moveTo(lx, ly - 14); cropCtx.lineTo(lx, ly + 14);
    cropCtx.stroke();
    cropCtx.restore();

    cropCtx.beginPath();
    cropCtx.arc(lx, ly, r, 0, Math.PI * 2);
    cropCtx.lineWidth = 3;
    cropCtx.strokeStyle = '#38bdf8';
    cropCtx.stroke();
  }
}

cropCanvas.addEventListener('wheel', (e) => {
  if (!state.cropImg) return;
  e.preventDefault();
  const rect = cropCanvas.getBoundingClientRect();
  cropZoomBy(e.deltaY < 0 ? 1.12 : 0.89, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

cropCanvas.addEventListener('pointerdown', (e) => {
  const rect = cropCanvas.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;

  const vHandles = state.corners.map(imgToView).concat(getEdgeMidpoints().map(imgToView));
  let best = -1, bestDist = Infinity;
  vHandles.forEach((pt, i) => {
    const d = Math.hypot(pt.x - vx, pt.y - vy);
    if (d < 26 && d < bestDist) { best = i; bestDist = d; }
  });

  if (best !== -1) {
    state.dragHandle = best;
    state.isPanningCrop = false;
    state.lastPointer = viewToImg(vx, vy);
  } else {
    state.dragHandle = -1;
    state.isPanningCrop = true;
    state.lastPointer = { vx, vy };
  }
  cropCanvas.setPointerCapture(e.pointerId);
  drawCropCanvas();
});

cropCanvas.addEventListener('pointermove', (e) => {
  const rect = cropCanvas.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;

  if (state.isPanningCrop) {
    state.cropView.x += vx - state.lastPointer.vx;
    state.cropView.y += vy - state.lastPointer.vy;
    state.lastPointer = { vx, vy };
    drawCropCanvas();
    return;
  }

  if (state.dragHandle === -1) return;
  const imgPt = viewToImg(vx, vy);

  if (state.dragHandle < 4) {
    state.corners[state.dragHandle] = imgPt;
  } else {
    const dx = imgPt.x - state.lastPointer.x;
    const dy = imgPt.y - state.lastPointer.y;
    const edgeIdx = state.dragHandle - 4;
    const cA = state.corners[edgeIdx], cB = state.corners[(edgeIdx + 1) % 4];
    cA.x = Math.max(0, Math.min(state.cropImg.width, cA.x + dx));
    cA.y = Math.max(0, Math.min(state.cropImg.height, cA.y + dy));
    cB.x = Math.max(0, Math.min(state.cropImg.width, cB.x + dx));
    cB.y = Math.max(0, Math.min(state.cropImg.height, cB.y + dy));
  }
  state.lastPointer = imgPt;
  drawCropCanvas();
});

cropCanvas.addEventListener('pointerup', () => {
  state.dragHandle = -1;
  state.isPanningCrop = false;
  drawCropCanvas();
});

async function applyCrop() {
  let targetW = null, targetH = null;
  if (state.cropTarget.mode === 'cardprint') {
    const isSingle = state.cropTarget.cardMode === 'single';
    targetW = isSingle ? 1011 : 2022;
    targetH = 638;
  }

  const warped = await warpPerspectiveAsync(state.cropImg, state.corners, targetW, targetH);
  const savedCorners = state.corners.map(p => ({ ...p }));

  if (state.cropTarget.mode === 'aadhaar') {
    const side = state.cropTarget.side;
    state[side].corners = savedCorners;
    state[side].warpedCanvas = warped;
    if (window.processAadhaarSide) await window.processAadhaarSide(side);
    if (window.renderA4) window.renderA4();
  } else if (state.cropTarget.mode === 'cardprint' && window.onCardPrintCropDone) {
    await window.onCardPrintCropDone(warped, savedCorners);
  } else if (window.onMultiCropDone) {
    await window.onMultiCropDone(state.cropTarget.index, warped, savedCorners);
  }
  closeCropModal();
}
