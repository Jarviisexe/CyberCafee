// e-Aadhaar Joint Card Print Engine
// Single side = 8.56 x 5.40 cm (3.37" x 2.13") | Joint Front+Back = 17.12 x 5.40 cm @ 300 DPI
const CP_SINGLE_W_MM = 85.6;
const CP_JOINT_W_MM = 171.2;
const CP_CARD_H_MM = 54.0;

const cpState = {
  pdfBuffer: null,
  pdfDoc: null,
  pageImg: null,
  cardCanvas: null,
  corners: null,
  cardMode: 'joint', // 'joint' (17.12 x 5.4 cm) | 'single' (8.56 x 5.4 cm)
  borderColor: '#000000',
  pendingPdfResolve: null
};

const cpZone = document.getElementById('cpDropZone');
const cpInput = document.getElementById('cpFileInput');

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
        return;
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
  cpState.pageImg = img;

  await extractBottomJointCard(img);
  setProgress(false);
}

// Auto-detect ONLY the bottom joint card (Front + Back together, ignoring top letter)
function detectBottomJointCorners(img) {
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

  // 1. Find the clean horizontal gap/cut-line separating top letter & bottom joint card (50% to 72% height)
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

  // 2. Find tight bounding box across FULL width below splitY
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
  // Valid joint strip ratio (~3.17) or single card ratio (~1.58)
  const isValidRatio = cpState.cardMode === 'joint'
    ? (ratio >= 2.2 && ratio <= 4.1)
    : (ratio >= 1.15 && ratio <= 2.2);

  if (isValidRatio) {
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
  }

  // Fallback UIDAI e-Aadhaar standard bottom joint strip coordinates
  return [
    { x: img.width * 0.048, y: img.height * 0.638 },
    { x: img.width * 0.952, y: img.height * 0.638 },
    { x: img.width * 0.952, y: img.height * 0.912 },
    { x: img.width * 0.048, y: img.height * 0.912 }
  ];
}

async function extractBottomJointCard(img) {
  const corners = detectBottomJointCorners(img);
  cpState.corners = corners;
  const targetW = cpState.cardMode === 'single' ? 1011 : 2022;
  cpState.cardCanvas = await warpPerspectiveAsync(img, corners, targetW, 638);
  updateCardPrintSlotUI();
  renderCardPrintA4();
  showToast('Bottom joint card extracted at 300 DPI!');
}

async function reAutoDetectBottomCard() {
  if (!cpState.pageImg) { alert('Please upload an e-Aadhaar PDF or image first.'); return; }
  setProgress(true, 'Re-detecting bottom card...', 60);
  await extractBottomJointCard(cpState.pageImg);
  setProgress(false);
}

function updateCardPrintSlotUI() {
  const preview = document.getElementById('cpCardPreview');
  const status = document.getElementById('cpCardStatus');
  const c = cpState.cardCanvas;

  if (c) {
    preview.innerHTML = `<img src="${c.toDataURL('image/jpeg', 0.8)}" alt="Joint Card" />`;
    status.innerText = cpState.cardMode === 'single' ? '8.56×5.4 cm' : '17.12×5.4 cm (Joint)';
    status.style.color = '#34d399';
  } else {
    preview.innerHTML = 'No Card Loaded';
    status.innerText = 'Empty';
    status.style.color = '#94a3b8';
  }
}

function openCardPrintCrop() {
  if (!cpState.pageImg) {
    cpInput.click();
    return;
  }
  openCropModal(
    { mode: 'cardprint', cardMode: cpState.cardMode },
    cpState.pageImg,
    false,
    cpState.corners
  );
}

window.onCardPrintCropDone = async function (warped, savedCorners) {
  if (cpState.cardCanvas) { cpState.cardCanvas.width = 0; cpState.cardCanvas.height = 0; }
  cpState.corners = savedCorners;
  cpState.cardCanvas = warped;
  updateCardPrintSlotUI();
  renderCardPrintA4();
};

function rotateCardPrint() {
  const src = cpState.cardCanvas;
  if (!src) return;
  const off = document.createElement('canvas');
  off.width = src.height; off.height = src.width;
  const octx = off.getContext('2d');
  octx.translate(off.width / 2, off.height / 2);
  octx.rotate(Math.PI / 2);
  octx.drawImage(src, -src.width / 2, -src.height / 2);
  src.width = 0; src.height = 0;
  cpState.cardCanvas = off;
  updateCardPrintSlotUI();
  renderCardPrintA4();
}

function clearCardPrint() {
  if (cpState.cardCanvas) { cpState.cardCanvas.width = 0; cpState.cardCanvas.height = 0; }
  cpState.pdfBuffer = null;
  cpState.pdfDoc = null;
  cpState.pageImg = null;
  cpState.cardCanvas = null;
  cpState.corners = null;

  document.getElementById('cpFileMeta').classList.remove('show');
  document.getElementById('cpClearBtn').style.display = 'none';
  updateCardPrintSlotUI();
  renderCardPrintA4();
}

function setCpCardMode(mode, btn) {
  cpState.cardMode = mode;
  document.querySelectorAll('[data-cpmode]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  updateCardPrintSlotUI();
  updateCpPreviewMeta();
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

function updateCpPreviewMeta() {
  const leftMm = document.getElementById('cpLeftMarginSlider').value;
  const sizeLabel = cpState.cardMode === 'single'
    ? '8.56 × 5.40 cm (Single)'
    : '17.12 × 5.40 cm (8.56×5.4 cm/side)';
  document.getElementById('cpPreviewMeta').innerText = `${sizeLabel} • 300 DPI • Left: ${leftMm}mm`;
}

function onCpMarginSlide() {
  const leftMm = document.getElementById('cpLeftMarginSlider').value;
  const topMm = document.getElementById('cpTopMarginSlider').value;
  document.getElementById('cpLeftMarginVal').innerText = leftMm + 'mm';
  document.getElementById('cpTopMarginVal').innerText = topMm + 'mm';
  updateCpPreviewMeta();
  renderCardPrintA4();
}

function drawCardPrintA4ToCanvas(canvas, isExport300Dpi = false) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pxPerMm = W / 210;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const cardW = (cpState.cardMode === 'single' ? CP_SINGLE_W_MM : CP_JOINT_W_MM) * pxPerMm;
  const cardH = CP_CARD_H_MM * pxPerMm;

  const leftMm = Number(document.getElementById('cpLeftMarginSlider').value);
  const topMm = Number(document.getElementById('cpTopMarginSlider').value);

  const showBorder = document.getElementById('cpBorderCheck').checked;
  const strokePxBase = Number(document.getElementById('cpBorderWidthSlider').value);
  const strokeW = Math.max(1, strokePxBase * (W / 2480));

  const x = leftMm * pxPerMm;
  const y = topMm * pxPerMm;

  if (cpState.cardCanvas) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cpState.cardCanvas, x, y, cardW, cardH);
    if (showBorder) {
      ctx.strokeStyle = cpState.borderColor;
      ctx.lineWidth = strokeW;
      ctx.strokeRect(x, y, cardW, cardH);
    }
  } else if (!isExport300Dpi) {
    ctx.save();
    ctx.strokeStyle = '#94a3b8';
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, cardW, cardH);
    if (cpState.cardMode === 'joint') {
      ctx.beginPath();
      ctx.moveTo(x + cardW / 2, y);
      ctx.lineTo(x + cardW / 2, y + cardH);
      ctx.stroke();
    }
    ctx.fillStyle = '#64748b';
    ctx.font = `bold ${Math.round(3.8 * pxPerMm)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      cpState.cardMode === 'single' ? 'CARD (8.56 × 5.40 cm)' : 'JOINT FRONT + BACK (17.12 × 5.40 cm)',
      x + cardW / 2,
      y + cardH / 2
    );
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
  if (!cpState.cardCanvas) {
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
  link.download = `Aadhaar-JointCard-300DPI-${Date.now()}.jpg`;
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
    pdf.save(`Aadhaar-JointCard-300DPI-${Date.now()}.pdf`);
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
