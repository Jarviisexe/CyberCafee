const resizeState = {
  fileType: null,
  origFile: null,
  origSize: 0,
  origBaseName: '',
  img: null,
  aspect: 1,
  pdfDoc: null,
  pdfNumPages: 0,
  pdfCurrentPage: 1,
  mode: 'target',
  outputBlob: null,
  outputExt: '.jpg',
  previewImages: []
};

const resizeZone = document.getElementById('resizeDropZone');
const resizeInput = document.getElementById('resizeFileInput');

resizeZone.addEventListener('click', () => resizeInput.click());
resizeInput.addEventListener('change', (e) => {
  if (e.target.files?.[0]) {
    handleResizeUpload(e.target.files[0]);
    resizeInput.value = '';
  }
});
resizeZone.addEventListener('dragover', (e) => { e.preventDefault(); resizeZone.classList.add('dragover'); });
resizeZone.addEventListener('dragleave', () => resizeZone.classList.remove('dragover'));
resizeZone.addEventListener('drop', (e) => {
  e.preventDefault();
  resizeZone.classList.remove('dragover');
  if (e.dataTransfer.files?.[0]) handleResizeUpload(e.dataTransfer.files[0]);
});

function setResizeMode(mode) {
  resizeState.mode = mode;
  document.getElementById('resizeModeTargetBtn').classList.toggle('active', mode === 'target');
  document.getElementById('resizeModeCustomBtn').classList.toggle('active', mode === 'custom');
  document.getElementById('targetSizePanel').style.display = mode === 'target' ? 'block' : 'none';
  document.getElementById('customSizePanel').style.display = mode === 'custom' ? 'block' : 'none';
}

function setTargetPreset(val, unit, btn) {
  document.getElementById('targetSizeVal').value = val;
  document.getElementById('targetSizeUnit').value = unit;
  document.querySelectorAll('#targetSizePanel .pill-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (resizeState.origFile) processResizeFile();
}

function clearPresetHighlight() {
  document.querySelectorAll('#targetSizePanel .pill-btn').forEach(b => b.classList.remove('active'));
}

function onDimChange(changed) {
  if (!document.getElementById('lockAspectCheck').checked || !resizeState.aspect) return;
  const wEl = document.getElementById('resizeWidthInput');
  const hEl = document.getElementById('resizeHeightInput');
  if (changed === 'w' && wEl.value) {
    hEl.value = Math.max(1, Math.round(Number(wEl.value) / resizeState.aspect));
  } else if (changed === 'h' && hEl.value) {
    wEl.value = Math.max(1, Math.round(Number(hEl.value) * resizeState.aspect));
  }
}

function onOutputFormatChange() {
  const fmt = document.getElementById('resizeOutputFormat').value;
  let ext = '.' + fmt;
  if (resizeState.fileType === 'pdf' && fmt === 'jpg' && resizeState.pdfNumPages > 1) ext = '.zip';
  resizeState.outputExt = ext;
  document.getElementById('resizeFileExtBadge').innerText = ext;
  if (resizeState.origFile) processResizeFile();
}

function clearResizeFile() {
  resizeState.previewImages.forEach(c => { c.width = 0; c.height = 0; });
  resizeState.fileType = null;
  resizeState.origFile = null;
  resizeState.origSize = 0;
  resizeState.img = null;
  resizeState.pdfDoc = null;
  resizeState.pdfNumPages = 0;
  resizeState.outputBlob = null;
  resizeState.previewImages = [];

  document.getElementById('resizeFileMeta').classList.remove('show');
  document.getElementById('resizeClearBtn').style.display = 'none';
  document.getElementById('resizeApplyBtn').disabled = true;
  document.getElementById('resizeDownloadBtn').disabled = true;
  document.getElementById('resizeFileNameInput').value = '';
  document.getElementById('statOrigSize').innerText = '—';
  document.getElementById('statNewSize').innerText = '—';
  document.getElementById('statSavedBadge').innerText = '—';
  document.getElementById('resizePreviewInfo').innerText = 'Upload a PDF or JPG to begin';
  document.getElementById('resizePreviewCanvas').style.display = 'none';
  document.getElementById('resizeEmptyState').style.display = 'block';
  document.getElementById('resizePdfNav').classList.remove('show');
}

async function handleResizeUpload(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImg = file.type.startsWith('image/');
  if (!isPdf && !isImg) { alert('Please upload a PDF or JPG/PNG image file.'); return; }

  const baseName = file.name.replace(/\.[^/.]+$/, '') || 'resized-file';
  resizeState.origFile = file;
  resizeState.origSize = file.size;
  resizeState.origBaseName = baseName;
  resizeState.outputBlob = null;

  document.getElementById('resizeFileNameInput').value = baseName + '-resized';
  document.getElementById('resizeMetaName').innerText = file.name;
  document.getElementById('resizeFileMeta').classList.add('show');
  document.getElementById('resizeClearBtn').style.display = 'inline-block';
  document.getElementById('statOrigSize').innerText = formatBytes(file.size);
  document.getElementById('statNewSize').innerText = '—';
  document.getElementById('statSavedBadge').innerText = '—';

  if (isPdf) {
    try {
      const pdfLib = await ensurePdfJs();
      if (!pdfLib) throw new Error('pdfjs unavailable');
      setProgress(true, 'Loading PDF...', 40);
      const buf = await file.arrayBuffer();
      const pdfDoc = await pdfLib.getDocument({ data: buf }).promise;
      resizeState.fileType = 'pdf';
      resizeState.pdfDoc = pdfDoc;
      resizeState.pdfNumPages = pdfDoc.numPages;
      resizeState.pdfCurrentPage = 1;
      resizeState.img = null;

      document.getElementById('resizeTypeBadge').innerText = 'PDF';
      document.getElementById('resizeMetaSub').innerText = `PDF • ${pdfDoc.numPages} Page(s) • ${formatBytes(file.size)}`;
      document.getElementById('imgDimControls').style.display = 'none';
      document.getElementById('pdfScaleControls').style.display = 'block';

      document.getElementById('resizeOutputFormat').innerHTML = `
        <option value="pdf" selected>PDF Document (.pdf)</option>
        <option value="jpg">${pdfDoc.numPages > 1 ? 'JPG Images (.zip)' : 'JPG Image (.jpg)'}</option>
      `;
      resizeState.outputExt = '.pdf';
      document.getElementById('resizeFileExtBadge').innerText = '.pdf';
      document.getElementById('resizeApplyBtn').disabled = false;
      setProgress(false);

      await processResizeFile();
    } catch (err) {
      setProgress(false);
      console.error(err);
      alert('Unable to read this PDF file. Check internet or file integrity.');
    }
  } else {
    const img = await blobToImage(file);
    resizeState.fileType = 'image';
    resizeState.img = img;
    resizeState.aspect = img.width / img.height;
    resizeState.pdfDoc = null;
    resizeState.pdfNumPages = 0;

    document.getElementById('resizeTypeBadge').innerText = 'IMG';
    document.getElementById('resizeMetaSub').innerText = `${img.width} × ${img.height} px • ${formatBytes(file.size)}`;
    document.getElementById('resizeWidthInput').value = img.width;
    document.getElementById('resizeHeightInput').value = img.height;
    document.getElementById('imgDimControls').style.display = 'block';
    document.getElementById('pdfScaleControls').style.display = 'none';

    document.getElementById('resizeOutputFormat').innerHTML = `
      <option value="jpg" selected>JPG Image (.jpg)</option>
      <option value="pdf">PDF Document (.pdf)</option>
      <option value="png">PNG Image (.png)</option>
    `;
    resizeState.outputExt = '.jpg';
    document.getElementById('resizeFileExtBadge').innerText = '.jpg';
    document.getElementById('resizeApplyBtn').disabled = false;

    await processResizeFile();
  }
}
window.handleResizeUpload = handleResizeUpload;

function drawResizedCanvas(img, w, h, fillWhite) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d');
  if (fillWhite) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

async function compressImageToTarget(img, targetBytes, mime = 'image/jpeg') {
  let scale = 1.0;
  let bestBlob = null;
  let bestCanvas = null;

  for (let pass = 0; pass < 8; pass++) {
    const w = Math.max(60, Math.round(img.width * scale));
    const h = Math.max(60, Math.round(img.height * scale));
    const c = drawResizedCanvas(img, w, h, mime === 'image/jpeg');

    if (mime === 'image/png') {
      const b = await canvasToBlob(c, 'image/png');
      bestBlob = b; bestCanvas = c;
      if (b.size <= targetBytes) return { blob: b, canvas: c };
      const ratio = Math.sqrt(targetBytes / b.size) * 0.92;
      scale = Math.max(0.08, scale * Math.min(0.85, ratio));
      continue;
    }

    const highBlob = await canvasToBlob(c, 'image/jpeg', 0.94);
    if (highBlob.size <= targetBytes) return { blob: highBlob, canvas: c };

    const lowBlob = await canvasToBlob(c, 'image/jpeg', 0.16);
    if (lowBlob.size > targetBytes && pass < 7) {
      c.width = 0; c.height = 0;
      const est = Math.sqrt(targetBytes / lowBlob.size) * 0.9;
      scale = Math.max(0.08, scale * Math.min(0.82, Math.max(0.45, est)));
      continue;
    }

    let lo = 0.16, hi = 0.94;
    bestBlob = lowBlob; bestCanvas = c;
    for (let iter = 0; iter < 7; iter++) {
      const mid = (lo + hi) / 2;
      const b = await canvasToBlob(c, 'image/jpeg', mid);
      if (b.size <= targetBytes) { bestBlob = b; bestCanvas = c; lo = mid; }
      else { hi = mid; }
    }
    return { blob: bestBlob, canvas: bestCanvas };
  }
  return { blob: bestBlob, canvas: bestCanvas };
}

async function renderPdfPagesAtScale(pdfDoc, scale) {
  const rendered = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const vp1 = page.getViewport({ scale: 1.0 });
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vp.width));
    c.height = Math.max(1, Math.round(vp.height));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    rendered.push({
      canvas: c,
      widthMm: vp1.width * 0.352778,
      heightMm: vp1.height * 0.352778
    });
  }
  return rendered;
}

function buildPdfBlobFromCanvases(renderedPages, quality) {
  const { jsPDF } = window.jspdf;
  const first = renderedPages[0];
  const orient0 = first.widthMm > first.heightMm ? 'l' : 'p';
  const pdf = new jsPDF({
    orientation: orient0,
    unit: 'mm',
    format: [first.widthMm, first.heightMm],
    compress: true
  });

  for (let i = 0; i < renderedPages.length; i++) {
    const rp = renderedPages[i];
    const orient = rp.widthMm > rp.heightMm ? 'l' : 'p';
    if (i > 0) pdf.addPage([rp.widthMm, rp.heightMm], orient);
    pdf.addImage(rp.canvas.toDataURL('image/jpeg', quality), 'JPEG', 0, 0, rp.widthMm, rp.heightMm, undefined, 'FAST');
  }
  return pdf.output('blob');
}

async function processResizeFile() {
  if (!resizeState.origFile) return;

  resizeState.previewImages.forEach(c => { c.width = 0; c.height = 0; });
  resizeState.previewImages = [];

  const fmt = document.getElementById('resizeOutputFormat').value;
  const mode = resizeState.mode;
  const targetVal = Math.max(5, Number(document.getElementById('targetSizeVal').value) || 200);
  const targetUnit = document.getElementById('targetSizeUnit').value;
  const targetBytes = targetUnit === 'MB' ? targetVal * 1024 * 1024 : targetVal * 1024;
  const manualQuality = (Number(document.getElementById('resizeQualitySlider').value) || 75) / 100;

  setProgress(true, 'Resizing file...', 20);
  await nextFrame();

  try {
    if (resizeState.fileType === 'image') {
      const img = resizeState.img;
      let finalCanvas, finalBlob;

      if (fmt === 'pdf') {
        await ensureJsPDF();
        if (mode === 'target') {
          const imgBudget = Math.max(4096, targetBytes - 4500);
          const res = await compressImageToTarget(img, imgBudget, 'image/jpeg');
          finalCanvas = res.canvas;
        } else {
          const w = Number(document.getElementById('resizeWidthInput').value) || img.width;
          const h = Number(document.getElementById('resizeHeightInput').value) || img.height;
          finalCanvas = drawResizedCanvas(img, w, h, true);
        }

        const pxToMm = 210 / Math.max(finalCanvas.width, finalCanvas.height);
        const rendered = [{ canvas: finalCanvas, widthMm: finalCanvas.width * pxToMm, heightMm: finalCanvas.height * pxToMm }];

        if (mode === 'target') {
          let lo = 0.15, hi = 0.92;
          let bestB = buildPdfBlobFromCanvases(rendered, 0.15);
          for (let it = 0; it < 6; it++) {
            const mid = (lo + hi) / 2;
            const b = buildPdfBlobFromCanvases(rendered, mid);
            if (b.size <= targetBytes) { bestB = b; lo = mid; }
            else { hi = mid; }
          }
          finalBlob = bestB;
        } else {
          finalBlob = buildPdfBlobFromCanvases(rendered, manualQuality);
        }
        resizeState.outputExt = '.pdf';
      } else {
        const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
        if (mode === 'target') {
          const res = await compressImageToTarget(img, targetBytes, mime);
          finalCanvas = res.canvas;
          finalBlob = res.blob;
        } else {
          const w = Number(document.getElementById('resizeWidthInput').value) || img.width;
          const h = Number(document.getElementById('resizeHeightInput').value) || img.height;
          finalCanvas = drawResizedCanvas(img, w, h, mime === 'image/jpeg');
          finalBlob = await canvasToBlob(finalCanvas, mime, mime === 'image/jpeg' ? manualQuality : undefined);
        }
        resizeState.outputExt = '.' + fmt;
      }

      resizeState.outputBlob = finalBlob;
      resizeState.previewImages = [finalCanvas];
      drawResizePreview(finalCanvas, `${finalCanvas.width} × ${finalCanvas.height} px • ${resizeState.outputExt.toUpperCase()}`);
      document.getElementById('resizePdfNav').classList.remove('show');
    } else if (resizeState.fileType === 'pdf') {
      const pdfDoc = resizeState.pdfDoc;
      let renderedPages = [];
      let finalBlob = null;

      if (fmt === 'pdf') {
        await ensureJsPDF();
        if (mode === 'target') {
          const scales = [1.4, 1.1, 0.85, 0.65, 0.48];
          for (let sIdx = 0; sIdx < scales.length; sIdx++) {
            setProgress(true, `Optimizing PDF (${sIdx + 1}/${scales.length})...`, 20 + sIdx * 16);
            await nextFrame();
            renderedPages = await renderPdfPagesAtScale(pdfDoc, scales[sIdx]);

            const hiBlob = buildPdfBlobFromCanvases(renderedPages, 0.90);
            if (hiBlob.size <= targetBytes) { finalBlob = hiBlob; break; }
            const loBlob = buildPdfBlobFromCanvases(renderedPages, 0.16);
            if (loBlob.size <= targetBytes || sIdx === scales.length - 1) {
              let lo = 0.16, hi = 0.90;
              finalBlob = loBlob;
              for (let iter = 0; iter < 5; iter++) {
                const mid = (lo + hi) / 2;
                const b = buildPdfBlobFromCanvases(renderedPages, mid);
                if (b.size <= targetBytes) { finalBlob = b; lo = mid; }
                else { hi = mid; }
              }
              break;
            }
          }
        } else {
          const userScale = (Number(document.getElementById('pdfScaleSlider').value) || 100) / 100 * 1.4;
          setProgress(true, `Rendering ${pdfDoc.numPages} page(s)...`, 45);
          await nextFrame();
          renderedPages = await renderPdfPagesAtScale(pdfDoc, userScale);
          setProgress(true, 'Building compressed PDF...', 80);
          await nextFrame();
          finalBlob = buildPdfBlobFromCanvases(renderedPages, manualQuality);
        }
        resizeState.outputExt = '.pdf';
      } else {
        const userScale = mode === 'custom'
          ? (Number(document.getElementById('pdfScaleSlider').value) || 100) / 100 * 1.5
          : 1.35;
        setProgress(true, `Converting PDF pages to JPG...`, 40);
        await nextFrame();
        renderedPages = await renderPdfPagesAtScale(pdfDoc, userScale);

        if (renderedPages.length === 1) {
          if (mode === 'target') {
            const imgObj = await loadImageFromSrc(renderedPages[0].canvas.toDataURL('image/png'));
            const res = await compressImageToTarget(imgObj, targetBytes, 'image/jpeg');
            renderedPages[0].canvas = res.canvas;
            finalBlob = res.blob;
          } else {
            finalBlob = await canvasToBlob(renderedPages[0].canvas, 'image/jpeg', manualQuality);
          }
          resizeState.outputExt = '.jpg';
        } else {
          const JSZipLib = await ensureJSZip();
          const zip = new JSZipLib();
          const perPageBudget = Math.max(12000, Math.floor(targetBytes / renderedPages.length));
          for (let i = 0; i < renderedPages.length; i++) {
            setProgress(true, `Packing page ${i + 1} / ${renderedPages.length}...`, Math.round(((i + 1) / renderedPages.length) * 90));
            await nextFrame();
            let b;
            if (mode === 'target') {
              const imgObj = await loadImageFromSrc(renderedPages[i].canvas.toDataURL('image/png'));
              const res = await compressImageToTarget(imgObj, perPageBudget, 'image/jpeg');
              renderedPages[i].canvas = res.canvas;
              b = res.blob;
            } else {
              b = await canvasToBlob(renderedPages[i].canvas, 'image/jpeg', manualQuality);
            }
            zip.file(`Page-${String(i + 1).padStart(2, '0')}.jpg`, b);
          }
          finalBlob = await zip.generateAsync({ type: 'blob' });
          resizeState.outputExt = '.zip';
        }
      }

      resizeState.outputBlob = finalBlob;
      resizeState.previewImages = renderedPages.map(p => p.canvas);
      resizeState.pdfCurrentPage = 1;
      showCurrentResizePdfPage();
    }

    document.getElementById('resizeFileExtBadge').innerText = resizeState.outputExt;
    updateResizeStats(resizeState.origSize, resizeState.outputBlob.size);
    document.getElementById('resizeDownloadBtn').disabled = false;
    setProgress(false);
    showToast(`Resized to ${formatBytes(resizeState.outputBlob.size)}`);
  } catch (err) {
    setProgress(false);
    console.error(err);
    alert('Error resizing file. Please try again.');
  }
}

function updateResizeStats(origBytes, newBytes) {
  document.getElementById('statOrigSize').innerText = formatBytes(origBytes);
  document.getElementById('statNewSize').innerText = formatBytes(newBytes);
  const diffPct = origBytes > 0 ? Math.round(((origBytes - newBytes) / origBytes) * 100) : 0;
  const savedEl = document.getElementById('statSavedBadge');
  if (diffPct >= 0) {
    savedEl.innerText = `-${diffPct}%`;
    savedEl.style.color = '#34d399';
  } else {
    savedEl.innerText = `+${Math.abs(diffPct)}%`;
    savedEl.style.color = '#fbbf24';
  }
}

function drawResizePreview(srcCanvas, infoText) {
  const pCanvas = document.getElementById('resizePreviewCanvas');
  pCanvas.width = srcCanvas.width;
  pCanvas.height = srcCanvas.height;
  pCanvas.getContext('2d').drawImage(srcCanvas, 0, 0);
  pCanvas.style.display = 'block';
  document.getElementById('resizeEmptyState').style.display = 'none';
  document.getElementById('resizePreviewInfo').innerText = infoText;
}

function showCurrentResizePdfPage() {
  const pages = resizeState.previewImages;
  if (!pages.length) return;
  const idx = Math.max(0, Math.min(pages.length - 1, resizeState.pdfCurrentPage - 1));
  resizeState.pdfCurrentPage = idx + 1;
  drawResizePreview(pages[idx], `PDF • ${pages.length} Page(s) • Output ${resizeState.outputExt.toUpperCase()}`);
  const nav = document.getElementById('resizePdfNav');
  if (pages.length > 1) {
    nav.classList.add('show');
    document.getElementById('resizePdfPageLabel').innerText = `Page ${resizeState.pdfCurrentPage} / ${pages.length}`;
  } else {
    nav.classList.remove('show');
  }
}

function changeResizePdfPage(delta) {
  const total = resizeState.previewImages.length;
  if (total <= 1) return;
  resizeState.pdfCurrentPage = Math.max(1, Math.min(total, resizeState.pdfCurrentPage + delta));
  showCurrentResizePdfPage();
}

function downloadResizedFile() {
  if (!resizeState.outputBlob) { alert('Please upload and resize a file first.'); return; }
  let rawName = (document.getElementById('resizeFileNameInput').value || '').trim();
  rawName = rawName.replace(/[<>:"/\\|?*]+/g, '').replace(/\.+$/, '');
  if (!rawName) rawName = 'resized-file';

  const ext = resizeState.outputExt || '.jpg';
  const finalName = rawName.toLowerCase().endsWith(ext) ? rawName : rawName + ext;

  const url = URL.createObjectURL(resizeState.outputBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = finalName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast(`Downloaded: ${finalName}`);
}
