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
  lastPointer: null
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

async function switchTab(tabId, btn) {
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

// ---------------- SHARED CROP MODAL ----------------
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

async function openCropModal(target, img, runAuto, presetCorners = null) {
  state.cropTarget = target;
  state.cropImg = img;

  let title = 'Adjust Crop';
  if (target.mode === 'aadhaar') title = `Crop ${target.side.toUpperCase()}`;
  else if (target.mode === 'cardprint') title = 'Crop Bottom Joint Aadhaar Card';
  else title = `Crop Page ${target.index + 1}`;
  document.getElementById('cropModalTitle').innerText = title;

  cropCanvas.width = img.width;
  cropCanvas.height = img.height;

  const savedCorners = presetCorners || (
    target.mode === 'aadhaar'
      ? state[target.side].corners
      : (target.mode === 'multi' ? state.docs[target.index].corners : null)
  );

  if (!runAuto && savedCorners) {
    state.corners = savedCorners.map(p => ({ ...p }));
    drawCropCanvas();
  } else {
    await runAutoDetect();
  }
  document.getElementById('cropModal').classList.add('open');
}

async function runAutoDetect() {
  const det = await detectCardCornersAsync(state.cropImg);
  state.corners = det ? det.corners : getDefaultCorners(state.cropImg, 0.03);
  drawCropCanvas();
}

function resetFullCorners() {
  state.corners = getDefaultCorners(state.cropImg, 0.01);
  drawCropCanvas();
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
    cropCanvas.width = rot.width;
    cropCanvas.height = rot.height;
    await runAutoDetect();
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

function drawCropCanvas() {
  const img = state.cropImg;
  const w = cropCanvas.width, h = cropCanvas.height;
  cropCtx.clearRect(0, 0, w, h);
  cropCtx.drawImage(img, 0, 0);

  cropCtx.save();
  cropCtx.fillStyle = 'rgba(0, 0, 0, 0.48)';
  cropCtx.beginPath();
  cropCtx.rect(0, 0, w, h);
  cropCtx.moveTo(state.corners[0].x, state.corners[0].y);
  cropCtx.lineTo(state.corners[3].x, state.corners[3].y);
  cropCtx.lineTo(state.corners[2].x, state.corners[2].y);
  cropCtx.lineTo(state.corners[1].x, state.corners[1].y);
  cropCtx.closePath();
  cropCtx.fill('evenodd');
  cropCtx.restore();

  const rect = cropCanvas.getBoundingClientRect();
  const scaleFactor = rect.width ? (w / rect.width) : 1;
  const lineW = Math.max(2, 3 * scaleFactor);
  const radius = Math.max(10, 13 * scaleFactor);

  cropCtx.strokeStyle = '#38bdf8';
  cropCtx.lineWidth = lineW;
  cropCtx.beginPath();
  cropCtx.moveTo(state.corners[0].x, state.corners[0].y);
  for (let i = 1; i < 4; i++) cropCtx.lineTo(state.corners[i].x, state.corners[i].y);
  cropCtx.closePath();
  cropCtx.stroke();

  getEdgeMidpoints().forEach((pt, idx) => {
    cropCtx.beginPath();
    cropCtx.arc(pt.x, pt.y, radius * 0.78, 0, Math.PI * 2);
    cropCtx.fillStyle = state.dragHandle === (idx + 4) ? '#facc15' : '#10b981';
    cropCtx.fill();
    cropCtx.lineWidth = lineW * 0.8;
    cropCtx.strokeStyle = '#ffffff';
    cropCtx.stroke();
  });

  state.corners.forEach((pt, idx) => {
    cropCtx.beginPath();
    cropCtx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    cropCtx.fillStyle = state.dragHandle === idx ? '#facc15' : '#8b5cf6';
    cropCtx.fill();
    cropCtx.lineWidth = lineW;
    cropCtx.strokeStyle = '#ffffff';
    cropCtx.stroke();
  });
}

function getPointerPos(e) {
  const rect = cropCanvas.getBoundingClientRect();
  const scaleX = cropCanvas.width / rect.width;
  const scaleY = cropCanvas.height / rect.height;
  return {
    x: Math.max(0, Math.min(cropCanvas.width, (e.clientX - rect.left) * scaleX)),
    y: Math.max(0, Math.min(cropCanvas.height, (e.clientY - rect.top) * scaleY)),
    scale: scaleX
  };
}

cropCanvas.addEventListener('pointerdown', (e) => {
  const pos = getPointerPos(e);
  const hitRadius = 30 * pos.scale;
  const allHandles = state.corners.concat(getEdgeMidpoints());
  let best = -1, bestDist = Infinity;
  allHandles.forEach((pt, i) => {
    const d = Math.hypot(pt.x - pos.x, pt.y - pos.y);
    if (d < hitRadius && d < bestDist) { best = i; bestDist = d; }
  });
  if (best !== -1) {
    state.dragHandle = best;
    state.lastPointer = { x: pos.x, y: pos.y };
    cropCanvas.setPointerCapture(e.pointerId);
    drawCropCanvas();
  }
});

cropCanvas.addEventListener('pointermove', (e) => {
  if (state.dragHandle === -1) return;
  const pos = getPointerPos(e);
  if (state.dragHandle < 4) {
    state.corners[state.dragHandle] = { x: pos.x, y: pos.y };
  } else {
    const dx = pos.x - state.lastPointer.x;
    const dy = pos.y - state.lastPointer.y;
    const edgeIdx = state.dragHandle - 4;
    const cA = state.corners[edgeIdx], cB = state.corners[(edgeIdx + 1) % 4];
    cA.x = Math.max(0, Math.min(cropCanvas.width, cA.x + dx));
    cA.y = Math.max(0, Math.min(cropCanvas.height, cA.y + dy));
    cB.x = Math.max(0, Math.min(cropCanvas.width, cB.x + dx));
    cB.y = Math.max(0, Math.min(cropCanvas.height, cB.y + dy));
  }
  state.lastPointer = { x: pos.x, y: pos.y };
  drawCropCanvas();
});

cropCanvas.addEventListener('pointerup', () => { state.dragHandle = -1; drawCropCanvas(); });

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
