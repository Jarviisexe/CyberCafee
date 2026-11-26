const CARD_WIDTH_MM = { small: 86, medium: 110, large: 135 };

const aadhaarZone = document.getElementById('aadhaarDropZone');
const aadhaarInput = document.getElementById('aadhaarFileInput');

aadhaarZone.addEventListener('click', () => aadhaarInput.click());
aadhaarInput.addEventListener('change', (e) => {
  if (e.target.files?.length) {
    handleAadhaarFiles(Array.from(e.target.files));
    aadhaarInput.value = '';
  }
});
aadhaarZone.addEventListener('dragover', (e) => { e.preventDefault(); aadhaarZone.classList.add('dragover'); });
aadhaarZone.addEventListener('dragleave', () => aadhaarZone.classList.remove('dragover'));
aadhaarZone.addEventListener('drop', (e) => {
  e.preventDefault();
  aadhaarZone.classList.remove('dragover');
  if (e.dataTransfer.files?.length) handleAadhaarFiles(Array.from(e.dataTransfer.files));
});

function setNextTarget(side) {
  state.nextTarget = side;
  document.getElementById('frontSlotCard').classList.toggle('targeted', side === 'front');
  document.getElementById('backSlotCard').classList.toggle('targeted', side === 'back');
  document.getElementById('nextSlotBadge').innerText =
    side === 'front' ? 'Next Target: FRONT' : 'Next Target: BACK';
}

async function handleAadhaarFiles(files) {
  const imgs = files.filter(f => f.type.startsWith('image/')).slice(0, 2);
  for (const file of imgs) {
    const target = state.nextTarget;
    setNextTarget(target === 'front' ? 'back' : 'front');
    const img = await fileToResizedImage(file, 1400);
    state[target].rawImg = img;

    const autoSet = document.getElementById('autoSetCheck').checked;
    if (autoSet) {
      const det = await detectCardCornersAsync(img);
      const corners = det ? det.corners : getDefaultCorners(img, 0.02);
      state[target].corners = corners;
      state[target].warpedCanvas = await warpPerspectiveAsync(img, corners);
      await processAadhaarSide(target);
      renderA4();
      showToast(`${target.toUpperCase()} added`);
    } else {
      openCropModal({ mode: 'aadhaar', side: target }, img, true);
    }
  }
}
window.handleAadhaarFiles = handleAadhaarFiles;

function swapAadhaarSides() {
  [state.front, state.back] = [state.back, state.front];
  updateAadhaarSlotUI('front');
  updateAadhaarSlotUI('back');
  renderA4();
}

function clearAadhaarSide(side) {
  state[side] = { rawImg: null, warpedCanvas: null, cleanCanvas: null, corners: null };
  updateAadhaarSlotUI(side);
  setNextTarget(side);
  renderA4();
}

function clearAllAadhaar() {
  state.front = { rawImg: null, warpedCanvas: null, cleanCanvas: null, corners: null };
  state.back = { rawImg: null, warpedCanvas: null, cleanCanvas: null, corners: null };
  updateAadhaarSlotUI('front');
  updateAadhaarSlotUI('back');
  setNextTarget('front');
  renderA4();
}

function rotateAadhaar(side) {
  if (!state[side].rawImg) return;
  const img = state[side].rawImg;
  const off = document.createElement('canvas');
  off.width = img.height; off.height = img.width;
  const octx = off.getContext('2d');
  octx.translate(off.width / 2, off.height / 2);
  octx.rotate(Math.PI / 2);
  octx.drawImage(img, -img.width / 2, -img.height / 2);

  off.toBlob(async (blob) => {
    off.width = 0; off.height = 0;
    const rot = await blobToImage(blob);
    state[side].rawImg = rot;
    if (state[side].corners) {
      state[side].corners = orderQuad(state[side].corners.map(p => ({ x: img.height - p.y, y: p.x })));
    } else {
      const det = await detectCardCornersAsync(rot);
      state[side].corners = det ? det.corners : getDefaultCorners(rot, 0.02);
    }
    state[side].warpedCanvas = await warpPerspectiveAsync(rot, state[side].corners);
    await processAadhaarSide(side);
    renderA4();
  }, 'image/jpeg', 0.93);
}

function updateAadhaarSlotUI(side) {
  const box = document.getElementById(side + 'PreviewBox');
  const st = document.getElementById(side + 'Status');
  if (state[side].cleanCanvas) {
    box.innerHTML = `<img src="${state[side].cleanCanvas.toDataURL('image/jpeg', 0.72)}" alt="${side}" />`;
    st.innerText = 'Ready';
    st.style.color = '#059669';
  } else {
    box.innerHTML = 'No Image';
    st.innerText = 'Empty';
    st.style.color = '#64748b';
  }
}

function openRecropAadhaar(side) {
  if (!state[side].rawImg) {
    setNextTarget(side);
    aadhaarInput.click();
    return;
  }
  openCropModal({ mode: 'aadhaar', side }, state[side].rawImg, false);
}

function setAadhaarFilter(mode, btn) {
  state.filter = mode;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  reprocessAllAadhaar();
}

let _contrastTimer = null;
function onContrastSlide() {
  document.getElementById('contrastVal').innerText = document.getElementById('contrastSlider').value + '%';
  clearTimeout(_contrastTimer);
  _contrastTimer = setTimeout(reprocessAllAadhaar, 75);
}

async function reprocessAllAadhaar() {
  if (state.front.warpedCanvas) await processAadhaarSide('front');
  if (state.back.warpedCanvas) await processAadhaarSide('back');
  renderA4();
}

async function processAadhaarSide(side) {
  const warped = state[side].warpedCanvas;
  if (!warped) return;
  const contrast = Number(document.getElementById('contrastSlider').value) / 100;
  state[side].cleanCanvas = await applyScanFilterAsync(warped, state.filter, contrast);
  updateAadhaarSlotUI(side);
}
window.processAadhaarSide = processAadhaarSide;

function setSize(sizeKey, btn) {
  state.size = sizeKey;
  document.querySelectorAll('[data-size]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderA4();
}

let _a4Raf = false;
function scheduleA4Render() {
  if (_a4Raf) return;
  _a4Raf = true;
  requestAnimationFrame(() => { _a4Raf = false; renderA4(); });
}

function getCardDimsMm(canvas, targetWidthMm) {
  if (!canvas) return { w: targetWidthMm, h: targetWidthMm * 0.63 };
  let wMm = targetWidthMm;
  let hMm = wMm * (canvas.height / canvas.width);
  if (hMm > 118) { hMm = 118; wMm = hMm * (canvas.width / canvas.height); }
  return { w: wMm, h: hMm };
}

function drawAadhaarA4ToCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const pxPerMm = W / 210;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const targetW = CARD_WIDTH_MM[state.size];
  const fDims = getCardDimsMm(state.front.cleanCanvas, targetW);
  const bDims = getCardDimsMm(state.back.cleanCanvas, targetW);

  let topMarginMm = Number(document.getElementById('topMarginSlider').value);
  let gapMm = Number(document.getElementById('gapSlider').value);
  const showBorder = document.getElementById('borderCheck').checked;

  const totalH = topMarginMm + fDims.h + gapMm + bDims.h;
  if (totalH > 285) {
    const overflow = totalH - 285;
    topMarginMm = Math.max(8, topMarginMm - overflow * 0.6);
    gapMm = Math.max(6, gapMm - overflow * 0.4);
  }

  const frontY = topMarginMm * pxPerMm;
  const backY = (topMarginMm + fDims.h + gapMm) * pxPerMm;

  const drawCard = (c, dims, y, label) => {
    const cardW = dims.w * pxPerMm;
    const cardH = dims.h * pxPerMm;
    const cardX = (W - cardW) / 2;

    if (c) {
      ctx.drawImage(c, cardX, y, cardW, cardH);
      if (showBorder) {
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = Math.max(1, 0.35 * pxPerMm);
        ctx.strokeRect(cardX, y, cardW, cardH);
      }
    } else if (canvas.id === 'a4PreviewCanvas') {
      ctx.save();
      ctx.strokeStyle = '#cbd5e1';
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(cardX, y, cardW, cardH);
      ctx.fillStyle = '#94a3b8';
      ctx.font = `bold ${Math.round(5 * pxPerMm)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cardX + cardW / 2, y + cardH / 2);
      ctx.restore();
    }
  };

  drawCard(state.front.cleanCanvas, fDims, frontY, 'FRONT');
  drawCard(state.back.cleanCanvas, bDims, backY, 'BACK');
}

function renderA4() {
  drawAadhaarA4ToCanvas(document.getElementById('a4PreviewCanvas'));
}
window.renderA4 = renderA4;

function createAadhaarPrintCanvas() {
  const hi = document.createElement('canvas');
  hi.width = 1654; hi.height = 2339;
  drawAadhaarA4ToCanvas(hi);
  return hi;
}

function checkAadhaarReady() {
  if (!state.front.cleanCanvas && !state.back.cleanCanvas) {
    alert('Please upload Front or Back image first.');
    return false;
  }
  return true;
}

function printAadhaar() {
  if (!checkAadhaarReady()) return;
  const c = createAadhaarPrintCanvas();
  const data = c.toDataURL('image/png');
  c.width = 0; c.height = 0;
  triggerPrint([data]);
}

function downloadAadhaarJPG() {
  if (!checkAadhaarReady()) return;
  const c = createAadhaarPrintCanvas();
  c.toBlob((blob) => {
    c.width = 0; c.height = 0;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `Aadhaar-A4-${Date.now()}.jpg`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }, 'image/jpeg', 0.94);
}

async function downloadAadhaarPDF() {
  if (!checkAadhaarReady()) return;
  try {
    const jsPDF = await ensureJsPDF();
    setProgress(false);
    if (!jsPDF) { alert('PDF engine failed to load.'); return; }
    const c = createAadhaarPrintCanvas();
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.addImage(c.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, 210, 297);
    c.width = 0; c.height = 0;
    doc.save(`Aadhaar-A4-${Date.now()}.pdf`);
  } catch {
    setProgress(false);
    alert('Could not load PDF engine. Use Print -> Save as PDF.');
  }
}

async function addAadhaarToMultiPage() {
  if (!checkAadhaarReady()) return;
  const c = createAadhaarPrintCanvas();
  await addSheetCanvasToMultiPage(c, 'Aadhaar');
  c.width = 0; c.height = 0;
}

renderA4();
