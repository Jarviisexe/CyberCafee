// e-Aadhaar Joint Card Print Engine
// Single side = 8.56 x 5.40 cm | Joint Front+Back = 17.12 x 5.40 cm @ 300 DPI
const CP_SINGLE_W_MM = 85.6;
const CP_JOINT_W_MM = 171.2;
const CP_CARD_H_MM = 54.0;

function createEmptyCpSlot(index) {
  return {
    pdfDoc: null,
    pageImg: null,
    cardCanvas: null,
    corners: null,
    cardMode: 'joint',
    fileName: '',
    fileSub: '',
    numPages: 1,
    currentPage: 1,
    xMm: 10,
    yMm: 14 + index * 64,
    wMm: CP_JOINT_W_MM,
    hMm: CP_CARD_H_MM,
    // Inside-box pan & zoom adjustments
    innerScale: 1.0,
    innerXMm: 0,
    innerYMm: 0
  };
}

const cpState = {
  cardCount: 1,
  activeSlot: 0,
  slots: [createEmptyCpSlot(0), createEmptyCpSlot(1), createEmptyCpSlot(2)],
  borderColor: '#000000',
  pendingPdfResolve: null,
  interactMode: 'none', // 'none' (clean default) | 'inside' (set card inside box) | 'box' (manual box move/resize)
  dragMode: null,       // 'inside' | 'move' | 0..7
  dragStartMm: { x: 0, y: 0 },
  dragOrigRect: null
};

const cpZone = document.getElementById('cpDropZone');
const cpInput = document.getElementById('cpFileInput');
const cpA4Canvas = document.getElementById('cpA4PreviewCanvas');

cpInput.addEventListener('change', (e) => {
  if (e.target.files?.[0]) {
    handleCardPrintUpload(e.target.files[0]);
    cpInput.value = '';
  }
});
cpZone.addEventListener('dragover', (e) => { e.preventDefault(); cpZone.classList.add('dragover'); });
cpZone.addEventListener('dragleave', () => cpZone.classList.remove('dragover'));
cpZone.addEventListener('drop', (e) => {
  e.preventDefault();
  cpZone.classList.remove('dragover');
  if (e.dataTransfer.files?.[0]) handleCardPrintUpload(e.dataTransfer.files[0]);
});

// ---------------- INTERACT MODE TOGGLES (BELOW A4 PREVIEW) ----------------
function toggleCpInteractMode(mode) {
  cpState.interactMode = cpState.interactMode === mode ? 'none' : mode;
  cpState.dragMode = null;

  document.getElementById('cpBtnInside').classList.toggle('active', cpState.interactMode === 'inside');
  document.getElementById('cpBtnBox').classList.toggle('active', cpState.interactMode === 'box');

  document.getElementById('cpInsideZoomBar').style.display = cpState.interactMode === 'inside' ? 'flex' : 'none';
  document.getElementById('cpBoxOptionBar').style.display = cpState.interactMode === 'box' ? 'flex' : 'none';

  const meta = document.getElementById('cpPreviewMeta');
  if (cpState.interactMode === 'inside') {
    meta.innerText = 'Drag inside box to slide card • Scroll or use slider to zoom inside box';
    syncInsideZoomUI();
  } else if (cpState.interactMode === 'box') {
    meta.innerText = 'Drag box to move on A4 • Drag 8 handles to match any 4-border size';
  } else {
    meta.innerText = 'Clean Preview • Click buttons below to adjust card or box';
  }

  renderCardPrintA4();
}

function syncInsideZoomUI() {
  const s = cpState.slots[cpState.activeSlot];
  document.getElementById('cpInsideZoomSlider').value = s.innerScale.toFixed(2);
  document.getElementById('cpInsideZoomVal').innerText = Math.round(s.innerScale * 100) + '%';
}

function onCpInsideZoomSlide() {
  const s = cpState.slots[cpState.activeSlot];
  s.innerScale = parseFloat(document.getElementById('cpInsideZoomSlider').value) || 1;
  document.getElementById('cpInsideZoomVal').innerText = Math.round(s.innerScale * 100) + '%';
  renderCardPrintA4();
}

function cpZoomInsideBy(delta) {
  const s = cpState.slots[cpState.activeSlot];
  s.innerScale = Math.max(0.7, Math.min(2.5, s.innerScale + delta));
  syncInsideZoomUI();
  renderCardPrintA4();
}

function resetCpInsideFit() {
  const s = cpState.slots[cpState.activeSlot];
  s.innerScale = 1.0;
  s.innerXMm = 0;
  s.innerYMm = 0;
  syncInsideZoomUI();
  renderCardPrintA4();
  showToast('Card inside box reset to exact fit');
}

// ---------------- CARD COUNT (1 / 2 / 3) & SLOT MANAGEMENT ----------------
function setCpCardCount(count, btn) {
  cpState.cardCount = count;
  document.querySelectorAll('[data-cpcount]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.getElementById('cpSlotTabsWrap').style.display = count > 1 ? 'block' : 'none';
  document.getElementById('cpSlotTab2').style.display = count === 3 ? 'block' : 'none';
  document.getElementById('cpGapRow').style.display = count > 1 ? 'flex' : 'none';

  if (cpState.activeSlot >= count) cpState.activeSlot = count - 1;
  autoArrangeCpCards();
  syncSlotPanelUI();
}

function selectCpSlot(idx) {
  if (idx < 0 || idx >= cpState.cardCount) return;
  cpState.activeSlot = idx;
  syncSlotPanelUI();
  syncInsideZoomUI();
  renderCardPrintA4();
}

function autoArrangeCpCards() {
  const leftMm = Number(document.getElementById('cpLeftMarginSlider').value) || 10;
  const topMm = cpState.cardCount > 1 ? 10 : (Number(document.getElementById('cpTopMarginSlider').value) || 14);
  const gapMm = Number(document.getElementById('cpGapSlider').value) || 10;

  if (cpState.cardCount > 1) {
    document.getElementById('cpTopMarginSlider').value = topMm;
    document.getElementById('cpTopMarginVal').innerText = topMm + 'mm';
  }

  for (let i = 0; i < cpState.cardCount; i++) {
    const s = cpState.slots[i];
    s.xMm = leftMm;
    s.yMm = topMm + i * (s.hMm + gapMm);
  }
  syncSlotPanelUI();
  renderCardPrintA4();
}

async function copyCpCard1ToAll() {
  const src = cpState.slots[0];
  if (!src.cardCanvas) {
    alert('Please upload Card 1 first!');
    return;
  }
  for (let i = 1; i < cpState.cardCount; i++) {
    const dst = cpState.slots[i];
    if (dst.cardCanvas) { dst.cardCanvas.width = 0; dst.cardCanvas.height = 0; }
    const clone = document.createElement('canvas');
    clone.width = src.cardCanvas.width;
    clone.height = src.cardCanvas.height;
    clone.getContext('2d').drawImage(src.cardCanvas, 0, 0);

    dst.cardCanvas = clone;
    dst.pageImg = src.pageImg;
    dst.corners = src.corners ? src.corners.map(p => ({ ...p })) : null;
    dst.cardMode = src.cardMode;
    dst.fileName = src.fileName + ' (Copy)';
    dst.fileSub = src.fileSub;
    dst.wMm = src.wMm;
    dst.hMm = src.hMm;
    dst.innerScale = src.innerScale;
    dst.innerXMm = src.innerXMm;
    dst.innerYMm = src.innerYMm;
  }
  autoArrangeCpCards();
  showToast(`Copied Card 1 to all ${cpState.cardCount} slots!`);
}

function syncSlotPanelUI() {
  const slot = cpState.slots[cpState.activeSlot];

  for (let i = 0; i < 3; i++) {
    const tabBtn = document.getElementById('cpSlotTab' + i);
    if (!tabBtn) continue;
    tabBtn.classList.toggle('active', i === cpState.activeSlot);
    tabBtn.classList.toggle('has-file', !!cpState.slots[i].cardCanvas);
    tabBtn.innerText = cpState.slots[i].cardCanvas ? `Card ${i + 1} ✓` : `Card ${i + 1}`;
  }

  document.getElementById('cpDropTitle').innerText = cpState.cardCount > 1
    ? `Upload PDF / Image for Card ${cpState.activeSlot + 1}`
    : 'Upload e-Aadhaar PDF (or Image)';

  document.getElementById('cpSlotHeaderLabel').innerText = cpState.cardCount > 1
    ? `CARD ${cpState.activeSlot + 1} (BOTTOM JOINT CARD)`
    : 'EXTRACTED BOTTOM CARD (JOINT FRONT + BACK)';

  if (slot.fileName) {
    document.getElementById('cpFileName').innerText = slot.fileName;
    document.getElementById('cpFileSub').innerText = slot.fileSub;
    document.getElementById('cpFileMeta').classList.add('show');
    document.getElementById('cpClearBtn').style.display = 'inline-block';
  } else {
    document.getElementById('cpFileMeta').classList.remove('show');
    document.getElementById('cpClearBtn').style.display = 'none';
  }

  const navWrap = document.getElementById('cpPageNavWrap');
  const pageSel = document.getElementById('cpPageSelect');
  if (slot.pdfDoc && slot.numPages > 1) {
    pageSel.innerHTML = '';
    for (let p = 1; p <= slot.numPages; p++) {
      pageSel.innerHTML += `<option value="${p}" ${p === slot.currentPage ? 'selected' : ''}>${p} / ${slot.numPages}</option>`;
    }
    navWrap.style.display = 'flex';
  } else {
    navWrap.style.display = 'none';
  }

  document.querySelectorAll('[data-cpmode]').forEach(b => {
    b.classList.toggle('active', b.dataset.cpmode === slot.cardMode);
  });

  document.getElementById('cpLeftMarginSlider').value = Math.round(slot.xMm);
  document.getElementById('cpLeftMarginVal').innerText = Math.round(slot.xMm) + 'mm';
  document.getElementById('cpTopMarginSlider').value = Math.round(slot.yMm);
  document.getElementById('cpTopMarginVal').innerText = Math.round(slot.yMm) + 'mm';

  updateLiveDimBadge();
  updateCardPrintSlotUI();
}

function updateLiveDimBadge() {
  const slot = cpState.slots[cpState.activeSlot];
  const wCm = (slot.wMm / 10).toFixed(2);
  const hCm = (slot.hMm / 10).toFixed(2);
  document.getElementById('cpLiveDimBadge').innerText =
    `${cpState.cardCount > 1 ? 'Card ' + (cpState.activeSlot + 1) + ': ' : ''}${wCm} × ${hCm} cm`;
}

// ---------------- PDF / IMAGE UPLOAD & UNLOCK ----------------
async function handleCardPrintUpload(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImg = file.type.startsWith('image/');
  if (!isPdf && !isImg) {
    alert('Please upload an e-Aadhaar PDF or image file.');
    return;
  }

  const slot = cpState.slots[cpState.activeSlot];
  slot.fileName = file.name;

  if (isPdf) {
    try {
      const pdfLib = await ensurePdfJs();
      if (!pdfLib) throw new Error('PDF reader unavailable');
      setProgress(true, 'Opening PDF...', 30);

      const rawBuf = await file.arrayBuffer();
      const pdfDoc = await openPdfWithOptionalPassword(pdfLib, rawBuf);
      if (!pdfDoc) { setProgress(false); return; }

      slot.pdfDoc = pdfDoc;
      slot.numPages = pdfDoc.numPages;
      slot.currentPage = 1;
      slot.fileSub = `PDF • ${pdfDoc.numPages} Page(s) • 300 DPI`;

      await loadCardPrintPdfPage(1);
    } catch (err) {
      setProgress(false);
      console.error(err);
      alert('Could not open PDF file.');
    }
  } else {
    setProgress(true, 'Loading image...', 40);
    const img = await fileToResizedImage(file, 2600);
    slot.pdfDoc = null;
    slot.numPages = 1;
    slot.currentPage = 1;
    slot.pageImg = img;
    slot.fileSub = `Image • ${img.width}×${img.height}px`;
    await extractBottomJointCard(img);
    setProgress(false);
  }
}
window.handleCardPrintUpload = handleCardPrintUpload;

async function openPdfWithOptionalPassword(pdfLib, rawBuf) {
  let password = '';
  while (true) {
    try {
      const task = pdfLib.getDocument({ data: new Uint8Array(rawBuf.slice(0)), password });
      return await task.promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        setProgress(false);
        const isWrong = err.code === 2;
        const entered = await askPdfPasswordModal(
          isWrong ? 'Wrong password! Please check and try again.' : ''
        );
        if (entered === null) return null;
        password = entered;
        setProgress(true, 'Unlocking PDF...', 45);
      } else {
        throw err;
      }
    }
  }
}

function askPdfPasswordModal(errorText = '') {
  return new Promise((resolve) => {
    cpState.pendingPdfResolve = resolve;
    const modal = document.getElementById('cpPwdModal');
    const input = document.getElementById('cpPwdInput');
    document.getElementById('cpPwdError').innerText = errorText;
    input.value = '';
    input.type = 'password';
    modal.classList.add('open');
    setTimeout(() => input.focus(), 60);
  });
}

function togglePdfPwdVisibility() {
  const input = document.getElementById('cpPwdInput');
  input.type = input.type === 'password' ? 'text' : 'password';
}

function submitPdfPassword() {
  const val = document.getElementById('cpPwdInput').value;
  document.getElementById('cpPwdModal').classList.remove('open');
  if (cpState.pendingPdfResolve) {
    const res = cpState.pendingPdfResolve;
    cpState.pendingPdfResolve = null;
    res(val);
  }
}

function cancelPdfPassword() {
  document.getElementById('cpPwdModal').classList.remove('open');
  if (cpState.pendingPdfResolve) {
    const res = cpState.pendingPdfResolve;
    cpState.pendingPdfResolve = null;
    res(null);
  }
}

async function onCardPrintPageChange() {
  const pageNum = Number(document.getElementById('cpPageSelect').value) || 1;
  cpState.slots[cpState.activeSlot].currentPage = pageNum;
  await loadCardPrintPdfPage(pageNum);
}

async function loadCardPrintPdfPage(pageNum) {
  const slot = cpState.slots[cpState.activeSlot];
  if (!slot.pdfDoc) return;
  setProgress(true, `Rendering Page ${pageNum} at 300 DPI...`, 50);

  const page = await slot.pdfDoc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1.0 });
  const scale = Math.min(4.2, Math.max(2.5, 2480 / vp1.width));
  const vp = page.getViewport({ scale });

  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.round(vp.width);
  pageCanvas.height = Math.round(vp.height);
  const ctx = pageCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  setProgress(true, 'Auto-detecting bottom joint card...', 80);
  const blob = await canvasToBlob(pageCanvas, 'image/png');
  pageCanvas.width = 0; pageCanvas.height = 0;
  const img = await blobToImage(blob);
  slot.pageImg = img;

  await extractBottomJointCard(img);
  setProgress(false);
}

function detectBottomJointCorners(img, cardMode) {
  const maxW = 600;
  const scale = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  c.width = 0; c.height = 0;

  const yScanStart = Math.floor(h * 0.50);
  const yScanEnd = Math.floor(h * 0.72);
  const rowInk = new Float32Array(h);

  for (let y = Math.floor(h * 0.45); y < h; y++) {
    let ink = 0;
    for (let x = Math.floor(w * 0.04); x < Math.floor(w * 0.96); x++) {
      const i = (y * w + x) * 4;
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) ink++;
    }
    rowInk[y] = ink / (w * 0.92);
  }

  let splitY = Math.floor(h * 0.61);
  let bestBlankRun = 0, curRun = 0, runEnd = splitY;
  for (let y = yScanStart; y <= yScanEnd; y++) {
    if (rowInk[y] < 0.015) {
      curRun++;
      if (curRun >= bestBlankRun) { bestBlankRun = curRun; runEnd = y; }
    } else {
      curRun = 0;
    }
  }
  if (bestBlankRun >= 4) splitY = runEnd;

  const x0 = Math.floor(w * 0.02);
  const x1 = Math.floor(w * 0.98);
  const y1 = Math.floor(h * 0.975);
  const rw = x1 - x0;

  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = splitY; y < y1; y++) {
    let count = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (data[i] < 242 || data[i + 1] < 242 || data[i + 2] < 242) count++;
    }
    if (count > rw * 0.02) {
      if (top === -1) top = y;
      bottom = y;
    }
  }

  if (top !== -1 && (bottom - top) >= h * 0.14) {
    for (let x = x0; x < x1; x++) {
      let count = 0;
      for (let y = top; y <= bottom; y++) {
        const i = (y * w + x) * 4;
        if (data[i] < 242 || data[i + 1] < 242 || data[i + 2] < 242) count++;
      }
      if (count > (bottom - top) * 0.04) {
        if (left === -1) left = x;
        right = x;
      }
    }
  }

  const ratio = (left !== -1 && right > left && bottom > top) ? (right - left) / (bottom - top) : 0;
  const isValidRatio = cardMode === 'joint' ? (ratio >= 2.2 && ratio <= 4.1) : (ratio >= 1.15 && ratio <= 2.2);

  if (isValidRatio) {
    const lx = Math.max(0, left - 1) / scale;
    const ty = Math.max(0, top - 1) / scale;
    const rx = Math.min(w, right + 2) / scale;
    const by = Math.min(h, bottom + 2) / scale;
    return [{ x: lx, y: ty }, { x: rx, y: ty }, { x: rx, y: by }, { x: lx, y: by }];
  }

  return [
    { x: img.width * 0.048, y: img.height * 0.638 },
    { x: img.width * 0.952, y: img.height * 0.638 },
    { x: img.width * 0.952, y: img.height * 0.912 },
    { x: img.width * 0.048, y: img.height * 0.912 }
  ];
}

async function extractBottomJointCard(img) {
  const slot = cpState.slots[cpState.activeSlot];
  const corners = detectBottomJointCorners(img, slot.cardMode);
  slot.corners = corners;
  slot.innerScale = 1.0;
  slot.innerXMm = 0;
  slot.innerYMm = 0;

  const targetW = slot.cardMode === 'single' ? 1011 : 2022;
  if (slot.cardCanvas) { slot.cardCanvas.width = 0; slot.cardCanvas.height = 0; }
  slot.cardCanvas = await warpPerspectiveAsync(img, corners, targetW, 638);
  syncSlotPanelUI();
  syncInsideZoomUI();
  renderCardPrintA4();
  showToast(`Card ${cpState.activeSlot + 1} extracted at 300 DPI!`);
}

async function reAutoDetectBottomCard() {
  const slot = cpState.slots[cpState.activeSlot];
  if (!slot.pageImg) { alert('Please upload an e-Aadhaar PDF or image first.'); return; }
  setProgress(true, 'Re-detecting bottom card...', 60);
  await extractBottomJointCard(slot.pageImg);
  setProgress(false);
}

function updateCardPrintSlotUI() {
  const slot = cpState.slots[cpState.activeSlot];
  const preview = document.getElementById('cpCardPreview');
  const status = document.getElementById('cpCardStatus');

  if (slot.cardCanvas) {
    preview.innerHTML = `<img src="${slot.cardCanvas.toDataURL('image/jpeg', 0.8)}" alt="Joint Card" />`;
    status.innerText = `${(slot.wMm / 10).toFixed(2)}×${(slot.hMm / 10).toFixed(2)} cm`;
    status.style.color = '#34d399';
  } else {
    preview.innerHTML = 'No Card Loaded';
    status.innerText = 'Empty';
    status.style.color = '#94a3b8';
  }
}

function openCardPrintCrop() {
  const slot = cpState.slots[cpState.activeSlot];
  if (!slot.pageImg) { cpInput.click(); return; }
  openCropModal(
    { mode: 'cardprint', slot: cpState.activeSlot, cardMode: slot.cardMode },
    slot.pageImg,
    false,
    slot.corners
  );
}

window.onCardPrintCropDone = async function (warped, savedCorners) {
  const slot = cpState.slots[cpState.activeSlot];
  if (slot.cardCanvas) { slot.cardCanvas.width = 0; slot.cardCanvas.height = 0; }
  slot.corners = savedCorners;
  slot.cardCanvas = warped;
  slot.innerScale = 1.0;
  slot.innerXMm = 0;
  slot.innerYMm = 0;
  syncSlotPanelUI();
  syncInsideZoomUI();
  renderCardPrintA4();
};

function rotateCardPrint() {
  const slot = cpState.slots[cpState.activeSlot];
  const src = slot.cardCanvas;
  if (!src) return;
  const off = document.createElement('canvas');
  off.width = src.height; off.height = src.width;
  const octx = off.getContext('2d');
  octx.translate(off.width / 2, off.height / 2);
  octx.rotate(Math.PI / 2);
  octx.drawImage(src, -src.width / 2, -src.height / 2);
  src.width = 0; src.height = 0;
  slot.cardCanvas = off;
  syncSlotPanelUI();
  renderCardPrintA4();
}

function clearCardPrintSlot() {
  const idx = cpState.activeSlot;
  const old = cpState.slots[idx];
  if (old.cardCanvas) { old.cardCanvas.width = 0; old.cardCanvas.height = 0; }
  const keptPos = { xMm: old.xMm, yMm: old.yMm, wMm: old.wMm, hMm: old.hMm, cardMode: old.cardMode };
  cpState.slots[idx] = { ...createEmptyCpSlot(idx), ...keptPos };
  syncSlotPanelUI();
  syncInsideZoomUI();
  renderCardPrintA4();
}

function setCpCardMode(mode, btn) {
  const slot = cpState.slots[cpState.activeSlot];
  slot.cardMode = mode;
  slot.wMm = mode === 'single' ? CP_SINGLE_W_MM : CP_JOINT_W_MM;
  slot.hMm = CP_CARD_H_MM;
  document.querySelectorAll('[data-cpmode]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  syncSlotPanelUI();
  renderCardPrintA4();
}

function resetCpCardSize() {
  const slot = cpState.slots[cpState.activeSlot];
  slot.wMm = slot.cardMode === 'single' ? CP_SINGLE_W_MM : CP_JOINT_W_MM;
  slot.hMm = CP_CARD_H_MM;
  syncSlotPanelUI();
  renderCardPrintA4();
  showToast('Reset to exact 8.56 × 5.40 cm ratio');
}

function setCpBorderColor(color, btn) {
  cpState.borderColor = color;
  document.getElementById('cpBorderColorInput').value = color;
  document.querySelectorAll('[data-cpcolor]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderCardPrintA4();
}

function onCpCustomColor(val) {
  cpState.borderColor = val;
  document.querySelectorAll('[data-cpcolor]').forEach(b => b.classList.remove('active'));
  renderCardPrintA4();
}

function onCpBorderSlide() {
  document.getElementById('cpBorderWidthVal').innerText =
    document.getElementById('cpBorderWidthSlider').value + ' px';
  renderCardPrintA4();
}

function onCpMarginSlide() {
  const slot = cpState.slots[cpState.activeSlot];
  const leftMm = Number(document.getElementById('cpLeftMarginSlider').value);
  const topMm = Number(document.getElementById('cpTopMarginSlider').value);
  slot.xMm = Math.min(210 - slot.wMm, leftMm);
  slot.yMm = Math.min(297 - slot.hMm, topMm);
  document.getElementById('cpLeftMarginVal').innerText = Math.round(slot.xMm) + 'mm';
  document.getElementById('cpTopMarginVal').innerText = Math.round(slot.yMm) + 'mm';
  renderCardPrintA4();
}

function onCpGapSlide() {
  const gapMm = Number(document.getElementById('cpGapSlider').value);
  document.getElementById('cpGapVal').innerText = gapMm + 'mm';
  for (let i = 1; i < cpState.cardCount; i++) {
    cpState.slots[i].yMm = cpState.slots[i - 1].yMm + cpState.slots[i - 1].hMm + gapMm;
  }
  syncSlotPanelUI();
  renderCardPrintA4();
}

// ---------------- INTERACTIVE A4 PREVIEW (INSIDE-BOX + MANUAL BOX MODE) ----------------
function getA4HandlePositionsMm(s) {
  return [
    { x: s.xMm, y: s.yMm, cursor: 'nwse-resize' },
    { x: s.xMm + s.wMm, y: s.yMm, cursor: 'nesw-resize' },
    { x: s.xMm + s.wMm, y: s.yMm + s.hMm, cursor: 'nwse-resize' },
    { x: s.xMm, y: s.yMm + s.hMm, cursor: 'nesw-resize' },
    { x: s.xMm + s.wMm / 2, y: s.yMm, cursor: 'ns-resize' },
    { x: s.xMm + s.wMm, y: s.yMm + s.hMm / 2, cursor: 'ew-resize' },
    { x: s.xMm + s.wMm / 2, y: s.yMm + s.hMm, cursor: 'ns-resize' },
    { x: s.xMm, y: s.yMm + s.hMm / 2, cursor: 'ew-resize' }
  ];
}

function pointerToA4Mm(e) {
  const rect = cpA4Canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(210, ((e.clientX - rect.left) / rect.width) * 210)),
    y: Math.max(0, Math.min(297, ((e.clientY - rect.top) / rect.height) * 297))
  };
}

cpA4Canvas.addEventListener('wheel', (e) => {
  if (cpState.interactMode !== 'inside') return;
  const mm = pointerToA4Mm(e);
  for (let i = cpState.cardCount - 1; i >= 0; i--) {
    const s = cpState.slots[i];
    if (mm.x >= s.xMm && mm.x <= s.xMm + s.wMm && mm.y >= s.yMm && mm.y <= s.yMm + s.hMm) {
      e.preventDefault();
      if (i !== cpState.activeSlot) selectCpSlot(i);
      cpZoomInsideBy(e.deltaY < 0 ? 0.05 : -0.05);
      return;
    }
  }
}, { passive: false });

cpA4Canvas.addEventListener('pointerdown', (e) => {
  const mm = pointerToA4Mm(e);

  // Mode 1: Clean preview -> only select slot if clicking a card when cardCount > 1
  if (cpState.interactMode === 'none') {
    for (let i = cpState.cardCount - 1; i >= 0; i--) {
      const s = cpState.slots[i];
      if (mm.x >= s.xMm && mm.x <= s.xMm + s.wMm && mm.y >= s.yMm && mm.y <= s.yMm + s.hMm) {
        if (i !== cpState.activeSlot) selectCpSlot(i);
        return;
      }
    }
    return;
  }

  // Mode 2: Set Card Inside Box
  if (cpState.interactMode === 'inside') {
    for (let i = cpState.cardCount - 1; i >= 0; i--) {
      const s = cpState.slots[i];
      if (mm.x >= s.xMm && mm.x <= s.xMm + s.wMm && mm.y >= s.yMm && mm.y <= s.yMm + s.hMm) {
        if (i !== cpState.activeSlot) selectCpSlot(i);
        cpState.dragMode = 'inside';
        cpState.dragStartMm = mm;
        cpState.dragOrigRect = { innerXMm: s.innerXMm, innerYMm: s.innerYMm };
        cpA4Canvas.setPointerCapture(e.pointerId);
        cpA4Canvas.style.cursor = 'grabbing';
        return;
      }
    }
    return;
  }

  // Mode 3: Manual Box Move / 4-Border Resize
  if (cpState.interactMode === 'box') {
    const active = cpState.slots[cpState.activeSlot];
    const handles = getA4HandlePositionsMm(active);
    for (let i = 0; i < handles.length; i++) {
      if (Math.hypot(handles[i].x - mm.x, handles[i].y - mm.y) <= 5.5) {
        cpState.dragMode = i;
        cpState.dragStartMm = mm;
        cpState.dragOrigRect = { xMm: active.xMm, yMm: active.yMm, wMm: active.wMm, hMm: active.hMm };
        cpA4Canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    for (let i = cpState.cardCount - 1; i >= 0; i--) {
      const s = cpState.slots[i];
      if (mm.x >= s.xMm && mm.x <= s.xMm + s.wMm && mm.y >= s.yMm && mm.y <= s.yMm + s.hMm) {
        if (i !== cpState.activeSlot) selectCpSlot(i);
        cpState.dragMode = 'move';
        cpState.dragStartMm = mm;
        cpState.dragOrigRect = { xMm: s.xMm, yMm: s.yMm, wMm: s.wMm, hMm: s.hMm };
        cpA4Canvas.setPointerCapture(e.pointerId);
        renderCardPrintA4();
        return;
      }
    }
  }
});

cpA4Canvas.addEventListener('pointermove', (e) => {
  const mm = pointerToA4Mm(e);
  const s = cpState.slots[cpState.activeSlot];

  if (cpState.dragMode === null) {
    if (cpState.interactMode === 'none') {
      let over = false;
      if (cpState.cardCount > 1) {
        for (let i = 0; i < cpState.cardCount; i++) {
          const sl = cpState.slots[i];
          if (mm.x >= sl.xMm && mm.x <= sl.xMm + sl.wMm && mm.y >= sl.yMm && mm.y <= sl.yMm + sl.hMm) {
            over = true; break;
          }
        }
      }
      cpA4Canvas.style.cursor = over ? 'pointer' : 'default';
      return;
    }

    if (cpState.interactMode === 'inside') {
      let over = false;
      for (let i = 0; i < cpState.cardCount; i++) {
        const sl = cpState.slots[i];
        if (mm.x >= sl.xMm && mm.x <= sl.xMm + sl.wMm && mm.y >= sl.yMm && mm.y <= sl.yMm + sl.hMm) {
          over = true; break;
        }
      }
      cpA4Canvas.style.cursor = over ? 'grab' : 'default';
      return;
    }

    if (cpState.interactMode === 'box') {
      const handles = getA4HandlePositionsMm(s);
      for (let i = 0; i < handles.length; i++) {
        if (Math.hypot(handles[i].x - mm.x, handles[i].y - mm.y) <= 5.5) {
          cpA4Canvas.style.cursor = handles[i].cursor;
          return;
        }
      }
      let overBody = false;
      for (let i = 0; i < cpState.cardCount; i++) {
        const sl = cpState.slots[i];
        if (mm.x >= sl.xMm && mm.x <= sl.xMm + sl.wMm && mm.y >= sl.yMm && mm.y <= sl.yMm + sl.hMm) {
          overBody = true; break;
        }
      }
      cpA4Canvas.style.cursor = overBody ? 'move' : 'default';
      return;
    }
  }

  const dx = mm.x - cpState.dragStartMm.x;
  const dy = mm.y - cpState.dragStartMm.y;
  const o = cpState.dragOrigRect;

  if (cpState.dragMode === 'inside') {
    s.innerXMm = Math.max(-s.wMm * 0.6, Math.min(s.wMm * 0.6, o.innerXMm + dx));
    s.innerYMm = Math.max(-s.hMm * 0.6, Math.min(s.hMm * 0.6, o.innerYMm + dy));
    renderCardPrintA4();
    return;
  }

  const minW = 30, minH = 20;
  if (cpState.dragMode === 'move') {
    s.xMm = Math.max(0, Math.min(210 - o.wMm, o.xMm + dx));
    s.yMm = Math.max(0, Math.min(297 - o.hMm, o.yMm + dy));
  } else if (typeof cpState.dragMode === 'number') {
    let left = o.xMm, top = o.yMm, right = o.xMm + o.wMm, bottom = o.yMm + o.hMm;
    const m = cpState.dragMode;

    if (m === 0 || m === 3 || m === 7) left = Math.max(0, Math.min(right - minW, o.xMm + dx));
    if (m === 1 || m === 2 || m === 5) right = Math.min(210, Math.max(left + minW, o.xMm + o.wMm + dx));
    if (m === 0 || m === 1 || m === 4) top = Math.max(0, Math.min(bottom - minH, o.yMm + dy));
    if (m === 2 || m === 3 || m === 6) bottom = Math.min(297, Math.max(top + minH, o.yMm + o.hMm + dy));

    if (document.getElementById('cpLockAspectCheck').checked && m < 4) {
      const ratio = o.wMm / o.hMm;
      const newW = right - left;
      const newH = newW / ratio;
      if (m === 0 || m === 1) top = Math.max(0, bottom - newH);
      else bottom = Math.min(297, top + newH);
    }

    s.xMm = left;
    s.yMm = top;
    s.wMm = right - left;
    s.hMm = bottom - top;
  }

  document.getElementById('cpLeftMarginSlider').value = Math.round(s.xMm);
  document.getElementById('cpLeftMarginVal').innerText = Math.round(s.xMm) + 'mm';
  document.getElementById('cpTopMarginSlider').value = Math.round(s.yMm);
  document.getElementById('cpTopMarginVal').innerText = Math.round(s.yMm) + 'mm';
  updateLiveDimBadge();
  updateCardPrintSlotUI();
  renderCardPrintA4();
});

cpA4Canvas.addEventListener('pointerup', () => {
  cpState.dragMode = null;
  if (cpState.interactMode === 'inside') cpA4Canvas.style.cursor = 'grab';
});
cpA4Canvas.addEventListener('pointercancel', () => { cpState.dragMode = null; });

function drawCardPrintA4ToCanvas(canvas, isExport300Dpi = false) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pxPerMm = W / 210;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const showBorder = document.getElementById('cpBorderCheck').checked;
  const strokePxBase = Number(document.getElementById('cpBorderWidthSlider').value);
  const strokeW = Math.max(1, strokePxBase * (W / 2480));

  for (let i = 0; i < cpState.cardCount; i++) {
    const s = cpState.slots[i];
    const x = s.xMm * pxPerMm;
    const y = s.yMm * pxPerMm;
    const w = s.wMm * pxPerMm;
    const h = s.hMm * pxPerMm;

    if (s.cardCanvas) {
      // Clip card inside its box so inside-box slide/zoom stays crisp inside borders
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();

      const drawW = w * s.innerScale;
      const drawH = h * s.innerScale;
      const drawX = x + (w - drawW) / 2 + s.innerXMm * pxPerMm;
      const drawY = y + (h - drawH) / 2 + s.innerYMm * pxPerMm;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(s.cardCanvas, drawX, drawY, drawW, drawH);
      ctx.restore();

      if (showBorder) {
        ctx.strokeStyle = cpState.borderColor;
        ctx.lineWidth = strokeW;
        ctx.strokeRect(x, y, w, h);
      }
    } else if (!isExport300Dpi) {
      ctx.save();
      ctx.strokeStyle = i === cpState.activeSlot ? '#8b5cf6' : '#94a3b8';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      if (s.cardMode === 'joint') {
        ctx.beginPath();
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w / 2, y + h);
        ctx.stroke();
      }
      ctx.fillStyle = '#64748b';
      ctx.font = `bold ${Math.round(3.6 * pxPerMm)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        `CARD ${i + 1} (${(s.wMm / 10).toFixed(2)}×${(s.hMm / 10).toFixed(2)} cm)`,
        x + w / 2,
        y + h / 2
      );
      ctx.restore();
    }
  }

  // Highlight active box ONLY when interactMode is 'inside' or 'box' (clean by default!)
  if (!isExport300Dpi && cpState.interactMode !== 'none') {
    const act = cpState.slots[cpState.activeSlot];
    const ax = act.xMm * pxPerMm, ay = act.yMm * pxPerMm;
    const aw = act.wMm * pxPerMm, ah = act.hMm * pxPerMm;

    ctx.save();
    ctx.strokeStyle = cpState.interactMode === 'inside' ? '#38bdf8' : '#3b82f6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(ax, ay, aw, ah);
    ctx.setLineDash([]);

    if (cpState.interactMode === 'box') {
      getA4HandlePositionsMm(act).forEach((hp, idx) => {
        const hx = hp.x * pxPerMm;
        const hy = hp.y * pxPerMm;
        ctx.beginPath();
        if (idx < 4) {
          ctx.arc(hx, hy, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = '#8b5cf6';
        } else {
          ctx.rect(hx - 4.5, hy - 4.5, 9, 9);
          ctx.fillStyle = '#10b981';
        }
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      });
    }
    ctx.restore();
  }
}

function renderCardPrintA4() {
  drawCardPrintA4ToCanvas(document.getElementById('cpA4PreviewCanvas'), false);
}

function createCardPrint300DpiCanvas() {
  const hi = document.createElement('canvas');
  hi.width = 2480;
  hi.height = 3508;
  drawCardPrintA4ToCanvas(hi, true);
  return hi;
}

function checkCardPrintReady() {
  const anyFilled = cpState.slots.slice(0, cpState.cardCount).some(s => !!s.cardCanvas);
  if (!anyFilled) {
    alert('Please upload at least one e-Aadhaar PDF or image first.');
    return false;
  }
  return true;
}

function printCardPrintA4() {
  if (!checkCardPrintReady()) return;
  const hi = createCardPrint300DpiCanvas();
  const data = hi.toDataURL('image/png');
  hi.width = 0; hi.height = 0;
  triggerPrint([data]);
}

function downloadCardPrintJPG() {
  if (!checkCardPrintReady()) return;
  const hi = createCardPrint300DpiCanvas();
  const dataUrl = hi.toDataURL('image/jpeg', 0.96);
  hi.width = 0; hi.height = 0;

  const bin = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF && bytes[3] === 0xE0 &&
      bytes[6] === 0x4A && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
    bytes[13] = 1;
    bytes[14] = 0x01; bytes[15] = 0x2C;
    bytes[16] = 0x01; bytes[17] = 0x2C;
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `Aadhaar-CardPrint-300DPI-${Date.now()}.jpg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function downloadCardPrintPDF() {
  if (!checkCardPrintReady()) return;
  try {
    const jsPDF = await ensureJsPDF();
    setProgress(false);
    if (!jsPDF) { alert('PDF library not loaded.'); return; }
    const hi = createCardPrint300DpiCanvas();
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    pdf.addImage(hi.toDataURL('image/jpeg', 0.96), 'JPEG', 0, 0, 210, 297);
    hi.width = 0; hi.height = 0;
    pdf.save(`Aadhaar-CardPrint-300DPI-${Date.now()}.pdf`);
  } catch {
    setProgress(false);
    alert('Could not load PDF engine.');
  }
}

async function addCardPrintToMultiPage() {
  if (!checkCardPrintReady()) return;
  const hi = createCardPrint300DpiCanvas();
  await addSheetCanvasToMultiPage(hi, 'Card Print');
  hi.width = 0; hi.height = 0;
}

syncSlotPanelUI();
renderCardPrintA4();