// Web Worker: pixel-level screen hole detection
// Receives ImageData, returns { coords, bounds, maskData }

self.onmessage = function(e) {
  const { imgData, width: w, height: h } = e.data;
  const data = imgData.data;

  const alphaAt = (x, y) => data[(y * w + x) * 4 + 3];
  const isTransparent = (x, y) => alphaAt(x, y) < 10;

  // Flood-fill from edges to mark outer background
  const outerMask = new Uint8Array(w * h);
  const queue = [];
  const enqueue = (x, y) => {
    const idx = y * w + x;
    if (outerMask[idx] === 0 && isTransparent(x, y)) {
      outerMask[idx] = 1;
      queue.push(x, y);
    }
  };

  for (let x = 0; x < w; x++) { enqueue(x, 0); enqueue(x, h - 1); }
  for (let y = 0; y < h; y++) { enqueue(0, y); enqueue(w - 1, y); }

  for (let qi = 0; qi < queue.length;) {
    const cx = queue[qi++], cy = queue[qi++];
    if (cx > 0)     enqueue(cx - 1, cy);
    if (cx < w - 1) enqueue(cx + 1, cy);
    if (cy > 0)     enqueue(cx, cy - 1);
    if (cy < h - 1) enqueue(cx, cy + 1);
  }

  // Find screen hole and frame bounds
  let sMinX = w, sMinY = h, sMaxX = 0, sMaxY = 0;
  let fMinX = w, fMinY = h, fMaxX = 0, fMaxY = 0;
  let holeFound = false;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (isTransparent(x, y) && outerMask[idx] === 0) {
        if (x < sMinX) sMinX = x; if (x > sMaxX) sMaxX = x;
        if (y < sMinY) sMinY = y; if (y > sMaxY) sMaxY = y;
        holeFound = true;
      } else if (!isTransparent(x, y)) {
        if (x < fMinX) fMinX = x; if (x > fMaxX) fMaxX = x;
        if (y < fMinY) fMinY = y; if (y > fMaxY) fMaxY = y;
      }
    }
  }

  if (!holeFound) {
    self.postMessage({ error: 'No inner transparent region found' });
    return;
  }

  const coords = { x: sMinX, y: sMinY, w: sMaxX - sMinX + 1, h: sMaxY - sMinY + 1 };
  const bounds = fMinX <= fMaxX
    ? { x: fMinX, y: fMinY, w: fMaxX - fMinX + 1, h: fMaxY - fMinY + 1 }
    : null;

  // Build mask
  const maskBuffer = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const px = i * 4;
    maskBuffer[px] = maskBuffer[px + 1] = maskBuffer[px + 2] = 255;
    maskBuffer[px + 3] = outerMask[i] === 1 ? 0 : 255 - alphaAt(i % w, (i / w) | 0);
  }

  self.postMessage({ coords, bounds, maskBuffer, width: w, height: h }, [maskBuffer.buffer]);
};
