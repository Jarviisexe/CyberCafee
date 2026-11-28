const upload = document.getElementById('ppUpload');
const uploadLabelText = document.getElementById('ppUploadLabelText');
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

function createPersonSlot() {
  const renderedCanvas = document.createElement('canvas');
  renderedCanvas.width = 360;
  renderedCanvas.height = 450;
  return {
    workCanvas: document.createElement('canvas'),
    fgCanvas: null,
    cutCanvas: document.createElement('canvas'),
    renderedCanvas,
    activeImg: null,
    imgLoaded: false,
    baseScale: 1,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    bg: '#ffffff',
    edge: 'natural',
    filter: 'none',
    aiDone: false
  };
}

const persons = [createPersonSlot(), createPersonSlot()];
let personMode = 1; // 1 = 1 Person (6/Row) | 2 = 2 Persons (3+3/Row)
let activePerson = 0;

let selectedRows = 1;
let selectedBorder = 'black3';

let isDragging = false, lastX = 0, lastY = 0;
let prevPinchDist = null, prevMidX = 0, prevMidY = 0;
let rafScheduled = false;

let removeBackgroundFn = null;

function cur() {
  return persons[activePerson];
}

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

// ---------------- 1 PERSON / 2 PERSONS (3+3) MODE ----------------
function updateLayoutLabels() {
  const btns = document.querySelectorAll('#ppLayoutTemplates .pill-btn');
  btns.forEach(btn => {
    const r = parseInt(btn.dataset.rows, 10);
    if (personMode === 2) {
      btn.textContent = `${r * 3}+${r * 3} Photos (${r} ${r === 1 ? 'Row' : 'Rows'})`;
    } else {
      btn.textContent = `${r * 6} Photos (${r} ${r === 1 ? 'Row' : 'Rows'})`;
    }
  });
}

function syncPersonUI() {
  const p = cur();

  // Person switcher tabs
  for (let i = 0; i < 2; i++) {
    const tab = document.getElementById('ppPersonTab' + i);
    if (!tab) continue;
    tab.classList.toggle('active', i === activePerson);
    tab.classList.toggle('has-file', persons[i].imgLoaded);
    const sideLabel = i === 0 ? 'Left 3' : 'Right 3';
    tab.textContent = persons[i].imgLoaded ? `👤 Person ${i + 1} ✓` : `👤 Person ${i + 1} (${sideLabel})`;
  }

  uploadLabelText.textContent = personMode === 2
    ? `Upload Photo (Person ${activePerson + 1})`
    : 'Upload Portrait Photo';

  // Sync BG / Edge / Filter highlights for active person
  document.querySelectorAll('#ppBgTemplates .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.bg === p.bg));
  document.querySelectorAll('#ppEdgeTemplates .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.edge === p.edge));
  document.querySelectorAll('#ppFilterTemplates .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === p.filter));

  emptyMsg.style.display = p.imgLoaded ? 'none' : 'flex';
  if (!p.imgLoaded) {
    cropCtx.clearRect(0, 0, 360, 450);
    const titleEl = emptyMsg.querySelector('strong');
    if (titleEl) {
      titleEl.textContent = personMode === 2
        ? `Upload Photo for Person ${activePerson + 1}`
        : 'Upload or Drop Photo Here';
    }
    aiStatus.textContent = personMode === 2
      ? `🤖 Ready for Person ${activePerson + 1} (${activePerson === 0 ? 'Left 3' : 'Right 3'})`
      : '🤖 HD Background Remove AI Ready';
    aiStatus.className = 'pp-status-box';
  } else {
    aiStatus.textContent = p.aiDone
      ? `✅ Person ${activePerson + 1}: Background Removed!`
      : `🖼️ Person ${activePerson + 1}: Photo Loaded`;
    aiStatus.className = p.aiDone ? 'pp-status-box ok' : 'pp-status-box';
    drawCropForPerson(activePerson);
  }

  updateZoomUI();
}

document.querySelectorAll('#ppModeGroup .pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    personMode = parseInt(btn.dataset.ppmode, 10);
    document.querySelectorAll('#ppModeGroup .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    document.getElementById('ppPersonTabsWrap').style.display = personMode === 2 ? 'block' : 'none';
    if (personMode === 1) activePerson = 0;

    updateLayoutLabels();
    syncPersonUI();
    generateA4Preview();
  });
});

document.getElementById('ppPersonTab0').addEventListener('click', () => {
  activePerson = 0;
  syncPersonUI();
});
document.getElementById('ppPersonTab1').addEventListener('click', () => {
  activePerson = 1;
  syncPersonUI();
});

// ---------------- AI BACKGROUND CUTOUT ----------------
function buildCutout(p) {
  if (!p.imgLoaded) return;
  if (p.bg === 'original' || !p.fgCanvas) {
    p.activeImg = p.workCanvas;
    return;
  }

  const w = p.fgCanvas.width, h = p.fgCanvas.height;
  p.cutCanvas.width = w;
  p.cutCanvas.height = h;
  const cctx = p.cutCanvas.getContext('2d', { willReadFrequently: true });

  cctx.clearRect(0, 0, w, h);
  cctx.drawImage(p.fgCanvas, 0, 0);
  const imgData = cctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  let minA = 14, maxA = 242;
  if (p.edge === 'tight') { minA = 42; maxA = 210; }
  else if (p.edge === 'soft') { minA = 6; maxA = 250; }

  const invSpan = 255 / (maxA - minA);
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i];
    if (a <= minA) d[i] = 0;
    else if (a >= maxA) d[i] = 255;
    else d[i] = ((a - minA) * invSpan) | 0;
  }
  cctx.putImageData(imgData, 0, 0);

  cctx.globalCompositeOperation = 'destination-over';
  cctx.fillStyle = p.bg;
  cctx.fillRect(0, 0, w, h);
  cctx.globalCompositeOperation = 'source-over';

  p.activeImg = p.cutCanvas;
}

async function runHighPrecisionCutout(targetIdx) {
  const p = persons[targetIdx];
  loaderOverlay.classList.add('show');
  progressFill.style.width = '10%';
  loaderText.textContent = "Loading High-Precision AI...";
  aiStatus.textContent = `⏳ AI removing background (Person ${targetIdx + 1})...`;
  aiStatus.className = "pp-status-box";

  try {
    const removeBg = await getRemoveBgLib();
    const inputBlob = await new Promise(res => p.workCanvas.toBlob(res, 'image/jpeg', 0.94));

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
      p.fgCanvas = document.createElement('canvas');
      p.fgCanvas.width = p.workCanvas.width;
      p.fgCanvas.height = p.workCanvas.height;
      p.fgCanvas.getContext('2d').drawImage(cutImg, 0, 0, p.fgCanvas.width, p.fgCanvas.height);
      URL.revokeObjectURL(cutUrl);

      p.aiDone = true;
      buildCutout(p);
      drawCropForPerson(targetIdx);
      generateA4Preview();
      loaderOverlay.classList.remove('show');
      if (targetIdx === activePerson) {
        aiStatus.textContent = `✅ Person ${targetIdx + 1}: Background Removed!`;
        aiStatus.className = "pp-status-box ok";
      }
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
  const targetIdx = activePerson;
  const p = persons[targetIdx];

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
    p.workCanvas.width = w;
    p.workCanvas.height = h;
    p.workCanvas.getContext('2d').drawImage(rawImg, 0, 0, w, h);

    p.fgCanvas = null;
    p.aiDone = false;
    p.activeImg = p.workCanvas;
    p.imgLoaded = true;
    resetPosition();
    syncPersonUI();
    runHighPrecisionCutout(targetIdx);
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
  const p = cur();
  if (!p.imgLoaded || !p.activeImg) return;
  p.baseScale = Math.max(360 / p.activeImg.width, 450 / p.activeImg.height);
  p.zoom = 1;
  p.offsetX = (360 - p.activeImg.width * p.baseScale) / 2;
  p.offsetY = (450 - p.activeImg.height * p.baseScale) / 2;
  updateZoomUI();
  renderAll();
}

function updateZoomUI() {
  const p = cur();
  zoomSlider.value = p.zoom.toFixed(2);
  zoomVal.textContent = Math.round(p.zoom * 100) + '%';
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
  const p = cur();
  if (!p.imgLoaded) return;
  newZoom = Math.max(0.4, Math.min(4.0, newZoom));
  const ratio = newZoom / p.zoom;
  p.offsetX = cx - (cx - p.offsetX) * ratio;
  p.offsetY = cy - (cy - p.offsetY) * ratio;
  p.zoom = newZoom;
  updateZoomUI();
  scheduleRender();
}

document.getElementById('ppZoomOutBtn').addEventListener('click', () => zoomAtPoint(cur().zoom - 0.1, 180, 225));
document.getElementById('ppZoomInBtn').addEventListener('click', () => zoomAtPoint(cur().zoom + 0.1, 180, 225));
document.getElementById('ppResetBtn').addEventListener('click', resetPosition);
document.getElementById('ppGuideBtn').addEventListener('click', () => faceGuide.classList.toggle('hidden'));
document.getElementById('ppDownloadBtn').addEventListener('click', downloadA4);
document.getElementById('ppPrintBtn').addEventListener('click', printA4);
document.getElementById('ppAddMultiBtn').addEventListener('click', async () => {
  if (!hasAnyPhotoLoaded()) return alert("Please upload a photo first!");
  const full = createFullA4Canvas();
  await window.addSheetCanvasToMultiPage(full, 'Passport');
  full.width = 0; full.height = 0;
});

zoomSlider.addEventListener('input', () => zoomAtPoint(parseFloat(zoomSlider.value), 180, 225));

cropStage.addEventListener('wheel', (e) => {
  if (!cur().imgLoaded) return;
  e.preventDefault();
  const rect = cropCanvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) * (360 / rect.width);
  const cy = (e.clientY - rect.top) * (450 / rect.height);
  zoomAtPoint(cur().zoom * (e.deltaY < 0 ? 1.08 : 0.92), cx, cy);
}, { passive: false });

cropStage.addEventListener('mousedown', (e) => {
  if (!cur().imgLoaded || e.button !== 0) return;
  isDragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener('mousemove', (e) => {
  const p = cur();
  if (!isDragging || !p.imgLoaded) return;
  const rect = cropCanvas.getBoundingClientRect();
  const factor = 360 / rect.width;
  p.offsetX += (e.clientX - lastX) * factor;
  p.offsetY += (e.clientY - lastY) * factor;
  lastX = e.clientX;
  lastY = e.clientY;
  scheduleRender();
});
window.addEventListener('mouseup', () => { isDragging = false; });

cropStage.addEventListener('touchstart', (e) => {
  if (!cur().imgLoaded) return;
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
  const p = cur();
  if (!p.imgLoaded) return;
  e.preventDefault();
  const rect = cropCanvas.getBoundingClientRect();
  const factor = 360 / rect.width;

  if (e.touches.length === 1 && isDragging) {
    const tx = e.touches[0].clientX;
    const ty = e.touches[0].clientY;
    p.offsetX += (tx - lastX) * factor;
    p.offsetY += (ty - lastY) * factor;
    lastX = tx;
    lastY = ty;
    scheduleRender();
  } else if (e.touches.length === 2 && prevPinchDist) {
    const t0 = e.touches[0], t1 = e.touches[1];
    const curDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const curMidX = (t0.clientX + t1.clientX) / 2;
    const curMidY = (t0.clientY + t1.clientY) / 2;

    p.offsetX += (curMidX - prevMidX) * factor;
    p.offsetY += (curMidY - prevMidY) * factor;

    const cx = (curMidX - rect.left) * factor;
    const cy = (curMidY - rect.top) * (450 / rect.height);
    zoomAtPoint(p.zoom * (curDist / prevPinchDist), cx, cy);

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

function setupTemplateGroup(containerId, attr, callback, redrawAllPersons = false) {
  const buttons = document.querySelectorAll(`#${containerId} .pill-btn`);
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      callback(btn.dataset[attr]);
      if (redrawAllPersons) {
        if (persons[0].imgLoaded) drawCropForPerson(0);
        if (persons[1].imgLoaded) drawCropForPerson(1);
        generateA4Preview();
      } else if (cur().imgLoaded) {
        renderAll();
      } else {
        generateA4Preview();
      }
    });
  });
}

setupTemplateGroup('ppBgTemplates', 'bg', (val) => { cur().bg = val; buildCutout(cur()); });
setupTemplateGroup('ppEdgeTemplates', 'edge', (val) => { cur().edge = val; buildCutout(cur()); });
setupTemplateGroup('ppLayoutTemplates', 'rows', (val) => { selectedRows = parseInt(val, 10); }, true);
setupTemplateGroup('ppBorderTemplates', 'border', (val) => { selectedBorder = val; }, true);
setupTemplateGroup('ppFilterTemplates', 'filter', (val) => { cur().filter = val; });

function drawCropForPerson(idx) {
  const p = persons[idx];
  if (!p.imgLoaded || !p.activeImg) return;

  const rCtx = p.renderedCanvas.getContext('2d');
  const bgFill = (p.bg !== 'original') ? p.bg : "#ffffff";
  const scale = p.baseScale * p.zoom;

  rCtx.fillStyle = bgFill;
  rCtx.fillRect(0, 0, 360, 450);

  rCtx.save();
  rCtx.imageSmoothingEnabled = true;
  rCtx.imageSmoothingQuality = 'high';
  if (p.filter !== 'none') rCtx.filter = p.filter;
  rCtx.drawImage(p.activeImg, p.offsetX, p.offsetY, p.activeImg.width * scale, p.activeImg.height * scale);
  rCtx.restore();

  if (selectedBorder === 'black3') {
    rCtx.strokeStyle = "#000000";
    rCtx.lineWidth = 3;
    rCtx.strokeRect(1.5, 1.5, 357, 447);
  } else if (selectedBorder === 'black1') {
    rCtx.strokeStyle = "#000000";
    rCtx.lineWidth = 1.5;
    rCtx.strokeRect(0.75, 0.75, 358.5, 448.5);
  } else if (selectedBorder === 'double') {
    rCtx.strokeStyle = "#ffffff";
    rCtx.lineWidth = 6;
    rCtx.strokeRect(3, 3, 354, 444);
    rCtx.strokeStyle = "#000000";
    rCtx.lineWidth = 2.5;
    rCtx.strokeRect(1.25, 1.25, 357.5, 447.5);
  }

  if (idx === activePerson) {
    cropCtx.clearRect(0, 0, 360, 450);
    cropCtx.drawImage(p.renderedCanvas, 0, 0);
  }
}

function hasAnyPhotoLoaded() {
  if (personMode === 1) return persons[0].imgLoaded;
  return persons[0].imgLoaded || persons[1].imgLoaded;
}

function generateA4Preview() {
  clearA4Preview();
  if (!hasAnyPhotoLoaded() && personMode === 1) return;

  const s = 0.25;
  const photoW = 360 * s, photoH = 450 * s;
  const gap = 30 * s, marginX = 85 * s, marginY = 85 * s;

  for (let r = 0; r < selectedRows; r++) {
    const y = marginY + r * (photoH + gap);
    for (let c = 0; c < 6; c++) {
      const x = marginX + c * (photoW + gap);
      const pIdx = (personMode === 2 && c >= 3) ? 1 : 0;
      const p = persons[pIdx];

      if (p.imgLoaded) {
        a4PreviewCtx.drawImage(p.renderedCanvas, x, y, photoW, photoH);
      } else if (personMode === 2) {
        a4PreviewCtx.save();
        a4PreviewCtx.strokeStyle = '#cbd5e1';
        a4PreviewCtx.setLineDash([3, 3]);
        a4PreviewCtx.strokeRect(x, y, photoW, photoH);
        a4PreviewCtx.fillStyle = '#94a3b8';
        a4PreviewCtx.font = 'bold 11px sans-serif';
        a4PreviewCtx.textAlign = 'center';
        a4PreviewCtx.textBaseline = 'middle';
        a4PreviewCtx.fillText(`P${pIdx + 1}`, x + photoW / 2, y + photoH / 2);
        a4PreviewCtx.restore();
      }
    }
  }
}

function createFullA4Canvas() {
  if (persons[0].imgLoaded) drawCropForPerson(0);
  if (personMode === 2 && persons[1].imgLoaded) drawCropForPerson(1);

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
      const pIdx = (personMode === 2 && c >= 3) ? 1 : 0;
      const p = persons[pIdx];
      if (p.imgLoaded) {
        ctx.drawImage(p.renderedCanvas, x, y);
      }
    }
  }
  return full;
}

function renderAll() {
  drawCropForPerson(activePerson);
  generateA4Preview();
}

function downloadA4() {
  if (!hasAnyPhotoLoaded()) return alert("Please upload a photo first!");
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

  const label = personMode === 2
    ? `${selectedRows * 3}+${selectedRows * 3}photos`
    : `${selectedRows * 6}photos`;

  const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `passport_${label}_A4_300DPI.jpg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function printA4() {
  if (!hasAnyPhotoLoaded()) return alert("Please upload a photo first!");
  const fullA4 = createFullA4Canvas();
  const data = fullA4.toDataURL("image/jpeg", 0.96);
  fullA4.width = 0; fullA4.height = 0;
  window.triggerPrint([data]);
}

updateLayoutLabels();
syncPersonUI();
