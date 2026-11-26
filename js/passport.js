const upload = document.getElementById('ppUpload');
const cropStage = document.getElementById('ppCropStage');
const cropCanvas = document.getElementById('ppCropCanvas');
const cropCtx = cropCanvas.getContext('2d');
const a4PreviewCanvas = document.getElementById('ppA4Canvas');
const a4PreviewCtx = a4PreviewCanvas.getContext('2d');
const zoomSlider = document.getElementById('ppZoomSlider');
const zoomVal = document.getElementById('ppZoomVal');
const emptyMsg = document.getElementById('ppEmptyMsg');
const faceGuide = document.getElementById('ppFaceGuide');
const loaderOverlay = document.getElementById('ppLoaderOverlay');
const loaderText = document.getElementById('ppLoaderText');
const progressFill = document.getElementById('ppProgressFill');
const aiStatus = document.getElementById('ppAiStatus');

const workCanvas = document.createElement('canvas');
let fgCanvas = null;
const cutCanvas = document.createElement('canvas');
let activeImg = null;
let imgLoaded = false;

let baseScale = 1, zoom = 1;
let offsetX = 0, offsetY = 0;

let selectedBg = '#ffffff';
let selectedEdge = 'natural';
let selectedRows = 1;
let selectedBorder = 'black3';
let selectedFilter = 'none';

let isDragging = false, lastX = 0, lastY = 0;
let prevPinchDist = null, prevMidX = 0, prevMidY = 0;
let rafScheduled = false;

let removeBackgroundFn = null;

function clearA4Preview() {
  a4PreviewCtx.fillStyle = "#ffffff";
  a4PreviewCtx.fillRect(0, 0, a4PreviewCanvas.width, a4PreviewCanvas.height);
}
clearA4Preview();

async function getRemoveBgLib() {
  if (removeBackgroundFn) return removeBackgroundFn;
  const mod = await import("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm");
  removeBackgroundFn = mod.removeBackground || mod.default;
  return removeBackgroundFn;
}

function buildCutout() {
  if (!imgLoaded) return;
  if (selectedBg === 'original' || !fgCanvas) {
    activeImg = workCanvas;
    return;
  }

  const w = fgCanvas.width, h = fgCanvas.height;
  cutCanvas.width = w;
  cutCanvas.height = h;
  const cctx = cutCanvas.getContext('2d', { willReadFrequently: true });

  cctx.clearRect(0, 0, w, h);
  cctx.drawImage(fgCanvas, 0, 0);
  const imgData = cctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  let minA = 14, maxA = 242;
  if (selectedEdge === 'tight') { minA = 42; maxA = 210; }
  else if (selectedEdge === 'soft') { minA = 6; maxA = 250; }

  const invSpan = 255 / (maxA - minA);
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a <= minA) d[i] = 0;
    else if (a >= maxA) d[i] = 255;
    else d[i] = ((a - minA) * invSpan) | 0;
  }
  cctx.putImageData(imgData, 0, 0);

  cctx.globalCompositeOperation = 'destination-over';
  cctx.fillStyle = selectedBg;
  cctx.fillRect(0, 0, w, h);
  cctx.globalCompositeOperation = 'source-over';

  activeImg = cutCanvas;
}

async function runHighPrecisionCutout() {
  loaderOverlay.classList.add('show');
  progressFill.style.width = '10%';
  loaderText.textContent = "Loading High-Precision AI...";
  aiStatus.textContent = "⏳ AI removing background...";
  aiStatus.className = "pp-status-box";

  try {
    const removeBg = await getRemoveBgLib();
    const inputBlob = await new Promise(res => workCanvas.toBlob(res, 'image/jpeg', 0.94));

    const config = {
      model: 'isnet_fp16',
      output: { format: 'image/png', type: 'foreground' },
      progress: (key, current, total) => {
        if (total > 0) {
          const pct = Math.min(98, Math.max(10, Math.round((current / total) * 100)));
          progressFill.style.width = pct + '%';
          loaderText.textContent = key.includes('fetch')
            ? `Downloading AI Model (${pct}%) — One-time...`
            : `Removing Background (${pct}%)...`;
        } else {
          loaderText.textContent = "Refining Hair & Edges...";
        }
      }
    };

    let resultBlob;
    try {
      resultBlob = await removeBg(inputBlob, config);
    } catch {
      config.model = 'isnet_quint8';
      resultBlob = await removeBg(inputBlob, config);
    }

    const cutUrl = URL.createObjectURL(resultBlob);
    const cutImg = new Image();
    cutImg.onload = () => {
      fgCanvas = document.createElement('canvas');
      fgCanvas.width = workCanvas.width;
      fgCanvas.height = workCanvas.height;
      fgCanvas.getContext('2d').drawImage(cutImg, 0, 0, fgCanvas.width, fgCanvas.height);
      URL.revokeObjectURL(cutUrl);

      buildCutout();
      renderAll();
      loaderOverlay.classList.remove('show');
      aiStatus.textContent = "✅ Background Removed! Studio Mode Active";
      aiStatus.className = "pp-status-box ok";
    };
    cutImg.src = cutUrl;
  } catch (err) {
    console.error(err);
    loaderOverlay.classList.remove('show');
    aiStatus.textContent = "⚠️ AI needs HTTPS (GitHub Pages) & Internet";
    aiStatus.className = "pp-status-box warn";
  }
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const rawImg = new Image();
  rawImg.onload = () => {
    URL.revokeObjectURL(url);
    const maxDim = 1280;
    let w = rawImg.width, h = rawImg.height;
    if (w > maxDim || h > maxDim) {
      const r = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    workCanvas.width = w;
    workCanvas.height = h;
    workCanvas.getContext('2d').drawImage(rawImg, 0, 0, w, h);

    fgCanvas = null;
    activeImg = workCanvas;
    imgLoaded = true;
    emptyMsg.style.display = 'none';
    resetPosition();
    runHighPrecisionCutout();
  };
  rawImg.src = url;
}

window.handlePassportPaste = (file) => loadFile(file);

upload.addEventListener('change', (e) => {
  if (e.target.files?.[0]) {
    loadFile(e.target.files[0]);
    upload.value = '';
  }
});

cropStage.addEventListener('dragover', (e) => { e.preventDefault(); cropStage.classList.add('drag-over'); });
cropStage.addEventListener('dragleave', () => cropStage.classList.remove('drag-over'));
cropStage.addEventListener('drop', (e) => {
  e.preventDefault();
  cropStage.classList.remove('drag-over');
  if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
});

function resetPosition() {
  if (!imgLoaded || !activeImg) return;
  baseScale = Math.max(360 / activeImg.width, 450 / activeImg.height);
  zoom = 1;
  offsetX = (360 - activeImg.width * baseScale) / 2;
  offsetY = (450 - activeImg.height * baseScale) / 2;
  updateZoomUI();
  renderAll();
}

function updateZoomUI() {
  zoomSlider.value = zoom.toFixed(2);
  zoomVal.textContent = Math.round(zoom * 100) + '%';
}

function scheduleRender() {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    renderAll();
  });
}

function zoomAtPoint(newZoom, cx, cy) {
  if (!imgLoaded) return;
  newZoom = Math.max(0.4, Math.min(4.0, newZoom));
  const ratio = newZoom / zoom;
  offsetX = cx - (cx - offsetX) * ratio;
  offsetY = cy - (cy - offsetY) * ratio;
  zoom = newZoom;
  updateZoomUI();
  scheduleRender();
}

document.getElementById('ppZoomOutBtn').addEventListener('click', () => zoomAtPoint(zoom - 0.1, 180, 225));
document.getElementById('ppZoomInBtn').addEventListener('click', () => zoomAtPoint(zoom + 0.1, 180, 225));
document.getElementById('ppResetBtn').addEventListener('click', resetPosition);
document.getElementById('ppGuideBtn').addEventListener('click', () => faceGuide.classList.toggle('hidden'));
document.getElementById('ppDownloadBtn').addEventListener('click', downloadA4);
document.getElementById('ppPrintBtn').addEventListener('click', printA4);
document.getElementById('ppAddMultiBtn').addEventListener('click', async () => {
  if (!imgLoaded) return alert("Please upload a photo first!");
  const full = createFullA4Canvas();
  await window.addSheetCanvasToMultiPage(full, 'Passport');
  full.width = 0; full.height = 0;
});

zoomSlider.addEventListener('input', () => zoomAtPoint(parseFloat(zoomSlider.value), 180, 225));

cropStage.addEventListener('wheel', (e) => {
  if (!imgLoaded) return;
  e.preventDefault();
  const rect = cropCanvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (360 / rect.width);
  const cy = (e.clientY - rect.top) * (450 / rect.height);
  zoomAtPoint(zoom * (e.deltaY < 0 ? 1.08 : 0.92), cx, cy);
}, { passive: false });

cropStage.addEventListener('mousedown', (e) => {
  if (!imgLoaded || e.button !== 0) return;
  isDragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener('mousemove', (e) => {
  if (!isDragging || !imgLoaded) return;
  const rect = cropCanvas.getBoundingClientRect();
  const factor = 360 / rect.width;
  offsetX += (e.clientX - lastX) * factor;
  offsetY += (e.clientY - lastY) * factor;
  lastX = e.clientX;
  lastY = e.clientY;
  scheduleRender();
});
window.addEventListener('mouseup', () => { isDragging = false; });

cropStage.addEventListener('touchstart', (e) => {
  if (!imgLoaded) return;
  e.preventDefault();
  if (e.touches.length === 1) {
    isDragging = true;
    prevPinchDist = null;
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    isDragging = false;
    const t0 = e.touches[0], t1 = e.touches[1];
    prevPinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    prevMidX = (t0.clientX + t1.clientX) / 2;
    prevMidY = (t0.clientY + t1.clientY) / 2;
  }
}, { passive: false });

cropStage.addEventListener('touchmove', (e) => {
  if (!imgLoaded) return;
  e.preventDefault();
  const rect = cropCanvas.getBoundingClientRect();
  const factor = 360 / rect.width;

  if (e.touches.length === 1 && isDragging) {
    const tx = e.touches[0].clientX;
    const ty = e.touches[0].clientY;
    offsetX += (tx - lastX) * factor;
    offsetY += (ty - lastY) * factor;
    lastX = tx;
    lastY = ty;
    scheduleRender();
  } else if (e.touches.length === 2 && prevPinchDist) {
    const t0 = e.touches[0], t1 = e.touches[1];
    const curDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const curMidX = (t0.clientX + t1.clientX) / 2;
    const curMidY = (t0.clientY + t1.clientY) / 2;

    offsetX += (curMidX - prevMidX) * factor;
    offsetY += (curMidY - prevMidY) * factor;

    const cx = (curMidX - rect.left) * factor;
    const cy = (curMidY - rect.top) * (450 / rect.height);
    zoomAtPoint(zoom * (curDist / prevPinchDist), cx, cy);

    prevPinchDist = curDist;
    prevMidX = curMidX;
    prevMidY = curMidY;
  }
}, { passive: false });

cropStage.addEventListener('touchend', (e) => {
  if (e.touches.length === 1) {
    prevPinchDist = null;
    isDragging = true;
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
  } else if (e.touches.length === 0) {
    isDragging = false;
    prevPinchDist = null;
  }
});

function setupTemplateGroup(containerId, attr, callback) {
  const buttons = document.querySelectorAll(`#${containerId} .pill-btn`);
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      callback(btn.dataset[attr]);
      if (imgLoaded) renderAll();
    });
  });
}

setupTemplateGroup('ppBgTemplates', 'bg', (val) => { selectedBg = val; buildCutout(); });
setupTemplateGroup('ppEdgeTemplates', 'edge', (val) => { selectedEdge = val; buildCutout(); });
setupTemplateGroup('ppLayoutTemplates', 'rows', (val) => selectedRows = parseInt(val));
setupTemplateGroup('ppBorderTemplates', 'border', (val) => selectedBorder = val);
setupTemplateGroup('ppFilterTemplates', 'filter', (val) => selectedFilter = val);

function drawCrop() {
  if (!imgLoaded || !activeImg) return;
  const bgFill = (selectedBg !== 'original') ? selectedBg : "#ffffff";
  const scale = baseScale * zoom;

  cropCtx.fillStyle = bgFill;
  cropCtx.fillRect(0, 0, 360, 450);

  cropCtx.save();
  cropCtx.imageSmoothingEnabled = true;
  cropCtx.imageSmoothingQuality = 'high';
  if (selectedFilter !== 'none') cropCtx.filter = selectedFilter;
  cropCtx.drawImage(activeImg, offsetX, offsetY, activeImg.width * scale, activeImg.height * scale);
  cropCtx.restore();

  if (selectedBorder === 'black3') {
    cropCtx.strokeStyle = "#000000";
    cropCtx.lineWidth = 3;
    cropCtx.strokeRect(1.5, 1.5, 357, 447);
  } else if (selectedBorder === 'black1') {
    cropCtx.strokeStyle = "#000000";
    cropCtx.lineWidth = 1.5;
    cropCtx.strokeRect(0.75, 0.75, 358.5, 448.5);
  } else if (selectedBorder === 'double') {
    cropCtx.strokeStyle = "#ffffff";
    cropCtx.lineWidth = 6;
    cropCtx.strokeRect(3, 3, 354, 444);
    cropCtx.strokeStyle = "#000000";
    cropCtx.lineWidth = 2.5;
    cropCtx.strokeRect(1.25, 1.25, 357.5, 447.5);
  }
}

function generateA4Preview() {
  if (!imgLoaded) return;
  clearA4Preview();
  const s = 0.25;
  const photoW = 360 * s, photoH = 450 * s;
  const gap = 30 * s, marginX = 85 * s, marginY = 85 * s;

  for (let r = 0; r < selectedRows; r++) {
    const y = marginY + r * (photoH + gap);
    for (let c = 0; c < 6; c++) {
      const x = marginX + c * (photoW + gap);
      a4PreviewCtx.drawImage(cropCanvas, x, y, photoW, photoH);
    }
  }
}

function createFullA4Canvas() {
  drawCrop();
  const full = document.createElement('canvas');
  full.width = 2480;
  full.height = 3508;
  const ctx = full.getContext('2d');
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 2480, 3508);

  const photoW = 360, photoH = 450;
  const gap = 30, marginX = 85, marginY = 85;
  for (let r = 0; r < selectedRows; r++) {
    const y = marginY + r * (photoH + gap);
    for (let c = 0; c < 6; c++) {
      const x = marginX + c * (photoW + gap);
      ctx.drawImage(cropCanvas, x, y);
    }
  }
  return full;
}

function renderAll() {
  drawCrop();
  generateA4Preview();
}

function downloadA4() {
  if (!imgLoaded) return alert("Please upload a photo first!");
  const fullA4 = createFullA4Canvas();
  const dataUrl = fullA4.toDataURL("image/jpeg", 0.96);
  fullA4.width = 0; fullA4.height = 0;

  const bin = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF && bytes[3] === 0xE0 &&
      bytes[6] === 0x4A && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
    bytes[13] = 1;
    bytes[14] = 0x01; bytes[15] = 0x2C;
    bytes[16] = 0x01; bytes[17] = 0x2C;
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `passport_${selectedRows * 6}photos_A4_300DPI.jpg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function printA4() {
  if (!imgLoaded) return alert("Please upload a photo first!");
  const fullA4 = createFullA4Canvas();
  const data = fullA4.toDataURL("image/jpeg", 0.96);
  fullA4.width = 0; fullA4.height = 0;
  window.triggerPrint([data]);
}
