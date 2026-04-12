(() => {
  // ─── State ────────────────────────────────────────────────────────────────
  let currentModel = 'iPhone 17';
  let currentColor = 'Black';
  let frameImg = null;
  let frameBounds = null;   // non-transparent bounding box (for download crop)
  let screenHoleMask = null; // pixel-perfect ImageData mask of screen hole only
  let screenshotImg = null;
  let frameLoaded = false;

  // Cache for autoDetectScreen results and loaded Image objects, keyed by "model|color"
  const frameCache = {}; // key -> { img, result: { coords, bounds }, mask: ImageData }

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

  // ─── Frame loading ────────────────────────────────────────────────────────
  let loadGeneration = 0; // monotonically increasing; guards against stale worker replies

  function loadFrame(model, color) {
    const gen = ++loadGeneration;
    frameLoaded = false;
    frameImg = null;
    frameBounds = null;
    screenHoleMask = null;
    frameStatusEl.textContent = 'Loading frame…';

    const cacheKey = `${model}|${color}`;

    function applyFrame(img, result, mask) {
      if (gen !== loadGeneration) return; // stale
      frameImg = img;
      screenHoleMask = mask;
      frameLoaded = true;
      if (result) frameBounds = result.bounds;

      frameStatusEl.textContent =
        `${model} · ${color} · ${img.naturalWidth}×${img.naturalHeight}px`;

      const saved = loadCal(model, color);
      if (saved) {
        setInputsFromCoords(saved);
        setCalStatus(`Loaded saved calibration for ${model} ${color}`, 'ok');
      } else if (result) {
        setInputsFromCoords(result.coords);
        saveCal(model, color, result.coords);
        setCalStatus(`Auto-detected screen area`, 'ok');
      } else {
        setCalStatus('No calibration — click Auto-Detect or enter manually', 'info');
      }

      composite();
    }

    // Immediately show frame (without screenshot composite) while worker runs
    function showFramePreview(img) {
      if (gen !== loadGeneration) return;
      frameImg = img;
      frameLoaded = true;
      frameStatusEl.textContent =
        `${model} · ${color} · ${img.naturalWidth}×${img.naturalHeight}px · detecting…`;

      // Show frame-only preview (no mask yet, so composite shows fallback)
      const saved = loadCal(model, color);
      if (saved) {
        setInputsFromCoords(saved);
      }
      composite();
    }

    // Return cached result immediately
    if (frameCache[cacheKey]) {
      const cached = frameCache[cacheKey];
      applyFrame(cached.img, cached.result, cached.mask);
      return;
    }

    const img = new Image();
    img.onload = () => {
      if (gen !== loadGeneration) return;

      // Show frame immediately while detection runs
      showFramePreview(img);

      // Extract pixel data on main thread (fast — just drawImage + getImageData)
      const oc = document.createElement('canvas');
      oc.width = img.naturalWidth;
      oc.height = img.naturalHeight;
      const octx = oc.getContext('2d');
      octx.drawImage(img, 0, 0);
      let imgData;
      try {
        imgData = octx.getImageData(0, 0, oc.width, oc.height);
      } catch (e) {
        setCalStatus('CORS error — serve via http:// not file://', 'err');
        return;
      }

      // Send to worker for heavy computation
      const handler = (e) => {
        detectWorker.removeEventListener('message', handler);
        if (gen !== loadGeneration) return;
        const msg = e.data;
        if (msg.error) {
          setCalStatus(msg.error, 'err');
          return;
        }
        const mask = new ImageData(new Uint8ClampedArray(msg.maskBuffer), msg.width, msg.height);
        const result = { coords: msg.coords, bounds: msg.bounds };
        screenHoleMask = mask;
        frameCache[cacheKey] = { img, result, mask };
        applyFrame(img, result, mask);
      };
      detectWorker.addEventListener('message', handler);
      detectWorker.postMessage(
        { imgData, width: oc.width, height: oc.height },
        [imgData.data.buffer]
      );
    };
    img.onerror = () => {
      if (gen !== loadGeneration) return;
      frameStatusEl.textContent = 'Frame not found';
      setCalStatus(`File not found: ${framePath(model, color)}`, 'err');
      composite();
    };
    img.src = framePath(model, color);
  }

  // ─── Composite ───────────────────────────────────────────────────────────
  // Compositing pipeline:
  //   1. Draw screenshot onto offCanvas at the calibrated screen hole position
  //   2. Apply screenHoleMask via destination-in → screenshot pixels outside
  //      the squircle (including outer background) are erased
  //   3. Draw frame on top (source-over) → border covers any remaining edges
  //   4. Blit to main canvas
  function composite() {
    if (!frameLoaded || !screenshotImg) {
      if (!screenshotImg) {
        canvas.style.display = 'none';
        placeholder.style.display = '';
      }
      return;
    }

    const coords = getCoordsFromInputs();

    canvas.width  = frameImg.naturalWidth;
    canvas.height = frameImg.naturalHeight;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (coords && screenHoleMask) {
      // Fit screenshot into screen hole (letterbox / pillarbox)
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
      offC.width  = canvas.width;
      offC.height = canvas.height;
      const offCtx = offC.getContext('2d');
      offCtx.imageSmoothingEnabled = true;
      offCtx.imageSmoothingQuality = 'high';

      // Step 1: draw screenshot
      offCtx.drawImage(screenshotImg, drawX, drawY, drawW, drawH);

      // Step 2: clip to screen hole shape via cached pixel-perfect mask
      const maskC = document.createElement('canvas');
      maskC.width  = canvas.width;
      maskC.height = canvas.height;
      maskC.getContext('2d').putImageData(screenHoleMask, 0, 0);
      offCtx.globalCompositeOperation = 'destination-in';
      offCtx.drawImage(maskC, 0, 0);
      offCtx.globalCompositeOperation = 'source-over';

      // Step 3: draw frame on top
      offCtx.drawImage(frameImg, 0, 0, offC.width, offC.height);

      ctx.drawImage(offC, 0, 0);
    } else if (coords) {
      // Fallback (mask not available): rectangular clip
      ctx.save();
      ctx.beginPath();
      ctx.rect(coords.x, coords.y, coords.w, coords.h);
      ctx.clip();
      ctx.drawImage(screenshotImg, coords.x, coords.y, coords.w, coords.h);
      ctx.restore();
      ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
    } else {
      // No calibration: ghost screenshot behind frame
      ctx.globalAlpha = 0.3;
      ctx.drawImage(screenshotImg, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1.0;
      ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
    }

    canvas.style.display = 'block';
    placeholder.style.display = 'none';
    btnDownload.disabled = false;
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
    if (!frameLoaded || !frameImg) { setCalStatus('Load a frame first', 'err'); return; }
    setCalStatus('Scanning pixels…', 'info');

    const oc = document.createElement('canvas');
    oc.width = frameImg.naturalWidth;
    oc.height = frameImg.naturalHeight;
    const octx = oc.getContext('2d');
    octx.drawImage(frameImg, 0, 0);
    let imgData;
    try {
      imgData = octx.getImageData(0, 0, oc.width, oc.height);
    } catch (e) {
      setCalStatus('CORS error — serve via http:// not file://', 'err');
      return;
    }

    const handler = (e) => {
      detectWorker.removeEventListener('message', handler);
      const msg = e.data;
      if (msg.error) { setCalStatus(msg.error, 'err'); return; }
      const mask = new ImageData(new Uint8ClampedArray(msg.maskBuffer), msg.width, msg.height);
      screenHoleMask = mask;
      if (msg.bounds) frameBounds = msg.bounds;
      setInputsFromCoords(msg.coords);
      saveCal(currentModel, currentColor, msg.coords);
      const { x, y, w, h } = msg.coords;
      setCalStatus(`Detected: x=${Math.round(x)} y=${Math.round(y)} w=${Math.round(w)} h=${Math.round(h)}`, 'ok');

      const cacheKey = `${currentModel}|${currentColor}`;
      frameCache[cacheKey] = { img: frameImg, result: { coords: msg.coords, bounds: msg.bounds }, mask };
      composite();
    };
    detectWorker.addEventListener('message', handler);
    detectWorker.postMessage(
      { imgData, width: oc.width, height: oc.height },
      [imgData.data.buffer]
    );
  });

  document.getElementById('btn-apply-cal').addEventListener('click', () => {
    const coords = getCoordsFromInputs();
    if (!coords) { setCalStatus('Invalid values — enter positive numbers', 'err'); return; }
    saveCal(currentModel, currentColor, coords);
    setCalStatus(`Saved for ${currentModel} ${currentColor}`, 'ok');
    composite();
  });

  Object.values(calInputs).forEach(input => input.addEventListener('input', () => composite()));

  // ─── Download ─────────────────────────────────────────────────────────────
  btnDownload.addEventListener('click', () => {
    if (!frameLoaded || !screenshotImg) return;
    try {
      let url;
      if (frameBounds) {
        const { x, y, w, h } = frameBounds;
        const crop = document.createElement('canvas');
        crop.width = w; crop.height = h;
        crop.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
        url = crop.toDataURL('image/png');
      } else {
        url = canvas.toDataURL('image/png');
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentModel.toLowerCase().replace(/\s+/g, '')}-${currentColor.toLowerCase().replace(/\s+/g, '-')}-mockup.png`;
      a.click();
    } catch (e) {
      alert('Download failed — ensure you are using http://localhost (not file://) to avoid CORS restrictions.');
    }
  });

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
