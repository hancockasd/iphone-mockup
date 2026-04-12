(() => {
  // ─── State ────────────────────────────────────────────────────────────────
  let currentModel = 'iPhone 17';
  let currentColor = 'Black';
  let screenshotImg = null;

  // Preview state (half-res)
  let previewFrameImg = null;
  let previewMask = null;
  let previewBounds = null;
  let previewLoaded = false;

  // Scale factor for preview (0.5 = half resolution, 1/4 pixel count)
  const PREVIEW_SCALE = 0.5;

  // Cache: key -> { previewImg, previewMask, previewResult, fullImg (lazy) }
  const frameCache = {};

  // Web Worker for off-thread screen detection
  const detectWorker = new Worker('detect-worker.js');

  const MODEL_COLORS = {
    'iPhone 17':         ['Black', 'White', 'Lavender', 'Mist Blue', 'Sage'],
    'iPhone 17 Pro':     ['Cosmic Orange', 'Deep Blue', 'Silver'],
    'iPhone 17 Pro Max': ['Cosmic Orange', 'Deep Blue', 'Silver'],
    'iPhone Air':        ['Cloud White', 'Light Gold', 'Sky Blue', 'Space Black'],
  };

  const COLOR_SWATCHES = {
    'Black':         '#1a1a1a',
    'White':         '#f5f5f0',
    'Lavender':      '#b9a9d4',
    'Mist Blue':     '#8ab4cc',
    'Sage':          '#8aab8a',
    'Cosmic Orange': '#c46b3a',
    'Deep Blue':     '#2a4a7a',
    'Silver':        '#a8a8aa',
    'Cloud White':   '#f0ede8',
    'Light Gold':    '#c8ad7f',
    'Sky Blue':      '#7aafc8',
    'Space Black':   '#2a2a2a',
  };

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const canvas        = document.getElementById('preview-canvas');
  const ctx           = canvas.getContext('2d');
  const placeholder   = document.getElementById('preview-placeholder');
  const frameStatusEl = document.getElementById('frame-status');
  const uploadedNameEl = document.getElementById('uploaded-name');
  const calStatusEl   = document.getElementById('cal-status');
  const btnDownload   = document.getElementById('btn-download');
  const colorGridEl   = document.getElementById('color-grid');

  const calInputs = {
    x: document.getElementById('cal-x'),
    y: document.getElementById('cal-y'),
    w: document.getElementById('cal-w'),
    h: document.getElementById('cal-h'),
  };

  // ─── Calibration helpers ──────────────────────────────────────────────────
  const calKey = (model, color) => `mockup-cal-${model}-${color}`;

  function loadCal(model, color) {
    try {
      const raw = localStorage.getItem(calKey(model, color));
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return null;
  }

  const saveCal = (model, color, coords) =>
    localStorage.setItem(calKey(model, color), JSON.stringify(coords));

  function getCoordsFromInputs() {
    const x = parseFloat(calInputs.x.value);
    const y = parseFloat(calInputs.y.value);
    const w = parseFloat(calInputs.w.value);
    const h = parseFloat(calInputs.h.value);
    if ([x, y, w, h].some(v => isNaN(v) || v < 0)) return null;
    return { x, y, w, h };
  }

  function setInputsFromCoords(coords) {
    if (!coords) return;
    calInputs.x.value = Math.round(coords.x);
    calInputs.y.value = Math.round(coords.y);
    calInputs.w.value = Math.round(coords.w);
    calInputs.h.value = Math.round(coords.h);
  }

  function setCalStatus(msg, type = 'info') {
    calStatusEl.textContent = msg;
    calStatusEl.className = `cal-status ${type}`;
  }

  // ─── Frame path ───────────────────────────────────────────────────────────
  const framePath = (model, color) =>
    `PNG/${model}/${model} - ${color} - Portrait.png`;

  // ─── Downscale an image to a canvas ────────────────────────────────────────
  function downscaleImage(img, scale) {
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cCtx = c.getContext('2d');
    cCtx.imageSmoothingEnabled = true;
    cCtx.imageSmoothingQuality = 'high';
    cCtx.drawImage(img, 0, 0, w, h);
    return c;
  }

  // ─── Run detection via worker (returns Promise) ────────────────────────────
  function detectViaWorker(canvasEl) {
    return new Promise((resolve, reject) => {
      const octx = canvasEl.getContext('2d');
      let imgData;
      try {
        imgData = octx.getImageData(0, 0, canvasEl.width, canvasEl.height);
      } catch (e) {
        reject(new Error('CORS'));
        return;
      }
      const handler = (e) => {
        detectWorker.removeEventListener('message', handler);
        const msg = e.data;
        if (msg.error) { reject(new Error(msg.error)); return; }
        const mask = new ImageData(
          new Uint8ClampedArray(msg.maskBuffer), msg.width, msg.height
        );
        resolve({ coords: msg.coords, bounds: msg.bounds, mask });
      };
      detectWorker.addEventListener('message', handler);
      detectWorker.postMessage(
        { imgData, width: canvasEl.width, height: canvasEl.height },
        [imgData.data.buffer]
      );
    });
  }

  // ─── Color grid ───────────────────────────────────────────────────────────
  function buildColorGrid(model) {
    colorGridEl.innerHTML = '';
    MODEL_COLORS[model].forEach((color, i) => {
      const btn = document.createElement('button');
      btn.className = 'color-btn' + (i === 0 ? ' active' : '');
      btn.dataset.color = color;

      const swatch = document.createElement('span');
      swatch.className = 'color-swatch';
      swatch.style.background = COLOR_SWATCHES[color] || '#888';

      btn.appendChild(swatch);
      btn.appendChild(document.createTextNode(' ' + color));
      btn.addEventListener('click', () => {
        colorGridEl.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentColor = color;
        loadFrame(currentModel, currentColor);
      });
      colorGridEl.appendChild(btn);
    });
  }

  // ─── Frame loading (preview = half-res) ─────────────────────────────────────
  let loadGeneration = 0;

  function loadFrame(model, color) {
    const gen = ++loadGeneration;
    previewLoaded = false;
    previewFrameImg = null;
    previewMask = null;
    previewBounds = null;
    frameStatusEl.textContent = 'Loading frame…';

    const cacheKey = `${model}|${color}`;

    function applyPreview(pImg, result, mask) {
      if (gen !== loadGeneration) return;
      previewFrameImg = pImg;
      previewMask = mask;
      previewLoaded = true;
      if (result) previewBounds = result.bounds;

      frameStatusEl.textContent =
        `${model} · ${color} · ${pImg.width}×${pImg.height}px (preview)`;

      // Calibration coords are stored at full-res scale
      const saved = loadCal(model, color);
      if (saved) {
        setInputsFromCoords(saved);
        setCalStatus(`Loaded saved calibration for ${model} ${color}`, 'ok');
      } else if (result) {
        // Scale coords back to full-res for display/storage
        const fullCoords = scaleCoords(result.coords, 1 / PREVIEW_SCALE);
        setInputsFromCoords(fullCoords);
        saveCal(model, color, fullCoords);
        setCalStatus(`Auto-detected screen area`, 'ok');
      } else {
        setCalStatus('No calibration — click Auto-Detect or enter manually', 'info');
      }

      composite();
    }

    // Return cached result immediately
    if (frameCache[cacheKey] && frameCache[cacheKey].previewMask) {
      const c = frameCache[cacheKey];
      applyPreview(c.previewCanvas, c.previewResult, c.previewMask);
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (gen !== loadGeneration) return;

      // Downscale for preview
      const previewCanvas = downscaleImage(img, PREVIEW_SCALE);

      // Show frame immediately (no mask yet)
      previewFrameImg = previewCanvas;
      previewLoaded = true;
      const saved = loadCal(model, color);
      if (saved) setInputsFromCoords(saved);
      frameStatusEl.textContent =
        `${model} · ${color} · detecting…`;
      composite();

      // Run detection on half-res in worker
      detectViaWorker(previewCanvas).then(({ coords, bounds, mask }) => {
        if (gen !== loadGeneration) return;
        // Cache: store preview canvas, full-res original, and detection results
        frameCache[cacheKey] = {
          previewCanvas, previewResult: { coords, bounds }, previewMask: mask,
          fullImg: img,
        };
        applyPreview(previewCanvas, { coords, bounds }, mask);
      }).catch(err => {
        if (gen !== loadGeneration) return;
        setCalStatus(err.message === 'CORS'
          ? 'CORS error — serve via http:// not file://'
          : err.message, 'err');
      });
    };
    img.onerror = () => {
      if (gen !== loadGeneration) return;
      frameStatusEl.textContent = 'Frame not found';
      setCalStatus(`File not found: ${framePath(model, color)}`, 'err');
      composite();
    };
    img.src = framePath(model, color);
  }

  // ─── Scale coords between preview and full-res ─────────────────────────────
  function scaleCoords(coords, factor) {
    return {
      x: Math.round(coords.x * factor),
      y: Math.round(coords.y * factor),
      w: Math.round(coords.w * factor),
      h: Math.round(coords.h * factor),
    };
  }

  // ─── Composite (preview, half-res) ─────────────────────────────────────────
  function composite() {
    if (!previewLoaded || !screenshotImg) {
      if (!screenshotImg) {
        canvas.style.display = 'none';
        placeholder.style.display = '';
      }
      return;
    }

    // Get full-res coords from inputs, scale down for preview
    const fullCoords = getCoordsFromInputs();
    const coords = fullCoords ? scaleCoords(fullCoords, PREVIEW_SCALE) : null;

    const fw = previewFrameImg.width;
    const fh = previewFrameImg.height;

    canvas.width  = fw;
    canvas.height = fh;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, fw, fh);

    if (coords && previewMask) {
      const sAspect = screenshotImg.naturalWidth / screenshotImg.naturalHeight;
      const aAspect = coords.w / coords.h;
      let drawX, drawY, drawW, drawH;
      if (sAspect > aAspect) {
        drawW = coords.w; drawH = coords.w / sAspect;
        drawX = coords.x; drawY = coords.y + (coords.h - drawH) / 2;
      } else {
        drawH = coords.h; drawW = coords.h * sAspect;
        drawX = coords.x + (coords.w - drawW) / 2; drawY = coords.y;
      }

      const offC = document.createElement('canvas');
      offC.width  = fw;
      offC.height = fh;
      const offCtx = offC.getContext('2d');
      offCtx.imageSmoothingEnabled = true;
      offCtx.imageSmoothingQuality = 'high';

      offCtx.drawImage(screenshotImg, drawX, drawY, drawW, drawH);

      const maskC = document.createElement('canvas');
      maskC.width  = fw;
      maskC.height = fh;
      maskC.getContext('2d').putImageData(previewMask, 0, 0);
      offCtx.globalCompositeOperation = 'destination-in';
      offCtx.drawImage(maskC, 0, 0);
      offCtx.globalCompositeOperation = 'source-over';

      offCtx.drawImage(previewFrameImg, 0, 0, fw, fh);
      ctx.drawImage(offC, 0, 0);
    } else if (coords) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(coords.x, coords.y, coords.w, coords.h);
      ctx.clip();
      ctx.drawImage(screenshotImg, coords.x, coords.y, coords.w, coords.h);
      ctx.restore();
      ctx.drawImage(previewFrameImg, 0, 0, fw, fh);
    } else {
      ctx.globalAlpha = 0.3;
      ctx.drawImage(screenshotImg, 0, 0, fw, fh);
      ctx.globalAlpha = 1.0;
      ctx.drawImage(previewFrameImg, 0, 0, fw, fh);
    }

    canvas.style.display = 'block';
    placeholder.style.display = 'none';
    btnDownload.disabled = false;
  }

  // ─── Full-res composite for download ───────────────────────────────────────
  function compositeFullRes(fullImg, fullMask, fullBounds) {
    const fullCoords = getCoordsFromInputs();
    const fw = fullImg.naturalWidth;
    const fh = fullImg.naturalHeight;

    const dlCanvas = document.createElement('canvas');
    dlCanvas.width = fw;
    dlCanvas.height = fh;
    const dlCtx = dlCanvas.getContext('2d');
    dlCtx.imageSmoothingEnabled = true;
    dlCtx.imageSmoothingQuality = 'high';
    dlCtx.clearRect(0, 0, fw, fh);

    if (fullCoords && fullMask) {
      const sAspect = screenshotImg.naturalWidth / screenshotImg.naturalHeight;
      const aAspect = fullCoords.w / fullCoords.h;
      let drawX, drawY, drawW, drawH;
      if (sAspect > aAspect) {
        drawW = fullCoords.w; drawH = fullCoords.w / sAspect;
        drawX = fullCoords.x; drawY = fullCoords.y + (fullCoords.h - drawH) / 2;
      } else {
        drawH = fullCoords.h; drawW = fullCoords.h * sAspect;
        drawX = fullCoords.x + (fullCoords.w - drawW) / 2; drawY = fullCoords.y;
      }

      const offC = document.createElement('canvas');
      offC.width  = fw;
      offC.height = fh;
      const offCtx = offC.getContext('2d');
      offCtx.imageSmoothingEnabled = true;
      offCtx.imageSmoothingQuality = 'high';

      offCtx.drawImage(screenshotImg, drawX, drawY, drawW, drawH);

      const maskC = document.createElement('canvas');
      maskC.width  = fw;
      maskC.height = fh;
      maskC.getContext('2d').putImageData(fullMask, 0, 0);
      offCtx.globalCompositeOperation = 'destination-in';
      offCtx.drawImage(maskC, 0, 0);
      offCtx.globalCompositeOperation = 'source-over';

      offCtx.drawImage(fullImg, 0, 0, fw, fh);
      dlCtx.drawImage(offC, 0, 0);
    } else if (fullCoords) {
      dlCtx.save();
      dlCtx.beginPath();
      dlCtx.rect(fullCoords.x, fullCoords.y, fullCoords.w, fullCoords.h);
      dlCtx.clip();
      dlCtx.drawImage(screenshotImg, fullCoords.x, fullCoords.y, fullCoords.w, fullCoords.h);
      dlCtx.restore();
      dlCtx.drawImage(fullImg, 0, 0, fw, fh);
    } else {
      dlCtx.globalAlpha = 0.3;
      dlCtx.drawImage(screenshotImg, 0, 0, fw, fh);
      dlCtx.globalAlpha = 1.0;
      dlCtx.drawImage(fullImg, 0, 0, fw, fh);
    }

    // Crop to frame bounds
    if (fullBounds) {
      const { x, y, w, h } = fullBounds;
      const crop = document.createElement('canvas');
      crop.width = w; crop.height = h;
      crop.getContext('2d').drawImage(dlCanvas, x, y, w, h, 0, 0, w, h);
      return crop.toDataURL('image/png');
    }
    return dlCanvas.toDataURL('image/png');
  }

  // ─── Model buttons ────────────────────────────────────────────────────────
  document.querySelectorAll('.model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentModel = btn.dataset.model;
      buildColorGrid(currentModel);
      currentColor = MODEL_COLORS[currentModel][0];
      loadFrame(currentModel, currentColor);
    });
  });

  // ─── File upload ──────────────────────────────────────────────────────────
  function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        screenshotImg = img;
        uploadedNameEl.textContent = file.name;
        uploadedNameEl.style.display = 'block';
        composite();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  document.getElementById('file-input').addEventListener('change', e => handleFile(e.target.files[0]));

  const uploadArea = document.getElementById('upload-area');
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });

  // ─── Calibration controls ─────────────────────────────────────────────────
  document.getElementById('btn-auto-detect').addEventListener('click', () => {
    if (!previewLoaded || !previewFrameImg) { setCalStatus('Load a frame first', 'err'); return; }
    setCalStatus('Scanning pixels…', 'info');

    detectViaWorker(previewFrameImg).then(({ coords, bounds, mask }) => {
      previewMask = mask;
      if (bounds) previewBounds = bounds;
      const fullCoords = scaleCoords(coords, 1 / PREVIEW_SCALE);
      setInputsFromCoords(fullCoords);
      saveCal(currentModel, currentColor, fullCoords);
      const { x, y, w, h } = fullCoords;
      setCalStatus(`Detected: x=${x} y=${y} w=${w} h=${h}`, 'ok');

      const cacheKey = `${currentModel}|${currentColor}`;
      if (frameCache[cacheKey]) {
        frameCache[cacheKey].previewMask = mask;
        frameCache[cacheKey].previewResult = { coords, bounds };
      }
      composite();
    }).catch(err => {
      setCalStatus(err.message === 'CORS'
        ? 'CORS error — serve via http:// not file://'
        : err.message, 'err');
    });
  });

  document.getElementById('btn-apply-cal').addEventListener('click', () => {
    const coords = getCoordsFromInputs();
    if (!coords) { setCalStatus('Invalid values — enter positive numbers', 'err'); return; }
    saveCal(currentModel, currentColor, coords);
    setCalStatus(`Saved for ${currentModel} ${currentColor}`, 'ok');
    composite();
  });

  Object.values(calInputs).forEach(input => input.addEventListener('input', () => composite()));

  // ─── Download (full-res on demand) ─────────────────────────────────────────
  btnDownload.addEventListener('click', () => {
    if (!previewLoaded || !screenshotImg) return;

    const cacheKey = `${currentModel}|${currentColor}`;
    const cached = frameCache[cacheKey];

    // If we have a cached full-res mask, use it directly
    if (cached && cached.fullMask) {
      try {
        const url = compositeFullRes(cached.fullImg, cached.fullMask, cached.fullBounds);
        triggerDownload(url);
      } catch (e) {
        alert('Download failed — ensure you are using http:// not file://');
      }
      return;
    }

    // Otherwise, run full-res detection then download
    btnDownload.disabled = true;
    btnDownload.textContent = 'Preparing HD…';

    const fullImg = cached ? cached.fullImg : null;
    if (!fullImg) {
      alert('Frame not loaded');
      btnDownload.disabled = false;
      btnDownload.textContent = 'Download PNG';
      return;
    }

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = fullImg.naturalWidth;
    fullCanvas.height = fullImg.naturalHeight;
    const fCtx = fullCanvas.getContext('2d');
    fCtx.drawImage(fullImg, 0, 0);

    detectViaWorker(fullCanvas).then(({ coords, bounds, mask }) => {
      // Cache the full-res results
      cached.fullMask = mask;
      cached.fullBounds = bounds;
      cached.fullCoords = coords;

      try {
        const url = compositeFullRes(fullImg, mask, bounds);
        triggerDownload(url);
      } catch (e) {
        alert('Download failed — ensure you are using http:// not file://');
      }
    }).catch(err => {
      alert('Detection failed: ' + err.message);
    }).finally(() => {
      btnDownload.disabled = false;
      btnDownload.textContent = 'Download PNG';
    });
  });

  function triggerDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentModel.toLowerCase().replace(/\s+/g, '')}-${currentColor.toLowerCase().replace(/\s+/g, '-')}-mockup.png`;
    a.click();
  }

  // ─── Sidebar toggle ───────────────────────────────────────────────────────
  const sidebarEl   = document.getElementById('sidebar');
  const toggleBtn   = document.getElementById('sidebar-toggle');
  const backdropEl  = document.getElementById('sidebar-backdrop');
  const appLayout   = document.querySelector('.app-layout');
  const openBtn     = document.getElementById('sidebar-open-btn');

  const isMobile = () => window.innerWidth <= 768;

  function openSidebar() {
    if (isMobile()) {
      sidebarEl.classList.add('is-open');
      backdropEl.classList.add('is-visible');
      document.body.style.overflow = 'hidden';
      openBtn.classList.add('hidden');
    } else {
      appLayout.classList.remove('sidebar-collapsed');
    }
    toggleBtn.classList.add('is-open');
  }

  function closeSidebar() {
    if (isMobile()) {
      sidebarEl.classList.remove('is-open');
      backdropEl.classList.remove('is-visible');
      document.body.style.overflow = '';
      openBtn.classList.remove('hidden');
    } else {
      appLayout.classList.add('sidebar-collapsed');
    }
    toggleBtn.classList.remove('is-open');
  }

  function isSidebarOpen() {
    return isMobile()
      ? sidebarEl.classList.contains('is-open')
      : !appLayout.classList.contains('sidebar-collapsed');
  }

  toggleBtn.addEventListener('click', () => {
    isSidebarOpen() ? closeSidebar() : openSidebar();
  });

  openBtn.addEventListener('click', openSidebar);

  backdropEl.addEventListener('click', closeSidebar);

  // ─── Init ─────────────────────────────────────────────────────────────────
  buildColorGrid(currentModel);
  loadFrame(currentModel, currentColor);
})();
