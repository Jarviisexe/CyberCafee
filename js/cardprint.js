// e-Aadhaar & PVC Smart Card Print Engine (8.56 cm x 5.4 cm @ 300 DPI)
const CP_CARD_W_MM = 85.6; // 8.56 cm = 3.37 inches
const CP_CARD_H_MM = 54.0; // 5.40 cm = 2.13 inches
const CP_CARD_W_300 = 1011; // 85.6mm @ 300 DPI
const CP_CARD_H_300 = 638;  // 54.0mm @ 300 DPI

const cpState = {
  pdfBuffer: null,
  pdfDoc: null,
  pageImg: null,
  front: { canvas: null, corners: null },
  back:  { canvas: null, corners: null },
  layout: 'row', // 'row' (side-by-side) | 'col' (top-bottom)
  borderColor: '#000000',
  pendingPdfResolve: null
};

const cpZone = document.getElementById('cpDropZone');
const cpInput = document.getElementById('cpFileInput');

cpZone.addEventListener('click', () => cpInput.click());
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

async function handleCardPrintUpload(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImg = file.type.startsWith('image/');
  if (!isPdf && !isImg) {
    alert('Please upload an e-Aadhaar PDF or image file.');
    return;
  }

  document.getElementById('cpFileName').innerText = file.name;
  document.getElementById('cpFileMeta').classList.add('show');
  document.getElementById('cpClearBtn').style.display = 'inline-block';

  if (isPdf) {
    try {
      const pdfLib = await ensurePdfJs();
      if (!pdfLib) throw new Error('PDF reader unavailable');
      setProgress(true, 'Opening PDF...', 30);

      const rawBuf = await file.arrayBuffer();
      cpState.pdfBuffer = rawBuf;

      const pdfDoc = await openPdfWithOptionalPassword(pdfLib, rawBuf);
      if (!pdfDoc) {
        setProgress(false);
        return; // Cancelled by user
      }

      cpState.pdfDoc = pdfDoc;
      document.getElementById('cpFileSub').innerText = `PDF • ${pdfDoc.numPages} Page(s) • 300 DPI`;

      const navWrap = document.getElementById('cpPageNavWrap');
      const pageSel = document.getElementById('cpPageSelect');
      if (pdfDoc.numPages > 1) {
        pageSel.innerHTML = '';
        for (let p = 1; p <= pdfDoc.numPages; p++) {
          pageSel.innerHTML += `<option value="${p}">${p} / ${pdfDoc.numPages}</option>`;
        }
        navWrap.style.display = 'flex';
      } else {
        navWrap.style.display = 'none';
      }

      await loadCardPrintPdfPage(1);
    } catch (err) {
      setProgress(false);
      console.error(err);
      alert('Could not open PDF file.');
    }
  } else {
    setProgress(true, 'Loading image...', 40);
    const img = await fileToResizedImage(file, 2600);
    cpState.pdfDoc = null;
    cpState.pageImg = img;
    document.getElementById('cpPageNavWrap').style.display = 'none';
    document.getElementById('cpFileSub').innerText = `Image • ${img.width}×${img.height}px`;
    await extractBottomCardsFromPageImg(img);
    setProgress(false);
  }
}
window.handleCardPrintUpload = handleCardPrintUpload;

async function openPdfWithOptionalPassword(pdfLib, rawBuf) {
  let password = '';
  while (true) {
    try {
      // Always pass a fresh Uint8Array copy so pdf.js worker never detaches our rawBuf
      const task = pdfLib.getDocument({ data: new Uint8Array(rawBuf.slice(0)), password });
      return await task.promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') {
        setProgress(false);
        const isWrong = err.code === 2;
        const entered = await askPdfPasswordModal(
          isWrong ? 'Wrong password! Please check and try again.' : ''
        );
        if (entered === null) return null; // cancelled
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
    const errEl = document.getElementById('cpPwdError');
    input.value = '';
    input.type = 'password';
    errEl.innerText = errorText;
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
  await loadCardPrintPdfPage(pageNum);
}

async function loadCardPrintPdfPage(pageNum) {
  if (!cpState.pdfDoc) return;
  setProgress(true, `Rendering PDF Page ${pageNum} at 300 DPI...`, 50);

  const page = await cpState.pdfDoc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1.0 });
  // Target ~2480px width (300 DPI on A4)
  const scale = Math.min(4.2, Math.max(2.5, 2480 / vp1.width));
  const vp = page.getViewport({ scale });

  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.round(vp.width);
  pageCanvas.height = Math.round(vp.height);
  const ctx = pageCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  setProgress(true, 'Auto-detecting bottom Aadhaar cards...', 80);
  const blob = await canvasToBlob(pageCanvas, 'image/png');
  pageCanvas.width = 0; pageCanvas.height = 0;
  const img = await blobToImage(blob);
  cpState.pageImg = img;

  await extractBottomCardsFromPageImg(img);
  setProgress(false);
}

// Smart detector: ignores upper letter, detects ONLY bottom Front & Back cards
function detectBottomAadhaarCards(img) {
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

  // 1. Scan lower half (from 50% to 98% height) for the horizontal cut/gap separating letter & bottom cards
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

  // Find lowest strong whitespace band (or cut-line row) between 52% and 70% height
  let splitY = Math.floor(h * 0.61);
  let bestBlankRun = 0, curRun = 0, runEnd = splitY;
  for (let y = yScanStart; y <= yScanEnd; y++) {
    if (rowInk[y] < 0.015) {
      curRun++;
      if (curRun >= bestBlankRun) {
        bestBlankRun = curRun;
        runEnd = y;
      }
    } else {
      curRun = 0;
    }
  }
  if (bestBlankRun >= 4) {
    splitY = runEnd;
  }

  // Helper: find tight content box inside a region, ignoring tiny scissor-dot noise
  const findBox = (x0, x1, y0, y1) => {
    const rw = x1 - x0;
    const rh = y1 - y0;
    let top = -1, bottom = -1, left = -1, right = -1;

    for (let y = y0; y < y1; y++) {
      let count = 0;
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i] < 242 || data[i + 1] < 242 || data[i + 2] < 242) count++;
      }
      if (count > rw * 0.025) {
        if (top === -1) top = y;
        bottom = y;
      }
    }

    if (top === -1 || (bottom - top) < rh * 0.25) return null;

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

    if (left === -1 || (right - left) < rw * 0.35) return null;

    const bw = right - left;
    const bh = bottom - top;
    const ratio = bw / Math.max(1, bh);
    // Validate roughly card-shaped (PVC 85.6:54 = 1.585)
    if (ratio < 1.15 || ratio > 2.2) return null;

    // Slight clean outward padding (1px)
    const lx = Math.max(0, left - 1) / scale;
    const ty = Math.max(0, top - 1) / scale;
    const rx = Math.min(w, right + 2) / scale;
    const by = Math.min(h, bottom + 2) / scale;
    return [
      { x: lx, y: ty },
      { x: rx, y: ty },
      { x: rx, y: by },
      { x: lx, y: by }
    ];
  };

  const yBottomLimit = Math.floor(h * 0.975);
  const midLeftEnd = Math.floor(w * 0.492);
  const midRightStart = Math.floor(w * 0.508);

  let frontCorners = findBox(Math.floor(w * 0.02), midLeftEnd, splitY, yBottomLimit);
  let backCorners = findBox(midRightStart, Math.floor(w * 0.98), splitY, yBottomLimit);

  // Fallback to standard UIDAI e-Aadhaar bottom card coordinates if borders/scan are unusual
  if (!frontCorners) {
    frontCorners = [
      { x: img.width * 0.055, y: img.height * 0.642 },
      { x: img.width * 0.478, y: img.height * 0.642 },
      { x: img.width * 0.478, y: img.height * 0.908 },
      { x: img.width * 0.055, y: img.height * 0.908 }
    ];
  }
  if (!backCorners) {
    backCorners = [
      { x: img.width * 0.522, y: img.height * 0.642 },
      { x: img.width * 0.945, y: img.height * 0.642 },
      { x: img.width * 0.945, y: img.height * 0.908 },
      { x: img.width * 0.522, y: img.height * 0.908 }
    ];
  }

  return { frontCorners, backCorners };
}

async function extractBottomCardsFromPageImg(img) {
  const { frontCorners, backCorners } = detectBottomAadhaarCards(img);
  cpState.front.corners = frontCorners;
  cpState.back.corners = backCorners;

  cpState.front.canvas = await warpPerspectiveAsync(img, frontCorners, CP_CARD_W_300, CP_CARD_H_300);
  cpState.back.canvas = await warpPerspectiveAsync(img, backCorners, CP_CARD_W_300, CP_CARD_H_300);

  updateCardPrintSlotUI('front');
  updateCardPrintSlotUI('back');
  renderCardPrintA4();
  showToast('Bottom Aadhaar cards extracted (8.56×5.4 cm)');
}

async function reAutoDetectBottomCards() {
  if (!cpState.pageImg) { alert('Please upload an e-Aadhaar PDF or image first.'); return; }
  setProgress(true, 'Re-detecting bottom cards...', 60);
  await extractBottomCardsFromPageImg(cpState.pageImg);
  setProgress(false);
}

function updateCardPrintSlotUI(side) {
  const preview = document.getElementById(side === 'front' ? 'cpFrontPreview' : 'cpBackPreview');
  const status = document.getElementById(side === 'front' ? 'cpFrontStatus' : 'cpBackStatus');
  const c = cpState[side].canvas;

  if (c) {
    preview.innerHTML = `<img src="${c.toDataURL('image/jpeg', 0.78)}" alt="${side}" />`;
    status.innerText = '8.56×5.4 cm';
    status.style.color = '#34d399';
  } else {
    preview.innerHTML = 'No Card';
    status.innerText = 'Empty';
    status.style.color = '#94a3b8';
  }
}

function openCardPrintCrop(side) {
  if (!cpState.pageImg) {
    cpInput.click();
    return;
  }
  openCropModal({ mode: 'cardprint', side }, cpState.pageImg, false, cpState[side].corners);
}

window.onCardPrintCropDone = async function (side, warped, savedCorners) {
  if (cpState[side].canvas) { cpState[side].canvas.width = 0; cpState[side].canvas.height = 0; }
  cpState[side].corners = savedCorners;
  cpState[side].canvas = warped;
  updateCardPrintSlotUI(side);
  renderCardPrintA4();
};

function rotateCardPrint(side) {
  const src = cpState[side].canvas;
  if (!src) return;
  const off = document.createElement('canvas');
  off.width = src.height; off.height = src.width;
  const octx = off.getContext('2d');
  octx.translate(off.width / 2, off.height / 2);
  octx.rotate(Math.PI / 2);
  octx.drawImage(src, -src.width / 2, -src.height / 2);
  src.width = 0; src.height = 0;
  cpState[side].canvas = off;
  updateCardPrintSlotUI(side);
  renderCardPrintA4();
}

function swapCardPrintSides() {
  if (!cpState.front.canvas && !cpState.back.canvas) return;
  [cpState.front, cpState.back] = [cpState.back, cpState.front];
  updateCardPrintSlotUI('front');
  updateCardPrintSlotUI('back');
  renderCardPrintA4();
}

function clearCardPrint() {
  if (cpState.front.canvas) { cpState.front.canvas.width = 0; cpState.front.canvas.height = 0; }
  if (cpState.back.canvas) { cpState.back.canvas.width = 0; cpState.back.canvas.height = 0; }
  cpState.pdfBuffer = null;
  cpState.pdfDoc = null;
  cpState.pageImg = null;
  cpState.front = { canvas: null, corners: null };
  cpState.back = { canvas: null, corners: null };

  document.getElementById('cpFileMeta').classList.remove('show');
  document.getElementById('cpClearBtn').style.display = 'none';
  updateCardPrintSlotUI('front');
  updateCardPrintSlotUI('back');
  renderCardPrintA4();
}

function setCpLayout(mode, btn) {
  cpState.layout = mode;
  document.querySelectorAll('[data-cplayout]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderCardPrintA4();
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
  const leftMm = document.getElementById('cpLeftMarginSlider').value;
  const topMm = document.getElementById('cpTopMarginSlider').value;
  const gapMm = document.getElementById('cpGapSlider').value;
  document.getElementById('cpLeftMarginVal').innerText = leftMm + 'mm';
  document.getElementById('cpTopMarginVal').innerText = topMm + 'mm';
  document.getElementById('cpGapVal').innerText = gapMm + 'mm';
  document.getElementById('cpPreviewMeta').innerText =
    `8.56 × 5.40 cm • 300 DPI • Left Offset: ${leftMm}mm`;
  renderCardPrintA4();
}

function drawCardPrintA4ToCanvas(canvas, isExport300Dpi = false) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pxPerMm = W / 210;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const cardW = CP_CARD_W_MM * pxPerMm;
  const cardH = CP_CARD_H_MM * pxPerMm;

  const leftMm = Number(document.getElementById('cpLeftMarginSlider').value);
  const topMm = Number(document.getElementById('cpTopMarginSlider').value);
  const gapMm = Number(document.getElementById('cpGapSlider').value);

  const showFront = document.getElementById('cpShowFrontCheck').checked;
  const showBack = document.getElementById('cpShowBackCheck').checked;
  const showBorder = document.getElementById('cpBorderCheck').checked;
  const strokePxBase = Number(document.getElementById('cpBorderWidthSlider').value);
  const scaleTo300 = W / 2480;
  const strokeW = Math.max(1, strokePxBase * scaleTo300);

  const startX = leftMm * pxPerMm;
  const startY = topMm * pxPerMm;
  const gapPx = gapMm * pxPerMm;

  const items = [];
  if (showFront) items.push({ c: cpState.front.canvas, label: 'FRONT (8.56×5.4cm)' });
  if (showBack) items.push({ c: cpState.back.canvas, label: 'BACK (8.56×5.4cm)' });

  items.forEach((item, idx) => {
    const x = cpState.layout === 'row' ? startX + idx * (cardW + gapPx) : startX;
    const y = cpState.layout === 'row' ? startY : startY + idx * (cardH + gapPx);

    if (item.c) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(item.c, x, y, cardW, cardH);
      if (showBorder) {
        ctx.strokeStyle = cpState.borderColor;
        ctx.lineWidth = strokeW;
        ctx.strokeRect(x, y, cardW, cardH);
      }
    } else if (!isExport300Dpi) {
      ctx.save();
      ctx.strokeStyle = '#94a3b8';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, cardW, cardH);
      ctx.fillStyle = '#64748b';
      ctx.font = `bold ${Math.round(3.6 * pxPerMm)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.label, x + cardW / 2, y + cardH / 2);
      ctx.restore();
    }
  });
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
  if (!cpState.front.canvas && !cpState.back.canvas) {
    alert('Please upload an e-Aadhaar PDF or image first.');
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

  // Inject 300 DPI JFIF metadata
  const bin = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF && bytes[3] === 0xE0 &&
      bytes[6] === 0x4A && bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46) {
    bytes[13] = 1;
    bytes[14] = 0x01; bytes[15] = 0x2C; // 300 X
    bytes[16] = 0x01; bytes[17] = 0x2C; // 300 Y
  }

  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `Aadhaar-Card-Print-300DPI-${Date.now()}.jpg`;
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
    pdf.save(`Aadhaar-Card-Print-300DPI-${Date.now()}.pdf`);
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

renderCardPrintA4();
