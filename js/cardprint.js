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
  interactMode: 'box', // 'box' (default: mouse slide + 4 corner/border resize) | 'inside' | 'none'
  dragMode: null,
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

// ---------------- INTERACT MODE TOGGLES ----------------
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
    meta.innerText = 'Drag card to slide on A4 • Drag corners or borders to resize';
  } else {
    meta.innerText = 'Clean Preview (Handles hidden) • Ready to Print';
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

  setProgress(true, 'Locking onto horizontal dotted cutting line...', 80);
  const blob = await canvasToBlob(pageCanvas, 'image/png');
  pageCanvas.width = 0; pageCanvas.height = 0;
  const img = await blobToImage(blob);
  slot.pageImg = img;

  await extractBottomJointCard(img);
  setProgress(false);
}

// High-Res Detector: Exact Horizontal Dotted Cutting Line = Starting Point (topY)
function detectBottomJointCorners(img) {
  // Already-cropped wide card image directly uploaded
  if (img.width / img.height > 1.75) {
    return {
      foundScissor: false,
      corners: [
        { x: 0, y: 0 },
        { x: img.width, y: 0 },
        { x: img.width, y: img.height },
        { x: 0, y: img.height }
      ]
    };
  }

  // Use 1100px width so thin 1px dotted cutting line stays crisp & never blurs out
  const maxW = 1100;
  const scale = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  c.width = 0; c.height = 0;

  const isInk = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i] < 244 || data[i + 1] < 244 || data[i + 2] < 244;
  };

  // 1. Find exact outer Left & Right borders in lower card zone (y: 74%..91%)
  const yB0 = Math.floor(h * 0.74);
  const yB1 = Math.floor(h * 0.91);
  const yBH = Math.max(1, yB1 - yB0);

  let leftX = Math.floor(w * 0.056);
  for (let x = Math.floor(w * 0.01); x < Math.floor(w * 0.16); x++) {
    let hits = 0;
    for (let y = yB0; y < yB1; y++) if (isInk(x, y)) hits++;
    if (hits > yBH * 0.32) { leftX = x; break; }
  }

  let rightX = Math.floor(w * 0.944);
  for (let x = Math.floor(w * 0.99); x > Math.floor(w * 0.84); x--) {
    let hits = 0;
    for (let y = yB0; y < yB1; y++) if (isInk(x, y)) hits++;
    if (hits > yBH * 0.32) { rightX = x; break; }
  }

  // 2. Find exact Bottom border (scan upwards from 98.5% to 84%)
  const xL0 = leftX + Math.floor(w * 0.045);
  const xL1 = Math.floor(w * 0.46);
  const xR0 = Math.floor(w * 0.54);
  const xR1 = rightX - Math.floor(w * 0.045);

  let bottomY = Math.floor(h * 0.94);
  for (let y = Math.floor(h * 0.985); y > Math.floor(h * 0.84); y--) {
    let hits = 0, total = 0;
    for (let x = xL0; x < xL1; x++) { total++; if (isInk(x, y)) hits++; }
    for (let x = xR0; x < xR1; x++) { total++; if (isInk(x, y)) hits++; }
    if (hits > total * 0.15) { bottomY = y; break; }
  }

  // 3. Find Exact Horizontal Dotted Cutting Line (56%..78% height)
  // Both left half AND right half must show regular dashes on the SAME row, with white gap above
  const ySc0 = Math.floor(h * 0.56);
  const ySc1 = Math.floor(h * 0.78);
  const rowStats = [];

  for (let y = ySc0; y <= ySc1; y++) {
    let lHits = 0, lTrans = 0, prevL = false;
    for (let x = xL0; x < xL1; x++) {
      const ink = isInk(x, y);
      if (ink) lHits++;
      if (ink !== prevL) lTrans++;
      prevL = ink;
    }
    let rHits = 0, rTrans = 0, prevR = false;
    for (let x = xR0; x < xR1; x++) {
      const ink = isInk(x, y);
      if (ink) rHits++;
      if (ink !== prevR) rTrans++;
      prevR = ink;
    }

    const lLen = Math.max(1, xL1 - xL0);
    const rLen = Math.max(1, xR1 - xR0);
    rowStats.push({
      y,
      lInk: lHits / lLen,
      rInk: rHits / rLen,
      lTrans,
      rTrans,
      avgInk: (lHits + rHits) / (lLen + rLen)
    });
  }

  let topY = -1;
  let foundScissor = false;
  let bestScore = -1;

  for (let idx = 8; idx < rowStats.length - 6; idx++) {
    const r = rowStats[idx];
    // Horizontal dotted line: dashed transitions on BOTH left & right halves simultaneously
    if (r.lTrans >= 10 && r.rTrans >= 10 &&
        r.lInk >= 0.03 && r.lInk <= 0.78 &&
        r.rInk >= 0.03 && r.rInk <= 0.78) {
      // Clean white band just above the dotted line (idx-9 .. idx-3)
      let aboveSum = 0;
      for (let k = idx - 9; k <= idx - 3; k++) aboveSum += rowStats[k].avgInk;
      const aboveAvg = aboveSum / 7;

      if (aboveAvg < 0.03) {
        const score = (r.lTrans + r.rTrans) + (r.y / h) * 30;
        if (score > bestScore) {
          bestScore = score;
          // Exact horizontal dotted cutting line is the starting point!
          topY = r.y;
          foundScissor = true;
        }
      }
    }
  }

  // Fallback: lowest white gap right above bottom card
  if (topY === -1) {
    let blankRun = 0;
    for (let idx = rowStats.length - 1; idx >= 0; idx--) {
      if (rowStats[idx].avgInk < 0.015) {
        blankRun++;
      } else {
        if (blankRun >= 4 && rowStats[idx].y < h * 0.75) {
          topY = rowStats[idx + blankRun].y;
          break;
        }
        blankRun = 0;
      }
    }
  }

  // Standard UIDAI fallback if PDF was extremely faint/blank
  if (topY === -1 || (bottomY - topY) < h * 0.14 || (bottomY - topY) > h * 0.34) {
    return {
      foundScissor: false,
      corners: [
        { x: img.width * 0.055, y: img.height * 0.721 },
        { x: img.width * 0.945, y: img.height * 0.721 },
        { x: img.width * 0.945, y: img.height * 0.941 },
        { x: img.width * 0.055, y: img.height * 0.941 }
      ]
    };
  }

  const lx = Math.max(0, leftX - 1) / scale;
  const rx = Math.min(w, rightX + 2) / scale;
  const ty = Math.max(0, topY) / scale;
  const by = Math.min(h, bottomY + 2) / scale;

  return {
    foundScissor,
    corners: [
      { x: lx, y: ty },
      { x: rx, y: ty },
      { x: rx, y: by },
      { x: lx, y: by }
    ]
  };
}

async function extractBottomJointCard(img) {
  const slot = cpState.slots[cpState.activeSlot];
  const det = detectBottomJointCorners(img);
  slot.corners = det.corners;
  slot.innerScale = 1.0;
  slot.innerXMm = 0;
  slot.innerYMm = 0;

  const targetW = slot.cardMode === 'single' ? 1011 : 2022;
  if (slot.cardCanvas) { slot.cardCanvas.width = 0; slot.cardCanvas.height = 0; }
  slot.cardCanvas = await warpPerspectiveAsync(img, det.corners, targetW, 638);
  syncSlotPanelUI();
  syncInsideZoomUI();
  renderCardPrintA4();
  showToast(
    det.foundScissor
      ? 'Cropped from horizontal dotted cutting line!'
      : 'Bottom Aadhaar card extracted!'
  );
}

async function reAutoDetectBottomCard() {
  const slot = cpState.slots[cpState.activeSlot];
  if (!slot.pageImg) { alert('Please upload an e-Aadhaar PDF or image first.'); return; }
  setProgress(true, 'Detecting horizontal dotted cutting line...', 60);
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

// ---------------- INTERACTIVE A4 PREVIEW ----------------
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
