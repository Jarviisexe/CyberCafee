const multiZone = document.getElementById('multiDropZone');
const multiInput = document.getElementById('multiFileInput');

multiZone.addEventListener('click', () => multiInput.click());
multiInput.addEventListener('change', (e) => {
  if (e.target.files?.length) {
    handleMultiFiles(Array.from(e.target.files));
    multiInput.value = '';
  }
});
multiZone.addEventListener('dragover', (e) => { e.preventDefault(); multiZone.classList.add('dragover'); });
multiZone.addEventListener('dragleave', () => multiZone.classList.remove('dragover'));
multiZone.addEventListener('drop', (e) => {
  e.preventDefault();
  multiZone.classList.remove('dragover');
  if (e.dataTransfer.files?.length) handleMultiFiles(Array.from(e.dataTransfer.files));
});

async function handleMultiFiles(files) {
  const imageFiles = files.filter(f => f.type.startsWith('image/'));
  if (!imageFiles.length) return;

  const available = MAX_PAGES - state.docs.length;
  if (available <= 0) { alert(`Max ${MAX_PAGES} pages reached.`); return; }
  const batch = imageFiles.slice(0, available);
  if (imageFiles.length > available) alert(`Only ${available} more pages allowed (Max ${MAX_PAGES}).`);

  const autoCrop = document.getElementById('multiAutoCropCheck').checked;
  setProgress(true, `Processing 0 / ${batch.length}...`, 0);

  for (let i = 0; i < batch.length; i++) {
    setProgress(true, `Processing ${i + 1} / ${batch.length}...`, Math.round(((i + 1) / batch.length) * 100));
    await nextFrame();

    const img = await fileToResizedImage(batch[i], 1350);
    const rawCanvas = document.createElement('canvas');
    rawCanvas.width = img.width; rawCanvas.height = img.height;
    rawCanvas.getContext('2d').drawImage(img, 0, 0);
    const rawBlob = await canvasToBlob(rawCanvas, 'image/jpeg', 0.91);

    let corners = getDefaultCorners(img, 0);
    let warpedCanvas = rawCanvas;
    if (autoCrop) {
      const det = await detectCardCornersAsync(img);
      if (det) {
        corners = det.corners;
        warpedCanvas = await warpPerspectiveAsync(img, corners);
        rawCanvas.width = 0; rawCanvas.height = 0;
      }
    }

    const warpedBlob = warpedCanvas === rawCanvas ? rawBlob : await canvasToBlob(warpedCanvas, 'image/jpeg', 0.91);
    const cleanCanvas = await applyScanFilterAsync(warpedCanvas, state.multiFilter, 1.15);
    const cleanBlob = await canvasToBlob(cleanCanvas, 'image/jpeg', 0.89);
    const thumbUrl = await createThumbUrlFromCanvas(cleanCanvas, 220);

    warpedCanvas.width = 0; warpedCanvas.height = 0;
    cleanCanvas.width = 0; cleanCanvas.height = 0;

    state.docs.push({
      id: Date.now() + Math.random(),
      rawBlob,
      warpedBlob,
      cleanBlob,
      thumbUrl,
      corners,
      isAadhaarSheet: false
    });
  }

  setProgress(false);
  renderMultiGrid();
  showToast(`Added ${batch.length} page(s)`);
}
window.handleMultiFiles = handleMultiFiles;

async function setMultiFilter(mode, btn) {
  state.multiFilter = mode;
  document.querySelectorAll('[data-mfilter]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  if (!state.docs.length) return;
  setProgress(true, `Applying filter 0 / ${state.docs.length}...`, 0);
  for (let i = 0; i < state.docs.length; i++) {
    const doc = state.docs[i];
    if (!doc.isAadhaarSheet) {
      const img = await blobToImage(doc.warpedBlob);
      const wc = document.createElement('canvas');
      wc.width = img.width; wc.height = img.height;
      wc.getContext('2d').drawImage(img, 0, 0);
      const clean = await applyScanFilterAsync(wc, state.multiFilter, 1.15);
      doc.cleanBlob = await canvasToBlob(clean, 'image/jpeg', 0.89);
      URL.revokeObjectURL(doc.thumbUrl);
      doc.thumbUrl = await createThumbUrlFromCanvas(clean, 220);
      wc.width = 0; wc.height = 0;
      clean.width = 0; clean.height = 0;
    }
    setProgress(true, `Applying filter ${i + 1} / ${state.docs.length}...`, Math.round(((i + 1) / state.docs.length) * 100));
    await nextFrame();
  }
  setProgress(false);
  renderMultiGrid();
}

function renderMultiGrid() {
  document.getElementById('pageCountBadge').innerText = `${state.docs.length}/50`;
  const grid = document.getElementById('pagesGrid');

  if (!state.docs.length) {
    grid.innerHTML = `<div class="empty-state">No pages added yet. Upload documents or add sheets from Aadhaar / Passport tabs.</div>`;
    return;
  }

  grid.innerHTML = state.docs.map((doc, idx) => `
    <div class="page-card">
      <div class="page-top">
        <span>Page ${idx + 1} ${doc.isAadhaarSheet ? '• ' + (doc.sheetTag || 'Aadhaar') : ''}</span>
      </div>
      <div class="page-thumb-box">
        <img src="${doc.thumbUrl}" alt="Page ${idx + 1}" />
      </div>
      <div class="page-tools">
        <button class="mini-btn" title="Crop" onclick="openMultiCrop(${idx})" ${doc.isAadhaarSheet ? 'disabled' : ''}>✂️</button>
        <button class="mini-btn" title="Rotate 90°" onclick="rotateMultiPage(${idx})">↻</button>
        <button class="mini-btn" title="Left" onclick="moveMultiPage(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>←</button>
        <button class="mini-btn" title="Right" onclick="moveMultiPage(${idx}, 1)" ${idx === state.docs.length - 1 ? 'disabled' : ''}>→</button>
        <button class="mini-btn danger" title="Delete" onclick="deleteMultiPage(${idx})">✕</button>
      </div>
    </div>
  `).join('');
}
window.renderMultiGrid = renderMultiGrid;

async function openMultiCrop(idx) {
  const img = await blobToImage(state.docs[idx].rawBlob);
  openCropModal({ mode: 'multi', index: idx }, img, false);
}

window.onMultiCropDone = async function (idx, warped, savedCorners) {
  const doc = state.docs[idx];
  doc.corners = savedCorners;
  doc.warpedBlob = await canvasToBlob(warped, 'image/jpeg', 0.91);
  const clean = await applyScanFilterAsync(warped, state.multiFilter, 1.15);
  doc.cleanBlob = await canvasToBlob(clean, 'image/jpeg', 0.89);
  URL.revokeObjectURL(doc.thumbUrl);
  doc.thumbUrl = await createThumbUrlFromCanvas(clean, 220);
  warped.width = 0; warped.height = 0;
  clean.width = 0; clean.height = 0;
  renderMultiGrid();
};

async function rotateMultiPage(idx) {
  const doc = state.docs[idx];
  const rotateBlob = async (blob, quality) => {
    const img = await blobToImage(blob);
    const off = document.createElement('canvas');
    off.width = img.height; off.height = img.width;
    const octx = off.getContext('2d');
    octx.translate(off.width / 2, off.height / 2);
    octx.rotate(Math.PI / 2);
    octx.drawImage(img, -img.width / 2, -img.height / 2);
    const outBlob = await canvasToBlob(off, 'image/jpeg', quality);
    return { canvas: off, blob: outBlob };
  };

  const rRaw = await rotateBlob(doc.rawBlob, 0.91);
  rRaw.canvas.width = 0; rRaw.canvas.height = 0;
  doc.rawBlob = rRaw.blob;

  const rWarp = await rotateBlob(doc.warpedBlob, 0.91);
  rWarp.canvas.width = 0; rWarp.canvas.height = 0;
  doc.warpedBlob = rWarp.blob;

  const rClean = await rotateBlob(doc.cleanBlob, 0.89);
  doc.cleanBlob = rClean.blob;
  URL.revokeObjectURL(doc.thumbUrl);
  doc.thumbUrl = await createThumbUrlFromCanvas(rClean.canvas, 220);
  rClean.canvas.width = 0; rClean.canvas.height = 0;

  doc.corners = null;
  renderMultiGrid();
}

function moveMultiPage(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= state.docs.length) return;
  [state.docs[idx], state.docs[newIdx]] = [state.docs[newIdx], state.docs[idx]];
  renderMultiGrid();
}

function deleteMultiPage(idx) {
  const [removed] = state.docs.splice(idx, 1);
  if (removed?.thumbUrl) URL.revokeObjectURL(removed.thumbUrl);
  renderMultiGrid();
}

function clearAllDocs() {
  if (!state.docs.length) return;
  if (confirm('Clear all pages?')) {
    state.docs.forEach(d => { if (d.thumbUrl) URL.revokeObjectURL(d.thumbUrl); });
    state.docs = [];
    renderMultiGrid();
  }
}

async function renderDocToA4Canvas(doc) {
  const img = await blobToImage(doc.cleanBlob);
  const canvas = document.createElement('canvas');
  canvas.width = 1654; canvas.height = 2339;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const marginMm = doc.isAadhaarSheet ? 0 : Number(document.getElementById('multiMarginSelect').value);
  const marginPx = marginMm * (canvas.width / 210);
  const maxW = canvas.width - 2 * marginPx;
  const maxH = canvas.height - 2 * marginPx;
  const scale = Math.min(maxW / img.width, maxH / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  return canvas;
}

async function printMultiPages() {
  if (!state.docs.length) { alert('No pages to print.'); return; }
  setProgress(true, `Preparing ${state.docs.length} pages...`, 0);
  const pages = [];
  for (let i = 0; i < state.docs.length; i++) {
    const c = await renderDocToA4Canvas(state.docs[i]);
    pages.push(c.toDataURL('image/jpeg', 0.92));
    c.width = 0; c.height = 0;
    setProgress(true, `Preparing ${i + 1} / ${state.docs.length}...`, Math.round(((i + 1) / state.docs.length) * 100));
    await nextFrame();
  }
  setProgress(false);
  triggerPrint(pages);
}

async function downloadMultiPDF() {
  if (!state.docs.length) { alert('No pages to export.'); return; }
  try {
    const jsPDF = await ensureJsPDF();
    if (!jsPDF) { setProgress(false); alert('PDF engine not loaded.'); return; }
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    setProgress(true, `Building PDF 0 / ${state.docs.length}...`, 0);

    for (let i = 0; i < state.docs.length; i++) {
      if (i > 0) pdf.addPage('a4', 'portrait');
      const c = await renderDocToA4Canvas(state.docs[i]);
      pdf.addImage(c.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, 210, 297);
      c.width = 0; c.height = 0;
      setProgress(true, `Building PDF ${i + 1} / ${state.docs.length}...`, Math.round(((i + 1) / state.docs.length) * 100));
      await nextFrame();
    }
    setProgress(false);
    pdf.save(`A4-Combined-${state.docs.length}-Pages.pdf`);
  } catch {
    setProgress(false);
    alert('Could not load PDF engine.');
  }
}

async function downloadMultiJPGs() {
  if (!state.docs.length) { alert('No pages to export.'); return; }
  if (state.docs.length === 1) {
    const c = await renderDocToA4Canvas(state.docs[0]);
    const b = await canvasToBlob(c, 'image/jpeg', 0.94);
    c.width = 0; c.height = 0;
    const url = URL.createObjectURL(b);
    const link = document.createElement('a');
    link.download = `A4-Page-1.jpg`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return;
  }

  try {
    const JSZipLib = await ensureJSZip();
    const zip = new JSZipLib();
    setProgress(true, `Packing JPGs 0 / ${state.docs.length}...`, 0);
    for (let i = 0; i < state.docs.length; i++) {
      const c = await renderDocToA4Canvas(state.docs[i]);
      const b = await canvasToBlob(c, 'image/jpeg', 0.92);
      c.width = 0; c.height = 0;
      zip.file(`Page-${String(i + 1).padStart(2, '0')}.jpg`, b);
      setProgress(true, `Packing JPGs ${i + 1} / ${state.docs.length}...`, Math.round(((i + 1) / state.docs.length) * 100));
      await nextFrame();
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    setProgress(false);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `A4-Pages-${state.docs.length}.zip`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch {
    setProgress(false);
    alert('Could not load ZIP engine.');
  }
}
